import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AudiobookView, generateConfirmText, parsedSegmentCount } from "../src/client/features/audiobook-feature.js";
import type { AudiobookOverview, AudiobookProjectView, AudiobookScriptRecord } from "../src/services/audiobook-contract.js";
import { CREATIVE_DIRECTORIES, mediaMimeTypeForPath } from "../src/workspace-route.js";

const PROJECT = {
  schemaVersion: 1 as const,
  source: { bookRoot: "正文", chapters: ["正文/第0001章_开篇.md"] },
  tts: { baseUrl: "https://api.example.com/v1", model: "tts-1", responseFormat: "mp3" as const, speed: 1, pricePerMillionChars: 15, maxCharsPerChapter: 20000, concurrency: 2 },
  cast: [{ id: "narrator", name: "旁白", kind: "narrator" as const, voice: "alloy" }],
  cues: [],
  export: { mp3BitrateKbps: 192, sampleRate: 44100, channels: 2, loudnessLufs: -16, truePeakDbtp: -1.5, subtitles: [] },
  rights: { voiceCloning: false as const },
};

const overviewWithProject = (): AudiobookOverview => ({
  projects: [{ path: "有声剧/长夜行/project.json", name: "长夜行", bookRoot: "正文", chapters: 1 }],
  sources: [{ bookRoot: "正文", name: "正文", chapters: ["正文/第0001章_开篇.md"] }],
  errors: [],
  preflight: { ttsKey: "present", ttsHost: "api.example.com", ffmpeg: true, ffprobe: true },
});

const projectView = (): AudiobookProjectView => ({
  record: { project: PROJECT, path: "有声剧/长夜行/project.json", version: "v1" },
  chapters: [{
    sourcePath: "正文/第0001章_开篇.md",
    chapter: "第0001章_开篇",
    scriptPath: "有声剧/长夜行/脚本/第0001章_开篇.json",
    hasScript: true,
    segmentCount: 2,
    unassignedSegments: 0,
    audioPath: "有声剧/长夜行/音频/第0001章_开篇.mp3",
    jobId: null,
    jobStatus: null,
  }],
  preflight: { ttsKey: "present", ttsHost: "api.example.com", ffmpeg: true, ffprobe: true },
});

const noop = (): void => undefined;

describe("AudiobookView", () => {
  it("空项目展示来源与创建入口，缺密钥/缺 ffmpeg 明确提示", () => {
    const html = renderToStaticMarkup(<AudiobookView
      overview={{ projects: [], sources: [{ bookRoot: "正文", name: "正文", chapters: ["正文/第1章.md"] }], errors: [], preflight: { ttsKey: "missing", ttsHost: null, ffmpeg: false, ffprobe: false } }}
      busy={false}
      onRefresh={() => undefined}
      onCreate={() => undefined}
      onParse={() => undefined}
      onDryRun={() => undefined}
      onGenerate={() => undefined}
      onExport={() => undefined}
    />);
    expect(html).toContain("有声剧");
    expect(html).toContain("缺少 OH_STORY_TTS_API_KEY");
    expect(html).toContain("ffmpeg 未就绪");
    expect(html).toContain("ffprobe 未就绪");
    expect(html).toContain("创建项目");
    expect(html).toContain("正文");
    expect(html).not.toContain("<audio");
  });

  it("项目视图展示章节、成本与导出入口", () => {
    const html = renderToStaticMarkup(<AudiobookView
      overview={overviewWithProject()}
      view={projectView()}
      estimate={{ segments: 2, chars: 6, cacheHits: 0, requests: 2, estimatedCost: 0.00009 }}
      busy={false}
      onRefresh={() => undefined}
      onCreate={() => undefined}
      onParse={() => undefined}
      onDryRun={() => undefined}
      onGenerate={() => undefined}
      onExport={() => undefined}
    />);
    expect(html).toContain("第0001章_开篇");
    expect(html).toContain("估算成本");
    expect(html).toContain("解析");
    expect(html).toContain("生成");
    expect(html).toContain("导出 MP3");
  });

  it("只有提供 audioUrl 且章节有音频时才渲染播放器", () => {
    const props = {
      overview: overviewWithProject(),
      view: projectView(),
      busy: false,
      onRefresh: noop,
      onCreate: noop,
      onParse: noop,
      onDryRun: noop,
      onGenerate: noop,
      onExport: noop,
    };
    const withoutUrl = renderToStaticMarkup(<AudiobookView {...props} />);
    expect(withoutUrl).not.toContain("<audio");
    const withUrl = renderToStaticMarkup(<AudiobookView
      {...props}
      audioUrl={(path) => `/media/${path}`}
    />);
    expect(withUrl).toContain("<audio");
    expect(withUrl).toContain("/media/有声剧/长夜行/音频/第0001章_开篇.mp3");
  });

  it("有声剧进入创作目录白名单并支持 MP3 媒体预览", () => {
    expect(CREATIVE_DIRECTORIES).toContain("有声剧");
    expect(mediaMimeTypeForPath("有声剧/x.mp3")).toBe("audio/mpeg");
  });

  it("有声剧排在叙事目录之后,避免共享文件上限先被脚本/音频耗尽", () => {
    const audiobook = CREATIVE_DIRECTORIES.indexOf("有声剧");
    expect(audiobook).toBeGreaterThan(-1);
    for (const prose of ["正文", "大纲", "设定"] as const) {
      expect(CREATIVE_DIRECTORIES.indexOf(prose)).toBeGreaterThan(-1);
      expect(CREATIVE_DIRECTORIES.indexOf(prose)).toBeLessThan(audiobook);
    }
  });

  it("解析脚本响应按路由的真实嵌套形状取段数", () => {
    const payload = {
      script: {
        path: "有声剧/长夜行/脚本/第0001章_开篇.json",
        version: "v5",
        script: {
          schemaVersion: 1 as const,
          chapter: "第0001章_开篇",
          sourcePath: "正文/第0001章_开篇.md",
          sourceSha256: "a".repeat(64),
          segments: [
            { id: "s-1", kind: "narration" as const, speakerId: "narrator", text: "你好。", sourceStart: 0, sourceEnd: 3 },
            { id: "s-2", kind: "dialogue" as const, speakerId: "unknown", text: "走吧。", sourceStart: 3, sourceEnd: 6 },
          ],
        },
      },
      assignmentSummary: { preserved: 0, dropped: 0 },
    };

    expect(parsedSegmentCount(payload)).toBe(2);
  });

  it("未指派对白显示计数并禁用估算/生成/导出，分段入口仍可用", () => {
    const base = projectView();
    const blocked: AudiobookProjectView = {
      ...base,
      chapters: [{ ...base.chapters[0]!, unassignedSegments: 2 }],
    };
    const html = renderToStaticMarkup(<AudiobookView
      overview={overviewWithProject()}
      view={blocked}
      busy={false}
      onRefresh={noop}
      onCreate={noop}
      onParse={noop}
      onDryRun={noop}
      onGenerate={noop}
      onExport={noop}
      onLoadSegments={noop}
    />);

    expect(html).toContain("未指派 2");
    expect(html).toContain("有 2 段对白未指派说话人");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>估算<\/button>/u);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>生成<\/button>/u);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>导出 MP3<\/button>/u);
    expect(html).toMatch(/<button[^>]*>分段<\/button>/u);
  });

  it("角色编辑器展示音色映射，可增删角色", () => {
    const base = projectView();
    const multi: AudiobookProjectView = {
      ...base,
      record: {
        ...base.record,
        project: {
          ...base.record.project,
          cast: [
            ...base.record.project.cast,
            { id: "role-linfan", name: "林帆", kind: "character", voice: "verse" },
            { id: "role-shen", name: "沈秋", kind: "character", voice: "echo" },
          ],
        },
      },
    };
    const html = renderToStaticMarkup(<AudiobookView
      overview={overviewWithProject()}
      view={multi}
      busy={false}
      onRefresh={noop}
      onCreate={noop}
      onParse={noop}
      onDryRun={noop}
      onGenerate={noop}
      onExport={noop}
      onSaveCast={noop}
    />);

    expect(html).toContain("角色与音色");
    expect(html).toContain("林帆");
    expect(html).toContain("沈秋");
    expect(html).toContain("role-linfan");
    expect(html).toContain("添加角色");
    expect(html).toContain("保存角色");
  });

  it("分段编辑器列出旁白与对白，未指派对白高亮并给出原因", () => {
    const record: AudiobookScriptRecord = {
      path: "有声剧/长夜行/脚本/第0001章_开篇.json",
      version: "v9",
      script: {
        schemaVersion: 1,
        chapter: "第0001章_开篇",
        sourcePath: "正文/第0001章_开篇.md",
        sourceSha256: "a".repeat(64),
        segments: [
          { id: "s-1", kind: "narration", speakerId: "narrator", text: "旁白。", sourceStart: 0, sourceEnd: 3 },
          { id: "s-2", kind: "dialogue", speakerId: "unknown", text: "走吧。", sourceStart: 3, sourceEnd: 6 },
        ],
      },
    };
    const base = projectView();
    const multi: AudiobookProjectView = {
      ...base,
      record: {
        ...base.record,
        project: {
          ...base.record.project,
          cast: [...base.record.project.cast, { id: "role-linfan", name: "林帆", kind: "character", voice: "verse" }],
        },
      },
    };
    const html = renderToStaticMarkup(<AudiobookView
      overview={overviewWithProject()}
      view={multi}
      busy={false}
      onRefresh={noop}
      onCreate={noop}
      onParse={noop}
      onDryRun={noop}
      onGenerate={noop}
      onExport={noop}
      segments={{ chapter: "第0001章_开篇", record }}
      onSaveAssignments={noop}
      onCloseSegments={noop}
    />);

    expect(html).toContain("分段指派 · 第0001章_开篇");
    expect(html).toContain("旁白。");
    expect(html).toContain("走吧。");
    expect(html).toContain("林帆");
    expect(html).toContain("还有 1 段对白未指派说话人");
    expect(html).toContain("data-unassigned");
    expect(html).toContain("保存指派");
  });

  it("生成确认文案包含费用、请求数、缓存命中与段数", () => {
    const text = generateConfirmText("第0001章_开篇", {
      segments: 12,
      chars: 2_400,
      cacheHits: 3,
      requests: 9,
      estimatedCost: 0.00123,
    });

    expect(text).toContain("第0001章_开篇");
    expect(text).toContain("12 段");
    expect(text).toContain("9 次请求");
    expect(text).toContain("缓存命中 3 段");
    expect(text).toContain("¥0.001230");
    expect(text).toContain("确认开始生成");
  });
});
