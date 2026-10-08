// ═══════════════════════════════════════════════════════════════════════════
// The song compiler's Web Worker (module worker, created by ./client.ts)
// ═══════════════════════════════════════════════════════════════════════════
//
//   in:  { id, text, file }      out: { id, result: CompileResult }
//
// On the first message it loads TypeScript and @strudel/core|mini|tonal (only
// to introspect which calls take mini-notation, like the Vite plugin does;
// nothing is evaluated here) and keeps them for the next compiles.
// ═══════════════════════════════════════════════════════════════════════════

import type TS from "typescript";
import { compileSong, type CompileResult } from "./compile.ts";
import { strudelNamesFrom, type StrudelModules, type StrudelNames } from "./names.ts";

export interface CompileRequest {
  id: number;
  text: string;
  file: string;
}

export interface CompileResponse {
  id: number;
  result: CompileResult;
}

let ready: Promise<{ ts: typeof TS; names: StrudelNames }> | undefined;

async function load() {
  // @strudel/core logs a banner on import (same silencing as vite-plugins/strudel-locations.ts)
  const { log, warn } = console;
  console.log = console.warn = () => {};
  try {
    const [ts, core, mini, tonal] = await Promise.all([
      import("typescript"),
      import("@strudel/core"),
      import("@strudel/mini"),
      import("@strudel/tonal"),
    ]);
    return {
      ts: ((ts as { default?: typeof TS }).default ?? ts) as typeof TS,
      names: strudelNamesFrom({ core, mini, tonal } as unknown as StrudelModules),
    };
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<CompileRequest>) => void) | null;
  postMessage(message: CompileResponse): void;
};

scope.onmessage = async ({ data: { id, text, file } }) => {
  let result: CompileResult;
  try {
    const { ts, names } = await (ready ??= load());
    result = compileSong(ts, names, text, file);
  } catch (err) {
    ready = undefined; // a failed load is retried on the next request
    result = { ok: false, error: { message: `The song compiler failed to load: ${err instanceof Error ? err.message : String(err)}` } };
  }
  scope.postMessage({ id, result });
};
