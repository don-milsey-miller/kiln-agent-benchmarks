#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function replaceExactlyOnce(target, original, patched) {
  const source = fs.readFileSync(target, "utf8");
  if (source.includes(patched)) return;
  const occurrences = source.split(original).length - 1;
  if (occurrences !== 1) {
    throw new Error(`expected one OpenAI fetch hook in ${target}; found ${occurrences}`);
  }
  fs.writeFileSync(target, source.replace(original, patched));
  console.log(`patched=${target}`);
}

replaceExactlyOnce(
  "/workspace/pi/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js",
  "        fetch,\n        defaultHeaders: headers,",
  "        fetch: fetch ?? globalThis.fetch,\n        defaultHeaders: headers,",
);

const chunkDirectory = "/workspace/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks";
const completionChunks = fs
  .readdirSync(chunkDirectory)
  .filter((name) => /^openai-completions-.*\.js$/.test(name));
if (completionChunks.length !== 1) {
  throw new Error(`expected one bundled OpenAI completions chunk; found ${completionChunks.length}`);
}
replaceExactlyOnce(
  path.join(chunkDirectory, completionChunks[0]),
  "dangerouslyAllowBrowser:!0,fetch,defaultHeaders:headers",
  "dangerouslyAllowBrowser:!0,fetch:fetch??globalThis.fetch,defaultHeaders:headers",
);
