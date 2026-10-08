// ═══════════════════════════════════════════════════════════════════════════
// strudel-bridge: WebSocket relay between the browser player and editors
// ═══════════════════════════════════════════════════════════════════════════
//
// Dev-only Vite plugin. Serves ws://<host:port>/__strudel on Vite's own HTTP
// server (only that path; Vite's HMR socket and other upgrades are left
// alone). Protocol: src/live/protocol.ts.
//
//   browser ──state/songs/highlight/onsets/reveal──▶ server ──▶ every editor
//           knobs/knobWrite/evalResult
//   editor  ──command──────────────────────────────▶ server ──▶ every browser
//   editor  ──eval {file, text}──▶ server: compiled as a Vite module
//           (strudel-live-eval.ts) ──live {url | error}──▶ every browser
//   server  ──player {connected}──▶ editors  (on join + whenever the set of
//                                             browsers goes empty/non-empty)
//   server  ──server {root, editorScheme}──▶ browsers (on join + when the
//                                             scheme changes)
//   server  ──editors {count, clients}─────▶ browsers (on join + whenever an
//                                             editor comes or goes)
//
// editorScheme is the URI scheme the browser falls back to for opening files
// (`cursor://file/…`) when no editor is attached. First match wins:
//   1. the plugin's `editorScheme` option or the STRUDEL_EDITOR env variable
//   2. the scheme of the editor that attached most recently
//   3. Cursor, when detectable (launched from Cursor's terminal, or installed)
//   4. "vscode"
//
// The latest `state`/`songs`/`knobs` per browser are cached and replayed to
// editors that connect later. The dev server URL is written to DISCOVERY_FILE so the
// VS Code extension can find it when the port isn't 3000.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import type { Duplex } from "node:stream";
import type { Plugin, ViteDevServer } from "vite";
import { WebSocketServer, type WebSocket } from "ws";
import {
  BRIDGE_PATH,
  DISCOVERY_FILE,
  SERVER_ONLY_TYPES,
  contentVersion,
  isEval,
  isHello,
  parseMessage,
  type DiscoveryInfo,
  type EditorsMsg,
  type EvalMsg,
  type EvalResultMsg,
  type LiveMsg,
  type PlayerError,
  type PlayerMsg,
  type Role,
  type ServerInfoMsg,
} from "../src/live/protocol.ts";
import { EvalError, createLiveEval, type LiveEval } from "./strudel-live-eval.ts";

export interface StrudelBridgeOptions {
  /** Write the discovery file (default true). */
  discovery?: boolean;
  /** Log connects/disconnects (default true). */
  log?: boolean;
  /**
   * URI scheme for the browser's `<scheme>://file/…` fallback links, e.g.
   * "cursor" or "vscode". Default: STRUDEL_EDITOR, else auto (see above).
   */
  editorScheme?: string;
}

/**
 * Handles an editor's `eval` (the relay never forwards it raw). `reply` sends
 * to that editor; `relay.toBrowsers` reaches the players.
 */
export type EvalHandler = (msg: EvalMsg, reply: (msg: object) => void) => void;

export interface RelayInfo {
  /** Live eval (strudel-live-eval.ts); without it `eval` is answered with an error */
  onEval?: EvalHandler;
  /** Absolute project root sent to browsers (default: process.cwd()) */
  root?: string;
  /** Configured scheme: beats the attached editors' schemes */
  editorScheme?: string;
  /** Detected scheme: used when no editor has attached yet (default "vscode") */
  detectedScheme?: string;
}

const SCHEME_RE = /^[a-z][a-z0-9+.-]{0,31}$/;

/**
 * Best guess at the user's editor: Cursor when the dev server was started from
 * Cursor's terminal or Cursor is installed, else VS Code.
 */
export function detectEditorScheme(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform,
): string {
  const launchedFrom = [env.__CFBundleIdentifier, env.VSCODE_GIT_ASKPASS_MAIN, env.VSCODE_IPC_HOOK_CLI, env.TERM_PROGRAM_VERSION]
    .filter(Boolean)
    .join(" ");
  if (env.CURSOR_TRACE_ID || /cursor|todesktop/i.test(launchedFrom)) return "cursor";
  if (/com\.microsoft\.VSCodeInsiders|insiders/i.test(launchedFrom)) return "vscode-insiders";
  if (/com\.microsoft\.VSCode|visual studio code/i.test(launchedFrom)) return "vscode";
  const candidates =
    platform === "darwin"
      ? ["/Applications/Cursor.app", join(homedir(), "Applications", "Cursor.app")]
      : platform === "win32"
        ? [join(env.LOCALAPPDATA ?? "", "Programs", "cursor", "Cursor.exe")]
        : (env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, "cursor"));
  return candidates.some((p) => exists(p)) ? "cursor" : "vscode";
}

interface BrowserCache {
  state?: string;
  songs?: string;
  knobs?: string;
  /** monotonically increasing; the most recently active browser wins replay */
  touched: number;
}

export interface BridgeRelay {
  /** Attach to an HTTP server's `upgrade` event. Returns a detach function. */
  attach(httpServer: Server): () => void;
  /** Send a message to every browser */
  toBrowsers(msg: object): void;
  close(): void;
  /** For tests/diagnostics. */
  counts(): { browsers: number; editors: number; pending: number };
}

const MAX_PAYLOAD = 1024 * 1024;
const HELLO_TIMEOUT_MS = 5000;

/** Reject cross-site pages; editors (Node clients) send no Origin at all. */
function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname;
    const reqHost = (req.headers.host ?? "").replace(/:\d+$/, "");
    return ["localhost", "127.0.0.1", "[::1]", "::1", reqHost].includes(host);
  } catch {
    return false;
  }
}

export function createBridgeRelay(log: (msg: string) => void = () => {}, info: RelayInfo = {}): BridgeRelay {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  const roles = new Map<WebSocket, Role>();
  const caches = new Map<WebSocket, BrowserCache>();
  /** editors' hello client names */
  const clients = new Map<WebSocket, string>();
  let touch = 0;
  let lastEditorScheme: string | undefined;
  const root = info.root ?? process.cwd();

  const browsers = () => [...roles].filter(([, r]) => r === "browser").map(([ws]) => ws);
  const editors = () => [...roles].filter(([, r]) => r === "editor").map(([ws]) => ws);

  const send = (ws: WebSocket, data: string) => {
    if (ws.readyState === ws.OPEN) ws.send(data);
  };
  const playerMsg = () =>
    JSON.stringify({ type: "player", connected: browsers().length > 0 } satisfies PlayerMsg);
  const editorScheme = () => info.editorScheme ?? lastEditorScheme ?? info.detectedScheme ?? "vscode";
  const serverMsg = () => JSON.stringify({ type: "server", root, editorScheme: editorScheme() } satisfies ServerInfoMsg);
  const editorsMsg = () => {
    const list = editors();
    return JSON.stringify({
      type: "editors",
      count: list.length,
      clients: list.map((ws) => clients.get(ws) ?? "editor"),
    } satisfies EditorsMsg);
  };
  const toBrowsers = (data: string) => {
    for (const b of browsers()) send(b, data);
  };

  function latestCache(): BrowserCache | undefined {
    let best: BrowserCache | undefined;
    for (const ws of browsers()) {
      const c = caches.get(ws);
      if (c && (!best || c.touched > best.touched)) best = c;
    }
    return best;
  }

  function onHello(ws: WebSocket, role: Role, client?: string, scheme?: string) {
    const hadBrowsers = browsers().length > 0;
    roles.set(ws, role);
    log(`${role} connected${client ? ` (${client})` : ""}`);
    if (role === "browser") {
      caches.set(ws, { touched: ++touch });
      if (!hadBrowsers) for (const e of editors()) send(e, playerMsg());
      send(ws, serverMsg());
      send(ws, editorsMsg());
    } else {
      clients.set(ws, typeof client === "string" ? client.slice(0, 64) : "editor");
      send(ws, playerMsg());
      const cache = latestCache();
      if (cache?.songs) send(ws, cache.songs);
      if (cache?.state) send(ws, cache.state);
      if (cache?.knobs) send(ws, cache.knobs);
      const before = editorScheme();
      if (typeof scheme === "string" && SCHEME_RE.test(scheme)) lastEditorScheme = scheme;
      if (editorScheme() !== before) toBrowsers(serverMsg());
      toBrowsers(editorsMsg());
    }
  }

  function onMessage(ws: WebSocket, raw: string) {
    const role = roles.get(ws);
    const msg = parseMessage(raw);
    if (!msg) return;
    if (!role) {
      if (isHello(msg)) onHello(ws, msg.role, msg.client, msg.scheme);
      return; // anything before hello is dropped
    }
    if (msg.type === "hello" || SERVER_ONLY_TYPES.includes(msg.type)) return;

    if (role === "browser") {
      if (msg.type === "eval") return;
      const cache = caches.get(ws);
      if (cache && (msg.type === "state" || msg.type === "songs" || msg.type === "knobs")) {
        cache[msg.type] = raw;
        cache.touched = ++touch;
      }
      for (const e of editors()) send(e, raw);
    } else if (msg.type === "eval") {
      const reply = (m: object) => send(ws, JSON.stringify(m));
      if (!isEval(msg)) return;
      if (info.onEval) info.onEval(msg, reply);
      else reply(evalFailed(msg, "Live eval needs the Vite dev server"));
    } else {
      toBrowsers(raw);
    }
  }

  function onClose(ws: WebSocket) {
    const role = roles.get(ws);
    roles.delete(ws);
    caches.delete(ws);
    clients.delete(ws);
    if (!role) return;
    log(`${role} disconnected`);
    if (role === "browser" && browsers().length === 0) {
      for (const e of editors()) send(e, playerMsg());
    }
    if (role === "editor") toBrowsers(editorsMsg());
  }

  wss.on("connection", (ws: WebSocket) => {
    const helloTimer = setTimeout(() => {
      if (!roles.has(ws)) ws.close(1008, "hello expected");
    }, HELLO_TIMEOUT_MS);
    ws.on("message", (data, isBinary) => {
      if (!isBinary) onMessage(ws, data.toString());
    });
    ws.on("close", () => {
      clearTimeout(helloTimer);
      onClose(ws);
    });
    ws.on("error", () => {});
  });

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      return;
    }
    if (pathname !== BRIDGE_PATH) return; // not ours: leave it for Vite HMR / proxies
    if (!originAllowed(req)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  };

  return {
    attach(httpServer) {
      httpServer.on("upgrade", onUpgrade);
      return () => httpServer.off("upgrade", onUpgrade);
    },
    toBrowsers(msg) {
      toBrowsers(JSON.stringify(msg));
    },
    close() {
      for (const ws of wss.clients) ws.terminate();
      roles.clear();
      caches.clear();
      wss.close();
    },
    counts() {
      const b = browsers().length;
      const e = editors().length;
      return { browsers: b, editors: e, pending: wss.clients.size - b - e };
    },
  };
}

function evalFailed(msg: Pick<EvalMsg, "file" | "text">, error: string | PlayerError): EvalResultMsg {
  return {
    type: "evalResult",
    file: String(msg.file),
    version: typeof msg.text === "string" ? contentVersion(msg.text) : "",
    ok: false,
    error: typeof error === "string" ? { message: error } : error,
  };
}

/**
 * The relay's `eval` handler: compile the buffer (strudel-live-eval.ts), then
 * send the browsers its URL, or its compile error. Evals are compiled one at a
 * time, in order; an eval superseded by a newer one for the same file while it
 * compiled is dropped.
 */
export function liveEvalHandler(live: LiveEval, relay: () => BridgeRelay | null): EvalHandler {
  let queue: Promise<unknown> = Promise.resolve();
  const latest = new Map<string, number>();
  let seq = 0;
  return (msg, reply) => {
    const id = ++seq;
    latest.set(msg.file, id);
    queue = queue.then(async () => {
      const r = relay();
      if (!r || r.counts().browsers === 0) return reply(evalFailed(msg, "No player connected: open the Strudel player in the browser"));
      const version = contentVersion(msg.text);
      let out: LiveMsg;
      try {
        const compiled = await live.compile(msg.file, msg.text);
        out = { type: "live", file: compiled.file, version, text: msg.text, url: compiled.url };
      } catch (err) {
        const error: PlayerError = err instanceof EvalError ? err.error : { message: String(err) };
        // not a song / too large / not on disk: only the editor hears about it
        if (!(err instanceof EvalError) || !error.file || error.line === undefined) return reply(evalFailed(msg, error));
        out = { type: "live", file: error.file, version, text: msg.text, error };
      }
      if (latest.get(msg.file) !== id) return; // a newer buffer is on its way
      if (msg.play) out.play = true;
      r.toBrowsers(out);
    });
  };
}

function discoveryInfo(server: ViteDevServer, address: AddressInfo): DiscoveryInfo {
  const https = !!server.config.server.https;
  const loopback = ["::", "0.0.0.0", "::1", "127.0.0.1", "localhost"];
  const host = loopback.includes(address.address)
    ? "localhost"
    : address.family === "IPv6"
      ? `[${address.address}]`
      : address.address;
  const base = (server.config.base || "/").replace(/\/$/, "");
  const url = `${https ? "https" : "http"}://${host}:${address.port}${base}`;
  return {
    url,
    port: address.port,
    bridgeUrl: `${https ? "wss" : "ws"}://${host}:${address.port}${BRIDGE_PATH}`,
    root: server.config.root,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
}

/** What the plugin exposes to other plugins (`plugin.api`), e.g. strudel-knobs */
export interface StrudelBridgeApi {
  /** Live eval of this dev server (null before configureServer / without an HTTP server) */
  live: LiveEval | null;
}

export default function strudelBridge(options: StrudelBridgeOptions = {}): Plugin {
  const { discovery = true, log: shouldLog = true } = options;
  const configuredScheme = [options.editorScheme, process.env.STRUDEL_EDITOR]
    .map((s) => s?.trim().toLowerCase())
    .find((s) => !!s && SCHEME_RE.test(s));
  const api: StrudelBridgeApi = { live: null };
  return {
    name: "strudel-bridge",
    apply: "serve",
    // live eval: the buffer is the source of `…/src/songs/x.ts?live=<version>`
    enforce: "pre",
    api,
    load(id) {
      return api.live?.load(id) ?? null;
    },
    handleHotUpdate(ctx) {
      return api.live?.hotUpdate(ctx.file, ctx.modules);
    },
    configureServer(server) {
      const httpServer = server.httpServer as Server | null;
      if (!httpServer) return; // middleware mode: no server to attach to
      const log = (msg: string) => {
        if (shouldLog) server.config.logger.info(`[strudel-bridge] ${msg}`, { timestamp: true });
      };
      const live = (api.live = createLiveEval(server));
      let relayRef: BridgeRelay | null = null;
      const relay = createBridgeRelay(log, {
        root: server.config.root,
        editorScheme: configuredScheme,
        detectedScheme: configuredScheme ? undefined : detectEditorScheme(),
        onEval: liveEvalHandler(live, () => relayRef),
      });
      relayRef = relay;
      const detach = relay.attach(httpServer);
      const discoveryPath = resolve(server.config.root, DISCOVERY_FILE);
      let wrotePort: number | null = null;

      // Only remove the file if it still describes this server (another dev
      // server for the same root may have overwritten it since).
      const removeDiscovery = () => {
        if (wrotePort === null) return;
        try {
          const info = JSON.parse(readFileSync(discoveryPath, "utf8")) as Partial<DiscoveryInfo>;
          if (info.port === wrotePort && info.pid === process.pid) rmSync(discoveryPath, { force: true });
        } catch {
          // already gone or unreadable
        }
        wrotePort = null;
      };

      const onListening = () => {
        const address = httpServer.address();
        if (!discovery || !address || typeof address === "string") return;
        try {
          mkdirSync(dirname(discoveryPath), { recursive: true });
          writeFileSync(discoveryPath, JSON.stringify(discoveryInfo(server, address), null, 2));
          wrotePort = address.port;
        } catch (e) {
          server.config.logger.warn(`[strudel-bridge] could not write ${discoveryPath}: ${e}`);
        }
      };
      if (httpServer.listening) onListening();
      else httpServer.once("listening", onListening);

      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        detach();
        relay.close();
        removeDiscovery();
        process.off("exit", removeDiscovery);
      };
      process.once("exit", removeDiscovery);
      httpServer.once("close", cleanup);
      // httpServer.close() waits for open sockets; clean up as soon as Vite closes.
      const viteClose = server.close.bind(server);
      server.close = async () => {
        cleanup();
        return viteClose();
      };
    },
  };
}
