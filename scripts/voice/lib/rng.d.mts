/**
 * Types for `rng.mjs`, so TS test files can import the real module under
 * `strict` without `allowJs` (the pattern `scripts/lib/testerStack.d.mts`
 * set). Keep in step with the exports there.
 */
export type Rng = () => number;
export function mulberry32(seed: number): Rng;
export function pick<T>(rng: Rng, arr: readonly T[]): T;
export function randInt(rng: Rng, min: number, max: number): number;
export function chance(rng: Rng, p: number): boolean;
export function shuffle<T>(rng: Rng, arr: readonly T[]): T[];
