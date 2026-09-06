import { describe, expect, it, vi } from "vitest";
import type { FileSystem, FsInfo, FsTarget, FsVersion } from "@deepseek-ai/dsh-fs";
import {
  workspaceGameProjects,
  type WorkspaceRealm,
} from "../src/workspace-route.js";

const CWD = "/work/demo";

function target(displayPath: string): FsTarget {
  return { targetKey: displayPath as FsTarget["targetKey"], displayPath };
}

function version(value: string): FsVersion {
  return value as FsVersion;
}

/** 内存 FileSystem(book-directories.test.ts 同构桩,加 readBytes 供 workspaceText 读取)。 */
function setup(initial: Record<string, string> = {}): WorkspaceRealm {
  const store = new Map<string, { content: string; version: string }>();
  let counter = 0;
  const nextVersion = (): string => {
    counter += 1;
    return `v${String(counter)}`;
  };
  const keyOf = (path: string, cwd?: string): string => (path.startsWith("/") ? path : `${cwd ?? CWD}/${path}`);
  for (const [path, content] of Object.entries(initial)) {
    store.set(keyOf(path), { content, version: nextVersion() });
  }
  const fs = {
    resolve: vi.fn(async (path: string, options?: { readonly cwd?: string }): Promise<FsTarget> =>
      target(keyOf(path, options?.cwd))),
    contains: vi.fn(
      (parent: FsTarget, child: FsTarget): boolean =>
        child.displayPath === parent.displayPath || child.displayPath.startsWith(`${parent.displayPath}/`)
    ),
    stat: vi.fn(async (entry: FsTarget): Promise<FsInfo | undefined> => {
      const hit = store.get(entry.displayPath);
      if (hit !== undefined) {
        return { type: "file", version: version(hit.version), size: Buffer.byteLength(hit.content) };
      }
      const prefix = `${entry.displayPath}/`;
      for (const key of store.keys()) {
        if (key.startsWith(prefix)) return { type: "directory", version: version("dir") };
      }
      return undefined;
    }),
    readBytes: vi.fn(async (entry: FsTarget, start?: number, length?: number): Promise<Uint8Array> => {
      const hit = store.get(entry.displayPath);
      if (hit === undefined) throw new Error("FS_NOT_FOUND");
      const bytes = new TextEncoder().encode(hit.content);
      return bytes.slice(start ?? 0, length === undefined ? undefined : (start ?? 0) + length);
    }),
    listDir: vi.fn(async (entry: FsTarget) => {
      const prefix = `${entry.displayPath}/`;
      const files = new Set<string>();
      const dirs = new Set<string>();
      for (const key of store.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash < 0) files.add(rest);
        else dirs.add(rest.slice(0, slash));
      }
      return [
        ...[...dirs].map((name) => ({ name, type: "directory" as const, target: target(`${prefix}${name}`) })),
        ...[...files].map((name) => ({
          name,
          type: "file" as const,
          target: target(`${prefix}${name}`),
          version: version("v-list"),
          size: 8,
        })),
      ];
    }),
  } as unknown as FileSystem;
  return { fs, cwd: CWD, root: target(CWD) } as unknown as WorkspaceRealm;
}

const QA_PASS = JSON.stringify({
  schemaVersion: 3,
  status: "PASS",
  completeRun: { id: "run-1", evidence: "qa/evidence/run.json" },
  checks: { launch: "PASS", render: "PASS", input: "PASS", coreLoop: "PASS", outcome: "PASS", restart: "PASS" }
});

describe("workspaceGameProjects qa 摘要", () => {
  it("有 verification.json 的项目 qa.present=true、六项检查、binding 透传", async () => {
    const realm = setup({
      "game-adaptations/demo/PRODUCT_BRIEF.md": "# 演示",
      "game-adaptations/demo/qa/verification.json": QA_PASS,
      "game-adaptations/demo/build/app/index.html": "<html></html>"
    });
    const files = [
      { path: "game-adaptations/demo/PRODUCT_BRIEF.md", bytes: 8, version: "v1", kind: "text" as const },
      { path: "game-adaptations/demo/qa/verification.json", bytes: 8, version: "v-qa", kind: "text" as const },
      { path: "game-adaptations/demo/build/app/index.html", bytes: 8, version: "v2", kind: "text" as const }
    ];
    const [project] = await workspaceGameProjects(realm, files, "session-1", 2_097_152);
    expect(project).toBeDefined();
    expect(project?.qa.present).toBe(true);
    expect(project?.qa.verdict).toBe("PASS");
    expect(project?.qa.checks).toHaveLength(6);
    // 新鲜度来自 WorkspaceVerificationTracker 进程态追踪,摘要只透传不伪造。
    expect(["CURRENT", "STALE", "UNBOUND", "PINNED"]).toContain(project?.qa.binding);
    expect(project?.verification.status).toBe("PASS");
  });

  it("无 verification.json 的项目 qa.present=false,不报错", async () => {
    const realm = setup({ "game-adaptations/empty/PRODUCT_BRIEF.md": "# 空" });
    const files = [
      { path: "game-adaptations/empty/PRODUCT_BRIEF.md", bytes: 8, version: "v1", kind: "text" as const }
    ];
    const [project] = await workspaceGameProjects(realm, files, "session-2", 2_097_152);
    expect(project).toBeDefined();
    expect(project?.qa).toEqual({ present: false });
  });

  it("坏 JSON 的 verification.json 降级为 present=false,整表不中断", async () => {
    const realm = setup({
      "game-adaptations/broken/PRODUCT_BRIEF.md": "# 坏",
      "game-adaptations/broken/qa/verification.json": "{oops",
      "game-adaptations/good/PRODUCT_BRIEF.md": "# 好",
      "game-adaptations/good/qa/verification.json": QA_PASS
    });
    const files = [
      { path: "game-adaptations/broken/PRODUCT_BRIEF.md", bytes: 8, version: "v1", kind: "text" as const },
      { path: "game-adaptations/broken/qa/verification.json", bytes: 8, version: "v2", kind: "text" as const },
      { path: "game-adaptations/good/PRODUCT_BRIEF.md", bytes: 8, version: "v3", kind: "text" as const },
      { path: "game-adaptations/good/qa/verification.json", bytes: 8, version: "v4", kind: "text" as const }
    ];
    const projects = await workspaceGameProjects(realm, files, "session-3", 2_097_152);
    expect(projects).toHaveLength(2);
    expect(projects.find((item) => item.root === "game-adaptations/broken")?.qa).toEqual({ present: false });
    expect(projects.find((item) => item.root === "game-adaptations/good")?.qa.present).toBe(true);
  });
});
