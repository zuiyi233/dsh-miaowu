# N4-A 有声剧纵向切片 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付单章、单旁白音色的有声剧纵向切片：正文切分 → OpenAI-compatible TTS → 内容寻址缓存 → 工作台试听 → 分章 MP3 导出，带成本预估与显式确认。

**Architecture:** TypeScript 宿主服务 + `/oh-story/audiobook/*` 路由 + 「有声剧」工作台 feature。TTS 只通过 OpenAI-compatible `/audio/speech`；音频字节由宿主二进制存储落盘，文本/JSON 继续走 DSH fs 缝；ffmpeg/ffprobe 只用于导出与探测，缺失时阻断并报错。

**Tech Stack:** TypeScript、React、Vitest、Node `fetch`、Node `child_process.spawn`、ffmpeg/ffprobe、DSH WorkspaceRealm。

**Spec:** `docs/superpowers/specs/2026-10-21-audiobook-roadmap-design.md`

## Global Constraints

- 所有项目/脚本/任务 JSON 使用 `schemaVersion: 1`。
- TTS 只发送标准字段：`model`、`input`、`voice`、`response_format`、`speed`。
- 密钥只读 `OH_STORY_TTS_API_KEY`，端点/模型读 `OH_STORY_TTS_BASE_URL` / `OH_STORY_TTS_MODEL`；密钥不得进入工作区、日志、错误、缓存或清单。
- 付费 TTS 启动与导出必须 `confirm: true`；无密钥、超预算、缺脚本时提前失败，不发请求。
- 产物只写 `有声剧/<书名>/` 与 `.oh-story/audiobook/`；不写 DSH 会话、`workspace.json`、`~/.dsh`。
- `baseUrl` 只允许 `https:`，或 loopback 的 `http://127.0.0.1` / `http://localhost` / `http://[::1]`；拒绝 URL 凭证、query、hash、跨主机重定向。
- ffmpeg/ffprobe 缺失、解码失败或输出为空时阻断，不静默降级。
- 客户端包体必须 ≤ 400,000 字节（当前 372,317）。
- 每个任务结束运行定向测试并提交；最终任务运行 `pnpm verify` 与双宿主冒烟。不要 push/tag/publish。
- 提交信息使用中文；`git add` 必须显式列出文件，`git commit` 不带 pathspec。

---

## Task 1: 契约、项目发现与项目持久化

**Files:**
- Create: `packages/dsh-plugin/src/services/audiobook-contract.ts`
- Create: `packages/dsh-plugin/src/services/audiobook-project.ts`
- Create: `packages/dsh-plugin/tests/audiobook-fixtures.ts` (shared `memoryRealm` helper; later audiobook tests import it)
- Test: `packages/dsh-plugin/tests/audiobook-project.test.ts`

**Interfaces:**
- Consumes: `WorkspaceRealm`, `WorkspaceHttpError`, `readVersionedFile`, `mapFsError` from `../workspace-route.js`.
- Produces:
  - `AUDIOBOOK_SCHEMA_VERSION`, `AUDIOBOOK_ROUTES`, `AUDIOBOOK_CACHE_ROOT`, `AUDIOBOOK_JOB_ROOT`, `AUDIOBOOK_ROOT`
  - `AudiobookProject`, `AudiobookProjectRecord`, `AudiobookProjectSummary`, `AudiobookSource`, `AudiobookPreflight`
  - `listAudiobookSources(realm): Promise<AudiobookSource[]>`
  - `listChapterPaths(realm, bookRoot): Promise<string[]>`
  - `createAudiobookProject(realm, input): Promise<AudiobookProjectRecord>`
  - `loadAudiobookProject(realm, path): Promise<AudiobookProjectRecord>`
  - `saveAudiobookProject(realm, path, project, baseVersion): Promise<AudiobookProjectRecord>`
  - `listAudiobookProjects(realm): Promise<{ projects: AudiobookProjectRecord[]; errors: { path: string; message: string }[] }>`
  - `validateTtsBaseUrl(raw: string): string`

- [ ] **Step 1: Write the failing project tests**

Create `packages/dsh-plugin/tests/audiobook-project.test.ts` with a memory realm. Reuse the memory fs shape from `tests/continuity.test.ts` but add `processPath(target) => target.displayPath` so later binary tests share it.

```ts
import { describe, expect, it } from "vitest";
import type { FileSystem, FsDirEntry, FsInfo, FsTarget, FsVersion, FsWriteIntent, FsWriteOutcome } from "@deepseek-ai/dsh-fs";
import type { WorkspaceRealm } from "../src/workspace-route.js";
import {
  createAudiobookProject,
  listAudiobookSources,
  listChapterPaths,
  loadAudiobookProject,
  saveAudiobookProject,
  validateTtsBaseUrl,
} from "../src/services/audiobook-project.js";
import { memoryRealm } from "./audiobook-fixtures.js";

const CWD = "/books/demo";

function memoryRealm(seed: Record<string, string> = {}): { realm: WorkspaceRealm; writes: string[]; read: (path: string) => string | undefined } {
  const files = new Map<string, { content: string; version: string }>();
  const writes: string[] = [];
  let clock = 0;
  const next = (): FsVersion => `v${String(++clock)}` as FsVersion;
  for (const [path, content] of Object.entries(seed)) files.set(path, { content, version: String(next()) });
  const info = (path: string): FsInfo | undefined => {
    const file = files.get(path);
    if (file !== undefined) return { type: "file", version: file.version as FsVersion, size: Buffer.byteLength(file.content) };
    const prefix = `${path}/`;
    for (const key of files.keys()) if (key.startsWith(prefix)) return { type: "directory", version: "dir" as FsVersion };
    return undefined;
  };
  const fs = {
    resolve: async (path: string): Promise<FsTarget> => ({
      targetKey: path.replace(/^\/+/u, "") as FsTarget["targetKey"],
      displayPath: path.replace(/^\/+/u, ""),
    }),
    contains: (parent: FsTarget, child: FsTarget): boolean =>
      child.displayPath === parent.displayPath || child.displayPath.startsWith(`${parent.displayPath}/`),
    stat: async (target: FsTarget): Promise<FsInfo | undefined> => info(target.displayPath),
    listDir: async (target: FsTarget): Promise<FsDirEntry[]> => {
      const prefix = `${target.displayPath}/`;
      const dirs = new Set<string>();
      const names = new Set<string>();
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash < 0) names.add(rest);
        else dirs.add(rest.slice(0, slash));
      }
      return [
        ...[...dirs].map((name) => ({ name, type: "directory" as const, target: { targetKey: `${prefix}${name}` as FsTarget["targetKey"], displayPath: `${prefix}${name}` } })),
        ...[...names].map((name) => ({ name, type: "file" as const, target: { targetKey: `${prefix}${name}` as FsTarget["targetKey"], displayPath: `${prefix}${name}` } })),
      ];
    },
    readBytes: async (target: FsTarget): Promise<Uint8Array> => {
      const file = files.get(target.displayPath);
      if (file === undefined) throw new Error("FS_NOT_FOUND");
      return new TextEncoder().encode(file.content);
    },
    writeText: async (target: FsTarget, content: string, expected?: FsWriteIntent): Promise<FsWriteOutcome> => {
      const current = files.get(target.displayPath);
      if (expected?.kind === "replaceIfVersion" && (current === undefined || current.version !== String(expected.version))) {
        throw new Error("FS_STALE_VERSION");
      }
      const version = String(next());
      files.set(target.displayPath, { content, version });
      writes.push(target.displayPath);
      return { operation: current === undefined ? "create" : "update", version: version as FsVersion, before: current?.content ?? null, after: content };
    },
  } as unknown as Pick<FileSystem, "resolve" | "contains" | "stat" | "listDir" | "readBytes" | "writeText">;
  return {
    realm: { fs: fs as FileSystem, cwd: CWD, root: { targetKey: "" as FsTarget["targetKey"], displayPath: "" } } as unknown as WorkspaceRealm,
    writes,
    read: (path) => files.get(path)?.content,
  };
}

export const CHAPTERS = {
  "正文/第0001章_开篇.md": "旁白。\n\n“你好。”他说。\n",
  "正文/第0002章_回声.md": "第二章。\n",
};

// 把上面的 memoryRealm 原样移到 tests/audiobook-fixtures.ts 并导出；
// 本文件改为 `import { memoryRealm } from "./audiobook-fixtures.js";`。
// 后续 audiobook 测试复用同一个 helper，避免复制内存 fs。

describe("audiobook project", () => {
  it("发现正文直属章节与 正文/书名 章节", async () => {
    const { realm } = memoryRealm({
      ...CHAPTERS,
      "正文/长夜行/第0001章.md": "# 长夜行\n",
      "书名/正文/第0001章.md": "# 书名布局\n",
    });

    expect(await listChapterPaths(realm, "正文")).toEqual(["正文/第0001章_开篇.md", "正文/第0002章_回声.md"]);
    const sources = await listAudiobookSources(realm);
    expect(sources.map((source) => source.bookRoot)).toEqual(["正文", "书名", "正文/长夜行"].sort((a, b) => a.localeCompare(b, "zh-Hans-CN")));
  });

  it("创建项目写入 schemaVersion 1，密钥字段不能落盘", async () => {
    const { realm, read } = memoryRealm(CHAPTERS);

    const record = await createAudiobookProject(realm, {
      bookRoot: "正文",
      name: "长夜行",
      voice: "alloy",
      baseUrl: "https://api.example.com/v1",
      model: "tts-1",
    });

    expect(record.path).toBe("有声剧/长夜行/project.json");
    const saved = JSON.parse(read(record.path) ?? "{}") as Record<string, unknown>;
    expect(saved.schemaVersion).toBe(1);
    expect(JSON.stringify(saved)).not.toContain("apiKey");
    expect(record.project.cast).toEqual([{ id: "narrator", name: "旁白", kind: "narrator", voice: "alloy" }]);
    expect(record.project.tts.baseUrl).toBe("https://api.example.com/v1");
  });

  it("保存项目使用 baseVersion CAS，旧版本返回 412", async () => {
    const { realm } = memoryRealm(CHAPTERS);
    const created = await createAudiobookProject(realm, {
      bookRoot: "正文", name: "长夜行", voice: "alloy", baseUrl: "https://api.example.com/v1", model: "tts-1",
    });
    const next = { ...created.project, cast: [{ ...created.project.cast[0]!, voice: "verse" }] };
    const saved = await saveAudiobookProject(realm, created.path, next, created.version);
    expect(saved.project.cast[0]?.voice).toBe("verse");
    await expect(saveAudiobookProject(realm, created.path, next, created.version)).rejects.toMatchObject({ status: 412 });
  });

  it("拒绝非 loopback 明文端点与 URL 凭证", () => {
    expect(validateTtsBaseUrl("https://api.example.com/v1")).toBe("https://api.example.com/v1");
    expect(validateTtsBaseUrl("http://127.0.0.1:8080/v1")).toBe("http://127.0.0.1:8080/v1");
    expect(() => validateTtsBaseUrl("http://api.example.com/v1")).toThrow(/https/u);
    expect(() => validateTtsBaseUrl("https://user:pass@api.example.com/v1")).toThrow(/凭证/u);
    expect(() => validateTtsBaseUrl("https://api.example.com/v1?x=1")).toThrow(/query/u);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/dsh-plugin && npx vitest run tests/audiobook-project.test.ts`
Expected: FAIL because `audiobook-project.js` does not exist.

- [ ] **Step 3: Implement the contract**

Create `packages/dsh-plugin/src/services/audiobook-contract.ts`:

```ts
export const AUDIOBOOK_SCHEMA_VERSION = 1 as const;
export const AUDIOBOOK_ROOT = "有声剧";
export const AUDIOBOOK_CACHE_ROOT = ".oh-story/audiobook/cache";
export const AUDIOBOOK_JOB_ROOT = ".oh-story/audiobook/jobs";
export const AUDIOBOOK_ROUTES = {
  overview: "/oh-story/audiobook",
  project: "/oh-story/audiobook/project",
  script: "/oh-story/audiobook/script",
  jobs: "/oh-story/audiobook/jobs",
  export: "/oh-story/audiobook/export",
  segmentAudio: "/oh-story/audiobook/segment-audio",
} as const;

export type AudiobookProjectKind = "novel";
export type AudiobookJobStatus = "queued" | "running" | "paused" | "failed" | "completed";

export interface AudiobookTtsConfig {
  readonly baseUrl: string;
  readonly model: string;
  readonly responseFormat: "mp3" | "wav";
  readonly speed: number;
  readonly pricePerMillionChars: number;
  readonly maxCharsPerChapter: number;
  readonly concurrency: number;
}

export interface AudiobookCastMember {
  readonly id: string;
  readonly name: string;
  readonly kind: "narrator" | "character";
  readonly voice: string;
}

export interface AudiobookCue {
  readonly id: string;
  readonly chapter: string;
  readonly asset: string;
  readonly startSegment: string;
  readonly offsetMs: number;
  readonly fadeInMs: number;
  readonly fadeOutMs: number;
  readonly gainDb: number;
  readonly duckDb: number;
}

export interface AudiobookProject {
  readonly schemaVersion: 1;
  readonly source: { readonly bookRoot: string; readonly chapters: readonly string[] };
  readonly tts: AudiobookTtsConfig;
  readonly cast: readonly AudiobookCastMember[];
  readonly cues: readonly AudiobookCue[];
  readonly export: {
    readonly mp3BitrateKbps: number;
    readonly sampleRate: number;
    readonly channels: number;
    readonly loudnessLufs: number;
    readonly truePeakDbtp: number;
    readonly subtitles: readonly ("srt" | "lrc")[];
  };
  readonly rights: { readonly voiceCloning: false };
}

export interface AudiobookSegment {
  readonly id: string;
  readonly kind: "narration" | "dialogue";
  readonly speakerId: string;
  readonly text: string;
  readonly sourceStart: number;
  readonly sourceEnd: number;
}

export interface AudiobookScript {
  readonly schemaVersion: 1;
  readonly chapter: string;
  readonly sourcePath: string;
  readonly sourceSha256: string;
  readonly segments: readonly AudiobookSegment[];
}

export interface AudiobookScriptRecord {
  readonly script: AudiobookScript;
  readonly path: string;
  readonly version: string;
}

export interface AudiobookJob {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly projectPath: string;
  readonly chapter: string;
  readonly sourcePath: string;
  readonly status: AudiobookJobStatus;
  readonly totalSegments: number;
  readonly completedSegments: number;
  readonly failedSegments: readonly { readonly segmentId: string; readonly error: string }[];
  readonly chars: number;
  readonly estimatedCost: number;
  readonly actualRequests: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly outputPath: string | null;
}

export interface AudiobookJobRecord {
  readonly job: AudiobookJob;
  readonly version: string;
}

export interface AudiobookCostEstimate {
  readonly segments: number;
  readonly chars: number;
  readonly cacheHits: number;
  readonly requests: number;
  readonly estimatedCost: number;
}

export interface AudiobookChapterSummary {
  readonly sourcePath: string;
  readonly chapter: string;
  readonly scriptPath: string;
  readonly hasScript: boolean;
  readonly segmentCount: number;
  readonly audioPath: string | null;
  readonly jobId: string | null;
  readonly jobStatus: AudiobookJobStatus | null;
}

export interface AudiobookProjectView {
  readonly record: AudiobookProjectRecord;
  readonly chapters: readonly AudiobookChapterSummary[];
  readonly preflight: AudiobookPreflight;
}

export interface AudiobookProjectRecord {
  readonly project: AudiobookProject;
  readonly path: string;
  readonly version: string;
}

export interface AudiobookProjectSummary {
  readonly path: string;
  readonly name: string;
  readonly bookRoot: string;
  readonly chapters: number;
}

export interface AudiobookSource {
  readonly bookRoot: string;
  readonly name: string;
  readonly chapters: readonly string[];
}

export interface AudiobookPreflight {
  readonly ttsKey: "present" | "missing";
  readonly ttsHost: string | null;
  readonly ffmpeg: boolean;
  readonly ffprobe: boolean;
}

export interface AudiobookOverview {
  readonly projects: readonly AudiobookProjectSummary[];
  readonly sources: readonly AudiobookSource[];
  readonly errors: readonly { readonly path: string; readonly message: string }[];
  readonly preflight: AudiobookPreflight;
}
```

Create `packages/dsh-plugin/src/services/audiobook-project.ts` with:
- `safeRelativePath`, `chapterPathsIn`, `listChapterPaths`, `listAudiobookSources`.
- `validateTtsBaseUrl`.
- `projectPathFor`, `validateProject`, `createAudiobookProject`, `loadAudiobookProject`, `saveAudiobookProject`, `listAudiobookProjects`.
- `loadAudiobookProject` must reject paths outside `有声剧/` and parse `schemaVersion === 1`.
- `saveAudiobookProject` catches `FS_STALE_VERSION` and throws `WorkspaceHttpError(412, ...)`; other fs errors via `mapFsError`.
- `createAudiobookProject` uses `writeText(..., { kind: "createIfAbsent" })`; if the fs throws stale/exists, return 409.
- Default TTS config: `responseFormat: "mp3"`, `speed: 1`, `pricePerMillionChars: 15`, `maxCharsPerChapter: 20000`, `concurrency: 2`, export `192/44100/2/-16/-1.5`, `cues: []`, `subtitles: []`, `rights.voiceCloning: false`.
- `source.chapters` is the full discovered chapter list at creation; `source.bookRoot` must be one of `listAudiobookSources`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/dsh-plugin && npx vitest run tests/audiobook-project.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-plugin/src/services/audiobook-contract.ts packages/dsh-plugin/src/services/audiobook-project.ts packages/dsh-plugin/tests/audiobook-fixtures.ts packages/dsh-plugin/tests/audiobook-project.test.ts
git commit -m "feat(audiobook): 增加项目契约与项目发现"
```

---

## Task 2: 确定性章节切分与脚本持久化

**Files:**
- Create: `packages/dsh-plugin/src/services/audiobook-script.ts`
- Test: `packages/dsh-plugin/tests/audiobook-script.test.ts`

**Interfaces:**
- Consumes: `AudiobookProjectRecord`, `AUDIOBOOK_ROOT`, `WorkspaceRealm`, `readVersionedFile`, `WorkspaceHttpError`.
- Produces:
  - `AudiobookSegment`, `AudiobookScript`, `AudiobookScriptRecord`
  - `segmentId(kind, speakerId, text, sourceStart): string`
  - `parseChapterText(text: string): AudiobookSegment[]`
  - `scriptPathFor(projectPath: string, chapter: string): string`
  - `parseChapterScript(realm, project, sourcePath): Promise<AudiobookScriptRecord>`
  - `loadChapterScript(realm, projectPath, chapter): Promise<AudiobookScriptRecord | undefined>`
  - `saveChapterScript(realm, projectPath, script, overwrite): Promise<AudiobookScriptRecord>`

- [ ] **Step 1: Write the failing parser tests**

```ts
import { describe, expect, it } from "vitest";
import { loadChapterScript, parseChapterText, saveChapterScript, segmentId } from "../src/services/audiobook-script.js";
import { memoryRealm } from "./audiobook-fixtures.js";

describe("parseChapterText", () => {
  it("区分旁白与中文引号对白，并保留源偏移", () => {
    const text = "雨夜。\n\n“你来了。”他说。\n";
    const segments = parseChapterText(text);
    expect(segments.map((segment) => [segment.kind, segment.text])).toEqual([
      ["narration", "雨夜。"],
      ["dialogue", "你来了。"],
      ["narration", "他说。"],
    ]);
    expect(segments[0]).toMatchObject({ sourceStart: 0, sourceEnd: 3 });
    expect(segments[1]?.sourceStart).toBe(text.indexOf("你来了。"));
  });

  it("未知说话人使用 unknown，segment ID 稳定且随文本变化", () => {
    const first = parseChapterText("“你好。”")[0]!;
    const second = parseChapterText("“你好。”")[0]!;
    expect(first.speakerId).toBe("unknown");
    expect(first.id).toBe(second.id);
    expect(first.id).toBe(segmentId("dialogue", "unknown", "你好。", first.sourceStart));
    expect(parseChapterText("“再见。”")[0]?.id).not.toBe(first.id);
  });

  it("超长段落按句末标点切到 2000 字以内", () => {
    const text = `${"雨。".repeat(1200)}`;
    const segments = parseChapterText(text);
    expect(segments.length).toBeGreaterThan(1);
    expect(segments.every((segment) => segment.text.length <= 2000)).toBe(true);
  });

  it("保存后读回；已有脚本未确认时拒绝覆盖", async () => {
    const { realm } = memoryRealm({ "正文/第0001章_开篇.md": "你好。" });
    const script = {
      schemaVersion: 1 as const,
      chapter: "第0001章_开篇",
      sourcePath: "正文/第0001章_开篇.md",
      sourceSha256: "0".repeat(64),
      segments: parseChapterText("你好。"),
    };
    const saved = await saveChapterScript(realm, "有声剧/长夜行/project.json", script, false);
    expect((await loadChapterScript(realm, "有声剧/长夜行/project.json", "第0001章_开篇"))?.script).toEqual(script);
    await expect(saveChapterScript(realm, "有声剧/长夜行/project.json", script, false))
      .rejects.toMatchObject({ status: 409 });
    await expect(saveChapterScript(realm, "有声剧/长夜行/project.json", { ...script, sourceSha256: "1".repeat(64) }, true))
      .resolves.toMatchObject({ script: { sourceSha256: "1".repeat(64) } });
    expect(saved.path).toBe("有声剧/长夜行/脚本/第0001章_开篇.json");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/dsh-plugin && npx vitest run tests/audiobook-script.test.ts`
Expected: FAIL because `audiobook-script.js` does not exist.

- [ ] **Step 3: Implement the parser and persistence**

Key algorithm for `parseChapterText`:

```ts
const QUOTE_PAIRS = [
  ["“", "”"],
  ["「", "」"],
  ["『", "』"],
] as const;
const SENTENCE_END = /[。！？!?…]/u;
const MAX_SEGMENT_CHARS = 2000;

export function segmentId(kind: AudiobookSegment["kind"], speakerId: string, text: string, sourceStart: number): string {
  return `s-${createHash("sha256").update(`${kind}|${speakerId}|${text}|${String(sourceStart)}`, "utf8").digest("hex").slice(0, 12)}`;
}

export function parseChapterText(text: string): AudiobookSegment[] {
  const out: AudiobookSegment[] = [];
  const push = (kind: AudiobookSegment["kind"], raw: string, start: number, speakerId: string): void => {
    const trimmed = raw.trim();
    if (trimmed === "") return;
    const offset = start + raw.indexOf(trimmed);
    let pieceOffset = 0;
    for (const piece of splitLong(trimmed)) {
      const pieceStart = offset + pieceOffset;
      out.push({ id: segmentId(kind, speakerId, piece, pieceStart), kind, speakerId, text: piece, sourceStart: pieceStart, sourceEnd: pieceStart + piece.length });
      pieceOffset += piece.length;
    }
  };

  for (const paragraph of splitParagraphs(text)) {
    let cursor = 0;
    for (const match of paragraph.text.matchAll(/“([^”]*)”|「([^」]*)」|『([^』]*)』/gu)) {
      const index = match.index ?? 0;
      push("narration", paragraph.text.slice(cursor, index), paragraph.start + cursor, "narrator");
      const inner = match[1] ?? match[2] ?? match[3] ?? "";
      push("dialogue", inner, paragraph.start + index + 1, "unknown");
      cursor = index + match[0].length;
    }
    push("narration", paragraph.text.slice(cursor), paragraph.start + cursor, "narrator");
  }
  return out;
}
```

Implement helpers:
- `splitParagraphs(text): { text: string; start: number }[]` by `/\n\s*\n/gu`, preserving offsets.
- `splitLong(text)`: if length ≤ 2000 return `[text]`; otherwise accumulate sentences at `SENTENCE_END` boundaries and hard-split only when a single sentence exceeds 2000.
- `parseChapterScript`: resolve source path via `realm.fs.resolve`, containment check, `readVersionedFile(realm.fs, target, 4 * 1024 * 1024)`; chapter = basename without `.md`; `sourceSha256 = sha256(content)`; write script with `createIfAbsent` if no existing, else `replaceIfVersion` when `overwrite`.
- `saveChapterScript`: validate chapter name has no `/` or `\`; ensure path under `有声剧/<name>/脚本/`; if existing and `!overwrite` throw 409; if overwrite read current version and use `replaceIfVersion`; return record with version.
- `loadChapterScript`: parse JSON; missing returns undefined; invalid schema throws 415/500? Use `WorkspaceHttpError(422, "脚本格式无效。")`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/dsh-plugin && npx vitest run tests/audiobook-script.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-plugin/src/services/audiobook-script.ts packages/dsh-plugin/tests/audiobook-script.test.ts
git commit -m "feat(audiobook): 增加确定性章节切分与脚本持久化"
```

---

## Task 3: 二进制存储、内容寻址缓存与成本预估

**Files:**
- Create: `packages/dsh-plugin/src/services/audiobook-binary.ts`
- Create: `packages/dsh-plugin/src/services/audiobook-cache.ts`
- Test: `packages/dsh-plugin/tests/audiobook-cache.test.ts`

**Interfaces:**
- Consumes: `WorkspaceRealm`, `AUDIOBOOK_CACHE_ROOT`, `AudiobookProject`, `AudiobookScript`.
- Produces:
  - `BinaryFileStore` with `prepare`, `write`, `read`, `stat`, `rename`, `remove`
  - `hostBinaryFileStore(realm)`, `memoryBinaryFileStore()`
  - `ttsCacheKey(input): string`
  - `segmentAudioPath(key, ext): string`, `segmentMetaPath(key): string`
  - `readCachedSegment(realm, binary, key, ext): Promise<Uint8Array | undefined>`
  - `writeCachedSegment(realm, binary, key, ext, bytes, meta): Promise<void>`
  - `planChapterCost(project, script, cached: ReadonlySet<string>): AudiobookCostEstimate`
  - `AudiobookCostEstimate`

- [ ] **Step 1: Write the failing cache/cost tests**

```ts
import { describe, expect, it } from "vitest";
import { memoryBinaryFileStore } from "../src/services/audiobook-binary.js";
import { planChapterCost, readCachedSegment, segmentAudioPath, ttsCacheKey, writeCachedSegment } from "../src/services/audiobook-cache.js";
import { memoryRealm } from "./audiobook-fixtures.js";

const PROJECT = {
  tts: { baseUrl: "https://api.example.com/v1", model: "tts-1", responseFormat: "mp3", speed: 1, pricePerMillionChars: 15 },
  cast: [{ id: "narrator", name: "旁白", kind: "narrator", voice: "alloy" }],
} as never;
const SCRIPT = {
  segments: [
    { id: "s-1", text: "你好。", kind: "narration", speakerId: "narrator", sourceStart: 0, sourceEnd: 3 },
    { id: "s-2", text: "世界。", kind: "narration", speakerId: "narrator", sourceStart: 3, sourceEnd: 6 },
  ],
} as never;

describe("audiobook cache", () => {
  it("缓存键随 voice 变化，不包含密钥或本机路径", () => {
    const base = { baseUrl: "https://api.example.com/v1/", model: "tts-1", voice: "alloy", speed: 1, responseFormat: "mp3" as const, text: "你好。" };
    const a = ttsCacheKey(base);
    const b = ttsCacheKey({ ...base, voice: "verse" });
    expect(a).toMatch(/^[0-9a-f]{64}$/u);
    expect(a).not.toBe(b);
    expect(a).not.toContain("api.example.com");
  });

  it("写入后读回字节，meta 不含密钥", async () => {
    const binary = memoryBinaryFileStore();
    const { realm } = memoryRealm();
    const key = ttsCacheKey({ baseUrl: "https://api.example.com/v1", model: "tts-1", voice: "alloy", speed: 1, responseFormat: "mp3", text: "你好。" });
    await writeCachedSegment(realm, binary, key, "mp3", new Uint8Array([1, 2, 3]), { model: "tts-1", voice: "alloy", bytes: 3 });
    expect(Array.from(await readCachedSegment(realm, binary, key, "mp3") ?? [])).toEqual([1, 2, 3]);
    expect(binary.files.get(segmentAudioPath(key, "mp3"))?.length).toBe(3);
  });

  it("成本只计算缓存未命中的字符", () => {
    const estimate = planChapterCost(PROJECT, SCRIPT, new Set());
    expect(estimate).toMatchObject({ segments: 2, chars: 6, cacheHits: 0, requests: 2 });
    expect(estimate.estimatedCost).toBeCloseTo(6 / 1_000_000 * 15);
    expect(planChapterCost(PROJECT, SCRIPT, new Set([ttsCacheKey({
      baseUrl: "https://api.example.com/v1", model: "tts-1", voice: "alloy", speed: 1, responseFormat: "mp3", text: "你好。",
    })])).cacheHits).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/dsh-plugin && npx vitest run tests/audiobook-cache.test.ts`
Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement binary store and cache**

`audiobook-binary.ts`:
```ts
export interface BinaryFileStore {
  processPath(target: FsTarget): string;
  prepare(target: FsTarget): Promise<void>;
  write(target: FsTarget, bytes: Uint8Array): Promise<void>;
  read(target: FsTarget, maxBytes: number): Promise<Uint8Array | undefined>;
  stat(target: FsTarget): Promise<{ readonly size: number } | undefined>;
  rename(from: FsTarget, to: FsTarget): Promise<void>;
  remove(target: FsTarget): Promise<void>;
}

export function hostBinaryFileStore(realm: WorkspaceRealm): BinaryFileStore {
  return {
    processPath: (target) => realm.fs.processPath(target),
    prepare: async (target) => { await mkdir(dirname(realm.fs.processPath(target)), { recursive: true }); },
    write: async (target, bytes) => {
      await mkdir(dirname(realm.fs.processPath(target)), { recursive: true });
      await writeFile(realm.fs.processPath(target), bytes);
    },
    read: async (target, maxBytes) => {
      const path = realm.fs.processPath(target);
      const info = await stat(path).catch(() => undefined);
      if (info === undefined || info.size > maxBytes) return undefined;
      return await readFile(path);
    },
    stat: async (target) => { const info = await stat(realm.fs.processPath(target)).catch(() => undefined); return info === undefined ? undefined : { size: info.size }; },
    rename: async (from, to) => { await rename(realm.fs.processPath(from), realm.fs.processPath(to)); },
    remove: async (target) => { await rm(realm.fs.processPath(target), { force: true }); },
  };
}
```
Use `node:fs/promises` `mkdir, readFile, rename, rm, stat`; `node:path` `dirname`.

`memoryBinaryFileStore()` uses `Map<string, Uint8Array>` keyed by `target.displayPath`; public `files` map for tests, and `processPath(target)` returns `target.displayPath`.

`audiobook-cache.ts`:
```ts
export function ttsCacheKey(input: {baseUrl:string; model:string; voice:string; speed:number; responseFormat:string; text:string}): string {
  const base = input.baseUrl.replace(/\/+$/u, "");
  return createHash("sha256").update(JSON.stringify([base, input.model, input.voice, input.speed, input.responseFormat, input.text]), "utf8").digest("hex");
}
export function segmentAudioPath(key: string, ext: "mp3" | "wav"): string { return `${AUDIOBOOK_CACHE_ROOT}/${key}/audio.${ext}`; }
export function segmentMetaPath(key: string): string { return `${AUDIOBOOK_CACHE_ROOT}/${key}/meta.json`; }
```
- `readCachedSegment`: resolve path, ensure under cache root; `binary.read`.
- `writeCachedSegment`: `binary.prepare`/`write`; `realm.fs.writeText` meta JSON with `schemaVersion`, model, voice, responseFormat, bytes, createdAt; **never** include text? Text is not secret but could be large; design says meta request fields excluding key. Store text? For debugging; but privacy. Store `textSha256` and chars, not full text. Good.
- `planChapterCost`: use `project.cast.find((member) => member.kind === "narrator")?.voice` (throw 422 if absent); build each key with `ttsCacheKey({ baseUrl: project.tts.baseUrl, model: project.tts.model, voice, speed: project.tts.speed, responseFormat: project.tts.responseFormat, text: segment.text })`; count total chars, cache hits (if key in cached set), requests = segments - hits, billable chars only misses; `estimatedCost` round to 6 decimals.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/dsh-plugin && npx vitest run tests/audiobook-cache.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-plugin/src/services/audiobook-binary.ts packages/dsh-plugin/src/services/audiobook-cache.ts packages/dsh-plugin/tests/audiobook-cache.test.ts
git commit -m "feat(audiobook): 增加二进制存储与内容寻址缓存"
```

---

## Task 4: OpenAI-compatible TTS 客户端

**Files:**
- Create: `packages/dsh-plugin/src/services/audiobook-tts.ts`
- Test: `packages/dsh-plugin/tests/audiobook-tts.test.ts`

**Interfaces:**
- Consumes: `AudiobookTtsConfig`, `WorkspaceHttpError`.
- Produces:
  - `TtsRequest`, `TtsClient`
  - `buildTtsRequest(config, env, text, voice): { url: string; init: RequestInit }`
  - `OpenAiCompatibleTtsClient` with constructor `{ fetchImpl?, timeoutMs?, maxBytes? }`

- [ ] **Step 1: Write the failing client tests**

```ts
import { describe, expect, it, vi } from "vitest";
import { buildTtsRequest, OpenAiCompatibleTtsClient } from "../src/services/audiobook-tts.js";

const CONFIG = { baseUrl: "https://api.example.com/v1/", model: "tts-1", responseFormat: "mp3" as const, speed: 1, pricePerMillionChars: 15, maxCharsPerChapter: 20000, concurrency: 2 };
const ENV = { OH_STORY_TTS_API_KEY: "secret-key" };

describe("OpenAI-compatible TTS", () => {
  it("只发送标准字段，Authorization 只放在请求头", () => {
    const request = buildTtsRequest(CONFIG, ENV, "你好。", "alloy");
    expect(request.url).toBe("https://api.example.com/v1/audio/speech");
    expect(JSON.parse(String(request.init.body))).toEqual({ model: "tts-1", input: "你好。", voice: "alloy", response_format: "mp3", speed: 1 });
    expect((request.init.headers as Record<string, string>).Authorization).toBe("Bearer secret-key");
    expect(String(request.init.body)).not.toContain("secret-key");
  });

  it("4xx 不重试，429 重试后成功", async () => {
    const responses = [
      new Response("busy", { status: 429 }),
      new Response(new Uint8Array([1, 2]), { status: 200, headers: { "content-type": "audio/mpeg" } }),
    ];
    const fetchImpl = vi.fn(async () => responses.shift()!);
    const client = new OpenAiCompatibleTtsClient({ fetchImpl: fetchImpl as typeof fetch, timeoutMs: 1000 });
    const bytes = await client.synthesize({ ...CONFIG, ...ENV, text: "你好。", voice: "alloy" });
    expect(Array.from(bytes)).toEqual([1, 2]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const fourFetch = vi.fn(async () => new Response("bad", { status: 400 }));
    const four = new OpenAiCompatibleTtsClient({ fetchImpl: fourFetch as typeof fetch, timeoutMs: 1000 });
    await expect(four.synthesize({ ...CONFIG, ...ENV, text: "你好。", voice: "alloy" })).rejects.toMatchObject({ status: 502 });
    expect(fourFetch).toHaveBeenCalledTimes(1);
  });

  it("拒绝非 audio 响应与超限响应", async () => {
    const json = new OpenAiCompatibleTtsClient({ fetchImpl: vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch });
    await expect(json.synthesize({ ...CONFIG, ...ENV, text: "你好。", voice: "alloy" })).rejects.toMatchObject({ status: 502 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/dsh-plugin && npx vitest run tests/audiobook-tts.test.ts`
Expected: FAIL because `audiobook-tts.js` does not exist.

- [ ] **Step 3: Implement the client**

Implement:
- `buildTtsRequest` validates `validateTtsBaseUrl` (import from project service), trims trailing `/`, appends `/audio/speech`; throws 503 if key missing.
- `OpenAiCompatibleTtsClient.synthesize(request, signal)`:
  - `const url = buildTtsRequest(...)`; `fetchImpl(url, {...init, signal: AbortSignal.any([...])})` with `redirect: "error"`.
  - retry on 408/429/5xx up to 3 attempts; respect `Retry-After` up to 10s; add `await sleep(...)`.
  - check `response.ok`; on 4xx throw `WorkspaceHttpError(502, ...)`; on retries exhausted 502.
  - `content-type` must start with `audio/`; else 502.
  - read bytes; if length > maxBytes throw 502; if length === 0 throw 502.
  - error messages include `new URL(request.url).host` and status; never include key or full URL query.
- `TtsRequest` includes `baseUrl`, `model`, `voice`, `text`, `responseFormat`, `speed`, `apiKey`.
- `TtsClient.synthesize(request, signal?)`.
- Test "4xx no retry" should assert fetch called once; adjust test code to expose fetchImpl via local variable rather than private property. Plan test snippet is illustrative; implementer should use `const fetchImpl = vi.fn(...)` and assert call count.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/dsh-plugin && npx vitest run tests/audiobook-tts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-plugin/src/services/audiobook-tts.ts packages/dsh-plugin/tests/audiobook-tts.test.ts
git commit -m "feat(audiobook): 接入 OpenAI-compatible TTS"
```

---

## Task 5: 章节 job、成本预估与断点更新

**Files:**
- Create: `packages/dsh-plugin/src/services/audiobook-jobs.ts`
- Test: `packages/dsh-plugin/tests/audiobook-jobs.test.ts`

**Interfaces:**
- Consumes: project/script/cache/TTS/binary types from Tasks 1–4.
- Produces:
  - `AudiobookJob`, `AudiobookJobRecord`, `AudiobookCostEstimate`
  - `createChapterJob(realm, record, chapter, runtime): Promise<AudiobookJobRecord>`
  - `planChapterJob(realm, record, script, runtime): Promise<AudiobookCostEstimate>`
  - `runChapterJob(realm, jobId, runtime): Promise<AudiobookJob>`
  - `loadAudiobookJob(realm, jobId): Promise<AudiobookJobRecord>`
  - `cancelAudiobookJob(jobId): void`
  - `listAudiobookJobs(realm): Promise<AudiobookJob[]>`

- [ ] **Step 1: Write the failing job tests**

```ts
import { describe, expect, it, vi } from "vitest";
import { loadAudiobookProject } from "../src/services/audiobook-project.js";
import { createChapterJob, runChapterJob } from "../src/services/audiobook-jobs.js";
import { memoryBinaryFileStore } from "../src/services/audiobook-binary.js";
import { OpenAiCompatibleTtsClient } from "../src/services/audiobook-tts.js";
import { memoryRealm } from "./audiobook-fixtures.js";

function fixtureWithScript() {
  const project = {
    schemaVersion: 1,
    source: { bookRoot: "正文", chapters: ["正文/第0001章_开篇.md"] },
    tts: { baseUrl: "https://api.example.com/v1", model: "tts-1", responseFormat: "mp3", speed: 1, pricePerMillionChars: 15, maxCharsPerChapter: 20000, concurrency: 2 },
    cast: [{ id: "narrator", name: "旁白", kind: "narrator", voice: "alloy" }],
    cues: [],
    export: { mp3BitrateKbps: 192, sampleRate: 44100, channels: 2, loudnessLufs: -16, truePeakDbtp: -1.5, subtitles: [] },
    rights: { voiceCloning: false },
  };
  const script = {
    schemaVersion: 1,
    chapter: "第0001章_开篇",
    sourcePath: "正文/第0001章_开篇.md",
    sourceSha256: "0".repeat(64),
    segments: [
      { id: "s-1", kind: "narration", speakerId: "narrator", text: "你好。", sourceStart: 0, sourceEnd: 3 },
      { id: "s-2", kind: "narration", speakerId: "narrator", text: "世界。", sourceStart: 3, sourceEnd: 6 },
    ],
  };
  return memoryRealm({
    "正文/第0001章_开篇.md": "你好。世界。",
    "有声剧/长夜行/project.json": JSON.stringify(project),
    "有声剧/长夜行/脚本/第0001章_开篇.json": JSON.stringify(script),
  });
}

const fakeRunner = () => ({ run: async () => ({ code: 0, stdout: "", stderr: "" }) });

it("缓存命中不调用 TTS，失败段被记录", async () => {
  const { realm } = fixtureWithScript();
  const binary = memoryBinaryFileStore();
  const fetchImpl = vi.fn(async () => new Response(new Uint8Array([1, 2]), { status: 200, headers: { "content-type": "audio/mpeg" } }));
  const runtime = { tts: new OpenAiCompatibleTtsClient({ fetchImpl: fetchImpl as typeof fetch }), binary, runner: fakeRunner(), now: () => 1_760_000_000_000, env: { OH_STORY_TTS_API_KEY: "k" } };
  const record = await loadAudiobookProject(realm, "有声剧/长夜行/project.json");
  const created = await createChapterJob(realm, record, "第0001章_开篇", runtime);
  const done = await runChapterJob(realm, created.job.id, runtime);
  expect(done.status).toBe("completed");
  expect(done.completedSegments).toBe(created.job.totalSegments);
  const firstRequests = fetchImpl.mock.calls.length;
  expect(firstRequests).toBe(created.job.totalSegments);
  const replay = await createChapterJob(realm, record, "第0001章_开篇", runtime);
  const replayDone = await runChapterJob(realm, replay.job.id, runtime);
  expect(replayDone.status).toBe("completed");
  expect(replayDone.actualRequests).toBe(0);
  expect(fetchImpl.mock.calls.length).toBe(firstRequests);
});

it("TTS 失败段被记录，不写该段缓存", async () => {
  const { realm } = fixtureWithScript();
  const binary = memoryBinaryFileStore();
  const fetchImpl = vi.fn(async () => new Response("bad", { status: 400 }));
  const runtime = { tts: new OpenAiCompatibleTtsClient({ fetchImpl: fetchImpl as typeof fetch }), binary, runner: fakeRunner(), now: () => 1_760_000_000_000, env: { OH_STORY_TTS_API_KEY: "k" } };
  const record = await loadAudiobookProject(realm, "有声剧/长夜行/project.json");
  const created = await createChapterJob(realm, record, "第0001章_开篇", runtime);
  const done = await runChapterJob(realm, created.job.id, runtime);
  expect(done.status).toBe("failed");
  expect(done.failedSegments).toHaveLength(2);
  expect(done.completedSegments).toBe(0);
  expect(binary.files.size).toBe(0);
});
```

Implement fixtures in the test file (or a shared `tests/audiobook-fixtures.ts`) with a project and script. Assert:
- `planChapterJob` returns `cacheHits` and `requests`.
- A second run after cache write issues 0 fetches.
- TTS failure marks `failed`, keeps completed segments, and does not write cache for failed segment.
- Job JSON is under `.oh-story/audiobook/jobs/` and updates atomically (no partial JSON).
- `cancelAudiobookJob` sets paused if running (optional; test via a fake TTS that waits on a promise).

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/dsh-plugin && npx vitest run tests/audiobook-jobs.test.ts`
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement jobs**

- Job path: `${AUDIOBOOK_JOB_ROOT}/${jobId}.json`.
- `createChapterJob`: load project record, load script (throw 409 if missing), compute `planChapterJob`, enforce `chars <= maxCharsPerChapter` (409), create job with `randomUUID()`, status queued, counters, `estimatedCost`, write JSON `createIfAbsent`, return record.
- `planChapterJob`: for each segment, voice = narrator (N4-A; dialogue also uses the narrator voice until N4-B); cache key; `binary.stat` on `segmentAudioPath`; count hits; chars only misses; requests = segments - hits; estimated cost. Throw 503 before planning if `runtime.env.OH_STORY_TTS_API_KEY` is missing.
- `runChapterJob`: load record; set running; for each segment:
  - if canceled flag, set paused and return.
  - cache hit → increment completed.
  - call `runtime.tts.synthesize({...})`; write cache; increment completed/actualRequests.
  - catch error → push `{segmentId, error: message}`; continue; final status failed if any.
  - update job JSON after each segment with `replaceIfVersion`; if CAS conflict, throw 409.
- `cancelAudiobookJob` uses module-level `Map<string, boolean>`; runner checks. For N4-A, cancellation only prevents further segments; test it.
- `loadAudiobookJob` validates id with `^[a-zA-Z0-9-]{1,64}$`, path containment, schema.
- No auto-resume; a running job loaded after restart stays running until N4-D. Document this in code? No comment needed unless non-obvious.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/dsh-plugin && npx vitest run tests/audiobook-jobs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-plugin/src/services/audiobook-jobs.ts packages/dsh-plugin/tests/audiobook-jobs.test.ts
git commit -m "feat(audiobook): 增加章节生成任务与缓存复用"
```

---

## Task 6: ffmpeg 导出、ffprobe 探测与预检

**Files:**
- Create: `packages/dsh-plugin/src/services/audiobook-export.ts`
- Test: `packages/dsh-plugin/tests/audiobook-export.test.ts`

**Interfaces:**
- Consumes: `AudiobookProjectRecord`, `AudiobookScript`, `BinaryFileStore`, `WorkspaceRealm`.
- Produces:
  - `CommandRunner`, `CommandResult`
  - `hostCommandRunner()`
  - `probeTool(runner, tool): Promise<boolean>`
  - `exportChapterMp3(realm, record, chapter, script, runtime): Promise<{ path: string; bytes: number; durationMs: number }>`

- [ ] **Step 1: Write the failing export tests**

```ts
import { describe, expect, it, vi } from "vitest";
import { memoryBinaryFileStore } from "../src/services/audiobook-binary.js";
import { segmentAudioPath, ttsCacheKey } from "../src/services/audiobook-cache.js";
import { exportChapterMp3, probeTool } from "../src/services/audiobook-export.js";
import type { AudiobookProject, AudiobookScript } from "../src/services/audiobook-contract.js";
import { memoryRealm } from "./audiobook-fixtures.js";

const TTS = { baseUrl: "https://api.example.com/v1", model: "tts-1", responseFormat: "mp3" as const, speed: 1, pricePerMillionChars: 15, maxCharsPerChapter: 20000, concurrency: 2 };
const PROJECT: AudiobookProject = {
  schemaVersion: 1,
  source: { bookRoot: "正文", chapters: ["正文/第0001章_开篇.md"] },
  tts: TTS,
  cast: [{ id: "narrator", name: "旁白", kind: "narrator", voice: "alloy" }],
  cues: [],
  export: { mp3BitrateKbps: 192, sampleRate: 44100, channels: 2, loudnessLufs: -16, truePeakDbtp: -1.5, subtitles: [] },
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

function fixture() {
  const realm = memoryRealm();
  const binary = memoryBinaryFileStore();
  for (const segment of SCRIPT.segments) {
    const key = ttsCacheKey({ baseUrl: TTS.baseUrl, model: TTS.model, voice: "alloy", speed: TTS.speed, responseFormat: TTS.responseFormat, text: segment.text });
    binary.files.set(segmentAudioPath(key, "mp3"), new Uint8Array([1, 2, 3]));
  }
  const calls: string[][] = [];
  const runner = {
    run: vi.fn(async (command: string, args: string[]) => {
      calls.push([command, ...args]);
      if (command === "ffmpeg") {
        binary.files.set(args.at(-1)!, new Uint8Array([0x49, 0x44, 0x33]));
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "12.5\n", stderr: "" };
    }),
  };
  const runtime = { tts: {} as never, binary, runner, now: () => 1_760_000_000_000, env: {} };
  return { realm, binary, runner, runtime, calls, record: { project: PROJECT, path: "有声剧/长夜行/project.json", version: "v1" }, script: SCRIPT };
}

it("导出调用 concat demuxer 并返回时长", async () => {
  const { realm, runtime, calls, record, script } = fixture();
  const result = await exportChapterMp3(realm, record, "第0001章_开篇", script, runtime);
  expect(calls[0]?.[0]).toBe("ffmpeg");
  expect(calls[0]).toContain("-f");
  expect(calls[0]).toContain("concat");
  expect(result.durationMs).toBe(12500);
  expect(result.path).toBe("有声剧/长夜行/音频/第0001章_开篇.mp3");
});

it("缺段缓存时拒绝导出", async () => {
  const { realm, runtime, binary, record, script } = fixture();
  binary.files.clear();
  await expect(exportChapterMp3(realm, record, "第0001章_开篇", script, runtime))
    .rejects.toMatchObject({ status: 409 });
});

it("probeTool 在命令失败时返回 false", async () => {
  expect(await probeTool({ run: async () => ({ code: 1, stdout: "", stderr: "no" }) }, "ffmpeg")).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/dsh-plugin && npx vitest run tests/audiobook-export.test.ts`
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement export and preflight**

- `hostCommandRunner` uses `spawn(command, args, { shell: false, windowsHide: true })`, collects stdout/stderr with max buffers, rejects on spawn error, resolves `{code, stdout, stderr}`.
- `probeTool` runs `[tool, "--version"]` with 5s timeout; returns `code === 0`.
- `exportChapterMp3`:
  - Resolve project path, narrator voice, cache keys for each segment; if any cache file missing throw 409 "第N章还没有完整生成。"
  - Write concat list to `.oh-story/audiobook/tmp/<jobKey>.txt` with `file '<binary.processPath(target)>'\n`; escape single quotes as `'\''`.
  - Output target `有声剧/<name>/音频/<chapter>.mp3`; `binary.prepare`.
  - Run `ffmpeg -hide_banner -loglevel error -y -f concat -safe 0 -i <list> -c:a libmp3lame -b:a 192k <output>`.
  - If code !== 0 throw `WorkspaceHttpError(500, "ffmpeg 导出失败：...")` (stderr tail, no secrets).
  - `binary.stat(output)`; missing/0 → 500.
  - `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 <output>`; parse `Number.parseFloat`; if not finite → 500.
  - Remove temp list; return path/bytes/durationMs.
- Tests use a fake binary store with `processPath` and a fake runner that writes output bytes into the store when it sees `ffmpeg`. Add a helper in the test.
- Add an optional real ffmpeg test guarded by `process.env.CI !== "true"`? Better: `it.skipIf(!(await probeTool(hostCommandRunner(), "ffmpeg")))`; but top-level await allowed in Vitest. Use a separate `it.skip` with message. Do not fail if missing; final release gate machine must run real test.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/dsh-plugin && npx vitest run tests/audiobook-export.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-plugin/src/services/audiobook-export.ts packages/dsh-plugin/tests/audiobook-export.test.ts
git commit -m "feat(audiobook): 增加 MP3 导出与 ffmpeg 预检"
```

---

## Task 7: 路由、运行时装配与注册

**Files:**
- Create: `packages/dsh-plugin/src/services/audiobook-route.ts`
- Test: `packages/dsh-plugin/tests/audiobook-route.test.ts`
- Modify: `packages/dsh-plugin/src/services/index.ts` (add `import "./audiobook-route.js";`)

**Interfaces:**
- Consumes: all services from Tasks 1–6; `jsonBody`, `send`, `workspaceRealm`, `WorkspaceHttpError`.
- Produces:
  - `AudiobookRuntime`, `createAudiobookRuntime(realm, env?)`
  - `AudiobookRouteDeps`
  - `handleAudiobookRequest(context, request, response, options, deps?): Promise<boolean>`
  - `registerAudiobookExtension(): void`

- [ ] **Step 1: Write the failing route tests**

Use the same fake context/request/response harness as `tests/continuity-route.test.ts`. Test:
1. `GET /oh-story/audiobook` returns overview, preflight, no secret values.
2. `POST /oh-story/audiobook/project` creates a project; a body with `apiKey` returns 400.
3. `POST /oh-story/audiobook/script` without `confirm` on an existing script returns 400; with confirm succeeds.
4. `POST /oh-story/audiobook/jobs` with `dryRun: true` returns estimate without writing `.oh-story/audiobook/jobs`; without `confirm: true` on a real start returns 400; with confirm returns 202 and a job id.
5. `POST /oh-story/audiobook/export` without confirm returns 400.
6. `GET /oh-story/audiobook/segment-audio?path=../../package.json` returns 403.
7. GET routes perform zero writes.

Inject a fake runtime with fake TTS/runner and a stub `runJob` so no async network runs.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/dsh-plugin && npx vitest run tests/audiobook-route.test.ts`
Expected: FAIL because `audiobook-route.js` does not exist.

- [ ] **Step 3: Implement runtime and routes**

Runtime:
```ts
export interface AudiobookRuntime {
  readonly tts: TtsClient;
  readonly binary: BinaryFileStore;
  readonly runner: CommandRunner;
  readonly now: () => number;
  readonly env: Readonly<Record<string, string | undefined>>;
}
export function createAudiobookRuntime(realm: WorkspaceRealm, env = process.env): AudiobookRuntime {
  return { tts: new OpenAiCompatibleTtsClient(), binary: hostBinaryFileStore(realm), runner: hostCommandRunner(), now: Date.now, env };
}
```
Route deps:
```ts
export interface AudiobookRouteDeps {
  readonly runtime?: (realm: WorkspaceRealm) => AudiobookRuntime;
  readonly runJob?: (realm: WorkspaceRealm, jobId: string, runtime: AudiobookRuntime) => Promise<unknown>;
}
```
Route behavior:
- `GET /overview`: `listAudiobookProjects`, `listAudiobookSources`, preflight:
  - key present if `env.OH_STORY_TTS_API_KEY` non-empty;
  - host from `env.OH_STORY_TTS_BASE_URL` parsed with `validateTtsBaseUrl` (catch → null);
  - ffmpeg/ffprobe via `probeTool`.
  - return `{projects, sources, errors, preflight}`.
- `POST /project`: body `{bookRoot,name,voice,baseUrl?,model?}`; reject secret keys recursively; call create; return 201 `{record}`.
- `GET /project?path=...`: load record; list chapters from `project.source.chapters`; for each, script path exists? `realm.fs.stat`; parse segment count if exists (load script); audio path exists; latest job; return `{record, chapters, preflight}`.
- `PUT /project`: body `{path,baseVersion,project}`; reject secrets; validate; save; return `{record}`.
- `POST /script`: body `{path,chapter,confirm?}`; load project; find chapter in source.chapters; parse; if existing and !confirm → 400; save with overwrite=confirm; return `{script: record}`.
- `POST /jobs`: body `{path,chapter,dryRun?,confirm?}`; load project/script; `planChapterJob`; if dryRun return `{estimate}`; require confirm; create job; `void (deps.runJob ?? runChapterJob)(realm, job.id, runtime).catch(...)`; return 202 `{job,estimate}`.
- `GET /jobs/:id`: `loadAudiobookJob`; return `{job}`.
- `POST /jobs/:id/cancel`: `cancelAudiobookJob`; return `{job}`.
- `POST /export`: body `{path,chapter,confirm}`; require confirm; load script; `exportChapterMp3`; return result.
- `GET /segment-audio?path=...`: path must be under `AUDIOBOOK_CACHE_ROOT` and safe; resolve; binary.read max 50MiB; if undefined 404; content-type from extension; write bytes with `content-type`, `content-length`, `cache-control: no-store`, `x-content-type-options: nosniff`; no range in N4-A.
- Secret rejection helper: recursively walk body, reject keys `/api.?key|authorization|token|secret/i` with 400. Do not reject `tts` fields.
- Map `WorkspaceHttpError`; unknown 500 with generic message and `context.logger`.

Register:
```ts
registerWorkspaceExtension({ name: "audiobook", handle: handleAudiobookRequest });
export function registerAudiobookExtension(): void {}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/dsh-plugin && npx vitest run tests/audiobook-route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-plugin/src/services/audiobook-route.ts packages/dsh-plugin/src/services/index.ts packages/dsh-plugin/tests/audiobook-route.test.ts
git commit -m "feat(audiobook): 增加有声剧路由与运行时"
```

---

## Task 8: 工作台面板、创作目录与备份接入

**Files:**
- Create: `packages/dsh-plugin/src/client/features/audiobook-feature.tsx`
- Create: `packages/dsh-plugin/src/client/features/audiobook-feature.css`
- Modify: `packages/dsh-plugin/src/client/features/index.ts`
- Modify: `packages/dsh-plugin/src/workspace-route.ts` (add `"有声剧"` to `CREATIVE_DIRECTORIES`)
- Modify: `packages/dsh-plugin/src/services/backup.ts` (add `"有声剧"` to `BACKUP_CREATIVE_ROOTS`)
- Test: `packages/dsh-plugin/tests/audiobook-view.test.tsx`

**Interfaces:**
- Consumes: `AudiobookOverview`, `AudiobookProjectView`, `AudiobookCostEstimate`, `endpoint`, `registerWorkbenchFeature`, `WorkbenchFeatureProps`, diagnostics CSS.
- Produces: `AudiobookView`, `AudiobookPanel`; feature `{ id: "audiobook", label: "有声剧", icon: "🎧", workbenches: ["story"] }`.

- [ ] **Step 1: Write the failing view test**

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AudiobookView } from "../src/client/features/audiobook-feature.js";
import type { AudiobookOverview, AudiobookProjectView } from "../src/services/audiobook-contract.js";

const PROJECT = {
  schemaVersion: 1 as const,
  source: { bookRoot: "正文", chapters: ["正文/第0001章_开篇.md"] },
  tts: { baseUrl: "https://api.example.com/v1", model: "tts-1", responseFormat: "mp3" as const, speed: 1, pricePerMillionChars: 15, maxCharsPerChapter: 20000, concurrency: 2 },
  cast: [{ id: "narrator", name: "旁白", kind: "narrator" as const, voice: "alloy" }],
  cues: [],
  export: { mp3BitrateKbps: 192, sampleRate: 44100, channels: 2, loudnessLufs: -16, truePeakDbtp: -1.5, subtitles: [] },
  rights: { voiceCloning: false as const },
};
const overviewWithProject = (): AudiobookOverview => ({
  projects: [{ path: "有声剧/长夜行/project.json", name: "长夜行", bookRoot: "正文", chapters: 1 }],
  sources: [{ bookRoot: "正文", name: "正文", chapters: ["正文/第0001章_开篇.md"] }],
  errors: [],
  preflight: { ttsKey: "present", ttsHost: "api.example.com", ffmpeg: true, ffprobe: true },
});
const projectView = (): AudiobookProjectView => ({
  record: { project: PROJECT, path: "有声剧/长夜行/project.json", version: "v1" },
  chapters: [{
    sourcePath: "正文/第0001章_开篇.md",
    chapter: "第0001章_开篇",
    scriptPath: "有声剧/长夜行/脚本/第0001章_开篇.json",
    hasScript: true,
    segmentCount: 2,
    audioPath: "有声剧/长夜行/音频/第0001章_开篇.mp3",
    jobId: null,
    jobStatus: null,
  }],
  preflight: { ttsKey: "present", ttsHost: "api.example.com", ffmpeg: true, ffprobe: true },
});

it("空项目展示来源与创建入口，缺密钥/缺 ffmpeg 明确提示", () => {
  const html = renderToStaticMarkup(<AudiobookView
    overview={{ projects: [], sources: [{ bookRoot: "正文", name: "正文", chapters: ["正文/第1章.md"] }], errors: [], preflight: { ttsKey: "missing", ttsHost: null, ffmpeg: false, ffprobe: false } }}
    busy={false}
    onRefresh={() => undefined}
    onCreate={() => undefined}
    onParse={() => undefined}
    onDryRun={() => undefined}
    onGenerate={() => undefined}
    onExport={() => undefined}
  />);
  expect(html).toContain("有声剧");
  expect(html).toContain("缺少 OH_STORY_TTS_API_KEY");
  expect(html).toContain("ffmpeg");
  expect(html).toContain("创建项目");
});

it("项目视图展示章节、成本与导出入口", () => {
  const html = renderToStaticMarkup(<AudiobookView
    overview={overviewWithProject()}
    view={projectView()}
    estimate={{ segments: 2, chars: 6, cacheHits: 0, requests: 2, estimatedCost: 0.00009 }}
    busy={false}
    onRefresh={() => undefined}
    onCreate={() => undefined}
    onParse={() => undefined}
    onDryRun={() => undefined}
    onGenerate={() => undefined}
    onExport={() => undefined}
  />);
  expect(html).toContain("第0001章_开篇");
  expect(html).toContain("估算成本");
  expect(html).toContain("导出 MP3");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/dsh-plugin && npx vitest run tests/audiobook-view.test.tsx`
Expected: FAIL because `audiobook-feature.js` does not exist.

- [ ] **Step 3: Implement the pure view and panel**

Pure `AudiobookView`:
- Props: `overview`, `view?`, `estimate?`, `busy`, `notice?`, `error?`, callbacks.
- Render preflight badges with exact text:
  - `缺少 OH_STORY_TTS_API_KEY` when missing.
  - `ffmpeg 未就绪` / `ffprobe 未就绪`.
- Empty state: sources list; name input is local state in panel? Pure view can use uncontrolled inputs only if panel supplies handlers. Keep creation form in panel and pass `createSlot`? Simpler: pure view renders a `<button>创建项目</button>` and calls `onCreate("正文","长夜行","alloy")` with defaults from the first source. The panel can provide a more complete form later. For N4-A, use defaults from source and a voice input in panel. Hmm.
  - Better: `AudiobookView` accepts `draft: {name,voice}` and `onDraftChange`, `onCreate`; test can pass. This adds props but okay.
- Project view: chapter table; for each chapter buttons `解析`, `估算`, `生成`, `导出`; show script state, segments, cost, audio link.
- Use `audio` element with `src={endpoint("media", sessionId, audioPath)}`? The pure view doesn't know sessionId; pass `audioUrl(path)` callback or `sessionId`. Add `sessionId` prop; but view test doesn't need. Use `onPlay(path)` callback instead; panel opens media URL. For N4-A, display `<audio controls src={audioUrl}>` with `audioUrl` callback prop.
- Panel:
  - Load overview on mount; if projects exist, load first project.
  - Create form: source select, name input, voice input; POST `/audiobook/project`; then load.
  - Parse: POST `/audiobook/script` with confirm if script exists (window.confirm).
  - Dry-run/generate/export: POST jobs/export with confirm; show estimate; refresh.
  - Error/notice; request race guard.
- Add CSS using diagnostics styles; keep minimal.
- Registration:
```tsx
registerWorkbenchFeature({ id: "audiobook", label: "有声剧", icon: "🎧", workbenches: ["story"], component: AudiobookPanel });
```
- Add `import "./audiobook-feature.js";` to client features index.
- Add `有声剧` to `CREATIVE_DIRECTORIES` and `BACKUP_CREATIVE_ROOTS`.
- Test that `CREATIVE_DIRECTORIES` includes `有声剧` and `mediaMimeTypeForPath("有声剧/x.mp3")` works (existing test file or new assertion).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/dsh-plugin && npx vitest run tests/audiobook-view.test.tsx`
Expected: PASS.

- [ ] **Step 5: Build and check bundle**

Run: `cd /e/dsh-miaowu && pnpm build && stat -c '%s' packages/dsh-plugin/lib/client.js`
Expected: ≤ 400000 bytes. If over, move panel CSS to shared diagnostics styles and avoid new dependencies; do not raise the budget.

- [ ] **Step 6: Commit**

```bash
git add packages/dsh-plugin/src/client/features/audiobook-feature.tsx packages/dsh-plugin/src/client/features/audiobook-feature.css packages/dsh-plugin/src/client/features/index.ts packages/dsh-plugin/src/workspace-route.ts packages/dsh-plugin/src/services/backup.ts packages/dsh-plugin/tests/audiobook-view.test.tsx
git commit -m "feat(audiobook): 增加有声剧工作台面板"
```

---

## Task 9: 打包冒烟、文档与全量验证

**Files:**
- Modify: `scripts/native-dsh-smoke.ts`
- Modify: `docs/FORK-FEATURES.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/TODO-dsh-miaowu.md`
- Modify: `docs/VALIDATION.md`
- Modify: `CHANGELOG.md`
- Modify: `README.md` / `README_EN.md`

**Interfaces:**
- Consumes: routes from Task 7, panel from Task 8.
- Produces: packaged smoke assertions, docs, verification evidence.

- [ ] **Step 1: Add packaged smoke probes**

In the story session section, add:
- `GET /oh-story/audiobook?sessionId=...` → 200, `preflight.ttsKey` is `"missing"` or `"present"`, `preflight.ffmpeg` boolean, `sources` array; response text does not contain the environment key value or an absolute home path.
- Browser: click `有声剧`, wait for heading/text `有声剧`, assert `缺少 OH_STORY_TTS_API_KEY` or preflight text, and no error. Do not create a project or call TTS in N4-A smoke.

- [ ] **Step 2: Update docs**

- `docs/FORK-FEATURES.md`: add a 「有声剧（N4-A）」 subsection with scope, env vars, cache semantics, ffmpeg requirement, and explicit limits (single narrator; no BGM/M4B yet).
- `docs/ARCHITECTURE.md`: add `audiobook-*` service/routes/panel and binary store; state no host-state writes.
- `docs/TODO-dsh-miaowu.md`: add N4-A delivered + N4-B/C/D pending; mention P3 remains gated.
- `docs/VALIDATION.md`: add an audit section with exact test counts, bundle size, smokes, and limitations.
- `CHANGELOG.md`: add bullet for N4-A.
- README/README_EN: add capability bullet and `OH_STORY_TTS_*` environment variables.

- [ ] **Step 3: Run full verification**

```bash
cd /e/dsh-miaowu
pnpm verify
stat -c '%s' packages/dsh-plugin/lib/client.js
```

Expected: exit 0; all tests pass; bundle ≤ 400000.

- [ ] **Step 4: Run both packaged smokes**

```bash
pnpm test:dsh
pnpm test:dsh:rc
```

Expected: both `"ok": true`.

- [ ] **Step 5: Commit**

```bash
git add scripts/native-dsh-smoke.ts docs/FORK-FEATURES.md docs/ARCHITECTURE.md docs/TODO-dsh-miaowu.md docs/VALIDATION.md CHANGELOG.md README.md README_EN.md
git commit -m "docs(audiobook): 补齐 N4-A 验证与使用说明"
```

---

## Task 10: 独立审查与收尾

**Files:**
- Review the diff from Task 1–9; fix findings in place.
- Test: all touched suites.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: review-fixed code, final verification, no push.

- [ ] **Step 1: Generate a review diff**

```bash
# N4-A 从设计文档提交 7fb9bf9 之后开始；若实施期间另有独立提交，替换为实际起点。
git diff 7fb9bf9 HEAD > /tmp/n4a-review.diff
```

- [ ] **Step 2: Dispatch an independent reviewer**

Review focus:
- TTS request only standard fields; no key leakage in logs/errors/cache/manifest.
- `baseUrl` SSRF rules; no redirect; no credentials.
- Cache key correctness and rerun zero-request behavior.
- Job atomic updates, cancel/pause, no duplicate charging.
- Export blocks on missing cache/ffmpeg; no partial output.
- `有声剧/` allowlist and backup integration; no host-state writes.
- UI confirmation gates and error visibility.
- Tests are real assertions, not vacuous.

- [ ] **Step 3: Fix findings and re-run targeted tests**

For each finding, add or adjust a failing test first, then fix. Re-run:
```bash
cd packages/dsh-plugin && npx vitest run tests/audiobook-*.test.ts tests/audiobook-view.test.tsx
```

- [ ] **Step 4: Final full verification**

```bash
cd /e/dsh-miaowu && pnpm verify
pnpm test:dsh
pnpm test:dsh:rc
```

- [ ] **Step 5: Commit fixes**

```bash
git add packages/dsh-plugin/src/services/audiobook-contract.ts packages/dsh-plugin/src/services/audiobook-project.ts packages/dsh-plugin/src/services/audiobook-script.ts packages/dsh-plugin/src/services/audiobook-binary.ts packages/dsh-plugin/src/services/audiobook-cache.ts packages/dsh-plugin/src/services/audiobook-tts.ts packages/dsh-plugin/src/services/audiobook-jobs.ts packages/dsh-plugin/src/services/audiobook-export.ts packages/dsh-plugin/src/services/audiobook-route.ts packages/dsh-plugin/src/services/index.ts packages/dsh-plugin/src/client/features/audiobook-feature.tsx packages/dsh-plugin/src/client/features/audiobook-feature.css packages/dsh-plugin/src/client/features/index.ts packages/dsh-plugin/src/workspace-route.ts packages/dsh-plugin/src/services/backup.ts packages/dsh-plugin/tests/audiobook-project.test.ts packages/dsh-plugin/tests/audiobook-script.test.ts packages/dsh-plugin/tests/audiobook-cache.test.ts packages/dsh-plugin/tests/audiobook-tts.test.ts packages/dsh-plugin/tests/audiobook-jobs.test.ts packages/dsh-plugin/tests/audiobook-export.test.ts packages/dsh-plugin/tests/audiobook-route.test.ts packages/dsh-plugin/tests/audiobook-view.test.tsx scripts/native-dsh-smoke.ts docs/FORK-FEATURES.md docs/ARCHITECTURE.md docs/TODO-dsh-miaowu.md docs/VALIDATION.md CHANGELOG.md README.md README_EN.md
git commit -m "fix(audiobook): 处理 N4-A 审查发现"
```

Do not push, tag, publish, or create a Release.

---

## N4-A 完成标准

- 单章、单旁白音色从正文解析到 MP3 导出可用。
- 同一章重跑缓存全命中，TTS 请求数为 0。
- dry-run 成本可见；无密钥泄漏；GET 路由零写入。
- TTS 失败、缺脚本、缺缓存、缺 ffmpeg 都有结构化错误，不写半成品。
- `pnpm verify`、双宿主冒烟、包体预算全绿。
- N4-B（多角色）、N4-C（BGM/时间轴/字幕/M4B）、N4-D（整书批量）不在本计划内。
