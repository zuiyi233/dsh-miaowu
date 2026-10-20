import type {
  DiagnosticCheck,
  DiagnosticEvidenceValue,
  DiagnosticGroup,
  DiagnosticRepairId,
  DiagnosticSeverity,
  DiagnosticStatus,
  DiagnosticsEnvironment,
  DiagnosticsReport,
  DiagnosticsSummary,
} from "./diagnostics-contract.js";
import type { StateInventoryEntry } from "./state-contract.js";
import { stateDescriptorForId, stateDescriptorMigratable } from "./state-contract.js";

/**
 * 只读诊断引擎：把采集阶段拿到的事实（宿主、运行时、工作区、集成注册、凭据开关、
 * 会话探测）翻译成“为什么不能用”。这里没有任何 fs / 网络 / cordis 上下文依赖，
 * 也不写宿主状态；同一个环境对象永远得到同一份报告（时间只取 `environment.now`）。
 */

const MINIMUM_NODE_MAJOR = 24;
const SUPPORTED_PLATFORMS: ReadonlySet<string> = new Set(["win32", "darwin", "linux"]);
/** 派生检索数据由聚合检查统一判定，避免与逐条 `data.search-index` 产生同 id 检查项。 */
const AGGREGATED_DESCRIPTOR_IDS: ReadonlySet<string> = new Set(["search-meta", "search-index"]);
const CREATIVE_DIRECTORY_EXAMPLE = "正文/";
const WORKSPACE_PLACEHOLDER = "<workspace>";
const HOME_PLACEHOLDER = "<home>";
const REDACTED_SECRET = "<redacted-secret>";
const MODEL_CREDENTIAL_GUIDANCE = "设置 → 模型 填入 API Key；只查看已有作品不需要模型";
/** 前缀后仍是这些字符时说明同一个路径段还没结束，不算命中。 */
const PATH_SEGMENT_CHARACTER = /[A-Za-z0-9_.\-:]/u;

type Redactor = (text: string) => string;

interface CheckDraft {
  readonly id: string;
  readonly group: DiagnosticGroup;
  readonly title: string;
  readonly status: DiagnosticStatus;
  /** warn / fail 必填；unknown 默认 P2；pass 恒为 null。 */
  readonly severity?: DiagnosticSeverity;
  readonly summary: string;
  readonly guidance?: readonly string[];
  readonly repair?: DiagnosticRepairId;
  readonly evidence?: Readonly<Record<string, DiagnosticEvidenceValue>>;
}

export function buildDiagnosticsReport(environment: DiagnosticsEnvironment): DiagnosticsReport {
  const redact: Redactor = (text) => redactDiagnosticsText(text, environment.redaction);
  const drafts: CheckDraft[] = [
    ...hostDrafts(environment),
    ...runtimeDrafts(environment),
    ...workspaceDrafts(environment),
    ...dataDrafts(environment),
    ...credentialDrafts(environment),
    ...integrationDrafts(environment),
  ];
  const checks: DiagnosticCheck[] = drafts.map((draft) => finalizeCheck(draft, redact));
  return {
    generatedAt: environment.now,
    pluginVersion: environment.pluginVersion,
    hostVersion: environment.host.version,
    readOnly: true,
    checks,
    summary: summarize(checks),
  };
}

/* -------------------------------------------------------------------------- */
/* 文本脱敏                                                                    */
/* -------------------------------------------------------------------------- */

/** 替换最长的前缀优先；`\` 只在匹配时归一为 `/`，其余文本原样保留；幂等。 */
export function redactDiagnosticsText(
  text: string,
  redaction: DiagnosticsEnvironment["redaction"]
): string {
  return redactSecretPatterns(redactPathPrefixes(text, redaction));
}

function normalizeSeparators(value: string): string {
  return value.replace(/\\/gu, "/");
}

function redactPathPrefixes(text: string, redaction: DiagnosticsEnvironment["redaction"]): string {
  const rules: Array<{ readonly needle: string; readonly replacement: string }> = [];
  const addRule = (prefix: string, replacement: string): void => {
    const needle = normalizeSeparators(prefix).replace(/\/+$/u, "");
    if (needle !== "") rules.push({ needle, replacement });
  };
  addRule(redaction.workspaceRoot, WORKSPACE_PLACEHOLDER);
  addRule(redaction.homeDir, HOME_PLACEHOLDER);
  rules.sort((left, right) => right.needle.length - left.needle.length);
  let result = text;
  for (const rule of rules) result = replacePathPrefix(result, rule.needle, rule.replacement);
  return result;
}

/**
 * `\` → `/` 是一对一替换，归一后的下标与原串完全对齐，因此可以直接按
 * 归一化串找到的位置切原串，保留其余字符（包括反斜杠）。
 */
function replacePathPrefix(text: string, needle: string, replacement: string): string {
  const haystack = normalizeSeparators(text);
  // Windows paths are case-insensitive. Fold ASCII casing only, which preserves
  // string length, so indices found in the folded copy still address the original.
  const foldedHaystack = haystack.replace(/[A-Z]/gu, (character) => character.toLowerCase());
  const foldedNeedle = needle.replace(/[A-Z]/gu, (character) => character.toLowerCase());
  const pieces: string[] = [];
  let cursor = 0;
  let found = foldedHaystack.indexOf(foldedNeedle, cursor);
  while (found !== -1) {
    const end = found + needle.length;
    const nextCharacter = end === haystack.length ? undefined : haystack[end];
    const isBoundary = nextCharacter === undefined
      || nextCharacter === "/"
      || !PATH_SEGMENT_CHARACTER.test(nextCharacter);
    if (isBoundary) {
      pieces.push(text.slice(cursor, found), replacement);
      cursor = end;
      found = foldedHaystack.indexOf(foldedNeedle, cursor);
    } else {
      found = foldedHaystack.indexOf(foldedNeedle, found + 1);
    }
  }
  if (pieces.length === 0) return text;
  pieces.push(text.slice(cursor));
  return pieces.join("");
}

function redactSecretPatterns(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/gu, REDACTED_SECRET)
    .replace(/(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/giu, `$1${REDACTED_SECRET}`)
    .replace(/(\bapi[_-]?key\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;)}\]]+)/giu, `$1${REDACTED_SECRET}`);
}

/* -------------------------------------------------------------------------- */
/* 兼容性解析（不依赖 semver 包）                                              */
/* -------------------------------------------------------------------------- */

interface SemverVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** semver 预发布标识：数字段按数值比较，其余按字典序；空数组代表正式版。 */
  readonly prerelease: readonly (string | number)[];
}

type ComparatorOperator = ">=" | ">" | "<=" | "<" | "=";

interface RangeComparator {
  readonly operator: ComparatorOperator;
  readonly version: SemverVersion;
}

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u;
const COMPARATOR_PATTERN = /^(>=|<=|>|<|=)?(.+)$/u;

function parseVersion(value: string): SemverVersion | null {
  const match = VERSION_PATTERN.exec(value.trim());
  if (match === null) return null;
  const majorText = match[1];
  const minorText = match[2];
  const patchText = match[3];
  if (majorText === undefined || minorText === undefined || patchText === undefined) return null;
  const major = Number(majorText);
  const minor = Number(minorText);
  const patch = Number(patchText);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return null;
  }
  const prerelease: Array<string | number> = [];
  const prereleaseText = match[4];
  if (prereleaseText !== undefined && prereleaseText !== "") {
    for (const identifier of prereleaseText.split(".")) {
      if (identifier === "") return null;
      prerelease.push(/^\d+$/u.test(identifier) ? Number(identifier) : identifier);
    }
  }
  return { major, minor, patch, prerelease };
}

function comparePrerelease(
  left: readonly (string | number)[],
  right: readonly (string | number)[]
): number {
  if (left.length === 0 && right.length === 0) return 0;
  // 正式版高于任何同号预发布版（0.2.1 > 0.2.1-rc.2）。
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  const limit = Math.min(left.length, right.length);
  for (let index = 0; index < limit; index += 1) {
    const leftIdentifier = left[index];
    const rightIdentifier = right[index];
    if (leftIdentifier === undefined || rightIdentifier === undefined) break;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = typeof leftIdentifier === "number";
    const rightNumeric = typeof rightIdentifier === "number";
    if (leftNumeric && rightNumeric) return leftIdentifier < rightIdentifier ? -1 : 1;
    // 数字标识低于字母标识（0.2.1-0 < 0.2.1-alpha.1）。
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  if (left.length === right.length) return 0;
  return left.length < right.length ? -1 : 1;
}

function compareVersions(left: SemverVersion, right: SemverVersion): number {
  const core = left.major - right.major || left.minor - right.minor || left.patch - right.patch;
  if (core !== 0) return core < 0 ? -1 : 1;
  return comparePrerelease(left.prerelease, right.prerelease);
}

/** `||` 择一，空白 AND，比较符 >= > <= < =，裸版本视为相等；无法解析返回 null。 */
function parseRange(range: string): readonly (readonly RangeComparator[])[] | null {
  if (range.trim() === "") return null;
  const alternatives: RangeComparator[][] = [];
  for (const alternative of range.split("||")) {
    const tokens = alternative.trim().split(/\s+/u).filter((token) => token !== "");
    if (tokens.length === 0) return null;
    const comparators: RangeComparator[] = [];
    for (const token of tokens) {
      const match = COMPARATOR_PATTERN.exec(token);
      if (match === null) return null;
      const operatorText = match[1];
      const versionText = match[2];
      if (versionText === undefined) return null;
      const version = parseVersion(versionText);
      if (version === null) return null;
      const operator: ComparatorOperator = operatorText === undefined
        ? "="
        : (operatorText as ComparatorOperator);
      comparators.push({ operator, version });
    }
    alternatives.push(comparators);
  }
  return alternatives.length === 0 ? null : alternatives;
}

function satisfiesComparator(version: SemverVersion, comparator: RangeComparator): boolean {
  const order = compareVersions(version, comparator.version);
  switch (comparator.operator) {
    case ">=":
      return order >= 0;
    case ">":
      return order > 0;
    case "<=":
      return order <= 0;
    case "<":
      return order < 0;
    case "=":
      return order === 0;
  }
}

/** 导出给测试与宿主兼容性检查；非法版本或范围返回 false，不抛错。 */
export function hostVersionSatisfies(version: string, range: string): boolean {
  try {
    const parsedVersion = parseVersion(version);
    const parsedRange = parseRange(range);
    if (parsedVersion === null || parsedRange === null) return false;
    return parsedRange.some((comparators) =>
      comparators.every((comparator) => satisfiesComparator(parsedVersion, comparator))
    );
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* 检查项组装                                                                  */
/* -------------------------------------------------------------------------- */

function finalizeCheck(draft: CheckDraft, redact: Redactor): DiagnosticCheck {
  const severity: DiagnosticSeverity | null = draft.status === "pass"
    ? null
    : (draft.severity ?? "P2");
  const guidance = draft.status === "pass" ? [] : (draft.guidance ?? []).map(redact);
  return {
    id: draft.id,
    group: draft.group,
    title: redact(draft.title),
    status: draft.status,
    severity,
    summary: redact(draft.summary),
    guidance,
    ...(draft.repair === undefined ? {} : { repair: draft.repair }),
    ...(draft.evidence === undefined ? {} : { evidence: redactEvidence(draft.evidence, redact) }),
  };
}

function redactEvidence(
  evidence: Readonly<Record<string, DiagnosticEvidenceValue>>,
  redact: Redactor
): Readonly<Record<string, DiagnosticEvidenceValue>> {
  const next: Record<string, DiagnosticEvidenceValue> = {};
  for (const [key, value] of Object.entries(evidence)) {
    next[key] = typeof value === "string" ? redact(value) : value;
  }
  return next;
}

function summarize(checks: readonly DiagnosticCheck[]): DiagnosticsSummary {
  let pass = 0;
  let warn = 0;
  let fail = 0;
  let unknown = 0;
  let p0 = 0;
  let p1 = 0;
  let p2 = 0;
  for (const check of checks) {
    if (check.status === "pass") pass += 1;
    else if (check.status === "warn") warn += 1;
    else if (check.status === "fail") fail += 1;
    else unknown += 1;
    if (check.severity === "P0") p0 += 1;
    else if (check.severity === "P1") p1 += 1;
    else if (check.severity === "P2") p2 += 1;
  }
  return { pass, warn, fail, unknown, p0, p1, p2 };
}

/* -------------------------------------------------------------------------- */
/* host                                                                        */
/* -------------------------------------------------------------------------- */

function hostDrafts(environment: DiagnosticsEnvironment): CheckDraft[] {
  const { host } = environment;
  const drafts: CheckDraft[] = [];
  if (host.version === null) {
    drafts.push({
      id: "host.version",
      group: "host",
      title: "宿主版本",
      status: "unknown",
      severity: "P2",
      summary: `未能确定 DSH 宿主版本（来源：${host.versionSource}）。`,
      guidance: [
        `版本来源是 ${host.versionSource}；该来源本次没有给出可用的版本号。`,
        "宿主版本未知不会中断诊断：其余分组仍按实际采集到的事实继续检查。",
        "需要确认版本时，可在宿主安装目录的 package.json 或 dsh --version 输出中查看。",
      ],
      evidence: {
        version: null,
        versionSource: host.versionSource,
        supportedRange: host.supportedRange,
      },
    });
  } else {
    drafts.push({
      id: "host.version",
      group: "host",
      title: "宿主版本",
      status: "pass",
      summary: `DSH 宿主版本 ${host.version}（来源：${host.versionSource}）。`,
      evidence: { version: host.version, versionSource: host.versionSource },
    });
  }

  if (host.version === null) {
    drafts.push({
      id: "host.compatibility",
      group: "host",
      title: "宿主版本兼容性",
      status: "unknown",
      severity: "P2",
      summary: `宿主版本未知，无法核对插件声明的支持范围 ${host.supportedRange}。`,
      guidance: [
        `插件声明的宿主支持范围是 ${host.supportedRange}；宿主版本未知，因此不做兼容性判定。`,
        "未知不等于兼容：在拿到宿主版本之前，这一项不会被当作通过。",
        "确认宿主版本后重新运行诊断，即可得到确定的结论。",
      ],
      evidence: {
        hostVersion: null,
        supportedRange: host.supportedRange,
        satisfied: null,
      },
    });
  } else if (parseRange(host.supportedRange) === null) {
    drafts.push({
      id: "host.compatibility",
      group: "host",
      title: "宿主版本兼容性",
      status: "unknown",
      severity: "P2",
      summary: `插件声明的宿主支持范围无法解析（${host.supportedRange}）。`,
      guidance: [
        "这是插件构建自身声明的清单问题，不是宿主版本问题。",
        "重新安装或升级到声明完整范围（engines.dsh）的插件构建。",
        "在范围可读之前，插件不会静默降级，也不会假装兼容。",
      ],
      evidence: {
        hostVersion: host.version,
        supportedRange: host.supportedRange,
        satisfied: null,
      },
    });
  } else if (hostVersionSatisfies(host.version, host.supportedRange)) {
    drafts.push({
      id: "host.compatibility",
      group: "host",
      title: "宿主版本兼容性",
      status: "pass",
      summary: `宿主版本 ${host.version} 在插件声明范围 ${host.supportedRange} 内。`,
      evidence: {
        hostVersion: host.version,
        supportedRange: host.supportedRange,
        satisfied: true,
      },
    });
  } else {
    drafts.push({
      id: "host.compatibility",
      group: "host",
      title: "宿主版本兼容性",
      status: "fail",
      severity: "P0",
      summary: `宿主版本 ${host.version} 不在插件声明范围 ${host.supportedRange} 内。`,
      guidance: [
        `当前宿主版本是 ${host.version}，插件声明的支持范围是 ${host.supportedRange}。`,
        "安全做法一：安装受支持的宿主版本行（升级或回退到上述范围内的 DSH 版本），再加载本插件。",
        "安全做法二：安装声明支持当前宿主版本行的插件构建（插件清单 engines.dsh 覆盖该宿主版本）。",
        "在解决之前，插件不会静默降级：与宿主不匹配的能力会以检查失败的形式明确报告，而不是假装可用。",
      ],
      evidence: {
        hostVersion: host.version,
        supportedRange: host.supportedRange,
        satisfied: false,
      },
    });
  }
  return drafts;
}

/* -------------------------------------------------------------------------- */
/* runtime                                                                     */
/* -------------------------------------------------------------------------- */

function nodeMajor(version: string): number | null {
  const match = /^v?(\d+)(?:\.|$)/u.exec(version.trim());
  if (match === null) return null;
  const text = match[1];
  if (text === undefined) return null;
  const major = Number(text);
  return Number.isSafeInteger(major) ? major : null;
}

function runtimeDrafts(environment: DiagnosticsEnvironment): CheckDraft[] {
  const { runtime } = environment;
  const drafts: CheckDraft[] = [];
  const major = nodeMajor(runtime.node);
  if (major === null) {
    drafts.push({
      id: "runtime.node",
      group: "runtime",
      title: "Node.js 版本",
      status: "unknown",
      severity: "P2",
      summary: `无法解析 Node.js 版本字符串（${runtime.node}）。`,
      guidance: [
        "函数声明要求 Node.js 主版本不低于 24，但当前版本字符串无法解析。",
        "在能反映真实版本的 Node.js 运行时中重启宿主后重新诊断。",
      ],
      evidence: { node: runtime.node, minimumMajor: MINIMUM_NODE_MAJOR },
    });
  } else if (major < MINIMUM_NODE_MAJOR) {
    drafts.push({
      id: "runtime.node",
      group: "runtime",
      title: "Node.js 版本",
      status: "fail",
      severity: "P1",
      summary: `Node.js ${runtime.node} 低于插件要求的 24.x。`,
      guidance: [
        `当前 Node.js 版本是 ${runtime.node}，插件声明要求主版本不低于 ${MINIMUM_NODE_MAJOR}。`,
        "升级 Node.js 到 24 或更高版本，然后重启宿主。",
        "在升级之前，依赖新运行时 API 的功能会明确失败，而不是静默降级。",
      ],
      evidence: { node: runtime.node, major, minimumMajor: MINIMUM_NODE_MAJOR },
    });
  } else {
    drafts.push({
      id: "runtime.node",
      group: "runtime",
      title: "Node.js 版本",
      status: "pass",
      summary: `Node.js ${runtime.node} 满足主版本 ≥ ${MINIMUM_NODE_MAJOR}。`,
      evidence: { node: runtime.node, major, minimumMajor: MINIMUM_NODE_MAJOR },
    });
  }

  if (SUPPORTED_PLATFORMS.has(runtime.platform)) {
    drafts.push({
      id: "runtime.platform",
      group: "runtime",
      title: "操作系统平台",
      status: "pass",
      summary: `运行平台 ${runtime.platform}（${runtime.arch}）在支持列表内。`,
      evidence: { platform: runtime.platform, arch: runtime.arch },
    });
  } else {
    drafts.push({
      id: "runtime.platform",
      group: "runtime",
      title: "操作系统平台",
      status: "warn",
      severity: "P2",
      summary: `运行平台 ${runtime.platform}（${runtime.arch}）不在常规支持列表内。`,
      guidance: [
        "插件只在 win32 / darwin / linux 上做过验证，其它平台的文件路径与锁语义可能不同。",
        "在其它平台上使用时，先用只读方式浏览已有作品，确认路径解析正确后再写入。",
      ],
      evidence: { platform: runtime.platform, arch: runtime.arch },
    });
  }
  return drafts;
}

/* -------------------------------------------------------------------------- */
/* workspace                                                                   */
/* -------------------------------------------------------------------------- */

function workspaceDrafts(environment: DiagnosticsEnvironment): CheckDraft[] {
  const { workspace } = environment;
  const drafts: CheckDraft[] = [];
  if (workspace.creativeProject) {
    drafts.push({
      id: "workspace.creative-project",
      group: "workspace",
      title: "创作项目",
      status: "pass",
      summary: `已在 ${workspace.rootLabel} 检测到创作项目。`,
      evidence: { rootLabel: workspace.rootLabel, creativeProject: true },
    });
  } else {
    drafts.push({
      id: "workspace.creative-project",
      group: "workspace",
      title: "创作项目",
      status: "warn",
      severity: "P2",
      summary: `工作区 ${workspace.rootLabel} 中还没有创作项目。`,
      guidance: [
        "工作台在没有创作文件时是故意隐藏的，这不是插件没加载，也不是故障。",
        `方式一：在对话里描述要写的小说、短剧或游戏，由 story-setup 创建创作目录。`,
        `方式二：创建白名单目录（例如 ${CREATIVE_DIRECTORY_EXAMPLE}），工作台随后就会出现。`,
      ],
      evidence: { rootLabel: workspace.rootLabel, creativeProject: false },
    });
  }

  if (workspace.stateDirectoryPresent) {
    drafts.push({
      id: "workspace.state-directory",
      group: "workspace",
      title: "状态目录",
      status: "pass",
      summary: "插件状态目录已存在。",
      evidence: { stateDirectoryPresent: true },
    });
  } else {
    drafts.push({
      id: "workspace.state-directory",
      group: "workspace",
      title: "状态目录",
      status: "warn",
      severity: "P2",
      summary: "尚未创建插件状态目录（.oh-story）。",
      guidance: [
        "只浏览已有作品不需要状态目录。",
        "写入第一个文件时插件会自动创建它，不需要手动新建。",
      ],
      evidence: { stateDirectoryPresent: false },
    });
  }

  if (!workspace.creativeProject) {
    drafts.push({
      id: "workspace.files",
      group: "workspace",
      title: "工作区文件",
      status: "pass",
      summary: "没有创作项目，无需检查文件数量。",
      evidence: { creativeProject: false, fileCount: workspace.fileCount },
    });
  } else if (workspace.fileCount > 0) {
    drafts.push({
      id: "workspace.files",
      group: "workspace",
      title: "工作区文件",
      status: "pass",
      summary: `工作区列出了 ${workspace.fileCount} 个文件。`,
      evidence: { creativeProject: true, fileCount: workspace.fileCount },
    });
  } else {
    drafts.push({
      id: "workspace.files",
      group: "workspace",
      title: "工作区文件",
      status: "warn",
      severity: "P2",
      summary: "创作项目已存在，但工作区没有列出任何文件。",
      guidance: [
        `确认工作区根目录下是否已有 ${CREATIVE_DIRECTORY_EXAMPLE} 等创作目录及其内容。`,
        "若文件确实存在，检查工作区指向的目录是否就是创作目录。",
      ],
      evidence: { creativeProject: true, fileCount: 0 },
    });
  }
  return drafts;
}

/* -------------------------------------------------------------------------- */
/* data                                                                        */
/* -------------------------------------------------------------------------- */

function dataDrafts(environment: DiagnosticsEnvironment): CheckDraft[] {
  const drafts: CheckDraft[] = [];
  const entries = environment.workspace.state.entries;
  const byId = new Map<string, StateInventoryEntry>();
  for (const entry of entries) byId.set(entry.id, entry);
  for (const entry of entries) {
    if (entry.status === "missing") continue;
    if (AGGREGATED_DESCRIPTOR_IDS.has(entry.id)) continue;
    // Secret descriptors only report presence; the aggregate vault check owns them.
    if (stateDescriptorForId(entry.id)?.secret === true) continue;
    drafts.push(descriptorDraft(entry));
  }
  drafts.push(vaultDataDraft(environment));
  drafts.push(searchIndexDraft(environment, byId));
  return drafts;
}

function descriptorDraft(entry: StateInventoryEntry): CheckDraft {
  const base = {
    id: `data.${entry.id}`,
    group: "data" as const,
    title: `状态文档：${entry.path}`,
  };
  const evidence: Record<string, DiagnosticEvidenceValue> = {
    path: entry.path,
    status: entry.status,
    schemaVersion: entry.schemaVersion,
    expectedVersion: entry.expectedVersion,
    entries: entry.entries,
  };
  switch (entry.status) {
    case "ok":
      return {
        ...base,
        status: "pass",
        summary: `${entry.path} 可读（schema v${entry.schemaVersion ?? entry.expectedVersion}，${entry.entries ?? 0} 条记录）。`,
        evidence,
      };
    case "legacy": {
      const descriptor = stateDescriptorForId(entry.id);
      const migratable = descriptor !== undefined && stateDescriptorMigratable(descriptor);
      if (!migratable) {
        return {
          ...base,
          status: "warn",
          severity: "P2",
          summary: `${entry.path} 是没有版本号字段的旧版文档，内容仍可读取。`,
          guidance: [
            "该格式（JSONL / 顶层数组 / 派生数据 / 密钥）不参与 v1 自动迁移；本次诊断没有改写它。",
            "内容仍按现有兼容规则读取；需要改格式时由专门的迁移承载，避免误改追加日志或派生索引。",
          ],
          evidence,
        };
      }
      return {
        ...base,
        status: "warn",
        severity: "P2",
        summary: `${entry.path} 是没有版本号字段的旧版文档，内容仍可读取。`,
        guidance: [
          "文档当前可以正常读取，本次诊断没有改写它。",
          "只有在你明确确认后执行「应用状态迁移」，才会写入新版本；迁移前会先写可回滚的备份目录。",
        ],
        repair: "apply-state-migration",
        evidence,
      };
    }
    case "newer":
      return {
        ...base,
        status: "fail",
        severity: "P1",
        summary: `${entry.path} 由更新版本的插件写入（schema v${entry.schemaVersion ?? 0}，本插件写入 v${entry.expectedVersion}）。`,
        guidance: [
          "这份文档比当前插件新：降级写入或删除都会丢失新版本写入的数据。",
          "先把插件升级到写入该版本的构建，再打开这份文档。",
          "若暂时无法升级，用备份恢复一份与当前插件匹配的副本，并保留现有文件。",
        ],
        evidence,
      };
    case "corrupt":
      return {
        ...base,
        status: "fail",
        severity: "P1",
        summary: `${entry.path} 无法解析为合法文档（状态：corrupt）。`,
        guidance: [
          "插件不会自动修复这份文档，也不会覆盖它。",
          "先复制一份现状作为备份，保留原文件便于后续排查。",
          "再从已知良好的备份副本恢复该文件，恢复后重新运行诊断确认。",
        ],
        evidence,
      };
    case "not-inspected":
      return {
        ...base,
        status: "warn",
        severity: "P2",
        summary: `${entry.path} 未做内容检查${entry.note === undefined ? "" : `：${entry.note}`}。`,
        guidance: [
          "该文件本次没有被读取，状态未知；其它诊断结果不受影响。",
        ],
        evidence,
      };
    case "missing":
    default:
      return {
        ...base,
        status: "warn",
        severity: "P2",
        summary: `${entry.path} 不存在。`,
        guidance: ["该文件缺失；如果没有使用相关功能，可以忽略这一项。"],
        evidence,
      };
  }
}

function vaultDataDraft(environment: DiagnosticsEnvironment): CheckDraft {
  const { vaultEnabled, vaultKeyPresent, vaultSecretsPresent } = environment.credentials;
  const base = { id: "data.vault", group: "data" as const, title: "凭据保险库" };
  const evidence = { vaultEnabled, vaultKeyPresent, vaultSecretsPresent };
  if (vaultSecretsPresent && !vaultKeyPresent) {
    return {
      ...base,
      status: "fail",
      severity: "P0",
      summary: "保险库密文存在，但主密钥不在工作区，密文无法解密。",
      guidance: [
        "密文仍在工作区，但对应的主密钥缺失，任何已保存的凭据都无法解密。",
        "把单独备份过的主密钥恢复到 .oh-story/vault/master.key 后重新诊断。",
        "在恢复之前不要重新初始化保险库，否则现有密文会被覆盖。",
      ],
      evidence,
    };
  }
  if (vaultEnabled && vaultSecretsPresent && vaultKeyPresent) {
    return {
      ...base,
      status: "pass",
      summary: "保险库已启用，主密钥与密文都在工作区。",
      evidence,
    };
  }
  if (!vaultEnabled && (vaultKeyPresent || vaultSecretsPresent)) {
    return {
      ...base,
      status: "warn",
      severity: "P2",
      summary: "保险库当前关闭，但工作区仍保留保险库数据。",
      guidance: [
        "关闭状态下插件不读取也不改写这些文件，数据保持原样。",
        "需要继续使用这些凭据时，重新启用保险库（DSH_MIAOWU_VAULT_ENABLED=1）。",
      ],
      evidence,
    };
  }
  return {
    ...base,
    status: "pass",
    summary: "保险库未使用：未启用，工作区也没有保险库数据。",
    evidence,
  };
}

function searchIndexDraft(
  environment: DiagnosticsEnvironment,
  byId: ReadonlyMap<string, StateInventoryEntry>
): CheckDraft {
  const base = { id: "data.search-index", group: "data" as const, title: "全文检索索引" };
  if (!environment.workspace.creativeProject) {
    return {
      ...base,
      status: "pass",
      summary: "没有创作项目，不需要全文检索索引。",
      evidence: { creativeProject: false },
    };
  }
  const meta = byId.get("search-meta");
  const index = byId.get("search-index");
  const metaStatus = meta === undefined ? "missing" : meta.status;
  const indexStatus = index === undefined ? "missing" : index.status;
  const evidence: Record<string, DiagnosticEvidenceValue> = {
    creativeProject: true,
    searchMetaStatus: metaStatus,
    searchIndexStatus: indexStatus,
    searchIndexEntries: index === undefined ? null : index.entries,
  };
  if (metaStatus === "ok" && indexStatus === "ok") {
    return {
      ...base,
      status: "pass",
      summary: `检索索引正常（meta 与行索引都可读，${index?.entries ?? 0} 条索引记录）。`,
      evidence,
    };
  }
  return {
    ...base,
    status: "warn",
    severity: "P2",
    summary: `检索索引需要重建（meta：${metaStatus}，行索引：${indexStatus}）。`,
    guidance: [
      "检索索引是可再生的派生数据，重建不会改动正文或状态文档。",
      "在诊断面板执行「重建检索索引」即可。",
    ],
    repair: "rebuild-search-index",
    evidence,
  };
}

/* -------------------------------------------------------------------------- */
/* credentials                                                                 */
/* -------------------------------------------------------------------------- */

function credentialDrafts(environment: DiagnosticsEnvironment): CheckDraft[] {
  const { modelConfigured, vaultEnabled, vaultKeyPresent, vaultSecretsPresent } = environment.credentials;
  const drafts: CheckDraft[] = [];
  if (modelConfigured === true) {
    drafts.push({
      id: "credentials.model",
      group: "credentials",
      title: "模型凭据",
      status: "pass",
      summary: "模型凭据已配置，生成类功能可以调用模型。",
      evidence: { modelConfigured: true },
    });
  } else if (modelConfigured === false) {
    drafts.push({
      id: "credentials.model",
      group: "credentials",
      title: "模型凭据",
      status: "fail",
      severity: "P1",
      summary: "未配置模型 API Key，需要模型的功能无法调用。",
      guidance: [
        MODEL_CREDENTIAL_GUIDANCE,
        "配置完成后重新运行诊断确认。",
      ],
      evidence: { modelConfigured: false },
    });
  } else {
    drafts.push({
      id: "credentials.model",
      group: "credentials",
      title: "模型凭据",
      status: "unknown",
      severity: "P2",
      summary: "宿主没有暴露模型凭据清单，无法判断 API Key 是否已配置。",
      guidance: [
        "这是宿主接口能力的限制，不代表 API Key 缺失。",
        "需要确认时请在「设置 → 模型」中查看。",
      ],
      evidence: { modelConfigured: null },
    });
  }

  const vaultBase = { id: "credentials.vault", group: "credentials" as const, title: "保险库凭据" };
  const vaultEvidence = { vaultEnabled, vaultKeyPresent, vaultSecretsPresent };
  if (vaultEnabled && vaultSecretsPresent && !vaultKeyPresent) {
    drafts.push({
      ...vaultBase,
      status: "fail",
      severity: "P1",
      summary: "保险库已启用，但主密钥缺失，已保存的凭据无法解密。",
      guidance: [
        "主密钥不在工作区，插件不能自行重建（重建会让现有密文永久不可解）。",
        "把单独备份的主密钥恢复到 .oh-story/vault/master.key。",
        "恢复后重新运行诊断确认。",
      ],
      evidence: vaultEvidence,
    });
  } else if (vaultEnabled && vaultKeyPresent) {
    drafts.push({
      ...vaultBase,
      status: "pass",
      summary: "保险库已启用，主密钥就位。",
      evidence: vaultEvidence,
    });
  } else if (vaultEnabled) {
    drafts.push({
      ...vaultBase,
      status: "pass",
      summary: "保险库已启用，但还没有写入任何凭据。",
      evidence: vaultEvidence,
    });
  } else if (vaultKeyPresent || vaultSecretsPresent) {
    drafts.push({
      ...vaultBase,
      status: "warn",
      severity: "P2",
      summary: "保险库已关闭，但工作区仍保留保险库数据。",
      guidance: [
        "关闭状态下插件不会读取或改写这些文件，数据保持原样。",
        "需要继续使用这些凭据时，重新启用保险库（DSH_MIAOWU_VAULT_ENABLED=1）。",
      ],
      evidence: vaultEvidence,
    });
  } else {
    drafts.push({
      ...vaultBase,
      status: "pass",
      summary: "保险库未启用，也没有保险库数据。",
      evidence: vaultEvidence,
    });
  }
  return drafts;
}

/* -------------------------------------------------------------------------- */
/* integration                                                                 */
/* -------------------------------------------------------------------------- */

function integrationDrafts(environment: DiagnosticsEnvironment): CheckDraft[] {
  const { integration } = environment;
  const drafts: CheckDraft[] = [];

  if (integration.skills.total >= integration.skills.expectedMinimum) {
    drafts.push({
      id: "integration.skills",
      group: "integration",
      title: "技能加载",
      status: "pass",
      summary: `已加载 ${integration.skills.total} 个技能（最少需要 ${integration.skills.expectedMinimum} 个）。`,
      evidence: {
        total: integration.skills.total,
        expectedMinimum: integration.skills.expectedMinimum,
      },
    });
  } else {
    drafts.push({
      id: "integration.skills",
      group: "integration",
      title: "技能加载",
      status: "fail",
      severity: "P0",
      summary: `插件技能没有加载：当前 ${integration.skills.total} 个，至少需要 ${integration.skills.expectedMinimum} 个。`,
      guidance: [
        "本插件的领域贡献（skills）没有注册到宿主，工作台与相关工具会缺少对应能力。",
        "重新安装或重新启用插件构建，然后重启宿主。",
        "插件不会静默降级：缺失的技能会以失败形式报告。",
      ],
      evidence: {
        total: integration.skills.total,
        expectedMinimum: integration.skills.expectedMinimum,
      },
    });
  }

  const registered = new Set(integration.tools.registered);
  const missing = integration.tools.expected.filter((name) => !registered.has(name));
  if (missing.length === 0) {
    drafts.push({
      id: "integration.tools",
      group: "integration",
      title: "工具注册",
      status: "pass",
      summary: `已注册全部 ${integration.tools.expected.length} 个预期工具。`,
      evidence: {
        expected: integration.tools.expected.length,
        registered: integration.tools.registered.length,
      },
    });
  } else {
    drafts.push({
      id: "integration.tools",
      group: "integration",
      title: "工具注册",
      status: "fail",
      severity: "P0",
      summary: `缺少 ${missing.length} 个工具注册：${missing.join("、")}。`,
      guidance: [
        `以下工具没有注册到宿主：${missing.join("、")}。`,
        "重新安装或重新启用插件构建，然后重启宿主。",
        "插件不会静默降级：缺失的工具会以失败形式报告。",
      ],
      evidence: {
        expected: integration.tools.expected.length,
        registered: integration.tools.registered.length,
        missing: missing.join(", "),
      },
    });
  }

  if (integration.roles.registered >= integration.roles.expected) {
    drafts.push({
      id: "integration.roles",
      group: "integration",
      title: "角色注册",
      status: "pass",
      summary: `已注册 ${integration.roles.registered} 个角色（需要 ${integration.roles.expected} 个）。`,
      evidence: {
        registered: integration.roles.registered,
        expected: integration.roles.expected,
      },
    });
  } else {
    drafts.push({
      id: "integration.roles",
      group: "integration",
      title: "角色注册",
      status: "fail",
      severity: "P1",
      summary: `角色注册不足：当前 ${integration.roles.registered} 个，需要 ${integration.roles.expected} 个。`,
      guidance: [
        "部分角色没有注册到宿主，依赖这些角色的工作流会缺少对应能力。",
        "重新安装或重新启用插件构建，然后重启宿主。",
      ],
      evidence: {
        registered: integration.roles.registered,
        expected: integration.roles.expected,
      },
    });
  }

  if (!integration.plugins.managerAvailable) {
    drafts.push({
      id: "integration.plugins",
      group: "integration",
      title: "插件清单",
      status: "unknown",
      severity: "P2",
      summary: "宿主未提供插件清单接口，无法交叉核对",
      guidance: [
        "接口不可用时无法确认宿主实际加载了哪些插件包。",
        "这不影响其它检查项；需要确认时可在宿主侧查看已安装插件列表。",
      ],
      evidence: { managerAvailable: false },
    });
  } else {
    drafts.push({
      id: "integration.plugins",
      group: "integration",
      title: "插件清单",
      status: "pass",
      summary: `宿主已加载 ${integration.plugins.bundles.length} 个插件包。`,
      evidence: {
        managerAvailable: true,
        bundleCount: integration.plugins.bundles.length,
        bundles: integration.plugins.bundles.join("、"),
      },
    });
  }

  if (!integration.presets.available) {
    drafts.push({
      id: "integration.presets",
      group: "integration",
      title: "预设清单",
      status: "unknown",
      severity: "P2",
      summary: "宿主未提供预设清单接口，无法核对预设加载情况。",
      guidance: [
        "接口不可用时无法确认预设是否已加载。",
        "这不影响其它检查项；需要确认时可在宿主侧查看预设列表。",
      ],
      evidence: { available: false, total: integration.presets.total },
    });
  } else {
    drafts.push({
      id: "integration.presets",
      group: "integration",
      title: "预设清单",
      status: "pass",
      summary: `已加载 ${integration.presets.total} 个预设。`,
      evidence: { available: true, total: integration.presets.total },
    });
  }

  drafts.push(sessionDraft(environment));
  return drafts;
}

function sessionDraft(environment: DiagnosticsEnvironment): CheckDraft {
  const { session } = environment;
  const base = { id: "integration.session", group: "integration" as const, title: "会话日志" };
  const evidence = {
    checked: session.checked,
    readable: session.readable,
    malformed: session.malformed,
  };
  if (!session.checked) {
    return {
      ...base,
      status: "unknown",
      severity: "P2",
      summary: "未检查会话日志：本次采集没有读取宿主会话数据。",
      guidance: [
        "采集阶段没有读取会话日志（没有可检查的会话，或本轮不允许读取），因此无法确认历史会话是否可加载。",
        "会话日志属于宿主数据，插件只读取，不会改写 ~/.dsh 下的任何内容。",
        "需要排查「历史加载失败」时，在允许读取后重新生成诊断。",
      ],
      evidence,
    };
  }
  if (session.readable === false || session.malformed) {
    const malformed = session.malformed || session.reason === "malformed";
    const reason = session.reason ?? (session.readable === false ? "unreadable" : null);
    const guidance: string[] = [];
    if (session.error !== null) guidance.push(`采集到的错误摘要：${session.error}`);
    if (malformed) {
      guidance.push(
        "问题出在宿主的会话数据上：畸形消息（例如空工具调用）会让历史会话在重载时校验失败。",
        "处理方式：在 DSH 的会话列表里删除或归档受影响的会话，或者直接开始一个新会话继续工作。",
        "本插件不会改写 ~/.dsh 下的会话文件，也不会替你删除它们；宿主目录里的文件请交给 DSH 自己管理。"
      );
    } else if (reason === "timeout") {
      guidance.push(
        "会话读取在 5 秒内没有完成；本次没有判定会话内容畸形。",
        "稍后重试；如果持续超时，先确认宿主会话目录可读、磁盘没有停顿，再查看 DSH 自身日志。",
        "本插件不会改写 ~/.dsh 下的任何文件，也不会替你删除它们。"
      );
    } else {
      guidance.push(
        "会话读取失败，但没有证据表明日志内容畸形；可能是会话已删除、权限不足或宿主暂不可用。",
        "确认该会话仍在 DSH 会话列表中并可打开，然后重新运行诊断。",
        "本插件不会改写 ~/.dsh 下的任何文件，也不会替你删除它们；若会话确实丢失，请在 DSH 中新建会话继续。"
      );
    }
    return {
      ...base,
      status: "fail",
      severity: "P1",
      summary: malformed
        ? "会话日志中存在畸形消息，历史会话可能无法加载。"
        : reason === "timeout"
          ? "会话日志读取超时，本次无法确认是否可加载。"
          : "会话日志无法读取，历史会话可能无法加载。",
      guidance,
      evidence: { ...evidence, reason },
    };
  }
  return {
    ...base,
    status: "pass",
    summary: "会话日志可读，未发现畸形消息。",
    evidence,
  };
}
