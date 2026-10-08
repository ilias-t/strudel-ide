// The production bundle (of the e2e app snapshot) builds and boots
// (top-level await, the dev-only bridge turning into a no-op, ...).
// `npm run test:build` additionally runs the full `npm run build` (tsc + vite
// build into dist/) on the checkout.

import { fileURLToPath } from "node:url";
import { build, preview, type PreviewServer } from "vite";
import { APP_ROOT, FIXTURE_ID, writeFixture } from "./fixture.ts";
import { expect, test } from "./player.ts";

let server: PreviewServer | undefined;
test.afterEach(async () => {
  await server?.close();
  server = undefined;
});

test("production build boots and plays", async ({ player, page }, testInfo) => {
  test.setTimeout(90_000);
  const configFile = fileURLToPath(new URL("../vite.config.ts", import.meta.url));
  const outDir = testInfo.outputPath("dist"); // not dist/: leave the real build alone

  writeFixture(); // the bundle includes the fixture: make sure it's the clean one
  await build({ root: APP_ROOT, configFile, logLevel: "warn", build: { outDir, emptyOutDir: true } });
  server = await preview({
    root: APP_ROOT,
    configFile,
    logLevel: "warn",
    build: { outDir },
    preview: { port: 0, open: false },
  });
  const url = server.resolvedUrls?.local[0];
  expect(url, "preview server URL").toBeTruthy();

  await page.goto(url!);
  await page.waitForFunction(() => window.__strudel?.getState().ready === true, null, { timeout: 30_000 });
  const ids = await player.songIds();
  expect(ids.length).toBeGreaterThan(0);

  expect(await player.select(FIXTURE_ID)).toBe(true);
  await player.play();
  await player.listen(1500);
  const state = await player.state();
  expect(state.playing).toBe(true);
  expect(state.error).toBeNull();
  expect(player.errors).toEqual([]);
  await player.stop();
});
