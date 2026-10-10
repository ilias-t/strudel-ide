// ═══════════════════════════════════════════════════════════════════════════
// Completions inside a string: what fits here, from what is actually loaded
// ═══════════════════════════════════════════════════════════════════════════
//
// Given the string context under the caret (./context.ts), the live sound
// registry (./registry.ts) and theory.json, list the values that fit:
//
//   s("…") / sound("…")   registered sounds only; under a bank, that machine's
//                       parts; after "bd:" its real variant numbers. Kinds that
//                       fit the track's name first (const hats = s("|")), then
//                       drums, then the rest. While samples load, a first row
//                       says how far they are.
//   .bank("…")           machines that have every part the chain's s() plays
//                       (all of them, each saying what it lacks, if none does)
//   note("…")            pitch classes; after a letter, its notes with octaves
//   .scale("…")          roots ("C:", which reopens the list), then the types
//   chord("…")           roots, then the root with each iReal symbol
//   .dict / .vowel / .struct   their few words
//   any mini string     mini-notation help: ~ [ ] < > { } at a fresh step, the
//                       modifiers (*2 /2 ! @2 ? : (3,8) , |) right after a value
//
// Pure: no Monaco. Items carry file offsets; ./provider.ts turns them into
// Monaco ranges and kinds. Sorting is by sortText (Monaco's fuzzy score
// decides first once something is typed).

import type { SoundRegistry, StringContext, Theory } from "./types.ts";
import { MINI, docHref, type MiniRow } from "../discover/cheatsheet-data.ts";
import { PITCH_CLASSES, ROOTS, parseNote, spell } from "./notes.ts";

export type ValueKind =
  | "sound"
  | "variant"
  | "bank"
  | "note"
  | "root"
  | "scale"
  | "chord"
  | "word" // vowels, voicing dictionaries, struct letters
  | "operator" // mini-notation
  | "loading";

/** What a row previews while browsing (./browse.ts): auditionSound(sound, { bank, n, pitched, note }) */
export interface SoundPreview {
  sound: string;
  bank?: string;
  n?: number;
  pitched?: boolean;
  /** The note a pitched sound plays: the chain's scale root */
  note?: string;
}

export interface ValueItem {
  label: string;
  /** Right after the label, dimmed: " ×8", " → RolandTR909" */
  detail?: string;
  /** Right-aligned: "kick", "11 parts", "mini-notation" */
  description?: string;
  kind: ValueKind;
  insertText: string;
  /** insertText is a snippet ($0 marks the caret) */
  snippet?: boolean;
  /** File offsets of the text the item replaces */
  range: { start: number; end: number };
  /** Where the insert range ends (the caret) when it isn't range.end */
  insertEnd?: number;
  filterText?: string;
  sortText: string;
  /** Markdown for the details pane */
  documentation?: string;
  /** Reopen the list after accepting ("C:", then the scale types) */
  retrigger?: boolean;
  strudel?: SoundPreview;
}

export interface ValueEnv {
  registry: SoundRegistry;
  theory: Theory | null;
  /** While samples load: sounds registered so far, of about how many */
  loading?: { count: number; total: number } | null;
}

export interface ValueList {
  items: ValueItem[];
  /** Ask again on the next keystroke (sounds are still arriving) */
  incomplete: boolean;
}

// ── track names → sound kinds ───────────────────────────────────────────────

/** A track's name says what it is (the same patterns as src/engine/tracks.ts trackRole, which imports the engine) and so which kinds fit it */
const TRACK_KINDS: [RegExp, string[]][] = [
  [/kick|^bd|909|808k|pulse/i, ["kick"]],
  [/snare|^sd|clap|^cp|rim|ghost/i, ["snare", "clap", "rim"]],
  [/hat|^hh|^oh|ride|cymbal|shaker/i, ["hat", "openhat", "cymbal", "shaker"]],
  [/perc|tom|crash|fill|conga|bongo|clave|cowbell|break/i, ["perc", "tom", "break", "cymbal", "rim", "shaker"]],
  [/acid|303/i, ["synth"]],
  [/bass|sub|rumble|reese|wobble|low/i, ["synth", "wavetable", "plucked"]],
  [/pad|chord|key|string|choir|organ|piano|rhodes|drone|atmos|stab/i, ["keys", "organ", "strings", "synth", "wavetable", "wind"]],
  [/arp|pluck|seq|bell|harp|loop|pebble/i, ["mallets", "plucked", "keys", "synth"]],
  [/lead|melody|vox|vocal|hook|voice|tune/i, ["synth", "wind", "keys", "mallets", "wavetable"]],
  [/fx|riser|sweep|noise|vinyl|rain|shore|hiss|texture|impact/i, ["fx", "noise"]],
];

const DRUM_KINDS = ["kick", "snare", "clap", "rim", "hat", "openhat", "cymbal", "tom", "shaker", "perc", "break"];

function kindsFor(track: string | undefined): string[] {
  if (!track) return [];
  return TRACK_KINDS.find(([re]) => re.test(track))?.[1] ?? [];
}

const pad = (n: number, w = 3) => String(n).padStart(w, "0");

// ── mini-notation help ──────────────────────────────────────────────────────

interface Op {
  label: string;
  /** The cheat sheet's row (its meaning and strudel.cc anchor) */
  row: string;
  insert: string;
  snippet?: boolean;
  /** Only where a value names a sound */
  soundsOnly?: boolean;
  retrigger?: boolean;
}

/** At a fresh step */
const STRUCTURE: Op[] = [
  { label: "~", row: "rest", insert: "~" },
  { label: "[ ]", row: "subdivide", insert: "[$0]", snippet: true },
  { label: "< >", row: "alternate", insert: "<$0>", snippet: true },
  { label: "{ }", row: "polymeter", insert: "{$0}", snippet: true },
];

/** Right after a value */
const MODIFIERS: Op[] = [
  { label: "*2", row: "faster", insert: "*${1:2}", snippet: true },
  { label: "/2", row: "slower", insert: "/${1:2}", snippet: true },
  { label: "!", row: "replicate", insert: "!" },
  { label: "@2", row: "elongate", insert: "@${1:2}", snippet: true },
  { label: "?", row: "maybe", insert: "?" },
  { label: ":", row: "variant", insert: ":", soundsOnly: true, retrigger: true },
  { label: "(3,8)", row: "euclid", insert: "(${1:3},${2:8})", snippet: true },
  { label: ",", row: "stack", insert: ", " },
  { label: "|", row: "choice", insert: " | " },
];

const MINI_BY_ID = new Map<string, MiniRow>(MINI.map((r) => [r.id, r]));

function opItems(ops: Op[], at: number, sortPrefix: string, role: StringContext["role"]): ValueItem[] {
  const out: ValueItem[] = [];
  ops.forEach((op, i) => {
    if (op.soundsOnly && role !== "sound") return;
    if (op.label === "~" && role === "struct") return; // struct lists ~ itself
    const row = MINI_BY_ID.get(op.row);
    const item: ValueItem = {
      label: op.label,
      detail: row ? ` ${row.name}` : undefined,
      description: "mini-notation",
      kind: "operator",
      insertText: op.insert,
      range: { start: at, end: at },
      sortText: `${sortPrefix}${i}`,
    };
    if (row) item.documentation = `${row.meaning} \`${row.example}\`\n\n[strudel.cc ↗](${docHref(row.doc)})`;
    if (op.snippet) item.snippet = true;
    if (op.retrigger) item.retrigger = true;
    out.push(item);
  });
  return out;
}

// ── the list ────────────────────────────────────────────────────────────────

/** The items for the string under the caret (`offset`) */
export function valueItems(ctx: StringContext, offset: number, env: ValueEnv): ValueList {
  const tok = ctx.token;
  const tokRange = { start: tok.start, end: tok.end };
  const items: ValueItem[] = [];
  let incomplete = false;
  /** a fresh step: nothing typed, not after a colon */
  const fresh = tok.prefix === "" && tok.before !== ":";
  /** the caret right after a whole word */
  const afterWord = tok.prefix !== "" && offset === tok.end && tok.before !== ":";
  const structure = () => {
    if (fresh) items.push(...opItems(STRUCTURE, offset, "~1", ctx.role));
  };
  const modifiers = (ok: boolean) => {
    if (afterWord && ok) items.push(...opItems(MODIFIERS, offset, "~2", ctx.role));
  };

  switch (ctx.role) {
    case "sound": {
      const bank = ctx.banks.length ? ctx.banks[ctx.banks.length - 1] : undefined;
      if (tok.before === ":") {
        if (tok.head) items.push(...variantItems(ctx, bank, tokRange, offset, env));
        break;
      }
      if (!env.registry.ready() && env.loading) {
        incomplete = true;
        items.push({
          label: "loading samples…",
          detail: ` (${env.loading.count} of ~${Math.round(env.loading.total / 100) * 100})`,
          kind: "loading",
          insertText: tok.text,
          filterText: tok.prefix,
          range: tokRange,
          insertEnd: offset,
          sortText: "!",
          documentation: "The rest of the sounds are still loading: the list grows as they arrive.",
        });
      }
      items.push(...soundItems(ctx, bank, tokRange, offset, env));
      structure();
      const key = bank ? `${bank}_${tok.text}` : tok.text;
      modifiers(env.registry.has(key));
      break;
    }
    case "bank":
      items.push(...bankItems(ctx, tokRange, offset, env));
      break;
    case "note":
      items.push(...noteItems(tok.prefix, tokRange, offset));
      structure();
      modifiers(parseNote(tok.text) !== null || /^-?\d+(\.\d+)?$/.test(tok.text));
      break;
    case "number":
      structure();
      modifiers(true);
      break;
    case "scale":
      items.push(...scaleItems(ctx, offset, env.theory));
      break;
    case "chord":
      items.push(...chordItems(ctx, offset, env.theory));
      structure();
      modifiers(true);
      break;
    case "voicingDict":
      items.push(...words(env.theory?.voicingDicts ?? [], "voicings", tokRange, offset));
      break;
    case "vowel":
      items.push(...words(env.theory?.vowels ?? [], "vowel", tokRange, offset));
      structure();
      modifiers(true);
      break;
    case "struct":
      items.push(...STRUCT.map(([w, d], i) => word(w, d, tokRange, offset, `0${i}`)));
      structure();
      modifiers(true);
      break;
    default:
      structure();
      modifiers(true);
  }
  return { items, incomplete };
}

// ── sounds ──────────────────────────────────────────────────────────────────

type Range = ValueItem["range"];

/** "kick", "keys · pitched", "synth", "noise · synth" */
function describeSound(type: string | undefined, kind: string | undefined, pitched: boolean): string {
  if (type === "synth" || type === "wavetable") return kind && kind !== type && kind !== "synth" ? `${kind} · ${type}` : type;
  return pitched ? `${kind ?? "sample"} · pitched` : (kind ?? "sample");
}

function soundItems(ctx: StringContext, bank: string | undefined, range: Range, offset: number, env: ValueEnv): ValueItem[] {
  const reg = env.registry;
  const names = bank ? reg.bankParts(bank) : reg.unbanked();
  const fit = kindsFor(ctx.trackName);
  const out: ValueItem[] = [];
  for (const name of names) {
    const key = bank ? `${bank}_${name}` : name;
    const type = reg.type(key);
    const kind = reg.kind(key);
    const pitched = reg.pitched(key);
    const files = reg.variants(key) ?? 0;
    const count = type === "sample" && !pitched && files > 1 ? files : 0;
    const description = describeSound(type, kind, pitched);
    const fitAt = kind ? fit.indexOf(kind) : -1;
    const drumAt = kind ? DRUM_KINDS.indexOf(kind) : -1;
    const tier = fitAt >= 0 ? `0${pad(fitAt, 2)}` : drumAt >= 0 ? `1${pad(drumAt, 2)}` : "2";
    const strudel: SoundPreview = { sound: name };
    if (bank) strudel.bank = bank;
    if (pitched) {
      strudel.pitched = true;
      if (ctx.scaleRoot) strudel.note = ctx.scaleRoot;
    }
    const variants = count ? ` · ${count} variants (${name}:0–${name}:${count - 1})` : "";
    const item: ValueItem = {
      label: name,
      description,
      kind: "sound",
      insertText: name,
      range,
      insertEnd: offset,
      // short names first within a kind: the classic ones (bd, sd, hh) before bassdrum1, snare_hi
      sortText: `${tier}${pad(name.length, 2)}${name}`,
      documentation: `**${name}**${bank ? ` · ${bank}` : ""} · ${description}${variants}`,
      strudel,
    };
    if (count) item.detail = ` ×${count}`;
    out.push(item);
  }
  return out;
}

function variantItems(ctx: StringContext, bank: string | undefined, range: Range, offset: number, env: ValueEnv): ValueItem[] {
  const head = ctx.token.head!;
  const key = bank ? `${bank}_${head}` : head;
  const reg = env.registry;
  const n = reg.variants(key) ?? 0;
  if (reg.pitched(key)) return [];
  const out: ValueItem[] = [];
  for (let i = 0; i < n; i++) {
    const strudel: SoundPreview = { sound: head };
    if (bank) strudel.bank = bank;
    strudel.n = i;
    out.push({
      label: String(i),
      description: `${head}:${i}`,
      kind: "variant",
      insertText: String(i),
      range,
      insertEnd: offset,
      sortText: pad(i),
      documentation: `**${head}:${i}**${bank ? ` · ${bank}` : ""} · file ${i + 1} of ${n}`,
      strudel,
    });
  }
  return out;
}

function bankItems(ctx: StringContext, range: Range, offset: number, env: ValueEnv): ValueItem[] {
  const used = [...new Set(ctx.soundsInChain.map((s) => s.toLowerCase()))];
  const banks = env.registry.banks();
  const missingOf = (parts: string[]) => used.filter((p) => !parts.includes(p));
  const fits = banks.filter((b) => missingOf(b.parts).length === 0);
  const out: ValueItem[] = [];
  for (const b of fits.length ? fits : banks) {
    const missing = missingOf(b.parts);
    const alias = b.name !== b.canonical;
    const part = used.find((p) => b.parts.includes(p)) ?? (b.parts.includes("bd") ? "bd" : b.parts[0]);
    const item: ValueItem = {
      label: b.name,
      description: missing.length ? `no ${missing.join(", ")}` : `${b.parts.length} parts`,
      kind: "bank",
      insertText: b.name,
      range,
      insertEnd: offset,
      sortText: `${pad(missing.length, 2)}${alias ? 1 : 0}${b.name.toLowerCase()}`,
      documentation: `**${b.canonical}**${alias ? ` (as ${b.name})` : ""}: ${b.parts.join(" ")}`,
      strudel: { sound: part, bank: b.name },
    };
    if (alias) item.detail = ` → ${b.canonical}`;
    out.push(item);
  }
  return out;
}

// ── notes, scales, chords, words ────────────────────────────────────────────

function noteDoc(name: string): string | undefined {
  const n = parseNote(name);
  if (!n) return undefined;
  const hz = 440 * 2 ** ((n.midi - 69) / 12);
  return `**${name}** · MIDI ${n.midi} · ${hz.toFixed(1)} Hz`;
}

function noteItems(prefix: string, range: Range, offset: number): ValueItem[] {
  const out: ValueItem[] = [];
  const note = (label: string, sortText: string) => out.push({ label, description: "note", kind: "note", insertText: label, range, insertEnd: offset, sortText, documentation: noteDoc(label) });
  const m = /^([a-gA-G])([#b]?)$/.exec(prefix);
  if (!m) {
    PITCH_CLASSES.forEach((pc, i) => note(pc, `1${pad(i, 2)}`));
    return out;
  }
  const letter = m[1].toLowerCase();
  PITCH_CLASSES.forEach((pc, i) => {
    if (pc[0] !== letter || (m[2] && pc !== letter + m[2])) return;
    const r = pad(pc === letter ? 0 : i + 1, 2); // the natural first: e3 before eb3
    for (let o = 1; o <= 6; o++) note(`${pc}${o}`, o === 3 ? `0${r}` : `1${r}${o}`);
    note(pc, `2${r}`);
  });
  return out;
}

/** The step of a string around the caret: the run between spaces and brackets ("C:minor:pentatonic", "Dm7") */
export function stepAt(ctx: StringContext, offset: number): { start: number; end: number; before: string } {
  const base = ctx.string.start + 1;
  const v = ctx.value;
  const stop = (c: string) => /[\s[\]<>{}(),|]/.test(c);
  const caret = Math.max(0, Math.min(offset - base, v.length));
  let a = caret;
  while (a > 0 && !stop(v[a - 1])) a--;
  let b = caret;
  while (b < v.length && !stop(v[b])) b++;
  return { start: base + a, end: base + b, before: v.slice(a, caret) };
}

function scaleItems(ctx: StringContext, offset: number, theory: Theory | null): ValueItem[] {
  const step = stepAt(ctx, offset);
  const colon = step.before.indexOf(":");
  if (colon < 0) {
    return ROOTS.map((r, i) => ({
      label: `${r}:`,
      description: "root",
      kind: "root" as const,
      insertText: `${r}:`,
      range: { start: step.start, end: step.end },
      insertEnd: offset,
      sortText: pad(i, 2),
      retrigger: true,
    }));
  }
  const root = step.before.slice(0, colon);
  const range = { start: step.start + colon + 1, end: step.end };
  return (theory?.scales ?? []).map((s, i) => {
    const typed = s.name.replace(/ /g, ":");
    const notes = spell(root, s.intervals);
    return {
      label: s.name,
      description: "scale",
      kind: "scale" as const,
      insertText: typed,
      filterText: typed,
      range,
      insertEnd: offset,
      sortText: s.common ? `0${pad(i)}` : `1${s.name}`,
      documentation: notes.length ? `**${root} ${s.name}**: ${notes.join(" ")}` : `**${s.name}**: ${s.intervals.join(" ")}`,
    };
  });
}

function chordItems(ctx: StringContext, offset: number, theory: Theory | null): ValueItem[] {
  const step = stepAt(ctx, offset);
  const range = { start: step.start, end: step.end };
  const m = /^([A-Ga-g][#b]?)/.exec(step.before);
  if (!m) {
    return ROOTS.map((r, i) => ({ label: r, description: "root", kind: "root" as const, insertText: r, range, insertEnd: offset, sortText: `0${pad(i, 2)}`, retrigger: true }));
  }
  const root = m[1][0].toUpperCase() + m[1].slice(1);
  return Object.entries(theory?.chords ?? {}).map(([sym, intervals], i) => ({
    label: root + sym,
    description: "chord",
    kind: "chord" as const,
    insertText: root + sym,
    filterText: root + sym,
    range,
    insertEnd: offset,
    sortText: `1${pad(i)}`,
    documentation: `**${root + sym}**: ${spell(root, intervals).join(" ")}`,
  }));
}

const STRUCT: [string, string][] = [
  ["x", "a hit"],
  ["~", "a rest"],
  ["t", "true"],
  ["f", "false"],
];

function word(label: string, description: string, range: Range, offset: number, sortText: string): ValueItem {
  return { label, description, kind: "word", insertText: label, range, insertEnd: offset, sortText };
}

function words(list: readonly string[], description: string, range: Range, offset: number): ValueItem[] {
  return list.map((w, i) => word(w, description, range, offset, pad(i)));
}
