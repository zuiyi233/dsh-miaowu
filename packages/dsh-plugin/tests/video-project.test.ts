import { describe, expect, it } from "vitest";
import { skipVideoDirectory, summarizeVideoProject, videoProjectRoot, visibleVideoPath, type VideoWorkspaceFile } from "../src/video-project.js";

function file(path: string, kind: "text" | "media" = "text", mimeType?: string): VideoWorkspaceFile {
  return { path, kind, mimeType, bytes: 42, version: `v:${path}` };
}

describe("video recap project projection", () => {
  it("keeps the Studio manifest-driven and hides high-volume working files", () => {
    expect(visibleVideoPath("video-recaps/demo/work/recap_run_manifest.json")).toBe(true);
    expect(visibleVideoPath("video-recaps/demo/work/frames/frame-00001.jpg")).toBe(false);
    expect(visibleVideoPath("video-recaps/demo/work/tts_segments/narr_001.wav")).toBe(true);
    expect(visibleVideoPath("video-recaps/demo/work/tts_segments/narr_001.mp3")).toBe(true);
    expect(visibleVideoPath("video-recaps/demo/work/tts_segments/notes.txt")).toBe(false);
    expect(visibleVideoPath("video-recaps/demo/work/frames/frame-00001.mp4")).toBe(false);
    expect(visibleVideoPath("video-recaps/demo/sources/input.mp4")).toBe(true);
    expect(skipVideoDirectory("video-recaps/demo/work/frames")).toBe(true);
    expect(skipVideoDirectory("video-recaps/demo/work/tts_segments")).toBe(false);
  });

  it("summarizes authoritative artifacts without creating a second lifecycle truth", () => {
    const root = "video-recaps/demo";
    const files = [
      file(`${root}/project.json`),
      file(`${root}/sources/source.mp4`, "media", "video/mp4"),
      file(`${root}/work/recap_run_manifest.json`),
      file(`${root}/work/clip_plan.json`),
      file(`${root}/work/edited_source.mp4`, "media", "video/mp4"),
      file(`${root}/work/assembly_manifest.json`),
      file(`${root}/outputs/recap_demo.mp4`, "media", "video/mp4")
    ];
    const summary = summarizeVideoProject(root, files, {
      project: { title: "Demo Recap" },
      runManifest: { source_video: `${root}/sources/source.mp4`, settings: { edit_mode: "cut" } },
      assembly: { final_output: "/workspace/video-recaps/demo/outputs/recap_demo.mp4" }
    });
    expect(summary.title).toBe("Demo Recap");
    expect(summary.state).toBe("ready");
    expect(summary.stageLabel).toBe("成片已就绪");
    expect(summary.previews.map((item) => item.role)).toEqual(["source", "edited", "final"]);
  });

  it("reports the two upstream cut-mode pauses", () => {
    const root = "video-recaps/cut";
    const base = [file(`${root}/sources/source.mp4`, "media", "video/mp4"), file(`${root}/work/recap_run_manifest.json`)];
    const passOne = summarizeVideoProject(root, base, { runManifest: { settings: { edit_mode: "cut" } } });
    expect(passOne).toMatchObject({ state: "waiting", nextArtifact: "clip_plan.json" });
    const passTwo = summarizeVideoProject(root, [...base, file(`${root}/work/clip_plan.json`), file(`${root}/work/edited_source.mp4`, "media", "video/mp4")], { runManifest: { settings: { edit_mode: "cut" } } });
    expect(passTwo).toMatchObject({ state: "waiting", nextArtifact: "narration.json" });
  });

  it("validates one-level project roots", () => {
    expect(videoProjectRoot("video-recaps/我的项目/work/timeline.json")).toBe("video-recaps/我的项目");
    expect(videoProjectRoot("video-recaps/.hidden/work/timeline.json")).toBeUndefined();
    expect(videoProjectRoot("正文/demo.md")).toBeUndefined();
  });

  it("lists tts_meta.json as a manifest artifact", () => {
    const root = "video-recaps/voice";
    const summary = summarizeVideoProject(root, [file(`${root}/work/tts_meta.json`)], {});
    expect(summary.artifacts).toEqual([{ label: "配音元数据", kind: "manifest", path: `${root}/work/tts_meta.json`, version: `v:${root}/work/tts_meta.json` }]);
  });

  it("reads engine/partial/failures from ttsMeta without demoting state", () => {
    const root = "video-recaps/voice";
    const files = [
      file(`${root}/sources/source.mp4`, "media", "video/mp4"),
      file(`${root}/work/narration.json`),
      file(`${root}/work/tts_meta.json`)
    ];
    const healthy = summarizeVideoProject(root, files, {
      runManifest: { source_video: `${root}/sources/source.mp4` },
      ttsMeta: { engine: "comfyui-local", partial: false, failures: [], segments: [{ index: 1 }] }
    });
    expect(healthy).toMatchObject({ state: "working", stage: "assemble", stageLabel: "正在合成", voiceEngine: "comfyui-local" });
    const bad = summarizeVideoProject(root, files, {
      runManifest: { source_video: `${root}/sources/source.mp4` },
      ttsMeta: { engine: "comfyui-local", partial: true, failures: [{ index: 2 }, { index: 5 }] }
    });
    expect(bad.state).toBe("working");
    expect(bad.stage).toBe("assemble");
    expect(bad.stageLabel).toBe("正在合成 · 配音不完整（partial） · 2 段失败");
    expect(bad.voiceEngine).toBe("comfyui-local");
  });

  it("leaves legacy projects without ttsMeta untouched", () => {
    const root = "video-recaps/legacy";
    const files = [
      file(`${root}/sources/source.mp4`, "media", "video/mp4"),
      file(`${root}/work/recap_run_manifest.json`),
      file(`${root}/work/narration.json`),
      file(`${root}/work/tts_meta.json`)
    ];
    const metadata = { runManifest: { source_video: `${root}/sources/source.mp4` } };
    const withAbsent = summarizeVideoProject(root, files, metadata);
    const withUndefinedFields = summarizeVideoProject(root, files, { ...metadata, ttsMeta: undefined });
    expect(withUndefinedFields).toEqual(withAbsent);
    expect(withAbsent.voiceEngine).toBeUndefined();
    expect(withAbsent).toMatchObject({ state: "working", stage: "assemble", stageLabel: "正在合成" });
  });
});
