// The command palette (⌘/Ctrl+K, src/ui/discover/palette.ts):
//   - a lazy chunk: neither it nor the catalog loads before the first open
//   - opens from view mode and from inside Monaco (the palette wins over
//     Monaco's ⌘K chords), as an ARIA combobox over a listbox of options
//   - fuzzy search over actions, songs, sounds, banks, functions, snippets
//   - Enter runs an action, switches song or inserts at the caret (entering
//     edit mode first); Shift+Enter auditions; Esc closes and gives focus back
//   - the stage's shortcuts never fire under it
//   - search by sound: intent rows (wobble, wetter, acid bass) play, insert
//     and open the track builder; the sound previews action is remembered

import type { Locator, Page } from "@playwright/test";
import { FIXTURE_ID } from "./fixture.ts";
import { expect, test } from "./player.ts";

test.afterEach(async ({ player }) => {
  expect(player.errors, "console/page errors").toEqual([]);
});

const input = (page: Page) => page.getByTestId("palette-input");
const options = (page: Page) => page.getByTestId("palette-option");
const isOpen = (page: Page) => page.evaluate(() => window.__strudelDiscover?.isOpen("palette") ?? false);

/** Open with Control+K and wait for the input to have focus */
async function openPalette(page: Page) {
  await page.keyboard.press("Control+k");
  await expect(input(page)).toBeFocused();
}

/** Wait until the catalog is in (the "loading…" row is gone) */
async function catalogLoaded(page: Page) {
  await expect(page.getByTestId("palette-loading")).toHaveCount(0, { timeout: 20_000 });
}

/** Type a query and wait for `first` to be the top result */
async function search(page: Page, query: string, first: { kind: string; id: string }) {
  await input(page).fill(query);
  await expect(options(page).first()).toHaveAttribute("data-kind", first.kind);
  await expect(options(page).first()).toHaveAttribute("data-id", first.id);
}

async function enterEdit(page: Page) {
  await page.locator("body").press("e");
  await expect.poll(() => page.evaluate(() => window.__strudelEditor?.loaded() ?? false), { timeout: 30_000 }).toBe(true);
  await expect(page.getByTestId("code-editor").locator(".monaco-editor")).toBeVisible();
}

const editorText = (page: Page) => page.evaluate(() => window.__strudelEditor!.value()!);

async function activeId(page: Page, list: Locator) {
  const id = await input(page).getAttribute("aria-activedescendant");
  expect(id, "aria-activedescendant").toBeTruthy();
  await expect(list.locator(`#${id}`)).toHaveAttribute("aria-selected", "true");
  return id!;
}

test("lazy until the first ⌘K; then a combobox over a listbox, the active option following the arrows", async ({ player, page }) => {
  await player.boot();
  const discoverResources = () =>
    page.evaluate(() =>
      performance
        .getEntriesByType("resource")
        .map((r) => r.name)
        .filter((n) => /discover\/palette|discover\/fuzzy|catalog\/\w+\.json/.test(n))
    );
  expect(await discoverResources(), "nothing of the palette at boot").toEqual([]);
  expect(await page.evaluate(() => window.__strudelDiscover!.loaded())).not.toContain("palette");
  await expect(page.getByTestId("palette")).toBeHidden();

  await openPalette(page);
  expect(await isOpen(page)).toBe(true);
  expect(await page.evaluate(() => window.__strudelDiscover!.loaded())).toContain("palette");
  expect((await discoverResources()).length, "the chunk and the catalog load on demand").toBeGreaterThan(0);

  const box = input(page);
  await expect(box).toHaveAttribute("role", "combobox");
  await expect(box).toHaveAttribute("aria-autocomplete", "list");
  await expect(box).toHaveAttribute("aria-controls", "palette-list");
  await expect(box).toHaveAttribute("aria-expanded", "true");
  const list = page.getByRole("listbox", { name: "Results" });
  await expect(list).toHaveAttribute("id", "palette-list");
  await expect(list.getByRole("option").first()).toBeVisible();
  await expect(list.getByRole("group").first()).toHaveAccessibleName("Actions");

  // actions and songs at once, the catalog behind them
  await expect(options(page).first()).toHaveAttribute("data-kind", "action");
  await expect(page.locator('[data-testid="palette-option"][data-kind="song"]').first()).toBeVisible();
  await catalogLoaded(page);
  await expect(page.getByTestId("palette-hint")).toContainText("functions");
  await expect(page.getByTestId("palette-status")).toHaveText(/\d+ actions and songs/);

  const first = await activeId(page, list);
  expect(first).toBe(await options(page).first().getAttribute("id"));
  await page.keyboard.press("ArrowDown");
  const second = await activeId(page, list);
  expect(second).toBe(await options(page).nth(1).getAttribute("id"));
  await expect(page.locator(`#${first}`)).toHaveAttribute("aria-selected", "false");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp"); // wraps to the last
  expect(await activeId(page, list)).toBe(await options(page).last().getAttribute("id"));

  // Tab stays in the palette
  await page.keyboard.press("Tab");
  await expect(box).toBeFocused();

  // ⌘K again closes
  await page.keyboard.press("Control+k");
  await expect(page.getByTestId("palette")).toBeHidden();
  expect(await isOpen(page)).toBe(false);
});

test("search: 909 finds the TR-909, lpf the function, nonsense says so", async ({ player, page }) => {
  await player.boot();
  await openPalette(page);
  await catalogLoaded(page);

  await input(page).fill("909");
  const top = options(page).first();
  await expect(top).toHaveAttribute("data-id", "RolandTR909");
  await expect(top).toHaveAttribute("data-kind", "bank");
  await expect(top.locator("mark")).toHaveText(["909"]);

  await search(page, "lpf", { kind: "function", id: "lpf" });
  await expect(options(page).first()).toContainText("low-pass");

  // a synonym finds it too
  await input(page).fill("cutoff");
  await expect(page.locator('[data-testid="palette-option"][data-kind="function"][data-id="lpf"]')).toBeVisible();

  await input(page).fill("qqqzzzxxx");
  await expect(page.getByTestId("palette-empty")).toBeVisible();
  await expect(options(page)).toHaveCount(0);
  await expect(input(page)).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("palette-status")).toHaveText("no results");
});

test("⌘K inside Monaco opens the palette (the buffer untouched); Enter inserts at the caret", async ({ player, page }) => {
  await player.boot();
  expect(await player.select(FIXTURE_ID)).toBe(true);
  await enterEdit(page);
  const before = await editorText(page);
  await page.evaluate(() => {
    const e = window.__strudelEditor!;
    const text = e.value()!;
    e.focus(text.indexOf(".gain(0.5)") + ".gain(0.5)".length);
  });
  await expect(page.getByTestId("code-editor").locator(".monaco-editor textarea")).toBeFocused();

  await openPalette(page);
  expect(await editorText(page), "Monaco didn't take the ⌘K").toBe(before);
  await catalogLoaded(page);
  await search(page, "lpf", { kind: "function", id: "lpf" });
  await page.keyboard.press("Enter");

  await expect(page.getByTestId("palette")).toBeHidden();
  await expect.poll(() => editorText(page)).toContain(".gain(0.5).lpf()");
  await expect(page.getByTestId("code-editor").locator(".monaco-editor textarea")).toBeFocused();
});

test("from view mode, Enter on a drum machine switches to edit mode and inserts it", async ({ player, page }) => {
  await player.boot();
  expect(await player.select(FIXTURE_ID)).toBe(true);
  expect(await page.evaluate(() => window.__strudelEditor!.mode())).toBe("view");
  await openPalette(page);
  await catalogLoaded(page);
  await search(page, "RolandTR909", { kind: "bank", id: "RolandTR909" });
  await page.keyboard.press("Enter");

  await expect(page.getByTestId("palette")).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.__strudelEditor!.mode())).toBe("edit");
  await expect.poll(() => page.evaluate(() => window.__strudelEditor!.loaded()), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => editorText(page)).toContain('s("bd").bank("RolandTR909")');
  await expect(page.getByTestId("code-editor").locator(".monaco-editor textarea")).toBeFocused();
});

test("actions: play/stop, loop, jump to a section", async ({ player, page }) => {
  await player.boot({ fixture: { sections: true } });
  expect(await player.select(FIXTURE_ID)).toBe(true);

  await openPalette(page);
  await search(page, "play", { kind: "action", id: "play" });
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("palette")).toBeHidden();
  await expect.poll(async () => (await player.state()).playing).toBe(true);

  await openPalette(page);
  await search(page, "loop this", { kind: "action", id: "loop" });
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await player.state()).loop).toBe(true);

  await openPalette(page);
  await search(page, "jump b", { kind: "action", id: "section:1" });
  await expect(options(page).first()).toContainText("jump to section b");
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => {
      const s = await player.state();
      return s.pendingJump?.index ?? s.section?.index;
    })
    .toBe(1);

  await openPalette(page);
  await search(page, "stop", { kind: "action", id: "play" });
  await expect(options(page).first()).toContainText("stop");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await player.state()).playing).toBe(false);
});

test("switching song", async ({ player, page }) => {
  await player.boot();
  expect(await player.select(FIXTURE_ID)).toBe(true);
  const other = await page.evaluate((fixture) => {
    const songs = window.__strudel!.songs();
    const id = Object.keys(songs).find((id) => id !== fixture)!;
    return { id, name: songs[id].name };
  }, FIXTURE_ID);

  await openPalette(page);
  // the current song is marked
  await expect(page.locator(`[data-testid="palette-option"][data-kind="song"][data-id="${FIXTURE_ID}"]`)).toHaveAttribute(
    "data-current",
    "true"
  );
  await search(page, other.name, { kind: "song", id: other.id });
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await player.state()).songId).toBe(other.id);
});

test("Shift+Enter auditions a sound and keeps the palette open", async ({ player, page }) => {
  await player.boot();
  await openPalette(page);
  await catalogLoaded(page);
  await search(page, "bd", { kind: "sound", id: "bd" });
  const before = (await page.evaluate(() => window.__strudelDiscover!.auditions())).length;
  await page.keyboard.press("Shift+Enter");
  await expect
    .poll(async () => {
      const recs = await page.evaluate(() => window.__strudelDiscover!.auditions());
      return recs.length > before ? recs[recs.length - 1].label : null;
    })
    .toBe("bd");
  expect(await isOpen(page)).toBe(true);
  await expect(input(page)).toBeFocused();
});

test("Esc closes and gives focus back; so does a click on the dim", async ({ player, page }) => {
  await player.boot();
  const help = page.getByTestId("help-button");
  await help.focus();
  await openPalette(page);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("palette")).toBeHidden();
  await expect(help).toBeFocused();
  await expect(page.getByTestId("help-overlay")).toBeHidden();

  await openPalette(page);
  await page.getByTestId("palette").click({ position: { x: 10, y: 10 } });
  await expect(page.getByTestId("palette")).toBeHidden();
  await expect(help).toBeFocused();
});

test("the stage's shortcuts don't fire while the palette is open", async ({ player, page }) => {
  await player.boot({ fixture: { sections: true } });
  expect(await player.select(FIXTURE_ID)).toBe(true);
  await player.play();
  await openPalette(page);

  // typed into the search: no mute, no stop, no loop
  await page.keyboard.type("1 l");
  await expect(input(page)).toHaveValue("1 l");
  // and keys that reach the panel or the page outside the input
  await page.evaluate(() => {
    const send = (target: EventTarget, key: string, code: string) =>
      target.dispatchEvent(new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true }));
    send(document.getElementById("palette")!, "1", "Digit1");
    send(document.getElementById("palette")!, "l", "KeyL");
    send(document.body, " ", "Space");
    send(document.body, "1", "Digit1");
    send(document.body, "b", "KeyB");
  });
  const s = await player.state();
  expect(s.muted, "no track muted").toEqual([]);
  expect(s.loop, "loop untouched").toBe(false);
  expect(s.playing, "still playing").toBe(true);
  expect(await page.evaluate(() => window.__strudelDiscover!.isOpen("library"))).toBe(false);
  await expect(input(page)).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("palette")).toBeHidden();
  expect((await player.state()).playing).toBe(true);
});

// ── search by sound ─────────────────────────────────────────────────────────

/** The kind:id of the first `n` rows */
const topRows = (page: Page, n: number) =>
  options(page).evaluateAll((els, n) => els.slice(0, n).map((e) => `${e.getAttribute("data-kind")}:${e.getAttribute("data-id")}`), n);

test("search by sound: wobble is an intent row; Shift+Enter plays its recipe and keeps the palette open", async ({ player, page }) => {
  await player.boot();
  await openPalette(page);
  await catalogLoaded(page);
  await search(page, "wobble", { kind: "intent", id: "wobble" });
  const row = options(page).first();
  await expect(row).toContainText("→ lpf · sine · range · segment");
  await expect(row).toContainText("a sine on the cutoff");
  await expect(page.locator("#palette-group-intent")).toHaveText("By sound");

  const before = (await page.evaluate(() => window.__strudelDiscover!.auditions())).length;
  await page.keyboard.press("Shift+Enter");
  await expect
    .poll(async () => {
      const recs = await page.evaluate(() => window.__strudelDiscover!.auditions());
      return recs.length > before ? { label: recs[recs.length - 1].label, kind: recs[recs.length - 1].kind } : null;
    })
    .toEqual({ label: "wobble", kind: "pattern" });
  expect(await isOpen(page)).toBe(true);
  await expect(input(page)).toBeFocused();
});

test("search by sound: reverb puts wetter first and room among the top rows; ⌥Enter on acid bass opens the track builder", async ({ player, page }) => {
  await player.boot();
  await openPalette(page);
  await catalogLoaded(page);
  await search(page, "reverb", { kind: "intent", id: "wetter" });
  const rows = await topRows(page, 8);
  expect(rows, rows.join(", ")).toContain("function:room");
  expect(rows.some((r) => r.startsWith("snippet:")), rows.join(", ")).toBe(false);
  // room says why it's here
  await expect(page.locator('[data-testid="palette-option"][data-kind="function"][data-id="room"]')).toContainText("for “reverb”");

  // an intent with a role: ⌥Enter opens the track builder on its snippet
  await search(page, "acid bass", { kind: "intent", id: "acid-bass" });
  await page.keyboard.press("Alt+Enter");
  await expect(page.getByTestId("palette")).toBeHidden();
  await expect(page.locator("[data-testid=builder-role][data-role=acid]")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("[data-testid=builder-snippet][data-id=acid-303-line]")).toHaveAttribute("aria-pressed", "true");
});

test("search by sound: Enter on wetter after an expression inserts .room(0.5)", async ({ player, page }) => {
  await player.boot();
  expect(await player.select(FIXTURE_ID)).toBe(true);
  await enterEdit(page);
  await page.evaluate(() => {
    const e = window.__strudelEditor!;
    const text = e.value()!;
    e.focus(text.indexOf(".gain(0.5)") + ".gain(0.5)".length);
  });
  await openPalette(page);
  await catalogLoaded(page);
  await search(page, "wetter", { kind: "intent", id: "wetter" });
  await page.keyboard.press("Enter");

  await expect(page.getByTestId("palette")).toBeHidden();
  await expect.poll(() => editorText(page)).toContain(".gain(0.5).room(0.5)");
  await expect(page.getByTestId("code-editor").locator(".monaco-editor textarea")).toBeFocused();
});

test("the sound previews action says its state, flips it, and is remembered after a reload", async ({ player, page }) => {
  await player.boot();
  await openPalette(page);
  await search(page, "sound previews", { kind: "action", id: "previews" });
  await expect(options(page).first()).toContainText("sound previews: off");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("palette")).toBeHidden();

  await openPalette(page);
  await search(page, "sound previews", { kind: "action", id: "previews" });
  await expect(options(page).first()).toContainText("sound previews: on");
  await page.keyboard.press("Escape");

  await page.reload();
  await page.waitForFunction(
    () => {
      const s = window.__strudel?.getState();
      return !!s && s.ready && s.loading === null;
    },
    null,
    { timeout: 30_000 }
  );
  await openPalette(page);
  await search(page, "sound previews", { kind: "action", id: "previews" });
  await expect(options(page).first()).toContainText("sound previews: on");
  // and back off
  await page.keyboard.press("Enter");
  await openPalette(page);
  await search(page, "sound previews", { kind: "action", id: "previews" });
  await expect(options(page).first()).toContainText("sound previews: off");
});
