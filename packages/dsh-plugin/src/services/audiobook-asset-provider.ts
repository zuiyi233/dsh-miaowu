import { createHash } from "node:crypto";
import { readWorkspaceComfyuiConfigFile, resolveComfyuiConfig, type WorkspaceComfyuiConfig } from "../comfyui-status.js";
import { createOhStoryComfyuiTool } from "../comfyui-tool.js";
import { WorkspaceHttpError, type WorkspaceRealm } from "../workspace-route.js";
import { AUDIOBOOK_ASSET_DIRECTORIES } from "./audiobook-assets.js";
import {
  AUDIOBOOK_ROOT,
  type AudiobookAssetKind,
  type AudiobookProjectRecord,
} from "./audiobook-contract.js";

/**
 * 有声剧素材生成 provider（N4-C）。
 *
 * 窄接口只为路由服务：`estimate` 返回预估价，`generate` 产出一批工作区相对路径
 * 的文件与回执。ComfyUI 走现有 `oh_story_comfyui` 工具（不复制 Python 启动逻辑），
 * 本地素材库只登记、不支持生成。本模块不做持久化：授权落盘由路由在成功生成后
 * 统一走 `loadAssetAuthorizations` / `saveAssetAuthorizations` 的 CAS。
 */

export const LOCAL_ASSET_PROVIDER_ID = "local";
export const COMFYUI_ASSET_PROVIDER_ID = "comfyui";
export const DEFAULT_COMFYUI_ASSET_MODEL = "comfyui";
/** 与 `oh_story_comfyui` 的默认超时一致；音频单次生成沿用同一上限。 */
export const DEFAULT_COMFYUI_AUDIO_TIMEOUT_SECONDS = 600;

const PROJECT_FILE = "project.json";
const AUDIO_EXTENSIONS: readonly string[] = [".mp3", ".wav", ".ogg"];

/** 生成产出的单个文件：工作区相对路径 + 字节数。 */
export interface AudioAssetGenerationFile {
  readonly path: string;
  readonly bytes: number;
}

export interface AudioAssetGenerationRequest {
  readonly kind: AudiobookAssetKind;
  readonly prompt: string;
  readonly durationSeconds: number;
  readonly count: number;
}

/** 生成回执的 provider 侧形状；`generatedAt` 由调用方（路由）补上。 */
export interface AudioAssetGenerationResult {
  readonly files: readonly AudioAssetGenerationFile[];
  readonly provider: string;
  readonly model: string;
  readonly promptSha256: string;
  readonly receiptId: string | null;
  readonly cost: number;
}

export interface AudioAssetProvider {
  readonly id: string;
  readonly label: string;
  readonly configured: boolean;
  estimate(request: AudioAssetGenerationRequest): number;
  generate(
    realm: WorkspaceRealm,
    project: AudiobookProjectRecord,
    request: AudioAssetGenerationRequest,
  ): Promise<AudioAssetGenerationResult>;
}

export interface ComfyuiAudioPortInput {
  readonly prompt: string;
  readonly durationSeconds: number;
  readonly outputDir: string;
  readonly filenamePrefix: string;
  readonly timeoutSeconds: number;
}

export interface ComfyuiAudioPortResult {
  readonly files: readonly AudioAssetGenerationFile[];
  readonly promptIds: readonly unknown[];
  readonly durationMs: number;
}

/** 测试注入假实现；生产实现复用 `oh_story_comfyui` 工具。 */
export interface ComfyuiAudioPort {
  generate(input: ComfyuiAudioPortInput): Promise<ComfyuiAudioPortResult>;
}

export interface ComfyUiMusicProviderOptions {
  readonly port: ComfyuiAudioPort;
  /** 由环境变量/工作区配置决定；为假时路由只能预览（生成返回 503）。 */
  readonly configured: boolean;
  readonly model?: string;
  readonly timeoutSeconds?: number;
}

export interface DefaultAssetProviderOptions {
  /** 工作区配置读取（测试可注入）；默认读工作区根 `.comfyui/config.json`。 */
  readonly readConfig?: (localDir: string) => Promise<WorkspaceComfyuiConfig>;
}

function hasControlCharacter(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** 必须是 `有声剧/<book>/project.json`；与 M4B/发布包（Task 5/6）同一规则。 */
export function bookDirectoryForProject(projectPath: string): string {
  const path = projectPath.trim();
  const segments = path.split("/");
  if (path === "" || path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/u.test(path) || segments.length !== 3) {
    throw new WorkspaceHttpError(400, `有声剧项目路径必须是 ${AUDIOBOOK_ROOT}/<书>/${PROJECT_FILE}。`);
  }
  const [root, book, file] = segments;
  if (root !== AUDIOBOOK_ROOT || file !== PROJECT_FILE
    || book === undefined || book === "" || book === "." || book === ".." || hasControlCharacter(book)) {
    throw new WorkspaceHttpError(400, `有声剧项目路径必须是 ${AUDIOBOOK_ROOT}/<书>/${PROJECT_FILE}。`);
  }
  return `${AUDIOBOOK_ROOT}/${book}`;
}

/** 生成输出目录固定为书内的 `素材/音乐` 或 `素材/音效`。 */
export function assetDirectoryFor(projectPath: string, kind: AudiobookAssetKind): string {
  return `${bookDirectoryForProject(projectPath)}/${AUDIOBOOK_ASSET_DIRECTORIES[kind]}`;
}

function isWorkspaceRelative(path: string): boolean {
  if (path === "" || path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/u.test(path)) return false;
  return path
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== ".." && !hasControlCharacter(segment));
}

function isAudioName(name: string): boolean {
  const lower = name.toLowerCase();
  return AUDIO_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/**
 * 生成产物必须直接落在目标素材目录内、扩展名为 .mp3/.wav/.ogg，否则 403。
 * provider 与路由共用：注入的 provider 绕过了 ComfyUI 适配器时路由仍会再校验一次。
 */
export function validateGeneratedAssets(
  projectPath: string,
  kind: AudiobookAssetKind,
  files: readonly AudioAssetGenerationFile[],
): void {
  const directory = assetDirectoryFor(projectPath, kind);
  for (const file of files) {
    const path = typeof file.path === "string" ? file.path : "";
    const name = path.startsWith(`${directory}/`) ? path.slice(directory.length + 1) : null;
    if (!isWorkspaceRelative(path) || name === null || name === "" || name.includes("/") || !isAudioName(name)) {
      throw new WorkspaceHttpError(
        403,
        `生成素材必须落在 ${directory}/ 目录内且为 .mp3/.wav/.ogg 文件：${path}`,
      );
    }
  }
}

function receiptIdOf(promptIds: readonly unknown[]): string | null {
  for (const id of promptIds) {
    if (typeof id === "string" && id.trim() !== "") return id;
    if (typeof id === "number" && Number.isFinite(id)) return String(id);
  }
  return null;
}

/** 工作流路径只用来标注回执里的 model：取最后一段，避免把本机目录写进授权/清单。 */
function modelLabelFor(workflow: string | undefined): string {
  if (workflow === undefined) return DEFAULT_COMFYUI_ASSET_MODEL;
  const label = workflow.split(/[\\/]/u).at(-1)?.trim() ?? "";
  return label === "" ? DEFAULT_COMFYUI_ASSET_MODEL : label;
}

/** 本地素材库只登记已有素材，不调用任何外部服务。 */
export class LocalAssetProvider implements AudioAssetProvider {
  readonly id = LOCAL_ASSET_PROVIDER_ID;
  readonly label = "本地素材库";
  readonly configured = true;

  estimate(): number {
    return 0;
  }

  generate(): Promise<never> {
    return Promise.reject(new WorkspaceHttpError(400, "本地素材库不支持生成。"));
  }
}

/**
 * ComfyUI 音效/音乐生成：每次按 `count` 调一次 port（ComfyUI 单次生成 count 固定 1），
 * 文件名前缀只用 `asset-<kind>-<promptSha256 前 8 位>`，符合工具的字母/数字/._- 约束。
 */
export class ComfyUiMusicProvider implements AudioAssetProvider {
  readonly id = COMFYUI_ASSET_PROVIDER_ID;
  readonly label = "ComfyUI";
  readonly configured: boolean;
  private readonly port: ComfyuiAudioPort;
  private readonly model: string;
  private readonly timeoutSeconds: number;

  constructor(options: ComfyUiMusicProviderOptions) {
    this.port = options.port;
    this.configured = options.configured;
    this.model = options.model === undefined || options.model.trim() === "" ? DEFAULT_COMFYUI_ASSET_MODEL : options.model.trim();
    this.timeoutSeconds = options.timeoutSeconds ?? DEFAULT_COMFYUI_AUDIO_TIMEOUT_SECONDS;
  }

  estimate(): number {
    return 0;
  }

  async generate(
    _realm: WorkspaceRealm,
    project: AudiobookProjectRecord,
    request: AudioAssetGenerationRequest,
  ): Promise<AudioAssetGenerationResult> {
    const outputDir = assetDirectoryFor(project.path, request.kind);
    const promptSha256 = createHash("sha256").update(request.prompt, "utf8").digest("hex");
    const filenamePrefix = `asset-${request.kind}-${promptSha256.slice(0, 8)}`;
    const files: AudioAssetGenerationFile[] = [];
    const promptIds: unknown[] = [];
    for (let index = 0; index < request.count; index += 1) {
      const outcome = await this.port.generate({
        prompt: request.prompt,
        durationSeconds: request.durationSeconds,
        outputDir,
        filenamePrefix,
        timeoutSeconds: this.timeoutSeconds,
      });
      files.push(...outcome.files.map((file) => ({ path: file.path, bytes: file.bytes })));
      promptIds.push(...outcome.promptIds);
    }
    validateGeneratedAssets(project.path, request.kind, files);
    return {
      files,
      provider: this.id,
      model: this.model,
      promptSha256,
      receiptId: receiptIdOf(promptIds),
      cost: 0,
    };
  }
}

/** `oh_story_comfyui` 工具的规范输出（直接 execute 时仍需本地收窄）。 */
interface ComfyuiToolOutput {
  readonly files: readonly { readonly path: string; readonly bytes: number }[];
  readonly prompt_ids: readonly unknown[];
  readonly duration_ms: number;
}

/** 生产 port：复用现有 ComfyUI 工具，工具内部负责 Python 启动与工作区配置注入。 */
export function createComfyuiAudioPort(realm: WorkspaceRealm): ComfyuiAudioPort {
  const tool = createOhStoryComfyuiTool();
  return {
    async generate(input) {
      const exec = {
        agent: {
          session: realm.agent.session,
          ctx: { get: (key: string) => (key === "fs" ? realm.fs : undefined) },
        },
      } as unknown as Parameters<typeof tool.execute>[1];
      const output = await tool.execute({
        prompt: input.prompt,
        output_dir: input.outputDir,
        filename_prefix: input.filenamePrefix,
        duration_seconds: input.durationSeconds,
        count: 1,
        timeout_seconds: input.timeoutSeconds,
      }, exec) as ComfyuiToolOutput;
      if (!Array.isArray(output.files)) {
        throw new WorkspaceHttpError(502, "ComfyUI 素材生成没有返回文件列表。");
      }
      const files = output.files as readonly { readonly path: string; readonly bytes: number }[];
      return {
        files: files.map((file) => ({ path: file.path, bytes: file.bytes })),
        promptIds: Array.isArray(output.prompt_ids) ? (output.prompt_ids as readonly unknown[]) : [],
        durationMs: typeof output.duration_ms === "number" ? output.duration_ms : 0,
      };
    },
  };
}

/**
 * 默认 provider 列表：本地素材库恒在，ComfyUI 按 `COMFYUI_WORKFLOW` 或工作区
 * `.comfyui/config.json` 的 workflow/workflowDir 判定 configured。只读配置，不写盘。
 */
export async function defaultAssetProviders(
  realm: WorkspaceRealm,
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: DefaultAssetProviderOptions = {},
): Promise<readonly AudioAssetProvider[]> {
  const readConfig = options.readConfig ?? readWorkspaceComfyuiConfigFile;
  const file = await readConfig(realm.fs.processPath(realm.root)).catch((): WorkspaceComfyuiConfig => ({}));
  const resolved = resolveComfyuiConfig(env, file);
  const configured = resolved.workflow !== undefined || resolved.workflowDir !== undefined;
  const model = modelLabelFor(resolved.workflow);
  return [
    new LocalAssetProvider(),
    new ComfyUiMusicProvider({ port: createComfyuiAudioPort(realm), configured, model }),
  ];
}
