import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ComfyuiEnvironmentStatus, JobFilenameHint, type DramaPreflightComfyui } from "../src/client/drama-production-view.js";
import { createPendingJob } from "../src/client/production-runtime.js";

function online(overrides: Partial<DramaPreflightComfyui> = {}): DramaPreflightComfyui {
  return {
    online: true,
    version: "0.3.10",
    baseUrl: "http://127.0.0.1:8188",
    workflow: { configured: true, source: "env-file" },
    ...overrides
  };
}

describe("ComfyuiEnvironmentStatus", () => {
  it("renders connected state with version, address and workflow source", () => {
    const html = renderToStaticMarkup(<ComfyuiEnvironmentStatus comfyui={online()} />);
    expect(html).toContain("ComfyUI 已连接");
    expect(html).toContain("版本 0.3.10");
    expect(html).toContain("http://127.0.0.1:8188");
    expect(html).toContain("工作流已配置（环境变量文件）");
  });

  it("names the workflow directory source when configured from env-dir", () => {
    const html = renderToStaticMarkup(<ComfyuiEnvironmentStatus comfyui={online({ workflow: { configured: true, source: "env-dir" } })} />);
    expect(html).toContain("工作流已配置（工作流目录）");
  });

  it("warns when online but no workflow is configured", () => {
    const html = renderToStaticMarkup(<ComfyuiEnvironmentStatus comfyui={online({ workflow: { configured: false, source: null } })} />);
    expect(html).toContain("ComfyUI 已连接");
    expect(html).toContain("未配置工作流——需设置 COMFYUI_WORKFLOW 或 COMFYUI_WORKFLOW_DIR");
  });

  it("renders offline state with the error summary and the fix hint", () => {
    const html = renderToStaticMarkup(<ComfyuiEnvironmentStatus comfyui={{
      online: false,
      baseUrl: "http://127.0.0.1:8188",
      error: "连接失败: fetch failed",
      workflow: { configured: false, source: null }
    }} />);
    expect(html).toContain("ComfyUI 未连接");
    expect(html).toContain("连接失败: fetch failed");
    expect(html).toContain("COMFYUI_BASE_URL");
    expect(html).toContain("docs/comfyui.md");
  });

  it("renders nothing when the host omits the comfyui field", () => {
    expect(renderToStaticMarkup(<ComfyuiEnvironmentStatus comfyui={undefined} />)).toBe("");
  });

  it("keeps previous rendering when neither runnerReady nor pythonOk is present", () => {
    const html = renderToStaticMarkup(<ComfyuiEnvironmentStatus comfyui={online()} />);
    expect(html).toContain("ComfyUI 已连接");
    expect(html).not.toContain("未检测到可用 Python");
  });

  it("warns when online but runnerReady is false", () => {
    const html = renderToStaticMarkup(<ComfyuiEnvironmentStatus comfyui={online({ runnerReady: false })} />);
    expect(html).toContain("ComfyUI 已连接");
    expect(html).toContain("本机未检测到可用 Python（3.10+），ComfyUI 生成任务将无法执行——请安装后重启 DSH");
  });

  it("falls back to pythonOk when the comfyui block has no runnerReady", () => {
    const html = renderToStaticMarkup(<ComfyuiEnvironmentStatus comfyui={online()} pythonOk={false} />);
    expect(html).toContain("本机未检测到可用 Python（3.10+），ComfyUI 生成任务将无法执行——请安装后重启 DSH");
  });

  it("prefers an explicit runnerReady true over a stale pythonOk false", () => {
    const html = renderToStaticMarkup(<ComfyuiEnvironmentStatus comfyui={online({ runnerReady: true })} pythonOk={false} />);
    expect(html).toContain("ComfyUI 已连接");
    expect(html).not.toContain("未检测到可用 Python");
  });

  it("names the workspace-file workflow source", () => {
    const html = renderToStaticMarkup(<ComfyuiEnvironmentStatus comfyui={online({ workflow: { configured: true, source: "workspace-file" } })} />);
    expect(html).toContain("工作流已配置（工作区配置）");
  });

  it("shows the config editor only when a sessionId is present", () => {
    expect(renderToStaticMarkup(<ComfyuiEnvironmentStatus comfyui={online()} />)).not.toContain("编辑配置");
    expect(renderToStaticMarkup(<ComfyuiEnvironmentStatus comfyui={online()} sessionId="sess-1" />)).toContain("编辑配置");
  });

  it("shows the config editor in the offline state too", () => {
    const offline: DramaPreflightComfyui = {
      online: false,
      baseUrl: "http://127.0.0.1:8188",
      error: "连接失败",
      workflow: { configured: false, source: null }
    };
    expect(renderToStaticMarkup(<ComfyuiEnvironmentStatus comfyui={offline} />)).not.toContain("编辑配置");
    expect(renderToStaticMarkup(<ComfyuiEnvironmentStatus comfyui={offline} sessionId="sess-1" />)).toContain("编辑配置");
  });
});

describe("JobFilenameHint", () => {
  it("warns when an awaiting job declares outputs missing the job id token", () => {
    const job = {
      ...createPendingJob({ id: "job-10", targetId: "SHOT-001", kind: "image" as const, prompt: "p" }),
      status: "awaiting_confirmation" as const,
      outputs: ["剧集/EP001/制作成果/SHOT-001-result.png"]
    };
    const html = renderToStaticMarkup(<JobFilenameHint job={job} />);
    expect(html).toContain("data-warn");
    expect(html).toContain("job-10");
    expect(html).toContain("无法自动关联");
  });

  it("stays silent when outputs carry the token, are absent, or the job left awaiting", () => {
    const base = createPendingJob({ id: "job-10", targetId: "SHOT-001", kind: "image" as const, prompt: "p" });
    const withToken = { ...base, status: "awaiting_confirmation" as const, outputs: ["剧集/EP001/制作成果/SHOT-001-job-10.png"] };
    const withoutOutputs = { ...base, status: "awaiting_confirmation" as const };
    const running = { ...base, status: "running" as const, outputs: ["x.png"] };
    // job-1 是 job-10 的前缀子串,必须按 token 语义判为缺失(与 mediaVersionMatchesJob 一致)。
    const prefixTrap = { ...base, status: "awaiting_confirmation" as const, outputs: ["SHOT-001-job-1.png"] };
    expect(renderToStaticMarkup(<JobFilenameHint job={withToken} />)).toBe("");
    expect(renderToStaticMarkup(<JobFilenameHint job={withoutOutputs} />)).toBe("");
    expect(renderToStaticMarkup(<JobFilenameHint job={running} />)).toBe("");
    expect(renderToStaticMarkup(<JobFilenameHint job={prefixTrap} />)).toContain("data-warn");
  });
});
