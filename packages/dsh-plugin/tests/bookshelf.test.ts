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
  archivedShelf,
  archiveEntry,
  defaultShelf,
  discoverWorks,
  isRecycleExpired,
  listArchive,
  listShelf,
  loadShelf,
  makeEntryId,
  mergeScanEntries,
  parseShelf,
  purgeEntry,
  purgeExpiredEntries,
  purgeExpiredShelf,
  recycleBin,
  restoreEntry,
  RETENTION_DAYS,
  retentionDeadline,
  scanWorkspace,
  softDeleteEntry,
  type DiscoveredWork,
  type ShelfEntry,
} from "../src/services/bookshelf.js";

const CWD = "/books/demo";
const DAY_MS = 86_400_000;

function target(displayPath: string): FsTarget {
  return { targetKey: displayPath as FsTarget["targetKey"], displayPath };
}

function version(value: string): FsVersion {
  return value as FsVersion;
}

/** 内存 FileSystem:路径即 key,带 CAS 版本校验,覆盖 resolve/contains/stat/readBytes/writeText/listDir。 */
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
        ...[...files].map((name) => ({ name, type: "file" as const, target: target(`${prefix}${name}`) })),
      ];
    }),
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

const BASE_FILES: Record<string, string> = {
  "正文/仙剑/第一章.md": "# 仙剑\n正文",
  "正文/凡人/序章.md": "# 凡人\n正文",
  "剧集/短剧A/分镜.md": "# 短剧A\n分镜",
  "剧集/空目录/说明.md": "没有分镜标记,不是作品",
  "game-adaptations/roguelike/PRODUCT_BRIEF.md": "# PRODUCT_BRIEF roguelike",
  "video-recaps/recap1/project.json": "{}",
};

describe("scan 发现作品根", () => {
  it("识别小说/短剧/游戏/视频四类作品根,无标记的短剧目录不算作品", async () => {
    const { realm } = setup(BASE_FILES);
    const discovered = await discoverWorks(realm);
    expect(discovered).toContainEqual({ kind: "novel", name: "仙剑", path: "正文/仙剑" });
    expect(discovered).toContainEqual({ kind: "novel", name: "凡人", path: "正文/凡人" });
    expect(discovered).toContainEqual({ kind: "drama", name: "短剧A", path: "剧集/短剧A" });
    expect(discovered).toContainEqual({ kind: "game", name: "roguelike", path: "game-adaptations/roguelike" });
    expect(discovered).toContainEqual({ kind: "video", name: "recap1", path: "video-recaps/recap1" });
    expect(discovered.some((work) => work.name === "空目录")).toBe(false);
  });

  it("分镜.md 直接落在剧集/ 根时记为名为剧集的单剧集作品", async () => {
    const { realm } = setup({ "剧集/分镜.md": "# 单剧集\n分镜" });
    expect(await discoverWorks(realm)).toContainEqual({ kind: "drama", name: "剧集", path: "剧集" });
  });

  it("空工作区扫描返回空书架,不抛错", async () => {
    const { realm } = setup();
    const summary = await scanWorkspace(realm, 1000);
    expect(summary.entries).toEqual([]);
    expect(summary.added).toBe(0);
    expect(summary.total).toBe(0);
    expect(await listShelf(realm)).toEqual([]);
  });

  it("二次扫描幂等:同名更新时间刷新,但保留归档与删除状态", async () => {
    const { realm } = setup(BASE_FILES);
    const first = await scanWorkspace(realm, 1000);
    expect(first.added).toBe(5);
    await archiveEntry(realm, makeEntryId("novel", "仙剑"), 2000);
    await softDeleteEntry(realm, makeEntryId("novel", "凡人"), 2000);
    const second = await scanWorkspace(realm, 3000);
    expect(second.added).toBe(0);
    expect(second.updated).toBe(5);
    const data = await loadShelf(realm);
    const xianjian = data.entries.find((entry) => entry.id === makeEntryId("novel", "仙剑"));
    const fanren = data.entries.find((entry) => entry.id === makeEntryId("novel", "凡人"));
    expect(xianjian?.archivedAt).toBe(2000);
    expect(xianjian?.updatedAt).toBe(3000);
    expect(fanren?.deletedAt).toBe(2000);
    expect(fanren?.updatedAt).toBe(3000);
  });
});

describe("archive/restore 生命周期", () => {
  it("归档后退出默认书架,恢复后回到默认书架", async () => {
    const { realm } = setup(BASE_FILES);
    await scanWorkspace(realm, 1000);
    const id = makeEntryId("novel", "仙剑");
    expect((await listShelf(realm)).some((entry) => entry.id === id)).toBe(true);
    const archived = await archiveEntry(realm, id, 2000);
    expect(archived.archivedAt).toBe(2000);
    expect((await listShelf(realm)).some((entry) => entry.id === id)).toBe(false);
    const listing = await listArchive(realm, false);
    expect(listing.archived.some((entry) => entry.id === id)).toBe(true);
    expect(listing.deleted).toEqual([]);
    const restored = await restoreEntry(realm, id);
    expect(restored.archivedAt).toBeUndefined();
    expect((await listShelf(realm)).some((entry) => entry.id === id)).toBe(true);
  });

  it("重复归档/恢复幂等,不存在的作品返回 404", async () => {
    const { realm } = setup(BASE_FILES);
    await scanWorkspace(realm, 1000);
    const id = makeEntryId("novel", "仙剑");
    await archiveEntry(realm, id, 2000);
    expect((await archiveEntry(realm, id, 3000)).archivedAt).toBe(2000);
    await restoreEntry(realm, id);
    expect((await restoreEntry(realm, id)).archivedAt).toBeUndefined();
    await expectHttpError(archiveEntry(realm, "novel:不存在", 1000), 404);
    await expectHttpError(restoreEntry(realm, "novel:不存在"), 404);
  });

  it("回收站中的作品不能直接归档(409)", async () => {
    const { realm } = setup(BASE_FILES);
    await scanWorkspace(realm, 1000);
    const id = makeEntryId("novel", "仙剑");
    await softDeleteEntry(realm, id, 1000);
    await expectHttpError(archiveEntry(realm, id, 2000), 409);
  });
});

describe("软删除 → 回收站 → 恢复/永久移除", () => {
  it("软删除写 deletedAt + deleteAfter(30 天),只进回收站视图", async () => {
    expect(RETENTION_DAYS).toBe(30);
    const { realm } = setup(BASE_FILES);
    await scanWorkspace(realm, 1000);
    const id = makeEntryId("game", "roguelike");
    const deleted = await softDeleteEntry(realm, id, 1000);
    expect(deleted.deletedAt).toBe(1000);
    expect(deleted.deleteAfter).toBe(1000 + 30 * DAY_MS);
    expect(deleted.deleteAfter).toBe(retentionDeadline(1000));
    expect((await listShelf(realm)).some((entry) => entry.id === id)).toBe(false);
    const hidden = await listArchive(realm, false);
    expect(hidden.archived.some((entry) => entry.id === id)).toBe(false);
    expect(hidden.deleted).toEqual([]);
    const shown = await listArchive(realm, true);
    expect(shown.deleted.some((entry) => entry.id === id)).toBe(true);
  });

  it("回收站恢复后回到默认书架,双字段同时清除", async () => {
    const { realm } = setup(BASE_FILES);
    await scanWorkspace(realm, 1000);
    const id = makeEntryId("video", "recap1");
    await softDeleteEntry(realm, id, 1000);
    const restored = await restoreEntry(realm, id);
    expect(restored.deletedAt).toBeUndefined();
    expect(restored.deleteAfter).toBeUndefined();
    expect((await listShelf(realm)).some((entry) => entry.id === id)).toBe(true);
    expect((await listArchive(realm, true)).deleted.some((entry) => entry.id === id)).toBe(false);
  });

  it("purge 仅允许已删除条目,且只清书架记录不删工作区文件", async () => {
    const { realm, read } = setup(BASE_FILES);
    await scanWorkspace(realm, 1000);
    const id = makeEntryId("novel", "仙剑");
    await expectHttpError(purgeEntry(realm, id), 409);
    await expectHttpError(purgeEntry(realm, "novel:不存在"), 404);
    await softDeleteEntry(realm, id, 1000);
    expect((await purgeEntry(realm, id)).id).toBe(id);
    expect((await loadShelf(realm)).entries.some((entry) => entry.id === id)).toBe(false);
    expect(read("正文/仙剑/第一章.md")).toBe("# 仙剑\n正文");
  });
});

describe("purge-expired 按 deleteAfter 清理", () => {
  it("只移除过期回收项,未到期与正常条目保留,文件不动", async () => {
    const now = 9_999_999_999_999;
    const { realm, read } = setup(BASE_FILES);
    await scanWorkspace(realm, 1000);
    const expiredId = makeEntryId("novel", "仙剑");
    const freshId = makeEntryId("novel", "凡人");
    await softDeleteEntry(realm, expiredId, now - 31 * DAY_MS);
    await softDeleteEntry(realm, freshId, now);
    const result = await purgeExpiredShelf(realm, now);
    expect(result).toEqual({ purged: [expiredId], count: 1 });
    const data = await loadShelf(realm);
    expect(data.entries.some((entry) => entry.id === expiredId)).toBe(false);
    expect(data.entries.some((entry) => entry.id === freshId)).toBe(true);
    expect(data.entries.some((entry) => entry.id === makeEntryId("drama", "短剧A"))).toBe(true);
    expect(read("正文/仙剑/第一章.md")).toBe("# 仙剑\n正文");
  });

  it("无过期项时不重写书架,空书架直接返回零", async () => {
    const { realm } = setup(BASE_FILES);
    await scanWorkspace(realm, 1000);
    expect(await purgeExpiredShelf(realm, 2000)).toEqual({ purged: [], count: 0 });
    const empty = setup();
    expect(await purgeExpiredShelf(empty.realm, 2000)).toEqual({ purged: [], count: 0 });
  });
});

describe("损坏 shelf.json 降级为空并允许重建", () => {
  it("坏 JSON / 非对象 / entries 非数组一律视为空书架", () => {
    expect(parseShelf(undefined)).toEqual({ entries: [] });
    expect(parseShelf("")).toEqual({ entries: [] });
    expect(parseShelf("{broken")).toEqual({ entries: [] });
    expect(parseShelf("[]")).toEqual({ entries: [] });
    expect(parseShelf('{"entries":"nope"}')).toEqual({ entries: [] });
    expect(parseShelf('{"entries":[{"id":"","name":"x","kind":"novel","path":"p","updatedAt":1}]}')).toEqual({ entries: [] });
    const ok = parseShelf('{"entries":[{"id":"novel:a","name":"a","kind":"novel","path":"正文/a","title":"","updatedAt":7}]}');
    expect(ok.entries).toHaveLength(1);
    expect(ok.entries[0]).toMatchObject({ id: "novel:a", title: "a", updatedAt: 7 });
  });

  it("损坏后 list 为空,scan 覆盖重建", async () => {
    const store = setup(BASE_FILES);
    store.seed(".oh-story/shelf.json", "{broken", "corrupt");
    expect(await loadShelf(store.realm)).toEqual({ entries: [] });
    expect(await listShelf(store.realm)).toEqual([]);
    const summary = await scanWorkspace(store.realm, 1000);
    expect(summary.added).toBe(5);
    expect((await listShelf(store.realm)).map((entry) => entry.id).sort()).toEqual([
      "drama:短剧A",
      "game:roguelike",
      "novel:仙剑",
      "novel:凡人",
      "video:recap1",
    ]);
    expect(store.read(".oh-story/shelf.json")).toContain("novel:仙剑");
  });
});

describe("纯函数:合并/分区/过期判定", () => {
  function entry(overrides: Partial<ShelfEntry> & { readonly id: string }): ShelfEntry {
    return {
      name: overrides.id,
      kind: "novel",
      path: `正文/${overrides.id}`,
      title: overrides.id,
      updatedAt: 1,
      ...overrides,
    };
  }

  it("makeEntryId 稳定且区分 kind", () => {
    expect(makeEntryId("novel", "仙剑")).toBe("novel:仙剑");
    expect(makeEntryId("game", "仙剑")).not.toBe(makeEntryId("novel", "仙剑"));
  });

  it("mergeScanEntries 保留磁盘已消失作品,不静默丢弃", () => {
    const previous = [entry({ id: "novel:旧作" })];
    const discovered: DiscoveredWork[] = [{ kind: "novel", name: "新作", path: "正文/新作" }];
    const merged = mergeScanEntries(previous, discovered, 9);
    expect(merged.added).toBe(1);
    expect(merged.updated).toBe(0);
    expect(merged.entries.some((item) => item.id === "novel:旧作")).toBe(true);
    expect(merged.entries.some((item) => item.id === "novel:新作")).toBe(true);
  });

  it("isRecycleExpired 缺字段不断言过期,边界时刻算过期", () => {
    expect(isRecycleExpired(entry({ id: "a" }), 100)).toBe(false);
    expect(isRecycleExpired(entry({ id: "a", deletedAt: 50 }), 100)).toBe(false);
    expect(isRecycleExpired(entry({ id: "a", deletedAt: 50, deleteAfter: 100 }), 100)).toBe(true);
    expect(isRecycleExpired(entry({ id: "a", deletedAt: 50, deleteAfter: 101 }), 100)).toBe(false);
  });

  it("purgeExpiredEntries 与三分区(default/archive/recycle)一致", () => {
    const entries = [
      entry({ id: "a" }),
      entry({ id: "b", archivedAt: 10 }),
      entry({ id: "c", deletedAt: 10, deleteAfter: 20 }),
      entry({ id: "d", deletedAt: 10, deleteAfter: 9_999 }),
    ];
    expect(defaultShelf(entries).map((item) => item.id)).toEqual(["a"]);
    expect(archivedShelf(entries).map((item) => item.id)).toEqual(["b"]);
    expect(recycleBin(entries).map((item) => item.id)).toEqual(["c", "d"]);
    const purged = purgeExpiredEntries(entries, 30);
    expect(purged.purged.map((item) => item.id)).toEqual(["c"]);
    expect(purged.kept.map((item) => item.id)).toEqual(["a", "b", "d"]);
  });
});
