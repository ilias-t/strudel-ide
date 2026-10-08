// Unit tests for the extension's vscode-free logic. Run: npm test

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { contentVersion, DISCOVERY_FILE, parseMessage, type StateMsg } from "../../src/live/protocol.ts";
import { readDiscovery, resolveEndpoint, toBridgeUrl } from "../src/discovery.ts";
import { LiveModel, planEvaluate, planPlayFile } from "../src/model.ts";
import { isSongPath, relativeTo, resolveIn, songIdFromPath } from "../src/paths.ts";
import { LineIndex, findCreatePattern, normalizeRanges, toSpans } from "../src/ranges.ts";
import { barNumber, currentCycle, cyclesPerSecond, formatStatus } from "../src/status.ts";

const state = (over: Partial<StateMsg> = {}): StateMsg => ({
  type: "state",
  playing: true,
  songId: "jynx",
  songName: "Jynx",
  file: "src/songs/jynx.ts",
  bpm: 126,
  cycle: 32,
  error: null,
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────────

describe("LineIndex / offset → range", () => {
  test("maps offsets across \\n, \\r\\n and lone \\r", () => {
    const text = "ab\ncd\r\nef\rgh";
    const idx = new LineIndex(text);
    assert.equal(idx.lineCount, 4);
    const at = (o: number) => idx.positionAt(o);
    assert.deepEqual(at(0), { line: 0, character: 0 });
    assert.deepEqual(at(2), { line: 0, character: 2 }); // on the \n
    assert.deepEqual(at(3), { line: 1, character: 0 });
    assert.deepEqual(at(5), { line: 1, character: 2 }); // on \r of \r\n
    assert.deepEqual(at(6), { line: 1, character: 2 }); // between \r and \n → line end
    assert.deepEqual(at(7), { line: 2, character: 0 });
    assert.deepEqual(at(10), { line: 3, character: 0 });
    assert.deepEqual(at(12), { line: 3, character: 2 }); // EOF
    assert.deepEqual(at(999), { line: 3, character: 2 }); // clamped
    assert.deepEqual(at(-5), { line: 0, character: 0 });
  });

  test("agrees with a naive implementation on a real song-like text", () => {
    const text = 'const a = note("c3 e3 g3")\n  .s("sawtooth") // 🎵 emoji is 2 UTF-16 units\n\nexport default a;\n';
    const idx = new LineIndex(text);
    for (let o = 0; o <= text.length; o++) {
      const before = text.slice(0, o).split("\n");
      assert.deepEqual(idx.positionAt(o), { line: before.length - 1, character: before.at(-1)!.length }, `offset ${o}`);
    }
  });

  test("a mini-notation token's range maps onto its text", () => {
    const text = 'x\nconst k = s("bd*4 ~ cp");\n';
    const start = text.indexOf("cp");
    const [span] = toSpans(new LineIndex(text), [[start, start + 2]]);
    assert.deepEqual(span, { start: { line: 1, character: 20 }, end: { line: 1, character: 22 } });
    assert.equal(text.split("\n")[1].slice(20, 22), "cp");
  });

  test("normalizeRanges validates, clamps, sorts and merges overlaps", () => {
    assert.deepEqual(
      normalizeRanges(
        [[5, 8], [1, 3], [5, 8], [6, 9], [3, 4], [10, 10], [12, 99], ["a", 2], [7], null, [-4, 1], [NaN, 3]],
        20,
      ),
      [[0, 1], [1, 3], [3, 4], [5, 9], [12, 20]],
    );
    assert.deepEqual(normalizeRanges("nope", 10), []);
  });

  test("findCreatePattern", () => {
    const text = "const s = {\n  createPattern() {\n    return x;\n  },\n};\n// createPatterns\n";
    assert.deepEqual(findCreatePattern(text), [text.indexOf("createPattern()")]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("paths", () => {
  test("song files", () => {
    assert.ok(isSongPath("src/songs/jynx.ts"));
    assert.ok(!isSongPath("src/songs/index.ts"));
    assert.ok(!isSongPath("src/songs/_template.ts"));
    assert.ok(!isSongPath("src/songs/sub/x.ts"));
    assert.ok(!isSongPath("src/main.ts"));
    assert.ok(!isSongPath(null));
    assert.equal(songIdFromPath("src/songs/acid-house.ts"), "acid-house");
  });

  test("relative/resolve", () => {
    const root = join(tmpdir(), "proj");
    assert.equal(relativeTo(root, join(root, "src", "songs", "a.ts")), "src/songs/a.ts");
    assert.equal(relativeTo(root, join(tmpdir(), "other", "a.ts")), null);
    assert.equal(relativeTo(root, root), null);
    assert.equal(resolveIn(root, "src/songs/a.ts"), join(root, "src", "songs", "a.ts"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("LiveModel message handling", () => {
  test("player / state / songs / highlight lifecycle", () => {
    const m = new LiveModel();
    let ch = m.setBridge("connected");
    assert.ok(ch.status);

    ch = m.handle({ type: "player", connected: true });
    assert.ok(ch.status && m.player && !m.playing);

    m.handle({ type: "songs", songs: [{ id: "jynx", name: "Jynx", file: "src/songs/jynx.ts" }] });
    ch = m.handle(state(), 1000);
    assert.ok(ch.status && ch.lens && !ch.error);
    assert.ok(m.playing);
    assert.equal(m.stateAt, 1000);

    ch = m.handle({ type: "highlight", file: "src/songs/jynx.ts", ranges: [[1, 2]] });
    assert.deepEqual([...ch.highlights], ["src/songs/jynx.ts"]);
    assert.ok(m.highlights.has("src/songs/jynx.ts"));

    // empty ranges clear; clearing twice reports nothing
    ch = m.handle({ type: "highlight", file: "src/songs/jynx.ts", ranges: [] });
    assert.deepEqual([...ch.highlights], ["src/songs/jynx.ts"]);
    ch = m.handle({ type: "highlight", file: "src/songs/jynx.ts", ranges: [] });
    assert.equal(ch.highlights.size, 0);

    // stopping clears highlights, and late highlight frames are ignored
    m.handle({ type: "highlight", file: "src/songs/jynx.ts", ranges: [[1, 2]] });
    ch = m.handle(state({ playing: false }));
    assert.ok(ch.lens && ch.highlights.has("src/songs/jynx.ts"));
    assert.equal(m.highlights.size, 0);
    m.handle({ type: "highlight", file: "src/songs/jynx.ts", ranges: [[1, 2]] });
    assert.equal(m.highlights.size, 0);

    // errors
    ch = m.handle(state({ error: { message: "boom", file: "src/songs/jynx.ts", line: 3 } }));
    assert.ok(ch.error);
    ch = m.handle(state({ error: { message: "boom", file: "src/songs/jynx.ts", line: 3 } }));
    assert.ok(!ch.error, "same error → no diagnostics churn");
    ch = m.handle(state());
    assert.ok(ch.error);

    // player disconnect resets everything
    m.handle({ type: "highlight", file: "src/songs/jynx.ts", ranges: [[1, 2]] });
    ch = m.handle({ type: "player", connected: false });
    assert.ok(ch.status && ch.lens && ch.highlights.size === 1);
    assert.equal(m.state, null);
    assert.equal(m.highlights.size, 0);
  });

  test("bridge going offline resets player state and error", () => {
    const m = new LiveModel();
    m.setBridge("connected");
    m.handle(state({ error: { message: "x" } }));
    const ch = m.setBridge("offline");
    assert.ok(ch.status && ch.error && !m.player && m.state === null);
    assert.equal(m.setBridge("offline").status, false);
  });

  test("parseMessage feeds the model; junk is ignored", () => {
    const m = new LiveModel();
    for (const raw of ["", "{", "[]", "null", '{"type":1}']) assert.equal(parseMessage(raw), null);
    m.handle(parseMessage(JSON.stringify({ type: "unknown" }))!);
    assert.equal(m.state, null);
  });

  test("songIdFor / isCurrent", () => {
    const m = new LiveModel();
    m.handle({ type: "songs", songs: [{ id: "custom-id", name: "X", file: "src/songs/x.ts" }] });
    assert.equal(m.songIdFor("src/songs/x.ts"), "custom-id");
    assert.equal(m.songIdFor("src/songs/y.ts"), "y");
    m.handle(state({ file: null, songId: "custom-id" }));
    assert.ok(m.isCurrent("src/songs/x.ts"));
    assert.ok(!m.isCurrent("src/songs/y.ts"));
  });
});

describe("command planning", () => {
  const cmd = (command: string, extra = {}) => ({ kind: "send", msg: { type: "command", command, ...extra } });
  const select = (file: string, songId: string) => cmd("select", { file, songId });

  test("evaluate outside a song file toggles", () => {
    assert.deepEqual(planEvaluate(new LiveModel(), null, false), [cmd("toggle")]);
  });

  test("evaluate in a song file", () => {
    const m = new LiveModel();
    m.setBridge("connected");
    m.handle(state({ playing: false }));
    const f = "src/songs/jynx.ts";
    assert.deepEqual(planEvaluate(m, f, false), [select(f, "jynx"), cmd("play")]);
    assert.deepEqual(planEvaluate(m, f, true), [{ kind: "save" }, select(f, "jynx"), cmd("play")]);
    m.handle(state({ playing: true }));
    assert.deepEqual(planEvaluate(m, f, false), [cmd("stop")]);
    assert.deepEqual(planEvaluate(m, f, true), [{ kind: "save" }], "dirty + playing = update via HMR");
    // another song is playing → switch
    const other = "src/songs/lofi.ts";
    assert.deepEqual(planEvaluate(m, other, false), [select(other, "lofi"), cmd("play")]);
    assert.deepEqual(planPlayFile(m, other), [select(other, "lofi"), cmd("play")]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("status formatting", () => {
  test("bar numbers and extrapolation", () => {
    assert.equal(barNumber(0), 1);
    assert.equal(barNumber(32.99), 33);
    assert.equal(barNumber(-0.5), 1);
    assert.equal(cyclesPerSecond({ bpm: 120, cps: undefined }), 0.5);
    assert.equal(cyclesPerSecond({ bpm: 120, cps: 0.75 }), 0.75);
    assert.equal(cyclesPerSecond({ bpm: null, cps: null }), null);
    // 120 BPM → 0.5 cycles/s; 4 s later = 2 cycles on
    assert.equal(currentCycle(state({ bpm: 120, cycle: 10 }), 1000, 5000), 12);
    assert.equal(currentCycle(state({ playing: false, bpm: 120, cycle: 10 }), 1000, 5000), 10);
    assert.equal(currentCycle(state({ cycle: null }), 0, 1), null);
  });

  test("texts", () => {
    const m = new LiveModel();
    assert.equal(formatStatus(m).kind, "connecting");
    m.setBridge("offline");
    assert.equal(formatStatus(m).text, "$(debug-disconnect) Strudel: dev server not running");
    assert.equal(formatStatus(m).command, "strudel.startDevServer");
    m.setBridge("connected");
    m.handle({ type: "player", connected: false });
    assert.equal(formatStatus(m).text, "$(debug-disconnect) Strudel: player not connected");
    assert.equal(formatStatus(m).command, "strudel.openPlayer");

    m.handle(state({ cycle: 32.4 }), 1000);
    assert.equal(formatStatus(m, 1000).text, "▶ Jynx · 126 BPM · bar 33");
    // 126 BPM = 0.525 cycles/s; 2 s later = cycle 33.45 → bar 34
    assert.equal(formatStatus(m, 3000).text, "▶ Jynx · 126 BPM · bar 34");
    assert.equal(formatStatus(m).command, "strudel.toggle");

    m.handle(state({ playing: false }));
    assert.equal(formatStatus(m).text, "■ Jynx · 126 BPM");
    assert.equal(formatStatus(m).kind, "stopped");

    m.handle(state({ error: { message: "Unexpected token\n  at line 4", file: "src/songs/jynx.ts", line: 4, column: 2 } }));
    const v = formatStatus(m);
    assert.equal(v.kind, "error");
    assert.equal(v.text, "$(error) Jynx: Unexpected token at line 4");
    assert.match(v.tooltip, /src\/songs\/jynx\.ts:4:2/);

    m.handle(state({ error: { message: "x".repeat(200) } }));
    assert.ok(formatStatus(m).text.length < 80);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("discovery", () => {
  test("reads the discovery file, skips dead pids, setting overrides", () => {
    const dir = mkdtempSync(join(tmpdir(), "strudel-disc-"));
    const none = mkdtempSync(join(tmpdir(), "strudel-disc-"));
    try {
      assert.equal(readDiscovery([none]), null);
      const file = join(dir, DISCOVERY_FILE);
      mkdirSync(join(file, ".."), { recursive: true });
      const info = {
        url: "http://localhost:3002",
        port: 3002,
        bridgeUrl: "ws://localhost:3002/__strudel",
        root: dir,
        pid: process.pid,
        startedAt: "",
      };
      writeFileSync(file, JSON.stringify(info));
      assert.deepEqual(readDiscovery([none, dir]), info);
      assert.equal(readDiscovery([dir], () => false), null, "stale file from a dead server is ignored");

      assert.deepEqual(resolveEndpoint("", info), {
        httpUrl: "http://localhost:3002",
        wsUrl: "ws://localhost:3002/__strudel",
        root: dir,
        source: "discovery",
      });
      assert.equal(resolveEndpoint("http://127.0.0.1:4000", info).wsUrl, "ws://127.0.0.1:4000/__strudel");
      assert.equal(resolveEndpoint("http://127.0.0.1:4000", info).source, "setting");
      assert.equal(resolveEndpoint("not a url", null).source, "default");
      assert.equal(resolveEndpoint(undefined, null).wsUrl, "ws://localhost:3000/__strudel");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(none, { recursive: true, force: true });
    }
  });

  test("toBridgeUrl", () => {
    assert.equal(toBridgeUrl("https://my.host:8443/app/?x=1"), "wss://my.host:8443/__strudel");
    assert.equal(toBridgeUrl("http://localhost:3000"), "ws://localhost:3000/__strudel");
  });
});

test("contentVersion is stable and content-sensitive", () => {
  assert.equal(contentVersion(""), "811c9dc5");
  assert.equal(contentVersion("abc"), contentVersion("abc"));
  assert.notEqual(contentVersion('s("bd")'), contentVersion('s("bd ")'));
  assert.match(contentVersion("🎵 x"), /^[0-9a-f]{8}$/);
});
