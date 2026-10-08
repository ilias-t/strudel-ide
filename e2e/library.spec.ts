// The library (src/ui/discover/library.ts): a unit over the rack column to
// browse, hear and insert sounds and functions.
//   - B and the file bar's key open it; the rack's units step away while it's
//     open; Esc closes it and gives focus back
//   - its chunk and the catalog JSON load on the first open, not at boot
//   - search filters the tab: banks by name and alias, functions ranked
//   - ▶ auditions while the song plays and while it's stopped (recorded by
//     src/ui/discover/audition.ts: audio itself can't be heard here)
//   - insert from view mode enters edit mode (Monaco loads lazily) and puts
//     the item at the caret, chaining after an expression
//   - keys typed in the editor stay the editor's
// Editor state is read through window.__strudelEditor (src/ui/stage.ts),
// discovery through window.__strudelDiscover (src/ui/discover/hooks.ts).

import type { Page } from "@playwright/test";
import { FIXTURE_ID } from "./fixture.ts";
import { expect, test } from "./player.ts";

test.afterEach(async ({ player }) => {
  expect(player.errors, "console/page errors").toEqual([]);
});

const LAZY = /\/discover\/library|\/catalog\/(sounds|functions)\.json/;

const lazyResources = (page: Page) =>
  page.evaluate(
    (source) =>
      performance
        .getEntriesByType("resource")
        .map((r) => r.name)
        .filter((n) => new RegExp(source).test(n)),
    LAZY.source
  );

const auditions = (page: Page) => page.evaluate(() => window.__strudelDiscover!.auditions());
const lastAudition = async (page: Page) => (await auditions(page)).at(-1);

/** Open the library with B and wait for the catalog to show */
async function openLibrary(page: Page) {
  await page.locator("body").press("b");
  await expect(page.getByTestId("library")).toBeVisible();
  await expect(page.getByTestId("library-sound").first()).toBeVisible();
}

const sound = (page: Page, name: string) => page.locator(`[data-testid=library-sound][data-name="${name}"]`);
const bank = (page: Page, name: string) => page.locator(`[data-testid=library-bank][data-name="${name}"]`);
const fn = (page: Page, name: string) => page.locator(`[data-testid=library-function][data-name="${name}"]`);

const editorLoaded = (page: Page) => page.evaluate(() => window.__strudelEditor?.loaded() ?? false);
const buffer = (page: Page) => page.evaluate(() => window.__strudelEditor!.value()!);

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

test("B opens the library over the rack, lazily; Esc closes it and gives focus back", async ({ player, page }) => {
  await player.boot();
  expect(await lazyResources(page), "nothing of the library at boot").toEqual([]);
  const key = page.getByTestId("library-key");
  await expect(key).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("mixer")).toBeVisible();

  await openLibrary(page);
  await expect(page.getByTestId("mixer"), "the rack steps away").toBeHidden();
  await expect(key).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("library-search"), "search has focus").toBeFocused();
  await expect
    .poll(async () => {
      const names = await lazyResources(page);
      return ["/discover/library", "sounds.json", "functions.json"].every((part) => names.some((n) => n.includes(part)));
    }, { message: "the library chunk and both catalogs load on open" })
    .toBe(true);

  // Esc from a row: closed, the rack is back, focus goes back where it was (nowhere: the page)
  await sound(page, "bd").getByTestId("library-sound-play").focus();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("library")).toBeHidden();
  await expect(page.getByTestId("mixer")).toBeVisible();
  await expect(key).toHaveAttribute("aria-expanded", "false");
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
});

test("the file bar's library key toggles it, and Esc gives the key its focus back", async ({ player, page }) => {
  await player.boot();
  const key = page.getByTestId("library-key");
  await key.click();
  await expect(page.getByTestId("library")).toBeVisible();
  await expect(key).toHaveAttribute("aria-expanded", "true");
  await key.click();
  await expect(page.getByTestId("library")).toBeHidden();
  await expect(page.getByTestId("mixer")).toBeVisible();

  await key.click();
  await expect(page.getByTestId("library-search")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("library")).toBeHidden();
  await expect(key).toBeFocused();

  await key.click();
  await page.getByTestId("library-close").click();
  await expect(page.getByTestId("library")).toBeHidden();
  await expect(key).toHaveAttribute("aria-expanded", "false");
});

test("search: 909 finds the RolandTR909 bank, lpf ranks lpf first among functions", async ({ player, page }) => {
  await player.boot();
  await openLibrary(page);
  const search = page.getByTestId("library-search");

  await search.fill("kick");
  await expect(sound(page, "bd")).toBeVisible();
  await expect(sound(page, "sd")).toHaveCount(0);

  await page.getByTestId("library-view-bank").click();
  await expect(page.getByTestId("library-view-bank")).toHaveAttribute("aria-pressed", "true");
  await search.fill("909");
  await expect(bank(page, "RolandTR909")).toBeVisible();
  await expect(bank(page, "RolandTR808")).toHaveCount(0);
  await expect(bank(page, "RolandTR909").locator("[data-testid=library-bank-part]")).not.toHaveCount(0);

  await page.getByTestId("library-tab-functions").click();
  await expect(page.getByTestId("library-tab-functions")).toHaveAttribute("aria-selected", "true");
  await search.fill("lpf");
  await expect(page.getByTestId("library-function").first()).toHaveAttribute("data-name", "lpf");

  // cleared: categories with counts; one opens to its functions
  await search.fill("");
  const effects = page.locator("[data-testid=library-category][data-id=effects]");
  await expect(effects).toHaveAttribute("aria-expanded", "false");
  await effects.click();
  await expect(effects).toHaveAttribute("aria-expanded", "true");
  await expect(fn(page, "lpf")).toBeVisible();
});

test("▶ auditions while stopped, then while the song plays, without touching the song", async ({ player, page }) => {
  await player.boot();
  await openLibrary(page);

  await sound(page, "bd").getByTestId("library-sound-play").click();
  await expect.poll(async () => (await lastAudition(page))?.events[0]).toMatchObject({ s: "bd" });
  expect((await lastAudition(page))?.status).not.toBe("error");

  expect(await player.select(FIXTURE_ID)).toBe(true);
  await player.play();
  const { swapCount } = await player.state();

  await page.getByTestId("library-view-bank").click();
  await page.getByTestId("library-search").fill("909");
  await bank(page, "RolandTR909").getByTestId("library-bank-play").click();
  await expect.poll(async () => (await lastAudition(page))?.events[0]).toMatchObject({ s: "bd", bank: "RolandTR909" });
  expect((await lastAudition(page))?.status).not.toBe("error");

  await bank(page, "RolandTR909").locator("[data-testid=library-bank-part][data-part=sd]").click();
  await expect.poll(async () => (await lastAudition(page))?.events[0]).toMatchObject({ s: "sd", bank: "RolandTR909" });

  const state = await player.state();
  expect(state.playing, "the song keeps playing").toBe(true);
  expect(state.swapCount, "no swap for an audition").toBe(swapCount);
});

test("an example's ▶ plays it once as a pattern; a second press stops it", async ({ player, page }) => {
  // a slow song: the one-bar preview lasts 8 s, long enough to stop it
  await player.boot({ fixture: { bpm: 30 } });
  expect(await player.select(FIXTURE_ID)).toBe(true);
  await openLibrary(page);
  await page.getByTestId("library-tab-functions").click();
  await page.getByTestId("library-search").fill("lpf");
  const lpf = fn(page, "lpf");
  await lpf.getByTestId("library-function-toggle").click();
  await expect(lpf.getByTestId("library-function-toggle")).toHaveAttribute("aria-expanded", "true");
  const example = lpf.getByTestId("library-example").first();
  await expect(example).toContainText('s("bd sd [~ bd] sd,hh*6")');

  const play = example.getByTestId("library-example-play");
  await play.click();
  await expect.poll(async () => (await lastAudition(page))?.kind).toBe("pattern");
  await expect.poll(async () => (await lastAudition(page))?.events.length ?? 0, { message: "haps handed to the engine" }).toBeGreaterThan(0);
  const rec = (await lastAudition(page))!;
  expect(rec.status).not.toBe("error");
  expect(rec.label).toContain("lpf");
  expect(rec.events.some((e) => e.s === "bd" && "cutoff" in e)).toBe(true);
  await expect(play).toHaveAttribute("data-playing", "true");

  await play.click();
  await expect(play).not.toHaveAttribute("data-playing", "true");
  await expect.poll(async () => (await auditions(page)).find((r) => r.id === rec.id)?.status).toBe("stopped");
});

test("insert from view mode: edit mode turns on, Monaco loads, and items chain at the caret", async ({ player, page }) => {
  await player.boot();
  expect(await player.select(FIXTURE_ID)).toBe(true);
  expect(await editorLoaded(page)).toBe(false);
  await openLibrary(page);

  // no caret placed yet: on its own line above createPattern()'s return
  const insertBd = sound(page, "bd").getByTestId("library-sound-insert");
  await insertBd.click();
  await expect.poll(() => editorLoaded(page), { timeout: 30_000 }).toBe(true);
  await expect(page.getByTestId("code-edit")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => buffer(page)).toMatch(/\n\s*s\("bd"\)\n\s*return \{ lead \}/);
  // the editor was just shown: the inserted line is in view, not scrolled past
  await expect(page.getByTestId("code-editor").locator(".view-line", { hasText: 's("bd")' })).toBeVisible();
  await expect(insertBd, "focus stays in the library").toBeFocused();
  await expect(page.getByTestId("library")).toBeVisible();

  // after an expression: chained
  await caretAfter(page, ".gain(0.5)");
  await page.getByTestId("library-view-bank").click();
  await page.getByTestId("library-search").fill("909");
  await bank(page, "RolandTR909").getByTestId("library-bank-insert").click();
  await expect.poll(() => buffer(page)).toContain('.gain(0.5).bank("RolandTR909")');

  await page.getByTestId("library-tab-functions").click();
  await page.getByTestId("library-search").fill("lpf");
  await fn(page, "lpf").getByTestId("library-function-insert").click();
  await expect.poll(() => buffer(page)).toContain('.gain(0.5).bank("RolandTR909").lpf()');

  // an example goes in as written, at the caret
  await caretAfter(page, "return { lead };");
  await page.keyboard.press("Enter");
  const lpf = fn(page, "lpf");
  await lpf.getByTestId("library-function-toggle").click();
  await lpf.getByTestId("library-example-insert").first().click();
  await expect.poll(() => buffer(page)).toMatch(/return \{ lead \};\n\s*s\("bd sd \[~ bd\] sd,hh\*6"\)\.lpf\("<4000 2000 1000 500 200 100>"\)/);
});

test("keys: B typed in the editor is a b; arrows in the library never step the song; letters go to the search", async ({ player, page }) => {
  await player.boot();
  expect(await player.select(FIXTURE_ID)).toBe(true);
  await page.locator("body").press("e");
  await expect.poll(() => editorLoaded(page), { timeout: 30_000 }).toBe(true);
  await caretAfter(page, 'note("c3');
  await page.keyboard.type(" b");
  await expect.poll(() => buffer(page)).toContain('note("c3 b e3');
  expect(await page.evaluate(() => window.__strudelDiscover!.isOpen("library"))).toBe(false);
  await expect(page.getByTestId("library")).toBeHidden();

  // the library key, then Esc: back in the editor
  await page.getByTestId("library-key").click();
  await expect(page.getByTestId("library-search")).toBeFocused();
  const play = sound(page, "bd").getByTestId("library-sound-play");
  await play.focus();
  const song = (await player.state()).songId;
  await page.keyboard.press("ArrowRight");
  await expect(sound(page, "bd").getByTestId("library-sound-insert")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowLeft");
  expect((await player.state()).songId, "no song stepping from the library").toBe(song);

  await page.keyboard.press("9");
  await expect(page.getByTestId("library-search")).toBeFocused();
  await expect(page.getByTestId("library-search")).toHaveValue("9");
  await page.getByTestId("library-search").fill("");

  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("library-sound-play").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("library")).toBeHidden();
});
