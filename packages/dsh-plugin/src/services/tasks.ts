import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { FsTarget } from "@deepseek-ai/dsh-fs";
import {
  creativeTarget,
  jsonBody,
  mapFsError,
  readVersionedFile,
  send,
  workspaceRealm,
  WorkspaceHttpError,
  type WorkspaceRealm,
  type WorkspaceRouteOptions,
} from "../workspace-route.js";
import { registerWorkspaceExtension } from "./registry.js";

/**
 * 功能 B2 candidate staging + B3 run/step/checkpoint 共享底座.
 * 参考 NarraLume 域 5(候选三段式 + 幂等)与域 6(Run/Step 状态机 + checkpoint +
 * 服务端驱动 UI),以及 Scriverse 域 11 analysis_tasks 状态机.
 * 无本地数据库,全部落在 `.oh-story/tasks/` 下的 JSON 文件.
 */

export type RunStatus =
  | "pending"
  | "running"
  | "awaiting_user"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";
export type StepStatus = "pending" | "running" | "done" | "failed";
export type CandidateStatus = "proposed" | "confirmed" | "rejected" | "amended" | "applied";

export interface TaskStep {
  readonly ordinal: number;
  readonly kind: string;
  readonly status: StepStatus;
  readonly note?: string | undefined;
  readonly updatedAt: number;
}

export interface RunEvent {
  readonly at: number;
  readonly type: string;
  readonly detail?: unknown;
}

export interface TaskRun {
  readonly id: string;
  readonly kind: string;
  readonly status: RunStatus;
  readonly meta: Record<string, unknown>;
  readonly steps: readonly TaskStep[];
  readonly checkpoint?: unknown;
  readonly events: readonly RunEvent[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly resumeCount: number;
}

export type RunSummary = Omit<TaskRun, "checkpoint">;

export interface Candidate {
  readonly id: string;
  readonly runId?: string | undefined;
  readonly kind: string;
  readonly title: string;
  readonly description?: string | undefined;
  readonly payload: Record<string, unknown>;
  readonly target?: string | undefined;
  readonly status: CandidateStatus;
  readonly createdAt: number;
  readonly decidedAt?: number | undefined;
  readonly amendOf?: string | undefined;
  readonly decidedBy?: string | undefined;
  readonly writtenPath?: string | undefined;
  readonly writtenVersion?: string | undefined;
}

export interface Recipe {
  readonly kind: string;
  readonly steps: readonly string[];
  readonly defaultTarget?: string | undefined;
}

const TASKS_DIR = ".oh-story/tasks";
const RUNS_NAME = "runs.json";
const CANDIDATES_NAME = "candidates.json";
const STORE_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

const RUN_STATUSES: readonly RunStatus[] = [
  "pending",
  "running",
  "awaiting_user",
  "paused",
  "completed",
  "failed",
  "cancelled",
];
const STEP_STATUSES: readonly StepStatus[] = ["pending", "running", "done", "failed"];
const CANDIDATE_STATUSES: readonly CandidateStatus[] = [
  "proposed",
  "confirmed",
  "rejected",
  "amended",
  "applied",
];

/** 内置 recipe 注册表(demonstration adapter):三个通用底座用法. */
export const RECIPE_REGISTRY: Record<string, Recipe> = {
  "novel-chapter": { kind: "novel-chapter", steps: ["细纲", "草稿", "自检", "审稿", "采纳"] },
  "drama-batch": { kind: "drama-batch", steps: ["分镜", "生成", "质检", "成片"] },
  "game-content": { kind: "game-content", steps: ["设定", "文案", "数值", "验收"] },
};

/** createRun 时 kind 命中 recipe 自动生成对应 steps,未命中返回 undefined. */
export function recipeStepsFor(kind: string): string[] | undefined {
  const recipe = RECIPE_REGISTRY[kind];
  return recipe === undefined ? undefined : [...recipe.steps];
}

const RUN_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  pending: ["running", "paused", "cancelled", "failed"],
  running: ["awaiting_user", "paused", "completed", "failed", "cancelled"],
  awaiting_user: ["running", "paused", "completed", "failed", "cancelled"],
  paused: ["running", "cancelled", "failed", "completed"],
  failed: ["running", "cancelled"],
  completed: [],
  cancelled: [],
};

const STEP_TRANSITIONS: Record<StepStatus, readonly StepStatus[]> = {
  pending: ["running"],
  running: ["done", "failed"],
  done: [],
  failed: [],
};

export function isLegalRunTransition(from: RunStatus, to: RunStatus): boolean {
  if (from === to) return true;
  return RUN_TRANSITIONS[from]?.includes(to) ?? false;
}

export function isLegalStepTransition(from: StepStatus, to: StepStatus): boolean {
  if (from === to) return true;
  return STEP_TRANSITIONS[from]?.includes(to) ?? false;
}

/** 候选状态机:proposed 可确认/拒绝/修订;confirmed 可应用/拒绝/修订;终态不可动. */
export function isLegalCandidateTransition(from: CandidateStatus, to: CandidateStatus): boolean {
  if (from === to) return true;
  if (from === "proposed") return to === "confirmed" || to === "rejected" || to === "amended";
  if (from === "confirmed") return to === "applied" || to === "rejected" || to === "amended";
  return false;
}

export function summarizeRun(run: TaskRun): RunSummary {
  const { checkpoint: _dropped, ...rest } = run;
  void _dropped;
  return rest;
}

export function parseListLimit(raw: string | null): number {
  if (raw === null || raw === "") return DEFAULT_LIMIT;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) return DEFAULT_LIMIT;
  return Math.min(value, MAX_LIMIT);
}

export function parseStatusList(raw: string | null, valid: readonly string[]): string[] | undefined {
  if (raw === null || raw === "") return undefined;
  const list = raw.split(",").map((part) => part.trim()).filter((part) => part !== "");
  const kept = list.filter((item) => valid.includes(item));
  return kept.length === 0 ? [] : kept;
}

/** resume 入口:按 updatedAt 新→旧取最近的可恢复 run. */
export function selectResumeRun(
  runs: readonly TaskRun[],
  kind?: string,
  statuses: readonly string[] = ["paused", "failed"]
): TaskRun | undefined {
  const wanted = new Set(statuses);
  return [...runs]
    .filter((run) => (kind === undefined || kind === "" || run.kind === kind) && wanted.has(run.status))
    .sort((left, right) => right.updatedAt - left.updatedAt)[0];
}

// 进程内内存态:以 cwd 为键,磁盘写失败不丢内存(参考 videoPreflightCache 风格).
const runsMemory = new Map<string, TaskRun[]>();
const candidatesMemory = new Map<string, Candidate[]>();

/** 测试隔离用:清空进程内缓存. */
export function clearTaskCaches(): void {
  runsMemory.clear();
  candidatesMemory.clear();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asStep(value: unknown): TaskStep | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  if (!Number.isSafeInteger(record.ordinal) || typeof record.kind !== "string") return undefined;
  if (typeof record.status !== "string" || !(STEP_STATUSES as readonly string[]).includes(record.status)) {
    return undefined;
  }
  return {
    ordinal: record.ordinal as number,
    kind: record.kind,
    status: record.status as StepStatus,
    note: typeof record.note === "string" ? record.note : undefined,
    updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : 0,
  };
}

function asRunEvent(value: unknown): RunEvent | undefined {
  const record = asRecord(value);
  if (record === undefined || typeof record.at !== "number" || typeof record.type !== "string") {
    return undefined;
  }
  return { at: record.at, type: record.type, detail: record.detail };
}

function asRun(value: unknown): TaskRun | undefined {
  const record = asRecord(value);
  if (record === undefined || typeof record.id !== "string" || typeof record.kind !== "string") {
    return undefined;
  }
  if (typeof record.status !== "string" || !(RUN_STATUSES as readonly string[]).includes(record.status)) {
    return undefined;
  }
  const steps = Array.isArray(record.steps) ? record.steps.flatMap((s) => {
    const step = asStep(s);
    return step === undefined ? [] : [step];
  }) : [];
  const events = Array.isArray(record.events) ? record.events.flatMap((e) => {
    const event = asRunEvent(e);
    return event === undefined ? [] : [event];
  }) : [];
  return {
    id: record.id,
    kind: record.kind,
    status: record.status as RunStatus,
    meta: asRecord(record.meta) ?? {},
    steps,
    checkpoint: record.checkpoint,
    events,
    createdAt: typeof record.createdAt === "number" ? record.createdAt : 0,
    updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : 0,
    resumeCount: typeof record.resumeCount === "number" ? record.resumeCount : 0,
  };
}

function asCandidate(value: unknown): Candidate | undefined {
  const record = asRecord(value);
  if (record === undefined || typeof record.id !== "string" || typeof record.kind !== "string") {
    return undefined;
  }
  if (typeof record.title !== "string") return undefined;
  if (typeof record.status !== "string" || !(CANDIDATE_STATUSES as readonly string[]).includes(record.status)) {
    return undefined;
  }
  const payload = asRecord(record.payload);
  if (payload === undefined) return undefined;
  return {
    id: record.id,
    runId: typeof record.runId === "string" ? record.runId : undefined,
    kind: record.kind,
    title: record.title,
    description: typeof record.description === "string" ? record.description : undefined,
    payload,
    target: typeof record.target === "string" ? record.target : undefined,
    status: record.status as CandidateStatus,
    createdAt: typeof record.createdAt === "number" ? record.createdAt : 0,
    decidedAt: typeof record.decidedAt === "number" ? record.decidedAt : undefined,
    amendOf: typeof record.amendOf === "string" ? record.amendOf : undefined,
    decidedBy: typeof record.decidedBy === "string" ? record.decidedBy : undefined,
    writtenPath: typeof record.writtenPath === "string" ? record.writtenPath : undefined,
    writtenVersion: typeof record.writtenVersion === "string" ? record.writtenVersion : undefined,
  };
}

async function resolveTasksTarget(realm: WorkspaceRealm, name: string): Promise<FsTarget | undefined> {
  const target = await realm.fs.resolve(`${TASKS_DIR}/${name}`, { cwd: realm.cwd });
  return realm.fs.contains(realm.root, target) ? target : undefined;
}

/** 损坏 JSON 降级为空数组,绝不抛. */
function parseJsonArray(text: string): unknown[] {
  try {
    const value = JSON.parse(text) as unknown;
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

async function readStoreText(realm: WorkspaceRealm, name: string): Promise<string | undefined> {
  const target = await resolveTasksTarget(realm, name);
  if (target === undefined) return undefined;
  const info = await realm.fs.stat(target);
  if (info?.type !== "file") return undefined;
  try {
    const bytes = await realm.fs.readBytes(target, undefined, STORE_MAX_BYTES);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

export async function loadRuns(realm: WorkspaceRealm): Promise<TaskRun[]> {
  const cached = runsMemory.get(realm.cwd);
  if (cached !== undefined) return cached.map((run) => ({ ...run }));
  const text = await readStoreText(realm, RUNS_NAME);
  if (text === undefined) {
    runsMemory.set(realm.cwd, []);
    return [];
  }
  const runs = parseJsonArray(text).flatMap((item) => {
    const run = asRun(item);
    return run === undefined ? [] : [run];
  });
  runsMemory.set(realm.cwd, runs);
  return runs.map((run) => ({ ...run }));
}

export async function loadCandidates(realm: WorkspaceRealm): Promise<Candidate[]> {
  const cached = candidatesMemory.get(realm.cwd);
  if (cached !== undefined) return cached.map((item) => ({ ...item }));
  const text = await readStoreText(realm, CANDIDATES_NAME);
  if (text === undefined) {
    candidatesMemory.set(realm.cwd, []);
    return [];
  }
  const items = parseJsonArray(text).flatMap((item) => {
    const candidate = asCandidate(item);
    return candidate === undefined ? [] : [candidate];
  });
  candidatesMemory.set(realm.cwd, items);
  return items.map((item) => ({ ...item }));
}

/** 先写内存再写盘,写盘失败保留内存态(调用方不因持久化失败丢状态). */
async function saveRuns(realm: WorkspaceRealm, runs: readonly TaskRun[]): Promise<void> {
  runsMemory.set(realm.cwd, runs.map((run) => ({ ...run })));
  const target = await resolveTasksTarget(realm, RUNS_NAME);
  if (target === undefined) return;
  await realm.fs.writeText(target, JSON.stringify(runs), undefined, undefined, undefined).catch(() => undefined);
}

async function saveCandidates(realm: WorkspaceRealm, items: readonly Candidate[]): Promise<void> {
  candidatesMemory.set(realm.cwd, items.map((item) => ({ ...item })));
  const target = await resolveTasksTarget(realm, CANDIDATES_NAME);
  if (target === undefined) return;
  await realm.fs.writeText(target, JSON.stringify(items), undefined, undefined, undefined).catch(() => undefined);
}

function replaceRun(runs: readonly TaskRun[], next: TaskRun): TaskRun[] {
  return runs.map((run) => (run.id === next.id ? next : run));
}

function sandboxFor(realm: WorkspaceRealm): unknown {
  try {
    const policy = realm.sandboxPolicy as unknown as { resolve?: (arg: unknown) => unknown };
    if (typeof policy?.resolve !== "function") return undefined;
    return policy.resolve({ session: (realm.agent as { session?: unknown })?.session });
  } catch {
    return undefined;
  }
}

export function createRunRecord(kind: string, meta: Record<string, unknown>): TaskRun {
  const now = Date.now();
  const steps: TaskStep[] = (recipeStepsFor(kind) ?? []).map((name, index) => ({
    ordinal: index,
    kind: name,
    status: "pending",
    updatedAt: now,
  }));
  return {
    id: randomUUID(),
    kind,
    status: "pending",
    meta,
    steps,
    checkpoint: undefined,
    events: [{ at: now, type: "created", detail: { kind } }],
    createdAt: now,
    updatedAt: now,
    resumeCount: 0,
  };
}

/** committer 分发:file 写文件(走 CAS),noop 仅标记,未知 kind 按 noop 处理. */
export function resolveCommitterKind(kind: string): "file" | "noop" {
  return kind === "file" ? "file" : "noop";
}

export async function commitFileCandidate(
  realm: WorkspaceRealm,
  candidate: Candidate,
  maxBytes: number
): Promise<{ readonly writtenPath: string; readonly writtenVersion: string }> {
  const rawTarget = candidate.payload["target"] ?? candidate.target;
  const content = candidate.payload["content"];
  if (typeof rawTarget !== "string" || rawTarget === "") {
    throw new WorkspaceHttpError(400, "file 候选缺少 payload.target。");
  }
  if (typeof content !== "string") {
    throw new WorkspaceHttpError(400, "file 候选的 payload.content 必须是字符串。");
  }
  const target = await creativeTarget(realm, rawTarget);
  let baseVersion: string | undefined;
  try {
    baseVersion = String((await readVersionedFile(realm.fs, target, maxBytes)).version);
  } catch (error) {
    if (!(error instanceof WorkspaceHttpError) || error.status !== 404) throw error;
    baseVersion = undefined;
  }
  const outcome = baseVersion === undefined
    ? await realm.fs.writeText(target, content, undefined, undefined, sandboxFor(realm) as never)
    : await realm.fs.writeText(
      target,
      content,
      { kind: "replaceIfVersion", version: baseVersion as never },
      undefined,
      sandboxFor(realm) as never
    );
  return { writtenPath: rawTarget, writtenVersion: String(outcome.version) };
}

export async function applyCandidateRecord(
  realm: WorkspaceRealm,
  candidate: Candidate,
  maxBytes: number
): Promise<{ candidate: Candidate; idempotentReplay: boolean }> {
  if (candidate.status === "applied") {
    return { candidate, idempotentReplay: true };
  }
  if (candidate.status !== "confirmed") {
    throw new WorkspaceHttpError(409, "候选尚未确认。");
  }
  const now = Date.now();
  if (resolveCommitterKind(candidate.kind) === "noop") {
    return { candidate: { ...candidate, status: "applied", decidedAt: now }, idempotentReplay: false };
  }
  const written = await commitFileCandidate(realm, candidate, maxBytes);
  return {
    candidate: {
      ...candidate,
      status: "applied",
      decidedAt: now,
      writtenPath: written.writtenPath,
      writtenVersion: written.writtenVersion,
    },
    idempotentReplay: false,
  };
}

function requireString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

async function handleTasksRequest(
  context: Context,
  request: IncomingMessage,
  response: ServerResponse,
  options: WorkspaceRouteOptions
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (!url.pathname.startsWith("/oh-story/tasks")) return false;
  const realm = await workspaceRealm(context, url);
  const maxBytes = options.maxBytes > 0 ? options.maxBytes : STORE_MAX_BYTES;
  try {
    const parts = url.pathname.split("/");
    // parts: ["", "oh-story", "tasks", ...rest]
    const rest = parts.slice(3);
    if (request.method === "POST" && rest.length === 1 && rest[0] === "run") {
      const body = await jsonBody(request, maxBytes);
      const kind = requireString(body.kind);
      if (kind === undefined) throw new WorkspaceHttpError(400, "kind 必须是字符串。");
      const meta = asRecord(body.meta) ?? {};
      const run = createRunRecord(kind, meta);
      const runs = await loadRuns(realm);
      await saveRuns(realm, [...runs, run]);
      send(response, 200, { run: summarizeRun(run) });
      return true;
    }
    if (request.method === "GET" && rest.length === 1 && rest[0] === "runs") {
      const runs = await loadRuns(realm);
      const kind = url.searchParams.get("kind") ?? undefined;
      const statuses = parseStatusList(url.searchParams.get("status"), RUN_STATUSES);
      const filtered = runs.filter((run) =>
        (kind === undefined || kind === "" || run.kind === kind)
        && (statuses === undefined || statuses.includes(run.status))
      );
      const items = filtered.slice(0, parseListLimit(url.searchParams.get("limit")));
      send(response, 200, { runs: items.map(summarizeRun), total: filtered.length });
      return true;
    }
    if (request.method === "GET" && rest.length === 1 && rest[0] === "resume") {
      const runs = await loadRuns(realm);
      const kind = url.searchParams.get("kind") ?? undefined;
      const rawStatuses = parseStatusList(url.searchParams.get("status"), RUN_STATUSES);
      const found = selectResumeRun(runs, kind, rawStatuses ?? ["paused", "failed"]);
      if (found === undefined) throw new WorkspaceHttpError(404, "没有可恢复的任务。");
      send(response, 200, { run: found });
      return true;
    }
    if (request.method === "GET" && rest.length === 2 && rest[0] === "run") {
      const runs = await loadRuns(realm);
      const found = runs.find((run) => run.id === rest[1]);
      if (found === undefined) throw new WorkspaceHttpError(404, "任务不存在。");
      send(response, 200, { run: found });
      return true;
    }
    if (request.method === "POST" && rest.length === 3 && rest[0] === "run" && rest[2] === "step") {
      const body = await jsonBody(request, maxBytes);
      const kind = requireString(body.kind);
      if (kind === undefined) throw new WorkspaceHttpError(400, "kind 必须是字符串。");
      const runs = await loadRuns(realm);
      const found = runs.find((run) => run.id === rest[1]);
      if (found === undefined) throw new WorkspaceHttpError(404, "任务不存在。");
      const now = Date.now();
      const step: TaskStep = { ordinal: found.steps.length, kind, status: "pending", updatedAt: now };
      const next: TaskRun = { ...found, steps: [...found.steps, step], updatedAt: now };
      await saveRuns(realm, replaceRun(runs, next));
      send(response, 200, { step });
      return true;
    }
    if (request.method === "POST" && rest.length === 5 && rest[0] === "run" && rest[2] === "step" && rest[4] === "status") {
      const body = await jsonBody(request, maxBytes);
      const status = requireString(body.status);
      if (status === undefined || !(STEP_STATUSES as readonly string[]).includes(status)) {
        throw new WorkspaceHttpError(400, "status 非法。");
      }
      const ordinal = Number(rest[3]);
      if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw new WorkspaceHttpError(400, "ordinal 非法。");
      const runs = await loadRuns(realm);
      const found = runs.find((run) => run.id === rest[1]);
      if (found === undefined) throw new WorkspaceHttpError(404, "任务不存在。");
      const step = found.steps.find((item) => item.ordinal === ordinal);
      if (step === undefined) throw new WorkspaceHttpError(404, "步骤不存在。");
      const nextStatus = status as StepStatus;
      if (step.status === nextStatus) {
        send(response, 200, { step, idempotentReplay: true });
        return true;
      }
      if (!isLegalStepTransition(step.status, nextStatus)) {
        throw new WorkspaceHttpError(409, "步骤状态转移非法。");
      }
      const now = Date.now();
      const nextStep: TaskStep = {
        ...step,
        status: nextStatus,
        note: typeof body.note === "string" ? body.note : step.note,
        updatedAt: now,
      };
      const next: TaskRun = {
        ...found,
        steps: found.steps.map((item) => (item.ordinal === ordinal ? nextStep : item)),
        updatedAt: now,
      };
      await saveRuns(realm, replaceRun(runs, next));
      send(response, 200, { step: nextStep });
      return true;
    }
    if (request.method === "POST" && rest.length === 3 && rest[0] === "run" && rest[2] === "checkpoint") {
      const body = await jsonBody(request, maxBytes);
      if (!("checkpoint" in body)) throw new WorkspaceHttpError(400, "缺少 checkpoint。");
      const runs = await loadRuns(realm);
      const found = runs.find((run) => run.id === rest[1]);
      if (found === undefined) throw new WorkspaceHttpError(404, "任务不存在。");
      const now = Date.now();
      const next: TaskRun = { ...found, checkpoint: body.checkpoint, updatedAt: now };
      await saveRuns(realm, replaceRun(runs, next));
      send(response, 200, { run: next });
      return true;
    }
    if (request.method === "POST" && rest.length === 3 && rest[0] === "run" && rest[2] === "status") {
      const body = await jsonBody(request, maxBytes);
      const status = requireString(body.status);
      if (status === undefined || !(RUN_STATUSES as readonly string[]).includes(status)) {
        throw new WorkspaceHttpError(400, "status 非法。");
      }
      const runs = await loadRuns(realm);
      const found = runs.find((run) => run.id === rest[1]);
      if (found === undefined) throw new WorkspaceHttpError(404, "任务不存在。");
      const nextStatus = status as RunStatus;
      if (found.status === nextStatus) {
        send(response, 200, { run: summarizeRun(found), idempotentReplay: true });
        return true;
      }
      if (!isLegalRunTransition(found.status, nextStatus)) {
        throw new WorkspaceHttpError(409, "任务状态转移非法。");
      }
      const now = Date.now();
      const resumed = (found.status === "paused" || found.status === "failed") && nextStatus === "running";
      const next: TaskRun = {
        ...found,
        status: nextStatus,
        updatedAt: now,
        resumeCount: resumed ? found.resumeCount + 1 : found.resumeCount,
      };
      await saveRuns(realm, replaceRun(runs, next));
      send(response, 200, { run: summarizeRun(next) });
      return true;
    }
    if (request.method === "POST" && rest.length === 3 && rest[0] === "run" && rest[2] === "event") {
      const body = await jsonBody(request, maxBytes);
      const type = requireString(body.type);
      if (type === undefined) throw new WorkspaceHttpError(400, "type 必须是字符串。");
      const runs = await loadRuns(realm);
      const found = runs.find((run) => run.id === rest[1]);
      if (found === undefined) throw new WorkspaceHttpError(404, "任务不存在。");
      const now = Date.now();
      const event: RunEvent = { at: now, type, detail: body.detail };
      const next: TaskRun = { ...found, events: [...found.events, event], updatedAt: now };
      await saveRuns(realm, replaceRun(runs, next));
      send(response, 200, { event });
      return true;
    }
    if (request.method === "POST" && rest.length === 1 && rest[0] === "candidates") {
      const body = await jsonBody(request, maxBytes);
      const kind = requireString(body.kind);
      const title = requireString(body.title);
      const payload = asRecord(body.payload);
      if (kind === undefined || title === undefined || payload === undefined) {
        throw new WorkspaceHttpError(400, "kind/title/payload 必填。");
      }
      const now = Date.now();
      const candidate: Candidate = {
        id: randomUUID(),
        runId: requireString(body.runId),
        kind,
        title,
        description: typeof body.description === "string" ? body.description : undefined,
        payload,
        target: requireString(body.target),
        status: "proposed",
        createdAt: now,
      };
      const items = await loadCandidates(realm);
      await saveCandidates(realm, [...items, candidate]);
      send(response, 200, { candidate });
      return true;
    }
    if (request.method === "GET" && rest.length === 1 && rest[0] === "candidates") {
      const items = await loadCandidates(realm);
      const statusRaw = url.searchParams.get("status") ?? "proposed";
      const kind = url.searchParams.get("kind") ?? undefined;
      const statuses = parseStatusList(statusRaw, CANDIDATE_STATUSES) ?? ["proposed"];
      const filtered = items.filter((item) =>
        statuses.includes(item.status) && (kind === undefined || kind === "" || item.kind === kind)
      );
      const list = filtered.slice(0, parseListLimit(url.searchParams.get("limit")));
      send(response, 200, { candidates: list, total: filtered.length });
      return true;
    }
    if (request.method === "POST" && rest.length === 3 && rest[0] === "candidates" && rest[2] === "confirm") {
      const items = await loadCandidates(realm);
      const found = items.find((item) => item.id === rest[1]);
      if (found === undefined) throw new WorkspaceHttpError(404, "候选不存在。");
      if (found.status === "confirmed") {
        send(response, 200, { candidate: found, idempotentReplay: true });
        return true;
      }
      if (!isLegalCandidateTransition(found.status, "confirmed")) {
        throw new WorkspaceHttpError(409, "候选状态转移非法。");
      }
      const body = await jsonBody(request, maxBytes).catch((): Record<string, unknown> => ({}));
      const next: Candidate = {
        ...found,
        status: "confirmed",
        decidedAt: Date.now(),
        decidedBy: requireString(body.decidedBy),
      };
      await saveCandidates(realm, items.map((item) => (item.id === next.id ? next : item)));
      send(response, 200, { candidate: next });
      return true;
    }
    if (request.method === "POST" && rest.length === 3 && rest[0] === "candidates" && rest[2] === "reject") {
      const items = await loadCandidates(realm);
      const found = items.find((item) => item.id === rest[1]);
      if (found === undefined) throw new WorkspaceHttpError(404, "候选不存在。");
      if (found.status === "rejected") {
        send(response, 200, { candidate: found, idempotentReplay: true });
        return true;
      }
      if (!isLegalCandidateTransition(found.status, "rejected")) {
        throw new WorkspaceHttpError(409, "候选状态转移非法。");
      }
      const body = await jsonBody(request, maxBytes).catch((): Record<string, unknown> => ({}));
      const next: Candidate = {
        ...found,
        status: "rejected",
        decidedAt: Date.now(),
        decidedBy: requireString(body.decidedBy),
      };
      await saveCandidates(realm, items.map((item) => (item.id === next.id ? next : item)));
      send(response, 200, { candidate: next });
      return true;
    }
    if (request.method === "POST" && rest.length === 3 && rest[0] === "candidates" && rest[2] === "apply") {
      const items = await loadCandidates(realm);
      const found = items.find((item) => item.id === rest[1]);
      if (found === undefined) throw new WorkspaceHttpError(404, "候选不存在。");
      const { candidate: next, idempotentReplay } = await applyCandidateRecord(realm, found, maxBytes);
      if (!idempotentReplay) {
        await saveCandidates(realm, items.map((item) => (item.id === next.id ? next : item)));
      }
      send(response, 200, {
        candidate: next,
        ...(idempotentReplay ? { idempotentReplay: true } : {}),
        ...(next.writtenPath !== undefined ? { writtenPath: next.writtenPath } : {}),
        ...(next.writtenVersion !== undefined ? { writtenVersion: next.writtenVersion } : {}),
      });
      return true;
    }
    if (request.method === "POST" && rest.length === 3 && rest[0] === "candidates" && rest[2] === "amend") {
      const body = await jsonBody(request, maxBytes);
      const items = await loadCandidates(realm);
      const found = items.find((item) => item.id === rest[1]);
      if (found === undefined) throw new WorkspaceHttpError(404, "候选不存在。");
      if (!isLegalCandidateTransition(found.status, "amended")) {
        throw new WorkspaceHttpError(409, "候选状态转移非法。");
      }
      const now = Date.now();
      const revised: Candidate = {
        id: randomUUID(),
        runId: found.runId,
        kind: found.kind,
        title: requireString(body.title) ?? found.title,
        description: typeof body.description === "string" ? body.description : found.description,
        payload: asRecord(body.payload) ?? found.payload,
        target: requireString(body.target) ?? found.target,
        status: "proposed",
        createdAt: now,
        amendOf: found.id,
      };
      const previous: Candidate = { ...found, status: "amended", decidedAt: now };
      await saveCandidates(realm, [
        ...items.map((item) => (item.id === previous.id ? previous : item)),
        revised,
      ]);
      send(response, 200, { candidate: revised, previous });
      return true;
    }
    send(response, 404, { error: "Tasks route not found." });
    return true;
  } catch (error) {
    const mapped = error instanceof WorkspaceHttpError ? error : mapFsError(error);
    if (mapped === undefined) throw error;
    send(response, mapped.status, { error: mapped.message });
    return true;
  }
}

registerWorkspaceExtension({ name: "tasks", handle: handleTasksRequest });

export function registerTasksService(): void {
  // 模块顶层已注册扩展缝,保留具名导出供测试引用.
}

export { handleTasksRequest };
