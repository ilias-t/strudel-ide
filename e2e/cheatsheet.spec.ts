// The cheat sheet (src/ui/discover/cheatsheet.ts): one docs overlay with tabs
// Mini-notation · Functions · Sounds · Keys, opened by ?, the top bar's ?,
// the file bar's help key and F1 in the editor.
//   - it opens on Mini-notation (the thing you look up mid-song), with the
//     search focused; its chunk loads on the first open, not at boot
//   - every tab renders rows; the tabs are a tablist (arrows, Home, End)
//   - ▶ plays an example or a sound (recorded by src/ui/discover/audition.ts)
//   - insert puts an example at the editor's caret, closes the sheet and
//     gives the editor the keyboard
//   - Esc closes it and gives focus back where it was: the key that opened
//     it, or the editor with its caret where it was
//   - search covers every tab; "more" opens the library on that category
//   - at phone width (390 px) nothing scrolls sideways
// Discovery state through window.__strudelDiscover (src/ui/discover/hooks.ts),
// the editor through window.__strudelEditor (src/ui/stage.ts).

import type { Page } from "@playwright/test";
import { FIXTURE_ID } from "./fixture.ts";
import { expect, test } from "./player.ts";

test.afterEach(async ({ player }) => {
  expect(player.errors, "console/page errors").toEqual([]);
});

const sheet = (page: Page) => page.getByTestId("help-overlay");
const tab = (page: Page, id: string) => page.getByTestId(`cheat-tab-${id}`);
const panel = (page: Page, id: string) => page.getByTestId(`cheat-panel-${id}`);
const row = (page: Page, kind: string, id: string) => page.locator(`[data-testid=cheat-row][data-kind=${kind}][data-id="${id}"]`);
const search = (page: Page) => page.getByTestId("cheat-search");
const auditions = (page: Page) => page.evaluate(() => window.__strudelDiscover!.auditions());
const lastAudition = async (page: Page) => (await auditions(page)).at(-1);
const editorLoaded = (page: Page) => page.evaluate(() => window.__strudelEditor?.loaded() ?? false);
const buffer = (page: Page) => page.evaluate(() => window.__strudelEditor!.value()!);
const cheatResources = (page: Page) =>
  page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .map((r) => r.name)
      .filter((n) => /\/discover\/cheatsheet/.test(n))
  );

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

async function enterEdit(page: Page) {
  await page.locator("body").press("e");
  await expect.poll(() => editorLoaded(page), { timeout: 30_000 }).toBe(true);
}

test("? opens it on Mini-notation, lazily, with the search focused; the tabs are a tablist", async ({ player, page }) => {
  await player.boot();
  expect(await cheatResources(page), "nothing of the cheat sheet at boot").toEqual([]);
  expect(await page.evaluate(() => window.__strudelDiscover!.loaded())).toEqual([]);

  await page.locator("body").press("?");
  await expect(sheet(page)).toBeVisible();
  const dialog = sheet(page).getByRole("dialog");
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect(search(page)).toBeFocused();
  await expect(search(page), "the ? that opened it isn't typed into the search").toHaveValue("");
  await expect(tab(page, "mini")).toHaveAttribute("aria-selected", "true");
  await expect(row(page, "mini", "subdivide")).toBeVisible();
  expect(await page.getByTestId("cheat-row").and(page.locator("[data-kind=mini]")).count()).toBeGreaterThanOrEqual(14);
  expect((await cheatResources(page)).length, "its chunk loaded on open").toBeGreaterThan(0);
  expect(await page.evaluate(() => window.__strudelDiscover!.isOpen("cheatsheet"))).toBe(true);
  await expect(page.getByTestId("help-button")).toHaveAttribute("aria-expanded", "true");

  // arrows move along the tablist, Home and End jump; each tab shows its panel
  await tab(page, "mini").focus();
  await page.keyboard.press("ArrowRight");
  await expect(tab(page, "functions")).toBeFocused();
  await expect(tab(page, "functions")).toHaveAttribute("aria-selected", "true");
  await expect(panel(page, "functions")).toBeVisible();
  await expect(panel(page, "mini")).toBeHidden();
  await page.keyboard.press("End");
  await expect(tab(page, "keys")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowRight");
  await expect(tab(page, "mini")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowLeft");
  await expect(tab(page, "keys")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Home");
  await expect(tab(page, "mini")).toHaveAttribute("aria-selected", "true");

  // Esc: closed, focus back where it was (the page)
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toBeHidden();
  await expect(page.getByTestId("help-button")).toHaveAttribute("aria-expanded", "false");
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
});

test("each tab renders its rows: functions in groups with links, sounds by family, every key", async ({ player, page }) => {
  await player.boot();
  await page.locator("body").press("?");
  await expect(row(page, "mini", "rest")).toBeVisible();
  await expect(row(page, "mini", "rest").getByTestId("cheat-doc")).toHaveAttribute("href", "https://strudel.cc/learn/mini-notation/#rests");

  await tab(page, "functions").click();
  const groups = panel(page, "functions").getByTestId("cheat-group");
  await expect(groups).toHaveCount(8);
  await expect(groups.first()).toContainText("Rhythm");
  expect(await panel(page, "functions").getByTestId("cheat-row").count()).toBeGreaterThanOrEqual(55);
  const lpf = row(page, "function", "lpf");
  await expect(lpf).toContainText(".lpf");
  await expect(lpf).toContainText('note("c2 c3").s("sawtooth").lpf(800)');
  await expect(lpf.getByTestId("cheat-doc")).toHaveAttribute("href", /^https:\/\/strudel\.cc\/learn\/effects\/#lpf$/);
  await expect(lpf.getByTestId("cheat-doc")).toHaveAttribute("target", "_blank");

  await tab(page, "sounds").click();
  await expect(row(page, "sound", "bd")).toBeVisible();
  await expect(row(page, "sound", "RolandTR909")).toBeVisible();
  await expect(panel(page, "sounds").getByTestId("cheat-family").first()).toContainText("Kick");

  await tab(page, "keys").click();
  const keys = panel(page, "keys");
  for (const text of ["Play / stop", "Previous / next song", "Mute track 1–9", "Solo track 1–9", "Loop the current section", "Command palette", "Library"])
    await expect(keys).toContainText(text);
  for (const text of ["Space", "F1", "Ctrl", "⌥"]) await expect(keys).toContainText(text);
  await expect(keys).toContainText("suggestions");
  await expect(keys).toContainText("quick fix");
  await expect(keys).toContainText("hear sounds as you browse");
});

test("▶ plays a mini-notation example and a sound; a second press on an example stops it", async ({ player, page }) => {
  await player.boot({ fixture: { bpm: 30 } });
  expect(await player.select(FIXTURE_ID)).toBe(true);
  await page.locator("body").press("?");
  const play = row(page, "mini", "subdivide").getByTestId("cheat-play");
  await play.click();
  await expect.poll(async () => (await lastAudition(page))?.kind).toBe("pattern");
  await expect.poll(async () => (await lastAudition(page))?.events.length ?? 0, { message: "haps handed to the engine" }).toBeGreaterThan(0);
  const rec = (await lastAudition(page))!;
  expect(rec.status).not.toBe("error");
  expect(rec.events[0]).toMatchObject({ s: "bd" }); // s("bd [sd sd]"): the rest follows at the song's tempo
  await expect(play).toHaveAttribute("data-playing", "true");
  await play.click();
  await expect(play).not.toHaveAttribute("data-playing", "true");
  await expect.poll(async () => (await auditions(page)).find((r) => r.id === rec.id)?.status).toBe("stopped");

  await tab(page, "sounds").click();
  await row(page, "sound", "bd").getByTestId("cheat-play").click();
  await expect.poll(async () => (await lastAudition(page))?.events[0]).toMatchObject({ s: "bd" });
  await row(page, "sound", "RolandTR909").getByTestId("cheat-play").click();
  await expect.poll(async () => (await lastAudition(page))?.events[0]).toMatchObject({ s: "bd", bank: "RolandTR909" });

  await tab(page, "functions").click();
  await row(page, "function", "lpf").getByTestId("cheat-play").click();
  await expect.poll(async () => (await lastAudition(page))?.events.some((e) => "cutoff" in e) ?? false).toBe(true);
  expect((await lastAudition(page))?.status).not.toBe("error");
});

test("insert puts an example at the editor's caret, closes the sheet and hands the editor the keyboard", async ({ player, page }) => {
  await player.boot();
  expect(await player.select(FIXTURE_ID)).toBe(true);
  await enterEdit(page);
  await caretAfter(page, "return { lead };");
  await page.keyboard.press("Enter");

  await page.getByTestId("help-key").click();
  await expect(sheet(page)).toBeVisible();
  await row(page, "mini", "rest").getByTestId("cheat-insert").click();
  await expect.poll(() => buffer(page)).toMatch(/return \{ lead \};\n\s*s\("bd ~ sd ~"\)/);
  await expect(sheet(page)).toBeHidden();
  await expect(page.locator("[data-testid=code-editor] textarea.inputarea")).toBeFocused();

  // right after an expression an example doesn't fit: refused, and the sheet stays open and says so
  await caretAfter(page, 's("bd ~ sd ~")');
  await page.keyboard.press("F1");
  await expect(sheet(page)).toBeVisible();
  await tab(page, "functions").click();
  await row(page, "function", "fast").getByTestId("cheat-insert").click();
  await expect(page.getByTestId("cheat-status")).toContainText("couldn't insert");
  await expect(sheet(page)).toBeVisible();
  expect(await buffer(page)).not.toContain('s("bd sd").fast(2)');
});

test("insert from the read-only view enters editing first, like the library", async ({ player, page }) => {
  await player.boot();
  expect(await player.select(FIXTURE_ID)).toBe(true);
  expect(await editorLoaded(page)).toBe(false);
  await page.locator("body").press("?");
  await row(page, "mini", "euclid").getByTestId("cheat-insert").click();
  await expect.poll(() => editorLoaded(page), { timeout: 30_000 }).toBe(true);
  await expect(page.getByTestId("code-edit")).toHaveAttribute("aria-pressed", "true");
  // no caret placed yet: on its own line above createPattern()'s return
  await expect.poll(() => buffer(page)).toMatch(/\n\s*s\("bd\(3,8\)"\)\n\s*return \{ lead \}/);
  await expect(sheet(page)).toBeHidden();
});

test("the file bar's help key opens it; Esc gives the key its focus back", async ({ player, page }) => {
  await player.boot();
  const key = page.getByTestId("help-key");
  await expect(key).toHaveAttribute("aria-expanded", "false");
  await key.click();
  await expect(sheet(page)).toBeVisible();
  await expect(key).toHaveAttribute("aria-expanded", "true");
  await expect(search(page)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toBeHidden();
  await expect(key).toBeFocused();
  await expect(key).toHaveAttribute("aria-expanded", "false");

  // the top bar's ? toggles it too, and its close key closes it
  await page.getByTestId("help-button").click();
  await expect(sheet(page)).toBeVisible();
  await page.getByTestId("help-close").click();
  await expect(sheet(page)).toBeHidden();
  await expect(page.getByTestId("help-button")).toBeFocused();
});

test("F1 in the editor opens it; Esc puts the caret back where it was", async ({ player, page }) => {
  await player.boot();
  expect(await player.select(FIXTURE_ID)).toBe(true);
  await enterEdit(page);
  await caretAfter(page, 'note("c3');
  await page.keyboard.press("F1");
  await expect(sheet(page)).toBeVisible();
  await expect(search(page)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toBeHidden();
  await expect(page.locator("[data-testid=code-editor] textarea.inputarea")).toBeFocused();
  await page.keyboard.type("X");
  await expect.poll(() => buffer(page)).toContain('note("c3X e3');
});

test("search covers every tab; keys inside never reach the stage; more opens the library on that category", async ({ player, page }) => {
  await player.boot();
  expect(await player.select(FIXTURE_ID)).toBe(true);
  await page.locator("body").press("?");
  await expect(row(page, "mini", "rest")).toBeVisible();

  await search(page).fill("lpf");
  const results = page.getByTestId("cheat-results");
  await expect(results).toBeVisible();
  await expect(results.getByTestId("cheat-row").first()).toHaveAttribute("data-id", "lpf");
  await search(page).fill("rest");
  await expect(results.locator("[data-kind=mini]").first()).toHaveAttribute("data-id", "rest");
  await search(page).fill("palette");
  await expect(results.locator("[data-kind=key]").first()).toContainText("palette");
  await search(page).fill("909");
  await expect(results.locator('[data-kind=sound][data-id="RolandTR909"]')).toBeVisible();
  await search(page).fill("");
  await expect(results).toBeHidden();
  await expect(panel(page, "mini")).toBeVisible();

  // arrows, digits and letters on a row stay in the sheet: no song stepping, no muting
  const song = (await player.state()).songId;
  await row(page, "mini", "rest").getByTestId("cheat-play").focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowDown");
  expect((await player.state()).songId, "no song stepping from the sheet").toBe(song);
  await page.keyboard.press("1");
  await expect(search(page)).toBeFocused();
  await expect(search(page)).toHaveValue("1");
  expect((await player.state()).muted ?? []).toEqual([]);
  await search(page).fill("");

  // more: the library's Functions tab, on that category
  await tab(page, "functions").click();
  await panel(page, "functions").locator("[data-testid=cheat-group][data-id=filter]").getByTestId("cheat-more").click();
  await expect(sheet(page)).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.__strudelDiscover!.isOpen("library"))).toBe(true);
  await expect(page.getByTestId("library-tab-functions")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("[data-testid=library-category][data-id=effects]")).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator('[data-testid=library-function][data-name="lpf"]')).toBeVisible();
});

test("at phone width (390×844) nothing scrolls sideways and every tab is reachable", async ({ player, page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await player.boot();
  await page.getByTestId("help-button").click();
  await expect(row(page, "mini", "rest")).toBeVisible();
  const overflow = () =>
    page.evaluate(() => {
      const card = document.querySelector<HTMLElement>("#help-overlay [role=dialog]")!;
      const out: string[] = [];
      if (document.documentElement.scrollWidth > innerWidth) out.push(`page ${document.documentElement.scrollWidth} > ${innerWidth}`);
      if (card.scrollWidth > card.clientWidth + 1) out.push(`card ${card.scrollWidth} > ${card.clientWidth}`);
      const r = card.getBoundingClientRect();
      if (r.left < 0 || r.right > innerWidth) out.push(`card at ${r.left}–${r.right}`);
      for (const el of card.querySelectorAll<HTMLElement>("*")) {
        const b = el.getBoundingClientRect();
        if (b.width && (b.right > r.right + 1 || b.left < r.left - 1) && el.offsetParent !== null) {
          out.push(`${el.tagName}.${el.className} ${Math.round(b.left)}–${Math.round(b.right)}`);
          if (out.length > 5) break;
        }
      }
      return out;
    });
  for (const id of ["mini", "functions", "sounds", "keys"]) {
    await tab(page, id).click();
    await expect(panel(page, id)).toBeVisible();
    await expect(tab(page, id)).toBeInViewport();
    expect(await overflow(), `${id}: horizontal overflow`).toEqual([]);
  }
  await search(page).fill("delay");
  await expect(page.getByTestId("cheat-results")).toBeVisible();
  expect(await overflow(), "results: horizontal overflow").toEqual([]);
});

test('with the real catalog: function rows show ranges, and an idea answers "wetter" first', async ({ player, page }) => {
  await player.boot();
  await page.locator("body").press("?");
  await tab(page, "functions").click();
  await expect(row(page, "function", "lpf")).toContainText("20–20000 Hz");
  await expect(row(page, "function", "room")).toContainText("0–1");

  await search(page).fill("wetter");
  const results = page.getByTestId("cheat-results");
  const first = results.getByTestId("cheat-row").first();
  await expect(first).toHaveAttribute("data-kind", "intent");
  await expect(first).toHaveAttribute("data-id", "wetter");
  await expect(first).toContainText("room");
  await search(page).fill("acid bass");
  await expect(results.getByTestId("cheat-row").first()).toHaveAttribute("data-kind", "intent");
});

test("the catalog arriving while a search result has the keyboard: it keeps it, and keys still never reach the stage", async ({ player, page }) => {
  // hold the catalog back until a result has the keyboard
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(/\/src\/catalog\/(sounds|completions|intents)\.json/, async (route) => {
    await held;
    await route.continue();
  });
  await player.boot();
  expect(await player.select(FIXTURE_ID)).toBe(true);
  await page.locator("body").press("?");
  await search(page).fill("rest");
  const results = page.getByTestId("cheat-results");
  await expect(results.locator("[data-kind=mini]").first()).toHaveAttribute("data-id", "rest");
  await search(page).press("ArrowDown");
  const play = results.locator('[data-kind=mini][data-id="rest"]').getByTestId("cheat-play");
  await expect(play).toBeFocused();

  const arrived = Promise.all(["sounds", "completions", "intents"].map((n) => page.waitForResponse((r) => r.url().includes(`/src/catalog/${n}.json`))));
  release(); // the results render again as each file comes in
  await arrived;
  await page.waitForTimeout(300);
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest("#help-card")), { message: "focus stays in the sheet" }).toBe(true);
  await expect(play).toBeFocused();
  await page.keyboard.press("1");
  expect((await player.state()).muted ?? [], "no muting from under the sheet").toEqual([]);
  await expect(sheet(page)).toBeVisible();

  // focus fallen out of the sheet some other way: the stage still ignores keys while it's open (? still closes it)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const song = (await player.state()).songId;
  for (const key of ["1", "ArrowRight", "c", "l"]) await page.keyboard.press(key);
  expect((await player.state()).muted ?? [], "no muting").toEqual([]);
  expect((await player.state()).songId, "no song stepping").toBe(song);
  await expect(sheet(page)).toBeVisible();
  await page.keyboard.press("?");
  await expect(sheet(page)).toBeHidden();
});
