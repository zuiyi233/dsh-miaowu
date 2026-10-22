import { WorkspaceHttpError } from "../workspace-route.js";
import type { AudiobookAssetKind, AudiobookCue, AudiobookScript } from "./audiobook-contract.js";

/**
 * 有声剧时间轴（N4-C）：把逐段实测时长排成章节时间轴，再把 cue 换算成绝对时间窗。
 *
 * 纯函数模块：不碰 realm、文件系统或 ffmpeg，也不写任何持久化。时长全部来自实测
 * （ffprobe），缺失直接报错——按字数估算会让 cue 与字幕整体漂移。段与段之间固定
 * 插 `DEFAULT_PAUSE_MS` 静音，混音（T4）与字幕（T5）共用同一份时间轴。
 */

/** 段间固定停顿（毫秒）：时间轴、混音与字幕共用，改这里三处一起变。 */
export const DEFAULT_PAUSE_MS = 120;

export interface TimedSegment {
  readonly segmentId: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly durationMs: number;
}

/** cue 的绝对时间窗：`cueWindow` 产出，`assertCueWindow` 校验，混音只读。 */
export interface CueWindow {
  readonly startMs: number;
  readonly endMs: number;
}

function cueConflict(cue: AudiobookCue, reason: string): WorkspaceHttpError {
  return new WorkspaceHttpError(409, `cue ${cue.id} ${reason}。`);
}

/**
 * 按脚本顺序排时间轴：起点接在上一段的终点加 `DEFAULT_PAUSE_MS` 之后。
 * 时长缺失、非有限或不为正一律 409 并点名片段，不猜时长。
 */
export function buildTimeline(script: AudiobookScript, durations: ReadonlyMap<string, number>): TimedSegment[] {
  const timeline: TimedSegment[] = [];
  let cursor = 0;
  for (const segment of script.segments) {
    const durationMs = durations.get(segment.id);
    if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs <= 0) {
      throw new WorkspaceHttpError(409, `片段 ${segment.id} 缺少有效的实测时长，请先生成音频。`);
    }
    const startMs = cursor;
    const endMs = startMs + Math.round(durationMs);
    timeline.push({ segmentId: segment.id, startMs, endMs, durationMs: Math.round(durationMs) });
    cursor = endMs + DEFAULT_PAUSE_MS;
  }
  return timeline;
}

/**
 * 时间窗校验（导出编排与 `cueWindow` 共用）：负起点、起点越过章末、空窗/倒置、
 * 终点越过章末都是 409 并点名 cue。非有限数（NaN/Infinity）只可能来自外部拼出来的
 * 窗口，同样拒绝，避免把 NaN 传给 ffmpeg。
 */
export function assertCueWindow(cue: AudiobookCue, window: CueWindow, chapterEndMs: number): void {
  if (!Number.isFinite(window.startMs) || !Number.isFinite(window.endMs)) throw cueConflict(cue, "的时间窗不是有效数字");
  if (window.startMs < 0) throw cueConflict(cue, "的时间窗起点为负");
  if (window.startMs >= chapterEndMs) throw cueConflict(cue, "的起点越过章末");
  if (window.endMs <= window.startMs) throw cueConflict(cue, "的时间窗为空或倒置");
  if (window.endMs > chapterEndMs) throw cueConflict(cue, "的时间窗终点越过章末");
}

/**
 * 计算 cue 的绝对时间窗：起点 = 锚点段起点 + 偏移。音乐 cue 从起点铺到章末（BGM
 * 打底），音效 cue 播放素材自身长度，并在章末截断。负偏移是请求形状错误（400），
 * 其余时间窗问题交给 `assertCueWindow`（409）。
 */
export function cueWindow(
  cue: AudiobookCue,
  kind: AudiobookAssetKind,
  timeline: readonly TimedSegment[],
  chapterEndMs: number,
  assetDurationMs: number,
): CueWindow {
  if (cue.offsetMs < 0) throw new WorkspaceHttpError(400, `cue ${cue.id} 的偏移不能为负。`);
  const anchor = timeline.find((segment) => segment.segmentId === cue.startSegment);
  if (anchor === undefined) throw cueConflict(cue, `引用的片段 ${cue.startSegment} 不存在`);
  const startMs = anchor.startMs + cue.offsetMs;
  const endMs =
    kind === "music" ? chapterEndMs : Math.min(startMs + Math.max(0, Math.round(assetDurationMs)), chapterEndMs);
  const window: CueWindow = { startMs, endMs };
  assertCueWindow(cue, window, chapterEndMs);
  return window;
}
