import type { FsTarget } from "@deepseek-ai/dsh-fs";
import { WorkspaceHttpError, type WorkspaceRealm } from "../workspace-route.js";
import { AUDIOBOOK_ROOT } from "./audiobook-contract.js";

/**
 * 有声剧 M4B（N4-C）：章节 ffmetadata 文本、ffmpeg 参数与封面断言。
 *
 * 纯构造模块：只返回文本与参数数组，不启动 ffmpeg、不写文件、不碰宿主状态；
 * Task 8 负责把清单/元数据/封面路径交给命令执行器并收尾。章节用毫秒时间基
 * （`TIMEBASE=1/1000`），起点终点直接来自章节 MP3 的实测时长累加；封面作为
 * `attached_pic` 视频流挂在 M4B 上，缺失时在导出前就 409，避免整本合成到
 * 最后一步才失败。
 */

const PROJECT_FILE = "project.json";
const AUDIO_DIRECTORY = "音频";
const COVER_DIRECTORY = "封面";
const COVER_FILE = "cover.jpg";
const BOOK_AUDIO_FILE = "全书.m4b";
const COVER_RELATIVE_PATH = `${COVER_DIRECTORY}/${COVER_FILE}`;
const METADATA_TIMEBASE = "1/1000";

/** 一段章节窗口：`title` 写进 ffmetadata，`startMs`/`endMs` 是整书绝对毫秒。 */
export interface M4bChapter {
  readonly title: string;
  readonly startMs: number;
  readonly endMs: number;
}

/** `buildM4bArgs` 的全部输入路径都由调用方（Task 8）换算成进程路径后传入。 */
export interface M4bArgsInput {
  readonly concatListPath: string;
  readonly metadataPath: string;
  readonly coverPath: string;
  readonly outputPath: string;
  readonly title: string;
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
 * 整本书 M4B 的唯一构造点：`有声剧/<书>/音频/全书.m4b`。只做路径推导，不读
 * 不写；Task 8 落盘前仍要按 DSH 路径策略确认目标留在工作区内。
 */
export function bookM4bPathFor(projectPath: string): string {
  return `${bookDirectoryOf(projectPath)}/${AUDIO_DIRECTORY}/${BOOK_AUDIO_FILE}`;
}

function chapterLabel(index: number): string {
  return `第 ${String(index + 1)} 章`;
}

/**
 * ffmetadata 的行首 `;` 开始注释、换行会截断条目：标题里的这两类字符一律
 * 换成空格；其余控制字符无法安全落盘，直接 400 而不是悄悄删掉。
 */
function chapterTitle(raw: string, index: number): string {
  const title = raw.replace(/\r\n/gu, " ").replace(/[\r\n;]/gu, " ").trim();
  if (hasControlCharacter(title)) throw new WorkspaceHttpError(400, `${chapterLabel(index)}标题不能包含控制字符。`);
  if (title === "") throw new WorkspaceHttpError(400, `${chapterLabel(index)}标题不能为空。`);
  return title;
}

/** 时间戳必须是有限、非负、整数毫秒：ffmetadata 的 START/END 只接受整数。 */
function milliseconds(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) throw new WorkspaceHttpError(400, `${label}必须是有限的非负整数毫秒。`);
  return value;
}

/**
 * 生成 ffmetadata 文本：`;FFMETADATA1` 头 + 每章一个 `[CHAPTER]` 段，毫秒
 * 时间基，末尾恰好一个换行。章节顺序保持入参顺序；起点晚于终点直接 400。
 */
export function buildFfmetadata(chapters: readonly M4bChapter[]): string {
  const lines = [";FFMETADATA1"];
  chapters.forEach((chapter, index) => {
    const label = chapterLabel(index);
    const startMs = milliseconds(chapter.startMs, `${label}起点`);
    const endMs = milliseconds(chapter.endMs, `${label}终点`);
    if (startMs > endMs) throw new WorkspaceHttpError(400, `${label}起点晚于终点。`);
    lines.push(
      "[CHAPTER]",
      `TIMEBASE=${METADATA_TIMEBASE}`,
      `START=${String(startMs)}`,
      `END=${String(endMs)}`,
      `title=${chapterTitle(chapter.title, index)}`,
    );
  });
  return `${lines.join("\n")}\n`;
}

function argumentPath(value: string, label: string): string {
  if (value.trim() === "") throw new WorkspaceHttpError(400, `${label}不能为空。`);
  if (hasControlCharacter(value)) throw new WorkspaceHttpError(400, `${label}不能包含控制字符。`);
  return value;
}

/** 书名写进 `-metadata title=`：去首尾空白，控制字符一律拒绝。 */
function bookTitle(raw: string): string {
  const title = raw.trim();
  if (title === "") throw new WorkspaceHttpError(400, "书名不能为空。");
  if (hasControlCharacter(title)) throw new WorkspaceHttpError(400, "书名不能包含控制字符。");
  return title;
}

/**
 * 构造整本书 M4B 的 ffmpeg 参数：concat 清单为输入 0、封面为输入 1、
 * ffmetadata 为输入 2；只取音频流与封面流，章节元数据来自输入 2，AAC 128k，
 * 封面以 `attached_pic` 附着，`+faststart` 让索引前置。数组参数，不经 shell。
 */
export function buildM4bArgs(input: M4bArgsInput): string[] {
  return [
    "-hide_banner",
    "-loglevel", "error",
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", argumentPath(input.concatListPath, "拼接清单路径"),
    "-i", argumentPath(input.coverPath, "封面路径"),
    "-f", "ffmetadata",
    "-i", argumentPath(input.metadataPath, "章节元数据路径"),
    "-map", "0:a",
    "-map", "1:v",
    "-map_metadata", "2",
    "-c:a", "aac",
    "-b:a", "128k",
    "-c:v", "mjpeg",
    "-disposition:v", "attached_pic",
    "-metadata", `title=${bookTitle(input.title)}`,
    "-movflags", "+faststart",
    argumentPath(input.outputPath, "M4B 输出路径"),
  ];
}

/** 解析封面目标并确认它仍在工作区内；离开工作区按 403 处理。 */
async function resolveInside(realm: WorkspaceRealm, path: string): Promise<FsTarget> {
  const target = await realm.fs.resolve(path, { cwd: realm.cwd });
  if (!realm.fs.contains(realm.root, target)) throw new WorkspaceHttpError(403, "封面路径离开了 DSH 工作目录。");
  return target;
}

/**
 * 封面闸门：`有声剧/<书>/封面/cover.jpg` 必须存在、是普通文件且非空，
 * 否则 409。返回工作区相对路径，供 Task 8 写入清单后交给 ffmpeg；本函数
 * 只 stat，不读内容、不校验图片格式。
 */
export async function assertCover(realm: WorkspaceRealm, projectPath: string): Promise<string> {
  const path = `${bookDirectoryOf(projectPath)}/${COVER_RELATIVE_PATH}`;
  const info = await realm.fs.stat(await resolveInside(realm, path));
  if (info === undefined || info.type !== "file" || info.size === undefined || info.size <= 0) {
    throw new WorkspaceHttpError(409, `缺少非空封面文件 ${path}，无法导出 M4B。`);
  }
  return path;
}
