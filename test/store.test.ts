// The songs store without a browser: share links, saved songs in a fake
// localStorage, the boot hook against a fake player, and the dev server's
// song-file endpoint validation.
//
// Run: node --test test/store.test.ts   (Node ≥ 22.18 strips TS types)

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MAX_EVAL_CHARS } from "../src/live/protocol.ts";
import { MAX_SHARE_BYTES, decodeShare, encodeShare, inflateCapped } from "../src/songs-store/share.ts";
import { createSongsStore, type EvalResult, type SongsStoreDeps, type StorePlayer, type StoreStorage } from "../src/songs-store/index.ts";

const SONG = `export default {\n  name: "Wobble — ünïcødé 🎵",\n  createPattern: () => ({ kick: s("bd*4") }),\n};\n`;

/** base64url of raw bytes (no compression), for hand-made bad payloads */
function b64url(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("base64url");
}

/** deflate-raw some bytes, as a share link would */
async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const utf8 = (s: string) => new TextEncoder().encode(s);

describe("share links", () => {
  test("round-trip id and text byte-exactly", async () => {
    const payload = await encodeShare("wobble", SONG);
    assert.match(payload, /^[A-Za-z0-9_-]+$/, "base64url, no padding");
    assert.deepEqual(await decodeShare(`#song=${payload}`), { id: "wobble", text: SONG });
    assert.deepEqual(await decodeShare(`song=${payload}`), { id: "wobble", text: SONG }, "leading # optional");
    assert.deepEqual(await decodeShare(`#x=1&song=${payload}`), { id: "wobble", text: SONG }, "among other params");
  });

  test("malformed hashes decode to null", async () => {
    const good = await encodeShare("wobble", SONG);
    const cases: [string, string][] = [
      ["empty", ""],
      ["no song param", "#foo=bar"],
      ["empty payload", "#song="],
      ["not base64url", "#song=%%%***"],
      ["truncated", `#song=${good.slice(0, good.length >> 1)}`],
      ["not deflate", `#song=${b64url(utf8("hello there, not compressed"))}`],
      ["deflated non-JSON", `#song=${b64url(await deflate(utf8("not json")))}`],
      ["wrong version", `#song=${b64url(await deflate(utf8(JSON.stringify({ v: 2, id: "a", text: "x" }))))}`],
      ["text not a string", `#song=${b64url(await deflate(utf8(JSON.stringify({ v: 1, id: "a", text: 5 }))))}`],
      ["traversal id", `#song=${b64url(await deflate(utf8(JSON.stringify({ v: 1, id: "../x", text: "x" }))))}`],
      ["reserved id", `#song=${b64url(await deflate(utf8(JSON.stringify({ v: 1, id: "index", text: "x" }))))}`],
      ["JSON null", `#song=${b64url(await deflate(utf8("null")))}`],
    ];
    for (const [name, hash] of cases) assert.equal(await decodeShare(hash), null, name);
  });

  test("text over MAX_EVAL_CHARS is refused both ways", async () => {
    const big = "a".repeat(MAX_EVAL_CHARS + 1);
    await assert.rejects(encodeShare("big", big), /too large/);
    const payload = b64url(await deflate(utf8(JSON.stringify({ v: 1, id: "big", text: big }))));
    assert.equal(await decodeShare(`#song=${payload}`), null);
    const fits = "a".repeat(MAX_EVAL_CHARS);
    assert.equal((await decodeShare(`#song=${await encodeShare("fits", fits)}`))?.text.length, MAX_EVAL_CHARS);
  });

  test("a decompression bomb stops at the cap instead of inflating it all", async () => {
    // 64 MB of zeros deflates to ~64 KB; decoding must give up past MAX_SHARE_BYTES
    const zeros = new Uint8Array(64 * 1024 * 1024);
    const payload = b64url(await deflate(zeros));
    assert.equal(await decodeShare(`#song=${payload}`), null);
    assert.ok(MAX_SHARE_BYTES < zeros.length);
  });

  test("inflation is capped while streaming", async () => {
    const data = utf8("x".repeat(100_000));
    const packed = await deflate(data);
    assert.equal((await inflateCapped(packed, 100_000))?.length, 100_000, "at the cap: whole");
    assert.equal(await inflateCapped(packed, 99_999), null, "one byte past the cap: refused");
    assert.equal(await inflateCapped(await deflate(new Uint8Array(64 * 1024 * 1024)), 4096), null, "bomb: refused");
  });

  test("an encoded payload longer than any valid share is refused before decoding", async () => {
    assert.equal(await decodeShare(`#song=${"A".repeat(MAX_SHARE_BYTES * 2)}`), null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fakes
// ─────────────────────────────────────────────────────────────────────────────

/** In-memory Storage with key()/length, like localStorage */
class MemoryStorage implements StoreStorage {
  map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, String(v));
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

const blocked = () => {
  throw new DOMException("blocked", "SecurityError");
};

/** Storage that throws on every access (private mode, blocked storage, quota) */
const throwingStorage: StoreStorage = {
  get length(): number {
    return blocked();
  },
  key: blocked,
  getItem: blocked,
  setItem: () => {
    throw new DOMException("quota", "QuotaExceededError");
  },
  removeItem: blocked,
};

type Call = [method: string, ...args: unknown[]];

/** A player with some built-in songs that records what the store tells it */
class FakePlayer implements StorePlayer {
  calls: Call[] = [];
  user = new Set<string>();
  failAdd = new Map<string, string>();
  builtIn = new Set(["acid-rain", "jynx"]);
  isBuiltInSong(id: string) {
    return this.builtIn.has(id);
  }
  hasSong(id: string) {
    return this.builtIn.has(id) || this.user.has(id);
  }
  async addSong(id: string, text: string): Promise<EvalResult> {
    this.calls.push(["addSong", id, text]);
    const error = this.failAdd.get(id);
    if (error) return { ok: false, error: { message: error, line: 2 } };
    this.user.add(id);
    return { ok: true, version: "v" };
  }
  removeSong(id: string) {
    this.calls.push(["removeSong", id]);
    return this.user.delete(id);
  }
  async evalSource(songId: string, text: string, opts: { intent: "typing" | "commit"; origin: "browser" | "editor" }): Promise<EvalResult> {
    this.calls.push(["evalSource", songId, text, opts]);
    return { ok: true, version: "v" };
  }
  revertSource(songId: string) {
    this.calls.push(["revertSource", songId]);
  }
  async selectSong(id: string) {
    this.calls.push(["selectSong", id]);
    return this.hasSong(id);
  }
}

const PREFIX = "strudel-ide:my-song:";
type FetchLog = [url: string, init: RequestInit | undefined][];

function setup(over: Partial<SongsStoreDeps> = {}) {
  const storage = new MemoryStorage();
  const player = new FakePlayer();
  const fetches: FetchLog = [];
  let clock = 1000;
  const store = createSongsStore({
    storage,
    player,
    location: { href: "https://example.org/strudel-ide/?x=1#old", hash: "" },
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      fetches.push([String(url), init]);
      return new Response("nope", { status: 404 });
    }) as typeof fetch,
    now: () => clock++,
    dev: false,
    baseUrl: "/",
    ...over,
  });
  return { store, storage, player, fetches };
}

const user = (name: string) => `export default {\n  name: "${name}",\n  createPattern: () => s("bd"),\n};\n`;
const entry = (kind: string, text: string, updatedAt: number) => JSON.stringify({ v: 1, kind, text, updatedAt });

// ─────────────────────────────────────────────────────────────────────────────

describe("my songs", () => {
  test("saveOverride stores a built-in's edit as an override and anything else as a user song", () => {
    const { store, storage, player } = setup();
    const a = store.saveOverride("acid-rain", user("Acid Rain (mine)"));
    const b = store.saveOverride("wobble", user("Wobble"));
    assert.equal(a.kind, "override");
    assert.equal(b.kind, "user");
    assert.equal(a.persisted, true);
    assert.deepEqual(
      store.listMySongs().map(({ id, kind, name }) => ({ id, kind, name })),
      [
        { id: "wobble", kind: "user", name: "Wobble" },
        { id: "acid-rain", kind: "override", name: "Acid Rain (mine)" },
      ],
      "newest first"
    );
    assert.deepEqual(store.getMySong("wobble"), { id: "wobble", kind: "user", name: "Wobble", text: user("Wobble"), updatedAt: 1001 });
    assert.equal(store.getMySong("nope"), null);
    assert.ok(storage.map.has(`${PREFIX}wobble`), "under the strudel-ide: prefix");
    assert.deepEqual(player.calls, [], "persists only, doesn't evaluate");
  });

  test("saving again replaces the entry", () => {
    const { store } = setup();
    store.saveOverride("wobble", "one");
    store.saveOverride("wobble", "two");
    assert.deepEqual(store.listMySongs().map((s) => [s.id, s.text, s.name]), [["wobble", "two", null]]);
  });

  test("saveOverride refuses an id that can't name a song file", () => {
    const { store } = setup();
    for (const id of ["../x", "index", "_template", "Upper", ""]) assert.throws(() => store.saveOverride(id, "x"), /song id|reserved/, id);
  });

  test("corrupt and foreign entries are skipped, not thrown", () => {
    const { store, storage } = setup();
    storage.setItem(`${PREFIX}broken`, "{not json");
    storage.setItem(`${PREFIX}nulled`, "null");
    storage.setItem(`${PREFIX}notext`, JSON.stringify({ v: 1, kind: "user", updatedAt: 1 }));
    storage.setItem(`${PREFIX}../evil`, entry("user", "x", 1));
    storage.setItem("strudel-ide:mix:jynx", "{}");
    storage.setItem("other-app:my-song:x", entry("user", "x", 1));
    storage.setItem(`${PREFIX}ok`, entry("user", "fine", 5));
    assert.deepEqual(store.listMySongs().map((s) => s.id), ["ok"]);
    assert.equal(store.getMySong("broken"), null);
    assert.equal(store.getMySong("../evil"), null);
  });

  test("kind follows the player: an override whose built-in is gone lists as a user song", () => {
    const { store, player } = setup();
    store.saveOverride("jynx", "x");
    player.builtIn.delete("jynx");
    assert.equal(store.getMySong("jynx")?.kind, "user");
  });

  test("blocked storage: nothing listed, saves report persisted: false, nothing throws", async () => {
    const storages: SongsStoreDeps["storage"][] = [throwingStorage, blocked];
    for (const storage of storages) {
      const { store, player } = setup({ storage });
      assert.deepEqual(store.listMySongs(), []);
      assert.equal(store.getMySong("x"), null);
      const saved = store.saveOverride("wobble", "x");
      assert.equal(saved.persisted, false);
      assert.equal(saved.text, "x");
      player.user.add("wobble");
      assert.equal(store.revert("wobble"), true);
      await store.init(player);
      assert.deepEqual(player.calls, [["removeSong", "wobble"]]);
    }
  });
});

describe("revert", () => {
  test("an override: entry gone, the built-in text plays again", () => {
    const { store, storage, player } = setup();
    store.saveOverride("jynx", "mine");
    assert.equal(store.revert("jynx"), true);
    assert.equal(storage.map.size, 0);
    assert.deepEqual(player.calls, [["revertSource", "jynx"]]);
  });

  test("a user song: entry gone and the song leaves the list", () => {
    const { store, storage, player } = setup();
    store.saveOverride("wobble", "mine");
    player.user.add("wobble");
    assert.equal(store.revert("wobble"), true);
    assert.equal(storage.map.size, 0);
    assert.deepEqual(player.calls, [["removeSong", "wobble"]]);
    assert.equal(player.hasSong("wobble"), false);
  });

  test("nothing to revert: false", () => {
    const { store } = setup();
    assert.equal(store.revert("ghost"), false);
  });
});

describe("share and open", () => {
  test("shareUrl keeps path and query, replaces the hash, and decodes back", async () => {
    const { store } = setup();
    const url = await store.shareUrl("wobble", SONG);
    assert.match(url, /^https:\/\/example\.org\/strudel-ide\/\?x=1#song=[A-Za-z0-9_-]+$/);
    assert.deepEqual(await store.decodeShare(new URL(url).hash), { id: "wobble", text: SONG });
    assert.match(await store.shareUrl("a", "b", "http://localhost:5426/#song=old"), /^http:\/\/localhost:5426\/#song=[A-Za-z0-9_-]+$/);
  });

  test("no #song=: null, nothing happens", async () => {
    const { store, player } = setup();
    assert.equal(await store.loadFromHash(""), null);
    assert.equal(await store.loadFromHash("#foo=1"), null);
    assert.equal(await store.loadFromHash(), null, "defaults to location.hash");
    assert.deepEqual(player.calls, []);
  });

  test("a damaged link: an error, nothing happens", async () => {
    const { store, player } = setup();
    const result = await store.loadFromHash("#song=AAAA");
    assert.equal(result?.ok, false);
    assert.deepEqual(player.calls, []);
  });

  test("a new id: added and selected, not persisted, not played", async () => {
    const { store, storage, player } = setup();
    const hash = `#song=${await encodeShare("wobble", SONG)}`;
    assert.deepEqual(await store.loadFromHash(hash), { ok: true, id: "wobble" });
    assert.deepEqual(player.calls, [["addSong", "wobble", SONG], ["selectSong", "wobble"]]);
    assert.equal(storage.map.size, 0);
  });

  test("a built-in's id: opened under a free -shared id", async () => {
    const { store, player } = setup();
    player.user.add("jynx-shared");
    const hash = `#song=${await encodeShare("jynx", SONG)}`;
    assert.deepEqual(await store.loadFromHash(hash), { ok: true, id: "jynx-shared-2" });
    assert.deepEqual(player.calls, [["addSong", "jynx-shared-2", SONG], ["selectSong", "jynx-shared-2"]]);
  });

  test("an existing user song with other text: a free id; with the same text: reused", async () => {
    const { store, player } = setup();
    store.saveOverride("wobble", "older text");
    player.user.add("wobble");
    const hash = `#song=${await encodeShare("wobble", SONG)}`;
    assert.deepEqual(await store.loadFromHash(hash), { ok: true, id: "wobble-shared" });
    player.calls = [];
    assert.deepEqual(await store.loadFromHash(hash), { ok: true, id: "wobble-shared" }, "opening it again reuses it");
    assert.deepEqual(player.calls, [["selectSong", "wobble-shared"]]);
    store.saveOverride("wobble", SONG);
    player.calls = [];
    assert.deepEqual(await store.loadFromHash(hash), { ok: true, id: "wobble" }, "same id, same saved text");
    assert.deepEqual(player.calls, [["selectSong", "wobble"]]);
  });

  test("a long id stays a valid id when suffixed", async () => {
    const { store, player } = setup();
    const id = "a".repeat(64);
    player.user.add(id);
    const result = await store.loadFromHash(`#song=${await encodeShare(id, SONG)}`);
    assert.deepEqual(result, { ok: true, id: `${"a".repeat(57)}-shared` });
  });

  test("a song that doesn't compile: the error, not selected", async () => {
    const { store, player } = setup();
    player.failAdd.set("wobble", "Unexpected token");
    assert.deepEqual(await store.loadFromHash(`#song=${await encodeShare("wobble", SONG)}`), { ok: false, error: "Unexpected token (line 2)" });
    assert.deepEqual(player.calls, [["addSong", "wobble", SONG]]);
  });
});

describe("boot", () => {
  test("nothing stored, no hash: the player isn't touched", async () => {
    const { store, player, fetches } = setup();
    await store.init(player);
    assert.deepEqual(player.calls, []);
    assert.deepEqual(fetches, []);
  });

  test("registers user songs, applies overrides, then opens the hash", async () => {
    const hash = `#song=${await encodeShare("shared-one", SONG)}`;
    const { store, storage, player } = setup({ location: { href: "https://example.org/", hash } });
    storage.setItem(`${PREFIX}wobble`, entry("user", "w", 2));
    storage.setItem(`${PREFIX}jynx`, entry("override", "j", 1));
    storage.setItem(`${PREFIX}gone`, entry("override", "g", 3));
    storage.setItem(`${PREFIX}broken`, "{");
    const report = await store.init(player);
    const commit = { intent: "commit", origin: "browser" };
    assert.deepEqual(
      player.calls.slice(0, 3).sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
      [["addSong", "gone", "g"], ["evalSource", "jynx", "j", commit], ["addSong", "wobble", "w"]],
      "an override whose built-in is gone comes back as a user song"
    );
    assert.deepEqual(player.calls.slice(3), [["addSong", "shared-one", SONG], ["selectSong", "shared-one"]]);
    assert.deepEqual(report, { failed: [], shared: { ok: true, id: "shared-one" } });
  });

  test("a stored song that fails to compile doesn't stop the others", async () => {
    const { store, storage, player } = setup();
    player.failAdd.set("bad", "boom");
    storage.setItem(`${PREFIX}bad`, entry("user", "b", 2));
    storage.setItem(`${PREFIX}good`, entry("user", "g", 1));
    const report = await store.init(player);
    assert.deepEqual(report.failed, [{ id: "bad", error: "boom (line 2)" }]);
    assert.ok(player.hasSong("good"));
    assert.ok(store.getMySong("bad"), "kept: the user can fix it");
  });
});

describe("save to file", () => {
  const devFetch = (log: FetchLog, reply: object = { ok: true, file: "src/songs/wobble.ts", created: true }, status = 200) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      log.push([String(url), init]);
      if (!init?.method || init.method === "GET") return Response.json({ ok: true });
      return Response.json(reply, { status });
    }) as typeof fetch;

  test("not under the dev server: unavailable, no request", async () => {
    const { store, fetches } = setup();
    assert.equal(await store.canSaveToFile(), false);
    const result = await store.saveToFile("wobble", "x");
    assert.equal(result.ok, false);
    assert.deepEqual(fetches, []);
  });

  test("dev server: probes once under Vite's base", async () => {
    const log: FetchLog = [];
    const { store } = setup({ dev: true, baseUrl: "/strudel-ide/", fetch: devFetch(log) });
    assert.equal(await store.canSaveToFile(), true);
    assert.equal(await store.canSaveToFile(), true);
    assert.deepEqual(log.map(([url, init]) => [url, init?.method ?? "GET"]), [["/strudel-ide/__strudel/song", "GET"]]);
  });

  test("dev mode without the endpoint (or offline): unavailable", async () => {
    const fetches = [
      async () => new Response("<html>", { status: 404 }),
      async () => new Response("<html>", { status: 200 }),
      async () => {
        throw new TypeError("offline");
      },
    ] as (typeof fetch)[];
    for (const fetch of fetches) {
      const { store } = setup({ dev: true, fetch });
      assert.equal(await store.canSaveToFile(), false);
    }
  });

  test("posts the song as JSON and drops the browser copy once the file has it", async () => {
    const log: FetchLog = [];
    const { store } = setup({ dev: true, fetch: devFetch(log) });
    store.saveOverride("wobble", SONG);
    assert.deepEqual(await store.saveToFile("wobble", SONG, { create: true }), { ok: true, file: "src/songs/wobble.ts", created: true });
    const [url, init] = log[1];
    assert.equal(url, "/__strudel/song");
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("content-type"), "application/json");
    assert.deepEqual(JSON.parse(String(init?.body)), { id: "wobble", text: SONG, create: true });
    assert.equal(store.getMySong("wobble"), null);
  });

  test("a refused write keeps the browser copy and returns the server's error", async () => {
    const log: FetchLog = [];
    const { store } = setup({ dev: true, fetch: devFetch(log, { ok: false, error: "src/songs/wobble.ts already exists" }, 409) });
    store.saveOverride("wobble", SONG);
    assert.deepEqual(await store.saveToFile("wobble", SONG, { create: true }), { ok: false, error: "src/songs/wobble.ts already exists" });
    assert.ok(store.getMySong("wobble"));
  });

  test("a bad id is refused without a request", async () => {
    const log: FetchLog = [];
    const { store } = setup({ dev: true, fetch: devFetch(log) });
    const result = await store.saveToFile("../x", SONG);
    assert.equal(result.ok, false);
    assert.equal(log.length, 0);
  });
});

describe("download", () => {
  test("the exact text as <id>.ts through a temporary link", async () => {
    const clicked: { download: string; href: string }[] = [];
    const blobs: Blob[] = [];
    const { store } = setup({
      document: {
        createElement: () => {
          const a = { download: "", href: "", click: () => clicked.push({ download: a.download, href: a.href }) };
          return a as unknown as HTMLAnchorElement;
        },
      },
      objectUrls: {
        createObjectURL: (b: Blob) => (blobs.push(b), "blob:1"),
        revokeObjectURL: () => {},
      },
    });
    store.download("wobble", SONG);
    assert.deepEqual(clicked, [{ download: "wobble.ts", href: "blob:1" }]);
    assert.equal(await blobs[0].text(), SONG);
  });
});
