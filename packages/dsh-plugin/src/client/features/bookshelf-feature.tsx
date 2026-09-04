import { useCallback, useEffect, useState } from "react";
import { endpoint } from "../workbench-ui.js";
import { registerWorkbenchFeature, type WorkbenchFeatureProps } from "./registry.js";
import styles from "./bookshelf-feature.css?inline";

type WorkKind = "novel" | "drama" | "game" | "video";
type ShelfView = "shelf" | "archive" | "recycle";

interface ShelfEntryPayload {
  readonly id: string;
  readonly name: string;
  readonly kind: WorkKind;
  readonly path: string;
  readonly title: string;
  readonly updatedAt: number;
  readonly archivedAt?: number | undefined;
  readonly deletedAt?: number | undefined;
  readonly deleteAfter?: number | undefined;
}

interface ScanSummary {
  readonly entries: ShelfEntryPayload[];
  readonly added: number;
  readonly updated: number;
  readonly total: number;
}

const KIND_LABEL: Record<WorkKind, string> = {
  novel: "小说",
  drama: "短剧",
  game: "游戏",
  video: "解说",
};

function kindLabel(kind: string): string {
  return kind === "novel" || kind === "drama" || kind === "game" || kind === "video"
    ? KIND_LABEL[kind]
    : kind;
}

function formatTime(timestamp: number): string {
  try {
    return new Date(timestamp).toLocaleString();
  } catch {
    return String(timestamp);
  }
}

function firstTextFile(workspace: WorkbenchFeatureProps["workspace"], root: string): string | undefined {
  if (workspace === undefined) return undefined;
  const prefix = `${root}/`;
  return workspace.files
    .filter((file) => file.kind === "text" && (file.path === root || file.path.startsWith(prefix)))
    .map((file) => file.path)
    .sort((left, right) => left.localeCompare(right, "zh-Hans-CN"))[0];
}

async function jsonOrThrow<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as T & { readonly error?: string };
  if (!response.ok) throw new Error(payload.error ?? `HTTP ${String(response.status)}`);
  return payload;
}

async function fetchShelf(sessionId: string): Promise<ShelfEntryPayload[]> {
  const payload = await jsonOrThrow<{ readonly entries: ShelfEntryPayload[] }>(
    await fetch(endpoint("bookshelf/list", sessionId)));
  return payload.entries;
}

async function fetchArchive(sessionId: string): Promise<{ readonly archived: ShelfEntryPayload[]; readonly deleted: ShelfEntryPayload[] }> {
  const url = new URL(endpoint("bookshelf/archive", sessionId), globalThis.location.origin);
  url.searchParams.set("includeDeleted", "1");
  return jsonOrThrow(await fetch(url.toString()));
}

async function postScan(sessionId: string): Promise<ScanSummary> {
  return jsonOrThrow(await fetch(endpoint("bookshelf/scan", sessionId), { method: "POST" }));
}

async function postEntryAction(sessionId: string, id: string, verb: "archive" | "restore" | "delete" | "purge"): Promise<void> {
  await jsonOrThrow(await fetch(endpoint(`bookshelf/${encodeURIComponent(id)}/${verb}`, sessionId), { method: "POST" }));
}

function ShelfCard({
  entry,
  openPath,
  notice,
  onArchive,
  onDelete,
  onRestore,
  onPurge,
  onOpen,
  archived,
  deleted,
}: {
  readonly entry: ShelfEntryPayload;
  readonly openPath: string | undefined;
  readonly notice: string | undefined;
  readonly onArchive: () => void;
  readonly onDelete: () => void;
  readonly onRestore: () => void;
  readonly onPurge: () => void;
  readonly onOpen: () => void;
  readonly archived: boolean;
  readonly deleted: boolean;
}): JSX.Element {
  return <li className="oh-shelf-card">
    <div className="oh-shelf-card-head">
      <span className="oh-shelf-title" title={entry.path}>{entry.title}</span>
      <span className="oh-shelf-kind" data-kind={entry.kind}>{kindLabel(entry.kind)}</span>
    </div>
    <p className="oh-shelf-meta">{entry.path} · 更新 {formatTime(entry.updatedAt)}</p>
    {entry.deleteAfter !== undefined ? <p className="oh-shelf-meta">到期 {formatTime(entry.deleteAfter)}</p> : null}
    {notice !== undefined ? <p className="oh-shelf-card-notice">{notice}</p> : null}
    <div className="oh-shelf-actions">
      {deleted ? null : <button type="button" className="oh-shelf-open" disabled={openPath === undefined} onClick={onOpen} title={openPath ?? "该作品下暂无可打开的文本文件"}>打开</button>}
      {archived ? <button type="button" className="oh-shelf-restore" onClick={onRestore}>恢复</button> : null}
      {deleted ? <button type="button" className="oh-shelf-restore" onClick={onRestore}>恢复</button> : null}
      {!archived && !deleted ? <button type="button" className="oh-shelf-archive" onClick={onArchive}>归档</button> : null}
      {!deleted ? <button type="button" className="oh-shelf-delete" onClick={onDelete}>删除</button> : null}
      {deleted ? <button type="button" className="oh-shelf-purge" onClick={onPurge}>永久移除记录</button> : null}
    </div>
  </li>;
}

function BookshelfPanel({ sessionId, workspace, onReveal }: WorkbenchFeatureProps): JSX.Element {
  const [view, setView] = useState<ShelfView>("shelf");
  const [entries, setEntries] = useState<ShelfEntryPayload[] | undefined>(undefined);
  const [archived, setArchived] = useState<ShelfEntryPayload[]>([]);
  const [deleted, setDeleted] = useState<ShelfEntryPayload[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | undefined>(undefined);

  const reload = useCallback(async (signal: AbortSignal): Promise<void> => {
    setLoading(true);
    setError(undefined);
    try {
      const [shelf, archive] = await Promise.all([fetchShelf(sessionId), fetchArchive(sessionId)]);
      if (signal.aborted) return;
      setEntries(shelf);
      setArchived(archive.archived);
      setDeleted(archive.deleted);
    } catch (failure) {
      if (signal.aborted) return;
      setEntries(undefined);
      setError(failure instanceof Error ? failure.message : "加载书架失败。");
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    const controller = new AbortController();
    void reload(controller.signal);
    return () => { controller.abort(); };
  }, [reload]);

  const refresh = useCallback((): void => {
    void reload(new AbortController().signal);
  }, [reload]);

  const mutate = useCallback(async (run: () => Promise<void>, ok: string): Promise<void> => {
    setError(undefined);
    setMessage(undefined);
    try {
      await run();
      setMessage(ok);
      refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "书架操作失败。");
    }
  }, [refresh]);

  const rescan = useCallback((): void => {
    setError(undefined);
    setMessage(undefined);
    void postScan(sessionId).then((summary) => {
      setMessage(`扫描完成:新增 ${String(summary.added)} 部,更新 ${String(summary.updated)} 部,共 ${String(summary.total)} 部。`);
      refresh();
    }).catch((failure: unknown) => {
      setError(failure instanceof Error ? failure.message : "重新扫描失败。");
    });
  }, [refresh, sessionId]);

  const openWork = useCallback((entry: ShelfEntryPayload): void => {
    const target = firstTextFile(workspace, entry.path);
    if (target === undefined) {
      setMessage(`作品「${entry.title}」下暂无可打开的文本文件。`);
      return;
    }
    onReveal(target, 1, 0);
  }, [onReveal, workspace]);

  const visible = view === "shelf" ? entries ?? [] : view === "archive" ? archived : deleted;
  const emptyHint = view === "shelf"
    ? "书架是空的,点右上「重新扫描」从工作区发现作品。"
    : view === "archive" ? "暂无归档作品。" : "回收站是空的。";

  return <div className="oh-shelf-panel">
    <style>{styles}</style>
    <div className="oh-shelf-bar">
      <div className="oh-shelf-tabs" role="tablist" aria-label="书架视图">
        <button type="button" role="tab" aria-selected={view === "shelf"} className={view === "shelf" ? "oh-shelf-tab-active" : "oh-shelf-tab"} onClick={() => { setView("shelf"); }}>默认书架{entries !== undefined ? `（${String(entries.length)}）` : ""}</button>
        <button type="button" role="tab" aria-selected={view === "archive"} className={view === "archive" ? "oh-shelf-tab-active" : "oh-shelf-tab"} onClick={() => { setView("archive"); }}>归档（{String(archived.length)}）</button>
        <button type="button" role="tab" aria-selected={view === "recycle"} className={view === "recycle" ? "oh-shelf-tab-active" : "oh-shelf-tab"} onClick={() => { setView("recycle"); }}>回收站（{String(deleted.length)}）</button>
      </div>
      <button type="button" className="oh-shelf-rescan" onClick={rescan}>重新扫描</button>
    </div>
    {error !== undefined ? <p className="oh-shelf-error" role="alert">{error}</p> : null}
    {message !== undefined && message !== "" ? <p className="oh-shelf-notice" role="status">{message}</p> : null}
    {loading ? <p className="oh-shelf-meta">正在加载书架…</p> : null}
    {entries === undefined && error === undefined && !loading ? <p className="oh-shelf-meta">书架尚未加载。</p> : null}
    {visible.length === 0 && entries !== undefined && error === undefined
      ? <p className="oh-shelf-empty">{emptyHint}</p>
      : null}
    <ul className="oh-shelf-list">
      {visible.map((entry) => {
        const openPath = firstTextFile(workspace, entry.path);
        return <ShelfCard
          key={entry.id}
          entry={entry}
          openPath={openPath}
          notice={confirmDelete === entry.id ? "再次点「删除」确认软删除(内容文件不受影响,可恢复)。" : undefined}
          archived={view === "archive"}
          deleted={view === "recycle"}
          onOpen={() => { openWork(entry); }}
          onArchive={() => { void mutate(() => postEntryAction(sessionId, entry.id, "archive"), `「${entry.title}」已归档,内容文件未动。`); }}
          onDelete={() => {
            if (confirmDelete !== entry.id) {
              setConfirmDelete(entry.id);
              return;
            }
            setConfirmDelete(undefined);
            void mutate(() => postEntryAction(sessionId, entry.id, "delete"), `「${entry.title}」已移入回收站(30 天,内容文件未动)。`);
          }}
          onRestore={() => { void mutate(() => postEntryAction(sessionId, entry.id, "restore"), `「${entry.title}」已恢复到默认书架。`); }}
          onPurge={() => { void mutate(() => postEntryAction(sessionId, entry.id, "purge"), `「${entry.title}」的书架记录已移除,工作区文件未动。`); }}
        />;
      })}
    </ul>
    <p className="oh-shelf-foot">书架只读写 .oh-story/shelf.json 索引:归档/删除/永久移除都不删除工作区内容文件。</p>
  </div>;
}

registerWorkbenchFeature({
  id: "bookshelf",
  label: "书架",
  icon: "▤",
  workbenches: ["story", "drama"],
  component: BookshelfPanel,
});

export function registerBookshelfFeature(): void {
  // 面板在模块顶层注册,保留具名导出兼容既有导入.
}
