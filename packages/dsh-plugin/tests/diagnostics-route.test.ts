import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import type { Context } from "@deepseek-ai/cordis";
import type { FileSystem, FsDirEntry, FsInfo, FsTarget, FsVersion, FsWriteIntent, FsWriteOutcome } from "@deepseek-ai/dsh-fs";
import { describe, expect, it } from "vitest";
import { handleDiagnosticsRequest } from "../src/services/diagnostics-route.js";
import type { DiagnosticRepairResult, DiagnosticsReport, SupportBundle } from "../src/services/diagnostics-contract.js";
import type { StateInventory, StateMigrationPlan, StateMigrationResult } from "../src/services/state-contract.js";

const CWD = "E:\\work\\demo";
const SESSION_ID = "session-1";
const HOME = homedir();

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

/** 内存 fs：绝对键 + CAS 版本，覆盖盘点/迁移/检索/备份所需的方法，并记录每次写入。 */
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

const DEFAULT_SKILLS: readonly string[] = Array.from({ length: 41 }, (_, index) => `bundled-skill-${String(index)}`);
const DEFAULT_TOOLS: readonly string[] = [
  "oh_story_role",
  "oh_story_production",
  "oh_story_task",
  "oh_story_comfyui",
  "oh_story_bundled_reference",
];

interface HostOptions {
  readonly skills?: readonly string[];
  readonly tools?: readonly string[];
  readonly presets?: unknown;
  readonly pluginManager?: unknown;
  readonly sessionQuery?: unknown;
}

function fakeContext(harness: Harness, options: HostOptions = {}): Context {
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
  const services: Record<string, unknown> = {
    agentPresets: options.presets ?? { list: async () => [{}] },
    pluginManager: options.pluginManager ?? { listBundles: async () => [{ name: "@dsh-miaowu/dsh" }] },
  };
  if (options.sessionQuery !== undefined) services.sessionQuery = options.sessionQuery;
  return {
    typert: { lookups: { get: () => ({ resolve: async (): Promise<unknown> => agent }) } },
    skills: { list: async () => (options.skills ?? DEFAULT_SKILLS).map((name) => ({ name })) },
    tools: { schemas: () => (options.tools ?? DEFAULT_TOOLS).map((name) => ({ name })) },
    get: (key: string): unknown => services[key],
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
  body?: unknown,
  host: HostOptions = {}
): Promise<RouteResult> {
  const captured: { status?: number; body?: unknown } = {};
  const request = makeRequest(method, `${path}?sessionId=${SESSION_ID}`, body);
  const response = {
    writeHead: (status: number): void => { captured.status = status; },
    end: (raw?: string): void => {
      captured.body = raw === undefined || raw === "" ? undefined : JSON.parse(raw) as unknown;
    },
  } as unknown as ServerResponse;
  const handled = await handleDiagnosticsRequest(
    fakeContext(harness, host),
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
    [`${CWD}/正文/第1章.md`]: "第一章 开篇",
    [`${CWD}/.oh-story/shelf.json`]: JSON.stringify({ entries: [{ id: "w1", path: "正文", title: "演示" }] }),
    [`${CWD}/.oh-story/history/2026-10-01.jsonl`]: `${JSON.stringify({ path: "正文/第1章.md", timestamp: "2026-10-01T00:00:00.000Z" })}\n`,
  };
}

describe("GET /oh-story/diagnostics", () => {
  it("返回六组只读报告，且不含绝对工作区路径", async () => {
    const harness = setup(workspaceSeed());
    const result = await callRoute(harness, "GET", "/oh-story/diagnostics");
    expect(result.handled).toBe(true);
    expect(result.status).toBe(200);
    const report = result.body as DiagnosticsReport;
    expect(report.readOnly).toBe(true);
    expect(new Set(report.checks.map((check) => check.group))).toEqual(
      new Set(["host", "runtime", "workspace", "data", "credentials", "integration"])
    );
    const serialized = JSON.stringify(result.body);
    expect(serialized).not.toContain("E:");
    expect(serialized).not.toContain("E:/work");
    expect(harness.writes).toHaveLength(0);
  });

  it("工具缺失时报告 P0", async () => {
    const harness = setup(workspaceSeed());
    const result = await callRoute(harness, "GET", "/oh-story/diagnostics", undefined, { tools: ["read"] });
    expect(result.status).toBe(200);
    const report = result.body as DiagnosticsReport;
    const tools = report.checks.find((check) => check.id === "integration.tools");
    expect(tools?.status).toBe("fail");
    expect(tools?.severity).toBe("P0");
    expect(report.summary.p0).toBeGreaterThanOrEqual(1);
  });

  it("会话读取抛错时报 P1，且指引不要求删除宿主文件", async () => {
    const harness = setup(workspaceSeed());
    const sessionQuery = {
      readSession: async (): Promise<unknown> => {
        throw new Error(`读取失败：${CWD}/.oh-story/index 与 ${HOME}/.dsh/sessions，key sk-abcdefgh12345678`);
      },
    };
    const result = await callRoute(harness, "GET", "/oh-story/diagnostics", undefined, { sessionQuery });
    const report = result.body as DiagnosticsReport;
    const session = report.checks.find((check) => check.id === "integration.session");
    expect(session?.status).toBe("fail");
    expect(session?.severity).toBe("P1");
    const guidance = (session?.guidance ?? []).join("\n");
    expect(session?.summary).toContain("无法读取");
    expect(guidance).toContain("不会改写");
    expect(guidance).toContain("没有证据表明");
    expect(guidance).not.toContain("在 DSH 的会话列表里删除或归档");
    expect(guidance).not.toContain("删除 ~/.dsh");
    expect(guidance).not.toMatch(/\brm\s/u);
    expect(JSON.stringify(result.body)).not.toContain("sk-");
    expect(JSON.stringify(result.body)).not.toContain("E:");
  });

  it("会话 replay 校验失败才按畸形消息处理并给出删除/归档指引", async () => {
    const harness = setup(workspaceSeed());
    const sessionQuery = {
      readSession: async (): Promise<unknown> => {
        throw new Error("replay validation failed: malformed tool message");
      },
    };
    const result = await callRoute(harness, "GET", "/oh-story/diagnostics", undefined, { sessionQuery });
    const report = result.body as DiagnosticsReport;
    const session = report.checks.find((check) => check.id === "integration.session");
    expect(session?.status).toBe("fail");
    expect(session?.summary).toContain("畸形消息");
    expect((session?.guidance ?? []).join("\n")).toContain("删除或归档");
  });
});

describe("GET /oh-story/state/inventory", () => {
  it("返回书架与历史盘点，不暴露文件级边表", async () => {
    const harness = setup(workspaceSeed());
    const result = await callRoute(harness, "GET", "/oh-story/state/inventory");
    expect(result.status).toBe(200);
    const inventory = result.body as StateInventory;
    const shelf = inventory.entries.find((entry) => entry.id === "shelf");
    expect(shelf?.status).toBe("legacy");
    expect(shelf?.entries).toBe(1);
    const history = inventory.entries.find((entry) => entry.id === "history");
    expect(history?.fileCount).toBe(1);
    expect(history?.entries).toBe(1);
    expect(asRecord(result.body).files).toBeUndefined();
    expect(harness.writes).toHaveLength(0);
  });
});

describe("POST /oh-story/diagnostics/bundle", () => {
  it("缺少 confirm 时 400", async () => {
    const harness = setup(workspaceSeed());
    const result = await callRoute(harness, "POST", "/oh-story/diagnostics/bundle", {});
    expect(result.status).toBe(400);
    expect(String(asRecord(result.body).error)).toContain("确认");
    expect(harness.writes).toHaveLength(0);
  });

  it("确认后导出已脱敏支持包", async () => {
    const harness = setup(workspaceSeed());
    const sessionQuery = {
      readSession: async (): Promise<unknown> => {
        throw new Error(`读取失败：${CWD}/.oh-story/index 与 ${HOME}/.dsh/sessions，key sk-abcdefgh12345678`);
      },
    };
    const result = await callRoute(harness, "POST", "/oh-story/diagnostics/bundle", { confirm: true }, { sessionQuery });
    expect(result.status).toBe(200);
    const bundle = result.body as SupportBundle;
    expect(bundle.redacted).toBe(true);
    expect(bundle.logSummary.available).toBe(false);
    const serialized = JSON.stringify(result.body);
    expect(serialized).not.toContain("sk-");
    expect(serialized).not.toContain("E:");
    expect(serialized).toContain("<workspace>");
    expect(serialized).toContain("<redacted-secret>");
    if (HOME !== "" && HOME !== "/") expect(serialized).toContain("<home>");
    expect(harness.writes).toHaveLength(0);
  });
});

describe("POST /oh-story/diagnostics/repair", () => {
  it("未知操作 400", async () => {
    const harness = setup(workspaceSeed());
    const result = await callRoute(harness, "POST", "/oh-story/diagnostics/repair", { action: "drop-database", confirm: true });
    expect(result.status).toBe(400);
    expect(String(asRecord(result.body).error)).toContain("未知");
    expect(harness.writes).toHaveLength(0);
  });

  it("重建检索索引会创建索引文件", async () => {
    const harness = setup(workspaceSeed());
    const result = await callRoute(harness, "POST", "/oh-story/diagnostics/repair", { action: "rebuild-search-index", confirm: true });
    expect(result.status).toBe(200);
    const body = result.body as DiagnosticRepairResult;
    expect(body.ok).toBe(true);
    expect(body.changed).toBeGreaterThan(0);
    expect(harness.has(".oh-story/index/meta.json")).toBe(true);
  });

  it("重新备份会创建备份文件", async () => {
    const harness = setup(workspaceSeed());
    const result = await callRoute(harness, "POST", "/oh-story/diagnostics/repair", { action: "rerun-backup", confirm: true });
    expect(result.status).toBe(200);
    const body = result.body as DiagnosticRepairResult;
    expect(body.ok).toBe(true);
    expect(body.message).toContain(".oh-story/backup/");
    expect([...harness.store.keys()].some((key) => key.includes("/.oh-story/backup/"))).toBe(true);
  });

  it("过期锁只报告不删除", async () => {
    const harness = setup({
      ...workspaceSeed(),
      [`${CWD}/.oh-story/locks/lock-a.json`]: JSON.stringify({ expiresAt: "2020-01-01T00:00:00.000Z" }),
    });
    const result = await callRoute(harness, "POST", "/oh-story/diagnostics/repair", { action: "clean-expired-locks", confirm: true });
    expect(result.status).toBe(200);
    const body = result.body as DiagnosticRepairResult;
    expect(body.ok).toBe(false);
    expect(body.changed).toBe(0);
    expect(body.message).toContain("lock-a.json");
    expect(body.message).toContain(".oh-story/locks/");
    expect(harness.has(".oh-story/locks/lock-a.json")).toBe(true);
    expect(harness.writes).toHaveLength(0);
  });
});

describe("/oh-story/state/migrate", () => {
  it("plan / apply / rollback 全流程", async () => {
    const harness = setup(workspaceSeed());
    const original = harness.read(".oh-story/shelf.json");

    const planned = await callRoute(harness, "GET", "/oh-story/state/migrate");
    expect(planned.status).toBe(200);
    const plans = asRecord(planned.body).plans as readonly StateMigrationPlan[];
    expect(plans).toHaveLength(1);
    expect(plans[0]?.files.map((file) => file.path)).toEqual([".oh-story/shelf.json"]);

    const noConfirm = await callRoute(harness, "POST", "/oh-story/state/migrate", { action: "apply", id: "adopt-v1" });
    expect(noConfirm.status).toBe(400);
    expect(String(asRecord(noConfirm.body).error)).toContain("确认");

    const applied = await callRoute(harness, "POST", "/oh-story/state/migrate", { action: "apply", id: "adopt-v1", confirm: true });
    expect(applied.status).toBe(200);
    const migration = applied.body as StateMigrationResult;
    expect(migration.plan.files.map((file) => file.path)).toEqual([".oh-story/shelf.json"]);
    expect(migration.rollback).toContain("rollback");
    const migrated = JSON.parse(harness.read(".oh-story/shelf.json") ?? "{}") as Record<string, unknown>;
    expect(migrated.schemaVersion).toBe(1);
    expect(Array.isArray(migrated.entries)).toBe(true);

    const rolledBack = await callRoute(harness, "POST", "/oh-story/state/migrate", {
      action: "rollback",
      backupDir: migration.plan.backupDir,
      confirm: true,
    });
    expect(rolledBack.status).toBe(200);
    expect(asRecord(rolledBack.body).restored).toBe(1);
    expect(harness.read(".oh-story/shelf.json")).toBe(original);
  });

  it("apply 未知计划返回 409", async () => {
    const harness = setup(workspaceSeed());
    const result = await callRoute(harness, "POST", "/oh-story/state/migrate", {
      action: "apply",
      id: "unknown-plan",
      confirm: true,
    });
    expect(result.status).toBe(409);
  });

  it("GET 计划的 backupDir 可直接用于 apply", async () => {
    const harness = setup(workspaceSeed());
    const planned = await callRoute(harness, "GET", "/oh-story/state/migrate");
    const plan = (asRecord(planned.body).plans as StateMigrationPlan[])[0];
    if (plan === undefined) throw new Error("GET 计划没有返回 adopt-v1");
    expect(plan.id).toBe("adopt-v1");
    const applied = await callRoute(harness, "POST", "/oh-story/state/migrate", {
      action: "apply",
      id: plan.id,
      backupDir: plan.backupDir,
      confirm: true,
    });
    expect(applied.status).toBe(200);
    const migrated = JSON.parse(harness.read(".oh-story/shelf.json") ?? "{}") as Record<string, unknown>;
    expect(migrated.schemaVersion).toBe(1);
  });
});
