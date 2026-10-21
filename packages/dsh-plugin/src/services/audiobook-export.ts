import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { FsTarget } from "@deepseek-ai/dsh-fs";
import { WorkspaceHttpError, type WorkspaceRealm } from "../workspace-route.js";
import type { BinaryFileStore } from "./audiobook-binary.js";
import { segmentAudioPath, ttsCacheKey, type CachedAudioExtension } from "./audiobook-cache.js";
import {
  AUDIOBOOK_CACHE_ROOT,
  AUDIOBOOK_ROOT,
  type AudiobookProject,
  type AudiobookProjectRecord,
  type AudiobookScript,
} from "./audiobook-contract.js";

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
const MP3_EXTENSION = ".mp3";
const CONCAT_EXTENSION = ".txt";
const PROBE_TIMEOUT_MS = 5_000;
/** ffmpeg/ffprobe 只接受单横线参数；`--version` 会以未知选项失败。 */
const PROBE_ARGUMENT = "-version";
/** 命令输出收集上限（stdout/stderr 各一份），避免失控进程撑爆宿主内存。 */
const COMMAND_OUTPUT_MAX_BYTES = 64 * 1_024;
const STDERR_TAIL_CHARS = 300;
const MP3_BITRATE = "192k";

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

/** N4-A 所有片段（含对白）都用旁白音色合成；缺旁白无法导出，返回 422。 */
function narratorVoice(project: AudiobookProject): string {
  const narrator = project.cast.find((member) => member.kind === "narrator");
  if (narrator === undefined || narrator.voice.trim() === "") {
    throw new WorkspaceHttpError(422, "有声剧项目缺少旁白音色。");
  }
  return narrator.voice;
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

/** 只保留单行、去重的 stderr 尾部，用于报错又不把整段日志塞给客户端。 */
function stderrTail(stderr: string): string {
  const compact = stderr.replace(/\s+/gu, " ").trim();
  if (compact === "") return "无错误输出";
  return compact.length <= STDERR_TAIL_CHARS ? compact : `…${compact.slice(compact.length - STDERR_TAIL_CHARS)}`;
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
  const voice = narratorVoice(project);
  const extension = audioExtension(project);
  if (script.segments.length === 0) throw new WorkspaceHttpError(409, `${name}还没有可导出的片段。`);

  const segmentTargets: FsTarget[] = [];
  for (const segment of script.segments) {
    const key = ttsCacheKey({
      baseUrl: project.tts.baseUrl,
      model: project.tts.model,
      voice,
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

    const ffmpeg = await runtime.runner.run("ffmpeg", [
      "-hide_banner",
      "-loglevel", "error",
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", runtime.binary.processPath(listTarget),
      "-c:a", "libmp3lame",
      "-b:a", MP3_BITRATE,
      runtime.binary.processPath(tempOutput),
    ]);
    if (ffmpeg.code !== 0) {
      throw new WorkspaceHttpError(500, `ffmpeg 导出失败：${stderrTail(ffmpeg.stderr)}`);
    }

    const stat = await runtime.binary.stat(tempOutput);
    if (stat === undefined || stat.size <= 0) throw new WorkspaceHttpError(500, "ffmpeg 没有写出有效的 MP3 文件。");

    const probe = await runtime.runner.run("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      runtime.binary.processPath(tempOutput),
    ]);
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
