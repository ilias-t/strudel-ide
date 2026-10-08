// ═══════════════════════════════════════════════════════════════════════════
// Editor link: connects the player to the VS Code extension via the bridge
// ═══════════════════════════════════════════════════════════════════════════
//
// Commands from the editor drive the player; player state and the song list
// flow back so the editor can show status, errors and (later) highlights.

import { connectBridge } from "./bridge-client";
import type { CommandMsg, StateMsg } from "./protocol";
import type { PlayerState } from "../engine/types";

export interface PlayerApi {
  getState(): PlayerState;
  onStateChange(listener: (state: PlayerState) => void): () => void;
  play(): unknown;
  stop(): unknown;
  togglePlay(): unknown;
  selectSong(id: string): unknown;
  stepSong(direction: 1 | -1): unknown;
  songs(): { id: string; name: string }[];
  toggleTrack?(mode: "mute" | "solo", track: string): unknown;
  unmuteAll?(): unknown;
  muted?(): string[];
  soloed?(): string[];
}

export const songFile = (id: string) => `src/songs/${id}.ts`;

/** "src/songs/jynx.ts" | "jynx.ts" | "/abs/…/src/songs/jynx.ts" → "jynx" */
export function songIdForFile(file: string | undefined): string | null {
  const match = file?.match(/([\w.-]+)\.ts$/);
  return match ? match[1] : null;
}

export interface LinkOptions {
  /** Called with true/false when the bridge socket opens/closes */
  onConnectionChange?: (connected: boolean) => void;
}

export function linkEditor(player: PlayerApi, options: LinkOptions = {}) {
  const bridge = connectBridge({
    client: "strudel-ide-player",
    onCommand: (cmd) => handleCommand(player, cmd),
    onConnectionChange: options.onConnectionChange,
  });

  let lastSongs = "";
  const publish = (state: PlayerState) => {
    const songs = player.songs().map(({ id, name }) => ({ id, name, file: songFile(id) }));
    const songsKey = JSON.stringify(songs);
    if (songsKey !== lastSongs) {
      lastSongs = songsKey;
      bridge.sendSongs(songs);
    }
    bridge.sendState(toStateMsg(player, state));
  };

  publish(player.getState());
  player.onStateChange(publish);
  return bridge;
}

function handleCommand(player: PlayerApi, cmd: CommandMsg) {
  switch (cmd.command) {
    case "play":
      return player.play();
    case "stop":
      return player.stop();
    case "toggle":
      return player.togglePlay();
    case "select": {
      const id = cmd.songId ?? songIdForFile(cmd.file);
      return id && player.selectSong(id);
    }
    case "next":
      return player.stepSong(1);
    case "prev":
      return player.stepSong(-1);
    case "mute":
    case "solo":
      return cmd.track && player.toggleTrack?.(cmd.command, cmd.track);
    case "unmuteAll":
      return player.unmuteAll?.();
  }
}

function toStateMsg(player: PlayerApi, state: PlayerState): Omit<StateMsg, "type"> {
  const err = state.error;
  return {
    playing: state.playing,
    songId: state.songId,
    songName: state.songName,
    file: songFile(state.songId),
    bpm: state.bpm,
    cycle: state.playing ? state.cycle : null,
    cps: state.cps,
    tracks: state.tracks ?? undefined,
    muted: player.muted?.(),
    soloed: player.soloed?.(),
    error: err
      ? {
          message: err.message,
          file: err.file ? songFile(songIdForFile(err.file) ?? err.file) : undefined,
          line: err.line,
          column: err.column,
        }
      : null,
  };
}
