import { createHash, randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { FsTarget, FsVersion } from "@deepseek-ai/dsh-fs";
import {
  creativeTarget,
  jsonBody,
  mapFsError,
  readVersionedFile,
  send,
  workspaceRealm,
  WorkspaceHttpError,
  type WorkspaceRealm,
  type WorkspaceRouteOptions,
} from "../workspace-route.js";
import {
  onWorkspaceWrite,
  registerWorkspaceExtension,
  type WorkspaceWriteEvent,
} from "./registry.js";

/**
 * 功能 A1:版本化 + 审计 + 行级批注.
 * 做法参考 Scriverse chapter_versions(整文快照 + source + 恢复)与 audit_logs
 * (全量写操作留痕),以及 NarraLume document_versions(parentVersionId 链)与
 * document_comments(quote + 行区间 + 绑定版本). 禁止 SQLite,全部状态落在
 * workspace 隐藏目录 `.oh-story/` 下的 JSON/JSONL 文件.
 */

export type SnapshotSource = "save" | "rollback";
export type AuditAction = "save" | "rollback";
export type AuditSource = "editor" | "rollback";
export type AnnotationKind = "note" | "todo" | "review";

export interface HistorySnapshot {
  readonly version: string;
  readonly parentVersion?: string | undefined;
  readonly contentHash: string;
  readonly content: string;
  readonly bytes: number;
  readonly source: SnapshotSource;
  readonly timestamp: number;
}

export interface VersionSummary {
  readonly version: string;
  readonly bytes: number;
  readonly source: SnapshotSource;
  readonly timestamp: number;
}

export interface AuditEntry {
  readonly timestamp: number;
  readonly action: AuditAction;
  readonly path: string;
  readonly version: string;
  readonly source: AuditSource;
  readonly detail?: string | undefined;
}

export interface Annotation {
  readonly id: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly quote: string;
  readonly note: string;
  readonly kind: AnnotationKind;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly stale?: boolean | undefined;
  readonly moved?: boolean | undefined;
}

export const HISTORY_LIMIT = 50;
export const REANCHOR_WINDOW = 10;
export const AUDIT_DEFAULT_LIMIT = 200;
export const AUDIT_MAX_LIMIT = 1000;
export const NOTE_MAX_LENGTH = 2000;

const STORE_DIR = ".oh-story";
const HISTORY_DIR = ".oh-story/history";
const AUDIT_NAME = "audit.jsonl";
const ANNOTATIONS_NAME = "annotations.json";
const STORE_MAX_BYTES = 8 * 1024 * 1024;

/** 每文件快照文件名:路径 sha256 前 16 字符,避免目录穿越. */
export function historyFileName(path: string): string {
  return `${createHash("sha256").update(path, "utf8").digest("hex").slice(0, 16)}.jsonl`;
}

export function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** 超限裁剪:只保留最近 HISTORY_LIMIT 条(调用方传入旧→新顺序). */
export function trimSnapshots(snapshots: readonly HistorySnapshot[]): HistorySnapshot[] {
  return snapshots.length <= HISTORY_LIMIT ? [...snapshots] : snapshots.slice(snapshots.length - HISTORY_LIMIT);
}

/** 审计行解析:坏行跳过,绝不因单个坏行丢掉整份审计. */
export function parseAuditEntries(text: string): AuditEntry[] {
  const entries: AuditEntry[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const entry = asAuditEntry(parseJsonLine(line));
    if (entry !== undefined) entries.push(entry);
  }
  return entries;
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asSnapshot(value: unknown): HistorySnapshot | undefined {
  const record = asRecord(value);
  if (record === undefined || typeof record.version !== "string" || typeof record.content !== "string") return undefined;
  return {
    version: record.version,
    parentVersion: typeof record.parentVersion === "string" ? record.parentVersion : undefined,
    contentHash: typeof record.contentHash === "string" ? record.contentHash : contentHash(record.content),
    content: record.content,
    bytes: typeof record.bytes === "number" ? record.bytes : Buffer.byteLength(record.content),
    source: record.source === "rollback" ? "rollback" : "save",
    timestamp: typeof record.timestamp === "number" ? record.timestamp : 0,
  };
}

function asAuditEntry(value: unknown): AuditEntry | undefined {
  const record = asRecord(value);
  if (
    record === undefined
    || typeof record.timestamp !== "number"
    || typeof record.path !== "string"
    || typeof record.version !== "string"
  ) return undefined;
  return {
    timestamp: record.timestamp,
    action: record.action === "rollback" ? "rollback" : "save",
    path: record.path,
    version: record.version,
    source: record.source === "rollback" ? "rollback" : "editor",
    detail: typeof record.detail === "string" ? record.detail : undefined,
  };
}

function asAnnotation(value: unknown): Annotation | undefined {
  const record = asRecord(value);
  if (
    record === undefined
    || typeof record.id !== "string"
    || !Number.isSafeInteger(record.lineStart)
    || !Number.isSafeInteger(record.lineEnd)
    || typeof record.quote !== "string"
    || typeof record.note !== "string"
  ) return undefined;
  const lineStart = record.lineStart as number;
  const lineEnd = record.lineEnd as number;
  if (lineStart < 1 || lineEnd < lineStart) return undefined;
  const kind: AnnotationKind = record.kind === "todo" || record.kind === "review" ? record.kind : "note";
  const annotation: Annotation = {
    id: record.id,
    lineStart,
    lineEnd,
    quote: record.quote,
    note: record.note,
    kind,
    createdAt: typeof record.createdAt === "number" ? record.createdAt : 0,
    updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : 0,
  };
  if (record.stale === true) return { ...annotation, stale: true };
  if (record.moved === true) return { ...annotation, moved: true };
  return annotation;
}

function splitLines(content: string): string[] {
  return content.split(/\r?\n/u);
}

async function resolveStoreTarget(realm: WorkspaceRealm, name: string): Promise<FsTarget | undefined> {
  const target = await realm.fs.resolve(`${STORE_DIR}/${name}`, { cwd: realm.cwd });
  return realm.fs.contains(realm.root, target) ? target : undefined;
}

async function resolveHistoryTarget(realm: WorkspaceRealm, path: string): Promise<FsTarget | undefined> {
  const target = await realm.fs.resolve(`${HISTORY_DIR}/${historyFileName(path)}`, { cwd: realm.cwd });
  return realm.fs.contains(realm.root, target) ? target : undefined;
}

async function readTextFile(realm: WorkspaceRealm, target: FsTarget): Promise<string | undefined> {
  const info = await realm.fs.stat(target);
  if (info?.type !== "file") return undefined;
  try {
    const bytes = await realm.fs.readBytes(target, undefined, STORE_MAX_BYTES);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

async function readSnapshots(realm: WorkspaceRealm, path: string): Promise<HistorySnapshot[]> {
  const target = await resolveHistoryTarget(realm, path);
  if (target === undefined) return [];
  const text = await readTextFile(realm, target);
  if (text === undefined) return [];
  const snapshots: HistorySnapshot[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const snapshot = asSnapshot(parseJsonLine(line));
    if (snapshot !== undefined) snapshots.push(snapshot);
  }
  return snapshots;
}

async function writeSnapshots(realm: WorkspaceRealm, path: string, snapshots: readonly HistorySnapshot[]): Promise<void> {
  const target = await resolveHistoryTarget(realm, path);
  if (target === undefined) return;
  const text = snapshots.map((snapshot) => JSON.stringify(snapshot)).join("\n");
  await realm.fs.writeText(target, text === "" ? "" : `${text}\n`, undefined, undefined, undefined);
}

async function appendAudit(realm: WorkspaceRealm, entry: AuditEntry): Promise<void> {
  const target = await resolveStoreTarget(realm, AUDIT_NAME);
  if (target === undefined) return;
  const previous = (await readTextFile(realm, target)) ?? "";
  const line = JSON.stringify(entry);
  await realm.fs.writeText(target, `${previous}${line}\n`, undefined, undefined, undefined);
}

/** 核心 PUT 保存钩子:追加快照 + 审计. 同 version 重复触发直接跳过. */
export async function recordSave(event: WorkspaceWriteEvent): Promise<boolean> {
  const realm = event.realm;
  const snapshots = await readSnapshots(realm, event.path).catch(() => []);
  if (snapshots.some((snapshot) => snapshot.version === event.version)) return false;
  const timestamp = Date.now();
  const snapshot: HistorySnapshot = {
    version: event.version,
    parentVersion: snapshots.at(-1)?.version,
    contentHash: contentHash(event.content),
    content: event.content,
    bytes: event.bytes,
    source: "save",
    timestamp,
  };
  await writeSnapshots(realm, event.path, trimSnapshots([...snapshots, snapshot]));
  await appendAudit(realm, {
    timestamp,
    action: "save",
    path: event.path,
    version: event.version,
    source: "editor",
  }).catch(() => undefined);
  return true;
}

/** 版本列表,新→旧,不含正文. */
export async function listVersions(realm: WorkspaceRealm, path: string): Promise<VersionSummary[]> {
  const snapshots = await readSnapshots(realm, path);
  return snapshots
    .slice()
    .reverse()
    .map((snapshot) => ({
      version: snapshot.version,
      bytes: snapshot.bytes,
      source: snapshot.source,
      timestamp: snapshot.timestamp,
    }));
}

export async function getVersionSnapshot(
  realm: WorkspaceRealm,
  path: string,
  version: string
): Promise<HistorySnapshot | undefined> {
  const snapshots = await readSnapshots(realm, path);
  return snapshots.find((snapshot) => snapshot.version === version);
}

/**
 * 回滚:校验 baseVersion 与磁盘 CAS 版本一致,原子写回快照内容,
 * 再补记 rollback 快照 + 审计 + 批注重锚定(rollback 不走核心 PUT,钩子不会触发).
 */
export async function rollbackToVersion(
  realm: WorkspaceRealm,
  path: string,
  version: string,
  baseVersion: string
): Promise<{ readonly content: string; readonly version: string }> {
  if (version === "" || baseVersion === "") throw new WorkspaceHttpError(400, "缺少版本参数。");
  const snapshot = await getVersionSnapshot(realm, path, version);
  if (snapshot === undefined) throw new WorkspaceHttpError(404, "版本不存在。");
  const target = await creativeTarget(realm, path);
  const info = await realm.fs.stat(target);
  if (info?.type !== "file") throw new WorkspaceHttpError(404, "文件不存在。");
  if (String(info.version) !== baseVersion) {
    throw new WorkspaceHttpError(412, "文件已在磁盘上更新，请先刷新后重试。");
  }
  let outcome;
  try {
    outcome = await realm.fs.writeText(
      target,
      snapshot.content,
      { kind: "replaceIfVersion", version: baseVersion as FsVersion },
      undefined,
      undefined
    );
  } catch (error) {
    const mapped = mapFsError(error);
    throw mapped ?? new WorkspaceHttpError(500, "回滚写入失败。");
  }
  const timestamp = Date.now();
  const snapshots = await readSnapshots(realm, path).catch(() => []);
  await writeSnapshots(realm, path, trimSnapshots([
    ...snapshots.filter((item) => item.version !== String(outcome.version)),
    {
      version: String(outcome.version),
      parentVersion: snapshots.at(-1)?.version,
      contentHash: contentHash(outcome.after),
      content: outcome.after,
      bytes: Buffer.byteLength(outcome.after),
      source: "rollback" as const,
      timestamp,
    },
  ]));
  await appendAudit(realm, {
    timestamp,
    action: "rollback",
    path,
    version: String(outcome.version),
    source: "rollback",
    detail: `rollback to ${version}`,
  }).catch(() => undefined);
  await reanchorFileAnnotations(realm, path, outcome.after).catch(() => undefined);
  return { content: outcome.after, version: String(outcome.version) };
}

export async function queryAudit(
  realm: WorkspaceRealm,
  path: string | undefined,
  limit: number
): Promise<AuditEntry[]> {
  const target = await resolveStoreTarget(realm, AUDIT_NAME);
  if (target === undefined) return [];
  const text = await readTextFile(realm, target);
  if (text === undefined) return [];
  const capped = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, AUDIT_MAX_LIMIT) : AUDIT_DEFAULT_LIMIT;
  return parseAuditEntries(text)
    .filter((entry) => path === undefined || path === "" || entry.path === path)
    .slice(-capped)
    .reverse();
}

async function loadAnnotationMap(realm: WorkspaceRealm): Promise<Record<string, Annotation[]>> {
  const target = await resolveStoreTarget(realm, ANNOTATIONS_NAME);
  if (target === undefined) return {};
  const text = await readTextFile(realm, target);
  if (text === undefined) return {};
  const value = parseJsonLine(text);
  const record = asRecord(value);
  if (record === undefined) return {};
  const out: Record<string, Annotation[]> = {};
  for (const [path, list] of Object.entries(record)) {
    if (!Array.isArray(list)) continue;
    const annotations = list.flatMap((item) => {
      const annotation = asAnnotation(item);
      return annotation === undefined ? [] : [annotation];
    });
    out[path] = annotations;
  }
  return out;
}

async function saveAnnotationMap(realm: WorkspaceRealm, map: Record<string, Annotation[]>): Promise<void> {
  const target = await resolveStoreTarget(realm, ANNOTATIONS_NAME);
  if (target === undefined) return;
  await realm.fs.writeText(target, JSON.stringify(map), undefined, undefined, undefined);
}

export async function listAnnotations(realm: WorkspaceRealm, path: string): Promise<Annotation[]> {
  return (await loadAnnotationMap(realm))[path] ?? [];
}

/** 创建批注:quote 由服务端从当前文件内容截取,行区间非法直接 400. */
export async function createAnnotation(
  realm: WorkspaceRealm,
  path: string,
  input: { readonly lineStart: unknown; readonly lineEnd: unknown; readonly note: unknown; readonly kind: unknown }
): Promise<Annotation> {
  const lineStart = typeof input.lineStart === "number" ? input.lineStart : Number.NaN;
  const lineEnd = typeof input.lineEnd === "number" ? input.lineEnd : Number.NaN;
  if (!Number.isSafeInteger(lineStart) || !Number.isSafeInteger(lineEnd) || lineStart < 1 || lineEnd < lineStart) {
    throw new WorkspaceHttpError(400, "批注行区间不合法。");
  }
  const kind: AnnotationKind = input.kind === undefined || input.kind === "note"
    ? "note"
    : input.kind === "todo" || input.kind === "review"
      ? input.kind
      : (() => { throw new WorkspaceHttpError(400, "批注类型不合法。"); })();
  const file = await readVersionedFile(realm.fs, await creativeTarget(realm, path), STORE_MAX_BYTES);
  const lines = splitLines(file.content);
  if (lineEnd > lines.length) throw new WorkspaceHttpError(400, "批注行区间超出文件范围。");
  const now = Date.now();
  const annotation: Annotation = {
    id: randomUUID(),
    lineStart,
    lineEnd,
    quote: lines.slice(lineStart - 1, lineEnd).join("\n"),
    note: typeof input.note === "string" ? input.note.slice(0, NOTE_MAX_LENGTH) : "",
    kind,
    createdAt: now,
    updatedAt: now,
  };
  const map = await loadAnnotationMap(realm);
  await saveAnnotationMap(realm, { ...map, [path]: [...(map[path] ?? []), annotation] });
  return annotation;
}

export async function deleteAnnotation(realm: WorkspaceRealm, path: string, id: string): Promise<boolean> {
  const map = await loadAnnotationMap(realm);
  const list = map[path] ?? [];
  if (!list.some((annotation) => annotation.id === id)) return false;
  await saveAnnotationMap(realm, { ...map, [path]: list.filter((annotation) => annotation.id !== id) });
  return true;
}

/** 在窗口内按 quote 重新定位:找到更新行号记 moved,找不到记 stale(不丢批注). */
export function reanchorAnnotations(content: string, annotations: readonly Annotation[]): Annotation[] {
  const lines = splitLines(content);
  return annotations.map((annotation) => reanchorOne(lines, annotation));
}

function reanchorOne(lines: readonly string[], annotation: Annotation): Annotation {
  // 重置上轮的 moved/stale:本轮的定位结果才作数,旧标记被有意弃用。
  const { moved: _moved, stale: _stale, ...base } = annotation;
  void _moved;
  void _stale;
  if (annotation.quote === "") return { ...base, stale: true };
  const current = lines.slice(annotation.lineStart - 1, annotation.lineEnd).join("\n");
  if (current === annotation.quote) return base;
  const relocated = locateQuote(lines, annotation.quote, annotation.lineStart);
  if (relocated === undefined) return { ...base, stale: true };
  return { ...base, lineStart: relocated.start, lineEnd: relocated.end, moved: true };
}

function locateQuote(
  lines: readonly string[],
  quote: string,
  lineStart: number
): { readonly start: number; readonly end: number } | undefined {
  const height = quote.split("\n").length;
  const from = Math.max(0, lineStart - 1 - REANCHOR_WINDOW);
  const window = lines.slice(from, lineStart - 1 + REANCHOR_WINDOW + height);
  const joined = window.join("\n");
  const at = joined.indexOf(quote);
  if (at < 0) return undefined;
  let offset = 0;
  for (let index = 0; index < at; index += 1) {
    if (joined[index] === "\n") offset += 1;
  }
  return { start: from + offset + 1, end: from + offset + height };
}

export async function reanchorFileAnnotations(
  realm: WorkspaceRealm,
  path: string,
  content?: string
): Promise<Annotation[]> {
  const text = content ?? (await readVersionedFile(realm.fs, await creativeTarget(realm, path), STORE_MAX_BYTES)).content;
  const map = await loadAnnotationMap(realm);
  const next = reanchorAnnotations(text, map[path] ?? []);
  await saveAnnotationMap(realm, { ...map, [path]: next });
  return next;
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
  send(response, 500, { error: "历史记录操作失败。" });
}

function requirePath(url: URL): string {
  const path = url.searchParams.get("path");
  if (path === null || path === "") throw new WorkspaceHttpError(400, "缺少文件路径。");
  return path;
}

function parseLimit(raw: string | null): number {
  if (raw === null || raw === "") return AUDIT_DEFAULT_LIMIT;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) return AUDIT_DEFAULT_LIMIT;
  return Math.min(value, AUDIT_MAX_LIMIT);
}

async function handleHistoryGet(realm: WorkspaceRealm, url: URL, response: ServerResponse): Promise<void> {
  const path = requirePath(url);
  send(response, 200, { path, versions: await listVersions(realm, path) });
}

async function handleVersionGet(realm: WorkspaceRealm, url: URL, response: ServerResponse): Promise<void> {
  const path = requirePath(url);
  const version = url.searchParams.get("version");
  if (version === null || version === "") throw new WorkspaceHttpError(400, "缺少版本参数。");
  const snapshot = await getVersionSnapshot(realm, path, version);
  if (snapshot === undefined) throw new WorkspaceHttpError(404, "版本不存在。");
  send(response, 200, { path, version: snapshot.version, content: snapshot.content, timestamp: snapshot.timestamp });
}

async function handleRollback(
  realm: WorkspaceRealm,
  url: URL,
  request: IncomingMessage,
  response: ServerResponse,
  options: WorkspaceRouteOptions
): Promise<void> {
  const path = requirePath(url);
  const body = await jsonBody(request, options.maxBytes);
  const version = typeof body.version === "string" ? body.version : "";
  const baseVersion = typeof body.baseVersion === "string" ? body.baseVersion : "";
  const outcome = await rollbackToVersion(realm, path, version, baseVersion);
  send(response, 200, { path, content: outcome.content, version: outcome.version });
}

async function handleAuditGet(realm: WorkspaceRealm, url: URL, response: ServerResponse): Promise<void> {
  const path = url.searchParams.get("path") ?? undefined;
  send(response, 200, { path: path ?? "", entries: await queryAudit(realm, path, parseLimit(url.searchParams.get("limit"))) });
}

async function handleAnnotationsGet(realm: WorkspaceRealm, url: URL, response: ServerResponse): Promise<void> {
  const path = requirePath(url);
  send(response, 200, { path, annotations: await listAnnotations(realm, path) });
}

async function handleAnnotationsPost(
  realm: WorkspaceRealm,
  url: URL,
  request: IncomingMessage,
  response: ServerResponse,
  options: WorkspaceRouteOptions
): Promise<void> {
  const path = requirePath(url);
  const body = await jsonBody(request, options.maxBytes);
  const annotation = await createAnnotation(realm, path, {
    lineStart: body.lineStart,
    lineEnd: body.lineEnd,
    note: body.note,
    kind: body.kind,
  });
  send(response, 200, { path, annotation });
}

async function handleAnnotationsDelete(realm: WorkspaceRealm, url: URL, response: ServerResponse): Promise<void> {
  const path = requirePath(url);
  const id = url.searchParams.get("id");
  if (id === null || id === "") throw new WorkspaceHttpError(400, "缺少批注 id。");
  if (!await deleteAnnotation(realm, path, id)) throw new WorkspaceHttpError(404, "批注不存在。");
  send(response, 200, { path, id, deleted: true });
}

async function handleReanchor(realm: WorkspaceRealm, url: URL, response: ServerResponse): Promise<void> {
  const path = requirePath(url);
  send(response, 200, { path, annotations: await reanchorFileAnnotations(realm, path) });
}

registerWorkspaceExtension({
  name: "history",
  handle: async (
    context: Context,
    request: IncomingMessage,
    response: ServerResponse,
    options: WorkspaceRouteOptions
  ): Promise<boolean> => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;
    const method = request.method ?? "GET";
    try {
      if (pathname === "/oh-story/history" && method === "GET") {
        await handleHistoryGet(await workspaceRealm(context, url), url, response);
        return true;
      }
      if (pathname === "/oh-story/history/version" && method === "GET") {
        await handleVersionGet(await workspaceRealm(context, url), url, response);
        return true;
      }
      if (pathname === "/oh-story/history/rollback" && method === "POST") {
        await handleRollback(await workspaceRealm(context, url), url, request, response, options);
        return true;
      }
      if (pathname === "/oh-story/history/audit" && method === "GET") {
        await handleAuditGet(await workspaceRealm(context, url), url, response);
        return true;
      }
      if (pathname === "/oh-story/annotations" && method === "GET") {
        await handleAnnotationsGet(await workspaceRealm(context, url), url, response);
        return true;
      }
      if (pathname === "/oh-story/annotations" && method === "POST") {
        await handleAnnotationsPost(await workspaceRealm(context, url), url, request, response, options);
        return true;
      }
      if (pathname === "/oh-story/annotations" && method === "DELETE") {
        await handleAnnotationsDelete(await workspaceRealm(context, url), url, response);
        return true;
      }
      if (pathname === "/oh-story/annotations/reanchor" && method === "POST") {
        await handleReanchor(await workspaceRealm(context, url), url, response);
        return true;
      }
    } catch (error) {
      fail(response, error);
      return true;
    }
    return false;
  },
});

// 核心 PUT /oh-story/file 每次成功保存后同步调用:监听器抛错会被吞掉,不影响保存.
onWorkspaceWrite((event) => {
  void recordSave(event).catch(() => undefined);
});
