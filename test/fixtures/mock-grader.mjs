import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const mode = process.argv[2] ?? "normal";
if (mode === "infra-error") {
  console.error("synthetic evaluator infrastructure failure");
  process.exit(2);
}
const value = (await readFile(resolve("src", "value.txt"), "utf8")).trim();
if (value === "fixed") {
  console.log(JSON.stringify({ targeted: "passed", regressions: "passed" }));
  process.exit(0);
}
console.log(JSON.stringify({ targeted: "failed", regressions: "not_run", observed: value }));
process.exit(1);
