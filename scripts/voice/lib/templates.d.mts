/** Types for `templates.mjs`. See `rng.d.mts` for why this file exists. */
import type { Command } from "../../../src/lib/command/parse";
import type { Rng } from "./rng.d.mts";

export interface VoiceTemplate {
  id: string;
  intent: "assign" | "book" | "unassign" | "move";
  /** The slot set is opaque outside the template that made it -- `sentence`
   *  and `form` below are the only things allowed to read it. */
  genSlots(rng: Rng): unknown;
  sentence(slots: unknown): string;
  form(slots: unknown): Command;
}

export const TEMPLATES: VoiceTemplate[];
export function templateById(id: string): VoiceTemplate;
