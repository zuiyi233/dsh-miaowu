import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AudiobookAssignment,
  AudiobookCastMember,
  AudiobookChapterSummary,
  AudiobookCostEstimate,
  AudiobookJob,
  AudiobookJobStatus,
  AudiobookOverview,
  AudiobookProjectRecord,
  AudiobookProjectView,
  AudiobookScriptParseResponse,
  AudiobookScriptRecord,
  AudiobookScriptViewResponse,
} from "../../services/audiobook-contract.js";
import { endpoint } from "../workbench-ui.js";
import { registerWorkbenchFeature, type WorkbenchFeatureProps } from "./registry.js";
import diagStyles from "./diagnostics-feature.css?inline";
import styles from "./audiobook-feature.css?inline";

/**
 * 「有声剧」工作台：把章节脚本、成本预估、任务与 MP3 导出收进一个面板。
 *
 * 概览/项目只读；解析、生成、导出都会产生副作用（覆盖脚本、TTS 费用、文件
 * 写入），必须经 window.confirm 显式确认。请求用递增 id 守卫，过期响应直接
 * 丢弃；任何失败都显示在面板里，绝不静默吞掉。
 */

const STYLES = `${diagStyles}\n${styles}`;
const NARRATOR_FALLBACK_VOICE = "alloy";

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

interface ProjectCreateResponse {
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
  return <section className="oh-diag-group" aria-label="有声剧角色">
    <h4 className="oh-diag-group-title">角色与音色</h4>
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
            : <button
              type="button"
              className="oh-diag-action"
              disabled={busy}
              onClick={() => { removeCharacter(index); }}
            >删除</button>}</td>
        </tr>)}
      </tbody>
    </table>
    <div className="oh-audiobook-actions">
      <button type="button" className="oh-diag-action" disabled={busy} onClick={addCharacter}>添加角色</button>
      <button
        type="button"
        className="oh-diag-action"
        disabled={busy || !dirty || !valid || onSave === undefined}
        onClick={() => { if (dirty && valid) onSave?.(draft); }}
      >保存角色</button>
    </div>
    {valid ? null : <p className="oh-diag-error" role="alert">
      角色 id 必须唯一且只含字母、数字、下划线或连字符；显示名与音色不能为空；必须恰好一个旁白。
    </p>}
  </section>;
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
  return <section className="oh-diag-group" aria-label="有声剧分段">
    <h4 className="oh-diag-group-title">分段指派 · {view.chapter}</h4>
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
      <button
        type="button"
        className="oh-diag-action"
        disabled={busy || assignments.length === 0 || onSave === undefined}
        onClick={() => { if (assignments.length > 0) onSave?.(view.chapter, assignments); }}
      >保存指派</button>
      {onClose === undefined ? null : <button type="button" className="oh-diag-action" disabled={busy} onClick={onClose}>收起</button>}
    </div>
    {unassigned === 0
      ? null
      : <p className="oh-diag-error" role="alert">还有 {String(unassigned)} 段对白未指派说话人，整章不能生成或导出。</p>}
  </section>;
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
        <button type="button" className="oh-diag-action" disabled={busy} onClick={onRefresh}>刷新</button>
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
      <section className="oh-diag-group" aria-label="创建有声剧项目">
        <h4 className="oh-diag-group-title">创建项目</h4>
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
              <button
                type="button"
                className="oh-diag-action"
                disabled={busy || !createReady}
                onClick={() => { onCreate(draft.bookRoot, draft.name.trim(), draft.voice.trim()); }}
              >创建项目</button>
            </div>
          </>}
      </section>
      {overview.projects.length === 0 ? null : <section className="oh-diag-group" aria-label="有声剧项目">
        <h4 className="oh-diag-group-title">项目</h4>
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
      </section>}
      {view === undefined
        ? <section className="oh-diag-group">
          <h4 className="oh-diag-group-title">章节</h4>
          <p className="oh-diag-empty">
            {overview.projects.length === 0 ? "还没有有声剧项目。" : busy ? "正在读取项目…" : "项目尚未加载。"}
          </p>
        </section>
        : <section className="oh-diag-group" aria-label="有声剧章节">
          <h4 className="oh-diag-group-title">{projectNameOf(view.record.path)} · {view.record.path}</h4>
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
                  const blocked = chapter.unassignedSegments > 0;
                  const blockedTitle = blocked ? `有 ${String(chapter.unassignedSegments)} 段对白未指派说话人` : undefined;
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
                        <button
                          type="button"
                          className="oh-diag-action"
                          disabled={busy}
                          onClick={() => { onParse(chapter.chapter); }}
                        >解析</button>
                        <button
                          type="button"
                          className="oh-diag-action"
                          disabled={busy || !chapter.hasScript || onLoadSegments === undefined}
                          onClick={() => { onLoadSegments?.(chapter.chapter); }}
                        >分段</button>
                        <button
                          type="button"
                          className="oh-diag-action"
                          title={blockedTitle}
                          disabled={busy || !chapter.hasScript || blocked}
                          onClick={() => { onDryRun(chapter.chapter); }}
                        >估算</button>
                        <button
                          type="button"
                          className="oh-diag-action"
                          title={blockedTitle}
                          disabled={busy || !chapter.hasScript || blocked}
                          onClick={() => { onGenerate(chapter.chapter); }}
                        >生成</button>
                        <button
                          type="button"
                          className="oh-diag-action"
                          title={blockedTitle}
                          disabled={busy || !chapter.hasScript || blocked}
                          onClick={() => { onExport(chapter.chapter); }}
                        >导出 MP3</button>
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
        </section>}
    </div>
  </div>;
}

function AudiobookPanel({ sessionId }: WorkbenchFeatureProps): JSX.Element {
  const [overview, setOverview] = useState<AudiobookOverview | undefined>(undefined);
  const [projectView, setProjectView] = useState<AudiobookProjectView | undefined>(undefined);
  const [segmentsView, setSegmentsView] = useState<AudiobookSegmentsView | undefined>(undefined);
  const [estimate, setEstimate] = useState<{ readonly chapter: string; readonly value: AudiobookCostEstimate } | undefined>(undefined);
  const [draft, setDraft] = useState<AudiobookDraft>({ bookRoot: "", name: "", voice: NARRATOR_FALLBACK_VOICE });
  const [error, setError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState<string | undefined>(undefined);
  const requestId = useRef(0);
  const busy = pending !== undefined;

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
      setDraft({
        bookRoot: loaded.record.project.source.bookRoot,
        name: projectNameOf(loaded.record.path),
        voice: narratorVoiceOf(loaded.record),
      });
      setEstimate(undefined);
    } catch (failure) {
      if (id !== requestId.current) return;
      if (failure instanceof DOMException && failure.name === "AbortError") return;
      setError(failure instanceof Error ? failure.message : "读取有声剧失败。");
    } finally {
      if (id === requestId.current) setPending(undefined);
    }
  }, [sessionId]);

  useEffect(() => {
    const controller = new AbortController();
    void load(undefined, controller.signal);
    return () => { controller.abort(); };
  }, [load]);

  const refresh = useCallback((): void => {
    void load(projectView?.record.path);
  }, [load, projectView?.record.path]);

  const create = useCallback(async (bookRoot: string, name: string, voice: string): Promise<void> => {
    const id = ++requestId.current;
    setPending("create");
    setError(undefined);
    setNotice(undefined);
    try {
      const payload = await postJson<ProjectCreateResponse>(endpoint("audiobook/project", sessionId), {
        bookRoot,
        name,
        voice,
      });
      if (id !== requestId.current) return;
      setSegmentsView(undefined);
      setNotice(`已创建项目 ${payload.record.path}。`);
      await load(payload.record.path);
    } catch (failure) {
      if (id !== requestId.current) return;
      setError(failure instanceof Error ? failure.message : "创建项目失败。");
    } finally {
      if (id === requestId.current) setPending(undefined);
    }
  }, [load, sessionId]);

  const loadSegments = useCallback(async (chapter: string): Promise<void> => {
    const current = projectView;
    if (current === undefined) return;
    const id = ++requestId.current;
    setPending(`segments:${chapter}`);
    setError(undefined);
    setNotice(undefined);
    try {
      const url = new URL(endpoint("audiobook/script", sessionId, current.record.path));
      url.searchParams.set("chapter", chapter);
      const payload = await jsonOrThrow<AudiobookScriptViewResponse>(await fetch(url.toString()));
      if (id !== requestId.current) return;
      setSegmentsView({ chapter, record: payload.script });
    } catch (failure) {
      if (id !== requestId.current) return;
      setError(failure instanceof Error ? failure.message : "读取章节脚本失败。");
    } finally {
      if (id === requestId.current) setPending(undefined);
    }
  }, [projectView, sessionId]);

  const saveCast = useCallback(async (cast: readonly AudiobookCastMember[]): Promise<void> => {
    const current = projectView;
    if (current === undefined) return;
    const id = ++requestId.current;
    setPending("cast");
    setError(undefined);
    setNotice(undefined);
    try {
      const payload = await putJson<{ readonly record: AudiobookProjectRecord }>(
        endpoint("audiobook/project", sessionId),
        { path: current.record.path, baseVersion: current.record.version, project: { ...current.record.project, cast } },
      );
      if (id !== requestId.current) return;
      setNotice(`已保存 ${String(payload.record.project.cast.length)} 个角色。`);
      await load(current.record.path);
    } catch (failure) {
      if (id !== requestId.current) return;
      setError(failure instanceof Error ? failure.message : "保存角色失败。");
    } finally {
      if (id === requestId.current) setPending(undefined);
    }
  }, [load, projectView, sessionId]);

  const saveAssignments = useCallback(async (chapter: string, assignments: readonly AudiobookAssignment[]): Promise<void> => {
    const current = projectView;
    const segments = segmentsView;
    if (current === undefined || segments === undefined || segments.chapter !== chapter) return;
    const id = ++requestId.current;
    setPending(`assign:${chapter}`);
    setError(undefined);
    setNotice(undefined);
    try {
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
    } catch (failure) {
      if (id !== requestId.current) return;
      setError(failure instanceof Error ? failure.message : "保存说话人指派失败。");
    } finally {
      if (id === requestId.current) setPending(undefined);
    }
  }, [load, projectView, segmentsView, sessionId]);

  const parse = useCallback(async (chapter: string): Promise<void> => {
    const current = projectView;
    if (current === undefined) return;
    const target = current.chapters.find((candidate) => candidate.chapter === chapter);
    const overwrite = target?.hasScript === true;
    if (overwrite && !globalThis.confirm(`章节「${chapter}」已有脚本，重新解析会覆盖现有脚本。确认继续？`)) return;
    const id = ++requestId.current;
    setPending(`parse:${chapter}`);
    setError(undefined);
    setNotice(undefined);
    try {
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
    } catch (failure) {
      if (id !== requestId.current) return;
      setError(failure instanceof Error ? failure.message : "解析脚本失败。");
    } finally {
      if (id === requestId.current) setPending(undefined);
    }
  }, [load, projectView, sessionId]);

  const dryRun = useCallback(async (chapter: string): Promise<void> => {
    const current = projectView;
    if (current === undefined) return;
    const id = ++requestId.current;
    setPending(`estimate:${chapter}`);
    setError(undefined);
    setNotice(undefined);
    try {
      const payload = await postJson<{ readonly estimate: AudiobookCostEstimate }>(
        endpoint("audiobook/jobs", sessionId),
        { path: current.record.path, chapter, dryRun: true }
      );
      if (id !== requestId.current) return;
      setEstimate({ chapter, value: payload.estimate });
      setNotice(`「${chapter}」预估 ${formatCost(payload.estimate.estimatedCost)}（${String(payload.estimate.requests)} 次请求）。`);
    } catch (failure) {
      if (id !== requestId.current) return;
      setError(failure instanceof Error ? failure.message : "预估成本失败。");
    } finally {
      if (id === requestId.current) setPending(undefined);
    }
  }, [projectView, sessionId]);

  const generate = useCallback(async (chapter: string): Promise<void> => {
    const current = projectView;
    if (current === undefined) return;
    const id = ++requestId.current;
    setPending(`generate:${chapter}`);
    setError(undefined);
    setNotice(undefined);
    try {
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
    } catch (failure) {
      if (id !== requestId.current) return;
      setError(failure instanceof Error ? failure.message : "启动任务失败。");
    } finally {
      if (id === requestId.current) setPending(undefined);
    }
  }, [load, projectView, sessionId]);

  const exportChapter = useCallback(async (chapter: string): Promise<void> => {
    const current = projectView;
    if (current === undefined) return;
    if (!globalThis.confirm(`将导出「${chapter}」的 MP3（调用 ffmpeg 写音频文件）。确认继续？`)) return;
    const id = ++requestId.current;
    setPending(`export:${chapter}`);
    setError(undefined);
    setNotice(undefined);
    try {
      const payload = await postJson<ExportResponse>(endpoint("audiobook/export", sessionId), {
        path: current.record.path,
        chapter,
        confirm: true,
      });
      if (id !== requestId.current) return;
      setNotice(`已导出 ${payload.path}（${formatBytes(payload.bytes)}，${(payload.durationMs / 1000).toFixed(1)} 秒）。`);
      await load(current.record.path);
    } catch (failure) {
      if (id !== requestId.current) return;
      setError(failure instanceof Error ? failure.message : "导出 MP3 失败。");
    } finally {
      if (id === requestId.current) setPending(undefined);
    }
  }, [load, projectView, sessionId]);

  return <div className="oh-diag-panel">
    <style>{STYLES}</style>
    {overview === undefined
      ? <div className="oh-diag-state">
        {error !== undefined
          ? <>
            <p className="oh-diag-error" role="alert">{error}</p>
            <button type="button" className="oh-diag-action" disabled={busy} onClick={refresh}>重试</button>
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
