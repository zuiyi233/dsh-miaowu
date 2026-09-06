import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  COMFYUI_CONFIG_RELATIVE_PATH,
  comfyuiWorkflowStatus,
  readWorkspaceComfyuiConfigFile,
  resolveComfyuiConfig,
  writeWorkspaceComfyuiConfigFile
} from "../src/comfyui-status.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "oh-story-comfyui-config-"));
}

describe("workspace comfyui config file", () => {
  it("round-trips through .comfyui/config.json atomically", async () => {
    const root = tempRoot();
    try {
      // 缺文件读出空配置,不抛异常。
      expect(await readWorkspaceComfyuiConfigFile(root)).toEqual({});
      const saved = await writeWorkspaceComfyuiConfigFile(root, {
        baseUrl: "http://192.168.1.10:8188",
        workflow: "portrait",
        workflowDir: "/data"
      });
      expect(saved).toEqual({ baseUrl: "http://192.168.1.10:8188", workflow: "portrait", workflowDir: "/data" });
      const body = readFileSync(join(root, COMFYUI_CONFIG_RELATIVE_PATH), "utf8");
      expect(JSON.parse(body)).toEqual(saved);
      expect(await readWorkspaceComfyuiConfigFile(root)).toEqual(saved);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats broken JSON as absent and clears keys with empty writes", async () => {
    const root = tempRoot();
    try {
      await writeWorkspaceComfyuiConfigFile(root, { workflow: "a.json" });
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(root, COMFYUI_CONFIG_RELATIVE_PATH), "{broken", "utf8");
      expect(await readWorkspaceComfyuiConfigFile(root)).toEqual({});
      const cleared = await writeWorkspaceComfyuiConfigFile(root, {});
      expect(cleared).toEqual({});
      expect(JSON.parse(readFileSync(join(root, COMFYUI_CONFIG_RELATIVE_PATH), "utf8"))).toEqual({});
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("drama-preflight workspace merge (env > workspace-file > default)", () => {
  it("stays env-only when no session file is given or the file is broken", () => {
    // 无 sessionId / 坏文件(= {})都走 env-only,响应形状不变。
    expect(resolveComfyuiConfig({})).toMatchObject({ baseUrlSource: "default" });
    expect(resolveComfyuiConfig({}, {})).toMatchObject({ baseUrlSource: "default" });
    expect(comfyuiWorkflowStatus({}, {})).toEqual({ configured: false, source: null });
  });

  it("reads baseUrl and workflow from the workspace file with source=workspace-file", () => {
    const file = { baseUrl: "http://file:8188", workflow: "file.json" };
    expect(resolveComfyuiConfig({}, file)).toMatchObject({
      baseUrl: "http://file:8188",
      baseUrlSource: "workspace-file",
      workflow: "file.json",
      workflowSource: "workspace-file"
    });
    expect(comfyuiWorkflowStatus({}, file)).toEqual({ configured: true, source: "workspace-file" });
  });

  it("prefers env over the workspace file per key", () => {
    const file = { baseUrl: "http://file:8188", workflow: "file.json" };
    const resolved = resolveComfyuiConfig({ COMFYUI_WORKFLOW: "env.json" }, file);
    expect(resolved.baseUrl).toBe("http://file:8188");
    expect(resolved.baseUrlSource).toBe("workspace-file");
    expect(resolved.workflow).toBe("env.json");
    expect(resolved.workflowSource).toBe("env");
    expect(comfyuiWorkflowStatus({ COMFYUI_WORKFLOW: "env.json" }, file)).toEqual({ configured: true, source: "env-file" });
  });
});
