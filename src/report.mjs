import { writeFile } from "node:fs/promises";

export function summarizeResults(results) {
  const counts = Object.fromEntries([...new Set(results.map((result) => result.classification))].sort().map((name) => [name, results.filter((result) => result.classification === name).length]));
  return {
    total: results.length,
    counts,
    wallSeconds: Number(results.reduce((sum, result) => sum + result.wallSeconds, 0).toFixed(3)),
    estimatedUsd: Number(results.reduce((sum, result) => sum + Number(result.cost?.estimatedUsd ?? 0), 0).toFixed(4)),
  };
}

export function renderMarkdown({ title, results, controls = [], limitations = [] }) {
  const summary = summarizeResults(results);
  const rows = results.map((result) => `| ${result.runId} | ${result.taskId} | ${result.modelId} | \`${result.classification}\` | ${result.wallSeconds.toFixed(3)} | ${result.agent.changedFiles.length} |`).join("\n");
  return `# ${title}\n\n` +
    `Runs: **${summary.total}** · Wall time: **${summary.wallSeconds}s** · RunPod spend: **$${summary.estimatedUsd.toFixed(2)}**\n\n` +
    `| Run | Task | Adapter | Classification | Seconds | Changed files |\n| --- | --- | --- | --- | ---: | ---: |\n${rows}\n\n` +
    `## Controls demonstrated\n\n${controls.map((item) => `- ${item}`).join("\n")}\n\n` +
    `## Limitations and next gate\n\n${limitations.map((item) => `- ${item}`).join("\n")}\n`;
}

export async function writeMarkdownReport(path, options) {
  await writeFile(path, renderMarkdown(options), "utf8");
}
