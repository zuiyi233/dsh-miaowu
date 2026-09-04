import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import type { FileSystem, FsDirEntry, FsInfo, FsTarget, FsVersion } from "@deepseek-ai/dsh-fs";
import { describe, expect, it } from "vitest";
import { pinyinInitials, pinyinize, PINYIN_MAP } from "../src/services/pinyin-map.js";
import {
  buildFileIndex,
  ensureFreshIndex,
  handleSearchRequest,
  lineHitOffset,
  matchLines,
  parseLimit,
  rankHits,
  rebuildAll,
  refreshSingleFile,
  searchablePath,
  searchIndexes,
  searchWorkspace,
  type SearchFileIndex,
} from "../src/services/search.js";
import type { WorkspaceRealm } from "../src/workspace-route.js";

type MemoryFs = Pick<
  FileSystem,
  "resolve" | "contains" | "stat" | "listDir" | "readBytes" | "writeText"
>;

interface MemoryFile {
  content: string;
  version: string;
}

function versionOf(raw: string): FsVersion {
  return raw as unknown as FsVersion;
}

function targetOf(path: string): FsTarget {
  return { targetKey: path as FsTarget["targetKey"], displayPath: path };
}

/** 轻量内存 fs: key 为 workspace 相对路径(根用 ""), 覆盖 search 所需六方法. */
function memoryFs(seed: Readonly<Record<string, string>> = {}): { fs: MemoryFs; files: Map<string, MemoryFile> } {
  const files = new Map<string, MemoryFile>();
  let clock = 1;
  for (const [path, content] of Object.entries(seed)) files.set(path, { content, version: `v${String(clock++)}` });

  // workspace 坐标系: 相对路径按 cwd 解析为 "ws/..." 绝对键, 与 resolve(cwd) 的 root 同坐标.
  const normalize = (path: string, cwd?: string): string => {
    const cwdParts = (cwd ?? "").replace(/^\/+/, "").split("/").filter((part) => part !== "");
    const parts: string[] = path.startsWith("/") ? [] : [...cwdParts];
    for (const segment of path.split("/")) {
      if (segment === "" || segment === ".") continue;
      if (segment === "..") parts.pop();
      else parts.push(segment);
    }
    return parts.join("/");
  };

  const infoOf = (path: string): FsInfo | undefined => {
    if (files.has(path)) {
      const file = files.get(path)!;
      return { version: versionOf(file.version), type: "file", size: Buffer.byteLength(file.content) };
    }
    const prefix = path === "" ? "" : `${path}/`;
    for (const key of files.keys()) {
      if (path === "" || key.startsWith(prefix)) return { version: versionOf("dir"), type: "directory" };
    }
    return undefined;
  };

  const fs: MemoryFs = {
    resolve: async (path: string, options?: { readonly cwd?: string }): Promise<FsTarget> =>
      targetOf(normalize(path, options?.cwd)),
    contains: (parent: FsTarget, child: FsTarget): boolean => {
      if (parent.displayPath === "") return true;
      const root = parent.displayPath.replace(/^\/+/, "").replace(/\/+$/, "");
      const candidate = child.displayPath.replace(/^\/+/, "");
      return candidate === root || candidate.startsWith(`${root}/`);
    },
    stat: async (target: FsTarget): Promise<FsInfo | undefined> =>
      infoOf(target.displayPath.replace(/^\/+/, "")),
    listDir: async (target: FsTarget): Promise<FsDirEntry[]> => {
      const dir = target.displayPath.replace(/^\/+/, "").replace(/\/+$/, "");
      const prefix = dir === "" ? "" : `${dir}/`;
      const children = new Map<string, { type: "file" | "directory"; target: FsTarget }>();
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash < 0) {
          children.set(rest, { type: "file", target: targetOf(key) });
        } else {
          const name = rest.slice(0, slash);
          if (name !== "" && !children.has(name)) {
            children.set(name, { type: "directory", target: targetOf(`${prefix}${name}`) });
          }
        }
      }
      return [...children.entries()].map(([name, entry]) => ({ name, type: entry.type, target: entry.target }));
    },
    readBytes: async (target: FsTarget, _signal: AbortSignal | undefined, _max: number): Promise<Uint8Array> => {
      void _signal;
      void _max;
      const file = files.get(target.displayPath.replace(/^\/+/, ""));
      if (file === undefined) throw new Error("FS_NOT_FOUND");
      return new TextEncoder().encode(file.content);
    },
    writeText: async (target: FsTarget, content: string) => {
      const path = target.displayPath.replace(/^\/+/, "");
      const before = files.get(path)?.content ?? null;
      const version = `v${String(clock++)}`;
      files.set(path, { content, version });
      return { operation: before === null ? "create" : "update", version: versionOf(version), before, after: content } as const;
    },
  };
  return { fs, files };
}

const CWD = "/ws";
const WS = "ws";

function realmFor(fs: MemoryFs): WorkspaceRealm {
  return { agent: {}, fs: fs as unknown as FileSystem, sandboxPolicy: {}, cwd: CWD, root: targetOf(WS) } as unknown as WorkspaceRealm;
}

function fakeContext(fs: MemoryFs): Context {
  const agent = {
    session: { header: { cwd: CWD } },
    ctx: {
      get: (key: string): unknown => {
        if (key === "fs") return fs;
        if (key === "sandboxPolicy") return {};
        return undefined;
      },
    },
  };
  return {
    typer: undefined,
    // workspace-route.ts 经 context.typert.lookups 取 agent, 此处按其真实键名伪造.
    typert: { lookups: { get: () => ({ resolve: async (): Promise<unknown> => agent }) } },
    logger: () => (): void => undefined,
  } as unknown as Context;
}

interface CapturedResponse {
  status?: number;
  body?: unknown;
}

async function callRoute(
  fs: MemoryFs,
  method: string,
  url: string
): Promise<CapturedResponse> {
  const captured: CapturedResponse = {};
  const request = { method, url, headers: {} } as unknown as IncomingMessage;
  const response = {
    writeHead: (status: number): void => { captured.status = status; },
    end: (body?: string): void => {
      captured.body = body === undefined || body === "" ? undefined : JSON.parse(body) as unknown;
    },
  } as unknown as ServerResponse;
  const handled = await handleSearchRequest(fakeContext(fs), request, response, { maxBytes: 2 * 1024 * 1024 });
  expect(handled).toBe(true);
  return captured;
}

function seedWorkspace(): { fs: MemoryFs; files: Map<string, MemoryFile> } {
  // 内存 key 用 workspace 绝对坐标("ws/..." ), search 侧的 path/meta 仍是相对路径.
  return memoryFs({
    "ws/正文/第001章.md": ["金瓶梅开篇", "西门庆登场", "金莲绣鞋"].join("\n"),
    "ws/大纲/主线.md": ["# 主线", "金莲人物小传", "伏笔一览"].join("\n"),
    "ws/设定/人物.json": JSON.stringify({ name: "潘金莲" }),
    "ws/拆文库/拆书A.md": ["拆书记录", "金字塔结构"].join("\n"),
    "ws/.oh-story/index/meta.json": JSON.stringify({}),
    "ws/video-recaps/某项目/正文.md": ["金藏视频目录"].join("\n"),
    "ws/game-adaptations/demo/设定.md": ["金藏游戏目录"].join("\n"),
  });
}

describe("searchablePath", () => {
  it("accepts creative roots plus 拆文库 text files", () => {
    expect(searchablePath("正文/第001章.md")).toBe(true);
    expect(searchablePath("拆文库/拆书A.md")).toBe(true);
    expect(searchablePath("设定/人物.json")).toBe(true);
  });

  it("skips hidden paths, oversized media dirs, and non-text types", () => {
    expect(searchablePath(".oh-story/index/meta.json")).toBe(false);
    expect(searchablePath("video-recaps/某项目/正文.md")).toBe(false);
    expect(searchablePath("game-adaptations/demo/设定.md")).toBe(false);
    expect(searchablePath("正文/封面.png")).toBe(false);
    expect(searchablePath("随笔/杂记.md")).toBe(false);
  });
});

describe("pinyin-map", () => {
  it("covers the fixture characters and transcribes initials", () => {
    expect(PINYIN_MAP["金"]).toBe("jin");
    expect(PINYIN_MAP["瓶"]).toBe("ping");
    expect(PINYIN_MAP["梅"]).toBe("mei");
    expect(pinyinize("金瓶梅")).toBe("jinpingmei");
    expect(pinyinInitials("金瓶梅")).toBe("jpm");
    expect(pinyinize("金莲 ABC")).toContain("jinlian");
  });
});

describe("matchLines", () => {
  const lines = ["金瓶梅开篇", "西门庆登场", "nothing here", "金莲绣鞋"];

  it("reports 1-based lines with char offsets", () => {
    const hits = matchLines(lines, "金", "正文/a.md");
    expect(hits.map((hit) => hit.line)).toEqual([1, 4]);
    expect(hits[0]).toMatchObject({ path: "正文/a.md", text: "金瓶梅开篇", via: "text" });
    expect(hits[0]?.offset).toBe(lineHitOffset(lines, 0, 0));
    expect(hits[1]?.offset).toBe(lineHitOffset(lines, 3, 0));
  });

  it("matches case-insensitively and via pinyin channels", () => {
    expect(matchLines(["Jin Ping Mei"], "jin", "x.md")).toHaveLength(1);
    const full = matchLines(lines, "jin", "正文/a.md");
    expect(full.length).toBeGreaterThan(0);
    expect(full.every((hit) => hit.via === "pinyin")).toBe(true);
    const initials = matchLines(["金瓶梅开篇"], "jpm", "正文/a.md");
    expect(initials[0]).toMatchObject({ line: 1, via: "pinyin" });
  });

  it("dedupes lines hit by both channels", () => {
    const hits = matchLines(["金jin混排"], "jin", "x.md");
    expect(hits.filter((hit) => hit.line === 1)).toHaveLength(1);
  });
});

describe("rankHits", () => {
  it("puts hit-dense files first and keeps line order within a file", () => {
    const hits = [
      { path: "b.md", line: 9, text: "t", offset: 0, via: "text" as const },
      { path: "a.md", line: 5, text: "t", offset: 0, via: "text" as const },
      { path: "a.md", line: 2, text: "t", offset: 0, via: "text" as const },
    ];
    const ranked = rankHits(hits, 10);
    expect(ranked.map((hit) => `${hit.path}:${String(hit.line)}`)).toEqual(["a.md:2", "a.md:5", "b.md:9"]);
  });
});

describe("index lifecycle", () => {
  it("builds per-file indexes and refreshes them on version change", async () => {
    const { fs } = seedWorkspace();
    const realm = realmFor(fs);
    const first = await buildFileIndex(realm, "正文/第001章.md");
    expect(first?.lines[0]).toBe("金瓶梅开篇");
    const same = await ensureFreshIndex(realm, "正文/第001章.md", first);
    expect(same).toBe(first);
    const target = await (fs as MemoryFs).resolve("正文/第001章.md", { cwd: CWD });
    await (fs as MemoryFs).writeText(target, ["金瓶梅开篇", "新增武松登场"].join("\n"));
    const refreshed = await ensureFreshIndex(realm, "正文/第001章.md", first);
    expect(refreshed).not.toBe(first);
    expect(refreshed?.lines).toContain("新增武松登场");
  });

  it("rebuilds the workspace and refreshes a single file", async () => {
    const { fs } = seedWorkspace();
    const realm = realmFor(fs);
    const count = await rebuildAll(realm);
    // 4 个可索引文件(正文/大纲/设定/拆文库), 视频与游戏目录被跳过.
    expect(count).toBe(4);
    const single = await refreshSingleFile(realm, "大纲/主线.md");
    expect(single?.path).toBe("大纲/主线.md");
    expect(await refreshSingleFile(realm, "video-recaps/某项目/正文.md")).toBeUndefined();
  });

  it("searches across documents with the agreed ranking", async () => {
    const { fs } = seedWorkspace();
    const realm = realmFor(fs);
    await rebuildAll(realm);
    const outcome = await searchWorkspace(realm, "金", 200);
    expect(outcome.total).toBeGreaterThan(0);
    // 正文命中 2 行 > 其他文件, 应排在最前且行序递增.
    expect(outcome.hits[0]?.path).toBe("正文/第001章.md");
    expect(outcome.hits[0]?.line).toBe(1);
    expect(outcome.hits[1]).toMatchObject({ path: "正文/第001章.md", line: 3 });
    expect(outcome.hits.some((hit) => hit.path === "拆文库/拆书A.md")).toBe(true);
    expect(outcome.hits.some((hit) => hit.path.startsWith("video-recaps"))).toBe(false);
  });

  it("picks up fresh content lazily after an external write", async () => {
    const { fs } = seedWorkspace();
    const realm = realmFor(fs);
    await rebuildAll(realm);
    expect((await searchWorkspace(realm, "武松", 200)).total).toBe(0);
    const target = await fs.resolve("正文/第001章.md", { cwd: CWD });
    await fs.writeText(target, ["金瓶梅开篇", "武松打虎"].join("\n"));
    const outcome = await searchWorkspace(realm, "武松", 200);
    expect(outcome.total).toBe(1);
    expect(outcome.hits[0]).toMatchObject({ path: "正文/第001章.md", line: 2 });
  });

  it("supports pinyin queries, file filters, and empty results", async () => {
    const { fs } = seedWorkspace();
    const realm = realmFor(fs);
    await rebuildAll(realm);
    const pinyin = await searchWorkspace(realm, "jin", 200);
    expect(pinyin.total).toBeGreaterThan(0);
    expect(pinyin.hits[0]?.via).toBe("pinyin");
    const upper = await searchWorkspace(realm, "JIN", 200);
    expect(upper.total).toBe(pinyin.total);
    const filtered = await searchWorkspace(realm, "金", 200, "大纲");
    expect(filtered.hits.every((hit) => hit.path.includes("大纲"))).toBe(true);
    const indexes = new Map<string, SearchFileIndex>();
    expect(searchIndexes(indexes, "金", 10)).toEqual([]);
    expect(parseLimit(null)).toBe(200);
    expect(parseLimit("5")).toBe(5);
  });
});

describe("search routes", () => {
  it("rejects empty queries with 400 and returns hits otherwise", async () => {
    const { fs } = seedWorkspace();
    const empty = await callRoute(fs, "GET", "/oh-story/search?sessionId=s&q=%20");
    expect(empty.status).toBe(400);
    const ok = await callRoute(fs, "GET", "/oh-story/search?sessionId=s&q=%E9%87%91");
    expect(ok.status).toBe(200);
    const body = ok.body as { total: number; hits: { path: string; line: number }[] };
    expect(body.total).toBeGreaterThan(0);
    expect(body.hits[0]?.line).toBeGreaterThanOrEqual(1);
  });

  it("exposes explicit index and rebuild routes", async () => {
    const { fs } = seedWorkspace();
    const indexed = await callRoute(fs, "POST", "/oh-story/search/index?sessionId=s&path=%E5%A4%A7%E7%BA%B2%2F%E4%B8%BB%E7%BA%BF.md");
    expect(indexed.status).toBe(200);
    const rebuilt = await callRoute(fs, "POST", "/oh-story/search/rebuild?sessionId=s");
    expect(rebuilt.status).toBe(200);
    expect((rebuilt.body as { files: number }).files).toBe(4);
    // 非白名单路径: creativeTarget 抛 403(直调时透出异常); 白名单内但缺失: 返回 404.
    await expect(callRoute(fs, "POST", "/oh-story/search/index?sessionId=s&path=%E4%B8%8D%E5%AD%98%E5%9C%A8.md")).rejects.toThrow();
    const gone = await callRoute(fs, "POST", "/oh-story/search/index?sessionId=s&path=%E6%AD%A3%E6%96%87%2F%E7%BC%BA%E5%A4%B1.md");
    expect(gone.status).toBe(404);
  });

  it("indexes ~100KB of prose well within the 2s budget", async () => {
    const paragraph = "金瓶梅开篇西门庆登场金莲绣鞋伏笔场景主角时间线人物设定大纲追踪对标参考剧集交付审查";
    const lines: string[] = [];
    for (let i = 0; i < 2800; i += 1) lines.push(`第${String(i + 1)}行${paragraph}`);
    const content = lines.join("\n");
    expect(Buffer.byteLength(content)).toBeGreaterThan(100 * 1024);
    const { fs } = memoryFs({
      "ws/正文/长篇.md": content,
      "ws/.oh-story/index/meta.json": JSON.stringify({}),
    });
    const realm = realmFor(fs);
    const outcome = await searchWorkspace(realm, "伏笔", 200);
    expect(outcome.total).toBeGreaterThan(0);
    expect(outcome.tookMs).toBeLessThan(2000);
  });
});
