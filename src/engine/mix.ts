// ═══════════════════════════════════════════════════════════════════════════
// Mute / solo state, per song, persisted in localStorage
// ═══════════════════════════════════════════════════════════════════════════
//
// A track is audible when nothing is soloed and it isn't muted, or when it is
// soloed. Mute and solo are independent toggles (like a mixing desk), so
// un-soloing brings back the previous mutes.

import { KEYS, readJson, writeJson } from "./storage";

interface Saved {
  muted?: string[];
  soloed?: string[];
}

export class Mix {
  private muted = new Set<string>();
  private soloed = new Set<string>();
  private songId = "";

  /** Switch to a song's saved mix */
  load(songId: string) {
    this.songId = songId;
    const saved = readJson<Saved>(KEYS.mix(songId)) ?? {};
    this.muted = new Set(Array.isArray(saved.muted) ? saved.muted : []);
    this.soloed = new Set(Array.isArray(saved.soloed) ? saved.soloed : []);
  }

  isAudible = (track: string): boolean =>
    this.soloed.size ? this.soloed.has(track) : !this.muted.has(track);

  toggle(mode: "mute" | "solo", track: string) {
    const set = mode === "mute" ? this.muted : this.soloed;
    if (!set.delete(track)) set.add(track);
    this.save();
  }

  clear() {
    this.muted.clear();
    this.soloed.clear();
    this.save();
  }

  mutedList(): string[] {
    return [...this.muted];
  }

  soloedList(): string[] {
    return [...this.soloed];
  }

  /** Identity of the current mix, to tell whether a rebuild is needed */
  key(tracks: readonly string[] | null): string {
    return tracks ? tracks.map((t) => (this.isAudible(t) ? "1" : "0")).join("") : "";
  }

  private save() {
    writeJson(KEYS.mix(this.songId), { muted: this.mutedList(), soloed: this.soloedList() });
  }
}
