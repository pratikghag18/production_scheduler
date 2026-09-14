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

/** F-145: `ScoreResult` plus how many prediction rows carried no `sentence`
 *  at all (a predictions file from before this change). */
export interface ScoreResultWithSentenceCheck extends ScoreResult {
  sentencesNotChecked: number;
}
export function scorePredictions<
  TRow extends { id: string; sentence: string; intent: string; clean: boolean; form: unknown },
>(
  heldoutRows: readonly TRow[],
  predictionRows: readonly { id: string; sentence?: string | null; form: unknown }[],
): ScoreResultWithSentenceCheck;
export function formatSentencesNotCheckedLine(n: number): string;
