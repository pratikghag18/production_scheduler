/**
 * Types for `wavGain.mjs` (S71-k, R-453/F-210) -- see `./score.d.mts` for
 * why this file exists: `src/test/voiceClips.test.ts` imports the real
 * `.mjs` module under `strict`, without `allowJs`.
 */
export function peakAmplitude(bytes: Buffer | Uint8Array | ArrayBuffer): number;

export function peakNormalizeGain(bytes: Buffer | Uint8Array | ArrayBuffer, target: number): number;

export function applyGain(bytes: Buffer | Uint8Array | ArrayBuffer, factor: number): Buffer;
