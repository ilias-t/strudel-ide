// Integration test for the live bridge: real Vite dev server + the relay
// plugin, the real browser client (Node's global WebSocket) as the player and
// a `ws` client as the editor.
//
// Run: node --test test/bridge.test.ts   (Node ≥ 22.18 strips TS types)

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { createServer, loadConfigFromFile, type ViteDevServer } from "vite";
import WebSocket from "ws";
import strudelBridge, { createBridgeRelay, detectEditorScheme } from "../vite-plugins/strudel-bridge.ts";
import { connectBridge, type BridgeClient, type BridgeClientOptions } from "../src/live/bridge-client.ts";
import { DISCOVERY_FILE, editorFileUrl, type CommandMsg, type DiscoveryInfo } from "../src/live/protocol.ts";

const repoRoot = resolve(import.meta.dirname, "..");

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

type Msg = { type: string; [k: string]: unknown };

/** A `ws` client that queues parsed messages so tests can await them in order. */
class Peer {
  ws: WebSocket;
  queue: Msg[] = [];
  waiters: ((m: Msg) => void)[] = [];
  opened: Promise<void>;

  constructor(url: string, opts: WebSocket.ClientOptions = {}, protocol?: string) {
    this.ws = protocol ? new WebSocket(url, protocol, opts) : new WebSocket(url, opts);
    this.ws.on("message", (data) => {
      const m = JSON.parse(data.toString()) as Msg;
      const w = this.waiters.shift();
      if (w) w(m);
      else this.queue.push(m);
    });
    this.opened = new Promise((res, rej) => {
      this.ws.once("open", () => res());
      this.ws.once("error", rej);
    });
  }

  static async editor(url: string, hello: object = {}): Promise<Peer> {
    const p = new Peer(url);
    await p.opened;
    p.send({ type: "hello", role: "editor", client: "test", ...hello });
    return p;
  }

  send(m: object) {
    this.ws.send(JSON.stringify(m));
  }

  next(timeout = 2000): Promise<Msg> {
    const m = this.queue.shift();
    if (m) return Promise.resolve(m);
    return new Promise((res, rej) => {
      const t = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        rej(new Error("timed out waiting for a message"));
      }, timeout);
      const waiter = (msg: Msg) => {
        clearTimeout(t);
        res(msg);
      };
      this.waiters.push(waiter);
    });
  }

  /** Resolve true if no message arrives within `ms`. */
  async silent(ms = 150): Promise<boolean> {
    try {
      const m = await this.next(ms);
      this.queue.unshift(m);
      return false;
    } catch {
      return true;
    }
  }

  close() {
    this.ws.close();
  }
}

function until(cond: () => boolean, timeout = 2000): Promise<void> {
  return new Promise((res, rej) => {
    const start = Date.now();
    const tick = () => {
      if (cond()) return res();
      if (Date.now() - start > timeout) return rej(new Error("condition not met"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

const sampleState = {
  playing: true,
  songId: "jynx",
  songName: "Jynx",
  file: "src/songs/jynx.ts",
  bpm: 126,
  cycle: 32.5,
  tracks: ["drums", "bass"],
  error: null,
};
const sampleSongs = [{ id: "jynx", name: "Jynx", file: "src/songs/jynx.ts" }];

// ─────────────────────────────────────────────────────────────────────────────
// Vite dev server with the plugin
// ─────────────────────────────────────────────────────────────────────────────

describe("strudel-bridge on a Vite dev server", () => {
  let root: string;
  let server: ViteDevServer;
  let base: string; // http://localhost:PORT
  let bridgeUrl: string;
  const browsers: BridgeClient[] = [];
  const peers: Peer[] = [];

  const editor = async (hello: object = {}) => {
    const p = await Peer.editor(bridgeUrl, hello);
    peers.push(p);
    return p;
  };
  const browser = (onCommand: (c: CommandMsg) => void = () => {}, more: Partial<BridgeClientOptions> = {}) => {
    const b = connectBridge({ url: bridgeUrl, enabled: true, onCommand, minDelay: 50, ...more });
    browsers.push(b);
    return b;
  };

  before(async () => {
    // the shared server's scheme comes from the editors / detection, not the env
    delete process.env.STRUDEL_EDITOR;
    root = mkdtempSync(join(tmpdir(), "strudel-bridge-"));
    writeFileSync(join(root, "index.html"), `<script type="module" src="/main.js"></script>`);
    writeFileSync(join(root, "main.js"), `console.log("hi")`);
    server = await createServer({
      configFile: false,
      root,
      logLevel: "silent",
      plugins: [strudelBridge({ log: false })],
      server: { port: 0, host: "127.0.0.1" },
    });
    await server.listen();
    const port = (server.httpServer!.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
    bridgeUrl = `ws://127.0.0.1:${port}/__strudel`;
  });

  after(async () => {
    for (const b of browsers) b.close();
    for (const p of peers) p.close();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("writes the discovery file with the real port", () => {
    const info = JSON.parse(readFileSync(join(root, DISCOVERY_FILE), "utf8")) as DiscoveryInfo;
    const port = (server.httpServer!.address() as AddressInfo).port;
    assert.equal(info.port, port);
    assert.equal(info.url, `http://localhost:${port}`);
    assert.equal(info.bridgeUrl, `ws://localhost:${port}/__strudel`);
    assert.equal(info.root, server.config.root);
    assert.equal(info.pid, process.pid);
  });

  test("relays both ways, replays cached state, reports player presence", async () => {
    const early = await editor();
    assert.deepEqual(await early.next(), { type: "player", connected: false });

    const commands: CommandMsg[] = [];
    const player = browser((c) => commands.push(c));
    assert.deepEqual(await early.next(), { type: "player", connected: true });

    player.sendSongs(sampleSongs);
    player.sendState(sampleState);
    assert.deepEqual(await early.next(), { type: "songs", songs: sampleSongs });
    assert.deepEqual(await early.next(), { type: "state", ...sampleState });

    // Late joiner gets presence + latest songs + latest state, in that order.
    const updated = { ...sampleState, cycle: 40 };
    player.sendState(updated);
    assert.equal((await early.next()).cycle, 40);
    const late = await editor();
    assert.deepEqual(await late.next(), { type: "player", connected: true });
    assert.deepEqual(await late.next(), { type: "songs", songs: sampleSongs });
    assert.deepEqual(await late.next(), { type: "state", ...updated });

    // Highlights reach every editor; identical consecutive frames are deduped.
    player.sendHighlight("src/songs/jynx.ts", [[10, 14], [20, 22]], "abc");
    player.sendHighlight("src/songs/jynx.ts", [[10, 14], [20, 22]], "abc");
    player.sendHighlight("src/songs/jynx.ts", []);
    for (const ed of [early, late]) {
      assert.deepEqual(await ed.next(), {
        type: "highlight",
        file: "src/songs/jynx.ts",
        ranges: [[10, 14], [20, 22]],
        version: "abc",
      });
      assert.deepEqual(await ed.next(), { type: "highlight", file: "src/songs/jynx.ts", ranges: [] });
    }

    // Editor → browser commands.
    late.send({ type: "command", command: "select", file: "src/songs/jynx.ts" });
    early.send({ type: "command", command: "play" });
    await until(() => commands.length === 2);
    assert.deepEqual(commands, [
      { type: "command", command: "select", file: "src/songs/jynx.ts" },
      { type: "command", command: "play" },
    ]);
    // Editor messages are not echoed to other editors.
    assert.ok(await early.silent());
    assert.ok(await late.silent());

    // Browser leaves → editors told; late joiners get no stale state.
    player.close();
    assert.deepEqual(await early.next(), { type: "player", connected: false });
    assert.deepEqual(await late.next(), { type: "player", connected: false });
    const later = await editor();
    assert.deepEqual(await later.next(), { type: "player", connected: false });
    assert.ok(await later.silent());
  });

  test("drops messages sent before hello and garbage frames", async () => {
    const ed = await editor();
    await ed.next(); // player
    const rogue = new Peer(bridgeUrl);
    peers.push(rogue);
    await rogue.opened;
    rogue.send({ type: "state", ...sampleState }); // no hello yet
    rogue.ws.send("not json");
    rogue.send({ type: "hello", role: "browser" });
    assert.deepEqual(await ed.next(), { type: "player", connected: true });
    rogue.ws.send("{broken");
    // browsers can't spoof server messages
    rogue.send({ type: "player", connected: false });
    rogue.send({ type: "editors", count: 7, clients: [] });
    rogue.send({ type: "server", root: "/evil", editorScheme: "evil" });
    assert.ok(await ed.silent());
    // …and neither can editors
    const rogueSaw: string[] = [];
    rogue.ws.on("message", (d) => rogueSaw.push(JSON.parse(d.toString()).type));
    ed.send({ type: "editors", count: 7, clients: [] });
    ed.send({ type: "server", root: "/evil", editorScheme: "evil" });
    ed.send({ type: "player", connected: false });
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(rogueSaw, []);
    rogue.close();
    assert.deepEqual(await ed.next(), { type: "player", connected: false });
  });

  test("tells browsers about attached editors and the project root; relays onsets and reveal", async () => {
    for (const p of peers.splice(0)) p.close(); // earlier tests' editors
    await new Promise((r) => setTimeout(r, 100));
    const seen: { count: number; clients: string[] }[] = [];
    const infos: { root: string; editorScheme: string }[] = [];
    const player = browser(() => {}, {
      onEditors: (e) => seen.push(e),
      onServerInfo: (i) => infos.push(i),
    });
    // on hello: server info, then the editor count (none yet)
    await until(() => seen.length === 1 && infos.length === 1);
    assert.deepEqual(seen[0], { count: 0, clients: [] });
    assert.equal(infos[0].root, server.config.root);
    assert.match(infos[0].editorScheme, /^(vscode|cursor|vscode-insiders)$/);
    assert.equal(player.editors, 0);

    // an editor attaches with its URI scheme: new count + new fallback scheme
    const cursor = await editor({ client: "strudel-live (Cursor)", scheme: "cursor" });
    await until(() => seen.length === 2);
    assert.deepEqual(seen[1], { count: 1, clients: ["strudel-live (Cursor)"] });
    assert.equal(player.editors, 1);
    await until(() => player.serverInfo?.editorScheme === "cursor");
    // a second editor with a junk scheme doesn't change it
    const second = await editor({ scheme: "not a scheme!" });
    await until(() => seen.at(-1)!.count === 2);
    assert.deepEqual(seen.at(-1)!.clients, ["strudel-live (Cursor)", "test"]);
    assert.equal(player.serverInfo?.editorScheme, "cursor");

    for (const ed of [cursor, second]) {
      await until(() => ed.queue.length > 0);
      ed.queue.length = 0; // player presence (+ cached state)
    }
    // onsets + reveal reach every editor; empty onset frames are not sent
    player.sendOnsets("src/songs/jynx.ts", [[3, 5]], "v1");
    player.sendOnsets("src/songs/jynx.ts", []);
    assert.equal(player.sendReveal("src/songs/jynx.ts", 12, 7), true);
    for (const ed of [cursor, second]) {
      assert.deepEqual(await ed.next(), { type: "onsets", file: "src/songs/jynx.ts", ranges: [[3, 5]], version: "v1" });
      assert.deepEqual(await ed.next(), { type: "reveal", file: "src/songs/jynx.ts", line: 12, column: 7 });
      assert.ok(await ed.silent(50));
    }

    // editors leave → browsers are told
    second.close();
    await until(() => seen.at(-1)!.count === 1);
    cursor.close();
    await until(() => seen.at(-1)!.count === 0 && player.editors === 0);
    // the scheme sticks after the editor left (it's the user's editor)
    const late = browser();
    await until(() => late.serverInfo !== null);
    assert.equal(late.serverInfo!.editorScheme, "cursor");
    player.close();
    late.close();
  });

  test("rejects cross-site browser origins", async () => {
    const evil = new WebSocket(bridgeUrl, { headers: { origin: "https://evil.example" } });
    const status = await new Promise<number | undefined>((res) => {
      evil.once("unexpected-response", (_req, r) => res(r.statusCode));
      evil.once("open", () => res(101));
      evil.once("error", () => res(undefined));
    });
    evil.terminate();
    assert.equal(status, 403);
    const ok = new Peer(bridgeUrl, { headers: { origin: base } });
    await ok.opened;
    ok.close();
  });

  test("Vite HMR socket still works", async () => {
    const hmr = new Peer(`ws://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}/`, {}, "vite-hmr");
    peers.push(hmr);
    await hmr.opened;
    assert.equal((await hmr.next()).type, "connected");
    // and the HMR channel still pushes updates
    server.hot.send({ type: "custom", event: "strudel-test", data: 1 });
    assert.deepEqual(await hmr.next(), { type: "custom", event: "strudel-test", data: 1 });
  });

  test("leaves unrelated upgrade requests alone", async () => {
    const port = (server.httpServer!.address() as AddressInfo).port;
    for (const path of ["/__strudel-not", "/other", "/__strudel/sub"]) {
      const sock = new WebSocket(`ws://127.0.0.1:${port}${path}`);
      const outcome = await new Promise<string>((res) => {
        const t = setTimeout(() => res("pending"), 300);
        sock.once("open", () => (clearTimeout(t), res("open")));
        sock.once("error", () => (clearTimeout(t), res("error")));
      });
      sock.terminate();
      assert.notEqual(outcome, "open", `${path} must not be accepted by the bridge`);
    }
  });

  test("plain HTTP still served", async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /main\.js/);
  });

  test("removes the discovery file on close", async () => {
    // Separate server so the shared one stays up for the other tests.
    const root2 = mkdtempSync(join(tmpdir(), "strudel-bridge-"));
    writeFileSync(join(root2, "index.html"), "<p>hi</p>");
    const s2 = await createServer({
      configFile: false,
      root: root2,
      logLevel: "silent",
      plugins: [strudelBridge({ log: false })],
      server: { port: 0, host: "127.0.0.1" },
    });
    await s2.listen();
    const file = join(root2, DISCOVERY_FILE);
    assert.ok(existsSync(file));
    await s2.close();
    assert.ok(!existsSync(file));
    rmSync(root2, { recursive: true, force: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Relay without Vite: browser client reconnect + resend
// ─────────────────────────────────────────────────────────────────────────────

describe("browser client", () => {
  test("reconnects and re-sends the latest songs/state", async () => {
    const http: Server = createHttpServer();
    await new Promise<void>((res) => http.listen(0, "127.0.0.1", res));
    const url = `ws://127.0.0.1:${(http.address() as AddressInfo).port}/__strudel`;
    let relay = createBridgeRelay();
    let detach = relay.attach(http);

    const changes: boolean[] = [];
    const player = connectBridge({
      url,
      enabled: true,
      minDelay: 30,
      onCommand: () => {},
      onConnectionChange: (c) => changes.push(c),
    });
    await until(() => player.connected);
    player.sendSongs(sampleSongs);
    player.sendState(sampleState);
    await until(() => relay.counts().browsers === 1);

    // Server goes away (e.g. Vite restart), then comes back.
    detach();
    relay.close();
    await until(() => !player.connected);
    relay = createBridgeRelay();
    detach = relay.attach(http);

    const ed = await Peer.editor(url);
    assert.deepEqual(await ed.next(), { type: "player", connected: false });
    assert.deepEqual(await ed.next(), { type: "player", connected: true });
    assert.deepEqual(await ed.next(), { type: "songs", songs: sampleSongs });
    assert.deepEqual(await ed.next(), { type: "state", ...sampleState });
    assert.deepEqual(changes, [true, false, true]);

    // close() stops reconnecting
    player.close();
    assert.deepEqual(await ed.next(), { type: "player", connected: false });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(relay.counts().browsers, 0);

    ed.close();
    detach();
    relay.close();
    await new Promise<void>((res) => http.close(() => res()));
  });

  test("is a no-op when disabled", () => {
    const c = connectBridge({ enabled: false, onCommand: () => {} });
    c.sendState(sampleState);
    c.sendSongs([]);
    c.sendHighlight("x", []);
    assert.equal(c.connected, false);
    c.close();
  });

  test("defaults to disabled outside a browser/Vite (no location)", () => {
    const c = connectBridge({ onCommand: () => {} });
    assert.equal(c.connected, false);
    c.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The project config registers the plugin
// ─────────────────────────────────────────────────────────────────────────────

test("vite.config.ts registers strudel-bridge", async () => {
  const loaded = await loadConfigFromFile(
    { command: "serve", mode: "development" },
    join(repoRoot, "vite.config.ts"),
    repoRoot,
    "silent",
  );
  const names = (loaded?.config.plugins ?? []).flat().map((p) => (p as { name?: string })?.name);
  assert.ok(names.includes("strudel-bridge"), `plugins: ${names.join(", ")}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Editor scheme + file links
// ─────────────────────────────────────────────────────────────────────────────

describe("editor scheme", () => {
  const none = () => false;
  test("detects Cursor from its terminal or installation, else VS Code", () => {
    assert.equal(detectEditorScheme({ CURSOR_TRACE_ID: "x" }, none, "darwin"), "cursor");
    assert.equal(
      detectEditorScheme(
        { VSCODE_GIT_ASKPASS_MAIN: "/Applications/Cursor.app/Contents/Resources/app/extensions/git/dist/askpass-main.js" },
        none,
        "darwin",
      ),
      "cursor",
    );
    assert.equal(detectEditorScheme({ __CFBundleIdentifier: "com.microsoft.VSCode" }, none, "darwin"), "vscode");
    assert.equal(detectEditorScheme({ __CFBundleIdentifier: "com.microsoft.VSCodeInsiders" }, none, "darwin"), "vscode-insiders");
    assert.equal(detectEditorScheme({}, (p) => p === "/Applications/Cursor.app", "darwin"), "cursor");
    assert.equal(detectEditorScheme({ PATH: "/usr/bin:/opt/cursor/bin" }, (p) => p === "/opt/cursor/bin/cursor", "linux"), "cursor");
    assert.equal(detectEditorScheme({ PATH: "/usr/bin" }, none, "linux"), "vscode");
  });

  test("a configured scheme beats the editors' schemes", async () => {
    const http: Server = createHttpServer();
    await new Promise<void>((res) => http.listen(0, "127.0.0.1", res));
    const url = `ws://127.0.0.1:${(http.address() as AddressInfo).port}/__strudel`;
    const relay = createBridgeRelay(() => {}, { root: "/proj", editorScheme: "vscode-insiders", detectedScheme: "cursor" });
    const detach = relay.attach(http);
    const ed = await Peer.editor(url, { scheme: "cursor" });
    const b = connectBridge({ url, enabled: true, onCommand: () => {} });
    await until(() => b.serverInfo !== null && b.editors === 1);
    assert.deepEqual(b.serverInfo, { root: "/proj", editorScheme: "vscode-insiders" });
    b.close();
    ed.close();
    detach();
    relay.close();
    await new Promise<void>((res) => http.close(() => res()));
  });

  test("editorFileUrl", () => {
    assert.equal(
      editorFileUrl("cursor", "/Users/me/strudel", "src/songs/jynx.ts", 12, 7),
      "cursor://file/Users/me/strudel/src/songs/jynx.ts:12:7",
    );
    assert.equal(editorFileUrl("vscode", "/a b/c/", "src/x.ts", 3), "vscode://file/a%20b/c/src/x.ts:3");
    assert.equal(editorFileUrl("vscode", "C:\\dev\\strudel", "src/x.ts", 1, 2), "vscode://file/C:/dev/strudel/src/x.ts:1:2");
  });
});
