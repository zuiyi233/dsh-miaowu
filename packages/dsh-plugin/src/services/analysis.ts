/**
 * A3 拆书结果结构化:把「拆文库/{书名}/」Markdown 文档树解析为可查询的 sidecar JSON。
 *
 * 设计取舍(与 NarraLume/Scriverse 对照):
 * - NarraLume ImportAnalysis 是"导入分析产出候选";这里是"拆书文档树产出结构化 sidecar",
 *   同样落盘为 JSON、可查询,证据引用同样锚定原文位置(Scriverse 用行 ID, NarraLume 用
 *   [P#] 段号,这里用源 md 路径 + 1-based 行号,人读可直接打开)。
 * - 无本地数据库:sidecar 落 `.oh-story/analysis/{书名}.json`(git 已忽略),走 DSH fs 读写。
 * - 解析器是 rule-based 确定性启发式:规则命中不了就跳过,不误报;未知结构不抛错。
 * - 原子写:DSH FileSystem 没有 rename 原语,writeText 本身是"原子创建或替换",
 *   因此 parse 直接 writeText 覆盖即原子幂等写,不需要 .partial 中转。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { FileSystem, FsTarget } from "@deepseek-ai/dsh-fs";
import { send, workspaceRealm, WorkspaceHttpError, type WorkspaceRouteOptions } from "../workspace-route.js";
import { registerWorkspaceExtension } from "./registry.js";

export const ANALYSIS_EXTENSION_NAME = "oh-story-analysis";
const LIBRARY_ROOT = "拆文库";
const ANALYSIS_ROOT = ".oh-story/analysis";
const PROGRESS_FILE = "_progress.md";

// 魔法数字全部具名:名称/行长上限用于过滤误报(句子过长不可能是实体名)。
const MAX_ENTITY_NAME_LENGTH = 16;
const MAX_KIND_LENGTH = 20;
const MAX_RELATION_LINE_LENGTH = 80;
const MAX_LABEL_LENGTH = 120;
const MAX_TITLE_LENGTH = 60;
const MAX_ALIAS_LENGTH = 12;
const MAX_EVIDENCE_TEXT_LENGTH = 200;

export interface EvidenceRef {
  readonly path: string;
  readonly line: number;
}

export type EntityType = "character" | "faction" | "location" | "power" | "rule" | "concept";

export interface AnalysisEntity {
  readonly name: string;
  readonly type: EntityType;
  readonly aliases: readonly string[];
  readonly evidence: readonly EvidenceRef[];
  readonly evidenceText: string;
}

export interface AnalysisRelation {
  readonly from: string;
  readonly to: string;
  readonly kind: string;
  readonly evidence: readonly EvidenceRef[];
  readonly evidenceText: string;
}

export interface AnalysisTimelineItem {
  readonly label: string;
  readonly at?: string | undefined;
  readonly evidence: readonly EvidenceRef[];
  readonly evidenceText: string;
}

export type ForeshadowStatus = "planted" | "open" | "resolved";

export interface AnalysisForeshadow {
  readonly title: string;
  readonly status: ForeshadowStatus;
  readonly note?: string | undefined;
  readonly evidence: readonly EvidenceRef[];
  readonly evidenceText: string;
}

export interface AnalysisScene {
  readonly title: string;
  readonly evidence: readonly EvidenceRef[];
  readonly evidenceText: string;
}

export interface BookSourceFile {
  readonly path: string;
  readonly bytes: number;
  readonly version: string;
}

export interface BookSidecar {
  readonly book: string;
  readonly parsedAt: string;
  readonly sourceFiles: readonly BookSourceFile[];
  readonly entities: readonly AnalysisEntity[];
  readonly relations: readonly AnalysisRelation[];
  readonly timeline: readonly AnalysisTimelineItem[];
  readonly foreshadows: readonly AnalysisForeshadow[];
  readonly scenes: readonly AnalysisScene[];
}

export interface BookSummary {
  readonly book: string;
  readonly entityCount: number;
  readonly relationCount: number;
  readonly timelineCount: number;
  readonly foreshadowCount: number;
  readonly sceneCount: number;
}

export interface BookDocInput {
  readonly path: string;
  readonly content: string;
  readonly bytes: number;
  readonly version: string;
}

export type AnalysisKind = "entity" | "relation" | "timeline" | "foreshadow" | "scene";

export interface QueryHit {
  readonly book: string;
  readonly kind: AnalysisKind;
  readonly record:
    | AnalysisEntity
    | AnalysisRelation
    | AnalysisTimelineItem
    | AnalysisForeshadow
    | AnalysisScene;
}

/** 测试用内存 fs 只需实现这六个方法;真实 FileSystem 结构兼容,可直接传入。 */
export type AnalysisFs = Pick<
  FileSystem,
  "resolve" | "contains" | "stat" | "listDir" | "readBytes" | "writeText"
>;

interface DocLine {
  readonly text: string;
  readonly line: number;
}

interface Heading extends DocLine {
  readonly level: number;
  readonly title: string;
}

interface ParsedDoc {
  readonly path: string;
  readonly basename: string;
  readonly lines: readonly DocLine[];
  readonly headings: readonly Heading[];
}

type ScopeKind = "entity" | "relation" | "timeline" | "foreshadow" | "scene" | "other";

const LIST_PATTERN = /^\s*(?:[-*+]|[(（]?\d+[.、)）])\s+(.+?)\s*$/u;
const HEADING_PATTERN = /^(#{1,6})\s+(.+?)\s*$/u;
// 关系三式:破折号+括号 > A 与 B 是 C > A 是 B 的 C(按特异度排序)。
const DASH_RELATION = /^(.+?)\s*[—–─\-－]{1,2}\s*(.+?)\s*[（(](.+?)[)）]\s*$/u;
const YU_SHI_RELATION = /^(.+?)\s*与\s*(.+?)\s*是\s*(.+?)\s*$/u;
const SHI_DE_RELATION = /^(.+?)\s*是\s*(.+?)\s*的\s*(.+?)\s*$/u;
const ALIAS_KEYWORDS = ["别名", "又称", "别称", "化名", "外号", "小名", "其他称呼", "尊号", "道号", "又名"];
const RESOLVED_KEYWORDS = ["已回收", "回收完毕", "已揭晓", "已填坑", "已收束"];
const PLANTED_KEYWORDS = ["未回收", "待回收", "埋设", "埋下", "铺垫", "待填", "悬置"];
const AT_PAREN_PATTERN = /（\s*(?:时间|日期|年代|时期|阶段)\s*[:：]\s*([^）]+?)\s*）/u;
const AT_BARE_PATTERN = /(?:时间|日期|年代|时期|阶段)\s*[:：]\s*([^;；，,]+?)\s*$/u;
// 名称含这些字符的一定是句子/标记,不是实体名(宁可漏报不误报)。
const NAME_PUNCT = /[\s，。；：？！、“”‘’（）()【】[\]{}<>《》#*@\\/|=_+]/u;
// 分节标题起手词:与 scopeKind 的关键词同源,分节本身(如「## 地理」「## 势力」)不做实体。
const SECTION_TITLES = /^(?:关系|伏笔|埋点|悬念|时间线|剧情|场景|情节|大纲|章节|分幕|正文|时间|角色|人物|档案|势力|门派|家族|组织|宗门|帮派|世界观|地理|地点|力量|境界|功法|修炼|规则|铁律|戒律|文风|概要|总结|报告|梗概|设定|导读|前言|附录|目录|金手指|系统)/u;
const GROUP_TITLES = /(角色|人物|一览|列表|介绍|群像|势力|关系|档案)$/u;
const SCENE_BLOCKLIST = /^(?:剧情|场景|梗概|概要|总结|报告|导读|前言|附录|目录|时间线|伏笔|关系|档案|世界观|势力|文风|角色|人物|设定|大纲|章节|正文|力量|规则)/u;
const FORESHADOW_MARKER = /^(?:伏笔|埋点|悬念)\s*\d*\s*[:：·・.\-–—]?\s*/u;
const PRONOUN_GUARD = /(你|我|他|她|它|这|那|该|此|每|各|某|其|谁|什么|怎么)/u;

function splitLines(content: string): DocLine[] {
  return content.split(/\r?\n/u).map((text, index) => ({ text, line: index + 1 }));
}

function parseHeadings(lines: readonly DocLine[]): Heading[] {
  const headings: Heading[] = [];
  for (const item of lines) {
    const match = HEADING_PATTERN.exec(item.text);
    if (match === null) continue;
    const hashes = match[1];
    const title = match[2];
    if (hashes === undefined || title === undefined) continue;
    headings.push({ text: item.text, line: item.line, level: hashes.length, title: title.trim() });
  }
  return headings;
}

function stripMarkdown(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/(\*\*|__)(.+?)\1/gu, "$2")
    .replace(/[*_`~]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function basenameOf(path: string): string {
  const slash = path.lastIndexOf("/");
  const file = slash === -1 ? path : path.slice(slash + 1);
  return file.endsWith(".md") ? file.slice(0, -3) : file;
}

function toParsedDoc(input: BookDocInput): ParsedDoc {
  const lines = splitLines(input.content);
  return { path: input.path, basename: basenameOf(input.path), lines, headings: parseHeadings(lines) };
}

/**
 * 行的作用域 = 其上方最近的"分节标题"(命中 scopeKind 关键字的二级含以上标题)。
 * 实体名小节(如「## 萧炎」)本身不是分节,要穿透回真正的分节(如「角色档案」),
 * 否则其下方的别名行/加粗行会被误判为无作用域而漏抽。
 * 三级标题归属其二级节;兜底用文件名。
 */
function scopeForLine(headings: readonly Heading[], line: number, basename: string): string {
  for (let index = headings.length - 1; index >= 0; index -= 1) {
    const heading = headings[index];
    if (heading === undefined || heading.line >= line || heading.level > 2) continue;
    if (scopeKind(heading.title) !== "other") return heading.title;
  }
  return basename;
}

/** 行内节判定:具体类别优先于场景——混排节不产出场景。 */
function scopeKind(scope: string): ScopeKind {
  if (/伏笔|埋点|悬念/u.test(scope)) return "foreshadow";
  if (/关系/u.test(scope)) return "relation";
  if (/时间线|剧情时间|大事记|编年|时间轴/u.test(scope)) return "timeline";
  if (/角色|人物|档案|势力|门派|家族|组织|宗门|帮派|世界观|地理|地点|力量体系|境界|功法|修炼|规则|铁律/u.test(scope)) return "entity";
  if (/场景|剧情|情节|大纲|章节|分幕|正文/u.test(scope)) return "scene";
  return "other";
}

function inferEntityType(scopeText: string): EntityType {
  if (/角色|人物/u.test(scopeText)) return "character";
  if (/势力|门派|家族|组织|宗门|帮派/u.test(scopeText)) return "faction";
  if (/地理|地点|地图|地域/u.test(scopeText)) return "location";
  if (/力量体系|境界|功法|修炼|金手指|系统/u.test(scopeText)) return "power";
  if (/规则|铁律|戒律/u.test(scopeText)) return "rule";
  return "concept";
}

function validName(name: string): boolean {
  if (name.length === 0 || name.length > MAX_ENTITY_NAME_LENGTH) return false;
  if (NAME_PUNCT.test(name) || PRONOUN_GUARD.test(name)) return false;
  if (/[第卷章节]\s*\d|\d+\s*[章节卷回]/u.test(name)) return false;
  return true;
}

function cleanEvidence(text: string): string {
  return text.trim().slice(0, MAX_EVIDENCE_TEXT_LENGTH);
}

function listContent(text: string): string | undefined {
  const match = LIST_PATTERN.exec(text);
  const item = match?.[1];
  return item === undefined || item === "" ? undefined : item;
}

function splitAliases(value: string): string[] {
  return value
    .split(/[、，,／/｜|;；\s]+/u)
    .map((alias) => alias.trim())
    .filter((alias) => alias.length > 0 && alias.length <= MAX_ALIAS_LENGTH);
}

function pushUnique(target: string[], value: string): void {
  if (!target.includes(value)) target.push(value);
}

export function extractEntities(docs: readonly BookDocInput[]): AnalysisEntity[] {
  const entities: AnalysisEntity[] = [];
  for (const input of docs.map(toParsedDoc)) {
    let current = -1;
    for (const item of input.lines) {
      const heading = input.headings.find((entry) => entry.line === item.line);
      if (heading !== undefined && heading.level >= 2) {
        current = -1;
        if (scopeKind(scopeForLine(input.headings, item.line, input.basename)) !== "entity") continue;
        const cleaned = stripMarkdown(heading.title);
        if (SECTION_TITLES.test(cleaned) || GROUP_TITLES.test(cleaned)) continue;
        // 「## 萧炎(主角)」:括号内顺手收为别名。
        const paren = /[（(]([^)）]{1,12})[)）]\s*$/u.exec(cleaned);
        const name = (paren === null ? cleaned : cleaned.slice(0, paren.index).trim());
        if (!validName(name)) continue;
        const aliases: string[] = [];
        if (paren !== null && paren[1] !== undefined) pushUnique(aliases, paren[1].trim());
        entities.push({
          name,
          type: inferEntityType(`${scopeForLine(input.headings, item.line, input.basename)} ${input.basename}`),
          aliases,
          evidence: [{ path: input.path, line: item.line }],
          evidenceText: cleanEvidence(item.text)
        });
        current = entities.length - 1;
        continue;
      }
      if (scopeKind(scopeForLine(input.headings, item.line, input.basename)) !== "entity") continue;
      const text = stripMarkdown(item.text);
      const bold = /[-*+]\s*\*\*(.+?)\*\*/u.exec(item.text);
      if (bold !== null && bold[1] !== undefined) {
        const name = stripMarkdown(bold[1]);
        if (!validName(name) || SECTION_TITLES.test(name)) continue;
        entities.push({
          name,
          type: inferEntityType(`${scopeForLine(input.headings, item.line, input.basename)} ${input.basename}`),
          aliases: [],
          evidence: [{ path: input.path, line: item.line }],
          evidenceText: cleanEvidence(item.text)
        });
        current = entities.length - 1;
        continue;
      }
      const aliasMatch = new RegExp(`(?:${ALIAS_KEYWORDS.join("|")})\\s*[:：]\\s*(.+)`, "u").exec(text);
      if (aliasMatch !== null && aliasMatch[1] !== undefined && current >= 0) {
        const entity = entities[current];
        if (entity === undefined) continue;
        const merged = [...entity.aliases];
        for (const alias of splitAliases(aliasMatch[1])) pushUnique(merged, alias);
        entities[current] = { ...entity, aliases: merged };
      }
    }
  }
  return entities;
}

interface RelationDraft {
  readonly from: string;
  readonly to: string;
  readonly kind: string;
}

function parseRelationLine(text: string): RelationDraft | undefined {
  const patterns = [DASH_RELATION, YU_SHI_RELATION, SHI_DE_RELATION];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match === null) continue;
    const from = match[1]?.trim();
    const to = match[2]?.trim();
    const kind = match[3]?.trim().replace(/[。；;.\s]+$/u, "");
    if (from === undefined || to === undefined || kind === undefined) continue;
    if (!validName(from) || !validName(to)) continue;
    if (kind.length === 0 || kind.length > MAX_KIND_LENGTH || NAME_PUNCT.test(kind)) continue;
    return { from, to, kind };
  }
  return undefined;
}

export function extractRelations(docs: readonly BookDocInput[]): AnalysisRelation[] {
  const relations: AnalysisRelation[] = [];
  for (const input of docs.map(toParsedDoc)) {
    for (const item of input.lines) {
      if (item.text.trim().length > MAX_RELATION_LINE_LENGTH) continue;
      if (scopeKind(scopeForLine(input.headings, item.line, input.basename)) !== "relation") continue;
      const content = listContent(item.text);
      // 只认列表行:段落散文不做关系抽取,避免误报。
      if (content === undefined) continue;
      const draft = parseRelationLine(stripMarkdown(content));
      if (draft === undefined) continue;
      relations.push({
        ...draft,
        evidence: [{ path: input.path, line: item.line }],
        evidenceText: cleanEvidence(item.text)
      });
    }
  }
  return relations;
}

export function extractTimeline(docs: readonly BookDocInput[]): AnalysisTimelineItem[] {
  const items: AnalysisTimelineItem[] = [];
  for (const input of docs.map(toParsedDoc)) {
    for (const item of input.lines) {
      if (scopeKind(scopeForLine(input.headings, item.line, input.basename)) !== "timeline") continue;
      const content = listContent(item.text);
      if (content === undefined) continue;
      const text = stripMarkdown(content).replace(/[。；;\s]+$/u, "");
      if (text.length === 0 || text.length > MAX_LABEL_LENGTH) continue;
      // 先配对括号式「（时间：幼年）」,再兜底裸「时间：幼年」。
      const parenMatch = AT_PAREN_PATTERN.exec(text);
      const bareMatch = parenMatch === null ? AT_BARE_PATTERN.exec(text) : null;
      const matched = parenMatch ?? bareMatch;
      const at = matched?.[1]?.trim();
      const label = (matched === null ? text : text.replace(matched[0], "").replace(/[（）()]/gu, "").replace(/\s+/gu, " ").trim());
      if (label.length === 0) continue;
      items.push({
        label,
        ...(at === undefined || at === "" ? {} : { at }),
        evidence: [{ path: input.path, line: item.line }],
        evidenceText: cleanEvidence(item.text)
      });
    }
  }
  return items;
}

function foreshadowStatus(text: string): ForeshadowStatus {
  if (RESOLVED_KEYWORDS.some((keyword) => text.includes(keyword))) return "resolved";
  if (PLANTED_KEYWORDS.some((keyword) => text.includes(keyword))) return "planted";
  return "open";
}

function statusParenPattern(): RegExp {
  const keywords = [...RESOLVED_KEYWORDS, ...PLANTED_KEYWORDS, "回收", "揭晓", "填坑", "收束"];
  return new RegExp(`[（(]\\s*[^)）]*(${keywords.join("|")})[^)）]*[)）]\\s*$`, "u");
}

/** 剥离裸状态后缀(「退婚之耻已回收」→标题「退婚之耻」):裸后缀是 status 信号,不是标题本体。 */
function stripBareStatusSuffix(title: string): string {
  const keywords = [...RESOLVED_KEYWORDS, ...PLANTED_KEYWORDS];
  for (const keyword of keywords.sort((left, right) => right.length - left.length)) {
    if (title.endsWith(keyword) && title.length > keyword.length) {
      return title.slice(0, -keyword.length).replace(/[，,、·・\s]+$/u, "");
    }
  }
  return title;
}

function cleanForeshadowTitle(text: string): string {
  const stripped = stripMarkdown(text).replace(FORESHADOW_MARKER, "").replace(statusParenPattern(), "").replace(/[。；;\s]+$/u, "").trim();
  return stripBareStatusSuffix(stripped);
}

export function extractForeshadows(docs: readonly BookDocInput[]): AnalysisForeshadow[] {
  const foreshadows: AnalysisForeshadow[] = [];
  for (const input of docs.map(toParsedDoc)) {
    for (const item of input.lines) {
      if (scopeKind(scopeForLine(input.headings, item.line, input.basename)) !== "foreshadow") continue;
      const heading = input.headings.find((entry) => entry.line === item.line);
      if (heading !== undefined) {
        // 伏笔小节只认三级(含)以下标题:二级标题是节本身(如"伏笔地图")。
        if (heading.level < 3) continue;
        const title = cleanForeshadowTitle(heading.title);
        if (title.length === 0 || title.length > MAX_TITLE_LENGTH) continue;
        foreshadows.push({
          title,
          status: foreshadowStatus(heading.title),
          evidence: [{ path: input.path, line: item.line }],
          evidenceText: cleanEvidence(item.text)
        });
        continue;
      }
      const content = listContent(item.text);
      if (content === undefined) continue;
      const stripped = stripMarkdown(content);
      const title = cleanForeshadowTitle(content);
      if (title.length === 0 || title.length > MAX_TITLE_LENGTH) continue;
      foreshadows.push({
        title,
        status: foreshadowStatus(stripped),
        ...(stripped === title ? {} : { note: stripped.slice(0, MAX_EVIDENCE_TEXT_LENGTH) }),
        evidence: [{ path: input.path, line: item.line }],
        evidenceText: cleanEvidence(item.text)
      });
    }
  }
  return foreshadows;
}

export function extractScenes(docs: readonly BookDocInput[]): AnalysisScene[] {
  const scenes: AnalysisScene[] = [];
  for (const input of docs.map(toParsedDoc)) {
    // 场景的归属看"文档级主题"(文件名 + 一级标题),不看最近二级节:
    // 混排文档(如"剧情与伏笔.md")里场景小节常跟在伏笔节之后,最近节会误判为伏笔。
    // 文档级主题里场景优先:含"剧情/场景"即视为剧情文档,不被"伏笔"二字抢占。
    const docTheme = `${input.basename} ${input.headings.filter((heading) => heading.level === 1).map((heading) => heading.title).join(" ")}`;
    if (!/剧情|场景|情节|大纲|章节|分幕|正文/u.test(docTheme)) continue;
    for (const heading of input.headings) {
      // 场景只认二级小节:三级多为节内细分,不做场景;再用 SCENE_BLOCKLIST 踢掉
      // 「时间线/伏笔地图」等同级分节标题。
      if (heading.level !== 2) continue;
      const title = stripMarkdown(heading.title);
      if (title.length === 0 || title.length > MAX_TITLE_LENGTH || SCENE_BLOCKLIST.test(title)) continue;
      scenes.push({
        title,
        evidence: [{ path: input.path, line: heading.line }],
        evidenceText: cleanEvidence(heading.text)
      });
    }
  }
  return scenes;
}

/** 同名实体跨文件合并:别名与证据累加,类型取首次命中。 */
function mergeEntities(entities: readonly AnalysisEntity[]): AnalysisEntity[] {
  const merged = new Map<string, AnalysisEntity>();
  for (const entity of entities) {
    const existing = merged.get(entity.name);
    if (existing === undefined) {
      merged.set(entity.name, { ...entity, aliases: [...entity.aliases], evidence: [...entity.evidence] });
      continue;
    }
    const aliases = [...existing.aliases];
    for (const alias of entity.aliases) pushUnique(aliases, alias);
    merged.set(entity.name, { ...existing, aliases, evidence: [...existing.evidence, ...entity.evidence] });
  }
  return [...merged.values()];
}

export function parseBookTree(book: string, files: readonly BookDocInput[]): BookSidecar {
  const docs = files.filter((file) => file.path.endsWith(".md") && !file.path.endsWith(PROGRESS_FILE));
  const entities = mergeEntities(extractEntities(docs));
  const relations = extractRelations(docs);
  const timeline = extractTimeline(docs);
  const foreshadows = extractForeshadows(docs);
  const scenes = extractScenes(docs);
  return {
    book,
    parsedAt: new Date().toISOString(),
    sourceFiles: docs.map((file) => ({ path: file.path, bytes: file.bytes, version: file.version })),
    entities,
    relations,
    timeline,
    foreshadows,
    scenes
  };
}

export function summarizeBook(sidecar: BookSidecar): BookSummary {
  return {
    book: sidecar.book,
    entityCount: sidecar.entities.length,
    relationCount: sidecar.relations.length,
    timelineCount: sidecar.timeline.length,
    foreshadowCount: sidecar.foreshadows.length,
    sceneCount: sidecar.scenes.length
  };
}

const KIND_VALUES: readonly AnalysisKind[] = ["entity", "relation", "timeline", "foreshadow", "scene"];

export function isAnalysisKind(value: string): value is AnalysisKind {
  return (KIND_VALUES as readonly string[]).includes(value);
}

export function querySidecar(
  sidecar: BookSidecar,
  kind: AnalysisKind | "all" | undefined,
  query: string
): QueryHit[] {
  const needle = query.trim().toLowerCase();
  const matches = (value: string | undefined): boolean =>
    needle === "" || (value ?? "").toLowerCase().includes(needle);
  const want = (candidate: AnalysisKind): boolean => kind === undefined || kind === "all" || kind === candidate;
  const hits: QueryHit[] = [];
  if (want("entity")) {
    for (const record of sidecar.entities) {
      if (matches(record.name) || record.aliases.some(matches) || matches(record.type)) {
        hits.push({ book: sidecar.book, kind: "entity", record });
      }
    }
  }
  if (want("relation")) {
    for (const record of sidecar.relations) {
      if (matches(record.from) || matches(record.to) || matches(record.kind)) {
        hits.push({ book: sidecar.book, kind: "relation", record });
      }
    }
  }
  if (want("timeline")) {
    for (const record of sidecar.timeline) {
      if (matches(record.label) || matches(record.at)) {
        hits.push({ book: sidecar.book, kind: "timeline", record });
      }
    }
  }
  if (want("foreshadow")) {
    for (const record of sidecar.foreshadows) {
      if (matches(record.title) || matches(record.note) || matches(record.status)) {
        hits.push({ book: sidecar.book, kind: "foreshadow", record });
      }
    }
  }
  if (want("scene")) {
    for (const record of sidecar.scenes) {
      if (matches(record.title)) hits.push({ book: sidecar.book, kind: "scene", record });
    }
  }
  return hits;
}

type RealmRoot = Parameters<AnalysisFs["contains"]>[0];
type DirTarget = Parameters<AnalysisFs["listDir"]>[0];

async function resolveInside(fs: AnalysisFs, cwd: string, root: RealmRoot, rel: string): Promise<FsTarget> {
  const target = await fs.resolve(rel, { cwd });
  if (!fs.contains(root, target)) throw new WorkspaceHttpError(403, "文件路径离开了 DSH 工作目录。");
  return target;
}

interface TextFile {
  readonly content: string;
  readonly bytes: number;
  readonly version: string;
}

async function readTextFile(fs: AnalysisFs, target: FsTarget, maxBytes: number): Promise<TextFile> {
  const info = await fs.stat(target);
  if (info?.type !== "file") throw new WorkspaceHttpError(404, "文件不存在。");
  if (info.size !== undefined && info.size > maxBytes) throw new WorkspaceHttpError(413, "文件超过工作台大小限制。");
  const bytes = await fs.readBytes(target, undefined, maxBytes);
  try {
    return { content: new TextDecoder("utf-8", { fatal: true }).decode(bytes), bytes: bytes.byteLength, version: String(info.version) };
  } catch {
    throw new WorkspaceHttpError(415, "文件不是有效的 UTF-8 文本。");
  }
}

/** 递归收集一本书的 md(跳过 _progress.md 与隐藏文件);单文件失败跳过整书不报错。 */
async function collectBookFiles(
  fs: AnalysisFs,
  cwd: string,
  root: RealmRoot,
  book: string,
  maxBytes: number
): Promise<BookDocInput[]> {
  const bookRoot = await resolveInside(fs, cwd, root, `${LIBRARY_ROOT}/${book}`);
  const info = await fs.stat(bookRoot);
  if (info?.type !== "directory") return [];
  const out: BookDocInput[] = [];
  const walk = async (target: DirTarget, rel: string): Promise<void> => {
    for (const entry of await fs.listDir(target)) {
      if (entry.name.startsWith(".")) continue;
      const childRel = `${rel}/${entry.name}`;
      if (entry.type === "directory") {
        await walk(entry.target, childRel);
        continue;
      }
      if (!entry.name.endsWith(".md") || entry.name === PROGRESS_FILE) continue;
      try {
        const file = await readTextFile(fs, entry.target, maxBytes);
        out.push({ path: childRel, content: file.content, bytes: file.bytes, version: file.version });
      } catch {
        continue;
      }
    }
  };
  await walk(bookRoot, `${LIBRARY_ROOT}/${book}`);
  return out.sort((left, right) => (left.path < right.path ? -1 : 1));
}

export async function listAnalysisBooks(
  fs: AnalysisFs,
  cwd: string,
  root: RealmRoot
): Promise<string[]> {
  const library = await resolveInside(fs, cwd, root, LIBRARY_ROOT);
  const info = await fs.stat(library);
  if (info === undefined) return [];
  if (info.type !== "directory") throw new WorkspaceHttpError(415, "拆文库不是目录。");
  const books: string[] = [];
  for (const entry of await fs.listDir(library)) {
    if (entry.type === "directory" && !entry.name.startsWith(".")) books.push(entry.name);
  }
  return books.sort();
}

export async function writeSidecar(
  fs: AnalysisFs,
  cwd: string,
  root: RealmRoot,
  sidecar: BookSidecar
): Promise<string> {
  const path = `${ANALYSIS_ROOT}/${sidecar.book}.json`;
  const target = await resolveInside(fs, cwd, root, path);
  await fs.writeText(target, `${JSON.stringify(sidecar, null, 2)}\n`);
  return path;
}

function validSidecar(value: unknown): value is BookSidecar {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.book === "string" &&
    Array.isArray(record.entities) &&
    Array.isArray(record.relations) &&
    Array.isArray(record.timeline) &&
    Array.isArray(record.foreshadows) &&
    Array.isArray(record.scenes)
  );
}

/** 损坏的 sidecar 降级为 undefined(查询视为空,parse 可覆盖重建)。 */
export async function readSidecar(
  fs: AnalysisFs,
  cwd: string,
  root: RealmRoot,
  book: string,
  maxBytes: number
): Promise<BookSidecar | undefined> {
  try {
    const target = await resolveInside(fs, cwd, root, `${ANALYSIS_ROOT}/${book}.json`);
    const file = await readTextFile(fs, target, maxBytes);
    const value = JSON.parse(file.content) as unknown;
    return validSidecar(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function listSidecarBooks(
  fs: AnalysisFs,
  cwd: string,
  root: RealmRoot
): Promise<string[]> {
  try {
    const directory = await resolveInside(fs, cwd, root, ANALYSIS_ROOT);
    if ((await fs.stat(directory))?.type !== "directory") return [];
    const books: string[] = [];
    for (const entry of await fs.listDir(directory)) {
      if (entry.type === "file" && entry.name.endsWith(".json")) books.push(entry.name.slice(0, -5));
    }
    return books.sort();
  } catch {
    return [];
  }
}

export async function parseAllBooks(
  fs: AnalysisFs,
  cwd: string,
  root: RealmRoot,
  maxBytes: number
): Promise<{ readonly books: readonly BookSummary[] }> {
  const books: BookSummary[] = [];
  for (const book of await listAnalysisBooks(fs, cwd, root)) {
    const sidecar = parseBookTree(book, await collectBookFiles(fs, cwd, root, book, maxBytes));
    await writeSidecar(fs, cwd, root, sidecar);
    books.push(summarizeBook(sidecar));
  }
  return { books };
}

export async function queryAnalysis(
  fs: AnalysisFs,
  cwd: string,
  root: RealmRoot,
  book: string | undefined,
  kind: AnalysisKind | "all",
  query: string,
  maxBytes: number
): Promise<QueryHit[]> {
  const names = book === undefined ? await listSidecarBooks(fs, cwd, root) : [book];
  const hits: QueryHit[] = [];
  for (const name of names) {
    const sidecar = await readSidecar(fs, cwd, root, name, maxBytes);
    if (sidecar !== undefined) hits.push(...querySidecar(sidecar, kind, query));
  }
  return hits;
}

function safeBookName(book: string): boolean {
  return book !== "" && !book.includes("/") && !book.includes("\\") && book !== "." && book !== "..";
}

async function handleAnalysis(
  context: Context,
  request: IncomingMessage,
  response: ServerResponse,
  options: WorkspaceRouteOptions
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/oh-story/analysis/parse" && request.method === "POST") {
    const realm = await workspaceRealm(context, url);
    const result = await parseAllBooks(realm.fs, realm.cwd, realm.root, options.maxBytes);
    send(response, 200, { books: result.books });
    return true;
  }
  if (url.pathname === "/oh-story/analysis/query" && request.method === "GET") {
    const realm = await workspaceRealm(context, url);
    const kindParam = url.searchParams.get("kind") ?? "all";
    if (!isAnalysisKind(kindParam) && kindParam !== "all") {
      throw new WorkspaceHttpError(400, "kind 必须是 entity/relation/timeline/foreshadow/scene 之一。");
    }
    const bookParam = url.searchParams.get("book") ?? undefined;
    const book = bookParam === "" ? undefined : bookParam;
    if (book !== undefined && !safeBookName(book)) throw new WorkspaceHttpError(400, "book 参数非法。");
    const hits = await queryAnalysis(
      realm.fs,
      realm.cwd,
      realm.root,
      book,
      kindParam,
      url.searchParams.get("q") ?? "",
      options.maxBytes
    );
    send(response, 200, { book: book ?? null, kind: kindParam, hits });
    return true;
  }
  if (url.pathname === "/oh-story/analysis/export" && request.method === "GET") {
    const realm = await workspaceRealm(context, url);
    const book = url.searchParams.get("book") ?? "";
    if (!safeBookName(book)) throw new WorkspaceHttpError(400, "缺少或非法的 book 参数。");
    const sidecar = await readSidecar(realm.fs, realm.cwd, realm.root, book, options.maxBytes);
    if (sidecar === undefined) {
      throw new WorkspaceHttpError(404, "该书尚未解析或 sidecar 已损坏,请先 POST /oh-story/analysis/parse。");
    }
    send(response, 200, sidecar);
    return true;
  }
  return false;
}

registerWorkspaceExtension({ name: ANALYSIS_EXTENSION_NAME, handle: handleAnalysis });

export function registerAnalysisService(): void {
  // 解析服务在模块顶层已注册;保留该函数以兼容占位模块的具名导入。
}
