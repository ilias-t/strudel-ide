// Curated categories for functions.json. Strudel's JSDoc carries no category tags, so a name gets
// its category from (in order):
//   1. its alias target: "Alias of `lpf`" puts `lp` wherever `lpf` is (followed through chains)
//   2. the explicit TABLE below
//   3. the first name RULE that matches
//   4. "other"
// When Strudel adds functions, test/catalog.test.mjs prints the "other" list; add them to TABLE.

/** In display order */
export const CATEGORIES = [
  { id: "time", label: "Rhythm & time" },
  { id: "structure", label: "Structure & arrangement" },
  { id: "transform", label: "Conditions & transformations" },
  { id: "pitch", label: "Pitch & harmony" },
  { id: "sound", label: "Sounds & samples" },
  { id: "synthesis", label: "Synthesis" },
  { id: "effects", label: "Effects & filters" },
  { id: "envelope", label: "Envelopes" },
  { id: "dynamics", label: "Dynamics & mix" },
  { id: "modulation", label: "Modulation" },
  { id: "randomness", label: "Randomness" },
  { id: "signals", label: "Signals" },
  { id: "math", label: "Math & values" },
  { id: "visual", label: "Visuals" },
  { id: "io", label: "Setup, MIDI & OSC" },
  { id: "internal", label: "Pattern internals" },
  { id: "other", label: "Other" },
];

const words = (category, list) => list.trim().split(/\s+/).map((name) => [name, category]);

function tableOf(pairs) {
  const table = {};
  for (const [name, category] of pairs) {
    if (table[name]) throw new Error(`function-categories: "${name}" is listed under both ${table[name]} and ${category}`);
    table[name] = category;
  }
  return table;
}

/** name → category, checked before the rules (a name listed twice is a mistake: it throws) */
const TABLE = tableOf([
  ...words(
    "time",
    `compressspan focusspan euclidrot loopat zoomarc zoomIn e fast slow early late hurry ply plyWith plyForEach euclid euclidRot euclidLegato euclidLegatoRot euclidish
     swing swingBy nudge off segment iter iterBack palindrome rev linger fastGap compress compressSpan zoom zoomArc
     focus focusSpan inside outside cpm cps brak press pressBy pace ribbon repeatCycles fit loopAt loopAtCps
     beat struct structAll mask maskAll binary binaryN gap expand contract extend shrink grow take drop
     hours minutes seconds steps`,
  ),
  ...words(
    "structure",
    `squeezeout stack cat seq sequence slowcat fastcat timecat arrange polymeter layer superimpose stepcat stepalt s_cat s_alt
     chunk chunkBack chunkInto chunkBackInto fastChunk firstOf lastOf every inhabit inhabitmod pick pickF pickOut
     pickReset pickRestart pickmod pickmodF pickmodOut pickmodReset pickmodRestart pickSqueeze pickmodSqueeze
     squeeze bite tour zip run seqPLoop sequenceP slowcatPrime silence nothing stackBy stackLeft stackRight stackCentre
     polyrhythm poly s_polymeter s_taper s_taperlist s_expand s_contract s_extend s_add s_sub s_tour s_zip
     replicate shrinklist`,
  ),
  ...words(
    "transform",
    `into when whenKey within jux juxBy apply applyN echo echoWith stut stutWith invert inv bypass keep keepif
     filterWhen lock scrub reset restart resetAll restartAll pipe`,
  ),
  ...words(
    "pitch",
    `offset note n freq scale scaleTranspose transpose chord voicing voicings voicingAlias addVoicings registerVoicings
     setDefaultVoicings setVoicingRange arp arpWith octave octaves rootNotes anchor mode dict dictionary degree
     semitone stepsPerOctave midi2note noteToMidi midiToFreq freqToMidi valueToMidi getFreq ctranspose mtranspose
     octaveR harmonic`,
  ),
  ...words(
    "sound",
    `chop accelerate rate stretch fadeTime fadeInTime fadeOutTime s sound bank begin end speed slice splice striate cut clip legato unit samples soundAlias aliasBank
     registerSound loop loopBegin loopEnd duration irbegin iresponse irspeed`,
  ),
  ...words(
    "synthesis",
    `density detune unison spread zmod fm fmh fmwave fmvelocity partials pw pwrate pwsweep wt warp warpmode warpdepth warpshape warpskew warprate
     warpsync warpdc wtdc wtdepth wtshape wtskew wtrate wtsync wtphaserand byteBeatExpression byteBeatStartTime
     zzfx noise imag real dough supradough tables waveloss`,
  ),
  ...words(
    "effects",
    `scurve octer octersub octersubsub binshift kcutoff freeze lpf hpf bpf lpq hpq bpq ftype djf vowel crush coarse distort distorttype distortvol drive shape triode diode
     chebyshev soft hard cubic sinefold fold room roomsize roomdim roomfade roomlp dry delay delayfeedback delayspeed
     delaysync comb fshift fshiftnote fshiftphase ring ringf ringdf squiz enhance lbrick hbrick xsdelay tsdelay zdelay
     zcrush krush curve asym morph`,
  ),
  ...words("envelope", `fanchor ds r psus hold attack decay sustain release adsr ar ad penv pattack pdecay psustain prelease pcurve sustainpedal`),
  ...words(
    "dynamics",
    `gain postgain velocity amp pan panchor panorient panspan pansplay panwidth orbit duckorbit duckattack duckdepth
     duckonset compressor compressorAttack compressorKnee compressorRatio compressorRelease xfade overgain overshape
     channel channels mix`,
  ),
  ...words(
    "modulation",
    `vib vibmod tremolo tremolodepth tremolophase tremoloshape tremoloskew tremolosync phaser phasercenter
     phaserdepth phasersweep chorus leslie lrate lsize lfo pitchJump pitchJumpTime deltaSlide slide`,
  ),
  ...words(
    "randomness",
    `rand rand2 irand perlin perlinWith berlin berlinWith brand brandBy choose choose2 chooseWith chooseIn
     chooseInWith chooseOut chooseCycles wchoose wchooseCycles randcat wrandcat degrade degradeBy degradeByWith
     undegrade undegradeBy scram scramble shuffle randrun zrand znoise sometimes sometimesBy often rarely
     almostAlways almostNever always never someCycles someCyclesBy`,
  ),
  ...words(
    "signals",
    `sine sine2 cosine cosine2 saw saw2 isaw isaw2 tri tri2 itri itri2 square square2 time signal range range2
     rangex rescale fromBipolar toBipolar mousex mousey mouseX mouseY steady`,
  ),
  ...words(
    "math",
    `ratio as add sub mul div mod pow round floor ceil log log2 and or band bor bxor blshift brshift gt gte lt lte eq ne
     eqt set val fmap asNumber removeUndefineds discreteOnly`,
  ),
  ...words(
    "visual",
    `angle wordfall pitchwheel fill moveXY pianoroll punchcard scope tscope fscope spectrum spiral color draw drawLine onPaint getPainters hsl hsla
     label activeLabel markcss animate fft frameRate frames x y w h analyze`,
  ),
  ...words(
    "io",
    `gate gat voice initStrudel initAudioOnFirstClick getAudioContext evaluate hush midichan midicmd midiport midimap
     midibend miditouch ccn ccv ctlNum nrpnn nrpv progNum sysex sysexdata sysexid oschost oscport out play
     polyTouch songPtr control createParam createParams register setDefault setDefaultValue setDefaultValues
     resetDefaults setMaxPolyphony keyDown speak net mini m isPattern`,
  ),
  ...words(
    "internal",
    `pure reify queryArc splitQueries appBoth appLeft appRight appWhole bind bindWhole innerBind outerBind
     squeezeBind stepBind polyBind join innerJoin outerJoin squeezeJoin stepJoin resetJoin restartJoin unjoin
     filter filterHaps filterValues firstCycle firstCycleValues showFirstCycle defragmentHaps sortHapsByPart
     onsetsOnly withContext setContext stripContext withHap withHaps withHapSpan withHapTime withLoc withQuerySpan
     withQuerySpanMaybe withQueryTime withState withSteps withValue setSteps hasSteps collect id uid tag
     logValues logPatterns compose func expression ref source`,
  ),
]);

/** Families by name shape, first match wins */
const RULES = [
  ["envelope", /^(lp|hp|bp|fm|wt|warp)(a|d|s|r|e|attack|decay|sustain|release|env)$/],
  ["effects", /^(lp|hp|bp|band)/],
  ["effects", /^(delay|room|distort|comb)/],
  ["modulation", /^(trem|vib|phas|ph)/],
  ["dynamics", /^(duck|compressor|pan)/],
  ["synthesis", /^(fm|wt|warp|wavetable|zzfx|z_)/],
  ["io", /^(midi|osc|cc|sysex|nrpn|onTrigger)/],
  ["structure", /^s_/],
];

/**
 * Adds `category` to every entry (returns new objects).
 * @template {{ name: string, aliasOf?: string }} T
 * @param {T[]} entries
 * @returns {(T & { category: string })[]}
 */
export function categorize(entries) {
  const byName = new Map(entries.map((e) => [e.name, e]));
  /** "Synonyms: `cutoff`" on lpf: a synonym without its own "Alias of" note still belongs with lpf */
  const synonymOf = new Map();
  for (const e of entries) for (const s of e.synonyms ?? []) if (!synonymOf.has(s)) synonymOf.set(s, e.name);
  const own = (name) => TABLE[name] ?? RULES.find(([, re]) => re.test(name))?.[0];
  const categoryOf = (name, seen = new Set()) => {
    seen.add(name);
    const target = byName.get(name)?.aliasOf;
    if (target && byName.has(target) && !seen.has(target)) return categoryOf(target, seen);
    const parent = synonymOf.get(name);
    return own(name) ?? (parent && !seen.has(parent) ? categoryOf(parent, seen) : "other");
  };
  return entries.map((e) => ({ ...e, category: categoryOf(e.name) }));
}
