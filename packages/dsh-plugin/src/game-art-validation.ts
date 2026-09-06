/**
 * 游戏 ART-* 三方校验器：对齐短剧 VISUAL-* 稳定 ID 诊断思路，把
 * design/ART_DIRECTION.md 登记、art/ 素材落盘、build/app 接入三个事实源交叉比对，
 * 让"美术已上屏"可机证（契约见 docs/game-art-pipeline.md）。
 * 纯函数：所有文件列举与内容采集由 workspace-route 完成，这里不做任何 I/O、
 * 不做静默兜底——缺登记文本（undefined）与空 art/ 的组合视为"项目未走美术流"。
 */

export type GameArtDiagnosticCode =
  | "registered_missing_asset"
  | "asset_unregistered"
  | "asset_not_used_in_build"
  | "build_reference_unregistered";

export interface GameArtDiagnostic {
  readonly level: "error" | "warning";
  readonly code: GameArtDiagnosticCode;
  readonly message: string;
}

export interface GameArtValidationInput {
  /** design/ART_DIRECTION.md 的文本；undefined = 文件不存在。 */
  readonly artDirectionText: string | undefined;
  /** art/ 下文件的项目内相对路径（如 art/ART-TITLE-01.png）。 */
  readonly artFiles: readonly string[];
  /** build/app/ 下文件的项目内相对路径。 */
  readonly buildAppFiles: readonly string[];
  /** build/app 下可读文本文件（js/html/css/json）内容，供扫 ART- 引用。 */
  readonly buildAppSources?: readonly { readonly path: string; readonly content: string }[];
}

/** ART-* 稳定 ID 形状（docs/game-art-pipeline.md 契约：ID 一旦分配不再修改）。 */
const ART_ID_PATTERN = /^ART-[A-Z0-9-]+$/u;
/** 登记行：`- ID：ART-*` / `- ID: ART-*`（全半角冒号、-/* 项目符号皆收）。 */
const REGISTERED_ID_LINE = /^[\t ]*[-*][\t ]+ID[\t ]*[：:][\t ]*(ART-[A-Z0-9-]+)/u;
/** build/app 文本中的引用：ART- 前必须不是字母数字，避免 startART-FOO 这类误报。 */
const ART_REFERENCE_PATTERN = /(?<![A-Za-z0-9])ART-[A-Z0-9-]+/gu;
/** art/ 下"ART-* 命名"判定：首段 ID 前缀允许生成器追加 _00001_ 等后缀。 */
const ART_FILE_NAME_PATTERN = /^ART-[A-Z0-9_-]+/u;

function parseRegisteredArtIds(text: string | undefined): readonly string[] {
  if (text === undefined) return [];
  const ids: string[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const id = REGISTERED_ID_LINE.exec(line)?.[1];
    if (id !== undefined && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function baseName(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? path : path.slice(index + 1);
}

function collectReferencedArtIds(text: string): readonly string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(ART_REFERENCE_PATTERN)) {
    // 引用常带引号/换行等尾巴，剥掉尾部连字符后再按 ID 形状复核（"ART--" 剥成 "ART" 会被拒）。
    const stripped = match[0].replace(/-+$/u, "");
    if (ART_ID_PATTERN.test(stripped)) ids.add(stripped);
  }
  return [...ids];
}

export function validateGameArtInventory(input: GameArtValidationInput): readonly GameArtDiagnostic[] {
  // 项目未走美术流（无登记文件且 art/ 空）：整体不产诊断，避免零接入项目误报。
  if (input.artDirectionText === undefined && input.artFiles.length === 0) return [];
  const registeredIds = parseRegisteredArtIds(input.artDirectionText);
  const artBasenames = input.artFiles.map(baseName);
  const diagnostics: GameArtDiagnostic[] = [];

  // 登记 → art/：文件名以 ID 开头即视为对应素材（生成器会追加 _00001_ 等后缀）。
  for (const id of registeredIds) {
    if (!artBasenames.some((name) => name.startsWith(id))) {
      diagnostics.push({
        level: "error",
        code: "registered_missing_asset",
        message: `ART 登记缺素材：${id} 已登记到 ART_DIRECTION.md，但 art/ 下没有以 ${id} 开头的文件。`
      });
    }
  }

  // art/ → 登记：只盯 ART-* 命名文件，不带前缀的普通文件（草稿、参考图）忽略不报。
  for (const path of input.artFiles) {
    const name = baseName(path);
    if (!ART_FILE_NAME_PATTERN.test(name)) continue;
    if (!registeredIds.some((id) => name.startsWith(id))) {
      diagnostics.push({
        level: "warning",
        code: "asset_unregistered",
        message: `素材未登记：${path} 以 ART- 命名，但 ART_DIRECTION.md 没有对应 ID 登记。`
      });
    }
  }

  // 接入判定：build/app 文本引用该 ID，或 build/app 内有以该 ID 命名的文件（复制接入）。
  const usedInBuild = (id: string): boolean =>
    input.buildAppFiles.some((path) => baseName(path).startsWith(id))
    || (input.buildAppSources ?? []).some((source) => source.content.includes(id));

  for (const id of registeredIds) {
    if (!usedInBuild(id)) {
      diagnostics.push({
        level: "warning",
        code: "asset_not_used_in_build",
        message: `美术未接入：${id} 已登记且素材在 art/，但 build/app 内没有发现任何引用（代码文本或同名文件）。`
      });
    }
  }

  // build/app → 登记：引用了未登记 ID 说明 ID 契约被绕过，两处必须一致。
  const buildText = (input.buildAppSources ?? []).map((source) => source.content).join("\n");
  for (const id of collectReferencedArtIds(buildText)) {
    if (!registeredIds.includes(id)) {
      diagnostics.push({
        level: "error",
        code: "build_reference_unregistered",
        message: `构建引用未登记：${id} 在 build/app 中被引用，但 ART_DIRECTION.md 没有该 ID 登记。`
      });
    }
  }

  return diagnostics;
}
