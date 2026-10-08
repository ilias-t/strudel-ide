// Which sounds exist, the way scripts/check-songs.mjs decides it (that script stays self-contained;
// keep the two in step): every sample-map key and synth, lowercased, plus "<alias>_<part>" for
// each short bank alias. A hap's key is "<bank>_<s>" when it has a bank, else its s.

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

/** The sound a hap plays (null for non-sound values); a note without s plays the default triangle */
export function soundKey(value) {
  if (!value || typeof value !== "object") return null;
  let s = value.s;
  if (s === undefined) return value.note !== undefined || value.n !== undefined || value.freq !== undefined ? "triangle" : null;
  s = String(s).split(":")[0];
  return (value.bank ? `${value.bank}_${s}` : s).toLowerCase();
}
