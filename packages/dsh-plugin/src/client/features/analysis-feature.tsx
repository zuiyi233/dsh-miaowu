import { useCallback, useEffect, useMemo, useState } from "react";
import { endpoint } from "../workbench-ui.js";
import { registerWorkbenchFeature, type WorkbenchFeatureProps } from "./registry.js";
import styles from "./analysis-feature.css?inline";

type PanelKind = "all" | "entity" | "relation" | "timeline" | "foreshadow" | "scene";

interface EvidenceRef {
  readonly path: string;
  readonly line: number;
}

interface QueryRecord {
  readonly evidence?: readonly EvidenceRef[] | undefined;
  readonly evidenceText?: string | undefined;
  readonly name?: string | undefined;
  readonly title?: string | undefined;
  readonly label?: string | undefined;
  readonly type?: string | undefined;
  readonly kind?: string | undefined;
  readonly status?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly at?: string | undefined;
}

interface QueryHit {
  readonly book: string;
  readonly kind: string;
  readonly record: QueryRecord;
}

interface ParseSummary {
  readonly book: string;
  readonly entityCount: number;
  readonly relationCount: number;
  readonly timelineCount: number;
  readonly foreshadowCount: number;
  readonly sceneCount: number;
}

const KIND_OPTIONS: readonly { readonly value: PanelKind; readonly label: string }[] = [
  { value: "all", label: "全部" },
  { value: "entity", label: "实体" },
  { value: "relation", label: "关系" },
  { value: "timeline", label: "时间线" },
  { value: "foreshadow", label: "伏笔" },
  { value: "scene", label: "场景" }
];

function displayName(record: QueryRecord): string {
  return record.name ?? record.title ?? record.label ?? "(未命名)";
}

function displayMeta(kind: string, record: QueryRecord): string {
  if (kind === "entity") return record.type ?? "";
  if (kind === "relation") return `${record.from ?? ""} → ${record.to ?? ""}${record.kind === undefined ? "" : ` · ${record.kind}`}`;
  if (kind === "timeline") return record.at ?? "";
  if (kind === "foreshadow") return record.status ?? "";
  return "";
}

export function AnalysisFeature(props: WorkbenchFeatureProps) {
  const [summaries, setSummaries] = useState<readonly ParseSummary[]>([]);
  const [book, setBook] = useState<string>("");
  const [kind, setKind] = useState<PanelKind>("all");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<readonly QueryHit[]>([]);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const activeBook = book === "" ? undefined : book;

  const loadQuery = useCallback(async (targetBook: string | undefined, targetKind: PanelKind, targetQuery: string): Promise<void> => {
    const url = new URL(endpoint("analysis/query", props.sessionId));
    if (targetBook !== undefined) url.searchParams.set("book", targetBook);
    url.searchParams.set("kind", targetKind);
    url.searchParams.set("q", targetQuery);
    const response = await fetch(url.toString());
    if (!response.ok) {
      setNotice("查询失败,请先点「重新解析」。");
      return;
    }
    const payload = (await response.json()) as { readonly hits?: readonly QueryHit[] };
    setHits(payload.hits ?? []);
  }, [props.sessionId]);

  const refresh = useCallback(async (): Promise<void> => {
    setBusy(true);
    setNotice(undefined);
    try {
      const response = await fetch(endpoint("analysis/parse", props.sessionId), { method: "POST" });
      if (!response.ok) {
        setNotice("解析失败,拆文库可能不存在。");
        return;
      }
      const payload = (await response.json()) as { readonly books?: readonly ParseSummary[] };
      const books = payload.books ?? [];
      setSummaries(books);
      // 书选择器默认选中第一本,保证面板开箱有内容。
      const nextBook = books[0]?.book;
      if (nextBook !== undefined) {
        setBook(nextBook);
        await loadQuery(nextBook, kind, query);
      } else {
        setHits([]);
      }
    } finally {
      setBusy(false);
    }
  }, [loadQuery, props.sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onSearch = useCallback(async (): Promise<void> => {
    setNotice(undefined);
    await loadQuery(activeBook, kind, query);
  }, [activeBook, kind, loadQuery, query]);

  const counts = useMemo(() => {
    const summary = summaries.find((item) => item.book === activeBook);
    if (summary === undefined) return undefined;
    return `实体 ${String(summary.entityCount)} · 关系 ${String(summary.relationCount)} · 时间线 ${String(summary.timelineCount)} · 伏笔 ${String(summary.foreshadowCount)} · 场景 ${String(summary.sceneCount)}`;
  }, [activeBook, summaries]);

  return (
    <div className="oh-analysis">
      <style>{styles}</style>
      <div className="oh-analysis-row">
        <select aria-label="选择书" value={book} onChange={(event) => { setBook(event.target.value); void loadQuery(event.target.value === "" ? undefined : event.target.value, kind, query); }}>
          {summaries.length === 0 && <option value="">（尚无解析结果）</option>}
          {summaries.map((summary) => <option key={summary.book} value={summary.book}>{summary.book}</option>)}
        </select>
        <button type="button" disabled={busy} onClick={() => { void refresh(); }}>{busy ? "解析中…" : "重新解析"}</button>
        <button type="button" onClick={props.onClose} aria-label="关闭拆书结构化面板">×</button>
      </div>
      <div className="oh-analysis-row">
        <div className="oh-analysis-kinds" role="tablist" aria-label="类型筛选">
          {KIND_OPTIONS.map((option) => <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={kind === option.value}
            onClick={() => { setKind(option.value); void loadQuery(activeBook, option.value, query); }}
          >{option.label}</button>)}
        </div>
      </div>
      <div className="oh-analysis-row">
        <input
          aria-label="搜索结构化记录"
          placeholder="搜索名称/标题子串…"
          value={query}
          onChange={(event) => { setQuery(event.target.value); }}
          onKeyDown={(event) => { if (event.key === "Enter") void onSearch(); }}
        />
        <button type="button" onClick={() => { void onSearch(); }}>搜索</button>
      </div>
      {counts !== undefined && <div className="oh-analysis-counts">{counts}</div>}
      {notice !== undefined && <div className="oh-analysis-notice">{notice}</div>}
      <ul className="oh-analysis-hits">
        {hits.map((hit, index) => {
          const first = hit.record.evidence?.[0];
          return (
            <li key={`${hit.book}/${hit.kind}/${displayName(hit.record)}/${String(index)}`}>
              <div className="oh-analysis-hit-head">
                <strong>{displayName(hit.record)}</strong>
                <span className="oh-analysis-tag">{hit.kind}</span>
                {displayMeta(hit.kind, hit.record) !== "" && <span className="oh-analysis-meta">{displayMeta(hit.kind, hit.record)}</span>}
              </div>
              {first !== undefined && (
                <button
                  type="button"
                  className="oh-analysis-evidence"
                  onClick={() => { props.onReveal(first.path, first.line, 0); }}
                  title="在编辑器中打开证据行"
                >{first.path}:{String(first.line)}</button>
              )}
              {hit.record.evidenceText !== undefined && hit.record.evidenceText !== "" && (
                <div className="oh-analysis-snippet">{hit.record.evidenceText}</div>
              )}
            </li>
          );
        })}
      </ul>
      {hits.length === 0 && <div className="oh-analysis-empty">无命中。换个关键词,或点「重新解析」。</div>}
    </div>
  );
}

registerWorkbenchFeature({ id: "analysis", label: "拆书结构化", icon: "◈", workbenches: ["story"], component: AnalysisFeature });