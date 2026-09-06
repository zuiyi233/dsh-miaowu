import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

/**
 * 本地 ComfyUI 服务的在线状态与工作流配置状态,只上报"是否可用",
 * 绝不回传任何凭据值(COMFYUI_API_KEY 只随探测请求发出,不进响应)。
 */
export const COMFYUI_DEFAULT_BASE_URL = "http://127.0.0.1:8188";
// 注意:该默认值与 python/comfyui_runner.py 的默认值保持一致,跨语言无法共享常量,改一处必须同步另一处。
const COMFYUI_PROBE_TIMEOUT_MS = 1_500;

/**
 * 工作区级 ComfyUI 配置:工作区根 `.comfyui/config.json`,三键均可选。
 * 优先级:环境变量 > 工作区配置文件 > 内置默认(各键独立)。
 * 工作区文件属于插件领域数据,绝不碰 ~/.dsh 宿主状态。
 */
export const COMFYUI_CONFIG_RELATIVE_PATH = ".comfyui/config.json";
const COMFYUI_CONFIG_BODY_MAX_BYTES = 64 * 1_024;
const COMFYUI_CONFIG_KEYS = ["baseUrl", "workflow", "workflowDir"] as const;

export interface WorkspaceComfyuiConfig {
  readonly baseUrl?: string | undefined;
  readonly workflow?: string | undefined;
  readonly workflowDir?: string | undefined;
}

export type ComfyuiBaseUrlSource = "env" | "workspace-file" | "default";
export type ComfyuiWorkflowSource = "env-file" | "env-dir" | "workspace-file" | null;

export interface ComfyuiProbeResult {
  readonly online: boolean;
  readonly version?: string | undefined;
  readonly baseUrl: string;
  readonly error?: string | undefined;
}

export interface ComfyuiWorkflowStatus {
  readonly configured: boolean;
  readonly source: ComfyuiWorkflowSource;
}

export interface ComfyuiPreflightSummary extends ComfyuiProbeResult {
  readonly workflow: ComfyuiWorkflowStatus;
}

/** 三级合并后的解析结果:生效值 + 每键来源,供 tool 注入、preflight、路由响应共用。 */
export interface ComfyuiResolvedConfig {
  readonly baseUrl: string;
  readonly baseUrlSource: ComfyuiBaseUrlSource;
  readonly baseUrlNote?: string | undefined;
  readonly workflow: string | undefined;
  readonly workflowSource: "env" | "workspace-file" | null;
  readonly workflowDir: string | undefined;
  readonly workflowDirSource: "env" | "workspace-file" | null;
}

/** GET/POST /oh-story/comfyui-config 的同构响应:生效值 + 每键来源;凭据类环境变量绝不进入响应。 */
export interface ComfyuiConfigResponse {
  readonly config: {
    readonly baseUrl: string;
    readonly workflow?: string | undefined;
    readonly workflowDir?: string | undefined;
  };
  readonly source: {
    readonly baseUrl: ComfyuiBaseUrlSource;
    readonly workflow: "param" | "env" | "workspace-file" | null;
    readonly workflowDir: "env" | "workspace-file" | null;
  };
}

/** 结构最小化的 fetch 抽象:默认走全局 fetch,测试可注入假实现。 */
export type ComfyuiFetch = (
  url: string,
  init: { readonly headers?: Readonly<Record<string, string>> | undefined; readonly signal?: AbortSignal | undefined }
) => Promise<{ readonly ok: boolean; readonly status: number; json(): Promise<unknown> }>;

const defaultComfyuiFetch: ComfyuiFetch = (url, init) => {
  const request: RequestInit = { headers: { ...(init.headers ?? {}) } };
  if (init.signal !== undefined) request.signal = init.signal;
  return globalThis.fetch(url, request);
};

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function cleanText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function cleanBaseUrl(value: unknown): string | undefined {
  const trimmed = cleanText(value);
  if (trimmed === undefined || !isHttpUrl(trimmed)) return undefined;
  return trimmed.replace(/\/+$/u, "");
}

/**
 * 宽松解析:给读盘用,非对象、未知键、非法值一律忽略(按"没有配置"处理),不抛异常。
 * 手工改坏的配置文件只会让对应键回退,不阻断 preflight 与工具执行。
 */
export function parseWorkspaceComfyuiConfig(raw: unknown): WorkspaceComfyuiConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  const baseUrl = cleanBaseUrl(record.baseUrl);
  const workflow = cleanText(record.workflow);
  const workflowDir = cleanText(record.workflowDir);
  return {
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(workflow === undefined ? {} : { workflow }),
    ...(workflowDir === undefined ? {} : { workflowDir })
  };
}

/**
 * 严格校验:给 POST 写盘用。未知键、非法 URL、非字符串一律抛错,由路由转成 400。
 * 空字符串视为"清除该键",返回的规范配置只含有效键。
 */
export function validateWorkspaceComfyuiConfigBody(body: unknown): WorkspaceComfyuiConfig {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("ComfyUI 配置必须是 JSON 对象。");
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(COMFYUI_CONFIG_KEYS as readonly string[]).includes(key)) {
      throw new Error(`未知的 ComfyUI 配置键：${key}。`);
    }
  }
  const pick = (key: typeof COMFYUI_CONFIG_KEYS[number], label: string): string | undefined => {
    const value = record[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string") throw new Error(`ComfyUI 配置的${label}必须是字符串。`);
    const trimmed = value.trim();
    if (trimmed === "") return undefined;
    if (key === "baseUrl") {
      if (!isHttpUrl(trimmed)) throw new Error(`ComfyUI 配置的${label}必须是合法 http/https URL：${value}。`);
      return trimmed.replace(/\/+$/u, "");
    }
    return trimmed;
  };
  const baseUrl = pick("baseUrl", "服务地址（baseUrl）");
  const workflow = pick("workflow", "工作流（workflow）");
  const workflowDir = pick("workflowDir", "工作流目录（workflowDir）");
  return {
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(workflow === undefined ? {} : { workflow }),
    ...(workflowDir === undefined ? {} : { workflowDir })
  };
}

/**
 * 三级优先级合并:环境变量 > 工作区配置文件 > 内置默认,各键独立生效。
 * 工作流解析链:调用显式参数(工具层另外处理) > COMFYUI_WORKFLOW(env) >
 * 配置文件 workflow 键 > COMFYUI_WORKFLOW_DIR(env)或配置文件 workflowDir(作 bare-name 查找目录)。
 */
export function resolveComfyuiConfig(env: NodeJS.ProcessEnv, file: WorkspaceComfyuiConfig = {}): ComfyuiResolvedConfig {
  const envBase = (env.COMFYUI_BASE_URL ?? "").trim();
  const envWorkflow = (env.COMFYUI_WORKFLOW ?? "").trim();
  const envWorkflowDir = (env.COMFYUI_WORKFLOW_DIR ?? "").trim();
  const baseUrl = envBase !== "" && isHttpUrl(envBase)
    ? { value: envBase.replace(/\/+$/u, ""), source: "env" as const }
    : file.baseUrl !== undefined
      ? { value: file.baseUrl, source: "workspace-file" as const }
      : { value: COMFYUI_DEFAULT_BASE_URL, source: "default" as const };
  const baseUrlNote = envBase === "" || isHttpUrl(envBase) ? undefined
    : `COMFYUI_BASE_URL 非法(${envBase}),已回退${baseUrl.source === "workspace-file" ? "工作区文件" : "默认"} ${baseUrl.value}`;
  return {
    baseUrl: baseUrl.value,
    baseUrlSource: baseUrl.source,
    ...(baseUrlNote === undefined ? {} : { baseUrlNote }),
    workflow: envWorkflow !== "" ? envWorkflow : file.workflow,
    workflowSource: envWorkflow !== "" ? "env" : file.workflow !== undefined ? "workspace-file" : null,
    workflowDir: envWorkflowDir !== "" ? envWorkflowDir : file.workflowDir,
    workflowDirSource: envWorkflowDir !== "" ? "env" : file.workflowDir !== undefined ? "workspace-file" : null
  };
}

/** COMFYUI_BASE_URL 非空且为 http/https 合法 URL 则用之,否则按 env > 工作区文件 > 默认回退。 */
export function comfyuiBaseUrl(env: NodeJS.ProcessEnv, file: WorkspaceComfyuiConfig = {}): string {
  return resolveComfyuiConfig(env, file).baseUrl;
}

/** 真实 /system_stats 形如 {"system":{"comfyui_version":"..."}};顶层同名字段也认,其余一律不认。 */
function extractComfyuiVersion(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;
  const system = record["system"];
  if (typeof system === "object" && system !== null) {
    const nested = (system as Record<string, unknown>)["comfyui_version"];
    if (typeof nested === "string" && nested.trim() !== "") return nested.trim();
  }
  const top = record["comfyui_version"];
  if (typeof top === "string" && top.trim() !== "") return top.trim();
  return undefined;
}

/**
 * TS 侧唯一的 ComfyUI 网络请求:GET {base}/system_stats。
 * 2xx 且 JSON 含版本号才算 online;连接失败/超时/非 2xx/非 JSON/缺版本号一律 online:false。
 * COMFYUI_API_KEY 非空时以 Authorization: Bearer 发出,值永不进入返回结果。
 * 本函数不抛异常:未知失败也折成 online:false 的 error 摘要。
 */
export async function probeComfyui(
  env: NodeJS.ProcessEnv,
  fetchImpl: ComfyuiFetch = defaultComfyuiFetch,
  file: WorkspaceComfyuiConfig = {}
): Promise<ComfyuiProbeResult> {
  const resolved = resolveComfyuiConfig(env, file);
  const baseUrl = resolved.baseUrl;
  const fallbackNote = resolved.baseUrlNote;
  const describe = (outcome: string): string => (fallbackNote === undefined ? outcome : `${fallbackNote};${outcome}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COMFYUI_PROBE_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {};
    const apiKey = (env.COMFYUI_API_KEY ?? "").trim();
    if (apiKey !== "") headers["Authorization"] = `Bearer ${apiKey}`;
    const response = await fetchImpl(`${baseUrl}/system_stats`, { headers, signal: controller.signal });
    if (!response.ok) return { online: false, baseUrl, error: describe(`HTTP ${String(response.status)}`) };
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { online: false, baseUrl, error: describe("响应不是合法 JSON") };
    }
    const version = extractComfyuiVersion(body);
    if (version === undefined) return { online: false, baseUrl, error: describe("响应缺少 system.comfyui_version") };
    return fallbackNote === undefined
      ? { online: true, version, baseUrl }
      : { online: true, version, baseUrl, error: fallbackNote };
  } catch (error) {
    const outcome = error instanceof Error && error.name === "AbortError"
      ? `请求超时(${String(COMFYUI_PROBE_TIMEOUT_MS / 1_000)}s)`
      : `连接失败:${error instanceof Error ? error.message : String(error)}`;
    return { online: false, baseUrl, error: describe(outcome) };
  } finally {
    clearTimeout(timer);
  }
}

/** 只报"配没配、配在哪",不读文件内容、不回传路径值以外的任何东西。 */
export function comfyuiWorkflowStatus(env: NodeJS.ProcessEnv, file: WorkspaceComfyuiConfig = {}): ComfyuiWorkflowStatus {
  const resolved = resolveComfyuiConfig(env, file);
  if (resolved.workflow !== undefined) {
    return { configured: true, source: resolved.workflowSource === "env" ? "env-file" : "workspace-file" };
  }
  if (resolved.workflowDir !== undefined) {
    return { configured: true, source: resolved.workflowDirSource === "env" ? "env-dir" : "workspace-file" };
  }
  return { configured: false, source: null };
}

/** 读工作区根 `.comfyui/config.json`;缺文件、超限、坏 JSON 一律返回 {},绝不抛异常。 */
export async function readWorkspaceComfyuiConfigFile(
  localDir: string,
  readFileImpl: (path: string) => Promise<string> = (path) => readFile(path, "utf8")
): Promise<WorkspaceComfyuiConfig> {
  let text: string;
  try {
    text = await readFileImpl(join(localDir, ".comfyui", "config.json"));
  } catch {
    return {};
  }
  if (Buffer.byteLength(text, "utf8") > COMFYUI_CONFIG_BODY_MAX_BYTES) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return {};
  }
  return parseWorkspaceComfyuiConfig(parsed);
}

/**
 * 原子写工作区配置:目标目录不存在先建,临时文件 + rename 发布,读方永远看不到截断文件。
 * 调用前先用 validateWorkspaceComfyuiConfigBody 做严格校验;这里再做一次宽松规范化兜底。
 */
export async function writeWorkspaceComfyuiConfigFile(
  localRoot: string,
  config: WorkspaceComfyuiConfig
): Promise<WorkspaceComfyuiConfig> {
  const root = resolve(localRoot);
  const directory = join(root, ".comfyui");
  const location = join(directory, "config.json");
  if (relative(root, location) !== join(".comfyui", "config.json")) {
    throw new Error("ComfyUI 配置路径离开了工作区根。");
  }
  const normalized = parseWorkspaceComfyuiConfig({ ...config });
  const body = `${JSON.stringify(normalized)}\n`;
  // 体积上限:三个短字符串的配置超限说明调用方传错了东西,直接拒绝。
  if (Buffer.byteLength(body, "utf8") > COMFYUI_CONFIG_BODY_MAX_BYTES) {
    throw new Error("ComfyUI 配置内容过大。");
  }
  await mkdir(directory, { recursive: true });
  const staging = `${location}.${String(process.pid)}.tmp`;
  await writeFile(staging, body, "utf8");
  await rename(staging, location);
  return normalized;
}

/** GET/POST /oh-story/comfyui-config 的同构响应构造:生效值 + 每键来源。 */
export function comfyuiConfigResponse(env: NodeJS.ProcessEnv, file: WorkspaceComfyuiConfig): ComfyuiConfigResponse {
  const resolved = resolveComfyuiConfig(env, file);
  return {
    config: {
      baseUrl: resolved.baseUrl,
      ...(resolved.workflow === undefined ? {} : { workflow: resolved.workflow }),
      ...(resolved.workflowDir === undefined ? {} : { workflowDir: resolved.workflowDir })
    },
    source: {
      baseUrl: resolved.baseUrlSource,
      workflow: resolved.workflowSource,
      workflowDir: resolved.workflowDirSource
    }
  };
}
