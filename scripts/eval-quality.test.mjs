/* global process */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const harness = path.join(scriptDir, "eval-quality.mjs");
const corpusPath = path.join(scriptDir, "eval", "corpus.json");
const corpus = JSON.parse(await readFile(corpusPath, "utf8"));
const filler = "雨落在旧站台上，灯光照亮一张车票。林舟握紧铜钥匙，听见远处传来回声。";

function countChars(text) {
  return Array.from(text.replace(/\s/gu, "")).length;
}

function fillerUntil(minimum) {
  let body = "";
  while (countChars(body) < minimum + 40) body += `${filler}\n`;
  return body;
}

function contentFor(sample, file) {
  const extension = path.extname(file).toLowerCase();
  const headings = sample.requiredHeadings?.[file] ?? [];
  const minimum = sample.minChars?.[file] ?? 0;
  const body = fillerUntil(minimum);
  if (extension === ".mp4") return `clip-marker:${sample.id}:${file}\n`;
  if (extension === ".json") {
    return `${JSON.stringify({ sample: sample.id, file, note: body.trim() }, null, 2)}\n`;
  }
  if (extension === ".html") {
    return `<!doctype html>\n<html><body><pre>${body}</pre></body></html>\n`;
  }
  if (extension === ".js") {
    return `export const artifact = ${JSON.stringify({ sample: sample.id, file, note: body.trim() })};\n`;
  }
  let markdown = `${headings.length > 0 ? `${headings.join("\n")}\n\n` : ""}${body}`;
  if (sample.kind === "novel") {
    markdown +=
      "\n伏笔：铜钥匙的来历。\n伏笔：末班车的时刻。\n伏笔：售票窗后的影子。\n";
  }
  return markdown;
}

async function createFixture(root) {
  for (const sample of corpus.samples) {
    for (const file of sample.requiredFiles) {
      const absolute = path.join(root, sample.id, ...file.split("/"));
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, contentFor(sample, file), "utf8");
    }
  }
}

async function createRoots(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-eval-quality-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const base = path.join(root, "base");
  const candidate = path.join(root, "candidate");
  await Promise.all([createFixture(base), createFixture(candidate)]);
  return { root, base, candidate };
}

async function runCli(args) {
  try {
    const result = await execFileAsync(process.execPath, [harness, ...args], {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

test("clean candidate passes and the report carries aggregate deltas", async (t) => {
  const { root, base, candidate } = await createRoots(t);
  const reportPath = path.join(root, "report.json");
  const markdownPath = path.join(root, "report.md");

  const run = await runCli([
    "--base",
    base,
    "--candidate",
    candidate,
    "--out",
    reportPath,
    "--markdown",
    markdownPath,
  ]);
  assert.equal(run.code, 0, run.stderr);

  const report = await readJson(reportPath);
  assert.equal(report.label, "结构评测，不含模型生成质量");
  assert.equal(report.deterministic, true);
  assert.equal(report.modelRuns, false);
  assert.equal(report.paidModelCalls, 0);
  assert.equal(report.networkCalls, 0);
  assert.equal(report.samples.length, corpus.samples.length);
  assert.equal(report.verdict.exitCode, 0);
  assert.equal(report.verdict.status, "clean");
  assert.deepEqual(report.aggregate.regressionsBySeverity, { P0: 0, P1: 0, P2: 0 });
  assert.equal(report.aggregate.delta.passCount, 0);
  assert.equal(report.aggregate.delta.charCount, 0);
  assert.equal(report.aggregate.delta.missingFileCount, 0);
  assert.equal(report.aggregate.delta.missingHeadingCount, 0);
  assert.equal(report.aggregate.delta.forbiddenHitCount, 0);
  assert.equal(report.badcases.loaded, true);
  assert.equal(report.badcases.schemaVersion, 1);
  assert.equal(report.badcases.total, 0);
  assert.equal(report.badcases.documentedExample, true);

  const markdown = await readFile(markdownPath, "utf8");
  assert.match(markdown, /结构评测，不含模型生成质量/u);
  assert.match(markdown, /未覆盖范围/u);
});

test("a missing required file is a P0 regression and moves aggregate deltas", async (t) => {
  const { root, base, candidate } = await createRoots(t);
  const reportPath = path.join(root, "report.json");
  await rm(path.join(candidate, "novel-rain-station", "正文", "第001章_雨夜.md"));

  const run = await runCli(["--base", base, "--candidate", candidate, "--out", reportPath]);
  assert.equal(run.code, 1, run.stderr);

  const report = await readJson(reportPath);
  const sample = report.samples.find((entry) => entry.id === "novel-rain-station");
  assert.ok(sample.regressions.some((entry) => entry.rubric === "required-files" && entry.severity === "P0"));
  assert.deepEqual(sample.missingFiles.added, ["正文/第001章_雨夜.md"]);
  assert.equal(sample.summary.delta.missingFileCount, 1);
  assert.equal(sample.summary.delta.missingHeadingCount, 1);
  assert.ok(sample.summary.delta.passCount < 0);
  assert.ok(sample.summary.delta.charCount < 0);
  assert.ok(report.aggregate.delta.passCount < 0);
  assert.ok(report.aggregate.delta.charCount < 0);
  assert.ok(report.aggregate.delta.missingFileCount > 0);
  assert.ok(report.aggregate.regressionsBySeverity.P0 >= 1);
  assert.equal(report.verdict.exitCode, 1);
});

test("a forbidden placeholder is a P1 regression", async (t) => {
  const { root, base, candidate } = await createRoots(t);
  const reportPath = path.join(root, "report.json");
  const file = path.join(candidate, "novel-rain-station", "正文", "第001章_雨夜.md");
  const body = await readFile(file, "utf8");
  await writeFile(file, `${body}\nTODO 补写这段。\n`, "utf8");

  const run = await runCli(["--base", base, "--candidate", candidate, "--out", reportPath]);
  assert.equal(run.code, 1, run.stderr);

  const report = await readJson(reportPath);
  const sample = report.samples.find((entry) => entry.id === "novel-rain-station");
  assert.ok(
    sample.regressions.some((entry) => entry.rubric === "forbidden-placeholders" && entry.severity === "P1"),
  );
  assert.equal(sample.forbiddenHits.base, 0);
  assert.equal(sample.forbiddenHits.candidate, 1);
  assert.equal(sample.forbiddenHits.delta, 1);
  assert.ok(report.aggregate.delta.forbiddenHitCount >= 1);
  assert.ok(report.aggregate.regressionsBySeverity.P1 >= 1);
  assert.equal(report.verdict.exitCode, 1);
});

test("a P2-only regression is reported but keeps exit code 0", async (t) => {
  const { root, base, candidate } = await createRoots(t);
  const reportPath = path.join(root, "report.json");
  const file = path.join(candidate, "novel-rain-station", "正文", "第001章_雨夜.md");
  const body = await readFile(file, "utf8");
  await writeFile(file, `${body}\n# 第001章 雨夜\n# 第001章 雨夜\n`, "utf8");

  const run = await runCli(["--base", base, "--candidate", candidate, "--out", reportPath]);
  assert.equal(run.code, 0, run.stderr);

  const report = await readJson(reportPath);
  const sample = report.samples.find((entry) => entry.id === "novel-rain-station");
  assert.ok(
    sample.regressions.some((entry) => entry.rubric === "duplicate-headings" && entry.severity === "P2"),
  );
  assert.equal(report.aggregate.regressionsBySeverity.P2, 1);
  assert.equal(report.verdict.status, "regressed-p2-only");
  assert.equal(report.verdict.exitCode, 0);
});

test("duplicate headings are counted per file, not across the sample", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-eval-dup-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const base = path.join(root, "base");
  const candidate = path.join(root, "candidate");
  for (const side of [base, candidate]) {
    const dir = path.join(side, "dup", "正文");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "一.md"), "# 一\n\n## 概要\n\n正文一。\n", "utf8");
    await writeFile(path.join(dir, "二.md"), "# 二\n\n## 概要\n\n正文二。\n", "utf8");
  }
  const corpusFile = path.join(root, "corpus.json");
  const rubricsFile = path.join(root, "rubrics.json");
  const reportFile = path.join(root, "report.json");
  await writeFile(corpusFile, JSON.stringify({
    schemaVersion: 1,
    samples: [{ id: "dup", kind: "novel", requiredFiles: ["正文/一.md", "正文/二.md"] }],
  }), "utf8");
  await writeFile(rubricsFile, JSON.stringify({
    schemaVersion: 1,
    rubrics: [{
      id: "dup-headings",
      name: "重复标题",
      severity: "P2",
      appliesTo: ["novel"],
      check: { type: "duplicate-headings", maxDuplicates: 0 },
    }],
  }), "utf8");

  const run = await runCli([
    "--base", base,
    "--candidate", candidate,
    "--corpus", corpusFile,
    "--rubrics", rubricsFile,
    "--out", reportFile,
  ]);
  assert.equal(run.code, 0, run.stderr);

  const report = await readJson(reportFile);
  const check = report.samples[0].checks.find((entry) => entry.rubric === "dup-headings");
  assert.equal(check.candidateResult.duplicateCount, 0);
  assert.equal(check.candidateResult.passed, true);
});

test("usage and input errors use exit code 2, including missing sample dirs", async (t) => {
  const { root, base, candidate } = await createRoots(t);

  const usage = await runCli([]);
  assert.equal(usage.code, 2);
  assert.match(usage.stderr, /--base/u);

  const missingCorpus = await runCli([
    "--base",
    base,
    "--candidate",
    candidate,
    "--corpus",
    path.join(root, "absent-corpus.json"),
  ]);
  assert.equal(missingCorpus.code, 2);
  assert.match(missingCorpus.stderr, /corpus/u);

  await rm(path.join(candidate, "novel-rain-station"), { recursive: true, force: true });
  const missingSample = await runCli(["--base", base, "--candidate", candidate]);
  assert.equal(missingSample.code, 2);
  assert.match(missingSample.stderr, /novel-rain-station/u);
});

test("JSON report goes to stdout by default", async (t) => {
  const { base, candidate } = await createRoots(t);
  const run = await runCli(["--base", base, "--candidate", candidate]);
  assert.equal(run.code, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.tool, "dsh-miaowu/eval-quality");
  assert.equal(report.verdict.status, "clean");
  assert.equal(typeof report.aggregate.delta.passCount, "number");
});
