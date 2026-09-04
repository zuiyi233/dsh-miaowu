import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { FileSystem, FsTarget } from "@deepseek-ai/dsh-fs";
import {
  jsonBody,
  mapFsError,
  send,
  workspaceRealm,
  WorkspaceHttpError,
  type WorkspaceRealm,
  type WorkspaceRouteOptions,
} from "../workspace-route.js";
import { registerWorkspaceExtension } from "./registry.js";

/**
 * D2 伏笔埋设→提醒→回收闭环.
 * 参考 Scriverse 域 9(foreshadows + occurrences + listChapterForeshadowReminders +
 * snooze)与 NarraLume 域 3(foreshadows status/importance).
 * 无本地数据库,状态落 `.oh-story/foreshadows.json`,提醒抑制落
 * `.oh-story/foreshadows-snooze.json`.A3 sidecar 只读导入,不回写.
 */

export type ForeshadowStatus = "planned" | "planted" | "resolved" | "abandoned";
export type ForeshadowSource = "manual" | "import";

export interface ForeshadowEvidence {
  readonly path: string;
  readonly line: number;
}

export interface Foreshadow {
  readonly id: string;
  readonly book?: string | undefined;
  readonly chapter?: string | undefined;
  readonly title: string;
  readonly description?: string | undefined;
  readonly status: ForeshadowStatus;
  readonly importance: number;
  readonly plannedPayoffChapter?: string | undefined;
  readonly resolutionNote?: string | undefined;
  readonly source: ForeshadowSource;
  readonly evidence?: readonly ForeshadowEvidence[] | undefined;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface SnoozeRecord {
  readonly id: string;
  readonly untilBook?: string | undefined;
  readonly untilChapter?: string | undefined;
  readonly untilMs?: number | undefined;
}

export interface AnalysisForeshadowInput {
  readonly title: string;
  readonly status: string;
  readonly note?: string | undefined;
  readonly evidence?: readonly { readonly path: string; readonly line: number }[] | undefined;
}

export const FORESHADOWS_EXTENSION_NAME = "foreshadows";
const FORESHADOWS_FILE = ".oh-story/foreshadows.json";
const SNOOZE_FILE = ".oh-story/foreshadows-snooze.json";
const ANALYSIS_ROOT = ".oh-story/analysis";
const STORE_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const MIN_IMPORTANCE = 1;
const MAX_IMPORTANCE = 5;
const DEFAULT_IMPORTANCE = 3;
const MAX_TITLE_LENGTH = 120;
const MAX_TEXT_LENGTH = 2000;
const DAY_MS = 24 * 60 * 60 * 1000;

const FORESHADOW_STATUSES: readonly ForeshadowStatus[] = ["planned", "planted", "resolved", "abandoned"];

export function isForeshadowStatus(value: string): value is ForeshadowStatus {
  return (FORESHADOW_STATUSES as readonly string[]).includes(value);
}

/**
 * 状态机:planned→planted→resolved;任意非终态→abandoned;终态不可回退.
 * from===to 视为幂等合法,由调用方返回 idempotentReplay.
 */
export function isLegalForeshadowTransition(from: ForeshadowStatus, to: ForeshadowStatus): boolean {
  if (from === to) return true;
  if (from === "resolved" || from === "abandoned") return false;
  if (to === "abandoned") return true;
  if (from === "planned" && to === "planted") return true;
  if (from === "planted" && to === "resolved") return true;
  return false;
}

export function normalizeImportance(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return DEFAULT_IMPORTANCE;
  if (value < MIN_IMPORTANCE || value > MAX_IMPORTANCE) return DEFAULT_IMPORTANCE;
  return value;
}

export function mapAnalysisStatus(status: string): ForeshadowStatus {
  if (status === "resolved") return "resolved";
  return "planted";
}

/** A3 sidecar 单条 → 伏笔实体. resolved 附带回收备注,其余 note 进 description. */
export function mapImportedForeshadow(entry: AnalysisForeshadowInput, book: string, now?: number): Foreshadow {
  const at = now ?? Date.now();
  const status = mapAnalysisStatus(entry.status);
  const note = typeof entry.note === "string" && entry.note.trim() !== "" ? entry.note.trim().slice(0, MAX_TEXT_LENGTH) : undefined;
  const evidence = Array.isArray(entry.evidence)
    ? entry.evidence.flatMap((item): ForeshadowEvidence[] => {
        if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
        const record = item as { readonly path?: unknown; readonly line?: unknown };
        return typeof record.path === "string" && Number.isSafeInteger(record.line) && (record.line as number) > 0
          ? [{ path: record.path, line: record.line as number }]
          : [];
      })
    : [];
  return {
    id: randomUUID(),
    book,
    title: entry.title.trim().slice(0, MAX_TITLE_LENGTH),
    ...(note === undefined ? {} : { description: note }),
    status,
    importance: DEFAULT_IMPORTANCE,
    ...(status === "resolved" && note !== undefined ? { resolutionNote: note } : {}),
    source: "import",
    ...(evidence.length === 0 ? {} : { evidence }),
    createdAt: at,
    updatedAt: at,
  };
}

export function importDedupeKey(book: string | undefined, title: string): string {
  return JSON.stringify([book ?? "", title.trim()]);
}

/**
 * Scriverse listChapterForeshadowReminders 语义:该 book 下未终态
 * (planned/planted)且未设回收章或回收章等于当前章.
 */
export function selectReminders(
  items: readonly Foreshadow[],
  book?: string,
  chapter?: string
): Foreshadow[] {
  const wantBook = book ?? "";
  const wantChapter = chapter ?? "";
  return items.filter((item) => {
    if (item.status !== "planned" && item.status !== "planted") return false;
    if (wantBook !== "" && item.book !== wantBook) return false;
    const payoff = item.plannedPayoffChapter ?? "";
    if (payoff === "") return true;
    if (wantChapter === "") return false;
    return payoff === wantChapter;
  });
}

/**
 * snooze 语义(查询态抑制,非推送):
 * - untilMs 未过期才有效;过期视为无记录.
 * - untilBook/untilChapter 为作用域:指定后仅在查询命中该位置时抑制
 *   (客户端「按章搁置」传当前章,「按天搁置」传 untilMs).
 * - 三者全空为无限期抑制.
 */
export function isSnoozed(
  snoozes: readonly SnoozeRecord[],
  id: string,
  now: number,
  book?: string,
  chapter?: string
): boolean {
  const record = snoozes.find((item) => item.id === id);
  if (record === undefined) return false;
  if (record.untilMs !== undefined && Number.isFinite(record.untilMs) && now >= record.untilMs) return false;
  const wantBook = book ?? "";
  const wantChapter = chapter ?? "";
  if (record.untilBook !== undefined && record.untilBook !== "" && wantBook !== "" && record.untilBook !== wantBook) {
    return false;
  }
  if (record.untilChapter !== undefined && record.untilChapter !== "" && wantChapter !== "" && record.untilChapter !== wantChapter) {
    return false;
  }
  return true;
}

export function filterSnoozedReminders(
  reminders: readonly Foreshadow[],
  snoozes: readonly SnoozeRecord[],
  now: number,
  book?: string,
  chapter?: string
): Foreshadow[] {
  return reminders.filter((item) => !isSnoozed(snoozes, item.id, now, book, chapter));
}

export function parseListLimit(raw: string | null): number {
  if (raw === null || raw === "") return DEFAULT_LIMIT;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) return DEFAULT_LIMIT;
  return Math.min(value, MAX_LIMIT);
}

export function parseForeshadowStatusFilter(raw: string | null): ForeshadowStatus[] | undefined {
  if (raw === null || raw === "") return undefined;
  const list = raw.split(",").map((part) => part.trim()).filter((part) => part !== "");
  const kept = list.filter(isForeshadowStatus);
  if (kept.length !== list.length) throw new WorkspaceHttpError(400, "status 参数非法。");
  return kept;
}

export function snoozeUntilMs(days = 1): number {
  return Date.now() + days * DAY_MS;
}

type RealmRoot = Parameters<FileSystem["contains"]>[0];

async function resolveInside(fs: WorkspaceRealm["fs"], cwd: string, root: RealmRoot, rel: string): Promise<FsTarget> {
  const target = await fs.resolve(rel, { cwd });
  if (!fs.contains(root, target)) throw new WorkspaceHttpError(403, "文件路径离开了 DSH 工作目录。");
  return target;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asEvidence(value: unknown): ForeshadowEvidence | undefined {
  const record = asRecord(value);
  if (record === undefined || typeof record.path !== "string" || !Number.isSafeInteger(record.line)) return undefined;
  const line = record.line as number;
  if (line <= 0) return undefined;
  return { path: record.path, line };
}

function asForeshadow(value: unknown): Foreshadow | undefined {
  const record = asRecord(value);
  if (record === undefined || typeof record.id !== "string" || typeof record.title !== "string") return undefined;
  if (typeof record.status !== "string" || !isForeshadowStatus(record.status)) return undefined;
  const evidenceRaw = record.evidence;
  const evidence = Array.isArray(evidenceRaw)
    ? evidenceRaw.flatMap((item) => {
        const ref = asEvidence(item);
        return ref === undefined ? [] : [ref];
      })
    : undefined;
  return {
    id: record.id,
    book: typeof record.book === "string" ? record.book : undefined,
    chapter: typeof record.chapter === "string" ? record.chapter : undefined,
    title: record.title,
    description: typeof record.description === "string" ? record.description : undefined,
    status: record.status,
    importance: normalizeImportance(record.importance),
    plannedPayoffChapter: typeof record.plannedPayoffChapter === "string" ? record.plannedPayoffChapter : undefined,
    resolutionNote: typeof record.resolutionNote === "string" ? record.resolutionNote : undefined,
    source: record.source === "import" ? "import" : "manual",
    ...(evidence === undefined ? {} : { evidence }),
    createdAt: typeof record.createdAt === "number" ? record.createdAt : 0,
    updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : 0,
  };
}

function asSnooze(value: unknown): SnoozeRecord | undefined {
  const record = asRecord(value);
  if (record === undefined || typeof record.id !== "string" || record.id === "") return undefined;
  const untilMs = record.untilMs;
  return {
    id: record.id,
    untilBook: typeof record.untilBook === "string" ? record.untilBook : undefined,
    untilChapter: typeof record.untilChapter === "string" ? record.untilChapter : undefined,
    untilMs: typeof untilMs === "number" && Number.isFinite(untilMs) ? untilMs : undefined,
  };
}

async function readJsonText(realm: WorkspaceRealm, rel: string, maxBytes: number): Promise<string | undefined> {
  let target: FsTarget;
  try {
    target = await resolveInside(realm.fs, realm.cwd, realm.root, rel);
  } catch {
    return undefined;
  }
  const info = await realm.fs.stat(target).catch(() => undefined);
  if (info?.type !== "file") return undefined;
  try {
    const bytes = await realm.fs.readBytes(target, undefined, maxBytes);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** 损坏 JSON 降级为空,不抛. */
export async function loadForeshadows(realm: WorkspaceRealm, maxBytes: number): Promise<Foreshadow[]> {
  const text = await readJsonText(realm, FORESHADOWS_FILE, maxBytes);
  if (text === undefined) return [];
  try {
    const value = JSON.parse(text) as unknown;
    const items = asRecord(value)?.items;
    if (!Array.isArray(items)) return [];
    return items.flatMap((item) => {
      const parsed = asForeshadow(item);
      return parsed === undefined ? [] : [parsed];
    });
  } catch {
    return [];
  }
}

export async function loadSnoozes(realm: WorkspaceRealm, maxBytes: number): Promise<SnoozeRecord[]> {
  const text = await readJsonText(realm, SNOOZE_FILE, maxBytes);
  if (text === undefined) return [];
  try {
    const value = JSON.parse(text) as unknown;
    const raw = asRecord(value)?.items ?? value;
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((item) => {
      const parsed = asSnooze(item);
      return parsed === undefined ? [] : [parsed];
    });
  } catch {
    return [];
  }
}

async function saveJson(realm: WorkspaceRealm, rel: string, payload: unknown): Promise<void> {
  const target = await resolveInside(realm.fs, realm.cwd, realm.root, rel);
  await realm.fs.writeText(target, JSON.stringify(payload, null, 2), undefined, undefined, undefined).catch(() => undefined);
}

export async function saveForeshadows(realm: WorkspaceRealm, items: readonly Foreshadow[]): Promise<void> {
  await saveJson(realm, FORESHADOWS_FILE, { items });
}

export async function saveSnoozes(realm: WorkspaceRealm, items: readonly SnoozeRecord[]): Promise<void> {
  await saveJson(realm, SNOOZE_FILE, { items });
}

function asAnalysisInput(value: unknown): AnalysisForeshadowInput | undefined {
  const record = asRecord(value);
  if (record === undefined || typeof record.title !== "string" || record.title.trim() === "") return undefined;
  if (typeof record.status !== "string") return undefined;
  const evidenceRaw = record.evidence;
  const evidence = Array.isArray(evidenceRaw)
    ? evidenceRaw.flatMap((item) => {
        const ref = asEvidence(item);
        return ref === undefined ? [] : [ref];
      })
    : undefined;
  return {
    title: record.title,
    status: record.status,
    note: typeof record.note === "string" ? record.note : undefined,
    ...(evidence === undefined ? {} : { evidence }),
  };
}

/** 只读 A3 sidecar 的 foreshadows 数组;缺失或损坏返回 undefined. */
export async function readAnalysisForeshadows(
  realm: WorkspaceRealm,
  book: string,
  maxBytes: number
): Promise<AnalysisForeshadowInput[] | undefined> {
  const text = await readJsonText(realm, `${ANALYSIS_ROOT}/${book}.json`, maxBytes);
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    const raw = asRecord(value)?.foreshadows;
    if (!Array.isArray(raw)) return undefined;
    return raw.flatMap((item) => {
      const parsed = asAnalysisInput(item);
      return parsed === undefined ? [] : [parsed];
    });
  } catch {
    return undefined;
  }
}

function cleanOptionalText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().slice(0, max);
  return trimmed === "" ? undefined : trimmed;
}

function requireTitle(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new WorkspaceHttpError(400, "title 必填。");
  if (value.trim().length > MAX_TITLE_LENGTH) throw new WorkspaceHttpError(400, "title 过长。");
  return value.trim();
}

function safeBookName(book: string): boolean {
  return book !== "" && !book.includes("/") && !book.includes("\\") && book !== "." && book !== "..";
}

function replaceItem(items: readonly Foreshadow[], next: Foreshadow): Foreshadow[] {
  return items.map((item) => (item.id === next.id ? next : item));
}

async function handleCreate(realm: WorkspaceRealm, request: IncomingMessage, maxBytes: number): Promise<Foreshadow> {
  const body = await jsonBody(request, maxBytes);
  const title = requireTitle(body.title);
  const now = Date.now();
  const item: Foreshadow = {
    id: randomUUID(),
    ...(cleanOptionalText(body.book, MAX_TITLE_LENGTH) === undefined ? {} : { book: cleanOptionalText(body.book, MAX_TITLE_LENGTH) }),
    ...(cleanOptionalText(body.chapter, MAX_TITLE_LENGTH) === undefined ? {} : { chapter: cleanOptionalText(body.chapter, MAX_TITLE_LENGTH) }),
    title,
    ...(cleanOptionalText(body.description, MAX_TEXT_LENGTH) === undefined
      ? {}
      : { description: cleanOptionalText(body.description, MAX_TEXT_LENGTH) }),
    status: "planned",
    importance: normalizeImportance(body.importance),
    ...(cleanOptionalText(body.plannedPayoffChapter, MAX_TITLE_LENGTH) === undefined
      ? {}
      : { plannedPayoffChapter: cleanOptionalText(body.plannedPayoffChapter, MAX_TITLE_LENGTH) }),
    source: "manual",
    createdAt: now,
    updatedAt: now,
  };
  const items = await loadForeshadows(realm, maxBytes);
  await saveForeshadows(realm, [...items, item]);
  return item;
}

async function handleStatusChange(
  realm: WorkspaceRealm,
  id: string,
  request: IncomingMessage,
  maxBytes: number
): Promise<{ foreshadow: Foreshadow; idempotentReplay: boolean }> {
  const body = await jsonBody(request, maxBytes);
  if (typeof body.status !== "string" || !isForeshadowStatus(body.status)) {
    throw new WorkspaceHttpError(400, "status 非法。");
  }
  const to = body.status;
  const items = await loadForeshadows(realm, maxBytes);
  const found = items.find((item) => item.id === id);
  if (found === undefined) throw new WorkspaceHttpError(404, "伏笔不存在。");
  if (found.status === to) return { foreshadow: found, idempotentReplay: true };
  if (!isLegalForeshadowTransition(found.status, to)) {
    throw new WorkspaceHttpError(409, "伏笔状态转移非法。");
  }
  const resolutionNote = cleanOptionalText(body.resolutionNote, MAX_TEXT_LENGTH);
  const note = cleanOptionalText(body.note, MAX_TEXT_LENGTH);
  const next: Foreshadow = {
    ...found,
    status: to,
    ...(resolutionNote !== undefined
      ? { resolutionNote }
      : note !== undefined && to === "resolved"
        ? { resolutionNote: note }
        : {}),
    ...(resolutionNote === undefined && note !== undefined && to !== "resolved" ? { description: note } : {}),
    updatedAt: Date.now(),
  };
  await saveForeshadows(realm, replaceItem(items, next));
  return { foreshadow: next, idempotentReplay: false };
}

async function handleImport(
  realm: WorkspaceRealm,
  request: IncomingMessage,
  maxBytes: number
): Promise<{ book: string; imported: number; skipped: number; foreshadows: Foreshadow[] }> {
  const body = await jsonBody(request, maxBytes);
  if (typeof body.book !== "string" || body.book.trim() === "" || !safeBookName(body.book.trim())) {
    throw new WorkspaceHttpError(400, "book 参数非法。");
  }
  const book = body.book.trim();
  const sidecar = await readAnalysisForeshadows(realm, book, maxBytes);
  if (sidecar === undefined) throw new WorkspaceHttpError(404, "该书尚未解析或 sidecar 已损坏,请先 POST /oh-story/analysis/parse。");
  const items = await loadForeshadows(realm, maxBytes);
  const seen = new Set(items.map((item) => importDedupeKey(item.book, item.title)));
  const created: Foreshadow[] = [];
  let skipped = 0;
  for (const entry of sidecar) {
    const key = importDedupeKey(book, entry.title);
    if (seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    created.push(mapImportedForeshadow(entry, book));
  }
  if (created.length > 0) await saveForeshadows(realm, [...items, ...created]);
  return { book, imported: created.length, skipped, foreshadows: created };
}

async function handleSnooze(
  realm: WorkspaceRealm,
  request: IncomingMessage,
  maxBytes: number
): Promise<{ snooze: SnoozeRecord }> {
  const body = await jsonBody(request, maxBytes);
  if (typeof body.id !== "string" || body.id === "") throw new WorkspaceHttpError(400, "id 必填。");
  const items = await loadForeshadows(realm, maxBytes);
  if (!items.some((item) => item.id === body.id)) throw new WorkspaceHttpError(404, "伏笔不存在。");
  const untilBook = cleanOptionalText(body.untilBook, MAX_TITLE_LENGTH);
  const untilChapter = cleanOptionalText(body.untilChapter, MAX_TITLE_LENGTH);
  const rawMs = body.untilMs;
  if (rawMs !== undefined && (typeof rawMs !== "number" || !Number.isFinite(rawMs) || rawMs <= 0)) {
    throw new WorkspaceHttpError(400, "untilMs 非法。");
  }
  const record: SnoozeRecord = {
    id: body.id,
    ...(untilBook === undefined ? {} : { untilBook }),
    ...(untilChapter === undefined ? {} : { untilChapter }),
    ...(rawMs === undefined ? {} : { untilMs: rawMs }),
  };
  const snoozes = await loadSnoozes(realm, maxBytes);
  const next = [...snoozes.filter((item) => item.id !== record.id), record];
  await saveSnoozes(realm, next);
  return { snooze: record };
}

export async function handleForeshadowsRequest(
  context: Context,
  request: IncomingMessage,
  response: ServerResponse,
  options: WorkspaceRouteOptions
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (!url.pathname.startsWith("/oh-story/foreshadows")) return false;
  const realm = await workspaceRealm(context, url);
  const maxBytes = options.maxBytes > 0 ? options.maxBytes : STORE_MAX_BYTES;
  try {
    const parts = url.pathname.split("/");
    const rest = parts.slice(3);
    if (request.method === "POST" && rest.length === 1 && rest[0] === "import") {
      const result = await handleImport(realm, request, maxBytes);
      send(response, 200, result);
      return true;
    }
    if (request.method === "GET" && rest.length === 1 && rest[0] === "reminders") {
      const book = url.searchParams.get("book") ?? undefined;
      const chapter = url.searchParams.get("chapter") ?? undefined;
      const items = await loadForeshadows(realm, maxBytes);
      const snoozes = await loadSnoozes(realm, maxBytes);
      const now = Date.now();
      const due = selectReminders(items, book ?? "", chapter ?? "");
      const reminders = filterSnoozedReminders(due, snoozes, now, book ?? "", chapter ?? "");
      send(response, 200, { book: book ?? null, chapter: chapter ?? null, reminders });
      return true;
    }
    if (request.method === "POST" && rest.length === 1 && rest[0] === "snooze") {
      const result = await handleSnooze(realm, request, maxBytes);
      send(response, 200, result);
      return true;
    }
    if (request.method === "POST" && rest.length === 0) {
      const foreshadow = await handleCreate(realm, request, maxBytes);
      send(response, 200, { foreshadow });
      return true;
    }
    if (request.method === "GET" && rest.length === 0) {
      const book = url.searchParams.get("book") ?? undefined;
      const statuses = parseForeshadowStatusFilter(url.searchParams.get("status"));
      const items = await loadForeshadows(realm, maxBytes);
      const filtered = items.filter(
        (item) =>
          (book === undefined || book === "" || item.book === book) &&
          (statuses === undefined || statuses.includes(item.status))
      );
      const limited = filtered.slice(0, parseListLimit(url.searchParams.get("limit")));
      send(response, 200, { foreshadows: limited, total: filtered.length });
      return true;
    }
    if (request.method === "POST" && rest.length === 2 && rest[1] === "status") {
      const id = decodeURIComponent(rest[0] ?? "");
      if (id === "") throw new WorkspaceHttpError(400, "id 非法。");
      const { foreshadow, idempotentReplay } = await handleStatusChange(realm, id, request, maxBytes);
      send(response, 200, { foreshadow, ...(idempotentReplay ? { idempotentReplay: true } : {}) });
      return true;
    }
    send(response, 404, { error: "Foreshadows route not found." });
    return true;
  } catch (error) {
    const mapped = error instanceof WorkspaceHttpError ? error : mapFsError(error);
    if (mapped === undefined) throw error;
    send(response, mapped.status, { error: mapped.message });
    return true;
  }
}

registerWorkspaceExtension({ name: FORESHADOWS_EXTENSION_NAME, handle: handleForeshadowsRequest });

export function registerForeshadowsService(): void {
  // 模块顶层已注册扩展缝,保留具名导出兼容合并导入.
}
