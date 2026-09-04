import { useCallback, useEffect, useMemo, useState } from "react";
import type { Dispatch, FormEvent, SetStateAction } from "react";
import { endpoint } from "../workbench-ui.js";
import { registerWorkbenchFeature, type WorkbenchFeatureProps } from "./registry.js";
import styles from "./history-feature.css?inline";

type AnnotationKindOption = "note" | "todo" | "review";

interface VersionSummaryPayload {
  readonly version: string;
  readonly bytes: number;
  readonly source: "save" | "rollback";
  readonly timestamp: number;
}

interface AuditEntryPayload {
  readonly timestamp: number;
  readonly action: "save" | "rollback";
  readonly path: string;
  readonly version: string;
  readonly source: string;
  readonly detail?: string | undefined;
}

interface AnnotationPayload {
  readonly id: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly quote: string;
  readonly note: string;
  readonly kind: AnnotationKindOption;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly stale?: boolean | undefined;
  readonly moved?: boolean | undefined;
}

interface AnnotationDraft {
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly note: string;
  readonly kind: AnnotationKindOption;
}

interface DiffRow {
  readonly kind: "same" | "add" | "del";
  readonly text: string;
}

interface HistoryBundle {
  readonly versions: VersionSummaryPayload[];
  readonly audits: AuditEntryPayload[];
  readonly annotations: AnnotationPayload[];
  readonly content: string;
  readonly version: string;
}

// LCS 表做法参考 Scriverse chapter-version-diff.js(2M 格上限 + 退化为按行定位).
// 面板场景文本小得多:中间段超限直接退化为旧全删 + 新全增,保证 diff 永远可渲染.
const DIFF_CELL_LIMIT = 40000;
const MAX_TEXT_LENGTH = 400;

function truncate(text: string): string {
  return text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH)}…` : text;
}

/** 简单逐行 diff:公共前后缀直接对齐,中间段跑 LCS. */
export function lineDiff(before: string, after: string): DiffRow[] {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  let head = 0;
  while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) head += 1;
  let tail = 0;
  while (
    tail < oldLines.length - head
    && tail < newLines.length - head
    && oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) tail += 1;
  const rows: DiffRow[] = oldLines.slice(0, head).map((text) => ({ kind: "same" as const, text }));
  rows.push(...diffMiddle(oldLines.slice(head, oldLines.length - tail), newLines.slice(head, newLines.length - tail)));
  rows.push(...oldLines.slice(oldLines.length - tail).map((text) => ({ kind: "same" as const, text })));
  return rows;
}

function diffMiddle(oldMid: readonly string[], newMid: readonly string[]): DiffRow[] {
  if (oldMid.length === 0) return newMid.map((text) => ({ kind: "add" as const, text }));
  if (newMid.length === 0) return oldMid.map((text) => ({ kind: "del" as const, text }));
  if (oldMid.length * newMid.length > DIFF_CELL_LIMIT) {
    return [
      ...oldMid.map((text) => ({ kind: "del" as const, text })),
      ...newMid.map((text) => ({ kind: "add" as const, text })),
    ];
  }
  const table: number[][] = [];
  for (let i = 0; i <= oldMid.length; i += 1) table.push(new Array<number>(newMid.length + 1).fill(0));
  for (let i = oldMid.length - 1; i >= 0; i -= 1) {
    const row = table[i];
    const next = table[i + 1];
    if (row === undefined || next === undefined) continue;
    for (let j = newMid.length - 1; j >= 0; j -= 1) {
      row[j] = oldMid[i] === newMid[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  return walkDiffTable(table, oldMid, newMid);
}

function walkDiffTable(table: number[][], oldMid: readonly string[], newMid: readonly string[]): DiffRow[] {
  const cell = (i: number, j: number): number => table[i]?.[j] ?? 0;
  const out: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < oldMid.length && j < newMid.length) {
    if (oldMid[i] === newMid[j]) {
      out.push({ kind: "same", text: oldMid[i] ?? "" });
      i += 1;
      j += 1;
    } else if (cell(i + 1, j) >= cell(i, j + 1)) {
      out.push({ kind: "del", text: oldMid[i] ?? "" });
      i += 1;
    } else {
      out.push({ kind: "add", text: newMid[j] ?? "" });
      j += 1;
    }
  }
  while (i < oldMid.length) {
    out.push({ kind: "del", text: oldMid[i] ?? "" });
    i += 1;
  }
  while (j < newMid.length) {
    out.push({ kind: "add", text: newMid[j] ?? "" });
    j += 1;
  }
  return out;
}

function formatTime(timestamp: number): string {
  try {
    return new Date(timestamp).toLocaleString();
  } catch {
    return String(timestamp);
  }
}

function shortVersion(version: string): string {
  return version.length > 12 ? version.slice(0, 12) : version;
}

async function jsonOrThrow<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as T & { readonly error?: string };
  if (!response.ok) throw new Error(payload.error ?? `HTTP ${String(response.status)}`);
  return payload;
}

async function fetchHistoryBundle(sessionId: string, path: string, signal: AbortSignal): Promise<HistoryBundle> {
  const [history, audit, annotation, file] = await Promise.all([
    jsonOrThrow<{ readonly versions: VersionSummaryPayload[] }>(
      await fetch(endpoint("history", sessionId, path), { signal })),
    jsonOrThrow<{ readonly entries: AuditEntryPayload[] }>(
      await fetch(endpoint("history/audit", sessionId, path), { signal })),
    jsonOrThrow<{ readonly annotations: AnnotationPayload[] }>(
      await fetch(endpoint("annotations", sessionId, path), { signal })),
    jsonOrThrow<{ readonly content: string; readonly version: string }>(
      await fetch(endpoint("file", sessionId, path), { signal })),
  ]);
  return { versions: history.versions, audits: audit.entries, annotations: annotation.annotations, content: file.content, version: file.version };
}

async function fetchVersionContent(sessionId: string, path: string, version: string): Promise<string> {
  const url = new URL(endpoint("history/version", sessionId, path), globalThis.location.origin);
  url.searchParams.set("version", version);
  const payload = await jsonOrThrow<{ readonly content: string }>(await fetch(url.toString()));
  return payload.content;
}

async function postRollback(sessionId: string, path: string, version: string, baseVersion: string): Promise<string> {
  const payload = await jsonOrThrow<{ readonly version: string }>(
    await fetch(endpoint("history/rollback", sessionId, path), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version, baseVersion }),
    }));
  return payload.version;
}

async function postAnnotation(sessionId: string, path: string, input: AnnotationDraft): Promise<AnnotationPayload> {
  const payload = await jsonOrThrow<{ readonly annotation: AnnotationPayload }>(
    await fetch(endpoint("annotations", sessionId, path), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }));
  return payload.annotation;
}

async function deleteAnnotationRequest(sessionId: string, path: string, id: string): Promise<void> {
  const url = new URL(endpoint("annotations", sessionId, path), globalThis.location.origin);
  url.searchParams.set("id", id);
  await jsonOrThrow(await fetch(url.toString(), { method: "DELETE" }));
}

async function postReanchor(sessionId: string, path: string): Promise<AnnotationPayload[]> {
  const payload = await jsonOrThrow<{ readonly annotations: AnnotationPayload[] }>(
    await fetch(endpoint("annotations/reanchor", sessionId, path), { method: "POST" }));
  return payload.annotations;
}

function VersionSection({
  path,
  versions,
  compareVersion,
  compareContent,
  currentContent,
  rollbackHint,
  canRollback,
  onOpenCompare,
  onRollback,
}: {
  readonly path: string;
  readonly versions: readonly VersionSummaryPayload[] | undefined;
  readonly compareVersion: string | undefined;
  readonly compareContent: string | undefined;
  readonly currentContent: string | undefined;
  readonly rollbackHint: string;
  readonly canRollback: boolean;
  readonly onOpenCompare: (version: string) => void;
  readonly onRollback: () => void;
}): JSX.Element {
  const diffRows = useMemo(() => {
    if (compareContent === undefined || currentContent === undefined) return undefined;
    return lineDiff(compareContent, currentContent);
  }, [compareContent, currentContent]);
  return <section className="oh-history-section" aria-label="版本历史">
    <h4>版本历史{versions !== undefined ? `（${String(versions.length)}）` : ""}</h4>
    {versions !== undefined && versions.length === 0
      ? <p className="oh-history-meta">暂无版本快照,保存一次文件后会自动生成。</p>
      : null}
    <ul className="oh-history-versions">
      {(versions ?? []).map((item) => <li key={item.version}>
        <button
          type="button"
          className="oh-history-version"
          aria-pressed={compareVersion === item.version}
          onClick={() => { onOpenCompare(item.version); }}
          title={`查看版本 ${item.version}`}
        >
          <span className="oh-history-version-id">{shortVersion(item.version)}</span>
          <span className="oh-history-version-meta">
            {item.source === "rollback" ? "回滚" : "保存"} · {formatTime(item.timestamp)} · {item.bytes}B
          </span>
        </button>
      </li>)}
    </ul>
    {compareVersion !== undefined ? <div className="oh-history-compare">
      <div className="oh-history-compare-bar">
        <span>对比版本 {shortVersion(compareVersion)} → 当前磁盘版本</span>
        <button
          type="button"
          className="oh-history-rollback"
          disabled={!canRollback}
          onClick={() => { onRollback(); }}
          title={rollbackHint}
        >
          回滚到此版本
        </button>
      </div>
      {diffRows === undefined
        ? <p className="oh-history-meta">正在加载版本内容…</p>
        : <pre className="oh-history-diff" aria-label={`${path} 版本差异`}>{
          diffRows.map((row, index) => <span
            key={`${String(index)}:${row.kind}`}
            className={row.kind === "add" ? "oh-history-add" : row.kind === "del" ? "oh-history-del" : "oh-history-same"}
          >{row.kind === "add" ? "+ " : row.kind === "del" ? "- " : "  "}{truncate(row.text)}{"\n"}</span>)
        }</pre>}
    </div> : null}
  </section>;
}

function AuditSection({ audits }: { readonly audits: readonly AuditEntryPayload[] | undefined }): JSX.Element {
  return <section className="oh-history-section" aria-label="审计轨迹">
    <h4>审计轨迹{audits !== undefined ? `（${String(audits.length)}）` : ""}</h4>
    <ul className="oh-history-audits">
      {(audits ?? []).map((entry, index) => <li key={`${String(entry.timestamp)}:${entry.version}:${String(index)}`}>
        <span>{entry.action === "rollback" ? "回滚" : "保存"}</span>
        <span> · {formatTime(entry.timestamp)} · {shortVersion(entry.version)}</span>
        {entry.detail !== undefined ? <span> · {truncate(entry.detail)}</span> : null}
      </li>)}
    </ul>
    {audits !== undefined && audits.length === 0 ? <p className="oh-history-meta">暂无审计记录。</p> : null}
  </section>;
}

function AnnotationForm({ onCreate }: { readonly onCreate: (input: AnnotationDraft) => void }): JSX.Element {
  const [lineStart, setLineStart] = useState("1");
  const [lineEnd, setLineEnd] = useState("1");
  const [note, setNote] = useState("");
  const [kind, setKind] = useState<AnnotationKindOption>("note");
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    onCreate({ lineStart: Number(lineStart), lineEnd: Number(lineEnd), note, kind });
    setNote("");
  };
  return <form className="oh-history-form" onSubmit={submit}>
    <label>起始行<input value={lineStart} onChange={(event) => { setLineStart(event.target.value); }} inputMode="numeric" aria-label="起始行" /></label>
    <label>结束行<input value={lineEnd} onChange={(event) => { setLineEnd(event.target.value); }} inputMode="numeric" aria-label="结束行" /></label>
    <label>类型<select value={kind} onChange={(event) => { setKind(event.target.value as AnnotationKindOption); }} aria-label="批注类型">
      <option value="note">备注</option>
      <option value="todo">待办</option>
      <option value="review">评审</option>
    </select></label>
    <label className="oh-history-form-note">备注<textarea value={note} onChange={(event) => { setNote(event.target.value); }} placeholder="批注内容" aria-label="批注内容" /></label>
    <button type="submit" className="oh-history-submit">新建批注</button>
  </form>;
}

function AnnotationSection({
  path,
  annotations,
  onReveal,
  onCreate,
  onRemove,
  onReanchor,
}: {
  readonly path: string;
  readonly annotations: readonly AnnotationPayload[] | undefined;
  readonly onReveal: (path: string, line: number, offset: number) => void;
  readonly onCreate: (input: AnnotationDraft) => void;
  readonly onRemove: (id: string) => void;
  readonly onReanchor: () => void;
}): JSX.Element {
  return <section className="oh-history-section" aria-label="行级批注">
    <div className="oh-history-annotation-head">
      <h4>行级批注{annotations !== undefined ? `（${String(annotations.length)}）` : ""}</h4>
      <button type="button" className="oh-history-reanchor" onClick={() => { onReanchor(); }}>重新锚定</button>
    </div>
    <ul className="oh-history-annotations">
      {(annotations ?? []).map((item) => <li key={item.id} className="oh-history-annotation">
        <div className="oh-history-annotation-line">
          <button
            type="button"
            className="oh-history-annotation-jump"
            onClick={() => { onReveal(path, item.lineStart, 0); }}
            title={`跳到第 ${String(item.lineStart)} 行`}
          >
            第 {item.lineStart}–{item.lineEnd} 行
          </button>
          <span className="oh-history-kind" data-kind={item.kind}>
            {item.kind === "todo" ? "待办" : item.kind === "review" ? "评审" : "备注"}
          </span>
          {item.stale === true ? <span className="oh-history-stale">已失锚</span> : null}
          {item.moved === true ? <span className="oh-history-moved">已搬移</span> : null}
          <button type="button" className="oh-history-delete" onClick={() => { onRemove(item.id); }}>删除</button>
        </div>
        <p className="oh-history-quote">{truncate(item.quote)}</p>
        {item.note !== "" ? <p className="oh-history-note">{truncate(item.note)}</p> : null}
      </li>)}
    </ul>
    {annotations !== undefined && annotations.length === 0 ? <p className="oh-history-meta">暂无批注,在下方按行区间新建。</p> : null}
    <AnnotationForm onCreate={onCreate} />
  </section>;
}

type StateSetter<T> = Dispatch<SetStateAction<T>>;

interface HistoryState {
  readonly versions: VersionSummaryPayload[] | undefined;
  readonly audits: AuditEntryPayload[] | undefined;
  readonly annotations: AnnotationPayload[] | undefined;
  readonly currentContent: string | undefined;
  readonly currentVersion: string | undefined;
  readonly compareVersion: string | undefined;
  readonly error: string | undefined;
  readonly loading: boolean;
  readonly actionMessage: string | undefined;
  readonly setVersions: StateSetter<VersionSummaryPayload[] | undefined>;
  readonly setAudits: StateSetter<AuditEntryPayload[] | undefined>;
  readonly setAnnotations: StateSetter<AnnotationPayload[] | undefined>;
  readonly setCurrentContent: StateSetter<string | undefined>;
  readonly setCurrentVersion: StateSetter<string | undefined>;
  readonly setCompareVersion: StateSetter<string | undefined>;
  readonly setError: StateSetter<string | undefined>;
  readonly setLoading: StateSetter<boolean>;
  readonly setActionMessage: StateSetter<string | undefined>;
}

function useHistoryState(): HistoryState {
  const [versions, setVersions] = useState<VersionSummaryPayload[] | undefined>(undefined);
  const [audits, setAudits] = useState<AuditEntryPayload[] | undefined>(undefined);
  const [annotations, setAnnotations] = useState<AnnotationPayload[] | undefined>(undefined);
  const [currentContent, setCurrentContent] = useState<string | undefined>(undefined);
  const [currentVersion, setCurrentVersion] = useState<string | undefined>(undefined);
  const [compareVersion, setCompareVersion] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | undefined>(undefined);
  return {
    versions, setVersions, audits, setAudits, annotations, setAnnotations,
    currentContent, setCurrentContent, currentVersion, setCurrentVersion,
    compareVersion, setCompareVersion, error, setError, loading, setLoading,
    actionMessage, setActionMessage,
  };
}

function useHistoryLoader(sessionId: string, state: HistoryState): (path: string, signal: AbortSignal) => Promise<void> {
  const { setVersions, setAudits, setAnnotations, setCurrentContent } = state;
  const { setCurrentVersion, setCompareVersion, setError, setLoading, setActionMessage } = state;
  return useCallback(async (path: string, signal: AbortSignal): Promise<void> => {
    setLoading(true);
    setError(undefined);
    setActionMessage(undefined);
    try {
      const bundle = await fetchHistoryBundle(sessionId, path, signal);
      setVersions(bundle.versions);
      setAudits(bundle.audits);
      setAnnotations(bundle.annotations);
      setCurrentContent(bundle.content);
      setCurrentVersion(bundle.version);
      setCompareVersion((current) =>
        current === undefined || bundle.versions.some((item) => item.version === current)
          ? current
          : bundle.versions[0]?.version);
    } catch (failure) {
      if (failure instanceof DOMException && failure.name === "AbortError") return;
      setVersions(undefined);
      setAudits(undefined);
      setAnnotations(undefined);
      setCurrentContent(undefined);
      setError(failure instanceof Error ? failure.message : "加载历史失败。");
    } finally {
      setLoading(false);
    }
  }, [sessionId, setActionMessage, setAnnotations, setAudits, setCompareVersion, setCurrentContent, setCurrentVersion, setError, setLoading, setVersions]);
}

function useVersionActions(
  sessionId: string,
  selected: string | undefined,
  state: HistoryState,
  loadAll: (path: string, signal: AbortSignal) => Promise<void>
): { readonly compareContent: string | undefined; readonly openCompare: (version: string) => void; readonly rollback: () => void } {
  const [versionContents, setVersionContents] = useState<Record<string, string>>({});
  const { compareVersion, currentVersion, setCompareVersion, setCurrentVersion, setError, setActionMessage } = state;
  useEffect(() => {
    setVersionContents({});
    setCompareVersion(undefined);
    if (selected === undefined) return;
    const controller = new AbortController();
    void loadAll(selected, controller.signal);
    return () => { controller.abort(); };
  }, [loadAll, selected, setCompareVersion]);
  const openCompare = useCallback(async (version: string): Promise<void> => {
    if (selected === undefined) return;
    setCompareVersion(version);
    if (versionContents[version] !== undefined) return;
    try {
      const content = await fetchVersionContent(sessionId, selected, version);
      setVersionContents((current) => ({ ...current, [version]: content }));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "加载版本内容失败。");
    }
  }, [selected, sessionId, setCompareVersion, setError, versionContents]);
  const rollback = useCallback(async (): Promise<void> => {
    if (selected === undefined || compareVersion === undefined || currentVersion === undefined) return;
    setError(undefined);
    setActionMessage(undefined);
    try {
      const version = await postRollback(sessionId, selected, compareVersion, currentVersion);
      setCurrentVersion(version);
      setActionMessage(`已回滚到 ${shortVersion(compareVersion)},新版本 ${shortVersion(version)}。请在编辑器刷新 ${selected} 后继续。`);
      await loadAll(selected, new AbortController().signal);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "回滚失败。");
    }
  }, [compareVersion, currentVersion, loadAll, selected, sessionId, setActionMessage, setCurrentVersion, setError]);
  return {
    compareContent: compareVersion === undefined ? undefined : versionContents[compareVersion],
    openCompare: (version) => { void openCompare(version); },
    rollback: () => { void rollback(); },
  };
}

function useAnnotationActions(
  sessionId: string,
  selected: string | undefined,
  state: HistoryState
): { readonly createAnnotation: (input: AnnotationDraft) => void; readonly removeAnnotation: (id: string) => void; readonly reanchor: () => void } {
  const { setAnnotations, setError, setActionMessage } = state;
  const createAnnotation = useCallback(async (input: AnnotationDraft): Promise<void> => {
    if (selected === undefined) return;
    setError(undefined);
    setActionMessage(undefined);
    try {
      const created = await postAnnotation(sessionId, selected, input);
      setAnnotations((current) => [...(current ?? []), created]);
      setActionMessage(`批注已创建(第 ${String(created.lineStart)}–${String(created.lineEnd)} 行)。`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "创建批注失败。");
    }
  }, [selected, sessionId, setActionMessage, setAnnotations, setError]);
  const removeAnnotation = useCallback(async (id: string): Promise<void> => {
    if (selected === undefined) return;
    setError(undefined);
    try {
      await deleteAnnotationRequest(sessionId, selected, id);
      setAnnotations((current) => (current ?? []).filter((item) => item.id !== id));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "删除批注失败。");
    }
  }, [selected, sessionId, setAnnotations, setError]);
  const reanchor = useCallback(async (): Promise<void> => {
    if (selected === undefined) return;
    setError(undefined);
    try {
      const next = await postReanchor(sessionId, selected);
      setAnnotations(next);
      const moved = next.filter((item) => item.moved === true).length;
      const stale = next.filter((item) => item.stale === true).length;
      setActionMessage(`已重新锚定:搬移 ${String(moved)} 条,失锚 ${String(stale)} 条。`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "重新锚定失败。");
    }
  }, [selected, sessionId, setActionMessage, setAnnotations, setError]);
  return {
    createAnnotation: (input) => { void createAnnotation(input); },
    removeAnnotation: (id) => { void removeAnnotation(id); },
    reanchor: () => { void reanchor(); },
  };
}

function HistoryPanel({ sessionId, workspace, selected, onReveal }: WorkbenchFeatureProps): JSX.Element {
  const state = useHistoryState();
  const loadAll = useHistoryLoader(sessionId, state);
  const versionActions = useVersionActions(sessionId, selected, state, loadAll);
  const annotationActions = useAnnotationActions(sessionId, selected, state);
  if (selected === undefined) {
    return <div className="oh-history-panel">
      <style>{styles}</style>
      <p className="oh-history-empty">在文件树中选择一个文件,查看版本历史、审计轨迹与行级批注。</p>
    </div>;
  }
  const workspaceVersion = workspace?.files.find((file) => file.path === selected)?.version;
  const versionStale = workspaceVersion !== undefined && state.currentVersion !== undefined && workspaceVersion !== state.currentVersion;
  return <div className="oh-history-panel">
    <style>{styles}</style>
    <p className="oh-history-path" title={selected}>{selected}</p>
    {state.error !== undefined ? <p className="oh-history-error" role="alert">{state.error}</p> : null}
    {state.actionMessage !== undefined ? <p className="oh-history-notice" role="status">{state.actionMessage}</p> : null}
    {state.loading ? <p className="oh-history-meta">正在加载历史…</p> : null}
    <VersionSection
      path={selected}
      versions={state.versions}
      compareVersion={state.compareVersion}
      compareContent={versionActions.compareContent}
      currentContent={state.currentContent}
      rollbackHint={versionStale ? "工作台文件版本已变化,建议先刷新编辑器" : "回滚到此版本"}
      canRollback={state.currentVersion !== undefined}
      onOpenCompare={versionActions.openCompare}
      onRollback={versionActions.rollback}
    />
    <AuditSection audits={state.audits} />
    <AnnotationSection
      path={selected}
      annotations={state.annotations}
      onReveal={onReveal}
      onCreate={annotationActions.createAnnotation}
      onRemove={annotationActions.removeAnnotation}
      onReanchor={annotationActions.reanchor}
    />
  </div>;
}

registerWorkbenchFeature({
  id: "history",
  label: "历史",
  icon: "◷",
  workbenches: ["story", "drama"],
  component: HistoryPanel,
});

export function registerHistoryFeature(): void {
  // 面板在模块顶层注册,保留具名导出兼容既有导入.
}
