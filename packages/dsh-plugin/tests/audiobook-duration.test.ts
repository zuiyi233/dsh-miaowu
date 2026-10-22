// tests/audiobook-duration.test.ts
import { describe, expect, it } from "vitest";
import { memoryBinaryFileStore } from "../src/services/audiobook-binary.js";
import { AUDIOBOOK_DURATION_ROOT, measureAudioDuration, measureCachedSegmentDuration } from "../src/services/audiobook-duration.js";
import { segmentAudioPath } from "../src/services/audiobook-cache.js";
import { memoryRealm, SANDBOX_POLICY } from "./audiobook-fixtures.js";
import type { CommandRunner } from "../src/services/audiobook-export.js";

const KEY = "a".repeat(64);
const FFPROBE_PREFIX = "ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1";
const runtime = (durations: string[], calls: string[]): { binary: ReturnType<typeof memoryBinaryFileStore>; runner: CommandRunner } => ({
  binary: memoryBinaryFileStore(),
  runner: { run: async (command, args) => { calls.push([command, ...args].join(" ")); return { code: 0, stdout: durations.shift() ?? "", stderr: "" }; } },
});

describe("duration cache", () => {
  it("首次 ffprobe，第二次读缓存不再调用 ffprobe", async () => {
    const { realm } = memoryRealm();
    const binary = memoryBinaryFileStore();
    binary.files.set(segmentAudioPath(KEY, "mp3"), new Uint8Array([1]));
    const calls: string[] = [];
    const rt = { ...runtime(["12.5\n"], calls), binary };
    expect(await measureCachedSegmentDuration(realm, rt, KEY, "mp3")).toBe(12_500);
    expect(await measureCachedSegmentDuration(realm, rt, KEY, "mp3")).toBe(12_500);
    expect(calls).toHaveLength(1);
  });

  it("缺缓存音频返回 409，坏时长返回 500", async () => {
    const { realm } = memoryRealm();
    const binary = memoryBinaryFileStore();
    const calls: string[] = [];
    await expect(measureCachedSegmentDuration(realm, { ...runtime([], calls), binary }, KEY, "mp3"))
      .rejects.toMatchObject({ status: 409 });
    binary.files.set(segmentAudioPath(KEY, "mp3"), new Uint8Array([1]));
    await expect(measureCachedSegmentDuration(realm, { ...runtime(["not-a-number\n"], calls), binary }, KEY, "mp3"))
      .rejects.toMatchObject({ status: 500 });
  });

  it("ffprobe 参数固定，缓存文档写入固定路径并带沙箱策略", async () => {
    const { realm, writeCalls, read } = memoryRealm();
    const binary = memoryBinaryFileStore();
    binary.files.set(segmentAudioPath(KEY, "mp3"), new Uint8Array([1]));
    const calls: string[] = [];
    expect(await measureCachedSegmentDuration(realm, { ...runtime(["12.5\n"], calls), binary }, KEY, "mp3")).toBe(12_500);
    expect(calls).toEqual([`${FFPROBE_PREFIX} ${segmentAudioPath(KEY, "mp3")}`]);
    const path = `${AUDIOBOOK_DURATION_ROOT}/${KEY}.json`;
    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0]?.path).toBe(path);
    expect(writeCalls[0]?.intent).toEqual({ kind: "createIfAbsent" });
    expect(writeCalls[0]?.sandboxPolicy).toBe(SANDBOX_POLICY);
    expect(JSON.parse(read(path) ?? "{}")).toMatchObject({
      schemaVersion: 1,
      cacheKey: KEY,
      durationMs: 12_500,
      probedAt: expect.any(Number),
    });
  });

  it("非法缓存键返回 400，不调用 ffprobe", async () => {
    const { realm } = memoryRealm();
    const binary = memoryBinaryFileStore();
    const calls: string[] = [];
    await expect(measureCachedSegmentDuration(realm, { ...runtime([], calls), binary }, "A".repeat(64), "mp3"))
      .rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(0);
  });

  it("坏 JSON 缓存不当 422，重新探测后写冲突且已有文件仍坏则 500", async () => {
    const path = `${AUDIOBOOK_DURATION_ROOT}/${KEY}.json`;
    const { realm } = memoryRealm({ [path]: "{not-json" });
    const binary = memoryBinaryFileStore();
    binary.files.set(segmentAudioPath(KEY, "mp3"), new Uint8Array([1]));
    const calls: string[] = [];
    await expect(measureCachedSegmentDuration(realm, { ...runtime(["12.5\n"], calls), binary }, KEY, "mp3"))
      .rejects.toMatchObject({ status: 500 });
    expect(calls).toHaveLength(1);
  });

  it("measureAudioDuration 直接探测、不写缓存；缺失 409、坏输出 500", async () => {
    const { realm, writes } = memoryRealm();
    const binary = memoryBinaryFileStore();
    const target = await realm.fs.resolve("有声剧/长夜行/素材/音乐/theme.mp3", { cwd: realm.cwd });
    const calls: string[] = [];
    await expect(measureAudioDuration({ ...runtime([], calls), binary }, realm, target))
      .rejects.toMatchObject({ status: 409 });
    binary.files.set(target.displayPath, new Uint8Array([1]));
    await expect(measureAudioDuration({ ...runtime(["3.25\n"], calls), binary }, realm, target)).resolves.toBe(3_250);
    expect(calls).toEqual([`${FFPROBE_PREFIX} 有声剧/长夜行/素材/音乐/theme.mp3`]);
    expect(writes).toEqual([]);
    await expect(measureAudioDuration({ ...runtime(["oops\n"], calls), binary }, realm, target))
      .rejects.toMatchObject({ status: 500 });
  });
});
