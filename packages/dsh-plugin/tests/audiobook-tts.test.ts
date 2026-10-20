import { describe, expect, it, vi } from "vitest";
import { WorkspaceHttpError } from "../src/workspace-route.js";
import {
  buildTtsRequest,
  OpenAiCompatibleTtsClient,
  parseRetryAfterMs,
  type TtsFetch,
  type TtsRequest,
} from "../src/services/audiobook-tts.js";

const CONFIG = {
  baseUrl: "https://api.example.com/v1/",
  model: "tts-1",
  responseFormat: "mp3" as const,
  speed: 1,
  pricePerMillionChars: 15,
  maxCharsPerChapter: 20_000,
  concurrency: 2,
};
const ENV = { OH_STORY_TTS_API_KEY: "secret-key" };
const REQUEST: TtsRequest = {
  baseUrl: CONFIG.baseUrl,
  model: CONFIG.model,
  voice: "alloy",
  text: "你好。",
  responseFormat: "mp3",
  speed: 1,
  apiKey: ENV.OH_STORY_TTS_API_KEY,
};

const audioResponse = (bytes: readonly number[]): Response =>
  new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": "audio/mpeg" } });

function captured(action: () => unknown): WorkspaceHttpError {
  try {
    action();
  } catch (error) {
    if (error instanceof WorkspaceHttpError) return error;
    throw error;
  }
  throw new Error("预期抛出 WorkspaceHttpError");
}

async function failure(promise: Promise<unknown>): Promise<WorkspaceHttpError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof WorkspaceHttpError) return error;
    throw error;
  }
  throw new Error("预期抛出 WorkspaceHttpError");
}

async function rejectionReason(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("预期 promise 被拒绝");
}

function expectAbortError(reason: unknown): void {
  // 调用方取消的 reason 是 DOMException，退避 sleep 抛的是 Node 自带的 AbortError，
  // 两者都只按 name 判定；关键是它不能是 502 的 WorkspaceHttpError。
  const name = typeof reason === "object" && reason !== null ? (reason as { name?: unknown }).name : undefined;
  expect(name).toBe("AbortError");
  expect(reason).not.toBeInstanceOf(WorkspaceHttpError);
}

describe("parseRetryAfterMs", () => {
  const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);

  it("解析秒数并封顶 10s", () => {
    expect(parseRetryAfterMs("0")).toBe(0);
    expect(parseRetryAfterMs("2")).toBe(2_000);
    expect(parseRetryAfterMs(" 3 ")).toBe(3_000);
    expect(parseRetryAfterMs("60")).toBe(10_000);
    expect(parseRetryAfterMs("999999999999999999999")).toBe(10_000);
  });

  it("解析 HTTP 日期并夹到 [0, 10s]", () => {
    expect(parseRetryAfterMs(new Date(NOW + 3_000).toUTCString(), NOW)).toBe(3_000);
    expect(parseRetryAfterMs(new Date(NOW - 3_000).toUTCString(), NOW)).toBe(0);
    expect(parseRetryAfterMs(new Date(NOW + 60_000).toUTCString(), NOW)).toBe(10_000);
  });

  it("空值或不可解析时交给指数退避", () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs("   ")).toBeUndefined();
    expect(parseRetryAfterMs("later")).toBeUndefined();
  });
});

describe("buildTtsRequest", () => {
  it("只发送标准字段，Authorization 只放在请求头", () => {
    const request = buildTtsRequest(CONFIG, ENV, "你好。", "alloy");

    expect(request.url).toBe("https://api.example.com/v1/audio/speech");
    expect(JSON.parse(String(request.init.body))).toEqual({
      model: "tts-1",
      input: "你好。",
      voice: "alloy",
      response_format: "mp3",
      speed: 1,
    });
    const headers = request.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer secret-key");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(request.init.method).toBe("POST");
    expect(request.init.redirect).toBe("error");
    expect(String(request.init.body)).not.toContain("secret-key");
    expect(Object.keys(JSON.parse(String(request.init.body))).sort()).toEqual([
      "input",
      "model",
      "response_format",
      "speed",
      "voice",
    ]);
  });

  it("缺少或空白密钥时返回 503，且错误信息不回显密钥", () => {
    expect(captured(() => buildTtsRequest(CONFIG, {}, "你好。", "alloy"))).toMatchObject({ status: 503 });
    expect(captured(() => buildTtsRequest(CONFIG, { OH_STORY_TTS_API_KEY: "   " }, "你好。", "alloy")))
      .toMatchObject({ status: 503 });
  });

  it("端点沿用项目校验，非法地址返回 400", () => {
    expect(captured(() => buildTtsRequest({ ...CONFIG, baseUrl: "http://api.example.com/v1" }, ENV, "你好。", "alloy")))
      .toMatchObject({ status: 400 });
    expect(captured(() => buildTtsRequest({ ...CONFIG, baseUrl: "not a url" }, ENV, "你好。", "alloy")))
      .toMatchObject({ status: 400 });
  });
});

describe("OpenAiCompatibleTtsClient", () => {
  it("429 重试后成功，4xx 不重试", async () => {
    const responses = [
      new Response("busy", { status: 429, headers: { "retry-after": "0" } }),
      audioResponse([1, 2]),
    ];
    const fetchImpl = vi.fn(async () => responses.shift()!);
    const client = new OpenAiCompatibleTtsClient({ fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 1000 });

    const bytes = await client.synthesize(REQUEST);

    expect(Array.from(bytes)).toEqual([1, 2]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const fourFetch = vi.fn(async () => new Response("bad", { status: 400 }));
    const four = new OpenAiCompatibleTtsClient({ fetchImpl: fourFetch as unknown as typeof fetch, timeoutMs: 1000 });
    await expect(four.synthesize(REQUEST)).rejects.toMatchObject({ status: 502 });
    expect(fourFetch).toHaveBeenCalledTimes(1);
  });

  it("拒绝非 audio 响应", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    const client = new OpenAiCompatibleTtsClient({ fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 1000 });

    await expect(client.synthesize(REQUEST)).rejects.toMatchObject({ status: 502 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("拒绝超限响应", async () => {
    const fetchImpl = vi.fn(async () => audioResponse([1, 2, 3, 4, 5]));
    const client = new OpenAiCompatibleTtsClient({ fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 1000, maxBytes: 4 });

    await expect(client.synthesize(REQUEST)).rejects.toMatchObject({ status: 502 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("拒绝空响应", async () => {
    const fetchImpl = vi.fn(async () => audioResponse([]));
    const client = new OpenAiCompatibleTtsClient({ fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 1000 });

    await expect(client.synthesize(REQUEST)).rejects.toMatchObject({ status: 502 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("5xx 最多尝试 3 次后返回 502", async () => {
    const fetchImpl = vi.fn(async () => new Response("oops", { status: 503, headers: { "retry-after": "0" } }));
    const client = new OpenAiCompatibleTtsClient({ fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 1000 });

    const error = await failure(client.synthesize(REQUEST));

    expect(error).toMatchObject({ status: 502 });
    expect(error.message).toContain("第 3 次尝试");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("请求携带 redirect: error，调用方取消合并进请求信号并中途生效", async () => {
    const caller = new AbortController();
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const fetchImpl = vi.fn<TtsFetch>((_url, init) => {
      notifyStarted();
      const requestSignal = init.signal;
      if (requestSignal === null || requestSignal === undefined) throw new Error("请求缺少取消信号");
      return new Promise<Response>((_resolve, reject) => {
        requestSignal.addEventListener("abort", () => reject(requestSignal.reason), { once: true });
      });
    });
    const client = new OpenAiCompatibleTtsClient({ fetchImpl, timeoutMs: 60_000 });

    const pending = rejectionReason(client.synthesize(REQUEST, caller.signal));
    await started;
    const call = fetchImpl.mock.calls[0]!;
    const requestSignal = call[1]?.signal;
    expect(call[0]).toBe("https://api.example.com/v1/audio/speech");
    expect(call[1]?.redirect).toBe("error");
    expect(call[1]?.method).toBe("POST");
    expect(requestSignal).toBeInstanceOf(AbortSignal);
    // 关键判据：传给 fetch 的必须是合并信号，而不是调用方信号本身。
    expect(requestSignal).not.toBe(caller.signal);
    expect(requestSignal?.aborted).toBe(false);

    caller.abort();

    const reason = await pending;
    expectAbortError(reason);
    expect(requestSignal?.aborted).toBe(true);
    expect(requestSignal?.reason).toBe(reason);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("退避等待期间取消也以 AbortError 结束，不折成 502", async () => {
    const caller = new AbortController();
    const fetchImpl = vi.fn<TtsFetch>(async () =>
      new Response("busy", { status: 429, headers: { "retry-after": "10" } }));
    const client = new OpenAiCompatibleTtsClient({ fetchImpl, timeoutMs: 5_000 });

    const pending = rejectionReason(client.synthesize(REQUEST, caller.signal));
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    // 让 synthesize 进入 10s 退避 sleep，再在等待期间取消。
    await new Promise((resolve) => setTimeout(resolve, 20));
    caller.abort();

    expectAbortError(await pending);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("Retry-After 秒数优先于指数退避", async () => {
    let calls = 0;
    const fetchImpl = vi.fn<TtsFetch>(async () => {
      calls += 1;
      return calls === 1
        ? new Response("busy", { status: 429, headers: { "retry-after": "1" } })
        : audioResponse([7]);
    });
    const client = new OpenAiCompatibleTtsClient({ fetchImpl, timeoutMs: 5_000 });

    const startedAt = performance.now();
    const bytes = await client.synthesize(REQUEST);
    const elapsed = performance.now() - startedAt;

    expect(Array.from(bytes)).toEqual([7]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // 指数退避首轮最多 500 + 250ms；>=900ms 只可能来自 Retry-After: 1。
    expect(elapsed, "Retry-After: 1 应等待约 1s，而非 500–749ms 的指数退避").toBeGreaterThanOrEqual(900);
  });

  it("content-length 超限时在读体前拒绝并释放连接", async () => {
    const response = new Response(new Uint8Array(1024), {
      status: 200,
      headers: { "content-type": "audio/mpeg", "content-length": "1024" },
    });
    const read = vi.spyOn(response, "arrayBuffer");
    const cancel = vi.spyOn(response.body!, "cancel");
    const fetchImpl = vi.fn<TtsFetch>(async () => response);
    const client = new OpenAiCompatibleTtsClient({ fetchImpl, timeoutMs: 1_000, maxBytes: 8 });

    await expect(client.synthesize(REQUEST)).rejects.toMatchObject({ status: 502 });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalled();
  });

  it("错误信息包含主机与状态，但不含密钥或完整 URL", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 401 }));
    const client = new OpenAiCompatibleTtsClient({ fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 1000 });

    const error = await failure(client.synthesize(REQUEST));

    expect(error).toMatchObject({ status: 502 });
    expect(error.message).toContain("api.example.com");
    expect(error.message).toContain("401");
    expect(error.message).not.toContain("secret-key");
    expect(error.message).not.toContain("https://");
    expect(error.message).not.toContain("/v1/audio/speech");
  });

  it("网络异常转为 502 且不回显底层错误", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("connect ECONNREFUSED https://api.example.com/v1/audio/speech");
    });
    const client = new OpenAiCompatibleTtsClient({ fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 1000 });

    const error = await failure(client.synthesize(REQUEST));

    expect(error).toMatchObject({ status: 502 });
    expect(error.message).toContain("api.example.com");
    expect(error.message).not.toContain("ECONNREFUSED");
    expect(error.message).not.toContain("secret-key");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("单次请求超时转为 502", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit): Promise<Response> =>
      await new Promise<Response>((_resolve, reject) => {
        if (init.signal?.aborted === true) {
          reject(init.signal.reason);
          return;
        }
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }));
    const client = new OpenAiCompatibleTtsClient({ fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 10 });

    await expect(client.synthesize(REQUEST)).rejects.toMatchObject({ status: 502 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
