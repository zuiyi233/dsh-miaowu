import { describe, expect, it } from "vitest";
import { validateGameArtInventory } from "../src/game-art-validation.js";

const ART_DIRECTION = `# 美术方向

- ID：ART-HERO-STANDING —— 主角定妆
- ID: ART-MAP-TOWN —— 城镇地图(半角冒号)
`;

const codes = (input: Parameters<typeof validateGameArtInventory>[0]): string[] =>
  validateGameArtInventory(input).map((diagnostic) => diagnostic.code);

describe("validateGameArtInventory", () => {
  it("registered_missing_asset:登记了但 art/ 无以 ID 开头的文件", () => {
    expect(codes({
      artDirectionText: ART_DIRECTION,
      artFiles: ["art/ART-HERO-STANDING_00001_.png"],
      buildAppFiles: ["build/app/index.html"],
      buildAppSources: [{ path: "build/app/index.html", content: "ART-HERO-STANDING" }]
    })).toContain("registered_missing_asset");
  });

  it("asset_unregistered:art/ 有 ART-* 文件但未登记;不带前缀的普通文件忽略", () => {
    expect(codes({
      artDirectionText: ART_DIRECTION,
      artFiles: ["art/ART-HERO-STANDING.png", "art/ART-MAP-TOWN.png", "art/ART-EXTRA.png", "art/草稿参考.png"],
      buildAppFiles: [],
      buildAppSources: [{ path: "build/app/data.js", content: "img: 'ART-HERO-STANDING.png', other: 'ART-MAP-TOWN' extra: 'ART-EXTRA'" }]
    })).toContain("asset_unregistered");
    expect(codes({
      artDirectionText: ART_DIRECTION,
      artFiles: ["art/草稿参考.png", "art/ART-HERO-STANDING.png", "art/ART-MAP-TOWN.png"],
      buildAppFiles: [],
      buildAppSources: [{ path: "build/app/data.js", content: "ART-HERO-STANDING ART-MAP-TOWN" }]
    })).toEqual([]);
  });

  it("asset_not_used_in_build:已登记且素材在 art/,但 build/app 零引用", () => {
    expect(codes({
      artDirectionText: ART_DIRECTION,
      artFiles: ["art/ART-HERO-STANDING.png", "art/ART-MAP-TOWN.png"],
      buildAppFiles: ["build/app/index.html"],
      buildAppSources: [{ path: "build/app/index.html", content: "<html>无引用</html>" }]
    })).toContain("asset_not_used_in_build");
  });

  it("build_reference_unregistered:build 引用了未登记 ID;startART- 这类粘连不算引用", () => {
    expect(codes({
      artDirectionText: ART_DIRECTION,
      artFiles: ["art/ART-HERO-STANDING.png", "art/ART-MAP-TOWN.png"],
      buildAppFiles: ["build/app/data.js"],
      buildAppSources: [{ path: "build/app/data.js", content: "ref='ART-GHOST-ID' img='ART-HERO-STANDING.png' ART-MAP-TOWN" }]
    })).toEqual(["build_reference_unregistered"]);
    expect(codes({
      artDirectionText: ART_DIRECTION,
      artFiles: ["art/ART-HERO-STANDING.png", "art/ART-MAP-TOWN.png"],
      buildAppFiles: ["build/app/data.js"],
      buildAppSources: [{ path: "build/app/data.js", content: "img='ART-HERO-STANDING.png' ART-MAP-TOWN startART-HERO-STANDING" }]
    })).toEqual([]);
  });

  it("全部一致时零诊断;同名文件接入(复制而非代码引用)也算已使用", () => {
    expect(codes({
      artDirectionText: ART_DIRECTION,
      artFiles: ["art/ART-HERO-STANDING.png", "art/ART-MAP-TOWN.png"],
      buildAppFiles: ["build/app/assets/ART-HERO-STANDING.png"],
      buildAppSources: [{ path: "build/app/data.js", content: "img: 'ART-MAP-TOWN.png'" }]
    })).toEqual([]);
  });

  it("未走美术流(无登记且 art/ 空)不产诊断", () => {
    expect(codes({
      artDirectionText: undefined,
      artFiles: [],
      buildAppFiles: ["build/app/index.html"],
      buildAppSources: [{ path: "build/app/index.html", content: "ART-NOTHING" }]
    })).toEqual([]);
  });
});
