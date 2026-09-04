import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import type { FileSystem, FsDirEntry, FsInfo, FsTarget, FsVersion } from "@deepseek-ai/dsh-fs";
import { describe, expect, it } from "vitest";
import {
  clearTaskCaches,
  handleTasksRequest,
  isLegalCandidateTransition,
  isLegalRunTransition,
  isLegalStepTransition,
  parseListLimit,
  RECIPE_REGISTRY,
  recipeStepsFor,
  resolveCommitterKind,
  selectResumeRun,
  summarizeRun,
  type Candidate,
  type TaskRun,
} from "../src/services/tasks.js";
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

function memoryFs(seed: Readonly<Record<string, string>> = {}): { fs: MemoryFs; files: Map<string, MemoryFile> } {
  const files = new Map<string, MemoryFile>();
  let clock = 1;
  for (const [path, content] of Object.entries(seed)) files.set(path, { content, version: `v${String(clock++)}` });

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
        if (slash < 0) children.set(rest, { type: "file", target: targetOf(key) });
        else {
          const name = rest.slice(0, slash);
          if (name !== "" && !children.has(name)) children.set(name, { type: "directory", target: targetOf(`${prefix}${name}`) });
        }
      }
      return [...children.entries()].map(([name, entry]) => ({ name, type: entry.type, target: entry.target }));
    },
    readBytes: async (target: FsTarget, _signal: AbortSignal | undefined, _max: number): Promise<Uint8Array> => {
      void _signal;
      void _max;
      const file = files.get(target.displayPath.replace(/^\/+/, ""));
      if (file === undefined) {
        const error = new Error("FS_NOT_FOUND") as Error & { code?: string };
        error.code = "FS_NOT_FOUND";
        throw error;
      }
      return new TextEncoder().encode(file.content);
    },
    writeText: async (
      target: FsTarget,
      content: string,
      conditions?: { readonly kind: string; readonly version?: unknown }
    ) => {
      const path = target.displayPath.replace(/^\/+/, "");
      const before = files.get(path);
      const wanted = (conditions as { version?: unknown } | undefined)?.version;
      if (wanted !== undefined && before !== undefined && String(wanted) !== before.version) {
        const error = new Error("stale") as Error & { code?: string };
        error.code = "FS_STALE_VERSION";
        throw error;
      }
      const version = `v${String(clock++)}`;
      files.set(path, { content, version });
      return { operation: before === undefined ? "create" : "update", version: versionOf(version), before: before?.content ?? null, after: content } as const;
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
    typert: { lookups: { get: () => ({ resolve: async (): Promise<unknown> => agent }) } },
    logger: () => (): void => undefined,
  } as unknown as Context;
}

interface CapturedResponse {
  status?: number;
  body?: unknown;
}

function incoming(method: string, url: string, payload?: unknown): IncomingMessage {
  const body = payload === undefined ? "" : JSON.stringify(payload);
  const chunks = body === "" ? [] : [Buffer.from(body)];
  async function* stream(): AsyncIterable<Uint8Array> {
    for (const chunk of chunks) yield chunk;
  }
  const request = stream() as unknown as IncomingMessage;
  (request as { method: string }).method = method;
  (request as { url: string }).url = url;
  (request as { headers: Record<string, string> }).headers = {};
  return request;
}

async function callTasks(
  fs: MemoryFs,
  method: string,
  url: string,
  payload?: unknown
): Promise<CapturedResponse> {
  clearTaskCachesOnFirstUse();
  const captured: CapturedResponse = {};
  const response = {
    writeHead: (status: number): void => { captured.status = status; },
    end: (body?: string): void => {
      captured.body = body === undefined || body === "" ? undefined : JSON.parse(body) as unknown;
    },
  } as unknown as ServerResponse;
  const handled = await handleTasksRequest(fakeContext(fs), incoming(method, url, payload), response, { maxBytes: 2 * 1024 * 1024 });
  expect(handled).toBe(true);
  return captured;
}

// 每个用例独立 cwd 命名空间:tasks 缓存以 cwd 为键, 用例间互不污染.
let caseClock = 0;
function isolatedFs(seed: Readonly<Record<string, string>> = {}): { fs: MemoryFs; files: Map<string, MemoryFile>; cwd: string } {
  caseClock += 1;
  const suffix = `case${String(caseClock)}`;
  const namespaced: Record<string, string> = {};
  for (const [path, content] of Object.entries(seed)) namespaced[`${suffix}/${path}`] = content;
  const { fs, files } = memoryFs(namespaced);
  // 将工作区根下移一层,使 cwd 隔离;realm/root 仍按 WS/cwd 计算需重绑.
  return { fs, files, cwd: `/ws/${suffix}` };
}

function realmForCase(fs: MemoryFs, cwd: string): { realm: WorkspaceRealm; context: Context } {
  const root = cwd.replace(/^\/+/, "");
  const realm = {
    agent: {},
    fs: fs as unknown as FileSystem,
    sandboxPolicy: {},
    cwd,
    root: targetOf(root),
  } as unknown as WorkspaceRealm;
  const agent = {
    session: { header: { cwd } },
    ctx: {
      get: (key: string): unknown => {
        if (key === "fs") return fs;
        if (key === "sandboxPolicy") return {};
        return undefined;
      },
    },
  };
  const context = {
    typert: { lookups: { get: () => ({ resolve: async (): Promise<unknown> => agent }) } },
    logger: () => (): void => undefined,
  } as unknown as Context;
  return { realm, context };
}

async function callTasksIsolated(
  fs: MemoryFs,
  cwd: string,
  method: string,
  path: string,
  payload?: unknown
): Promise<CapturedResponse> {
  const captured: CapturedResponse = {};
  const response = {
    writeHead: (status: number): void => { captured.status = status; },
    end: (body?: string): void => {
      captured.body = body === undefined || body === "" ? undefined : JSON.parse(body) as unknown;
    },
  } as unknown as ServerResponse;
  const { context } = realmForCase(fs, cwd);
  const session = encodeURIComponent(cwd);
  const separator = path.includes("?") ? "&" : "?";
  const handled = await handleTasksRequest(
    context,
    incoming(method, `${path}${separator}sessionId=${session}`, payload),
    response,
    { maxBytes: 2 * 1024 * 1024 }
  );
  expect(handled).toBe(true);
  return captured;
}

function clearTaskCachesOnFirstUse(): void {
  // tasks 模块以 realm.cwd 为缓存键;默认 cwd 用例共享需显式清理,隔离用例不走此路径.
  clearTaskCaches();
}

function bodyOf<T>(response: CapturedResponse): T {
  return response.body as T;
}

describe("tasks: pure helpers", () => {
  it("validates run/step/candidate transitions", () => {
    expect(isLegalRunTransition("pending", "running")).toBe(true);
    expect(isLegalRunTransition("completed", "running")).toBe(false);
    expect(isLegalRunTransition("failed", "failed")).toBe(true);
    expect(isLegalStepTransition("pending", "running")).toBe(true);
    expect(isLegalStepTransition("done", "running")).toBe(false);
    expect(isLegalStepTransition("failed", "failed")).toBe(true);
    expect(isLegalCandidateTransition("proposed", "confirmed")).toBe(true);
    expect(isLegalCandidateTransition("proposed", "applied")).toBe(false);
    expect(isLegalCandidateTransition("confirmed", "applied")).toBe(true);
    expect(isLegalCandidateTransition("applied", "confirmed")).toBe(false);
  });

  it("exposes the three demo recipes and strips checkpoints from summaries", () => {
    expect(recipeStepsFor("novel-chapter")).toEqual(["细纲", "草稿", "自检", "审稿", "采纳"]);
    expect(recipeStepsFor("drama-batch")).toHaveLength(4);
    expect(recipeStepsFor("game-content")).toHaveLength(4);
    expect(recipeStepsFor("unknown-kind")).toBeUndefined();
    expect(Object.keys(RECIPE_REGISTRY).sort()).toEqual(["drama-batch", "game-content", "novel-chapter"]);
    expect(resolveCommitterKind("file")).toBe("file");
    expect(resolveCommitterKind("noop")).toBe("noop");
    expect(resolveCommitterKind("anything-else")).toBe("noop");
    expect(parseListLimit(null)).toBe(100);
    expect(parseListLimit("7")).toBe(7);
    const run = {
      id: "r", kind: "k", status: "running", meta: {}, steps: [], checkpoint: { a: 1 },
      events: [], createdAt: 1, updatedAt: 2, resumeCount: 0,
    } as TaskRun;
    expect(summarizeRun(run)).not.toHaveProperty("checkpoint");
  });

  it("picks the newest paused/failed run for resume", () => {
    const base = { kind: "novel-chapter", meta: {}, steps: [], events: [], createdAt: 1, resumeCount: 0 };
    const runs = [
      { ...base, id: "old", status: "paused", updatedAt: 10 },
      { ...base, id: "new", status: "failed", updatedAt: 20 },
      { ...base, id: "done", status: "completed", updatedAt: 30 },
    ] as TaskRun[];
    expect(selectResumeRun(runs, "novel-chapter")?.id).toBe("new");
    expect(selectResumeRun(runs, "other-kind")).toBeUndefined();
    expect(selectResumeRun(runs, "novel-chapter", ["paused"])?.id).toBe("old");
  });
});

describe("tasks: run lifecycle", () => {
  it("creates, steps, checkpoints, and resumes the newest paused run", async () => {
    const { fs, cwd } = isolatedFs({ "正文/第一章.md": "旧正文" });
    const created = await callTasksIsolated(fs, cwd, "POST", "/oh-story/tasks/run", { kind: "novel-chapter", meta: { chapter: 1 } });
    expect(created.status).toBe(200);
    const runId = bodyOf<{ run: TaskRun }>(created).run.id;
    // recipe 自动生成 5 步.
    expect(bodyOf<{ run: TaskRun }>(created).run.steps).toHaveLength(5);

    const added = await callTasksIsolated(fs, cwd, "POST", `/oh-story/tasks/run/${runId}/step`, { kind: "加更" });
    expect(added.status).toBe(200);
    expect(bodyOf<{ step: { ordinal: number } }>(added).step.ordinal).toBe(5);

    const running = await callTasksIsolated(fs, cwd, "POST", `/oh-story/tasks/run/${runId}/step/5/status`, { status: "running" });
    expect(running.status).toBe(200);
    const done = await callTasksIsolated(fs, cwd, "POST", `/oh-story/tasks/run/${runId}/step/5/status`, { status: "done", note: "写完" });
    expect(done.status).toBe(200);
    // 幂等重放不报错.
    const replay = await callTasksIsolated(fs, cwd, "POST", `/oh-story/tasks/run/${runId}/step/5/status`, { status: "done" });
    expect(replay.status).toBe(200);
    expect(bodyOf<{ idempotentReplay?: boolean }>(replay).idempotentReplay).toBe(true);
    // 非法回退 409.
    const illegal = await callTasksIsolated(fs, cwd, "POST", `/oh-story/tasks/run/${runId}/step/5/status`, { status: "running" });
    expect(illegal.status).toBe(409);

    const checkpoint = { draft: "partial-text", cursor: 42 };
    const saved = await callTasksIsolated(fs, cwd, "POST", `/oh-story/tasks/run/${runId}/checkpoint`, { checkpoint });
    expect(saved.status).toBe(200);
    expect(bodyOf<{ run: TaskRun }>(saved).run.checkpoint).toEqual(checkpoint);

    const event = await callTasksIsolated(fs, cwd, "POST", `/oh-story/tasks/run/${runId}/event`, { type: "note", detail: { by: "test" } });
    expect(event.status).toBe(200);

    const paused = await callTasksIsolated(fs, cwd, "POST", `/oh-story/tasks/run/${runId}/status`, { status: "paused" });
    expect(paused.status).toBe(200);
    const resumed = await callTasksIsolated(fs, cwd, "GET", "/oh-story/tasks/resume?kind=novel-chapter");
    expect(resumed.status).toBe(200);
    const resumedRun = bodyOf<{ run: TaskRun }>(resumed).run;
    expect(resumedRun.id).toBe(runId);
    expect(resumedRun.checkpoint).toEqual(checkpoint);
    expect(resumedRun.events.some((item) => item.type === "note")).toBe(true);
    // 摘要列表不含 checkpoint.
    const listed = await callTasksIsolated(fs, cwd, "GET", "/oh-story/tasks/runs?kind=novel-chapter");
    expect(listed.status).toBe(200);
    expect(bodyOf<{ runs: Array<Record<string, unknown>> }>(listed).runs[0]).not.toHaveProperty("checkpoint");
  });

  it("rejects illegal run transitions and unknown ids", async () => {
    const { fs, cwd } = isolatedFs();
    const created = await callTasksIsolated(fs, cwd, "POST", "/oh-story/tasks/run", { kind: "custom" });
    const runId = bodyOf<{ run: TaskRun }>(created).run.id;
    expect(bodyOf<{ run: TaskRun }>(created).run.steps).toEqual([]);
    const completed = await callTasksIsolated(fs, cwd, "POST", `/oh-story/tasks/run/${runId}/status`, { status: "running" });
    expect(completed.status).toBe(200);
    const finished = await callTasksIsolated(fs, cwd, "POST", `/oh-story/tasks/run/${runId}/status`, { status: "completed" });
    expect(finished.status).toBe(200);
    const reopen = await callTasksIsolated(fs, cwd, "POST", `/oh-story/tasks/run/${runId}/status`, { status: "running" });
    expect(reopen.status).toBe(409);
    const missing = await callTasksIsolated(fs, cwd, "GET", "/oh-story/tasks/run/nope");
    expect(missing.status).toBe(404);
    const noResume = await callTasksIsolated(fs, cwd, "GET", "/oh-story/tasks/resume?kind=custom");
    expect(noResume.status).toBe(404);
  });
});

describe("tasks: candidate staging", () => {
  it("runs proposed -> confirm -> apply(file writes with CAS), then idempotent replay", async () => {
    const { fs, files, cwd } = isolatedFs({ "正文/第一章.md": "旧正文" });
    const created = await callTasksIsolated(fs, cwd, "POST", "/oh-story/tasks/candidates", {
      kind: "file",
      title: "第一章修订",
      description: "AI 产出先落候选",
      payload: { target: "正文/第一章.md", content: "新正文" },
      target: "正文/第一章.md",
    });
    expect(created.status).toBe(200);
    const candidate = bodyOf<{ candidate: Candidate }>(created).candidate;
    expect(candidate.status).toBe("proposed");

    const confirmed = await callTasksIsolated(fs, cwd, "POST", `/oh-story/tasks/candidates/${candidate.id}/confirm`, { decidedBy: "author" });
    expect(confirmed.status).toBe(200);
    expect(bodyOf<{ candidate: Candidate }>(confirmed).candidate.status).toBe("confirmed");

    const applied = await callTasksIsolated(fs, cwd, "POST", `/oh-story/tasks/candidates/${candidate.id}/apply`);
    expect(applied.status).toBe(200);
    const appliedBody = bodyOf<{ candidate: Candidate; writtenPath?: string; writtenVersion?: string }>(applied);
    expect(appliedBody.candidate.status).toBe("applied");
    expect(appliedBody.writtenPath).toBe("正文/第一章.md");
    expect(typeof appliedBody.writtenVersion).toBe("string");

    // file committer 真实写入,版本随 CAS 前进.
    const root = cwd.replace(/^\/+/, "");
    expect(files.get(`${root}/正文/第一章.md`)?.content).toBe("新正文");
    expect(files.get(`${root}/正文/第一章.md`)?.version).toBe(appliedBody.writtenVersion);

    const replay = await callTasksIsolated(fs, cwd, "POST", `/oh-story/tasks/candidates/${candidate.id}/apply`);
    expect(replay.status).toBe(200);
    expect(bodyOf<{ idempotentReplay?: boolean }>(replay).idempotentReplay).toBe(true);
  });

  it("rejects unconfirmed apply, and supports reject/amend branches", async () => {
    const { fs, cwd } = isolatedFs();
    const draft = await callTasksIsolated(fs, cwd, "POST", "/oh-story/tasks/candidates", {
      kind: "noop",
      title: "待定建议",
      payload: { text: "hello" },
    });
    const id = bodyOf<{ candidate: Candidate }>(draft).candidate.id;
    const early = await callTasksIsolated(fs, cwd, "POST", `/oh-story/tasks/candidates/${id}/apply`);
    expect(early.status).toBe(409);

    const rejected = await callTasksIsolated(fs, cwd, "POST", `/oh-story/tasks/candidates/${id}/reject`);
    expect(bodyOf<{ candidate: Candidate }>(rejected).candidate.status).toBe("rejected");

    const second = await callTasksIsolated(fs, cwd, "POST", "/oh-story/tasks/candidates", {
      kind: "noop",
      title: "可修订建议",
      payload: { text: "v1" },
    });
    const secondId = bodyOf<{ candidate: Candidate }>(second).candidate.id;
    const amended = await callTasksIsolated(fs, cwd, "POST", `/oh-story/tasks/candidates/${secondId}/amend`, {
      payload: { text: "v2" },
    });
    expect(amended.status).toBe(200);
    const amendedBody = bodyOf<{ candidate: Candidate; previous: Candidate }>(amended);
    expect(amendedBody.candidate.status).toBe("proposed");
    expect(amendedBody.candidate.amendOf).toBe(secondId);
    expect(amendedBody.previous.status).toBe("amended");

    const inbox = await callTasksIsolated(fs, cwd, "GET", "/oh-story/tasks/candidates?status=proposed");
    expect(bodyOf<{ candidates: Candidate[] }>(inbox).candidates.some((item) => item.id === amendedBody.candidate.id)).toBe(true);
    const missing = await callTasksIsolated(fs, cwd, "POST", "/oh-story/tasks/candidates/nope/confirm");
    expect(missing.status).toBe(404);
  });

  it("keeps confirmed candidates appliable after their run fails", async () => {
    const { fs, files, cwd } = isolatedFs({ "正文/第一章.md": "旧正文" });
    const run = await callTasksIsolated(fs, cwd, "POST", "/oh-story/tasks/run", { kind: "novel-chapter" });
    const runId = bodyOf<{ run: TaskRun }>(run).run.id;
    const draft = await callTasksIsolated(fs, cwd, "POST", "/oh-story/tasks/candidates", {
      kind: "file",
      title: "已确认产物",
      payload: { target: "正文/第一章.md", content: "确认产物正文" },
      runId,
    });
    const candidateId = bodyOf<{ candidate: Candidate }>(draft).candidate.id;
    await callTasksIsolated(fs, cwd, "POST", `/oh-story/tasks/candidates/${candidateId}/confirm`);
    await callTasksIsolated(fs, cwd, "POST", `/oh-story/tasks/run/${runId}/status`, { status: "running" });
    const failed = await callTasksIsolated(fs, cwd, "POST", `/oh-story/tasks/run/${runId}/status`, { status: "failed" });
    expect(failed.status).toBe(200);
    // run 失败不影响已确认产物:仍可 apply 落库.
    const applied = await callTasksIsolated(fs, cwd, "POST", `/oh-story/tasks/candidates/${candidateId}/apply`);
    expect(applied.status).toBe(200);
    expect(bodyOf<{ candidate: Candidate }>(applied).candidate.status).toBe("applied");
    const root = cwd.replace(/^\/+/, "");
    expect(files.get(`${root}/正文/第一章.md`)?.content).toBe("确认产物正文");
  });

  it("degrades corrupt stores to empty arrays", async () => {
    const { fs, cwd } = isolatedFs();
    const root = cwd.replace(/^\/+/, "");
    const { context } = realmForCase(fs, cwd);
    void context;
    const runsTarget = await fs.resolve(".oh-story/tasks/runs.json", { cwd });
    await fs.writeText(runsTarget, "not-json{{{");
    const candidatesTarget = await fs.resolve(".oh-story/tasks/candidates.json", { cwd });
    await fs.writeText(candidatesTarget, "[broken");
    clearTaskCaches();
    const runs = await callTasksIsolated(fs, cwd, "GET", "/oh-story/tasks/runs");
    expect(runs.status).toBe(200);
    expect(bodyOf<{ runs: unknown[] }>(runs).runs).toEqual([]);
    const inbox = await callTasksIsolated(fs, cwd, "GET", "/oh-story/tasks/candidates");
    expect(inbox.status).toBe(200);
    expect(bodyOf<{ candidates: unknown[] }>(inbox).candidates).toEqual([]);
    void root;
  });
});

describe("tasks: shared-cwd smoke via default realm helper", () => {
  it("serves the run route on the default test realm", async () => {
    const { fs } = memoryFs({ "ws/正文/a.md": "x" });
    const created = await callTasks(fs, "POST", "/oh-story/tasks/run?sessionId=s", { kind: "custom" });
    expect(created.status).toBe(200);
    expect(realmFor(fs).cwd).toBe(CWD);
  });
});
