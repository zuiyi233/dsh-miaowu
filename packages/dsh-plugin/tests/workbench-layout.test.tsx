import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { clampFloatGeometry, defaultFloatGeometry } from "../src/client/layout/free-window.js";
import { SplitPaneView } from "../src/client/layout/split-pane.js";
import {
  createRow,
  DEFAULT_TREE_FRACTION,
  defaultSplitTree,
  EDITOR_LEAF_ID,
  flattenLeaves,
  parseSplit,
  removeLeaf,
  sanitizeSplit,
  serializeSplit,
  setFraction,
  SPLIT_FRACTION_MAX,
  SPLIT_FRACTION_MIN,
  TREE_LEAF_ID,
  type SplitTree
} from "../src/client/layout/split-tree.js";
import {
  clearWorkbenchLayouts,
  layoutStorageKey,
  readWorkbenchLayoutRaw,
  writeWorkbenchLayoutRaw,
  type WorkbenchPreferenceStorage
} from "../src/client/workbench-presence.js";
import { featureToggleKey, isLayoutRecord, readFeatureEnabled, writeFeatureEnabled } from "../src/client/workbench-ui.js";

function storage(entries: Record<string, string> = {}): WorkbenchPreferenceStorage & { readonly entries: Record<string, string> } {
  return {
    entries,
    getItem: (key) => entries[key] ?? null,
    setItem: (key, value) => { entries[key] = value; }
  };
}

describe("split tree state machine", () => {
  it("creates a row with fraction sizes summing to 1", () => {
    const tree = createRow("a", "b", 0.3);
    expect(tree).toMatchObject({ kind: "pane", direction: "row" });
    if (tree.kind !== "pane") throw new Error("expected a pane");
    expect(tree.sizes).toHaveLength(2);
    expect(tree.sizes[0]).toBeCloseTo(0.3, 9);
    expect(tree.sizes.reduce((sum, size) => sum + size, 0)).toBeCloseTo(1, 9);
  });

  it("defaults the story split to tree | editor", () => {
    const tree = defaultSplitTree();
    expect(flattenLeaves(tree)).toEqual([TREE_LEAF_ID, EDITOR_LEAF_ID]);
    if (tree.kind !== "pane") throw new Error("expected a pane");
    expect(tree.sizes[0]).toBeCloseTo(DEFAULT_TREE_FRACTION, 9);
  });

  it("clamps divider fractions to 0.08-0.92", () => {
    const tree = createRow("a", "b", 0.5);
    const low = setFraction(tree, [0], -1);
    const high = setFraction(tree, [0], 2);
    if (low.kind !== "pane" || high.kind !== "pane") throw new Error("expected panes");
    expect(low.sizes[0]).toBeCloseTo(SPLIT_FRACTION_MIN, 9);
    expect(high.sizes[0]).toBeCloseTo(SPLIT_FRACTION_MAX, 9);
    expect(low.sizes.reduce((sum, size) => sum + size, 0)).toBeCloseTo(1, 9);
    expect(high.sizes.reduce((sum, size) => sum + size, 0)).toBeCloseTo(1, 9);
  });

  it("scales relative to the dragged pair, not the whole pane", () => {
    const tree: SplitTree = {
      kind: "pane",
      direction: "row",
      sizes: [0.5, 0.25, 0.25],
      children: [{ kind: "leaf", id: "a" }, { kind: "leaf", id: "b" }, { kind: "leaf", id: "c" }]
    };
    const next = setFraction(tree, [1], 0.5);
    if (next.kind !== "pane") throw new Error("expected a pane");
    // Pair b+c owns 0.5 of the pane; a keeps its 0.5 untouched.
    expect(next.sizes[0]).toBeCloseTo(0.5, 9);
    expect(next.sizes[1]).toBeCloseTo(0.25, 9);
    expect(next.sizes[2]).toBeCloseTo(0.25, 9);
    expect(next.sizes.reduce((sum, size) => sum + size, 0)).toBeCloseTo(1, 9);
  });

  it("ignores out-of-range divider paths", () => {
    const tree = createRow("a", "b", 0.4);
    expect(setFraction(tree, [7], 0.9)).toBe(tree);
    expect(setFraction(tree, [], 0.9)).toBe(tree);
    expect(setFraction({ kind: "leaf", id: "a" }, [0], 0.9)).toEqual({ kind: "leaf", id: "a" });
  });

  it("removes a leaf and promotes the survivor", () => {
    const single = removeLeaf(createRow("a", "b", 0.4), "b");
    expect(single).toEqual({ kind: "leaf", id: "a" });
  });

  it("renormalizes surviving sizes after removal", () => {
    const tree: SplitTree = {
      kind: "pane",
      direction: "row",
      sizes: [0.5, 0.25, 0.25],
      children: [{ kind: "leaf", id: "a" }, { kind: "leaf", id: "b" }, { kind: "leaf", id: "c" }]
    };
    const next = removeLeaf(tree, "a");
    if (next.kind !== "pane") throw new Error("expected a pane");
    expect(flattenLeaves(next)).toEqual(["b", "c"]);
    expect(next.sizes.reduce((sum, size) => sum + size, 0)).toBeCloseTo(1, 9);
  });

  it("keeps the tree unchanged for unknown leaf ids", () => {
    const tree = createRow("a", "b", 0.4);
    expect(removeLeaf(tree, "ghost")).toBe(tree);
  });

  it("sanitizes sizes back to normalized fractions", () => {
    const next = sanitizeSplit({ kind: "pane", direction: "row", sizes: [2, 2], children: [{ kind: "leaf", id: "a" }, { kind: "leaf", id: "b" }] });
    if (next.kind !== "pane") throw new Error("expected a pane");
    expect(next.sizes[0]).toBeCloseTo(0.5, 9);
    expect(next.sizes[1]).toBeCloseTo(0.5, 9);
  });

  it("falls back to the default split for malformed input", () => {
    expect(sanitizeSplit(null)).toEqual(defaultSplitTree());
    expect(sanitizeSplit({ kind: "pane" })).toEqual(defaultSplitTree());
    expect(sanitizeSplit({ kind: "leaf", id: "" })).toEqual(defaultSplitTree());
    expect(sanitizeSplit({ kind: "pane", direction: "row", sizes: [], children: [] })).toEqual(defaultSplitTree());
  });

  it("round-trips serialize/parse and recovers from corrupt JSON", () => {
    const tree = createRow("a", "b", 0.33);
    expect(parseSplit(serializeSplit(tree))).toEqual(tree);
    expect(parseSplit("{broken")).toEqual(defaultSplitTree());
    expect(parseSplit(undefined)).toEqual(defaultSplitTree());
    expect(parseSplit("")).toEqual(defaultSplitTree());
  });
});

describe("float geometry", () => {
  const viewport = { width: 1280, height: 800 };

  it("clamps windows inside the viewport", () => {
    const next = clampFloatGeometry({ x: -500, y: -500, width: 9999, height: 9999 }, viewport);
    expect(next.x).toBeGreaterThanOrEqual(8);
    expect(next.y).toBeGreaterThanOrEqual(8);
    expect(next.x + next.width).toBeLessThanOrEqual(viewport.width);
    expect(next.y + next.height).toBeLessThanOrEqual(viewport.height);
    expect(next.width).toBeGreaterThanOrEqual(280);
    expect(next.height).toBeGreaterThanOrEqual(200);
  });

  it("falls back to a default box for corrupt input", () => {
    expect(clampFloatGeometry(undefined, viewport)).toEqual(defaultFloatGeometry(viewport));
    expect(clampFloatGeometry({ width: NaN, height: Infinity }, viewport)).toEqual(defaultFloatGeometry(viewport));
  });

  it("keeps legal geometry untouched", () => {
    const box = { x: 100, y: 100, width: 560, height: 480 };
    expect(clampFloatGeometry(box, viewport)).toEqual(box);
  });
});

describe("layout storage", () => {
  it("isolates layouts per session", () => {
    const store = storage();
    writeWorkbenchLayoutRaw(store, "session-a", JSON.stringify({ split: createRow("a", "b", 0.3), floats: {} }));
    expect(layoutStorageKey("session-a")).toBe("oh-story.layout.v1.session-a");
    expect(readWorkbenchLayoutRaw(store, "session-a")).toContain("0.3");
    expect(readWorkbenchLayoutRaw(store, "session-b")).toBeUndefined();
  });

  it("tolerates blocked storage and empty session ids", () => {
    const refusing: WorkbenchPreferenceStorage = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); }
    };
    expect(readWorkbenchLayoutRaw(refusing, "s")).toBeUndefined();
    expect(() => { writeWorkbenchLayoutRaw(refusing, "s", "{}"); }).not.toThrow();
    expect(readWorkbenchLayoutRaw(storage(), "")).toBeUndefined();
    expect(readWorkbenchLayoutRaw(undefined, "s")).toBeUndefined();
    expect(() => { writeWorkbenchLayoutRaw(storage(), undefined, "{}"); }).not.toThrow();
  });

  it("clears every session layout on reset", () => {
    const entries: Record<string, string> = {
      [layoutStorageKey("a")]: "{}",
      [layoutStorageKey("b")]: "{}",
      "oh-story.workbench./work": "open"
    };
    interface KeyedStorage extends WorkbenchPreferenceStorage {
      readonly length: number;
      key: (index: number) => string | null;
      removeItem: (key: string) => void;
    }
    const withKeys: KeyedStorage = {
      getItem: (key) => entries[key] ?? null,
      setItem: (key, value) => { entries[key] = value; },
      get length() { return Object.keys(entries).length; },
      key: (index: number) => Object.keys(entries)[index] ?? null,
      removeItem: (key: string) => { delete entries[key]; }
    };
    clearWorkbenchLayouts(withKeys);
    expect(entries[layoutStorageKey("a")]).toBeUndefined();
    expect(entries[layoutStorageKey("b")]).toBeUndefined();
    expect(entries["oh-story.workbench./work"]).toBe("open");
  });
});

describe("feature toggles", () => {
  it("defaults to enabled and honors explicit disables", () => {
    const store = storage();
    expect(readFeatureEnabled(store, "history")).toBe(true);
    writeFeatureEnabled(store, "history", false);
    expect(store.entries[featureToggleKey("history")]).toBe("0");
    expect(readFeatureEnabled(store, "history")).toBe(false);
    writeFeatureEnabled(store, "history", true);
    expect(readFeatureEnabled(store, "history")).toBe(true);
  });

  it("stays enabled when storage is blocked", () => {
    const refusing = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); }
    };
    expect(readFeatureEnabled(refusing, "history")).toBe(true);
    expect(() => { writeFeatureEnabled(refusing, "history", false); }).not.toThrow();
    expect(readFeatureEnabled(undefined, "history")).toBe(true);
  });
});

describe("layout records", () => {
  it("guards persisted payloads", () => {
    expect(isLayoutRecord({ split: 1 })).toBe(true);
    expect(isLayoutRecord(null)).toBe(false);
    expect(isLayoutRecord([1])).toBe(false);
    expect(isLayoutRecord("split")).toBe(false);
  });
});

describe("split rendering", () => {
  it("renders leaves in order with dividers between them", () => {
    const html = renderToStaticMarkup(<SplitPaneView
      tree={createRow("a", "b", 0.4)}
      renderLeaf={(leafId) => <span>{`leaf-${leafId}`}</span>}
      onResize={() => undefined}
    />);
    expect(html).toContain("leaf-a");
    expect(html).toContain("leaf-b");
    expect(html.indexOf("leaf-a")).toBeLessThan(html.indexOf("leaf-b"));
    expect(html).toContain('role="separator"');
    expect(html).toContain("data-leaf");
  });

  it("lists every leaf in order for the narrow-screen merge", () => {
    const tree: SplitTree = {
      kind: "pane",
      direction: "row",
      sizes: [0.5, 0.25, 0.25],
      children: [{ kind: "leaf", id: "a" }, { kind: "leaf", id: "b" }, { kind: "leaf", id: "c" }]
    };
    // Narrow screens merge via CSS column stacking; the merge order is the
    // depth-first leaf order, dividers hidden by stylesheet rules.
    expect(flattenLeaves(tree)).toEqual(["a", "b", "c"]);
  });
});
