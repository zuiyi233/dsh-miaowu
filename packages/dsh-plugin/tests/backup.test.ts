import { describe, expect, it, vi } from "vitest";
import { FsError } from "@deepseek-ai/dsh-fs";
import type {
  FileSystem,
  FsDirEntry,
  FsInfo,
  FsTarget,
  FsVersion,
  FsWriteIntent,
  FsWriteOutcome,
} from "@deepseek-ai/dsh-fs";
import type { WorkspaceRealm } from "../src/workspace-route.js";
import { WorkspaceHttpError } from "../src/workspace-route.js";
import {
  asBackupBundle,
  assertRestorableBundle,
  buildBackup,
  collectFullFiles,
  collectScopeFiles,
  computeBundleHash,
  countsOf,
  createBackup,
  formatBackupTimestamp,
  listBackups,
  loadBackupFile,
  restoreBackup,
  restorePlan,
  safeBundlePath,
  slugifyBackupRoot,
  verifyBundleHash,
  type BackupBundle,
} from "../src/services/backup.js";

const CWD = "/books/demo";
const CHAPTER = "正文/第一章.md";
const OUTLINE = "大纲/结构.md";
const HISTORY = ".oh-story/history.jsonl";

function target(displayPath: string): FsTarget {
  return { targetKey: displayPath as FsTarget["targetKey"], displayPath };
}

function version(value: string): FsVersion {
  return value as FsVersion;
}

/** 轻量内存 FileSystem:resolve/contains/stat/readBytes/writeText/listDir + CAS 版本校验. */
function setup(initial: Record<string, string> = {}): {
  readonly realm: WorkspaceRealm;
  readonly read: (path: string) => string | undefined;
} {
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
    readBytes: vi.fn(async (entry: FsTarget): Promise<Uint8Array> => {
      const hit = store.get(entry.displayPath);
      if (hit === undefined) throw new FsError("missing", "FS_NOT_FOUND");
      return new TextEncoder().encode(hit.content);
    }),
    writeText: vi.fn(
      async (entry: FsTarget, content: string, expected?: FsWriteIntent): Promise<FsWriteOutcome> => {
        const hit = store.get(entry.displayPath);
        if (expected?.kind === "replaceIfVersion") {
          if (hit === undefined || hit.version !== String(expected.version)) {
            throw new FsError("stale", "FS_STALE_VERSION");
          }
        }
        const outcome: FsWriteOutcome = {
          operation: hit === undefined ? "create" : "update",
          version: version(nextVersion()),
          before: hit?.content ?? null,
          after: content,
        };
        store.set(entry.displayPath, { content, version: String(outcome.version) });
        return outcome;
      }
    ),
    listDir: vi.fn(async (entry: FsTarget): Promise<FsDirEntry[]> => {
      const prefix = `${entry.displayPath}/`;
      const children = new Map<string, { type: "file" | "directory"; target: FsTarget; version: FsVersion; size: number }>();
      for (const [key, value] of store) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash < 0) {
          children.set(rest, { type: "file", target: target(key), version: version(value.version), size: Buffer.byteLength(value.content) });
        } else {
          const name = rest.slice(0, slash);
          if (!children.has(name)) {
            children.set(name, { type: "directory", target: target(`${entry.displayPath}/${name}`), version: version("dir"), size: 0 });
          }
        }
      }
      return [...children].map(([name, child]) => ({
        name,
        type: child.type,
        target: child.target,
        version: child.version,
        size: child.size,
      }));
    }),
  } as unknown as FileSystem;
  const realm = { fs, cwd: CWD, root: target(CWD) } as unknown as WorkspaceRealm;
  return { realm, read: (path: string): string | undefined => store.get(keyOf(path))?.content };
}

const SEED = {
  [CHAPTER]: "# 第一章\n正文初稿",
  [OUTLINE]: "# 结构\n第一卷",
  [HISTORY]: '{"version":"v1"}\n',
} satisfies Record<string, string>;

async function expectHttpError(promise: Promise<unknown>, status: number): Promise<void> {
  const failure = await promise.then(
    () => undefined,
    (error: unknown) => error
  );
  expect(failure).toBeInstanceOf(WorkspaceHttpError);
  expect((failure as WorkspaceHttpError).status).toBe(status);
}

function tampered(bundle: BackupBundle): BackupBundle {
  return {
    ...bundle,
    files: bundle.files.map((file, index) => (index === 0 ? { ...file, content: `${file.content}篡改` } : file)),
  };
}

describe("纯函数:路径/时间戳/hash/counts", () => {
  it("拒绝越界与绝对路径,通过合法相对路径", () => {
    expect(safeBundlePath("正文/第一章.md")).toBe(true);
    expect(safeBundlePath(".oh-story/history.jsonl")).toBe(true);
    expect(safeBundlePath("../逃逸.md")).toBe(false);
    expect(safeBundlePath("正文/../逃逸.md")).toBe(false);
    expect(safeBundlePath("/绝对.md")).toBe(false);
    expect(safeBundlePath("正文\\反斜杠.md")).toBe(false);
    expect(safeBundlePath("")).toBe(false);
  });

  it("时间戳格式 YYYYMMDD-HHmmss,slug 去不安全字符", () => {
    expect(formatBackupTimestamp(new Date(2026, 8, 5, 12, 34, 56))).toBe("20260905-123456");
    expect(slugifyBackupRoot("正文/我的书", "bundle")).toBe("正文-我的书");
    expect(slugifyBackupRoot(undefined, "full")).toBe("full");
    expect(slugifyBackupRoot("", "bundle")).toBe("workspace");
  });

  it("buildBackup 排序收录 + hash 自洽 + sizeBytes 自洽 + counts 正确", () => {
    const bundle = buildBackup(
      "bundle",
      [
        { path: "正文/b.md", content: "bb" },
        { path: "正文/a.md", content: "a" },
      ],
      1,
      "正文"
    );
    expect(bundle.files.map((file) => file.path)).toEqual(["正文/a.md", "正文/b.md"]);
    expect(verifyBundleHash(bundle)).toBe(true);
    expect(bundle.counts).toEqual(countsOf(bundle.files));
    expect(bundle.counts.files).toBe(2);
    expect(Buffer.byteLength(JSON.stringify(bundle), "utf8")).toBe(bundle.sizeBytes);
    expect(computeBundleHash(bundle.files)).toBe(bundle.hash);
  });
});

describe("三类备份创建", () => {
  it("bundle 只收录 root 下文本,counts/hash/sizeBytes 正确", async () => {
    const { realm, read } = setup({ ...SEED, "正文/封面.png": "binary-stub" });
    const outcome = await createBackup(realm, "bundle", "正文", 1_000_000, Date.UTC(2026, 8, 5));
    expect(outcome.counts.files).toBe(1);
    const stored = JSON.parse(read(outcome.path) ?? "") as unknown;
    const bundle = asBackupBundle(stored);
    expect(bundle?.kind).toBe("bundle");
    expect(bundle?.root).toBe("正文");
    expect(bundle?.files.map((file) => file.path)).toEqual([CHAPTER]);
    expect(verifyBundleHash(bundle as BackupBundle)).toBe(true);
    expect(outcome.path.startsWith(".oh-story/backup/bundle-")).toBe(true);
  });

  it("snapshot 与 bundle 同语义但 kind 不同", async () => {
    const { realm, read } = setup(SEED);
    const outcome = await createBackup(realm, "snapshot", "大纲", 1_000_000, Date.UTC(2026, 8, 5));
    const bundle = asBackupBundle(JSON.parse(read(outcome.path) ?? "") as unknown);
    expect(bundle?.kind).toBe("snapshot");
    expect(bundle?.files.map((file) => file.path)).toEqual([OUTLINE]);
    expect(outcome.path.startsWith(".oh-story/backup/snapshot-")).toBe(true);
  });

  it("full 含创作树全部文本 + .oh-story 状态,但排除备份目录自身", async () => {
    const { realm, read } = setup(SEED);
    const first = await createBackup(realm, "full", undefined, 1_000_000, Date.UTC(2026, 8, 5));
    expect(first.path.startsWith(".oh-story/backup/full-")).toBe(true);
    const second = await createBackup(realm, "full", undefined, 1_000_000, Date.UTC(2026, 8, 5, 0, 0, 1));
    const bundle = asBackupBundle(JSON.parse(read(second.path) ?? "") as unknown);
    const paths = bundle?.files.map((file) => file.path) ?? [];
    expect(paths).toContain(CHAPTER);
    expect(paths).toContain(OUTLINE);
    expect(paths).toContain(HISTORY);
    // 备份目录自身不被递归收录.
    expect(paths.every((path) => !path.startsWith(".oh-story/backup/"))).toBe(true);
    expect(bundle?.root).toBeUndefined();
    expect(verifyBundleHash(bundle as BackupBundle)).toBe(true);
  });

  it("备份列表摘要含 kind/counts/hash 前 8 位,损坏文件降级跳过", async () => {
    const { realm } = setup(SEED);
    await createBackup(realm, "bundle", "正文", 1_000_000, Date.UTC(2026, 8, 5));
    const target = await realm.fs.resolve(".oh-story/backup/broken.json", { cwd: realm.cwd });
    await realm.fs.writeText(target, "not-json{{{", undefined, undefined, undefined);
    const summaries = await listBackups(realm);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.kind).toBe("bundle");
    expect(summaries[0]?.hashShort).toHaveLength(8);
    expect(summaries[0]?.counts.files).toBe(1);
    // 下载坏文件 400.
    await expectHttpError(loadBackupFile(realm, ".oh-story/backup/broken.json"), 400);
  });
});

describe("备份→篡改→恢复链路回归", () => {
  it("恢复目录内容为备份时原样,原目录文件未被改动", async () => {
    const { realm, read } = setup(SEED);
    const outcome = await createBackup(realm, "bundle", "正文", 1_000_000, Date.UTC(2026, 8, 5));
    // 篡改原文件.
    const chapterTarget = await realm.fs.resolve(CHAPTER, { cwd: realm.cwd });
    const info = await realm.fs.stat(chapterTarget);
    await realm.fs.writeText(chapterTarget, "# 第一章\n被篡改", { kind: "replaceIfVersion", version: info?.version as FsVersion }, undefined, undefined);
    expect(read(CHAPTER)).toBe("# 第一章\n被篡改");
    // 恢复为新项目.
    const restored = await restoreBackup(realm, { bundlePath: outcome.path });
    expect(restored.restoredRoot).not.toBe("正文");
    expect(restored.restoredRoot.startsWith("正文-恢复-")).toBe(true);
    expect(restored.counts.files).toBe(1);
    expect(read(`${restored.restoredRoot}/第一章.md`)).toBe("# 第一章\n正文初稿");
    // 原目录未被改动(篡改后的内容保留,恢复未覆盖).
    expect(read(CHAPTER)).toBe("# 第一章\n被篡改");
  });

  it("离线导入:直接传 bundle JSON 对象成功且校验 hash", async () => {
    const { realm, read } = setup(SEED);
    const outcome = await createBackup(realm, "bundle", "正文", 1_000_000, Date.UTC(2026, 8, 5));
    const offline = JSON.parse(read(outcome.path) ?? "") as unknown;
    const restored = await restoreBackup(realm, { bundle: offline });
    expect(read(`${restored.restoredRoot}/第一章.md`)).toBe("# 第一章\n正文初稿");
  });

  it("full 恢复到 workspace 根下 恢复备份-ts 目录,保留原路径结构", async () => {
    const { realm, read } = setup(SEED);
    await createBackup(realm, "full", undefined, 1_000_000, Date.UTC(2026, 8, 5));
    const summaries = await listBackups(realm);
    const restored = await restoreBackup(realm, { bundlePath: summaries[0]?.path as string });
    expect(restored.restoredRoot.startsWith("恢复备份-")).toBe(true);
    expect(read(`${restored.restoredRoot}/${CHAPTER}`)).toBe("# 第一章\n正文初稿");
    expect(read(`${restored.restoredRoot}/${HISTORY}`)).toBe('{"version":"v1"}\n');
  });
});

describe("恢复拒绝路径", () => {
  it("hash 不一致 → 400 备份已损坏", async () => {
    const { realm } = setup(SEED);
    const outcome = await createBackup(realm, "bundle", "正文", 1_000_000, Date.UTC(2026, 8, 5));
    const bundle = await loadBackupFile(realm, outcome.path);
    await expectHttpError(restoreBackup(realm, { bundle: tampered(bundle) }), 400);
    await expectHttpError((async () => assertRestorableBundle(tampered(bundle)))(), 400);
  });

  it("files 含越界路径 → 拒绝", async () => {
    const { realm } = setup(SEED);
    const evil = buildBackup("bundle", [{ path: "../逃逸.md", content: "x" }], 1, "正文");
    await expectHttpError(restoreBackup(realm, { bundle: evil }), 400);
  });

  it("缺少参数 → 400;非法备份路径 → 403", async () => {
    const { realm } = setup(SEED);
    await expectHttpError(restoreBackup(realm, {}), 400);
    await expectHttpError(loadBackupFile(realm, "../逃逸.json"), 403);
    await expectHttpError(loadBackupFile(realm, ".oh-story/backup/missing.json"), 404);
  });
});

describe("恢复计划纯函数", () => {
  it("bundle 有 root → 同级新目录去前缀;无 root → 恢复导入;full → 恢复备份", () => {
    const scoped = buildBackup("bundle", [{ path: "正文/我的书/第一章.md", content: "a" }], 1, "正文/我的书");
    const plan = restorePlan(scoped, "20260905-123456");
    expect(plan.restoredRoot).toBe("正文/我的书-恢复-20260905-123456");
    expect(plan.entries).toEqual([{ from: "正文/我的书/第一章.md", to: "正文/我的书-恢复-20260905-123456/第一章.md" }]);
    const unscoped = buildBackup("snapshot", [{ path: "正文/a.md", content: "a" }], 1);
    expect(restorePlan(unscoped, "20260905-123456").restoredRoot).toBe("恢复导入-20260905-123456");
    const full = buildBackup("full", [{ path: "正文/a.md", content: "a" }], 1);
    const fullPlan = restorePlan(full, "20260905-123456");
    expect(fullPlan.restoredRoot).toBe("恢复备份-20260905-123456");
    expect(fullPlan.entries).toEqual([{ from: "正文/a.md", to: "恢复备份-20260905-123456/正文/a.md" }]);
  });

  it("collectScopeFiles/collectFullFiles 直接覆盖收录语义", async () => {
    const { realm } = setup(SEED);
    expect((await collectScopeFiles(realm, "正文", 1_000_000)).map((file) => file.path)).toEqual([CHAPTER]);
    expect((await collectFullFiles(realm, 1_000_000)).map((file) => file.path)).toEqual([HISTORY, OUTLINE, CHAPTER]);
  });
});
