import { createHash } from "node:crypto";
import type { FsDirEntry, FsTarget } from "@deepseek-ai/dsh-fs";
import { readVersionedFile, WorkspaceHttpError, type WorkspaceRealm } from "../workspace-route.js";
import {
  CONTINUITY_BACKUP_STALE_DAYS,
  CONTINUITY_CANDIDATE_STALE_DAYS,
  CONTINUITY_LEVEL_ORDER,
  CONTINUITY_MAX_CHAPTERS,
  CONTINUITY_MAX_HANDOFF_FILES,
  type ContinuityForeshadow,
  type ContinuityHandoffFile,
  type ContinuityHandoffManifest,
  type ContinuityHandoffSkipReason,
  type ContinuityHandoffSkipped,
  type ContinuityHandoffVerifyFile,
  type ContinuityHandoffVerifyResult,
  type ContinuityHandoffVerifyStatus,
  type ContinuityLevel,
  type ContinuityNextChapter,
  type ContinuityOverview,
  type ContinuityProject,
  type ContinuityProjectKind,
  type ContinuityRisk,
  type ContinuityRiskId,
  type ContinuityRun,
  type ContinuitySave,
  type ContinuitySnapshotResult,
  type ContinuityStateAnomaly,
  type ContinuityStats,
  type ContinuityToday,
  type ContinuityTracking,
} from "./continuity-contract.js";
import { listShelf, loadShelf, type ShelfEntry } from "./bookshelf.js";
import { filterSnoozedReminders, loadForeshadows, loadSnoozes, type Foreshadow, type SnoozeRecord } from "./foreshadows.js";
import { loadCandidates, loadRuns, type Candidate, type TaskRun } from "./tasks.js";
import { listVersions, queryAudit } from "./history.js";
import { collectScopeFiles, createBackup, listBackups, safeBundlePath, type BackupSummary } from "./backup.js";
import { buildStateInventory } from "./state-inventory.js";
import { listAnalysisBooks, listSidecarBooks } from "./analysis.js";
import type { StateInventoryEntry } from "./state-contract.js";

/** 连续性驾驶舱的只读投影:概览与交接绝不写盘,只有快照经备份服务落到 `.oh-story/backup/`。 */

const STORY_DIRECTORY = "正文";
const TRACKING_DIRECTORY = "追踪";
const DRAMA_DIRECTORY = "剧集";
const DRAMA_ROOT_FILE = "short-drama.json";
const GAME_DIRECTORY = "game-adaptations";
const VIDEO_DIRECTORY = "video-recaps";
const TRACKING_STATE_FILE = "追踪/_tracking-state.json";
const ACTIVE_BOOK_FILE = ".active-book";
const ACTIVE_BOOK_MAX_BYTES = 4 * 1024;
const AUDIT_FILE = ".oh-story/audit.jsonl";
const HISTORY_DIRECTORY = ".oh-story/history";
const ANALYSIS_DIRECTORY = ".oh-story/analysis";
const TASKS_DIRECTORY = ".oh-story/tasks";
const TASKS_RUNS_FILE = ".oh-story/tasks/runs.json";
const TASKS_CANDIDATES_FILE = ".oh-story/tasks/candidates.json";
const INDEX_DIRECTORY = ".oh-story/index/";
const BACKUP_DIRECTORY = ".oh-story/backup/";
const VAULT_DIRECTORY = ".oh-story/vault/";
const LOCKS_DIRECTORY = ".oh-story/locks/";
const MIGRATIONS_DIRECTORY = ".oh-story/migrations/";

const STATE_FILES = [
  ".active-book",
  ".oh-story/shelf.json",
  ".oh-story/foreshadows.json",
  ".oh-story/foreshadows-snooze.json",
  ".oh-story/annotations.json",
  TASKS_RUNS_FILE,
  TASKS_CANDIDATES_FILE,
  AUDIT_FILE,
] as const;

const EXCLUDED_DIRECTORIES = [
  VAULT_DIRECTORY,
  INDEX_DIRECTORY,
  LOCKS_DIRECTORY,
  BACKUP_DIRECTORY,
  MIGRATIONS_DIRECTORY,
] as const;

const CHAPTER_EXTENSION = ".md";
const CHAPTER_NAME = /^第0*(\d+)章/u;
const PAYOFF_DIGITS = /(\d+)/u;
const DAY_MS = 86_400_000;
const STORE_MAX_BYTES = 2 * 1024 * 1024;
const TRACKING_MAX_BYTES = 4 * 1024 * 1024;
const ROOT_SCAN_LIMIT = 200;
const HISTORY_WALK_DEPTH = 8;
const TODAY_FORESHADOW_LIMIT = 10;
const TODAY_RUN_LIMIT = 10;
const RISK_PATH_LIMIT = 5;
const RECENT_SAVE_LIMIT = 5;
// queryAudit 单次硬上限是 AUDIT_MAX_LIMIT(1000)，这里只要一个有界条数。
const AUDIT_SCAN_LIMIT = 5_000;
const RECYCLE_WARNING_DAYS = 3;

const ABSENT_TRACKING: ContinuityTracking = { lastChapter: null, stateRevision: null, source: "absent" };
const INVALID_TRACKING: ContinuityTracking = { lastChapter: null, stateRevision: null, source: "invalid" };

interface ChapterFile {
  readonly ordinal: number;
  readonly path: string;
  readonly title: string;
  readonly bytes: number;
}

type ActiveBookState = "valid" | "invalid" | "absent";

interface ActiveBookRead {
  readonly state: ActiveBookState;
  readonly root?: string;
}

interface ProjectDetection {
  readonly root: string;
  readonly candidates: readonly string[];
  readonly activeBookState: ActiveBookState;
}

interface RiskContext {
  readonly realm: WorkspaceRealm;
  readonly now: number;
  readonly root: string;
  readonly chapters: readonly ChapterFile[];
  readonly tracking: ContinuityTracking;
  readonly trackingPath: string | null;
  readonly activeBookState: ActiveBookState;
  readonly ambiguousBooks: readonly string[];
  readonly nextOrdinal: number;
  readonly dueForeshadows: readonly Foreshadow[];
  readonly runs: readonly TaskRun[];
  readonly candidates: readonly Candidate[];
  readonly backups: readonly BackupSummary[];
  readonly backupAgeDays: number | null;
  readonly inventory: readonly StateInventoryEntry[];
  readonly shelf: readonly ShelfEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function joinPath(root: string, relative: string): string {
  return root === "" ? relative : `${root}/${relative}`;
}

/** 风险/最近保存路径只接受工作区相对路径；用户可编辑的 JSON 不能把绝对路径带进面板。 */
function safeWorkspacePath(path: string): string | undefined {
  if (path === "" || path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/u.test(path)) return undefined;
  if (path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) return undefined;
  return path;
}

function basenameOf(path: string): string {
  const parts = path.split(/[\\/]+/u).filter((part) => part !== "");
  return parts.at(-1) ?? "";
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function comparePath(left: { readonly path: string }, right: { readonly path: string }): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function formatMinute(at: number): string {
  if (!Number.isFinite(at)) return "未知时间";
  return new Date(at).toISOString().slice(0, 16).replace("T", " ");
}

async function resolveTarget(realm: WorkspaceRealm, relative: string): Promise<FsTarget | undefined> {
  try {
    const target = await realm.fs.resolve(relative, { cwd: realm.cwd });
    return realm.fs.contains(realm.root, target) ? target : undefined;
  } catch {
    return undefined;
  }
}

async function probeType(realm: WorkspaceRealm, relative: string): Promise<FsDirEntry["type"] | undefined> {
  const target = await resolveTarget(realm, relative);
  if (target === undefined) return undefined;
  try {
    return (await realm.fs.stat(target))?.type;
  } catch {
    return undefined;
  }
}

async function listDirectory(realm: WorkspaceRealm, target: FsTarget): Promise<readonly FsDirEntry[]> {
  try {
    if ((await realm.fs.stat(target))?.type !== "directory") return [];
    return await realm.fs.listDir(target);
  } catch {
    return [];
  }
}

async function listChildDirectoryNames(realm: WorkspaceRealm): Promise<string[]> {
  const entries = await listDirectory(realm, realm.root);
  return entries
    .filter((entry) => entry.type === "directory" && !entry.name.startsWith(".") && realm.fs.contains(realm.root, entry.target))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "zh-Hans-CN"))
    .slice(0, ROOT_SCAN_LIMIT);
}

function isChapterName(name: string): boolean {
  return name.endsWith(CHAPTER_EXTENSION) && CHAPTER_NAME.test(name.slice(0, -CHAPTER_EXTENSION.length));
}

async function hasChapterFiles(realm: WorkspaceRealm, directory: string): Promise<boolean> {
  if (await probeType(realm, directory) !== "directory") return false;
  const target = await resolveTarget(realm, directory);
  if (target === undefined) return false;
  return (await listDirectory(realm, target)).some((entry) => entry.type === "file" && isChapterName(entry.name));
}

/** 正文/ 下的书目录（正文/书名/第N章.md）；供当前书缺失时的歧义检测。 */
async function listBookDirectoriesWithChapters(realm: WorkspaceRealm, base: string): Promise<string[]> {
  if (await probeType(realm, base) !== "directory") return [];
  const target = await resolveTarget(realm, base);
  if (target === undefined) return [];
  const books: string[] = [];
  for (const entry of await listDirectory(realm, target)) {
    if (entry.type !== "directory" || entry.name.startsWith(".")) continue;
    const path = `${base}/${entry.name}`;
    if (await hasChapterFiles(realm, path)) books.push(path);
  }
  return books.sort((left, right) => left.localeCompare(right, "zh-Hans-CN"));
}

async function readActiveBook(realm: WorkspaceRealm): Promise<ActiveBookRead> {
  const read = await readTextInside(realm, ACTIVE_BOOK_FILE, ACTIVE_BOOK_MAX_BYTES);
  if (read.kind === "missing") {
    // 不是文件的同名条目同样算“存在但无效”，不能当成没有设置。
    return await probeType(realm, ACTIVE_BOOK_FILE) === undefined
      ? { state: "absent" }
      : { state: "invalid" };
  }
  if (read.kind !== "content") return { state: "invalid" };
  const raw = read.content.trim().replace(/^\.\/+/u, "").replace(/\/+$/u, "");
  if (raw === "" || raw.startsWith("/") || raw.includes("\\") || /^[A-Za-z]:/u.test(raw)) {
    return { state: "invalid" };
  }
  if (raw.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    return { state: "invalid" };
  }
  const target = await resolveTarget(realm, raw);
  if (target === undefined) return { state: "invalid" };
  try {
    if ((await realm.fs.stat(target))?.type !== "directory") return { state: "invalid" };
  } catch {
    return { state: "invalid" };
  }
  return { state: "valid", root: raw };
}

async function listFirstLevelProjectRoots(realm: WorkspaceRealm): Promise<string[]> {
  const roots: string[] = [];
  for (const name of await listChildDirectoryNames(realm)) {
    if (await probeType(realm, `${name}/${STORY_DIRECTORY}`) === "directory") {
      // 空的 书名/正文/ 目录不是一本书，避免把残留目录误报成多书歧义。
      if (await hasChapterFiles(realm, `${name}/${STORY_DIRECTORY}`)) roots.push(name);
      continue;
    }
    if (await probeType(realm, `${name}/${TRACKING_DIRECTORY}`) === "directory"
      || await probeType(realm, `${name}/${DRAMA_DIRECTORY}`) === "directory") {
      roots.push(name);
    }
  }
  return roots;
}

/** 两种书目布局 + 根级项目标记统一成一个候选集合，供当前书判定和歧义风险共用。 */
async function listProjectCandidates(realm: WorkspaceRealm): Promise<string[]> {
  const candidates = new Set<string>();
  if (await probeType(realm, STORY_DIRECTORY) === "directory") {
    if (await hasChapterFiles(realm, STORY_DIRECTORY)) candidates.add("");
    for (const book of await listBookDirectoriesWithChapters(realm, STORY_DIRECTORY)) candidates.add(book);
  }
  for (const root of await listFirstLevelProjectRoots(realm)) candidates.add(root);
  if (candidates.size === 0
    && (await probeType(realm, TRACKING_DIRECTORY) !== undefined
      || await probeType(realm, DRAMA_DIRECTORY) !== undefined
      || await probeType(realm, DRAMA_ROOT_FILE) !== undefined)) {
    candidates.add("");
  }
  return [...candidates].sort((left, right) => left.localeCompare(right, "zh-Hans-CN"));
}

async function detectProject(realm: WorkspaceRealm): Promise<ProjectDetection> {
  const activeBook = await readActiveBook(realm);
  const candidates = await listProjectCandidates(realm);
  if (activeBook.state === "valid" && activeBook.root !== undefined) {
    return { root: activeBook.root, candidates, activeBookState: "valid" };
  }
  // 只有恰好一个候选才自动选中；多书一律回到工作区根并交给 P1，不静默挑第一本。
  return {
    root: candidates.length === 1 ? candidates[0]! : "",
    candidates,
    activeBookState: activeBook.state,
  };
}

async function detectProjectKind(realm: WorkspaceRealm, root: string): Promise<ContinuityProjectKind> {
  if (await probeType(realm, joinPath(root, STORY_DIRECTORY)) === "directory") return "novel";
  if (root.startsWith(`${STORY_DIRECTORY}/`) || await hasChapterFiles(realm, root)) return "novel";
  if (await probeType(realm, joinPath(root, DRAMA_DIRECTORY)) === "directory") return "drama";
  if (await probeType(realm, joinPath(root, DRAMA_ROOT_FILE)) === "file") return "drama";
  if (await probeType(realm, joinPath(root, GAME_DIRECTORY)) === "directory") return "game";
  if (await probeType(realm, joinPath(root, VIDEO_DIRECTORY)) === "directory") return "video";
  return "unknown";
}

function projectTitle(root: string, cwd: string, shelf: readonly ShelfEntry[]): string {
  if (root === "") return basenameOf(cwd) || "工作区";
  return shelf.find((entry) => entry.path === root)?.title ?? basenameOf(root);
}

async function readTrackingAt(realm: WorkspaceRealm, relative: string): Promise<ContinuityTracking> {
  const target = await resolveTarget(realm, relative);
  if (target === undefined) return ABSENT_TRACKING;
  let info;
  try {
    info = await realm.fs.stat(target);
  } catch {
    return INVALID_TRACKING;
  }
  if (info === undefined) return ABSENT_TRACKING;
  if (info.type !== "file") return INVALID_TRACKING;
  if (info.size !== undefined && info.size > TRACKING_MAX_BYTES) return INVALID_TRACKING;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(
      await realm.fs.readBytes(target, undefined, TRACKING_MAX_BYTES)
    );
  } catch {
    return INVALID_TRACKING;
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return INVALID_TRACKING;
  }
  if (!isRecord(value)) return INVALID_TRACKING;
  const rawLast = value["last_committed_chapter"];
  if (rawLast !== undefined && finiteNumber(rawLast) === null) return INVALID_TRACKING;
  const rawRevision = value["state_revision"];
  if (rawRevision !== undefined && finiteNumber(rawRevision) === null) return INVALID_TRACKING;
  return {
    lastChapter: finiteNumber(rawLast),
    stateRevision: finiteNumber(rawRevision),
    source: "tracking",
  };
}

interface TrackingRead {
  readonly tracking: ContinuityTracking;
  readonly path: string | null;
}

async function readTracking(realm: WorkspaceRealm, root: string): Promise<TrackingRead> {
  // 书名目录案（正文/书名/）的追踪可能挂在工作区根，而不是书目录内。
  const candidates = root === ""
    ? [TRACKING_STATE_FILE]
    : [joinPath(root, TRACKING_STATE_FILE), TRACKING_STATE_FILE];
  for (const path of candidates) {
    const tracking = await readTrackingAt(realm, path);
    if (tracking.source !== "absent") return { tracking, path };
  }
  return { tracking: ABSENT_TRACKING, path: null };
}

async function statSize(realm: WorkspaceRealm, target: FsTarget): Promise<number> {
  try {
    return (await realm.fs.stat(target))?.size ?? 0;
  } catch {
    return 0;
  }
}

async function listChapters(realm: WorkspaceRealm, root: string): Promise<ChapterFile[]> {
  const storyDirectory = joinPath(root, STORY_DIRECTORY);
  const directory = await probeType(realm, storyDirectory) === "directory" ? storyDirectory : root;
  if (directory === "" && await probeType(realm, "") !== "directory") return [];
  const target = await resolveTarget(realm, directory);
  if (target === undefined) return [];
  const chapters: ChapterFile[] = [];
  for (const entry of await listDirectory(realm, target)) {
    if (entry.type !== "file" || !isChapterName(entry.name)) continue;
    if (!realm.fs.contains(realm.root, entry.target)) continue;
    const title = entry.name.slice(0, -CHAPTER_EXTENSION.length);
    const match = CHAPTER_NAME.exec(title);
    const ordinal = match?.[1] === undefined ? Number.NaN : Number(match[1]);
    if (!Number.isSafeInteger(ordinal) || ordinal < 0) continue;
    const bytes = entry.size ?? await statSize(realm, entry.target);
    chapters.push({
      ordinal,
      path: directory === "" ? entry.name : `${directory}/${entry.name}`,
      title,
      bytes,
    });
  }
  chapters.sort((left, right) => left.ordinal - right.ordinal || comparePath(left, right));
  return chapters.length > CONTINUITY_MAX_CHAPTERS ? chapters.slice(-CONTINUITY_MAX_CHAPTERS) : chapters;
}

function payoffOrdinal(value: string | undefined): number | null {
  if (value === undefined) return null;
  const match = PAYOFF_DIGITS.exec(value);
  if (match?.[1] === undefined) return null;
  const ordinal = Number(match[1]);
  return Number.isSafeInteger(ordinal) ? ordinal : null;
}

function toContinuityForeshadow(item: Foreshadow): ContinuityForeshadow {
  return {
    id: item.id,
    title: item.title,
    status: item.status,
    chapter: item.chapter,
    plannedPayoffChapter: item.plannedPayoffChapter,
    importance: item.importance,
  };
}

function toContinuityRun(run: TaskRun): ContinuityRun {
  return { id: run.id, kind: run.kind, status: run.status, updatedAt: run.updatedAt };
}

async function countHistoryFiles(realm: WorkspaceRealm): Promise<number> {
  const target = await resolveTarget(realm, HISTORY_DIRECTORY);
  if (target === undefined) return 0;
  const entries = await listDirectory(realm, target);
  return entries.filter(
    (entry) => entry.type === "file"
      && entry.name.endsWith(".jsonl")
      && realm.fs.contains(realm.root, entry.target)
  ).length;
}

async function missingAnalysisBooks(realm: WorkspaceRealm): Promise<readonly string[]> {
  try {
    const books = await listAnalysisBooks(realm.fs, realm.cwd, realm.root);
    const sidecars = new Set(await listSidecarBooks(realm.fs, realm.cwd, realm.root));
    return books.filter((book) => !sidecars.has(book));
  } catch {
    return [];
  }
}

function risk(
  id: ContinuityRiskId,
  level: ContinuityLevel,
  title: string,
  detail: string,
  paths: readonly string[],
  nextAction: string
): ContinuityRisk {
  return {
    id,
    level,
    title,
    detail,
    paths: paths.map(safeWorkspacePath).filter((path): path is string => path !== undefined),
    nextAction,
  };
}

function dueForeshadowsOf(
  foreshadows: readonly Foreshadow[],
  snoozes: readonly SnoozeRecord[],
  nextOrdinal: number,
  now: number
): Foreshadow[] {
  const active = foreshadows.filter((item) => item.status === "planned" || item.status === "planted");
  const due = active.filter((item) => {
    const ordinal = payoffOrdinal(item.plannedPayoffChapter);
    return ordinal !== null && ordinal <= nextOrdinal;
  });
  // 驾驶舱没有“当前章”上下文：按书/按章的 snooze 只在其作用域内生效，
  // 不能在这里被当成全局抑制；只应用按时间或不带作用域的抑制。
  const scoped = snoozes.filter(
    (record) => (record.untilBook === undefined || record.untilBook === "")
      && (record.untilChapter === undefined || record.untilChapter === "")
  );
  return filterSnoozedReminders(due, scoped, now).sort(
    (left, right) => right.importance - left.importance || right.updatedAt - left.updatedAt
  );
}

async function buildRisks(context: RiskContext): Promise<ContinuityRisk[]> {
  const risks: ContinuityRisk[] = [];

  const corrupt = context.inventory.filter((entry) => entry.status === "corrupt");
  if (corrupt.length > 0) {
    risks.push(risk(
      "state-corrupt",
      "P0",
      "状态文件损坏",
      `${corrupt.length} 个状态文档无法解析：${corrupt.map((entry) => entry.path).join("、")}；继续写入会覆盖现场。`,
      corrupt.map((entry) => entry.path),
      "先停止一切写入，到诊断页创建备份保留现场，再按状态修复流程处理。"
    ));
  }

  const secrets = context.inventory.find((entry) => entry.id === "vault-secrets");
  const masterKey = context.inventory.find((entry) => entry.id === "vault-master-key");
  // 盘点是只读探测:密钥信封只报 not-inspected,非 missing 即表示密文仍在。
  if (secrets !== undefined && secrets.status !== "missing" && masterKey?.status === "missing") {
    risks.push(risk(
      "vault-key-missing",
      "P0",
      "密钥库缺少主密钥",
      "密钥库里还有密文，但主密钥 master.key 已不在，当前无法解密；不要覆盖密钥目录。",
      [VAULT_DIRECTORY],
      "先整目录复制 .oh-story/vault/ 留档，确认是否换过机器或清理过主密钥，再决定恢复主密钥还是重置密钥库。"
    ));
  }

  const newer = context.inventory.filter((entry) => entry.status === "newer");
  if (newer.length > 0) {
    risks.push(risk(
      "state-newer",
      "P1",
      "状态文件版本高于当前构建",
      `${newer.length} 个状态文档的版本超出本插件可读范围：${newer.map((entry) => entry.path).join("、")}；当前构建不会改写它们。`,
      newer.map((entry) => entry.path),
      "升级 dsh-miaowu 插件到匹配版本后再写入，不要用当前版本覆盖这些文件。"
    ));
  }

  const failedRuns = context.runs.filter((run) => run.status === "failed");
  if (failedRuns.length > 0) {
    const latest = Math.max(...failedRuns.map((run) => run.updatedAt));
    risks.push(risk(
      "run-failed",
      "P1",
      "有任务运行失败",
      `${failedRuns.length} 个任务处于失败状态，最近一次更新于 ${formatMinute(latest)}。`,
      [TASKS_RUNS_FILE],
      "到工作台任务页查看失败步骤，补齐条件后恢复运行，或结束该任务。"
    ));
  }

  const pausedRuns = context.runs.filter((run) => run.status === "paused");
  if (pausedRuns.length > 0) {
    const latest = Math.max(...pausedRuns.map((run) => run.updatedAt));
    risks.push(risk(
      "run-paused",
      "P1",
      "有任务停在检查点",
      `${pausedRuns.length} 个任务暂停在检查点，最近一次更新于 ${formatMinute(latest)}。`,
      [TASKS_RUNS_FILE],
      "到工作台任务页从检查点恢复运行，确认不需要后结束这些任务。"
    ));
  }

  const proposed = context.candidates.filter((candidate) => candidate.status === "proposed");
  if (proposed.length > 0) {
    const oldest = proposed.map((candidate) => candidate.createdAt).filter((at) => at > 0);
    const ageDays = oldest.length === 0 ? null : Math.floor((context.now - Math.min(...oldest)) / DAY_MS);
    const staleNote = ageDays !== null && ageDays > CONTINUITY_CANDIDATE_STALE_DAYS
      ? `，最早一条已等待 ${ageDays} 天`
      : "";
    risks.push(risk(
      "candidates-pending",
      "P1",
      "候选等待确认",
      `有 ${proposed.length} 条候选待确认${staleNote}，确认前不会写进正文。`,
      [TASKS_CANDIDATES_FILE],
      "到工作台候选页逐条确认或拒绝，确认后再应用。"
    ));
  }

  if (context.dueForeshadows.length > 0) {
    const titles = context.dueForeshadows.slice(0, 3).map((item) => `《${item.title}》`).join("、");
    const more = context.dueForeshadows.length > 3 ? " 等" : "";
    const evidence = [...new Set(
      context.dueForeshadows.flatMap((item) => (item.evidence ?? [])
        .map((ref) => safeWorkspacePath(ref.path))
        .filter((path): path is string => path !== undefined))
    )].slice(0, RISK_PATH_LIMIT);
    risks.push(risk(
      "foreshadow-due",
      "P1",
      "伏笔已到回收章",
      `${context.dueForeshadows.length} 条伏笔的预计回收章不晚于第 ${context.nextOrdinal} 章：${titles}${more}。`,
      evidence.length === 0 ? [".oh-story/foreshadows.json"] : evidence,
      "打开伏笔页核对这些伏笔，在下一章回收或改写预计回收章。"
    ));
  }

  if (context.backups.length === 0) {
    risks.push(risk(
      "backup-missing",
      "P1",
      "还没有可用备份",
      "工作区内没有备份包，误写后无法回滚。",
      [],
      "在连续性驾驶舱点「创建快照」，创建第一份包含正文与状态文件的整体备份。"
    ));
  } else if (context.backupAgeDays !== null && context.backupAgeDays > CONTINUITY_BACKUP_STALE_DAYS) {
    risks.push(risk(
      "backup-stale",
      "P1",
      "备份已过期",
      `最近一次备份在 ${context.backupAgeDays} 天前，超过 ${CONTINUITY_BACKUP_STALE_DAYS} 天的建议间隔。`,
      [],
      "在驾驶舱重新创建整体备份，确认覆盖当前正文与 .oh-story 状态后再继续大批量写作。"
    ));
  }

  const trackingPath = context.trackingPath ?? joinPath(context.root, TRACKING_STATE_FILE);
  if (context.activeBookState === "invalid") {
    risks.push(risk(
      "active-book-invalid",
      "P1",
      "当前书指向无效",
      ".active-book 存在，但内容为空、指向工作区外的路径、指向的目录不存在或不是目录；驾驶舱不会静默改用其它书。",
      [ACTIVE_BOOK_FILE],
      "把 .active-book 改写成当前书目录的工作区相对路径（例如 正文/书名），或删除它让唯一的书自动选中。"
    ));
  }
  if (context.ambiguousBooks.length > 1) {
    const names = context.ambiguousBooks
      .slice(0, 3)
      .map((candidate) => (candidate === "" ? "工作区根" : candidate))
      .join("、");
    const pointer = context.activeBookState === "absent" ? "没有 .active-book" : ".active-book 无效";
    risks.push(risk(
      "active-book-missing",
      "P1",
      "存在多本作品但没有当前书",
      `工作区里有 ${context.ambiguousBooks.length} 个候选书目录/创作根（${names}），${pointer}，无法判断驾驶舱该汇总哪一本。`,
      [ACTIVE_BOOK_FILE, ...context.ambiguousBooks
        .filter((candidate) => candidate !== "")
        .slice(0, RISK_PATH_LIMIT)],
      "在项目根 .active-book 写入当前书目录的相对路径（例如 正文/书名），再刷新驾驶舱。"
    ));
  }

  if (context.tracking.source === "invalid") {
    risks.push(risk(
      "tracking-invalid",
      "P1",
      "追踪状态无法解析",
      "追踪文件存在，但 last_committed_chapter / state_revision 不是有效数字或内容无法读取；追踪进度不会参与风险判断。",
      [trackingPath],
      "检查并修复 追踪/_tracking-state.json；必要时从正文重新生成追踪状态，修复前不要把它当作“已同步”。"
    ));
  }

  const latestOrdinal = context.chapters.at(-1)?.ordinal ?? null;
  if (
    context.tracking.source === "tracking"
    && context.tracking.lastChapter !== null
    && latestOrdinal !== null
    && context.tracking.lastChapter < latestOrdinal
  ) {
    risks.push(risk(
      "tracking-behind",
      "P1",
      "追踪状态落后于正文",
      `追踪记录只到第 ${context.tracking.lastChapter} 章，正文已经写到第 ${latestOrdinal} 章。`,
      [trackingPath],
      "按追踪工作流运行 tracking_commit.py check 并补齐提交，让追踪状态与正文一致。"
    ));
  }

  const latest = context.chapters.at(-1);
  if (latest !== undefined) {
    const versions = await listVersions(context.realm, latest.path).catch(() => []);
    if (versions.length === 0) {
      risks.push(risk(
        "history-missing",
        "P2",
        "最新章没有历史快照",
        `第 ${latest.ordinal} 章还没有任何历史版本，误改后无法回滚。`,
        [latest.path],
        "打开该章并保存一次，生成第一份历史快照。"
      ));
    }
  }

  const searchMeta = context.inventory.find((entry) => entry.id === "search-meta");
  if (searchMeta?.status === "missing") {
    risks.push(risk(
      "search-index-missing",
      "P2",
      "尚未建立检索索引",
      "全文检索没有索引文件，搜索会退化为实时扫描，长篇项目会变慢。",
      [INDEX_DIRECTORY],
      "到诊断页执行「重建检索索引」。"
    ));
  }

  const missingBooks = await missingAnalysisBooks(context.realm);
  if (missingBooks.length > 0) {
    const names = missingBooks.slice(0, 3).join("、");
    const more = missingBooks.length > 3 ? " 等" : "";
    risks.push(risk(
      "analysis-missing",
      "P2",
      "拆书结果不完整",
      `拆文库有 ${missingBooks.length} 本书缺少结构化 sidecar：${names}${more}。`,
      [ANALYSIS_DIRECTORY],
      "到拆书页对缺少结果的书重新解析，生成 sidecar 后再检索。"
    ));
  }

  const expiring = context.shelf
    .filter((entry) => entry.deletedAt !== undefined
      && entry.deleteAfter !== undefined
      && entry.deleteAfter - context.now <= RECYCLE_WARNING_DAYS * DAY_MS)
    .sort((left, right) => (left.deleteAfter ?? 0) - (right.deleteAfter ?? 0));
  if (expiring.length > 0) {
    const names = expiring.slice(0, 3).map((entry) => entry.title).join("、");
    const more = expiring.length > 3 ? " 等" : "";
    risks.push(risk(
      "recycle-expiring",
      "P2",
      "回收站条目即将清理",
      `${expiring.length} 个作品会在 ${RECYCLE_WARNING_DAYS} 天内（或已经）从回收站永久移除：${names}${more}。`,
      expiring.slice(0, RISK_PATH_LIMIT).map((entry) => entry.path),
      "到书架回收站把作品恢复到新项目，或确认放弃。"
    ));
  }

  return risks.sort((left, right) => CONTINUITY_LEVEL_ORDER[left.level] - CONTINUITY_LEVEL_ORDER[right.level]
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

export async function buildContinuityOverview(
  realm: WorkspaceRealm,
  now: number = Date.now()
): Promise<ContinuityOverview> {
  const detection = await detectProject(realm);
  const root = detection.root;
  const kind = await detectProjectKind(realm, root);
  const [shelf, allShelf, trackingRead, chapters, foreshadows, snoozes, runs, candidates, audit, backups, historyFiles, inventory] = await Promise.all([
    listShelf(realm),
    loadShelf(realm),
    readTracking(realm, root),
    kind === "drama" ? Promise.resolve<ChapterFile[]>([]) : listChapters(realm, root),
    loadForeshadows(realm, STORE_MAX_BYTES),
    loadSnoozes(realm, STORE_MAX_BYTES),
    loadRuns(realm),
    loadCandidates(realm),
    queryAudit(realm, undefined, AUDIT_SCAN_LIMIT),
    listBackups(realm),
    countHistoryFiles(realm),
    buildStateInventory(realm),
  ]);
  const tracking = trackingRead.tracking;
  const ambiguousBooks = detection.activeBookState !== "valid" && detection.candidates.length > 1
    ? detection.candidates
    : [];

  const latest = chapters.at(-1);
  const nextChapter: ContinuityNextChapter = {
    ordinal: latest === undefined ? 1 : Math.max(latest.ordinal + 1, 1),
    latestPath: latest?.path ?? null,
    latestTitle: latest?.title ?? null,
  };

  const due = dueForeshadowsOf(foreshadows, snoozes, nextChapter.ordinal, now);
  const proposed = candidates.filter((candidate) => candidate.status === "proposed");
  const recentSaves: ContinuitySave[] = [];
  for (const entry of audit) {
    const path = safeWorkspacePath(entry.path);
    if (path === undefined) continue;
    recentSaves.push({ path, version: entry.version, timestamp: entry.timestamp });
    if (recentSaves.length >= RECENT_SAVE_LIMIT) break;
  }

  let lastBackupAt: number | null = null;
  for (const backup of backups) {
    if (lastBackupAt === null || backup.createdAt > lastBackupAt) lastBackupAt = backup.createdAt;
  }
  const backupAgeDays = lastBackupAt === null ? null : Math.floor((now - lastBackupAt) / DAY_MS);

  const today: ContinuityToday = {
    nextChapter,
    dueForeshadows: due.slice(0, TODAY_FORESHADOW_LIMIT).map(toContinuityForeshadow),
    pausedRuns: runs
      .filter((run) => run.status === "paused" || run.status === "failed")
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, TODAY_RUN_LIMIT)
      .map(toContinuityRun),
    proposedCandidates: proposed.length,
    recentSaves,
    lastBackupAt,
    backupAgeDays,
  };

  const foreshadowCounts = { planned: 0, planted: 0, resolved: 0, abandoned: 0 };
  for (const item of foreshadows) foreshadowCounts[item.status] += 1;
  const runCounts = { active: 0, paused: 0, failed: 0, completed: 0 };
  for (const run of runs) {
    if (run.status === "paused") runCounts.paused += 1;
    else if (run.status === "failed") runCounts.failed += 1;
    else if (run.status === "completed") runCounts.completed += 1;
    else if (run.status === "pending" || run.status === "running" || run.status === "awaiting_user") runCounts.active += 1;
  }
  const candidateCounts = {
    proposed: proposed.length,
    // 修订后的旧版状态是 amended:同样属于「已确认过、只是被新版取代」的候选。
    confirmed: candidates.filter((candidate) => candidate.status === "confirmed" || candidate.status === "amended").length,
    applied: candidates.filter((candidate) => candidate.status === "applied").length,
  };
  const anomalies: ContinuityStateAnomaly[] = inventory.entries
    .filter((entry) => entry.status === "corrupt" || entry.status === "newer" || entry.status === "not-inspected")
    .map((entry) => ({ id: entry.id, path: entry.path, status: entry.status }));

  const stats: ContinuityStats = {
    chapters: chapters.length,
    chapterBytes: chapters.reduce((total, chapter) => total + chapter.bytes, 0),
    foreshadows: foreshadowCounts,
    runs: runCounts,
    candidates: candidateCounts,
    backups: backups.length,
    historyFiles,
    auditEntries: audit.length,
    books: shelf.length,
    anomalies,
  };

  const project: ContinuityProject = {
    kind,
    title: projectTitle(root, realm.cwd, allShelf.entries),
    root,
    tracking,
  };

  const risks = await buildRisks({
    realm,
    now,
    root,
    chapters,
    tracking,
    trackingPath: trackingRead.path,
    activeBookState: detection.activeBookState,
    ambiguousBooks,
    nextOrdinal: nextChapter.ordinal,
    dueForeshadows: due,
    runs,
    candidates,
    backups,
    backupAgeDays,
    inventory: inventory.entries,
    shelf: allShelf.entries,
  });

  return {
    generatedAt: new Date(now).toISOString(),
    readOnly: true,
    project,
    today,
    stats,
    risks,
  };
}

type TextRead =
  | { readonly kind: "content"; readonly content: string }
  | { readonly kind: "missing" }
  | { readonly kind: "skipped"; readonly reason: ContinuityHandoffSkipReason };

async function readTextInside(realm: WorkspaceRealm, relative: string, maxBytes: number): Promise<TextRead> {
  const target = await resolveTarget(realm, relative);
  if (target === undefined) return { kind: "missing" };
  let info;
  try {
    info = await realm.fs.stat(target);
  } catch {
    return { kind: "skipped", reason: "unreadable" };
  }
  if (info?.type !== "file") return { kind: "missing" };
  if (info.size !== undefined && info.size > maxBytes) return { kind: "skipped", reason: "too-large" };
  let bytes: Uint8Array;
  try {
    bytes = await realm.fs.readBytes(target, undefined, maxBytes);
  } catch (error) {
    return {
      kind: "skipped",
      reason: error instanceof Error && /TOO_LARGE|TOO_BIG/iu.test(error.message) ? "too-large" : "unreadable",
    };
  }
  try {
    return { kind: "content", content: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { kind: "skipped", reason: "non-utf8" };
  }
}

interface HandoffWalkState {
  truncated: boolean;
}

async function walkHistoryFiles(
  realm: WorkspaceRealm,
  directory: FsTarget,
  prefix: string,
  maxBytes: number,
  depth: number,
  out: Array<[string, string]>,
  skipped: ContinuityHandoffSkipped[],
  state: HandoffWalkState
): Promise<void> {
  if (depth > HISTORY_WALK_DEPTH) {
    skipped.push({ path: prefix, reason: "depth-limit" });
    return;
  }
  if (out.length >= CONTINUITY_MAX_HANDOFF_FILES) {
    state.truncated = true;
    return;
  }
  for (const entry of await listDirectory(realm, directory)) {
    if (!realm.fs.contains(realm.root, entry.target)) continue;
    const path = `${prefix}/${entry.name}`;
    if (entry.type === "directory") {
      await walkHistoryFiles(realm, entry.target, path, maxBytes, depth + 1, out, skipped, state);
      if (state.truncated) return;
      continue;
    }
    if (entry.type !== "file" || !entry.name.endsWith(".jsonl")) continue;
    const read = await readTextInside(realm, path, maxBytes);
    if (read.kind === "content") out.push([path, read.content]);
    else if (read.kind === "skipped") skipped.push({ path, reason: read.reason });
    if (out.length >= CONTINUITY_MAX_HANDOFF_FILES) {
      state.truncated = true;
      return;
    }
  }
}

async function collectStateFiles(
  realm: WorkspaceRealm,
  root: string,
  maxBytes: number,
  skipped: ContinuityHandoffSkipped[],
  state: HandoffWalkState
): Promise<Array<[string, string]>> {
  const out: Array<[string, string]> = [];
  for (const path of STATE_FILES) {
    const read = await readTextInside(realm, path, maxBytes);
    if (read.kind === "content") out.push([path, read.content]);
    else if (read.kind === "skipped") skipped.push({ path, reason: read.reason });
  }
  const analysis = await resolveTarget(realm, ANALYSIS_DIRECTORY);
  if (analysis !== undefined) {
    for (const entry of await listDirectory(realm, analysis)) {
      if (entry.type !== "file" || !entry.name.endsWith(".json")) continue;
      const path = `${ANALYSIS_DIRECTORY}/${entry.name}`;
      const read = await readTextInside(realm, path, maxBytes);
      if (read.kind === "content") out.push([path, read.content]);
      else if (read.kind === "skipped") skipped.push({ path, reason: read.reason });
    }
  }
  const history = await resolveTarget(realm, HISTORY_DIRECTORY);
  if (history !== undefined) {
    await walkHistoryFiles(realm, history, HISTORY_DIRECTORY, maxBytes, 0, out, skipped, state);
  }
  const drama = joinPath(root, DRAMA_ROOT_FILE);
  const dramaRead = await readTextInside(realm, drama, maxBytes);
  if (dramaRead.kind === "content") out.push([drama, dramaRead.content]);
  else if (dramaRead.kind === "skipped") skipped.push({ path: drama, reason: dramaRead.reason });
  return out;
}

async function excludedDirectories(realm: WorkspaceRealm): Promise<string[]> {
  const excluded: string[] = [...EXCLUDED_DIRECTORIES];
  const tasks = await resolveTarget(realm, TASKS_DIRECTORY);
  if (tasks !== undefined) {
    const others = (await listDirectory(realm, tasks)).some(
      (entry) => entry.name !== "runs.json" && entry.name !== "candidates.json"
    );
    if (others) excluded.push(".oh-story/tasks/ 下除 runs.json、candidates.json 之外的文件");
  }
  return excluded;
}

function handoffFile(path: string, content: string): ContinuityHandoffFile {
  return { path, bytes: Buffer.byteLength(content, "utf8"), sha256: sha256(content) };
}

function handoffChecksum(files: readonly ContinuityHandoffFile[]): string {
  return sha256([...files].sort(comparePath).map((file) => `${file.path}\0${file.sha256}`).join("\n"));
}

export async function buildContinuityHandoff(
  realm: WorkspaceRealm,
  maxBytes: number,
  now: number = Date.now()
): Promise<ContinuityHandoffManifest> {
  const detection = await detectProject(realm);
  if (detection.root === "" && detection.candidates.length > 1) {
    // 多书歧义时只交出一部分创作树会误导接收方，必须先在 .active-book 选定一本。
    throw new WorkspaceHttpError(409, "工作区存在多本作品，请先在 .active-book 指定当前书，再生成交接清单。");
  }
  const root = detection.root;
  const skipped: ContinuityHandoffSkipped[] = [];
  const creative = await collectScopeFiles(
    realm,
    root === "" ? undefined : root,
    maxBytes,
    (path, reason) => { skipped.push({ path, reason }); }
  );
  if (creative.length >= CONTINUITY_MAX_HANDOFF_FILES) {
    // 备份收集器在 2000 个文件处静默截断；交接清单不能把截断当成完整。
    throw new WorkspaceHttpError(413, "交接清单文件过多，请缩小项目范围。");
  }
  const collected = new Map<string, ContinuityHandoffFile>();
  for (const file of creative) collected.set(file.path, handoffFile(file.path, file.content));
  const walkState: HandoffWalkState = { truncated: false };
  for (const [path, content] of await collectStateFiles(realm, root, maxBytes, skipped, walkState)) {
    if (!collected.has(path)) collected.set(path, handoffFile(path, content));
  }
  if (walkState.truncated) {
    throw new WorkspaceHttpError(413, "交接清单文件过多，请缩小项目范围。");
  }
  const files = [...collected.values()].sort(comparePath);
  if (files.length >= CONTINUITY_MAX_HANDOFF_FILES) {
    throw new WorkspaceHttpError(413, "交接清单文件过多，请缩小项目范围。");
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date(now).toISOString(),
    root,
    files,
    checksum: handoffChecksum(files),
    skipped: skipped.sort(comparePath),
    excluded: [
      ...await excludedDirectories(realm),
      "二进制与非文本扩展名（交接清单只覆盖文本资产）",
      "超过单文件上限的文本（不进入 files；可读的状态与创作文本会列入 skipped）",
    ],
  };
}

const HANDOFF_SHA256 = /^[0-9a-f]{64}$/u;
const HANDOFF_SKIP_REASONS: readonly ContinuityHandoffSkipReason[] = [
  "too-large",
  "non-utf8",
  "unreadable",
  "depth-limit",
];

function asHandoffManifest(value: unknown): ContinuityHandoffManifest | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1
    || typeof record.generatedAt !== "string"
    || typeof record.root !== "string"
    || typeof record.checksum !== "string"
    || !HANDOFF_SHA256.test(record.checksum)
    || !Array.isArray(record.files)
    || !Array.isArray(record.skipped)
    || !Array.isArray(record.excluded)) {
    return undefined;
  }
  const seen = new Set<string>();
  const files: ContinuityHandoffFile[] = [];
  for (const item of record.files) {
    if (typeof item !== "object" || item === null) return undefined;
    const file = item as Record<string, unknown>;
    if (typeof file.path !== "string" || file.path === "" || seen.has(file.path)) return undefined;
    if (typeof file.bytes !== "number" || !Number.isSafeInteger(file.bytes) || file.bytes < 0) return undefined;
    if (typeof file.sha256 !== "string" || !HANDOFF_SHA256.test(file.sha256)) return undefined;
    seen.add(file.path);
    files.push({ path: file.path, bytes: file.bytes, sha256: file.sha256 });
  }
  const skipped: ContinuityHandoffSkipped[] = [];
  for (const item of record.skipped) {
    if (typeof item !== "object" || item === null) return undefined;
    const skip = item as Record<string, unknown>;
    if (typeof skip.path !== "string" || !HANDOFF_SKIP_REASONS.includes(skip.reason as ContinuityHandoffSkipReason)) {
      return undefined;
    }
    skipped.push({ path: skip.path, reason: skip.reason as ContinuityHandoffSkipReason });
  }
  if (record.excluded.some((item) => typeof item !== "string")) return undefined;
  return {
    schemaVersion: 1,
    generatedAt: record.generatedAt,
    root: record.root,
    files,
    checksum: record.checksum,
    skipped,
    excluded: record.excluded as string[],
  };
}

/**
 * 校验一份交接清单：只读当前工作区并逐文件比对 sha256，绝不写入。
 * 清单自身的 checksum 先复算；不完整（有 skipped）或任一文件不匹配都不算 ok。
 */
export async function verifyContinuityHandoff(
  realm: WorkspaceRealm,
  input: unknown,
  maxBytes: number
): Promise<ContinuityHandoffVerifyResult> {
  const manifest = asHandoffManifest(input);
  if (manifest === undefined) throw new WorkspaceHttpError(400, "交接清单结构不合法。");
  const checksumOk = handoffChecksum(manifest.files) === manifest.checksum;
  const results: ContinuityHandoffVerifyFile[] = [];
  for (const file of manifest.files) {
    if (!safeBundlePath(file.path)) {
      results.push({ path: file.path, status: "unsafe" });
      continue;
    }
    let target: FsTarget;
    try {
      target = await realm.fs.resolve(file.path, { cwd: realm.cwd });
    } catch {
      results.push({ path: file.path, status: "unreadable" });
      continue;
    }
    if (!realm.fs.contains(realm.root, target)) {
      results.push({ path: file.path, status: "unsafe" });
      continue;
    }
    let status: ContinuityHandoffVerifyStatus;
    try {
      const current = await readVersionedFile(realm.fs, target, maxBytes);
      status = sha256(current.content) === file.sha256 ? "match" : "changed";
    } catch {
      try {
        status = (await realm.fs.stat(target)) === undefined ? "missing" : "unreadable";
      } catch {
        status = "unreadable";
      }
    }
    results.push({ path: file.path, status });
  }
  const matched = results.filter((file) => file.status === "match").length;
  return {
    ok: checksumOk && manifest.skipped.length === 0 && matched === manifest.files.length,
    checksumOk,
    checked: manifest.files.length,
    matched,
    skipped: manifest.skipped,
    files: results,
  };
}

export async function createContinuitySnapshot(
  realm: WorkspaceRealm,
  maxBytes: number,
  now: number = Date.now()
): Promise<ContinuitySnapshotResult> {
  const detection = await detectProject(realm);
  if (detection.root === "" && detection.candidates.length > 1) {
    throw new WorkspaceHttpError(409, "工作区存在多本作品，请先在 .active-book 指定当前书，再创建快照。");
  }
  // 驾驶舱承诺保护“当前书 + .oh-story 状态”，只有 full 会同时收录状态目录；
  // root 作为额外收录范围补上 `书名/正文/` 这类不在标准创作根下的书。
  // requireComplete 拒绝 2000 文件截断与超限跳过，避免把不完整快照报成成功。
  // full 仍不含 DSH 会话与 vault/master.key。
  const outcome = await createBackup(
    realm,
    "full",
    detection.root === "" ? undefined : detection.root,
    maxBytes,
    now,
    { requireComplete: true }
  );
  return {
    path: outcome.path,
    counts: { files: outcome.counts.files, bytes: outcome.counts.bytes },
  };
}

const PRE_WRITE_SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;

interface PreWriteSnapshotState {
  lastAt: number;
  inFlight: Promise<boolean> | undefined;
}

/** 按文件系统实例节流；同一工作区连续回滚/应用候选不重复写前快照。 */
const preWriteSnapshots = new WeakMap<object, PreWriteSnapshotState>();

function preWriteSnapshotError(error: unknown): WorkspaceHttpError {
  const detail = error instanceof WorkspaceHttpError
    ? error.message
    : error instanceof Error ? error.message : String(error);
  return new WorkspaceHttpError(500, `写入前自动快照失败，已阻止本次写入：${detail}`);
}

/**
 * 高风险整文件覆盖前的安全快照。
 *
 * 非创作工作区与多书歧义（自动路径不替用户选书）静默跳过；节流窗口内复用上一次
 * 成功快照；其余失败一律抛 500 阻断写入——没有安全网时不覆盖正文。快照只写
 * `.oh-story/backup/`，不含 DSH 会话与 vault 主密钥。
 */
export async function snapshotBeforeHighRiskWrite(
  realm: WorkspaceRealm,
  maxBytes: number,
  now: number = Date.now()
): Promise<void> {
  const key = realm.fs as object;
  const existing = preWriteSnapshots.get(key);
  if (existing?.inFlight !== undefined) {
    try {
      await existing.inFlight;
      return;
    } catch (error) {
      throw preWriteSnapshotError(error);
    }
  }
  if (existing !== undefined && now - existing.lastAt < PRE_WRITE_SNAPSHOT_INTERVAL_MS) return;
  // 判定与写盘都放进同一个 in-flight promise，并发写入共享一次快照。
  const next: PreWriteSnapshotState = { lastAt: existing?.lastAt ?? 0, inFlight: undefined };
  const pending = (async (): Promise<boolean> => {
    const detection = await detectProject(realm);
    if (detection.candidates.length === 0) return false;
    if (detection.root === "" && detection.candidates.length > 1) return false;
    // 只收创作树，不重收 `.oh-story`：历史 JSONL 会随版本累积并可能超过单文件上限，
    // 把自动快照拖成必然 413，反而永久阻断回滚。状态目录仍有手动整体快照保护。
    await createBackup(
      realm,
      "snapshot",
      detection.root === "" ? undefined : detection.root,
      maxBytes,
      now,
      { requireComplete: true }
    );
    return true;
  })();
  next.inFlight = pending;
  preWriteSnapshots.set(key, next);
  let created: boolean;
  try {
    created = await pending;
  } catch (error) {
    if (preWriteSnapshots.get(key) === next) preWriteSnapshots.delete(key);
    throw preWriteSnapshotError(error);
  } finally {
    next.inFlight = undefined;
  }
  if (created) next.lastAt = now;
}
