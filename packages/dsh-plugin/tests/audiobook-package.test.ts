// tests/audiobook-package.test.ts
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AudiobookManifest, AudiobookManifestFile, AudiobookProjectRecord } from "../src/services/audiobook-contract.js";
import { manifestChecksum, releaseDirectoryFor, writeReleaseManifest } from "../src/services/audiobook-package.js";
import { WorkspaceHttpError } from "../src/workspace-route.js";
import { memoryRealm, SANDBOX_POLICY } from "./audiobook-fixtures.js";

const PROJECT = "有声剧/长夜行/project.json";

const project = (): AudiobookProjectRecord => ({
  path: PROJECT,
  version: "v7",
  project: {
    schemaVersion: 1,
    source: { bookRoot: "正文", chapters: ["正文/第0001章.md"] },
    tts: { baseUrl: "https://api.example.com/v1", model: "tts-1", responseFormat: "mp3", speed: 1, pricePerMillionChars: 15, maxCharsPerChapter: 20_000, concurrency: 2 },
    cast: [
      { id: "narrator", name: "旁白", kind: "narrator", voice: "alloy" },
      { id: "hero", name: "沈砚", kind: "character", voice: "echo" },
    ],
    cues: [],
    export: { mp3BitrateKbps: 192, sampleRate: 44_100, channels: 2, loudnessLufs: -16, truePeakDbtp: -1.5, subtitles: [] },
    rights: { voiceCloning: false },
  },
});

const cost = { chars: 1_200, requests: 3, estimatedCost: 0.02 };

const releaseFile = (name: string, sha256 = "a".repeat(64)): AudiobookManifestFile => ({
  path: `发布/${name}`,
  bytes: 1_024,
  sha256,
  durationMs: 1_000,
});

const chapters = [
  { index: 1, title: "第0001章", audio: "发布/第0001章.mp3", subtitles: ["发布/第0001章.srt"] },
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

describe("audiobook package", () => {
  it("清单校验和按路径排序后对 path\\0sha256 拼接再哈希", () => {
    const files = [
      { path: "发布/第0002章.mp3", sha256: "b".repeat(64) },
      { path: "发布/第0001章.mp3", sha256: "a".repeat(64) },
    ];
    const expected = createHash("sha256")
      .update(`发布/第0001章.mp3\u0000${"a".repeat(64)}\n发布/第0002章.mp3\u0000${"b".repeat(64)}`, "utf8")
      .digest("hex");
    expect(manifestChecksum(files)).toBe(expected);
    expect(manifestChecksum([...files].reverse())).toBe(expected);
  });

  it("写入发布清单：工作区路径、排序文件、cast 与默认空数组", async () => {
    const { realm, read, writeCalls, writes } = memoryRealm();
    const files = [releaseFile("第0002章.mp3", "b".repeat(64)), releaseFile("第0001章.mp3", "a".repeat(64))];
    const result = await writeReleaseManifest(realm, project(), { files, chapters, cost });
    expect(result.path).toBe("有声剧/长夜行/发布/发布清单.json");
    expect(writes).toEqual(["有声剧/长夜行/发布/发布清单.json"]);
    expect(writeCalls[0]?.sandboxPolicy).toBe(SANDBOX_POLICY);
    const content = read(result.path);
    expect(content).toBeDefined();
    expect(content?.endsWith("\n")).toBe(true);
    const manifest = JSON.parse(content ?? "") as AudiobookManifest;
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.book).toBe("长夜行");
    expect(manifest.projectVersion).toBe("v7");
    expect(typeof manifest.generatedAt).toBe("number");
    expect(manifest.cast).toEqual([
      { id: "narrator", name: "旁白", voice: "alloy" },
      { id: "hero", name: "沈砚", voice: "echo" },
    ]);
    expect(manifest.files.map((file) => [file.path, file.sha256])).toEqual([
      ["发布/第0001章.mp3", "a".repeat(64)],
      ["发布/第0002章.mp3", "b".repeat(64)],
    ]);
    expect(manifest.checksum).toBe(manifestChecksum(files));
    expect(manifest.licenses).toEqual([]);
    expect(manifest.providerReceipts).toEqual([]);
    expect(manifest.chapters).toEqual(chapters);
    expect(manifest.cost).toEqual(cost);
    expect(result.manifest).toEqual(manifest);
  });

  it("重复文件路径返回 422", async () => {
    const { realm } = memoryRealm();
    await expect(writeReleaseManifest(realm, project(), {
      files: [releaseFile("第0001章.mp3"), releaseFile("第0001章.mp3", "b".repeat(64))],
      chapters: [],
      cost,
    })).rejects.toMatchObject({ status: 422 });
  });

  it("发布文件路径必须位于 发布/ 下的包内相对路径", async () => {
    const { realm } = memoryRealm();
    const filesOutside = [
      "音频/第0001章.mp3",
      "发布/../音频/第0001章.mp3",
      "/发布/第0001章.mp3",
      "C:发布/第0001章.mp3",
      "发布\\第0001章.mp3",
    ];
    for (const path of filesOutside) {
      await expect(writeReleaseManifest(realm, project(), {
        files: [{ ...releaseFile("第0001章.mp3"), path }],
        chapters: [],
        cost,
      })).rejects.toMatchObject({ status: 400 });
    }
  });

  it("提供的清单校验和不一致时返回 422，一致时放行并记录 licenses/回执", async () => {
    const files = [releaseFile("第0001章.mp3")];
    const licenses = [{ path: "发布/主题曲.mp3", license: "CC-BY-4.0", attribution: "作者 / 来源链接" }];
    const providerReceipts = [
      { id: "music-1", model: "suno-v4", promptSha256: "c".repeat(64), receiptId: "r-1", generatedAt: 1 },
    ];
    const mismatch = memoryRealm();
    await expect(writeReleaseManifest(mismatch.realm, project(), {
      files,
      chapters: [],
      cost,
      checksum: "0".repeat(64),
    })).rejects.toMatchObject({ status: 422 });
    expect(mismatch.writes).toEqual([]);

    const matching = memoryRealm();
    const result = await writeReleaseManifest(matching.realm, project(), {
      files,
      chapters: [],
      cost,
      licenses,
      providerReceipts,
      checksum: manifestChecksum(files),
    });
    const manifest = JSON.parse(matching.read(result.path) ?? "") as AudiobookManifest;
    expect(manifest.checksum).toBe(manifestChecksum(files));
    expect(manifest.licenses).toEqual(licenses);
    expect(manifest.providerReceipts).toEqual(providerReceipts);
  });

  it("校验 sha256、字节数与时长", async () => {
    const { realm } = memoryRealm();
    const invalid: readonly AudiobookManifestFile[] = [
      { ...releaseFile("第0001章.mp3"), sha256: "A".repeat(64) },
      { ...releaseFile("第0001章.mp3"), sha256: "a".repeat(63) },
      { ...releaseFile("第0001章.mp3"), bytes: -1 },
      { ...releaseFile("第0001章.mp3"), bytes: 1.5 },
      { ...releaseFile("第0001章.mp3"), durationMs: -1 },
      { ...releaseFile("第0001章.mp3"), durationMs: Number.POSITIVE_INFINITY },
    ];
    for (const file of invalid) {
      await expect(writeReleaseManifest(realm, project(), { files: [file], chapters: [], cost }))
        .rejects.toMatchObject({ status: 400 });
    }
  });

  it("清单超过 512 KiB 时返回 413 且不落盘", async () => {
    const { realm, writes } = memoryRealm();
    const files = Array.from({ length: 6_000 }, (_, index) => releaseFile(`第${String(index).padStart(5, "0")}章.mp3`));
    await expect(writeReleaseManifest(realm, project(), { files, chapters: [], cost }))
      .rejects.toMatchObject({ status: 413 });
    expect(writes).toEqual([]);
  });

  it("发布目录固定为 有声剧/<书>/发布，非规范项目路径返回 400", () => {
    expect(releaseDirectoryFor(PROJECT)).toBe("有声剧/长夜行/发布");
    expect(rejectionStatus(() => releaseDirectoryFor("正文/长夜行/project.json"))).toBe(400);
    expect(rejectionStatus(() => releaseDirectoryFor("有声剧/../project.json"))).toBe(400);
    expect(rejectionStatus(() => releaseDirectoryFor("有声剧/长夜行/项目.json"))).toBe(400);
    expect(rejectionStatus(() => releaseDirectoryFor("有声剧/长夜行/子目录/project.json"))).toBe(400);
  });
});
