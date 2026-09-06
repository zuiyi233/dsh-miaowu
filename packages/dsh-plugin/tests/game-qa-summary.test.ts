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
    writeText: vi.fn(async (entry: FsTarget, content: string): Promise<unknown> => {
      store.set(entry.displayPath, { content, version: nextVersion() });
      return { after: content, version: version(store.get(entry.displayPath)?.version ?? "v0") };
    }),
  } as unknown as FileSystem;
  return { fs, cwd: CWD, root: target(CWD), agent: { session: "stub" }, sandboxPolicy: { resolve: () => undefined } } as unknown as WorkspaceRealm;
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

describe("workspaceGameProjects 运行证据三态", () => {
  const filesOf = (paths: readonly string[]): readonly { path: string; bytes: number; version: string; kind: "text" | "media" }[] =>
    paths.map((path, index) => ({ path, bytes: 8, version: `v${index}`, kind: "text" as const }));

  it("evidence 文件存在时 runEvidence=file,证据文本指向路径", async () => {
    const realm = setup({
      "game-adaptations/demo/PRODUCT_BRIEF.md": "# 演示",
      "game-adaptations/demo/qa/verification.json": QA_PASS,
      "game-adaptations/demo/qa/evidence/run.json": "{}",
      "game-adaptations/demo/build/app/index.html": "<html></html>"
    });
    const files = filesOf([
      "game-adaptations/demo/PRODUCT_BRIEF.md",
      "game-adaptations/demo/qa/verification.json",
      "game-adaptations/demo/qa/evidence/run.json",
      "game-adaptations/demo/build/app/index.html"
    ]);
    const [project] = await workspaceGameProjects(realm, files, "session-e1", 2_097_152);
    expect(project?.qa.runEvidence).toEqual({ path: "qa/evidence/run.json", exists: true, kind: "file" });
    expect(project?.qa.checks?.[0]?.evidence).toContain("qa/evidence/run.json");
    expect(project?.qa.checks?.[0]?.evidence).not.toContain("缺失");
  });

  it("evidence 文件缺失时 runEvidence=missing 且不再宣称可见", async () => {
    const realm = setup({
      "game-adaptations/demo/PRODUCT_BRIEF.md": "# 演示",
      "game-adaptations/demo/qa/verification.json": QA_PASS,
      "game-adaptations/demo/build/app/index.html": "<html></html>"
    });
    const files = filesOf([
      "game-adaptations/demo/PRODUCT_BRIEF.md",
      "game-adaptations/demo/qa/verification.json",
      "game-adaptations/demo/build/app/index.html"
    ]);
    const [project] = await workspaceGameProjects(realm, files, "session-e2", 2_097_152);
    expect(project?.qa.runEvidence).toEqual({ path: "qa/evidence/run.json", exists: false, kind: "missing" });
    expect(project?.qa.checks?.[0]?.evidence).toContain("运行证据缺失");
  });

  it("evidence 路径越界按 missing 处理;无 evidence 字段不检查", async () => {
    const escape = QA_PASS.replace("qa/evidence/run.json", "../outside.json");
    const plain = JSON.stringify({
      schemaVersion: 3,
      status: "PASS",
      completeRun: { id: "run-1" },
      checks: { launch: "PASS", render: "PASS", input: "PASS", coreLoop: "PASS", outcome: "PASS", restart: "PASS" }
    });
    const realm = setup({
      "game-adaptations/escape/PRODUCT_BRIEF.md": "# 越界",
      "game-adaptations/escape/qa/verification.json": escape,
      "game-adaptations/escape/build/app/index.html": "<html></html>",
      "game-adaptations/plain/PRODUCT_BRIEF.md": "# 无路径",
      "game-adaptations/plain/qa/verification.json": plain,
      "game-adaptations/plain/build/app/index.html": "<html></html>"
    });
    const files = filesOf([
      "game-adaptations/escape/PRODUCT_BRIEF.md",
      "game-adaptations/escape/qa/verification.json",
      "game-adaptations/escape/build/app/index.html",
      "game-adaptations/plain/PRODUCT_BRIEF.md",
      "game-adaptations/plain/qa/verification.json",
      "game-adaptations/plain/build/app/index.html"
    ]);
    const projects = await workspaceGameProjects(realm, files, "session-e3", 2_097_152);
    const escapeProject = projects.find((item) => item.root === "game-adaptations/escape");
    const plainProject = projects.find((item) => item.root === "game-adaptations/plain");
    expect(escapeProject?.qa.runEvidence).toEqual({ path: "../outside.json", exists: false, kind: "missing" });
    expect(plainProject?.qa.runEvidence).toBeUndefined();
    expect(plainProject?.qa.checks?.[0]?.evidence).toContain("本次运行未记录 evidence 路径");
  });
});

describe("workspaceGameProjects QA 新鲜度侧车持久化", () => {
  const baseStore = (): Record<string, string> => ({
    "game-adaptations/demo/PRODUCT_BRIEF.md": "# 演示",
    "game-adaptations/demo/qa/verification.json": QA_PASS,
    "game-adaptations/demo/build/app/index.html": "<html></html>"
  });
  const filesWithQaVersion = (qaVersion: string): readonly { path: string; bytes: number; version: string; kind: "text" }[] => [
    { path: "game-adaptations/demo/PRODUCT_BRIEF.md", bytes: 8, version: "v1", kind: "text" },
    { path: "game-adaptations/demo/qa/verification.json", bytes: 8, version: qaVersion, kind: "text" },
    { path: "game-adaptations/demo/build/app/index.html", bytes: 8, version: "v2", kind: "text" }
  ];

  it("QA 重写建立绑定并写回侧车;跨 realm 读回后 CURRENT 不回退到 UNBOUND", async () => {
    // WorkspaceVerificationTracker 是模块级单例,绑定只在 QA 文件 version 变化时产生:
    // 第一次 observe 只记未绑定观察,第二次(QA 重写)才 bound:true——与真实进程行为一致。
    const realm = setup(baseStore());
    const warnings: string[] = [];
    await workspaceGameProjects(realm, filesWithQaVersion("v-qa-1"), "session-p1", 2_097_152, (message) => { warnings.push(message); });
    await workspaceGameProjects(realm, filesWithQaVersion("v-qa-2"), "session-p1", 2_097_152, (message) => { warnings.push(message); });
    expect(warnings).toHaveLength(0);
    const persisted = await readPersistedEntries(realm);
    const parsed = JSON.parse(persisted["game-adaptations/demo/qa/.verification-observations.json"] ?? "{}") as {
      version: number;
      entries: { key: string; bound: boolean }[];
    };
    expect(parsed.version).toBe(1);
    expect(parsed.entries.find((entry) => entry.key === "session-p1\0game-adaptations/demo")?.bound).toBe(true);
    // 新 realm + 已"落盘"侧车 = 重启后的进程:hydrate 读回,同版本 observe 应维持 CURRENT。
    const second = setup({ ...baseStore(), ...persisted });
    const [project] = await workspaceGameProjects(second, filesWithQaVersion("v-qa-2"), "session-p1", 2_097_152, (message) => { warnings.push(message); });
    expect(warnings).toHaveLength(0);
    expect(project?.qa.binding).toBe("CURRENT");
  });

  it("侧车损坏时按空记录处理并暴露 warning,列表不中断", async () => {
    const realm = setup({
      ...baseStore(),
      "game-adaptations/demo/qa/.verification-observations.json": "{oops"
    });
    const warnings: string[] = [];
    const [project] = await workspaceGameProjects(realm, filesWithQaVersion("v-qa"), "session-p2", 2_097_152, (message) => { warnings.push(message); });
    expect(project?.qa.present).toBe(true);
    expect(warnings.some((message) => message.includes("损坏"))).toBe(true);
  });
});

/** 从第一轮 realm 的内存 fs 里取写回的侧车内容,喂给第二轮 realm(initial 形状与磁盘一致)。 */
async function readPersistedEntries(realm: WorkspaceRealm): Promise<Record<string, string>> {
  const fs = realm.fs as unknown as {
    resolve: (path: string, options?: { readonly cwd?: string }) => Promise<{ displayPath: string }>;
    readBytes: (entry: { displayPath: string }) => Promise<Uint8Array>;
  };
  const resolved = await fs.resolve("game-adaptations/demo/qa/.verification-observations.json", { cwd: CWD });
  const bytes = await fs.readBytes(resolved);
  return { "game-adaptations/demo/qa/.verification-observations.json": new TextDecoder().decode(bytes) };
}
