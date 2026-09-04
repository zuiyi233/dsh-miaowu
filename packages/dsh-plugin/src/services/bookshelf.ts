import type { Context } from "@deepseek-ai/cordis";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { FsTarget } from "@deepseek-ai/dsh-fs";
import {
  mapFsError,
  send,
  workspaceRealm,
  WorkspaceHttpError,
  type WorkspaceRealm,
  type WorkspaceRouteOptions,
} from "../workspace-route.js";
import { registerWorkspaceExtension } from "./registry.js";

/**
 * 功能 D2:书架多作品管理.
 * 借鉴 NarraLume Bookshelf(archivedAt 仅从默认书架隐藏不删内容、30 天回收站
 * deleted_at + delete_after)与 Scriverse 作品书架(works 软删除 + 三级回收 +
 * purgeExpiredRecycleBin + restore/permanent-delete).
 * 无本地数据库:书架索引只落 `.oh-story/shelf.json`.
 * 内容不删除边界:书架所有操作只读写 shelf.json 记录,从不删除工作区内容文件;
 * purge / 永久移除也仅清理书架记录,工作区文件原样保留.
 */

export type WorkKind = "novel" | "drama" | "game" | "video";

export interface ShelfEntry {
  readonly id: string;
  readonly name: string;
  readonly kind: WorkKind;
  readonly path: string;
  readonly title: string;
  readonly updatedAt: number;
  readonly archivedAt?: number | undefined;
  readonly deletedAt?: number | undefined;
  readonly deleteAfter?: number | undefined;
}

export interface ShelfData {
  readonly entries: ShelfEntry[];
}

export interface DiscoveredWork {
  readonly kind: WorkKind;
  readonly name: string;
  readonly path: string;
}

/** 回收站保留天数:对齐 NarraLume 30 天回收站约定. */
export const RETENTION_DAYS = 30;
const MS_PER_DAY = 86_400_000;
const STORE_MAX_BYTES = 4 * 1024 * 1024;
const SHELF_PATH = ".oh-story/shelf.json";
const NOVEL_BASE = "正文";
const DRAMA_BASE = "剧集";
const GAME_BASE = "game-adaptations";
const VIDEO_BASE = "video-recaps";
/** 短剧作品标记:剧集/{作品名}/分镜.md 所在目录即一座短剧作品. */
const DRAMA_MARKER = "分镜.md";
const ROUTE_PREFIX = "/oh-story/bookshelf";

const WORK_KINDS: ReadonlySet<string> = new Set(["novel", "drama", "game", "video"]);

/** 书架条目 id:kind + name 组合,扫描幂等的稳定键. */
export function makeEntryId(kind: WorkKind, name: string): string {
  return `${kind}:${name}`;
}

/** 软删除到期时间:删除时刻 + 保留天数. */
export function retentionDeadline(from: number): number {
  return from + RETENTION_DAYS * MS_PER_DAY;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asOptionalTime(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asShelfEntry(value: unknown): ShelfEntry[] {
  const record = asRecord(value);
  if (record === undefined) return [];
  if (typeof record.id !== "string" || record.id === "") return [];
  if (typeof record.name !== "string" || record.name === "") return [];
  if (typeof record.path !== "string" || record.path === "") return [];
  if (typeof record.kind !== "string" || !WORK_KINDS.has(record.kind)) return [];
  if (typeof record.updatedAt !== "number" || !Number.isFinite(record.updatedAt)) return [];
  const base: ShelfEntry = {
    id: record.id,
    name: record.name,
    kind: record.kind as WorkKind,
    path: record.path,
    title: typeof record.title === "string" && record.title !== "" ? record.title : record.name,
    updatedAt: record.updatedAt,
  };
  const archivedAt = asOptionalTime(record.archivedAt);
  const deletedAt = asOptionalTime(record.deletedAt);
  const deleteAfter = asOptionalTime(record.deleteAfter);
  return [{
    ...base,
    ...(archivedAt === undefined ? {} : { archivedAt }),
    ...(deletedAt === undefined ? {} : { deletedAt }),
    ...(deleteAfter === undefined ? {} : { deleteAfter }),
  }];
}

/** shelf.json 解析:损坏/缺失/形状非法一律降级为空书架,等待 scan 重建. */
export function parseShelf(text: string | undefined): ShelfData {
  if (text === undefined || text.trim() === "") return { entries: [] };
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return { entries: [] };
  }
  const record = asRecord(value);
  if (record === undefined || !Array.isArray(record.entries)) return { entries: [] };
  return { entries: record.entries.flatMap(asShelfEntry) };
}

/**
 * 扫描结果合并:同 id 幂等更新(刷新 name/path/title/updatedAt,保留
 * archived/deleted 状态);磁盘上已消失的作品保留原记录,不静默丢弃.
 */
export function mergeScanEntries(
  previous: readonly ShelfEntry[],
  discovered: readonly DiscoveredWork[],
  now: number
): { readonly entries: ShelfEntry[]; readonly added: number; readonly updated: number } {
  const known = new Map(previous.map((entry) => [entry.id, entry]));
  let added = 0;
  let updated = 0;
  const entries = discovered.map((work) => {
    const id = makeEntryId(work.kind, work.name);
    const existing = known.get(id);
    if (existing === undefined) {
      added += 1;
      return { id, name: work.name, kind: work.kind, path: work.path, title: work.name, updatedAt: now };
    }
    updated += 1;
    return { ...existing, name: work.name, kind: work.kind, path: work.path, title: work.name, updatedAt: now };
  });
  for (const entry of previous) {
    if (!entries.some((item) => item.id === entry.id)) entries.push(entry);
  }
  return { entries, added, updated };
}

/** 回收项是否过期:仅 deleteAfter 已过才算过期,缺字段不断言过期. */
export function isRecycleExpired(entry: ShelfEntry, now: number = Date.now()): boolean {
  return entry.deletedAt !== undefined
    && entry.deleteAfter !== undefined
    && entry.deleteAfter <= now;
}

/** 过期回收分区:参考 Scriverse purgeExpiredRecycleBin. */
export function purgeExpiredEntries(
  entries: readonly ShelfEntry[],
  now: number = Date.now()
): { readonly kept: ShelfEntry[]; readonly purged: ShelfEntry[] } {
  const kept: ShelfEntry[] = [];
  const purged: ShelfEntry[] = [];
  for (const entry of entries) {
    if (isRecycleExpired(entry, now)) purged.push(entry);
    else kept.push(entry);
  }
  return { kept, purged };
}

/** 默认书架:未归档且未软删除. */
export function defaultShelf(entries: readonly ShelfEntry[]): ShelfEntry[] {
  return entries.filter((entry) => entry.archivedAt === undefined && entry.deletedAt === undefined);
}

/** 归档列表:已归档且不在回收站. */
export function archivedShelf(entries: readonly ShelfEntry[]): ShelfEntry[] {
  return entries.filter((entry) => entry.archivedAt !== undefined && entry.deletedAt === undefined);
}

/** 回收站列表:已软删除(归档态删除后会清 archivedAt,单态不变量). */
export function recycleBin(entries: readonly ShelfEntry[]): ShelfEntry[] {
  return entries.filter((entry) => entry.deletedAt !== undefined);
}

async function shelfTarget(realm: WorkspaceRealm): Promise<FsTarget | undefined> {
  const target = await realm.fs.resolve(SHELF_PATH, { cwd: realm.cwd });
  return realm.fs.contains(realm.root, target) ? target : undefined;
}

async function readShelfText(realm: WorkspaceRealm): Promise<string | undefined> {
  const target = await shelfTarget(realm);
  if (target === undefined) return undefined;
  if ((await realm.fs.stat(target))?.type !== "file") return undefined;
  try {
    const bytes = await realm.fs.readBytes(target, undefined, STORE_MAX_BYTES);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

export async function loadShelf(realm: WorkspaceRealm): Promise<ShelfData> {
  return parseShelf(await readShelfText(realm).catch(() => undefined));
}

export async function saveShelf(realm: WorkspaceRealm, data: ShelfData): Promise<void> {
  const target = await shelfTarget(realm);
  if (target === undefined) return;
  await realm.fs.writeText(target, JSON.stringify({ entries: data.entries }, null, 2), undefined, undefined, undefined);
}

async function childDirectories(
  realm: WorkspaceRealm,
  base: string
): Promise<Array<{ readonly name: string; readonly target: FsTarget }>> {
  const root = await realm.fs.resolve(base, { cwd: realm.cwd });
  if (!realm.fs.contains(realm.root, root)) return [];
  if ((await realm.fs.stat(root))?.type !== "directory") return [];
  const out: Array<{ readonly name: string; readonly target: FsTarget }> = [];
  for (const entry of await realm.fs.listDir(root)) {
    if (entry.name.startsWith(".") || entry.type !== "directory") continue;
    if (!realm.fs.contains(realm.root, entry.target)) continue;
    out.push({ name: entry.name, target: entry.target });
  }
  return out.sort((left, right) => left.name.localeCompare(right.name, "zh-Hans-CN"));
}

async function directoryHasFile(realm: WorkspaceRealm, directory: FsTarget, fileName: string): Promise<boolean> {
  for (const entry of await realm.fs.listDir(directory)) {
    if (entry.type === "file" && entry.name === fileName) return true;
  }
  return false;
}

async function discoverNovels(realm: WorkspaceRealm): Promise<DiscoveredWork[]> {
  const children = await childDirectories(realm, NOVEL_BASE);
  return children.map((child) => ({ kind: "novel" as const, name: child.name, path: `${NOVEL_BASE}/${child.name}` }));
}

async function discoverDramas(realm: WorkspaceRealm): Promise<DiscoveredWork[]> {
  const root = await realm.fs.resolve(DRAMA_BASE, { cwd: realm.cwd });
  if (!realm.fs.contains(realm.root, root)) return [];
  if ((await realm.fs.stat(root))?.type !== "directory") return [];
  const works: DiscoveredWork[] = [];
  for (const child of await childDirectories(realm, DRAMA_BASE)) {
    const hasMarker = await directoryHasFile(realm, child.target, DRAMA_MARKER).catch(() => false);
    if (hasMarker) works.push({ kind: "drama", name: child.name, path: `${DRAMA_BASE}/${child.name}` });
  }
  // 约定:剧集/ 下无子目录的单剧集(分镜.md 直接落在剧集/ 根),记为名为"剧集"的作品.
  const rootMarker = await directoryHasFile(realm, root, DRAMA_MARKER).catch(() => false);
  if (rootMarker) works.push({ kind: "drama", name: DRAMA_BASE, path: DRAMA_BASE });
  return works;
}

async function discoverAdaptations(
  realm: WorkspaceRealm,
  base: string,
  kind: WorkKind
): Promise<DiscoveredWork[]> {
  const children = await childDirectories(realm, base);
  return children.map((child) => ({ kind, name: child.name, path: `${base}/${child.name}` }));
}

/** 作品发现:遍历创作目录识别作品根,单目录失败只降级该类,不中断整轮扫描. */
export async function discoverWorks(realm: WorkspaceRealm): Promise<DiscoveredWork[]> {
  const [novels, dramas, games, videos] = await Promise.all([
    discoverNovels(realm).catch(() => []),
    discoverDramas(realm).catch(() => []),
    discoverAdaptations(realm, GAME_BASE, "game").catch(() => []),
    discoverAdaptations(realm, VIDEO_BASE, "video").catch(() => []),
  ]);
  return [...novels, ...dramas, ...games, ...videos];
}

export async function scanWorkspace(
  realm: WorkspaceRealm,
  now: number = Date.now()
): Promise<{ readonly entries: ShelfEntry[]; readonly added: number; readonly updated: number; readonly total: number }> {
  const discovered = await discoverWorks(realm);
  const previous = await loadShelf(realm);
  const merged = mergeScanEntries(previous.entries, discovered, now);
  await saveShelf(realm, { entries: merged.entries });
  return { entries: merged.entries, added: merged.added, updated: merged.updated, total: merged.entries.length };
}

export async function listShelf(realm: WorkspaceRealm): Promise<ShelfEntry[]> {
  return defaultShelf((await loadShelf(realm)).entries);
}

export async function listArchive(
  realm: WorkspaceRealm,
  includeDeleted: boolean
): Promise<{ readonly archived: ShelfEntry[]; readonly deleted: ShelfEntry[] }> {
  const entries = (await loadShelf(realm)).entries;
  return { archived: archivedShelf(entries), deleted: includeDeleted ? recycleBin(entries) : [] };
}

async function updateEntry(realm: WorkspaceRealm, id: string, mutate: (entry: ShelfEntry) => ShelfEntry): Promise<ShelfEntry> {
  const data = await loadShelf(realm);
  const current = data.entries.find((entry) => entry.id === id);
  if (current === undefined) throw new WorkspaceHttpError(404, "书架中没有该作品。");
  const next = mutate(current);
  await saveShelf(realm, { entries: data.entries.map((entry) => entry.id === id ? next : entry) });
  return next;
}

/** 归档:只写 archivedAt,不碰工作区内容文件. */
export async function archiveEntry(realm: WorkspaceRealm, id: string, now: number = Date.now()): Promise<ShelfEntry> {
  return updateEntry(realm, id, (entry) => {
    if (entry.deletedAt !== undefined) throw new WorkspaceHttpError(409, "回收站中的作品请先恢复,再归档。");
    if (entry.archivedAt !== undefined) return entry;
    return { ...entry, archivedAt: now };
  });
}

/** 恢复:归档与软删除共用同一恢复口,恢复后一律回默认书架. */
export async function restoreEntry(realm: WorkspaceRealm, id: string): Promise<ShelfEntry> {
  return updateEntry(realm, id, (entry) => {
    if (entry.archivedAt === undefined && entry.deletedAt === undefined) return entry;
    const { archivedAt: _archived, deletedAt: _deleted, deleteAfter: _after, ...rest } = entry;
    void _archived;
    void _deleted;
    void _after;
    return rest;
  });
}

/** 软删除:写 deletedAt + deleteAfter,不碰工作区内容文件;归档态一并清除(单态不变量). */
export async function softDeleteEntry(realm: WorkspaceRealm, id: string, now: number = Date.now()): Promise<ShelfEntry> {
  return updateEntry(realm, id, (entry) => {
    if (entry.deletedAt !== undefined) return entry;
    const { archivedAt: _archived, ...rest } = entry;
    void _archived;
    return { ...rest, deletedAt: now, deleteAfter: retentionDeadline(now) };
  });
}

/**
 * 永久移除:仅清理书架记录,工作区文件原样保留(与「不删除内容」一致:
 * 书架只是索引层)。仅已软删除条目可移除,否则 409。
 */
export async function purgeEntry(realm: WorkspaceRealm, id: string): Promise<ShelfEntry> {
  const data = await loadShelf(realm);
  const current = data.entries.find((entry) => entry.id === id);
  if (current === undefined) throw new WorkspaceHttpError(404, "书架中没有该作品。");
  if (current.deletedAt === undefined) throw new WorkspaceHttpError(409, "只有回收站中的作品才能永久移除记录。");
  await saveShelf(realm, { entries: data.entries.filter((entry) => entry.id !== id) });
  return current;
}

/** 清理过期回收项:deleteAfter 已过则从书架移除记录,文件不动. */
export async function purgeExpiredShelf(
  realm: WorkspaceRealm,
  now: number = Date.now()
): Promise<{ readonly purged: string[]; readonly count: number }> {
  const data = await loadShelf(realm);
  const result = purgeExpiredEntries(data.entries, now);
  if (result.purged.length > 0) await saveShelf(realm, { entries: result.kept });
  const purged = result.purged.map((entry) => entry.id);
  return { purged, count: purged.length };
}

function fail(response: ServerResponse, error: unknown): void {
  if (error instanceof WorkspaceHttpError) {
    send(response, error.status, { error: error.message });
    return;
  }
  const mapped = mapFsError(error);
  if (mapped !== undefined) {
    send(response, mapped.status, { error: mapped.message });
    return;
  }
  send(response, 500, { error: "书架操作失败。" });
}

function parseIncludeDeleted(url: URL): boolean {
  const raw = url.searchParams.get("includeDeleted");
  return raw === "1" || raw === "true" || raw === "yes";
}

function parseItemAction(rest: string): { readonly id: string; readonly verb: string } | undefined {
  if (!rest.startsWith("/")) return undefined;
  const parts = rest.slice(1).split("/");
  if (parts.length !== 2) return undefined;
  const [id, verb] = parts;
  if (id === undefined || id === "" || verb === undefined) return undefined;
  if (verb !== "archive" && verb !== "restore" && verb !== "delete" && verb !== "purge") return undefined;
  return { id, verb };
}

function decodeEntryId(raw: string): string {
  try {
    const id = decodeURIComponent(raw);
    if (id === "") throw new Error();
    return id;
  } catch {
    throw new WorkspaceHttpError(400, "作品标识无效。");
  }
}

registerWorkspaceExtension({
  name: "bookshelf",
  handle: async (
    context: Context,
    request: IncomingMessage,
    response: ServerResponse,
    options: WorkspaceRouteOptions
  ): Promise<boolean> => {
    void options;
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (!url.pathname.startsWith(ROUTE_PREFIX)) return false;
    const rest = url.pathname.slice(ROUTE_PREFIX.length);
    const method = request.method ?? "GET";
    try {
      if (rest === "/list") {
        if (method !== "GET") throw new WorkspaceHttpError(405, "书架列表仅支持 GET。");
        send(response, 200, { entries: await listShelf(await workspaceRealm(context, url)) });
        return true;
      }
      if (rest === "/archive") {
        if (method !== "GET") throw new WorkspaceHttpError(405, "归档列表仅支持 GET。");
        send(response, 200, await listArchive(await workspaceRealm(context, url), parseIncludeDeleted(url)));
        return true;
      }
      if (rest === "/scan") {
        if (method !== "POST") throw new WorkspaceHttpError(405, "重新扫描仅支持 POST。");
        send(response, 200, await scanWorkspace(await workspaceRealm(context, url)));
        return true;
      }
      if (rest === "/purge-expired") {
        if (method !== "POST") throw new WorkspaceHttpError(405, "清理过期回收项仅支持 POST。");
        send(response, 200, await purgeExpiredShelf(await workspaceRealm(context, url)));
        return true;
      }
      const action = parseItemAction(rest);
      if (action !== undefined) {
        if (method !== "POST") throw new WorkspaceHttpError(405, "书架条目操作仅支持 POST。");
        const realm = await workspaceRealm(context, url);
        const id = decodeEntryId(action.id);
        if (action.verb === "archive") send(response, 200, { entry: await archiveEntry(realm, id) });
        else if (action.verb === "restore") send(response, 200, { entry: await restoreEntry(realm, id) });
        else if (action.verb === "delete") send(response, 200, { entry: await softDeleteEntry(realm, id) });
        else send(response, 200, { purged: (await purgeEntry(realm, id)).id });
        return true;
      }
      throw new WorkspaceHttpError(404, "书架路由不存在。");
    } catch (error) {
      fail(response, error);
      return true;
    }
  },
});
