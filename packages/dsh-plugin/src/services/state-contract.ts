/**
 * Shared version contract for plugin-owned `.oh-story` documents.
 *
 * A document without a schema version is legacy version 0: it stays readable
 * and is never rewritten implicitly. A document newer than this build is
 * reported and left untouched. Only an explicit, confirmed migration may
 * write, and every migration carries a restorable backup directory.
 */
export const STATE_SCHEMA_VERSION = 1;

export type StateFormat = "json" | "jsonl" | "file-set" | "file";
export type StateCountMode = "array" | "keys" | "lines" | "files" | "none";

export interface StateDescriptor {
  readonly id: string;
  /** Workspace-relative path; a trailing slash marks a directory of documents. */
  readonly path: string;
  readonly format: StateFormat;
  /** Version this build writes. */
  readonly schemaVersion: number;
  /** Versions readable without rewriting: 0 is an unversioned legacy document. */
  readonly readableVersions: readonly number[];
  /** Top-level field carrying the schema version (default `schemaVersion`). */
  readonly versionKey?: string;
  readonly count: StateCountMode;
  /** Top-level field holding the counted array when count is `array`. */
  readonly entriesKey?: string;
  /** Fields that may carry a document timestamp; the newest wins. */
  readonly timestampKeys?: readonly string[];
  /** Presence/metadata only: contents never enter a report. */
  readonly secret?: boolean;
  /** Derived data (search index) is rebuildable, never migrated. */
  readonly derived?: boolean;
  /** Historical snapshots stay byte-for-byte; readable, never rewritten. */
  readonly immutable?: boolean;
  /** Direct children ignored by a file-set (e.g. the index manifest beside line shards). */
  readonly excludeFiles?: readonly string[];
  readonly description: string;
}

export const STATE_DESCRIPTORS: readonly StateDescriptor[] = [
  {
    id: "search-meta",
    path: ".oh-story/index/meta.json",
    format: "json",
    schemaVersion: 1,
    readableVersions: [0, 1],
    count: "keys",
    derived: true,
    description: "全文检索的文件清单",
  },
  {
    id: "search-index",
    path: ".oh-story/index/",
    format: "file-set",
    schemaVersion: 1,
    readableVersions: [0, 1],
    count: "lines",
    derived: true,
    excludeFiles: ["meta.json"],
    description: "全文检索的单文件行索引",
  },
  {
    id: "history",
    path: ".oh-story/history/",
    format: "jsonl",
    schemaVersion: 1,
    readableVersions: [0, 1],
    count: "lines",
    timestampKeys: ["timestamp"],
    description: "文件历史快照",
  },
  {
    id: "audit",
    path: ".oh-story/audit.jsonl",
    format: "jsonl",
    schemaVersion: 1,
    readableVersions: [0, 1],
    count: "lines",
    timestampKeys: ["timestamp"],
    description: "写入审计流水",
  },
  {
    id: "annotations",
    path: ".oh-story/annotations.json",
    format: "json",
    schemaVersion: 1,
    readableVersions: [0, 1],
    count: "keys",
    description: "文件批注",
  },
  {
    id: "analysis",
    path: ".oh-story/analysis/",
    format: "file-set",
    schemaVersion: 1,
    readableVersions: [0, 1],
    count: "array",
    entriesKey: "scenes",
    timestampKeys: ["parsedAt"],
    description: "拆书结构化结果",
  },
  {
    id: "tasks-runs",
    path: ".oh-story/tasks/runs.json",
    format: "json",
    schemaVersion: 1,
    readableVersions: [0, 1],
    count: "array",
    timestampKeys: ["updatedAt", "createdAt"],
    description: "任务运行记录",
  },
  {
    id: "tasks-candidates",
    path: ".oh-story/tasks/candidates.json",
    format: "json",
    schemaVersion: 1,
    readableVersions: [0, 1],
    count: "array",
    timestampKeys: ["updatedAt", "createdAt"],
    description: "候选变更记录",
  },
  {
    id: "backup",
    path: ".oh-story/backup/",
    format: "file-set",
    schemaVersion: 1,
    readableVersions: [0, 1],
    count: "array",
    entriesKey: "files",
    timestampKeys: ["createdAt"],
    immutable: true,
    description: "备份包清单",
  },
  {
    id: "foreshadows",
    path: ".oh-story/foreshadows.json",
    format: "json",
    schemaVersion: 1,
    readableVersions: [0, 1],
    count: "array",
    entriesKey: "items",
    timestampKeys: ["updatedAt"],
    description: "伏笔登记",
  },
  {
    id: "foreshadows-snooze",
    path: ".oh-story/foreshadows-snooze.json",
    format: "json",
    schemaVersion: 1,
    readableVersions: [0, 1],
    count: "array",
    entriesKey: "items",
    description: "伏笔提醒抑制",
  },
  {
    id: "shelf",
    path: ".oh-story/shelf.json",
    format: "json",
    schemaVersion: 1,
    readableVersions: [0, 1],
    count: "array",
    entriesKey: "entries",
    timestampKeys: ["updatedAt"],
    description: "书架索引",
  },
  {
    id: "locks",
    path: ".oh-story/locks/",
    format: "file-set",
    schemaVersion: 1,
    readableVersions: [0, 1],
    count: "files",
    timestampKeys: ["expiresAt", "createdAt"],
    derived: true,
    description: "工作区锁文件",
  },
  {
    id: "vault-secrets",
    path: ".oh-story/vault/secrets.json",
    format: "json",
    schemaVersion: 1,
    readableVersions: [1],
    versionKey: "v",
    count: "keys",
    secret: true,
    description: "密钥库密文信封（只盘点，不读取内容）",
  },
  {
    id: "vault-master-key",
    path: ".oh-story/vault/master.key",
    format: "file",
    schemaVersion: 1,
    readableVersions: [1],
    count: "none",
    secret: true,
    description: "密钥库主密钥（只盘点存在性）",
  },
];

export type StateEntryStatus = "ok" | "legacy" | "newer" | "corrupt" | "missing" | "not-inspected";

/** Descriptor lookup shared by diagnostics and the migration planner. */
export function stateDescriptorForId(id: string): StateDescriptor | undefined {
  return STATE_DESCRIPTORS.find((descriptor) => descriptor.id === id);
}

/**
 * Only durable JSON object documents migrate in v1. JSONL (append-only history/audit),
 * derived indexes/locks, secrets and top-level array documents (tasks) stay readable
 * as-is; changing their shape needs a dedicated migration.
 */
export function stateDescriptorMigratable(descriptor: StateDescriptor): boolean {
  return descriptor.derived !== true
    && descriptor.secret !== true
    && descriptor.immutable !== true
    && (descriptor.format === "json" || descriptor.format === "file-set")
    && !(descriptor.count === "array" && descriptor.entriesKey === undefined);
}

export interface StateInventoryEntry {
  readonly id: string;
  readonly path: string;
  readonly format: StateFormat;
  readonly expectedVersion: number;
  readonly schemaVersion: number | null;
  readonly status: StateEntryStatus;
  readonly fileCount: number;
  readonly entries: number | null;
  readonly bytes: number | null;
  /** Only a timestamp stored inside a document; the fs layer exposes no mtime. */
  readonly lastWriteAt: string | null;
  readonly lastWriteSource: "document" | "unavailable";
  readonly note?: string;
}

export interface StateInventory {
  readonly generatedAt: string;
  readonly schemaVersion: number;
  readonly entries: readonly StateInventoryEntry[];
}

export interface StateMigrationFile {
  readonly path: string;
  readonly format: "json" | "jsonl";
  readonly fromVersion: number;
}

export interface StateMigrationPlan {
  readonly id: string;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly files: readonly StateMigrationFile[];
  /** Workspace-relative backup directory written before the first change. */
  readonly backupDir: string;
  readonly reversible: true;
  readonly summary: string;
}

export interface StateMigrationManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly appliedAt: string;
  readonly backupDir: string;
  readonly files: readonly {
    readonly path: string;
    readonly hash: string;
  }[];
}

export interface StateMigrationResult {
  readonly plan: StateMigrationPlan;
  readonly manifest: StateMigrationManifest;
  readonly rollback: string;
}
