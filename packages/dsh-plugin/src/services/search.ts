import { createHash } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { FileSystem, FsTarget } from "@deepseek-ai/dsh-fs";
import {
  creativeTarget,
  readVersionedFile,
  send,
  workspaceRealm,
  type WorkspaceRealm,
  type WorkspaceRouteOptions,
} from "../workspace-route.js";
import { registerWorkspaceExtension } from "./registry.js";
import { pinyinInitials, pinyinize } from "./pinyin-map.js";

/**
 * 全文检索(功能 A2):文件扫描 + 行级内存索引 + JSON 轻量持久化.
 * 做法参考 Scriverse chapter_paragraph_search(段落索引 + 短词拼音双通道 +
 * 段落→行号映射), 但本插件禁止 SQLite, 故用 `.oh-story/index/` 下的单文件
 * JSON + meta 清单做持久化, 查询时对候选做 version 懒核对(Scriverse
 * source_versions 过期语义的轻量版).
 */

export interface SearchFileIndex {
  readonly path: string;
  readonly version: string;
  readonly lines: readonly string[];
}

export interface SearchHit {
  readonly path: string;
  readonly line: number;
  readonly text: string;
  readonly offset: number;
  readonly via: "text" | "pinyin";
}

export interface SearchOutcome {
  readonly query: string;
  readonly tookMs: number;
  readonly total: number;
  readonly hits: readonly SearchHit[];
}

const INDEX_DIR = ".oh-story/index";
const META_NAME = "meta.json";
const INDEXABLE_EXTENSIONS = new Set([".md", ".txt", ".json", ".jsonl"]);
// 创作白名单目录 + 拆文库(workspace 根拆书目录, 不在创作白名单但也要检索)
// + 两类工程目录(文本产物可检索, 重产物子目录另由 excludedProjectPath 减去).
const SEARCH_ROOTS = [
  "正文",
  "大纲",
  "设定",
  "追踪",
  "对标",
  "参考资料",
  "剧集",
  "输入",
  "项目开发",
  "设定集",
  "交付",
  "创作者决策",
  "审查",
  "拆文库",
  "game-adaptations",
  "video-recaps",
] as const;
const GAME_DIRECTORY = "game-adaptations";
const VIDEO_DIRECTORY = "video-recaps";
/** 游戏重型顶层目录: build/** 为 web 可玩构建产物(文件多且为生成物), 整树不索引. */
const GAME_HEAVY_TOP_DIRS = new Set(["build"]);
/** 视频重型目录: sources/ 与 outputs/ 为媒体整树排除; work/ 下重型中间目录与 video-project.ts SKIPPED_DIRECTORIES 同口径. */
const VIDEO_HEAVY_TOP_DIRS = new Set(["sources", "outputs"]);
const VIDEO_WORK_HEAVY_DIRS = new Set(["frames", "asr_chunks", "chunks", "cache", "tmp", ".subtitle_measure"]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const MAX_FILES_PER_SEARCH = 2000;
const MAX_LINE_LENGTH = 4000;

function indexableExtension(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  return INDEXABLE_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

/**
 * 重产物排除(单一谓词, searchablePath 与目录遍历共享口径, 避免两处漂移).
 * 当初整目录排除的动机是 build 构建产物与视频媒体/中间目录量大且多为二进制,
 * 会拖慢索引并污染结果; 但整目录一刀切把两类工程的文本产物(设计文档、解说词)
 * 也屏蔽了. 现收窄为重产物子目录, 文本产物保留可检索:
 * - game-adaptations/<项目>/build/** 整树排除(web 构建生成物);
 *   PRODUCT_BRIEF.md / analysis/ / concepts/ / design/ / qa/ 等文本保留.
 *   (examples/jin-ping-mei 大例子在 skills 知识目录不在 workspace 内, 无需处理;
 *   qa/verification.json 为小文本, 靠 2MB 上限兜底, 保留可检索.)
 * - video-recaps/<项目>/sources/** 与 outputs/** 整树排除(源片与成片媒体);
 *   work/ 下仅排除重型中间目录(与 video-project.ts SKIPPED_DIRECTORIES 同口径),
 *   work/ 根的 narration.json / timeline.json 等解说与计划文本保留.
 */
export function excludedHeavyPath(path: string): boolean {
  const parts = path.split("/");
  if (parts[0] === GAME_DIRECTORY) {
    return parts.length >= 3 && GAME_HEAVY_TOP_DIRS.has(parts[2] ?? "");
  }
  if (parts[0] === VIDEO_DIRECTORY) {
    if (parts.length >= 3 && VIDEO_HEAVY_TOP_DIRS.has(parts[2] ?? "")) return true;
    if (parts[2] === "work" && parts.slice(3).some((part) => VIDEO_WORK_HEAVY_DIRS.has(part))) {
      return true;
    }
    return false;
  }
  return false;
}

/** 是否纳入检索范围: 跳过点开头路径与重产物子树, 其余走创作白名单 + 文本扩展名. */
export function searchablePath(path: string): boolean {
  if (path === "" || path.split("/").some((segment) => segment.startsWith("."))) return false;
  if (excludedHeavyPath(path)) return false;
  const root = path.split("/", 1)[0] ?? "";
  if (!(SEARCH_ROOTS as readonly string[]).includes(root)) return false;
  return indexableExtension(path);
}

function indexFileName(path: string): string {
  return `${createHash("sha256").update(path, "utf8").digest("hex").slice(0, 16)}.json`;
}

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/gu, "");
}

function isAsciiQuery(query: string): boolean {
  return query !== "" && /^[a-z0-9]+$/u.test(query);
}

/** 全文字符偏移: 前面各行长度(含换行) + 本行内命中起点. */
export function lineHitOffset(lines: readonly string[], lineIndex: number, column: number): number {
  let offset = 0;
  for (let i = 0; i < lineIndex; i += 1) offset += (lines[i]?.length ?? 0) + 1;
  return offset + column;
}

/**
 * 行级双通道命中: 原文 includes(大小写不敏感) + 纯 ASCII 查询时的拼音通道.
 * 拼音通道同时试全拼串与首字母串(如 jinpingmei / jpm 命中"金瓶梅").
 */
export function matchLines(
  lines: readonly string[],
  query: string,
  path: string
): SearchHit[] {
  const normalized = normalizeQuery(query);
  if (normalized === "") return [];
  const folded = query.trim().toLowerCase();
  const ascii = isAsciiQuery(normalized);
  const hits: SearchHit[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i] ?? "";
    const line = i + 1;
    const at = text.toLowerCase().indexOf(folded);
    if (at >= 0) {
      hits.push({ path, line, text, offset: lineHitOffset(lines, i, at), via: "text" });
      seen.add(line);
      continue;
    }
    if (!ascii) continue;
    const full = pinyinize(text);
    const fullAt = full.indexOf(normalized);
    if (fullAt >= 0 && !seen.has(line)) {
      // 拼音串与原文非 1:1 对齐, offset 回退为行首偏移, 仍可定位到行.
      hits.push({ path, line, text, offset: lineHitOffset(lines, i, 0), via: "pinyin" });
      seen.add(line);
      continue;
    }
    if (pinyinInitials(text).includes(normalized) && !seen.has(line)) {
      hits.push({ path, line, text, offset: lineHitOffset(lines, i, 0), via: "pinyin" });
      seen.add(line);
    }
  }
  return hits;
}

/**
 * 排序约定: 命中多的文件在前(文件内保持行序), 同文件内按行号.
 * 文件顺序用 hits 数量降序, 数量相同按 path 字典序稳定输出.
 */
export function rankHits(hits: readonly SearchHit[], limit: number): readonly SearchHit[] {
  const counts = new Map<string, number>();
  for (const hit of hits) counts.set(hit.path, (counts.get(hit.path) ?? 0) + 1);
  return [...hits]
    .sort((left, right) => {
      const byFile = (counts.get(right.path) ?? 0) - (counts.get(left.path) ?? 0);
      if (byFile !== 0) return byFile;
      if (left.path !== right.path) return left.path < right.path ? -1 : 1;
      return left.line - right.line;
    })
    .slice(0, Math.max(0, limit));
}

export function searchIndexes(
  indexes: ReadonlyMap<string, SearchFileIndex>,
  query: string,
  limit: number,
  fileFilter?: string
): SearchHit[] {
  const out: SearchHit[] = [];
  for (const [path, index] of indexes) {
    if (fileFilter !== undefined && fileFilter !== "" && !path.includes(fileFilter)) continue;
    out.push(...matchLines(index.lines, query, path));
  }
  return [...rankHits(out, limit)];
}

async function resolveIndexTarget(realm: WorkspaceRealm, name: string): Promise<FsTarget | undefined> {
  const target = await realm.fs.resolve(`${INDEX_DIR}/${name}`, { cwd: realm.cwd });
  return realm.fs.contains(realm.root, target) ? target : undefined;
}

async function readJsonTarget(fs: FileSystem, target: FsTarget): Promise<unknown> {
  const info = await fs.stat(target);
  if (info?.type !== "file") return undefined;
  try {
    const bytes = await fs.readBytes(target, undefined, MAX_FILE_BYTES);
    return JSON.parse(new TextDecoder("utf-8").decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
}

function asFileIndex(value: unknown, path: string): SearchFileIndex | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.path !== path || typeof record.version !== "string" || !Array.isArray(record.lines)) {
    return undefined;
  }
  const lines = record.lines.every((line): line is string => typeof line === "string")
    ? record.lines.map((line) => line.slice(0, MAX_LINE_LENGTH))
    : undefined;
  if (lines === undefined) return undefined;
  return { path, version: record.version, lines };
}

async function loadMeta(realm: WorkspaceRealm): Promise<Record<string, string>> {
  const target = await resolveIndexTarget(realm, META_NAME);
  if (target === undefined) return {};
  const value = await readJsonTarget(realm.fs, target);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [path, hash] of Object.entries(value as Record<string, unknown>)) {
    if (typeof hash === "string" && searchablePath(path)) out[path] = hash;
  }
  return out;
}

async function saveMeta(realm: WorkspaceRealm, meta: Record<string, string>): Promise<void> {
  const target = await resolveIndexTarget(realm, META_NAME);
  if (target === undefined) return;
  // 前置条件: `.oh-story/index` 目录由宿主工作区初始化时创建(与 `.oh-story/` 本身一样);
  // 缺失时 writeText 抛错并显式暴露, 不静默重建目录.
  await realm.fs.writeText(target, JSON.stringify(meta), undefined, undefined, undefined);
}

async function loadFileIndex(realm: WorkspaceRealm, path: string): Promise<SearchFileIndex | undefined> {
  const target = await resolveIndexTarget(realm, indexFileName(path));
  if (target === undefined) return undefined;
  return asFileIndex(await readJsonTarget(realm.fs, target), path);
}

async function saveFileIndex(realm: WorkspaceRealm, index: SearchFileIndex): Promise<void> {
  const target = await resolveIndexTarget(realm, indexFileName(index.path));
  if (target === undefined) return;
  await realm.fs.writeText(
    target,
    JSON.stringify({ path: index.path, version: index.version, lines: index.lines }),
    undefined,
    undefined,
    undefined
  );
}

/** 读文件并切行建索引, version 取 fs.stat 的 opaque 版本. */
export async function buildFileIndex(
  realm: Pick<WorkspaceRealm, "fs" | "cwd" | "root">,
  path: string
): Promise<SearchFileIndex | undefined> {
  const target = await realm.fs.resolve(path, { cwd: realm.cwd });
  if (!realm.fs.contains(realm.root, target)) return undefined;
  const file = await readVersionedFile(realm.fs, target, MAX_FILE_BYTES);
  const version = String(file.version);
  return { path, version, lines: file.content.split(/\r?\n/u).map((line) => line.slice(0, MAX_LINE_LENGTH)) };
}

/**
 * 懒增量核对: stat version 与索引 version 不一致则重读该文件刷新索引.
 * 返回 undefined 表示文件已消失(调用方顺带清理 meta).
 */
export async function ensureFreshIndex(
  realm: Pick<WorkspaceRealm, "fs" | "cwd" | "root">,
  path: string,
  cached: SearchFileIndex | undefined
): Promise<SearchFileIndex | undefined> {
  const target = await realm.fs.resolve(path, { cwd: realm.cwd });
  if (!realm.fs.contains(realm.root, target)) return undefined;
  const info = await realm.fs.stat(target);
  if (info?.type !== "file") return undefined;
  if (cached !== undefined && String(info.version) === cached.version) return cached;
  return buildFileIndex(realm, path);
}

async function collectWorkspaceFiles(realm: WorkspaceRealm): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: FsTarget, prefix: string): Promise<void> => {
    const entries = await realm.fs.listDir(dir);
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (!realm.fs.contains(realm.root, entry.target) && !realm.fs.contains(dir, entry.target)) continue;
      const childPath = `${prefix}/${entry.name}`;
      if (entry.type === "directory") {
        // 重产物子树整枝剪掉(与 searchablePath 同一谓词, 口径不漂移).
        if (excludedHeavyPath(childPath)) continue;
        if (searchablePath(childPath)) continue;
        const root = childPath.split("/", 1)[0] ?? "";
        if (!(SEARCH_ROOTS as readonly string[]).includes(root)) continue;
        if (found.length < MAX_FILES_PER_SEARCH) await walk(entry.target, childPath);
      } else if (entry.type === "file" && searchablePath(childPath)) {
        found.push(childPath);
      }
      if (found.length >= MAX_FILES_PER_SEARCH) return;
    }
  };
  for (const root of SEARCH_ROOTS) {
    const target = await realm.fs.resolve(root, { cwd: realm.cwd });
    if (!realm.fs.contains(realm.root, target)) continue;
    if ((await realm.fs.stat(target))?.type !== "directory") continue;
    await walk(target, root);
    if (found.length >= MAX_FILES_PER_SEARCH) break;
  }
  return found.sort();
}

export async function refreshSingleFile(realm: WorkspaceRealm, path: string): Promise<SearchFileIndex | undefined> {
  if (!searchablePath(path)) return undefined;
  const index = await buildFileIndex(realm, path).catch(() => undefined);
  if (index === undefined) return undefined;
  await saveFileIndex(realm, index);
  const meta = await loadMeta(realm);
  meta[path] = indexFileName(path);
  await saveMeta(realm, meta);
  return index;
}

export async function rebuildAll(realm: WorkspaceRealm): Promise<number> {
  const files = await collectWorkspaceFiles(realm);
  const meta: Record<string, string> = {};
  let count = 0;
  for (const path of files) {
    const index = await buildFileIndex(realm, path).catch(() => undefined);
    if (index === undefined) continue;
    await saveFileIndex(realm, index);
    meta[path] = indexFileName(path);
    count += 1;
  }
  await saveMeta(realm, meta);
  return count;
}

export async function searchWorkspace(
  realm: WorkspaceRealm,
  query: string,
  limit: number,
  fileFilter?: string
): Promise<SearchOutcome> {
  const started = Date.now();
  const meta = await loadMeta(realm);
  const indexes = new Map<string, SearchFileIndex>();
  const staleMeta = { ...meta };
  const candidates = Object.keys(meta).filter((path) => searchablePath(path))
    .filter((path) => fileFilter === undefined || fileFilter === "" || path.includes(fileFilter));
  // meta 缺失(如首次查询)时回退到全量扫描, 保证开箱可用.
  const paths = candidates.length > 0 || Object.keys(meta).length > 0
    ? candidates
    : await collectWorkspaceFiles(realm);
  for (const path of paths) {
    const cached = await loadFileIndex(realm, path).catch(() => undefined);
    const fresh = await ensureFreshIndex(realm, path, cached).catch(() => cached);
    if (fresh === undefined) {
      delete staleMeta[path];
      continue;
    }
    if (fresh !== cached) await saveFileIndex(realm, fresh).catch(() => undefined);
    indexes.set(path, fresh);
  }
  if (Object.keys(staleMeta).length !== Object.keys(meta).length) {
    await saveMeta(realm, staleMeta).catch(() => undefined);
  }
  const hits = searchIndexes(indexes, query, limit, fileFilter);
  return { query, tookMs: Date.now() - started, total: hits.length, hits };
}

export function parseLimit(raw: string | null): number {
  if (raw === null || raw === "") return DEFAULT_LIMIT;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) return DEFAULT_LIMIT;
  return Math.min(value, MAX_LIMIT);
}

/** HTTP 薄壳: 检索 / 单文件刷新 / 全量重建三路由, 供扩展缝注册与测试直调. */
export async function handleSearchRequest(
  context: Context,
  request: IncomingMessage,
  response: ServerResponse,
  options: WorkspaceRouteOptions
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/oh-story/search" && request.method === "GET") {
    const realm = await workspaceRealm(context, url);
    const query = url.searchParams.get("q") ?? "";
    if (query.trim() === "") {
      send(response, 400, { error: "缺少检索关键词。" });
      return true;
    }
    const outcome = await searchWorkspace(
      realm,
      query,
      parseLimit(url.searchParams.get("limit")),
      url.searchParams.get("fileFilter") ?? undefined
    );
    send(response, 200, outcome);
    return true;
  }
  if (url.pathname === "/oh-story/search/index" && request.method === "POST") {
    const realm = await workspaceRealm(context, url);
    const path = url.searchParams.get("path");
    if (path === null || path === "") {
      send(response, 400, { error: "缺少文件路径。" });
      return true;
    }
    // 编辑器保存后调用: 路径仍走创作白名单校验, 非法路径直接 403.
    await creativeTarget(realm, path);
    const index = await refreshSingleFile(realm, path);
    if (index === undefined) {
      send(response, 404, { error: "文件不存在或不在检索范围内。" });
      return true;
    }
    send(response, 200, { path, version: index.version, lines: index.lines.length });
    return true;
  }
  if (url.pathname === "/oh-story/search/rebuild" && request.method === "POST") {
    const realm = await workspaceRealm(context, url);
    const files = await rebuildAll(realm);
    send(response, 200, { files });
    return true;
  }
  void options;
  return false;
}

registerWorkspaceExtension({ name: "search", handle: handleSearchRequest });

export function registerSearchService(): void {
  // 实现在模块顶层通过 registerWorkspaceExtension 注册, 保留具名导出供测试引用.
}
