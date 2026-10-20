import type { FileSystem, FsDirEntry, FsInfo, FsTarget, FsVersion } from "@deepseek-ai/dsh-fs";
import { describe, expect, it } from "vitest";
import {
  buildStateInventory,
  type StateInventoryRealm,
} from "../src/services/state-inventory.js";
import {
  STATE_DESCRIPTORS,
  type StateInventory,
  type StateInventoryEntry,
} from "../src/services/state-contract.js";

type MemoryFs = Pick<FileSystem, "resolve" | "contains" | "stat" | "listDir" | "readBytes" | "writeText">;

interface MemoryFile {
  content: string;
  version: string;
}

interface MemoryWorkspace {
  readonly fs: MemoryFs & { mkdir: (path: string) => Promise<void> };
  readonly files: Map<string, MemoryFile>;
  readonly writes: { readonly path: string; readonly content: string }[];
  readonly mkdirs: string[];
}

function versionOf(raw: string): FsVersion {
  return raw as unknown as FsVersion;
}

function targetOf(path: string): FsTarget {
  return { targetKey: path as FsTarget["targetKey"], displayPath: path };
}

const CWD = "/ws";
const WS = "ws";

/** 轻量内存 fs：key 为 workspace 绝对坐标（"ws/..."），覆盖盘点所需方法并记录写入。 */
function memoryFs(seed: Readonly<Record<string, string>> = {}): MemoryWorkspace {
  const files = new Map<string, MemoryFile>();
  const writes: { readonly path: string; readonly content: string }[] = [];
  const mkdirs: string[] = [];
  let clock = 1;
  for (const [path, content] of Object.entries(seed)) {
    files.set(path, { content, version: `v${String(clock++)}` });
  }

  const normalize = (path: string, cwd?: string): string => {
    const cwdParts = (cwd ?? "").replace(/^\/+/u, "").split("/").filter((part) => part !== "");
    const parts: string[] = path.startsWith("/") ? [] : [...cwdParts];
    for (const segment of path.split("/")) {
      if (segment === "" || segment === ".") continue;
      if (segment === "..") parts.pop();
      else parts.push(segment);
    }
    return parts.join("/");
  };

  const infoOf = (path: string): FsInfo | undefined => {
    const file = files.get(path);
    if (file !== undefined) {
      return { version: versionOf(file.version), type: "file", size: Buffer.byteLength(file.content) };
    }
    const prefix = path === "" ? "" : `${path}/`;
    for (const key of files.keys()) {
      if (path === "" || key.startsWith(prefix)) return { version: versionOf("dir"), type: "directory" };
    }
    return undefined;
  };

  const fs: MemoryFs & { mkdir: (path: string) => Promise<void> } = {
    resolve: async (path: string, options?: { readonly cwd?: string }): Promise<FsTarget> =>
      targetOf(normalize(path, options?.cwd)),
    contains: (parent: FsTarget, child: FsTarget): boolean => {
      if (parent.displayPath === "") return true;
      const root = parent.displayPath.replace(/^\/+/u, "").replace(/\/+$/u, "");
      const candidate = child.displayPath.replace(/^\/+/u, "");
      return candidate === root || candidate.startsWith(`${root}/`);
    },
    stat: async (target: FsTarget): Promise<FsInfo | undefined> =>
      infoOf(target.displayPath.replace(/^\/+/u, "")),
    listDir: async (target: FsTarget): Promise<FsDirEntry[]> => {
      const dir = target.displayPath.replace(/^\/+/u, "").replace(/\/+$/u, "");
      const prefix = dir === "" ? "" : `${dir}/`;
      const children = new Map<string, { type: "file" | "directory"; target: FsTarget; size?: number }>();
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash < 0) {
          children.set(rest, { type: "file", target: targetOf(key), size: Buffer.byteLength(files.get(key)!.content) });
        } else {
          const name = rest.slice(0, slash);
          if (name !== "" && !children.has(name)) {
            children.set(name, { type: "directory", target: targetOf(`${prefix}${name}`) });
          }
        }
      }
      return [...children.entries()].map(([name, entry]) => ({
        name,
        type: entry.type,
        target: entry.target,
        ...(entry.size === undefined ? {} : { size: entry.size }),
      }));
    },
    readBytes: async (target: FsTarget, _signal: AbortSignal | undefined, max: number): Promise<Uint8Array> => {
      const file = files.get(target.displayPath.replace(/^\/+/u, ""));
      if (file === undefined) throw new Error("FS_NOT_FOUND");
      const bytes = new TextEncoder().encode(file.content);
      if (bytes.byteLength > max) throw new Error("FS_TOO_LARGE");
      return bytes;
    },
    writeText: async (target: FsTarget, content: string) => {
      const path = target.displayPath.replace(/^\/+/u, "");
      const before = files.get(path)?.content ?? null;
      const version = `v${String(clock++)}`;
      files.set(path, { content, version });
      writes.push({ path, content });
      return { operation: before === null ? "create" : "update", version: versionOf(version), before, after: content } as const;
    },
    mkdir: async (path: string) => {
      mkdirs.push(path);
    },
  };
  return { fs, files, writes, mkdirs };
}

function realmFor(state: MemoryWorkspace): StateInventoryRealm {
  return {
    fs: state.fs as unknown as FileSystem,
    cwd: CWD,
    root: targetOf(WS),
  };
}

function entry(inventory: StateInventory, id: string): StateInventoryEntry {
  const found = inventory.entries.find((item) => item.id === id);
  if (found === undefined) throw new Error(`盘点缺少条目 ${id}`);
  return found;
}

describe("buildStateInventory", () => {
  it("把未版本化的书架文档判为 legacy，并读取文档内时间戳", async () => {
    const state = memoryFs({
      "ws/.oh-story/shelf.json": JSON.stringify({
        entries: [{ title: "甲" }, { title: "乙" }],
        updatedAt: "2026-04-01T10:00:00.000Z",
      }),
    });
    const inventory = await buildStateInventory(realmFor(state), { now: "2026-10-24T00:00:00.000Z" });

    expect(inventory.generatedAt).toBe("2026-10-24T00:00:00.000Z");
    expect(inventory.schemaVersion).toBe(1);
    expect(inventory.entries).toHaveLength(STATE_DESCRIPTORS.length);

    const shelf = entry(inventory, "shelf");
    expect(shelf.path).toBe(".oh-story/shelf.json");
    expect(shelf.status).toBe("legacy");
    expect(shelf.schemaVersion).toBe(0);
    expect(shelf.expectedVersion).toBe(1);
    expect(shelf.entries).toBe(2);
    expect(shelf.fileCount).toBe(1);
    expect(shelf.bytes).toBeGreaterThan(0);
    expect(shelf.lastWriteAt).toBe("2026-04-01T10:00:00.000Z");
    expect(shelf.lastWriteSource).toBe("document");
    expect(shelf.note).toBeUndefined();
  });

  it("更高版本判为 newer，绝不误报 ok", async () => {
    const state = memoryFs({
      "ws/.oh-story/annotations.json": JSON.stringify({ schemaVersion: 2, alpha: "a", beta: "b" }),
    });
    const annotations = entry(await buildStateInventory(realmFor(state)), "annotations");
    expect(annotations.status).toBe("newer");
    expect(annotations.schemaVersion).toBe(2);
    expect(annotations.entries).toBe(2);
    expect(annotations.note).toContain("高于当前构建");
  });

  it("schemaVersion 不计入键计数，抑制记录按 items 计数", async () => {
    const state = memoryFs({
      "ws/.oh-story/annotations.json": JSON.stringify({
        schemaVersion: 1,
        "正文/甲.md": [{ id: "a" }],
        "正文/乙.md": [{ id: "b" }, { id: "c" }],
      }),
      "ws/.oh-story/foreshadows-snooze.json": JSON.stringify({
        schemaVersion: 1,
        items: [{ id: "s1" }, { id: "s2" }],
      }),
    });
    const inventory = await buildStateInventory(realmFor(state));
    const annotations = entry(inventory, "annotations");
    const snooze = entry(inventory, "foreshadows-snooze");
    expect(annotations.status).toBe("ok");
    expect(annotations.entries).toBe(2);
    expect(snooze.status).toBe("ok");
    expect(snooze.entries).toBe(2);
  });

  it("检索索引不把 meta.json 当成行索引，派生数据缺版本不报 legacy", async () => {
    const state = memoryFs({
      "ws/.oh-story/index/meta.json": JSON.stringify({ "正文/一.md": "hash.json" }),
      "ws/.oh-story/index/hash.json": JSON.stringify({ path: "正文/一.md", version: "v1", lines: ["甲", "乙"] }),
    });
    const inventory = await buildStateInventory(realmFor(state));
    const meta = entry(inventory, "search-meta");
    const index = entry(inventory, "search-index");
    expect(meta.status).toBe("ok");
    expect(meta.entries).toBe(1);
    expect(index.status).toBe("ok");
    expect(index.fileCount).toBe(1);
    expect(index.entries).toBe(2);
    expect(index.note).toBe("派生数据，无需版本");
  });

  it("损坏 JSON 判为 corrupt，不抛错", async () => {
    const state = memoryFs({
      "ws/.oh-story/foreshadows.json": "{\"items\": [",
    });
    const foreshadows = entry(await buildStateInventory(realmFor(state)), "foreshadows");
    expect(foreshadows.status).toBe("corrupt");
    expect(foreshadows.schemaVersion).toBeNull();
    expect(foreshadows.entries).toBeNull();
    expect(foreshadows.note).toContain("JSON");
  });

  it("顶层形状与计数模式不符判为 corrupt", async () => {
    const state = memoryFs({
      "ws/.oh-story/foreshadows-snooze.json": "[]",
    });
    const snooze = entry(await buildStateInventory(realmFor(state)), "foreshadows-snooze");
    expect(snooze.status).toBe("corrupt");
    expect(snooze.note).toContain("顶层不是对象");
  });

  it("缺失文件判为 missing，且不给假时间", async () => {
    const state = memoryFs({});
    const runs = entry(await buildStateInventory(realmFor(state)), "tasks-runs");
    expect(runs.status).toBe("missing");
    expect(runs.schemaVersion).toBeNull();
    expect(runs.entries).toBeNull();
    expect(runs.bytes).toBeNull();
    expect(runs.fileCount).toBe(0);
    expect(runs.lastWriteAt).toBeNull();
    expect(runs.lastWriteSource).toBe("unavailable");
  });

  it("JSONL 有一行坏行时判为 corrupt，但仍统计有效行与时间戳", async () => {
    const state = memoryFs({
      "ws/.oh-story/audit.jsonl": [
        "{\"timestamp\":\"2026-02-01T00:00:00.000Z\"}",
        "{oops",
        "{\"timestamp\":\"2026-03-01T00:00:00.000Z\"}",
      ].join("\n") + "\n",
    });
    const audit = entry(await buildStateInventory(realmFor(state)), "audit");
    expect(audit.status).toBe("corrupt");
    expect(audit.entries).toBe(2);
    expect(audit.note).toContain("1 行无法解析");
    expect(audit.lastWriteAt).toBe("2026-03-01T00:00:00.000Z");
    expect(audit.lastWriteSource).toBe("document");
  });

  it("目录型 JSONL（历史快照）按文件聚合，仍标 legacy", async () => {
    const state = memoryFs({
      "ws/.oh-story/history/正文.jsonl": [
        "{\"timestamp\":\"2026-01-01T00:00:00.000Z\"}",
        "{\"timestamp\":\"2026-01-02T00:00:00.000Z\"}",
      ].join("\n"),
      "ws/.oh-story/history/大纲.jsonl": "{\"timestamp\":\"2026-01-03T00:00:00.000Z\"}",
    });
    const history = entry(await buildStateInventory(realmFor(state)), "history");
    expect(history.status).toBe("legacy");
    expect(history.schemaVersion).toBe(0);
    expect(history.fileCount).toBe(2);
    expect(history.entries).toBe(3);
    expect(history.lastWriteAt).toBe("2026-01-03T00:00:00.000Z");
  });

  it("文件集聚合：累加文档计数与字节，按最差状态上报", async () => {
    const state = memoryFs({
      "ws/.oh-story/analysis/甲.json": JSON.stringify({
        book: "甲",
        scenes: [1, 2, 3],
        parsedAt: "2026-02-01T00:00:00.000Z",
      }),
      "ws/.oh-story/analysis/乙.json": JSON.stringify({ book: "乙", scenes: [4] }),
    });
    const analysis = entry(await buildStateInventory(realmFor(state)), "analysis");
    expect(analysis.status).toBe("legacy");
    expect(analysis.schemaVersion).toBe(0);
    expect(analysis.fileCount).toBe(2);
    expect(analysis.entries).toBe(4);
    expect(analysis.bytes).toBeGreaterThan(0);
    expect(analysis.lastWriteAt).toBe("2026-02-01T00:00:00.000Z");
  });

  it("文件集内出现更高版本时判为 newer，并标注版本不一致", async () => {
    const state = memoryFs({
      "ws/.oh-story/analysis/甲.json": JSON.stringify({ book: "甲", scenes: [1] }),
      "ws/.oh-story/analysis/乙.json": JSON.stringify({ schemaVersion: 2, book: "乙", scenes: [] }),
    });
    const analysis = entry(await buildStateInventory(realmFor(state)), "analysis");
    expect(analysis.status).toBe("newer");
    expect(analysis.schemaVersion).toBeNull();
    expect(analysis.note).toContain("版本不一致");
  });

  it("主密钥只报存在性与大小，密钥字节不出现在盘点结果里", async () => {
    const secret = "master-key-secret-bytes";
    const state = memoryFs({ "ws/.oh-story/vault/master.key": secret });
    const inventory = await buildStateInventory(realmFor(state));
    const masterKey = entry(inventory, "vault-master-key");
    expect(masterKey.status).toBe("not-inspected");
    expect(masterKey.bytes).toBe(Buffer.byteLength(secret));
    expect(masterKey.entries).toBeNull();
    expect(masterKey.fileCount).toBe(1);
    expect(masterKey.note).toContain("未读取内容");
    expect(JSON.stringify(inventory)).not.toContain(secret);
  });

  it("密文信封只取版本字段，密文/iv/tag 都不进输出", async () => {
    const state = memoryFs({
      "ws/.oh-story/vault/secrets.json": JSON.stringify({
        v: 1,
        iv: "iv-cipher-bytes",
        tag: "tag-cipher-bytes",
        data: "data-cipher-bytes",
      }),
    });
    const inventory = await buildStateInventory(realmFor(state));
    const secrets = entry(inventory, "vault-secrets");
    expect(secrets.status).toBe("not-inspected");
    expect(secrets.schemaVersion).toBe(1);
    expect(secrets.entries).toBe(4);
    const serialized = JSON.stringify(inventory);
    expect(serialized).not.toContain("iv-cipher-bytes");
    expect(serialized).not.toContain("tag-cipher-bytes");
    expect(serialized).not.toContain("data-cipher-bytes");
  });

  it("损坏的密文信封报 corrupt，且不输出内容", async () => {
    const state = memoryFs({ "ws/.oh-story/vault/secrets.json": "{\"v\":1,\"iv\":\"broken" });
    const secrets = entry(await buildStateInventory(realmFor(state)), "vault-secrets");
    expect(secrets.status).toBe("corrupt");
    expect(secrets.note).toContain("内容未输出");
  });

  it("盘点全程只读：零 writeText、零 mkdir", async () => {
    const state = memoryFs({
      "ws/.oh-story/shelf.json": JSON.stringify({ entries: [], updatedAt: "2026-01-01T00:00:00.000Z" }),
      "ws/.oh-story/history/正文.jsonl": "{\"timestamp\":\"2026-01-01T00:00:00.000Z\"}",
    });
    await buildStateInventory(realmFor(state));
    expect(state.writes).toHaveLength(0);
    expect(state.mkdirs).toHaveLength(0);
  });
});
