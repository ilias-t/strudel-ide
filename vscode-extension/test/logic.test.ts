// Unit tests for the extension's vscode-free logic. Run: npm test

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { contentVersion, DISCOVERY_FILE, parseMessage, type StateMsg } from "../../src/live/protocol.ts";
import { readDiscovery, resolveEndpoint, toBridgeUrl } from "../src/discovery.ts";
import { LiveModel, planEvaluate, planPlayFile } from "../src/model.ts";
import { isSongPath, relativeTo, resolveIn, songIdFromPath } from "../src/paths.ts";
import { LineIndex, findCreatePattern, normalizeRanges, toSpans } from "../src/ranges.ts";
import { Pulses } from "../src/pulses.ts";
import { barNumber, currentCycle, cyclesPerSecond, formatStatus, songPosition } from "../src/status.ts";
import { findTracks, isAudible, tokenize } from "../src/tracks.ts";

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

  test("onsets become pulses while playing; reveal; mix changes", () => {
    const m = new LiveModel();
    m.setBridge("connected");
    const f = "src/songs/jynx.ts";
    // not playing yet → ignored
    let ch = m.handle({ type: "onsets", file: f, ranges: [[1, 3]] }, 0);
    assert.equal(ch.pulses.size, 0);
    m.handle(state({ tracks: ["kick", "bass"], muted: [], soloed: [] }), 0);
    ch = m.handle({ type: "onsets", file: f, ranges: [[1, 3], [5, 6]], version: "v" }, 100);
    assert.deepEqual([...ch.pulses], [f]);
    assert.deepEqual(m.pulses.active(f, 120), [[1, 3], [5, 6]]);
    // stop → pulses cleared and reported
    ch = m.handle(state({ playing: false, tracks: ["kick", "bass"] }), 150);
    assert.deepEqual([...ch.pulses], [f]);
    assert.deepEqual(m.pulses.active(f, 150), []);

    // reveal is passed through (1-based line required)
    ch = m.handle({ type: "reveal", file: f, line: 7, column: 3 });
    assert.deepEqual(ch.reveal, { type: "reveal", file: f, line: 7, column: 3 });
    assert.equal(m.handle({ type: "reveal", file: f, line: 0 }).reveal, null);
    assert.equal(m.handle({ type: "reveal", file: f } as never).reveal, null);

    // mute/solo/track changes → mix + lens; position-only updates → neither
    m.handle(state({ tracks: ["kick", "bass"], muted: [], soloed: [] }));
    ch = m.handle(state({ tracks: ["kick", "bass"], muted: [], soloed: [], position: 3 }));
    assert.ok(!ch.mix && !ch.lens);
    ch = m.handle(state({ tracks: ["kick", "bass"], muted: ["bass"], soloed: [] }));
    assert.ok(ch.mix && ch.lens);
    assert.deepEqual(m.tracksOf(f), { tracks: ["kick", "bass"], muted: ["bass"], soloed: [] });
    assert.equal(m.tracksOf("src/songs/other.ts"), null, "the mix belongs to the current song only");
    ch = m.handle({ type: "player", connected: false });
    assert.ok(ch.mix);
    assert.equal(m.tracksOf(f), null);
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
    assert.equal(formatStatus(m, 1000).text, "▶ Jynx · bar 33 · 126 BPM");
    // 126 BPM = 0.525 cycles/s; 2 s later = cycle 33.45 → bar 34
    assert.equal(formatStatus(m, 3000).text, "▶ Jynx · bar 34 · 126 BPM");
    // `position` (song position, jumps applied) wins over the scheduler cycle
    m.handle(state({ cycle: 32.4, position: 4.5 }), 1000);
    assert.equal(formatStatus(m, 1000).text, "▶ Jynx · bar 5 · 126 BPM");
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

  const sections = [
    { name: "intro", start: 0, bars: 8 },
    { name: "verse", start: 8, bars: 16 },
    { name: "chorus", start: 24, bars: 16 },
  ]; // 40 bars
  // 104 BPM, cps = 104/240 → 1 bar = 2.3077 s
  const neon = (over: Partial<StateMsg> = {}) =>
    state({ songName: "Neon Drive", bpm: 104, cps: 104 / 240, sections, ...over });
  const bar = (n: number) => (n * 240 * 1000) / 104; // ms for n bars

  test("song position: sections, wrapping, loops, pending jumps", () => {
    // chorus, bar 3 of 16
    let p = songPosition(neon({ position: 26.5, section: 2 }), 0, 0)!;
    assert.equal(p.section?.name, "chorus");
    assert.deepEqual([p.bar, p.beat, p.sectionBar], [27, 3, 3]);
    // extrapolates: 2 bars later → bar 5 of the chorus
    p = songPosition(neon({ position: 26.5, section: 2 }), 0, bar(2))!;
    assert.equal(p.sectionBar, 5);
    // past the end of the song → wraps to the intro (positions are unwrapped)
    p = songPosition(neon({ position: 39.5, section: 2 }), 0, bar(1))!;
    assert.deepEqual([p.section?.name, p.sectionBar, p.bar], ["intro", 1, 1]);
    p = songPosition(neon({ position: 80 + 9, section: 1 }), 0, 0)!; // third pass
    assert.deepEqual([p.section?.name, p.sectionBar], ["verse", 2]);
    // looping the chorus: stays inside it instead of moving on
    p = songPosition(neon({ position: 39.5, section: 2, loop: true }), 0, bar(1))!;
    assert.deepEqual([p.section?.name, p.sectionBar, p.loop], ["chorus", 1, true]);
    p = songPosition(neon({ position: 30, section: 2, loop: true }), 0, bar(16 * 3 + 2))!;
    assert.deepEqual([p.section?.name, p.sectionBar], ["chorus", 9]);
    // a pending jump is named
    p = songPosition(neon({ position: 23.9, section: 1, pendingJump: { index: 2 } }), 0, 0)!;
    assert.equal(p.next, "chorus");
    // stopped → none
    assert.equal(songPosition(neon({ playing: false, position: null }), 0, 0), null);
  });

  test("status bar with sections", () => {
    const m = new LiveModel();
    m.setBridge("connected");
    m.handle(neon({ position: 26.2, section: 2 }), 0);
    assert.equal(formatStatus(m, 0).text, "▶ Neon Drive · chorus · bar 3/16 · 104 BPM");
    assert.match(String(formatStatus(m, 0).tooltip), /Section 3\/3: chorus, bar 3 of 16 \(song bar 27\)/);
    // a jump lands: the next state re-anchors the position
    m.handle(neon({ position: 8, section: 1 }), 1000);
    assert.equal(formatStatus(m, 1000).text, "▶ Neon Drive · verse · bar 1/16 · 104 BPM");
    m.handle(neon({ position: 30, section: 2, loop: true }), 0);
    assert.equal(formatStatus(m, 0).text, "▶ Neon Drive · $(sync) chorus · bar 7/16 · 104 BPM");
    m.handle(neon({ position: 23.5, section: 1, pendingJump: { index: 0 } }), 0);
    assert.equal(formatStatus(m, 0).text, "▶ Neon Drive · verse → intro · bar 16/16 · 104 BPM");
    m.handle(neon({ playing: false, position: null }), 0);
    assert.equal(formatStatus(m, 0).text, "■ Neon Drive · 104 BPM");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("track definitions", () => {
  const SONG = `import type { Song } from ".";

const BANK = "RolandTR808"; // top-level const
const pad = note("<c3 e3>").s("sawtooth");

const song: Song = {
  name: "Test",
  createPattern(): Pattern | Record<string, Pattern> {
    const helper = (p: Pattern) => {
      return { not: "the tracks" }; // nested return
    };
    const kick = s("bd*4") // a comment with a } brace
      .bank(BANK)
      .gain(0.9);
    let hats = s(\`hh*\${8}\`).gain(/[}]/.test("x") ? 0.3 : 0.2);
    const unused = s("~");
    return {
      kick,
      hats,
      "lead": n("0 2 4").scale("C:minor"),
      bass: note("c2*8")
        .s("sawtooth")
        .lpf(400),
      drums: kick,
      pad,
      ...extra,
    };
  },
};

export default song;
`;
  const r = findTracks(SONG);
  const by = Object.fromEntries(r.tracks.map((t) => [t.name, SONG.slice(t.start, t.end)]));

  test("finds each returned key's definition", () => {
    assert.deepEqual(
      r.tracks.map((t) => [t.name, t.kind]),
      [
        ["kick", "declaration"],
        ["hats", "declaration"],
        ["lead", "property"],
        ["bass", "property"],
        ["drums", "declaration"],
        ["pad", "declaration"],
      ],
    );
    assert.equal(by.kick, 'const kick = s("bd*4") // a comment with a } brace\n      .bank(BANK)\n      .gain(0.9);');
    assert.match(by.hats, /^let hats = s\(`hh\*\$\{8\}`\)\.gain\(.*0\.2\);$/);
    assert.equal(by.lead, '"lead": n("0 2 4").scale("C:minor")');
    assert.equal(by.bass, 'bass: note("c2*8")\n        .s("sawtooth")\n        .lpf(400)');
    assert.equal(by.drums, by.kick, "an identifier value resolves to its declaration");
    assert.equal(by.pad, 'const pad = note("<c3 e3>").s("sawtooth");', "falls back to top-level declarations");
    assert.equal(SONG.slice(r.returnAt!, r.returnAt! + 8), "return {");
  });

  test("statements without semicolons end at the next statement", () => {
    const text = `export default { createPattern() {
  const a = s("bd")
    .gain(1)
  const b = s("hh")
  return { a, b }
} }`;
    const t = findTracks(text).tracks;
    assert.deepEqual(t.map((x) => text.slice(x.start, x.end)), ['const a = s("bd")\n    .gain(1)', 'const b = s("hh")']);
  });

  test("returning a named object, arrow functions, and non-track songs", () => {
    const named = `const song = { createPattern: () => {
  const kick = s("bd*4");
  const tracks = { kick, snare: s("~ sd") };
  return tracks;
} };`;
    assert.deepEqual(findTracks(named).tracks.map((t) => t.name), ["kick", "snare"]);
    assert.deepEqual(findTracks(`const song = { createPattern() { return stack(s("bd"), s("hh")); } };`), {
      tracks: [],
      returnAt: null,
    });
    assert.deepEqual(findTracks("no song here"), { tracks: [], returnAt: null });
  });

  test("the tokenizer skips strings, templates, comments and regexes", () => {
    const toks = tokenize('a("}", `${"}"}`, /}/g) /* } */ // }\n{ }');
    assert.deepEqual(
      toks.map((t) => t.v),
      ["a", "(", '"}"', ",", '`${"}"}`', ",", "/}/g", ")", "{", "}"],
    );
    assert.deepEqual(toks.map((t) => t.depth), [0, 0, 1, 1, 1, 1, 1, 0, 0, 0]);
  });

  test("isAudible: solo beats mute", () => {
    assert.ok(isAudible("kick"));
    assert.ok(!isAudible("kick", ["kick"]));
    assert.ok(isAudible("kick", ["kick"], ["kick"]));
    assert.ok(!isAudible("bass", [], ["kick"]));
  });

  test("real songs: every returned track is found", () => {
    const songsDir = join(import.meta.dirname, "..", "..", "src", "songs");
    for (const f of readdirSync(songsDir)) {
      if (f === "index.ts" || !f.endsWith(".ts")) continue;
      const text = readFileSync(join(songsDir, f), "utf8");
      const found = findTracks(text);
      // Songs that build their track record dynamically (e.g. tour.ts's `return tracks;`) can't be mapped statically
      const lastReturn = [...text.matchAll(/^\s+return\s+([^;\n]*)/gm)].at(-1)?.[1] ?? "";
      if (!/^(\w+\()?\{/.test(lastReturn)) continue;
      assert.ok(found.tracks.length > 0, `${f}: no tracks`);
      for (const t of found.tracks) {
        const def = text.slice(t.start, t.end);
        assert.ok(def.startsWith(t.kind === "declaration" ? "" : t.name), `${f}: ${t.name} → ${def.slice(0, 40)}`);
        assert.ok(def.includes(t.name), `${f}: ${t.name} not in its definition`);
      }
    }
  });
});

describe("pulses", () => {
  test("expire, track versions and report the next expiry", () => {
    const p = new Pulses(100);
    assert.ok(p.add("f", [[1, 2], [3, 4], ["x"], [5, 5]], "v1", 0));
    assert.deepEqual(p.active("f", 50), [[1, 2], [3, 4]]);
    assert.equal(p.nextExpiry(), 100);
    p.add("f", [[1, 2]], "v1", 80); // re-hit extends
    assert.deepEqual(p.active("f", 120), [[1, 2]]);
    assert.equal(p.nextExpiry(), 180);
    // another version of the file drops the old offsets
    p.add("f", [[7, 9]], "v2", 130);
    assert.deepEqual(p.active("f", 131), [[7, 9]]);
    assert.equal(p.version("f"), "v2");
    assert.deepEqual(p.active("f", 1000), []);
    assert.equal(p.nextExpiry(), null);
    assert.equal(p.add("f", "junk", undefined, 0), false);
    p.add("g", [[1, 2]], undefined, 0);
    assert.deepEqual(p.clear(), ["g"]);
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
