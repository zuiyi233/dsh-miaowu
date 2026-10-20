import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@deepseek-ai/cordis";
import type { DiagnosticsHostFacts } from "./diagnostics-contract.js";

/**
 * 诊断用的插件/宿主事实。
 *
 * 只读 `package.json` 与环境变量，绝不猜测版本：读不到就报 `unknown` / `null`，
 * 让诊断引擎把“未知”作为独立状态呈现，而不是伪造一个通过或失败。
 * 构建布局不固定（src / lib / 单文件 bundle），因此按候选相对路径依次尝试，
 * 只有 `name` 匹配本插件的清单才会被接受。
 */

const PACKAGE_NAME = "@dsh-miaowu/dsh";
const PLUGIN_MANIFEST_CANDIDATES = ["../../package.json", "../package.json", "./package.json"] as const;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const HOST_VERSION_ENV = "DSH_CLIENT_VERSION";

/** 本构建期望的领域贡献下限；与打包内容一起评审，不从磁盘推断。 */
export const EXPECTED_SKILL_MINIMUM = 41;
export const EXPECTED_TOOL_NAMES = [
  "oh_story_role",
  "oh_story_production",
  "oh_story_task",
  "oh_story_comfyui",
  "oh_story_bundled_reference",
] as const;
export const EXPECTED_ROLE_COUNT = 7;

export interface PluginFacts {
  readonly name: string;
  readonly version: string;
  readonly supportedRange: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validVersion(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return VERSION_PATTERN.test(trimmed) ? trimmed : undefined;
}

/** 读一个 JSON 对象；任何读取/解析错误都返回 undefined，不抛错。 */
function readJsonObject(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function unknownFacts(): PluginFacts {
  return { name: PACKAGE_NAME, version: "unknown", supportedRange: "" };
}

/** 读本插件清单；候选布局都不命中时返回 `unknown`，绝不编造版本。 */
export function readPluginFacts(): PluginFacts {
  for (const candidate of PLUGIN_MANIFEST_CANDIDATES) {
    let path: string;
    try {
      path = fileURLToPath(new URL(candidate, import.meta.url));
    } catch {
      continue;
    }
    const manifest = readJsonObject(path);
    if (manifest === undefined || manifest.name !== PACKAGE_NAME) continue;
    const engines = isRecord(manifest.engines) ? manifest.engines : undefined;
    return {
      name: PACKAGE_NAME,
      version: validVersion(manifest.version) ?? "unknown",
      supportedRange: engines !== undefined && typeof engines.dsh === "string" ? engines.dsh.trim() : "",
    };
  }
  return unknownFacts();
}

interface ProfileFactShape {
  readonly profileContext?: {
    readonly installAnchor?: unknown;
  };
}

function installAnchor(context: Context): string | undefined {
  const profile = (context as unknown as ProfileFactShape).profileContext;
  const anchor = profile?.installAnchor;
  return typeof anchor === "string" && anchor.trim() !== "" ? anchor.trim() : undefined;
}

/** `installAnchor` 通常指向宿主 package.json；若给的是目录则补上文件名。 */
function manifestPathOf(anchor: string): string {
  try {
    return statSync(anchor).isDirectory() ? join(anchor, "package.json") : anchor;
  } catch {
    return anchor;
  }
}

/**
 * 读宿主版本：profile 的 installAnchor → `DSH_CLIENT_VERSION` → 不可用。
 * `supportedRange` 由调用方用插件清单的 engines.dsh 填充，这里只报空串。
 */
export function readHostFacts(context: Context): DiagnosticsHostFacts {
  try {
    const anchor = installAnchor(context);
    if (anchor !== undefined) {
      const manifest = readJsonObject(manifestPathOf(anchor));
      const version = manifest === undefined ? undefined : validVersion(manifest.version);
      if (version !== undefined) {
        return { version, versionSource: "installAnchor", supportedRange: "" };
      }
    }
    const fromEnv = validVersion(process.env[HOST_VERSION_ENV]);
    if (fromEnv !== undefined) {
      return { version: fromEnv, versionSource: "env", supportedRange: "" };
    }
    return { version: null, versionSource: "unavailable", supportedRange: "" };
  } catch {
    return { version: null, versionSource: "unavailable", supportedRange: "" };
  }
}
