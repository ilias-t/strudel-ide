// Playwright's webServer command: snapshot the app into .e2e-app/ (with the
// fixture song, see fixture.ts), then run Vite on it with e2e/vite.config.ts.
// Writing the fixture first means it's part of the very first module graph,
// and a snapshot left behind by a killed run is replaced before anything loads.
//
// Usage: node e2e/serve.ts --port 5310   (Node >= 22.18 runs .ts directly)

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { ROOT, createAppSnapshot, removeAppSnapshot } from "./fixture.ts";

createAppSnapshot();

const vite = spawn(
  process.execPath,
  [
    resolve(ROOT, "node_modules/vite/bin/vite.js"),
    "--config",
    resolve(ROOT, "e2e/vite.config.ts"),
    "--strictPort",
    ...process.argv.slice(2),
  ],
  { cwd: ROOT, stdio: "inherit", env: { ...process.env, NO_OPEN: "1" } }
);

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => vite.kill(signal));
}
vite.on("exit", (code, signal) => {
  removeAppSnapshot();
  process.exit(code ?? (signal ? 1 : 0));
});
