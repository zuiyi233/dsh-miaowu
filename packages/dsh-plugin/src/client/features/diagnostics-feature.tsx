import { useCallback, useEffect, useState } from "react";
import type { DiagnosticCheck, DiagnosticGroup, DiagnosticRepairId, DiagnosticsReport } from "../../services/diagnostics-contract.js";
import { endpoint } from "../workbench-ui.js";
import { registerWorkbenchFeature, type WorkbenchFeatureProps } from "./registry.js";
import styles from "./diagnostics-feature.css?inline";

/**
 * 「自诊断」面板:只读报告的展示 + 三处需显式确认的修复。
 *
 * 报告本身已由宿主侧脱敏；面板只做呈现，不重算诊断、不缓存宿主状态。
 * 所有请求失败都会显示出来，忙碌时按钮全部禁用，绝不静默吞掉。
 */

const GROUPS: readonly { readonly id: DiagnosticGroup; readonly label: string }[] = [
  { id: "host", label: "宿主" },
  { id: "runtime", label: "运行时" },
  { id: "workspace", label: "工作区" },
  { id: "data", label: "数据" },
  { id: "credentials", label: "凭据" },
  { id: "integration", label: "集成" },
];

const STATUS_LABELS: Readonly<Record<DiagnosticCheck["status"], string>> = {
  pass: "通过",
  warn: "注意",
  fail: "失败",
  unknown: "未知",
};

const REPAIR_LABELS: Readonly<Record<DiagnosticRepairId, string>> = {
  "rebuild-search-index": "重建检索索引",
  "rerun-backup": "重新备份",
  "clean-expired-locks": "检查过期锁",
  "apply-state-migration": "应用状态迁移",
};

const REPAIR_CONFIRM: Readonly<Record<DiagnosticRepairId, string>> = {
  "rebuild-search-index": "将重建 .oh-story 索引（只重写派生索引文件，不改动正文与状态文档）。确认继续？",
  "rerun-backup": "将创建一个全量备份包（.oh-story/backup/ 下的 JSON，不含 DSH 会话与凭据）。确认继续？",
  "clean-expired-locks": "将只读检查 .oh-story/locks/ 下的过期锁文件；插件不会删除任何文件，发现过期锁时会提示你手动处理。确认继续？",
  "apply-state-migration": "将把未版本化的 .oh-story 状态文档升级到 schemaVersion 1；写入前会先备份到 .oh-story/migrations/，可随时回滚。确认继续？",
};

const BUNDLE_CONFIRM =
  "支持包将包含：宿主与插件版本、运行时信息、工作区顶层结构（仅名称）、诊断结果与 .oh-story 状态盘点、配置存在性布尔值；"
  + "不包含文件内容、API Key、会话载荷或绝对路径。确认导出？";

interface RepairResultPayload {
  readonly action: DiagnosticRepairId;
  readonly ok: boolean;
  readonly changed: number;
  readonly message: string;
  readonly rollback?: string | undefined;
}

async function jsonOrThrow<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as T & { readonly error?: string };
  if (!response.ok) throw new Error(payload.error ?? `HTTP ${String(response.status)}`);
  return payload;
}

function formatEvidence(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  // 契约只允许原始值；万一收到意外结构也只显示占位符，绝不输出原始对象。
  return "—";
}

function groupChecks(report: DiagnosticsReport, group: DiagnosticGroup): readonly DiagnosticCheck[] {
  return report.checks.filter((check) => check.group === group);
}

export interface DiagnosticsViewProps {
  readonly report: DiagnosticsReport;
  readonly busy: boolean;
  readonly onRefresh: () => void;
  readonly onCopy: () => void;
  readonly onBundle: () => void;
  readonly onRepair: (action: DiagnosticRepairId) => void;
  readonly notice?: string | undefined;
  readonly error?: string | undefined;
  readonly rollbackText?: string | undefined;
  readonly copyFallback?: string | undefined;
}

function CheckCard({
  check,
  busy,
  onRepair,
}: {
  readonly check: DiagnosticCheck;
  readonly busy: boolean;
  readonly onRepair: (action: DiagnosticRepairId) => void;
}): JSX.Element {
  const repair = check.repair;
  const evidence: readonly (readonly [string, string])[] = Object.entries(check.evidence ?? {})
    .map(([key, value]) => [key, formatEvidence(value)] as const);
  return <article className="oh-diag-check" data-status={check.status}>
    <header className="oh-diag-check-head">
      <span className="oh-diag-badge" data-status={check.status}>{STATUS_LABELS[check.status]}</span>
      {check.severity !== null ? <span className="oh-diag-severity" data-severity={check.severity}>{check.severity}</span> : null}
      <h4 className="oh-diag-check-title">{check.title}</h4>
    </header>
    <p className="oh-diag-check-summary">{check.summary}</p>
    {check.guidance.length > 0
      ? <ul className="oh-diag-guidance">
        {check.guidance.map((step, index) => <li key={`${check.id}:guidance:${String(index)}`}>{step}</li>)}
      </ul>
      : null}
    {evidence.length > 0
      ? <dl className="oh-diag-evidence">
        {evidence.map(([key, value]) => <div className="oh-diag-evidence-row" key={`${check.id}:${key}`}>
          <dt>{key}</dt>
          <dd>{value}</dd>
        </div>)}
      </dl>
      : null}
    {repair !== undefined
      ? <button
        type="button"
        className="oh-diag-repair"
        disabled={busy}
        onClick={() => { onRepair(repair); }}
      >{REPAIR_LABELS[repair]}</button>
      : null}
  </article>;
}

/** 纯展示组件：只吃 props，可在 SSR/测试里直接渲染。 */
export function DiagnosticsView({
  report,
  busy,
  onRefresh,
  onCopy,
  onBundle,
  onRepair,
  notice,
  error,
  rollbackText,
  copyFallback,
}: DiagnosticsViewProps): JSX.Element {
  return <div className="oh-diag-body" aria-busy={busy}>
    <div className="oh-diag-bar">
      <span className="oh-diag-meta">
        诊断于 {report.generatedAt} · 插件 {report.pluginVersion} · 宿主 {report.hostVersion ?? "未知"}
      </span>
      <div className="oh-diag-actions">
        <button type="button" className="oh-diag-action" disabled={busy} onClick={onRefresh}>刷新</button>
        <button type="button" className="oh-diag-action" disabled={busy} onClick={onCopy}>复制报告</button>
        <button type="button" className="oh-diag-action" disabled={busy} onClick={onBundle}>导出支持包</button>
      </div>
    </div>
    <div className="oh-diag-chips" role="group" aria-label="诊断汇总">
      <span className="oh-diag-chip" data-kind="p0">P0 {report.summary.p0}</span>
      <span className="oh-diag-chip" data-kind="p1">P1 {report.summary.p1}</span>
      <span className="oh-diag-chip" data-kind="p2">P2 {report.summary.p2}</span>
      <span className="oh-diag-chip" data-kind="pass">通过 {report.summary.pass}</span>
      <span className="oh-diag-chip" data-kind="warn">注意 {report.summary.warn}</span>
      <span className="oh-diag-chip" data-kind="unknown">未知 {report.summary.unknown}</span>
    </div>
    {error !== undefined ? <p className="oh-diag-error" role="alert">{error}</p> : null}
    {notice !== undefined ? <p className="oh-diag-notice" role="status">{notice}</p> : null}
    {rollbackText !== undefined ? <p className="oh-diag-rollback">{rollbackText}</p> : null}
    {copyFallback !== undefined
      ? <textarea
        className="oh-diag-fallback"
        readOnly
        value={copyFallback}
        aria-label="可手动复制的诊断报告"
        onFocus={(event) => { event.currentTarget.select(); }}
      />
      : null}
    <div className="oh-diag-groups">
      {GROUPS.map((group) => {
        const checks = groupChecks(report, group.id);
        return <section className="oh-diag-group" key={group.id} data-group={group.id}>
          <h3 className="oh-diag-group-title">{group.label}</h3>
          {checks.length === 0
            ? <p className="oh-diag-empty">本轮没有检查项。</p>
            : checks.map((check) => <CheckCard key={check.id} check={check} busy={busy} onRepair={onRepair} />)}
        </section>;
      })}
    </div>
  </div>;
}

function downloadJson(value: unknown): void {
  const text = JSON.stringify(value, null, 2);
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = globalThis.document.createElement("a");
  anchor.href = url;
  anchor.download = `dsh-miaowu-support-${stamp}.json`;
  globalThis.document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function DiagnosticsPanel({ sessionId }: WorkbenchFeatureProps): JSX.Element {
  const [report, setReport] = useState<DiagnosticsReport | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [rollbackText, setRollbackText] = useState<string | undefined>(undefined);
  const [copyFallback, setCopyFallback] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState<string | undefined>(undefined);
  const busy = pending !== undefined;

  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    setPending("refresh");
    setError(undefined);
    try {
      const response = await fetch(endpoint("diagnostics", sessionId), signal === undefined ? undefined : { signal });
      const payload = await jsonOrThrow<DiagnosticsReport>(response);
      setReport(payload);
    } catch (failure) {
      if (failure instanceof DOMException && failure.name === "AbortError") return;
      setError(failure instanceof Error ? failure.message : "自诊断失败。");
    } finally {
      setPending(undefined);
    }
  }, [sessionId]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => { controller.abort(); };
  }, [load]);

  const refresh = useCallback((): void => {
    void load();
  }, [load]);

  const copyReport = useCallback(async (): Promise<void> => {
    if (report === undefined) return;
    const text = JSON.stringify(report, null, 2);
    setPending("copy");
    setError(undefined);
    setCopyFallback(undefined);
    try {
      const clipboard: Clipboard | undefined = navigator.clipboard;
      if (clipboard !== undefined) {
        try {
          await clipboard.writeText(text);
          setNotice("报告已复制（宿主侧已脱敏）。");
          return;
        } catch {
          // 剪贴板被拒绝时退回可选中的文本框，不吞掉这次操作。
        }
      }
      setCopyFallback(text);
      setNotice("剪贴板不可用，请手动选择下方文本复制。");
    } finally {
      setPending(undefined);
    }
  }, [report]);

  const exportBundle = useCallback(async (): Promise<void> => {
    if (!globalThis.confirm(BUNDLE_CONFIRM)) return;
    setPending("bundle");
    setError(undefined);
    setNotice(undefined);
    try {
      const response = await fetch(endpoint("diagnostics/bundle", sessionId), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      const payload = await jsonOrThrow<unknown>(response);
      downloadJson(payload);
      setNotice("支持包已导出（已脱敏）。");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "导出支持包失败。");
    } finally {
      setPending(undefined);
    }
  }, [sessionId]);

  const repair = useCallback(async (action: DiagnosticRepairId): Promise<void> => {
    if (!globalThis.confirm(REPAIR_CONFIRM[action])) return;
    setPending(action);
    setError(undefined);
    setNotice(undefined);
    setRollbackText(undefined);
    try {
      const response = await fetch(endpoint("diagnostics/repair", sessionId), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, confirm: true }),
      });
      const result = await jsonOrThrow<RepairResultPayload>(response);
      // 先刷新再落结果：刷新会清空旧错误，不能被本次结果覆盖掉顺序颠倒。
      await load();
      if (result.ok) {
        setNotice(result.message);
        setRollbackText(result.rollback);
      } else {
        setError(result.message);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "修复操作失败。");
    } finally {
      setPending(undefined);
    }
  }, [load, sessionId]);

  if (report === undefined) {
    return <div className="oh-diag-panel">
      <style>{styles}</style>
      <div className="oh-diag-state">
        {error !== undefined
          ? <>
            <p className="oh-diag-error" role="alert">{error}</p>
            <button type="button" className="oh-diag-action" disabled={busy} onClick={refresh}>重试</button>
          </>
          : <p className="oh-diag-meta">{busy ? "正在采集诊断…" : "尚无诊断结果，点「刷新」重试。"}</p>}
      </div>
    </div>;
  }

  return <div className="oh-diag-panel">
    <style>{styles}</style>
    <DiagnosticsView
      report={report}
      busy={busy}
      onRefresh={refresh}
      onCopy={() => { void copyReport(); }}
      onBundle={() => { void exportBundle(); }}
      onRepair={(action) => { void repair(action); }}
      notice={notice}
      error={error}
      rollbackText={rollbackText}
      copyFallback={copyFallback}
    />
  </div>;
}

registerWorkbenchFeature({
  id: "diagnostics",
  label: "自诊断",
  icon: "🩺",
  workbenches: ["story", "drama"],
  component: DiagnosticsPanel,
});

export function registerDiagnosticsFeature(): void {
  // 面板在模块顶层注册，保留具名导出兼容既有导入。
}
