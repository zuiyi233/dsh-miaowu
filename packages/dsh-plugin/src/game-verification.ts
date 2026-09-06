export type GameVerificationBinding = "CURRENT" | "PINNED" | "STALE" | "UNBOUND";

export interface GameVerificationFreshness {
  readonly binding: Exclude<GameVerificationBinding, "PINNED">;
  readonly verifiedPreviewVersion?: string | undefined;
}

/**
 * 观察持久化条目:key 原样保留（含 sessionId 前缀，跨会话/跨项目不混淆），
 * updatedAt 是该观察最后一次写入内存的时刻（进程时钟，不参与 binding 判定）。
 */
export interface VerificationObservationRecord {
  readonly key: string;
  readonly verificationRevision: string | undefined;
  readonly previewVersion: string;
  readonly bound: boolean;
  readonly updatedAt: number;
}

interface Observation {
  readonly verificationRevision: string | undefined;
  readonly previewVersion: string;
  readonly bound: boolean;
  readonly updatedAt: number;
}

const OBSERVATION_STORE_VERSION = 1;
/** LRU 上限：内存与单文件写回共用同一口径。 */
const VERIFICATION_OBSERVATION_LIMIT = 500;

/** 运行时守卫：hydrate 直面 JSON.parse 产物，不能信任类型标注。 */
function isObservationRecord(value: unknown): value is VerificationObservationRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.key === "string" && record.key !== ""
    && (typeof record.verificationRevision === "string" || record.verificationRevision === undefined)
    && typeof record.previewVersion === "string" && record.previewVersion !== ""
    && typeof record.bound === "boolean"
    && typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt);
}

/**
 * 解析 `<project>/qa/.verification-observations.json`。JSON 损坏、envelope 版本
 * 不识别或条目形状不对统一返回 corrupt=true + 空条目，由调用方日志暴露后按空
 * 记录处理；text 为 undefined（文件不存在）是首次运行的正常态，不算损坏。
 */
export function parseVerificationObservationFile(
  text: string | undefined
): { readonly entries: readonly VerificationObservationRecord[]; readonly corrupt: boolean } {
  if (text === undefined || text.trim() === "") return { entries: [], corrupt: false };
  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; }
  catch { return { entries: [], corrupt: true }; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { entries: [], corrupt: true };
  const envelope = parsed as Record<string, unknown>;
  if (envelope.version !== OBSERVATION_STORE_VERSION || !Array.isArray(envelope.entries)) return { entries: [], corrupt: true };
  if (!envelope.entries.every((entry) => isObservationRecord(entry))) return { entries: [], corrupt: true };
  return { entries: envelope.entries, corrupt: false };
}

/** 序列化写回内容（末尾换行）。undefined revision 由 JSON 省略，回读时归一为 undefined。 */
export function serializeVerificationObservationFile(entries: readonly VerificationObservationRecord[]): string {
  return `${JSON.stringify({ version: OBSERVATION_STORE_VERSION, entries })}\n`;
}

/**
 * The upstream QA schema intentionally contains no build digest. Track what
 * this DSH process actually observes instead of pretending an imported PASS
 * belongs to the current build. A QA rewrite binds that run to the preview
 * visible at the same observation; later preview changes make it stale.
 */
export class WorkspaceVerificationTracker {
  readonly #observations = new Map<string, Observation>();

  observe(key: string, verificationRevision: string | undefined, previewVersion: string): GameVerificationFreshness {
    const previous = this.#observations.get(key);
    if (previous === undefined) {
      this.#remember(key, { verificationRevision, previewVersion, bound: false });
      return { binding: "UNBOUND" };
    }
    if (verificationRevision !== previous.verificationRevision) {
      const bound = verificationRevision !== undefined;
      this.#remember(key, { verificationRevision, previewVersion, bound });
      return bound ? { binding: "CURRENT", verifiedPreviewVersion: previewVersion } : { binding: "UNBOUND" };
    }
    if (!previous.bound) return { binding: "UNBOUND" };
    return previewVersion === previous.previewVersion
      ? { binding: "CURRENT", verifiedPreviewVersion: previous.previewVersion }
      : { binding: "STALE", verifiedPreviewVersion: previous.previewVersion };
  }

  /**
   * 灌入持久化历史观察，让 binding 连续性跨进程存活。只补内存中不存在的 key：
   * 内存观察在每次 observe 后即写回，至少与文件一样新，回灌旧值会让新鲜度倒退。
   * 非法条目跳过（不抛错），返回实际接受数，调用方可据此对 skipped 暴露日志。
   */
  hydrate(entries: readonly VerificationObservationRecord[]): number {
    let applied = 0;
    for (const entry of entries) {
      if (!isObservationRecord(entry) || this.#observations.has(entry.key)) continue;
      this.#remember(entry.key, {
        verificationRevision: entry.verificationRevision,
        previewVersion: entry.previewVersion,
        bound: entry.bound,
        updatedAt: entry.updatedAt
      });
      applied += 1;
    }
    return applied;
  }

  /** 导出当前全部观察（Map 插入序）；调用方按项目过滤后再持久化，不做伪造。 */
  snapshot(): VerificationObservationRecord[] {
    return [...this.#observations].map(([key, observation]) => ({
      key,
      verificationRevision: observation.verificationRevision,
      previewVersion: observation.previewVersion,
      bound: observation.bound,
      updatedAt: observation.updatedAt
    }));
  }

  #remember(key: string, observation: Omit<Observation, "updatedAt"> & { readonly updatedAt?: number }): void {
    this.#observations.set(key, { ...observation, updatedAt: observation.updatedAt ?? Date.now() });
    if (this.#observations.size <= VERIFICATION_OBSERVATION_LIMIT) return;
    const oldest = this.#observations.keys().next();
    if (!oldest.done) this.#observations.delete(oldest.value);
  }
}
