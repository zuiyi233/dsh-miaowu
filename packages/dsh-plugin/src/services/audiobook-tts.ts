import { setTimeout as sleepTimer } from "node:timers/promises";
import { WorkspaceHttpError } from "../workspace-route.js";
import type { AudiobookTtsConfig } from "./audiobook-contract.js";
import { validateTtsBaseUrl } from "./audiobook-project.js";

/**
 * OpenAI-compatible TTS 客户端。
 *
 * 单次合成只发送 `model`/`input`/`voice`/`response_format`/`speed` 五个标准字段，
 * 密钥只进 `Authorization` 请求头，永不落盘、永不进 body、永不进错误信息。
 * 端点沿用项目服务的 `validateTtsBaseUrl`（仅 https 或回环 http，禁止凭证、
 * query 与 hash）。重试只覆盖 408/429/5xx，最多 3 次，指数退避加抖动；每次
 * 请求都有独立超时，并与调用方的取消信号合并。非音频、空音频、超限音频与
 * 不可重试的 HTTP 状态一律折成 502，错误信息只带主机、状态、模型与尝试次数。
 */

const TTS_ENDPOINT_SUFFIX = "/audio/speech";
const TTS_KEY_ENV = "OH_STORY_TTS_API_KEY";
const MAX_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BYTES = 50 * 1_024 * 1_024;
const MAX_RETRY_AFTER_MS = 10_000;
const BASE_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 8_000;
const RETRY_JITTER_MS = 250;

/** 合成单段只需要项目 TTS 配置里与请求相关的字段。 */
export type TtsRequestConfig = Pick<AudiobookTtsConfig, "baseUrl" | "model" | "responseFormat" | "speed">;

/** TTS 密钥的运行时来源；生产传 `process.env`，测试传字面量。 */
export interface TtsEnv {
  readonly OH_STORY_TTS_API_KEY?: string | undefined;
}

export interface TtsRequest extends TtsRequestConfig {
  readonly voice: string;
  readonly text: string;
  readonly apiKey: string;
}

export interface TtsClient {
  synthesize(request: TtsRequest, signal?: AbortSignal): Promise<Uint8Array>;
}

/** 结构最小化的 fetch 抽象：默认走全局 fetch，测试注入假实现。 */
export type TtsFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface OpenAiCompatibleTtsClientOptions {
  readonly fetchImpl?: TtsFetch;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status < 600);
}

function backoffDelayMs(attempt: number): number {
  const exponential = Math.min(BASE_RETRY_DELAY_MS * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
  return exponential + Math.floor(Math.random() * RETRY_JITTER_MS);
}

/** `Retry-After` 支持秒数与 HTTP 日期，上限 10s；无法解析时交给指数退避。 */
function parseRetryAfterMs(header: string | null, now: number = Date.now()): number | undefined {
  const value = header?.trim() ?? "";
  if (value === "") return undefined;
  if (/^\d+$/u.test(value)) return Math.min(Number(value) * 1_000, MAX_RETRY_AFTER_MS);
  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  return Math.min(Math.max(at - now, 0), MAX_RETRY_AFTER_MS);
}

async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await sleepTimer(ms, undefined, signal === undefined ? {} : { signal });
}

/** 丢弃响应体以释放连接；丢弃失败不改变调用方的错误语义。 */
async function discardBody(response: Response): Promise<void> {
  if (response.body === null) return;
  await response.body.cancel().catch(() => undefined);
}

/**
 * 构建一次 `/audio/speech` 请求：校验并归一化基址、要求运行时密钥、只拼标准
 * 字段，`Authorization` 只放在请求头里。
 */
export function buildTtsRequest(
  config: TtsRequestConfig,
  env: TtsEnv,
  text: string,
  voice: string,
): { url: string; init: RequestInit } {
  const apiKey = (env.OH_STORY_TTS_API_KEY ?? "").trim();
  if (apiKey === "") throw new WorkspaceHttpError(503, `缺少 TTS API 密钥（${TTS_KEY_ENV}）。`);
  const baseUrl = validateTtsBaseUrl(config.baseUrl).replace(/\/+$/u, "");
  return {
    url: `${baseUrl}${TTS_ENDPOINT_SUFFIX}`,
    init: {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        input: text,
        voice,
        response_format: config.responseFormat,
        speed: config.speed,
      }),
    },
  };
}

export class OpenAiCompatibleTtsClient implements TtsClient {
  private readonly fetchImpl: TtsFetch;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;

  constructor(options: OpenAiCompatibleTtsClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  async synthesize(request: TtsRequest, signal?: AbortSignal): Promise<Uint8Array> {
    const { url, init } = buildTtsRequest(
      request,
      { OH_STORY_TTS_API_KEY: request.apiKey },
      request.text,
      request.voice,
    );
    const host = new URL(url).host;
    for (let attempt = 1; ; attempt += 1) {
      const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
      const requestSignal = signal === undefined
        ? timeoutSignal
        : AbortSignal.any([signal, timeoutSignal]);
      let response: Response;
      try {
        response = await this.fetchImpl(url, { ...init, signal: requestSignal });
      } catch (error) {
        if (signal?.aborted === true) throw error;
        if (timeoutSignal.aborted) {
          throw new WorkspaceHttpError(502, `TTS 请求超时（${host}，模型 ${request.model}，第 ${attempt} 次尝试）。`);
        }
        throw new WorkspaceHttpError(502, `TTS 网络请求失败（${host}，模型 ${request.model}，第 ${attempt} 次尝试）。`);
      }
      if (response.ok) {
        return await this.readAudio(response, host, request.model, signal, timeoutSignal);
      }
      if (!isRetryableStatus(response.status) || attempt >= MAX_ATTEMPTS) {
        await discardBody(response);
        throw new WorkspaceHttpError(
          502,
          `TTS 服务返回 HTTP ${response.status}（${host}，模型 ${request.model}，第 ${attempt} 次尝试）。`,
        );
      }
      const retryAfter = parseRetryAfterMs(response.headers.get("retry-after"));
      await discardBody(response);
      await pause(retryAfter ?? backoffDelayMs(attempt), signal);
    }
  }

  private async readAudio(
    response: Response,
    host: string,
    model: string,
    signal: AbortSignal | undefined,
    timeoutSignal: AbortSignal,
  ): Promise<Uint8Array> {
    const contentType = (response.headers.get("content-type") ?? "").trim().toLowerCase();
    if (!contentType.startsWith("audio/")) {
      await discardBody(response);
      throw new WorkspaceHttpError(502, `TTS 服务返回了非音频响应（HTTP ${response.status}，${host}，模型 ${model}）。`);
    }
    const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
    if (Number.isFinite(declared) && declared > this.maxBytes) {
      await discardBody(response);
      throw new WorkspaceHttpError(502, `TTS 音频超过 ${this.maxBytes} 字节上限（HTTP ${response.status}，${host}，模型 ${model}）。`);
    }
    let buffer: ArrayBuffer;
    try {
      buffer = await response.arrayBuffer();
    } catch (error) {
      if (signal?.aborted === true) throw error;
      if (timeoutSignal.aborted) {
        throw new WorkspaceHttpError(502, `读取 TTS 音频超时（${host}，模型 ${model}）。`);
      }
      throw new WorkspaceHttpError(502, `读取 TTS 音频失败（${host}，模型 ${model}）。`);
    }
    if (buffer.byteLength === 0) {
      throw new WorkspaceHttpError(502, `TTS 服务返回了空音频（HTTP ${response.status}，${host}，模型 ${model}）。`);
    }
    if (buffer.byteLength > this.maxBytes) {
      throw new WorkspaceHttpError(502, `TTS 音频超过 ${this.maxBytes} 字节上限（HTTP ${response.status}，${host}，模型 ${model}）。`);
    }
    return new Uint8Array(buffer);
  }
}
