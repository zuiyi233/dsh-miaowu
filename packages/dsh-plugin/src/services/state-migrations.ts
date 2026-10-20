/**
 * 显式、可回滚的 `.oh-story` 状态迁移。
 *
 * 规则：只迁移未版本化（legacy v0）的普通 JSON 文档；派生索引、密钥库、
 * 追加型 JSONL 与缺失文件一概跳过；顶层数组文档（tasks 的 runs/candidates）
 * 无法在不改变形状的前提下加版本字段，同样跳过。规划与执行分离，执行必须
 * `confirm: true`，写前先把原文与清单落到备份目录，可原样回滚。
 */
import { createHash } from "node:crypto";
import type { FsTarget, FsVersion } from "@deepseek-ai/dsh-fs";
import { readVersionedFile, WorkspaceHttpError } from "../workspace-route.js";
import {
  STATE_DESCRIPTORS,
  STATE_SCHEMA_VERSION,
  stateDescriptorMigratable,
  type StateDescriptor,
  type StateInventory,
  type StateMigrationFile,
  type StateMigrationManifest,
  type StateMigrationPlan,
  type StateMigrationResult,
} from "./state-contract.js";
import {
  STATE_DOCUMENT_MAX_BYTES,
  stateInventoryFiles,
  type StateInventoryRealm,
} from "./state-inventory.js";

const MIGRATION_ID = "adopt-v1";
const MIGRATION_ROOT = ".oh-story/migrations";
const MANIFEST_NAME = "manifest.json";
const HASH_PATTERN = /^[a-f0-9]{64}$/u;

interface OriginalFile {
  readonly file: StateMigrationFile;
  readonly versionKey: string;
  readonly content: string;
  readonly parsed: Record<string, unknown>;
  readonly version: FsVersion;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 全部状态路径都必须是工作区内相对路径：无盘符/绝对路径/反斜杠/`.`/`..`。 */
function assertSafeRelative(path: string, label: string): void {
  const segments = path.split("/");
  if (
    path === ""
    || path.startsWith("/")
    || path.includes("\\")
    || path.includes("\0")
    || segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new WorkspaceHttpError(400, `${label}不是合法的工作区相对路径。`);
  }
}

function normalizeBackupDir(dir: string): string {
  const trimmed = dir.replace(/\/+$/u, "");
  const segments = trimmed.split("/");
  if (
    trimmed === ""
    || trimmed.startsWith("/")
    || trimmed.includes("\\")
    || trimmed.includes("\0")
    || segments.length < 3
    || segments[0] !== ".oh-story"
    || segments[1] !== "migrations"
    || segments.slice(2).some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new WorkspaceHttpError(400, "备份目录不合法（必须位于 .oh-story/migrations/ 下）。");
  }
  return trimmed;
}

function joinRelative(base: string, path: string): string {
  return `${base.replace(/\/+$/u, "")}/${path}`;
}

function descriptorForPath(path: string): StateDescriptor | undefined {
  return STATE_DESCRIPTORS.find((descriptor) =>
    descriptor.path.endsWith("/")
      ? path.length > descriptor.path.length && path.startsWith(descriptor.path)
      : descriptor.path === path
  );
}

function versionKeyOf(descriptor: StateDescriptor): string {
  return descriptor.versionKey ?? "schemaVersion";
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

async function workspaceTarget(realm: StateInventoryRealm, path: string): Promise<FsTarget> {
  const target = await realm.fs.resolve(path, { cwd: realm.cwd });
  if (!realm.fs.contains(realm.root, target)) {
    throw new WorkspaceHttpError(403, "状态文件路径离开了 DSH 工作目录。");
  }
  return target;
}

interface RequiredFile {
  readonly content: string;
  readonly version: FsVersion;
}

async function requiredFile(
  realm: StateInventoryRealm,
  path: string,
  missingStatus: number,
  missingMessage: string
): Promise<RequiredFile> {
  const target = await workspaceTarget(realm, path);
  const info = await realm.fs.stat(target).catch(() => undefined);
  if (info?.type !== "file") throw new WorkspaceHttpError(missingStatus, missingMessage);
  try {
    const file = await readVersionedFile(realm.fs, target, STATE_DOCUMENT_MAX_BYTES);
    return { content: file.content, version: file.version };
  } catch (error) {
    if (error instanceof WorkspaceHttpError) throw error;
    throw new WorkspaceHttpError(500, "状态文件读取失败。");
  }
}

function parseObject(content: string, status: number, message: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch {
    throw new WorkspaceHttpError(status, message);
  }
  if (!isRecord(value)) throw new WorkspaceHttpError(status, message);
  return value;
}

function validatePlan(plan: StateMigrationPlan): string {
  if (plan.id !== MIGRATION_ID) throw new WorkspaceHttpError(400, "未知的迁移计划。");
  if (plan.fromVersion !== 0 || plan.toVersion !== STATE_SCHEMA_VERSION) {
    throw new WorkspaceHttpError(400, "迁移计划版本不受支持。");
  }
  if (plan.reversible !== true) throw new WorkspaceHttpError(400, "迁移计划必须可回滚。");
  if (plan.files === undefined || plan.files.length === 0) {
    throw new WorkspaceHttpError(400, "迁移计划没有文件。");
  }
  const backupDir = normalizeBackupDir(plan.backupDir);
  const seen = new Set<string>();
  for (const file of plan.files) {
    assertSafeRelative(file.path, "迁移文件路径");
    if (seen.has(file.path)) throw new WorkspaceHttpError(400, "迁移计划包含重复文件。");
    seen.add(file.path);
    if (file.format !== "json" || file.fromVersion !== 0) {
      throw new WorkspaceHttpError(400, "迁移计划文件格式不受支持。");
    }
    const descriptor = descriptorForPath(file.path);
    if (descriptor === undefined) {
      throw new WorkspaceHttpError(400, `迁移计划包含未知状态文件：${file.path}`);
    }
    if (!stateDescriptorMigratable(descriptor)) {
      throw new WorkspaceHttpError(400, "派生数据、不可变快照或密钥文件不允许迁移。");
    }
    if (descriptor.format !== "json" && descriptor.format !== "file-set") {
      throw new WorkspaceHttpError(400, "该状态文件格式不允许迁移。");
    }
  }
  return backupDir;
}

function parseManifest(content: string): StateMigrationManifest {
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch {
    throw new WorkspaceHttpError(400, "备份清单不是有效 JSON。");
  }
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new WorkspaceHttpError(400, "备份清单版本不受支持。");
  }
  const rawFiles = value.files;
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
    throw new WorkspaceHttpError(400, "备份清单缺少文件列表。");
  }
  const files: { readonly path: string; readonly hash: string }[] = [];
  const seen = new Set<string>();
  for (const raw of rawFiles) {
    if (!isRecord(raw) || typeof raw.path !== "string" || typeof raw.hash !== "string") {
      throw new WorkspaceHttpError(400, "备份清单文件条目非法。");
    }
    assertSafeRelative(raw.path, "备份清单文件路径");
    if (!HASH_PATTERN.test(raw.hash)) throw new WorkspaceHttpError(400, "备份清单哈希格式非法。");
    if (seen.has(raw.path)) throw new WorkspaceHttpError(400, "备份清单包含重复文件。");
    seen.add(raw.path);
    files.push({ path: raw.path, hash: raw.hash });
  }
  return {
    schemaVersion: 1,
    id: typeof value.id === "string" ? value.id : "",
    appliedAt: typeof value.appliedAt === "string" ? value.appliedAt : "",
    backupDir: typeof value.backupDir === "string" ? value.backupDir : "",
    files,
  };
}

/**
 * 由只读盘点结果生成迁移计划。文件级明细来自盘点时记下的相对路径；
 * 若盘点对象是 JSON 反序列化出来的（没有明细），单文件 JSON 仍可规划，
 * 目录型文档因无法枚举具体文件而跳过。
 */
export function planStateMigrations(inventory: StateInventory): readonly StateMigrationPlan[] {
  const records = stateInventoryFiles(inventory);
  const files: StateMigrationFile[] = [];
  const seen = new Set<string>();
  for (const entry of inventory.entries) {
    if (entry.status !== "legacy") continue;
    const descriptor = STATE_DESCRIPTORS.find((candidate) => candidate.id === entry.id);
    if (descriptor === undefined || !stateDescriptorMigratable(descriptor)) continue;
    if (descriptor.format === "json" && !descriptor.path.endsWith("/")) {
      const record = records.find((candidate) => candidate.path === descriptor.path);
      if (record !== undefined) {
        if (record.version !== 0 || record.topLevel !== "object") continue;
      } else if (descriptor.count === "array" && descriptor.entriesKey === undefined) {
        // 契约上这是顶层数组文档（tasks 的 runs/candidates），无法加顶层版本字段。
        continue;
      }
      if (seen.has(descriptor.path)) continue;
      seen.add(descriptor.path);
      files.push({ path: descriptor.path, format: "json", fromVersion: 0 });
      continue;
    }
    if (descriptor.format === "file-set") {
      for (const record of records) {
        if (record.id !== descriptor.id || record.version !== 0 || record.topLevel !== "object") continue;
        if (seen.has(record.path)) continue;
        seen.add(record.path);
        files.push({ path: record.path, format: "json", fromVersion: 0 });
      }
    }
  }
  if (files.length === 0) return [];
  files.sort((left, right) => left.path.localeCompare(right.path));
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const backupDir = `${MIGRATION_ROOT}/${stamp}/`;
  return [{
    id: MIGRATION_ID,
    fromVersion: 0,
    toVersion: STATE_SCHEMA_VERSION,
    files,
    backupDir,
    reversible: true,
    summary: `将 ${files.length} 个未版本化的 .oh-story JSON 文档升级到 schemaVersion ${STATE_SCHEMA_VERSION}；写入前备份到 ${backupDir}，可随时回滚。`,
  }];
}

/**
 * 执行迁移：先重读并确认每个文件仍未版本化，再把原文与清单写入备份目录，
 * 校验备份后才给原文加 `schemaVersion: 1`。计划过期时整单拒绝，不部分执行。
 */
export async function applyStateMigration(
  realm: StateInventoryRealm,
  plan: StateMigrationPlan,
  options: { readonly confirm: true; readonly now?: string }
): Promise<StateMigrationResult> {
  if (options?.confirm !== true) {
    throw new WorkspaceHttpError(400, "状态迁移需要显式确认（confirm: true）。");
  }
  const backupDir = validatePlan(plan);

  const originals: OriginalFile[] = [];
  for (const file of plan.files) {
    const descriptor = descriptorForPath(file.path);
    if (descriptor === undefined) throw new WorkspaceHttpError(400, "迁移计划包含未知状态文件。");
    const versionKey = versionKeyOf(descriptor);
    const current = await requiredFile(realm, file.path, 409, "迁移计划已过期：状态文件不存在。");
    const parsed = parseObject(current.content, 409, "迁移计划已过期：状态文件不是 JSON 对象。");
    if (Object.prototype.hasOwnProperty.call(parsed, versionKey)) {
      throw new WorkspaceHttpError(409, `迁移计划已过期：${file.path} 已带有 ${versionKey}。`);
    }
    originals.push({ file, versionKey, content: current.content, parsed, version: current.version });
  }

  const appliedAt = options.now ?? new Date().toISOString();
  const manifest: StateMigrationManifest = {
    schemaVersion: 1,
    id: plan.id,
    appliedAt,
    backupDir,
    files: originals.map((original) => ({ path: original.file.path, hash: sha256(original.content) })),
  };

  const backupRoot = await workspaceTarget(realm, backupDir);
  const existingBackup = await realm.fs.stat(backupRoot).catch(() => undefined);
  if (existingBackup !== undefined) {
    throw new WorkspaceHttpError(409, "备份目录已存在，请重新生成迁移计划。");
  }

  try {
    for (const original of originals) {
      const target = await workspaceTarget(realm, joinRelative(backupDir, original.file.path));
      await realm.fs.writeText(target, original.content);
    }
    const manifestTarget = await workspaceTarget(realm, joinRelative(backupDir, MANIFEST_NAME));
    await realm.fs.writeText(manifestTarget, `${JSON.stringify(manifest, null, 2)}\n`);
  } catch {
    throw new WorkspaceHttpError(500, "迁移备份写入失败，未修改任何原文。");
  }

  for (const original of originals) {
    const backup = await requiredFile(
      realm,
      joinRelative(backupDir, original.file.path),
      500,
      "迁移备份校验失败，未修改任何原文。"
    );
    if (backup.content !== original.content) {
      throw new WorkspaceHttpError(500, "迁移备份校验失败，未修改任何原文。");
    }
  }

  const written: { readonly file: StateMigrationFile; readonly content: string; readonly version: FsVersion }[] = [];
  try {
    for (const original of originals) {
      const next: Record<string, unknown> = {
        [original.versionKey]: STATE_SCHEMA_VERSION,
        ...original.parsed,
      };
      const target = await workspaceTarget(realm, original.file.path);
      const outcome = await realm.fs.writeText(target, JSON.stringify(next), {
        kind: "replaceIfVersion",
        version: original.version,
      });
      written.push({ file: original.file, content: original.content, version: outcome.version });
    }
  } catch {
    // Multi-file writes cannot be atomic over the fs seam: compensate every file
    // already migrated by restoring its exact original under the version we wrote.
    // A concurrent edit makes that CAS fail, which is reported instead of overwritten.
    const restored: string[] = [];
    const failed: string[] = [];
    for (const item of [...written].reverse()) {
      try {
        const target = await workspaceTarget(realm, item.file.path);
        await realm.fs.writeText(target, item.content, { kind: "replaceIfVersion", version: item.version });
        restored.push(item.file.path);
      } catch {
        failed.push(item.file.path);
      }
    }
    const detail = failed.length === 0
      ? `迁移写入中断，已回滚 ${String(restored.length)} 个已写文件。`
      : `迁移写入中断，已回滚 ${String(restored.length)} 个文件；以下文件未能自动回滚：${failed.join("、")}。`;
    throw new WorkspaceHttpError(500, `${detail}完整原文已备份到 ${backupDir}，可按备份回滚。`);
  }

  return {
    plan,
    manifest,
    rollback: `已备份 ${originals.length} 个文件并完成迁移。回滚：POST /oh-story/state/migrate，请求体 {"action":"rollback","backupDir":"${backupDir}"}。`,
  };
}

/**
 * 按备份清单原样覆盖回滚。先校验全部备份（路径、SHA-256）再写，备份目录保留不删。
 */
export async function rollbackStateMigration(
  realm: StateInventoryRealm,
  backupDir: string,
  options: { readonly confirm: true }
): Promise<{ readonly restored: number; readonly backupDir: string }> {
  if (options?.confirm !== true) {
    throw new WorkspaceHttpError(400, "回滚需要显式确认（confirm: true）。");
  }
  const normalized = normalizeBackupDir(backupDir);
  const manifestFile = await requiredFile(
    realm,
    joinRelative(normalized, MANIFEST_NAME),
    404,
    "备份清单不存在。"
  );
  const manifest = parseManifest(manifestFile.content);
  if (manifest.id !== MIGRATION_ID) {
    throw new WorkspaceHttpError(400, "备份清单不是本插件产生的迁移。");
  }

  const snapshot: { readonly path: string; readonly content: string }[] = [];
  for (const file of manifest.files) {
    const descriptor = descriptorForPath(file.path);
    if (descriptor === undefined || !stateDescriptorMigratable(descriptor)) {
      throw new WorkspaceHttpError(400, "备份清单包含不可迁移的状态文件，回滚中止。");
    }
    const backup = await requiredFile(
      realm,
      joinRelative(normalized, file.path),
      404,
      "备份文件缺失，回滚中止。"
    );
    if (sha256(backup.content) !== file.hash) {
      throw new WorkspaceHttpError(400, "备份文件校验失败，回滚中止。");
    }
    snapshot.push({ path: file.path, content: backup.content });
  }

  for (const file of snapshot) {
    const target = await workspaceTarget(realm, file.path);
    await realm.fs.writeText(target, file.content);
  }
  return { restored: snapshot.length, backupDir: normalized };
}
