// tests/audiobook-subtitles.test.ts
import { describe, expect, it } from "vitest";
import { buildSubtitleCues, formatLrc, formatSrt, subtitlePathsFor } from "../src/services/audiobook-subtitles.js";
import { WorkspaceHttpError } from "../src/workspace-route.js";
import type { AudiobookScript } from "../src/services/audiobook-contract.js";
import type { TimedSegment } from "../src/services/audiobook-timeline.js";

const script: AudiobookScript = {
  schemaVersion: 1, chapter: "第0001章", sourcePath: "正文/第0001章.md", sourceSha256: "0".repeat(64),
  segments: [
    { id: "s-1", kind: "narration", speakerId: "narrator", text: "第一段。", sourceStart: 0, sourceEnd: 4 },
    { id: "s-2", kind: "dialogue", speakerId: "role-a", text: "第二段。", sourceStart: 4, sourceEnd: 8 },
  ],
};
const timeline: TimedSegment[] = [
  { segmentId: "s-1", startMs: 0, endMs: 1_000, durationMs: 1_000 },
  { segmentId: "s-2", startMs: 1_120, endMs: 3_120, durationMs: 2_000 },
];

/** 捕获服务抛出的 HTTP 状态码；不是 WorkspaceHttpError 时返回 undefined。 */
const rejectionStatus = (action: () => unknown): number | undefined => {
  try {
    action();
    return undefined;
  } catch (error) {
    return error instanceof WorkspaceHttpError ? error.status : undefined;
  }
};

describe("audiobook subtitles", () => {
  it("SRT 与 LRC 使用实测时轴，空行/换行规范", () => {
    const cues = buildSubtitleCues(timeline, script);
    expect(cues).toEqual([
      { startMs: 0, endMs: 1_000, text: "第一段。" },
      { startMs: 1_120, endMs: 3_120, text: "第二段。" },
    ]);
    expect(formatSrt(cues)).toBe("1\n00:00:00,000 --> 00:00:01,000\n第一段。\n\n2\n00:00:01,120 --> 00:00:03,120\n第二段。\n");
    expect(formatLrc(cues)).toBe("[00:00.00]第一段。\n[00:01.12]第二段。\n");
  });

  it("长句按标点与 42 字上限拆分，时间按字符比例分配", () => {
    const long = { ...script, segments: [{ id: "s-1", kind: "narration" as const, speakerId: "narrator", text: "一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十，后半句。", sourceStart: 0, sourceEnd: 50 }] };
    const cues = buildSubtitleCues([{ segmentId: "s-1", startMs: 0, endMs: 5_000, durationMs: 5_000 }], long);
    expect(cues.length).toBeGreaterThan(1);
    expect(cues.every((cue) => cue.text.length <= 42)).toBe(true);
    expect(cues[0]?.startMs).toBe(0);
    expect(cues.at(-1)?.endMs).toBe(5_000);
    expect(cues.map((cue) => cue.text).join("")).toBe(long.segments[0]!.text);
  });

  it("时间轴引用脚本外的片段时直接失败，不静默丢字幕", () => {
    expect(rejectionStatus(() => buildSubtitleCues([{ segmentId: "s-9", startMs: 0, endMs: 10, durationMs: 10 }], script))).toBe(409);
  });

  it("字幕路径只落在 有声剧/<书>/字幕/ 下，危险章节名与错位项目路径被拒绝", () => {
    expect(subtitlePathsFor("有声剧/长夜行/project.json", "第0001章")).toEqual({
      srt: "有声剧/长夜行/字幕/第0001章.srt",
      lrc: "有声剧/长夜行/字幕/第0001章.lrc",
    });
    expect(rejectionStatus(() => subtitlePathsFor("有声剧/长夜行/project.json", "第0001章/番外"))).toBe(400);
    expect(rejectionStatus(() => subtitlePathsFor("有声剧/长夜行/project.json", "../第0001章"))).toBe(400);
    expect(rejectionStatus(() => subtitlePathsFor("正文/长夜行/project.json", "第0001章"))).toBe(400);
  });
});
