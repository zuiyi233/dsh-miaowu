import type { Context } from "@deepseek-ai/cordis";
import { hostVersionSatisfies } from "./diagnostics.js";
import { readHostFacts, readPluginFacts } from "./plugin-facts.js";

/**
 * 启动预检：只读插件/宿主清单与环境变量，不碰工作区与会话。
 *
 * 预检只发告警，绝不阻断插件加载，也不静默改变任何能力：
 * 版本不匹配会以“不会静默降级”的明确告警出现，详细处理步骤留在自诊断面板。
 */

const MINIMUM_NODE_MAJOR = 24;

function nodeMajor(version: string): number | null {
  const match = /^v?(\d+)(?:\.|$)/u.exec(version.trim());
  const text = match?.[1];
  if (text === undefined) return null;
  const major = Number(text);
  return Number.isSafeInteger(major) ? major : null;
}

export function runStartupPrecheck(context: Context): void {
  try {
    const plugin = readPluginFacts();
    const host = readHostFacts(context);
    const logger = context.logger("oh-story");
    const range = plugin.supportedRange.trim();

    if (host.version === null) {
      logger.warn(
        `未能确定 DSH 宿主版本（来源：${host.versionSource}）；插件 ${plugin.version} 照常加载，自诊断面板仍可用，可在其中查看宿主与集成状态。`
      );
    } else if (range === "") {
      logger.warn(
        `没有从插件清单读到宿主支持范围（engines.dsh），宿主版本 ${host.version} 的兼容性未做预检；自诊断面板仍可查看详情。`
      );
    } else if (!hostVersionSatisfies(host.version, range)) {
      logger.warn(
        `DSH 宿主版本 ${host.version} 不在插件声明范围 ${range} 内；插件不会静默降级，与宿主不匹配的能力会以失败形式报告。请打开「自诊断」面板查看处理步骤。`
      );
    }

    const major = nodeMajor(process.versions.node);
    if (major !== null && major < MINIMUM_NODE_MAJOR) {
      logger.warn(
        `当前 Node.js ${process.versions.node} 低于插件要求的 ${String(MINIMUM_NODE_MAJOR)}.x；插件会继续加载，但依赖新运行时 API 的功能会明确失败，而不是静默降级。`
      );
    }
  } catch (error) {
    try {
      context.logger("oh-story").warn("启动预检失败，插件继续加载。", error);
    } catch {
      // 预检绝不能阻断插件加载，连告警失败也只能吞掉。
    }
  }
}
