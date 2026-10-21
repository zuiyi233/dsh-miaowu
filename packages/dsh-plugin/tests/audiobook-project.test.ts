import { describe, expect, it } from "vitest";
import {
  createAudiobookProject,
  listAudiobookSources,
  listChapterPaths,
  loadAudiobookProject,
  saveAudiobookProject,
  validateTtsBaseUrl,
} from "../src/services/audiobook-project.js";
import { CHAPTERS, memoryRealm } from "./audiobook-fixtures.js";

describe("audiobook project", () => {
  it("发现正文直属章节、根级书目录与 正文/<书名> 章节", async () => {
    const { realm } = memoryRealm({
      ...CHAPTERS,
      "正文/README.md": "# 正文目录说明\n",
      "正文/人物设定.md": "# 人物设定\n",
      "正文/长夜行/第0001章.md": "# 长夜行\n",
      "书名/正文/第0001章.md": "# 书名布局\n",
    });

    // README、设定等非 `第N章` 命名的 .md 不是章节。
    expect(await listChapterPaths(realm, "正文")).toEqual(["正文/第0001章_开篇.md", "正文/第0002章_回声.md"]);
    const sources = await listAudiobookSources(realm);
    expect(sources.map((source) => source.bookRoot)).toEqual(["正文", "书名", "正文/长夜行"].sort((a, b) => a.localeCompare(b, "zh-Hans-CN")));
  });

  it("根级目录必须自带 正文/ 才算书籍", async () => {
    const { realm } = memoryRealm({
      "正文/第0001章_开篇.md": "# 正文\n",
      "书名/正文/第0001章.md": "# 书名布局\n",
      "书名/第0002章.md": "# 根级章节不应被发现\n",
      "大纲/第0001章.md": "# 大纲不是书\n",
      "大纲/大纲.md": "# 大纲说明\n",
    });

    const sources = await listAudiobookSources(realm);
    expect(sources.map((source) => source.bookRoot)).not.toContain("大纲");
    expect(sources.map((source) => source.bookRoot)).toEqual(["正文", "书名"].sort((a, b) => a.localeCompare(b, "zh-Hans-CN")));
    // 根级书目录只认 `<book>/正文/`，直属 `第0002章.md` 被忽略。
    expect(sources.find((source) => source.bookRoot === "书名")?.chapters).toEqual(["书名/正文/第0001章.md"]);
    expect(await listChapterPaths(realm, "书名")).toEqual(["书名/正文/第0001章.md"]);
    await expect(createAudiobookProject(realm, {
      bookRoot: "大纲", name: "大纲", voice: "alloy", baseUrl: "https://api.example.com/v1", model: "tts-1",
    })).rejects.toMatchObject({ status: 404 });
  });

  it("创建项目写入 schemaVersion 1，密钥字段不能落盘", async () => {
    const { realm, read } = memoryRealm(CHAPTERS);

    const record = await createAudiobookProject(realm, {
      bookRoot: "正文",
      name: "长夜行",
      voice: "alloy",
      baseUrl: "https://api.example.com/v1",
      model: "tts-1",
    });

    expect(record.path).toBe("有声剧/长夜行/project.json");
    const saved = JSON.parse(read(record.path) ?? "{}") as Record<string, unknown>;
    expect(saved.schemaVersion).toBe(1);
    expect(JSON.stringify(saved)).not.toContain("apiKey");
    expect(record.project.cast).toEqual([{ id: "narrator", name: "旁白", kind: "narrator", voice: "alloy" }]);
    expect(record.project.tts.baseUrl).toBe("https://api.example.com/v1");
  });

  it("保存项目使用 baseVersion CAS，旧版本返回 412", async () => {
    const { realm } = memoryRealm(CHAPTERS);
    const created = await createAudiobookProject(realm, {
      bookRoot: "正文", name: "长夜行", voice: "alloy", baseUrl: "https://api.example.com/v1", model: "tts-1",
    });
    const next = { ...created.project, cast: [{ ...created.project.cast[0]!, voice: "verse" }] };
    const saved = await saveAudiobookProject(realm, created.path, next, created.version);
    expect(saved.project.cast[0]?.voice).toBe("verse");
    await expect(saveAudiobookProject(realm, created.path, next, created.version)).rejects.toMatchObject({ status: 412 });
  });

  it("保存并恢复多角色音色映射", async () => {
    const { realm } = memoryRealm(CHAPTERS);
    const created = await createAudiobookProject(realm, {
      bookRoot: "正文", name: "长夜行", voice: "alloy", baseUrl: "https://api.example.com/v1", model: "tts-1",
    });
    const cast = [
      created.project.cast[0]!,
      { id: "role-linfan", name: "林帆", kind: "character" as const, voice: "verse" },
      { id: "role-shen", name: "沈秋", kind: "character" as const, voice: "echo" },
      { id: "role-gu", name: "顾遥", kind: "character" as const, voice: "shimmer" },
    ];

    const saved = await saveAudiobookProject(realm, created.path, { ...created.project, cast }, created.version);
    const loaded = await loadAudiobookProject(realm, created.path);

    expect(saved.project.cast).toEqual(cast);
    expect(loaded.project.cast).toEqual(cast);
    expect(loaded.version).toBe(saved.version);
  });

  it("加载项目只接受 有声剧/ 下 schemaVersion 1 的文件", async () => {
    const { realm } = memoryRealm({ ...CHAPTERS, "有声剧/旧项目/project.json": JSON.stringify({ schemaVersion: 2 }) });
    const created = await createAudiobookProject(realm, {
      bookRoot: "正文", name: "长夜行", voice: "alloy", baseUrl: "https://api.example.com/v1", model: "tts-1",
    });

    const loaded = await loadAudiobookProject(realm, created.path);
    expect(loaded.project.source).toEqual({ bookRoot: "正文", chapters: ["正文/第0001章_开篇.md", "正文/第0002章_回声.md"] });
    await expect(loadAudiobookProject(realm, "正文/project.json")).rejects.toMatchObject({ status: 403 });
    await expect(loadAudiobookProject(realm, "有声剧/旧项目/project.json")).rejects.toMatchObject({ status: 422 });
  });

  it("拒绝非 loopback 明文端点与 URL 凭证", () => {
    expect(validateTtsBaseUrl("https://api.example.com/v1")).toBe("https://api.example.com/v1");
    expect(validateTtsBaseUrl("http://127.0.0.1:8080/v1")).toBe("http://127.0.0.1:8080/v1");
    expect(() => validateTtsBaseUrl("http://api.example.com/v1")).toThrow(/https/u);
    expect(() => validateTtsBaseUrl("https://user:pass@api.example.com/v1")).toThrow(/凭证/u);
    expect(() => validateTtsBaseUrl("https://api.example.com/v1?x=1")).toThrow(/query/u);
  });

  it("拒绝只有分隔符的裸 query 与 hash", () => {
    // `new URL("...?")` 的 search 为空，必须按原文识别出多余的 `?`/`#`。
    expect(() => validateTtsBaseUrl("https://api.example.com/v1?")).toThrow(/query/u);
    expect(() => validateTtsBaseUrl("https://api.example.com/v1#")).toThrow(/hash/u);
    expect(() => validateTtsBaseUrl("http://127.0.0.1:8080/v1?#")).toThrow(/query/u);
  });

  it("保存与加载都拒绝重复旁白、重复 id 与保留 unknown 角色", async () => {
    const { realm } = memoryRealm(CHAPTERS);
    const created = await createAudiobookProject(realm, {
      bookRoot: "正文", name: "长夜行", voice: "alloy", baseUrl: "https://api.example.com/v1", model: "tts-1",
    });
    const narrator = created.project.cast[0]!;
    const character = { id: "role-linfan", name: "林帆", kind: "character" as const, voice: "verse" };

    await expect(saveAudiobookProject(realm, created.path, {
      ...created.project,
      cast: [narrator, { ...character, kind: "narrator" }],
    }, created.version)).rejects.toMatchObject({ status: 422, message: expect.stringContaining("恰好有一个旁白") });

    await expect(saveAudiobookProject(realm, created.path, {
      ...created.project,
      cast: [narrator, character, { ...character, name: "另一个林帆" }],
    }, created.version)).rejects.toMatchObject({ status: 422, message: expect.stringContaining("id 重复") });

    await expect(saveAudiobookProject(realm, created.path, {
      ...created.project,
      cast: [narrator, { ...character, id: "unknown" }],
    }, created.version)).rejects.toMatchObject({ status: 422, message: expect.stringContaining("保留值") });
  });

  it("拒绝以点开头的项目名，避免创建后从项目列举里消失", async () => {
    const { realm, writes } = memoryRealm(CHAPTERS);

    await expect(createAudiobookProject(realm, {
      bookRoot: "正文", name: ".hidden", voice: "alloy", baseUrl: "https://api.example.com/v1", model: "tts-1",
    })).rejects.toMatchObject({ status: 400, message: expect.stringContaining("以点开头") });
    expect(writes).toEqual([]);
  });

  it("保存超过 512 KiB 的项目在写盘前返回 413", async () => {
    const { realm, writes } = memoryRealm(CHAPTERS);
    const created = await createAudiobookProject(realm, {
      bookRoot: "正文", name: "长夜行", voice: "alloy", baseUrl: "https://api.example.com/v1", model: "tts-1",
    });
    const writesBefore = writes.length;
    const oversized = {
      ...created.project,
      cast: [{ ...created.project.cast[0]!, voice: "x".repeat(512 * 1_024) }],
    };

    await expect(saveAudiobookProject(realm, created.path, oversized, created.version))
      .rejects.toMatchObject({ status: 413 });
    expect(writes.length).toBe(writesBefore);
  });
});
