import { useCallback, useEffect, useState } from "react";
import { endpoint } from "../workbench-ui.js";
import { registerWorkbenchFeature, type WorkbenchFeatureProps } from "./registry.js";
import styles from "./vault-feature.css?inline";

/**
 * 「保险库」面板：默认关闭；开启后只操作 .oh-story/vault/ 下的条目。
 * 列表只拿名称，明文只在用户显式「读取」后显示，绝不随列表或状态返回。
 */

export interface VaultStatusPayload {
  readonly enabled: boolean;
  readonly ready: boolean;
}

export interface VaultListPayload {
  readonly enabled: boolean;
  readonly names: readonly string[];
}

export interface VaultSecretPayload {
  readonly name: string;
  readonly value: string;
}

const DISABLED_TEXT = "凭据保险库未启用（设置 DSH_MIAOWU_VAULT_ENABLED=1 并重启 DSH）。";

async function jsonPayload<T>(response: Response): Promise<T & { readonly error?: string; readonly enabled?: boolean }> {
  try {
    return await response.json() as T & { readonly error?: string; readonly enabled?: boolean };
  } catch {
    throw new Error(`HTTP ${String(response.status)}`);
  }
}

function secretUrl(sessionId: string, name?: string): string {
  const url = new URL(endpoint("vault/secrets", sessionId));
  if (name !== undefined) url.searchParams.set("name", name);
  return url.toString();
}

export interface VaultViewProps {
  readonly status: VaultStatusPayload | undefined;
  readonly disabled: boolean;
  readonly names: readonly string[];
  readonly name: string;
  readonly value: string;
  readonly revealed: VaultSecretPayload | undefined;
  readonly busy: boolean;
  readonly notice: string | undefined;
  readonly error: string | undefined;
  readonly onRefresh: () => void;
  readonly onNameChange: (value: string) => void;
  readonly onValueChange: (value: string) => void;
  readonly onSave: () => void;
  readonly onReveal: (name: string) => void;
  readonly onHide: () => void;
  readonly onDelete: (name: string) => void;
  readonly onRotate: () => void;
  readonly onCopy: (value: string) => void;
}

export function VaultView({
  status,
  disabled,
  names,
  name,
  value,
  revealed,
  busy,
  notice,
  error,
  onRefresh,
  onNameChange,
  onValueChange,
  onSave,
  onReveal,
  onHide,
  onDelete,
  onRotate,
  onCopy,
}: VaultViewProps): JSX.Element {
  return <>
    <header className="oh-vault-head">
      <div>
        <h3>凭据保险库</h3>
        <p>
          {disabled ? "未启用" : status === undefined ? "读取中…" : "已启用"}
          {status !== undefined
            ? <span className="oh-vault-badge" data-ready={status.ready ? "true" : "false"}>{status.ready ? "已就绪" : "未初始化"}</span>
            : null}
        </p>
      </div>
      <button type="button" className="oh-vault-action" disabled={busy} onClick={onRefresh}>刷新</button>
    </header>
    {notice !== undefined ? <p className="oh-vault-notice" role="status">{notice}</p> : null}
    {error !== undefined ? <p className="oh-vault-error" role="alert">{error}</p> : null}
    {disabled
      ? <p className="oh-vault-note">凭据保险库默认关闭。设置 <code>DSH_MIAOWU_VAULT_ENABLED=1</code> 并重启 DSH 后，这里可以新增、读取、删除与轮换凭据。</p>
      : status === undefined
        ? <p className="oh-vault-note">{busy ? "正在读取保险库…" : "尚无保险库状态，点「刷新」重试。"}</p>
        : <>
          <form className="oh-vault-form" onSubmit={(event) => { event.preventDefault(); onSave(); }}>
            <label>名称
              <input
                value={name}
                onChange={(event) => { onNameChange(event.target.value); }}
                placeholder="例如 MIMO_API_KEY"
                autoComplete="off"
                spellCheck={false}
                maxLength={128}
                pattern="[A-Za-z0-9._-]+"
              />
            </label>
            <label>值
              <input
                type="password"
                value={value}
                onChange={(event) => { onValueChange(event.target.value); }}
                autoComplete="new-password"
              />
            </label>
            <button type="submit" disabled={busy}>写入 / 更新</button>
          </form>
          <ul className="oh-vault-list">
            {names.length === 0
              ? <li className="oh-vault-empty">还没有凭据。</li>
              : names.map((entry) => <li className="oh-vault-item" key={entry}>
                <code>{entry}</code>
                <div className="oh-vault-actions">
                  <button type="button" disabled={busy} onClick={() => { onReveal(entry); }}>读取</button>
                  <button type="button" disabled={busy} onClick={() => { onDelete(entry); }}>删除</button>
                </div>
              </li>)}
          </ul>
          {revealed !== undefined
            ? <section className="oh-vault-revealed" aria-label={`${revealed.name} 的凭据值`}>
              <header>
                <strong>{revealed.name}</strong>
                <div className="oh-vault-actions">
                  <button type="button" disabled={busy} onClick={() => { onCopy(revealed.value); }}>复制</button>
                  <button type="button" disabled={busy} onClick={onHide}>隐藏</button>
                </div>
              </header>
              <input readOnly value={revealed.value} aria-label={`${revealed.name} 的凭据值`} />
            </section>
            : null}
          <footer className="oh-vault-footer">
            <button type="button" className="oh-vault-action" disabled={busy || !status.ready} onClick={onRotate}>轮换主密钥</button>
            <span>轮换会重新加密全部凭据；旧密文将不可解。</span>
          </footer>
        </>}
  </>;
}

function VaultFeature({ sessionId }: WorkbenchFeatureProps): JSX.Element {
  const [status, setStatus] = useState<VaultStatusPayload | undefined>(undefined);
  const [disabled, setDisabled] = useState(false);
  const [names, setNames] = useState<readonly string[]>([]);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [revealed, setRevealed] = useState<VaultSecretPayload | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState<string | undefined>(undefined);
  const busy = pending !== undefined;

  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    setPending("refresh");
    setError(undefined);
    try {
      const response = await fetch(endpoint("vault/status", sessionId), signal === undefined ? undefined : { signal });
      const payload = await jsonPayload<VaultStatusPayload>(response);
      if (response.status === 403 && payload.enabled === false) {
        setDisabled(true);
        setStatus(undefined);
        setNames([]);
        setRevealed(undefined);
        setError(payload.error ?? DISABLED_TEXT);
        return;
      }
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${String(response.status)}`);
      setDisabled(false);
      setStatus({ enabled: true, ready: payload.ready === true });
      const listResponse = await fetch(secretUrl(sessionId), signal === undefined ? undefined : { signal });
      const listPayload = await jsonPayload<VaultListPayload>(listResponse);
      if (!listResponse.ok) throw new Error(listPayload.error ?? `HTTP ${String(listResponse.status)}`);
      setNames(listPayload.names);
    } catch (failure) {
      if (failure instanceof DOMException && failure.name === "AbortError") return;
      setError(failure instanceof Error ? failure.message : "读取保险库失败。");
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

  const save = useCallback(async (): Promise<void> => {
    const trimmed = name.trim();
    if (trimmed === "") {
      setError("请填写凭据名称。");
      return;
    }
    if (value === "") {
      setError("请填写凭据值。");
      return;
    }
    setPending("save");
    setError(undefined);
    setNotice(undefined);
    try {
      const response = await fetch(secretUrl(sessionId), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: trimmed, value }),
      });
      const payload = await jsonPayload<{ readonly name: string }>(response);
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${String(response.status)}`);
      setName("");
      setValue("");
      setRevealed(undefined);
      setNotice(`已写入 ${payload.name}。`);
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "写入凭据失败。");
    } finally {
      setPending(undefined);
    }
  }, [load, name, sessionId, value]);

  const reveal = useCallback(async (target: string): Promise<void> => {
    setPending(`reveal:${target}`);
    setError(undefined);
    try {
      const response = await fetch(secretUrl(sessionId, target));
      const payload = await jsonPayload<VaultSecretPayload>(response);
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${String(response.status)}`);
      setRevealed({ name: payload.name, value: payload.value });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "读取凭据失败。");
    } finally {
      setPending(undefined);
    }
  }, [sessionId]);

  const remove = useCallback(async (target: string): Promise<void> => {
    if (!globalThis.confirm(`删除凭据 ${target}？此操作不可撤销。`)) return;
    setPending(`delete:${target}`);
    setError(undefined);
    setNotice(undefined);
    try {
      const response = await fetch(secretUrl(sessionId, target), { method: "DELETE" });
      const payload = await jsonPayload<{ readonly deleted: boolean }>(response);
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${String(response.status)}`);
      if (revealed?.name === target) setRevealed(undefined);
      setNotice(payload.deleted ? `已删除 ${target}。` : `${target} 已不存在。`);
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "删除凭据失败。");
    } finally {
      setPending(undefined);
    }
  }, [load, revealed, sessionId]);

  const rotate = useCallback(async (): Promise<void> => {
    if (!globalThis.confirm("轮换主密钥会重新加密全部凭据；旧密文将不可解。确认继续？")) return;
    setPending("rotate");
    setError(undefined);
    setNotice(undefined);
    try {
      const response = await fetch(endpoint("vault/rotate", sessionId), { method: "POST" });
      const payload = await jsonPayload<{ readonly rotated: boolean; readonly count: number }>(response);
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${String(response.status)}`);
      setRevealed(undefined);
      setNotice(`已轮换主密钥，重新加密 ${String(payload.count)} 条凭据。`);
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "轮换主密钥失败。");
    } finally {
      setPending(undefined);
    }
  }, [load, sessionId]);

  const copy = useCallback((text: string): void => {
    setError(undefined);
    const clipboard: Clipboard | undefined = navigator.clipboard;
    if (clipboard === undefined) {
      setNotice("剪贴板不可用，请手动选择文本复制。");
      return;
    }
    void clipboard.writeText(text).then(
      () => { setNotice("已复制到剪贴板。"); },
      () => { setNotice("剪贴板不可用，请手动选择文本复制。"); }
    );
  }, []);

  return <div className="oh-vault-panel">
    <style>{styles}</style>
    <VaultView
      status={status}
      disabled={disabled}
      names={names}
      name={name}
      value={value}
      revealed={revealed}
      busy={busy}
      notice={notice}
      error={error}
      onRefresh={refresh}
      onNameChange={setName}
      onValueChange={setValue}
      onSave={() => { void save(); }}
      onReveal={(entry) => { void reveal(entry); }}
      onHide={() => { setRevealed(undefined); }}
      onDelete={(entry) => { void remove(entry); }}
      onRotate={() => { void rotate(); }}
      onCopy={copy}
    />
  </div>;
}

registerWorkbenchFeature({
  id: "vault",
  label: "保险库",
  icon: "🔐",
  workbenches: ["story", "drama"],
  component: VaultFeature,
});
