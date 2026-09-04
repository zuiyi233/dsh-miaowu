import type { KeyboardEvent as ReactKeyboardEvent } from "react";

/** Roving-focus keyboard contract shared by every workbench tablist. */
export function handleTabKey<T extends string>(
  event: ReactKeyboardEvent<HTMLButtonElement>,
  values: readonly T[],
  current: T,
  select: (value: T) => void
): void {
  let index: number | undefined;
  if (event.key === "Home") index = 0;
  else if (event.key === "End") index = values.length - 1;
  else if (event.key === "ArrowRight") index = (values.indexOf(current) + 1) % values.length;
  else if (event.key === "ArrowLeft") index = (values.indexOf(current) - 1 + values.length) % values.length;
  if (index === undefined) return;
  event.preventDefault();
  const value = values[index];
  if (value === undefined) return;
  select(value);
  event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role='tab']")[index]?.focus();
}

export function endpoint(path: string, sessionId: string, file?: string): string {
  const url = new URL(`/oh-story/${path}`, globalThis.location.origin);
  url.searchParams.set("sessionId", sessionId);
  if (file !== undefined) url.searchParams.set("path", file);
  return url.toString();
}

/** localStorage key for one feature panel's enabled switch (settings UI only). */
export function featureToggleKey(featureId: string): string {
  return `oh-story.feature.${featureId}`;
}

/**
 * Read one feature toggle. Absent keys mean enabled; only an explicit
 * "0"/"false"/"off" disables. Storage failures keep the panel enabled.
 */
export function readFeatureEnabled(
  storage: { getItem: (key: string) => string | null } | undefined,
  featureId: string
): boolean {
  if (storage === undefined) return true;
  let value: string | null;
  try { value = storage.getItem(featureToggleKey(featureId)); }
  catch { return true; }
  if (value === null) return true;
  return value !== "0" && value !== "false" && value !== "off";
}

export function writeFeatureEnabled(
  storage: { setItem: (key: string, value: string) => void } | undefined,
  featureId: string,
  enabled: boolean
): void {
  if (storage === undefined) return;
  try { storage.setItem(featureToggleKey(featureId), enabled ? "1" : "0"); }
  catch { /* the Session keeps the choice */ }
}

/** Plain-object guard for persisted layout payloads; malformed entries drop. */
export function isLayoutRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
