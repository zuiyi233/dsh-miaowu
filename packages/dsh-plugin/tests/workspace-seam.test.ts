import { describe, expect, it } from "vitest";
import { FsError } from "@deepseek-ai/dsh-fs";
import { registerWorkspaceExtension, workspaceExtensions } from "../src/services/registry.js";
import { registerWorkbenchFeature, workbenchFeatures } from "../src/client/features/registry.js";
import { mapFsError, parseByteRange } from "../src/workspace-route.js";

describe("workspace extension seam", () => {
  it("accepts named handlers and rejects duplicates", () => {
    const before = workspaceExtensions().length;
    const handler = async (): Promise<boolean> => false;
    registerWorkspaceExtension({ name: "seam-test", handle: handler });
    expect(workspaceExtensions().length).toBe(before + 1);
    expect(workspaceExtensions().at(-1)?.name).toBe("seam-test");
    expect(() => registerWorkspaceExtension({ name: "seam-test", handle: handler })).toThrow(/already registered/);
  });
});

describe("workbench feature seam", () => {
  it("registers panels and rejects duplicate ids", () => {
    const before = workbenchFeatures().length;
    const component = (): null => null;
    registerWorkbenchFeature({ id: "seam-panel", label: "Seam", icon: "◇", workbenches: ["story"], component });
    expect(workbenchFeatures().length).toBe(before + 1);
    expect(() => registerWorkbenchFeature({ id: "seam-panel", label: "Seam", icon: "◇", workbenches: ["story"], component })).toThrow(/already registered/);
  });
});

describe("workspace helpers stay exported for feature services", () => {
  it("maps stale-version filesystem failures to the conflict status", () => {
    const mapped = mapFsError(new FsError("stale", "FS_STALE_VERSION"));
    expect(mapped?.status).toBe(412);
    expect(mapped?.message).toContain("已在磁盘上更新");
  });

  it("keeps byte-range parsing for media preview", () => {
    expect(parseByteRange("bytes=0-4", 10)).toEqual({ start: 0, end: 4 });
    expect(parseByteRange("bytes=999-", 10)).toBeNull();
    expect(parseByteRange("bytes=abc", 10)).toBeUndefined();
  });
});
