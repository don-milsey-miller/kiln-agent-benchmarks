import { cp, lstat, mkdir, readFile, readdir, rm, symlink } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { applyChanges, diffManifests, sha256File, treeDigest, writeJson } from "../src/fs-tree.mjs";
import { validateChangeScope } from "../src/policy.mjs";
import { parseJsonLines, runBounded } from "../src/process.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const rawRoot = resolve(process.argv[2] ?? resolve(root, "artifacts/raw/ms4-pilot-20261022"));
const attemptsRoot = resolve(root, "artifacts/runs/ms4-pilot-20261022");
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const tasksManifest = await readJson(resolve(root, "manifests/tasks.public.json"));
const runnerConfig = await readJson(resolve(root, "config/tasks.runner.public.json"));
const modelConfig = await readJson(resolve(root, "config/models.public.json"));
const privateManifest = await readJson(resolve(root, "artifacts/private/evaluator-manifest.json"));
let podMetadata = {};
try { podMetadata = await readJson(resolve(root, "artifacts/private/ms4-pod.json")); } catch {}

const tasks = new Map(tasksManifest.tasks.map((task) => [task.id, task]));
const models = new Map(modelConfig.models.map((model) => [model.id, model]));
const dependencySnapshots = {
  S1: resolve(root, ".work/snapshots/s1r-pre/node_modules"),
  M1: resolve(root, ".work/snapshots/m1-pre/node_modules"),
  L1: resolve(root, ".work/snapshots/l1-pre/node_modules"),
};

function summarizeProtocol(text) {
  try {
    const events = parseJsonLines(text);
    if (!events.length) return { ok: false, error: "agent emitted no JSONL events", tokens: {} };
    const assistantMessages = events
      .filter((event) => event?.type === "message_end" && event?.message?.role === "assistant")
      .map((event) => event.message);
    if (!assistantMessages.length) return { ok: false, error: "agent emitted no completed assistant messages", tokens: {} };
    const tokens = assistantMessages.reduce((total, message) => {
      const usage = message.usage ?? {};
      const content = Array.isArray(message.content) ? message.content : [];
      return {
        input: total.input + Number(usage.input_tokens ?? usage.input ?? 0),
        output: total.output + Number(usage.output_tokens ?? usage.output ?? 0),
        reasoning: total.reasoning + Number(usage.reasoning_tokens ?? usage.reasoning ?? 0),
        cacheRead: total.cacheRead + Number(usage.cache_read_tokens ?? usage.cacheRead ?? 0),
        cacheWrite: total.cacheWrite + Number(usage.cache_write_tokens ?? usage.cacheWrite ?? 0),
        toolCalls: total.toolCalls + content.filter((block) => /tool.?call/i.test(String(block?.type ?? ""))).length,
      };
    }, { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, toolCalls: 0 });
    const inferenceErrors = assistantMessages.filter((message) => message.stopReason === "error").length;
    return { ok: inferenceErrors === 0, eventCount: events.length, assistantMessages: assistantMessages.length, inferenceErrors, tokens,
      error: inferenceErrors ? `${inferenceErrors} assistant inference error(s)` : undefined };
  } catch (error) {
    return { ok: false, error: `malformed JSONL: ${error.message}`, tokens: {} };
  }
}

async function summarizeTelemetry(path) {
  let text;
  try { text = await readFile(path, "utf8"); } catch { return []; }
  const samples = text.split(/\r?\n/).filter(Boolean).map((line) => {
    const fields = line.split(",").map((field) => field.trim());
    return {
      timestamp: fields[0], gpu: Number(fields[1]), name: fields[2], utilizationPercent: Number(fields[3]),
      memoryMiB: Number(fields[4]), temperatureC: Number(fields[5]), powerW: Number(fields[6]),
    };
  }).filter((sample) => Number.isInteger(sample.gpu) && Number.isFinite(sample.utilizationPercent));
  const average = (values) => values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2)) : null;
  return [...new Set(samples.map((sample) => sample.gpu))].sort().map((gpu) => {
    const group = samples.filter((sample) => sample.gpu === gpu);
    const values = (key) => group.map((sample) => sample[key]).filter(Number.isFinite);
    return {
      gpu,
      modelId: modelConfig.models.find((model) => model.gpu === gpu)?.id ?? null,
      name: group[0]?.name ?? null,
      sampleCount: group.length,
      firstAt: group[0]?.timestamp ?? null,
      lastAt: group.at(-1)?.timestamp ?? null,
      averageUtilizationPercent: average(values("utilizationPercent")),
      peakUtilizationPercent: Math.max(...values("utilizationPercent")),
      averageMemoryMiB: average(values("memoryMiB")),
      peakMemoryMiB: Math.max(...values("memoryMiB")),
      averageTemperatureC: average(values("temperatureC")),
      peakTemperatureC: Math.max(...values("temperatureC")),
      averagePowerW: average(values("powerW")),
      peakPowerW: Math.max(...values("powerW")),
    };
  });
}

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

function barChart(title, items, { value = (item) => item.value, label = (item) => item.label, format = (number) => String(number), ceiling } = {}) {
  const maximum = ceiling ?? Math.max(1, ...items.map(value));
  const rows = items.map((item) => {
    const amount = value(item);
    const width = Math.max(0, Math.min(100, amount / maximum * 100));
    return `<div class="bar-row"><span class="bar-label">${escapeHtml(label(item))}</span><span class="bar-track"><span class="bar-fill" style="width:${width.toFixed(2)}%"></span></span><strong>${escapeHtml(format(amount))}</strong></div>`;
  }).join("");
  return `<section class="panel chart"><h2>${escapeHtml(title)}</h2>${rows}</section>`;
}

function removeArchiveEncodingAliases(changes) {
  const skeleton = (path) => path.replace(/[^\x20-\x7e]+/g, "<unicode>");
  const ignored = new Set();
  const aliases = [];
  for (let index = 0; index < changes.length; index += 1) {
    const left = changes[index];
    if (ignored.has(index) || !/[^\x00-]/.test(left.path) || !["added", "deleted"].includes(left.change)) continue;
    const match = changes.findIndex((right, candidateIndex) => candidateIndex !== index && !ignored.has(candidateIndex)
      && right.change !== left.change && ["added", "deleted"].includes(right.change)
      && right.sha256 === left.sha256 && /[^\x00-]/.test(right.path)
      && skeleton(right.path) === skeleton(left.path));
    if (match < 0) continue;
    ignored.add(index);
    ignored.add(match);
    aliases.push({ paths: [left.path, changes[match].path].sort(), sha256: left.sha256, reason: "cross-platform archive filename decoding" });
  }
  return { changes: changes.filter((_, index) => !ignored.has(index)), aliases };
}

async function extractCandidate(archive, destination) {
  await rm(destination, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  await mkdir(destination, { recursive: true });
  const [names, verbose] = await Promise.all([
    runBounded("tar.exe", ["-tf", archive], { timeoutMs: 60_000 }),
    runBounded("tar.exe", ["-tvf", archive], { timeoutMs: 60_000 }),
  ]);
  if (names.code !== 0 || verbose.code !== 0) throw new Error("candidate archive inspection failed");
  const unsafeName = names.stdout.split(/\r?\n/).filter(Boolean).find((value) => {
    const path = value.replaceAll("\\", "/").replace(/^\.\//, "");
    return path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.split("/").includes("..");
  });
  const unsafeType = verbose.stdout.split(/\r?\n/).filter(Boolean).find((line) => /^[lh]/.test(line));
  if (unsafeName || unsafeType) throw new Error(unsafeName ? `unsafe archive path: ${unsafeName}` : "candidate archive contains a link");
  const extract = await runBounded("tar.exe", ["-xf", archive, "-C", destination], { timeoutMs: 120_000 });
  if (extract.code !== 0) throw new Error(`candidate archive extraction failed: ${extract.stderr}`);
}

async function grade(taskId, gradeRoot, runRoot) {
  const dependencyRoot = dependencySnapshots[taskId];
  const dependencyStat = await lstat(dependencyRoot);
  if (!dependencyStat.isDirectory()) throw new Error(`dependency snapshot missing for ${taskId}`);
  const gitCommands = [
    ["init", "-q"],
    ["add", "-A"],
    ["-c", "user.name=Kiln Benchmark", "-c", "user.email=benchmark@kiln.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "candidate snapshot"],
  ];
  for (const args of gitCommands) {
    const git = await runBounded("git", args, { cwd: gradeRoot, timeoutMs: 120_000 });
    if (git.code !== 0) throw new Error(`grader snapshot git ${args[0]} failed: ${git.stderr || git.stdout}`);
  }
  await symlink(dependencyRoot, resolve(gradeRoot, "node_modules"), "junction");
  const result = await runBounded(process.execPath, [resolve(root, "evaluator-private/grade-task.mjs"), taskId, gradeRoot], {
    cwd: root,
    timeoutMs: 15 * 60_000,
    env: { ...process.env, KILN_BENCHMARK_GRADE_ROOT: gradeRoot },
    maxOutputBytes: 16 * 1024 * 1024,
  });
  const parsed = (() => {
    try { return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)); } catch { return null; }
  })();
  return {
    exitCode: result.code,
    timedOut: result.timedOut,
    status: result.code === 0 ? "passed" : result.code === 1 ? "failed_tests" : "infrastructure_error",
    targeted: parsed?.targeted ?? null,
    regressions: parsed?.regressions ?? null,
    wallSeconds: Number((result.wallMs / 1000).toFixed(3)),
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

await rm(attemptsRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
await mkdir(attemptsRoot, { recursive: true });
const runNames = (await readdir(resolve(rawRoot, "runs"), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const expectedRunNames = [...tasks.keys()].flatMap((taskId) => [...models.keys()].map((modelId) => `${taskId.toLowerCase()}-${modelId}`)).sort();
if (JSON.stringify(runNames) !== JSON.stringify(expectedRunNames)) {
  throw new Error(`expected exactly ${expectedRunNames.join(", ")}; received ${runNames.join(", ")}`);
}
const results = [];

for (const runName of runNames) {
  const remoteRoot = resolve(rawRoot, "runs", runName);
  const remote = await readJson(resolve(remoteRoot, "remote.json"));
  const task = tasks.get(remote.taskId);
  const model = models.get(remote.modelId);
  if (!task || !model || runName !== remote.runId) throw new Error(`unexpected remote run metadata: ${runName}`);
  const runRoot = resolve(attemptsRoot, runName);
  const candidateRoot = resolve(runRoot, "candidate");
  const gradeRoot = resolve(runRoot, "grader-workspace");
  await mkdir(runRoot, { recursive: true });
  await extractCandidate(resolve(remoteRoot, "workspace.tar.gz"), candidateRoot);
  const [baseline, candidate] = await Promise.all([
    treeDigest(resolve(root, "artifacts/private/bundles", task.id), { ignoreNames: new Set(["node_modules", ".git"]) }),
    treeDigest(candidateRoot, { ignoreNames: new Set(["node_modules", ".git"]) }),
  ]);
  const rawChanges = diffManifests(baseline, candidate);
  const { changes, aliases: ignoredTransportAliases } = removeArchiveEncodingAliases(rawChanges);
  const scopeViolations = validateChangeScope(changes, {
    allowed: runnerConfig.tasks[task.id].allowedProductionPaths,
    forbidden: runnerConfig.alwaysForbiddenPaths,
  });
  const protocol = summarizeProtocol(await readFile(resolve(remoteRoot, "agent.jsonl"), "utf8"));
  const agentExitCode = Number(remote.agentExitCode);
  let classification;
  let grading = { status: "not_run", targeted: null, regressions: null, exitCode: null };
  const timedOut = agentExitCode === 124 || agentExitCode === 137;
  if ((!timedOut && agentExitCode !== 0) || !protocol.ok) classification = "agent_error";
  else if (scopeViolations.length) classification = "policy_violation";
  else {
    await applyChanges(resolve(root, "artifacts/private/bundles", task.id), candidateRoot, gradeRoot, changes);
    try {
      const outcome = await grade(task.id, gradeRoot, runRoot);
      await Promise.all([
        cp(resolve(remoteRoot, "candidate.patch"), resolve(runRoot, "candidate.patch")),
        cp(resolve(remoteRoot, "status.txt"), resolve(runRoot, "status.txt")),
      ]);
      await Promise.all([
        import("node:fs/promises").then(({ writeFile }) => writeFile(resolve(runRoot, "grader.stdout.log"), outcome.stdout)),
        import("node:fs/promises").then(({ writeFile }) => writeFile(resolve(runRoot, "grader.stderr.log"), outcome.stderr)),
      ]);
      grading = { status: outcome.status, targeted: outcome.targeted, regressions: outcome.regressions, exitCode: outcome.exitCode, timedOut: outcome.timedOut, wallSeconds: outcome.wallSeconds };
      classification = timedOut ? "timeout" : outcome.status === "passed" ? "passed" : outcome.status === "failed_tests" ? "failed_tests" : "infra_error";
    } catch (error) {
      grading = { status: "infrastructure_error", targeted: null, regressions: null, exitCode: null, error: String(error) };
      classification = "infra_error";
    }
  }
  const started = Date.parse(remote.startedAt);
  const finished = Date.parse(remote.finishedAt);
  const wallSeconds = Number(((finished - started) / 1000).toFixed(3));
  const patchSha256 = changes.length ? await sha256File(resolve(remoteRoot, "candidate.patch")) : null;
  const result = {
    schemaVersion: 1,
    experimentId: "ms4-pilot-20261022",
    runId: runName,
    taskId: task.id,
    modelId: model.id,
    classification,
    startedAt: remote.startedAt,
    finishedAt: remote.finishedAt,
    wallSeconds,
    sourceSha: task.preFixSha,
    modelRevision: model.revision,
    promptSha256: task.promptSha256,
    graderSha256: task.graderSha256,
    patchSha256,
    agent: { backend: "runpod-rhel-seccomp-unix", protocol: "jsonl", exitCode: agentExitCode, timedOut, protocolValid: protocol.ok, protocolError: protocol.error ?? null, eventCount: protocol.eventCount ?? null, assistantMessages: protocol.assistantMessages ?? null, inferenceErrors: protocol.inferenceErrors ?? null, changedFiles: changes, ignoredTransportAliases, scopeViolations },
    grading,
    tokens: protocol.tokens,
    telemetry: { gpu: model.gpu, source: "telemetry/nvidia-smi.csv" },
    cost: { estimatedUsd: Number((wallSeconds * 2.49 / 3600).toFixed(4)), ceilingUsd: 50, currency: "USD", runpodProvisioned: true },
  };
  await writeJson(resolve(runRoot, "result.json"), result);
  results.push(result);
}

const counts = Object.fromEntries(["passed", "failed_tests", "timeout", "agent_error", "infra_error", "policy_violation"].map((key) => [key, results.filter((result) => result.classification === key).length]));
const gpuHours = results.reduce((sum, result) => sum + result.wallSeconds, 0) / 3600;
const telemetrySummary = await summarizeTelemetry(resolve(rawRoot, "telemetry/nvidia-smi.csv"));
const evidence = {
  schemaVersion: 1,
  experimentId: "ms4-pilot-20261022",
  capturedAt: new Date().toISOString(),
  status: results.length === 9 ? "completed" : "partial",
  runCount: results.length,
  counts,
  validatedSuccessesPerGpuHour: gpuHours ? Number((counts.passed / gpuHours).toFixed(4)) : null,
  gpuHours: Number(gpuHours.toFixed(4)),
  billed: {
    podId: podMetadata.id ?? null,
    hourlyRateUsd: podMetadata.costPerHour ?? 7.47,
    actualUsd: podMetadata.actualSpendUsd ?? null,
    startedAt: podMetadata.startedAt ?? null,
    terminatedAt: podMetadata.terminatedAt ?? null,
    terminalStateVerified: podMetadata.terminalStateVerified ?? false,
  },
  isolation: { attested: true, backend: "seccomp AF_UNIX-only socket filter plus group-scoped model relay", evidencePath: "artifacts/raw/ms4-pilot-20261022/config" },
  telemetrySummary,
  results,
};
await writeJson(resolve(root, "evidence/ms4-results.json"), evidence);
const rows = results.map((result) => `| ${result.runId} | ${result.taskId} | ${result.modelId} | \`${result.classification}\` | ${result.wallSeconds.toFixed(1)} | ${result.agent.changedFiles.length} | ${result.grading.targeted ?? "—"} | ${result.grading.regressions ?? "—"} |`).join("\n");
const markdown = `# MS4 — nine-run paid pilot\n\n` +
  `Experiment: \`ms4-pilot-20261022\` · Runs: **${results.length}/9** · Passed: **${counts.passed}** · GPU-hours: **${evidence.gpuHours.toFixed(2)}** · Billed cost: **${evidence.billed.actualUsd == null ? "pending provider finalization" : `$${evidence.billed.actualUsd.toFixed(2)}`}**\n\n` +
  `| Run | Task | Model | Classification | Agent seconds | Changed files | Targeted | Regressions |\n| --- | --- | --- | --- | ---: | ---: | --- | --- |\n${rows}\n\n` +
  `## Controls\n\n- Every attempt used a fresh history-stripped task tree and unique unprivileged identity.\n- The paid sandbox admitted only the assigned vLLM endpoint through a Unix-socket relay; external network, direct host loopback, sibling model sockets, and root SSH material were blocked before execution.\n- Graders and reference fixes remained on the trusted Windows host. M1 was graded natively on Windows.\n- The pod was capped at $50 and all candidate changes were scope-checked before grading.\n\n` +
  `## Interpretation limit\n\nThis one-run-per-model-per-task pilot is diagnostic. It does not establish a statistically reliable model ranking, and public-history training contamination cannot be excluded.\n`;
await import("node:fs/promises").then(({ writeFile }) => writeFile(resolve(root, "reports/MS4-PAID-PILOT.md"), markdown));

const modelSummaries = modelConfig.models.map((model) => {
  const modelResults = results.filter((result) => result.modelId === model.id);
  return {
    id: model.id,
    passed: modelResults.filter((result) => result.classification === "passed").length,
    total: modelResults.length,
    wallMinutes: modelResults.reduce((sum, result) => sum + result.wallSeconds, 0) / 60,
    outputTokens: modelResults.reduce((sum, result) => sum + Number(result.tokens.output ?? 0), 0),
    toolCalls: modelResults.reduce((sum, result) => sum + Number(result.tokens.toolCalls ?? 0), 0),
  };
});
const outcomeChart = barChart("Outcome distribution", Object.entries(counts).map(([label, value]) => ({ label, value })), { ceiling: 9 });
const durationChart = barChart("Agent wall time by run", results, {
  value: (result) => result.wallSeconds / 60,
  label: (result) => result.runId,
  format: (number) => `${number.toFixed(1)} min`,
});
const tokenChart = barChart("Output-token diagnostics", results, {
  value: (result) => Number(result.tokens.output ?? 0),
  label: (result) => result.runId,
  format: (number) => Math.round(number).toLocaleString("en-US"),
});
const utilizationChart = barChart("Average GPU utilization", telemetrySummary, {
  value: (gpu) => Number(gpu.averageUtilizationPercent ?? 0),
  label: (gpu) => `GPU ${gpu.gpu} · ${gpu.modelId}`,
  format: (number) => `${number.toFixed(1)}%`,
  ceiling: 100,
});
const resultRows = results.map((result) => `<tr><td>${escapeHtml(result.runId)}</td><td>${escapeHtml(result.modelId)}</td><td>${escapeHtml(result.taskId)}</td><td><span class="status ${escapeHtml(result.classification)}">${escapeHtml(result.classification)}</span></td><td>${(result.wallSeconds / 60).toFixed(2)}</td><td>${result.tokens.output.toLocaleString("en-US")}</td><td>${result.tokens.toolCalls}</td><td>${result.agent.changedFiles.length}</td><td>${escapeHtml(result.grading.targeted == null ? "—" : JSON.stringify(result.grading.targeted))}</td><td>${escapeHtml(result.grading.regressions == null ? "—" : JSON.stringify(result.grading.regressions))}</td></tr>`).join("");
const modelRows = modelConfig.models.map((model) => `<tr><td>${escapeHtml(model.id)}</td><td>${escapeHtml(model.repository)}</td><td><code>${escapeHtml(model.revision)}</code></td><td>GPU ${model.gpu}</td><td>${escapeHtml(model.thinking)}</td><td>${model.mtpTokens ?? "—"}</td></tr>`).join("");
const telemetryRows = telemetrySummary.map((gpu) => `<tr><td>${gpu.gpu}</td><td>${escapeHtml(gpu.modelId)}</td><td>${gpu.sampleCount}</td><td>${gpu.averageUtilizationPercent?.toFixed(2) ?? "—"}% / ${gpu.peakUtilizationPercent?.toFixed(2) ?? "—"}%</td><td>${gpu.averageMemoryMiB?.toFixed(0) ?? "—"} / ${gpu.peakMemoryMiB?.toFixed(0) ?? "—"} MiB</td><td>${gpu.averageTemperatureC?.toFixed(1) ?? "—"} / ${gpu.peakTemperatureC?.toFixed(1) ?? "—"} °C</td><td>${gpu.averagePowerW?.toFixed(1) ?? "—"} / ${gpu.peakPowerW?.toFixed(1) ?? "—"} W</td></tr>`).join("");
const billedCost = evidence.billed.actualUsd == null ? "Pending provider finalization" : `$${evidence.billed.actualUsd.toFixed(2)}`;
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MS4 paid pilot · Kiln agent benchmark</title>
<style>
:root{color-scheme:dark;--bg:#08111f;--panel:#101d30;--panel2:#15243a;--text:#e8eef7;--muted:#9eb0c8;--line:#29405f;--accent:#56d6b2;--accent2:#65a9ff;--warn:#ffbd59;--bad:#ff7272}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top right,#173052 0,transparent 36%),var(--bg);color:var(--text);font:15px/1.55 system-ui,-apple-system,Segoe UI,sans-serif}main{max-width:1280px;margin:auto;padding:44px 28px 80px}h1{font-size:clamp(32px,5vw,62px);line-height:1.03;margin:10px 0 14px;letter-spacing:-.04em}h2{font-size:19px;margin:0 0 18px}h3{margin:24px 0 8px}.eyebrow{color:var(--accent);font-weight:750;letter-spacing:.16em;text-transform:uppercase}.lede{max-width:860px;color:var(--muted);font-size:18px}.grid{display:grid;gap:18px}.kpis{grid-template-columns:repeat(4,minmax(0,1fr));margin:32px 0}.two{grid-template-columns:repeat(2,minmax(0,1fr));margin:18px 0}.panel{background:linear-gradient(145deg,var(--panel2),var(--panel));border:1px solid var(--line);border-radius:18px;padding:22px;box-shadow:0 18px 50px #0004}.kpi strong{font-size:30px;display:block}.kpi span,.muted{color:var(--muted)}table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:10px 9px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{color:var(--muted);font-weight:650}.table-wrap{overflow:auto}.bar-row{display:grid;grid-template-columns:120px 1fr 86px;gap:12px;align-items:center;margin:11px 0}.bar-label{color:var(--muted);overflow:hidden;text-overflow:ellipsis}.bar-track{height:13px;background:#07101e;border-radius:99px;overflow:hidden}.bar-fill{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,var(--accent2),var(--accent))}.bar-row strong{text-align:right;font-size:12px}.status{padding:3px 8px;border-radius:999px;background:#243752}.status.passed{background:#174a3e;color:#8ff6d2}.status.timeout,.status.failed_tests{background:#59431d;color:#ffd690}.status.agent_error,.status.infra_error,.status.policy_violation{background:#592a34;color:#ffb2bd}code{color:#b9d7ff;word-break:break-all}.note{border-left:3px solid var(--accent2);padding-left:14px;color:var(--muted)}ol,ul{padding-left:22px}footer{margin-top:34px;color:var(--muted);font-size:13px}@media(max-width:850px){.kpis,.two{grid-template-columns:1fr 1fr}}@media(max-width:560px){main{padding:28px 16px}.kpis,.two{grid-template-columns:1fr}.bar-row{grid-template-columns:90px 1fr 70px}}
</style></head><body><main>
<div class="eyebrow">Kiln private coding-agent benchmark · MS4</div><h1>Nine-run paid pilot</h1>
<p class="lede">Independent, history-stripped evaluations of Qwen, Muse, and Gemma on the same three validated Kiln engineering tasks, using Pi and one Blackwell GPU per model.</p>
<div class="grid kpis"><section class="panel kpi"><strong>${counts.passed}/9</strong><span>validated passes</span></section><section class="panel kpi"><strong>${evidence.gpuHours.toFixed(2)}</strong><span>attributed GPU-hours</span></section><section class="panel kpi"><strong>${escapeHtml(billedCost)}</strong><span>full pod cost</span></section><section class="panel kpi"><strong>${evidence.validatedSuccessesPerGpuHour ?? "—"}</strong><span>passes per GPU-hour</span></section></div>
<div class="grid two">${outcomeChart}${utilizationChart}</div><div class="grid two">${durationChart}${tokenChart}</div>
<section class="panel"><h2>Scored attempts</h2><div class="table-wrap"><table><thead><tr><th>Run</th><th>Model</th><th>Task</th><th>Class</th><th>Minutes</th><th>Output tokens</th><th>Tools</th><th>Files</th><th>Targeted</th><th>Regressions</th></tr></thead><tbody>${resultRows}</tbody></table></div></section>
<div class="grid two"><section class="panel"><h2>Pinned serving stack</h2><ul><li>RHEL 10.2 UBI userland; provider host kernel recorded separately.</li><li>vLLM ${escapeHtml(modelConfig.servingProfile.vllm)}, PyTorch ${escapeHtml(modelConfig.servingProfile.torch)}, CUDA runtime ${escapeHtml(modelConfig.servingProfile.cudaRuntime)}, Pi ${escapeHtml(modelConfig.servingProfile.pi)}.</li><li>BF16 weights, FP8 KV cache, 64K context, prefix caching, 16 sequences, 16,384 batched tokens.</li><li>Image: <code>${escapeHtml(podMetadata.image ?? "unavailable")}</code></li></ul></section><section class="panel"><h2>Isolation and grading</h2><ul><li>Inherited seccomp filter denied all non-AF_UNIX socket creation.</li><li>Each identity could reach only its group-scoped Unix relay and assigned vLLM model.</li><li>Direct TCP loopback, external IPv4, sibling sockets, root SSH material, graders, and reference fixes were denied or absent.</li><li>Candidate archives were scope-checked and graded only on the trusted Windows runner; M1 remained Windows-native.</li></ul></section></div>
<section class="panel"><h2>Models and revisions</h2><div class="table-wrap"><table><thead><tr><th>ID</th><th>Repository</th><th>Revision</th><th>Assignment</th><th>Thinking</th><th>MTP tokens</th></tr></thead><tbody>${modelRows}</tbody></table></div></section>
<section class="panel"><h2>GPU telemetry</h2><div class="table-wrap"><table><thead><tr><th>GPU</th><th>Model</th><th>Samples</th><th>Util avg / peak</th><th>VRAM avg / peak</th><th>Temp avg / peak</th><th>Power avg / peak</th></tr></thead><tbody>${telemetryRows}</tbody></table></div></section>
<section class="panel"><h2>Implementation change log</h2><ol><li><strong>RHEL containerization:</strong> replaced the Ubuntu userland with a pinned RHEL 10.2 UBI image while accurately retaining the provider-managed Ubuntu host-kernel disclosure.</li><li><strong>Model loading:</strong> selected explicit safetensors prefetch for the FUSE-backed volume, cutting pathological startup behavior and making all three pinned checkpoints reproducible.</li><li><strong>Service lifecycle:</strong> moved vLLM servers into distinct process groups so restart and teardown remove engine descendants and release VRAM deterministically.</li><li><strong>Network boundary:</strong> replaced unavailable container namespace isolation with an inherited syscall filter that admits AF_UNIX only, plus per-model relays and Unix permissions.</li><li><strong>Pi compatibility:</strong> routed both bundled and unbundled OpenAI SDK paths through the constrained fetch shim, then proved real completions under the filter.</li><li><strong>Preflight:</strong> added positive Pi completion checks and negative probes for host TCP, external IPv4, non-Unix sockets, sibling model sockets, and SSH key access.</li><li><strong>Result integrity:</strong> used fresh source copies, dependency snapshots, per-run users, atomic candidate capture, exact-matrix validation, and stale-marker removal.</li></ol></section>
<section class="panel"><h2>Technical interpretation and next strategy</h2><p>Success rate is the primary outcome; throughput, tokens, and GPU metrics are diagnostics. This pilot should guide the next controlled cycle, not establish a model ranking.</p><ol><li>Repeat each task at least three times and add unpublished tasks to reduce run variance and public-history contamination.</li><li>Profile Qwen MTP-3 against a no-MTP control because the deployed backend reported a fallback in fused multi-step draft decoding; retain the faster setting only if end-to-end validated success per GPU-hour improves.</li><li>Use the utilization and power traces to tune batching only after correctness is stable; the current one-agent-per-GPU topology intentionally favors comparability over saturation.</li><li>Upstream or package the Pi Unix-transport hook so the isolation boundary does not depend on patching installed bundles.</li><li>Promote only changes that reproduce on the bare-metal RHEL target using the same image digest, model revisions, service flags, and acceptance suite.</li></ol><p class="note">Limits: one attempt per model/task, public-task contamination cannot be excluded, and RHEL describes the container userland rather than the provider-managed host kernel.</p></section>
<footer>Generated ${escapeHtml(evidence.capturedAt)} · Experiment <code>${escapeHtml(evidence.experimentId)}</code> · Pod <code>${escapeHtml(evidence.billed.podId ?? "unavailable")}</code> · Terminal shutdown verified: ${escapeHtml(evidence.billed.terminalStateVerified)}</footer>
</main></body></html>`;
await import("node:fs/promises").then(({ writeFile }) => writeFile(resolve(root, "reports/MS4-PAID-PILOT.html"), html));
console.log(JSON.stringify({ ok: true, runs: results.length, counts, gpuHours: evidence.gpuHours }));
