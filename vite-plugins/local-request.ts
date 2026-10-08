// ═══════════════════════════════════════════════════════════════════════════
// local-request — who may talk to the dev server's own endpoints
// ═══════════════════════════════════════════════════════════════════════════
//
// The bridge WebSocket (/__strudel, strudel-bridge.ts) and the write endpoints
// (POST /__strudel/knob, POST /__strudel/song) change files and drive the
// player, so only pages served from this machine may use them:
//
//   • The Host header must itself be localhost / 127.0.0.1 / [::1] (any port).
//     Comparing Origin with Host isn't enough: under DNS rebinding a page on
//     evil.example (re-resolved to 127.0.0.1) sends `Host: evil.example` and
//     `Origin: http://evil.example`, which match. Vite 5's own host check
//     doesn't cover plugin middlewares or our `upgrade` handler.
//   • An Origin, when present, must be this server's own (scheme://Host), so
//     a loopback host too. Editors (Node WebSocket clients) send none.
//   • Writes must be `Content-Type: application/json`, which a cross-site page
//     can only send after a CORS preflight that Vite doesn't answer for these
//     paths, so a `text/plain` form/fetch POST can't reach the JSON parser.
//
// Consequence: the dev server's write endpoints and bridge don't work when the
// page is opened through a LAN address (e.g. `vite --host` from a phone).
// ═══════════════════════════════════════════════════════════════════════════

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Is `host` (a Host header or URL host, with or without a port) this machine's loopback name? */
export function isLocalHost(host: string | undefined): boolean {
  if (!host) return false;
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  return LOCAL_HOSTNAMES.has(hostname);
}

/**
 * Is `origin` absent (non-browser clients) or a loopback page served by this
 * very server (`http://localhost:5173` for `Host: localhost:5173`)?
 */
export function isLocalOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined) return true;
  try {
    const url = new URL(origin); // "null" (sandboxed, file:) throws
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      LOCAL_HOSTNAMES.has(url.hostname.toLowerCase()) &&
      url.host.toLowerCase() === host?.toLowerCase()
    );
  } catch {
    return false;
  }
}

export interface RequestHeaders {
  host?: string;
  origin?: string;
  contentType?: string;
}

export interface RequestProblem {
  status: 403 | 415;
  message: string;
}

/** Why a request to the bridge or an endpoint must be refused (403), or null */
export function localRequestProblem({ host, origin }: RequestHeaders): RequestProblem | null {
  if (!isLocalHost(host)) {
    return { status: 403, message: `refused: the dev server only accepts requests to localhost (Host ${host ?? "missing"})` };
  }
  if (!isLocalOrigin(origin, host)) return { status: 403, message: `refused: cross-origin request (Origin ${origin})` };
  return null;
}

/** Why a JSON write (POST) must be refused (403 not local, 415 not JSON), or null */
export function jsonWriteProblem(headers: RequestHeaders): RequestProblem | null {
  const local = localRequestProblem(headers);
  if (local) return local;
  const type = headers.contentType?.split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return { status: 415, message: "Content-Type must be application/json" };
  return null;
}

/** The headers of a Node request, as the checks above take them */
export function requestHeaders(req: { headers: Record<string, string | string[] | undefined> }): RequestHeaders {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  return { host: one(req.headers.host), origin: one(req.headers.origin), contentType: one(req.headers["content-type"]) };
}
