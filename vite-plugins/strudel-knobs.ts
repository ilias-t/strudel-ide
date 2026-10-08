// ═══════════════════════════════════════════════════════════════════════════
// strudel-knobs — song identity for knob() + the dev-only write-back endpoint
// ═══════════════════════════════════════════════════════════════════════════
//
// 1. Transform (src/songs/*.ts, after strudel-locations)
//      knob("cutoff", 2200, 200, 8000)
//   →  __strudel_knob("cutoff", 2200, 200, 8000)
//   plus, prepended to the module, `__strudelKnobModule(file)` (this module
//   evaluates now: its top-level knobs are declared anew) and, appended, the
//   helper that calls the global `__strudelKnob(file, …args)`. That tells the
//   player which song a knob belongs to, also for knobs at the top of the file
//   (which run when the module is imported, outside any build). See
//   src/engine/knobs.ts. A file that declares its own `knob` is left alone.
//   It must run after strudel-locations: that plugin computes file offsets
//   from the text it receives, and this one changes lengths.
//
// 2. POST /__strudel/knob   (dev server only)
//      { file: "src/songs/untitled.ts", knobs: [{ name: "cutoff", value: 1800 }] }
//   (or a single { file, name, value }) rewrites the numeric `value` literal of
//   every `knob("cutoff", <value>, …)` call in that file, using the TypeScript
//   AST for exact positions, in one write (so "Write all" is one hot-swap).
//   Refuses (4xx, nothing written) when a call isn't found, or its value isn't
//   a numeric literal (`2200`, `-3`, `0.15`), and (409) while the player plays
//   an evaluated, unsaved editor buffer of that file (live eval, see
//   strudel-live-eval.ts): writing the file would replace those unsaved edits
//   in the player and clash with the editor's buffer. The editor extension
//   writes into its buffer instead; from the stage, save first. Vite's watcher then sends the
//   usual HMR update. Response: { ok: true, changes: [{ name, literal, line }] }
//   or { ok: false, error }.
// ═══════════════════════════════════════════════════════════════════════════

import { promises as fs } from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { Plugin } from "vite";
import { isSongFile } from "./strudel-locations.ts";
import type { StrudelBridgeApi } from "./strudel-bridge.ts";
import { jsonWriteProblem, requestHeaders } from "./local-request.ts";
import * as shared from "../src/compile/knobs.ts";
import { KnobWriteError, numberLiteral, type KnobChange, type KnobWrite } from "../src/compile/knobs.ts";

export const KNOB_ENDPOINT = "/__strudel/knob";

// The transform and the literal rewrite live in src/compile/knobs.ts, shared
// with the browser compiler. These bind them to the Node `typescript`.
export { KnobWriteError, numberLiteral, type KnobChange, type KnobWrite };

/** Route a song file's knob() calls through a helper that passes the file */
export function transformKnobs(code: string, file: string) {
  return shared.transformKnobs(ts, code, file);
}

/**
 * Refuse a write while `buffer` (the evaluated, unsaved editor buffer of
 * `file`) differs from the file on disk.
 */
export function checkLiveBuffer(code: string, file: string, writes: KnobWrite[], buffer: { text: string } | null) {
  shared.checkLiveBuffer(ts, code, file, writes, buffer);
}

/** Rewrite the value literal of the named knobs in `code` (all-or-nothing, throws KnobWriteError) */
export function rewriteKnobValues(code: string, file: string, writes: KnobWrite[]) {
  return shared.rewriteKnobValues(ts, code, file, writes);
}

// ─────────────────────────────────────────────────────────────────────────────
// Vite plugin
// ─────────────────────────────────────────────────────────────────────────────

async function readBody(req: NodeJS.ReadableStream): Promise<string> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 64_000) throw new KnobWriteError("request too large", 413);
  }
  return body;
}

export default function strudelKnobs(): Plugin {
  let root = process.cwd();
  return {
    name: "strudel-knobs",
    enforce: "pre",
    configResolved(config) {
      root = config.root;
    },
    transform(code, id) {
      if (!isSongFile(id, root)) return null;
      const file = path.relative(root, id.split("?")[0]).split(path.sep).join("/");
      const result = transformKnobs(code, file);
      return result && { code: result.code, map: result.map.toString() };
    },
    configureServer(server) {
      server.middlewares.use(KNOB_ENDPOINT, (req, res) => {
        const reply = (status: number, body: object) => {
          res.statusCode = status;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(body));
        };
        if (req.method !== "POST") return reply(405, { ok: false, error: "POST only" });
        // localhost pages only, JSON only (no cross-site simple POST, no DNS rebinding)
        const refused = jsonWriteProblem(requestHeaders(req));
        if (refused) return reply(refused.status, { ok: false, error: refused.message });
        void (async () => {
          try {
            let payload: { file?: unknown; name?: unknown; value?: unknown; knobs?: unknown };
            try {
              payload = JSON.parse(await readBody(req));
            } catch (err) {
              if (err instanceof KnobWriteError) throw err;
              throw new KnobWriteError("body must be JSON", 400);
            }
            const { file } = payload;
            if (typeof file !== "string") throw new KnobWriteError("file must be a string", 400);
            const abs = path.resolve(root, file);
            const rel = path.relative(root, abs).split(path.sep).join("/");
            if (rel.startsWith("..") || path.isAbsolute(rel) || !isSongFile(abs, root)) {
              throw new KnobWriteError(`${file} is not a song file (src/songs/*.ts)`, 403);
            }
            const writes = (Array.isArray(payload.knobs) ? payload.knobs : [{ name: payload.name, value: payload.value }]) as KnobWrite[];
            let code: string;
            try {
              code = await fs.readFile(abs, "utf8");
            } catch {
              throw new KnobWriteError(`${file} not found`, 404);
            }
            const bridge = server.config.plugins.find((p) => p.name === "strudel-bridge")?.api as StrudelBridgeApi | undefined;
            checkLiveBuffer(code, rel, writes, bridge?.live?.activeBuffer(rel) ?? null);
            const result = rewriteKnobValues(code, rel, writes);
            if (result.code !== code) await fs.writeFile(abs, result.code);
            reply(200, { ok: true, file: rel, changes: result.changes });
          } catch (err) {
            const status = err instanceof KnobWriteError ? err.status : 500;
            reply(status, { ok: false, error: err instanceof Error ? err.message : String(err) });
          }
        })();
      });
    },
  };
}
