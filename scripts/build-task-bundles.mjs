import { mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertWithin, treeDigest, writeJson } from "../src/fs-tree.mjs";
import { scanAgentTree } from "../src/policy.mjs";
import { runBounded } from "../src/process.mjs";

const benchmarkRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceRoot = resolve(process.argv[2] ?? resolve(benchmarkRoot, ".work", "kiln-source"));
const outputRoot = resolve(benchmarkRoot, "artifacts", "private", "bundles");
const publicManifest = JSON.parse(await readFile(resolve(benchmarkRoot, "manifests", "tasks.public.json"), "utf8"));

assertWithin(resolve(benchmarkRoot, "artifacts", "private"), outputRoot);
await rm(outputRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
await mkdir(outputRoot, { recursive: true });

const built = [];
for (const task of publicManifest.tasks) {
  if (task.status !== "ready") continue;
  const destination = resolve(outputRoot, task.id);
  const archive = resolve(outputRoot, `${task.id}.tar`);
  await mkdir(destination, { recursive: true });
  const archived = await runBounded("git", ["-C", sourceRoot, "archive", "--format=tar", `--output=${archive}`, task.preFixSha], { timeoutMs: 60_000 });
  if (archived.code !== 0) throw new Error(`git archive failed for ${task.id}: ${archived.stderr}`);
  const extracted = await runBounded("tar.exe", ["-xf", archive, "-C", destination], { timeoutMs: 60_000 });
  await rm(archive, { force: true });
  if (extracted.code !== 0) throw new Error(`archive extraction failed for ${task.id}: ${extracted.stderr}`);
  const violations = await scanAgentTree(destination, { forbiddenTokens: [task.fixSha, task.fixSha.slice(0, 12)] });
  if (violations.length) throw new Error(`${task.id} bundle leaked forbidden material: ${JSON.stringify(violations)}`);
  const digest = await treeDigest(destination, { ignoreNames: new Set(["node_modules"]) });
  built.push({
    taskId: task.id,
    sourceSha: task.preFixSha,
    treeSha256: digest.sha256,
    fileCount: digest.files.length,
    gitMetadataPresent: digest.files.some((file) => file.path === ".git" || file.path.startsWith(".git/")),
    fixingCommitPresent: false,
  });
}

const manifest = { schemaVersion: 1, builtAt: new Date().toISOString(), sourceRoot, bundles: built };
await writeJson(resolve(benchmarkRoot, "artifacts", "private", "bundles.manifest.json"), manifest);
console.log(JSON.stringify(manifest, null, 2));
