// scripts/voice/clips/lib/wavGain.mjs -- S71-k (brief docs/agent-briefs/
// s71-k-clip-file-collision-and-gain-brief.md, R-453/F-210): pure sample
// maths for `score.mjs`'s `--gain` flag. F-210 measured the maintainer's
// own three real clips at peak RMS 0.037-0.065 -- a third to a tenth of the
// 0.12-0.39 whisper.cpp's own onset/silence rules were tuned against -- so
// this library lets `--gain` boost a clip's samples before it is posted to
// Whisper and MEASURE whether that helps, rather than tune the recogniser
// on a feeling (R-453: measure first; nothing in the recogniser changes in
// this lane).
//
// No I/O: every function here takes a WAV Buffer/Uint8Array/ArrayBuffer and
// is otherwise pure. 16-bit PCM MONO only. Reviewer finding: a fixed
// 44-byte offset assumed the exact chunk layout `record.mjs`'s own
// `encodeWav16k` happens to write and nothing else -- a WAV with so much as
// one extra chunk before "data" (a `LIST`/`INFO` chunk, which some
// encoders/editors add) would have its "samples" read starting midway
// through that chunk instead. The header is now read properly: the
// "RIFF"/"WAVE" magic is checked first, then every chunk from byte 12
// onward is walked by its own declared size (each chunk word-aligned, one
// pad byte after an odd-sized body, same rule the RIFF spec sets) until
// both a "fmt " chunk (channels, bits, sample rate) and a "data" chunk
// (where the samples actually start) are found, in whichever order they
// appear.
//
// Amplitude is read and written with the SAME asymmetric int16<->[-1,1]
// mapping `encodeWav16k` itself uses when it writes a clip -- a negative
// sample scales over 0x8000, a positive (or zero) one over 0x7fff, so +1.0
// and -1.0 each round-trip to their own true int16 extreme (32767 /
// -32768) instead of sharing one divisor and leaving one side unreachable.

import { Buffer } from "node:buffer";

/** `instanceof Uint8Array`/`instanceof ArrayBuffer` are realm-sensitive --
 *  `src/test/voiceClips.test.ts` runs under vitest's jsdom environment,
 *  whose `Uint8Array`/`ArrayBuffer` are NOT the same class objects a Node
 *  `Buffer` (built in Node's own realm) is an instance of, even though a
 *  `Buffer` genuinely is a `Uint8Array` at runtime. `ArrayBuffer.isView` and
 *  a `[[Class]]` tag check are both realm-independent (spec-defined on the
 *  object's internal slot, not the calling realm's constructor identity),
 *  so both a same-realm and cross-realm `Buffer`/`Uint8Array`/`ArrayBuffer`
 *  are accepted. */
function toUint8Array(bytes) {
  if (ArrayBuffer.isView(bytes)) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  if (Object.prototype.toString.call(bytes) === "[object ArrayBuffer]") {
    return new Uint8Array(bytes);
  }
  throw new TypeError("wavGain: expected a Buffer, Uint8Array, or ArrayBuffer");
}

function readAscii(view, offset, length) {
  let s = "";
  for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

/** Verifies the RIFF/WAVE magic, walks every chunk from byte 12 onward
 *  (word-aligned, per the RIFF spec: one pad byte after an odd-sized body)
 *  until both "fmt " and "data" are found, and returns the pieces the
 *  functions below need. Throws a clear, specific Error for anything that
 *  is not a well-formed 16-bit PCM MONO WAV -- there is no sample data to
 *  read or scale correctly otherwise. */
function readWavHeader(bytes) {
  const u8 = toUint8Array(bytes);
  if (u8.byteLength < 12) {
    throw new Error(`wavGain: buffer too short to be a WAV (${u8.byteLength} bytes)`);
  }
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const riffTag = readAscii(view, 0, 4);
  const waveTag = readAscii(view, 8, 4);
  if (riffTag !== "RIFF" || waveTag !== "WAVE") {
    throw new Error(`wavGain: not a RIFF/WAVE file (saw "${riffTag}"/"${waveTag}")`);
  }

  let fmt = null;
  let dataOffset = null;
  let dataSize = null;
  let offset = 12;
  while (offset + 8 <= u8.byteLength) {
    const chunkId = readAscii(view, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const bodyOffset = offset + 8;
    if (chunkId === "fmt ") {
      if (bodyOffset + 16 > u8.byteLength) {
        throw new Error('wavGain: "fmt " chunk is truncated');
      }
      fmt = {
        audioFormat: view.getUint16(bodyOffset, true),
        numChannels: view.getUint16(bodyOffset + 2, true),
        sampleRate: view.getUint32(bodyOffset + 4, true),
        bitsPerSample: view.getUint16(bodyOffset + 14, true),
      };
    } else if (chunkId === "data") {
      dataOffset = bodyOffset;
      dataSize = chunkSize;
    }
    if (fmt && dataOffset !== null) break; // both found -- no need to walk further
    offset = bodyOffset + chunkSize + (chunkSize % 2); // word-aligned, per spec
  }

  if (!fmt) throw new Error('wavGain: no "fmt " chunk found');
  if (dataOffset === null) throw new Error('wavGain: no "data" chunk found');
  if (fmt.bitsPerSample !== 16) {
    throw new Error(`wavGain: only 16-bit PCM WAV is supported, got ${fmt.bitsPerSample}-bit`);
  }
  if (fmt.numChannels !== 1) {
    throw new Error(`wavGain: only mono WAV is supported, got ${fmt.numChannels} channel(s)`);
  }
  // Defensive: a truncated file's declared dataSize can overrun what is
  // actually on hand -- clamp so a read never walks off the end of `u8`.
  const available = u8.byteLength - dataOffset;
  const clampedDataSize = Math.min(dataSize, available);
  const sampleCount = Math.floor(clampedDataSize / 2);
  return {
    u8,
    view,
    dataOffset,
    sampleCount,
    numChannels: fmt.numChannels,
    sampleRate: fmt.sampleRate,
    bitsPerSample: fmt.bitsPerSample,
  };
}

function int16ToFloat(sample) {
  return sample < 0 ? sample / 0x8000 : sample / 0x7fff;
}

function floatToInt16(amplitude) {
  const clamped = Math.max(-1, Math.min(1, amplitude));
  const scaled = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  return Math.round(scaled);
}

/** The largest absolute sample amplitude in the clip, on the [-1, 1] scale
 *  `encodeWav16k` itself writes in -- 0 for a silent clip, 1 for a clip that
 *  already has a sample at a true int16 extreme. Pure read; `bytes` is
 *  never modified. */
export function peakAmplitude(bytes) {
  const { view, dataOffset, sampleCount } = readWavHeader(bytes);
  let peak = 0;
  for (let i = 0; i < sampleCount; i++) {
    const sample = view.getInt16(dataOffset + i * 2, true);
    const amplitude = Math.abs(int16ToFloat(sample));
    if (amplitude > peak) peak = amplitude;
  }
  return peak;
}

/** The gain factor that would land this clip's OWN peak on `target` (0
 *  exclusive to 1 inclusive) -- `score.mjs`'s `--gain peak:<target>`. A
 *  silent clip (peak 0) has no peak to land anywhere: the factor is 1
 *  (unchanged), never a division by zero. */
export function peakNormalizeGain(bytes, target) {
  const peak = peakAmplitude(bytes);
  if (peak === 0) return 1;
  return target / peak;
}

/** Scales every sample by `factor`, clipping at the same +-1 ceiling
 *  `encodeWav16k` itself clips a live recording at (a factor's own validity
 *  -- finite, positive -- is `score.mjs`'s CLI concern, not this pure
 *  function's). Returns a NEW Buffer; `bytes` is never modified. The header
 *  (channels, rate, bit depth, RIFF/data sizes) is copied through
 *  unchanged -- only the sample data differs. */
export function applyGain(bytes, factor) {
  const { u8, view, dataOffset, sampleCount } = readWavHeader(bytes);
  const out = Buffer.from(u8); // a fresh copy: header + data, overwritten below
  const outView = new DataView(out.buffer, out.byteOffset, out.byteLength);
  for (let i = 0; i < sampleCount; i++) {
    const offset = dataOffset + i * 2;
    const sample = view.getInt16(offset, true);
    const scaled = int16ToFloat(sample) * factor;
    outView.setInt16(offset, floatToInt16(scaled), true);
  }
  return out;
}
