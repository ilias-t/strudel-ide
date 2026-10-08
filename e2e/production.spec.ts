// The production bundle (of the e2e app snapshot) builds and boots
// (top-level await, the dev-only bridge turning into a no-op, ...).
// `npm run test:build` additionally runs the full `npm run build` (tsc + vite
// build into dist/) on the checkout.

import { fileURLToPath } from "node:url";
import { build, preview, type PreviewServer } from "vite";
import { contentVersion } from "../src/live/protocol.ts";
import { APP_ROOT, FIXTURE_ID, fixtureSource, writeFixture } from "./fixture.ts";
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

// The hosted site (GitHub Pages, base /strudel-ide/) has no dev server: song
// edits compile in the page. Booting and playing must not load the compiler
// (TypeScript is in its worker chunk); the first evalSource loads it, from
// under the base path, and hot-swaps.
test("production build under /strudel-ide/: boot loads no compiler; evalSource compiles in the browser", async ({ player, page }, testInfo) => {
  test.setTimeout(120_000);
  const base = "/strudel-ide/";
  const configFile = fileURLToPath(new URL("../vite.config.ts", import.meta.url));
  const outDir = testInfo.outputPath("dist");

  writeFixture();
  await build({ root: APP_ROOT, configFile, base, logLevel: "warn", build: { outDir, emptyOutDir: true } });
  server = await preview({ root: APP_ROOT, configFile, base, logLevel: "warn", build: { outDir }, preview: { port: 0, open: false } });
  const origin = new URL(server.resolvedUrls!.local[0]).origin;

  const requests: string[] = [];
  page.on("request", (req) => requests.push(req.url()));
  await page.goto(`${origin}${base}`);
  await page.waitForFunction(() => window.__strudel?.getState().ready === true, null, { timeout: 30_000 });
  expect(await player.select(FIXTURE_ID)).toBe(true);
  await player.play();
  await player.listen(500);

  const compilerChunk = /\/assets\/(worker|client)[-.][^/]*\.js/;
  const local = (url: string) => url.startsWith(origin);
  const atBoot = requests.filter(local);
  expect(atBoot.filter((url) => compilerChunk.test(url)), "no compiler chunk loaded by booting and playing").toEqual([]);
  for (const url of atBoot) expect(new URL(url).pathname.startsWith(base), url).toBe(true);

  const { swapCount } = await player.state();
  const text = fixtureSource({ gain: 0.3 });
  const result = await page.evaluate(
    (text) => window.__strudel!.evalSource("zz-e2e-fixture", text, { intent: "commit", origin: "browser" }),
    text
  );
  expect(result).toEqual({ ok: true, version: contentVersion(text) });
  await expect.poll(() => player.probe()).toMatchObject({ gain: 0.3 });
  const state = await player.state();
  expect(state.swapCount).toBe(swapCount + 1);
  expect(state.error).toBeNull();

  const loaded = requests.filter(local).slice(atBoot.length);
  expect(loaded.some((url) => compilerChunk.test(url)), `compiler chunks loaded on first use: ${loaded.join(", ")}`).toBe(true);
  for (const url of loaded) expect(new URL(url).pathname.startsWith(base), url).toBe(true);
  expect(player.errors).toEqual([]);
  await player.stop();
});
