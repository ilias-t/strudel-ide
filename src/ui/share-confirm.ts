// The question before a share link's song runs (initSongsStore's confirmShare):
// the stage's own card, saying what the link holds and that opening it runs
// code. Nothing from the link is compiled before "open it".

import type { SharedSong } from "../songs-store";
import { ask } from "./ask";

/** The song's `name: "…"`, read from the text without running it */
const NAME_RE = /\bname\s*:\s*"([^"\\\n]*)"/;

/** "2.4 KB · 84 lines" */
export function describeSize(text: string): string {
  const bytes = new TextEncoder().encode(text).length;
  const size = bytes < 1024 ? `${bytes} bytes` : `${(bytes / 1024).toFixed(1)} KB`;
  const lines = text.split("\n").length;
  return `${size} · ${lines} ${lines === 1 ? "line" : "lines"}`;
}

export function confirmSharedSong(song: SharedSong): Promise<boolean> {
  const name = NAME_RE.exec(song.text)?.[1]?.trim();
  return ask({
    testid: "share-dialog",
    title: "Open a shared song?",
    facts: [
      ["song", name || "(no name)"],
      ["file", `${song.id}.ts`],
      ["size", describeSize(song.text)],
    ],
    note: "This link carries code, and opening it runs that code in this page. Only open links from people you trust.",
    confirm: "open it",
    cancel: "don't",
    tone: "warn",
    focus: "confirm",
  });
}
