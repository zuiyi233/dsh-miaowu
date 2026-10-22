// tests/audiobook-assets.test.ts
import { describe, expect, it } from "vitest";
import { memoryRealm } from "./audiobook-fixtures.js";
import {
  assertCuesAuthorized,
  listAudiobookAssets,
  saveAssetAuthorizations,
} from "../src/services/audiobook-assets.js";
import type { AudiobookProjectRecord } from "../src/services/audiobook-contract.js";

const PROJECT = "有声剧/长夜行/project.json";
const project = (): AudiobookProjectRecord => ({
  path: PROJECT,
  version: "v1",
  project: {
    schemaVersion: 1,
    source: { bookRoot: "正文", chapters: ["正文/第0001章.md"] },
    tts: { baseUrl: "https://api.example.com/v1", model: "tts-1", responseFormat: "mp3", speed: 1, pricePerMillionChars: 15, maxCharsPerChapter: 20_000, concurrency: 2 },
    cast: [{ id: "narrator", name: "旁白", kind: "narrator", voice: "alloy" }],
    cues: [],
    export: { mp3BitrateKbps: 192, sampleRate: 44_100, channels: 2, loudnessLufs: -16, truePeakDbtp: -1.5, subtitles: [] },
    rights: { voiceCloning: false },
  },
});

describe("audiobook assets", () => {
  it("扫描音乐/音效，只有授权条目才算 authorized", async () => {
    const { realm } = memoryRealm({
      "有声剧/长夜行/素材/音乐/theme.mp3": "ID3",
      "有声剧/长夜行/素材/音效/whoosh.wav": "RIFF",
      "有声剧/长夜行/素材/音乐/notes.txt": "不是音频",
    });
    const view = await listAudiobookAssets(realm, project());
    expect(view.assets.map((asset) => [asset.kind, asset.path, asset.authorized])).toEqual([
      ["effect", "有声剧/长夜行/素材/音效/whoosh.wav", false],
      ["music", "有声剧/长夜行/素材/音乐/theme.mp3", false],
    ]);
    expect(view.authorizationVersion).toBeNull();
  });

  it("授权保存做 CAS，拒绝越界路径与空许可证", async () => {
    const { realm } = memoryRealm({
      "有声剧/长夜行/素材/音乐/theme.mp3": "ID3",
    });
    const saved = await saveAssetAuthorizations(realm, project(), {
      schemaVersion: 1,
      assets: [{ path: "有声剧/长夜行/素材/音乐/theme.mp3", source: "本地购买", license: "CC-BY-4.0", allowedUse: ["audiobook", "commercial"], attribution: "作者" }],
    }, null);
    expect(saved.version).not.toBe("");
    expect(saved.document.assets).toHaveLength(1);
    expect((await listAudiobookAssets(realm, project())).assets[0]?.authorized).toBe(true);
    await expect(saveAssetAuthorizations(realm, project(), saved.document, saved.version)).resolves.toBeDefined();
    await expect(saveAssetAuthorizations(realm, project(), saved.document, "stale")).rejects.toMatchObject({ status: 412 });
    await expect(saveAssetAuthorizations(realm, project(), {
      schemaVersion: 1,
      assets: [{ path: "正文/逃逸.mp3", source: "x", license: "x", allowedUse: ["audiobook"], attribution: "" }],
    }, saved.version)).rejects.toMatchObject({ status: 400 });
    await expect(saveAssetAuthorizations(realm, project(), {
      schemaVersion: 1,
      assets: [{ path: "有声剧/长夜行/素材/音乐/theme.mp3", source: "x", license: "", allowedUse: ["audiobook"], attribution: "" }],
    }, saved.version)).rejects.toMatchObject({ status: 422 });
  });

  it("cue 引用缺失/未授权素材时阻断", async () => {
    const { realm } = memoryRealm({ "有声剧/长夜行/素材/音乐/theme.mp3": "ID3" });
    const record = {
      ...project(),
      project: {
        ...project().project,
        cues: [{
          id: "cue-1", chapter: "第0001章", asset: "有声剧/长夜行/素材/音乐/theme.mp3",
          startSegment: "s-1", offsetMs: 0, fadeInMs: 0, fadeOutMs: 0, gainDb: -6, duckDb: -12,
        }],
      },
    };
    const scripts = new Map([["第0001章", { schemaVersion: 1 as const, chapter: "第0001章", sourcePath: "正文/第0001章.md", sourceSha256: "0".repeat(64), segments: [{ id: "s-1", kind: "narration" as const, speakerId: "narrator", text: "你好。", sourceStart: 0, sourceEnd: 3 }] }]]);
    await expect(assertCuesAuthorized(record.project, await listAudiobookAssets(realm, record), scripts))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining("未授权") });
  });
});
