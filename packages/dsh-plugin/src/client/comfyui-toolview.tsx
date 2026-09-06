import type { ToolCallViewProps } from "@deepseek-ai/dsh-client-ui-tool/client";
import type { ToolCallBlock } from "@deepseek-ai/dsh-client-ui-conversation/client";
import { endpoint } from "./workbench-ui.js";

/**
 * ComfyUI 工具结果卡片：对成功结果渲染图片网格，异常结构回退原文。
 * 服务端 output.render 只产文本清单（`- <path>（N 字节）`），客户端从该文本
 * 还原 files 列表做预览；服务端不声明 presentationMeta，所以 meta 路径不可用。
 */

// 与服务端 src/comfyui-tool.ts 的 OH_STORY_COMFYUI_TOOL_NAME 同值。
// 服务端模块依赖 node:child_process，不能进 browser bundle，此处用字面量。
export const OH_STORY_COMFYUI_TOOL_NAME = "oh_story_comfyui";

export interface ComfyuiToolFile {
  readonly path: string;
  readonly bytes: number;
}

export interface ComfyuiToolResult {
  readonly files: readonly ComfyuiToolFile[];
  readonly durationMs: number | undefined;
  readonly outputDir: string | undefined;
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif"]);

export function isComfyuiImagePath(path: string): boolean {
  const basename = path.split("/").at(-1) ?? path;
  const dot = basename.lastIndexOf(".");
  if (dot <= 0) return false;
  return IMAGE_EXTENSIONS.has(basename.slice(dot).toLocaleLowerCase());
}

const FILE_LINE_PATTERN = /^-\s+(.+?)\s*（(\d+)\s*字节）$/gmu;
const HEAD_PATTERN = /共\s*(\d+)\s*个文件.*?落在\s*(\S+?)[，,].*?耗时\s*([\d.]+)s/u;

/**
 * 从 tool/result 文本块里还原 comfyui 结构化输出。
 * 行数/形态对不上就返回 undefined 让调用方回退原文，绝不抛错。
 */
export function parseComfyuiResultText(text: string): ComfyuiToolResult | undefined {
  const files: ComfyuiToolFile[] = [];
  for (const match of text.matchAll(FILE_LINE_PATTERN)) {
    const path = match[1]?.trim() ?? "";
    const bytes = Number(match[2]);
    if (path === "" || !Number.isFinite(bytes)) return undefined;
    files.push({ path, bytes });
  }
  if (files.length === 0) return undefined;
  const head = HEAD_PATTERN.exec(text);
  const durationMs = head?.[3] === undefined ? undefined : Number(head[3]) * 1000;
  return {
    files,
    durationMs: durationMs !== undefined && Number.isFinite(durationMs) ? durationMs : undefined,
    outputDir: head?.[2]
  };
}

function flattenResultText(block: ToolCallBlock): string | undefined {
  if (!("kind" in block)) return undefined;
  if (block.isError) return undefined;
  const text = block.content
    .map((item) => {
      if (typeof item !== "object" || item === null || !("type" in item)) return "";
      const record = item as unknown as Record<string, unknown>;
      return record.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .join("\n");
  return text === "" ? undefined : text;
}

/** 何时接管渲染：仅 settled 成功结果且能还原出 files 列表，否则回退原文。 */
export function resolveComfyuiToolResult(block: ToolCallBlock): ComfyuiToolResult | undefined {
  const text = flattenResultText(block);
  if (text === undefined) return undefined;
  return parseComfyuiResultText(text);
}

function formatDuration(durationMs: number | undefined): string {
  if (durationMs === undefined) return "耗时未知";
  return `耗时 ${(durationMs / 1000).toFixed(1)}s`;
}

export interface ComfyuiToolCardProps {
  readonly files: readonly ComfyuiToolFile[];
  readonly durationMs: number | undefined;
  readonly outputDir: string | undefined;
  readonly sessionId: string;
}

export function ComfyuiToolCard({ files, durationMs, outputDir, sessionId }: ComfyuiToolCardProps): React.JSX.Element {
  return <div className="oh-story-comfyui">
    <p className="oh-story-comfyui-head">
      <span>🎨 ComfyUI 生成</span>
      <strong>{files.length} 个文件{outputDir === undefined ? "" : ` · ${outputDir}`}</strong>
      <em>{formatDuration(durationMs)}</em>
    </p>
    <div className="oh-story-comfyui-grid">
      {files.map((file) => isComfyuiImagePath(file.path)
        ? <figure key={file.path} className="oh-story-comfyui-item">
          <img src={endpoint("media", sessionId, file.path)} alt={file.path} loading="lazy" />
          <figcaption title={file.path}>{file.path}</figcaption>
        </figure>
        : <p key={file.path} className="oh-story-comfyui-file">
          <a href={endpoint("media", sessionId, file.path)} target="_blank" rel="noreferrer">{file.path}</a>
          <span>（{file.bytes} 字节）</span>
        </p>)}
    </div>
  </div>;
}

/**
 * keyed toolview 组件：sessionId 由注册时的 inject(sessionId) 注入
 * （`tool.call.toolview` scope 为 session，见 SlotCore.register 的 inject 重载，
 * 同 `oh-story.workspace` 注册的 `inject: (sessionId) => …` 形态）。
 */
export function ComfyuiToolView({ block, sessionId, inspect }: ToolCallViewProps & { readonly sessionId: string }): React.JSX.Element {
  const settled = "kind" in block;
  const state = !settled ? "running" : block.isError ? "error" : "done";
  const fallback = !settled
    ? ""
    : block.content.map((item) => {
      if (typeof item !== "object" || item === null || !("type" in item)) return JSON.stringify(item);
      const record = item as unknown as Record<string, unknown>;
      return record.type === "text" && typeof record.text === "string" ? record.text : JSON.stringify(item);
    }).join("\n");
  const parsed = resolveComfyuiToolResult(block);
  return <details className="oh-story-role" data-state={state}>
    <summary><span>🎨 ComfyUI</span><strong>{parsed === undefined ? "生成结果" : `${String(parsed.files.length)} 张图片`}</strong><em>{state === "running" ? "生成中" : state === "error" ? "失败" : "完成"}</em></summary>
    {!settled || block.isError || parsed === undefined
      ? <pre>{fallback === "" ? "等待生成结果…" : fallback}</pre>
      : <ComfyuiToolCard files={parsed.files} durationMs={parsed.durationMs} outputDir={parsed.outputDir} sessionId={sessionId} />}
    {inspect !== undefined && <button type="button" onClick={inspect}>在轨迹中检查</button>}
  </details>;
}
