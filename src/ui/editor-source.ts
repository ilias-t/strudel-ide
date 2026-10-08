// ═══════════════════════════════════════════════════════════════════════════
// The browser editor's path into the engine: player.evalSource with
// origin "browser". Loaded at boot, so it stays tiny and never imports Monaco.
// ═══════════════════════════════════════════════════════════════════════════
//
// evalSource is detected at call time rather than imported by name: until the
// engine exports it, reading it off the module namespace is just undefined and
// browser edits are recorded but not evaluated (evalEdit resolves null).

import * as player from "../engine/player";
import { createEditorSource, type EditorSourceCall } from "./editor-source-core.ts";
import type { EvalIntent, EvalResult, EvalSource } from "./editor-types";

export type { EditorSourceCall };

const api = player as typeof player & { evalSource?: EvalSource };
let testEngine: EvalSource | null = null;

const source = createEditorSource({
  getEngine: () => testEngine ?? api.evalSource,
});

/** Evaluate the browser editor's text. null = no engine path yet (no evalSource): the call is only recorded. */
export function evalEdit(songId: string, text: string, intent: EvalIntent): Promise<EvalResult | null> {
  return source.evalEdit(songId, text, intent);
}

export function hasEngine(): boolean {
  return source.hasEngine();
}

/** Recent calls, newest last (bounded to 50); read by e2e tests via a window hook */
export function editorSourceCalls(): readonly EditorSourceCall[] {
  return source.calls();
}

/** Tests: replace the engine (null restores the real one). */
export function setEngineForTests(fn: EvalSource | null): void {
  testEngine = fn;
}
