// ════════════════════════════════════════════════════════════════════════════
// Type tests for the Strudel declarations (src/strudel*.d.ts).
//
// Never imported by the app (so never bundled) and outside the src/songs glob; it is only
// type-checked by `npm run check` (tsc). Lines marked `@ts-expect-error` MUST fail to compile —
// if one starts compiling, tsc reports the directive as unused.
// ════════════════════════════════════════════════════════════════════════════

import type { Song, Tracks } from "./songs";

// ─── chained controls & mini-notation ───────────────────────────────────────
export const drums = s("bd*4, [~ sd]*2, hh*8").bank("RolandTR909").gain(0.8).room(0.2).orbit(1);
export const miniControls = s("hh*8").gain("[0.4 0.22 0.45 0.28]*4").pan("0 1").lpf("<400 2000>");
export const soundAlias = sound("piano").note("c4 e4 g4");
export const sampleIndex = s("bd:3 sd:1").n("<0 1 2>").speed("1 2").cut(1);
export const synthChain = note("c2 [eb2 g2]").s("sawtooth").lpf(800).lpq(8).attack(0.01).decay(0.2).sustain(0).release(0.3).shape(0.4).crush(8).delay(0.25).delaytime(0.125).delayfeedback(0.5);
export const sizeControl = s("bd").room(0.5).size(4).rsize(2);
export const duckControls = s("bd*4").duckorbit(2).duckdepth(0.8).duckattack(0.1);
export const vibControl = note("c4").vib(4).vibmod(0.5);

// ─── signals as arguments ────────────────────────────────────────────────────
export const filterSweep = note("c3 e3").s("sawtooth").lpf(sine.range(200, 2000).slow(4));
export const signalMix = s("hh*16").gain(perlin.range(0.2, 0.6)).pan(rand).speed(saw.add(1)).lpf(cosine.rangex(300, 3000));
export const segmented = n(irand(8).segment(4)).scale("C:minor").s("piano");
export const nWithSignal = n(run(8)).degradeBy(sine.range(0, 0.5));

// ─── tonal ───────────────────────────────────────────────────────────────────
export const scaled = n("0 2 4").scale("C:major");
export const scaledNote = note("0 2 4 6").scale("A5:minor");
export const scaleWithPattern = n("0 2 4").scale("<C:major D:dorian>");
export const pentatonic = n("0 1 2 3 4").scale("F#:minor:pentatonic");
export const transposed = note("c3 e3 g3").transpose("<0 3 5>").scaleTranspose(1);
export const chords = chord("<C Am F G>").voicing().mode("root:g2").anchor("c5").s("piano");
export const roots = chord("<C^7 A7 Dm7 G7>").rootNotes(2).note();
export const voiced = n("0 1 2 3").chord("<Am7 Dm7>").dict("ireal").voicing();

// ─── time & structure ────────────────────────────────────────────────────────
export const every4 = s("bd sd").every(4, (x) => x.fast(2));
export const curried = s("bd sd hh cp").every(3, fast(2)).lastOf(4, rev).firstOf(8, (x) => x.ply(2));
export const juxRev = s("bd sd [~ bd] sd").jux(rev);
export const juxCurried = note("c3 e3 g3").jux(late(0.125)).juxBy(0.5, (x) => x.fast(2));
export const sometimesFast = s("hh*8").sometimesBy(0.3, (x) => x.speed(2)).sometimes((x) => x.gain(0.5)).often(rev);
export const offs = note("c3 e3").off(1 / 8, (x) => x.add(note(7))).off(0.25, add(note(12)));
export const swinging = s("hh*8").swingBy(1 / 3, 4).swing(4);
export const slicing = s("breaks").slice(8, "0 1 <2 3>").splice(4, "0 1").chop(4).striate(4).loopAt(2);
export const fitted = s("breaks").fit();
export const timeShift = s("bd sd").early(0.25).late("<0 0.125>").fast("<1 2>").slow(2).hurry(2).ply("<1 2>");
export const structured = note("c3").struct("x ~ x x").euclid(3, 8).mask("1 0 1 1");
export const euclidRot = s("bd").euclidRot(3, 8, 2).euclidLegato(5, 8);
export const chunked = n("0 1 2 3").chunk(4, (x) => x.add(7)).iter(4).palindrome().inside(2, rev).within(0, 0.5, fast(2));
export const degraded = s("hh*16").degradeBy(0.3).degrade().undegradeBy(0.2);
export const lingered = s("bd sd hh cp").linger(0.25).zoom(0.25, 0.75).compress(0.25, 0.75).ribbon(1, 2);
export const echoed = note("c4").echo(3, 1 / 8, 0.5).stut(3, 0.5, 1 / 8).echoWith(3, 1 / 8, (x) => x.add(note(12)));
export const superimposed = note("c3").superimpose((x) => x.add(note(7))).layer(rev, (x) => x.fast(2));
export const operators = n("0 2").add(3).sub(1).mul(2).add.squeeze("0 12").add.out("0 7");

// ─── combining patterns ──────────────────────────────────────────────────────
export const stacked = stack(s("bd*4"), s("hh*8").gain(0.5), "<c3 e3>", [s("cp"), s("rim")]);
export const sequenced = seq("bd", ["sd", "sd"], s("hh")).s();
export const catted = cat(note("c3"), note("e3"), "g3").note();
export const arrangement = arrange([4, s("bd*4")], [8, stack(s("bd*4"), s("hh*8"))]);
export const stepped = stepcat([3, s("bd*3")], [1, s("sd")]);
export const randomCycles = chooseCycles(s("bd"), s("sd"), s("hh"));
export const weighted = wchooseCycles([s("bd"), 3], [s("sd"), 1]);
export const weightedValues = s("hh*8").gain(wchoose([0.2, 2], [0.8, 1]));
export const picked = n("<0 1 2>").pick([s("bd*2"), s("sd"), s("hh*4")]);
export const pickedByName = s("<a b>").pick({ a: s("bd*2"), b: s("sd sd") });
export const nothingHere = silence;
export const polymeterPat = polymeter(["c3", "e3", "g3"], ["c4", "d4"]).note();

// ─── named tracks / songs ────────────────────────────────────────────────────
const kick = s("bd*4").bank("RolandTR808");
const hats = s("hh*8").bank("RolandTR808").gain(0.4);
export const tracks: Tracks = { kick, hats, bass: note("<c2 g1>").s("sawtooth").lpf(400) };
export const song: Song = {
  name: "Type test",
  bpm: 120,
  visualization: { type: "pianoroll", options: { cycles: 4, autorange: true } },
  createPattern: () => tracks,
};

// ─── visuals ─────────────────────────────────────────────────────────────────
export const visuals = [
  note("c3 e3").pianoroll({ cycles: 4, playhead: 0.5, labels: true }),
  s("bd sd").punchcard(),
  note("c3 e3").scope({ color: "cyan" }),
  note("c3 e3").spiral(),
];

// ─── queries / misc ──────────────────────────────────────────────────────────
export const haps: Hap[] = note("c3 e3").queryArc(0, 1);
export const firstValues: string[] = n("0 1").showFirstCycle;
export const rendered: Pattern = s("bd").play();
export const loadSamples: Promise<void> = samples("github:tidalcycles/dirt-samples");

// ─── things that must NOT compile ────────────────────────────────────────────

// Strings have no pattern methods without the strudel.cc transpiler
// @ts-expect-error
export const stringMethod = "c3 e3".note();
// @ts-expect-error
export const stringFast = "bd sd".fast(2);

// Not part of Strudel (or not loaded in this app)
// @ts-expect-error
export const noSuchMethod = s("bd").reverb(0.5);
// @ts-expect-error
export const noAppend = s("bd").append(s("sd"));
// @ts-expect-error
setcpm(120);
// @ts-expect-error
setbpm(120);

// silence is a Pattern, not a function
// @ts-expect-error
export const silenceCall = silence();

// Wrong arity / argument types
// @ts-expect-error
export const everyNoFn = s("bd").every(4);
// @ts-expect-error
export const juxNotFn = s("bd").jux(2);
// @ts-expect-error
export const lpfObject = s("bd").lpf({ freq: 200 });
// @ts-expect-error
export const showFirstCycleIsNotAMethod = n("0 1").showFirstCycle();
// @ts-expect-error
export const arrangeNeedsTuples = arrange(4, s("bd"));
