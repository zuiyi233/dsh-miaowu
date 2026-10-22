// tests/audiobook-m4b.test.ts
import { describe, expect, it } from "vitest";
import { assertCover, bookM4bPathFor, buildFfmetadata, buildM4bArgs } from "../src/services/audiobook-m4b.js";
import { WorkspaceHttpError } from "../src/workspace-route.js";
import { memoryRealm } from "./audiobook-fixtures.js";

const chapters = [
  { title: "第0001章", startMs: 0, endMs: 1_000 },
  { title: "第0002章", startMs: 1_000, endMs: 3_000 },
];

/** 捕获服务抛出的 HTTP 状态码；不是 WorkspaceHttpError 时返回 undefined。 */
const rejectionStatus = (action: () => unknown): number | undefined => {
  try {
    action();
    return undefined;
  } catch (error) {
    return error instanceof WorkspaceHttpError ? error.status : undefined;
  }
};

describe("audiobook m4b", () => {
  it("ffmetadata 使用毫秒时间基与章节标题", () => {
    expect(buildFfmetadata(chapters)).toBe(";FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=1000\ntitle=第0001章\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=1000\nEND=3000\ntitle=第0002章\n");
  });

  it("M4B 参数嵌入封面、章节元数据与 AAC 128k", () => {
    const args = buildM4bArgs({
      concatListPath: "/tmp/list.txt", metadataPath: "/tmp/meta.txt", coverPath: "/tmp/cover.jpg",
      outputPath: "/tmp/全书.m4b", title: "长夜行",
    });
    expect(args).toContain("-f");
    expect(args[args.indexOf("-f") + 1]).toBe("concat");
    expect(args).toContain("-safe");
    expect(args[args.indexOf("-i") + 1]).toBe("/tmp/list.txt");
    expect(args).toContain("-f");
    expect(args).toContain("ffmetadata");
    expect(args[args.indexOf("-map_metadata") + 1]).toBe("2");
    expect(args).toContain("attached_pic");
    expect(args[args.indexOf("-c:a") + 1]).toBe("aac");
    expect(args[args.indexOf("-b:a") + 1]).toBe("128k");
    expect(args).toContain("+faststart");
    expect(args.at(-1)).toBe("/tmp/全书.m4b");
  });

  it("缺封面或封面为空时返回 409", async () => {
    const { realm } = memoryRealm({ "有声剧/长夜行/封面/cover.jpg": "" });
    await expect(assertCover(realm, "有声剧/长夜行/project.json")).rejects.toMatchObject({ status: 409 });
    const withCover = memoryRealm({ "有声剧/长夜行/封面/cover.jpg": "JPEG" });
    await expect(assertCover(withCover.realm, "有声剧/长夜行/project.json"))
      .resolves.toBe("有声剧/长夜行/封面/cover.jpg");
  });

  it("封面缺失或不是普通文件时返回 409", async () => {
    await expect(assertCover(memoryRealm().realm, "有声剧/长夜行/project.json")).rejects.toMatchObject({ status: 409 });
    // 该路径下有子文件时 stat 报告 directory：目录不能当封面。
    const directory = memoryRealm({ "有声剧/长夜行/封面/cover.jpg/占位": "" });
    await expect(assertCover(directory.realm, "有声剧/长夜行/project.json")).rejects.toMatchObject({ status: 409 });
  });

  it("章节标题里的换行与分号转成空格，控制字符与空标题被拒绝", () => {
    expect(buildFfmetadata([{ title: "第一行\n第二行;尾声", startMs: 0, endMs: 10 }]))
      .toBe(";FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=10\ntitle=第一行 第二行 尾声\n");
    expect(rejectionStatus(() => buildFfmetadata([{ title: "标题\t制表符", startMs: 0, endMs: 10 }]))).toBe(400);
    expect(rejectionStatus(() => buildFfmetadata([{ title: "  ", startMs: 0, endMs: 10 }]))).toBe(400);
  });

  it("章节时间必须有限、非负、整数且不倒置", () => {
    expect(rejectionStatus(() => buildFfmetadata([{ title: "第1章", startMs: 20, endMs: 10 }]))).toBe(400);
    expect(rejectionStatus(() => buildFfmetadata([{ title: "第1章", startMs: -1, endMs: 10 }]))).toBe(400);
    expect(rejectionStatus(() => buildFfmetadata([{ title: "第1章", startMs: Number.NaN, endMs: 10 }]))).toBe(400);
    expect(rejectionStatus(() => buildFfmetadata([{ title: "第1章", startMs: 0, endMs: Number.POSITIVE_INFINITY }]))).toBe(400);
    expect(rejectionStatus(() => buildFfmetadata([{ title: "第1章", startMs: 0.5, endMs: 10 }]))).toBe(400);
    // 起点等于终点是合法的空章（brief 只要求 startMs <= endMs）。
    expect(rejectionStatus(() => buildFfmetadata([{ title: "第1章", startMs: 10, endMs: 10 }]))).toBeUndefined();
  });

  it("M4B 参数顺序固定：封面为第二输入、章节元数据为第三输入", () => {
    expect(buildM4bArgs({
      concatListPath: "/tmp/list.txt", metadataPath: "/tmp/meta.txt", coverPath: "/tmp/cover.jpg",
      outputPath: "/tmp/全书.m4b", title: "长夜行",
    })).toEqual([
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "concat", "-safe", "0", "-i", "/tmp/list.txt",
      "-i", "/tmp/cover.jpg",
      "-f", "ffmetadata", "-i", "/tmp/meta.txt",
      "-map", "0:a", "-map", "1:v", "-map_metadata", "2",
      "-c:a", "aac", "-b:a", "128k", "-c:v", "mjpeg",
      "-disposition:v", "attached_pic",
      "-metadata", "title=长夜行", "-movflags", "+faststart",
      "/tmp/全书.m4b",
    ]);
    expect(rejectionStatus(() => buildM4bArgs({
      concatListPath: "", metadataPath: "/tmp/meta.txt", coverPath: "/tmp/cover.jpg",
      outputPath: "/tmp/全书.m4b", title: "长夜行",
    }))).toBe(400);
    expect(rejectionStatus(() => buildM4bArgs({
      concatListPath: "/tmp/list.txt", metadataPath: "/tmp/meta.txt", coverPath: "/tmp/cover.jpg",
      outputPath: "/tmp/全书.m4b", title: "  ",
    }))).toBe(400);
  });

  it("全书 M4B 路径固定在 有声剧/<书>/音频/ 下且不碰文件系统", async () => {
    expect(bookM4bPathFor("有声剧/长夜行/project.json")).toBe("有声剧/长夜行/音频/全书.m4b");
    expect(rejectionStatus(() => bookM4bPathFor("正文/长夜行/project.json"))).toBe(400);
    expect(rejectionStatus(() => bookM4bPathFor("有声剧/../project.json"))).toBe(400);
    await expect(assertCover(memoryRealm().realm, "正文/长夜行/project.json")).rejects.toMatchObject({ status: 400 });
  });
});
