// localStorage that never throws (private mode, blocked storage, …)

const PREFIX = "strudel-ide:";

export const KEYS = {
  song: "song",
  follow: "follow-edits",
  codeView: "code-view",
  mix: (songId: string) => `mix:${songId}`,
};

export function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string) {
  try {
    localStorage.setItem(PREFIX + key, value);
  } catch {
    // storage unavailable: not persisted
  }
}

export function readJson<T>(key: string): T | null {
  const raw = readStorage(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function writeJson(key: string, value: unknown) {
  writeStorage(key, JSON.stringify(value));
}
