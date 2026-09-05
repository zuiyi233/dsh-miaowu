import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EmptyStateOnboarding, ONBOARDING_ENTRIES } from "../src/client/empty-state-onboarding.js";

describe("empty state onboarding", () => {
  it("declares five creation entries, one per product line", () => {
    expect(ONBOARDING_ENTRIES).toHaveLength(5);
    expect(ONBOARDING_ENTRIES.map((entry) => entry.key)).toEqual(
      ["novel-long", "novel-short", "drama", "game", "video"]
    );
  });

  it("renders title, description and all five entries", () => {
    const html = renderToStaticMarkup(<EmptyStateOnboarding onCreate={() => Promise.resolve()} />);
    expect(html).toContain("尚未检测到创作工程");
    for (const entry of ONBOARDING_ENTRIES) {
      expect(html).toContain(entry.label);
      expect(html).toContain(entry.hint);
    }
  });

  it("covers each product line with a non-empty creation prompt", () => {
    for (const entry of ONBOARDING_ENTRIES) {
      expect(entry.prompt.length).toBeGreaterThan(0);
    }
    const prompts = ONBOARDING_ENTRIES.map((entry) => entry.prompt).join("\n");
    expect(prompts).toContain("story-setup");
    expect(prompts).toContain("short-drama");
    expect(prompts).toContain("novel-to-game");
    expect(prompts).toContain("video-recap");
  });
});
