// Live editing: saving the fixture song while it plays hot-swaps it into the
// running scheduler; broken edits never stop the music.

import {
  BOOM_FLAG,
  BUILD_ERROR_MESSAGE,
  FIXTURE_BASENAME,
  FIXTURE_ID,
  QUERY_ERROR_MESSAGE,
  lineOf,
  writeFixture,
} from "./fixture.ts";
import { expect, maxBackwardStep, test, type Player } from "./player.ts";

/**
 * Sampling jitter allowed between consecutive scheduler.now() readings.
 * Strudel extrapolates now() from the last tick; a real restart drops the
 * cycle to ~0, far beyond this.
 */
const JITTER = 0.01;

async function playFixture(player: Player) {
  expect(await player.select(FIXTURE_ID)).toBe(true);
  await player.play();
  expect(await player.probe(), "fixture is playing").toMatchObject({ gain: 0.5 });
}

test.beforeEach(async ({ player }) => {
  await player.boot();
  await playFixture(player);
});

test.afterEach(async ({ player }) => {
  expect(player.errors, "console/page errors").toEqual([]);
});

test("hot-swap keeps the clock running and applies the edit", async ({ player }) => {
  // Play past the first bar so a reset to 0 would be obvious.
  await player.listen(1200);
  const before = await player.state();
  await player.startSampler();

  writeFixture({ gain: 0.25 });
  await player.waitForSwapAfter(before.swapCount);
  await player.listen(1000);
  const samples = await player.stopSampler();
  const after = await player.state();

  expect(samples.length, "samples across the swap").toBeGreaterThan(40);
  expect(samples.every((s) => s.started), "scheduler never stopped").toBe(true);
  expect(maxBackwardStep(samples), "cycle position is monotonic").toBeLessThanOrEqual(JITTER);
  expect(samples[0].cycle).toBeGreaterThanOrEqual(before.cycle - JITTER);
  expect(after.cycle).toBeGreaterThan(before.cycle + 0.3);
  expect(after.playing).toBe(true);
  expect(after.swapCount).toBe(before.swapCount + 1);
  expect(after.error).toBeNull();
  expect(await player.probe(), "new gain in effect").toMatchObject({ gain: 0.25 });
});

test("build error keeps the old pattern playing and points at the line; fixing clears it", async ({ player }) => {
  const before = await player.state();
  const source = writeFixture({ gain: 0.9, buildError: true });
  const line = lineOf(source, BUILD_ERROR_MESSAGE);

  // file/line are resolved asynchronously (source map), so wait for them.
  await player.waitForError((e) => e.line !== undefined, "build error with a location");
  const failing = await player.state();
  expect(failing.error).toMatchObject({
    kind: "build",
    message: BUILD_ERROR_MESSAGE,
    songId: FIXTURE_ID,
    file: FIXTURE_BASENAME,
    line,
    keptPrevious: true,
  });
  expect(failing.playing).toBe(true);
  expect(failing.swapCount, "no swap for a broken edit").toBe(before.swapCount);
  expect(await player.probe(), "old pattern still playing").toMatchObject({ gain: 0.5 });

  // The error is shown in the page, with its location.
  const panel = player.errorPanel();
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(BUILD_ERROR_MESSAGE);
  await expect(panel).toContainText(`${FIXTURE_BASENAME}:${line}`);

  await player.listen(800);
  expect((await player.state()).cycle, "clock still advancing").toBeGreaterThan(failing.cycle + 0.2);

  writeFixture({ gain: 0.9 });
  await player.waitForSwapAfter(before.swapCount);
  const fixed = await player.state();
  expect(fixed.error).toBeNull();
  expect(fixed.playing).toBe(true);
  expect(await player.probe(), "fixed pattern in effect").toMatchObject({ gain: 0.9 });
  await expect(panel).toBeHidden();
});

test("query-time error falls back to the last good pattern", async ({ player, page }) => {
  // Swap in a pattern that throws at query time once BOOM_FLAG is set (it has
  // to pass the player's build-time preflight query first).
  const swaps = (await player.state()).swapCount;
  const source = writeFixture({ gain: 0.75, queryErrorWhenFlagged: true });
  await player.waitForSwapAfter(swaps);
  expect(await player.probe()).toMatchObject({ gain: 0.75 });

  await page.evaluate((flag) => ((window as unknown as Record<string, unknown>)[flag] = true), BOOM_FLAG);
  await player.waitForError((e) => e.kind === "query", "query error");
  // Let the asynchronous location lookup land before reading the error.
  await player.waitForError((e) => e.line !== undefined, "query error with a location");
  const failing = await player.state();
  expect(failing.error).toMatchObject({
    kind: "query",
    message: QUERY_ERROR_MESSAGE,
    songId: FIXTURE_ID,
    file: FIXTURE_BASENAME,
    line: lineOf(source, QUERY_ERROR_MESSAGE),
    keptPrevious: true,
  });
  expect(failing.playing).toBe(true);
  expect(await player.probe(), "fell back to the previous pattern").toMatchObject({ gain: 0.5 });
  await expect(player.errorPanel()).toBeVisible();

  await player.listen(800);
  expect((await player.state()).cycle, "clock still advancing").toBeGreaterThan(failing.cycle + 0.2);

  // Saving a good version clears the error.
  await page.evaluate((flag) => delete (window as unknown as Record<string, unknown>)[flag], BOOM_FLAG);
  writeFixture({ gain: 0.6 });
  await player.waitForSwapAfter(failing.swapCount);
  expect((await player.state()).error).toBeNull();
  expect(await player.probe()).toMatchObject({ gain: 0.6 });
});

test("tempo edit changes cps to bpm/240 without restarting", async ({ player }) => {
  await player.listen(1200);
  const before = await player.state();
  expect(before.cps).toBeCloseTo(120 / 240, 9);
  await player.startSampler();

  writeFixture({ bpm: 90 });
  await player.waitForSwapAfter(before.swapCount);
  await player.listen(500);
  const samples = await player.stopSampler();
  const after = await player.state();

  expect(after.bpm).toBe(90);
  expect(after.cps).toBeCloseTo(90 / 240, 9);
  expect(after.playing).toBe(true);
  expect(after.swapCount).toBe(before.swapCount + 1);
  expect(samples.every((s) => s.started), "scheduler never stopped").toBe(true);
  // Strudel's now() is extrapolated with the *current* cps, so slowing down
  // mid-tick can step it back by a fraction of a tick (~0.05 cycle). Anything
  // near a bar would be a restart.
  expect(maxBackwardStep(samples), "no jump back").toBeLessThan(0.1);
  expect(Math.min(...samples.map((s) => s.cycle))).toBeGreaterThan(before.cycle - 0.1);

  // The clock now advances at the new rate.
  const measured = await player.measureCps(1000);
  expect(measured).toBeGreaterThan((90 / 240) * 0.8);
  expect(measured).toBeLessThan((90 / 240) * 1.25);
});
