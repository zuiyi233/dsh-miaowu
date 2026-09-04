import { useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

/**
 * Phase C free window. Absolute viewport geometry: the floating panel never
 * joins the grid flow, so dragging a studio out never re-pushes the Chat
 * column. Drag frames write `[data-oh-float]` attributes straight to the DOM
 * (better-sidebar #31); React commits once on pointer release.
 */

export interface FloatGeometry {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface FloatViewport {
  readonly width: number;
  readonly height: number;
}

const FLOAT_MIN_WIDTH = 280;
const FLOAT_MIN_HEIGHT = 200;
const FLOAT_MARGIN = 8;
const FLOAT_DEFAULT_WIDTH = 560;
const FLOAT_DEFAULT_HEIGHT = 480;

function finite(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? (value as number) : fallback;
}

/** Loose geometry read from persisted JSON; every field is optional. */
export interface PartialFloatGeometry {
  readonly x?: number | undefined;
  readonly y?: number | undefined;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
}

/** Clamp a float window into the viewport; corrupt input falls back to a default box. */
export function clampFloatGeometry(geometry: PartialFloatGeometry | null | undefined, viewport: FloatViewport): FloatGeometry {
  const viewWidth = Math.max(1, viewport.width);
  const viewHeight = Math.max(1, viewport.height);
  const width = Math.min(viewWidth - FLOAT_MARGIN * 2, Math.max(FLOAT_MIN_WIDTH, finite(geometry?.width, FLOAT_DEFAULT_WIDTH)));
  const height = Math.min(viewHeight - FLOAT_MARGIN * 2, Math.max(FLOAT_MIN_HEIGHT, finite(geometry?.height, FLOAT_DEFAULT_HEIGHT)));
  const x = Math.min(viewWidth - FLOAT_MARGIN - Math.min(width, viewWidth), Math.max(FLOAT_MARGIN, finite(geometry?.x, FLOAT_MARGIN)));
  const y = Math.min(viewHeight - FLOAT_MARGIN - Math.min(height, viewHeight), Math.max(FLOAT_MARGIN, finite(geometry?.y, FLOAT_MARGIN)));
  return { x, y, width, height };
}

export function defaultFloatGeometry(viewport: FloatViewport): FloatGeometry {
  return clampFloatGeometry({ x: FLOAT_MARGIN, y: FLOAT_MARGIN, width: FLOAT_DEFAULT_WIDTH, height: FLOAT_DEFAULT_HEIGHT }, viewport);
}

function px(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boxOf(element: HTMLElement): FloatGeometry {
  return {
    x: px(element.style.left, FLOAT_MARGIN),
    y: px(element.style.top, FLOAT_MARGIN),
    width: px(element.style.width, FLOAT_DEFAULT_WIDTH),
    height: px(element.style.height, FLOAT_DEFAULT_HEIGHT)
  };
}

function writeBox(element: HTMLElement, box: FloatGeometry): void {
  element.style.left = `${String(Math.round(box.x))}px`;
  element.style.top = `${String(Math.round(box.y))}px`;
  element.style.width = `${String(Math.round(box.width))}px`;
  element.style.height = `${String(Math.round(box.height))}px`;
}

interface FreeWindowProps {
  readonly panelId: string;
  readonly title: string;
  readonly geometry: FloatGeometry;
  readonly children: ReactNode;
  readonly onMove: (panelId: string, geometry: FloatGeometry) => void;
  readonly onDock: (panelId: string) => void;
}

export function FreeWindow({ panelId, title, geometry, children, onMove, onDock }: FreeWindowProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ readonly mode: "move" | "resize"; readonly pointerId: number; lastX: number; lastY: number } | null>(null);

  const begin = (mode: "move" | "resize") => (event: ReactPointerEvent<HTMLElement>): void => {
    const root = rootRef.current;
    if (root === null || drag.current !== null) return;
    if (mode === "move" && (event.target as HTMLElement).closest("button") !== null) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    drag.current = { mode, pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const state = drag.current;
    const root = rootRef.current;
    if (state === null || root === null || event.pointerId !== state.pointerId) return;
    // Incremental delta; the previous box is read from the DOM attributes so
    // the motion matches what the reader sees mid-drag.
    const deltaX = event.clientX - state.lastX;
    const deltaY = event.clientY - state.lastY;
    state.lastX = event.clientX;
    state.lastY = event.clientY;
    if (deltaX === 0 && deltaY === 0) return;
    const view = root.ownerDocument.documentElement;
    const box = boxOf(root);
    const next = state.mode === "move"
      ? { ...box, x: box.x + deltaX, y: box.y + deltaY }
      : { ...box, width: box.width + deltaX, height: box.height + deltaY };
    writeBox(root, clampFloatGeometry(next, { width: view.clientWidth, height: view.clientHeight }));
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const state = drag.current;
    const root = rootRef.current;
    drag.current = null;
    if (state === null || root === null || event.pointerId !== state.pointerId) return;
    onMove(panelId, boxOf(root));
  };

  return <div
    ref={rootRef}
    className="oh-float-window"
    data-oh-float={panelId}
    role="dialog"
    aria-label={title}
    style={{ left: geometry.x, top: geometry.y, width: geometry.width, height: geometry.height }}
    onPointerMove={onPointerMove}
    onPointerUp={endDrag}
    onPointerCancel={() => { drag.current = null; }}
  >
    <header className="oh-float-header" onPointerDown={begin("move")}>
      <strong>{title}</strong>
      <span className="oh-float-actions">
        <button type="button" title="放回工作台" aria-label={`将${title}放回工作台`} onClick={() => { onDock(panelId); }}>⇲</button>
      </span>
    </header>
    <div className="oh-float-body">{children}</div>
    <div
      className="oh-float-resize"
      aria-hidden
      onPointerDown={begin("resize")}
    />
  </div>;
}
