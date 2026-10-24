import { useCallback, useEffect, useRef, useState } from "react";
import {
  CONTINUITY_LEVEL_ORDER,
  type ContinuityHandoffManifest,
  type ContinuityHandoffVerifyResult,
  type ContinuityLevel,
  type ContinuityOverview,
  type ContinuityRisk,
  type ContinuitySnapshotResult,
} from "../../services/continuity-contract.js";
import { endpoint } from "../workbench-ui.js";
import { registerWorkbenchFeature, type WorkbenchFeatureProps } from "./registry.js";
import diagStyles from "./diagnostics-feature.css?inline";
import cockpitStyles from "./continuity-feature.css?inline";

/**
 * 「驾驶舱」面板：只读投影 `.oh-story/` 与创作树的连续性事实。
 *
 * 概览走 GET，面板只做呈现；「创建快照」是唯一写入动作，
 * 必须经 window.confirm 显式确认，且只写 `.oh-story/backup/`。
 * 任何失败都会显示出来，忙碌时按钮全部禁用，绝不静默吞掉。
 */

const LEVELS: readonly ContinuityLevel[] = (Object.keys(CONTINUITY_LEVEL_ORDER) as ContinuityLevel[])
  .sort((left, right) => CONTINUITY_LEVEL_ORDER[left] - CONTINUITY_LEVEL_ORDER[right]);

const KIND_LABELS: Readonly<Record<ContinuityOverview["project"]["kind"], string>> = {
  novel: "小说",
  drama: "短剧",
  game: "互动游戏",
  video: "视频解说",
  unknown: "未知类型",
};

const SNAPSHOT_CONFIRM =
  "将把创作树与 .oh-story/ 状态打包成整体备份，只写入 .oh-story/backup/"
  + "（不改动正文与状态文档，不含 DSH 会话与 vault 主密钥）。确认继续？";

const STYLES = `${diagStyles}\n${cockpitStyles}`;

async function jsonOrThrow<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as T & { readonly error?: string };
  if (!response.ok) throw new Error(payload.error ?? `HTTP ${String(response.status)}`);
  return payload;
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString("zh-CN", { hour12: false });
}

function backupText(today: ContinuityOverview["today"]): string {
  if (today.lastBackupAt === null) return "还没有备份。";
  const age = today.backupAgeDays === null
    ? ""
    : today.backupAgeDays === 0 ? "（今天）" : `（${String(today.backupAgeDays)} 天前）`;
  return `${formatTime(today.lastBackupAt)}${age}`;
}

interface PathButtonProps {
  readonly path: string;
  readonly onReveal?: ((path: string, line: number, offset: number) => void) | undefined;
}

function PathButton({ path, onReveal }: PathButtonProps): JSX.Element {
  return <button
    type="button"
    className="oh-continuity-path"
    onClick={() => { onReveal?.(path, 1, 0); }}
  >{path}</button>;
}

function RiskCard({ risk, onReveal }: { readonly risk: ContinuityRisk; readonly onReveal?: PathButtonProps["onReveal"] }): JSX.Element {
  return <article className="oh-diag-check">
    <h4 className="oh-diag-check-title">{risk.title}</h4>
    <p className="oh-diag-check-summary">{risk.detail}</p>
    {risk.paths.length === 0
      ? null
      : <div className="oh-continuity-paths">
        {risk.paths.map((path) => <PathButton key={path} path={path} onReveal={onReveal} />)}
      </div>}
    <p className="oh-diag-check-summary">下一步：{risk.nextAction}</p>
  </article>;
}

interface RiskGroup {
  readonly level: ContinuityLevel;
  readonly risks: readonly ContinuityRisk[];
}

function riskGroups(risks: readonly ContinuityRisk[]): readonly RiskGroup[] {
  return LEVELS
    .map((level) => ({ level, risks: risks.filter((risk) => risk.level === level) }))
    .filter((group) => group.risks.length > 0);
}

function levelCounts(risks: readonly ContinuityRisk[]): ReadonlyMap<ContinuityLevel, number> {
  const counts = new Map<ContinuityLevel, number>();
  for (const risk of risks) counts.set(risk.level, (counts.get(risk.level) ?? 0) + 1);
  return counts;
}

export interface ContinuityViewProps {
  readonly overview: ContinuityOverview;
  readonly busy: boolean;
  readonly onRefresh: () => void;
  readonly onSnapshot: () => void;
  readonly onHandoff: () => void;
  readonly onVerifyHandoff: () => void;
  readonly onReveal?: ((path: string, line: number, offset: number) => void) | undefined;
  readonly notice?: string | undefined;
  readonly error?: string | undefined;
  readonly handoffFallback?: string | undefined;
}

/** 纯展示组件：只吃 props，可在 SSR/测试里直接渲染。 */
export function ContinuityView({
  overview,
  busy,
  onRefresh,
  onSnapshot,
  onHandoff,
  onVerifyHandoff,
  onReveal,
  notice,
  error,
  handoffFallback,
}: ContinuityViewProps): JSX.Element {
  const { project, today, risks } = overview;
  const groups = riskGroups(risks);
  const counts = levelCounts(risks);
  const latest = today.nextChapter;
  return <div className="oh-diag-body" aria-busy={busy}>
    <div className="oh-diag-bar">
      <span className="oh-diag-meta">
        {project.title} · {KIND_LABELS[project.kind]}{project.root === "" ? "" : ` · ${project.root}`} · 生成于 {overview.generatedAt}
      </span>
      <div className="oh-diag-actions">
        <button type="button" className="oh-diag-action" disabled={busy} onClick={onRefresh}>刷新</button>
        <button type="button" className="oh-diag-action" disabled={busy} onClick={onSnapshot}>创建快照</button>
        <button type="button" className="oh-diag-action" disabled={busy} onClick={onHandoff}>复制交接清单</button>
        <button type="button" className="oh-diag-action" disabled={busy} onClick={onVerifyHandoff}>校验交接清单</button>
      </div>
    </div>
    <div className="oh-diag-chips" role="group" aria-label="风险汇总">
      {LEVELS.map((level) => <span className="oh-diag-chip" data-kind={level.toLocaleLowerCase()} key={level}>
        {level} {String(counts.get(level) ?? 0)}
      </span>)}
    </div>
    {error !== undefined ? <p className="oh-diag-error" role="alert">{error}</p> : null}
    {notice !== undefined ? <p className="oh-diag-notice" role="status">{notice}</p> : null}
    {handoffFallback !== undefined
      ? <textarea
        className="oh-diag-fallback"
        readOnly
        value={handoffFallback}
        aria-label="可手动复制的交接清单"
        onFocus={(event) => { event.currentTarget.select(); }}
      />
      : null}
    <div className="oh-diag-groups">
      <section className="oh-diag-group">
        <h3 className="oh-diag-group-title">今天</h3>
        <ul className="oh-diag-guidance">
          <li>
            下一章：第 {latest.ordinal} 章{latest.latestTitle === null ? "" : ` · ${latest.latestTitle}`}
            {latest.latestPath === null ? null : <> · <PathButton path={latest.latestPath} onReveal={onReveal} /></>}
          </li>
          <li>
            到期伏笔：{today.dueForeshadows.length === 0
              ? "今天没有到期伏笔。"
              : today.dueForeshadows.map((item) => `${item.title}（${item.status}${item.plannedPayoffChapter === undefined || item.plannedPayoffChapter === "" ? "" : ` · 计划在${item.plannedPayoffChapter}回收`}）`).join("；")}
          </li>
          <li>
            暂停 / 失败的运行：{today.pausedRuns.length === 0
              ? "无。"
              : today.pausedRuns.map((run) => `${run.kind} · ${run.status} · ${formatTime(run.updatedAt)}`).join("；")}
          </li>
          <li>候选变更：{today.proposedCandidates === 0 ? "无。" : `${String(today.proposedCandidates)} 条待确认。`}</li>
          <li>
            追踪：{project.tracking.source === "invalid"
              ? "状态无法解析。"
              : project.tracking.source === "absent"
                ? "尚未建立。"
                : project.tracking.lastChapter === null ? "已建立，尚无提交章。" : `第 ${String(project.tracking.lastChapter)} 章。`}
          </li>
          <li>最近备份：{backupText(today)}</li>
          <li>
            最近保存：{today.recentSaves.length === 0
              ? "无。"
              : today.recentSaves.map((save) => <span key={`${save.path}:${save.version}`}>
                <PathButton path={save.path} onReveal={onReveal} /> · {save.version === "" ? "无版本" : save.version} · {formatTime(save.timestamp)}；
              </span>)}
          </li>
        </ul>
      </section>
      <section className="oh-diag-group">
        <h3 className="oh-diag-group-title">风险</h3>
        {groups.length === 0
          ? <p className="oh-diag-empty">今天没有风险。</p>
          : groups.map((group) => <div className="oh-diag-group" key={group.level} data-level={group.level}>
            <h4 className="oh-diag-group-title">{group.level} · {String(group.risks.length)} 项</h4>
            {group.risks.map((risk) => <RiskCard key={risk.id} risk={risk} onReveal={onReveal} />)}
          </div>)}
      </section>
    </div>
  </div>;
}

function ContinuityPanel({ sessionId, onReveal }: WorkbenchFeatureProps): JSX.Element {
  const [overview, setOverview] = useState<ContinuityOverview | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [handoffFallback, setHandoffFallback] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState<string | undefined>(undefined);
  const requestId = useRef(0);
  const handoffInputRef = useRef<HTMLInputElement | null>(null);
  const busy = pending !== undefined;

  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    const id = ++requestId.current;
    setPending("refresh");
    setError(undefined);
    try {
      const response = await fetch(endpoint("continuity", sessionId), signal === undefined ? undefined : { signal });
      const payload = await jsonOrThrow<ContinuityOverview>(response);
      if (id !== requestId.current) return;
      setOverview(payload);
    } catch (failure) {
      if (id !== requestId.current) return;
      if (failure instanceof DOMException && failure.name === "AbortError") return;
      setError(failure instanceof Error ? failure.message : "读取失败。");
    } finally {
      if (id === requestId.current) setPending(undefined);
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

  const snapshot = useCallback(async (): Promise<void> => {
    if (!globalThis.confirm(SNAPSHOT_CONFIRM)) return;
    setPending("snapshot");
    setError(undefined);
    setNotice(undefined);
    try {
      const response = await fetch(endpoint("continuity/snapshot", sessionId), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      const result = await jsonOrThrow<ContinuitySnapshotResult>(response);
      await load();
      setNotice(`已创建快照 ${result.path}（${String(result.counts.files)} 个文件，${String(result.counts.bytes)} 字节）。`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "创建快照失败。");
    } finally {
      setPending(undefined);
    }
  }, [load, sessionId]);

  const handoff = useCallback(async (): Promise<void> => {
    setPending("handoff");
    setError(undefined);
    setNotice(undefined);
    setHandoffFallback(undefined);
    try {
      const response = await fetch(endpoint("continuity/handoff", sessionId));
      const manifest = await jsonOrThrow<ContinuityHandoffManifest>(response);
      const text = JSON.stringify(manifest, null, 2);
      const skippedNote = manifest.skipped.length === 0
        ? ""
        : `，跳过 ${String(manifest.skipped.length)} 个无法读取的文件`;
      const clipboard: Clipboard | undefined = navigator.clipboard;
      if (clipboard !== undefined) {
        try {
          await clipboard.writeText(text);
          setNotice(`交接清单已复制：${String(manifest.files.length)} 个文件${skippedNote}，校验和 ${manifest.checksum.slice(0, 12)}…`);
          return;
        } catch {
          // 剪贴板被拒绝时退回可选中的文本框，不把这次操作吞掉。
        }
      }
      setHandoffFallback(text);
      setNotice(`剪贴板不可用，请手动选择下方文本复制（${String(manifest.files.length)} 个文件${skippedNote}）。`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "读取交接清单失败。");
    } finally {
      setPending(undefined);
    }
  }, [sessionId]);

  const verifyHandoff = useCallback(async (file: File): Promise<void> => {
    setPending("verify-handoff");
    setError(undefined);
    setNotice(undefined);
    let manifest: unknown;
    try {
      manifest = JSON.parse(await file.text()) as unknown;
    } catch {
      setError("交接清单不是合法 JSON。");
      setPending(undefined);
      return;
    }
    try {
      const response = await fetch(endpoint("continuity/handoff/verify", sessionId), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ manifest }),
      });
      const result = await jsonOrThrow<ContinuityHandoffVerifyResult>(response);
      const problems = result.files.filter((item) => item.status !== "match");
      if (result.ok) {
        setNotice(`交接清单校验通过：${String(result.checked)} 个文件全部匹配。`);
      } else {
        const details = problems.slice(0, 5).map((item) => `${item.path}（${item.status}）`).join("；");
        const skipped = result.skipped.length === 0 ? "" : `；清单自身跳过 ${String(result.skipped.length)} 个文件`;
        setNotice(`交接清单未通过：checksum ${result.checksumOk ? "一致" : "不一致"}，匹配 ${String(result.matched)}/${String(result.checked)}${details === "" ? "" : `；${details}`}${skipped}。`);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "校验交接清单失败。");
    } finally {
      setPending(undefined);
    }
  }, [sessionId]);

  return <div className="oh-diag-panel">
    <style>{STYLES}</style>
    <input
      ref={handoffInputRef}
      type="file"
      accept="application/json,.json"
      hidden
      onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (file !== undefined) void verifyHandoff(file);
      }}
    />
    {overview === undefined
      ? <div className="oh-diag-state">
        {error !== undefined
          ? <>
            <p className="oh-diag-error" role="alert">{error}</p>
            <button type="button" className="oh-diag-action" disabled={busy} onClick={refresh}>重试</button>
          </>
          : <p className="oh-diag-meta">{busy ? "正在读取…" : "尚无数据，点「刷新」重试。"}</p>}
      </div>
      : <ContinuityView
        overview={overview}
        busy={busy}
        onRefresh={refresh}
        onSnapshot={() => { void snapshot(); }}
        onHandoff={() => { void handoff(); }}
        onVerifyHandoff={() => { handoffInputRef.current?.click(); }}
        onReveal={onReveal}
        notice={notice}
        error={error}
        handoffFallback={handoffFallback}
      />}
  </div>;
}

registerWorkbenchFeature({
  id: "continuity",
  label: "驾驶舱",
  icon: "🧭",
  workbenches: ["story", "drama"],
  component: ContinuityPanel,
});
