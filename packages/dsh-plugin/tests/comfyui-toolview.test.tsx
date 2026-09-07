import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolCallBlock } from "@deepseek-ai/dsh-client-ui-conversation/client";
import type { ToolCallViewProps } from "@deepseek-ai/dsh-client-ui-tool/client";
import {
  ComfyuiToolView,
  countComfyuiFilesByKind,
  formatComfyuiSummaryCount,
  isComfyuiImagePath,
  parseComfyuiResultText,
  resolveComfyuiToolResult
} from "../src/client/comfyui-toolview.js";

const SUCCESS_TEXT = [
  "ComfyUI 生成完成：共 2 个文件，落在 cover，耗时 12.3s。",
  "- cover/comfyui-1.png（1024 字节）",
  "- cover/comfyui-2.png（2048 字节）"
].join("\n");

function settledBlock(text: string, isError = false): ToolCallBlock {
  return {
    kind: "tool-result",
    seq: 1,
    time: 0,
    callId: "call-1",
    call: { name: "oh_story_comfyui", argsRaw: "{}" },
    callTime: null,
    content: [{ type: "text", text }],
    isError,
    subCalls: []
  } as ToolCallBlock;
}

function viewProps(block: ToolCallBlock): ToolCallViewProps & { readonly sessionId: string } {
  return { block, sessionId: "sess-1" } as unknown as ToolCallViewProps & { readonly sessionId: string };
}

beforeEach(() => {
  vi.stubGlobal("location", new URL("http://localhost/"));
});

describe("comfyui toolview", () => {
  it("parses files, duration and output dir from the rendered text", () => {
    const parsed = parseComfyuiResultText(SUCCESS_TEXT);
    expect(parsed?.files).toEqual([
      { path: "cover/comfyui-1.png", bytes: 1024 },
      { path: "cover/comfyui-2.png", bytes: 2048 }
    ]);
    expect(parsed?.durationMs).toBeCloseTo(12300);
    expect(parsed?.outputDir).toBe("cover");
  });

  it("renders one lazy img per image file with the media endpoint url", () => {
    const html = renderToStaticMarkup(<ComfyuiToolView {...viewProps(settledBlock(SUCCESS_TEXT))} />);
    expect(html).toContain("ComfyUI 生成");
    expect(html).toContain("图片 2 张");
    expect(html).toContain("2 个文件");
    expect(html).toContain("耗时 12.3s");
    const imgs = html.match(/<img/g) ?? [];
    expect(imgs).toHaveLength(2);
    expect(html).toContain("loading=\"lazy\"");
    expect(html).toContain("/oh-story/media?sessionId=sess-1");
    expect(html).not.toContain("<pre>");
  });

  it("renders non-image paths as file links instead of img", () => {
    const text = "ComfyUI 生成完成：共 1 个文件，落在 other，耗时 3.0s。\n- other/notes.txt（512 字节）";
    const html = renderToStaticMarkup(<ComfyuiToolView {...viewProps(settledBlock(text))} />);
    expect(html).not.toContain("<img");
    expect(html).toContain("other/notes.txt");
    expect(html).toContain("<a ");
  });

  it("summarizes mixed image and audio results by kind", () => {
    const text = [
      "ComfyUI 生成完成：共 2 个文件，落在 mix，耗时 3.0s。",
      "- mix/cover.png（1024 字节）",
      "- mix/voice.wav（2048 字节）"
    ].join("\n");
    const html = renderToStaticMarkup(<ComfyuiToolView {...viewProps(settledBlock(text))} />);
    expect(html).toContain("图片 1 张 · 音频 1 个");
    expect(html).toContain("<img");
    expect(html).toContain("<audio");
    expect(html).toContain("mix/voice.wav");
  });

  it("renders pure video results with an inline video player", () => {
    const text = "ComfyUI 生成完成：共 1 个文件，落在 video，耗时 3.0s。\n- video/clip.mp4（512 字节）";
    const html = renderToStaticMarkup(<ComfyuiToolView {...viewProps(settledBlock(text))} />);
    expect(html).toContain("视频 1 个");
    expect(html).not.toContain("<img");
    expect(html).toContain("<video");
    expect(html).toContain("preload=\"metadata\"");
    expect(html).toContain("video/clip.mp4");
  });

  it("renders pure audio results with an inline audio player", () => {
    const text = "ComfyUI 生成完成：共 2 个文件，落在 audio，耗时 3.0s。\n- audio/a.mp3（512 字节）\n- audio/b.flac（1024 字节）";
    const html = renderToStaticMarkup(<ComfyuiToolView {...viewProps(settledBlock(text))} />);
    expect(html).toContain("音频 2 个");
    expect(html).not.toContain("<img");
    const audios = html.match(/<audio/g) ?? [];
    expect(audios).toHaveLength(2);
    expect(html).toContain("preload=\"metadata\"");
  });

  it("counts file kinds and falls back to file count for unknown extensions", () => {
    expect(countComfyuiFilesByKind([
      { path: "cover/a.png", bytes: 1 },
      { path: "video/b.MP4", bytes: 2 },
      { path: "audio/c.OGG", bytes: 3 },
      { path: "other/notes.txt", bytes: 4 },
      { path: "other/noext", bytes: 5 }
    ])).toEqual({ images: 1, videos: 1, audios: 1, other: 2 });
    expect(formatComfyuiSummaryCount([{ path: "other/notes.txt", bytes: 1 }])).toBe("1 个文件");
  });

  it("falls back to raw text when the structure is abnormal", () => {
    const text = "ComfyUI 生成完成：但没有文件清单。";
    expect(resolveComfyuiToolResult(settledBlock(text))).toBeUndefined();
    const html = renderToStaticMarkup(<ComfyuiToolView {...viewProps(settledBlock(text))} />);
    expect(html).toContain("<pre>");
    expect(html).toContain("但没有文件清单");
  });

  it("never takes over error results", () => {
    const block = settledBlock(SUCCESS_TEXT, true);
    expect(resolveComfyuiToolResult(block)).toBeUndefined();
    const html = renderToStaticMarkup(<ComfyuiToolView {...viewProps(block)} />);
    expect(html).toContain("失败");
    expect(html).not.toContain("<img");
  });

  it("matches image extensions case-insensitively", () => {
    expect(isComfyuiImagePath("cover/A.PNG")).toBe(true);
    expect(isComfyuiImagePath("cover/a.webp")).toBe(true);
    expect(isComfyuiImagePath("video/clip.mp4")).toBe(false);
    expect(isComfyuiImagePath("cover/noext")).toBe(false);
  });
});
