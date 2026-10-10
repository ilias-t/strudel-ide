// ═══════════════════════════════════════════════════════════════════════════
// The audition bus: auditions play on an orbit of their own (./audition.ts)
// ═══════════════════════════════════════════════════════════════════════════
//
// Superdough's orbit effects (the DJ filter, delay, reverb) are per orbit and
// shared by every sound on it, and they stay set: a `djf` example auditioned
// on the song's orbit would filter the playing song, and go on filtering it
// after the audition ended. So every audition value is moved to one orbit no
// song uses, never ducks another orbit, and (once an audition used the DJ
// filter) sets it back to neutral when it doesn't ask for one.
//
// Pure: no engine imports, so it runs in Node tests.

/** Beyond the orbits songs use (1–6 today) and the ones the stage warms (1–16) */
export const AUDITION_ORBIT = 64;

/** The DJ filter's neutral value (no filtering) */
const DJF_OFF = 0.5;

export class AuditionBus {
  /** An audition set the bus's DJ filter: later ones reset it */
  private djf = false;

  /** A copy of `value` for the audition bus */
  route(value: Record<string, unknown>): Record<string, unknown> {
    const v: Record<string, unknown> = { ...value, orbit: AUDITION_ORBIT };
    delete v.duckorbit;
    if (v.djf != null) this.djf = true;
    else if (this.djf) v.djf = DJF_OFF;
    return v;
  }
}
