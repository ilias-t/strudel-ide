// The songs store (src/songs-store/): edits kept in the browser.
//   - an override of a built-in song persists across reloads; revert restores the built-in
//   - a user song persists across reloads
//   - a share link (the song in the URL hash) round-trips into another page
//   - a page with nothing stored loads no compiler

import { contentVersion } from "../src/live/protocol.ts";
import { FIXTURE_ID, fixtureSource, writeFixture } from "./fixture.ts";
import { expect, test, type Player } from "./player.ts";

type Source = { file: string; text?: string; version?: string; live?: boolean; origin?: string } | null;

function sourceOf(player: Player): Promise<Source> {
  return player.page.evaluate(() => window.__strudel!.currentSource());
}

async function waitReady(player: Player) {
  await player.page.waitForFunction(
    () => {
      const s = window.__strudel?.getState();
      return !!s && s.ready && s.loading === null;
    },
    null,
    { timeout: 30_000 }
  );
}

test.afterEach(async ({ player }) => {
  expect(player.errors, "console/page errors").toEqual([]);
});

test("an override persists across reloads; revert restores the built-in song", async ({ player, page }) => {
  test.setTimeout(60_000);
  await player.boot();
  expect(await player.select(FIXTURE_ID)).toBe(true);
  const builtIn = (await sourceOf(player))!;
  const text = fixtureSource({ gain: 0.3, name: "E2E Fixture (edited)" });

  // edit + keep it (what the editor does on commit)
  const saved = await page.evaluate(([id, text]) => window.__strudel!.store.saveOverride(id, text), [FIXTURE_ID, text] as const);
  expect(saved).toMatchObject({ id: FIXTURE_ID, kind: "override", text });
  expect(await page.evaluate(([id, text]) => window.__strudel!.evalSource(id, text, { intent: "commit", origin: "browser" }), [FIXTURE_ID, text] as const)).toMatchObject({ ok: true });
  expect(await page.evaluate(() => window.__strudel!.store.listMySongs().map(({ id, kind }) => ({ id, kind })))).toEqual([
    { id: FIXTURE_ID, kind: "override" },
  ]);

  // reload: the override replaces the built-in source on boot
  await page.reload();
  await waitReady(player);
  expect((await player.state()).songId).toBe(FIXTURE_ID);
  await expect.poll(async () => (await sourceOf(player))?.text, { message: "override applied on boot" }).toBe(text);
  expect(await sourceOf(player)).toMatchObject({ version: contentVersion(text), live: true });
  expect(await player.fixtureName()).toBe("E2E Fixture"); // the built-in module itself is untouched
  expect((await player.state()).songName).toBe("E2E Fixture (edited)");
  await player.play();
  await expect.poll(() => player.probe()).toMatchObject({ gain: 0.3 });

  // revert: the built-in plays again, and stays after a reload
  expect(await page.evaluate((id) => window.__strudel!.store.revert(id), FIXTURE_ID)).toBe(true);
  await expect.poll(async () => (await sourceOf(player))?.text).toBe(builtIn.text);
  await expect.poll(() => player.probe()).toMatchObject({ gain: 0.5 });
  expect((await player.state()).live).toBeNull();
  expect(await page.evaluate(() => window.__strudel!.store.listMySongs())).toEqual([]);
  await player.stop();
  await page.reload();
  await waitReady(player);
  expect(await sourceOf(player)).toEqual(builtIn);
});

test("a user song persists across reloads", async ({ player, page }) => {
  await player.boot();
  const text = fixtureSource({ name: "Kept Tune", gain: 0.2 });
  await page.evaluate((text) => window.__strudel!.store.saveOverride("kept-tune", text), text);
  expect(await page.evaluate((text) => window.__strudel!.addSong("kept-tune", text), text)).toMatchObject({ ok: true });
  expect(await player.select("kept-tune")).toBe(true);

  await page.reload();
  await waitReady(player);
  await expect.poll(() => player.songIds()).toContain("kept-tune");
  // it was the current song: it is selected again once registered
  await expect.poll(async () => (await player.state()).songId).toBe("kept-tune");
  expect(await sourceOf(player)).toMatchObject({ file: "src/songs/kept-tune.ts", text });

  expect(await page.evaluate(() => window.__strudel!.store.revert("kept-tune"))).toBe(true);
  expect(await player.songIds()).not.toContain("kept-tune");
});

test("a share link round-trips: the song travels in the URL hash", async ({ player, page, browser }) => {
  test.setTimeout(60_000);
  await player.boot();
  const text = fixtureSource({ name: "Shared Tune", gain: 0.45 }) + "\n// ünïcödé ✓ — kept byte for byte\n";
  const url = await page.evaluate((text) => window.__strudel!.store.shareUrl("shared-tune", text), text);
  const parsed = new URL(url);
  expect(parsed.hash).toMatch(/^#song=[A-Za-z0-9_-]+$/);
  expect(parsed.pathname).toBe("/");

  // a fresh browser context (no storage) opens the link, once the person agrees
  const context = await browser.newContext();
  const other = await context.newPage();
  const errors: string[] = [];
  const asked: string[] = [];
  other.on("pageerror", (e) => errors.push(e.message));
  other.on("dialog", (dialog) => (asked.push(dialog.message()), void dialog.accept()));
  await other.goto(url);
  await other.waitForFunction(() => window.__strudel?.getState().ready === true, null, { timeout: 30_000 });
  await expect.poll(() => other.evaluate(() => window.__strudel!.getState().songId)).toBe("shared-tune");
  expect(await other.evaluate(() => window.__strudel!.currentSource())).toMatchObject({
    file: "src/songs/shared-tune.ts",
    text,
    version: contentVersion(text),
  });
  expect(await other.evaluate(() => window.__strudel!.getState().playing), "a link never auto-plays").toBe(false);
  expect(await other.evaluate(() => window.__strudel!.store.listMySongs()), "nor persists by itself").toEqual([]);
  expect(asked).toHaveLength(1);
  expect(asked[0]).toMatch(/shared song "shared-tune".*runs that code/s);
  expect(errors).toEqual([]);
  await context.close();
});

test("a declined share link runs nothing", async ({ player, page, browser }) => {
  await player.boot();
  // top-level code that would show if it ran
  const text = fixtureSource({ name: "Nope" }) + "\n(globalThis as any).__sharedRan = true;\n";
  const url = await page.evaluate((text) => window.__strudel!.store.shareUrl("nope-tune", text), text);

  const context = await browser.newContext();
  const other = await context.newPage();
  other.on("dialog", (dialog) => void dialog.dismiss());
  const requests: string[] = [];
  other.on("request", (req) => requests.push(new URL(req.url()).pathname));
  await other.goto(url);
  await other.waitForFunction(() => window.__strudel?.getState().ready === true, null, { timeout: 30_000 });
  await other.waitForTimeout(500);
  expect(await other.evaluate(() => Object.keys(window.__strudel!.songs()))).not.toContain("nope-tune");
  expect(await other.evaluate(() => (globalThis as { __sharedRan?: boolean }).__sharedRan)).toBeUndefined();
  expect(requests.filter((p) => /\/src\/compile\/(client|worker)\.ts$/.test(p)), "the compiler isn't even loaded").toEqual([]);
  await context.close();
});

test("booting with nothing stored loads no compiler", async ({ player, page }) => {
  const requests: string[] = [];
  page.on("request", (req) => requests.push(new URL(req.url()).pathname));
  writeFixture();
  await player.boot();
  await player.select(FIXTURE_ID);
  await player.play();
  await player.listen(300);
  // dev server module paths: the compiler is src/compile/client.ts + worker.ts (+ typescript)
  const compiler = requests.filter((p) => /\/src\/compile\/(client|worker|compile|evaluate)\.ts$|\/typescript\b|typescript\.js/.test(p));
  expect(compiler).toEqual([]);
});
