// ═══════════════════════════════════════════════════════════════════════════
// A snippet with another drum machine or sound (the track builder's step 3)
// ═══════════════════════════════════════════════════════════════════════════
//
//   withSound(code, { bank })   the argument of an existing .bank("…") is
//                               replaced, or .bank("X") is appended
//   withSound(code, { sound })  the value of the snippet's one s("…") /
//                               .s("…") / .sound("…") is replaced when it is a
//                               single word (a sound name), else .s("x") is
//                               appended (it overrides a pattern of sounds)
//   drumParts(code)             the sound names the snippet's s("…") plays
//                               (bd, hh…: which banks can play it)
//
// Works on tokens (../tokenize.ts), so strings, comments and other methods
// never match by accident. Pure; the result is still one expression.

import { tokenize } from "../tokenize.ts";

export interface SoundChoice {
  /** A drum machine (sounds.json banks) */
  bank?: string;
  /** A synth or an instrument */
  sound?: string;
}

interface Lexeme {
  kind: "id" | "str" | "num" | "punct";
  text: string;
  start: number;
  end: number;
}

/** Significant tokens: identifiers, strings, numbers and single punctuation characters */
function lex(code: string): Lexeme[] {
  const out: Lexeme[] = [];
  for (const t of tokenize(code)) {
    const text = code.slice(t.start, t.end);
    if (t.kind === "c") continue;
    if (t.kind === "s") out.push({ kind: "str", text, start: t.start, end: t.end });
    else if (t.kind === "n") out.push({ kind: "num", text, start: t.start, end: t.end });
    else if (t.kind === "p") {
      for (let i = 0; i < text.length; i++) out.push({ kind: "punct", text: text[i], start: t.start + i, end: t.start + i + 1 });
    } else {
      // keywords, calls, Types and plain runs (identifiers between whitespace)
      for (const m of text.matchAll(/[A-Za-z_$\u0080-￿][\w$\u0080-￿]*/g)) {
        out.push({ kind: "id", text: m[0], start: t.start + m.index!, end: t.start + m.index! + m[0].length });
      }
    }
  }
  return out;
}

interface Call {
  /** The method / function name */
  name: Lexeme;
  /** A lone string literal argument, if that's what it has */
  literal: Lexeme | null;
}

/** Calls of `names` (as methods, or as functions when `bare`) */
function calls(lexemes: Lexeme[], names: Set<string>, { bare }: { bare: boolean }): Call[] {
  const out: Call[] = [];
  for (let i = 0; i < lexemes.length; i++) {
    const l = lexemes[i];
    if (l.kind !== "id" || !names.has(l.text) || lexemes[i + 1]?.text !== "(") continue;
    const prev = lexemes[i - 1];
    const method = prev?.kind === "punct" && prev.text === ".";
    if (!method && !bare) continue;
    const arg = lexemes[i + 2];
    const close = lexemes[i + 3];
    out.push({ name: l, literal: arg?.kind === "str" && close?.text === ")" ? arg : null });
  }
  return out;
}

const SOUND_CALLS = new Set(["s", "sound"]);
const BANK_CALLS = new Set(["bank"]);

/** The string's content (no quotes) */
const content = (s: Lexeme) => s.text.slice(1, -1);

/** A string literal like `like`, holding `value` */
function quoted(like: string, value: string): string {
  const q = like[0] === "'" || like[0] === "`" ? like[0] : '"';
  return q + value.replace(/[\\'"`$]/g, (c) => (c === q || c === "\\" ? `\\${c}` : c)) + q;
}

const SINGLE_WORD = /^[A-Za-z0-9_]+$/;

/** `code` with the chosen bank and/or sound (see the header) */
export function withSound(code: string, { bank, sound }: SoundChoice): string {
  if (!bank && !sound) return code;
  const lexemes = lex(code);
  const edits: { start: number; end: number; text: string }[] = [];
  const appended: string[] = [];

  if (bank) {
    const banks = calls(lexemes, BANK_CALLS, { bare: false });
    if (banks.length && banks.every((c) => c.literal)) {
      for (const c of banks) edits.push({ start: c.literal!.start, end: c.literal!.end, text: quoted(c.literal!.text, bank) });
    } else {
      appended.push(`.bank(${quoted('"', bank)})`);
    }
  }
  if (sound) {
    const sounds = calls(lexemes, SOUND_CALLS, { bare: true });
    const only = sounds.length === 1 ? sounds[0].literal : null;
    if (only && SINGLE_WORD.test(content(only))) {
      edits.push({ start: only.start, end: only.end, text: quoted(only.text, sound) });
    } else {
      appended.push(`.s(${quoted('"', sound)})`);
    }
  }

  if (appended.length) {
    const at = lexemes.length ? lexemes[lexemes.length - 1].end : code.length;
    edits.push({ start: at, end: at, text: appended.join("") });
  }
  let out = code;
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

/** The sound names in the snippet's s("…") / .s("…") / .sound("…") literals, in order */
export function drumParts(code: string): string[] {
  const parts: string[] = [];
  for (const c of calls(lex(code), SOUND_CALLS, { bare: true })) {
    if (!c.literal) continue;
    for (const m of content(c.literal).matchAll(/[A-Za-z_][\w]*/g)) if (!parts.includes(m[0])) parts.push(m[0]);
  }
  return parts;
}
