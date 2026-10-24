import type { StateEntryStatus } from "./state-contract.js";

/**
 * 连续性驾驶舱的只读契约。
 *
 * 驾驶舱只投影 `.oh-story/` 与创作树中已经存在的事实：不调用模型、不写宿主状态、
 * 不自动修改用户数据。快照与交接清单是仅有的两个显式动作，前者复用备份服务，
 * 后者只计算 manifest/checksum，不移动或打包文件。
 */

export const CONTINUITY_ROUTES = {
  overview: "/oh-story/continuity",
  handoff: "/oh-story/continuity/handoff",
  handoffVerify: "/oh-story/continuity/handoff/verify",
  snapshot: "/oh-story/continuity/snapshot",
} as const;

export const CONTINUITY_BACKUP_STALE_DAYS = 7;
export const CONTINUITY_CANDIDATE_STALE_DAYS = 7;
export const CONTINUITY_MAX_CHAPTERS = 2_000;
export const CONTINUITY_MAX_HANDOFF_FILES = 2_000;

export type ContinuityLevel = "P0" | "P1" | "P2";
export const CONTINUITY_LEVEL_ORDER: Readonly<Record<ContinuityLevel, number>> = {
  P0: 0,
  P1: 1,
  P2: 2,
};

export type ContinuityProjectKind = "novel" | "drama" | "game" | "video" | "unknown";

export type ContinuityRiskId =
  | "state-corrupt"
  | "vault-key-missing"
  | "state-newer"
  | "active-book-missing"
  | "active-book-invalid"
  | "tracking-invalid"
  | "run-paused"
  | "run-failed"
  | "candidates-pending"
  | "foreshadow-due"
  | "backup-missing"
  | "backup-stale"
  | "tracking-behind"
  | "history-missing"
  | "search-index-missing"
  | "analysis-missing"
  | "recycle-expiring";

export interface ContinuityRisk {
  readonly id: ContinuityRiskId;
  readonly level: ContinuityLevel;
  readonly title: string;
  readonly detail: string;
  /** Workspace-relative paths a reader can open; empty when the risk has no file. */
  readonly paths: readonly string[];
  readonly nextAction: string;
}

export interface ContinuityStateAnomaly {
  readonly id: string;
  readonly path: string;
  readonly status: StateEntryStatus;
}

export interface ContinuityNextChapter {
  readonly ordinal: number;
  readonly latestPath: string | null;
  readonly latestTitle: string | null;
}

export interface ContinuityForeshadow {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly chapter?: string | undefined;
  readonly plannedPayoffChapter?: string | undefined;
  readonly importance: number;
}

export interface ContinuityRun {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly updatedAt: number;
}

export interface ContinuitySave {
  readonly path: string;
  readonly version: string;
  readonly timestamp: number;
}

export interface ContinuityTracking {
  readonly lastChapter: number | null;
  readonly stateRevision: number | null;
  readonly source: "tracking" | "absent" | "invalid";
}

export interface ContinuityToday {
  readonly nextChapter: ContinuityNextChapter;
  readonly dueForeshadows: readonly ContinuityForeshadow[];
  readonly pausedRuns: readonly ContinuityRun[];
  readonly proposedCandidates: number;
  readonly recentSaves: readonly ContinuitySave[];
  /** Epoch milliseconds, matching backup bundles. */
  readonly lastBackupAt: number | null;
  readonly backupAgeDays: number | null;
}

export interface ContinuityStats {
  readonly chapters: number;
  readonly chapterBytes: number;
  readonly foreshadows: Readonly<Record<"planned" | "planted" | "resolved" | "abandoned", number>>;
  readonly runs: Readonly<Record<"active" | "paused" | "failed" | "completed", number>>;
  readonly candidates: Readonly<Record<"proposed" | "confirmed" | "applied", number>>;
  readonly backups: number;
  readonly historyFiles: number;
  readonly auditEntries: number;
  readonly books: number;
  readonly anomalies: readonly ContinuityStateAnomaly[];
}

export interface ContinuityProject {
  readonly kind: ContinuityProjectKind;
  readonly title: string;
  /** Workspace-relative project root; "" means the workspace root itself. */
  readonly root: string;
  readonly tracking: ContinuityTracking;
}

export interface ContinuityOverview {
  readonly generatedAt: string;
  readonly readOnly: true;
  readonly project: ContinuityProject;
  readonly today: ContinuityToday;
  readonly stats: ContinuityStats;
  readonly risks: readonly ContinuityRisk[];
}

export interface ContinuityHandoffFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export type ContinuityHandoffSkipReason = "too-large" | "non-utf8" | "unreadable" | "depth-limit";

export interface ContinuityHandoffSkipped {
  readonly path: string;
  readonly reason: ContinuityHandoffSkipReason;
}

export interface ContinuityHandoffManifest {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly root: string;
  readonly files: readonly ContinuityHandoffFile[];
  readonly checksum: string;
  /** State files that could not be hashed; they are not covered by `checksum`. */
  readonly skipped: readonly ContinuityHandoffSkipped[];
  /** Paths intentionally left out (secrets, derived data, backups). */
  readonly excluded: readonly string[];
}

export interface ContinuitySnapshotResult {
  readonly path: string;
  readonly counts: {
    readonly files: number;
    readonly bytes: number;
  };
}

export type ContinuityHandoffVerifyStatus = "match" | "changed" | "missing" | "unreadable" | "unsafe";

export interface ContinuityHandoffVerifyFile {
  readonly path: string;
  readonly status: ContinuityHandoffVerifyStatus;
}

export interface ContinuityHandoffVerifyResult {
  readonly ok: boolean;
  readonly checksumOk: boolean;
  readonly checked: number;
  readonly matched: number;
  readonly skipped: readonly ContinuityHandoffSkipped[];
  readonly files: readonly ContinuityHandoffVerifyFile[];
}
