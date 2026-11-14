import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
for (const source of ["index.js", "dist/control-ui/source/main.js"]) {
  const result = spawnSync(process.execPath, ["--check", path.join(root, source)], { stdio: "inherit" });
  if (result.status !== 0) throw new Error("Syntax check failed: " + source);
}
console.log("Validated directly executable backend and authored native UI sources; no build needed.");
