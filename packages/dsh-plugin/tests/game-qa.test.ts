import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { summarizeGameQa } from "../src/workspace-route.js";

/** 真实样例:knowledge novel-to-game 金瓶梅 verification.json(schema v3,六项全 PASS)。 */
function realSample(): unknown {
  const path = resolve(import.meta.dirname, "../../knowledge/novel-to-game/examples/jin-ping-mei/qa/verification.json");
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

describe("summarizeGameQa", () => {
  it("解析真实样例:verdict PASS、六项检查、证据指向 run 级 evidence", () => {
    const qa = summarizeGameQa(realSample(), "PINNED");
    expect(qa.present).toBe(true);
    expect(qa.verdict).toBe("PASS");
    expect(qa.binding).toBe("PINNED");
    expect(qa.checks).toHaveLength(6);
    expect(qa.checks?.map((check) => check.id)).toEqual(["launch", "render", "input", "coreLoop", "outcome", "restart"]);
    for (const check of qa.checks ?? []) {
      expect(check.status).toBe("PASS");
      // checks 本身只是状态字符串,逐项证据统一指向 completeRun.evidence,不伪造。
      expect(check.evidence).toContain("qa/evidence/run.json");
    }
  });

  it("宽容缺失:字段缺失不报错,present=false", () => {
    expect(summarizeGameQa(undefined)).toEqual({ present: false });
    expect(summarizeGameQa(null)).toEqual({ present: false });
    expect(summarizeGameQa("not-json")).toEqual({ present: false });
    expect(summarizeGameQa([])).toEqual({ present: false });
    expect(summarizeGameQa({})).toEqual({ present: false });
    expect(summarizeGameQa({ status: "UNKNOWN", checks: {} })).toEqual({ present: false });
    // 有 verdict 但缺 checks:六项记为 NOT_RUN,仍 present。
    const partial = summarizeGameQa({ status: "FAIL" });
    expect(partial.present).toBe(true);
    expect(partial.verdict).toBe("FAIL");
    expect(partial.checks).toHaveLength(6);
    expect(partial.checks?.every((check) => check.status === "NOT_RUN")).toBe(true);
  });

  it("缺 evidence 路径时证据文本显式说明,不伪造", () => {
    const qa = summarizeGameQa({ status: "PASS", checks: { launch: "PASS" } });
    expect(qa.present).toBe(true);
    expect(qa.checks?.[0]?.evidence).toContain("未记录 evidence 路径");
    expect(qa.checks?.[1]?.status).toBe("NOT_RUN");
  });

  it("透传新鲜度 binding,不伪造", () => {
    expect(summarizeGameQa({ status: "PASS" }, "STALE").binding).toBe("STALE");
    expect(summarizeGameQa({ status: "PASS" }).binding).toBeUndefined();
    expect(summarizeGameQa(undefined, "CURRENT")).toEqual({ present: false });
  });
});
