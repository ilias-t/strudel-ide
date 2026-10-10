// Which sounds exist: one rule, two inputs.
//   knownSounds(inputs)              from the raw inputs (sample maps, bank aliases, synths): the
//                                    generator's view, used to build and test sounds.json
//   knownSoundsFromCatalog(sounds)   from the generated src/catalog/sounds.json: what check-songs reads,
//                                    so it can't drift from the catalog (and the stage registers the same
//                                    set: e2e/sound-registry.spec.ts)
// A key is a lowercased sound name, or "<bank>_<part>" (also for each short bank alias). A hap's key
// is "<bank>_<s>" when it has a bank, else its s (soundKey).

/** @param {{ maps: Record<string, Record<string, unknown>>, aliasMap: Record<string, string | string[]>, synths: string[] }} input */
export function knownSounds({ maps, aliasMap, synths }) {
  const known = new Set(synths.map((s) => s.toLowerCase()));
  for (const map of Object.values(maps)) {
    for (const key of Object.keys(map)) if (key !== "_base") known.add(key.toLowerCase());
  }
  for (const key of [...known]) {
    const [bank, suffix] = key.split("_");
    if (!suffix) continue;
    for (const [long, short] of Object.entries(aliasMap)) {
      if (long.toLowerCase() !== bank) continue;
      for (const s of [short].flat()) known.add(`${s}_${suffix}`.toLowerCase());
    }
  }
  return known;
}

/**
 * The same set from sounds.json: every sound that plays without a bank (it has files, or it's
 * superdough's), and every bank part under the bank's name and each alias.
 * @param {{ sounds: Record<string, { source?: string, count?: number }>, banks: Record<string, { aliases: string[], parts: string[] }> }} catalog
 */
export function knownSoundsFromCatalog({ sounds, banks }) {
  const known = new Set();
  for (const [name, info] of Object.entries(sounds)) {
    if (info.count !== undefined || info.source === "superdough") known.add(name.toLowerCase());
  }
  for (const [bank, info] of Object.entries(banks)) {
    for (const b of [bank, ...info.aliases]) for (const part of info.parts) known.add(`${b}_${part}`.toLowerCase());
  }
  return known;
}

/** The sound a hap plays (null for non-sound values); a note without s plays the default triangle */
export function soundKey(value) {
  if (!value || typeof value !== "object") return null;
  let s = value.s;
  if (s === undefined) return value.note !== undefined || value.n !== undefined || value.freq !== undefined ? "triangle" : null;
  s = String(s).split(":")[0];
  return (value.bank ? `${value.bank}_${s}` : s).toLowerCase();
}
