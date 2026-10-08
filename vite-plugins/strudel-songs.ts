// ═══════════════════════════════════════════════════════════════════════════
// strudel-songs — the dev server's "save to file" endpoint for the songs store
// ═══════════════════════════════════════════════════════════════════════════
//
//   GET  /__strudel/song   → { ok: true }        feature probe (src/songs-store)
//   POST /__strudel/song   { id, text, create? }
//        writes src/songs/<id>.ts under the Vite root, byte for byte.
//        create: true  → a new file; 409 if it exists
//        create: false → overwrite an existing file; 404 if it's missing
//        → { ok: true, file: "src/songs/<id>.ts", created } | { ok: false, error }
//
// Both paths also answer under Vite's base (`<base>__strudel/song`). Vite's
// watcher then picks the file up: a new file reaches the eager
// import.meta.glob in src/songs/index.ts, an existing one hot-swaps as usual.
//
// Song files are code that `npm run check` and the page execute, so writes are
// locked down:
//   - the id must pass songIdProblem (src/compile/song-id.ts): no `/`, `.`,
//     `%`, `index` or leading `_`, at most 64 characters; and the resolved
//     path must still be a direct child of <root>/src/songs that isSongFile()
//   - text is a string of at most MAX_EVAL_CHARS; the body is capped while read
//   - CSRF: Content-Type must be application/json (a cross-site form or
//     no-cors fetch can't send that without a preflight), and an Origin header,
//     when present, must name this server's Host
//   - writes go to a temp file in the same directory, then rename (overwrite)
//     or hard-link (create, which fails atomically if the file appeared)
//
// configureServer only runs under `vite` (dev): `vite preview` and the static
// GitHub Pages build have no endpoint, and the store's probe says so.
// ═══════════════════════════════════════════════════════════════════════════

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { Plugin } from "vite";
import { songIdProblem, songFileOf } from "../src/compile/song-id.ts";
import { MAX_EVAL_CHARS } from "../src/live/protocol.ts";
import { isSongFile } from "./strudel-locations.ts";

export const SONG_ENDPOINT = "/__strudel/song";

/**
 * Most bytes a request body may have: MAX_EVAL_CHARS UTF-16 units are at most
 * 3 UTF-8 bytes each once JSON-encoded (`"`, `\` and newlines escape to 2),
 * plus the envelope.
 */
export const MAX_SONG_BODY_BYTES = 3 * MAX_EVAL_CHARS + 4096;

export class SongWriteError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface SongWriteTarget {
  id: string;
  text: string;
  create: boolean;
  /** Absolute path of src/songs/<id>.ts */
  abs: string;
  /** Root-relative path, e.g. "src/songs/wobble.ts" */
  file: string;
}

/** Refuse requests a cross-site page could make (throws SongWriteError 415/403) */
export function checkSongRequest(headers: { contentType?: string; origin?: string; host?: string }): void {
  const type = headers.contentType?.split(";")[0].trim().toLowerCase();
  if (type !== "application/json") throw new SongWriteError("Content-Type must be application/json", 415);
  if (headers.origin === undefined) return;
  let originHost: string | null = null;
  try {
    originHost = new URL(headers.origin).host.toLowerCase();
  } catch {
    // "null" (sandboxed/file pages) or garbage
  }
  if (!originHost || !headers.host || originHost !== headers.host.toLowerCase()) {
    throw new SongWriteError(`cross-origin write refused (Origin ${headers.origin})`, 403);
  }
}

/** Validate a parsed POST body and resolve the song file it writes (throws SongWriteError 400/403/413) */
export function songWriteTarget(payload: unknown, root: string): SongWriteTarget {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new SongWriteError("body must be a JSON object { id, text, create? }", 400);
  const { id, text, create = false } = payload as Record<string, unknown>;
  const problem = songIdProblem(id);
  if (problem) throw new SongWriteError(problem, 400);
  if (typeof text !== "string") throw new SongWriteError("text must be a string", 400);
  if (text.length > MAX_EVAL_CHARS) throw new SongWriteError(`text too large (${text.length} > ${MAX_EVAL_CHARS} characters)`, 413);
  if (typeof create !== "boolean") throw new SongWriteError("create must be a boolean", 400);
  const songId = id as string;
  const dir = path.resolve(root, "src/songs");
  const abs = path.resolve(dir, `${songId}.ts`);
  // belt and braces: the id rule already rules out separators and dots
  if (path.dirname(abs) !== dir || !isSongFile(abs, root)) throw new SongWriteError(`${songId} doesn't name a song file (src/songs/*.ts)`, 403);
  return { id: songId, text, create, abs, file: songFileOf(songId) };
}

/** Read a request body as UTF-8, refusing (413) once it passes `cap` bytes */
export async function readBody(req: AsyncIterable<Buffer | string>, cap = MAX_SONG_BODY_BYTES): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += buf.length;
    if (total > cap) throw new SongWriteError("request too large", 413);
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const errnoOf = (err: unknown) => (err as NodeJS.ErrnoException | null)?.code;

/** Write the song file atomically: create (409 if it exists) or overwrite (404 if it's missing) */
export async function writeSongFile(target: SongWriteTarget): Promise<{ file: string; created: boolean }> {
  const { abs, text, create, file } = target;
  // not *.ts, so the songs glob never sees it
  const tmp = path.join(path.dirname(abs), `.${target.id}.ts.${randomBytes(6).toString("hex")}.tmp`);
  let mode: number | undefined;
  if (!create) {
    try {
      const st = await fs.stat(abs);
      if (!st.isFile()) throw new SongWriteError(`${file} is not a file`, 409);
      mode = st.mode & 0o777;
    } catch (err) {
      if (err instanceof SongWriteError) throw err;
      throw new SongWriteError(`${file} doesn't exist (create a new song instead)`, 404);
    }
  }
  await fs.writeFile(tmp, text, { flag: "wx", mode });
  try {
    if (!create) {
      await fs.rename(tmp, abs);
      return { file, created: false };
    }
    try {
      await fs.link(tmp, abs);
    } catch (err) {
      if (errnoOf(err) === "EEXIST") throw new SongWriteError(`${file} already exists`, 409);
      // no hard links on this file system: exclusive create instead
      try {
        await fs.writeFile(abs, text, { flag: "wx" });
      } catch (err2) {
        if (errnoOf(err2) === "EEXIST") throw new SongWriteError(`${file} already exists`, 409);
        throw err2;
      }
    }
    return { file, created: true };
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Vite plugin
// ─────────────────────────────────────────────────────────────────────────────

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export default function strudelSongs(): Plugin {
  return {
    name: "strudel-songs",
    apply: "serve",
    configureServer(server) {
      const root = server.config.root;
      const handle = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        // mounted with use(path): req.url is what follows the path
        if (req.url && !/^\/?(\?|$)/.test(req.url)) return next();
        const reply = (status: number, body: object) => {
          res.statusCode = status;
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-store");
          res.end(JSON.stringify(body));
        };
        if (req.method === "GET" || req.method === "HEAD") return reply(200, { ok: true });
        if (req.method !== "POST") return reply(405, { ok: false, error: "GET or POST only" });
        void (async () => {
          try {
            checkSongRequest({ contentType: header(req, "content-type"), origin: header(req, "origin"), host: header(req, "host") });
            let payload: unknown;
            const body = await readBody(req);
            try {
              payload = JSON.parse(body);
            } catch {
              throw new SongWriteError("body must be JSON", 400);
            }
            const result = await writeSongFile(songWriteTarget(payload, root));
            server.config.logger.info(`[strudel-songs] ${result.created ? "created" : "saved"} ${result.file}`, { timestamp: true });
            reply(200, { ok: true, ...result });
          } catch (err) {
            const status = err instanceof SongWriteError ? err.status : 500;
            reply(status, { ok: false, error: err instanceof Error ? err.message : String(err) });
          }
        })();
      };
      server.middlewares.use(SONG_ENDPOINT, handle);
      const base = server.config.base;
      if (base.startsWith("/") && base !== "/") server.middlewares.use(base.replace(/\/$/, "") + SONG_ENDPOINT, handle);
    },
  };
}
