// tests/audiobook-binary.test.ts
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FsTarget } from "@deepseek-ai/dsh-fs";
import { hostBinaryFileStore, memoryBinaryFileStore } from "../src/services/audiobook-binary.js";
import type { WorkspaceRealm } from "../src/workspace-route.js";

const target = (displayPath: string): FsTarget => ({ targetKey: displayPath as FsTarget["targetKey"], displayPath });
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** 宿主实现的 `processPath` 直接把展示路径当绝对路径用。 */
const hostStore = (): ReturnType<typeof hostBinaryFileStore> =>
  hostBinaryFileStore({ fs: { processPath: (value: FsTarget) => value.displayPath } } as unknown as WorkspaceRealm);

describe("audiobook binary", () => {
  it("内存实现 hash 稳定，copy 不改源", async () => {
    const store = memoryBinaryFileStore();
    const source = target(".oh-story/audiobook/cache/source.mp3");
    const destination = target(".oh-story/audiobook/tmp/destination.mp3");
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    await store.write(source, bytes);

    expect(await store.hash(source)).toBe(sha256(bytes));
    expect(await store.hash(source)).toBe(sha256(bytes));
    expect(await store.hash(destination)).toBeUndefined();

    await store.copy(source, destination);
    expect(await store.read(source, 1_024)).toEqual(bytes);
    expect(await store.read(destination, 1_024)).toEqual(bytes);
    expect(await store.hash(source)).toBe(sha256(bytes));

    // 复制必须是独立副本：改目标不能影响源。
    store.files.set(destination.displayPath, new Uint8Array([9]));
    expect(await store.read(source, 1_024)).toEqual(bytes);
  });

  it("宿主实现 hash 稳定，copy 不改源", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dsh-audiobook-binary-"));
    try {
      const store = hostStore();
      const sourcePath = join(directory, "source.bin");
      const destinationPath = join(directory, "nested", "destination.bin");
      const bytes = new Uint8Array([7, 8, 9, 10]);
      await writeFile(sourcePath, bytes);
      const source = target(sourcePath);
      const destination = target(destinationPath);

      expect(await store.hash(source)).toBe(sha256(bytes));
      expect(await store.hash(source)).toBe(sha256(bytes));
      expect(await store.hash(target(join(directory, "missing.bin")))).toBeUndefined();

      await store.copy(source, destination);
      expect(new Uint8Array(await readFile(sourcePath))).toEqual(bytes);
      expect(new Uint8Array(await readFile(destinationPath))).toEqual(bytes);
      expect(await store.hash(source)).toBe(sha256(bytes));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
