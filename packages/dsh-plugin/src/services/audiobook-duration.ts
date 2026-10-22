import type { FsTarget } from "@deepseek-ai/dsh-fs";
import { mapFsError, readVersionedFile, WorkspaceHttpError, type WorkspaceRealm } from "../workspace-route.js";
import type { BinaryFileStore } from "./audiobook-binary.js";
import { segmentAudioPath, type CachedAudioExtension } from "./audiobook-cache.js";
import { AUDIOBOOK_CACHE_ROOT, AUDIOBOOK_SCHEMA_VERSION } from "./audiobook-contract.js";
import type { CommandResult, CommandRunner } from "./audiobook-export.js";

/**
 * 有声剧实测时长（N4-C）：ffprobe 探测片段/素材时长并落盘 `.oh-story/audiobook/durations/`。
 *
 * 时长缓存与内容寻址音频缓存分开：音频缓存键是 TTS 请求哈希，时长文档只按同一
 * 缓存键存 `{ schemaVersion, cacheKey, durationMs, probedAt }`，第二次导出直接命中，
 * 不再为同一片段重复起 ffprobe 进程。缓存损坏（坏 JSON、schemaVersion/cacheKey
 * 不符、时长非有限或为负）按未命中处理并重新探测，不向客户端抛 422；重新探测
 * 失败也不写缓存，坏文件不会被半截结果覆盖。ffprobe 只接收固定参数数组，不经
 * shell，错误文本不包含进程路径。素材时长（`measureAudioDuration`）直接探测目标
 * 文件，不写缓存。
 */

/** 时长缓存目录：与音频缓存同属 `.oh-story/audiobook/`，但按缓存键单文件存放。 */
export const AUDIOBOOK_DURATION_ROOT = ".oh-story/audiobook/durations";

const DURATION_KEY_PATTERN = /^[0-9a-f]{64}$/u;
const DURATION_MAX_BYTES = 64 * 1_024;
const FFPROBE_TIMEOUT_MS = 30_000;
/** 固定参数（不含路径）：`ffprobe -v error -show_entries format=duration ...`。 */
const FFPROBE_ARGUMENTS: readonly string[] = [
  "-v", "error",
  "-show_entries", "format=duration",
  "-of", "default=noprint_wrappers=1:nokey=1",
];

/** 时长探测只需要二进制存储与命令执行，与导出运行时同形。 */
export interface AudiobookDurationRuntime {
  readonly binary: BinaryFileStore;
  readonly runner: CommandRunner;
}

/** 落盘文档：schemaVersion 1，只含缓存键、毫秒时长与探测时间。 */
export interface CachedSegmentDuration {
  readonly schemaVersion: typeof AUDIOBOOK_SCHEMA_VERSION;
  readonly cacheKey: string;
  readonly durationMs: number;
  readonly probedAt: number;
}

function cacheKeyOrThrow(key: string): string {
  // 与音频缓存一致：键必须恰好是 64 位小写十六进制，否则视为非法请求而非未命中。
  if (!DURATION_KEY_PATTERN.test(key)) throw new WorkspaceHttpError(400, "缓存键无效。");
  return key;
}

function extensionOrThrow(ext: CachedAudioExtension): CachedAudioExtension {
  if (ext !== "mp3" && ext !== "wav") throw new WorkspaceHttpError(400, "不支持的音频格式。");
  return ext;
}

/** 解析时长文档目标并确认它仍在时长缓存根内；缓存根本身也必须留在工作区。 */
async function durationTarget(realm: WorkspaceRealm, key: string): Promise<FsTarget> {
  const root = await realm.fs.resolve(AUDIOBOOK_DURATION_ROOT, { cwd: realm.cwd });
  if (!realm.fs.contains(realm.root, root)) throw new WorkspaceHttpError(403, "时长缓存目录离开了 DSH 工作目录。");
  const target = await realm.fs.resolve(`${AUDIOBOOK_DURATION_ROOT}/${key}.json`, { cwd: realm.cwd });
  if (!realm.fs.contains(root, target)) throw new WorkspaceHttpError(403, "时长缓存路径离开了缓存目录。");
  return target;
}

/** 解析片段音频目标并确认它仍在音频缓存根内。 */
async function segmentTarget(realm: WorkspaceRealm, key: string, ext: CachedAudioExtension): Promise<FsTarget> {
  const cacheRoot = await realm.fs.resolve(AUDIOBOOK_CACHE_ROOT, { cwd: realm.cwd });
  if (!realm.fs.contains(realm.root, cacheRoot)) throw new WorkspaceHttpError(403, "有声剧缓存目录离开了 DSH 工作目录。");
  const target = await realm.fs.resolve(segmentAudioPath(key, ext), { cwd: realm.cwd });
  if (!realm.fs.contains(cacheRoot, target)) throw new WorkspaceHttpError(403, "有声剧缓存路径离开了缓存目录。");
  return target;
}

/** 缓存文件本身不可用（缺失、非文本、超限、读取冲突）都按未命中处理，重新探测。 */
function isUnusableCacheRead(error: unknown): boolean {
  const status = mapFsError(error)?.status ?? (error instanceof WorkspaceHttpError ? error.status : undefined);
  return status === 404 || status === 412 || status === 413 || status === 415;
}

/** 解析缓存文档；形状、schemaVersion、键或时长不合法都返回 undefined（未命中）。 */
function parseCachedDuration(content: string, key: string): number | undefined {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Readonly<Record<string, unknown>>;
  if (record["schemaVersion"] !== AUDIOBOOK_SCHEMA_VERSION) return undefined;
  if (record["cacheKey"] !== key) return undefined;
  const durationMs = record["durationMs"];
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) return undefined;
  return Math.round(durationMs);
}

/** 读时长缓存：只有合法文档才返回毫秒；缺失或损坏一律 undefined。 */
async function readCachedDuration(realm: WorkspaceRealm, key: string): Promise<number | undefined> {
  const target = await durationTarget(realm, key);
  let content: string;
  try {
    content = (await readVersionedFile(realm.fs, target, DURATION_MAX_BYTES)).content;
  } catch (error) {
    if (isUnusableCacheRead(error)) return undefined;
    throw mapFsError(error) ?? error;
  }
  return parseCachedDuration(content, key);
}

/**
 * 写时长缓存：`createIfAbsent` 加沙箱策略，并发写冲突时以磁盘上的已有值为准；
 * 已有值仍不合法则 500，不覆盖别人的文件。只在探测成功后调用。
 */
async function writeCachedDuration(realm: WorkspaceRealm, key: string, durationMs: number): Promise<number> {
  const target = await durationTarget(realm, key);
  const document: CachedSegmentDuration = {
    schemaVersion: AUDIOBOOK_SCHEMA_VERSION,
    cacheKey: key,
    durationMs: Math.round(durationMs),
    probedAt: Date.now(),
  };
  try {
    await realm.fs.writeText(
      target,
      `${JSON.stringify(document, undefined, 2)}\n`,
      { kind: "createIfAbsent" },
      undefined,
      realm.sandboxPolicy.resolve({ session: realm.agent.session }),
    );
    return document.durationMs;
  } catch (error) {
    const mapped = mapFsError(error);
    if (mapped?.status !== 412) throw mapped ?? error;
    const existing = await readCachedDuration(realm, key);
    if (existing === undefined) throw new WorkspaceHttpError(500, "时长缓存写入冲突，且已有缓存不可用。");
    return existing;
  }
}

/**
 * 用 ffprobe 读目标时长：固定参数数组、不经 shell、带 30 秒超时；退出码非 0、
 * 输出不可解析或为负都返回 500，错误文本不含绝对路径。
 */
async function probeDuration(runtime: AudiobookDurationRuntime, target: FsTarget): Promise<number> {
  const argumentsList = [...FFPROBE_ARGUMENTS, runtime.binary.processPath(target)];
  let result: CommandResult;
  try {
    result = await runtime.runner.run("ffprobe", argumentsList, { timeoutMs: FFPROBE_TIMEOUT_MS });
  } catch {
    throw new WorkspaceHttpError(500, "ffprobe 无法执行，读取音频时长失败。");
  }
  const seconds = Number.parseFloat(result.stdout.trim());
  if (result.code !== 0 || !Number.isFinite(seconds) || seconds < 0) {
    throw new WorkspaceHttpError(500, "ffprobe 无法读取音频时长。");
  }
  return Math.round(seconds * 1000);
}

/**
 * 片段实测时长：优先读 `.oh-story/audiobook/durations/<cacheKey>.json`，未命中才
 * 探测缓存音频并写回。缓存音频缺失或为空返回 409（还没有生成完整），探测失败
 * 返回 500 且不落盘。返回值是四舍五入后的毫秒。
 */
export async function measureCachedSegmentDuration(
  realm: WorkspaceRealm,
  runtime: AudiobookDurationRuntime,
  cacheKey: string,
  ext: CachedAudioExtension,
): Promise<number> {
  const key = cacheKeyOrThrow(cacheKey);
  const extension = extensionOrThrow(ext);
  const cached = await readCachedDuration(realm, key);
  if (cached !== undefined) return cached;
  const target = await segmentTarget(realm, key, extension);
  const info = await runtime.binary.stat(target);
  if (info === undefined || info.size <= 0) throw new WorkspaceHttpError(409, "片段音频还没有生成完整。");
  const durationMs = await probeDuration(runtime, target);
  return await writeCachedDuration(realm, key, durationMs);
}

/**
 * 素材实测时长：直接探测给定目标（调用方已解析到工作区内），不读也不写时长缓存。
 * 目标缺失或为空返回 409，探测失败返回 500，返回四舍五入后的毫秒。
 */
export async function measureAudioDuration(
  runtime: AudiobookDurationRuntime,
  realm: WorkspaceRealm,
  target: FsTarget,
): Promise<number> {
  if (!realm.fs.contains(realm.root, target)) throw new WorkspaceHttpError(403, "音频路径离开了 DSH 工作目录。");
  const info = await runtime.binary.stat(target);
  if (info === undefined || info.size <= 0) throw new WorkspaceHttpError(409, "音频文件不存在或为空。");
  return await probeDuration(runtime, target);
}
