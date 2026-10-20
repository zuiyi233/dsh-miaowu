#!/usr/bin/env node
/* global AbortSignal, process */

// One-command upstream sync factory (skeleton).
//
// A dry run (the default) reads the four pinned manifests and a latest-release map and
// reports which sets are current/behind/ahead/diverged/unavailable. An apply run requires
// a clean tree plus the four upstream checkouts, then invokes the existing assets:sync:*
// scripts and assets:check. It never commits, pushes, tags, publishes or calls a paid
// provider, stops at the first failing step, and always reports a rollback command.
//
// The four pins and their sync scripts/env vars are the ones declared in
// scripts/upstream-updates.mjs, so this factory cannot drift from the update watcher.

import { exec } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { githubSlug, skillSets } from "./upstream-updates.mjs";

const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginPackagePath = "packages/dsh-plugin/package.json";
const reportSchemaVersion = 1;
const maxStepOutput = 4000;
const fetchTimeoutMs = 5000;

/** Only these directories can be rewritten by the sync scripts (they rm -rf each set). */
export const rollbackPaths = skillSets.map((set) => `packages/knowledge/${set.set}`);

const upstreamDirNames = {
  "oh-story": ["oh-story-claudecode", "oh-story"],
  drama: ["drama-skills", "drama"],
  "novel-to-game": ["novel-to-game"],
  "video-recap": ["video-recap-skills", "video-recap"]
};

export const usage = `Usage: node scripts/sync-upstream.mjs [options]

Synchronise the four pinned upstream Skill sets with one verifiable command.
Dry run is the default and never writes; apply runs the existing assets:sync:* scripts
on a clean tree and stops at the first failure.

Options:
  --dry-run              Report what would change; no writes (default)
  --apply                Run the sync steps; requires a clean tree and --upstream-root
  --latest <file>        JSON map of latest upstream releases keyed by set id:
                         { "oh-story": { "version": "0.9.1", "commit": "<sha>" }, ... }
                         Set ids: ${skillSets.map((set) => set.key).join(", ")}
                         When omitted, the GitHub releases API is tried; any failure is
                         reported as "unavailable" instead of thrown.
  --upstream-root <dir>  Directory holding the four upstream checkouts:
                         ${skillSets.map((set) => `${set.key}: ${upstreamDirNames[set.key].join(" or ")}`).join("; ")}
  --json                 Print one JSON report to stdout instead of the human summary
  --verify               After assets:check, run pnpm verify and pnpm test:dsh
                         (never the paid test:dsh:real)
  --help, -h             Show this help and exit 0

Apply never commits, pushes, tags or publishes. The JSON report is written under .tmp/
when that directory is gitignored, otherwise under the OS temp directory; the path is
printed at the end of the run.
`;

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

function truncate(value) {
  return value.length > maxStepOutput ? `${value.slice(0, maxStepOutput)}\n[truncated]` : value;
}

function cleanVersion(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().replace(/^v/u, "");
  return trimmed === "" ? undefined : trimmed;
}

export function parseArgs(argv = []) {
  const options = {
    mode: "dry-run",
    modeExplicit: false,
    latestFile: undefined,
    upstreamRoot: undefined,
    json: false,
    verify: false,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run" || arg === "--apply") {
      const mode = arg === "--apply" ? "apply" : "dry-run";
      if (options.modeExplicit && options.mode !== mode) {
        throw new Error("--dry-run and --apply are mutually exclusive");
      }
      options.mode = mode;
      options.modeExplicit = true;
    } else if (arg === "--latest" || arg === "--upstream-root") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (arg === "--latest") options.latestFile = value;
      else options.upstreamRoot = value;
      index += 1;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--verify") {
      options.verify = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

export function manifestPathFor(set) {
  return `packages/knowledge/${set.set}/manifest.json`;
}

/** Read the four pinned manifests; a missing or malformed pin is a hard error. */
export async function loadLocalPins({ repoRoot = moduleRoot } = {}) {
  const pins = [];
  for (const set of skillSets) {
    const manifestPath = manifestPathFor(set);
    let manifest;
    try {
      manifest = JSON.parse(await readFile(path.join(repoRoot, manifestPath), "utf8"));
    } catch (error) {
      throw new Error(`cannot read ${manifestPath}: ${message(error)}`, { cause: error });
    }
    const upstream = manifest?.upstream ?? {};
    if (typeof upstream.commit !== "string" || !/^[0-9a-f]{40}$/iu.test(upstream.commit)) {
      throw new Error(`${manifestPath} has no full 40-character upstream.commit`);
    }
    pins.push({
      id: set.key,
      name: set.name,
      manifestPath,
      repository: typeof upstream.repository === "string" ? upstream.repository : undefined,
      pinnedVersion: cleanVersion(upstream.releaseVersion),
      pinnedCommit: upstream.commit.toLowerCase()
    });
  }
  return pins;
}

function parseVersion(value) {
  if (typeof value !== "string") return undefined;
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u.exec(value.trim());
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split(".")
  };
}

/** Semver precedence, including prerelease identifiers; undefined for unparsable input. */
export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return undefined;
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/u.test(leftPart);
    const rightNumeric = /^\d+$/u.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) < Number(rightPart) ? -1 : 1;
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function satisfiesAlternative(version, alternative) {
  let sawComparable = false;
  for (const token of alternative.split(/\s+/u).filter(Boolean)) {
    const match = /^(>=|<=|>|<|=)?(.+)$/u.exec(token);
    if (!match) return undefined;
    const operator = match[1] ?? "=";
    const order = compareVersions(version, match[2]);
    if (order === undefined) return undefined;
    sawComparable = true;
    if (operator === ">=" && order < 0) return false;
    if (operator === ">" && order <= 0) return false;
    if (operator === "<=" && order > 0) return false;
    if (operator === "<" && order >= 0) return false;
    if (operator === "=" && order !== 0) return false;
  }
  return sawComparable ? true : undefined;
}

/** Minimal semver range check for the `||`/comparator ranges used by engines.dsh. */
export function satisfiesRange(version, range) {
  if (typeof version !== "string" || typeof range !== "string" || range.trim() === "") return undefined;
  if (!parseVersion(version)) return undefined;
  const outcomes = range
    .split("||")
    .map((alternative) => alternative.trim())
    .filter(Boolean)
    .map((alternative) => satisfiesAlternative(version, alternative));
  const usable = outcomes.filter((outcome) => outcome !== undefined);
  if (usable.length === 0) return undefined;
  return usable.some(Boolean);
}

/** Declared DSH range plus the default host the plugin currently builds and tests against. */
export function readDshContract(pluginPackage) {
  const declaredRange = typeof pluginPackage?.engines?.dsh === "string" ? pluginPackage.engines.dsh : null;
  const hostPin = pluginPackage?.devDependencies?.["@deepseek-ai/dsh-agent"]
    ?? pluginPackage?.peerDependencies?.["@deepseek-ai/dsh-agent"]
    ?? null;
  const defaultHost = typeof hostPin === "string" ? hostPin : null;
  let status = "unavailable";
  if (declaredRange && defaultHost) {
    const aligned = satisfiesRange(defaultHost, declaredRange);
    status = aligned === undefined ? "unknown" : aligned ? "aligned" : "mismatch";
  }
  return { declaredRange, defaultHost, status };
}

function normalizeLatest(entry) {
  if (entry === undefined || entry === null) return { unavailable: true, reason: "no latest entry" };
  if (typeof entry === "string") return normalizeLatest({ version: entry });
  if (typeof entry !== "object" || Array.isArray(entry)) {
    return { unavailable: true, reason: "latest entry is not an object" };
  }
  if (entry.status === "unavailable" || entry.error) {
    return { unavailable: true, reason: typeof entry.error === "string" ? entry.error : "marked unavailable" };
  }
  const version = cleanVersion(entry.version ?? entry.releaseVersion ?? entry.tag ?? entry.tagName);
  const commit = typeof entry.commit === "string" && entry.commit.length > 0 ? entry.commit.toLowerCase() : undefined;
  if (!version && !commit) return { unavailable: true, reason: "latest entry has neither version nor commit" };
  return { version, commit };
}

/**
 * current = same version (and commit when both are known); behind = pinned is older;
 * ahead = pinned is newer than the latest release; diverged = same version but a different
 * commit, or commits differ with no version to order them; unavailable = no usable data.
 */
export function classifyPin(pin, latest) {
  const normalized = normalizeLatest(latest);
  if (normalized.unavailable) return "unavailable";
  if (normalized.version && pin.pinnedVersion) {
    const order = compareVersions(pin.pinnedVersion, normalized.version);
    if (order !== undefined) {
      if (order < 0) return "behind";
      if (order > 0) return "ahead";
      if (normalized.commit && normalized.commit !== pin.pinnedCommit) return "diverged";
      return "current";
    }
  }
  if (normalized.commit) return normalized.commit === pin.pinnedCommit ? "current" : "diverged";
  return "unavailable";
}

export function diffPins(pins, latestBySet = {}) {
  return pins.map((pin) => {
    const latest = latestBySet?.[pin.id];
    const normalized = normalizeLatest(latest);
    return {
      id: pin.id,
      manifestPath: pin.manifestPath,
      pinnedVersion: pin.pinnedVersion ?? null,
      pinnedCommit: pin.pinnedCommit,
      latestVersion: normalized.version ?? null,
      latestCommit: normalized.commit ?? null,
      status: classifyPin(pin, latest),
      ...(normalized.unavailable && normalized.reason ? { note: normalized.reason } : {})
    };
  });
}

export function assertCleanStatus(statusOutput) {
  const dirty = String(statusOutput ?? "")
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== "");
  if (dirty.length > 0) {
    const error = new Error(`working tree is dirty (${dirty.length} path${dirty.length === 1 ? "" : "s"}); commit or stash before --apply`);
    error.paths = dirty;
    throw error;
  }
}

export function rollbackCommandFor(baseSha, paths = rollbackPaths) {
  if (typeof baseSha !== "string" || baseSha.trim() === "") {
    throw new Error("rollbackCommandFor requires the base commit");
  }
  return `git restore --source=${baseSha.trim()} -- ${paths.join(" ")}`;
}

export function reportFileName(now = new Date()) {
  return `sync-report-${now.toISOString().replace(/[:.]/gu, "-")}.json`;
}

/**
 * .tmp/ is preferred only when it is already gitignored; this fork's .gitignore does not
 * list it, so reports fall back to the OS temp directory rather than polluting the repo.
 */
export function reportLocation({ repoRoot = moduleRoot, gitignoreText = "", tmpDir = os.tmpdir(), now = new Date() } = {}) {
  const fileName = reportFileName(now);
  const ignoresTmp = String(gitignoreText)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .some((line) => line === ".tmp" || line === ".tmp/" || line === "/.tmp" || line === "/.tmp/");
  if (ignoresTmp) return { path: path.join(repoRoot, ".tmp", fileName), insideRepo: true };
  return { path: path.join(tmpDir, "dsh-miaowu-sync", fileName), insideRepo: false };
}

export function parseStatusPaths(statusOutput) {
  return String(statusOutput ?? "")
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== "")
    .map((line) => line.slice(3).trim())
    .filter((entry) => entry !== "")
    .map((entry) => entry.replace(/^"(.*)"$/u, "$1"));
}

export const rollbackNote = "git restore only covers tracked files; remove any new untracked files under the sync roots with git status --porcelain.";

export function buildReport({
  mode,
  baseSha,
  rollbackCommand,
  sets,
  dsh,
  steps,
  startedAt,
  finishedAt,
  failedStep,
  latestSource,
  reportFile
}) {
  return {
    schemaVersion: reportSchemaVersion,
    mode,
    startedAt,
    finishedAt,
    baseSha,
    rollbackCommand,
    rollbackNote,
    latestSource: latestSource ?? null,
    dsh,
    sets,
    steps,
    ...(failedStep ? { failedStep } : {}),
    ...(reportFile ? { reportFile } : {})
  };
}

/**
 * Read-only latest-release lookup. The four upstream repositories are public, so an
 * unauthenticated request is allowed; a token is used when present. Every failure is
 * downgraded to `unavailable` so a dry run never throws on network problems.
 */
export async function fetchLatestVersions({ pins, token, fetchImpl = globalThis.fetch, timeoutMs = fetchTimeoutMs } = {}) {
  const latest = {};
  const headers = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "dsh-miaowu-sync-upstream"
  };
  if (token) headers.authorization = `Bearer ${token}`;
  await Promise.all((pins ?? []).map(async (pin) => {
    if (typeof fetchImpl !== "function") {
      latest[pin.id] = { status: "unavailable", error: "fetch is not available" };
      return;
    }
    let slug;
    try {
      slug = githubSlug(pin.repository);
    } catch (error) {
      latest[pin.id] = { status: "unavailable", error: message(error) };
      return;
    }
    try {
      const response = await fetchImpl(`https://api.github.com/repos/${slug}/releases/latest`, {
        headers,
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!response.ok) {
        latest[pin.id] = { status: "unavailable", error: `HTTP ${response.status}` };
        return;
      }
      const release = await response.json();
      let commit;
      try {
        const commitResponse = await fetchImpl(`https://api.github.com/repos/${slug}/commits/${release.tag_name}`, {
          headers,
          signal: AbortSignal.timeout(timeoutMs)
        });
        if (commitResponse.ok) {
          const commitJson = await commitResponse.json();
          commit = typeof commitJson.sha === "string" ? commitJson.sha : undefined;
        }
      } catch {
        commit = undefined;
      }
      latest[pin.id] = { version: cleanVersion(release.tag_name), commit, url: release.html_url };
    } catch (error) {
      latest[pin.id] = { status: "unavailable", error: message(error) };
    }
  }));
  return latest;
}

const safeCommandArgument = /^[A-Za-z0-9_./:=@-]+$/u;

/** Commands/args are constants (paths travel via env); reject anything shell-active. */
function quoteArgument(value) {
  if (typeof value !== "string" || !safeCommandArgument.test(value)) {
    throw new Error(`refusing to run with an unsafe command argument: ${String(value)}`);
  }
  return value;
}

/** Default runner; resolves instead of rejecting so a missing binary is a failed step. */
export function createRunner({ cwd = moduleRoot, env = process.env } = {}) {
  return (command, args = [], options = {}) => new Promise((resolve) => {
    // exec uses the platform shell, so pnpm's .cmd shim resolves on Windows. Every token
    // is an ASCII constant and unsafe characters are rejected above, so the shell never
    // sees user-controlled data.
    const commandLine = [command, ...args].map(quoteArgument).join(" ");
    exec(commandLine, {
      cwd: options.cwd ?? cwd,
      env: { ...env, ...options.env },
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      encoding: "utf8"
    }, (error, stdoutText, stderrText) => {
      const code = error === null
        ? 0
        : typeof error.code === "number" ? error.code : 1;
      resolve({ code, stdout: stdoutText ?? "", stderr: stderrText ?? "" });
    });
  });
}

export async function resolveUpstreamDirs({ upstreamRoot, statFn = stat } = {}) {
  if (!upstreamRoot) throw new Error("--upstream-root is required with --apply");
  const root = path.resolve(upstreamRoot);
  const dirs = {};
  const missing = [];
  for (const set of skillSets) {
    let found;
    for (const name of upstreamDirNames[set.key]) {
      const candidate = path.join(root, name);
      const info = await statFn(candidate).catch(() => undefined);
      if (info?.isDirectory()) {
        found = candidate;
        break;
      }
    }
    if (found) dirs[set.key] = found;
    else missing.push(`${set.key} (expected ${upstreamDirNames[set.key].map((name) => path.join(root, name)).join(" or ")})`);
  }
  if (missing.length > 0) {
    throw new Error(`--upstream-root is missing upstream checkouts: ${missing.join("; ")}`);
  }
  return dirs;
}

function humanSummary(report) {
  const lines = [`sync-upstream ${report.mode}${report.latestSource ? ` (latest: ${report.latestSource})` : ""}`];
  lines.push(`base ${report.baseSha}`);
  for (const entry of report.sets) {
    const pinned = entry.pinnedVersion ?? (entry.pinnedCommit ? entry.pinnedCommit.slice(0, 12) : "?");
    const latest = entry.latestVersion ?? (entry.latestCommit ? entry.latestCommit.slice(0, 12) : "unavailable");
    const changed = entry.changedFiles && entry.changedFiles.length > 0 ? ` (${entry.changedFiles.length} changed file${entry.changedFiles.length === 1 ? "" : "s"})` : "";
    lines.push(`  ${entry.id.padEnd(14)} pinned ${pinned.padEnd(14)} latest ${String(latest).padEnd(14)} ${entry.status}${changed}`);
  }
  const dshRange = report.dsh?.declaredRange ?? "unavailable";
  const host = report.dsh?.defaultHost ?? "unavailable";
  lines.push(`  dsh            declared ${dshRange} default host ${host} ${report.dsh?.status ?? "unavailable"}`);
  if (report.failedStep) lines.push(`failed step: ${report.failedStep}`);
  lines.push(`rollback: ${report.rollbackCommand}`);
  lines.push(`rollback note: ${report.rollbackNote}`);
  if (report.reportFile) lines.push(`report: ${report.reportFile}`);
  if (report.mode === "dry-run") {
    lines.push("dry run: no files were written; pass --apply (clean tree + --upstream-root) to sync");
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Orchestrates one dry run or apply run. All side effects go through the injected runner,
 * clock, fetch and stdout/stderr so tests can exercise every branch without spawning
 * pnpm/git or touching the network.
 */
export async function runSync(options = parseArgs([]), deps = {}) {
  const repoRoot = deps.repoRoot ?? moduleRoot;
  const runner = deps.runner ?? createRunner({ cwd: repoRoot });
  const now = deps.now ?? (() => new Date());
  const stdout = deps.stdout ?? ((text) => process.stdout.write(text));
  const stderr = deps.stderr ?? ((text) => process.stderr.write(text));
  const startedAt = now().toISOString();

  if (options.help) {
    stdout(usage);
    return 0;
  }

  const steps = [];
  const runStep = async (name, command, args, extra = {}) => {
    const stepStarted = Date.now();
    let result;
    try {
      result = await runner(command, args, extra);
    } catch (error) {
      result = { code: 1, stdout: "", stderr: message(error) };
    }
    const step = {
      name,
      command: [command, ...args].join(" "),
      status: result.code === 0 ? "ok" : "failed",
      exitCode: result.code,
      durationMs: Date.now() - stepStarted
    };
    if (typeof result.stdout === "string" && result.stdout.trim() !== "") step.stdout = truncate(result.stdout.trim());
    if (typeof result.stderr === "string" && result.stderr.trim() !== "") step.stderr = truncate(result.stderr.trim());
    steps.push(step);
    return step;
  };

  let pins;
  let pluginPackage;
  try {
    pins = await loadLocalPins({ repoRoot });
    pluginPackage = JSON.parse(await readFile(path.join(repoRoot, pluginPackagePath), "utf8"));
  } catch (error) {
    stderr(`sync-upstream: ${message(error)}\n`);
    return 2;
  }

  let latestBySet;
  let latestSource = null;
  if (options.latestFile) {
    try {
      const parsed = JSON.parse(await readFile(path.resolve(options.latestFile), "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("latest file must be a JSON object keyed by set id");
      }
      latestBySet = parsed;
      latestSource = path.resolve(options.latestFile);
    } catch (error) {
      stderr(`sync-upstream: cannot read --latest ${options.latestFile}: ${message(error)}\n`);
      return 2;
    }
  } else {
    const token = deps.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    const fetchLatest = deps.fetchLatest ?? fetchLatestVersions;
    latestBySet = await fetchLatest({ pins, token, fetchImpl: deps.fetchImpl });
    latestSource = token ? "github (authenticated)" : "github (public, unauthenticated)";
  }

  const baseStep = await runStep("base", "git", ["rev-parse", "HEAD"]);
  if (baseStep.status !== "ok" || !baseStep.stdout) {
    stderr("sync-upstream: cannot resolve HEAD; is this a git checkout?\n");
    return 2;
  }
  const baseSha = baseStep.stdout.split(/\r?\n/u)[0].trim();

  let sets = diffPins(pins, latestBySet);
  const dsh = readDshContract(pluginPackage);
  const rollbackCommand = rollbackCommandFor(baseSha, rollbackPaths);

  const finish = async ({ failedStep, writeReport }) => {
    const finishedAt = now().toISOString();
    let reportFile;
    if (writeReport) {
      if (deps.reportDir) {
        reportFile = path.join(deps.reportDir, reportFileName(now()));
      } else {
        const gitignoreText = await readFile(path.join(repoRoot, ".gitignore"), "utf8").catch(() => "");
        reportFile = reportLocation({ repoRoot, gitignoreText, tmpDir: deps.tmpDir ?? os.tmpdir(), now: now() }).path;
      }
      await mkdir(path.dirname(reportFile), { recursive: true });
    }
    const report = buildReport({
      mode: options.mode,
      baseSha,
      rollbackCommand,
      sets,
      dsh,
      steps,
      startedAt,
      finishedAt,
      failedStep,
      latestSource,
      reportFile
    });
    if (reportFile) {
      try {
        await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      } catch (error) {
        delete report.reportFile;
        report.reportFileError = message(error);
        stderr(`sync-upstream: cannot write report ${reportFile}: ${message(error)}\n`);
      }
    }
    if (options.json) stdout(`${JSON.stringify(report, null, 2)}\n`);
    else stdout(humanSummary(report));
    return failedStep ? 1 : 0;
  };

  if (options.mode === "dry-run") return finish({ failedStep: undefined, writeReport: false });

  const cleanStep = await runStep("clean-tree", "git", ["status", "--porcelain"]);
  if (cleanStep.status !== "ok") {
    stderr("sync-upstream: git status failed; refusing to apply\n");
    return finish({ failedStep: "clean-tree", writeReport: false });
  }
  try {
    assertCleanStatus(cleanStep.stdout ?? "");
  } catch (error) {
    stderr(`sync-upstream: ${message(error)}\n`);
    return finish({ failedStep: "clean-tree", writeReport: false });
  }

  let upstreamDirs;
  try {
    upstreamDirs = await resolveUpstreamDirs({ upstreamRoot: options.upstreamRoot });
  } catch (error) {
    stderr(`sync-upstream: ${message(error)}\n`);
    return finish({ failedStep: "upstream-root", writeReport: false });
  }

  let failedStep;
  for (const set of skillSets) {
    const step = await runStep(`sync:${set.key}`, "pnpm", [set.sync], { env: { [set.env]: upstreamDirs[set.key] } });
    if (step.status !== "ok") {
      failedStep = step.name;
      break;
    }
  }
  if (!failedStep) {
    const checkStep = await runStep("assets:check", "pnpm", ["assets:check"]);
    if (checkStep.status !== "ok") failedStep = checkStep.name;
  }
  if (!failedStep && options.verify) {
    const verifyStep = await runStep("verify", "pnpm", ["verify"]);
    if (verifyStep.status !== "ok") {
      failedStep = verifyStep.name;
    } else {
      const smokeStep = await runStep("test:dsh", "pnpm", ["test:dsh"]);
      if (smokeStep.status !== "ok") failedStep = smokeStep.name;
    }
  }

  if (!failedStep) {
    const changedStep = await runStep("changed-files", "git", ["status", "--porcelain"]);
    if (changedStep.status === "ok") {
      const paths = parseStatusPaths(changedStep.stdout);
      sets = sets.map((entry) => {
        const set = skillSets.find((candidate) => candidate.key === entry.id);
        const root = `packages/knowledge/${set.set}`;
        return { ...entry, changedFiles: paths.filter((file) => file === root || file.startsWith(`${root}/`)) };
      });
    }
  }

  return finish({ failedStep, writeReport: true });
}

async function cli(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`sync-upstream: ${message(error)}\nRun with --help for usage.\n`);
    return 2;
  }
  try {
    return await runSync(options);
  } catch (error) {
    process.stderr.write(`sync-upstream: ${message(error)}\n`);
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await cli(process.argv.slice(2));
}
