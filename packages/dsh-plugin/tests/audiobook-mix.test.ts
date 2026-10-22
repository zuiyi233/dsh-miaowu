import { describe, expect, it } from "vitest";
import {
  buildMixArgs, buildLoudnormApplyArgs, buildLoudnormMeasureArgs, parseLoudnormMeasurement,
  type MixCue,
} from "../src/services/audiobook-mix.js";
import type { TimedSegment } from "../src/services/audiobook-timeline.js";
import { WorkspaceHttpError } from "../src/workspace-route.js";

const timeline: TimedSegment[] = [
  { segmentId: "s-1", startMs: 0, endMs: 1_000, durationMs: 1_000 },
  { segmentId: "s-2", startMs: 1_120, endMs: 3_120, durationMs: 2_000 },
];

describe("audiobook mix", () => {
  it("旁白拼接、BGM 延迟/淡入淡出/增益/闪避与 amix 参数固定", () => {
    const { args, filterGraph } = buildMixArgs({
      voicePaths: ["/tmp/s1.mp3", "/tmp/s2.mp3"],
      timeline,
      chapterEndMs: 3_120,
      cues: [{ id: "cue-1", kind: "music", assetPath: "/tmp/theme.mp3", startMs: 1_000, endMs: 3_120, fadeInMs: 500, fadeOutMs: 1_000, gainDb: -6, duckDb: -12 }],
      outputPath: "/tmp/master.wav",
    });
    expect(args.filter((arg) => arg === "-filter_complex")).toHaveLength(1);
    expect(filterGraph).toContain("concat=n=2:v=0:a=1[voice]");
    expect(filterGraph).toContain("apad=pad_dur=0.12");
    expect(filterGraph).toContain("adelay=1000|1000");
    expect(filterGraph).toContain("afade=t=in:st=0:d=0.5");
    expect(filterGraph).toContain("afade=t=out:st=2.12:d=1");
    expect(filterGraph).toContain("volume=-6dB");
    expect(filterGraph).toContain("if(between(t,0,1)+between(t,1.12,3.12),0.251188643150958,1)");
    expect(filterGraph).toContain("amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mix]");
    expect(args).toContain("pcm_s16le");
    expect(args.at(-1)).toBe("/tmp/master.wav");
    const fadeInAt = filterGraph.indexOf("afade=t=in:");
    const delayAt = filterGraph.indexOf("adelay=");
    const fadeOutAt = filterGraph.indexOf("afade=t=out:");
    expect(fadeInAt).toBeGreaterThanOrEqual(0);
    expect(fadeInAt).toBeLessThan(delayAt);
    expect(fadeOutAt).toBeGreaterThan(delayAt);
  });

  it("音效按 cue 窗口长度裁剪，不越过自身窗口", () => {
    const { filterGraph } = buildMixArgs({
      voicePaths: ["/tmp/s1.mp3", "/tmp/s2.mp3"],
      timeline,
      chapterEndMs: 3_120,
      cues: [{ id: "cue-fx", kind: "effect", assetPath: "/tmp/slam.wav", startMs: 1_120, endMs: 1_620, fadeInMs: 0, fadeOutMs: 0, gainDb: 0, duckDb: 0 }],
      outputPath: "/tmp/master.wav",
    });
    expect(filterGraph).toContain("atrim=0:0.5");
    expect(filterGraph).toContain("adelay=1120|1120");
    expect(filterGraph).not.toContain("atrim=0:1.62");
  });

  it("无 cue 时只输出 voice，不引入 amix", () => {
    const { filterGraph } = buildMixArgs({ voicePaths: ["/tmp/s1.mp3", "/tmp/s2.mp3"], timeline, chapterEndMs: 3_120, cues: [], outputPath: "/tmp/master.wav" });
    expect(filterGraph).toContain("[voice]anull[mix]");
    expect(filterGraph).not.toContain("amix");
  });

  it("两遍 loudnorm：先测量再应用", () => {
    expect(buildLoudnormMeasureArgs("/tmp/master.wav")).toEqual([
      "-hide_banner", "-loglevel", "info", "-y", "-i", "/tmp/master.wav",
      "-af", "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-",
    ]);
    const measured = parseLoudnormMeasurement(JSON.stringify({ input_i: "-18.20", input_tp: "-2.10", input_lra: "7.00", input_thresh: "-28.30", target_offset: "0.10" }));
    expect(measured).toEqual({ inputI: -18.2, inputTp: -2.1, inputLra: 7, inputThresh: -28.3, targetOffset: 0.1 });
    expect(buildLoudnormApplyArgs("/tmp/master.wav", "/tmp/normalized.wav", measured)).toEqual([
      "-hide_banner", "-loglevel", "error", "-y", "-i", "/tmp/master.wav",
      "-af", "loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=-18.2:measured_TP=-2.1:measured_LRA=7:measured_thresh=-28.3:offset=0.1:linear=true",
      "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", "/tmp/normalized.wav",
    ]);
  });
});

const baseCue: MixCue = {
  id: "cue-1",
  kind: "music",
  assetPath: "/tmp/theme.mp3",
  startMs: 1_000,
  endMs: 3_120,
  fadeInMs: 500,
  fadeOutMs: 1_000,
  gainDb: -6,
  duckDb: -12,
};

function captured(action: () => unknown): WorkspaceHttpError {
  try {
    action();
  } catch (error) {
    if (error instanceof WorkspaceHttpError) return error;
    throw error;
  }
  throw new Error("预期抛出 WorkspaceHttpError");
}

function mixFailure(cue: MixCue): WorkspaceHttpError {
  return captured(() =>
    buildMixArgs({
      voicePaths: ["/tmp/s1.mp3", "/tmp/s2.mp3"],
      timeline,
      chapterEndMs: 3_120,
      cues: [cue],
      outputPath: "/tmp/master.wav",
    }),
  );
}

describe("audiobook mix 校验错误码", () => {
  const cases: Array<[string, MixCue, number]> = [
    ["cue 时间窗起点为负", { ...baseCue, startMs: -1 }, 400],
    ["cue 淡入时长为负", { ...baseCue, fadeInMs: -1 }, 400],
    ["cue 淡出时长为负", { ...baseCue, fadeOutMs: -1 }, 400],
    ["cue 增益非有限（NaN）", { ...baseCue, gainDb: Number.NaN }, 400],
    ["cue 闪避量非有限（Infinity）", { ...baseCue, duckDb: Number.POSITIVE_INFINITY }, 400],
    ["音效 cue 终点越过章末", { ...baseCue, kind: "effect", startMs: 1_120, endMs: 3_620 }, 409],
    ["cue 时间窗为空（起点等于终点）", { ...baseCue, startMs: 2_000, endMs: 2_000 }, 409],
    ["cue 时间窗倒置（终点小于起点）", { ...baseCue, startMs: 2_000, endMs: 1_500 }, 409],
    ["cue 淡出时长超过时间窗", { ...baseCue, fadeOutMs: 3_000 }, 409],
  ];

  it.each(cases)("%s → %s", (_label, cue, status) => {
    expect(mixFailure(cue).status).toBe(status);
  });
});

describe("audiobook loudnorm 解析错误码", () => {
  const invalid: Array<[string, string]> = [
    ["stderr 中没有 JSON 对象", "[info] loudnorm finished without a measurement block"],
    ["JSON 语法无效", '[info] loudnorm\n{\n\t"input_i" : "-18.20",\n}'],
    [
      "JSON 缺少必填字段 target_offset",
      JSON.stringify({ input_i: "-18.20", input_tp: "-2.10", input_lra: "7.00", input_thresh: "-28.30" }),
    ],
  ];

  it.each(invalid)("%s → 500", (_label, stderr) => {
    expect(captured(() => parseLoudnormMeasurement(stderr)).status).toBe(500);
  });

  it("真实 ffmpeg 日志包裹的 JSON 仍能解析", () => {
    const stderr = [
      "[Parsed_loudnorm_0 @ 0x5612f4c9a480]",
      "{",
      '\t"input_i" : "-18.20",',
      '\t"input_tp" : "-2.10",',
      '\t"input_lra" : "7.00",',
      '\t"input_thresh" : "-28.30",',
      '\t"output_i" : "-16.05",',
      '\t"output_tp" : "-1.50",',
      '\t"output_lra" : "5.00",',
      '\t"output_thresh" : "-25.10",',
      '\t"normalization_type" : "dynamic",',
      '\t"target_offset" : "0.10"',
      "}",
      "[out#0/null @ 0x5612f4c9a480] video:0KiB audio:123KiB subtitle:0KiB other streams:0KiB global headers:0KiB muxing overhead: unknown",
    ].join("\n");
    expect(parseLoudnormMeasurement(stderr)).toEqual({
      inputI: -18.2, inputTp: -2.1, inputLra: 7, inputThresh: -28.3, targetOffset: 0.1,
    });
  });
});
