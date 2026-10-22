import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ComfyUiMusicProvider,
  LocalAssetProvider,
  bookDirectoryForProject,
  defaultAssetProviders,
  workspaceRelativeGeneratedPath,
  type AudioAssetGenerationRequest,
  type AudioAssetProvider,
  type ComfyuiAudioPort,
  type ComfyuiAudioPortInput,
  type ComfyuiAudioPortResult,
} from "../src/services/audiobook-asset-provider.js";
import type { AudiobookProjectRecord } from "../src/services/audiobook-contract.js";
import { memoryRealm } from "./audiobook-fixtures.js";

const PROJECT_PATH = "有声剧/长夜行/project.json";
const MUSIC_DIR = "有声剧/长夜行/素材/音乐";
const EFFECT_DIR = "有声剧/长夜行/素材/音效";

const REQUEST: AudioAssetGenerationRequest = {
  kind: "music",
  prompt: "雨夜的城市",
  durationSeconds: 12,
  count: 1,
};

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function projectRecord(): AudiobookProjectRecord {
  return {
    path: PROJECT_PATH,
    version: "v1",
    project: {
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
    },
  };
}

interface FakePort extends ComfyuiAudioPort {
  readonly calls: ComfyuiAudioPortInput[];
}

function fakePort(
  files: (input: ComfyuiAudioPortInput, index: number) => readonly { readonly path: string; readonly bytes: number }[],
): FakePort {
  const calls: ComfyuiAudioPortInput[] = [];
  return {
    calls,
    async generate(input): Promise<ComfyuiAudioPortResult> {
      calls.push(input);
      return {
        files: files(input, calls.length - 1),
        promptIds: [`prompt-${String(calls.length)}`],
        durationMs: 10,
      };
    },
  };
}

describe("ComfyUiMusicProvider", () => {
  it("生成音乐素材：回执含 sha256/首个 promptId，cost 0，文件名前缀受控", async () => {
    const { realm } = memoryRealm();
    const port = fakePort((input, index) => [{ path: `${input.outputDir}/theme-${String(index)}.mp3`, bytes: 128 }]);
    const provider: AudioAssetProvider = new ComfyUiMusicProvider({ port, configured: true });

    const result = await provider.generate(realm, projectRecord(), { ...REQUEST, count: 2 });

    expect(provider.id).toBe("comfyui");
    expect(provider.label).toBe("ComfyUI");
    expect(provider.configured).toBe(true);
    expect(provider.estimate(REQUEST)).toBe(0);
    expect(result.cost).toBe(0);
    expect(result.provider).toBe("comfyui");
    expect(result.model).not.toBe("");
    expect(result.promptSha256).toBe(sha256(REQUEST.prompt));
    expect(result.files).toEqual([
      { path: `${MUSIC_DIR}/theme-0.mp3`, bytes: 128 },
      { path: `${MUSIC_DIR}/theme-1.mp3`, bytes: 128 },
    ]);
    expect(port.calls.map((call) => call.outputDir)).toEqual([MUSIC_DIR, MUSIC_DIR]);
    expect(port.calls[0]?.durationSeconds).toBe(REQUEST.durationSeconds);
    expect(port.calls[0]?.timeoutSeconds).toBeGreaterThan(0);
    expect(port.calls[0]?.filenamePrefix).toBe(`asset-music-${result.promptSha256.slice(0, 8)}-1`);
    expect(result.receiptId).toBe("prompt-1");
  });

  it("count > 1 时前缀逐次加序号，生成的文件互不覆盖", async () => {
    const { realm } = memoryRealm();
    const written = new Map<string, number>();
    const port = fakePort((input) => {
      const path = `${input.outputDir}/${input.filenamePrefix}.mp3`;
      written.set(path, (written.get(path) ?? 0) + 1);
      return [{ path, bytes: 64 }];
    });
    const provider = new ComfyUiMusicProvider({ port, configured: true });

    const result = await provider.generate(realm, projectRecord(), { ...REQUEST, count: 2 });

    const prefix = `asset-music-${sha256(REQUEST.prompt).slice(0, 8)}`;
    expect(result.files.map((file) => file.path)).toEqual([
      `${MUSIC_DIR}/${prefix}-1.mp3`,
      `${MUSIC_DIR}/${prefix}-2.mp3`,
    ]);
    expect(new Set(result.files.map((file) => file.path)).size).toBe(2);
    expect([...written.values()]).toEqual([1, 1]);
  });

  it("音效输出到素材/音效目录", async () => {
    const { realm } = memoryRealm();
    const port = fakePort((input) => [{ path: `${input.outputDir}/whoosh.ogg`, bytes: 64 }]);
    const provider = new ComfyUiMusicProvider({ port, configured: true });

    const result = await provider.generate(realm, projectRecord(), {
      kind: "effect",
      prompt: "一阵风",
      durationSeconds: 2,
      count: 1,
    });

    expect(result.files).toEqual([{ path: `${EFFECT_DIR}/whoosh.ogg`, bytes: 64 }]);
    expect(port.calls[0]?.filenamePrefix).toBe(`asset-effect-${result.promptSha256.slice(0, 8)}-1`);
  });

  it("port 返回目录外、错误扩展名或绝对路径的文件一律 403", async () => {
    const { realm } = memoryRealm();
    const outside = new ComfyUiMusicProvider({
      port: fakePort(() => [{ path: "正文/逃逸.mp3", bytes: 1 }]),
      configured: true,
    });
    await expect(outside.generate(realm, projectRecord(), REQUEST)).rejects.toMatchObject({ status: 403 });

    const otherKind = new ComfyUiMusicProvider({
      port: fakePort(() => [{ path: `${EFFECT_DIR}/whoosh.mp3`, bytes: 1 }]),
      configured: true,
    });
    await expect(otherKind.generate(realm, projectRecord(), REQUEST)).rejects.toMatchObject({ status: 403 });

    const wrongExtension = new ComfyUiMusicProvider({
      port: fakePort(() => [{ path: `${MUSIC_DIR}/theme.txt`, bytes: 1 }]),
      configured: true,
    });
    await expect(wrongExtension.generate(realm, projectRecord(), REQUEST)).rejects.toMatchObject({ status: 403 });

    const absolute = new ComfyUiMusicProvider({
      port: fakePort(() => [{ path: `${MUSIC_DIR}/../音乐/theme.mp3`, bytes: 1 }]),
      configured: true,
    });
    await expect(absolute.generate(realm, projectRecord(), REQUEST)).rejects.toMatchObject({ status: 403 });
  });
});

describe("workspaceRelativeGeneratedPath", () => {
  it("工作区内的绝对路径转换成正斜杠相对路径", () => {
    expect(workspaceRelativeGeneratedPath(
      "E:\\books\\demo",
      "E:\\books\\demo\\有声剧\\长夜行\\素材\\音乐\\asset-music-abc-1.mp3",
    )).toBe("有声剧/长夜行/素材/音乐/asset-music-abc-1.mp3");
    expect(workspaceRelativeGeneratedPath("/books/demo/", "/books/demo/有声剧/x.mp3")).toBe("有声剧/x.mp3");
    // Windows 路径大小写不敏感：盘符与目录大小写不同也算同一个根。
    expect(workspaceRelativeGeneratedPath("E:/books/demo", "e:/Books/Demo/y.mp3")).toBe("y.mp3");
  });

  it("工作区根之外的绝对路径一律 403", async () => {
    const cases: readonly (readonly [string, string])[] = [
      ["E:\\books\\demo", "E:\\books\\other\\a.mp3"],
      ["E:\\books\\demo", "D:\\books\\demo\\a.mp3"],
      ["/books/demo", "/books/demo2/a.mp3"],
      ["/books/demo", "/books/other/a.mp3"],
      ["/books/demo", "/books/demo/../secret/a.mp3"],
      ["/books/demo", "/books/demo"],
      ["", "/books/demo/a.mp3"],
    ];
    for (const [root, path] of cases) {
      await expect(
        Promise.resolve().then(() => workspaceRelativeGeneratedPath(root, path)),
        `${root} -> ${path}`,
      ).rejects.toMatchObject({ status: 403 });
    }
  });

  it("已是工作区相对路径的原样返回", () => {
    const relative = `${MUSIC_DIR}/asset-music-abc-1.mp3`;
    expect(workspaceRelativeGeneratedPath("E:\\books\\demo", relative)).toBe(relative);
  });
});

describe("LocalAssetProvider", () => {
  it("始终配置可用、估价 0，但不支持生成（400）", async () => {
    const { realm } = memoryRealm();
    const provider: AudioAssetProvider = new LocalAssetProvider();
    expect(provider.id).toBe("local");
    expect(provider.label).toBe("本地素材库");
    expect(provider.configured).toBe(true);
    expect(provider.estimate(REQUEST)).toBe(0);
    await expect(provider.generate(realm, projectRecord(), REQUEST)).rejects.toMatchObject({ status: 400 });
  });
});

describe("defaultAssetProviders", () => {
  it("恒含 local 与 comfyui，configured 取决于环境变量或工作区配置", async () => {
    const { realm } = memoryRealm();

    const unconfigured = await defaultAssetProviders(realm, {}, { readConfig: async () => ({}) });
    expect(unconfigured.map((provider) => provider.id)).toEqual(["local", "comfyui"]);
    expect(unconfigured[0]?.configured).toBe(true);
    expect(unconfigured[1]?.configured).toBe(false);

    const envConfigured = await defaultAssetProviders(realm, { COMFYUI_WORKFLOW: "music.json" }, {
      readConfig: async () => ({}),
    });
    expect(envConfigured[1]?.configured).toBe(true);

    const fileConfigured = await defaultAssetProviders(realm, {}, {
      readConfig: async () => ({ workflow: "music.json" }),
    });
    expect(fileConfigured[1]?.configured).toBe(true);

    const dirConfigured = await defaultAssetProviders(realm, {}, {
      readConfig: async () => ({ workflowDir: "workflows" }),
    });
    expect(dirConfigured[1]?.configured).toBe(true);
  });
});

describe("项目路径规则", () => {
  function expectBadRequest(path: string): void {
    try {
      bookDirectoryForProject(path);
      throw new Error(`应当拒绝项目路径：${path}`);
    } catch (error) {
      expect(error).toMatchObject({ status: 400 });
    }
  }

  it("只接受 有声剧/<book>/project.json", () => {
    expect(bookDirectoryForProject("有声剧/长夜行/project.json")).toBe("有声剧/长夜行");
    for (const path of [
      "正文/长夜行/project.json",
      "有声剧/长夜行/子目录/project.json",
      "有声剧/长夜行/其他.json",
      "/有声剧/长夜行/project.json",
      "C:/有声剧/长夜行/project.json",
      "有声剧/../project.json",
    ]) {
      expectBadRequest(path);
    }
  });
});
