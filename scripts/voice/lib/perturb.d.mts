/** Types for `perturb.mjs`. See `rng.d.mts` for why this file exists. */
import type { Rng } from "./rng.d.mts";

export const CATALOG: Record<string, (sentence: string, rng: Rng) => string>;
export const PERTURBATION_IDS: string[];
export function perturbAll(
  sentence: string,
  rng: Rng,
  n: number,
): { sentence: string; ids: string[] };
export function perturbedRowForm<T>(cleanForm: T, appliedIds: readonly string[]): T;
