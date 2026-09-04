import { createElement, type ComponentType, type ReactNode } from "react";

/** A light structural view of the workspace the feature panels consume. */
export interface FeatureWorkspace {
  readonly cwd: string;
  readonly files: readonly {
    readonly path: string;
    readonly bytes: number;
    readonly version: string;
    readonly kind: "text" | "media";
    readonly mimeType?: string | undefined;
  }[];
  readonly metadataErrors: readonly string[];
}

export interface WorkbenchFeatureProps {
  readonly sessionId: string;
  readonly workspace: FeatureWorkspace | undefined;
  readonly selected: string | undefined;
  /** Open a file in the editor at a 1-based line and character offset. */
  readonly onReveal: (path: string, line: number, offset: number) => void;
  readonly onClose: () => void;
}

export interface WorkbenchFeature {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  /** Workbenches that show the toggle button for this feature. */
  readonly workbenches: readonly ("story" | "drama")[];
  readonly component: ComponentType<WorkbenchFeatureProps>;
}

const features: WorkbenchFeature[] = [];

export function registerWorkbenchFeature(feature: WorkbenchFeature): void {
  if (feature.id === "" || features.some((existing) => existing.id === feature.id)) {
    throw new Error(`workbench feature already registered: ${feature.id}`);
  }
  features.push(feature);
}

export function workbenchFeatures(): readonly WorkbenchFeature[] {
  return features;
}

/** Props a registered file viewer receives when it renders the selected file. */
export interface FileViewerProps {
  readonly sessionId: string;
  readonly path: string;
  readonly content: string;
  readonly onClose: () => void;
}

/** A third-party file view: `extensions: []` is a catch-all fallback. */
export interface FileViewerDescriptor {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  readonly extensions: readonly string[];
  readonly priority: number;
  readonly match?: ((path: string, kind: "text" | "media") => boolean) | undefined;
  readonly component: ComponentType<FileViewerProps>;
}

const registeredFileViewers: FileViewerDescriptor[] = [];
const fileViewerListeners = new Set<() => void>();
let fileViewersVersion = 0;

function notifyFileViewers(): void {
  fileViewersVersion += 1;
  for (const listener of [...fileViewerListeners]) listener();
}

/** Register a file viewer; throws on duplicate id, returns a disposer. */
export function registerFileViewer(viewer: FileViewerDescriptor): () => void {
  if (viewer.id === "" || registeredFileViewers.some((existing) => existing.id === viewer.id)) {
    throw new Error(`file viewer already registered: ${viewer.id}`);
  }
  registeredFileViewers.push(viewer);
  notifyFileViewers();
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const index = registeredFileViewers.findIndex((existing) => existing.id === viewer.id);
    if (index >= 0) {
      registeredFileViewers.splice(index, 1);
      notifyFileViewers();
    }
  };
}

/** Registered viewers ordered by descending priority (registration order breaks ties). */
export function fileViewers(): readonly FileViewerDescriptor[] {
  return [...registeredFileViewers].sort((left, right) => right.priority - left.priority);
}

function extensionOf(path: string): string {
  const basename = path.split("/").at(-1) ?? path;
  const dot = basename.lastIndexOf(".");
  return dot <= 0 ? "" : basename.slice(dot).toLocaleLowerCase();
}

/**
 * Find the best viewer for a path: match() runs before extensions, and an
 * empty extensions list only counts when nothing more precise matched. A
 * viewer that declares match() is sniff-only: a false match never falls
 * through to extensions or catch-all (better-sidebar semantics).
 */
export function matchFileViewer(path: string, kind: "text" | "media"): FileViewerDescriptor | undefined {
  const ordered = fileViewers();
  const ext = extensionOf(path);
  for (const viewer of ordered) {
    if (viewer.match?.(path, kind) === true) return viewer;
  }
  for (const viewer of ordered) {
    if (viewer.match !== undefined || viewer.extensions.length === 0) continue;
    if (ext !== "" && viewer.extensions.some((candidate) => candidate.toLocaleLowerCase() === ext)) return viewer;
  }
  for (const viewer of ordered) {
    if (viewer.match === undefined && viewer.extensions.length === 0) return viewer;
  }
  return undefined;
}

/** Subscribe to viewer registry changes (useSyncExternalStore style). */
export function subscribeFileViewers(listener: () => void): () => void {
  fileViewerListeners.add(listener);
  return () => { fileViewerListeners.delete(listener); };
}

/** Snapshot token a React component can subscribe to for registry changes. */
export function getFileViewersSnapshot(): number {
  return fileViewersVersion;
}

const MAX_TREE_DEPTH = 8;
const MAX_TREE_KEYS = 200;

function renderJsonNode(value: unknown, depth: number, keyPrefix: string): ReactNode {
  if (value === null) return createElement("span", { className: "oh-viewer-value" }, "null");
  if (typeof value === "string") return createElement("span", { className: "oh-viewer-value" }, JSON.stringify(value));
  if (typeof value === "number" || typeof value === "boolean") {
    return createElement("span", { className: "oh-viewer-value" }, String(value));
  }
  if (typeof value === "bigint") return createElement("span", { className: "oh-viewer-value" }, `${String(value)}n`);
  if (typeof value === "symbol") return createElement("span", { className: "oh-viewer-value" }, value.toString());
  if (typeof value === "function") return createElement("span", { className: "oh-viewer-value" }, "…");
  if (typeof value !== "object") return createElement("span", { className: "oh-viewer-value" }, "…");
  if (depth >= MAX_TREE_DEPTH) return createElement("span", { className: "oh-viewer-value" }, "…");
  const entries: readonly (readonly [string, unknown])[] = Array.isArray(value)
    ? value.map((item, index): readonly [string, unknown] => [String(index), item])
    : Object.entries(value).slice(0, MAX_TREE_KEYS);
  return createElement(
    "ul",
    { className: "oh-viewer-tree" },
    entries.map(([key, item]) => createElement(
      "li",
      { key: `${keyPrefix}${key}` },
      createElement("span", { className: "oh-viewer-key" }, key),
      createElement("span", { className: "oh-viewer-sep" }, ": "),
      renderJsonNode(item, depth + 1, `${keyPrefix}${key}.`)
    ))
  );
}

function JsonTreeViewer({ path, content }: FileViewerProps): ReactNode {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    return createElement("pre", { className: "oh-viewer-fallback", "aria-label": `${path} 原始文本` }, content);
  }
  return createElement(
    "div",
    { className: "oh-viewer-json", "aria-label": `${path} 树形视图` },
    createElement("style", null, ".oh-viewer-json{padding:12px;overflow:auto}.oh-viewer-tree{list-style:none;margin:4px 0 4px 16px;padding:0}.oh-viewer-key{font-weight:600}.oh-viewer-fallback{padding:12px;white-space:pre-wrap;overflow:auto}"),
    renderJsonNode(parsed, 0, "")
  );
}

/**
 * Built-in example proving the API works: a JSON tree view. Registered once
 * at module load; the editor only shows its tab when it wins the match.
 */
registerFileViewer({
  id: "source-map",
  label: "树形",
  icon: "🌳",
  extensions: [".json"],
  priority: 0,
  component: JsonTreeViewer
});