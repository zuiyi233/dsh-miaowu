import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { FsTarget } from "@deepseek-ai/dsh-fs";
import { WorkspaceHttpError, type WorkspaceRealm } from "../workspace-route.js";
import {
  assertCuesAuthorized,
  listAudiobookAssets,
  loadAssetAuthorizations,
} from "./audiobook-assets.js";
import { assertAssignable, requiredSegmentVoice, resolveCast } from "./audiobook-cast.js";
import type { BinaryFileStore } from "./audiobook-binary.js";
import { segmentAudioPath, ttsCacheKey, type CachedAudioExtension } from "./audiobook-cache.js";
import {
  AUDIOBOOK_CACHE_ROOT,
  AUDIOBOOK_ROOT,
  type AudiobookAssetProviderReceipt,
  type AudiobookAssetView,
  type AudiobookAuthorizationRecord,
  type AudiobookExportFormats,
  type AudiobookExportFullResult,
  type AudiobookExportIssue,
  type AudiobookExportPreflight,
  type AudiobookManifestChapter,
  type AudiobookManifestFile,
  type AudiobookManifestLicense,
  type AudiobookProject,
  type AudiobookProjectRecord,
  type AudiobookScript,
} from "./audiobook-contract.js";
import { measureAudioDuration, measureCachedSegmentDuration } from "./audiobook-duration.js";
import {
  assertCover,
  bookM4bPathFor,
  buildFfmetadata,
  buildM4bArgs,
  type M4bChapter,
} from "./audiobook-m4b.js";
import {
  buildLoudnormApplyArgs,
  buildLoudnormMeasureArgs,
  buildMixArgs,
  parseLoudnormMeasurement,
  type MixCue,
} from "./audiobook-mix.js";
import { releaseDirectoryFor, writeReleaseManifest } from "./audiobook-package.js";
import { assertScriptSourceFresh, loadChapterScript } from "./audiobook-script.js";
import { buildSubtitleCues, formatLrc, formatSrt, subtitlePathsFor } from "./audiobook-subtitles.js";
import { buildTimeline, cueWindow } from "./audiobook-timeline.js";

/**
 * 有声剧导出：ffmpeg concat 合成章节 MP3、ffprobe 时长探测与系统能力预检。
 *
 * 导出只读内容寻址缓存，不重新合成：任一脚本片段的缓存音频缺失就视为整章没
 * 生成完（409），不产出半章音频。合成先写 `.oh-story/audiobook/tmp/` 下的
 * 临时清单与临时 MP3，ffprobe 确认时长有限后再改名到
 * `有声剧/<书>/音频/<章节>.mp3`，任何失败都会清掉临时文件，不会留下可被误认
 * 为成品的目标文件。清单里只写缓存音频的进程路径，不写正文或密钥；stderr 只
 * 截取尾部用于报错。
 *
 * 命令执行与能力预检分开：`hostCommandRunner` 只负责跑命令并收集有上限的
 * 输出，`probeTool` 用 `-version` 加 5 秒超时判断 ffmpeg/ffprobe 是否可用
 * （ffmpeg 系工具只认单横线参数，`--version` 会被当成未知选项并失败）；
 * 导出本身不重复探测，由路由在进入导出前预检。
 */

/** 导出临时目录：concat 清单与临时 MP3 都落在这里。 */
const AUDIOBOOK_TEMP_ROOT = ".oh-story/audiobook/tmp";
const AUDIO_DIRECTORY = "音频";
const SUBTITLE_DIRECTORY = "字幕";
const ASSET_DIRECTORY = "素材";
const PROJECT_FILE = "project.json";
const MP3_EXTENSION = ".mp3";
const CONCAT_EXTENSION = ".txt";
const COVER_FILE = "cover.jpg";
const BOOK_M4B_FILE = "全书.m4b";
const RELEASE_DIRECTORY = "发布";
const STAGING_CHAPTER_DIRECTORY = "chapters";
const STAGING_M4B_DIRECTORY = "m4b";
/** 混音/归一/编码链路的固定输出规格：44.1 kHz 立体声（N4-C 契约）。 */
const ENCODE_SAMPLE_RATE = "44100";
const ENCODE_CHANNELS = "2";
const PROBE_TIMEOUT_MS = 5_000;
/** ffmpeg/ffprobe 只接受单横线参数；`--version` 会以未知选项失败。 */
const PROBE_ARGUMENT = "-version";
/** 整章合成的时间上限：超时终止子进程并返回 504，不把宿主卡在长任务里。 */
const EXPORT_TIMEOUT_MS = 10 * 60_000;
/** 时长探测的时间上限。 */
const FFPROBE_TIMEOUT_MS = 30_000;
/** 命令输出收集上限（stdout/stderr 各一份），避免失控进程撑爆宿主内存。 */
const COMMAND_OUTPUT_MAX_BYTES = 64 * 1_024;
const STDERR_TAIL_CHARS = 300;
const MP3_BITRATE = "192k";
/** 错误文本里的绝对路径占位符：stderr 可能带出进程路径或工作目录。 */
const PATH_PLACEHOLDER = "[路径]";
/** 盘符路径按反斜杠分段，允许段内空格；在任意冒号、引号、行尾或另一个盘符路径前停。 */
const WINDOWS_ABSOLUTE_PATH = /[A-Za-z]:[\\/](?!\/)(?:[^\\:*?"<>|\r\n]+\\)*[^\\:*?"<>|\r\n]*?(?=:|["<>|\r\n]|$|\s+[A-Za-z]:[\\/])/gu;
/** UNC 路径允许共享名里带空格，同样在冒号/引号/行尾或另一个盘符路径前停。 */
const UNC_PATH = /\\\\[^:*?"<>|\r\n]*?(?=:|["<>|\r\n]|$|\s+[A-Za-z]:[\\/])/gu;
/** POSIX 绝对路径可出现在行首或空白/引号/括号之后，遇到空白或冒号即停。 */
const POSIX_ABSOLUTE_PATH = /(^|[\s'"(=])(\/(?:[^\s'":]+\/)*[^\s'":]+)/gu;
/** 脱敏前先截取尾部，给正则一个固定上限，避免超长 stderr 拖慢错误路径。 */
const STDERR_SCAN_CHARS = 2_000;

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandRunOptions {
  readonly timeoutMs?: number;
}

/** 运行外部命令的窄接口：生产用 `hostCommandRunner`，测试注入假实现。 */
export interface CommandRunner {
  run(command: string, args: readonly string[], options?: CommandRunOptions): Promise<CommandResult>;
}

/** 导出只需要二进制存储与命令执行；Task 7 的运行时会在此基础上扩展。 */
export interface AudiobookExportRuntime {
  readonly binary: BinaryFileStore;
  readonly runner: CommandRunner;
}

export interface AudiobookExportResult {
  readonly path: string;
  readonly bytes: number;
  readonly durationMs: number;
}

/**
 * 宿主进程命令执行器：不经 shell（避免注入与引号差异），Windows 下隐藏窗口；
 * 收集 stdout/stderr 到各自 64 KiB 上限，进程无法启动时拒绝，退出码为空
 * （被信号终止）按 1 处理。超时由调用方传入，触发后终止子进程并拒绝。
 */
export function hostCommandRunner(): CommandRunner {
  return {
    run: (command, args, options = {}) => new Promise<CommandResult>((resolvePromise, rejectPromise) => {
      const child = spawn(command, [...args], { shell: false, windowsHide: true });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      const collect = (chunk: Buffer | string, used: number, chunks: Buffer[]): number => {
        const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
        const remaining = COMMAND_OUTPUT_MAX_BYTES - used;
        if (remaining <= 0) return used;
        const kept = buffer.byteLength > remaining ? buffer.subarray(0, remaining) : buffer;
        chunks.push(kept);
        return used + kept.byteLength;
      };
      const timeoutMs = options.timeoutMs;
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill(); } catch { /* 子进程可能已退出 */ }
        rejectPromise(new Error(`命令超时（${String(Math.round(timeoutMs / 1000))}s）：${command}`));
      }, timeoutMs);
      timer?.unref();
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        action();
      };
      child.stdout?.on("data", (chunk: Buffer | string) => {
        stdoutBytes = collect(chunk, stdoutBytes, stdoutChunks);
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderrBytes = collect(chunk, stderrBytes, stderrChunks);
      });
      child.on("error", (cause) => {
        finish(() => { rejectPromise(new Error(`无法启动命令（${command}）：${cause.message}`)); });
      });
      child.on("close", (code) => {
        finish(() => {
          resolvePromise({
            code: code ?? 1,
            stdout: Buffer.concat(stdoutChunks).toString("utf8"),
            stderr: Buffer.concat(stderrChunks).toString("utf8"),
          });
        });
      });
    }),
  };
}

/**
 * 探测系统工具：跑 `[tool, "-version"]`，退出码 0 即可用。探测永远不抛错：
 * 超时、进程无法启动或任何命令失败都返回 false，由调用方决定降级或报错。
 */
export async function probeTool(runner: CommandRunner, tool: string): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<CommandResult>((_resolve, rejectPromise) => {
    timer = setTimeout(() => {
      rejectPromise(new Error(`探测 ${tool} 超时。`));
    }, PROBE_TIMEOUT_MS);
    timer.unref();
  });
  try {
    const result = await Promise.race([
      runner.run(tool, [PROBE_ARGUMENT], { timeoutMs: PROBE_TIMEOUT_MS }),
      timeout,
    ]);
    return result.code === 0;
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function hasControlCharacter(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** 与项目/脚本服务同一套相对路径判据：绝对路径、盘符、反斜杠、空段与 `..` 一律拒绝。 */
function relativePathOrNull(raw: string): string | null {
  const text = raw.trim();
  if (text === "" || text.startsWith("/") || text.includes("\\") || /^[A-Za-z]:/u.test(text)) return null;
  const segments = text.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".." || hasControlCharacter(segment))) return null;
  return segments.join("/");
}

/** 章节名就是导出文件名（不含 .mp3），不允许路径分隔符或控制字符。 */
function chapterName(raw: string): string {
  const chapter = raw.trim();
  if (chapter === "" || chapter === "." || chapter === "..") throw new WorkspaceHttpError(400, "章节名不能为空。");
  if (chapter.includes("/") || chapter.includes("\\") || hasControlCharacter(chapter)) {
    throw new WorkspaceHttpError(400, "章节名不能包含路径分隔符。");
  }
  return chapter;
}

/** 项目路径的父目录名即书目名；项目必须位于 `有声剧/` 下。 */
function projectDirectoryName(projectPath: string): string {
  const path = relativePathOrNull(projectPath);
  if (path === null) throw new WorkspaceHttpError(400, "项目路径必须是工作区内的相对路径。");
  const segments = path.split("/");
  if (segments[0] !== AUDIOBOOK_ROOT || segments.length < 3) {
    throw new WorkspaceHttpError(403, `有声剧项目必须位于 ${AUDIOBOOK_ROOT}/ 目录下。`);
  }
  return segments[1] ?? "";
}

function audioExtension(project: AudiobookProject): CachedAudioExtension {
  return project.tts.responseFormat;
}

/** 解析缓存目标并确认它仍在缓存根内；缓存根本身也必须留在工作区。 */
async function cacheTarget(realm: WorkspaceRealm, key: string, extension: CachedAudioExtension): Promise<FsTarget> {
  const cacheRoot = await realm.fs.resolve(AUDIOBOOK_CACHE_ROOT, { cwd: realm.cwd });
  if (!realm.fs.contains(realm.root, cacheRoot)) throw new WorkspaceHttpError(403, "有声剧缓存目录离开了 DSH 工作目录。");
  const target = await realm.fs.resolve(segmentAudioPath(key, extension), { cwd: realm.cwd });
  if (!realm.fs.contains(cacheRoot, target)) throw new WorkspaceHttpError(403, "有声剧缓存路径离开了缓存目录。");
  return target;
}

/** 解析导出目标并确认它仍在 `有声剧/<书>/音频/` 内。 */
async function outputTarget(realm: WorkspaceRealm, directoryPath: string, outputPath: string): Promise<FsTarget> {
  const root = await realm.fs.resolve(AUDIOBOOK_ROOT, { cwd: realm.cwd });
  if (!realm.fs.contains(realm.root, root)) throw new WorkspaceHttpError(403, "有声剧目录离开了 DSH 工作目录。");
  const directory = await realm.fs.resolve(directoryPath, { cwd: realm.cwd });
  if (!realm.fs.contains(root, directory)) throw new WorkspaceHttpError(403, "导出目录离开了有声剧目录。");
  const target = await realm.fs.resolve(outputPath, { cwd: realm.cwd });
  if (!realm.fs.contains(directory, target)) throw new WorkspaceHttpError(403, "导出路径离开了音频目录。");
  return target;
}

/** 解析临时文件目标并确认它仍在导出临时目录内。 */
async function tempTarget(realm: WorkspaceRealm, fileName: string): Promise<FsTarget> {
  const tmpRoot = await realm.fs.resolve(AUDIOBOOK_TEMP_ROOT, { cwd: realm.cwd });
  if (!realm.fs.contains(realm.root, tmpRoot)) throw new WorkspaceHttpError(403, "导出临时目录离开了 DSH 工作目录。");
  const target = await realm.fs.resolve(`${AUDIOBOOK_TEMP_ROOT}/${fileName}`, { cwd: realm.cwd });
  if (!realm.fs.contains(tmpRoot, target)) throw new WorkspaceHttpError(403, "导出临时文件离开了临时目录。");
  return target;
}

/** concat demuxer 的 `file` 行；单引号按 ffmpeg 清单语法拆段转义为 `'\''`。 */
function concatFileLine(processPath: string): string {
  if (/[\r\n]/u.test(processPath)) throw new WorkspaceHttpError(500, "音频路径包含换行符，无法写入 concat 清单。");
  return `file '${processPath.replaceAll("'", "'\\''")}'`;
}

/** 去掉错误文本里的绝对路径（Windows 盘符、UNC 与 POSIX），避免回显进程路径。 */
function redactAbsolutePaths(text: string): string {
  return text
    .replace(WINDOWS_ABSOLUTE_PATH, PATH_PLACEHOLDER)
    .replace(UNC_PATH, PATH_PLACEHOLDER)
    .replace(POSIX_ABSOLUTE_PATH, `$1${PATH_PLACEHOLDER}`);
}

/** 只保留单行、去重、已抹掉绝对路径的 stderr 尾部，用于报错又不把整段日志塞给客户端。 */
function stderrTail(stderr: string): string {
  const compact = stderr.replace(/\s+/gu, " ").trim();
  if (compact === "") return "无错误输出";
  const bounded = compact.length <= STDERR_SCAN_CHARS ? compact : compact.slice(-STDERR_SCAN_CHARS);
  const redacted = redactAbsolutePaths(bounded);
  return redacted.length <= STDERR_TAIL_CHARS ? redacted : `…${redacted.slice(redacted.length - STDERR_TAIL_CHARS)}`;
}

/** 宿主命令执行器在超时后拒绝；超时与普通失败在路由层要映射成不同状态码。 */
function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && /超时/u.test(error.message);
}

/**
 * 带超时运行导出所需的外部命令：超时返回 504，其余启动/执行失败返回 500，
 * 错误文本先抹掉绝对路径再截尾。
 */
async function runBounded(
  runner: CommandRunner,
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<CommandResult> {
  try {
    return await runner.run(command, args, { timeoutMs });
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new WorkspaceHttpError(504, `${command} 执行超时（${String(Math.round(timeoutMs / 1000))} 秒），已终止。`);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new WorkspaceHttpError(500, `${command} 无法执行：${stderrTail(message)}`);
  }
}

/** 章节成品音频的唯一构造点：`有声剧/<书>/音频/<章节>.mp3`。 */
export function chapterAudioPathFor(projectPath: string, chapter: string): string {
  return `${AUDIOBOOK_ROOT}/${projectDirectoryName(projectPath)}/${AUDIO_DIRECTORY}/${chapterName(chapter)}${MP3_EXTENSION}`;
}

/**
 * 导出整章 MP3：确认每个片段的缓存音频都存在，写 concat 清单，跑一次 ffmpeg
 * 合成到临时文件，ffprobe 确认时长后改名到最终路径；任何失败都清理清单与
 * 临时文件并抛出 500（缓存缺失是 409），不会留下最终 MP3。
 */
export async function exportChapterMp3(
  realm: WorkspaceRealm,
  record: AudiobookProjectRecord,
  chapter: string,
  script: AudiobookScript,
  runtime: AudiobookExportRuntime,
): Promise<AudiobookExportResult> {
  const name = chapterName(chapter);
  const project = record.project;
  const cast = resolveCast(project);
  const extension = audioExtension(project);
  if (script.segments.length === 0) throw new WorkspaceHttpError(409, `${name}还没有可导出的片段。`);
  assertAssignable(cast, script);

  const segmentTargets: FsTarget[] = [];
  for (const segment of script.segments) {
    const key = ttsCacheKey({
      baseUrl: project.tts.baseUrl,
      model: project.tts.model,
      voice: requiredSegmentVoice(cast, segment),
      speed: project.tts.speed,
      responseFormat: extension,
      text: segment.text,
    });
    const target = await cacheTarget(realm, key, extension);
    const info = await runtime.binary.stat(target);
    if (info === undefined || info.size <= 0) throw new WorkspaceHttpError(409, `${name}还没有完整生成。`);
    segmentTargets.push(target);
  }

  const outputPath = chapterAudioPathFor(record.path, name);
  const directoryPath = outputPath.slice(0, outputPath.lastIndexOf("/"));
  const output = await outputTarget(realm, directoryPath, outputPath);
  const jobKey = randomUUID();
  const listTarget = await tempTarget(realm, `${jobKey}${CONCAT_EXTENSION}`);
  const tempOutput = await tempTarget(realm, `${jobKey}${MP3_EXTENSION}`);
  const listContent = `${segmentTargets.map((target) => concatFileLine(runtime.binary.processPath(target))).join("\n")}\n`;

  try {
    await runtime.binary.prepare(listTarget);
    await runtime.binary.prepare(tempOutput);
    await runtime.binary.prepare(output);
    await runtime.binary.write(listTarget, new TextEncoder().encode(listContent));

    const ffmpeg = await runBounded(runtime.runner, "ffmpeg", [
      "-hide_banner",
      "-loglevel", "error",
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", runtime.binary.processPath(listTarget),
      "-c:a", "libmp3lame",
      "-b:a", MP3_BITRATE,
      runtime.binary.processPath(tempOutput),
    ], EXPORT_TIMEOUT_MS);
    if (ffmpeg.code !== 0) {
      throw new WorkspaceHttpError(500, `ffmpeg 导出失败：${stderrTail(ffmpeg.stderr)}`);
    }

    const stat = await runtime.binary.stat(tempOutput);
    if (stat === undefined || stat.size <= 0) throw new WorkspaceHttpError(500, "ffmpeg 没有写出有效的 MP3 文件。");

    const probe = await runBounded(runtime.runner, "ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      runtime.binary.processPath(tempOutput),
    ], FFPROBE_TIMEOUT_MS);
    const seconds = Number.parseFloat(probe.stdout.trim());
    if (probe.code !== 0 || !Number.isFinite(seconds) || seconds < 0) {
      throw new WorkspaceHttpError(500, "ffprobe 无法读取导出时长。");
    }

    await runtime.binary.rename(tempOutput, output);
    return { path: outputPath, bytes: stat.size, durationMs: Math.round(seconds * 1000) };
  } finally {
    await runtime.binary.remove(listTarget).catch(() => undefined);
    await runtime.binary.remove(tempOutput).catch(() => undefined);
  }
}

type SubtitleFormat = "srt" | "lrc";

/** 有效导出格式：package 展开为 MP3 + M4B + SRT/LRC。 */
interface EffectiveFormats {
  /** 需要混音/编码的章节 MP3（M4B 也依赖它）。 */
  readonly mp3: boolean;
  readonly m4b: boolean;
  readonly subtitles: readonly SubtitleFormat[];
  /** 章节 MP3 是否提升为 `音频/` 成品；只做 M4B 时暂存文件不落地。 */
  readonly promoteMp3: boolean;
}

/** 预检的完整结果：issues 之外的脚本/素材/授权只给导出编排复用，不对外暴露。 */
interface ExportInspection {
  readonly issues: readonly AudiobookExportIssue[];
  readonly selected: readonly string[];
  readonly scripts: ReadonlyMap<string, AudiobookScript>;
  readonly assets: AudiobookAssetView;
  readonly authorization: AudiobookAuthorizationRecord | undefined;
  readonly chars: number;
}

interface ChapterStage {
  readonly mix: FsTarget;
  readonly normalized: FsTarget;
  readonly mp3: FsTarget;
  readonly subtitles: Map<SubtitleFormat, FsTarget>;
}

/**
 * 规范项目目录 `有声剧/<书>`：预检在这里统一路径校验（精确三段 + project.json），
 * 与发布包/M4B 模块的判据一致；不符合按 400 拒绝，而不是等某个下游模块报错。
 */
function bookDirectoryOf(projectPath: string): string {
  const path = projectPath.trim();
  const segments = path.split("/");
  if (path === "" || path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/u.test(path) || segments.length !== 3) {
    throw new WorkspaceHttpError(400, `有声剧项目路径必须是 ${AUDIOBOOK_ROOT}/<书>/${PROJECT_FILE}。`);
  }
  const [root, book, file] = segments;
  if (
    root !== AUDIOBOOK_ROOT
    || file !== PROJECT_FILE
    || book === undefined
    || book === ""
    || book === "."
    || book === ".."
    || hasControlCharacter(book)
  ) {
    throw new WorkspaceHttpError(400, `有声剧项目路径必须是 ${AUDIOBOOK_ROOT}/<书>/${PROJECT_FILE}。`);
  }
  return `${AUDIOBOOK_ROOT}/${book}`;
}

/** 项目章节源路径 → 章节名（源文件名去掉 `.md`），与任务/脚本/旧导出同一约定。 */
function projectChapterNames(project: AudiobookProject): string[] {
  return project.source.chapters.map((sourcePath) => {
    const name = sourcePath.slice(sourcePath.lastIndexOf("/") + 1);
    return name.endsWith(".md") ? name.slice(0, -".md".length) : name;
  });
}

/** 请求开关 → 有效格式；package 强制字幕 SRT+LRC，重复的字幕格式只保留一次。 */
function effectiveFormats(formats: AudiobookExportFormats): EffectiveFormats {
  const m4b = formats.m4b || formats.package;
  const subtitles: SubtitleFormat[] = [];
  for (const format of formats.package ? ["srt", "lrc"] as const : formats.subtitles) {
    if (!subtitles.includes(format)) subtitles.push(format);
  }
  return {
    mp3: formats.mp3 || formats.package || m4b,
    m4b,
    subtitles,
    promoteMp3: formats.mp3 || formats.package,
  };
}

/** 暂存目标 `.oh-story/audiobook/tmp/<uuid>/<relative>`，并确认仍在临时目录内。 */
async function stagingTarget(
  realm: WorkspaceRealm,
  jobKey: string,
  relative: string,
): Promise<FsTarget> {
  const tmpRoot = await realm.fs.resolve(AUDIOBOOK_TEMP_ROOT, { cwd: realm.cwd });
  if (!realm.fs.contains(realm.root, tmpRoot)) throw new WorkspaceHttpError(403, "导出临时目录离开了 DSH 工作目录。");
  const target = await realm.fs.resolve(`${AUDIOBOOK_TEMP_ROOT}/${jobKey}/${relative}`, { cwd: realm.cwd });
  if (!realm.fs.contains(tmpRoot, target)) throw new WorkspaceHttpError(403, "导出临时文件离开了临时目录。");
  return target;
}

/** 解析 cue 素材目标：必须同时留在工作区与本书的 `素材/` 目录内。 */
async function assetTarget(realm: WorkspaceRealm, bookDirectory: string, assetPath: string): Promise<FsTarget> {
  const assetsRoot = await realm.fs.resolve(`${bookDirectory}/${ASSET_DIRECTORY}`, { cwd: realm.cwd });
  if (!realm.fs.contains(realm.root, assetsRoot)) throw new WorkspaceHttpError(403, "素材目录离开了 DSH 工作目录。");
  const target = await realm.fs.resolve(assetPath, { cwd: realm.cwd });
  if (!realm.fs.contains(realm.root, target) || !realm.fs.contains(assetsRoot, target)) {
    throw new WorkspaceHttpError(403, "素材路径离开了素材目录。");
  }
  return target;
}

/** 确认 ffmpeg 写出的暂存音频存在且非空；空文件不能进入后续步骤。 */
async function assertStagedAudio(
  runtime: AudiobookExportRuntime,
  target: FsTarget,
  label: string,
): Promise<number> {
  const info = await runtime.binary.stat(target);
  if (info === undefined || info.size <= 0) throw new WorkspaceHttpError(500, `ffmpeg 没有写出有效的${label}。`);
  return info.size;
}

/** 跑一条 ffmpeg 命令：超时/启动失败由 `runBounded` 映射，非零退出带 stderr 尾部。 */
async function runFfmpeg(
  runtime: AudiobookExportRuntime,
  args: readonly string[],
  label: string,
): Promise<CommandResult> {
  const result = await runBounded(runtime.runner, "ffmpeg", args, EXPORT_TIMEOUT_MS);
  if (result.code !== 0) throw new WorkspaceHttpError(500, `ffmpeg ${label}失败：${stderrTail(result.stderr)}`);
  return result;
}

/** 章节 MP3 编码参数：loudnorm 后的 WAV 转 44.1 kHz 立体声 MP3。 */
function buildChapterMp3Args(inputPath: string, outputPath: string, bitrateKbps: number): string[] {
  return [
    "-hide_banner",
    "-loglevel", "error",
    "-y",
    "-i", inputPath,
    "-ar", ENCODE_SAMPLE_RATE,
    "-ac", ENCODE_CHANNELS,
    "-c:a", "libmp3lame",
    "-b:a", `${String(bitrateKbps)}k`,
    outputPath,
  ];
}

/**
 * 完整导出预检：只读脚本、素材授权、封面、缓存音频与 ffmpeg 能力，任何领域问题
 * 都收集进 `issues` 而不抛出（损坏的授权文档/项目文档仍按原错误上抛）。缓存音频
 * 只 stat，不探测时长——预览必须零写入，时长缓存只在实际导出时建立。
 */
async function inspectExport(
  realm: WorkspaceRealm,
  record: AudiobookProjectRecord,
  runtime: AudiobookExportRuntime,
  formats: AudiobookExportFormats,
  chapters: readonly string[] | undefined,
): Promise<ExportInspection> {
  const project = record.project;
  const effective = effectiveFormats(formats);
  // 规范项目路径先在这里统一校验：不合规直接 400，不进入后续只读扫描。
  bookDirectoryOf(record.path);
  const issues: AudiobookExportIssue[] = [];
  const allChapters = projectChapterNames(project);
  const requested = chapters === undefined || chapters.length === 0 ? allChapters : chapters;
  const selected: string[] = [];
  for (const raw of requested) {
    const name = raw.trim();
    if (name === "" || !allChapters.includes(name)) {
      issues.push({
        code: "chapter-missing",
        message: name === "" ? "导出的章节名不能为空。" : `有声剧项目里没有章节 ${name}。`,
      });
      continue;
    }
    if (!selected.includes(name)) selected.push(name);
  }
  // 输出顺序固定按项目章节顺序，避免请求顺序改变 M4B 章节与清单顺序。
  const ordered = allChapters.filter((name) => selected.includes(name));
  const cast = resolveCast(project);
  const scripts = new Map<string, AudiobookScript>();
  const assignable = new Set<string>();
  let chars = 0;

  for (const name of ordered) {
    let loaded: Awaited<ReturnType<typeof loadChapterScript>>;
    try {
      loaded = await loadChapterScript(realm, record.path, name);
    } catch (error) {
      // 坏脚本/超限脚本是工作区数据问题，预检应报告而不是把预览打成 500。
      if (error instanceof WorkspaceHttpError && (error.status === 422 || error.status === 413)) {
        issues.push({ code: "script-invalid", message: `${name}的脚本无法读取：${error.message}` });
        continue;
      }
      throw error;
    }
    if (loaded === undefined) {
      issues.push({ code: "script-missing", message: `${name}还没有脚本，请先生成脚本。` });
      continue;
    }
    scripts.set(name, loaded.script);
    chars += loaded.script.segments.reduce((sum, segment) => sum + segment.text.length, 0);
    try {
      await assertScriptSourceFresh(realm, loaded.script);
    } catch (error) {
      if (error instanceof WorkspaceHttpError && error.status === 409) {
        issues.push({ code: "script-stale", message: error.message, path: loaded.path });
        continue;
      }
      throw error;
    }
    try {
      assertAssignable(cast, loaded.script);
      assignable.add(name);
    } catch (error) {
      if (error instanceof WorkspaceHttpError && error.status === 409) {
        issues.push({ code: "unassigned", message: error.message, path: loaded.path });
        continue;
      }
      throw error;
    }
  }

  // 授权文档损坏等文档级错误由 listAudiobookAssets 按原状态码上抛。
  const assets = await listAudiobookAssets(realm, record);
  const authorization = await loadAssetAuthorizations(realm, record.path);
  const selectedSet = new Set(ordered);
  // 只校验选中章节、且脚本已读到的 cue；脚本缺失已在上面报过，不重复归类。
  const cueProject: AudiobookProject = {
    ...project,
    cues: project.cues.filter((cue) => selectedSet.has(cue.chapter) && scripts.has(cue.chapter)),
  };
  try {
    await assertCuesAuthorized(cueProject, assets, scripts);
  } catch (error) {
    if (error instanceof WorkspaceHttpError) issues.push({ code: "asset-unauthorized", message: error.message });
    else throw error;
  }

  if (effective.m4b) {
    try {
      await assertCover(realm, record.path);
    } catch (error) {
      if (error instanceof WorkspaceHttpError) issues.push({ code: "cover-missing", message: error.message });
      else throw error;
    }
  }

  const [ffmpeg, ffprobe] = await Promise.all([
    probeTool(runtime.runner, "ffmpeg"),
    probeTool(runtime.runner, "ffprobe"),
  ]);
  if (!ffmpeg || !ffprobe) {
    issues.push({ code: "ffmpeg-missing", message: "本机缺少 ffmpeg 或 ffprobe，无法导出有声剧。" });
  }

  const extension = audioExtension(project);
  for (const name of ordered) {
    const script = scripts.get(name);
    if (script === undefined || !assignable.has(name)) continue;
    for (const segment of script.segments) {
      const key = ttsCacheKey({
        baseUrl: project.tts.baseUrl,
        model: project.tts.model,
        voice: requiredSegmentVoice(cast, segment),
        speed: project.tts.speed,
        responseFormat: extension,
        text: segment.text,
      });
      const target = await cacheTarget(realm, key, extension);
      const info = await runtime.binary.stat(target);
      if (info === undefined || info.size <= 0) {
        issues.push({
          code: "segment-missing",
          message: `${name}还没有完整生成。`,
          path: segmentAudioPath(key, extension),
        });
      }
    }
  }

  return { issues, selected: ordered, scripts, assets, authorization, chars };
}

/**
 * 导出预检（只读）：返回 issues 而不是抛错，`ready` 为假时由调用方决定是否阻断。
 * `cost` 只按选中章节的脚本字符数统计；导出复用缓存，不产生新的 TTS 请求与费用。
 */
export async function preflightAudiobookExport(
  realm: WorkspaceRealm,
  record: AudiobookProjectRecord,
  runtime: AudiobookExportRuntime,
  formats: AudiobookExportFormats,
  chapters?: readonly string[],
): Promise<AudiobookExportPreflight> {
  const inspection = await inspectExport(realm, record, runtime, formats, chapters);
  return {
    ready: inspection.issues.length === 0,
    issues: inspection.issues,
    chapters: inspection.selected.length,
    cost: { chars: inspection.chars, requests: 0, estimatedCost: 0 },
  };
}

/** 发布清单的素材许可证与 provider 回执：只取选中章节 cue 实际引用的授权条目。 */
function releaseRights(
  project: AudiobookProject,
  selected: readonly string[],
  authorization: AudiobookAuthorizationRecord | undefined,
): { readonly licenses: readonly AudiobookManifestLicense[]; readonly providerReceipts: readonly AudiobookAssetProviderReceipt[] } {
  const selectedSet = new Set(selected);
  const used = new Set(
    project.cues.filter((cue) => selectedSet.has(cue.chapter)).map((cue) => cue.asset),
  );
  const entries = (authorization?.document.assets ?? []).filter((entry) => used.has(entry.path));
  const licenses = entries.map((entry) => ({
    path: entry.path,
    license: entry.license,
    attribution: entry.attribution,
  }));
  const providerReceipts: AudiobookAssetProviderReceipt[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.provider === undefined) continue;
    const key = entry.provider.receiptId ?? `${entry.provider.id}:${String(entry.provider.generatedAt)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    providerReceipts.push(entry.provider);
  }
  return { licenses, providerReceipts };
}

/**
 * 完整导出：重跑预检，未就绪时以第一条 issue 拒绝（ffmpeg 缺失 503，其余 409）。
 *
 * 全部章节先写 `.oh-story/audiobook/tmp/<uuid>/`：混音 → 两遍 loudnorm → MP3 →
 * 字幕，随后按整书时长拼 M4B；只有全部成功后才改名到 `音频/`、`字幕/`，最后
 * 复制到 `发布/` 并写清单。任何失败都不会把半成品放到最终路径；暂存文件在
 * `finally` 清理（已提升的文件只在最终路径，不会被清理）。
 */
export async function exportAudiobook(
  realm: WorkspaceRealm,
  record: AudiobookProjectRecord,
  runtime: AudiobookExportRuntime,
  formats: AudiobookExportFormats,
  chapters?: readonly string[],
): Promise<AudiobookExportFullResult> {
  const inspection = await inspectExport(realm, record, runtime, formats, chapters);
  if (inspection.issues.length > 0) {
    const first = inspection.issues[0];
    // inspectExport 至少产出一条 issue 才会进入这里；防御性兜底保持错误形状。
    if (first === undefined) throw new WorkspaceHttpError(500, "有声剧导出预检失败。");
    throw new WorkspaceHttpError(first.code === "ffmpeg-missing" ? 503 : 409, first.message);
  }

  const project = record.project;
  const effective = effectiveFormats(formats);
  const cast = resolveCast(project);
  const extension = audioExtension(project);
  const bookDirectory = bookDirectoryOf(record.path);
  const audioDirectory = `${bookDirectory}/${AUDIO_DIRECTORY}`;
  const subtitleDirectory = `${bookDirectory}/${SUBTITLE_DIRECTORY}`;
  const assetsByPath = new Map(inspection.assets.assets.map((asset) => [asset.path, asset]));
  const selected = inspection.selected;
  const jobKey = randomUUID();
  const staged: FsTarget[] = [];
  const chapterStages = new Map<string, ChapterStage>();
  const chapterEndMs = new Map<string, number>();
  const promotedMp3 = new Map<string, FsTarget>();
  const promotedSubtitles = new Map<string, Map<SubtitleFormat, FsTarget>>();
  let promotedM4b: FsTarget | undefined;
  let m4bDurationMs = 0;
  const resultFiles: { path: string; bytes: number }[] = [];

  const stage = async (relative: string): Promise<FsTarget> => {
    const target = await stagingTarget(realm, jobKey, relative);
    staged.push(target);
    return target;
  };
  /** 提升后的最终文件必须真实存在；返回字节数供响应使用。 */
  const finalBytes = async (target: FsTarget, path: string): Promise<number> => {
    const info = await runtime.binary.stat(target);
    if (info === undefined) throw new WorkspaceHttpError(500, `导出文件缺失：${path}`);
    return info.size;
  };

  try {
    for (const name of selected) {
      const script = inspection.scripts.get(name);
      if (script === undefined) throw new WorkspaceHttpError(409, `${name}还没有脚本，请先生成脚本。`);
      const keys = new Map<string, string>();
      const durations = new Map<string, number>();
      for (const segment of script.segments) {
        const key = ttsCacheKey({
          baseUrl: project.tts.baseUrl,
          model: project.tts.model,
          voice: requiredSegmentVoice(cast, segment),
          speed: project.tts.speed,
          responseFormat: extension,
          text: segment.text,
        });
        keys.set(segment.id, key);
        durations.set(segment.id, await measureCachedSegmentDuration(realm, runtime, key, extension));
      }
      const timeline = buildTimeline(script, durations);
      const endMs = timeline.at(-1)?.endMs ?? 0;
      chapterEndMs.set(name, endMs);

      const voicePaths: string[] = [];
      for (const segment of script.segments) {
        const key = keys.get(segment.id);
        if (key === undefined) throw new WorkspaceHttpError(500, "片段缓存键缺失。");
        const target = await cacheTarget(realm, key, extension);
        voicePaths.push(runtime.binary.processPath(target));
      }

      const cues: MixCue[] = [];
      for (const cue of project.cues.filter((candidate) => candidate.chapter === name)) {
        const asset = assetsByPath.get(cue.asset);
        if (asset === undefined) throw new WorkspaceHttpError(409, `cue ${cue.id} 引用的素材不存在。`);
        const target = await assetTarget(realm, bookDirectory, cue.asset);
        const assetDurationMs = asset.kind === "effect"
          ? await measureAudioDuration(runtime, realm, target)
          : 0;
        const window = cueWindow(cue, asset.kind, timeline, endMs, assetDurationMs);
        cues.push({
          id: cue.id,
          kind: asset.kind,
          assetPath: runtime.binary.processPath(target),
          startMs: window.startMs,
          endMs: window.endMs,
          fadeInMs: cue.fadeInMs,
          fadeOutMs: cue.fadeOutMs,
          gainDb: cue.gainDb,
          duckDb: cue.duckDb,
        });
      }

      const stageMix = await stage(`${STAGING_CHAPTER_DIRECTORY}/${name}/mix.wav`);
      const stageNormalized = await stage(`${STAGING_CHAPTER_DIRECTORY}/${name}/normalized.wav`);
      const stageMp3 = await stage(`${STAGING_CHAPTER_DIRECTORY}/${name}/chapter${MP3_EXTENSION}`);
      chapterStages.set(name, { mix: stageMix, normalized: stageNormalized, mp3: stageMp3, subtitles: new Map() });

      if (effective.mp3) {
        await runtime.binary.prepare(stageMix);
        const mix = buildMixArgs({
          voicePaths,
          timeline,
          chapterEndMs: endMs,
          cues,
          outputPath: runtime.binary.processPath(stageMix),
        });
        await runFfmpeg(runtime, mix.args, "混音");
        await assertStagedAudio(runtime, stageMix, "混音 WAV");

        const measured = await runFfmpeg(
          runtime,
          buildLoudnormMeasureArgs(runtime.binary.processPath(stageMix)),
          "响度测量",
        );
        const measurement = parseLoudnormMeasurement(measured.stderr);
        await runtime.binary.prepare(stageNormalized);
        await runFfmpeg(
          runtime,
          buildLoudnormApplyArgs(
            runtime.binary.processPath(stageMix),
            runtime.binary.processPath(stageNormalized),
            measurement,
          ),
          "响度归一",
        );
        await assertStagedAudio(runtime, stageNormalized, "归一 WAV");

        await runtime.binary.prepare(stageMp3);
        await runFfmpeg(
          runtime,
          buildChapterMp3Args(
            runtime.binary.processPath(stageNormalized),
            runtime.binary.processPath(stageMp3),
            project.export.mp3BitrateKbps,
          ),
          "编码 MP3",
        );
        await assertStagedAudio(runtime, stageMp3, "MP3");
      }

      if (effective.subtitles.length > 0) {
        const subtitleCues = buildSubtitleCues(timeline, script);
        const chapterStage = chapterStages.get(name);
        if (chapterStage === undefined) throw new WorkspaceHttpError(500, "章节暂存目录缺失。");
        for (const format of effective.subtitles) {
          const target = await stage(`${STAGING_CHAPTER_DIRECTORY}/${name}/chapter.${format}`);
          chapterStage.subtitles.set(format, target);
          await runtime.binary.prepare(target);
          await runtime.binary.write(
            target,
            new TextEncoder().encode(format === "srt" ? formatSrt(subtitleCues) : formatLrc(subtitleCues)),
          );
        }
      }
    }

    let stagedM4b: FsTarget | undefined;
    if (effective.m4b) {
      let cursor = 0;
      const m4bChapters: M4bChapter[] = [];
      for (const name of selected) {
        const endMs = cursor + (chapterEndMs.get(name) ?? 0);
        m4bChapters.push({ title: name, startMs: cursor, endMs });
        cursor = endMs;
      }
      m4bDurationMs = cursor;
      const concatTarget = await stage(`${STAGING_M4B_DIRECTORY}/concat${CONCAT_EXTENSION}`);
      const metadataTarget = await stage(`${STAGING_M4B_DIRECTORY}/metadata${CONCAT_EXTENSION}`);
      stagedM4b = await stage(`${STAGING_M4B_DIRECTORY}/book.m4b`);
      const lines: string[] = [];
      for (const name of selected) {
        const chapterStage = chapterStages.get(name);
        if (chapterStage === undefined) throw new WorkspaceHttpError(500, "章节暂存目录缺失。");
        lines.push(concatFileLine(runtime.binary.processPath(chapterStage.mp3)));
      }
      await runtime.binary.prepare(concatTarget);
      await runtime.binary.prepare(metadataTarget);
      await runtime.binary.prepare(stagedM4b);
      await runtime.binary.write(concatTarget, new TextEncoder().encode(`${lines.join("\n")}\n`));
      await runtime.binary.write(metadataTarget, new TextEncoder().encode(buildFfmetadata(m4bChapters)));

      const coverPath = await assertCover(realm, record.path);
      const coverTarget = await realm.fs.resolve(coverPath, { cwd: realm.cwd });
      await runFfmpeg(runtime, buildM4bArgs({
        concatListPath: runtime.binary.processPath(concatTarget),
        metadataPath: runtime.binary.processPath(metadataTarget),
        coverPath: runtime.binary.processPath(coverTarget),
        outputPath: runtime.binary.processPath(stagedM4b),
        title: projectDirectoryName(record.path),
      }), "M4B 合成");
      await assertStagedAudio(runtime, stagedM4b, "M4B");
    }

    // 提升：全部章节/M4B/字幕都成功后才改名到最终路径。
    if (effective.promoteMp3) {
      for (const name of selected) {
        const chapterStage = chapterStages.get(name);
        if (chapterStage === undefined) throw new WorkspaceHttpError(500, "章节暂存目录缺失。");
        const finalPath = chapterAudioPathFor(record.path, name);
        const target = await outputTarget(realm, audioDirectory, finalPath);
        await runtime.binary.prepare(target);
        await runtime.binary.rename(chapterStage.mp3, target);
        promotedMp3.set(name, target);
        resultFiles.push({ path: finalPath, bytes: await finalBytes(target, finalPath) });
      }
    }
    if (effective.subtitles.length > 0) {
      for (const name of selected) {
        const chapterStage = chapterStages.get(name);
        if (chapterStage === undefined) throw new WorkspaceHttpError(500, "章节暂存目录缺失。");
        const paths = subtitlePathsFor(record.path, name);
        const promoted = new Map<SubtitleFormat, FsTarget>();
        for (const format of effective.subtitles) {
          const stagedSubtitle = chapterStage.subtitles.get(format);
          if (stagedSubtitle === undefined) throw new WorkspaceHttpError(500, "字幕暂存文件缺失。");
          const target = await outputTarget(realm, subtitleDirectory, paths[format]);
          await runtime.binary.prepare(target);
          await runtime.binary.rename(stagedSubtitle, target);
          promoted.set(format, target);
          resultFiles.push({ path: paths[format], bytes: await finalBytes(target, paths[format]) });
        }
        promotedSubtitles.set(name, promoted);
      }
    }
    if (stagedM4b !== undefined) {
      const finalPath = bookM4bPathFor(record.path);
      const target = await outputTarget(realm, audioDirectory, finalPath);
      await runtime.binary.prepare(target);
      await runtime.binary.rename(stagedM4b, target);
      promotedM4b = target;
      resultFiles.push({ path: finalPath, bytes: await finalBytes(target, finalPath) });
    }

    let manifestPath: string | undefined;
    if (formats.package) {
      const releaseDirectory = releaseDirectoryFor(record.path);
      const releaseRoot = await realm.fs.resolve(releaseDirectory, { cwd: realm.cwd });
      const audiobookRoot = await realm.fs.resolve(AUDIOBOOK_ROOT, { cwd: realm.cwd });
      if (!realm.fs.contains(realm.root, releaseRoot) || !realm.fs.contains(audiobookRoot, releaseRoot)) {
        throw new WorkspaceHttpError(403, "发布目录离开了有声剧目录。");
      }
      const packageNames = new Set<string>();
      const manifestFiles: AudiobookManifestFile[] = [];
      const copyIntoPackage = async (source: FsTarget, name: string, durationMs: number | null): Promise<void> => {
        if (packageNames.has(name)) throw new WorkspaceHttpError(409, `发布包文件名重复：${name}`);
        packageNames.add(name);
        const path = `${releaseDirectory}/${name}`;
        const target = await realm.fs.resolve(path, { cwd: realm.cwd });
        if (!realm.fs.contains(releaseRoot, target)) throw new WorkspaceHttpError(403, "发布文件离开了发布目录。");
        await runtime.binary.prepare(target);
        await runtime.binary.copy(source, target);
        const info = await runtime.binary.stat(target);
        if (info === undefined) throw new WorkspaceHttpError(500, "发布文件复制失败。");
        const sha256 = await runtime.binary.hash(target);
        if (sha256 === undefined) throw new WorkspaceHttpError(500, "发布文件校验失败。");
        manifestFiles.push({ path: `${RELEASE_DIRECTORY}/${name}`, bytes: info.size, sha256, durationMs });
        resultFiles.push({ path, bytes: info.size });
      };

      for (const name of selected) {
        const mp3 = promotedMp3.get(name);
        if (mp3 !== undefined) await copyIntoPackage(mp3, `${name}${MP3_EXTENSION}`, chapterEndMs.get(name) ?? null);
        for (const format of effective.subtitles) {
          const subtitle = promotedSubtitles.get(name)?.get(format);
          if (subtitle !== undefined) await copyIntoPackage(subtitle, `${name}.${format}`, null);
        }
      }
      if (promotedM4b !== undefined) await copyIntoPackage(promotedM4b, BOOK_M4B_FILE, m4bDurationMs);
      const coverPath = await assertCover(realm, record.path);
      const coverTarget = await realm.fs.resolve(coverPath, { cwd: realm.cwd });
      await copyIntoPackage(coverTarget, COVER_FILE, null);

      const chapters: AudiobookManifestChapter[] = selected.map((name, index) => ({
        index: index + 1,
        title: name,
        audio: `${RELEASE_DIRECTORY}/${name}${MP3_EXTENSION}`,
        subtitles: effective.subtitles.map((format) => `${RELEASE_DIRECTORY}/${name}.${format}`),
      }));
      const rights = releaseRights(project, selected, inspection.authorization);
      const written = await writeReleaseManifest(realm, record, {
        files: [...manifestFiles].sort((left, right) => left.path.localeCompare(right.path, "zh-Hans-CN")),
        chapters,
        cost: { chars: inspection.chars, requests: 0, estimatedCost: 0 },
        licenses: rights.licenses,
        providerReceipts: rights.providerReceipts,
      });
      manifestPath = written.path;
    }

    return manifestPath === undefined ? { files: resultFiles } : { files: resultFiles, manifestPath };
  } finally {
    await Promise.all(staged.map((target) => runtime.binary.remove(target).catch(() => undefined)));
  }
}
