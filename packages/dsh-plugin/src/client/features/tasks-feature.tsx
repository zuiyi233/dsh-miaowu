import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { endpoint } from "../workbench-ui.js";
import { registerWorkbenchFeature, type WorkbenchFeatureProps } from "./registry.js";
import styles from "./tasks-feature.css?inline";

type View = "inbox" | "runs";

interface StepPayload {
  readonly ordinal: number;
  readonly kind: string;
  readonly status: string;
  readonly note?: string | undefined;
  readonly updatedAt: number;
}

interface EventPayload {
  readonly at: number;
  readonly type: string;
  readonly detail?: unknown;
}

interface RunPayload {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly meta: Record<string, unknown>;
  readonly steps: readonly StepPayload[];
  readonly checkpoint?: unknown;
  readonly events: readonly EventPayload[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly resumeCount: number;
}

interface CandidatePayload {
  readonly id: string;
  readonly runId?: string | undefined;
  readonly kind: string;
  readonly title: string;
  readonly description?: string | undefined;
  readonly payload: Record<string, unknown>;
  readonly target?: string | undefined;
  readonly status: string;
  readonly createdAt: number;
  readonly writtenPath?: string | undefined;
  readonly writtenVersion?: string | undefined;
}

interface ErrorPayload {
  readonly error?: string | undefined;
}

// 服务端状态机驱动按钮:终态/非法转移一律禁用,避免点了报 409 的死按钮.
const RUN_NEXT: Record<string, readonly string[]> = {
  pending: ["running", "paused", "cancelled", "failed"],
  running: ["awaiting_user", "paused", "completed", "failed", "cancelled"],
  awaiting_user: ["running", "paused", "completed", "failed", "cancelled"],
  paused: ["running", "cancelled", "failed", "completed"],
  failed: ["running", "cancelled"],
  completed: [],
  cancelled: [],
};
const STEP_NEXT: Record<string, readonly string[]> = {
  pending: ["running"],
  running: ["done", "failed"],
  done: [],
  failed: [],
};
const CANDIDATE_ACTIONS: Record<string, readonly string[]> = {
  proposed: ["confirm", "reject", "amend"],
  confirmed: ["apply", "reject", "amend"],
  rejected: [],
  amended: [],
  applied: [],
};
const RECIPE_KINDS = ["novel-chapter", "drama-batch", "game-content", "custom"];
const PAYLOAD_PREVIEW_LENGTH = 160;

function formatTime(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "-";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}

function payloadSummary(payload: Record<string, unknown>): string {
  const text = JSON.stringify(payload);
  return text.length > PAYLOAD_PREVIEW_LENGTH ? `${text.slice(0, PAYLOAD_PREVIEW_LENGTH)}…` : text;
}

function checkpointSummary(value: unknown): string {
  if (value === undefined || value === null) return "无 checkpoint";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > PAYLOAD_PREVIEW_LENGTH ? `${text.slice(0, PAYLOAD_PREVIEW_LENGTH)}…` : text;
}

async function readPayload(response: Response): Promise<Record<string, unknown>> {
  try {
    return await response.json() as Record<string, unknown>;
  } catch {
    return {};
  }
}

function TasksPanel({ sessionId }: WorkbenchFeatureProps): JSX.Element {
  const [view, setView] = useState<View>("inbox");
  const [candidates, setCandidates] = useState<CandidatePayload[]>([]);
  const [runs, setRuns] = useState<RunPayload[]>([]);
  const [selectedRun, setSelectedRun] = useState<RunPayload | undefined>(undefined);
  const [resumeCheckpoint, setResumeCheckpoint] = useState<unknown>(undefined);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState("proposed");
  const [newKind, setNewKind] = useState("novel-chapter");
  const [newMeta, setNewMeta] = useState("");

  const loadCandidates = useCallback(async (status: string): Promise<void> => {
    setLoading(true);
    setError(undefined);
    try {
      const url = new URL(endpoint("tasks/candidates", sessionId), globalThis.location.origin);
      url.searchParams.set("status", status);
      const response = await fetch(url.toString());
      const payload = await readPayload(response) as { candidates?: CandidatePayload[] } & ErrorPayload;
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${String(response.status)}`);
      setCandidates(payload.candidates ?? []);
    } catch (failure) {
      setCandidates([]);
      setError(failure instanceof Error ? failure.message : "加载候选失败。");
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  const loadRuns = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(undefined);
    try {
      const url = new URL(endpoint("tasks/runs", sessionId), globalThis.location.origin);
      url.searchParams.set("limit", "100");
      const response = await fetch(url.toString());
      const payload = await readPayload(response) as { runs?: RunPayload[] } & ErrorPayload;
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${String(response.status)}`);
      setRuns(payload.runs ?? []);
    } catch (failure) {
      setRuns([]);
      setError(failure instanceof Error ? failure.message : "加载任务失败。");
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    if (view === "inbox") void loadCandidates(statusFilter);
    else void loadRuns();
  }, [view, statusFilter, loadCandidates, loadRuns]);

  const mutate = useCallback(async (path: string, init?: RequestInit): Promise<Record<string, unknown>> => {
    const response = await fetch(new URL(endpoint(path, sessionId), globalThis.location.origin).toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      ...init,
    });
    const payload = await readPayload(response);
    if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : `HTTP ${String(response.status)}`);
    return payload;
  }, [sessionId]);

  const actOnCandidate = useCallback(async (id: string, action: "confirm" | "reject" | "apply"): Promise<void> => {
    setError(undefined);
    setMessage(undefined);
    try {
      const payload = await mutate(`tasks/candidates/${id}/${action}`);
      const candidate = payload.candidate as CandidatePayload | undefined;
      if (action === "apply") {
        const path = typeof payload.writtenPath === "string" ? payload.writtenPath : candidate?.writtenPath;
        const version = typeof payload.writtenVersion === "string" ? payload.writtenVersion : candidate?.writtenVersion;
        setMessage(path !== undefined ? `已应用: ${path}${version !== undefined ? `（版本 ${version}）` : ""}` : "已应用。");
      } else {
        setMessage(action === "confirm" ? "已确认（尚未写入，应用后才落库）。" : "已拒绝。");
      }
      await loadCandidates(statusFilter);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "候选操作失败。");
    }
  }, [loadCandidates, mutate, statusFilter]);

  const amendCandidate = useCallback(async (candidate: CandidatePayload): Promise<void> => {
    setError(undefined);
    setMessage(undefined);
    const title = globalThis.prompt("修订标题（留空沿用原标题）", candidate.title);
    if (title === null) return;
    try {
      await mutate(`tasks/candidates/${candidate.id}/amend`, {
        body: JSON.stringify(title.trim() === "" ? {} : { title: title.trim() }),
      });
      setMessage("已生成修订候选（旧候选标记 amended）。");
      await loadCandidates(statusFilter);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "修订失败。");
    }
  }, [loadCandidates, mutate, statusFilter]);

  const openRun = useCallback(async (id: string): Promise<void> => {
    setError(undefined);
    setMessage(undefined);
    setResumeCheckpoint(undefined);
    try {
      const response = await fetch(new URL(endpoint(`tasks/run/${id}`, sessionId), globalThis.location.origin).toString());
      const payload = await readPayload(response) as { run?: RunPayload } & ErrorPayload;
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${String(response.status)}`);
      setSelectedRun(payload.run);
    } catch (failure) {
      setSelectedRun(undefined);
      setError(failure instanceof Error ? failure.message : "加载任务详情失败。");
    }
  }, [sessionId]);

  const changeRunStatus = useCallback(async (id: string, status: string): Promise<void> => {
    setError(undefined);
    setMessage(undefined);
    try {
      const payload = await mutate(`tasks/run/${id}/status`, { body: JSON.stringify({ status }) });
      setMessage(`任务已置为 ${status}。`);
      setSelectedRun((payload.run as RunPayload | undefined) ?? undefined);
      await loadRuns();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "任务状态变更失败。");
    }
  }, [loadRuns, mutate]);

  const changeStepStatus = useCallback(async (runId: string, ordinal: number, status: string): Promise<void> => {
    setError(undefined);
    setMessage(undefined);
    try {
      await mutate(`tasks/run/${runId}/step/${String(ordinal)}/status`, { body: JSON.stringify({ status }) });
      setMessage(`步骤 ${String(ordinal)} 已置为 ${status}。`);
      await openRun(runId);
      await loadRuns();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "步骤状态变更失败。");
    }
  }, [loadRuns, mutate, openRun]);

  const resumeRun = useCallback(async (run: RunPayload): Promise<void> => {
    setError(undefined);
    setMessage(undefined);
    try {
      const response = await fetch(
        new URL(endpoint(`tasks/resume?kind=${encodeURIComponent(run.kind)}`, sessionId), globalThis.location.origin).toString()
      );
      const payload = await readPayload(response) as { run?: RunPayload } & ErrorPayload;
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${String(response.status)}`);
      setSelectedRun(payload.run);
      setResumeCheckpoint(payload.run?.checkpoint);
      setMessage("已取回最近可恢复任务的 checkpoint，请把 checkpoint 内容交还 Chat/Agent 继续。");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "恢复任务失败。");
    }
  }, [sessionId]);

  const createRun = useCallback(async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError(undefined);
    setMessage(undefined);
    let meta: Record<string, unknown> = {};
    if (newMeta.trim() !== "") {
      try {
        const parsed = JSON.parse(newMeta) as unknown;
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
        meta = parsed as Record<string, unknown>;
      } catch {
        setError("meta 必须是 JSON 对象。");
        return;
      }
    }
    try {
      const payload = await mutate("tasks/run", { body: JSON.stringify({ kind: newKind, meta }) });
      const run = payload.run as RunPayload | undefined;
      setMessage(run !== undefined ? `已创建任务 ${run.id}（${String(run.steps.length)} 步）。` : "已创建任务。");
      await loadRuns();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "创建任务失败。");
    }
  }, [loadRuns, mutate, newKind, newMeta]);

  const progress = useMemo(() => {
    const table = new Map<string, string>();
    for (const run of runs) {
      const done = run.steps.filter((step) => step.status === "done").length;
      table.set(run.id, `${String(done)} / ${String(run.steps.length)}`);
    }
    return table;
  }, [runs]);

  return <div className="oh-tasks-panel">
    <style>{styles}</style>
    <div className="oh-tasks-tabs" role="tablist" aria-label="任务与候选视图">
      <button
        type="button"
        role="tab"
        aria-selected={view === "inbox"}
        className={view === "inbox" ? "oh-tasks-tab-active" : "oh-tasks-tab"}
        onClick={() => { setView("inbox"); }}
      >
        候选收件箱
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={view === "runs"}
        className={view === "runs" ? "oh-tasks-tab-active" : "oh-tasks-tab"}
        onClick={() => { setView("runs"); }}
      >
        任务中心
      </button>
    </div>
    <div className="oh-tasks-status" role="status">
      {error !== undefined ? <span className="oh-tasks-error">{error}</span>
        : message !== undefined ? <span className="oh-tasks-message">{message}</span>
        : loading ? <span>加载中…</span> : null}
    </div>
    {view === "inbox"
      ? <section className="oh-tasks-inbox">
        <div className="oh-tasks-filter">
          <label className="oh-tasks-label" htmlFor="oh-tasks-status">状态</label>
          <select
            id="oh-tasks-status"
            className="oh-tasks-select"
            value={statusFilter}
            onChange={(event) => { setStatusFilter(event.target.value); }}
          >
            {["proposed", "confirmed", "rejected", "amended", "applied"].map((status) =>
              <option key={status} value={status}>{status}</option>)}
          </select>
          <button type="button" className="oh-tasks-reload" onClick={() => { void loadCandidates(statusFilter); }}>刷新</button>
        </div>
        {candidates.length === 0
          ? <p className="oh-tasks-empty">暂无候选。AI 产出会先落到这里，确认后才可应用写入。</p>
          : <ul className="oh-tasks-list">
            {candidates.map((candidate) => {
              const actions = CANDIDATE_ACTIONS[candidate.status] ?? [];
              return <li key={candidate.id} className="oh-tasks-card">
                <div className="oh-tasks-card-head">
                  <strong className="oh-tasks-title">{candidate.title}</strong>
                  <span className="oh-tasks-kind">{candidate.kind} · {candidate.status}</span>
                </div>
                {candidate.description !== undefined ? <p className="oh-tasks-desc">{candidate.description}</p> : null}
                <div className="oh-tasks-meta">
                  <span title={candidate.target ?? ""}>目标：{candidate.target ?? candidate.runId ?? "-"}</span>
                  <span>{formatTime(candidate.createdAt)}</span>
                </div>
                <code className="oh-tasks-payload" title={JSON.stringify(candidate.payload)}>{payloadSummary(candidate.payload)}</code>
                {candidate.writtenPath !== undefined
                  ? <div className="oh-tasks-meta">已写入：{candidate.writtenPath}{candidate.writtenVersion !== undefined ? `（${candidate.writtenVersion}）` : ""}</div>
                  : null}
                <div className="oh-tasks-actions">
                  {actions.includes("confirm")
                    ? <button type="button" className="oh-tasks-button" onClick={() => { void actOnCandidate(candidate.id, "confirm"); }}>确认</button>
                    : null}
                  {actions.includes("reject")
                    ? <button type="button" className="oh-tasks-button" onClick={() => { void actOnCandidate(candidate.id, "reject"); }}>拒绝</button>
                    : null}
                  {actions.includes("amend")
                    ? <button type="button" className="oh-tasks-button" onClick={() => { void amendCandidate(candidate); }}>修订</button>
                    : null}
                  {actions.includes("apply")
                    ? <button type="button" className="oh-tasks-button-primary" onClick={() => { void actOnCandidate(candidate.id, "apply"); }}>应用已确认</button>
                    : null}
                </div>
              </li>;
            })}
          </ul>}
      </section>
      : <section className="oh-tasks-runs">
        <form className="oh-tasks-create" onSubmit={(event) => { void createRun(event); }}>
          <label className="oh-tasks-label" htmlFor="oh-tasks-kind">新建运行</label>
          <select
            id="oh-tasks-kind"
            className="oh-tasks-select"
            value={newKind}
            onChange={(event) => { setNewKind(event.target.value); }}
          >
            {RECIPE_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
          </select>
          <input
            className="oh-tasks-input"
            value={newMeta}
            onChange={(event) => { setNewMeta(event.target.value); }}
            placeholder='meta JSON（可选，如 {"chapter": 1}）'
            aria-label="新建运行 meta"
          />
          <button type="submit" className="oh-tasks-button-primary">创建</button>
          <button type="button" className="oh-tasks-reload" onClick={() => { void loadRuns(); }}>刷新</button>
        </form>
        {runs.length === 0
          ? <p className="oh-tasks-empty">暂无任务。创建运行后可跟踪步骤、checkpoint 与审计事件。</p>
          : <ul className="oh-tasks-list">
            {runs.map((run) => <li key={run.id} className="oh-tasks-card">
              <div className="oh-tasks-card-head">
                <button type="button" className="oh-tasks-runlink" onClick={() => { void openRun(run.id); }} title={run.id}>
                  {run.kind} · {run.status}
                </button>
                <span className="oh-tasks-kind">进度 {progress.get(run.id) ?? "-"} · {formatTime(run.updatedAt)}</span>
              </div>
              {(run.status === "paused" || run.status === "failed")
                ? <div className="oh-tasks-actions">
                  <button type="button" className="oh-tasks-button-primary" onClick={() => { void resumeRun(run); }}>恢复</button>
                </div>
                : null}
            </li>)}
          </ul>}
        {selectedRun !== undefined
          ? <article className="oh-tasks-detail">
            <h4 className="oh-tasks-detail-title">{selectedRun.kind} · {selectedRun.status}</h4>
            <div className="oh-tasks-meta">checkpoint：{checkpointSummary(selectedRun.checkpoint)}</div>
            {resumeCheckpoint !== undefined
              ? <code className="oh-tasks-payload" title="恢复取回的 checkpoint">恢复 checkpoint：{checkpointSummary(resumeCheckpoint)}</code>
              : null}
            <ul className="oh-tasks-steps">
              {selectedRun.steps.map((step) => {
                const next = STEP_NEXT[step.status] ?? [];
                return <li key={step.ordinal} className="oh-tasks-step">
                  <span>#{String(step.ordinal)} {step.kind} · {step.status}{step.note !== undefined ? ` · ${step.note}` : ""}</span>
                  <span className="oh-tasks-actions">
                    {next.map((status) =>
                      <button
                        key={status}
                        type="button"
                        className="oh-tasks-button"
                        onClick={() => { void changeStepStatus(selectedRun.id, step.ordinal, status); }}
                      >
                        {status}
                      </button>)}
                  </span>
                </li>;
              })}
            </ul>
            <div className="oh-tasks-actions">
              {(RUN_NEXT[selectedRun.status] ?? []).map((status) =>
                <button
                  key={status}
                  type="button"
                  className="oh-tasks-button"
                  onClick={() => { void changeRunStatus(selectedRun.id, status); }}
                >
                  置为{status}
                </button>)}
              {(selectedRun.status === "paused" || selectedRun.status === "failed")
                ? <button type="button" className="oh-tasks-button-primary" onClick={() => { void resumeRun(selectedRun); }}>恢复</button>
                : null}
            </div>
            <ul className="oh-tasks-events">
              {selectedRun.events.map((event, index) =>
                <li key={`${String(event.at)}-${String(index)}`} className="oh-tasks-event">
                  {formatTime(event.at)} · {event.type}
                </li>)}
            </ul>
          </article>
          : null}
      </section>}
  </div>;
}

registerWorkbenchFeature({
  id: "tasks",
  label: "任务与候选",
  icon: "◫",
  workbenches: ["story", "drama"],
  component: TasksPanel,
});

export function registerTasksFeature(): void {
  // 面板在模块顶层注册,保留具名导出兼容既有导入.
}
