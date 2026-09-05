/**
 * Phase C layout: recursive split tree state machine.
 *
 * Borrowed from DSH-better-sidebar (`SidebarLeaf | SidebarSplit`, fraction
 * sizes summing to 1, divider clamp 0.08-0.92). Pure functions only: no React,
 * no DOM, so vitest covers the whole contract without a browser.
 */

/** Divider clamp lower bound (better-sidebar split-pane Divider). */
export const SPLIT_FRACTION_MIN = 0.08;
/** Divider clamp upper bound (better-sidebar split-pane Divider). */
export const SPLIT_FRACTION_MAX = 0.92;
/** Story workbench default: tree column share of the tree|editor pair. The
 *  top-level pane spans the fixed tree track plus the fluid editor track, so
 *  the share is relative to that combined width. */
export const DEFAULT_TREE_FRACTION = 0.32;
/** Leaf id of the story/drama file tree column. */
export const TREE_LEAF_ID = "tree";
/** Leaf id of the story/drama editor column. */
export const EDITOR_LEAF_ID = "editor";

export interface SplitLeaf {
  readonly kind: "leaf";
  readonly id: string;
}

export interface SplitPane {
  readonly kind: "pane";
  readonly direction: "row" | "column";
  readonly sizes: readonly number[];
  readonly children: readonly SplitTree[];
}

export type SplitTree = SplitLeaf | SplitPane;

function clampFraction(fraction: number): number {
  if (!Number.isFinite(fraction)) return (SPLIT_FRACTION_MIN + SPLIT_FRACTION_MAX) / 2;
  return Math.min(SPLIT_FRACTION_MAX, Math.max(SPLIT_FRACTION_MIN, fraction));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Fresh default story split: tree | editor horizontal pair. */
export function defaultSplitTree(): SplitTree {
  return createRow(TREE_LEAF_ID, EDITOR_LEAF_ID, DEFAULT_TREE_FRACTION);
}

export function createRow(a: string, b: string, fraction = 0.5): SplitTree {
  const first = clampFraction(fraction);
  return { kind: "pane", direction: "row", sizes: [first, 1 - first], children: [{ kind: "leaf", id: a }, { kind: "leaf", id: b }] };
}

/**
 * Move the divider at `path` (index path to the pane, last element is the
 * divider index between child[i] and child[i+1]) so the left/top child owns
 * `fraction` of the pair. Out-of-range paths return the tree unchanged.
 */
export function setFraction(tree: SplitTree, path: readonly number[], fraction: number): SplitTree {
  if (path.length === 0 || tree.kind !== "pane") return tree;
  const [head, ...tail] = path as [number, ...number[]];
  if (tail.length === 0) {
    const left = tree.sizes[head];
    const right = tree.sizes[head + 1];
    if (left === undefined || right === undefined) return tree;
    const pair = left + right;
    const clamped = clampFraction(fraction);
    const sizes = [...tree.sizes];
    sizes[head] = clamped * pair;
    sizes[head + 1] = (1 - clamped) * pair;
    return { ...tree, sizes };
  }
  const child = tree.children[head];
  if (child === undefined) return tree;
  const next = setFraction(child, tail, fraction);
  if (next === child) return tree;
  const children = [...tree.children];
  children[head] = next;
  return { ...tree, children };
}

/**
 * Remove a leaf; a pane left with a single child promotes that child, and an
 * empty pane collapses to nothing (caller falls back to the default split).
 * Unknown ids and removing the last leaf return the tree unchanged.
 */
export function removeLeaf(tree: SplitTree, leafId: string): SplitTree {
  if (tree.kind === "leaf") return tree;
  const kept: SplitTree[] = [];
  const keptSizes: number[] = [];
  let changed = false;
  for (let index = 0; index < tree.children.length; index += 1) {
    const child = tree.children[index];
    if (child === undefined) continue;
    if (child.kind === "leaf") {
      if (child.id === leafId) {
        changed = true;
        continue;
      }
      kept.push(child);
      keptSizes.push(tree.sizes[index] ?? 0);
      continue;
    }
    const next = removeLeaf(child, leafId);
    if (next === child) {
      kept.push(child);
      keptSizes.push(tree.sizes[index] ?? 0);
      continue;
    }
    changed = true;
    if (next.kind === "pane" && next.children.length === 0) continue;
    kept.push(next);
    keptSizes.push(tree.sizes[index] ?? 0);
  }
  if (!changed) return tree;
  const first = kept[0];
  if (kept.length === 0) return { ...tree, children: [], sizes: [] };
  if (kept.length === 1 && first !== undefined) return first;
  const total = keptSizes.reduce((sum, size) => sum + size, 0);
  const sizes = total > 0 ? keptSizes.map((size) => size / total) : kept.map(() => 1 / kept.length);
  return { ...tree, children: kept, sizes };
}

/** Leaf ids left to right (depth first); the narrow-screen merge order. */
export function flattenLeaves(tree: SplitTree): string[] {
  if (tree.kind === "leaf") return [tree.id];
  return tree.children.flatMap(flattenLeaves);
}

function sanitizeLeaf(raw: unknown): SplitLeaf | undefined {
  if (!isRecord(raw) || raw.kind !== "leaf" || typeof raw.id !== "string" || raw.id === "") return undefined;
  return { kind: "leaf", id: raw.id };
}

function sanitizeNode(raw: unknown): SplitTree | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.kind === "leaf") return sanitizeLeaf(raw);
  if (raw.kind !== "pane" || !Array.isArray(raw.children)) return undefined;
  const direction = raw.direction === "column" ? "column" : "row";
  const children = (raw.children as unknown[]).flatMap((child) => {
    const next = sanitizeNode(child);
    return next === undefined ? [] : [next];
  });
  if (children.length === 0) return undefined;
  if (children.length === 1) return children[0];
  const rawSizes = Array.isArray(raw.sizes) ? (raw.sizes as unknown[]) : [];
  const parsed = children.map((_, index) => {
    const size = rawSizes[index];
    return typeof size === "number" && Number.isFinite(size) && size > 0 ? size : NaN;
  });
  const valid = parsed.every((size) => !Number.isNaN(size));
  const total = parsed.reduce((sum, size) => sum + (Number.isNaN(size) ? 0 : size), 0);
  const sizes = valid && total > 0
    ? parsed.map((size) => (Number.isNaN(size) ? 0 : size) / total)
    : children.map(() => 1 / children.length);
  return { kind: "pane", direction, sizes, children };
}

/** Strict validation: anything malformed falls back to the default split. */
export function sanitizeSplit(raw: unknown): SplitTree {
  return sanitizeNode(raw) ?? defaultSplitTree();
}

export function serializeSplit(tree: SplitTree): string {
  return JSON.stringify(tree);
}

/** Corrupt JSON falls back to the default split, never throws. */
export function parseSplit(raw: string | null | undefined): SplitTree {
  if (typeof raw !== "string" || raw === "") return defaultSplitTree();
  try {
    return sanitizeSplit(JSON.parse(raw) as unknown);
  } catch {
    return defaultSplitTree();
  }
}
