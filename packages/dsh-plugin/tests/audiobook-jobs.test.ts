import { FsError, type FsTarget } from "@deepseek-ai/dsh-fs";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceRealm } from "../src/workspace-route.js";
import { memoryBinaryFileStore } from "../src/services/audiobook-binary.js";
import { segmentAudioPath, segmentMetaPath, ttsCacheKey, writeCachedSegment } from "../src/services/audiobook-cache.js";
import {
  AUDIOBOOK_JOB_ROOT,
  type AudiobookJob,
  type AudiobookProject,
  type AudiobookScript,
} from "../src/services/audiobook-contract.js";
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
} from "../src/services/audiobook-jobs.js";
import { loadAudiobookProject, saveAudiobookProject } from "../src/services/audiobook-project.js";
import { assignChapterSpeakers, loadChapterScript, segmentId } from "../src/services/audiobook-script.js";
import { OpenAiCompatibleTtsClient, type TtsClient, type TtsFetch } from "../src/services/audiobook-tts.js";
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

it("单段失败时保留已完成段，只为失败段记错且不写其缓存", async () => {
  const { realm, read } = fixtureWithScript();
  const binary = memoryBinaryFileStore();
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init.body)) as { readonly input?: string };
    if (body.input === "世界。") return new Response("bad", { status: 400 });
    return new Response(new Uint8Array([1, 2]), { status: 200, headers: { "content-type": "audio/mpeg" } });
  });
  const runtime = runtimeFor(new OpenAiCompatibleTtsClient({ fetchImpl }), binary);
  const record = await loadAudiobookProject(realm, PROJECT_PATH);
  const created = await createChapterJob(realm, record, CHAPTER, runtime);

  const done = await runChapterJob(realm, created.job.id, runtime);

  expect(done.status).toBe("failed");
  expect(done.completedSegments).toBe(1);
  expect(done.actualRequests).toBe(1);
  expect(done.failedSegments.map((failure) => failure.segmentId)).toEqual(["s-2"]);
  expect(binary.files.has(segmentAudioPath(FIRST_KEY, "mp3"))).toBe(true);
  expect(binary.files.has(segmentAudioPath(SECOND_KEY, "mp3"))).toBe(false);
  expect(read(segmentMetaPath(FIRST_KEY))).toBeDefined();
  expect(read(segmentMetaPath(SECOND_KEY))).toBeUndefined();
  expect((await loadAudiobookJob(realm, created.job.id)).job.completedSegments).toBe(1);
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

it("runChapterJob 缺少密钥时 503，queued 任务落成 failed", async () => {
  const { realm, writes } = fixtureWithScript();
  const binary = memoryBinaryFileStore();
  const record = await loadAudiobookProject(realm, PROJECT_PATH);
  const created = await createChapterJob(realm, record, CHAPTER, runtimeFor(unusedTts, binary));
  const writesBefore = writes.length;

  await expect(runChapterJob(realm, created.job.id, runtimeFor(unusedTts, binary, {})))
    .rejects.toMatchObject({ status: 503 });

  expect(writes.length).toBe(writesBefore + 1);
  expect((await loadAudiobookJob(realm, created.job.id)).job.status).toBe("failed");
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

it("并发创建同一项目章节任务只成功一个", async () => {
  const { realm, writes } = fixtureWithScript();
  const binary = memoryBinaryFileStore();
  const runtime = runtimeFor(unusedTts, binary);
  const record = await loadAudiobookProject(realm, PROJECT_PATH);

  const results = await Promise.allSettled([
    createChapterJob(realm, record, CHAPTER, runtime),
    createChapterJob(realm, record, CHAPTER, runtime),
  ]);

  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  expect(rejected).toHaveLength(1);
  expect(rejected[0]?.reason).toMatchObject({ status: 409 });
  expect(writes.filter((path) => path.startsWith(`${AUDIOBOOK_JOB_ROOT}/`))).toHaveLength(1);
  expect(await listAudiobookJobs(realm)).toHaveLength(1);
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

it("任务文件 CAS 冲突时 runChapterJob 返回 409，原文件内容不变", async () => {
  const fixture = fixtureWithScript();
  const { realm } = fixture;
  const binary = memoryBinaryFileStore();
  const runtime = runtimeFor(new OpenAiCompatibleTtsClient({ fetchImpl: audioFetch() }), binary);
  const record = await loadAudiobookProject(realm, PROJECT_PATH);
  const created = await createChapterJob(realm, record, CHAPTER, runtime);
  const jobPath = `${AUDIOBOOK_JOB_ROOT}/${created.job.id}.json`;
  const before = fixture.read(jobPath);
  expect(before).toBeDefined();

  const original = realm.fs.writeText;
  let injected = false;
  realm.fs.writeText = async (target, content, intent, signal, policy) => {
    if (!injected && target.displayPath.startsWith(`${AUDIOBOOK_JOB_ROOT}/`) && intent?.kind === "replaceIfVersion") {
      injected = true;
      throw new FsError("stale", "FS_STALE_VERSION");
    }
    return await original.call(realm.fs, target, content, intent, signal, policy);
  };
  try {
    await expect(runChapterJob(realm, created.job.id, runtime)).rejects.toMatchObject({ status: 409 });
  } finally {
    realm.fs.writeText = original;
  }

  expect(injected).toBe(true);
  expect(fixture.read(jobPath)).toBe(before);
  expect(binary.files.size).toBe(0);
  expect((await loadAudiobookJob(realm, created.job.id)).job.status).toBe("queued");
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

it("重启后残留的 running 任务可显式恢复，已缓存段不重复请求", async () => {
  const { realm } = memoryRealm({
    [SOURCE_PATH]: "你好。世界。",
    [PROJECT_PATH]: JSON.stringify(projectWith()),
    [SCRIPT_PATH]: JSON.stringify(SCRIPT),
    [`${AUDIOBOOK_JOB_ROOT}/running-1.json`]: jobDocument("running-1", {
      status: "running",
      completedSegments: 1,
      actualRequests: 1,
    }),
  });
  const binary = memoryBinaryFileStore();
  binary.files.set(segmentAudioPath(FIRST_KEY, "mp3"), new Uint8Array([1, 2]));
  const fetchImpl = audioFetch();
  const runtime = runtimeFor(new OpenAiCompatibleTtsClient({ fetchImpl }), binary);

  const done = await runChapterJob(realm, "running-1", runtime);

  expect(done.status).toBe("completed");
  expect(done.completedSegments).toBe(2);
  // 第一段走缓存，只为第二段发一次请求；实际请求数在原值上累加。
  expect(fetchImpl.mock.calls.length).toBe(1);
  expect(done.actualRequests).toBe(2);
});

it("执行前的门禁失败会把任务落成 failed，不留在 queued", async () => {
  const { realm } = memoryRealm({
    [SOURCE_PATH]: "你好。世界。",
    [PROJECT_PATH]: JSON.stringify(projectWith()),
    [`${AUDIOBOOK_JOB_ROOT}/orphan-1.json`]: jobDocument("orphan-1", {
      chapter: "第0002章_回声",
      sourcePath: "正文/第0002章_回声.md",
    }),
  });
  const runtime = runtimeFor(unusedTts, memoryBinaryFileStore());

  await expect(runChapterJob(realm, "orphan-1", runtime))
    .rejects.toMatchObject({ status: 409, message: expect.stringContaining("脚本不存在") });

  expect((await loadAudiobookJob(realm, "orphan-1")).job.status).toBe("failed");
});

it("缺少密钥时 queued 任务落成 failed，不留在 queued", async () => {
  const { realm } = memoryRealm({
    [SOURCE_PATH]: "你好。世界。",
    [PROJECT_PATH]: JSON.stringify(projectWith()),
    [`${AUDIOBOOK_JOB_ROOT}/nokey-1.json`]: jobDocument("nokey-1"),
  });
  const runtime = runtimeFor(unusedTts, memoryBinaryFileStore(), {});

  await expect(runChapterJob(realm, "nokey-1", runtime))
    .rejects.toMatchObject({ status: 503, message: expect.stringContaining("OH_STORY_TTS_API_KEY") });

  expect((await loadAudiobookJob(realm, "nokey-1")).job.status).toBe("failed");
});

it("路由带过期版本落 failed 时跳过，不覆盖另一个执行者的进度", async () => {
  const { realm, writes } = fixtureWithScript();
  const binary = memoryBinaryFileStore();
  const record = await loadAudiobookProject(realm, PROJECT_PATH);
  const created = await createChapterJob(realm, record, CHAPTER, runtimeFor(unusedTts, binary));
  const writesBefore = writes.length;

  await markAudiobookJobFailed(realm, created.job.id, runtimeFor(unusedTts, binary), new Error("precheck"), "v-stale");
  expect(writes.length).toBe(writesBefore);
  expect((await loadAudiobookJob(realm, created.job.id)).job.status).toBe("queued");

  await markAudiobookJobFailed(realm, created.job.id, runtimeFor(unusedTts, binary), new Error("precheck"), created.version);
  expect((await loadAudiobookJob(realm, created.job.id)).job.status).toBe("failed");
});

it("in-flight 标记按工作区隔离", async () => {
  const { realm } = fixtureWithScript();
  const binary = memoryBinaryFileStore();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let notifyStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  const runtime = runtimeFor({
    synthesize: async () => {
      notifyStarted();
      await gate;
      return new Uint8Array([9]);
    },
  }, binary);
  const record = await loadAudiobookProject(realm, PROJECT_PATH);
  const created = await createChapterJob(realm, record, CHAPTER, runtime);

  const running = runChapterJob(realm, created.job.id, runtime);
  await started;
  const otherRealm = { ...realm, root: { targetKey: "/other", displayPath: "/other" } } as typeof realm;
  expect(isAudiobookJobInFlight(realm, created.job.id)).toBe(true);
  expect(isAudiobookJobInFlight(otherRealm, created.job.id)).toBe(false);
  release();
  await running;
  expect(isAudiobookJobInFlight(realm, created.job.id)).toBe(false);
});

it("同一任务并发执行只允许一个，第二个返回 409", async () => {
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
  const runtime = runtimeFor({ synthesize }, binary);
  const record = await loadAudiobookProject(realm, PROJECT_PATH);
  const created = await createChapterJob(realm, record, CHAPTER, runtime);

  const running = runChapterJob(realm, created.job.id, runtime);
  await firstStarted;
  await expect(runChapterJob(realm, created.job.id, runtime)).rejects.toMatchObject({ status: 409 });
  release();
  const done = await running;
  expect(done.status).toBe("completed");
  expect(synthesize).toHaveBeenCalledTimes(2);

  // 执行结束后 in-flight 标记释放，同一任务可以再次执行且只走缓存。
  const again = await runChapterJob(realm, created.job.id, runtime);
  expect(again.status).toBe("completed");
  expect(synthesize).toHaveBeenCalledTimes(2);
});

it("零字节缓存不算命中，plan 与 run 都会重新合成", async () => {
  const { realm } = fixtureWithScript();
  const binary = memoryBinaryFileStore();
  binary.files.set(segmentAudioPath(FIRST_KEY, "mp3"), new Uint8Array());
  const fetchImpl = audioFetch();
  const runtime = runtimeFor(new OpenAiCompatibleTtsClient({ fetchImpl }), binary);
  const record = await loadAudiobookProject(realm, PROJECT_PATH);

  const estimate = await planChapterJob(realm, record, SCRIPT, runtime);
  expect(estimate).toEqual({
    segments: 2,
    chars: 6,
    cacheHits: 0,
    requests: 2,
    estimatedCost: 0.00009,
  });

  const created = await createChapterJob(realm, record, CHAPTER, runtime);
  const done = await runChapterJob(realm, created.job.id, runtime);
  expect(done.status).toBe("completed");
  expect(fetchImpl.mock.calls.length).toBe(2);
  expect(binary.files.get(segmentAudioPath(FIRST_KEY, "mp3"))?.byteLength).toBeGreaterThan(0);
});

it("空脚本不能创建任务，也不能执行", async () => {
  const emptyScript = { ...SCRIPT, segments: [] };
  const { realm, writes } = memoryRealm({
    [SOURCE_PATH]: "你好。世界。",
    [PROJECT_PATH]: JSON.stringify(projectWith()),
    [SCRIPT_PATH]: JSON.stringify(emptyScript),
    [`${AUDIOBOOK_JOB_ROOT}/empty-1.json`]: jobDocument("empty-1", { totalSegments: 0 }),
  });
  const binary = memoryBinaryFileStore();
  const runtime = runtimeFor(unusedTts, binary);
  const record = await loadAudiobookProject(realm, PROJECT_PATH);

  await expect(createChapterJob(realm, record, CHAPTER, runtime)).rejects.toMatchObject({ status: 409 });
  expect(writes.filter((path) => path.startsWith(`${AUDIOBOOK_JOB_ROOT}/`))).toEqual([]);

  await expect(runChapterJob(realm, "empty-1", runtime)).rejects.toMatchObject({ status: 409 });
  expect((await loadAudiobookJob(realm, "empty-1")).job.status).toBe("failed");
});

function multiRoleProject(): AudiobookProject {
  return {
    ...projectWith(),
    cast: [
      { id: "narrator", name: "旁白", kind: "narrator", voice: "alloy" },
      { id: "role-linfan", name: "林帆", kind: "character", voice: "verse" },
      { id: "role-shen", name: "沈秋", kind: "character", voice: "echo" },
    ],
  };
}

function multiRoleScript(speakerId = "role-linfan"): AudiobookScript {
  const narration = "旁白。";
  const dialogue = "林帆来了。";
  return {
    schemaVersion: 1,
    chapter: CHAPTER,
    sourcePath: SOURCE_PATH,
    sourceSha256: "0".repeat(64),
    segments: [
      { id: segmentId("narration", "narrator", narration, 0), kind: "narration", speakerId: "narrator", text: narration, sourceStart: 0, sourceEnd: 3 },
      { id: segmentId("dialogue", speakerId, dialogue, 5), kind: "dialogue", speakerId, text: dialogue, sourceStart: 5, sourceEnd: 10 },
    ],
  };
}

function multiFixture(script: AudiobookScript = multiRoleScript()) {
  return memoryRealm({
    [SOURCE_PATH]: "旁白。\n\n“林帆来了。”\n",
    [PROJECT_PATH]: JSON.stringify(multiRoleProject()),
    [SCRIPT_PATH]: JSON.stringify(script),
  });
}

function recordingTts(): { readonly fetchImpl: TtsFetch; readonly bodies: { voice?: string; input?: string }[] } {
  const bodies: { voice?: string; input?: string }[] = [];
  const fetchImpl: TtsFetch = vi.fn(async (_url: string, init: RequestInit): Promise<Response> => {
    bodies.push(JSON.parse(String(init.body)) as { voice?: string; input?: string });
    return new Response(new Uint8Array([1, 2]), { status: 200, headers: { "content-type": "audio/mpeg" } });
  });
  return { fetchImpl, bodies };
}

it("多角色按各自音色合成，改指派后只重生成受影响段", async () => {
  const { realm } = multiFixture();
  const binary = memoryBinaryFileStore();
  const { fetchImpl, bodies } = recordingTts();
  const runtime = runtimeFor(new OpenAiCompatibleTtsClient({ fetchImpl }), binary);
  const record = await loadAudiobookProject(realm, PROJECT_PATH);

  const first = await createChapterJob(realm, record, CHAPTER, runtime);
  const firstDone = await runChapterJob(realm, first.job.id, runtime);

  expect(firstDone.status).toBe("completed");
  expect(bodies.map((body) => [body.voice, body.input])).toEqual([
    ["alloy", "旁白。"],
    ["verse", "林帆来了。"],
  ]);

  const requestsBeforeReplay = bodies.length;
  const replay = await createChapterJob(realm, record, CHAPTER, runtime);
  const replayDone = await runChapterJob(realm, replay.job.id, runtime);
  expect(replayDone.status).toBe("completed");
  expect(replayDone.actualRequests).toBe(0);
  expect(bodies.length).toBe(requestsBeforeReplay);

  const scriptRecord = await loadChapterScript(realm, PROJECT_PATH, CHAPTER);
  await assignChapterSpeakers(realm, record, CHAPTER, scriptRecord!.version, [
    { segmentId: scriptRecord!.script.segments[1]!.id, speakerId: "role-shen" },
  ]);
  const updated = await loadChapterScript(realm, PROJECT_PATH, CHAPTER);
  const estimate = await planChapterJob(realm, record, updated!.script, runtime);
  expect(estimate).toEqual({
    segments: 2,
    chars: 8,
    cacheHits: 1,
    requests: 1,
    estimatedCost: 0.000075,
  });

  const nextJob = await createChapterJob(realm, record, CHAPTER, runtime);
  const nextDone = await runChapterJob(realm, nextJob.job.id, runtime);
  expect(nextDone.status).toBe("completed");
  expect(nextDone.actualRequests).toBe(1);
  expect(bodies.slice(requestsBeforeReplay).map((body) => [body.voice, body.input])).toEqual([
    ["echo", "林帆来了。"],
  ]);
});

it("改角色音色只失效该角色的分段", async () => {
  const { realm } = multiFixture();
  const binary = memoryBinaryFileStore();
  const { fetchImpl, bodies } = recordingTts();
  const runtime = runtimeFor(new OpenAiCompatibleTtsClient({ fetchImpl }), binary);
  const record = await loadAudiobookProject(realm, PROJECT_PATH);
  const first = await createChapterJob(realm, record, CHAPTER, runtime);
  await runChapterJob(realm, first.job.id, runtime);
  const requestsBefore = bodies.length;

  const updated = await saveAudiobookProject(realm, record.path, {
    ...record.project,
    cast: record.project.cast.map((member) => member.id === "role-linfan" ? { ...member, voice: "verse2" } : member),
  }, record.version);
  const script = await loadChapterScript(realm, PROJECT_PATH, CHAPTER);
  const estimate = await planChapterJob(realm, updated, script!.script, runtime);
  expect(estimate).toEqual({
    segments: 2,
    chars: 8,
    cacheHits: 1,
    requests: 1,
    estimatedCost: 0.000075,
  });

  const next = await createChapterJob(realm, updated, CHAPTER, runtime);
  await runChapterJob(realm, next.job.id, runtime);
  expect(bodies.slice(requestsBefore).map((body) => [body.voice, body.input])).toEqual([
    ["verse2", "林帆来了。"],
  ]);
});

it("未指派对白拦截预估、新建与执行，执行中的任务落 failed", async () => {
  const { realm, writes } = multiFixture(multiRoleScript("unknown"));
  const binary = memoryBinaryFileStore();
  const fetchImpl = audioFetch();
  const runtime = runtimeFor(new OpenAiCompatibleTtsClient({ fetchImpl }), binary);
  const record = await loadAudiobookProject(realm, PROJECT_PATH);
  const script = await loadChapterScript(realm, PROJECT_PATH, CHAPTER);

  await expect(planChapterJob(realm, record, script!.script, runtime))
    .rejects.toMatchObject({ status: 409, message: expect.stringContaining("1 段对白") });
  await expect(createChapterJob(realm, record, CHAPTER, runtime))
    .rejects.toMatchObject({ status: 409, message: expect.stringContaining("1 段对白") });
  expect(writes.filter((path) => path.startsWith(`${AUDIOBOOK_JOB_ROOT}/`))).toEqual([]);
  expect(fetchImpl).not.toHaveBeenCalled();

  const jobTarget = await realm.fs.resolve(`${AUDIOBOOK_JOB_ROOT}/job-queued-1.json`, { cwd: realm.cwd });
  await realm.fs.writeText(jobTarget, jobDocument("job-queued-1"), { kind: "createIfAbsent" });

  await expect(runChapterJob(realm, "job-queued-1", runtime))
    .rejects.toMatchObject({ status: 409, message: expect.stringContaining("1 段对白") });
  expect((await loadAudiobookJob(realm, "job-queued-1")).job.status).toBe("failed");
  expect(binary.files.size).toBe(0);
  expect(fetchImpl).not.toHaveBeenCalled();
});

it("10 章 + 旁白 + 3 角色的样本按角色音色生成，整批重跑零请求", async () => {
  const chapters = Array.from({ length: 10 }, (_, index) => `第${String(index + 1).padStart(4, "0")}章_样本`);
  const sourcePaths = chapters.map((chapter) => `正文/${chapter}.md`);
  const cast = [
    { id: "narrator", name: "旁白", kind: "narrator" as const, voice: "alloy" },
    { id: "role-linfan", name: "林帆", kind: "character" as const, voice: "verse" },
    { id: "role-shen", name: "沈秋", kind: "character" as const, voice: "echo" },
    { id: "role-gu", name: "顾遥", kind: "character" as const, voice: "shimmer" },
  ];
  const project: AudiobookProject = {
    ...projectWith(),
    source: { bookRoot: "正文", chapters: sourcePaths },
    cast,
  };
  const seed: Record<string, string> = { [PROJECT_PATH]: JSON.stringify(project) };
  for (const [index, chapter] of chapters.entries()) {
    seed[sourcePaths[index]!] = "样本正文。\n";
    const segments = [
      { kind: "narration" as const, speakerId: "narrator", text: `第${String(index + 1)}章旁白。`, start: 0 },
      { kind: "dialogue" as const, speakerId: "role-linfan", text: `林帆的第${String(index + 1)}句。`, start: 10 },
      { kind: "dialogue" as const, speakerId: "role-shen", text: `沈秋的第${String(index + 1)}句。`, start: 20 },
      { kind: "dialogue" as const, speakerId: "role-gu", text: `顾遥的第${String(index + 1)}句。`, start: 30 },
    ].map((segment) => ({
      id: segmentId(segment.kind, segment.speakerId, segment.text, segment.start),
      kind: segment.kind,
      speakerId: segment.speakerId,
      text: segment.text,
      sourceStart: segment.start,
      sourceEnd: segment.start + segment.text.length,
    }));
    seed[`有声剧/长夜行/脚本/${chapter}.json`] = JSON.stringify({
      schemaVersion: 1,
      chapter,
      sourcePath: sourcePaths[index],
      sourceSha256: "0".repeat(64),
      segments,
    });
  }
  const { realm } = memoryRealm(seed);
  const binary = memoryBinaryFileStore();
  const { fetchImpl, bodies } = recordingTts();
  const runtime = runtimeFor(new OpenAiCompatibleTtsClient({ fetchImpl }), binary);
  const record = await loadAudiobookProject(realm, PROJECT_PATH);

  for (const chapter of chapters) {
    const created = await createChapterJob(realm, record, chapter, runtime);
    const done = await runChapterJob(realm, created.job.id, runtime);
    expect(done.status).toBe("completed");
    expect(done.completedSegments).toBe(4);
  }
  const firstPassRequests = bodies.length;
  expect(firstPassRequests).toBe(40);
  expect(new Set(bodies.map((body) => body.voice))).toEqual(new Set(["alloy", "verse", "echo", "shimmer"]));

  for (const chapter of chapters) {
    const replay = await createChapterJob(realm, record, chapter, runtime);
    const replayDone = await runChapterJob(realm, replay.job.id, runtime);
    expect(replayDone.status).toBe("completed");
    expect(replayDone.actualRequests).toBe(0);
  }
  expect(bodies.length).toBe(firstPassRequests);
});
