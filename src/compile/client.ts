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
//   planAddTrack(text, file, track) → AddTrackPlan (./add-track.ts, the track builder)
//   trackNames(text, file)          → TrackNames  (./add-track.ts)
// ═══════════════════════════════════════════════════════════════════════════

import type { Song } from "../songs/index.ts";
import type { CompileError, CompileResult } from "./compile.ts";
import { evaluateSong, SongEvaluationError } from "./evaluate.ts";
import type { AddTrackPlan, NewTrack, TrackNames } from "./add-track.ts";
import type { AddTrackRequest, CompileRequest, TrackNamesRequest, WorkerResponse } from "./worker.ts";

export type { AddTrackPlan, CompileError, CompileResult, NewTrack, TrackNames };

let worker: Worker | null = null;
let nextId = 1;
/** Requests in flight: how to resolve each, and how to fail it in its own shape */
const pending = new Map<number, { resolve(result: unknown): void; fail(message: string): void }>();

/** Fail every request in flight and drop the worker (the next compile starts a new one) */
function failAll(message: string) {
  const waiting = [...pending.values()];
  pending.clear();
  worker?.terminate();
  worker = null;
  for (const p of waiting) p.fail(message);
}

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "song-compiler" });
  w.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
    const p = pending.get(data.id);
    pending.delete(data.id);
    p?.resolve(data.result);
  };
  w.onerror = (event) => {
    event.preventDefault();
    failAll(`The song compiler stopped: ${event.message || "the worker failed to load"}`);
  };
  w.onmessageerror = () => failAll("The song compiler sent an unreadable message");
  return (worker = w);
}

/** Post `message(id)` to the worker; `failed(message)` is the result when it can't answer. Never rejects. */
function request<T>(message: (id: number) => object, failed: (message: string) => T): Promise<T> {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, { resolve: resolve as (result: unknown) => void, fail: (m) => resolve(failed(m)) });
    try {
      getWorker().postMessage(message(id));
    } catch (err) {
      pending.delete(id);
      resolve(failed(`The song compiler could not start: ${err instanceof Error ? err.message : String(err)}`));
    }
  });
}

/** Compile a song's text in the shared compiler worker. Never rejects. */
export function compileInWorker(text: string, file: string): Promise<CompileResult> {
  return request<CompileResult>(
    (id) => ({ id, text, file }) satisfies CompileRequest,
    (message) => ({ ok: false, error: { message } })
  );
}

/** The track builder: plan adding `track` to the song's text, in the worker. Never rejects. */
export function planAddTrack(text: string, file: string, track: NewTrack): Promise<AddTrackPlan> {
  return request<AddTrackPlan>(
    (id) => ({ id, op: "addTrack", text, file, track }) satisfies AddTrackRequest,
    (message) => ({ ok: false, reason: message })
  );
}

/** The track builder: the song's tracks and the names a new one can't take. Never rejects. */
export function trackNames(text: string, file: string): Promise<TrackNames> {
  return request<TrackNames>(
    (id) => ({ id, op: "trackNames", text, file }) satisfies TrackNamesRequest,
    (message) => ({ ok: false, reason: message, taken: [] })
  );
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
