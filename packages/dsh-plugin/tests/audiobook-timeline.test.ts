// tests/audiobook-timeline.test.ts
import { describe, expect, it } from "vitest";
import { assertCueWindow, buildTimeline, cueWindow, DEFAULT_PAUSE_MS } from "../src/services/audiobook-timeline.js";
import type { AudiobookCue, AudiobookScript } from "../src/services/audiobook-contract.js";

const SCRIPT: AudiobookScript = {
  schemaVersion: 1, chapter: "第0001章", sourcePath: "正文/第0001章.md", sourceSha256: "0".repeat(64),
  segments: [
    { id: "s-1", kind: "narration", speakerId: "narrator", text: "第一段。", sourceStart: 0, sourceEnd: 4 },
    { id: "s-2", kind: "dialogue", speakerId: "role-a", text: "第二段。", sourceStart: 4, sourceEnd: 8 },
  ],
};

const cue = (overrides: Partial<AudiobookCue> = {}): AudiobookCue => ({
  id: "cue-1", chapter: "第0001章", asset: "有声剧/长夜行/素材/音乐/theme.mp3",
  startSegment: "s-2", offsetMs: 100, fadeInMs: 500, fadeOutMs: 1_000, gainDb: -6, duckDb: -12,
  ...overrides,
});

describe("audiobook timeline", () => {
  it("按实测时长与固定停顿排时间轴", () => {
    const timeline = buildTimeline(SCRIPT, new Map([["s-1", 1_000], ["s-2", 2_000]]));
    expect(timeline).toEqual([
      { segmentId: "s-1", startMs: 0, endMs: 1_000, durationMs: 1_000 },
      { segmentId: "s-2", startMs: 1_000 + DEFAULT_PAUSE_MS, endMs: 3_000 + DEFAULT_PAUSE_MS, durationMs: 2_000 },
    ]);
  });

  it("缺时长直接失败，不猜时长", () => {
    expect(() => buildTimeline(SCRIPT, new Map([["s-1", 1_000]]))).toThrow(/s-2/u);
  });

  it("音乐 cue 从锚点播放到章末，音效 cue 播放素材长度", () => {
    const timeline = buildTimeline(SCRIPT, new Map([["s-1", 1_000], ["s-2", 2_000]]));
    const chapterEnd = timeline.at(-1)!.endMs;
    expect(cueWindow(cue(), "music", timeline, chapterEnd, 30_000)).toEqual({ startMs: 1_220, endMs: chapterEnd });
    expect(cueWindow(cue({ asset: "有声剧/长夜行/素材/音效/whoosh.wav", offsetMs: 0 }), "effect", timeline, chapterEnd, 500))
      .toEqual({ startMs: 1_120, endMs: 1_620 });
  });

  it("cue 偏移越过章末或负偏移被拒绝", () => {
    const timeline = buildTimeline(SCRIPT, new Map([["s-1", 1_000], ["s-2", 2_000]]));
    const chapterEnd = timeline.at(-1)!.endMs;
    expect(() => cueWindow(cue({ offsetMs: 99_999 }), "music", timeline, chapterEnd, 30_000)).toThrow(/章末/u);
    expect(() => cueWindow(cue({ offsetMs: -1 }), "music", timeline, chapterEnd, 30_000)).toThrow(/偏移/u);
  });

  it("assertCueWindow 拒绝空窗与越过章末的窗口", () => {
    const chapterEnd = buildTimeline(SCRIPT, new Map([["s-1", 1_000], ["s-2", 2_000]])).at(-1)!.endMs;
    expect(() => assertCueWindow(cue(), { startMs: 1_220, endMs: 1_220 }, chapterEnd)).toThrow(/时间窗/u);
    expect(() => assertCueWindow(cue(), { startMs: 1_220, endMs: chapterEnd + 1 }, chapterEnd)).toThrow(/章末/u);
  });
});
