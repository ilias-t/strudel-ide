// Editing and saving on the stage (src/ui/stage.ts, song-saver.ts, ask.ts):
//   - every edit is kept in this browser (debounced, even when it doesn't
//     build); a reload brings it back with the "edited" badge; revert asks on
//     the stage's own card, then brings back the original
//   - ⌘/Ctrl+S: under the dev server it writes src/songs/<id>.ts (of the
//     e2e snapshot, never the checkout); on the site it keeps the edit in the
//     browser; never the browser's own "save page"
//   - share copies a link that opens through the styled dialog; download
//     saves the exact text
//   - the site's first-visit hint
//
// "The site" (no dev server to save to) is simulated by answering the store's
// probe, GET __strudel/song, with { ok: false }: canSaveToFile() is then false, as on
// GitHub Pages. The production build itself is covered by production.spec.ts
// and the deploy smoke test.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import { FIXTURE_FILE, FIXTURE_ID, FIXTURE_PATH, ROOT, fixtureSource, writeFixture } from "./fixture.ts";
import { expect, test, type Player } from "./player.ts";

test.afterEach(async ({ player }) => {
  expect(player.errors, "console/page errors").toEqual([]);
});

/** Make this page "the site": no dev-server song endpoint */
async function asHostedSite(page: Page) {
  await page.route("**/__strudel/song", (route) => route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":false}' }));
}

async function waitReady(page: Page) {
  await page.waitForFunction(
    () => {
      const s = window.__strudel?.getState();
      return !!s && s.ready && s.loading === null;
    },
    null,
    { timeout: 30_000 }
  );
}

async function enterEdit(page: Page) {
  await page.locator("body").press("e");
  await expect.poll(() => page.evaluate(() => window.__strudelEditor?.loaded() ?? false), { timeout: 30_000 }).toBe(true);
  await expect(page.getByTestId("code-editor").locator(".monaco-editor")).toBeVisible();
}

/** Put the caret just after `needle` in the buffer */
async function caretAfter(page: Page, needle: string) {
  await page.evaluate((needle) => {
    const e = window.__strudelEditor!;
    const text = e.value()!;
    const at = text.indexOf(needle);
    if (at < 0) throw new Error(`"${needle}" not in the buffer`);
    e.focus(at + needle.length);
  }, needle);
}

const buffer = (page: Page) => page.evaluate(() => window.__strudelEditor!.value()!);
const kept = (page: Page, id = FIXTURE_ID) => page.evaluate((id) => window.__strudel!.store.getMySong(id), id);

async function playFixtureAndEdit(player: Player) {
  await player.boot();
  expect(await player.select(FIXTURE_ID)).toBe(true);
  await player.play();
  await enterEdit(player.page);
}

/** gain 0.5 → 0.4 in the editor, by typing */
async function typeGainEdit(page: Page) {
  await caretAfter(page, ".gain(0.5");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("4");
  expect(await buffer(page)).toContain(".gain(0.4)");
}

test("an edit is kept in this browser; a reload brings it back, edited; revert asks, then plays the original", async ({ player, page }) => {
  test.setTimeout(90_000);
  await playFixtureAndEdit(player);
  const original = await buffer(page);
  const { swapCount } = await player.state();
  await typeGainEdit(page);
  const edited = await buffer(page);

  // typing plays it, and keeps it
  await player.waitForSwapAfter(swapCount);
  await expect.poll(() => player.probe()).toMatchObject({ gain: 0.4 });
  await expect.poll(async () => (await kept(page))?.text, { message: "kept as typed" }).toBe(edited);
  expect((await kept(page))?.kind).toBe("override");
  await expect(page.getByTestId("code-edited")).toBeVisible();
  await expect(page.getByTestId("code-revert")).toBeVisible();
  await expect(page.getByTestId("code-unsaved"), "kept: not 'unsaved'").toBeHidden();

  // reload: the edit is back, in the editor (remembered edit mode), playable and editable
  await page.reload();
  await waitReady(page);
  await expect.poll(() => page.evaluate(() => window.__strudelEditor?.loaded() ?? false), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => buffer(page)).toBe(edited);
  await expect(page.getByTestId("code-edited")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__strudelEditor!.session()?.owner)).toBe("browser");
  expect(await page.evaluate(() => window.__strudelEditor!.session()?.readOnly)).toBe(false);
  await player.play();
  await expect.poll(() => player.probe()).toMatchObject({ gain: 0.4 });

  // revert asks first; "keep them" changes nothing
  await page.getByTestId("code-revert").click();
  const dialog = page.getByTestId("revert-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("E2E Fixture");
  await expect(page.getByTestId("revert-dialog-cancel"), "the safe key has focus").toBeFocused();
  await page.getByTestId("revert-dialog-cancel").click();
  await expect(dialog).toBeHidden();
  expect((await kept(page))?.text).toBe(edited);
  expect(await buffer(page)).toBe(edited);

  // …and "revert" brings back the original, in the editor and in the music
  await page.getByTestId("code-revert").click();
  await page.getByTestId("revert-dialog-confirm").click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => buffer(page)).toBe(original);
  await expect.poll(() => player.probe()).toMatchObject({ gain: 0.5 });
  expect(await kept(page)).toBeNull();
  await expect(page.getByTestId("code-edited")).toBeHidden();
  await expect(page.getByTestId("code-revert")).toBeHidden();
  expect(await page.evaluate(() => window.__strudelEditor!.session()?.owner)).toBe("mirror");
  // and it stays reverted
  await page.reload();
  await waitReady(page);
  await expect.poll(() => page.evaluate(() => window.__strudelEditor?.loaded() ?? false), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => buffer(page)).toBe(original);
  await expect(page.getByTestId("code-edited")).toBeHidden();
});

test("an edit that doesn't build is kept too, and comes back after a reload with its error inline", async ({ player, page }) => {
  test.setTimeout(90_000);
  await playFixtureAndEdit(player);
  await caretAfter(page, ".gain(");
  await page.keyboard.type("((");
  const broken = await buffer(page);
  await expect.poll(async () => (await kept(page))?.text).toBe(broken);

  await page.reload();
  await waitReady(page);
  await expect.poll(() => page.evaluate(() => window.__strudelEditor?.loaded() ?? false), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => buffer(page), { message: "the broken edit, not the file" }).toBe(broken);
  await expect(page.getByTestId("code-edited")).toBeVisible();
  const line = broken.split("\n").findIndex((l) => l.includes(".gain(((")) + 1;
  await expect.poll(() => page.evaluate(() => window.__strudelEditor!.markers().map((m) => m.line))).toContain(line);
});

test("an edit typed back to the original drops the kept copy", async ({ player, page }) => {
  await playFixtureAndEdit(player);
  await typeGainEdit(page);
  await expect.poll(async () => (await kept(page)) !== null).toBe(true);
  await page.keyboard.press("Backspace");
  await page.keyboard.type("5");
  await expect.poll(() => kept(page)).toBeNull();
  await expect(page.getByTestId("code-edited")).toBeHidden();
});

/** Record whether ⌘/Ctrl+S keydowns reached the page with their default prevented */
async function watchSaveKeys(page: Page) {
  await page.evaluate(() => {
    const seen: boolean[] = ((window as unknown as { __saveKeys: boolean[] }).__saveKeys = []);
    addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") seen.push(e.defaultPrevented);
    });
  });
}
const saveKeys = (page: Page) => page.evaluate(() => (window as unknown as { __saveKeys: boolean[] }).__saveKeys);

test("⌘S under the dev server writes the song file (in the test snapshot) and drops the kept copy", async ({ player, page }) => {
  test.setTimeout(60_000);
  await playFixtureAndEdit(player);
  expect(await page.evaluate(() => window.__strudel!.store.canSaveToFile())).toBe(true);
  await watchSaveKeys(page);
  await typeGainEdit(page);
  const text = await buffer(page);

  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.getByTestId("code-toast")).toHaveText(`saved to ${FIXTURE_FILE}`);
  expect(await saveKeys(page), "never the browser's save-page dialog").toEqual([true]);
  expect(readFileSync(FIXTURE_PATH, "utf8")).toBe(text);
  expect(existsSync(resolve(ROOT, FIXTURE_FILE)), "the checkout's src/songs is never written").toBe(false);
  // the file is the truth now: nothing kept, the session follows the file again (HMR)
  await expect.poll(() => kept(page)).toBeNull();
  await expect.poll(() => page.evaluate(() => window.__strudelEditor!.session()?.owner)).toBe("mirror");
  await expect.poll(async () => (await player.state()).live).toBeNull();
  await expect(page.getByTestId("code-edited")).toBeHidden();
  await expect(page.getByTestId("code-unsaved")).toBeHidden();
  await expect.poll(() => player.probe()).toMatchObject({ gain: 0.4 });
});

test("two ⌘S saves land in order: the newest text ends up in the file", async ({ player, page }) => {
  test.setTimeout(60_000);
  // the first save's request is slow, so the second one is sent while it's out
  let posts = 0;
  await page.route("**/__strudel/song", async (route) => {
    if (route.request().method() === "POST" && ++posts === 1) await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await playFixtureAndEdit(player);
  await typeGainEdit(page);
  await page.keyboard.press("ControlOrMeta+s");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("3");
  const newest = await buffer(page);
  expect(newest).toContain(".gain(0.3)");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => posts).toBe(2);
  await expect(page.getByTestId("code-toast")).toHaveText(`saved to ${FIXTURE_FILE}`, { timeout: 10_000 });
  await page.waitForTimeout(500);
  expect(readFileSync(FIXTURE_PATH, "utf8"), "the newest text, not the slow older save").toBe(newest);
  await expect.poll(() => kept(page)).toBeNull();
  await expect.poll(() => buffer(page)).toBe(newest);
});

test("a file saved with the buffer's text while an autosave is pending keeps that text", async ({ player, page }) => {
  await playFixtureAndEdit(player);
  await typeGainEdit(page); // A: kept
  await expect.poll(async () => (await kept(page)) !== null).toBe(true);
  await page.keyboard.press("Backspace");
  await page.keyboard.type("3"); // B: autosave pending
  const b = await buffer(page);
  expect(writeFixture({ gain: 0.3 })).toBe(b); // the IDE saves exactly B
  await expect.poll(() => page.evaluate(() => window.__strudelEditor!.session()?.owner)).toBe("mirror");
  await page.waitForTimeout(600); // past the autosave debounce
  expect(await buffer(page), "not the older kept edit").toBe(b);
  expect(await kept(page), "B is the file: nothing kept").toBeNull();
  await expect(page.getByTestId("code-edited")).toBeHidden();
});

test("when the browser can't keep an edit, the stage says so", async ({ player, page }) => {
  await playFixtureAndEdit(player);
  await page.evaluate(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key.includes("my-song:")) throw new DOMException("full", "QuotaExceededError");
      return set.call(this, key, value);
    };
  });
  await typeGainEdit(page);
  await expect(page.getByTestId("code-toast")).toContainText("not kept");
  await expect(page.getByTestId("code-toast")).toHaveAttribute("data-kind", "error");
  await expect(page.getByTestId("code-unsaved")).toBeVisible();
  await expect(page.getByTestId("code-edited")).toBeHidden();
});

test("⌘S on the site keeps the edit in this browser at once", async ({ player, page }) => {
  await asHostedSite(page);
  await playFixtureAndEdit(player);
  expect(await page.evaluate(() => window.__strudel!.store.canSaveToFile())).toBe(false);
  await watchSaveKeys(page);
  const disk = readFileSync(FIXTURE_PATH, "utf8");
  await typeGainEdit(page);
  const text = await buffer(page);

  await page.keyboard.press("ControlOrMeta+s"); // before the autosave's debounce
  await expect(page.getByTestId("code-toast")).toHaveText("saved in this browser");
  expect(await saveKeys(page)).toEqual([true]);
  expect(await kept(page)).toMatchObject({ kind: "override", text });
  await expect(page.getByTestId("code-edited")).toBeVisible();
  expect(readFileSync(FIXTURE_PATH, "utf8"), "no file is written").toBe(disk);
});

test("share copies a link that opens through the stage's dialog", async ({ player, page, browser, baseURL }) => {
  test.setTimeout(60_000);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseURL });
  await playFixtureAndEdit(player);
  await typeGainEdit(page);
  const text = await buffer(page);
  await page.getByTestId("code-share").click();
  await expect(page.getByTestId("code-toast")).toHaveText("link copied");
  const url = await page.evaluate(() => navigator.clipboard.readText());
  expect(new URL(url).hash).toMatch(/^#song=[A-Za-z0-9_-]+$/);

  const context = await browser.newContext();
  const other = await context.newPage();
  const errors: string[] = [];
  other.on("pageerror", (e) => errors.push(e.message));
  other.on("dialog", (d) => errors.push(`native dialog: ${d.message()}`));
  await other.goto(url);
  const dialog = other.getByTestId("share-dialog");
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expect(dialog).toContainText("E2E Fixture");
  await expect(dialog).toContainText(`${FIXTURE_ID}.ts`);
  await expect(dialog).toContainText(/\d+(\.\d)? (KB|bytes) · \d+ lines/);
  await expect(dialog).toContainText(/runs that code/);
  // "don't" has focus, so a stray Enter can't run the link's code; opening takes a deliberate choice
  await expect(other.getByTestId("share-dialog-cancel")).toBeFocused();
  await other.getByTestId("share-dialog-confirm").click();
  await expect(dialog).toBeHidden();
  await other.waitForFunction(() => window.__strudel?.getState().ready === true, null, { timeout: 30_000 });
  // a built-in of that id exists there: the shared song comes in beside it
  await expect.poll(() => other.evaluate(() => window.__strudel!.getState().songId)).toBe(`${FIXTURE_ID}-shared`);
  expect(await other.evaluate(() => window.__strudel!.currentSource()?.text)).toBe(text);
  expect(await other.evaluate(() => window.__strudel!.getState().playing), "a link never auto-plays").toBe(false);
  expect(errors).toEqual([]);
  await context.close();
});

test("a declined share link runs nothing: Esc or \"don't\", and the stage's keys stay off meanwhile", async ({ player, page, browser }) => {
  test.setTimeout(60_000);
  await player.boot();
  const text = fixtureSource({ name: "Nope" }) + "\n(globalThis as any).__sharedRan = true;\n";
  const url = await page.evaluate((text) => window.__strudel!.store.shareUrl("nope-tune", text), text);

  for (const how of ["Escape", "dont"] as const) {
    const context = await browser.newContext();
    const other = await context.newPage();
    const requests: string[] = [];
    other.on("request", (req) => requests.push(new URL(req.url()).pathname));
    await other.goto(url);
    const dialog = other.getByTestId("share-dialog");
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect(dialog).toContainText("Nope");
    await other.waitForFunction(() => window.__strudel?.getState().ready === true, null, { timeout: 30_000 });
    // E would edit, → would change the song: not while the dialog is up
    const songId = await other.evaluate(() => window.__strudel!.getState().songId);
    await other.keyboard.press("e");
    await other.keyboard.press("ArrowRight");
    await other.keyboard.press("1");
    expect(await other.evaluate(() => window.__strudelEditor!.mode())).toBe("view");
    expect(await other.evaluate(() => window.__strudel!.getState().songId)).toBe(songId);
    expect(await other.evaluate(() => window.__strudel!.muted())).toEqual([]);
    await expect(dialog).toBeVisible();
    if (how === "Escape") await other.keyboard.press("Escape");
    else await other.getByTestId("share-dialog-cancel").click();
    await expect(dialog).toBeHidden();
    await other.waitForTimeout(300);
    expect(await other.evaluate(() => Object.keys(window.__strudel!.songs()))).not.toContain("nope-tune");
    expect(await other.evaluate(() => (globalThis as { __sharedRan?: boolean }).__sharedRan)).toBeUndefined();
    expect(requests.filter((p) => /\/src\/compile\/(client|worker)\.ts$/.test(p)), "the compiler isn't even loaded").toEqual([]);
    await context.close();
  }
});

test("share without clipboard access shows the link to copy by hand", async ({ player, page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new DOMException("denied", "NotAllowedError")) },
    });
  });
  await player.boot();
  expect(await player.select(FIXTURE_ID)).toBe(true);
  await page.getByTestId("code-share").click();
  const dialog = page.getByTestId("share-link");
  await expect(dialog).toBeVisible();
  const field = page.getByTestId("share-link-url");
  await expect(field).toBeFocused();
  const url = await field.inputValue();
  expect(new URL(url).hash).toMatch(/^#song=[A-Za-z0-9_-]+$/);
  const shared = await page.evaluate((hash) => window.__strudel!.store.decodeShare(hash), new URL(url).hash);
  expect(shared).toEqual({ id: FIXTURE_ID, text: await page.evaluate(() => window.__strudel!.currentSource()!.text!) });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("download saves the song's exact text as <id>.ts", async ({ player, page }) => {
  await playFixtureAndEdit(player);
  await caretAfter(page, "// padding line");
  await page.keyboard.type(" ünïcödé ✓ — kept byte for byte");
  const text = await buffer(page);
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("code-download").click()]);
  expect(download.suggestedFilename()).toBe(`${FIXTURE_ID}.ts`);
  expect(readFileSync((await download.path())!, "utf8")).toBe(text);
});

test("the site shows a first-visit hint near the code until it's dismissed or E is used", async ({ player, page }) => {
  await asHostedSite(page);
  await player.boot();
  const hint = page.getByTestId("edit-hint");
  await expect(hint).toBeVisible();
  await expect(hint).toContainText("press E to edit");
  await page.getByTestId("edit-hint-dismiss").click();
  await expect(hint).toBeHidden();
  await page.reload();
  await waitReady(page);
  await page.waitForTimeout(300);
  await expect(hint, "remembered").toBeHidden();

  // a fresh visitor who presses E has found it
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await waitReady(page);
  await expect(hint).toBeVisible();
  await enterEdit(page);
  await expect(hint).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem("strudel-ide:hint-edit"))).toBe("done");
});

test("no hint under the dev server", async ({ player, page }) => {
  await player.boot();
  await page.waitForTimeout(300);
  await expect(page.getByTestId("edit-hint")).toBeHidden();
});

test("the song picker shows a user song's new name after an edit renames it", async ({ player, page }) => {
  test.setTimeout(60_000);
  await player.boot();
  const text = fixtureSource({ name: "Before Name" });
  expect(await page.evaluate((text) => window.__strudel!.addSong("renamed-tune", text), text)).toMatchObject({ ok: true });
  expect(await player.select("renamed-tune")).toBe(true);
  const option = page.locator('#song-select option[value="renamed-tune"]');
  await expect(option).toHaveText("Before Name");
  await enterEdit(page);
  await caretAfter(page, 'name: "Before');
  await page.keyboard.press("Shift+End");
  await page.keyboard.type(' Name After",');
  await expect(option).toHaveText("Before Name After");
});
