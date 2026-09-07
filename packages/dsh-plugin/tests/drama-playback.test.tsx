import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DramaPlayback, PlaybackTakeSwitcher } from "../src/client/drama-playback.js";
import { parseEpisodeProduction } from "../src/client/drama-production.js";
import { playbackTakeGroups, type ProductionMediaVersion } from "../src/client/production-runtime.js";

const episode = "剧集/EP001";

function production() {
  return parseEpisodeProduction({
    [`${episode}/剧本.md`]: "## EP001-SC001 内 · 门外 · 夜\n江辰：我回来了。",
    [`${episode}/分镜.md`]: "## SHOT-EP001-001 · 门外停步\n- 来源：EP001-SC001\n- 目的：先停住。\n- 景别/机位：中近景。\n- 起点：右手悬在门把上方。\n- 终点：手收回。\n\n### 冻结关键帧提示词\n> 江辰站在旧门外，右手悬停。\n\n## SHOT-EP001-002 · 推门\n- 来源：EP001-SC001\n- 目的：进入。\n",
    [`${episode}/图片提示词.md`]: "",
    [`${episode}/视频提示词.md`]: `## MOTION-EP001-001 · 门外停步\n- 分镜：SHOT-EP001-001\n\n### 可复制提示词\n> 从悬停开始，人物缓慢收回右手。\n`
  }, episode);
}

interface TakeButtonProps {
  readonly children?: ReactNode;
  readonly onClick?: () => void;
}

/** Collect rendered buttons from a function-component element tree (no DOM harness in this repo). */
function collectButtons(node: ReactNode, into: Array<ReactElement<TakeButtonProps>>): void {
  if (Array.isArray(node)) {
    node.forEach((child) => { collectButtons(child, into); });
    return;
  }
  if (!isValidElement<TakeButtonProps>(node)) return;
  if (node.type === "button" && typeof node.props.onClick === "function") into.push(node);
  if (node.props.children !== undefined) collectButtons(node.props.children, into);
}

function twoImageTakes(): ProductionMediaVersion[] {
  return [
    { id: "img1", targetId: "SHOT-EP001-001", kind: "image", url: "/m/1.png", path: `${episode}/制作成果/SHOT-EP001-001.png` },
    { id: "img2", targetId: "SHOT-EP001-001", kind: "image", url: "/m/2.png", path: `${episode}/制作成果/SHOT-EP001-001-take2.png` }
  ];
}

describe("DramaPlayback", () => {
  beforeEach(() => { vi.stubGlobal("location", new URL("http://localhost/")); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("renders the first shot with media, caption and controls", () => {
    const versions: ProductionMediaVersion[] = [
      { id: "v1", targetId: "SHOT-EP001-001", kind: "video", url: "/m/1.mp4", path: `${episode}/制作成果/SHOT-EP001-001.mp4` }
    ];
    const html = renderToStaticMarkup(<DramaPlayback sessionId="sess-1" production={production()} versions={versions} selections={{}} episodeName="EP001" onSelectionsChange={() => undefined} />);
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
    const html = renderToStaticMarkup(<DramaPlayback sessionId="sess-1" production={production()} versions={[]} selections={{}} episodeName="EP001" onSelectionsChange={() => undefined} />);
    expect(html).toContain("SHOT-EP001-001");
    expect(html).toContain("江辰站在旧门外");
    expect(html).toContain("02");
  });

  it("renders the empty-state guide when the episode has no shots", () => {
    const html = renderToStaticMarkup(<DramaPlayback sessionId="sess-1" production={parseEpisodeProduction({}, episode)} versions={[]} selections={{}} episodeName="EP001" onSelectionsChange={() => undefined} />);
    expect(html).toContain("还没有可串播的镜头");
    expect(html).toContain("/short-drama-storyboard");
  });

  it("stays silent without dub audio: no audio element then", () => {
    const html = renderToStaticMarkup(<DramaPlayback sessionId="sess-1" production={production()} versions={[]} selections={{}} episodeName="EP001" onSelectionsChange={() => undefined} />);
    expect(html).not.toContain("<audio");
  });

  it("renders the dub track for an image shot with audio", () => {
    const dubbed = parseEpisodeProduction({
      [`${episode}/分镜.md`]: "## SHOT-EP001-001 · 门外停步\n- 目的：先停住。\n"
    }, episode, [{ path: `${episode}/配音/SHOT-EP001-001.wav` }]);
    const html = renderToStaticMarkup(<DramaPlayback sessionId="sess-1" production={dubbed} versions={[]} selections={{}} episodeName="EP001" onSelectionsChange={() => undefined} />);
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
    const html = renderToStaticMarkup(<DramaPlayback sessionId="sess-1" production={dubbed} versions={versions} selections={{}} episodeName="EP001" onSelectionsChange={() => undefined} />);
    expect(html).toContain("<video");
    expect(html).not.toContain("<audio");
  });

  it("shows the take switcher below the caption when the current shot has multiple image takes", () => {
    const versions = twoImageTakes();
    const html = renderToStaticMarkup(<DramaPlayback sessionId="sess-1" production={production()} versions={versions} selections={{}} episodeName="EP001" onSelectionsChange={() => undefined} />);
    expect(html).toContain("版本切换");
    expect(html).toContain("关键帧");
    expect(html).toContain("V1");
    expect(html).toContain("V2");
    const captionAt = html.indexOf("oh-story-playback-caption");
    const takesAt = html.indexOf("oh-story-playback-takes");
    const controlsAt = html.indexOf("oh-story-playback-controls");
    expect(captionAt).toBeGreaterThanOrEqual(0);
    expect(takesAt).toBeGreaterThan(captionAt);
    expect(controlsAt).toBeGreaterThan(takesAt);
  });

  it("marks the selected take and switches on click", () => {
    const versions = twoImageTakes();
    const groups = playbackTakeGroups("SHOT-EP001-001", versions, {}).filter((group) => group.versions.length > 1);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.kind).toBe("image");
    expect(groups[0]?.selectedId).toBe("img2");
    const seen: Array<Record<string, string>> = [];
    const element = PlaybackTakeSwitcher({ shotId: "SHOT-EP001-001", groups, selections: {}, onSelectionsChange: (next) => { seen.push(next); } });
    const buttons: Array<ReactElement<TakeButtonProps>> = [];
    collectButtons(element, buttons);
    expect(buttons).toHaveLength(2);
    buttons[0]?.props.onClick?.();
    expect(seen).toEqual([{ "SHOT-EP001-001": "img1" }]);
    const marked = renderToStaticMarkup(<PlaybackTakeSwitcher shotId="SHOT-EP001-001" groups={groups} selections={{ "SHOT-EP001-001": "img1" }} onSelectionsChange={() => undefined} />);
    expect(marked).toContain("data-selected=\"true\"");
  });

  it("hides the take switcher for single-take shots", () => {
    const html = renderToStaticMarkup(<DramaPlayback sessionId="sess-1" production={production()} versions={[{ id: "img1", targetId: "SHOT-EP001-001", kind: "image", url: "/m/1.png", path: `${episode}/制作成果/SHOT-EP001-001.png` }]} selections={{}} episodeName="EP001" onSelectionsChange={() => undefined} />);
    expect(html).not.toContain("oh-story-playback-takes");
  });

  it("shows the dub switcher when a shot has multiple dub tracks", () => {
    const dubbed = parseEpisodeProduction({
      [`${episode}/分镜.md`]: "## SHOT-EP001-001 · 门外停步\n- 目的：先停住。\n"
    }, episode, [{ path: `${episode}/配音/SHOT-EP001-001.wav` }, { path: `${episode}/配音/SHOT-EP001-001-take2.wav` }]);
    const html = renderToStaticMarkup(<DramaPlayback sessionId="sess-1" production={dubbed} versions={[]} selections={{}} episodeName="EP001" onSelectionsChange={() => undefined} />);
    expect(html).toContain("配音版本");
    expect(html).toContain("P1");
    expect(html).toContain("P2");
  });
});
