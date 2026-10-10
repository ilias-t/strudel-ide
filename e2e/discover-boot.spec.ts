// Boot budget for discovery (src/ui/discover/): a page that only plays loads
// none of the library, the palette, the track builder, audition or the catalog
// JSON. Only the small hooks module (keys, slots) is on the boot path. Each
// feature is a lazy chunk, requested the first time it opens.
//
// Checked twice: on the dev server (module URLs), and in the production build
// under /strudel-ide/ (chunk file names), like the hosted site.

import { fileURLToPath } from "node:url";
import { build, preview, type PreviewServer } from "vite";
import { APP_ROOT, FIXTURE_ID, fixtureSource, writeFixture } from "./fixture.ts";
import { expect, test } from "./player.ts";

test.afterEach(async ({ player }) => {
  expect(player.errors, "console/page errors").toEqual([]);
});

/** Dev server module URLs that must wait until a feature opens */
const LAZY_MODULES = /\/src\/ui\/discover\/(library|palette|track-builder|audition|catalog|fuzzy|snippet-sound|cheatsheet|previewable)[^/]*\.ts|\/src\/catalog\/|\/src\/compile\/add-track/;
/** Production chunk names that must wait until a feature opens */
const LAZY_CHUNKS = /\/assets\/(library|palette|track-builder|audition|catalog|sounds|functions|snippets|fuzzy|snippet-sound|add-track|cheatsheet|previewable|completions|intents)[-.][^/]*\.(js|css)$/;

test("dev: booting and playing loads no discovery feature or catalog; opening one loads it", async ({ player, page }) => {
  await player.boot();
  expect(await player.select(FIXTURE_ID)).toBe(true);
  await player.play();
  await player.listen(500);

  const resources = () => page.evaluate(() => performance.getEntriesByType("resource").map((r) => r.name));
  const atBoot = await resources();
  expect(atBoot.filter((url) => LAZY_MODULES.test(url)), "no discovery feature at boot").toEqual([]);
  expect(atBoot.some((url) => url.includes("/src/ui/discover/hooks.ts")), "the hooks module is the boot-path piece").toBe(true);
  expect(await page.evaluate(() => window.__strudelDiscover!.loaded())).toEqual([]);

  // B opens the library: its chunk and the sounds catalog load now
  await page.locator("body").press("b");
  await expect.poll(() => page.evaluate(() => window.__strudelDiscover!.isOpen("library"))).toBe(true);
  await expect.poll(async () => (await resources()).some((url) => /\/src\/ui\/discover\/library[^/]*\.ts/.test(url))).toBe(true);
  // the library focuses its search (which keeps every key, b included): Esc closes it
  await expect(page.getByTestId("library-search")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect.poll(() => page.evaluate(() => window.__strudelDiscover!.isOpen("library"))).toBe(false);
  await player.stop();
});

test("dev: a stored song compiles at boot without loading the track builder's planner", async ({ player, page }) => {
  await player.boot();
  const text = fixtureSource({ gain: 0.3 });
  await page.evaluate(({ id, text }) => window.__strudel!.store.saveOverride(id, text), { id: FIXTURE_ID, text });

  // the boot replay compiles it in the song compiler's worker: see what the worker loads too
  const requests: string[] = [];
  page.context().on("request", (req) => requests.push(req.url()));
  await page.reload();
  await page.waitForFunction(() => window.__strudel?.getState().ready === true, null, { timeout: 30_000 });
  await expect
    .poll(() => page.evaluate((id) => window.__strudel!.songs()[id] && window.__strudel!.store.getMySong(id)?.text, FIXTURE_ID))
    .toBe(text);
  expect(await player.select(FIXTURE_ID)).toBe(true);
  await player.play();
  await expect.poll(() => player.probe(), { message: "the stored edit plays" }).toMatchObject({ gain: 0.3 });
  await player.stop();
  expect(requests.some((url) => /\/src\/compile\/worker\.ts/.test(url)), "the compiler worker ran (the replay)").toBe(true);
  expect(requests.filter((url) => LAZY_MODULES.test(url)), "no discovery module, in the page or the worker").toEqual([]);
});

let server: PreviewServer | undefined;
test.afterEach(async () => {
  await server?.close();
  server = undefined;
});

test("production build under /strudel-ide/: boot requests no discovery chunk; they load on first open", async ({ player, page }, testInfo) => {
  test.setTimeout(150_000);
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
  await player.listen(800);

  const local = (url: string) => url.startsWith(origin);
  const atBoot = requests.filter(local);
  expect(atBoot.filter((url) => LAZY_CHUNKS.test(url)), "no discovery chunk at boot").toEqual([]);

  // the library: its chunk and the sounds catalog, under the base path
  await page.locator("body").press("b");
  await expect.poll(() => page.evaluate(() => window.__strudelDiscover!.isOpen("library"))).toBe(true);
  await expect
    .poll(() => requests.filter(local).slice(atBoot.length).some((url) => /\/assets\/library[-.]/.test(url)), { message: "library chunk on first open" })
    .toBe(true);
  // the palette
  await page.locator("body").press("Escape");
  await page.locator("body").press("Control+k");
  await expect.poll(() => page.evaluate(() => window.__strudelDiscover!.isOpen("palette"))).toBe(true);
  await expect
    .poll(() => requests.filter(local).some((url) => /\/assets\/palette[-.]/.test(url)), { message: "palette chunk on first open" })
    .toBe(true);
  // the cheat sheet
  await page.locator("body").press("Escape");
  await page.locator("body").press("?");
  await expect.poll(() => page.evaluate(() => window.__strudelDiscover!.isOpen("cheatsheet"))).toBe(true);
  await expect
    .poll(() => requests.filter(local).some((url) => /\/assets\/cheatsheet[-.][^/]*\.js$/.test(url)), { message: "cheat sheet chunk on first open" })
    .toBe(true);
  await expect(page.locator("[data-testid=cheat-row][data-kind=mini]").first()).toBeVisible();
  for (const url of requests.filter(local)) expect(new URL(url).pathname.startsWith(base), url).toBe(true);
  await player.stop();
});
