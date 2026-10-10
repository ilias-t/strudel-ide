// ═══════════════════════════════════════════════════════════════════════════
// Hovers on names inside strings: what a sound, note, scale, chord or bank is,
// with a ▶ that plays it
// ═══════════════════════════════════════════════════════════════════════════
//
//   s("cp")            **cp** · clap · 2 variants (cp:0–cp:1)
//                     ▶ play · in 41 drum machines · sounds on strudel.cc ↗
//   note("c3")         **c3** · MIDI 48 · 130.8 Hz ▶ (on the chain's sound)
//   .scale("C:minor")  **C minor**: C D Eb F G Ab Bb ▶ (plays it up)
//   chord("Dm7")       **Dm7**: D F A C ▶
//   .bank("TR909")     its parts, ▶ plays bd on it
//
// ▶ is a markdown link to a command (PLAY_COMMAND, registered by
// ./provider.ts), trusted for that command only; clicking it is a gesture, so
// it can unlock audio. TypeScript's own hover still shows next to ours.
// Pure: no Monaco.

import type { SoundRegistry, StringContext, Theory } from "./types.ts";
import { midiToHz, midiUp, parseNote, spell } from "./notes.ts";
import { stepAt } from "./values.ts";

/** The command a hover's ▶ runs, with one PlayArg */
export const PLAY_COMMAND = "strudel.play";

/** What a ▶ plays: one sound (auditionSound) or a little pattern (previewCode) */
export type PlayArg =
  | { type: "sound"; sound: string; bank?: string; n?: number; pitched?: boolean; note?: string }
  | { type: "code"; code: string; label?: string };

export interface HoverEnv {
  registry: SoundRegistry;
  theory: Theory | null;
  /** The drum machines that have a part */
  banksWith?: (part: string) => string[];
}

export interface HoverInfo {
  /** File offsets of what the hover is about */
  range: { start: number; end: number };
  markdown: string;
}

const SAMPLES_DOC = "https://strudel.cc/learn/samples/";

/** A markdown link that runs PLAY_COMMAND with `arg` */
export function playLink(arg: PlayArg, text = "▶ play"): string {
  // parentheses too: a ")" in the code would end the link
  const args = encodeURIComponent(JSON.stringify([arg])).replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `[${text}](command:${PLAY_COMMAND}?${args})`;
}

/** The hover for the string under the mouse, or null */
export function hoverFor(ctx: StringContext, offset: number, env: HoverEnv): HoverInfo | null {
  const tok = ctx.token;
  const range = { start: tok.start, end: tok.end };
  switch (ctx.role) {
    case "sound":
      return tok.text ? soundHover(ctx, range, env) : null;
    case "bank":
      return tok.text ? bankHover(tok.text, range, env) : null;
    case "note":
      return noteHover(ctx, range, env);
    case "scale":
      return scaleHover(ctx, offset, env);
    case "chord":
      return chordHover(ctx, offset, env);
    default:
      return null;
  }
}

const theBank = (ctx: StringContext) => (ctx.banks.length ? ctx.banks[ctx.banks.length - 1] : undefined);

function soundHover(ctx: StringContext, range: HoverInfo["range"], env: HoverEnv): HoverInfo | null {
  const reg = env.registry;
  const tok = ctx.token;
  const bank = theBank(ctx);
  // "bd:3": the variant
  if (tok.before === ":") {
    if (!tok.head || !/^\d+$/.test(tok.text)) return null;
    const key = bank ? `${bank}_${tok.head}` : tok.head;
    const files = reg.variants(key);
    if (!files) return null;
    const n = Number(tok.text);
    const arg: PlayArg = { type: "sound", sound: tok.head };
    if (bank) arg.bank = bank;
    arg.n = n;
    const kind = reg.kind(key);
    const head = [`**${tok.head}:${n}**`, bank, kind, `file ${(n % files) + 1} of ${files}`].filter(Boolean).join(" · ");
    return { range, markdown: `${head}\n\n${playLink(arg)}` };
  }
  const name = tok.text;
  const key = bank ? `${bank}_${name}` : name;
  if (!reg.has(key)) return null;
  const type = reg.type(key);
  const kind = reg.kind(key);
  const pitched = reg.pitched(key);
  const files = reg.variants(key) ?? 0;
  const parts = [`**${name}**`];
  if (bank) parts.push(bank);
  if (type === "synth" || type === "wavetable") parts.push(kind && kind !== type && kind !== "synth" ? `${kind} · ${type}` : type);
  else {
    parts.push(kind ?? "sample");
    if (pitched) parts.push("pitched");
    if (files > 1) parts.push(pitched ? `${files} files` : `${files} variants (${name}:0–${name}:${files - 1})`);
  }
  const arg: PlayArg = { type: "sound", sound: name };
  if (bank) arg.bank = bank;
  if (pitched) {
    arg.pitched = true;
    if (ctx.scaleRoot) arg.note = ctx.scaleRoot;
  }
  const links = [playLink(arg)];
  const machines = bank ? 0 : (env.banksWith?.(name).length ?? 0);
  if (machines) links.push(`in ${machines} drum machine${machines === 1 ? "" : "s"}`);
  links.push(`[sounds on strudel.cc ↗](${SAMPLES_DOC})`);
  return { range, markdown: `${parts.join(" · ")}\n\n${links.join(" · ")}` };
}

function bankHover(word: string, range: HoverInfo["range"], env: HoverEnv): HoverInfo | null {
  const parts = env.registry.bankParts(word);
  if (!parts.length) return null;
  const entry = env.registry.banks().find((b) => b.name.toLowerCase() === word.toLowerCase());
  const canonical = entry?.canonical ?? word;
  const name = canonical === word ? `**${canonical}**` : `**${canonical}** (as ${word})`;
  const sound = parts.includes("bd") ? "bd" : parts[0];
  return {
    range,
    markdown: `${name} · ${parts.length} parts: ${parts.join(" ")}\n\n${playLink({ type: "sound", sound, bank: word }, `▶ ${sound}`)}`,
  };
}

/** The pitched sound a note, scale or chord plays on: the chain's, else a triangle (Strudel's default) */
function voiceOf(ctx: StringContext, env: HoverEnv): string {
  const bank = theBank(ctx);
  for (const s of ctx.soundsInChain) {
    const key = bank ? `${bank}_${s}` : s;
    if (env.registry.has(key) && env.registry.pitched(key)) return s;
  }
  return "triangle";
}

function noteHover(ctx: StringContext, range: HoverInfo["range"], env: HoverEnv): HoverInfo | null {
  const text = ctx.token.text;
  const n = parseNote(text);
  if (!n) return null;
  const line = `**${text}** · MIDI ${n.midi} · ${midiToHz(n.midi).toFixed(1)} Hz`;
  const arg: PlayArg = { type: "sound", sound: voiceOf(ctx, env), pitched: true, note: text };
  return { range, markdown: `${line}\n\n${playLink(arg)}` };
}

function scaleHover(ctx: StringContext, offset: number, env: HoverEnv): HoverInfo | null {
  const step = stepAt(ctx, offset);
  const value = ctx.value.slice(step.start - ctx.string.start - 1, step.end - ctx.string.start - 1);
  const colon = value.indexOf(":");
  if (colon < 1) return null;
  const root = value.slice(0, colon);
  const type = value.slice(colon + 1).replace(/:/g, " ");
  const scale = env.theory?.scales.find((s) => s.name === type);
  if (!scale || !parseNote(root)) return null;
  const notes = spell(root, scale.intervals);
  const up = midiUp(root, scale.intervals);
  up.push(up[0] + 12);
  const label = `${root} ${type}`;
  const code = `note("${up.join(" ")}").s("${voiceOf(ctx, env)}")`;
  return { range: { start: step.start, end: step.end }, markdown: `**${label}**: ${notes.join(" ")}\n\n${playLink({ type: "code", code, label })}` };
}

function chordHover(ctx: StringContext, offset: number, env: HoverEnv): HoverInfo | null {
  const step = stepAt(ctx, offset);
  const value = ctx.value.slice(step.start - ctx.string.start - 1, step.end - ctx.string.start - 1);
  const m = /^([A-Ga-g][#b]?)(.*)$/.exec(value);
  if (!m) return null;
  const intervals = env.theory?.chords[m[2]];
  if (!intervals) return null;
  const root = m[1][0].toUpperCase() + m[1].slice(1);
  const code = `note("[${midiUp(root, intervals).join(",")}]").s("${voiceOf(ctx, env)}")`;
  return {
    range: { start: step.start, end: step.end },
    markdown: `**${value}**: ${spell(root, intervals).join(" ")}\n\n${playLink({ type: "code", code, label: value })}`,
  };
}
