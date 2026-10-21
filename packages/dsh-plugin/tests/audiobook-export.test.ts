import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FsTarget } from "@deepseek-ai/dsh-fs";
import { describe, expect, it, vi } from "vitest";
import {
  hostBinaryFileStore,
  memoryBinaryFileStore,
  type BinaryFileStore,
  type MemoryBinaryFileStore,
} from "../src/services/audiobook-binary.js";
import { segmentAudioPath, ttsCacheKey } from "../src/services/audiobook-cache.js";
import type {
  AudiobookProject,
  AudiobookProjectRecord,
  AudiobookScript,
} from "../src/services/audiobook-contract.js";
import {
  exportChapterMp3,
  hostCommandRunner,
  probeTool,
  type AudiobookExportRuntime,
  type CommandResult,
  type CommandRunOptions,
  type CommandRunner,
} from "../src/services/audiobook-export.js";
import { WorkspaceHttpError, type WorkspaceRealm } from "../src/workspace-route.js";
import { memoryRealm } from "./audiobook-fixtures.js";

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
  source: { bookRoot: "正文", chapters: ["正文/第0001章_开篇.md"] },
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
  chapter: "第0001章_开篇",
  sourcePath: "正文/第0001章_开篇.md",
  sourceSha256: "0".repeat(64),
  segments: [
    { id: "s-1", kind: "narration", speakerId: "narrator", text: "你好。", sourceStart: 0, sourceEnd: 3 },
    { id: "s-2", kind: "narration", speakerId: "narrator", text: "世界。", sourceStart: 3, sourceEnd: 6 },
  ],
};

const CHAPTER = "第0001章_开篇";
const RECORD_PATH = "有声剧/长夜行/project.json";
const FINAL_PATH = "有声剧/长夜行/音频/第0001章_开篇.mp3";
const TEMP_PREFIX = ".oh-story/audiobook/tmp/";

function cacheKeyFor(text: string, format: "mp3" | "wav" = "mp3"): string {
  return ttsCacheKey({
    baseUrl: TTS.baseUrl,
    model: TTS.model,
    voice: "alloy",
    speed: TTS.speed,
    responseFormat: format,
    text,
  });
}

interface Fixture {
  readonly realm: WorkspaceRealm;
  readonly binary: MemoryBinaryFileStore;
  readonly runtime: AudiobookExportRuntime;
  readonly calls: string[][];
  readonly lists: string[];
  readonly record: AudiobookProjectRecord;
  readonly script: AudiobookScript;
}

function fixture(
  options: { readonly responseFormat?: "mp3" | "wav"; readonly run?: CommandRunner["run"] } = {},
): Fixture {
  const format = options.responseFormat ?? "mp3";
  const project: AudiobookProject = { ...PROJECT, tts: { ...TTS, responseFormat: format } };
  const { realm } = memoryRealm();
  const binary = memoryBinaryFileStore();
  for (const segment of SCRIPT.segments) {
    binary.files.set(segmentAudioPath(cacheKeyFor(segment.text, format), format), new Uint8Array([1, 2, 3]));
  }
  const calls: string[][] = [];
  const lists: string[] = [];
  const defaultRun: CommandRunner["run"] = async (command, args) => {
    if (command === "ffmpeg") {
      const listPath = args[args.indexOf("-i") + 1];
      if (listPath !== undefined) {
        const bytes = binary.files.get(listPath);
        lists.push(bytes === undefined ? "" : new TextDecoder().decode(bytes));
      }
      const output = args.at(-1);
      if (output !== undefined) binary.files.set(output, new Uint8Array([0x49, 0x44, 0x33]));
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "12.5\n", stderr: "" };
  };
  const run = options.run ?? defaultRun;
  const runner: CommandRunner = {
    run: async (command, args, runOptions) => {
      calls.push([command, ...args]);
      return await run(command, args, runOptions);
    },
  };
  return {
    realm,
    binary,
    runtime: { binary, runner },
    calls,
    lists,
    record: { project, path: RECORD_PATH, version: "v1" },
    script: SCRIPT,
  };
}

function runtimeWith(binary: BinaryFileStore, run: CommandRunner["run"]): AudiobookExportRuntime {
  return { binary, runner: { run } };
}

function tempFiles(binary: MemoryBinaryFileStore): string[] {
  return [...binary.files.keys()].filter((path) => path.startsWith(TEMP_PREFIX));
}

async function failureOf(promise: Promise<unknown>): Promise<WorkspaceHttpError> {
  try {
    await promise;
  } catch (error) {
    return error as WorkspaceHttpError;
  }
  throw new Error("预期导出失败，但实际成功了。");
}

describe("exportChapterMp3", () => {
  it("导出调用 concat demuxer 并返回时长", async () => {
    const { realm, runtime, calls, record, script, binary } = fixture();
    const result = await exportChapterMp3(realm, record, CHAPTER, script, runtime);

    expect(calls[0]?.[0]).toBe("ffmpeg");
    expect(calls[0]).toContain("-f");
    expect(calls[0]).toContain("concat");
    expect(calls[1]?.[0]).toBe("ffprobe");
    expect(result.durationMs).toBe(12_500);
    expect(result.bytes).toBe(3);
    expect(result.path).toBe(FINAL_PATH);
    expect(binary.files.has(FINAL_PATH)).toBe(true);
    expect(tempFiles(binary)).toEqual([]);
  });

  it("ffmpeg 参数固定为 concat 清单与 192k MP3，输出先写临时文件", async () => {
    const { realm, runtime, calls, record, script } = fixture();

    await exportChapterMp3(realm, record, CHAPTER, script, runtime);

    const args = calls[0] ?? [];
    expect(args[0]).toBe("ffmpeg");
    expect(args).toContain("-hide_banner");
    expect(args[args.indexOf("-loglevel") + 1]).toBe("error");
    expect(args[args.indexOf("-f") + 1]).toBe("concat");
    expect(args[args.indexOf("-safe") + 1]).toBe("0");
    expect(args[args.indexOf("-i") + 1]?.startsWith(TEMP_PREFIX)).toBe(true);
    expect(args[args.indexOf("-i") + 1]?.endsWith(".txt")).toBe(true);
    expect(args[args.indexOf("-c:a") + 1]).toBe("libmp3lame");
    expect(args[args.indexOf("-b:a") + 1]).toBe("192k");
    const output = args.at(-1) ?? "";
    expect(output.startsWith(TEMP_PREFIX)).toBe(true);
    expect(output).not.toBe(FINAL_PATH);
    expect(calls[1]?.at(-1)).toBe(output);
  });

  it("concat 清单每段一行，并转义路径里的单引号", async () => {
    const { realm, binary, runtime, record, script, lists } = fixture();
    const quotingBinary: BinaryFileStore = {
      ...binary,
      processPath: (target) => target.displayPath.replace("/cache/", "/it's-cache/"),
    };

    await exportChapterMp3(realm, record, CHAPTER, script, { binary: quotingBinary, runner: runtime.runner });

    const content = lists[0] ?? "";
    const lines = content.split("\n").filter((line) => line !== "");
    expect(lines).toHaveLength(SCRIPT.segments.length);
    for (const line of lines) {
      expect(line.startsWith("file '")).toBe(true);
      expect(line.endsWith("'")).toBe(true);
    }
    expect(content.endsWith("\n")).toBe(true);
    expect(content).toContain("it'\\''s-cache");
    expect(content).not.toContain("it's-cache");
  });

  it("缺段缓存时拒绝导出", async () => {
    const { realm, runtime, binary, calls, record, script } = fixture();
    binary.files.clear();

    await expect(exportChapterMp3(realm, record, CHAPTER, script, runtime))
      .rejects.toMatchObject({ status: 409, message: "第0001章_开篇还没有完整生成。" });
    expect(calls).toHaveLength(0);
    expect(tempFiles(binary)).toEqual([]);
  });

  it("缓存音频为零字节时同样视为未生成", async () => {
    const { realm, runtime, binary, record, script } = fixture();
    binary.files.set(segmentAudioPath(cacheKeyFor("世界。"), "mp3"), new Uint8Array());

    await expect(exportChapterMp3(realm, record, CHAPTER, script, runtime))
      .rejects.toMatchObject({ status: 409 });
  });

  it("ffmpeg 失败时返回 500，且不留最终文件与临时文件", async () => {
    const { realm, binary, record, script } = fixture();
    const runtime = runtimeWith(binary, async (command, args) => {
      if (command !== "ffmpeg") return { code: 0, stdout: "1", stderr: "" };
      const output = args.at(-1);
      if (output !== undefined) binary.files.set(output, new Uint8Array([0x49, 0x44, 0x33]));
      return { code: 1, stdout: "", stderr: "Invalid data found when processing input" };
    });

    const error = await failureOf(exportChapterMp3(realm, record, CHAPTER, script, runtime));

    expect(error).toBeInstanceOf(WorkspaceHttpError);
    expect(error.status).toBe(500);
    expect(error.message).toContain("ffmpeg 导出失败");
    expect(error.message).toContain("Invalid data found when processing input");
    expect(binary.files.has(FINAL_PATH)).toBe(false);
    expect(tempFiles(binary)).toEqual([]);
  });

  it("ffprobe 时长不是有限数字时返回 500，且不留最终文件", async () => {
    const { realm, binary, record, script } = fixture();
    const runtime = runtimeWith(binary, async (command, args) => {
      if (command === "ffmpeg") {
        const output = args.at(-1);
        if (output !== undefined) binary.files.set(output, new Uint8Array([0x49, 0x44, 0x33]));
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "N/A\n", stderr: "" };
    });

    const error = await failureOf(exportChapterMp3(realm, record, CHAPTER, script, runtime));

    expect(error).toBeInstanceOf(WorkspaceHttpError);
    expect(error.status).toBe(500);
    expect(error.message).toContain("ffprobe");
    expect(binary.files.has(FINAL_PATH)).toBe(false);
    expect(tempFiles(binary)).toEqual([]);
  });

  it("ffmpeg 超时返回 504，并带 10 分钟超时", async () => {
    const { realm, binary, record, script } = fixture();
    const seen: { command: string; timeoutMs: number | undefined }[] = [];
    const runtime: AudiobookExportRuntime = {
      binary,
      runner: {
        run: async (command, _args, options) => {
          seen.push({ command, timeoutMs: options?.timeoutMs });
          throw new Error("命令超时（600s）：ffmpeg");
        },
      },
    };

    const error = await failureOf(exportChapterMp3(realm, record, CHAPTER, script, runtime));

    expect(error.status).toBe(504);
    expect(error.message).toContain("ffmpeg 执行超时");
    expect(seen).toEqual([{ command: "ffmpeg", timeoutMs: 600_000 }]);
    expect(binary.files.has(FINAL_PATH)).toBe(false);
    expect(tempFiles(binary)).toEqual([]);
  });

  it("ffprobe 超时返回 504，且探测使用 30 秒超时", async () => {
    const { realm, binary, record, script } = fixture();
    const seen: { command: string; timeoutMs: number | undefined }[] = [];
    const runtime: AudiobookExportRuntime = {
      binary,
      runner: {
        run: async (command, args, options) => {
          seen.push({ command, timeoutMs: options?.timeoutMs });
          if (command === "ffmpeg") {
            const output = args.at(-1);
            if (output !== undefined) binary.files.set(output, new Uint8Array([0x49, 0x44, 0x33]));
            return { code: 0, stdout: "", stderr: "" };
          }
          throw new Error("命令超时（30s）：ffprobe");
        },
      },
    };

    const error = await failureOf(exportChapterMp3(realm, record, CHAPTER, script, runtime));

    expect(error.status).toBe(504);
    expect(error.message).toContain("ffprobe 执行超时");
    expect(seen).toEqual([
      { command: "ffmpeg", timeoutMs: 600_000 },
      { command: "ffprobe", timeoutMs: 30_000 },
    ]);
    expect(binary.files.has(FINAL_PATH)).toBe(false);
    expect(tempFiles(binary)).toEqual([]);
  });

  it("ffmpeg 报错里的绝对路径被抹成占位符", async () => {
    const { realm, binary, record, script } = fixture();
    const runtime: AudiobookExportRuntime = {
      binary,
      runner: {
        run: async (command) => (command === "ffmpeg"
          ? {
            code: 1,
            stdout: "",
            stderr: "cannot open C:\\Program Files\\Git\\bin\\ffmpeg.exe: No such file; /home/alice/audio/a.mp3: Invalid data; D:\\media\\books\\a b.mp3: not found; C:\\cache\\a.mp3:Missing input; \\\\srv\\Team Share\\a.mp3: access denied",
          }
          : { code: 0, stdout: "1", stderr: "" }),
      },
    };

    const error = await failureOf(exportChapterMp3(realm, record, CHAPTER, script, runtime));

    expect(error.status).toBe(500);
    expect(error.message).toContain("ffmpeg 导出失败");
    expect(error.message).toContain("[路径]");
    // 路径后面的诊断信息必须保留，否则 500 只剩一个占位符。
    expect(error.message).toContain("No such file");
    expect(error.message).toContain("Invalid data");
    expect(error.message).toContain("not found");
    expect(error.message).toContain("Missing input");
    expect(error.message).toContain("access denied");
    expect(error.message).not.toContain("alice");
    expect(error.message).not.toContain("/home");
    expect(error.message).not.toContain("Program Files");
    expect(error.message).not.toContain("Git");
    expect(error.message).not.toContain("media");
    expect(error.message).not.toContain("cache");
    expect(error.message).not.toContain("Team Share");
    expect(error.message).not.toContain("b.mp3");
  });

  it("拒绝不安全的章节名", async () => {
    const { realm, runtime, calls, record, script } = fixture();

    for (const chapter of ["", "..", "../第0001章_开篇", "第0001章/开篇", "第0001章\\开篇"]) {
      await expect(exportChapterMp3(realm, record, chapter, script, runtime))
        .rejects.toMatchObject({ status: 400 });
    }
    expect(calls).toHaveLength(0);
  });

  it("项目路径不在有声剧目录下时拒绝导出", async () => {
    const { realm, runtime, calls, record, script } = fixture();

    await expect(exportChapterMp3(realm, { ...record, path: "正文/长夜行/project.json" }, CHAPTER, script, runtime))
      .rejects.toMatchObject({ status: 403 });
    expect(calls).toHaveLength(0);
  });
});

describe("probeTool", () => {
  it("命令成功时返回 true 并带 5 秒超时", async () => {
    const run = vi.fn(
      async (
        command: string,
        args: readonly string[],
        options?: CommandRunOptions,
      ): Promise<CommandResult> => {
        expect(command).toBe("ffmpeg");
        expect(args).toEqual(["-version"]);
        expect(options).toEqual({ timeoutMs: 5_000 });
        return { code: 0, stdout: "ffmpeg version 7", stderr: "" };
      },
    );

    expect(await probeTool({ run }, "ffmpeg")).toBe(true);
  });

  it("探测参数是单横线 -version，不是双横线 --version", async () => {
    const run = vi.fn(
      async (
        command: string,
        args: readonly string[],
        options?: CommandRunOptions,
      ): Promise<CommandResult> => {
        expect(command).toBe("ffprobe");
        expect(args).toEqual(["-version"]);
        expect(args).not.toContain("--version");
        expect(options).toEqual({ timeoutMs: 5_000 });
        return { code: 0, stdout: "ffprobe version 7", stderr: "" };
      },
    );

    expect(await probeTool({ run }, "ffprobe")).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("probeTool 在命令失败时返回 false", async () => {
    expect(await probeTool({ run: async () => ({ code: 1, stdout: "", stderr: "no" }) }, "ffmpeg")).toBe(false);
  });

  it("命令无法启动时返回 false", async () => {
    expect(await probeTool({ run: () => Promise.reject(new Error("spawn ENOENT")) }, "ffprobe")).toBe(false);
  });

  it("命令挂起时超时返回 false", async () => {
    vi.useFakeTimers();
    try {
      const pending = probeTool({ run: () => new Promise<CommandResult>(() => undefined) }, "ffmpeg");
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(pending).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("hostCommandRunner", () => {
  it("收集 stdout/stderr 并原样返回退出码", async () => {
    const result = await hostCommandRunner().run(process.execPath, [
      "-e",
      "process.stdout.write('ok'); process.stderr.write('warn')",
    ]);

    expect(result).toEqual({ code: 0, stdout: "ok", stderr: "warn" });
  });

  it("命令不存在时拒绝", async () => {
    await expect(hostCommandRunner().run("dsh-miaowu-definitely-missing-tool", ["--version"]))
      .rejects.toThrow(/无法启动命令/u);
  });

  it("超时会终止子进程并拒绝", async () => {
    await expect(hostCommandRunner().run(process.execPath, ["-e", "setTimeout(() => undefined, 30_000)"], { timeoutMs: 50 }))
      .rejects.toThrow(/超时/u);
  });
});

// 真实 ffmpeg/ffprobe 用例：本机没有安装时不安装、不失败，只显式跳过。
const realToolsReady =
  (await probeTool(hostCommandRunner(), "ffmpeg")) && (await probeTool(hostCommandRunner(), "ffprobe"));
const REAL_SKIP_REASON = "本机缺少 ffmpeg/ffprobe，跳过真实导出用例";

function hostRealm(directory: string): WorkspaceRealm {
  const fs = {
    resolve: async (path: string): Promise<FsTarget> => ({
      targetKey: path.replace(/^\/+/u, "") as FsTarget["targetKey"],
      displayPath: path.replace(/^\/+/u, ""),
    }),
    contains: (parent: FsTarget, child: FsTarget): boolean =>
      parent.displayPath === ""
      || child.displayPath === parent.displayPath
      || child.displayPath.startsWith(`${parent.displayPath}/`),
    processPath: (target: FsTarget): string => join(directory, target.displayPath),
  };
  return {
    fs: fs as unknown as WorkspaceRealm["fs"],
    cwd: directory,
    root: { targetKey: "" as FsTarget["targetKey"], displayPath: "" },
    agent: { session: {} },
    sandboxPolicy: { resolve: () => ({}) },
  } as unknown as WorkspaceRealm;
}

/** 生成一小段静音 PCM WAV，供真实 ffmpeg concat 使用（不依赖外部素材）。 */
function silenceWav(durationSeconds: number, sampleRate = 8_000): Uint8Array {
  const samples = Math.round(durationSeconds * sampleRate);
  const dataBytes = samples * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) bytes[offset + index] = text.charCodeAt(index);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  return bytes;
}

it.skipIf(!realToolsReady)(`真实 ffmpeg 合成整章 MP3（${REAL_SKIP_REASON}）`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "audiobook-export-"));
  try {
    const realm = hostRealm(directory);
    const binary = hostBinaryFileStore(realm);
    for (const segment of SCRIPT.segments) {
      const target = await realm.fs.resolve(segmentAudioPath(cacheKeyFor(segment.text, "wav"), "wav"), { cwd: realm.cwd });
      await binary.prepare(target);
      await binary.write(target, silenceWav(0.25));
    }
    const record: AudiobookProjectRecord = {
      project: { ...PROJECT, tts: { ...TTS, responseFormat: "wav" } },
      path: RECORD_PATH,
      version: "v1",
    };

    const result = await exportChapterMp3(realm, record, CHAPTER, SCRIPT, { binary, runner: hostCommandRunner() });

    expect(result.path).toBe(FINAL_PATH);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThan(300);
    expect(result.durationMs).toBeLessThan(900);
    const finalTarget = await realm.fs.resolve(FINAL_PATH, { cwd: realm.cwd });
    expect((await binary.stat(finalTarget))?.size).toBe(result.bytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
