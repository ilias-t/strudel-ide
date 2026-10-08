// Editor-side WebSocket connection to the bridge (no vscode): hello as
// `editor`, auto-reconnect with backoff, endpoint re-resolved on every attempt
// (so a dev server restarted on another port is picked up).

import WebSocket from "ws";
import { parseMessage, type BridgeMessage, type CommandMsg, type EvalMsg, type HelloMsg } from "../../src/live/protocol.ts";
import type { BridgeStatus } from "./model.ts";

export interface ConnectionOptions {
  /** Called before each attempt. */
  url: () => string;
  onMessage: (msg: BridgeMessage) => void;
  onStatus: (status: BridgeStatus) => void;
  minDelay?: number;
  maxDelay?: number;
  client?: string;
  /** The editor's URI scheme (vscode.env.uriScheme), sent in hello */
  scheme?: string;
}

export class BridgeConnection {
  private ws: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private delay: number;
  private disposed = false;
  private readonly minDelay: number;
  private readonly maxDelay: number;
  private readonly opts: ConnectionOptions;

  constructor(opts: ConnectionOptions) {
    this.opts = opts;
    this.minDelay = opts.minDelay ?? 500;
    this.maxDelay = opts.maxDelay ?? 5000;
    this.delay = this.minDelay;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  start(): void {
    this.opts.onStatus("connecting");
    this.open();
  }

  send(msg: CommandMsg | EvalMsg): boolean {
    if (!this.connected) return false;
    this.ws!.send(JSON.stringify(msg));
    return true;
  }

  /** Drop the current socket and connect again right away (e.g. settings changed). */
  reconnect(): void {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.delay = this.minDelay;
    const old = this.ws;
    this.ws = null;
    old?.terminate();
    this.opts.onStatus("connecting");
    this.open();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const old = this.ws;
    this.ws = null;
    old?.terminate();
  }

  private open() {
    if (this.disposed) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.url(), { handshakeTimeout: 3000 });
    } catch {
      this.opts.onStatus("offline");
      this.schedule();
      return;
    }
    this.ws = ws;
    ws.on("open", () => {
      if (this.ws !== ws) return;
      this.delay = this.minDelay;
      const hello: HelloMsg = { type: "hello", role: "editor", client: this.opts.client ?? "vscode" };
      if (this.opts.scheme) hello.scheme = this.opts.scheme;
      ws.send(JSON.stringify(hello));
      this.opts.onStatus("connected");
    });
    ws.on("message", (data, isBinary) => {
      if (this.ws !== ws || isBinary) return;
      const msg = parseMessage(data.toString());
      if (msg) this.opts.onMessage(msg);
    });
    ws.on("close", () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.opts.onStatus("offline");
      this.schedule();
    });
    ws.on("error", () => {
      // "close" follows
    });
  }

  private schedule() {
    if (this.disposed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.open();
    }, this.delay);
    this.delay = Math.min(this.maxDelay, Math.round(this.delay * 1.6));
  }
}
