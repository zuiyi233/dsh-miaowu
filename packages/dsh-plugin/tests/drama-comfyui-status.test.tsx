import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ComfyuiEnvironmentStatus, type DramaPreflightComfyui } from "../src/client/drama-production-view.js";

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
});
