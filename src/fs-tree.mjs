import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

const DEFAULT_IGNORES = new Set(["node_modules", ".git"]);

export const toPosix = (value) => value.split(sep).join("/");

export function assertWithin(parent, child) {
  const base = resolve(parent);
  const target = resolve(child);
  if (target === base || !target.startsWith(`${base}${sep}`)) {
    throw new Error(`path must be a child of ${base}: ${target}`);
  }
  return target;
}

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export const sha256File = async (path) => sha256(await readFile(path));

export async function listTree(root, { ignoreNames = DEFAULT_IGNORES } = {}) {
  const base = resolve(root);
  const entries = [];
  async function walk(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (ignoreNames.has(item.name)) continue;
      const absolute = resolve(directory, item.name);
      const path = toPosix(relative(base, absolute));
      if (item.isDirectory()) await walk(absolute);
      else if (item.isFile()) {
        const stat = await lstat(absolute);
        entries.push({ path, size: stat.size, sha256: await sha256File(absolute), mode: stat.mode & 0o777 });
      } else if (item.isSymbolicLink()) {
        throw new Error(`symbolic links are not allowed in benchmark trees: ${path}`);
      }
    }
  }
  await walk(base);
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

export async function treeDigest(root, options) {
  const files = await listTree(root, options);
  return { files, sha256: sha256(JSON.stringify(files)) };
}

export function diffManifests(before, after) {
  const oldFiles = new Map(before.files.map((file) => [file.path, file]));
  const newFiles = new Map(after.files.map((file) => [file.path, file]));
  const paths = [...new Set([...oldFiles.keys(), ...newFiles.keys()])].sort();
  return paths.flatMap((path) => {
    const oldFile = oldFiles.get(path);
    const newFile = newFiles.get(path);
    if (!oldFile) return [{ path, change: "added", sha256: newFile.sha256 }];
    if (!newFile) return [{ path, change: "deleted", sha256: oldFile.sha256 }];
    if (oldFile.sha256 !== newFile.sha256 || oldFile.mode !== newFile.mode) {
      return [{ path, change: "modified", beforeSha256: oldFile.sha256, sha256: newFile.sha256 }];
    }
    return [];
  });
}

export async function copyCleanTree(source, destination) {
  await mkdir(destination, { recursive: true });
  await cp(source, destination, {
    recursive: true,
    force: true,
    filter: (path) => !path.split(/[\\/]/).some((part) => DEFAULT_IGNORES.has(part)),
  });
}

export async function replaceTree(root, source) {
  const parent = dirname(resolve(root));
  assertWithin(parent, root);
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  await mkdir(root, { recursive: true });
  await copyCleanTree(source, root);
}

export async function applyChanges(baseRoot, candidateRoot, gradeRoot, changes) {
  await copyCleanTree(baseRoot, gradeRoot);
  for (const change of changes) {
    const destination = assertWithin(gradeRoot, resolve(gradeRoot, ...change.path.split("/")));
    if (change.change === "deleted") {
      await rm(destination, { force: true, recursive: true });
      continue;
    }
    const source = assertWithin(candidateRoot, resolve(candidateRoot, ...change.path.split("/")));
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination, { force: true });
  }
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
