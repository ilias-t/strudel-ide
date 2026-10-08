// Vite config for the end-to-end tests: the app's own vite.config.ts, but
//  - serving the app snapshot in .e2e-app/ (see fixture.ts) instead of the
//    checkout, so a `npm run dev` player never sees the tests' fixture edits;
//  - the bridge plugin doesn't write the editor discovery file
//    (node_modules/.strudel/server.json), which would otherwise point the
//    VS Code extension at the test server and be deleted when it exits;
//  - its own dependency pre-bundle cache.

import { resolve } from "node:path";
import { defineConfig, type PluginOption } from "vite";
import base from "../vite.config";
import strudelBridge from "../vite-plugins/strudel-bridge";
import { APP_ROOT, ROOT } from "./fixture.ts";

const flatten = (plugins: PluginOption[] | undefined): PluginOption[] =>
  (plugins ?? []).flatMap((p) => (Array.isArray(p) ? flatten(p) : [p]));

export default defineConfig({
  ...base,
  root: APP_ROOT,
  cacheDir: resolve(ROOT, "node_modules/.vite-e2e"),
  plugins: flatten(base.plugins).map((p) =>
    p && typeof p === "object" && "name" in p && p.name === "strudel-bridge"
      ? strudelBridge({ discovery: false, log: false })
      : p
  ),
  server: { ...base.server, open: false },
});
