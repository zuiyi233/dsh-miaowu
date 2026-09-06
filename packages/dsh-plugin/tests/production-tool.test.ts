import type { ChatSnapshot } from "@deepseek-ai/dsh-client-ui-chat/client";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { describe, expect, it } from "vitest";
import { settledProductionIntents } from "../src/client/production-intents.js";
import { createOhStoryProductionTool } from "../src/production-tool.js";
import { OH_STORY_PRODUCTION_TOOL_NAME, validateProductionIntent } from "../src/production-intent.js";

describe("native short-drama production intent tool", () => {
  it("validates semantic focus, sequence and tracked-job intents", () => {
    expect(validateProductionIntent({
      action: "focus_target",
      episode: "剧集/EP001/",
      targetId: "SHOT-EP001-008",
      section: "shots"
    })).toEqual({ action: "focus_target", episode: "剧集/EP001", targetId: "SHOT-EP001-008", section: "shots" });
    expect(validateProductionIntent({
      action: "set_sequence",
      episode: "剧集/EP002",
      shotIds: ["SHOT-EP002-002", "SHOT-EP002-001"]
    }).shotIds).toEqual(["SHOT-EP002-002", "SHOT-EP002-001"]);
    expect(() => validateProductionIntent({ action: "focus_target", episode: "../EP001", targetId: "SHOT-001" })).toThrow(/剧集\/EP001/u);
    expect(() => validateProductionIntent({ action: "focus_target", episode: "剧集/EP001", targetId: "" })).toThrow(/targetId/u);
    expect(() => validateProductionIntent({ action: "set_sequence", episode: "剧集/EP001", shotIds: ["SHOT-A", "SHOT-A"] })).toThrow(/unique/u);
  });

  it("returns a canonical projection result without touching media or files", async () => {
    const tool = createOhStoryProductionTool();
    expect(tool.name).toBe(OH_STORY_PRODUCTION_TOOL_NAME);
    const result = await tool.execute({
      action: "track_job",
      episode: "剧集/EP001",
      targetId: "SHOT-EP001-003",
      jobId: "agent-job-003",
      jobKind: "video",
      expectedOutputs: 1,
      outputs: ["剧集/EP001/制作成果/SHOT-EP001-003-agent-job-003.mp4"],
      prompt: "从冻结关键帧开始运动"
    }, {} as ToolRunContext);
    expect(result).toEqual(expect.objectContaining({ action: "track_job", episode: "剧集/EP001" }));
  });

  it("validates track_job outputs and keeps them optional", () => {
    const base = {
      action: "track_job" as const,
      episode: "剧集/EP001",
      targetId: "SHOT-EP001-003",
      jobId: "agent-job-003",
      jobKind: "video" as const
    };
    // 合法:去空白后透传。
    expect(validateProductionIntent({ ...base, outputs: ["  a.mp4 ", "b.mp4"] }).outputs).toEqual(["a.mp4", "b.mp4"]);
    // 向后兼容:不传不报错、不带字段。
    expect(validateProductionIntent(base).outputs).toBeUndefined();
    // 越界:空数组、超 16 项、全空白、非串一律拒绝。
    expect(() => validateProductionIntent({ ...base, outputs: [] })).toThrow(/outputs/u);
    expect(() => validateProductionIntent({ ...base, outputs: Array.from({ length: 17 }, (_, index) => `f${String(index)}.mp4`) })).toThrow(/outputs/u);
    expect(() => validateProductionIntent({ ...base, outputs: ["   "] })).toThrow(/outputs/u);
    expect(() => validateProductionIntent({ ...base, outputs: ["a.mp4", 42 as unknown as string] })).toThrow(/outputs/u);
  });

  it("exposes track_job outputs in the tool parameters", () => {
    const tool = createOhStoryProductionTool();
    // defineTool 把简写 parameters 规范化为 JSON Schema:字段在 properties 下。
    const properties = (tool.parameters as { readonly properties?: Record<string, { readonly type?: string; readonly items?: { readonly type?: string }; readonly description?: string }> }).properties;
    expect(properties?.["outputs"]?.type).toBe("array");
    expect(properties?.["outputs"]?.items).toEqual({ type: "string" });
    expect(properties?.["outputs"]?.description).toContain("reconciled");
  });

  it("replays only durable successful DSH tool calls in Chat order", () => {
    const block = (callId: string, argsRaw: string, isError = false) => ({
      kind: "tool-result",
      callId,
      isError,
      call: { name: OH_STORY_PRODUCTION_TOOL_NAME, argsRaw },
      content: [],
      subCalls: []
    });
    const nodes = [
      { key: "tool:1", kind: "tool-call", data: { root: block("intent-1", JSON.stringify({ action: "open_section", episode: "剧集/EP001", section: "assets" })) } },
      { key: "tool:2", kind: "tool-call", data: { root: block("intent-2", JSON.stringify({ action: "focus_target", episode: "剧集/EP001", targetId: "SHOT-002" }), true) } },
      { key: "tool:3", kind: "tool-call", data: { root: block("intent-3", "{bad") } }
    ];
    const chat = {
      order: nodes.map((node) => node.key),
      nodes: { get: (key: string) => nodes.find((node) => node.key === key) }
    } as unknown as ChatSnapshot;
    expect(settledProductionIntents(chat)).toEqual([{
      callId: "intent-1",
      intent: { action: "open_section", episode: "剧集/EP001", section: "assets" }
    }]);
  });
});
