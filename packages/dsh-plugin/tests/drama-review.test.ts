import { describe, expect, it } from "vitest";
import { parseDramaReviewDocument } from "../src/client/drama-review.js";

describe("parseDramaReviewDocument", () => {
  it("解析 DSH bridge 冻结格式(## 审查结论 + 结论/Blocker 行)", () => {
    const text = `# EP001 审查

## 审查结论
- 结论：有阻塞
- Blocker：BLOCK-001（SHOT-EP001-004）夜戏光比与视觉设定冲突，需补拍参考
- Blocker：BLOCK-002（VISUAL-HERO）定妆图分辨率不足
`;
    const verdict = parseDramaReviewDocument(text);
    expect(verdict.conclusion).toBe("blocked");
    expect(verdict.blockers).toEqual([
      { id: "BLOCK-001", target: "SHOT-EP001-004", title: "夜戏光比与视觉设定冲突，需补拍参考" },
      { id: "BLOCK-002", target: "VISUAL-HERO", title: "定妆图分辨率不足" }
    ]);
  });

  it("解析上游 SKILL 模板格式(结论：REVISE + ## Blocker · REV-xxx · 标题)", () => {
    const text = `# 审查

- 结论：REVISE

## Blocker · REV-001 · 画面文字未被镜头承载
正文略。
`;
    const verdict = parseDramaReviewDocument(text);
    expect(verdict.conclusion).toBe("blocked");
    expect(verdict.blockers).toEqual([{ id: "REV-001", target: undefined, title: "画面文字未被镜头承载" }]);
  });

  it("上游 pass 族(APPROVE/APPROVE_WITH_NOTES)与中文「通过」都归 pass", () => {
    for (const line of ["- 结论：APPROVE", "- 结论：APPROVE_WITH_NOTES", "- 结论：通过"]) {
      expect(parseDramaReviewDocument(`${line}\n`).conclusion).toBe("pass");
    }
  });

  it("有 Blocker 但无结论行 → blocked(显式证据,不猜测);全空 → unknown", () => {
    expect(parseDramaReviewDocument("- Blocker：BLOCK-001（SHOT-EP001-002）问题\n").conclusion).toBe("blocked");
    expect(parseDramaReviewDocument("# 只有一级标题\n正文\n")).toEqual({ conclusion: "unknown", blockers: [] });
  });

  it("PROVISIONAL(关键输入不足)归 unknown,不伪造结论;重复 Blocker 去重", () => {
    const verdict = parseDramaReviewDocument("- 结论：PROVISIONAL\n- Blocker：BLOCK-001（A）x\n- Blocker：BLOCK-001（A）x\n");
    expect(verdict.conclusion).toBe("unknown");
    expect(verdict.blockers).toHaveLength(1);
  });
});
