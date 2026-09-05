import type { Agent } from "@deepseek-ai/dsh-agent";
import type { Context } from "@deepseek-ai/cordis";
import { defineTool, type ToolDefinition } from "@deepseek-ai/dsh-tools";
import {
  checkpointRunRecord,
  stageCandidateRecord,
  type RunStatus,
} from "./services/tasks.js";
import type { WorkspaceRealm } from "./workspace-route.js";

export const OH_STORY_TASK_TOOL_NAME = "oh_story_task";

export const OH_STORY_TASK_OPS = ["stage_candidate", "checkpoint_run"] as const;
export type OhStoryTaskOp = (typeof OH_STORY_TASK_OPS)[number];

/** Checkpoint 只允许这三个状态:进行中/等人/暂停,终态由工作台收口. */
export const OH_STORY_TASK_STATUSES: readonly RunStatus[] = ["running", "awaiting_user", "paused"];

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`oh_story_task 的 ${label} 必须是字符串。`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** 直接从调用 Agent 构建 realm,不经过 HTTP session 查找,子 Agent 亦可登记. */
async function realmForAgent(agent: Agent): Promise<WorkspaceRealm> {
  const cwd = agent.session.header.cwd;
  if (cwd === undefined) throw new Error("当前 DSH 会话没有工作目录。");
  const fs = agent.ctx.get("fs");
  const sandboxPolicy = agent.ctx.get("sandboxPolicy");
  if (fs === undefined || sandboxPolicy === undefined) throw new Error("DSH 文件系统当前不可用。");
  return { agent, fs, sandboxPolicy, cwd, root: await fs.resolve(cwd) };
}

export function createOhStoryTaskTool(): ToolDefinition {
  return defineTool({
    name: OH_STORY_TASK_TOOL_NAME,
    description: "Stage an AI-suggested change as a decision candidate, or bookmark a long generation run with a checkpoint, in the current DSH Session's oh-story task engine. Staging a candidate never writes files: the creator confirms and applies it from the workbench 任务与候选 panel, so AI suggestions never become decisions by themselves. Checkpointing records progress so an interrupted long run can be resumed.",
    parameters: {
      op: { type: "string", required: true, enum: [...OH_STORY_TASK_OPS], description: "stage_candidate 登记一条待确认建议;checkpoint_run 为长任务落一个可恢复的进度点." },
      kind: { type: "string", required: true, description: "Recipe kind: novel-chapter, drama-batch, game-content, or a custom label." },
      title: { type: "string", description: "Candidate title (required for stage_candidate)." },
      description: { type: "string", description: "Optional rationale shown with the candidate." },
      target: { type: "string", description: "Creative workspace file path the suggestion would change (file candidates can also carry payload.target)." },
      payload: { type: "object", additionalProperties: true, description: "Candidate payload; for file commits use { target, content }." },
      runId: { type: "string", description: "Run to checkpoint, or the run this candidate belongs to." },
      meta: { type: "object", additionalProperties: true, description: "Run metadata recorded at creation (checkpoint_run only)." },
      note: { type: "string", description: "Checkpoint note (checkpoint_run only)." },
      status: { type: "string", enum: [...OH_STORY_TASK_STATUSES], description: "Run status after the checkpoint; default paused." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          op: { type: "string", required: true, enum: [...OH_STORY_TASK_OPS] },
          message: { type: "string", required: true },
          candidateId: { type: "string" },
          runId: { type: "string" },
          status: { type: "string" }
        }
      },
      render: (_args, value) => [{ type: "text", text: value.message }]
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error("oh_story_task requires a calling DSH Agent.");
      const op = args.op;
      if (op === undefined || !OH_STORY_TASK_OPS.includes(op)) {
        throw new Error(`未知 oh_story_task 操作: ${String(args.op)}`);
      }
      const kind = requireString(args.kind, "kind");
      const realm = await realmForAgent(exec.agent);
      if (op === "stage_candidate") {
        const title = requireString(args.title, "title");
        const candidate = await stageCandidateRecord(realm, {
          kind,
          title,
          description: optionalString(args.description),
          payload: optionalRecord(args.payload) ?? {},
          target: optionalString(args.target),
          runId: optionalString(args.runId),
        });
        return {
          op,
          candidateId: candidate.id,
          status: candidate.status,
          message: `已把「${candidate.title}」登记为待确认候选（未写任何文件）；请在创作工作台的「任务与候选」面板确认后应用。`,
        };
      }
      const run = await checkpointRunRecord(realm, {
        kind,
        runId: optionalString(args.runId),
        meta: optionalRecord(args.meta),
        note: optionalString(args.note),
        status: args.status,
      });
      return {
        op,
        runId: run.id,
        status: run.status,
        message: `已把 ${run.kind} 任务 ${run.id} 的进度保存为检查点（状态 ${run.status}）。`,
      };
    }
  });
}

export function registerOhStoryTaskTool(context: Context): void {
  context.tools.register(createOhStoryTaskTool());
}
