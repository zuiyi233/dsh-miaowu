import type { Context } from "@deepseek-ai/cordis";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { WorkspaceRealm, WorkspaceRouteOptions } from "../workspace-route.js";

/**
 * Host-side extension seam for the session workspace API. Feature modules register
 * themselves by importing their module (side effect) and mounting a handler that
 * runs after the core `/oh-story` routes, so parallel feature work never rewrites
 * `workspace-route.ts`.
 */
export interface WorkspaceExtension {
  readonly name: string;
  /** Handle a request, or return false to let later extensions / the 404 answer it. */
  readonly handle: (
    context: Context,
    request: IncomingMessage,
    response: ServerResponse,
    options: WorkspaceRouteOptions
  ) => Promise<boolean>;
}

const extensions: WorkspaceExtension[] = [];

export function registerWorkspaceExtension(extension: WorkspaceExtension): void {
  if (extension.name === "" || extensions.some((existing) => existing.name === extension.name)) {
    throw new Error(`workspace extension already registered: ${extension.name}`);
  }
  extensions.push(extension);
}

export function workspaceExtensions(): readonly WorkspaceExtension[] {
  return extensions;
}

/** A file save the core editor route accepted. */
export interface WorkspaceWriteEvent {
  readonly path: string;
  readonly content: string;
  readonly bytes: number;
  readonly version: string;
  readonly realm: WorkspaceRealm;
}

const writeListeners: Array<(event: WorkspaceWriteEvent) => void> = [];

export function onWorkspaceWrite(listener: (event: WorkspaceWriteEvent) => void): void {
  writeListeners.push(listener);
}

export function notifyWorkspaceWrite(event: WorkspaceWriteEvent): void {
  for (const listener of writeListeners) {
    try { listener(event); } catch { /* audit/index listeners never fail the save */ }
  }
}