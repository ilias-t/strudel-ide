import { defineConfig } from "vite";
import strudelBridge from "./vite-plugins/strudel-bridge";

export default defineConfig({
  plugins: [strudelBridge()],
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
