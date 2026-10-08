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

// Auto-import all song modules (excluding index.ts and _template.ts)
const songModules = import.meta.glob<{ default: Song }>(
  ["./*.ts", "!./index.ts", "!./_template.ts"],
  { eager: true }
);

// Build songs registry from modules
export const songs: Record<string, Song> = {};

for (const [path, module] of Object.entries(songModules)) {
  // Extract song ID from path: "./untitled.ts" -> "untitled"
  const id = path.replace("./", "").replace(".ts", "");
  songs[id] = module.default;
}

export function getSong(id: string): Song {
  return songs[id] ?? Object.values(songs)[0];
}

export function getAllSongs(): Array<{ id: string; song: Song }> {
  return Object.entries(songs).map(([id, song]) => ({ id, song }));
}
