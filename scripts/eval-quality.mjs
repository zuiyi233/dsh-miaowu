#!/usr/bin/env node
/* global process */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const modulePath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(modulePath);

export const REPORT_LABEL = "结构评测，不含模型生成质量";
export const REPORT_DISCLAIMER =
  "本报告只做确定性的文件结构与文本统计比较，未调用任何模型或网络，不评价模型生成质量。";
export const DEFAULT_PATHS = {
  corpus: path.join(scriptDir, "eval", "corpus.json"),
  rubrics: path.join(scriptDir, "eval", "rubrics.json"),
  badcases: path.join(scriptDir, "eval", "badcases.json"),
};

const KINDS = new Set(["novel", "drama", "game", "video-recap"]);
const SEVERITIES = new Set(["P0", "P1", "P2"]);
const CHECK_TYPES = new Set([
  "files-present",
  "min-chars",
  "required-headings",
  "forbidden-patterns",
  "duplicate-headings",
  "marker-count",
]);
const TEXT_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".json",
  ".jsonl",
  ".html",
  ".htm",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".ts",
  ".tsx",
  ".css",
  ".yaml",
  ".yml",
  ".csv",
  ".xml",
  ".svg",
  ".srt",
  ".ass",
  ".vtt",
]);

const USAGE = `用法：
  node scripts/eval-quality.mjs --base <dir> --candidate <dir> [options]

必填：
  --base <dir>        基线产物根目录（旧版本 / 上游）
  --candidate <dir>   候选产物根目录

选填：
  --corpus <path>     语料清单（默认 scripts/eval/corpus.json）
  --rubrics <path>    评分规则（默认 scripts/eval/rubrics.json）
  --badcases <path>   badcase 清单（默认 scripts/eval/badcases.json）
  --no-badcases       不加载 badcase 清单
  --out <path>        JSON 报告路径，- 表示 stdout（默认 -）
  --markdown <path>   Markdown 摘要路径，- 表示 stdout；不传则不生成
  --help              显示本帮助

退出码：
  0  没有候选侧 P0/P1 回归
  1  候选侧出现 P0/P1 回归
  2  用法或输入错误

报告只做结构评测，不含模型生成质量。`;

export class UsageError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "UsageError";
    this.code = code;
  }
}

function invariant(condition, message) {
  if (!condition) throw new UsageError(message);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNonEmptyString(value, label) {
  invariant(typeof value === "string" && value.trim() !== "", `${label} 必须是非空字符串`);
  return value.trim();
}

function normalizeRelativePath(value, label) {
  assertNonEmptyString(value, label);
  const normalized = value.trim().replace(/\\/gu, "/");
  invariant(
    !normalized.startsWith("/") && !/^[A-Za-z]:/u.test(normalized),
    `${label} 必须是相对路径: ${value}`,
  );
  invariant(!normalized.includes("\u0000"), `${label} 不能包含空字符`);
  const parts = normalized.split("/");
  invariant(
    parts.every((part) => part !== "" && part !== "." && part !== ".."),
    `${label} 不能包含空段、. 或 ..: ${value}`,
  );
  return parts.join("/");
}

function normalizeSampleId(value, label) {
  assertNonEmptyString(value, label);
  invariant(value === value.trim(), `${label} 不能有首尾空格: "${value}"`);
  invariant(value !== "." && value !== "..", `${label} 不能是 . 或 ..`);
  invariant(
    !/[\\/:*?"<>|]/u.test(value) &&
      ![...value].some((character) => (character.codePointAt(0) ?? 0) < 32) &&
      !/[. ]$/u.test(value),
    `${label} 不是可移植的目录名: ${value}`,
  );
  return value;
}

function normalizePathList(value, label) {
  invariant(Array.isArray(value) && value.length > 0, `${label} 必须是非空数组`);
  const files = value.map((entry, index) => normalizeRelativePath(entry, `${label}[${index}]`));
  invariant(new Set(files).size === files.length, `${label} 不能有重复路径`);
  return files;
}

function normalizePatterns(value, label) {
  invariant(Array.isArray(value) && value.length > 0, `${label} 必须是非空字符串数组`);
  const patterns = value.map((entry, index) => assertNonEmptyString(entry, `${label}[${index}]`));
  return [...new Set(patterns)];
}

function normalizeMinChars(value, requiredFiles, label) {
  if (value === undefined) return undefined;
  if (typeof value === "number") {
    invariant(Number.isInteger(value) && value >= 0, `${label} 必须是非负整数`);
    return Object.fromEntries(requiredFiles.map((file) => [file, value]));
  }
  invariant(isPlainObject(value), `${label} 必须是数字或 { 文件: 最小字符数 } 对象`);
  const required = new Set(requiredFiles);
  const result = {};
  for (const [rawFile, rawMin] of Object.entries(value)) {
    const file = normalizeRelativePath(rawFile, `${label} 的键`);
    invariant(required.has(file), `${label} 引用了 requiredFiles 中不存在的文件: ${file}`);
    invariant(!Object.hasOwn(result, file), `${label} 有重复文件键: ${file}`);
    invariant(Number.isInteger(rawMin) && rawMin >= 0, `${label}.${file} 必须是非负整数`);
    result[file] = rawMin;
  }
  return result;
}

function normalizeRequiredHeadings(value, requiredFiles, label) {
  if (value === undefined) return undefined;
  invariant(isPlainObject(value), `${label} 必须是 { 文件: [标题] } 对象`);
  const required = new Set(requiredFiles);
  const result = {};
  for (const [rawFile, headings] of Object.entries(value)) {
    const file = normalizeRelativePath(rawFile, `${label} 的键`);
    invariant(required.has(file), `${label} 引用了 requiredFiles 中不存在的文件: ${file}`);
    invariant(!Object.hasOwn(result, file), `${label} 有重复文件键: ${file}`);
    invariant(Array.isArray(headings) && headings.length > 0, `${label}.${file} 必须是非空标题数组`);
    result[file] = headings.map((heading, index) =>
      assertNonEmptyString(heading, `${label}.${file}[${index}]`),
    );
  }
  return result;
}

async function readJson(file, label) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new UsageError(`${label} 文件不存在: ${path.resolve(file)}`, "ENOENT");
    }
    throw new UsageError(`无法读取 ${label}: ${path.resolve(file)} (${error.code ?? error.message})`);
  }
  try {
    return JSON.parse(text.replace(/^\uFEFF/u, ""));
  } catch (error) {
    throw new UsageError(`${label} 不是合法 JSON: ${path.resolve(file)} (${error.message})`);
  }
}

async function requireDirectory(directory, label) {
  let info;
  try {
    info = await stat(directory);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      throw new UsageError(`${label} 目录不存在: ${path.resolve(directory)}`, "ENOENT");
    }
    throw new UsageError(`无法读取 ${label} 目录: ${path.resolve(directory)} (${error.code ?? error.message})`);
  }
  invariant(info.isDirectory(), `${label} 不是目录: ${path.resolve(directory)}`);
}

function normalizeSample(raw, index) {
  const label = `corpus.samples[${index}]`;
  invariant(isPlainObject(raw), `${label} 必须是对象`);
  const id = normalizeSampleId(raw.id, `${label}.id`);
  const kind = assertNonEmptyString(raw.kind, `${label}.kind`);
  invariant(KINDS.has(kind), `${label}.kind 必须是 ${[...KINDS].join(" / ")} 之一`);
  const requiredFiles = normalizePathList(raw.requiredFiles, `${label}.requiredFiles`);
  const minChars = normalizeMinChars(raw.minChars, requiredFiles, `${label}.minChars`);
  const requiredHeadings = normalizeRequiredHeadings(
    raw.requiredHeadings,
    requiredFiles,
    `${label}.requiredHeadings`,
  );
  const forbiddenPatterns =
    raw.forbiddenPatterns === undefined
      ? undefined
      : normalizePatterns(raw.forbiddenPatterns, `${label}.forbiddenPatterns`);
  return { id, kind, requiredFiles, minChars, requiredHeadings, forbiddenPatterns };
}

export async function loadCorpus(file) {
  const raw = await readJson(file, "corpus");
  const document = Array.isArray(raw) ? { schemaVersion: 1, samples: raw } : raw;
  invariant(isPlainObject(document), "corpus 必须是对象或样本数组");
  if (document.schemaVersion !== undefined) {
    invariant(document.schemaVersion === 1, `corpus.schemaVersion 必须是 1，收到 ${document.schemaVersion}`);
  }
  invariant(Array.isArray(document.samples) && document.samples.length > 0, "corpus.samples 必须是非空数组");
  const samples = document.samples.map((sample, index) => normalizeSample(sample, index));
  invariant(new Set(samples.map((sample) => sample.id)).size === samples.length, "corpus 样本 id 不能重复");
  return {
    schemaVersion: 1,
    description: typeof document.description === "string" ? document.description : "",
    samples,
  };
}

function normalizeCheck(raw, label) {
  invariant(isPlainObject(raw), `${label} 必须是对象`);
  const type = assertNonEmptyString(raw.type, `${label}.type`);
  invariant(CHECK_TYPES.has(type), `${label}.type 不受支持: ${type}`);
  const check = { type };

  if (type === "files-present") {
    if (raw.source !== undefined) {
      invariant(raw.source === "sample.requiredFiles", `${label}.source 只支持 sample.requiredFiles`);
      invariant(raw.files === undefined, `${label} 不能同时配置 source 和 files`);
      check.source = raw.source;
    } else {
      check.files = normalizePathList(raw.files, `${label}.files`);
    }
    if (raw.nonEmpty !== undefined) {
      invariant(typeof raw.nonEmpty === "boolean", `${label}.nonEmpty 必须是布尔值`);
      check.nonEmpty = raw.nonEmpty;
    }
  } else if (type === "min-chars") {
    if (raw.source !== undefined) invariant(raw.source === "sample.minChars", `${label}.source 只支持 sample.minChars`);
    check.source = "sample.minChars";
  } else if (type === "required-headings") {
    if (raw.source !== undefined) {
      invariant(raw.source === "sample.requiredHeadings", `${label}.source 只支持 sample.requiredHeadings`);
    }
    check.source = "sample.requiredHeadings";
  } else if (type === "forbidden-patterns") {
    check.patterns = raw.patterns === undefined ? [] : normalizePatterns(raw.patterns, `${label}.patterns`);
    if (raw.includeSamplePatterns !== undefined) {
      invariant(typeof raw.includeSamplePatterns === "boolean", `${label}.includeSamplePatterns 必须是布尔值`);
      check.includeSamplePatterns = raw.includeSamplePatterns;
    } else {
      check.includeSamplePatterns = true;
    }
    invariant(
      check.patterns.length > 0 || check.includeSamplePatterns,
      `${label} 至少要有一个模式来源`,
    );
  } else if (type === "duplicate-headings") {
    check.maxDuplicates = raw.maxDuplicates === undefined ? 1 : raw.maxDuplicates;
    invariant(
      Number.isInteger(check.maxDuplicates) && check.maxDuplicates >= 0,
      `${label}.maxDuplicates 必须是非负整数`,
    );
    if (raw.files !== undefined) check.files = normalizePathList(raw.files, `${label}.files`);
  } else {
    check.pattern = assertNonEmptyString(raw.pattern, `${label}.pattern`);
    check.minCount = raw.minCount === undefined ? 1 : raw.minCount;
    invariant(Number.isInteger(check.minCount) && check.minCount >= 0, `${label}.minCount 必须是非负整数`);
    if (raw.files !== undefined) check.files = normalizePathList(raw.files, `${label}.files`);
  }
  return check;
}

function normalizeRubric(raw, index) {
  const label = `rubrics[${index}]`;
  invariant(isPlainObject(raw), `${label} 必须是对象`);
  const id = assertNonEmptyString(raw.id, `${label}.id`);
  const name = assertNonEmptyString(raw.name, `${label}.name`);
  const severity = assertNonEmptyString(raw.severity, `${label}.severity`);
  invariant(SEVERITIES.has(severity), `${label}.severity 必须是 P0 / P1 / P2`);
  invariant(Array.isArray(raw.appliesTo) && raw.appliesTo.length > 0, `${label}.appliesTo 必须是非空数组`);
  const appliesTo = [...new Set(raw.appliesTo.map((kind, kindIndex) => {
    const value = assertNonEmptyString(kind, `${label}.appliesTo[${kindIndex}]`);
    invariant(KINDS.has(value), `${label}.appliesTo 包含未知 kind: ${value}`);
    return value;
  }))];
  return {
    id,
    name,
    severity,
    appliesTo,
    check: normalizeCheck(raw.check, `${label}.check`),
  };
}

export async function loadRubrics(file) {
  const raw = await readJson(file, "rubrics");
  const document = Array.isArray(raw) ? { schemaVersion: 1, rubrics: raw } : raw;
  invariant(isPlainObject(document), "rubrics 必须是对象或规则数组");
  if (document.schemaVersion !== undefined) {
    invariant(document.schemaVersion === 1, `rubrics.schemaVersion 必须是 1，收到 ${document.schemaVersion}`);
  }
  invariant(Array.isArray(document.rubrics) && document.rubrics.length > 0, "rubrics.rubrics 必须是非空数组");
  const rubrics = document.rubrics.map((rubric, index) => normalizeRubric(rubric, index));
  invariant(new Set(rubrics.map((rubric) => rubric.id)).size === rubrics.length, "rubrics id 不能重复");
  return {
    schemaVersion: 1,
    description: typeof document.description === "string" ? document.description : "",
    rubrics,
  };
}

function normalizeStringList(value, label) {
  if (typeof value === "string") return [assertNonEmptyString(value, label)];
  invariant(Array.isArray(value) && value.length > 0, `${label} 必须是非空字符串或非空字符串数组`);
  return value.map((entry, index) => assertNonEmptyString(entry, `${label}[${index}]`));
}

function normalizeBadcase(raw, label, ids) {
  invariant(isPlainObject(raw), `${label} 必须是对象`);
  const id = assertNonEmptyString(raw.id, `${label}.id`);
  invariant(!ids.has(id), `${label}.id 重复: ${id}`);
  ids.add(id);
  return {
    id,
    kind: assertNonEmptyString(raw.kind, `${label}.kind`),
    sourceVersion: assertNonEmptyString(raw.sourceVersion, `${label}.sourceVersion`),
    symptom: assertNonEmptyString(raw.symptom, `${label}.symptom`),
    evidence: normalizeStringList(raw.evidence, `${label}.evidence`),
    repro: normalizeStringList(raw.repro, `${label}.repro`),
    expected: assertNonEmptyString(raw.expected, `${label}.expected`),
    status: assertNonEmptyString(raw.status, `${label}.status`),
  };
}

async function loadBadcases(file, { explicit = false } = {}) {
  let raw;
  try {
    raw = await readJson(file, "badcase 清单");
  } catch (error) {
    if (!explicit && error instanceof UsageError && error.code === "ENOENT") {
      return { loaded: false, path: path.resolve(file), reason: "文件不存在", total: 0 };
    }
    throw error;
  }
  invariant(isPlainObject(raw), "badcase 清单必须是对象");
  invariant(raw.schemaVersion === 1, `badcases.schemaVersion 必须是 1，收到 ${raw.schemaVersion}`);
  invariant(Array.isArray(raw.cases), "badcases.cases 必须是数组");
  const ids = new Set();
  const cases = raw.cases.map((entry, index) => normalizeBadcase(entry, `badcases.cases[${index}]`, ids));
  let example;
  if (raw.exampleCase !== undefined) {
    example = normalizeBadcase(raw.exampleCase, "badcases.exampleCase", new Set());
  }
  const byStatus = {};
  const byKind = {};
  for (const entry of cases) {
    byStatus[entry.status] = (byStatus[entry.status] ?? 0) + 1;
    byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1;
  }
  return {
    loaded: true,
    path: path.resolve(file),
    schemaVersion: 1,
    total: cases.length,
    byStatus,
    byKind,
    documentedExample: example !== undefined,
    exampleId: example?.id,
  };
}

function isTextFile(file) {
  return TEXT_EXTENSIONS.has(path.extname(file).toLowerCase());
}

function countChars(text) {
  return Array.from(text.replace(/\s/gu, "")).length;
}

async function readArtifact(sampleDir, relativePath) {
  const absolute = path.join(sampleDir, ...relativePath.split("/"));
  let info;
  try {
    info = await stat(absolute);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      return { path: relativePath, exists: false, reason: "missing", bytes: 0, text: undefined };
    }
    throw new UsageError(`无法读取产物 ${relativePath}: ${error.code ?? error.message}`);
  }
  if (!info.isFile()) {
    return { path: relativePath, exists: false, reason: "not-file", bytes: 0, text: undefined };
  }
  let text;
  if (isTextFile(relativePath)) {
    try {
      text = await readFile(absolute, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        return { path: relativePath, exists: false, reason: "missing", bytes: 0, text: undefined };
      }
      throw new UsageError(`无法读取文本产物 ${relativePath}: ${error.code ?? error.message}`);
    }
  }
  return {
    path: relativePath,
    exists: true,
    reason: undefined,
    bytes: info.size,
    text,
    charCount: text === undefined ? undefined : countChars(text),
  };
}

function neededFiles(sample, rubrics) {
  const files = new Set(sample.requiredFiles);
  for (const rubric of rubrics) {
    if (!rubric.appliesTo.includes(sample.kind)) continue;
    for (const file of rubric.check.files ?? []) files.add(file);
  }
  return [...files];
}

async function loadArtifacts(sampleDir, files) {
  const entries = await Promise.all(
    files.map(async (file) => [file, await readArtifact(sampleDir, file)]),
  );
  return new Map(entries);
}

function normalizeHeading(value) {
  return value
    .replace(/^#{1,6}\s+/u, "")
    .replace(/\s+#+\s*$/u, "")
    .trim()
    .replace(/\s+/gu, " ");
}

function extractHeadings(text) {
  const headings = [];
  const pattern = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/gmu;
  for (const match of text.matchAll(pattern)) {
    const heading = normalizeHeading(match[2]);
    if (heading !== "") headings.push(heading);
  }
  return headings;
}

function literalPattern(value) {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "giu");
}

function countMatches(text, pattern) {
  return [...text.matchAll(literalPattern(pattern))].length;
}

function lineAt(text, index) {
  const before = text.slice(0, index);
  const lineNumber = before.split(/\r?\n/u).length;
  const lineStart = Math.max(before.lastIndexOf("\n"), before.lastIndexOf("\r")) + 1;
  const nextBreak = text.slice(index).search(/\r?\n/u);
  const lineEnd = nextBreak === -1 ? text.length : index + nextBreak;
  return { line: lineNumber, text: text.slice(lineStart, lineEnd).trim() };
}

function mergedForbiddenPatterns(rubric, sample) {
  const values = [...rubric.check.patterns];
  if (rubric.check.includeSamplePatterns) values.push(...(sample.forbiddenPatterns ?? []));
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function skipped(reason) {
  return { applicable: false, reason };
}

function evaluateRubric(rubric, sample, artifacts) {
  if (!rubric.appliesTo.includes(sample.kind)) return skipped(`kind ${sample.kind} 不适用`);

  if (rubric.check.type === "files-present") {
    const files = rubric.check.source === "sample.requiredFiles" ? sample.requiredFiles : rubric.check.files;
    const missing = [];
    const empty = [];
    for (const file of files) {
      const artifact = artifacts.get(file);
      if (!artifact?.exists) missing.push(file);
      else if (rubric.check.nonEmpty && artifact.bytes === 0) empty.push(file);
    }
    return {
      applicable: true,
      result: { type: "files-present", files, missing, empty, passed: missing.length === 0 && empty.length === 0 },
    };
  }

  if (rubric.check.type === "min-chars") {
    if (!sample.minChars) return skipped("样本未声明 minChars");
    const failures = [];
    let charCount = 0;
    for (const [file, min] of Object.entries(sample.minChars)) {
      const artifact = artifacts.get(file);
      if (!artifact?.exists) {
        failures.push({ file, min, reason: "missing" });
        continue;
      }
      if (artifact.text === undefined) {
        failures.push({ file, min, reason: "not-text" });
        continue;
      }
      charCount += artifact.charCount;
      if (artifact.charCount < min) failures.push({ file, min, chars: artifact.charCount });
    }
    return {
      applicable: true,
      result: {
        type: "min-chars",
        checked: Object.keys(sample.minChars).length,
        charCount,
        failures,
        passed: failures.length === 0,
      },
    };
  }

  if (rubric.check.type === "required-headings") {
    if (!sample.requiredHeadings) return skipped("样本未声明 requiredHeadings");
    const missing = [];
    let requiredCount = 0;
    for (const [file, headings] of Object.entries(sample.requiredHeadings)) {
      const artifact = artifacts.get(file);
      const present = new Set(artifact?.text === undefined ? [] : extractHeadings(artifact.text));
      for (const heading of headings) {
        requiredCount += 1;
        if (!present.has(normalizeHeading(heading))) {
          missing.push({ file, heading, reason: artifact?.exists ? "missing" : "missing-file" });
        }
      }
    }
    return {
      applicable: true,
      result: { type: "required-headings", requiredCount, missing, passed: missing.length === 0 },
    };
  }

  if (rubric.check.type === "forbidden-patterns") {
    const patterns = mergedForbiddenPatterns(rubric, sample);
    if (patterns.length === 0) return skipped("没有可用的禁用模式");
    const hits = [];
    let hitCount = 0;
    for (const file of sample.requiredFiles) {
      const artifact = artifacts.get(file);
      if (artifact?.text === undefined) continue;
      for (const pattern of patterns) {
        const matches = [...artifact.text.matchAll(literalPattern(pattern))];
        if (matches.length === 0) continue;
        const first = matches[0];
        const location = lineAt(artifact.text, first.index);
        hits.push({
          file,
          pattern,
          count: matches.length,
          line: location.line,
          excerpt: location.text.slice(0, 160),
        });
        hitCount += matches.length;
      }
    }
    return {
      applicable: true,
      result: { type: "forbidden-patterns", patterns, hitCount, hits, passed: hitCount === 0 },
    };
  }

  if (rubric.check.type === "duplicate-headings") {
    const files = rubric.check.files ?? sample.requiredFiles;
    const duplicates = [];
    let headingCount = 0;
    let duplicateCount = 0;
    // 跨文件重复标题是正常结构（各章都有「概要」）；只统计同一文件内的重复。
    for (const file of files) {
      const artifact = artifacts.get(file);
      if (artifact?.text === undefined) continue;
      const counts = new Map();
      for (const heading of extractHeadings(artifact.text)) {
        headingCount += 1;
        counts.set(heading, (counts.get(heading) ?? 0) + 1);
      }
      for (const [heading, count] of counts) {
        if (count <= 1) continue;
        duplicateCount += count - 1;
        duplicates.push({ file, heading, count });
      }
    }
    return {
      applicable: true,
      result: {
        type: "duplicate-headings",
        maxDuplicates: rubric.check.maxDuplicates,
        headingCount,
        duplicateCount,
        duplicates,
        passed: duplicateCount <= rubric.check.maxDuplicates,
      },
    };
  }

  const files = rubric.check.files ?? sample.requiredFiles;
  const byFile = {};
  let count = 0;
  for (const file of files) {
    const artifact = artifacts.get(file);
    if (artifact?.text === undefined) continue;
    const matches = countMatches(artifact.text, rubric.check.pattern);
    if (matches > 0) byFile[file] = matches;
    count += matches;
  }
  return {
    applicable: true,
    result: {
      type: "marker-count",
      pattern: rubric.check.pattern,
      minCount: rubric.check.minCount,
      count,
      byFile,
      passed: count >= rubric.check.minCount,
    },
  };
}

function summarizeResult(result) {
  const preview = (items, limit = 8) => {
    if (items.length === 0) return "未通过";
    const shown = items.slice(0, limit);
    if (items.length > limit) shown.push(`等 ${items.length} 项`);
    return shown.join("；");
  };
  if (result.type === "files-present") {
    const parts = [];
    if (result.missing.length > 0) parts.push(`缺失文件：${preview(result.missing)}`);
    if (result.empty.length > 0) parts.push(`空文件：${preview(result.empty)}`);
    return parts.length > 0 ? parts.join("；") : "未通过";
  }
  if (result.type === "min-chars") {
    return preview(
      result.failures.map((failure) =>
        failure.reason ? `${failure.file}（${failure.reason}）` : `${failure.file}（${failure.chars} < ${failure.min}）`,
      ),
    );
  }
  if (result.type === "required-headings") {
    return preview(result.missing.map((entry) => `${entry.file} :: ${entry.heading}`));
  }
  if (result.type === "forbidden-patterns") {
    return preview(result.hits.map((hit) => `${hit.pattern} x${hit.count} @ ${hit.file}`));
  }
  if (result.type === "duplicate-headings") {
    return preview(result.duplicates.map((entry) => `${entry.heading} x${entry.count}`));
  }
  return `标记 "${result.pattern}" 数量 ${result.count} < ${result.minCount}`;
}

function collectSideDetails(checks, key) {
  let passCount = 0;
  const missingFiles = new Set();
  const emptyFiles = new Set();
  const missingHeadings = new Set();
  let forbiddenHitCount = 0;
  for (const check of checks) {
    const result = check[key];
    if (result.passed) passCount += 1;
    if (result.type === "files-present") {
      for (const file of result.missing) missingFiles.add(file);
      for (const file of result.empty) emptyFiles.add(file);
    } else if (result.type === "required-headings") {
      for (const entry of result.missing) missingHeadings.add(`${entry.file} :: ${entry.heading}`);
    } else if (result.type === "forbidden-patterns") {
      forbiddenHitCount += result.hitCount;
    }
  }
  return {
    passCount,
    failCount: checks.length - passCount,
    checkCount: checks.length,
    missingFiles: [...missingFiles].sort(),
    emptyFiles: [...emptyFiles].sort(),
    missingHeadings: [...missingHeadings].sort(),
    forbiddenHitCount,
  };
}

function computeCharCounts(sample, artifacts) {
  const byFile = {};
  let total = 0;
  for (const file of sample.requiredFiles) {
    const artifact = artifacts.get(file);
    if (artifact?.text === undefined) {
      byFile[file] = null;
      continue;
    }
    byFile[file] = artifact.charCount;
    total += artifact.charCount;
  }
  return { total, byFile };
}

function addedRemoved(base, candidate) {
  const baseSet = new Set(base);
  const candidateSet = new Set(candidate);
  return {
    base,
    candidate,
    added: candidate.filter((entry) => !baseSet.has(entry)),
    removed: base.filter((entry) => !candidateSet.has(entry)),
  };
}

async function evaluateSample(sample, baseDir, candidateDir, rubrics) {
  const files = neededFiles(sample, rubrics);
  const [baseArtifacts, candidateArtifacts] = await Promise.all([
    loadArtifacts(baseDir, files),
    loadArtifacts(candidateDir, files),
  ]);
  const checks = [];
  const skippedRubrics = [];
  const regressions = [];
  const improvements = [];

  for (const rubric of rubrics) {
    const baseEvaluation = evaluateRubric(rubric, sample, baseArtifacts);
    const candidateEvaluation = evaluateRubric(rubric, sample, candidateArtifacts);
    if (!baseEvaluation.applicable) {
      skippedRubrics.push({ rubric: rubric.id, reason: baseEvaluation.reason });
      continue;
    }
    invariant(candidateEvaluation.applicable, `rubric 适用性不一致: ${rubric.id}`);
    const baseResult = baseEvaluation.result;
    const candidateResult = candidateEvaluation.result;
    let status;
    if (baseResult.passed && candidateResult.passed) status = "pass";
    else if (!baseResult.passed && !candidateResult.passed) status = "persistent";
    else if (baseResult.passed && !candidateResult.passed) status = "regression";
    else status = "fixed";

    const check = {
      rubric: rubric.id,
      name: rubric.name,
      severity: rubric.severity,
      status,
      basePassed: baseResult.passed,
      candidatePassed: candidateResult.passed,
      baseResult,
      candidateResult,
    };
    checks.push(check);
    if (status === "regression") {
      regressions.push({
        rubric: rubric.id,
        name: rubric.name,
        severity: rubric.severity,
        detail: summarizeResult(candidateResult),
      });
    } else if (status === "fixed") {
      improvements.push({
        rubric: rubric.id,
        name: rubric.name,
        severity: rubric.severity,
        detail: summarizeResult(baseResult),
      });
    }
  }

  const baseChars = computeCharCounts(sample, baseArtifacts);
  const candidateChars = computeCharCounts(sample, candidateArtifacts);
  const baseDetails = collectSideDetails(checks, "baseResult");
  const candidateDetails = collectSideDetails(checks, "candidateResult");
  const sideSummary = (details, charCount) => ({
    passCount: details.passCount,
    failCount: details.failCount,
    checkCount: details.checkCount,
    charCount,
    missingFileCount: details.missingFiles.length,
    emptyFileCount: details.emptyFiles.length,
    missingHeadingCount: details.missingHeadings.length,
    forbiddenHitCount: details.forbiddenHitCount,
  });
  const baseSummary = sideSummary(baseDetails, baseChars.total);
  const candidateSummary = sideSummary(candidateDetails, candidateChars.total);
  const byFile = {};
  for (const file of sample.requiredFiles) {
    const baseCount = baseChars.byFile[file];
    const candidateCount = candidateChars.byFile[file];
    byFile[file] = {
      base: baseCount,
      candidate: candidateCount,
      delta: baseCount === null || candidateCount === null ? null : candidateCount - baseCount,
    };
  }

  return {
    id: sample.id,
    kind: sample.kind,
    requiredFiles: sample.requiredFiles,
    summary: {
      checkCount: checks.length,
      skippedCount: skippedRubrics.length,
      base: baseSummary,
      candidate: candidateSummary,
      delta: {
        passCount: candidateSummary.passCount - baseSummary.passCount,
        failCount: candidateSummary.failCount - baseSummary.failCount,
        charCount: candidateSummary.charCount - baseSummary.charCount,
        missingFileCount: candidateSummary.missingFileCount - baseSummary.missingFileCount,
        emptyFileCount: candidateSummary.emptyFileCount - baseSummary.emptyFileCount,
        missingHeadingCount: candidateSummary.missingHeadingCount - baseSummary.missingHeadingCount,
        forbiddenHitCount: candidateSummary.forbiddenHitCount - baseSummary.forbiddenHitCount,
      },
    },
    charCounts: {
      base: baseChars.total,
      candidate: candidateChars.total,
      delta: candidateChars.total - baseChars.total,
      byFile,
    },
    missingFiles: addedRemoved(baseDetails.missingFiles, candidateDetails.missingFiles),
    missingHeadings: addedRemoved(baseDetails.missingHeadings, candidateDetails.missingHeadings),
    forbiddenHits: {
      base: baseDetails.forbiddenHitCount,
      candidate: candidateDetails.forbiddenHitCount,
      delta: candidateDetails.forbiddenHitCount - baseDetails.forbiddenHitCount,
    },
    checks,
    skippedRubrics,
    regressions,
    improvements,
  };
}

function countBy(values) {
  const result = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
}

function aggregateSide(samples, side) {
  const summary = (sample) => sample.summary[side];
  return {
    passCount: samples.reduce((sum, sample) => sum + summary(sample).passCount, 0),
    failCount: samples.reduce((sum, sample) => sum + summary(sample).failCount, 0),
    checkCount: samples.reduce((sum, sample) => sum + summary(sample).checkCount, 0),
    charCount: samples.reduce((sum, sample) => sum + summary(sample).charCount, 0),
    missingFileCount: samples.reduce((sum, sample) => sum + summary(sample).missingFileCount, 0),
    emptyFileCount: samples.reduce((sum, sample) => sum + summary(sample).emptyFileCount, 0),
    missingHeadingCount: samples.reduce((sum, sample) => sum + summary(sample).missingHeadingCount, 0),
    forbiddenHitCount: samples.reduce((sum, sample) => sum + summary(sample).forbiddenHitCount, 0),
  };
}

export async function runEvaluation({
  base,
  candidate,
  corpusPath = DEFAULT_PATHS.corpus,
  rubricsPath = DEFAULT_PATHS.rubrics,
  badcasesPath = DEFAULT_PATHS.badcases,
  includeBadcases = true,
  badcasesExplicit = false,
} = {}) {
  assertNonEmptyString(base, "--base");
  assertNonEmptyString(candidate, "--candidate");
  const baseRoot = path.resolve(base);
  const candidateRoot = path.resolve(candidate);
  await requireDirectory(baseRoot, "base");
  await requireDirectory(candidateRoot, "candidate");

  const [corpus, rubricsDocument, badcases] = await Promise.all([
    loadCorpus(corpusPath),
    loadRubrics(rubricsPath),
    includeBadcases
      ? loadBadcases(badcasesPath, { explicit: badcasesExplicit })
      : Promise.resolve({ loaded: false, path: path.resolve(badcasesPath), reason: "已禁用", total: 0 }),
  ]);

  for (const sample of corpus.samples) {
    await requireDirectory(path.join(baseRoot, sample.id), `base 样本 "${sample.id}"`);
    await requireDirectory(path.join(candidateRoot, sample.id), `candidate 样本 "${sample.id}"`);
  }

  const samples = [];
  for (const sample of corpus.samples) {
    samples.push(
      await evaluateSample(
        sample,
        path.join(baseRoot, sample.id),
        path.join(candidateRoot, sample.id),
        rubricsDocument.rubrics,
      ),
    );
  }

  const baseAggregate = aggregateSide(samples, "base");
  const candidateAggregate = aggregateSide(samples, "candidate");
  const regressionsBySeverity = { P0: 0, P1: 0, P2: 0 };
  const improvementsBySeverity = { P0: 0, P1: 0, P2: 0 };
  const regressions = [];
  const improvements = [];
  const samplesWithRegressions = [];
  let candidateBlockingFailures = 0;

  for (const sample of samples) {
    for (const regression of sample.regressions) {
      regressionsBySeverity[regression.severity] += 1;
      regressions.push({ sample: sample.id, ...regression });
    }
    for (const improvement of sample.improvements) {
      improvementsBySeverity[improvement.severity] += 1;
      improvements.push({ sample: sample.id, ...improvement });
    }
    if (sample.regressions.length > 0) samplesWithRegressions.push(sample.id);
    for (const check of sample.checks) {
      if ((check.severity === "P0" || check.severity === "P1") && !check.candidateResult.passed) {
        candidateBlockingFailures += 1;
      }
    }
  }

  const aggregate = {
    sampleCount: samples.length,
    skippedRubricCount: samples.reduce((sum, sample) => sum + sample.skippedRubrics.length, 0),
    base: baseAggregate,
    candidate: candidateAggregate,
    delta: {
      passCount: candidateAggregate.passCount - baseAggregate.passCount,
      failCount: candidateAggregate.failCount - baseAggregate.failCount,
      charCount: candidateAggregate.charCount - baseAggregate.charCount,
      missingFileCount: candidateAggregate.missingFileCount - baseAggregate.missingFileCount,
      emptyFileCount: candidateAggregate.emptyFileCount - baseAggregate.emptyFileCount,
      missingHeadingCount: candidateAggregate.missingHeadingCount - baseAggregate.missingHeadingCount,
      forbiddenHitCount: candidateAggregate.forbiddenHitCount - baseAggregate.forbiddenHitCount,
    },
    regressionsBySeverity,
    improvementsBySeverity,
    regressions,
    improvements,
    samplesWithRegressions,
  };

  const blockingRegressions = regressionsBySeverity.P0 + regressionsBySeverity.P1;
  const p2Regressions = regressionsBySeverity.P2;
  let status = "clean";
  if (blockingRegressions > 0) status = "regressed";
  else if (candidateBlockingFailures > 0) status = "no-regression-baseline-failures";
  else if (p2Regressions > 0) status = "regressed-p2-only";

  return {
    schemaVersion: 1,
    tool: "dsh-miaowu/eval-quality",
    generatedAt: new Date().toISOString(),
    label: REPORT_LABEL,
    disclaimer: REPORT_DISCLAIMER,
    deterministic: true,
    modelRuns: false,
    paidModelCalls: 0,
    networkCalls: 0,
    inputs: {
      base: baseRoot,
      candidate: candidateRoot,
      corpus: path.resolve(corpusPath),
      rubrics: path.resolve(rubricsPath),
      badcases: includeBadcases ? path.resolve(badcasesPath) : null,
    },
    corpus: {
      schemaVersion: corpus.schemaVersion,
      sampleCount: corpus.samples.length,
      kinds: countBy(corpus.samples.map((sample) => sample.kind)),
    },
    rubrics: {
      schemaVersion: rubricsDocument.schemaVersion,
      rubricCount: rubricsDocument.rubrics.length,
      bySeverity: countBy(rubricsDocument.rubrics.map((rubric) => rubric.severity)),
    },
    badcases,
    samples,
    aggregate,
    verdict: {
      status,
      exitCode: blockingRegressions > 0 ? 1 : 0,
      blockingRegressions,
      p2Regressions,
      candidateBlockingFailures,
      totalRegressions: regressions.length,
      totalImprovements: improvements.length,
    },
  };
}

const STATUS_TEXT = {
  clean: "通过（未发现回归）",
  regressed: "失败（存在 P0/P1 回归）",
  "regressed-p2-only": "通过（仅有 P2 回归，不阻塞退出码）",
  "no-regression-baseline-failures": "无新增回归，但候选仍有 P0/P1 未通过（基线同样未通过）",
};

function mdCell(value) {
  return String(value).replace(/\|/gu, "\\|").replace(/\r?\n/gu, " ");
}

function signed(value) {
  return value > 0 ? `+${value}` : String(value);
}

function regressionCounts(sample) {
  return countBy(sample.regressions.map((regression) => regression.severity));
}

export function renderMarkdown(report) {
  const lines = [];
  const verdictText = STATUS_TEXT[report.verdict.status] ?? report.verdict.status;
  lines.push("# dsh-miaowu 质量与评测报告", "");
  lines.push(`**${REPORT_LABEL}**`, "");
  lines.push(`> ${REPORT_DISCLAIMER}`, "");
  lines.push(`- 生成时间：${report.generatedAt}`);
  lines.push(`- 基线：\`${report.inputs.base}\``);
  lines.push(`- 候选：\`${report.inputs.candidate}\``);
  lines.push(`- 语料：\`${report.inputs.corpus}\``);
  lines.push(`- 规则：\`${report.inputs.rubrics}\``);
  if (report.inputs.badcases) lines.push(`- Badcase 清单：\`${report.inputs.badcases}\``);
  else lines.push("- Badcase 清单：未加载");
  lines.push("");

  lines.push("## 结论", "");
  lines.push(`- 结论：${verdictText}`);
  lines.push(`- 退出码：${report.verdict.exitCode}（0 无 P0/P1 回归；1 候选 P0/P1 回归；2 用法/输入错误）`);
  lines.push(
    `- 回归：P0 ${report.aggregate.regressionsBySeverity.P0} / P1 ${report.aggregate.regressionsBySeverity.P1} / P2 ${report.aggregate.regressionsBySeverity.P2}`,
  );
  if (report.verdict.candidateBlockingFailures > 0) {
    lines.push(
      `- 候选仍有 ${report.verdict.candidateBlockingFailures} 项 P0/P1 未通过，其中 ${report.verdict.blockingRegressions} 项是相对基线新增的回归。`,
    );
  }
  lines.push("");

  lines.push("## 聚合（基线 -> 候选）", "");
  lines.push("| 指标 | 基线 | 候选 | 增量 |");
  lines.push("|---|---:|---:|---:|");
  const base = report.aggregate.base;
  const candidate = report.aggregate.candidate;
  const delta = report.aggregate.delta;
  lines.push(`| 通过检查 / 总检查 | ${base.passCount} / ${base.checkCount} | ${candidate.passCount} / ${candidate.checkCount} | ${signed(delta.passCount)} |`);
  lines.push(`| 非空白字符数 | ${base.charCount} | ${candidate.charCount} | ${signed(delta.charCount)} |`);
  lines.push(`| 缺失文件 | ${base.missingFileCount} | ${candidate.missingFileCount} | ${signed(delta.missingFileCount)} |`);
  lines.push(`| 缺失标题 | ${base.missingHeadingCount} | ${candidate.missingHeadingCount} | ${signed(delta.missingHeadingCount)} |`);
  lines.push(`| 禁用词命中 | ${base.forbiddenHitCount} | ${candidate.forbiddenHitCount} | ${signed(delta.forbiddenHitCount)} |`);
  lines.push("");

  lines.push("## 样本", "");
  lines.push("| 样本 | 类型 | 基线通过 | 候选通过 | 字符增量 | 缺失文件 | 缺失标题 | 禁用词 | P0 | P1 | P2 |");
  lines.push("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const sample of report.samples) {
    const counts = regressionCounts(sample);
    lines.push(
      `| ${mdCell(sample.id)} | ${sample.kind} | ${sample.summary.base.passCount}/${sample.summary.base.checkCount} | ${sample.summary.candidate.passCount}/${sample.summary.candidate.checkCount} | ${signed(sample.summary.delta.charCount)} | ${signed(sample.summary.delta.missingFileCount)} | ${signed(sample.summary.delta.missingHeadingCount)} | ${signed(sample.summary.delta.forbiddenHitCount)} | ${counts.P0 ?? 0} | ${counts.P1 ?? 0} | ${counts.P2 ?? 0} |`,
    );
  }
  lines.push("");

  lines.push("## 回归明细", "");
  if (report.aggregate.regressions.length === 0) {
    lines.push("无 P0/P1/P2 回归。", "");
  } else {
    for (const regression of report.aggregate.regressions) {
      lines.push(
        `- [${regression.severity}] ${regression.sample} / ${regression.rubric}（${regression.name}）：${regression.detail}`,
      );
    }
    lines.push("");
  }

  if (report.aggregate.improvements.length > 0) {
    lines.push("## 改进明细", "");
    for (const improvement of report.aggregate.improvements) {
      lines.push(
        `- [${improvement.severity}] ${improvement.sample} / ${improvement.rubric}（${improvement.name}）：基线未通过，候选通过；基线问题：${improvement.detail}`,
      );
    }
    lines.push("");
  }

  lines.push("## Badcase 清单", "");
  if (!report.badcases.loaded) {
    lines.push(`- 未加载：${report.badcases.reason ?? "未知原因"}`);
  } else {
    lines.push(
      `- 已加载 schemaVersion ${report.badcases.schemaVersion}，共 ${report.badcases.total} 条；状态分布：${JSON.stringify(report.badcases.byStatus)}；示例字段条目：${report.badcases.documentedExample ? "有（不计入统计）" : "无"}。`,
    );
  }
  lines.push("");

  lines.push("## 未覆盖范围", "");
  lines.push("- 未调用任何真实模型或 provider，未运行付费生成任务，因此不包含任何模型生成质量结论。");
  lines.push("- 未评测叙事质量、事实一致性、镜头可看性、美术效果、配音效果或发布适配度。");
  lines.push("- 字符数、标题数、占位符和文件存在性只是结构信号，不等价于内容质量。");
  lines.push("- 二进制文件（如 .mp4）只检查存在性与字节大小，不解析媒体内容。");
  lines.push("- 本报告不是发布门禁：在真实语料和真实 provider 运行建立前，它只作为结构回归的辅助信号。");
  lines.push("");
  return lines.join("\n");
}

export function parseArgs(argv) {
  const options = {
    base: undefined,
    candidate: undefined,
    corpus: DEFAULT_PATHS.corpus,
    rubrics: DEFAULT_PATHS.rubrics,
    badcases: DEFAULT_PATHS.badcases,
    out: "-",
    markdown: undefined,
    includeBadcases: true,
    badcasesExplicit: false,
    help: false,
  };
  const valueFlags = new Set(["base", "candidate", "corpus", "rubrics", "badcases", "out", "markdown"]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--no-badcases") {
      options.includeBadcases = false;
      continue;
    }
    const match = /^--([a-z][a-z-]*)(?:=(.*))?$/u.exec(argument);
    if (!match) throw new UsageError(`无法识别的参数: ${argument}`);
    const name = match[1];
    if (!valueFlags.has(name)) throw new UsageError(`无法识别的参数: ${argument}`);
    let value = match[2];
    if (value === undefined) {
      value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError(`--${name} 需要一个值`);
      }
      index += 1;
    }
    if (value === "") throw new UsageError(`--${name} 需要一个非空值`);
    options[name] = value;
    if (name === "badcases") {
      options.includeBadcases = true;
      options.badcasesExplicit = true;
    }
  }

  if (options.help) return options;
  if (!options.base) throw new UsageError("缺少必填参数 --base");
  if (!options.candidate) throw new UsageError("缺少必填参数 --candidate");
  if (options.out === "-" && options.markdown === "-") {
    throw new UsageError("--out 和 --markdown 不能同时输出到 stdout");
  }
  return options;
}

async function writeOutput(file, content) {
  const absolute = path.resolve(file);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content, "utf8");
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const report = await runEvaluation({
    base: options.base,
    candidate: options.candidate,
    corpusPath: options.corpus,
    rubricsPath: options.rubrics,
    badcasesPath: options.badcases,
    includeBadcases: options.includeBadcases,
    badcasesExplicit: options.badcasesExplicit,
  });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.out === "-") process.stdout.write(json);
  else await writeOutput(options.out, json);
  if (options.markdown !== undefined) {
    const markdown = `${renderMarkdown(report)}\n`;
    if (options.markdown === "-") process.stdout.write(markdown);
    else await writeOutput(options.markdown, markdown);
  }
  return report.verdict.exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      const message =
        error instanceof UsageError ? error.message : (error?.stack ?? String(error));
      process.stderr.write(`eval-quality: ${message}\n`);
      process.exitCode = 2;
    },
  );
}
