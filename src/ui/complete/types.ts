// ═══════════════════════════════════════════════════════════════════════════
// Smart autocomplete: the contracts its modules meet at
// ═══════════════════════════════════════════════════════════════════════════
//
// src/ui/complete/ is the editor's Strudel language support: completions
// inside strings and after a dot, calm warnings for unknown names, hovers on
// names inside strings, and sound previews while browsing a list. It loads
// with Monaco (code-editor.ts imports index.ts), never at boot.
//
//   context.ts / mini.ts / roles.ts   what the string under the caret means (pure, sync)
//   registry.ts                       the live sound registry (superdough's soundMap)
//   diagnostics.ts / did-you-mean.ts  warnings + quick fixes (Warning severity, never red)
//   values.ts / members.ts            items inside strings / after a dot
//   provider.ts / hover.ts / browse.ts / index.ts   the Monaco side
//
// Offsets are UTF-16 offsets into the model text (LF line ends), like the
// highlight ranges.

/** What a string literal holds, decided by the call it's an argument of (or, for a carrier like mini(), the chain after it) */
export type Role =
  | "sound" // s / sound
  | "bank"
  | "note" // note names or MIDI numbers
  | "number" // n, arp: sample indices or scale degrees
  | "scale"
  | "chord" // chord symbols: C^7 Dm7
  | "voicingDict" // .dict / .voicings("lefthand")
  | "vowel"
  | "struct" // x ~ t f
  | "mini"; // a mini-notation string we know nothing more about

/** The mini-notation token under the caret */
export interface MiniToken {
  /** File offsets of the token */
  start: number;
  end: number;
  text: string;
  /** Text from the token's start to the caret */
  prefix: string;
  /** The character right before the token inside the string ("" at the string's start) */
  before: string;
  /** For "bd:3": the word before the ":" */
  head?: string;
}

/** A word of a mini string with its file offsets ("bd*2 [sd:3]" → bd, sd) */
export interface MiniWord {
  text: string;
  start: number;
  end: number;
  /** The variant after a ":" ("sd:3" → 3), when it's a number */
  variant?: number;
}

/** A call in a chain: `s(…)`, `.bank(…)` */
export interface CallRef {
  name: string;
  /** `.name(…)` rather than `name(…)` */
  method: boolean;
}

export interface StringContext {
  /** The string literal, quotes included (an unclosed one ends where typing is) */
  string: { start: number; end: number };
  /** Its contents without quotes */
  value: string;
  call: CallRef;
  argIndex: number;
  /** The whole chain the call is in: a(…).b(…).c(…), in order */
  chain: CallRef[];
  role: Role;
  /** What decided the role, for docs: "s(…)", "mini(…).note()" */
  roleFrom: string;
  token: MiniToken;
  /** Bank names in the chain (a literal, or a simple `const D = "…"`) */
  banks: string[];
  /** Sound words of the chain's s()/sound() strings, nested ones too (`stack(s("bd"), s("sd")).bank(…)`) */
  soundsInChain: string[];
  /** The track this string belongs to, from `const hats = …` or a record key `hats: …` */
  trackName?: string;
}

/** The live sound registry: what can actually play right now */
export interface SoundRegistry {
  /** Samples finished loading (warnings wait for this) */
  ready(): boolean;
  /** Bumps on every (debounced) change */
  version(): number;
  /** Called after changes settle (debounced); returns the unsubscribe */
  onChange(fn: () => void): () => void;
  /** A registered key: "bd", "rolandtr909_bd", "tr909_bd" (any case) */
  has(key: string): boolean;
  /** Files for a sample key (0 for synths and wavetables); null: not registered */
  variants(key: string): number | null;
  /** The catalog's kind for a sound name (kick, keys, synth, …) */
  kind(name: string): string | undefined;
  type(key: string): "sample" | "synth" | "wavetable" | undefined;
  /** Needs a note to sound right: samples keyed by note, synths, wavetables */
  pitched(key: string): boolean;
  /** Every sound that plays without a bank */
  unbanked(): string[];
  /** Every bank (canonical names and aliases), with its parts */
  banks(): { name: string; canonical: string; parts: string[] }[];
  /** The parts of a bank (by canonical name or alias, any case); [] for an unknown bank */
  bankParts(bank: string): string[];
}

/** Why a function sinks to the bottom of the method list (shown as the reason, never struck through) */
export type Availability = "ok" | "superdirt" | "visual" | "io" | "internal";

/** What completions know about one function (src/catalog/completions.json) */
export interface CompletionMeta {
  category: string;
  /** Global rank: 0 is the most used */
  rank: number;
  availability: Availability;
  aliasOf?: string;
  synonyms?: string[];
  range?: { min?: number; max?: number; unit?: string; log?: boolean };
  /** strudel.cc page (and anchor) documenting it */
  docUrl?: string;
}

/** Music theory for string completions and hovers (src/catalog/theory.json) */
export interface Theory {
  /** Scale types ("major", "minor pentatonic") with their intervals; common ones flagged */
  scales: { name: string; intervals: string[]; common?: true }[];
  /** Chord symbol ("m7", "^7", "7b9") → intervals */
  chords: Record<string, string[]>;
  vowels: string[];
  /** Voicing dictionaries for .dict()/.voicings() */
  voicingDicts: string[];
}
