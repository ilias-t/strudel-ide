// Calm warnings in the editor (src/ui/complete/: registry.ts, diagnostics.ts, warnings.ts):
//   - an unknown sound gets one "strudel-sounds" Warning marker with "did you mean", once the caret
//     leaves the word; Ctrl+. then Enter fixes it
//   - nothing while the word is being typed, nothing before the samples are loaded
//   - an unknown bank gets one too
//   - never red: no Error marker from any owner (TypeScript's included) on those words, the
//     underline is dotted (no wavy background), and playing a song with an unknown sound shows
//     no error panel or the amber "trigger" one
//
// Screenshots for a human look: WARN_SHOTS=<dir> E2E_PORT=… npx playwright test e2e/complete-warnings.spec.ts

import type { Page } from "@playwright/test";
import { FIXTURE_ID, writeFixture } from "./fixture.ts";
import { expect, test, type Player } from "./player.ts";

const SHOTS = process.env.WARN_SHOTS;

test.afterEach(async ({ player }) => {
  expect(player.errors, "console/page errors").toEqual([]);
});

/** Boot, show the fixture song and open it in the editor */
async function editFixture(player: Player) {
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

/** Type a new line of code after the fixture's padding comment (Monaco closes quotes and brackets as you go) */
async function typeLine(page: Page, code: string) {
  await caretAt(page, "// padding line");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type(code);
}

const soundMarkers = (page: Page) => page.evaluate(() => window.__strudelComplete!.markers(window.__strudelComplete!.owner));
const buffer = (page: Page) => page.evaluate(() => window.__strudelEditor!.value()!);

/** 1-based line and column range of the first `needle` in the buffer */
async function rangeOf(page: Page, needle: string) {
  const text = await buffer(page);
  const at = text.indexOf(needle);
  expect(at, needle).toBeGreaterThanOrEqual(0);
  const before = text.slice(0, at).split("\n");
  const line = before.length;
  const column = before[before.length - 1].length + 1;
  return { line, start: column, end: column + needle.length };
}

test("an unknown sound: one calm warning once the caret leaves it, and Ctrl+. fixes it", async ({ player, page }) => {
  if (SHOTS) await page.setViewportSize({ width: 1440, height: 900 });
  await editFixture(player);
  await typeLine(page, 'const x = s("bd");');
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.type("d");
  expect(await buffer(page)).toContain('const x = s("bdd");');
  // still typing: the caret is in the word
  await page.waitForTimeout(700);
  await page.evaluate(() => window.__strudelComplete!.flush());
  expect(await soundMarkers(page)).toEqual([]);

  await page.keyboard.press("End"); // the caret leaves the word
  await expect.poll(() => soundMarkers(page).then((m) => m.length)).toBe(1);
  const [m] = await soundMarkers(page);
  const r = await rangeOf(page, 'bdd")');
  expect(m).toMatchObject({ owner: "strudel-sounds", severity: "warning", source: "strudel", startLineNumber: r.line, startColumn: r.start, endColumn: r.start + 3 });
  expect(m.message).toContain('did you mean "bd"');

  if (SHOTS) {
    const box = await page.locator(".code-editor .squiggly-warning").first().boundingBox();
    if (box) {
      await page.mouse.move(box.x + 2, box.y + box.height / 2 - 6);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 5, { steps: 4 });
    }
    await expect(page.locator(".monaco-hover").filter({ hasText: "did you mean" }).first()).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/warning-hover.png` });
    await page.mouse.move(5, 5);
  }

  // back onto the flagged word (not typing): the marker stays, so the quick fix is there
  await caretAt(page, 'bdd")', 1);
  await page.waitForTimeout(1000); // TypeScript's markers settle too (a marker change re-requests code actions)
  expect(await soundMarkers(page)).toHaveLength(1);
  await page.keyboard.press("Control+Period");
  const fix = page.locator(".action-widget").getByText('Change to "bd"');
  await expect(fix).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/warning-quickfix.png` });
  await page.keyboard.press("Enter");
  await expect.poll(() => buffer(page)).toContain('const x = s("bd");');
  await expect.poll(() => soundMarkers(page).then((m) => m.length)).toBe(0);
});

test("nothing before the samples are loaded; the warning comes once they are", async ({ player, page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route("https://strudel.b-cdn.net/**", async (route) => {
    await gate;
    await route.continue();
  });
  writeFixture();
  await page.goto("/");
  await page.waitForFunction(() => !!window.__strudel);
  await page.evaluate((id) => window.__strudel!.selectSong(id), FIXTURE_ID);
  await enterEdit(page);
  expect(await buffer(page)).toContain("// padding line");
  expect(await page.evaluate(() => window.__strudel!.getState().ready)).toBe(false);
  await typeLine(page, 'const x = s("bdd");');
  await page.waitForTimeout(800);
  await page.evaluate(() => window.__strudelComplete!.flush());
  expect(await page.evaluate(() => window.__strudelComplete!.ready())).toBe(false);
  expect(await soundMarkers(page)).toEqual([]);

  release();
  await page.waitForFunction(() => window.__strudel?.getState().ready, null, { timeout: 30_000 });
  await expect.poll(() => soundMarkers(page).then((m) => m.map((x) => x.message)), { timeout: 15_000 }).toEqual([
    'No sound "bdd" — did you mean "bd"?',
  ]);
  await page.unroute("https://strudel.b-cdn.net/**");
});

test("an unknown bank is a warning too", async ({ player, page }) => {
  await editFixture(player);
  await typeLine(page, 'const d = s("bd").bank("RolandTR90");');
  await expect.poll(() => soundMarkers(page).then((m) => m.map((x) => [x.severity, x.message]))).toEqual([
    ["warning", 'No drum machine "RolandTR90" — did you mean "RolandTR909"?'],
  ]);
});

test("never red: no Error marker from anyone on these words, a dotted underline, and an amber panel at most", async ({ player, page }) => {
  await editFixture(player);
  // let TypeScript check the fixture too (it starts with @ts-nocheck)
  const first = await buffer(page);
  expect(first.startsWith("// @ts-nocheck\n")).toBe(true);
  await page.evaluate(() => window.__strudelEditor!.focus(0));
  await page.keyboard.press("Shift+End");
  await page.keyboard.press("Delete");
  expect((await buffer(page)).startsWith("// @ts-nocheck")).toBe(false);

  await typeLine(page, 'const z = n("0 2").scale("C:majr");');
  await typeLine(page, 'const y = s("bd").bank("RolandTR90");');
  await typeLine(page, 'const x = s("bdd");');
  await page.keyboard.press("End");
  await expect.poll(() => soundMarkers(page).then((m) => m.length)).toBeGreaterThanOrEqual(2);
  // TypeScript's worker answers asynchronously
  await page.waitForTimeout(2500);

  const all = await page.evaluate(() => window.__strudelComplete!.markers());
  for (const needle of ["bdd", "RolandTR90", "majr"]) {
    const r = await rangeOf(page, needle);
    const on = all.filter((m) => m.startLineNumber <= r.line && m.endLineNumber >= r.line && m.startColumn < r.end && m.endColumn > r.start);
    expect(
      on.filter((m) => m.severity === "error"),
      `${needle}: ${JSON.stringify(on)}`
    ).toEqual([]);
  }
  const warnings = page.locator(".code-editor .squiggly-warning");
  await expect(warnings.first()).toBeVisible();
  const styles = await warnings.evaluateAll((els) =>
    els.map((el) => {
      const cs = getComputedStyle(el);
      return { image: cs.backgroundImage, border: cs.borderBottomStyle };
    })
  );
  expect(styles.length).toBeGreaterThanOrEqual(2);
  for (const s of styles) expect(s).toEqual({ image: "none", border: "dotted" });
  await expect(page.locator(".code-editor .squiggly-error")).toHaveCount(0);

  // play it with an unknown sound: the player may report a sound error (amber), never a red panel
  await player.play();
  const { swapCount } = await player.state();
  await caretAt(page, '.s("', 4);
  for (let i = 0; i < "triangle".length; i++) await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.type("bdd");
  expect(await buffer(page)).toContain('.s("bdd")');
  await page.keyboard.press("ControlOrMeta+Enter");
  await player.waitForSwapAfter(swapCount);
  await player.listen(1500);
  const panel = page.getByTestId("error-panel");
  if (await panel.isVisible()) await expect(panel).toHaveAttribute("data-kind", "trigger");
  const { error } = await player.state();
  expect(error === null || error.kind === "trigger", JSON.stringify(error)).toBe(true);
  await player.stop();
});
