// The songs store without a browser: share links, saved songs in a fake
// localStorage, the boot hook against a fake player, and the dev server's
// song-file endpoint validation.
//
// Run: node --test test/store.test.ts   (Node ≥ 22.18 strips TS types)

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, test } from "node:test";
import { MAX_SONG_BODY_BYTES, SongWriteError, checkSongRequest, readBody, songWriteTarget, writeSongFile } from "../vite-plugins/strudel-songs.ts";
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

  test("a user song not listed yet (still compiling at boot): the player is told to cancel it", () => {
    const { store, player } = setup();
    store.saveOverride("wobble", SONG);
    assert.equal(player.hasSong("wobble"), false);
    assert.equal(store.revert("wobble"), true);
    assert.deepEqual(player.calls, [["removeSong", "wobble"]]);
  });

  test("nothing to revert: false", () => {
    const { store } = setup();
    assert.equal(store.revert("ghost"), false);
  });
});

describe("discard", () => {
  test("removes a saved entry without telling the player anything", () => {
    const { store, storage, player } = setup();
    store.saveOverride("jynx", "mine");
    assert.equal(store.discard("jynx"), true);
    assert.equal(storage.map.size, 0);
    assert.equal(store.getMySong("jynx"), null);
    assert.deepEqual(player.calls, [], "an IDE's live buffer (or the music) stays as it is");
  });

  test("nothing saved, a bad id or blocked storage: false, never throws", () => {
    assert.equal(setup().store.discard("ghost"), false);
    assert.equal(setup().store.discard("../x"), false);
    assert.equal(setup({ storage: throwingStorage }).store.discard("jynx"), false);
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

  test("asks first: a declined link runs nothing; an accepted one opens", async () => {
    const { store, player } = setup();
    const hash = `#song=${await encodeShare("wobble", SONG)}`;
    const asked: unknown[] = [];
    const declined = await store.loadFromHash(hash, { confirm: (song) => (asked.push(song), false) });
    assert.deepEqual(declined, { ok: false, error: "The shared song was not opened.", declined: true });
    assert.deepEqual(asked, [{ id: "wobble", text: SONG }], "the question sees the id and the text");
    assert.deepEqual(player.calls, [], "nothing compiled, nothing selected");
    assert.deepEqual(await store.loadFromHash(hash, { confirm: async () => true }), { ok: true, id: "wobble" });
    assert.deepEqual(player.calls, [["addSong", "wobble", SONG], ["selectSong", "wobble"]]);
  });

  test("boot passes its confirmShare to the link", async () => {
    const hash = `#song=${await encodeShare("wobble", SONG)}`;
    const { store, player } = setup({ location: { href: `https://example.org/${hash}`, hash } });
    const report = await store.init(player, { confirmShare: () => false });
    assert.equal(report.shared?.ok, false);
    assert.deepEqual(player.calls, []);
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

  // The replay awaits each song's compile in turn: what the user does to the
  // later songs meanwhile (revert, edit) must win over what boot read first.
  describe("while an earlier stored song is still compiling", () => {
    /** Boot with "slow" (a user song whose addSong is held) stored first, then `later` */
    async function bootHeld(later: [id: string, kind: string, text: string]) {
      const { store, storage, player } = setup();
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      // like the real player's sequence guard: removeSong cancels the add still compiling
      let cancelled = false;
      const addSong = player.addSong.bind(player);
      player.addSong = async (id, text) => {
        if (id !== "slow") return addSong(id, text);
        await held;
        return cancelled ? { ok: false, error: { message: "superseded by a newer edit" } } : addSong(id, text);
      };
      const removeSong = player.removeSong.bind(player);
      player.removeSong = (id) => {
        if (id === "slow") cancelled = true;
        return removeSong(id);
      };
      storage.setItem(`${PREFIX}slow`, entry("user", "s", 2));
      storage.setItem(`${PREFIX}${later[0]}`, entry(later[1], later[2], 1));
      const booted = store.init(player);
      await Promise.resolve();
      assert.equal(player.calls.length, 0, "slow is still compiling");
      return { store, storage, player, booted, release };
    }

    test("a user song reverted meanwhile isn't added back", async () => {
      const { store, storage, player, booted, release } = await bootHeld(["wobble", "user", "w"]);
      assert.equal(store.revert("wobble"), true);
      release();
      const report = await booted;
      assert.deepEqual(player.calls.filter((c) => c[1] === "wobble"), [["removeSong", "wobble"]]);
      assert.equal(player.hasSong("wobble"), false);
      assert.equal(storage.getItem(`${PREFIX}wobble`), null);
      assert.ok(player.hasSong("slow"));
      assert.deepEqual(report.failed, []);
    });

    test("an override reverted meanwhile isn't evaluated back", async () => {
      const { store, storage, player, booted, release } = await bootHeld(["jynx", "override", "j"]);
      assert.equal(store.revert("jynx"), true);
      release();
      const report = await booted;
      assert.deepEqual(player.calls.filter((c) => c[1] === "jynx"), [["revertSource", "jynx"]]);
      assert.equal(storage.getItem(`${PREFIX}jynx`), null);
      assert.deepEqual(report.failed, []);
    });

    test("the compiling song itself reverted: the player drops it, and it isn't reported as failing", async () => {
      const { store, storage, player, booted, release } = await bootHeld(["wobble", "user", "w"]);
      assert.equal(store.revert("slow"), true);
      release();
      const report = await booted;
      assert.equal(storage.getItem(`${PREFIX}slow`), null);
      assert.deepEqual(report.failed, []);
      assert.ok(player.hasSong("wobble"));
    });

    test("a song edited meanwhile is replayed with its newest text", async () => {
      const { store, player, booted, release } = await bootHeld(["jynx", "override", "j"]);
      store.saveOverride("jynx", "j2");
      release();
      await booted;
      assert.deepEqual(player.calls.filter((c) => c[1] === "jynx"), [["evalSource", "jynx", "j2", { intent: "commit", origin: "browser" }]]);
    });

    test("a user song edited meanwhile is added with its newest text, and known by it", async () => {
      const { store, player, booted, release } = await bootHeld(["wobble", "user", "w"]);
      store.saveOverride("wobble", "w2");
      release();
      await booted;
      assert.deepEqual(player.calls.filter((c) => c[1] === "wobble"), [["addSong", "wobble", "w2"]]);
      // with the saved entry gone, the store still knows the song by the text it added:
      // a share link with that text reuses it instead of opening a copy
      store.discard("wobble");
      const hash = `#song=${await encodeShare("wobble", "w2")}`;
      assert.deepEqual(await store.loadFromHash(hash), { ok: true, id: "wobble" });
    });
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

  test("an edit saved while the request was out stays: only the text that reached the file is dropped", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const log: FetchLog = [];
    const inner = devFetch(log);
    const slow = (async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") await gate;
      return inner(url, init);
    }) as typeof fetch;
    const { store } = setup({ dev: true, fetch: slow });
    store.saveOverride("wobble", SONG);
    const saving = store.saveToFile("wobble", SONG, { create: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    store.saveOverride("wobble", user("Newer"));
    release();
    assert.equal((await saving).ok, true);
    assert.equal(store.getMySong("wobble")?.text, user("Newer"), "the newer edit is kept");
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

// ─────────────────────────────────────────────────────────────────────────────
// Dev server endpoint: POST /__strudel/song
// ─────────────────────────────────────────────────────────────────────────────

describe("song file endpoint", () => {
  const root = "/work/app";
  const status = (fn: () => unknown) => {
    try {
      fn();
    } catch (err) {
      if (err instanceof SongWriteError) return err.status;
      throw err;
    }
    return 0;
  };

  test("a valid write targets src/songs/<id>.ts under the root", () => {
    assert.deepEqual(songWriteTarget({ id: "wobble", text: SONG, create: true }, root), {
      id: "wobble",
      text: SONG,
      create: true,
      abs: join(root, "src/songs/wobble.ts"),
      file: "src/songs/wobble.ts",
    });
    assert.equal(songWriteTarget({ id: "wobble", text: "" }, root).create, false, "create defaults to false");
  });

  test("ids that would escape src/songs or name a non-song file are refused", () => {
    const ids = ["../x", "..%2fx", "..%2F..%2Fpackage", "..", ".", "a/b", "a\\b", "/etc/passwd", "src/songs/x", "index", "_template", "_x", ".hidden", "x.ts", "", "Wobble", "a".repeat(65), 5, null];
    for (const id of ids) assert.equal(status(() => songWriteTarget({ id, text: "x" }, root)), 400, String(id));
  });

  test("text must be a string within MAX_EVAL_CHARS", () => {
    assert.equal(status(() => songWriteTarget({ id: "a", text: 5 }, root)), 400);
    assert.equal(status(() => songWriteTarget({ id: "a" }, root)), 400);
    assert.equal(status(() => songWriteTarget({ id: "a", text: "x".repeat(MAX_EVAL_CHARS + 1) }, root)), 413);
    assert.equal(status(() => songWriteTarget({ id: "a", text: "x".repeat(MAX_EVAL_CHARS) }, root)), 0);
    assert.equal(status(() => songWriteTarget({ id: "a", text: "x", create: "yes" }, root)), 400);
    for (const payload of [null, [], "x", 1]) assert.equal(status(() => songWriteTarget(payload, root)), 400);
  });

  test("only JSON from this page: content type and Origin are checked", () => {
    const ok = { contentType: "application/json", host: "localhost:5426" };
    assert.equal(status(() => checkSongRequest(ok)), 0);
    assert.equal(status(() => checkSongRequest({ ...ok, contentType: "application/json; charset=utf-8" })), 0);
    assert.equal(status(() => checkSongRequest({ ...ok, origin: "http://localhost:5426" })), 0, "same origin");
    assert.equal(status(() => checkSongRequest({ ...ok, origin: "http://LOCALHOST:5426" })), 0, "host is case-insensitive");
    for (const contentType of [undefined, "text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/jsonx"]) {
      assert.equal(status(() => checkSongRequest({ ...ok, contentType })), 415, String(contentType));
    }
    for (const origin of ["https://evil.example", "http://localhost:5427", "http://localhost", "null", "garbage"]) {
      assert.equal(status(() => checkSongRequest({ ...ok, origin })), 403, origin);
    }
    assert.equal(status(() => checkSongRequest({ contentType: "application/json", origin: "http://localhost:5426" })), 403, "Origin without Host");
  });

  test("the body is capped while reading", async () => {
    const chunks = (n: number, size: number) => Readable.from(Array.from({ length: n }, () => Buffer.alloc(size, 0x61)));
    assert.equal((await readBody(chunks(4, 10), 40)).length, 40);
    await assert.rejects(readBody(chunks(5, 10), 40), (e: SongWriteError) => e.status === 413);
    assert.equal(await readBody(Readable.from([Buffer.from("é", "utf8").subarray(0, 1), Buffer.from("é", "utf8").subarray(1)]), 40), "é", "UTF-8 split across chunks");
    assert.ok(MAX_SONG_BODY_BYTES > MAX_EVAL_CHARS * 3);
  });

  describe("writing", () => {
    let dir = "";
    const target = (id: string, text: string, create = false) => songWriteTarget({ id, text, create }, dir);
    const songs = () => readdirSync(join(dir, "src/songs")).sort();

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "strudel-songs-"));
      mkdirSync(join(dir, "src/songs"), { recursive: true });
      writeFileSync(join(dir, "src/songs/jynx.ts"), "old");
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    test("create writes a new file; an existing one is a 409, untouched", async () => {
      assert.deepEqual(await writeSongFile(target("wobble", SONG, true)), { file: "src/songs/wobble.ts", created: true });
      assert.equal(readFileSync(join(dir, "src/songs/wobble.ts"), "utf8"), SONG);
      await assert.rejects(writeSongFile(target("jynx", "new", true)), (e: SongWriteError) => e.status === 409);
      assert.equal(readFileSync(join(dir, "src/songs/jynx.ts"), "utf8"), "old");
      assert.deepEqual(songs(), ["jynx.ts", "wobble.ts"], "no temp files left");
    });

    test("overwrite replaces an existing file; a missing one is a 404", async () => {
      assert.deepEqual(await writeSongFile(target("jynx", SONG)), { file: "src/songs/jynx.ts", created: false });
      assert.equal(readFileSync(join(dir, "src/songs/jynx.ts"), "utf8"), SONG);
      await assert.rejects(writeSongFile(target("ghost", "x")), (e: SongWriteError) => e.status === 404);
      assert.deepEqual(songs(), ["jynx.ts"], "no temp files left");
    });
  });
});
