import { describe, expect, it } from "vitest";
import { isGameAudio } from "../src/client/index.js";

const ROOT = "game-adaptations/demo";

describe("isGameAudio", () => {
  it("matches audio/ tracks recursively", () => {
    expect(isGameAudio(`${ROOT}/audio/bgm.mp3`, ROOT)).toBe(true);
    expect(isGameAudio(`${ROOT}/audio/battle/theme.WAV`, ROOT)).toBe(true);
    expect(isGameAudio(`${ROOT}/audio/sfx/hit.flac`, ROOT)).toBe(true);
  });

  it("excludes other projects, non-audio files and out-of-scope directories", () => {
    expect(isGameAudio("game-adaptations/other/audio/bgm.mp3", ROOT)).toBe(false);
    expect(isGameAudio(`${ROOT}/audio/cover.png`, ROOT)).toBe(false);
    expect(isGameAudio(`${ROOT}/audio/notes.md`, ROOT)).toBe(false);
    expect(isGameAudio(`${ROOT}/cover.mp3`, ROOT)).toBe(false);
    expect(isGameAudio(`${ROOT}/build/app/bgm.mp3`, ROOT)).toBe(false);
    expect(isGameAudio(`${ROOT}/design/mock.mp3`, ROOT)).toBe(false);
  });
});
