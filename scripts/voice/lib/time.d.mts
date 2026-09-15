/** Types for `time.mjs`. See `rng.d.mts` for why this file exists. */
import type { ClockTime } from "../../../src/lib/command/parse";

export interface TimeSpec {
  kind: "24h" | "ampm" | "noon" | "midnight";
  hour?: number;
  minute?: number;
}

export interface ResolvedTime {
  text: string;
  hour: number;
  minute: number;
  hasMeridiem: boolean;
}

export function resolveTimeSpec(spec: TimeSpec): ResolvedTime;
export function applyLoneEdgeRule(resolved: ResolvedTime): ResolvedTime;
export function resolveLoneTime(
  spec: TimeSpec,
  options?: { allowDayEnd?: boolean },
): { text: string; hour: number; minute: number };
export function buildTimePair(
  startSpec: TimeSpec,
  endSpec: TimeSpec,
  sep: string,
): { text: string; start: ClockTime; end: ClockTime } | null;
export const TIME_SEPARATORS: string[];
