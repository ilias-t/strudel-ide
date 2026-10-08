// sounds.json: every sound the app can play, by bank and by kind.
//
// Inputs are the parsed sample maps the app loads (src/engine/strudel.ts SAMPLE_MAPS), the bank
// alias map, and superdough's synth names. Pure: no fs, no network.

import { sortedUnique, sortKeys } from "./util.mjs";

export const DRUM_MACHINES = "tidal-drum-machines";

/** Kinds, grouped, in display order. A sound has exactly one kind. */
export const SOUND_GROUPS = [
  {
    id: "drums",
    label: "Drums",
    kinds: [
      ["kick", "Kick"],
      ["snare", "Snare"],
      ["clap", "Clap"],
      ["rim", "Rim"],
      ["hat", "Hi-hat"],
      ["openhat", "Open hat"],
      ["cymbal", "Cymbal"],
      ["tom", "Tom"],
      ["shaker", "Shaker"],
      ["perc", "Percussion"],
      ["break", "Break"],
    ],
  },
  {
    id: "instruments",
    label: "Instruments",
    kinds: [
      ["keys", "Keys"],
      ["organ", "Organ"],
      ["mallets", "Mallets & bells"],
      ["plucked", "Plucked"],
      ["strings", "Bowed strings"],
      ["wind", "Wind"],
    ],
  },
  {
    id: "synths",
    label: "Synths",
    kinds: [
      ["synth", "Waveforms"],
      ["noise", "Noise"],
      ["wavetable", "Wavetables"],
      ["zzfx", "ZzFX"],
    ],
  },
  { id: "fx", label: "FX", kinds: [["fx", "Effects"]] },
];

/** Drum-machine parts (tidal-drum-machines suffixes and uzu-drumkit names) */
const DRUM_PARTS = {
  bd: "kick",
  sd: "snare",
  cp: "clap",
  rim: "rim",
  hh: "hat",
  oh: "openhat",
  cr: "cymbal", // crash
  rd: "cymbal", // ride
  ht: "tom",
  mt: "tom",
  lt: "tom",
  sh: "shaker",
  tb: "shaker", // tambourine
  cb: "perc", // cowbell
  perc: "perc",
  misc: "perc",
  fx: "fx",
  brk: "break",
};

/** Named samples (vcsl, piano, mridangam, uzu-wavetables), first match wins */
const SAMPLE_KINDS = [
  ["kick", /^bassdrum/],
  ["rim", /^snare_rim$/],
  ["snare", /^snare/],
  ["tom", /^tom2?_/],
  ["clap", /^clap$/],
  ["hat", /^hihat$/],
  ["cymbal", /cymbal|^clash|^gong/],
  ["shaker", /^(shaker_\w+|cabasa|sleighbells|tambourine2?)$/],
  [
    "perc",
    /^(mridangam_\w+|timpani\w*|bongo|conga|darbuka|framedrum|cajon|agogo|anvil|brakedrum|clave|cowbell|flexatone|guiro|ratchet|slapstick|slitdrum|triangles|vibraslap|woodblock|marktrees|oceandrum)$/,
  ],
  ["mallets", /^(glockenspiel|marimba|vibraphone|xylophone|kalimba|balafon|tubularbells|handbells|handchimes|belltree|wineglass)/],
  ["keys", /^(piano|piano1|kawai|steinway|fmpiano|clavisynth)$/],
  ["organ", /organ/],
  ["plucked", /^(harp|folkharp|strumstick|dantranh|psaltery_pluck)/],
  ["strings", /^psaltery_(bow|spiccato)$/],
  ["wind", /^(recorder|ocarina|harmonica|super64|saxello|sax|didgeridoo)/],
  ["fx", /^(ballwhistle|trainwhistle|siren)$/],
  ["wavetable", /^wt_/],
];

const NOISES = new Set(["white", "pink", "brown", "crackle"]);
/** superdough registers these short names as copies of the full waveforms */
const SYNTH_ALIASES = { saw: "sawtooth", tri: "triangle", sqr: "square", sin: "sine" };

function synthKind(name) {
  if (NOISES.has(name)) return "noise";
  if (name === "zzfx" || name.startsWith("z_")) return "zzfx";
  if (name === "sbd") return "kick"; // superdough's synthesized bass drum
  return "synth";
}

/** Files in a map entry: a list of files, or (pitched instruments) note → file(s) */
function fileCount(entry) {
  if (Array.isArray(entry)) return entry.length;
  if (entry && typeof entry === "object") return Object.values(entry).reduce((n, v) => n + (Array.isArray(v) ? v.length : 1), 0);
  return 1;
}

/** "RolandTR909_bd" → ["RolandTR909", "bd"]; null for stray keys like "OberheimDMX_" */
function splitBankKey(key) {
  const i = key.indexOf("_");
  if (i <= 0 || i === key.length - 1) return null;
  return [key.slice(0, i), key.slice(i + 1)];
}

/**
 * @param {{ maps: Record<string, Record<string, unknown>>, aliasMap: Record<string, string | string[]>, synths: string[] }} input
 *   maps: map name → parsed sample map, in the order the app loads them
 */
export function buildSounds({ maps, aliasMap, synths }) {
  /** @type {Record<string, any>} */
  const sounds = {};
  /** @type {Record<string, { aliases: string[], parts: string[] }>} */
  const banks = {};

  for (const [mapName, map] of Object.entries(maps)) {
    for (const [key, entry] of Object.entries(map)) {
      if (key === "_base") continue;
      if (mapName === DRUM_MACHINES) {
        const split = splitBankKey(key);
        if (!split) continue;
        const [bank, part] = split;
        (banks[bank] ??= { aliases: [], parts: [] }).parts.push(part);
        const sound = (sounds[part] ??= { kind: DRUM_PARTS[part] ?? "perc", ...(DRUM_PARTS[part] ? {} : { guessed: true }) });
        (sound.banks ??= {})[bank] = fileCount(entry);
        continue;
      }
      if (sounds[key]?.source) continue; // first map wins (none overlap today)
      const pitched = !Array.isArray(entry) && typeof entry === "object";
      const curated = DRUM_PARTS[key] ?? SAMPLE_KINDS.find(([, re]) => re.test(key))?.[0];
      const sound = {
        kind: curated ?? (pitched ? "keys" : "perc"),
        ...(curated ? {} : { guessed: true }),
        source: mapName,
        count: fileCount(entry),
        ...(pitched ? { pitched: true } : {}),
      };
      sounds[key] = { ...sound, ...(sounds[key]?.banks ? { banks: sounds[key].banks } : {}) };
    }
  }

  for (const name of synths) {
    sounds[name] ??= { kind: synthKind(name), source: "superdough", ...(SYNTH_ALIASES[name] ? { aliasOf: SYNTH_ALIASES[name] } : {}) };
  }

  for (const [bank, alias] of Object.entries(aliasMap)) {
    if (banks[bank]) banks[bank].aliases.push(...[alias].flat());
  }
  for (const bank of Object.values(banks)) {
    bank.aliases = sortedUnique(bank.aliases);
    bank.parts = sortedUnique(bank.parts);
  }
  for (const sound of Object.values(sounds)) if (sound.banks) sound.banks = sortKeys(sound.banks);

  const sortedSounds = sortKeys(sounds);
  const groups = SOUND_GROUPS.map((g) => ({
    id: g.id,
    label: g.label,
    kinds: g.kinds
      .map(([id, label]) => ({ id, label, sounds: Object.keys(sortedSounds).filter((n) => sortedSounds[n].kind === id) }))
      .filter((k) => k.sounds.length),
  })).filter((g) => g.kinds.length);

  return { groups, banks: sortKeys(banks), sounds: sortedSounds };
}

