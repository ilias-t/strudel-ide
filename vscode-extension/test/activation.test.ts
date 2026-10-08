// Drives the real extension.ts against a fake `vscode` module (test/fake-vscode.ts)
// and a fake bridge server, end to end over a WebSocket: discovery → connect →
// status bar → highlights → diagnostics → commands → disconnect.
//
// This stands in for an @vscode/test-electron smoke test (which would download
// a full VS Code build).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as nodeModule from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { contentVersion, DISCOVERY_FILE, editorFileUrl } from "../../src/live/protocol.ts";

// Route `import "vscode"` to the fake.
const fakeUrl = pathToFileURL(join(import.meta.dirname, "fake-vscode.ts")).href;
type ResolveHook = (s: string, c: unknown, next: (s: string, c: unknown) => unknown) => unknown;
(nodeModule as unknown as { registerHooks(h: { resolve: ResolveHook }): void }).registerHooks({
  resolve: (specifier, context, next) =>
    specifier === "vscode" ? { url: fakeUrl, shortCircuit: true } : next(specifier, context),
});

const vscode = await import("./fake-vscode.ts");
const ext = await import("../src/extension.ts");

/** Ranges of the extension's decoration layers on an editor */
const hl = (ed: InstanceType<typeof vscode.FakeEditor>) => ed.decorationsOf(vscode.isHighlight);
const pulsesOn = (ed: InstanceType<typeof vscode.FakeEditor>) => ed.decorationsOf(vscode.isPulse);
const dimOn = (ed: InstanceType<typeof vscode.FakeEditor>) => ed.decorationsOf(vscode.isDim);
const lines = (rs: { start: { line: number }; end: { line: number } }[]) => rs.map((r) => [r.start.line, r.end.line]);

const SONG = `import type { Song } from ".";

const song: Song = {
  name: "Jynx",
  bpm: 126,
  createPattern() {
    return s("bd*4 ~ cp").bank("RolandTR808");
  },
};

export default song;
`;

function until(cond: () => boolean, what: string, timeout = 3000): Promise<void> {
  return new Promise((res, rej) => {
    const start = Date.now();
    const tick = () => {
      if (cond()) return res();
      if (Date.now() - start > timeout) return rej(new Error(`timed out: ${what}`));
      setTimeout(tick, 5);
    };
    tick();
  });
}

let root: string;
let wss: WebSocketServer;
let editorSocket: WebSocket | null = null;
let hello: unknown = null;
const fromEditor: any[] = [];
const toEditor = (m: object) => editorSocket!.send(JSON.stringify(m));
const subscriptions: { dispose(): unknown }[] = [];

before(async () => {
  root = mkdtempSync(join(tmpdir(), "strudel-ext-"));
  mkdirSync(join(root, "src", "songs"), { recursive: true });
  writeFileSync(join(root, "src", "songs", "jynx.ts"), SONG);

  wss = new WebSocketServer({ port: 0, host: "127.0.0.1", path: "/__strudel" });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  wss.on("connection", (ws) => {
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === "hello") {
        editorSocket = ws;
        hello = m;
      }
      else fromEditor.push(m);
    });
  });
  const port = (wss.address() as AddressInfo).port;
  mkdirSync(join(root, "node_modules", ".strudel"), { recursive: true });
  writeFileSync(
    join(root, DISCOVERY_FILE),
    JSON.stringify({
      url: `http://127.0.0.1:${port}`,
      port,
      bridgeUrl: `ws://127.0.0.1:${port}/__strudel`,
      root,
      pid: process.pid,
      startedAt: "",
    }),
  );
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root) }];
});

after(() => {
  ext.deactivate();
  for (const s of subscriptions) s.dispose();
  wss.close();
  rmSync(root, { recursive: true, force: true });
});

test("extension end to end against a fake bridge", async () => {
  const doc = new vscode.FakeDocument(join(root, "src", "songs", "jynx.ts"), SONG);
  const other = new vscode.FakeDocument(join(root, "src", "main.ts"), "console.log(1)\n");
  vscode.workspace.textDocuments.push(doc, other);
  const editor = new vscode.FakeEditor(doc);
  const otherEditor = new vscode.FakeEditor(other);
  vscode.window._setEditors([editor, otherEditor], editor);

  ext.activate({ subscriptions } as any);
  await until(() => editorSocket !== null, "editor hello");
  assert.equal(vscode.recorded.context.get("strudel.isSongFile"), true);
  // the editor's URI scheme tells the player how to open files without the bridge
  assert.deepEqual(hello, { type: "hello", role: "editor", client: "strudel-live (Cursor)", scheme: "cursor" });

  // ── presence + state ────────────────────────────────────────────────────────
  toEditor({ type: "player", connected: false });
  await until(() => vscode.statusItem.text.includes("player not connected"), "no-player status");
  assert.equal(vscode.statusItem.command, "strudel.openPlayer");
  await vscode.commands.executeCommand("strudel.openPlayer");
  assert.match(vscode.recorded.opened.at(-1)!, /^http:\/\/127\.0\.0\.1:\d+/);

  toEditor({ type: "player", connected: true });
  toEditor({ type: "songs", songs: [{ id: "jynx", name: "Jynx", file: "src/songs/jynx.ts" }] });
  toEditor({ type: "state", playing: true, songId: "jynx", songName: "Jynx", file: "src/songs/jynx.ts", bpm: 126, cycle: 32.2, error: null });
  await until(() => vscode.statusItem.text === "▶ Jynx · bar 33 · 126 BPM", "playing status");
  assert.equal(vscode.statusItem.command, "strudel.toggle");
  assert.equal(vscode.recorded.context.get("strudel.playing"), true);

  // CodeLens shows Stop for the playing song
  const lenses = await vscode.codeLensProviders[0].provideCodeLenses(doc);
  assert.equal(lenses.length, 1);
  assert.equal(lenses[0].command.title, "■ Stop");
  assert.equal(lenses[0].range.start.line, SONG.split("\n").findIndex((l) => l.includes("createPattern")));

  // ── highlights ──────────────────────────────────────────────────────────────
  const cp = SONG.indexOf("cp");
  const bd = SONG.indexOf("bd*4");
  const line = SONG.slice(0, cp).split("\n").length - 1;
  const col = (o: number) => o - SONG.lastIndexOf("\n", o - 1) - 1;
  toEditor({ type: "highlight", file: "src/songs/jynx.ts", ranges: [[cp, cp + 2], [bd, bd + 2], [cp, cp + 2]], version: contentVersion(SONG) });
  await until(() => hl(editor).length > 0, "decorations");
  const ranges = hl(editor);
  assert.deepEqual(
    ranges.map((r) => [r.start.line, r.start.character, r.end.line, r.end.character]),
    [
      [line, col(bd), line, col(bd) + 2],
      [line, col(cp), line, col(cp) + 2],
    ],
  );
  assert.equal(otherEditor.setDecorationsCalls, 0, "unrelated editors are never touched");

  // stale version → cleared
  toEditor({ type: "highlight", file: "src/songs/jynx.ts", ranges: [[cp, cp + 2]], version: "deadbeef" });
  await until(() => hl(editor).length === 0, "stale version cleared");

  // no version → shown; then editing the doc clears immediately and suppresses
  toEditor({ type: "highlight", file: "src/songs/jynx.ts", ranges: [[cp, cp + 2]] });
  await until(() => hl(editor).length === 1, "unversioned shown");
  doc.edit(SONG.replace("bd*4", "bd*8"));
  assert.equal(hl(editor).length, 0, "dirty doc cleared synchronously");
  toEditor({ type: "highlight", file: "src/songs/jynx.ts", ranges: [[bd, bd + 2]] });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(hl(editor).length, 0, "no highlights on a dirty doc");

  // ── evaluate (Cmd+Enter) on a dirty, playing file = save only (HMR updates) ─
  await vscode.commands.executeCommand("strudel.evaluate");
  assert.equal(doc.saves, 1);
  assert.equal(fromEditor.length, 0);
  // clean + playing → stop
  await vscode.commands.executeCommand("strudel.evaluate");
  await until(() => fromEditor.length === 1, "stop command");
  assert.deepEqual(fromEditor.shift(), { type: "command", command: "stop" });

  // ── mute via quick pick ─────────────────────────────────────────────────────
  toEditor({ type: "state", playing: true, songId: "jynx", songName: "Jynx", file: "src/songs/jynx.ts", bpm: 126, cycle: 40, tracks: ["drums", "bass"], muted: [], soloed: [], error: null });
  await until(() => vscode.statusItem.text.includes("bar 41"), "state with tracks");
  vscode.window.quickPickAnswer = (items) => items.find((i: any) => i.track === "bass");
  await vscode.commands.executeCommand("strudel.muteTrack");
  await until(() => fromEditor.length === 1, "mute command");
  assert.deepEqual(fromEditor.shift(), { type: "command", command: "mute", track: "bass" });

  // ── errors → diagnostics + status ──────────────────────────────────────────
  toEditor({ type: "state", playing: true, songId: "jynx", songName: "Jynx", file: "src/songs/jynx.ts", bpm: 126, cycle: 41, error: { message: "s is not defined", file: "src/songs/jynx.ts", line: 7, column: 12 } });
  await until(() => vscode.diagnostics.size === 1, "diagnostic");
  const [diag] = vscode.diagnostics.get(join(root, "src", "songs", "jynx.ts"))!;
  assert.equal(diag.message, "s is not defined");
  assert.deepEqual([diag.range.start.line, diag.range.start.character], [6, 11]);
  assert.equal(vscode.statusItem.text, "$(error) Jynx: s is not defined");
  assert.equal(vscode.statusItem.backgroundColor?.id, "statusBarItem.errorBackground");
  toEditor({ type: "state", playing: false, songId: "jynx", songName: "Jynx", file: "src/songs/jynx.ts", bpm: 126, cycle: 41, error: null });
  await until(() => vscode.diagnostics.size === 0, "diagnostic cleared");
  assert.equal(vscode.statusItem.text, "■ Jynx · 126 BPM");

  // ── play this file from another editor's context ───────────────────────────
  await vscode.commands.executeCommand("strudel.playFile", doc.uri);
  await until(() => fromEditor.length === 2, "select+play");
  assert.deepEqual(fromEditor.splice(0), [
    { type: "command", command: "select", file: "src/songs/jynx.ts", songId: "jynx" },
    { type: "command", command: "play" },
  ]);

  // ── song position, sections, jump / loop ────────────────────────────────────
  const F = "src/songs/jynx.ts";
  const sections = [
    { name: "intro", start: 0, bars: 4 },
    { name: "drop", start: 4, bars: 8 },
  ];
  const playingState = { type: "state", playing: true, songId: "jynx", songName: "Jynx", file: F, bpm: 126, cycle: 100, error: null };
  toEditor({ ...playingState, position: 5.5, sections, section: 1, loop: false });
  await until(() => vscode.statusItem.text.startsWith("▶ Jynx · drop · bar 2/8"), "section status");
  assert.equal(vscode.recorded.context.get("strudel.hasSections"), true);
  let picked: any[] = [];
  vscode.window.quickPickAnswer = (items) => ((picked = items), items.find((i: any) => i.label.endsWith("intro")));
  await vscode.commands.executeCommand("strudel.jumpToSection");
  await until(() => fromEditor.length === 1, "jump command");
  assert.deepEqual(fromEditor.shift(), { type: "command", command: "jump", section: 0 });
  assert.deepEqual(picked.map((i) => i.label), ["$(blank) intro", "$(play) drop"]);
  await vscode.commands.executeCommand("strudel.jumpToSection", "drop"); // keybinding args
  await vscode.commands.executeCommand("strudel.nextSection");
  await vscode.commands.executeCommand("strudel.prevSection");
  await vscode.commands.executeCommand("strudel.toggleLoop");
  await until(() => fromEditor.length === 4, "section commands");
  assert.deepEqual(fromEditor.splice(0), [
    { type: "command", command: "jump", section: "drop" },
    { type: "command", command: "nextSection" },
    { type: "command", command: "prevSection" },
    { type: "command", command: "loop" },
  ]);
  toEditor({ ...playingState, position: 11.5, sections, section: 1, loop: true });
  await until(() => vscode.statusItem.text.startsWith("▶ Jynx · $(sync) drop · bar 8/8"), "loop status");
  assert.equal(vscode.recorded.context.get("strudel.looping"), true);
  // no sections → a hint, no command
  toEditor({ ...playingState, position: 1, sections: null, section: null });
  await until(() => vscode.recorded.context.get("strudel.hasSections") === false, "no sections");
  await vscode.commands.executeCommand("strudel.nextSection");
  assert.match(vscode.recorded.messages.at(-1)!.text, /no sections/);
  assert.equal(fromEditor.length, 0);

  // ── hit pulses: a short flash per onset, gone after ~140 ms ─────────────────
  const text = doc.getText(); // saved, edited above ("bd*8")
  const bd8 = text.indexOf("bd*8");
  toEditor({ type: "onsets", file: F, ranges: [[bd8, bd8 + 4]], version: contentVersion(text) });
  await until(() => pulsesOn(editor).length === 1, "pulse shown");
  const t0 = Date.now();
  await until(() => pulsesOn(editor).length === 0, "pulse expired");
  assert.ok(Date.now() - t0 < 400);
  // stale version → no pulse
  toEditor({ type: "onsets", file: F, ranges: [[bd8, bd8 + 4]], version: "deadbeef" });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(pulsesOn(editor).length, 0);

  // ── mixer: mute/solo CodeLens above each track, muted definitions dimmed ───
  const BEAT = `const song = {
  name: "Beat",
  createPattern() {
    const kick = s("bd*4");
    const hats = s("hh*8")
      .gain(0.4);
    return { kick, hats, bass: note("c2").s("sawtooth") };
  },
};
export default song;
`;
  writeFileSync(join(root, "src", "songs", "beat.ts"), BEAT);
  const beat = new vscode.FakeDocument(join(root, "src", "songs", "beat.ts"), BEAT);
  vscode.workspace.textDocuments.push(beat);
  const beatEditor = new vscode.FakeEditor(beat);
  vscode.window._setEditors([editor, otherEditor, beatEditor], editor);
  const B = "src/songs/beat.ts";
  const beatState = { type: "state", playing: true, songId: "beat", songName: "Beat", file: B, bpm: 120, cycle: 1, position: 1, tracks: ["kick", "hats", "bass"], error: null };
  toEditor({ ...beatState, muted: ["hats"], soloed: [] });
  await until(() => dimOn(beatEditor).length === 1, "muted track dimmed");
  const lineOf = (needle: string) => BEAT.split("\n").findIndex((l) => l.includes(needle));
  assert.deepEqual(lines(dimOn(beatEditor)), [[lineOf("const hats"), lineOf(".gain(0.4)")]]);
  let mixLenses = (await vscode.codeLensProviders[0].provideCodeLenses(beat)).map((l: any) => [l.range.start.line, l.command.title]);
  assert.deepEqual(mixLenses, [
    [lineOf("createPattern"), "■ Stop"],
    [lineOf("const kick"), "🔊 on · mute"],
    [lineOf("const kick"), "solo"],
    [lineOf("const hats"), "🔇 muted · unmute"],
    [lineOf("const hats"), "solo"],
    [lineOf("return"), "🔊 on · mute"],
    [lineOf("return"), "solo"],
    [lineOf("return"), "🎚 1 muted · unmute all"],
  ]);
  // clicking a lens toggles through the bridge
  const unmuteHats = (await vscode.codeLensProviders[0].provideCodeLenses(beat))[3].command;
  await vscode.commands.executeCommand(unmuteHats.command, ...unmuteHats.arguments);
  await until(() => fromEditor.length === 1, "lens mute command");
  assert.deepEqual(fromEditor.shift(), { type: "command", command: "mute", track: "hats" });
  // solo kick: everything else goes quiet
  toEditor({ ...beatState, muted: [], soloed: ["kick"] });
  await until(() => dimOn(beatEditor).length === 2, "solo dims the others");
  mixLenses = (await vscode.codeLensProviders[0].provideCodeLenses(beat)).map((l: any) => l.command.title);
  assert.deepEqual(mixLenses.slice(1, 3), ["🎧 solo · unsolo", "mute"]);
  assert.equal(mixLenses[3], "🔈 silent (solo) · solo");
  await vscode.commands.executeCommand("strudel.unmuteAll");
  await until(() => fromEditor.length === 1, "unmute all");
  assert.deepEqual(fromEditor.shift(), { type: "command", command: "unmuteAll" });
  toEditor({ ...beatState, muted: [], soloed: [] });
  await until(() => dimOn(beatEditor).length === 0, "undimmed");
  // the jynx editor shows no mixer lenses: it isn't the player's current song
  const jynxLenses = (await vscode.codeLensProviders[0].provideCodeLenses(doc)).map((l: any) => l.command.title);
  assert.deepEqual(jynxLenses, ["▶ Play"]);
  assert.equal(otherEditor.setDecorationsCalls, 0, "unrelated editors are never touched");

  // ── reveal: a click in the browser's code view opens the spot here ─────────
  vscode.config["strudel.reveal.focusWindow"] = "uri";
  toEditor({ type: "reveal", file: B, line: 5, column: 7 });
  await until(() => vscode.recorded.shown.length === 1, "file shown");
  const shown = vscode.recorded.shown[0];
  assert.equal(shown.path, join(root, "src", "songs", "beat.ts"));
  assert.deepEqual([shown.selection!.start.line, shown.selection!.start.character], [4, 6]);
  assert.equal(shown.preserveFocus, false);
  assert.equal(vscode.window.activeTextEditor, beatEditor, "reuses the editor that shows it");
  assert.equal(beatEditor.revealed.length, 1);
  await until(() => vscode.recorded.opened.includes(editorFileUrl("cursor", root, B, 5, 7)), "window focused via cursor://");
  // paths outside the project are ignored
  toEditor({ type: "reveal", file: "../outside.ts", line: 1 });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(vscode.recorded.shown.length, 1);
  vscode.config["strudel.reveal.focusWindow"] = "off";
  vscode.window._setEditors([editor, otherEditor], editor);

  // ── player disconnect clears highlights ─────────────────────────────────────
  toEditor({ type: "state", playing: true, songId: "jynx", songName: "Jynx", file: "src/songs/jynx.ts", bpm: 126, cycle: 0, error: null });
  toEditor({ type: "highlight", file: "src/songs/jynx.ts", ranges: [[cp, cp + 2]] });
  await until(() => hl(editor).length === 1, "highlight after save");
  toEditor({ type: "player", connected: false });
  await until(() => hl(editor).length === 0, "cleared on player disconnect");
  assert.match(vscode.statusItem.text, /player not connected/);

  // commands without a player warn instead of sending
  await vscode.commands.executeCommand("strudel.play");
  assert.match(vscode.recorded.messages.at(-1)!.text, /player not connected/);
  assert.equal(fromEditor.length, 0);

  // ── bridge goes away → offline status, then reconnects ─────────────────────
  editorSocket!.terminate();
  editorSocket = null;
  await until(() => vscode.statusItem.text.includes("dev server not running"), "offline status");
  assert.equal(vscode.recorded.context.get("strudel.connected"), false);
  await until(() => editorSocket !== null, "reconnect", 5000);
  await until(() => vscode.recorded.context.get("strudel.connected") === true, "reconnected");
});
