// ═══════════════════════════════════════════════════════════════════════════
// 🎵 SONG REGISTRY
// ═══════════════════════════════════════════════════════════════════════════
//
// Songs are auto-discovered from this directory!
// Just create a new .ts file and export a default Song object.
//
// Only src/main.ts imports this module at runtime (it accepts its HMR updates),
// so a song edit hot-swaps instead of reloading the page. Other modules use
// `import type` only.
//
// ═══════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// Visualization Types
// ─────────────────────────────────────────────────────────────────────────────

export type VisualizationType = "pianoroll" | "scope" | "none";

export interface VisualizationConfig {
  type: VisualizationType;
  options?: PianorollOptions; // Pianoroll options (also works for punchcard)
}

/** Default pianoroll settings */
export const defaultVisualization: VisualizationConfig = {
  type: "none",
  options: {
    cycles: 4,
    playhead: 0.5,
    autorange: true,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Song Interface
// ─────────────────────────────────────────────────────────────────────────────

/** Named tracks, e.g. `{ kick, snare, bass }` — the player stacks them (and can mute/solo by name) */
export type Tracks = Record<string, Pattern>;

/**
 * The song's form for the player's timeline: section names and lengths in bars
 * (1 cycle = 1 bar), in playing order. Either `{ name, bars }` objects or the
 * `[name, bars]` tuples songs already use with `arrange`, so a song can pass
 * its FORM table as is: `sections: FORM`.
 */
export type SongSections =
  | readonly { readonly name: string; readonly bars: number }[]
  | readonly (readonly [name: string, bars: number])[];

export interface Song {
  name: string;
  bpm?: number; // Tempo in beats per minute (default: 120)
  visualization?: VisualizationType | VisualizationConfig; // Visualization config
  /** Sections for the timeline (jump to a section, loop it). Should match the arrangement. */
  sections?: SongSections;
  /**
   * The stage's room: "dusk" (default) is a calm studio with soft, lush lamps;
   * "club" is near-black with hard strobes and short tails, for hard transients.
   */
  room?: "dusk" | "club";
  /** Return a single Pattern, or named tracks that get stacked together */
  createPattern(): Pattern | Tracks;
}

export function isPattern(value: unknown): value is Pattern {
  return typeof (value as Pattern)?.queryArc === "function";
}

/** Normalize createPattern()'s result into a single Pattern */
export function toPattern(result: Pattern | Tracks): Pattern {
  return isPattern(result) ? result : stack(...Object.values(result));
}

export interface BuiltSong {
  /** The (stacked) pattern of the audible tracks */
  pattern: Pattern;
  /** Track names when createPattern() returned named tracks, otherwise null */
  tracks: string[] | null;
  /**
   * All named tracks in order (null for a single Pattern). The player decorates
   * these per track (mute/solo, colours, activity tags) and stacks them itself.
   */
  parts: [name: string, pattern: Pattern][] | null;
}

/**
 * Build a song's patterns. This is the single place the player turns a Song
 * into Patterns. `isAudible` filters `pattern`; the player mutes on `parts`
 * instead (seamlessly, see src/engine/tracks.ts). Throws whatever
 * createPattern() throws.
 */
export function buildPattern(
  song: Song,
  isAudible: (track: string) => boolean = () => true
): BuiltSong {
  const result = song.createPattern();
  if (isPattern(result)) return { pattern: result, tracks: null, parts: null };
  if (!result || typeof result !== "object") {
    throw new Error(
      `createPattern() must return a Pattern or a record of named Patterns, got ${typeof result}`
    );
  }
  const entries = Object.entries(result);
  for (const [name, value] of entries) {
    if (!isPattern(value)) throw new Error(`Track "${name}" is not a Pattern`);
  }
  const audible = entries.filter(([name]) => isAudible(name)).map(([, p]) => p);
  return { pattern: stack(...audible), tracks: entries.map(([name]) => name), parts: entries };
}

/**
 * Which file a song's highlight offsets refer to, and the version of its text
 * they were computed from. Injected into each song module by
 * vite-plugins/strudel-locations.ts (`__strudel_file`, `__strudel_version`).
 */
export interface SongSource {
  file: string;
  version?: string;
  /** The text exactly as compiled (the file on disk, or a live buffer), which the highlight offsets index into */
  text?: string;
  /** An evaluated, unsaved editor buffer (live eval) rather than the file on disk */
  live?: boolean;
}

interface SongModule {
  default: Song;
  __strudel_file?: string;
  __strudel_version?: string;
}

// Auto-import all song modules (excluding index.ts and _template.ts)
const songModules = import.meta.glob<SongModule>(
  ["./*.ts", "!./index.ts", "!./_template.ts"],
  { eager: true }
);

// The raw text of each song file, for the player's code view. Imported here
// (and nowhere else) so an edit updates the text together with the module, in
// the one HMR update main.ts accepts.
const songTexts = import.meta.glob<string>(["./*.ts", "!./index.ts", "!./_template.ts"], {
  eager: true,
  query: "?raw",
  import: "default",
});

// Build songs registry from modules
export const songs: Record<string, Song> = {};
export const songSources: Record<string, SongSource> = {};

for (const [path, module] of Object.entries(songModules)) {
  // Extract song ID from path: "./untitled.ts" -> "untitled"
  const id = path.replace("./", "").replace(".ts", "");
  songs[id] = module.default;
  songSources[id] = {
    file: module.__strudel_file ?? `src/songs/${id}.ts`,
    version: module.__strudel_version,
    text: songTexts[path],
  };
}

export function getSong(id: string): Song {
  return songs[id] ?? Object.values(songs)[0];
}

export function getAllSongs(): Array<{ id: string; song: Song }> {
  return Object.entries(songs).map(([id, song]) => ({ id, song }));
}
