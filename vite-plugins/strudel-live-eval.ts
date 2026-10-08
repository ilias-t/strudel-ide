// ═══════════════════════════════════════════════════════════════════════════
// strudel-live-eval — evaluate unsaved editor buffers (dev server only)
// ═══════════════════════════════════════════════════════════════════════════
//
// strudel.cc evaluates the code in its editor without saving it. Here the
// editor (VS Code extension) sends the unsaved buffer of a song file over the
// bridge (`eval`, src/live/protocol.ts) and the dev server:
//
//   1. validates it: a song module (src/songs/<name>.ts, not index.ts/_*.ts)
//      that exists on disk, at most MAX_EVAL_CHARS; version = contentVersion(text)
//   2. keeps it in memory (LiveBuffers: the last few versions per file)
//   3. compiles it as the module `/src/songs/<name>.ts?live=<version>` through
//      Vite's own transform pipeline: the `load` hook below returns the buffer
//      instead of the file, so strudel-locations (mini-notation offsets, now
//      into the buffer), strudel-knobs and TS stripping all apply unchanged.
//      A TypeScript syntax check runs first for exact positions and messages.
//   4. tells the browsers to import it (`live {url}`), or hands them the
//      compile error (`live {error}`): the player hot-swaps the module like an
//      HMR update, or keeps the last good pattern and reports the error.
//
// Compiling on the server (transformRequest) instead of letting the browser
// fetch a broken module keeps Vite's error overlay off the stage.
//
// Live modules share their file with the real song module in Vite's module
// graph but have no importers (the player import()s them by URL), so a save
// of that file would make Vite do a full page reload. handleHotUpdate()
// drops them from the update, and old versions are pruned from the graph.
// ═══════════════════════════════════════════════════════════════════════════

import { existsSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { ModuleNode, ViteDevServer } from "vite";
import { LIVE_QUERY, MAX_EVAL_CHARS, contentVersion, type PlayerError } from "../src/live/protocol.ts";
import { isSongFile } from "./strudel-locations.ts";

/** Versions kept per file: the browser imports the newest; errors are located through older ones' source maps */
const KEEP_VERSIONS = 8;

const LIVE_RE = new RegExp(`[?&]${LIVE_QUERY}=([0-9a-f]{8})(?:&|$)`);

/** The live version in a module id or URL (`…/x.ts?live=1a2b3c4d`), else null */
export function liveVersionOf(id: string): string | null {
  return LIVE_RE.exec(id)?.[1] ?? null;
}

/** `/src/songs/x.ts?live=<version>` (root-relative URL, without Vite's base) */
export function liveUrl(file: string, version: string): string {
  return `/${file}?${LIVE_QUERY}=${version}`;
}

export class LiveEvalError extends Error {
  readonly error: PlayerError;
  constructor(error: PlayerError) {
    super(error.message);
    this.error = error;
  }
}

/**
 * Normalize and validate an editor's `file`: the Vite-root-relative path of an
 * existing song module, or a LiveEvalError.
 */
export function songFileOf(root: string, file: unknown): string {
  if (typeof file !== "string" || !file) throw new LiveEvalError({ message: "eval: `file` must be a song path" });
  const abs = path.resolve(root, file);
  const rel = path.relative(root, abs).split(path.sep).join("/");
  if (rel.startsWith("..") || path.isAbsolute(rel) || !isSongFile(abs, root)) {
    throw new LiveEvalError({ message: `${file} is not a song file (src/songs/<name>.ts)` });
  }
  if (!existsSync(abs)) {
    throw new LiveEvalError({ message: `${rel} is not on disk yet: save it once, then evaluate`, file: rel });
  }
  return rel;
}

interface Buffer {
  text: string;
  at: number;
}

/** The evaluated buffers: file → version → text (newest last, KEEP_VERSIONS per file) */
export class LiveBuffers {
  private files = new Map<string, Map<string, Buffer>>();

  /** Store a buffer; returns the versions that were evicted */
  put(file: string, version: string, text: string): string[] {
    let versions = this.files.get(file);
    if (!versions) this.files.set(file, (versions = new Map()));
    versions.delete(version); // re-insert as newest
    versions.set(version, { text, at: Date.now() });
    const evicted: string[] = [];
    for (const v of versions.keys()) {
      if (versions.size - evicted.length <= KEEP_VERSIONS) break;
      evicted.push(v);
    }
    for (const v of evicted) versions.delete(v);
    return evicted;
  }

  get(file: string, version: string): string | undefined {
    return this.files.get(file)?.get(version)?.text;
  }

  /** The most recently evaluated buffer of `file` */
  latest(file: string): { version: string; text: string } | null {
    const versions = this.files.get(file);
    if (!versions?.size) return null;
    const version = [...versions.keys()].at(-1)!;
    return { version, text: versions.get(version)!.text };
  }

}

/** Syntax errors of a TS buffer, located (1-based), or null */
export function syntaxError(text: string, file: string): PlayerError | null {
  const out = ts.transpileModule(text, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  });
  const d = out.diagnostics?.find((x) => x.category === ts.DiagnosticCategory.Error && x.file && x.start !== undefined);
  if (!d) return null;
  const { line, character } = d.file!.getLineAndCharacterOfPosition(d.start!);
  return {
    message: `Syntax error: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`,
    file,
    line: line + 1,
    column: character + 1,
  };
}

/** A Vite/esbuild transform error → PlayerError (loc.column is 0-based) */
function transformError(err: unknown, file: string): PlayerError {
  const e = err as { message?: string; loc?: { line?: number; column?: number } };
  const message = String(e?.message ?? err)
    .replace(/^\[plugin:[^\]]+\]\s*/, "")
    .replace(/^Transform failed with \d+ errors?:\s*/, "")
    .split("\n")[0];
  return {
    message,
    file,
    line: e?.loc?.line,
    column: typeof e?.loc?.column === "number" ? e.loc.column + 1 : undefined,
  };
}

/** Drop module-graph nodes of `file`'s live versions that are no longer stored */
function prune(server: ViteDevServer, abs: string, keep: (version: string) => boolean) {
  const graph = server.moduleGraph;
  const mods = graph.getModulesByFile(abs);
  if (!mods) return;
  for (const mod of [...mods]) {
    const version = liveVersionOf(mod.url);
    if (!version || keep(version)) continue;
    mods.delete(mod);
    graph.urlToModuleMap.delete(mod.url);
    if (mod.id) graph.idToModuleMap.delete(mod.id);
    const etag = mod.transformResult?.etag;
    if (etag) graph.etagToModuleMap.delete(etag);
  }
}

export interface CompiledBuffer {
  file: string;
  version: string;
  /** URL to import, with Vite's base */
  url: string;
}

/**
 * The live-eval service of one dev server. `compile()` stores and compiles a
 * buffer (throws LiveEvalError); `load()` and `hotUpdate()` are the plugin hooks.
 */
export function createLiveEval(server: ViteDevServer) {
  const root = server.config.root;
  const base = (server.config.base || "/").replace(/\/$/, "");
  const buffers = new LiveBuffers();
  /** file → the version last evaluated since the file was last saved */
  const active = new Map<string, string>();

  return {
    buffers,

    /** The buffer the player was last given for `file`, unless the file was saved since */
    activeBuffer(file: string): { version: string; text: string } | null {
      const version = active.get(file);
      const text = version && buffers.get(file, version);
      return version && text !== undefined ? { version, text } : null;
    },

    async compile(fileArg: unknown, text: unknown): Promise<CompiledBuffer> {
      const file = songFileOf(root, fileArg);
      if (typeof text !== "string") throw new LiveEvalError({ message: "eval: `text` must be a string", file });
      if (text.length > MAX_EVAL_CHARS) {
        throw new LiveEvalError({ message: `eval: ${file} is too large (${text.length} > ${MAX_EVAL_CHARS} characters)`, file });
      }
      const version = contentVersion(text);
      const evicted = buffers.put(file, version, text);
      active.set(file, version);
      const abs = path.resolve(root, file);
      if (evicted.length) prune(server, abs, (v) => buffers.get(file, v) !== undefined);

      const syntax = syntaxError(text, file);
      if (syntax) throw new LiveEvalError(syntax);
      const url = liveUrl(file, version);
      try {
        // not through the HTTP middleware: its errors would pop Vite's overlay
        await server.transformRequest(url);
      } catch (err) {
        throw new LiveEvalError(transformError(err, file));
      }
      return { file, version, url: `${base}${url}` };
    },

    /** Plugin `load`: a stored buffer for `…/src/songs/x.ts?live=<v>` */
    load(id: string): string | null {
      const version = liveVersionOf(id);
      if (!version || !isSongFile(id, root)) return null;
      const file = path.relative(root, id.split("?")[0]).split(path.sep).join("/");
      const text = buffers.get(file, version);
      // never fall back to the file on disk: that would be another version
      return text ?? `throw new Error(${JSON.stringify(`live buffer ${file}@${version} has expired; evaluate again`)});\n`;
    },

    /**
     * Plugin `handleHotUpdate`: the file was saved, so it is the truth again.
     * Live modules never take part in HMR (they have no importers: Vite would
     * reload the page). Their buffers stay stored for locating errors.
     */
    hotUpdate(file: string, modules: ModuleNode[]): ModuleNode[] | undefined {
      active.delete(path.relative(root, file).split(path.sep).join("/"));
      if (!modules.some((m) => liveVersionOf(m.url))) return undefined;
      return modules.filter((m) => !liveVersionOf(m.url));
    },
  };
}

export type LiveEval = ReturnType<typeof createLiveEval>;
