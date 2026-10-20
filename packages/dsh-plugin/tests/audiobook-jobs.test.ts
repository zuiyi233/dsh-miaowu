import type { FsTarget } from "@deepseek-ai/dsh-fs";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceRealm } from "../src/workspace-route.js";
import { memoryBinaryFileStore } from "../src/services/audiobook-binary.js";
import { segmentAudioPath, ttsCacheKey, writeCachedSegment } from "../src/services/audiobook-cache.js";
import {
  AUDIOBOOK_JOB_ROOT,
  type AudiobookJob,
  type AudiobookProject,
  type AudiobookScript,
} from "../src/services/audiobook-contract.js";
import {
  cancelAudiobookJob,
  createChapterJob,
  listAudiobookJobs,
  loadAudiobookJob,
  planChapterJob,
  runChapterJob,
  type AudiobookJobRuntime,
} from "../src/services/audiobook-jobs.js";
import { loadAudiobookProject } from "../src/services/audiobook-project.js";
import { OpenAiCompatibleTtsClient, type TtsClient } from "../src/services/audiobook-tts.js";
import { SANDBOX_POLICY, memoryRealm } from "./audiobook-fixtures.js";

const PROJECT_PATH = "有声剧/长夜行/project.json";
const SCRIPT_PATH = "有声剧/长夜行/脚本/第0001章_开篇.json";
const CHAPTER = "第0001章_开篇";
const SOURCE_PATH = "正文/第0001章_开篇.md";
const NOW = 1_760_000_000_000;
const SECRET = "sk-test-secret";

const SCRIPT: AudiobookScript = {
  schemaVersion: 1,
  chapter: CHAPTER,
  sourcePath: SOURCE_PATH,
  sourceSha256: "0".repeat(64),
  segments: [
    { id: "s-1", kind: "narration", speakerId: "narrator", text: "你好。", sourceStart: 0, sourceEnd: 3 },
    { id: "s-2", kind: "narration", speakerId: "narrator", text: "世界。", sourceStart: 3, sourceEnd: 6 },
  ],
};

const FIRST_KEY = ttsCacheKey({
  baseUrl: "https://api.example.com/v1",
  model: "tts-1",
  voice: "alloy",
  speed: 1,
  responseFormat: "mp3",
  text: "你好。",
});

const SECOND_KEY = ttsCacheKey({
  baseUrl: "https://api.example.com/v1",
  model: "tts-1",
  voice: "alloy",
  speed: 1,
  responseFormat: "mp3",
  text: "世界。",
});

function projectWith(maxCharsPerChapter = 20_000): AudiobookProject {
  return {
    schemaVersion: 1,
    source: { bookRoot: "正文", chapters: [SOURCE_PATH] },
    tts: {
      baseUrl: "https://api.example.com/v1",
      model: "tts-1",
      responseFormat: "mp3",
      speed: 1,
      pricePerMillionChars: 15,
      maxCharsPerChapter,
      concurrency: 2,
    },
    cast: [{ id: "narrator", name: "旁白", kind: "narrator", voice: "alloy" }],
    cues: [],
    export: { mp3BitrateKbps: 192, sampleRate: 44_100, channels: 2, loudnessLufs: -16, truePeakDbtp: -1.5, subtitles: [] },
    rights: { voiceCloning: false },
  };
}

function fixtureWithScript(options: { readonly maxCharsPerChapter?: number } = {}) {
  return memoryRealm({
    [SOURCE_PATH]: "你好。世界。",
    [PROJECT_PATH]: JSON.stringify(projectWith(options.maxCharsPerChapter ?? 20_000)),
    [SCRIPT_PATH]: JSON.stringify(SCRIPT),
  });
}

function runtimeFor(
  tts: TtsClient,
  binary = memoryBinaryFileStore(),
  env: Readonly<Record<string, string | undefined>> = { OH_STORY_TTS_API_KEY: SECRET },
): AudiobookJobRuntime {
  return { tts, binary, now: () => NOW, env };
}

const unusedTts: TtsClient = {
  synthesize: () => Promise.reject(new Error("本用例不应调用 TTS。")),
};

function audioFetch() {
  return vi.fn(async (): Promise<Response> =>
    new Response(new Uint8Array([1, 2]), { status: 200, headers: { "content-type": "audio/mpeg" } }));
}

function jobDocument(id: string, overrides: Partial<AudiobookJob> = {}): string {
  const job: AudiobookJob = {
    schemaVersion: 1,
    id,
    projectPath: PROJECT_PATH,
    chapter: CHAPTER,
    sourcePath: SOURCE_PATH,
    status: "queued",
    totalSegments: 2,
    completedSegments: 0,
    failedSegments: [],
    chars: 6,
    estimatedCost: 0.00009,
    actualRequests: 0,
    createdAt: NOW,
    updatedAt: NOW,
    outputPath: null,
    ...overrides,
  };
  return JSON.stringify(job);
}

it("缓存命中不调用 TTS，失败段被记录", async () => {
  const { realm } = fixtureWithScript();
  const binary = memoryBinaryFileStore();
  const fetchImpl = audioFetch();
  const runtime = runtimeFor(new OpenAiCompatibleTtsClient({ fetchImpl }), binary);
  const record = await loadAudiobookProject(realm, PROJECT_PATH);
  const created = await createChapterJob(realm, record, CHAPTER, runtime);
  const done = await runChapterJob(realm, created.job.id, runtime);
  expect(done.status).toBe("completed");
  expect(done.completedSegments).toBe(created.job.totalSegments);
  const firstRequests = fetchImpl.mock.calls.length;
  expect(firstRequests).toBe(created.job.totalSegments);
  const replay = await createChapterJob(realm, record, CHAPTER, runtime);
  const replayDone = await runChapterJob(realm, replay.job.id, runtime);
  expect(replayDone.status).toBe("completed");
  expect(replayDone.actualRequests).toBe(0);
  expect(fetchImpl.mock.calls.length).toBe(firstRequests);
});

it("TTS 失败段被记录，不写该段缓存", async () => {
  const { realm } = fixtureWithScript();
  const binary = memoryBinaryFileStore();
  const fetchImpl = vi.fn(async (): Promise<Response> =>
    new Response("bad", { status: 400 }));
  const runtime = runtimeFor(new OpenAiCompatibleTtsClient({ fetchImpl }), binary);
  const record = await loadAudiobookProject(realm, PROJECT_PATH);
  const created = await createChapterJob(realm, record, CHAPTER, runtime);
  const done = await runChapterJob(realm, created.job.id, runtime);
  expect(done.status).toBe("failed");
  expect(done.failedSegments).toHaveLength(2);
  expect(done.completedSegments).toBe(0);
  expect(binary.files.size).toBe(0);
});

it("planChapterJob 统计缓存命中，成本只计未命中", async () => {
  const { realm, writes } = fixtureWithScript();
  const binary = memoryBinaryFileStore();
  await writeCachedSegment(realm, binary, FIRST_KEY, "mp3", new Uint8Array([1, 2]), {
    model: "tts-1",
    voice: "alloy",
    text: "你好。",
  });
  const record = await loadAudiobookProject(realm, PROJECT_PATH);

  const estimate = await planChapterJob(realm, record, SCRIPT, runtimeFor(unusedTts, binary));

  expect(estimate).toEqual({
    segments: 2,
    chars: 6,
    cacheHits: 1,
    requests: 1,
    estimatedCost: 0.000045,
  });
  expect(writes.filter((path) => path.startsWith(`${AUDIOBOOK_JOB_ROOT}/`))).toEqual([]);
});

it("缺少密钥时 plan/create 返回 503 且不写任务文件", async () => {
  const { realm, writes } = fixtureWithScript();
  const binary = memoryBinaryFileStore();
  const record = await loadAudiobookProject(realm, PROJECT_PATH);

  await expect(planChapterJob(realm, record, SCRIPT, runtimeFor(unusedTts, binary, {})))
    .rejects.toMatchObject({ status: 503 });
  await expect(createChapterJob(realm, record, CHAPTER, runtimeFor(unusedTts, binary, {})))
    .rejects.toMatchObject({ status: 503 });
  await expect(createChapterJob(realm, record, CHAPTER, runtimeFor(unusedTts, binary, { OH_STORY_TTS_API_KEY: "   " })))
    .rejects.toMatchObject({ status: 503 });
  expect(writes.filter((path) => path.startsWith(`${AUDIOBOOK_JOB_ROOT}/`))).toEqual([]);
});

it("runChapterJob 缺少密钥时 503 且任务状态不变", async () => {
  const { realm, writes } = fixtureWithScript();
  const binary = memoryBinaryFileStore();
  const record = await loadAudiobookProject(realm, PROJECT_PATH);
  const created = await createChapterJob(realm, record, CHAPTER, runtimeFor(unusedTts, binary));
  const writesBefore = writes.length;

  await expect(runChapterJob(realm, created.job.id, runtimeFor(unusedTts, binary, {})))
    .rejects.toMatchObject({ status: 503 });

  expect(writes.length).toBe(writesBefore);
  expect((await loadAudiobookJob(realm, created.job.id)).job.status).toBe("queued");
});

it("超过单章字符上限时 createChapterJob 返回 409", async () => {
  const { realm, writes } = fixtureWithScript({ maxCharsPerChapter: 5 });
  const binary = memoryBinaryFileStore();
  const record = await loadAudiobookProject(realm, PROJECT_PATH);

  await expect(createChapterJob(realm, record, CHAPTER, runtimeFor(unusedTts, binary)))
    .rejects.toMatchObject({ status: 409 });

  expect(writes.filter((path) => path.startsWith(`${AUDIOBOOK_JOB_ROOT}/`))).toEqual([]);
  expect(await listAudiobookJobs(realm)).toEqual([]);
});

it("同一章节已有排队任务时拒绝再次创建，完成后允许新任务", async () => {
  const { realm } = fixtureWithScript();
  const binary = memoryBinaryFileStore();
  const runtime = runtimeFor(new OpenAiCompatibleTtsClient({ fetchImpl: audioFetch() }), binary);
  const record = await loadAudiobookProject(realm, PROJECT_PATH);

  const first = await createChapterJob(realm, record, CHAPTER, runtime);
  expect(first.job.status).toBe("queued");
  await expect(createChapterJob(realm, record, CHAPTER, runtime)).rejects.toMatchObject({ status: 409 });
  expect(await listAudiobookJobs(realm)).toHaveLength(1);

  const done = await runChapterJob(realm, first.job.id, runtime);
  expect(done.status).toBe("completed");

  const next = await createChapterJob(realm, record, CHAPTER, runtime);
  expect(next.job.status).toBe("queued");
  expect(next.job.id).not.toBe(first.job.id);
  expect(await listAudiobookJobs(realm)).toHaveLength(2);
});

it("取消后当前段完成、后续段不再请求，状态暂停且保留缓存", async () => {
  const { realm } = fixtureWithScript();
  const binary = memoryBinaryFileStore();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let notifyStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  const synthesize = vi.fn(async () => {
    notifyStarted();
    await gate;
    return new Uint8Array([9]);
  });
  const tts: TtsClient = { synthesize };
  const runtime = runtimeFor(tts, binary);
  const record = await loadAudiobookProject(realm, PROJECT_PATH);
  const created = await createChapterJob(realm, record, CHAPTER, runtime);

  const running = runChapterJob(realm, created.job.id, runtime);
  await firstStarted;
  cancelAudiobookJob(created.job.id);
  release();
  const paused = await running;

  expect(paused.status).toBe("paused");
  expect(paused.completedSegments).toBe(1);
  expect(paused.actualRequests).toBe(1);
  expect(paused.failedSegments).toEqual([]);
  expect(synthesize).toHaveBeenCalledTimes(1);
  expect(binary.files.has(segmentAudioPath(FIRST_KEY, "mp3"))).toBe(true);
  expect((await loadAudiobookJob(realm, created.job.id)).job.status).toBe("paused");

  // 取消标记已被消费且缓存未删除：再次执行只补未完成段。
  const resumed = await runChapterJob(realm, created.job.id, runtime);
  expect(resumed.status).toBe("completed");
  expect(resumed.completedSegments).toBe(2);
  expect(synthesize).toHaveBeenCalledTimes(2);
  expect(binary.files.has(segmentAudioPath(SECOND_KEY, "mp3"))).toBe(true);
});

it("任务逐段原子持久化：每次写入都是 CAS 且 JSON 可解析、无密钥", async () => {
  const { realm, writeCalls, policyRequests } = fixtureWithScript();
  const binary = memoryBinaryFileStore();
  const runtime = runtimeFor(new OpenAiCompatibleTtsClient({ fetchImpl: audioFetch() }), binary);
  const record = await loadAudiobookProject(realm, PROJECT_PATH);

  const created = await createChapterJob(realm, record, CHAPTER, runtime);
  const done = await runChapterJob(realm, created.job.id, runtime);
  expect(done.status).toBe("completed");

  const jobWrites = writeCalls.filter((call) => call.path.startsWith(`${AUDIOBOOK_JOB_ROOT}/`));
  expect(jobWrites).toHaveLength(5);
  expect(jobWrites[0]?.intent).toEqual({ kind: "createIfAbsent" });
  expect(jobWrites.slice(1).every((call) => call.intent?.kind === "replaceIfVersion")).toBe(true);

  const parsed = jobWrites.map((call) => JSON.parse(call.content) as AudiobookJob);
  for (const job of parsed) expect(job.schemaVersion).toBe(1);
  expect(parsed.map((job) => job.status)).toEqual(["queued", "running", "running", "running", "completed"]);
  expect(parsed.at(-1)?.completedSegments).toBe(2);
  expect(jobWrites.every((call) => call.sandboxPolicy === SANDBOX_POLICY)).toBe(true);
  expect(policyRequests).toHaveLength(writeCalls.length);
  expect(jobWrites.every((call) => !call.content.includes(SECRET))).toBe(true);
});

describe("loadAudiobookJob", () => {
  it("非法 ID 返回 400，任务目录越界返回 403", async () => {
    const { realm } = memoryRealm();
    for (const id of ["../project", "a".repeat(65), "", "a/b", "任务"]) {
      await expect(loadAudiobookJob(realm, id)).rejects.toMatchObject({ status: 400 });
    }

    const base = memoryRealm();
    const detached = {
      ...base.realm,
      fs: {
        ...base.realm.fs,
        contains: (parent: FsTarget): boolean => parent.displayPath === "",
      },
    } as unknown as WorkspaceRealm;
    await expect(loadAudiobookJob(detached, "abc")).rejects.toMatchObject({ status: 403 });
  });

  it("缺失返回 404，坏 JSON、错误 schema 与 id 不匹配返回 422", async () => {
    const missing = memoryRealm();
    await expect(loadAudiobookJob(missing.realm, "0b5b3390")).rejects.toMatchObject({ status: 404 });

    const broken = memoryRealm({ [`${AUDIOBOOK_JOB_ROOT}/broken.json`]: "{" });
    await expect(loadAudiobookJob(broken.realm, "broken")).rejects.toMatchObject({ status: 422 });

    const valid = JSON.parse(jobDocument("schema")) as Record<string, unknown>;
    const wrongSchedule = memoryRealm({
      [`${AUDIOBOOK_JOB_ROOT}/schema.json`]: JSON.stringify({ ...valid, schemaVersion: 2 }),
    });
    await expect(loadAudiobookJob(wrongSchedule.realm, "schema")).rejects.toMatchObject({ status: 422 });

    const mismatch = memoryRealm({ [`${AUDIOBOOK_JOB_ROOT}/expected.json`]: jobDocument("other") });
    await expect(loadAudiobookJob(mismatch.realm, "expected")).rejects.toMatchObject({ status: 422 });

    const badChapter = memoryRealm({
      [`${AUDIOBOOK_JOB_ROOT}/chapter.json`]: jobDocument("chapter", { chapter: "../逃逸" }),
    });
    await expect(loadAudiobookJob(badChapter.realm, "chapter")).rejects.toMatchObject({ status: 422 });
  });
});

describe("listAudiobookJobs", () => {
  it("缺少任务目录返回空，坏文件被跳过", async () => {
    expect(await listAudiobookJobs(memoryRealm().realm)).toEqual([]);

    const { realm } = memoryRealm({
      [`${AUDIOBOOK_JOB_ROOT}/ok.json`]: jobDocument("ok"),
      [`${AUDIOBOOK_JOB_ROOT}/broken.json`]: "{",
      [`${AUDIOBOOK_JOB_ROOT}/notes.txt`]: "not a job",
    });

    expect((await listAudiobookJobs(realm)).map((job) => job.id)).toEqual(["ok"]);
  });
});

it("缺失章节脚本时 createChapterJob 返回 409", async () => {
  const { realm } = fixtureWithScript();
  const binary = memoryBinaryFileStore();
  const record = await loadAudiobookProject(realm, PROJECT_PATH);

  await expect(createChapterJob(realm, record, "第0002章_回声", runtimeFor(unusedTts, binary)))
    .rejects.toMatchObject({ status: 409 });
});
