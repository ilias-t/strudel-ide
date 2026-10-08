// Who may use the dev server's bridge and write endpoints (vite-plugins/local-request.ts):
// localhost pages and editors only. Covers DNS rebinding (a foreign Host that
// matches its Origin), cross-site Origins and non-JSON ("simple") POSTs, on the
// helper and on a real dev server with the bridge, knob and song plugins.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { createServer, type ViteDevServer } from "vite";
import { WebSocket } from "ws";
import { isLocalHost, isLocalOrigin, jsonWriteProblem, localRequestProblem } from "../vite-plugins/local-request.ts";
import strudelBridge from "../vite-plugins/strudel-bridge.ts";
import strudelKnobs from "../vite-plugins/strudel-knobs.ts";
import strudelSongs from "../vite-plugins/strudel-songs.ts";

describe("local-request rules", () => {
  test("Host must be a loopback name (any port)", () => {
    for (const host of ["localhost", "localhost:5173", "LOCALHOST:1", "127.0.0.1:80", "[::1]:5173", "[::1]"]) assert.ok(isLocalHost(host), host);
    for (const host of [undefined, "", "evil.example", "evil.example:5173", "127.0.0.2:5173", "localhost.evil.example", "192.168.1.5:5173", "a b"]) {
      assert.ok(!isLocalHost(host), String(host));
    }
  });

  test("Origin must be absent or this server's own", () => {
    assert.ok(isLocalOrigin(undefined, "localhost:5173"));
    assert.ok(isLocalOrigin("http://localhost:5173", "localhost:5173"));
    assert.ok(isLocalOrigin("http://127.0.0.1:5173", "127.0.0.1:5173"));
    for (const origin of ["http://evil.example", "http://localhost:5174", "null", "garbage", "file:///x", "vscode-webview://x"]) {
      assert.ok(!isLocalOrigin(origin, "localhost:5173"), origin);
    }
  });

  test("DNS rebinding: a foreign Host is refused even when Origin matches it", () => {
    assert.equal(localRequestProblem({ host: "evil.example:5173", origin: "http://evil.example:5173" })?.status, 403);
    assert.equal(localRequestProblem({ host: "evil.example:5173" })?.status, 403);
    assert.equal(localRequestProblem({ host: "localhost:5173" }), null);
  });

  test("writes must be JSON", () => {
    const ok = { host: "localhost:5173", origin: "http://localhost:5173" };
    assert.equal(jsonWriteProblem({ ...ok, contentType: "application/json; charset=utf-8" }), null);
    for (const contentType of [undefined, "text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
      assert.equal(jsonWriteProblem({ ...ok, contentType })?.status, 415, String(contentType));
    }
    // not local beats not JSON: nothing about the request is answered
    assert.equal(jsonWriteProblem({ host: "evil.example", contentType: "text/plain" })?.status, 403);
  });
});

describe("dev server endpoints", () => {
  let server: ViteDevServer;
  let root = "";
  let port = 0;
  const SONG = `const song = { name: "X", createPattern: () => s("bd").gain(knob("level", 0.5, 0, 1)) };\nexport default song;\n`;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "strudel-local-"));
    mkdirSync(join(root, "src/songs"), { recursive: true });
    writeFileSync(join(root, "index.html"), `<script type="module" src="/main.js"></script>`);
    writeFileSync(join(root, "main.js"), `console.log("hi")`);
    writeFileSync(join(root, "src/songs/x.ts"), SONG);
    server = await createServer({
      configFile: false,
      root,
      logLevel: "silent",
      plugins: [strudelKnobs(), strudelBridge({ log: false, discovery: false }), strudelSongs()],
      server: { port: 0, host: "127.0.0.1", watch: null },
    });
    await server.listen();
    port = (server.httpServer!.address() as AddressInfo).port;
  });

  after(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  /** POST with explicit Host/Origin/Content-Type (fetch can't set Host) */
  function post(path: string, body: unknown, headers: Record<string, string>): Promise<number> {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = request({ host: "127.0.0.1", port, path, method: "POST", headers: { "content-length": Buffer.byteLength(data), ...headers } }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      });
      req.on("error", reject);
      req.end(data);
    });
  }

  const local = () => ({ host: `localhost:${port}`, origin: `http://localhost:${port}`, "content-type": "application/json" });
  const knob = { file: "src/songs/x.ts", knobs: [{ name: "level", value: 0.25 }] };
  const song = { id: "y", text: SONG, create: true };

  for (const [name, path, body] of [
    ["knob write-back", "/__strudel/knob", knob],
    ["song save", "/__strudel/song", song],
  ] as const) {
    test(`${name}: foreign Host (DNS rebinding), foreign Origin, text/plain are refused`, async () => {
      const rebinding = { ...local(), host: `evil.example:${port}`, origin: `http://evil.example:${port}` };
      assert.equal(await post(path, body, rebinding), 403, "foreign Host");
      assert.equal(await post(path, body, { ...local(), origin: "https://evil.example" }), 403, "foreign Origin");
      assert.equal(await post(path, body, { ...local(), "content-type": "text/plain" }), 415, "text/plain");
    });
  }

  test("a localhost JSON request works", async () => {
    assert.equal(await post("/__strudel/knob", knob, local()), 200);
    assert.match(readFileSync(join(root, "src/songs/x.ts"), "utf8"), /knob\("level", 0\.25, 0, 1\)/);
    const { origin: _, ...noOrigin } = local();
    assert.equal(await post("/__strudel/song", song, noOrigin), 200, "no Origin (a script) is fine too");
    assert.equal(readFileSync(join(root, "src/songs/y.ts"), "utf8"), SONG);
  });

  test("bridge: a rebinding page can't connect; a localhost page can", async () => {
    const connect = (headers: Record<string, string>) =>
      new Promise<number | undefined>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/__strudel`, { headers });
        ws.once("unexpected-response", (_req, r) => (resolve(r.statusCode), ws.terminate()));
        ws.once("open", () => (resolve(101), ws.close()));
        ws.once("error", () => resolve(undefined));
      });
    assert.equal(await connect({ host: `evil.example:${port}`, origin: `http://evil.example:${port}` }), 403);
    assert.equal(await connect({ host: `localhost:${port}`, origin: `http://localhost:${port}` }), 101);
    assert.equal(await connect({ host: `localhost:${port}` }), 101, "editors send no Origin");
  });
});
