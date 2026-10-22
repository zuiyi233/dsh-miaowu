import { WorkspaceHttpError } from "../workspace-route.js";
import type { AudiobookAssetKind } from "./audiobook-contract.js";
import type { TimedSegment } from "./audiobook-timeline.js";

/**
 * 有声剧混音与双通道响度（N4-C）：只构造 ffmpeg 参数与 filtergraph 字符串。
 *
 * 纯函数模块：不启动进程、不碰文件系统，也不写任何持久化。Task 8 拿到这里的
 * 数组参数后交给既有 `CommandRunner` 执行。时间轴由 `audiobook-timeline` 产出，
 * cue 的绝对窗口也已在那边校验过；本模块只做混音所需的二次校验（负数、越界、
 * 淡出超过窗口），绝不静默夹取参数。
 *
 * 固定形状（Task 4 契约）：
 * - 旁白：每个输入 `aresample/aformat` 上混立体声，除最后一段外按段间停顿
 *   `apad`，再 `concat` 成 `[voice]`；
 * - cue：`atrim` 到 cue 终点、`asetpts` 归零、`adelay` 到 cue 起点、淡入淡出、
 *   增益、按旁白区间做固定闪避（`duckDb` 换算成线性倍数，无随机参数）；
 * - 混合：有 cue 用 `amix=duration=first`（以旁白长度为准），无 cue 直接
 *   `[voice]anull[mix]`；输出固定 44.1 kHz 立体声 PCM。
 */

const OUTPUT_SAMPLE_RATE = "44100";
const OUTPUT_CHANNELS = "2";
/** 旁白与 cue 共用的重采样/上混前缀：统一成 44.1 kHz 立体声浮点，避免 concat 拒绝。 */
const RESAMPLE_CHAIN = "aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo";
/** 响度目标（N4-C 固定 -16 LUFS / -1.5 dBTP / LRA 11）；项目级覆盖留待后续任务。 */
const LOUDNORM_TARGET = "loudnorm=I=-16:TP=-1.5:LRA=11";

export interface MixCue {
  readonly id: string;
  readonly kind: AudiobookAssetKind;
  readonly assetPath: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly fadeInMs: number;
  readonly fadeOutMs: number;
  readonly gainDb: number;
  readonly duckDb: number;
}

export interface MixInput {
  readonly voicePaths: readonly string[];
  readonly timeline: readonly TimedSegment[];
  readonly chapterEndMs: number;
  readonly cues: readonly MixCue[];
  readonly outputPath: string;
}

export interface MixArgs {
  readonly args: string[];
  readonly filterGraph: string;
}

export interface LoudnormMeasurement {
  readonly inputI: number;
  readonly inputTp: number;
  readonly inputLra: number;
  readonly inputThresh: number;
  readonly targetOffset: number;
}

/** 毫秒转 ffmpeg 秒字符串：`String(ms / 1000)` 才能得到 `1`/`1.12`，不能用 toFixed。 */
function seconds(ms: number): string {
  return String(ms / 1000);
}

function malformed(message: string): WorkspaceHttpError {
  return new WorkspaceHttpError(400, message);
}

function inconsistent(message: string): WorkspaceHttpError {
  return new WorkspaceHttpError(409, message);
}

function requireFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw malformed(`${label}不是有效数字。`);
}

function requirePath(value: string, label: string): void {
  if (typeof value !== "string" || value.trim() === "") throw malformed(`${label}不能为空。`);
}

/** 段窗口校验：负数/非有限是请求形状错误（400），空窗、倒置、重叠是时间轴冲突（409）。 */
function validateSegment(segment: TimedSegment, previous: TimedSegment | undefined): void {
  requireFinite(segment.startMs, `片段 ${segment.segmentId} 的起点`);
  requireFinite(segment.endMs, `片段 ${segment.segmentId} 的终点`);
  requireFinite(segment.durationMs, `片段 ${segment.segmentId} 的时长`);
  if (segment.startMs < 0) throw malformed(`片段 ${segment.segmentId} 的起点为负。`);
  if (segment.endMs <= segment.startMs) throw inconsistent(`片段 ${segment.segmentId} 的时间窗为空或倒置。`);
  if (segment.durationMs <= 0) throw inconsistent(`片段 ${segment.segmentId} 的时长为零。`);
  if (previous !== undefined && segment.startMs < previous.endMs) {
    throw inconsistent(`片段 ${segment.segmentId} 的时间窗与上一段重叠。`);
  }
}

/**
 * cue 校验：非有限/负数（起点、淡入淡出）是 400；空窗、越过章末、淡出超过窗口
 * 是 409。这里的窗口由调用方算好传入，本模块不重算锚点，只拒绝自相矛盾的窗口。
 */
function validateCue(cue: MixCue, chapterEndMs: number): void {
  requirePath(cue.assetPath, `cue ${cue.id} 的素材路径`);
  requireFinite(cue.startMs, `cue ${cue.id} 的起点`);
  requireFinite(cue.endMs, `cue ${cue.id} 的终点`);
  requireFinite(cue.fadeInMs, `cue ${cue.id} 的淡入时长`);
  requireFinite(cue.fadeOutMs, `cue ${cue.id} 的淡出时长`);
  requireFinite(cue.gainDb, `cue ${cue.id} 的增益`);
  requireFinite(cue.duckDb, `cue ${cue.id} 的闪避量`);
  if (cue.startMs < 0) throw malformed(`cue ${cue.id} 的时间窗起点为负。`);
  if (cue.fadeInMs < 0) throw malformed(`cue ${cue.id} 的淡入时长不能为负。`);
  if (cue.fadeOutMs < 0) throw malformed(`cue ${cue.id} 的淡出时长不能为负。`);
  if (cue.startMs >= chapterEndMs) throw inconsistent(`cue ${cue.id} 的起点越过章末。`);
  if (cue.endMs <= cue.startMs) throw inconsistent(`cue ${cue.id} 的时间窗为空或倒置。`);
  if (cue.endMs > chapterEndMs) throw inconsistent(`cue ${cue.id} 的时间窗终点越过章末。`);
  if (cue.fadeOutMs > cue.endMs - cue.startMs) throw inconsistent(`cue ${cue.id} 的淡出时长超过时间窗。`);
}

function validateMixInput(input: MixInput): void {
  if (input.voicePaths.length === 0) throw malformed("没有旁白音频，无法混音。");
  input.voicePaths.forEach((path, index) => requirePath(path, `旁白文件 ${index}`));
  requirePath(input.outputPath, "混音输出路径");
  requireFinite(input.chapterEndMs, "章末时间");
  if (input.chapterEndMs <= 0) throw inconsistent("章末时间必须为正。");
  if (input.timeline.length === 0) throw inconsistent("时间轴为空，无法混音。");
  if (input.voicePaths.length !== input.timeline.length) {
    throw inconsistent(`旁白文件数（${input.voicePaths.length}）与时间轴段数（${input.timeline.length}）不一致。`);
  }
  for (let index = 0; index < input.timeline.length; index += 1) {
    const segment = input.timeline[index];
    if (segment === undefined) continue;
    validateSegment(segment, input.timeline[index - 1]);
  }
  for (const cue of input.cues) validateCue(cue, input.chapterEndMs);
}

/** 旁白链路：最后一段之外的段间停顿用相邻段的实际空隙，和时间轴保持同一份事实。 */
function voiceLinks(timeline: readonly TimedSegment[]): string[] {
  return timeline.map((segment, index) => {
    const next = timeline[index + 1];
    const pad = next === undefined ? "" : `,apad=pad_dur=${seconds(next.startMs - segment.endMs)}`;
    return `[${index}:a]${RESAMPLE_CHAIN}${pad}[v${index}]`;
  });
}

/** cue 链路：每条链路逐项生成，顺序即 Task 4 的目标形状（trim → pts → delay → fade → gain → duck）。 */
function cueLinks(cue: MixCue, inputIndex: number, voiceIntervals: string): string {
  const duckFactor = String(Math.pow(10, cue.duckDb / 20));
  const fadeOutStart = seconds(cue.endMs - cue.fadeOutMs);
  const filters = [
    RESAMPLE_CHAIN,
    `atrim=0:${seconds(cue.endMs)}`,
    "asetpts=PTS-STARTPTS",
    `adelay=${cue.startMs}|${cue.startMs}`,
    `afade=t=in:st=0:d=${seconds(cue.fadeInMs)}`,
    `afade=t=out:st=${fadeOutStart}:d=${seconds(cue.fadeOutMs)}`,
    `volume=${cue.gainDb}dB`,
    `volume=volume='if(${voiceIntervals},${duckFactor},1)':eval=frame`,
  ];
  return `[${inputIndex}:a]${filters.join(",")}[bgm${inputIndex}]`;
}

/**
 * 构造一次混音的全部参数。返回的 `args` 可直接交给数组参数的 `CommandRunner`；
 * `filterGraph` 同步返回便于测试与诊断。校验全部发生在拼串之前，失败不留半截图。
 */
export function buildMixArgs(input: MixInput): MixArgs {
  validateMixInput(input);
  const { voicePaths, timeline, cues, outputPath } = input;
  const voiceIntervals = timeline
    .map((segment) => `between(t,${seconds(segment.startMs)},${seconds(segment.endMs)})`)
    .join("+");
  const links = voiceLinks(timeline);
  links.push(`${timeline.map((_segment, index) => `[v${index}]`).join("")}concat=n=${timeline.length}:v=0:a=1[voice]`);
  cues.forEach((cue, cueIndex) => {
    links.push(cueLinks(cue, voicePaths.length + cueIndex, voiceIntervals));
  });
  if (cues.length === 0) {
    links.push("[voice]anull[mix]");
  } else {
    const cueLabels = cues.map((_cue, cueIndex) => `[bgm${voicePaths.length + cueIndex}]`).join("");
    links.push(
      `[voice]${cueLabels}amix=inputs=${cues.length + 1}:duration=first:dropout_transition=0:normalize=0[mix]`,
    );
  }
  const filterGraph = links.join(";");

  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  for (const voicePath of voicePaths) args.push("-i", voicePath);
  for (const cue of cues) {
    if (cue.kind === "music") args.push("-stream_loop", "-1");
    args.push("-i", cue.assetPath);
  }
  args.push(
    "-filter_complex",
    filterGraph,
    "-map",
    "[mix]",
    "-ar",
    OUTPUT_SAMPLE_RATE,
    "-ac",
    OUTPUT_CHANNELS,
    "-c:a",
    "pcm_s16le",
    outputPath,
  );
  return { args, filterGraph };
}

/** 第一遍 loudnorm：只测量，输出到 null，JSON 走 stderr。 */
export function buildLoudnormMeasureArgs(inputPath: string): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "info",
    "-y",
    "-i",
    inputPath,
    "-af",
    `${LOUDNORM_TARGET}:print_format=json`,
    "-f",
    "null",
    "-",
  ];
}

function measuredNumber(record: Record<string, unknown>, key: string): number {
  const raw = record[key];
  const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : typeof raw === "number" ? raw : Number.NaN;
  if (!Number.isFinite(value)) throw new WorkspaceHttpError(500, `loudnorm 测量结果缺少有效的 ${key}。`);
  return value;
}

/**
 * 从 ffmpeg stderr 提取最后一个 `{...}` JSON（真实输出前后有日志，测试则直接传纯
 * JSON），五个测量字段都必须是有限数字，否则 500——测量不可信时不继续归一。
 */
export function parseLoudnormMeasurement(stderr: string): LoudnormMeasurement {
  const close = stderr.lastIndexOf("}");
  const open = close === -1 ? -1 : stderr.lastIndexOf("{", close);
  if (open === -1 || close <= open) throw new WorkspaceHttpError(500, "loudnorm 测量输出中没有 JSON 对象。");
  let parsed: unknown;
  try {
    parsed = JSON.parse(stderr.slice(open, close + 1));
  } catch {
    throw new WorkspaceHttpError(500, "loudnorm 测量输出不是有效 JSON。");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WorkspaceHttpError(500, "loudnorm 测量输出不是 JSON 对象。");
  }
  const record = parsed as Record<string, unknown>;
  return {
    inputI: measuredNumber(record, "input_i"),
    inputTp: measuredNumber(record, "input_tp"),
    inputLra: measuredNumber(record, "input_lra"),
    inputThresh: measuredNumber(record, "input_thresh"),
    targetOffset: measuredNumber(record, "target_offset"),
  };
}

/** 第二遍 loudnorm：带实测值线性归一，输出 44.1 kHz 立体声 WAV。 */
export function buildLoudnormApplyArgs(
  inputPath: string,
  outputPath: string,
  measured: LoudnormMeasurement,
): string[] {
  const filter =
    `${LOUDNORM_TARGET}:measured_I=${measured.inputI}:measured_TP=${measured.inputTp}` +
    `:measured_LRA=${measured.inputLra}:measured_thresh=${measured.inputThresh}` +
    `:offset=${measured.targetOffset}:linear=true`;
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    inputPath,
    "-af",
    filter,
    "-ar",
    OUTPUT_SAMPLE_RATE,
    "-ac",
    OUTPUT_CHANNELS,
    "-c:a",
    "pcm_s16le",
    outputPath,
  ];
}
