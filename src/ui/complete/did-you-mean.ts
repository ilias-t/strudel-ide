// ═══════════════════════════════════════════════════════════════════════════
// "Did you mean …?" for unknown sounds, banks and scales (pure)
// ═══════════════════════════════════════════════════════════════════════════
//
// Optimal string alignment distance (Damerau–Levenshtein with adjacent swaps,
// each substring edited once), case-insensitive. A guess must be close: at
// most a third of the word's length in edits (at least one), so "bdd" → "bd"
// and "RolandTR90" → "RolandTR909", while "xylophone" gets nothing.
// Candidates whose length is too far off are skipped before any work, which
// keeps a call over the ~1500 live sound keys well under a millisecond.

/** Edits between `a` and `b` (insert, delete, substitute, swap two neighbours), ignoring case */
export function distance(a: string, b: string, limit = Infinity): number {
  a = a.toLowerCase();
  b = b.toLowerCase();
  const n = a.length;
  const m = b.length;
  if (Math.abs(n - m) > limit) return Math.abs(n - m);
  if (!n) return m;
  if (!m) return n;
  let prev2 = new Array<number>(m + 1).fill(0);
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  let cur = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    let rowMin = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      const cb = b.charCodeAt(j - 1);
      let d = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca === cb ? 0 : 1));
      if (i > 1 && j > 1 && ca === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === cb) d = Math.min(d, prev2[j - 2] + 1);
      cur[j] = d;
      if (d < rowMin) rowMin = d;
    }
    if (rowMin > limit) return rowMin; // can only grow from here
    [prev2, prev, cur] = [prev, cur, prev2];
  }
  return prev[m];
}

/** How many edits a guess for `word` may be away */
export const threshold = (word: string) => Math.max(1, Math.floor(word.length / 3));

/**
 * Up to `n` candidates close to `word`, closest first. Ties go to the lower
 * `rank` (a preference such as "same kind as its neighbours"), then to the
 * caller's order.
 */
export function didYouMean(word: string, candidates: readonly string[], n = 3, rank?: (candidate: string) => number): string[] {
  const max = threshold(word);
  const hits: { c: string; d: number; r: number; i: number }[] = [];
  const w = word.toLowerCase();
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (Math.abs(c.length - word.length) > max) continue;
    const d = distance(w, c, max);
    if (d > max) continue;
    hits.push({ c, d, r: rank ? rank(c) : 0, i });
  }
  hits.sort((a, b) => a.d - b.d || a.r - b.r || a.i - b.i);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const h of hits) {
    const k = h.c.toLowerCase();
    if (k === w || seen.has(k)) continue; // the word itself (another case) is no suggestion
    seen.add(k);
    out.push(h.c);
    if (out.length >= n) break;
  }
  return out;
}
