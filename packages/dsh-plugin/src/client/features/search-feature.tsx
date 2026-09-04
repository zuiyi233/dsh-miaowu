import { useCallback, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { endpoint } from "../workbench-ui.js";
import { registerWorkbenchFeature, type WorkbenchFeatureProps } from "./registry.js";
import styles from "./search-feature.css?inline";

interface SearchHitPayload {
  readonly path: string;
  readonly line: number;
  readonly text: string;
  readonly offset: number;
  readonly via?: string | undefined;
}

interface SearchPayload {
  readonly query: string;
  readonly tookMs: number;
  readonly total: number;
  readonly hits: readonly SearchHitPayload[];
}

const SNIPPET_RADIUS = 60;
const MAX_TEXT_LENGTH = 500;

function truncate(text: string): string {
  return text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH)}…` : text;
}

/** 命中片段高亮: 原文通道按字面位置标 <mark>, 拼音通道整行标(无法对齐到字). */
function HitText({ text, query, via }: { readonly text: string; readonly query: string; readonly via: string | undefined }): JSX.Element {
  const folded = text.toLowerCase();
  const needle = query.trim().toLowerCase();
  const at = via === "pinyin" || needle === "" ? -1 : folded.indexOf(needle);
  if (at < 0) return <span className="oh-search-line-text">{truncate(text)}</span>;
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(text.length, at + needle.length + SNIPPET_RADIUS);
  return <span className="oh-search-line-text">
    {start > 0 ? "…" : null}{truncate(text.slice(start, at))}
    <mark>{text.slice(at, at + needle.length)}</mark>
    {truncate(text.slice(at + needle.length, end))}{end < text.length ? "…" : null}
  </span>;
}

function SearchPanel({ sessionId, onReveal }: WorkbenchFeatureProps): JSX.Element {
  const [query, setQuery] = useState("");
  const [fileFilter, setFileFilter] = useState("");
  const [result, setResult] = useState<SearchPayload | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [rebuildMessage, setRebuildMessage] = useState<string | undefined>(undefined);
  const controller = useRef<AbortController | undefined>(undefined);

  const runSearch = useCallback(async (event?: FormEvent): Promise<void> => {
    event?.preventDefault();
    const keyword = query.trim();
    if (keyword === "" || loading) return;
    controller.current?.abort();
    const signal = new AbortController();
    controller.current = signal;
    setLoading(true);
    setError(undefined);
    setRebuildMessage(undefined);
    try {
      const url = new URL(endpoint("search", sessionId), globalThis.location.origin);
      url.searchParams.set("q", keyword);
      if (fileFilter.trim() !== "") url.searchParams.set("fileFilter", fileFilter.trim());
      const response = await fetch(url.toString(), { signal: signal.signal });
      const payload = await response.json() as SearchPayload & { readonly error?: string };
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${String(response.status)}`);
      setResult(payload);
    } catch (failure) {
      if (failure instanceof DOMException && failure.name === "AbortError") return;
      setResult(undefined);
      setError(failure instanceof Error ? failure.message : "检索失败。");
    } finally {
      if (controller.current === signal) {
        controller.current = undefined;
        setLoading(false);
      }
    }
  }, [fileFilter, loading, query, sessionId]);

  const rebuild = useCallback(async (): Promise<void> => {
    setError(undefined);
    setRebuildMessage(undefined);
    try {
      const url = new URL(endpoint("search/rebuild", sessionId), globalThis.location.origin);
      const response = await fetch(url.toString(), { method: "POST" });
      const payload = await response.json() as { readonly files?: number; readonly error?: string };
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${String(response.status)}`);
      setRebuildMessage(`索引已重建, ${String(payload.files ?? 0)} 个文件。`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "重建索引失败。");
    }
  }, [sessionId]);

  const groups = useMemo(() => {
    const ordered = new Map<string, SearchHitPayload[]>();
    for (const hit of result?.hits ?? []) {
      const list = ordered.get(hit.path) ?? [];
      list.push(hit);
      ordered.set(hit.path, list);
    }
    return [...ordered.entries()];
  }, [result]);

  return <div className="oh-search-panel">
    <style>{styles}</style>
    <form className="oh-search-bar" onSubmit={(event) => { void runSearch(event); }}>
      <input
        className="oh-search-input"
        value={query}
        onChange={(event) => { setQuery(event.target.value); }}
        placeholder="跨文档检索, 支持中文与拼音(如 jin / jpm)"
        aria-label="检索关键词"
      />
      <input
        className="oh-search-filter"
        value={fileFilter}
        onChange={(event) => { setFileFilter(event.target.value); }}
        placeholder="文件过滤(可选)"
        aria-label="文件过滤"
      />
      <button type="submit" className="oh-search-submit" disabled={loading || query.trim() === ""}>
        {loading ? "检索中…" : "搜索"}
      </button>
      <button type="button" className="oh-search-rebuild" onClick={() => { void rebuild(); }} title="全量扫描重建索引">
        重建索引
      </button>
    </form>
    <div className="oh-search-meta" role="status">
      {error !== undefined
        ? <span className="oh-search-error">{error}</span>
        : result === undefined
          ? <span className="oh-search-empty">输入关键词后搜索正文 / 大纲 / 设定 / 剧集等目录。</span>
          : <span>命中 {result.total} 处 · {result.tookMs}ms{rebuildMessage !== undefined ? ` · ${rebuildMessage}` : ""}</span>}
      {rebuildMessage !== undefined && error === undefined && result === undefined
        ? <span>{rebuildMessage}</span>
        : null}
    </div>
    <div className="oh-search-results">
      {result !== undefined && result.hits.length === 0
        ? <p className="oh-search-empty">无命中, 换个关键词或重建索引后重试。</p>
        : groups.map(([path, hits]) => <section key={path} className="oh-search-group">
          <h4 className="oh-search-path" title={path}>{path}（{hits.length}）</h4>
          <ul className="oh-search-lines">
            {hits.map((hit) => <li key={`${hit.path}:${String(hit.line)}:${String(hit.offset)}`}>
              <button
                type="button"
                className="oh-search-line"
                onClick={() => { onReveal(hit.path, hit.line, hit.offset); }}
                title={`跳到 ${hit.path} 第 ${String(hit.line)} 行`}
              >
                <span className="oh-search-lineno">{hit.line}</span>
                <HitText text={hit.text} query={result?.query ?? ""} via={hit.via} />
                {hit.via === "pinyin" ? <span className="oh-search-pinyin-badge">拼音</span> : null}
              </button>
            </li>)}
          </ul>
        </section>)}
    </div>
  </div>;
}

registerWorkbenchFeature({
  id: "search",
  label: "全文检索",
  icon: "⌕",
  workbenches: ["story", "drama"],
  component: SearchPanel,
});

export function registerSearchFeature(): void {
  // 面板在模块顶层注册, 保留具名导出兼容既有导入.
}
