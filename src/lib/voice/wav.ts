/**
 * S57-a (brief docs/agent-briefs/s57-a-whisper-brief.md §2, design-plan
 * §19.102 / D131) — pure audio helpers `localRecognizer.ts` builds on: a
 * 16-bit PCM mono WAV encoder (whisper.cpp's server reads WAV without
 * ffmpeg, so the browser's own resampled clip needs no server-side
 * conversion) and an RMS meter used to decide when a clip has speech and
 * when it has gone quiet. Both are pure functions -- no DOM, no timers --
 * so they are tested directly, with no faked `AudioContext`.
 */

/** A 44-byte RIFF/WAVE header followed by 16-bit PCM samples, mono, at
 *  `sampleRate`. Each sample is clamped to [-1, 1] before it is scaled to
 *  the signed 16-bit range, so an out-of-range input clips instead of
 *  wrapping. An empty `samples` array still produces a valid (silent, 0
 *  byte `data` chunk) WAV. */
export function encodeWav16k(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const bytesPerSample = 2;
  const numChannels = 1;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;

  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  function writeAscii(offset: number, text: string): void {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  }

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, "WAVE");

  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size (PCM)
  view.setUint16(20, 1, true); // audio format 1 = PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true); // bits per sample

  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    const scaled = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    view.setInt16(offset, Math.round(scaled), true);
    offset += bytesPerSample;
  }

  return buffer;
}

/** Root-mean-square of a frame's samples -- 0 for an empty frame, never
 *  NaN. Used against a fixed floor (`localRecognizer.ts`'s `RMS_FLOOR`) to
 *  decide whether a frame has speech in it. */
export function rmsOf(frame: Float32Array): number {
  if (frame.length === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < frame.length; i++) sumSquares += frame[i] * frame[i];
  return Math.sqrt(sumSquares / frame.length);
}
