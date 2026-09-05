import { describe, expect, it } from "vitest";
import { isGameArtImage } from "../src/client/game-art.js";

const ROOT = "game-adaptations/demo";

describe("isGameArtImage", () => {
  it("matches art/ images recursively", () => {
    expect(isGameArtImage(`${ROOT}/art/hero.png`, ROOT)).toBe(true);
    expect(isGameArtImage(`${ROOT}/art/scene-1/cover.webp`, ROOT)).toBe(true);
    expect(isGameArtImage(`${ROOT}/art/poster.JPEG`, ROOT)).toBe(true);
  });

  it("matches project-root images", () => {
    expect(isGameArtImage(`${ROOT}/cover.jpg`, ROOT)).toBe(true);
    expect(isGameArtImage(`${ROOT}/icon.gif`, ROOT)).toBe(true);
  });

  it("excludes other projects, documents and build assets", () => {
    expect(isGameArtImage("game-adaptations/other/art/hero.png", ROOT)).toBe(false);
    expect(isGameArtImage(`${ROOT}/PRODUCT_BRIEF.md`, ROOT)).toBe(false);
    expect(isGameArtImage(`${ROOT}/build/app/cover.png`, ROOT)).toBe(false);
    expect(isGameArtImage(`${ROOT}/design/mock.svg`, ROOT)).toBe(false);
  });
});
