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
//                                    (at a cold start warmOrbits() in strudel.ts
//                                    has created the busses before the first note)
//   value.duckorbit removed       → a muted kick stops pumping the pads
//   context.locations removed     → its tokens don't light up (browser + editor)
// Nothing is filtered out, so mute/solo is a plain hot-swap: no restart, and
// the scheduler's timing is untouched.

import { internals, remakeHap, type Hap } from "./strudel";

/**
 * What a track plays, guessed from its name. The role picks the track's colour
 * (knob caps, keys, meter LEDs, pianoroll, lit code) and which lamp in the
 * stage's room it drives (src/ui/room.ts).
 */
export type TrackRole = "kick" | "snare" | "hats" | "perc" | "bass" | "pads" | "arp" | "lead" | "acid" | "fx" | "other";

const ROLE_PATTERNS: [TrackRole, RegExp][] = [
  ["kick", /kick|^bd|909|808k|pulse/i],
  ["snare", /snare|^sd|clap|^cp|rim/i],
  ["hats", /hat|^hh|^oh|ride|cymbal|shaker|ghost/i],
  ["perc", /perc|tom|crash|fill|conga|bongo|clave|cowbell|break/i],
  ["acid", /acid|303/i],
  ["bass", /bass|sub|rumble|reese|wobble|low/i],
  ["pads", /pad|chord|key|string|choir|organ|piano|rhodes|drone|atmos|stab/i],
  ["arp", /arp|pluck|seq|bell|harp|loop|pebble/i],
  ["lead", /lead|melody|vox|vocal|hook|voice|tune/i],
  ["fx", /fx|riser|sweep|noise|vinyl|rain|shore|hiss|texture|impact/i],
];

export function trackRole(name: string): TrackRole {
  return ROLE_PATTERNS.find(([, re]) => re.test(name))?.[0] ?? "other";
}

/** Stage palette (src/ui/stage.css): ember drums, cobalt bass, lilac pads, teal arp, cream lead */
const ROLE_COLORS: Record<TrackRole, string | null> = {
  kick: "#ff6a2b", // ember
  snare: "#ff8a52", // ember, a step lighter
  hats: "#ffa877", // ember, lighter still
  perc: "#e8582a", // ember, deeper
  bass: "#3f6bff", // cobalt
  pads: "#9c82f2", // lilac
  arp: "#1db89f", // teal
  lead: "#f1ece1", // cream
  acid: "#b9f03a", // acid
  fx: "#f0729a", // rose
  other: null,
};

/** For tracks whose name says nothing about them, in order */
const SPARE_COLORS = ["#1db89f", "#9c82f2", "#f1ece1", "#3f6bff", "#f0729a", "#ff6a2b"];

const MUTED_COLOR = "#3a3a3e";

export const trackColor = (name: string, index: number) =>
  ROLE_COLORS[trackRole(name)] ?? SPARE_COLORS[index % SPARE_COLORS.length];

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
  return stack(...parts.map(([name, p], i) => decorate(p, name, trackColor(name, i), !isAudible(name))));
}
