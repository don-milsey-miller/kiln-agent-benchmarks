import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertWithin, copyCleanTree, sha256, sha256File, writeJson } from "../src/fs-tree.mjs";
import { renderMarkdown, summarizeResults } from "../src/report.mjs";
import { runAttempt } from "../src/runner.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const experimentId = "kiln-ms3-offline-2026-10-22";
const rawRoot = resolve(root, "artifacts", "raw", experimentId);
const attemptsRoot = resolve(rawRoot, "attempts");
const bundleRoot = resolve(rawRoot, "synthetic-bundle");
const sourceBundle = resolve(root, "test", "fixtures", "ms3-bundle");
const graderPath = resolve(root, "test", "fixtures", "mock-grader.mjs");
const runnerConfig = JSON.parse(await readFile(resolve(root, "config", "tasks.runner.public.json"), "utf8"));

assertWithin(resolve(root, "artifacts", "raw"), rawRoot);
await rm(rawRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
await mkdir(attemptsRoot, { recursive: true });
await copyCleanTree(sourceBundle, bundleRoot);

const promptSha256 = sha256("Synthetic offline control task v1\n");
const graderSha256 = await sha256File(graderPath);
const task = {
  id: "CONTROL",
  preFixSha: "synthetic-ms3-fixture-v1",
  promptSha256,
  deadlineMinutes: 1,
  allowedProductionPaths: ["src/**"],
};
const model = { id: "mock-agent", revision: "offline-control-v1" };
const scenarios = [
  ["valid", "normal"],
  ["failing", "normal"],
  ["noop", "normal"],
  ["timeout", "normal"],
  ["canceled", "normal"],
  ["malformed", "normal"],
  ["agent-error", "normal"],
  ["scope-violation", "normal"],
  ["evaluator-failure", "infra-error"],
  ["isolation-probe", "normal"],
];

process.env.KILN_BENCHMARK_SECRET = "MS3-HOST-SECRET-MUST-NOT-CROSS";
const results = [];
for (const [scenario, graderMode] of scenarios) {
  const actualAgentScenario = scenario === "evaluator-failure" ? "valid" : scenario;
  const timeoutMs = scenario === "timeout" ? 500 : 10_000;
  results.push(await runAttempt({
    experimentId,
    runId: `control-${scenario}`,
    task,
    model,
    bundleRoot,
    attemptsRoot,
    agent: {
      backend: "wsl-unshare",
      command: "/bin/bash",
      args: [".benchmark/mock-agent.sh", actualAgentScenario, `kiln-ms3-${scenario}-descendant`],
      protocol: "jsonl",
      timeoutMs,
      distribution: "Ubuntu-24.04",
    },
    grader: { command: process.execPath, args: [graderPath, graderMode], timeoutMs: 10_000, sha256: graderSha256 },
    alwaysForbiddenPaths: runnerConfig.alwaysForbiddenPaths,
    forbiddenTokens: ["evaluator-private", "reference-fix-secret"],
    budget: { ceilingUsd: 0, estimatedUsd: 0 },
  }));
}
delete process.env.KILN_BENCHMARK_SECRET;

const expected = {
  valid: "passed",
  failing: "failed_tests",
  noop: "failed_tests",
  timeout: "timeout",
  canceled: "canceled",
  malformed: "agent_error",
  "agent-error": "agent_error",
  "scope-violation": "policy_violation",
  "evaluator-failure": "infra_error",
  "isolation-probe": "failed_tests",
};
const mismatches = results.flatMap((result) => {
  const scenario = result.runId.replace(/^control-/, "");
  return result.classification === expected[scenario] ? [] : [{ scenario, expected: expected[scenario], actual: result.classification }];
});
const probeLog = await readFile(resolve(attemptsRoot, "control-isolation-probe", "agent.stdout.log"), "utf8");
const isolationProbe = JSON.parse(probeLog.trim());
const isolationPassed = isolationProbe.windowsDriveVisible === false && isolationProbe.networkReachable === false && isolationProbe.hostSecretVisible === false;
const timeoutWorkspace = resolve(attemptsRoot, "control-timeout", "agent-workspace");
await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_500));
let descendantSurvived = false;
try {
  const marker = await readFile(resolve(timeoutWorkspace, "descendant-survived"), "utf8");
  descendantSurvived = Boolean(marker);
} catch {}

const publicEvidence = {
  schemaVersion: 1,
  experimentId,
  executedAt: new Date().toISOString(),
  runner: { os: "Windows 11", isolationBackend: "WSL2 unshare", distribution: "Ubuntu-24.04" },
  spend: { runpodProvisioned: false, runpodCreditsUsed: 0 },
  summary: summarizeResults(results),
  expectedClassifications: expected,
  observedClassifications: Object.fromEntries(results.map((result) => [result.runId.replace(/^control-/, ""), result.classification])),
  isolationProbe,
  descendantSurvived,
  mismatches,
  status: mismatches.length === 0 && isolationPassed && !descendantSurvived ? "passed" : "failed",
};
await writeJson(resolve(root, "evidence", "ms3-results.json"), publicEvidence);
const markdown = renderMarkdown({
  title: "MS3 — offline harness dry run",
  results,
  controls: [
    "Valid, invalid, no-op, timeout, cancellation, malformed-output, agent-error, policy-violation, and evaluator-infrastructure paths were classified independently.",
    `The WSL2 namespace probe reported Windows drive visible=${isolationProbe.windowsDriveVisible}, network reachable=${isolationProbe.networkReachable}, and host secret visible=${isolationProbe.hostSecretVisible}.`,
    `Timed-out descendant survived=${descendantSurvived}.`,
    "Every agent attempt began from a fresh synthetic source bundle and was graded in a separate clean workspace.",
    "Raw stdout, stderr, candidate workspaces, and grader workspaces remain under ignored local artifacts.",
  ],
  limitations: [
    "This rehearsal used a synthetic controllable agent, not Qwen, Muse, Gemma, Pi, vLLM, or a paid API.",
    "The paid backend remains disabled until a RunPod/RHEL sandbox can expose only its selected local vLLM endpoint and an explicit MS4 authorization is recorded.",
    "Windows-native M1 grading remains a host-side trusted evaluator step after patch transfer.",
  ],
});
await writeFile(resolve(root, "reports", "MS3-OFFLINE-DRY-RUN.md"), markdown, "utf8");
console.log(JSON.stringify(publicEvidence, null, 2));
if (publicEvidence.status !== "passed") process.exitCode = 1;
