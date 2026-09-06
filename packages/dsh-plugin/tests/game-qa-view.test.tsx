import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GameQa } from "../src/client/game-qa.js";

const PASS_QA = {
  present: true as const,
  verdict: "PASS",
  binding: "PINNED" as const,
  checks: [
    { id: "launch" as const, status: "PASS" as const, evidence: "启动通过（见运行证据 qa/evidence/run.json）" },
    { id: "render" as const, status: "PASS" as const, evidence: "渲染通过（见运行证据 qa/evidence/run.json）" },
    { id: "input" as const, status: "PASS" as const, evidence: "输入通过（见运行证据 qa/evidence/run.json）" },
    { id: "coreLoop" as const, status: "PASS" as const, evidence: "核心循环通过（见运行证据 qa/evidence/run.json）" },
    { id: "outcome" as const, status: "FAIL" as const, evidence: "设计结果未通过（见运行证据 qa/evidence/run.json）" },
    { id: "restart" as const, status: "NOT_RUN" as const, evidence: "重开尚未验证" }
  ]
};

describe("GameQa", () => {
  it("渲染 verdict 徽标与六项检查列表", () => {
    const html = renderToStaticMarkup(<GameQa qa={PASS_QA} projectTitle="演示" />);
    expect(html).toContain("通过");
    expect(html).toContain("内置示例");
    for (const label of ["启动", "渲染", "输入", "核心循环", "设计结果", "重开"]) {
      expect(html).toContain(label);
    }
    // 状态图标:通过 ✓、未通过 ✕、未验证 ○。
    expect(html).toContain("✓");
    expect(html).toContain("✕");
    expect(html).toContain("○");
  });

  it("qa.present=false 时显示空态与管线指引", () => {
    const html = renderToStaticMarkup(<GameQa qa={{ present: false }} projectTitle="演示" />);
    expect(html).toContain("尚无 QA 报告");
    expect(html).toContain("game-qa");
    expect(html).toContain("qa/verification.json");
  });

  it("FAIL verdict 显示未通过徽标", () => {
    const html = renderToStaticMarkup(<GameQa qa={{ ...PASS_QA, verdict: "FAIL" }} projectTitle="演示" />);
    expect(html).toContain("未通过");
  });
});
