import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  memoryBinaryFileStore,
  type MemoryBinaryFileStore,
} from "../src/services/audiobook-binary.js";
import { segmentAudioPath, ttsCacheKey } from "../src/services/audiobook-cache.js";
import {
  type AudiobookAssetProviderReceipt,
  type AudiobookCue,
  type AudiobookExportFormats,
  type AudiobookManifest,
  type AudiobookProject,
  type AudiobookProjectRecord,
  type AudiobookScript,
} from "../src/services/audiobook-contract.js";
import {
  exportAudiobook,
  preflightAudiobookExport,
  type AudiobookExportRuntime,
  type CommandRunner,
} from "../src/services/audiobook-export.js";
import { manifestChecksum } from "../src/services/audiobook-package.js";
import { CHAPTERS, memoryRealm, SANDBOX_POLICY, type MemoryRealm } from "./audiobook-fixtures.js";

/**
 * 完整导出编排测试：内存工作区 + 内存二进制存储 + 假 ffmpeg/ffprobe。
 *
 * 假执行器按参数形状模拟四类真实命令：能力探测（`-version`）、ffprobe 时长、
 * loudnorm 测量（`-f null -`，JSON 走 stderr）与所有写文件的 ffmpeg 命令（把
 * 固定字节写到最后一个参数）。预检必须零写入，真正的导出只有全部章节/M4B/
 * 字幕成功后才改名到最终路径，清单最后写。
 */

const PROJECT_PATH = "有声剧/长夜行/project.json";
const BOOK_DIRECTORY = "有声剧/长夜行";
const CHAPTER = "第0001章_开篇";
const SOURCE_PATH = "正文/第0001章_开篇.md";
const SCRIPT_PATH = `${BOOK_DIRECTORY}/脚本/${CHAPTER}.json`;
const MUSIC_ASSET = `${BOOK_DIRECTORY}/素材/音乐/theme.mp3`;
const EFFECT_ASSET = `${BOOK_DIRECTORY}/素材/音效/rain.wav`;
const AUTHORIZATION_PATH = `${BOOK_DIRECTORY}/素材/授权.json`;
const COVER_PATH = `${BOOK_DIRECTORY}/封面/cover.jpg`;
const AUDIO_FINAL = `${BOOK_DIRECTORY}/音频/${CHAPTER}.mp3`;
const M4B_FINAL = `${BOOK_DIRECTORY}/音频/全书.m4b`;
const SUBTITLE_SRT = `${BOOK_DIRECTORY}/字幕/${CHAPTER}.srt`;
const SUBTITLE_LRC = `${BOOK_DIRECTORY}/字幕/${CHAPTER}.lrc`;
const RELEASE_DIRECTORY = `${BOOK_DIRECTORY}/发布`;
const MANIFEST_PATH = `${RELEASE_DIRECTORY}/发布清单.json`;
const STAGING_PREFIX = ".oh-story/audiobook/tmp/";
const NOW = 1_760_000_000_000;
/** 假 ffprobe 对每个文件都报 12.5 秒；两段之间固定 120ms 停顿。 */
const SEGMENT_MS = 12_500;
const CHAPTER_END_MS = SEGMENT_MS * 2 + 120;

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
  source: { bookRoot: "正文", chapters: [SOURCE_PATH] },
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
  sourceSha256: createHash("sha256").update(CHAPTERS[SOURCE_PATH] ?? "", "utf8").digest("hex"),
  segments: [
    { id: "s-1", kind: "narration", speakerId: "narrator", text: "你好。", sourceStart: 0, sourceEnd: 3 },
    { id: "s-2", kind: "narration", speakerId: "narrator", text: "世界。", sourceStart: 3, sourceEnd: 6 },
  ],
};

/** 解析成功但没有任何片段的脚本：时间轴为空，不能当成可导出。 */
const EMPTY_SCRIPT: AudiobookScript = { ...SCRIPT, segments: [] };

/** 项目里没有任何章节：未显式选章时选中集为空，同样不能报告就绪。 */
const EMPTY_PROJECT: AudiobookProject = { ...PROJECT, source: { bookRoot: "正文", chapters: [] } };

const MUSIC_CUE: AudiobookCue = {
  id: "cue-music",
  chapter: CHAPTER,
  asset: MUSIC_ASSET,
  startSegment: "s-1",
  offsetMs: 0,
  fadeInMs: 0,
  fadeOutMs: 0,
  gainDb: -6,
  duckDb: -12,
};

const EFFECT_CUE: AudiobookCue = {
  ...MUSIC_CUE,
  id: "cue-effect",
  asset: EFFECT_ASSET,
  startSegment: "s-2",
  gainDb: -3,
  duckDb: -6,
};

const MUSIC_PROJECT: AudiobookProject = { ...PROJECT, cues: [MUSIC_CUE] };
const EFFECT_PROJECT: AudiobookProject = { ...PROJECT, cues: [EFFECT_CUE] };

const PROVIDER_RECEIPT: AudiobookAssetProviderReceipt = {
  id: "comfyui",
  model: "test-model",
  promptSha256: "b".repeat(64),
  receiptId: "receipt-1",
  generatedAt: NOW,
};

const FULL_FORMATS: AudiobookExportFormats = {
  mp3: true,
  m4b: true,
  subtitles: ["srt", "lrc"],
  package: true,
};

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

function authorizationDocument(project: AudiobookProject): Record<string, unknown> {
  return {
    schemaVersion: 1,
    assets: project.cues.map((cue) => ({
      path: cue.asset,
      source: "测试",
      license: "CC-BY-4.0",
      allowedUse: ["audiobook"],
      attribution: cue.asset === MUSIC_ASSET ? "作曲" : "音效作者",
      ...(cue.asset === MUSIC_ASSET ? { provider: PROVIDER_RECEIPT } : {}),
    })),
  };
}

interface FixtureOptions {
  readonly project?: AudiobookProject;
  readonly script?: AudiobookScript;
  readonly authorized?: boolean;
  readonly cover?: boolean;
  readonly cache?: boolean;
  readonly missingSegments?: readonly string[];
  readonly ffmpeg?: boolean;
  /** 预置的旧发布清单（模拟上一次成功发布的提交标记）。 */
  readonly manifest?: string;
}

interface Fixture {
  readonly state: MemoryRealm;
  readonly binary: MemoryBinaryFileStore;
  readonly calls: string[][];
  readonly record: AudiobookProjectRecord;
  readonly runtime: AudiobookExportRuntime;
}

/** 假执行器：`-version` 探测、ffprobe 时长、loudnorm 测量 JSON、其余写输出字节。 */
function fakeRunner(
  binary: MemoryBinaryFileStore,
  calls: string[][],
  options: FixtureOptions,
): CommandRunner {
  const ffmpegReady = options.ffmpeg ?? true;
  return {
    run: async (command, args) => {
      calls.push([command, ...args]);
      if (args.length === 1 && args[0] === "-version") {
        return ffmpegReady
          ? { code: 0, stdout: `${command} version test\n`, stderr: "" }
          : { code: 1, stdout: "", stderr: "not found" };
      }
      if (command === "ffprobe") return { code: 0, stdout: "12.5\n", stderr: "" };
      if (command === "ffmpeg") {
        if (args.includes("null") && args.at(-1) === "-") {
          return {
            code: 0,
            stdout: "",
            stderr: JSON.stringify({
              input_i: "-23.0",
              input_tp: "-2.1",
              input_lra: "6.8",
              input_thresh: "-33.2",
              target_offset: "0.1",
            }),
          };
        }
        const output = args.at(-1);
        if (output !== undefined) binary.files.set(output, new Uint8Array([0x49, 0x44, 0x33, 0x04]));
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
}

function fixture(options: FixtureOptions = {}): Fixture {
  const project = options.project ?? MUSIC_PROJECT;
  const seed: Record<string, string> = {
    ...CHAPTERS,
    [PROJECT_PATH]: JSON.stringify(project),
    [SCRIPT_PATH]: JSON.stringify(options.script ?? SCRIPT),
  };
  if (options.manifest !== undefined) seed[MANIFEST_PATH] = options.manifest;
  for (const asset of project.cues.map((cue) => cue.asset)) seed[asset] = "ID3";
  if (options.authorized ?? true) seed[AUTHORIZATION_PATH] = JSON.stringify(authorizationDocument(project));
  if (options.cover ?? true) seed[COVER_PATH] = "JPEG";

  const state = memoryRealm(seed);
  const binary = memoryBinaryFileStore();
  for (const asset of project.cues.map((cue) => cue.asset)) {
    binary.files.set(asset, new Uint8Array([0x49, 0x44, 0x33]));
  }
  if (options.cover ?? true) binary.files.set(COVER_PATH, new Uint8Array([0xff, 0xd8, 0xff]));

  if (options.cache ?? true) {
    for (const segment of SCRIPT.segments) {
      if (options.missingSegments?.includes(segment.id) === true) continue;
      binary.files.set(segmentAudioPath(cacheKeyFor(segment.text), "mp3"), new Uint8Array([1, 2, 3]));
    }
  }

  const calls: string[][] = [];
  return {
    state,
    binary,
    calls,
    record: { project, path: PROJECT_PATH, version: "v1" },
    runtime: { binary, runner: fakeRunner(binary, calls, options) },
  };
}

function stagingFiles(binary: MemoryBinaryFileStore): string[] {
  return [...binary.files.keys()].filter((path) => path.startsWith(STAGING_PREFIX));
}

function finalOutputs(binary: MemoryBinaryFileStore): string[] {
  return [...binary.files.keys()].filter((path) => path.startsWith(`${BOOK_DIRECTORY}/音频/`)
    || path.startsWith(`${BOOK_DIRECTORY}/字幕/`)
    || path.startsWith(`${RELEASE_DIRECTORY}/`));
}

describe("preflightAudiobookExport", () => {
  it("预检零写入：未授权素材与缺封面进入 issues 且 ready=false", async () => {
    const harness = fixture({ authorized: false, cover: false });
    const beforeBinary = [...harness.binary.files.keys()];

    const preflight = await preflightAudiobookExport(
      harness.state.realm,
      harness.record,
      harness.runtime,
      FULL_FORMATS,
      [CHAPTER],
    );

    expect(preflight.ready).toBe(false);
    expect(preflight.chapters).toBe(1);
    expect(preflight.cost).toEqual({ chars: 6, requests: 0, estimatedCost: 0 });
    const issues = JSON.stringify(preflight.issues);
    expect(issues).toContain("未授权");
    expect(issues).toContain("封面");
    expect(harness.state.writes).toHaveLength(0);
    expect([...harness.binary.files.keys()]).toEqual(beforeBinary);
    // 只跑 ffmpeg/ffprobe 的 -version 探测，没有混音或时长探测。
    expect(harness.calls.every((call) => call.at(-1) === "-version")).toBe(true);
  });

  it("授权、封面与缓存齐备时 ready=true 且零写入", async () => {
    const harness = fixture();
    const beforeBinary = [...harness.binary.files.keys()];

    const preflight = await preflightAudiobookExport(
      harness.state.realm,
      harness.record,
      harness.runtime,
      FULL_FORMATS,
      [CHAPTER],
    );

    expect(preflight).toEqual({
      ready: true,
      issues: [],
      chapters: 1,
      cost: { chars: 6, requests: 0, estimatedCost: 0 },
    });
    expect(harness.state.writes).toHaveLength(0);
    expect([...harness.binary.files.keys()]).toEqual(beforeBinary);
    expect(stagingFiles(harness.binary)).toEqual([]);
  });

  it("缺 ffmpeg 时预检列出 ffmpeg-missing，实际导出返回 503", async () => {
    const harness = fixture({ ffmpeg: false });

    const preflight = await preflightAudiobookExport(
      harness.state.realm,
      harness.record,
      harness.runtime,
      FULL_FORMATS,
      [CHAPTER],
    );
    expect(preflight.ready).toBe(false);
    expect(preflight.issues.map((issue) => issue.code)).toEqual(["ffmpeg-missing"]);

    await expect(exportAudiobook(
      harness.state.realm,
      harness.record,
      harness.runtime,
      FULL_FORMATS,
      [CHAPTER],
    )).rejects.toMatchObject({ status: 503 });
    expect(finalOutputs(harness.binary)).toEqual([]);
    expect(stagingFiles(harness.binary)).toEqual([]);
  });

  it("请求不存在的章节时列出 chapter-missing", async () => {
    const harness = fixture();

    const preflight = await preflightAudiobookExport(
      harness.state.realm,
      harness.record,
      harness.runtime,
      FULL_FORMATS,
      ["第9999章_不存在"],
    );

    expect(preflight.ready).toBe(false);
    expect(preflight.chapters).toBe(0);
    expect(preflight.issues.map((issue) => issue.code)).toEqual(["chapter-missing"]);
  });

  it("空脚本报告 script-empty，不计成本也不查缓存", async () => {
    const harness = fixture({ script: EMPTY_SCRIPT, cache: false });

    const preflight = await preflightAudiobookExport(
      harness.state.realm,
      harness.record,
      harness.runtime,
      { mp3: false, m4b: false, subtitles: ["srt"], package: false },
      [CHAPTER],
    );

    expect(preflight.ready).toBe(false);
    expect(preflight.chapters).toBe(1);
    expect(preflight.issues.map((issue) => issue.code)).toEqual(["script-empty"]);
    expect(preflight.cost).toEqual({ chars: 0, requests: 0, estimatedCost: 0 });
    expect(harness.state.writes).toHaveLength(0);
  });

  it("项目没有任何章节时报告 no-chapters 而不是就绪", async () => {
    const harness = fixture({ project: EMPTY_PROJECT });

    const preflight = await preflightAudiobookExport(
      harness.state.realm,
      harness.record,
      harness.runtime,
      { mp3: false, m4b: false, subtitles: ["srt"], package: false },
    );

    expect(preflight.ready).toBe(false);
    expect(preflight.chapters).toBe(0);
    expect(preflight.issues.map((issue) => issue.code)).toEqual(["no-chapters"]);
    expect(harness.state.writes).toHaveLength(0);
  });
});

describe("exportAudiobook", () => {
  it("缺缓存片段时返回 409，且不写最终文件、不留暂存", async () => {
    const harness = fixture({ missingSegments: ["s-2"] });

    await expect(exportAudiobook(
      harness.state.realm,
      harness.record,
      harness.runtime,
      FULL_FORMATS,
      [CHAPTER],
    )).rejects.toMatchObject({ status: 409, message: expect.stringContaining("还没有完整生成") });

    expect(finalOutputs(harness.binary)).toEqual([]);
    expect(stagingFiles(harness.binary)).toEqual([]);
    expect(harness.calls.some((call) => call.includes("-filter_complex"))).toBe(false);
  });

  it("完整导出产出 MP3/字幕/M4B/发布包，清单最后写且 checksum 可复算", async () => {
    const harness = fixture();

    const result = await exportAudiobook(
      harness.state.realm,
      harness.record,
      harness.runtime,
      FULL_FORMATS,
      [CHAPTER],
    );

    expect(result.manifestPath).toBe(MANIFEST_PATH);
    const paths = result.files.map((file) => file.path);
    expect(paths).toHaveLength(9);
    for (const path of [
      AUDIO_FINAL,
      SUBTITLE_SRT,
      SUBTITLE_LRC,
      M4B_FINAL,
      `${RELEASE_DIRECTORY}/${CHAPTER}.mp3`,
      `${RELEASE_DIRECTORY}/${CHAPTER}.srt`,
      `${RELEASE_DIRECTORY}/${CHAPTER}.lrc`,
      `${RELEASE_DIRECTORY}/全书.m4b`,
      `${RELEASE_DIRECTORY}/cover.jpg`,
    ]) {
      expect(paths).toContain(path);
      expect(harness.binary.files.has(path)).toBe(true);
    }
    for (const file of result.files) expect(file.bytes).toBeGreaterThan(0);

    // 清单是最后一个写入的工作区文本文件（之前只有时长缓存文档）。
    expect(harness.state.writes.at(-1)).toBe(MANIFEST_PATH);
    const manifest = JSON.parse(harness.state.read(MANIFEST_PATH) ?? "{}") as AudiobookManifest;
    const manifestPaths = manifest.files.map((file) => file.path);
    expect(new Set(manifestPaths)).toEqual(new Set([
      `发布/${CHAPTER}.mp3`,
      `发布/${CHAPTER}.srt`,
      `发布/${CHAPTER}.lrc`,
      "发布/全书.m4b",
      "发布/cover.jpg",
    ]));
    expect(manifestPaths).toEqual(
      [...manifestPaths].sort((left, right) => left.localeCompare(right, "zh-Hans-CN")),
    );
    expect(manifest.files.some((file) => file.path.includes("发布清单"))).toBe(false);
    for (const file of manifest.files) {
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(file.bytes).toBeGreaterThan(0);
    }
    expect(manifest.checksum).toBe(manifestChecksum(manifest.files));
    expect(manifest.chapters).toEqual([{
      index: 1,
      title: CHAPTER,
      audio: `发布/${CHAPTER}.mp3`,
      subtitles: [`发布/${CHAPTER}.srt`, `发布/${CHAPTER}.lrc`],
    }]);
    expect(manifest.licenses).toEqual([{ path: MUSIC_ASSET, license: "CC-BY-4.0", attribution: "作曲" }]);
    expect(manifest.providerReceipts).toEqual([PROVIDER_RECEIPT]);
    expect(manifest.cost).toEqual({ chars: 6, requests: 0, estimatedCost: 0 });
    expect(manifest.files.find((file) => file.path === `发布/${CHAPTER}.mp3`)?.durationMs).toBe(CHAPTER_END_MS);
    expect(manifest.files.find((file) => file.path === "发布/全书.m4b")?.durationMs).toBe(CHAPTER_END_MS);
    expect(manifest.files.find((file) => file.path === "发布/cover.jpg")?.durationMs).toBeNull();
    expect(manifest.files.find((file) => file.path === `发布/${CHAPTER}.srt`)?.durationMs).toBeNull();

    for (const prefix of [AUDIO_FINAL, SUBTITLE_SRT, SUBTITLE_LRC, M4B_FINAL]) {
      const size = harness.binary.files.get(prefix)?.byteLength ?? 0;
      expect(result.files.find((file) => file.path === prefix)?.bytes).toBe(size);
    }
    expect(stagingFiles(harness.binary)).toEqual([]);

    const mixCall = harness.calls.find((call) => call.includes("-filter_complex"));
    expect(mixCall).toBeDefined();
    expect(mixCall).toContain("-stream_loop");
    expect(harness.calls.some((call) => call.join(" ").includes("loudnorm"))).toBe(true);
    expect(harness.calls.some((call) => call.includes("libmp3lame"))).toBe(true);
    expect(harness.calls.some((call) => call.includes("ffmetadata"))).toBe(true);
  });

  it("音效 cue 按素材实测窗口截断，不循环素材", async () => {
    const harness = fixture({ project: EFFECT_PROJECT });

    const result = await exportAudiobook(
      harness.state.realm,
      harness.record,
      harness.runtime,
      { mp3: true, m4b: false, subtitles: [], package: false },
      [CHAPTER],
    );

    expect(result.manifestPath).toBeUndefined();
    expect(harness.calls.some((call) => call[0] === "ffprobe" && call.at(-1) === EFFECT_ASSET)).toBe(true);
    const mixCall = harness.calls.find((call) => call.includes("-filter_complex"));
    expect(mixCall).toBeDefined();
    expect(mixCall).not.toContain("-stream_loop");
    expect(mixCall?.join(" ")).toContain("atrim=0:12.5");
    expect(harness.binary.files.has(AUDIO_FINAL)).toBe(true);
    expect(harness.binary.files.has(M4B_FINAL)).toBe(false);
    expect(harness.binary.files.has(SUBTITLE_SRT)).toBe(false);
    expect(finalOutputs(harness.binary).some((path) => path.startsWith(RELEASE_DIRECTORY))).toBe(false);
  });

  it("只请求 M4B 时章节 MP3 不提升为成品，M4B 与发布包仍完整", async () => {
    const harness = fixture();

    const result = await exportAudiobook(
      harness.state.realm,
      harness.record,
      harness.runtime,
      { mp3: false, m4b: true, subtitles: [], package: false },
      [CHAPTER],
    );

    expect(result.manifestPath).toBeUndefined();
    expect(harness.binary.files.has(AUDIO_FINAL)).toBe(false);
    expect(harness.binary.files.has(SUBTITLE_SRT)).toBe(false);
    expect(harness.binary.files.has(M4B_FINAL)).toBe(true);
    expect(result.files.map((file) => file.path)).toEqual([M4B_FINAL]);
    expect(stagingFiles(harness.binary)).toEqual([]);
  });

  it("空脚本只导出字幕时导出返回 409，零写入", async () => {
    const harness = fixture({ script: EMPTY_SCRIPT, cache: false });
    const before = [...harness.binary.files.keys()];

    await expect(exportAudiobook(
      harness.state.realm,
      harness.record,
      harness.runtime,
      { mp3: false, m4b: false, subtitles: ["srt"], package: false },
      [CHAPTER],
    )).rejects.toMatchObject({ status: 409, message: expect.stringContaining("没有可导出的片段") });

    expect(harness.state.writes).toHaveLength(0);
    expect([...harness.binary.files.keys()]).toEqual(before);
    expect(stagingFiles(harness.binary)).toEqual([]);
  });

  it("重新导出中途失败时旧清单失效，已复制的发布文件被清理", async () => {
    const oldManifest = JSON.stringify({ schemaVersion: 1, files: [] });
    const harness = fixture({ manifest: oldManifest });
    // 封面是最后一个复制项：复制失败前 MP3/SRT/LRC/M4B 都已落进发布目录，必须回滚。
    const originalCopy = harness.binary.copy;
    harness.binary.copy = (from, to) => {
      if (to.displayPath === `${RELEASE_DIRECTORY}/cover.jpg`) return Promise.reject(new Error("磁盘写入失败。"));
      return originalCopy(from, to);
    };

    await expect(exportAudiobook(
      harness.state.realm,
      harness.record,
      harness.runtime,
      FULL_FORMATS,
      [CHAPTER],
    )).rejects.toThrow("磁盘写入失败");

    // 旧清单在第一次复制前就被清空成空串：读方不能再把它当成完整发布包的提交标记。
    const manifest = harness.state.read(MANIFEST_PATH);
    expect(manifest).toBe("");
    expect(() => JSON.parse(manifest ?? "")).toThrow(SyntaxError);
    const invalidation = harness.state.writeCalls.find((call) => call.path === MANIFEST_PATH);
    expect(invalidation?.content).toBe("");
    expect(invalidation?.sandboxPolicy).toBe(SANDBOX_POLICY);

    // 本次复制出的包内文件已尽力删除；提升到最终路径的成品按既有约定保留。
    expect(harness.binary.files.has(`${RELEASE_DIRECTORY}/${CHAPTER}.mp3`)).toBe(false);
    expect(harness.binary.files.has(`${RELEASE_DIRECTORY}/${CHAPTER}.srt`)).toBe(false);
    expect(harness.binary.files.has(`${RELEASE_DIRECTORY}/${CHAPTER}.lrc`)).toBe(false);
    expect(harness.binary.files.has(`${RELEASE_DIRECTORY}/全书.m4b`)).toBe(false);
    expect(harness.binary.files.has(AUDIO_FINAL)).toBe(true);
    expect(stagingFiles(harness.binary)).toEqual([]);
  });
});
