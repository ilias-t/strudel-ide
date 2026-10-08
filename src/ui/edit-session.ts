// ═══════════════════════════════════════════════════════════════════════════
// The browser editor's session for one song: who owns the buffer, the
// debounced typing evals, commit, and what to do with external changes.
// ═══════════════════════════════════════════════════════════════════════════
//
// Pure: no DOM, no Monaco, no engine. The UI feeds it events (edit, commit,
// incoming player sources, the take-over / load keys) and renders the
// SessionView it hands to onChange.
//
// Ownership:
//   mirror   the buffer follows player.currentSource() (the file on disk)
//   ide      the IDE is evaluating its unsaved buffer: shown read-only until
//            the user takes it over
//   browser  the user typed here: external changes never overwrite the buffer
//            silently; they become a `conflict` the user can load. Ends when
//            the file is saved with exactly the buffer's text.
//
// Every eval gets a sequence number and only the newest issued one is applied,
// so a slow typing result can't overwrite a later commit's.

import type { EvalError, EvalIntent, EvalResult } from "./editor-types.ts";
import { contentVersion } from "../live/protocol.ts";

export type Owner = "mirror" | "browser" | "ide";

/** What player.currentSource() says (file and version are what we need) */
export interface IncomingSource {
  text: string;
  /** contentVersion(text); computed when absent */
  version?: string;
  /** An evaluated, unsaved buffer (live eval) rather than the file on disk */
  live?: boolean;
}

export interface SessionStatus {
  kind: "idle" | "pending" | "evaluating" | "ok" | "error" | "offline" | "readonly" | "conflict";
  /** Short, for the code unit's file bar */
  text: string;
  /** The key the status offers: takeOver() for "readonly", loadIncoming() for "conflict" */
  action?: "takeOver" | "load";
}

export interface SessionView {
  /** The buffer to display */
  text: string;
  readOnly: boolean;
  owner: Owner;
  status: SessionStatus;
  /** Inline marker for the last typing/commit error; line/column index into `markerText` */
  marker: EvalError | null;
  /** The evaluated text the marker refers to (may be older than `text`) */
  markerText: string | null;
  /** An external change we did not apply */
  conflict: IncomingSource | null;
}

export interface SessionTimers {
  set(fn: () => void, ms: number): unknown;
  clear(id: unknown): void;
}

export interface EditSessionOptions {
  initial: IncomingSource;
  /** Usually editor-source's evalEdit bound to the song. null: no engine */
  evaluate: (text: string, intent: EvalIntent) => Promise<EvalResult | null>;
  /** Quiet time after the last edit before a typing eval (default 400) */
  debounceMs?: number;
  timers?: SessionTimers;
  onChange: (view: SessionView) => void;
  /** "Cursor" / "VS Code" for status texts (default "your editor") */
  ideName?: () => string;
}

type ResultStatus = { kind: "idle" | "ok" | "error" | "offline"; text: string };

const IDLE: ResultStatus = { kind: "idle", text: "" };
/** How many evaluated versions are remembered to recognise their echoes */
const SENT_LIMIT = 32;
const STATUS_MAX = 80;

const defaultTimers: SessionTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

const versionOf = (src: IncomingSource) => src.version ?? contentVersion(src.text);

/** "line 12: Unexpected token", first line only, truncated */
export function errorStatusText(error: EvalError): string {
  const first = error.message.split("\n", 1)[0].trim();
  const text = error.line ? `line ${error.line}: ${first}` : first;
  return text.length > STATUS_MAX ? `${text.slice(0, STATUS_MAX - 1).trimEnd()}…` : text;
}

export class EditSession {
  private readonly opts: EditSessionOptions;
  private readonly debounceMs: number;
  private readonly timers: SessionTimers;

  private text: string;
  private owner: Owner;
  private conflict: IncomingSource | null = null;
  private last: { text: string; version: string | undefined; live: boolean };

  private marker: EvalError | null = null;
  private markerText: string | null = null;
  private result: ResultStatus = IDLE;

  private timer: unknown = null;
  /** Sequence number of the newest issued eval */
  private seq = 0;
  /** seq of the newest eval while its result is outstanding */
  private inFlight: number | null = null;
  private lastEvaluated: string | null = null;
  /** Versions this session evaluated, oldest first (their echoes are ignored) */
  private readonly sent: string[] = [];
  private disposed = false;

  constructor(opts: EditSessionOptions) {
    this.opts = opts;
    this.debounceMs = opts.debounceMs ?? 400;
    this.timers = opts.timers ?? defaultTimers;
    const { initial } = opts;
    this.text = initial.text;
    this.owner = initial.live ? "ide" : "mirror";
    this.last = { text: initial.text, version: initial.version, live: !!initial.live };
  }

  view(): SessionView {
    return {
      text: this.text,
      readOnly: this.owner === "ide",
      owner: this.owner,
      status: this.status(),
      marker: this.marker,
      markerText: this.markerText,
      conflict: this.conflict,
    };
  }

  /** The user typed: the buffer is now `text`. Ignored (false) while read-only or disposed. */
  edit(text: string): boolean {
    if (this.disposed || this.owner === "ide") return false;
    this.text = text;
    this.owner = "browser";
    this.cancelTimer();
    this.timer = this.timers.set(() => {
      this.timer = null;
      if (this.text === this.lastEvaluated) this.emit();
      else void this.run("typing");
    }, this.debounceMs);
    this.emit();
    return true;
  }

  /** ⌘/Ctrl+Enter: evaluate the buffer now (even unchanged), cancelling the pending typing eval */
  commit(): Promise<EvalResult | null> {
    if (this.disposed) return Promise.resolve(null);
    this.cancelTimer();
    return this.run("commit");
  }

  /**
   * player.currentSource() changed. Call it on every player state change:
   * an unchanged source returns at once without callbacks. Returns whether the
   * buffer text changed.
   */
  incoming(src: IncomingSource): boolean {
    if (this.disposed) return false;
    const live = !!src.live;
    const { last } = this;
    const sameContent =
      src.version !== undefined && last.version !== undefined ? src.version === last.version : src.text === last.text;
    if (live === last.live && sameContent) return false;
    this.last = { text: src.text, version: src.version, live };

    const version = versionOf(src);
    // text this session evaluated (by version, or by text should the version be computed differently)
    const echo = this.sent.includes(version) || (src.version !== undefined && this.sent.includes(contentVersion(src.text)));

    if (this.owner === "browser") {
      if (!live && src.text === this.text) {
        // saved with exactly our text: back to following the file, nothing lost
        this.owner = "mirror";
        this.conflict = null;
        this.resetEval();
        this.emit();
        return false;
      }
      if (echo) return false; // never touches a pending conflict either
      if (src.text === this.text) {
        // the IDE's buffer says what ours says: nothing to load
        if (this.conflict) {
          this.conflict = null;
          this.emit();
        }
        return false;
      }
      this.conflict = { ...src, version };
      this.emit();
      return false;
    }
    // a late echo of an evaluated buffer must not hand the mirror to the IDE
    if (echo && live) return false;
    return this.apply({ ...src, version });
  }

  /** The "take over" key: the browser owns the IDE's buffer (unchanged, editable) */
  takeOver(): void {
    if (this.disposed || this.owner !== "ide") return;
    this.owner = "browser";
    this.emit();
  }

  /** The "load" key on a conflict: replace the buffer with the external text */
  loadIncoming(): void {
    if (this.disposed || !this.conflict) return;
    const src = this.conflict;
    this.conflict = null;
    this.apply(src);
  }

  /**
   * The user's saved edit (the songs store's override, e.g. after a reload)
   * becomes the browser's buffer, editable, replacing whatever was shown.
   * `evaluated`: the player already plays this text, so nothing is evaluated;
   * otherwise it is evaluated as typing (after the debounce), so an edit that
   * doesn't build shows its error inline instead of being lost.
   */
  restore(text: string, { evaluated }: { evaluated: boolean }): void {
    if (this.disposed) return;
    this.text = text;
    this.owner = "browser";
    this.conflict = null;
    this.resetEval();
    if (evaluated) {
      this.remember(contentVersion(text));
    } else {
      this.lastEvaluated = null;
      this.timer = this.timers.set(() => {
        this.timer = null;
        void this.run("typing");
      }, this.debounceMs);
    }
    this.emit();
  }

  /** Cancel timers; late eval results are ignored and no callbacks fire */
  dispose(): void {
    this.disposed = true;
    this.cancelTimer();
  }

  // ───────────────────────────────────────────────────────────────────────────

  /** Show an external source in mirror/ide mode (rule 1) */
  private apply(src: IncomingSource): boolean {
    const changed = src.text !== this.text;
    this.text = src.text;
    this.owner = src.live ? "ide" : "mirror";
    this.conflict = null;
    this.resetEval();
    this.emit();
    return changed;
  }

  /** The buffer was replaced from outside: drop pending and in-flight evals and their marker */
  private resetEval() {
    this.cancelTimer();
    this.seq++;
    this.inFlight = null;
    this.result = IDLE;
    this.marker = null;
    this.markerText = null;
    this.lastEvaluated = this.text;
  }

  private async run(intent: EvalIntent): Promise<EvalResult | null> {
    const text = this.text;
    const seq = ++this.seq;
    this.inFlight = seq;
    this.lastEvaluated = text;
    this.remember(contentVersion(text));
    this.emit();
    let result: EvalResult | null;
    try {
      result = await this.opts.evaluate(text, intent);
    } catch (err) {
      result = { ok: false, error: { message: err instanceof Error ? err.message : String(err) } };
    }
    if (this.disposed || seq !== this.seq) return result; // superseded
    this.inFlight = null;
    if (result && !result.ok && result.error.superseded) {
      // the engine evaluated something newer for this song first: nothing changed
    } else if (result === null) {
      this.result = { kind: "offline", text: "not evaluated (engine pending)" };
    } else if (result.ok) {
      this.result = { kind: "ok", text: "live" };
      this.marker = null;
      this.markerText = null;
    } else {
      this.result = { kind: "error", text: errorStatusText(result.error) };
      this.marker = result.error;
      this.markerText = text;
    }
    this.emit();
    return result;
  }

  private status(): SessionStatus {
    const ide = this.opts.ideName?.() || "your editor";
    if (this.conflict) {
      return this.conflict.live
        ? { kind: "conflict", text: `${ide} has newer edits · load them`, action: "load" }
        : { kind: "conflict", text: `file saved in ${ide} · load it`, action: "load" };
    }
    if (this.owner === "ide") return { kind: "readonly", text: `${ide} is editing · take over`, action: "takeOver" };
    if (this.timer !== null) return { kind: "pending", text: "editing…" };
    if (this.inFlight !== null) return { kind: "evaluating", text: "evaluating…" };
    return { ...this.result };
  }

  private remember(version: string) {
    const i = this.sent.indexOf(version);
    if (i >= 0) this.sent.splice(i, 1);
    this.sent.push(version);
    if (this.sent.length > SENT_LIMIT) this.sent.shift();
  }

  private cancelTimer() {
    if (this.timer !== null) {
      this.timers.clear(this.timer);
      this.timer = null;
    }
  }

  private emit() {
    if (!this.disposed) this.opts.onChange(this.view());
  }
}
