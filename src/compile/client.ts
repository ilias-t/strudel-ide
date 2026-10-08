// ═══════════════════════════════════════════════════════════════════════════
// The song compiler, main-thread side
// ═══════════════════════════════════════════════════════════════════════════
//
// The player lazy-loads this module (`await import("../compile/client")`); it
// must never be imported statically from the boot path. The TypeScript
// compiler lives in a Web Worker (./worker.ts, one per page, created on the
// first compile), so neither its download nor its work blocks the page.
//
//   compileInWorker(text, file)    → CompileResult (./compile.ts)
//   compileAndEvaluate(text, file) → the Song, or a located CompileError
// ═══════════════════════════════════════════════════════════════════════════

import type { Song } from "../songs/index.ts";
import type { CompileError, CompileResult } from "./compile.ts";
import { evaluateSong, SongEvaluationError } from "./evaluate.ts";
import type { CompileRequest, CompileResponse } from "./worker.ts";

export type { CompileError, CompileResult };

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, (result: CompileResult) => void>();

/** Fail every request in flight and drop the worker (the next compile starts a new one) */
function failAll(message: string) {
  const waiting = [...pending.values()];
  pending.clear();
  worker?.terminate();
  worker = null;
  for (const resolve of waiting) resolve({ ok: false, error: { message } });
}

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "song-compiler" });
  w.onmessage = ({ data }: MessageEvent<CompileResponse>) => {
    const resolve = pending.get(data.id);
    pending.delete(data.id);
    resolve?.(data.result);
  };
  w.onerror = (event) => {
    event.preventDefault();
    failAll(`The song compiler stopped: ${event.message || "the worker failed to load"}`);
  };
  w.onmessageerror = () => failAll("The song compiler sent an unreadable message");
  return (worker = w);
}

/** Compile a song's text in the shared compiler worker. Never rejects. */
export function compileInWorker(text: string, file: string): Promise<CompileResult> {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    try {
      getWorker().postMessage({ id, text, file } satisfies CompileRequest);
    } catch (err) {
      pending.delete(id);
      resolve({ ok: false, error: { message: `The song compiler could not start: ${err instanceof Error ? err.message : String(err)}` } });
    }
  });
}

/** Compile in the worker, then import the module. Never rejects. */
export async function compileAndEvaluate(
  text: string,
  file: string
): Promise<{ ok: true; song: Song; file: string; version: string } | { ok: false; error: CompileError }> {
  const result = await compileInWorker(text, file);
  if (!result.ok) return result;
  try {
    return { ok: true, ...(await evaluateSong(result)) };
  } catch (err) {
    if (err instanceof SongEvaluationError) {
      return { ok: false, error: { message: err.message, line: err.line, column: err.column } };
    }
    return { ok: false, error: { message: err instanceof Error ? err.message : String(err) } };
  }
}
