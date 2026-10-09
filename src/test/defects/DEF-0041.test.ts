/**
 * DEF-0041: `groundReading` (src/lib/command/grounded.ts) treats ANY
 * occurrence of an unassign-list word anywhere in the heard text as proof
 * the sentence asked for a removal -- it does not check that the word was
 * said AS the command's own verb. "take" was added to UNASSIGN_VERBS at
 * R-405 so "take Sam to Cell 2" reads as a removal; the side effect is that
 * ANY heard text containing the ordinary English word "take" (or "out",
 * "off", "away" -- all common words, all in UNASSIGN_VERBS/ABSENCE_WORDS)
 * grounds a sweeping "everyone, day: null" unassign the model guessed for
 * an unrelated reason. This is exactly F-215's own shape ("EF76." must never
 * ground a clear-everyone with one button away from running) reopened
 * through a different, much more common word than "clear"/"remove".
 */
import { describe, it, expect } from "vitest";
import { groundReading, type VerbLists } from "@/lib/command/grounded";
import {
  ASSIGN_VERBS,
  BOOK_VERBS,
  UNASSIGN_VERBS,
  MOVE_VERBS,
  HEADCOUNT_VERBS,
  REPLACE_VERBS,
  SWAP_VERBS,
  COPY_VERBS,
  ABSENCE_WORDS,
  ADJUST_VERBS,
  SAME_AS_WORDS,
  type UnassignCommand,
} from "@/lib/command/parse";

const VERBS: VerbLists = {
  assign: ASSIGN_VERBS,
  book: BOOK_VERBS,
  unassign: [...UNASSIGN_VERBS, ...ABSENCE_WORDS],
  move: [...MOVE_VERBS, ...ADJUST_VERBS],
  headcount: HEADCOUNT_VERBS,
  replace: REPLACE_VERBS,
  swap: SWAP_VERBS,
  copy: [...COPY_VERBS, ...SAME_AS_WORDS],
  split: ["split"],
};

function sweepingUnassign(): UnassignCommand {
  return {
    intent: "unassign",
    operator: "everyone",
    place: [],
    day: null,
    span: null,
    existing: null,
    shift: null,
    until: null,
  };
}

describe("DEF-0041: groundReading is fooled by an incidental 'take'/'off'/'out' (F-215 reopened)", () => {
  it("a garbage transcript that happens to contain the ordinary word 'take' grounds a sweeping clear-everyone", () => {
    // Nothing here asks for a removal at all -- "take" is used the way it
    // is in ordinary speech ("this will take a while"), not as a verb aimed
    // at any person or place. The model's own reading (unrelated, garbled)
    // came back a sweeping unassign of everyone on the day. F-215/R-431 say
    // this must be refused outright ("sweeping"), the same as "EF76." is.
    const heard = "sorry, this will take a few extra minutes, go ahead without me";
    const g = groundReading(heard, sweepingUnassign(), VERBS);
    expect(g).toEqual({ ok: false, reason: "sweeping", intent: expect.any(String) });
  });

  it("'the shipment is out for delivery today' grounds the same sweeping clear-everyone via 'out'", () => {
    const heard = "the shipment is out for delivery today, nothing else to say";
    const g = groundReading(heard, sweepingUnassign(), VERBS);
    expect(g).toEqual({ ok: false, reason: "sweeping", intent: expect.any(String) });
  });
});
