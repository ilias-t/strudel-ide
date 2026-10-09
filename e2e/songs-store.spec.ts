// The songs store (src/songs-store/): edits kept in the browser.
//   - an override of a built-in song persists across reloads; revert restores the built-in
//   - a user song persists across reloads
//   - a stored user song or a share link that doesn't build is a placeholder:
//     listed (⚠), silent, its text openable in the editor and fixed in place
//   - a share link (the song in the URL hash) round-trips into another page
//   - a page with nothing stored loads no compiler

import { contentVersion } from "../src/live/protocol.ts";
import { FIXTURE_ID, fixtureSource, writeFixture } from "./fixture.ts";
import type { Page } from "@playwright/test";
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

/** The fixture with a syntax error on its gain line ("((" after ".gain(") */
const brokenSource = (name: string) => fixtureSource({ name }).replace(".gain(", ".gain(((");

async function enterEdit(page: Page) {
  await page.locator("body").press("e");
  await expect.poll(() => page.evaluate(() => window.__strudelEditor?.loaded() ?? false), { timeout: 30_000 }).toBe(true);
  await expect(page.getByTestId("code-editor").locator(".monaco-editor")).toBeVisible();
}

test("a stored user song that doesn't build comes back as a placeholder: listed, silent, editable, fixed in place", async ({ player, page }) => {
  test.setTimeout(90_000);
  await player.boot();
  const id = "broken-tune";
  const broken = brokenSource("Broken Tune");
  const fixed = fixtureSource({ name: "Broken Tune" });
  expect(broken).not.toBe(fixed);
  // saved earlier in this browser, and the last song played
  await page.evaluate(
    ([id, text]) => {
      localStorage.setItem(`strudel-ide:my-song:${id}`, JSON.stringify({ v: 1, kind: "user", text, updatedAt: 1 }));
      localStorage.setItem("strudel-ide:song", id);
    },
    [id, broken] as const
  );
  await page.reload();
  await waitReady(player);

  // listed, marked, selected (it was the last song), with its text and no error panel
  await expect.poll(() => player.songIds()).toContain(id);
  const option = page.locator(`#song-select option[value="${id}"]`);
  await expect(option).toHaveText("⚠ Broken Tune");
  expect(await page.evaluate((id) => window.__strudel!.songs()[id]?.name, id), "the mark is only in the picker").toBe("Broken Tune");
  await expect.poll(async () => (await player.state()).songId).toBe(id);
  expect(await sourceOf(player)).toMatchObject({ file: `src/songs/${id}.ts`, text: broken, live: false });
  expect((await player.state()).error).toBeNull();
  await expect(player.errorPanel()).toBeHidden();

  // selecting it again and playing it: silence, still no error
  await page.evaluate(() => window.__strudel!.selectSong("untitled"));
  expect(await player.select(id)).toBe(true);
  await player.play();
  expect(await player.probe()).toBeNull();
  expect((await player.state()).error).toBeNull();
  await player.stop();

  // the editor opens its text with the error inline
  await enterEdit(page);
  const buffer = () => page.evaluate(() => window.__strudelEditor!.value()!);
  await expect.poll(buffer).toBe(broken);
  const line = broken.split("\n").findIndex((l) => l.includes(".gain(((")) + 1;
  await expect.poll(() => page.evaluate(() => window.__strudelEditor!.markers().map((m) => m.line))).toContain(line);
  expect((await player.state()).error).toBeNull();

  // fixing it builds it: the mark goes, it plays, and the fixed text is kept
  await page.evaluate(() => {
    const e = window.__strudelEditor!;
    e.focus(e.value()!.indexOf(".gain(((") + ".gain(((".length);
  });
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  expect(await buffer()).toBe(fixed);
  await expect(option).toHaveText("Broken Tune");
  await expect.poll(() => page.evaluate(() => window.__strudelEditor!.markers())).toEqual([]);
  await expect.poll(async () => (await sourceOf(player))?.text).toBe(fixed);
  await player.play();
  await expect.poll(() => player.probe()).toMatchObject({ gain: 0.5 });
  expect((await player.state()).error).toBeNull();
  await expect
    .poll(() => page.evaluate((id) => window.__strudel!.store.getMySong(id)?.text, id), { message: "the fix is kept" })
    .toBe(fixed);
  await player.stop();

  await page.reload();
  await waitReady(player);
  await expect.poll(() => player.songIds()).toContain(id);
  await expect(option).toHaveText("Broken Tune");
  await expect.poll(async () => (await sourceOf(player))?.text).toBe(fixed);
});

test("a stored last song whose createPattern() throws is a placeholder too, its error located inline", async ({ player, page }) => {
  test.setTimeout(60_000);
  await player.boot();
  const id = "throwing-tune";
  const text = fixtureSource({ name: "Throwing Tune", buildError: true });
  await page.evaluate(
    ([id, text]) => {
      localStorage.setItem(`strudel-ide:my-song:${id}`, JSON.stringify({ v: 1, kind: "user", text, updatedAt: 1 }));
      localStorage.setItem("strudel-ide:song", id);
    },
    [id, text] as const
  );
  await page.reload();
  await waitReady(player);
  await expect.poll(async () => (await player.state()).songId).toBe(id);
  await expect(page.locator(`#song-select option[value="${id}"]`)).toHaveText("⚠ Throwing Tune");
  expect(await sourceOf(player)).toMatchObject({ text });
  expect((await player.state()).error).toBeNull();
  await expect(player.errorPanel()).toBeHidden();
  await enterEdit(page);
  await expect.poll(() => page.evaluate(() => window.__strudelEditor!.value())).toBe(text);
  const line = text.split("\n").findIndex((l) => l.includes("throw new Error")) + 1;
  await expect.poll(() => page.evaluate(() => window.__strudelEditor!.markers().map((m) => m.line))).toContain(line);
  expect((await player.state()).error).toBeNull();
});

test("a share link whose song doesn't build opens as a placeholder with its text intact", async ({ player, page, browser }) => {
  await player.boot();
  const broken = brokenSource("Broken Share");
  const url = await page.evaluate((text) => window.__strudel!.store.shareUrl("broken-share", text), broken);

  const context = await browser.newContext();
  const other = await context.newPage();
  const errors: string[] = [];
  other.on("pageerror", (e) => errors.push(e.message));
  other.on("console", (msg) => msg.type() === "error" && errors.push(msg.text()));
  const warnings: string[] = [];
  other.on("console", (msg) => msg.type() === "warning" && warnings.push(msg.text()));
  await other.goto(url);
  await other.getByTestId("share-dialog-confirm").click({ timeout: 30_000 });
  await other.waitForFunction(() => window.__strudel?.getState().ready === true, null, { timeout: 30_000 });
  await expect.poll(() => other.evaluate(() => window.__strudel!.getState().songId)).toBe("broken-share");
  // opened, but it doesn't build: the boot logs why
  await expect.poll(() => warnings.filter((w) => w.startsWith("[strudel-ide] share link:")).length, { message: "the share link's error is logged" }).toBe(1);
  expect(await other.evaluate(() => window.__strudel!.currentSource())).toMatchObject({ file: "src/songs/broken-share.ts", text: broken });
  await expect(other.locator('#song-select option[value="broken-share"]')).toHaveText("⚠ Broken Share");
  expect(await other.evaluate(() => window.__strudel!.getState().error)).toBeNull();
  // opening the same link again reuses the song (no -shared copy)
  const hash = new URL(url).hash;
  expect(await other.evaluate((hash) => window.__strudel!.store.loadFromHash(hash, { confirm: () => true }), hash)).toMatchObject({
    ok: true,
    id: "broken-share",
  });
  expect((await other.evaluate(() => Object.keys(window.__strudel!.songs()))).filter((id) => id.startsWith("broken-share"))).toEqual([
    "broken-share",
  ]);
  expect(errors).toEqual([]);
  await context.close();
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
  // the question is the stage's own card (src/ui/share-confirm.ts), never a native dialog
  other.on("dialog", (dialog) => (errors.push(`native dialog: ${dialog.message()}`), void dialog.dismiss()));
  await other.exposeFunction("__e2eAsked", (text: string) => asked.push(text));
  await other.addInitScript(() => {
    new MutationObserver((records) => {
      for (const r of records)
        for (const n of r.addedNodes)
          if (n instanceof HTMLElement) {
            const card = n.matches('[data-testid="share-dialog"]') ? n : n.querySelector('[data-testid="share-dialog"]');
            if (card) void (window as unknown as { __e2eAsked(t: string): void }).__e2eAsked(card.textContent ?? "");
          }
    }).observe(document, { childList: true, subtree: true });
  });
  await other.goto(url);
  await other.getByTestId("share-dialog-confirm").click({ timeout: 30_000 });
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
  expect(asked[0]).toMatch(/shared song.*Shared Tune.*shared-tune\.ts.*runs that code/s);
  await expect(other.getByTestId("share-dialog")).toHaveCount(0);
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
  // the stage's own card asks (src/ui/share-confirm.ts): "don't"
  await other.getByTestId("share-dialog-cancel").click({ timeout: 30_000 });
  await expect(other.getByTestId("share-dialog")).toHaveCount(0);
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
