// 从 src/client/index.tsx 原样迁移的工作台桥接层(签名、注释、逻辑逐字保持,仅加 export 并调整 import 来源)。
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PropsRuntime, PropsStore } from "@deepseek-ai/dsh-client-ui-slots";
import { endpoint } from "./workbench-ui.js";
import { json, type createWorkbenchStore, type WorkspacePayload } from "./workbench-state.js";
import { latestSettledMutation, streamingAssistant } from "./file-activity.js";
import { settledProductionIntents } from "./production-intents.js";
import {
  hasCreativeProject,
  readWorkbenchPreference,
  resolveWorkbenchOpen,
  workbenchPreferenceStorage
} from "./workbench-presence.js";
import { isParkedAtTail, shouldPinTail, TAIL_UNPARK_WINDOW_MS } from "./workbench-tail.js";
import { CreativeWorkbench } from "./creative-workbench.js";

/** 宿主重排/虚拟化时锚点闪断的宽限:连续 N 次查不到才真正卸载,避免 :has() 瞬间失配。 */
const BRIDGE_ANCHOR_MISS_LIMIT = 3;

export function useWorkspace(sessionId: string): {
  readonly workspace: WorkspacePayload | undefined;
  readonly error: string | undefined;
  readonly loading: boolean;
  readonly reload: () => void;
} {
  const [version, setVersion] = useState(0);
  const [workspace, setWorkspace] = useState<WorkspacePayload>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const reload = useCallback(() => {
    setLoading(true);
    setVersion((value) => value + 1);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setError(undefined);
    void fetch(endpoint("workspace", sessionId), { signal: controller.signal })
      .then((response) => json<WorkspacePayload>(response))
      .then(setWorkspace)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); };
  }, [sessionId, version]);
  return { workspace, error, loading, reload };
}

export interface ProductionConversationFace {
  readonly sendProductionPrompt: (prompt: string) => Promise<void>;
  readonly cancelProduction: () => Promise<void>;
  readonly removeQueuedProduction: (itemId: string) => Promise<void>;
}

export type WorkbenchSlotProps = PropsRuntime<"oh-story.workspace"> & PropsStore<ReturnType<typeof createWorkbenchStore>> & ProductionConversationFace;

/** Mount beside the official conversation without replacing Chat or Composer. */
export function CreativeSplitBridge({ sessionId, useSession, useChat, useStore, actions, sendProductionPrompt, cancelProduction, removeQueuedProduction }: WorkbenchSlotProps) {
  const marker = useRef<HTMLSpanElement>(null);
  const [target, setTarget] = useState<HTMLElement>();
  const runningCalls = useChat((snapshot) => snapshot.legacy.runningCalls);
  const partial = useChat((snapshot) => streamingAssistant(snapshot.timeline));
  const settledMutation = useChat((snapshot) => latestSettledMutation(snapshot));
  const workbench = useStore((memory) => memory.workbench);
  const gamePane = useStore((memory) => memory.gamePane);
  const videoPane = useStore((memory) => memory.videoPane);
  const sessionRunning = useSession((snapshot) => snapshot.running);
  const productionQueue = useSession((snapshot) => snapshot.queue.map((item) => ({ id: item.id, preview: item.preview })));
  const chat = useChat((snapshot) => snapshot);
  const productionIntents = useMemo(() => settledProductionIntents(chat), [chat]);
  const { workspace, error, loading: workspaceLoading, reload } = useWorkspace(sessionId);
  const chosenPreference = useStore((memory) => memory.workbenchPreference);
  const creativeProject = hasCreativeProject(workspace);
  // The Session Store holds this Session's choice; localStorage carries the workspace's
  // last choice across restarts. Reading it here keeps the decision in the same render
  // that learns the workspace, so a collapsed workbench never flashes the layout open.
  const storedPreference = useMemo(
    () => readWorkbenchPreference(workbenchPreferenceStorage(), workspace?.cwd),
    [workspace?.cwd]
  );
  const preference = chosenPreference ?? storedPreference;
  const open = resolveWorkbenchOpen(preference, creativeProject);
  useLayoutEffect(() => {
    const document = marker.current?.ownerDocument;
    if (document === undefined) return;
    // 锚点查不到时保留旧 target:宿主重排/虚拟化会让锚点闪断一两帧,立即置空会让
    // .oh-story-split-surface 卸载、:has() 失配,宿主瞬间弹回官方全宽。
    let missed = 0;
    const locate = (): void => {
      const anchor = document.querySelector<HTMLElement>("[data-conversation-scroll] > [data-slot='conversation.session']");
      if (anchor !== null) {
        missed = 0;
        setTarget((current) => current === anchor ? current : anchor);
        return;
      }
      missed += 1;
      if (missed >= BRIDGE_ANCHOR_MISS_LIMIT) setTarget(undefined);
    };
    locate();
    const observer = new MutationObserver(locate);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => { observer.disconnect(); };
  }, [sessionId]);
  useLayoutEffect(() => {
    const scroller = target?.parentElement;
    if (scroller === undefined || scroller === null) return;
    if (!open) {
      // A collapsed workbench returns the conversation to DSH untouched, so the only
      // measurement left is where that column sits: the launcher floats over its corner.
      const publishSeam = (): void => {
        const box = scroller.getBoundingClientRect();
        scroller.style.setProperty("--oh-story-seam-top", `${String(box.top)}px`);
        scroller.style.setProperty("--oh-story-seam-right", `${String(scroller.ownerDocument.documentElement.clientWidth - box.right)}px`);
      };
      publishSeam();
      const seams = new ResizeObserver(publishSeam);
      seams.observe(scroller);
      const view = scroller.ownerDocument.defaultView;
      view?.addEventListener("resize", publishSeam);
      return () => {
        seams.disconnect();
        view?.removeEventListener("resize", publishSeam);
        scroller.style.removeProperty("--oh-story-seam-top");
        scroller.style.removeProperty("--oh-story-seam-right");
      };
    }
    const composerSeat = (): HTMLElement | null => scroller.querySelector(":scope > [data-composer-seat]");
    // The seat overlaps the Chat column here, so a reader parked at the tail has
    // to be carried across every layout pass; losing the tail does not merely
    // scroll it out of sight, it leaves the last lines behind the Composer.
    // Being parked is a sticky snapshot: reaching the tail always claims it,
    // but only a scroll the reader actually drove releases it. publishLayout
    // must never touch it — a growing scrollHeight during streaming is not
    // the reader leaving (#26).
    const parkedAtTail = (): boolean => isParkedAtTail(scroller.scrollHeight, scroller.scrollTop, scroller.clientHeight);
    let parked = parkedAtTail();
    let drivenAt = 0;
    let pointerHeld = false;
    const markDriven = (event: Event): void => {
      if (event.target instanceof Node && composerSeat()?.contains(event.target) === true) return;
      // A button click (for example switching the editor preview) is not a
      // scrollbar drag. Its subsequent reflow must not release the Chat tail.
      if (event.type === "pointerdown" && event.target !== scroller) return;
      drivenAt = performance.now();
    };
    const trackParked = (): void => {
      if (parkedAtTail()) { parked = true; return; }
      // 只有用户驱动的滚动(指针按下/解除窗口内)才允许解除贴底;
      // scroll anchoring 与宿主重排的自发滚动不得解除(#26 长答复跟随依赖此语义)。
      if (pointerHeld || performance.now() - drivenAt < TAIL_UNPARK_WINDOW_MS) parked = false;
    };
    const pinTail = (): void => {
      // 在底部即认领:程序化跳底/异步 scroll 事件可能迟到,当前几何已在尾部时
      // 跟随永远是正确语义,不依赖事件时序(#26)。
      if (parkedAtTail()) parked = true;
      // 流式输出停在尾部 → 跟随到底;指针按下/用户手势宽限内 → 不写回,滚动条位置归用户。
      if (shouldPinTail({ parked, pointerHeld, lastDrivenAt: drivenAt, now: performance.now() })) {
        scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight;
        parked = true;
      }
    };
    const publishLayout = (): void => {
      scroller.style.setProperty("--oh-story-scroll-height", `${String(scroller.clientHeight)}px`);
      // DSH 0.1.2 grows the seat with the streaming Todo panel while
      // --dsh-composer-height keeps reporting the bare input height. Publish the
      // measurement beside it rather than over it: the CSS takes the larger, so
      // writing the variable DSH also owns can never turn into a resize duel.
      scroller.style.setProperty("--oh-story-composer-height", `${String(composerSeat()?.getBoundingClientRect().height ?? 0)}px`);
      scroller.dataset.ohStoryWorkbench = workbench;
      const studioPane = workbench === "video" ? videoPane : gamePane;
      scroller.dataset.ohStudioPane = studioPane;
      const compactAt = workbench === "game" || workbench === "video" ? 720 : 620;
      const mediumAt = workbench === "game" || workbench === "video" ? 960 : 900;
      const layout = scroller.clientWidth < compactAt ? "compact" : scroller.clientWidth < mediumAt ? "medium" : "wide";
      if (scroller.dataset.ohStoryLayout !== layout) scroller.dataset.ohStoryLayout = layout;
      pinTail();
    };
    const observer = new ResizeObserver(publishLayout);
    const observed = new WeakSet<Element>();
    // The official seat and Chat flow mount and remount independently of this
    // bridge. The flow is observed because a resized Chat keeps re-wrapping for
    // several frames afterwards: pinning once against the height the first frame
    // reports leaves the reader behind the Composer again once it settles.
    let flowObserved = false;
    const observePanes = (): void => {
      const flow = scroller.querySelector("[data-chat-flow]");
      flowObserved = flow !== null;
      for (const pane of [composerSeat(), flow]) {
        if (pane === null || observed.has(pane)) continue;
        observed.add(pane);
        observer.observe(pane);
      }
    };
    publishLayout();
    const view = scroller.ownerDocument;
    // 滚动条拖拽的 pointerdown 落在 scroller 自身:capture 捕获起始,全局 up/cancel 释放按下态。
    const holdPointer = (event: Event): void => {
      if (event.target instanceof Node && composerSeat()?.contains(event.target) === true) return;
      pointerHeld = true;
      drivenAt = performance.now();
    };
    const releasePointer = (): void => { pointerHeld = false; drivenAt = performance.now(); };
    scroller.addEventListener("scroll", trackParked, { passive: true });
    for (const driven of ["wheel", "touchmove", "keydown"]) {
      scroller.addEventListener(driven, markDriven, { passive: true });
    }
    scroller.addEventListener("pointerdown", markDriven, { passive: true, capture: true });
    view.addEventListener("pointerdown", holdPointer, { capture: true });
    view.addEventListener("pointerup", releasePointer);
    view.addEventListener("pointercancel", releasePointer);
    observer.observe(scroller);
    observePanes();
    const seats = new MutationObserver(() => { observePanes(); publishLayout(); });
    seats.observe(scroller, { childList: true });
    // The flow mounts below the seat's level, and streaming mutates it token by
    // token: watch the subtree only until it has been found once.
    const panes = new MutationObserver(() => { if (!flowObserved) observePanes(); });
    panes.observe(scroller, { childList: true, subtree: true });
    return () => {
      panes.disconnect();
      scroller.removeEventListener("scroll", trackParked);
      for (const driven of ["wheel", "touchmove", "keydown"]) {
        scroller.removeEventListener(driven, markDriven);
      }
      scroller.removeEventListener("pointerdown", markDriven, { capture: true });
      view.removeEventListener("pointerdown", holdPointer, { capture: true });
      view.removeEventListener("pointerup", releasePointer);
      view.removeEventListener("pointercancel", releasePointer);
      observer.disconnect();
      seats.disconnect();
      scroller.style.removeProperty("--oh-story-scroll-height");
      scroller.style.removeProperty("--oh-story-composer-height");
      delete scroller.dataset.ohStoryLayout;
      delete scroller.dataset.ohStoryWorkbench;
      delete scroller.dataset.ohStudioPane;
    };
  }, [gamePane, open, target, videoPane, workbench]);
  return <>
    <span ref={marker} className="oh-story-bridge-marker" aria-hidden />
    {target === undefined ? null : createPortal(<CreativeWorkbench
      sessionId={sessionId}
      runningCalls={runningCalls}
      partial={partial}
      settledMutation={settledMutation}
      sessionRunning={sessionRunning}
      productionQueue={productionQueue}
      productionIntents={productionIntents}
      workspace={workspace}
      error={error}
      workspaceLoading={workspaceLoading}
      reload={reload}
      open={open}
      creativeProject={creativeProject}
      sendProductionPrompt={sendProductionPrompt}
      cancelProduction={cancelProduction}
      removeQueuedProduction={removeQueuedProduction}
      useStore={useStore}
      actions={actions}
    />, target)}
  </>;
}
