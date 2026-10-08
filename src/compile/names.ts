// ═══════════════════════════════════════════════════════════════════════════
// Strudel names: which calls take mini-notation strings (shared transform code)
// ═══════════════════════════════════════════════════════════════════════════
//
// Used by the locations transform (./locations.ts) in both places it runs:
// the Vite plugin (vite-plugins/strudel-locations.ts, Node) and the browser
// compiler (./worker.ts). Both call strudelNamesFrom() on the same installed
// @strudel/core|mini|tonal packages, so the sets can't drift apart.
//
// Pure: no imports, no globals. Node type stripping loads this file as is.
// ═══════════════════════════════════════════════════════════════════════════

/** Pattern constructors that are exported but are not Pattern methods */
export const EXTRA_FUNCTIONS = [
  "arrange", "polymeter", "polyrhythm", "pr", "randcat", "wrandcat", "timeCat", "timecat",
  "chooseCycles", "stepcat", "stepalt", "s_cat", "s_alt", "s_polymeter",
  "stackLeft", "stackRight", "stackCentre", "stackBy", "reify",
];

/** Never rewrite arguments of these bare calls */
export const FUNCTION_DENY = new Set([
  "require", "fetch", "register", "samples", "pure", "evalScope", "setStringParser",
  "aliasBank", "soundAlias", "initStrudel", "String", "Number", "Boolean", "Symbol",
  "parseInt", "parseFloat", "alert", "setTimeout", "setInterval", "m", "h",
  // its args must stay strings; literal-only mini(...) calls are handled in transformLocations
  "mini",
]);

/** Never rewrite arguments of these methods, even though Pattern has them */
export const METHOD_DENY = new Set([
  // builtin collisions that take plain strings / no strings
  "constructor", "bind", "call", "apply", "join", "toString", "valueOf", "toJSON",
  "split", "concat", "includes", "indexOf", "lastIndexOf", "startsWith", "endsWith",
  "replace", "replaceAll", "match", "matchAll", "search", "padStart", "padEnd",
  "localeCompare", "normalize", "trim", "at", "charAt", "get", "has", "delete", "push",
  // strudel methods that want plain strings (ids, css, labels)
  "p", "q", "log", "logValues", "onTrigger", "markcss", "describe",
]);

/** Never rewrite arguments of methods called on these globals */
export const RECEIVER_DENY = new Set([
  "console", "JSON", "Math", "Object", "Array", "String", "Number", "Reflect", "Promise",
  "document", "window", "globalThis", "self", "localStorage", "sessionStorage",
  "performance", "navigator", "crypto", "Intl", "Date", "Symbol", "URL", "Map", "Set",
  "location", "history", "process", "import",
]);

export interface StrudelNames {
  /** bare function names whose string args are rewritten */
  functions: Set<string>;
  /** method names whose string args are rewritten */
  methods: Set<string>;
  /** returns true if `"${raw}"` parses as mini notation */
  parses(raw: string): boolean;
}

/** The three strudel packages the names are introspected from */
export interface StrudelModules {
  core: { Pattern: { prototype: object } } & Record<string, unknown>;
  mini: { mini2ast(code: string): unknown } & Record<string, unknown>;
  tonal: Record<string, unknown>;
}

/**
 * The name sets from the imported packages. Import all three before calling:
 * tonal registers its methods (voicing, scale, …) on core's Pattern.prototype.
 */
export function strudelNamesFrom({ core, mini, tonal }: StrudelModules): StrudelNames {
  const methods = new Set<string>();
  for (let p: object | null = core.Pattern.prototype; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    for (const k of Object.getOwnPropertyNames(p)) {
      const d = Object.getOwnPropertyDescriptor(p, k);
      // operators like add/sub/set are getters returning a function (with .in/.out/…)
      if ((typeof d?.value === "function" || d?.get) && !METHOD_DENY.has(k)) methods.add(k);
    }
  }
  const functions = new Set<string>(EXTRA_FUNCTIONS);
  for (const mod of [core, mini, tonal]) {
    for (const [k, v] of Object.entries(mod)) {
      if (typeof v === "function" && methods.has(k)) functions.add(k);
    }
  }
  for (const k of FUNCTION_DENY) functions.delete(k);
  const parses = (raw: string) => {
    try {
      mini.mini2ast(`"${raw}"`);
      return true;
    } catch {
      return false;
    }
  };
  return { functions, methods, parses };
}
