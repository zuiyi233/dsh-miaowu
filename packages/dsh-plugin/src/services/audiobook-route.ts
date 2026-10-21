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
import { hostBinaryFileStore } from "./audiobook-binary.js";
import {
  AUDIOBOOK_CACHE_ROOT,
  AUDIOBOOK_ROUTES,
  type AudiobookChapterSummary,
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
  exportChapterMp3,
  hostCommandRunner,
  probeTool,
  type CommandRunner,
} from "./audiobook-export.js";
import {
  cancelAudiobookJob,
  createChapterJob,
  listAudiobookJobs,
  loadAudiobookJob,
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
import { loadChapterScript, parseChapterScript, scriptPathFor } from "./audiobook-script.js";
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
/** 与缓存模块一致的读取上限（50 MiB）；超出按不存在处理。 */
const SEGMENT_AUDIO_MAX_BYTES = 50 * 1_024 * 1_024;
const TTS_KEY_ENV = "OH_STORY_TTS_API_KEY";
const TTS_BASE_URL_ENV = "OH_STORY_TTS_BASE_URL";
const SECRET_KEY_PATTERN = /api.?key|authorization|token|secret/iu;
const JOB_ROUTE = /^\/oh-story\/audiobook\/jobs\/([^/]+)(?:\/(cancel|run))?$/u;
const SOURCE_EXTENSION = ".md";

export interface AudiobookRuntime extends AudiobookJobRuntime {
  readonly runner: CommandRunner;
}

export interface AudiobookRouteDeps {
  readonly runtime?: (realm: WorkspaceRealm) => AudiobookRuntime;
  readonly runJob?: (realm: WorkspaceRealm, jobId: string, runtime: AudiobookRuntime) => Promise<unknown>;
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

/** 环境变量里的 `OH_STORY_TTS_BASE_URL` 只在预检里展示；非法或缺失都为 null。 */
function hostFromEnv(env: Readonly<Record<string, string | undefined>>): string | null {
  const raw = (env[TTS_BASE_URL_ENV] ?? "").trim();
  if (raw === "") return null;
  try {
    return validateTtsBaseUrl(raw);
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

async function chapterSummaries(realm: WorkspaceRealm, record: AudiobookProjectRecord): Promise<AudiobookChapterSummary[]> {
  const jobs = await listAudiobookJobs(realm);
  const summaries: AudiobookChapterSummary[] = [];
  for (const sourcePath of record.project.source.chapters) {
    const chapter = chapterNameOf(sourcePath);
    const script = await loadChapterScript(realm, record.path, chapter);
    const audioPath = chapterAudioPathFor(record.path, chapter);
    const audioInfo = await realm.fs.stat(await realm.fs.resolve(audioPath, { cwd: realm.cwd }));
    const job = latestJob(jobs, record.path, chapter);
    summaries.push({
      sourcePath,
      chapter,
      scriptPath: scriptPathFor(record.path, chapter),
      hasScript: script !== undefined,
      segmentCount: script?.script.segments.length ?? 0,
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
        const record = await createAudiobookProject(realm, {
          bookRoot: requiredString(body, "bookRoot"),
          name: requiredString(body, "name"),
          voice: requiredString(body, "voice"),
          baseUrl: requiredString(body, "baseUrl"),
          model: requiredString(body, "model"),
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

    if (url.pathname === AUDIOBOOK_ROUTES.script && method === "POST") {
      const body = await jsonBody(request, BODY_LIMIT);
      assertNoSecretKeys(body, "body");
      const chapter = requiredString(body, "chapter");
      const realm = await workspaceRealm(context, url);
      const record = await loadAudiobookProject(realm, requiredString(body, "path"));
      const sourcePath = record.project.source.chapters.find((candidate) => chapterNameOf(candidate) === chapter);
      if (sourcePath === undefined) throw new WorkspaceHttpError(404, "有声剧项目里没有该章节。");
      const confirm = body["confirm"] === true;
      const existing = await loadChapterScript(realm, record.path, chapter);
      if (existing !== undefined && !confirm) {
        throw new WorkspaceHttpError(400, "章节脚本已存在，覆盖需要显式确认（confirm: true）。");
      }
      send(response, 200, { script: await parseChapterScript(realm, record, sourcePath, confirm) });
      return true;
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
        if (loaded.job.status !== "paused" && loaded.job.status !== "failed") {
          throw new WorkspaceHttpError(409, "只有已暂停或失败的任务可以恢复。");
        }
        const runtime = runtimeOf(realm, deps);
        launchJob(context, realm, jobId, runtime, deps);
        send(response, 202, { job: loaded.job });
        return true;
      }
    }

    if (url.pathname === AUDIOBOOK_ROUTES.export && method === "POST") {
      const body = await jsonBody(request, BODY_LIMIT);
      assertNoSecretKeys(body, "body");
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
