/**
 * 游戏 Studio 组件层(由 src/client/index.tsx 389-731 行逐字迁移,仅 import 来源调整)。
 * 状态类型与 json 工具由 ./workbench-state.js 提供;本文件不得 import ./index.js(成环)。
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { workbenchLabel, type WorkbenchMode } from "./file-activity.js";
import { isGameArtImage } from "./game-art.js";
import { GameQa } from "./game-qa.js";
import { MarkdownPreview } from "./markdown-preview.js";
import { endpoint, handleTabKey } from "./workbench-ui.js";
import { json } from "./workbench-state.js";
import type {
  FilePayload,
  GameProject,
  WorkbenchMemory,
  WorkspaceFile,
  WorkspacePayload
} from "./workbench-state.js";

export function isolatedPreviewUrl(path: string, version: string, revision: number): { readonly href: string; readonly isolated: boolean } {
  const url = new URL(path, globalThis.location.origin);
  if (url.hostname === "127.0.0.1") url.hostname = "localhost";
  else if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  url.searchParams.set("build", version);
  url.searchParams.set("reload", String(revision));
  return { href: url.toString(), isolated: url.origin !== globalThis.location.origin };
}

/**
 * An iframe fires `load`, not `error`, when a navigation commits an HTTP error response, so the
 * frame's own events cannot tell a working preview from the route's JSON error body. Probe the
 * same URL out of band and report a non-OK or non-HTML answer as a real failure.
 */
export function PreviewProbe({ href, onFailed }: { readonly href: string; readonly onFailed: () => void }) {
  // Hold the callback in a ref so an inline arrow from the caller cannot re-trigger the probe.
  const failedRef = useRef(onFailed);
  useEffect(() => { failedRef.current = onFailed; }, [onFailed]);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(href, { signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted) return;
        const type = response.headers.get("content-type") ?? "";
        if (!response.ok || !type.includes("text/html")) failedRef.current();
      })
      .catch(() => { if (!controller.signal.aborted) failedRef.current(); });
    return () => { controller.abort(); };
  }, [href]);
  return null;
}

export function GamePreview({ project, building }: { readonly project: GameProject; readonly building: boolean }) {
  const shellRef = useRef<HTMLDivElement>(null);
  const fullscreenButtonRef = useRef<HTMLButtonElement>(null);
  const restoreFullscreenFocus = useRef(false);
  const [focused, setFocused] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [loadedVersion, setLoadedVersion] = useState(project.previewVersion);
  useEffect(() => {
    const document = shellRef.current?.ownerDocument;
    if (document === undefined) return;
    const restore = (): void => {
      if (document.fullscreenElement !== null || !restoreFullscreenFocus.current) return;
      restoreFullscreenFocus.current = false;
      fullscreenButtonRef.current?.focus();
    };
    document.addEventListener("fullscreenchange", restore);
    return () => { document.removeEventListener("fullscreenchange", restore); };
  }, []);
  if (!project.previewReady || project.previewUrl === undefined) return <div className="oh-game-preview-empty">
    <span aria-hidden>◫</span>
    <strong>还没有可试玩版本</strong>
    <p>在右侧 Chat 使用 <code>/novel-to-game quick</code>，产物写入 <code>game-adaptations/&lt;project&gt;/build/app/</code> 后会自动出现在这里。</p>
    <div className="oh-game-prompt-example"><span>描述示例</span><q>把《作品名》改编成网页互动游戏，目标玩家是……，核心玩法是……，希望整体风格……</q></div>
  </div>;
  const preview = isolatedPreviewUrl(project.previewUrl, loadedVersion, revision);
  const pending = project.previewVersion !== loadedVersion;
  /** Accept the newer build the creator just chose. */
  const reload = (): void => {
    setLoaded(false);
    setLoadError(false);
    setLoadedVersion(project.previewVersion);
    setRevision((value) => value + 1);
  };
  /** Re-run the build the creator already accepted; never silently adopt a newer one. */
  const refresh = (): void => {
    setLoaded(false);
    setLoadError(false);
    setRevision((value) => value + 1);
  };
  const runtimeState = loadError ? "预览载入失败 · 可重新载入"
    : building ? "Agent 正在更新游戏文件 · 当前预览保持不变"
      : pending ? "新版本已就绪 · 由你决定何时载入"
        : loaded ? (preview.isolated ? "预览已载入" : "预览已载入 · 当前部署无法隔离来源，存档功能不可用")
          : "正在载入预览…";
  const fullscreen = (): void => {
    const shell = shellRef.current;
    if (shell === null) return;
    restoreFullscreenFocus.current = true;
    void shell.requestFullscreen().catch(() => { restoreFullscreenFocus.current = false; });
  };
  return <div ref={shellRef} className="oh-game-preview-shell" data-state={loadError ? "error" : building ? "building" : loaded ? "ready" : "loading"}>
    <div className="oh-game-preview-status">
      <span className="oh-game-runtime-state" role="status" aria-live="polite" title={runtimeState}><i aria-hidden /><em>{runtimeState}</em></span>
      <div>
        {pending && !building && <button type="button" onClick={reload}>载入新版本</button>}
        <button className="oh-game-reload" type="button" onClick={refresh} aria-label="重新载入游戏"><span aria-hidden>↻</span><b>刷新</b></button>
        <button ref={fullscreenButtonRef} type="button" onClick={fullscreen}>全屏试玩</button>
      </div>
    </div>
    <PreviewProbe href={preview.href} onFailed={() => { setLoaded(false); setLoadError(true); }} />
    <iframe
      key={`${project.id}:${loadedVersion}:${String(revision)}`}
      src={preview.href}
      title={`《${project.title}》可试玩预览`}
      sandbox={preview.isolated
        ? "allow-scripts allow-same-origin allow-forms allow-modals allow-downloads"
        : "allow-scripts allow-forms allow-modals allow-downloads"}
      allow="autoplay; fullscreen; gamepad"
      allowFullScreen
      referrerPolicy="no-referrer"
      onLoad={() => { setLoadError(false); setLoaded(true); }}
      onError={() => { setLoaded(false); setLoadError(true); }}
      onFocus={() => { setFocused(true); }}
      onBlur={() => { setFocused(false); }}
    />
    <div className="oh-game-focus-hint" data-focused={focused || undefined}>{focused ? "游戏正在接收键鼠输入" : "点击画面进入试玩"}</div>
  </div>;
}

/**
 * 游戏音频分组规则:当前项目 audio/ 下递归,仅 .wav/.mp3/.flac。
 * ComfyUI 音乐工作流产物经 oh_story_comfyui 落在 game-adaptations/<项目>/audio/。
 * 纯函数,便于 tests/game-audio.test.ts 直接覆盖。
 */
export function isGameAudio(path: string, root: string): boolean {
  if (!/\.(?:wav|mp3|flac)$/iu.test(path)) return false;
  return path.startsWith(`${root}/audio/`);
}

export function GameDesign({
  project,
  files,
  selected,
  sessionId,
  onSelect
}: {
  readonly project: GameProject;
  readonly files: readonly WorkspaceFile[];
  readonly selected: string | undefined;
  readonly sessionId: string;
  readonly onSelect: (path: string) => void;
}) {
  const documents = useMemo(() => files.filter((file) => file.path.startsWith(`${project.root}/`) && (
    /\.(?:md|txt|json|jsonl|html|css|[cm]?js|tsx?|jsx)$/iu.test(file.path)
  )), [files, project.root]);
  const artworks = useMemo(() => files.filter((file) => isGameArtImage(file.path, project.root)), [files, project.root]);
  const audios = useMemo(() => files.filter((file) => isGameAudio(file.path, project.root)), [files, project.root]);
  const preferred = selected !== undefined && (documents.some((file) => file.path === selected) || artworks.some((file) => file.path === selected) || audios.some((file) => file.path === selected))
    ? selected
    : documents.find((file) => file.path === `${project.root}/PRODUCT_BRIEF.md`)?.path ?? documents[0]?.path ?? artworks[0]?.path ?? audios[0]?.path;
  const [path, setPath] = useState(preferred);
  const [content, setContent] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => { setPath(preferred); }, [preferred, project.id]);
  const artwork = path === undefined ? undefined : artworks.find((file) => file.path === path);
  const audio = artwork === undefined && path !== undefined ? audios.find((file) => file.path === path) : undefined;
  useEffect(() => {
    if (path === undefined || artwork !== undefined || audio !== undefined || project.source === "example") { setContent(undefined); return; }
    const controller = new AbortController();
    setContent(undefined);
    setError(undefined);
    void fetch(endpoint("file", sessionId, path), { signal: controller.signal })
      .then((response) => json<FilePayload>(response))
      .then((file) => { setContent(file.content); })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { controller.abort(); };
  }, [artwork, audio, path, project.source, sessionId]);
  if (project.source === "example") return <div className="oh-game-design-empty">
    <strong>内置完整示例</strong>
    <p>《金瓶梅 · 风月总账》的完整可玩构建与 QA 校验结果随插件打包，可直接在左侧试玩。上游的产品简报、分析、概念、设计与源小说不随包分发，可在 novel-to-game 仓库查看完整创作过程。</p>
    <code>novel-to-game/examples/jin-ping-mei</code>
  </div>;
  if ((documents.length === 0 && artworks.length === 0 && audios.length === 0) || path === undefined) return <div className="oh-game-design-empty">当前项目还没有可检查的设计或源文件。</div>;
  const markdown = path.toLocaleLowerCase().endsWith(".md");
  const diagnostics = project.gameArtDiagnostics ?? [];
  return <div className="oh-game-design">
    {diagnostics.length > 0 && <details className="oh-game-art-diagnostics" data-level={diagnostics.some((item) => item.level === "error") ? "error" : "warning"}>
      <summary>美术接入诊断（三方对账）: {diagnostics.length} 项</summary>
      <ul>{diagnostics.map((item, index) => <li data-level={item.level} key={`${item.code}:${String(index)}`}>{item.level === "error" ? "⛔" : "⚠"} {item.message}</li>)}</ul>
    </details>}
    <p className="oh-game-cost-note" role="note">美术 / 音频均由 ComfyUI 本地生成 · 免费（需本地已部署 ComfyUI）</p>
    <label>项目文件<select value={path} onChange={(event) => {
      setPath(event.target.value);
      onSelect(event.target.value);
    }}>{documents.map((file) => <option value={file.path} key={file.path}>{file.path.slice(project.root.length + 1)}</option>)}{artworks.length > 0 && <optgroup label="美术">{artworks.map((file) => <option value={file.path} key={file.path}>{file.path.slice(project.root.length + 1)}</option>)}</optgroup>}{audios.length > 0 && <optgroup label="音频">{audios.map((file) => <option value={file.path} key={file.path}>{file.path.slice(project.root.length + 1)}</option>)}</optgroup>}</select></label>
    {artwork !== undefined ? <div className="oh-story-media-document"><img src={endpoint("media", sessionId, artwork.path)} alt={artwork.path} loading="lazy" /></div>
      : audio !== undefined ? <div className="oh-story-media-document"><audio className="oh-game-audio" src={endpoint("media", sessionId, audio.path)} controls preload="metadata" /></div>
      : error !== undefined ? <div className="oh-story-error">{error}</div>
      : content === undefined ? <div className="oh-game-design-empty">正在载入文件…</div>
        : markdown ? <MarkdownPreview content={content} label={path} />
          : <pre className="oh-game-source" aria-label={`${path} 源码`}>{content}</pre>}
  </div>;
}

/**
 * Float mirrors never clone the live Studio (iframe/player state would fork).
 * The Studio stays mounted in place; the float is a status card with a
 * dock-back action. Docking restores the original rendering.
 */
export function FloatMirror({ title, hint }: { readonly title: string; readonly hint: string }) {
  return <div className="oh-game-design-empty">
    <span aria-hidden>⧉</span>
    <strong>{title}</strong>
    <p>{hint}</p>
  </div>;
}

/**
 * 构建导出:把可玩 build/app 冻结为项目内交付快照(POST /oh-story/game-export)。
 * 仅 workspace 项目的 previewReady 态可用;错误显式展示,不吞。
 */
export function GameExportButton({ sessionId, project }: {
  readonly sessionId: string;
  readonly project: GameProject;
}) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ readonly ok: true; readonly exportPath: string; readonly fileCount: number } | { readonly ok: false; readonly message: string } | undefined>();
  if (project.source !== "workspace" || !project.previewReady) return null;
  const projectName = project.root.slice("game-adaptations/".length);
  const run = (): void => {
    if (busy) return;
    setBusy(true);
    setOutcome(undefined);
    void fetch(endpoint("game-export", sessionId), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: projectName })
    }).then(async (response) => {
      const payload = await response.json().catch(() => undefined) as { readonly exportPath?: string; readonly fileCount?: number; readonly error?: string } | undefined;
      if (!response.ok || payload === undefined) {
        throw new Error(payload?.error ?? `HTTP ${String(response.status)}`);
      }
      setOutcome({ ok: true, exportPath: payload.exportPath ?? "", fileCount: payload.fileCount ?? 0 });
    }).catch((reason: unknown) => {
      setOutcome({ ok: false, message: reason instanceof Error ? reason.message : String(reason) });
    }).finally(() => { setBusy(false); });
  };
  return <span className="oh-game-export">
    <button type="button" disabled={busy} onClick={run}>{busy ? "导出中…" : "导出交付快照"}</button>
    {outcome?.ok === true && <span role="status">已导出到 {outcome.exportPath}（{String(outcome.fileCount)} 个文件）</span>}
    {outcome?.ok === false && <span className="oh-story-error" role="alert">导出失败:{outcome.message}</span>}
  </span>;
}

export function GameStudio({  sessionId,
  workspace,
  building,
  selected,
  gameTab,
  gameProjectId,
  hidden,
  onGameTab,
  onGameProject,
  workbenches,
  paneId,
  labelledBy,
  onWorkbench,
  onCollapse,
  onSelect,
  floatActive,
  onFloatToggle
}: {
  readonly sessionId: string;
  readonly workspace: WorkspacePayload;
  readonly building: boolean;
  readonly selected: string | undefined;
  readonly gameTab: WorkbenchMemory["gameTab"];
  readonly gameProjectId: string | undefined;
  readonly hidden: boolean;
  readonly onGameTab: (tab: WorkbenchMemory["gameTab"]) => void;
  readonly onGameProject: (id: string) => void;
  readonly workbenches: readonly WorkbenchMode[];
  readonly paneId: string;
  readonly labelledBy: string;
  readonly onWorkbench: (mode: WorkbenchMode) => void;
  readonly onCollapse: () => void;
  readonly onSelect: (path: string) => void;
  /** The studio floats in a FreeWindow; the toolbar button docks it back. */
  readonly floatActive: boolean;
  readonly onFloatToggle: () => void;
}) {
  const project = workspace.games.find((value) => value.id === gameProjectId) ?? workspace.games[0];
  const studioRef = useRef<HTMLElement>(null);
  const tabsId = useId();
  useLayoutEffect(() => {
    const studio = studioRef.current;
    if (studio === null) return;
    const publishWidth = () => {
      studio.toggleAttribute("data-oh-game-narrow", studio.clientWidth <= 300);
    };
    publishWidth();
    const observer = new ResizeObserver(publishWidth);
    observer.observe(studio);
    return () => { observer.disconnect(); };
  }, []);
  useEffect(() => {
    if (project !== undefined && project.id !== gameProjectId) onGameProject(project.id);
  }, [gameProjectId, onGameProject, project]);
  if (project === undefined) return <main ref={studioRef} id={paneId} className="oh-game-studio" role="tabpanel" aria-labelledby={labelledBy} hidden={hidden}><div className="oh-game-design-empty">游戏能力正在载入…</div></main>;
  const tabs = ["preview", "design", "qa"] as const;
  return <main ref={studioRef} id={paneId} className="oh-game-studio" data-source={project.source} data-oh-floated={floatActive || undefined} role="tabpanel" aria-labelledby={labelledBy} hidden={hidden}>
    <header className="oh-game-toolbar">
      <div className="oh-workbench-cluster">
        {workbenches.length > 1 && <div className="oh-game-mode-tabs" role="tablist" aria-label="创作工作台">
          {workbenches.map((mode) => <button
            type="button"
            role="tab"
            key={mode}
            aria-selected={mode === "game"}
            tabIndex={mode === "game" ? 0 : -1}
            onKeyDown={(event) => { handleTabKey(event, workbenches, "game", onWorkbench); }}
            onClick={() => { onWorkbench(mode); }}
          >{workbenchLabel(mode)}</button>)}
        </div>}
        <button className="oh-workbench-collapse" type="button" title="收起创作工作台" aria-label="收起创作工作台" onClick={onCollapse}>×</button>
        <button className="oh-workbench-float" type="button" title={floatActive ? "放回工作台" : "拖出为浮窗"} aria-label={floatActive ? "将游戏放回工作台" : "将游戏拖出为浮窗"} aria-pressed={floatActive} onClick={onFloatToggle}>⧉</button>
      </div>
      <label className="oh-game-project" title="切换项目将重新载入试玩"><span>游戏项目</span><select aria-label="游戏项目；切换将重新载入试玩" value={project.id} onChange={(event) => { onGameProject(event.target.value); }}>
        {workspace.games.some((item) => item.source === "workspace") && <optgroup label="我的项目">{workspace.games.filter((item) => item.source === "workspace").map((item) => <option value={item.id} key={item.id}>{`我的项目 · ${item.title}`}</option>)}</optgroup>}
        {workspace.games.some((item) => item.source === "example") && <optgroup label="内置示例">{workspace.games.filter((item) => item.source === "example").map((item) => <option value={item.id} key={item.id}>{`内置示例 · ${item.title}`}</option>)}</optgroup>}
      </select></label>
      <div className="oh-game-tabs" role="tablist" aria-label="游戏工作台">
        {tabs.map((tab) => <button
          key={tab}
          type="button"
          role="tab"
          tabIndex={gameTab === tab ? 0 : -1}
          aria-selected={gameTab === tab}
          id={`${tabsId}-${tab}-tab`}
          aria-controls={`${tabsId}-${tab}-panel`}
          onKeyDown={(event) => { handleTabKey(event, tabs, gameTab, onGameTab); }}
          onClick={() => { onGameTab(tab); }}
        >{tab === "preview" ? "试玩" : tab === "qa" ? "质检" : project.source === "example" ? "说明" : "项目文件"}</button>)}
      </div>
      <GameExportButton sessionId={sessionId} project={project} />
    </header>
    <div className="oh-game-panels">
      <div className="oh-game-panel" role="tabpanel" id={`${tabsId}-preview-panel`} aria-labelledby={`${tabsId}-preview-tab`} hidden={gameTab !== "preview"}>
        <GamePreview key={`${project.id}:${String(project.previewReady)}`} project={project} building={building} />
      </div>
      <div className="oh-game-panel" role="tabpanel" id={`${tabsId}-design-panel`} aria-labelledby={`${tabsId}-design-tab`} hidden={gameTab !== "design"}>
        <GameDesign project={project} files={workspace.files} selected={selected} sessionId={sessionId} onSelect={onSelect} />
      </div>
      <div className="oh-game-panel" role="tabpanel" id={`${tabsId}-qa-panel`} aria-labelledby={`${tabsId}-qa-tab`} hidden={gameTab !== "qa"}>
        <GameQa qa={project.qa ?? { present: false }} projectTitle={project.title} />
      </div>
    </div>
  </main>;
}
