import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAudiobookProject } from "../src/services/audiobook-project.js";
import {
  loadChapterScript,
  parseChapterScript,
  parseChapterText,
  saveChapterScript,
  scriptPathFor,
  segmentId,
} from "../src/services/audiobook-script.js";
import { memoryRealm } from "./audiobook-fixtures.js";

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

    const record = await parseChapterScript(realm, project, SOURCE_PATH);

    expect(record.path).toBe("有声剧/长夜行/脚本/第0001章_开篇.json");
    expect(record.script.chapter).toBe(CHAPTER);
    expect(record.script.sourcePath).toBe(SOURCE_PATH);
    expect(record.script.sourceSha256).toBe(sha256(source));
    expect(record.script.segments.map((segment) => [segment.kind, segment.text])).toEqual([
      ["narration", "夜色。"],
      ["dialogue", "走吧。"],
    ]);
    expect(JSON.parse(read(record.path) ?? "{}")).toMatchObject({ schemaVersion: 1, chapter: CHAPTER });

    await expect(parseChapterScript(realm, project, SOURCE_PATH)).rejects.toMatchObject({ status: 409 });
    const replaced = await parseChapterScript(realm, project, SOURCE_PATH, true);
    expect(replaced.version).not.toBe(record.version);
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
