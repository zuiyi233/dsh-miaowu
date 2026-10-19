// 从 src/client/index.tsx 原样迁移的工作台座位层(签名、注释、逻辑逐字保持,仅加 export 并调整 import 来源)。
import type { Context as ClientContext } from "@deepseek-ai/cordis";
import type { ISessions } from "@deepseek-ai/dsh-api-session-controller/client";
import type { IConversation } from "@deepseek-ai/dsh-client-ui-conversation/client";
import type { PropsRenderSlots, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type { ToolCallViewProps } from "@deepseek-ai/dsh-client-ui-tool/client";
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { OH_STORY_PRODUCTION_TOOL_NAME } from "../production-intent.js";
import { createWorkbenchStore } from "./workbench-state.js";
import { CreativeSplitBridge } from "./workbench-bridge.js";
import { ComfyuiToolView, OH_STORY_COMFYUI_TOOL_NAME } from "./comfyui-toolview.js";
import { registerClientFeatures } from "./features/index.js";
import { registerSettingsFeature } from "./layout/layout-settings.js";
import styles from "./plugin.css?inline";

export const name = "oh-story";
export const inject = ["slots", "sessions", "conversation"];

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface SlotMap {
    "oh-story.workspace": { kind: "single"; scope: "session" };
  }
}

export type WorkbenchSeatProps = PropsRuntime<"shell.overlay"> & PropsRenderSlots<"oh-story.workspace">;

/** The session-scoped workbench cannot mount on a fresh DSH home page. */
function WorkbenchWelcome() {
  const marker = useRef<HTMLSpanElement>(null);
  const [target, setTarget] = useState<HTMLElement>();
  useLayoutEffect(() => {
    const document = marker.current?.ownerDocument;
    if (document === undefined) return;
    const locate = (): void => {
      const anchor = document.querySelector<HTMLElement>("[data-conversation-content]:not([data-sidebar-chat] *) > [data-conversation-scroll]");
      setTarget((current) => current === anchor ? current : anchor ?? undefined);
    };
    locate();
    const observer = new MutationObserver(locate);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => { observer.disconnect(); };
  }, []);
  return <>
    <style>{styles}</style>
    <span ref={marker} className="oh-story-bridge-marker" aria-hidden />
    {target === undefined ? null : createPortal(<section className="oh-story-welcome" aria-label="Oh Story 使用引导">
      <h2>Oh Story 已加载</h2>
      <p>直接在下方输入框说你想写什么，比如「写一篇 8000 字的重生复仇短篇」，或输入 <code>/story</code>、<code>/short-drama</code>、<code>/novel-to-game quick</code>、<code>/video-recap</code>。写出第一个创作文件后，小说、短剧、游戏、视频工作台会自动出现。</p>
      <ol>
        <li>不选文件夹也能开始：作品会写进 DSH 自动建立的「默认工作区 / Default workspace」。</li>
        <li>想放进自己的作品文件夹：点击左侧「工作区 / Workspaces」旁的「添加工作区 / Add workspace」，在系统弹出的文件夹窗口里选择，再在下方「选择工作区 / Choose workspace」中选中它。</li>
        <li>输入框右下角显示模型名就说明已配置好；没有模型时，在「设置 → 模型」填入 API Key。只查看已有作品无需 API Key。</li>
      </ol>
    </section>, target)}
  </>;
}

export function WorkbenchSeat({ SessionProvider, renderSlot }: WorkbenchSeatProps) {
  return <SessionProvider empty={() => <WorkbenchWelcome />}>{renderSlot("oh-story.workspace", {})}</SessionProvider>;
}

export function argsOf(block: ToolCallViewProps["block"]): Record<string, unknown> {
  // 0.2.0 types: Preparing carries no args, Started exposes argsRaw, a result keeps the call head.
  const raw = "argsRaw" in block ? block.argsRaw : "kind" in block ? block.call?.argsRaw : undefined;
  if (raw === undefined) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}

export function resultOf(block: ToolCallViewProps["block"]): string | undefined {
  if (!("kind" in block)) return undefined;
  return block.content.map((item) => item.type === "text" ? item.text : JSON.stringify(item, null, 2)).join("\n");
}

export function RoleToolView({ block, inspect }: ToolCallViewProps) {
  const args = argsOf(block);
  const role = typeof args.role === "string" ? args.role : "story-role";
  const output = resultOf(block);
  const state = !("kind" in block) ? "running" : block.isError ? "error" : "done";
  return <details className="oh-story-role" data-state={state}>
    <style>{styles}</style>
    <summary><span>✦ Role</span><strong>{role}</strong><em>{state === "running" ? "运行中" : state === "error" ? "失败" : "完成"}</em></summary>
    {output !== undefined && <pre>{output}</pre>}
    {inspect !== undefined && <button type="button" onClick={inspect}>在轨迹中检查</button>}
  </details>;
}

export function ProductionToolView({ block, inspect }: ToolCallViewProps) {
  const args = argsOf(block);
  const action = typeof args.action === "string" ? args.action : "production";
  const episode = typeof args.episode === "string" ? args.episode : "短剧";
  const state = !("kind" in block) ? "running" : block.isError ? "error" : "done";
  return <details className="oh-story-role" data-state={state}>
    <style>{styles}</style>
    <summary><span>▦ 生产</span><strong>{episode} · {action}</strong><em>{state === "running" ? "执行中" : state === "error" ? "失败" : "已应用"}</em></summary>
    {resultOf(block) !== undefined && <pre>{resultOf(block)}</pre>}
    {inspect !== undefined && <button type="button" onClick={inspect}>在轨迹中检查</button>}
  </details>;
}

/** Register only official DSH surfaces; the split bridge never replaces Chat. */
export function apply(context: ClientContext): void {
  registerClientFeatures();
  registerSettingsFeature();
  context.slots.inject("shell.overlay", () => {
    const disposeSeat = context.slots.register({
      name: "shell.overlay",
      id: "oh-story-workspace",
      order: -100,
      children: { "oh-story.workspace": { kind: "single", scope: "session" } }
    }, WorkbenchSeat);
    const disposeWorkbench = context.slots.register({
      name: "oh-story.workspace",
      store: createWorkbenchStore,
      inject: (sessionId) => {
        const binding = (context.sessions as unknown as ISessions).binding(sessionId);
        const conversation = binding?.ctx.get("conversation");
        if (binding === undefined || conversation === undefined) {
          return {
            sendProductionPrompt: () => Promise.reject(new Error("DSH 会话当前不可用。")),
            cancelProduction: () => Promise.reject(new Error("DSH 会话当前不可用。")),
            removeQueuedProduction: () => Promise.reject(new Error("DSH 会话当前不可用。"))
          };
        }
        return {
          sendProductionPrompt: (prompt: string) => conversation.send(prompt),
          cancelProduction: () => conversation.cancel(),
          removeQueuedProduction: (itemId: string) => conversation.updateQueue(itemId as Parameters<IConversation["updateQueue"]>[0], { kind: "remove" })
        };
      }
    }, CreativeSplitBridge);
    return [disposeSeat, disposeWorkbench];
  });
  context.slots.inject("tool.call.toolview", () => context.slots.register({
    name: "tool.call.toolview",
    key: "oh_story_role"
  }, RoleToolView));
  context.slots.inject("tool.call.toolview", () => context.slots.register({
    name: "tool.call.toolview",
    key: OH_STORY_PRODUCTION_TOOL_NAME
  }, ProductionToolView));
  context.slots.inject("tool.call.toolview", () => context.slots.register({
    name: "tool.call.toolview",
    key: OH_STORY_COMFYUI_TOOL_NAME,
    inject: (sessionId) => ({ sessionId })
  }, ComfyuiToolView));
}
