import { readdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { basename } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { FsDirEntry } from "@deepseek-ai/dsh-fs";
import type {} from "@deepseek-ai/dsh-skill";
import type {} from "@deepseek-ai/dsh-tools";
import { SessionId } from "@deepseek-ai/dsh-session";
import {
  CREATIVE_DIRECTORIES,
  SHORT_STORY_FILES,
  jsonBody,
  readVersionedFile,
  send,
  workspaceRealm,
  WorkspaceHttpError,
  type WorkspaceRealm,
  type WorkspaceRouteOptions,
} from "../workspace-route.js";
import { defaultBundledRoleRoot } from "../role-provider.js";
import { registerWorkspaceExtension } from "./registry.js";
import {
  DIAGNOSTICS_ROUTES,
  type DiagnosticRepairId,
  type DiagnosticRepairResult,
  type DiagnosticsCredentialFacts,
  type DiagnosticsEnvironment,
  type DiagnosticsIntegrationFacts,
  type DiagnosticsSessionFacts,
} from "./diagnostics-contract.js";
import type { StateInventory } from "./state-contract.js";
import { buildDiagnosticsReport, redactDiagnosticsText } from "./diagnostics.js";
import {
  EXPECTED_ROLE_COUNT,
  EXPECTED_SKILL_MINIMUM,
  EXPECTED_TOOL_NAMES,
  readHostFacts,
  readPluginFacts,
  type PluginFacts,
} from "./plugin-facts.js";
import { buildStateInventory } from "./state-inventory.js";
import { applyStateMigration, planStateMigrations, rollbackStateMigration } from "./state-migrations.js";
import { buildSupportBundle } from "./support-bundle.js";
import { rebuildAll } from "./search.js";
import { createBackup } from "./backup.js";

/**
 * 只读诊断的宿主路由。
 *
 * 除三处显式确认的修复（重建检索索引、重新备份、清理过期锁的报告）与显式状态迁移外，
 * 所有路由只读工作区。诊断宁可整体失败也不返回“猜出来的通过”：
 * 技能/工具清单读不到就是 503，不把 0 当成 P0。
 */

const BODY_LIMIT = 64 * 1024;
const SESSION_TIMEOUT_MS = 5_000;
const SESSION_ERROR_MAX_LENGTH = 200;
const TOP_LEVEL_LIMIT = 10_000;
const STRUCTURE_LIMIT = 100;
const LOCK_DIRECTORY = ".oh-story/locks";
const LOCK_FILE_MAX_BYTES = 64 * 1024;
const REPAIR_ACTIONS: readonly DiagnosticRepairId[] = [
  "rebuild-search-index",
  "rerun-backup",
  "clean-expired-locks",
  "apply-state-migration",
];

interface CollectedEnvironment {
  readonly environment: DiagnosticsEnvironment;
  readonly structure: readonly string[];
  readonly plugin: PluginFacts;
}

/* -------------------------------------------------------------------------- */
/* 可选宿主服务读取（结构校验，不信任接口形状）                                */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface SkillListService {
  list(): Promise<readonly unknown[]>;
}

interface ToolSchemaService {
  schemas(): unknown;
}

interface PresetListService {
  list(): Promise<unknown>;
}

interface PluginManagerService {
  listBundles(): Promise<unknown>;
}

interface SessionQueryService {
  readSession(id: ReturnType<typeof SessionId>): Promise<unknown>;
}

function methodOf(value: unknown, name: string): ((...args: never[]) => unknown) | undefined {
  if (!isRecord(value)) return undefined;
  const method = value[name];
  return typeof method === "function" ? (method as (...args: never[]) => unknown) : undefined;
}

function skillService(context: Context): SkillListService | undefined {
  const value: unknown = (context as unknown as { readonly skills?: unknown }).skills;
  const list = methodOf(value, "list");
  return list === undefined ? undefined : (value as SkillListService);
}

function toolService(context: Context): ToolSchemaService | undefined {
  const value: unknown = (context as unknown as { readonly tools?: unknown }).tools;
  const schemas = methodOf(value, "schemas");
  return schemas === undefined ? undefined : (value as ToolSchemaService);
}

/** 读一个可能缺席的宿主服务；cordis 的 `get` 在未挂载时返回 undefined。 */
function optionalService(context: Context, name: string): unknown {
  const getter = (context as unknown as { readonly get?: (key: string) => unknown }).get;
  if (typeof getter !== "function") return undefined;
  try {
    return getter.call(context, name);
  } catch {
    return undefined;
  }
}

function presetService(context: Context): PresetListService | undefined {
  const value = optionalService(context, "agentPresets");
  return methodOf(value, "list") === undefined ? undefined : (value as PresetListService);
}

function pluginManagerService(context: Context): PluginManagerService | undefined {
  const value = optionalService(context, "pluginManager");
  return methodOf(value, "listBundles") === undefined ? undefined : (value as PluginManagerService);
}

function sessionQueryService(context: Context): SessionQueryService | undefined {
  const value = optionalService(context, "sessionQuery");
  return methodOf(value, "readSession") === undefined ? undefined : (value as SessionQueryService);
}

/* -------------------------------------------------------------------------- */
/* 环境采集                                                                    */
/* -------------------------------------------------------------------------- */

function homeDirectory(): string {
  try {
    return homedir();
  } catch {
    return "";
  }
}

async function skillTotal(context: Context): Promise<number> {
  const service = skillService(context);
  if (service === undefined) throw new WorkspaceHttpError(503, "无法读取技能清单。");
  try {
    const listing = await service.list();
    return listing.length;
  } catch {
    // 读不到技能清单就整体失败：把 0 当成 P0 是在撒谎，而不是诊断。
    throw new WorkspaceHttpError(503, "无法读取技能清单。");
  }
}

function toolNames(context: Context): string[] {
  const service = toolService(context);
  if (service === undefined) throw new WorkspaceHttpError(503, "无法读取工具清单。");
  let raw: unknown;
  try {
    raw = service.schemas();
  } catch {
    throw new WorkspaceHttpError(503, "无法读取工具清单。");
  }
  if (!Array.isArray(raw)) throw new WorkspaceHttpError(503, "无法读取工具清单。");
  const names: string[] = [];
  for (const item of raw) {
    if (isRecord(item) && typeof item.name === "string" && item.name !== "") names.push(item.name);
  }
  return names.sort();
}

/** 内置角色目录只读枚举；目录读不到时 0 是真实的 P1（角色确实不可用）。 */
function roleFileCount(): number {
  try {
    return readdirSync(defaultBundledRoleRoot(), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
      .length;
  } catch {
    return 0;
  }
}

async function presetFacts(context: Context): Promise<{ readonly total: number; readonly available: boolean }> {
  const service = presetService(context);
  if (service === undefined) return { total: 0, available: false };
  try {
    const listing: unknown = await service.list();
    if (!Array.isArray(listing)) return { total: 0, available: false };
    return { total: listing.length, available: true };
  } catch {
    return { total: 0, available: false };
  }
}

async function pluginFacts(context: Context): Promise<{ readonly managerAvailable: boolean; readonly bundles: readonly string[] }> {
  const service = pluginManagerService(context);
  if (service === undefined) return { managerAvailable: false, bundles: [] };
  try {
    const listing: unknown = await service.listBundles();
    if (!Array.isArray(listing)) return { managerAvailable: false, bundles: [] };
    const bundles: string[] = [];
    for (const item of listing) {
      if (isRecord(item) && typeof item.name === "string" && item.name !== "") bundles.push(item.name);
    }
    return { managerAvailable: true, bundles: bundles.sort() };
  } catch {
    return { managerAvailable: false, bundles: [] };
  }
}

async function collectIntegration(context: Context): Promise<DiagnosticsIntegrationFacts> {
  const total = await skillTotal(context);
  const registered = toolNames(context);
  return {
    skills: { total, expectedMinimum: EXPECTED_SKILL_MINIMUM },
    tools: { registered, expected: [...EXPECTED_TOOL_NAMES] },
    roles: { registered: roleFileCount(), expected: EXPECTED_ROLE_COUNT },
    presets: await presetFacts(context),
    plugins: await pluginFacts(context),
  };
}

function modelCredentialConfigured(): boolean | null {
  // The host exposes no provider/credential inventory here. Env vars are not proof
  // that the active DSH provider has a key, so reporting them as "configured"
  // would be a false pass; the engine renders this as an explicit unknown.
  return null;
}

function entryPresent(entryById: ReadonlyMap<string, { readonly status: string }>, id: string): boolean {
  const entry = entryById.get(id);
  return entry !== undefined && entry.status !== "missing";
}

function credentialFacts(inventory: StateInventory): DiagnosticsCredentialFacts {
  const entryById = new Map(inventory.entries.map((entry) => [entry.id, entry] as const));
  return {
    modelConfigured: modelCredentialConfigured(),
    vaultEnabled: process.env.DSH_MIAOWU_VAULT_ENABLED === "1",
    vaultKeyPresent: entryPresent(entryById, "vault-master-key"),
    vaultSecretsPresent: entryPresent(entryById, "vault-secrets"),
  };
}

function timeout(ms: number): Promise<never> {
  return new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("会话读取超时。"));
    }, ms);
    timer.unref();
  });
}

function sessionError(error: unknown, redaction: DiagnosticsEnvironment["redaction"]): string {
  const raw = error instanceof Error
    ? error.message
    : typeof error === "string" ? error : "会话读取失败。";
  const message = raw.trim() === "" ? "会话读取失败。" : raw.trim();
  const redacted = redactDiagnosticsText(message, redaction);
  return redacted.length > SESSION_ERROR_MAX_LENGTH ? `${redacted.slice(0, SESSION_ERROR_MAX_LENGTH)}…` : redacted;
}

/**
 * `readSession` rejects both for malformed replay data and for an unreadable or
 * missing session. Only replay/validation failures may be described as malformed;
 * everything else stays "unreadable" so the panel never advises deleting a
 * perfectly valid session.
 */
function sessionFailureReason(error: unknown): "malformed" | "timeout" | "unreadable" {
  if (error instanceof Error && error.message === "会话读取超时。") return "timeout";
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /replay|validat|malformed|tool source|畸形|校验/iu.test(text) ? "malformed" : "unreadable";
}

/**
 * 会话探测只经宿主的 `sessionQuery.readSession`，5 秒超时；绝不直读会话文件。
 * 服务缺席或没有 sessionId 时不探测（checked:false），而不是猜测。
 */
async function sessionFacts(
  context: Context,
  rawSessionId: string | null,
  redaction: DiagnosticsEnvironment["redaction"]
): Promise<DiagnosticsSessionFacts> {
  const service = sessionQueryService(context);
  if (service === undefined || rawSessionId === null || rawSessionId === "") {
    return { checked: false, readable: null, malformed: false, error: null };
  }
  try {
    await Promise.race([
      service.readSession(SessionId(rawSessionId)),
      timeout(SESSION_TIMEOUT_MS),
    ]);
    return { checked: true, readable: true, malformed: false, error: null };
  } catch (error) {
    const reason = sessionFailureReason(error);
    return {
      checked: true,
      readable: false,
      malformed: reason === "malformed",
      reason,
      error: sessionError(error, redaction),
    };
  }
}

interface WorkspaceScan {
  readonly rootLabel: string;
  readonly creativeProject: boolean;
  readonly stateDirectoryPresent: boolean;
  readonly fileCount: number;
  readonly structure: readonly string[];
  readonly state: StateInventory;
}

function isCreativeDirectory(name: string): boolean {
  return (CREATIVE_DIRECTORIES as readonly string[]).includes(name);
}

function isShortStoryFile(name: string): boolean {
  return (SHORT_STORY_FILES as readonly string[]).includes(name);
}

async function scanWorkspace(realm: WorkspaceRealm): Promise<WorkspaceScan> {
  let entries: FsDirEntry[];
  try {
    entries = await realm.fs.listDir(realm.root);
  } catch {
    throw new WorkspaceHttpError(503, "无法读取工作区目录。");
  }
  const stateEntry = entries.find((entry) => entry.name === ".oh-story");
  const creativeProject = entries.some((entry) => isCreativeDirectory(entry.name))
    || entries.some((entry) => entry.type === "file" && isShortStoryFile(entry.name))
    || stateEntry !== undefined;
  const structure = [...new Set(entries.map((entry) => entry.name))]
    .sort((left, right) => left.localeCompare(right, "zh-Hans-CN"))
    .slice(0, STRUCTURE_LIMIT);
  const rootLabel = basename(realm.cwd) || ".";
  return {
    rootLabel,
    creativeProject,
    stateDirectoryPresent: stateEntry?.type === "directory",
    fileCount: Math.min(entries.length, TOP_LEVEL_LIMIT),
    structure,
    state: await buildStateInventory(realm),
  };
}

async function collectEnvironment(
  context: Context,
  realm: WorkspaceRealm,
  rawSessionId: string | null
): Promise<CollectedEnvironment> {
  const redaction = { workspaceRoot: realm.cwd, homeDir: homeDirectory() };
  const plugin = readPluginFacts();
  const host = readHostFacts(context);
  const integration = await collectIntegration(context);
  const workspace = await scanWorkspace(realm);
  const environment: DiagnosticsEnvironment = {
    now: new Date().toISOString(),
    pluginVersion: plugin.version,
    host: {
      version: host.version,
      versionSource: host.versionSource,
      // 空范围写成 "unknown"：引擎会报“未知”，而不是把空串解析成不兼容。
      supportedRange: plugin.supportedRange === "" ? "unknown" : plugin.supportedRange,
    },
    runtime: {
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
    },
    workspace: {
      rootLabel: workspace.rootLabel,
      creativeProject: workspace.creativeProject,
      stateDirectoryPresent: workspace.stateDirectoryPresent,
      fileCount: workspace.fileCount,
      state: workspace.state,
    },
    integration,
    credentials: credentialFacts(workspace.state),
    session: await sessionFacts(context, rawSessionId, redaction),
    // 宿主没有官方日志接口：错误清单留空，支持包里明确写 available:false。
    errors: [],
    redaction,
  };
  return { environment, structure: workspace.structure, plugin };
}

/* -------------------------------------------------------------------------- */
/* 修复                                                                        */
/* -------------------------------------------------------------------------- */

function isRepairAction(value: string): value is DiagnosticRepairId {
  return (REPAIR_ACTIONS as readonly string[]).includes(value);
}

async function cleanExpiredLocks(realm: WorkspaceRealm): Promise<DiagnosticRepairResult> {
  const action: DiagnosticRepairId = "clean-expired-locks";
  const directory = await realm.fs.resolve(LOCK_DIRECTORY, { cwd: realm.cwd });
  if (!realm.fs.contains(realm.root, directory)) {
    return { action, ok: false, changed: 0, message: "锁目录离开了工作区，未做任何检查。" };
  }
  const info = await realm.fs.stat(directory).catch(() => undefined);
  if (info?.type !== "directory") {
    return { action, ok: true, changed: 0, message: "没有锁文件，无需清理。" };
  }
  let entries: FsDirEntry[];
  try {
    entries = await realm.fs.listDir(directory);
  } catch {
    return { action, ok: false, changed: 0, message: `锁目录 ${LOCK_DIRECTORY}/ 无法读取，无法确认是否存在过期锁。` };
  }
  if (entries.length === 0) {
    return { action, ok: true, changed: 0, message: "没有锁文件，无需清理。" };
  }

  const now = Date.now();
  const expired: string[] = [];
  const unreadable: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "file" || !entry.name.toLowerCase().endsWith(".json")) continue;
    if (!realm.fs.contains(directory, entry.target)) {
      unreadable.push(entry.name);
      continue;
    }
    let content: string;
    try {
      content = (await readVersionedFile(realm.fs, entry.target, LOCK_FILE_MAX_BYTES)).content;
    } catch {
      unreadable.push(entry.name);
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(content) as unknown;
    } catch {
      unreadable.push(entry.name);
      continue;
    }
    const expiresAt = isRecord(value) && typeof value.expiresAt === "string" ? Date.parse(value.expiresAt) : Number.NaN;
    if (!Number.isNaN(expiresAt) && expiresAt <= now) expired.push(entry.name);
  }

  if (expired.length > 0) {
    const extra = unreadable.length > 0 ? `另有 ${String(unreadable.length)} 个锁文件无法读取（${unreadable.join("、")}），也无法自动清理。` : "";
    return {
      action,
      ok: false,
      changed: 0,
      // 已安装的 DSH fs 缝没有删除 API：只报告，绝不代删、绝不用 node:fs 删宿主文件。
      message: `发现 ${String(expired.length)} 个已过期锁文件（${expired.join("、")}）；当前 DSH 文件系统接口没有删除能力，请手动删除这些文件：${LOCK_DIRECTORY}/。${extra}`,
    };
  }
  if (unreadable.length > 0) {
    return {
      action,
      ok: false,
      changed: 0,
      message: `有 ${String(unreadable.length)} 个锁文件无法读取（${unreadable.join("、")}），无法确认是否过期，也不能自动清理；请手动检查 ${LOCK_DIRECTORY}/。`,
    };
  }
  return { action, ok: true, changed: 0, message: "没有过期锁文件，无需清理。" };
}

async function applyAllMigrations(realm: WorkspaceRealm): Promise<DiagnosticRepairResult> {
  const action: DiagnosticRepairId = "apply-state-migration";
  const plans = planStateMigrations(await buildStateInventory(realm));
  if (plans.length === 0) {
    return { action, ok: true, changed: 0, message: "没有需要迁移的状态。" };
  }
  let changed = 0;
  const rollbacks: string[] = [];
  for (const plan of plans) {
    try {
      const result = await applyStateMigration(realm, plan, { confirm: true });
      changed += result.plan.files.length;
      rollbacks.push(result.rollback);
    } catch (error) {
      const reason = error instanceof WorkspaceHttpError ? error.message : "迁移写入失败。";
      const done = rollbacks.length === 0 ? "" : `；已完成的迁移可回滚：${rollbacks.join(" ")}`;
      throw new WorkspaceHttpError(500, `状态迁移中断，未继续后续计划：${reason}${done}`);
    }
  }
  const rollback = rollbacks.join(" ");
  return {
    action,
    ok: true,
    changed,
    message: `已迁移 ${String(changed)} 个状态文件。回滚：${rollback}`,
    rollback,
  };
}

async function runRepair(
  action: DiagnosticRepairId,
  realm: WorkspaceRealm,
  options: WorkspaceRouteOptions
): Promise<DiagnosticRepairResult> {
  switch (action) {
    case "rebuild-search-index": {
      const files = await rebuildAll(realm);
      return {
        action,
        ok: true,
        changed: files,
        message: `已重建检索索引，共 ${String(files)} 个文件。`,
      };
    }
    case "rerun-backup": {
      const backup = await createBackup(realm, "full", undefined, options.maxBytes);
      return {
        action,
        ok: true,
        changed: 1,
        message: `已创建全量备份 ${backup.path}（${String(backup.counts.files)} 个文件，${String(backup.counts.bytes)} 字节）。`,
      };
    }
    case "clean-expired-locks":
      return cleanExpiredLocks(realm);
    case "apply-state-migration":
      return applyAllMigrations(realm);
  }
}

/* -------------------------------------------------------------------------- */
/* 路由                                                                        */
/* -------------------------------------------------------------------------- */

function normalizeBackupDir(dir: string): string {
  return dir.replace(/\/+$/u, "");
}

async function handleMigratePost(
  context: Context,
  url: URL,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const body = await jsonBody(request, BODY_LIMIT);
  const action = body.action;
  if (action === "plan") {
    const realm = await workspaceRealm(context, url);
    const inventory = await buildStateInventory(realm);
    send(response, 200, { plans: planStateMigrations(inventory) });
    return;
  }
  if (action === "apply") {
    if (body.confirm !== true) {
      throw new WorkspaceHttpError(400, "应用状态迁移需要显式确认（confirm: true）。");
    }
    const realm = await workspaceRealm(context, url);
    const inventory = await buildStateInventory(realm);
    const id = typeof body.id === "string" && body.id !== "" ? body.id : undefined;
    const backupDir = typeof body.backupDir === "string" && body.backupDir !== ""
      ? normalizeBackupDir(body.backupDir)
      : undefined;
    const plan = planStateMigrations(inventory).find((candidate) => id === undefined || candidate.id === id);
    if (plan === undefined) {
      throw new WorkspaceHttpError(409, "迁移计划不存在或已过期，请重新生成计划后再试。");
    }
    // A plan returned by GET carries its millisecond backup directory. Re-planning
    // generates a new timestamp, so apply by id and honor the user-visible backup
    // directory instead of requiring the two timestamps to match.
    const appliedPlan = backupDir === undefined
      ? plan
      : { ...plan, backupDir: backupDir.endsWith("/") ? backupDir : `${backupDir}/` };
    send(response, 200, await applyStateMigration(realm, appliedPlan, { confirm: true }));
    return;
  }
  if (action === "rollback") {
    if (body.confirm !== true) {
      throw new WorkspaceHttpError(400, "回滚状态迁移需要显式确认（confirm: true）。");
    }
    const backupDir = typeof body.backupDir === "string" ? body.backupDir.trim() : "";
    if (backupDir === "") {
      throw new WorkspaceHttpError(400, "回滚需要提供备份目录（backupDir）。");
    }
    const realm = await workspaceRealm(context, url);
    send(response, 200, await rollbackStateMigration(realm, backupDir, { confirm: true }));
    return;
  }
  throw new WorkspaceHttpError(400, "未知的状态迁移操作（action 只能是 plan / apply / rollback）。");
}

async function handleBundlePost(
  context: Context,
  url: URL,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const body = await jsonBody(request, BODY_LIMIT);
  if (body.confirm !== true) {
    throw new WorkspaceHttpError(
      400,
      "支持包包含宿主与工作区元数据（版本、插件清单、状态盘点与诊断结果），必须显式确认（confirm: true）后才能导出。"
    );
  }
  const rawSessionId = url.searchParams.get("sessionId");
  const realm = await workspaceRealm(context, url);
  const collected = await collectEnvironment(context, realm, rawSessionId);
  const { environment } = collected;
  const report = buildDiagnosticsReport(environment);
  const credentials = environment.credentials;
  const bundle = buildSupportBundle({
    report,
    inventory: environment.workspace.state,
    plugin: { name: collected.plugin.name, version: collected.plugin.version, source: "packages/dsh-plugin/package.json" },
    host: {
      version: environment.host.version,
      supportedRange: environment.host.supportedRange,
      bundles: [...environment.integration.plugins.bundles],
    },
    runtime: environment.runtime,
    workspace: {
      structure: [...collected.structure],
      fileCount: environment.workspace.fileCount,
      creativeProject: environment.workspace.creativeProject,
    },
    config: {
      modelConfigured: credentials.modelConfigured,
      vaultEnabled: credentials.vaultEnabled,
      vaultKeyPresent: credentials.vaultKeyPresent,
      vaultSecretsPresent: credentials.vaultSecretsPresent,
      hostVersionFromEnv: (process.env.DSH_CLIENT_VERSION ?? "") !== "",
    },
    logSummary: {
      available: false,
      note: "DSH 未提供官方日志读取接口；本包只含诊断结果与状态盘点。",
      errors: [],
    },
    confirmedAt: new Date().toISOString(),
  }, environment.redaction);
  send(response, 200, bundle);
}

async function handleRepairPost(
  context: Context,
  url: URL,
  request: IncomingMessage,
  response: ServerResponse,
  options: WorkspaceRouteOptions
): Promise<void> {
  const body = await jsonBody(request, BODY_LIMIT);
  const action = body.action;
  if (typeof action !== "string" || !isRepairAction(action)) {
    throw new WorkspaceHttpError(400, "未知的修复操作。");
  }
  if (body.confirm !== true) {
    throw new WorkspaceHttpError(400, "修复操作会写入工作区，需要显式确认（confirm: true）。");
  }
  const realm = await workspaceRealm(context, url);
  send(response, 200, await runRepair(action, realm, options));
}

/** 供宿主路由扩展缝调用；命中返回 true，其余交回 `workspace-route.ts`。 */
export async function handleDiagnosticsRequest(
  context: Context,
  request: IncomingMessage,
  response: ServerResponse,
  options: WorkspaceRouteOptions
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  try {
    if (url.pathname === DIAGNOSTICS_ROUTES.report && request.method === "GET") {
      const rawSessionId = url.searchParams.get("sessionId");
      const realm = await workspaceRealm(context, url);
      const collected = await collectEnvironment(context, realm, rawSessionId);
      send(response, 200, buildDiagnosticsReport(collected.environment));
      return true;
    }
    if (url.pathname === DIAGNOSTICS_ROUTES.inventory && request.method === "GET") {
      const realm = await workspaceRealm(context, url);
      // 盘点对象的文件级边表只在本进程内用于迁移规划，序列化时自然消失。
      send(response, 200, await buildStateInventory(realm));
      return true;
    }
    if (url.pathname === DIAGNOSTICS_ROUTES.migrate && request.method === "GET") {
      const realm = await workspaceRealm(context, url);
      const inventory = await buildStateInventory(realm);
      send(response, 200, { plans: planStateMigrations(inventory) });
      return true;
    }
    if (url.pathname === DIAGNOSTICS_ROUTES.migrate && request.method === "POST") {
      await handleMigratePost(context, url, request, response);
      return true;
    }
    if (url.pathname === DIAGNOSTICS_ROUTES.bundle && request.method === "POST") {
      await handleBundlePost(context, url, request, response);
      return true;
    }
    if (url.pathname === DIAGNOSTICS_ROUTES.repair && request.method === "POST") {
      await handleRepairPost(context, url, request, response, options);
      return true;
    }
    return false;
  } catch (error) {
    if (error instanceof WorkspaceHttpError) {
      send(response, error.status, { error: error.message });
      return true;
    }
    context.logger("oh-story").error("diagnostics route failed", error);
    send(response, 500, { error: "自诊断失败。" });
    return true;
  }
}

registerWorkspaceExtension({ name: "diagnostics", handle: handleDiagnosticsRequest });

export function registerDiagnosticsExtension(): void {
  // 扩展在模块顶层注册，保留具名导出供测试与入口显式引用。
}
