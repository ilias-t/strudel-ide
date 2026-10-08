// Knobs: knob("level", 0.5, 0, 1) as the fixture's gain. Turning it changes
// the sound without a hot-swap; Write to file rewrites the literal and the
// following swap is seamless; editing the literal resets the knob.

import { readFileSync } from "node:fs";
import { FIXTURE_FILE, FIXTURE_ID, FIXTURE_PATH, KNOB_NAME, writeFixture } from "./fixture.ts";
import { expect, maxBackwardStep, test, type Player } from "./player.ts";

const literal = (value: number) => `knob(${JSON.stringify(KNOB_NAME)}, ${value}, 0, 1)`;

function level(player: Player) {
  return player.page.evaluate((name) => window.__strudel!.knobs().find((k) => k.name === name) ?? null, KNOB_NAME);
}

function setLevel(player: Player, value: number) {
  return player.page.evaluate(([name, value]) => window.__strudel!.setKnob(name, value), [KNOB_NAME, value] as const);
}

async function probeGain(player: Player) {
  return (await player.probe())?.gain;
}

test.beforeEach(async ({ player }) => {
  await player.boot({ fixture: { gainKnob: 0.5 } });
  expect(await player.select(FIXTURE_ID)).toBe(true);
  await player.play();
  await expect.poll(() => level(player)).toMatchObject({ value: 0.5, def: 0.5, min: 0, max: 1, dirty: false });
  expect(await probeGain(player), "the knob's default is the gain").toBe(0.5);
});

test.afterEach(async ({ player }) => {
  expect(player.errors, "console/page errors").toEqual([]);
});

test("dragging the knob changes the gain live, without a hot-swap", async ({ player, page }) => {
  const { swapCount } = await player.state();
  const dial = page.getByTestId("knob").filter({ hasText: KNOB_NAME }).getByTestId("knob-dial");
  await expect(dial).toHaveAttribute("aria-valuenow", "0.5");
  const box = (await dial.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 66, { steps: 8 }); // 66 of 220 px = +0.3
  await page.mouse.up();

  const turned = (await level(player))!;
  expect(turned.value).toBeCloseTo(0.8, 2);
  expect(turned.dirty).toBe(true);
  await expect(dial).toHaveAttribute("aria-valuenow", String(turned.value));
  // the next queried cycle plays the new value; nothing was rebuilt
  await expect.poll(() => probeGain(player)).toBe(turned.value);
  expect((await player.state()).swapCount, "no hot-swap").toBe(swapCount);

  // the chip next to knob(…) in the code shows it, and is marked dirty
  const chip = page.getByTestId("knob-chip");
  await expect(chip).toHaveAttribute("data-value", String(turned.value));
  await expect(chip).toHaveAttribute("data-dirty", "true");

  // keyboard: arrows step, Delete goes back to the file's value
  await dial.focus();
  await page.keyboard.press("ArrowDown");
  await expect.poll(async () => (await level(player))!.value).toBeCloseTo(turned.value - 0.01, 5);
  await page.keyboard.press("Delete");
  await expect.poll(() => level(player)).toMatchObject({ value: 0.5, dirty: false });
  await expect.poll(() => probeGain(player)).toBe(0.5);
  expect((await player.state()).swapCount, "still no hot-swap").toBe(swapCount);
  expect((await player.state()).songId, "arrow keys on a knob don't change the song").toBe(FIXTURE_ID);
});

test("Write to file rewrites the exact literal; the swap is seamless and the knob is clean", async ({ player, page }) => {
  expect(await setLevel(player, 0.25)).toBe(0.25);
  await expect.poll(() => probeGain(player)).toBe(0.25);
  const before = await player.state();
  await player.startSampler();

  await page.getByTestId("knob-write").click();
  await expect.poll(() => readFileSync(FIXTURE_PATH, "utf8"), { message: "file rewritten" }).toContain(`.gain(${literal(0.25)})`);
  await player.waitForSwapAfter(before.swapCount);
  await player.listen(500);
  const samples = await player.stopSampler();

  expect(maxBackwardStep(samples), "the clock never restarted").toBeLessThanOrEqual(0.01);
  expect(samples.every((s) => s.started)).toBe(true);
  expect(await level(player)).toMatchObject({ value: 0.25, def: 0.25, dirty: false });
  expect(await probeGain(player), "same sound after the swap").toBe(0.25);
  await expect(page.getByTestId("knob-write")).toBeHidden();
  expect((await player.state()).error).toBeNull();
});

test("Write all writes every dirty knob in one edit, through the API", async ({ player }) => {
  await setLevel(player, 0.62);
  const before = await player.state();
  const result = await player.page.evaluate(() => window.__strudel!.writeKnobs());
  expect(result).toMatchObject({ ok: true, changes: [{ name: KNOB_NAME, literal: "0.62" }] });
  expect(readFileSync(FIXTURE_PATH, "utf8")).toContain(literal(0.62));
  await player.waitForSwapAfter(before.swapCount);
  await expect.poll(() => level(player)).toMatchObject({ value: 0.62, def: 0.62, dirty: false });
});

test("editing the literal in the file resets the knob", async ({ player }) => {
  await setLevel(player, 0.9);
  const before = await player.state();
  writeFixture({ gainKnob: 0.7 }); // an IDE or agent edit
  await player.waitForSwapAfter(before.swapCount);
  await expect.poll(() => level(player)).toMatchObject({ value: 0.7, def: 0.7, dirty: false });
  expect(await probeGain(player)).toBe(0.7);
});

test("live values survive a reload, unless the file changed meanwhile", async ({ player, page }) => {
  await setLevel(player, 0.33);
  await page.waitForTimeout(400); // persisted after a short debounce
  await page.reload();
  await page.waitForFunction(() => window.__strudel?.getState().ready);
  await expect.poll(() => level(player)).toMatchObject({ value: 0.33, def: 0.5, dirty: true });

  writeFixture({ gainKnob: 0.4 });
  await page.reload();
  await page.waitForFunction(() => window.__strudel?.getState().ready);
  await expect.poll(() => level(player)).toMatchObject({ value: 0.4, def: 0.4, dirty: false });
});

test("the write-back endpoint refuses unknown knobs, non-literals and non-song files", async ({ player, page }) => {
  const source = readFileSync(FIXTURE_PATH, "utf8");
  const post = (data: object) => page.request.post("/__strudel/knob", { data });

  const missing = await post({ file: FIXTURE_FILE, name: "nope", value: 1 });
  expect(missing.status()).toBe(404);
  expect(await missing.json()).toMatchObject({ ok: false, error: expect.stringContaining("nope") });

  const outside = await post({ file: "vite.config.ts", name: KNOB_NAME, value: 1 });
  expect(outside.status()).toBe(403);
  const traversal = await post({ file: "src/songs/../../index.html", name: KNOB_NAME, value: 1 });
  expect(traversal.status()).toBe(403);
  const notANumber = await post({ file: FIXTURE_FILE, name: KNOB_NAME, value: "loud" });
  expect(notANumber.status()).toBe(400);

  expect(readFileSync(FIXTURE_PATH, "utf8"), "nothing written").toBe(source);
  expect((await player.state()).error).toBeNull();
});
