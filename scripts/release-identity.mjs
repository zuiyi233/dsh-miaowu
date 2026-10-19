import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const pluginManifestPath = path.join(scriptsDirectory, "..", "packages", "dsh-plugin", "package.json");

function readPluginManifest() {
  return JSON.parse(readFileSync(pluginManifestPath, "utf8"));
}

function parseGitHubRepository(url) {
  const value = String(url ?? "").trim();
  const match = /github\.com[:/]([^/]+)\/([^/#?]+?)(?:\.git)?\/?$/i.exec(value);
  if (!match) {
    throw new Error(`cannot derive the release repository from packages/dsh-plugin/package.json repository.url: ${value}`);
  }
  return `${match[1]}/${match[2]}`;
}

const pluginManifest = readPluginManifest();
const packageName = pluginManifest.name;
if (typeof packageName !== "string" || !/^@[^/]+\/[^/]+$/.test(packageName)) {
  throw new Error(`packages/dsh-plugin/package.json must declare a scoped package name, received ${packageName}`);
}

const packageScope = packageName.slice(0, packageName.indexOf("/"));
const packageLeaf = packageName.slice(packageName.indexOf("/") + 1);

// Frozen so release stages cannot drift away from the packed package identity.
export const RELEASE_IDENTITY = Object.freeze({
  repository: parseGitHubRepository(pluginManifest.repository?.url),
  packageName,
  packageScope,
  packageLeaf,
  tarballPrefix: `${packageScope.slice(1)}-${packageLeaf}`,
  tagPrefix: "miaowu-v",
  userAgent: "dsh-miaowu-release",
  tempPrefix: "dsh-miaowu-public-",
});

export function isPackedPluginSkillPath(skillPath, packageName = RELEASE_IDENTITY.packageName) {
  return String(skillPath ?? "")
    .replaceAll("\\", "/")
    .includes(`/${packageName}/lib/`);
}
