// Minimal WAV (RIFF) writer/reader: 16-bit PCM or 32-bit float, interleaved.

import { readFileSync, writeFileSync } from "node:fs";

/**
 * Encode channels as a WAV file. 16-bit output is clamped to [-1, 1] (the DAC clips
 * there too) with TPDF dither; 32-bit float keeps the raw values, overs included.
 * @param {Float32Array[]} channels
 * @returns {{ buffer: Buffer, clipped: number }}
 */
export function encodeWav(channels, sampleRate, { float = false, dither = true } = {}) {
  const numChannels = channels.length;
  const frames = channels[0].length;
  const bytesPerSample = float ? 4 : 2;
  const dataSize = frames * numChannels * bytesPerSample;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(float ? 3 : 1, 20); // 3 = IEEE float, 1 = PCM
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * numChannels * bytesPerSample, 28);
  buf.writeUInt16LE(numChannels * bytesPerSample, 32);
  buf.writeUInt16LE(bytesPerSample * 8, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  let clipped = 0;
  let off = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const x = channels[c][i];
      if (float) {
        buf.writeFloatLE(x, off);
        off += 4;
      } else {
        if (x > 1 || x < -1) clipped++;
        const d = dither ? (Math.random() - Math.random()) / 32768 : 0;
        const v = Math.max(-1, Math.min(1, x + d));
        buf.writeInt16LE(Math.round(v < 0 ? v * 32768 : v * 32767), off);
        off += 2;
      }
    }
  }
  return { buffer: buf, clipped };
}

export function writeWav(file, channels, sampleRate, opts) {
  const { buffer, clipped } = encodeWav(channels, sampleRate, opts);
  writeFileSync(file, buffer);
  return { clipped, bytes: buffer.length };
}

/** Read a 16-bit PCM or 32-bit float WAV into float channels. */
export function readWav(file) {
  const buf = readFileSync(file);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error(`${file}: not a WAV`);
  let off = 12;
  let fmt = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") {
      fmt = {
        format: buf.readUInt16LE(body),
        numChannels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data" && fmt) {
      const bytes = fmt.bits / 8;
      const frames = Math.floor(size / (bytes * fmt.numChannels));
      const channels = Array.from({ length: fmt.numChannels }, () => new Float32Array(frames));
      let p = body;
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < fmt.numChannels; c++) {
          if (fmt.format === 3) channels[c][i] = buf.readFloatLE(p);
          else if (fmt.bits === 16) channels[c][i] = buf.readInt16LE(p) / 32768;
          else throw new Error(`${file}: unsupported ${fmt.bits}-bit format ${fmt.format}`);
          p += bytes;
        }
      }
      return { sampleRate: fmt.sampleRate, channels };
    }
    off = body + size + (size & 1);
  }
  throw new Error(`${file}: no data chunk`);
}
