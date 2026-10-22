import { createHash } from "node:crypto";
import type { FsTarget } from "@deepseek-ai/dsh-fs";
import { mapFsError, WorkspaceHttpError, type WorkspaceRealm } from "../workspace-route.js";
import {
  AUDIOBOOK_ROOT,
  AUDIOBOOK_SCHEMA_VERSION,
  type AudiobookAssetProviderReceipt,
  type AudiobookManifest,
  type AudiobookManifestFile,
  type AudiobookProjectRecord,
} from "./audiobook-contract.js";

/**
 * 有声剧发布包（N4-C）：发布目录、可复算校验和与 `发布/发布清单.json`。
 *
 * 清单是发布包的提交标记：只有所有 MP3/M4B/字幕/封面写完（Task 8 的顺序）才最后
 * 写它，读方据此判断包完整。`files[].path` 是包内相对路径（`发布/...`），清单
 * 本身落在工作区 `有声剧/<book>/发布/发布清单.json`。
 *
 * 原子性：`realm.fs` 没有 rename/remove 原语，而 `writeText` 在 dsh-fs-local 里
 * 已实现“临时文件 + rename”的原子发布，所以这里直接写最终路径、把沙箱策略作为
 * 第五参传入；本模块不碰 `node:fs`、不写宿主状态。
 */

const PROJECT_FILE = "project.json";
const RELEASE_DIRECTORY = "发布";
const MANIFEST_FILE = "发布清单.json";
const MANIFEST_MAX_BYTES = 512 * 1_024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

/** 清单写入的领域输入；`chapters`/`cost` 直接复用 manifest 的字段形状。 */
export interface AudiobookReleaseInput {
  readonly files: readonly AudiobookManifestFile[];
  readonly chapters: readonly AudiobookManifest["chapters"][number][];
  readonly cost: AudiobookManifest["cost"];
  readonly licenses?: readonly AudiobookManifest["licenses"][number][];
  readonly providerReceipts?: readonly AudiobookAssetProviderReceipt[];
  readonly checksum?: string;
}

function badRequest(message: string): WorkspaceHttpError {
  return new WorkspaceHttpError(400, message);
}

function unprocessable(message: string): WorkspaceHttpError {
  return new WorkspaceHttpError(422, message);
}

function hasControlCharacter(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function invalidProjectPath(): WorkspaceHttpError {
  return badRequest(`有声剧项目路径必须是 ${AUDIOBOOK_ROOT}/<书>/${PROJECT_FILE}。`);
}

/** 项目路径必须是 `有声剧/<书>/project.json`：只从中取书目录，别的一律 400。 */
function bookDirectoryOf(projectPath: string): string {
  const path = projectPath.trim();
  const segments = path.split("/");
  if (path === "" || path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/u.test(path) || segments.length !== 3) {
    throw invalidProjectPath();
  }
  const [root, book, file] = segments;
  if (root !== AUDIOBOOK_ROOT || file !== PROJECT_FILE || book === undefined || book === "" || book === "." || book === ".." || hasControlCharacter(book)) {
    throw invalidProjectPath();
  }
  return `${AUDIOBOOK_ROOT}/${book}`;
}

/**
 * 发布目录的唯一构造点：`有声剧/<书>/发布`。只做路径推导，不读不写；规范项目
 * 路径之外的输入（绝对路径、盘符、反斜杠、多段嵌套、错文件名）一律 400。
 */
export function releaseDirectoryFor(projectPath: string): string {
  return `${bookDirectoryOf(projectPath)}/${RELEASE_DIRECTORY}`;
}

const comparePaths = (left: string, right: string): number => left.localeCompare(right, "zh-Hans-CN");

/** 包内相对路径：以 `发布/` 开头，且不含绝对路径、盘符、反斜杠、空段、`.`/`..` 与控制字符。 */
function packagePathOrNull(raw: string): string | null {
  const text = raw.trim();
  if (text === "" || text.startsWith("/") || text.includes("\\") || /^[A-Za-z]:/u.test(text)) return null;
  const segments = text.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".." || hasControlCharacter(segment))) return null;
  if (segments.length < 2 || segments[0] !== RELEASE_DIRECTORY) return null;
  return text;
}

/** 单个清单文件条目：路径、摘要、字节数、时长全部校验后才进入清单。 */
function manifestFile(value: AudiobookManifestFile, index: number): AudiobookManifestFile {
  const label = `files[${index}]`;
  if (typeof value.path !== "string") throw badRequest(`${label}.path 必须是字符串路径。`);
  const path = packagePathOrNull(value.path);
  if (path === null) throw badRequest(`${label}.path 必须是 ${RELEASE_DIRECTORY}/ 下的包内相对路径。`);
  if (typeof value.sha256 !== "string" || !SHA256_PATTERN.test(value.sha256)) {
    throw badRequest(`${label}.sha256 必须是 64 位小写十六进制。`);
  }
  if (typeof value.bytes !== "number" || !Number.isInteger(value.bytes) || value.bytes < 0) {
    throw badRequest(`${label}.bytes 必须是非负整数。`);
  }
  if (value.durationMs !== null && (typeof value.durationMs !== "number" || !Number.isFinite(value.durationMs) || value.durationMs < 0)) {
    throw badRequest(`${label}.durationMs 必须是 null 或有限的非负数字。`);
  }
  return { path, bytes: value.bytes, sha256: value.sha256, durationMs: value.durationMs };
}

/** 归一化并排序文件条目；重复路径说明清单自相矛盾，按 422 拒绝。 */
function manifestFiles(files: readonly AudiobookManifestFile[]): AudiobookManifestFile[] {
  const seen = new Set<string>();
  const normalized = files.map((file, index) => {
    const entry = manifestFile(file, index);
    if (seen.has(entry.path)) throw unprocessable(`发布文件路径重复：${entry.path}`);
    seen.add(entry.path);
    return entry;
  });
  return normalized.sort((left, right) => comparePaths(left.path, right.path));
}

/**
 * 可复算校验和：按 `path`（`localeCompare(..., "zh-Hans-CN")`）稳定排序，每条取
 * `path\0sha256` 用 `\n` 连接后对 UTF-8 文本取 sha256，末尾不加换行。
 *
 * 只依赖 path 与 sha256：校验和语义本来就只覆盖这两个字段，调用方不必先凑齐
 * bytes/durationMs 才能预先算摘要。
 */
export function manifestChecksum(files: readonly Pick<AudiobookManifestFile, "path" | "sha256">[]): string {
  const text = [...files]
    .sort((left, right) => comparePaths(left.path, right.path))
    .map((file) => `${file.path}\u0000${file.sha256}`)
    .join("\n");
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 解析清单目标并确认它仍在工作区内；离开工作区按 403 处理。 */
async function resolveInside(realm: WorkspaceRealm, path: string): Promise<FsTarget> {
  const target = await realm.fs.resolve(path, { cwd: realm.cwd });
  if (!realm.fs.contains(realm.root, target)) throw new WorkspaceHttpError(403, "发布清单路径离开了 DSH 工作目录。");
  return target;
}

/**
 * 写 `有声剧/<book>/发布/发布清单.json`：先校验并排序文件、复算 checksum，
 * 再按 2 空格缩进 + 末尾换行序列化（超过 512 KiB 返回 413），最后经沙箱策略
 * 一次性发布；任何失败都不留下半截文件（`writeText` 自身原子替换）。
 *
 * `generatedAt` 每次写入都取当前时间；`cast` 从项目快照投影，`licenses` 与
 * `providerReceipts` 缺省为空数组。调用方提供的 `checksum` 必须与复算结果
 * 一致，否则说明清单与已写出的文件不同源，按 422 拒绝。
 */
export async function writeReleaseManifest(
  realm: WorkspaceRealm,
  project: AudiobookProjectRecord,
  input: AudiobookReleaseInput,
): Promise<{ path: string; manifest: AudiobookManifest }> {
  const bookDirectory = bookDirectoryOf(project.path);
  const directory = `${bookDirectory}/${RELEASE_DIRECTORY}`;
  const files = manifestFiles(input.files);
  const checksum = manifestChecksum(files);
  if (input.checksum !== undefined && input.checksum.trim().toLowerCase() !== checksum) {
    throw unprocessable("发布清单 checksum 与文件列表复算结果不一致。");
  }
  const manifest: AudiobookManifest = {
    schemaVersion: AUDIOBOOK_SCHEMA_VERSION,
    generatedAt: Date.now(),
    book: bookDirectory.slice(`${AUDIOBOOK_ROOT}/`.length),
    projectVersion: project.version,
    files,
    chapters: input.chapters,
    cast: project.project.cast.map((member) => ({ id: member.id, name: member.name, voice: member.voice })),
    licenses: input.licenses ?? [],
    providerReceipts: input.providerReceipts ?? [],
    cost: input.cost,
    checksum,
  };
  const serialized = `${JSON.stringify(manifest, undefined, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MANIFEST_MAX_BYTES) {
    throw new WorkspaceHttpError(413, "发布清单超过 512 KiB 大小限制。");
  }
  const path = `${directory}/${MANIFEST_FILE}`;
  const target = await resolveInside(realm, path);
  try {
    await realm.fs.writeText(target, serialized, undefined, undefined, realm.sandboxPolicy.resolve({ session: realm.agent.session }));
  } catch (error) {
    throw mapFsError(error) ?? new WorkspaceHttpError(500, "发布清单写入失败。");
  }
  return { path, manifest };
}
