import { randomUUID } from "node:crypto";
import type { FsTarget, FsVersion } from "@deepseek-ai/dsh-fs";
import { mapFsError, readVersionedFile, WorkspaceHttpError, type WorkspaceRealm } from "../workspace-route.js";
import type { BinaryFileStore } from "./audiobook-binary.js";
import {
  planChapterCost,
  segmentAudioPath,
  ttsCacheKey,
  writeCachedSegment,
  type CachedAudioExtension,
} from "./audiobook-cache.js";
import {
  AUDIOBOOK_CACHE_ROOT,
  AUDIOBOOK_JOB_ROOT,
  AUDIOBOOK_ROOT,
  AUDIOBOOK_SCHEMA_VERSION,
  type AudiobookCostEstimate,
  type AudiobookJob,
  type AudiobookJobRecord,
  type AudiobookJobStatus,
  type AudiobookProject,
  type AudiobookProjectRecord,
  type AudiobookScript,
} from "./audiobook-contract.js";
import { loadAudiobookProject } from "./audiobook-project.js";
import { loadChapterScript } from "./audiobook-script.js";
import type { TtsClient } from "./audiobook-tts.js";

/**
 * 有声剧章节任务：成本预估、任务创建、逐段合成与断点持久化。
 *
 * 任务文档固定落 `.oh-story/audiobook/jobs/<id>.json`（schemaVersion 1），只在
 * 创建时 `createIfAbsent`，之后每次状态/计数变化都用读取到的版本做 CAS；写入
 * 一律带当前会话解析出的沙箱策略。任务里只有路径、计数与成本，没有正文全文、
 * 没有密钥。N4-A 不做重启自动恢复：进程重启后已存的状态原样保留，由 N4-D 再
 * 引入运行中任务的恢复转换；取消只阻止后续片段，已完成的缓存永远保留。
 */

const TTS_KEY_ENV = "OH_STORY_TTS_API_KEY";
const JOB_ID_PATTERN = /^[a-zA-Z0-9-]{1,64}$/u;
const JOB_FILE_SUFFIX = ".json";
const JOB_MAX_BYTES = 1 * 1_024 * 1_024;
const JOB_STATUSES: readonly AudiobookJobStatus[] = ["queued", "running", "paused", "failed", "completed"];
const ACTIVE_STATUSES: ReadonlySet<AudiobookJobStatus> = new Set<AudiobookJobStatus>(["queued", "running", "paused"]);

/** 章节任务只需 TTS、二进制缓存、时钟与宿主环境；Task 7 的运行时会再加 runner。 */
export interface AudiobookJobRuntime {
  readonly tts: TtsClient;
  readonly binary: BinaryFileStore;
  readonly now: () => number;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** 模块级取消标记：只有当前进程内的执行者能看到，消费后即删除。 */
const cancellations = new Map<string, boolean>();

function invalidJob(): WorkspaceHttpError {
  return new WorkspaceHttpError(422, "有声剧任务格式无效。");
}

function hasControlCharacter(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** 与项目/脚本服务同一套相对路径判据，任务文档不接受目标路径越级。 */
function relativePathOrNull(raw: string): string | null {
  const text = raw.trim();
  if (text === "" || text.startsWith("/") || text.includes("\\") || /^[A-Za-z]:/u.test(text)) return null;
  const segments = text.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".." || hasControlCharacter(segment))) return null;
  return segments.join("/");
}

function jobIdOrThrow(raw: string): string {
  if (!JOB_ID_PATTERN.test(raw)) throw new WorkspaceHttpError(400, "有声剧任务 ID 无效。");
  return raw;
}

function jobPathFor(jobId: string): string {
  return `${AUDIOBOOK_JOB_ROOT}/${jobId}${JOB_FILE_SUFFIX}`;
}

function sandboxPolicyFor(realm: WorkspaceRealm): ReturnType<WorkspaceRealm["sandboxPolicy"]["resolve"]> {
  return realm.sandboxPolicy.resolve({ session: realm.agent.session });
}

/** 解析任务目标并确认它仍在任务根内；任务根本身也必须留在工作区。 */
async function jobTarget(realm: WorkspaceRealm, jobId: string): Promise<FsTarget> {
  const root = await realm.fs.resolve(AUDIOBOOK_JOB_ROOT, { cwd: realm.cwd });
  if (!realm.fs.contains(realm.root, root)) throw new WorkspaceHttpError(403, "有声剧任务目录离开了 DSH 工作目录。");
  const target = await realm.fs.resolve(jobPathFor(jobId), { cwd: realm.cwd });
  if (!realm.fs.contains(root, target)) throw new WorkspaceHttpError(403, "有声剧任务路径离开了任务目录。");
  return target;
}

function serializeJob(job: AudiobookJob): string {
  return `${JSON.stringify(job, undefined, 2)}\n`;
}

async function persistNewJob(realm: WorkspaceRealm, job: AudiobookJob): Promise<AudiobookJobRecord> {
  const target = await jobTarget(realm, job.id);
  try {
    const outcome = await realm.fs.writeText(
      target,
      serializeJob(job),
      { kind: "createIfAbsent" },
      undefined,
      sandboxPolicyFor(realm),
    );
    return { job, version: String(outcome.version) };
  } catch (error) {
    const mapped = mapFsError(error);
    if (mapped?.status === 412) throw new WorkspaceHttpError(409, "有声剧任务已存在。");
    throw mapped ?? new WorkspaceHttpError(500, "有声剧任务写入失败。");
  }
}

async function persistJob(realm: WorkspaceRealm, job: AudiobookJob, version: string): Promise<AudiobookJobRecord> {
  const target = await jobTarget(realm, job.id);
  try {
    const outcome = await realm.fs.writeText(
      target,
      serializeJob(job),
      { kind: "replaceIfVersion", version: version as FsVersion },
      undefined,
      sandboxPolicyFor(realm),
    );
    return { job, version: String(outcome.version) };
  } catch (error) {
    const mapped = mapFsError(error);
    if (mapped?.status === 412) throw new WorkspaceHttpError(409, "有声剧任务已被其他执行修改，请刷新后重试。");
    throw mapped ?? new WorkspaceHttpError(500, "有声剧任务写入失败。");
  }
}

function requireTtsKey(runtime: AudiobookJobRuntime): string {
  const apiKey = (runtime.env[TTS_KEY_ENV] ?? "").trim();
  if (apiKey === "") throw new WorkspaceHttpError(503, `缺少 TTS API 密钥（${TTS_KEY_ENV}）。`);
  return apiKey;
}

/** N4-A 所有片段（含对白）都用旁白音色；缺旁白无法合成，返回 422。 */
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

function cacheKeyFor(project: AudiobookProject, voice: string, text: string): string {
  return ttsCacheKey({
    baseUrl: project.tts.baseUrl,
    model: project.tts.model,
    voice,
    speed: project.tts.speed,
    responseFormat: audioExtension(project),
    text,
  });
}

/** 缓存命中探测与缓存模块同一套守界：解析后的目标必须仍在缓存根内。 */
async function cachedAudioTarget(
  realm: WorkspaceRealm,
  key: string,
  extension: CachedAudioExtension,
): Promise<FsTarget> {
  const cacheRoot = await realm.fs.resolve(AUDIOBOOK_CACHE_ROOT, { cwd: realm.cwd });
  if (!realm.fs.contains(realm.root, cacheRoot)) throw new WorkspaceHttpError(403, "有声剧缓存目录离开了 DSH 工作目录。");
  const target = await realm.fs.resolve(segmentAudioPath(key, extension), { cwd: realm.cwd });
  if (!realm.fs.contains(cacheRoot, target)) throw new WorkspaceHttpError(403, "有声剧缓存路径离开了缓存目录。");
  return target;
}

/**
 * 章节成本预估：先要求运行时密钥（缺密钥 503，不触碰文件系统），再按旁白音色
 * 为每个片段构造缓存键并用二进制存储确认是否已有音频；命中数交给
 * `planChapterCost` 做与缓存模块一致的计费（只计未命中的字符）。
 */
export async function planChapterJob(
  realm: WorkspaceRealm,
  record: AudiobookProjectRecord,
  script: AudiobookScript,
  runtime: AudiobookJobRuntime,
): Promise<AudiobookCostEstimate> {
  requireTtsKey(runtime);
  const project = record.project;
  const voice = narratorVoice(project);
  const extension = audioExtension(project);
  const keys = await Promise.all(script.segments.map(async (segment) => {
    const key = cacheKeyFor(project, voice, segment.text);
    const cached = await runtime.binary.stat(await cachedAudioTarget(realm, key, extension));
    return cached === undefined ? undefined : key;
  }));
  const cached = new Set(keys.filter((key): key is string => key !== undefined));
  return planChapterCost(project, script, cached);
}

/**
 * 创建章节任务：脚本缺失 409；预估后超过单章字符上限 409；同一项目+章节已有
 * 排队/运行/暂停任务时 409。新任务状态 queued、计数归零，成本取预估未命中。
 */
export async function createChapterJob(
  realm: WorkspaceRealm,
  record: AudiobookProjectRecord,
  chapter: string,
  runtime: AudiobookJobRuntime,
): Promise<AudiobookJobRecord> {
  const scriptRecord = await loadChapterScript(realm, record.path, chapter);
  if (scriptRecord === undefined) throw new WorkspaceHttpError(409, "章节脚本不存在，请先生成脚本。");
  const script = scriptRecord.script;
  const estimate = await planChapterJob(realm, record, script, runtime);
  if (estimate.chars > record.project.tts.maxCharsPerChapter) {
    throw new WorkspaceHttpError(409, `章节字符数超过单章上限（${String(record.project.tts.maxCharsPerChapter)}）。`);
  }
  const active = (await listAudiobookJobs(realm)).some((job) =>
    job.projectPath === record.path && job.chapter === script.chapter && ACTIVE_STATUSES.has(job.status));
  if (active) throw new WorkspaceHttpError(409, "该章节已有排队或进行中的有声剧任务。");
  const now = runtime.now();
  const job: AudiobookJob = {
    schemaVersion: AUDIOBOOK_SCHEMA_VERSION,
    id: randomUUID(),
    projectPath: record.path,
    chapter: script.chapter,
    sourcePath: script.sourcePath,
    status: "queued",
    totalSegments: estimate.segments,
    completedSegments: 0,
    failedSegments: [],
    chars: estimate.chars,
    estimatedCost: estimate.estimatedCost,
    actualRequests: 0,
    createdAt: now,
    updatedAt: now,
    outputPath: null,
  };
  return await persistNewJob(realm, job);
}

/**
 * 执行章节任务：先确认密钥（503 在改状态之前）再置 running；每次执行都从内容
 * 寻址缓存重算完成数（暂停/失败重跑不会重复累计），实际请求数保持累计。逐段
 * 检查取消标记、命中缓存则跳过请求、未命中才合成并写缓存；单段失败只记录到
 * failedSegments 并继续后续段。每段结束后用 CAS 持久化，冲突返回 409；最终
 * 有任何失败段则 failed，否则 completed。
 */
export async function runChapterJob(
  realm: WorkspaceRealm,
  jobId: string,
  runtime: AudiobookJobRuntime,
): Promise<AudiobookJob> {
  const loaded = await loadAudiobookJob(realm, jobId);
  const apiKey = requireTtsKey(runtime);
  const projectRecord = await loadAudiobookProject(realm, loaded.job.projectPath);
  const scriptRecord = await loadChapterScript(realm, loaded.job.projectPath, loaded.job.chapter);
  if (scriptRecord === undefined) throw new WorkspaceHttpError(409, "章节脚本不存在，无法执行有声剧任务。");
  const project = projectRecord.project;
  const voice = narratorVoice(project);
  const extension = audioExtension(project);
  const script = scriptRecord.script;

  let record = await persistJob(realm, {
    ...loaded.job,
    status: "running",
    // 以当前脚本为准：脚本在排队后被重新生成时，总数与本次执行保持一致。
    totalSegments: script.segments.length,
    completedSegments: 0,
    failedSegments: [],
    updatedAt: runtime.now(),
  }, loaded.version);

  let completed = 0;
  let actualRequests = record.job.actualRequests;
  const failed: { readonly segmentId: string; readonly error: string }[] = [];

  for (const segment of script.segments) {
    if (cancellations.get(record.job.id) === true) {
      const paused = await persistJob(realm, {
        ...record.job,
        status: "paused",
        completedSegments: completed,
        failedSegments: [...failed],
        actualRequests,
        updatedAt: runtime.now(),
      }, record.version);
      cancellations.delete(record.job.id);
      return paused.job;
    }

    const key = cacheKeyFor(project, voice, segment.text);
    const cached = await runtime.binary.stat(await cachedAudioTarget(realm, key, extension));
    if (cached === undefined) {
      try {
        const bytes = await runtime.tts.synthesize({
          baseUrl: project.tts.baseUrl,
          model: project.tts.model,
          voice,
          text: segment.text,
          responseFormat: extension,
          speed: project.tts.speed,
          apiKey,
        });
        await writeCachedSegment(realm, runtime.binary, key, extension, bytes, {
          model: project.tts.model,
          voice,
          responseFormat: extension,
          speed: project.tts.speed,
          text: segment.text,
          createdAt: runtime.now(),
        });
        completed += 1;
        actualRequests += 1;
      } catch (error) {
        failed.push({ segmentId: segment.id, error: error instanceof Error ? error.message : "未知错误" });
      }
    } else {
      completed += 1;
    }

    record = await persistJob(realm, {
      ...record.job,
      completedSegments: completed,
      failedSegments: [...failed],
      actualRequests,
      updatedAt: runtime.now(),
    }, record.version);
  }

  cancellations.delete(record.job.id);
  return (await persistJob(realm, {
    ...record.job,
    status: failed.length > 0 ? "failed" : "completed",
    completedSegments: completed,
    failedSegments: [...failed],
    actualRequests,
    updatedAt: runtime.now(),
  }, record.version)).job;
}

/**
 * 读取任务文档：ID 仅接受 `[a-zA-Z0-9-]{1,64}`（400），路径必须留在任务根内
 * （403），缺失 404，坏 JSON、错误 schemaVersion、id 与文件名不一致 422。
 */
export async function loadAudiobookJob(realm: WorkspaceRealm, jobId: string): Promise<AudiobookJobRecord> {
  const id = jobIdOrThrow(jobId);
  const target = await jobTarget(realm, id);
  let file: Awaited<ReturnType<typeof readVersionedFile>>;
  try {
    file = await readVersionedFile(realm.fs, target, JOB_MAX_BYTES);
  } catch (error) {
    const mapped = mapFsError(error);
    const status = error instanceof WorkspaceHttpError ? error.status : mapped?.status;
    if (status === 404) throw new WorkspaceHttpError(404, "有声剧任务不存在。");
    throw mapped ?? error;
  }
  let value: unknown;
  try {
    value = JSON.parse(file.content);
  } catch {
    throw invalidJob();
  }
  const job = normalizeJob(value);
  if (job.id !== id) throw invalidJob();
  return { job, version: String(file.version) };
}

/** 请求取消：只阻止后续片段；已写入的缓存与已完成计数保留，标记由执行者消费。 */
export function cancelAudiobookJob(jobId: string): void {
  if (JOB_ID_PATTERN.test(jobId)) cancellations.set(jobId, true);
}

/** 列出任务根下的有效任务；目录缺失返回空，坏文件跳过，不因单个坏任务丢整份清单。 */
export async function listAudiobookJobs(realm: WorkspaceRealm): Promise<AudiobookJob[]> {
  const root = await realm.fs.resolve(AUDIOBOOK_JOB_ROOT, { cwd: realm.cwd });
  if (!realm.fs.contains(realm.root, root)) return [];
  const info = await realm.fs.stat(root).catch(() => undefined);
  if (info?.type !== "directory") return [];
  const entries = await realm.fs.listDir(root).catch(() => []);
  const jobs: AudiobookJob[] = [];
  for (const entry of entries) {
    if (entry.type !== "file" || !entry.name.endsWith(JOB_FILE_SUFFIX)) continue;
    const id = entry.name.slice(0, -JOB_FILE_SUFFIX.length);
    if (!JOB_ID_PATTERN.test(id)) continue;
    try {
      jobs.push((await loadAudiobookJob(realm, id)).job);
    } catch {
      // 坏任务文件只影响自身，列表继续返回其余任务。
    }
  }
  jobs.sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id));
  return jobs;
}

function asJobRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalidJob();
  return value as Readonly<Record<string, unknown>>;
}

function jobText(value: unknown, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.trim() === "")) throw invalidJob();
  return value;
}

function jobRelativePath(value: unknown): string {
  const path = relativePathOrNull(jobText(value));
  if (path === null) throw invalidJob();
  return path;
}

/** 章节名就是脚本文件名，与脚本服务一样不接受路径分隔符或控制字符。 */
function jobChapter(value: unknown): string {
  const chapter = jobText(value);
  if (chapter === "." || chapter === ".." || chapter.includes("/") || chapter.includes("\\") || hasControlCharacter(chapter)) {
    throw invalidJob();
  }
  return chapter;
}

function jobInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw invalidJob();
  return value;
}

function jobCost(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw invalidJob();
  return value;
}

function jobChoice<T extends string>(value: unknown, options: readonly T[]): T {
  if (typeof value === "string") {
    const found = options.find((option) => option === value);
    if (found !== undefined) return found;
  }
  throw invalidJob();
}

function jobFailures(value: unknown): readonly { readonly segmentId: string; readonly error: string }[] {
  if (!Array.isArray(value)) throw invalidJob();
  const entries: readonly unknown[] = value;
  return entries.map((entry) => {
    const record = asJobRecord(entry);
    return {
      segmentId: jobText(record["segmentId"]),
      error: jobText(record["error"], true),
    };
  });
}

function jobOutputPath(value: unknown): string | null {
  return value === null ? null : jobRelativePath(value);
}

/** 完整校验并重建任务文档：只接受 schemaVersion 1，丢弃未知字段。 */
function normalizeJob(value: unknown): AudiobookJob {
  const record = asJobRecord(value);
  if (record["schemaVersion"] !== AUDIOBOOK_SCHEMA_VERSION) throw invalidJob();
  const id = jobText(record["id"]);
  if (!JOB_ID_PATTERN.test(id)) throw invalidJob();
  const projectPath = jobRelativePath(record["projectPath"]);
  if (!projectPath.startsWith(`${AUDIOBOOK_ROOT}/`)) throw invalidJob();
  const totalSegments = jobInteger(record["totalSegments"]);
  const completedSegments = jobInteger(record["completedSegments"]);
  if (completedSegments > totalSegments) throw invalidJob();
  return {
    schemaVersion: AUDIOBOOK_SCHEMA_VERSION,
    id,
    projectPath,
    chapter: jobChapter(record["chapter"]),
    sourcePath: jobRelativePath(record["sourcePath"]),
    status: jobChoice(record["status"], JOB_STATUSES),
    totalSegments,
    completedSegments,
    failedSegments: jobFailures(record["failedSegments"]),
    chars: jobInteger(record["chars"]),
    estimatedCost: jobCost(record["estimatedCost"]),
    actualRequests: jobInteger(record["actualRequests"]),
    createdAt: jobInteger(record["createdAt"]),
    updatedAt: jobInteger(record["updatedAt"]),
    outputPath: jobOutputPath(record["outputPath"]),
  };
}
