import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DramaPlayback } from "../src/client/drama-playback.js";
import { parseEpisodeProduction } from "../src/client/drama-production.js";
import type { ProductionMediaVersion } from "../src/client/production-runtime.js";

const episode = "剧集/EP001";

function production() {
  return parseEpisodeProduction({
    [`${episode}/剧本.md`]: "## EP001-SC001 内 · 门外 · 夜\n江辰：我回来了。",
    [`${episode}/分镜.md`]: "## SHOT-EP001-001 · 门外停步\n- 来源：EP001-SC001\n- 目的：先停住。\n- 景别/机位：中近景。\n- 起点：右手悬在门把上方。\n- 终点：手收回。\n\n### 冻结关键帧提示词\n> 江辰站在旧门外，右手悬停。\n\n## SHOT-EP001-002 · 推门\n- 来源：EP001-SC001\n- 目的：进入。\n",
    [`${episode}/图片提示词.md`]: "",
    [`${episode}/视频提示词.md`]: `## MOTION-EP001-001 · 门外停步\n- 分镜：SHOT-EP001-001\n\n### 可复制提示词\n> 从悬停开始，人物缓慢收回右手。\n`
  }, episode);
}

describe("DramaPlayback", () => {
  beforeEach(() => { vi.stubGlobal("location", new URL("http://localhost/")); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("renders the first shot with media, caption and controls", () => {
    const versions: ProductionMediaVersion[] = [
      { id: "v1", targetId: "SHOT-EP001-001", kind: "video", url: "/m/1.mp4", path: `${episode}/制作成果/SHOT-EP001-001.mp4` }
    ];
    const html = renderToStaticMarkup(<DramaPlayback sessionId="sess-1" production={production()} versions={versions} selections={{}} episodeName="EP001" />);
    expect(html).toContain("oh-story-playback");
    expect(html).toContain("SHOT-EP001-001");
    expect(html).toContain("<video");
    expect(html).toContain("controls");
    expect(html).toContain("先停住");
    expect(html).toContain("上一镜");
    expect(html).toContain("下一镜");
    expect(html).toContain("自动播放");
    expect(html).toContain("图片每镜停留秒数");
  });

  it("shows a placeholder with the prompt summary when a shot has no media", () => {
    const html = renderToStaticMarkup(<DramaPlayback sessionId="sess-1" production={production()} versions={[]} selections={{}} episodeName="EP001" />);
    expect(html).toContain("SHOT-EP001-001");
    expect(html).toContain("江辰站在旧门外");
    expect(html).toContain("02");
  });

  it("renders the empty-state guide when the episode has no shots", () => {
    const html = renderToStaticMarkup(<DramaPlayback sessionId="sess-1" production={parseEpisodeProduction({}, episode)} versions={[]} selections={{}} episodeName="EP001" />);
    expect(html).toContain("还没有可串播的镜头");
    expect(html).toContain("/short-drama-storyboard");
  });

  it("stays silent without dub audio: no audio element then", () => {
    const html = renderToStaticMarkup(<DramaPlayback sessionId="sess-1" production={production()} versions={[]} selections={{}} episodeName="EP001" />);
    expect(html).not.toContain("<audio");
  });

  it("renders the dub track for an image shot with audio", () => {
    const dubbed = parseEpisodeProduction({
      [`${episode}/分镜.md`]: "## SHOT-EP001-001 · 门外停步\n- 目的：先停住。\n"
    }, episode, [{ path: `${episode}/配音/SHOT-EP001-001.wav` }]);
    const html = renderToStaticMarkup(<DramaPlayback sessionId="sess-1" production={dubbed} versions={[]} selections={{}} episodeName="EP001" />);
    expect(html).toContain("<audio");
    expect(html).toContain("controls");
    expect(html).toContain("台词配音");
  });

  it("skips the dub track on a video shot: the video sound wins", () => {
    const dubbed = parseEpisodeProduction({
      [`${episode}/分镜.md`]: "## SHOT-EP001-001 · 门外停步\n- 目的：先停住。\n"
    }, episode, [{ path: `${episode}/配音/SHOT-EP001-001.wav` }]);
    const versions: ProductionMediaVersion[] = [
      { id: "v1", targetId: "SHOT-EP001-001", kind: "video", url: "/m/1.mp4", path: `${episode}/制作成果/SHOT-EP001-001.mp4` }
    ];
    const html = renderToStaticMarkup(<DramaPlayback sessionId="sess-1" production={dubbed} versions={versions} selections={{}} episodeName="EP001" />);
    expect(html).toContain("<video");
    expect(html).not.toContain("<audio");
  });
});
