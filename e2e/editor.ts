// A Node WebSocket client in the VS Code extension's role: hello as an editor,
// record every message from the bridge, send commands, wait for messages.

import WebSocket from "ws";
import type { CommandMsg, EvalResultMsg, StateMsg } from "../src/live/protocol.ts";
import { BRIDGE_PATH, contentVersion } from "../src/live/protocol.ts";

export type Msg = { type: string } & Record<string, unknown>;

export class EditorClient {
  readonly messages: Msg[] = [];
  private waiters = new Set<() => void>();

  private constructor(private ws: WebSocket) {
    ws.on("message", (data) => {
      this.messages.push(JSON.parse(data.toString()) as Msg);
      for (const wake of this.waiters) wake();
    });
  }

  /** Connect and say hello (as Cursor by default, like the extension does) */
  static async connect(baseURL: string, hello: { client?: string; scheme?: string } = {}): Promise<EditorClient> {
    const ws = new WebSocket(baseURL.replace(/^http/, "ws") + BRIDGE_PATH);
    const editor = new EditorClient(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.send(JSON.stringify({ type: "hello", role: "editor", client: "e2e", scheme: "cursor", ...hello }));
    return editor;
  }

  send(command: Omit<CommandMsg, "type">) {
    this.ws.send(JSON.stringify({ type: "command", ...command }));
  }

  /** Any message, as is */
  sendRaw(msg: object) {
    this.ws.send(JSON.stringify(msg));
  }

  /**
   * Live-evaluate `text` as the unsaved buffer of `file` (what the extension's
   * Ctrl+Enter does) and wait for the player's evalResult for it.
   */
  async eval(file: string, text: string, { play = false, timeout = 10_000 } = {}): Promise<EvalResultMsg> {
    const version = contentVersion(text);
    const from = this.messages.length;
    this.sendRaw({ type: "eval", file, text, version, ...(play ? { play } : {}) });
    return this.waitFor<EvalResultMsg & Msg>(
      (m) => m.type === "evalResult" && m.file === file && m.version === version,
      `evalResult for ${file}@${version}`,
      { from, timeout }
    );
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
  nextState(predicate: (s: StateMsg) => boolean, description: string, timeout = 10_000): Promise<StateMsg> {
    return this.waitFor<StateMsg & Msg>(
      (m) => m.type === "state" && predicate(m as unknown as StateMsg),
      `state: ${description}`,
      { from: this.messages.length, timeout }
    );
  }

  close() {
    this.ws.close();
  }
}
