import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceRealm } from "../src/workspace-route.js";
import {
  memoryBinaryFileStore,
  type MemoryBinaryFileStore,
} from "../src/services/audiobook-binary.js";
import { segmentAudioPath, ttsCacheKey } from "../src/services/audiobook-cache.js";
import {
  AUDIOBOOK_JOB_ROOT,
  type AudiobookJob,
  type AudiobookOverview,
  type AudiobookProject,
  type AudiobookProjectView,
  type AudiobookScript,
} from "../src/services/audiobook-contract.js";
import {
  chapterAudioPathFor,
  type CommandResult,
  type CommandRunner,
} from "../src/services/audiobook-export.js";
import {
  handleAudiobookRequest,
  type AudiobookRouteDeps,
  type AudiobookRuntime,
} from "../src/services/audiobook-route.js";
import type { TtsClient } from "../src/services/audiobook-tts.js";
import { CHAPTERS, memoryRealm, type MemoryRealm } from "./audiobook-fixtures.js";

const SESSION_ID = "session-1";
const PROJECT_PATH = "有声剧/长夜行/project.json";
const SCRIPT_PATH = "有声剧/长夜行/脚本/第0001章_开篇.json";
const CHAPTER = "第0001章_开篇";
const SECOND_CHAPTER = "第0002章_回声";
const SOURCE_PATH = "正文/第0001章_开篇.md";
const AUDIO_PATH = "有声剧/长夜行/音频/第0001章_开篇.mp3";
const JOB_ID = "job-paused-1";
const SECRET = "sk-route-secret";
const NOW = 1_760_000_000_000;

const TTS = {
  baseUrl: "https://api.example.com/v1",
  model: "tts-1",
  responseFormat: "mp3" as const,
  speed: 1,
  pricePerMillionChars: 15,
  maxCharsPerChapter: 20_000,
  concurrency: 2,
};

const PROJECT: AudiobookProject = {
  schemaVersion: 1,
  source: { bookRoot: "正文", chapters: [SOURCE_PATH, "正文/第0002章_回声.md"] },
  tts: TTS,
  cast: [{ id: "narrator", name: "旁白", kind: "narrator", voice: "alloy" }],
  cues: [],
  export: {
    mp3BitrateKbps: 192,
    sampleRate: 44_100,
    channels: 2,
    loudnessLufs: -16,
    truePeakDbtp: -1.5,
    subtitles: [],
  },
  rights: { voiceCloning: false },
};

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

const unusedTts: TtsClient = {
  synthesize: () => Promise.reject(new Error("路由测试不应直接调用 TTS。")),
};

type RunHandler = (command: string, args: readonly string[]) => CommandResult | Promise<CommandResult>;

interface FakeRunner extends CommandRunner {
  readonly calls: string[];
}

function makeRunner(handler?: RunHandler): FakeRunner {
  const calls: string[] = [];
  return {
    calls,
    run: async (command, args) => {
      calls.push([command, ...args].join(" "));
      if (handler === undefined) return { code: 0, stdout: "", stderr: "" };
      return await handler(command, args);
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function cacheKeyFor(text: string): string {
  return ttsCacheKey({
    baseUrl: TTS.baseUrl,
    model: TTS.model,
    voice: "alloy",
    speed: TTS.speed,
    responseFormat: TTS.responseFormat,
    text,
  });
}

function jobDocument(id: string, status: AudiobookJob["status"]): string {
  const job: AudiobookJob = {
    schemaVersion: 1,
    id,
    projectPath: PROJECT_PATH,
    chapter: CHAPTER,
    sourcePath: SOURCE_PATH,
    status,
    totalSegments: 2,
    completedSegments: 0,
    failedSegments: [],
    chars: 6,
    estimatedCost: 0.00009,
    actualRequests: 0,
    createdAt: NOW,
    updatedAt: NOW,
    outputPath: null,
  };
  return JSON.stringify(job);
}

interface Fixture extends MemoryRealm {
  readonly binary: MemoryBinaryFileStore;
  readonly runner: FakeRunner;
  readonly runtime: AudiobookRuntime;
  readonly runJob: NonNullable<AudiobookRouteDeps["runJob"]>;
  readonly runCalls: readonly { readonly realm: WorkspaceRealm; readonly jobId: string; readonly runtime: AudiobookRuntime }[];
  readonly context: Context;
  readonly logged: unknown[];
}

interface FixtureOptions {
  readonly seed?: Record<string, string>;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly run?: RunHandler;
  readonly binary?: MemoryBinaryFileStore;
}

function fixture(options: FixtureOptions = {}): Fixture {
  const state = memoryRealm({
    ...CHAPTERS,
    [PROJECT_PATH]: JSON.stringify(PROJECT),
    [SCRIPT_PATH]: JSON.stringify(SCRIPT),
    ...options.seed,
  });
  const binary = options.binary ?? memoryBinaryFileStore();
  const runner = makeRunner(options.run);
  const runtime: AudiobookRuntime = {
    tts: unusedTts,
    binary,
    runner,
    now: () => NOW,
    env: options.env ?? { OH_STORY_TTS_API_KEY: SECRET, OH_STORY_TTS_BASE_URL: TTS.baseUrl },
  };
  const runCalls: { realm: WorkspaceRealm; jobId: string; runtime: AudiobookRuntime }[] = [];
  const runJob = vi.fn(async (realm: WorkspaceRealm, jobId: string, runRuntime: AudiobookRuntime): Promise<unknown> => {
    runCalls.push({ realm, jobId, runtime: runRuntime });
    return undefined;
  });
  const logged: unknown[] = [];
  const agent = {
    session: { header: { cwd: "" } },
    ctx: {
      get: (key: string): unknown =>
        key === "fs" ? state.realm.fs : key === "sandboxPolicy" ? state.realm.sandboxPolicy : undefined,
    },
  };
  const context = {
    typert: { lookups: { get: () => ({ resolve: async (): Promise<unknown> => agent }) } },
    get: (): unknown => undefined,
    logger: () => ({
      error: (message: string, error?: unknown): void => {
        logged.push({ message, error });
      },
      warn: (): void => undefined,
    }),
  } as unknown as Context;
  return { ...state, binary, runner, runtime, runJob, runCalls, context, logged };
}

interface RouteResult {
  readonly status: number | undefined;
  readonly headers: Readonly<Record<string, string | number>>;
  readonly bytes: Buffer;
  readonly json: unknown;
  readonly handled: boolean;
}

async function callRoute(
  harness: Fixture,
  method: string,
  path: string,
  body?: unknown,
): Promise<RouteResult> {
  const separator = path.includes("?") ? "&" : "?";
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const request = {
    method,
    url: `${path}${separator}sessionId=${SESSION_ID}`,
    headers: {},
    async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
      for (const chunk of chunks) yield chunk;
    },
  } as unknown as IncomingMessage;
  let status: number | undefined;
  let headers: Record<string, string | number> = {};
  let bytes = Buffer.alloc(0);
  const response = {
    writeHead: (nextStatus: number, nextHeaders?: Record<string, string | number>): void => {
      status = nextStatus;
      headers = nextHeaders ?? {};
    },
    end: (raw?: string | Uint8Array): void => {
      bytes = raw === undefined ? Buffer.alloc(0) : Buffer.from(raw);
    },
  } as unknown as ServerResponse;
  const deps: AudiobookRouteDeps = { runtime: () => harness.runtime, runJob: harness.runJob };
  const handled = await handleAudiobookRequest(
    harness.context,
    request,
    response,
    { maxBytes: 2 * 1_024 * 1_024 },
    deps,
  );
  const text = bytes.toString("utf8");
  const isJson = String(headers["content-type"] ?? "").startsWith("application/json");
  return {
    status,
    headers,
    bytes,
    json: isJson && text.trim() !== "" ? JSON.parse(text) as unknown : undefined,
    handled,
  };
}

function projectView(result: RouteResult): AudiobookProjectView {
  return result.json as AudiobookProjectView;
}

describe("GET /oh-story/audiobook", () => {
  it("返回项目、书籍与预检，响应不含密钥值", async () => {
    const harness = fixture();

    const result = await callRoute(harness, "GET", "/oh-story/audiobook");

    expect(result.handled).toBe(true);
    expect(result.status).toBe(200);
    const overview = result.json as AudiobookOverview;
    expect(overview.projects).toEqual([{ path: PROJECT_PATH, name: "长夜行", bookRoot: "正文", chapters: 2 }]);
    expect(overview.sources.map((source) => source.bookRoot)).toEqual(["正文"]);
    expect(overview.errors).toEqual([]);
    expect(overview.preflight).toEqual({
      ttsKey: "present",
      ttsHost: TTS.baseUrl,
      ffmpeg: true,
      ffprobe: true,
    });
    expect(result.bytes.toString("utf8")).not.toContain(SECRET);
    expect(harness.writes).toHaveLength(0);
  });

  it("缺少密钥与非法端点时预检降级为 missing/null", async () => {
    const harness = fixture({ env: { OH_STORY_TTS_BASE_URL: "http://api.example.com/v1" } });
    const result = await callRoute(harness, "GET", "/oh-story/audiobook");
    expect(result.status).toBe(200);
    expect((result.json as AudiobookOverview).preflight).toEqual({
      ttsKey: "missing",
      ttsHost: null,
      ffmpeg: true,
      ffprobe: true,
    });
  });
});

describe("POST /oh-story/audiobook/project", () => {
  it("创建项目返回 201 并写入 project.json", async () => {
    const harness = fixture();
    const result = await callRoute(harness, "POST", "/oh-story/audiobook/project", {
      bookRoot: "正文",
      name: "新书",
      voice: "alloy",
      baseUrl: TTS.baseUrl,
      model: TTS.model,
    });

    expect(result.status).toBe(201);
    expect(asRecord(asRecord(result.json)["record"])["path"]).toBe("有声剧/新书/project.json");
    expect(harness.read("有声剧/新书/project.json")).toContain("\"schemaVersion\": 1");
    expect(harness.writes).toEqual(["有声剧/新书/project.json"]);
  });

  it("请求体嵌套 apiKey 返回 400 且不写文件", async () => {
    const harness = fixture();
    const result = await callRoute(harness, "POST", "/oh-story/audiobook/project", {
      bookRoot: "正文",
      name: "新书",
      voice: "alloy",
      baseUrl: TTS.baseUrl,
      model: TTS.model,
      tts: { apiKey: SECRET },
    });

    expect(result.status).toBe(400);
    expect(String(asRecord(result.json)["error"])).toContain("密钥");
    expect(harness.writes).toHaveLength(0);
  });
});

describe("GET /oh-story/audiobook/project", () => {
  it("返回章节脚本/音频/任务摘要与预检", async () => {
    const harness = fixture({
      seed: {
        [`${AUDIOBOOK_JOB_ROOT}/${JOB_ID}.json`]: jobDocument(JOB_ID, "completed"),
        [AUDIO_PATH]: "ID3",
      },
    });

    const result = await callRoute(
      harness,
      "GET",
      `/oh-story/audiobook/project?path=${encodeURIComponent(PROJECT_PATH)}`,
    );

    expect(result.status).toBe(200);
    const view = projectView(result);
    expect(view.record.path).toBe(PROJECT_PATH);
    expect(view.chapters.map((chapter) => chapter.chapter)).toEqual([CHAPTER, SECOND_CHAPTER]);
    const first = view.chapters[0]!;
    expect(first.hasScript).toBe(true);
    expect(first.segmentCount).toBe(2);
    expect(first.scriptPath).toBe(SCRIPT_PATH);
    expect(first.audioPath).toBe(AUDIO_PATH);
    expect(first.jobId).toBe(JOB_ID);
    expect(first.jobStatus).toBe("completed");
    const second = view.chapters[1]!;
    expect(second.hasScript).toBe(false);
    expect(second.segmentCount).toBe(0);
    expect(second.audioPath).toBeNull();
    expect(second.jobId).toBeNull();
    expect(view.preflight.ttsKey).toBe("present");
    expect(harness.writes).toHaveLength(0);
  });
});

describe("PUT /oh-story/audiobook/project", () => {
  it("按 baseVersion 保存项目并拒绝嵌套密钥", async () => {
    const harness = fixture();
    const loaded = await callRoute(
      harness,
      "GET",
      `/oh-story/audiobook/project?path=${encodeURIComponent(PROJECT_PATH)}`,
    );
    const version = String(asRecord(asRecord(loaded.json)["record"])["version"]);
    const next = { ...PROJECT, cast: [{ ...PROJECT.cast[0]!, voice: "verse" }] };

    const saved = await callRoute(harness, "PUT", "/oh-story/audiobook/project", {
      path: PROJECT_PATH,
      baseVersion: version,
      project: next,
    });

    expect(saved.status).toBe(200);
    expect(JSON.stringify(asRecord(asRecord(saved.json)["record"])["project"])).toContain("\"verse\"");
    expect(harness.read(PROJECT_PATH)).toContain("\"voice\": \"verse\"");

    const rejected = await callRoute(harness, "PUT", "/oh-story/audiobook/project", {
      path: PROJECT_PATH,
      baseVersion: version,
      project: { ...next, nested: { secret: SECRET } },
    });
    expect(rejected.status).toBe(400);
    expect(String(asRecord(rejected.json)["error"])).toContain("密钥");
  });
});

describe("POST /oh-story/audiobook/script", () => {
  it("已有脚本未确认返回 400，确认后覆盖", async () => {
    const harness = fixture();

    const denied = await callRoute(harness, "POST", "/oh-story/audiobook/script", {
      path: PROJECT_PATH,
      chapter: CHAPTER,
    });
    expect(denied.status).toBe(400);
    expect(harness.writes).toHaveLength(0);

    const confirmed = await callRoute(harness, "POST", "/oh-story/audiobook/script", {
      path: PROJECT_PATH,
      chapter: CHAPTER,
      confirm: true,
    });
    expect(confirmed.status).toBe(200);
    const record = asRecord(asRecord(confirmed.json)["script"]);
    expect(record["path"]).toBe(SCRIPT_PATH);
    const saved = asRecord(record["script"]);
    expect(saved["chapter"]).toBe(CHAPTER);
    expect(saved["segments"]).toHaveLength(3);
    expect(harness.writes).toEqual([SCRIPT_PATH]);
  });

  it("项目没有该章节时返回 404", async () => {
    const harness = fixture();
    const result = await callRoute(harness, "POST", "/oh-story/audiobook/script", {
      path: PROJECT_PATH,
      chapter: "第9999章_终章",
    });
    expect(result.status).toBe(404);
    expect(harness.writes).toHaveLength(0);
  });
});

describe("POST /oh-story/audiobook/jobs", () => {
  it("dryRun 返回预估且不写任务文件、不启动执行", async () => {
    const harness = fixture();
    const result = await callRoute(harness, "POST", "/oh-story/audiobook/jobs", {
      path: PROJECT_PATH,
      chapter: CHAPTER,
      dryRun: true,
    });

    expect(result.status).toBe(200);
    expect(asRecord(result.json)["estimate"]).toEqual({
      segments: 2,
      chars: 6,
      cacheHits: 0,
      requests: 2,
      estimatedCost: 0.00009,
    });
    expect(harness.writes.filter((path) => path.startsWith(`${AUDIOBOOK_JOB_ROOT}/`))).toEqual([]);
    expect(harness.runCalls).toHaveLength(0);
  });

  it("真实启动未确认返回 400 且不建任务", async () => {
    const harness = fixture();
    const result = await callRoute(harness, "POST", "/oh-story/audiobook/jobs", {
      path: PROJECT_PATH,
      chapter: CHAPTER,
    });

    expect(result.status).toBe(400);
    expect(String(asRecord(result.json)["error"])).toContain("confirm: true");
    expect(harness.writes).toHaveLength(0);
    expect(harness.runCalls).toHaveLength(0);
  });

  it("确认后返回 202、写入任务并交给 runJob", async () => {
    const harness = fixture();
    const result = await callRoute(harness, "POST", "/oh-story/audiobook/jobs", {
      path: PROJECT_PATH,
      chapter: CHAPTER,
      confirm: true,
    });

    expect(result.status).toBe(202);
    const job = asRecord(asRecord(result.json)["job"]);
    expect(typeof job["id"]).toBe("string");
    expect(job["status"]).toBe("queued");
    expect(harness.writes).toContain(`${AUDIOBOOK_JOB_ROOT}/${String(job["id"])}.json`);
    expect(harness.runCalls.map((call) => call.jobId)).toEqual([job["id"]]);
  });
});

describe("GET /oh-story/audiobook/jobs/:id", () => {
  it("返回任务；任务缺失返回 404", async () => {
    const harness = fixture({ seed: { [`${AUDIOBOOK_JOB_ROOT}/${JOB_ID}.json`]: jobDocument(JOB_ID, "queued") } });

    const found = await callRoute(harness, "GET", `/oh-story/audiobook/jobs/${JOB_ID}`);
    expect(found.status).toBe(200);
    expect(asRecord(asRecord(found.json)["job"])["id"]).toBe(JOB_ID);

    const missing = await callRoute(harness, "GET", "/oh-story/audiobook/jobs/missing-1");
    expect(missing.status).toBe(404);
    expect(harness.writes).toHaveLength(0);
  });
});

describe("POST /oh-story/audiobook/jobs/:id/cancel", () => {
  it("取消后返回当前任务", async () => {
    const harness = fixture({ seed: { [`${AUDIOBOOK_JOB_ROOT}/${JOB_ID}.json`]: jobDocument(JOB_ID, "queued") } });
    const result = await callRoute(harness, "POST", `/oh-story/audiobook/jobs/${JOB_ID}/cancel`);

    expect(result.status).toBe(200);
    expect(asRecord(asRecord(result.json)["job"])["id"]).toBe(JOB_ID);
    expect(harness.writes).toHaveLength(0);
  });
});

describe("POST /oh-story/audiobook/jobs/:id/run", () => {
  it("暂停任务未确认返回 400 且不执行", async () => {
    const harness = fixture({ seed: { [`${AUDIOBOOK_JOB_ROOT}/${JOB_ID}.json`]: jobDocument(JOB_ID, "paused") } });
    const result = await callRoute(harness, "POST", `/oh-story/audiobook/jobs/${JOB_ID}/run`, {});

    expect(result.status).toBe(400);
    expect(harness.runCalls).toHaveLength(0);
    expect(harness.writes).toHaveLength(0);
  });

  it("暂停任务确认后返回 202 并交给 runJob", async () => {
    const harness = fixture({ seed: { [`${AUDIOBOOK_JOB_ROOT}/${JOB_ID}.json`]: jobDocument(JOB_ID, "paused") } });
    const result = await callRoute(harness, "POST", `/oh-story/audiobook/jobs/${JOB_ID}/run`, { confirm: true });

    expect(result.status).toBe(202);
    expect(asRecord(asRecord(result.json)["job"])["status"]).toBe("paused");
    expect(harness.runCalls.map((call) => call.jobId)).toEqual([JOB_ID]);
  });

  it("非暂停/失败任务返回 409", async () => {
    const harness = fixture({ seed: { [`${AUDIOBOOK_JOB_ROOT}/${JOB_ID}.json`]: jobDocument(JOB_ID, "completed") } });
    const result = await callRoute(harness, "POST", `/oh-story/audiobook/jobs/${JOB_ID}/run`, { confirm: true });

    expect(result.status).toBe(409);
    expect(harness.runCalls).toHaveLength(0);
  });
});

describe("POST /oh-story/audiobook/export", () => {
  it("未确认返回 400 且不调用 ffmpeg", async () => {
    const harness = fixture();
    const result = await callRoute(harness, "POST", "/oh-story/audiobook/export", {
      path: PROJECT_PATH,
      chapter: CHAPTER,
    });

    expect(result.status).toBe(400);
    expect(harness.runner.calls).toEqual([]);
    expect(harness.writes).toHaveLength(0);
  });

  it("缺少 ffmpeg 时返回 503", async () => {
    const harness = fixture({
      run: () => ({ code: 1, stdout: "", stderr: "not found" }),
    });
    const result = await callRoute(harness, "POST", "/oh-story/audiobook/export", {
      path: PROJECT_PATH,
      chapter: CHAPTER,
      confirm: true,
    });

    expect(result.status).toBe(503);
    expect(String(asRecord(result.json)["error"])).toContain("ffmpeg");
    expect(harness.writes).toHaveLength(0);
  });

  it("预检通过后导出整章 MP3 并复用章节音频布局", async () => {
    const binary = memoryBinaryFileStore();
    for (const segment of SCRIPT.segments) {
      binary.files.set(segmentAudioPath(cacheKeyFor(segment.text), "mp3"), new Uint8Array([1, 2, 3]));
    }
    const harness = fixture({
      binary,
      run: (command, args) => {
        if (command === "ffmpeg") {
          const output = args.at(-1);
          if (output !== undefined) binary.files.set(output, new Uint8Array([0x49, 0x44, 0x33]));
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "12.5\n", stderr: "" };
      },
    });

    const result = await callRoute(harness, "POST", "/oh-story/audiobook/export", {
      path: PROJECT_PATH,
      chapter: CHAPTER,
      confirm: true,
    });

    expect(result.status).toBe(200);
    expect(result.json).toEqual({ path: AUDIO_PATH, bytes: 3, durationMs: 12_500 });
    expect(chapterAudioPathFor(PROJECT_PATH, CHAPTER)).toBe(AUDIO_PATH);
    expect(binary.files.has(AUDIO_PATH)).toBe(true);
  });
});

describe("GET /oh-story/audiobook/segment-audio", () => {
  it("拒绝离开缓存目录的路径", async () => {
    const harness = fixture();
    const result = await callRoute(
      harness,
      "GET",
      "/oh-story/audiobook/segment-audio?path=../../package.json",
    );

    expect(result.handled).toBe(true);
    expect(result.status).toBe(403);
    expect(harness.writes).toHaveLength(0);
  });

  it("返回缓存音频字节与禁止缓存的响应头", async () => {
    const audioPath = segmentAudioPath(cacheKeyFor("你好。"), "mp3");
    const binary = memoryBinaryFileStore();
    binary.files.set(audioPath, new Uint8Array([1, 2, 3]));
    const harness = fixture({ binary });

    const result = await callRoute(
      harness,
      "GET",
      `/oh-story/audiobook/segment-audio?path=${encodeURIComponent(audioPath)}`,
    );

    expect(result.status).toBe(200);
    expect(result.headers["content-type"]).toBe("audio/mpeg");
    expect(result.headers["content-length"]).toBe(3);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.headers["x-content-type-options"]).toBe("nosniff");
    expect([...result.bytes]).toEqual([1, 2, 3]);
    expect(harness.writes).toHaveLength(0);
  });

  it("缓存音频缺失返回 404", async () => {
    const harness = fixture();
    const missing = segmentAudioPath("a".repeat(64), "mp3");
    const result = await callRoute(
      harness,
      "GET",
      `/oh-story/audiobook/segment-audio?path=${encodeURIComponent(missing)}`,
    );
    expect(result.status).toBe(404);
  });
});

describe("只读 GET 路由", () => {
  it("概览、项目、任务与音频读取全程零写入", async () => {
    const audioPath = segmentAudioPath(cacheKeyFor("你好。"), "mp3");
    const binary = memoryBinaryFileStore();
    binary.files.set(audioPath, new Uint8Array([1, 2, 3]));
    const harness = fixture({
      binary,
      seed: {
        [`${AUDIOBOOK_JOB_ROOT}/${JOB_ID}.json`]: jobDocument(JOB_ID, "completed"),
        [AUDIO_PATH]: "ID3",
      },
    });

    expect((await callRoute(harness, "GET", "/oh-story/audiobook")).status).toBe(200);
    expect((await callRoute(
      harness,
      "GET",
      `/oh-story/audiobook/project?path=${encodeURIComponent(PROJECT_PATH)}`,
    )).status).toBe(200);
    expect((await callRoute(harness, "GET", `/oh-story/audiobook/jobs/${JOB_ID}`)).status).toBe(200);
    expect((await callRoute(
      harness,
      "GET",
      `/oh-story/audiobook/segment-audio?path=${encodeURIComponent(audioPath)}`,
    )).status).toBe(200);
    expect(harness.writes).toHaveLength(0);
  });
});

describe("未知路由", () => {
  it("路径或方法不匹配时交回后续扩展", async () => {
    const harness = fixture();
    expect((await callRoute(harness, "GET", "/oh-story/audiobook/unknown")).handled).toBe(false);
    expect((await callRoute(harness, "GET", "/oh-story/audiobook/export")).handled).toBe(false);
    expect(harness.writes).toHaveLength(0);
  });
});
