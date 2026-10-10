// Hear while browsing (src/ui/complete/browse.ts): which focus changes in a sound list play.
// Only arrowing does (a navigation key within 150 ms), after a 120 ms pause on the row, and only
// with previews on; a screen reader keeps them off unless turned on in this session.
// Run: node --test test/complete-browse.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { composeDoc, createBrowser, previewsOn, HINT_OFF, HINT_ON, NAV_WINDOW_MS, NOTE_LOAD_FAILED, PREVIEW_DELAY_MS } from "../src/ui/complete/browse.ts";
import type { SoundPreview } from "../src/ui/complete/values.ts";

/** A browser over a fake clock; `on` is the setting */
function setup(on = true) {
  let now = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let id = 0;
  const log: string[] = [];
  const state = { on };
  const b = createBrowser({
    now: () => now,
    setTimer: (fn, ms) => {
      timers.set(++id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (t) => timers.delete(t as number),
    enabled: () => state.on,
    play: (p) => log.push(`play ${p.sound}${p.n === undefined ? "" : `:${p.n}`}`),
    prefetch: (p) => log.push(`prefetch ${p.sound}`),
    stop: () => log.push("stop"),
  });
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const next = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at;
      timers.delete(next[0]);
      next[1].fn();
    }
    now = until;
  };
  const plays = () => log.filter((l) => l.startsWith("play"));
  return { b, advance, log, plays, state };
}

const row = (sound: string, n?: number): SoundPreview => (n === undefined ? { sound } : { sound, n });

test("three fast ArrowDowns: one preview, of the row where you stop, 120 ms later", () => {
  const { b, advance, plays } = setup();
  for (const s of ["bd", "sd", "hh"]) {
    b.keyDown("ArrowDown");
    b.focus(row(s));
    advance(30);
  }
  assert.deepEqual(plays(), []);
  advance(PREVIEW_DELAY_MS);
  assert.deepEqual(plays(), ["play hh"]);
  // a slow one more: one more
  b.keyDown("ArrowDown");
  b.focus(row("bd", 3));
  advance(500);
  assert.deepEqual(plays(), ["play hh", "play bd:3"]);
});

test("opening the list, typing, re-filtering and the mouse never play", () => {
  const { b, advance, plays, log } = setup();
  b.focus(row("bd")); // the list opened
  advance(1000);
  b.keyDown("h");
  b.focus(row("hh")); // re-filtered as you type
  advance(1000);
  b.keyDown("ArrowDown");
  advance(NAV_WINDOW_MS + 1);
  b.focus(row("sd")); // too long after the key: an incomplete re-query, the mouse
  advance(1000);
  assert.deepEqual(plays(), []);
  assert.ok(log.includes("prefetch bd"), "but a focused row loads ahead");
});

test("previews off: nothing plays and nothing loads", () => {
  const { b, advance, log } = setup(false);
  b.keyDown("ArrowDown");
  b.focus(row("bd"));
  advance(1000);
  assert.deepEqual(log, []);
});

test("a row that isn't a sound cancels a pending preview", () => {
  const { b, advance, plays } = setup();
  b.keyDown("ArrowDown");
  b.focus(row("bd"));
  b.keyDown("ArrowDown");
  b.focus(undefined); // a mini-notation row
  advance(1000);
  assert.deepEqual(plays(), []);
});

test("closing the list stops what it played, and cancels what it was about to", () => {
  const { b, advance, log, plays } = setup();
  b.keyDown("ArrowDown");
  b.focus(row("bd"));
  advance(PREVIEW_DELAY_MS);
  b.hide();
  assert.equal(log[log.length - 1], "stop");
  b.keyDown("ArrowDown");
  b.focus(row("sd"));
  b.hide();
  advance(1000);
  assert.deepEqual(plays(), ["play bd"]);
  const n = log.length;
  b.hide(); // nothing played since: nothing to stop
  assert.equal(log.length, n);
});

test("composeDoc: the row's own text, a note about it, then the previews line", () => {
  assert.equal(composeDoc("**bd** · kick", { hint: HINT_OFF }), "**bd** · kick\n\n*⌥P to hear sounds as you browse*");
  assert.equal(composeDoc("**bd** · kick", { hint: HINT_ON, note: NOTE_LOAD_FAILED }), "**bd** · kick\n\n⚠ couldn't load this sample\n\n*♪ previews on arrow · ⌥P mutes*");
});

test("previewsOn: the setting, but a screen reader keeps them off unless turned on this session", () => {
  assert.equal(previewsOn({ allowed: true, screenReader: false, toggledThisSession: false }), true);
  assert.equal(previewsOn({ allowed: false, screenReader: false, toggledThisSession: true }), false);
  assert.equal(previewsOn({ allowed: true, screenReader: true, toggledThisSession: false }), false);
  assert.equal(previewsOn({ allowed: true, screenReader: true, toggledThisSession: true }), true);
});

test("previews turned off while one waits on its row: it never plays", () => {
  const { b, advance, plays, state } = setup();
  b.keyDown("ArrowDown");
  b.focus(row("bd"));
  advance(PREVIEW_DELAY_MS / 2);
  state.on = false; // ⌥P (or the palette) turned them off, before the pause ran out
  advance(1000);
  assert.deepEqual(plays(), []);
});

test("off(): cancels what was about to play and stops what played", () => {
  const { b, advance, log, plays } = setup();
  b.keyDown("ArrowDown");
  b.focus(row("bd"));
  b.off();
  advance(1000);
  assert.deepEqual(plays(), []);
  b.keyDown("ArrowDown");
  b.focus(row("sd"));
  advance(PREVIEW_DELAY_MS);
  assert.deepEqual(plays(), ["play sd"]);
  b.off();
  assert.equal(log[log.length - 1], "stop");
});

test("dispose(): nothing pending plays, what played stops, and later keys and rows do nothing", () => {
  const { b, advance, log, plays } = setup();
  b.keyDown("ArrowDown");
  b.focus(row("bd"));
  advance(PREVIEW_DELAY_MS);
  b.keyDown("ArrowDown");
  b.focus(row("sd"));
  b.dispose();
  assert.equal(log[log.length - 1], "stop");
  advance(1000);
  const n = log.length;
  b.keyDown("ArrowDown");
  b.focus(row("hh"));
  advance(1000);
  b.hide();
  assert.deepEqual(plays(), ["play bd"]);
  assert.equal(log.length, n, "no prefetch, play or stop after dispose");
});
