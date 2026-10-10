// strudel.cc links for completions.json / functions.json `docUrl`, from the committed heading
// snapshot (scripts/lib/catalog/strudel-docs.json, refreshed by hand: node scripts/fetch-strudel-docs.mjs),
// never a guessed URL. Pure.
//
// strudel.cc has no per-function reference: functions are headings on topical pages. A heading
// documents a function when its text names it as code: "lpf", "swingBy", "scale(name)",
// "clip / legato", "control, ccn && ccv" (headingNames). Section headings are prose ("Delay",
// "Shape" on the LFO page, "Note" on the mini-notation page), so for a name:
//   1. DOC_OVERRIDES: a curated anchor for a core function strudel.cc only explains in a section
//      (each one must exist in the snapshot, or the build fails)
//   2. an exact, case-sensitive heading anywhere ("delay" → #delay-1, not the "Delay" section)
//   3. a case-insensitive heading on one of its category's pages ("Scope" on visual-feedback)
//   4. the same for a synonym (every → firstOf's heading)
//   5. its category's page (CATEGORY_PAGES), without an anchor
//   6. nothing (internal, other)
// Several matches: the category's pages first (in CATEGORY_PAGES order), then path order, then
// page order. An alias always links where its target does.

/** Pages documenting each category, the first being its fallback page */
export const CATEGORY_PAGES = {
  time: ["/learn/time-modifiers/", "/learn/stepwise/", "/learn/conditional-modifiers/", "/learn/factories/"],
  structure: ["/learn/factories/", "/learn/stepwise/", "/learn/conditional-modifiers/", "/learn/accumulation/"],
  transform: ["/learn/conditional-modifiers/", "/learn/accumulation/", "/learn/effects/"],
  pitch: ["/learn/tonal/", "/understand/voicings/", "/understand/pitch/", "/learn/xen/", "/workshop/first-notes/"],
  sound: ["/learn/samples/", "/workshop/first-sounds/"],
  synthesis: ["/learn/synths/"],
  effects: ["/learn/effects/"],
  envelope: ["/learn/effects/", "/learn/synths/"],
  dynamics: ["/learn/effects/"],
  modulation: ["/learn/effects/", "/learn/synths/"],
  randomness: ["/learn/random-modifiers/", "/learn/signals/"],
  signals: ["/learn/signals/", "/functions/value-modifiers/"],
  math: ["/functions/value-modifiers/"],
  visual: ["/learn/visual-feedback/"],
  io: ["/learn/input-output/"],
};

/** Core functions strudel.cc explains in a section rather than under their own heading */
export const DOC_OVERRIDES = {
  s: "/workshop/first-sounds/#sounds",
  n: "/learn/samples/#selecting-sounds", // "we can select the other ones using n" (voicings' #n is the voicing index)
  note: "/workshop/first-notes/#numbers-and-notes",
  bank: "/learn/samples/#sound-banks",
  chord: "/understand/voicings/#chord-symbols",
  shape: "/learn/effects/#waveshaping",
};

/** CORE names (ranking.mjs) with no heading or section on strudel.cc, so a page only (none today: DOC_OVERRIDES covers them) */
export const NO_ANCHOR = [];

/** The function names a heading's text gives as code ([] for prose) */
export function headingNames(text) {
  const plain = text
    .replace(/\([^()]*\)/g, " ") // arguments and asides: scale(name), progNum (Program Change)
    .replace(/[^\x20-\x7e]/g, " ") // emoji: arpWith 🧪
    .replace(/\bPattern\./g, "");
  const parts = plain.split(/,|&&|&|\//).map((p) => p.trim());
  return parts.every((p) => /^[A-Za-z_$][\w$]*$/.test(p)) ? parts : [];
}

/**
 * @param {{ name: string, category: string, aliasOf?: string, synonyms: string[] }[]} functions
 * @param {{ base: string, pages: Record<string, { title: string, headings: { id: string, level: number, text: string }[] }> }} snapshot
 * @param {{ overrides?: Record<string, string> }} [options]
 * @returns {Record<string, string>} name → URL, for the names that have one
 */
export function docUrls(functions, snapshot, { overrides = DOC_OVERRIDES } = {}) {
  const paths = Object.keys(snapshot.pages);
  const inSnapshot = (url) => {
    const [path, anchor] = url.split("#");
    const page = snapshot.pages[path];
    return !!page && (!anchor || page.headings.some((h) => h.id === anchor));
  };
  for (const [name, url] of Object.entries(overrides)) if (!inSnapshot(url)) throw new Error(`doc-links: ${name} → ${url} is not in the snapshot`);
  // a category page the snapshot lacks is skipped (test/catalog-data.test.mjs checks the real one has them all)
  const categoryPages = Object.fromEntries(Object.entries(CATEGORY_PAGES).map(([c, pages]) => [c, pages.filter((p) => snapshot.pages[p])]));

  /** name → [{ path, id, exact }] for every heading naming it (exact: same case) */
  const headings = new Map();
  for (const path of paths) {
    for (const h of snapshot.pages[path].headings) {
      for (const n of headingNames(h.text)) {
        const key = n.toLowerCase();
        if (!headings.has(key)) headings.set(key, []);
        headings.get(key).push({ path, id: h.id, text: n });
      }
    }
  }

  const byName = new Map(functions.map((f) => [f.name, f]));
  /** The best heading for `name`, read on `category`'s pages */
  const headingFor = (name, category) => {
    const prefer = categoryPages[category] ?? [];
    const order = (h) => [prefer.includes(h.path) ? prefer.indexOf(h.path) : prefer.length, paths.indexOf(h.path)];
    const found = (headings.get(name.toLowerCase()) ?? []).filter((h) => h.text === name || prefer.includes(h.path));
    found.sort((a, b) => {
      const exact = Number(b.text === name) - Number(a.text === name);
      if (exact) return exact;
      const [pa, ia] = order(a);
      const [pb, ib] = order(b);
      return pa - pb || ia - ib;
    });
    return found[0] && `${found[0].path}#${found[0].id}`;
  };
  const own = (fn) => {
    if (overrides[fn.name]) return overrides[fn.name];
    const direct = headingFor(fn.name, fn.category);
    if (direct) return direct;
    for (const s of fn.synonyms ?? []) {
      const viaSynonym = headingFor(s, fn.category);
      if (viaSynonym) return viaSynonym;
    }
    return categoryPages[fn.category]?.[0];
  };
  const target = (fn, seen = new Set([fn.name])) => {
    const to = fn.aliasOf && byName.get(fn.aliasOf);
    return to && !seen.has(to.name) ? target(to, seen.add(to.name)) : fn;
  };

  const out = {};
  for (const fn of functions) {
    const path = own(target(fn));
    if (path) out[fn.name] = snapshot.base + path;
  }
  return out;
}
