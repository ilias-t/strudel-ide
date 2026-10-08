// Live eval: the editor sends the unsaved buffer of a song file (`eval`), the
// dev server compiles it as its own Vite module and the player hot-swaps it,
// without anything being written to disk (strudel.cc's Ctrl+Enter).
//   - the buffer plays: swapCount goes up, the file is untouched
//   - highlights/onsets carry the buffer's version and index into the buffer
//   - a syntax or build error in the buffer keeps the old pattern playing
//   - saving the same text afterwards doesn't swap again (or reload)
//   - follow-edits: evaluating another song's buffer selects it
//   - knobs flow both ways over the bridge; write-back refuses buffer-only knobs

import { readFileSync, statSync, writeFileSync } from "node:fs";
import type { HighlightMsg, KnobsMsg, KnobWriteMsg, OnsetsMsg } from "../src/live/protocol.ts";
import { contentVersion } from "../src/live/protocol.ts";
import { EditorClient, type Msg } from "./editor.ts";
import {
  FIXTURE_FILE,
  FIXTURE_ID,
  FIXTURE_PATH,
  KNOB_NAME,
  fixtureSource,
  lineOf,
  writeFixture,
  type FixtureOptions,
} from "./fixture.ts";
import { expect, maxBackwardStep, test, type Player } from "./player.ts";

let editor: EditorClient | undefined;
test.afterEach(() => editor?.close());

const baseURL = () => test.info().project.use.baseURL!;

/** The fixture's lead line, with a token only the buffer has */
const LEAD = `note("c3 e3 g3 b3")`;
const BUFFER_TOKEN = "d4";
const withBufferToken = (source: string) => source.replace(LEAD, `note("c3 e3 g3 b3 ${BUFFER_TOKEN}")`);

async function connect() {
  editor = await EditorClient.connect(baseURL());
  await editor.waitFor((m) => m.type === "player" && m.connected === true, "player connected");
  return editor;
}

async function playFixture(player: Player, fixture: FixtureOptions = {}) {
  await player.boot({ fixture });
  expect(await player.select(FIXTURE_ID)).toBe(true);
  await player.play();
}

/** Every range must slice `text` to a mini-notation token: non-empty, no whitespace or quotes */
function slices(text: string, ranges: [number, number][]) {
  return ranges.map(([a, b]) => text.slice(a, b));
}

test.afterEach(async ({ player }) => {
  expect(player.errors, "console/page errors").toEqual([]);
});

test("an evaluated buffer hot-swaps without writing the file; highlights index into the buffer", async ({ player, page }) => {
  await playFixture(player);
  const ed = await connect();
  const disk = readFileSync(FIXTURE_PATH, "utf8");
  const mtime = statSync(FIXTURE_PATH).mtimeMs;
  const before = await player.state();

  const buffer = withBufferToken(fixtureSource({ gain: 0.3 }));
  const version = contentVersion(buffer);
  const result = await ed.eval(FIXTURE_FILE, buffer);
  expect(result).toMatchObject({ ok: true, applied: true, version });

  const after = await player.state();
  expect(after.swapCount, "one hot-swap").toBe(before.swapCount + 1);
  expect(after.live).toEqual({ file: FIXTURE_FILE, version });
  expect(after.error).toBeNull();
  expect(after.playing).toBe(true);
  await expect.poll(() => player.probe()).toMatchObject({ gain: 0.3 });
  // nothing was written
  expect(readFileSync(FIXTURE_PATH, "utf8")).toBe(disk);
  expect(statSync(FIXTURE_PATH).mtimeMs).toBe(mtime);
  // the editor hears it's a buffer
  await ed.waitFor((m) => m.type === "state" && (m.live as { version?: string } | null)?.version === version, "state.live");

  // highlights carry the buffer's version, and their offsets slice the buffer to tokens
  const tokenAt = buffer.indexOf(`${BUFFER_TOKEN}")`);
  const lit = await ed.waitFor<HighlightMsg & Msg>(
    (m) =>
      m.type === "highlight" &&
      m.version === version &&
      (m as unknown as HighlightMsg).ranges.some(([a, b]) => a === tokenAt && b === tokenAt + BUFFER_TOKEN.length),
    `the buffer-only token "${BUFFER_TOKEN}" lit`,
    { timeout: 8_000 }
  );
  expect(lit.file).toBe(FIXTURE_FILE);
  for (const token of slices(buffer, lit.ranges)) expect(token).toMatch(/^[^\s"'`]+$/);
  const hits = await ed.waitFor<OnsetsMsg & Msg>((m) => m.type === "onsets" && m.version === version, "onsets of the buffer");
  for (const token of slices(buffer, hits.ranges)) expect(token).toMatch(/^[^\s"'`]+$/);

  // the stage shows the buffer, marked unsaved
  await expect(page.getByTestId("code-unsaved")).toBeVisible();
  await expect(page.getByTestId("code-view")).toContainText(`b3 ${BUFFER_TOKEN}`);
  expect(await page.locator("vite-error-overlay").count()).toBe(0);
});

test("a syntax or build error in the buffer keeps the old pattern playing", async ({ player, page }) => {
  await playFixture(player);
  const ed = await connect();
  const good = fixtureSource({ gain: 0.3 });
  expect(await ed.eval(FIXTURE_FILE, good)).toMatchObject({ ok: true });
  await expect.poll(() => player.probe()).toMatchObject({ gain: 0.3 });
  const { swapCount } = await player.state();

  // a syntax error: compiled on the server, never imported by the page
  const broken = fixtureSource({ gain: 0.1 }).replace(".gain(0.1)", ".gain(0.1))");
  const result = await ed.eval(FIXTURE_FILE, broken);
  expect(result.ok).toBe(false);
  await player.waitForError((e) => /syntax error/i.test(e.message) && e.line !== undefined, "syntax error state");
  const { error } = await player.state();
  expect(error).toMatchObject({ kind: "build", keptPrevious: true, line: lineOf(broken, ".gain(0.1))") });
  // …which the editor gets as state.error (its diagnostics)
  await ed.waitFor((m) => m.type === "state" && /syntax error/i.test(String((m.error as { message?: string } | null)?.message)), "error in state");
  expect(await page.locator("vite-error-overlay").count(), "no Vite overlay").toBe(0);
  await player.listen(300);
  expect((await player.state()).swapCount).toBe(swapCount);
  expect(await player.probe(), "still the last good buffer").toMatchObject({ gain: 0.3 });
  expect((await player.state()).live?.version).toBe(contentVersion(good));

  // a build error (createPattern throws): same, and the line is the buffer's
  const throwing = fixtureSource({ gain: 0.2, buildError: true });
  expect((await ed.eval(FIXTURE_FILE, throwing)).ok).toBe(false);
  await player.waitForError((e) => e.message.includes("createPattern failed on purpose"), "build error");
  expect((await player.state()).swapCount).toBe(swapCount);
  expect(await player.probe()).toMatchObject({ gain: 0.3 });

  // fixing it swaps and clears the error
  expect(await ed.eval(FIXTURE_FILE, fixtureSource({ gain: 0.4 }))).toMatchObject({ ok: true, applied: true });
  expect((await player.state()).error).toBeNull();
  await expect.poll(() => player.probe()).toMatchObject({ gain: 0.4 });
  player.clearErrors(); // the build error is logged on purpose
});

test("saving the evaluated text afterwards doesn't swap again or reload", async ({ player, page }) => {
  await playFixture(player);
  const ed = await connect();
  const buffer = fixtureSource({ gain: 0.35 });
  expect(await ed.eval(FIXTURE_FILE, buffer)).toMatchObject({ ok: true, applied: true });
  await page.evaluate(() => ((window as unknown as { __e2eMarker: number }).__e2eMarker = 42));
  const before = await player.state();
  await player.startSampler();

  writeFileSync(FIXTURE_PATH, buffer); // the editor saves
  await expect.poll(async () => (await player.state()).live, { message: "the file took over" }).toBeNull();
  await player.listen(600);
  const samples = await player.stopSampler();
  const after = await player.state();
  expect(after.swapCount, "no second swap").toBe(before.swapCount);
  expect(maxBackwardStep(samples)).toBeLessThanOrEqual(0.01);
  expect(samples.every((s) => s.started)).toBe(true);
  expect(await page.evaluate(() => (window as unknown as { __e2eMarker?: number }).__e2eMarker), "no page reload").toBe(42);
  await expect(page.getByTestId("code-unsaved")).toBeHidden();
  expect(await player.probe()).toMatchObject({ gain: 0.35 });

  // highlights keep the same version across the save (same text)
  const from = ed.messages.length;
  await ed.waitFor((m) => m.type === "highlight" && m.version === contentVersion(buffer) && (m.ranges as unknown[]).length > 0, "highlights after the save", { from });

  // a save with other text than the buffer swaps as usual
  writeFixture({ gain: 0.45 });
  await player.waitForSwapAfter(after.swapCount);
  await expect.poll(() => player.probe()).toMatchObject({ gain: 0.45 });
});

test("follow-edits: evaluating another song's buffer selects and swaps it", async ({ player }) => {
  await player.boot();
  const other = (await player.songIds()).find((id) => id !== FIXTURE_ID)!;
  expect(await player.select(other)).toBe(true);
  await player.play();
  const ed = await connect();

  expect(await ed.eval(FIXTURE_FILE, fixtureSource({ gain: 0.27 }))).toMatchObject({ ok: true, applied: true });
  const state = await player.state();
  expect(state.songId).toBe(FIXTURE_ID);
  expect(state.playing).toBe(true);
  await expect.poll(() => player.probe()).toMatchObject({ gain: 0.27 });

  // Ctrl+Enter on a stopped song: eval with play selects and starts it
  await player.stop();
  await player.select(other);
  expect(await ed.eval(FIXTURE_FILE, fixtureSource({ gain: 0.29 }), { play: true })).toMatchObject({ ok: true });
  await expect.poll(async () => (await player.state()).playing).toBe(true);
  expect((await player.state()).songId).toBe(FIXTURE_ID);
  await expect.poll(() => player.probe()).toMatchObject({ gain: 0.29 });
});

test("knobs flow both ways: knobs messages out, setKnob/resetKnob/grabKnob/writeKnobs in", async ({ player }) => {
  await playFixture(player, { gainKnob: 0.5 });
  const ed = await connect();
  const knobsMsg = (pred: (k: KnobsMsg) => boolean, what: string, from = 0) =>
    ed.waitFor<KnobsMsg & Msg>((m) => m.type === "knobs" && pred(m as unknown as KnobsMsg), what, { from });
  const levelOf = (k: KnobsMsg) => k.knobs.find((x) => x.name === KNOB_NAME);

  const first = await knobsMsg((k) => k.songId === FIXTURE_ID && !!levelOf(k), "the fixture's knobs");
  expect(first.file).toBe(FIXTURE_FILE);
  expect(levelOf(first)).toMatchObject({ value: 0.5, def: 0.5, min: 0, max: 1, dirty: false });

  let from = ed.messages.length;
  ed.send({ command: "setKnob", knob: KNOB_NAME, value: 0.25 });
  expect(levelOf(await knobsMsg((k) => levelOf(k)?.value === 0.25, "turned to 0.25", from))).toMatchObject({ dirty: true });
  await expect.poll(() => player.probe()).toMatchObject({ gain: 0.25 });
  // commands for another song are ignored
  ed.send({ command: "setKnob", knob: KNOB_NAME, value: 0.9, songId: "some-other-song" });

  from = ed.messages.length;
  ed.send({ command: "resetKnob", knob: KNOB_NAME });
  await knobsMsg((k) => levelOf(k)?.value === 0.5 && !levelOf(k)!.dirty, "reset to the file's value", from);

  // grabbed (an editor-side drag): a file edit meanwhile doesn't reset it
  ed.send({ command: "setKnob", knob: KNOB_NAME, value: 0.7 });
  ed.send({ command: "grabKnob", knob: KNOB_NAME, on: true });
  await expect.poll(() => player.probe()).toMatchObject({ gain: 0.7 });
  const { swapCount } = await player.state();
  writeFixture({ gainKnob: 0.4 });
  await player.waitForSwapAfter(swapCount);
  await expect.poll(() => player.probe()).toMatchObject({ gain: 0.7 });
  ed.send({ command: "grabKnob", knob: KNOB_NAME, on: false });

  // writeKnobs: the literal in the file, and the outcome back to the editor
  from = ed.messages.length;
  ed.send({ command: "writeKnobs" });
  const wrote = await ed.waitFor<KnobWriteMsg & Msg>((m) => m.type === "knobWrite", "knobWrite", { from });
  expect(wrote).toMatchObject({ ok: true, file: FIXTURE_FILE, changes: [{ name: KNOB_NAME, literal: "0.7" }] });
  expect(readFileSync(FIXTURE_PATH, "utf8")).toContain(`knob("${KNOB_NAME}", 0.7, 0, 1)`);
  await knobsMsg((k) => levelOf(k)?.def === 0.7 && !levelOf(k)!.dirty, "clean after the write", from);

  // a knob only an evaluated buffer has: it plays, but the file has no call to write
  const buffer = fixtureSource({ gainKnob: 0.7 }).replace(`note("c3 e3 g3 b3")`, `note("c3 e3 g3 b3").pan(knob("width", 0.5, 0, 1))`);
  expect(await ed.eval(FIXTURE_FILE, buffer)).toMatchObject({ ok: true, applied: true });
  from = ed.messages.length;
  await knobsMsg((k) => k.knobs.some((x) => x.name === "width"), "the buffer's knob", 0);
  ed.send({ command: "setKnob", knob: "width", value: 0.2 });
  await expect.poll(() => player.probe()).toMatchObject({ pan: 0.2 });
  const mtime = statSync(FIXTURE_PATH).mtimeMs;
  ed.send({ command: "writeKnobs", knobs: ["width"] });
  const refused = await ed.waitFor<KnobWriteMsg & Msg>((m) => m.type === "knobWrite", "refused write", { from });
  expect(refused.ok).toBe(false);
  expect(refused.error).toMatch(/only in the unsaved editor buffer/);
  // knobs the file has are refused too while unsaved edits play (the editor writes those into its buffer)
  from = ed.messages.length;
  ed.send({ command: "setKnob", knob: KNOB_NAME, value: 0.6 });
  ed.send({ command: "writeKnobs", knobs: [KNOB_NAME] });
  const refused2 = await ed.waitFor<KnobWriteMsg & Msg>((m) => m.type === "knobWrite", "refused write 2", { from });
  expect(refused2).toMatchObject({ ok: false });
  expect(refused2.error).toMatch(/unsaved changes/);
  expect(statSync(FIXTURE_PATH).mtimeMs, "nothing written").toBe(mtime);
  player.clearErrors(); // the browser logs the refused (409) requests
});
