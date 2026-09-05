/**
 * 本地 ComfyUI 服务的在线状态与工作流配置状态,只上报"是否可用",
 * 绝不回传任何凭据值(COMFYUI_API_KEY 只随探测请求发出,不进响应)。
 */
export const COMFYUI_DEFAULT_BASE_URL = "http://127.0.0.1:8188";
// 注意:该默认值与 python/comfyui_runner.py 的默认值保持一致,跨语言无法共享常量,改一处必须同步另一处。
const COMFYUI_PROBE_TIMEOUT_MS = 1_500;

export interface ComfyuiProbeResult {
  readonly online: boolean;
  readonly version?: string | undefined;
  readonly baseUrl: string;
  readonly error?: string | undefined;
}

export interface ComfyuiWorkflowStatus {
  readonly configured: boolean;
  readonly source: "env-file" | "env-dir" | null;
}

export interface ComfyuiPreflightSummary extends ComfyuiProbeResult {
  readonly workflow: ComfyuiWorkflowStatus;
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

/** COMFYUI_BASE_URL 非空且为 http/https 合法 URL 则用之,否则回退默认值。 */
export function comfyuiBaseUrl(env: NodeJS.ProcessEnv): string {
  const raw = (env.COMFYUI_BASE_URL ?? "").trim();
  if (raw === "" || !isHttpUrl(raw)) return COMFYUI_DEFAULT_BASE_URL;
  return raw.replace(/\/+$/u, "");
}

function invalidBaseNote(env: NodeJS.ProcessEnv): string | undefined {
  const raw = (env.COMFYUI_BASE_URL ?? "").trim();
  if (raw === "" || isHttpUrl(raw)) return undefined;
  return `COMFYUI_BASE_URL 非法(${raw}),已回退默认 ${COMFYUI_DEFAULT_BASE_URL}`;
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
export async function probeComfyui(env: NodeJS.ProcessEnv, fetchImpl: ComfyuiFetch = defaultComfyuiFetch): Promise<ComfyuiProbeResult> {
  const baseUrl = comfyuiBaseUrl(env);
  const fallbackNote = invalidBaseNote(env);
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
export function comfyuiWorkflowStatus(env: NodeJS.ProcessEnv): ComfyuiWorkflowStatus {
  if ((env.COMFYUI_WORKFLOW ?? "").trim() !== "") return { configured: true, source: "env-file" };
  if ((env.COMFYUI_WORKFLOW_DIR ?? "").trim() !== "") return { configured: true, source: "env-dir" };
  return { configured: false, source: null };
}
