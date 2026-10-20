import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { FsTarget } from "@deepseek-ai/dsh-fs";
import type { WorkspaceRealm } from "../workspace-route.js";

/**
 * 有声剧二进制存储：把 `FsTarget` 映射到可读写字节的位置。
 *
 * DSH 的 `realm.fs` 只提供文本读写，音频与候选缓存必须走字节通道：生产环境用
 * `realm.fs.processPath` 得到执行世界的绝对路径后交给 `node:fs/promises`，
 * 测试环境用内存 Map（键为 `target.displayPath`）替代，与工作台路由里的工作区
 * 相对路径一致。所有目标仍由调用方先经 `realm.fs.resolve` 解析，这里不解析
 * 用户输入，也不负责路径越界判断。
 */

export interface BinaryFileStore {
  /** 执行世界里的绝对路径，供子进程/ffmpeg 等外部能力打开同一文件。 */
  processPath(target: FsTarget): string;
  /** 预建父目录，允许调用方在写入前一次性准备缓存目录。 */
  prepare(target: FsTarget): Promise<void>;
  write(target: FsTarget, bytes: Uint8Array): Promise<void>;
  /** 目标缺失或超过 `maxBytes` 时返回 undefined，不抛错。 */
  read(target: FsTarget, maxBytes: number): Promise<Uint8Array | undefined>;
  stat(target: FsTarget): Promise<{ readonly size: number } | undefined>;
  rename(from: FsTarget, to: FsTarget): Promise<void>;
  /** 删除目标；目标缺失不算错误。 */
  remove(target: FsTarget): Promise<void>;
}

/** 宿主文件系统实现：路径来自当前 realm 的执行世界。 */
export function hostBinaryFileStore(realm: WorkspaceRealm): BinaryFileStore {
  return {
    processPath: (target) => realm.fs.processPath(target),
    prepare: async (target) => {
      await mkdir(dirname(realm.fs.processPath(target)), { recursive: true });
    },
    write: async (target, bytes) => {
      await mkdir(dirname(realm.fs.processPath(target)), { recursive: true });
      await writeFile(realm.fs.processPath(target), bytes);
    },
    read: async (target, maxBytes) => {
      const path = realm.fs.processPath(target);
      const info = await stat(path).catch(() => undefined);
      if (info === undefined || info.size > maxBytes) return undefined;
      return await readFile(path);
    },
    stat: async (target) => {
      const info = await stat(realm.fs.processPath(target)).catch(() => undefined);
      return info === undefined ? undefined : { size: info.size };
    },
    rename: async (from, to) => {
      await rename(realm.fs.processPath(from), realm.fs.processPath(to));
    },
    remove: async (target) => {
      await rm(realm.fs.processPath(target), { force: true });
    },
  };
}

/** 内存实现：`files` 公开给测试，键与 `processPath` 相同（工作区展示路径）。 */
export interface MemoryBinaryFileStore extends BinaryFileStore {
  readonly files: Map<string, Uint8Array>;
}

export function memoryBinaryFileStore(): MemoryBinaryFileStore {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    processPath: (target) => target.displayPath,
    prepare: () => Promise.resolve(),
    write: (target, bytes) => {
      files.set(target.displayPath, bytes.slice());
      return Promise.resolve();
    },
    read: (target, maxBytes) => {
      const bytes = files.get(target.displayPath);
      if (bytes === undefined || bytes.byteLength > maxBytes) return Promise.resolve(undefined);
      return Promise.resolve(bytes.slice());
    },
    stat: (target) => {
      const bytes = files.get(target.displayPath);
      return Promise.resolve(bytes === undefined ? undefined : { size: bytes.byteLength });
    },
    rename: (from, to) => {
      const bytes = files.get(from.displayPath);
      if (bytes === undefined) return Promise.reject(new Error("二进制文件不存在。"));
      files.delete(from.displayPath);
      files.set(to.displayPath, bytes);
      return Promise.resolve();
    },
    remove: (target) => {
      files.delete(target.displayPath);
      return Promise.resolve();
    },
  };
}
