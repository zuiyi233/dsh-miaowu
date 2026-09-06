import { useState } from "react";
import type { GameVerificationBinding } from "../game-verification.js";

export type GameQaCheckId = "launch" | "render" | "input" | "coreLoop" | "outcome" | "restart";

export interface GameQaCheckSummary {
  readonly id: GameQaCheckId;
  readonly status: "NOT_RUN" | "FAIL" | "PASS";
  readonly evidence: string;
}

export interface GameQaSummary {
  readonly present: boolean;
  readonly verdict?: string | undefined;
  readonly binding?: GameVerificationBinding | undefined;
  readonly checks?: readonly GameQaCheckSummary[] | undefined;
}

const CHECK_LABELS: Readonly<Record<GameQaCheckSummary["id"], string>> = {
  launch: "启动",
  render: "渲染",
  input: "输入",
  coreLoop: "核心循环",
  outcome: "设计结果",
  restart: "重开"
};

const CHECK_DESCRIPTIONS: Readonly<Record<GameQaCheckSummary["id"], string>> = {
  launch: "候选在实际运行环境启动，无阻断错误。",
  render: "画面非空且会随时间或操作变化。",
  input: "真实输入引起可观察状态变化。",
  coreLoop: "核心循环完整执行。",
  outcome: "至少一个设计结果可达。",
  restart: "重开回到定义初态。"
};

function verdictBadge(qa: GameQaSummary): { readonly text: string; readonly state: string } {
  if (!qa.present) return { text: "未验证", state: "none" };
  if (qa.verdict === "PASS") return { text: "通过", state: "pass" };
  if (qa.verdict === "FAIL") return { text: "未通过", state: "fail" };
  return { text: "部分", state: "partial" };
}

function bindingLabel(binding: GameQaSummary["binding"]): string | undefined {
  if (binding === "CURRENT") return "与当前构建一致";
  if (binding === "STALE") return "构建已更新，QA 待重跑";
  if (binding === "PINNED") return "内置示例（随包锁定）";
  if (binding === "UNBOUND") return "未绑定到当前构建";
  return undefined;
}

/** GameStudio「质检」tab:把 qa/verification.json 六项最小 QA 与运行证据摆到创作者面前。 */
export function GameQa({ qa, projectTitle }: {
  readonly qa: GameQaSummary;
  readonly projectTitle: string;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  if (!qa.present || qa.checks === undefined) return <div className="oh-game-design-empty">
    <span aria-hidden>◍</span>
    <strong>尚无 QA 报告</strong>
    <p>运行 novel-to-game 管线的 game-qa 阶段生成 <code>qa/verification.json</code> 后会出现在这里。</p>
  </div>;
  const badge = verdictBadge(qa);
  const binding = bindingLabel(qa.binding);
  const toggle = (id: string): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  return <div className="oh-story-game-qa" aria-label={`《${projectTitle}》质检报告`}>
    <div className="oh-story-game-qa-header">
      <span className="oh-story-game-qa-verdict" data-state={badge.state}>{badge.text}</span>
      {binding !== undefined && <span className="oh-story-game-qa-binding" data-state={qa.binding}>{binding}</span>}
    </div>
    <ol className="oh-story-game-qa-checks">
      {qa.checks.map((check) => {
        const open = expanded.has(check.id);
        const statusIcon = check.status === "PASS" ? "✓" : check.status === "FAIL" ? "✕" : "○";
        return <li key={check.id} className="oh-story-game-qa-check" data-status={check.status}>
          <button
            type="button"
            className="oh-story-game-qa-check-toggle"
            aria-expanded={open}
            onClick={() => { toggle(check.id); }}
          >
            <span className="oh-story-game-qa-check-icon" aria-hidden>{statusIcon}</span>
            <span className="oh-story-game-qa-check-name">{CHECK_LABELS[check.id]}</span>
            <span className="oh-story-game-qa-check-status">{check.status === "PASS" ? "通过" : check.status === "FAIL" ? "未通过" : "未验证"}</span>
          </button>
          {open && <div className="oh-story-game-qa-evidence">
            <p>{CHECK_DESCRIPTIONS[check.id]}</p>
            <p className="oh-story-game-qa-evidence-text">{check.evidence}</p>
          </div>}
        </li>;
      })}
    </ol>
  </div>;
}
