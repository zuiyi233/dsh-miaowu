import { describe, expect, it } from "vitest";
import {
  buildDiagnosticsReport,
  hostVersionSatisfies,
  redactDiagnosticsText,
} from "../src/services/diagnostics.js";
import type {
  DiagnosticCheck,
  DiagnosticsEnvironment,
  DiagnosticsReport,
} from "../src/services/diagnostics-contract.js";
import {
  STATE_DESCRIPTORS,
  type StateEntryStatus,
  type StateFormat,
  type StateInventoryEntry,
} from "../src/services/state-contract.js";

const SUPPORTED_RANGE = ">=0.2.0-rc.2 <0.2.1-0 || >=0.2.1-alpha.1 <0.2.2-0";
const NOW = "2026-10-20T10:00:00.000Z";
const WORKSPACE_ROOT = "E:\\dsh-miaowu";
const HOME_DIR = "C:\\Users\\Administrator";

interface EntryOverrides {
  readonly path?: string;
  readonly format?: StateFormat;
  readonly schemaVersion?: number | null;
  readonly entries?: number | null;
  readonly bytes?: number | null;
  readonly note?: string;
}

function entryFor(id: string, status: StateEntryStatus, overrides: EntryOverrides = {}): StateInventoryEntry {
  const descriptor = STATE_DESCRIPTORS.find((candidate) => candidate.id === id);
  const schemaVersion = overrides.schemaVersion === undefined
    ? (status === "ok" ? 1 : null)
    : overrides.schemaVersion;
  return {
    id,
    path: overrides.path ?? descriptor?.path ?? `.oh-story/${id}.json`,
    format: overrides.format ?? descriptor?.format ?? "json",
    expectedVersion: descriptor?.schemaVersion ?? 1,
    schemaVersion,
    status,
    fileCount: status === "missing" ? 0 : 1,
    entries: overrides.entries ?? (status === "missing" ? null : 0),
    bytes: overrides.bytes ?? (status === "missing" ? null : 128),
    lastWriteAt: null,
    lastWriteSource: "unavailable",
    ...(overrides.note === undefined ? {} : { note: overrides.note }),
  };
}

function healthyEntries(): readonly StateInventoryEntry[] {
  return STATE_DESCRIPTORS.map((descriptor) =>
    entryFor(descriptor.id, descriptor.secret === true ? "missing" : "ok")
  );
}

function healthyEnvironment(): DiagnosticsEnvironment {
  return {
    now: NOW,
    pluginVersion: "0.1.18",
    host: { version: "0.2.1-rc.2", versionSource: "host.manifest", supportedRange: SUPPORTED_RANGE },
    runtime: { node: "24.5.0", platform: "win32", arch: "x64" },
    workspace: {
      rootLabel: WORKSPACE_ROOT,
      creativeProject: true,
      stateDirectoryPresent: true,
      fileCount: 12,
      state: { generatedAt: NOW, schemaVersion: 1, entries: healthyEntries() },
    },
    integration: {
      skills: { total: 24, expectedMinimum: 20 },
      tools: {
        registered: ["oh_story_read", "oh_story_write", "oh_story_production"],
        expected: ["oh_story_read", "oh_story_write", "oh_story_production"],
      },
      roles: { registered: 5, expected: 5 },
      presets: { total: 2, available: true },
      plugins: { managerAvailable: true, bundles: ["plugin-a", "plugin-b"] },
    },
    credentials: {
      modelConfigured: true,
      vaultEnabled: false,
      vaultKeyPresent: false,
      vaultSecretsPresent: false,
    },
    session: { checked: true, readable: true, malformed: false, error: null },
    errors: [],
    redaction: { workspaceRoot: WORKSPACE_ROOT, homeDir: HOME_DIR },
  };
}

function withEntries(
  base: DiagnosticsEnvironment,
  entries: readonly StateInventoryEntry[]
): DiagnosticsEnvironment {
  return {
    ...base,
    workspace: { ...base.workspace, state: { ...base.workspace.state, entries } },
  };
}

function checkById(report: DiagnosticsReport, id: string): DiagnosticCheck {
  const found = report.checks.find((check) => check.id === id);
  if (found === undefined) throw new Error(`报告缺少检查项 ${id}`);
  return found;
}

function guidanceText(check: DiagnosticCheck): string {
  return check.guidance.join("\n");
}

function expectSummaryConsistent(report: DiagnosticsReport): void {
  const { checks, summary } = report;
  expect(summary.pass).toBe(checks.filter((check) => check.status === "pass").length);
  expect(summary.warn).toBe(checks.filter((check) => check.status === "warn").length);
  expect(summary.fail).toBe(checks.filter((check) => check.status === "fail").length);
  expect(summary.unknown).toBe(checks.filter((check) => check.status === "unknown").length);
  expect(summary.p0).toBe(checks.filter((check) => check.severity === "P0").length);
  expect(summary.p1).toBe(checks.filter((check) => check.severity === "P1").length);
  expect(summary.p2).toBe(checks.filter((check) => check.severity === "P2").length);
  expect(summary.pass + summary.warn + summary.fail + summary.unknown).toBe(checks.length);
  // p0+p1+p2 覆盖所有带等级的检查项（warn/fail/unknown 都带等级）。
  expect(summary.p0 + summary.p1 + summary.p2).toBe(summary.warn + summary.fail + summary.unknown);
}

describe("buildDiagnosticsReport：全健康环境", () => {
  it("零失败、六组齐全、ro 标记与时间来自 environment.now", () => {
    const report = buildDiagnosticsReport(healthyEnvironment());
    expect(report.readOnly).toBe(true);
    expect(report.generatedAt).toBe(NOW);
    expect(report.pluginVersion).toBe("0.1.18");
    expect(report.hostVersion).toBe("0.2.1-rc.2");
    expect(report.summary.fail).toBe(0);
    expect(report.summary.warn).toBe(0);
    expect(report.summary.unknown).toBe(0);
    expect(report.checks.length).toBeGreaterThan(0);
    expectSummaryConsistent(report);
  });

  it("分组顺序固定为 host → runtime → workspace → data → credentials → integration", () => {
    const report = buildDiagnosticsReport(healthyEnvironment());
    const groups: string[] = [];
    for (const check of report.checks) {
      if (groups[groups.length - 1] !== check.group) groups.push(check.group);
    }
    expect(groups).toEqual(["host", "runtime", "workspace", "data", "credentials", "integration"]);
    const ids = report.checks.map((check) => check.id);
    expect(ids.slice(0, 2)).toEqual(["host.version", "host.compatibility"]);
    expect(ids.slice(-6)).toEqual([
      "integration.skills",
      "integration.tools",
      "integration.roles",
      "integration.plugins",
      "integration.presets",
      "integration.session",
    ]);
    expect(ids.indexOf("data.vault")).toBeGreaterThan(0);
    expect(ids.indexOf("data.search-index")).toBeGreaterThan(ids.indexOf("data.vault"));
  });

  it("同一环境重复构建结果完全一致，且检查 id 唯一", () => {
    const first = buildDiagnosticsReport(healthyEnvironment());
    const second = buildDiagnosticsReport(healthyEnvironment());
    expect(second).toEqual(first);
    const ids = first.checks.map((check) => check.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("pass 项不带 guidance，warn/fail 项带等级", () => {
    const report = buildDiagnosticsReport(healthyEnvironment());
    for (const check of report.checks) {
      if (check.status === "pass") {
        expect(check.guidance, check.id).toEqual([]);
        expect(check.severity, check.id).toBeNull();
      } else {
        expect(check.severity, check.id).not.toBeNull();
      }
    }
  });
});

describe("宿主检查", () => {
  it("fixture A：宿主 0.2.2 超出声明范围 → P0 失败并给出两种安全做法", () => {
    const base = healthyEnvironment();
    const report = buildDiagnosticsReport({
      ...base,
      host: { ...base.host, version: "0.2.2" },
    });
    const compatibility = checkById(report, "host.compatibility");
    expect(compatibility.status).toBe("fail");
    expect(compatibility.severity).toBe("P0");
    expect(compatibility.summary).toContain("0.2.2");
    expect(compatibility.summary).toContain(SUPPORTED_RANGE);
    const text = guidanceText(compatibility);
    expect(text).toMatch(/安装受支持的宿主版本/u);
    expect(text).toMatch(/声明支持当前宿主版本/u);
    expect(text).toContain("不会静默降级");
    expect(checkById(report, "host.version").status).toBe("pass");
    expect(report.summary.p0).toBe(1);
    expectSummaryConsistent(report);
  });

  it("宿主版本未知时两项都是 unknown/P2，兼容性绝不判为 pass", () => {
    const base = healthyEnvironment();
    const report = buildDiagnosticsReport({
      ...base,
      host: { ...base.host, version: null },
    });
    expect(report.hostVersion).toBeNull();
    const version = checkById(report, "host.version");
    expect(version.status).toBe("unknown");
    expect(version.severity).toBe("P2");
    expect(guidanceText(version)).toContain("host.manifest");
    const compatibility = checkById(report, "host.compatibility");
    expect(compatibility.status).toBe("unknown");
    expect(compatibility.severity).toBe("P2");
    expect(compatibility.status).not.toBe("pass");
    expectSummaryConsistent(report);
  });

  it("声明范围无法解析时记为 unknown，而不是误报不兼容", () => {
    const base = healthyEnvironment();
    const report = buildDiagnosticsReport({
      ...base,
      host: { ...base.host, supportedRange: "not-a-range" },
    });
    const compatibility = checkById(report, "host.compatibility");
    expect(compatibility.status).toBe("unknown");
    expect(compatibility.severity).toBe("P2");
  });
});

describe("数据检查", () => {
  it("fixture B：corrupt shelf → P1，legacy tasks-runs → P2 且不提供不可执行的迁移", () => {
    const base = healthyEnvironment();
    const entries = base.workspace.state.entries
      .filter((entry) => entry.id !== "shelf" && entry.id !== "tasks-runs")
      .concat([entryFor("shelf", "corrupt"), entryFor("tasks-runs", "legacy")]);
    const report = buildDiagnosticsReport(withEntries(base, entries));
    const shelf = checkById(report, "data.shelf");
    expect(shelf.status).toBe("fail");
    expect(shelf.severity).toBe("P1");
    expect(shelf.summary).toContain(".oh-story/shelf.json");
    expect(shelf.summary).toContain("corrupt");
    expect(guidanceText(shelf)).toContain("不会自动修复");
    expect(guidanceText(shelf)).toContain("备份");
    const tasks = checkById(report, "data.tasks-runs");
    expect(tasks.status).toBe("warn");
    expect(tasks.severity).toBe("P2");
    expect(tasks.repair).toBeUndefined();
    expect(guidanceText(tasks)).toContain("不参与 v1 自动迁移");
    const allGuidance = report.checks.flatMap((check) => check.guidance).join("\n");
    expect(allGuidance).not.toContain("删除");
    expectSummaryConsistent(report);
  });

  it("密钥描述符不产生逐条 not-inspected 检查，由 data.vault 汇总", () => {
    const base = healthyEnvironment();
    const entries = base.workspace.state.entries.map((entry) =>
      entry.id === "vault-secrets" || entry.id === "vault-master-key"
        ? entryFor(entry.id, "not-inspected", { note: "只报存在性" })
        : entry
    );
    const report = buildDiagnosticsReport(withEntries(base, entries));
    expect(report.checks.some((check) => check.id === "data.vault-secrets")).toBe(false);
    expect(report.checks.some((check) => check.id === "data.vault-master-key")).toBe(false);
    expect(checkById(report, "data.vault").status).toBe("pass");
  });

  it("检索索引派生数据恢复正常时不报需要重建", () => {
    const report = buildDiagnosticsReport(healthyEnvironment());
    const index = checkById(report, "data.search-index");
    expect(index.status).toBe("pass");
    expect(index.repair).toBeUndefined();
  });

  it("会话不可读与畸形消息给出不同指引", () => {
    const base = healthyEnvironment();
    const unreadable = buildDiagnosticsReport({
      ...base,
      session: { checked: true, readable: false, malformed: false, reason: "unreadable", error: "permission denied" },
    });
    const unreadableCheck = checkById(unreadable, "integration.session");
    expect(unreadableCheck.status).toBe("fail");
    expect(unreadableCheck.summary).toContain("无法读取");
    expect(guidanceText(unreadableCheck)).toContain("没有证据表明");
    expect(guidanceText(unreadableCheck)).not.toContain("在 DSH 的会话列表里删除或归档");

    const timeout = buildDiagnosticsReport({
      ...base,
      session: { checked: true, readable: false, malformed: false, reason: "timeout", error: "会话读取超时。" },
    });
    expect(checkById(timeout, "integration.session").summary).toContain("超时");

    const malformed = buildDiagnosticsReport({
      ...base,
      session: { checked: true, readable: false, malformed: true, reason: "malformed", error: "replay validation failed" },
    });
    const malformedCheck = checkById(malformed, "integration.session");
    expect(malformedCheck.summary).toContain("畸形消息");
    expect(guidanceText(malformedCheck)).toContain("删除或归档");
  });

  it("newer 文档 → P1：要求升级插件或恢复备份，不得降级写入", () => {
    const base = healthyEnvironment();
    const entries = base.workspace.state.entries.map((entry) =>
      entry.id === "annotations" ? entryFor("annotations", "newer", { schemaVersion: 2 }) : entry
    );
    const report = buildDiagnosticsReport(withEntries(base, entries));
    const newer = checkById(report, "data.annotations");
    expect(newer.status).toBe("fail");
    expect(newer.severity).toBe("P1");
    expect(newer.summary).toContain("schema v2");
    const text = guidanceText(newer);
    expect(text).toContain("升级");
    expect(text).toContain("备份");
  });

  it("检索索引缺失/损坏 → P2 + rebuild-search-index；无创作项目 → pass", () => {
    const base = healthyEnvironment();
    const entries = base.workspace.state.entries.map((entry) =>
      entry.id === "search-meta" ? entryFor("search-meta", "corrupt") : entry
    );
    const report = buildDiagnosticsReport(withEntries(base, entries));
    const search = checkById(report, "data.search-index");
    expect(search.status).toBe("warn");
    expect(search.severity).toBe("P2");
    expect(search.repair).toBe("rebuild-search-index");
    const noProject = buildDiagnosticsReport({
      ...base,
      workspace: { ...base.workspace, creativeProject: false, fileCount: 0 },
    });
    expect(checkById(noProject, "data.search-index").status).toBe("pass");
  });

  it("有密文无主密钥 → data.vault P0（P0 优先于保险库开关）", () => {
    const base = healthyEnvironment();
    const report = buildDiagnosticsReport({
      ...base,
      credentials: {
        modelConfigured: true,
        vaultEnabled: true,
        vaultKeyPresent: false,
        vaultSecretsPresent: true,
      },
    });
    const vault = checkById(report, "data.vault");
    expect(vault.status).toBe("fail");
    expect(vault.severity).toBe("P0");
    expect(guidanceText(vault)).toContain("主密钥");
    expect(guidanceText(vault)).toContain("备份");
    expect(guidanceText(vault)).not.toContain("重新初始化后删除");
    const credentialVault = checkById(report, "credentials.vault");
    expect(credentialVault.status).toBe("fail");
    expect(credentialVault.severity).toBe("P1");
    expectSummaryConsistent(report);
  });

  it("保险库关闭但留有数据 → P2 警告，声明数据保持原样", () => {
    const base = healthyEnvironment();
    const report = buildDiagnosticsReport({
      ...base,
      credentials: {
        modelConfigured: true,
        vaultEnabled: false,
        vaultKeyPresent: true,
        vaultSecretsPresent: true,
      },
    });
    const vault = checkById(report, "data.vault");
    expect(vault.status).toBe("warn");
    expect(vault.severity).toBe("P2");
    expect(guidanceText(vault)).toContain("保持原样");
  });
});

describe("凭据与集成检查", () => {
  it("fixture C：技能 0 且缺 oh_story_production → 两个 P0 失败并点名缺失工具", () => {
    const base = healthyEnvironment();
    const report = buildDiagnosticsReport({
      ...base,
      integration: {
        ...base.integration,
        skills: { total: 0, expectedMinimum: 20 },
        tools: {
          registered: ["oh_story_read"],
          expected: ["oh_story_read", "oh_story_write", "oh_story_production"],
        },
        roles: { registered: 1, expected: 5 },
      },
    });
    const skills = checkById(report, "integration.skills");
    expect(skills.status).toBe("fail");
    expect(skills.severity).toBe("P0");
    expect(skills.summary).toContain("0");
    const tools = checkById(report, "integration.tools");
    expect(tools.status).toBe("fail");
    expect(tools.severity).toBe("P0");
    expect(tools.summary).toContain("oh_story_production");
    expect(tools.summary).not.toContain("oh_story_read");
    const roles = checkById(report, "integration.roles");
    expect(roles.status).toBe("fail");
    expect(roles.severity).toBe("P1");
    expect(report.summary.p0).toBe(2);
    expect(report.summary.p1).toBe(1);
    expectSummaryConsistent(report);
  });

  it("模型凭据不可知、插件/预设清单不可用 → unknown/P2，不冒充通过", () => {
    const base = healthyEnvironment();
    const report = buildDiagnosticsReport({
      ...base,
      credentials: { ...base.credentials, modelConfigured: null },
      integration: {
        ...base.integration,
        plugins: { managerAvailable: false, bundles: [] },
        presets: { total: 0, available: false },
      },
    });
    for (const id of [
      "credentials.model",
      "integration.plugins",
      "integration.presets",
    ]) {
      const check = checkById(report, id);
      expect(check.status, id).toBe("unknown");
      expect(check.severity, id).toBe("P2");
    }
    expect(checkById(report, "integration.plugins").summary).toContain("宿主未提供插件清单接口");
    const unknowns = report.checks.filter((check) => check.status === "unknown");
    expect(unknowns.every((check) => check.severity === "P2")).toBe(true);
    expect(report.summary.p2).toBeGreaterThanOrEqual(unknowns.length);
    expectSummaryConsistent(report);
  });

  it("模型凭据缺失 → P1 并给出设置路径指引", () => {
    const base = healthyEnvironment();
    const report = buildDiagnosticsReport({
      ...base,
      credentials: { ...base.credentials, modelConfigured: false },
    });
    const model = checkById(report, "credentials.model");
    expect(model.status).toBe("fail");
    expect(model.severity).toBe("P1");
    expect(model.guidance).toContain("设置 → 模型 填入 API Key；只查看已有作品不需要模型");
  });
});

describe("会话检查", () => {
  it("fixture D：畸形会话 → P1，指引用户自行处理且明确不改写 ~/.dsh", () => {
    const base = healthyEnvironment();
    const report = buildDiagnosticsReport({
      ...base,
      session: {
        checked: true,
        readable: true,
        malformed: true,
        error: "tool/result 缺少 callId（sk-abcdefgh12345678）",
      },
    });
    const session = checkById(report, "integration.session");
    expect(session.status).toBe("fail");
    expect(session.severity).toBe("P1");
    const text = guidanceText(session);
    expect(text).toContain("不会改写");
    expect(text).toContain("~/.dsh");
    expect(text).toContain("会话列表");
    expect(text).not.toMatch(/手动删除|手动删/u);
    expect(text).toContain("<redacted-secret>");
    expect(text).not.toContain("sk-abcdefgh12345678");
    expectSummaryConsistent(report);
  });

  it("会话可读且无畸形 → pass；未检查 → unknown/P2 并说明原因", () => {
    const base = healthyEnvironment();
    expect(checkById(buildDiagnosticsReport(base), "integration.session").status).toBe("pass");
    const unchecked = buildDiagnosticsReport({
      ...base,
      session: { checked: false, readable: null, malformed: false, error: null },
    });
    const session = checkById(unchecked, "integration.session");
    expect(session.status).toBe("unknown");
    expect(session.severity).toBe("P2");
    expect(session.summary).toContain("未检查会话日志");
    expect(guidanceText(session).length).toBeGreaterThan(0);
  });

  it("会话不可读同样 → P1", () => {
    const base = healthyEnvironment();
    const report = buildDiagnosticsReport({
      ...base,
      session: { checked: true, readable: false, malformed: false, error: null },
    });
    const session = checkById(report, "integration.session");
    expect(session.status).toBe("fail");
    expect(session.severity).toBe("P1");
  });
});

describe("redactDiagnosticsText", () => {
  const redaction = { workspaceRoot: "E:\\novel-work", homeDir: "C:\\Users\\me" };

  it("替换工作区与主目录前缀，保留路径其余文本（含反斜杠）", () => {
    expect(redactDiagnosticsText("读取 E:\\novel-work\\正文\\a.md 失败", redaction))
      .toBe("读取 <workspace>\\正文\\a.md 失败");
    expect(redactDiagnosticsText("缓存 C:/Users/me/.cache", redaction))
      .toBe("缓存 <home>/.cache");
  });

  it("最长前缀优先", () => {
    const nested = { workspaceRoot: "C:\\Users\\me\\novel", homeDir: "C:\\Users\\me" };
    expect(redactDiagnosticsText("C:\\Users\\me\\novel\\正文", nested)).toBe("<workspace>\\正文");
    expect(redactDiagnosticsText("C:\\Users\\me\\.dsh", nested)).toBe("<home>\\.dsh");
  });

  it("Windows 路径大小写不同也能命中", () => {
    expect(redactDiagnosticsText("E:\\NOVEL-WORK\\正文\\a.md", redaction))
      .toBe("<workspace>\\正文\\a.md");
    expect(redactDiagnosticsText("c:/users/ME/.dsh/sessions", redaction))
      .toBe("<home>/.dsh/sessions");
  });

  it("遮蔽 sk- 密钥、Bearer token 与 api_key 取值", () => {
    const text = "key=sk-abcdefgh12345678 Authorization: Bearer eyJhbGciOi.payload.sig api_key=plainvalue";
    const redacted = redactDiagnosticsText(text, redaction);
    expect(redacted).not.toContain("sk-abcdefgh12345678");
    expect(redacted).not.toContain("eyJhbGciOi");
    expect(redacted).not.toContain("plainvalue");
    expect(redacted).toContain("Bearer <redacted-secret>");
    expect(redacted).toContain("api_key=<redacted-secret>");
  });

  it("幂等：重复脱敏结果不变", () => {
    const messy = "E:\\novel-work\\正文 sk-abcdefgh12345678 Bearer abc.def apiKey: plainvalue C:\\Users\\me\\.dsh";
    const once = redactDiagnosticsText(messy, redaction);
    expect(redactDiagnosticsText(once, redaction)).toBe(once);
    expect(once).not.toContain("novel-work");
  });

  it("报告中的 summary/guidance/evidence 全部经过脱敏", () => {
    const base = healthyEnvironment();
    const report = buildDiagnosticsReport({
      ...base,
      workspace: { ...base.workspace, rootLabel: WORKSPACE_ROOT },
    });
    const creative = checkById(report, "workspace.creative-project");
    expect(creative.summary).toContain("<workspace>");
    expect(creative.evidence?.["rootLabel"]).toBe("<workspace>");
    expect(JSON.stringify(report)).not.toContain("dsh-miaowu");
    expect(JSON.stringify(report)).not.toContain("Administrator");
  });
});

describe("hostVersionSatisfies", () => {
  const cases: Array<[string, boolean]> = [
    ["0.2.0-rc.2", true],
    ["0.2.0", true],
    ["0.2.1-alpha.1", true],
    ["0.2.1-alpha.5", true],
    ["0.2.1-rc.2", true],
    ["0.2.1", true],
    ["0.2.2", false],
    ["0.2.0-rc.1", false],
    ["0.2.1-0", false],
    ["1.0.0", false],
  ];

  it.each(cases)("%s 对插件声明范围返回 %s", (version, expected) => {
    expect(hostVersionSatisfies(version, SUPPORTED_RANGE)).toBe(expected);
  });

  it("预发布优先级：0.2.0-rc.2 < 0.2.0 < 0.2.1-alpha.1 < 0.2.1-rc.2 < 0.2.1", () => {
    expect(hostVersionSatisfies("0.2.0", ">0.2.0-rc.2")).toBe(true);
    expect(hostVersionSatisfies("0.2.0-rc.2", "<0.2.1-alpha.1")).toBe(true);
    expect(hostVersionSatisfies("0.2.1-alpha.1", ">0.2.0 <0.2.1-rc.2")).toBe(true);
    expect(hostVersionSatisfies("0.2.1-rc.2", ">0.2.1-alpha.5 <0.2.1")).toBe(true);
    expect(hostVersionSatisfies("0.2.1", ">0.2.1-rc.2")).toBe(true);
    expect(hostVersionSatisfies("0.2.0", "<0.2.0")).toBe(false);
  });

  it("裸版本与 = 视为相等，|| 择一，空白为 AND", () => {
    expect(hostVersionSatisfies("0.2.1", "0.2.1")).toBe(true);
    expect(hostVersionSatisfies("0.2.1", "=0.2.1")).toBe(true);
    expect(hostVersionSatisfies("0.2.1", "0.2.0")).toBe(false);
    expect(hostVersionSatisfies("0.2.1", ">=0.2.0 <=0.2.1")).toBe(true);
    expect(hostVersionSatisfies("0.2.1", ">0.2.1 || 0.2.1")).toBe(true);
    expect(hostVersionSatisfies("0.2.1", ">0.2.1 || 0.2.2")).toBe(false);
  });

  it("非法版本返回 false 且不抛错", () => {
    const malformedVersions = ["", "0.2", "two", "0.2.1.4", "0.2.1-", "0.2.1-abc..def", ">=0.2.1"];
    for (const version of malformedVersions) {
      expect(() => hostVersionSatisfies(version, SUPPORTED_RANGE), version).not.toThrow();
      expect(hostVersionSatisfies(version, SUPPORTED_RANGE), version).toBe(false);
    }
  });

  it("非法范围返回 false 且不抛错", () => {
    const malformedRanges = ["", "   ", "not-a-range", ">=0.2.1 ||", "|| >=0.2.1", "^1.0.0", ">=0.2.1,"];
    for (const range of malformedRanges) {
      expect(() => hostVersionSatisfies("0.2.1", range), range).not.toThrow();
      expect(hostVersionSatisfies("0.2.1", range), range).toBe(false);
    }
  });
});
