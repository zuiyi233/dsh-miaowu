import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import type { FileSystem, FsDirEntry, FsInfo, FsTarget, FsVersion, FsWriteIntent, FsWriteOutcome } from "@deepseek-ai/dsh-fs";
import { describe, expect, it } from "vitest";
import { handleContinuityRequest } from "../src/services/continuity-route.js";
import type {
  ContinuityHandoffManifest,
  ContinuityOverview,
  ContinuitySnapshotResult,
} from "../src/services/continuity-contract.js";

const CWD = "E:\\work\\demo";
const SESSION_ID = "session-1";

type MemoryFs = Pick<FileSystem, "resolve" | "contains" | "stat" | "listDir" | "readBytes" | "writeText">;

interface Harness {
  readonly fs: MemoryFs;
  readonly store: Map<string, { content: string; version: string }>;
  readonly writes: string[];
  has(path: string): boolean;
  read(path: string): string | undefined;
}

function targetOf(displayPath: string): FsTarget {
  return { targetKey: displayPath as FsTarget["targetKey"], displayPath };
}

function versionOf(raw: string): FsVersion {
  return raw as unknown as FsVersion;
}

function keyOf(path: string, cwd?: string): string {
  const absolute = path.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(path) ? path : `${cwd ?? CWD}/${path}`;
  return absolute.replace(/\/{2,}/gu, "/").replace(/\/+$/u, "");
}

/** 内存 fs：绝对键 + CAS 版本，覆盖盘点/备份/路由所需方法，并记录每次写入。 */
function setup(seed: Readonly<Record<string, string>> = {}): Harness {
  const store = new Map<string, { content: string; version: string }>();
  const writes: string[] = [];
  let clock = 0;
  const nextVersion = (): string => {
    clock += 1;
    return `v${String(clock)}`;
  };
  for (const [path, content] of Object.entries(seed)) {
    store.set(keyOf(path), { content, version: nextVersion() });
  }

  const infoOf = (path: string): FsInfo | undefined => {
    const file = store.get(path);
    if (file !== undefined) {
      return { version: versionOf(file.version), type: "file", size: Buffer.byteLength(file.content) };
    }
    const prefix = `${path}/`;
    for (const key of store.keys()) {
      if (key.startsWith(prefix)) return { version: versionOf("dir"), type: "directory" };
    }
    return undefined;
  };

  const fs = {
    resolve: async (path: string, options?: { readonly cwd?: string }): Promise<FsTarget> =>
      targetOf(keyOf(path, options?.cwd)),
    contains: (parent: FsTarget, child: FsTarget): boolean =>
      child.displayPath === parent.displayPath || child.displayPath.startsWith(`${parent.displayPath}/`),
    stat: async (entry: FsTarget): Promise<FsInfo | undefined> => infoOf(entry.displayPath),
    readBytes: async (entry: FsTarget): Promise<Uint8Array> => {
      const file = store.get(entry.displayPath);
      if (file === undefined) throw new Error("FS_NOT_FOUND");
      return new TextEncoder().encode(file.content);
    },
    listDir: async (entry: FsTarget): Promise<FsDirEntry[]> => {
      const prefix = `${entry.displayPath}/`;
      const directories = new Set<string>();
      const files = new Set<string>();
      for (const key of store.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash < 0) files.add(rest);
        else directories.add(rest.slice(0, slash));
      }
      return [
        ...[...directories].map((name) => ({ name, type: "directory" as const, target: targetOf(`${prefix}${name}`) })),
        ...[...files].map((name) => ({ name, type: "file" as const, target: targetOf(`${prefix}${name}`) })),
      ];
    },
    writeText: async (entry: FsTarget, content: string, expected?: FsWriteIntent): Promise<FsWriteOutcome> => {
      const current = store.get(entry.displayPath);
      if (expected?.kind === "replaceIfVersion"
        && (current === undefined || current.version !== String(expected.version))) {
        throw new Error("FS_STALE_VERSION");
      }
      const outcome: FsWriteOutcome = {
        operation: current === undefined ? "create" : "update",
        version: versionOf(nextVersion()),
        before: current?.content ?? null,
        after: content,
      };
      store.set(entry.displayPath, { content, version: String(outcome.version) });
      writes.push(entry.displayPath);
      return outcome;
    },
  } as unknown as MemoryFs;

  return {
    fs,
    store,
    writes,
    has: (path: string): boolean => store.has(keyOf(path)),
    read: (path: string): string | undefined => store.get(keyOf(path))?.content,
  };
}

function fakeContext(harness: Harness): Context {
  const agent = {
    session: { header: { cwd: CWD } },
    ctx: {
      get: (key: string): unknown => {
        if (key === "fs") return harness.fs;
        if (key === "sandboxPolicy") return {};
        return undefined;
      },
    },
  };
  return {
    typert: { lookups: { get: () => ({ resolve: async (): Promise<unknown> => agent }) } },
    get: (): unknown => undefined,
    logger: () => ({ error: () => undefined, warn: () => undefined }),
  } as unknown as Context;
}

interface RouteResult {
  readonly status: number | undefined;
  readonly body: unknown;
  readonly handled: boolean;
}

function makeRequest(method: string, url: string, body: unknown): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  return {
    method,
    url,
    headers: {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  } as unknown as IncomingMessage;
}

async function callRoute(
  harness: Harness,
  method: string,
  path: string,
  body?: unknown
): Promise<RouteResult> {
  const captured: { status?: number; body?: unknown } = {};
  const request = makeRequest(method, `${path}?sessionId=${SESSION_ID}`, body);
  const response = {
    writeHead: (status: number): void => { captured.status = status; },
    end: (raw?: string): void => {
      captured.body = raw === undefined || raw === "" ? undefined : JSON.parse(raw) as unknown;
    },
  } as unknown as ServerResponse;
  const handled = await handleContinuityRequest(
    fakeContext(harness),
    request,
    response,
    { maxBytes: 2 * 1024 * 1024 }
  );
  return { status: captured.status, body: captured.body, handled };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function workspaceSeed(): Record<string, string> {
  return {
    [`${CWD}/正文/第1章 开端.md`]: "第一章 开端\n\n林远在雨夜捡到一把铜钥匙。",
    [`${CWD}/.oh-story/foreshadows.json`]: JSON.stringify({
      schemaVersion: 1,
      items: [{
        id: "f1",
        title: "铜钥匙的来历",
        status: "planted",
        plantedChapter: "第1章",
        plannedPayoffChapter: "第2章",
        importance: 3,
      }],
      updatedAt: "2026-10-01T00:00:00.000Z",
    }),
    [`${CWD}/.oh-story/history/2026-10-01.jsonl`]: `${JSON.stringify({
      path: "正文/第1章 开端.md",
      version: "v1",
      timestamp: "2026-10-01T00:00:00.000Z",
      bytes: 30,
    })}\n`,
    [`${CWD}/.oh-story/shelf.json`]: JSON.stringify({
      schemaVersion: 1,
      entries: [{ id: "w1", path: "正文", title: "演示" }],
    }),
  };
}

describe("GET /oh-story/continuity", () => {
  it("返回只读概览", async () => {
    const harness = setup(workspaceSeed());
    const result = await callRoute(harness, "GET", "/oh-story/continuity");
    expect(result.handled).toBe(true);
    expect(result.status).toBe(200);
    const overview = result.body as ContinuityOverview;
    expect(overview.readOnly).toBe(true);
    expect(Array.isArray(overview.risks)).toBe(true);
    expect(Array.isArray(overview.today.dueForeshadows)).toBe(true);
    expect(harness.writes).toHaveLength(0);
  });
});

describe("GET /oh-story/continuity/handoff", () => {
  it("返回带 checksum 的只读交接清单", async () => {
    const harness = setup(workspaceSeed());
    const result = await callRoute(harness, "GET", "/oh-story/continuity/handoff");
    expect(result.status).toBe(200);
    const manifest = result.body as ContinuityHandoffManifest;
    expect(manifest.schemaVersion).toBe(1);
    expect(typeof manifest.checksum).toBe("string");
    expect(manifest.checksum).not.toBe("");
    expect(Array.isArray(manifest.files)).toBe(true);
    expect(harness.writes).toHaveLength(0);
  });
});

describe("POST /oh-story/continuity/snapshot", () => {
  it("缺少 confirm 时 400 且不写入", async () => {
    const harness = setup(workspaceSeed());
    const result = await callRoute(harness, "POST", "/oh-story/continuity/snapshot", {});
    expect(result.status).toBe(400);
    expect(String(asRecord(result.body).error)).toContain("确认");
    expect(String(asRecord(result.body).error)).toContain(".oh-story/backup/");
    expect(harness.writes).toHaveLength(0);
  });

  it("confirm 必须是布尔 true，字符串 \"true\" 仍拒绝", async () => {
    const harness = setup(workspaceSeed());
    const result = await callRoute(harness, "POST", "/oh-story/continuity/snapshot", { confirm: "true" });
    expect(result.status).toBe(400);
    expect(harness.writes).toHaveLength(0);
  });

  it("确认后只在 .oh-story/backup/ 下写一个整体快照", async () => {
    const harness = setup(workspaceSeed());
    const result = await callRoute(harness, "POST", "/oh-story/continuity/snapshot", { confirm: true });
    expect(result.status).toBe(200);
    const snapshot = result.body as ContinuitySnapshotResult;
    expect(snapshot.path).toContain(".oh-story/backup/");
    expect(snapshot.counts.files).toBeGreaterThan(0);
    expect(harness.writes).toHaveLength(1);
    expect(harness.writes[0]).toContain("/.oh-story/backup/");
    expect(harness.has(snapshot.path)).toBe(true);
  });
});

describe("未知路由", () => {
  it("路径或方法不匹配时交回后续扩展", async () => {
    const harness = setup(workspaceSeed());
    const unknown = await callRoute(harness, "GET", "/oh-story/continuity/unknown");
    expect(unknown.handled).toBe(false);
    const wrongMethod = await callRoute(harness, "GET", "/oh-story/continuity/snapshot");
    expect(wrongMethod.handled).toBe(false);
  });
});
