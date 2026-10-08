// Short-lived "hit" pulses per file (pure, no vscode). Each onset frame from
// the player adds its ranges with an expiry; the editor draws what's still
// alive and redraws once more when the next one expires.

const PACK = 2 ** 22;

export class Pulses {
  /** file → packed range → expiry (ms) */
  private live = new Map<string, Map<number, number>>();
  /** file → content version the offsets refer to */
  private versions = new Map<string, string | undefined>();

  readonly ttl: number;
  constructor(ttl = 140) {
    this.ttl = ttl;
  }

  add(file: string, ranges: unknown, version: string | undefined, now: number): boolean {
    if (!Array.isArray(ranges)) return false;
    let m = this.live.get(file);
    if (this.versions.get(file) !== version) {
      m?.clear(); // offsets of another version of the file
      this.versions.set(file, version);
    }
    let added = false;
    for (const r of ranges) {
      if (!Array.isArray(r) || typeof r[0] !== "number" || typeof r[1] !== "number") continue;
      const [a, b] = r;
      if (!(b > a) || a < 0 || b >= PACK) continue;
      if (!m) this.live.set(file, (m = new Map()));
      m.set(Math.floor(a) * PACK + Math.floor(b), now + this.ttl);
      added = true;
    }
    return added;
  }

  /** Live ranges of `file` (expired ones are dropped) */
  active(file: string, now: number): [number, number][] {
    const m = this.live.get(file);
    if (!m) return [];
    const out: [number, number][] = [];
    for (const [k, until] of m) {
      if (until <= now) m.delete(k);
      else out.push([Math.floor(k / PACK), k % PACK]);
    }
    if (!m.size) this.live.delete(file);
    return out;
  }

  version(file: string): string | undefined {
    return this.versions.get(file);
  }

  /** Earliest expiry across all files, or null */
  nextExpiry(): number | null {
    let next: number | null = null;
    for (const m of this.live.values()) for (const until of m.values()) if (next === null || until < next) next = until;
    return next;
  }

  files(): string[] {
    return [...this.live.keys()];
  }

  /** Drop everything; returns the files that had pulses */
  clear(): string[] {
    const files = this.files();
    this.live.clear();
    return files;
  }
}
