import { defineConfig, devices } from "@playwright/test";

// End-to-end tests for the player (see e2e/ and the README).
//
// The tests edit a fixture song on disk and watch the running page hot-swap
// it, so they run serially (workers: 1) against one Vite dev server that
// e2e/serve.ts starts on a dedicated port.

const PORT = Number(process.env.E2E_PORT ?? 5310);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "e2e",
  workers: 1,
  fullyParallel: false,
  // Flakiness should show up as failures, not be retried away.
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    launchOptions: {
      // Lets the AudioContext start without a click, so play() really plays.
      args: ["--autoplay-policy=no-user-gesture-required"],
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `node e2e/serve.ts --port ${PORT}`,
    url: BASE_URL,
    // Never attach to a server we didn't start: fixture edits made here would
    // not reach a dev server running from another checkout.
    reuseExistingServer: false,
    // SIGTERM (not the default SIGKILL) so serve.ts can delete .e2e-app/.
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    timeout: 60_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
