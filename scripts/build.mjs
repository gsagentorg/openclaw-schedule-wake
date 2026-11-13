import { mkdirSync, copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
for (const source of ["index.js", "browser/main.js"]) {
  const result = spawnSync(process.execPath, ["--check", path.join(root, source)], { stdio: "inherit" });
  if (result.status !== 0) throw new Error("Syntax check failed: " + source);
}
mkdirSync(path.join(root, "dist", "control-ui", "v1"), { recursive: true });
for (const [source, destination] of [
  ["index.js", "dist/index.js"],
  ["browser/main.js", "dist/control-ui/v1/index.js"],
  ["browser/main.css", "dist/control-ui/v1/index.css"],
]) copyFileSync(path.join(root, source), path.join(root, destination));
console.log("Built backend and native UI assets (no dependencies or network required).");
