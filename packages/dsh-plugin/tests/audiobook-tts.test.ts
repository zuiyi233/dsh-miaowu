import { describe, expect, it, vi } from "vitest";
import { WorkspaceHttpError } from "../src/workspace-route.js";
import { buildTtsRequest, OpenAiCompatibleTtsClient, type TtsFetch, type TtsRequest } from "../src/services/audiobook-tts.js";

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
      new Response("busy", { status: 429 }),
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
    expect(error.message).toContain("3");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("请求携带 redirect: error 与合并后的超时信号", async () => {
    const fetchImpl = vi.fn<TtsFetch>(async () => audioResponse([1]));
    const client = new OpenAiCompatibleTtsClient({ fetchImpl, timeoutMs: 1000 });
    const caller = new AbortController();

    await client.synthesize(REQUEST, caller.signal);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = fetchImpl.mock.calls[0]!;
    expect(call[0]).toBe("https://api.example.com/v1/audio/speech");
    expect(call[1]?.redirect).toBe("error");
    expect(call[1]?.method).toBe("POST");
    expect(call[1]?.signal).toBeInstanceOf(AbortSignal);
    caller.abort();
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
