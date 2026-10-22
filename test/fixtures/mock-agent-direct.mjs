import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const scenario = process.argv[2];
if (scenario === "valid") await writeFile(resolve("src", "value.txt"), "fixed\n");
else if (scenario === "failing") await writeFile(resolve("src", "value.txt"), "wrong\n");
else if (scenario === "scope") await writeFile(resolve("forbidden.txt"), "bad\n");
else if (scenario === "malformed") {
  console.log("not json");
  process.exit(0);
} else if (scenario === "error") {
  console.log(JSON.stringify({ type: "agent_error" }));
  process.exit(7);
}
console.log(JSON.stringify({ type: "agent_end", scenario, usage: { input_tokens: 2, output_tokens: 1 } }));
