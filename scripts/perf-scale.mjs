#!/usr/bin/env node
/* global Buffer, process */

// Synthetic performance/scale benchmark for the raw filesystem and JSON
// primitives the plugin uses. It is not a release gate and it does not load or
// exercise the packaged plugin UI. See docs/PERFORMANCE.md.

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const SCHEMA_VERSION = 1;
const MARKER_NAME = ".perf-scale.json";
const SUPPORT_ROOTS = ["大纲", "设定", "参考资料"];
const CREATIVE_ROOTS = ["正文", ...SUPPORT_ROOTS];
const TEXT_EXTENSIONS = new Set([".md", ".txt", ".json", ".jsonl"]);
const BASE_TIME = Date.UTC(2026, 0, 1);
const CHAPTER_LINE_CHARS = 50;
const CJK_BANK =
  "夜色沉沉风起云涌山门未闭灯火摇曳少年提剑穿过长街旧梦如潮往事成灰无人知晓江湖路远故人难寻檐下听雨纸上落墨春去秋来花开花谢谁在窗前低语命运翻覆山河寂静一轮明月照见归途";

export const SCALES = {
  full: {
    chapters: 1000,
    chapterCjkChars: 1000,
    supportFiles: { 大纲: 4000, 设定: 3000, 参考资料: 3000 },
    shelfEntries: 100,
    foreshadows: 200,
    runs: 200
  },
  small: {
    chapters: 20,
    chapterCjkChars: 1000,
    supportFiles: { 大纲: 80, 设定: 60, 参考资料: 60 },
    shelfEntries: 10,
    foreshadows: 20,
    runs: 20
  }
};

export const BUDGETS = [
  { id: "walk-support-10k", label: "recursive walk of 10k support files", budgetMs: 2000 },
  { id: "chapters-1000", label: "enumerate 1000 chapter files with stat", budgetMs: 500 },
  { id: "read-hash-1m", label: "read 1M CJK chars and sha256", budgetMs: 500 },
  { id: "backup-collect", label: "backup-like walk+read of the creative tree", budgetMs: 30000 }
];

const CAVEATS = [
  "This benchmark times raw filesystem/JSON primitives; it does not load or exercise the packaged plugin UI.",
  "Timings are one local run with a warm OS cache and are not a release gate or a product SLO.",
  "Budgets are raw-primitive ceilings, not the roadmap UI SLOs (search, tree refresh, backup, bundle).",
  "The synthetic creative corpus is far smaller than 100 MB, so the backup budget is not the 30 s / 100 MB target.",
  "The 400 KB browser bundle budget is enforced by pnpm build, not by this script.",
  "The backup-like collection reads every text file and does not apply the backup service's 2000-file cap."
];

export const usage = `Usage: node scripts/perf-scale.mjs [options]

Generate a synthetic creative workspace and time the raw filesystem and JSON
primitives used by the plugin. This measures primitives, not the packaged plugin
UI, and it is not a release gate.

Options:
  --root <dir>          Reuse or create a workspace directory (default: OS temp dir).
                        An existing non-empty directory without a perf-scale marker
                        is refused. An explicit root is never deleted.
  --keep                Keep the temporary workspace (temp roots only).
  --assert              Exit 1 when a measurement exceeds its raw-primitive budget.
  --json                Print one JSON report to stdout.
  --scale <full|small>  Corpus preset. small (20 chapters / 200 files) is for
                        wiring tests only; the budgets do not scale down.
  --help, -h            Show this help and exit 0.

Measured: recursive walk of 10k support files, 1000-chapter enumeration + stat,
read 1M CJK chars, sha256 of those chars, a combined read+hash pass, JSON
parse+stringify of the 200-run state, and a backup-like walk+read of the
creative tree.

Budgets (raw primitives only): walk 10k files < 2000 ms; enumerate 1000 chapters
< 500 ms; read+hash 1M chars < 500 ms; backup-like collection < 30000 ms.
The 400 KB browser bundle budget is enforced by pnpm build, not here.

Exit codes: 0 pass or no --assert, 1 budget exceeded, 2 usage or setup error.
`;

class PerfScaleError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.name = "PerfScaleError";
    this.exitCode = exitCode;
  }
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

function pad(value, width) {
  return String(value).padStart(width, "0");
}

function roundMs(value) {
  return Math.round(value * 100) / 100;
}

function requireScale(name) {
  if (!Object.hasOwn(SCALES, name)) throw new PerfScaleError(`unknown scale: ${String(name)}`);
  return SCALES[name];
}

function supportTotal(scale) {
  return SUPPORT_ROOTS.reduce((total, root) => total + scale.supportFiles[root], 0);
}

export function expectedCorpus(scale) {
  const lines = Math.ceil(scale.chapterCjkChars / CHAPTER_LINE_CHARS);
  const chapters = scale.chapters;
  const supportFiles = supportTotal(scale);
  return {
    chapters,
    chapterCjkChars: chapters * scale.chapterCjkChars,
    chapterTextChars: chapters * (scale.chapterCjkChars + lines),
    supportFiles,
    creativeFiles: chapters + supportFiles,
    shelfEntries: scale.shelfEntries,
    foreshadows: scale.foreshadows,
    runs: scale.runs
  };
}

export function parseArgs(argv = []) {
  const options = { root: undefined, keep: false, assert: false, json: false, scale: "full", help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new PerfScaleError("--root requires a value");
      options.root = value;
      index += 1;
    } else if (arg === "--scale") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new PerfScaleError("--scale requires a value");
      if (!Object.hasOwn(SCALES, value)) throw new PerfScaleError(`--scale must be full or small, got: ${value}`);
      options.scale = value;
      index += 1;
    } else if (arg === "--keep") {
      options.keep = true;
    } else if (arg === "--assert") {
      options.assert = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new PerfScaleError(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function chapterName(index) {
  return `第${pad(index, 4)}章_草稿.md`;
}

function chapterText(index, cjkChars) {
  const width = CHAPTER_LINE_CHARS;
  const lines = [];
  let cursor = (index * 7) % CJK_BANK.length;
  let remaining = cjkChars;
  while (remaining > 0) {
    const take = Math.min(width, remaining);
    let line = "";
    for (let offset = 0; offset < take; offset += 1) {
      line += CJK_BANK[(cursor + offset) % CJK_BANK.length];
    }
    cursor = (cursor + 13) % CJK_BANK.length;
    lines.push(line);
    remaining -= take;
  }
  return `${lines.join("\n")}\n`;
}

function supportContent(rootName, index, asJson) {
  const id = `${rootName}-${pad(index, 4)}`;
  const title = `合成条目 ${pad(index, 4)}`;
  if (asJson) {
    return `${JSON.stringify({
      id,
      title,
      tags: ["人物", "时间线", "伏笔"],
      note: "性能基准占位文本，用于测试递归遍历与 JSON 文本读取。"
    })}\n`;
  }
  return `# ${title}

- 来源：合成性能基准
- 分类：${rootName}
- 标签：人物 / 时间线 / 伏笔
- 备注：这是性能基准生成的占位文本，用于测试递归遍历与文本读取。
`;
}

function shelfDocument(count) {
  const entries = Array.from({ length: count }, (_, offset) => {
    const index = offset + 1;
    const name = `作品-${pad(index, 4)}`;
    return {
      id: `novel:${name}`,
      name,
      kind: "novel",
      path: `正文/${name}`,
      title: `合成作品 ${pad(index, 4)}`,
      updatedAt: BASE_TIME - offset * 60_000
    };
  });
  return { schemaVersion: SCHEMA_VERSION, entries };
}

function foreshadowDocument(count) {
  const statuses = ["planned", "planted", "resolved", "abandoned"];
  const items = Array.from({ length: count }, (_, offset) => {
    const index = offset + 1;
    const status = statuses[offset % statuses.length];
    const item = {
      id: `foreshadow-${pad(index, 4)}`,
      book: `作品-${pad((offset % 20) + 1, 4)}`,
      chapter: `第${pad((offset % 100) + 1, 4)}章`,
      title: `伏笔 ${pad(index, 4)}：旧信与钥匙`,
      description: "合成伏笔描述，用于制造真实的 JSON 负载。",
      status,
      importance: (offset % 5) + 1,
      source: offset % 3 === 0 ? "import" : "manual",
      evidence: [{ path: `正文/第${pad((offset % 100) + 1, 4)}章_草稿.md`, line: (offset % 40) + 1 }],
      createdAt: BASE_TIME - offset * 60_000,
      updatedAt: BASE_TIME - offset * 30_000
    };
    if (status === "resolved") item.resolutionNote = "已在合成章节回收。";
    if (offset % 4 === 0) item.plannedPayoffChapter = `第${pad((offset % 100) + 50, 4)}章`;
    return item;
  });
  return { schemaVersion: SCHEMA_VERSION, items };
}

function runsDocument(count) {
  const kinds = ["novel-chapter", "drama-batch", "game-content"];
  const statuses = ["completed", "paused", "failed", "running"];
  const stepStatuses = ["done", "done", "done", "pending", "pending"];
  return Array.from({ length: count }, (_, offset) => {
    const index = offset + 1;
    const updatedAt = BASE_TIME - offset * 120_000;
    return {
      id: `run-${pad(index, 4)}`,
      kind: kinds[offset % kinds.length],
      status: statuses[offset % statuses.length],
      meta: {
        book: `作品-${pad((offset % 20) + 1, 4)}`,
        chapter: `第${pad((offset % 100) + 1, 4)}章`,
        note: "合成运行记录"
      },
      steps: ["细纲", "草稿", "自检", "审稿", "采纳"].map((kind, step) => ({
        ordinal: step + 1,
        kind,
        status: stepStatuses[step],
        note: step === 0 ? "合成步骤备注" : undefined,
        updatedAt: updatedAt + step * 1000
      })),
      checkpoint: offset % 5 === 0 ? { at: updatedAt, lastCompletedOrdinal: 3 } : undefined,
      events: [
        { at: updatedAt - 5000, type: "created", detail: { source: "perf-scale" } },
        { at: updatedAt - 3000, type: "step", detail: { ordinal: 1, status: "done" } },
        { at: updatedAt, type: "updated", detail: { note: "合成事件" } }
      ],
      createdAt: updatedAt - 10_000,
      updatedAt,
      resumeCount: offset % 3
    };
  });
}

async function writeInBatches(items, limit, worker) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(workers);
}

export async function generateWorkspace(root, scaleName = "full") {
  const scale = requireScale(scaleName);
  const corpus = expectedCorpus(scale);
  const chapters = Array.from({ length: scale.chapters }, (_, offset) => offset + 1);
  const chapterDir = path.join(root, "正文");
  await mkdir(chapterDir, { recursive: true });
  await writeInBatches(chapters, 16, async (index) => {
    await writeFile(path.join(chapterDir, chapterName(index)), chapterText(index, scale.chapterCjkChars), "utf8");
  });

  for (const rootName of SUPPORT_ROOTS) {
    const count = scale.supportFiles[rootName];
    const batchDirs = Math.ceil(count / 100);
    await Promise.all(
      Array.from({ length: batchDirs }, (_, offset) =>
        mkdir(path.join(root, rootName, `批-${pad(offset + 1, 2)}`), { recursive: true })
      )
    );
    await writeInBatches(Array.from({ length: count }, (_, offset) => offset + 1), 16, async (index) => {
      const asJson = index % 5 === 4;
      const subdir = `批-${pad(Math.floor((index - 1) / 100) + 1, 2)}`;
      const name = `${rootName}-${pad(index, 4)}.${asJson ? "json" : "md"}`;
      await writeFile(path.join(root, rootName, subdir, name), supportContent(rootName, index, asJson), "utf8");
    });
  }

  const stateDir = path.join(root, ".oh-story");
  const tasksDir = path.join(stateDir, "tasks");
  await mkdir(tasksDir, { recursive: true });
  const shelfText = `${JSON.stringify(shelfDocument(scale.shelfEntries), null, 2)}\n`;
  const foreshadowText = `${JSON.stringify(foreshadowDocument(scale.foreshadows), null, 2)}\n`;
  const runsText = JSON.stringify(runsDocument(scale.runs));
  await writeFile(path.join(stateDir, "shelf.json"), shelfText, "utf8");
  await writeFile(path.join(stateDir, "foreshadows.json"), foreshadowText, "utf8");
  await writeFile(path.join(tasksDir, "runs.json"), runsText, "utf8");
  const stateBytes =
    Buffer.byteLength(shelfText, "utf8") + Buffer.byteLength(foreshadowText, "utf8") + Buffer.byteLength(runsText, "utf8");

  const marker = {
    schemaVersion: SCHEMA_VERSION,
    tool: "perf-scale",
    scale: scaleName,
    generatedAt: new Date().toISOString(),
    corpus: { ...corpus, stateBytes }
  };
  await writeFile(path.join(root, MARKER_NAME), `${JSON.stringify(marker, null, 2)}\n`, "utf8");
  return { ...corpus, stateBytes };
}

async function prepareWorkspace(root, scaleName) {
  let info;
  try {
    info = await stat(root);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (info !== undefined && !info.isDirectory()) throw new PerfScaleError(`--root is not a directory: ${root}`);
  if (info === undefined) await mkdir(root, { recursive: true });

  const expected = expectedCorpus(requireScale(scaleName));
  const markerPath = path.join(root, MARKER_NAME);
  let markerText;
  try {
    markerText = await readFile(markerPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (markerText !== undefined) {
    let marker;
    try {
      marker = JSON.parse(markerText);
    } catch {
      throw new PerfScaleError(`perf-scale marker is not valid JSON: ${markerPath}`);
    }
    if (marker.schemaVersion !== SCHEMA_VERSION || marker.tool !== "perf-scale" || marker.scale !== scaleName) {
      throw new PerfScaleError(`perf-scale marker does not match scale ${scaleName}: ${markerPath}`);
    }
    for (const key of Object.keys(expected)) {
      if (marker.corpus?.[key] !== expected[key]) {
        throw new PerfScaleError(`perf-scale marker has a stale ${key} count: ${markerPath}`);
      }
    }
    return { corpus: marker.corpus, reused: true };
  }

  const entries = await readdir(root);
  if (entries.length > 0) {
    throw new PerfScaleError(`--root is not empty and has no ${MARKER_NAME}; refusing to mix a synthetic corpus with existing files: ${root}`);
  }
  return { corpus: await generateWorkspace(root, scaleName), reused: false };
}

async function countFilesRecursive(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    if (entry.isDirectory()) count += await countFilesRecursive(path.join(directory, entry.name));
    else if (entry.isFile()) count += 1;
  }
  return count;
}

function countCjk(text) {
  return (text.match(/[\u4e00-\u9fff]/gu) ?? []).length;
}

async function time(run) {
  const started = performance.now();
  const value = await run();
  return { ms: roundMs(performance.now() - started), value };
}

function measurement(id, label, timing, details) {
  return { id, label, iterations: 1, ms: timing.ms, details };
}

async function collectTextFiles(root, relativeDir, out) {
  const directory = path.join(root, relativeDir);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const relativePath = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) {
      await collectTextFiles(root, relativePath, out);
    } else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      out.push({ relativePath, absolutePath: path.join(root, relativePath) });
    }
  }
}

export async function measureWorkspace(root, corpus) {
  const measurements = [];

  const walk = await time(async () => {
    let files = 0;
    for (const rootName of SUPPORT_ROOTS) files += await countFilesRecursive(path.join(root, rootName));
    return files;
  });
  if (walk.value !== corpus.supportFiles) {
    throw new PerfScaleError(`corpus incomplete: walked ${walk.value} support files, expected ${corpus.supportFiles}`);
  }
  measurements.push(measurement("walk-support-10k", "recursive walk of support files", walk, { files: walk.value }));

  const chapterDir = path.join(root, "正文");
  const chapterEnumeration = await time(async () => {
    const entries = await readdir(chapterDir, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && /^第\d{4}章_.*\.md$/u.test(entry.name))
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    let bytes = 0;
    const paths = [];
    for (const entry of files) {
      const filePath = path.join(chapterDir, entry.name);
      bytes += (await stat(filePath)).size;
      paths.push(filePath);
    }
    return { chapters: files.length, bytes, paths };
  });
  if (chapterEnumeration.value.chapters !== corpus.chapters) {
    throw new PerfScaleError(
      `corpus incomplete: enumerates ${chapterEnumeration.value.chapters} chapters, expected ${corpus.chapters}`
    );
  }
  const chapterPaths = chapterEnumeration.value.paths;
  measurements.push(
    measurement("chapters-1000", "enumerate chapter files with stat", chapterEnumeration, {
      chapters: chapterEnumeration.value.chapters,
      bytes: chapterEnumeration.value.bytes
    })
  );

  const read = await time(async () => {
    const chunks = [];
    let bytes = 0;
    for (const filePath of chapterPaths) {
      const text = await readFile(filePath, "utf8");
      chunks.push(text);
      bytes += Buffer.byteLength(text, "utf8");
    }
    return { text: chunks.join(""), bytes };
  });
  const readText = read.value.text;
  const readCjk = countCjk(readText);
  if (readText.length !== corpus.chapterTextChars || readCjk !== corpus.chapterCjkChars) {
    throw new PerfScaleError(
      `corpus incomplete: read ${readText.length} chars (${readCjk} CJK), expected ${corpus.chapterTextChars} (${corpus.chapterCjkChars} CJK)`
    );
  }
  measurements.push(
    measurement("read-chapters-1m", "read 1M CJK chars from chapters", read, {
      chars: readText.length,
      cjkChars: readCjk,
      bytes: read.value.bytes
    })
  );

  const hash = await time(async () => createHash("sha256").update(readText, "utf8").digest("hex"));
  measurements.push(
    measurement("hash-1m", "sha256 of the 1M CJK chars", hash, {
      sha256: hash.value,
      bytes: read.value.bytes
    })
  );

  const readHash = await time(async () => {
    const digest = createHash("sha256");
    let chars = 0;
    for (const filePath of chapterPaths) {
      const text = await readFile(filePath, "utf8");
      chars += text.length;
      digest.update(text, "utf8");
    }
    return { sha256: digest.digest("hex"), chars };
  });
  if (readHash.value.chars !== corpus.chapterTextChars || readHash.value.sha256 !== hash.value) {
    throw new PerfScaleError("corpus read+hash pass did not reproduce the standalone read+hash result");
  }
  measurements.push(
    measurement("read-hash-1m", "read+sha256 1M CJK chars", readHash, {
      chars: readHash.value.chars,
      sha256: readHash.value.sha256
    })
  );

  const runsPath = path.join(root, ".oh-story", "tasks", "runs.json");
  const runsSource = await readFile(runsPath, "utf8");
  const json = await time(async () => {
    const parsed = JSON.parse(runsSource);
    const serialized = JSON.stringify(parsed);
    return {
      runs: parsed.length,
      sourceBytes: Buffer.byteLength(runsSource, "utf8"),
      serializedBytes: Buffer.byteLength(serialized, "utf8")
    };
  });
  if (json.value.runs !== corpus.runs) {
    throw new PerfScaleError(`corpus incomplete: parsed ${json.value.runs} runs, expected ${corpus.runs}`);
  }
  measurements.push(measurement("json-200-runs", "JSON parse+stringify of the run state", json, json.value));

  const backup = await time(async () => {
    const files = [];
    for (const rootName of CREATIVE_ROOTS) await collectTextFiles(root, rootName, files);
    files.sort((left, right) => (left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0));
    let bytes = 0;
    for (const file of files) {
      bytes += Buffer.byteLength(await readFile(file.absolutePath, "utf8"), "utf8");
    }
    return { files: files.length, bytes };
  });
  if (backup.value.files !== corpus.creativeFiles) {
    throw new PerfScaleError(
      `corpus incomplete: collected ${backup.value.files} creative files, expected ${corpus.creativeFiles}`
    );
  }
  measurements.push(measurement("backup-collect", "backup-like walk+read of the creative tree", backup, backup.value));

  return measurements;
}

export function evaluateBudgets(measurements) {
  const byId = new Map(measurements.map((item) => [item.id, item]));
  return BUDGETS.map((budget) => {
    const measured = byId.get(budget.id);
    if (measured === undefined) throw new PerfScaleError(`missing measurement for budget ${budget.id}`);
    return {
      id: budget.id,
      label: budget.label,
      budgetMs: budget.budgetMs,
      measuredMs: measured.ms,
      ok: measured.ms <= budget.budgetMs,
      overByMs: roundMs(Math.max(0, measured.ms - budget.budgetMs))
    };
  });
}

function runtimeInfo() {
  const cpus = os.cpus();
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu: cpus[0]?.model ?? "unknown",
    cpuCount: cpus.length
  };
}

export async function runPerfScale(options) {
  requireScale(options.scale);
  const temporary = options.root === undefined;
  const root = temporary ? await mkdtemp(path.join(os.tmpdir(), "dsh-perf-scale-")) : path.resolve(options.root);
  let prepared;
  let measurements;
  let budgetRows;
  try {
    prepared = await prepareWorkspace(root, options.scale);
    measurements = await measureWorkspace(root, prepared.corpus);
    budgetRows = evaluateBudgets(measurements);
  } catch (error) {
    if (temporary && !options.keep) {
      await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
    }
    throw error instanceof PerfScaleError ? error : new PerfScaleError(message(error));
  }

  for (const row of budgetRows) {
    const target = measurements.find((item) => item.id === row.id);
    target.budgetMs = row.budgetMs;
    target.withinBudget = row.ok;
  }
  const failures = budgetRows.filter((row) => !row.ok);
  const cleanup = { temporary, kept: false, removed: false };
  if (temporary) {
    if (options.keep) {
      cleanup.kept = true;
    } else {
      try {
        await rm(root, { recursive: true, force: true, maxRetries: 3 });
        cleanup.removed = true;
      } catch (error) {
        cleanup.error = message(error);
      }
    }
  } else {
    cleanup.kept = true;
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    tool: "perf-scale",
    generatedAt: new Date().toISOString(),
    runtime: runtimeInfo(),
    scale: options.scale,
    root,
    reused: prepared.reused,
    corpus: prepared.corpus,
    measurements,
    budgets: budgetRows,
    assert: {
      enabled: options.assert,
      ok: failures.length === 0,
      failures: failures.map((row) => ({
        id: row.id,
        measuredMs: row.measuredMs,
        budgetMs: row.budgetMs,
        overByMs: row.overByMs
      }))
    },
    cleanup,
    caveats: CAVEATS
  };
}

function formatDetail(details) {
  return Object.entries(details)
    .map(([key, value]) => {
      const text = typeof value === "string" && value.length > 16 ? `${value.slice(0, 12)}...` : String(value);
      return `${key}=${text}`;
    })
    .join(" ");
}

export function formatHuman(report) {
  const corpus = report.corpus;
  const lines = [
    `perf-scale: ${report.root}`,
    `scale=${report.scale} reused=${report.reused} runtime=node ${report.runtime.node} ${report.runtime.platform}-${report.runtime.arch}`,
    `corpus: ${corpus.chapters} chapters (${corpus.chapterCjkChars} CJK chars), ${corpus.supportFiles} support files, shelf=${corpus.shelfEntries}, foreshadows=${corpus.foreshadows}, runs=${corpus.runs}`,
    ""
  ];
  for (const item of report.measurements) {
    const budget = item.budgetMs === undefined ? "" : ` budget=${item.budgetMs}ms ${item.withinBudget ? "ok" : "OVER"}`;
    lines.push(`  ${item.id.padEnd(20)} ${item.ms.toFixed(1).padStart(9)} ms${budget}  ${formatDetail(item.details)}`);
  }
  lines.push("");
  if (report.assert.enabled) {
    lines.push(report.assert.ok ? "assert: all raw budgets within limits" : `assert: ${report.assert.failures.length} budget(s) exceeded`);
    for (const failure of report.assert.failures) {
      lines.push(`  - ${failure.id}: ${failure.measuredMs} ms > ${failure.budgetMs} ms`);
    }
  } else {
    lines.push("assert: off (budgets are informational; use --assert to gate)");
  }
  if (report.cleanup.temporary) {
    if (report.cleanup.removed) lines.push("cleanup: temporary workspace removed");
    else if (report.cleanup.kept) lines.push(`cleanup: temporary workspace kept at ${report.root}`);
    else lines.push(`cleanup: temporary workspace not removed${report.cleanup.error ? ` (${report.cleanup.error})` : ""}`);
  } else {
    lines.push("cleanup: explicit --root kept");
  }
  const failed = (report.assert.enabled && !report.assert.ok) || report.cleanup.error !== undefined;
  lines.push(failed ? "perf-scale: FAIL" : "perf-scale: PASS");
  lines.push("scope: raw filesystem/JSON primitives only; not the packaged plugin UI.");
  return `${lines.join("\n")}\n`;
}

export async function main(argv = []) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`perf-scale: ${message(error)}\nRun with --help for usage.\n`);
    return error instanceof PerfScaleError ? error.exitCode : 2;
  }
  if (options.help) {
    process.stdout.write(usage);
    return 0;
  }
  try {
    const report = await runPerfScale(options);
    process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatHuman(report));
    if (report.cleanup.error !== undefined) {
      process.stderr.write(`perf-scale: temporary workspace cleanup failed: ${report.cleanup.error}\n`);
      return 2;
    }
    return report.assert.enabled && !report.assert.ok ? 1 : 0;
  } catch (error) {
    process.stderr.write(`perf-scale: ${message(error)}\n`);
    return error instanceof PerfScaleError ? error.exitCode : 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
