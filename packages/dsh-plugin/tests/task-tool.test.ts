import type { FileSystem, FsDirEntry, FsInfo, FsTarget, FsVersion } from "@deepseek-ai/dsh-fs";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { describe, expect, it } from "vitest";
import { checkpointRunRecord, loadCandidates, loadRuns, stageCandidateRecord } from "../src/services/tasks.js";
import { createOhStoryTaskTool, OH_STORY_TASK_OPS, OH_STORY_TASK_STATUSES, OH_STORY_TASK_TOOL_NAME } from "../src/task-tool.js";
import type { WorkspaceRealm } from "../src/workspace-route.js";

type MemoryFs = Pick<
  FileSystem,
  "resolve" | "contains" | "stat" | "listDir" | "readBytes" | "writeText"
>;

interface MemoryFile {
  content: string;
  version: string;
}

function versionOf(raw: string): FsVersion {
  return raw as unknown as FsVersion;
}

function targetOf(path: string): FsTarget {
  return { targetKey: path as FsTarget["targetKey"], displayPath: path };
}

function memoryFs(seed: Readonly<Record<string, string>> = {}): { fs: MemoryFs; files: Map<string, MemoryFile> } {
  const files = new Map<string, MemoryFile>();
  let clock = 1;
  for (const [path, content] of Object.entries(seed)) files.set(path, { content, version: `v${String(clock++)}` });

  const normalize = (path: string, cwd?: string): string => {
    const cwdParts = (cwd ?? "").replace(/^\/+/, "").split("/").filter((part) => part !== "");
    const parts: string[] = path.startsWith("/") ? [] : [...cwdParts];
    for (const segment of path.split("/")) {
      if (segment === "" || segment === ".") continue;
      if (segment === "..") parts.pop();
      else parts.push(segment);
    }
    return parts.join("/");
  };

  const infoOf = (path: string): FsInfo | undefined => {
    if (files.has(path)) {
      const file = files.get(path)!;
      return { version: versionOf(file.version), type: "file", size: Buffer.byteLength(file.content) };
    }
  };

  return {
    fs: {
      resolve: async (path: string, options?: { readonly cwd?: string }): Promise<FsTarget> =>
        targetOf(normalize(path, options?.cwd)),
      contains: (parent: FsTarget, child: FsTarget): boolean => {
        if (parent.displayPath === "") return true;
        const root = parent.displayPath.replace(/^\/+/, "").replace(/\/+$/, "");
        const candidate = child.displayPath.replace(/^\/+/, "");
        return candidate === root || candidate.startsWith(`${root}/`);
      },
      stat: async (target: FsTarget): Promise<FsInfo | undefined> =>
        infoOf(target.displayPath.replace(/^\/+/, "")),
      listDir: async (target: FsTarget): Promise<FsDirEntry[]> => {
        const dir = target.displayPath.replace(/^\/+/, "").replace(/\/+$/, "");
        const prefix = dir === "" ? "" : `${dir}/`;
        const children = new Map<string, { type: "file" | "directory"; target: FsTarget }>();
        for (const key of files.keys()) {
          if (!key.startsWith(prefix)) continue;
          const rest = key.slice(prefix.length);
          const slash = rest.indexOf("/");
          if (slash < 0) children.set(rest, { type: "file", target: targetOf(key) });
          else {
            const name = rest.slice(0, slash);
            if (name !== "" && !children.has(name)) children.set(name, { type: "directory", target: targetOf(`${prefix}${name}`) });
          }
        }
        return [...children.entries()].map(([name, entry]) => ({ name, type: entry.type, target: entry.target }));
      },
      readBytes: async (target: FsTarget, _signal: AbortSignal | undefined, _max: number): Promise<Uint8Array> => {
        void _signal;
        void _max;
        const file = files.get(target.displayPath.replace(/^\/+/, ""));
        if (file === undefined) {
          const error = new Error("FS_NOT_FOUND") as Error & { code?: string };
          error.code = "FS_NOT_FOUND";
          throw error;
        }
        return new TextEncoder().encode(file.content);
      },
      writeText: async (
        target: FsTarget,
        content: string,
        conditions?: { readonly kind: string; readonly version?: unknown }
      ) => {
        const path = target.displayPath.replace(/^\/+/, "");
        const before = files.get(path);
        const wanted = (conditions as { version?: unknown } | undefined)?.version;
        if (wanted !== undefined && before !== undefined && String(wanted) !== before.version) {
          const error = new Error("stale") as Error & { code?: string };
          error.code = "FS_STALE_VERSION";
          throw error;
        }
        const version = `v${String(clock++)}`;
        files.set(path, { content, version });
        return { operation: before === undefined ? "create" : "update", version: versionOf(version), before: before?.content ?? null, after: content } as const;
      },
    },
    files,
  };
}

const CWD = "/ws";
const WS = "ws";

function realmFor(fs: MemoryFs): WorkspaceRealm {
  return { agent: {}, fs: fs as unknown as FileSystem, sandboxPolicy: {}, cwd: CWD, root: targetOf(WS) } as unknown as WorkspaceRealm;
}

function fakeAgent(fs: MemoryFs): { session: { header: { cwd?: string } }; ctx: { get: (key: string) => unknown } } {
  return {
    session: { header: { cwd: CWD } },
    ctx: {
      get: (key: string): unknown => {
        if (key === "fs") return fs;
        if (key === "sandboxPolicy") return {};
        return undefined;
      }
    }
  };
}

describe("oh_story_task native tool", () => {
  it("declares the stage/checkpoint operations and checkpoint statuses", () => {
    const tool = createOhStoryTaskTool();
    expect(tool.name).toBe(OH_STORY_TASK_TOOL_NAME);
    expect(OH_STORY_TASK_OPS).toEqual(["stage_candidate", "checkpoint_run"]);
    expect(OH_STORY_TASK_STATUSES).toEqual(["running", "awaiting_user", "paused"]);
  });

  it("stages a candidate without writing any creative file", async () => {
    const { fs, files } = memoryFs({ "正文/第001章.md": "旧草稿" });
    const tool = createOhStoryTaskTool();
    const result = await tool.execute({
      op: "stage_candidate",
      kind: "novel-chapter",
      title: "第001章 重写建议",
      payload: { target: "正文/第001章.md", content: "新草稿" }
    }, { agent: fakeAgent(fs) } as unknown as ToolRunContext);
    expect(result).toEqual(expect.objectContaining({ op: "stage_candidate", status: "proposed" }));
    expect(files.get("正文/第001章.md")?.content).toBe("旧草稿");
    const candidates = await loadCandidates(realmFor(fs));
    const staged = candidates.find((item) => item.title === "第001章 重写建议");
    expect(staged).toBeDefined();
    expect(staged?.status).toBe("proposed");
    expect(staged?.payload).toEqual({ target: "正文/第001章.md", content: "新草稿" });
  });

  it("rejects staging without a title", async () => {
    const { fs } = memoryFs();
    const tool = createOhStoryTaskTool();
    await expect(tool.execute({ op: "stage_candidate", kind: "novel-chapter" }, { agent: fakeAgent(fs) } as unknown as ToolRunContext))
      .rejects.toThrow(/title/u);
  });

  it("rejects an operation outside the declared schema", async () => {
    const { fs } = memoryFs();
    const tool = createOhStoryTaskTool();
    await expect(tool.execute({ op: "explode", kind: "novel-chapter" }, { agent: fakeAgent(fs) } as unknown as ToolRunContext))
      .rejects.toThrow(/op/u);
  });

  it("checkpoints a new run into a resumable paused state", async () => {
    const { fs } = memoryFs();
    const tool = createOhStoryTaskTool();
    const result = await tool.execute({
      op: "checkpoint_run",
      kind: "novel-chapter",
      note: "第三章完成"
    }, { agent: fakeAgent(fs) } as unknown as ToolRunContext);
    const runId = (result as { runId?: string }).runId;
    expect(runId).toBeDefined();
    const runs = await loadRuns(realmFor(fs));
    const run = runs.find((item) => item.id === runId);
    expect(run?.status).toBe("paused");
    expect(run?.checkpoint).toEqual(expect.objectContaining({ note: "第三章完成" }));
  });

  it("checkpoints an existing run through running/paused transitions", async () => {
    const { fs } = memoryFs();
    const first = await checkpointRunRecord(realmFor(fs), { kind: "drama-batch", runId: undefined, meta: undefined, note: "分镜完成", status: "running" });
    expect(first.status).toBe("running");
    const paused = await checkpointRunRecord(realmFor(fs), { kind: "drama-batch", runId: first.id, meta: undefined, note: "生成中断", status: "paused" });
    expect(paused.id).toBe(first.id);
    expect(paused.status).toBe("paused");
    const resumed = await checkpointRunRecord(realmFor(fs), { kind: "drama-batch", runId: first.id, meta: undefined, note: "恢复后", status: "running" });
    expect(resumed.status).toBe("running");
    expect(resumed.resumeCount).toBe(0);
  });

  it("defaults a fresh checkpoint to paused without a terminal status", async () => {
    const { fs } = memoryFs();
    const run = await checkpointRunRecord(realmFor(fs), { kind: "novel-chapter", runId: undefined, meta: { chapter: 12 }, note: "第十二章", status: undefined });
    expect(run.status).toBe("paused");
    expect(run.meta).toEqual({ chapter: 12 });
    const again = await checkpointRunRecord(realmFor(fs), { kind: "novel-chapter", runId: run.id, meta: undefined, note: undefined, status: undefined });
    expect(again.status).toBe("paused");
  });
});

describe("service staging helpers shared with the panel route", () => {
  it("stages then persists a proposed candidate record", async () => {
    const { fs } = memoryFs();
    const candidate = await stageCandidateRecord(realmFor(fs), {
      kind: "game-content",
      title: "数值平衡建议",
      description: "把暴击率从 5% 调到 8%",
      payload: { target: "game-adaptations/demo/数值.md", content: "暴击率 8%" },
      target: "game-adaptations/demo/数值.md",
      runId: undefined
    });
    expect(candidate.status).toBe("proposed");
    expect(candidate.kind).toBe("game-content");
    const loaded = await loadCandidates(realmFor(fs));
    expect(loaded.some((item) => item.id === candidate.id)).toBe(true);
  });

  it("stages drama candidates into the same store the panel reads", async () => {
    const { fs, files } = memoryFs();
    const staged = await stageCandidateRecord(realmFor(fs), {
      kind: "drama-batch", title: "镜头候选", description: undefined,
      payload: { target: "剧集/EP001/分镜.md", content: "新分镜" }, target: "剧集/EP001/分镜.md", runId: undefined
    });
    expect((await loadCandidates(realmFor(fs))).some((item) => item.id === staged.id)).toBe(true);
    expect(files.has("剧集/EP001/分镜.md")).toBe(false);
  });

  it("isolates stores per workspace", async () => {
    const first = memoryFs();
    const second = memoryFs();
    await stageCandidateRecord(realmFor(first.fs), {
      kind: "novel-chapter", title: "仅在一号库", description: undefined,
      payload: {}, target: undefined, runId: undefined
    });
    const secondRealm = { cwd: "/ws/另一本", fs: second.fs as unknown as FileSystem, sandboxPolicy: {}, agent: {}, root: targetOf("另一本") } as unknown as WorkspaceRealm;
    expect(await loadCandidates(secondRealm)).toEqual([]);
  });
});