import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import {
  fileViewers,
  getFileViewersSnapshot,
  matchFileViewer,
  registerFileViewer,
  subscribeFileViewers
} from "../src/client/features/registry.js";
import type { FileViewerDescriptor } from "../src/client/features/registry.js";

const disposers: Array<() => void> = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

function stubViewer(overrides: Partial<FileViewerDescriptor> & { readonly id: string }): FileViewerDescriptor {
  return {
    label: overrides.id,
    icon: "◫",
    extensions: [],
    priority: 0,
    component: () => null,
    ...overrides
  };
}

function track(viewer: FileViewerDescriptor): () => void {
  const dispose = registerFileViewer(viewer);
  disposers.push(dispose);
  return dispose;
}

describe("matchFileViewer", () => {
  it("matches extensions case-insensitively", () => {
    expect(matchFileViewer("data.JSON", "text")?.id).toBe("source-map");
    expect(matchFileViewer("dir/sub/DATA.Json", "text")?.id).toBe("source-map");
  });

  it("prefers the higher priority among extension hits", () => {
    track(stubViewer({ id: "d1-prio-low", extensions: [".d1prio"], priority: 1 }));
    track(stubViewer({ id: "d1-prio-high", extensions: [".D1PRIO"], priority: 10 }));
    expect(matchFileViewer("notes.d1prio", "text")?.id).toBe("d1-prio-high");
  });

  it("prefers match() over extensions regardless of priority", () => {
    track(stubViewer({ id: "d1-ext-only", extensions: [".d1m"], priority: 100 }));
    // Sniff-only: extensions: [] plus match() means "win on match, never fall through".
    track(stubViewer({
      id: "d1-match-wins",
      extensions: [],
      priority: -100,
      match: (path) => path.endsWith(".d1m")
    }));
    expect(matchFileViewer("notes.d1m", "text")?.id).toBe("d1-match-wins");
    expect(matchFileViewer("notes.d1plain", "text")).toBeUndefined();
  });

  it("uses catch-all only without a more precise hit", () => {
    track(stubViewer({ id: "d1-catchall", extensions: [], priority: 999 }));
    expect(matchFileViewer("notes.d1plain", "text")?.id).toBe("d1-catchall");
    expect(matchFileViewer("data.json", "text")?.id).toBe("source-map");
  });

  it("passes kind through to match()", () => {
    track(stubViewer({ id: "d1-media-only", match: (_path, kind) => kind === "media" }));
    expect(matchFileViewer("clip.d1bin", "media")?.id).toBe("d1-media-only");
    expect(matchFileViewer("clip.d1bin", "text")).toBeUndefined();
  });

  it("returns undefined without a hit", () => {
    expect(matchFileViewer("notes.d1nothing", "text")).toBeUndefined();
  });
});

describe("registerFileViewer", () => {
  it("registers, lists, and removes via the disposer", () => {
    expect(fileViewers().some((viewer) => viewer.id === "source-map")).toBe(true);
    const dispose = track(stubViewer({ id: "d1-gone", extensions: [".d1gone"] }));
    expect(matchFileViewer("notes.d1gone", "text")?.id).toBe("d1-gone");
    dispose();
    expect(matchFileViewer("notes.d1gone", "text")).toBeUndefined();
  });

  it("throws on duplicate or empty id", () => {
    expect(() => registerFileViewer(stubViewer({ id: "source-map" }))).toThrow(/already registered/);
    expect(() => registerFileViewer(stubViewer({ id: "" }))).toThrow(/already registered/);
  });

  it("tolerates a double dispose", () => {
    const dispose = track(stubViewer({ id: "d1-twice", extensions: [".d1twice"] }));
    dispose();
    expect(() => { dispose(); }).not.toThrow();
    expect(matchFileViewer("notes.d1twice", "text")).toBeUndefined();
  });
});

describe("subscribeFileViewers", () => {
  it("notifies listeners and advances the snapshot on register and unregister", () => {
    let calls = 0;
    const unsubscribe = subscribeFileViewers(() => { calls += 1; });
    try {
      const before = getFileViewersSnapshot();
      const dispose = track(stubViewer({ id: "d1-sub" }));
      expect(getFileViewersSnapshot()).not.toBe(before);
      expect(calls).toBeGreaterThan(0);
      const registered = getFileViewersSnapshot();
      dispose();
      expect(getFileViewersSnapshot()).not.toBe(registered);
    } finally {
      unsubscribe();
    }
    const settled = getFileViewersSnapshot();
    const quietCalls = calls;
    const dispose = track(stubViewer({ id: "d1-quiet" }));
    dispose();
    expect(calls).toBe(quietCalls);
    expect(getFileViewersSnapshot()).not.toBe(settled);
  });
});

describe("built-in source-map viewer", () => {
  it("renders valid JSON as an indented tree", () => {
    const viewer = matchFileViewer("story.json", "text");
    expect(viewer?.id).toBe("source-map");
    if (viewer === undefined) throw new Error("source-map viewer missing");
    const html = renderToStaticMarkup(createElement(viewer.component, {
      sessionId: "test",
      path: "story.json",
      content: '{"title":"顾禾","count":3,"tags":["a","b"],"nested":{"ok":true}}',
      onClose: () => undefined
    }));
    expect(html).toContain("oh-viewer-json");
    expect(html).toContain("title");
    expect(html).toContain("顾禾");
    expect(html).toContain("nested");
  });

  it("falls back to raw text when JSON parsing fails", () => {
    const viewer = matchFileViewer("story.json", "text");
    if (viewer === undefined) throw new Error("source-map viewer missing");
    const html = renderToStaticMarkup(createElement(viewer.component, {
      sessionId: "test",
      path: "story.json",
      content: "{broken",
      onClose: () => undefined
    }));
    expect(html).toContain("oh-viewer-fallback");
    expect(html).toContain("{broken");
  });
});
