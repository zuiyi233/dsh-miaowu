import { createHash, randomUUID } from "node:crypto";
import type { FsTarget } from "@deepseek-ai/dsh-fs";
import { WorkspaceHttpError, type WorkspaceRealm } from "../workspace-route.js";
import type { BinaryFileStore } from "./audiobook-binary.js";
import {
  AUDIOBOOK_CACHE_ROOT,
  AUDIOBOOK_SCHEMA_VERSION,
  type AudiobookCostEstimate,
  type AudiobookProject,
  type AudiobookScript,
} from "./audiobook-contract.js";

/**
 * 有声剧内容寻址缓存与成本预估。
 *
 * 缓存目录固定 `.oh-story/audiobook/cache/<sha256>/{audio.mp3|wav,meta.json}`：
 * 键只取 TTS 请求的可复现字段（端点去尾斜杠、模型、音色、语速、格式、文本），
 * 不含密钥、时间戳、主机名明文或本机路径，所以同一请求在不同机器/时间都命中
 * 同一个键；meta 只记录请求参数、字节数、字符数、文本哈希与创建时间，永不落
 * 全文或密钥。读写前先把键校验成 64 位小写十六进制，再用 `realm.fs.resolve`
 * 与 `contains` 确认目标仍在缓存目录内，越级输入一律 403。
 */

export type CachedAudioExtension = "mp3" | "wav";

export type { AudiobookCostEstimate } from "./audiobook-contract.js";

export interface TtsCacheKeyInput {
  readonly baseUrl: string;
  readonly model: string;
  readonly voice: string;
  readonly speed: number;
  readonly responseFormat: CachedAudioExtension;
  readonly text: string;
}

/** 写入 meta 时调用方提供的请求字段；`text` 只用于推导字符数与哈希。 */
export interface CachedSegmentMetaInput {
  readonly model: string;
  readonly voice: string;
  readonly responseFormat?: CachedAudioExtension;
  readonly speed?: number;
  readonly text?: string;
  /** 冗余校验字段；实际落盘字节数始终取传入音频的实测长度。 */
  readonly bytes?: number;
  readonly createdAt?: number;
}

/** 落盘 meta 文档：schemaVersion 1，只含请求参数与摘要，不含全文/密钥。 */
export interface CachedSegmentMeta {
  readonly schemaVersion: 1;
  readonly model: string;
  readonly voice: string;
  readonly responseFormat: CachedAudioExtension;
  readonly speed: number;
  readonly bytes: number;
  readonly chars: number;
  readonly textSha256: string;
  readonly createdAt: number;
}

const CACHE_KEY_PATTERN = /^[0-9a-f]{64}$/u;
/** 与工作台音频路由一致的读取上限（50 MiB）；超出按未命中处理。 */
const SEGMENT_AUDIO_MAX_BYTES = 50 * 1_024 * 1_024;
const DEFAULT_SPEED = 1;

/** 内容寻址键：sha256(JSON [去尾斜杠端点, 模型, 音色, 语速, 格式, 文本])。 */
export function ttsCacheKey(input: TtsCacheKeyInput): string {
  const base = input.baseUrl.replace(/\/+$/u, "");
  return createHash("sha256")
    .update(JSON.stringify([base, input.model, input.voice, input.speed, input.responseFormat, input.text]), "utf8")
    .digest("hex");
}

export function segmentAudioPath(key: string, ext: CachedAudioExtension): string {
  return `${AUDIOBOOK_CACHE_ROOT}/${key}/audio.${ext}`;
}

export function segmentMetaPath(key: string): string {
  return `${AUDIOBOOK_CACHE_ROOT}/${key}/meta.json`;
}

function cacheKeyOrThrow(key: string): string {
  if (!CACHE_KEY_PATTERN.test(key)) throw new WorkspaceHttpError(403, "缓存键无效。");
  return key;
}

function extensionOrThrow(ext: CachedAudioExtension): CachedAudioExtension {
  if (ext !== "mp3" && ext !== "wav") throw new WorkspaceHttpError(400, "不支持的音频格式。");
  return ext;
}

/** 解析目标并确认它仍在缓存根内；缓存根本身也必须留在工作区。 */
async function cacheTarget(realm: WorkspaceRealm, path: string): Promise<FsTarget> {
  const cacheRoot = await realm.fs.resolve(AUDIOBOOK_CACHE_ROOT, { cwd: realm.cwd });
  if (!realm.fs.contains(realm.root, cacheRoot)) throw new WorkspaceHttpError(403, "缓存目录离开了 DSH 工作目录。");
  const target = await realm.fs.resolve(path, { cwd: realm.cwd });
  if (!realm.fs.contains(cacheRoot, target)) throw new WorkspaceHttpError(403, "缓存路径离开了缓存目录。");
  return target;
}

/** 读取缓存音频；键非法/越级 403，文件缺失或超过读取上限返回 undefined。 */
export async function readCachedSegment(
  realm: WorkspaceRealm,
  binary: BinaryFileStore,
  key: string,
  ext: CachedAudioExtension,
): Promise<Uint8Array | undefined> {
  const cacheKey = cacheKeyOrThrow(key);
  const extension = extensionOrThrow(ext);
  const target = await cacheTarget(realm, segmentAudioPath(cacheKey, extension));
  return await binary.read(target, SEGMENT_AUDIO_MAX_BYTES);
}

/**
 * 写入缓存音频与 meta：音频先写同目录下的唯一临时文件（`audio.<ext>.tmp-<uuid>`）
 * 再改名到最终路径，避免半截文件被当成永久缓存命中；失败时删除临时文件并抛出。
 * 随后写 meta，meta 写入沿用工作台其他写路径的沙箱策略；meta 里的字节数取实测
 * 长度，文本只留 sha256 与字符数。
 */
export async function writeCachedSegment(
  realm: WorkspaceRealm,
  binary: BinaryFileStore,
  key: string,
  ext: CachedAudioExtension,
  bytes: Uint8Array,
  meta: CachedSegmentMetaInput,
): Promise<void> {
  const cacheKey = cacheKeyOrThrow(key);
  const extension = extensionOrThrow(ext);
  if (meta.bytes !== undefined && meta.bytes !== bytes.byteLength) {
    throw new WorkspaceHttpError(422, "缓存元数据字节数与音频不一致。");
  }
  const audioPath = segmentAudioPath(cacheKey, extension);
  const audioTarget = await cacheTarget(realm, audioPath);
  const tempTarget = await cacheTarget(realm, `${audioPath}.tmp-${randomUUID()}`);
  const metaTarget = await cacheTarget(realm, segmentMetaPath(cacheKey));
  const text = meta.text ?? "";
  const document: CachedSegmentMeta = {
    schemaVersion: AUDIOBOOK_SCHEMA_VERSION,
    model: meta.model,
    voice: meta.voice,
    responseFormat: meta.responseFormat ?? extension,
    speed: meta.speed ?? DEFAULT_SPEED,
    bytes: bytes.byteLength,
    chars: text.length,
    textSha256: createHash("sha256").update(text, "utf8").digest("hex"),
    createdAt: meta.createdAt ?? Date.now(),
  };
  try {
    await binary.prepare(tempTarget);
    await binary.write(tempTarget, bytes);
    await binary.rename(tempTarget, audioTarget);
  } catch (error) {
    await binary.remove(tempTarget).catch(() => undefined);
    throw error;
  }
  await realm.fs.writeText(
    metaTarget,
    `${JSON.stringify(document, undefined, 2)}\n`,
    undefined,
    undefined,
    realm.sandboxPolicy.resolve({ session: realm.agent.session }),
  );
}

function roundCost(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/**
 * 章节成本预估：调用方为每段提供解析后的音色（N4-B 起旁白与角色可能不同），
 * 总字符数是整章文本量，计费只算未命中的片段，预估成本 = 未命中字符 / 100 万
 * * 单价，保留 6 位小数。未指派的片段由调用方在进入本函数前拦住。
 */
export function planChapterCost(
  project: AudiobookProject,
  script: AudiobookScript,
  cached: ReadonlySet<string>,
  voiceFor: (segment: AudiobookScript["segments"][number]) => string,
): AudiobookCostEstimate {
  let chars = 0;
  let billableChars = 0;
  let cacheHits = 0;
  for (const segment of script.segments) {
    chars += segment.text.length;
    const key = ttsCacheKey({
      baseUrl: project.tts.baseUrl,
      model: project.tts.model,
      voice: voiceFor(segment),
      speed: project.tts.speed,
      responseFormat: project.tts.responseFormat,
      text: segment.text,
    });
    if (cached.has(key)) cacheHits += 1;
    else billableChars += segment.text.length;
  }
  return {
    segments: script.segments.length,
    chars,
    cacheHits,
    requests: script.segments.length - cacheHits,
    estimatedCost: roundCost(billableChars / 1_000_000 * project.tts.pricePerMillionChars),
  };
}
