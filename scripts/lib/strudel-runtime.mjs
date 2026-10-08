// Loads the Strudel runtime in Node and describes what it exposes:
//   - the globals initStrudel() registers (evalScope of core, mini, tonal, webaudio + hush/evaluate)
//   - every method on Pattern.prototype (core + controls + tonal + draw + webaudio)
//
// Shared by scripts/audit-types.mjs and scripts/gen-strudel-types.mjs so both see
// exactly the same runtime surface.

import * as core from "@strudel/core";
import * as mini from "@strudel/mini";
import * as tonal from "@strudel/tonal";
import * as webaudio from "@strudel/webaudio";
// @strudel/draw is not part of evalScope, but webaudio imports it and it adds
// Pattern.prototype.pianoroll/punchcard/spiral/... as a side effect.
import "@strudel/draw";

const { Pattern, isControlName } = core;

/** Modules in the order @strudel/web's defaultPrebake() passes them to evalScope (later wins). */
export const SCOPE_MODULES = [
  ["@strudel/core", core],
  ["@strudel/mini", mini],
  ["@strudel/tonal", tonal],
  ["@strudel/webaudio", webaudio],
  // web.mjs adds { hush, evaluate } last
  ["@strudel/web", { hush() {}, evaluate() {} }],
];

/** Globals that are only defined for the browser app (initStrudel is put on window by @strudel/web). */
export const EXTRA_GLOBALS = { initStrudel: "@strudel/web" };

const isClass = (fn) =>
  typeof fn === "function" && /^class[\s{]/.test(Function.prototype.toString.call(fn));

/**
 * Find the arity of a function produced by core's curry(): calling it with fewer
 * args than its arity returns a function named "partial" without running anything.
 */
function curriedArity(fn) {
  for (let k = 1; k <= 8; k++) {
    let result;
    try {
      result = fn(...Array.from({ length: k }, () => core.pure(0)));
    } catch {
      return k; // it ran (and choked on our dummy args) → k args was enough
    }
    if (!(typeof result === "function" && result.name === "partial")) return k;
  }
  return undefined;
}

function describeValue(name, value) {
  if (value instanceof Pattern) return { kind: "pattern" };
  if (typeof value === "function") {
    if (isClass(value)) return { kind: "class" };
    if (isControlName(name)) return { kind: "control" };
    if (value.name === "curried") return { kind: "curried", arity: curriedArity(value) };
    return { kind: "function", arity: value.length };
  }
  return { kind: typeof value };
}

/** @returns {Map<string, {name, module, kind, arity?}>} */
export function runtimeGlobals() {
  const globals = new Map();
  for (const [module, exports] of SCOPE_MODULES) {
    for (const [name, value] of Object.entries(exports)) {
      globals.set(name, { name, module, ...describeValue(name, value) });
    }
  }
  for (const [name, module] of Object.entries(EXTRA_GLOBALS)) {
    globals.set(name, { name, module, kind: "function" });
  }
  return globals;
}

/** @returns {Map<string, {name, kind, arity?}>} Pattern.prototype members (excluding constructor). */
export function runtimePatternMethods() {
  const globals = runtimeGlobals();
  const methods = new Map();
  const proto = Pattern.prototype;
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === "constructor") continue;
    const desc = Object.getOwnPropertyDescriptor(proto, name);
    if (desc.get || desc.set) {
      methods.set(name, { name, kind: "getter" });
      continue;
    }
    const fn = desc.value;
    if (typeof fn !== "function") continue;
    if (isControlName(name)) {
      methods.set(name, { name, kind: "control", arity: 1 });
      continue;
    }
    const g = globals.get(name);
    // register()'d methods have a curried global twin whose last arg is the pattern
    if (g?.kind === "curried" && g.arity !== undefined && `_${name}` in proto) {
      methods.set(name, { name, kind: "registered", arity: g.arity - 1 });
    } else if (fn.length === 0 && `_${name}` in proto) {
      methods.set(name, { name, kind: "registered" });
    } else {
      methods.set(name, { name, kind: "method", arity: fn.length });
    }
  }
  return methods;
}

export { core, mini, tonal, webaudio, Pattern };
