// ═══════════════════════════════════════════════════════════════════════════
// The browser editor's path into the engine, without the engine: editor-source.ts
// wraps this with player.ts's evalSource. Pure, so Node tests load it.
// ═══════════════════════════════════════════════════════════════════════════

import type { EvalIntent, EvalResult, EvalSource } from "./editor-types.ts";

export interface EditorSourceCall {
  songId: string;
  text: string;
  intent: EvalIntent;
  origin: "browser";
  at: number;
}

export interface EditorSource {
  /**
   * Evaluate the browser editor's text. null = no engine path yet: the call is only recorded. Never rejects.
   * An aborted `signal` tells the engine not to apply it (the caller gave it up).
   */
  evalEdit(songId: string, text: string, intent: EvalIntent, signal?: AbortSignal): Promise<EvalResult | null>;
  hasEngine(): boolean;
  /** Recent calls, newest last (bounded) */
  calls(): readonly EditorSourceCall[];
}

export interface EditorSourceOptions {
  /** Looked up on every call (the engine may appear later) */
  getEngine: () => EvalSource | undefined;
  now?: () => number;
  /** Where the one-time "no engine yet" note goes (default console.info) */
  log?: (msg: string) => void;
  /** How many calls calls() keeps (default 50) */
  limit?: number;
}

export function createEditorSource(opts: EditorSourceOptions): EditorSource {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((msg: string) => console.info(msg));
  const limit = opts.limit ?? 50;
  const calls: EditorSourceCall[] = [];
  let noted = false;

  const engine = () => {
    const fn = opts.getEngine();
    return typeof fn === "function" ? fn : undefined;
  };

  return {
    hasEngine: () => engine() !== undefined,
    calls: () => calls.slice(),
    async evalEdit(songId, text, intent, signal) {
      calls.push({ songId, text, intent, origin: "browser", at: now() });
      if (calls.length > limit) calls.splice(0, calls.length - limit);
      const fn = engine();
      if (!fn) {
        if (!noted) {
          noted = true;
          log("[strudel] Browser edits aren't evaluated yet: the engine doesn't export evalSource.");
        }
        return null;
      }
      try {
        return await fn(songId, text, signal ? { intent, origin: "browser", signal } : { intent, origin: "browser" });
      } catch (err) {
        return { ok: false, error: { message: err instanceof Error ? err.message : String(err) } };
      }
    },
  };
}
