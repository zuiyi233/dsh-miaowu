import { homedir } from "node:os";
import type { SupportBundle, SupportBundleInput } from "./diagnostics-contract.js";
import { redactDiagnosticsText } from "./diagnostics.js";

/**
 * 脱敏支持包。
 *
 * 支持包只含版本、状态盘点与诊断结论：没有任何文件内容、密钥字节、会话载荷
 * 或绝对路径。调用方已经拿到脱敏过的报告，这里仍对整棵结果再做一次前缀脱敏
 * （纵深防御）：工作区根与用户主目录都会替换为 `<workspace>` / `<home>`。
 */

export const SUPPORT_BUNDLE_LOG_NOTE = "DSH 未提供官方日志读取接口；本包只含诊断结果与状态盘点。";

/** 工作区结构清单上限：只列顶层名字，不展开内容。 */
const STRUCTURE_LIMIT = 100;

export interface SupportBundleRedaction {
  readonly workspaceRoot: string;
  readonly homeDir: string;
}

type Redactor = (text: string) => string;

function defaultRedaction(): SupportBundleRedaction {
  try {
    // 未传入工作区根时不替换空串规则；主目录仍在最后一道防线上。
    return { workspaceRoot: "", homeDir: homedir() };
  } catch {
    return { workspaceRoot: "", homeDir: "" };
  }
}

/** 深拷贝并逐字符串脱敏；非字符串叶子原样保留。 */
function redactDeep<T>(value: T, redact: Redactor): T {
  if (typeof value === "string") return redact(value) as unknown as T;
  if (Array.isArray(value)) {
    return (value as unknown[]).map((item) => redactDeep(item, redact)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = redactDeep(item, redact);
    }
    return output as unknown as T;
  }
  return value;
}

/**
 * 由诊断输入构建支持包。`redaction` 可选：路由传入本次采集的真实前缀，
 * 单独调用时至少脱敏用户主目录。
 */
export function buildSupportBundle(
  input: SupportBundleInput,
  redaction: SupportBundleRedaction = defaultRedaction()
): SupportBundle {
  const redact: Redactor = (text) => redactDiagnosticsText(text, redaction);
  const candidate = {
    schemaVersion: 1 as const,
    redacted: true as const,
    generatedAt: input.report.generatedAt,
    confirmedAt: input.confirmedAt,
    plugin: input.plugin,
    host: input.host,
    runtime: input.runtime,
    workspace: {
      structure: input.workspace.structure.slice(0, STRUCTURE_LIMIT),
      fileCount: input.workspace.fileCount,
      creativeProject: input.workspace.creativeProject,
    },
    config: input.config,
    diagnostics: input.report,
    inventory: input.inventory,
    logSummary: {
      // 宿主没有官方日志读取接口：这里永远是 available:false，只带固定说明。
      available: false,
      note: SUPPORT_BUNDLE_LOG_NOTE,
      errors: input.logSummary.errors,
    },
  };
  return redactDeep(candidate, redact);
}
