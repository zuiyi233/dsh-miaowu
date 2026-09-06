import type { Context } from "@deepseek-ai/cordis";
import type { FileSystem, FsTarget } from "@deepseek-ai/dsh-fs";
import { defineTool, type ToolDefinition, type ToolRunContext } from "@deepseek-ai/dsh-tools";
import {
  OH_STORY_PRODUCTION_TOOL_NAME,
  PRODUCTION_INTENT_ACTIONS,
  PRODUCTION_INTENT_JOB_KINDS,
  PRODUCTION_INTENT_SECTIONS,
  validateProductionIntent,
  type ProductionIntentArgs
} from "./production-intent.js";

/** set_sequence 落盘文件名：冻结 schema，解析与 UI 展示都按此契约读。 */
export const PRODUCTION_SEQUENCE_FILENAME = "_sequence.json";

export interface ProductionSequenceDocument {
  readonly episode: string;
  readonly shotIds: readonly string[];
  readonly updatedAt: string;
}

/** 冻结 schema：{"episode":"EP001","shotIds":[...],"updatedAt":"<ISO8601>"}。 */
export function sequenceDocument(episode: string, shotIds: readonly string[], updatedAt: string): ProductionSequenceDocument {
  return { episode, shotIds: [...shotIds], updatedAt };
}

export interface ProductionSequenceRealm {
  readonly fs: Pick<FileSystem, "resolve" | "contains" | "stat" | "writeText">;
  readonly root: FsTarget;
  readonly cwd: string;
  readonly sandboxPolicy?: unknown;
}

export interface ProductionToolDeps {
  /** 覆盖落盘时钟；默认 new Date().toISOString()。 */
  readonly now?: () => string;
  /** 覆盖 realm 解析；默认从调用 Agent 的 dsh-fs 取。测试注入内存实现。 */
  readonly resolveSequenceRealm?: (exec: ToolRunContext) => Promise<ProductionSequenceRealm | undefined>;
}

/** 与 task-tool.ts realmForAgent 同款：只认调用 Agent 的 dsh-fs，不做静默退路。 */
async function defaultSequenceRealm(exec: ToolRunContext): Promise<ProductionSequenceRealm | undefined> {
  const agent = (exec as { readonly agent?: unknown }).agent as
    | { readonly session?: { readonly header?: { readonly cwd?: unknown } }; readonly ctx?: { readonly get?: (key: string) => unknown } }
    | undefined;
  const cwd = agent?.session?.header?.cwd;
  const fs = agent?.ctx?.get?.("fs") as Pick<FileSystem, "resolve" | "contains" | "stat" | "writeText"> | undefined;
  if (typeof cwd !== "string" || cwd === "" || fs === undefined) return undefined;
  const sandboxPolicy = agent?.ctx?.get?.("sandboxPolicy");
  return { fs, root: await fs.resolve(cwd), cwd, sandboxPolicy };
}

// 与 services/tasks.ts sandboxFor 同模式：能取到策略就透给 writeText，取不到走后端默认。
function sandboxFor(realm: ProductionSequenceRealm): unknown {
  try {
    const policy = realm.sandboxPolicy as { resolve?: (arg: unknown) => unknown } | undefined;
    if (typeof policy?.resolve !== "function") return undefined;
    return policy.resolve({ session: (realm as { agent?: { session?: unknown } }).agent?.session });
  } catch {
    return undefined;
  }
}

/**
 * set_sequence 落盘：顺序写入工作区 剧集/<EP>/_sequence.json。
 * EP 目录不存在、shotIds 为空显式报错；写失败向上抛，不吞。
 */
export async function persistProductionSequence(
  realm: ProductionSequenceRealm,
  episode: string,
  shotIds: readonly string[],
  now: () => string
): Promise<string> {
  if (shotIds.length === 0) throw new Error("oh_story_production shotIds must contain at least one shot for set_sequence.");
  const relativePath = `${episode}/${PRODUCTION_SEQUENCE_FILENAME}`;
  const directory = await realm.fs.resolve(episode, { cwd: realm.cwd });
  if (!realm.fs.contains(realm.root, directory)) {
    throw new Error(`oh_story_production 落盘越界：${relativePath} 离开了当前工作区。`);
  }
  const info = await realm.fs.stat(directory).catch(() => undefined);
  if (info?.type !== "directory") {
    throw new Error(`oh_story_production set_sequence 落盘失败：${episode} 目录不存在，先创建剧集目录再定顺序。`);
  }
  const target = await realm.fs.resolve(relativePath, { cwd: realm.cwd });
  if (!realm.fs.contains(realm.root, target)) {
    throw new Error(`oh_story_production 落盘越界：${relativePath} 离开了当前工作区。`);
  }
  const short = episode.split("/").pop() ?? episode;
  const body = `${JSON.stringify(sequenceDocument(short, shotIds, now()))}\n`;
  await realm.fs.writeText(target, body, undefined, undefined, sandboxFor(realm) as never);
  return relativePath;
}

function intentMessage(intent: ProductionIntentArgs, persisted?: string): string {
  if (intent.action === "track_job") return `已把 ${intent.targetId ?? "生产对象"} 的 ${intent.jobKind ?? "媒体"} 任务投影到 ${intent.episode} 的任务板。`;
  if (intent.action === "set_sequence") {
    const base = `已把 ${String(intent.shotIds?.length ?? 0)} 个镜头的顺序发送到 ${intent.episode} 成片视图。`;
    return persisted === undefined ? base : `${base}已落盘 ${persisted}。`;
  }
  if (intent.action === "focus_target") return `已请求 ${intent.episode} 生产视图聚焦 ${intent.targetId ?? "目标"}。`;
  return `已把 ${intent.action} 界面意图发送到 ${intent.episode} 生产工作台。`;
}

export function createOhStoryProductionTool(deps: ProductionToolDeps = {}): ToolDefinition {
  const now = deps.now ?? (() => new Date().toISOString());
  const resolveRealm = deps.resolveSequenceRealm ?? defaultSequenceRealm;
  return defineTool({
    name: OH_STORY_PRODUCTION_TOOL_NAME,
    description: "Operate the native oh-story short-drama production projection in the current DSH Session. It can open or focus semantic production targets, set an explicit shot order, or track a job the Agent is actually executing. It never controls cosmetic canvas layout, generates media, changes creator documents, or counts as creator confirmation for paid production.",
    parameters: {
      action: { type: "string", required: true, enum: PRODUCTION_INTENT_ACTIONS, description: "The exact production UI/task projection operation." },
      episode: { type: "string", required: true, description: "Creator-first episode directory, for example 剧集/EP001." },
      section: { type: "string", enum: PRODUCTION_INTENT_SECTIONS },
      targetId: { type: "string" },
      shotIds: { type: "array", items: { type: "string" } },
      jobId: { type: "string", description: "Stable ID that must also appear in produced output filenames." },
      jobKind: { type: "string", enum: PRODUCTION_INTENT_JOB_KINDS },
      expectedOutputs: { type: "integer", description: "Number of media files this job will produce. Repeat the count the creator approved when re-registering a batch; omit it to keep the count the workbench already recorded." },
      outputs: { type: "array", items: { type: "string" }, description: "Confirmed job output filenames; lets the workbench warn before confirmation when a filename cannot be reconciled." },
      prompt: { type: "string", description: "Exact prompt/specification for a tracked job; not a production authorization." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", required: true, enum: PRODUCTION_INTENT_ACTIONS },
          episode: { type: "string", required: true },
          message: { type: "string", required: true }
        }
      },
      render: (_args, value) => [{ type: "text", text: value.message }]
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const intent = validateProductionIntent(args);
      if (intent.action === "set_sequence") {
        const realm = await resolveRealm(exec);
        // 无 Agent/fs（单测直调等）时退回纯投影：不静默写本地，状态投影语义不变。
        if (realm === undefined) {
          return Promise.resolve({ action: intent.action, episode: intent.episode, message: intentMessage(intent) });
        }
        const persisted = await persistProductionSequence(realm, intent.episode, intent.shotIds ?? [], now);
        return Promise.resolve({ action: intent.action, episode: intent.episode, message: intentMessage(intent, persisted) });
      }
      return Promise.resolve({ action: intent.action, episode: intent.episode, message: intentMessage(intent) });
    }
  });
}

export function registerOhStoryProductionTool(context: Context): void {
  context.tools.register(createOhStoryProductionTool());
}
