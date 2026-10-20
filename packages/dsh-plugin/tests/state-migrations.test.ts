import { createHash } from "node:crypto";
import type { FileSystem, FsDirEntry, FsInfo, FsTarget, FsVersion, FsWriteIntent } from "@deepseek-ai/dsh-fs";
import { describe, expect, it } from "vitest";
import { buildStateInventory, type StateInventoryRealm } from "../src/services/state-inventory.js";
import {
  applyStateMigration,
  planStateMigrations,
  rollbackStateMigration,
} from "../src/services/state-migrations.js";
import type { StateMigrationManifest } from "../src/services/state-contract.js";

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

/** 轻量内存 fs：key 为 workspace 绝对坐标（"ws/..."），记录写入以便断言。 */
function memoryFs(
  seed: Readonly<Record<string, string>> = {},
  options: {
    readonly failWrite?: (path: string) => boolean;
    readonly beforeWrite?: (path: string, files: Map<string, MemoryFile>) => void;
  } = {}
): MemoryWorkspace {
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
    writeText: async (target: FsTarget, content: string, expected?: FsWriteIntent) => {
      const path = target.displayPath.replace(/^\/+/u, "");
      if (options.failWrite?.(path) === true) throw new Error("INJECTED_WRITE_FAILURE");
      options.beforeWrite?.(path, files);
      const before = files.get(path)?.content ?? null;
      if (expected?.kind === "createIfAbsent" && files.has(path)) throw new Error("FS_NOT_OBSERVED");
      if (expected?.kind === "replaceIfVersion" && files.get(path)?.version !== String(expected.version)) {
        throw new Error("FS_STALE_VERSION");
      }
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
  return { fs: state.fs as unknown as FileSystem, cwd: CWD, root: targetOf(WS) };
}

const SHELF = [
  "{",
  "  \"entries\": [",
  "    { \"title\": \"甲\" },",
  "    { \"title\": \"乙\" }",
  "  ],",
  "  \"updatedAt\": \"2026-01-02T03:04:05.000Z\"",
  "}",
].join("\n");

const ANALYSIS = JSON.stringify({
  book: "书",
  scenes: [{ id: 1 }, { id: 2 }],
  parsedAt: "2026-02-03T00:00:00.000Z",
});

function seededWorkspace(): MemoryWorkspace {
  return memoryFs({
    "ws/.oh-story/shelf.json": SHELF,
    "ws/.oh-story/analysis/书.json": ANALYSIS,
    "ws/.oh-story/index/meta.json": JSON.stringify({ "正文/一.md": "hash" }),
    "ws/.oh-story/audit.jsonl": "{\"timestamp\":\"2026-01-01T00:00:00.000Z\"}\n",
    "ws/.oh-story/history/正文.jsonl": "{\"timestamp\":\"2026-01-01T00:00:00.000Z\"}\n",
    "ws/.oh-story/vault/master.key": "master-key-secret-bytes",
    "ws/.oh-story/vault/secrets.json": JSON.stringify({ v: 1, iv: "x", tag: "y", data: "z" }),
    "ws/.oh-story/tasks/runs.json": "[]",
  });
}

function backupKey(backupDir: string, path: string): string {
  return `ws/${backupDir}${path}`;
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

describe("planStateMigrations", () => {
  it("只把非派生、非密钥、非 JSONL 的对象型 legacy 文档列入 adopt-v1", async () => {
    const state = seededWorkspace();
    const inventory = await buildStateInventory(realmFor(state));
    const plans = planStateMigrations(inventory);

    expect(plans).toHaveLength(1);
    const plan = plans[0]!;
    expect(plan.id).toBe("adopt-v1");
    expect(plan.fromVersion).toBe(0);
    expect(plan.toVersion).toBe(1);
    expect(plan.reversible).toBe(true);
    expect(plan.files).toEqual([
      { path: ".oh-story/analysis/书.json", format: "json", fromVersion: 0 },
      { path: ".oh-story/shelf.json", format: "json", fromVersion: 0 },
    ]);
    expect(plan.backupDir).toMatch(/^\.oh-story\/migrations\/[^:]+\/$/u);
    expect(plan.summary).toContain("schemaVersion 1");
    expect(plan.files.some((file) => file.path.includes("/index/"))).toBe(false);
    expect(plan.files.some((file) => file.path.includes("/vault/"))).toBe(false);
    expect(plan.files.some((file) => file.path.endsWith(".jsonl"))).toBe(false);
    expect(plan.files.some((file) => file.path.includes("/tasks/"))).toBe(false);
    expect(plan.files.some((file) => file.path.includes("/history/"))).toBe(false);
  });

  it("没有 legacy 文档时不产出计划", async () => {
    const state = memoryFs({
      "ws/.oh-story/shelf.json": JSON.stringify({ schemaVersion: 1, entries: [] }),
    });
    expect(planStateMigrations(await buildStateInventory(realmFor(state)))).toEqual([]);
  });
});

describe("applyStateMigration", () => {
  it("缺少 confirm 时拒绝执行且不写盘", async () => {
    const state = seededWorkspace();
    const plan = planStateMigrations(await buildStateInventory(realmFor(state)))[0]!;
    await expect(
      applyStateMigration(realmFor(state), plan, { confirm: false } as unknown as { confirm: true })
    ).rejects.toThrow(/confirm/u);
    expect(state.writes).toHaveLength(0);
  });

  it("先原样备份，再给每个文档加 schemaVersion:1，其余数据不动", async () => {
    const state = seededWorkspace();
    const inventory = await buildStateInventory(realmFor(state));
    const plan = planStateMigrations(inventory)[0]!;
    const result = await applyStateMigration(realmFor(state), plan, {
      confirm: true,
      now: "2026-05-01T00:00:00.000Z",
    });

    expect(result.manifest.schemaVersion).toBe(1);
    expect(result.manifest.id).toBe("adopt-v1");
    expect(result.manifest.appliedAt).toBe("2026-05-01T00:00:00.000Z");
    expect(result.manifest.files).toEqual([
      { path: ".oh-story/analysis/书.json", hash: sha256(ANALYSIS) },
      { path: ".oh-story/shelf.json", hash: sha256(SHELF) },
    ]);
    expect(result.rollback).toContain(plan.backupDir.replace(/\/+$/u, ""));
    expect(result.rollback).toContain("POST /oh-story/state/migrate");
    expect(result.rollback).toContain("\"action\":\"rollback\"");

    expect(state.files.get(backupKey(plan.backupDir, ".oh-story/shelf.json"))?.content).toBe(SHELF);
    expect(state.files.get(backupKey(plan.backupDir, ".oh-story/analysis/书.json"))?.content).toBe(ANALYSIS);
    const manifestRaw = state.files.get(backupKey(plan.backupDir, "manifest.json"))?.content;
    expect(manifestRaw).toBeDefined();
    const manifest = JSON.parse(manifestRaw!) as StateMigrationManifest;
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.files).toEqual(result.manifest.files);

    const migratedShelf = JSON.parse(state.files.get("ws/.oh-story/shelf.json")!.content) as Record<string, unknown>;
    expect(migratedShelf.schemaVersion).toBe(1);
    expect(migratedShelf.entries).toEqual([{ title: "甲" }, { title: "乙" }]);
    expect(migratedShelf.updatedAt).toBe("2026-01-02T03:04:05.000Z");

    const migratedAnalysis = JSON.parse(state.files.get("ws/.oh-story/analysis/书.json")!.content) as Record<string, unknown>;
    expect(migratedAnalysis.schemaVersion).toBe(1);
    expect(migratedAnalysis.book).toBe("书");
    expect(migratedAnalysis.scenes).toEqual([{ id: 1 }, { id: 2 }]);
    expect(migratedAnalysis.parsedAt).toBe("2026-02-03T00:00:00.000Z");
  });

  it("计划过期时在任何写入前整单拒绝", async () => {
    const state = seededWorkspace();
    const inventory = await buildStateInventory(realmFor(state));
    const plan = planStateMigrations(inventory)[0]!;

    const shelfTarget = await state.fs.resolve(".oh-story/shelf.json", { cwd: CWD });
    await state.fs.writeText(shelfTarget, JSON.stringify({ schemaVersion: 1, entries: [] }));
    const writesBefore = state.writes.length;

    await expect(
      applyStateMigration(realmFor(state), plan, { confirm: true })
    ).rejects.toThrow(/过期/u);
    expect(state.writes).toHaveLength(writesBefore);
    expect(state.files.has(backupKey(plan.backupDir, "manifest.json"))).toBe(false);
  });

  it("拒绝伪造的密钥迁移计划", async () => {
    const state = seededWorkspace();
    const inventory = await buildStateInventory(realmFor(state));
    const plan = planStateMigrations(inventory)[0]!;
    const forged = { ...plan, files: [{ path: ".oh-story/vault/master.key", format: "json" as const, fromVersion: 0 }] };
    await expect(
      applyStateMigration(realmFor(state), forged, { confirm: true })
    ).rejects.toThrow(/密钥/u);
    expect(state.writes).toHaveLength(0);
  });

  it("拒绝把不可变备份快照纳入迁移计划", async () => {
    const state = seededWorkspace();
    const inventory = await buildStateInventory(realmFor(state));
    const plan = planStateMigrations(inventory)[0]!;
    const forged = { ...plan, files: [{ path: ".oh-story/backup/full-1.json", format: "json" as const, fromVersion: 0 }] };
    await expect(
      applyStateMigration(realmFor(state), forged, { confirm: true })
    ).rejects.toThrow(/不可变/u);
    expect(state.writes).toHaveLength(0);
  });

  it("写入中途失败时补偿回滚已写文件，并保留可回滚备份", async () => {
    const state = memoryFs({
      "ws/.oh-story/shelf.json": SHELF,
      "ws/.oh-story/analysis/书.json": ANALYSIS,
    }, { failWrite: (path) => path === "ws/.oh-story/shelf.json" });
    const plan = planStateMigrations(await buildStateInventory(realmFor(state)))[0]!;
    const failure = await applyStateMigration(realmFor(state), plan, { confirm: true })
      .then(() => undefined, (error: unknown) => error);
    expect(failure).toMatchObject({ status: 500 });
    expect((failure as Error).message).toContain("已回滚 1 个已写文件");
    expect(state.files.get("ws/.oh-story/analysis/书.json")?.content).toBe(ANALYSIS);
    expect(state.files.get("ws/.oh-story/shelf.json")?.content).toBe(SHELF);
    expect(state.files.has(backupKey(plan.backupDir, "manifest.json"))).toBe(true);
  });

  it("写入前目标被并发改动时 CAS 拒绝覆盖并回滚已写文件", async () => {
    const concurrent = JSON.stringify({ entries: [{ title: "并发" }] });
    const state = memoryFs({
      "ws/.oh-story/shelf.json": SHELF,
      "ws/.oh-story/analysis/书.json": ANALYSIS,
    }, {
      beforeWrite: (path, files) => {
        if (path === "ws/.oh-story/analysis/书.json") {
          files.set("ws/.oh-story/shelf.json", { content: concurrent, version: "v-concurrent" });
        }
      },
    });
    const plan = planStateMigrations(await buildStateInventory(realmFor(state)))[0]!;
    const failure = await applyStateMigration(realmFor(state), plan, { confirm: true })
      .then(() => undefined, (error: unknown) => error);
    expect(failure).toMatchObject({ status: 500 });
    expect((failure as Error).message).toContain("已回滚 1 个已写文件");
    expect(state.files.get("ws/.oh-story/shelf.json")?.content).toBe(concurrent);
    expect(state.files.get("ws/.oh-story/analysis/书.json")?.content).toBe(ANALYSIS);
    expect(state.files.has(backupKey(plan.backupDir, "manifest.json"))).toBe(true);
  });
});

describe("rollbackStateMigration", () => {
  it("按清单原样恢复每个文件，且保留备份目录", async () => {
    const state = seededWorkspace();
    const inventory = await buildStateInventory(realmFor(state));
    const plan = planStateMigrations(inventory)[0]!;
    const applied = await applyStateMigration(realmFor(state), plan, { confirm: true });

    const result = await rollbackStateMigration(realmFor(state), applied.plan.backupDir, { confirm: true });
    expect(result.restored).toBe(2);
    expect(result.backupDir).toBe(plan.backupDir.replace(/\/+$/u, ""));
    expect(state.files.get("ws/.oh-story/shelf.json")?.content).toBe(SHELF);
    expect(state.files.get("ws/.oh-story/analysis/书.json")?.content).toBe(ANALYSIS);
    expect(state.files.has(backupKey(plan.backupDir, "manifest.json"))).toBe(true);
    expect(state.files.has(backupKey(plan.backupDir, ".oh-story/shelf.json"))).toBe(true);
  });

  it("缺少 confirm 时拒绝回滚", async () => {
    const state = seededWorkspace();
    await expect(
      rollbackStateMigration(realmFor(state), ".oh-story/migrations/none", { confirm: false } as unknown as { confirm: true })
    ).rejects.toThrow(/confirm/u);
  });

  it("清单缺失或版本不支持时报错", async () => {
    const missing = memoryFs({});
    await expect(
      rollbackStateMigration(realmFor(missing), ".oh-story/migrations/none", { confirm: true })
    ).rejects.toThrow(/备份清单不存在/u);

    const invalid = memoryFs({
      "ws/.oh-story/migrations/bad/manifest.json": JSON.stringify({ schemaVersion: 2, files: [] }),
    });
    await expect(
      rollbackStateMigration(realmFor(invalid), ".oh-story/migrations/bad", { confirm: true })
    ).rejects.toThrow(/版本不受支持/u);
  });

  it("备份目录或清单文件路径越界时报错", async () => {
    const state = memoryFs({
      "ws/.oh-story/migrations/bad/manifest.json": JSON.stringify({
        schemaVersion: 1,
        id: "adopt-v1",
        files: [{ path: "../escape.json", hash: "a".repeat(64) }],
      }),
    });
    await expect(
      rollbackStateMigration(realmFor(state), ".oh-story/migrations/bad", { confirm: true })
    ).rejects.toThrow(/相对路径/u);

    await expect(
      rollbackStateMigration(realmFor(state), "../outside", { confirm: true })
    ).rejects.toThrow(/备份目录不合法/u);
  });

  it("备份内容与清单哈希不符时中止，不覆盖当前文件", async () => {
    const backupDir = ".oh-story/migrations/tampered";
    const state = memoryFs({
      "ws/.oh-story/shelf.json": JSON.stringify({ schemaVersion: 1, entries: [] }),
      "ws/.oh-story/migrations/tampered/manifest.json": JSON.stringify({
        schemaVersion: 1,
        id: "adopt-v1",
        files: [{ path: ".oh-story/shelf.json", hash: "a".repeat(64) }],
      }),
      "ws/.oh-story/migrations/tampered/.oh-story/shelf.json": "{\"entries\":[]}",
    });
    const writesBefore = state.writes.length;
    await expect(
      rollbackStateMigration(realmFor(state), backupDir, { confirm: true })
    ).rejects.toThrow(/校验失败/u);
    expect(state.writes).toHaveLength(writesBefore);
  });

  it("拒绝用备份清单覆盖密钥或派生数据", async () => {
    const backupDir = ".oh-story/migrations/vault";
    const content = "not-a-real-key";
    const hash = createHash("sha256").update(content, "utf8").digest("hex");
    const state = memoryFs({
      "ws/.oh-story/migrations/vault/manifest.json": JSON.stringify({
        schemaVersion: 1,
        id: "adopt-v1",
        files: [{ path: ".oh-story/vault/secrets.json", hash }],
      }),
      "ws/.oh-story/migrations/vault/.oh-story/vault/secrets.json": content,
    });
    await expect(
      rollbackStateMigration(realmFor(state), backupDir, { confirm: true })
    ).rejects.toThrow(/不可迁移/u);
  });

  it("缺少迁移 id 的备份清单被拒绝", async () => {
    const backupDir = ".oh-story/migrations/legacy-shape";
    const content = JSON.stringify({ entries: [] });
    const hash = createHash("sha256").update(content, "utf8").digest("hex");
    const state = memoryFs({
      "ws/.oh-story/migrations/legacy-shape/manifest.json": JSON.stringify({
        schemaVersion: 1,
        files: [{ path: ".oh-story/shelf.json", hash }],
      }),
      "ws/.oh-story/migrations/legacy-shape/.oh-story/shelf.json": content,
    });
    await expect(
      rollbackStateMigration(realmFor(state), backupDir, { confirm: true })
    ).rejects.toThrow(/不是本插件产生的迁移/u);
  });
});
