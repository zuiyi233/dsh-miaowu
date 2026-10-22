/**
 * 有声剧（N4-B）领域契约。
 *
 * 只包含类型与常量：项目/脚本/job 的结构、路由、缓存与 job 目录。所有持久化
 * 文档都带 schemaVersion 1；密钥永不落盘——TTS 端点与模型写在项目里，密钥由
 * 宿主环境或运行时注入，项目 JSON 里没有 key 字段。
 */

export const AUDIOBOOK_SCHEMA_VERSION = 1 as const;
export const AUDIOBOOK_ROOT = "有声剧";
export const AUDIOBOOK_CACHE_ROOT = ".oh-story/audiobook/cache";
export const AUDIOBOOK_JOB_ROOT = ".oh-story/audiobook/jobs";
export const AUDIOBOOK_ROUTES = {
  overview: "/oh-story/audiobook",
  project: "/oh-story/audiobook/project",
  script: "/oh-story/audiobook/script",
  jobs: "/oh-story/audiobook/jobs",
  export: "/oh-story/audiobook/export",
  segmentAudio: "/oh-story/audiobook/segment-audio",
} as const;

export type AudiobookProjectKind = "novel";
export type AudiobookJobStatus = "queued" | "running" | "paused" | "failed" | "completed";

/** 仍占用章节的状态：新建与恢复都据此拦截重复计费。 */
export const AUDIOBOOK_ACTIVE_JOB_STATUSES: readonly AudiobookJobStatus[] = ["queued", "running", "paused"];

export interface AudiobookTtsConfig {
  readonly baseUrl: string;
  readonly model: string;
  readonly responseFormat: "mp3" | "wav";
  readonly speed: number;
  readonly pricePerMillionChars: number;
  readonly maxCharsPerChapter: number;
  readonly concurrency: number;
}

export interface AudiobookCastMember {
  readonly id: string;
  readonly name: string;
  readonly kind: "narrator" | "character";
  readonly voice: string;
}

export interface AudiobookCue {
  readonly id: string;
  readonly chapter: string;
  readonly asset: string;
  readonly startSegment: string;
  readonly offsetMs: number;
  readonly fadeInMs: number;
  readonly fadeOutMs: number;
  readonly gainDb: number;
  readonly duckDb: number;
}

export interface AudiobookProject {
  readonly schemaVersion: 1;
  readonly source: { readonly bookRoot: string; readonly chapters: readonly string[] };
  readonly tts: AudiobookTtsConfig;
  readonly cast: readonly AudiobookCastMember[];
  readonly cues: readonly AudiobookCue[];
  readonly export: {
    readonly mp3BitrateKbps: number;
    readonly sampleRate: number;
    readonly channels: number;
    readonly loudnessLufs: number;
    readonly truePeakDbtp: number;
    readonly subtitles: readonly ("srt" | "lrc")[];
  };
  readonly rights: { readonly voiceCloning: false };
}

export interface AudiobookSegment {
  readonly id: string;
  readonly kind: "narration" | "dialogue";
  readonly speakerId: string;
  readonly text: string;
  readonly sourceStart: number;
  readonly sourceEnd: number;
}

export interface AudiobookScript {
  readonly schemaVersion: 1;
  readonly chapter: string;
  readonly sourcePath: string;
  readonly sourceSha256: string;
  readonly segments: readonly AudiobookSegment[];
}

export interface AudiobookScriptRecord {
  readonly script: AudiobookScript;
  readonly path: string;
  readonly version: string;
}

/** 说话人指派的单条补丁：`unknown` 表示清空指派。 */
export interface AudiobookAssignment {
  readonly segmentId: string;
  readonly speakerId: string;
}

/** 重新解析时手工指派的去向：文本与源偏移未变的片段保留，其余重置。 */
export interface AudiobookAssignmentSummary {
  readonly preserved: number;
  readonly dropped: number;
}

/** `POST /oh-story/audiobook/script` 的成功响应；面板与路由共用同一形状。 */
export interface AudiobookScriptParseResponse {
  readonly script: AudiobookScriptRecord;
  readonly assignmentSummary: AudiobookAssignmentSummary;
}

/** `GET/PUT /oh-story/audiobook/script` 的成功响应。 */
export interface AudiobookScriptViewResponse {
  readonly script: AudiobookScriptRecord;
}

export interface AudiobookJob {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly projectPath: string;
  readonly chapter: string;
  readonly sourcePath: string;
  readonly status: AudiobookJobStatus;
  readonly totalSegments: number;
  readonly completedSegments: number;
  readonly failedSegments: readonly { readonly segmentId: string; readonly error: string }[];
  readonly chars: number;
  readonly estimatedCost: number;
  readonly actualRequests: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly outputPath: string | null;
}

export interface AudiobookJobRecord {
  readonly job: AudiobookJob;
  readonly version: string;
}

export interface AudiobookCostEstimate {
  readonly segments: number;
  readonly chars: number;
  readonly cacheHits: number;
  readonly requests: number;
  readonly estimatedCost: number;
}

export interface AudiobookChapterSummary {
  readonly sourcePath: string;
  readonly chapter: string;
  readonly scriptPath: string;
  readonly hasScript: boolean;
  readonly segmentCount: number;
  /** 对白中说话人缺失或已从 cast 删除的段数；大于 0 时整章不能生成/导出。 */
  readonly unassignedSegments: number;
  /** 脚本存在但读取/校验失败时的错误摘要；此时 hasScript 仍为 true、segmentCount 为 0。 */
  readonly scriptError?: string;
  readonly audioPath: string | null;
  readonly jobId: string | null;
  readonly jobStatus: AudiobookJobStatus | null;
}

export interface AudiobookProjectView {
  readonly record: AudiobookProjectRecord;
  readonly chapters: readonly AudiobookChapterSummary[];
  readonly preflight: AudiobookPreflight;
}

export interface AudiobookProjectRecord {
  readonly project: AudiobookProject;
  readonly path: string;
  readonly version: string;
}

export interface AudiobookProjectSummary {
  readonly path: string;
  readonly name: string;
  readonly bookRoot: string;
  readonly chapters: number;
}

export interface AudiobookSource {
  readonly bookRoot: string;
  readonly name: string;
  readonly chapters: readonly string[];
}

export interface AudiobookPreflight {
  readonly ttsKey: "present" | "missing";
  readonly ttsHost: string | null;
  readonly ffmpeg: boolean;
  readonly ffprobe: boolean;
}

export interface AudiobookOverview {
  readonly projects: readonly AudiobookProjectSummary[];
  readonly sources: readonly AudiobookSource[];
  readonly errors: readonly { readonly path: string; readonly message: string }[];
  readonly preflight: AudiobookPreflight;
}

/**
 * 素材与授权（N4-C）：音乐/音效目录、`素材/授权.json` 与素材视图。
 *
 * 所有 `path` 都是**工作区相对路径**（`有声剧/<book>/素材/...`），与 N4-B 的
 * `AudiobookCue.asset` 同一形态。`authorized` 已汇总“有条目 + license 有效
 * （非空且非 `unverified`）+ allowedUse 含 audiobook”，视图不另暴露 allowedUse。
 */
export type AudiobookAssetKind = "music" | "effect";
export type AudiobookAssetUse = "audiobook" | "commercial";

export interface AudiobookAssetProviderReceipt {
  readonly id: string;
  readonly model: string;
  readonly promptSha256: string;
  readonly receiptId: string | null;
  readonly generatedAt: number;
}

export interface AudiobookAssetAuthorization {
  readonly path: string;
  readonly source: string;
  readonly license: string;
  readonly allowedUse: readonly AudiobookAssetUse[];
  readonly attribution: string;
  readonly provider?: AudiobookAssetProviderReceipt;
}

export interface AudiobookAssetAuthorizationDocument {
  readonly schemaVersion: 1;
  readonly assets: readonly AudiobookAssetAuthorization[];
}

export interface AudiobookAuthorizationRecord {
  readonly document: AudiobookAssetAuthorizationDocument;
  readonly path: string;
  readonly version: string;
}

export interface AudiobookAsset {
  readonly path: string;
  readonly kind: AudiobookAssetKind;
  readonly bytes: number;
  readonly authorized: boolean;
  readonly license: string | null;
}

export interface AudiobookAssetView {
  readonly assets: readonly AudiobookAsset[];
  readonly authorizationVersion: string | null;
  readonly providers: readonly { readonly id: string; readonly label: string; readonly configured: boolean }[];
}

/**
 * 发布清单（N4-C）：`有声剧/<book>/发布/发布清单.json` 的结构。
 *
 * `files[].path` 是**包内相对路径**（`发布/...`），不是工作区相对路径；清单本身
 * 落在 `发布/发布清单.json`，所以包内路径与工作区路径只差 `有声剧/<book>/` 前缀。
 * `checksum` 是按路径排序后对 `path\0sha256` 逐行拼接再取 sha256 的结果，可本地
 * 复算；`cast` 只保留 id/name/voice，`providerReceipts` 不含密钥与完整 URL。
 */
export interface AudiobookManifestFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly durationMs: number | null;
}

export interface AudiobookManifestChapter {
  readonly index: number;
  readonly title: string;
  readonly audio: string | null;
  readonly subtitles: readonly string[];
}

export interface AudiobookManifestCastMember {
  readonly id: string;
  readonly name: string;
  readonly voice: string;
}

export interface AudiobookManifestLicense {
  readonly path: string;
  readonly license: string;
  readonly attribution: string;
}

export interface AudiobookManifest {
  readonly schemaVersion: 1;
  readonly generatedAt: number;
  readonly book: string;
  readonly projectVersion: string;
  readonly files: readonly AudiobookManifestFile[];
  readonly chapters: readonly AudiobookManifestChapter[];
  readonly cast: readonly AudiobookManifestCastMember[];
  readonly licenses: readonly AudiobookManifestLicense[];
  readonly providerReceipts: readonly AudiobookAssetProviderReceipt[];
  readonly cost: { readonly chars: number; readonly requests: number; readonly estimatedCost: number };
  readonly checksum: string;
}
