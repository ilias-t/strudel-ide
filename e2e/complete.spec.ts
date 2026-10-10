// The editor's completions, hovers and hear-while-browsing (src/ui/complete/: provider.ts,
// values.ts, members.ts, hover.ts, browse.ts), in the real editor over the real catalog:
//   - inside strings: sounds after a space (accepting keeps what was there), variants after
//     "bd:", only the banks that fit, notes, scale types
//   - after a dot: the chain's common methods first, aliases folded (".cuto" shows cutoff → lpf),
//     the ones that don't work here at the bottom with a reason, never struck through
//   - TypeScript's own completions still work (a local const); its values in a string, asked
//     again after the word changed, replace just the word (no stale replacement span)
//   - a hover on a sound has ▶, and clicking it plays (an audition record)
//   - hear while browsing: off by default (arrowing plays nothing, the details pane says how to
//     turn it on); ⌥P turns it on, three fast arrows play one preview, typing plays none,
//     closing stops it, the choice survives a reload, and Monaco's internal hook is there
//
// Screenshots for a human look: COMPLETE_SHOTS=<dir> E2E_PORT=… npx playwright test e2e/complete.spec.ts

import type { Page } from "@playwright/test";
import { FIXTURE_ID } from "./fixture.ts";
import { expect, test, type Player } from "./player.ts";

const SHOTS = process.env.COMPLETE_SHOTS;

test.afterEach(async ({ player }) => {
  expect(player.errors, "console/page errors").toEqual([]);
});

/** Boot, show the fixture song and open it in the editor */
async function editFixture(player: Player) {
  if (SHOTS) await player.page.setViewportSize({ width: 1440, height: 900 });
  await player.boot();
  expect(await player.select(FIXTURE_ID)).toBe(true);
  await enterEdit(player.page);
}

async function enterEdit(page: Page) {
  await page.locator("body").press("e");
  await expect.poll(() => page.evaluate(() => window.__strudelEditor?.loaded() ?? false), { timeout: 30_000 }).toBe(true);
  await expect(page.getByTestId("code-editor").locator(".monaco-editor")).toBeVisible();
  await expect.poll(() => page.evaluate(() => !!window.__strudelComplete)).toBe(true);
}

/** Put the caret `delta` characters into the first `needle` (its end by default) */
async function caretAt(page: Page, needle: string, delta = needle.length) {
  await page.evaluate(
    ([needle, delta]) => {
      const e = window.__strudelEditor!;
      const at = e.value()!.indexOf(needle);
      if (at < 0) throw new Error(`"${needle}" not in the buffer`);
      e.focus(at + delta);
    },
    [needle, delta] as const
  );
}

/** Start a new line of code after the fixture's padding comment and type `code` (Monaco closes quotes and brackets as you go) */
async function typeLine(page: Page, code: string) {
  await closeList(page);
  await caretAt(page, "// padding line");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type(code);
}

const buffer = (page: Page) => page.evaluate(() => window.__strudelEditor!.value()!);
const rows = (page: Page) => page.evaluate(() => window.__strudelComplete!.rows());
const labels = (page: Page) => rows(page).then((r) => r.map((x) => x.label));
const details = (page: Page) => page.evaluate(() => window.__strudelComplete!.details());
const previews = (page: Page) => page.evaluate(() => window.__strudelComplete!.previews());
const auditions = (page: Page) => page.evaluate(() => window.__strudelDiscover!.auditions());
const trigger = (page: Page, id: string) => page.evaluate((id) => window.__strudelComplete!.trigger(id), id);

/** Wait for the suggest list to show rows */
async function listOpen(page: Page) {
  await expect.poll(() => rows(page).then((r) => r.length), { message: "the suggest list" }).toBeGreaterThan(0);
}

async function openList(page: Page) {
  await trigger(page, "editor.action.triggerSuggest");
  await listOpen(page);
}

async function closeList(page: Page) {
  if ((await rows(page)).length) await page.keyboard.press("Escape");
  await expect.poll(() => rows(page).then((r) => r.length)).toBe(0);
}

/** The details pane: open it (⌃Space toggles it while the list shows) */
async function showDetails(page: Page) {
  if ((await details(page)) === null) await trigger(page, "toggleSuggestionDetails");
  await expect.poll(() => details(page)).not.toBeNull();
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

test("inside strings: sounds after a space (accepting keeps bd), variants after bd:, only the banks that fit, notes, scale types", async ({ player, page }) => {
  await editFixture(player);
  const tsCalls = () => page.evaluate(() => window.__strudelComplete!.timings().tsCalls);

  // a space in s("bd |"): registered sounds, drums first, with counts and kinds
  await typeLine(page, 'const t1 = s("bd");');
  await closeList(page);
  await caretAt(page, 's("bd');
  await page.keyboard.type(" ");
  await listOpen(page);
  const sounds = await rows(page);
  expect(sounds[0].description).toBe("kick");
  expect(sounds.map((r) => r.label)).not.toContain("rolandtr909_bd");
  expect(sounds.find((r) => r.label === "bd")).toMatchObject({ detail: " ×8", description: "kick", deprecated: false });
  await shot(page, "sounds-in-string");
  const first = sounds[0].label;
  await page.keyboard.press("Enter");
  expect(await buffer(page)).toContain(`const t1 = s("bd ${first}");`);

  // bd: → its real variants
  await typeLine(page, 'const t2 = s("bd");');
  await closeList(page);
  await caretAt(page, 't2 = s("bd');
  await page.keyboard.type(":");
  await listOpen(page);
  expect(await labels(page)).toEqual(["0", "1", "2", "3", "4", "5", "6", "7"]);

  // .bank("") after s("bd cp"): machines that have both, canonical names first
  await typeLine(page, 'const t3 = s("bd cp").bank("");');
  await closeList(page);
  await caretAt(page, '.bank("');
  await page.waitForTimeout(300); // a TypeScript request from typing the line settles first
  const tsBefore = await tsCalls();
  await openList(page);
  expect(await tsCalls(), "inside strings: our items only, no TypeScript round trip").toBe(tsBefore);
  const banks = await rows(page);
  for (const b of banks) expect(b.description, b.label).toMatch(/^\d+ parts$/);
  expect(banks[0].detail).toBe("");
  await shot(page, "bank-filtered");

  // mini("c |").note(): pitch classes
  await typeLine(page, 'const t4 = mini("c ").note()');
  await caretAt(page, 'mini("c ');
  await openList(page);
  expect((await labels(page)).slice(0, 5)).toEqual(["c", "c#", "db", "d", "d#"]);

  // .scale("C:": the scale types, common ones first
  await typeLine(page, 'const t5 = n("0 2").scale("C:");');
  await closeList(page);
  await caretAt(page, 'scale("C:');
  await openList(page);
  expect((await labels(page)).slice(0, 4)).toEqual(["major", "minor", "dorian", "mixolydian"]);
  await shot(page, "scale-types");
  await closeList(page);

  // a space in code never pops a list
  await typeLine(page, "const zz = ");
  await page.waitForTimeout(400);
  expect(await rows(page)).toEqual([]);
});

test("after a dot: the chain's common methods first, cutoff → lpf, the rest sinks with a reason; TypeScript still completes locals", async ({ player, page }) => {
  await editFixture(player);
  await typeLine(page, 'const d = s("bd").');
  await listOpen(page);
  // what songs use right after s(): completions.json after.s
  expect((await labels(page)).slice(0, 5)).toEqual(["gain", "bank", "hpf", "pan", "room"]);
  const top = await rows(page);
  expect(top.find((r) => r.label === "lpf")).toMatchObject({ detail: " 20–20k Hz", description: "effects", deprecated: false });
  // the details pane: TypeScript's signature and docs, then the catalog's line
  await showDetails(page);
  await expect.poll(() => details(page)).toContain("gain(");
  await expect.poll(() => details(page)).toContain("strudel.cc ↗");
  await shot(page, "members-after-s");

  // an alias that only fits what is typed
  await page.keyboard.type("cuto");
  await expect.poll(() => rows(page).then((r) => r[0])).toMatchObject({ label: "cutoff", detail: " → lpf" });
  await page.keyboard.press("Enter");
  expect(await buffer(page)).toContain('const d = s("bd").cutoff');

  // the bottom of the list: what doesn't work here, with the reason, not struck through
  await typeLine(page, 'const e = s("bd").');
  await listOpen(page);
  await trigger(page, "selectLastSuggestion");
  const reasons = ["SuperDirt only", "visuals", "MIDI/OSC", "internal"];
  await expect.poll(() => rows(page).then((r) => r[r.length - 1].description)).toMatch(/^(SuperDirt only|visuals|MIDI\/OSC|internal)$/);
  const bottom = await rows(page);
  for (const r of bottom.slice(-6)) {
    expect(reasons, r.label).toContain(r.description);
    expect(r.deprecated, r.label).toBe(false);
  }
  expect(await page.locator(".suggest-widget.visible .monaco-list-row .deprecated").count()).toBe(0);
  await closeList(page);

  // TypeScript completes a local (our provider asks its worker outside strings)
  await typeLine(page, "const myLocalThing = 1;");
  await page.keyboard.press("Enter");
  await page.keyboard.type("myLoc");
  await expect.poll(() => labels(page)).toContain("myLocalThing");
  await closeList(page);

  const t = await page.evaluate(() => window.__strudelComplete!.timings());
  console.log(`timings (median ms): in strings ${t.strings?.toFixed(2)}, member post-processing ${t.members?.toFixed(2)}, TypeScript ${t.ts?.toFixed(1)} (${t.tsCalls} calls)`);
});

test("TypeScript's values in a string, asked again after the word changed: accepting one replaces just the word", async ({ player, page }) => {
  await editFixture(player);
  // TypeScript's string items carry a replacement span (the string's text when asked): a later ask must not reuse it
  await typeLine(page, 'const rm: "club" | "dusk" = "cl"; // rm');
  await closeList(page);
  await caretAt(page, '= "cl');
  await openList(page);
  expect(await labels(page)).toContain("club");
  await closeList(page);
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await closeList(page);
  await openList(page);
  expect(await labels(page)).toEqual(expect.arrayContaining(["club", "dusk"]));
  while ((await rows(page)).find((r) => r.focused)?.label !== "club") await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  expect(await buffer(page)).toContain('const rm: "club" | "dusk" = "club"; // rm');
});

test("a hover on a sound shows ▶, and clicking it plays", async ({ player, page }) => {
  await editFixture(player);
  await typeLine(page, 'const h = s("cp");');
  await closeList(page);
  await page.keyboard.press("End");
  const at = (await buffer(page)).indexOf('s("cp")') + 4;
  const p = (await page.evaluate((at) => window.__strudelComplete!.pointAt(at), at))!;
  await page.mouse.move(p.x - 6, p.y);
  await page.mouse.move(p.x + 3, p.y, { steps: 3 });
  const hover = page.locator(".monaco-hover").filter({ hasText: "▶ play" });
  await expect(hover.first()).toBeVisible();
  await expect(hover.first()).toContainText("cp · clap · 2 variants");
  await expect(hover.first()).toContainText("drum machines");
  await shot(page, "hover-sound");
  const before = (await auditions(page)).length;
  await hover.first().getByText("▶ play").click();
  await expect.poll(() => auditions(page).then((a) => a.slice(before).map((r) => [r.label, !!r.preview]))).toEqual([["cp", false]]);
});

/** Preview records (hear while browsing) since `from` */
const previewsSince = (page: Page, from: number) => auditions(page).then((a) => a.slice(from).filter((r) => r.preview));

test("hear while browsing: off by default; ⌥P, three fast arrows: one preview; typing: none; closing stops it; remembered", async ({ player, page }) => {
  await editFixture(player);
  // Monaco's internal suggest widget hook is where it was (fails loudly on an upgrade that moves it)
  expect(await page.evaluate(() => window.__strudelComplete!.hookOk)).toBe(true);
  expect(await previews(page)).toMatchObject({ enabled: false, on: false });

  // a drum machine's parts (its samples load reliably from the CDN)
  await typeLine(page, 'const p = s("bd ").bank("RolandTR909")');
  await closeList(page);
  await caretAt(page, 's("bd ');
  await openList(page);
  expect((await labels(page)).slice(0, 3)).toEqual(["bd", "sd", "cp"]);
  // off: arrowing plays nothing, and the details pane says how to turn it on
  const start = (await auditions(page)).length;
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(600);
  expect(await previewsSince(page, start)).toEqual([]);
  expect((await previews(page)).log.filter((e) => e.type === "preview" || e.type === "prefetch")).toEqual([]);
  await showDetails(page);
  await expect.poll(() => details(page)).toContain("⌥P to hear sounds as you browse");
  await shot(page, "details-hint");

  // ⌥P: on, and the pane says so
  await page.keyboard.press("Alt+KeyP");
  await expect.poll(() => previews(page).then((p) => p.enabled && p.on)).toBe(true);
  expect(await rows(page).then((r) => r.length), "the list stays open").toBeGreaterThan(0);
  await expect.poll(() => details(page)).toMatch(/♪ (previews on arrow|playing as you arrow) · ⌥P mutes/);

  // three fast arrows: one preview, of the row where they stopped
  const on = (await auditions(page)).length;
  // dispatched in one go inside the page, so a busy machine can't space them past the 120 ms pause
  // (Playwright's presses are round trips each: under load two of them were once 120 ms apart)
  await page.evaluate(() => {
    const target = document.activeElement!;
    for (let i = 0; i < 3; i++) {
      for (const type of ["keydown", "keyup"]) {
        target.dispatchEvent(new KeyboardEvent(type, { key: "ArrowDown", code: "ArrowDown", keyCode: 40, which: 40, bubbles: true, cancelable: true }));
      }
    }
  });
  await expect.poll(() => previewsSince(page, on).then((p) => p.length)).toBe(1);
  await page.waitForTimeout(500);
  const [one] = await previewsSince(page, on);
  expect((await previewsSince(page, on)).length).toBe(1);
  const focused = (await rows(page)).find((r) => r.focused)!;
  expect(one.label).toBe(`${focused.label} · RolandTR909`);
  expect(one.events.length === 0 || Number(one.events[0].gain) < 0.8, "quieter than ▶").toBe(true);
  await shot(page, "details-previews-on");

  // typing a letter re-filters the list: no preview
  await page.keyboard.type("h");
  await page.waitForTimeout(500);
  expect((await previewsSince(page, on)).length).toBe(1);

  // closing the list stops a preview
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => previewsSince(page, on).then((p) => p.length)).toBe(2);
  await page.keyboard.press("Escape");
  await expect.poll(() => previews(page).then((p) => p.log[p.log.length - 1]?.type)).toBe("stop");
  await expect.poll(() => previewsSince(page, on).then((p) => p[1].status)).toBe("stopped");

  // remembered
  await page.reload();
  await page.waitForFunction(() => window.__strudel?.getState().ready, null, { timeout: 30_000 });
  // edit mode is remembered too: the editor comes back on its own
  await page.evaluate(() => window.__strudelEditor!.enter());
  await expect.poll(() => page.evaluate(() => !!window.__strudelComplete), { timeout: 30_000 }).toBe(true);
  expect((await previews(page)).enabled).toBe(true);
});
