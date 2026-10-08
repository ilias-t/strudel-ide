// The editor's autosave without a browser: every buffer change is kept in the
// songs store (debounced), even text that doesn't compile; an edit back to
// the original drops the override; ⌘S writes now; revert cancels a pending
// write so it can't bring the edit back.
//
// Run: node --test test/song-saver.test.ts   (Node ≥ 22.18 strips TS types)

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SongSaver } from "../src/ui/song-saver.ts";

class FakeTimers {
  now = 0;
  private nextId = 1;
  private tasks = new Map<number, { at: number; fn: () => void }>();
  set = (fn: () => void, ms: number): unknown => {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.now + ms, fn });
    return id;
  };
  clear = (id: unknown): void => {
    this.tasks.delete(id as number);
  };
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      let due: [number, { at: number; fn: () => void }] | null = null;
      for (const entry of this.tasks) if (entry[1].at <= end && (!due || entry[1].at < due[1].at)) due = entry;
      if (!due) break;
      this.tasks.delete(due[0]);
      this.now = due[1].at;
      due[1].fn();
    }
    this.now = end;
  }
}

/** A store backed by a Map; `blocked` makes saves report persisted: false */
function setup({ blocked = false, debounceMs }: { blocked?: boolean; debounceMs?: number } = {}) {
  const saved = new Map<string, string>();
  const log: string[] = [];
  const notified: string[] = [];
  const originals: Record<string, string> = { jynx: "ORIGINAL" };
  const timers = new FakeTimers();
  const saver = new SongSaver({
    store: {
      saveOverride(id, text) {
        log.push(`save ${id}`);
        if (!blocked) saved.set(id, text);
        return { persisted: !blocked };
      },
      discard(id) {
        log.push(`discard ${id}`);
        return saved.delete(id);
      },
    },
    originalText: (id) => originals[id],
    timers,
    debounceMs,
    onSaved: (id, result) => notified.push(`${id}:${result}`),
  });
  return { saver, saved, log, timers, notified };
}

describe("autosave", () => {
  test("a burst of edits is written once, after the debounce, with the latest text", () => {
    const { saver, saved, log, timers } = setup();
    saver.edit("jynx", "A");
    timers.advance(200);
    saver.edit("jynx", "AB");
    timers.advance(299);
    assert.deepEqual(log, [], "still typing");
    assert.equal(saver.pending("jynx"), true);
    timers.advance(1);
    assert.deepEqual(log, ["save jynx"]);
    assert.equal(saved.get("jynx"), "AB");
    assert.equal(saver.pending("jynx"), false);
  });

  test("the debounce is configurable", () => {
    const { saver, log, timers } = setup({ debounceMs: 50 });
    saver.edit("jynx", "A");
    timers.advance(50);
    assert.deepEqual(log, ["save jynx"]);
  });

  test("text that doesn't compile is kept as is", () => {
    const { saver, saved, timers } = setup();
    saver.edit("jynx", "const x = ((");
    timers.advance(300);
    assert.equal(saved.get("jynx"), "const x = ((");
  });

  test("an edit back to the original text drops the override instead of saving a copy", () => {
    const { saver, saved, log, timers } = setup();
    saver.edit("jynx", "A");
    timers.advance(300);
    saver.edit("jynx", "ORIGINAL");
    timers.advance(300);
    assert.deepEqual(log, ["save jynx", "discard jynx"]);
    assert.equal(saved.has("jynx"), false);
  });

  test("a user song (no original) is always saved, never discarded", () => {
    const { saver, saved, log, timers } = setup();
    saver.edit("wobble", "ORIGINAL");
    timers.advance(300);
    assert.deepEqual(log, ["save wobble"]);
    assert.equal(saved.get("wobble"), "ORIGINAL");
  });

  test("songs are debounced separately", () => {
    const { saver, saved, timers } = setup();
    saver.edit("jynx", "J");
    saver.edit("wobble", "W");
    timers.advance(300);
    assert.equal(saved.get("jynx"), "J");
    assert.equal(saved.get("wobble"), "W");
  });

  test("every write is announced with its outcome (the badge re-reads the store; a failure is shown)", () => {
    const { saver, timers, notified } = setup();
    saver.edit("jynx", "A");
    timers.advance(300);
    saver.edit("jynx", "ORIGINAL");
    timers.advance(300);
    assert.deepEqual(notified, ["jynx:saved", "jynx:unchanged"]);
  });

  test("an autosave the storage refuses is announced as not persisted", () => {
    const { saver, timers, notified } = setup({ blocked: true });
    saver.edit("jynx", "A");
    timers.advance(300);
    assert.deepEqual(notified, ["jynx:not-persisted"]);
  });
});

describe("flush (page hidden / about to unload)", () => {
  test("writes every pending edit now", () => {
    const { saver, saved, timers, log } = setup();
    saver.edit("jynx", "J");
    saver.edit("wobble", "W");
    saver.flush();
    assert.equal(saved.get("jynx"), "J");
    assert.equal(saved.get("wobble"), "W");
    timers.advance(1000);
    assert.equal(log.length, 2, "the timers don't write again");
  });

  test("one song only, when given", () => {
    const { saver, saved } = setup();
    saver.edit("jynx", "J");
    saver.edit("wobble", "W");
    saver.flush("jynx");
    assert.equal(saved.get("jynx"), "J");
    assert.equal(saved.has("wobble"), false);
    assert.equal(saver.pending("wobble"), true);
  });

  test("nothing pending: no write", () => {
    const { saver, log } = setup();
    saver.flush();
    saver.flush("jynx");
    assert.deepEqual(log, []);
  });
});

describe("cancel (revert)", () => {
  test("a pending write is dropped, so it can't bring a reverted edit back", () => {
    const { saver, saved, timers, log } = setup();
    saver.edit("jynx", "A");
    saver.cancel("jynx");
    timers.advance(1000);
    saver.flush();
    assert.deepEqual(log, []);
    assert.equal(saved.has("jynx"), false);
  });
});

describe("keep (⌘S)", () => {
  test("writes now and replaces the pending write", () => {
    const { saver, saved, timers, log } = setup();
    saver.edit("jynx", "A");
    assert.equal(saver.keep("jynx", "AB"), "saved");
    assert.equal(saved.get("jynx"), "AB");
    timers.advance(1000);
    assert.deepEqual(log, ["save jynx"]);
  });

  test("the original text: nothing to keep, any override goes", () => {
    const { saver, saved } = setup();
    saver.keep("jynx", "A");
    assert.equal(saver.keep("jynx", "ORIGINAL"), "unchanged");
    assert.equal(saved.has("jynx"), false);
  });

  test("storage blocked: says so", () => {
    const { saver } = setup({ blocked: true });
    assert.equal(saver.keep("jynx", "A"), "not-persisted");
  });
});
