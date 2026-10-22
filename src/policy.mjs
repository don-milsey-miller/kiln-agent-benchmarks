import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { listTree } from "./fs-tree.mjs";

function escape(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

export function globMatches(path, pattern) {
  const expression = escape(pattern)
    .replace(/\*\*/g, "\0")
    .replace(/\*/g, "[^/]*")
    .replace(/\0/g, ".*");
  return new RegExp(`^${expression}$`).test(path);
}

export function validateChangeScope(changes, { allowed = [], forbidden = [] }) {
  const violations = [];
  for (const change of changes) {
    if (forbidden.some((pattern) => globMatches(change.path, pattern))) {
      violations.push({ ...change, reason: "forbidden_path" });
    } else if (!allowed.some((pattern) => globMatches(change.path, pattern))) {
      violations.push({ ...change, reason: "outside_allowed_scope" });
    }
  }
  return violations;
}

export async function scanAgentTree(root, { forbiddenTokens = [] } = {}) {
  const files = await listTree(root, { ignoreNames: new Set(["node_modules"]) });
  const violations = [];
  for (const file of files) {
    const parts = file.path.toLowerCase().split("/");
    if (parts.includes(".git") || parts.includes("evaluator-private") || parts.includes("private")) {
      violations.push({ path: file.path, reason: "forbidden_artifact_name" });
      continue;
    }
    if (file.size > 2 * 1024 * 1024 || forbiddenTokens.length === 0) continue;
    const bytes = await readFile(resolve(root, ...file.path.split("/")));
    if (bytes.includes(0)) continue;
    const text = bytes.toString("utf8");
    for (const token of forbiddenTokens.filter(Boolean)) {
      if (text.includes(token)) violations.push({ path: file.path, reason: "forbidden_reference_token" });
    }
  }
  return violations;
}
