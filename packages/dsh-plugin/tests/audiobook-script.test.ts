import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAudiobookProject, saveAudiobookProject } from "../src/services/audiobook-project.js";
import type { AudiobookProjectRecord } from "../src/services/audiobook-contract.js";
import {
  assignChapterSpeakers,
  loadChapterScript,
  parseChapterScript,
  parseChapterText,
  saveChapterScript,
  scriptPathFor,
  segmentId,
} from "../src/services/audiobook-script.js";
import { CHAPTERS, memoryRealm, SANDBOX_POLICY, SESSION } from "./audiobook-fixtures.js";

const PROJECT_PATH = "有声剧/长夜行/project.json";
const CHAPTER = "第0001章_开篇";
const SOURCE_PATH = "正文/第0001章_开篇.md";

const sha256 = (content: string): string => createHash("sha256").update(content, "utf8").digest("hex");

function chapterScript(sourceSha256 = "0".repeat(64)) {
  return {
    schemaVersion: 1 as const,
    chapter: CHAPTER,
    sourcePath: SOURCE_PATH,
    sourceSha256,
    segments: parseChapterText("你好。"),
  };
}

describe("parseChapterText", () => {
  it("区分旁白与中文引号对白，并保留源偏移", () => {
    const text = "雨夜。\n\n“你来了。”他说。\n";
    const segments = parseChapterText(text);
    expect(segments.map((segment) => [segment.kind, segment.text])).toEqual([
      ["narration", "雨夜。"],
      ["dialogue", "你来了。"],
      ["narration", "他说。"],
    ]);
    expect(segments[0]).toMatchObject({ sourceStart: 0, sourceEnd: 3 });
    expect(segments[1]?.sourceStart).toBe(text.indexOf("你来了。"));
  });

  it("未知说话人使用 unknown，segment ID 稳定且随文本变化", () => {
    const first = parseChapterText("“你好。”")[0]!;
    const second = parseChapterText("“你好。”")[0]!;
    expect(first.speakerId).toBe("unknown");
    expect(first.id).toBe(second.id);
    expect(first.id).toBe(segmentId("dialogue", "unknown", "你好。", first.sourceStart));
    expect(parseChapterText("“再见。”")[0]?.id).not.toBe(first.id);
  });

  it("裁剪空白后仍指向源文本，并识别「」与『』对白", () => {
    const text = "  夜色。  「走吧。」他说。\n";
    const segments = parseChapterText(text);
    expect(segments.map((segment) => [segment.kind, segment.text])).toEqual([
      ["narration", "夜色。"],
      ["dialogue", "走吧。"],
      ["narration", "他说。"],
    ]);
    expect(segments[0]).toMatchObject({ sourceStart: 2, sourceEnd: 5 });
    expect(segments[1]?.sourceStart).toBe(text.indexOf("走吧。"));
    expect(parseChapterText(text)).toEqual(segments);
  });

  it("超长段落按句末标点切到 2000 字以内", () => {
    const text = `${"雨。".repeat(1200)}`;
    const segments = parseChapterText(text);
    expect(segments.length).toBeGreaterThan(1);
    expect(segments.every((segment) => segment.text.length <= 2000)).toBe(true);
  });

  it("单句超过 2000 字时硬切且偏移连续", () => {
    const text = "雨".repeat(2100);
    const segments = parseChapterText(text);
    expect(segments.map((segment) => [segment.sourceStart, segment.sourceEnd, segment.text.length])).toEqual([
      [0, 2000, 2000],
      [2000, 2100, 100],
    ]);
  });

  it("保存后读回；已有脚本未确认时拒绝覆盖", async () => {
    const { realm } = memoryRealm({ "正文/第0001章_开篇.md": "你好。" });
    const script = chapterScript();
    const saved = await saveChapterScript(realm, "有声剧/长夜行/project.json", script, false);
    expect((await loadChapterScript(realm, "有声剧/长夜行/project.json", "第0001章_开篇"))?.script).toEqual(script);
    await expect(saveChapterScript(realm, "有声剧/长夜行/project.json", script, false))
      .rejects.toMatchObject({ status: 409 });
    await expect(saveChapterScript(realm, "有声剧/长夜行/project.json", { ...script, sourceSha256: "1".repeat(64) }, true))
      .resolves.toMatchObject({ script: { sourceSha256: "1".repeat(64) } });
    expect(saved.path).toBe("有声剧/长夜行/脚本/第0001章_开篇.json");
  });
});

describe("parseChapterScript", () => {
  it("从正文生成脚本：章节名、源哈希与覆盖语义", async () => {
    const source = "夜色。\n\n“走吧。”\n";
    const { realm, read } = memoryRealm({ [SOURCE_PATH]: source });
    const project = await createAudiobookProject(realm, {
      bookRoot: "正文", name: "长夜行", voice: "alloy", baseUrl: "https://api.example.com/v1", model: "tts-1",
    });

    const { record, assignmentSummary } = await parseChapterScript(realm, project, SOURCE_PATH);

    expect(record.path).toBe("有声剧/长夜行/脚本/第0001章_开篇.json");
    expect(record.script.chapter).toBe(CHAPTER);
    expect(record.script.sourcePath).toBe(SOURCE_PATH);
    expect(record.script.sourceSha256).toBe(sha256(source));
    expect(record.script.segments.map((segment) => [segment.kind, segment.text])).toEqual([
      ["narration", "夜色。"],
      ["dialogue", "走吧。"],
    ]);
    expect(assignmentSummary).toEqual({ preserved: 0, dropped: 0 });
    expect(JSON.parse(read(record.path) ?? "{}")).toMatchObject({ schemaVersion: 1, chapter: CHAPTER });

    await expect(parseChapterScript(realm, project, SOURCE_PATH)).rejects.toMatchObject({ status: 409 });
    const replaced = await parseChapterScript(realm, project, SOURCE_PATH, true);
    expect(replaced.record.version).not.toBe(record.version);
    await expect(parseChapterScript(realm, project, "正文/第0009章_缺失.md")).rejects.toMatchObject({ status: 404 });
  });
});

describe("脚本持久化边界", () => {
  it("读取脚本：缺失返回 undefined，坏 JSON 或错误 schemaVersion 返回 422", async () => {
    const { realm } = memoryRealm({
      "有声剧/长夜行/脚本/第0001章_开篇.json": "{",
      "有声剧/长夜行/脚本/第0002章_回声.json": JSON.stringify({ ...chapterScript(), chapter: "第0002章_回声", schemaVersion: 2 }),
      "有声剧/长夜行/脚本/第0003章_尾声.json": JSON.stringify({ ...chapterScript(), chapter: "第0003章_尾声", schemaVersion: "1" }),
      "有声剧/长夜行/脚本/第0004章_错名.json": JSON.stringify(chapterScript()),
    });
    await expect(loadChapterScript(realm, PROJECT_PATH, CHAPTER)).rejects.toMatchObject({ status: 422 });
    await expect(loadChapterScript(realm, PROJECT_PATH, "第0002章_回声")).rejects.toMatchObject({ status: 422 });
    await expect(loadChapterScript(realm, PROJECT_PATH, "第0003章_尾声")).rejects.toMatchObject({ status: 422 });
    await expect(loadChapterScript(realm, PROJECT_PATH, "第0004章_错名")).rejects.toMatchObject({ status: 422 });
    expect(await loadChapterScript(realm, PROJECT_PATH, "第0005章_没有")).toBeUndefined();
  });

  it("脚本路径固定在 有声剧/<书>/脚本/ 下，非法章节名与外部项目路径被拒绝", async () => {
    const { realm } = memoryRealm({});
    expect(scriptPathFor(PROJECT_PATH, CHAPTER)).toBe("有声剧/长夜行/脚本/第0001章_开篇.json");
    expect(() => scriptPathFor(PROJECT_PATH, "a/b")).toThrow(/分隔符/u);
    expect(() => scriptPathFor(PROJECT_PATH, "..\\逃逸")).toThrow(/分隔符/u);
    expect(() => scriptPathFor("正文/长夜行/project.json", CHAPTER)).toThrow(/有声剧/u);

    await expect(saveChapterScript(realm, PROJECT_PATH, { ...chapterScript(), chapter: "a/b" }, false))
      .rejects.toMatchObject({ status: 400 });
    await expect(saveChapterScript(realm, "正文/长夜行/project.json", chapterScript(), false))
      .rejects.toMatchObject({ status: 403 });
    await expect(loadChapterScript(realm, PROJECT_PATH, "a/b")).rejects.toMatchObject({ status: 400 });

    // 脚本不存在时，overwrite 也按新建处理。
    const created = await saveChapterScript(realm, PROJECT_PATH, chapterScript(), true);
    expect(created.path).toBe(scriptPathFor(PROJECT_PATH, CHAPTER));
  });
});

describe("沙箱策略透传", () => {
  it("保存脚本按当前会话解析策略，并作为第五参传给 writeText", async () => {
    const { realm, policyRequests, writeCalls } = memoryRealm({});

    await saveChapterScript(realm, PROJECT_PATH, chapterScript(), false);

    expect(policyRequests).toEqual([{ session: SESSION }]);
    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0]?.path).toBe(scriptPathFor(PROJECT_PATH, CHAPTER));
    expect(writeCalls[0]?.sandboxPolicy).toBe(SANDBOX_POLICY);
  });

  it("创建与保存项目同样按会话解析策略", async () => {
    const { realm, policyRequests, writeCalls } = memoryRealm({ ...CHAPTERS });

    const record = await createAudiobookProject(realm, {
      bookRoot: "正文", name: "长夜行", voice: "alloy", baseUrl: "https://api.example.com/v1", model: "tts-1",
    });
    await saveAudiobookProject(realm, record.path, record.project, record.version);

    expect(policyRequests).toEqual([{ session: SESSION }, { session: SESSION }]);
    expect(writeCalls.map((call) => call.sandboxPolicy)).toEqual([SANDBOX_POLICY, SANDBOX_POLICY]);
  });
});

describe("脚本大小上限", () => {
  it("超过 4 MiB 的脚本在写入前返回 413 且不落盘", async () => {
    const { realm, writes, writeCalls, policyRequests } = memoryRealm({});
    const oversizedText = "雨".repeat(1_500_000);
    const oversized = {
      ...chapterScript(),
      segments: [{
        id: segmentId("narration", "narrator", oversizedText, 0),
        kind: "narration" as const,
        speakerId: "narrator",
        text: oversizedText,
        sourceStart: 0,
        sourceEnd: oversizedText.length,
      }],
    };

    await expect(saveChapterScript(realm, PROJECT_PATH, oversized, true)).rejects.toMatchObject({ status: 413 });
    expect(writes).toHaveLength(0);
    expect(writeCalls).toHaveLength(0);
    expect(policyRequests).toHaveLength(0);
  });
});

async function multiRoleProject(realm: Parameters<typeof createAudiobookProject>[0]): Promise<AudiobookProjectRecord> {
  const created = await createAudiobookProject(realm, {
    bookRoot: "正文", name: "长夜行", voice: "alloy", baseUrl: "https://api.example.com/v1", model: "tts-1",
  });
  return await saveAudiobookProject(realm, created.path, {
    ...created.project,
    cast: [
      created.project.cast[0]!,
      { id: "role-linfan", name: "林帆", kind: "character", voice: "verse" },
      { id: "role-shen", name: "沈秋", kind: "character", voice: "echo" },
    ],
  }, created.version);
}

async function replaceSource(realm: Parameters<typeof createAudiobookProject>[0], path: string, content: string): Promise<void> {
  const target = await realm.fs.resolve(path, { cwd: realm.cwd });
  const info = await realm.fs.stat(target);
  if (info === undefined || info.type !== "file") throw new Error("source missing");
  await realm.fs.writeText(target, content, { kind: "replaceIfVersion", version: info.version });
}

describe("说话人指派", () => {
  const SOURCE = "旁白。\n\n“林帆来了。”\n\n“我听见了。”\n";

  it("按 segmentId 指派对白，重算 id 并做 CAS；非法目标被拒绝", async () => {
    const { realm } = memoryRealm({ [SOURCE_PATH]: SOURCE });
    const project = await multiRoleProject(realm);
    const parsed = await parseChapterScript(realm, project, SOURCE_PATH);
    const dialoges = parsed.record.script.segments.filter((segment) => segment.kind === "dialogue");
    expect(dialoges).toHaveLength(2);
    expect(dialoges.map((segment) => segment.speakerId)).toEqual(["unknown", "unknown"]);

    const saved = await assignChapterSpeakers(
      realm,
      project,
      CHAPTER,
      parsed.record.version,
      [{ segmentId: dialoges[0]!.id, speakerId: "role-linfan" }],
    );
    expect(saved.script.segments.find((segment) => segment.text === "林帆来了。")).toMatchObject({
      speakerId: "role-linfan",
      id: segmentId("dialogue", "role-linfan", "林帆来了。", dialoges[0]!.sourceStart),
    });
    expect(saved.script.segments.find((segment) => segment.text === "我听见了。")?.speakerId).toBe("unknown");
    expect((await loadChapterScript(realm, PROJECT_PATH, CHAPTER))?.script).toEqual(saved.script);

    await expect(assignChapterSpeakers(realm, project, CHAPTER, parsed.record.version, [
      { segmentId: saved.script.segments[1]!.id, speakerId: "role-shen" },
    ])).rejects.toMatchObject({ status: 412 });
    await expect(assignChapterSpeakers(realm, project, CHAPTER, saved.version, [
      { segmentId: "s-missing", speakerId: "role-shen" },
    ])).rejects.toMatchObject({ status: 400 });
    await expect(assignChapterSpeakers(realm, project, CHAPTER, saved.version, [
      { segmentId: saved.script.segments[1]!.id, speakerId: "role-deleted" },
    ])).rejects.toMatchObject({ status: 400 });
    await expect(assignChapterSpeakers(realm, project, CHAPTER, saved.version, [
      { segmentId: saved.script.segments[0]!.id, speakerId: "role-shen" },
    ])).rejects.toMatchObject({ status: 400, message: expect.stringContaining("旁白片段") });
    await expect(assignChapterSpeakers(realm, project, CHAPTER, saved.version, [
      { segmentId: saved.script.segments[1]!.id, speakerId: "role-linfan" },
      { segmentId: saved.script.segments[1]!.id, speakerId: "role-shen" },
    ])).rejects.toMatchObject({ status: 400, message: expect.stringContaining("重复") });

    const cleared = await assignChapterSpeakers(realm, project, CHAPTER, saved.version, [
      { segmentId: saved.script.segments[1]!.id, speakerId: "unknown" },
    ]);
    expect(cleared.script.segments[1]?.speakerId).toBe("unknown");
  });

  it("重新解析保留文本未变片段的指派，文本变化的片段记 dropped", async () => {
    const { realm } = memoryRealm({ [SOURCE_PATH]: SOURCE });
    const project = await multiRoleProject(realm);
    const parsed = await parseChapterScript(realm, project, SOURCE_PATH);
    const dialogue = parsed.record.script.segments.filter((segment) => segment.kind === "dialogue");
    const assigned = await assignChapterSpeakers(realm, project, CHAPTER, parsed.record.version, [
      { segmentId: dialogue[0]!.id, speakerId: "role-linfan" },
      { segmentId: dialogue[1]!.id, speakerId: "role-shen" },
    ]);

    const reused = await parseChapterScript(realm, project, SOURCE_PATH, true);
    expect(reused.assignmentSummary).toEqual({ preserved: 2, dropped: 0 });
    expect(reused.record.script.segments.filter((segment) => segment.kind === "dialogue").map((segment) => segment.speakerId))
      .toEqual(["role-linfan", "role-shen"]);

    await replaceSource(realm, SOURCE_PATH, "旁白。\n\n“林帆走了。”\n\n“我听见了。”\n");
    const changed = await parseChapterScript(realm, project, SOURCE_PATH, true);
    expect(changed.assignmentSummary).toEqual({ preserved: 1, dropped: 1 });
    expect(changed.record.script.segments.filter((segment) => segment.kind === "dialogue").map((segment) => [segment.text, segment.speakerId]))
      .toEqual([["林帆走了。", "unknown"], ["我听见了。", "role-shen"]]);
    expect(assigned.version).not.toBe(changed.record.version);
  });
});
