import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activeProductionJobId,
  assemblePlaybackShots,
  clampPlaybackImageSeconds,
  compositionInFlight,
  createPendingJob,
  mediaTargetFromPath,
  mediaVersionMatchesJob,
  playbackImageDelayMs,
  playbackNextIndex,
  playbackPromptSnippet,
  playbackShouldStop,
  productionQueueFromInbox,
  schedulePlaybackImageAdvance,
  summarizeEpisodeOutput,
  queuedItemForJob,
  reconcileProductionJobs,
  reconcileSequence,
  reorderSequence,
  sequenceIssues,
  settleSupersededCompositions,
  type ProductionJob,
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

  it("reads DSH Queue rows from the inbox projection that replaced SessionSnapshot.queue (#50)", () => {
    const longPrefix = "按顺序执行。".repeat(60);
    const rows = [
      { id: "message-1", content: [{ type: "text", text: `/short-drama-produce ${longPrefix}\n- 任务 ID：job-late` }], source: { kind: "user" } },
      { id: "message-2", content: [{ type: "image", attachment: {} }, { type: "text", text: "任务 ID：job-claimed" }], source: { kind: "user", rpcId: "rpc-2" } },
      { id: 7, content: [] },
      null
    ];

    const queue = productionQueueFromInbox(rows, new Set(["rpc-2"]));
    expect(queue.map((item) => item.id)).toEqual(["message-1"]);
    // The label sits past the 200-character preview DSH 0.1.5 used to hand out.
    expect(queuedItemForJob("job-late", queue)?.id).toBe("message-1");
    expect(queuedItemForJob("job-claimed", queue)).toBeUndefined();
    expect(queuedItemForJob("job-claimed", productionQueueFromInbox(rows))?.id).toBe("message-2");
  });

  it("treats an absent inbox projection as an empty DSH Queue", () => {
    expect(productionQueueFromInbox(undefined)).toEqual([]);
    expect(productionQueueFromInbox({ "next-turn": [] })).toEqual([]);
  });

  it("associates media through exact path tokens instead of substring guesses", () => {
    expect(mediaTargetFromPath("剧集/EP001/制作成果/SHOT-EP001-010/result.mp4", ["SHOT-EP001-001", "SHOT-EP001-010"])).toBe("SHOT-EP001-010");
    expect(mediaTargetFromPath("剧集/EP001/制作成果/misc/SHOT-EP001-0100-result.mp4", ["SHOT-EP001-010"])).toBeUndefined();
    const version = { id: "opaque", targetId: "SHOT-001", kind: "video" as const, url: "/media", path: "剧集/EP001/SHOT-001-job-10.mp4" };
    expect(mediaVersionMatchesJob(version, "job-10")).toBe(true);
    expect(mediaVersionMatchesJob(version, "job-1")).toBe(false);
  });

  it("never reads edit-stage files under 制作成果/成片/ as a new shot version", () => {
    const targets = ["SHOT-EP001-001", "MOTION-EP001-001"];
    // Clips the edit stage normalised to the delivery spec may carry the MOTION or shot ID.
    expect(mediaTargetFromPath("剧集/EP001/制作成果/成片/规格统一/MOTION-EP001-001.mp4", targets)).toBeUndefined();
    expect(mediaTargetFromPath("剧集/EP001/制作成果/成片/规格统一/SHOT-EP001-001.mp4", targets)).toBeUndefined();
    expect(mediaTargetFromPath("剧集/EP001/制作成果/成片/分段/CUT-EP001-01.mp4", targets)).toBeUndefined();
    // The produce-stage original stays a version of its shot.
    expect(mediaTargetFromPath("剧集/EP001/制作成果/SHOT-EP001-001/SHOT-EP001-001-job-1.mp4", targets)).toBe("SHOT-EP001-001");
  });

  it("completes an assembly job on the newly rendered cut rather than a stale one", () => {
    const cutPath = "剧集/EP001/制作成果/成片/成片.mp4";
    const stale: ProductionMediaVersion = { id: `workspace:${cutPath}:3`, targetId: "剧集/EP001", kind: "video", url: "/media/old", path: cutPath };
    const job = createPendingJob({
      id: "compose-1",
      targetId: "剧集/EP001",
      kind: "composition",
      prompt: "按成片顺序合成",
      outputPath: cutPath,
      supersededOutputIds: [stale.id]
    });

    // short-drama-edit names the cut, not the workbench, so the job id never reaches the filename.
    expect(mediaVersionMatchesJob(stale, job.id)).toBe(false);
    const beforeRender = reconcileProductionJobs([{ ...job, status: "running" }], [], true, [stale]);
    expect(beforeRender[0]).toMatchObject({ status: "running", completedOutputs: 0 });

    const rendered: ProductionMediaVersion = { ...stale, id: `workspace:${cutPath}:4`, url: "/media/new" };
    const afterRender = reconcileProductionJobs([{ ...job, status: "running" }], [], true, [rendered]);
    expect(afterRender[0]).toMatchObject({ status: "succeeded", progress: 100, completedOutputs: 1 });
    expect(afterRender[0]?.output?.id).toBe(rendered.id);
  });

  it("never lets a later cut revive an assembly job the creator canceled or that failed", () => {
    const cutPath = "剧集/EP001/制作成果/成片/成片.mp4";
    const assembly = (id: string) => createPendingJob({
      id, targetId: "剧集/EP001", kind: "composition", prompt: "按成片顺序合成", outputPath: cutPath, supersededOutputIds: []
    });
    // Every composition renders to this one upstream path, so the cut carries no job identity.
    const cut: ProductionMediaVersion = { id: `workspace:${cutPath}:1`, targetId: "剧集/EP001", kind: "video", url: "/media/new", path: cutPath };

    const canceled = reconcileProductionJobs([{ ...assembly("compose-canceled"), status: "canceled" }], [], true, [cut]);
    expect(canceled[0]).toMatchObject({ status: "canceled", progress: 0 });

    const failed = reconcileProductionJobs(
      [{ ...assembly("compose-failed"), status: "failed", error: "CUT-EP001-002 的素材不存在" }], [], true, [cut]
    );
    expect(failed[0]).toMatchObject({ status: "failed", error: "CUT-EP001-002 的素材不存在" });

    // A job keyed on its own id keeps the old behaviour: that output really is its own.
    const legacy = createPendingJob({ id: "compose-legacy", targetId: "剧集/EP001", kind: "composition", prompt: "合成" });
    const legacyCut: ProductionMediaVersion = {
      id: "workspace:legacy:1", targetId: "剧集/EP001", kind: "video", url: "/media", path: "剧集/EP001/制作成果/成片-compose-legacy.mp4"
    };
    expect(reconcileProductionJobs([{ ...legacy, status: "failed" }], [], true, [legacyCut])[0]).toMatchObject({ status: "succeeded" });
  });

  it("keeps a succeeded assembly job pinned to the cut it produced", () => {
    const cutPath = "剧集/EP001/制作成果/成片/成片.mp4";
    const first: ProductionMediaVersion = { id: `workspace:${cutPath}:1`, targetId: "剧集/EP001", kind: "video", url: "/media/1", path: cutPath };
    const job = {
      ...createPendingJob({ id: "compose-1", targetId: "剧集/EP001", kind: "composition", prompt: "合成", outputPath: cutPath, supersededOutputIds: [] }),
      status: "succeeded" as const, output: first, completedOutputs: 1, progress: 100
    };
    const second: ProductionMediaVersion = { ...first, id: `workspace:${cutPath}:2`, url: "/media/2" };
    expect(reconcileProductionJobs([job], [], true, [second])[0]?.output?.id).toBe(first.id);
  });

  it("reports an unsettled composition so a second one cannot claim the same cut", () => {
    const assembly = (id: string, status: ProductionJob["status"]) => ({
      ...createPendingJob({ id, targetId: "剧集/EP001", kind: "composition", prompt: "合成" }), status
    });
    expect(compositionInFlight([])).toBe(false);
    expect(compositionInFlight([assembly("a", "running")])).toBe(true);
    expect(compositionInFlight([assembly("a", "pending")])).toBe(true);
    expect(compositionInFlight([assembly("a", "awaiting_confirmation")])).toBe(true);
    // Settled either way, so re-composing is the creator's call again.
    expect(compositionInFlight([assembly("a", "succeeded"), assembly("b", "canceled"), assembly("c", "failed")])).toBe(false);
    // Per-shot work never blocks assembly.
    expect(compositionInFlight([{ ...assembly("a", "running"), kind: "video" }])).toBe(false);
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
    expect(sequenceIssues(sequence, versions)).toEqual(["SHOT-EP001-002 缺少已选视频或关键帧素材"]);
    expect(reorderSequence(sequence, 1, 0).map((item) => item.shotId)).toEqual(["SHOT-EP001-002", "SHOT-EP001-001"]);
    expect(reorderSequence(sequence, 0, 9).map((item) => item.shotId)).toEqual(["SHOT-EP001-001", "SHOT-EP001-002"]);
  });

  it("prefers the explicitly selected video, then any available video, before a selected keyframe", () => {
    const versions: ProductionMediaVersion[] = [
      { id: "image", targetId: "SHOT-EP001-001", kind: "image", url: "/image", path: "剧集/EP001/制作成果/SHOT-EP001-001/key.png" },
      { id: "video-old", targetId: "SHOT-EP001-001", kind: "video", url: "/old", path: "剧集/EP001/制作成果/SHOT-EP001-001/old.mp4" },
      { id: "video-new", targetId: "SHOT-EP001-001", kind: "video", url: "/new", path: "剧集/EP001/制作成果/SHOT-EP001-001/new.mp4" }
    ];
    expect(reconcileSequence(["SHOT-EP001-001"], [], versions, { "SHOT-EP001-001": "video-old" })[0]?.versionId).toBe("video-old");
    expect(reconcileSequence(["SHOT-EP001-001"], [], versions, { "SHOT-EP001-001": "image" })[0]?.versionId).toBe("video-new");
  });

  it("lets a per-sequence explicit static source override an available video", () => {
    const versions: ProductionMediaVersion[] = [
      { id: "still", targetId: "IMG-EP001-DOOR", kind: "image", url: "/still", path: "剧集/EP001/制作成果/IMG-EP001-DOOR/door.png" },
      { id: "video", targetId: "SHOT-EP001-001", kind: "video", url: "/video", path: "剧集/EP001/制作成果/SHOT-EP001-001/video.mp4" }
    ];
    expect(reconcileSequence(
      ["SHOT-EP001-001"],
      [{ shotId: "SHOT-EP001-001", sourceVersionId: "still", versionId: "still" }],
      versions,
      {},
      "剧集/EP001"
    )).toEqual([{ shotId: "SHOT-EP001-001", sourceVersionId: "still", versionId: "still" }]);
  });

  it("uses an accepted SHOT keyframe or an explicitly selected IMG keyframe when no video exists", () => {
    const versions: ProductionMediaVersion[] = [
      { id: "unselected", targetId: "SHOT-EP001-001", kind: "image", url: "/first", path: "剧集/EP001/制作成果/SHOT-EP001-001/first.png" },
      { id: "selected-img", targetId: "IMG-EP001-DOOR", kind: "image", url: "/door", path: "剧集/EP001/制作成果/IMG-EP001-DOOR/door.png" }
    ];
    expect(reconcileSequence(["SHOT-EP001-001"], [], versions, {})[0]?.versionId).toBe("unselected");
    const staticSequence = reconcileSequence(["SHOT-EP001-001"], [], versions, { "SHOT-EP001-001": "selected-img" });
    expect(staticSequence).toEqual([{ shotId: "SHOT-EP001-001", versionId: "selected-img" }]);
    expect(sequenceIssues(staticSequence, versions)).toEqual([]);
  });

  it("preserves mixed static/video ordering and blocks missing or unreadable material", () => {
    const versions: ProductionMediaVersion[] = [
      { id: "still", targetId: "SHOT-EP001-001", kind: "image", url: "/still", path: "剧集/EP001/制作成果/SHOT-EP001-001/still.png" },
      { id: "video", targetId: "SHOT-EP001-002", kind: "video", url: "/video", path: "剧集/EP001/制作成果/SHOT-EP001-002/video.mp4" },
      { id: "unreadable", targetId: "SHOT-EP001-003", kind: "image", url: "/missing" }
    ];
    const sequence = reconcileSequence(
      ["SHOT-EP001-001", "SHOT-EP001-002", "SHOT-EP001-003", "SHOT-EP001-004"],
      [{ shotId: "SHOT-EP001-002" }, { shotId: "SHOT-EP001-001" }],
      versions,
      { "SHOT-EP001-001": "still", "SHOT-EP001-003": "unreadable" }
    );
    expect(sequence.map((item) => [item.shotId, item.versionId])).toEqual([
      ["SHOT-EP001-002", "video"], ["SHOT-EP001-001", "still"], ["SHOT-EP001-003", "unreadable"], ["SHOT-EP001-004", undefined]
    ]);
    expect(sequenceIssues(sequence, versions)).toEqual([
      "SHOT-EP001-003 的关键帧没有可供 DSH 读取的工作区路径",
      "SHOT-EP001-004 缺少已选视频或关键帧素材"
    ]);
  });

  it("does not reuse a same-named version from another episode", () => {
    const otherEpisode: ProductionMediaVersion = {
      id: "ep2-video", targetId: "SHOT-EP001-001", kind: "video", url: "/ep2", path: "剧集/EP002/制作成果/SHOT-EP001-001/take.mp4"
    };
    const sequence = reconcileSequence(["SHOT-EP001-001"], [], [otherEpisode], {}, "剧集/EP001");
    expect(sequence).toEqual([{ shotId: "SHOT-EP001-001", versionId: undefined }]);
    expect(sequenceIssues([{ shotId: "SHOT-EP001-001", versionId: otherEpisode.id }], [otherEpisode], "剧集/EP001"))
      .toEqual(["SHOT-EP001-001 缺少已选视频或关键帧素材"]);
  });

  it("accepts this episode's delivery media, rejects another delivery, and migrates old sequence state", () => {
    const delivered: ProductionMediaVersion = {
      id: "delivery-1", targetId: "SHOT-EP001-001", kind: "video", url: "/delivery", path: "交付/EP001/SHOT-EP001-001/take.mp4"
    };
    const other: ProductionMediaVersion = {
      ...delivered, id: "delivery-2", url: "/other", path: "交付/EP002/SHOT-EP001-001/take.mp4"
    };
    // Old Session rows have only versionId; reconciliation keeps their order and adopts the
    // current automatic result without inventing an explicit source choice.
    expect(reconcileSequence(
      ["SHOT-EP001-001"], [{ shotId: "SHOT-EP001-001", versionId: "stale" }], [other, delivered], {}, "剧集/EP001"
    )).toEqual([{ shotId: "SHOT-EP001-001", versionId: "delivery-1" }]);
    expect(sequenceIssues([{ shotId: "SHOT-EP001-001", versionId: "delivery-1" }], [other, delivered], "剧集/EP001")).toEqual([]);
  });

  it("blocks instead of substituting when an explicit sequence source disappears", () => {
    const available: ProductionMediaVersion = {
      id: "video", targetId: "SHOT-EP001-001", kind: "video", url: "/video", path: "剧集/EP001/制作成果/SHOT-EP001-001/video.mp4"
    };
    const sequence = reconcileSequence(
      ["SHOT-EP001-001"],
      [{ shotId: "SHOT-EP001-001", sourceVersionId: "deleted-still", versionId: "deleted-still" }],
      [available],
      {},
      "剧集/EP001"
    );
    expect(sequence).toEqual([{ shotId: "SHOT-EP001-001", sourceVersionId: "deleted-still", versionId: undefined }]);
    expect(sequenceIssues(sequence, [available], "剧集/EP001")).toEqual(["SHOT-EP001-001 显式选择的成片素材已不可用"]);
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

  it("points an assembly that ended without a cut at edit_tool check instead of a billing warning", () => {
    const cutPath = "剧集/EP001/制作成果/成片/成片.mp4";
    const stale: ProductionMediaVersion = { id: `workspace:${cutPath}:1`, targetId: "剧集/EP001", kind: "video", url: "/media/old", path: cutPath };
    const running = {
      ...createPendingJob({ id: "compose-1", targetId: "剧集/EP001", kind: "composition", prompt: "合成", outputPath: cutPath, supersededOutputIds: [stale.id] }),
      status: "running" as const
    };
    // Composition is local ffmpeg: nothing was billed, so the paid-dispatch warning would mislead.
    const ended = reconcileProductionJobs([running], [], false, [stale])[0]!;
    expect(ended).toMatchObject({ status: "dispatched_unknown", completedOutputs: 0 });
    expect(ended.error).toBe("成片未生成：请在 Chat 查看 edit_tool check 的阻断项（未采用镜头理由、画幅/帧率不一致等），修正后再合成。");
    expect(ended.error).not.toContain("计费");
    // Re-composing after the fix stays available, and a cut that lands later still completes the job.
    expect(compositionInFlight([ended])).toBe(false);
    const rendered: ProductionMediaVersion = { ...stale, id: `workspace:${cutPath}:2`, url: "/media/new" };
    expect(reconcileProductionJobs([ended], [], false, [rendered])[0]).toMatchObject({ status: "succeeded", completedOutputs: 1, error: undefined });
  });

  it("fails an assembly that ended without a cut once a newer composition runs, so the new cut completes only the new job", () => {
    const cutPath = "剧集/EP001/制作成果/成片/成片.mp4";
    const stale: ProductionMediaVersion = { id: `workspace:${cutPath}:1`, targetId: "剧集/EP001", kind: "video", url: "/media/old", path: cutPath };
    const assembly = (id: string) => createPendingJob({
      id, targetId: "剧集/EP001", kind: "composition", prompt: "合成", outputPath: cutPath, supersededOutputIds: [stale.id]
    });
    const first = reconcileProductionJobs([{ ...assembly("compose-1"), status: "running" }], [], false, [stale])[0]!;
    expect(first.status).toBe("dispatched_unknown");
    const second = assembly("compose-2");
    const rendered: ProductionMediaVersion = { ...stale, id: `workspace:${cutPath}:2`, url: "/media/new" };

    // Still waiting in the DSH Queue (or withdrawn from it): the older job can still be finished in Chat.
    const queue = [{ id: "q-2", preview: "/short-drama-edit 任务 ID：compose-2" }];
    expect(reconcileProductionJobs([first, second], queue, true, [stale])[0]).toBe(first);
    expect(reconcileProductionJobs([first, { ...second, status: "canceled" }], [], false, [rendered])[0]?.status).toBe("succeeded");

    // Once the newer composition runs, its cut completes only itself — even when the cut lands in the same pass.
    const [earlier, later] = reconcileProductionJobs([first, { ...second, status: "running" }], [], true, [rendered]);
    expect(earlier).toMatchObject({ id: "compose-1", status: "failed", error: first.error, completedOutputs: 0 });
    expect(earlier?.output).toBeUndefined();
    expect(later).toMatchObject({ id: "compose-2", status: "succeeded", completedOutputs: 1 });
    expect(later?.output?.id).toBe(rendered.id);

    const paid = { ...createPendingJob({ id: "paid-1", targetId: "SHOT-EP001-001", kind: "video", prompt: "p" }), status: "dispatched_unknown" as const, error: "避免重复计费" };
    const otherEpisode = {
      ...createPendingJob({ id: "compose-ep2", targetId: "剧集/EP002", kind: "composition", prompt: "合成", outputPath: "剧集/EP002/制作成果/成片/成片.mp4" }),
      status: "dispatched_unknown" as const
    };
    const settled = settleSupersededCompositions([first, paid, otherEpisode], second);
    expect(settled[0]).toEqual({ ...first, status: "failed" });
    expect(settled[1]).toBe(paid);
    expect(settled[2]).toBe(otherEpisode);
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

  it("counts music jobs and audio media in the music row (audio is no longer invisible)", () => {
    const jobs = [
      { ...createPendingJob({ id: "music-job", targetId: "EP001-MUSIC", kind: "music", prompt: "p" }), status: "succeeded" as const },
      { ...createPendingJob({ id: "music-run", targetId: "EP001-MUSIC", kind: "music", prompt: "p" }), status: "running" as const }
    ];
    const versions: ProductionMediaVersion[] = [
      // 成功 music job 的产物(文件名含 job ID)由 job 覆盖计数;
      // 未被任何成功 job 覆盖的配音/配乐音频按 existing 计入。
      { id: "v-covered", targetId: "EP001-MUSIC", kind: "audio", url: "/m/theme.wav", path: "剧集/EP001/制作成果/theme-music-job.wav" },
      { id: "v-dub", targetId: "SHOT-EP001-001", kind: "audio", url: "/m/dub.wav", path: "剧集/EP001/配音/SHOT-EP001-001.wav" }
    ];
    expect(summarizeEpisodeOutput(jobs, versions)).toEqual([
      { kind: "image", produced: 0, running: 0 },
      { kind: "video", produced: 0, running: 0 },
      { kind: "music", produced: 2, running: 1 }
    ]);
  });
});
