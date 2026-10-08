// ═══════════════════════════════════════════════════════════════════════════
// The song compiler's Web Worker (module worker, created by ./client.ts)
// ═══════════════════════════════════════════════════════════════════════════
//
//   in:  { id, text, file }                        out: { id, result: CompileResult }
//   in:  { id, op: "addTrack", text, file, track }  out: { id, result: AddTrackPlan }
//   in:  { id, op: "trackNames", text, file }       out: { id, result: TrackNames }
//
// The track builder's requests (./add-track.ts) carry an `op`; compile requests
// don't. On the first message of either kind it loads TypeScript and @strudel/core|mini|tonal (only
// to introspect which calls take mini-notation, like the Vite plugin does;
// nothing is evaluated here) and keeps them for the next compiles.
// ═══════════════════════════════════════════════════════════════════════════

import type TS from "typescript";
import { planAddTrack, trackNames, type AddTrackPlan, type NewTrack, type TrackNames } from "./add-track.ts";
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

/** The track builder: plan adding a track to the song's text */
export interface AddTrackRequest {
  id: number;
  op: "addTrack";
  text: string;
  file: string;
  track: NewTrack;
}

/** The track builder: the song's tracks and the names a new one can't take */
export interface TrackNamesRequest {
  id: number;
  op: "trackNames";
  text: string;
  file: string;
}

export type WorkerRequest = CompileRequest | AddTrackRequest | TrackNamesRequest;

export interface WorkerResponse {
  id: number;
  result: CompileResult | AddTrackPlan | TrackNames;
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
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse): void;
};

async function trackOp(data: AddTrackRequest | TrackNamesRequest): Promise<AddTrackPlan | TrackNames> {
  let ts: typeof TS;
  try {
    ({ ts } = await (ready ??= load()));
  } catch (err) {
    ready = undefined; // a failed load is retried on the next request
    const reason = `the song compiler failed to load: ${err instanceof Error ? err.message : String(err)}`;
    return data.op === "addTrack" ? { ok: false, reason } : { ok: false, reason, taken: [] };
  }
  if (data.op === "addTrack") return planAddTrack(ts, data.text, data.track, data.file); // never throws
  try {
    return trackNames(ts, data.text, data.file);
  } catch (err) {
    return { ok: false, reason: `couldn't read the song: ${err instanceof Error ? err.message : String(err)}`, taken: [] };
  }
}

scope.onmessage = async ({ data }) => {
  if ("op" in data) {
    scope.postMessage({ id: data.id, result: await trackOp(data) });
    return;
  }
  const { id, text, file } = data;
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
