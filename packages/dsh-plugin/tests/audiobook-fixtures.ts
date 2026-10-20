import { FsError, type FileSystem, type FsDirEntry, type FsInfo, type FsTarget, type FsVersion, type FsWriteIntent, type FsWriteOutcome } from "@deepseek-ai/dsh-fs";
import type { WorkspaceRealm } from "../src/workspace-route.js";

/**
 * 有声剧测试共用的内存 FileSystem。
 *
 * 与 continuity.test.ts 的内存 fs 同形：文件以 workspace 相对坐标存储，写入逐条记录，
 * 供"只读/只写某路径"类断言使用。与 brief 原稿相比做了三处贴近真实后端的修正，
 * 否则根目录枚举恒为空、发现逻辑无法被测试：
 * 1) `contains`:空 displayPath 表示工作区根，包含一切（与 continuity 内存 fs 一致）；
 * 2) `stat`/`listDir`:根目录的路径前缀是空串而不是 "/"；
 * 3) 写入用真实 `FsError` 抛 FS_STALE_VERSION/FS_NOT_OBSERVED，让 mapFsError 能识别。
 * `processPath` 与真实 FileSystem 语义一致，返回 target 的展示路径。
 */

const CWD = "/books/demo";

type MemoryFs = Pick<
  FileSystem,
  "resolve" | "contains" | "stat" | "listDir" | "readBytes" | "writeText" | "processPath"
>;

export interface MemoryRealm {
  readonly realm: WorkspaceRealm;
  /** 按写入顺序记录的 workspace 相对路径。 */
  readonly writes: string[];
  readonly read: (path: string) => string | undefined;
}

/** 有声剧各测试复用的两章正文语料。 */
export const CHAPTERS: Record<string, string> = {
  "正文/第0001章_开篇.md": "旁白。\n\n“你好。”他说。\n",
  "正文/第0002章_回声.md": "第二章。\n",
};

export function memoryRealm(seed: Record<string, string> = {}): MemoryRealm {
  const files = new Map<string, { content: string; version: string }>();
  const writes: string[] = [];
  let clock = 0;
  const next = (): FsVersion => `v${String(++clock)}` as FsVersion;
  for (const [path, content] of Object.entries(seed)) files.set(path, { content, version: String(next()) });
  const info = (path: string): FsInfo | undefined => {
    const file = files.get(path);
    if (file !== undefined) return { type: "file", version: file.version as FsVersion, size: Buffer.byteLength(file.content) };
    const prefix = path === "" ? "" : `${path}/`;
    for (const key of files.keys()) if (key.startsWith(prefix)) return { type: "directory", version: "dir" as FsVersion };
    return undefined;
  };
  const fs = {
    resolve: async (path: string): Promise<FsTarget> => ({
      targetKey: path.replace(/^\/+/u, "") as FsTarget["targetKey"],
      displayPath: path.replace(/^\/+/u, ""),
    }),
    contains: (parent: FsTarget, child: FsTarget): boolean =>
      parent.displayPath === ""
      || child.displayPath === parent.displayPath
      || child.displayPath.startsWith(`${parent.displayPath}/`),
    stat: async (target: FsTarget): Promise<FsInfo | undefined> => info(target.displayPath),
    listDir: async (target: FsTarget): Promise<FsDirEntry[]> => {
      const prefix = target.displayPath === "" ? "" : `${target.displayPath}/`;
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
      if (file === undefined) throw new FsError("读不到文件", "FS_NOT_FOUND");
      return new TextEncoder().encode(file.content);
    },
    writeText: async (target: FsTarget, content: string, expected?: FsWriteIntent): Promise<FsWriteOutcome> => {
      const current = files.get(target.displayPath);
      if (expected?.kind === "createIfAbsent" && current !== undefined) throw new FsError("文件已存在", "FS_NOT_OBSERVED");
      if (expected?.kind === "replaceIfVersion" && (current === undefined || current.version !== String(expected.version))) {
        throw new FsError("版本已过期", "FS_STALE_VERSION");
      }
      const version = String(next());
      files.set(target.displayPath, { content, version });
      writes.push(target.displayPath);
      return { operation: current === undefined ? "create" : "update", version: version as FsVersion, before: current?.content ?? null, after: content };
    },
    processPath: (target: FsTarget): string => target.displayPath,
  } as unknown as MemoryFs;
  return {
    realm: { fs: fs as FileSystem, cwd: CWD, root: { targetKey: "" as FsTarget["targetKey"], displayPath: "" } } as unknown as WorkspaceRealm,
    writes,
    read: (path) => files.get(path)?.content,
  };
}
