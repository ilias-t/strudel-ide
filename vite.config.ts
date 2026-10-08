import { defineConfig } from "vite";

export default defineConfig({
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
