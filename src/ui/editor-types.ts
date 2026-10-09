// ═══════════════════════════════════════════════════════════════════════════
// The engine contract the browser editor builds against (the compile stream
// implements it as `evalSource` in src/engine/player.ts).
// ═══════════════════════════════════════════════════════════════════════════

export type EvalIntent = "typing" | "commit";
export type EvalOrigin = "browser" | "editor";

export interface EvalError {
  message: string;
  /** 1-based, into the evaluated text */
  line?: number;
  column?: number;
  /** A newer eval (or a revert) of the same song came first: nothing changed, show nothing */
  superseded?: true;
}

export type EvalResult = { ok: true; version: string } | { ok: false; error: EvalError };

/**
 * Compile `text` as song `songId` and hot-swap it on success. With
 * `intent: "typing"` it never sets the player's error panel (the caller shows
 * the returned error inline). An aborted `signal` cancels this one call: if it
 * aborts before the compile finishes, nothing is applied (a superseded result).
 */
export type EvalSource = (
  songId: string,
  text: string,
  opts: { intent: EvalIntent; origin: EvalOrigin; signal?: AbortSignal }
) => Promise<EvalResult>;
