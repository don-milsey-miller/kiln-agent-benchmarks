import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { copyCleanTree, sha256, sha256File } from "../src/fs-tree.mjs";
import { runAttempt } from "../src/runner.mjs";

const fixtureRoot = fileURLToPath(new URL("./fixtures/ms3-bundle", import.meta.url));
const agentPath = fileURLToPath(new URL("./fixtures/mock-agent-direct.mjs", import.meta.url));
const graderPath = fileURLToPath(new URL("./fixtures/mock-grader.mjs", import.meta.url));

test("runner separates agent, policy, test, and infrastructure outcomes", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "kiln-benchmark-runner-"));
  const bundle = resolve(root, "bundle");
  const attempts = resolve(root, "attempts");
  await copyCleanTree(fixtureRoot, bundle);
  await mkdir(attempts);
  const task = {
    id: "CONTROL",
    preFixSha: "synthetic-source-v1",
    promptSha256: sha256("prompt"),
    deadlineMinutes: 1,
    allowedProductionPaths: ["src/**"],
  };
  const common = {
    experimentId: "unit",
    task,
    model: { id: "mock", revision: "mock-v1" },
    bundleRoot: bundle,
    attemptsRoot: attempts,
    grader: { command: process.execPath, args: [graderPath, "normal"], sha256: await sha256File(graderPath), timeoutMs: 5_000 },
    alwaysForbiddenPaths: ["test/**", ".git/**"],
    budget: { ceilingUsd: 0, estimatedUsd: 0 },
  };
  const run = (id, scenario, overrides = {}) => runAttempt({
    ...common,
    ...overrides,
    runId: id,
    agent: { backend: "direct", command: process.execPath, args: [agentPath, scenario], protocol: "jsonl", timeoutMs: 5_000 },
  });
  try {
    assert.equal((await run("valid", "valid")).classification, "passed");
    assert.equal((await run("failing", "failing")).classification, "failed_tests");
    assert.equal((await run("malformed", "malformed")).classification, "agent_error");
    assert.equal((await run("scope", "scope")).classification, "policy_violation");
    assert.equal((await run("agent-error", "error")).classification, "agent_error");
    assert.equal((await run("infra", "valid", { grader: { ...common.grader, args: [graderPath, "infra-error"] } })).classification, "infra_error");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
