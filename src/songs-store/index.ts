// ═══════════════════════════════════════════════════════════════════════════
// Songs store — the user's own songs, kept in the browser
// ═══════════════════════════════════════════════════════════════════════════
//
// Two kinds of saved song, one localStorage entry each
// (`strudel-ide:my-song:<id>` → { v: 1, kind, text, updatedAt }):
//   override — edited text for a built-in song (src/songs/<id>.ts)
//   user     — a song that exists only here (new, or opened from a share link)
// The store only persists. Evaluating is the player's job: the editor UI calls
// evalSource/addSong itself, and initSongsStore() replays the saved songs at
// boot. A page with nothing saved and no share link never touches the player,
// so it never loads the compiler.
//
// Also here: share links (the song in the URL hash, see share.ts), download as
// a .ts file, and "save to file" through the dev server's POST /__strudel/song
// (vite-plugins/strudel-songs.ts), which only exists under `npm run dev`.
//
// Everything is injected through createSongsStore(deps) so it runs in Node
// (test/store.test.ts); the plain exported functions at the bottom are bound
// to the browser and to the player given to connectSongsStore()/initSongsStore().
// Explicit .ts imports: Node type stripping loads this file in tests.
// ═══════════════════════════════════════════════════════════════════════════

import { KEYS, PREFIX } from "../engine/storage.ts";
import { songIdProblem } from "../compile/song-id.ts";
import { MAX_EVAL_CHARS } from "../live/protocol.ts";
import { decodeShare as decodeSharePayload, encodeShare, sharePayload, type SharedSong } from "./share.ts";

export { MAX_SHARE_BYTES, ShareError, type SharedSong } from "./share.ts";

export type EvalResult =
  | { ok: true; version: string }
  | { ok: false; error: { message: string; line?: number; column?: number } };

/** What the store needs from the player (src/engine/player.ts) */
export interface StorePlayer {
  /** A song from src/songs/*.ts */
  isBuiltInSong(id: string): boolean;
  /** Built-in or user song */
  hasSong(id: string): boolean;
  /** Compile and register a user song in the song list */
  addSong(id: string, text: string): Promise<EvalResult>;
  /** User songs only */
  removeSong(id: string): boolean;
  /** Hot-swap source into an existing song */
  evalSource(songId: string, text: string, opts: { intent: "typing" | "commit"; origin: "browser" | "editor" }): Promise<EvalResult>;
  /** Drop evaluated source: back to the built-in / disk text */
  revertSource(songId: string): void;
  selectSong(id: string): Promise<boolean>;
}

export type StoreStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

export interface MySong {
  id: string;
  kind: "user" | "override";
  /** The song's `name: "…"`, read from the text without compiling it */
  name: string | null;
  text: string;
  updatedAt: number;
}

/** saveOverride's result: `persisted` is false when storage is unavailable (private mode, quota, blocked) */
export type SavedSong = MySong & { persisted: boolean };

export type LoadResult = { ok: true; id: string } | { ok: false; error: string; /** the person said no (confirm) */ declined?: true };

export interface InitOptions {
  /** Asked before a share link in the URL is opened (see LoadOptions.confirm) */
  confirmShare?: LoadOptions["confirm"];
}

export interface LoadOptions {
  /**
   * Asked before a shared song's code is compiled and run; false = not opened.
   * initSongsStore() asks with window.confirm unless given its own.
   */
  confirm?: (song: SharedSong) => boolean | Promise<boolean>;
}

export type SaveToFileResult = { ok: true; file: string; created: boolean } | { ok: false; error: string };

export interface InitReport {
  /** Saved songs the player couldn't compile (they stay saved, so the user can fix them) */
  failed: { id: string; error: string }[];
  /** The share link in the hash, if there was one */
  shared: LoadResult | null;
}

export interface SongsStoreDeps {
  /** localStorage, or a getter for it (reading `localStorage` itself can throw) */
  storage: StoreStorage | (() => StoreStorage | null);
  player?: StorePlayer;
  location: Pick<Location, "href" | "hash"> | (() => Pick<Location, "href" | "hash">);
  fetch: typeof fetch;
  /** Running under the Vite dev server (import.meta.env.DEV) */
  dev: boolean;
  /** Vite's base (import.meta.env.BASE_URL), e.g. "/" or "/strudel-ide/" */
  baseUrl: string;
  now?: () => number;
  document?: { createElement(tag: "a"): HTMLAnchorElement; body?: { append(node: Node): void } | null };
  objectUrls?: { createObjectURL(blob: Blob): string; revokeObjectURL(url: string): void };
}

export interface SongsStore {
  /** Use this player from now on (initSongsStore does this too) */
  connect(player: StorePlayer): void;
  listMySongs(): MySong[];
  getMySong(id: string): MySong | null;
  saveOverride(id: string, text: string): SavedSong;
  revert(id: string): boolean;
  shareUrl(id: string, text: string, baseHref?: string): Promise<string>;
  decodeShare(hash: string): Promise<SharedSong | null>;
  loadFromHash(hash?: string, opts?: LoadOptions): Promise<LoadResult | null>;
  download(id: string, text: string): void;
  canSaveToFile(): Promise<boolean>;
  saveToFile(id: string, text: string, opts?: { create?: boolean }): Promise<SaveToFileResult>;
  /** Boot: stored songs, then a share link (asking `confirmShare` first, if given) */
  init(player: StorePlayer, opts?: InitOptions): Promise<InitReport>;
}

/** The dev server's song-file endpoint, relative to Vite's base */
export const SONG_ENDPOINT = "__strudel/song";

const ENTRY_PREFIX = PREFIX + KEYS.mySong("");
const NAME_RE = /\bname\s*:\s*"([^"\\\n]*)"/;

interface StoredEntry {
  v: 1;
  kind: MySong["kind"];
  text: string;
  updatedAt: number;
}

function errorText(error: { message: string; line?: number; column?: number }): string {
  if (error.line === undefined) return error.message;
  return `${error.message} (line ${error.line}${error.column !== undefined ? `, column ${error.column}` : ""})`;
}

export function createSongsStore(deps: SongsStoreDeps): SongsStore {
  let player = deps.player ?? null;
  const now = deps.now ?? Date.now;
  /** Text this store handed the player per user song (addSong) */
  const registered = new Map<string, string>();
  let probe: Promise<boolean> | null = null;

  // ── storage, never throwing ──────────────────────────────────────────────

  function storage(): StoreStorage | null {
    try {
      return typeof deps.storage === "function" ? deps.storage() : deps.storage;
    } catch {
      return null;
    }
  }

  function readEntry(id: string): StoredEntry | null {
    if (songIdProblem(id)) return null;
    let raw: string | null;
    try {
      raw = storage()?.getItem(ENTRY_PREFIX + id) ?? null;
    } catch {
      return null;
    }
    if (raw === null) return null;
    try {
      const data = JSON.parse(raw) as Partial<StoredEntry> | null;
      if (!data || typeof data !== "object" || typeof data.text !== "string") return null;
      return {
        v: 1,
        kind: data.kind === "override" ? "override" : "user",
        text: data.text,
        updatedAt: typeof data.updatedAt === "number" ? data.updatedAt : 0,
      };
    } catch {
      return null;
    }
  }

  function writeEntry(id: string, entry: StoredEntry): boolean {
    try {
      const s = storage();
      if (!s) return false;
      s.setItem(ENTRY_PREFIX + id, JSON.stringify(entry));
      return true;
    } catch {
      return false;
    }
  }

  /** Remove a saved song; true if there was one */
  function removeEntry(id: string): boolean {
    try {
      const s = storage();
      if (!s || s.getItem(ENTRY_PREFIX + id) === null) return false;
      s.removeItem(ENTRY_PREFIX + id);
      return true;
    } catch {
      return false;
    }
  }

  function storedIds(): string[] {
    const ids: string[] = [];
    try {
      const s = storage();
      if (!s) return ids;
      const keys: string[] = [];
      for (let i = 0; i < s.length; i++) {
        const key = s.key(i);
        if (key !== null) keys.push(key);
      }
      for (const key of keys) {
        if (!key.startsWith(ENTRY_PREFIX)) continue;
        const id = key.slice(ENTRY_PREFIX.length);
        if (!songIdProblem(id)) ids.push(id);
      }
    } catch {
      // storage unavailable: nothing saved
    }
    return ids;
  }

  function toMySong(id: string, entry: StoredEntry): MySong {
    // the player knows best: an override whose built-in file is gone is a user song now
    const kind = player ? (player.isBuiltInSong(id) ? "override" : "user") : entry.kind;
    return { id, kind, name: NAME_RE.exec(entry.text)?.[1] ?? null, text: entry.text, updatedAt: entry.updatedAt };
  }

  // ── my songs ─────────────────────────────────────────────────────────────

  function getMySong(id: string): MySong | null {
    const entry = readEntry(id);
    return entry && toMySong(id, entry);
  }

  function listMySongs(): MySong[] {
    const songs: MySong[] = [];
    for (const id of storedIds()) {
      const song = getMySong(id);
      if (song) songs.push(song);
    }
    return songs.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  }

  function saveOverride(id: string, text: string): SavedSong {
    const problem = songIdProblem(id);
    if (problem) throw new Error(problem);
    if (typeof text !== "string") throw new Error("text must be a string");
    const kind = player ? (player.isBuiltInSong(id) ? "override" : "user") : (readEntry(id)?.kind ?? "user");
    const entry: StoredEntry = { v: 1, kind, text, updatedAt: now() };
    const persisted = writeEntry(id, entry);
    return { ...toMySong(id, entry), persisted };
  }

  function revert(id: string): boolean {
    const removed = removeEntry(id);
    registered.delete(id);
    if (!player) return removed;
    if (player.isBuiltInSong(id)) {
      player.revertSource(id);
      return removed;
    }
    // also when it isn't listed yet: removeSong cancels an addSong still compiling (boot)
    return player.removeSong(id) || removed;
  }

  // ── share links ──────────────────────────────────────────────────────────

  function currentLocation() {
    return typeof deps.location === "function" ? deps.location() : deps.location;
  }

  async function shareUrl(id: string, text: string, baseHref = currentLocation().href): Promise<string> {
    const url = new URL(baseHref);
    url.hash = "";
    return `${url.href}#song=${await encodeShare(id, text)}`;
  }

  /** The text we know a user song by: what the user saved, else what we gave the player */
  function knownText(id: string): string | undefined {
    return readEntry(id)?.text ?? registered.get(id);
  }

  /** Where a shared song goes: its own id, or `<id>-shared[-n]` when that id holds something else */
  function pickId(id: string, text: string): string {
    for (let n = 1; ; n++) {
      const suffix = n === 1 ? "" : n === 2 ? "-shared" : `-shared-${n - 1}`;
      const candidate = id.slice(0, 64 - suffix.length) + suffix;
      if (!player!.hasSong(candidate) && readEntry(candidate) === null) return candidate;
      if (!player!.isBuiltInSong(candidate) && knownText(candidate) === text) return candidate;
    }
  }

  async function loadFromHash(hash = currentLocation().hash, opts: LoadOptions = {}): Promise<LoadResult | null> {
    if (!sharePayload(hash)) return null;
    if (!player) throw new Error("songs store: no player connected");
    const shared = await decodeSharePayload(hash);
    if (!shared) return { ok: false, error: "This share link is damaged or too large to open." };
    // A link's text is code, and compiling a song runs it in this page (with
    // this origin's storage and, under the dev server, its write endpoints):
    // nothing from a link runs before the person agrees.
    if (opts.confirm && !(await opts.confirm(shared))) {
      return { ok: false, error: "The shared song was not opened.", declined: true };
    }
    const id = pickId(shared.id, shared.text);
    if (!player.hasSong(id)) {
      const result = await player.addSong(id, shared.text);
      if (!result.ok) return { ok: false, error: errorText(result.error) };
      registered.set(id, shared.text);
    }
    await player.selectSong(id);
    return { ok: true, id };
  }

  // ── files ────────────────────────────────────────────────────────────────

  function download(id: string, text: string) {
    const doc: NonNullable<SongsStoreDeps["document"]> = deps.document ?? globalThis.document;
    const urls = deps.objectUrls ?? URL;
    const href = urls.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const a = doc.createElement("a");
    a.href = href;
    a.download = `${id}.ts`;
    doc.body?.append(a);
    a.click();
    a.remove?.();
    setTimeout(() => urls.revokeObjectURL(href), 1000);
  }

  function endpoint() {
    return deps.baseUrl.replace(/\/?$/, "/") + SONG_ENDPOINT;
  }

  function canSaveToFile(): Promise<boolean> {
    if (!deps.dev) return Promise.resolve(false);
    return (probe ??= (async () => {
      try {
        const res = await deps.fetch(endpoint());
        if (!res.ok) return false;
        const body = (await res.json()) as { ok?: unknown };
        return body?.ok === true;
      } catch {
        return false;
      }
    })());
  }

  async function saveToFile(id: string, text: string, opts: { create?: boolean } = {}): Promise<SaveToFileResult> {
    const problem = songIdProblem(id);
    if (problem) return { ok: false, error: problem };
    if (text.length > MAX_EVAL_CHARS) return { ok: false, error: `song too large (${text.length} > ${MAX_EVAL_CHARS} characters)` };
    if (!(await canSaveToFile())) return { ok: false, error: "saving to a file needs the dev server (npm run dev)" };
    let res: Response;
    try {
      res = await deps.fetch(endpoint(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, text, create: !!opts.create }),
      });
    } catch (err) {
      return { ok: false, error: `couldn't reach the dev server: ${err instanceof Error ? err.message : String(err)}` };
    }
    let body: { ok?: unknown; file?: unknown; created?: unknown; error?: unknown } | null = null;
    try {
      body = await res.json();
    } catch {
      // not JSON: reported below
    }
    if (!res.ok || body?.ok !== true || typeof body.file !== "string") {
      return { ok: false, error: typeof body?.error === "string" ? body.error : `save failed (HTTP ${res.status})` };
    }
    // the file is the truth now; HMR brings it into the player. An edit saved
    // while the request was out (different text) isn't on disk: keep that one.
    if (readEntry(id)?.text === text) removeEntry(id);
    return { ok: true, file: body.file, created: body.created === true };
  }

  // ── boot ─────────────────────────────────────────────────────────────────

  async function init(p: StorePlayer, opts: InitOptions = {}): Promise<InitReport> {
    player = p;
    const report: InitReport = { failed: [], shared: null };
    // Read everything synchronously first: with nothing saved and no share
    // link, return without calling the player (no compiler load at boot).
    const saved = storedIds()
      .map((id) => [id, readEntry(id)] as const)
      .filter((e): e is readonly [string, StoredEntry] => e[1] !== null);
    const hasShare = sharePayload(safeHash()) !== null;
    if (!saved.length && !hasShare) return report;
    for (const [id, entry] of saved) {
      try {
        let result: EvalResult;
        if (p.isBuiltInSong(id)) {
          result = await p.evalSource(id, entry.text, { intent: "commit", origin: "browser" });
        } else {
          result = await p.addSong(id, entry.text);
          if (result.ok) registered.set(id, entry.text);
        }
        if (!result.ok) report.failed.push({ id, error: errorText(result.error) });
      } catch (err) {
        report.failed.push({ id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (hasShare) report.shared = await loadFromHash(undefined, { confirm: opts.confirmShare });
    return report;
  }

  function safeHash(): string {
    try {
      return currentLocation().hash;
    } catch {
      return "";
    }
  }

  return {
    connect(p) {
      player = p;
    },
    listMySongs,
    getMySong,
    saveOverride,
    revert,
    shareUrl,
    decodeShare: decodeSharePayload,
    loadFromHash,
    download,
    canSaveToFile,
    saveToFile,
    init,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Browser-bound defaults (localStorage, location, fetch, Vite's env)
// ─────────────────────────────────────────────────────────────────────────────

let defaultStore: SongsStore | null = null;

function store(): SongsStore {
  // import.meta.env is undefined outside Vite (Node tests)
  const env = import.meta.env as ImportMetaEnv | undefined;
  return (defaultStore ??= createSongsStore({
    storage: () => globalThis.localStorage,
    location: () => globalThis.location,
    fetch: (input, init) => globalThis.fetch(input, init),
    dev: env?.DEV === true,
    baseUrl: env?.BASE_URL ?? "/",
  }));
}

/** Give the default store its player (initSongsStore does this too) */
export const connectSongsStore = (player: StorePlayer) => store().connect(player);
/** The user's saved songs, newest first */
export const listMySongs = () => store().listMySongs();
export const getMySong = (id: string) => store().getMySong(id);
/** Persist a song's text (an override for a built-in id, else a user song). Doesn't evaluate. */
export const saveOverride = (id: string, text: string) => store().saveOverride(id, text);
/** Forget a saved song: an override's built-in plays again, a user song leaves the list */
export const revert = (id: string) => store().revert(id);
/** A link with the song in its hash (#song=…); path and query of `baseHref` are kept */
export const shareUrl = (id: string, text: string, baseHref?: string) => store().shareUrl(id, text, baseHref);
/** The song in a share hash, or null when there's none or it's malformed */
export const decodeShare = (hash: string) => store().decodeShare(hash);
/** Open the share link in the hash as a user song and select it (doesn't play or save). null: no link. */
export const loadFromHash = (hash?: string, opts?: LoadOptions) => store().loadFromHash(hash, opts);
/** Download the song's exact text as <id>.ts */
export const download = (id: string, text: string) => store().download(id, text);
/** True only under the dev server with the song endpoint (probed once) */
export const canSaveToFile = () => store().canSaveToFile();
/** Write src/songs/<id>.ts through the dev server (create: a new file, else overwrite an existing one) */
export const saveToFile = (id: string, text: string, opts?: { create?: boolean }) => store().saveToFile(id, text, opts);
/** Boot hook: register saved user songs, apply saved overrides, then open a share link in the hash */
/**
 * The boot hook (main.ts). A share link in the URL is only opened once the
 * person agrees: `confirmShare` (default: window.confirm) sees its id and text.
 */
export const initSongsStore = (player: StorePlayer, opts: InitOptions = {}) =>
  store().init(player, { confirmShare: opts.confirmShare ?? confirmShareInBrowser });

/** The default question before a share link's code runs */
export function confirmShareInBrowser(song: SharedSong): boolean {
  const ask = (globalThis as { confirm?: (message: string) => boolean }).confirm;
  if (typeof ask !== "function") return false;
  return ask(
    `Open the shared song "${song.id}"?\n\nA share link carries code, and opening it runs that code in this page. ` +
      `Only open links from people you trust.`
  );
}
