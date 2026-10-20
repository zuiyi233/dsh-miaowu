/**
 * 只读 `.oh-story` 状态盘点。
 *
 * 盘点只经 `realm.fs`（resolve + contains 守界）进行，绝不写入，也不读取密钥内容：
 * 主密钥只报存在性与字节数，密文信封只取版本字段。文件系统没有 mtime，
 * `lastWriteAt` 只能来自文档内登记的时间戳；拿不到就明确报 `unavailable`。
 */
import type { FileSystem, FsTarget, FsVersion } from "@deepseek-ai/dsh-fs";
import { readVersionedFile, WorkspaceHttpError } from "../workspace-route.js";
import {
  STATE_DESCRIPTORS,
  STATE_SCHEMA_VERSION,
  type StateDescriptor,
  type StateEntryStatus,
  type StateInventory,
  type StateInventoryEntry,
} from "./state-contract.js";

export interface StateInventoryRealm {
  readonly fs: FileSystem;
  readonly cwd: string;
  readonly root: FsTarget;
}

/**
 * 盘点时记下的具体文件（工作区相对路径）。共享契约的条目只带聚合值，
 * 所以文件级明细留在这张进程内边表里，仅供同步的迁移规划使用；
 * 不进入 `StateInventory`，序列化后自然消失。
 */
export interface StateInventoryFileRecord {
  readonly id: string;
  readonly path: string;
  /** 0 = 未版本化；null = 无法判定（损坏/未读取）。 */
  readonly version: number | null;
  readonly topLevel: "object" | "array" | null;
}

const inventoryFiles = new WeakMap<StateInventory, readonly StateInventoryFileRecord[]>();

/** 读取盘点时记录的文件明细；非本模块生成的盘点对象返回空表。 */
export function stateInventoryFiles(inventory: StateInventory): readonly StateInventoryFileRecord[] {
  return inventoryFiles.get(inventory) ?? [];
}

/** 单个状态文档的读取上限；超过即 `not-inspected`，不截断、不猜测。 */
export const STATE_DOCUMENT_MAX_BYTES = 4 * 1024 * 1024;

const JSON_EXTENSION = ".json";
const JSONL_EXTENSION = ".jsonl";
const STATUS_RANK: Readonly<Record<StateEntryStatus, number>> = {
  ok: 0,
  legacy: 1,
  "not-inspected": 2,
  newer: 3,
  corrupt: 4,
  missing: 5,
};

interface DescriptorInspection {
  readonly entry: StateInventoryEntry;
  readonly files: readonly StateInventoryFileRecord[];
}

type StateFileRead =
  | { readonly kind: "missing" }
  | { readonly kind: "blocked"; readonly note: string; readonly bytes: number | null }
  | { readonly kind: "content"; readonly content: string; readonly bytes: number; readonly version: FsVersion };

type StateDirectoryListing =
  | { readonly kind: "missing" }
  | { readonly kind: "blocked"; readonly note: string }
  | { readonly kind: "files"; readonly files: readonly { readonly path: string; readonly bytes: number | null }[] };

interface JsonAssessment {
  readonly status: StateEntryStatus;
  readonly schemaVersion: number | null;
  readonly entries: number | null;
  readonly topLevel: "object" | "array" | null;
  readonly lastWriteAt: string | null;
  readonly note: string | undefined;
}

interface JsonlStats {
  readonly validLines: number;
  readonly malformedLines: number;
  readonly lastWriteAt: string | null;
}

interface EntryFields {
  readonly schemaVersion?: number | null;
  readonly fileCount?: number;
  readonly entries?: number | null;
  readonly bytes?: number | null;
  readonly lastWriteAt?: string | null;
  readonly note?: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function entryFor(
  descriptor: StateDescriptor,
  status: StateEntryStatus,
  fields: EntryFields = {}
): StateInventoryEntry {
  const lastWriteAt = fields.lastWriteAt ?? null;
  return {
    id: descriptor.id,
    path: descriptor.path,
    format: descriptor.format,
    expectedVersion: descriptor.schemaVersion,
    schemaVersion: fields.schemaVersion ?? null,
    status,
    fileCount: fields.fileCount ?? 0,
    entries: fields.entries ?? null,
    bytes: fields.bytes ?? null,
    lastWriteAt,
    lastWriteSource: lastWriteAt === null ? "unavailable" : "document",
    ...(fields.note === undefined ? {} : { note: fields.note }),
  };
}

/** 短说明；只用稳定错误码，绝不回传可能含绝对路径的 error.message。 */
function readFailureNote(error: unknown): string {
  if (error instanceof WorkspaceHttpError) {
    switch (error.status) {
      case 413: return "超过 4 MiB 盘点上限";
      case 415: return "不是 UTF-8 文本";
      case 404: return "读取时文件已消失";
      case 409: return "文件正在被修改";
      default: return "读取失败";
    }
  }
  const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
  return code !== undefined && /^FS_[A-Z_]+$/u.test(code) ? `读取失败（${code}）` : "读取失败";
}

async function stateTarget(realm: StateInventoryRealm, path: string): Promise<FsTarget | undefined> {
  try {
    const target = await realm.fs.resolve(path, { cwd: realm.cwd });
    return realm.fs.contains(realm.root, target) ? target : undefined;
  } catch {
    return undefined;
  }
}

async function readStateFile(realm: StateInventoryRealm, path: string): Promise<StateFileRead> {
  const target = await stateTarget(realm, path);
  if (target === undefined) return { kind: "blocked", note: "路径越界或无法定位", bytes: null };
  let info;
  try {
    info = await realm.fs.stat(target);
  } catch {
    return { kind: "blocked", note: "无法读取文件状态", bytes: null };
  }
  if (info === undefined) return { kind: "missing" };
  if (info.type !== "file") return { kind: "blocked", note: "目标不是普通文件", bytes: null };
  const size = info.size ?? null;
  if (size !== null && size > STATE_DOCUMENT_MAX_BYTES) {
    return { kind: "blocked", note: "超过 4 MiB 盘点上限", bytes: size };
  }
  try {
    const file = await readVersionedFile(realm.fs, target, STATE_DOCUMENT_MAX_BYTES);
    return { kind: "content", content: file.content, bytes: file.bytes, version: file.version };
  } catch (error) {
    return { kind: "blocked", note: readFailureNote(error), bytes: size };
  }
}

async function listStateFiles(
  realm: StateInventoryRealm,
  descriptor: StateDescriptor,
  extension: string
): Promise<StateDirectoryListing> {
  const target = await stateTarget(realm, descriptor.path);
  if (target === undefined) return { kind: "blocked", note: "路径越界或无法定位" };
  let info;
  try {
    info = await realm.fs.stat(target);
  } catch {
    return { kind: "blocked", note: "无法读取目录状态" };
  }
  if (info === undefined) return { kind: "missing" };
  if (info.type !== "directory") return { kind: "blocked", note: "目标不是目录" };
  let children;
  try {
    children = await realm.fs.listDir(target);
  } catch {
    return { kind: "blocked", note: "目录列表读取失败" };
  }
  const base = descriptor.path.endsWith("/") ? descriptor.path : `${descriptor.path}/`;
  const excluded = new Set(descriptor.excludeFiles ?? []);
  const files: { path: string; bytes: number | null }[] = [];
  for (const child of children) {
    if (child.type !== "file" || !child.name.toLowerCase().endsWith(extension)) continue;
    if (excluded.has(child.name)) continue;
    if (!realm.fs.contains(realm.root, child.target)) continue;
    files.push({ path: `${base}${child.name}`, bytes: child.size ?? null });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { kind: "files", files };
}

type DocumentVersion =
  | { readonly kind: "absent" }
  | { readonly kind: "value"; readonly version: number }
  | { readonly kind: "invalid" };

function documentVersion(value: unknown, descriptor: StateDescriptor): DocumentVersion {
  if (!isRecord(value)) return { kind: "absent" };
  const key = descriptor.versionKey ?? "schemaVersion";
  const raw: unknown = value[key];
  if (raw === undefined) return { kind: "absent" };
  return typeof raw === "number" && Number.isSafeInteger(raw)
    ? { kind: "value", version: raw }
    : { kind: "invalid" };
}

function versionStatus(version: number, descriptor: StateDescriptor): StateEntryStatus {
  if (!descriptor.readableVersions.includes(version) || version > descriptor.schemaVersion) return "newer";
  if (version === descriptor.schemaVersion) return "ok";
  return "legacy";
}

function versionNote(version: number, descriptor: StateDescriptor): string | undefined {
  if (version > descriptor.schemaVersion) return `文档版本 ${version} 高于当前构建`;
  if (!descriptor.readableVersions.includes(version)) return `文档版本 ${version} 不在可读范围`;
  return undefined;
}

type DocumentCount =
  | { readonly kind: "count"; readonly count: number }
  | { readonly kind: "invalid"; readonly note: string };

function documentCount(value: unknown, descriptor: StateDescriptor): DocumentCount {
  switch (descriptor.count) {
    case "array": {
      // entriesKey 缺省表示文档本身就是数组（tasks 的 runs/candidates）；
      // 一旦声明了集合字段，顶层必须是对象，否则形状不符合契约。
      if (descriptor.entriesKey === undefined) {
        return Array.isArray(value)
          ? { kind: "count", count: value.length }
          : { kind: "invalid", note: "顶层不是数组" };
      }
      if (!isRecord(value)) return { kind: "invalid", note: "顶层不是对象" };
      const entries = value[descriptor.entriesKey];
      if (Array.isArray(entries)) return { kind: "count", count: entries.length };
      return { kind: "invalid", note: `缺少数组字段 ${descriptor.entriesKey}` };
    }
    case "keys": {
      if (!isRecord(value)) return { kind: "invalid", note: "顶层不是对象" };
      const versionKey = descriptor.versionKey ?? "schemaVersion";
      return { kind: "count", count: Object.keys(value).filter((key) => key !== versionKey).length };
    }
    case "lines": {
      if (!isRecord(value) || !Array.isArray(value.lines)) return { kind: "invalid", note: "缺少 lines 数组" };
      return { kind: "count", count: value.lines.length };
    }
    case "files":
    case "none":
      return { kind: "count", count: 0 };
  }
}

/** 只认文档里登记的时间戳；顶层数组则看每个元素（tasks 的 runs/candidates）。 */
function newestDocumentTime(value: unknown, keys: readonly string[] | undefined): string | null {
  if (keys === undefined || keys.length === 0) return null;
  const stamps: string[] = [];
  const visit = (candidate: unknown): void => {
    if (!isRecord(candidate)) return;
    for (const key of keys) {
      const raw = candidate[key];
      if (typeof raw !== "string") continue;
      const time = Date.parse(raw);
      if (Number.isNaN(time)) continue;
      stamps.push(new Date(time).toISOString());
    }
  };
  visit(value);
  if (Array.isArray(value)) for (const item of value) visit(item);
  let newest: string | null = null;
  for (const iso of stamps) {
    if (newest === null || iso > newest) newest = iso;
  }
  return newest;
}

function assessJsonDocument(content: string, descriptor: StateDescriptor): JsonAssessment {
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch {
    return {
      status: "corrupt",
      schemaVersion: null,
      entries: null,
      topLevel: null,
      lastWriteAt: null,
      note: "JSON 解析失败",
    };
  }
  const topLevel: "object" | "array" | null = Array.isArray(value) ? "array" : isRecord(value) ? "object" : null;
  if (topLevel === null) {
    return {
      status: "corrupt",
      schemaVersion: null,
      entries: null,
      topLevel: null,
      lastWriteAt: null,
      note: "顶层既不是对象也不是数组",
    };
  }
  const count = documentCount(value, descriptor);
  if (count.kind === "invalid") {
    return {
      status: "corrupt",
      schemaVersion: null,
      entries: null,
      topLevel,
      lastWriteAt: null,
      note: count.note,
    };
  }
  const entries = descriptor.count === "none" ? null : count.count;
  const lastWriteAt = newestDocumentTime(value, descriptor.timestampKeys);
  const version = documentVersion(value, descriptor);
  if (version.kind === "invalid") {
    return {
      status: "newer",
      schemaVersion: null,
      entries,
      topLevel,
      lastWriteAt,
      note: "版本字段不是整数，按未知版本处理",
    };
  }
  const resolved = version.kind === "absent" ? 0 : version.version;
  // A derived document is rebuilt, not versioned; an immutable snapshot keeps its
  // historical shape. An absent schemaVersion is normal for both.
  if (version.kind === "absent" && (descriptor.derived === true || descriptor.immutable === true)) {
    return {
      status: "ok",
      schemaVersion: null,
      entries,
      topLevel,
      lastWriteAt,
      note: descriptor.immutable === true ? "历史快照，不参与迁移" : "派生数据，无需版本",
    };
  }
  return {
    status: versionStatus(resolved, descriptor),
    schemaVersion: resolved,
    entries,
    topLevel,
    lastWriteAt,
    note: versionNote(resolved, descriptor),
  };
}

function parseJsonl(content: string, descriptor: StateDescriptor): JsonlStats {
  let validLines = 0;
  let malformedLines = 0;
  let lastWriteAt: string | null = null;
  for (const rawLine of content.split(/\r?\n/u)) {
    if (rawLine.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine) as unknown;
    } catch {
      malformedLines += 1;
      continue;
    }
    validLines += 1;
    const lineTime = newestDocumentTime(parsed, descriptor.timestampKeys);
    if (lineTime !== null && (lastWriteAt === null || lineTime > lastWriteAt)) lastWriteAt = lineTime;
  }
  return { validLines, malformedLines, lastWriteAt };
}

function aggregateStatus(statuses: readonly StateEntryStatus[]): StateEntryStatus {
  let worst: StateEntryStatus = "ok";
  for (const status of statuses) {
    if (STATUS_RANK[status] > STATUS_RANK[worst]) worst = status;
  }
  return worst;
}

async function inspectSingleDocument(
  realm: StateInventoryRealm,
  descriptor: StateDescriptor
): Promise<DescriptorInspection> {
  const read = await readStateFile(realm, descriptor.path);
  if (read.kind === "missing") return { entry: entryFor(descriptor, "missing"), files: [] };
  if (read.kind === "blocked") {
    return { entry: entryFor(descriptor, "not-inspected", { bytes: read.bytes, note: read.note }), files: [] };
  }
  if (descriptor.format === "jsonl") {
    const stats = parseJsonl(read.content, descriptor);
    const corrupt = stats.malformedLines > 0;
    return {
      entry: entryFor(descriptor, corrupt ? "corrupt" : "legacy", {
        schemaVersion: corrupt ? null : 0,
        fileCount: 1,
        entries: stats.validLines,
        bytes: read.bytes,
        lastWriteAt: stats.lastWriteAt,
        note: corrupt
          ? `${stats.malformedLines} 行无法解析，已计入 ${stats.validLines} 行有效记录`
          : "追加型流水（不参与版本迁移）",
      }),
      files: [],
    };
  }
  const assessment = assessJsonDocument(read.content, descriptor);
  return {
    entry: entryFor(descriptor, assessment.status, {
      schemaVersion: assessment.schemaVersion,
      fileCount: 1,
      entries: assessment.entries,
      bytes: read.bytes,
      lastWriteAt: assessment.lastWriteAt,
      note: assessment.note,
    }),
    files: [{
      id: descriptor.id,
      path: descriptor.path,
      version: assessment.schemaVersion,
      topLevel: assessment.topLevel,
    }],
  };
}

async function inspectFileSet(
  realm: StateInventoryRealm,
  descriptor: StateDescriptor
): Promise<DescriptorInspection> {
  const listing = await listStateFiles(realm, descriptor, JSON_EXTENSION);
  if (listing.kind === "missing") return { entry: entryFor(descriptor, "missing"), files: [] };
  if (listing.kind === "blocked") {
    return { entry: entryFor(descriptor, "not-inspected", { note: listing.note }), files: [] };
  }
  if (listing.files.length === 0) {
    return { entry: entryFor(descriptor, "ok", { fileCount: 0, entries: 0, bytes: 0 }), files: [] };
  }

  const files: StateInventoryFileRecord[] = [];
  const statuses: StateEntryStatus[] = [];
  const versions: number[] = [];
  let entries: number | null = null;
  let bytes = 0;
  let bytesKnown = true;
  let lastWriteAt: string | null = null;
  let unreadable = 0;
  let corrupt = 0;

  for (const file of listing.files) {
    const read = await readStateFile(realm, file.path);
    if (read.kind !== "content") {
      unreadable += 1;
      statuses.push("not-inspected");
      const size = read.kind === "blocked" ? (read.bytes ?? file.bytes) : file.bytes;
      if (size === null) bytesKnown = false;
      else bytes += size;
      continue;
    }
    bytes += read.bytes;
    const assessment = assessJsonDocument(read.content, descriptor);
    statuses.push(assessment.status);
    if (assessment.status === "corrupt") corrupt += 1;
    if (assessment.schemaVersion !== null) versions.push(assessment.schemaVersion);
    if (assessment.entries !== null) entries = (entries ?? 0) + assessment.entries;
    if (assessment.lastWriteAt !== null && (lastWriteAt === null || assessment.lastWriteAt > lastWriteAt)) {
      lastWriteAt = assessment.lastWriteAt;
    }
    files.push({
      id: descriptor.id,
      path: file.path,
      version: assessment.schemaVersion,
      topLevel: assessment.topLevel,
    });
  }

  let schemaVersion: number | null = null;
  const firstVersion = versions[0];
  if (firstVersion !== undefined && versions.every((version) => version === firstVersion)) {
    schemaVersion = firstVersion;
  }
  const notes: string[] = [];
  if (corrupt > 0) notes.push(`${corrupt} 个文件损坏`);
  if (unreadable > 0) notes.push(`${unreadable} 个文件无法盘点`);
  if (corrupt === 0 && unreadable === 0 && versions.length > 1 && schemaVersion === null) {
    notes.push("文件版本不一致");
  }
  if (descriptor.derived === true && corrupt === 0 && unreadable === 0 && schemaVersion === null) {
    notes.push("派生数据，无需版本");
  }
  if (descriptor.immutable === true && corrupt === 0 && unreadable === 0 && schemaVersion === null) {
    notes.push("历史快照，不参与迁移");
  }
  return {
    entry: entryFor(descriptor, aggregateStatus(statuses), {
      schemaVersion,
      fileCount: listing.files.length,
      entries,
      bytes: bytesKnown ? bytes : null,
      lastWriteAt,
      note: notes.length === 0 ? undefined : notes.join("；"),
    }),
    files,
  };
}

async function inspectJsonlSet(
  realm: StateInventoryRealm,
  descriptor: StateDescriptor
): Promise<DescriptorInspection> {
  const listing = await listStateFiles(realm, descriptor, JSONL_EXTENSION);
  if (listing.kind === "missing") return { entry: entryFor(descriptor, "missing"), files: [] };
  if (listing.kind === "blocked") {
    return { entry: entryFor(descriptor, "not-inspected", { note: listing.note }), files: [] };
  }
  if (listing.files.length === 0) {
    return { entry: entryFor(descriptor, "ok", { fileCount: 0, entries: 0, bytes: 0 }), files: [] };
  }

  const statuses: StateEntryStatus[] = [];
  let validLines = 0;
  let malformedLines = 0;
  let bytes = 0;
  let bytesKnown = true;
  let lastWriteAt: string | null = null;

  for (const file of listing.files) {
    const read = await readStateFile(realm, file.path);
    if (read.kind !== "content") {
      statuses.push("not-inspected");
      const size = read.kind === "blocked" ? (read.bytes ?? file.bytes) : file.bytes;
      if (size === null) bytesKnown = false;
      else bytes += size;
      continue;
    }
    bytes += read.bytes;
    const stats = parseJsonl(read.content, descriptor);
    validLines += stats.validLines;
    malformedLines += stats.malformedLines;
    statuses.push(stats.malformedLines > 0 ? "corrupt" : "legacy");
    if (stats.lastWriteAt !== null && (lastWriteAt === null || stats.lastWriteAt > lastWriteAt)) {
      lastWriteAt = stats.lastWriteAt;
    }
  }

  return {
    entry: entryFor(descriptor, aggregateStatus(statuses), {
      schemaVersion: 0,
      fileCount: listing.files.length,
      entries: validLines,
      bytes: bytesKnown ? bytes : null,
      lastWriteAt,
      note: malformedLines > 0
        ? `${malformedLines} 行无法解析，已计入 ${validLines} 行有效记录`
        : "追加型流水（不参与版本迁移）",
    }),
    files: [],
  };
}

async function inspectSecret(
  realm: StateInventoryRealm,
  descriptor: StateDescriptor
): Promise<DescriptorInspection> {
  const target = await stateTarget(realm, descriptor.path);
  if (target === undefined) {
    return { entry: entryFor(descriptor, "not-inspected", { note: "路径越界或无法定位" }), files: [] };
  }
  let info;
  try {
    info = await realm.fs.stat(target);
  } catch {
    return { entry: entryFor(descriptor, "not-inspected", { note: "无法读取文件状态" }), files: [] };
  }
  if (info === undefined) return { entry: entryFor(descriptor, "missing"), files: [] };
  if (info.type !== "file") {
    return { entry: entryFor(descriptor, "not-inspected", { note: "目标不是普通文件" }), files: [] };
  }
  const size = info.size ?? null;
  if (descriptor.format !== "json") {
    return {
      entry: entryFor(descriptor, "not-inspected", {
        fileCount: 1,
        bytes: size,
        note: "仅盘点存在性，未读取内容",
      }),
      files: [],
    };
  }
  const read = await readStateFile(realm, descriptor.path);
  if (read.kind === "blocked") {
    return {
      entry: entryFor(descriptor, "not-inspected", { fileCount: 1, bytes: read.bytes ?? size, note: read.note }),
      files: [],
    };
  }
  if (read.kind === "missing") return { entry: entryFor(descriptor, "missing"), files: [] };
  let value: unknown;
  try {
    value = JSON.parse(read.content) as unknown;
  } catch {
    return {
      entry: entryFor(descriptor, "corrupt", {
        fileCount: 1,
        bytes: read.bytes,
        note: "密文信封无法解析（内容未输出）",
      }),
      files: [],
    };
  }
  if (!isRecord(value)) {
    return {
      entry: entryFor(descriptor, "corrupt", {
        fileCount: 1,
        bytes: read.bytes,
        note: "密文信封结构非法（内容未输出）",
      }),
      files: [],
    };
  }
  const version = documentVersion(value, descriptor);
  return {
    entry: entryFor(descriptor, "not-inspected", {
      schemaVersion: version.kind === "value" ? version.version : null,
      fileCount: 1,
      entries: Object.keys(value).length,
      bytes: read.bytes,
      note: "仅读取版本字段，未输出内容",
    }),
    files: [],
  };
}

async function inspectDescriptor(
  realm: StateInventoryRealm,
  descriptor: StateDescriptor
): Promise<DescriptorInspection> {
  if (descriptor.secret === true || descriptor.format === "file") {
    return inspectSecret(realm, descriptor);
  }
  if (descriptor.format === "file-set" || descriptor.path.endsWith("/")) {
    return descriptor.format === "jsonl"
      ? inspectJsonlSet(realm, descriptor)
      : inspectFileSet(realm, descriptor);
  }
  return inspectSingleDocument(realm, descriptor);
}

/**
 * 只读盘点所有 `.oh-story` 状态文档。单个文件缺失/超限/损坏/无权限都落成条目
 * 状态，不会抛错，也不会把内容或绝对路径写进结果。
 */
export async function buildStateInventory(
  realm: StateInventoryRealm,
  options?: { readonly now?: string }
): Promise<StateInventory> {
  const entries: StateInventoryEntry[] = [];
  const files: StateInventoryFileRecord[] = [];
  for (const descriptor of STATE_DESCRIPTORS) {
    const inspection = await inspectDescriptor(realm, descriptor);
    entries.push(inspection.entry);
    files.push(...inspection.files);
  }
  const inventory: StateInventory = {
    generatedAt: options?.now ?? new Date().toISOString(),
    schemaVersion: STATE_SCHEMA_VERSION,
    entries,
  };
  inventoryFiles.set(inventory, files);
  return inventory;
}
