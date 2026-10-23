// tests/audiobook-ffmpeg.test.ts
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AudiobookCue, AudiobookScript } from "../src/services/audiobook-contract.js";
import { hostCommandRunner, probeTool, type CommandResult } from "../src/services/audiobook-export.js";
import {
  buildLoudnormApplyArgs,
  buildLoudnormMeasureArgs,
  buildMixArgs,
  parseLoudnormMeasurement,
  type MixCue,
} from "../src/services/audiobook-mix.js";
import { buildFfmetadata, buildM4bArgs, type M4bChapter } from "../src/services/audiobook-m4b.js";
import { buildSubtitleCues, formatLrc, formatSrt } from "../src/services/audiobook-subtitles.js";
import { buildTimeline, cueWindow, type TimedSegment } from "../src/services/audiobook-timeline.js";
import { assertCreativePath, mediaMimeTypeForPath } from "../src/workspace-route.js";

/**
 * N4-C 真实 ffmpeg 验收（Task 10a）：本文件把已提交的纯构造函数（`buildMixArgs` /
 * `buildLoudnorm*` / `buildFfmetadata` / `buildM4bArgs` / `buildSubtitleCues`）接到真实
 * 进程与真实文件上。
 *
 * 范围说明（勿再写成“唯一真跑 ffmpeg 的用例”）：`audiobook-export.test.ts` 已经有一个
 * `it.skipIf(!realToolsReady)` 用例，用 `hostCommandRunner` 真跑 ffmpeg 验证单章 MP3 导出
 * （`exportChapterMp3`）产出可播放成品，所以本文件并非仓库里唯一真的启动 ffmpeg/ffprobe
 * 的有声剧用例。二者的分工是：本文件专测只有真进程才给得出、假实现覆盖不到的两类结果——
 * MIX MASTER LOUDNESS 门限（两遍 loudnorm 后混音母带的实测综合 LUFS [-17, -15] 与真峰值
 * ≤ -1.4 dBTP）与 M4B 的 CHAPTER 章节表 + `attached_pic` 封面流；顺带核对混音母带的实际
 * 时长与字幕时间轴。其余 `audiobook-*.test.ts`（含 `audiobook-export-full.test.ts`）注入假
 * `CommandRunner`，只证明参数构造正确。
 *
 * 素材全部由 ffmpeg 自己的 lavfi 源合成，不联网、不读外部素材、无随机数：
 * - 旁白用 `sine`（440/330 Hz、0.4s、`volume=0.25`）而不是 `anullsrc`：静音的
 *   综合响度会测到 -70/-inf LUFS，loudnorm 两遍等于没测；正弦是持续稳态节目，
 *   400ms 门控窗口里始终有真实能量，`input_i`/`input_tp` 稳定可复现；
 * - `volume=0.25` 留 ~12 dBFS 峰值余量：旁白 + BGM 在 `amix=normalize=0` 下相加
 *   也不会削顶，否则 loudnorm 的线性增益会被真峰值上限压住，归一结果达不到 -16 LUFS；
 * - BGM 用 1.5s 正弦（长于 0.92s 的章内窗口），配合 `-stream_loop -1` + `atrim` 走真实分支。
 *
 * `sine` 源在 ffmpeg 9 里没有 `volume` 选项（实测报 `Could not set non-existent option
 * 'volume'`），所以音量走 `-af volume=` 链路。
 */

const runner = hostCommandRunner();
/** 单条命令的时间上限：合成素材都在 1s 级，60s 只用于吸收冷启动与杀软扫描。 */
const COMMAND_TIMEOUT_MS = 60_000;
/** 段落素材时长与频率（固定值）：`durationMs` 交给 ffprobe 实测，不写死进时间轴。 */
const VOICE_HZ = [440, 330] as const;
const VOICE_SECONDS = "0.40";
const VOICE_VOLUME = "0.25";
const BGM_SECONDS = "1.50";
const BGM_VOLUME = "0.30";
/** 时长断言容差：44.1 kHz 下 1 帧 ≈ 0.023ms，20ms 只留给 muxer 的取整。 */
const DURATION_TOLERANCE_MS = 20;

const SCRIPT: AudiobookScript = {
  schemaVersion: 1,
  chapter: "第0001章_开篇",
  sourcePath: "正文/第0001章_开篇.md",
  sourceSha256: "0".repeat(64),
  segments: [
    {
      id: "s-1",
      kind: "narration",
      speakerId: "narrator",
      text: "旁白：长夜的尽头还亮着一盏灯，风把窗台的影子拉得很长，也把这些年没说出口的话留在了门口。",
      sourceStart: 0,
      sourceEnd: 48,
    },
    { id: "s-2", kind: "dialogue", speakerId: "role-linfan", text: "“别走。”她说。", sourceStart: 49, sourceEnd: 56 },
  ],
};

/** BGM cue：项目里的原始形状，窗口交给 `cueWindow` 现算，不在测试里手填毫秒。 */
const MUSIC_CUE: AudiobookCue = {
  id: "cue-bgm",
  chapter: "第0001章_开篇",
  asset: "有声剧/长夜行/素材/主题.wav",
  startSegment: "s-1",
  offsetMs: 0,
  fadeInMs: 100,
  fadeOutMs: 100,
  gainDb: -6,
  duckDb: -12,
};

// 真实工具闸门：本机没有 ffmpeg/ffprobe 时显式跳过（不装、不伪造通过），有则必须执行。
const realToolsReady =
  (await probeTool(runner, "ffmpeg")) && (await probeTool(runner, "ffprobe"));
const SKIP_REASON = "本机缺少 ffmpeg/ffprobe，跳过真实混音与 M4B 验收";

async function runOrThrow(tool: string, args: readonly string[]): Promise<CommandResult> {
  const result = await runner.run(tool, [...args], { timeoutMs: COMMAND_TIMEOUT_MS });
  if (result.code !== 0) {
    throw new Error(`${tool} 失败（退出码 ${String(result.code)}）：${result.stderr.slice(-500)}`);
  }
  return result;
}

/** ffprobe 实测时长（毫秒）：与导出链路同一套 `-show_entries format=duration` 取数。 */
async function measuredDurationMs(path: string): Promise<number> {
  const result = await runOrThrow("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    path,
  ]);
  const seconds = Number(result.stdout.trim());
  if (!Number.isFinite(seconds)) throw new Error(`ffprobe 没有给出有效时长：${result.stdout.slice(0, 200)}`);
  return Math.round(seconds * 1000);
}

async function makeTone(directory: string, fileName: string, frequencyHz: number, seconds: string, volume: string): Promise<string> {
  const path = join(directory, fileName);
  await runOrThrow("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `sine=frequency=${String(frequencyHz)}:duration=${seconds}`,
    "-af", `volume=${volume}`,
    "-c:a", "pcm_s16le",
    path,
  ]);
  expect((await stat(path)).size).toBeGreaterThan(0);
  return path;
}

async function makeChapterMp3(directory: string, fileName: string, frequencyHz: number): Promise<string> {
  const path = join(directory, fileName);
  await runOrThrow("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `sine=frequency=${String(frequencyHz)}:duration=0.60`,
    "-af", "volume=0.20",
    "-c:a", "libmp3lame", "-b:a", "128k",
    path,
  ]);
  expect((await stat(path)).size).toBeGreaterThan(0);
  return path;
}

/** 与 `audiobook-export.ts` 的私有 `concatFileLine` 同形：单引号包裹并转义内部单引号。 */
function concatFileLine(processPath: string): string {
  return `file '${processPath.replaceAll("'", "'\\''")}'`;
}

/**
 * ebur128 汇总块（ffmpeg 9.0.2 实测）长这样：
 *
 *   Summary:
 *     Integrated loudness:
 *       I:         -16.0 LUFS
 *     …
 *     True peak:
 *       Peak:      -10.6 dBFS
 *
 * 计划里的 `/I:\s+(...)\s+LUFS/` 会先命中 ebur128 的逐帧统计行（首帧是初值 -70.0 LUFS，
 * 是假读数）；`True peak:` 之后紧跟的是 `Peak:` 子标签而不是数字，原式恒不匹配。
 * 两条都改成锚定汇总小标题——只修解析，不改门限：仍是 [-17, -15] LUFS 与 ≤ -1.4 dBTP。
 */
function integratedLoudnessOf(stderr: string): number | null {
  return numberOrNull(/Integrated loudness:\s+I:\s+(-?\d+(?:\.\d+)?)\s+LUFS/u.exec(stderr)?.[1]);
}

function truePeakOf(stderr: string): number | null {
  return numberOrNull(/True peak:\s+Peak:\s+(-?\d+(?:\.\d+)?)\s+dBFS/u.exec(stderr)?.[1]);
}

function numberOrNull(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** 期望的 SRT 时间行（`HH:MM:SS,mmm`）：这里独立复算一次，用来核对 `formatSrt` 的输出。 */
function srtStamp(ms: number): string {
  const pad = (value: number, width: number): string => String(value).padStart(width, "0");
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1_000);
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)},${pad(ms % 1_000, 3)}`;
}

/** 期望的 LRC 时间标签（`[mm:ss.xx]`）。 */
function lrcStamp(ms: number): string {
  const pad = (value: number, width: number): string => String(value).padStart(width, "0");
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1_000);
  return `[${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(Math.floor((ms % 1_000) / 10), 2)}]`;
}

describe("audiobook 真实 ffmpeg 验收", () => {
  it("`.m4b` 是受支持的媒体类型，`/oh-story/media` 能按 Range 送出", () => {
    const path = "有声剧/长夜行/音频/全书.m4b";
    expect(mediaMimeTypeForPath(path)).toBe("audio/mp4");
    expect(mediaMimeTypeForPath("有声剧/长夜行/发布/全书.M4B")).toBe("audio/mp4");
    // `assertCreativePath` 是媒体 Range 服务的路径闸门：415/403 不过就没法播放。
    expect(() => assertCreativePath(path, "media")).not.toThrow();
  });

  it.skipIf(!realToolsReady)(`混音母带 + 两遍 loudnorm 达到 -16 LUFS 目标（${SKIP_REASON}）`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "dsh-audiobook-ffmpeg-mix-"));
    try {
      const voicePaths: string[] = [];
      for (const [index, frequencyHz] of VOICE_HZ.entries()) {
        voicePaths.push(await makeTone(directory, `voice-${String(index + 1)}.wav`, frequencyHz, VOICE_SECONDS, VOICE_VOLUME));
      }
      const bgmPath = await makeTone(directory, "bgm.wav", 220, BGM_SECONDS, BGM_VOLUME);

      // 时间轴用 ffprobe 实测时长构建，和导出链路同源。
      const durations = new Map<string, number>();
      for (const [index, segment] of SCRIPT.segments.entries()) {
        const path = voicePaths[index];
        if (path === undefined) throw new Error(`缺少旁白素材 ${String(index)}`);
        durations.set(segment.id, await measuredDurationMs(path));
      }
      const timeline: TimedSegment[] = buildTimeline(SCRIPT, durations);
      const last = timeline.at(-1);
      if (last === undefined) throw new Error("时间轴为空。");
      const chapterEndMs = last.endMs;
      const window = cueWindow(MUSIC_CUE, "music", timeline, chapterEndMs, 0);
      const cue: MixCue = {
        id: MUSIC_CUE.id,
        kind: "music",
        assetPath: bgmPath,
        startMs: window.startMs,
        endMs: window.endMs,
        fadeInMs: MUSIC_CUE.fadeInMs,
        fadeOutMs: MUSIC_CUE.fadeOutMs,
        gainDb: MUSIC_CUE.gainDb,
        duckDb: MUSIC_CUE.duckDb,
      };

      const masterPath = join(directory, "master.wav");
      await runOrThrow("ffmpeg", buildMixArgs({ voicePaths, timeline, chapterEndMs, cues: [cue], outputPath: masterPath }).args);
      expect((await stat(masterPath)).size).toBeGreaterThan(0);
      const masterMs = await measuredDurationMs(masterPath);
      expect(Math.abs(masterMs - chapterEndMs)).toBeLessThanOrEqual(DURATION_TOLERANCE_MS);

      const measure = await runOrThrow("ffmpeg", buildLoudnormMeasureArgs(masterPath));
      const measurement = parseLoudnormMeasurement(measure.stderr);
      expect(measurement.inputI).toBeLessThan(0);
      expect(measurement.inputTp).toBeLessThanOrEqual(0);

      const normalizedPath = join(directory, "normalized.wav");
      await runOrThrow("ffmpeg", buildLoudnormApplyArgs(masterPath, normalizedPath, measurement));
      expect((await stat(normalizedPath)).size).toBeGreaterThan(0);
      const normalizedMs = await measuredDurationMs(normalizedPath);
      expect(Math.abs(normalizedMs - chapterEndMs)).toBeLessThanOrEqual(DURATION_TOLERANCE_MS);

      const ebur128 = await runOrThrow("ffmpeg", [
        "-hide_banner", "-nostats",
        "-i", normalizedPath,
        "-af", "ebur128=peak=true",
        "-f", "null", "-",
      ]);
      const integrated = integratedLoudnessOf(ebur128.stderr);
      const truePeak = truePeakOf(ebur128.stderr);
      if (integrated === null) throw new Error(`ebur128 没测出综合响度：${ebur128.stderr.slice(-500)}`);
      if (truePeak === null) throw new Error(`ebur128 没测出真峰值：${ebur128.stderr.slice(-500)}`);
      expect(integrated).toBeGreaterThanOrEqual(-17);
      expect(integrated).toBeLessThanOrEqual(-15);
      expect(truePeak).toBeLessThanOrEqual(-1.4);

      // 字幕走同一条实测时间轴：每段的字幕必须铺满自身窗口且行间连续，段与段之间
      // 留出 `DEFAULT_PAUSE_MS` 的停顿（不是首尾相接）。
      const cues = buildSubtitleCues(timeline, SCRIPT);
      expect(cues.length).toBeGreaterThanOrEqual(2);
      expect(cues[0]?.startMs).toBe(0);
      expect(cues.at(-1)?.endMs).toBe(chapterEndMs);
      for (const segment of timeline) {
        const segmentCues = cues.filter((item) => item.startMs >= segment.startMs && item.endMs <= segment.endMs);
        expect(segmentCues.length).toBeGreaterThan(0);
        expect(segmentCues[0]?.startMs).toBe(segment.startMs);
        expect(segmentCues.at(-1)?.endMs).toBe(segment.endMs);
        for (const [index, cueItem] of segmentCues.entries()) {
          if (index === 0) continue;
          expect(cueItem.startMs).toBe(segmentCues[index - 1]?.endMs);
        }
      }
      const srt = formatSrt(cues);
      const srtTimeLines = srt.split("\n").filter((line) => line.includes(" --> "));
      expect(srtTimeLines).toHaveLength(cues.length);
      expect(srtTimeLines[0]).toBe(`${srtStamp(0)} --> ${srtStamp(cues[0]?.endMs ?? 0)}`);
      expect(srt).toContain(` --> ${srtStamp(chapterEndMs)}`);
      const lrc = formatLrc(cues);
      expect(lrc.startsWith(lrcStamp(0))).toBe(true);
      expect(lrc.split("\n").filter((line) => /^\[\d{2}:\d{2}\.\d{2}\].+/u.test(line))).toHaveLength(cues.length);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 180_000);

  it.skipIf(!realToolsReady)(`M4B 合成：两章章节表 + attached_pic 封面流（${SKIP_REASON}）`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "dsh-audiobook-ffmpeg-m4b-"));
    try {
      const chapterOne = await makeChapterMp3(directory, "chapter-1.mp3", 440);
      const chapterTwo = await makeChapterMp3(directory, "chapter-2.mp3", 550);
      const coverPath = join(directory, "cover.jpg");
      await runOrThrow("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "color=black:s=1x1:d=0.04",
        "-frames:v", "1",
        coverPath,
      ]);
      expect((await stat(coverPath)).size).toBeGreaterThan(0);

      const chapterOneMs = await measuredDurationMs(chapterOne);
      const chapterTwoMs = await measuredDurationMs(chapterTwo);
      const chapters: M4bChapter[] = [
        { title: "第一章 起点", startMs: 0, endMs: chapterOneMs },
        { title: "第二章 回声", startMs: chapterOneMs, endMs: chapterOneMs + chapterTwoMs },
      ];

      const concatListPath = join(directory, "concat.txt");
      await writeFile(concatListPath, `${concatFileLine(chapterOne)}\n${concatFileLine(chapterTwo)}\n`, "utf8");
      const metadataPath = join(directory, "chapters.txt");
      const metadata = buildFfmetadata(chapters);
      await writeFile(metadataPath, metadata, "utf8");
      expect(metadata.startsWith(";FFMETADATA1\n")).toBe(true);

      const bookPath = join(directory, "全书.m4b");
      await runOrThrow("ffmpeg", buildM4bArgs({
        concatListPath,
        metadataPath,
        coverPath,
        outputPath: bookPath,
        title: "长夜行",
      }));
      expect((await stat(bookPath)).size).toBeGreaterThan(0);

      const chapterProbe = await runOrThrow("ffprobe", ["-v", "error", "-show_chapters", "-of", "json", bookPath]);
      const probed = JSON.parse(chapterProbe.stdout) as { chapters?: { id: number; tags?: Record<string, string> }[] };
      const probedChapters = probed.chapters ?? [];
      expect(probedChapters).toHaveLength(2);
      expect(probedChapters.map((chapter) => chapter.tags?.title)).toEqual(["第一章 起点", "第二章 回声"]);

      const streamProbe = await runOrThrow("ffprobe", ["-v", "error", "-show_streams", "-of", "json", bookPath]);
      const streams = (JSON.parse(streamProbe.stdout) as {
        streams: { codec_type: string; disposition?: Record<string, number> }[];
      }).streams;
      const attached = streams.filter((stream) => stream.disposition?.attached_pic === 1);
      expect(attached).toHaveLength(1);
      expect(attached[0]?.codec_type).toBe("video");
      expect(streams.filter((stream) => stream.codec_type === "audio")).toHaveLength(1);
      // ffmpeg 9 实测容器里还有第三条 `data` 轨——mov muxer 存放章节表的 chapter track，
      // 正是 `-show_chapters` 能读出两章的原因，不当作多余媒体流断言。

      const bookMs = await measuredDurationMs(bookPath);
      expect(Math.abs(bookMs - (chapterOneMs + chapterTwoMs))).toBeLessThanOrEqual(120);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 180_000);
});
