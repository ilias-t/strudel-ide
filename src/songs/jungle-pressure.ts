// ═══════════════════════════════════════════════════════════════════════════
// 🎵 JUNGLE PRESSURE
// ═══════════════════════════════════════════════════════════════════════════
//
// Jungle / drum & bass at 172 BPM in F minor.
//
// There's no amen break loaded, so the break is *built* from E-mu SP-12 hits
// (the 12-bit sampler half of the early jungle records were made on), then
// "chopped" with Strudel's pattern transforms: iter, within, ply, chunk, rev.
//
// Arrangement (bars):
//   intro 16 → build 8 → DROP 32 → breakdown 16 → build 8 → DROP 2 32 → outro 16
//
// Things worth tweaking while it plays:
//   • KEY: retunes everything (all melodic parts are scale degrees)
//   • BARS: section lengths (keep them multiples of 8 so the chords line up)
//   • KICK_N / SNARE_N / GHOST_N: flip through the SP-12's 14 kicks and 21 snares
//   • chops(): how the break gets cut up
//   • WOBBLE: how fast the drop-2 reese wobbles
//
// ═══════════════════════════════════════════════════════════════════════════

import type { Song } from ".";

// ─────────────────────────────────────────────────────────────────────────────
// 🎛️ KNOBS
// ─────────────────────────────────────────────────────────────────────────────

const BPM = 172;
const BEAT = 60 / BPM; // one quarter note in seconds (delaytime is in seconds)

const KEY = "F"; // try "E" or "G" — everything follows

// Section lengths in bars (1 cycle = 1 bar)
const BARS = {
  intro: 16,
  build: 8,
  drop: 32,
  breakdown: 16,
  build2: 8,
  drop2: 32,
  outro: 16,
};
type Section = keyof typeof BARS;

const DRUMS = "EmuSP12"; // the SP-12: gritty 12-bit hits
const KICK_N = 0; // 0–13
const SNARE_N = 0; // 0–20
const GHOST_N = 4; // a different snare for the ghost notes

const WOBBLE = 2; // drop-2 reese filter wobbles per bar

// ─────────────────────────────────────────────────────────────────────────────
// 🧩 HELPERS (plain strings, so they can live outside createPattern)
// ─────────────────────────────────────────────────────────────────────────────

/** One mini-notation bar per argument, played one after another: "<[bar1] [bar2] ...>" */
const bars = (...b: string[]) => `<${b.map((bar) => `[${bar}]`).join(" ")}>`;

/** Mask that is off for the first `bar` bars of a section, then on: "<0@8 1@8>" */
const enterAt = (bar: number, len: number) => `<0@${bar} 1@${len - bar}>`;

/** Mask that is on for the first `bar` bars of a section, then off */
const exitAt = (bar: number, len: number) => `<1@${bar} 0@${len - bar}>`;

/** On for the whole section, except the last beat: the gulp of silence before a drop */
const gapBeforeDrop = (len: number) => `<1@${len - 1} [1 1 1 0]>`;

// ─────────────────────────────────────────────────────────────────────────────
// 🎼 HARMONY — i9 · VI7 · iv7 · v7 (Fm9 · Dbmaj7 · Bbm7 · Cm7), 2 bars each
// Everything is written as scale degrees and turned into notes with .scale(),
// so the KEY knob moves the whole tune.
// ─────────────────────────────────────────────────────────────────────────────

// Chord roots: degree 0 = F, 5 = Db, 3 = Bb, 4 = C
const ROOTS = "<0 5 3 4>";

// Close-voiced, rootless chords (the bass plays the roots). Shared notes
// (Ab, C) between neighbours keep the voice leading smooth.
const CHORDS = "<[2,4,6,8] [2,4,5,7] [2,3,5,7] [1,3,4,6]>";

// The hook: a 2-bar call-and-response, restated over each chord.
// Degrees in F minor from F4: 0=F 1=G 2=Ab 3=Bb 4=C 5=Db 6=Eb 7=F
const MOTIF = bars(
  "4 ~ ~ 2 ~ ~ 4 ~ 6 ~ ~ 4 ~ ~ ~ ~", // Fm   call
  "~ ~ 7 ~ ~ 6 ~ 4 ~ ~ ~ ~ 2 ~ 1 ~", //      answer
  "4 ~ ~ 2 ~ ~ 4 ~ 5 ~ ~ 4 ~ ~ ~ ~", // Db   call (top note moves Eb → Db)
  "~ ~ 7 ~ ~ 5 ~ 4 ~ ~ ~ ~ 2 ~ ~ ~", //      answer
  "3 ~ ~ 2 ~ ~ 3 ~ 5 ~ ~ 3 ~ ~ ~ ~", // Bbm  call, a step lower
  "~ ~ 7 ~ ~ 5 ~ 3 ~ ~ ~ ~ 2 ~ ~ ~", //      answer
  "1 ~ ~ 0 ~ ~ 1 ~ 3 ~ ~ 1 ~ ~ ~ ~", // Cm   call, lower again
  "~ ~ 4 ~ ~ 3 ~ 1 ~ ~ 2 ~ 1 ~ ~ ~" //       answer, ends on G → back to C
);

// Bass rhythm on the 16th grid: hits land with the kicks (steps 1 and 11),
// plus a pickup. Every 2nd bar the pickup jumps up an octave (+7 degrees).
const BASSLINE = bars("0@6 ~@4 0@2 ~ 0@3", "0@6 ~@4 0@2 ~ 7@3");

// Drop-2 reese: re-triggered 8ths, so the filter can wobble note by note
const WOBBLE_LINE = bars("0 0 0 0 0 0 ~ 0", "0 0 0 0 0 ~ 7 0");

// Chord stab rhythm (2-bar call and response)
const STABS = bars("~ ~ x ~ ~ ~ ~ ~ ~ ~ x ~ ~ ~ ~ ~", "~ ~ x ~ ~ ~ ~ ~ ~ x ~ ~ x ~ ~ ~");

// ─────────────────────────────────────────────────────────────────────────────
// 🥁 THE BREAK — a 4-bar amen-style phrase on a 16-step grid
// Bars 1–2: the classic. Bar 3: snare slips late to step 15.
// Bar 4: snare on the "e" of 1, kick pushed to step 3 — the turnaround.
// ─────────────────────────────────────────────────────────────────────────────

const KICKS = bars(
  "bd ~ bd ~ ~ ~ ~ ~ ~ ~ bd bd ~ ~ ~ ~",
  "bd ~ bd ~ ~ ~ ~ ~ ~ ~ bd bd ~ ~ ~ ~",
  "bd ~ bd ~ ~ ~ ~ ~ ~ ~ bd ~ ~ ~ ~ ~",
  "~ ~ bd ~ ~ ~ ~ ~ ~ ~ bd ~ ~ ~ ~ ~"
);

// The loud backbeat snares
const SNARES = bars(
  "~ ~ ~ ~ sd ~ ~ ~ ~ ~ ~ ~ sd ~ ~ ~",
  "~ ~ ~ ~ sd ~ ~ ~ ~ ~ ~ ~ sd ~ ~ ~",
  "~ ~ ~ ~ sd ~ ~ ~ ~ ~ ~ ~ ~ ~ sd ~",
  "~ sd ~ ~ sd ~ ~ ~ ~ ~ ~ ~ ~ ~ sd ~"
);

// Ghost notes: same drum, much quieter, tucked between the backbeats.
// This is most of what makes a break "roll" instead of march.
const GHOSTS = bars(
  "~ ~ ~ ~ ~ ~ ~ sd ~ sd ~ ~ ~ ~ ~ sd",
  "~ ~ ~ ~ ~ ~ ~ sd ~ sd ~ ~ ~ ~ ~ sd",
  "~ ~ ~ ~ ~ ~ ~ sd ~ sd ~ ~ ~ ~ ~ ~",
  "~ ~ ~ ~ ~ ~ ~ sd ~ sd ~ ~ sd ~ ~ ~"
);

// Snare roll for the builds: speeds up bar by bar (8 bars)
const ROLL = "sd*<4 4 8 8 8 16 16 32>";

const song: Song = {
  name: "Jungle Pressure",
  bpm: BPM,
  visualization: "scope",
  sections: Object.entries(BARS), // the player's timeline (jump / loop)

  createPattern() {
    // ─────────────────────────────────────────────────────────────────────────
    // 🧱 SECTIONS
    // Every track lists what it plays per section; anything not listed rests.
    // `arrange` restarts the clock at bar 0 in each section, so every(),
    // lastOf(), "<...>" and slow signals all count from the section start.
    // ─────────────────────────────────────────────────────────────────────────

    const REST = s("~");
    const track = (parts: Partial<Record<Section, Pattern>>): Pattern =>
      arrange(
        ...(Object.keys(BARS) as Section[]).map(
          (name): [number, Pattern] => [BARS[name], parts[name] ?? REST]
        )
      );

    // ─────────────────────────────────────────────────────────────────────────
    // ✂️ CHOPS — re-edit the break like a sampler jockey
    // Applied identically to kick, snare and ghosts (all deterministic), so
    // the three tracks stay locked together while the break mutates.
    // ─────────────────────────────────────────────────────────────────────────

    // lastOf(n, f) applies f on the LAST bar of every n (every() hits the first).
    const chops = (p: Pattern): Pattern =>
      p
        .lastOf(8, (x: Pattern) => x.iter(4)) // bar 8: start the bar from a later slice
        .lastOf(16, (x: Pattern) => x.within(0.75, 1, (y: Pattern) => y.ply(2))); // bar 16: stutter the last beat

    // Drop 2 gets nastier: every 4th bar the last beat is pitched up
    // (speed > 1 plays the sample faster = higher), every 16th bar plays backwards.
    const wildChops = (p: Pattern): Pattern =>
      chops(p)
        .lastOf(4, (x: Pattern) => x.within(0.75, 1, (y: Pattern) => y.speed(1.5)))
        .lastOf(16, (x: Pattern) => x.rev());

    // ─────────────────────────────────────────────────────────────────────────
    // 🥁 DRUMS
    // ─────────────────────────────────────────────────────────────────────────

    // Kick also *ducks* orbit 2 (sub + reese): real sidechain compression,
    // so the bass gets out of the kick's way.
    const kickHit: Pattern = s(KICKS)
      .bank(DRUMS)
      .n(KICK_N)
      .gain(0.95)
      .shape(0.25)
      .duckorbit(2) // which orbit to duck
      .duckattack(0.12) // seconds to recover
      .duckdepth(0.5); // how far down (0–1)

    const snareHit = s(SNARES).bank(DRUMS).n(SNARE_N).gain(0.8).room(0.12);

    const ghostHit = s(GHOSTS)
      .bank(DRUMS)
      .n(GHOST_N)
      .gain(0.28)
      .hpf(400)
      .pan(0.55)
      .sometimesBy(0.15, (x) => x.ply(2)); // the odd ghost becomes a little roll

    // Build roll: rising gain, then one beat of silence before the drop
    const roll = s(ROLL)
      .bank(DRUMS)
      .n(SNARE_N)
      .gain(saw.range(0.25, 0.75).slow(8))
      .hpf(200);

    // "Next room" filter for intros/outros: a lowpassed break
    const muffled = (p: Pattern) => p.lpf(600);

    const kick = track({
      intro: kickHit.apply(chops).apply(muffled).mask(enterAt(8, BARS.intro)),
      build: kickHit.apply(chops).mask(exitAt(BARS.build - 2, BARS.build)),
      drop: kickHit.apply(chops),
      breakdown: kickHit.apply(muffled).gain(0.7).mask(enterAt(12, BARS.breakdown)),
      drop2: kickHit.apply(wildChops),
      outro: kickHit.apply(chops).gain(saw.range(0.95, 0.3).slow(BARS.outro)).mask(exitAt(12, BARS.outro)),
    });

    const snare = track({
      intro: snareHit.apply(chops).apply(muffled).mask(enterAt(8, BARS.intro)),
      build: stack(
        snareHit.apply(chops).mask(exitAt(BARS.build - 2, BARS.build)),
        roll.mask(enterAt(BARS.build - 2, BARS.build)).mask(gapBeforeDrop(BARS.build))
      ),
      drop: snareHit.apply(chops),
      breakdown: snareHit.apply(muffled).gain(0.5).mask(enterAt(12, BARS.breakdown)),
      build2: roll.mask(gapBeforeDrop(BARS.build2)),
      drop2: snareHit.apply(wildChops),
      outro: snareHit.apply(chops).gain(saw.range(0.8, 0.25).slow(BARS.outro)).mask(exitAt(12, BARS.outro)),
    });

    const ghosts = track({
      build: ghostHit.apply(chops).mask(exitAt(BARS.build - 2, BARS.build)),
      drop: ghostHit.apply(chops),
      drop2: ghostHit.apply(wildChops),
      outro: ghostHit.apply(chops).mask(exitAt(8, BARS.outro)),
    });

    // Closed hats: 16ths with perlin-noise velocity (smooth, human-ish drift),
    // an open hat on the last 8th, and occasional 32nd ratchets.
    const hatLine = stack(
      s("hh*16").bank(DRUMS).gain(perlin.range(0.1, 0.3)),
      s("~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ oh ~").bank(DRUMS).gain(0.22)
    )
      .hpf(3000)
      .pan(0.42)
      .sometimesBy(0.1, (x) => x.ply(2));

    const hats = track({
      intro: hatLine.lpf(4000).mask(enterAt(8, BARS.intro)),
      build: hatLine,
      drop: hatLine,
      breakdown: hatLine.gain(0.15).mask(enterAt(8, BARS.breakdown)),
      build2: hatLine.gain(perlin.range(0.05, 0.2)),
      drop2: hatLine.chunk(4, (x) => x.hurry(2)), // one beat per bar runs double-time, pitched up
      outro: hatLine.mask(exitAt(12, BARS.outro)),
    });

    // Amen-style ride on 8ths, accent on the beat
    const rideLine = s("rd*8").bank(DRUMS).gain(mini("[0.2 0.12]*4")).pan(0.6).hpf(2000);

    const ride = track({
      drop: rideLine,
      drop2: rideLine,
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 🔊 BASS — sine sub + supersaw "reese", both on orbit 2 (ducked by kick)
    // ─────────────────────────────────────────────────────────────────────────

    const bassDegrees = n(BASSLINE).add(n(ROOTS).slow(2));

    // Sub: a pure sine an octave below the reese — felt more than heard
    const subLine = bassDegrees
      .scale(`${KEY}1:minor`)
      .s("sine")
      .attack(0.005)
      .sustain(1)
      .release(0.08)
      .lpf(180)
      .gain(0.6)
      .orbit(2);

    const sub = track({
      drop: subLine,
      breakdown: subLine.gain(0.4).mask(enterAt(8, BARS.breakdown)),
      drop2: subLine,
      outro: subLine.gain(0.45).mask(exitAt(8, BARS.outro)),
    });

    // Reese: a few detuned saws beating against each other (supersaw), with a
    // resonant lowpass. Each note's filter envelope swells open (lpenv), and the
    // detune drifts slowly so the phasing never repeats exactly.
    const reeseBase = (p: Pattern): Pattern =>
      p
        .scale(`${KEY}2:minor`)
        .s("supersaw")
        .unison(3) // number of saw voices
        .detune(sine.range(0.12, 0.3).slow(8)) // how far apart they're tuned
        .spread(0.3) // stereo spread: keep the bass fairly mono
        .attack(0.01)
        .sustain(1)
        .release(0.1)
        .lpq(6)
        .hpf(50)
        .gain(0.32)
        .orbit(2);

    const reeseGrowl = reeseBase(bassDegrees)
      .lpf(sine.range(300, 900).slow(4))
      .lpenv(3)
      .lpattack(0.25)
      .lpdecay(0.5)
      .lpsustain(0.3);

    // Wobble: re-triggered 8ths with the cutoff following a sine,
    // so the filter "talks" WOBBLE times per bar.
    const reeseWobble = reeseBase(n(WOBBLE_LINE).add(n(ROOTS).slow(2)))
      .lpf(sine.range(250, 1800).fast(WOBBLE))
      .decay(0.15)
      .sustain(0.6);

    const reese = track({
      drop: reeseGrowl,
      breakdown: reeseGrowl.lpf(260).gain(0.22).mask(enterAt(8, BARS.breakdown)),
      build2: reeseGrowl.lpf(saw.range(200, 1500).slow(BARS.build2)).mask(gapBeforeDrop(BARS.build2)),
      drop2: reeseWobble,
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 🌌 PADS — slow-attack saws in a huge reverb (orbit 3)
    // ─────────────────────────────────────────────────────────────────────────

    const padVoice = n(CHORDS)
      .slow(2)
      .scale(`${KEY}3:minor`)
      .s("sawtooth")
      .attack(0.8)
      .sustain(0.8)
      .release(2)
      .hpf(200)
      .room(0.85)
      .rsize(6)
      .orbit(3);

    // An octave of triangle "air" on top
    const padAir = n(CHORDS)
      .slow(2)
      .scale(`${KEY}4:minor`)
      .s("triangle")
      .attack(1)
      .release(2)
      .gain(0.12)
      .room(0.85)
      .rsize(6)
      .orbit(3);

    // Soft root note so the chords make sense when the bass is out.
    // It lives on the bass bus (orbit 2): it gets ducked by the kick too, and
    // it creates that orbit from bar 1, before the kick's duck needs it.
    const padRoot = n(ROOTS)
      .slow(2)
      .scale(`${KEY}2:minor`)
      .s("sawtooth")
      .attack(0.5)
      .release(1.5)
      .lpf(350)
      .gain(0.16)
      .orbit(2);

    const pads = track({
      intro: stack(padVoice.lpf(saw.range(300, 2000).slow(BARS.intro)).gain(0.2), padAir, padRoot),
      build: stack(padVoice.lpf(2000).gain(0.18), padAir),
      drop: padVoice.lpf(1400).gain(0.1),
      breakdown: stack(padVoice.lpf(sine.range(700, 2600).slow(8)).gain(0.22), padAir, padRoot),
      build2: stack(padVoice.lpf(saw.range(600, 3000).slow(BARS.build2)).gain(0.18), padAir),
      drop2: padVoice.lpf(1600).gain(0.1),
      outro: stack(padVoice.lpf(saw.range(2000, 300).slow(BARS.outro)).gain(0.2), padAir, padRoot),
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 🎹 STABS — the pad chords cut into short syncopated hits (orbit 5)
    // ─────────────────────────────────────────────────────────────────────────

    const stabLine = n(CHORDS)
      .slow(2)
      .struct(STABS)
      .scale(`${KEY}4:minor`)
      .s("sawtooth")
      .lpf(700)
      .lpenv(4) // filter snaps open on each hit, then closes: a pluck
      .lpdecay(0.12)
      .decay(0.18)
      .sustain(0)
      .release(0.1)
      .hpf(300)
      .gain(0.15) // 4-note chords: keep each voice low
      .room(0.35)
      .delay(0.25)
      .delaytime(BEAT * 0.5)
      .delayfeedback(0.3)
      .orbit(5);

    const stabs = track({
      drop: stabLine,
      drop2: stabLine.every(4, (x) => x.off(1 / 8, (y) => y.gain(0.12))),
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 🎵 LEAD — the motif: square pluck in the drops, vibraphone in the
    // breakdown. Dotted-8th delay is the classic rolling-jungle echo (orbit 4).
    // ─────────────────────────────────────────────────────────────────────────

    const motif = n(MOTIF);

    const pluck = (p: Pattern) =>
      p
        .scale(`${KEY}4:minor`)
        .s("square")
        .lpf(1400)
        .lpenv(3)
        .lpdecay(0.15)
        .decay(0.2)
        .sustain(0.15)
        .release(0.15)
        .hpf(300)
        .gain(0.22)
        .delay(0.35)
        .delaytime(BEAT * 0.75)
        .delayfeedback(0.45)
        .room(0.3)
        .orbit(4);

    const bells = motif
      .scale(`${KEY}4:minor`)
      .s("vibraphone")
      .gain(0.45)
      .delay(0.5)
      .delaytime(BEAT * 0.75)
      .delayfeedback(0.55)
      .room(0.7)
      .orbit(4);

    const lead = track({
      drop: pluck(motif).mask(enterAt(16, BARS.drop)),
      breakdown: bells,
      // Drop 2: an octave-up canon an 8th behind the motif
      drop2: pluck(motif.off(1 / 8, (x) => x.add(n(7)))),
      outro: bells.gain(0.3).mask(exitAt(8, BARS.outro)),
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 🌧️ ATMOS — vinyl crackle and a pink-noise wind in the reverb
    // ─────────────────────────────────────────────────────────────────────────

    const atmosLine = stack(
      s("crackle").gain(0.12).hpf(1500),
      s("pink").attack(1).release(1).lpf(sine.range(400, 1600).slow(8)).hpf(200).gain(0.05)
    )
      .room(0.85)
      .rsize(6)
      .orbit(3);

    const atmos = track({
      intro: atmosLine,
      breakdown: atmosLine,
      build2: atmosLine,
      outro: atmosLine,
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 💥 FX — noise riser into each drop, crash on the 1 of every 16 bars
    // ─────────────────────────────────────────────────────────────────────────

    // 16th noise bursts whose highpass and volume climb over the build
    const riser = (len: number) =>
      s("white*16")
        .hpf(saw.range(400, 10000).slow(len))
        .gain(saw.range(0.02, 0.16).slow(len))
        .decay(0.06)
        .sustain(0)
        .pan(sine.fast(2))
        .mask(gapBeforeDrop(len));

    const crash = s("cr").bank("RolandTR909").mask("<1 0!15>").gain(0.3).room(0.3).orbit(5);

    const fx = track({
      build: riser(BARS.build),
      drop: crash,
      build2: riser(BARS.build2),
      drop2: crash,
    });

    return { kick, snare, ghosts, hats, ride, sub, reese, pads, stabs, lead, atmos, fx };
  },
};

export default song;
