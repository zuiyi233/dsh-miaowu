import { describe, expect, it } from "vitest";
import {
  assertAssignable,
  assertValidCast,
  isSpeakerAssignable,
  requiredSegmentVoice,
  resolveCast,
  segmentVoice,
  unassignedSegmentsIn,
} from "../src/services/audiobook-cast.js";
import type { AudiobookCastMember, AudiobookProject, AudiobookScript, AudiobookSegment } from "../src/services/audiobook-contract.js";

const CAST: readonly AudiobookCastMember[] = [
  { id: "narrator", name: "旁白", kind: "narrator", voice: "alloy" },
  { id: "role-linfan", name: "林帆", kind: "character", voice: "verse" },
  { id: "role-shen", name: "沈秋", kind: "character", voice: "echo" },
];

const PROJECT: AudiobookProject = {
  schemaVersion: 1,
  source: { bookRoot: "正文", chapters: ["正文/第0001章.md"] },
  tts: {
    baseUrl: "https://api.example.com/v1",
    model: "tts-1",
    responseFormat: "mp3",
    speed: 1,
    pricePerMillionChars: 15,
    maxCharsPerChapter: 20_000,
    concurrency: 2,
  },
  cast: CAST,
  cues: [],
  export: { mp3BitrateKbps: 192, sampleRate: 44_100, channels: 2, loudnessLufs: -16, truePeakDbtp: -1.5, subtitles: [] },
  rights: { voiceCloning: false },
};

function segment(overrides: Partial<AudiobookSegment>): AudiobookSegment {
  return {
    id: "s-1",
    kind: "dialogue",
    speakerId: "role-linfan",
    text: "你好。",
    sourceStart: 0,
    sourceEnd: 3,
    ...overrides,
  };
}

function script(segments: readonly AudiobookSegment[]): AudiobookScript {
  return {
    schemaVersion: 1,
    chapter: "第0001章",
    sourcePath: "正文/第0001章.md",
    sourceSha256: "0".repeat(64),
    segments,
  };
}

describe("cast 语义校验", () => {
  it("接受一个旁白加多个角色，拒绝缺失/重复旁白与不可用 id", () => {
    expect(() => { assertValidCast(CAST); }).not.toThrow();
    expect(() => { assertValidCast([]); }).toThrow(/至少需要一个旁白/u);
    expect(() => { assertValidCast([CAST[0]!, CAST[1]!, { ...CAST[1]!, name: "另一个林帆" }]); }).toThrow(/重复/u);
    expect(() => { assertValidCast([CAST[0]!, { ...CAST[1]!, kind: "narrator" }]); }).toThrow(/恰好有一个旁白/u);
    expect(() => { assertValidCast([CAST[0]!, { ...CAST[1]!, id: "unknown" }]); }).toThrow(/保留值/u);
    expect(() => { assertValidCast([CAST[0]!, { ...CAST[1]!, id: "角色 一" }]); }).toThrow(/id 无效/u);
    expect(() => { assertValidCast([CAST[0]!, { ...CAST[1]!, name: " " }]); }).toThrow(/显示名/u);
    expect(() => { assertValidCast([CAST[0]!, { ...CAST[1]!, voice: " " }]); }).toThrow(/音色/u);
  });
});

describe("每段音色解析", () => {
  it("旁白固定 narrator，对白按 speakerId 取角色音色", () => {
    const cast = resolveCast(PROJECT);
    expect(segmentVoice(cast, segment({ kind: "narration", speakerId: "narrator" }))).toBe("alloy");
    expect(segmentVoice(cast, segment({ speakerId: "role-linfan" }))).toBe("verse");
    expect(segmentVoice(cast, segment({ speakerId: "role-shen" }))).toBe("echo");
  });

  it("unknown、缺失角色与未指派音色都返回 undefined，不做旁白回退", () => {
    const cast = resolveCast(PROJECT);
    expect(segmentVoice(cast, segment({ speakerId: "unknown" }))).toBeUndefined();
    expect(segmentVoice(cast, segment({ speakerId: "role-deleted" }))).toBeUndefined();
    expect(isSpeakerAssignable(cast, "unknown")).toBe(true);
    expect(isSpeakerAssignable(cast, "role-linfan")).toBe(true);
    expect(isSpeakerAssignable(cast, "role-deleted")).toBe(false);
  });

  it("未指派对白计数并阻止整章；全部指派后放行", () => {
    const cast = resolveCast(PROJECT);
    const mixed = script([
      segment({ id: "s-1", kind: "narration", speakerId: "narrator" }),
      segment({ id: "s-2", speakerId: "role-linfan" }),
      segment({ id: "s-3", speakerId: "unknown" }),
      segment({ id: "s-4", speakerId: "role-deleted" }),
    ]);
    expect(unassignedSegmentsIn(cast, mixed).map((item) => item.id)).toEqual(["s-3", "s-4"]);
    expect(() => { assertAssignable(cast, mixed); }).toThrow(/2 段对白/u);
    expect(() => { assertAssignable(cast, mixed); }).toThrow(/尚未指派说话人/u);

    const assigned = script(mixed.segments.map((item) => item.id === "s-3" || item.id === "s-4"
      ? { ...item, speakerId: "role-shen" }
      : item));
    expect(() => { assertAssignable(cast, assigned); }).not.toThrow();
    expect(requiredSegmentVoice(cast, assigned.segments[1]!)).toBe("verse");
    expect(() => { requiredSegmentVoice(cast, mixed.segments[2]!); }).toThrow(/s-3/u);
  });
});
