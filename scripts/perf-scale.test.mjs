/* global process, URL */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { BUDGETS, evaluateBudgets, generateWorkspace, parseArgs } from "./perf-scale.mjs";

const scriptPath = fileURLToPath(new URL("./perf-scale.mjs", import.meta.url));

function countCjk(text) {
  return (text.match(/[\u4e00-\u9fff]/gu) ?? []).length;
}

async function countFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    if (entry.isDirectory()) count += await countFiles(path.join(directory, entry.name));
    else if (entry.isFile()) count += 1;
  }
  return count;
}

function runCli(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
    timeout: 120000
  });
}

test("parseArgs defaults to a full run and validates documented flags", () => {
  const defaults = parseArgs([]);
  assert.equal(defaults.scale, "full");
  assert.equal(defaults.root, undefined);
  assert.equal(defaults.keep, false);
  assert.equal(defaults.assert, false);
  assert.equal(defaults.json, false);
  assert.equal(defaults.help, false);

  const parsed = parseArgs(["--root", "workspace", "--keep", "--assert", "--json", "--scale", "small"]);
  assert.equal(parsed.root, "workspace");
  assert.equal(parsed.keep, true);
  assert.equal(parsed.assert, true);
  assert.equal(parsed.json, true);
  assert.equal(parsed.scale, "small");

  assert.equal(parseArgs(["--help"]).help, true);
  assert.throws(() => parseArgs(["--root"]), /requires a value/u);
  assert.throws(() => parseArgs(["--scale"]), /requires a value/u);
  assert.throws(() => parseArgs(["--scale", "huge"]), /full or small/u);
  assert.throws(() => parseArgs(["--bogus"]), /unknown argument/u);
});

test("generateWorkspace writes the small corpus with exact counts and characters", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-perf-scale-gen-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const corpus = await generateWorkspace(root, "small");
  assert.equal(corpus.chapters, 20);
  assert.equal(corpus.chapterCjkChars, 20000);
  assert.equal(corpus.chapterTextChars, 20400);
  assert.equal(corpus.supportFiles, 200);
  assert.equal(corpus.creativeFiles, 220);
  assert.equal(corpus.shelfEntries, 10);
  assert.equal(corpus.foreshadows, 20);
  assert.equal(corpus.runs, 20);
  assert.ok(corpus.stateBytes > 0);

  const chapters = (await readdir(path.join(root, "正文"))).filter((name) => name.endsWith(".md")).sort();
  assert.equal(chapters.length, 20);
  assert.equal(chapters[0], "第0001章_草稿.md");
  assert.equal(chapters[19], "第0020章_草稿.md");
  for (const name of [chapters[0], chapters.at(-1)]) {
    const text = await readFile(path.join(root, "正文", name), "utf8");
    assert.equal(text.length, 1020);
    assert.equal(countCjk(text), 1000);
  }

  for (const [directory, expected] of [["大纲", 80], ["设定", 60], ["参考资料", 60]]) {
    assert.equal(await countFiles(path.join(root, directory)), expected);
  }

  const shelf = JSON.parse(await readFile(path.join(root, ".oh-story", "shelf.json"), "utf8"));
  assert.equal(shelf.schemaVersion, 1);
  assert.equal(shelf.entries.length, 10);
  const foreshadows = JSON.parse(await readFile(path.join(root, ".oh-story", "foreshadows.json"), "utf8"));
  assert.equal(foreshadows.schemaVersion, 1);
  assert.equal(foreshadows.items.length, 20);
  const runs = JSON.parse(await readFile(path.join(root, ".oh-story", "tasks", "runs.json"), "utf8"));
  assert.ok(Array.isArray(runs));
  assert.equal(runs.length, 20);
  const marker = JSON.parse(await readFile(path.join(root, ".perf-scale.json"), "utf8"));
  assert.equal(marker.scale, "small");
});

test("--scale small --assert emits a shaped report and reuses an explicit --root", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "dsh-perf-scale-cli-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "workspace");

  const first = runCli(["--root", root, "--scale", "small", "--assert", "--json"]);
  assert.equal(first.status, 0, first.stderr);
  const report = JSON.parse(first.stdout);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.tool, "perf-scale");
  assert.equal(report.scale, "small");
  assert.equal(report.root, root);
  assert.equal(report.reused, false);
  assert.equal(report.corpus.chapters, 20);
  assert.equal(report.corpus.supportFiles, 200);

  const ids = report.measurements.map((item) => item.id);
  for (const id of [
    "walk-support-10k",
    "chapters-1000",
    "read-chapters-1m",
    "hash-1m",
    "read-hash-1m",
    "json-200-runs",
    "backup-collect"
  ]) {
    assert.ok(ids.includes(id), `missing measurement ${id}`);
  }
  for (const item of report.measurements) {
    assert.equal(item.iterations, 1);
    assert.equal(typeof item.ms, "number");
    assert.ok(Number.isFinite(item.ms) && item.ms >= 0);
  }
  assert.equal(report.budgets.length, BUDGETS.length);
  assert.equal(report.assert.enabled, true);
  assert.equal(report.assert.ok, true);
  assert.deepEqual(report.assert.failures, []);
  assert.equal(report.cleanup.temporary, false);
  assert.equal(report.cleanup.kept, true);
  assert.ok(report.caveats.some((line) => line.includes("packaged plugin UI")));

  const second = runCli(["--root", root, "--scale", "small", "--assert", "--json"]);
  assert.equal(second.status, 0, second.stderr);
  const reused = JSON.parse(second.stdout);
  assert.equal(reused.reused, true);
  assert.equal(reused.root, root);
});

test("evaluateBudgets reports an over-budget measurement as a failure", () => {
  const rows = evaluateBudgets(BUDGETS.map((budget) => ({
    id: budget.id,
    ms: budget.budgetMs + (budget.id === "read-hash-1m" ? 1 : 0)
  })));
  const failed = rows.filter((row) => !row.ok);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].id, "read-hash-1m");
  assert.equal(failed[0].overByMs, 1);
});

test("explicit --root refuses a non-empty directory without the marker", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-perf-scale-unsafe-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sentinel = path.join(root, "user-data.txt");
  await writeFile(sentinel, "do not touch\n", "utf8");

  const run = runCli(["--root", root, "--scale", "small"]);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /non-empty|marker|refus/iu);
  assert.equal(await readFile(sentinel, "utf8"), "do not touch\n");
});

test("temporary workspaces are removed unless --keep is passed", async (t) => {
  const removed = runCli(["--scale", "small", "--json"]);
  assert.equal(removed.status, 0, removed.stderr);
  const removedReport = JSON.parse(removed.stdout);
  assert.equal(removedReport.cleanup.temporary, true);
  assert.equal(removedReport.cleanup.removed, true);
  assert.equal(removedReport.cleanup.kept, false);
  assert.equal(existsSync(removedReport.root), false);

  const kept = runCli(["--scale", "small", "--json", "--keep"]);
  assert.equal(kept.status, 0, kept.stderr);
  const keptReport = JSON.parse(kept.stdout);
  t.after(() => rm(keptReport.root, { recursive: true, force: true }));
  assert.equal(keptReport.cleanup.temporary, true);
  assert.equal(keptReport.cleanup.removed, false);
  assert.equal(keptReport.cleanup.kept, true);
  assert.equal(existsSync(keptReport.root), true);
  assert.equal(existsSync(path.join(keptReport.root, "正文")), true);
});
