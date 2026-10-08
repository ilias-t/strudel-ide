import { initStrudel } from "@strudel/web";
import type { VisualizationType, VisualizationConfig } from "./songs";
import { defaultVisualization } from "./songs";

await initStrudel();

// Load all Strudel CDN samples
await samples("https://strudel.b-cdn.net/tidal-drum-machines.json");
await samples("https://strudel.b-cdn.net/tidal-drum-machines-alias.json"); // RolandTR808, RolandTR909, etc.
await samples("https://strudel.b-cdn.net/piano.json");
await samples("https://strudel.b-cdn.net/vcsl.json"); // Orchestral/acoustic instruments
await samples("https://strudel.b-cdn.net/uzu-drumkit.json");
await samples("https://strudel.b-cdn.net/uzu-wavetables.json"); // Wavetable synths
await samples("https://strudel.b-cdn.net/mridangam.json"); // Indian percussion

// Samples loaded from Strudel CDN - see strudel.d.ts for available types

// Dynamic import so we can re-import on HMR
type SongsModule = typeof import("./songs");
let songsModule: SongsModule = await import("./songs");

// ─────────────────────────────────────────────────────────────────────────────
// DOM
// ─────────────────────────────────────────────────────────────────────────────

const playBtn = document.getElementById("play") as HTMLButtonElement;
const statusEl = document.getElementById("current-pattern") as HTMLElement;
const songSelect = document.getElementById("song-select") as HTMLSelectElement;

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

let isPlaying = false;
let currentSongId = "untitled";

// ─────────────────────────────────────────────────────────────────────────────
// Core Functions
// ─────────────────────────────────────────────────────────────────────────────

function stop() {
  hush();
  clearVisualizations();
  isPlaying = false;
  playBtn.textContent = "▶ Play";
  playBtn.classList.remove("playing");
  statusEl.classList.add("idle");
}

function clearVisualizations() {
  // Remove Strudel-created visualization canvases
  // These are typically created with specific IDs or as direct children of body
  const canvasSelectors = [
    'canvas[id^="pianoroll"]',
    'canvas[id^="scope"]',
    "canvas#draw-context",
    "canvas.strudel-canvas",
  ];

  canvasSelectors.forEach((selector) => {
    document.querySelectorAll(selector).forEach((el) => el.remove());
  });

  // Also remove any canvases Strudel adds directly to body
  document.querySelectorAll("body > canvas").forEach((el) => el.remove());
}

function play() {
  stop();
  const song = songsModule.getSong(currentSongId);
  cpm((song.bpm ?? 120) / 4);

  // Get pattern and apply visualization (Strudel renders to its own full-page canvas)
  let pattern = songsModule.toPattern(song.createPattern());
  pattern = applyVisualization(pattern, song.visualization);
  pattern.play();

  isPlaying = true;
  playBtn.textContent = "■ Stop";
  playBtn.classList.add("playing");
  statusEl.textContent = song.name;
  statusEl.classList.remove("idle");
}

function applyVisualization(
  pattern: Pattern,
  viz: VisualizationType | VisualizationConfig | undefined
): Pattern {
  // Resolve config: string shorthand or full config object
  const config: VisualizationConfig =
    viz === undefined
      ? defaultVisualization
      : typeof viz === "string"
      ? { type: viz }
      : viz;

  const defaultOptions: PianorollOptions = {
    cycles: 4,
    playhead: 0.5,
    autorange: true,
  };

  switch (config.type) {
    case "pianoroll":
      return pattern.pianoroll({ ...defaultOptions, ...config.options });
    case "scope":
      return pattern.scope();
    case "none":
      return pattern;
    default:
      return pattern.pianoroll(defaultOptions);
  }
}

function renderSongSelector() {
  songSelect.innerHTML = songsModule
    .getAllSongs()
    .map(
      ({ id, song }) =>
        `<option value="${id}"${id === currentSongId ? " selected" : ""}>${
          song.name
        }</option>`
    )
    .join("");
}

// ─────────────────────────────────────────────────────────────────────────────
// Initialize
// ─────────────────────────────────────────────────────────────────────────────

renderSongSelector();

songSelect.addEventListener("change", (e) => {
  stop();
  currentSongId = (e.target as HTMLSelectElement).value;
  statusEl.textContent = songsModule.getSong(currentSongId).name;
});

playBtn.addEventListener("click", () => {
  if (isPlaying) {
    stop();
    statusEl.textContent = "Stopped";
  } else {
    play();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// HMR - Watches all song files via the glob in songs/index.ts
// ─────────────────────────────────────────────────────────────────────────────

if (import.meta.hot) {
  import.meta.hot.accept("./songs/index.ts", async (newModule: unknown) => {
    if (newModule) {
      songsModule = newModule as SongsModule;
      renderSongSelector();
      if (isPlaying) {
        play(); // Restart with updated song
      } else {
        statusEl.textContent = songsModule.getSong(currentSongId).name;
      }
    }
  });
}

console.log("🎵 Strudel IDE ready!");
