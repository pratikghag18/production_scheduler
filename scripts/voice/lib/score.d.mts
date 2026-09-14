/** Types for `score.mjs`. See `rng.d.mts` for why this file exists. */
export interface ScoreBucket {
  n: number;
  correct: number;
}
export interface ScoreIntentBucket {
  clean: ScoreBucket;
  perturbed: ScoreBucket;
}
export interface ExtraKeysBucket {
  n: number;
  keys: Record<string, number>;
}
export interface ScoreResult {
  clean: ScoreBucket;
  perturbed: ScoreBucket;
  byIntent: Record<string, ScoreIntentBucket>;
  byField: Record<string, ScoreBucket>;
  extraKeys: ExtraKeysBucket;
}
export function score<TRow extends { intent: string; clean: boolean; form: unknown }>(
  rows: readonly TRow[],
  predict: (row: TRow) => unknown,
): ScoreResult;
export function rate(bucket: ScoreBucket): number;
export function formatExtraKeysLine(extraKeys: ExtraKeysBucket): string;
