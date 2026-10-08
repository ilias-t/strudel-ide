// Knobs in the editor (pure, no vscode): inline value hints after each
// knob(…) call, stepping a value, and writing values into the buffer.

import { formatKnob, knobPosition, knobValueAt, snapKnob } from "../../src/engine/knobs.ts";
import { findKnobCalls, type KnobCall } from "../../src/live/knob-calls.ts";
import type { KnobState } from "../../src/live/protocol.ts";

export { findKnobCalls, type KnobCall };

export interface KnobHint {
  name: string;
  /** Where the hint goes: just past the call's closing paren */
  offset: number;
  /** "◉ 2200" */
  text: string;
  dirty: boolean;
  /** Hover text */
  title: string;
}

export function formatValue(k: KnobState, value = k.value): string {
  return formatKnob(k, value);
}

/** A hint per knob(…) call whose knob the player reports */
export function knobHints(calls: readonly KnobCall[], knobs: readonly KnobState[]): KnobHint[] {
  const byName = new Map(knobs.map((k) => [k.name, k]));
  const hints: KnobHint[] = [];
  for (const call of calls) {
    const k = byName.get(call.name);
    if (!k) continue;
    const value = formatValue(k);
    hints.push({
      name: k.name,
      offset: call.end,
      text: `◉ ${value}`,
      dirty: k.dirty,
      title: k.dirty
        ? `${k.name} = ${value} (the code says ${formatValue(k, k.def)}): Strudel: Adjust Knob… or the "write" lens puts it in the code`
        : `${k.name} = ${value} (${formatValue(k, k.min)}–${formatValue(k, k.max)})`,
    });
  }
  return hints;
}

/** Names of the dirty knobs, as a stable key (CodeLens only refresh when it changes) */
export function dirtyKey(knobs: readonly KnobState[]): string {
  return knobs
    .filter((k) => k.dirty)
    .map((k) => k.name)
    .join("\u0000");
}

/**
 * The value `steps` steps away: fine steps are the knob's own step, coarse
 * ones 5% of its travel (log knobs travel in ratios), snapped like the player.
 */
export function stepKnob(k: KnobState, steps: number, coarse = false): number {
  if (!coarse) return snapKnob(k, k.value + steps * k.step);
  const p = knobPosition(k, k.value) + steps * 0.05;
  let v = snapKnob(k, knobValueAt(k, p));
  // a coarse step must move at least one fine step
  if (v === k.value && steps !== 0) v = snapKnob(k, k.value + Math.sign(steps) * k.step);
  return v;
}

/** Parse what the user typed; an error message when it's not a number in range */
export function parseKnobInput(k: KnobState, input: string): { value: number } | { error: string } {
  const v = Number(input.trim());
  if (!input.trim() || !Number.isFinite(v)) return { error: "Type a number" };
  if (v < k.min || v > k.max) return { error: `Between ${formatValue(k, k.min)} and ${formatValue(k, k.max)}` };
  return { value: snapKnob(k, v) };
}

/** The source text for a number (as the dev server writes it): the shortest literal for `value` */
export function numberLiteral(value: number): string {
  return String(Object.is(value, -0) ? 0 : value);
}

export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

/**
 * Edits that write `value` into every knob("<name>", <literal>, …) call of
 * `text`, or an error (no call, or a value that isn't a number literal).
 */
export function knobValueEdits(text: string, name: string, value: number): { edits: TextEdit[] } | { error: string } {
  const calls = findKnobCalls(text).filter((c) => c.name === name);
  if (!calls.length) return { error: `No knob("${name}", …) call in this file` };
  const bad = calls.find((c) => !c.value);
  if (bad) return { error: `knob("${name}", …): its value isn't a number literal, so it can't be written` };
  const literal = numberLiteral(value);
  return { edits: calls.map((c) => ({ start: c.value!.start, end: c.value!.end, text: literal })) };
}
