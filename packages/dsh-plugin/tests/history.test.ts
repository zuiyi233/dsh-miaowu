import { describe, expect, it, vi } from "vitest";
import { FsError } from "@deepseek-ai/dsh-fs";
import type {
  FileSystem,
  FsInfo,
  FsTarget,
  FsVersion,
  FsWriteIntent,
  FsWriteOutcome,
} from "@deepseek-ai/dsh-fs";
import type { WorkspaceRealm } from "../src/workspace-route.js";
import { WorkspaceHttpError } from "../src/workspace-route.js";
import {
  contentHash,
  createAnnotation,
  deleteAnnotation,
  getVersionSnapshot,
  HISTORY_LIMIT,
  historyFileName,
  listAnnotations,
  listVersions,
  parseAuditEntries,
  queryAudit,
  reanchorAnnotations,
  recordSave,
  rollbackToVersion,
  trimSnapshots,
  type Annotation,
  type HistorySnapshot,
} from "../src/services/history.js";

const CWD = "/books/demo";
const CHAPTER = "正文/第001章.md";
const OUTLINE = "大纲/结构.md";
const NOTE_FILE = "正文/批注.md";

function target(displayPath: string): FsTarget {
  return { targetKey: displayPath as FsTarget["targetKey"], displayPath };
}

function version(value: string): FsVersion {
  return value as FsVersion;
}

/** 轻量内存 FileSystem:路径即 key,带 CAS 版本校验,覆盖 resolve/contains/stat/readBytes/writeText。 */
function setup(initial: Record<string, string> = {}): {
  readonly realm: WorkspaceRealm;
  readonly seed: (path: string, content: string, fileVersion: string) => void;
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
  } as unknown as FileSystem;
  const realm = { fs, cwd: CWD, root: target(CWD) } as unknown as WorkspaceRealm;
  return {
    realm,
    seed: (path: string, content: string, fileVersion: string): void => {
      store.set(keyOf(path), { content, version: fileVersion });
    },
    read: (path: string): string | undefined => store.get(keyOf(path))?.content,
  };
}

async function expectHttpError(promise: Promise<unknown>, status: number): Promise<void> {
  const failure = await promise.then(
    () => undefined,
    (error: unknown) => error
  );
  expect(failure).toBeInstanceOf(WorkspaceHttpError);
  expect((failure as WorkspaceHttpError).status).toBe(status);
}

function annotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: "a1",
    lineStart: 2,
    lineEnd: 2,
    quote: "第二行",
    note: "备注",
    kind: "note",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("保存事件 → 快照 + 审计 + 版本列表", () => {
  it("追加快照并记录审计,版本列表新→旧且不含正文", async () => {
    const { realm } = setup();
    expect(await recordSave({ path: CHAPTER, content: "第一版\n正文", bytes: 10, version: "s1", realm })).toBe(true);
    await recordSave({ path: CHAPTER, content: "第二版\n正文", bytes: 11, version: "s2", realm });
    const versions = await listVersions(realm, CHAPTER);
    expect(versions).toHaveLength(2);
    expect(versions[0]).toMatchObject({ version: "s2", source: "save" });
    expect(versions[1]).toMatchObject({ version: "s1", source: "save" });
    expect(versions[0]).not.toHaveProperty("content");
    const latest = await getVersionSnapshot(realm, CHAPTER, "s2");
    expect(latest?.content).toBe("第二版\n正文");
    expect(latest?.parentVersion).toBe("s1");
    const entries = await queryAudit(realm, CHAPTER, 200);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ action: "save", source: "editor", path: CHAPTER, version: "s2" });
  });

  it("同 version 重复触发不重复追加", async () => {
    const { realm } = setup();
    await recordSave({ path: CHAPTER, content: "第一版", bytes: 9, version: "s1", realm });
    expect(await recordSave({ path: CHAPTER, content: "第一版", bytes: 9, version: "s1", realm })).toBe(false);
    expect(await listVersions(realm, CHAPTER)).toHaveLength(1);
    expect(await queryAudit(realm, CHAPTER, 200)).toHaveLength(1);
  });

  it("审计支持按路径过滤与条数上限", async () => {
    const { realm } = setup();
    await recordSave({ path: CHAPTER, content: "一", bytes: 1, version: "s1", realm });
    await recordSave({ path: OUTLINE, content: "纲", bytes: 1, version: "o1", realm });
    await recordSave({ path: CHAPTER, content: "二", bytes: 1, version: "s2", realm });
    expect(await queryAudit(realm, undefined, 200)).toHaveLength(3);
    expect(await queryAudit(realm, CHAPTER, 200)).toHaveLength(2);
    const latest = await queryAudit(realm, undefined, 1);
    expect(latest).toHaveLength(1);
    expect(latest[0]).toMatchObject({ path: CHAPTER, version: "s2" });
  });
});

describe("rollback", () => {
  it("成功回滚恢复内容并追加 rollback 快照与审计", async () => {
    const { realm, seed, read } = setup();
    seed(CHAPTER, "第三版", "disk3");
    await recordSave({ path: CHAPTER, content: "第一版", bytes: 9, version: "s1", realm });
    await recordSave({ path: CHAPTER, content: "第二版", bytes: 9, version: "s2", realm });
    const outcome = await rollbackToVersion(realm, CHAPTER, "s1", "disk3");
    expect(outcome.content).toBe("第一版");
    expect(read(CHAPTER)).toBe("第一版");
    const versions = await listVersions(realm, CHAPTER);
    expect(versions[0]).toMatchObject({ version: outcome.version, source: "rollback" });
    const entries = await queryAudit(realm, CHAPTER, 200);
    expect(entries[0]).toMatchObject({ action: "rollback", source: "rollback", version: outcome.version });
  });

  it("baseVersion 过期返回 412,底层 CAS 同样抛 FS_STALE_VERSION", async () => {
    const { realm, seed } = setup();
    seed(CHAPTER, "第三版", "disk3");
    await recordSave({ path: CHAPTER, content: "第一版", bytes: 9, version: "s1", realm });
    await expectHttpError(rollbackToVersion(realm, CHAPTER, "s1", "expired"), 412);
    const stale = await realm.fs
      .writeText(await realm.fs.resolve(CHAPTER, { cwd: CWD }), "x", {
        kind: "replaceIfVersion",
        version: version("expired"),
      })
      .then(
        () => undefined,
        (error: unknown) => error
      );
    expect(stale).toBeInstanceOf(FsError);
    expect((stale as FsError).code).toBe("FS_STALE_VERSION");
  });

  it("不存在的版本返回 404", async () => {
    const { realm, seed } = setup();
    seed(CHAPTER, "第三版", "disk3");
    await expectHttpError(rollbackToVersion(realm, CHAPTER, "missing", "disk3"), 404);
  });
});

describe("快照裁剪", () => {
  it("超过 HISTORY_LIMIT 条时丢弃最旧", async () => {
    const { realm } = setup();
    for (let index = 1; index <= HISTORY_LIMIT + 5; index += 1) {
      await recordSave({ path: CHAPTER, content: `第${String(index)}版`, bytes: 5, version: `k${String(index)}`, realm });
    }
    const versions = await listVersions(realm, CHAPTER);
    expect(versions).toHaveLength(HISTORY_LIMIT);
    expect(versions[0]?.version).toBe(`k${String(HISTORY_LIMIT + 5)}`);
    expect(versions.at(-1)?.version).toBe("k6");
  });

  it("trimSnapshots 纯函数只保留最近 HISTORY_LIMIT 条", () => {
    const snapshots: HistorySnapshot[] = Array.from({ length: HISTORY_LIMIT + 2 }, (_, index) => ({
      version: `v${String(index)}`,
      contentHash: "h",
      content: "c",
      bytes: 1,
      source: "save" as const,
      timestamp: index,
    }));
    const trimmed = trimSnapshots(snapshots);
    expect(trimmed).toHaveLength(HISTORY_LIMIT);
    expect(trimmed[0]?.version).toBe("v2");
    expect(trimmed.at(-1)?.version).toBe(`v${String(HISTORY_LIMIT + 1)}`);
  });
});

describe("reanchorAnnotations", () => {
  it("内容小幅编辑后按 quote 更新行号并标记 moved", () => {
    const [next] = reanchorAnnotations("新首行\n第一行\n第二行\n第三行", [annotation()]);
    expect(next).toMatchObject({ lineStart: 3, lineEnd: 3, moved: true, quote: "第二行" });
    expect(next).not.toHaveProperty("stale");
  });

  it("quote 被删除后标记 stale 但不丢批注", () => {
    const [next] = reanchorAnnotations("第一行\n第三行", [annotation()]);
    expect(next).toMatchObject({ lineStart: 2, stale: true, quote: "第二行", note: "备注" });
    expect(next).not.toHaveProperty("moved");
  });

  it("无关编辑不触动批注", () => {
    const current = annotation();
    expect(reanchorAnnotations("第一行\n第二行\n第三行", [current])).toEqual([current]);
  });

  it("多行 quote 整体搬移后行区间同步更新", () => {
    const multi = annotation({ lineStart: 2, lineEnd: 3, quote: "b\nc" });
    const [next] = reanchorAnnotations("x\na\nb\nc\nd", [multi]);
    expect(next).toMatchObject({ lineStart: 3, lineEnd: 4, moved: true });
  });

  it("quote 移出 ±10 行窗口后标记 stale", () => {
    const filler = (count: number): string =>
      [...Array<string>(count).fill("填充"), "第一行", "第二行", "第三行"].join("\n");
    const [far] = reanchorAnnotations(filler(11), [annotation()]);
    expect(far?.stale).toBe(true);
    const [near] = reanchorAnnotations(filler(10), [annotation()]);
    expect(near).toMatchObject({ lineStart: 12, moved: true });
  });
});

describe("批注创建与删除", () => {
  it("创建时服务端从当前文件截取 quote", async () => {
    const { realm } = setup({ [NOTE_FILE]: "第一行\n第二行\n第三行" });
    const created = await createAnnotation(realm, NOTE_FILE, {
      lineStart: 2,
      lineEnd: 3,
      note: "待润色",
      kind: "todo",
    });
    expect(created.quote).toBe("第二行\n第三行");
    expect(created.kind).toBe("todo");
    expect(created.id).not.toBe("");
    expect(await listAnnotations(realm, NOTE_FILE)).toHaveLength(1);
  });

  it("删除存在的批注返回 true,不存在的返回 false", async () => {
    const { realm } = setup({ [NOTE_FILE]: "第一行\n第二行\n第三行" });
    const created = await createAnnotation(realm, NOTE_FILE, { lineStart: 1, lineEnd: 1, note: "n", kind: "note" });
    expect(await deleteAnnotation(realm, NOTE_FILE, created.id)).toBe(true);
    expect(await listAnnotations(realm, NOTE_FILE)).toHaveLength(0);
    expect(await deleteAnnotation(realm, NOTE_FILE, created.id)).toBe(false);
  });

  it("非法行区间与非法类型返回 400", async () => {
    const { realm } = setup({ [NOTE_FILE]: "第一行\n第二行\n第三行" });
    await expectHttpError(createAnnotation(realm, NOTE_FILE, { lineStart: 0, lineEnd: 1, note: "n", kind: "note" }), 400);
    await expectHttpError(createAnnotation(realm, NOTE_FILE, { lineStart: 2, lineEnd: 1, note: "n", kind: "note" }), 400);
    await expectHttpError(createAnnotation(realm, NOTE_FILE, { lineStart: 1, lineEnd: 99, note: "n", kind: "note" }), 400);
    await expectHttpError(createAnnotation(realm, NOTE_FILE, { lineStart: 1, lineEnd: 1, note: "n", kind: "bad" }), 400);
  });

  it("损坏的 annotations.json 降级为空并可继续写入", async () => {
    const { realm, seed } = setup({ [NOTE_FILE]: "第一行\n第二行" });
    seed(".oh-story/annotations.json", "{broken", "corrupt");
    expect(await listAnnotations(realm, NOTE_FILE)).toEqual([]);
    await createAnnotation(realm, NOTE_FILE, { lineStart: 1, lineEnd: 1, note: "n", kind: "review" });
    expect(await listAnnotations(realm, NOTE_FILE)).toHaveLength(1);
  });
});

describe("纯函数与命名", () => {
  it("historyFileName 稳定且 16 位 hex", () => {
    expect(historyFileName(CHAPTER)).toBe(historyFileName(CHAPTER));
    expect(historyFileName(CHAPTER)).not.toBe(historyFileName(OUTLINE));
    expect(historyFileName(CHAPTER)).toMatch(/^[0-9a-f]{16}\.jsonl$/u);
  });

  it("parseAuditEntries 跳过坏行并保留好行", () => {
    const entries = parseAuditEntries(
      'broken\n{"timestamp":1,"action":"save","path":"p","version":"v","source":"editor"}\n\n{"bad":1}\n'
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ path: "p", version: "v" });
  });

  it("contentHash 稳定且区分内容", () => {
    expect(contentHash("a")).toBe(contentHash("a"));
    expect(contentHash("a")).not.toBe(contentHash("b"));
  });
});
