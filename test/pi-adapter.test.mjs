import test from "node:test";
import assert from "node:assert/strict";

import { assertPilotAuthorization, buildNineRunPlan, buildPiInvocation, checkVllmReadiness, reserveBudget } from "../src/pi-adapter.mjs";

test("the pilot plan is exactly three tasks by three one-GPU model streams", () => {
  const tasks = ["S1", "M1", "L1"].map((id, index) => ({ id, deadlineMinutes: [10, 30, 120][index] }));
  const models = ["qwen", "muse", "gemma"].map((id, gpu) => ({ id, gpu }));
  const plan = buildNineRunPlan(tasks, models);
  assert.equal(plan.length, 9);
  assert.deepEqual(plan.slice(0, 3).map((run) => run.gpu), [0, 1, 2]);
});

test("Pi invocation holds tools and protocol constant while preserving model controls", () => {
  const invocation = buildPiInvocation({
    piPath: "/workspace/bin/pi",
    model: { provider: "vllm-muse", repository: "meta-models/Muse-Glimmer-30B", thinking: "off", systemPromptSuffix: "Reasoning strength: low" },
    prompt: "Repair the task.",
  });
  assert.equal(invocation.protocol, "jsonl");
  assert.ok(invocation.args.includes("read,bash,edit,write"));
  assert.ok(invocation.args.includes("Reasoning strength: low"));
  assert.equal(invocation.environment.PI_OFFLINE, "1");
});

test("budget reservations fail closed", () => {
  assert.deepEqual(reserveBudget({ ceilingUsd: 50, spentUsd: 4, requestedUsd: 20 }), { ceilingUsd: 50, spentUsd: 4, reservedUsd: 20, remainingUsd: 26 });
  assert.throws(() => reserveBudget({ ceilingUsd: 50, spentUsd: 40, requestedUsd: 20 }), /ceiling exceeded/);
});

test("readiness records endpoint failures without treating them as model failures", async () => {
  const result = await checkVllmReadiness([{ id: "qwen", endpoint: "http://127.0.0.1:8001/v1" }], {
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });
  assert.deepEqual(result, { ready: false, checks: [{ modelId: "qwen", ok: false, status: 503 }] });
});

test("paid execution cannot start without a separate authorization record", async () => {
  await assert.rejects(() => assertPilotAuthorization("missing-authorization.json", {
    experimentId: "pilot",
    tasks: ["S1", "M1", "L1"],
    models: ["qwen", "muse", "gemma"],
    maxBudgetUsd: 50,
  }), /paid execution is disabled/);
});
