import type { FsDirEntry, FsTarget, FsVersion } from "@deepseek-ai/dsh-fs";
import { mapFsError, readVersionedFile, WorkspaceHttpError, type WorkspaceRealm } from "../workspace-route.js";
import {
  AUDIOBOOK_ROOT,
  AUDIOBOOK_SCHEMA_VERSION,
  type AudiobookCastMember,
  type AudiobookCue,
  type AudiobookProject,
  type AudiobookProjectRecord,
  type AudiobookSource,
  type AudiobookTtsConfig,
} from "./audiobook-contract.js";

/**
 * 有声剧工程：书籍目录发现、项目路径/校验与 project.json 持久化。
 *
 * 项目文档落在 `有声剧/<名称>/project.json`，只写工作区内的领域数据；TTS 端点
 * 与模型随项目保存，密钥由运行时注入，项目 JSON 永不包含密钥字段。读取/保存
 * 都走 `realm.fs` 的版本身份（CAS），保存时 baseVersion 过期返回 412。
 */

const STORY_ROOT = "正文";
const PROJECT_FILE = "project.json";
const PROJECT_MAX_BYTES = 512 * 1_024;
const PROJECT_NAME_MAX_LENGTH = 64;
const TTS_RESPONSE_FORMATS = ["mp3", "wav"] as const;
const CAST_KINDS = ["narrator", "character"] as const;
const SUBTITLE_FORMATS = ["srt", "lrc"] as const;
/** 明文 http 仅允许本机回环；其他端点必须 https。 */
const LOOPBACK_TTS_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"]);

export interface AudiobookProjectInput {
  readonly bookRoot: string;
  readonly name: string;
  readonly voice: string;
  readonly baseUrl: string;
  readonly model: string;
}

const compareLabels = (left: string, right: string): number => left.localeCompare(right, "zh-Hans-CN");

function invalid(message: string): WorkspaceHttpError {
  return new WorkspaceHttpError(422, message);
}

function hasControlCharacter(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** 归一化工作区相对路径；绝对路径、盘符、反斜杠、空段与 `..` 一律拒绝。 */
function relativePathOrNull(raw: string): string | null {
  const text = raw.trim();
  if (text === "" || text.startsWith("/") || text.includes("\\") || /^[A-Za-z]:/u.test(text)) return null;
  const segments = text.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".." || hasControlCharacter(segment))) return null;
  return segments.join("/");
}

function safeRelativePath(raw: string): string {
  const path = relativePathOrNull(raw);
  if (path === null) throw new WorkspaceHttpError(400, "路径必须是工作区内的相对路径。");
  return path;
}

function projectRelativePath(value: unknown, label: string): string {
  if (typeof value !== "string") throw invalid(`${label} 必须是字符串路径。`);
  const path = relativePathOrNull(value);
  if (path === null) throw invalid(`${label} 必须是工作区内的相对路径。`);
  return path;
}

function requiredText(raw: string, label: string): string {
  const text = raw.trim();
  if (text === "") throw new WorkspaceHttpError(400, `缺少${label}。`);
  return text;
}

function projectName(raw: string): string {
  const name = raw.trim();
  if (name === "" || name === "." || name === "..") throw new WorkspaceHttpError(400, "有声剧名称不能为空。");
  if (name.length > PROJECT_NAME_MAX_LENGTH) throw new WorkspaceHttpError(400, "有声剧名称过长。");
  if (/[\\/:*?"<>|]/u.test(name) || hasControlCharacter(name)) throw new WorkspaceHttpError(400, "有声剧名称不能包含路径分隔符或文件系统保留字符。");
  if (/[. ]$/u.test(name)) throw new WorkspaceHttpError(400, "有声剧名称不能以点或空格结尾。");
  return name;
}

function projectPathFor(name: string): string {
  return `${AUDIOBOOK_ROOT}/${name}/${PROJECT_FILE}`;
}

async function resolveInside(realm: WorkspaceRealm, path: string): Promise<FsTarget> {
  const target = await realm.fs.resolve(path, { cwd: realm.cwd });
  if (!realm.fs.contains(realm.root, target)) throw new WorkspaceHttpError(403, "路径离开了 DSH 工作目录。");
  return target;
}

async function listDirectory(realm: WorkspaceRealm, target: FsTarget): Promise<readonly FsDirEntry[]> {
  const info = await realm.fs.stat(target);
  return info?.type === "directory" ? await realm.fs.listDir(target) : [];
}

function childDirectoryNames(entries: readonly FsDirEntry[], exclude: readonly string[]): string[] {
  return entries
    .filter((entry) => entry.type === "directory" && !entry.name.startsWith(".") && !exclude.includes(entry.name))
    .map((entry) => entry.name)
    .sort(compareLabels);
}

async function chapterPathsIn(realm: WorkspaceRealm, directory: string): Promise<string[]> {
  const entries = await listDirectory(realm, await resolveInside(realm, directory));
  return entries
    .filter((entry) => entry.type === "file" && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => `${directory}/${entry.name}`)
    .sort(compareLabels);
}

/** 书籍根自身直属章节优先；没有时再看它自己的 `正文/`（书根布局）。 */
async function chaptersUnder(realm: WorkspaceRealm, bookRoot: string): Promise<string[]> {
  const direct = await chapterPathsIn(realm, bookRoot);
  return direct.length > 0 ? direct : chapterPathsIn(realm, `${bookRoot}/${STORY_ROOT}`);
}

function workspaceLabel(realm: WorkspaceRealm): string {
  const parts = realm.root.displayPath.split(/[\\/]+/u).filter((part) => part !== "");
  return parts.at(-1) ?? STORY_ROOT;
}

/**
 * 书籍目录发现（不使用 `.active-book`）：
 * a) `正文/` 直属章节 → bookRoot `正文`；
 * b) 根级目录内含 `正文/` 章节 → bookRoot `<目录>`；
 * c) `正文/<目录>/` 内直属章节或其自带 `正文/` 章节 → bookRoot `正文/<目录>`。
 */
export async function listAudiobookSources(realm: WorkspaceRealm): Promise<AudiobookSource[]> {
  const sources: AudiobookSource[] = [];
  const storyChapters = await chaptersUnder(realm, STORY_ROOT);
  if (storyChapters.length > 0) sources.push({ bookRoot: STORY_ROOT, name: workspaceLabel(realm), chapters: storyChapters });
  for (const name of childDirectoryNames(await listDirectory(realm, realm.root), [STORY_ROOT, AUDIOBOOK_ROOT])) {
    const chapters = await chaptersUnder(realm, name);
    if (chapters.length > 0) sources.push({ bookRoot: name, name, chapters });
  }
  const storyRoot = await resolveInside(realm, STORY_ROOT);
  for (const name of childDirectoryNames(await listDirectory(realm, storyRoot), [])) {
    const bookRoot = `${STORY_ROOT}/${name}`;
    const chapters = await chaptersUnder(realm, bookRoot);
    if (chapters.length > 0) sources.push({ bookRoot, name, chapters });
  }
  return sources.sort((left, right) => compareLabels(left.bookRoot, right.bookRoot));
}

/** 书籍根下的章节清单（`正文` 直属章节，或书根自带 `正文/` 的章节）。 */
export async function listChapterPaths(realm: WorkspaceRealm, bookRoot: string): Promise<string[]> {
  return chaptersUnder(realm, safeRelativePath(bookRoot));
}

/** 校验 TTS 端点：仅 https 或回环 http，禁止内嵌凭证、query 与 hash。 */
export function validateTtsBaseUrl(raw: string): string {
  const text = raw.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new WorkspaceHttpError(400, "TTS 端点不是有效 URL，必须使用 https 地址。");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new WorkspaceHttpError(400, "TTS 端点必须使用 https 地址。");
  if (url.username !== "" || url.password !== "") throw new WorkspaceHttpError(400, "TTS 端点不能内嵌凭证。");
  if (url.search !== "") throw new WorkspaceHttpError(400, "TTS 端点不能带 query 参数。");
  if (url.hash !== "") throw new WorkspaceHttpError(400, "TTS 端点不能带 hash 片段。");
  if (url.protocol === "http:" && !LOOPBACK_TTS_HOSTS.has(url.hostname)) {
    throw new WorkspaceHttpError(400, "明文 http 只允许本机回环地址，其他端点必须使用 https。");
  }
  return text;
}

type JsonRecord = Readonly<Record<string, unknown>>;

function asRecord(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid(`${label} 必须是对象。`);
  return value as JsonRecord;
}

function asArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw invalid(`${label} 必须是数组。`);
  return value;
}

function asText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw invalid(`${label} 必须是非空字符串。`);
  return value;
}

function asFinite(value: unknown, label: string, accept: (candidate: number) => boolean = () => true): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !accept(value)) throw invalid(`${label} 不是有效数字。`);
  return value;
}

function asInteger(value: unknown, label: string, minimum: number): number {
  return asFinite(value, label, (candidate) => Number.isSafeInteger(candidate) && candidate >= minimum);
}

function asChoice<T extends string>(value: unknown, options: readonly T[], label: string): T {
  if (typeof value !== "string") throw invalid(`${label} 必须是字符串。`);
  const found = options.find((option) => option === value);
  if (found === undefined) throw invalid(`${label} 取值不受支持。`);
  return found;
}

function parseTts(value: unknown): AudiobookTtsConfig {
  const tts = asRecord(value, "tts");
  return {
    baseUrl: validateTtsBaseUrl(asText(tts["baseUrl"], "tts.baseUrl")),
    model: asText(tts["model"], "tts.model"),
    responseFormat: asChoice(tts["responseFormat"], TTS_RESPONSE_FORMATS, "tts.responseFormat"),
    speed: asFinite(tts["speed"], "tts.speed", (candidate) => candidate > 0),
    pricePerMillionChars: asFinite(tts["pricePerMillionChars"], "tts.pricePerMillionChars", (candidate) => candidate >= 0),
    maxCharsPerChapter: asInteger(tts["maxCharsPerChapter"], "tts.maxCharsPerChapter", 1),
    concurrency: asInteger(tts["concurrency"], "tts.concurrency", 1),
  };
}

function parseCast(value: unknown): readonly AudiobookCastMember[] {
  return asArray(value, "cast").map((item, index) => {
    const member = asRecord(item, `cast[${index}]`);
    return {
      id: asText(member["id"], `cast[${index}].id`),
      name: asText(member["name"], `cast[${index}].name`),
      kind: asChoice(member["kind"], CAST_KINDS, `cast[${index}].kind`),
      voice: asText(member["voice"], `cast[${index}].voice`),
    };
  });
}

function parseCues(value: unknown): readonly AudiobookCue[] {
  return asArray(value, "cues").map((item, index) => {
    const cue = asRecord(item, `cues[${index}]`);
    return {
      id: asText(cue["id"], `cues[${index}].id`),
      chapter: projectRelativePath(cue["chapter"], `cues[${index}].chapter`),
      asset: projectRelativePath(cue["asset"], `cues[${index}].asset`),
      startSegment: asText(cue["startSegment"], `cues[${index}].startSegment`),
      offsetMs: asInteger(cue["offsetMs"], `cues[${index}].offsetMs`, 0),
      fadeInMs: asInteger(cue["fadeInMs"], `cues[${index}].fadeInMs`, 0),
      fadeOutMs: asInteger(cue["fadeOutMs"], `cues[${index}].fadeOutMs`, 0),
      gainDb: asFinite(cue["gainDb"], `cues[${index}].gainDb`),
      duckDb: asFinite(cue["duckDb"], `cues[${index}].duckDb`),
    };
  });
}

function parseExport(value: unknown): AudiobookProject["export"] {
  const output = asRecord(value, "export");
  return {
    mp3BitrateKbps: asInteger(output["mp3BitrateKbps"], "export.mp3BitrateKbps", 8),
    sampleRate: asInteger(output["sampleRate"], "export.sampleRate", 8_000),
    channels: asInteger(output["channels"], "export.channels", 1),
    loudnessLufs: asFinite(output["loudnessLufs"], "export.loudnessLufs"),
    truePeakDbtp: asFinite(output["truePeakDbtp"], "export.truePeakDbtp"),
    subtitles: asArray(output["subtitles"], "export.subtitles").map((item, index) =>
      asChoice(item, SUBTITLE_FORMATS, `export.subtitles[${index}]`)),
  };
}

function parseRights(value: unknown): { readonly voiceCloning: false } {
  const rights = asRecord(value, "rights");
  if (rights["voiceCloning"] !== false) throw invalid("rights.voiceCloning 必须为 false。");
  return { voiceCloning: false };
}

/** 完整校验并重建项目文档：只接受 schemaVersion 1，丢弃未知字段。 */
function validateProject(value: unknown): AudiobookProject {
  const record = asRecord(value, "项目");
  if (record["schemaVersion"] !== AUDIOBOOK_SCHEMA_VERSION) throw invalid("有声剧项目 schemaVersion 必须为 1。");
  const source = asRecord(record["source"], "source");
  const chapters = asArray(source["chapters"], "source.chapters").map((item, index) => {
    const path = projectRelativePath(item, `source.chapters[${index}]`);
    if (!path.toLowerCase().endsWith(".md")) throw invalid(`source.chapters[${index}] 必须是 .md 章节文件。`);
    return path;
  });
  return {
    schemaVersion: AUDIOBOOK_SCHEMA_VERSION,
    source: { bookRoot: projectRelativePath(source["bookRoot"], "source.bookRoot"), chapters },
    tts: parseTts(record["tts"]),
    cast: parseCast(record["cast"]),
    cues: parseCues(record["cues"]),
    export: parseExport(record["export"]),
    rights: parseRights(record["rights"]),
  };
}

function serializeProject(project: AudiobookProject): string {
  return `${JSON.stringify(project, undefined, 2)}\n`;
}

async function projectTarget(realm: WorkspaceRealm, raw: string): Promise<{ readonly path: string; readonly target: FsTarget }> {
  const path = safeRelativePath(raw);
  if (!path.startsWith(`${AUDIOBOOK_ROOT}/`)) throw new WorkspaceHttpError(403, `有声剧项目必须位于 ${AUDIOBOOK_ROOT}/ 目录下。`);
  return { path, target: await resolveInside(realm, path) };
}

/**
 * 在书籍根上创建项目：章节清单取创建时的完整发现结果，TTS 默认 mp3/1x，
 * 价格 15 元/百万字符、单章 2 万字符、并发 2，导出 192kbps/44.1kHz/立体声
 * -16 LUFS/-1.5 dBTP，无 cue、无字幕、不允许声音克隆。已存在返回 409。
 */
export async function createAudiobookProject(realm: WorkspaceRealm, input: AudiobookProjectInput): Promise<AudiobookProjectRecord> {
  const name = projectName(input.name);
  const bookRoot = safeRelativePath(input.bookRoot);
  const source = (await listAudiobookSources(realm)).find((candidate) => candidate.bookRoot === bookRoot);
  if (source === undefined) throw new WorkspaceHttpError(404, "未找到可用的书籍目录。");
  const project: AudiobookProject = {
    schemaVersion: AUDIOBOOK_SCHEMA_VERSION,
    source: { bookRoot, chapters: source.chapters },
    tts: {
      baseUrl: validateTtsBaseUrl(input.baseUrl),
      model: requiredText(input.model, "模型名称"),
      responseFormat: "mp3",
      speed: 1,
      pricePerMillionChars: 15,
      maxCharsPerChapter: 20_000,
      concurrency: 2,
    },
    cast: [{ id: "narrator", name: "旁白", kind: "narrator", voice: requiredText(input.voice, "旁白音色") }],
    cues: [],
    export: { mp3BitrateKbps: 192, sampleRate: 44_100, channels: 2, loudnessLufs: -16, truePeakDbtp: -1.5, subtitles: [] },
    rights: { voiceCloning: false },
  };
  const path = projectPathFor(name);
  const target = await resolveInside(realm, path);
  try {
    const outcome = await realm.fs.writeText(target, serializeProject(project), { kind: "createIfAbsent" }, undefined, undefined);
    return { project, path, version: String(outcome.version) };
  } catch (error) {
    const mapped = mapFsError(error);
    if (mapped?.status === 412) throw new WorkspaceHttpError(409, "有声剧项目已存在。");
    throw mapped ?? new WorkspaceHttpError(500, "有声剧项目写入失败。");
  }
}

/** 读取 `有声剧/` 下的项目文档；离开该目录 403，schemaVersion 不是 1 时 422。 */
export async function loadAudiobookProject(realm: WorkspaceRealm, path: string): Promise<AudiobookProjectRecord> {
  const resolved = await projectTarget(realm, path);
  try {
    const file = await readVersionedFile(realm.fs, resolved.target, PROJECT_MAX_BYTES);
    const value: unknown = JSON.parse(file.content);
    return { project: validateProject(value), path: resolved.path, version: String(file.version) };
  } catch (error) {
    const mapped = mapFsError(error);
    if (mapped !== undefined) throw mapped;
    if (error instanceof SyntaxError) throw invalid("有声剧项目不是有效的 JSON。");
    throw error;
  }
}

/** 以 baseVersion 做 CAS 保存；磁盘版本已变化由 mapFsError 映射为 412。 */
export async function saveAudiobookProject(
  realm: WorkspaceRealm,
  path: string,
  project: AudiobookProject,
  baseVersion: string,
): Promise<AudiobookProjectRecord> {
  const resolved = await projectTarget(realm, path);
  const version = baseVersion.trim();
  if (version === "") throw new WorkspaceHttpError(400, "缺少基础版本号。");
  const normalized = validateProject(project);
  try {
    const outcome = await realm.fs.writeText(
      resolved.target,
      serializeProject(normalized),
      { kind: "replaceIfVersion", version: version as FsVersion },
      undefined,
      undefined,
    );
    return { project: normalized, path: resolved.path, version: String(outcome.version) };
  } catch (error) {
    const mapped = mapFsError(error);
    throw mapped ?? new WorkspaceHttpError(500, "有声剧项目写入失败。");
  }
}

/**
 * 枚举 `有声剧/` 下每个目录的 project.json：缺少项目文件的目录跳过；存在但读取/
 * 校验失败的目录进 errors，不因单个坏文件丢掉整份清单。
 */
export async function listAudiobookProjects(
  realm: WorkspaceRealm,
): Promise<{ projects: AudiobookProjectRecord[]; errors: { path: string; message: string }[] }> {
  const projects: AudiobookProjectRecord[] = [];
  const errors: { path: string; message: string }[] = [];
  const root = await realm.fs.resolve(AUDIOBOOK_ROOT, { cwd: realm.cwd });
  if (!realm.fs.contains(realm.root, root)) return { projects, errors };
  for (const name of childDirectoryNames(await listDirectory(realm, root), [])) {
    const path = `${AUDIOBOOK_ROOT}/${name}/${PROJECT_FILE}`;
    try {
      projects.push(await loadAudiobookProject(realm, path));
    } catch (error) {
      if (error instanceof WorkspaceHttpError && error.status === 404) continue;
      errors.push({ path, message: error instanceof Error ? error.message : String(error) });
    }
  }
  projects.sort((left, right) => compareLabels(left.path, right.path));
  errors.sort((left, right) => compareLabels(left.path, right.path));
  return { projects, errors };
}
