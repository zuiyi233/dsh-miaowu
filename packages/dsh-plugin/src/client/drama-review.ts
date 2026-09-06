/**
 * 短剧审查文档(`审查/<EP>-审查.md`)机器可读结论解析。
 * 同时兼容两种写法,不得因格式差异静默丢结论:
 * - DSH bridge 冻结格式(skill-provider.ts 注入):`## 审查结论` 段 +
 *   `- 结论：通过|有阻塞` + `- Blocker：BLOCK-<编号>（<涉及条目>）<描述>`。
 * - 上游 short-drama-review SKILL 模板:`- 结论：APPROVE|APPROVE_WITH_NOTES|REVISE|PROVISIONAL` +
 *   `## Blocker · REV-<编号> · <标题>`。
 * 纯函数:文本采集由调用方完成,这里不做任何 I/O、不做静默兜底——
 * 解析不出结论就如实返回 unknown,不伪造"通过"。
 */

export interface DramaReviewBlocker {
  /** BLOCK-001 / REV-001 等编号 ID(两种格式统一为 id)。 */
  readonly id: string;
  /** bridge 格式括号里的涉及条目(镜头/条目 ID);上游标题格式无此字段。 */
  readonly target?: string | undefined;
  /** bridge 格式的行内描述或上游标题行的标题文本。 */
  readonly title?: string | undefined;
}

export interface DramaReviewVerdict {
  readonly conclusion: "pass" | "blocked" | "unknown";
  readonly blockers: readonly DramaReviewBlocker[];
}

/** 结论词 → pass/blocked;APPROVE_WITH_NOTES 按上游定义"只有不阻断的改进"归 pass。 */
const PASS_CONCLUSIONS = new Set(["通过", "PASS", "APPROVE", "APPROVE_WITH_NOTES", "OK", "无阻塞"]);
const BLOCKED_CONCLUSIONS = new Set(["有阻塞", "阻塞", "REVISE", "BLOCKED", "FAIL", "需修订"]);

const CONCLUSION_LINE = /^[-*][\t ]*结论[\t ]*[：:][\t ]*(\S[^\n]*)$/u;
/** bridge 格式:`- Blocker：BLOCK-001（SHOT-EP001-004）夜戏光比冲突`。 */
const BLOCKER_LINE = /^[-*][\t ]*Blocker[\t ]*[：:][\t ]*((?:BLOCK|REV)-\d+)(?:[\t ]*[（(]([^）)]*)[）)])?[\t ]*(.*)$/iu;
/** 上游格式:`## Blocker · REV-001 · 画面文字未被镜头承载`。 */
const BLOCKER_HEADING = /^##[\t ]+Blocker[\t ]*·[\t ]*((?:BLOCK|REV)-\d+)(?:[\t ]*·[\t ]*(.+))?$/iu;

function normalizeConclusion(raw: string): DramaReviewVerdict["conclusion"] {
  const value = raw.trim().toUpperCase();
  if (PASS_CONCLUSIONS.has(value) || PASS_CONCLUSIONS.has(raw.trim())) return "pass";
  if (BLOCKED_CONCLUSIONS.has(value) || BLOCKED_CONCLUSIONS.has(raw.trim())) return "blocked";
  return "unknown";
}

export function parseDramaReviewDocument(text: string): DramaReviewVerdict {
  const blockers: DramaReviewBlocker[] = [];
  const seen = new Set<string>();
  let conclusion: DramaReviewVerdict["conclusion"] | undefined;
  for (const line of text.split(/\r?\n/u)) {
    const blockerMatch = BLOCKER_LINE.exec(line);
    if (blockerMatch !== null && blockerMatch[1] !== undefined) {
      const id = blockerMatch[1];
      const target = blockerMatch[2];
      const title = blockerMatch[3];
      const key = id.toUpperCase();
      if (!seen.has(key)) {
        seen.add(key);
        blockers.push({
          id: key,
          target: target?.trim() || undefined,
          title: title?.trim() || undefined
        });
      }
      continue;
    }
    const headingMatch = BLOCKER_HEADING.exec(line);
    if (headingMatch !== null && headingMatch[1] !== undefined) {
      const id = headingMatch[1];
      const title = headingMatch[2];
      const key = id.toUpperCase();
      if (!seen.has(key)) {
        seen.add(key);
        blockers.push({ id: key, target: undefined, title: title?.trim() || undefined });
      }
      continue;
    }
    const conclusionMatch = CONCLUSION_LINE.exec(line);
    if (conclusionMatch !== null && conclusionMatch[1] !== undefined && conclusion === undefined) {
      conclusion = normalizeConclusion(conclusionMatch[1]);
    }
  }
  // 无显式结论但列了 Blocker:有 Blocker 即有阻塞,这是显式证据不是推断。
  if (conclusion === undefined) {
    return { conclusion: blockers.length > 0 ? "blocked" : "unknown", blockers };
  }
  return { conclusion, blockers };
}
