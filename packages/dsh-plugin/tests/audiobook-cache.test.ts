import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FsTarget } from "@deepseek-ai/dsh-fs";
import { describe, expect, it } from "vitest";
import type { WorkspaceRealm } from "../src/workspace-route.js";
import { hostBinaryFileStore, memoryBinaryFileStore } from "../src/services/audiobook-binary.js";
import {
  planChapterCost,
  readCachedSegment,
  segmentAudioPath,
  segmentMetaPath,
  ttsCacheKey,
  writeCachedSegment,
} from "../src/services/audiobook-cache.js";
import type { AudiobookProject, AudiobookScript } from "../src/services/audiobook-contract.js";
import { SANDBOX_POLICY, SESSION, memoryRealm } from "./audiobook-fixtures.js";

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

const CACHED_KEY = ttsCacheKey({
  baseUrl: "https://api.example.com/v1",
  model: "tts-1",
  voice: "alloy",
  speed: 1,
  responseFormat: "mp3",
  text: "你好。",
});

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

  it("写入后读回字节，meta 不含密钥且透传沙箱策略", async () => {
    const binary = memoryBinaryFileStore();
    const { realm, policyRequests, writeCalls } = memoryRealm();
    const key = ttsCacheKey({ baseUrl: "https://api.example.com/v1", model: "tts-1", voice: "alloy", speed: 1, responseFormat: "mp3", text: "你好。" });
    await writeCachedSegment(realm, binary, key, "mp3", new Uint8Array([1, 2, 3]), { model: "tts-1", voice: "alloy", bytes: 3 });
    expect(Array.from(await readCachedSegment(realm, binary, key, "mp3") ?? [])).toEqual([1, 2, 3]);
    expect(binary.files.get(segmentAudioPath(key, "mp3"))?.length).toBe(3);
    expect(policyRequests).toEqual([{ session: SESSION }]);
    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0]?.sandboxPolicy).toBe(SANDBOX_POLICY);
  });

  it("成本只计算缓存未命中的字符", () => {
    const voiceFor = (): string => "alloy";
    const estimate = planChapterCost(PROJECT, SCRIPT, new Set(), voiceFor);
    expect(estimate).toMatchObject({ segments: 2, chars: 6, cacheHits: 0, requests: 2 });
    expect(estimate.estimatedCost).toBe(0.00009);
    expect(planChapterCost(PROJECT, SCRIPT, new Set([CACHED_KEY]), voiceFor).cacheHits).toBe(1);
  });

  it("逐段音色参与缓存键：旁白与角色各算各的命中", () => {
    const mixed: AudiobookScript = {
      ...SCRIPT,
      segments: [
        { id: "s-1", text: "你好。", kind: "narration", speakerId: "narrator", sourceStart: 0, sourceEnd: 3 },
        { id: "s-2", text: "世界。", kind: "dialogue", speakerId: "role-linfan", sourceStart: 3, sourceEnd: 6 },
      ],
    };
    const dialogueKey = ttsCacheKey({
      baseUrl: "https://api.example.com/v1",
      model: "tts-1",
      voice: "verse",
      speed: 1,
      responseFormat: "mp3",
      text: "世界。",
    });
    const voiceFor = (segment: AudiobookScript["segments"][number]): string =>
      segment.kind === "narration" ? "alloy" : "verse";

    const estimate = planChapterCost(PROJECT, mixed, new Set([CACHED_KEY]), voiceFor);
    expect(estimate).toMatchObject({ segments: 2, chars: 6, cacheHits: 1, requests: 1 });
    expect(estimate.estimatedCost).toBe(0.000045);
    expect(planChapterCost(PROJECT, mixed, new Set([CACHED_KEY, dialogueKey]), voiceFor).cacheHits).toBe(2);
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

describe("audiobook cache 原子写入", () => {
  it("先写临时文件再改名，最终字节可见且不留临时文件", async () => {
    const binary = memoryBinaryFileStore();
    const { realm } = memoryRealm();

    await writeCachedSegment(realm, binary, CACHED_KEY, "mp3", new Uint8Array([7, 8, 9]), { model: "tts-1", voice: "alloy" });

    expect(Array.from(await readCachedSegment(realm, binary, CACHED_KEY, "mp3") ?? [])).toEqual([7, 8, 9]);
    expect(binary.files.has(segmentAudioPath(CACHED_KEY, "mp3"))).toBe(true);
    expect([...binary.files.keys()].filter((path) => path.includes(".tmp-"))).toEqual([]);
  });

  it("改名失败时删除临时文件并抛出，不留下缓存命中", async () => {
    const store = memoryBinaryFileStore();
    const binary = { ...store, rename: (): Promise<void> => Promise.reject(new Error("rename 失败")) };
    const { realm, writes } = memoryRealm();

    await expect(writeCachedSegment(realm, binary, CACHED_KEY, "mp3", new Uint8Array([1, 2, 3]), { model: "tts-1", voice: "alloy" }))
      .rejects.toThrow("rename 失败");

    expect(store.files.size).toBe(0);
    expect(writes).toHaveLength(0);
    expect(await readCachedSegment(realm, store, CACHED_KEY, "mp3")).toBeUndefined();
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

  it("缓存根不在工作区内时 403，且不触碰文件系统", async () => {
    const binary = memoryBinaryFileStore();
    const base = memoryRealm();
    const realm = {
      ...base.realm,
      fs: { ...base.realm.fs, contains: (): boolean => false },
    } as unknown as WorkspaceRealm;

    await expect(readCachedSegment(realm, binary, CACHED_KEY, "mp3"))
      .rejects.toMatchObject({ status: 403, message: "缓存目录离开了 DSH 工作目录。" });
    await expect(writeCachedSegment(realm, binary, CACHED_KEY, "mp3", new Uint8Array([1]), { model: "tts-1", voice: "alloy" }))
      .rejects.toMatchObject({ status: 403, message: "缓存目录离开了 DSH 工作目录。" });

    expect(binary.files.size).toBe(0);
    expect(base.writes).toHaveLength(0);
    expect(base.policyRequests).toHaveLength(0);
  });

  it("缓存目标离开缓存目录时 403，且不触碰文件系统", async () => {
    const binary = memoryBinaryFileStore();
    const base = memoryRealm();
    const realm = {
      ...base.realm,
      // 只认为工作区根包含一切，缓存根对目标不成立，命中目标级 contains 分支。
      fs: { ...base.realm.fs, contains: (parent: FsTarget): boolean => parent.displayPath === "" },
    } as unknown as WorkspaceRealm;

    await expect(readCachedSegment(realm, binary, CACHED_KEY, "mp3"))
      .rejects.toMatchObject({ status: 403, message: "缓存路径离开了缓存目录。" });
    await expect(writeCachedSegment(realm, binary, CACHED_KEY, "mp3", new Uint8Array([1]), { model: "tts-1", voice: "alloy" }))
      .rejects.toMatchObject({ status: 403, message: "缓存路径离开了缓存目录。" });

    expect(binary.files.size).toBe(0);
    expect(base.writes).toHaveLength(0);
    expect(base.policyRequests).toHaveLength(0);
  });

  it("合法键未命中返回 undefined", async () => {
    const binary = memoryBinaryFileStore();
    const { realm } = memoryRealm();
    expect(await readCachedSegment(realm, binary, CACHED_KEY, "mp3")).toBeUndefined();
  });
});

describe("planChapterCost 边界", () => {
  it("单段命中只减少请求数与计费字符", () => {
    const hit = ttsCacheKey({
      baseUrl: "https://api.example.com/v1", model: "tts-1", voice: "alloy", speed: 1, responseFormat: "mp3", text: "你好。",
    });

    const estimate = planChapterCost(PROJECT, SCRIPT, new Set([hit]), () => "alloy");

    expect(estimate).toMatchObject({ segments: 2, chars: 6, cacheHits: 1, requests: 1 });
    expect(estimate.estimatedCost).toBe(0.000045);
  });

  it("成本按六位小数四舍五入", () => {
    const cheapProject: AudiobookProject = {
      ...PROJECT,
      tts: { ...PROJECT.tts, pricePerMillionChars: 0.4 },
    };
    const fiveCharScript: AudiobookScript = {
      ...SCRIPT,
      segments: [{ id: "s-1", text: "一二三四五", kind: "narration", speakerId: "narrator", sourceStart: 0, sourceEnd: 5 }],
    };

    const estimate = planChapterCost(cheapProject, fiveCharScript, new Set(), () => "alloy");

    expect(estimate).toMatchObject({ segments: 1, chars: 5, cacheHits: 0, requests: 1 });
    expect(estimate.estimatedCost).toBe(0.000002);
  });
});

describe("hostBinaryFileStore", () => {
  it("在真实临时目录上完成 prepare/write/read/stat/rename/remove", async () => {
    const dir = await mkdtemp(join(tmpdir(), "audiobook-binary-"));
    try {
      const realm = {
        fs: { processPath: (target: FsTarget): string => join(dir, target.displayPath) },
      } as unknown as WorkspaceRealm;
      const binary = hostBinaryFileStore(realm);
      const audio = { targetKey: "audio", displayPath: ".oh-story/audiobook/cache/host/audio.mp3" } as FsTarget;
      const renamed = { targetKey: "renamed", displayPath: ".oh-story/audiobook/cache/host/renamed.mp3" } as FsTarget;

      expect(binary.processPath(audio)).toBe(join(dir, audio.displayPath));
      expect(await binary.read(audio, 10)).toBeUndefined();
      expect(await binary.stat(audio)).toBeUndefined();

      await binary.prepare(audio);
      await binary.write(audio, new TextEncoder().encode("hello"));
      expect(await binary.stat(audio)).toEqual({ size: 5 });
      expect(Array.from(await binary.read(audio, 5) ?? [])).toEqual([104, 101, 108, 108, 111]);
      expect(await binary.read(audio, 4)).toBeUndefined();

      await binary.rename(audio, renamed);
      expect(await binary.stat(audio)).toBeUndefined();
      expect(Array.from(await binary.read(renamed, 5) ?? [])).toEqual([104, 101, 108, 108, 111]);

      await binary.remove(renamed);
      expect(await binary.stat(renamed)).toBeUndefined();
      expect(await binary.read(renamed, 5)).toBeUndefined();
      // remove 对缺失目标幂等。
      await binary.remove(renamed);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
