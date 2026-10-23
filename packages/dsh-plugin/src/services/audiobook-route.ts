import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import {
  jsonBody,
  mediaMimeTypeForPath,
  send,
  workspaceRealm,
  WorkspaceHttpError,
  type WorkspaceRealm,
  type WorkspaceRouteOptions,
} from "../workspace-route.js";
import { resolveCast, unassignedSegmentsIn } from "./audiobook-cast.js";
import {
  COMFYUI_ASSET_PROVIDER_ID,
  LocalAssetProvider,
  bookDirectoryForProject,
  defaultAssetProviders,
  validateGeneratedAssets,
  type AudioAssetGenerationFile,
  type AudioAssetGenerationRequest,
  type AudioAssetProvider,
} from "./audiobook-asset-provider.js";
import {
  listAudiobookAssets,
  loadAssetAuthorizations,
  saveAssetAuthorizations,
} from "./audiobook-assets.js";
import { hostBinaryFileStore } from "./audiobook-binary.js";
import {
  AUDIOBOOK_ACTIVE_JOB_STATUSES,
  AUDIOBOOK_CACHE_ROOT,
  AUDIOBOOK_ROUTES,
  type AudiobookAssetGenerationPreview,
  type AudiobookAssetGenerationResponse,
  type AudiobookAssetAuthorizationDocument,
  type AudiobookAuthorizationRecord,
  type AudiobookAssetKind,
  type AudiobookAssetProviderReceipt,
  type AudiobookAssetProviderSummary,
  type AudiobookAssignment,
  type AudiobookChapterSummary,
  type AudiobookExportFormats,
  type AudiobookJob,
  type AudiobookOverview,
  type AudiobookPreflight,
  type AudiobookProject,
  type AudiobookProjectRecord,
  type AudiobookProjectSummary,
  type AudiobookProjectView,
} from "./audiobook-contract.js";
import {
  chapterAudioPathFor,
  exportAudiobook,
  exportChapterMp3,
  hostCommandRunner,
  preflightAudiobookExport,
  probeTool,
  type CommandRunner,
} from "./audiobook-export.js";
import {
  cancelAudiobookJob,
  createChapterJob,
  isAudiobookJobInFlight,
  listAudiobookJobs,
  loadAudiobookJob,
  markAudiobookJobFailed,
  planChapterJob,
  runChapterJob,
  type AudiobookJobRuntime,
} from "./audiobook-jobs.js";
import {
  createAudiobookProject,
  listAudiobookProjects,
  listAudiobookSources,
  loadAudiobookProject,
  saveAudiobookProject,
  validateTtsBaseUrl,
} from "./audiobook-project.js";
import { registerWorkspaceExtension } from "./registry.js";
import { assignChapterSpeakers, loadChapterScript, parseChapterScript, scriptPathFor, assertScriptSourceFresh } from "./audiobook-script.js";
import { OpenAiCompatibleTtsClient } from "./audiobook-tts.js";

/**
 * 有声剧宿主路由。
 *
 * 概览/项目/脚本/任务/导出全部走 `/oh-story/audiobook/*`；GET 路由只读工作区，
 * 启动任务、恢复任务与导出都会产生外部副作用（TTS 费用或文件写入），必须
 * `confirm: true`。密钥只从运行时环境读取，任何请求体里出现密钥字段一律 400。
 * 路由本身不实现业务规则，校验与持久化全部交给 audiobook-* 服务。
 */

const BODY_LIMIT = 64 * 1_024;
/** PUT assets 直接提交整份授权文档：512 KiB 上限（与 audiobook-assets 一致）+ 64 KiB JSON 外壳余量。 */
const ASSET_DOCUMENT_BODY_LIMIT = 512 * 1_024 + 64 * 1_024;
/** 与缓存模块一致的读取上限（50 MiB）；超出按不存在处理。 */
const SEGMENT_AUDIO_MAX_BYTES = 50 * 1_024 * 1_024;
const TTS_KEY_ENV = "OH_STORY_TTS_API_KEY";
const TTS_BASE_URL_ENV = "OH_STORY_TTS_BASE_URL";
const TTS_MODEL_ENV = "OH_STORY_TTS_MODEL";
const SECRET_KEY_PATTERN = /api.?key|authorization|token|secret/iu;
const JOB_ROUTE = /^\/oh-story\/audiobook\/jobs\/([^/]+)(?:\/(cancel|run))?$/u;
const SOURCE_EXTENSION = ".md";

export interface AudiobookRuntime extends AudiobookJobRuntime {
  readonly runner: CommandRunner;
}

export interface AudiobookRouteDeps {
  readonly runtime?: (realm: WorkspaceRealm) => AudiobookRuntime;
  readonly runJob?: (realm: WorkspaceRealm, jobId: string, runtime: AudiobookRuntime) => Promise<unknown>;
  /** 素材生成 provider（测试注入假实现）；缺省用 ComfyUI provider。 */
  readonly assetProvider?: (realm: WorkspaceRealm, runtime: AudiobookRuntime) => Promise<AudioAssetProvider>;
}

/** 生产运行时：宿主 TTS 客户端、宿主二进制通道、宿主进程命令与进程环境。 */
export function createAudiobookRuntime(
  realm: WorkspaceRealm,
  env: Readonly<Record<string, string | undefined>> = process.env,
): AudiobookRuntime {
  return {
    tts: new OpenAiCompatibleTtsClient(),
    binary: hostBinaryFileStore(realm),
    runner: hostCommandRunner(),
    now: Date.now,
    env,
  };
}

function runtimeOf(realm: WorkspaceRealm, deps: AudiobookRouteDeps): AudiobookRuntime {
  return (deps.runtime ?? createAudiobookRuntime)(realm);
}

/** 环境变量里的 `OH_STORY_TTS_BASE_URL` 只在预检里展示主机名；非法或缺失都为 null。 */
function hostFromEnv(env: Readonly<Record<string, string | undefined>>): string | null {
  const raw = (env[TTS_BASE_URL_ENV] ?? "").trim();
  if (raw === "") return null;
  try {
    return new URL(validateTtsBaseUrl(raw)).host;
  } catch {
    return null;
  }
}

async function preflightFor(runtime: AudiobookRuntime): Promise<AudiobookPreflight> {
  const [ffmpeg, ffprobe] = await Promise.all([
    probeTool(runtime.runner, "ffmpeg"),
    probeTool(runtime.runner, "ffprobe"),
  ]);
  return {
    ttsKey: (runtime.env[TTS_KEY_ENV] ?? "").trim() === "" ? "missing" : "present",
    ttsHost: hostFromEnv(runtime.env),
    ffmpeg,
    ffprobe,
  };
}

/** 递归拒绝密钥字段：密钥只从宿主环境读取，请求体永远不允许出现。 */
function assertNoSecretKeys(value: unknown, label: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertNoSecretKeys(item, `${label}[${String(index)}]`);
    });
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      throw new WorkspaceHttpError(400, `请求体不能包含密钥字段（${label}.${key}），TTS 密钥只从宿主环境读取。`);
    }
    assertNoSecretKeys(child, `${label}.${key}`);
  }
}

function requiredString(body: Readonly<Record<string, unknown>>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim() === "") throw new WorkspaceHttpError(400, `缺少 ${key}。`);
  return value.trim();
}

/** 指派请求只接受 `{ segmentId, speakerId }[]`；业务校验（片段/角色是否存在）留给脚本服务。 */
function assignmentList(value: unknown): readonly AudiobookAssignment[] {
  if (!Array.isArray(value) || value.length === 0) throw new WorkspaceHttpError(400, "assignments 必须是非空数组。");
  return value.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new WorkspaceHttpError(400, `assignments[${String(index)}] 必须是对象。`);
    }
    const record = item as Readonly<Record<string, unknown>>;
    const segmentId = record["segmentId"];
    const speakerId = record["speakerId"];
    if (typeof segmentId !== "string" || segmentId.trim() === "") {
      throw new WorkspaceHttpError(400, `assignments[${String(index)}].segmentId 必须是非空字符串。`);
    }
    if (typeof speakerId !== "string" || speakerId.trim() === "") {
      throw new WorkspaceHttpError(400, `assignments[${String(index)}].speakerId 必须是非空字符串。`);
    }
    return { segmentId: segmentId.trim(), speakerId: speakerId.trim() };
  });
}

/**
 * 可选字符串字段：请求体优先，缺省（未提供或空串）时回退宿主环境变量；
 * 两处都没有值时返回 400，错误里同时点出字段名与环境变量名。
 */
function optionalString(
  body: Readonly<Record<string, unknown>>,
  key: string,
  env: Readonly<Record<string, string | undefined>>,
  envKey: string,
): string {
  const raw = body[key];
  if (raw !== undefined && typeof raw !== "string") throw new WorkspaceHttpError(400, `${key} 必须是字符串。`);
  const fromBody = typeof raw === "string" ? raw.trim() : "";
  const value = fromBody !== "" ? fromBody : (env[envKey] ?? "").trim();
  if (value === "") {
    throw new WorkspaceHttpError(400, `缺少 ${key}：请在请求体提供，或设置环境变量 ${envKey}。`);
  }
  return value;
}

function projectNameOf(path: string): string {
  const segments = path.split("/");
  return segments.length >= 3 ? (segments.at(-2) ?? path) : path;
}

/** 章节名就是源文件名去掉 `.md`，与脚本/任务/导出服务的命名约定一致。 */
function chapterNameOf(sourcePath: string): string {
  const name = sourcePath.slice(sourcePath.lastIndexOf("/") + 1);
  return name.endsWith(SOURCE_EXTENSION) ? name.slice(0, -SOURCE_EXTENSION.length) : name;
}

function latestJob(
  jobs: readonly AudiobookJob[],
  projectPath: string,
  chapter: string,
): AudiobookJob | undefined {
  return jobs
    .filter((job) => job.projectPath === projectPath && job.chapter === chapter)
    .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))[0];
}

/** 同一项目+章节上除当前任务外的排队/运行/暂停任务；恢复前用它拦住重复计费。 */
function otherActiveJob(jobs: readonly AudiobookJob[], current: AudiobookJob): AudiobookJob | undefined {
  return jobs.find((job) => job.id !== current.id
    && job.projectPath === current.projectPath
    && job.chapter === current.chapter
    && AUDIOBOOK_ACTIVE_JOB_STATUSES.includes(job.status));
}

async function chapterSummaries(realm: WorkspaceRealm, record: AudiobookProjectRecord): Promise<AudiobookChapterSummary[]> {
  const jobs = await listAudiobookJobs(realm);
  const cast = resolveCast(record.project);
  const summaries: AudiobookChapterSummary[] = [];
  for (const sourcePath of record.project.source.chapters) {
    const chapter = chapterNameOf(sourcePath);
    const scriptPath = scriptPathFor(record.path, chapter);
    const scriptInfo = await realm.fs.stat(await realm.fs.resolve(scriptPath, { cwd: realm.cwd }));
    const hasScript = scriptInfo?.type === "file";
    let segmentCount = 0;
    let unassignedSegments = 0;
    let scriptError: string | undefined;
    if (hasScript) {
      try {
        const script = await loadChapterScript(realm, record.path, chapter);
        segmentCount = script?.script.segments.length ?? 0;
        unassignedSegments = script === undefined ? 0 : unassignedSegmentsIn(cast, script.script).length;
      } catch (error) {
        // 单章脚本损坏只降级该章摘要，不拖垮整个项目视图；其余错误照常上抛。
        if (!(error instanceof WorkspaceHttpError) || error.status !== 422) throw error;
        scriptError = error.message;
      }
    }
    const audioPath = chapterAudioPathFor(record.path, chapter);
    const audioInfo = await realm.fs.stat(await realm.fs.resolve(audioPath, { cwd: realm.cwd }));
    const job = latestJob(jobs, record.path, chapter);
    summaries.push({
      sourcePath,
      chapter,
      scriptPath,
      hasScript,
      segmentCount,
      unassignedSegments,
      ...(scriptError === undefined ? {} : { scriptError }),
      audioPath: audioInfo?.type === "file" ? audioPath : null,
      jobId: job?.id ?? null,
      jobStatus: job?.status ?? null,
    });
  }
  return summaries;
}

async function buildProjectView(
  realm: WorkspaceRealm,
  runtime: AudiobookRuntime,
  path: string,
): Promise<AudiobookProjectView> {
  const record = await loadAudiobookProject(realm, path);
  const [chapters, preflight] = await Promise.all([chapterSummaries(realm, record), preflightFor(runtime)]);
  return { record, chapters, preflight };
}

async function buildOverview(realm: WorkspaceRealm, runtime: AudiobookRuntime): Promise<AudiobookOverview> {
  const [listing, sources, preflight] = await Promise.all([
    listAudiobookProjects(realm),
    listAudiobookSources(realm),
    preflightFor(runtime),
  ]);
  const projects: AudiobookProjectSummary[] = listing.projects.map((record) => ({
    path: record.path,
    name: projectNameOf(record.path),
    bookRoot: record.project.source.bookRoot,
    chapters: record.project.source.chapters.length,
  }));
  return { projects, sources, errors: listing.errors, preflight };
}

/** 启动后台任务：错误只写日志，已返回的 202 不因异步失败改成 5xx。 */
function launchJob(
  context: Context,
  realm: WorkspaceRealm,
  jobId: string,
  runtime: AudiobookRuntime,
  deps: AudiobookRouteDeps,
): void {
  const run = deps.runJob ?? ((targetRealm, id, targetRuntime) => runChapterJob(targetRealm, id, targetRuntime));
  void run(realm, jobId, runtime).catch((error: unknown) => {
    context.logger("oh-story").error(`audiobook job ${jobId} failed`, error);
  });
}

function segmentAudioMimeType(path: string): string {
  const mimeType = mediaMimeTypeForPath(path);
  if (mimeType === undefined || !mimeType.startsWith("audio/")) {
    throw new WorkspaceHttpError(415, "目标不是可播放的音频文件。");
  }
  return mimeType;
}

async function sendSegmentAudio(
  response: ServerResponse,
  realm: WorkspaceRealm,
  runtime: AudiobookRuntime,
  rawPath: string,
): Promise<void> {
  const cacheRoot = await realm.fs.resolve(AUDIOBOOK_CACHE_ROOT, { cwd: realm.cwd });
  if (!realm.fs.contains(realm.root, cacheRoot)) {
    throw new WorkspaceHttpError(403, "有声剧缓存目录离开了 DSH 工作目录。");
  }
  const target = await realm.fs.resolve(rawPath, { cwd: realm.cwd });
  if (!realm.fs.contains(cacheRoot, target) || !realm.fs.contains(realm.root, target)) {
    throw new WorkspaceHttpError(403, "音频路径离开了有声剧缓存目录。");
  }
  const mimeType = segmentAudioMimeType(target.displayPath);
  const bytes = await runtime.binary.read(target, SEGMENT_AUDIO_MAX_BYTES);
  if (bytes === undefined) throw new WorkspaceHttpError(404, "音频不存在。");
  response.writeHead(200, {
    "content-type": mimeType,
    "content-length": bytes.byteLength,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(Buffer.from(bytes));
}

function assetKindOf(value: unknown): AudiobookAssetKind {
  if (value === "music" || value === "effect") return value;
  throw new WorkspaceHttpError(400, "kind 必须是 music 或 effect。");
}

function positiveDuration(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new WorkspaceHttpError(400, "durationSeconds 必须是大于 0 的数字。");
  }
  return value;
}

function generationCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 8) {
    throw new WorkspaceHttpError(400, "count 必须是 1–8 的整数。");
  }
  return value;
}

/** 生成只支持 ComfyUI；本地素材库只登记已有文件（400）。 */
function assertGeneratableProvider(value: unknown): void {
  if (value !== undefined && value !== COMFYUI_ASSET_PROVIDER_ID) {
    throw new WorkspaceHttpError(400, "provider 只支持 comfyui。");
  }
}

/**
 * 完整导出格式：三个布尔开关与字幕数组必须显式给出；字幕只接受 srt/lrc，
 * 重复值去重，全空视为没有可导出的内容（400）。预检与导出共用这份解析结果。
 */
function exportFormatsOf(value: unknown): AudiobookExportFormats {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkspaceHttpError(400, "formats 必须是对象。");
  }
  const record = value as Readonly<Record<string, unknown>>;
  const flag = (key: string): boolean => {
    const raw = record[key];
    if (typeof raw !== "boolean") throw new WorkspaceHttpError(400, `formats.${key} 必须是布尔值。`);
    return raw;
  };
  const mp3 = flag("mp3");
  const m4b = flag("m4b");
  const packageRequested = flag("package");
  const rawSubtitles = record["subtitles"];
  if (!Array.isArray(rawSubtitles)) throw new WorkspaceHttpError(400, "formats.subtitles 必须是数组。");
  const items: readonly unknown[] = rawSubtitles;
  const subtitles: ("srt" | "lrc")[] = [];
  for (const [index, item] of items.entries()) {
    if (item !== "srt" && item !== "lrc") {
      throw new WorkspaceHttpError(400, `formats.subtitles[${String(index)}] 只支持 srt 或 lrc。`);
    }
    if (!subtitles.includes(item)) subtitles.push(item);
  }
  if (!mp3 && !m4b && !packageRequested && subtitles.length === 0) {
    throw new WorkspaceHttpError(400, "formats 至少要选择一种输出格式。");
  }
  return { mp3, m4b, subtitles, package: packageRequested };
}

/** 可选章节过滤：省略或空数组表示全部章节；每个元素必须是非空章节名。 */
function chapterSelection(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new WorkspaceHttpError(400, "chapters 必须是章节名数组。");
  const items: readonly unknown[] = value;
  return items.map((item, index) => {
    if (typeof item !== "string" || item.trim() === "") {
      throw new WorkspaceHttpError(400, `chapters[${String(index)}] 必须是非空章节名。`);
    }
    return item.trim();
  });
}

/**
 * 可选布尔开关：省略返回 undefined，出现但非布尔一律 400。导出路由用它校验
 * `preview`/`confirm`，避免 `preview: "yes"` 之类输入落进确认分支被当成真导出。
 */
function optionalBoolean(body: Readonly<Record<string, unknown>>, key: string): boolean | undefined {
  const raw = body[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== "boolean") throw new WorkspaceHttpError(400, `${key} 必须是布尔值。`);
  return raw;
}

function providerSummary(provider: AudioAssetProvider): AudiobookAssetProviderSummary {
  return { id: provider.id, label: provider.label, configured: provider.configured };
}

async function assetProviderFor(
  realm: WorkspaceRealm,
  runtime: AudiobookRuntime,
  deps: AudiobookRouteDeps,
): Promise<AudioAssetProvider> {
  if (deps.assetProvider !== undefined) return deps.assetProvider(realm, runtime);
  const providers = await defaultAssetProviders(realm, runtime.env);
  const comfyui = providers.find((provider) => provider.id === COMFYUI_ASSET_PROVIDER_ID);
  if (comfyui === undefined) throw new WorkspaceHttpError(500, "素材生成 provider 未注册。");
  return comfyui;
}

/**
 * 生成成功后补齐授权：已有条目保留 source/license/allowedUse/attribution，只补/替换
 * provider 回执；新条目写 `license: "unverified"`（导出预检据此阻断，等待用户补授权）。
 * 走 `saveAssetAuthorizations` 的 CAS：文档存在用其版本，缺失时按新建处理。
 * `existing` 必须由调用方在生成前读好，坏文档才不会等到文件落盘后才发现。
 */
async function upsertGeneratedAuthorizations(
  realm: WorkspaceRealm,
  project: AudiobookProjectRecord,
  existing: AudiobookAuthorizationRecord | undefined,
  files: readonly AudioAssetGenerationFile[],
  provider: AudiobookAssetProviderReceipt,
): Promise<void> {
  const assets = [...(existing?.document.assets ?? [])];
  const indexes = new Map(assets.map((asset, index) => [asset.path, index] as const));
  for (const file of files) {
    const index = indexes.get(file.path);
    const previous = index === undefined ? undefined : assets[index];
    if (index === undefined || previous === undefined) {
      indexes.set(file.path, assets.length);
      assets.push({
        path: file.path,
        source: COMFYUI_ASSET_PROVIDER_ID,
        license: "unverified",
        allowedUse: ["audiobook"],
        attribution: "",
        provider,
      });
    } else {
      assets[index] = { ...previous, provider };
    }
  }
  await saveAssetAuthorizations(realm, project, { schemaVersion: 1, assets }, existing?.version ?? null);
}

/**
 * 授权落盘失败时回滚本请求生成的文件：逐条解析到工作区内再交给宿主二进制通道删除。
 * 尽力而为——单个文件解析失败或删除失败只记日志，不覆盖原始错误；工作区外的路径跳过。
 */
async function rollbackGeneratedAssets(
  context: Context,
  realm: WorkspaceRealm,
  runtime: AudiobookRuntime,
  files: readonly AudioAssetGenerationFile[],
): Promise<void> {
  for (const file of files) {
    try {
      const target = await realm.fs.resolve(file.path, { cwd: realm.cwd });
      if (!realm.fs.contains(realm.root, target)) continue;
      await runtime.binary.remove(target);
    } catch (error) {
      context.logger("oh-story").warn(`audiobook asset rollback failed: ${file.path}`, error);
    }
  }
}

/** 供宿主路由扩展缝调用；命中返回 true，其余交回 `workspace-route.ts`。 */
export async function handleAudiobookRequest(
  context: Context,
  request: IncomingMessage,
  response: ServerResponse,
  options: WorkspaceRouteOptions,
  deps: AudiobookRouteDeps = {},
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const method = request.method ?? "GET";
  const jobMatch = JOB_ROUTE.exec(url.pathname);
  try {
    if (url.pathname === AUDIOBOOK_ROUTES.overview && method === "GET") {
      const realm = await workspaceRealm(context, url);
      send(response, 200, await buildOverview(realm, runtimeOf(realm, deps)));
      return true;
    }

    if (url.pathname === AUDIOBOOK_ROUTES.project) {
      if (method === "GET") {
        const path = url.searchParams.get("path")?.trim() ?? "";
        if (path === "") throw new WorkspaceHttpError(400, "缺少有声剧项目路径。");
        const realm = await workspaceRealm(context, url);
        send(response, 200, await buildProjectView(realm, runtimeOf(realm, deps), path));
        return true;
      }
      if (method === "POST") {
        const body = await jsonBody(request, BODY_LIMIT);
        assertNoSecretKeys(body, "body");
        const realm = await workspaceRealm(context, url);
        const runtime = runtimeOf(realm, deps);
        const record = await createAudiobookProject(realm, {
          bookRoot: requiredString(body, "bookRoot"),
          name: requiredString(body, "name"),
          voice: requiredString(body, "voice"),
          baseUrl: optionalString(body, "baseUrl", runtime.env, TTS_BASE_URL_ENV),
          model: optionalString(body, "model", runtime.env, TTS_MODEL_ENV),
        });
        send(response, 201, { record });
        return true;
      }
      if (method === "PUT") {
        const body = await jsonBody(request, BODY_LIMIT);
        assertNoSecretKeys(body, "body");
        const realm = await workspaceRealm(context, url);
        const record = await saveAudiobookProject(
          realm,
          requiredString(body, "path"),
          body["project"] as AudiobookProject,
          requiredString(body, "baseVersion"),
        );
        send(response, 200, { record });
        return true;
      }
    }

    if (url.pathname === AUDIOBOOK_ROUTES.script) {
      if (method === "GET") {
        const path = url.searchParams.get("path")?.trim() ?? "";
        const chapter = url.searchParams.get("chapter")?.trim() ?? "";
        if (path === "" || chapter === "") throw new WorkspaceHttpError(400, "缺少有声剧项目路径或章节。");
        const realm = await workspaceRealm(context, url);
        const record = await loadAudiobookProject(realm, path);
        const script = await loadChapterScript(realm, record.path, chapter);
        if (script === undefined) throw new WorkspaceHttpError(404, "章节脚本不存在。");
        send(response, 200, { script });
        return true;
      }
      if (method === "POST") {
        const body = await jsonBody(request, BODY_LIMIT);
        assertNoSecretKeys(body, "body");
        const chapter = requiredString(body, "chapter");
        const realm = await workspaceRealm(context, url);
        const record = await loadAudiobookProject(realm, requiredString(body, "path"));
        const sourcePath = record.project.source.chapters.find((candidate) => chapterNameOf(candidate) === chapter);
        if (sourcePath === undefined) throw new WorkspaceHttpError(404, "有声剧项目里没有该章节。");
        const confirm = body["confirm"] === true;
        // 存在性只看 stat，不预先解析：损坏脚本也要能用 confirm 覆盖。
        const scriptPath = scriptPathFor(record.path, chapter);
        const existing = await realm.fs.stat(await realm.fs.resolve(scriptPath, { cwd: realm.cwd }));
        if (existing !== undefined && !confirm) {
          throw new WorkspaceHttpError(400, "章节脚本已存在，覆盖需要显式确认（confirm: true）。");
        }
        const parsed = await parseChapterScript(realm, record, sourcePath, confirm);
        send(response, 200, { script: parsed.record, assignmentSummary: parsed.assignmentSummary });
        return true;
      }
      if (method === "PUT") {
        const body = await jsonBody(request, BODY_LIMIT);
        assertNoSecretKeys(body, "body");
        const assignments = assignmentList(body["assignments"]);
        const realm = await workspaceRealm(context, url);
        const record = await loadAudiobookProject(realm, requiredString(body, "path"));
        const script = await assignChapterSpeakers(
          realm,
          record,
          requiredString(body, "chapter"),
          requiredString(body, "baseVersion"),
          assignments,
        );
        send(response, 200, { script });
        return true;
      }
    }

    if (url.pathname === AUDIOBOOK_ROUTES.jobs && method === "POST") {
      const body = await jsonBody(request, BODY_LIMIT);
      assertNoSecretKeys(body, "body");
      const chapter = requiredString(body, "chapter");
      const realm = await workspaceRealm(context, url);
      const runtime = runtimeOf(realm, deps);
      const record = await loadAudiobookProject(realm, requiredString(body, "path"));
      const scriptRecord = await loadChapterScript(realm, record.path, chapter);
      if (scriptRecord === undefined) throw new WorkspaceHttpError(409, "章节脚本不存在，请先生成脚本。");
      // 预估与实际生成都基于脚本里的 sha256：源文件在解析后改过就要求先重新解析。
      await assertScriptSourceFresh(realm, scriptRecord.script);
      const estimate = await planChapterJob(realm, record, scriptRecord.script, runtime);
      if (body["dryRun"] === true) {
        send(response, 200, { estimate });
        return true;
      }
      if (body["confirm"] !== true) {
        throw new WorkspaceHttpError(400, "启动任务会调用 TTS 服务并产生费用，需要显式确认（confirm: true）。");
      }
      const created = await createChapterJob(realm, record, chapter, runtime);
      launchJob(context, realm, created.job.id, runtime, deps);
      send(response, 202, { job: created.job, estimate });
      return true;
    }

    if (jobMatch !== null) {
      const jobId = jobMatch[1] ?? "";
      const action = jobMatch[2];
      if (action === undefined && method === "GET") {
        const realm = await workspaceRealm(context, url);
        send(response, 200, { job: (await loadAudiobookJob(realm, jobId)).job });
        return true;
      }
      if (action === "cancel" && method === "POST") {
        const realm = await workspaceRealm(context, url);
        cancelAudiobookJob(jobId);
        send(response, 200, { job: (await loadAudiobookJob(realm, jobId)).job });
        return true;
      }
      if (action === "run" && method === "POST") {
        const body = await jsonBody(request, BODY_LIMIT);
        assertNoSecretKeys(body, "body");
        if (body["confirm"] !== true) {
          throw new WorkspaceHttpError(400, "恢复任务会继续调用 TTS 服务并产生费用，需要显式确认（confirm: true）。");
        }
        const realm = await workspaceRealm(context, url);
        const loaded = await loadAudiobookJob(realm, jobId);
        if (loaded.job.status === "completed") {
          throw new WorkspaceHttpError(409, "已完成的有声剧任务不能再次执行。");
        }
        // 已在执行的任务不再回 202，否则异步的 409 只会进日志。
        if (isAudiobookJobInFlight(realm, jobId)) {
          throw new WorkspaceHttpError(409, "该有声剧任务正在执行，请等待当前执行结束。");
        }
        // 恢复同样是付费入口：同一章节还有其他活动任务时先拒绝，避免双份合成。
        if (otherActiveJob(await listAudiobookJobs(realm), loaded.job) !== undefined) {
          throw new WorkspaceHttpError(409, "该章节已有其他排队、进行中或暂停的有声剧任务。");
        }
        // 恢复前先过与新建任务相同的门禁（密钥、旁白、脚本、源文件、单章上限）。
        const runtime = runtimeOf(realm, deps);
        try {
          const record = await loadAudiobookProject(realm, loaded.job.projectPath);
          const scriptRecord = await loadChapterScript(realm, record.path, loaded.job.chapter);
          if (scriptRecord === undefined) throw new WorkspaceHttpError(409, "章节脚本不存在，请先生成脚本。");
          await assertScriptSourceFresh(realm, scriptRecord.script);
          const estimate = await planChapterJob(realm, record, scriptRecord.script, runtime);
          if (estimate.chars > record.project.tts.maxCharsPerChapter) {
            throw new WorkspaceHttpError(409, `章节字符数超过单章上限（${String(record.project.tts.maxCharsPerChapter)}）。`);
          }
        } catch (error) {
          // queued/running 的残留任务被门禁挡住时落成 failed，否则它会永远占着章节。
          // 另一个执行者已经在跑这个任务时不要改它的状态。
          if (!isAudiobookJobInFlight(realm, jobId)) {
            await markAudiobookJobFailed(realm, jobId, runtime, error, loaded.version);
          }
          throw error;
        }
        // 门禁全部通过后同步再查一次；这里到 launchJob 之间没有 await，避免双份 202。
        if (isAudiobookJobInFlight(realm, jobId)) {
          throw new WorkspaceHttpError(409, "该有声剧任务正在执行，请等待当前执行结束。");
        }
        launchJob(context, realm, jobId, runtime, deps);
        send(response, 202, { job: loaded.job });
        return true;
      }
    }

    if (url.pathname === AUDIOBOOK_ROUTES.assets) {
      if (method === "GET") {
        const path = url.searchParams.get("path")?.trim() ?? "";
        if (path === "") throw new WorkspaceHttpError(400, "缺少有声剧项目路径。");
        // Task 1 的视图 providers 恒为空，这里用真实 provider 列表覆盖。
        bookDirectoryForProject(path);
        const realm = await workspaceRealm(context, url);
        const record = await loadAudiobookProject(realm, path);
        const provider = await assetProviderFor(realm, runtimeOf(realm, deps), deps);
        const view = await listAudiobookAssets(realm, record);
        const providers: AudiobookAssetProviderSummary[] = [
          providerSummary(new LocalAssetProvider()),
          providerSummary(provider),
        ];
        send(response, 200, { view: { ...view, providers } });
        return true;
      }
      if (method === "PUT") {
        const body = await jsonBody(request, ASSET_DOCUMENT_BODY_LIMIT);
        assertNoSecretKeys(body, "body");
        const path = requiredString(body, "path");
        bookDirectoryForProject(path);
        const rawBaseVersion = body["baseVersion"];
        if (rawBaseVersion !== null && typeof rawBaseVersion !== "string") {
          throw new WorkspaceHttpError(400, "baseVersion 必须是字符串或 null。");
        }
        const baseVersion = rawBaseVersion === null ? null : rawBaseVersion.trim();
        if (baseVersion === "") throw new WorkspaceHttpError(400, "缺少基础版本号。");
        const document = body["document"];
        if (typeof document !== "object" || document === null || Array.isArray(document)) {
          throw new WorkspaceHttpError(400, "document 必须是授权文档对象。");
        }
        const realm = await workspaceRealm(context, url);
        const record = await loadAudiobookProject(realm, path);
        const saved = await saveAssetAuthorizations(
          realm,
          record,
          document as AudiobookAssetAuthorizationDocument,
          baseVersion,
        );
        send(response, 200, { record: saved });
        return true;
      }
    }

    if (url.pathname === AUDIOBOOK_ROUTES.assetsGenerate && method === "POST") {
      const body = await jsonBody(request, BODY_LIMIT);
      assertNoSecretKeys(body, "body");
      const path = requiredString(body, "path");
      bookDirectoryForProject(path);
      const generation: AudioAssetGenerationRequest = {
        kind: assetKindOf(body["kind"]),
        prompt: requiredString(body, "prompt"),
        durationSeconds: positiveDuration(body["durationSeconds"]),
        count: generationCount(body["count"]),
      };
      assertGeneratableProvider(body["provider"]);
      const realm = await workspaceRealm(context, url);
      const runtime = runtimeOf(realm, deps);
      const provider = await assetProviderFor(realm, runtime, deps);
      if (body["preview"] === true) {
        const preview: AudiobookAssetGenerationPreview = {
          estimate: provider.estimate(generation),
          provider: { id: provider.id, label: provider.label },
        };
        send(response, 200, preview);
        return true;
      }
      if (body["confirm"] !== true) {
        throw new WorkspaceHttpError(400, "生成素材会调用 ComfyUI 并写入工作区文件，需要显式确认（confirm: true）。");
      }
      if (!provider.configured) throw new WorkspaceHttpError(503, "ComfyUI 未配置工作流，无法生成素材。");
      const record = await loadAudiobookProject(realm, path);
      // 授权文档必须在生成前读取并校验：坏文档在这里就 422，不会等到音频落盘后才失败。
      const authorization = await loadAssetAuthorizations(realm, record.path);
      const result = await provider.generate(realm, record, generation);
      // 注入的 provider 可能绕过 ComfyUI 适配器，路由必须再校验一次落点。
      validateGeneratedAssets(record.path, generation.kind, result.files);
      if (result.files.length === 0) throw new WorkspaceHttpError(502, "ComfyUI 素材生成没有返回文件。");
      const generatedAt = runtime.now();
      const providerReceipt: AudiobookAssetProviderReceipt = {
        id: result.provider,
        model: result.model,
        promptSha256: result.promptSha256,
        receiptId: result.receiptId,
        generatedAt,
      };
      try {
        await upsertGeneratedAuthorizations(realm, record, authorization, result.files, providerReceipt);
      } catch (error) {
        // 授权没写成就删掉本请求生成的文件，避免留下没有授权记录的无主音频。
        await rollbackGeneratedAssets(context, realm, runtime, result.files);
        throw error;
      }
      const payload: AudiobookAssetGenerationResponse = {
        files: result.files.map((file) => ({ path: file.path, bytes: file.bytes })),
        receipt: {
          provider: result.provider,
          model: result.model,
          promptSha256: result.promptSha256,
          receiptId: result.receiptId,
          generatedAt,
        },
      };
      send(response, 200, payload);
      return true;
    }

    if (url.pathname === AUDIOBOOK_ROUTES.export && method === "POST") {
      const body = await jsonBody(request, BODY_LIMIT);
      assertNoSecretKeys(body, "body");
      if (body["formats"] !== undefined) {
        // preview/confirm 只接受布尔；非布尔输入直接 400，不能落进真导出分支。
        const preview = optionalBoolean(body, "preview");
        const confirm = optionalBoolean(body, "confirm");
        const formats = exportFormatsOf(body["formats"]);
        const chapters = chapterSelection(body["chapters"]);
        const path = requiredString(body, "path");
        const realm = await workspaceRealm(context, url);
        const runtime = runtimeOf(realm, deps);
        if (preview === true) {
          // 预览只读：返回 issues 与成本预估，不要求 confirm，也不写任何文件。
          const record = await loadAudiobookProject(realm, path);
          const preflight = await preflightAudiobookExport(realm, record, runtime, formats, chapters);
          send(response, 200, { preflight });
          return true;
        }
        if (confirm !== true) {
          throw new WorkspaceHttpError(400, "完整导出会调用 ffmpeg 写音频与发布文件，需要显式确认（confirm: true）。");
        }
        const record = await loadAudiobookProject(realm, path);
        const result = await exportAudiobook(realm, record, runtime, formats, chapters);
        send(response, 200, result.manifestPath === undefined
          ? { files: result.files }
          : { files: result.files, manifestPath: result.manifestPath });
        return true;
      }
      if (body["confirm"] !== true) {
        throw new WorkspaceHttpError(400, "导出会调用 ffmpeg 写音频文件，需要显式确认（confirm: true）。");
      }
      const realm = await workspaceRealm(context, url);
      const runtime = runtimeOf(realm, deps);
      const [ffmpeg, ffprobe] = await Promise.all([
        probeTool(runtime.runner, "ffmpeg"),
        probeTool(runtime.runner, "ffprobe"),
      ]);
      if (!ffmpeg || !ffprobe) throw new WorkspaceHttpError(503, "本机缺少 ffmpeg/ffprobe，无法导出 MP3。");
      const chapter = requiredString(body, "chapter");
      const record = await loadAudiobookProject(realm, requiredString(body, "path"));
      const script = await loadChapterScript(realm, record.path, chapter);
      if (script === undefined) throw new WorkspaceHttpError(409, "章节脚本不存在，请先生成脚本。");
      await assertScriptSourceFresh(realm, script.script);
      send(response, 200, await exportChapterMp3(realm, record, chapter, script.script, runtime));
      return true;
    }

    if (url.pathname === AUDIOBOOK_ROUTES.segmentAudio && method === "GET") {
      const rawPath = url.searchParams.get("path")?.trim() ?? "";
      if (rawPath === "") throw new WorkspaceHttpError(400, "缺少音频路径。");
      const realm = await workspaceRealm(context, url);
      await sendSegmentAudio(response, realm, runtimeOf(realm, deps), rawPath);
      return true;
    }

    return false;
  } catch (error) {
    if (error instanceof WorkspaceHttpError) {
      send(response, error.status, { error: error.message });
      return true;
    }
    context.logger("oh-story").error("audiobook route failed", error);
    send(response, 500, { error: "有声剧请求失败。" });
    return true;
  }
}

registerWorkspaceExtension({ name: "audiobook", handle: handleAudiobookRequest });

export function registerAudiobookExtension(): void {
  // 扩展在模块顶层注册，保留具名导出供入口与测试显式引用。
}
