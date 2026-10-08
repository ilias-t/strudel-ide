import type { VisualizationType } from "../songs";

export interface PlayerError {
  /** build: createPattern()/viz threw · query: pattern threw while playing ·
   *  trigger: a sound failed to play (e.g. unknown sample) · load: startup */
  kind: "build" | "query" | "trigger" | "load";
  message: string;
  songId?: string;
  /** Song file, line and column (1-based, source-mapped to the .ts file) */
  file?: string;
  line?: number;
  column?: number;
  /** true when the music fell back to (or kept) the previous good pattern */
  keptPrevious: boolean;
}

/** A section of the current song, positioned in bars from the song start */
export interface SectionInfo {
  index: number;
  name: string;
  /** First bar of the section, 0-based (= cycle) */
  start: number;
  bars: number;
}

export interface PlayerState {
  ready: boolean;
  loading: string | null;
  playing: boolean;
  songId: string;
  songName: string;
  bpm: number;
  cps: number;
  /** Current scheduler cycle position (0 when stopped). Monotonic while playing. */
  cycle: number;
  /**
   * Where in the song we are (in cycles = bars), as heard: the scheduler cycle
   * minus output latency, remapped by section jumps and loops.
   */
  position: number;
  /** 1-based bar and beat of `position` (wrapped to the song length when it has sections) */
  bar: number;
  beat: number;
  visualization: VisualizationType;
  /** Track names when the song returns named tracks */
  tracks: string[] | null;
  muted: string[];
  soloed: string[];
  sections: SectionInfo[] | null;
  /** The section playing now (null without sections) */
  section: SectionInfo | null;
  /** Looping the current section */
  loop: boolean;
  /** A section jump waiting for its bar line (scheduler cycle `atCycle`) */
  pendingJump: { index: number; atCycle: number } | null;
  followEdits: boolean;
  codeView: boolean;
  audio: AudioContextState | "uninitialized";
  /** Play was requested but the browser blocks audio until a user gesture */
  needsGesture: boolean;
  error: PlayerError | null;
  /**
   * The current song plays (or shows) an evaluated, unsaved editor buffer
   * instead of its file (live eval): the file and the buffer's contentVersion
   */
  live: { file: string; version: string } | null;
  swapCount: number;
  lastSwapAt: number | null;
}
