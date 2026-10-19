/**
 * Types for `release-identity.mjs`. The module is plain JavaScript so the release
 * scripts can run without a build step; TypeScript callers resolve this declaration
 * beside it (`./release-identity.mjs` under NodeNext).
 */

export declare const RELEASE_IDENTITY: Readonly<{
  readonly repository: string;
  readonly packageName: string;
  readonly packageScope: string;
  readonly packageLeaf: string;
  readonly tarballPrefix: string;
  readonly tagPrefix: string;
  readonly userAgent: string;
  readonly tempPrefix: string;
}>;

export declare function isPackedPluginSkillPath(
  skillPath: string | null | undefined,
  packageName?: string,
): boolean;
