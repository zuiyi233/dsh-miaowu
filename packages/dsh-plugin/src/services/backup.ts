import { createHash } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type { FsTarget } from "@deepseek-ai/dsh-fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  jsonBody,
  mapFsError,
  readVersionedFile,
  send,
  workspaceRealm,
  WorkspaceHttpError,
  type WorkspaceRealm,
  type WorkspaceRouteOptions,
} from "../workspace-route.js";
import { registerWorkspaceExtension } from "./registry.js";

/**
 * 功能 B4:备份三件套(bundle/snapshot/full)+恢复为新项目.
 * 做法参考 NarraLume 域 10:单作品 JSON bundle(bundleHash+sizeBytes+counts,
 * 不含密钥)+restore 恢复为新项目(恢复前校验 hash、写后校验 counts)+
 * "备份不等于可恢复,必须演练恢复到新目录". 禁止 SQLite 与 zip 依赖,
 * 备份产物是 JSON 文件,落在 `.oh-story/backup/`(git 已忽略隐藏目录).
 * 媒体文件只跳过不存字节;full 备份含 `.oh-story/` 状态但不含 DSH 会话/凭据.
 */

export type BackupKind = "bundle" | "snapshot" | "full";

export interface BackupFileEntry {
  readonly path: string;
  readonly content: string;
  readonly version?: string | undefined;
}

export interface BackupCounts {
  readonly files: number;
  readonly bytes: number;
}

export interface BackupBundle {
  readonly kind: BackupKind;
  readonly createdAt: number;
  readonly root?: string;
  readonly files: readonly BackupFileEntry[];
  readonly hash: string;
  readonly sizeBytes: number;
  readonly counts: BackupCounts;
}

export interface BackupSummary {
  readonly path: string;
  readonly kind: BackupKind;
  readonly createdAt: number;
  readonly counts: BackupCounts;
  readonly hashShort: string;
}

export interface RestoreOutcome {
  readonly restoredRoot: string;
  readonly source?: string | undefined;
  readonly counts: BackupCounts;
}

export interface RestorePlan {
  readonly restoredRoot: string;
  readonly entries: ReadonlyArray<{ readonly from: string; readonly to: string }>;
}

type BackupRealm = Pick<WorkspaceRealm, "fs" | "cwd" | "root">;

const BACKUP_DIR = ".oh-story/backup";
const BACKUP_TEXT_EXTENSIONS = new Set([".md", ".txt", ".json", ".jsonl"]);
// 创作树根(含短剧/游戏/视频目录;游戏构建产物与视频派生大目录靠扩展名自然过滤).
const BACKUP_CREATIVE_ROOTS = [
  "正文",
  "大纲",
  "设定",
  "追踪",
  "对标",
  "参考资料",
  "输入",
  "项目开发",
  "设定集",
  "剧集",
  "交付",
  "创作者决策",
  "审查",
  "game-adaptations",
  "video-recaps",
] as const;
const BACKUP_ROOT_FILE = "short-drama.json";
const MAX_BACKUP_FILES = 2000;
const MAX_RESTORE_ATTEMPTS = 100;
const BACKUP_READ_MAX_BYTES = 32 * 1024 * 1024;

/** 备份内路径安全校验:相对路径,无空段/./..、无绝对路径与反斜杠. */
export function safeBundlePath(path: string): boolean {
  if (path === "" || path.startsWith("/") || path.includes("\\")) return false;
  return !path.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

function textExtension(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot >= 0 && BACKUP_TEXT_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

/** hash = files 按 path 排序后 `path\0content` 行拼接的 sha256. */
export function computeBundleHash(files: readonly BackupFileEntry[]): string {
  const ordered = [...files].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return createHash("sha256").update(ordered.map((file) => `${file.path}\0${file.content}`).join("\n"), "utf8").digest("hex");
}

export function countsOf(files: readonly BackupFileEntry[]): BackupCounts {
  return {
    files: files.length,
    bytes: files.reduce((total, file) => total + Buffer.byteLength(file.content, "utf8"), 0),
  };
}

/** 三类备份共享的唯一构建函数:排序收录 + hash + counts + 自洽 sizeBytes. */
export function buildBackup(
  kind: BackupKind,
  files: readonly BackupFileEntry[],
  createdAt: number,
  root?: string
): BackupBundle {
  const ordered = [...files].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const base = {
    kind,
    createdAt,
    ...(root === undefined ? {} : { root }),
    files: ordered,
    hash: computeBundleHash(ordered),
    counts: countsOf(ordered),
  };
  // sizeBytes 指最终 JSON 的序列化字节数:定点迭代收敛(数字位数稳定即自洽).
  let sizeBytes = 0;
  for (let round = 0; round < 4; round += 1) {
    const serialized = JSON.stringify({ ...base, sizeBytes });
    const measured = Buffer.byteLength(serialized, "utf8");
    if (measured === sizeBytes) break;
    sizeBytes = measured;
  }
  return { ...base, sizeBytes };
}

/** 恢复前校验:hash 必须与内容重算一致. */
export function verifyBundleHash(bundle: BackupBundle): boolean {
  return bundle.hash === computeBundleHash(bundle.files);
}

function asBackupKind(value: unknown): BackupKind | undefined {
  return value === "bundle" || value === "snapshot" || value === "full" ? value : undefined;
}

/** 宽松解析:坏结构返回 undefined(列表场景降级跳过,不崩). */
export function asBackupBundle(value: unknown): BackupBundle | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const kind = asBackupKind(record.kind);
  if (kind === undefined || typeof record.createdAt !== "number" || !Array.isArray(record.files)) return undefined;
  const files: BackupFileEntry[] = [];
  for (const item of record.files) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return undefined;
    const entry = item as Record<string, unknown>;
    if (typeof entry.path !== "string" || typeof entry.content !== "string") return undefined;
    files.push({
      path: entry.path,
      content: entry.content,
      ...(typeof entry.version === "string" ? { version: entry.version } : {}),
    });
  }
  if (typeof record.hash !== "string" || typeof record.sizeBytes !== "number") return undefined;
  const counts = record.counts as Record<string, unknown> | undefined;
  const root = record.root;
  return {
    kind,
    createdAt: record.createdAt,
    ...(root === undefined ? {} : typeof root === "string" ? { root } : undefined),
    files,
    hash: record.hash,
    sizeBytes: record.sizeBytes,
    counts: {
      files: typeof counts?.files === "number" ? counts.files : files.length,
      bytes: typeof counts?.bytes === "number" ? counts.bytes : 0,
    },
  };
}

/** 恢复入口强校验:结构/hash/越界路径任一失败即拒绝. */
export function assertRestorableBundle(value: unknown): BackupBundle {
  const bundle = asBackupBundle(value);
  if (bundle === undefined || !verifyBundleHash(bundle)) {
    throw new WorkspaceHttpError(400, "备份已损坏。");
  }
  if (!bundle.files.every((file) => safeBundlePath(file.path))) {
    throw new WorkspaceHttpError(400, "备份包含非法路径，已拒绝恢复。");
  }
  return bundle;
}

/** 本地时间戳 YYYYMMDD-HHmmss,用于备份文件名与恢复目录名. */
export function formatBackupTimestamp(date: Date = new Date()): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  return `${String(date.getFullYear())}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** 文件名 slug:root 的 `/` 转 `-`,去不安全字符,截断;省略 root 时回退. */
export function slugifyBackupRoot(root: string | undefined, kind: BackupKind): string {
  if (root === undefined || root === "") return kind === "full" ? "full" : "workspace";
  const slug = root.replaceAll("/", "-").replaceAll(/[^a-zA-Z0-9\u4e00-\u9fff_-]/gu, "").slice(0, 24);
  return slug === "" ? "workspace" : slug;
}

/**
 * 恢复计划(纯函数):一律恢复为新目录,不覆盖原数据.
 * bundle/snapshot 有 root → `{root}-恢复-{ts}`(去 root 前缀);
 * 无 root → `恢复导入-{ts}/` 保留原路径;full → `恢复备份-{ts}/` 保留原路径.
 */
export function restorePlan(bundle: BackupBundle, timestamp: string): RestorePlan {
  if (bundle.kind === "full") {
    const restoredRoot = `恢复备份-${timestamp}`;
    return {
      restoredRoot,
      entries: bundle.files.map((file) => ({ from: file.path, to: `${restoredRoot}/${file.path}` })),
    };
  }
  if (bundle.root !== undefined && bundle.root !== "") {
    const root = bundle.root;
    const restoredRoot = `${root}-恢复-${timestamp}`;
    return {
      restoredRoot,
      entries: bundle.files.map((file) => {
        const suffix = file.path === root
          ? (file.path.split("/").at(-1) ?? file.path)
          : file.path.startsWith(`${root}/`)
            ? file.path.slice(root.length + 1)
            : file.path;
        return { from: file.path, to: `${restoredRoot}/${suffix}` };
      }),
    };
  }
  const restoredRoot = `恢复导入-${timestamp}`;
  return {
    restoredRoot,
    entries: bundle.files.map((file) => ({ from: file.path, to: `${restoredRoot}/${file.path}` })),
  };
}

async function readTextEntry(
  realm: BackupRealm,
  path: string,
  target: FsTarget,
  maxBytes: number,
  out: BackupFileEntry[]
): Promise<void> {
  try {
    const file = await readVersionedFile(realm.fs, target, maxBytes);
    out.push({ path, content: file.content, version: String(file.version) });
  } catch (error) {
    // 超限(413)/非文本(415)跳过该文件;其它错误向上传播,不静默吞错.
    if (error instanceof WorkspaceHttpError && (error.status === 413 || error.status === 415)) return;
    throw error;
  }
}

async function walkTextFiles(
  realm: BackupRealm,
  dir: FsTarget,
  prefix: string,
  maxBytes: number,
  out: BackupFileEntry[],
  skipDir: (path: string) => boolean
): Promise<void> {
  if (out.length >= MAX_BACKUP_FILES) return;
  const entries = await realm.fs.listDir(dir);
  for (const entry of entries) {
    if (entry.name.startsWith(".") || !realm.fs.contains(realm.root, entry.target)) continue;
    const childPath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.type === "directory") {
      if (!skipDir(childPath)) await walkTextFiles(realm, entry.target, childPath, maxBytes, out, skipDir);
    } else if (entry.type === "file" && textExtension(childPath)) {
      await readTextEntry(realm, childPath, entry.target, maxBytes, out);
    }
    if (out.length >= MAX_BACKUP_FILES) return;
  }
}

async function collectUnder(
  realm: BackupRealm,
  root: string,
  maxBytes: number,
  skipDir: (path: string) => boolean
): Promise<BackupFileEntry[]> {
  const target = await realm.fs.resolve(root, { cwd: realm.cwd });
  if (!realm.fs.contains(realm.root, target)) throw new WorkspaceHttpError(403, "备份范围离开了 DSH 工作目录。");
  const info = await realm.fs.stat(target);
  if (info?.type === "file") {
    const out: BackupFileEntry[] = [];
    if (textExtension(root)) await readTextEntry(realm, root, target, maxBytes, out);
    return out;
  }
  if (info?.type !== "directory") throw new WorkspaceHttpError(404, "备份范围不存在。");
  const out: BackupFileEntry[] = [];
  await walkTextFiles(realm, target, root, maxBytes, out, skipDir);
  return out.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

/** bundle/snapshot 收录:root 省略即整个创作树. */
export async function collectScopeFiles(
  realm: BackupRealm,
  root: string | undefined,
  maxBytes: number
): Promise<BackupFileEntry[]> {
  const skipNothing = (): boolean => false;
  if (root !== undefined && root !== "") {
    if (!safeBundlePath(root)) throw new WorkspaceHttpError(400, "备份范围路径不合法。");
    return collectUnder(realm, root, maxBytes, skipNothing);
  }
  const out: BackupFileEntry[] = [];
  for (const dir of BACKUP_CREATIVE_ROOTS) {
    const target = await realm.fs.resolve(dir, { cwd: realm.cwd });
    if (!realm.fs.contains(realm.root, target)) continue;
    if ((await realm.fs.stat(target))?.type !== "directory") continue;
    await walkTextFiles(realm, target, dir, maxBytes, out, skipNothing);
    if (out.length >= MAX_BACKUP_FILES) break;
  }
  const rootFile = await realm.fs.resolve(BACKUP_ROOT_FILE, { cwd: realm.cwd });
  if (realm.fs.contains(realm.root, rootFile) && (await realm.fs.stat(rootFile))?.type === "file") {
    await readTextEntry(realm, BACKUP_ROOT_FILE, rootFile, maxBytes, out);
  }
  return out.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

/** full 收录:创作树全部文本 + `.oh-story/` 服务状态(排除备份目录自身,防递归). */
export async function collectFullFiles(realm: BackupRealm, maxBytes: number): Promise<BackupFileEntry[]> {
  const out = await collectScopeFiles(realm, undefined, maxBytes);
  const skipBackup = (path: string): boolean => path === BACKUP_DIR || path.startsWith(`${BACKUP_DIR}/`);
  const store = await realm.fs.resolve(".oh-story", { cwd: realm.cwd });
  if (realm.fs.contains(realm.root, store) && (await realm.fs.stat(store))?.type === "directory") {
    await walkTextFiles(realm, store, ".oh-story", maxBytes, out, skipBackup);
  }
  return out.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

async function resolveBackupTarget(realm: BackupRealm, relPath: string): Promise<FsTarget> {
  const dir = await realm.fs.resolve(BACKUP_DIR, { cwd: realm.cwd });
  const target = await realm.fs.resolve(relPath, { cwd: realm.cwd });
  if (!realm.fs.contains(realm.root, target) || !realm.fs.contains(dir, target)) {
    throw new WorkspaceHttpError(403, "备份路径离开了备份目录。");
  }
  return target;
}

async function uniqueBackupTarget(realm: BackupRealm, fileName: string): Promise<{ readonly target: FsTarget; readonly relPath: string }> {
  const stem = fileName.replace(/\.json$/u, "");
  for (let attempt = 0; attempt < MAX_RESTORE_ATTEMPTS; attempt += 1) {
    const name = attempt === 0 ? `${stem}.json` : `${stem}-${String(attempt)}.json`;
    const relPath = `${BACKUP_DIR}/${name}`;
    const target = await resolveBackupTarget(realm, relPath);
    if ((await realm.fs.stat(target))?.type !== "file") return { target, relPath };
  }
  throw new WorkspaceHttpError(409, "备份文件名冲突，请稍后重试。");
}

/** 创建备份并落盘,返回产物路径与 counts. */
export async function createBackup(
  realm: BackupRealm,
  kind: BackupKind,
  root: string | undefined,
  maxBytes: number,
  now: number = Date.now()
): Promise<{ readonly path: string; readonly counts: BackupCounts }> {
  const files = kind === "full" ? await collectFullFiles(realm, maxBytes) : await collectScopeFiles(realm, root, maxBytes);
  const bundle = buildBackup(kind, files, now, kind === "full" ? undefined : root === "" ? undefined : root);
  const stamp = formatBackupTimestamp(new Date(now));
  const { target, relPath } = await uniqueBackupTarget(realm, `${kind}-${stamp}-${slugifyBackupRoot(root, kind)}.json`);
  await realm.fs.writeText(target, JSON.stringify(bundle), undefined, undefined, undefined);
  return { path: relPath, counts: bundle.counts };
}

/** 列出备份摘要:损坏文件逐个降级跳过,不崩. */
export async function listBackups(realm: BackupRealm): Promise<BackupSummary[]> {
  const dir = await realm.fs.resolve(BACKUP_DIR, { cwd: realm.cwd });
  if (!realm.fs.contains(realm.root, dir)) return [];
  let entries: Awaited<ReturnType<BackupRealm["fs"]["listDir"]>>;
  try {
    entries = await realm.fs.listDir(dir);
  } catch {
    return [];
  }
  const summaries: BackupSummary[] = [];
  for (const entry of entries) {
    if (entry.type !== "file" || !entry.name.endsWith(".json")) continue;
    if (!realm.fs.contains(realm.root, entry.target) || !realm.fs.contains(dir, entry.target)) continue;
    try {
      const file = await readVersionedFile(realm.fs, entry.target, BACKUP_READ_MAX_BYTES);
      const bundle = asBackupBundle(JSON.parse(file.content) as unknown);
      if (bundle === undefined) continue;
      summaries.push({
        path: `${BACKUP_DIR}/${entry.name}`,
        kind: bundle.kind,
        createdAt: bundle.createdAt,
        counts: bundle.counts,
        hashShort: bundle.hash.slice(0, 8),
      });
    } catch {
      continue;
    }
  }
  return summaries.sort((left, right) => right.createdAt - left.createdAt);
}

/** 按相对路径读取一份备份:非法路径 403,坏 JSON/坏结构 400. */
export async function loadBackupFile(realm: BackupRealm, relPath: string): Promise<BackupBundle> {
  if (!safeBundlePath(relPath)) throw new WorkspaceHttpError(403, "备份路径不合法。");
  const target = await resolveBackupTarget(realm, relPath);
  let text: string;
  try {
    text = (await readVersionedFile(realm.fs, target, BACKUP_READ_MAX_BYTES)).content;
  } catch (error) {
    if (error instanceof WorkspaceHttpError) throw error;
    throw new WorkspaceHttpError(404, "备份文件不存在。");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new WorkspaceHttpError(400, "备份文件已损坏。");
  }
  const bundle = asBackupBundle(parsed);
  if (bundle === undefined) throw new WorkspaceHttpError(400, "备份文件已损坏。");
  return bundle;
}

async function freshRestoreRoot(realm: BackupRealm, base: string): Promise<string> {
  for (let attempt = 0; attempt < MAX_RESTORE_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${String(attempt)}`;
    const target = await realm.fs.resolve(candidate, { cwd: realm.cwd });
    if (!realm.fs.contains(realm.root, target)) throw new WorkspaceHttpError(403, "恢复目标离开了 DSH 工作目录。");
    if ((await realm.fs.stat(target)) === undefined) return candidate;
  }
  throw new WorkspaceHttpError(409, "恢复目录名冲突，请稍后重试。");
}

/**
 * 恢复为新项目:校验 hash → 以时间戳目录为目标无条件写入 →
 * 写后校验 counts. 绝不覆盖已有文件(目录名时间戳 + 已存在文件拒绝).
 */
export async function restoreBackup(
  realm: BackupRealm,
  input: { readonly bundlePath?: string | undefined; readonly bundle?: unknown }
): Promise<RestoreOutcome> {
  let bundle: BackupBundle;
  let source: string | undefined;
  if (input.bundle !== undefined) {
    bundle = assertRestorableBundle(input.bundle);
  } else if (typeof input.bundlePath === "string" && input.bundlePath !== "") {
    bundle = assertRestorableBundle(await loadBackupFile(realm, input.bundlePath));
    source = input.bundlePath;
  } else {
    throw new WorkspaceHttpError(400, "缺少 bundlePath 或 bundle。");
  }
  const plan = restorePlan(bundle, formatBackupTimestamp());
  const restoredRoot = await freshRestoreRoot(realm, plan.restoredRoot);
  const suffixOf = (to: string): string => to.slice(plan.restoredRoot.length + 1);
  let written = 0;
  for (const entry of plan.entries) {
    const content = bundle.files.find((file) => file.path === entry.from)?.content;
    if (content === undefined) throw new WorkspaceHttpError(500, "恢复计划与备份内容不一致。");
    const to = entry.to === plan.restoredRoot
      ? plan.restoredRoot
      : `${restoredRoot}/${suffixOf(entry.to)}`;
    const target = await realm.fs.resolve(to, { cwd: realm.cwd });
    if (!realm.fs.contains(realm.root, target)) throw new WorkspaceHttpError(403, "恢复目标离开了 DSH 工作目录。");
    if ((await realm.fs.stat(target))?.type === "file") {
      throw new WorkspaceHttpError(409, "恢复目标已存在，拒绝覆盖。");
    }
    await realm.fs.writeText(target, content, undefined, undefined, undefined);
    written += 1;
  }
  if (written !== bundle.files.length) throw new WorkspaceHttpError(500, "恢复写入数量与备份不一致。");
  return {
    restoredRoot,
    ...(source === undefined ? {} : { source }),
    counts: countsOf(bundle.files),
  };
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
  send(response, 500, { error: "备份操作失败。" });
}

function queryRoot(url: URL): string | undefined {
  const root = url.searchParams.get("root");
  return root === null || root === "" ? undefined : root;
}

async function handleCreate(
  realm: BackupRealm,
  kind: BackupKind,
  url: URL,
  response: ServerResponse,
  options: WorkspaceRouteOptions
): Promise<void> {
  const root = kind === "full" ? undefined : queryRoot(url);
  const outcome = await createBackup(realm, kind, root, options.maxBytes);
  send(response, 200, { kind, path: outcome.path, counts: outcome.counts });
}

async function handleList(realm: BackupRealm, response: ServerResponse): Promise<void> {
  send(response, 200, { backups: await listBackups(realm) });
}

async function handleDownload(realm: BackupRealm, url: URL, response: ServerResponse): Promise<void> {
  const path = url.searchParams.get("path");
  if (path === null || path === "") throw new WorkspaceHttpError(400, "缺少备份路径。");
  send(response, 200, await loadBackupFile(realm, path));
}

async function handleRestore(
  realm: BackupRealm,
  request: IncomingMessage,
  response: ServerResponse,
  options: WorkspaceRouteOptions
): Promise<void> {
  const body = await jsonBody(request, Math.max(options.maxBytes, BACKUP_READ_MAX_BYTES));
  const outcome = await restoreBackup(realm, { bundlePath: body.bundlePath as string | undefined, bundle: body.bundle });
  send(response, 200, outcome);
}

registerWorkspaceExtension({
  name: "backup",
  handle: async (
    context: Context,
    request: IncomingMessage,
    response: ServerResponse,
    options: WorkspaceRouteOptions
  ): Promise<boolean> => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const method = request.method ?? "GET";
    try {
      if (url.pathname === "/oh-story/backup/bundle" && method === "POST") {
        await handleCreate(await workspaceRealm(context, url), "bundle", url, response, options);
        return true;
      }
      if (url.pathname === "/oh-story/backup/snapshot" && method === "POST") {
        await handleCreate(await workspaceRealm(context, url), "snapshot", url, response, options);
        return true;
      }
      if (url.pathname === "/oh-story/backup/full" && method === "POST") {
        await handleCreate(await workspaceRealm(context, url), "full", url, response, options);
        return true;
      }
      if (url.pathname === "/oh-story/backup/list" && method === "GET") {
        await handleList(await workspaceRealm(context, url), response);
        return true;
      }
      if (url.pathname === "/oh-story/backup/download" && method === "GET") {
        await handleDownload(await workspaceRealm(context, url), url, response);
        return true;
      }
      if (url.pathname === "/oh-story/backup/restore" && method === "POST") {
        await handleRestore(await workspaceRealm(context, url), request, response, options);
        return true;
      }
    } catch (error) {
      fail(response, error);
      return true;
    }
    return false;
  },
});
