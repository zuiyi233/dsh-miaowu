import { describe, expect, it, vi } from "vitest";
import type { FileSystem, FsDirEntry, FsInfo, FsTarget } from "@deepseek-ai/dsh-fs";
import {
  extractEntities,
  extractForeshadows,
  extractRelations,
  extractScenes,
  extractTimeline,
  listAnalysisBooks,
  listSidecarBooks,
  parseAllBooks,
  parseBookTree,
  queryAnalysis,
  querySidecar,
  readSidecar,
  writeSidecar,
  type AnalysisFs,
  type BookDocInput,
  type BookSidecar
} from "../src/services/analysis.js";

function target(displayPath: string): FsTarget {
  return { targetKey: displayPath as FsTarget["targetKey"], displayPath };
}

function version(value: string): FsInfo["version"] {
  return value as FsInfo["version"];
}

/** 轻量内存 FileSystem:路径即 key,测试只用 resolve/contains/stat/listDir/readBytes/writeText。 */
function memoryFs(files: Record<string, string>): { fs: AnalysisFs; written: Map<string, string> } {
  const store = new Map<string, string>(Object.entries(files));
  const written = new Map<string, string>();
  const fs = {
    resolve: vi.fn(async (path: string, options?: { readonly cwd?: string }): Promise<FsTarget> =>
      target(path.startsWith("/") ? path : `${options?.cwd ?? ""}/${path}`)),
    contains: vi.fn((parent: FsTarget, child: FsTarget) => child.displayPath.startsWith(parent.displayPath)),
    stat: vi.fn(async (entry: FsTarget): Promise<FsInfo | undefined> => {
      if (store.has(entry.displayPath)) {
        const size = store.get(entry.displayPath)?.length;
        return size === undefined ? { type: "file", version: version("v1") } : { type: "file", version: version("v1"), size };
      }
      const prefix = `${entry.displayPath}/`;
      for (const key of store.keys()) {
        if (key.startsWith(prefix)) return { type: "directory", version: version("v1") };
      }
      return undefined;
    }),
    listDir: vi.fn(async (entry: FsTarget): Promise<FsDirEntry[]> => {
      const prefix = `${entry.displayPath}/`;
      const children = new Map<string, "file" | "directory">();
      for (const key of store.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash === -1) children.set(rest, "file");
        else children.set(rest.slice(0, slash), "directory");
      }
      return [...children.entries()]
        .sort(([left], [right]) => (left < right ? -1 : 1))
        .map(([name, type]) => ({ name, type, target: target(`${entry.displayPath}/${name}`) }));
    }),
    readBytes: vi.fn(async (entry: FsTarget): Promise<Uint8Array> => {
      const content = store.get(entry.displayPath);
      if (content === undefined) throw new Error("missing");
      return new TextEncoder().encode(content);
    }),
    writeText: vi.fn(async (entry: FsTarget, content: string): Promise<{ operation: "create" | "update"; version: FsInfo["version"] }> => {
      store.set(entry.displayPath, content);
      written.set(entry.displayPath, content);
      return { operation: "update", version: version("v2") };
    })
  } as unknown as AnalysisFs;
  // FileSystem 抽象类无运行期依赖,此处仅复用其方法签名做类型兼容断言。
  void (null as unknown as FileSystem | null);
  return { fs, written };
}

const CWD = "/books/demo";

const CHARACTERS = [
  "# 角色档案与关系",
  "",
  "## 角色档案",
  "",
  "## 萧炎",
  "",
  "别名：炎帝、萧三少",
  "",
  "- **药尘**：师父，灵魂体",
  "",
  "## 关系",
  "",
  "- 萧炎 — 药尘（师徒）",
  "- 萧炎 与 纳兰嫣然 是 退婚对手"
].join("\n");

const PLOT = [
  "# 剧情与伏笔",
  "",
  "## 时间线",
  "",
  "- 萧炎三岁练气（时间：幼年）",
  "- 纳兰嫣然上门退婚",
  "",
  "## 伏笔地图",
  "",
  "- 戒指里的老爷爷（埋设）",
  "- 退婚之耻已回收",
  "",
  "### 神秘戒指",
  "",
  "## 第一幕·乌坦城",
  "",
  "正文段落。"
].join("\n");

// 第 1 行是 H1,世界观节从第 3 行开始;两个实体标题行号用于断言证据准确。
const WORLD = ["# 世界观", "", "## 势力", "", "## 云岚宗", "", "- **纳兰嫣然**：少宗主", "", "## 地理", "", "### 加玛圣城"].join("\n");

function docs(): BookDocInput[] {
  return [
    { path: "拆文库/斗破/角色档案与关系.md", content: CHARACTERS, bytes: CHARACTERS.length, version: "v1" },
    { path: "拆文库/斗破/剧情与伏笔.md", content: PLOT, bytes: PLOT.length, version: "v1" },
    { path: "拆文库/斗破/世界观.md", content: WORLD, bytes: WORLD.length, version: "v1" }
  ];
}

function asInput(path: string, content: string): BookDocInput {
  return { path, content, bytes: content.length, version: "v1" };
}

describe("拆书解析器", () => {
  it("抽取实体/关系/时间线/伏笔/场景的数量与字段", () => {
    const inputs = docs();
    expect(extractEntities(inputs).map((entity) => entity.name)).toEqual(["萧炎", "药尘", "云岚宗", "纳兰嫣然", "加玛圣城"]);

    const relations = extractRelations(inputs);
    expect(relations).toHaveLength(2);
    expect(relations[0]).toMatchObject({ from: "萧炎", to: "药尘", kind: "师徒" });
    expect(relations[1]).toMatchObject({ from: "萧炎", to: "纳兰嫣然", kind: "退婚对手" });

    const timeline = extractTimeline(inputs);
    expect(timeline).toHaveLength(2);
    expect(timeline[0]).toMatchObject({ label: "萧炎三岁练气", at: "幼年" });
    expect(timeline[1]).toMatchObject({ label: "纳兰嫣然上门退婚" });

    const foreshadows = extractForeshadows(inputs);
    expect(foreshadows.map((item) => item.title)).toEqual(["戒指里的老爷爷", "退婚之耻", "神秘戒指"]);
    expect(foreshadows[0]?.status).toBe("planted");
    expect(foreshadows[1]?.status).toBe("resolved");
    expect(foreshadows[2]?.status).toBe("open");

    const scenes = extractScenes(inputs);
    expect(scenes.map((scene) => scene.title)).toEqual(["第一幕·乌坦城"]);
  });

  it("实体别名合并且类型由所在节推断", () => {
    const entities = extractEntities(docs());
    expect(entities.find((entity) => entity.name === "萧炎")).toMatchObject({ type: "character", aliases: ["炎帝", "萧三少"] });
    expect(entities.find((entity) => entity.name === "云岚宗")?.type).toBe("faction");
    expect(entities.find((entity) => entity.name === "加玛圣城")?.type).toBe("location");
  });

  it("证据行号等于标题与内容的实际 1-based 行号", () => {
    const entities = extractEntities(docs());
    // CHARACTERS: "## 萧炎" 在第 5 行,"- **药尘**" 在第 9 行;"## 关系" 是关系节,不产实体。
    expect(entities.find((entity) => entity.name === "萧炎")?.evidence).toEqual([{ path: "拆文库/斗破/角色档案与关系.md", line: 5 }]);
    expect(entities.find((entity) => entity.name === "药尘")?.evidence).toEqual([{ path: "拆文库/斗破/角色档案与关系.md", line: 9 }]);

    // WORLD: "## 云岚宗" 第 5 行,"- **纳兰嫣然**" 第 7 行,"### 加玛圣城" 第 11 行。
    expect(entities.find((entity) => entity.name === "云岚宗")?.evidence).toEqual([{ path: "拆文库/斗破/世界观.md", line: 5 }]);
    expect(entities.find((entity) => entity.name === "纳兰嫣然")?.evidence).toEqual([{ path: "拆文库/斗破/世界观.md", line: 7 }]);
    expect(entities.find((entity) => entity.name === "加玛圣城")?.evidence).toEqual([{ path: "拆文库/斗破/世界观.md", line: 11 }]);

    // PLOT: "## 伏笔地图" 第 8 行,伏笔列表第 10/11 行;"### 神秘戒指" 第 13 行;"## 第一幕" 第 15 行。
    const foreshadows = extractForeshadows(docs());
    expect(foreshadows[0]?.evidence).toEqual([{ path: "拆文库/斗破/剧情与伏笔.md", line: 10 }]);
    expect(foreshadows[1]?.evidence).toEqual([{ path: "拆文库/斗破/剧情与伏笔.md", line: 11 }]);
    expect(foreshadows[2]?.evidence).toEqual([{ path: "拆文库/斗破/剧情与伏笔.md", line: 13 }]);
    expect(extractScenes(docs())[0]?.evidence).toEqual([{ path: "拆文库/斗破/剧情与伏笔.md", line: 15 }]);
    expect(extractScenes(docs())[0]?.evidence).toEqual([{ path: "拆文库/斗破/剧情与伏笔.md", line: 15 }]);

    const relations = extractRelations(docs());
    expect(relations[0]?.evidence).toEqual([{ path: "拆文库/斗破/角色档案与关系.md", line: 13 }]);
    expect(relations[1]?.evidence).toEqual([{ path: "拆文库/斗破/角色档案与关系.md", line: 14 }]);

    const timeline = extractTimeline(docs());
    expect(timeline[0]?.evidence).toEqual([{ path: "拆文库/斗破/剧情与伏笔.md", line: 5 }]);
  });

  it("对缺节与未知结构不抛错", () => {
    const empty: BookDocInput[] = [asInput("拆文库/空书/随笔.md", "# 随笔\n\n今天天气不错,写点散文。\n\n- 买菜\n- 做饭\n")];
    expect(parseBookTree("空书", empty)).toMatchObject({
      book: "空书",
      entities: [],
      relations: [],
      timeline: [],
      foreshadows: [],
      scenes: []
    });
    expect(parseBookTree("无书", [])).toMatchObject({ book: "无书", entities: [] });
    // _progress.md 只作参考,不产记录。
    const progress = [asInput("拆文库/斗破/_progress.md", "## 萧炎\n\n- 萧炎 — 药尘（师徒）\n")];
    expect(parseBookTree("斗破", progress)).toMatchObject({ entities: [], relations: [] });
  });
});

describe("sidecar 与查询", () => {
  it("parse 逐书落盘并返回计数,query 按 kind 过滤与子串匹配", async () => {
    const { fs } = memoryFs({
      "/books/demo/拆文库/斗破/角色档案与关系.md": CHARACTERS,
      "/books/demo/拆文库/斗破/剧情与伏笔.md": PLOT,
      "/books/demo/拆文库/斗破/世界观.md": WORLD
    });
    const root = await fs.resolve(CWD);
    const result = await parseAllBooks(fs, CWD, root, 1_048_576);
    expect(result.books).toEqual([{
      book: "斗破",
      entityCount: 5,
      relationCount: 2,
      timelineCount: 2,
      foreshadowCount: 3,
      sceneCount: 1
    }]);

    const sidecar = await readSidecar(fs, CWD, root, "斗破", 1_048_576);
    expect(sidecar?.book).toBe("斗破");
    expect(sidecar?.sourceFiles.map((file) => file.path)).toEqual([
      "拆文库/斗破/世界观.md",
      "拆文库/斗破/剧情与伏笔.md",
      "拆文库/斗破/角色档案与关系.md"
    ]);

    // 子串匹配大小写不敏感,空 q 全量返回。
    const hits = await queryAnalysis(fs, CWD, root, "斗破", "entity", "萧炎", 1_048_576);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ book: "斗破", kind: "entity" });
    expect(await queryAnalysis(fs, CWD, root, "斗破", "relation", "萧炎", 1_048_576)).toHaveLength(2);
    expect(await queryAnalysis(fs, CWD, root, "斗破", "entity", "", 1_048_576)).toHaveLength(5);
    expect(await queryAnalysis(fs, CWD, root, "斗破", "all", "退婚", 1_048_576)).toHaveLength(3);
  });

  it("export 可 roundtrip 且字段齐全", async () => {
    const { fs } = memoryFs({
      "/books/demo/拆文库/斗破/角色档案与关系.md": CHARACTERS,
      "/books/demo/拆文库/斗破/剧情与伏笔.md": PLOT,
      "/books/demo/拆文库/斗破/世界观.md": WORLD
    });
    const root = await fs.resolve(CWD);
    await parseAllBooks(fs, CWD, root, 1_048_576);
    const sidecar = await readSidecar(fs, CWD, root, "斗破", 1_048_576);
    const roundtrip = JSON.parse(JSON.stringify(sidecar)) as BookSidecar;
    expect(roundtrip.book).toBe("斗破");
    expect(typeof roundtrip.parsedAt).toBe("string");
    expect(roundtrip.entities.length).toBeGreaterThan(0);
    expect(roundtrip.relations.length).toBeGreaterThan(0);
    expect(roundtrip.timeline.length).toBeGreaterThan(0);
    expect(roundtrip.foreshadows.length).toBeGreaterThan(0);
    expect(roundtrip.scenes.length).toBeGreaterThan(0);
    for (const entity of roundtrip.entities) {
      expect(entity.evidence.length).toBeGreaterThan(0);
      expect(entity.evidence[0]?.line).toBeGreaterThan(0);
      expect(typeof entity.evidenceText).toBe("string");
    }
  });

  it("parse 幂等:跑两次结果一致(除 parsedAt)", async () => {
    const { fs } = memoryFs({
      "/books/demo/拆文库/斗破/角色档案与关系.md": CHARACTERS,
      "/books/demo/拆文库/斗破/剧情与伏笔.md": PLOT
    });
    const root = await fs.resolve(CWD);
    await parseAllBooks(fs, CWD, root, 1_048_576);
    const first = await readSidecar(fs, CWD, root, "斗破", 1_048_576);
    await parseAllBooks(fs, CWD, root, 1_048_576);
    const second = await readSidecar(fs, CWD, root, "斗破", 1_048_576);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect({ ...second, parsedAt: "" }).toEqual({ ...first, parsedAt: "" });
  });

  it("损坏的 sidecar 降级为空并允许重建", async () => {
    const { fs, written } = memoryFs({
      "/books/demo/拆文库/斗破/角色档案与关系.md": CHARACTERS,
      "/books/demo/.oh-story/analysis/斗破.json": "NOT-JSON{{{"
    });
    const root = await fs.resolve(CWD);
    expect(await readSidecar(fs, CWD, root, "斗破", 1_048_576)).toBeUndefined();
    expect(await queryAnalysis(fs, CWD, root, "斗破", "all", "", 1_048_576)).toEqual([]);
    // 重建覆盖损坏文件。
    await parseAllBooks(fs, CWD, root, 1_048_576);
    expect(written.get("/books/demo/.oh-story/analysis/斗破.json")).toContain("萧炎");
    expect((await readSidecar(fs, CWD, root, "斗破", 1_048_576))?.entities.length).toBeGreaterThan(0);
  });

  it("book 省略时查全部书,结果带 book 字段", async () => {
    const { fs } = memoryFs({
      "/books/demo/拆文库/斗破/角色档案与关系.md": CHARACTERS,
      "/books/demo/拆文库/凡人/世界观.md": WORLD
    });
    const root = await fs.resolve(CWD);
    await parseAllBooks(fs, CWD, root, 1_048_576);
    expect(await listAnalysisBooks(fs, CWD, root)).toEqual(["凡人", "斗破"]);
    expect(await listSidecarBooks(fs, CWD, root)).toEqual(["凡人", "斗破"]);
    const hits = await queryAnalysis(fs, CWD, root, undefined, "all", "纳兰", 1_048_576);
    expect(hits.map((hit) => hit.book).sort()).toEqual(["凡人", "斗破"]);
    expect(hits.find((hit) => hit.book === "斗破")?.kind).toBe("relation");
    expect(hits.find((hit) => hit.book === "凡人")?.kind).toBe("entity");
  });

  it("querySidecar 支持纯函数单测", () => {
    const sidecar = parseBookTree("斗破", docs());
    expect(querySidecar(sidecar, "scene", "乌坦")).toHaveLength(1);
    expect(querySidecar(sidecar, "foreshadow", "戒指")).toHaveLength(2);
    expect(querySidecar(sidecar, "timeline", "退婚")).toHaveLength(1);
    expect(querySidecar(sidecar, "all", "不存在的名字")).toEqual([]);
  });

  it("writeSidecar 直接落盘可读回", async () => {
    const { fs } = memoryFs({ "/books/demo/拆文库/斗破/角色档案与关系.md": CHARACTERS });
    const root = await fs.resolve(CWD);
    const sidecar = parseBookTree("斗破", [asInput("拆文库/斗破/角色档案与关系.md", CHARACTERS)]);
    const path = await writeSidecar(fs, CWD, root, sidecar);
    expect(path).toBe(".oh-story/analysis/斗破.json");
    expect(await readSidecar(fs, CWD, root, "斗破", 1_048_576)).toMatchObject({ book: "斗破" });
  });
});
