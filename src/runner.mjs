import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { applyChanges, copyCleanTree, diffManifests, sha256, treeDigest, writeJson } from "./fs-tree.mjs";
import { runDirectAgent, runWslOfflineAgent } from "./isolation.mjs";
import { validateChangeScope, scanAgentTree } from "./policy.mjs";
import { parseJsonLines, runBounded } from "./process.mjs";

const now = () => new Date().toISOString();

async function saveText(path, value) {
  await writeFile(path, value ?? "", "utf8");
}

function protocolSummary(protocol, stdout) {
  if (protocol !== "jsonl") return { ok: true, events: [], tokens: {} };
  try {
    const events = parseJsonLines(stdout);
    if (events.length === 0) return { ok: false, error: "agent emitted no JSONL events", events: [], tokens: {} };
    const tokens = events.reduce((total, event) => ({
      input: total.input + Number(event?.usage?.input_tokens ?? event?.usage?.input ?? 0),
      output: total.output + Number(event?.usage?.output_tokens ?? event?.usage?.output ?? 0),
      reasoning: total.reasoning + Number(event?.usage?.reasoning_tokens ?? event?.usage?.reasoning ?? 0),
    }), { input: 0, output: 0, reasoning: 0 });
    const toolCalls = events.filter((event) => /tool.*call/i.test(String(event?.type ?? ""))).length;
    return { ok: true, events, tokens: { ...tokens, toolCalls } };
  } catch (error) {
    return { ok: false, error: `malformed JSONL: ${error.message}`, events: [], tokens: {} };
  }
}

export async function runAttempt({
  experimentId,
  runId,
  task,
  model,
  bundleRoot,
  attemptsRoot,
  agent,
  grader,
  alwaysForbiddenPaths = [],
  forbiddenTokens = [],
  budget = { ceilingUsd: 0, estimatedUsd: 0 },
}) {
  const startedAt = now();
  const started = Date.now();
  const runRoot = resolve(attemptsRoot, runId);
  const workspace = resolve(runRoot, "agent-workspace");
  const gradeRoot = resolve(runRoot, "grader-workspace");
  await mkdir(runRoot, { recursive: false });
  await copyCleanTree(bundleRoot, workspace);
  const baseline = await treeDigest(workspace, { ignoreNames: new Set(["node_modules"]) });

  let agentResult;
  try {
    const request = { ...agent, workspace, runRoot, timeoutMs: agent.timeoutMs ?? task.deadlineMinutes * 60_000 };
    agentResult = agent.backend === "wsl-unshare"
      ? await runWslOfflineAgent(request)
      : await runDirectAgent(request);
  } catch (error) {
    agentResult = { code: null, signal: null, timedOut: false, canceled: false, wallMs: Date.now() - started, stdout: "", stderr: String(error), launchError: true };
  }
  await saveText(resolve(runRoot, "agent.stdout.log"), agentResult.stdout);
  await saveText(resolve(runRoot, "agent.stderr.log"), agentResult.stderr);

  let after = baseline;
  let changes = [];
  let treeViolations = [];
  try {
    after = await treeDigest(workspace, { ignoreNames: new Set(["node_modules"]) });
    changes = diffManifests(baseline, after);
    treeViolations = await scanAgentTree(workspace, { forbiddenTokens });
  } catch (error) {
    treeViolations = [{ path: null, reason: "invalid_workspace_tree", detail: error.message }];
  }
  if (agentResult.sandboxPolicyViolation) {
    treeViolations.push({ path: null, reason: "unsafe_sandbox_archive", detail: agentResult.sandboxPolicyViolation });
  }
  const patchSha256 = changes.length ? sha256(JSON.stringify(changes)) : null;
  await writeJson(resolve(runRoot, "changes.json"), changes);
  const protocol = protocolSummary(agent.protocol, agentResult.stdout);
  const scopeViolations = validateChangeScope(changes, {
    allowed: task.allowedProductionPaths,
    forbidden: alwaysForbiddenPaths,
  });

  let classification;
  let grading = { status: "not_run", exitCode: null, targeted: null, regressions: null };
  if (agentResult.timedOut) classification = "timeout";
  else if (agentResult.canceled || agentResult.code === 130) classification = "canceled";
  else if (agentResult.launchError || !protocol.ok || agentResult.code !== 0) classification = "agent_error";
  else if (treeViolations.length || scopeViolations.length) classification = "policy_violation";
  else {
    try {
      await applyChanges(bundleRoot, workspace, gradeRoot, changes);
      if (grader.prepare) {
        const prepared = await runBounded(grader.prepare.command, grader.prepare.args ?? [], {
          cwd: gradeRoot,
          env: { ...process.env, KILN_BENCHMARK_GRADE_ROOT: gradeRoot },
          timeoutMs: grader.prepare.timeoutMs ?? 300_000,
        });
        await saveText(resolve(runRoot, "grader.prepare.stdout.log"), prepared.stdout);
        await saveText(resolve(runRoot, "grader.prepare.stderr.log"), prepared.stderr);
        if (prepared.code !== 0 || prepared.timedOut) {
          grading = { status: "infrastructure_error", exitCode: prepared.code, phase: "prepare", targeted: null, regressions: null };
          throw Object.assign(new Error("grader preparation failed"), { gradingHandled: true });
        }
      }
      const gradeResult = await runBounded(grader.command, grader.args ?? [], {
        cwd: gradeRoot,
        env: { ...process.env, KILN_BENCHMARK_GRADE_ROOT: gradeRoot },
        timeoutMs: grader.timeoutMs ?? 120_000,
      });
      await saveText(resolve(runRoot, "grader.stdout.log"), gradeResult.stdout);
      await saveText(resolve(runRoot, "grader.stderr.log"), gradeResult.stderr);
      grading = {
        status: gradeResult.code === 0 ? "passed" : gradeResult.code === 1 ? "failed" : "infrastructure_error",
        exitCode: gradeResult.code,
        timedOut: gradeResult.timedOut,
        targeted: gradeResult.code === 0,
        regressions: gradeResult.code === 0,
      };
      classification = gradeResult.code === 0 ? "passed" : gradeResult.code === 1 ? "failed_tests" : "infra_error";
      if (gradeResult.timedOut) classification = "infra_error";
    } catch (error) {
      if (!error.gradingHandled) grading = { status: "infrastructure_error", exitCode: null, error: String(error), targeted: null, regressions: null };
      classification = "infra_error";
    }
  }

  const result = {
    schemaVersion: 1,
    experimentId,
    runId,
    taskId: task.id,
    modelId: model.id,
    classification,
    startedAt,
    finishedAt: now(),
    wallSeconds: Number(((Date.now() - started) / 1000).toFixed(3)),
    sourceSha: task.preFixSha,
    modelRevision: model.revision ?? null,
    promptSha256: task.promptSha256,
    graderSha256: grader.sha256,
    patchSha256,
    agent: {
      backend: agent.backend,
      protocol: agent.protocol,
      exitCode: agentResult.code,
      signal: agentResult.signal,
      timedOut: agentResult.timedOut,
      canceled: agentResult.canceled,
      protocolValid: protocol.ok,
      protocolError: protocol.error ?? null,
      changedFiles: changes,
      scopeViolations,
      treeViolations,
    },
    grading,
    tokens: protocol.tokens,
    telemetry: { gpu: null, note: "offline mock; GPU telemetry absent" },
    cost: {
      estimatedUsd: budget.estimatedUsd ?? 0,
      ceilingUsd: budget.ceilingUsd ?? 0,
      currency: "USD",
      runpodProvisioned: false,
    },
  };
  await writeJson(resolve(runRoot, "result.json"), result);
  return result;
}

export async function loadJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
