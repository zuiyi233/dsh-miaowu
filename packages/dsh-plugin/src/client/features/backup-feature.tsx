import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { endpoint } from "../workbench-ui.js";
import { registerWorkbenchFeature, type WorkbenchFeatureProps } from "./registry.js";
import styles from "./backup-feature.css?inline";

type BackupKind = "bundle" | "snapshot" | "full";

interface BackupCounts {
  readonly files: number;
  readonly bytes: number;
}

interface BackupSummary {
  readonly path: string;
  readonly kind: BackupKind;
  readonly createdAt: number;
  readonly counts: BackupCounts;
  readonly hashShort: string;
}

interface RestoreOutcome {
  readonly restoredRoot: string;
  readonly counts: BackupCounts;
}

const KIND_LABEL: Record<BackupKind, string> = { bundle: "作品包", snapshot: "快照", full: "整体备份" };

function formatTime(timestamp: number): string {
  try {
    return new Date(timestamp).toLocaleString();
  } catch {
    return String(timestamp);
  }
}

async function jsonOrThrow<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as T & { readonly error?: string };
  if (!response.ok) throw new Error(payload.error ?? `HTTP ${String(response.status)}`);
  return payload;
}

async function postBackup(sessionId: string, kind: BackupKind, root: string): Promise<{ readonly path: string; readonly counts: BackupCounts }> {
  const url = new URL(endpoint(`backup/${kind}`, sessionId), globalThis.location.origin);
  if (root !== "" && kind !== "full") url.searchParams.set("root", root);
  return jsonOrThrow(await fetch(url.toString(), { method: "POST" }));
}

async function fetchBackupJson(sessionId: string, path: string): Promise<unknown> {
  const url = new URL(endpoint("backup/download", sessionId), globalThis.location.origin);
  url.searchParams.set("path", path);
  return jsonOrThrow(await fetch(url.toString()));
}

async function postRestore(sessionId: string, body: Record<string, unknown>): Promise<RestoreOutcome> {
  return jsonOrThrow(await fetch(endpoint("backup/restore", sessionId), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

function downloadJson(path: string, bundle: unknown): void {
  const name = path.split("/").at(-1) ?? "backup.json";
  const url = URL.createObjectURL(new Blob([JSON.stringify(bundle)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

interface SectionHooks {
  readonly reportOk: (message: string) => void;
  readonly reportFail: (message: string) => void;
}

function CreateSection({ sessionId, reportOk, reportFail }: { readonly sessionId: string } & SectionHooks): JSX.Element {
  const [root, setRoot] = useState("");
  const [busy, setBusy] = useState(false);
  const create = useCallback(async (kind: BackupKind): Promise<void> => {
    setBusy(true);
    try {
      const outcome = await postBackup(sessionId, kind, root.trim());
      reportOk(`已创建${KIND_LABEL[kind]}：${outcome.path}（${String(outcome.counts.files)} 个文件，${String(outcome.counts.bytes)}B）。`);
    } catch (failure) {
      reportFail(failure instanceof Error ? failure.message : "创建备份失败。");
    } finally {
      setBusy(false);
    }
  }, [reportFail, reportOk, root, sessionId]);
  return <section className="oh-backup-section" aria-label="创建备份">
    <h4>创建备份</h4>
    <label className="oh-backup-root">备份范围（可选，默认整个创作树）
      <input
        value={root}
        onChange={(event) => { setRoot(event.target.value); }}
        placeholder="如 正文/我的书、剧集/EP001"
        aria-label="备份范围"
      />
    </label>
    <div className="oh-backup-buttons">
      {(["bundle", "snapshot", "full"] as const).map((kind) => <button
        key={kind}
        type="button"
        className="oh-backup-action"
        disabled={busy}
        onClick={() => { void create(kind); }}
      >{KIND_LABEL[kind]}</button>)}
    </div>
  </section>;
}

function BackupItem({
  sessionId,
  item,
  reportOk,
  reportFail,
}: {
  readonly sessionId: string;
  readonly item: BackupSummary;
} & SectionHooks): JSX.Element {
  const [busy, setBusy] = useState(false);
  const download = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      downloadJson(item.path, await fetchBackupJson(sessionId, item.path));
      reportOk(`已导出 ${item.path}，可在本地离线保存。`);
    } catch (failure) {
      reportFail(failure instanceof Error ? failure.message : "下载失败。");
    } finally {
      setBusy(false);
    }
  }, [item.path, reportFail, reportOk, sessionId]);
  const restore = useCallback(async (): Promise<void> => {
    if (!globalThis.confirm(`恢复为新项目，不覆盖原项目。\n确定从 ${item.path} 恢复吗？`)) return;
    setBusy(true);
    try {
      const outcome = await postRestore(sessionId, { bundlePath: item.path });
      reportOk(`已恢复为新项目 ${outcome.restoredRoot}（${String(outcome.counts.files)} 个文件），原项目未改动。`);
    } catch (failure) {
      reportFail(failure instanceof Error ? failure.message : "恢复失败。");
    } finally {
      setBusy(false);
    }
  }, [item.path, reportFail, reportOk, sessionId]);
  return <li className="oh-backup-item">
    <div className="oh-backup-item-head">
      <span className="oh-backup-kind">{KIND_LABEL[item.kind]}</span>
      <span className="oh-backup-path" title={item.path}>{item.path}</span>
    </div>
    <div className="oh-backup-item-meta">
      {formatTime(item.createdAt)} · {String(item.counts.files)} 个文件 · {String(item.counts.bytes)}B · #{item.hashShort}
    </div>
    <div className="oh-backup-buttons">
      <button type="button" className="oh-backup-action" disabled={busy} onClick={() => { void download(); }}>下载</button>
      <button type="button" className="oh-backup-action oh-backup-restore" disabled={busy} onClick={() => { void restore(); }}>恢复为新项目</button>
    </div>
  </li>;
}

function ImportSection({ sessionId, reportOk, reportFail }: { readonly sessionId: string } & SectionHooks): JSX.Element {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const onFile = useCallback(async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    if (file === undefined) return;
    setBusy(true);
    try {
      const outcome = await postRestore(sessionId, { bundle: JSON.parse(await file.text()) as unknown });
      reportOk(`已从离线文件恢复为新项目 ${outcome.restoredRoot}（${String(outcome.counts.files)} 个文件）。`);
    } catch (failure) {
      reportFail(failure instanceof Error ? failure.message : "导入恢复失败。");
    } finally {
      setBusy(false);
      if (fileRef.current !== null) fileRef.current.value = "";
    }
  }, [reportFail, reportOk, sessionId]);
  return <section className="oh-backup-section" aria-label="导入备份恢复">
    <h4>导入备份恢复</h4>
    <p className="oh-backup-meta">选择之前下载的备份 JSON 文件，离线重新导入并恢复为新项目。</p>
    <input ref={fileRef} type="file" accept="application/json,.json" disabled={busy} onChange={(event) => { void onFile(event); }} aria-label="选择备份文件" />
  </section>;
}

function BackupPanel({ sessionId }: WorkbenchFeatureProps): JSX.Element {
  const [backups, setBackups] = useState<readonly BackupSummary[] | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const refresh = useCallback(async (signal?: AbortSignal): Promise<void> => {
    setLoading(true);
    try {
      const payload = await jsonOrThrow<{ readonly backups: BackupSummary[] }>(
        await fetch(endpoint("backup/list", sessionId), signal === undefined ? {} : { signal }));
      setBackups(payload.backups);
    } catch (failure) {
      if (failure instanceof DOMException && failure.name === "AbortError") return;
      setBackups(undefined);
      setError(failure instanceof Error ? failure.message : "加载备份列表失败。");
    } finally {
      setLoading(false);
    }
  }, [sessionId]);
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => { controller.abort(); };
  }, [refresh]);
  const reportOk = useCallback((message: string): void => {
    setError(undefined);
    setNotice(message);
    void refresh();
  }, [refresh]);
  const reportFail = useCallback((message: string): void => {
    setNotice(undefined);
    setError(message);
  }, []);
  return <div className="oh-backup-panel">
    <style>{styles}</style>
    <p className="oh-backup-meta">恢复一律恢复为新项目，不覆盖原项目。媒体文件仅跳过不备份字节。</p>
    {error !== undefined ? <p className="oh-backup-error" role="alert">{error}</p> : null}
    {notice !== undefined ? <p className="oh-backup-notice" role="status">{notice}</p> : null}
    <CreateSection sessionId={sessionId} reportOk={reportOk} reportFail={reportFail} />
    <section className="oh-backup-section" aria-label="备份列表">
      <h4>备份列表{backups !== undefined ? `（${String(backups.length)}）` : ""}</h4>
      {loading ? <p className="oh-backup-meta">正在加载备份…</p> : null}
      {backups !== undefined && backups.length === 0
        ? <p className="oh-backup-meta">暂无备份，先在上方创建一个作品包、快照或整体备份。</p>
        : null}
      <ul className="oh-backup-list">
        {(backups ?? []).map((item) => <BackupItem
          key={item.path}
          sessionId={sessionId}
          item={item}
          reportOk={reportOk}
          reportFail={reportFail}
        />)}
      </ul>
    </section>
    <ImportSection sessionId={sessionId} reportOk={reportOk} reportFail={reportFail} />
  </div>;
}

registerWorkbenchFeature({
  id: "backup",
  label: "备份",
  icon: "⛨",
  workbenches: ["story", "drama"],
  component: BackupPanel,
});

export function registerBackupFeature(): void {
  // 面板在模块顶层注册,保留具名导出兼容既有导入.
}
