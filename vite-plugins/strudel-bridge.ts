// ═══════════════════════════════════════════════════════════════════════════
// strudel-bridge: WebSocket relay between the browser player and editors
// ═══════════════════════════════════════════════════════════════════════════
//
// Dev-only Vite plugin. Serves ws://<host:port>/__strudel on Vite's own HTTP
// server (only that path; Vite's HMR socket and other upgrades are left
// alone). Protocol: src/live/protocol.ts.
//
//   browser ──state/songs/highlight──▶ server ──▶ every editor
//   editor  ──command───────────────▶ server ──▶ every browser
//   server  ──player {connected}────▶ editors (on join + whenever the set of
//                                      browsers goes empty/non-empty)
//
// The latest `state`/`songs` per browser are cached and replayed to editors
// that connect later. The dev server URL is written to DISCOVERY_FILE so the
// VS Code extension can find it when the port isn't 3000.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import type { Duplex } from "node:stream";
import type { Plugin, ViteDevServer } from "vite";
import { WebSocketServer, type WebSocket } from "ws";
import {
  BRIDGE_PATH,
  DISCOVERY_FILE,
  isHello,
  parseMessage,
  type DiscoveryInfo,
  type PlayerMsg,
  type Role,
} from "../src/live/protocol.ts";

export interface StrudelBridgeOptions {
  /** Write the discovery file (default true). */
  discovery?: boolean;
  /** Log connects/disconnects (default true). */
  log?: boolean;
}

interface BrowserCache {
  state?: string;
  songs?: string;
  /** monotonically increasing; the most recently active browser wins replay */
  touched: number;
}

export interface BridgeRelay {
  /** Attach to an HTTP server's `upgrade` event. Returns a detach function. */
  attach(httpServer: Server): () => void;
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

export function createBridgeRelay(log: (msg: string) => void = () => {}): BridgeRelay {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  const roles = new Map<WebSocket, Role>();
  const caches = new Map<WebSocket, BrowserCache>();
  let touch = 0;

  const browsers = () => [...roles].filter(([, r]) => r === "browser").map(([ws]) => ws);
  const editors = () => [...roles].filter(([, r]) => r === "editor").map(([ws]) => ws);

  const send = (ws: WebSocket, data: string) => {
    if (ws.readyState === ws.OPEN) ws.send(data);
  };
  const playerMsg = () =>
    JSON.stringify({ type: "player", connected: browsers().length > 0 } satisfies PlayerMsg);

  function latestCache(): BrowserCache | undefined {
    let best: BrowserCache | undefined;
    for (const ws of browsers()) {
      const c = caches.get(ws);
      if (c && (!best || c.touched > best.touched)) best = c;
    }
    return best;
  }

  function onHello(ws: WebSocket, role: Role, client?: string) {
    const hadBrowsers = browsers().length > 0;
    roles.set(ws, role);
    log(`${role} connected${client ? ` (${client})` : ""}`);
    if (role === "browser") {
      caches.set(ws, { touched: ++touch });
      if (!hadBrowsers) for (const e of editors()) send(e, playerMsg());
    } else {
      send(ws, playerMsg());
      const cache = latestCache();
      if (cache?.songs) send(ws, cache.songs);
      if (cache?.state) send(ws, cache.state);
    }
  }

  function onMessage(ws: WebSocket, raw: string) {
    const role = roles.get(ws);
    const msg = parseMessage(raw);
    if (!msg) return;
    if (!role) {
      if (isHello(msg)) onHello(ws, msg.role, msg.client);
      return; // anything before hello is dropped
    }
    if (msg.type === "hello" || msg.type === "player") return;

    if (role === "browser") {
      const cache = caches.get(ws);
      if (cache && (msg.type === "state" || msg.type === "songs")) {
        cache[msg.type] = raw;
        cache.touched = ++touch;
      }
      for (const e of editors()) send(e, raw);
    } else {
      for (const b of browsers()) send(b, raw);
    }
  }

  function onClose(ws: WebSocket) {
    const role = roles.get(ws);
    roles.delete(ws);
    caches.delete(ws);
    if (!role) return;
    log(`${role} disconnected`);
    if (role === "browser" && browsers().length === 0) {
      for (const e of editors()) send(e, playerMsg());
    }
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

export default function strudelBridge(options: StrudelBridgeOptions = {}): Plugin {
  const { discovery = true, log: shouldLog = true } = options;
  return {
    name: "strudel-bridge",
    apply: "serve",
    configureServer(server) {
      const httpServer = server.httpServer as Server | null;
      if (!httpServer) return; // middleware mode: no server to attach to
      const log = (msg: string) => {
        if (shouldLog) server.config.logger.info(`[strudel-bridge] ${msg}`, { timestamp: true });
      };
      const relay = createBridgeRelay(log);
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
