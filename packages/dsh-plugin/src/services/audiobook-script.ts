import { createHash } from "node:crypto";
import type { FsTarget, FsWriteIntent } from "@deepseek-ai/dsh-fs";
import { mapFsError, readVersionedFile, WorkspaceHttpError, type WorkspaceRealm } from "../workspace-route.js";
import {
  AUDIOBOOK_ROOT,
  AUDIOBOOK_SCHEMA_VERSION,
  type AudiobookProjectRecord,
  type AudiobookScript,
  type AudiobookScriptRecord,
  type AudiobookSegment,
} from "./audiobook-contract.js";

/**
 * 有声剧脚本：确定性章节切分与 `有声剧/<书>/脚本/<章节>.json` 持久化。
 *
 * 切分只做纯函数变换（段落 → 旁白/对白片段），同样的输入永远得到同样的片段
 * 编号与源偏移，便于缓存键与断点重跑；对白统一是 `unknown` 说话人，旁白固定
 * `narrator`，N4-A 不做角色识别。持久化沿用项目文档的 CAS 习惯：新建
 * `createIfAbsent`，覆盖 `replaceIfVersion`，已有脚本未确认时 409。
 */

export type { AudiobookScript, AudiobookScriptRecord, AudiobookSegment } from "./audiobook-contract.js";

/** 中文常用引号对：弯引号、直角引号、双直角引号。 */
const QUOTE_PAIRS = [
  ["“", "”"],
  ["「", "」"],
  ["『", "』"],
] as const;
const DIALOGUE_PATTERN = new RegExp(QUOTE_PAIRS.map(([open, close]) => `${open}([^${close}]*)${close}`).join("|"), "gu");
const SENTENCE_END = /[。！？!?…]/u;
const MAX_SEGMENT_CHARS = 2000;

const SCRIPT_DIRECTORY = "脚本";
const SCRIPT_EXTENSION = ".json";
const SOURCE_EXTENSION = ".md";
const SOURCE_MAX_BYTES = 4 * 1_024 * 1_024;
const SCRIPT_MAX_BYTES = 4 * 1_024 * 1_024;

const NARRATOR = "narrator";
const UNKNOWN_SPEAKER = "unknown";

/** 稳定片段编号：同一 (kind, speaker, text, sourceStart) 永远得到同一 id。 */
export function segmentId(kind: AudiobookSegment["kind"], speakerId: string, text: string, sourceStart: number): string {
  return `s-${createHash("sha256").update(`${kind}|${speakerId}|${text}|${String(sourceStart)}`, "utf8").digest("hex").slice(0, 12)}`;
}

/** 按空行切段，保留每段在源文本中的起始偏移。 */
function splitParagraphs(text: string): { text: string; start: number }[] {
  const paragraphs: { text: string; start: number }[] = [];
  const pattern = /\n\s*\n/gu;
  let start = 0;
  for (const match of text.matchAll(pattern)) {
    paragraphs.push({ text: text.slice(start, match.index), start });
    start = match.index + match[0].length;
  }
  paragraphs.push({ text: text.slice(start), start });
  return paragraphs;
}

/** 在句末标点后断句，标点归入前一句；没有标点的尾段单独成句。 */
function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (!SENTENCE_END.test(text[index] ?? "")) continue;
    sentences.push(text.slice(start, index + 1));
    start = index + 1;
  }
  if (start < text.length) sentences.push(text.slice(start));
  return sentences;
}

/** 超出单段上限时按句末标点累积；单个句子仍超限才硬切（硬切后偏移依旧连续）。 */
function splitLong(text: string): string[] {
  if (text.length <= MAX_SEGMENT_CHARS) return [text];
  const pieces: string[] = [];
  let current = "";
  const flush = (): void => {
    if (current === "") return;
    pieces.push(current);
    current = "";
  };
  for (const sentence of splitSentences(text)) {
    if (sentence.length > MAX_SEGMENT_CHARS) {
      flush();
      for (let offset = 0; offset < sentence.length; offset += MAX_SEGMENT_CHARS) {
        pieces.push(sentence.slice(offset, offset + MAX_SEGMENT_CHARS));
      }
      continue;
    }
    if (current.length + sentence.length > MAX_SEGMENT_CHARS) flush();
    current += sentence;
  }
  flush();
  return pieces;
}

/**
 * 章节正文 → 片段清单：段落内先摘引号对白，其余算旁白；裁剪空白与超长切分都
 * 保持 sourceStart/sourceEnd 指向源文本，输出顺序即阅读顺序。
 */
export function parseChapterText(text: string): AudiobookSegment[] {
  const out: AudiobookSegment[] = [];
  const push = (kind: AudiobookSegment["kind"], raw: string, start: number, speakerId: string): void => {
    const trimmed = raw.trim();
    if (trimmed === "") return;
    const offset = start + raw.indexOf(trimmed);
    let pieceOffset = 0;
    for (const piece of splitLong(trimmed)) {
      const pieceStart = offset + pieceOffset;
      out.push({ id: segmentId(kind, speakerId, piece, pieceStart), kind, speakerId, text: piece, sourceStart: pieceStart, sourceEnd: pieceStart + piece.length });
      pieceOffset += piece.length;
    }
  };

  for (const paragraph of splitParagraphs(text)) {
    let cursor = 0;
    for (const match of paragraph.text.matchAll(DIALOGUE_PATTERN)) {
      const index = match.index;
      push("narration", paragraph.text.slice(cursor, index), paragraph.start + cursor, NARRATOR);
      const inner = match.slice(1).find((group) => group !== undefined) ?? "";
      push("dialogue", inner, paragraph.start + index + 1, UNKNOWN_SPEAKER);
      cursor = index + match[0].length;
    }
    push("narration", paragraph.text.slice(cursor), paragraph.start + cursor, NARRATOR);
  }
  return out;
}

function hasControlCharacter(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** 与项目服务同一套相对路径判据：绝对路径、盘符、反斜杠、空段与 `..` 一律拒绝。 */
function workspacePathOrNull(raw: string): string | null {
  const text = raw.trim();
  if (text === "" || text.startsWith("/") || text.includes("\\") || /^[A-Za-z]:/u.test(text)) return null;
  const segments = text.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".." || hasControlCharacter(segment))) return null;
  return segments.join("/");
}

/** 项目路径的父目录名即书目名，脚本目录固定在 `有声剧/<书>/脚本/`。 */
function bookDirectoryOf(projectPath: string): string {
  const path = workspacePathOrNull(projectPath);
  if (path === null) throw new WorkspaceHttpError(400, "项目路径必须是工作区内的相对路径。");
  const segments = path.split("/");
  if (segments[0] !== AUDIOBOOK_ROOT) throw new WorkspaceHttpError(403, `有声剧脚本必须位于 ${AUDIOBOOK_ROOT}/ 目录下。`);
  if (segments.length < 3) throw new WorkspaceHttpError(400, "有声剧项目路径无效。");
  return segments.at(-2) ?? "";
}

/** 章节名就是脚本文件名（去掉 .json），不允许路径分隔符或控制字符。 */
function chapterName(raw: string): string {
  const chapter = raw.trim();
  if (chapter === "" || chapter === "." || chapter === "..") throw new WorkspaceHttpError(400, "章节名不能为空。");
  if (chapter.includes("/") || chapter.includes("\\") || hasControlCharacter(chapter)) throw new WorkspaceHttpError(400, "章节名不能包含路径分隔符。");
  return chapter;
}

function scriptDirectoryFor(projectPath: string): string {
  return `${AUDIOBOOK_ROOT}/${bookDirectoryOf(projectPath)}/${SCRIPT_DIRECTORY}`;
}

/** 脚本路径的唯一构造点：`有声剧/<书>/脚本/<章节>.json`。 */
export function scriptPathFor(projectPath: string, chapter: string): string {
  return `${scriptDirectoryFor(projectPath)}/${chapterName(chapter)}${SCRIPT_EXTENSION}`;
}

async function resolveInside(realm: WorkspaceRealm, path: string): Promise<FsTarget> {
  const target = await realm.fs.resolve(path, { cwd: realm.cwd });
  if (!realm.fs.contains(realm.root, target)) throw new WorkspaceHttpError(403, "路径离开了 DSH 工作目录。");
  return target;
}

async function scriptTarget(realm: WorkspaceRealm, projectPath: string, path: string): Promise<FsTarget> {
  const directory = await resolveInside(realm, scriptDirectoryFor(projectPath));
  const target = await realm.fs.resolve(path, { cwd: realm.cwd });
  if (!realm.fs.contains(realm.root, target) || !realm.fs.contains(directory, target)) {
    throw new WorkspaceHttpError(403, "脚本路径离开了有声剧脚本目录。");
  }
  return target;
}

function scriptInvalid(): WorkspaceHttpError {
  return new WorkspaceHttpError(422, "脚本格式无效。");
}

function asScriptObject(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw scriptInvalid();
  return value as Readonly<Record<string, unknown>>;
}

function scriptString(value: unknown): string {
  if (typeof value !== "string" || value === "") throw scriptInvalid();
  return value;
}

function scriptOffset(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw scriptInvalid();
  return value;
}

function segmentFromValue(value: unknown): AudiobookSegment {
  const record = asScriptObject(value);
  const kind = record["kind"];
  if (kind !== "narration" && kind !== "dialogue") throw scriptInvalid();
  const sourceStart = scriptOffset(record["sourceStart"]);
  const sourceEnd = scriptOffset(record["sourceEnd"]);
  if (sourceEnd < sourceStart) throw scriptInvalid();
  return {
    id: scriptString(record["id"]),
    kind,
    speakerId: scriptString(record["speakerId"]),
    text: scriptString(record["text"]),
    sourceStart,
    sourceEnd,
  };
}

/** 完整校验并重建脚本：只接受 schemaVersion 1，丢弃未知字段。 */
function normalizeScript(value: unknown): AudiobookScript {
  const record = asScriptObject(value);
  if (record["schemaVersion"] !== AUDIOBOOK_SCHEMA_VERSION) throw scriptInvalid();
  const rawSourcePath = record["sourcePath"];
  if (typeof rawSourcePath !== "string") throw scriptInvalid();
  const sourcePath = workspacePathOrNull(rawSourcePath);
  if (sourcePath === null) throw scriptInvalid();
  const segments = record["segments"];
  if (!Array.isArray(segments)) throw scriptInvalid();
  const values: readonly unknown[] = segments;
  return {
    schemaVersion: AUDIOBOOK_SCHEMA_VERSION,
    chapter: scriptString(record["chapter"]),
    sourcePath,
    sourceSha256: scriptString(record["sourceSha256"]),
    segments: values.map((segment) => segmentFromValue(segment)),
  };
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function serializeScript(script: AudiobookScript): string {
  return `${JSON.stringify(script, undefined, 2)}\n`;
}

function parseScriptDocument(content: string, chapter: string): AudiobookScript {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw scriptInvalid();
  }
  const script = normalizeScript(value);
  if (script.chapter !== chapter) throw new WorkspaceHttpError(422, "脚本章节与文件名不一致。");
  return script;
}

/**
 * 保存脚本：已有且 `overwrite` 为假返回 409；覆盖按读取到的版本做 CAS，磁盘
 * 版本已变化由 mapFsError 映射为 412；新建用 createIfAbsent，并发创建同样 409。
 */
export async function saveChapterScript(
  realm: WorkspaceRealm,
  projectPath: string,
  script: AudiobookScript,
  overwrite: boolean,
): Promise<AudiobookScriptRecord> {
  const chapter = chapterName(script.chapter);
  const path = scriptPathFor(projectPath, chapter);
  const normalized = normalizeScript({ ...script, chapter });
  const target = await scriptTarget(realm, projectPath, path);
  const existing = await realm.fs.stat(target);
  if (existing !== undefined && existing.type !== "file") throw new WorkspaceHttpError(415, "脚本路径不是普通文件。");
  if (existing !== undefined && !overwrite) throw new WorkspaceHttpError(409, "脚本已存在，覆盖需要确认。");
  const intent: FsWriteIntent = existing === undefined
    ? { kind: "createIfAbsent" }
    : { kind: "replaceIfVersion", version: existing.version };
  try {
    const outcome = await realm.fs.writeText(target, serializeScript(normalized), intent, undefined, undefined);
    return { script: normalized, path, version: String(outcome.version) };
  } catch (error) {
    const mapped = mapFsError(error);
    if (mapped?.status === 412 && intent.kind === "createIfAbsent") throw new WorkspaceHttpError(409, "脚本已存在，覆盖需要确认。");
    throw mapped ?? new WorkspaceHttpError(500, "脚本写入失败。");
  }
}

/** 读取脚本：缺失返回 undefined；坏 JSON、错误 schemaVersion 或章节不符返回 422。 */
export async function loadChapterScript(
  realm: WorkspaceRealm,
  projectPath: string,
  chapter: string,
): Promise<AudiobookScriptRecord | undefined> {
  const name = chapterName(chapter);
  const path = scriptPathFor(projectPath, name);
  const target = await scriptTarget(realm, projectPath, path);
  const file = await readVersionedFile(realm.fs, target, SCRIPT_MAX_BYTES).catch((error: unknown): undefined => {
    if (error instanceof WorkspaceHttpError && error.status === 404) return undefined;
    throw mapFsError(error) ?? error;
  });
  if (file === undefined) return undefined;
  return { script: parseScriptDocument(file.content, name), path, version: String(file.version) };
}

/**
 * 解析章节正文并落盘脚本：章节名取源文件名去掉 `.md`，sourceSha256 为正文
 * UTF-8 内容的 sha256；已存在脚本且未确认覆盖时返回 409。
 */
export async function parseChapterScript(
  realm: WorkspaceRealm,
  project: AudiobookProjectRecord,
  sourcePath: string,
  overwrite = false,
): Promise<AudiobookScriptRecord> {
  const path = workspacePathOrNull(sourcePath);
  if (path === null) throw new WorkspaceHttpError(400, "正文路径必须是工作区内的相对路径。");
  const target = await resolveInside(realm, path);
  const file = await readVersionedFile(realm.fs, target, SOURCE_MAX_BYTES);
  const name = path.slice(path.lastIndexOf("/") + 1);
  const chapter = chapterName(name.endsWith(SOURCE_EXTENSION) ? name.slice(0, -SOURCE_EXTENSION.length) : name);
  const script: AudiobookScript = {
    schemaVersion: AUDIOBOOK_SCHEMA_VERSION,
    chapter,
    sourcePath: path,
    sourceSha256: sha256(file.content),
    segments: parseChapterText(file.content),
  };
  return saveChapterScript(realm, project.path, script, overwrite);
}
