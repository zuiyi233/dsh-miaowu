import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const RUNNER_PATH = resolve(import.meta.dirname, "../python/comfyui_runner.py");
const FIXTURE_DIR = resolve(import.meta.dirname, "fixtures");
const FIXTURE_DRAMA = join(FIXTURE_DIR, "comfyui-drama.json");
const FIXTURE_TXT2IMG = join(FIXTURE_DIR, "comfyui-txt2img.json");
const FIXTURE_IMG2IMG = join(FIXTURE_DIR, "comfyui-img2img.json");
const FIXTURE_VIDEO = join(FIXTURE_DIR, "comfyui-video.json");
const FIXTURE_MUSIC = join(FIXTURE_DIR, "comfyui-music.json");
const FIXTURE_TTS = join(FIXTURE_DIR, "comfyui-tts.json");

// PNG: 8 字节签名 + IDAT/IEND 垫底；runner 只校验签名，垫底保证"真实"形状。
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("IDAT"),
  Buffer.alloc(32, 0),
  Buffer.from("IEND")
]);

// MP4: 最小 ftyp 盒头即可，对齐 runner 的 mp4 签名判断（content[4:8] == "ftyp")。
const MP4_BYTES = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from("ftypisom"),
  Buffer.alloc(16, 0)
]);

// WAV: 最小 RIFF/WAVE 头即可，对齐 runner 的 wav 签名判断。
const WAV_BYTES = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.alloc(4, 0),
  Buffer.from("WAVE"),
  Buffer.alloc(32, 0)
]);

// FLAC: "fLaC" 魔数即可，对齐 runner 的 flac 签名判断。
const FLAC_BYTES = Buffer.concat([
  Buffer.from("fLaC"),
  Buffer.alloc(36, 0)
]);

// MP3: ID3v2 标签头即可，对齐 runner 的 mp3 签名判断（无标签裸流靠帧同步字，见 runner 自测）。
const MP3_BYTES = Buffer.concat([
  Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00]),
  Buffer.alloc(32, 0)
]);

// M4A: ftyp 盒 + major brand 含 M4A，对齐 runner 的 m4a 签名判断。
const M4A_BYTES = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x20]),
  Buffer.from("ftypM4A "),
  Buffer.alloc(16, 0)
]);

type HistoryDoc = Record<string, unknown>;

interface MockOptions {
  history?: (pid: string, callIndex: number) => HistoryDoc;
  view?: Buffer | ((callIndex: number) => Buffer);
  uploadName?: string;
}

interface MockState {
  /** 每次 POST /prompt 提交的 workflow（body.prompt），按到达顺序。 */
  prompts: unknown[];
  historyCalls: string[];
  viewCalls: number;
  uploadCalls: number;
  uploadBodies: Buffer[];
}

interface MockComfyUI {
  baseUrl: string;
  state: MockState;
  close: () => Promise<void>;
}

interface RunnerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function successEntry(filename = "ComfyUI_00001_.png"): HistoryDoc {
  return {
    status: { status_str: "success", completed: true },
    outputs: { "9": { images: [{ filename, subfolder: "", type: "output" }] } }
  };
}

async function startMockComfyUI(options: MockOptions = {}): Promise<MockComfyUI> {
  const state: MockState = { prompts: [], historyCalls: [], viewCalls: 0, uploadCalls: 0, uploadBodies: [] };
  let promptSeq = 0;
  let viewSeq = 0;
  const historySeq = new Map<string, number>();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const json = (status: number, document: unknown): void => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(document));
      };
      if (req.method === "POST" && url.pathname === "/prompt") {
        promptSeq += 1;
        state.prompts.push((JSON.parse(body.toString("utf-8")) as Record<string, unknown>)["prompt"]);
        json(200, { prompt_id: `pid-${promptSeq}` });
        return;
      }
      if (req.method === "GET" && url.pathname.startsWith("/history/")) {
        const pid = decodeURIComponent(url.pathname.slice("/history/".length));
        const callIndex = historySeq.get(pid) ?? 0;
        historySeq.set(pid, callIndex + 1);
        state.historyCalls.push(pid);
        json(200, options.history?.(pid, callIndex) ?? { [pid]: successEntry() });
        return;
      }
      if (req.method === "GET" && url.pathname === "/view") {
        const bytes = typeof options.view === "function" ? options.view(viewSeq) : (options.view ?? PNG_BYTES);
        viewSeq += 1;
        state.viewCalls += 1;
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(bytes);
        return;
      }
      if (req.method === "POST" && url.pathname === "/upload/image") {
        state.uploadCalls += 1;
        state.uploadBodies.push(body);
        json(200, { name: options.uploadName ?? "uploaded-input.png", subfolder: "", type: "input" });
        return;
      }
      if (req.method === "GET" && url.pathname === "/system_stats") {
        json(200, { system: { comfyui_version: "0.3.x-mock" } });
        return;
      }
      json(404, {});
    });
  });
  await new Promise<void>((fulfill, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      fulfill();
    });
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("mock ComfyUI 未能绑定 127.0.0.1 随机端口");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    state,
    close: async () => {
      await new Promise<void>((fulfill, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else fulfill();
        });
      });
    }
  };
}

/** 隔离环境：清空宿主侧 ComfyUI 配置，只保留指向 mock 的 BASE_URL。 */
function runnerEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env["COMFYUI_API_KEY"];
  delete env["COMFYUI_WORKFLOW"];
  delete env["COMFYUI_WORKFLOW_DIR"];
  delete env["COMFYUI_TIMEOUT_SECONDS"];
  return { ...env, ...extra };
}

/**
 * 注意：必须用异步 spawn 而非 spawnSync —— 同进程的 mock http server 依赖
 * Node 事件循环，spawnSync 会阻塞事件循环导致 server 收不到请求、
 * runner 60s 后报 request_timeout。
 */
function runRunner(mode: "drama" | "tool", payload: unknown, env: NodeJS.ProcessEnv, cwd: string): Promise<RunnerResult> {
  return new Promise((fulfill, reject) => {
    const child = spawn("python", [RUNNER_PATH, mode], { env, cwd });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => {
      out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err.push(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      fulfill({
        exitCode: code ?? -1,
        stdout: Buffer.concat(out).toString("utf-8"),
        stderr: Buffer.concat(err).toString("utf-8")
      });
    });
    child.stdin.write(JSON.stringify(payload), "utf-8");
    child.stdin.end();
  });
}

function parseStdout(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

function errorOf(result: RunnerResult): Record<string, unknown> {
  return parseStdout(result.stdout)["error"] as Record<string, unknown>;
}

function nodeInput(workflow: unknown, node: string, key: string): unknown {
  if (typeof workflow !== "object" || workflow === null) return undefined;
  const entry = (workflow as Record<string, unknown>)[node];
  if (typeof entry !== "object" || entry === null) return undefined;
  const inputs = (entry as Record<string, unknown>)["inputs"];
  if (typeof inputs !== "object" || inputs === null) return undefined;
  return (inputs as Record<string, unknown>)[key];
}

function expectNoPlaceholders(workflow: unknown): void {
  expect(JSON.stringify(workflow)).not.toMatch(/__[A-Z_]+__/u);
}

const mocks: MockComfyUI[] = [];
const tempDirs: string[] = [];

async function launch(options: MockOptions = {}): Promise<MockComfyUI> {
  const mock = await startMockComfyUI(options);
  mocks.push(mock);
  return mock;
}

async function makeTemp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "comfyui-runner-e2e-"));
  tempDirs.push(dir);
  return dir;
}

beforeAll(() => {
  try {
    execFileSync("python", ["--version"], { stdio: "pipe" });
  } catch {
    throw new Error("comfyui-runner-e2e 需要 `python` 可用：探测 `python --version` 失败，本机未装 Python 或不在 PATH（不允许静默 skip，故显式失败）");
  }
});

afterEach(async () => {
  await Promise.all(mocks.splice(0).map((mock) => mock.close()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("comfyui_runner 端到端（mock server + 真实 python 子进程）", () => {
  it("drama 模式成功：占位符替换 + 产物落盘 + provider_job_id", async () => {
    const mock = await launch();
    const root = await makeTemp();
    const outputRoot = join(root, "out");
    const projectRoot = join(root, "proj");
    await mkdir(outputRoot, { recursive: true });
    await mkdir(projectRoot, { recursive: true });
    const prompt = "雨夜路灯下的橘猫";
    const result = await runRunner("drama", {
      modality: "image",
      prompt,
      parameters: {},
      outputs: ["剧集/EP001/制作成果/x.png"],
      output_root: outputRoot,
      run_id: "r1",
      project_root: projectRoot
    }, runnerEnv({ COMFYUI_BASE_URL: mock.baseUrl, COMFYUI_WORKFLOW: FIXTURE_DRAMA }), root);
    expect(result.exitCode).toBe(0);
    expect(parseStdout(result.stdout)).toEqual({
      outputs: [{ target: "剧集/EP001/制作成果/x.png", source: join(outputRoot, "result.png") }],
      provider_job_id: "pid-1"
    });
    expect(Buffer.from(await readFile(join(outputRoot, "result.png"))).equals(PNG_BYTES)).toBe(true);
    expect(mock.state.prompts).toHaveLength(1);
    const submitted = mock.state.prompts[0];
    expect(nodeInput(submitted, "1", "text")).toBe(prompt);
    expect(typeof nodeInput(submitted, "3", "seed")).toBe("number");
    expectNoPlaceholders(submitted);
  }, 60_000);

  it("tool 模式成功：文件落盘 + prompt_ids + duration_ms", async () => {
    const mock = await launch();
    const cwd = await makeTemp();
    const result = await runRunner("tool", {
      prompt: "a cat",
      width: 768,
      height: 1024,
      steps: 20,
      output_dir: "cover",
      filename_prefix: "cover"
    }, runnerEnv({ COMFYUI_BASE_URL: mock.baseUrl, COMFYUI_WORKFLOW: FIXTURE_TXT2IMG }), cwd);
    expect(result.exitCode).toBe(0);
    const out = parseStdout(result.stdout);
    expect(out["prompt_ids"]).toEqual(["pid-1"]);
    expect(typeof out["duration_ms"]).toBe("number");
    const files = out["files"] as Array<Record<string, unknown>>;
    expect(files).toHaveLength(1);
    expect(files[0]?.["bytes"]).toBe(PNG_BYTES.length);
    const landed = String(files[0]?.["path"]);
    expect(landed.endsWith("cover-1.png")).toBe(true);
    expect(Buffer.from(await readFile(landed)).equals(PNG_BYTES)).toBe(true);
    expect(mock.state.prompts).toHaveLength(1);
    const submitted = mock.state.prompts[0];
    expect(nodeInput(submitted, "1", "text")).toBe("a cat");
    expect(nodeInput(submitted, "2", "width")).toBe(768);
    expect(nodeInput(submitted, "2", "height")).toBe(1024);
    expect(nodeInput(submitted, "3", "steps")).toBe(20);
    expect(typeof nodeInput(submitted, "3", "seed")).toBe("number");
    expectNoPlaceholders(submitted);
  }, 60_000);

  it("count=3：seed 严格递增 + 3 文件 + 3 prompt_id", async () => {
    const mock = await launch();
    const cwd = await makeTemp();
    const result = await runRunner("tool", {
      prompt: "a cat",
      width: 512,
      height: 512,
      steps: 10,
      count: 3,
      seed: 500,
      output_dir: "outs",
      filename_prefix: "batch"
    }, runnerEnv({ COMFYUI_BASE_URL: mock.baseUrl, COMFYUI_WORKFLOW: FIXTURE_TXT2IMG }), cwd);
    expect(result.exitCode).toBe(0);
    const out = parseStdout(result.stdout);
    expect(out["prompt_ids"]).toEqual(["pid-1", "pid-2", "pid-3"]);
    expect((out["files"] as unknown[])).toHaveLength(3);
    expect(mock.state.prompts).toHaveLength(3);
    const seeds = mock.state.prompts.map((workflow) => nodeInput(workflow, "3", "seed"));
    expect(seeds).toEqual([500, 501, 502]);
    expect(seeds[1] as number > (seeds[0] as number) && (seeds[2] as number) > (seeds[1] as number)).toBe(true);
  }, 60_000);

  it("图生图：input_image 经 /upload/image 后替换 __INPUT_IMAGE__", async () => {
    const mock = await launch({ uploadName: "server-cat.png" });
    const cwd = await makeTemp();
    await writeFile(join(cwd, "input.png"), PNG_BYTES);
    const result = await runRunner("tool", {
      prompt: "a cat",
      width: 512,
      height: 512,
      steps: 10,
      output_dir: "cover",
      filename_prefix: "img2img",
      input_image: "input.png"
    }, runnerEnv({ COMFYUI_BASE_URL: mock.baseUrl, COMFYUI_WORKFLOW: FIXTURE_IMG2IMG }), cwd);
    expect(result.exitCode).toBe(0);
    expect(mock.state.uploadCalls).toBe(1);
    expect(mock.state.uploadBodies[0]?.length).toBeGreaterThan(0);
    expect(mock.state.prompts).toHaveLength(1);
    const submitted = mock.state.prompts[0];
    expect(nodeInput(submitted, "5", "image")).toBe("server-cat.png");
    expectNoPlaceholders(submitted);
  }, 60_000);

  it("node_error：history 报 error → 退出码 1 + provider 错误", async () => {
    const mock = await launch({
      history: (pid) => ({
        [pid]: { status: { status_str: "error", messages: [["NodeA", "boom"]] }, outputs: {} }
      })
    });
    const cwd = await makeTemp();
    const result = await runRunner("tool", {
      prompt: "a cat",
      width: 512,
      height: 512,
      steps: 10,
      output_dir: "cover"
    }, runnerEnv({ COMFYUI_BASE_URL: mock.baseUrl, COMFYUI_WORKFLOW: FIXTURE_TXT2IMG }), cwd);
    expect(result.exitCode).toBe(1);
    expect(errorOf(result)).toMatchObject({ category: "provider", code: "node_error" });
  }, 60_000);

  it("未配置工作流：env 与 payload 均无 → workflow_not_configured", async () => {
    const mock = await launch();
    const cwd = await makeTemp();
    const result = await runRunner("tool", {
      prompt: "a cat",
      output_dir: "cover"
    }, runnerEnv({ COMFYUI_BASE_URL: mock.baseUrl }), cwd);
    expect(result.exitCode).toBe(1);
    expect(errorOf(result)["code"]).toBe("workflow_not_configured");
  }, 60_000);

  it("媒体签名不符：/view 返回垃圾字节 → output_invalid_media 且无残留文件", async () => {
    const mock = await launch({ view: Buffer.from("this is not a png file....") });
    const root = await makeTemp();
    const outputRoot = join(root, "out");
    await mkdir(outputRoot, { recursive: true });
    const result = await runRunner("drama", {
      modality: "image",
      prompt: "a cat",
      parameters: {},
      outputs: ["shot/x.png"],
      output_root: outputRoot,
      run_id: "r1",
      project_root: root
    }, runnerEnv({ COMFYUI_BASE_URL: mock.baseUrl, COMFYUI_WORKFLOW: FIXTURE_DRAMA }), root);
    expect(result.exitCode).toBe(1);
    expect(errorOf(result)["code"]).toBe("output_invalid_media");
    expect(await readdir(outputRoot)).toEqual([]);
  }, 60_000);

  it("超时：history 永远 pending + timeout_seconds=1 → comfyui_timeout", async () => {    const mock = await launch({ history: () => ({}) });
    const cwd = await makeTemp();
    const result = await runRunner("tool", {
      prompt: "a cat",
      width: 512,
      height: 512,
      steps: 10,
      output_dir: "cover",
      timeout_seconds: 1
    }, runnerEnv({ COMFYUI_BASE_URL: mock.baseUrl, COMFYUI_WORKFLOW: FIXTURE_TXT2IMG }), cwd);
    expect(result.exitCode).toBe(1);
    expect(errorOf(result)).toMatchObject({ category: "timeout", code: "comfyui_timeout" });
  }, 60_000);

  it("drama 未知参数：ratio/size 成功且 stderr 警告、产物正常", async () => {
    const mock = await launch();
    const root = await makeTemp();
    const outputRoot = join(root, "out");
    const projectRoot = join(root, "proj");
    await mkdir(outputRoot, { recursive: true });
    await mkdir(projectRoot, { recursive: true });
    const result = await runRunner("drama", {
      modality: "image",
      prompt: "雨夜路灯下的橘猫",
      parameters: { ratio: "9:16", size: "large", width: 512, mystery: null, blank: "" },
      outputs: ["shot/x.png"],
      output_root: outputRoot,
      run_id: "r-warn",
      project_root: projectRoot
    }, runnerEnv({ COMFYUI_BASE_URL: mock.baseUrl, COMFYUI_WORKFLOW: FIXTURE_DRAMA }), root);
    expect(result.exitCode).toBe(0);
    expect(parseStdout(result.stdout)).toEqual({
      outputs: [{ target: "shot/x.png", source: join(outputRoot, "result.png") }],
      provider_job_id: "pid-1"
    });
    expect(result.stderr).toContain("comfyui-runner: ignored parameters: ratio, size");
    expect(Buffer.from(await readFile(join(outputRoot, "result.png"))).equals(PNG_BYTES)).toBe(true);
  }, 60_000);

  it("tool 前导点 prefix：filename_prefix=.hidden → 退出码 1 + 结构化错误", async () => {
    const mock = await launch();
    const cwd = await makeTemp();
    const result = await runRunner("tool", {
      prompt: "a cat",
      output_dir: "cover",
      filename_prefix: ".hidden"
    }, runnerEnv({ COMFYUI_BASE_URL: mock.baseUrl, COMFYUI_WORKFLOW: FIXTURE_TXT2IMG }), cwd);
    expect(result.exitCode).toBe(1);
    expect(errorOf(result)).toMatchObject({ category: "invalid_request" });
    expect(mock.state.prompts).toHaveLength(0);
  }, 60_000);

  it("tool 未知参数：stdout warnings 数组含该项且 stderr 同步警告", async () => {
    const mock = await launch();
    const cwd = await makeTemp();
    const result = await runRunner("tool", {
      prompt: "a cat",
      width: 512,
      height: 512,
      steps: 10,
      output_dir: "cover",
      filename_prefix: "cover",
      ratio: "9:16"
    }, runnerEnv({ COMFYUI_BASE_URL: mock.baseUrl, COMFYUI_WORKFLOW: FIXTURE_TXT2IMG }), cwd);
    expect(result.exitCode).toBe(0);
    expect(parseStdout(result.stdout)["warnings"]).toEqual(["ratio"]);
    expect(result.stderr).toContain("comfyui-runner: ignored parameters: ratio");
    const files = parseStdout(result.stdout)["files"] as Array<Record<string, unknown>>;
    expect(files).toHaveLength(1);
    expect(Buffer.from(await readFile(String(files[0]?.["path"]))).equals(PNG_BYTES)).toBe(true);
  }, 60_000);

  it("tool 视频：video 工作流 + mp4 签名 → 产物落盘", async () => {
    const mock = await launch({
      history: (pid) => ({ [pid]: { status: { status_str: "success", completed: true }, outputs: { "4": { gifs: [{ filename: "ComfyUI_00001_.mp4", subfolder: "", type: "output" }] } } } }),
      view: MP4_BYTES
    });
    const cwd = await makeTemp();
    const result = await runRunner("tool", {
      prompt: "a cat walking in the rain",
      fps: 24,
      duration_seconds: 3,
      output_dir: "video",
      filename_prefix: "shot"
    }, runnerEnv({ COMFYUI_BASE_URL: mock.baseUrl, COMFYUI_WORKFLOW: FIXTURE_VIDEO }), cwd);
    expect(result.exitCode).toBe(0);
    const out = parseStdout(result.stdout);
    expect(out["prompt_ids"]).toEqual(["pid-1"]);
    const files = out["files"] as Array<Record<string, unknown>>;
    expect(files).toHaveLength(1);
    const landed = String(files[0]?.["path"]);
    expect(landed.endsWith("shot-1.mp4")).toBe(true);
    const bytes = Buffer.from(await readFile(landed));
    expect(bytes.equals(MP4_BYTES)).toBe(true);
    expect(bytes.subarray(4, 8).toString("ascii")).toBe("ftyp");
    const submitted = mock.state.prompts[0];
    expect(nodeInput(submitted, "1", "text")).toBe("a cat walking in the rain");
    expect(nodeInput(submitted, "4", "frame_rate")).toBe(24);
    expect(nodeInput(submitted, "5", "length")).toBe(3);
    expect(typeof nodeInput(submitted, "3", "seed")).toBe("number");
    expectNoPlaceholders(submitted);
  }, 60_000);

  it("tool 音乐：music 工作流 wav 路径端到端", async () => {
    const mock = await launch({
      history: (pid) => ({ [pid]: { status: { status_str: "success", completed: true }, outputs: { "3": { gifs: [{ filename: "ComfyUI_00001_.wav", subfolder: "", type: "output" }] } } } }),
      view: WAV_BYTES
    });
    const cwd = await makeTemp();
    const result = await runRunner("tool", {
      prompt: "lofi piano loop, 90bpm",
      duration_seconds: 30,
      output_dir: "music",
      filename_prefix: "bgm"
    }, runnerEnv({ COMFYUI_BASE_URL: mock.baseUrl, COMFYUI_WORKFLOW: FIXTURE_MUSIC }), cwd);
    expect(result.exitCode).toBe(0);
    const out = parseStdout(result.stdout);
    const files = out["files"] as Array<Record<string, unknown>>;
    expect(files).toHaveLength(1);
    const landed = String(files[0]?.["path"]);
    expect(landed.endsWith("bgm-1.wav")).toBe(true);
    const bytes = Buffer.from(await readFile(landed));
    expect(bytes.equals(WAV_BYTES)).toBe(true);
    expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(bytes.subarray(8, 12).toString("ascii")).toBe("WAVE");
    const submitted = mock.state.prompts[0];
    expect(nodeInput(submitted, "1", "text")).toBe("lofi piano loop, 90bpm");
    expect(nodeInput(submitted, "2", "duration")).toBe(30);
    expect(typeof nodeInput(submitted, "2", "seed")).toBe("number");
    expectNoPlaceholders(submitted);
  }, 60_000);

  it("tool TTS：tts 工作流 wav 路径端到端", async () => {
    const mock = await launch({
      history: (pid) => ({ [pid]: { status: { status_str: "success", completed: true }, outputs: { "3": { gifs: [{ filename: "ComfyUI_00001_.wav", subfolder: "", type: "output" }] } } } }),
      view: WAV_BYTES
    });
    const cwd = await makeTemp();
    const result = await runRunner("tool", {
      prompt: "你好，这里是解说配音。",
      output_dir: "tts",
      filename_prefix: "narr"
    }, runnerEnv({ COMFYUI_BASE_URL: mock.baseUrl, COMFYUI_WORKFLOW: FIXTURE_TTS }), cwd);
    expect(result.exitCode).toBe(0);
    const files = parseStdout(result.stdout)["files"] as Array<Record<string, unknown>>;
    expect(files).toHaveLength(1);
    expect(String(files[0]?.["path"]).endsWith("narr-1.wav")).toBe(true);
    expect(Buffer.from(await readFile(String(files[0]?.["path"]))).equals(WAV_BYTES)).toBe(true);
    const submitted = mock.state.prompts[0];
    expect(nodeInput(submitted, "1", "text")).toBe("你好，这里是解说配音。");
    expect(typeof nodeInput(submitted, "2", "seed")).toBe("number");
    expectNoPlaceholders(submitted);
  }, 60_000);

  it("tool 音频：SaveAudio 的 audio 键 + flac 魔数 → 产物落盘", async () => {
    const mock = await launch({
      history: (pid) => ({ [pid]: { status: { status_str: "success", completed: true }, outputs: { "3": { audio: [{ filename: "ComfyUI_00001_.flac", subfolder: "", type: "output" }] } } } }),
      view: FLAC_BYTES
    });
    const cwd = await makeTemp();
    const result = await runRunner("tool", {
      prompt: "lofi piano loop, 90bpm",
      duration_seconds: 30,
      output_dir: "music",
      filename_prefix: "bgm"
    }, runnerEnv({ COMFYUI_BASE_URL: mock.baseUrl, COMFYUI_WORKFLOW: FIXTURE_MUSIC }), cwd);
    expect(result.exitCode).toBe(0);
    const files = parseStdout(result.stdout)["files"] as Array<Record<string, unknown>>;
    expect(files).toHaveLength(1);
    const landed = String(files[0]?.["path"]);
    expect(landed.endsWith("bgm-1.flac")).toBe(true);
    const bytes = Buffer.from(await readFile(landed));
    expect(bytes.equals(FLAC_BYTES)).toBe(true);
    expect(bytes.subarray(0, 4).toString("ascii")).toBe("fLaC");
  }, 60_000);

  it("tool 音频：mp3(ID3)与 m4a 魔数 → 产物落盘", async () => {
    for (const [bytes, suffix, ascii] of [
      [MP3_BYTES, ".mp3", "ID3"],
      [M4A_BYTES, ".m4a", "ftyp"]
    ] as const) {
      const mock = await launch({
        history: (pid) => ({ [pid]: { status: { status_str: "success", completed: true }, outputs: { "3": { audio: [{ filename: `ComfyUI_00001_${suffix}`, subfolder: "", type: "output" }] } } } }),
        view: bytes
      });
      const cwd = await makeTemp();
      const result = await runRunner("tool", {
        prompt: "audio signature probe",
        duration_seconds: 10,
        output_dir: "music",
        filename_prefix: "sig"
      }, runnerEnv({ COMFYUI_BASE_URL: mock.baseUrl, COMFYUI_WORKFLOW: FIXTURE_MUSIC }), cwd);
      expect(result.exitCode).toBe(0);
      const files = parseStdout(result.stdout)["files"] as Array<Record<string, unknown>>;
      expect(files).toHaveLength(1);
      const landed = String(files[0]?.["path"]);
      expect(landed.endsWith(`sig-1${suffix}`)).toBe(true);
      expect(Buffer.from(await readFile(landed)).subarray(0, 3).toString("ascii") === ascii
        || Buffer.from(await readFile(landed)).subarray(4, 8).toString("ascii") === ascii).toBe(true);
    }
  }, 60_000);
});
