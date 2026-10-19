import { describe, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import type { FileSystem, FsTarget } from "@deepseek-ai/dsh-fs";
import {
  creativeTarget,
  WorkspaceHttpError,
  workspaceRealmForSession,
  type WorkspaceRealm
} from "../src/workspace-route.js";

const CWD = "/work/demo";

function target(displayPath: string): FsTarget {
  return { targetKey: displayPath as FsTarget["targetKey"], displayPath };
}

/** 内存 realm:只伪造 workspaceRealmForSession / creativeTarget 实际读到的 fs 表面。 */
function realmWith(overrides: {
  readonly resolve?: FileSystem["resolve"];
  readonly contains?: FileSystem["contains"];
} = {}): WorkspaceRealm {
  const fs = {
    resolve: overrides.resolve ?? vi.fn(async (path: string): Promise<FsTarget> => target(path.startsWith("/") ? path : `${CWD}/${path}`)),
    contains: overrides.contains ?? vi.fn(() => true)
  } as unknown as FileSystem;
  return { agent: {}, fs, sandboxPolicy: {}, cwd: CWD, root: target(CWD) } as unknown as WorkspaceRealm;
}

interface FakeHeader {
  readonly cwd?: string;
  readonly parentSession?: string;
  readonly origin?: "subagent";
}

/** Agent 只暴露 workspaceRealmForSession 读取的 session.header 与 ctx.get。 */
function agentWith(header: FakeHeader, fs: FileSystem = realmWith().fs): unknown {
  return {
    session: { header },
    ctx: { get: (key: string): unknown => key === "fs" ? fs : key === "sandboxPolicy" ? {} : undefined }
  };
}

/** workspace-route.ts 经 context.typert.lookups.get("agent") 取 agent,键名与宿主一致。 */
function contextResolving(resolve: (id: string) => unknown): Context {
  return { typert: { lookups: { get: () => ({ resolve }) } } } as unknown as Context;
}

async function expectHttpError(promise: Promise<unknown>, status: number): Promise<WorkspaceHttpError> {
  const failure = await promise.then(() => undefined, (error: unknown) => error);
  expect(failure).toBeInstanceOf(WorkspaceHttpError);
  expect((failure as WorkspaceHttpError).status).toBe(status);
  return failure as WorkspaceHttpError;
}

describe("workspaceRealmForSession 会话负向契约", () => {
  it("带 parentSession 的子 Agent 会话 403,不开放创作编辑器", async () => {
    const context = contextResolving(async () => agentWith({ cwd: CWD, parentSession: "parent-session" }));
    const failure = await expectHttpError(workspaceRealmForSession(context, "child-session"), 403);
    expect(failure.message).toBe("子 Agent 会话不开放创作编辑器。");
  });

  it("origin 为 subagent 的会话同样 403", async () => {
    const context = contextResolving(async () => agentWith({ cwd: CWD, origin: "subagent" }));
    const failure = await expectHttpError(workspaceRealmForSession(context, "subagent-session"), 403);
    expect(failure.message).toBe("子 Agent 会话不开放创作编辑器。");
  });

  it("空 sessionId 直接 400,不触碰 Agent lookup", async () => {
    const resolve = vi.fn();
    const failure = await expectHttpError(workspaceRealmForSession(contextResolving(resolve), ""), 400);
    expect(failure.message).toBe("缺少 DSH sessionId。");
    expect(resolve).not.toHaveBeenCalled();
  });

  it("lookup 拒绝的未知会话 404", async () => {
    const context = contextResolving(async () => { throw new Error("unknown session"); });
    const failure = await expectHttpError(workspaceRealmForSession(context, "missing-session"), 404);
    expect(failure.message).toBe("DSH 会话不可用。");
  });

  it("lookup 解析为 undefined 的未知会话 404", async () => {
    const context = contextResolving(async () => undefined);
    await expectHttpError(workspaceRealmForSession(context, "missing-session"), 404);
  });

  it("顶层会话照常组装 realm(证明负向用例的假件确实走到解析路径)", async () => {
    const fs = realmWith().fs;
    const context = contextResolving(async () => agentWith({ cwd: CWD }, fs));
    const realm = await workspaceRealmForSession(context, "top-level-session");
    expect(realm.cwd).toBe(CWD);
    expect(realm.root).toEqual(target(CWD));
    expect(realm.fs).toBe(fs);
  });
});

describe("creativeTarget 路径负向契约", () => {
  it("绝对路径 403(创作工作台只收工作目录内的相对路径)", async () => {
    const failure = await expectHttpError(creativeTarget(realmWith(), "/work/demo/正文/第001章.md"), 403);
    expect(failure.message).toBe("文件路径不在创作工作台中。");
  });

  it("解析结果逃出工作区时 403:DSH fs.resolve 会 realpath 规范化软链,包含关系才是安全边界", async () => {
    // 软链契约:相对创作路径本身合法,但 fs.resolve 已按 realpath 把
    // 正文/第001章.md(指向工作区外的符号链接)规范化到 root 之外,于是 fs.contains 为假。
    // 因此安全边界是"规范化目标是否仍在 realm.root 内",不是路径字符串形状或前缀匹配。
    const escaping = target("/outside/link/正文/第001章.md");
    const realm = realmWith({
      resolve: vi.fn(async () => escaping),
      contains: vi.fn(() => false)
    });
    const failure = await expectHttpError(creativeTarget(realm, "正文/第001章.md"), 403);
    expect(failure.message).toBe("文件路径离开了 DSH 工作目录。");
  });
});
