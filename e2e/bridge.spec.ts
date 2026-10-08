// Editor bridge, end to end: a Node WebSocket client plays the VS Code
// extension's role against the real page through the dev server relay.

import WebSocket from "ws";
import type { CommandMsg, SongsMsg, StateMsg } from "../src/live/protocol.ts";
import { BRIDGE_PATH } from "../src/live/protocol.ts";
import { BUILD_ERROR_MESSAGE, FIXTURE_FILE, FIXTURE_ID, lineOf, writeFixture } from "./fixture.ts";
import { expect, test } from "./player.ts";

type Msg = { type: string } & Record<string, unknown>;

/** Minimal editor: records every message and lets tests wait for one. */
class Editor {
  readonly messages: Msg[] = [];
  private waiters = new Set<() => void>();

  private constructor(private ws: WebSocket) {
    ws.on("message", (data) => {
      this.messages.push(JSON.parse(data.toString()) as Msg);
      for (const wake of this.waiters) wake();
    });
  }

  static async connect(baseURL: string): Promise<Editor> {
    const ws = new WebSocket(baseURL.replace(/^http/, "ws") + BRIDGE_PATH);
    const editor = new Editor(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.send(JSON.stringify({ type: "hello", role: "editor", client: "e2e" }));
    return editor;
  }

  send(command: Omit<CommandMsg, "type">) {
    this.ws.send(JSON.stringify({ type: "command", ...command }));
  }

  /** Resolve with the first message (at index >= `from`) matching `predicate`. */
  waitFor<T extends Msg>(
    predicate: (m: Msg) => boolean,
    description: string,
    { from = 0, timeout = 10_000 } = {}
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const found = this.messages.slice(from).find(predicate);
        if (!found) return;
        cleanup();
        resolve(found as T);
      };
      const timer = setTimeout(() => {
        cleanup();
        const recent = this.messages.slice(-5).map((m) => JSON.stringify(m).slice(0, 300));
        reject(new Error(`editor: timed out waiting for ${description}. Last messages:\n${recent.join("\n")}`));
      }, timeout);
      const cleanup = () => {
        clearTimeout(timer);
        this.waiters.delete(check);
      };
      this.waiters.add(check);
      check();
    });
  }

  /** Wait for a `state` message received after this call that matches `predicate`. */
  nextState(predicate: (s: StateMsg) => boolean, description: string): Promise<StateMsg> {
    return this.waitFor<StateMsg & Msg>(
      (m) => m.type === "state" && predicate(m as unknown as StateMsg),
      `state: ${description}`,
      { from: this.messages.length }
    );
  }

  close() {
    this.ws.close();
  }
}

let editor: Editor | undefined;
test.afterEach(() => editor?.close());

test("editor client drives the player and receives state, songs and errors", async ({ player }) => {
  await player.boot();
  editor = await Editor.connect(test.info().project.use.baseURL!);

  // On connect: whether a player is there, plus the cached song list and state.
  await editor.waitFor((m) => m.type === "player" && m.connected === true, "player connected");
  const { songs } = await editor.waitFor<SongsMsg & Msg>((m) => m.type === "songs", "songs");
  expect(songs).toContainEqual({ id: FIXTURE_ID, name: "E2E Fixture", file: FIXTURE_FILE });
  expect(songs.map((s) => s.id)).toEqual(await player.songIds());
  await editor.waitFor((m) => m.type === "state", "initial state");

  // select by file
  let pending = editor.nextState((s) => s.songId === FIXTURE_ID, "fixture selected");
  editor.send({ command: "select", file: FIXTURE_FILE });
  let state = await pending;
  expect(state).toMatchObject({ file: FIXTURE_FILE, songName: "E2E Fixture", playing: false });

  // play
  pending = editor.nextState((s) => s.playing, "playing");
  editor.send({ command: "play" });
  state = await pending;
  expect(state).toMatchObject({ songId: FIXTURE_ID, bpm: 120, cps: 0.5, error: null });
  expect((await player.state()).playing).toBe(true);

  // A build error reaches the editor with the 1-based line of the throw.
  const source = writeFixture({ buildError: true, gain: 0.8 });
  state = await editor.nextState((s) => s.error?.line !== undefined, "error with a line");
  expect(state.error).toMatchObject({
    message: BUILD_ERROR_MESSAGE,
    file: FIXTURE_FILE,
    line: lineOf(source, BUILD_ERROR_MESSAGE),
  });
  expect(state.playing).toBe(true);

  pending = editor.nextState((s) => s.error === null, "error cleared");
  writeFixture({ gain: 0.8 });
  await pending;

  // next: the song after the fixture in the player's order (wrapping around)
  const ids = songs.map((s) => s.id);
  const expected = ids[(ids.indexOf(FIXTURE_ID) + 1) % ids.length];
  pending = editor.nextState((s) => s.songId === expected, `next song (${expected})`);
  editor.send({ command: "next" });
  state = await pending;
  expect(state.playing).toBe(true);
  expect(state.file).toBe(`src/songs/${expected}.ts`);

  // stop
  pending = editor.nextState((s) => !s.playing, "stopped");
  editor.send({ command: "stop" });
  state = await pending;
  expect(state.cycle).toBeNull();
  expect((await player.state()).playing).toBe(false);
});

test("editor learns when the player page goes away", async ({ player, page }) => {
  await player.boot();
  editor = await Editor.connect(test.info().project.use.baseURL!);
  await editor.waitFor((m) => m.type === "player" && m.connected === true, "player connected");
  const from = editor.messages.length;
  await page.close();
  await editor.waitFor((m) => m.type === "player" && m.connected === false, "player disconnected", { from });
});
