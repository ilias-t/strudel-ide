// Run an npm script in vscode-extension/, installing its deps first if needed.
// Usage: node scripts/ext.mjs <build|check|package|test|typecheck>

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "vscode-extension");
const script = process.argv[2] ?? "check";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const run = (args) => {
  const r = spawnSync(npm, args, { cwd: dir, stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

if (!existsSync(join(dir, "node_modules", ".package-lock.json"))) {
  console.log("Installing vscode-extension dependencies…");
  run(["ci", "--no-audit", "--no-fund"]);
}
run(["run", script]);
