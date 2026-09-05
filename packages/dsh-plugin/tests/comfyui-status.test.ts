import { describe, expect, it } from "vitest";
import {
  COMFYUI_DEFAULT_BASE_URL,
  comfyuiBaseUrl,
  comfyuiWorkflowStatus,
  probeComfyui,
  type ComfyuiFetch
} from "../src/comfyui-status.js";

function okJson(body: unknown, status = 200): ComfyuiFetch {
  return async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
}

describe("comfyuiBaseUrl", () => {
  it("defaults when unset", () => {
    expect(comfyuiBaseUrl({})).toBe(COMFYUI_DEFAULT_BASE_URL);
    expect(comfyuiBaseUrl({ COMFYUI_BASE_URL: "   " })).toBe(COMFYUI_DEFAULT_BASE_URL);
    expect(COMFYUI_DEFAULT_BASE_URL).toBe("http://127.0.0.1:8188");
  });

  it("honors a valid custom URL and strips trailing slashes", () => {
    expect(comfyuiBaseUrl({ COMFYUI_BASE_URL: "http://192.168.1.10:8188///" })).toBe("http://192.168.1.10:8188");
    expect(comfyuiBaseUrl({ COMFYUI_BASE_URL: "https://comfy.example.com/api" })).toBe("https://comfy.example.com/api");
  });

  it("falls back to default on illegal URLs", () => {
    expect(comfyuiBaseUrl({ COMFYUI_BASE_URL: "not-a-url" })).toBe(COMFYUI_DEFAULT_BASE_URL);
    expect(comfyuiBaseUrl({ COMFYUI_BASE_URL: "ftp://host:21/x" })).toBe(COMFYUI_DEFAULT_BASE_URL);
  });
});

describe("probeComfyui", () => {
  it("reports online with version from the real system_stats shape", async () => {
    const result = await probeComfyui({}, okJson({ system: { comfyui_version: "0.3.10" } }));
    expect(result).toEqual({ online: true, version: "0.3.10", baseUrl: COMFYUI_DEFAULT_BASE_URL });
  });

  it("accepts a top-level comfyui_version as a loose fallback", async () => {
    const result = await probeComfyui({}, okJson({ comfyui_version: "0.3.9" }));
    expect(result.online).toBe(true);
    expect(result.version).toBe("0.3.9");
  });

  it("reports offline on connection failure", async () => {
    const failing: ComfyuiFetch = async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:8188"); };
    const result = await probeComfyui({}, failing);
    expect(result.online).toBe(false);
    expect(result.baseUrl).toBe(COMFYUI_DEFAULT_BASE_URL);
    expect(result.error).toContain("ECONNREFUSED");
    expect(JSON.stringify(result)).not.toMatch(/sk-|Bearer [A-Za-z0-9]/u);
  });

  it("reports offline on non-2xx and non-JSON without throwing", async () => {
    const http500 = await probeComfyui({}, okJson({}, 500));
    expect(http500).toMatchObject({ online: false });
    expect(http500.error).toContain("500");
    const badJson: ComfyuiFetch = async () => ({
      ok: true, status: 200, json: async () => { throw new Error("Unexpected token"); }
    });
    const notJson = await probeComfyui({}, badJson);
    expect(notJson.online).toBe(false);
    expect(notJson.error).toContain("JSON");
    const missingVersion = await probeComfyui({}, okJson({ system: {} }));
    expect(missingVersion.online).toBe(false);
    expect(missingVersion.error).toContain("comfyui_version");
  });

  it("reports offline on timeout", async () => {
    const hanging: ComfyuiFetch = async (_url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        const aborted = new Error("The operation was aborted.");
        aborted.name = "AbortError";
        reject(aborted);
      });
    });
    const result = await probeComfyui({}, hanging);
    expect(result.online).toBe(false);
    expect(result.error).toContain("超时");
  }, 10_000);

  it("sends the API key as a header but never leaks it into the result", async () => {
    let seenAuth: string | undefined;
    const spy: ComfyuiFetch = async (_url, init) => {
      const headers = init.headers;
      seenAuth = typeof headers === "object" && headers !== null
        ? (headers as Record<string, string>)["Authorization"]
        : undefined;
      return { ok: true, status: 200, json: async () => ({ system: { comfyui_version: "1.0.0" } }) };
    };
    const result = await probeComfyui({ COMFYUI_API_KEY: "sk-test-secret" }, spy);
    expect(seenAuth).toBe("Bearer sk-test-secret");
    expect(result.online).toBe(true);
    expect(JSON.stringify(result)).not.toContain("sk-test-secret");
  });

  it("marks invalid base URLs and still probes the default", async () => {
    let seenUrl = "";
    const spy: ComfyuiFetch = async (url) => {
      seenUrl = url;
      return { ok: true, status: 200, json: async () => ({ system: { comfyui_version: "0.3.10" } }) };
    };
    const result = await probeComfyui({ COMFYUI_BASE_URL: "::::bad" }, spy);
    expect(seenUrl).toBe(`${COMFYUI_DEFAULT_BASE_URL}/system_stats`);
    expect(result).toMatchObject({ online: true, baseUrl: COMFYUI_DEFAULT_BASE_URL });
    expect(result.error).toContain("回退默认");
  });
});

describe("comfyuiWorkflowStatus", () => {
  it("prefers env-file over env-dir, else unconfigured", () => {
    expect(comfyuiWorkflowStatus({})).toEqual({ configured: false, source: null });
    expect(comfyuiWorkflowStatus({ COMFYUI_WORKFLOW_DIR: "/data/workflows" }))
      .toEqual({ configured: true, source: "env-dir" });
    expect(comfyuiWorkflowStatus({ COMFYUI_WORKFLOW: "/data/w.json", COMFYUI_WORKFLOW_DIR: "/data" }))
      .toEqual({ configured: true, source: "env-file" });
  });
});
