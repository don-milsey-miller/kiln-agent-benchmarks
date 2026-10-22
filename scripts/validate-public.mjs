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
const allowedPaidStatuses = new Set(["disabled", "authorized_pending_attestation", "enabled", "completed", "halted"]);
if (!allowedPaidStatuses.has(isolation.paidBackend.status)) throw new Error("paid execution has an invalid state");
if (isolation.paidBackend.status !== "disabled") {
  if (isolation.paidBackend.experimentId !== "ms4-pilot-20261022") throw new Error("paid execution experiment is not frozen");
  if (isolation.paidBackend.maximumBudgetUsd !== 50) throw new Error("paid execution budget differs from the approved ceiling");
  if (isolation.paidBackend.gpu?.count !== 3 || isolation.paidBackend.gpu?.cloud !== "SECURE") throw new Error("paid execution topology differs from the approved topology");
  if (!/@sha256:[0-9a-f]{64}$/.test(isolation.paidBackend.image ?? "")) throw new Error("paid execution image is not digest-pinned");
  const policyHash = await sha256File(resolve(root, isolation.paidBackend.executionPolicy?.path ?? ""));
  if (policyHash !== isolation.paidBackend.executionPolicy?.sha256) throw new Error("paid execution policy hash mismatch");
}
if (isolation.paidBackend.status === "completed") {
  const ms4 = await readJson("evidence/ms4-results.json");
  if (ms4.status !== "completed" || ms4.runCount !== 9 || ms4.results?.length !== 9) throw new Error("MS4 completion evidence is incomplete");
  if (!ms4.billed?.terminalStateVerified) throw new Error("MS4 pod shutdown was not verified");
  if (!Number.isFinite(ms4.billed?.actualUsd) || ms4.billed.actualUsd > isolation.paidBackend.maximumBudgetUsd) throw new Error("MS4 spending evidence exceeds or omits the approved ceiling");
}
if (ms2.status !== "passed" || ms3.status !== "passed") throw new Error("MS2/MS3 evidence is not green");
console.log(JSON.stringify({ ok: true, tasks: tasks.tasks.length, models: models.models.length, ms2: ms2.status, ms3: ms3.status, paidExecution: isolation.paidBackend.status }));
