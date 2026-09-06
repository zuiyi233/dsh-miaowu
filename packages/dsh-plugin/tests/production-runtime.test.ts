import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activeProductionJobId,
  assemblePlaybackShots,
  clampPlaybackImageSeconds,
  createPendingJob,
  mediaTargetFromPath,
  mediaVersionMatchesJob,
  playbackImageDelayMs,
  playbackNextIndex,
  playbackPromptSnippet,
  playbackShouldStop,
  schedulePlaybackImageAdvance,
  summarizeEpisodeOutput,
  queuedItemForJob,
  reconcileProductionJobs,
  reconcileSequence,
  reorderSequence,
  sequenceIssues,
  type ProductionMediaVersion
} from "../src/client/production-runtime.js";

describe("production runtime", () => {
  it("creates a DSH-session production job without owning a second runtime", () => {
    const pending = createPendingJob({ id: "local-1", targetId: "SHOT-EP001-001", kind: "video", prompt: "动作" });
    expect(pending).toMatchObject({ id: "local-1", targetId: "SHOT-EP001-001", kind: "video", status: "pending", progress: 0, expectedOutputs: 1, completedOutputs: 0 });
    expect(pending).not.toHaveProperty("remoteTaskId");
    expect(pending.outputs).toBeUndefined();
  });

  it("lets declared outputs drive the expected count", () => {
    const declared = createPendingJob({
      id: "job-out",
      targetId: "SHOT-001",
      kind: "image",
      prompt: "p",
      expectedOutputs: 5,
      outputs: ["a-job-out.png", "b-job-out.png"]
    });
    expect(declared.outputs).toEqual(["a-job-out.png", "b-job-out.png"]);
    expect(declared.expectedOutputs).toBe(2);
  });

  it("distinguishes an exact DSH queue item from the current running turn", () => {
    const running = createPendingJob({ id: "job-running", targetId: "SHOT-001", kind: "image", prompt: "a" });
    const queued = createPendingJob({ id: "job-queued", targetId: "SHOT-002", kind: "video", prompt: "b" });
    const queue = [{ id: "message-1", preview: "/short-drama-produce 任务 ID：job-queued" }];

    expect(queuedItemForJob(queued.id, queue)?.id).toBe("message-1");
    expect(activeProductionJobId([running, queued], queue, true)).toBe("job-running");
    expect(activeProductionJobId([running, queued], queue, false)).toBeUndefined();
  });

  it("associates media through exact path tokens instead of substring guesses", () => {
    expect(mediaTargetFromPath("剧集/EP001/制作成果/SHOT-EP001-010/result.mp4", ["SHOT-EP001-001", "SHOT-EP001-010"])).toBe("SHOT-EP001-010");
    expect(mediaTargetFromPath("剧集/EP001/制作成果/misc/SHOT-EP001-0100-result.mp4", ["SHOT-EP001-010"])).toBeUndefined();
    const version = { id: "opaque", targetId: "SHOT-001", kind: "video" as const, url: "/media", path: "剧集/EP001/SHOT-001-job-10.mp4" };
    expect(mediaVersionMatchesJob(version, "job-10")).toBe(true);
    expect(mediaVersionMatchesJob(version, "job-1")).toBe(false);
  });

  it("reconciles and reorders the delivery sequence while reporting missing shots", () => {
    const versions: ProductionMediaVersion[] = [{
      id: "image-v1", targetId: "SHOT-EP001-001", kind: "image", url: "/oh-story/media", path: "剧集/EP001/制作成果/1.png"
    }, {
      id: "video-v1", targetId: "SHOT-EP001-001", kind: "video", url: "/oh-story/media", path: "剧集/EP001/制作成果/1.mp4"
    }];
    const sequence = reconcileSequence(["SHOT-EP001-001", "SHOT-EP001-002"], [], versions, { "SHOT-EP001-001": "image-v1" });
    expect(sequence[0]?.versionId).toBe("video-v1");
    expect(sequence.map((item) => item.shotId)).toEqual(["SHOT-EP001-001", "SHOT-EP001-002"]);
    expect(sequenceIssues(sequence, versions)).toEqual(["SHOT-EP001-002 缺少已选视频版本"]);
    expect(reorderSequence(sequence, 1, 0).map((item) => item.shotId)).toEqual(["SHOT-EP001-002", "SHOT-EP001-001"]);
    expect(reorderSequence(sequence, 0, 9).map((item) => item.shotId)).toEqual(["SHOT-EP001-001", "SHOT-EP001-002"]);
  });

  it("does not turn an ended paid dispatch into an automatically retryable failure", () => {
    const running = { ...createPendingJob({ id: "paid-1", targetId: "SHOT-001", kind: "video", prompt: "p", expectedOutputs: 2 }), status: "running" as const };
    const unknown = reconcileProductionJobs([running], [], false, [])[0]!;
    expect(unknown).toMatchObject({
      status: "dispatched_unknown",
      error: expect.stringContaining("避免重复计费")
    });
    const partial = { id: "workspace:paid-1.mp4", targetId: "SHOT-001", kind: "video" as const, url: "/media", path: "paid-1.mp4" };
    expect(reconcileProductionJobs([unknown], [], false, [partial])[0]).toMatchObject({
      status: "dispatched_unknown",
      completedOutputs: 1,
      error: expect.stringContaining("已发现 1/2")
    });
  });

  it("keeps a prepared job awaiting explicit confirmation until the Agent tracks its dispatch", () => {
    const prepared = {
      ...createPendingJob({ id: "prepare-1", targetId: "SHOT-001", kind: "image", prompt: "p" }),
      status: "awaiting_confirmation" as const
    };
    expect(reconcileProductionJobs([prepared], [], false, [])[0]).toEqual(prepared);
    expect(activeProductionJobId([prepared], [], true)).toBe("prepare-1");
  });
});

describe("paid-job reconciliation regressions", () => {
  it("does not mark a job queued because another job's prompt quotes its id", () => {
    const queue = [{ id: "q1", preview: "合成成片 任务 ID：compose-9 顺序：剧集/EP001/制作成果/paid-1-001.mp4" }];
    expect(queuedItemForJob("paid-1", queue)).toBeUndefined();
    expect(queuedItemForJob("compose-9", queue)?.id).toBe("q1");
  });

  it("clears the end-of-turn billing warning once outputs start landing", () => {
    const stale = {
      ...createPendingJob({ id: "paid-2", targetId: "SHOT-001", kind: "video", prompt: "p", expectedOutputs: 2 }),
      status: "dispatched_unknown" as const,
      error: "DSH Turn 已结束，尚未发现关联成果。"
    };
    const versions: ProductionMediaVersion[] = [{
      id: "v1", targetId: "SHOT-001", kind: "video", url: "/oh-story/media", path: "剧集/EP001/制作成果/paid-2-001.mp4"
    }];
    const next = reconcileProductionJobs([stale], [], true, versions)[0]!;
    expect(next.status).toBe("running");
    expect(next.completedOutputs).toBe(1);
    expect(next.error).toBeUndefined();
  });
});


describe("drama playback assembly", () => {
  const shots = [
    { id: "SHOT-A-001", title: "开场", purpose: "定调", shotSpec: "远景", start: "门开", end: "人入", keyframePrompt: "人物站在门外" },
    { id: "SHOT-A-002", title: "对峙", motionPrompt: "两人缓慢靠近" },
    { id: "SHOT-A-003", title: "空镜" }
  ];
  const versions: ProductionMediaVersion[] = [
    { id: "img-1", targetId: "SHOT-A-001", kind: "image", url: "/m/1.png", path: "剧集/EP001/制作成果/SHOT-A-001.png" },
    { id: "vid-1", targetId: "SHOT-A-001", kind: "video", url: "/m/1.mp4", path: "剧集/EP001/制作成果/SHOT-A-001.mp4" },
    { id: "img-2", targetId: "SHOT-A-002", kind: "image", url: "/m/2.png", path: "剧集/EP001/制作成果/SHOT-A-002.png" }
  ];

  it("keeps document order, resolves selected media and leaves missing shots empty", () => {
    const assembled = assemblePlaybackShots(shots, versions, {});
    expect(assembled.map((shot) => shot.shotId)).toEqual(["SHOT-A-001", "SHOT-A-002", "SHOT-A-003"]);
    expect(assembled.map((shot) => shot.index)).toEqual([0, 1, 2]);
    expect(assembled[0]?.image?.id).toBe("img-1");
    expect(assembled[0]?.video?.id).toBe("vid-1");
    expect(assembled[1]?.image?.id).toBe("img-2");
    expect(assembled[1]?.video).toBeUndefined();
    expect(assembled[2]?.image).toBeUndefined();
    expect(assembled[2]?.video).toBeUndefined();
    expect(assembled[0]?.caption).toContain("定调");
    expect(assembled[0]?.promptSummary).toBe("人物站在门外");
    expect(assembled[1]?.promptSummary).toBe("两人缓慢靠近");
  });

  it("honours explicit version selections and keeps the audio hook frozen", () => {
    const extra: ProductionMediaVersion = { id: "img-1b", targetId: "SHOT-A-001", kind: "image", url: "/m/1b.png", path: "剧集/EP001/制作成果/SHOT-A-001-b.png" };
    const assembled = assemblePlaybackShots(
      [{ ...shots[0]!, audio: [{ path: "剧集/EP001/制作成果/MUSIC-A.mp3", label: "配乐" }] }],
      [...versions, extra],
      { "SHOT-A-001": "img-1b" }
    );
    expect(assembled[0]?.image?.id).toBe("img-1b");
    expect(assembled[0]?.audio).toEqual([{ path: "剧集/EP001/制作成果/MUSIC-A.mp3", label: "配乐" }]);
  });

  it("summarises prompts and clamps the still duration", () => {
    expect(playbackPromptSnippet("  江辰站在旧门外，\n右手悬停。  ")).toBe("江辰站在旧门外， 右手悬停。");
    expect(playbackPromptSnippet("")).toBeUndefined();
    expect(playbackPromptSnippet(undefined)).toBeUndefined();
    expect(playbackPromptSnippet("x".repeat(100), 48)?.length).toBeLessThanOrEqual(49);
    expect(clampPlaybackImageSeconds(4)).toBe(4);
    expect(clampPlaybackImageSeconds(0)).toBe(1);
    expect(clampPlaybackImageSeconds(99)).toBe(30);
    expect(clampPlaybackImageSeconds(Number.NaN)).toBe(4);
    expect(playbackImageDelayMs(4)).toBe(4000);
  });
});

describe("drama playback autoplay state machine", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("steps prev/next with clamping and holds on the last shot for timer events", () => {
    expect(playbackNextIndex(0, 3, "next")).toBe(1);
    expect(playbackNextIndex(2, 3, "next")).toBe(2);
    expect(playbackNextIndex(1, 3, "image-timer")).toBe(2);
    expect(playbackNextIndex(2, 3, "video-ended")).toBe(2);
    expect(playbackNextIndex(1, 3, "prev")).toBe(0);
    expect(playbackNextIndex(0, 3, "prev")).toBe(0);
    expect(playbackNextIndex(5, 3, "next")).toBe(2);
    expect(playbackNextIndex(0, 0, "image-timer")).toBe(0);
    expect(playbackShouldStop(3, 2)).toBe(true);
    expect(playbackShouldStop(3, 1)).toBe(false);
    expect(playbackShouldStop(0, 0)).toBe(true);
  });

  it("fires the image advance once after the still duration", () => {
    vi.useFakeTimers();
    const onAdvance = vi.fn();
    const cancel = schedulePlaybackImageAdvance(onAdvance, 4);
    expect(onAdvance).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3999);
    expect(onAdvance).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onAdvance).toHaveBeenCalledTimes(1);
    cancel();
  });

  it("cancels the pending advance on pause", () => {
    vi.useFakeTimers();
    const onAdvance = vi.fn();
    const cancel = schedulePlaybackImageAdvance(onAdvance, 4);
    cancel();
    vi.advanceTimersByTime(10_000);
    expect(onAdvance).not.toHaveBeenCalled();
  });
});

describe("episode output ledger", () => {
  it("aggregates succeeded jobs plus unclaimed workspace media per kind", () => {
    const jobs = [
      { ...createPendingJob({ id: "img-job", targetId: "SHOT-A-001", kind: "image", prompt: "p" }), status: "succeeded" as const },
      { ...createPendingJob({ id: "vid-job", targetId: "SHOT-A-001", kind: "video", prompt: "p" }), status: "running" as const },
      { ...createPendingJob({ id: "compose-job", targetId: "剧集/EP001", kind: "composition", prompt: "p" }), status: "pending" as const }
    ];
    const versions: ProductionMediaVersion[] = [
      { id: "v-img", targetId: "SHOT-A-001", kind: "image", url: "/m/a.png", path: "剧集/EP001/制作成果/img-job-a.png" },
      { id: "v-loose", targetId: "SHOT-A-002", kind: "image", url: "/m/b.png", path: "剧集/EP001/制作成果/SHOT-A-002.png" },
      { id: "v-vid", targetId: "SHOT-A-001", kind: "video", url: "/m/c.mp4", path: "剧集/EP001/制作成果/SHOT-A-001.mp4" }
    ];
    expect(summarizeEpisodeOutput(jobs, versions)).toEqual([
      { kind: "image", produced: 2, running: 0 },
      { kind: "video", produced: 1, running: 2 },
      { kind: "music", produced: 0, running: 0 }
    ]);
  });
});
