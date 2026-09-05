import { describe, expect, it, vi } from "vitest";
import type { FileSystem, FsInfo, FsTarget, FsVersion } from "@deepseek-ai/dsh-fs";
import {
  assertCreativePath,
  creativeTarget,
  discoverBookDirectories,
  isBookNestedStoryPath,
  listFiles,
  type WorkspaceRealm,
} from "../src/workspace-route.js";
import { discoverWorks } from "../src/services/bookshelf.js";
import { creativeRelativePath, workbenchModeForPath } from "../src/client/file-activity.js";

const CWD = "/work/demo";

function target(displayPath: string): FsTarget {
  return { targetKey: displayPath as FsTarget["targetKey"], displayPath };
}

function version(value: string): FsVersion {
  return value as FsVersion;
}

/** 内存 FileSystem:与 bookshelf.test.ts 同构,listDir 同时返回文件与目录条目。 */
function setup(initial: Record<string, string> = {}): WorkspaceRealm {
  const store = new Map<string, { content: string; version: string }>();
  let counter = 0;
  const nextVersion = (): string => {
    counter += 1;
    return `v${String(counter)}`;
  };
  const keyOf = (path: string, cwd?: string): string => (path.startsWith("/") ? path : `${cwd ?? CWD}/${path}`);
  for (const [path, content] of Object.entries(initial)) {
    store.set(keyOf(path), { content, version: nextVersion() });
  }
  const fs = {
    resolve: vi.fn(async (path: string, options?: { readonly cwd?: string }): Promise<FsTarget> =>
      target(keyOf(path, options?.cwd))),
    contains: vi.fn(
      (parent: FsTarget, child: FsTarget): boolean =>
        child.displayPath === parent.displayPath || child.displayPath.startsWith(`${parent.displayPath}/`)
    ),
    stat: vi.fn(async (entry: FsTarget): Promise<FsInfo | undefined> => {
      const hit = store.get(entry.displayPath);
      if (hit !== undefined) {
        return { type: "file", version: version(hit.version), size: Buffer.byteLength(hit.content) };
      }
      const prefix = `${entry.displayPath}/`;
      for (const key of store.keys()) {
        if (key.startsWith(prefix)) return { type: "directory", version: version("dir") };
      }
      return undefined;
    }),
    listDir: vi.fn(async (entry: FsTarget) => {
      const prefix = `${entry.displayPath}/`;
      const files = new Set<string>();
      const dirs = new Set<string>();
      for (const key of store.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash < 0) files.add(rest);
        else dirs.add(rest.slice(0, slash));
      }
      return [
        ...[...dirs].map((name) => ({ name, type: "directory" as const, target: target(`${prefix}${name}`) })),
        ...[...files].map((name) => ({
          name,
          type: "file" as const,
          target: target(`${prefix}${name}`),
          version: version("v-list"),
          size: 8,
        })),
      ];
    }),
  } as unknown as FileSystem;
  return { fs, cwd: CWD, root: target(CWD) } as unknown as WorkspaceRealm;
}

const NESTED: Record<string, string> = {
  "齐天道君/正文/第001章.md": "# 第一章",
  "齐天道君/大纲/主线.md": "# 主线",
  "齐天道君/追踪/进度.md": "# 进度",
  "另一本书/追踪/状态.md": "# 状态",
  "正文/根小说/开篇.md": "# 开篇",
};

describe("书名目录探测边界", () => {
  it("含 正文/ 认、含 追踪/ 认、都没有不认、文件不是目录不认", async () => {
    const realm = setup({
      "有正文/正文/第一章.md": "x",
      "有追踪/追踪/进度.md": "x",
      "空书/大纲/只有大纲.md": "x",
      "文件书": "我是一个文件,不是目录",
      ".隐藏书/正文/第一章.md": "x",
    });
    expect(await discoverBookDirectories(realm)).toEqual(["有正文", "有追踪"]);
  });

  it("根白名单目录即使含标记也不算书名目录", async () => {
    const realm = setup({ "正文/追踪/嵌套.md": "x" });
    expect(await discoverBookDirectories(realm)).toEqual([]);
  });

  it("isBookNestedStoryPath 只认两段形状,不做存在性判定", () => {
    expect(isBookNestedStoryPath("齐天道君/正文/第001章.md")).toBe(true);
    expect(isBookNestedStoryPath("齐天道君/追踪/进度.md")).toBe(true);
    expect(isBookNestedStoryPath("随便/非法/路径")).toBe(false);
    expect(isBookNestedStoryPath("正文/第001章.md")).toBe(false);
    expect(isBookNestedStoryPath("齐天道君/game-adaptations/x.md")).toBe(false);
    expect(isBookNestedStoryPath("齐天道君")).toBe(false);
  });
});

describe("listFiles 与守卫", () => {
  it("发现 齐天道君/正文/... 嵌套文件,保持自然两段路径", async () => {
    const paths = (await listFiles(setup(NESTED))).map((file) => file.path);
    expect(paths).toContain("齐天道君/正文/第001章.md");
    expect(paths).toContain("齐天道君/大纲/主线.md");
    expect(paths).toContain("另一本书/追踪/状态.md");
  });

  it("多书并存都要发现,根白名单原行为不变", async () => {
    const paths = (await listFiles(setup(NESTED))).map((file) => file.path);
    expect(paths).toContain("正文/根小说/开篇.md");
    expect(paths.filter((path) => path.startsWith("齐天道君/"))).toHaveLength(3);
  });

  it("assertCreativePath 放行合法两段、拒绝非法两段", () => {
    expect(() => { assertCreativePath("齐天道君/正文/第001章.md", "text"); }).not.toThrow();
    expect(() => { assertCreativePath("齐天道君/追踪/进度.md", "text"); }).not.toThrow();
    expect(() => { assertCreativePath("随便/非法/路径.md", "text"); }).toThrow();
    expect(() => { assertCreativePath("正文/第001章.md", "text"); }).not.toThrow();
    expect(() => { assertCreativePath("short-drama.json", "text"); }).not.toThrow();
  });

  it("creativeTarget 对不存在的书名目录仍拒绝", async () => {
    const realm = setup(NESTED);
    await expect(creativeTarget(realm, "齐天道君/正文/第001章.md")).resolves.toBeDefined();
    await expect(creativeTarget(realm, "随便/非法/路径.md")).rejects.toThrow();
    await expect(creativeTarget(realm, "鬼书/正文/第一章.md")).rejects.toThrow();
  });
});

describe("书架发现书名目录小说", () => {
  it("书名/正文/ 下的子目录按小说发现,剧集规则不变", async () => {
    const discovered = await discoverWorks(setup({
      ...NESTED,
      "齐天道君/正文/长篇卷/第一章.md": "x",
      "另一本书/正文/短篇集/序.md": "x",
      "剧集/短剧A/分镜.md": "x",
    }));
    expect(discovered).toContainEqual({ kind: "novel", name: "长篇卷", path: "齐天道君/正文/长篇卷" });
    expect(discovered).toContainEqual({ kind: "novel", name: "短篇集", path: "另一本书/正文/短篇集" });
    expect(discovered).toContainEqual({ kind: "novel", name: "根小说", path: "正文/根小说" });
    expect(discovered).toContainEqual({ kind: "drama", name: "短剧A", path: "剧集/短剧A" });
  });
});

describe("前端两段识别", () => {
  const books = ["齐天道君", "另一本书"];

  it("名单命中时认两段,缺失名单时不认(不自行猜测)", () => {
    expect(creativeRelativePath("齐天道君/正文/第001章.md", CWD, books)).toBe("齐天道君/正文/第001章.md");
    expect(creativeRelativePath(`${CWD}/另一本书/追踪/状态.md`, CWD, books)).toBe("另一本书/追踪/状态.md");
    expect(creativeRelativePath("齐天道君/正文/第001章.md", CWD)).toBeUndefined();
    expect(creativeRelativePath("随便/非法/路径.md", CWD, books)).toBeUndefined();
    expect(workbenchModeForPath("齐天道君/正文/第001章.md", books)).toBe("story");
    expect(workbenchModeForPath("齐天道君/正文/第001章.md")).toBeUndefined();
  });

  it("根白名单行为不变,旧的两参数调用照常工作", () => {
    expect(creativeRelativePath("正文/第001章.md", CWD, books)).toBe("正文/第001章.md");
    expect(workbenchModeForPath("正文/第001章.md")).toBe("story");
    expect(workbenchModeForPath("剧集/EP001/剧本.md")).toBe("drama");
  });
});
