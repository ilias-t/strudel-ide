// Browser eval: song text compiled in the page (src/compile/, a lazily loaded
// worker running the same transforms as the Vite plugins), with no dev-server
// involvement, as on the static host.
//   - evalSource hot-swaps while playing; highlights index into the evaluated
//     text; knobs in it work
//   - intent "typing" never sets the player error; "commit" does
//   - user songs (addSong/removeSong) join the song list and play
//   - the file on disk is never written

import { readFileSync, statSync } from "node:fs";
import { contentVersion } from "../src/live/protocol.ts";
import { FIXTURE_FILE, FIXTURE_ID, FIXTURE_PATH, KNOB_NAME, fixtureSource, lineOf } from "./fixture.ts";
import { expect, test, type Player } from "./player.ts";

/** The fixture's lead line, and a variant with a token only the evaluated text has */
const LEAD = `note("c3 e3 g3 b3")`;
const BROWSER_TOKEN = "d4";
const withBrowserToken = (source: string) => source.replace(LEAD, `note("c3 e3 g3 b3 ${BROWSER_TOKEN}")`);

type EvalOpts = { intent: "typing" | "commit"; origin: "browser" | "editor" };

function evalSource(player: Player, songId: string, text: string, opts: EvalOpts) {
  return player.page.evaluate(([id, text, opts]) => window.__strudel!.evalSource(id, text, opts), [songId, text, opts] as const);
}

async function playFixture(player: Player, fixture: Parameters<Player["boot"]>[0] = {}) {
  await player.boot(fixture);
  expect(await player.select(FIXTURE_ID)).toBe(true);
  await player.play();
}

/** Mark the page so a full reload (e.g. Vite re-optimizing deps for the worker) is caught */
async function markPage(player: Player) {
  await player.page.evaluate(() => ((window as unknown as { __e2eMark: number }).__e2eMark = 1));
}
async function expectSamePage(player: Player) {
  expect(await player.page.evaluate(() => (window as unknown as { __e2eMark?: number }).__e2eMark), "no page reload").toBe(1);
}

test.afterEach(async ({ player }) => {
  expect(player.errors, "console/page errors").toEqual([]);
});

test("evalSource hot-swaps browser-compiled text while playing; highlights land on its tokens; knobs work", async ({ player, page }) => {
  test.setTimeout(60_000);
  await playFixture(player);
  await markPage(player);
  const disk = readFileSync(FIXTURE_PATH, "utf8");
  const mtime = statSync(FIXTURE_PATH).mtimeMs;
  const before = await player.state();

  const text = withBrowserToken(fixtureSource({ gainKnob: 0.4 }));
  const version = contentVersion(text);
  const result = await evalSource(player, FIXTURE_ID, text, { intent: "commit", origin: "browser" });
  expect(result).toEqual({ ok: true, version });

  const after = await player.state();
  expect(after.swapCount, "one hot-swap").toBe(before.swapCount + 1);
  expect(after.playing).toBe(true);
  expect(after.error).toBeNull();
  expect(after.live).toEqual({ file: FIXTURE_FILE, version });
  const source = await page.evaluate(() => window.__strudel!.currentSource());
  expect(source).toEqual({ file: FIXTURE_FILE, text, version, live: true, origin: "browser" });

  // highlights index into the evaluated text: the browser-only token lights up
  const tokenAt = text.indexOf(`${BROWSER_TOKEN}")`);
  await expect
    .poll(() => page.evaluate(() => window.__strudel!.highlights()), { message: `"${BROWSER_TOKEN}" lit`, timeout: 8_000, intervals: [50] })
    .toContainEqual([tokenAt, tokenAt + BROWSER_TOKEN.length]);
  const ranges = await page.evaluate(() => window.__strudel!.highlights());
  for (const [a, b] of ranges) expect(text.slice(a, b)).toMatch(/^[^\s"'`]+$/);

  // the knob in the text: its default is the gain, and turning it changes the sound without a swap
  await expect.poll(() => player.probe()).toMatchObject({ gain: 0.4 });
  await expect
    .poll(() => page.evaluate((name) => window.__strudel!.knobs().find((k) => k.name === name) ?? null, KNOB_NAME))
    .toMatchObject({ def: 0.4, value: 0.4 });
  const { swapCount } = await player.state();
  expect(await page.evaluate((name) => window.__strudel!.setKnob(name, 0.2), KNOB_NAME)).toBe(0.2);
  await expect.poll(() => player.probe()).toMatchObject({ gain: 0.2 });
  expect((await player.state()).swapCount).toBe(swapCount);
  // write-back refuses: the edit only exists in the page
  const write = await page.evaluate(() => window.__strudel!.writeKnobs());
  expect(write.ok).toBe(false);
  expect(write.error).toMatch(/unsaved edits made in the browser/);

  // nothing was written to disk, and the page never reloaded
  expect(readFileSync(FIXTURE_PATH, "utf8")).toBe(disk);
  expect(statSync(FIXTURE_PATH).mtimeMs).toBe(mtime);
  await expectSamePage(player);
  expect(await page.locator("vite-error-overlay").count()).toBe(0);

  // revert: the file plays again
  expect(await page.evaluate((id) => window.__strudel!.revertSource(id), FIXTURE_ID)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__strudel!.currentSource()?.text)).toBe(disk);
  expect((await player.state()).live).toBeNull();
});

test("a typing-intent error is only returned; a commit-intent error shows in the player", async ({ player, page }) => {
  await playFixture(player);
  const good = fixtureSource({ gain: 0.3 });
  expect(await evalSource(player, FIXTURE_ID, good, { intent: "typing", origin: "browser" })).toMatchObject({ ok: true });
  await expect.poll(() => player.probe()).toMatchObject({ gain: 0.3 });
  const { swapCount } = await player.state();

  // a syntax error while typing: returned with its position, no player error, music unchanged
  const broken = fixtureSource({ gain: 0.1 }).replace(".gain(0.1)", ".gain(0.1))");
  const typing = await evalSource(player, FIXTURE_ID, broken, { intent: "typing", origin: "browser" });
  expect(typing.ok).toBe(false);
  if (!typing.ok) {
    expect(typing.error.message).toMatch(/syntax error/i);
    expect(typing.error.line).toBe(lineOf(broken, ".gain(0.1))"));
  }
  // a createPattern() that throws while typing: same
  const throwing = fixtureSource({ gain: 0.2, buildError: true });
  const typingThrow = await evalSource(player, FIXTURE_ID, throwing, { intent: "typing", origin: "browser" });
  expect(typingThrow.ok).toBe(false);
  await player.listen(300);
  let state = await player.state();
  expect(state.error).toBeNull();
  await expect(player.errorPanel()).toBeHidden();
  expect(state.swapCount).toBe(swapCount);
  expect(state.playing).toBe(true);
  expect(await player.probe(), "still the last good text").toMatchObject({ gain: 0.3 });
  expect(await page.evaluate(() => window.__strudel!.currentSource()?.text)).toBe(good);

  // the same syntax error on commit: the player reports it (with its line), still playing the last good text
  const commit = await evalSource(player, FIXTURE_ID, broken, { intent: "commit", origin: "browser" });
  expect(commit.ok).toBe(false);
  state = await player.state();
  expect(state.error).toMatchObject({ kind: "build", keptPrevious: true, line: lineOf(broken, ".gain(0.1))") });
  expect(await player.probe()).toMatchObject({ gain: 0.3 });

  // a good text clears it
  expect(await evalSource(player, FIXTURE_ID, fixtureSource({ gain: 0.25 }), { intent: "typing", origin: "browser" })).toMatchObject({ ok: true });
  expect((await player.state()).error).toBeNull();
  await expect.poll(() => player.probe()).toMatchObject({ gain: 0.25 });
  // the commit error was reported on purpose
  player.clearErrors();
});

test("a runtime error in createPattern is located in the evaluated text", async ({ player }) => {
  await playFixture(player);
  const throwing = fixtureSource({ gain: 0.2, buildError: true });
  const result = await evalSource(player, FIXTURE_ID, throwing, { intent: "commit", origin: "browser" });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.line).toBe(lineOf(throwing, "throw new Error"));
  await player.waitForError((e) => e.line === lineOf(throwing, "throw new Error"), "located build error");
  player.clearErrors();
});

test("addSong registers a user song that plays like a built-in; removeSong drops it", async ({ player, page }) => {
  await player.boot();
  const text = fixtureSource({ name: "My Tune", gain: 0.35 });
  const added = await page.evaluate((text) => window.__strudel!.addSong("my-tune", text), text);
  expect(added).toEqual({ ok: true, version: contentVersion(text) });
  expect(await player.songIds()).toContain("my-tune");
  expect((await player.songIds()).at(-1), "listed after the built-in songs").toBe("my-tune");
  await expect(page.locator("select option[value='my-tune']")).toHaveText("My Tune");

  expect(await player.select("my-tune")).toBe(true);
  await player.play();
  await expect.poll(() => player.probe()).toMatchObject({ gain: 0.35 });
  const state = await player.state();
  expect(state).toMatchObject({ songId: "my-tune", songName: "My Tune", error: null, live: null });
  expect(await page.evaluate(() => window.__strudel!.currentSource())).toMatchObject({
    file: "src/songs/my-tune.ts",
    text,
    live: false,
  });

  // an edit of the user song hot-swaps like any other
  const edited = fixtureSource({ name: "My Tune", gain: 0.15 });
  expect(await evalSource(player, "my-tune", edited, { intent: "commit", origin: "browser" })).toMatchObject({ ok: true });
  await expect.poll(() => player.probe()).toMatchObject({ gain: 0.15 });

  // re-adding the selected song with a text that doesn't build: refused, the old one stays
  const broken = fixtureSource({ name: "My Tune", gain: 0.6, buildError: true });
  const readd = await page.evaluate((text) => window.__strudel!.addSong("my-tune", text), broken);
  expect(readd.ok).toBe(false);
  player.clearErrors(); // the player reports the build error, on purpose
  expect(await page.evaluate(() => window.__strudel!.songs()["my-tune"]?.name)).toBe("My Tune");
  await expect.poll(() => player.probe()).toMatchObject({ gain: 0.15 });
  expect(await page.evaluate(() => window.__strudel!.currentSource()?.text)).toBe(edited);
  await page.evaluate(() => window.__strudel!.selectSong("untitled"));
  await page.evaluate(() => window.__strudel!.selectSong("my-tune"));
  expect((await player.state()).error, "the kept song still builds").toBeNull();

  // built-in ids and bad ids are refused
  for (const id of [FIXTURE_ID, "../x", "Upper", "index"]) {
    const r = await page.evaluate(([id, text]) => window.__strudel!.addSong(id, text), [id, text] as const);
    expect(r.ok, id).toBe(false);
  }
  expect(await page.evaluate(() => window.__strudel!.removeSong("untitled")), "built-in songs stay").toBe(false);

  expect(await page.evaluate(() => window.__strudel!.removeSong("my-tune"))).toBe(true);
  expect(await player.songIds()).not.toContain("my-tune");
  expect((await player.state()).songId).not.toBe("my-tune");
});
