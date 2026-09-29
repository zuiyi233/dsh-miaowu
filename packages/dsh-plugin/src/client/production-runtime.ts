export type ProductionJobKind = "image" | "video" | "composition" | "music";
export type ProductionJobStatus = "awaiting_confirmation" | "pending" | "running" | "dispatched_unknown" | "succeeded" | "failed" | "canceled";

export interface ProductionMediaVersion {
  readonly id: string;
  readonly targetId: string;
  readonly kind: "image" | "video" | "audio";
  readonly url: string;
  /** Workspace-relative path when the result is owned by the DSH FileSystem. */
  readonly path?: string | undefined;
}

export interface ProductionJob {
  readonly id: string;
  readonly targetId: string;
  readonly kind: ProductionJobKind;
  readonly status: ProductionJobStatus;
  readonly progress: number;
  readonly prompt: string;
  readonly error?: string | undefined;
  readonly output?: ProductionMediaVersion | undefined;
  /**
   * prepare 声明的产出文件名(工作区相对路径或裸文件名):待确认态的关联提示用它
   * 按 mediaVersionMatchesJob 的 token 语义检查 job ID;成功关联后由 versions 承载,不再依赖它。
   */
  readonly outputs?: readonly string[] | undefined;
  readonly expectedOutputs: number;
  readonly completedOutputs: number;
  /**
   * Deliverable whose name the job cannot influence. Drama Skills 0.7 renders the
   * assembled cut to a fixed path, so it carries no job id to correlate on.
   */
  readonly outputPath?: string | undefined;
  /** Versions already at `outputPath` when the job was dispatched, so an earlier cut never completes it. */
  readonly supersededOutputIds?: readonly string[] | undefined;
}

export interface ProductionSequenceItem {
  readonly shotId: string;
  readonly versionId?: string | undefined;
}

import type { DramaShotAudio } from "./drama-production.js";

export interface PlaybackShot {
  readonly shotId: string;
  readonly index: number;
  readonly title: string;
  /** Dialogue/action line shown under the media; sourced from existing storyboard fields. */
  readonly caption?: string | undefined;
  readonly promptSummary?: string | undefined;
  readonly image?: ProductionMediaVersion | undefined;
  readonly video?: ProductionMediaVersion | undefined;
  /**
   * Per-shot dialogue dubbing from 剧集/<EP>/配音/ (resolveDramaShotAudios);
   * the player renders the first track under the stage for image/placeholder
   * shots and skips it on video shots (the video's own sound wins).
   */
  readonly audio?: readonly DramaShotAudio[] | undefined;
}

export interface PlaybackShotSource {
  readonly id: string;
  readonly title: string;
  readonly purpose?: string | undefined;
  readonly shotSpec?: string | undefined;
  readonly start?: string | undefined;
  readonly end?: string | undefined;
  readonly keyframePrompt?: string | undefined;
  readonly motionPrompt?: string | undefined;
  /** Dubbing passthrough from resolveDramaShotAudios; empty stays empty. */
  readonly audio?: readonly DramaShotAudio[] | undefined;
}

export type PlaybackAdvanceReason = "next" | "prev" | "image-timer" | "video-ended";

export interface CanvasPoint {
  readonly x: number;
  readonly y: number;
}

export interface ProductionQueueEntry {
  readonly id: string;
  readonly preview: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * DSH Queue rows from the host `inbox` projection's `next-turn` list. DSH 0.1.7 removed
 * `SessionSnapshot.queue`; reading it threw and blanked the whole workbench (#50). The
 * projection is wire JSON and absent without agent-loop, so every row is checked rather than
 * trusted. Like DSH's own QueueDock, a row whose prompt RPC already has a transcript echo is
 * a turn being claimed, not a queued one. The preview is the row's full text: the job-id label
 * is matched against it, and the old 200-character preview could cut that label off.
 */
export function productionQueueFromInbox(rows: unknown, claimedRequestIds: ReadonlySet<string> = new Set()): ProductionQueueEntry[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    const item = record(row);
    if (item === undefined || typeof item.id !== "string" || !Array.isArray(item.content)) return [];
    const source = record(item.source);
    if (source?.kind === "user" && typeof source.rpcId === "string" && claimedRequestIds.has(source.rpcId)) return [];
    const preview = item.content.flatMap((block) => {
      const value = record(block);
      return value?.type === "text" && typeof value.text === "string" ? [value.text] : [];
    }).join(" ");
    return [{ id: item.id, preview }];
  });
}

export function createPendingJob(input: {
  readonly id: string;
  readonly targetId: string;
  readonly kind: ProductionJobKind;
  readonly prompt: string;
  readonly expectedOutputs?: number | undefined;
  readonly outputs?: readonly string[] | undefined;
  readonly outputPath?: string | undefined;
  readonly supersededOutputIds?: readonly string[] | undefined;
}): ProductionJob {
  // 有 outputs 时数量以列表长度为准(expectedOutputs 的 Agent 传值/旧值都不再覆盖它)。
  const declared = input.outputs?.filter((name) => name.trim() !== "");
  const expectedOutputs = declared !== undefined && declared.length > 0
    ? declared.length
    : Math.max(1, Math.floor(input.expectedOutputs ?? 1));
  return {
    id: input.id,
    targetId: input.targetId,
    kind: input.kind,
    status: "pending",
    progress: 0,
    prompt: input.prompt,
    ...(declared === undefined || declared.length === 0 ? {} : { outputs: declared }),
    expectedOutputs,
    completedOutputs: 0,
    outputPath: input.outputPath,
    supersededOutputIds: input.supersededOutputIds
  };
}

export function selectedVersionForTarget(
  targetId: string,
  versions: readonly ProductionMediaVersion[],
  selections: Readonly<Record<string, string>>,
  kind?: ProductionMediaVersion["kind"]
): ProductionMediaVersion | undefined {
  const candidates = versions.filter((version) => version.targetId === targetId && (kind === undefined || version.kind === kind));
  return candidates.find((version) => version.id === selections[targetId]) ?? candidates.at(-1);
}

/**
 * Upstream's edit stage owns what it writes under 制作成果/成片/ — the cut, its segments, and clips
 * normalised into 成片/规格统一/ — so none of it is a new version of a shot or asset, even when a
 * filename carries that shot's or MOTION's ID.
 */
const EDIT_OUTPUT_DIRECTORY = /(?:^|\/)制作成果\/成片\//u;

export function mediaTargetFromPath(path: string, knownTargets: readonly string[]): string | undefined {
  if (EDIT_OUTPUT_DIRECTORY.test(path)) return undefined;
  const upper = path.toLocaleUpperCase();
  const segments = upper.split("/");
  const filename = segments.at(-1) ?? "";
  return [...knownTargets].sort((left, right) => right.length - left.length).find((target) => {
    const canonical = target.toLocaleUpperCase();
    return segments.includes(canonical)
      || filename === canonical
      || filename.startsWith(`${canonical}.`)
      || filename.startsWith(`${canonical}-`);
  });
}

export function mediaVersionMatchesJob(version: ProductionMediaVersion, jobId: string): boolean {
  if (version.path === undefined || jobId.trim() === "") return false;
  const escaped = jobId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const basename = version.path.split("/").at(-1) ?? "";
  return new RegExp(`(?:^|[-_.])${escaped}(?:[-_.]|$)`, "u").test(basename);
}

export function outputsForJob(job: ProductionJob, versions: readonly ProductionMediaVersion[]): ProductionMediaVersion[] {
  if (job.outputPath === undefined) return versions.filter((version) => mediaVersionMatchesJob(version, job.id));
  const superseded = new Set(job.supersededOutputIds ?? []);
  return versions.filter((version) => version.path === job.outputPath && !superseded.has(version.id));
}

/**
 * True while a composition the creator already dispatched has not settled. Every composition
 * for an episode renders to the same upstream path, so a second one dispatched now would be
 * completed by the first one's cut — and, once marked succeeded, could no longer be removed
 * from the DSH Queue.
 */
export function compositionInFlight(jobs: readonly ProductionJob[]): boolean {
  return jobs.some((job) => job.kind === "composition"
    && (job.status === "awaiting_confirmation" || job.status === "pending" || job.status === "running"));
}

/**
 * A composition whose Turn ended without a cut stays dispatched_unknown so a late cut can still
 * complete it, and compositionInFlight lets the creator compose again. Both render to the same
 * upstream path, so once a new composition is dispatched its cut would complete the old job too.
 * Fail the old one instead, keeping the check findings its error already reports.
 */
export function settleSupersededCompositions(jobs: readonly ProductionJob[], next: ProductionJob): ProductionJob[] {
  if (next.kind !== "composition") return [...jobs];
  return jobs.map((job) => (
    job.id !== next.id
    && job.kind === "composition"
    && job.status === "dispatched_unknown"
    && (job.targetId === next.targetId || (job.outputPath !== undefined && job.outputPath === next.outputPath))
      ? { ...job, status: "failed" }
      : job
  ));
}

export function referencesForTarget(
  targetId: string,
  production: { readonly shots: readonly { readonly id: string; readonly references: readonly string[] }[] },
  versions: readonly ProductionMediaVersion[],
  selections: Readonly<Record<string, string>>,
  libraryVersions: readonly ProductionMediaVersion[] = versions,
  manualReferences: Readonly<Record<string, readonly string[]>> = {}
): ProductionMediaVersion[] {
  const shot = production.shots.find((item) => item.id === targetId);
  if (shot === undefined) return [];
  const declared = shot.references.flatMap((id) => {
    const version = selectedVersionForTarget(id, versions, selections, "image");
    return version === undefined ? [] : [version];
  });
  const manual = (manualReferences[targetId] ?? []).flatMap((id) => {
    const version = libraryVersions.find((item) => item.id === id && item.kind === "image");
    return version === undefined ? [] : [version];
  });
  return [...new Map([...declared, ...manual].map((version) => [version.id, version])).values()];
}

export function queuedItemForJob(jobId: string, queue: readonly ProductionQueueEntry[]): ProductionQueueEntry | undefined {
  if (jobId.trim() === "") return undefined;
  const escaped = jobId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  // The prompts label the id as 「任务 ID：<id>」 / 「批次任务 ID：<id>」. Anchor on that label so an
  // id merely quoted inside another job's output paths cannot mark this job as queued.
  const labelled = new RegExp(`任务\\s*ID\\s*[：:]\\s*${escaped}(?:[\\s.,;、。]|$)`, "u");
  return queue.find((item) => labelled.test(item.preview));
}

export function activeProductionJobId(
  jobs: readonly ProductionJob[],
  queue: readonly ProductionQueueEntry[],
  sessionRunning: boolean
): string | undefined {
  if (!sessionRunning) return undefined;
  return [...jobs].reverse().find((job) => (
    (job.status === "awaiting_confirmation" || job.status === "pending" || job.status === "running")
    && queuedItemForJob(job.id, queue) === undefined
  ))?.id;
}

/** Reconcile the lightweight Session projection against DSH Queue/Turn state and real workspace outputs. */
export function reconcileProductionJobs(
  jobs: readonly ProductionJob[],
  queue: readonly ProductionQueueEntry[],
  sessionRunning: boolean,
  versions: readonly ProductionMediaVersion[]
): ProductionJob[] {
  const latestPending = [...jobs].reverse().find((job) => (
    job.status === "pending" && queuedItemForJob(job.id, queue) === undefined
  ));

  // Retire an unfinished composition only once a newer one actually runs, and before outputs are
  // matched, so the newer cut cannot complete it. A dispatch that fails or is withdrawn from the
  // Queue leaves the older one to be finished in Chat.
  const settleCompositions = (list: readonly ProductionJob[]): ProductionJob[] => list
    .filter((job) => job.kind === "composition" && job.status === "running")
    .reduce((current, running) => settleSupersededCompositions(current, running), [...list]);
  const reconciled = settleCompositions(jobs).map((job): ProductionJob => {
    const queued = queuedItemForJob(job.id, queue) !== undefined;
    // A terminal job is never revived by a result that arrived later. This matters most for
    // `outputPath`: a shared deliverable name carries no job identity, so without this guard
    // the next cut would complete a job the creator canceled, and bury the error a failed one
    // reported. A job-id correlated failure keeps its old behaviour — that output really is its own.
    if (job.status === "canceled" || job.status === "succeeded") return job;
    if (job.status === "failed" && job.outputPath !== undefined) return job;
    const outputs = outputsForJob(job, versions);

    if (outputs.length >= job.expectedOutputs) {
      return {
        ...job,
        status: "succeeded",
        progress: 100,
        completedOutputs: outputs.length,
        output: outputs[0],
        error: undefined
      };
    }
    if (job.status === "awaiting_confirmation" && outputs.length === 0) return job;
    if (job.status === "running" && queued) return { ...job, status: "pending", progress: 0 };
    if (job.status === "pending" && sessionRunning && !queued && job === latestPending) {
      return { ...job, status: "running", progress: Math.max(10, job.progress), error: undefined };
    }
    if (!sessionRunning && !queued && (job.status === "running" || job.status === "dispatched_unknown")) {
      return {
        ...job,
        status: "dispatched_unknown",
        progress: Math.round(outputs.length / job.expectedOutputs * 100),
        completedOutputs: outputs.length,
        // Assembly is local ffmpeg, so nothing was billed: a missing cut usually means edit_tool
        // check blocked the render, and those findings — not a billing warning — are what to show.
        error: outputs.length > 0
          ? `DSH Turn 已结束，已发现 ${String(outputs.length)}/${String(job.expectedOutputs)} 项成果；请刷新核对剩余输出。`
          : job.kind === "composition"
            ? "成片未生成：请在 Chat 查看 edit_tool check 的阻断项（未采用镜头理由、画幅/帧率不一致等），修正后再合成。"
            : "DSH Turn 已结束，尚未发现关联成果。任务可能已派发，请先刷新成果，避免重复计费。"
      };
    }
    if (outputs.length > 0) {
      return {
        ...job,
        status: job.status === "failed" ? "failed" : "running",
        progress: Math.max(10, Math.round(outputs.length / job.expectedOutputs * 100)),
        completedOutputs: outputs.length,
        error: job.status === "failed" ? job.error : undefined
      };
    }
    return job;
  });
  return settleCompositions(reconciled);
}

export function reconcileSequence(
  shotIds: readonly string[],
  current: readonly ProductionSequenceItem[],
  versions: readonly ProductionMediaVersion[],
  selections: Readonly<Record<string, string>>
): ProductionSequenceItem[] {
  const shotSet = new Set(shotIds);
  const preserved = current.filter((item) => shotSet.has(item.shotId));
  const present = new Set(preserved.map((item) => item.shotId));
  const appended = shotIds.filter((shotId) => !present.has(shotId)).map((shotId) => ({ shotId }));
  return [...preserved, ...appended].map((item) => ({
    shotId: item.shotId,
    versionId: selectedVersionForTarget(item.shotId, versions, selections, "video")?.id
  }));
}

export function sequenceIssues(sequence: readonly ProductionSequenceItem[], versions: readonly ProductionMediaVersion[]): string[] {
  const versionById = new Map(versions.map((version) => [version.id, version]));
  const issues: string[] = [];
  for (const item of sequence) {
    const version = item.versionId === undefined ? undefined : versionById.get(item.versionId);
    if (version === undefined || version.kind !== "video") issues.push(`${item.shotId} 缺少已选视频版本`);
    else if (version.path === undefined) issues.push(`${item.shotId} 的视频没有可供 DSH 读取的工作区路径`);
  }
  return issues;
}

export function reorderSequence(sequence: readonly ProductionSequenceItem[], source: number, target: number): ProductionSequenceItem[] {
  if (!Number.isInteger(source) || !Number.isInteger(target)) return [...sequence];
  if (source < 0 || target < 0 || source >= sequence.length || target >= sequence.length || source === target) return [...sequence];
  const next = [...sequence];
  const [item] = next.splice(source, 1);
  if (item !== undefined) next.splice(target, 0, item);
  return next;
}

export type PlaybackTakeKind = "image" | "video";

export interface PlaybackTakeGroup {
  readonly kind: PlaybackTakeKind;
  readonly versions: readonly ProductionMediaVersion[];
  readonly selectedId: string | undefined;
}

/**
 * Group same-shot takes by media kind for the 串播 take switcher. Pure
 * grouping over the passed EP-scoped version list; selection marking reuses
 * `selectedVersionForTarget` (explicit pick wins, otherwise latest). Callers
 * hide groups with fewer than two takes.
 */
export function playbackTakeGroups(
  targetId: string,
  versions: readonly ProductionMediaVersion[],
  selections: Readonly<Record<string, string>>
): readonly PlaybackTakeGroup[] {
  const kinds: readonly PlaybackTakeKind[] = ["image", "video"];
  return kinds.map((kind) => ({
    kind,
    versions: versions.filter((version) => version.targetId === targetId && version.kind === kind),
    selectedId: selectedVersionForTarget(targetId, versions, selections, kind)?.id
  }));
}

/**
 * Assemble one playback entry per shot, in document order. Media resolution
 * reuses the same rule as the 镜头 board (`selectedVersionForTarget`, latest
 * wins unless the user picked a version): index.tsx already scoped `versions`
 * to this EP via `mediaTargetFromPath` + episode/交付 prefix match, so this
 * function only selects within the passed list instead of reimplementing the
 * token match (index.tsx itself must stay untouched).
 */
export function assemblePlaybackShots(
  shots: readonly PlaybackShotSource[],
  versions: readonly ProductionMediaVersion[],
  selections: Readonly<Record<string, string>>
): PlaybackShot[] {
  return shots.map((shot, index) => {
    const caption = [shot.purpose, shot.shotSpec, [shot.start, shot.end].filter((part) => part !== undefined && part !== "").join(" → ") || undefined]
      .filter((part) => part !== undefined && part.trim() !== "")
      .join(" ｜ ") || undefined;
    const promptSummary = shot.keyframePrompt ?? shot.motionPrompt;
    return {
      shotId: shot.id,
      index,
      title: shot.title,
      ...(caption === undefined ? {} : { caption }),
      ...(promptSummary === undefined ? {} : { promptSummary }),
      image: selectedVersionForTarget(shot.id, versions, selections, "image"),
      video: selectedVersionForTarget(shot.id, versions, selections, "video"),
      ...(shot.audio === undefined || shot.audio.length === 0 ? {} : { audio: shot.audio })
    };
  });
}

export function playbackPromptSnippet(prompt: string | undefined, limit = 48): string | undefined {
  if (prompt === undefined) return undefined;
  const singleLine = prompt.replace(/\s+/gu, " ").trim();
  if (singleLine === "") return undefined;
  return singleLine.length <= limit ? singleLine : `${singleLine.slice(0, limit)}…`;
}

export const PLAYBACK_IMAGE_SECONDS_MIN = 1;
export const PLAYBACK_IMAGE_SECONDS_MAX = 30;
export const PLAYBACK_IMAGE_SECONDS_DEFAULT = 4;

export function clampPlaybackImageSeconds(value: number): number {
  if (!Number.isFinite(value)) return PLAYBACK_IMAGE_SECONDS_DEFAULT;
  return Math.min(PLAYBACK_IMAGE_SECONDS_MAX, Math.max(PLAYBACK_IMAGE_SECONDS_MIN, Math.round(value)));
}

export function playbackImageDelayMs(seconds: number): number {
  return clampPlaybackImageSeconds(seconds) * 1000;
}

/**
 * Image-timer plumbing for autoplay: fires once after the per-shot still
 * duration; the player re-arms it on every shot change and cancels on pause.
 * Covered with fake timers.
 */
export function schedulePlaybackImageAdvance(onAdvance: () => void, seconds: number): () => void {
  const timer = globalThis.setTimeout(onAdvance, playbackImageDelayMs(seconds));
  return () => { globalThis.clearTimeout(timer); };
}

/**
 * Pure autoplay state machine. Next, image-timer and video-ended advance one
 * shot and hold on the last one so the player stops instead of wrapping
 * silently; prev steps back and clamps at the first shot.
 */
export function playbackNextIndex(current: number, total: number, reason: PlaybackAdvanceReason): number {
  if (!Number.isInteger(current) || !Number.isInteger(total) || total <= 0) return 0;
  const clamped = Math.min(total - 1, Math.max(0, current));
  if (reason === "prev") return Math.max(0, clamped - 1);
  return clamped >= total - 1 ? clamped : clamped + 1;
}

export function playbackShouldStop(total: number, index: number): boolean {
  return total <= 0 || index >= total - 1;
}

export type EpisodeOutputKind = "image" | "video" | "music";

export interface EpisodeOutputSummary {
  readonly kind: EpisodeOutputKind;
  /** succeeded 任务数 + 已存在产物去重后的已产出文件数。 */
  readonly produced: number;
  readonly running: number;
}

/**
 * Aggregate the EP ledger from existing runtime state only (no new requests):
 * succeeded jobs count as produced, pending/running/dispatched_unknown count
 * as running; workspace media not already covered by a succeeded job adds to
 * produced. Composition jobs fold into the video row.
 */
export function summarizeEpisodeOutput(
  jobs: readonly ProductionJob[],
  versions: readonly ProductionMediaVersion[]
): readonly EpisodeOutputSummary[] {
  const kinds: readonly EpisodeOutputKind[] = ["image", "video", "music"];
  return kinds.map((kind) => {
    const relevant = jobs.filter((job) => kind === "image"
      ? job.kind === "image"
      : kind === "video"
        ? (job.kind === "video" || job.kind === "composition")
        : job.kind === "music");
    const succeeded = relevant.filter((job) => job.status === "succeeded");
    const running = relevant.filter((job) => job.status === "pending" || job.status === "running" || job.status === "dispatched_unknown").length;
    const jobCovered = new Set(succeeded.flatMap((job) => versions.filter((version) => mediaVersionMatchesJob(version, job.id)).map((version) => version.id)));
    // 媒体库现已收录 audio(productionLibrary kind:"audio"),music 行同时计 jobs 与
    // 未被成功 job 覆盖的 audio 产物,与 image/video 行口径一致。
    const existing = kind === "music"
      ? versions.filter((version) => version.kind === "audio" && !jobCovered.has(version.id)).length
      : versions.filter((version) => {
        if (kind === "image" ? version.kind !== "image" : version.kind !== "video") return false;
        return !jobCovered.has(version.id);
      }).length;
    return { kind, produced: jobCovered.size + existing, running };
  });
}
