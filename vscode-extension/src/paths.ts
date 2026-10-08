// Path helpers (pure; node:path only). Protocol `file` fields are relative to
// the Vite root with "/" separators.

import * as path from "node:path";

export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Root-relative posix path of `abs`, or null when it lies outside `root`. */
export function relativeTo(root: string, abs: string): string | null {
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return toPosix(rel);
}

export function resolveIn(root: string, rel: string): string {
  return path.resolve(root, ...rel.split("/"));
}

/** A song module: src/songs/<name>.ts, excluding index.ts and _private files. */
export function isSongPath(rel: string | null): rel is string {
  return !!rel && /^src\/songs\/(?!index\.ts$)(?!_)[^/]+\.ts$/.test(rel);
}

/** Song id the registry derives from a path ("src/songs/jynx.ts" → "jynx"). */
export function songIdFromPath(rel: string): string {
  return rel.slice(rel.lastIndexOf("/") + 1).replace(/\.ts$/, "");
}
