// ═══════════════════════════════════════════════════════════════════════════
// Which code a preview may run (pure; ./audition.ts re-exports it)
// ═══════════════════════════════════════════════════════════════════════════
//
// Its own module so Node tests can check examples without loading the engine
// (test/discover-cheatsheet.test.ts).

/** Calls a preview must never make: they reach past the pattern into the running engine or the page */
const UNSAFE =
  /\b(setcps|setcpm|setCps|setCpm|hush|samples|soundAlias|aliasBank|register|evalScope|initAudio|initStrudel|loadOrc|loadCsound|fetch|import|await|document|window|globalThis|eval|Function|localStorage)\b|\.(osc|midi|midin|serial|csound|mqtt|dough|scope|tscope|fscope|pianoroll|punchcard|spiral|pitchwheel|spectrum|wordfall|markcss|draw|animate|onPaint|onFrame|onTrigger|log|logValues)\s*\(|\$:|_\w+\s*\(/;

/** Whether previewCode() will try `code` (the library greys out ▶ otherwise) */
export function previewable(code: string): boolean {
  return code.trim().length > 0 && !UNSAFE.test(code);
}
