import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256File } from "../src/fs-tree.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const readJson = async (path) => JSON.parse(await readFile(resolve(root, path), "utf8"));
const tasks = await readJson("manifests/tasks.public.json");
const models = await readJson("config/models.public.json");
const isolation = await readJson("config/isolation.public.json");
const ms2 = await readJson("evidence/ms2-results.json");
const ms3 = await readJson("evidence/ms3-results.json");
await readJson("config/tasks.runner.public.json");
await readJson("schemas/run-result.schema.json");
await readJson("evidence/provenance.json");
await readJson("evidence/ms1-results.json");

for (const task of tasks.tasks) {
  if (task.status !== "ready") throw new Error(`${task.id} is not ready`);
  if (!/^[0-9a-f]{40}$/.test(task.preFixSha) || !/^[0-9a-f]{40}$/.test(task.fixSha)) throw new Error(`${task.id} has an invalid source SHA`);
  const actual = await sha256File(resolve(root, task.promptPath));
  if (actual !== task.promptSha256) throw new Error(`${task.id} prompt hash mismatch: ${actual}`);
  if (ms2.bundles[task.id]?.treeSha256 !== task.bundleTreeSha256) throw new Error(`${task.id} bundle hash evidence mismatch`);
  if (!/^[0-9a-f]{64}$/.test(task.graderSha256)) throw new Error(`${task.id} grader is not frozen`);
}
for (const model of models.models) {
  if (!/^[0-9a-f]{40}$/.test(model.revision)) throw new Error(`${model.id} is not pinned to an immutable revision`);
  if (!/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(model.endpoint)) throw new Error(`${model.id} endpoint is not loopback-only`);
}
if (isolation.paidBackend.status !== "disabled") throw new Error("paid execution must remain disabled before MS4 approval");
if (ms2.status !== "passed" || ms3.status !== "passed") throw new Error("MS2/MS3 evidence is not green");
console.log(JSON.stringify({ ok: true, tasks: tasks.tasks.length, models: models.models.length, ms2: ms2.status, ms3: ms3.status, paidExecution: "disabled" }));
