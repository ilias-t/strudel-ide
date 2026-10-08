// Finding the dev server (node:fs only, no vscode).

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { BRIDGE_PATH, DISCOVERY_FILE, type DiscoveryInfo } from "../../src/live/protocol.ts";

export const DEFAULT_SERVER_URL = "http://localhost:3000";

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** First valid, live discovery file among `dirs` (each a candidate Vite root). */
export function readDiscovery(dirs: string[], isAlive: (pid: number) => boolean = pidAlive): DiscoveryInfo | null {
  for (const dir of dirs) {
    try {
      const info = JSON.parse(readFileSync(path.join(dir, DISCOVERY_FILE), "utf8")) as DiscoveryInfo;
      if (typeof info.url !== "string" || typeof info.port !== "number") continue;
      if (typeof info.pid === "number" && !isAlive(info.pid)) continue; // stale (server crashed)
      return info;
    } catch {
      // missing or unreadable
    }
  }
  return null;
}

/** http(s)://host:port/... → ws(s)://host:port/__strudel */
export function toBridgeUrl(httpUrl: string): string {
  const u = new URL(httpUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = BRIDGE_PATH;
  u.search = "";
  u.hash = "";
  return u.toString();
}

export interface Endpoint {
  httpUrl: string;
  wsUrl: string;
  /** Vite root if known (from the discovery file) */
  root: string | null;
  source: "setting" | "discovery" | "default";
}

/** The `strudel.serverUrl` setting wins, then the discovery file, then localhost:3000. */
export function resolveEndpoint(setting: string | undefined, discovery: DiscoveryInfo | null): Endpoint {
  const s = setting?.trim();
  if (s) {
    try {
      return { httpUrl: s, wsUrl: toBridgeUrl(s), root: discovery?.root ?? null, source: "setting" };
    } catch {
      // invalid URL: fall through
    }
  }
  if (discovery)
    return {
      httpUrl: discovery.url,
      wsUrl: discovery.bridgeUrl || toBridgeUrl(discovery.url),
      root: discovery.root ?? null,
      source: "discovery",
    };
  return { httpUrl: DEFAULT_SERVER_URL, wsUrl: toBridgeUrl(DEFAULT_SERVER_URL), root: null, source: "default" };
}
