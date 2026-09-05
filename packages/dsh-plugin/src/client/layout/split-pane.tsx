import { useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { SPLIT_FRACTION_MIN, SPLIT_FRACTION_MAX, type SplitTree } from "./split-tree.js";

/** Divider drag: pointer capture + rAF-batched incremental deltas written
straight to the DOM, one React commit on release. Never one reduce per move. */

interface DividerProps {
  readonly direction: "row" | "column";
  readonly index: number;
  readonly path: readonly number[];
  readonly sizes: readonly number[];
  readonly paneRef: React.RefObject<HTMLDivElement | null>;
  readonly onCommit: (path: readonly number[], fraction: number) => void;
}

function cellsOf(pane: HTMLDivElement): HTMLElement[] {
  return [...pane.querySelectorAll<HTMLElement>(":scope > [data-oh-split-cell]")];
}

function SplitDivider({ direction, index, path, sizes, paneRef, onCommit }: DividerProps) {
  const drag = useRef<{
    readonly pointerId: number;
    lastX: number;
    lastY: number;
    pending: number;
    scheduled: boolean;
    readonly span: number;
    readonly pair: number;
    fraction: number;
    readonly host: Element | null;
  } | null>(null);

  const writeFraction = (fraction: number): void => {
    const pane = paneRef.current;
    const state = drag.current;
    if (pane === null || state === null) return;
    const cells = cellsOf(pane);
    const left = cells[index];
    const right = cells[index + 1];
    if (left === undefined || right === undefined) return;
    const clamped = Math.min(SPLIT_FRACTION_MAX, Math.max(SPLIT_FRACTION_MIN, fraction));
    state.fraction = clamped;
    // Direct DOM write: no React state while the pointer is down.
    left.style.flexGrow = String(clamped * state.pair);
    right.style.flexGrow = String((1 - clamped) * state.pair);
  };

  const flush = (): void => {
    const state = drag.current;
    if (state === null) return;
    state.scheduled = false;
    if (state.span <= 0) return;
    const delta = state.pending;
    state.pending = 0;
    if (delta === 0) return;
    writeFraction(state.fraction + delta / state.span);
  };

  const endDrag = (commit: boolean): void => {
    const state = drag.current;
    drag.current = null;
    state?.host?.removeAttribute("data-oh-splitting");
    if (state !== null && commit) onCommit(path, state.fraction);
  };

  // pointercancel 与 lostpointercapture 同路径:捕获丢失时拖拽已死,必须清状态、
  // 摘 data-oh-splitting,幂等(重复触发走空分支)。
  const abortDrag = (): void => { endDrag(false); };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const pane = paneRef.current;
    if (pane === null || drag.current !== null) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    const rect = pane.getBoundingClientRect();
    const pair = (sizes[index] ?? 0) + (sizes[index + 1] ?? 0);
    const host = pane.closest("[data-conversation-scroll]");
    host?.setAttribute("data-oh-splitting", "");
    drag.current = {
      pointerId: event.pointerId,
      lastX: event.clientX,
      lastY: event.clientY,
      pending: 0,
      scheduled: false,
      span: direction === "row" ? rect.width : rect.height,
      pair: pair > 0 ? pair : 1,
      fraction: pair > 0 ? (sizes[index] ?? 0) / pair : 0.5,
      host
    };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const state = drag.current;
    if (state === null || event.pointerId !== state.pointerId) return;
    // Incremental deltas only: accumulating absolute offsets runs away.
    const horizontal = direction === "row";
    state.pending += horizontal ? event.clientX - state.lastX : event.clientY - state.lastY;
    state.lastX = event.clientX;
    state.lastY = event.clientY;
    if (!state.scheduled) {
      state.scheduled = true;
      requestAnimationFrame(flush);
    }
  };

  return <div
    className="oh-split-divider"
    role="separator"
    aria-orientation={direction === "row" ? "vertical" : "horizontal"}
    tabIndex={0}
    data-direction={direction}
    onPointerDown={onPointerDown}
    onPointerMove={onPointerMove}
    onPointerUp={(event) => { if (drag.current?.pointerId === event.pointerId) endDrag(true); }}
    onPointerCancel={abortDrag}
    onLostPointerCapture={abortDrag}
  />;
}

export interface SplitPaneViewProps {
  readonly tree: SplitTree;
  /** Map a leaf id to its content. A floated leaf renders its placeholder. */
  readonly renderLeaf: (leafId: string) => ReactNode;
  /** Single commit when a divider drag is released. */
  readonly onResize: (path: readonly number[], fraction: number) => void;
  /** Extra class on the root pane (e.g. the grid-spanning story wrapper). */
  readonly className?: string | undefined;
}

function PaneView({ node, path, renderLeaf, onResize }: {
  readonly node: SplitTree;
  readonly path: readonly number[];
  readonly renderLeaf: (leafId: string) => ReactNode;
  readonly onResize: (path: readonly number[], fraction: number) => void;
}): ReactNode {
  const paneRef = useRef<HTMLDivElement | null>(null);
  if (node.kind === "leaf") {
    return <div className="oh-split-cell" data-oh-split-cell data-leaf={node.id}>{renderLeaf(node.id)}</div>;
  }
  return <div
    ref={paneRef}
    className="oh-split-pane"
    data-oh-split-pane
    data-direction={node.direction}
  >
    {node.children.map((child, childIndex) => {
      const size = node.sizes[childIndex] ?? 1 / node.children.length;
      const cell = child.kind === "leaf"
        ? <div key={child.id} className="oh-split-cell" data-oh-split-cell data-leaf={child.id} style={{ flexGrow: size, flexShrink: 1, flexBasis: 0 }}>{renderLeaf(child.id)}</div>
        : <div key={`pane-${String(childIndex)}`} className="oh-split-cell" data-oh-split-cell style={{ flexGrow: size, flexShrink: 1, flexBasis: 0 }}>
          <PaneView node={child} path={[...path, childIndex]} renderLeaf={renderLeaf} onResize={onResize} />
        </div>;
      const divider = childIndex < node.children.length - 1
        ? <SplitDivider key={`divider-${String(childIndex)}`} direction={node.direction} index={childIndex} path={[...path, childIndex]} sizes={node.sizes} paneRef={paneRef} onCommit={onResize} />
        : null;
      return [cell, divider];
    })}
  </div>;
}

/** Recursive split renderer. Narrow screens merge via CSS (column stack,
dividers hidden); leaf ids stay stable so docked state survives. */
export function SplitPaneView({ tree, renderLeaf, onResize, className }: SplitPaneViewProps): ReactNode {
  if (tree.kind === "leaf") {
    return <div className={`oh-split-pane ${className ?? ""}`} data-oh-split-pane data-direction="row">
      <div className="oh-split-cell" data-oh-split-cell data-leaf={tree.id}>{renderLeaf(tree.id)}</div>
    </div>;
  }
  return <div className={`oh-split-contents ${className ?? ""}`} data-oh-split-root>
    <PaneView node={tree} path={[]} renderLeaf={renderLeaf} onResize={onResize} />
  </div>;
}
