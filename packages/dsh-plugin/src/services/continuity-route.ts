import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import {
  jsonBody,
  send,
  workspaceRealm,
  WorkspaceHttpError,
  type WorkspaceRouteOptions,
} from "../workspace-route.js";
import { onWorkspaceBeforeWrite, registerWorkspaceExtension } from "./registry.js";
import { CONTINUITY_ROUTES } from "./continuity-contract.js";
import {
  buildContinuityHandoff,
  buildContinuityOverview,
  createContinuitySnapshot,
  snapshotBeforeHighRiskWrite,
  verifyContinuityHandoff,
} from "./continuity.js";

/**
 * 连续性驾驶舱的宿主路由。
 *
 * 概览与交接清单只读工作区；快照会写 `.oh-story/backup/`，必须显式确认。
 * 除快照外不写任何文件，也不触碰 DSH 会话与宿主状态。
 */

const BODY_LIMIT = 64 * 1024;

/** 供宿主路由扩展缝调用；命中返回 true，其余交回 `workspace-route.ts`。 */
export async function handleContinuityRequest(
  context: Context,
  request: IncomingMessage,
  response: ServerResponse,
  options: WorkspaceRouteOptions
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  try {
    if (url.pathname === CONTINUITY_ROUTES.overview && request.method === "GET") {
      const realm = await workspaceRealm(context, url);
      send(response, 200, await buildContinuityOverview(realm));
      return true;
    }
    if (url.pathname === CONTINUITY_ROUTES.handoff && request.method === "GET") {
      const realm = await workspaceRealm(context, url);
      send(response, 200, await buildContinuityHandoff(realm, options.maxBytes));
      return true;
    }
    if (url.pathname === CONTINUITY_ROUTES.handoffVerify && request.method === "POST") {
      // 校验只读工作区；清单本身可能有数千文件，不能套用快照的 64 KB 小体限。
      const body = await jsonBody(request, options.maxBytes);
      const realm = await workspaceRealm(context, url);
      send(response, 200, await verifyContinuityHandoff(realm, body.manifest, options.maxBytes));
      return true;
    }
    if (url.pathname === CONTINUITY_ROUTES.snapshot && request.method === "POST") {
      const body = await jsonBody(request, BODY_LIMIT);
      if (body.confirm !== true) {
        throw new WorkspaceHttpError(400, "创建快照会写入 .oh-story/backup/，需要显式确认（confirm: true）。");
      }
      const realm = await workspaceRealm(context, url);
      send(response, 200, await createContinuitySnapshot(realm, options.maxBytes));
      return true;
    }
    return false;
  } catch (error) {
    if (error instanceof WorkspaceHttpError) {
      send(response, error.status, { error: error.message });
      return true;
    }
    context.logger("oh-story").error("continuity route failed", error);
    send(response, 500, { error: "连续性驾驶舱读取失败。" });
    return true;
  }
}

registerWorkspaceExtension({ name: "continuity", handle: handleContinuityRequest });

let preWriteGuard: (() => void) | undefined;

/** 由插件入口在拿到 editorMaxBytes 后调用；重复调用复用同一个监听。 */
export function registerContinuityPreWriteGuard(maxBytes: number): () => void {
  if (preWriteGuard === undefined) {
    const dispose = onWorkspaceBeforeWrite(async (event) => {
      await snapshotBeforeHighRiskWrite(event.realm, maxBytes);
    });
    preWriteGuard = () => {
      dispose();
      preWriteGuard = undefined;
    };
  }
  return preWriteGuard;
}

export function registerContinuityExtension(): void {
  // 扩展在模块顶层注册，保留具名导出供测试与入口显式引用。
}
