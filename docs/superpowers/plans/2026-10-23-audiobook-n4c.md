# 有声剧 N4-C 完整有声剧 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 N4-B 多角色章节音频之上，加入本地 BGM/音效与授权、cue 时间轴、双通道响度归一、SRT/LRC、M4B 章节与封面、可复算的发布包清单，全部通过显式确认与 ffmpeg 预检。

**Architecture:** 音频渲染拆成纯函数层（时间轴、混音参数、字幕文本、清单校验）与窄执行层（ffprobe/ffmpeg 命令、缓存、原子写）。服务层只读写 `有声剧/<书>/` 与 `.oh-story/audiobook/`，不写 DSH 会话、`workspace.json` 或 `~/.dsh`。素材授权与生成回执独立保存在 `素材/授权.json`，cue 继续复用 `project.json` 的既有字段。

**Tech Stack:** TypeScript 24、`@deepseek-ai/dsh-fs` realm 缝、Node `child_process`（数组参数、无 shell）、ffmpeg/ffprobe、React 工作台面板、Vitest。

**Spec:** `docs/superpowers/specs/2026-10-21-audiobook-roadmap-design.md` 第 4、6、7、8、9、10、11 节（N4-C 验收门）。

## Global Constraints

- 所有路径必须是工作区相对路径；拒绝绝对路径、盘符、反斜杠、空段、`.`、`..` 与控制字符。
- ffmpeg/ffprobe 一律用数组参数调用，禁止 shell 拼接；stderr 只截尾并脱敏绝对路径。
- 付费 TTS 与外部素材生成必须 `confirm: true`；无密钥、无授权、缺封面、悬空 cue、缺段时提前失败，不写半成品。
- 发布包清单必须可本地复算：文件 sha256 + 按路径排序后的 `path\0sha256` 拼接再 sha256。
- 不写 DSH 会话持久化、`workspace.json`、`~/.dsh`；不新增数据库或 SQLite。
- 浏览器包保持 ≤ 400,000 字节；`pnpm verify`、双宿主冒烟全绿。
- 本计划默认采用三个决策：**安装 ffmpeg/ffprobe 做真实验证**、**发布包用目录而非 zip**、**外部生成先实现 ComfyUI 适配器但默认关闭**。开工前用户可改。

---

### Task 0: 环境与分支

**Files:** 无源码改动。

**Interfaces:** 无。

- [ ] **Step 1: 确认/安装 ffmpeg 与 ffprobe**

Windows 上使用 winget：

```bash
winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements
```

安装后新开 shell 或把安装目录加入当前进程 PATH，验证：

```bash
ffmpeg -version
ffprobe -version
```

预期：两条命令都退出 0，且 `ffmpeg -encoders` 包含 `libmp3lame` 与 `aac`。

- [ ] **Step 2: 建功能分支**

```bash
git switch -c feat/audiobook-n4c
```

- [ ] **Step 3: 记录基线**

```bash
pnpm verify
```

预期：退出 0；记录测试文件数、通过数与 `packages/dsh-plugin/lib/client.js` 字节数到 `.tmp/n4c-baseline.log`。

- [ ] **Step 4: 不提交（环境步骤无仓库改动）**

---

### Task 1: 素材目录、授权文档与校验

**Files:**
- Modify: `packages/dsh-plugin/src/services/audiobook-contract.ts`
- Create: `packages/dsh-plugin/src/services/audiobook-assets.ts`
- Test: `packages/dsh-plugin/tests/audiobook-assets.test.ts`

**Interfaces:**
- Produces:
  - `AUDIOBOOK_ASSET_DIRECTORIES = { music: "素材/音乐", effect: "素材/音效" }`
  - `AUDIOBOOK_AUTHORIZATION_FILE = "素材/授权.json"`
  - `AudiobookAssetKind = "music" | "effect"`
  - `AudiobookAssetAuthorization`
  - `AudiobookAssetView`
  - `listAudiobookAssets(realm, project: AudiobookProjectRecord): Promise<AudiobookAssetView>`
  - `loadAssetAuthorizations(realm, projectPath): Promise<AudiobookAuthorizationRecord | undefined>`
  - `saveAssetAuthorizations(realm, project, doc, baseVersion: string | null): Promise<AudiobookAuthorizationRecord>`
  - `assertCuesAuthorized(project, assets, scripts: ReadonlyMap<string, AudiobookScript>): void`

- [ ] **Step 1: 写失败测试**

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd packages/dsh-plugin && npx vitest run tests/audiobook-assets.test.ts
```

预期：模块不存在，FAIL。

- [ ] **Step 3: 实现契约类型**

在 `audiobook-contract.ts` 追加：

```ts
export type AudiobookAssetKind = "music" | "effect";
export type AudiobookAssetUse = "audiobook" | "commercial";

export interface AudiobookAssetProviderReceipt {
  readonly id: string;
  readonly model: string;
  readonly promptSha256: string;
  readonly receiptId: string | null;
  readonly generatedAt: number;
}

export interface AudiobookAssetAuthorization {
  readonly path: string;
  readonly source: string;
  readonly license: string;
  readonly allowedUse: readonly AudiobookAssetUse[];
  readonly attribution: string;
  readonly provider?: AudiobookAssetProviderReceipt;
}

export interface AudiobookAssetAuthorizationDocument {
  readonly schemaVersion: 1;
  readonly assets: readonly AudiobookAssetAuthorization[];
}

export interface AudiobookAuthorizationRecord {
  readonly document: AudiobookAssetAuthorizationDocument;
  readonly path: string;
  readonly version: string;
}

export interface AudiobookAsset {
  readonly path: string;
  readonly kind: AudiobookAssetKind;
  readonly bytes: number;
  readonly authorized: boolean;
  readonly license: string | null;
}

export interface AudiobookAssetView {
  readonly assets: readonly AudiobookAsset[];
  readonly authorizationVersion: string | null;
  readonly providers: readonly { readonly id: string; readonly label: string; readonly configured: boolean }[];
}
```

- [ ] **Step 4: 实现 `audiobook-assets.ts`**

要点：
- `ASSET_DIRECTORIES` 用 `AudiobookAssetKind` 映射；扫描 `listDir`，只收 `.mp3|.wav|.ogg`，`stat` 必须是文件，路径必须在项目目录下。
- 授权文档校验：`schemaVersion === 1`；每条 `path` 必须位于 `有声剧/<book>/素材/` 且被扫描到；`source`/`license` 非空；`allowedUse` 非空且只含 `audiobook|commercial`；`attribution` 可以是空字符串；`path` 不重复。
- `loadAssetAuthorizations` 用 `readVersionedFile`；缺失返回 `undefined`；坏 JSON/schema 返回 422。
- `saveAssetAuthorizations`：`baseVersion === null` 用 `createIfAbsent`，否则 `replaceIfVersion`；写前做 512 KiB 上限与沙箱策略；CAS 冲突 412。
- `assertCuesAuthorized(project, assets, scripts)`：对每个 cue 检查 `scripts.get(cue.chapter)`、`startSegment` 存在、资产在 `assets` 里且 `authorized` 且 `allowedUse` 含 `"audiobook"`；任何一项失败 409，错误中列出 cue id 与原因。
- 生成 provider 列表先返回空数组（Task 9 注入），保证契约稳定。

- [ ] **Step 5: 运行测试**

```bash
cd packages/dsh-plugin && npx vitest run tests/audiobook-assets.test.ts
```

预期：PASS。

- [ ] **Step 6: 提交**

```bash
git add packages/dsh-plugin/src/services/audiobook-contract.ts packages/dsh-plugin/src/services/audiobook-assets.ts packages/dsh-plugin/tests/audiobook-assets.test.ts
git commit -m "feat(audiobook): 增加素材授权与 cue 校验"
```

---

### Task 2: 时间轴与 cue 窗口

**Files:**
- Create: `packages/dsh-plugin/src/services/audiobook-timeline.ts`
- Test: `packages/dsh-plugin/tests/audiobook-timeline.test.ts`

**Interfaces:**
- Produces:
  - `DEFAULT_PAUSE_MS = 120`
  - `TimedSegment { segmentId; startMs; endMs; durationMs }`
  - `buildTimeline(script, durations: ReadonlyMap<string, number>): TimedSegment[]`
  - `cueWindow(cue, kind: AudiobookAssetKind, timeline, chapterEndMs, assetDurationMs): { startMs; endMs }`
  - `assertCueWindow(cue, window, chapterEndMs): void`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest";
import { buildTimeline, cueWindow, DEFAULT_PAUSE_MS } from "../src/services/audiobook-timeline.js";
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
});
```

- [ ] **Step 2: 运行确认失败**

```bash
cd packages/dsh-plugin && npx vitest run tests/audiobook-timeline.test.ts
```

- [ ] **Step 3: 实现纯函数**

```ts
export const DEFAULT_PAUSE_MS = 120;

export interface TimedSegment {
  readonly segmentId: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly durationMs: number;
}

export function buildTimeline(script: AudiobookScript, durations: ReadonlyMap<string, number>): TimedSegment[] {
  const timeline: TimedSegment[] = [];
  let cursor = 0;
  for (const segment of script.segments) {
    const durationMs = durations.get(segment.id);
    if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs <= 0) {
      throw new WorkspaceHttpError(409, `片段 ${segment.id} 缺少有效的实测时长，请先生成音频。`);
    }
    const startMs = cursor;
    const endMs = startMs + Math.round(durationMs);
    timeline.push({ segmentId: segment.id, startMs, endMs, durationMs: Math.round(durationMs) });
    cursor = endMs + DEFAULT_PAUSE_MS;
  }
  return timeline;
}

export function cueWindow(cue: AudiobookCue, kind: AudiobookAssetKind, timeline: readonly TimedSegment[], chapterEndMs: number, assetDurationMs: number): { startMs: number; endMs: number } {
  if (cue.offsetMs < 0) throw new WorkspaceHttpError(400, `cue ${cue.id} 的偏移不能为负。`);
  const anchor = timeline.find((segment) => segment.segmentId === cue.startSegment);
  if (anchor === undefined) throw new WorkspaceHttpError(409, `cue ${cue.id} 引用的片段 ${cue.startSegment} 不存在。`);
  const startMs = anchor.startMs + cue.offsetMs;
  if (startMs >= chapterEndMs) throw new WorkspaceHttpError(409, `cue ${cue.id} 的起点越过章末。`);
  const endMs = kind === "music" ? chapterEndMs : Math.min(startMs + Math.max(0, Math.round(assetDurationMs)), chapterEndMs);
  if (endMs <= startMs) throw new WorkspaceHttpError(409, `cue ${cue.id} 的时间窗为空。`);
  return { startMs, endMs };
}
```

- [ ] **Step 4: 运行测试**

```bash
cd packages/dsh-plugin && npx vitest run tests/audiobook-timeline.test.ts
```

- [ ] **Step 5: 提交**

```bash
git add packages/dsh-plugin/src/services/audiobook-timeline.ts packages/dsh-plugin/tests/audiobook-timeline.test.ts
git commit -m "feat(audiobook): 增加 cue 时间轴计算"
```

---

### Task 3: 实测时长缓存与二进制 hash/copy

**Files:**
- Modify: `packages/dsh-plugin/src/services/audiobook-binary.ts`
- Create: `packages/dsh-plugin/src/services/audiobook-duration.ts`
- Test: `packages/dsh-plugin/tests/audiobook-duration.test.ts`

**Interfaces:**
- Produces:
  - `BinaryFileStore.hash(target: FsTarget): Promise<string | undefined>`
  - `BinaryFileStore.copy(from: FsTarget, to: FsTarget): Promise<void>`
  - `measureCachedSegmentDuration(realm, runtime: { readonly binary: BinaryFileStore; readonly runner: CommandRunner }, cacheKey, ext): Promise<number>`
  - `measureAudioDuration(runtime: { readonly binary: BinaryFileStore; readonly runner: CommandRunner }, realm, target): Promise<number>`
  - `AUDIOBOOK_DURATION_ROOT = ".oh-story/audiobook/durations"`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest";
import { memoryBinaryFileStore } from "../src/services/audiobook-binary.js";
import { measureCachedSegmentDuration } from "../src/services/audiobook-duration.js";
import { segmentAudioPath } from "../src/services/audiobook-cache.js";
import { memoryRealm } from "./audiobook-fixtures.js";
import type { CommandRunner } from "../src/services/audiobook-export.js";

const KEY = "a".repeat(64);
const runtime = (durations: string[], calls: string[]): { binary: ReturnType<typeof memoryBinaryFileStore>; runner: CommandRunner } => ({
  binary: memoryBinaryFileStore(),
  runner: { run: async (command, args) => { calls.push([command, ...args].join(" ")); return { code: 0, stdout: durations.shift() ?? "", stderr: "" }; } },
});

describe("duration cache", () => {
  it("首次 ffprobe，第二次读缓存不再调用 ffprobe", async () => {
    const { realm } = memoryRealm();
    const binary = memoryBinaryFileStore();
    binary.files.set(segmentAudioPath(KEY, "mp3"), new Uint8Array([1]));
    const calls: string[] = [];
    const rt = { ...runtime(["12.5\n"], calls), binary };
    expect(await measureCachedSegmentDuration(realm, rt, KEY, "mp3")).toBe(12_500);
    expect(await measureCachedSegmentDuration(realm, rt, KEY, "mp3")).toBe(12_500);
    expect(calls).toHaveLength(1);
  });

  it("缺缓存音频返回 409，坏时长返回 500", async () => {
    const { realm } = memoryRealm();
    const binary = memoryBinaryFileStore();
    const calls: string[] = [];
    await expect(measureCachedSegmentDuration(realm, { ...runtime([], calls), binary }, KEY, "mp3"))
      .rejects.toMatchObject({ status: 409 });
    binary.files.set(segmentAudioPath(KEY, "mp3"), new Uint8Array([1]));
    await expect(measureCachedSegmentDuration(realm, { ...runtime(["not-a-number\n"], calls), binary }, KEY, "mp3"))
      .rejects.toMatchObject({ status: 500 });
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
cd packages/dsh-plugin && npx vitest run tests/audiobook-duration.test.ts
```

- [ ] **Step 3: 扩展二进制存储**

在 `BinaryFileStore` 接口追加：

```ts
hash(target: FsTarget): Promise<string | undefined>;
copy(from: FsTarget, to: FsTarget): Promise<void>;
```

宿主实现：

```ts
hash: async (target) => {
  const path = realm.fs.processPath(target);
  const info = await stat(path).catch(() => undefined);
  if (info === undefined || !info.isFile()) return undefined;
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
},
copy: async (from, to) => {
  await mkdir(dirname(realm.fs.processPath(to)), { recursive: true });
  await copyFile(realm.fs.processPath(from), realm.fs.processPath(to));
},
```

内存实现按字节 `sha256`/`slice`。补一个 `audiobook-binary.test.ts` 用例断言 hash 稳定、copy 不改源。

- [ ] **Step 4: 实现时长缓存**

要点：
- 时长文档固定 `.oh-story/audiobook/durations/<cacheKey>.json`，schemaVersion 1，字段 `cacheKey`、`durationMs`、`probedAt`。
- 缓存键必须是 64 位小写 hex；解析后必须仍在 duration 根内。
- 优先读缓存；坏 JSON/键不符视为 miss，重新 ffprobe。
- ffprobe 参数固定：
  `-v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 <path>`
- 解析 `Number.parseFloat(stdout.trim())`；非有限或 `<0` → 500。
- 写缓存用 `createIfAbsent`，并发冲突时重读已有值；写入带沙箱策略。
- `measureAudioDuration` 用于素材文件，直接 ffprobe，不写缓存。

- [ ] **Step 5: 运行测试**

```bash
cd packages/dsh-plugin && npx vitest run tests/audiobook-duration.test.ts tests/audiobook-binary.test.ts
```

- [ ] **Step 6: 提交**

```bash
git add packages/dsh-plugin/src/services/audiobook-binary.ts packages/dsh-plugin/src/services/audiobook-duration.ts packages/dsh-plugin/tests/audiobook-duration.test.ts packages/dsh-plugin/tests/audiobook-binary.test.ts
git commit -m "feat(audiobook): 增加实测时长缓存与二进制 hash"
```

---

### Task 4: 混音参数与双通道响度

**Files:**
- Create: `packages/dsh-plugin/src/services/audiobook-mix.ts`
- Test: `packages/dsh-plugin/tests/audiobook-mix.test.ts`

**Interfaces:**
- Produces:
  - `MixCue { id; kind; assetPath; startMs; endMs; fadeInMs; fadeOutMs; gainDb; duckDb }`
  - `buildMixArgs(input): { args: string[]; filterGraph: string }`
  - `buildLoudnormMeasureArgs(inputPath): string[]`
  - `parseLoudnormMeasurement(stderr): { inputI; inputTp; inputLra; inputThresh; targetOffset }`
  - `buildLoudnormApplyArgs(inputPath, outputPath, measured): string[]`

- [ ] **Step 1: 写失败测试**

```ts
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
```

- [ ] **Step 2: 运行确认失败**

```bash
cd packages/dsh-plugin && npx vitest run tests/audiobook-mix.test.ts
```

- [ ] **Step 3: 实现参数构造器**

要点：
- 输入顺序：每个 voice 文件一个 `-i`；每个 cue 资产一个 `-i`（音乐加 `-stream_loop -1`，音效不加）。
- 图中每个 voice 输入先 `aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo`；除最后一段外加 `apad=pad_dur=0.12`；然后 `concat=n=<voiceCount>:v=0:a=1[voice]`。
- 每个 cue 的链路必须逐项生成，下面是 Task 4 测试输入的完整目标形状（实现必须产出同样的字符串）：

```text
[0:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,apad=pad_dur=0.12[v0];
[1:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[v1];
[v0][v1]concat=n=2:v=0:a=1[voice];
[2:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=0:3.12,asetpts=PTS-STARTPTS,adelay=1000|1000,afade=t=in:st=0:d=0.5,afade=t=out:st=2.12:d=1,volume=-6dB,volume=volume='if(between(t,0,1)+between(t,1.12,3.12),0.251188643150958,1)':eval=frame[bgm2];
[voice][bgm2]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mix]
```

  - `voiceIntervals` 是 `between(t,startSec,endSec)` 用 `+` 连接。
  - `duckFactor = Math.pow(10, duckDb / 20)`，保留完整浮点字符串。
- 混合：有 cue 时 `[voice][bgm...]amix=inputs=N:duration=first:dropout_transition=0:normalize=0[mix]`；无 cue 时 `[voice]anull[mix]`。所有输出 `[mix]`。
- 输出固定 `-ar 44100 -ac 2 -c:a pcm_s16le <output>`。
- 任何负数 fade/越界 cue 在构造前返回 400/409，不生成半截图。

- [ ] **Step 4: 运行测试**

```bash
cd packages/dsh-plugin && npx vitest run tests/audiobook-mix.test.ts
```

- [ ] **Step 5: 提交**

```bash
git add packages/dsh-plugin/src/services/audiobook-mix.ts packages/dsh-plugin/tests/audiobook-mix.test.ts
git commit -m "feat(audiobook): 增加混音与响度参数构造"
```

---

### Task 5: SRT/LRC 字幕

**Files:**
- Create: `packages/dsh-plugin/src/services/audiobook-subtitles.ts`
- Test: `packages/dsh-plugin/tests/audiobook-subtitles.test.ts`

**Interfaces:**
- Produces:
  - `MAX_SUBTITLE_CHARS = 42`
  - `buildSubtitleCues(timeline, script): readonly { startMs; endMs; text }[]`
  - `formatSrt(cues): string`
  - `formatLrc(cues): string`
  - `subtitlePathsFor(projectPath, chapter): { srt: string; lrc: string }`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest";
import { buildSubtitleCues, formatLrc, formatSrt } from "../src/services/audiobook-subtitles.js";
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
});
```

- [ ] **Step 2: 运行确认失败**

```bash
cd packages/dsh-plugin && npx vitest run tests/audiobook-subtitles.test.ts
```

- [ ] **Step 3: 实现**

- `buildSubtitleCues`：逐个时间轴段找脚本段；文本按 `，。！？；、,.!?;` 贪心切分，单块超过 42 字再硬切；每块时长 = 段时长 * 块字符数 / 总字符数，最后一块吸收舍入误差；空文本跳过。
- `formatSrt`：序号从 1，时间 `HH:MM:SS,mmm`，条目之间空行，文件尾一个换行。
- `formatLrc`：`[mm:ss.xx]text`，分钟可超过 59，两位数毫秒截断。
- `subtitlePathsFor`：`有声剧/<book>/字幕/<chapter>.srt|lrc`，章节名同样禁止路径分隔符。
- 导出服务负责写文件，本模块不碰 fs。

- [ ] **Step 4: 运行测试**

```bash
cd packages/dsh-plugin && npx vitest run tests/audiobook-subtitles.test.ts
```

- [ ] **Step 5: 提交**

```bash
git add packages/dsh-plugin/src/services/audiobook-subtitles.ts packages/dsh-plugin/tests/audiobook-subtitles.test.ts
git commit -m "feat(audiobook): 增加 SRT/LRC 字幕生成"
```

---

### Task 6: M4B 章节与封面

**Files:**
- Create: `packages/dsh-plugin/src/services/audiobook-m4b.ts`
- Test: `packages/dsh-plugin/tests/audiobook-m4b.test.ts`

**Interfaces:**
- Produces:
  - `buildFfmetadata(chapters: readonly { title; startMs; endMs }[]): string`
  - `buildM4bArgs(input): string[]`
  - `assertCover(realm, projectPath): Promise<string>`（返回 `封面/cover.jpg` 相对路径）
  - `bookM4bPathFor(projectPath): string`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest";
import { buildFfmetadata, buildM4bArgs, assertCover } from "../src/services/audiobook-m4b.js";
import { memoryRealm } from "./audiobook-fixtures.js";

const chapters = [
  { title: "第0001章", startMs: 0, endMs: 1_000 },
  { title: "第0002章", startMs: 1_000, endMs: 3_000 },
];

describe("audiobook m4b", () => {
  it("ffmetadata 使用毫秒时间基与章节标题", () => {
    expect(buildFfmetadata(chapters)).toBe(";FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=1000\ntitle=第0001章\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=1000\nEND=3000\ntitle=第0002章\n");
  });

  it("M4B 参数嵌入封面、章节元数据与 AAC 128k", () => {
    const args = buildM4bArgs({
      concatListPath: "/tmp/list.txt", metadataPath: "/tmp/meta.txt", coverPath: "/tmp/cover.jpg",
      outputPath: "/tmp/全书.m4b", title: "长夜行",
    });
    expect(args).toContain("-f");
    expect(args[args.indexOf("-f") + 1]).toBe("concat");
    expect(args).toContain("-safe");
    expect(args[args.indexOf("-i") + 1]).toBe("/tmp/list.txt");
    expect(args).toContain("-f");
    expect(args).toContain("ffmetadata");
    expect(args[args.indexOf("-map_metadata") + 1]).toBe("2");
    expect(args).toContain("attached_pic");
    expect(args[args.indexOf("-c:a") + 1]).toBe("aac");
    expect(args[args.indexOf("-b:a") + 1]).toBe("128k");
    expect(args).toContain("+faststart");
    expect(args.at(-1)).toBe("/tmp/全书.m4b");
  });

  it("缺封面或封面为空时返回 409", async () => {
    const { realm } = memoryRealm({ "有声剧/长夜行/封面/cover.jpg": "" });
    await expect(assertCover(realm, "有声剧/长夜行/project.json")).rejects.toMatchObject({ status: 409 });
    const withCover = memoryRealm({ "有声剧/长夜行/封面/cover.jpg": "JPEG" });
    await expect(assertCover(withCover.realm, "有声剧/长夜行/project.json"))
      .resolves.toBe("有声剧/长夜行/封面/cover.jpg");
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
cd packages/dsh-plugin && npx vitest run tests/audiobook-m4b.test.ts
```

- [ ] **Step 3: 实现**

- `buildFfmetadata`：严格按上面的文本；标题里的换行/分号转义为空格（拒绝控制字符）。
- `buildM4bArgs`：
  ```
  -hide_banner -loglevel error -y -f concat -safe 0 -i <list> -i <cover> -f ffmetadata -i <meta>
  -map 0:a -map 1:v -map_metadata 2 -c:a aac -b:a 128k -c:v mjpeg -disposition:v attached_pic
  -metadata title=<title> -movflags +faststart <output>
  ```
- `assertCover`：`封面/cover.jpg` 必须存在、普通文件、`size > 0`；返回相对路径。缺失 409。
- `bookM4bPathFor`：`有声剧/<book>/音频/全书.m4b`。

- [ ] **Step 4: 运行测试**

```bash
cd packages/dsh-plugin && npx vitest run tests/audiobook-m4b.test.ts
```

- [ ] **Step 5: 提交**

```bash
git add packages/dsh-plugin/src/services/audiobook-m4b.ts packages/dsh-plugin/tests/audiobook-m4b.test.ts
git commit -m "feat(audiobook): 增加 M4B 章节与封面参数"
```

---

### Task 7: 发布包与可复算清单

**Files:**
- Create: `packages/dsh-plugin/src/services/audiobook-package.ts`
- Modify: `packages/dsh-plugin/src/services/audiobook-contract.ts`（manifest 类型）
- Test: `packages/dsh-plugin/tests/audiobook-package.test.ts`

**Interfaces:**
- Produces:
  - `AudiobookManifest`
  - `manifestChecksum(files): string`
  - `writeReleaseManifest(realm, project, input): Promise<{ path; manifest }>`
  - `releaseDirectoryFor(projectPath): string`

- [ ] **Step 1: 写失败测试**

```ts
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { manifestChecksum } from "../src/services/audiobook-package.js";

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
});
```

- [ ] **Step 2: 运行确认失败**

```bash
cd packages/dsh-plugin && npx vitest run tests/audiobook-package.test.ts
```

- [ ] **Step 3: 定义 manifest 契约**

```ts
export interface AudiobookManifestFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly durationMs: number | null;
}

export interface AudiobookManifest {
  readonly schemaVersion: 1;
  readonly generatedAt: number;
  readonly book: string;
  readonly projectVersion: string;
  readonly files: readonly AudiobookManifestFile[];
  readonly chapters: readonly { readonly index: number; readonly title: string; readonly audio: string | null; readonly subtitles: readonly string[] }[];
  readonly cast: readonly { readonly id: string; readonly name: string; readonly voice: string }[];
  readonly licenses: readonly { readonly path: string; readonly license: string; readonly attribution: string }[];
  readonly providerReceipts: readonly AudiobookAssetProviderReceipt[];
  readonly cost: { readonly chars: number; readonly requests: number; readonly estimatedCost: number };
  readonly checksum: string;
}
```

- [ ] **Step 4: 实现清单与原子写**

- `manifestChecksum(files)`：按 `path` 用 `localeCompare(..., "zh-Hans-CN")` 稳定排序，`path\0sha256` 用 `\n` 连接，再 sha256。
- `writeReleaseManifest`：校验每个文件在 `发布/` 下、sha256 64 hex、bytes ≥ 0；重复路径 422；`checksum` 复算一致；JSON 末尾换行；先写 `发布/发布清单.json.tmp-<uuid>` 再 `rename`；任何失败清理临时文件。清单作为发布包的提交标记，最后写。
- `releaseDirectoryFor`：`有声剧/<book>/发布`。

- [ ] **Step 5: 运行测试**

```bash
cd packages/dsh-plugin && npx vitest run tests/audiobook-package.test.ts
```

- [ ] **Step 6: 提交**

```bash
git add packages/dsh-plugin/src/services/audiobook-package.ts packages/dsh-plugin/src/services/audiobook-contract.ts packages/dsh-plugin/tests/audiobook-package.test.ts
git commit -m "feat(audiobook): 增加发布清单与校验和"
```

---

### Task 8: 导出编排、路由预检与外部素材 provider

**Files:**
- Modify: `packages/dsh-plugin/src/services/audiobook-export.ts`
- Modify: `packages/dsh-plugin/src/services/audiobook-route.ts`
- Modify: `packages/dsh-plugin/src/services/audiobook-contract.ts`（routes/response）
- Create: `packages/dsh-plugin/src/services/audiobook-asset-provider.ts`
- Test: `packages/dsh-plugin/tests/audiobook-export-full.test.ts`
- Test: `packages/dsh-plugin/tests/audiobook-asset-provider.test.ts`
- Test: `packages/dsh-plugin/tests/audiobook-route.test.ts`（追加）

**Interfaces:**
- Produces:
  - `AUDIOBOOK_ROUTES.assets = "/oh-story/audiobook/assets"`
  - `AUDIOBOOK_ROUTES.assetsGenerate = "/oh-story/audiobook/assets/generate"`
  - `AudiobookExportRequest { path; chapters?; formats: { mp3; m4b; subtitles; package }; confirm? }`
  - `AudiobookExportIssue { code; message; path? }`
  - `AudiobookExportPreflight { ready; issues: readonly AudiobookExportIssue[]; chapters; cost: { chars; requests; estimatedCost } }`
  - `AudioAssetProvider` / `LocalAssetProvider` / `ComfyUiMusicProvider`
  - `preflightAudiobookExport(...)`
  - `exportAudiobook(...)`

- [ ] **Step 1: 写预检/导出路由失败测试**

追加到 `tests/audiobook-route.test.ts`：

```ts
const CUE = {
  id: "cue-1",
  chapter: CHAPTER,
  asset: "有声剧/长夜行/素材/音乐/theme.mp3",
  startSegment: SCRIPT.segments[0]!.id,
  offsetMs: 0,
  fadeInMs: 0,
  fadeOutMs: 0,
  gainDb: -6,
  duckDb: -12,
};
const CUE_PROJECT: AudiobookProject = { ...PROJECT, cues: [CUE] };
const ASSET_PATH = "有声剧/长夜行/素材/音乐/theme.mp3";
const AUTHORIZATION_PATH = "有声剧/长夜行/素材/授权.json";

function cueFixture(authorized: boolean): Fixture {
  return fixture({
    seed: {
      [PROJECT_PATH]: JSON.stringify(CUE_PROJECT),
      [ASSET_PATH]: "ID3",
      ...(authorized ? {
        [AUTHORIZATION_PATH]: JSON.stringify({
          schemaVersion: 1,
          assets: [{ path: ASSET_PATH, source: "测试", license: "CC-BY-4.0", allowedUse: ["audiobook"], attribution: "测试" }],
        }),
        "有声剧/长夜行/封面/cover.jpg": "JPEG",
      } : {}),
    },
  });
}

it("导出预检零写入；未授权素材/缺封面时 ready=false 并列出 issue", async () => {
  const harness = cueFixture(false);
  const preview = await callRoute(harness, "POST", "/oh-story/audiobook/export", {
    path: PROJECT_PATH, chapters: [CHAPTER], preview: true,
    formats: { mp3: true, m4b: true, subtitles: ["srt", "lrc"], package: true },
  });
  expect(preview.status).toBe(200);
  expect(harness.writes).toHaveLength(0);
  const preflight = asRecord(asRecord(preview.json)["preflight"]);
  expect(preflight["ready"]).toBe(false);
  expect(JSON.stringify(preflight["issues"])).toContain("未授权");
  expect(JSON.stringify(preflight["issues"])).toContain("封面");
});

it("未确认完整导出返回 400 且不写发布目录", async () => {
  const harness = cueFixture(true);
  const denied = await callRoute(harness, "POST", "/oh-story/audiobook/export", {
    path: PROJECT_PATH, chapters: [CHAPTER],
    formats: { mp3: true, m4b: false, subtitles: [], package: false },
  });
  expect(denied.status).toBe(400);
  expect(harness.writes).toHaveLength(0);
});
```

- [ ] **Step 2: 实现 provider 窄接口**

```ts
export interface AudioAssetGenerationRequest {
  readonly kind: AudiobookAssetKind;
  readonly prompt: string;
  readonly durationSeconds: number;
  readonly count: number;
}

export interface AudioAssetGenerationResult {
  readonly files: readonly { readonly path: string; readonly bytes: number }[];
  readonly provider: string;
  readonly model: string;
  readonly promptSha256: string;
  readonly receiptId: string | null;
  readonly cost: number;
}

export interface AudioAssetProvider {
  readonly id: string;
  readonly label: string;
  readonly configured: boolean;
  estimate(request: AudioAssetGenerationRequest): number;
  generate(realm: WorkspaceRealm, project: AudiobookProjectRecord, request: AudioAssetGenerationRequest): Promise<AudioAssetGenerationResult>;
}
```

- `LocalAssetProvider`：`configured: true`，`generate` 抛 400「本地素材库不支持生成」。
- `ComfyUiMusicProvider`：测试注入 `generatePort`；生产适配器如下（复用现有 `oh_story_comfyui` 工具，不复制 Python 启动逻辑）：

```ts
export interface ComfyuiAudioPort {
  generate(input: {
    readonly prompt: string;
    readonly durationSeconds: number;
    readonly outputDir: string;
    readonly filenamePrefix: string;
    readonly timeoutSeconds: number;
  }): Promise<{ readonly files: readonly { readonly path: string; readonly bytes: number }[]; readonly promptIds: readonly unknown[]; readonly durationMs: number }>;
}

export function createComfyuiAudioPort(realm: WorkspaceRealm): ComfyuiAudioPort {
  const tool = createOhStoryComfyuiTool();
  return {
    async generate(input) {
      const exec = {
        agent: { session: realm.agent.session, ctx: { get: (key: string) => key === "fs" ? realm.fs : undefined } },
      } as unknown as Parameters<typeof tool.execute>[1];
      const result = await tool.execute({
        prompt: input.prompt,
        output_dir: input.outputDir,
        filename_prefix: input.filenamePrefix,
        duration_seconds: input.durationSeconds,
        count: 1,
        timeout_seconds: input.timeoutSeconds,
      }, exec);
      return { files: result.files, promptIds: result.prompt_ids, durationMs: result.duration_ms };
    },
  };
}
```

`configured` 取决于 `COMFYUI_WORKFLOW` 或工作区 `.comfyui.json`；未配置时路由返回 503。生成输出目录固定 `有声剧/<book>/素材/<音乐|音效>`，返回文件必须落在该目录且扩展名合法。
- 路由 `POST /oh-story/audiobook/assets/generate` 必须 `confirm: true`，预检返回 `{ estimate, provider }`；生成后把 provider receipt 写入对应授权条目（若用户尚未填 license，则先写 `license: "unverified"` 并在导出预检里阻断；UI 必须提示补授权）。
- 测试：fake provider 成功写入文件并返回 receipt；未配置 503；未确认 400；路径逃逸 403。

- [ ] **Step 3: 预检与导出编排**

`preflightAudiobookExport` 顺序：
1. 读取项目与选中章节脚本，`assertScriptSourceFresh`、`assertAssignable`。
2. `listAudiobookAssets` + `assertCuesAuthorized`；没有 `素材/授权.json` 且项目有 cue → 409。
3. 缺 `封面/cover.jpg` 且请求 M4B/package → 409。
4. `probeTool` ffmpeg/ffprobe；缺任一 → 503。
5. 逐段检查缓存音频存在；缺段 → 409。
6. 返回 `issues`（不抛错）与 `ready`；`preview: true` 直接返回 200。
7. 实际导出：每个章节 `measureCachedSegmentDuration` → `buildTimeline` → 查 cue 窗口与素材时长 → `buildMixArgs` 混音到 tmp WAV → `loudnorm` 两遍 → 编码 MP3（192k）→ 字幕 → 收集结果。M4B 用各章 MP3 + 封面 + ffmetadata。Package 复制到 `发布/` 并写清单。所有临时文件在 `finally` 清理。
8. 任何失败不写最终文件；已在 `finally` 删除 tmp。

- [ ] **Step 4: 路由扩展**

- `GET /oh-story/audiobook/assets?path=` → `{ view }`，零写入。
- `PUT /oh-story/audiobook/assets` → `{ path, baseVersion, document }`，CAS。
- `POST /oh-story/audiobook/assets/generate` → `{ path, kind, prompt, durationSeconds, count, confirm, preview? }`；未配置 503；生成后返回 `{ files, receipt }`。
- `POST /oh-story/audiobook/export` 兼容旧 `{ path, chapter, confirm }`：若带 `formats` 则走完整导出；否则仍只导出单章 MP3。旧响应保持 `{ path, bytes, durationMs }`，完整导出返回 `{ files, manifestPath? }`。
- `GET /oh-story/audiobook/segment-audio` 保持缓存音频读取；新增 `.m4b` 媒体类型。

- [ ] **Step 5: 运行测试**

```bash
cd packages/dsh-plugin && npx vitest run tests/audiobook-export-full.test.ts tests/audiobook-asset-provider.test.ts tests/audiobook-route.test.ts
```

- [ ] **Step 6: 提交**

```bash
git add packages/dsh-plugin/src/services/audiobook-export.ts packages/dsh-plugin/src/services/audiobook-route.ts packages/dsh-plugin/src/services/audiobook-contract.ts packages/dsh-plugin/src/services/audiobook-asset-provider.ts packages/dsh-plugin/tests/audiobook-export-full.test.ts packages/dsh-plugin/tests/audiobook-asset-provider.test.ts packages/dsh-plugin/tests/audiobook-route.test.ts
git commit -m "feat(audiobook): 增加完整导出预检与素材生成接口"
```

---

### Task 9: 工作台素材/cue/导出面板

**Files:**
- Modify: `packages/dsh-plugin/src/client/features/audiobook-feature.tsx`
- Modify: `packages/dsh-plugin/src/client/features/audiobook-feature.css`
- Test: `packages/dsh-plugin/tests/audiobook-view.test.tsx`

**Interfaces:**
- Consumes `AudiobookAssetView`, `AudiobookExportPreflight`, `AudiobookCue`。
- `AudiobookView` 新增可选 props：`assets`、`cues`、`exportPreflight`、`onSaveCues`、`onPreviewExport`、`onExportAll`。
- Produces pure components:
  - `AssetPanel({ view, cues, chapterSegments, busy, onSaveCue, onDeleteCue, onSaveCues, onGenerate })`
  - `ExportPanel({ preflight, busy, onPreview, onExport })`

- [ ] **Step 1: 写 UI 渲染测试**

追加到 `tests/audiobook-view.test.tsx`：

```tsx
const baseProps = {
  overview: overviewWithProject(),
  view: projectView(),
  busy: false,
  onRefresh: noop,
  onCreate: noop,
  onParse: noop,
  onDryRun: noop,
  onGenerate: noop,
  onExport: noop,
};

const unauthorizedAssets: AudiobookAssetView = {
  assets: [{ path: "有声剧/长夜行/素材/音乐/theme.mp3", kind: "music", bytes: 3, authorized: false, license: null }],
  authorizationVersion: null,
  providers: [],
};

it("素材面板展示授权状态，未授权素材不能加入 cue", () => {
  const html = renderToStaticMarkup(<AudiobookView
    {...baseProps}
    assets={unauthorizedAssets}
    cues={[]}
    onSaveCues={noop}
  />);
  expect(html).toContain("音乐与音效");
  expect(html).toContain("theme.mp3");
  expect(html).toContain("未授权");
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>加入 cue<\/button>/u);
});

it("导出面板显示预检问题并禁用未就绪的导出", () => {
  const html = renderToStaticMarkup(<AudiobookView
    {...baseProps}
    exportPreflight={{
      ready: false,
      issues: [{ code: "cover-missing", message: "缺少封面" }],
      chapters: 1,
      cost: { chars: 6, requests: 0, estimatedCost: 0 },
    }}
  />);
  expect(html).toContain("缺少封面");
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>完整导出<\/button>/u);
});
```

`tests/audiobook-view.test.tsx` 需要导入 `AudiobookAssetView`；`unauthorizedAssets` 的 `path` 已在 N4-B 的 `PROJECT` 书名下，渲染时只显示文件名，不显示绝对路径。

- [ ] **Step 2: 实现 UI 状态**

- 面板新增状态：`assetsView`、`cuesDraft`、`exportOptions`（`{ mp3: true, m4b: false, subtitles: ["srt"], package: false }`）、`exportPreflight`。
- `load` 同时拉 `GET /assets`；失败只影响素材区，不拖垮项目视图。
- 选中章节后，沿用 `GET script` 的段落列表作为 cue 锚点；cue 列表来自 `project.cues` 过滤当前章节。
- 新增/删除 cue 在本地草稿，点「保存 cue」才 `PUT /project`（带 `baseVersion`）；保存成功刷新项目。
- 生成素材入口：选择 provider、kind、prompt、时长、数量，先请求 `preview: true` 显示预估，再 `confirm` 生成；生成后刷新素材与授权，提示补 license。
- 导出区：勾选 MP3/M4B/SRT/LRC/发布包；「预检」调 `preview: true`；预检未就绪时显示每条 issue 并禁用「完整导出」；导出前 `window.confirm` 列出格式、章节与预估成本。
- 面板不显示密钥、绝对路径或完整 URL 查询串。

- [ ] **Step 3: 运行 UI 测试**

```bash
cd packages/dsh-plugin && npx vitest run tests/audiobook-view.test.tsx
```

- [ ] **Step 4: 提交**

```bash
git add packages/dsh-plugin/src/client/features/audiobook-feature.tsx packages/dsh-plugin/src/client/features/audiobook-feature.css packages/dsh-plugin/tests/audiobook-view.test.tsx
git commit -m "feat(audiobook): 增加素材与完整导出面板"
```

---

### Task 10: 真实 ffmpeg 验收、文档与合并

**Files:**
- Modify: `packages/dsh-plugin/src/workspace-route.ts`（`.m4b` MIME）
- Create: `packages/dsh-plugin/tests/audiobook-ffmpeg.test.ts`
- Modify: `docs/VALIDATION.md`、`docs/TODO-dsh-miaowu.md`、`docs/FORK-FEATURES.md`、`docs/ARCHITECTURE.md`、`CHANGELOG.md`、`README.md`、`README_EN.md`

- [ ] **Step 1: 真实 ffmpeg 集成测试**

`audiobook-ffmpeg.test.ts` 用 `mkdtemp` + `hostBinaryFileStore`：
1. 生成 2 个 0.4s 静音 WAV（`anullsrc`）和一个 1.5s 正弦 BGM（`sine`）。
2. 用 `buildMixArgs` 混音，跑 `hostCommandRunner`。
3. 断言输出 WAV 存在、时长约等于时间轴长度。
4. 两遍 loudnorm 后，用 `ffmpeg -hide_banner -nostats -i master.wav -af ebur128=peak=true -f null -` 测量；从 stderr 解析：

```ts
const integrated = /I:\s+(-?\d+(?:\.\d+)?)\s+LUFS/u.exec(stderr)?.[1];
const truePeak = /True peak:\s+(-?\d+(?:\.\d+)?)\s+dBFS/u.exec(stderr)?.[1];
expect(Number(integrated)).toBeGreaterThanOrEqual(-17);
expect(Number(integrated)).toBeLessThanOrEqual(-15);
expect(Number(truePeak)).toBeLessThanOrEqual(-1.4);
```

5. 生成 SRT/LRC，断言时间行。
6. M4B：用两个 MP3 + 1x1 JPEG 封面 + ffmetadata，跑 ffmpeg，`ffprobe -show_chapters` 断言 2 个章节、`-show_streams` 断言 attached_pic。
7. 若 `probeTool(runner,"ffmpeg")` 或 ffprobe 不可用，`it.skip` 并在 VALIDATION 记录；不允许伪造通过。

- [ ] **Step 2: 跑 targeted → 全量 → 双宿主**

```bash
cd packages/dsh-plugin && npx vitest run tests/audiobook-*.test.ts tests/audiobook-view.test.tsx
cd /e/dsh-miaowu && pnpm verify
pnpm test:dsh
pnpm test:dsh:rc
stat -c '%s' packages/dsh-plugin/lib/client.js
```

预期：全绿；包体 ≤ 400,000；双宿主 `"ok": true`。

- [ ] **Step 3: 更新文档**

- `VALIDATION.md`：新增 2026-10-23 N4-C 审计，写清真实 ffmpeg 测量值、M4B 章节数、包体、双宿主结果、仍然未做的 N4-D 项。
- `TODO-dsh-miaowu.md`：N4-C 状态改为已交付，列出 N4-D 剩余项。
- `FORK-FEATURES.md` / `ARCHITECTURE.md`：素材授权、cue、响度、字幕、M4B、发布包与路由。
- `CHANGELOG.md`：Unreleased 增加 N4-C 条目。
- `README.md` / `README_EN.md`：有声剧段落改为 N4-C，明确 ffmpeg 依赖与发布包格式。

- [ ] **Step 4: 功能与文档分开提交**

```bash
git add packages/dsh-plugin/src/services packages/dsh-plugin/src/client packages/dsh-plugin/tests packages/dsh-plugin/src/workspace-route.ts
git commit -m "feat(audiobook): 交付完整有声剧混音、字幕与发布包"

git add docs CHANGELOG.md README.md README_EN.md
git commit -m "docs(audiobook): 记录 N4-C 验证与发布包说明"
```

- [ ] **Step 5: ff-only 合并 main（不 push）**

```bash
git switch main
git merge --ff-only feat/audiobook-n4c
git status -sb
```

预期：`main` 快进；工作树只有未跟踪的 `.tmp/`；不执行 `git push`。

---

## Self-Review

- **Spec coverage:** 4.3 素材授权 → Task 1；4.4/发布清单 → Task 7；5.4/5.5 时长与成本 → Task 3；6 BGM/音效 → Task 1/4/8；7.1 时间轴 → Task 2；7.2 混音/响度 → Task 4；7.3 字幕 → Task 5；7.4 导出/M4B/封面 → Task 6/8；8 路由与工作台 → Task 8/9；9 安全边界 → Global Constraints + Task 1/8；10 测试策略 → 各 Task；11 N4-C 验收 → Task 10。
- **未纳入本切片（与路线图一致）：** 波形预览（N4-C 验收未要求，先以 cue 列表/试听替代，N4-D 再补）、TTS 时长 QC 的 0.5–1.8 比值复检（N4-D 质量项）、真实付费 provider、整书批量与自动续跑。
- **类型一致性：** `AudiobookAssetKind`、`AudiobookAssetAuthorization`、`AudiobookCue`、`MixCue`、`AudiobookManifest` 在 Task 1/2/4/7 中定义并在 Task 8/9 复用；`BinaryFileStore.hash/copy` 在 Task 3 定义，Task 7/8 使用。
- **无占位符：** 每个实现步骤都给了函数签名、参数或测试断言；环境安装命令给了具体 winget ID。

## Execution Handoff

计划已保存到 `docs/superpowers/plans/2026-10-23-audiobook-n4c.md`。两种执行方式：

1. **Subagent-Driven（推荐）**：每个 Task 派独立子代理，任务间做两阶段审查，适合这种跨服务/路由/UI 的大切片。
2. **Inline Execution**：在当前会话按 Task 顺序执行，每个 Task 后设检查点。

选哪种？
