import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { describe, expect, it } from "vitest";
import {
  createOhStoryProductionTool,
  persistProductionSequence,
  PRODUCTION_SEQUENCE_FILENAME,
  sequenceDocument,
  type ProductionSequenceRealm
} from "../src/production-tool.js";

interface MemoryFile {
  content: string;
}

function realmFor(seed: Readonly<Record<string, string>> = {}): { realm: ProductionSequenceRealm; files: Map<string, MemoryFile> } {
  const files = new Map<string, MemoryFile>(Object.entries(seed).map(([path, content]) => [path, { content }]));
  const normalize = (path: string, cwd?: string): string => {
    const base = (cwd ?? "").replace(/^\/+/, "").split("/").filter((part) => part !== "");
    const parts: string[] = path.startsWith("/") ? [] : [...base];
    for (const segment of path.split("/")) {
      if (segment === "" || segment === ".") continue;
      if (segment === "..") parts.pop();
      else parts.push(segment);
    }
    return parts.join("/");
  };
  const realm: ProductionSequenceRealm = {
    cwd: "/ws",
    root: { displayPath: "ws" } as ProductionSequenceRealm["root"],
    fs: {
      resolve: (path: string, options?: { readonly cwd?: string }) =>
        Promise.resolve({ displayPath: normalize(path, options?.cwd) } as ProductionSequenceRealm["root"]),
      contains: (parent, child): boolean => {
        const root = String((parent as { displayPath: string }).displayPath).replace(/\/+$/, "");
        const candidate = String((child as { displayPath: string }).displayPath);
        return candidate === root || candidate.startsWith(`${root}/`);
      },
      stat: (target) => {
        const path = String((target as { displayPath: string }).displayPath).replace(/^\/+/, "");
        if (files.has(path)) return Promise.resolve({ type: "file" } as never);
        const prefix = `${path}/`;
        for (const key of files.keys()) {
          if (key.startsWith(prefix)) return Promise.resolve({ type: "directory" } as never);
        }
        return Promise.resolve(undefined);
      },
      writeText: (target, content) => {
        const path = String((target as { displayPath: string }).displayPath).replace(/^\/+/, "");
        files.set(path, { content });
        return Promise.resolve({ operation: "create", version: "v1" } as never);
      }
    }
  };
  return { realm, files };
}

function exec(): ToolRunContext {
  return { signal: new AbortController().signal } as unknown as ToolRunContext;
}

const NOW = "2026-09-06T00:00:00.000Z";

describe("set_sequence 落盘", () => {
  it("冻结 schema 落盘：episode/shotIds/updatedAt", async () => {
    const { realm, files } = realmFor({ "ws/剧集/EP001/分镜.md": "# shot list" });
    const path = await persistProductionSequence(realm, "剧集/EP001", ["SHOT-EP001-001", "SHOT-EP001-002"], () => NOW);
    expect(path).toBe(`剧集/EP001/${PRODUCTION_SEQUENCE_FILENAME}`);
    expect(files.get("ws/剧集/EP001/_sequence.json")?.content).toBe(
      `${JSON.stringify(sequenceDocument("EP001", ["SHOT-EP001-001", "SHOT-EP001-002"], NOW))}\n`
    );
  });

  it("重复 set 覆盖旧顺序", async () => {
    const { realm, files } = realmFor({ "ws/剧集/EP001/分镜.md": "# shot list" });
    await persistProductionSequence(realm, "剧集/EP001", ["SHOT-EP001-001"], () => NOW);
    await persistProductionSequence(realm, "剧集/EP001", ["SHOT-EP001-002", "SHOT-EP001-001"], () => NOW);
    const parsed = JSON.parse(files.get("ws/剧集/EP001/_sequence.json")?.content ?? "{}") as { shotIds: string[] };
    expect(parsed.shotIds).toEqual(["SHOT-EP001-002", "SHOT-EP001-001"]);
  });

  it("EP 目录不存在显式报错", async () => {
    const { realm } = realmFor({});
    await expect(persistProductionSequence(realm, "剧集/EP999", ["SHOT-EP999-001"], () => NOW)).rejects.toThrow(/EP999/u);
  });

  it("tool 执行 set_sequence：落盘 + 返回文案追加已落盘", async () => {
    const { realm, files } = realmFor({ "ws/剧集/EP001/分镜.md": "# shot list" });
    const tool = createOhStoryProductionTool({ now: () => NOW, resolveSequenceRealm: () => Promise.resolve(realm) });
    const result = await tool.execute({
      action: "set_sequence",
      episode: "剧集/EP001",
      shotIds: ["SHOT-EP001-002", "SHOT-EP001-001"]
    }, exec()) as { message: string };
    expect(result.message).toContain("2 个镜头");
    expect(result.message).toContain(`已落盘 剧集/EP001/${PRODUCTION_SEQUENCE_FILENAME}`);
    expect(JSON.parse(files.get("ws/剧集/EP001/_sequence.json")?.content ?? "{}")).toEqual(
      sequenceDocument("EP001", ["SHOT-EP001-002", "SHOT-EP001-001"], NOW)
    );
  });

  it("无 realm 时退回纯投影：文案语义不变、不抛", async () => {
    const tool = createOhStoryProductionTool({ resolveSequenceRealm: () => Promise.resolve(undefined) });
    const result = await tool.execute({
      action: "set_sequence",
      episode: "剧集/EP001",
      shotIds: ["SHOT-EP001-001"]
    }, exec()) as { message: string };
    expect(result.message).toContain("1 个镜头");
    expect(result.message).not.toContain("已落盘");
  });
});
