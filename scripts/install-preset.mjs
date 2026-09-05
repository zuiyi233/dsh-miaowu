#!/usr/bin/env node
/* global console:readonly, process:readonly */
// Install the bundled `dsh-miaowu` agent preset into the user's DSH home.
// Target-only write: <homedir>/.dsh/.agent-presets/dsh-miaowu/ — nothing else
// under ~/.dsh is touched. Node >= 18, no third-party deps.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PRESET_ID = "dsh-miaowu";
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const srcDir = join(repoRoot, "packages", "dsh-plugin", "presets", PRESET_ID);
const destDir = join(homedir(), ".dsh", ".agent-presets", PRESET_ID);

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const remove = args.has("--remove");

function listFiles(dir) {
  return readdirSync(dir)
    .filter((f) => statSync(join(dir, f)).isFile())
    .sort();
}

function sameContent(a, b) {
  try {
    return readFileSync(a, "utf8") === readFileSync(b, "utf8");
  } catch {
    return false;
  }
}

if (remove) {
  if (!existsSync(destDir)) {
    console.log(`[preset] not installed: ${destDir} (nothing to do)`);
    process.exit(0);
  }
  if (dryRun) {
    console.log(`[preset] dry-run: would remove ${destDir}`);
    process.exit(0);
  }
  rmSync(destDir, { recursive: true, force: true });
  console.log(`[preset] removed ${destDir}`);
  console.log("重启 DSH 后生效。");
  process.exit(0);
}

if (!existsSync(srcDir)) {
  console.error(`[preset] source missing: ${srcDir}`);
  process.exit(1);
}

const files = listFiles(srcDir);
if (!existsSync(destDir)) {
  if (dryRun) {
    console.log(`[preset] dry-run: would create ${destDir} with: ${files.join(", ")}`);
    process.exit(0);
  }
  mkdirSync(destDir, { recursive: true });
  cpSync(srcDir, destDir, { recursive: true });
  console.log(`[preset] installed ${files.length} file(s) -> ${destDir}`);
  console.log("重启 DSH 后生效，在 设置→Agent 预设 可见。");
  process.exit(0);
}

const destFiles = existsSync(destDir) ? listFiles(destDir) : [];
const identical =
  files.length === destFiles.length &&
  files.every((f) => destFiles.includes(f) && sameContent(join(srcDir, f), join(destDir, f)));

if (identical) {
  console.log(`[preset] up to date: ${destDir} (contents identical, skipped)`);
  process.exit(0);
}

if (dryRun) {
  console.log(`[preset] dry-run: would overwrite ${destDir} with: ${files.join(", ")}`);
  process.exit(0);
}
cpSync(srcDir, destDir, { recursive: true });
console.log(`[preset] updated ${destDir} (overwritten)`);
console.log("重启 DSH 后生效，在 设置→Agent 预设 可见。");
