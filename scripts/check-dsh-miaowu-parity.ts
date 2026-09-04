import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

interface ManifestFile {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

interface SelfManifest {
  readonly skills: readonly string[];
  readonly files: readonly ManifestFile[];
}

const packageRoot = resolve(import.meta.dirname, "../packages/knowledge/dsh-miaowu");
const manifestPath = join(packageRoot, "manifest.json");
const skillsRoot = join(packageRoot, "skills");

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function collectDiskFiles(): Promise<ManifestFile[]> {
  const out: ManifestFile[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), rel);
        continue;
      }
      if (entry.isFile()) {
        const bytes = await readFile(join(dir, entry.name));
        out.push({ path: rel, sha256: sha256(bytes), bytes: bytes.byteLength });
      }
    }
  }
  await walk(packageRoot, "");
  // The manifest describes its own payload; it never lists itself.
  return out.filter((file) => file.path !== "manifest.json").sort((a, b) => a.path.localeCompare(b.path));
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as SelfManifest;
const actual = await collectDiskFiles();
const normalize = (files: readonly ManifestFile[]): string =>
  JSON.stringify(
    [...files]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((file) => ({ bytes: file.bytes, path: file.path, sha256: file.sha256 }))
  );
if (normalize(actual) !== normalize(manifest.files)) {
  const expectedPaths = new Set(manifest.files.map((file) => file.path));
  const actualPaths = new Set(actual.map((file) => file.path));
  const missing = [...expectedPaths].filter((path) => !actualPaths.has(path));
  const extra = [...actualPaths].filter((path) => !expectedPaths.has(path));
  const mismatched = actual
    .filter((file) => expectedPaths.has(file.path))
    .filter((file) => {
      const expected = manifest.files.find((candidate) => candidate.path === file.path);
      return expected?.sha256 !== file.sha256 || expected?.bytes !== file.bytes;
    })
    .map((file) => file.path);
  throw new Error(
    `dsh-miaowu knowledge files differ from manifest (missing: ${missing.join(", ") || "none"}; ` +
    `extra: ${extra.join(", ") || "none"}; hash mismatch: ${mismatched.join(", ") || "none"}).`
  );
}
if (actual.some(({ path }) => path.includes("__pycache__") || path.endsWith(".pyc") || path.endsWith(".DS_Store"))) {
  throw new Error("dsh-miaowu knowledge retained workspace artifacts.");
}

const skillDirs = (await readdir(skillsRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
if (JSON.stringify(skillDirs) !== JSON.stringify([...manifest.skills].sort())) {
  throw new Error(`dsh-miaowu skills differ from manifest (disk: ${skillDirs.join(", ")}; manifest: ${[...manifest.skills].sort().join(", ")}).`);
}

const skillSource = await readFile(join(skillsRoot, "worldbuilding/SKILL.md"), "utf8");
const nameMatch = /^name:\s*(\S+)/mu.exec(skillSource)?.[1];
if (nameMatch !== "worldbuilding") throw new Error("worldbuilding SKILL.md has an invalid name.");
const description = /^description:\s*(?:"((?:[^"\\]|\\.)*)"|(.*))$/mu.exec(skillSource)?.slice(1, 3).find((part) => part !== undefined);
if (!description) throw new Error("worldbuilding SKILL.md has no description.");
for (const trigger of ["世界观构建", "先建世界观", "worldbuilding"]) {
  if (!description.includes(trigger)) throw new Error(`worldbuilding description is missing the trigger intent "${trigger}".`);
}
for (const output of ["设定/世界观/背景设定.md", "设定/世界观/力量体系.md", "设定/世界观/地理.md", "设定/势力/", "设定/规则/", "设定/世界观/_索引.md"]) {
  if (!skillSource.includes(output)) throw new Error(`worldbuilding SKILL.md no longer declares the Phase 2 output ${output}.`);
}
if (!skillSource.includes("oh_story_role") || !skillSource.includes("story-architect")) {
  throw new Error("worldbuilding SKILL.md lost the story-architect collaboration contract.");
}

process.stdout.write(
  `dsh-miaowu parity OK: ${String(manifest.skills.length)} self-owned skill(s), ${String(manifest.files.length)} files.\n`
);
