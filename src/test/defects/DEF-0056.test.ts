/**
 * DEF-0056: DEF-0041's rule (session 194) grounds a clear of the whole board
 * only on a "removal phrase" -- and the phrase matcher (`hasRemovalPhrase`,
 * src/lib/command/grounded.ts) looks at the words of the phrase alone, never
 * at what stands in front of it or between its parts. So a sentence that says
 * NOT to clear the board, one that ASKS whether everyone is off, and an
 * everyday idiom ("clear it with everyone", "take everyone out tonight") each
 * still ground the sweeping reading F-215 and DEF-0041 were about: an unassign
 * of everyone with no place, one "Do all" from emptying the board.
 *
 * Same fixture as DEF-0041's pin: the bar's own verb lists (`GROUNDING_VERBS`,
 * CommandBar.tsx, copied field for field) and the model's sweeping reading.
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

const sweeping: UnassignCommand = {
  intent: "unassign",
  operator: "everyone",
  place: [],
  day: null,
  span: null,
  existing: null,
  shift: null,
  until: null,
};

const refused = { ok: false, reason: "sweeping", intent: expect.any(String) };

describe("DEF-0056: a removal phrase inside a negation, a question or an idiom still grounds a clear of the whole board", () => {
  it.each([
    "do not clear the board",
    "I did not say clear the board",
    "never clear the board",
    "don't clear everyone",
  ])("a sentence that says NOT to: %s", (heard) => {
    expect(groundReading(heard, sweeping, VERBS)).toEqual(refused);
  });

  it.each(["is everyone off today", "should I clear the board", "did we get everyone out"])(
    "a question, not an order: %s",
    (heard) => {
      expect(groundReading(heard, sweeping, VERBS)).toEqual(refused);
    },
  );

  it.each([
    "I will clear it with everyone",
    "let me clear that with everybody tomorrow",
    "I would like to take everyone out tonight",
  ])("an everyday idiom: %s", (heard) => {
    expect(groundReading(heard, sweeping, VERBS)).toEqual(refused);
  });

  it("the orders the rule was written for still ground (the control)", () => {
    for (const heard of ["clear the board", "clear everyone today", "send everyone home"]) {
      expect(groundReading(heard, sweeping, VERBS), heard).toEqual({ ok: true });
    }
  });
});
