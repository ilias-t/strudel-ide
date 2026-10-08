// ═══════════════════════════════════════════════════════════════════════════
// 🎵 SONG REGISTRY
// ═══════════════════════════════════════════════════════════════════════════
//
// Songs are auto-discovered from this directory!
// Just create a new .ts file and export a default Song object.
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

export interface Song {
  name: string;
  bpm?: number; // Tempo in beats per minute (default: 120)
  visualization?: VisualizationType | VisualizationConfig; // Visualization config
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
  /** The (stacked) pattern to play */
  pattern: Pattern;
  /** Track names when createPattern() returned named tracks, otherwise null */
  tracks: string[] | null;
}

/**
 * Build a song's playable pattern. This is the single place the player turns a
 * Song into a Pattern, so per-track features (mute/solo) hook in here via
 * `isAudible`. Throws whatever createPattern() throws.
 */
export function buildPattern(
  song: Song,
  isAudible: (track: string) => boolean = () => true
): BuiltSong {
  const result = song.createPattern();
  if (isPattern(result)) return { pattern: result, tracks: null };
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
  return { pattern: stack(...audible), tracks: entries.map(([name]) => name) };
}

/**
 * Which file a song's highlight offsets refer to, and the version of its text
 * they were computed from. Injected into each song module by
 * vite-plugins/strudel-locations.ts (`__strudel_file`, `__strudel_version`).
 */
export interface SongSource {
  file: string;
  version?: string;
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
  };
}

export function getSong(id: string): Song {
  return songs[id] ?? Object.values(songs)[0];
}

export function getAllSongs(): Array<{ id: string; song: Song }> {
  return Object.entries(songs).map(([id, song]) => ({ id, song }));
}
