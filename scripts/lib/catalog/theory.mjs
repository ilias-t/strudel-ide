// theory.json: scales (with intervals), chord symbols, vowels and voicing dictionaries, for the
// editor's string completions and hovers (Theory in src/ui/complete/types.ts).
// Skeleton: filled from @strudel/tonal / tonal and superdough's vowels.

/** @returns {{ scales: { name: string, intervals: string[], common?: true }[], chords: Record<string, string[]>, vowels: string[], voicingDicts: string[] }} */
export function buildTheory() {
  return { scales: [], chords: {}, vowels: [], voicingDicts: [] };
}
