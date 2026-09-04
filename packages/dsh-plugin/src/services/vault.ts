import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import {
  jsonBody,
  send,
  workspaceRealm,
  WorkspaceHttpError,
  type WorkspaceRouteOptions,
} from "../workspace-route.js";
import { registerWorkspaceExtension } from "./registry.js";

/**
 * 功能 D5:可选凭据保险库(AES-256-GCM),默认关闭.
 * 参考 Scriverse credential-vault.ts(主密钥文件 + AES-GCM 加密存储)的思路,
 * 但本插件无 SQLite,主密钥与密文都落在工作区 `.oh-story/vault/` 下的 JSON/二进制文件.
 *
 * 默认关闭语义:仅当环境变量 `DSH_MIAOWU_VAULT_ENABLED=1` 时才工作;未启用时所有
 * 路由返回 403 且不落任何文件.本模块不触碰任何现有凭据路径(MIMO/FISH/keyring/
 * DSH 配置全部原样,仍走环境变量).
 *
 * 接线说明:本模块在顶层自注册 workspace 扩展(与 backup/tasks 等服务一致),
 * 但按本次任务的只读约束,未改动 `services/index.ts`;集成时在该文件加一行
 * `import "./vault.js";` 即可挂载路由(默认关闭,不影响现有行为).
 */

const VAULT_ENABLED_ENV = "DSH_MIAOWU_VAULT_ENABLED";
const VAULT_ENABLED_VALUE = "1";
const VAULT_ROUTE_PREFIX = "/oh-story/vault";
const VAULT_DIR_NAME = ".oh-story/vault";
const MASTER_KEY_FILE_NAME = "master.key";
const SECRETS_FILE_NAME = "secrets.json";
const MASTER_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;
const GCM_CIPHER = "aes-256-gcm";
const VAULT_CIPHER_VERSION = 1;
const FILE_MODE_PRIVATE = 0o600;
const DIR_MODE_PRIVATE = 0o700;
const MAX_SECRET_NAME_CHARS = 128;
const MAX_SECRET_VALUE_CHARS = 65_536;
const SECRET_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/u;
const VAULT_DISABLED_MESSAGE = "凭据保险库未启用（DSH_MIAOWU_VAULT_ENABLED=1 开启）。";

/** AES-GCM 密文(JSON 可序列化):主密钥永不写入此类结构. */
export interface VaultCiphertext {
  readonly v: 1;
  readonly iv: string;
  readonly tag: string;
  readonly data: string;
}

/** 保险库三文件落盘位置(全部派生自会话 cwd,名称不进文件名,杜绝路径穿越). */
export interface VaultPaths {
  readonly dir: string;
  readonly keyPath: string;
  readonly storePath: string;
}

export interface VaultRotation {
  readonly key: Buffer;
  readonly entries: Record<string, VaultCiphertext>;
}

/** 开关判定(纯函数,env 可注入以便测试).仅严格 `"1"` 视为开启. */
export function isVaultEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[VAULT_ENABLED_ENV] === VAULT_ENABLED_VALUE;
}

export function vaultPaths(cwd: string): VaultPaths {
  const dir = join(cwd, VAULT_DIR_NAME);
  return { dir, keyPath: join(dir, MASTER_KEY_FILE_NAME), storePath: join(dir, SECRETS_FILE_NAME) };
}

function isVaultPath(pathname: string): boolean {
  return pathname === VAULT_ROUTE_PREFIX || pathname.startsWith(`${VAULT_ROUTE_PREFIX}/`);
}

function assertMasterKeyLength(key: Uint8Array): void {
  if (key.length !== MASTER_KEY_BYTES) throw new Error("主密钥长度必须为 32 字节。");
}

/** 32 字节随机主密钥. */
export function generateMasterKey(): Buffer {
  return randomBytes(MASTER_KEY_BYTES);
}

export function encryptSecret(key: Uint8Array, plaintext: string): VaultCiphertext {
  assertMasterKeyLength(key);
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv(GCM_CIPHER, key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    v: VAULT_CIPHER_VERSION,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

/** authTag 校验失败(篡改/错钥)时抛错,绝不返回脏明文. */
export function decryptSecret(key: Uint8Array, ciphertext: VaultCiphertext): string {
  assertMasterKeyLength(key);
  const decipher = createDecipheriv(GCM_CIPHER, key, Buffer.from(ciphertext.iv, "base64"));
  decipher.setAuthTag(Buffer.from(ciphertext.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext.data, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export function isVaultCiphertext(value: unknown): value is VaultCiphertext {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.v === VAULT_CIPHER_VERSION
    && typeof record.iv === "string" && record.iv !== ""
    && typeof record.tag === "string" && record.tag !== ""
    && typeof record.data === "string" && record.data !== "";
}

/** 凭据名白名单:只允许字母数字 `._-`,杜绝路径/注入字符. */
export function assertSecretName(name: string): void {
  if (name.length === 0 || name.length > MAX_SECRET_NAME_CHARS || !SECRET_NAME_PATTERN.test(name)) {
    throw new WorkspaceHttpError(400, "凭据名称只允许字母、数字、._-（≤128 字符）。");
  }
}

/** 内存中替换一条目(不可变);调用方负责落盘. */
export function setSecretEntry(
  entries: Readonly<Record<string, VaultCiphertext>>,
  name: string,
  ciphertext: VaultCiphertext
): Record<string, VaultCiphertext> {
  return { ...entries, [name]: ciphertext };
}

/** 内存中删除一条目(不可变,幂等语义由调用方体现). */
export function deleteSecretEntry(
  entries: Readonly<Record<string, VaultCiphertext>>,
  name: string
): { readonly entries: Record<string, VaultCiphertext>; readonly deleted: boolean } {
  if (entries[name] === undefined) return { entries: { ...entries }, deleted: false };
  const next: Record<string, VaultCiphertext> = {};
  for (const [entryName, ciphertext] of Object.entries(entries)) {
    if (entryName !== name) next[entryName] = ciphertext;
  }
  return { entries: next, deleted: true };
}

/**
 * 纯函数轮换:用旧密钥全量解密后再用新密钥加密,任一条目失败即抛错,
 * 调用方在拿到结果前不写盘——失败时旧密钥与旧密文天然保持可解.
 */
export function rotateVaultSecrets(
  oldKey: Uint8Array,
  entries: Readonly<Record<string, VaultCiphertext>>
): VaultRotation {
  const fresh = generateMasterKey();
  const next: Record<string, VaultCiphertext> = {};
  for (const [name, ciphertext] of Object.entries(entries)) {
    next[name] = encryptSecret(fresh, decryptSecret(oldKey, ciphertext));
  }
  return { key: fresh, entries: next };
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && (error as { readonly code?: unknown }).code === "ENOENT";
}

/** 0600/0700 仅尽力(Windows 下 chmod 无效也不报错). */
async function chmodBestEffort(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode);
  } catch {
    /* Windows 等平台忽略权限设置失败 */
  }
}

/** 读主密钥:缺文件返回 undefined(视为空保险库);长度非法则抛错(拒绝 silently 重建). */
export async function readMasterKey(keyPath: string): Promise<Buffer | undefined> {
  let raw: Buffer;
  try {
    raw = await readFile(keyPath);
  } catch (error) {
    if (isNotFoundError(error)) return undefined;
    throw error;
  }
  if (raw.length !== MASTER_KEY_BYTES) throw new Error("主密钥文件已损坏（长度非 32 字节），拒绝使用。");
  await chmodBestEffort(keyPath, FILE_MODE_PRIVATE);
  return raw;
}

/** 读或创建主密钥:不存在时生成 32 字节随机密钥落盘(0600 尽力). */
export async function readOrCreateMasterKey(keyPath: string): Promise<Buffer> {
  const existing = await readMasterKey(keyPath);
  if (existing !== undefined) return existing;
  await mkdir(dirname(keyPath), { recursive: true, mode: DIR_MODE_PRIVATE });
  const fresh = generateMasterKey();
  await writeFile(keyPath, fresh, { mode: FILE_MODE_PRIVATE });
  await chmodBestEffort(keyPath, FILE_MODE_PRIVATE);
  return fresh;
}

/** 读密文库:缺文件视为空;结构非法抛错(不静默丢数据).只含密文,无明文. */
export async function readSecretEntries(storePath: string): Promise<Record<string, VaultCiphertext>> {
  let text: string;
  try {
    text = await readFile(storePath, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) return {};
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("凭据存储文件已损坏（非 JSON）。");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("凭据存储文件已损坏（结构非法）。");
  }
  const entries: Record<string, VaultCiphertext> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (!isVaultCiphertext(value)) throw new Error(`凭据存储文件已损坏（条目 ${name} 非法）。`);
    entries[name] = value;
  }
  return entries;
}

/** 写密文库:tmp 写后 rename,避免半截文件. */
export async function writeSecretEntries(
  storePath: string,
  entries: Readonly<Record<string, VaultCiphertext>>
): Promise<void> {
  await mkdir(dirname(storePath), { recursive: true, mode: DIR_MODE_PRIVATE });
  const tempPath = `${storePath}.tmp`;
  await writeFile(tempPath, JSON.stringify(entries), { mode: FILE_MODE_PRIVATE });
  await chmodBestEffort(tempPath, FILE_MODE_PRIVATE);
  await rename(tempPath, storePath);
}

/** 就绪 = 主密钥存在且合法、目录可写.GET status 不创建任何文件,无副作用. */
export async function isVaultReady(paths: VaultPaths): Promise<boolean> {
  try {
    if (await readMasterKey(paths.keyPath) === undefined) return false;
    await access(paths.dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 轮换落盘:纯函数先行(解密失败直接抛,未动盘) → 暂存新密钥/新库 →
 * 备份旧密钥 → 装新密钥 → 装新库.收尾前任一步失败都把旧密钥拷回,
 * 且旧库此前未被改动——回滚后旧密钥保持可解.返回轮换条目数.
 */
export async function rotateVaultFiles(keyPath: string, storePath: string): Promise<number> {
  const oldKey = await readMasterKey(keyPath);
  if (oldKey === undefined) {
    throw new WorkspaceHttpError(404, "保险库尚未初始化（无主密钥），请先写入一条凭据。");
  }
  const entries = await readSecretEntries(storePath);
  const rotated = rotateVaultSecrets(oldKey, entries);
  await installRotatedVault(keyPath, storePath, rotated);
  return Object.keys(entries).length;
}

async function removeBestEffort(path: string): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch {
    /* 临时文件清理失败不影响轮换结论 */
  }
}

async function installRotatedVault(
  keyPath: string,
  storePath: string,
  rotated: VaultRotation
): Promise<void> {
  await mkdir(dirname(keyPath), { recursive: true, mode: DIR_MODE_PRIVATE });
  const keyTempPath = `${keyPath}.tmp`;
  const storeTempPath = `${storePath}.tmp`;
  const backupPath = `${keyPath}.bak`;
  await writeFile(keyTempPath, rotated.key, { mode: FILE_MODE_PRIVATE });
  await chmodBestEffort(keyTempPath, FILE_MODE_PRIVATE);
  await writeFile(storeTempPath, JSON.stringify(rotated.entries), { mode: FILE_MODE_PRIVATE });
  await chmodBestEffort(storeTempPath, FILE_MODE_PRIVATE);
  try {
    await copyFile(keyPath, backupPath);
    await rename(keyTempPath, keyPath);
    await rename(storeTempPath, storePath);
  } catch (error) {
    await copyFile(backupPath, keyPath).catch(() => undefined);
    throw error;
  }
  await removeBestEffort(backupPath);
  await removeBestEffort(keyTempPath);
  await removeBestEffort(storeTempPath);
}

async function handleVaultStatus(
  context: Context,
  url: URL,
  response: ServerResponse
): Promise<void> {
  const realm = await workspaceRealm(context, url);
  send(response, 200, { enabled: true, ready: await isVaultReady(vaultPaths(realm.cwd)) });
}

async function handleVaultCreateSecret(
  context: Context,
  request: IncomingMessage,
  url: URL,
  response: ServerResponse,
  options: WorkspaceRouteOptions
): Promise<void> {
  const realm = await workspaceRealm(context, url);
  const body = await jsonBody(request, options.maxBytes);
  if (typeof body.name !== "string") throw new WorkspaceHttpError(400, "缺少凭据名称。");
  assertSecretName(body.name);
  if (typeof body.value !== "string" || body.value === "") {
    throw new WorkspaceHttpError(400, "凭据值必须是非空字符串。");
  }
  if (body.value.length > MAX_SECRET_VALUE_CHARS) throw new WorkspaceHttpError(413, "凭据值超过长度限制。");
  const paths = vaultPaths(realm.cwd);
  const key = await readOrCreateMasterKey(paths.keyPath);
  await writeSecretEntries(paths.storePath, setSecretEntry(
    await readSecretEntries(paths.storePath),
    body.name,
    encryptSecret(key, body.value)
  ));
  send(response, 200, { name: body.name, enabled: true });
}

function querySecretName(url: URL): string {
  const name = url.searchParams.get("name");
  if (name === null || name === "") throw new WorkspaceHttpError(400, "缺少凭据名称。");
  assertSecretName(name);
  return name;
}

async function handleVaultReadSecret(
  context: Context,
  url: URL,
  response: ServerResponse
): Promise<void> {
  const name = querySecretName(url);
  const realm = await workspaceRealm(context, url);
  const paths = vaultPaths(realm.cwd);
  const key = await readMasterKey(paths.keyPath);
  const found = key === undefined ? undefined : (await readSecretEntries(paths.storePath))[name];
  if (key === undefined || found === undefined) throw new WorkspaceHttpError(404, "凭据不存在。");
  let value: string;
  try {
    value = decryptSecret(key, found);
  } catch {
    throw new WorkspaceHttpError(500, "凭据解密失败，数据可能已被篡改。");
  }
  send(response, 200, { name, value });
}

async function handleVaultDeleteSecret(
  context: Context,
  url: URL,
  response: ServerResponse
): Promise<void> {
  const name = querySecretName(url);
  const realm = await workspaceRealm(context, url);
  const paths = vaultPaths(realm.cwd);
  const outcome = deleteSecretEntry(await readSecretEntries(paths.storePath), name);
  if (outcome.deleted) await writeSecretEntries(paths.storePath, outcome.entries);
  send(response, 200, { name, deleted: outcome.deleted });
}

async function handleVaultRotate(
  context: Context,
  url: URL,
  response: ServerResponse
): Promise<void> {
  const realm = await workspaceRealm(context, url);
  const paths = vaultPaths(realm.cwd);
  send(response, 200, {
    rotated: true,
    count: await rotateVaultFiles(paths.keyPath, paths.storePath),
  });
}

function vaultRouteKind(pathname: string): "status" | "secrets" | "rotate" | "unknown" {
  if (pathname === `${VAULT_ROUTE_PREFIX}/status`) return "status";
  if (pathname === `${VAULT_ROUTE_PREFIX}/secrets`) return "secrets";
  if (pathname === `${VAULT_ROUTE_PREFIX}/rotate`) return "rotate";
  return "unknown";
}

async function dispatchVaultRequest(
  context: Context,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  options: WorkspaceRouteOptions
): Promise<boolean> {
  const method = request.method ?? "GET";
  const kind = vaultRouteKind(url.pathname);
  if (kind === "status" && method === "GET") {
    await handleVaultStatus(context, url, response);
    return true;
  }
  if (kind === "secrets" && method === "POST") {
    await handleVaultCreateSecret(context, request, url, response, options);
    return true;
  }
  if (kind === "secrets" && method === "GET") {
    await handleVaultReadSecret(context, url, response);
    return true;
  }
  if (kind === "secrets" && method === "DELETE") {
    await handleVaultDeleteSecret(context, url, response);
    return true;
  }
  if (kind === "rotate" && method === "POST") {
    await handleVaultRotate(context, url, response);
    return true;
  }
  if (kind === "unknown") throw new WorkspaceHttpError(404, "凭据保险库路由不存在。");
  throw new WorkspaceHttpError(405, "不支持的请求方法。");
}

/**
 * 扩展缝 HTTP 薄壳:非本前缀返回 false;其它全部先查开关,未启用 403 且不碰磁盘.
 * env 参数仅供测试注入,注册调用只传前四个参数(默认读 process.env 一次).
 */
export async function handleVaultRequest(
  context: Context,
  request: IncomingMessage,
  response: ServerResponse,
  options: WorkspaceRouteOptions,
  env: Record<string, string | undefined> = process.env
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (!isVaultPath(url.pathname)) return false;
  if (!isVaultEnabled(env)) {
    send(response, 403, { error: VAULT_DISABLED_MESSAGE, enabled: false });
    return true;
  }
  try {
    return await dispatchVaultRequest(context, request, response, url, options);
  } catch (error) {
    if (error instanceof WorkspaceHttpError) {
      send(response, error.status, { error: error.message });
      return true;
    }
    throw error;
  }
}

registerWorkspaceExtension({ name: "vault", handle: handleVaultRequest });
