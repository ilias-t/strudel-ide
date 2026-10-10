// The browser editor's per-song session without a browser: ownership of the
// buffer (mirror / browser / IDE), debounced typing evals, commit, races and
// conflicts with external changes.
//
// Run: node --test test/edit-session.test.ts   (Node ≥ 22.18 strips TS types)

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { EditSession, emptyPatternCall, type IncomingSource, type Owner, type SessionView } from "../src/ui/edit-session.ts";
import type { EvalIntent, EvalResult } from "../src/ui/editor-types.ts";
import { contentVersion } from "../src/live/protocol.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Harness: fake timers, an engine whose results the test resolves by hand
// ─────────────────────────────────────────────────────────────────────────────

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
  get pending(): number {
    return this.tasks.size;
  }
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

interface EvalCall {
  text: string;
  intent: EvalIntent;
  /** Aborted when the session gives this eval up (the engine must not apply it) */
  signal: AbortSignal | undefined;
  resolve: (r: EvalResult | null) => void;
  reject: (e: unknown) => void;
}

/** Lets pending promise callbacks run */
const flush = () => new Promise<void>((r) => setImmediate(r));

const disk = (text: string): IncomingSource => ({ text, version: contentVersion(text) });
const ideLive = (text: string): IncomingSource => ({ text, version: contentVersion(text), live: true });
/** What player.currentSource() looks like after the browser's text was evaluated */
const echo = (text: string): IncomingSource => ({ text, version: contentVersion(text), live: true });

const OK: EvalResult = { ok: true, version: "v" };
const fail = (message: string, line?: number): EvalResult => ({ ok: false, error: { message, line } });

function setup(initial: IncomingSource = disk("A"), opts: { debounceMs?: number; ideName?: string } = {}) {
  const timers = new FakeTimers();
  const calls: EvalCall[] = [];
  const views: SessionView[] = [];
  /** [owner, previous] for every ownership change */
  const owners: [Owner, Owner][] = [];
  const session = new EditSession({
    initial,
    evaluate: (text, intent, signal) =>
      new Promise<EvalResult | null>((resolve, reject) => calls.push({ text, intent, signal, resolve, reject })),
    debounceMs: opts.debounceMs,
    timers,
    onChange: (v) => views.push(v),
    onOwnerChange: (owner, previous) => owners.push([owner, previous]),
    ideName: opts.ideName ? () => opts.ideName! : undefined,
  });
  return { session, timers, calls, views, owners };
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule 1: mirror
// ─────────────────────────────────────────────────────────────────────────────

describe("mirror (rule 1)", () => {
  test("a disk source is shown editable, owned by the mirror", () => {
    const { session } = setup(disk("A"));
    const v = session.view();
    assert.equal(v.text, "A");
    assert.equal(v.owner, "mirror");
    assert.equal(v.readOnly, false);
    assert.equal(v.status.kind, "idle");
    assert.equal(v.conflict, null);
    assert.equal(v.marker, null);
  });

  test("the buffer follows a new disk source", () => {
    const { session, views } = setup(disk("A"));
    assert.equal(session.incoming(disk("B")), true);
    assert.equal(session.view().text, "B");
    assert.equal(session.view().owner, "mirror");
    assert.equal(views.at(-1)?.text, "B");
  });

  test("an IDE live buffer is shown read-only with a take-over hint", () => {
    const { session } = setup(disk("A"), { ideName: "Cursor" });
    assert.equal(session.incoming(ideLive("B")), true);
    const v = session.view();
    assert.equal(v.text, "B");
    assert.equal(v.owner, "ide");
    assert.equal(v.readOnly, true);
    assert.equal(v.status.kind, "readonly");
    assert.match(v.status.text, /Cursor/);
    assert.match(v.status.text, /take over/);
    assert.equal(v.status.action, "takeOver");
  });

  test("a live initial source starts read-only", () => {
    const { session } = setup(ideLive("A"));
    assert.equal(session.view().owner, "ide");
    assert.equal(session.view().readOnly, true);
  });

  test("the IDE name defaults to a generic one", () => {
    const { session } = setup(ideLive("A"));
    assert.match(session.view().status.text, /your editor/);
  });

  test("a disk source after an IDE buffer makes it editable again", () => {
    const { session } = setup(ideLive("A"));
    session.incoming(disk("B"));
    assert.equal(session.view().owner, "mirror");
    assert.equal(session.view().readOnly, false);
    assert.equal(session.view().text, "B");
  });

  test("edits are rejected while read-only", () => {
    const { session, timers, calls } = setup(ideLive("A"));
    assert.equal(session.edit("A!"), false);
    assert.equal(session.view().text, "A");
    assert.equal(session.view().owner, "ide");
    timers.advance(10_000);
    assert.equal(calls.length, 0);
  });

  test("take over makes the IDE's buffer the browser's, unchanged and editable", () => {
    const { session } = setup(disk("A"));
    session.incoming(ideLive("B"));
    session.takeOver();
    const v = session.view();
    assert.equal(v.owner, "browser");
    assert.equal(v.readOnly, false);
    assert.equal(v.text, "B");
    assert.notEqual(v.status.kind, "readonly");
    assert.equal(session.edit("B!"), true);
  });

  test("take over does nothing unless the IDE owns the buffer", () => {
    const { session, views } = setup(disk("A"));
    session.takeOver();
    assert.equal(session.view().owner, "mirror");
    assert.equal(views.length, 0);
  });

  test("after take over, newer IDE edits become a conflict", () => {
    const { session } = setup(ideLive("A"), { ideName: "Cursor" });
    session.takeOver();
    assert.equal(session.incoming(ideLive("A2")), false);
    assert.equal(session.view().text, "A");
    assert.equal(session.view().conflict?.text, "A2");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rule 2: typing makes the browser the owner
// ─────────────────────────────────────────────────────────────────────────────

describe("browser ownership (rule 2)", () => {
  test("typing makes the browser the owner", () => {
    const { session } = setup(disk("A"));
    assert.equal(session.edit("AB"), true);
    assert.equal(session.view().owner, "browser");
    assert.equal(session.view().text, "AB");
  });

  test("an echo of the browser's evaluated text is ignored", async () => {
    const { session, timers, calls, views } = setup(disk("A"));
    session.edit("AB");
    timers.advance(400);
    calls[0].resolve(OK);
    await flush();
    const before = views.length;
    assert.equal(session.incoming(echo("AB")), false);
    assert.equal(session.view().conflict, null);
    assert.equal(session.view().owner, "browser");
    assert.equal(views.length, before, "no callback for an echo");
  });

  test("a late echo of older sent text doesn't overwrite newer typing", async () => {
    const { session, timers, calls } = setup(disk("A"));
    session.edit("AB");
    timers.advance(400);
    session.edit("ABC");
    calls[0].resolve(OK);
    await flush();
    assert.equal(session.incoming(echo("AB")), false);
    assert.equal(session.view().text, "ABC");
    assert.equal(session.view().conflict, null);
  });

  test("an echo is recognised by its text when it carries no version", async () => {
    const { session, timers } = setup(disk("A"));
    session.edit("AB");
    timers.advance(400);
    assert.equal(session.incoming({ text: "AB", live: true }), false);
    assert.equal(session.view().conflict, null);
  });

  test("a committed text's echo is ignored too", async () => {
    const { session, calls } = setup(disk("A"));
    session.edit("AB");
    const p = session.commit();
    calls[0].resolve(OK);
    await p;
    assert.equal(session.incoming(echo("AB")), false);
    assert.equal(session.view().owner, "browser");
    assert.equal(session.view().conflict, null);
  });

  test("an echo never makes the mirror read-only", async () => {
    const { session, calls } = setup(disk("A"));
    session.edit("AB");
    void session.commit();
    calls[0].resolve(OK);
    session.incoming(disk("AB")); // saved: back to the mirror
    // a late echo of the evaluated buffer (live: it differed from the file then)
    assert.equal(session.incoming(echo("AB")), false);
    assert.equal(session.view().owner, "mirror");
    assert.equal(session.view().readOnly, false);
  });

  test("a file saved with other text becomes a conflict, not a silent overwrite", () => {
    const { session } = setup(disk("A"), { ideName: "Cursor" });
    session.edit("AB");
    assert.equal(session.incoming(disk("XYZ")), false);
    const v = session.view();
    assert.equal(v.text, "AB");
    assert.equal(v.owner, "browser");
    assert.deepEqual(v.conflict, disk("XYZ"));
    assert.equal(v.status.kind, "conflict");
    assert.match(v.status.text, /saved/);
    assert.match(v.status.text, /load/);
    assert.equal(v.status.action, "load");
  });

  test("an IDE live buffer with other text becomes a conflict saying the IDE has newer edits", () => {
    const { session } = setup(disk("A"), { ideName: "Cursor" });
    session.edit("AB");
    assert.equal(session.incoming(ideLive("XYZ")), false);
    const v = session.view();
    assert.equal(v.text, "AB");
    assert.equal(v.readOnly, false);
    assert.equal(v.conflict?.text, "XYZ");
    assert.equal(v.status.kind, "conflict");
    assert.match(v.status.text, /Cursor has newer edits/);
    assert.equal(v.status.action, "load");
  });

  test("a newer external change replaces the pending conflict", () => {
    const { session } = setup(disk("A"));
    session.edit("AB");
    session.incoming(disk("X"));
    session.incoming(disk("Y"));
    assert.equal(session.view().conflict?.text, "Y");
  });

  test("load on a disk conflict replaces the buffer and returns to the mirror", () => {
    const { session, views } = setup(disk("A"));
    session.edit("AB");
    session.incoming(disk("XYZ"));
    session.loadIncoming();
    const v = session.view();
    assert.equal(v.text, "XYZ");
    assert.equal(v.owner, "mirror");
    assert.equal(v.readOnly, false);
    assert.equal(v.conflict, null);
    assert.notEqual(v.status.kind, "conflict");
    assert.equal(views.at(-1)?.text, "XYZ");
  });

  test("load on an IDE conflict hands the buffer back to the IDE, read-only", () => {
    const { session } = setup(disk("A"));
    session.edit("AB");
    session.incoming(ideLive("XYZ"));
    session.loadIncoming();
    const v = session.view();
    assert.equal(v.text, "XYZ");
    assert.equal(v.owner, "ide");
    assert.equal(v.readOnly, true);
    assert.equal(v.conflict, null);
  });

  test("load cancels a pending typing eval of the replaced text", () => {
    const { session, timers, calls } = setup(disk("A"));
    session.edit("AB");
    session.incoming(disk("XYZ"));
    session.loadIncoming();
    timers.advance(10_000);
    assert.equal(calls.length, 0);
  });

  test("load without a conflict does nothing", () => {
    const { session, views } = setup(disk("A"));
    session.edit("AB");
    const before = views.length;
    session.loadIncoming();
    assert.equal(session.view().text, "AB");
    assert.equal(views.length, before);
  });

  test("a file saved with the buffer's text ends browser ownership with nothing lost", () => {
    const { session } = setup(disk("A"));
    session.edit("AB");
    assert.equal(session.incoming(disk("AB")), false);
    const v = session.view();
    assert.equal(v.owner, "mirror");
    assert.equal(v.text, "AB");
    assert.equal(v.conflict, null);
    assert.equal(v.readOnly, false);
  });

  test("saving exactly the text the browser evaluated ends ownership (not mistaken for an echo)", async () => {
    const { session, calls } = setup(disk("A"));
    session.edit("AB");
    void session.commit();
    calls[0].resolve(OK);
    await flush();
    session.incoming(echo("AB"));
    // the save steps the live buffer down: same version, now the file
    session.incoming(disk("AB"));
    assert.equal(session.view().owner, "mirror");
    assert.equal(session.incoming(disk("C")), true, "follows the file again");
  });

  test("a save of older evaluated text after more typing is ignored, not a conflict", async () => {
    const { session, calls, timers } = setup(disk("A"));
    session.edit("AB");
    timers.advance(400);
    calls[0].resolve(OK);
    await flush();
    session.edit("ABC");
    assert.equal(session.incoming(disk("AB")), false);
    assert.equal(session.view().conflict, null);
    assert.equal(session.view().owner, "browser");
    assert.equal(session.view().text, "ABC");
  });

  test("an echo leaves a pending conflict in place", async () => {
    const { session, calls, timers } = setup(disk("A"));
    session.edit("AB");
    session.incoming(disk("X"));
    timers.advance(400);
    calls[0].resolve(OK);
    await flush();
    session.incoming(echo("AB"));
    assert.equal(session.view().conflict?.text, "X");
  });

  test("an IDE buffer that catches up with the browser's text clears the conflict", () => {
    const { session } = setup(disk("A"));
    session.edit("AB");
    session.incoming(ideLive("X"));
    session.incoming(ideLive("AB"));
    assert.equal(session.view().conflict, null);
    assert.equal(session.view().owner, "browser");
  });

  test("an equal-text save also clears an earlier conflict", () => {
    const { session } = setup(disk("A"));
    session.edit("AB");
    session.incoming(disk("X"));
    session.incoming(disk("AB"));
    assert.equal(session.view().conflict, null);
    assert.equal(session.view().owner, "mirror");
  });

  test("an IDE buffer equal to the browser's is no conflict and keeps browser ownership", () => {
    const { session } = setup(disk("A"));
    session.edit("AB");
    session.incoming(ideLive("AB"));
    assert.equal(session.view().conflict, null);
    assert.equal(session.view().owner, "browser");
    assert.equal(session.view().readOnly, false);
  });

  test("after the file is saved, the mirror follows again", () => {
    const { session } = setup(disk("A"));
    session.edit("AB");
    session.incoming(disk("AB"));
    assert.equal(session.incoming(disk("C")), true);
    assert.equal(session.view().text, "C");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rule 3: debounce
// ─────────────────────────────────────────────────────────────────────────────

describe("debounce (rule 3)", () => {
  test("a typing eval fires debounceMs after the last edit", () => {
    const { session, timers, calls } = setup(disk("A"));
    session.edit("A1");
    timers.advance(300);
    session.edit("A12");
    timers.advance(399);
    assert.equal(calls.length, 0, "each edit restarts the timer");
    timers.advance(1);
    assert.equal(calls.length, 1);
    assert.deepEqual([calls[0].text, calls[0].intent], ["A12", "typing"]);
  });

  test("the debounce is configurable", () => {
    const { session, timers, calls } = setup(disk("A"), { debounceMs: 50 });
    session.edit("A1");
    timers.advance(50);
    assert.equal(calls.length, 1);
  });

  test("status is pending while scheduled, evaluating while in flight", () => {
    const { session, timers } = setup(disk("A"));
    session.edit("A1");
    assert.equal(session.view().status.kind, "pending");
    timers.advance(400);
    assert.equal(session.view().status.kind, "evaluating");
  });

  test("text equal to the last evaluated text isn't evaluated again", async () => {
    const { session, timers, calls } = setup(disk("A"));
    session.edit("A1");
    timers.advance(400);
    calls[0].resolve(OK);
    await flush();
    session.edit("A12");
    session.edit("A1");
    timers.advance(400);
    assert.equal(calls.length, 1);
    assert.equal(session.view().status.kind, "ok", "back to the evaluated state, not stuck pending");
  });

  test("commit evaluates now, cancelling the pending typing eval", async () => {
    const { session, timers, calls } = setup(disk("A"));
    session.edit("A1");
    const p = session.commit();
    assert.equal(calls.length, 1);
    assert.deepEqual([calls[0].text, calls[0].intent], ["A1", "commit"]);
    timers.advance(10_000);
    assert.equal(calls.length, 1, "the typing eval was cancelled");
    calls[0].resolve(OK);
    assert.deepEqual(await p, OK);
  });

  test("commit evaluates even unchanged text", async () => {
    const { session, timers, calls } = setup(disk("A"));
    session.edit("A1");
    timers.advance(400);
    calls[0].resolve(OK);
    await flush();
    void session.commit();
    assert.equal(calls.length, 2);
    assert.deepEqual([calls[1].text, calls[1].intent], ["A1", "commit"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rule 4: races
// ─────────────────────────────────────────────────────────────────────────────

describe("races (rule 4)", () => {
  test("a slow typing result arriving after a commit's is dropped", async () => {
    const { session, timers, calls } = setup(disk("A"));
    session.edit("A1");
    timers.advance(400); // typing eval of A1 in flight
    session.edit("A12");
    const p = session.commit();
    calls[1].resolve(OK);
    await p;
    assert.equal(session.view().status.kind, "ok");
    calls[0].resolve(fail("stale", 1));
    await flush();
    assert.equal(session.view().status.kind, "ok");
    assert.equal(session.view().marker, null);
  });

  test("an older typing result is dropped once a newer typing eval is issued", async () => {
    const { session, timers, calls } = setup(disk("A"));
    session.edit("A1");
    timers.advance(400);
    session.edit("A12");
    timers.advance(400);
    calls[0].resolve(fail("old", 1));
    await flush();
    assert.equal(session.view().status.kind, "evaluating");
    assert.equal(session.view().marker, null);
    calls[1].resolve(OK);
    await flush();
    assert.equal(session.view().status.kind, "ok");
  });

  test("nothing is applied and no callback fires after dispose", async () => {
    const { session, timers, calls, views } = setup(disk("A"));
    session.edit("A1");
    timers.advance(400);
    const before = views.length;
    session.dispose();
    calls[0].resolve(fail("late", 2));
    await flush();
    assert.equal(views.length, before);
    assert.equal(session.view().marker, null);
  });

  test("dispose cancels the pending typing eval and ignores later calls", async () => {
    const { session, timers, calls, views } = setup(disk("A"));
    session.edit("A1");
    session.dispose();
    assert.equal(timers.pending, 0);
    timers.advance(10_000);
    assert.equal(calls.length, 0);
    const before = views.length;
    assert.equal(session.edit("A12"), false);
    assert.equal(session.incoming(disk("B")), false);
    assert.equal(await session.commit(), null);
    assert.equal(views.length, before);
  });

  test("an eval result for text replaced by a loaded change is dropped", async () => {
    const { session, timers, calls } = setup(disk("A"));
    session.edit("A1");
    timers.advance(400);
    session.incoming(disk("X"));
    session.loadIncoming();
    calls[0].resolve(fail("for A1", 1));
    await flush();
    assert.equal(session.view().marker, null);
    assert.notEqual(session.view().status.kind, "evaluating");
  });

  test("an in-flight eval whose text the file then saved ends cleanly", async () => {
    const { session, timers, calls } = setup(disk("A"));
    session.edit("A1");
    timers.advance(400);
    session.incoming(disk("A1"));
    assert.notEqual(session.view().status.kind, "evaluating");
    calls[0].resolve(OK);
    await flush();
    assert.equal(session.view().owner, "mirror");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rule 5: results
// ─────────────────────────────────────────────────────────────────────────────

describe("emptyPatternCall: an empty pattern string still being filled", () => {
  const err = (line: number, column: number) => ({ message: "[mini] parse error at line 1: Expected", line, column });
  test("an empty literal at the failing call, also when the argument starts on the next line", () => {
    assert.equal(emptyPatternCall(err(1, 19), 'const d = s("bd").bank("");'), "bank");
    assert.equal(emptyPatternCall(err(1, 19), 'const d = s("bd").bank(\n  ""\n);'), "bank");
  });
  test("only whitespace Strudel accepts counts as empty: a pasted em space is a real error", () => {
    assert.equal(emptyPatternCall(err(1, 19), 'const d = s("bd").bank(" ");'), "bank");
    assert.equal(emptyPatternCall(err(1, 19), 'const d = s("bd").bank("\u2003");'), null);
  });
  test("a literal with something in it, another message, or no location: not this case", () => {
    assert.equal(emptyPatternCall(err(1, 19), 'const d = s("bd").bank("x");'), null);
    assert.equal(emptyPatternCall({ message: "Unexpected token", line: 1, column: 19 }, 'const d = s("bd").bank("");'), null);
    assert.equal(emptyPatternCall({ message: "[mini] parse error" }, 'const d = s("bd").bank("");'), null);
  });
});

describe("results (rule 5)", () => {
  test("ok clears the marker and shows a short ok status", async () => {
    const { session, timers, calls } = setup(disk("A"));
    session.edit("A1");
    timers.advance(400);
    calls[0].resolve(fail("bad", 1));
    await flush();
    session.edit("A12");
    timers.advance(400);
    calls[1].resolve(OK);
    await flush();
    const v = session.view();
    assert.equal(v.marker, null);
    assert.equal(v.status.kind, "ok");
    assert.equal(v.status.text, "live");
  });

  test("an error sets the marker and a 'line N: message' status", async () => {
    const { session, timers, calls } = setup(disk("A"));
    session.edit("A1");
    timers.advance(400);
    const error = { message: "Unexpected token", line: 12, column: 3 };
    calls[0].resolve({ ok: false, error });
    await flush();
    const v = session.view();
    assert.deepEqual(v.marker, error);
    assert.equal(v.markerText, "A1", "the text the marker's line/column refer to");
    assert.equal(v.status.kind, "error");
    assert.equal(v.status.text, "line 12: Unexpected token");
  });

  test("a typing error that is only an empty pattern string (bank(\"\") as the quotes close) is no error yet: no marker, a calm status", async () => {
    const { session, timers, calls } = setup(disk("A"));
    const text = 'const d = s("bd").bank("");';
    session.edit(text);
    timers.advance(400);
    calls[0].resolve({ ok: false, error: { message: '[mini] parse error at line 1: Expected "<", "[" but "\"" found.', line: 1, column: 20 } });
    await flush();
    const v = session.view();
    assert.equal(v.marker, null);
    assert.equal(v.status.kind, "pending");
    assert.equal(v.status.text, "waiting for a value in bank(\"\")");
    // a real parse error in a string with something in it stays an error
    session.edit('const d = s("bd [").bank("x");');
    timers.advance(400);
    calls[1].resolve({ ok: false, error: { message: "[mini] parse error at line 1: Expected", line: 1, column: 11 } });
    await flush();
    assert.equal(session.view().status.kind, "error");
    assert.ok(session.view().marker);
  });

  test("an error without a line shows just the message", async () => {
    const { session, timers, calls } = setup(disk("A"));
    session.edit("A1");
    timers.advance(400);
    calls[0].resolve(fail("no default export"));
    await flush();
    assert.equal(session.view().status.text, "no default export");
  });

  test("error status text keeps the first line and truncates long messages", async () => {
    const { session, timers, calls } = setup(disk("A"));
    session.edit("A1");
    timers.advance(400);
    calls[0].resolve(fail(`${"x".repeat(300)}\n    at stack frame`, 4));
    await flush();
    const text = session.view().status.text;
    assert.ok(text.startsWith("line 4: xxx"));
    assert.ok(!text.includes("stack frame"));
    assert.ok(text.length <= 100, `short: ${text.length}`);
    assert.ok(text.endsWith("…"));
    assert.equal(session.view().marker?.message.includes("stack frame"), true, "the marker keeps the full error");
  });

  test("no engine shows offline and leaves the marker as it was", async () => {
    const { session, timers, calls } = setup(disk("A"));
    session.edit("A1");
    timers.advance(400);
    calls[0].resolve(fail("bad", 1));
    await flush();
    session.edit("A12");
    timers.advance(400);
    calls[1].resolve(null);
    await flush();
    const v = session.view();
    assert.equal(v.status.kind, "offline");
    assert.match(v.status.text, /not evaluated/);
    assert.equal(v.marker?.message, "bad");
  });

  test("a result the engine marks superseded changes nothing: no marker, the last status stays", async () => {
    const { session, timers, calls } = setup(disk("A"));
    session.edit("A1");
    timers.advance(400);
    calls[0].resolve(OK);
    await flush();
    // the engine ran a newer eval (or a revert) of this song first
    session.edit("A12");
    timers.advance(400);
    calls[1].resolve({ ok: false, error: { message: "superseded by a newer eval", superseded: true } });
    await flush();
    const v = session.view();
    assert.equal(v.marker, null, "no inline error for a superseded eval");
    assert.equal(v.status.kind, "ok");
    assert.equal(v.status.text, "live");
  });

  test("a superseded result keeps an earlier marker as it was", async () => {
    const { session, timers, calls } = setup(disk("A"));
    session.edit("A1");
    timers.advance(400);
    calls[0].resolve(fail("bad", 1));
    await flush();
    session.edit("A12");
    timers.advance(400);
    calls[1].resolve({ ok: false, error: { message: "superseded", superseded: true } });
    await flush();
    const v = session.view();
    assert.equal(v.marker?.message, "bad");
    assert.equal(v.markerText, "A1");
    assert.equal(v.status.kind, "error");
  });

  test("a rejected evaluate becomes an error, never an unhandled rejection", async () => {
    const { session, calls } = setup(disk("A"));
    const p = session.commit();
    calls[0].reject(new Error("boom"));
    assert.deepEqual(await p, { ok: false, error: { message: "boom" } });
    assert.equal(session.view().status.kind, "error");
  });

  test("a conflict outranks the eval status", async () => {
    const { session, timers, calls } = setup(disk("A"));
    session.edit("A1");
    timers.advance(400);
    session.incoming(disk("X"));
    calls[0].resolve(fail("bad", 1));
    await flush();
    const v = session.view();
    assert.equal(v.status.kind, "conflict");
    assert.equal(v.marker?.message, "bad", "the marker still updates");
  });

  test("an external change that replaces the buffer clears the marker", async () => {
    const { session, timers, calls } = setup(disk("A"));
    session.edit("A1");
    timers.advance(400);
    calls[0].resolve(fail("bad", 1));
    await flush();
    session.incoming(disk("A1")); // saved: back to the mirror
    session.incoming(disk("B"));
    assert.equal(session.view().marker, null);
    assert.equal(session.view().status.kind, "idle");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rule 6: incoming() is cheap and idempotent
// ─────────────────────────────────────────────────────────────────────────────

describe("idempotent incoming (rule 6)", () => {
  test("the same source again does nothing and calls back nothing", () => {
    const { session, views } = setup(disk("A"));
    assert.equal(session.incoming(disk("A")), false);
    session.incoming(disk("B"));
    const before = views.length;
    assert.equal(session.incoming(disk("B")), false);
    assert.equal(session.incoming({ ...disk("B") }), false);
    assert.equal(views.length, before);
  });

  test("an unchanged conflict source isn't re-reported", () => {
    const { session, views } = setup(disk("A"));
    session.edit("AB");
    session.incoming(disk("X"));
    const before = views.length;
    session.incoming(disk("X"));
    assert.equal(views.length, before);
  });

  test("the same text arriving as a disk source after a live one is a change", () => {
    const { session } = setup(disk("A"));
    session.incoming(ideLive("B"));
    assert.equal(session.view().readOnly, true);
    session.incoming(disk("B"));
    assert.equal(session.view().readOnly, false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rule 7: a saved browser edit (the songs store's override) comes back as the
// browser's buffer, e.g. after a reload
// ─────────────────────────────────────────────────────────────────────────────

describe("restore (rule 7)", () => {
  test("a saved edit the player already plays becomes the browser's buffer, with no eval", () => {
    const { session, timers, calls } = setup(disk("A"));
    session.restore("A2", { evaluated: true });
    const v = session.view();
    assert.equal(v.text, "A2");
    assert.equal(v.owner, "browser");
    assert.equal(v.readOnly, false);
    assert.equal(v.status.kind, "idle");
    timers.advance(1000);
    assert.equal(calls.length, 0);
  });

  test("a saved edit the player couldn't build is evaluated as typing, so its error shows inline", async () => {
    const { session, timers, calls } = setup(disk("A"));
    session.restore("A((", { evaluated: false });
    timers.advance(400);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].text, "A((");
    assert.equal(calls[0].intent, "typing");
    calls[0].resolve(fail("Expression expected.", 1));
    await flush();
    assert.equal(session.view().status.kind, "error");
    assert.equal(session.view().marker?.line, 1);
    assert.equal(session.view().text, "A((");
  });

  test("its echo is no conflict", () => {
    const { session } = setup(disk("A"));
    session.restore("A2", { evaluated: true });
    session.incoming(echo("A2"));
    assert.equal(session.view().conflict, null);
    assert.equal(session.view().owner, "browser");
  });

  test("a file saved afterwards with other text is a conflict, never a silent overwrite", () => {
    const { session } = setup(disk("A"));
    session.restore("A2", { evaluated: true });
    session.incoming(disk("B"));
    assert.equal(session.view().text, "A2");
    assert.equal(session.view().status.action, "load");
  });

  test("it replaces a read-only IDE buffer and a pending conflict", () => {
    const { session } = setup(ideLive("I"));
    session.restore("A2", { evaluated: false });
    assert.equal(session.view().readOnly, false);
    assert.equal(session.view().text, "A2");
    const other = setup(disk("A"));
    other.session.edit("AB");
    other.session.incoming(disk("X"));
    other.session.restore("A2", { evaluated: true });
    assert.equal(other.session.view().conflict, null);
  });

  test("does nothing once disposed", () => {
    const { session, views } = setup(disk("A"));
    session.dispose();
    const before = views.length;
    session.restore("A2", { evaluated: false });
    assert.equal(views.length, before);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Giving an eval up: the engine is told (its signal aborts), so it can't land
// ─────────────────────────────────────────────────────────────────────────────

describe("abandoned evals abort their signal", () => {
  test("every eval gets its own signal, not aborted while the session wants it", () => {
    const { session, timers, calls } = setup(disk("A"));
    session.edit("A1");
    timers.advance(400);
    void session.commit();
    assert.equal(calls.length, 2);
    assert.ok(calls[0].signal instanceof AbortSignal);
    assert.notEqual(calls[0].signal, calls[1].signal);
    assert.equal(calls[1].signal?.aborted, false);
  });

  test("load on a conflict aborts the eval in flight", () => {
    const { session, timers, calls } = setup(disk("A"));
    session.incoming(ideLive("X"));
    session.takeOver();
    session.incoming(ideLive("XY")); // the IDE's newer buffer: a conflict
    session.edit("X1");
    timers.advance(400);
    assert.equal(calls[0].signal?.aborted, false);
    session.loadIncoming();
    assert.equal(session.view().owner, "ide");
    assert.equal(calls[0].signal?.aborted, true);
  });

  test("a file saved with the buffer's text aborts the eval in flight", () => {
    const { session, calls } = setup(disk("A"));
    session.edit("A1");
    void session.commit();
    session.incoming(disk("A1"));
    assert.equal(session.view().owner, "mirror");
    assert.equal(calls[0].signal?.aborted, true);
  });

  test("an external change replacing the mirrored buffer aborts the eval in flight", () => {
    const { session, calls } = setup(disk("A"));
    void session.commit();
    session.incoming(disk("B"));
    assert.equal(session.view().text, "B");
    assert.equal(calls[0].signal?.aborted, true);
  });

  test("dispose aborts the eval in flight", () => {
    const { session, calls } = setup(disk("A"));
    session.edit("A1");
    void session.commit();
    session.dispose();
    assert.equal(calls[0].signal?.aborted, true);
  });

  test("an older eval still in flight is aborted too", () => {
    const { session, timers, calls } = setup(disk("A"));
    session.edit("A1");
    timers.advance(400);
    void session.commit();
    session.dispose();
    assert.deepEqual(
      calls.map((c) => c.signal?.aborted),
      [true, true]
    );
  });

  test("an eval that already finished is not aborted later", async () => {
    const { session, calls } = setup(disk("A"));
    session.edit("A1");
    void session.commit();
    calls[0].resolve(OK);
    await flush();
    session.incoming(disk("B"));
    session.loadIncoming();
    session.dispose();
    assert.equal(calls[0].signal?.aborted, false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// onOwnerChange: the stage drops the browser's kept edit when the browser
// stops owning the buffer, whichever way that happens
// ─────────────────────────────────────────────────────────────────────────────

describe("onOwnerChange", () => {
  test("typing reports mirror → browser once, not on every key", () => {
    const { session, owners } = setup(disk("A"));
    session.edit("A1");
    session.edit("A12");
    assert.deepEqual(owners, [["browser", "mirror"]]);
  });

  test("a file saved with the buffer's text reports browser → mirror", () => {
    const { session, owners } = setup(disk("A"));
    session.edit("A1");
    session.incoming(disk("A1"));
    assert.deepEqual(owners.at(-1), ["mirror", "browser"]);
  });

  test("load on a disk conflict reports browser → mirror", () => {
    const { session, owners } = setup(disk("A"));
    session.edit("A1");
    session.incoming(disk("X"));
    assert.deepEqual(owners.at(-1), ["browser", "mirror"], "a conflict alone keeps the browser the owner");
    session.loadIncoming();
    assert.deepEqual(owners.at(-1), ["mirror", "browser"]);
  });

  test("load on an IDE conflict reports browser → ide", () => {
    const { session, owners } = setup(disk("A"));
    session.edit("A1");
    session.incoming(ideLive("X"));
    session.loadIncoming();
    assert.deepEqual(owners.at(-1), ["ide", "browser"]);
  });

  test("an IDE buffer, take over, load and restore report their changes", () => {
    const { session, owners } = setup(disk("A"));
    session.incoming(ideLive("X"));
    session.takeOver();
    session.incoming(disk("Y"));
    session.loadIncoming();
    session.restore("Z", { evaluated: true });
    assert.deepEqual(owners, [
      ["ide", "mirror"],
      ["browser", "ide"],
      ["mirror", "browser"],
      ["browser", "mirror"],
    ]);
  });

  test("the session's view already shows the new owner when it is reported", () => {
    const seen: Owner[] = [];
    const session: EditSession = new EditSession({
      initial: disk("A"),
      evaluate: async () => OK,
      timers: new FakeTimers(),
      onChange: () => {},
      onOwnerChange: () => seen.push(session.view().owner),
    });
    session.edit("A1");
    session.incoming(disk("A1"));
    assert.deepEqual(seen, ["browser", "mirror"]);
  });

  test("an echo, a conflict or the same source again report nothing", async () => {
    const { session, calls, owners } = setup(disk("A"));
    session.edit("A1");
    void session.commit();
    calls[0].resolve(OK);
    await flush();
    session.incoming(echo("A1"));
    session.incoming(disk("X"));
    session.incoming(disk("X"));
    assert.deepEqual(owners, [["browser", "mirror"]]);
  });

  test("nothing is reported after dispose", () => {
    const { session, owners } = setup(disk("A"));
    session.edit("A1");
    session.dispose();
    session.incoming(disk("A1"));
    assert.deepEqual(owners, [["browser", "mirror"]]);
  });
});
