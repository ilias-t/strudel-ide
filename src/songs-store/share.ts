// Share links: a song travels in the URL hash, so it never reaches a server.
//
//   #song=<base64url(deflate-raw(UTF-8 JSON { v: 1, id, text }))>
//
// Decoding is tolerant (anything malformed → null) and bounded: the inflated
// JSON is capped at MAX_SHARE_BYTES while streaming, so a decompression bomb
// stops after a megabyte or so instead of hanging the tab. Encoding refuses
// what decoding would refuse, so every link we make opens again.
// Explicit .ts imports: Node type stripping loads this file in tests.

import { MAX_EVAL_CHARS } from "../live/protocol.ts";
import { songIdProblem } from "../compile/song-id.ts";

export const SHARE_PARAM = "song";
export const SHARE_VERSION = 1;

/**
 * Most bytes the inflated JSON may have: MAX_EVAL_CHARS UTF-16 units are at
 * most 3 UTF-8 bytes each (JSON escapes of `"`, `\` and newlines stay within
 * that), plus room for the envelope.
 */
export const MAX_SHARE_BYTES = 3 * MAX_EVAL_CHARS + 1024;

/** Longest base64url payload worth inflating (deflate-raw adds ~5 bytes per 16 KB to incompressible data) */
const MAX_ENCODED_CHARS = Math.ceil((MAX_SHARE_BYTES * 1.01 + 1024) * 4 / 3);

export interface SharedSong {
  id: string;
  text: string;
}

export class ShareError extends Error {}

/** The base64url payload of a share link for this song (throws ShareError when it can't be shared) */
export async function encodeShare(id: string, text: string): Promise<string> {
  const problem = songIdProblem(id);
  if (problem) throw new ShareError(problem);
  if (typeof text !== "string") throw new ShareError("text must be a string");
  if (text.length > MAX_EVAL_CHARS) throw new ShareError(`song too large to share (${text.length} > ${MAX_EVAL_CHARS} characters)`);
  const json = new TextEncoder().encode(JSON.stringify({ v: SHARE_VERSION, id, text }));
  if (json.length > MAX_SHARE_BYTES) throw new ShareError("song too large to share");
  const stream = new Blob([json as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return toBase64Url(new Uint8Array(await new Response(stream).arrayBuffer()));
}

/** The `song=` payload of a location hash ("#song=…", "song=…", "#a=1&song=…"), or null */
export function sharePayload(hash: string): string | null {
  const params = hash.replace(/^#/, "").split("&");
  for (const param of params) {
    if (param.startsWith(`${SHARE_PARAM}=`)) return param.slice(SHARE_PARAM.length + 1);
  }
  return null;
}

/** The song in a share link's hash, or null if there's none or it's malformed, too large or names a bad id */
export async function decodeShare(hash: string): Promise<SharedSong | null> {
  try {
    const payload = sharePayload(hash);
    if (!payload || payload.length > MAX_ENCODED_CHARS) return null;
    const bytes = fromBase64Url(payload);
    if (!bytes) return null;
    const json = await inflateCapped(bytes, MAX_SHARE_BYTES);
    if (!json) return null;
    const data: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(json));
    if (!data || typeof data !== "object") return null;
    const { v, id, text } = data as Record<string, unknown>;
    if (v !== SHARE_VERSION || typeof id !== "string" || typeof text !== "string") return null;
    if (songIdProblem(id) || text.length > MAX_EVAL_CHARS) return null;
    return { id, text };
  } catch {
    return null;
  }
}

/** Inflate deflate-raw bytes, giving up (null) as soon as the output passes `cap` bytes or the data is corrupt */
export async function inflateCapped(bytes: Uint8Array, cap: number): Promise<Uint8Array | null> {
  const reader = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > cap) {
        void reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1) return null;
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}
