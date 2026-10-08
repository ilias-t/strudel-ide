// Edit mode: the song in Monaco on the stage, edited while it plays.
//   - the read-only view is what boots; Monaco is a lazy chunk loaded on E /
//     the edit key / a double-click, and remembered for the next visit
//   - typing is evaluated after a pause (intent "typing"), ⌘/Ctrl+Enter now
//     (intent "commit"); a broken edit is a marker, never the error panel
//   - the code view's live signals work in Monaco: lit ranges, flashes, knob
//     chips, the error line
//   - an IDE's live buffer shows read-only until taken over; a save never
//     silently replaces browser edits
//
// Until the engine has evalSource (the compile stream), the adapter records
// what it was asked to evaluate, and the tests check that instead of a swap.
// Editor state is read through window.__strudelEditor (src/ui/stage.ts).

import { EditorClient } from "./editor.ts";
import { FIXTURE_FILE, FIXTURE_ID, KNOB_NAME, PULSE_TOKEN, fixtureSource, writeFixture, type FixtureOptions } from "./fixture.ts";
import { expect, test, type Player } from "./player.ts";
import type { Page } from "@playwright/test";

const MODE_KEY = "strudel-ide:code-mode";

let ide: EditorClient | undefined;
test.afterEach(() => ide?.close());
test.afterEach(async ({ player }) => {
  expect(player.errors, "console/page errors").toEqual([]);
});

async function playFixture(player: Player, fixture: FixtureOptions = {}) {
  await player.boot({ fixture });
  expect(await player.select(FIXTURE_ID)).toBe(true);
  await player.play();
}

/** Enter edit mode with the E key and wait for Monaco to mount */
async function enterEdit(page: Page) {
  await page.locator("body").press("e");
  await expect.poll(() => page.evaluate(() => window.__strudelEditor?.loaded() ?? false), { timeout: 20_000 }).toBe(true);
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

const typingCalls = (page: Page) =>
  page.evaluate(() => window.__strudelEditor!.calls().filter((c) => c.intent === "typing"));

test("the read-only view boots without Monaco; E loads the editor lazily and is remembered", async ({ player, page }) => {
  await player.boot();
  const loadedModules = () =>
    page.evaluate(() =>
      performance
        .getEntriesByType("resource")
        .map((r) => r.name)
        .filter((n) => /monaco|code-editor|editor-lang/.test(n))
    );
  expect(await loadedModules(), "nothing of the editor at boot").toEqual([]);
  expect(await page.evaluate(() => window.__strudelEditor!.loaded())).toBe(false);
  await expect(page.getByTestId("code-editor")).toBeHidden();
  await expect(page.getByTestId("code-line").first()).toBeVisible();

  await enterEdit(page);
  expect((await loadedModules()).length, "the editor chunk loaded on demand").toBeGreaterThan(0);
  await expect(page.getByTestId("code-edit")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#code-scroll")).toBeHidden();
  expect(await page.evaluate((k) => localStorage.getItem(k), MODE_KEY)).toBe("edit");
  // the read-only view is emptied, so its knob chips don't double the editor's
  await expect(page.locator("#code-lines")).toHaveText("");
  expect(await page.evaluate(() => window.__strudelEditor!.value())).toContain("createPattern()");

  // a returning editor gets the editor without asking
  await page.reload();
  await page.waitForFunction(() => window.__strudel?.getState().ready === true, null, { timeout: 30_000 });
  await expect.poll(() => page.evaluate(() => window.__strudelEditor?.loaded() ?? false), { timeout: 20_000 }).toBe(true);
  await expect(page.getByTestId("code-editor")).toBeVisible();

  // and the edit key goes back to the read-only view
  await page.getByTestId("code-edit").click();
  await expect(page.getByTestId("code-editor")).toBeHidden();
  await expect(page.getByTestId("code-line").first()).toBeVisible();
  expect(await page.evaluate((k) => localStorage.getItem(k), MODE_KEY)).toBe("view");
});

test("a double-click in the code starts editing at that spot", async ({ player, page }) => {
  await player.boot();
  expect(await player.select(FIXTURE_ID)).toBe(true);
  const line = page.getByTestId("code-line").filter({ hasText: "note(" });
  await line.dblclick();
  await expect.poll(() => page.evaluate(() => window.__strudelEditor?.loaded() ?? false), { timeout: 20_000 }).toBe(true);
  await expect(page.getByTestId("code-editor").locator(".monaco-editor textarea")).toBeFocused();
});

test("typing is evaluated after a pause, as a typing edit, while the music plays", async ({ player, page }) => {
  await playFixture(player);
  await enterEdit(page);
  const engine = await page.evaluate(() => window.__strudelEditor!.hasEngine());
  const { swapCount } = await player.state();

  await caretAfter(page, ".gain(0.5");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("3", { delay: 30 });
  await page.keyboard.press("Backspace");
  await page.keyboard.type("4", { delay: 30 });
  const buffer = (await page.evaluate(() => window.__strudelEditor!.value()))!;
  expect(buffer).toContain(".gain(0.4)");

  // one evaluation for the whole burst, of the final text, with typing intent
  await expect.poll(async () => (await typingCalls(page)).length, { message: "a debounced typing eval" }).toBe(1);
  const [call] = await typingCalls(page);
  expect(call).toMatchObject({ songId: FIXTURE_ID, intent: "typing", origin: "browser", text: buffer });

  if (engine) {
    await player.waitForSwapAfter(swapCount);
    await expect.poll(() => player.probe()).toMatchObject({ gain: 0.4 });
  } else {
    // no engine path yet: the edit is not played, and the stage says so
    await expect(page.getByTestId("code-status")).toContainText("not evaluated");
  }
  // the buffer is ahead of what plays (or just swapped in): either way no error panel
  expect((await player.state()).error).toBeNull();
  await expect(page.getByTestId("error-panel")).toBeHidden(); // (Monaco has its own role="alert" regions)
});

test("a broken edit shows a marker and a status, never the error panel", async ({ player, page }) => {
  await playFixture(player);
  await enterEdit(page);
  const engine = await page.evaluate(() => window.__strudelEditor!.hasEngine());
  if (!engine) {
    // stand in for the engine: "((" is a syntax error on its line
    await page.evaluate(() =>
      window.__strudelEditor!.setEngineForTests(async (_id, text) => {
        const at = text.indexOf("((");
        if (at < 0) return { ok: true, version: "test" };
        const before = text.slice(0, at);
        const line = before.split("\n").length;
        return { ok: false, error: { message: "Expression expected.", line, column: at - before.lastIndexOf("\n") } };
      })
    );
  }
  await caretAfter(page, ".gain(");
  await page.keyboard.type("((");
  const brokenLine = (await page.evaluate(() => window.__strudelEditor!.value()))!.split("\n").findIndex((l) => l.includes(".gain(((")) + 1;

  await expect.poll(() => page.evaluate(() => window.__strudelEditor!.markers()), { message: "an eval marker" }).toEqual([
    expect.objectContaining({ line: brokenLine }),
  ]);
  await expect(page.getByTestId("code-status")).toHaveAttribute("data-kind", "error");
  await expect(page.getByTestId("code-status")).toContainText(`line ${brokenLine}`);
  expect((await player.state()).error, "typing never sets the player's error").toBeNull();
  await expect(page.getByTestId("error-panel")).toBeHidden(); // (Monaco has its own role="alert" regions)
  expect((await player.state()).playing).toBe(true);

  // fixing it clears the marker
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await expect.poll(() => page.evaluate(() => window.__strudelEditor!.markers())).toEqual([]);

  // ⌘/Ctrl+Enter evaluates now, as a commit
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect
    .poll(() => page.evaluate(() => window.__strudelEditor!.calls().filter((c) => c.intent === "commit").length))
    .toBe(1);
  if (!engine) await page.evaluate(() => window.__strudelEditor!.setEngineForTests(null));
});

test("lit ranges, flashes and knob chips work in the editor", async ({ player, page }) => {
  await playFixture(player, { gainKnob: 0.5, pulse: true });
  await enterEdit(page);
  const editorEl = page.getByTestId("code-editor");

  // the tokens sounding now are lit, in the playing text's offsets
  await expect.poll(() => page.evaluate(() => window.__strudelEditor!.litRanges().length)).toBeGreaterThan(0);
  await expect(editorEl.locator(".cm-lit").first()).toBeVisible();
  const text = (await page.evaluate(() => window.__strudelEditor!.value()))!;
  const pulseAt = text.indexOf(PULSE_TOKEN);
  // "c4*4" hits four times a bar: it flashes (a hard invert) on the hits
  await expect
    .poll(() => page.evaluate((at) => window.__strudelEditor!.flashing().some(([a]) => a === at), pulseAt), {
      message: "the pulse token flashing",
      intervals: [16],
    })
    .toBe(true);

  // one knob chip, in the editor, with the live value
  const chip = page.getByTestId("knob-chip");
  await expect(chip).toHaveCount(1);
  await expect(editorEl.getByTestId("knob-chip")).toHaveAttribute("data-value", "0.5");
  await expect(chip).toHaveAttribute("data-dirty", "false");
  await page.evaluate(([name]) => window.__strudel!.setKnob(name, 0.8), [KNOB_NAME] as const);
  await expect(chip).toHaveAttribute("data-value", "0.8");
  await expect(chip).toHaveAttribute("data-dirty", "true");
  // it sits on its own gap: the ")" after the call is to its right, not under it
  const chipBox = (await chip.boundingBox())!;
  const closing = editorEl.locator(".cm-chip-slot").first();
  const slot = (await closing.boundingBox())!;
  expect(Math.abs(chipBox.x - slot.x)).toBeLessThan(slot.width / 2);
  expect(chipBox.x + chipBox.width).toBeLessThanOrEqual(slot.x + slot.width + 1);
  // clicking it focuses the knob
  await chip.click();
  await expect(page.getByTestId("knob").filter({ hasText: KNOB_NAME }).getByTestId("knob-dial")).toBeFocused();

  // an edit makes the buffer differ from what plays: highlights stop
  await caretAfter(page, "// padding line");
  await page.keyboard.type("!");
  await expect.poll(() => page.evaluate(() => window.__strudelEditor!.litRanges().length)).toBe(0);
  await expect(editorEl.locator(".cm-lit")).toHaveCount(0);
});

test("the editor follows saves, and shows the player's error line", async ({ player, page }) => {
  await playFixture(player);
  await enterEdit(page);
  const source = writeFixture({ buildError: true });
  await player.waitForError((e) => e.kind === "build", "the build error");
  // nobody typed here: the editor mirrors the saved file
  await expect.poll(() => page.evaluate(() => window.__strudelEditor!.value())).toBe(source);
  await expect(page.getByTestId("code-editor").locator(".cm-error-text").first()).toBeVisible();
  writeFixture();
  await expect.poll(async () => (await player.state()).error).toBeNull();
  await expect(page.getByTestId("code-editor").locator(".cm-error-text")).toHaveCount(0);
});

test("an IDE's live buffer is read-only until taken over; a save never overwrites browser edits", async ({ player, page }) => {
  await playFixture(player);
  await enterEdit(page);
  ide = await EditorClient.connect(test.info().project.use.baseURL!);
  await ide.waitFor((m) => m.type === "player" && m.connected === true, "player connected");

  // the IDE evaluates its unsaved buffer: the browser shows it, read-only
  const theirs = fixtureSource({ gain: 0.3 });
  expect(await ide.eval(FIXTURE_FILE, theirs)).toMatchObject({ ok: true });
  await expect.poll(() => page.evaluate(() => window.__strudelEditor!.value())).toBe(theirs);
  await expect.poll(() => page.evaluate(() => window.__strudelEditor!.session()?.readOnly)).toBe(true);
  await expect(page.getByTestId("code-takeover")).toBeVisible();
  await caretAfter(page, "// padding line");
  await page.keyboard.type("xyz");
  expect(await page.evaluate(() => window.__strudelEditor!.value()), "read-only").toBe(theirs);

  // take over: editable, and typing makes the browser the owner
  await page.getByTestId("code-takeover").click();
  await expect(page.getByTestId("code-takeover")).toBeHidden();
  await caretAfter(page, "// padding line");
  await page.keyboard.type(" (mine)");
  const mine = (await page.evaluate(() => window.__strudelEditor!.value()))!;
  expect(mine).toContain("// padding line (mine)");
  await expect.poll(() => page.evaluate(() => window.__strudelEditor!.session()?.owner)).toBe("browser");

  // a save in the IDE doesn't replace the browser's edits: it offers to load them
  const saved = writeFixture({ gain: 0.2 });
  await expect.poll(async () => (await player.state()).live, { message: "the save replaced the IDE's buffer" }).toBeNull();
  await expect(page.getByTestId("code-load")).toBeVisible();
  expect(await page.evaluate(() => window.__strudelEditor!.value())).toBe(mine);
  await page.getByTestId("code-load").click();
  await expect.poll(() => page.evaluate(() => window.__strudelEditor!.value())).toBe(saved);
  await expect(page.getByTestId("code-load")).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.__strudelEditor!.session()?.owner)).toBe("mirror");
});
