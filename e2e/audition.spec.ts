// Auditions are bounded, and previews are quiet, keyed and never stack
// (src/ui/discover/audition.ts, values in src/ui/discover/audition-values.ts).
//   - ▶ in the library on bassdrum2 (a 26 s sample) hands superdough a
//     bounded one-shot: a release and a ~1.2 s duration, not the whole file
//   - a browse preview of piano plays the note it's given, 12 dB under ▶
//     (18 dB while the song plays)
//   - a preview waits for its sample (briefly): it plays when the load is
//     quick, gives up silently when it isn't, and two quick previews leave
//     only the second
//   - a sample that fails to load is "couldn't load this sample", with no
//     console error
//   - a new preview silences a synth still sounding (cut groups are the
//     sampler's only), and a stop silences what plays
// Audio itself can't be heard here: the audition record (window.__strudelDiscover)
// holds the values handed to superdough, with the duration it was given.
// Sample files are served by the test (a short generated WAV) so nothing
// depends on the sample hosts.

import type { Page, Route } from "@playwright/test";
import type { AuditionRecord, SoundOptions } from "../src/ui/discover/audition.ts";
import { FIXTURE_ID } from "./fixture.ts";
import { expect, test } from "./player.ts";

test.afterEach(async ({ player }) => {
  expect(player.errors, "console/page errors").toEqual([]);
});

/** A mono 16-bit WAV of `seconds` of a quiet sine */
function wav(seconds = 0.5, rate = 22050): Buffer {
  const n = Math.round(seconds * rate);
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(800 * Math.sin((2 * Math.PI * 220 * i) / rate)), 44 + i * 2);
  return b;
}

/** Sample files whose path has `fragment` (as requested, percent-encoded) */
const fileOf = (fragment: string) => (url: URL) => url.pathname.includes(fragment);
const BASSDRUM2 = fileOf("/Bass%20Drum%202/");
const PIANO = fileOf("/dough-samples/main/piano/");

/** Serve those files from here, after `delay` ms */
async function serveSamples(page: Page, match: (url: URL) => boolean, delay = 0) {
  await page.route(match, async (route: Route) => {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    await route.fulfill({ status: 200, contentType: "audio/wav", body: wav() }).catch(() => {});
  });
}

const auditions = (page: Page) => page.evaluate(() => window.__strudelDiscover!.auditions());
const lastAudition = async (page: Page) => (await auditions(page)).at(-1);
const byId = async (page: Page, id: number) => (await auditions(page)).find((r) => r.id === id);

const AUDITION = "/src/ui/discover/audition.ts";
type AuditionModule = typeof import("../src/ui/discover/audition.ts");

/** auditionSound() in the page (the module the app uses): resolves with the record's id */
const audition = (page: Page, name: string, opts: SoundOptions) =>
  page.evaluate(
    async ([url, name, opts]) => {
      const m = (await import(/* @vite-ignore */ url)) as AuditionModule;
      return (await m.auditionSound(name, opts)).id;
    },
    [AUDITION, name, opts] as const
  );

/** Two previews, the second started right after the first (no await between): their ids */
const twoPreviews = (page: Page, first: [string, SoundOptions], second: [string, SoundOptions]) =>
  page.evaluate(
    async ([url, first, second]) => {
      const m = (await import(/* @vite-ignore */ url)) as AuditionModule;
      const a = m.auditionSound(...first);
      const b = m.auditionSound(...second);
      return [(await a).id, (await b).id];
    },
    [AUDITION, first, second] as const
  );

const prefetch = (page: Page, name: string, opts: SoundOptions) =>
  page.evaluate(
    async ([url, name, opts]) => ((await import(/* @vite-ignore */ url)) as AuditionModule).prefetchSound(name, opts),
    [AUDITION, name, opts] as const
  );

const db = (ratio: number) => 20 * Math.log10(ratio);
const first = (rec: AuditionRecord | undefined) => rec?.events[0] ?? {};

test("▶ on bassdrum2 hands over a bounded one-shot, not the 26 s sample", async ({ player, page }) => {
  await serveSamples(page, BASSDRUM2);
  await player.boot();
  await page.locator("body").press("b");
  await expect(page.getByTestId("library")).toBeVisible();
  await page.getByTestId("library-search").fill("bassdrum2");
  const row = page.locator('[data-testid=library-sound][data-name="bassdrum2"]');
  await row.getByTestId("library-sound-play").click();

  await expect.poll(async () => first(await lastAudition(page))).toMatchObject({ s: "bassdrum2", orbit: 64 });
  const rec = (await lastAudition(page))!;
  expect(rec.status).not.toBe("error");
  const event = rec.events[0];
  // superdough plays the whole sample unless the value carries a release (sampler.mjs onTriggerSample)
  expect(typeof event.release).toBe("number");
  expect(typeof event.duration).toBe("number");
  const total = Number(event.duration) + Number(event.release);
  expect(total).toBeGreaterThanOrEqual(1);
  expect(total).toBeLessThanOrEqual(1.5);
  expect(event.gain).toBe(0.8);
  expect("note" in event, "a drum never gets a note").toBe(false);
  // done once the one-shot has ended
  await expect.poll(async () => (await byId(page, rec.id))?.status, { timeout: 4000 }).toBe("done");
});

test("a preview of piano plays the note it's given, 12 dB under ▶, 18 dB while the song plays", async ({ player, page }) => {
  await serveSamples(page, PIANO);
  await player.boot();

  const click = await audition(page, "piano", { pitched: true });
  const quiet = await audition(page, "piano", { pitched: true, preview: true, note: "d3" });
  const clickEvent = first(await byId(page, click));
  const quietEvent = first(await byId(page, quiet));
  expect(quietEvent).toMatchObject({ s: "piano", note: "d3", orbit: 64 });
  expect(clickEvent.note, "▶ plays c3").toBe(48);
  expect(db(Number(quietEvent.gain) / Number(clickEvent.gain))).toBeCloseTo(-12, 0);
  expect(Number(quietEvent.duration) + Number(quietEvent.release)).toBeLessThanOrEqual(0.7);

  expect(await player.select(FIXTURE_ID)).toBe(true);
  await player.play();
  const underSong = await audition(page, "piano", { pitched: true, preview: true, note: 50 });
  const underEvent = first(await byId(page, underSong));
  expect(underEvent.note).toBe(50);
  expect(db(Number(underEvent.gain) / Number(clickEvent.gain))).toBeCloseTo(-18, 0);
  expect((await player.state()).playing, "the song keeps playing").toBe(true);
});

test("a preview plays when its sample loads in time and gives up silently when it doesn't", async ({ player, page }) => {
  await serveSamples(page, PIANO, 150);
  await serveSamples(page, BASSDRUM2, 1500);
  await player.boot();

  const quick = await audition(page, "piano", { pitched: true, preview: true });
  expect(first(await byId(page, quick))).toMatchObject({ s: "piano", note: 48 });

  const slow = await audition(page, "bassdrum2", { preview: true });
  const rec = (await byId(page, slow))!;
  expect(rec.events, "nothing handed over").toEqual([]);
  expect(rec.status, "given up, not an error").toBe("stopped");
  expect(rec.error).toBeUndefined();

  // the load carried on: once it's in, the same preview plays at once
  expect(await prefetch(page, "bassdrum2", {})).toBe(true);
  const again = await audition(page, "bassdrum2", { preview: true });
  expect(first(await byId(page, again))).toMatchObject({ s: "bassdrum2" });
});

test("two quick previews leave only the second playing", async ({ player, page }) => {
  await serveSamples(page, PIANO, 100);
  await player.boot();
  const [a, b] = await twoPreviews(page, ["piano", { pitched: true, preview: true, note: 48 }], ["piano", { pitched: true, preview: true, note: 55 }]);
  const recA = (await byId(page, a))!;
  const recB = (await byId(page, b))!;
  expect(recA.status).toBe("stopped");
  expect(recA.events).toEqual([]);
  expect(recB.events).toHaveLength(1);
  expect(recB.events[0]).toMatchObject({ s: "piano", note: 55 });
  expect(recB.status).not.toBe("error");
});

/** Both kinds of audition on a sample that won't load: "couldn't load this sample", nothing handed over */
async function expectLoadFailure(page: Page) {
  for (const preview of [true, false]) {
    const id = await audition(page, "bassdrum2", { preview });
    const rec = (await byId(page, id))!;
    expect(rec.status).toBe("error");
    expect(rec.error).toBe("couldn't load this sample");
    expect(rec.events, "nothing handed to superdough").toEqual([]);
  }
  expect(await prefetch(page, "bassdrum2", {})).toBe(false);
}

test("a sample that doesn't decode: \"couldn't load this sample\", no console error", async ({ player, page }) => {
  await page.route(BASSDRUM2, (route) => route.fulfill({ status: 200, contentType: "audio/wav", body: "not a wav file" }));
  await player.boot();
  await expectLoadFailure(page);
});

test("a sample that 404s: \"couldn't load this sample\", and only the browser's own network line", async ({ player, page }) => {
  await page.route(BASSDRUM2, (route) => route.fulfill({ status: 404, contentType: "text/plain", body: "not found" }));
  await player.boot();
  await expectLoadFailure(page);
  // Chromium reports the 404 itself (once: superdough caches the failed load); the app logs nothing
  expect(player.errors).toEqual(["Failed to load resource: the server responded with a status of 404 (Not Found)"]);
  player.clearErrors();
});

/** The audition voices sounding or fading now (src/ui/discover/audition-voices.ts), tagged with their record's id */
const voices = (page: Page) =>
  page.evaluate(async (url) => ((await import(/* @vite-ignore */ url)) as AuditionModule).auditionVoices(), AUDITION);

test("a new preview silences a synth still sounding (superdough's cut group only chokes samples)", async ({ player, page }) => {
  await player.boot();
  const sine = await audition(page, "sine", { pitched: true, preview: true });
  expect(await voices(page)).toContainEqual({ tag: sine, gain: 1, cut: false });
  await page.waitForTimeout(200); // well inside the sine's ~0.7 s
  const square = await audition(page, "square", { pitched: true, preview: true });
  // the sine fades out in a few ms (and leaves once stopped); the square plays on
  await expect.poll(async () => (await voices(page)).filter((v) => v.gain > 0.01).map((v) => v.tag), { timeout: 2000 }).toEqual([square]);
  expect((await voices(page)).find((v) => v.tag === sine)?.cut ?? true).toBe(true);
  // stopping it silences it too
  await page.evaluate(async (url) => ((await import(/* @vite-ignore */ url)) as AuditionModule).stopAudition(), AUDITION);
  await expect.poll(async () => (await voices(page)).filter((v) => v.gain > 0.01), { timeout: 2000 }).toEqual([]);
});
