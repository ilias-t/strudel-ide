// ═══════════════════════════════════════════════════════════════════════════
// The Song types, for the Monaco editor only
// ═══════════════════════════════════════════════════════════════════════════
//
// editor-lang.ts registers this text as file:///src/songs/index.d.ts, so a
// song's `import type { Song } from "."` resolves in the editor. It's a copy
// of the exported types in src/songs/index.ts (types only: that file's runtime
// part can't be handed to Monaco). test/editor-docs.test.ts fails when the two
// drift; copy the changed declarations over.

export type VisualizationType = "pianoroll" | "scope" | "none";

export interface VisualizationConfig {
  type: VisualizationType;
  options?: PianorollOptions; // Pianoroll options (also works for punchcard)
}

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
