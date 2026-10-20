import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DiagnosticsReport } from "../src/services/diagnostics-contract.js";
import { DiagnosticsView } from "../src/client/features/diagnostics-feature.js";

const REPORT: DiagnosticsReport = {
  generatedAt: "2026-10-20T10:00:00.000Z",
  pluginVersion: "0.1.18",
  hostVersion: "0.2.1-rc.2",
  readOnly: true,
  checks: [
    {
      id: "host.compatibility",
      group: "host",
      title: "宿主版本兼容性",
      status: "fail",
      severity: "P0",
      summary: "宿主版本 0.1.0 不在插件声明范围内。",
      guidance: ["安装受支持的宿主版本。"],
      evidence: { hostVersion: "0.1.0", satisfied: false },
    },
    {
      id: "runtime.node",
      group: "runtime",
      title: "Node.js 版本",
      status: "pass",
      severity: null,
      summary: "Node.js 24.5.0 满足主版本 ≥ 24。",
      guidance: [],
      evidence: { major: 24, minimumMajor: 24 },
    },
    {
      id: "workspace.creative-project",
      group: "workspace",
      title: "创作项目",
      status: "warn",
      severity: "P2",
      summary: "工作区 demo 中还没有创作项目。",
      guidance: ["在对话里创建创作目录。"],
      evidence: { rootLabel: "demo", creativeProject: false },
    },
    {
      id: "data.search-index",
      group: "data",
      title: "全文检索索引",
      status: "warn",
      severity: "P2",
      summary: "检索索引需要重建。",
      guidance: ["在诊断面板执行「重建检索索引」。"],
      repair: "rebuild-search-index",
      evidence: { searchMetaStatus: "missing", searchIndexEntries: null },
    },
    {
      id: "credentials.model",
      group: "credentials",
      title: "模型凭据",
      status: "unknown",
      severity: "P2",
      summary: "宿主没有暴露模型凭据清单，无法判断 API Key 是否已配置。",
      guidance: ["需要确认时请在「设置 → 模型」中查看。"],
      evidence: { modelConfigured: null },
    },
    {
      id: "integration.tools",
      group: "integration",
      title: "工具注册",
      status: "fail",
      severity: "P0",
      summary: "缺少 1 个工具注册：oh_story_role。",
      guidance: ["重新安装或重新启用插件构建，然后重启宿主。"],
      evidence: { expected: 5, registered: 4 },
    },
  ],
  summary: { pass: 1, warn: 2, fail: 2, unknown: 1, p0: 2, p1: 0, p2: 3 },
};

function render(): string {
  return renderToStaticMarkup(<DiagnosticsView
    report={REPORT}
    busy={false}
    onRefresh={() => undefined}
    onCopy={() => undefined}
    onBundle={() => undefined}
    onRepair={() => undefined}
  />);
}

describe("DiagnosticsView", () => {
  it("按固定顺序渲染六个分组", () => {
    const html = render();
    const labels = ["宿主", "运行时", "工作区", "数据", "凭据", "集成"];
    const positions = labels.map((label) => html.indexOf(`>${label}</h3>`));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((left, right) => left - right)).toEqual(positions);
  });

  it("显示状态、严重级别、指引与修复按钮", () => {
    const html = render();
    expect(html).toContain("失败");
    expect(html).toContain("注意");
    expect(html).toContain("通过");
    expect(html).toContain("未知");
    expect(html).toContain("P0");
    expect(html).toContain("P1");
    expect(html).toContain("P2");
    expect(html).toContain("安装受支持的宿主版本。");
    expect(html).toContain("重建检索索引");
    expect(html).toContain("宿主 0.2.1-rc.2");
  });

  it("汇总数字与证据都以纯文本呈现，不出现 undefined 或对象字符串", () => {
    const html = render();
    expect(html).toContain("P0 2");
    expect(html).toContain("P1 0");
    expect(html).toContain("P2 3");
    expect(html).toContain("通过 1");
    expect(html).toContain("注意 2");
    expect(html).toContain("未知 1");
    expect(html).toContain("—");
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("[object Object]");
  });
});
