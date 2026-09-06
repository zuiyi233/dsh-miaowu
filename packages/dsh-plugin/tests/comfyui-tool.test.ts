import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  COMFYUI_DEFAULT_COUNT,
  COMFYUI_DEFAULT_FILENAME_PREFIX,
  COMFYUI_DEFAULT_TIMEOUT_SECONDS,
  comfyuiWorkspaceEnvOverlay,
  createOhStoryComfyuiTool,
  extractComfyuiRunnerError,
  OH_STORY_COMFYUI_TOOL_NAME,
  parseComfyuiRunnerStdout,
  resolveComfyuiRunnerPath,
  resolveComfyuiWorkspaceBase,
  validateComfyuiArgs,
  type ComfyuiSpawnResult
} from "../src/comfyui-tool.js";

function execWithoutAgent(): ToolRunContext {
  const signal = new AbortController().signal;
  return { signal } as unknown as ToolRunContext;
}

function successResult(stdout: string): ComfyuiSpawnResult {
  return { exitCode: 0, stdout, stderr: "" };
}

async function runTool(
  args: Record<string, unknown>,
  spawned: ComfyuiSpawnResult,
  seen: Array<{ stdin: string; cwd: string; command: string; argv: readonly string[] }>
) {
  const tool = createOhStoryComfyuiTool({
    pythonCommand: () => Promise.resolve("python3"),
    runnerPath: "/pkg/python/comfyui_runner.py",
    spawner: (request) => {
      seen.push({ stdin: request.stdin, cwd: request.cwd, command: request.command, argv: request.argv });
      return Promise.resolve(spawned);
    }
  });
  return tool.execute(args, execWithoutAgent());
}

describe("oh_story_comfyui 参数校验", () => {
  it("声明工具名并拒绝并发", () => {
    const tool = createOhStoryComfyuiTool();
    expect(tool.name).toBe(OH_STORY_COMFYUI_TOOL_NAME);
    expect(tool.isConcurrencySafe?.({} as never)).toBe(false);
  });

  it("schema 里没有任何凭据字段", () => {
    const tool = createOhStoryComfyuiTool();
    const keys = Object.keys(tool.parameters).map((key) => key.toLowerCase());
    for (const banned of ["api_key", "apikey", "token", "secret", "password", "credential", "auth"]) {
      expect(keys.some((key) => key.includes(banned))).toBe(false);
    }
  });

  it("缺 prompt 报参数错误", () => {
    expect(() => validateComfyuiArgs({ output_dir: "cover" })).toThrow(/prompt/u);
    expect(() => validateComfyuiArgs({ prompt: "  ", output_dir: "cover" })).toThrow(/prompt/u);
  });

  it("count 越界被拒绝", () => {
    const base = { prompt: "a cat", output_dir: "cover" };
    expect(() => validateComfyuiArgs({ ...base, count: 0 })).toThrow(/count/u);
    expect(() => validateComfyuiArgs({ ...base, count: 9 })).toThrow(/count/u);
    expect(() => validateComfyuiArgs({ ...base, count: 1.5 })).toThrow(/count/u);
  });

  it("output_dir 拒绝绝对路径", () => {
    const base = { prompt: "a cat" };
    expect(() => validateComfyuiArgs({ ...base, output_dir: "/tmp/cover" })).toThrow(/相对路径/u);
    expect(() => validateComfyuiArgs({ ...base, output_dir: "C:\\cover" })).toThrow(/相对路径/u);
    expect(() => validateComfyuiArgs({ ...base, output_dir: "" })).toThrow(/output_dir/u);
  });

  it("input_image 拒绝绝对路径", () => {
    expect(() => validateComfyuiArgs({
      prompt: "a cat",
      output_dir: "cover",
      input_image: "D:/refs/cat.png"
    })).toThrow(/input_image/u);
  });

  it("filename_prefix 非法字符被拒绝", () => {
    const base = { prompt: "a cat", output_dir: "cover" };
    expect(() => validateComfyuiArgs({ ...base, filename_prefix: "../evil" })).toThrow(/filename_prefix/u);
    expect(() => validateComfyuiArgs({ ...base, filename_prefix: "a b" })).toThrow(/filename_prefix/u);
    expect(() => validateComfyuiArgs({ ...base, filename_prefix: ".hidden" })).toThrow(/filename_prefix/u);
  });

  it("timeout_seconds 越界被拒绝", () => {
    const base = { prompt: "a cat", output_dir: "cover" };
    expect(() => validateComfyuiArgs({ ...base, timeout_seconds: 0 })).toThrow(/timeout_seconds/u);
    expect(() => validateComfyuiArgs({ ...base, timeout_seconds: 3601 })).toThrow(/timeout_seconds/u);
  });
});

describe("oh_story_comfyui payload 构造", () => {
  it("回填 count/filename_prefix/timeout_seconds 默认值并透传可选字段", () => {
    const { payload, outputDir, inputImage } = validateComfyuiArgs({
      prompt: "a cat",
      output_dir: "cover",
      negative: "blurry",
      width: 1024,
      height: 1024,
      steps: 20,
      cfg: 7,
      seed: 42,
      workflow: "portrait"
    });
    expect(outputDir).toBe("cover");
    expect(inputImage).toBeUndefined();
    expect(payload).toEqual({
      prompt: "a cat",
      count: COMFYUI_DEFAULT_COUNT,
      output_dir: "cover",
      filename_prefix: COMFYUI_DEFAULT_FILENAME_PREFIX,
      timeout_seconds: COMFYUI_DEFAULT_TIMEOUT_SECONDS,
      workflow: "portrait",
      negative: "blurry",
      width: 1024,
      height: 1024,
      steps: 20,
      cfg: 7,
      seed: 42
    });
  });

  it("不会出现 workflow 缺省时的 undefined 键", () => {
    const { payload } = validateComfyuiArgs({ prompt: "a cat", output_dir: "cover" });
    expect("workflow" in payload).toBe(false);
    expect("negative" in payload).toBe(false);
    expect("input_image" in payload).toBe(false);
  });
});

describe("oh_story_comfyui runner 路径解析", () => {
  it("src 与 lib 两种运行态都落在 packages/dsh-plugin/python/", () => {
    const normalize = (path: string): string => path.replaceAll("\\", "/");
    const fromSrc = resolveComfyuiRunnerPath(
      pathToFileURL("E:/dsh-miaowu/packages/dsh-plugin/src/comfyui-tool.ts").href
    );
    const fromLib = resolveComfyuiRunnerPath(
      pathToFileURL("E:/dsh-miaowu/packages/dsh-plugin/lib/comfyui-tool.js").href
    );
    expect(normalize(fromSrc).endsWith("packages/dsh-plugin/python/comfyui_runner.py")).toBe(true);
    expect(normalize(fromLib).endsWith("packages/dsh-plugin/python/comfyui_runner.py")).toBe(true);
  });
});

describe("oh_story_comfyui 工作区基根", () => {
  it("无 Agent 时退回 process.cwd 并拒绝逃逸", async () => {
    const base = await resolveComfyuiWorkspaceBase(execWithoutAgent());
    expect(base.kind).toBe("process-cwd");
    expect(base.localDir).toBe(process.cwd());
    await expect(base.resolveInside("../evil", "output_dir")).rejects.toThrow(/逃逸/u);
    await expect(base.resolveInside("/abs/path", "output_dir")).rejects.toThrow();
    await expect(base.resolveInside("cover/ep01", "output_dir")).resolves.toBe("cover/ep01");
  });
});

describe("oh_story_comfyui 工作区配置注入", () => {
  it("只在 env 未设置时注入文件值(env 优先)", () => {
    expect(comfyuiWorkspaceEnvOverlay(
      {},
      { baseUrl: "http://file:8188", workflow: "file.json", workflowDir: "/file" }
    )).toEqual({ COMFYUI_BASE_URL: "http://file:8188", COMFYUI_WORKFLOW: "file.json", COMFYUI_WORKFLOW_DIR: "/file" });
    expect(comfyuiWorkspaceEnvOverlay(
      { COMFYUI_WORKFLOW: "env.json" },
      { workflow: "file.json", workflowDir: "/file" }
    )).toEqual({ COMFYUI_WORKFLOW_DIR: "/file" });
    expect(comfyuiWorkspaceEnvOverlay(
      { COMFYUI_BASE_URL: "http://env:8188", COMFYUI_WORKFLOW: "e.json", COMFYUI_WORKFLOW_DIR: "/e" },
      { baseUrl: "http://file:8188", workflow: "file.json", workflowDir: "/file" }
    )).toEqual({});
    expect(comfyuiWorkspaceEnvOverlay({}, {})).toEqual({});
  });

  it("spawn 请求里携带 env 覆盖,无配置时不带 env 键", async () => {
    const seen: Array<{ env?: Readonly<Record<string, string>> | undefined }> = [];
    const tool = createOhStoryComfyuiTool({
      pythonCommand: () => Promise.resolve("python3"),
      runnerPath: "/pkg/python/comfyui_runner.py",
      env: {},
      readWorkspaceConfig: () => Promise.resolve({ workflow: "file.json" }),
      spawner: (request) => {
        seen.push({ env: request.env });
        return Promise.resolve(successResult(JSON.stringify({
          files: [{ path: "cover/a.png", bytes: 10 }],
          prompt_ids: [],
          duration_ms: 100
        })));
      }
    });
    await tool.execute({ prompt: "a cat", output_dir: "cover" }, execWithoutAgent());
    expect(seen[0]?.env).toEqual({ COMFYUI_WORKFLOW: "file.json" });
  });

  it("env 已设时 spawn 不带覆盖", async () => {
    const seen: Array<{ env?: Readonly<Record<string, string>> | undefined }> = [];
    const tool = createOhStoryComfyuiTool({
      pythonCommand: () => Promise.resolve("python3"),
      runnerPath: "/pkg/python/comfyui_runner.py",
      env: { COMFYUI_WORKFLOW: "env.json" },
      readWorkspaceConfig: () => Promise.resolve({ workflow: "file.json" }),
      spawner: (request) => {
        seen.push({ env: request.env });
        return Promise.resolve(successResult(JSON.stringify({
          files: [{ path: "cover/a.png", bytes: 10 }],
          prompt_ids: [],
          duration_ms: 100
        })));
      }
    });
    await tool.execute({ prompt: "a cat", output_dir: "cover" }, execWithoutAgent());
    expect(seen[0]?.env).toBeUndefined();
  });
});

describe("oh_story_comfyui runner 输出解析", () => {
  it("解析成功输出", () => {
    const parsed = parseComfyuiRunnerStdout(JSON.stringify({
      files: [{ path: "cover/a.png", bytes: 12 }],
      prompt_ids: ["p1"],
      duration_ms: 1500
    }));
    expect(parsed.files).toEqual([{ path: "cover/a.png", bytes: 12 }]);
    expect(parsed.duration_ms).toBe(1500);
  });

  it("抽取 runner 的结构化错误", () => {
    expect(extractComfyuiRunnerError(JSON.stringify({ error: { code: "NO_WORKFLOW", message: "未配置工作流" } })))
      .toBe("未配置工作流（NO_WORKFLOW）");
    expect(extractComfyuiRunnerError(JSON.stringify({ files: [] }))).toBeUndefined();
    expect(extractComfyuiRunnerError("not json")).toBeUndefined();
  });

  it("非 JSON stdout 显式报错", () => {
    expect(() => parseComfyuiRunnerStdout("plain text")).toThrow(/非 JSON/u);
  });

  it("带 error 的 JSON stdout 显式报错", () => {
    expect(() => parseComfyuiRunnerStdout(JSON.stringify({ error: { message: "boom" } }))).toThrow(/boom/u);
  });
});

describe("oh_story_comfyui 执行路径（spawn mock）", () => {
  it("成功时 stdin 下发 payload 并返回文件清单", async () => {
    const seen: Array<{ stdin: string; cwd: string; command: string; argv: readonly string[] }> = [];
    const result = await runTool(
      { prompt: "a cat", output_dir: "cover" },
      successResult(JSON.stringify({
        files: [{ path: "cover/a.png", bytes: 10 }, { path: "cover/b.png", bytes: 20 }],
        prompt_ids: ["p1", "p2"],
        duration_ms: 2000
      })),
      seen
    ) as { files: unknown[]; output_dir: string; duration_ms: number; prompt_ids: unknown[] };
    expect(result.files).toHaveLength(2);
    expect(result.output_dir).toBe("cover");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.command).toBe("python3");
    expect(seen[0]?.argv).toEqual(["/pkg/python/comfyui_runner.py", "tool"]);
    expect(seen[0]?.cwd).toBe(process.cwd());
    const payload = JSON.parse(seen[0]?.stdin ?? "{}") as Record<string, unknown>;
    expect(payload).toEqual(expect.objectContaining({ prompt: "a cat", count: 1, output_dir: "cover" }));
  });

  it("runner exit 非零时把 stderr 转成工具错误抛出", async () => {
    const seen: Array<{ stdin: string; cwd: string; command: string; argv: readonly string[] }> = [];
    const tool = createOhStoryComfyuiTool({
      pythonCommand: () => Promise.resolve("python3"),
      runnerPath: "/pkg/python/comfyui_runner.py",
      spawner: (request) => {
        seen.push({ stdin: request.stdin, cwd: request.cwd, command: request.command, argv: request.argv });
        return Promise.resolve({
          exitCode: 1,
          stdout: JSON.stringify({ error: { code: "COMFYUI_DOWN", message: "连不上 ComfyUI" } }),
          stderr: "traceback..."
        });
      }
    });
    await expect(tool.execute({ prompt: "a cat", output_dir: "cover" }, execWithoutAgent()))
      .rejects.toThrow(/连不上 ComfyUI/u);
  });

  it("spawn 抛异常时显式报错且不吞错", async () => {
    const tool = createOhStoryComfyuiTool({
      pythonCommand: () => Promise.resolve("python3"),
      runnerPath: "/pkg/python/comfyui_runner.py",
      spawner: () => Promise.reject(new Error("ENOENT python3"))
    });
    await expect(tool.execute({ prompt: "a cat", output_dir: "cover" }, execWithoutAgent()))
      .rejects.toThrow(/ENOENT python3/u);
  });

  it("成功但 stdout 非法时显式报错", async () => {
    const seen: Array<{ stdin: string; cwd: string; command: string; argv: readonly string[] }> = [];
    await expect(runTool({ prompt: "a cat", output_dir: "cover" }, successResult("garbage"), seen))
      .rejects.toThrow(/非 JSON/u);
  });

  it("output_dir 逃逸时不启动 spawn", async () => {
    const seen: Array<{ stdin: string; cwd: string; command: string; argv: readonly string[] }> = [];
    // validateComfyuiArgs 只拦绝对路径；"..” 逃逸由基根校验拦。
    await expect(runTool(
      { prompt: "a cat", output_dir: "cover/../../evil" },
      successResult("{}"),
      seen
    )).rejects.toThrow(/逃逸/u);
    expect(seen).toHaveLength(0);
  });
});
