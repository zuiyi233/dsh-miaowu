import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type {
  AudiobookAssignment,
  AudiobookAsset,
  AudiobookAssetGenerationPreview,
  AudiobookAssetGenerationResponse,
  AudiobookAssetKind,
  AudiobookAssetView,
  AudiobookCastMember,
  AudiobookChapterSummary,
  AudiobookCostEstimate,
  AudiobookCue,
  AudiobookExportFormats,
  AudiobookExportFullResult,
  AudiobookExportPreflight,
  AudiobookJob,
  AudiobookJobStatus,
  AudiobookOverview,
  AudiobookProjectRecord,
  AudiobookProjectView,
  AudiobookScriptParseResponse,
  AudiobookScriptRecord,
  AudiobookScriptViewResponse,
  AudiobookSegment,
} from "../../services/audiobook-contract.js";
import { endpoint } from "../workbench-ui.js";
import { registerWorkbenchFeature, type WorkbenchFeatureProps } from "./registry.js";
import diagStyles from "./diagnostics-feature.css?inline";
import styles from "./audiobook-feature.css?inline";

/**
 * 「有声剧」工作台：把章节脚本、成本预估、任务、MP3 导出，以及 N4-C 的素材/
 * cue 与完整导出收进一个面板。
 *
 * 概览/项目只读；解析、生成、导出都会产生副作用（覆盖脚本、TTS 费用、文件
 * 写入），必须经 window.confirm 显式确认。请求用递增 id 守卫，过期响应直接
 * 丢弃；任何失败都显示在面板里，绝不静默吞掉。
 */

const STYLES = `${diagStyles}\n${styles}`;
const NARRATOR_FALLBACK_VOICE = "alloy";
/** 素材生成只支持 ComfyUI，与路由 `assertGeneratableProvider` 同一约定。 */
const GENERATABLE_PROVIDER_ID = "comfyui";

/** 新 cue 的中性默认值：起点零偏移、轻量淡入淡出、配乐音量与闪避。 */
const CUE_DEFAULTS = { offsetMs: 0, fadeInMs: 300, fadeOutMs: 600, gainDb: -12, duckDb: -6 } as const;

const JOB_LABELS: Readonly<Record<AudiobookJobStatus, string>> = {
  queued: "排队中",
  running: "生成中",
  paused: "已暂停",
  failed: "失败",
  completed: "已完成",
};

export interface AudiobookDraft {
  readonly bookRoot: string;
  readonly name: string;
  readonly voice: string;
}

/** POST 与 PUT /project 都只回一份项目记录：创建与保存 cue/角色共用。 */
interface ProjectRecordResponse {
  readonly record: AudiobookProjectRecord;
}

interface JobStartResponse {
  readonly job: AudiobookJob;
  readonly estimate: AudiobookCostEstimate;
}

interface ExportResponse {
  readonly path: string;
  readonly bytes: number;
  readonly durationMs: number;
}

async function jsonOrThrow<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as T & { readonly error?: string };
  if (!response.ok) throw new Error(payload.error ?? `HTTP ${String(response.status)}`);
  return payload;
}

function postJson<T>(url: string, body: unknown): Promise<T> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(jsonOrThrow<T>);
}

function putJson<T>(url: string, body: unknown): Promise<T> {
  return fetch(url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(jsonOrThrow<T>);
}

function projectNameOf(path: string): string {
  const segments = path.split("/");
  return segments.length >= 3 ? (segments.at(-2) ?? path) : path;
}

function defaultDraft(overview: AudiobookOverview): AudiobookDraft {
  const source = overview.sources[0];
  return {
    bookRoot: source?.bookRoot ?? "",
    name: source?.name ?? "",
    voice: NARRATOR_FALLBACK_VOICE,
  };
}

function narratorVoiceOf(record: AudiobookProjectRecord): string {
  return record.project.cast.find((member) => member.kind === "narrator")?.voice ?? NARRATOR_FALLBACK_VOICE;
}

function formatCost(value: number): string {
  return `¥${value.toFixed(6)}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function scriptStateOf(chapter: AudiobookChapterSummary): string {
  if (chapter.scriptError !== undefined) return "脚本损坏";
  return chapter.hasScript ? "已解析" : "未解析";
}

/** 素材/ cue 只暴露文件名：面板不渲染工作区路径，更不渲染绝对路径。 */
function fileNameOf(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function nextCueId(cues: readonly AudiobookCue[]): string {
  const used = new Set(cues.map((cue) => cue.id));
  for (let index = 1; ; index += 1) {
    const candidate = `cue-${String(index)}`;
    if (!used.has(candidate)) return candidate;
  }
}

function formatFormats(formats: AudiobookExportFormats): string {
  return EXPORT_KEYS.filter((key) => selectedFormats(formats)[key])
    .map((key) => EXPORT_LABELS[key])
    .join(" / ");
}

/** 完整导出前把格式、章节数与预估成本摆进确认框，写盘前最后一次看清范围。 */
function exportConfirmText(formats: AudiobookExportFormats, preflight: AudiobookExportPreflight): string {
  return `完整导出 ${String(preflight.chapters)} 章：${formatFormats(formats)}，预估 ${formatCost(preflight.cost.estimatedCost)}。确认？`;
}

/**
 * 解析响应 → 段数。路由返回 `{ script: AudiobookScriptRecord }`，脚本本体在
 * 记录的 `script` 字段里再嵌一层；面板曾按 `payload.script.segments` 读取，
 * 永远得到 undefined。这个纯函数把真实形状钉在测试里。
 */
export function parsedSegmentCount(payload: AudiobookScriptParseResponse): number {
  return payload.script.script.segments.length;
}

/** 生成前的确认文案：费用、请求数、缓存命中与段数都要在付费前让用户看到。 */
export function generateConfirmText(chapter: string, estimate: AudiobookCostEstimate): string {
  return `将为「${chapter}」调用 TTS 服务：共 ${String(estimate.segments)} 段，${String(estimate.requests)} 次请求（缓存命中 ${String(estimate.cacheHits)} 段），预估 ${formatCost(estimate.estimatedCost)}。确认开始生成？`;
}

export interface AudiobookSegmentsView {
  readonly chapter: string;
  readonly record: AudiobookScriptRecord;
}

const CAST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;

/** 客户端只做即时可判的校验；id 格式、保留值与服务端保持同一套规则。 */
export function castDraftValid(cast: readonly AudiobookCastMember[]): boolean {
  const narrators = cast.filter((member) => member.kind === "narrator").length;
  const ids = new Set(cast.map((member) => member.id));
  return narrators === 1
    && ids.size === cast.length
    && cast.every((member) => CAST_ID_PATTERN.test(member.id)
      && member.id !== "unknown"
      && member.name.trim() !== ""
      && member.voice.trim() !== "");
}

function nextCharacterId(cast: readonly AudiobookCastMember[]): string {
  const ids = new Set(cast.map((member) => member.id));
  for (let index = 1; ; index += 1) {
    const candidate = `role-${String(index)}`;
    if (!ids.has(candidate)) return candidate;
  }
}

interface CastEditorProps {
  readonly cast: readonly AudiobookCastMember[];
  readonly busy: boolean;
  readonly onSave?: ((cast: readonly AudiobookCastMember[]) => void) | undefined;
}

/** 角色与音色编辑器：保存整份 cast，服务端按 baseVersion 做 CAS。 */
function CastEditor({ cast, busy, onSave }: CastEditorProps): JSX.Element {
  const [draft, setDraft] = useState<readonly AudiobookCastMember[]>(cast);
  const dirty = JSON.stringify(draft) !== JSON.stringify(cast);
  const valid = castDraftValid(draft);
  const update = (index: number, patch: Partial<AudiobookCastMember>): void => {
    setDraft(draft.map((member, current) => current === index ? { ...member, ...patch } : member));
  };
  const addCharacter = (): void => {
    setDraft([...draft, { id: nextCharacterId(draft), name: "新角色", kind: "character", voice: "" }]);
  };
  const removeCharacter = (index: number): void => {
    const member = draft[index];
    if (member === undefined || member.kind === "narrator") return;
    if (!globalThis.confirm(`删除角色「${member.name}」会让引用它的对白变成未指派。确认删除？`)) return;
    setDraft(draft.filter((_, current) => current !== index));
  };
  return <Group label="有声剧角色" title="角色与音色">
    <table className="oh-audiobook-table oh-audiobook-cast">
      <thead>
        <tr><th>类型</th><th>id</th><th>显示名</th><th>音色</th><th>操作</th></tr>
      </thead>
      <tbody>
        {draft.map((member, index) => <tr key={member.id}>
          <td>{member.kind === "narrator" ? "旁白" : "角色"}</td>
          <td className="oh-audiobook-cast-id">{member.id}</td>
          <td><input
            className="oh-audiobook-cast-input"
            value={member.name}
            disabled={busy}
            onChange={(event) => { update(index, { name: event.target.value }); }}
          /></td>
          <td><input
            className="oh-audiobook-cast-input"
            value={member.voice}
            placeholder="如 alloy"
            disabled={busy}
            onChange={(event) => { update(index, { voice: event.target.value }); }}
          /></td>
          <td>{member.kind === "narrator"
            ? "—"
            : <Action text="删除" disabled={busy} onClick={() => { removeCharacter(index); }} />}</td>
        </tr>)}
      </tbody>
    </table>
    <div className="oh-audiobook-actions">
      <Action text="添加角色" disabled={busy} onClick={addCharacter} />
      <Action
        text="保存角色"
        disabled={busy || !dirty || !valid || onSave === undefined}
        onClick={() => { if (dirty && valid) onSave?.(draft); }}
      />
    </div>
    {valid ? null : <p className="oh-diag-error" role="alert">
      角色 id 必须唯一且只含字母、数字、下划线或连字符；显示名与音色不能为空；必须恰好一个旁白。
    </p>}
  </Group>;
}

interface SegmentEditorProps {
  readonly view: AudiobookSegmentsView;
  readonly cast: readonly AudiobookCastMember[];
  readonly busy: boolean;
  readonly onClose?: (() => void) | undefined;
  readonly onSave?: ((chapter: string, assignments: readonly AudiobookAssignment[]) => void) | undefined;
}

/** 章节分段指派：只把改动过的 segmentId 发给服务端，未指派段保持可见并阻止生成。 */
function SegmentEditor({ view, cast, busy, onClose, onSave }: SegmentEditorProps): JSX.Element {
  const [edits, setEdits] = useState<ReadonlyMap<string, string>>(new Map());
  const castIds = new Set(cast.map((member) => member.id));
  const assignments = view.record.script.segments
    .filter((segment) => edits.has(segment.id) && edits.get(segment.id) !== segment.speakerId)
    .map((segment) => ({ segmentId: segment.id, speakerId: edits.get(segment.id) ?? segment.speakerId }));
  const effectiveSpeaker = (segment: AudiobookScriptRecord["script"]["segments"][number]): string =>
    edits.get(segment.id) ?? segment.speakerId;
  const unassigned = view.record.script.segments.filter((segment) =>
    segment.kind === "dialogue"
    && (effectiveSpeaker(segment) === "unknown" || !castIds.has(effectiveSpeaker(segment)))).length;
  const setSpeaker = (segmentId: string, speakerId: string): void => {
    const next = new Map(edits);
    next.set(segmentId, speakerId);
    setEdits(next);
  };
  return <Group label="有声剧分段" title={`分段指派 · ${view.chapter}`}>
    <table className="oh-audiobook-table oh-audiobook-segments">
      <thead><tr><th>类型</th><th>文本</th><th>说话人</th></tr></thead>
      <tbody>
        {view.record.script.segments.map((segment) => {
          const speaker = effectiveSpeaker(segment);
          const missing = speaker !== "unknown" && !castIds.has(speaker);
          const unassignedRow = segment.kind === "dialogue" && (speaker === "unknown" || missing);
          return <tr key={segment.id} data-unassigned={unassignedRow ? "" : undefined}>
            <td>{segment.kind === "narration" ? "旁白" : "对白"}</td>
            <td className="oh-audiobook-segment-text" title={segment.text}>{segment.text}</td>
            <td>{segment.kind === "narration"
              ? "旁白"
              : <select
                className="oh-audiobook-segment-speaker"
                value={speaker}
                disabled={busy}
                onChange={(event) => { setSpeaker(segment.id, event.target.value); }}
              >
                <option value="unknown">未指派</option>
                {missing ? <option value={speaker}>已删除角色（{speaker}）</option> : null}
                {cast.map((member) => <option key={member.id} value={member.id}>
                  {member.name}{member.kind === "narrator" ? "（旁白）" : ""}
                </option>)}
              </select>}</td>
          </tr>;
        })}
      </tbody>
    </table>
    <div className="oh-audiobook-actions">
      <Action
        text="保存指派"
        disabled={busy || assignments.length === 0 || onSave === undefined}
        onClick={() => { if (assignments.length > 0) onSave?.(view.chapter, assignments); }}
      />
      {onClose === undefined ? null : <Action text="收起" disabled={busy} onClick={onClose} />}
    </div>
    {unassigned === 0
      ? null
      : <p className="oh-diag-error" role="alert">还有 {String(unassigned)} 段对白未指派说话人，整章不能生成或导出。</p>}
  </Group>;
}

/** 面板共用的小外壳：重复的 class 与属性抽成组件，省下浏览器包的 400 KB 预算。 */
function Group({ label, title, children }: {
  readonly label: string;
  readonly title: string;
  readonly children: ReactNode;
}): JSX.Element {
  return <section className="oh-diag-group" aria-label={label}>
    <h4 className="oh-diag-group-title">{title}</h4>
    {children}
  </section>;
}

function Action({ text, disabled, title, onClick }: {
  readonly text: string;
  readonly disabled: boolean;
  readonly title?: string | undefined;
  readonly onClick: () => void;
}): JSX.Element {
  return <button type="button" className="oh-diag-action" disabled={disabled} title={title} onClick={onClick}>{text}</button>;
}

/** 素材生成表单的输入；预估与写盘由容器按路由的两步（preview → confirm）执行。 */
export interface AssetGenerateInput {
  readonly kind: AudiobookAssetKind;
  readonly prompt: string;
  readonly durationSeconds: number;
  readonly count: number;
}

interface AssetPanelProps {
  readonly view: AudiobookAssetView;
  readonly cues: readonly AudiobookCue[];
  readonly chapterSegments?: readonly AudiobookSegment[] | undefined;
  readonly busy: boolean;
  readonly onSaveCue?: ((asset: AudiobookAsset, startSegment: string) => void) | undefined;
  readonly onDeleteCue?: ((cueId: string) => void) | undefined;
  readonly onSaveCues?: (() => void) | undefined;
  readonly onGenerate?: ((input: AssetGenerateInput) => void) | undefined;
}

/**
 * 素材与 cue 面板：素材只显示文件名与授权状态，未授权素材不能挂 cue；
 * cue 的增删留在本地草稿，点「保存 cue」才写回项目。
 */
export function AssetPanel({ view, cues, chapterSegments, busy, onSaveCue, onDeleteCue, onSaveCues, onGenerate }: AssetPanelProps): JSX.Element {
  const [anchor, setAnchor] = useState("");
  const [form, setForm] = useState({ kind: "music" as AudiobookAssetKind, prompt: "", durationSeconds: 4, count: 1 });
  const segments = chapterSegments ?? [];
  const start = anchor === "" ? (segments[0]?.id ?? "") : anchor;
  const generatable = view.providers.some((item) => item.id === GENERATABLE_PROVIDER_ID && item.configured);
  const set = (patch: Partial<typeof form>): void => { setForm({ ...form, ...patch }); };
  const ready = generatable
    && form.prompt.trim() !== "" && form.durationSeconds > 0 && form.count >= 1 && form.count <= 8;
  const rows = [
    ...view.assets.map((asset) => ({
      key: asset.path,
      text: `${fileNameOf(asset.path)} · ${asset.kind === "music" ? "音乐" : "音效"} · ${asset.authorized ? "已授权" : "未授权"}`,
      action: "加入 cue",
      disabled: busy || !asset.authorized,
      click: () => { onSaveCue?.(asset, start); },
    })),
    ...cues.map((cue) => ({
      key: cue.id,
      text: `cue ${fileNameOf(cue.asset)} · ${cue.startSegment}`,
      action: "移除",
      disabled: busy,
      click: () => { onDeleteCue?.(cue.id); },
    })),
  ];
  return <Group label="有声剧素材" title="音乐与音效">
    <ul className="oh-diag-guidance">
      {rows.map((row) => <li key={row.key}>{row.text}<Action text={row.action} disabled={row.disabled} onClick={row.click} /></li>)}
    </ul>
    {segments.length === 0 ? null : <select
      className="oh-audiobook-segment-speaker"
      aria-label="起点"
      value={start}
      disabled={busy}
      onChange={(event) => { setAnchor(event.target.value); }}
    >
      {segments.map((segment) => <option key={segment.id} value={segment.id}>{segment.id}</option>)}
    </select>}
    <Action text="保存 cue" disabled={busy || onSaveCues === undefined} onClick={() => { onSaveCues?.(); }} />
    <div className="oh-audiobook-create">
      <select
        aria-label="类型"
        value={form.kind}
        disabled={busy}
        onChange={(event) => { set({ kind: event.target.value === "music" ? "music" : "effect" }); }}
      >
        <option value="music">音乐</option>
        <option value="effect">音效</option>
      </select>
      <input aria-label="提示词" value={form.prompt} disabled={busy} onChange={(event) => { set({ prompt: event.target.value }); }} />
      <input aria-label="秒" type="number" value={form.durationSeconds} disabled={busy} onChange={(event) => { set({ durationSeconds: Number(event.target.value) }); }} />
      <input aria-label="数量" type="number" value={form.count} disabled={busy} onChange={(event) => { set({ count: Number(event.target.value) }); }} />
      <Action
        text="生成素材"
        disabled={busy || !ready}
        onClick={() => { if (onGenerate !== undefined) onGenerate({ ...form, prompt: form.prompt.trim() }); }}
      />
    </div>
  </Group>;
}

const EXPORT_KEYS = ["mp3", "m4b", "srt", "lrc", "package"] as const;
type ExportKey = (typeof EXPORT_KEYS)[number];
const EXPORT_LABELS: Readonly<Record<ExportKey, string>> = {
  mp3: "MP3", m4b: "M4B", srt: "SRT", lrc: "LRC", package: "发布包",
};

/** 扁平化的格式勾选状态：导出面板与确认文案共用同一份解释。 */
function selectedFormats(formats: AudiobookExportFormats): Readonly<Record<ExportKey, boolean>> {
  return {
    mp3: formats.mp3,
    m4b: formats.m4b,
    package: formats.package,
    srt: formats.subtitles.includes("srt"),
    lrc: formats.subtitles.includes("lrc"),
  };
}

interface ExportPanelProps {
  readonly preflight: AudiobookExportPreflight | undefined;
  readonly busy: boolean;
  readonly onPreview?: ((formats: AudiobookExportFormats) => void) | undefined;
  readonly onExport?: ((formats: AudiobookExportFormats) => void) | undefined;
}

/** 完整导出面板：格式开关留在本地，预检未就绪时禁用导出并逐条列出问题。 */
export function ExportPanel({ preflight, busy, onPreview, onExport }: ExportPanelProps): JSX.Element {
  const [formats, setFormats] = useState<AudiobookExportFormats>({ mp3: true, m4b: false, subtitles: ["srt"], package: false });
  const selected = selectedFormats(formats);
  const ready = preflight?.ready === true;
  const toggle = (key: ExportKey): void => {
    setFormats(key === "srt" || key === "lrc"
      ? { ...formats, subtitles: selected[key] ? formats.subtitles.filter((item) => item !== key) : [...formats.subtitles, key] }
      : { ...formats, [key]: !selected[key] });
  };
  return <Group label="有声剧完整导出" title="完整导出">
    <div className="oh-audiobook-actions">
      {EXPORT_KEYS.map((key) => <label key={key} className="oh-diag-chip">
        <input type="checkbox" checked={selected[key]} disabled={busy} onChange={() => { toggle(key); }} />
        {EXPORT_LABELS[key]}
      </label>)}
      <Action text="预检" disabled={busy || onPreview === undefined} onClick={() => { onPreview?.(formats); }} />
      <Action text="完整导出" disabled={busy || !ready} onClick={() => { onExport?.(formats); }} />
    </div>
    {preflight === undefined ? null : <>
      <p className="oh-diag-check-summary">{`${preflight.ready ? "预检通过" : "预检未通过"} · ${String(preflight.chapters)} 章 · ${formatCost(preflight.cost.estimatedCost)}`}</p>
      <ul className="oh-diag-guidance">
        {preflight.issues.map((issue, index) => <li key={String(index)}>{`${issue.code} ${issue.message}`}</li>)}
      </ul>
    </>}
  </Group>;
}

export interface AudiobookViewProps {
  readonly overview: AudiobookOverview;
  readonly view?: AudiobookProjectView | undefined;
  readonly estimate?: AudiobookCostEstimate | undefined;
  /** 预估对应的章节；省略时视为整表共用同一份预估。 */
  readonly estimateChapter?: string | undefined;
  readonly busy: boolean;
  readonly notice?: string | undefined;
  readonly error?: string | undefined;
  readonly draft?: AudiobookDraft | undefined;
  readonly onDraftChange?: ((next: AudiobookDraft) => void) | undefined;
  readonly onRefresh: () => void;
  readonly onCreate: (bookRoot: string, name: string, voice: string) => void;
  readonly onParse: (chapter: string) => void;
  readonly onDryRun: (chapter: string) => void;
  readonly onGenerate: (chapter: string) => void;
  readonly onExport: (chapter: string) => void;
  readonly onSelectProject?: ((path: string) => void) | undefined;
  readonly audioUrl?: ((path: string) => string) | undefined;
  readonly segments?: AudiobookSegmentsView | undefined;
  readonly onLoadSegments?: ((chapter: string) => void) | undefined;
  readonly onCloseSegments?: (() => void) | undefined;
  readonly onSaveCast?: ((cast: readonly AudiobookCastMember[]) => void) | undefined;
  readonly onSaveAssignments?: ((chapter: string, assignments: readonly AudiobookAssignment[]) => void) | undefined;
  /** 素材/cue/完整导出（N4-C）：省略时对应面板不渲染，老调用方形状不变。 */
  readonly assets?: AudiobookAssetView | undefined;
  readonly assetsError?: string | undefined;
  readonly cues?: readonly AudiobookCue[] | undefined;
  readonly exportPreflight?: AudiobookExportPreflight | undefined;
  readonly onAddCue?: ((asset: AudiobookAsset, startSegment: string) => void) | undefined;
  readonly onDeleteCue?: ((cueId: string) => void) | undefined;
  readonly onSaveCues?: (() => void) | undefined;
  readonly onGenerateAssets?: ((input: AssetGenerateInput) => void) | undefined;
  readonly onPreviewExport?: ((formats: AudiobookExportFormats) => void) | undefined;
  readonly onExportAll?: ((formats: AudiobookExportFormats) => void) | undefined;
}

/** 纯展示组件：只吃 props，可在 SSR/测试里直接渲染。 */
export function AudiobookView({
  overview,
  view,
  estimate,
  estimateChapter,
  busy,
  notice,
  error,
  draft: draftProp,
  onDraftChange,
  onRefresh,
  onCreate,
  onParse,
  onDryRun,
  onGenerate,
  onExport,
  onSelectProject,
  audioUrl,
  segments,
  onLoadSegments,
  onCloseSegments,
  onSaveCast,
  onSaveAssignments,
  assets,
  assetsError,
  cues,
  exportPreflight,
  onAddCue,
  onDeleteCue,
  onSaveCues,
  onGenerateAssets,
  onPreviewExport,
  onExportAll,
}: AudiobookViewProps): JSX.Element {
  const draft = draftProp ?? defaultDraft(overview);
  const createReady = draft.bookRoot !== "" && draft.name.trim() !== "" && draft.voice.trim() !== "";
  const currentPath = view?.record.path;
  const updateDraft = (patch: Partial<AudiobookDraft>): void => {
    onDraftChange?.({ ...draft, ...patch });
  };
  const estimateFor = (chapter: string): AudiobookCostEstimate | undefined => {
    if (estimate === undefined) return undefined;
    return estimateChapter === undefined || estimateChapter === chapter ? estimate : undefined;
  };
  return <div className="oh-diag-body oh-audiobook" aria-busy={busy}>
    <div className="oh-diag-bar">
      <h3 className="oh-audiobook-title">有声剧</h3>
      <span className="oh-diag-meta">
        {String(overview.projects.length)} 个项目 · {String(overview.sources.length)} 个来源
      </span>
      <div className="oh-diag-actions">
        <Action text="刷新" disabled={busy} onClick={onRefresh} />
      </div>
    </div>
    <div className="oh-diag-chips" role="group" aria-label="有声剧预检">
      {overview.preflight.ttsKey === "missing"
        ? <span className="oh-diag-chip" data-kind="p0">缺少 OH_STORY_TTS_API_KEY</span>
        : <span className="oh-diag-chip" data-kind="pass">
          TTS 密钥已配置{overview.preflight.ttsHost === null ? "" : ` · ${overview.preflight.ttsHost}`}
        </span>}
      {overview.preflight.ffmpeg
        ? <span className="oh-diag-chip" data-kind="pass">ffmpeg 就绪</span>
        : <span className="oh-diag-chip" data-kind="p0">ffmpeg 未就绪</span>}
      {overview.preflight.ffprobe
        ? <span className="oh-diag-chip" data-kind="pass">ffprobe 就绪</span>
        : <span className="oh-diag-chip" data-kind="p0">ffprobe 未就绪</span>}
      {busy ? <span className="oh-diag-chip">处理中…</span> : null}
    </div>
    {error !== undefined ? <p className="oh-diag-error" role="alert">{error}</p> : null}
    {notice !== undefined ? <p className="oh-diag-notice" role="status">{notice}</p> : null}
    {overview.errors.map((item) => <p className="oh-diag-error" role="alert" key={item.path}>
      {item.path}：{item.message}
    </p>)}
    <div className="oh-diag-groups">
      <Group label="创建有声剧项目" title="创建项目">
        {overview.sources.length === 0
          ? <p className="oh-diag-empty">没有可用来源：请先在 正文/ 下建立章节，再刷新。</p>
          : <>
            <ul className="oh-diag-guidance">
              {overview.sources.map((source) => <li key={source.bookRoot}>
                {source.name} · {String(source.chapters.length)} 章 · {source.bookRoot}
              </li>)}
            </ul>
            <div className="oh-audiobook-create">
              <label className="oh-audiobook-field">来源
                <select
                  value={draft.bookRoot}
                  onChange={(event) => { updateDraft({ bookRoot: event.target.value }); }}
                >
                  {overview.sources.map((source) => <option key={source.bookRoot} value={source.bookRoot}>
                    {source.name}（{String(source.chapters.length)} 章）
                  </option>)}
                </select>
              </label>
              <label className="oh-audiobook-field">名称
                <input
                  value={draft.name}
                  placeholder="如 长夜行"
                  onChange={(event) => { updateDraft({ name: event.target.value }); }}
                />
              </label>
              <label className="oh-audiobook-field">旁白音色
                <input
                  value={draft.voice}
                  placeholder="如 alloy"
                  onChange={(event) => { updateDraft({ voice: event.target.value }); }}
                />
              </label>
              <Action
                text="创建项目"
                disabled={busy || !createReady}
                onClick={() => { onCreate(draft.bookRoot, draft.name.trim(), draft.voice.trim()); }}
              />
            </div>
          </>}
      </Group>
      {overview.projects.length === 0 ? null : <Group label="有声剧项目" title="项目">
        <div className="oh-audiobook-projects">
          {overview.projects.map((project) => <button
            key={project.path}
            type="button"
            className="oh-diag-chip"
            data-active={project.path === currentPath ? "" : undefined}
            disabled={busy || onSelectProject === undefined || project.path === currentPath}
            onClick={() => { onSelectProject?.(project.path); }}
          >{project.name} · {String(project.chapters)} 章</button>)}
        </div>
      </Group>}
      {view === undefined
        ? <Group label="有声剧章节" title="章节">
          <p className="oh-diag-empty">
            {overview.projects.length === 0 ? "还没有有声剧项目。" : busy ? "正在读取项目…" : "项目尚未加载。"}
          </p>
        </Group>
        : <Group label="有声剧章节" title={`${projectNameOf(view.record.path)} · ${view.record.path}`}>
          <p className="oh-diag-check-summary">
            TTS：{view.record.project.tts.model} · {view.record.project.tts.baseUrl} · 旁白音色：{narratorVoiceOf(view.record)}
          </p>
          <CastEditor
            key={`${view.record.path}:${view.record.version}`}
            cast={view.record.project.cast}
            busy={busy}
            onSave={onSaveCast}
          />
          {view.chapters.length === 0
            ? <p className="oh-diag-empty">项目里还没有章节。</p>
            : <table className="oh-audiobook-table">
              <thead>
                <tr>
                  <th>章节</th><th>脚本</th><th>段数</th><th>未指派</th><th>任务</th><th>估算成本</th><th>音频</th><th>操作</th>
                </tr>
              </thead>
              <tbody>
                {view.chapters.map((chapter) => {
                  const chapterEstimate = estimateFor(chapter.chapter);
                  const actionBlocked = busy || !chapter.hasScript || chapter.unassignedSegments > 0;
                  const blockedTitle = chapter.unassignedSegments > 0 ? `有 ${String(chapter.unassignedSegments)} 段对白未指派说话人` : undefined;
                  return <tr key={chapter.chapter}>
                    <td className="oh-audiobook-chapter">{chapter.chapter}</td>
                    <td>{scriptStateOf(chapter)}</td>
                    <td>{String(chapter.segmentCount)}</td>
                    <td>{chapter.unassignedSegments > 0
                      ? <span className="oh-diag-chip" data-kind="p0">未指派 {String(chapter.unassignedSegments)}</span>
                      : "—"}</td>
                    <td>{chapter.jobStatus === null ? "—" : JOB_LABELS[chapter.jobStatus]}</td>
                    <td>{chapterEstimate === undefined ? "—" : formatCost(chapterEstimate.estimatedCost)}</td>
                    <td>
                      {chapter.audioPath === null
                        ? "—"
                        : audioUrl === undefined
                          ? chapter.audioPath
                          : <audio className="oh-audiobook-audio" controls preload="none" src={audioUrl(chapter.audioPath)} />}
                    </td>
                    <td>
                      <div className="oh-audiobook-actions">
                        <Action text="解析" disabled={busy} onClick={() => { onParse(chapter.chapter); }} />
                        <Action
                          text="分段"
                          disabled={busy || !chapter.hasScript || onLoadSegments === undefined}
                          onClick={() => { onLoadSegments?.(chapter.chapter); }}
                        />
                        <Action
                          text="估算"
                          title={blockedTitle}
                          disabled={actionBlocked}
                          onClick={() => { onDryRun(chapter.chapter); }}
                        />
                        <Action
                          text="生成"
                          title={blockedTitle}
                          disabled={actionBlocked}
                          onClick={() => { onGenerate(chapter.chapter); }}
                        />
                        <Action
                          text="导出 MP3"
                          title={blockedTitle}
                          disabled={actionBlocked}
                          onClick={() => { onExport(chapter.chapter); }}
                        />
                      </div>
                    </td>
                  </tr>;
                })}
              </tbody>
            </table>}
          {estimate === undefined ? null : <p className="oh-diag-check-summary">
            估算成本：{formatCost(estimate.estimatedCost)} · {String(estimate.segments)} 段 · {String(estimate.chars)} 字符 · {String(estimate.requests)} 次请求 · 缓存命中 {String(estimate.cacheHits)}
          </p>}
          {segments === undefined ? null : <SegmentEditor
            key={`${segments.record.path}:${segments.record.version}`}
            view={segments}
            cast={view.record.project.cast}
            busy={busy}
            onClose={onCloseSegments}
            onSave={onSaveAssignments}
          />}
          {assetsError === undefined ? null : <p className="oh-diag-error" role="alert">素材：{assetsError}</p>}
          {assets === undefined ? null : <AssetPanel
            view={assets}
            cues={cues ?? []}
            chapterSegments={segments?.record.script.segments}
            busy={busy}
            onSaveCue={onAddCue}
            onDeleteCue={onDeleteCue}
            onSaveCues={onSaveCues}
            onGenerate={onGenerateAssets}
          />}
          {exportPreflight === undefined && onPreviewExport === undefined ? null : <ExportPanel
            preflight={exportPreflight}
            busy={busy}
            onPreview={onPreviewExport}
            onExport={onExportAll}
          />}
        </Group>}
    </div>
  </div>;
}

function AudiobookPanel({ sessionId }: WorkbenchFeatureProps): JSX.Element {
  const [overview, setOverview] = useState<AudiobookOverview | undefined>(undefined);
  const [projectView, setProjectView] = useState<AudiobookProjectView | undefined>(undefined);
  const [segmentsView, setSegmentsView] = useState<AudiobookSegmentsView | undefined>(undefined);
  const [assetsView, setAssetsView] = useState<AudiobookAssetView | undefined>(undefined);
  const [assetsError, setAssetsError] = useState<string | undefined>(undefined);
  const [cuesDraft, setCuesDraft] = useState<readonly AudiobookCue[] | undefined>(undefined);
  const [exportPreflight, setExportPreflight] = useState<AudiobookExportPreflight | undefined>(undefined);
  const [estimate, setEstimate] = useState<{ readonly chapter: string; readonly value: AudiobookCostEstimate } | undefined>(undefined);
  const [draft, setDraft] = useState<AudiobookDraft>({ bookRoot: "", name: "", voice: NARRATOR_FALLBACK_VOICE });
  const [error, setError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState<string | undefined>(undefined);
  const requestId = useRef(0);
  const busy = pending !== undefined;

  /** 统一异步动作：递增 id 守卫 + pending 标签 + 失败落进面板，避免每个动作重复样板。 */
  const run = useCallback(async (label: string, work: (id: number) => Promise<void>): Promise<void> => {
    const id = ++requestId.current;
    setPending(label);
    setError(undefined);
    setNotice(undefined);
    try {
      await work(id);
    } catch (reason) {
      if (id === requestId.current) setError(reason instanceof Error ? reason.message : "有声剧操作失败。");
    } finally {
      if (id === requestId.current) setPending(undefined);
    }
  }, []);

  /** 素材视图独立请求：读取失败只让素材区报错，不拖垮项目视图。 */
  const loadAssets = useCallback(async (path: string, id: number, signal?: AbortSignal): Promise<void> => {
    try {
      const payload = await jsonOrThrow<{ readonly view: AudiobookAssetView }>(
        await fetch(endpoint("audiobook/assets", sessionId, path), signal === undefined ? undefined : { signal }),
      );
      if (id !== requestId.current) return;
      setAssetsView(payload.view);
      setAssetsError(undefined);
    } catch (reason) {
      if (id !== requestId.current || (reason instanceof DOMException && reason.name === "AbortError")) return;
      setAssetsView(undefined);
      setAssetsError(reason instanceof Error ? reason.message : "读取素材失败。");
    }
  }, [sessionId]);

  const load = useCallback(async (preferred?: string, signal?: AbortSignal): Promise<void> => {
    const id = ++requestId.current;
    setPending("refresh");
    setError(undefined);
    try {
      const response = await fetch(endpoint("audiobook", sessionId), signal === undefined ? undefined : { signal });
      const payload = await jsonOrThrow<AudiobookOverview>(response);
      if (id !== requestId.current) return;
      setOverview(payload);
      const target = payload.projects.find((project) => project.path === preferred) ?? payload.projects[0];
      if (target === undefined) {
        setProjectView(undefined);
        setSegmentsView(undefined);
        setEstimate(undefined);
        setAssetsView(undefined);
        setAssetsError(undefined);
        setCuesDraft(undefined);
        setExportPreflight(undefined);
        setDraft(defaultDraft(payload));
        return;
      }
      const projectResponse = await fetch(
        endpoint("audiobook/project", sessionId, target.path),
        signal === undefined ? undefined : { signal }
      );
      const loaded = await jsonOrThrow<AudiobookProjectView>(projectResponse);
      if (id !== requestId.current) return;
      setProjectView(loaded);
      setCuesDraft(undefined);
      setDraft({
        bookRoot: loaded.record.project.source.bookRoot,
        name: projectNameOf(loaded.record.path),
        voice: narratorVoiceOf(loaded.record),
      });
      setEstimate(undefined);
      await loadAssets(target.path, id, signal);
    } catch (failure) {
      if (id !== requestId.current) return;
      if (failure instanceof DOMException && failure.name === "AbortError") return;
      setError(failure instanceof Error ? failure.message : "读取有声剧失败。");
    } finally {
      if (id === requestId.current) setPending(undefined);
    }
  }, [loadAssets, sessionId]);

  useEffect(() => {
    const controller = new AbortController();
    void load(undefined, controller.signal);
    return () => { controller.abort(); };
  }, [load]);

  const refresh = useCallback((): void => {
    void load(projectView?.record.path);
  }, [load, projectView?.record.path]);

  const create = useCallback((bookRoot: string, name: string, voice: string): Promise<void> => run("create", async (id) => {
    const payload = await postJson<ProjectRecordResponse>(endpoint("audiobook/project", sessionId), { bookRoot, name, voice });
    if (id !== requestId.current) return;
    setSegmentsView(undefined);
    setNotice(`已创建项目 ${payload.record.path}。`);
    await load(payload.record.path);
  }), [load, run, sessionId]);

  const loadSegments = useCallback((chapter: string): Promise<void> => {
    const current = projectView;
    if (current === undefined) return Promise.resolve();
    return run(`segments:${chapter}`, async (id) => {
      const url = new URL(endpoint("audiobook/script", sessionId, current.record.path));
      url.searchParams.set("chapter", chapter);
      const payload = await jsonOrThrow<AudiobookScriptViewResponse>(await fetch(url.toString()));
      if (id !== requestId.current) return;
      setSegmentsView({ chapter, record: payload.script });
    });
  }, [projectView, run, sessionId]);

  const saveCast = useCallback((cast: readonly AudiobookCastMember[]): Promise<void> => {
    const current = projectView;
    if (current === undefined) return Promise.resolve();
    return run("cast", async (id) => {
      const payload = await putJson<{ readonly record: AudiobookProjectRecord }>(
        endpoint("audiobook/project", sessionId),
        { path: current.record.path, baseVersion: current.record.version, project: { ...current.record.project, cast } },
      );
      if (id !== requestId.current) return;
      setNotice(`已保存 ${String(payload.record.project.cast.length)} 个角色。`);
      await load(current.record.path);
    });
  }, [load, projectView, run, sessionId]);

  const saveAssignments = useCallback((chapter: string, assignments: readonly AudiobookAssignment[]): Promise<void> => {
    const current = projectView;
    const segments = segmentsView;
    if (current === undefined || segments === undefined || segments.chapter !== chapter) return Promise.resolve();
    return run(`assign:${chapter}`, async (id) => {
      const payload = await putJson<AudiobookScriptViewResponse>(endpoint("audiobook/script", sessionId), {
        path: current.record.path,
        chapter,
        baseVersion: segments.record.version,
        assignments,
      });
      if (id !== requestId.current) return;
      setSegmentsView({ chapter, record: payload.script });
      setNotice(`已保存「${chapter}」的 ${String(assignments.length)} 条说话人指派。`);
      await load(current.record.path);
    });
  }, [load, projectView, run, segmentsView, sessionId]);

  const parse = useCallback((chapter: string): Promise<void> => {
    const current = projectView;
    if (current === undefined) return Promise.resolve();
    const target = current.chapters.find((candidate) => candidate.chapter === chapter);
    const overwrite = target?.hasScript === true;
    // 覆盖已有脚本是破坏性动作，确认框必须在请求之前。
    if (overwrite && !globalThis.confirm(`章节「${chapter}」已有脚本，重新解析会覆盖现有脚本。确认继续？`)) return Promise.resolve();
    return run(`parse:${chapter}`, async (id) => {
      const payload = await postJson<AudiobookScriptParseResponse>(
        endpoint("audiobook/script", sessionId),
        { path: current.record.path, chapter, confirm: overwrite }
      );
      if (id !== requestId.current) return;
      setSegmentsView(undefined);
      const summary = payload.assignmentSummary;
      const kept = summary === undefined
        ? ""
        : `；保留 ${String(summary.preserved)} 条说话人指派${summary.dropped > 0 ? `，${String(summary.dropped)} 条因文本变化重置` : ""}`;
      setNotice(`已解析「${chapter}」，共 ${String(parsedSegmentCount(payload))} 段${kept}。`);
      await load(current.record.path);
    });
  }, [load, projectView, run, sessionId]);

  const dryRun = useCallback((chapter: string): Promise<void> => {
    const current = projectView;
    if (current === undefined) return Promise.resolve();
    return run(`estimate:${chapter}`, async (id) => {
      const payload = await postJson<{ readonly estimate: AudiobookCostEstimate }>(
        endpoint("audiobook/jobs", sessionId),
        { path: current.record.path, chapter, dryRun: true }
      );
      if (id !== requestId.current) return;
      setEstimate({ chapter, value: payload.estimate });
      setNotice(`「${chapter}」预估 ${formatCost(payload.estimate.estimatedCost)}（${String(payload.estimate.requests)} 次请求）。`);
    });
  }, [projectView, run, sessionId]);

  const generate = useCallback((chapter: string): Promise<void> => {
    const current = projectView;
    if (current === undefined) return Promise.resolve();
    return run(`generate:${chapter}`, async (id) => {
      // 付费前先干跑一次：确认框里带上预估费用、请求数与缓存命中，再真正启动任务。
      const preview = await postJson<{ readonly estimate: AudiobookCostEstimate }>(
        endpoint("audiobook/jobs", sessionId),
        { path: current.record.path, chapter, dryRun: true }
      );
      if (id !== requestId.current) return;
      setEstimate({ chapter, value: preview.estimate });
      if (!globalThis.confirm(generateConfirmText(chapter, preview.estimate))) return;
      const payload = await postJson<JobStartResponse>(endpoint("audiobook/jobs", sessionId), {
        path: current.record.path,
        chapter,
        confirm: true,
      });
      if (id !== requestId.current) return;
      setNotice(`已启动任务 ${payload.job.id}：${JOB_LABELS[payload.job.status]}，共 ${String(payload.job.totalSegments)} 段，预估 ${formatCost(payload.estimate.estimatedCost)}。`);
      await load(current.record.path);
    });
  }, [load, projectView, run, sessionId]);

  const exportChapter = useCallback((chapter: string): Promise<void> => {
    const current = projectView;
    if (current === undefined) return Promise.resolve();
    if (!globalThis.confirm(`将导出「${chapter}」的 MP3（调用 ffmpeg 写音频文件）。确认继续？`)) return Promise.resolve();
    return run(`export:${chapter}`, async (id) => {
      const payload = await postJson<ExportResponse>(endpoint("audiobook/export", sessionId), {
        path: current.record.path,
        chapter,
        confirm: true,
      });
      if (id !== requestId.current) return;
      setNotice(`已导出 ${payload.path}（${formatBytes(payload.bytes)}，${(payload.durationMs / 1000).toFixed(1)} 秒）。`);
      await load(current.record.path);
    });
  }, [load, projectView, run, sessionId]);

  /** cue 挂在“当前打开分段的章节”，没打开分段时退回首章；草稿存在时以草稿为准。 */
  const cueChapter = segmentsView?.chapter ?? projectView?.chapters[0]?.chapter ?? "";
  const cueBase = cuesDraft ?? projectView?.record.project.cues ?? [];
  const visibleCues = cueBase.filter((cue) => cue.chapter === cueChapter);

  const addCue = useCallback((asset: AudiobookAsset, startSegment: string): void => {
    if (projectView === undefined || cueChapter === "" || startSegment === "") {
      setNotice("请先点「分段」。");
      return;
    }
    setCuesDraft([...cueBase, { ...CUE_DEFAULTS, id: nextCueId(cueBase), chapter: cueChapter, asset: asset.path, startSegment }]);
    setNotice("已加入 cue 草稿。");
  }, [cueBase, cueChapter, projectView]);

  const deleteCue = useCallback((cueId: string): void => {
    setCuesDraft(cueBase.filter((cue) => cue.id !== cueId));
  }, [cueBase]);

  const saveCues = useCallback((): Promise<void> => {
    const current = projectView;
    const cues = cuesDraft;
    if (current === undefined || cues === undefined) return Promise.resolve();
    return run("cues", async (id) => {
      await putJson<ProjectRecordResponse>(endpoint("audiobook/project", sessionId), {
        path: current.record.path,
        baseVersion: current.record.version,
        project: { ...current.record.project, cues },
      });
      if (id !== requestId.current) return;
      setCuesDraft(undefined);
      setNotice(`已保存 ${String(cues.length)} 条 cue。`);
      await load(current.record.path);
    });
  }, [cuesDraft, load, projectView, run, sessionId]);

  const generateAssets = useCallback((input: AssetGenerateInput): Promise<void> => {
    const current = projectView;
    if (current === undefined) return Promise.resolve();
    const body = { path: current.record.path, ...input };
    return run("asset", async (id) => {
      // 先零写入预览拿预估，把费用摆进确认框，再真正调用 provider 写盘。
      const preview = await postJson<AudiobookAssetGenerationPreview>(endpoint("audiobook/assets/generate", sessionId), { ...body, preview: true });
      if (id !== requestId.current) return;
      const text = `生成 ${String(input.count)} 个素材，预估 ${formatCost(preview.estimate)}。确认写入？`;
      if (!globalThis.confirm(text)) return;
      const payload = await postJson<AudiobookAssetGenerationResponse>(endpoint("audiobook/assets/generate", sessionId), { ...body, confirm: true });
      if (id !== requestId.current) return;
      setNotice(`已生成 ${String(payload.files.length)} 个素材，待补授权。`);
      await loadAssets(current.record.path, id);
    });
  }, [loadAssets, projectView, run, sessionId]);

  const previewExport = useCallback((formats: AudiobookExportFormats): Promise<void> => {
    const current = projectView;
    if (current === undefined) return Promise.resolve();
    return run("preflight", async (id) => {
      const payload = await postJson<{ readonly preflight: AudiobookExportPreflight }>(
        endpoint("audiobook/export", sessionId),
        { path: current.record.path, formats, preview: true },
      );
      if (id !== requestId.current) return;
      setExportPreflight(payload.preflight);
      setNotice(payload.preflight.ready ? "预检通过。" : `预检有 ${String(payload.preflight.issues.length)} 个问题。`);
    });
  }, [projectView, run, sessionId]);

  const exportAll = useCallback((formats: AudiobookExportFormats): Promise<void> => {
    const current = projectView;
    const preflight = exportPreflight;
    if (current === undefined || preflight === undefined || !preflight.ready) return Promise.resolve();
    if (!globalThis.confirm(exportConfirmText(formats, preflight))) return Promise.resolve();
    return run("export-all", async (id) => {
      const payload = await postJson<AudiobookExportFullResult>(
        endpoint("audiobook/export", sessionId),
        { path: current.record.path, formats, confirm: true },
      );
      if (id !== requestId.current) return;
      const manifest = payload.manifestPath === undefined ? "" : `，清单 ${payload.manifestPath}`;
      setNotice(`已导出 ${String(payload.files.length)} 个文件${manifest}。`);
      await load(current.record.path);
    });
  }, [exportPreflight, load, projectView, run, sessionId]);

  return <div className="oh-diag-panel">
    <style>{STYLES}</style>
    {overview === undefined
      ? <div className="oh-diag-state">
        {error !== undefined
          ? <>
            <p className="oh-diag-error" role="alert">{error}</p>
            <Action text="重试" disabled={busy} onClick={refresh} />
          </>
          : <p className="oh-diag-meta">{busy ? "正在读取…" : "尚无数据，点「刷新」重试。"}</p>}
      </div>
      : <AudiobookView
        overview={overview}
        view={projectView}
        estimate={estimate?.value}
        estimateChapter={estimate?.chapter}
        busy={busy}
        notice={notice}
        error={error}
        draft={draft}
        onDraftChange={setDraft}
        onRefresh={refresh}
        onCreate={(bookRoot, name, voice) => { void create(bookRoot, name, voice); }}
        onParse={(chapter) => { void parse(chapter); }}
        onDryRun={(chapter) => { void dryRun(chapter); }}
        onGenerate={(chapter) => { void generate(chapter); }}
        onExport={(chapter) => { void exportChapter(chapter); }}
        onSelectProject={(path) => { setSegmentsView(undefined); void load(path); }}
        audioUrl={(path) => endpoint("media", sessionId, path)}
        segments={segmentsView}
        onLoadSegments={(chapter) => { void loadSegments(chapter); }}
        onCloseSegments={() => { setSegmentsView(undefined); }}
        onSaveCast={(cast) => { void saveCast(cast); }}
        onSaveAssignments={(chapter, assignments) => { void saveAssignments(chapter, assignments); }}
        assets={assetsView}
        assetsError={assetsError}
        cues={visibleCues}
        exportPreflight={exportPreflight}
        onAddCue={addCue}
        onDeleteCue={deleteCue}
        onSaveCues={cuesDraft === undefined ? undefined : () => { void saveCues(); }}
        onGenerateAssets={(input) => { void generateAssets(input); }}
        onPreviewExport={(formats) => { void previewExport(formats); }}
        onExportAll={(formats) => { void exportAll(formats); }}
      />}
  </div>;
}

registerWorkbenchFeature({
  id: "audiobook",
  label: "有声剧",
  icon: "🎧",
  workbenches: ["story"],
  component: AudiobookPanel,
});
