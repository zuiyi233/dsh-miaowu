import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertCleanStatus,
  buildReport,
  classifyPin,
  compareVersions,
  diffPins,
  fetchLatestVersions,
  loadLocalPins,
  parseArgs,
  parseStatusPaths,
  readDshContract,
  reportFileName,
  reportLocation,
  rollbackCommandFor,
  rollbackPaths,
  runSync,
  satisfiesRange,
  usage
} from "./sync-upstream.mjs";

const baseSha = "1111111111111111111111111111111111111111";
const commits = {
  "oh-story": "a".repeat(40),
  drama: "b".repeat(40),
  "novel-to-game": "c".repeat(40),
  "video-recap": "d".repeat(40)
};
const pinnedVersions = {
  "oh-story": "0.9.0",
  drama: undefined,
  "novel-to-game": "0.6.0",
  "video-recap": "0.6.2"
};
const dshRange = ">=0.2.0-rc.2 <0.2.1-0 || >=0.2.1-alpha.1 <0.2.2-0";
const fixedNow = () => new Date("2026-10-21T01:02:03.456Z");

async function fixtureRepo(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-sync-upstream-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [set, commit] of Object.entries(commits)) {
    const directory = path.join(root, "packages/knowledge", set);
    await mkdir(directory, { recursive: true });
    const upstream = { repository: `https://github.com/zenstory-ai/${set}.git`, commit };
    if (pinnedVersions[set]) upstream.releaseVersion = pinnedVersions[set];
    await writeFile(
      path.join(directory, "manifest.json"),
      JSON.stringify({ schemaVersion: 1, upstream, generatedAt: "2026-10-01T00:00:00.000Z", skills: [], files: [] })
    );
  }
  await mkdir(path.join(root, "packages/dsh-plugin"), { recursive: true });
  await writeFile(
    path.join(root, "packages/dsh-plugin/package.json"),
    JSON.stringify({
      name: "@dsh-miaowu/dsh",
      engines: { dsh: dshRange },
      peerDependencies: { "@deepseek-ai/dsh-agent": dshRange },
      devDependencies: { "@deepseek-ai/dsh-agent": "0.2.1-rc.2" }
    })
  );
  return root;
}

async function upstreamRootFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-sync-upstream-dirs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ["oh-story-claudecode", "drama-skills", "novel-to-game", "video-recap-skills"]) {
    await mkdir(path.join(root, name), { recursive: true });
  }
  return root;
}

function fakeRunner({ status = "", head = baseSha, overrides = {} } = {}) {
  const calls = [];
  const runner = async (command, args = [], options = {}) => {
    const key = `${command} ${args.join(" ")}`;
    calls.push({ command, args, key, env: options.env });
    if (overrides[key]) return overrides[key];
    if (key === "git rev-parse HEAD") return { code: 0, stdout: `${head}\n`, stderr: "" };
    if (key === "git status --porcelain") return { code: 0, stdout: status, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { runner, calls };
}

function capture() {
  const chunks = { stdout: "", stderr: "" };
  return {
    chunks,
    stdout: (text) => { chunks.stdout += text; },
    stderr: (text) => { chunks.stderr += text; }
  };
}

test("parseArgs defaults to a dry run and parses every documented flag", () => {
  assert.equal(parseArgs([]).mode, "dry-run");
  assert.equal(parseArgs([]).json, false);
  assert.equal(parseArgs([]).help, false);

  const apply = parseArgs(["--apply", "--json", "--verify", "--latest", "latest.json", "--upstream-root", "upstreams"]);
  assert.equal(apply.mode, "apply");
  assert.equal(apply.json, true);
  assert.equal(apply.verify, true);
  assert.equal(apply.latestFile, "latest.json");
  assert.equal(apply.upstreamRoot, "upstreams");

  assert.equal(parseArgs(["--dry-run"]).mode, "dry-run");
  assert.equal(parseArgs(["--help"]).help, true);
  assert.throws(() => parseArgs(["--apply", "--dry-run"]), /mutually exclusive/u);
  assert.throws(() => parseArgs(["--latest"]), /requires a value/u);
  assert.throws(() => parseArgs(["--bogus"]), /unknown argument/u);
});

test("loadLocalPins reads the four manifests with their pinned versions and commits", async (t) => {
  const repoRoot = await fixtureRepo(t);
  const pins = await loadLocalPins({ repoRoot });

  assert.deepEqual(pins.map((pin) => pin.id), ["oh-story", "drama", "novel-to-game", "video-recap"]);
  assert.deepEqual(pins.map((pin) => pin.manifestPath), [
    "packages/knowledge/oh-story/manifest.json",
    "packages/knowledge/drama/manifest.json",
    "packages/knowledge/novel-to-game/manifest.json",
    "packages/knowledge/video-recap/manifest.json"
  ]);
  assert.equal(pins.find((pin) => pin.id === "oh-story").pinnedVersion, "0.9.0");
  assert.equal(pins.find((pin) => pin.id === "drama").pinnedVersion, undefined);
  assert.equal(pins.find((pin) => pin.id === "video-recap").pinnedCommit, commits["video-recap"]);
});

test("classifyPin separates current, behind, ahead, diverged and unavailable", () => {
  const pin = { id: "oh-story", pinnedVersion: "1.2.3", pinnedCommit: "a".repeat(40) };
  assert.equal(classifyPin(pin, { version: "v1.2.3", commit: pin.pinnedCommit }), "current");
  assert.equal(classifyPin(pin, { version: "1.2.4", commit: "b".repeat(40) }), "behind");
  assert.equal(classifyPin(pin, { version: "1.2.2", commit: "b".repeat(40) }), "ahead");
  assert.equal(classifyPin(pin, { version: "1.2.3", commit: "b".repeat(40) }), "diverged");
  assert.equal(classifyPin(pin, undefined), "unavailable");
  assert.equal(classifyPin(pin, { error: "HTTP 404" }), "unavailable");
  assert.equal(classifyPin(pin, {}), "unavailable");

  const noVersion = { id: "drama", pinnedCommit: "c".repeat(40) };
  assert.equal(classifyPin(noVersion, { commit: "c".repeat(40) }), "current");
  assert.equal(classifyPin(noVersion, { commit: "d".repeat(40) }), "diverged");
  assert.equal(classifyPin(noVersion, { version: "0.7.0" }), "unavailable");
});

test("diffPins reports every pinned set with nulls for missing latest data", async (t) => {
  const repoRoot = await fixtureRepo(t);
  const pins = await loadLocalPins({ repoRoot });
  const sets = diffPins(pins, { "oh-story": { version: "0.9.1", commit: "e".repeat(40) } });

  assert.equal(sets.length, 4);
  assert.deepEqual(sets[0], {
    id: "oh-story",
    manifestPath: "packages/knowledge/oh-story/manifest.json",
    pinnedVersion: "0.9.0",
    pinnedCommit: commits["oh-story"],
    latestVersion: "0.9.1",
    latestCommit: "e".repeat(40),
    status: "behind"
  });
  assert.equal(sets[1].latestVersion, null);
  assert.equal(sets[1].latestCommit, null);
  assert.equal(sets[1].status, "unavailable");
  assert.equal(sets[1].note, "no latest entry");
});

test("DSH reporting follows engines.dsh and flags a default host outside the range", () => {
  const aligned = readDshContract({
    engines: { dsh: dshRange },
    devDependencies: { "@deepseek-ai/dsh-agent": "0.2.1-rc.2" }
  });
  assert.equal(aligned.declaredRange, dshRange);
  assert.equal(aligned.defaultHost, "0.2.1-rc.2");
  assert.equal(aligned.status, "aligned");

  const changedHost = readDshContract({
    engines: { dsh: dshRange },
    devDependencies: { "@deepseek-ai/dsh-agent": "0.2.2-rc.1" }
  });
  assert.equal(changedHost.defaultHost, "0.2.2-rc.1");
  assert.equal(changedHost.status, "mismatch");

  assert.equal(readDshContract({}).status, "unavailable");
  assert.equal(satisfiesRange("0.2.1-alpha.5", dshRange), true);
  assert.equal(satisfiesRange("0.2.2-0", dshRange), false);
  assert.equal(satisfiesRange("0.2.2-rc.1", dshRange), false);
  assert.equal(satisfiesRange("not-a-version", dshRange), undefined);
  assert.equal(compareVersions("0.2.1-alpha.2", "0.2.1-alpha.5"), -1);
  assert.equal(compareVersions("0.2.1-rc.2", "0.2.1-0"), 1);
});

test("fetchLatestVersions degrades network failures to unavailable instead of throwing", async () => {
  const pin = { id: "oh-story", repository: "https://github.com/zenstory-ai/oh-story-claudecode.git" };
  const offline = await fetchLatestVersions({
    pins: [pin],
    fetchImpl: async () => { throw new Error("offline"); }
  });
  assert.equal(offline["oh-story"].status, "unavailable");
  assert.match(offline["oh-story"].error, /offline/u);

  const rejected = await fetchLatestVersions({
    pins: [pin],
    fetchImpl: async () => ({ ok: false, status: 404 })
  });
  assert.equal(rejected["oh-story"].status, "unavailable");
  assert.equal(rejected["oh-story"].error, "HTTP 404");
});

test("dry run classifies fixtures, reports base/DSH and runs no sync command", async (t) => {
  const repoRoot = await fixtureRepo(t);
  const latestFile = path.join(repoRoot, "latest.json");
  await writeFile(latestFile, JSON.stringify({
    "oh-story": { version: "0.9.1", commit: "e".repeat(40) },
    drama: { version: "0.6.0", commit: commits.drama },
    "novel-to-game": { version: "0.6.0", commit: "f".repeat(40) },
    "video-recap": { version: "0.6.1", commit: "1".repeat(40) }
  }));

  const { runner, calls } = fakeRunner();
  const output = capture();
  const manifestBefore = await readFile(path.join(repoRoot, "packages/knowledge/oh-story/manifest.json"), "utf8");
  const code = await runSync(parseArgs(["--dry-run", "--json", "--latest", latestFile]), {
    repoRoot,
    runner,
    now: fixedNow,
    stdout: output.stdout,
    stderr: output.stderr
  });

  assert.equal(code, 0);
  assert.equal(await readFile(path.join(repoRoot, "packages/knowledge/oh-story/manifest.json"), "utf8"), manifestBefore);
  assert.deepEqual((await readdir(repoRoot)).sort(), ["latest.json", "packages"]);
  assert.deepEqual(calls.map((call) => call.key), ["git rev-parse HEAD"]);
  const report = JSON.parse(output.chunks.stdout);
  assert.equal(report.mode, "dry-run");
  assert.equal(report.baseSha, baseSha);
  assert.equal(report.startedAt, "2026-10-21T01:02:03.456Z");
  assert.equal(report.finishedAt, "2026-10-21T01:02:03.456Z");
  assert.deepEqual(report.sets.map((entry) => entry.status), ["behind", "current", "diverged", "ahead"]);
  assert.equal(report.sets[0].manifestPath, "packages/knowledge/oh-story/manifest.json");
  assert.equal(report.dsh.declaredRange, dshRange);
  assert.equal(report.dsh.defaultHost, "0.2.1-rc.2");
  assert.equal(report.dsh.status, "aligned");
  assert.equal(report.rollbackCommand, `git restore --source=${baseSha} -- ${rollbackPaths.join(" ")}`);
  assert.match(report.rollbackNote, /tracked files/u);
  assert.equal(report.reportFile, undefined);
  assert.equal(output.chunks.stderr, "");
});

test("apply refuses a dirty tree before invoking any sync step", async (t) => {
  const repoRoot = await fixtureRepo(t);
  const upstreamRoot = await upstreamRootFixture(t);
  const { runner, calls } = fakeRunner({ status: " M packages/knowledge/oh-story/manifest.json\n" });
  const output = capture();

  const code = await runSync(
    parseArgs(["--apply", "--upstream-root", upstreamRoot, "--json"]),
    { repoRoot, runner, now: fixedNow, stdout: output.stdout, stderr: output.stderr, fetchLatest: async () => ({}) }
  );

  assert.equal(code, 1);
  assert.equal(calls.some((call) => call.command === "pnpm"), false);
  assert.deepEqual(calls.map((call) => call.key), ["git rev-parse HEAD", "git status --porcelain"]);
  const report = JSON.parse(output.chunks.stdout);
  assert.equal(report.failedStep, "clean-tree");
  assert.ok(report.rollbackCommand.startsWith(`git restore --source=${baseSha} -- `));
  assert.equal(report.reportFile, undefined);
  assert.match(output.chunks.stderr, /working tree is dirty/u);
});

test("apply refuses a missing upstream checkout before writing", async (t) => {
  const repoRoot = await fixtureRepo(t);
  const emptyRoot = await mkdtemp(path.join(os.tmpdir(), "dsh-sync-upstream-empty-"));
  t.after(() => rm(emptyRoot, { recursive: true, force: true }));
  const { runner, calls } = fakeRunner();
  const output = capture();

  const code = await runSync(
    parseArgs(["--apply", "--upstream-root", emptyRoot, "--json"]),
    { repoRoot, runner, now: fixedNow, stdout: output.stdout, stderr: output.stderr, fetchLatest: async () => ({}) }
  );

  assert.equal(code, 1);
  assert.equal(calls.some((call) => call.command === "pnpm"), false);
  const report = JSON.parse(output.chunks.stdout);
  assert.equal(report.failedStep, "upstream-root");
  assert.equal(report.reportFile, undefined);
  assert.match(output.chunks.stderr, /missing upstream checkouts/u);
});

test("apply stops at a failing sync step, reports it and still reports the rollback", async (t) => {
  const repoRoot = await fixtureRepo(t);
  const upstreamRoot = await upstreamRootFixture(t);
  const reportDir = await mkdtemp(path.join(os.tmpdir(), "dsh-sync-upstream-report-"));
  t.after(() => rm(reportDir, { recursive: true, force: true }));
  const { runner, calls } = fakeRunner({
    overrides: { "pnpm assets:sync:drama": { code: 2, stdout: "", stderr: "boom" } }
  });
  const output = capture();

  const code = await runSync(
    parseArgs(["--apply", "--upstream-root", upstreamRoot, "--json"]),
    {
      repoRoot,
      runner,
      reportDir,
      now: fixedNow,
      stdout: output.stdout,
      stderr: output.stderr,
      fetchLatest: async () => ({})
    }
  );

  assert.equal(code, 1);
  assert.deepEqual(
    calls.filter((call) => call.command === "pnpm").map((call) => call.key),
    ["pnpm assets:sync:story", "pnpm assets:sync:drama"]
  );
  const report = JSON.parse(output.chunks.stdout);
  assert.equal(report.failedStep, "sync:drama");
  const failedStep = report.steps.find((step) => step.name === "sync:drama");
  assert.equal(failedStep.status, "failed");
  assert.equal(failedStep.exitCode, 2);
  assert.deepEqual(report.steps.map((step) => step.name), [
    "base",
    "clean-tree",
    "sync:oh-story",
    "sync:drama"
  ]);
  assert.equal(report.rollbackCommand, `git restore --source=${baseSha} -- ${rollbackPaths.join(" ")}`);
  assert.ok(report.reportFile.endsWith("sync-report-2026-10-21T01-02-03-456Z.json"));
  const onDisk = JSON.parse(await readFile(report.reportFile, "utf8"));
  assert.equal(onDisk.failedStep, "sync:drama");
  assert.equal(onDisk.baseSha, baseSha);
});

test("apply passes the upstream dirs through the documented env vars and writes a report", async (t) => {
  const repoRoot = await fixtureRepo(t);
  const upstreamRoot = await upstreamRootFixture(t);
  const reportDir = await mkdtemp(path.join(os.tmpdir(), "dsh-sync-upstream-report-"));
  t.after(() => rm(reportDir, { recursive: true, force: true }));
  const { runner, calls } = fakeRunner();
  const output = capture();

  const code = await runSync(
    parseArgs(["--apply", "--upstream-root", upstreamRoot, "--verify", "--json"]),
    {
      repoRoot,
      runner,
      reportDir,
      now: fixedNow,
      stdout: output.stdout,
      stderr: output.stderr,
      fetchLatest: async () => ({})
    }
  );

  assert.equal(code, 0);
  assert.deepEqual(
    calls.filter((call) => call.command === "pnpm").map((call) => call.key),
    [
      "pnpm assets:sync:story",
      "pnpm assets:sync:drama",
      "pnpm assets:sync:game",
      "pnpm assets:sync:video",
      "pnpm assets:check",
      "pnpm verify",
      "pnpm test:dsh"
    ]
  );
  const storyCall = calls.find((call) => call.key === "pnpm assets:sync:story");
  assert.equal(storyCall.env.OH_STORY_UPSTREAM_DIR, path.join(upstreamRoot, "oh-story-claudecode"));
  const videoCall = calls.find((call) => call.key === "pnpm assets:sync:video");
  assert.equal(videoCall.env.VIDEO_RECAP_UPSTREAM_DIR, path.join(upstreamRoot, "video-recap-skills"));
  assert.equal(calls.some((call) => call.key.includes("test:dsh:real")), false);

  const report = JSON.parse(output.chunks.stdout);
  assert.equal(report.mode, "apply");
  assert.equal(report.failedStep, undefined);
  assert.deepEqual(report.steps.map((step) => step.name), [
    "base",
    "clean-tree",
    "sync:oh-story",
    "sync:drama",
    "sync:novel-to-game",
    "sync:video-recap",
    "assets:check",
    "verify",
    "test:dsh",
    "changed-files"
  ]);
  assert.deepEqual(report.sets.map((entry) => entry.changedFiles), [[], [], [], []]);
  assert.ok(report.reportFile.endsWith("sync-report-2026-10-21T01-02-03-456Z.json"));
  const onDisk = JSON.parse(await readFile(report.reportFile, "utf8"));
  assert.deepEqual(onDisk, report);
});

test("rollbackCommandFor names BASE and only the four knowledge set directories", () => {
  const command = rollbackCommandFor(baseSha);
  assert.equal(command, `git restore --source=${baseSha} -- ${rollbackPaths.join(" ")}`);
  assert.equal(rollbackPaths.length, 4);
  for (const entry of rollbackPaths) assert.match(entry, /^packages\/knowledge\/[a-z-]+$/u);
  assert.throws(() => rollbackCommandFor(""), /requires the base commit/u);
});

test("reportLocation prefers .tmp only when it is gitignored, else the OS temp dir", () => {
  const stamp = new Date("2026-10-21T01:02:03.456Z");
  assert.equal(reportFileName(stamp), "sync-report-2026-10-21T01-02-03-456Z.json");

  const outside = reportLocation({ repoRoot: path.join("C:", "repo"), gitignoreText: "node_modules/\n", tmpDir: path.join("C:", "tmp"), now: stamp });
  assert.equal(outside.insideRepo, false);
  assert.equal(outside.path, path.join("C:", "tmp", "dsh-miaowu-sync", "sync-report-2026-10-21T01-02-03-456Z.json"));

  const inside = reportLocation({ repoRoot: path.join("C:", "repo"), gitignoreText: "node_modules/\n.tmp/\n", tmpDir: path.join("C:", "tmp"), now: stamp });
  assert.equal(inside.insideRepo, true);
  assert.equal(inside.path, path.join("C:", "repo", ".tmp", "sync-report-2026-10-21T01-02-03-456Z.json"));
});

test("assertCleanStatus and parseStatusPaths treat only real entries as changes", () => {
  assert.doesNotThrow(() => assertCleanStatus(""));
  assert.doesNotThrow(() => assertCleanStatus("\n"));
  assert.throws(() => assertCleanStatus("?? packages/knowledge/oh-story/new.md\n"), /dirty/u);
  assert.deepEqual(
    parseStatusPaths(" M packages/knowledge/oh-story/manifest.json\n?? packages/knowledge/drama/skills/a.md\n\n"),
    ["packages/knowledge/oh-story/manifest.json", "packages/knowledge/drama/skills/a.md"]
  );
});

test("buildReport stays JSON-serializable and keeps the required evidence fields", () => {
  const report = buildReport({
    mode: "dry-run",
    baseSha,
    rollbackCommand: rollbackCommandFor(baseSha),
    sets: [{ id: "oh-story", status: "current" }],
    dsh: { declaredRange: dshRange, defaultHost: "0.2.1-rc.2", status: "aligned" },
    steps: [{ name: "base", status: "ok" }],
    startedAt: "2026-10-21T01:02:03.456Z",
    finishedAt: "2026-10-21T01:02:04.000Z",
    latestSource: "fixture"
  });
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
  assert.equal(report.baseSha, baseSha);
  assert.equal(report.startedAt, "2026-10-21T01:02:03.456Z");
  assert.equal(report.finishedAt, "2026-10-21T01:02:04.000Z");
  assert.equal(report.failedStep, undefined);
});

test("--help exits 0, lists every flag and spawns nothing", async () => {
  const { runner, calls } = fakeRunner();
  const output = capture();
  const code = await runSync(parseArgs(["--help"]), {
    runner,
    stdout: output.stdout,
    stderr: output.stderr
  });
  assert.equal(code, 0);
  assert.deepEqual(calls, []);
  for (const flag of ["--dry-run", "--apply", "--latest", "--upstream-root", "--json", "--verify", "--help"]) {
    assert.ok(output.chunks.stdout.includes(flag), `help must list ${flag}`);
  }
  assert.equal(output.chunks.stdout, usage);
});
