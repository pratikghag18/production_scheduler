/**
 * S57-a (brief §2) — `src/lib/voice/wav.ts`'s two pure functions: the WAV
 * header/encoding shape `encodeWav16k` must produce, and the loudness meter
 * `rmsOf` local recognition uses to find the edges of a spoken clip.
 */
import { describe, expect, it } from "vitest";
import { encodeWav16k, rmsOf } from "@/lib/voice/wav";

function readAscii(view: DataView, offset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += String.fromCharCode(view.getUint8(offset + i));
  return out;
}

describe("WAV: encodeWav16k (S57-a brief §2)", () => {
  it("WAV-1: the 44-byte RIFF/WAVE/fmt/data header, mono 16-bit at the given rate", () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1]);
    const sampleRate = 16000;
    const buffer = encodeWav16k(samples, sampleRate);
    const view = new DataView(buffer);

    expect(buffer.byteLength).toBe(44 + samples.length * 2);
    expect(readAscii(view, 0, 4)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(36 + samples.length * 2);
    expect(readAscii(view, 8, 4)).toBe("WAVE");
    expect(readAscii(view, 12, 4)).toBe("fmt ");
    expect(view.getUint32(16, true)).toBe(16); // fmt chunk size
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(sampleRate);
    expect(view.getUint32(28, true)).toBe(sampleRate * 2); // byte rate: rate * blockAlign
    expect(view.getUint16(32, true)).toBe(2); // block align: 1 channel * 2 bytes
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(readAscii(view, 36, 4)).toBe("data");
    expect(view.getUint32(40, true)).toBe(samples.length * 2);
  });

  it("WAV-2: samples clip at +/-1 rather than wrap", () => {
    const buffer = encodeWav16k(new Float32Array([2, -2]), 16000);
    const view = new DataView(buffer);
    expect(view.getInt16(44, true)).toBe(0x7fff);
    expect(view.getInt16(46, true)).toBe(-0x8000);
  });

  it("WAV-3: an empty clip is still a valid, silent WAV", () => {
    const buffer = encodeWav16k(new Float32Array([]), 16000);
    expect(buffer.byteLength).toBe(44);
    const view = new DataView(buffer);
    expect(view.getUint32(40, true)).toBe(0); // data chunk size
    expect(view.getUint32(4, true)).toBe(36);
  });

  it("WAV-4: an ordinary sample round-trips to the nearest 16-bit value", () => {
    const buffer = encodeWav16k(new Float32Array([0.5]), 16000);
    const view = new DataView(buffer);
    expect(view.getInt16(44, true)).toBe(Math.round(0.5 * 0x7fff));
  });

  it("WAV-5b: an odd sample count still produces a correct, even-scaled header", () => {
    const samples = new Float32Array([0, 0.25, -0.25]); // 3 samples -- odd
    const buffer = encodeWav16k(samples, 16000);
    expect(buffer.byteLength).toBe(44 + 6); // 3 samples * 2 bytes
    const view = new DataView(buffer);
    expect(view.getUint32(4, true)).toBe(36 + 6); // RIFF chunk size
    expect(view.getUint32(40, true)).toBe(6); // data chunk size
  });

  it("WAV-5c: samples are written little-endian, not just read back that way", () => {
    // 0.5 * 0x7fff = 16383.5 -> rounds to 16384 = 0x4000. Read the two
    // bytes directly (not through getInt16's own endianness flag) so this
    // does not just prove the write and the read agree with each other.
    const buffer = encodeWav16k(new Float32Array([0.5]), 16000);
    const view = new DataView(buffer);
    expect(view.getUint8(44)).toBe(0x00); // low byte first
    expect(view.getUint8(45)).toBe(0x40); // high byte second
  });

  it("WAV-5d: a NaN sample does not throw and is not left as NaN bytes", () => {
    // Review finding (brief attack list §3): a ScriptProcessorNode frame can
    // in principle carry a NaN if upstream Web Audio nodes produce one (a
    // clipped/underrun buffer). `encodeWav16k` must degrade to something
    // playable, not throw mid-clip and lose the whole recording.
    const buffer = encodeWav16k(new Float32Array([0.25, NaN, -0.25]), 16000);
    expect(buffer.byteLength).toBe(44 + 6);
    const view = new DataView(buffer);
    // DataView#setInt16 follows the spec's ToInt16, which maps NaN to 0 --
    // pinned here so a future change to the clamp/scale math that breaks
    // this (e.g. an unguarded Math.round producing a throwing path) is
    // caught, not just silently different.
    expect(view.getInt16(46, true)).toBe(0);
  });
});

describe("WAV: rmsOf (S57-a brief §2)", () => {
  it("WAV-5: silence has zero RMS", () => {
    expect(rmsOf(new Float32Array([0, 0, 0, 0]))).toBe(0);
  });

  it("WAV-6: a full-scale square wave has RMS 1", () => {
    expect(rmsOf(new Float32Array([1, -1, 1, -1]))).toBeCloseTo(1, 10);
  });

  it("WAV-7: an empty frame is zero, not NaN", () => {
    expect(rmsOf(new Float32Array([]))).toBe(0);
  });
});
