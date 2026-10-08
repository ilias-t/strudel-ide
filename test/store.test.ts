// The songs store without a browser: share links, saved songs in a fake
// localStorage, the boot hook against a fake player, and the dev server's
// song-file endpoint validation.
//
// Run: node --test test/store.test.ts   (Node ≥ 22.18 strips TS types)

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MAX_EVAL_CHARS } from "../src/live/protocol.ts";
import { MAX_SHARE_BYTES, decodeShare, encodeShare, inflateCapped } from "../src/songs-store/share.ts";

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
