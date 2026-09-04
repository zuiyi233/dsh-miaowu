import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import type { FileSystem, FsDirEntry, FsInfo, FsTarget, FsVersion } from "@deepseek-ai/dsh-fs";
import { describe, expect, it } from "vitest";
import {
  filterSnoozedReminders,
  handleForeshadowsRequest,
  importDedupeKey,
  isLegalForeshadowTransition,
  isSnoozed,
  mapAnalysisStatus,
  mapImportedForeshadow,
  parseListLimit,
  selectReminders,
  type Foreshadow,
  type SnoozeRecord,
} from "../src/services/foreshadows.js";
import type { WorkspaceRealm } from "../src/workspace-route.js";

type MemoryFs = Pick<
  FileSystem,
  "resolve" | "contains" | "stat" | "listDir" | "readBytes" | "writeText"
> & { processPath: (target: FsTarget) => string };

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

function normalize(path: string, cwd?: string): string {
  const cwdParts = (cwd ?? "").replace(/^\/+/, "").split("/").filter((part) => part !== "");
  const parts: string[] = path.startsWith("/") ? [] : [...cwdParts];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/");
}

function memoryFs(): { fs: MemoryFs; files: Map<string, MemoryFile> } {
  const files = new Map<string, MemoryFile>();
  let clock = 1;
  const infoOf = (path: string): FsInfo | undefined => {
    if (files.has(path)) {
      const file = files.get(path)!;
      return { version: versionOf(file.version), type: "file", size: Buffer.byteLength(file.content) };
    }
    const prefix = path === "" ? "" : `${path}/`;
    for (const key of files.keys()) {
      if (path === "" || key.startsWith(prefix)) return { version: versionOf("dir"), type: "directory" };
    }
    return undefined;
  };
  const fs: MemoryFs = {
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
    readBytes: async (target: FsTarget): Promise<Uint8Array> => {
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
    processPath: (target: FsTarget): string => target.displayPath,
  };
  return { fs, files };
}

// 每个用例独立 cwd 命名空间,服务无进程内缓存,天然隔离.
let caseClock = 0;
function isolatedCase(seed: Readonly<Record<string, string>> = {}): { fs: MemoryFs; files: Map<string, MemoryFile>; cwd: string } {
  caseClock += 1;
  const cwd = `/ws/case${String(caseClock)}`;
  const root = cwd.replace(/^\/+/, "");
  const { fs, files } = memoryFs();
  let clock = 1;
  for (const [path, content] of Object.entries(seed)) {
    files.set(`${root}/${path}`, { content, version: `seed-v${String(clock++)}` });
  }
  return { fs, files, cwd };
}

function fakeContext(fs: MemoryFs, cwd: string): Context {
  const agent = {
    session: { header: { cwd } },
    ctx: {
      get: (key: string): unknown => {
        if (key === "fs") return fs;
        if (key === "sandboxPolicy") return {};
        return undefined;
      },
    },
  };
  return {
    typert: { lookups: { get: () => ({ resolve: async (): Promise<unknown> => agent }) } },
    logger: () => (): void => undefined,
  } as unknown as Context;
}

function realmForCase(fs: MemoryFs, cwd: string): WorkspaceRealm {
  return {
    agent: {},
    fs: fs as unknown as FileSystem,
    sandboxPolicy: {},
    cwd,
    root: targetOf(cwd.replace(/^\/+/, "")),
  } as unknown as WorkspaceRealm;
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

interface CapturedResponse {
  status?: number;
  body?: unknown;
}

async function callForeshadows(
  fs: MemoryFs,
  cwd: string,
  method: string,
  path: string,
  payload?: unknown
): Promise<CapturedResponse> {
  const captured: CapturedResponse = {};
  const response = {
    writeHead: (status: number): void => { captured.status = status; },
    end: (body?: string): void => {
      captured.body = body === undefined || body === "" ? undefined : JSON.parse(body) as unknown;
    },
  } as unknown as ServerResponse;
  const separator = path.includes("?") ? "&" : "?";
  const handled = await handleForeshadowsRequest(
    fakeContext(fs, cwd),
    incoming(method, `${path}${separator}sessionId=${encodeURIComponent(cwd)}`, payload),
    response,
    { maxBytes: 2 * 1024 * 1024 }
  );
  expect(handled).toBe(true);
  return captured;
}

function bodyOf<T>(response: CapturedResponse): T {
  return response.body as T;
}

async function createItem(
  fs: MemoryFs,
  cwd: string,
  payload: Record<string, unknown>
): Promise<Foreshadow> {
  const created = await callForeshadows(fs, cwd, "POST", "/oh-story/foreshadows", payload);
  expect(created.status).toBe(200);
  return bodyOf<{ foreshadow: Foreshadow }>(created).foreshadow;
}

describe("foreshadows: pure helpers", () => {
  it("validates the planned->planted->resolved state machine", () => {
    expect(isLegalForeshadowTransition("planned", "planted")).toBe(true);
    expect(isLegalForeshadowTransition("planted", "resolved")).toBe(true);
    expect(isLegalForeshadowTransition("planned", "resolved")).toBe(false);
    expect(isLegalForeshadowTransition("planned", "abandoned")).toBe(true);
    expect(isLegalForeshadowTransition("planted", "abandoned")).toBe(true);
    expect(isLegalForeshadowTransition("resolved", "abandoned")).toBe(false);
    expect(isLegalForeshadowTransition("abandoned", "planned")).toBe(false);
    expect(isLegalForeshadowTransition("resolved", "planted")).toBe(false);
    expect(isLegalForeshadowTransition("planted", "planned")).toBe(false);
    expect(isLegalForeshadowTransition("planned", "planned")).toBe(true);
    expect(isLegalForeshadowTransition("resolved", "resolved")).toBe(true);
  });

  it("maps A3 sidecar statuses and entries", () => {
    expect(mapAnalysisStatus("resolved")).toBe("resolved");
    expect(mapAnalysisStatus("planted")).toBe("planted");
    expect(mapAnalysisStatus("open")).toBe("planted");
    expect(mapAnalysisStatus("whatever")).toBe("planted");
    const resolved = mapImportedForeshadow(
      { title: "退婚之耻", status: "resolved", note: "第三十章澄清", evidence: [{ path: "拆文库/斗破/正文.md", line: 30 }] },
      "斗破",
      1000
    );
    expect(resolved.status).toBe("resolved");
    expect(resolved.source).toBe("import");
    expect(resolved.book).toBe("斗破");
    expect(resolved.resolutionNote).toBe("第三十章澄清");
    expect(resolved.evidence).toEqual([{ path: "拆文库/斗破/正文.md", line: 30 }]);
    expect(resolved.createdAt).toBe(1000);
    const open = mapImportedForeshadow({ title: "戒指老爷爷", status: "open", note: "埋设" }, "斗破", 1000);
    expect(open.status).toBe("planted");
    expect(open.resolutionNote).toBeUndefined();
    expect(open.description).toBe("埋设");
    expect(importDedupeKey("斗破", " 戒指 ")).toBe(importDedupeKey("斗破", "戒指"));
    expect(importDedupeKey("斗破", "戒指")).not.toBe(importDedupeKey("斗破2", "戒指"));
  });

  it("selects reminders with Scriverse chapter semantics", () => {
    const base = { importance: 3, source: "manual", createdAt: 1, updatedAt: 1 } as const;
    const items: Foreshadow[] = [
      { id: "a", book: "b1", title: "A", status: "planted", plannedPayoffChapter: "ch2", ...base },
      { id: "b", book: "b1", title: "B", status: "planned", ...base },
      { id: "c", book: "b1", title: "C", status: "resolved", ...base },
      { id: "d", book: "b2", title: "D", status: "planted", ...base },
    ];
    expect(selectReminders(items, "b1", "ch2").map((item) => item.id).sort()).toEqual(["a", "b"]);
    expect(selectReminders(items, "b1", "ch9").map((item) => item.id)).toEqual(["b"]);
    expect(selectReminders(items, "b2", "ch2").map((item) => item.id)).toEqual(["d"]);
    expect(parseListLimit(null)).toBe(100);
    expect(parseListLimit("5")).toBe(5);
  });

  it("suppresses snoozed reminders until expiry or scope miss", () => {
    const base = { importance: 3, source: "manual", createdAt: 1, updatedAt: 1 } as const;
    const due: Foreshadow[] = [{ id: "a", book: "b1", title: "A", status: "planted", ...base }];
    const now = 1_000_000;
    const chapterSnooze: SnoozeRecord[] = [{ id: "a", untilBook: "b1", untilChapter: "ch2" }];
    expect(isSnoozed(chapterSnooze, "a", now, "b1", "ch2")).toBe(true);
    expect(isSnoozed(chapterSnooze, "a", now, "b1", "ch9")).toBe(false);
    expect(filterSnoozedReminders(due, chapterSnooze, now, "b1", "ch2")).toEqual([]);
    const expired: SnoozeRecord[] = [{ id: "a", untilMs: now - 1 }];
    expect(isSnoozed(expired, "a", now, "b1", "ch2")).toBe(false);
    expect(filterSnoozedReminders(due, expired, now, "b1", "ch2")).toHaveLength(1);
    const future: SnoozeRecord[] = [{ id: "a", untilMs: now + 60_000 }];
    expect(filterSnoozedReminders(due, future, now, "b1", "ch2")).toEqual([]);
  });
});

describe("foreshadows: create and list", () => {
  it("creates planned items by default and filters by book/status", async () => {
    const { fs, cwd } = isolatedCase();
    const first = await createItem(fs, cwd, { book: "斗破", chapter: "ch1", title: "戒指老爷爷", importance: 5 });
    expect(first.status).toBe("planned");
    expect(first.source).toBe("manual");
    expect(first.importance).toBe(5);
    const second = await createItem(fs, cwd, { book: "斗破", title: "退婚" });
    expect(second.importance).toBe(3);
    await createItem(fs, cwd, { book: "另一本", title: "别书伏笔" });

    const byBook = await callForeshadows(fs, cwd, "GET", "/oh-story/foreshadows?book=斗破");
    expect(byBook.status).toBe(200);
    expect(bodyOf<{ total: number }>(byBook).total).toBe(2);

    const byStatus = await callForeshadows(fs, cwd, "GET", "/oh-story/foreshadows?status=planned");
    expect(bodyOf<{ total: number }>(byStatus).total).toBe(3);

    const badStatus = await callForeshadows(fs, cwd, "GET", "/oh-story/foreshadows?status=nope");
    expect(badStatus.status).toBe(400);

    const missingTitle = await callForeshadows(fs, cwd, "POST", "/oh-story/foreshadows", { book: "斗破" });
    expect(missingTitle.status).toBe(400);
    void realmForCase(fs, cwd);
  });

  it("ignores other workspace prefixes", async () => {
    const { fs, cwd } = isolatedCase();
    const captured: CapturedResponse = {};
    const response = {
      writeHead: (status: number): void => { captured.status = status; },
      end: (): void => undefined,
    } as unknown as ServerResponse;
    const handled = await handleForeshadowsRequest(
      fakeContext(fs, cwd),
      incoming("GET", `/oh-story/tasks/runs?sessionId=${encodeURIComponent(cwd)}`),
      response,
      { maxBytes: 1024 }
    );
    expect(handled).toBe(false);
  });
});

describe("foreshadows: status machine", () => {
  it("walks planned->planted->resolved with idempotent replay", async () => {
    const { fs, cwd } = isolatedCase();
    const item = await createItem(fs, cwd, { book: "斗破", title: "戒指老爷爷" });
    // 非法跳跃 409.
    const skip = await callForeshadows(fs, cwd, "POST", `/oh-story/foreshadows/${item.id}/status`, { status: "resolved" });
    expect(skip.status).toBe(409);

    const planted = await callForeshadows(fs, cwd, "POST", `/oh-story/foreshadows/${item.id}/status`, { status: "planted" });
    expect(planted.status).toBe(200);
    expect(bodyOf<{ foreshadow: Foreshadow }>(planted).foreshadow.status).toBe("planted");

    const replay = await callForeshadows(fs, cwd, "POST", `/oh-story/foreshadows/${item.id}/status`, { status: "planted" });
    expect(replay.status).toBe(200);
    expect(bodyOf<{ idempotentReplay?: boolean }>(replay).idempotentReplay).toBe(true);

    const resolved = await callForeshadows(fs, cwd, "POST", `/oh-story/foreshadows/${item.id}/status`, {
      status: "resolved",
      resolutionNote: "第三十章揭晓",
    });
    expect(resolved.status).toBe(200);
    expect(bodyOf<{ foreshadow: Foreshadow }>(resolved).foreshadow.resolutionNote).toBe("第三十章揭晓");

    // 终态不可回退.
    const rollback = await callForeshadows(fs, cwd, "POST", `/oh-story/foreshadows/${item.id}/status`, { status: "planted" });
    expect(rollback.status).toBe(409);
    const missing = await callForeshadows(fs, cwd, "POST", "/oh-story/foreshadows/nope/status", { status: "planted" });
    expect(missing.status).toBe(404);
  });

  it("supports abandon from any non-terminal state and locks it", async () => {
    const { fs, cwd } = isolatedCase();
    const planned = await createItem(fs, cwd, { title: "废弃A" });
    const dropped = await callForeshadows(fs, cwd, "POST", `/oh-story/foreshadows/${planned.id}/status`, { status: "abandoned" });
    expect(dropped.status).toBe(200);
    const revive = await callForeshadows(fs, cwd, "POST", `/oh-story/foreshadows/${planned.id}/status`, { status: "planted" });
    expect(revive.status).toBe(409);

    const second = await createItem(fs, cwd, { title: "废弃B" });
    await callForeshadows(fs, cwd, "POST", `/oh-story/foreshadows/${second.id}/status`, { status: "planted" });
    const dropPlanted = await callForeshadows(fs, cwd, "POST", `/oh-story/foreshadows/${second.id}/status`, { status: "abandoned" });
    expect(dropPlanted.status).toBe(200);
  });
});

describe("foreshadows: import from A3 sidecar", () => {
  const SIDECAR = JSON.stringify({
    book: "斗破",
    parsedAt: "2026-09-05T00:00:00.000Z",
    sourceFiles: [],
    entities: [],
    relations: [],
    timeline: [],
    foreshadows: [
      { title: "戒指老爷爷", status: "planted", note: "埋设", evidence: [{ path: "拆文库/斗破/正文.md", line: 3 }], evidenceText: "x" },
      { title: "退婚之耻", status: "open", note: "待回收", evidence: [{ path: "拆文库/斗破/正文.md", line: 9 }], evidenceText: "y" },
      { title: "旧恩怨", status: "resolved", note: "已了结", evidence: [], evidenceText: "z" },
    ],
    scenes: [],
  });

  it("maps statuses and skips same-name entries on re-import", async () => {
    const { fs, cwd } = isolatedCase({ ".oh-story/analysis/斗破.json": SIDECAR });
    const first = await callForeshadows(fs, cwd, "POST", "/oh-story/foreshadows/import", { book: "斗破" });
    expect(first.status).toBe(200);
    const firstBody = bodyOf<{ imported: number; skipped: number; foreshadows: Foreshadow[] }>(first);
    expect(firstBody.imported).toBe(3);
    expect(firstBody.skipped).toBe(0);
    const byTitle = new Map(firstBody.foreshadows.map((item) => [item.title, item]));
    expect(byTitle.get("戒指老爷爷")?.status).toBe("planted");
    expect(byTitle.get("退婚之耻")?.status).toBe("planted");
    expect(byTitle.get("退婚之耻")?.description).toBe("待回收");
    expect(byTitle.get("旧恩怨")?.status).toBe("resolved");
    expect(byTitle.get("旧恩怨")?.resolutionNote).toBe("已了结");
    expect(byTitle.get("戒指老爷爷")?.evidence).toEqual([{ path: "拆文库/斗破/正文.md", line: 3 }]);
    for (const item of firstBody.foreshadows) expect(item.source).toBe("import");

    const second = await callForeshadows(fs, cwd, "POST", "/oh-story/foreshadows/import", { book: "斗破" });
    expect(second.status).toBe(200);
    expect(bodyOf<{ imported: number; skipped: number }>(second).imported).toBe(0);
    expect(bodyOf<{ imported: number; skipped: number }>(second).skipped).toBe(3);

    const missing = await callForeshadows(fs, cwd, "POST", "/oh-story/foreshadows/import", { book: "没这书" });
    expect(missing.status).toBe(404);
    const illegal = await callForeshadows(fs, cwd, "POST", "/oh-story/foreshadows/import", { book: "../逃逸" });
    expect(illegal.status).toBe(400);
  });
});

describe("foreshadows: reminders and snooze", () => {
  it("returns due items per chapter and hides snoozed until expiry", async () => {
    const { fs, cwd } = isolatedCase();
    const dueNow = await createItem(fs, cwd, { book: "斗破", title: "戒指", plannedPayoffChapter: "ch2" });
    await callForeshadows(fs, cwd, "POST", `/oh-story/foreshadows/${dueNow.id}/status`, { status: "planted" });
    const anytime = await createItem(fs, cwd, { book: "斗破", title: "退婚" });
    await callForeshadows(fs, cwd, "POST", `/oh-story/foreshadows/${anytime.id}/status`, { status: "planted" });
    const otherBook = await createItem(fs, cwd, { book: "别书", title: "别书线" });
    await callForeshadows(fs, cwd, "POST", `/oh-story/foreshadows/${otherBook.id}/status`, { status: "planted" });
    const done = await createItem(fs, cwd, { book: "斗破", title: "已收", plannedPayoffChapter: "ch2" });
    await callForeshadows(fs, cwd, "POST", `/oh-story/foreshadows/${done.id}/status`, { status: "planted" });
    await callForeshadows(fs, cwd, "POST", `/oh-story/foreshadows/${done.id}/status`, { status: "resolved" });

    const ch2 = await callForeshadows(fs, cwd, "GET", "/oh-story/foreshadows/reminders?book=斗破&chapter=ch2");
    expect(ch2.status).toBe(200);
    expect(bodyOf<{ reminders: Foreshadow[] }>(ch2).reminders.map((item) => item.id).sort()).toEqual(
      [dueNow.id, anytime.id].sort()
    );
    const ch9 = await callForeshadows(fs, cwd, "GET", "/oh-story/foreshadows/reminders?book=斗破&chapter=ch9");
    expect(bodyOf<{ reminders: Foreshadow[] }>(ch9).reminders.map((item) => item.id)).toEqual([anytime.id]);

    // 按章搁置:本章隐藏,别章仍提醒.
    const snoozed = await callForeshadows(fs, cwd, "POST", "/oh-story/foreshadows/snooze", {
      id: anytime.id,
      untilBook: "斗破",
      untilChapter: "ch2",
    });
    expect(snoozed.status).toBe(200);
    const ch2Hidden = await callForeshadows(fs, cwd, "GET", "/oh-story/foreshadows/reminders?book=斗破&chapter=ch2");
    expect(bodyOf<{ reminders: Foreshadow[] }>(ch2Hidden).reminders.map((item) => item.id)).toEqual([dueNow.id]);

    // 按天搁置:全查询隐藏;过期后恢复.
    const daySnooze = await callForeshadows(fs, cwd, "POST", "/oh-story/foreshadows/snooze", {
      id: dueNow.id,
      untilMs: Date.now() + 60_000,
    });
    expect(daySnooze.status).toBe(200);
    const ch2Empty = await callForeshadows(fs, cwd, "GET", "/oh-story/foreshadows/reminders?book=斗破&chapter=ch2");
    expect(bodyOf<{ reminders: Foreshadow[] }>(ch2Empty).reminders).toEqual([]);
    const expire = await callForeshadows(fs, cwd, "POST", "/oh-story/foreshadows/snooze", {
      id: dueNow.id,
      untilMs: Date.now() - 1000,
    });
    expect(expire.status).toBe(200);
    const ch2Back = await callForeshadows(fs, cwd, "GET", "/oh-story/foreshadows/reminders?book=斗破&chapter=ch2");
    expect(bodyOf<{ reminders: Foreshadow[] }>(ch2Back).reminders.map((item) => item.id)).toEqual([dueNow.id]);

    const missing = await callForeshadows(fs, cwd, "POST", "/oh-story/foreshadows/snooze", { id: "nope" });
    expect(missing.status).toBe(404);
  });
});

describe("foreshadows: corrupt stores degrade", () => {
  it("treats broken JSON as empty without crashing", async () => {
    const { fs, cwd } = isolatedCase({
      ".oh-story/foreshadows.json": "not-json{{{",
      ".oh-story/foreshadows-snooze.json": "[broken",
    });
    const listed = await callForeshadows(fs, cwd, "GET", "/oh-story/foreshadows");
    expect(listed.status).toBe(200);
    expect(bodyOf<{ foreshadows: unknown[] }>(listed).foreshadows).toEqual([]);
    const reminders = await callForeshadows(fs, cwd, "GET", "/oh-story/foreshadows/reminders?book=斗破&chapter=ch1");
    expect(reminders.status).toBe(200);
    expect(bodyOf<{ reminders: unknown[] }>(reminders).reminders).toEqual([]);
    // 损坏后仍可正常写入覆盖.
    const created = await createItem(fs, cwd, { title: "重建" });
    expect(created.status).toBe("planned");
  });
});
