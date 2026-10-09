/** Types for `rows.mjs`. See `rng.d.mts` for why this file exists. */
import type { Command } from "../../../src/lib/command/parse";
import type { Rng } from "./rng.d.mts";
import type { VoiceTemplate } from "./templates.d.mts";

export interface VoiceRow {
  id: string;
  intent: string;
  sentence: string;
  form: Command;
  clean: boolean;
  source: string;
}

export const INTENTS: string[];
export function templatesFor(intent: string): VoiceTemplate[];

export class OracleMismatchError extends Error {
  templateId: string;
  sentence: string;
}

export function buildClean(template: VoiceTemplate, rng: Rng): { sentence: string; form: Command };

export function makeRow(
  template: VoiceTemplate,
  rng: Rng,
  wantClean: boolean,
  forbidden: Set<string>,
  seen: Set<string>,
  idPrefix: string,
  index: number,
): VoiceRow;

export function generateHeldoutRows(seed: number): VoiceRow[];
export function generateTrainingRows(
  seed: number,
  n: number,
  forbiddenSet?: Set<string>,
): VoiceRow[];
