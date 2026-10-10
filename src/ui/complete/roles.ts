// ═══════════════════════════════════════════════════════════════════════════
// What a call says about its string arguments (pure)
// ═══════════════════════════════════════════════════════════════════════════
//
// A role-giving call decides what its string holds: s("bd hh") names sounds,
// .scale("C:minor") a scale. A carrier (mini, seq, cat, stack, …) just turns
// strings into a pattern, so its strings mean whatever the chain does with
// them later: mini("c e g").note() holds notes. The first argument-less
// role-giving method after the carrier decides (one with an argument sets
// that control to its own value and says nothing about the carrier's string).

import type { Role } from "./types.ts";

/** The calls whose string arguments have a known role (as functions or methods) */
export const ROLE_OF: Readonly<Record<string, Role>> = {
  s: "sound",
  sound: "sound",
  bank: "bank",
  note: "note",
  n: "number",
  scale: "scale",
  chord: "chord",
  dict: "voicingDict",
  voicings: "voicingDict",
  vowel: "vowel",
  struct: "struct",
  mask: "struct",
  arp: "number",
  anchor: "note",
};

/** Calls that just carry a pattern along: their role comes from the chain after them */
export const CARRIERS: ReadonlySet<string> = new Set(["mini", "m", "seq", "sequence", "cat", "fastcat", "slowcat", "stack", "h", "pure"]);

/** The role a call gives its string arguments, if it gives one */
export function roleOf(name: string): Role | undefined {
  return Object.prototype.hasOwnProperty.call(ROLE_OF, name) ? ROLE_OF[name] : undefined;
}

export function isCarrier(name: string): boolean {
  return CARRIERS.has(name);
}

/** A call in a chain, as far as roles care */
export interface RoleCall {
  name: string;
  method: boolean;
  /** Called with no arguments: `.note()` */
  empty: boolean;
}

const show = (c: RoleCall) => `${c.method ? "." : ""}${c.name}`;

/**
 * The role of a string argument of `chain[at]`, and what decided it
 * ("s(…)", "mini(…).note()"). Anything else is plain mini-notation.
 */
export function resolveRole(chain: readonly RoleCall[], at: number): { role: Role; roleFrom: string } {
  const call = chain[at];
  const own = roleOf(call.name);
  if (own) return { role: own, roleFrom: `${show(call)}(…)` };
  if (isCarrier(call.name)) {
    for (let i = at + 1; i < chain.length; i++) {
      const next = chain[i];
      const role = next.empty ? roleOf(next.name) : undefined;
      if (role) return { role, roleFrom: `${show(call)}(…)${show(next)}()` };
    }
  }
  return { role: "mini", roleFrom: `${show(call)}(…)` };
}
