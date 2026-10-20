import { createHash } from "node:crypto";
import type { FsTarget } from "@deepseek-ai/dsh-fs";
import { describe, expect, it } from "vitest";
import { WorkspaceHttpError } from "../src/workspace-route.js";
import { memoryBinaryFileStore } from "../src/services/audiobook-binary.js";
import {
  planChapterCost,
  readCachedSegment,
  segmentAudioPath,
  segmentMetaPath,
  ttsCacheKey,
  writeCachedSegment,
} from "../src/services/audiobook-cache.js";
import type { AudiobookProject, AudiobookScript } from "../src/services/audiobook-contract.js";
import { memoryRealm } from "./audiobook-fixtures.js";

const PROJECT: AudiobookProject = {
  schemaVersion: 1,
  source: { bookRoot: "正文", chapters: ["正文/第0001章_开篇.md"] },
  tts: {
    baseUrl: "https://api.example.com/v1",
    model: "tts-1",
    responseFormat: "mp3",
    speed: 1,
    pricePerMillionChars: 15,
    maxCharsPerChapter: 20_000,
    concurrency: 2,
  },
  cast: [{ id: "narrator", name: "旁白", kind: "narrator", voice: "alloy" }],
  cues: [],
  export: { mp3BitrateKbps: 192, sampleRate: 44_100, channels: 2, loudnessLufs: -16, truePeakDbtp: -1.5, subtitles: [] },
  rights: { voiceCloning: false },
};

const SCRIPT: AudiobookScript = {
  schemaVersion: 1,
  chapter: "第0001章_开篇",
  sourcePath: "正文/第0001章_开篇.md",
  sourceSha256: "0".repeat(64),
  segments: [
    { id: "s-1", text: "你好。", kind: "narration", speakerId: "narrator", sourceStart: 0, sourceEnd: 3 },
    { id: "s-2", text: "世界。", kind: "narration", speakerId: "narrator", sourceStart: 3, sourceEnd: 6 },
  ],
};

const sha256 = (content: string): string => createHash("sha256").update(content, "utf8").digest("hex");

describe("audiobook cache", () => {
  it("缓存键随 voice 变化，不包含密钥或本机路径", () => {
    const base = { baseUrl: "https://api.example.com/v1/", model: "tts-1", voice: "alloy", speed: 1, responseFormat: "mp3" as const, text: "你好。" };
    const a = ttsCacheKey(base);
    const b = ttsCacheKey({ ...base, voice: "verse" });
    expect(a).toMatch(/^[0-9a-f]{64}$/u);
    expect(a).not.toBe(b);
    expect(a).not.toContain("api.example.com");
    expect(ttsCacheKey({ ...base, baseUrl: "https://api.example.com/v1" })).toBe(a);
  });

  it("写入后读回字节，meta 不含密钥", async () => {
    const binary = memoryBinaryFileStore();
    const { realm } = memoryRealm();
    const key = ttsCacheKey({ baseUrl: "https://api.example.com/v1", model: "tts-1", voice: "alloy", speed: 1, responseFormat: "mp3", text: "你好。" });
    await writeCachedSegment(realm, binary, key, "mp3", new Uint8Array([1, 2, 3]), { model: "tts-1", voice: "alloy", bytes: 3 });
    expect(Array.from(await readCachedSegment(realm, binary, key, "mp3") ?? [])).toEqual([1, 2, 3]);
    expect(binary.files.get(segmentAudioPath(key, "mp3"))?.length).toBe(3);
  });

  it("成本只计算缓存未命中的字符", () => {
    const estimate = planChapterCost(PROJECT, SCRIPT, new Set());
    expect(estimate).toMatchObject({ segments: 2, chars: 6, cacheHits: 0, requests: 2 });
    expect(estimate.estimatedCost).toBeCloseTo(6 / 1_000_000 * 15);
    expect(planChapterCost(PROJECT, SCRIPT, new Set([ttsCacheKey({
      baseUrl: "https://api.example.com/v1", model: "tts-1", voice: "alloy", speed: 1, responseFormat: "mp3", text: "你好。",
    })])).cacheHits).toBe(1);
  });

  it("meta.bytes 与音频实测长度不一致时拒绝写入", async () => {
    const binary = memoryBinaryFileStore();
    const { realm, writes } = memoryRealm();
    const key = ttsCacheKey({ baseUrl: "https://api.example.com/v1", model: "tts-1", voice: "alloy", speed: 1, responseFormat: "mp3", text: "你好。" });

    await expect(writeCachedSegment(realm, binary, key, "mp3", new Uint8Array([1, 2, 3]), { model: "tts-1", voice: "alloy", bytes: 4 }))
      .rejects.toMatchObject({ status: 422 });

    expect(binary.files.size).toBe(0);
    expect(writes).toHaveLength(0);
  });

  it("meta 字段齐全、不含 API 密钥与正文全文", async () => {
    const binary = memoryBinaryFileStore();
    const { realm, read } = memoryRealm();
    const text = "绝密正文内容。";
    const key = ttsCacheKey({ baseUrl: "https://api.example.com/v1", model: "tts-1", voice: "alloy", speed: 1, responseFormat: "mp3", text });
    const meta = {
      model: "tts-1",
      voice: "alloy",
      responseFormat: "mp3" as const,
      speed: 1,
      text,
      createdAt: 1_760_000_000_000,
      apiKey: "sk-test-secret",
    };

    await writeCachedSegment(realm, binary, key, "mp3", new Uint8Array([1, 2, 3, 4]), meta);

    const document = read(segmentMetaPath(key)) ?? "";
    const parsed: unknown = JSON.parse(document);
    expect(parsed).toEqual({
      schemaVersion: 1,
      model: "tts-1",
      voice: "alloy",
      responseFormat: "mp3",
      speed: 1,
      bytes: 4,
      chars: text.length,
      textSha256: sha256(text),
      createdAt: 1_760_000_000_000,
    });
    expect(document).not.toContain("sk-test-secret");
    expect(document).not.toContain(text);
  });
});

describe("audiobook cache 路径安全", () => {
  it("内存二进制存储按展示路径读写、改名与删除", async () => {
    const binary = memoryBinaryFileStore();
    const from = { targetKey: "a", displayPath: ".oh-story/audiobook/cache/from.bin" } as FsTarget;
    const to = { targetKey: "b", displayPath: ".oh-story/audiobook/cache/to.bin" } as FsTarget;

    await binary.prepare(from);
    await binary.write(from, new Uint8Array([1, 2]));
    expect(binary.processPath(from)).toBe(from.displayPath);
    expect(await binary.stat(from)).toEqual({ size: 2 });
    expect(await binary.stat(to)).toBeUndefined();
    expect(await binary.read(from, 1)).toBeUndefined();

    await binary.rename(from, to);
    expect(await binary.read(to, 10)).toEqual(new Uint8Array([1, 2]));
    expect(await binary.read(from, 10)).toBeUndefined();
    await expect(binary.rename(from, to)).rejects.toThrow(/不存在/u);

    await binary.remove(to);
    expect(await binary.stat(to)).toBeUndefined();
    expect(binary.files.size).toBe(0);
  });

  it("非法缓存键与越级键在触碰文件系统前返回 403", async () => {
    const binary = memoryBinaryFileStore();
    const { realm, writes } = memoryRealm();
    const meta = { model: "tts-1", voice: "alloy" };

    await expect(readCachedSegment(realm, binary, "../escape", "mp3")).rejects.toMatchObject({ status: 403 });
    await expect(readCachedSegment(realm, binary, "A".repeat(64), "mp3")).rejects.toMatchObject({ status: 403 });
    await expect(writeCachedSegment(realm, binary, "../escape", "mp3", new Uint8Array([1]), meta))
      .rejects.toMatchObject({ status: 403 });

    expect(binary.files.size).toBe(0);
    expect(writes).toHaveLength(0);
  });

  it("合法键未命中返回 undefined", async () => {
    const binary = memoryBinaryFileStore();
    const { realm } = memoryRealm();
    const key = ttsCacheKey({ baseUrl: "https://api.example.com/v1", model: "tts-1", voice: "alloy", speed: 1, responseFormat: "mp3", text: "你好。" });
    expect(await readCachedSegment(realm, binary, key, "mp3")).toBeUndefined();
  });
});

describe("planChapterCost 边界", () => {
  it("缺少旁白音色时返回 422", () => {
    try {
      planChapterCost({ ...PROJECT, cast: [] }, SCRIPT, new Set());
      expect.unreachable("缺少旁白时不应给出成本预估");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceHttpError);
      expect(error).toMatchObject({ status: 422 });
    }
  });

  it("单段命中只减少请求数与计费字符", () => {
    const hit = ttsCacheKey({
      baseUrl: "https://api.example.com/v1", model: "tts-1", voice: "alloy", speed: 1, responseFormat: "mp3", text: "你好。",
    });

    const estimate = planChapterCost(PROJECT, SCRIPT, new Set([hit]));

    expect(estimate).toMatchObject({ segments: 2, chars: 6, cacheHits: 1, requests: 1 });
    expect(estimate.estimatedCost).toBeCloseTo(3 / 1_000_000 * 15);
  });
});
