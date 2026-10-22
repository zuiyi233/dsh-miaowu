import { WorkspaceHttpError } from "../workspace-route.js";
import { AUDIOBOOK_ROOT, type AudiobookScript } from "./audiobook-contract.js";
import type { TimedSegment } from "./audiobook-timeline.js";

/**
 * 有声剧字幕（N4-C）：把实测时间轴与脚本拆成字幕 cue，并格式化成 SRT/LRC。
 *
 * 纯函数模块：只返回 cue、文本与工作区相对路径，不碰文件系统；Task 8 负责把
 * `formatSrt`/`formatLrc` 的输出写到 `subtitlePathsFor` 给出的位置。时间轴来自
 * ffprobe 实测（`audiobook-timeline`）：只有单条太长时才拆——按标点切出的碎句
 * 贪心合并到每行 `MAX_SUBTITLE_CHARS` 字上限（单个碎句自身超限才硬切），每行
 * 时长按字符数占比分配，最后一行吸收舍入误差——字幕总和与片段实测时长严格
 * 相等，不会越到下一个片段。
 */

/** 单条字幕的字符上限（UTF-16 长度）：超过就拆行，避免一屏字幕挤满播放器。 */
export const MAX_SUBTITLE_CHARS = 42;

/** 断句标点（全角/半角）：在标点之后切开，标点留在前一块里。 */
const BREAK_PUNCTUATION: ReadonlySet<string> = new Set(["，", "。", "！", "？", "；", "、", ",", ".", "!", "?", ";"]);

const SUBTITLE_DIRECTORY = "字幕";
const PROJECT_FILE = "project.json";
const SRT_EXTENSION = ".srt";
const LRC_EXTENSION = ".lrc";

/** 一条字幕：`startMs`/`endMs` 是章内绝对毫秒，`text` 已按上限拆行。 */
export interface SubtitleCue {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
}

/** 字幕文件路径，均为工作区相对路径。 */
export interface SubtitlePaths {
  readonly srt: string;
  readonly lrc: string;
}

function hasControlCharacter(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function invalidProjectPath(): WorkspaceHttpError {
  return new WorkspaceHttpError(400, `有声剧项目路径必须是 ${AUDIOBOOK_ROOT}/<书>/${PROJECT_FILE}。`);
}

/** 章节名就是字幕文件名（不含扩展名）：空白、`.`/`..`、路径分隔符与控制字符一律 400。 */
function chapterName(raw: string): string {
  if (hasControlCharacter(raw)) throw new WorkspaceHttpError(400, "章节名不能包含控制字符。");
  const chapter = raw.trim();
  if (chapter === "" || chapter === "." || chapter === "..") throw new WorkspaceHttpError(400, "章节名不能为空。");
  if (chapter.includes("/") || chapter.includes("\\")) throw new WorkspaceHttpError(400, "章节名不能包含路径分隔符。");
  return chapter;
}

/** 项目路径必须是 `有声剧/<书>/project.json`：只从中取书目录，别的一律 400。 */
function bookDirectoryOf(projectPath: string): string {
  const path = projectPath.trim();
  const segments = path.split("/");
  if (path === "" || path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/u.test(path) || segments.length !== 3) {
    throw invalidProjectPath();
  }
  const [root, book, file] = segments;
  if (root !== AUDIOBOOK_ROOT || file !== PROJECT_FILE || book === undefined || book === "" || book === "." || book === ".." || hasControlCharacter(book)) {
    throw invalidProjectPath();
  }
  return `${AUDIOBOOK_ROOT}/${book}`;
}

/**
 * 字幕文件的唯一构造点：`有声剧/<书>/字幕/<章节>.srt|lrc`。只做路径推导，不读
 * 不写；Task 8 写入前仍要按 DSH 路径策略确认目标留在工作区内。
 */
export function subtitlePathsFor(projectPath: string, chapter: string): SubtitlePaths {
  const directory = bookDirectoryOf(projectPath);
  const name = chapterName(chapter);
  return {
    srt: `${directory}/${SUBTITLE_DIRECTORY}/${name}${SRT_EXTENSION}`,
    lrc: `${directory}/${SUBTITLE_DIRECTORY}/${name}${LRC_EXTENSION}`,
  };
}

/** 单块超过 42 字时按码点硬切，避免切坏代理对；每块都不超过上限。 */
function hardSplit(piece: string): string[] {
  const chunks: string[] = [];
  let chunk = "";
  for (const character of piece) {
    if (chunk.length + character.length > MAX_SUBTITLE_CHARS) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += character;
  }
  if (chunk !== "") chunks.push(chunk);
  return chunks;
}

/** 先按标点切出碎句（标点留在前一块），空文本不产生碎句。 */
function fragmentsOf(text: string): string[] {
  const fragments: string[] = [];
  let piece = "";
  for (const character of text) {
    piece += character;
    if (BREAK_PUNCTUATION.has(character)) {
      fragments.push(piece);
      piece = "";
    }
  }
  if (piece !== "") fragments.push(piece);
  return fragments;
}

/**
 * 碎句贪心合并到 42 字上限：只有“再加上下一碎句就超限”时才收行，短句因此保持
 * 整句；单个碎句自身超过上限时才硬切（42/42/余），余块继续参与贪心合并。
 */
function splitText(text: string): string[] {
  const lines: string[] = [];
  let line = "";
  for (const fragment of fragmentsOf(text)) {
    if (line.length + fragment.length <= MAX_SUBTITLE_CHARS) {
      line += fragment;
      continue;
    }
    if (line !== "") lines.push(line);
    const chunks = hardSplit(fragment);
    lines.push(...chunks.slice(0, -1));
    line = chunks.at(-1) ?? "";
  }
  if (line !== "") lines.push(line);
  return lines;
}

/** 时间轴段 → 字幕块：每块时长按字符数占比分配，最后一块吸收舍入误差。 */
function cuesForSegment(segment: TimedSegment, text: string): SubtitleCue[] {
  if (text.trim() === "") return [];
  const lines = splitText(text);
  const total = lines.reduce((sum, line) => sum + line.length, 0);
  const durationMs = segment.endMs - segment.startMs;
  const cues: SubtitleCue[] = [];
  let consumed = 0;
  let cursor = segment.startMs;
  lines.forEach((line, index) => {
    consumed += line.length;
    const endMs = index === lines.length - 1
      ? segment.endMs
      : segment.startMs + Math.round((durationMs * consumed) / total);
    cues.push({ startMs: cursor, endMs, text: line });
    cursor = endMs;
  });
  return cues;
}

/**
 * 按时间轴生成字幕 cue：每个时间轴段找同 id 的脚本段，文本拆行后按字符占比
 * 分配段内时间。时间轴引用脚本外的片段说明两份数据不同源，直接 409 而不是
 * 静默丢字幕；空白文本跳过。
 */
export function buildSubtitleCues(timeline: readonly TimedSegment[], script: AudiobookScript): readonly SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  for (const segment of timeline) {
    const source = script.segments.find((candidate) => candidate.id === segment.segmentId);
    if (source === undefined) {
      throw new WorkspaceHttpError(409, `时间轴片段 ${segment.segmentId} 在脚本中不存在。`);
    }
    cues.push(...cuesForSegment(segment, source.text));
  }
  return cues;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/** SRT 时间戳：`HH:MM:SS,mmm`，小时与毫秒补零到固定宽度。 */
function srtTimestamp(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1_000);
  const millis = ms % 1_000;
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)},${pad(millis, 3)}`;
}

/** LRC 时间戳：`[mm:ss.xx]`，分钟不折回（可超过 59），厘秒截断不进位。 */
function lrcTimestamp(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1_000);
  const centiseconds = Math.floor((ms % 1_000) / 10);
  return `[${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(centiseconds, 2)}]`;
}

/** SRT 文本：序号从 1，条目之间恰好一个空行，文件尾一个换行；无 cue 返回空串。 */
export function formatSrt(cues: readonly SubtitleCue[]): string {
  if (cues.length === 0) return "";
  const blocks = cues.map((cue, index) =>
    `${String(index + 1)}\n${srtTimestamp(cue.startMs)} --> ${srtTimestamp(cue.endMs)}\n${cue.text}`);
  return `${blocks.join("\n\n")}\n`;
}

/** LRC 文本：每行 `[mm:ss.xx]text`，只记起点；无 cue 返回空串。 */
export function formatLrc(cues: readonly SubtitleCue[]): string {
  return cues.map((cue) => `${lrcTimestamp(cue.startMs)}${cue.text}\n`).join("");
}
