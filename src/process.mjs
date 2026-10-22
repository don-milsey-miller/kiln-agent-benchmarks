import { spawn, spawnSync } from "node:child_process";

function killTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  }
}

export function runBounded(command, args, {
  cwd,
  env,
  timeoutMs,
  signal,
  maxOutputBytes = 4 * 1024 * 1024,
} = {}) {
  return new Promise((resolvePromise, reject) => {
    const started = Date.now();
    const child = spawn(command, args, {
      cwd,
      env,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    let canceled = false;
    const collect = (current, chunk) => Buffer.concat([current, chunk]).subarray(-maxOutputBytes);
    child.stdout.on("data", (chunk) => { stdout = collect(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = collect(stderr, chunk); });
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs) : null;
    const abort = () => { canceled = true; killTree(child); };
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("exit", (code, exitSignal) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolvePromise({
        code,
        signal: exitSignal,
        timedOut,
        canceled,
        wallMs: Date.now() - started,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
      });
    });
  });
}

export function parseJsonLines(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  const values = [];
  for (const line of lines) values.push(JSON.parse(line));
  return values;
}
