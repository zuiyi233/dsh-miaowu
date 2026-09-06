import { describe, expect, it } from "vitest";
import {
  parseVerificationObservationFile,
  serializeVerificationObservationFile,
  WorkspaceVerificationTracker,
  type VerificationObservationRecord
} from "../src/game-verification.js";

describe("workspace game QA freshness", () => {
  it("does not pretend an imported QA record is bound to the current preview", () => {
    const tracker = new WorkspaceVerificationTracker();
    expect(tracker.observe("session:game", "qa-v1", "build-v1")).toEqual({ binding: "UNBOUND" });
    expect(tracker.observe("session:game", "qa-v1", "build-v2")).toEqual({ binding: "UNBOUND" });
  });

  it("binds a QA rewrite and marks later preview changes stale", () => {
    const tracker = new WorkspaceVerificationTracker();
    expect(tracker.observe("session:game", undefined, "build-v1")).toEqual({ binding: "UNBOUND" });
    expect(tracker.observe("session:game", "qa-v1", "build-v1")).toEqual({
      binding: "CURRENT",
      verifiedPreviewVersion: "build-v1"
    });
    expect(tracker.observe("session:game", "qa-v1", "build-v2")).toEqual({
      binding: "STALE",
      verifiedPreviewVersion: "build-v1"
    });
    expect(tracker.observe("session:game", "qa-v2", "build-v2")).toEqual({
      binding: "CURRENT",
      verifiedPreviewVersion: "build-v2"
    });
  });
});

describe("verification observation persistence", () => {
  const record = (overrides: Partial<VerificationObservationRecord>): VerificationObservationRecord => ({
    key: "session:game",
    verificationRevision: "qa-v1",
    previewVersion: "build-v1",
    bound: true,
    updatedAt: 1_000,
    ...overrides
  });

  it("hydrate restores continuity so a rebuilt process still sees STALE", () => {
    const tracker = new WorkspaceVerificationTracker();
    tracker.hydrate([record({})]);
    expect(tracker.observe("session:game", "qa-v1", "build-v2")).toEqual({
      binding: "STALE",
      verifiedPreviewVersion: "build-v1"
    });
    // 内存已有的 key 不回灌:内存观察至少与文件一样新,回灌旧值会让新鲜度倒退。
    // (若 hydrate 覆盖了内存条目,previous 变为 bound 的旧记录,同参 observe 会错误地返回 CURRENT。)
    const fresher = new WorkspaceVerificationTracker();
    fresher.observe("session:game", "qa-v2", "build-v9");
    expect(fresher.hydrate([record({ verificationRevision: "qa-v1", previewVersion: "build-v1" })])).toBe(0);
    expect(fresher.observe("session:game", "qa-v2", "build-v9")).toEqual({ binding: "UNBOUND" });
  });

  it("snapshot exports what observe remembers, undefined revision included", () => {
    const tracker = new WorkspaceVerificationTracker();
    tracker.observe("session:a\0game-adaptations/x", "qa-v1", "build-v1");
    tracker.observe("session:b\0game-adaptations/y", undefined, "build-v1");
    const entries = tracker.snapshot();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ key: "session:a\0game-adaptations/x", verificationRevision: "qa-v1", bound: false });
    expect(entries[1]?.verificationRevision).toBeUndefined();
    expect(typeof entries[0]?.updatedAt).toBe("number");
  });

  it("round-trips through serialize/parse and rejects corrupt payloads", () => {
    const entries = [record({ verificationRevision: undefined })];
    const parsed = parseVerificationObservationFile(serializeVerificationObservationFile(entries));
    expect(parsed.corrupt).toBe(false);
    expect(parsed.entries[0]?.key).toBe("session:game");
    expect(parsed.entries[0]?.verificationRevision).toBeUndefined();
    for (const bad of [undefined, "", "not json", "[]", JSON.stringify({ entries: [] }), JSON.stringify({ version: 99, entries: [] }), JSON.stringify({ version: 1, entries: [{ key: "" }] })]) {
      const result = parseVerificationObservationFile(bad);
      if (bad === undefined || bad === "") expect(result).toEqual({ entries: [], corrupt: false });
      else expect(result.corrupt).toBe(true);
    }
  });
});
