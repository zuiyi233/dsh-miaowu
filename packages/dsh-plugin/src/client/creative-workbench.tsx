import type { PartialAssistant, RunningToolCall } from "@deepseek-ai/dsh-client-ui-conversation/client";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type CSSProperties } from "react";
import {
  creativeRelativePath,
  fileMutations,
  mutatingCallIds,
  preferredWorkbenchFile,
  previewMutation,
  workbenchLabel,
  workbenchModeForPath,
  type WorkbenchMode
} from "./file-activity.js";
import { buildFileTree, type FileTreeNode } from "./file-tree.js";
import { JsonlPreview } from "./jsonl-preview.js";
import { MarkdownPreview } from "./markdown-preview.js";
import {
  creatorDocumentPaths,
  episodeDirectoryForPath,
  isCreatorDocumentPath,
  parseEpisodeProduction,
  type DramaDocumentTarget,
} from "./drama-production.js";
import { DramaProductionView } from "./drama-production-view.js";
import { createPendingJob, mediaTargetFromPath, type CanvasPoint, type ProductionJob, type ProductionMediaVersion, type ProductionQueueEntry, type ProductionSequenceItem } from "./production-runtime.js";
import type { SettledProductionIntent } from "./production-intents.js";
import { VideoStudio } from "./video-studio.js";
import {
  readWorkbenchLayoutRaw,
  workbenchPreferenceStorage,
  writeWorkbenchLayoutRaw,
  writeWorkbenchPreference,
  type WorkbenchPreference
} from "./workbench-presence.js";
import { endpoint, handleTabKey, isLayoutRecord, readFeatureEnabled } from "./workbench-ui.js";
import { EmptyStateOnboarding } from "./empty-state-onboarding.js";
import styles from "./plugin.css?inline";
import { getFileViewersSnapshot, matchFileViewer, subscribeFileViewers, workbenchFeatures } from "./features/registry.js";
import type { FileViewerDescriptor } from "./features/registry.js";
import { SplitPaneView } from "./layout/split-pane.js";
import { clampFloatGeometry, defaultFloatGeometry, FreeWindow, type FloatGeometry, type PartialFloatGeometry } from "./layout/free-window.js";
import {
  defaultSplitTree,
  EDITOR_LEAF_ID,
  sanitizeSplit,
  setFraction,
  TREE_LEAF_ID,
} from "./layout/split-tree.js";
import { settingsBridge } from "./layout/layout-settings.js";
import {
  GROUP_ORDER,
  WORKBENCH_MODES,
  EDITOR_MODES,
  GAME_FLOAT_ID,
  VIDEO_FLOAT_ID,
  json,
  WorkspaceRequestError,
  groupForPath,
  type WorkbenchMemory,
  type WorkspacePayload,
  type WorkspaceFile,
  type FilePayload,
  type FileBuffer
} from "./workbench-state.js";
import { GameStudio, FloatMirror } from "./game-studio.js";
import type { WorkbenchSlotProps } from "./workbench-bridge.js";

export function FileTreeNodes({
  nodes,
  depth,
  expanded,
  selected,
  activityPath,
  onToggle,
  onSelect
}: {
  readonly nodes: readonly FileTreeNode[];
  readonly depth: number;
  readonly expanded: Readonly<Record<string, boolean>>;
  readonly selected: string | undefined;
  readonly activityPath: string | undefined;
  readonly onToggle: (path: string, open: boolean) => void;
  readonly onSelect: (path: string) => void;
}) {
  return <>{nodes.map((node) => {
    if (node.kind === "file") return <button
      type="button"
      key={node.path}
      style={{ "--oh-story-indent": `${String(depth * 14)}px` } as CSSProperties}
      title={node.path}
      aria-label={node.path}
      data-file-path={node.path}
      data-agent-target={node.path === activityPath || undefined}
      aria-current={node.path === selected ? "page" : undefined}
      onClick={() => { onSelect(node.path); }}
    >{node.name}</button>;
    const open = selected?.startsWith(`${node.path}/`) === true || expanded[node.path] === true;
    return <details className="oh-story-file-folder" key={node.path} open={open} onToggle={(event) => { onToggle(node.path, event.currentTarget.open); }}>
      <summary style={{ "--oh-story-indent": `${String(depth * 14)}px` } as CSSProperties} title={node.path}>{node.name}<span>{node.fileCount}</span></summary>
      <FileTreeNodes
        nodes={node.children}
        depth={depth + 1}
        expanded={expanded}
        selected={selected}
        activityPath={activityPath}
        onToggle={onToggle}
        onSelect={onSelect}
      />
    </details>;
  })}</>;
}

export function FileViewerHost({ viewer, sessionId, path, content, onClose }: {
  readonly viewer: FileViewerDescriptor;
  readonly sessionId: string;
  readonly path: string;
  readonly content: string;
  readonly onClose: () => void;
}) {
  const Viewer = viewer.component;
  return <Viewer sessionId={sessionId} path={path} content={content} onClose={onClose} />;
}

export function CreativeWorkbench({
  sessionId,
  runningCalls,
  partial,
  settledMutation,
  sessionRunning,
  productionQueue,
  productionIntents,
  sendProductionPrompt,
  cancelProduction,
  removeQueuedProduction,
  workspace,
  error,
  workspaceLoading,
  reload,
  open,
  creativeProject,
  useStore,
  actions
}: {
  readonly sessionId: string;
  readonly runningCalls: readonly RunningToolCall[];
  readonly partial: PartialAssistant | null;
  readonly settledMutation: string | undefined;
  readonly sessionRunning: boolean;
  readonly productionQueue: readonly ProductionQueueEntry[];
  readonly productionIntents: readonly SettledProductionIntent[];
  readonly workspace: WorkspacePayload | undefined;
  readonly error: string | undefined;
  readonly workspaceLoading: boolean;
  readonly reload: () => void;
  readonly open: boolean;
  readonly creativeProject: boolean;
} & Pick<WorkbenchSlotProps, "useStore" | "actions" | "sendProductionPrompt" | "cancelProduction" | "removeQueuedProduction">) {
  const activities = useMemo(
    () => fileMutations(runningCalls, partial),
    [partial, runningCalls]
  );
  const normalizedActivities = useMemo(() => activities.flatMap((activity) => {
    const path = creativeRelativePath(activity.path, workspace?.cwd, workspace?.bookDirectories);
    return path === undefined ? [] : [{ activity, path }];
  }), [activities, workspace?.cwd, workspace?.bookDirectories]);
  const primaryActivity = normalizedActivities.at(-1);
  const activityPaths = useMemo(() => new Set(normalizedActivities.map((value) => value.path)), [normalizedActivities]);
  const activity = primaryActivity?.activity;
  const activityPath = primaryActivity?.path;
  const workbench = useStore((memory) => memory.workbench);
  const setWorkbench = actions.setWorkbench;
  const gameTab = useStore((memory) => memory.gameTab);
  const setGameTab = actions.setGameTab;
  const gameProjectId = useStore((memory) => memory.gameProjectId);
  const setGameProjectId = actions.setGameProjectId;
  const gamePane = useStore((memory) => memory.gamePane);
  const setGamePane = actions.setGamePane;
  const videoTab = useStore((memory) => memory.videoTab);
  const setVideoTab = actions.setVideoTab;
  const videoProjectId = useStore((memory) => memory.videoProjectId);
  const setVideoProjectId = actions.setVideoProjectId;
  const videoPane = useStore((memory) => memory.videoPane);
  const setVideoPane = actions.setVideoPane;
  const selected = useStore((memory) => memory.selected);
  const setSelected = actions.setSelected;
  const buffers = useStore((memory) => memory.buffers);
  const setBuffers = actions.setBuffers;
  const buffersRef = useRef<Record<string, FileBuffer>>({});
  const expanded = useStore((memory) => memory.expanded);
  const setExpanded = actions.setExpanded;
  const productionSection = useStore((memory) => memory.productionSection);
  const setProductionSection = actions.setProductionSection;
  const productionSelectedIds = useStore((memory) => memory.productionSelectedIds);
  const productionJobsByEpisode = useStore((memory) => memory.productionJobs);
  const productionSelectionsByEpisode = useStore((memory) => memory.productionSelections);
  const productionReferencesByEpisode = useStore((memory) => memory.productionReferences);
  const productionSequenceByEpisode = useStore((memory) => memory.productionSequence);
  const productionCanvasByEpisode = useStore((memory) => memory.productionCanvas);
  const productionZoomByEpisode = useStore((memory) => memory.productionZoom);
  const productionIntentCalls = useStore((memory) => memory.productionIntentCalls);
  const featurePane = useStore((memory) => memory.featurePane);
  const setFeaturePane = actions.setFeaturePane;
  const splitTree = useStore((memory) => memory.splitTree);
  const setSplitTree = actions.setSplitTree;
  const setFloat = actions.setFloat;
  const floats = useStore((memory) => memory.floats);
  const setFloats = actions.setFloats;
  const surfaceRef = useRef<HTMLDivElement>(null);
  const setWorkbenchPreference = actions.setWorkbenchPreference;
  const applyWorkbenchPreference = useCallback((preference: WorkbenchPreference): void => {
    setWorkbenchPreference(preference);
    writeWorkbenchPreference(workbenchPreferenceStorage(), workspace?.cwd, preference);
  }, [setWorkbenchPreference, workspace?.cwd]);
  const compactTabsId = useId();
  const compactStudioId = `${compactTabsId}-studio-panel`;
  const compactVideoStudioId = `${compactTabsId}-video-studio-panel`;
  const compactChatId = `${compactTabsId}-chat-panel`;
  const navRef = useRef<HTMLElement>(null);
  const activityBases = useRef(new Map<string, { readonly path: string; readonly base: string }>());
  const previousSignals = useRef<ReadonlySet<string>>(new Set());
  const previousSettledMutation = useRef(settledMutation);
  const saveLocks = useRef(new Set<string>());
  const buffer = selected === undefined ? undefined : buffers[selected];
  const selectedFile = workspace?.files.find((file) => file.path === selected);
  const selectedMedia = selectedFile?.kind === "media";
  const dirty = buffer?.source === "human" && buffer.content !== buffer.saved;
  const saving = buffer?.saving === true;
  const fileError = buffer?.error;
  const conflict = buffer?.conflict;
  const selectedLower = selected?.toLocaleLowerCase();
  const markdown = selectedLower?.endsWith(".md") === true;
  const jsonl = selectedLower?.endsWith(".jsonl") === true;
  const structured = jsonl || selectedLower?.endsWith(".json") === true;
  const previewable = markdown || jsonl;
  const episodeDirectory = episodeDirectoryForPath(selected);
  const productionAvailable = selected !== undefined && isCreatorDocumentPath(selected) && episodeDirectory !== undefined;
  const editorModes = productionAvailable ? EDITOR_MODES : EDITOR_MODES.filter((mode) => mode !== "production");
  // File-viewer registry (D1): the snapshot re-renders the editor when viewers register/unregister.
  const fileViewerRevision = useSyncExternalStore(subscribeFileViewers, getFileViewersSnapshot);
  const selectedViewer = useMemo(
    () => selected === undefined || selectedMedia ? undefined : matchFileViewer(selected, "text"),
    [fileViewerRevision, selected, selectedMedia]
  );
  const visibleEditorModes = selectedViewer === undefined ? editorModes : [...editorModes, "view" as const];
  const episodeDocumentPaths = useMemo(
    () => episodeDirectory === undefined ? [] : creatorDocumentPaths(workspace?.files.filter((file) => file.kind === "text") ?? [], episodeDirectory),
    [episodeDirectory, workspace?.files]
  );
  const episodeDocuments = useMemo(() => Object.fromEntries(episodeDocumentPaths.flatMap((path) => {
    const current = buffers[path];
    return current === undefined || current.missing === true ? [] : [[path, current.content] as const];
  })), [buffers, episodeDocumentPaths]);
  const episodeVoiceoverFiles = useMemo(
    () => (workspace?.files ?? []).filter((file) => file.kind === "media" && file.mimeType?.startsWith("audio/") === true),
    [workspace?.files]
  );
  const episodeProduction = useMemo(
    () => episodeDirectory === undefined ? undefined : parseEpisodeProduction(episodeDocuments, episodeDirectory, episodeVoiceoverFiles),
    [episodeDirectory, episodeDocuments, episodeVoiceoverFiles]
  );
  // 审查文档按 EP 精确命名(审查/<EP>-审查.md);存在但未打开时 content 为 undefined,
  // 徽标如实提示"未加载"而不猜结论。
  const episodeName = episodeDirectory === undefined ? undefined : episodeDirectory.split("/").at(-1);
  const reviewDocument = useMemo(() => {
    if (episodeName === undefined) return undefined;
    const path = (workspace?.files ?? []).find((file) => file.kind === "text" && file.path === `审查/${episodeName}-审查.md`)?.path;
    if (path === undefined) return undefined;
    return { path, content: buffers[path]?.missing === true ? undefined : buffers[path]?.content };
  }, [buffers, episodeName, workspace?.files]);
  const productionLibrary = useMemo(() => (workspace?.files ?? []).flatMap((file): ProductionMediaVersion[] => {
    if (file.kind !== "media") return [];
    // 音频(配音/配乐产物)进生产库:music 产量行与播放器都靠它;游戏 audio 在
    // game-adaptations/ 下,被 剧集/交付 前缀过滤自然排除。
    if (!file.path.startsWith("剧集/") && !file.path.startsWith("交付/")) return [];
    const targetId = file.path.toLocaleUpperCase().match(/(?:SHOT|IMG|MOTION|VISUAL)-[A-Z0-9-]+/u)?.[0] ?? file.path.split("/").at(-2) ?? "PROJECT-MEDIA";
    return [{
      id: `workspace:${file.path}:${file.version}`,
      targetId,
      kind: file.mimeType?.startsWith("image/") === true ? "image"
        : file.mimeType?.startsWith("audio/") === true ? "audio" : "video",
      url: endpoint("media", sessionId, file.path),
      path: file.path
    }];
  }), [sessionId, workspace?.files]);
  const productionVersions = useMemo(() => {
    if (episodeProduction === undefined) return [];
    const episodeName = episodeProduction.episodeDirectory.split("/").at(-1) ?? "";
    const knownTargets = [
      ...episodeProduction.shots.map((shot) => shot.id),
      ...episodeProduction.assets.map((asset) => asset.id),
      ...episodeProduction.visualAssets.map((asset) => asset.id),
      ...episodeProduction.motions.map((motion) => motion.id)
    ].sort((left, right) => right.length - left.length);
    const motionTargets = new Map(episodeProduction.motions.flatMap((motion) => motion.shotId === undefined ? [] : [[motion.id, motion.shotId] as const]));
    const fromWorkspace = productionLibrary.flatMap((version) => {
      if (version.path === undefined || (!version.path.startsWith(`${episodeProduction.episodeDirectory}/`) && !version.path.startsWith(`交付/${episodeName}/`))) return [];
      const matched = mediaTargetFromPath(version.path, knownTargets);
      const composition = /(?:^|\/)成片-[^/]+\.mp4$/iu.test(version.path);
      if (matched === undefined && !composition) return [];
      const targetId = matched === undefined ? episodeProduction.episodeDirectory : motionTargets.get(matched) ?? matched;
      return [{ ...version, targetId }];
    });
    const byId = new Map<string, ProductionMediaVersion>();
    for (const version of fromWorkspace) byId.set(version.id, version);
    return [...byId.values()];
  }, [episodeProduction, productionLibrary]);
  const productionSelectedId = episodeDirectory === undefined ? undefined : productionSelectedIds[episodeDirectory];
  const productionJobs = episodeDirectory === undefined ? [] : productionJobsByEpisode[episodeDirectory] ?? [];
  const productionSelections = episodeDirectory === undefined ? {} : productionSelectionsByEpisode[episodeDirectory] ?? {};
  const productionReferences = episodeDirectory === undefined ? {} : productionReferencesByEpisode[episodeDirectory] ?? {};
  const productionSequence = episodeDirectory === undefined ? [] : productionSequenceByEpisode[episodeDirectory] ?? [];
  const productionCanvas = episodeDirectory === undefined ? {} : productionCanvasByEpisode[episodeDirectory] ?? {};
  const productionZoom = episodeDirectory === undefined ? .65 : productionZoomByEpisode[episodeDirectory] ?? .65;
  const setProductionSelectedId = useCallback((selectedId: string | undefined) => {
    if (episodeDirectory !== undefined) actions.setProductionSelectedIds((current) => ({ ...current, [episodeDirectory]: selectedId }));
  }, [actions, episodeDirectory]);
  const setProductionJobs = useCallback((jobs: ProductionJob[]) => {
    if (episodeDirectory !== undefined) actions.setProductionJobs((current) => ({ ...current, [episodeDirectory]: jobs }));
  }, [actions, episodeDirectory]);
  const setProductionSelections = useCallback((selections: Record<string, string>) => {
    if (episodeDirectory !== undefined) actions.setProductionSelections((current) => ({ ...current, [episodeDirectory]: selections }));
  }, [actions, episodeDirectory]);
  const setProductionReferences = useCallback((references: Record<string, string[]>) => {
    if (episodeDirectory !== undefined) actions.setProductionReferences((current) => ({ ...current, [episodeDirectory]: references }));
  }, [actions, episodeDirectory]);
  const setProductionSequence = useCallback((sequence: ProductionSequenceItem[]) => {
    if (episodeDirectory !== undefined) actions.setProductionSequence((current) => ({ ...current, [episodeDirectory]: sequence }));
  }, [actions, episodeDirectory]);
  const setProductionCanvas = useCallback((canvas: Record<string, CanvasPoint>) => {
    if (episodeDirectory !== undefined) actions.setProductionCanvas((current) => ({ ...current, [episodeDirectory]: canvas }));
  }, [actions, episodeDirectory]);
  const setProductionZoom = useCallback((zoom: number) => {
    if (episodeDirectory !== undefined) actions.setProductionZoom((current) => ({ ...current, [episodeDirectory]: zoom }));
  }, [actions, episodeDirectory]);
  const editorMode = useStore((memory) => memory.editorMode);
  const setEditorMode = actions.setEditorMode;
  const modeSelection = useRef(selected);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const editorPositions = useRef(new Map<string, { readonly scrollTop: number; readonly selectionStart: number; readonly selectionEnd: number }>());
  const editorReady = buffer !== undefined && buffer.missing !== true;
  const workspaceKind = workbench === "game" || workbench === "video" ? undefined : workbench;
  const featureList = useMemo(() => {
    if (workspaceKind === undefined) return [];
    let storage: { getItem: (key: string) => string | null } | undefined;
    try {
      const raw = globalThis.localStorage;
      storage = raw === undefined || raw === null ? undefined : raw;
    } catch { storage = undefined; }
    const active = storage;
    // The settings panel owns the toggles; the registry itself stays read-only.
    return workbenchFeatures().filter((feature) => feature.workbenches.includes(workspaceKind) && readFeatureEnabled(active, feature.id));
  }, [workspaceKind, featurePane]);
  const gameBuilding = normalizedActivities.some(({ path }) => path.startsWith("game-adaptations/"));
  const videoBuilding = normalizedActivities.some(({ path }) => path.startsWith("video-recaps/"));

  // Phase C layout restore (session isolated) + debounced persist. The DSH
  // Session Store is not persisted, so localStorage stays the authority and
  // the store mirrors it for this session.
  const appliedLayoutSession = useRef<string>();
  useEffect(() => {
    if (appliedLayoutSession.current === sessionId) return;
    appliedLayoutSession.current = sessionId;
    const raw = readWorkbenchLayoutRaw(workbenchPreferenceStorage(), sessionId);
    if (raw === undefined) {
      setSplitTree(defaultSplitTree());
      setFloats({});
      return;
    }
    try {
      const parsed = JSON.parse(raw) as { readonly split?: unknown; readonly floats?: Readonly<Record<string, unknown>> };
      setSplitTree(sanitizeSplit(parsed.split));
      const view = { width: globalThis.innerWidth, height: globalThis.innerHeight };
      const entries = isLayoutRecord(parsed.floats) ? parsed.floats : {};
      const next: Record<string, FloatGeometry> = {};
      for (const [panelId, geometry] of Object.entries(entries)) {
        if (!isLayoutRecord(geometry)) continue;
        const partial: PartialFloatGeometry = {
          x: typeof geometry.x === "number" ? geometry.x : undefined,
          y: typeof geometry.y === "number" ? geometry.y : undefined,
          width: typeof geometry.width === "number" ? geometry.width : undefined,
          height: typeof geometry.height === "number" ? geometry.height : undefined
        };
        next[panelId] = clampFloatGeometry(partial, view);
      }
      setFloats(next);
    } catch {
      setSplitTree(defaultSplitTree());
      setFloats({});
    }
  }, [sessionId, setFloats, setSplitTree]);

  const persistTimer = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (appliedLayoutSession.current !== sessionId) return;
    globalThis.clearTimeout(persistTimer.current);
    persistTimer.current = globalThis.setTimeout(() => {
      writeWorkbenchLayoutRaw(workbenchPreferenceStorage(), sessionId, JSON.stringify({ split: splitTree, floats }));
    }, 200);
    return () => { globalThis.clearTimeout(persistTimer.current); };
  }, [sessionId, splitTree, floats]);

  const resetLayout = useCallback(() => {
    setSplitTree(defaultSplitTree());
    setFloats({});
  }, [setFloats, setSplitTree]);

  const toggleStudioFloat = useCallback((panelId: string) => {
    const current = floats[panelId];
    setFloat(panelId, current === undefined
      ? defaultFloatGeometry({ width: globalThis.innerWidth, height: globalThis.innerHeight })
      : undefined);
  }, [floats, setFloat]);

  useEffect(() => {
    settingsBridge.current = {
      layoutReset: resetLayout,
      workbenchOpen: open,
      onWorkbenchPreference: applyWorkbenchPreference,
      cwd: workspace?.cwd
    };
  });

  useEffect(() => { buffersRef.current = buffers; }, [buffers]);

  const rememberEditorPosition = useCallback((): void => {
    const element = textareaRef.current;
    if (element === null || selected === undefined || element.getAttribute("aria-label") !== selected) return;
    editorPositions.current.set(selected, {
      scrollTop: element.scrollTop,
      selectionStart: element.selectionStart,
      selectionEnd: element.selectionEnd
    });
  }, [selected]);

  useLayoutEffect(() => {
    if (editorMode !== "source" || selected === undefined || !editorReady) return;
    const element = textareaRef.current;
    const position = editorPositions.current.get(selected);
    if (element === null || position === undefined) return;
    const end = Math.min(position.selectionEnd, element.value.length);
    element.setSelectionRange(Math.min(position.selectionStart, end), end);
    element.scrollTop = position.scrollTop;
  }, [editorMode, editorReady, selected]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent): void => {
      if (!Object.values(buffersRef.current).some((value) => value.source === "human" && value.content !== value.saved)) return;
      event.preventDefault();
    };
    globalThis.addEventListener("beforeunload", warn);
    return () => { globalThis.removeEventListener("beforeunload", warn); };
  }, []);

  const expandPath = useCallback((path: string): void => {
    const segments = path.split("/");
    const ancestors = [groupForPath(path)];
    for (let index = 1; index < segments.length - 1; index += 1) ancestors.push(segments.slice(0, index + 1).join("/"));
    setExpanded((current) => {
      const next = { ...current };
      for (const ancestor of ancestors) next[ancestor] = true;
      return next;
    });
  }, []);

  const revealPath = useCallback((path: string): void => {
    rememberEditorPosition();
    const nextWorkbench = workbenchModeForPath(path, workspace?.bookDirectories) ?? "story";
    setWorkbench(nextWorkbench);
    if (nextWorkbench === "game" && !path.includes("/build/app/")) setGameTab("design");
    setSelected(path);
    expandPath(path);
  }, [expandPath, rememberEditorPosition, workspace?.bookDirectories]);

  // Feature panels (search, history, ...) ask for a file to be opened at a line and
  // character offset. The editor applies the remembered position once the buffer loads.
  const revealFeatureTarget = useCallback((path: string, line: number, offset: number): void => {
    rememberEditorPosition();
    editorPositions.current.set(path, {
      scrollTop: Math.max(0, (line - 1) * 28 - 72),
      selectionStart: offset,
      selectionEnd: offset
    });
    modeSelection.current = path;
    revealPath(path);
    setEditorMode("source");
  }, [rememberEditorPosition, revealPath]);

  useEffect(() => {
    if (workspace === undefined) return;
    const pending = productionIntents.filter(({ callId }) => productionIntentCalls[callId] !== true);
    if (pending.length === 0) return;
    for (const { intent } of pending) {
      if (intent.action === "open_section" || intent.action === "focus_target") {
        const documentPath = ["分镜.md", "图片提示词.md", "视觉设定.md", "剧本.md", "视频提示词.md"]
          .map((name) => `${intent.episode}/${name}`)
          .find((path) => workspace.files.some((file) => file.path === path));
        if (documentPath !== undefined) {
          setWorkbench("drama");
          setSelected(documentPath);
          expandPath(documentPath);
          globalThis.setTimeout(() => { setEditorMode("production"); }, 0);
        }
      }
      if (intent.action === "open_section") setProductionSection(intent.section ?? "shots");
      else if (intent.action === "focus_target") {
        actions.setProductionSelectedIds((current) => ({ ...current, [intent.episode]: intent.targetId }));
        setProductionSection(intent.section ?? (intent.targetId?.startsWith("SHOT-") === true ? "shots" : "assets"));
      } else if (intent.action === "set_sequence") {
        actions.setProductionSequence((current) => ({
          ...current,
          [intent.episode]: (intent.shotIds ?? []).map((shotId) => ({ shotId }))
        }));
      } else if (intent.action === "track_job" && intent.jobId !== undefined && intent.targetId !== undefined && intent.jobKind !== undefined) {
        const { jobId, targetId, jobKind } = intent;
        // 有 outputs 时数量以列表长度为准:旧任务重 track 补文件名也同步修正数量。
        const declaredOutputs = intent.outputs !== undefined && intent.outputs.length > 0 ? [...intent.outputs] : undefined;
        const declaredCount = declaredOutputs?.length;
        actions.setProductionJobs((current) => {
          const jobs = current[intent.episode] ?? [];
          if (jobs.some((job) => job.id === jobId)) {
            return {
              ...current,
              [intent.episode]: jobs.map((job) => job.id === jobId ? {
                ...job,
                targetId,
                kind: jobKind,
                status: "running",
                progress: Math.max(10, job.progress),
                prompt: intent.prompt ?? job.prompt,
                ...(declaredOutputs === undefined ? {} : { outputs: declaredOutputs }),
                expectedOutputs: declaredCount ?? intent.expectedOutputs ?? job.expectedOutputs,
                error: undefined
              } : job)
            };
          }
          return {
            ...current,
            [intent.episode]: [...jobs, {
              ...createPendingJob({
                id: jobId,
                targetId,
                kind: jobKind,
                prompt: intent.prompt ?? "",
                expectedOutputs: intent.expectedOutputs,
                ...(declaredOutputs === undefined ? {} : { outputs: declaredOutputs })
              }),
              status: "running",
              progress: 10
            }]
          };
        });
      }
    }
    actions.setProductionIntentCalls((current) => ({
      ...current,
      ...Object.fromEntries(pending.map(({ callId }) => [callId, true]))
    }));
  }, [actions, expandPath, productionIntentCalls, productionIntents, setEditorMode, setProductionSection, setSelected, setWorkbench, workspace]);

  // Latch first entry into the game workbench: before that the Studio must not mount, or every
  // session downloads and runs the bundled example in a display:none iframe. Once mounted it
  // stays mounted so the running game survives later navigation.
  const openedGame = useRef(false);
  if (workbench === "game") openedGame.current = true;
  const gameStudioMounted = openedGame.current;
  const openedVideo = useRef(false);
  if (workbench === "video") openedVideo.current = true;
  const videoStudioMounted = openedVideo.current;

  const followAgentPath = useCallback((path: string): void => {
    expandPath(path);
    const current = selected === undefined ? undefined : buffersRef.current[selected];
    const preserveFocusedDraft = path !== selected
      && current?.source === "human"
      && current.content !== current.saved
      && surfaceRef.current?.ownerDocument.activeElement === textareaRef.current;
    if (preserveFocusedDraft) return;
    // The editor textarea is not mounted in the Game Studio, so the draft guard above can never
    // fire there. Never preempt a running game: agent writes may expand the tree, not navigate.
    if ((workbench === "game" && gameTab === "preview") || (workbench === "video" && videoTab === "preview")) return;
    revealPath(path);
  }, [expandPath, gameTab, revealPath, selected, videoTab, workbench]);

  useEffect(() => {
    if (activityPath !== undefined && activityPath === selected && !selectedMedia) setEditorMode("source");
  }, [activityPath, selected, selectedMedia]);

  useEffect(() => {
    if (modeSelection.current === selected) return;
    modeSelection.current = selected;
    setEditorMode(selected !== undefined && activityPaths.has(selected) ? "source" : selectedMedia || previewable ? "preview" : "source");
  }, [activityPaths, previewable, selected, selectedMedia]);

  // A newly selected file may match a different viewer; never strand the editor on "view".
  useEffect(() => {
    if (selectedViewer === undefined && editorMode === "view") setEditorMode("preview");
  }, [editorMode, selectedViewer]);

  useEffect(() => {
    if (workspaceLoading) return;
    if (activityPath !== undefined) return;
    if (selected !== undefined && (
      (workspace?.files.some((file) => file.path === selected) ?? false)
      || buffers[selected] !== undefined
    ) && workbenchModeForPath(selected, workspace?.bookDirectories) === workbench) return;
    setSelected(workspace === undefined ? undefined : preferredWorkbenchFile(workspace.files, workbench, workspace.bookDirectories));
  }, [activityPath, buffers, selected, workbench, workspace, workspaceLoading]);

  useEffect(() => {
    if (workspace === undefined || workspaceLoading) return;
    const paths = new Set(workspace.files.map((file) => file.path));
    setBuffers((current) => {
      let changed = false;
      const next = { ...current };
      for (const [path, value] of Object.entries(current)) {
        if (paths.has(path) || activityPaths.has(path)) continue;
        if (value.source === "human" && value.content !== value.saved) {
          if (value.missing !== true) {
            next[path] = { ...value, missing: true, error: "文件已从 workspace 移除。本地草稿仍保留，可复制后放弃草稿。" };
            changed = true;
          }
        } else {
          delete next[path];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [activityPaths, workspace, workspaceLoading]);

  useEffect(() => {
    if (selected === undefined || selectedMedia || activityPaths.has(selected)) return;
    if (!(workspace?.files.some((file) => file.path === selected) ?? false)) return;
    const controller = new AbortController();
    setBuffers((current) => {
      const existing = current[selected];
      return existing === undefined ? current : { ...current, [selected]: { ...existing, error: undefined } };
    });
    void fetch(endpoint("file", sessionId, selected), { signal: controller.signal })
      .then((response) => json<FilePayload>(response))
      .then((file) => {
        setBuffers((current) => {
          const existing = current[file.path];
          if (existing?.source === "human" && existing.content !== existing.saved) {
            if (existing.version === file.version) return { ...current, [file.path]: { ...existing, missing: false, error: undefined } };
            return {
              ...current,
              [file.path]: {
                ...existing,
                missing: false,
                error: undefined,
                conflict: {
                  message: `${file.path} 已在磁盘上更新；你的本地草稿没有被覆盖。`,
                  theirs: file.content,
                  theirsVersion: file.version
                }
              }
            };
          }
          return {
            ...current,
            [file.path]: { content: file.content, saved: file.content, source: "disk", version: file.version }
          };
        });
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setBuffers((current) => {
          const existing = current[selected];
          return existing === undefined ? current : {
            ...current,
            [selected]: { ...existing, error: reason instanceof Error ? reason.message : String(reason) }
          };
        });
      });
    return () => { controller.abort(); };
  }, [activityPaths, selected, selectedMedia, sessionId, workspace?.files]);

  useEffect(() => {
    if (!productionAvailable) return;
    const missing = episodeDocumentPaths.filter((path) => buffersRef.current[path] === undefined && !activityPaths.has(path));
    if (missing.length === 0) return;
    const controller = new AbortController();
    void Promise.all(missing.map((path) => fetch(endpoint("file", sessionId, path), { signal: controller.signal }).then((response) => json<FilePayload>(response))))
      .then((files) => {
        setBuffers((current) => {
          const next = { ...current };
          for (const file of files) {
            const existing = next[file.path];
            if (existing?.source === "human" && existing.content !== existing.saved) continue;
            next[file.path] = { content: file.content, saved: file.content, source: "disk", version: file.version };
          }
          return next;
        });
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setBuffers((current) => {
            const next = { ...current };
            for (const path of missing) {
              const existing = next[path];
              if (existing !== undefined) next[path] = { ...existing, error: reason instanceof Error ? reason.message : String(reason) };
            }
            return next;
          });
        }
      });
    return () => { controller.abort(); };
  }, [activityPaths, episodeDocumentPaths, productionAvailable, sessionId]);

  useEffect(() => {
    if (normalizedActivities.length === 0) return;
    for (const { path } of normalizedActivities) expandPath(path);
    if (activityPath !== undefined) followAgentPath(activityPath);
    setBuffers((current) => {
      let next = current;
      for (const { activity: currentActivity, path } of normalizedActivities) {
        const existing = next[path];
        if (existing?.source === "human" && existing.content !== existing.saved) {
          next = {
            ...next,
            [path]: {
              ...existing,
              conflict: { message: `${path} 正由 Agent 修改；你的本地草稿已锁定，不会被覆盖。` }
            }
          };
          continue;
        }
        let basis = activityBases.current.get(currentActivity.callId);
        if (basis === undefined || basis.path !== path) {
          basis = { path, base: existing?.content ?? "" };
          activityBases.current.set(currentActivity.callId, basis);
        }
        const preview = previewMutation(currentActivity, basis.base);
        if (preview === undefined || (existing?.source === "agent" && existing.content === preview)) continue;
        next = {
          ...next,
          [path]: {
            content: preview,
            saved: existing?.saved ?? "",
            source: "agent",
            version: existing?.version ?? ""
          }
        };
      }
      return next;
    });
  }, [activityPath, expandPath, followAgentPath, normalizedActivities]);

  useEffect(() => {
    const signals = new Set(mutatingCallIds(runningCalls));
    for (const { activity: currentActivity } of normalizedActivities) signals.add(currentActivity.callId.split(":", 1)[0] ?? currentActivity.callId);
    const settled = [...previousSignals.current].some((callId) => !signals.has(callId));
    for (const callId of activityBases.current.keys()) {
      if (!signals.has(callId.split(":", 1)[0] ?? callId)) activityBases.current.delete(callId);
    }
    previousSignals.current = signals;
    if (!settled) return;
    reload();
  }, [normalizedActivities, reload, runningCalls]);

  useEffect(() => {
    if (settledMutation === undefined || settledMutation === previousSettledMutation.current) return;
    // The signal carries an absolute path, so creativeRelativePath cannot resolve it until the
    // workspace (and its cwd) has loaded. Consuming the signal first would burn it: the effect
    // re-runs when cwd arrives, but the guard above then short-circuits and the agent's file is
    // never selected. Wait for cwd instead of dropping the follow.
    if (workspace?.cwd === undefined) return;
    previousSettledMutation.current = settledMutation;
    const path = creativeRelativePath(settledMutation.slice(settledMutation.indexOf("\0") + 1), workspace.cwd, workspace.bookDirectories);
    if (path !== undefined) followAgentPath(path);
    reload();
  }, [followAgentPath, reload, settledMutation, workspace?.cwd, workspace?.bookDirectories]);

  useEffect(() => {
    if (selected === undefined) return;
    for (const button of navRef.current?.querySelectorAll<HTMLButtonElement>("button[data-file-path]") ?? []) {
      if (button.dataset.filePath === selected) {
        button.scrollIntoView({ block: "nearest" });
        break;
      }
    }
  }, [selected]);

  useEffect(() => {
    if (!open || normalizedActivities.length > 0 || workspace === undefined) return;
    const sessionSurface = surfaceRef.current?.parentElement;
    if (sessionSurface === undefined || sessionSurface === null) return;
    const knownPaths = new Set(workspace.files.map((file) => file.path));
    const followOfficialFileLink = (event: MouseEvent): void => {
      const origin = event.target;
      if (!(origin instanceof Element)) return;
      const control = origin.closest<HTMLElement>("button, a");
      if (control === null || control.closest(".oh-story-split-surface") !== null) return;
      const candidates = [control.title, control.getAttribute("aria-label"), control.textContent];
      for (const candidate of candidates) {
        const path = creativeRelativePath(candidate?.trim().replace(/^(?:Open|打开)\s+/u, ""), workspace.cwd, workspace.bookDirectories);
        if (path === undefined || !knownPaths.has(path)) continue;
        event.preventDefault();
        event.stopPropagation();
        revealPath(path);
        break;
      }
    };
    sessionSurface.addEventListener("click", followOfficialFileLink, true);
    return () => { sessionSurface.removeEventListener("click", followOfficialFileLink, true); };
  }, [normalizedActivities.length, open, revealPath, workspace]);

  useEffect(() => {
    if (workbench !== "game" && workbench !== "video") return;
    const surface = surfaceRef.current;
    const sessionSurface = surface?.parentElement;
    const chat = Array.from(sessionSurface?.children ?? []).find((child) => child !== surface && child instanceof HTMLElement);
    if (!(chat instanceof HTMLElement)) return;
    const previous = {
      id: chat.id,
      role: chat.getAttribute("role"),
      labelledBy: chat.getAttribute("aria-labelledby")
    };
    chat.id = compactChatId;
    chat.setAttribute("role", "tabpanel");
    chat.setAttribute("aria-labelledby", `${compactTabsId}-chat-tab`);
    return () => {
      chat.id = previous.id;
      if (previous.role === null) chat.removeAttribute("role");
      else chat.setAttribute("role", previous.role);
      if (previous.labelledBy === null) chat.removeAttribute("aria-labelledby");
      else chat.setAttribute("aria-labelledby", previous.labelledBy);
    };
  }, [compactChatId, compactTabsId, workbench]);

  const savePath = useCallback(async (path: string) => {
    if (saveLocks.current.has(path)) return;
    const submitted = buffersRef.current[path];
    if (submitted === undefined || submitted.missing === true || submitted.content === submitted.saved) return;
    saveLocks.current.add(path);
    setBuffers((current) => {
      const existing = current[path];
      return existing === undefined ? current : { ...current, [path]: { ...existing, saving: true, error: undefined } };
    });
    try {
      const file = await json<FilePayload>(await fetch(endpoint("file", sessionId, path), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: submitted.content, baseVersion: submitted.version })
      }));
      setBuffers((current) => {
        const latest = current[path];
        if (latest === undefined) return current;
        const unchanged = latest.content === submitted.content;
        return {
          ...current,
          [path]: {
            content: unchanged ? file.content : latest.content,
            saved: file.content,
            source: unchanged ? "disk" : "human",
            version: file.version,
            saving: false
          }
        };
      });
      reload();
    } catch (reason) {
      if (reason instanceof WorkspaceRequestError && reason.status === 412) {
        try {
          const theirs = await json<FilePayload>(await fetch(endpoint("file", sessionId, path)));
          setBuffers((current) => {
            const latest = current[path];
            if (latest === undefined) return current;
            return {
              ...current,
              [path]: {
                ...latest,
                saving: false,
                conflict: {
                  message: `${path} 已在磁盘上更新；请选择保留哪一版。`,
                  theirs: theirs.content,
                  theirsVersion: theirs.version
                }
              }
            };
          });
        } catch (refreshError) {
          setBuffers((current) => {
            const existing = current[path];
            return existing === undefined ? current : {
              ...current,
              [path]: { ...existing, saving: false, error: refreshError instanceof Error ? refreshError.message : String(refreshError) }
            };
          });
        }
      } else {
        setBuffers((current) => {
          const existing = current[path];
          return existing === undefined ? current : {
            ...current,
            [path]: { ...existing, saving: false, error: reason instanceof Error ? reason.message : String(reason) }
          };
        });
      }
    } finally {
      saveLocks.current.delete(path);
    }
  }, [reload, sessionId]);

  useEffect(() => {
    if (!open) return;
    const saveShortcut = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLocaleLowerCase() !== "s") return;
      event.preventDefault();
      if (selected !== undefined) void savePath(selected);
    };
    globalThis.addEventListener("keydown", saveShortcut);
    return () => { globalThis.removeEventListener("keydown", saveShortcut); };
  }, [open, savePath, selected]);

  const groups = useMemo(() => {
    const value = new Map<string, WorkspaceFile[]>();
    const all = [...(workspace?.files ?? [])].filter((file) => workbenchModeForPath(file.path, workspace?.bookDirectories) === workbench);
    if (activityPath !== undefined && !all.some((file) => file.path === activityPath)) all.push({ path: activityPath, bytes: 0, version: "", kind: "text" });
    all.sort((left, right) => left.path.localeCompare(right.path, "zh-Hans-CN"));
    for (const file of all) {
      const directory = groupForPath(file.path);
      const files = value.get(directory) ?? [];
      files.push(file);
      value.set(directory, files);
    }
    const order = GROUP_ORDER[workbench];
    return [...value.entries()].sort(([left], [right]) => {
      const leftIndex = order.indexOf(left);
      const rightIndex = order.indexOf(right);
      return (leftIndex < 0 ? order.length : leftIndex) - (rightIndex < 0 ? order.length : rightIndex)
        || left.localeCompare(right, "zh-Hans-CN");
    });
  }, [activityPath, workbench, workspace]);

  const selectWorkbench = (next: WorkbenchMode): void => {
    setWorkbench(next);
    if (next === "game" || next === "video") {
      if (next === "game") setGameTab("preview");
      else setVideoTab("preview");
      setSelected(undefined);
      return;
    }
    const target = workspace === undefined ? undefined : preferredWorkbenchFile(workspace.files, next, workspace.bookDirectories);
    if (target === undefined) setSelected(undefined);
    else revealPath(target);
  };
  const selectEditorMode = (next: WorkbenchMemory["editorMode"]): void => {
    if (next === "preview") rememberEditorPosition();
    setEditorMode(next);
  };
  const navigateProductionTarget = (target: DramaDocumentTarget): void => {
    const content = buffersRef.current[target.path]?.content ?? "";
    const before = content.slice(0, target.offset);
    const approximateScrollTop = Math.max(0, before.split(/\r?\n/u).length * 28 - 96);
    editorPositions.current.set(target.path, { scrollTop: approximateScrollTop, selectionStart: target.offset, selectionEnd: target.offset });
    modeSelection.current = target.path;
    revealPath(target.path);
    setEditorMode("source");
  };
  const selectedLabel = selected ?? `在当前 DSH workspace 中选择${workbenchLabel(workbench)}文件`;
  const selectedBasename = selected?.split("/").at(-1) ?? selectedLabel;
  const selectedGroup = selected === undefined ? undefined : groupForPath(selected);
  const toggleGroup = (key: string, open: boolean): void => {
    setExpanded((current) => ({ ...current, [key]: open }));
  };
  const resolveConflict = (keepLocal: boolean): void => {
    if (selected === undefined || conflict?.theirs === undefined || conflict.theirsVersion === undefined) return;
    const theirs = conflict.theirs;
    const theirsVersion = conflict.theirsVersion;
    setBuffers((current) => {
      const existing = current[selected];
      if (existing === undefined) return current;
      return {
        ...current,
        [selected]: keepLocal
          ? { ...existing, saved: theirs, version: theirsVersion, source: "human", conflict: undefined }
          : { content: theirs, saved: theirs, source: "disk", version: theirsVersion }
      };
    });
  };

  if (!open) {
    // Without creative work there is nothing to reveal, so a failed workspace
    // request still offers the way in (that error is only readable inside the
    // workbench), an unloaded workspace stays untouched, and a confirmed-empty
    // workspace gets a lightweight onboarding panel. Loading and error behavior
    // are unchanged: null while loading, launcher when the request failed.
    if (!creativeProject && error === undefined && !workspaceLoading) {
      // 不是工作台面：无工程的会话必须保持官方布局（#29），空态入口只是浮层。
      return <div ref={surfaceRef} className="oh-story-empty-host" data-open="false">
        <style>{styles}</style>
        <EmptyStateOnboarding onCreate={sendProductionPrompt} />
      </div>;
    }
    if (!creativeProject && error === undefined) return null;
    return <div ref={surfaceRef} className="oh-story-split-surface" data-open="false">
      <style>{styles}</style>
      <button className="oh-story-launcher" type="button" title={error ?? "打开创作工作台"} aria-label="打开创作工作台" onClick={() => { applyWorkbenchPreference("open"); }}>
        <span aria-hidden>✦</span><b>创作工作台</b>
      </button>
    </div>;
  }

  return <div ref={surfaceRef} className="oh-story-split-surface" data-open="true" data-workbench={workbench}>
    <style>{styles}</style>
    {(workbench === "game" || workbench === "video") && <div className="oh-game-mobile-switcher" role="tablist" aria-label={workbench === "game" ? "窄屏游戏工作台" : "窄屏视频工作台"}>
      {(["studio", "chat"] as const).map((pane) => <button
        type="button"
        role="tab"
        key={pane}
        id={`${compactTabsId}-${pane}-tab`}
        aria-controls={pane === "chat" ? compactChatId : workbench === "game" ? compactStudioId : compactVideoStudioId}
        aria-selected={(workbench === "game" ? gamePane : videoPane) === pane}
        tabIndex={(workbench === "game" ? gamePane : videoPane) === pane ? 0 : -1}
        onKeyDown={(event) => { handleTabKey(event, ["studio", "chat"] as const, workbench === "game" ? gamePane : videoPane, workbench === "game" ? setGamePane : setVideoPane); }}
        onClick={() => { if (workbench === "game") setGamePane(pane); else setVideoPane(pane); }}
      >{pane === "studio" ? "制作" : "对话"}</button>)}
    </div>}
    {workbench === "game" && workspace === undefined && <main id={compactStudioId} className="oh-game-studio" role="tabpanel" aria-labelledby={`${compactTabsId}-studio-tab`}><div className="oh-game-design-empty">{error ?? "正在连接游戏工作台…"}</div></main>}
    {workspace !== undefined && gameStudioMounted && <GameStudio
          sessionId={sessionId}
          workspace={workspace}
          building={gameBuilding}
          selected={selected}
          gameTab={gameTab}
          gameProjectId={gameProjectId}
          hidden={workbench !== "game"}
          onGameTab={setGameTab}
          onGameProject={setGameProjectId}
          workbenches={WORKBENCH_MODES}
          paneId={compactStudioId}
          labelledBy={`${compactTabsId}-studio-tab`}
          onWorkbench={selectWorkbench}
          onCollapse={() => { applyWorkbenchPreference("closed"); }}
          onSelect={revealPath}
          floatActive={floats[GAME_FLOAT_ID] !== undefined}
          onFloatToggle={() => { toggleStudioFloat(GAME_FLOAT_ID); }}
        />}
    {floats[GAME_FLOAT_ID] !== undefined && workspace !== undefined && gameStudioMounted && workbench === "game" && (() => {
      const geometry = floats[GAME_FLOAT_ID];
      if (geometry === undefined) return null;
      return <FreeWindow
        panelId={GAME_FLOAT_ID}
        title="游戏 Studio（浮窗）"
        geometry={geometry}
        onMove={(panelId, next) => { setFloat(panelId, next); }}
        onDock={(panelId) => { setFloat(panelId, undefined); }}
      >
        <FloatMirror title={(workspace.games.find((item) => item.id === gameProjectId) ?? workspace.games[0])?.title ?? "游戏"} hint="预览在工作台原位运行；浮窗只做状态镜像。" />
      </FreeWindow>;
    })()}
    {workbench === "video" && workspace === undefined && <main id={compactVideoStudioId} className="oh-video-studio" role="tabpanel" aria-labelledby={`${compactTabsId}-studio-tab`}><div className="oh-video-preview-empty">{error ?? "正在连接视频工作台…"}</div></main>}
    {workbench === "video" && workspace !== undefined && videoStudioMounted && <button
      className="oh-video-float-entry"
      type="button"
      aria-label={floats[VIDEO_FLOAT_ID] === undefined ? "将视频 Studio 拖出为浮窗" : "将视频 Studio 放回工作台"}
      aria-pressed={floats[VIDEO_FLOAT_ID] !== undefined}
      onClick={() => { toggleStudioFloat(VIDEO_FLOAT_ID); }}
    >⧉</button>}
    {workspace !== undefined && videoStudioMounted && <VideoStudio
          sessionId={sessionId}
          projects={workspace.videos}
          running={videoBuilding}
          projectId={videoProjectId}
          tab={videoTab}
          hidden={workbench !== "video"}
          workbenches={WORKBENCH_MODES}
          paneId={compactVideoStudioId}
          labelledBy={`${compactTabsId}-studio-tab`}
          onProject={setVideoProjectId}
          onTab={setVideoTab}
          onWorkbench={selectWorkbench}
          onCollapse={() => { applyWorkbenchPreference("closed"); }}
        />}
    {floats[VIDEO_FLOAT_ID] !== undefined && workspace !== undefined && videoStudioMounted && workbench === "video" && (() => {
      const geometry = floats[VIDEO_FLOAT_ID];
      if (geometry === undefined) return null;
      return <FreeWindow
        panelId={VIDEO_FLOAT_ID}
        title="视频 Studio（浮窗）"
        geometry={geometry}
        onMove={(panelId, next) => { setFloat(panelId, next); }}
        onDock={(panelId) => { setFloat(panelId, undefined); }}
      >
        <FloatMirror title={(workspace.videos.find((item) => item.id === videoProjectId) ?? workspace.videos[0])?.title ?? "视频"} hint="播放器在工作台原位运行；浮窗只做状态镜像。" />
      </FreeWindow>;
    })()}
    {workbench !== "game" && workbench !== "video" && <>
    <SplitPaneView
      className="oh-story-split"
      tree={splitTree}
      onResize={(path, fraction) => { setSplitTree(setFraction(splitTree, path, fraction)); }}
      renderLeaf={(leafId) => {
        if (leafId === TREE_LEAF_ID) {
          return (
            <aside className="oh-story-tree" data-oh-leaf="tree">
      <div className="oh-story-brand">
        <span className="oh-story-brand-cluster"><strong>✦ <span>Oh Story</span></strong>{workspaceKind !== undefined && <span className="oh-story-kind">{workspaceKind === "story" ? "小说" : "短剧"}</span>}</span>
        <span className="oh-story-brand-actions">
          {featureList.map((feature) => <button
            key={feature.id}
            type="button"
            title={feature.label}
            aria-label={feature.label}
            aria-pressed={featurePane === feature.id}
            onClick={() => { setFeaturePane(featurePane === feature.id ? undefined : feature.id); }}
          >{feature.icon}</button>)}
          <button type="button" onClick={reload} title="刷新" aria-label="刷新项目文件">↻</button>
          <button type="button" onClick={() => { applyWorkbenchPreference("closed"); }} title="收起创作工作台" aria-label="收起创作工作台">×</button>
        </span>
      </div>
      {workspace !== undefined && <div className="oh-story-mode-tabs" role="tablist" aria-label="创作工作台">
        {WORKBENCH_MODES.map((mode) => <button
          type="button"
          role="tab"
          key={mode}
          tabIndex={workbench === mode ? 0 : -1}
          aria-selected={workbench === mode}
          onKeyDown={(event) => { handleTabKey(event, WORKBENCH_MODES, workbench, selectWorkbench); }}
          onClick={() => { selectWorkbench(mode); }}
        >{workbenchLabel(mode)}</button>)}
      </div>}
      {error !== undefined && <div className="oh-story-error">{error}</div>}
      {workspace?.metadataErrors.map((message) => <div className="oh-story-warning" key={message}>{message}</div>)}
      <nav ref={navRef} aria-label={workbench === "story" ? "小说项目文件" : "短剧项目文件"}>
        {groups.map(([directory, files]) => {
          const groupOpen = selectedGroup === directory || expanded[directory] === true;
          return <details className="oh-story-file-group" key={directory} open={groupOpen} onToggle={(event) => { toggleGroup(directory, event.currentTarget.open); }}>
            <summary>{directory}<span>{files.length}</span></summary>
            <FileTreeNodes
              nodes={buildFileTree(files, directory)}
              depth={1}
              expanded={expanded}
              selected={selected}
              activityPath={activityPath}
              onToggle={toggleGroup}
              onSelect={revealPath}
            />
          </details>;
        })}
      </nav>
            </aside>
          );
        }
        if (leafId === EDITOR_LEAF_ID) {
          return (
            <main className="oh-story-editor" data-oh-leaf="editor">
      <header>
        <span className="oh-story-editor-path" title={selected}><span>{selectedLabel}</span><strong>{selectedBasename}</strong></span>
        <div className="oh-story-editor-actions">
          {(previewable || productionAvailable || selectedViewer !== undefined) && !selectedMedia && <div className="oh-story-editor-tabs" role="tablist" aria-label={productionAvailable ? "短剧文档查看方式" : markdown ? "Markdown 查看方式" : "JSONL 查看方式"}>
            {visibleEditorModes.map((mode) => <button
              type="button"
              role="tab"
              key={mode}
              tabIndex={editorMode === mode ? 0 : -1}
              aria-selected={editorMode === mode}
              onKeyDown={(event) => { handleTabKey(event, visibleEditorModes, editorMode, selectEditorMode); }}
              onClick={() => { selectEditorMode(mode); }}
            >{mode === "preview" ? "预览" : mode === "source" ? "源码" : mode === "production" ? "生产" : selectedViewer === undefined ? "视图" : selectedViewer.label}</button>)}
          </div>}
          {(dirty || saving) && selected !== undefined && <button className="oh-story-save" type="button" disabled={saving || buffer?.missing === true} onClick={() => { void savePath(selected); }}>
            {saving ? "保存中…" : "保存"}
          </button>}
        </div>
      </header>
      {activity !== undefined && activityPath !== undefined && activityPath === selected && <div className="oh-story-stream" data-stage={activity.stage} role="status" aria-live="polite">● {activity.stage === "running" ? "Agent 正在应用修改" : "Agent 正在生成文件内容"}</div>}
      {conflict !== undefined && <div className="oh-story-conflict" role="alert">
        <span>{conflict.message}</span>
        {conflict.theirs !== undefined && conflict.theirsVersion !== undefined && selected !== undefined && <div>
          <button type="button" onClick={() => { resolveConflict(false); }}>载入磁盘版本</button>
          <button type="button" onClick={() => { resolveConflict(true); }}>保留本地草稿</button>
        </div>}
      </div>}
      {fileError !== undefined && <div className="oh-story-error">{fileError}</div>}
      {selected === undefined
        ? <div className="oh-story-editor-empty">{workbench === "story"
            ? <>当前 workspace 还没有小说文件。可在右侧 Chat 中运行 <code>/story-setup</code>。</>
            : <>当前 workspace 还没有短剧项目。可在右侧 Chat 中运行 <code>/short-drama</code>。</>}</div>
        : selectedMedia && selectedFile !== undefined
          ? <div className="oh-story-media-document">{selectedFile.mimeType?.startsWith("image/") === true
              ? <img src={endpoint("media", sessionId, selectedFile.path)} alt={selectedFile.path} />
              : selectedFile.mimeType?.startsWith("audio/") === true
                ? <audio src={endpoint("media", sessionId, selectedFile.path)} controls />
                : <video src={endpoint("media", sessionId, selectedFile.path)} controls preload="metadata" />}</div>
        : buffer === undefined
          ? <div className="oh-story-editor-empty">正在加载 {selected}…</div>
        : buffer.missing === true
          ? <div className="oh-story-editor-empty">文件已从 workspace 移除，本地草稿仍保留。请先复制需要的内容，再放弃草稿。<button type="button" onClick={() => {
            setBuffers((current) => {
              const next = { ...current };
              delete next[selected];
              return next;
            });
            setSelected(workspace === undefined ? undefined : preferredWorkbenchFile(workspace.files, workbench, workspace.bookDirectories));
          }}>放弃本地草稿</button></div>
        : editorMode === "production" && productionAvailable && episodeProduction !== undefined
          ? <DramaProductionView
              sessionId={sessionId}
              production={episodeProduction}
              reviewDocument={reviewDocument}
              sessionRunning={sessionRunning}
              queue={productionQueue}
              section={productionSection}
              selectedId={productionSelectedId}
              jobs={productionJobs}
              versions={productionVersions}
              libraryVersions={productionLibrary}
              selections={productionSelections}
              manualReferences={productionReferences}
              sequence={productionSequence}
              canvas={productionCanvas}
              zoom={productionZoom}
              onSectionChange={setProductionSection}
              onSelect={setProductionSelectedId}
              onNavigate={navigateProductionTarget}
              onJobsChange={setProductionJobs}
              onSelectionsChange={setProductionSelections}
              onManualReferencesChange={setProductionReferences}
              onOpenMedia={(path) => { revealPath(path); }}
              onSequenceChange={setProductionSequence}
              onCanvasChange={setProductionCanvas}
              onZoomChange={setProductionZoom}
              onDispatchPrompt={sendProductionPrompt}
              onCancelTurn={cancelProduction}
              onRemoveQueued={removeQueuedProduction}
              onRefresh={reload}
            />
        : editorMode === "view" && selectedViewer !== undefined && selected !== undefined
          ? <FileViewerHost viewer={selectedViewer} sessionId={sessionId} path={selected} content={buffer.content} onClose={() => { setEditorMode("preview"); }} />
        : previewable && editorMode === "preview"
          ? markdown
            ? <MarkdownPreview content={buffer.content} label={selected} />
            : <JsonlPreview content={buffer.content} label={selected} />
          : <textarea
            ref={textareaRef}
            value={buffer.content}
            data-format={structured ? "structured" : "prose"}
            onBlur={rememberEditorPosition}
            onScroll={rememberEditorPosition}
            onSelect={rememberEditorPosition}
            onChange={(event) => {
              const content = event.target.value;
              setBuffers((current) => ({
                ...current,
                [selected]: {
                  content,
                  saved: current[selected]?.saved ?? "",
                  source: "human",
                  version: current[selected]?.version ?? "",
                  conflict: current[selected]?.conflict,
                  saving: current[selected]?.saving
                }
              }));
            }}
            spellCheck={!structured}
            aria-label={selected}
          />}
            </main>
          );
        }
        return null;
      }}
    />
    {featurePane !== undefined && (() => {
      const feature = featureList.find((value) => value.id === featurePane);
      if (feature === undefined) return null;
      const Panel = feature.component;
      const panel = <Panel sessionId={sessionId} workspace={workspace} selected={selected} onReveal={revealFeatureTarget} onClose={() => { setFeaturePane(undefined); }} />;
      const geometry = floats[feature.id];
      if (geometry !== undefined) {
        return <FreeWindow
          panelId={feature.id}
          title={feature.label}
          geometry={geometry}
          onMove={(panelId, next) => { setFloat(panelId, next); }}
          onDock={(panelId) => { setFloat(panelId, undefined); }}
        >{panel}</FreeWindow>;
      }
      return <aside className="oh-feature-drawer" role="complementary" aria-label={feature.label}>
        <header className="oh-feature-drawer-header">
          <strong><span aria-hidden>{feature.icon}</span> {feature.label}</strong>
          <span className="oh-feature-drawer-actions">
            <button type="button" title="拖出为浮窗" aria-label={`将${feature.label}拖出为浮窗`} onClick={() => {
              setFloat(feature.id, defaultFloatGeometry({ width: globalThis.innerWidth, height: globalThis.innerHeight }));
            }}>⧉</button>
            <button type="button" title="关闭" aria-label={`关闭 ${feature.label}`} onClick={() => { setFeaturePane(undefined); }}>×</button>
          </span>
        </header>
        <div className="oh-feature-drawer-body">{panel}</div>
      </aside>;
    })()}
    </>}
  </div>;
}
