import { spawn } from "node:child_process";
import { dirname, isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@deepseek-ai/cordis";
import type { JsonValue } from "@deepseek-ai/dsh-util-values";
import { defineTool, type ToolDefinition, type ToolRunContext } from "@deepseek-ai/dsh-tools";
import { readWorkspaceComfyuiConfigFile, resolveComfyuiConfig } from "./comfyui-status.js";
import { hostPython } from "./host-python.js";

export const OH_STORY_COMFYUI_TOOL_NAME = "oh_story_comfyui";

export const COMFYUI_DEFAULT_COUNT = 1;
export const COMFYUI_MAX_COUNT = 8;
export const COMFYUI_DEFAULT_FILENAME_PREFIX = "comfyui";
export const COMFYUI_DEFAULT_TIMEOUT_SECONDS = 600;
export const COMFYUI_MAX_TIMEOUT_SECONDS = 3600;

const FILENAME_PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

/** 冻结契约 v1：tool 模式下发给 comfyui_runner.py 的 payload。 */
export interface ComfyuiRunnerPayload {
  readonly prompt: string;
  readonly count: number;
  readonly output_dir: string;
  readonly filename_prefix: string;
  readonly timeout_seconds: number;
  readonly workflow?: string;
  readonly negative?: string;
  readonly width?: number;
  readonly height?: number;
  readonly steps?: number;
  readonly cfg?: number;
  readonly seed?: number;
  readonly fps?: number;
  readonly duration_seconds?: number;
  readonly input_image?: string;
}

export interface ComfyuiGeneratedFile {
  readonly path: string;
  readonly bytes: number;
}

export interface ComfyuiRunnerSuccess {
  readonly files: readonly ComfyuiGeneratedFile[];
  readonly prompt_ids: readonly JsonValue[];
  readonly duration_ms: number;
}

export interface ComfyuiSpawnRequest {
  readonly command: string;
  readonly argv: readonly string[];
  readonly stdin: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** 仅当同名环境变量未显式设置时才注入工作区配置值(env 优先);凭据类一律不注入。 */
  readonly env?: Readonly<Record<string, string>> | undefined;
}

export interface ComfyuiSpawnResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type ComfyuiSpawner = (request: ComfyuiSpawnRequest) => Promise<ComfyuiSpawnResult>;

export interface ComfyuiToolDeps {
  readonly spawner?: ComfyuiSpawner;
  readonly pythonCommand?: () => Promise<string>;
  readonly runnerPath?: string;
  readonly moduleUrl?: string;
  /** 注入给定基根的工作区配置读取(默认读基根 `.comfyui/config.json`),测试可替换。 */
  readonly readWorkspaceConfig?: (localDir: string) => Promise<{ readonly workflow?: string | undefined; readonly workflowDir?: string | undefined; readonly baseUrl?: string | undefined }>;
  /** 默认用 process.env,测试可注入假环境。 */
  readonly env?: NodeJS.ProcessEnv;
}

/** src/comfyui-tool.ts 与编译后 lib/comfyui-tool.js 都映射到 packages/dsh-plugin/python/。 */
export function resolveComfyuiRunnerPath(moduleUrl: string): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), "../python/comfyui_runner.py");
}

function isAbsoluteComfyuiPath(value: string): boolean {
  return isAbsolute(value) || win32.isAbsolute(value);
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`oh_story_comfyui 的 ${label} 必须是非空字符串。`);
  }
  return value;
}

function optionalNonEmptyString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`oh_story_comfyui 的 ${label} 必须是字符串。`);
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function optionalFiniteNumber(value: unknown, label: string, integer: boolean): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`oh_story_comfyui 的 ${label} 必须是数字。`);
  }
  if (integer && !Number.isInteger(value)) {
    throw new Error(`oh_story_comfyui 的 ${label} 必须是整数。`);
  }
  return value;
}

/** 参数校验 + 默认值回填，纯函数便于单测。 */
export function validateComfyuiArgs(raw: Record<string, unknown>): {
  payload: ComfyuiRunnerPayload;
  outputDir: string;
  inputImage: string | undefined;
} {
  const prompt = requireNonEmptyString(raw.prompt, "prompt（正向提示词）");
  const outputDir = requireNonEmptyString(raw.output_dir, "output_dir");
  if (isAbsoluteComfyuiPath(outputDir)) {
    throw new Error(`oh_story_comfyui 的 output_dir 必须是工作区内相对路径，拒绝绝对路径：${outputDir}`);
  }
  const inputImage = optionalNonEmptyString(raw.input_image, "input_image");
  if (inputImage !== undefined && isAbsoluteComfyuiPath(inputImage)) {
    throw new Error(`oh_story_comfyui 的 input_image 必须是工作区内相对路径，拒绝绝对路径：${inputImage}`);
  }
  const count = optionalFiniteNumber(raw.count, "count", true) ?? COMFYUI_DEFAULT_COUNT;
  if (count < 1 || count > COMFYUI_MAX_COUNT) {
    throw new Error(`oh_story_comfyui 的 count 必须在 1–${COMFYUI_MAX_COUNT} 之间，当前为 ${count}。`);
  }
  const timeoutSeconds = optionalFiniteNumber(raw.timeout_seconds, "timeout_seconds", true)
    ?? COMFYUI_DEFAULT_TIMEOUT_SECONDS;
  if (timeoutSeconds < 1 || timeoutSeconds > COMFYUI_MAX_TIMEOUT_SECONDS) {
    throw new Error(`oh_story_comfyui 的 timeout_seconds 必须在 1–${COMFYUI_MAX_TIMEOUT_SECONDS} 之间，当前为 ${timeoutSeconds}。`);
  }
  const filenamePrefix = optionalNonEmptyString(raw.filename_prefix, "filename_prefix")
    ?? COMFYUI_DEFAULT_FILENAME_PREFIX;
  if (!FILENAME_PREFIX_PATTERN.test(filenamePrefix)) {
    throw new Error(`oh_story_comfyui 的 filename_prefix 只允许字母/数字/._- 且不能以 . 开头，当前为 ${filenamePrefix}。`);
  }
  const workflow = optionalNonEmptyString(raw.workflow, "workflow");
  const negative = optionalNonEmptyString(raw.negative, "negative");
  const width = optionalFiniteNumber(raw.width, "width", true);
  const height = optionalFiniteNumber(raw.height, "height", true);
  const steps = optionalFiniteNumber(raw.steps, "steps", true);
  const cfg = optionalFiniteNumber(raw.cfg, "cfg", false);
  const seed = optionalFiniteNumber(raw.seed, "seed", true);
  const fps = optionalFiniteNumber(raw.fps, "fps", false);
  const durationSeconds = optionalFiniteNumber(raw.duration_seconds, "duration_seconds", false);
  return {
    payload: {
      prompt,
      count,
      output_dir: outputDir,
      filename_prefix: filenamePrefix,
      timeout_seconds: timeoutSeconds,
      ...(workflow === undefined ? {} : { workflow }),
      ...(negative === undefined ? {} : { negative }),
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
      ...(steps === undefined ? {} : { steps }),
      ...(cfg === undefined ? {} : { cfg }),
      ...(seed === undefined ? {} : { seed }),
      ...(fps === undefined ? {} : { fps }),
      ...(durationSeconds === undefined ? {} : { duration_seconds: durationSeconds }),
      ...(inputImage === undefined ? {} : { input_image: inputImage })
    },
    outputDir,
    inputImage
  };
}

interface ComfyuiFsLike {
  resolve(path: string, opts?: { cwd?: string }): Promise<unknown>;
  contains(parent: unknown, child: unknown): boolean;
  processPath(target: unknown): string;
}

export interface ComfyuiWorkspaceBase {
  /** spawn 的本地工作目录（工作区根）。 */
  readonly localDir: string;
  /** 基根来源：dsh-fs（真工作区根）或 process-cwd（退路，见报告限制）。 */
  readonly kind: "dsh-fs" | "process-cwd";
  resolveInside(relativePath: string, label: string): Promise<string>;
}

/**
 * 工作区基根取法：优先走调用 Agent 的 dsh-fs（task-tool.ts realmForAgent 同款：
 * agent.session.header.cwd + fs.resolve/contain + fs.processPath 落本地 spawn 目录）；
 * 拿不到 Agent/fs 时退回 process.cwd() 并在 kind 中标明，调用方不得静默。
 */
export async function resolveComfyuiWorkspaceBase(exec: ToolRunContext): Promise<ComfyuiWorkspaceBase> {
  const agent = (exec as { agent?: unknown }).agent as
    | { session?: { header?: { cwd?: unknown } }; ctx?: { get?: (key: string) => unknown } }
    | undefined;
  const cwd = agent?.session?.header?.cwd;
  const fs = agent?.ctx?.get?.("fs") as ComfyuiFsLike | undefined;
  if (typeof cwd === "string" && cwd !== "" && fs !== undefined
    && typeof fs.resolve === "function" && typeof fs.contains === "function"
    && typeof fs.processPath === "function") {
    const root = await fs.resolve(cwd);
    const localDir = fs.processPath(root);
    return {
      localDir,
      kind: "dsh-fs",
      async resolveInside(relativePath: string, label: string): Promise<string> {
        const candidate = await fs.resolve(relativePath, { cwd });
        if (!fs.contains(root, candidate)) {
          throw new Error(`oh_story_comfyui 的 ${label} 必须在当前工作区内，拒绝逃逸基根：${relativePath}`);
        }
        return relativePath;
      }
    };
  }
  const fallback = process.cwd();
  return {
    localDir: fallback,
    kind: "process-cwd",
    resolveInside(relativePath: string, label: string): Promise<string> {
      const resolved = resolve(fallback, relativePath);
      const inside = relative(fallback, resolved);
      if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsoluteComfyuiPath(inside)) {
        return Promise.reject(new Error(`oh_story_comfyui 的 ${label} 必须在当前工作区内，拒绝逃逸基根：${relativePath}`));
      }
      return Promise.resolve(relativePath);
    }
  };
}

/** JSON.parse 的产物天然是 JSON 值；递归守卫把 unknown 收窄为 JsonValue。 */
function asJsonValue(value: unknown): JsonValue {
  if (value === null) return null;
  const tag = typeof value;
  if (tag === "string" || tag === "number" || tag === "boolean") return value as JsonValue;
  if (Array.isArray(value)) return value.map(asJsonValue);
  if (tag === "object") {
    const record: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) record[key] = asJsonValue(entry);
    return record;
  }
  throw new Error("ComfyUI runner 返回了 JSON 无法表示的值。");
}
/** stdout 里可能附带的 {"error": {...}}，成功与失败路径共用。 */
export function extractComfyuiRunnerError(stdout: string): string | undefined {
  try {
    const parsed = JSON.parse(stdout) as { error?: unknown };
    if (parsed !== null && typeof parsed === "object" && "error" in parsed && parsed.error !== undefined) {
      const detail = parsed.error as { message?: unknown; code?: unknown };
      const message = typeof detail === "object" && detail !== null && typeof detail.message === "string"
        ? detail.message
        : JSON.stringify(parsed.error);
      const rawCode = typeof detail === "object" && detail !== null ? detail.code : undefined;
      const code = typeof rawCode === "string" || typeof rawCode === "number" ? `（${rawCode}）` : "";
      return `${message}${code}`;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** 解析 runner 成功输出，形状不对就显式报错，绝不吞错。 */
export function parseComfyuiRunnerStdout(stdout: string): ComfyuiRunnerSuccess {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    throw new Error(`ComfyUI runner 返回了无法解析的 stdout（非 JSON），请检查 runner 日志：${stdout.slice(0, 500)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("ComfyUI runner 返回的 JSON 不是对象，请检查 runner 日志。");
  }
  const record = parsed as Record<string, unknown>;
  if (record.error !== undefined) {
    throw new Error(`ComfyUI runner 报错：${extractComfyuiRunnerError(stdout) ?? JSON.stringify(record.error)}`);
  }
  if (!Array.isArray(record.files)) {
    throw new Error("ComfyUI runner 返回缺少 files 数组，请检查 runner 日志。");
  }
  const files: ComfyuiGeneratedFile[] = record.files.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`ComfyUI runner 返回的 files[${index}] 不是对象。`);
    }
    const item = entry as Record<string, unknown>;
    if (typeof item.path !== "string" || item.path === "") {
      throw new Error(`ComfyUI runner 返回的 files[${index}].path 非法。`);
    }
    if (typeof item.bytes !== "number" || !Number.isFinite(item.bytes)) {
      throw new Error(`ComfyUI runner 返回的 files[${index}].bytes 非法。`);
    }
    return { path: item.path, bytes: item.bytes };
  });
  if (record.prompt_ids !== undefined && !Array.isArray(record.prompt_ids)) {
    throw new Error("ComfyUI runner 返回的 prompt_ids 不是数组。");
  }
  if (typeof record.duration_ms !== "number" || !Number.isFinite(record.duration_ms)) {
    throw new Error("ComfyUI runner 返回缺少合法的 duration_ms。");
  }
  const promptIds = record.prompt_ids === undefined ? [] : (asJsonValue(record.prompt_ids) as JsonValue[]);
  return { files, prompt_ids: promptIds, duration_ms: record.duration_ms };
}

function tailText(value: string, limit = 2000): string {
  return value.length <= limit ? value : `…${value.slice(value.length - limit)}`;
}

function defaultSpawnRunner(request: ComfyuiSpawnRequest): Promise<ComfyuiSpawnResult> {
  return new Promise<ComfyuiSpawnResult>((resolvePromise, rejectPromise) => {
    // overlay 只补缺:进程已有 env 永远优先,工作区配置不能覆盖部署级显式设置。
    const child = spawn(request.command, [...request.argv], {
      cwd: request.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      ...(request.env === undefined ? {} : { env: { ...process.env, ...request.env } })
    });
    const chunks: string[] = [];
    const errors: string[] = [];
    let settled = false;
    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* 进程可能已退出 */ }
      rejectPromise(new Error(message));
    };
    const timer = setTimeout(() => {
      fail(`ComfyUI runner 超时（${String(Math.round(request.timeoutMs / 1000))}s），已终止进程，cwd=${request.cwd}`);
    }, request.timeoutMs);
    timer.unref?.();
    child.on("error", (cause) => {
      fail(`无法启动 ComfyUI runner（${request.command}）：${cause instanceof Error ? cause.message : String(cause)}`);
    });
    child.stdout?.on("data", (chunk: Buffer | string) => { chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8")); });
    child.stderr?.on("data", (chunk: Buffer | string) => { errors.push(typeof chunk === "string" ? chunk : chunk.toString("utf8")); });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ exitCode: code, stdout: chunks.join(""), stderr: errors.join("") });
    });
    if (request.signal !== undefined) {
      if (request.signal.aborted) {
        fail("ComfyUI 生成已被调用方取消。");
        return;
      }
      request.signal.addEventListener("abort", () => {
        fail("ComfyUI 生成已被调用方取消。");
      }, { once: true });
    }
    try {
      if (child.stdin === null) {
        fail("ComfyUI runner 的 stdin 不可用，无法下发 payload。");
        return;
      }
      child.stdin.write(request.stdin, "utf8");
      child.stdin.end();
    } catch (cause) {
      fail(`向 ComfyUI runner 下发 payload 失败：${cause instanceof Error ? cause.message : String(cause)}`);
    }
  });
}

/**
 * 工作区配置注入:工具解析出的生效值只在同名 env 未显式设置时才带给子进程(env 优先)。
 * runner 只认环境变量,所以注入在 TS 侧完成;凭据类(COMFYUI_API_KEY 等)这里一律不碰。
 */
export function comfyuiWorkspaceEnvOverlay(
  env: NodeJS.ProcessEnv,
  file: { readonly baseUrl?: string | undefined; readonly workflow?: string | undefined; readonly workflowDir?: string | undefined }
): Record<string, string> {
  const resolved = resolveComfyuiConfig(env, file);
  const overlay: Record<string, string> = {};
  if ((env.COMFYUI_BASE_URL ?? "") === "" && resolved.baseUrlSource === "workspace-file") {
    overlay.COMFYUI_BASE_URL = resolved.baseUrl;
  }
  if ((env.COMFYUI_WORKFLOW ?? "") === "" && resolved.workflow !== undefined) {
    overlay.COMFYUI_WORKFLOW = resolved.workflow;
  }
  if ((env.COMFYUI_WORKFLOW_DIR ?? "") === "" && resolved.workflowDir !== undefined) {
    overlay.COMFYUI_WORKFLOW_DIR = resolved.workflowDir;
  }
  return overlay;
}

export function createOhStoryComfyuiTool(deps: ComfyuiToolDeps = {}): ToolDefinition {
  const spawner = deps.spawner ?? defaultSpawnRunner;
  return defineTool({
    name: OH_STORY_COMFYUI_TOOL_NAME,
    description: "本地/局域网 ComfyUI 通用图片生成入口（封面、游戏美术等）。工作流为预设的 ComfyUI API JSON（含 __PROMPT__ 等占位符），经 workflow 参数或 COMFYUI_WORKFLOW 环境变量选择；未配置工作流时显式报错。凭据只读 COMFYUI_API_KEY 等环境变量。产物写入当前工作区的 output_dir。",
    parameters: {
      prompt: { type: "string", required: true, description: "正向提示词，将填入工作流的 __PROMPT__ 占位符。" },
      workflow: { type: "string", description: "工作流名（COMFYUI_WORKFLOW_DIR 下文件名去 .json）或 .json 文件路径；缺省用 COMFYUI_WORKFLOW 环境变量。" },
      negative: { type: "string", description: "反向提示词。" },
      width: { type: "integer", description: "生成宽度像素。" },
      height: { type: "integer", description: "生成高度像素。" },
      steps: { type: "integer", description: "采样步数。" },
      cfg: { type: "number", description: "CFG Scale。" },
      seed: { type: "integer", description: "随机种子。" },
      fps: { type: "number", description: "视频帧率（视频工作流）。" },
      duration_seconds: { type: "number", description: "视频时长秒数（视频工作流）。" },
      count: { type: "integer", default: COMFYUI_DEFAULT_COUNT, description: "生成张数，1–8，默认 1。" },
      input_image: { type: "string", description: "工作区内参考图相对路径。" },
      output_dir: { type: "string", required: true, description: "产物输出目录，相对当前工作区根的路径。" },
      filename_prefix: { type: "string", default: COMFYUI_DEFAULT_FILENAME_PREFIX, description: "输出文件名前缀，默认 comfyui，仅允许字母/数字/._-。" },
      timeout_seconds: { type: "integer", default: COMFYUI_DEFAULT_TIMEOUT_SECONDS, description: "等待超时秒数，默认 600，上限 3600。" }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          files: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                path: { type: "string", required: true },
                bytes: { type: "integer", required: true }
              }
            }
          },
          prompt_ids: { type: "array", required: true, items: { type: "json" } },
          duration_ms: { type: "number", required: true },
          output_dir: { type: "string", required: true }
        }
      },
      render: (_args, value) => {
        const seconds = (value.duration_ms / 1000).toFixed(1);
        const lines = [
          `ComfyUI 生成完成：共 ${String(value.files.length)} 个文件，落在 ${value.output_dir}，耗时 ${seconds}s。`,
          ...value.files.map((file) => `- ${file.path}（${String(file.bytes)} 字节）`)
        ];
        return [{ type: "text", text: lines.join("\n") }];
      }
    },
    isConcurrencySafe: () => false,
    async execute(rawArgs, exec) {
      const { payload, outputDir, inputImage } = validateComfyuiArgs(rawArgs);
      const base = await resolveComfyuiWorkspaceBase(exec);
      await base.resolveInside(outputDir, "output_dir");
      if (inputImage !== undefined) await base.resolveInside(inputImage, "input_image");
      const pythonCommand = deps.pythonCommand !== undefined
        ? await deps.pythonCommand()
        : (await hostPython()).command;
      const runnerPath = deps.runnerPath ?? resolveComfyuiRunnerPath(deps.moduleUrl ?? import.meta.url);
      const env = deps.env ?? process.env;
      const readConfig = deps.readWorkspaceConfig ?? readWorkspaceComfyuiConfigFile;
      // 工作区配置读失败只视为"无配置",不阻断工具:读盘是领域数据,不是执行错误。
      const file = await readConfig(base.localDir).catch(() => ({}));
      const overlay = comfyuiWorkspaceEnvOverlay(env, file);
      let spawned: ComfyuiSpawnResult;
      try {
        spawned = await spawner({
          command: pythonCommand,
          argv: [runnerPath, "tool"],
          stdin: JSON.stringify(payload),
          cwd: base.localDir,
          timeoutMs: payload.timeout_seconds * 1000,
          signal: exec.signal,
          ...(Object.keys(overlay).length === 0 ? {} : { env: overlay })
        });
      } catch (cause) {
        throw new Error(`ComfyUI runner 启动或执行失败：${cause instanceof Error ? cause.message : String(cause)}`, { cause });
      }
      if (spawned.exitCode !== 0) {
        const runnerError = extractComfyuiRunnerError(spawned.stdout);
        const stderr = spawned.stderr.trim() === "" ? "" : ` stderr=${tailText(spawned.stderr.trim())}`;
        throw new Error(
          `ComfyUI runner 执行失败（exit=${String(spawned.exitCode)}）：${runnerError ?? "runner 未返回结构化错误"}${stderr}`
        );
      }
      const success = parseComfyuiRunnerStdout(spawned.stdout);
      return {
        files: success.files.map((file) => ({ path: file.path, bytes: file.bytes })),
        prompt_ids: [...success.prompt_ids],
        duration_ms: success.duration_ms,
        output_dir: outputDir
      };
    }
  });
}

export function registerOhStoryComfyuiTool(context: Context): void {
  context.tools.register(createOhStoryComfyuiTool());
}
