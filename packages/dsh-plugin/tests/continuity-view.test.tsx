import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ContinuityOverview } from "../src/services/continuity-contract.js";
import { ContinuityView } from "../src/client/features/continuity-feature.js";

const OVERVIEW: ContinuityOverview = {
  generatedAt: "2026-10-21T08:30:00.000Z",
  readOnly: true,
  project: {
    kind: "novel",
    title: "长夜行",
    root: "长夜行",
    tracking: { lastChapter: 12, stateRevision: 3, source: "tracking" },
  },
  today: {
    nextChapter: {
      ordinal: 13,
      latestPath: "长夜行/正文/第12章 雨夜.md",
      latestTitle: "第12章 雨夜",
    },
    dueForeshadows: [{
      id: "f1",
      title: "铜钥匙的来历",
      status: "planted",
      plannedPayoffChapter: "第13章",
      importance: 3,
    }],
    pausedRuns: [{
      id: "run-1",
      kind: "写章",
      status: "paused",
      updatedAt: Date.parse("2026-10-20T12:00:00.000Z"),
    }],
    proposedCandidates: 2,
    recentSaves: [{
      path: "长夜行/正文/第12章 雨夜.md",
      version: "v8",
      timestamp: Date.parse("2026-10-20T12:00:00.000Z"),
    }],
    lastBackupAt: Date.parse("2026-10-18T00:00:00.000Z"),
    backupAgeDays: 3,
  },
  stats: {
    chapters: 12,
    chapterBytes: 48_000,
    foreshadows: { planned: 1, planted: 2, resolved: 0, abandoned: 0 },
    runs: { active: 0, paused: 1, failed: 0, completed: 4 },
    candidates: { proposed: 2, confirmed: 0, applied: 3 },
    backups: 1,
    historyFiles: 4,
    auditEntries: 7,
    books: 1,
    anomalies: [],
  },
  risks: [{
    id: "foreshadow-due",
    level: "P1",
    title: "到期伏笔未回收",
    detail: "铜钥匙的来历计划在第13章回收。",
    paths: ["长夜行/正文/第12章 雨夜.md"],
    nextAction: "在第13章写回收场。",
  }],
};

const EMPTY_TODAY: ContinuityOverview["today"] = {
  nextChapter: { ordinal: 1, latestPath: null, latestTitle: null },
  dueForeshadows: [],
  pausedRuns: [],
  proposedCandidates: 0,
  recentSaves: [],
  lastBackupAt: null,
  backupAgeDays: null,
};

function render(overview: ContinuityOverview): string {
  return renderToStaticMarkup(<ContinuityView
    overview={overview}
    busy={false}
    onRefresh={() => undefined}
    onSnapshot={() => undefined}
    onHandoff={() => undefined}
    onVerifyHandoff={() => undefined}
  />);
}

describe("ContinuityView", () => {
  it("显示项目、P1 汇总、到期伏笔、风险与生成时间", () => {
    const html = render(OVERVIEW);
    expect(html).toContain("长夜行");
    expect(html).toContain("小说");
    expect(html).toContain("第 12 章");
    expect(html).toContain("P1 1");
    expect(html).toContain("铜钥匙的来历");
    expect(html).toContain("到期伏笔未回收");
    expect(html).toContain("下一步：");
    expect(html).toContain(OVERVIEW.generatedAt);
    expect(html).toContain("第 13 章");
    expect(html).toContain("创建快照");
    expect(html).toContain("复制交接清单");
    expect(html).toContain("校验交接清单");
  });

  it("列表为空时给出空状态且不报错", () => {
    const html = render({ ...OVERVIEW, today: EMPTY_TODAY, risks: [] });
    expect(html).toContain("今天没有到期伏笔。");
    expect(html).toContain("今天没有风险。");
    expect(html).toContain("还没有备份");
    expect(html).not.toContain("oh-diag-error");
    expect(html).not.toContain("undefined");
  });

  it("剪贴板不可用时显示可手动复制的交接清单", () => {
    const html = renderToStaticMarkup(<ContinuityView
      overview={OVERVIEW}
      busy={false}
      onRefresh={() => undefined}
      onSnapshot={() => undefined}
      onHandoff={() => undefined}
      onVerifyHandoff={() => undefined}
      handoffFallback={'{"schemaVersion":1}'}
    />);
    expect(html).toContain("可手动复制的交接清单");
    expect(html).toContain("schemaVersion");
  });
});
