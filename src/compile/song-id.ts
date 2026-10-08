// Song ids for songs made at runtime (user songs, share links, local save).
// Shared by the player, the songs store and the dev server's save endpoint
// (vite-plugins/strudel-songs.ts), so all three accept exactly the same ids.
// No imports: Node type stripping loads this file as is.

/** Lowercase letters, digits, `-` and `_`, starting with a letter or digit, at most 64 characters */
export const SONG_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Why `id` can't name a song file (src/songs/<id>.ts), or null when it can */
export function songIdProblem(id: unknown): string | null {
  if (typeof id !== "string" || !id) return "a song id must be a non-empty string";
  if (!SONG_ID_RE.test(id)) return `"${id}" is not a valid song id (lowercase letters, digits, - and _, at most 64)`;
  if (id === "index") return `"index" is reserved (src/songs/index.ts is the song registry)`;
  return null;
}

/** The song file a song id stands for */
export function songFileOf(id: string): string {
  return `src/songs/${id}.ts`;
}
