import { access, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertWithin } from "./fs-tree.mjs";
import { runBounded } from "./process.mjs";

const scriptPath = fileURLToPath(new URL("../scripts/wsl-offline-sandbox.sh", import.meta.url));

export async function runDirectAgent({ command, args = [], workspace, timeoutMs, env = {}, signal }) {
  return runBounded(command, args, {
    cwd: workspace,
    timeoutMs,
    signal,
    env: { ...process.env, ...env },
  });
}

export async function runWslOfflineAgent({
  command,
  args = [],
  workspace,
  runRoot,
  timeoutMs,
  distribution = "Ubuntu-24.04",
}) {
  const resolvedWorkspace = assertWithin(runRoot, workspace);
  const archive = resolve(runRoot, "sandbox-return.tar");
  assertWithin(runRoot, archive);
  await rm(archive, { force: true });
  const toWslPath = async (path) => {
    const portablePath = path.replaceAll("\\", "/");
    const converted = await runBounded("wsl.exe", ["-d", distribution, "--", "wslpath", "-u", portablePath], { timeoutMs: 10_000 });
    if (converted.code !== 0) throw new Error(`wslpath failed for ${path}: ${converted.stderr}`);
    return converted.stdout.trim();
  };
  const [wslScript, wslWorkspace, wslArchive] = await Promise.all([
    toWslPath(scriptPath),
    toWslPath(resolvedWorkspace),
    toWslPath(archive),
  ]);
  const result = await runBounded(
    "wsl.exe",
    ["-d", distribution, "--", "bash", wslScript, wslWorkspace, wslArchive, String(timeoutMs), command, ...args],
    { cwd: runRoot, timeoutMs: timeoutMs + 15_000, env: process.env },
  );
  let archiveAvailable = true;
  try { await access(archive); } catch { archiveAvailable = false; }
  let sandboxPolicyViolation = null;
  if (archiveAvailable) {
    const [names, verbose] = await Promise.all([
      runBounded("tar.exe", ["-tf", archive], { timeoutMs: 30_000 }),
      runBounded("tar.exe", ["-tvf", archive], { timeoutMs: 30_000 }),
    ]);
    if (names.code !== 0 || verbose.code !== 0) throw new Error("sandbox return archive could not be inspected");
    const unsafeName = names.stdout.split(/\r?\n/).filter(Boolean).find((name) => {
      const normalized = name.replaceAll("\\", "/");
      return normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.split("/").includes("..");
    });
    const unsafeType = verbose.stdout.split(/\r?\n/).filter(Boolean).find((line) => /^[lh]/.test(line));
    if (unsafeName || unsafeType) {
      sandboxPolicyViolation = unsafeName ? `unsafe archive path: ${unsafeName}` : "symbolic and hard links are forbidden in sandbox output";
    } else {
      await rm(resolvedWorkspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      await mkdir(resolvedWorkspace, { recursive: true });
      const extract = await runBounded("tar.exe", ["-xf", archive, "-C", resolvedWorkspace], { timeoutMs: 30_000 });
      if (extract.code !== 0) throw new Error(`failed to restore sandbox workspace: ${extract.stderr}`);
    }
  }
  await rm(archive, { force: true });
  return {
    ...result,
    timedOut: result.timedOut || result.code === 124,
    canceled: result.canceled || result.code === 130,
    launchError: result.launchError || !archiveAvailable,
    sandboxPolicyViolation,
  };
}

export function assertPaidExecutionDisabled(isolationConfig) {
  if (isolationConfig?.paidBackend?.status !== "enabled") {
    throw new Error(`paid execution disabled: ${isolationConfig?.paidBackend?.reason ?? "no attested isolation backend"}`);
  }
}
