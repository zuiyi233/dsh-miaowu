import { describe, expect, it } from "vitest";
import {
  buildMixArgs, buildLoudnormApplyArgs, buildLoudnormMeasureArgs, parseLoudnormMeasurement,
} from "../src/services/audiobook-mix.js";
import type { TimedSegment } from "../src/services/audiobook-timeline.js";

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
