import { createHash } from "node:crypto";
import type {
  FileSystem,
  FsDirEntry,
  FsInfo,
  FsTarget,
  FsVersion,
  FsWriteOutcome,
} from "@deepseek-ai/dsh-fs";
import { beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceRealm } from "../src/workspace-route.js";
import {
  buildContinuityHandoff,
  buildContinuityOverview,
  createContinuitySnapshot,
  snapshotBeforeHighRiskWrite,
  verifyContinuityHandoff,
} from "../src/services/continuity.js";
import { clearTaskCaches } from "../src/services/tasks.js";

const CWD = "/books/demo";
const WS = "books/demo";
const DAY_MS = 86_400_000;
const NOW = 1_760_000_000_000;

type MemoryFs = Pick<FileSystem, "resolve" | "contains" | "stat" | "listDir" | "readBytes" | "writeText">;

interface MemoryWorkspace {
  readonly realm: WorkspaceRealm;
  readonly writes: { readonly path: string; readonly content: string }[];
  readonly read: (path: string) => string | undefined;
}

function versionOf(raw: string): FsVersion {
  return raw as unknown as FsVersion;
}

function targetOf(path: string): FsTarget {
  return { targetKey: path as FsTarget["targetKey"], displayPath: path };
}

let clock = 0;

/** 内存 FileSystem:路径以 workspace 相对坐标存储,写入逐条记录,便于断言"只读"。 */
function memoryFs(seed: Readonly<Record<string, string>> = {}): MemoryWorkspace {
  const files = new Map<string, { content: string; version: string }>();
  const writes: { readonly path: string; readonly content: string }[] = [];
  const nextVersion = (): string => {
    clock += 1;
    return `v${String(clock)}`;
  };

  const normalize = (path: string, cwd?: string): string => {
    const base = path.startsWith("/") ? [] : (cwd ?? "").replace(/^\/+/u, "").split("/").filter((part) => part !== "");
    const parts = [...base];
    for (const segment of path.split("/")) {
      if (segment === "" || segment === ".") continue;
      if (segment === "..") parts.pop();
      else parts.push(segment);
    }
    return parts.join("/");
  };
  const keyOf = (path: string): string => normalize(path, CWD);

  for (const [path, content] of Object.entries(seed)) {
    files.set(keyOf(path), { content, version: nextVersion() });
  }

  const infoOf = (path: string): FsInfo | undefined => {
    const file = files.get(path);
    if (file !== undefined) {
      return { type: "file", version: versionOf(file.version), size: Buffer.byteLength(file.content) };
    }
    const prefix = path === "" ? "" : `${path}/`;
    for (const key of files.keys()) {
      if (key.startsWith(prefix)) return { type: "directory", version: versionOf("dir") };
    }
    return undefined;
  };

  const fs: MemoryFs = {
    resolve: async (path: string, options?: { readonly cwd?: string }): Promise<FsTarget> =>
      targetOf(normalize(path, options?.cwd)),
    contains: (parent: FsTarget, child: FsTarget): boolean => {
      if (parent.displayPath === "") return true;
      const root = parent.displayPath.replace(/^\/+/u, "").replace(/\/+$/u, "");
      const candidate = child.displayPath.replace(/^\/+/u, "");
      return candidate === root || candidate.startsWith(`${root}/`);
    },
    stat: async (target: FsTarget): Promise<FsInfo | undefined> => infoOf(target.displayPath),
    listDir: async (target: FsTarget): Promise<FsDirEntry[]> => {
      const dir = target.displayPath;
      const prefix = dir === "" ? "" : `${dir}/`;
      const children = new Map<string, FsDirEntry>();
      for (const [key, file] of files) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (rest === "") continue;
        const slash = rest.indexOf("/");
        if (slash < 0) {
          children.set(rest, {
            name: rest,
            type: "file",
            target: targetOf(key),
            version: versionOf(file.version),
            size: Buffer.byteLength(file.content),
          });
        } else {
          const name = rest.slice(0, slash);
          if (!children.has(name)) {
            children.set(name, { name, type: "directory", target: targetOf(`${prefix}${name}`) });
          }
        }
      }
      return [...children.values()];
    },
    readBytes: async (target: FsTarget, _signal: AbortSignal | undefined, max: number): Promise<Uint8Array> => {
      const file = files.get(target.displayPath);
      if (file === undefined) throw new Error("FS_NOT_FOUND");
      const bytes = new TextEncoder().encode(file.content);
      if (bytes.byteLength > max) throw new Error("FS_TOO_LARGE");
      return bytes;
    },
    writeText: async (target: FsTarget, content: string): Promise<FsWriteOutcome> => {
      const before = files.get(target.displayPath)?.content ?? null;
      const version = nextVersion();
      files.set(target.displayPath, { content, version });
      writes.push({ path: target.displayPath, content });
      return {
        operation: before === null ? "create" : "update",
        version: versionOf(version),
        before,
        after: content,
      };
    },
  };

  const realm = { fs, cwd: CWD, root: targetOf(WS) } as unknown as WorkspaceRealm;
  return {
    realm,
    writes,
    read: (path: string): string | undefined => files.get(keyOf(path))?.content,
  };
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function backupBundle(createdAt: number): string {
  return JSON.stringify({
    kind: "snapshot",
    createdAt,
    files: [],
    hash: "0".repeat(64),
    sizeBytes: 120,
    counts: { files: 0, bytes: 0 },
  });
}

const FORESHADOW = {
  id: "f1",
  title: "旧玉佩",
  status: "planted",
  importance: 5,
  plannedPayoffChapter: "第4章",
  source: "manual",
  createdAt: NOW - 10 * DAY_MS,
  updatedAt: NOW - DAY_MS,
};

const RUNS = [
  {
    id: "r1",
    kind: "novel-chapter",
    status: "paused",
    meta: {},
    steps: [],
    events: [],
    createdAt: NOW - 5 * DAY_MS,
    updatedAt: NOW - 2 * DAY_MS,
    resumeCount: 1,
  },
  {
    id: "r2",
    kind: "novel-chapter",
    status: "completed",
    meta: {},
    steps: [],
    events: [],
    createdAt: NOW - 9 * DAY_MS,
    updatedAt: NOW - 8 * DAY_MS,
    resumeCount: 0,
  },
  {
    id: "r3",
    kind: "drama-batch",
    status: "cancelled",
    meta: {},
    steps: [],
    events: [],
    createdAt: NOW - 4 * DAY_MS,
    updatedAt: NOW - 4 * DAY_MS,
    resumeCount: 0,
  },
];

const CANDIDATES = [
  { id: "c1", kind: "file", title: "第三章候选", payload: {}, status: "proposed", createdAt: NOW - 9 * DAY_MS },
  { id: "c2", kind: "file", title: "已确认候选", payload: {}, status: "confirmed", createdAt: NOW - 3 * DAY_MS, decidedAt: NOW - 2 * DAY_MS },
  { id: "c3", kind: "file", title: "修订候选", payload: {}, status: "amended", createdAt: NOW - 3 * DAY_MS, decidedAt: NOW - 2 * DAY_MS },
  { id: "c4", kind: "file", title: "已应用候选", payload: {}, status: "applied", createdAt: NOW - 2 * DAY_MS, decidedAt: NOW - DAY_MS },
  { id: "c5", kind: "file", title: "已拒绝候选", payload: {}, status: "rejected", createdAt: NOW - 2 * DAY_MS, decidedAt: NOW - DAY_MS },
];

// audit.jsonl 按追加顺序写,旧→新;queryAudit 取尾部后反转即最新在前。
const AUDIT_LINES = [
  JSON.stringify({ timestamp: NOW - 120_000, action: "save", path: "正文/第2章.md", version: "v2", source: "editor" }),
  JSON.stringify({ timestamp: NOW - 60_000, action: "save", path: "正文/第3章.md", version: "v3", source: "editor" }),
].join("\n") + "\n";

function novelFixture(): Readonly<Record<string, string>> {
  return {
    "正文/第1章.md": "# 第一章\n起",
    "正文/第2章.md": "# 第二章\n承",
    "正文/第3章.md": "# 第三章\n转",
    "追踪/_tracking-state.json": JSON.stringify({ last_committed_chapter: 2, state_revision: 7 }),
    ".oh-story/shelf.json": JSON.stringify({
      schemaVersion: 1,
      entries: [{
        id: "novel:仙剑",
        name: "仙剑",
        kind: "novel",
        path: "正文/仙剑",
        title: "仙剑奇侠传",
        updatedAt: NOW - 30 * DAY_MS,
      }],
    }),
    ".oh-story/foreshadows.json": JSON.stringify({ schemaVersion: 1, items: [FORESHADOW] }),
    ".oh-story/tasks/runs.json": JSON.stringify(RUNS),
    ".oh-story/tasks/candidates.json": JSON.stringify(CANDIDATES),
    ".oh-story/backup/snapshot-20251001-000000-workspace.json": backupBundle(NOW - 10 * DAY_MS),
    ".oh-story/audit.jsonl": AUDIT_LINES,
  };
}

beforeEach(() => {
  clearTaskCaches();
});

describe("buildContinuityOverview", () => {
  it("完整小说工作区投影出今日事项、统计与风险,且全程不写盘", async () => {
    const state = memoryFs(novelFixture());
    const overview = await buildContinuityOverview(state.realm, NOW);

    expect(overview.readOnly).toBe(true);
    expect(overview.generatedAt).toBe(new Date(NOW).toISOString());
    expect(overview.project).toMatchObject({ kind: "novel", root: "", title: "demo" });
    expect(overview.project.tracking).toEqual({ lastChapter: 2, stateRevision: 7, source: "tracking" });

    expect(overview.stats.chapters).toBe(3);
    expect(overview.stats.chapterBytes).toBe(
      Buffer.byteLength("# 第一章\n起") + Buffer.byteLength("# 第二章\n承") + Buffer.byteLength("# 第三章\n转")
    );
    expect(overview.today.nextChapter).toEqual({ ordinal: 4, latestPath: "正文/第3章.md", latestTitle: "第3章" });
    expect(overview.today.dueForeshadows.map((item) => item.id)).toEqual(["f1"]);
    expect(overview.today.pausedRuns.map((run) => run.id)).toEqual(["r1"]);
    expect(overview.today.proposedCandidates).toBe(1);
    expect(overview.today.recentSaves.map((save) => save.path)).toEqual(["正文/第3章.md", "正文/第2章.md"]);
    expect(overview.today.lastBackupAt).toBe(NOW - 10 * DAY_MS);
    expect(overview.today.backupAgeDays).toBe(10);

    expect(overview.stats.runs).toEqual({ active: 0, paused: 1, failed: 0, completed: 1 });
    expect(overview.stats.candidates).toEqual({ proposed: 1, confirmed: 2, applied: 1 });
    expect(overview.stats.books).toBe(1);
    expect(overview.stats.backups).toBe(1);
    expect(overview.stats.historyFiles).toBe(0);
    expect(overview.stats.auditEntries).toBe(2);

    const ids = overview.risks.map((item) => item.id);
    expect(ids).toEqual(expect.arrayContaining([
      "tracking-behind",
      "foreshadow-due",
      "run-paused",
      "candidates-pending",
      "backup-stale",
    ]));
    expect(ids).not.toContain("backup-missing");
    expect(overview.risks.some((item) => item.level === "P0")).toBe(false);
    expect(overview.risks.find((item) => item.id === "candidates-pending")?.detail).toContain("9 天");
    expect(overview.risks.find((item) => item.id === "tracking-behind")?.paths).toEqual(["追踪/_tracking-state.json"]);

    expect(state.writes).toHaveLength(0);
  });

  it("书架损坏且密钥库有密文无主密钥时给出两个 P0,不抛错", async () => {
    const state = memoryFs({
      ".oh-story/shelf.json": "{broken",
      ".oh-story/vault/secrets.json": JSON.stringify({ v: 1, data: "ciphertext" }),
    });

    const overview = await buildContinuityOverview(state.realm, NOW);

    const p0 = overview.risks.filter((item) => item.level === "P0").map((item) => item.id).sort();
    expect(p0).toEqual(["state-corrupt", "vault-key-missing"]);
    expect(overview.stats.anomalies).toContainEqual({
      id: "shelf",
      path: ".oh-story/shelf.json",
      status: "corrupt",
    });
    expect(state.writes).toHaveLength(0);
  });

  it("空工作区降级为空概览,没有 P0,缺备份是 P1", async () => {
    const state = memoryFs();
    const overview = await buildContinuityOverview(state.realm, NOW);

    expect(overview.project).toMatchObject({ kind: "unknown", root: "", title: "demo" });
    expect(overview.project.tracking).toEqual({ lastChapter: null, stateRevision: null, source: "absent" });
    expect(overview.stats.chapters).toBe(0);
    expect(overview.today.nextChapter).toEqual({ ordinal: 1, latestPath: null, latestTitle: null });
    expect(overview.risks.some((item) => item.level === "P0")).toBe(false);
    expect(overview.risks.find((item) => item.id === "backup-missing")?.level).toBe("P1");
    expect(state.writes).toHaveLength(0);
  });

  it("最新章没有任何历史快照时给出 P2 history-missing", async () => {
    const state = memoryFs({ "正文/第3章.md": "# 第三章" });
    const overview = await buildContinuityOverview(state.realm, NOW);

    const history = overview.risks.find((item) => item.id === "history-missing");
    expect(history?.level).toBe("P2");
    expect(history?.paths).toEqual(["正文/第3章.md"]);
  });

  it("按章 snooze 不隐藏驾驶舱的到期伏笔，按时间 snooze 才隐藏", async () => {
    const scoped = memoryFs({
      ...novelFixture(),
      ".oh-story/foreshadows-snooze.json": JSON.stringify({ items: [{ id: "f1", untilChapter: "第4章" }] }),
    });
    expect((await buildContinuityOverview(scoped.realm, NOW)).today.dueForeshadows.map((item) => item.id))
      .toEqual(["f1"]);

    const timed = memoryFs({
      ...novelFixture(),
      ".oh-story/foreshadows-snooze.json": JSON.stringify({ items: [{ id: "f1", untilMs: NOW + DAY_MS }] }),
    });
    expect((await buildContinuityOverview(timed.realm, NOW)).today.dueForeshadows).toEqual([]);
  });

  it("识别正文/<书名>/第N章.md 布局，并用书架标题命名当前书", async () => {
    const state = memoryFs({
      "正文/仙剑/第1章.md": "# 第一章",
      "正文/仙剑/第2章.md": "# 第二章",
      ".oh-story/shelf.json": JSON.stringify({
        schemaVersion: 1,
        entries: [{
          id: "novel:仙剑",
          name: "仙剑",
          kind: "novel",
          path: "正文/仙剑",
          title: "仙剑奇侠传",
          updatedAt: NOW - DAY_MS,
        }],
      }),
    });

    const overview = await buildContinuityOverview(state.realm, NOW);

    expect(overview.project).toMatchObject({ kind: "novel", root: "正文/仙剑", title: "仙剑奇侠传" });
    expect(overview.stats.chapters).toBe(2);
    expect(overview.today.nextChapter).toEqual({
      ordinal: 3,
      latestPath: "正文/仙剑/第2章.md",
      latestTitle: "第2章",
    });
  });

  it("多本书且没有 .active-book 时给出 P1，不静默挑第一本", async () => {
    const state = memoryFs({
      "正文/甲/第1章.md": "# 甲",
      "正文/乙/第2章.md": "# 乙",
    });

    const overview = await buildContinuityOverview(state.realm, NOW);

    expect(overview.project.root).toBe("");
    expect(overview.stats.chapters).toBe(0);
    const risk = overview.risks.find((item) => item.id === "active-book-missing");
    expect(risk).toMatchObject({ level: "P1" });
    expect(risk?.paths).toEqual([".active-book", "正文/甲", "正文/乙"]);
  });

  it("书名/正文/ 布局的多本书同样给出 P1，不静默挑第一本", async () => {
    const state = memoryFs({
      "甲/正文/第1章.md": "# 甲",
      "乙/正文/第2章.md": "# 乙",
    });

    const overview = await buildContinuityOverview(state.realm, NOW);

    expect(overview.project.root).toBe("");
    expect(overview.stats.chapters).toBe(0);
    const risk = overview.risks.find((item) => item.id === "active-book-missing");
    expect(risk).toMatchObject({ level: "P1" });
    expect(risk?.paths).toEqual([".active-book", "甲", "乙"]);
  });

  it(".active-book 指向的书目录优先于多书歧义", async () => {
    const state = memoryFs({
      ".active-book": "正文/乙",
      "正文/甲/第1章.md": "# 甲",
      "正文/乙/第2章.md": "# 乙",
    });

    const overview = await buildContinuityOverview(state.realm, NOW);

    expect(overview.project.root).toBe("正文/乙");
    expect(overview.stats.chapters).toBe(1);
    expect(overview.today.nextChapter.ordinal).toBe(3);
    expect(overview.risks.some((item) => item.id === "active-book-missing")).toBe(false);
  });

  it("正文/书名 与 书名/正文 混用时同样视为多书歧义", async () => {
    const state = memoryFs({
      "正文/甲/第1章.md": "# 甲",
      "乙/正文/第1章.md": "# 乙",
    });

    const overview = await buildContinuityOverview(state.realm, NOW);

    expect(overview.project.root).toBe("");
    const risk = overview.risks.find((item) => item.id === "active-book-missing");
    expect(risk).toMatchObject({ level: "P1" });
    expect(risk?.paths).toEqual([".active-book", "乙", "正文/甲"]);
  });

  it("正文直属章节与嵌套书目录并存时也算多书歧义", async () => {
    const state = memoryFs({
      "正文/第1章.md": "# 根级",
      "正文/甲/第2章.md": "# 甲",
    });

    const overview = await buildContinuityOverview(state.realm, NOW);

    expect(overview.project.root).toBe("");
    const risk = overview.risks.find((item) => item.id === "active-book-missing");
    expect(risk).toMatchObject({ level: "P1" });
    expect(risk?.detail).toContain("工作区根");
    expect(risk?.paths).toEqual([".active-book", "正文/甲"]);
  });

  it("空的 书名/正文/ 目录不会被误报成第二本书", async () => {
    const state = memoryFs({
      "甲/正文/第1章.md": "# 甲",
      "乙/正文/说明.txt": "还没有章节",
    });

    const overview = await buildContinuityOverview(state.realm, NOW);

    expect(overview.project.root).toBe("甲");
    expect(overview.stats.chapters).toBe(1);
    expect(overview.risks.some((item) => item.id === "active-book-missing")).toBe(false);
  });

  it("指向不存在目录的 .active-book 给出 P1，而不是当成没有设置", async () => {
    const state = memoryFs({
      ".active-book": "正文/不存在",
      "正文/第1章.md": "# 第一章",
    });

    const overview = await buildContinuityOverview(state.realm, NOW);

    const risk = overview.risks.find((item) => item.id === "active-book-invalid");
    expect(risk).toMatchObject({ level: "P1" });
    expect(risk?.paths).toEqual([".active-book"]);
    expect(overview.risks.some((item) => item.id === "active-book-missing")).toBe(false);
  });

  it(".active-book 指向工作区外时同样判为无效", async () => {
    const state = memoryFs({
      ".active-book": "../outside",
      "正文/第1章.md": "# 第一章",
    });

    const overview = await buildContinuityOverview(state.realm, NOW);

    expect(overview.risks.find((item) => item.id === "active-book-invalid"))
      .toMatchObject({ level: "P1", paths: [".active-book"] });
  });

  it("用户可编辑状态里的绝对路径和 .. 不会进入风险与最近保存", async () => {
    const state = memoryFs({
      ...novelFixture(),
      ".oh-story/foreshadows.json": JSON.stringify({
        schemaVersion: 1,
        items: [{
          ...FORESHADOW,
          evidence: [
            { path: "C:\\Users\\me\\secret.md", line: 1 },
            { path: "../../outside.md", line: 1 },
            { path: "正文/第3章.md", line: 1 },
          ],
        }],
      }),
      ".oh-story/audit.jsonl": [
        JSON.stringify({ timestamp: NOW, action: "save", path: "C:/Users/me/secret.md", version: "v9", source: "editor" }),
        JSON.stringify({ timestamp: NOW - 1_000, action: "save", path: "正文/第3章.md", version: "v3", source: "editor" }),
      ].join("\n") + "\n",
      ".oh-story/shelf.json": JSON.stringify({
        schemaVersion: 1,
        entries: [{
          id: "novel:gone",
          name: "gone",
          kind: "novel",
          path: "D:\\outside",
          title: "回收书",
          updatedAt: NOW - 30 * DAY_MS,
          deletedAt: NOW - DAY_MS,
          deleteAfter: NOW + DAY_MS,
        }],
      }),
    });

    const overview = await buildContinuityOverview(state.realm, NOW);

    const due = overview.risks.find((item) => item.id === "foreshadow-due");
    expect(due?.paths).toEqual(["正文/第3章.md"]);
    expect(overview.today.recentSaves.map((save) => save.path)).toEqual(["正文/第3章.md"]);
    const recycle = overview.risks.find((item) => item.id === "recycle-expiring");
    expect(recycle?.paths).toEqual([]);
  });

  it("追踪字段不是数字时标为 invalid 并给出 P1", async () => {
    const state = memoryFs({
      ...novelFixture(),
      "追踪/_tracking-state.json": JSON.stringify({ last_committed_chapter: "二", state_revision: 7 }),
    });

    const overview = await buildContinuityOverview(state.realm, NOW);

    expect(overview.project.tracking).toEqual({ lastChapter: null, stateRevision: null, source: "invalid" });
    expect(overview.risks.find((item) => item.id === "tracking-invalid")).toMatchObject({ level: "P1" });
  });

  it("短剧项目没有章节模型,下一章固定为 1", async () => {
    const state = memoryFs({
      "剧集/短剧A/分镜.md": "# 分镜",
      "short-drama.json": JSON.stringify({ title: "短剧A" }),
    });
    const overview = await buildContinuityOverview(state.realm, NOW);

    expect(overview.project.kind).toBe("drama");
    expect(overview.stats.chapters).toBe(0);
    expect(overview.today.nextChapter).toEqual({ ordinal: 1, latestPath: null, latestTitle: null });
  });
});

describe("buildContinuityHandoff", () => {
  it("收录创作文件与选定的 .oh-story 状态,排除密钥,校验和可本地复算", async () => {
    const state = memoryFs({
      "正文/第1章.md": "# 第一章",
      "大纲/大纲.md": "# 大纲",
      ".oh-story/shelf.json": JSON.stringify({ schemaVersion: 1, entries: [] }),
      ".oh-story/vault/secrets.json": JSON.stringify({ v: 1, data: "secret" }),
      ".oh-story/index/meta.json": "{}",
    });

    const manifest = await buildContinuityHandoff(state.realm, 1024 * 1024, NOW);

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.root).toBe("");
    expect(manifest.generatedAt).toBe(new Date(NOW).toISOString());
    const paths = manifest.files.map((file) => file.path);
    expect(paths).toEqual([".oh-story/shelf.json", "大纲/大纲.md", "正文/第1章.md"]);
    expect(paths.some((path) => path.includes("/vault/"))).toBe(false);
    expect(manifest.excluded).toContain(".oh-story/vault/");

    const chapter = manifest.files.find((file) => file.path === "正文/第1章.md");
    expect(chapter?.bytes).toBe(Buffer.byteLength("# 第一章", "utf8"));
    expect(chapter?.sha256).toBe(sha256("# 第一章"));

    const recomputed = sha256(
      [...manifest.files]
        .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
        .map((file) => `${file.path}\0${file.sha256}`)
        .join("\n")
    );
    expect(manifest.checksum).toBe(recomputed);
    expect(state.writes).toHaveLength(0);
  });

  it("超过单文件上限的状态文件列入 skipped，而不是静默消失", async () => {
    const state = memoryFs({
      "正文/第1章.md": "# 第一章",
      ".oh-story/shelf.json": JSON.stringify({ schemaVersion: 1, entries: [] }),
    });

    const manifest = await buildContinuityHandoff(state.realm, 8, NOW);

    expect(manifest.files.map((file) => file.path)).toEqual([]);
    expect(manifest.skipped).toEqual([
      { path: ".oh-story/shelf.json", reason: "too-large" },
      { path: "正文/第1章.md", reason: "too-large" },
    ]);
    expect(manifest.excluded.some((note) => note.includes("超过单文件上限"))).toBe(true);
    expect(state.writes).toHaveLength(0);
  });

  it("历史目录超过深度上限时列入 skipped depth-limit", async () => {
    const state = memoryFs({
      ".oh-story/history/a/b/c/d/e/f/g/h/i/deep.jsonl": "{}\n",
      "正文/第1章.md": "# 第一章",
    });

    const manifest = await buildContinuityHandoff(state.realm, 1024 * 1024, NOW);

    expect(manifest.skipped).toContainEqual({
      path: ".oh-story/history/a/b/c/d/e/f/g/h/i",
      reason: "depth-limit",
    });
  });

  it("多书歧义时拒绝生成交接清单，避免只交出一部分创作树", async () => {
    const state = memoryFs({
      "正文/甲/第1章.md": "# 甲",
      "乙/正文/第1章.md": "# 乙",
    });

    await expect(buildContinuityHandoff(state.realm, 1024 * 1024, NOW))
      .rejects.toMatchObject({ status: 409 });
    expect(state.writes).toHaveLength(0);
  });

  it("文件数达到交接上限时返回 413，不把截断当成完整清单", async () => {
    const seed: Record<string, string> = {
      ".oh-story/shelf.json": JSON.stringify({ schemaVersion: 1, entries: [] }),
    };
    for (let index = 0; index < 2_000; index += 1) {
      seed[`正文/第${String(index + 1)}章.md`] = "# 正文";
    }
    const state = memoryFs(seed);

    await expect(buildContinuityHandoff(state.realm, 1024 * 1024, NOW))
      .rejects.toMatchObject({ status: 413 });
    expect(state.writes).toHaveLength(0);
  });
});

describe("verifyContinuityHandoff", () => {
  it("匹配清单返回 ok 且零写入；变更、缺失、越界与 checksum 不符分别报告", async () => {
    const state = memoryFs({
      "正文/第1章.md": "# 第一章",
      ".oh-story/shelf.json": JSON.stringify({ schemaVersion: 1, entries: [] }),
    });
    const manifest = await buildContinuityHandoff(state.realm, 1024 * 1024, NOW);
    const writesBeforeVerify = state.writes.length;
    const clean = await verifyContinuityHandoff(state.realm, manifest, 1024 * 1024);
    expect(clean.ok).toBe(true);
    expect(clean.checksumOk).toBe(true);
    expect(clean.checked).toBe(manifest.files.length);
    expect(clean.matched).toBe(manifest.files.length);
    expect(clean.files.every((file) => file.status === "match")).toBe(true);
    expect(state.writes).toHaveLength(writesBeforeVerify);

    const chapter = await state.realm.fs.resolve("正文/第1章.md", { cwd: CWD });
    await state.realm.fs.writeText(chapter, "# 改过");
    const changed = await verifyContinuityHandoff(state.realm, manifest, 1024 * 1024);
    expect(changed.ok).toBe(false);
    expect(changed.files.find((file) => file.path === "正文/第1章.md")?.status).toBe("changed");

    const withMissing = {
      ...manifest,
      files: [...manifest.files, { path: "正文/不存在.md", bytes: 1, sha256: "0".repeat(64) }],
    };
    const missing = await verifyContinuityHandoff(state.realm, withMissing, 1024 * 1024);
    expect(missing.files.find((file) => file.path === "正文/不存在.md")?.status).toBe("missing");

    const unsafe = await verifyContinuityHandoff(state.realm, {
      ...manifest,
      files: [{ path: "../escape.md", bytes: 1, sha256: "0".repeat(64) }],
    }, 1024 * 1024);
    expect(unsafe.files[0]?.status).toBe("unsafe");

    const tampered = await verifyContinuityHandoff(state.realm, {
      ...manifest,
      checksum: "0".repeat(64),
    }, 1024 * 1024);
    expect(tampered.checksumOk).toBe(false);
    expect(tampered.ok).toBe(false);
  });

  it("结构非法直接 400，不读取工作区", async () => {
    const state = memoryFs({ "正文/第1章.md": "# 第一章" });
    await expect(verifyContinuityHandoff(state.realm, { schemaVersion: 1 }, 1024 * 1024))
      .rejects.toMatchObject({ status: 400 });
    expect(state.writes).toHaveLength(0);
  });
});

describe("createContinuitySnapshot", () => {
  it("整体快照包含创作树与 .oh-story 状态，但不含 vault 主密钥", async () => {
    const state = memoryFs({
      ".active-book": "正文",
      "正文/第1章.md": "# 第一章",
      "正文/第2章.md": "# 第二章",
      ".oh-story/shelf.json": JSON.stringify({ schemaVersion: 1, entries: [] }),
      ".oh-story/vault/secrets.json": JSON.stringify({ v: 1, data: "ciphertext" }),
      ".oh-story/vault/master.key": "secret-key",
    });

    const result = await createContinuitySnapshot(state.realm, 1024 * 1024, NOW);

    expect(result.path.startsWith(".oh-story/backup/")).toBe(true);
    expect(result.path.endsWith(".json")).toBe(true);
    expect(state.writes).toHaveLength(1);
    expect(state.writes.every((write) => write.path.startsWith(`${WS}/.oh-story/backup/`))).toBe(true);
    const bundle = JSON.parse(state.writes[0]!.content) as {
      readonly kind: string;
      readonly files: readonly { readonly path: string }[];
    };
    const paths = bundle.files.map((file) => file.path);
    expect(bundle.kind).toBe("full");
    expect(paths).toEqual([
      ".active-book",
      ".oh-story/shelf.json",
      ".oh-story/vault/secrets.json",
      "正文/第1章.md",
      "正文/第2章.md",
    ]);
    expect(paths).not.toContain(".oh-story/vault/master.key");
    expect(result.counts.files).toBe(paths.length);
  });

  it("书名/正文/ 布局的快照收录当前书的正文，而不只是 .oh-story 状态", async () => {
    const state = memoryFs({
      ".active-book": "甲",
      "甲/正文/第1章.md": "# 甲",
      "甲/大纲/大纲.md": "# 大纲",
      ".oh-story/shelf.json": JSON.stringify({ schemaVersion: 1, entries: [] }),
    });

    await createContinuitySnapshot(state.realm, 1024 * 1024, NOW);

    const bundle = JSON.parse(state.writes[0]!.content) as {
      readonly files: readonly { readonly path: string }[];
    };
    const paths = bundle.files.map((file) => file.path);
    expect(paths).toContain("甲/正文/第1章.md");
    expect(paths).toContain("甲/大纲/大纲.md");
    expect(paths).toContain(".oh-story/shelf.json");
  });

  it("多书歧义时拒绝创建快照，不静默只备份其中一本", async () => {
    const state = memoryFs({
      "正文/甲/第1章.md": "# 甲",
      "乙/正文/第1章.md": "# 乙",
    });

    await expect(createContinuitySnapshot(state.realm, 1024 * 1024, NOW))
      .rejects.toMatchObject({ status: 409 });
    expect(state.writes).toHaveLength(0);
  });

  it("有文件超过单文件上限时拒绝创建快照，不把跳过报成成功", async () => {
    const state = memoryFs({
      "正文/第1章.md": "# 第一章",
    });

    await expect(createContinuitySnapshot(state.realm, 4, NOW))
      .rejects.toMatchObject({ status: 413 });
    expect(state.writes).toHaveLength(0);
  });

  it("文件数达到备份上限时拒绝创建快照，不写入截断结果", async () => {
    const seed: Record<string, string> = {};
    for (let index = 0; index < 2_000; index += 1) {
      seed[`正文/第${String(index + 1)}章.md`] = "# 正文";
    }
    const state = memoryFs(seed);

    await expect(createContinuitySnapshot(state.realm, 1024 * 1024, NOW))
      .rejects.toMatchObject({ status: 413 });
    expect(state.writes).toHaveLength(0);
  });
});

describe("snapshotBeforeHighRiskWrite", () => {
  it("首次写前创建创作树快照，节流窗口内复用同一次快照", async () => {
    const state = memoryFs({ "正文/第1章.md": "# 第一章" });

    await snapshotBeforeHighRiskWrite(state.realm, 1024 * 1024, NOW);
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0]!.path.startsWith(`${WS}/.oh-story/backup/`)).toBe(true);

    await snapshotBeforeHighRiskWrite(state.realm, 1024 * 1024, NOW + 60_000);
    expect(state.writes).toHaveLength(1);

    await snapshotBeforeHighRiskWrite(state.realm, 1024 * 1024, NOW + 10 * 60_000 + 1);
    expect(state.writes).toHaveLength(2);
  });

  it("并发写共享同一次 in-flight 快照", async () => {
    const state = memoryFs({ "正文/第1章.md": "# 第一章" });

    await Promise.all([
      snapshotBeforeHighRiskWrite(state.realm, 1024 * 1024, NOW),
      snapshotBeforeHighRiskWrite(state.realm, 1024 * 1024, NOW),
      snapshotBeforeHighRiskWrite(state.realm, 1024 * 1024, NOW),
    ]);
    expect(state.writes).toHaveLength(1);
  });

  it("多书歧义与非创作工作区静默跳过，不替用户选书也不阻断写入", async () => {
    const ambiguous = memoryFs({
      "正文/甲/第1章.md": "# 甲",
      "乙/正文/第1章.md": "# 乙",
    });
    await snapshotBeforeHighRiskWrite(ambiguous.realm, 1024 * 1024, NOW);
    expect(ambiguous.writes).toHaveLength(0);

    const empty = memoryFs({ "README.md": "# 空工作区" });
    await snapshotBeforeHighRiskWrite(empty.realm, 1024 * 1024, NOW);
    expect(empty.writes).toHaveLength(0);
  });

  it("快照失败抛 500 阻断写入，且失败不占用节流窗口", async () => {
    const state = memoryFs({ "正文/第1章.md": "# 第一章" });

    await expect(snapshotBeforeHighRiskWrite(state.realm, 4, NOW))
      .rejects.toMatchObject({ status: 500 });
    expect(state.writes).toHaveLength(0);

    // 同一 fs 在失败后立刻重试（未到 10 分钟）仍会重新尝试快照。
    await snapshotBeforeHighRiskWrite(state.realm, 1024 * 1024, NOW + 1);
    expect(state.writes).toHaveLength(1);
  });
});
