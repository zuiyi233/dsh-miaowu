import type { FsDirEntry, FsTarget, FsVersion } from "@deepseek-ai/dsh-fs";
import { mapFsError, readVersionedFile, WorkspaceHttpError, type WorkspaceRealm } from "../workspace-route.js";
import {
  AUDIOBOOK_ROOT,
  AUDIOBOOK_SCHEMA_VERSION,
  type AudiobookAsset,
  type AudiobookAssetAuthorization,
  type AudiobookAssetAuthorizationDocument,
  type AudiobookAssetKind,
  type AudiobookAssetProviderReceipt,
  type AudiobookAssetUse,
  type AudiobookAssetView,
  type AudiobookAuthorizationRecord,
  type AudiobookCue,
  type AudiobookProject,
  type AudiobookProjectRecord,
  type AudiobookScript,
} from "./audiobook-contract.js";

/**
 * 有声剧素材（N4-C）：音乐/音效目录扫描、`素材/授权.json` 持久化与 cue 授权校验。
 *
 * 素材与授权路径都是**工作区相对路径**（`有声剧/<book>/素材/...`），与 N4-B 的
 * `AudiobookCue.asset` 同一形态；书内固定目录由 `AUDIOBOOK_ASSET_DIRECTORIES`
 * 追加在 `project.json` 所在目录（`dirname(project.path)`）之后。授权文档缺失不算
 * 错误（视图版本为 null），只有授权条目存在且 license 有效、`allowedUse` 含
 * `audiobook` 的素材才算 `authorized`。本模块只做领域读写，不写宿主状态。
 */

/** 书内相对素材目录；扫描与授权 path 都以此为后缀拼成工作区相对路径。 */
export const AUDIOBOOK_ASSET_DIRECTORIES: Readonly<Record<AudiobookAssetKind, string>> = {
  music: "素材/音乐",
  effect: "素材/音效",
};
export const AUDIOBOOK_AUTHORIZATION_FILE = "素材/授权.json";

const ASSET_DIRECTORY = "素材";
const AUTHORIZATION_MAX_BYTES = 512 * 1_024;
const AUDIO_EXTENSIONS: readonly string[] = [".mp3", ".wav", ".ogg"];
/**
 * 素材排序键：先按 kind 字母序（effect → music），再按完整路径升序。
 * 不能只按路径用 `localeCompare("zh-Hans-CN")`：ICU 把“乐”读作 lè，`音效`
 * 会排到 `音乐` 之后；素材目录名固定，kind 分组给出稳定、跨引擎一致的结果。
 */
const ASSET_KINDS: readonly AudiobookAssetKind[] = ["effect", "music"];
const ASSET_USES: readonly AudiobookAssetUse[] = ["audiobook", "commercial"];
/** 生成素材尚未补授权时的占位 license：非空但视为未授权。 */
const UNVERIFIED_LICENSE = "unverified";

const compareLabels = (left: string, right: string): number => left.localeCompare(right, "zh-Hans-CN");

function badRequest(message: string): WorkspaceHttpError {
  return new WorkspaceHttpError(400, message);
}

function unprocessable(message: string): WorkspaceHttpError {
  return new WorkspaceHttpError(422, message);
}

function hasControlCharacter(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** 归一化工作区相对路径；绝对路径、盘符、反斜杠、空段与 `..` 一律拒绝。 */
function relativePathOrNull(raw: string): string | null {
  const text = raw.trim();
  if (text === "" || text.startsWith("/") || text.includes("\\") || /^[A-Za-z]:/u.test(text)) return null;
  const segments = text.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".." || hasControlCharacter(segment))) return null;
  return segments.join("/");
}

function workspacePath(value: unknown, label: string): string {
  if (typeof value !== "string") throw badRequest(`${label} 必须是字符串路径。`);
  const path = relativePathOrNull(value);
  if (path === null) throw badRequest(`${label} 必须是工作区内的相对路径。`);
  return path;
}

/** `project.json` 所在目录：`有声剧/<book>`。授权文档与素材目录都挂在这里。 */
function bookDirectoryOf(projectPath: string): string {
  const path = workspacePath(projectPath, "项目路径");
  const segments = path.split("/");
  if (segments[0] !== AUDIOBOOK_ROOT) throw new WorkspaceHttpError(403, `有声剧项目必须位于 ${AUDIOBOOK_ROOT}/ 目录下。`);
  if (segments.length < 3) throw badRequest("有声剧项目路径必须形如 有声剧/<名称>/project.json。");
  return segments.slice(0, -1).join("/");
}

function authorizationPathFor(projectPath: string): string {
  return `${bookDirectoryOf(projectPath)}/${AUDIOBOOK_AUTHORIZATION_FILE}`;
}

function isAudioName(name: string): boolean {
  const lower = name.toLowerCase();
  return AUDIO_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

async function resolveInside(realm: WorkspaceRealm, path: string): Promise<FsTarget> {
  const target = await realm.fs.resolve(path, { cwd: realm.cwd });
  if (!realm.fs.contains(realm.root, target)) throw new WorkspaceHttpError(403, "路径离开了 DSH 工作目录。");
  return target;
}

async function listDirectory(realm: WorkspaceRealm, path: string): Promise<readonly FsDirEntry[]> {
  const target = await resolveInside(realm, path);
  const info = await realm.fs.stat(target);
  return info?.type === "directory" ? await realm.fs.listDir(target) : [];
}

interface ScannedAsset {
  readonly path: string;
  readonly kind: AudiobookAssetKind;
  readonly bytes: number;
}

/** 扫描 `素材/音乐` 与 `素材/音效`：只收音频扩展名且 `stat` 为文件的条目，按 kind 后路径排序。 */
async function scanAssets(realm: WorkspaceRealm, bookDirectory: string): Promise<ScannedAsset[]> {
  const assets: ScannedAsset[] = [];
  const directoryPrefix = `${bookDirectory}/${ASSET_DIRECTORY}/`;
  for (const kind of ASSET_KINDS) {
    const directory = `${bookDirectory}/${AUDIOBOOK_ASSET_DIRECTORIES[kind]}`;
    for (const entry of await listDirectory(realm, directory)) {
      if (entry.type !== "file" || entry.name === "" || entry.name.includes("/") || !isAudioName(entry.name)) continue;
      const path = `${directory}/${entry.name}`;
      if (!path.startsWith(directoryPrefix)) continue;
      const info = await realm.fs.stat(await resolveInside(realm, path));
      if (info?.type !== "file") continue;
      assets.push({ path, kind, bytes: info.size ?? 0 });
    }
  }
  return assets.sort((left, right) => compareLabels(left.kind, right.kind) || compareLabels(left.path, right.path));
}

type JsonRecord = Readonly<Record<string, unknown>>;

function asRecord(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw badRequest(`${label} 必须是对象。`);
  return value as JsonRecord;
}

function asArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw badRequest(`${label} 必须是数组。`);
  return value;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw badRequest(`${label} 必须是非空字符串。`);
  return value;
}

/** license 是授权语义字段：空值属于语义不可处理（422），而不是形状错误。 */
function licenseOf(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw unprocessable(`${label} 必须是非空许可证名称。`);
  return value;
}

/** 用途白名单：非数组、空数组、未知取值都属于语义不可处理（422）。 */
function usesOf(value: unknown, label: string): readonly AudiobookAssetUse[] {
  if (!Array.isArray(value) || value.length === 0) throw unprocessable(`${label} 必须是非空的用途数组。`);
  const uses: AudiobookAssetUse[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string") throw unprocessable(`${label}[${index}] 必须是字符串。`);
    const use = ASSET_USES.find((candidate) => candidate === item);
    if (use === undefined) throw unprocessable(`${label}[${index}] 取值不受支持，只允许 audiobook 或 commercial。`);
    if (!uses.includes(use)) uses.push(use);
  }
  return uses;
}

/** 生成回执是授权条目的附属元数据：存在即校验形状，保存时原样保留。 */
function optionalProvider(value: unknown, label: string): AudiobookAssetProviderReceipt | undefined {
  if (value === undefined) return undefined;
  const record = asRecord(value, label);
  const receiptId = record["receiptId"];
  if (receiptId !== null && typeof receiptId !== "string") throw badRequest(`${label}.receiptId 必须是字符串或 null。`);
  const generatedAt = record["generatedAt"];
  if (typeof generatedAt !== "number" || !Number.isFinite(generatedAt)) throw badRequest(`${label}.generatedAt 不是有效数字。`);
  return {
    id: requiredText(record["id"], `${label}.id`),
    model: requiredText(record["model"], `${label}.model`),
    promptSha256: requiredText(record["promptSha256"], `${label}.promptSha256`),
    receiptId,
    generatedAt,
  };
}

function parseAuthorization(value: unknown, index: number, bookDirectory: string): AudiobookAssetAuthorization {
  const label = `assets[${index}]`;
  const record = asRecord(value, label);
  const path = workspacePath(record["path"], `${label}.path`);
  if (!path.startsWith(`${bookDirectory}/${ASSET_DIRECTORY}/`)) {
    throw badRequest(`${label}.path 必须位于 ${bookDirectory}/${ASSET_DIRECTORY}/ 目录下。`);
  }
  const attribution = record["attribution"];
  if (typeof attribution !== "string") throw badRequest(`${label}.attribution 必须是字符串。`);
  const provider = optionalProvider(record["provider"], `${label}.provider`);
  return {
    path,
    source: requiredText(record["source"], `${label}.source`),
    license: licenseOf(record["license"], `${label}.license`),
    allowedUse: usesOf(record["allowedUse"], `${label}.allowedUse`),
    attribution,
    ...(provider === undefined ? {} : { provider }),
  };
}

/** 授权文档只接受 schemaVersion 1；path 必须限定在本项目的 `素材/` 内且不重复。 */
function validateAuthorizationDocument(value: unknown, bookDirectory: string): AudiobookAssetAuthorizationDocument {
  const record = asRecord(value, "素材授权");
  if (record["schemaVersion"] !== AUDIOBOOK_SCHEMA_VERSION) throw badRequest("素材授权 schemaVersion 必须为 1。");
  const assets = asArray(record["assets"], "素材授权 assets").map((item, index) => parseAuthorization(item, index, bookDirectory));
  const seen = new Set<string>();
  for (const asset of assets) {
    if (seen.has(asset.path)) throw badRequest(`素材授权条目的 path 重复：${asset.path}`);
    seen.add(asset.path);
  }
  return { schemaVersion: AUDIOBOOK_SCHEMA_VERSION, assets };
}

function serializeAuthorization(document: AudiobookAssetAuthorizationDocument): string {
  return `${JSON.stringify(document, undefined, 2)}\n`;
}

function isAuthorized(entry: AudiobookAssetAuthorization | undefined): boolean {
  if (entry === undefined) return false;
  return entry.license.trim() !== "" && entry.license !== UNVERIFIED_LICENSE && entry.allowedUse.includes("audiobook");
}

/**
 * 读取 `有声剧/<book>/素材/授权.json`；文件缺失返回 undefined（不是错误），
 * 超过 512 KiB 仍是 413，坏 JSON 或不合规文档统一 422。
 */
export async function loadAssetAuthorizations(
  realm: WorkspaceRealm,
  projectPath: string,
): Promise<AudiobookAuthorizationRecord | undefined> {
  const path = authorizationPathFor(projectPath);
  const target = await resolveInside(realm, path);
  let content: string;
  let version: FsVersion;
  try {
    const file = await readVersionedFile(realm.fs, target, AUTHORIZATION_MAX_BYTES);
    content = file.content;
    version = file.version;
  } catch (error) {
    const mapped = mapFsError(error);
    if (mapped?.status === 404 || (error instanceof WorkspaceHttpError && error.status === 404)) return undefined;
    if (mapped !== undefined) throw mapped;
    throw error;
  }
  try {
    const value: unknown = JSON.parse(content);
    return { document: validateAuthorizationDocument(value, bookDirectoryOf(projectPath)), path, version: String(version) };
  } catch (error) {
    if (error instanceof WorkspaceHttpError) throw unprocessable(`素材授权文档无效：${error.message}`);
    if (error instanceof SyntaxError) throw unprocessable("素材授权不是有效的 JSON。");
    throw error;
  }
}

/**
 * 保存授权文档：先按当前扫描结果校验（path 必须是扫到的素材），再按
 * baseVersion 走 createIfAbsent / replaceIfVersion 的 CAS。写入经沙箱策略，
 * 超过 512 KiB 返回 413，创建冲突 409，版本过期 412。
 */
export async function saveAssetAuthorizations(
  realm: WorkspaceRealm,
  project: AudiobookProjectRecord,
  document: AudiobookAssetAuthorizationDocument,
  baseVersion: string | null,
): Promise<AudiobookAuthorizationRecord> {
  const bookDirectory = bookDirectoryOf(project.path);
  const version = baseVersion === null ? null : baseVersion.trim();
  if (version === "") throw badRequest("缺少基础版本号。");
  const scanned = await scanAssets(realm, bookDirectory);
  const normalized = validateAuthorizationDocument(document, bookDirectory);
  const known = new Set(scanned.map((asset) => asset.path));
  for (const entry of normalized.assets) {
    if (!known.has(entry.path)) throw badRequest(`素材授权引用了未扫描到的素材：${entry.path}`);
  }
  const serialized = serializeAuthorization(normalized);
  if (Buffer.byteLength(serialized, "utf8") > AUTHORIZATION_MAX_BYTES) {
    throw new WorkspaceHttpError(413, "素材授权超过 512 KiB 大小限制。");
  }
  const path = authorizationPathFor(project.path);
  const target = await resolveInside(realm, path);
  try {
    const outcome = await realm.fs.writeText(
      target,
      serialized,
      version === null ? { kind: "createIfAbsent" } : { kind: "replaceIfVersion", version: version as FsVersion },
      undefined,
      realm.sandboxPolicy.resolve({ session: realm.agent.session }),
    );
    return { document: normalized, path, version: String(outcome.version) };
  } catch (error) {
    const mapped = mapFsError(error);
    if (version === null && mapped?.status === 412) throw new WorkspaceHttpError(409, "素材授权已存在，请刷新后重试。");
    throw mapped ?? new WorkspaceHttpError(500, "素材授权写入失败。");
  }
}

/**
 * 素材视图：扫描两个素材目录并叠加授权状态。`providers` 在本切片恒为空数组，
 * 素材生成 provider（Task 8）在路由层覆盖；`authorized` 已汇总 license 与用途。
 */
export async function listAudiobookAssets(
  realm: WorkspaceRealm,
  project: AudiobookProjectRecord,
): Promise<AudiobookAssetView> {
  const bookDirectory = bookDirectoryOf(project.path);
  const authorization = await loadAssetAuthorizations(realm, project.path);
  const byPath = new Map((authorization?.document.assets ?? []).map((entry) => [entry.path, entry]));
  const assets: AudiobookAsset[] = (await scanAssets(realm, bookDirectory)).map((scanned) => {
    const entry = byPath.get(scanned.path);
    return { path: scanned.path, kind: scanned.kind, bytes: scanned.bytes, authorized: isAuthorized(entry), license: entry?.license ?? null };
  });
  return { assets, authorizationVersion: authorization?.version ?? null, providers: [] };
}

function cueConflict(cue: AudiobookCue, reason: string): WorkspaceHttpError {
  return new WorkspaceHttpError(409, `cue ${cue.id} ${reason}。`);
}

/**
 * cue 授权闸门：章节脚本缺失、起点片段不存在、素材缺失或未授权一律 409，
 * 错误里带上 cue id 与原因。时间窗口由时间轴（Task 2）计算，这里不碰时序。
 * 校验本身没有 I/O；返回 Promise 让调用方统一 `await` 并复用错误映射。
 */
export function assertCuesAuthorized(
  project: AudiobookProject,
  assets: AudiobookAssetView,
  scripts: ReadonlyMap<string, AudiobookScript>,
): Promise<void> {
  return Promise.resolve().then(() => {
    const byPath = new Map(assets.assets.map((asset) => [asset.path, asset]));
    for (const cue of project.cues) {
      const script = scripts.get(cue.chapter);
      if (script === undefined) throw cueConflict(cue, `引用的章节 ${cue.chapter} 还没有脚本`);
      if (!script.segments.some((segment) => segment.id === cue.startSegment)) {
        throw cueConflict(cue, `起点片段 ${cue.startSegment} 在 ${cue.chapter} 脚本里不存在`);
      }
      const asset = byPath.get(cue.asset);
      if (asset === undefined) throw cueConflict(cue, `引用的素材 ${cue.asset} 不存在`);
      // `authorized` 已包含“条目存在 + license 有效 + allowedUse 含 audiobook”，视图不另暴露 allowedUse。
      if (!asset.authorized) throw cueConflict(cue, `引用的素材 ${cue.asset} 未授权`);
    }
  });
}
