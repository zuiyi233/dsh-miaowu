/**
 * DSH is a general Harness: one installed plugin must not turn every Session
 * into a writing surface. The workbench claims the conversation layout only for
 * a workspace that actually holds creative work, and the creator can always
 * take the layout back.
 */

export type WorkbenchPreference = "open" | "closed";

export interface WorkbenchWorkspace {
  readonly files: readonly unknown[];
  readonly games: readonly { readonly source: "workspace" | "example" }[];
  readonly videos: readonly unknown[];
  /** 服务端发现的书名目录名单(一级子目录且含 正文/ 或 追踪/),缺失时前端不做两段判定。 */
  readonly bookDirectories?: readonly string[] | undefined;
}

export interface WorkbenchPreferenceStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

/** The bundled game example ships with the plugin, so it never marks a workspace as creative. */
export function hasCreativeProject(workspace: WorkbenchWorkspace | undefined): boolean {
  if (workspace === undefined) return false;
  return workspace.files.length > 0
    || workspace.videos.length > 0
    || workspace.games.some((game) => game.source === "workspace");
}

/** An explicit creator choice always wins over what the workspace happens to contain. */
export function resolveWorkbenchOpen(preference: WorkbenchPreference | undefined, creativeProject: boolean): boolean {
  return preference === undefined ? creativeProject : preference === "open";
}

export function workbenchPreferenceKey(cwd: string): string {
  return `oh-story.workbench.${cwd}`;
}

/** The DSH Session Store is not persisted, so the choice is kept per workspace instead. */
export function readWorkbenchPreference(storage: WorkbenchPreferenceStorage | undefined, cwd: string | undefined): WorkbenchPreference | undefined {
  if (storage === undefined || cwd === undefined) return undefined;
  let value: string | null;
  try { value = storage.getItem(workbenchPreferenceKey(cwd)); }
  catch { return undefined; }
  return value === "open" || value === "closed" ? value : undefined;
}

export function writeWorkbenchPreference(storage: WorkbenchPreferenceStorage | undefined, cwd: string | undefined, preference: WorkbenchPreference): void {
  if (storage === undefined || cwd === undefined) return;
  // Private windows and blocked site data refuse to persist; the Session still keeps the choice.
  try { storage.setItem(workbenchPreferenceKey(cwd), preference); }
  catch { /* the Session Store remains the in-session authority */ }
}

/** Reading the property itself throws when the browser blocks site data. */
export function workbenchPreferenceStorage(): WorkbenchPreferenceStorage | undefined {
  try { return globalThis.localStorage; }
  catch { return undefined; }
}

export type WorkbenchLayoutStorage = WorkbenchPreferenceStorage;

/** Session-isolated layout key; layouts never leak across sessions. */
export function layoutStorageKey(sessionId: string): string {
  return `oh-story.layout.v1.${sessionId}`;
}

/** Clear every persisted layout (used by the layout settings "reset" action). */
export function clearWorkbenchLayouts(storage: WorkbenchLayoutStorage | undefined): void {
  if (storage === undefined) return;
  try {
    const doomed: string[] = [];
    const length = (storage as unknown as { readonly length?: unknown }).length;
    const keyAt = (storage as unknown as { key?: (index: number) => string | null }).key;
    if (typeof length === "number" && typeof keyAt === "function") {
      for (let index = 0; index < length; index += 1) {
        const key = keyAt.call(storage, index);
        if (key !== null && key.startsWith("oh-story.layout.v1.")) doomed.push(key);
      }
      for (const key of doomed) (storage as unknown as { removeItem: (key: string) => void }).removeItem(key);
    }
  } catch { /* resetting layout must never break the workbench */ }
}

/** Persisted layout payload: split tree JSON plus float geometries. */
export interface PersistedWorkbenchLayout {
  readonly split?: unknown;
  readonly floats?: Readonly<Record<string, unknown>> | undefined;
}

export function readWorkbenchLayoutRaw(storage: WorkbenchLayoutStorage | undefined, sessionId: string | undefined): string | undefined {
  if (storage === undefined || sessionId === undefined || sessionId === "") return undefined;
  try {
    return storage.getItem(layoutStorageKey(sessionId)) ?? undefined;
  } catch { return undefined; }
}

export function writeWorkbenchLayoutRaw(storage: WorkbenchLayoutStorage | undefined, sessionId: string | undefined, value: string): void {
  if (storage === undefined || sessionId === undefined || sessionId === "") return;
  // Same contract as writeWorkbenchPreference: private windows refuse storage,
  // the Session Store stays the in-session authority.
  try { storage.setItem(layoutStorageKey(sessionId), value); }
  catch { /* the Session Store remains the in-session authority */ }
}
