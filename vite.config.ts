import { defineConfig } from "vite";
import strudelBridge from "./vite-plugins/strudel-bridge";
import strudelLocations from "./vite-plugins/strudel-locations";

export default defineConfig({
  // mini-notation strings in src/songs/*.ts → m("...", offset) for live highlighting
  plugins: [strudelLocations(), strudelBridge()],
  // main.ts uses top-level await (audio engine + samples load before the UI)
  build: { target: "es2022", chunkSizeWarningLimit: 1500 },
  server: {
    port: 3000,
    open: !process.env.CI && !process.env.NO_OPEN,
    proxy: {
      // Proxy requests to /strudel-samples to the Strudel CDN
      "/strudel-samples": {
        target: "https://strudel.cc",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/strudel-samples/, ""),
      },
    },
  },
});
