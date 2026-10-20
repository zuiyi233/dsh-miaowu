import type { StateInventory } from "./state-contract.js";

/**
 * Shared vocabulary for the read-only diagnostics surface. The engine receives
 * an already-collected environment; the route and the client only consume the
 * report shape, so neither has to know how a host service is reached.
 */
export type DiagnosticSeverity = "P0" | "P1" | "P2";
export type DiagnosticGroup = "host" | "runtime" | "workspace" | "data" | "credentials" | "integration";
export type DiagnosticStatus = "pass" | "warn" | "fail" | "unknown";
export type DiagnosticRepairId =
  | "rebuild-search-index"
  | "rerun-backup"
  | "clean-expired-locks"
  | "apply-state-migration";

export type DiagnosticEvidenceValue = string | number | boolean | null;

export interface DiagnosticCheck {
  readonly id: string;
  readonly group: DiagnosticGroup;
  readonly title: string;
  readonly status: DiagnosticStatus;
  /** Set for warn/fail; null for pass/unknown. */
  readonly severity: DiagnosticSeverity | null;
  readonly summary: string;
  /** Ordered user-facing steps. Empty for a pass. */
  readonly guidance: readonly string[];
  readonly repair?: DiagnosticRepairId | undefined;
  readonly evidence?: Readonly<Record<string, DiagnosticEvidenceValue>> | undefined;
}

export interface DiagnosticsSummary {
  readonly pass: number;
  readonly warn: number;
  readonly fail: number;
  readonly unknown: number;
  readonly p0: number;
  readonly p1: number;
  readonly p2: number;
}

export interface DiagnosticsReport {
  readonly generatedAt: string;
  readonly pluginVersion: string;
  readonly hostVersion: string | null;
  readonly readOnly: true;
  readonly checks: readonly DiagnosticCheck[];
  readonly summary: DiagnosticsSummary;
}

export interface DiagnosticsHostFacts {
  readonly version: string | null;
  readonly versionSource: string;
  readonly supportedRange: string;
}

export interface DiagnosticsRuntimeFacts {
  readonly node: string;
  readonly platform: string;
  readonly arch: string;
}

export interface DiagnosticsWorkspaceFacts {
  readonly rootLabel: string;
  readonly creativeProject: boolean;
  readonly stateDirectoryPresent: boolean;
  readonly fileCount: number;
  readonly state: StateInventory;
}

export interface DiagnosticsIntegrationFacts {
  readonly skills: { readonly total: number; readonly expectedMinimum: number };
  readonly tools: { readonly registered: readonly string[]; readonly expected: readonly string[] };
  readonly roles: { readonly registered: number; readonly expected: number };
  readonly presets: { readonly total: number; readonly available: boolean };
  readonly plugins: { readonly managerAvailable: boolean; readonly bundles: readonly string[] };
}

export interface DiagnosticsCredentialFacts {
  /** null when the host exposes no provider inventory; never the value itself. */
  readonly modelConfigured: boolean | null;
  readonly vaultEnabled: boolean;
  readonly vaultKeyPresent: boolean;
  readonly vaultSecretsPresent: boolean;
}

export interface DiagnosticsSessionFacts {
  readonly checked: boolean;
  readonly readable: boolean | null;
  readonly malformed: boolean;
  /** Why an unreadable session was not classified as malformed. */
  readonly reason?: "malformed" | "timeout" | "unreadable" | null;
  /** Already redacted by the collector; never a raw session payload. */
  readonly error: string | null;
}

export interface DiagnosticErrorRecord {
  readonly at: string;
  readonly source: string;
  readonly message: string;
}

export interface DiagnosticsEnvironment {
  readonly now: string;
  readonly pluginVersion: string;
  readonly host: DiagnosticsHostFacts;
  readonly runtime: DiagnosticsRuntimeFacts;
  readonly workspace: DiagnosticsWorkspaceFacts;
  readonly integration: DiagnosticsIntegrationFacts;
  readonly credentials: DiagnosticsCredentialFacts;
  readonly session: DiagnosticsSessionFacts;
  readonly errors: readonly DiagnosticErrorRecord[];
  /** Absolute prefixes replaced before any text enters a report. */
  readonly redaction: {
    readonly workspaceRoot: string;
    readonly homeDir: string;
  };
}

export interface SupportBundleInput {
  readonly report: DiagnosticsReport;
  readonly inventory: StateInventory;
  readonly plugin: {
    readonly name: string;
    readonly version: string;
    readonly source: string;
  };
  readonly host: {
    readonly version: string | null;
    readonly supportedRange: string;
    readonly bundles: readonly string[];
  };
  readonly runtime: DiagnosticsRuntimeFacts;
  readonly workspace: {
    readonly structure: readonly string[];
    readonly fileCount: number;
    readonly creativeProject: boolean;
  };
  readonly config: Readonly<Record<string, boolean | null>>;
  readonly logSummary: {
    readonly available: boolean;
    readonly note: string;
    readonly errors: readonly DiagnosticErrorRecord[];
  };
  readonly confirmedAt: string;
}

export interface SupportBundle {
  readonly schemaVersion: 1;
  readonly redacted: true;
  readonly generatedAt: string;
  readonly confirmedAt: string;
  readonly plugin: SupportBundleInput["plugin"];
  readonly host: SupportBundleInput["host"];
  readonly runtime: DiagnosticsRuntimeFacts;
  readonly workspace: SupportBundleInput["workspace"];
  readonly config: Readonly<Record<string, boolean | null>>;
  readonly diagnostics: DiagnosticsReport;
  readonly inventory: StateInventory;
  readonly logSummary: SupportBundleInput["logSummary"];
}

export interface DiagnosticRepairRequest {
  readonly action: DiagnosticRepairId;
  readonly confirm: true;
  readonly sessionId?: string | undefined;
}

export interface DiagnosticRepairResult {
  readonly action: DiagnosticRepairId;
  readonly ok: boolean;
  readonly changed: number;
  readonly message: string;
  readonly rollback?: string | undefined;
}

export const DIAGNOSTICS_ROUTES = {
  report: "/oh-story/diagnostics",
  bundle: "/oh-story/diagnostics/bundle",
  repair: "/oh-story/diagnostics/repair",
  inventory: "/oh-story/state/inventory",
  migrate: "/oh-story/state/migrate",
} as const;
