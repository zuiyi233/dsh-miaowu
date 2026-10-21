import { WorkspaceHttpError } from "../workspace-route.js";
import type {
  AudiobookCastMember,
  AudiobookProject,
  AudiobookScript,
  AudiobookSegment,
} from "./audiobook-contract.js";

/**
 * 有声剧角色表：cast 是有声剧唯一的音色映射来源。
 *
 * N4-A 所有片段都用旁白音色；N4-B 起旁白只读旁白成员，对白按 `speakerId` 查
 * 角色。`unknown` 是解析器给未识别对白的保留值，不能作为真实角色 id；对白指向
 * 缺失成员（角色被删除或手工改坏）与 `unknown` 一样视为未指派，生成与导出都会
 * 被拦住，不做“回退旁白”的静默降级。
 */

export const UNKNOWN_SPEAKER_ID = "unknown";

const CAST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;

export interface ResolvedCast {
  readonly narrator: AudiobookCastMember;
  readonly members: ReadonlyMap<string, AudiobookCastMember>;
}

function invalidCast(message: string): WorkspaceHttpError {
  return new WorkspaceHttpError(422, message);
}

/** 项目保存/加载共用的 cast 语义校验：恰好一个旁白、id 唯一且可用作 URL 参数。 */
export function assertValidCast(cast: readonly AudiobookCastMember[]): void {
  if (cast.length === 0) throw invalidCast("有声剧项目至少需要一个旁白角色。");
  const narrators = cast.filter((member) => member.kind === "narrator");
  if (narrators.length !== 1) throw invalidCast("有声剧项目必须恰好有一个旁白角色。");
  const ids = new Set<string>();
  for (const member of cast) {
    if (!CAST_ID_PATTERN.test(member.id)) throw invalidCast(`角色 id 无效：${member.id}`);
    if (member.id === UNKNOWN_SPEAKER_ID) throw invalidCast(`角色 id 不能使用保留值 ${UNKNOWN_SPEAKER_ID}。`);
    if (ids.has(member.id)) throw invalidCast(`角色 id 重复：${member.id}`);
    ids.add(member.id);
    if (member.name.trim() === "") throw invalidCast("角色显示名不能为空。");
    if (member.voice.trim() === "") throw invalidCast(`角色「${member.name}」缺少音色。`);
  }
}

/** 解析 cast；项目文档已经校验过，这里仍对内存中的项目做一次防御。 */
export function resolveCast(project: AudiobookProject): ResolvedCast {
  assertValidCast(project.cast);
  const narrator = project.cast.find((member) => member.kind === "narrator");
  if (narrator === undefined) throw invalidCast("有声剧项目缺少旁白角色。");
  return { narrator, members: new Map(project.cast.map((member) => [member.id, member])) };
}

export function isSpeakerAssignable(cast: ResolvedCast, speakerId: string): boolean {
  return speakerId === UNKNOWN_SPEAKER_ID || cast.members.has(speakerId);
}

/** 旁白段固定用旁白音色；对白段查角色表，缺失成员返回 undefined（未指派）。 */
export function segmentVoice(cast: ResolvedCast, segment: AudiobookSegment): string | undefined {
  if (segment.kind === "narration") return cast.narrator.voice;
  return cast.members.get(segment.speakerId)?.voice;
}

export function unassignedSegmentsIn(cast: ResolvedCast, script: AudiobookScript): readonly AudiobookSegment[] {
  return script.segments.filter((segment) => segmentVoice(cast, segment) === undefined);
}

/** 生成、恢复与导出共用的门禁：未指派对白会拒绝整章，避免用错音色继续计费。 */
export function assertAssignable(cast: ResolvedCast, script: AudiobookScript): void {
  const unassigned = unassignedSegmentsIn(cast, script);
  if (unassigned.length > 0) {
    throw new WorkspaceHttpError(409, `有 ${String(unassigned.length)} 段对白尚未指派说话人，请先完成指派。`);
  }
}

/** 门禁通过后的必得音色；单独保留一个函数，避免调用点用非空断言。 */
export function requiredSegmentVoice(cast: ResolvedCast, segment: AudiobookSegment): string {
  const voice = segmentVoice(cast, segment);
  if (voice === undefined) {
    throw new WorkspaceHttpError(409, `片段 ${segment.id} 尚未指派说话人。`);
  }
  return voice;
}
