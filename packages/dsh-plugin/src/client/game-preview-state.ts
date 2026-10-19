/** What the out-of-band probe learned about the build the frame is showing. */
export type PreviewProbeResult = "pending" | "ok" | "failed";

export interface GamePreviewObservation {
  /** The iframe fired `load`. It also fires for an HTTP error page, so it never proves the build works. */
  readonly frameLoaded: boolean;
  readonly frameError: boolean;
  readonly probe: PreviewProbeResult;
  /** The Agent is writing into this project's files right now. */
  readonly building: boolean;
  /** A newer build exists than the one the creator accepted. */
  readonly pending: boolean;
  readonly isolated: boolean;
}

export interface GamePreviewStatus {
  readonly tone: "error" | "building" | "ready" | "loading";
  readonly label: string;
}

/**
 * The status line describes the build on screen. A probe that failed while the Agent rewrote
 * the files, or for a build that a newer one has already replaced, says nothing about what to
 * do next, so building and a waiting new version take precedence over a failure.
 */
export function gamePreviewStatus(state: GamePreviewObservation): GamePreviewStatus {
  const failed = state.frameError || state.probe === "failed";
  if (state.building) return { tone: "building", label: "Agent 正在更新游戏文件 · 当前预览保持不变" };
  if (state.pending) return { tone: state.frameLoaded && !failed ? "ready" : "loading", label: "新版本已就绪 · 由你决定何时载入" };
  if (failed) return { tone: "error", label: "预览载入失败 · 可重新载入" };
  if (state.frameLoaded) {
    return { tone: "ready", label: state.isolated ? "预览已载入" : "预览已载入 · 当前部署无法隔离来源，存档功能不可用" };
  }
  return { tone: "loading", label: "正在载入预览…" };
}

/**
 * The preview runs on the other loopback alias (127.0.0.1 ↔ localhost) so its storage is
 * isolated from DSH. A `fetch` there is cross-site, and the route rightly refuses cross-site
 * reads, so the probe asks the same route on the page's own origin, which serves the same bytes.
 */
export function previewUrls(path: string, version: string, revision: number, origin: string): {
  readonly href: string;
  readonly probeHref: string;
  readonly isolated: boolean;
} {
  const url = new URL(path, origin);
  url.searchParams.set("build", version);
  url.searchParams.set("reload", String(revision));
  const probeHref = url.toString();
  if (url.hostname === "127.0.0.1") url.hostname = "localhost";
  else if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return { href: url.toString(), probeHref, isolated: url.origin !== new URL(origin).origin };
}
