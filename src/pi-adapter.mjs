import { readFile } from "node:fs/promises";

export function buildNineRunPlan(tasks, models) {
  if (tasks.length !== 3 || models.length !== 3) throw new Error("the initial pilot must contain exactly three tasks and three models");
  const runs = [];
  for (const task of tasks) {
    for (const model of models) {
      runs.push({
        runId: `${task.id.toLowerCase()}-${model.id}`,
        taskId: task.id,
        modelId: model.id,
        gpu: model.gpu,
        deadlineMinutes: task.deadlineMinutes,
      });
    }
  }
  return runs;
}

export function buildPiInvocation({ piPath, model, prompt }) {
  if (!piPath || !model?.provider || !model?.repository || !prompt) throw new Error("Pi invocation is missing a required pinned input");
  const args = [
    "--offline",
    "--provider", model.provider,
    "--model", model.repository,
    "--thinking", model.thinking ?? "off",
    "--mode", "json",
    "--print",
    "--no-session",
    "--approve",
    "--tools", "read,bash,edit,write",
  ];
  if (model.systemPromptSuffix) args.push("--append-system-prompt", model.systemPromptSuffix);
  args.push(prompt);
  return {
    command: piPath,
    args,
    protocol: "jsonl",
    environment: {
      PI_OFFLINE: "1",
      VLLM_API_KEY: "local-vllm",
    },
  };
}

export function reserveBudget({ ceilingUsd, spentUsd = 0, requestedUsd }) {
  for (const [name, value] of Object.entries({ ceilingUsd, spentUsd, requestedUsd })) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative finite number`);
  }
  if (spentUsd + requestedUsd > ceilingUsd) {
    throw new Error(`budget ceiling exceeded: $${spentUsd.toFixed(2)} + $${requestedUsd.toFixed(2)} > $${ceilingUsd.toFixed(2)}`);
  }
  return { ceilingUsd, spentUsd, reservedUsd: requestedUsd, remainingUsd: ceilingUsd - spentUsd - requestedUsd };
}

export async function assertPilotAuthorization(path, { experimentId, tasks, models, maxBudgetUsd }) {
  let authorization;
  try {
    authorization = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("MS4 authorization record is absent or unreadable; paid execution is disabled");
  }
  if (authorization.experimentId !== experimentId) throw new Error("authorization experiment does not match");
  if (authorization.status !== "approved") throw new Error("authorization is not approved");
  if (authorization.maxBudgetUsd < maxBudgetUsd) throw new Error("requested budget exceeds the approved maximum");
  const expectedTasks = [...tasks].sort().join(",");
  const expectedModels = [...models].sort().join(",");
  if ([...authorization.tasks].sort().join(",") !== expectedTasks) throw new Error("authorized tasks do not match");
  if ([...authorization.models].sort().join(",") !== expectedModels) throw new Error("authorized models do not match");
  if (!authorization.infrastructure?.provider || !authorization.infrastructure?.imageDigest) throw new Error("provider and immutable image digest must be authorized");
  return authorization;
}

export async function checkVllmReadiness(models, { fetchImpl = fetch, timeoutMs = 5_000 } = {}) {
  const checks = [];
  for (const model of models) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const health = new URL(model.endpoint);
      health.pathname = "/health";
      const response = await fetchImpl(health, { signal: controller.signal });
      checks.push({ modelId: model.id, ok: response.ok, status: response.status });
    } catch (error) {
      checks.push({ modelId: model.id, ok: false, error: error.name === "AbortError" ? "timeout" : error.message });
    } finally {
      clearTimeout(timer);
    }
  }
  return { ready: checks.every((check) => check.ok), checks };
}
