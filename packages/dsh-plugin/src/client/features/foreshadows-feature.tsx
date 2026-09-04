import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { endpoint } from "../workbench-ui.js";
import { registerWorkbenchFeature, type WorkbenchFeatureProps } from "./registry.js";
import styles from "./foreshadows-feature.css?inline";

type StatusTab = "all" | "planned" | "planted" | "resolved" | "abandoned";

interface EvidencePayload {
  readonly path: string;
  readonly line: number;
}

interface ForeshadowPayload {
  readonly id: string;
  readonly book?: string | undefined;
  readonly chapter?: string | undefined;
  readonly title: string;
  readonly description?: string | undefined;
  readonly status: string;
  readonly importance: number;
  readonly plannedPayoffChapter?: string | undefined;
  readonly resolutionNote?: string | undefined;
  readonly source: string;
  readonly evidence?: readonly EvidencePayload[] | undefined;
}

interface ErrorPayload {
  readonly error?: string | undefined;
}

const STATUS_TABS: readonly { readonly value: StatusTab; readonly label: string }[] = [
  { value: "all", label: "全部" },
  { value: "planned", label: "待埋设 planned" },
  { value: "planted", label: "已埋 planted" },
  { value: "resolved", label: "已回收 resolved" },
  { value: "abandoned", label: "废弃 abandoned" },
];

const STATUS_BADGE: Record<string, string> = {
  planned: "待埋设",
  planted: "已埋",
  resolved: "已回收",
  abandoned: "废弃",
};

const DAY_MS = 24 * 60 * 60 * 1000;

async function readPayload(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function badgeOf(status: string): string {
  return STATUS_BADGE[status] ?? status;
}

function isTerminal(status: string): boolean {
  return status === "resolved" || status === "abandoned";
}

function ForeshadowsPanel({ sessionId, onReveal }: WorkbenchFeatureProps): JSX.Element {
  const [book, setBook] = useState("");
  const [chapter, setChapter] = useState("");
  const [tab, setTab] = useState<StatusTab>("all");
  const [items, setItems] = useState<ForeshadowPayload[]>([]);
  const [reminders, setReminders] = useState<ForeshadowPayload[]>([]);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newImportance, setNewImportance] = useState("3");
  const [newPayoff, setNewPayoff] = useState("");
  const [importBook, setImportBook] = useState("");

  const loadItems = useCallback(async (nextBook: string, nextTab: StatusTab): Promise<void> => {
    setLoading(true);
    setError(undefined);
    try {
      const url = new URL(endpoint("foreshadows", sessionId), globalThis.location.origin);
      if (nextBook.trim() !== "") url.searchParams.set("book", nextBook.trim());
      if (nextTab !== "all") url.searchParams.set("status", nextTab);
      url.searchParams.set("limit", "200");
      const response = await fetch(url.toString());
      const payload = (await readPayload(response)) as { foreshadows?: ForeshadowPayload[] } & ErrorPayload;
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${String(response.status)}`);
      setItems(payload.foreshadows ?? []);
    } catch (failure) {
      setItems([]);
      setError(failure instanceof Error ? failure.message : "加载伏笔失败。");
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  const loadReminders = useCallback(async (nextBook: string, nextChapter: string): Promise<void> => {
    try {
      const url = new URL(endpoint("foreshadows/reminders", sessionId), globalThis.location.origin);
      if (nextBook.trim() !== "") url.searchParams.set("book", nextBook.trim());
      if (nextChapter.trim() !== "") url.searchParams.set("chapter", nextChapter.trim());
      const response = await fetch(url.toString());
      const payload = (await readPayload(response)) as { reminders?: ForeshadowPayload[] } & ErrorPayload;
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${String(response.status)}`);
      setReminders(payload.reminders ?? []);
    } catch {
      setReminders([]);
    }
  }, [sessionId]);

  useEffect(() => {
    void loadItems(book, tab);
  }, [book, tab, loadItems]);

  useEffect(() => {
    void loadReminders(book, chapter);
  }, [book, chapter, loadReminders]);

  const refresh = useCallback(async (): Promise<void> => {
    await loadItems(book, tab);
    await loadReminders(book, chapter);
  }, [book, chapter, loadItems, loadReminders, tab]);

  const mutate = useCallback(async (path: string, body: unknown): Promise<Record<string, unknown>> => {
    const response = await fetch(new URL(endpoint(path, sessionId), globalThis.location.origin).toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await readPayload(response);
    if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : `HTTP ${String(response.status)}`);
    return payload;
  }, [sessionId]);

  const createForeshadow = useCallback(async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError(undefined);
    setMessage(undefined);
    if (newTitle.trim() === "") {
      setError("标题必填。");
      return;
    }
    try {
      await mutate("foreshadows", {
        ...(book.trim() === "" ? {} : { book: book.trim() }),
        ...(chapter.trim() === "" ? {} : { chapter: chapter.trim() }),
        title: newTitle.trim(),
        ...(newDescription.trim() === "" ? {} : { description: newDescription.trim() }),
        importance: Number(newImportance),
        ...(newPayoff.trim() === "" ? {} : { plannedPayoffChapter: newPayoff.trim() }),
      });
      setNewTitle("");
      setNewDescription("");
      setNewPayoff("");
      setMessage("已埋设（planned）。");
      await refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "新建伏笔失败。");
    }
  }, [book, chapter, mutate, newDescription, newImportance, newPayoff, newTitle, refresh]);

  const importFromAnalysis = useCallback(async (): Promise<void> => {
    setError(undefined);
    setMessage(undefined);
    const name = importBook.trim() === "" ? book.trim() : importBook.trim();
    if (name === "") {
      setError("请先输入书名。");
      return;
    }
    try {
      const payload = await mutate("foreshadows/import", { book: name });
      const imported = typeof payload.imported === "number" ? payload.imported : 0;
      const skipped = typeof payload.skipped === "number" ? payload.skipped : 0;
      setMessage(`从拆书导入：新增 ${String(imported)} 条，跳过同名 ${String(skipped)} 条。`);
      await refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "导入失败。");
    }
  }, [book, importBook, mutate, refresh]);

  const changeStatus = useCallback(async (id: string, status: "planted" | "resolved" | "abandoned"): Promise<void> => {
    setError(undefined);
    setMessage(undefined);
    try {
      let extra: Record<string, unknown> = {};
      if (status === "resolved") {
        const note = globalThis.prompt("回收备注（resolutionNote，可留空）", "");
        if (note === null) return;
        if (note.trim() !== "") extra = { resolutionNote: note.trim() };
      }
      await mutate(`foreshadows/${encodeURIComponent(id)}/status`, { status, ...extra });
      setMessage(status === "planted" ? "已标记已埋设。" : status === "resolved" ? "已回收。" : "已废弃。");
      await refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "状态变更失败。");
    }
  }, [mutate, refresh]);

  const snooze = useCallback(async (id: string, mode: "chapter" | "day"): Promise<void> => {
    setError(undefined);
    setMessage(undefined);
    try {
      await mutate("foreshadows/snooze", mode === "chapter"
        ? { id, ...(chapter.trim() === "" ? {} : { untilChapter: chapter.trim() }), ...(book.trim() === "" ? {} : { untilBook: book.trim() }) }
        : { id, untilMs: Date.now() + DAY_MS });
      setMessage(mode === "chapter" ? "已按章搁置提醒。" : "已搁置 1 天。");
      await loadReminders(book, chapter);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "搁置提醒失败。");
    }
  }, [book, chapter, loadReminders, mutate]);

  return <div className="oh-foreshadow-panel">
    <style>{styles}</style>
    <div className="oh-foreshadow-filters">
      <label className="oh-foreshadow-label" htmlFor="oh-foreshadow-book">书</label>
      <input
        id="oh-foreshadow-book"
        className="oh-foreshadow-input"
        value={book}
        onChange={(event) => { setBook(event.target.value); }}
        placeholder="book（留空=全部）"
      />
      <label className="oh-foreshadow-label" htmlFor="oh-foreshadow-chapter">章</label>
      <input
        id="oh-foreshadow-chapter"
        className="oh-foreshadow-input"
        value={chapter}
        onChange={(event) => { setChapter(event.target.value); }}
        placeholder="chapter（提醒按章过滤）"
      />
      <button type="button" className="oh-foreshadow-reload" onClick={() => { void refresh(); }}>刷新</button>
    </div>
    <form className="oh-foreshadow-create" onSubmit={(event) => { void createForeshadow(event); }}>
      <input
        className="oh-foreshadow-input"
        value={newTitle}
        onChange={(event) => { setNewTitle(event.target.value); }}
        placeholder="新建伏笔标题（必填）"
        aria-label="新建伏笔标题"
      />
      <input
        className="oh-foreshadow-input"
        value={newDescription}
        onChange={(event) => { setNewDescription(event.target.value); }}
        placeholder="描述（可选）"
        aria-label="新建伏笔描述"
      />
      <select
        className="oh-foreshadow-select"
        value={newImportance}
        onChange={(event) => { setNewImportance(event.target.value); }}
        aria-label="重要度"
      >
        {["1", "2", "3", "4", "5"].map((level) => <option key={level} value={level}>重要度 {level}</option>)}
      </select>
      <input
        className="oh-foreshadow-input"
        value={newPayoff}
        onChange={(event) => { setNewPayoff(event.target.value); }}
        placeholder="计划回收章（可选）"
        aria-label="计划回收章"
      />
      <button type="submit" className="oh-foreshadow-button-primary">新建伏笔</button>
    </form>
    <div className="oh-foreshadow-import">
      <input
        className="oh-foreshadow-input"
        value={importBook}
        onChange={(event) => { setImportBook(event.target.value); }}
        placeholder="从拆书导入：书名（留空用上方 book）"
        aria-label="导入书名"
      />
      <button type="button" className="oh-foreshadow-button" onClick={() => { void importFromAnalysis(); }}>从拆书导入</button>
    </div>
    <div className="oh-foreshadow-status" role="status">
      {error !== undefined ? <span className="oh-foreshadow-error">{error}</span>
        : message !== undefined ? <span className="oh-foreshadow-message">{message}</span>
        : loading ? <span>加载中…</span> : null}
    </div>
    <section className="oh-foreshadow-reminders" aria-label="应提醒伏笔">
      <h4 className="oh-foreshadow-section-title">提醒（当前章应处理）</h4>
      {reminders.length === 0
        ? <p className="oh-foreshadow-empty">本章暂无应提醒伏笔。</p>
        : <ul className="oh-foreshadow-list">
          {reminders.map((item) => <li key={item.id} className="oh-foreshadow-card oh-foreshadow-card-reminder">
            <div className="oh-foreshadow-card-head">
              <strong className="oh-foreshadow-title">{item.title}</strong>
              <span className={`oh-foreshadow-badge oh-foreshadow-badge-${item.status}`}>{badgeOf(item.status)} · ★{String(item.importance)}</span>
            </div>
            <div className="oh-foreshadow-actions">
              <button type="button" className="oh-foreshadow-button" onClick={() => { void snooze(item.id, "chapter"); }}>按章搁置</button>
              <button type="button" className="oh-foreshadow-button" onClick={() => { void snooze(item.id, "day"); }}>搁置 1 天</button>
              {item.status === "planned"
                ? <button type="button" className="oh-foreshadow-button" onClick={() => { void changeStatus(item.id, "planted"); }}>标记已埋设</button>
                : null}
              {item.status === "planted"
                ? <button type="button" className="oh-foreshadow-button-primary" onClick={() => { void changeStatus(item.id, "resolved"); }}>标记已回收</button>
                : null}
              {(item.evidence ?? []).map((ref) => <button
                key={`${ref.path}:${String(ref.line)}`}
                type="button"
                className="oh-foreshadow-evidence"
                onClick={() => { onReveal(ref.path, ref.line, 0); }}
              >
                {ref.path}:{String(ref.line)}
              </button>)}
            </div>
          </li>)}
        </ul>}
    </section>
    <div className="oh-foreshadow-tabs" role="tablist" aria-label="伏笔状态过滤">
      {STATUS_TABS.map((entry) => <button
        key={entry.value}
        type="button"
        role="tab"
        aria-selected={tab === entry.value}
        className={tab === entry.value ? "oh-foreshadow-tab-active" : "oh-foreshadow-tab"}
        onClick={() => { setTab(entry.value); }}
      >
        {entry.label}
      </button>)}
    </div>
    {items.length === 0
      ? <p className="oh-foreshadow-empty">暂无伏笔。先埋设一条，或从拆书导入。</p>
      : <ul className="oh-foreshadow-list">
        {items.map((item) => <li key={item.id} className="oh-foreshadow-card">
          <div className="oh-foreshadow-card-head">
            <strong className="oh-foreshadow-title">{item.title}</strong>
            <span className={`oh-foreshadow-badge oh-foreshadow-badge-${item.status}`}>{badgeOf(item.status)} · ★{String(item.importance)}</span>
          </div>
          <div className="oh-foreshadow-meta">
            {[item.book, item.chapter].filter((part) => part !== undefined && part !== "").join(" / ") || "未归属"}
            {item.plannedPayoffChapter !== undefined && item.plannedPayoffChapter !== "" ? ` · 计划回收：${item.plannedPayoffChapter}` : ""}
            {` · ${item.source === "import" ? "拆书导入" : "手动"}`}
          </div>
          {item.description !== undefined ? <p className="oh-foreshadow-desc">{item.description}</p> : null}
          {item.resolutionNote !== undefined ? <p className="oh-foreshadow-desc">回收备注：{item.resolutionNote}</p> : null}
          {(item.evidence ?? []).length > 0
            ? <div className="oh-foreshadow-evidence-row">
              {(item.evidence ?? []).map((ref) => <button
                key={`${ref.path}:${String(ref.line)}`}
                type="button"
                className="oh-foreshadow-evidence"
                onClick={() => { onReveal(ref.path, ref.line, 0); }}
              >
                {ref.path}:{String(ref.line)}
              </button>)}
            </div>
            : null}
          {isTerminal(item.status)
            ? null
            : <div className="oh-foreshadow-actions">
              {item.status === "planned"
                ? <button type="button" className="oh-foreshadow-button" onClick={() => { void changeStatus(item.id, "planted"); }}>标记已埋设</button>
                : null}
              {item.status === "planted"
                ? <button type="button" className="oh-foreshadow-button-primary" onClick={() => { void changeStatus(item.id, "resolved"); }}>标记已回收</button>
                : null}
              <button type="button" className="oh-foreshadow-button" onClick={() => { void changeStatus(item.id, "abandoned"); }}>废弃</button>
            </div>}
        </li>)}
      </ul>}
  </div>;
}

registerWorkbenchFeature({
  id: "foreshadows",
  label: "伏笔",
  icon: "⚑",
  workbenches: ["story"],
  component: ForeshadowsPanel,
});

export function registerForeshadowsFeature(): void {
  // 面板在模块顶层注册,保留具名导出兼容既有导入.
}
