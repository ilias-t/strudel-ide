import { defineConfig } from "vite";
import strudelBridge from "./vite-plugins/strudel-bridge";
import strudelLocations from "./vite-plugins/strudel-locations";
import strudelKnobs from "./vite-plugins/strudel-knobs";
import strudelSongs from "./vite-plugins/strudel-songs";

export default defineConfig({
  // Where the build is served from: "/" locally, "/strudel-ide/" on GitHub Pages
  // (.github/workflows/pages.yml sets BASE_PATH)
  base: process.env.BASE_PATH ?? "/",
  // mini-notation strings in src/songs/*.ts → m("...", offset) for live highlighting
  // knob() → song-aware helper + POST /__strudel/knob write-back (after locations: it shifts offsets)
  // songs store → GET/POST /__strudel/song: save a browser song to src/songs/<id>.ts (dev server only)
  plugins: [strudelLocations(), strudelKnobs(), strudelBridge(), strudelSongs()],
  // main.ts uses top-level await (audio engine + samples load before the UI)
  build: { target: "es2022", chunkSizeWarningLimit: 1500 },
  // The song compiler's worker (src/compile/worker.ts) lazy-imports TypeScript
  // and strudel: module workers can code-split, iife ones can't
  worker: { format: "es" },
  // Pre-bundle what that worker imports, so the first compile in dev doesn't
  // discover new dependencies and reload the page
  optimizeDeps: { include: ["typescript", "magic-string", "@strudel/core", "@strudel/mini", "@strudel/tonal"] },
  server: {
    port: 3000,
    open: !process.env.CI && !process.env.NO_OPEN,
  },
});
