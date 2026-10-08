// ═══════════════════════════════════════════════════════════════════════════
// Autosave for the browser editor: every buffer change is kept in the songs
// store (src/songs-store/), debounced per song, so a reload never loses an
// edit, not even one that doesn't compile yet.
// ═══════════════════════════════════════════════════════════════════════════
//
//   edit(id, text)   a change: written after `debounceMs` of quiet
//   flush(id?)       write what's pending now (⌘S, page hidden / unloading)
//   cancel(id)       drop what's pending (revert: it must not come back)
//   keep(id, text)   write now (⌘S on the hosted site)
//
// A built-in song whose buffer says exactly what its file says has no edits:
// its override is dropped rather than saved as a copy. A user song (no
// original) is the stored text itself, so it is always saved.
//
// Pure: the store, the original text and timers are injected (Node tests:
// test/song-saver.test.ts). Explicit .ts imports: Node type stripping.

import type { SessionTimers } from "./edit-session.ts";

export interface SaverStore {
  saveOverride(id: string, text: string): { persisted: boolean };
  /** Forget the entry without touching the player */
  discard(id: string): boolean;
}

export interface SongSaverOptions {
  store: SaverStore;
  /** A built-in song's own text (its file); undefined for a user song */
  originalText(id: string): string | undefined;
  /** Quiet time after the last change before writing (default 300) */
  debounceMs?: number;
  timers?: SessionTimers;
  /** The stored state of `id` may have changed (badges re-read the store) */
  onSaved?(id: string): void;
}

/** keep()'s outcome: written / nothing to keep (the original text) / storage unavailable */
export type KeepResult = "saved" | "unchanged" | "not-persisted";

const defaultTimers: SessionTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

export class SongSaver {
  private readonly opts: SongSaverOptions;
  private readonly timers: SessionTimers;
  private readonly debounceMs: number;
  private readonly pendingWrites = new Map<string, { text: string; timer: unknown }>();

  constructor(opts: SongSaverOptions) {
    this.opts = opts;
    this.timers = opts.timers ?? defaultTimers;
    this.debounceMs = opts.debounceMs ?? 300;
  }

  edit(id: string, text: string): void {
    this.cancel(id);
    const timer = this.timers.set(() => {
      this.pendingWrites.delete(id);
      this.write(id, text);
    }, this.debounceMs);
    this.pendingWrites.set(id, { text, timer });
  }

  /** Whether a change of `id` is waiting to be written */
  pending(id: string): boolean {
    return this.pendingWrites.has(id);
  }

  flush(id?: string): void {
    for (const songId of id === undefined ? [...this.pendingWrites.keys()] : [id]) {
      const entry = this.pendingWrites.get(songId);
      if (!entry) continue;
      this.cancel(songId);
      this.write(songId, entry.text);
    }
  }

  cancel(id: string): void {
    const entry = this.pendingWrites.get(id);
    if (!entry) return;
    this.timers.clear(entry.timer);
    this.pendingWrites.delete(id);
  }

  keep(id: string, text: string): KeepResult {
    this.cancel(id);
    return this.write(id, text);
  }

  private write(id: string, text: string): KeepResult {
    let result: KeepResult;
    if (text === this.opts.originalText(id)) {
      this.opts.store.discard(id);
      result = "unchanged";
    } else {
      try {
        result = this.opts.store.saveOverride(id, text).persisted ? "saved" : "not-persisted";
      } catch {
        result = "not-persisted"; // an id that can't name a song file
      }
    }
    this.opts.onSaved?.(id);
    return result;
  }
}
