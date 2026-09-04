import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";
import {
  assertSecretName,
  decryptSecret,
  deleteSecretEntry,
  encryptSecret,
  generateMasterKey,
  handleVaultRequest,
  isVaultCiphertext,
  isVaultEnabled,
  readOrCreateMasterKey,
  rotateVaultSecrets,
  setSecretEntry,
  type VaultCiphertext,
} from "../src/services/vault.js";

const OPTIONS = { maxBytes: 2 * 1024 * 1024 };
const ENABLED = { DSH_MIAOWU_VAULT_ENABLED: "1" };
const DISABLED: Record<string, string | undefined> = {};

function tempCwd(): string {
  return mkdtempSync(join(tmpdir(), "dsh-vault-"));
}

function cleanup(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

function fakeContext(cwd: string): Context {
  const agent = {
    session: { header: { cwd } },
    ctx: { get: (key: string): unknown => (key === "fs" ? { resolve: async (): Promise<unknown> => ({}) } : {}) },
  };
  return {
    typert: { lookups: { get: () => ({ resolve: async (): Promise<unknown> => agent }) } },
    logger: () => (): void => undefined,
  } as unknown as Context;
}

function incoming(method: string, url: string, payload?: unknown): IncomingMessage {
  const body = payload === undefined ? "" : JSON.stringify(payload);
  const chunks = body === "" ? [] : [Buffer.from(body)];
  async function* stream(): AsyncIterable<Uint8Array> {
    for (const chunk of chunks) yield chunk;
  }
  const request = stream() as unknown as IncomingMessage;
  (request as { method: string }).method = method;
  (request as { url: string }).url = url;
  (request as { headers: Record<string, string> }).headers = {};
  return request;
}

interface Captured {
  status?: number;
  body?: unknown;
}

async function callVault(
  cwd: string,
  method: string,
  path: string,
  payload?: unknown,
  env: Record<string, string | undefined> = ENABLED
): Promise<Captured> {
  const captured: Captured = {};
  const response = {
    writeHead: (status: number): void => {
      captured.status = status;
    },
    end: (body?: string): void => {
      captured.body = body === undefined || body === "" ? undefined : (JSON.parse(body) as unknown);
    },
  } as unknown as ServerResponse;
  const separator = path.includes("?") ? "&" : "?";
  const handled = await handleVaultRequest(
    fakeContext(cwd),
    incoming(method, `${path}${separator}sessionId=test-session`, payload),
    response,
    OPTIONS,
    env
  );
  expect(handled).toBe(true);
  return captured;
}

function bodyOf<T>(captured: Captured): T {
  return captured.body as T;
}

describe("vault 开关判定", () => {
  it("仅 DSH_MIAOWU_VAULT_ENABLED=1 视为开启", () => {
    expect(isVaultEnabled({})).toBe(false);
    expect(isVaultEnabled({ DSH_MIAOWU_VAULT_ENABLED: undefined })).toBe(false);
    expect(isVaultEnabled({ DSH_MIAOWU_VAULT_ENABLED: "0" })).toBe(false);
    expect(isVaultEnabled({ DSH_MIAOWU_VAULT_ENABLED: "true" })).toBe(false);
    expect(isVaultEnabled({ DSH_MIAOWU_VAULT_ENABLED: "1" })).toBe(true);
  });
});

describe("vault AES-GCM 纯函数", () => {
  it("generateMasterKey 生成 32 字节且实例各异", () => {
    const first = generateMasterKey();
    const second = generateMasterKey();
    expect(first.length).toBe(32);
    expect(second.length).toBe(32);
    expect(first.equals(second)).toBe(false);
  });

  it("encrypt/decrypt roundtrip 且密文结构完整", () => {
    const key = generateMasterKey();
    const ciphertext = encryptSecret(key, "sk-secret-value");
    expect(isVaultCiphertext(ciphertext)).toBe(true);
    expect(ciphertext.v).toBe(1);
    expect(decryptSecret(key, ciphertext)).toBe("sk-secret-value");
  });

  it("密文只含 v/iv/tag/data 且不泄露明文", () => {
    const key = generateMasterKey();
    const ciphertext = encryptSecret(key, "sk-very-private-token");
    expect(Object.keys(ciphertext).sort()).toEqual(["data", "iv", "tag", "v"]);
    expect(JSON.stringify(ciphertext)).not.toContain("sk-very-private-token");
  });

  it("相同明文两次加密密文不同（随机 iv）", () => {
    const key = generateMasterKey();
    const first = encryptSecret(key, "same-plaintext");
    const second = encryptSecret(key, "same-plaintext");
    expect(first.iv).not.toBe(second.iv);
    expect(first.data).not.toBe(second.data);
    expect(decryptSecret(key, first)).toBe("same-plaintext");
    expect(decryptSecret(key, second)).toBe("same-plaintext");
  });

  it("篡改密文解密失败（authTag 防篡改）", () => {
    const key = generateMasterKey();
    const original = encryptSecret(key, "tamper-me");
    const flip = (value: string): string => (value[0] === "A" ? `B${value.slice(1)}` : `A${value.slice(1)}`);
    const tamperedData: VaultCiphertext = { ...original, data: flip(original.data) };
    const tamperedTag: VaultCiphertext = { ...original, tag: flip(original.tag) };
    const tamperedIv: VaultCiphertext = { ...original, iv: flip(original.iv) };
    expect(() => decryptSecret(key, tamperedData)).toThrow();
    expect(() => decryptSecret(key, tamperedTag)).toThrow();
    expect(() => decryptSecret(key, tamperedIv)).toThrow();
  });

  it("错钥解密失败", () => {
    const ciphertext = encryptSecret(generateMasterKey(), "wrong-key");
    expect(() => decryptSecret(generateMasterKey(), ciphertext)).toThrow();
  });

  it("readOrCreateMasterKey 幂等（创建后复用）", async () => {
    const cwd = tempCwd();
    try {
      const keyPath = join(cwd, ".oh-story", "vault", "master.key");
      const first = await readOrCreateMasterKey(keyPath);
      const second = await readOrCreateMasterKey(keyPath);
      expect(first.length).toBe(32);
      expect(first.equals(second)).toBe(true);
    } finally {
      cleanup(cwd);
    }
  });

  it("凭据名白名单拒绝非法名", () => {
    expect(() => assertSecretName("api.key-01")).not.toThrow();
    expect(() => assertSecretName("A.B_C-9")).not.toThrow();
    for (const bad of ["", "../escape", "a/b", "has space", "semi;colon", "x".repeat(129)]) {
      expect(() => assertSecretName(bad), bad).toThrow();
    }
  });

  it("内存条目 set/delete 不可变且删除幂等", () => {
    const key = generateMasterKey();
    const cipher = encryptSecret(key, "v");
    const entries = setSecretEntry({}, "a", cipher);
    expect(entries.a).toEqual(cipher);
    expect(deleteSecretEntry(entries, "missing").deleted).toBe(false);
    const removed = deleteSecretEntry(entries, "a");
    expect(removed.deleted).toBe(true);
    expect(removed.entries.a).toBeUndefined();
    expect(entries.a).toEqual(cipher);
  });

  it("rotateVaultSecrets 纯函数：旧密文新钥不可解、新密文明文一致", () => {
    const oldKey = generateMasterKey();
    const entries = { a: encryptSecret(oldKey, "alpha"), b: encryptSecret(oldKey, "beta") };
    const rotated = rotateVaultSecrets(oldKey, entries);
    expect(rotated.key.equals(oldKey)).toBe(false);
    expect(decryptSecret(rotated.key, rotated.entries.a as VaultCiphertext)).toBe("alpha");
    expect(decryptSecret(rotated.key, rotated.entries.b as VaultCiphertext)).toBe("beta");
    expect(() => decryptSecret(rotated.key, entries.a as VaultCiphertext)).toThrow();
    expect(() => decryptSecret(oldKey, rotated.entries.a as VaultCiphertext)).toThrow();
  });
});

describe("vault 路由（默认关闭）", () => {
  it("未启用时全部拒绝 403 且不落盘", async () => {
    const cwd = tempCwd();
    try {
      const status = await callVault(cwd, "GET", "/oh-story/vault/status", undefined, DISABLED);
      expect(status.status).toBe(403);
      expect(bodyOf<{ enabled: boolean }>(status).enabled).toBe(false);
      const created = await callVault(
        cwd, "POST", "/oh-story/vault/secrets", { name: "x", value: "y" }, DISABLED
      );
      expect(created.status).toBe(403);
      const read = await callVault(cwd, "GET", "/oh-story/vault/secrets?name=x", undefined, DISABLED);
      expect(read.status).toBe(403);
      const rotated = await callVault(cwd, "POST", "/oh-story/vault/rotate", undefined, DISABLED);
      expect(rotated.status).toBe(403);
      let leaked = false;
      try {
        readFileSync(join(cwd, ".oh-story", "vault", "master.key"), "utf8");
        leaked = true;
      } catch {
        leaked = false;
      }
      expect(leaked).toBe(false);
    } finally {
      cleanup(cwd);
    }
  });

  it("非保险库前缀返回 false（不拦截其它路由）", async () => {
    const cwd = tempCwd();
    try {
      const captured: Captured = {};
      const response = {
        writeHead: (status: number): void => {
          captured.status = status;
        },
        end: (): void => undefined,
      } as unknown as ServerResponse;
      const handled = await handleVaultRequest(
        fakeContext(cwd), incoming("GET", "/oh-story/workspace?sessionId=x"), response, OPTIONS, ENABLED
      );
      expect(handled).toBe(false);
    } finally {
      cleanup(cwd);
    }
  });
});

describe("vault 路由（启用后 secrets 增删查）", () => {
  it("status ready 语义：写前 false、写后 true", async () => {
    const cwd = tempCwd();
    try {
      const before = await callVault(cwd, "GET", "/oh-story/vault/status");
      expect(before.status).toBe(200);
      expect(bodyOf<{ enabled: boolean; ready: boolean }>(before)).toEqual({ enabled: true, ready: false });
      await callVault(cwd, "POST", "/oh-story/vault/secrets", { name: "k", value: "v" });
      const after = await callVault(cwd, "GET", "/oh-story/vault/status");
      expect(bodyOf<{ enabled: boolean; ready: boolean }>(after)).toEqual({ enabled: true, ready: true });
    } finally {
      cleanup(cwd);
    }
  });

  it("写入只存密文、返回不含 value；点名可读、无名 400、未知名 404", async () => {
    const cwd = tempCwd();
    try {
      const created = await callVault(cwd, "POST", "/oh-story/vault/secrets", { name: "mimo.key-01", value: "sk-live-token" });
      expect(created.status).toBe(200);
      expect(bodyOf<Record<string, unknown>>(created)).toEqual({ name: "mimo.key-01", enabled: true });
      const storeText = readFileSync(join(cwd, ".oh-story", "vault", "secrets.json"), "utf8");
      expect(storeText).not.toContain("sk-live-token");
      const stored = JSON.parse(storeText) as Record<string, VaultCiphertext>;
      expect(isVaultCiphertext(stored["mimo.key-01"])).toBe(true);
      const masterB64 = readFileSync(join(cwd, ".oh-story", "vault", "master.key")).toString("base64");
      expect(storeText).not.toContain(masterB64);
      const read = await callVault(cwd, "GET", "/oh-story/vault/secrets?name=mimo.key-01");
      expect(read.status).toBe(200);
      expect(bodyOf<{ name: string; value: string }>(read)).toEqual({ name: "mimo.key-01", value: "sk-live-token" });
      const noName = await callVault(cwd, "GET", "/oh-story/vault/secrets");
      expect(noName.status).toBe(400);
      const missing = await callVault(cwd, "GET", "/oh-story/vault/secrets?name=nope");
      expect(missing.status).toBe(404);
    } finally {
      cleanup(cwd);
    }
  });

  it("删除幂等：删后不可读、重复删除 deleted=false", async () => {
    const cwd = tempCwd();
    try {
      await callVault(cwd, "POST", "/oh-story/vault/secrets", { name: "temp", value: "v" });
      const first = await callVault(cwd, "DELETE", "/oh-story/vault/secrets?name=temp");
      expect(first.status).toBe(200);
      expect(bodyOf<{ deleted: boolean }>(first).deleted).toBe(true);
      const gone = await callVault(cwd, "GET", "/oh-story/vault/secrets?name=temp");
      expect(gone.status).toBe(404);
      const second = await callVault(cwd, "DELETE", "/oh-story/vault/secrets?name=temp");
      expect(bodyOf<{ deleted: boolean }>(second).deleted).toBe(false);
    } finally {
      cleanup(cwd);
    }
  });

  it("非法凭据名与空值被拒绝", async () => {
    const cwd = tempCwd();
    try {
      const bad = await callVault(cwd, "POST", "/oh-story/vault/secrets", { name: "../x", value: "v" });
      expect(bad.status).toBe(400);
      const empty = await callVault(cwd, "POST", "/oh-story/vault/secrets", { name: "ok", value: "" });
      expect(empty.status).toBe(400);
    } finally {
      cleanup(cwd);
    }
  });
});

describe("vault rotate", () => {
  it("空保险库 rotate 返回 404", async () => {
    const cwd = tempCwd();
    try {
      const response = await callVault(cwd, "POST", "/oh-story/vault/rotate");
      expect(response.status).toBe(404);
    } finally {
      cleanup(cwd);
    }
  });

  it("rotate 后旧密文失效、新密文可解、HTTP 仍可读", async () => {
    const cwd = tempCwd();
    try {
      await callVault(cwd, "POST", "/oh-story/vault/secrets", { name: "a", value: "alpha" });
      await callVault(cwd, "POST", "/oh-story/vault/secrets", { name: "b", value: "beta" });
      const keyPath = join(cwd, ".oh-story", "vault", "master.key");
      const storePath = join(cwd, ".oh-story", "vault", "secrets.json");
      const oldKey = readFileSync(keyPath);
      const oldStore = JSON.parse(readFileSync(storePath, "utf8")) as Record<string, VaultCiphertext>;
      const rotated = await callVault(cwd, "POST", "/oh-story/vault/rotate");
      expect(rotated.status).toBe(200);
      expect(bodyOf<{ rotated: boolean; count: number }>(rotated)).toEqual({ rotated: true, count: 2 });
      const newKey = readFileSync(keyPath);
      const newStore = JSON.parse(readFileSync(storePath, "utf8")) as Record<string, VaultCiphertext>;
      expect(newKey.equals(oldKey)).toBe(false);
      expect(decryptSecret(newKey, newStore.a as VaultCiphertext)).toBe("alpha");
      expect(decryptSecret(newKey, newStore.b as VaultCiphertext)).toBe("beta");
      expect(() => decryptSecret(newKey, oldStore.a as VaultCiphertext)).toThrow();
      expect(() => decryptSecret(oldKey, newStore.a as VaultCiphertext)).toThrow();
      const read = await callVault(cwd, "GET", "/oh-story/vault/secrets?name=a");
      expect(bodyOf<{ value: string }>(read).value).toBe("alpha");
    } finally {
      cleanup(cwd);
    }
  });
});
