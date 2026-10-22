import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { applyChanges, diffManifests, treeDigest } from "../src/fs-tree.mjs";
import { globMatches, validateChangeScope } from "../src/policy.mjs";

test("scope globs distinguish production paths from tests and metadata", () => {
  assert.equal(globMatches("lib/windows/job-host.ps1", "lib/windows/**"), true);
  assert.equal(globMatches("lib/windows-job.mjs", "lib/windows/**"), false);
  const violations = validateChangeScope([
    { path: "lib/windows/job-host.ps1", change: "modified" },
    { path: "test/windows-job.test.mjs", change: "modified" },
  ], { allowed: ["lib/windows/**"], forbidden: ["test/**"] });
  assert.deepEqual(violations.map((item) => item.reason), ["forbidden_path"]);
});

test("a candidate delta is replayed onto a clean grading tree", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "kiln-benchmark-tree-"));
  const base = resolve(root, "base");
  const candidate = resolve(root, "candidate");
  const grade = resolve(root, "grade");
  try {
    await mkdir(resolve(base, "src"), { recursive: true });
    await mkdir(resolve(candidate, "src"), { recursive: true });
    await writeFile(resolve(base, "src", "value.txt"), "broken\n");
    await writeFile(resolve(candidate, "src", "value.txt"), "fixed\n");
    const before = await treeDigest(base);
    const after = await treeDigest(candidate);
    const changes = diffManifests(before, after);
    assert.deepEqual(changes.map((item) => [item.path, item.change]), [["src/value.txt", "modified"]]);
    await applyChanges(base, candidate, grade, changes);
    assert.equal((await treeDigest(grade)).sha256, after.sha256);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
