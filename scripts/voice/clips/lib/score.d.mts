/**
 * Types for `score.mjs` (the clips lib, S71-c). See `scripts/voice/lib/
 * rng.d.mts` for why this file exists -- `src/test/voiceClips.test.ts`
 * imports the real `.mjs` module under `strict`, without `allowJs`.
 */
export const BOARD_NAMES: readonly string[];

export function normalizeText(text: string): string;

export function wordErrorRate(reference: string, hypothesis: string): number;

export function isExact(reference: string, hypothesis: string): boolean;

export interface NameHitsResult {
  hits: number;
  total: number;
  missed: string[];
}

export function nameHits(
  reference: string,
  hypothesis: string,
  names?: readonly string[],
): NameHitsResult;
