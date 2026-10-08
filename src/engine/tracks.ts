// ═══════════════════════════════════════════════════════════════════════════
// Per-track decoration: activity tags, colours, seamless muting
// ═══════════════════════════════════════════════════════════════════════════
//
// Each named track's haps get
//   context.track = name          → mixer LEDs, code-view colours
//   value.color   = track colour  → pianoroll (unless the song set its own)
// and a muted track's haps become rests that still reach superdough:
//   value.s = "~"                 → superdough returns before making sound, but
//                                    only *after* getOrbit(), so the orbit stays
//                                    alive and `duckorbit` on other tracks never
//                                    hits "duck target orbit N does not exist"
//   value.duckorbit removed       → a muted kick stops pumping the pads
//   context.locations removed     → its tokens don't light up (browser + editor)
// Nothing is filtered out, so mute/solo is a plain hot-swap: no restart, and
// the scheduler's timing is untouched.

import { internals, remakeHap, type Hap } from "./strudel";

/** Neon palette, assigned to tracks in order */
export const TRACK_COLORS = [
  "#05d9e8", // cyan
  "#ff2a6d", // hot pink
  "#b967ff", // violet
  "#ffb347", // amber
  "#3dffc4", // mint
  "#ff57e3", // magenta
  "#4d9fff", // sky
  "#f5f56b", // lemon
  "#ff7a59", // coral
  "#d6a6ff", // lilac
  "#00c2a8", // teal
  "#ff9ec7", // rose
];

const MUTED_COLOR = "#3a2f5a";

export const trackColor = (index: number) => TRACK_COLORS[index % TRACK_COLORS.length];

function decorate(pattern: Pattern, track: string, color: string, muted: boolean): Pattern {
  return internals(pattern).withHap((hap: Hap) => {
    let value = hap.value;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      if (muted) {
        value = { ...value, s: "~", color: MUTED_COLOR };
        delete value.duckorbit;
      } else if (value.color === undefined) {
        value = { ...value, color };
      }
    }
    const context = muted
      ? { ...hap.context, track, muted: true, locations: undefined }
      : { ...hap.context, track };
    return remakeHap(hap, value, context);
  });
}

/** Stack named tracks, decorated for the current mix */
export function composeTracks(
  parts: readonly [string, Pattern][],
  isAudible: (track: string) => boolean
): Pattern {
  return stack(...parts.map(([name, p], i) => decorate(p, name, trackColor(i), !isAudible(name))));
}
