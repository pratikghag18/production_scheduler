/**
 * S71-m (docs/agent-briefs/s71-m-grounded-reading-brief.md §2, F-212/F-215,
 * R-435/R-431): `groundReading`'s own pins, GR-1..GR-15. `VERBS` mirrors
 * `CommandBar.tsx`'s own `GROUNDING_VERBS` constant exactly -- see that
 * file's comment (and `grounded.ts`'s own `VerbLists` doc) for why
 * `unassign` unions `ABSENCE_WORDS`, `move` unions `ADJUST_VERBS`, and
 * `copy` unions `SAME_AS_WORDS`: all three gaps were found running the
 * existing `commandBar.test.tsx` model-reader cases red, or (`SAME_AS_WORDS`)
 * a reviewer reading `parse.ts`'s own `SAME_AS_RE` directly (CB-x-14,
 * CB-y-15, GR-15). GR-13/GR-14 pin the reviewer's other fix: a MIXED
 * several (some members grounded, one not) is `no_intent_word`, never
 * `sweeping`, even when the one ungrounded member is an unassign --
 * `groundOne`'s own "unassign is always sweeping" rule is right only for a
 * standalone unassign or a several where NOTHING is grounded.
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
  type AssignCommand,
  type BookCommand,
  type UnassignCommand,
  type MoveCommand,
  type CopyCommand,
  type SeveralCommand,
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

function assignCmd(over: Partial<AssignCommand> = {}): AssignCommand {
  return {
    intent: "assign",
    operator: "Sam Patel",
    product: "Housing A",
    place: ["Cell 1"],
    day: null,
    start: { hour: 8, minute: 0 },
    end: { hour: 16, minute: 0 },
    attach: null,
    existing: null,
    shift: null,
    ...over,
  };
}

function bookCmd(over: Partial<BookCommand> = {}): BookCommand {
  return {
    intent: "book",
    product: "Bracket A",
    place: ["Cell 3"],
    headcount: null,
    day: null,
    start: { hour: 8, minute: 0 },
    end: { hour: 14, minute: 0 },
    existing: null,
    shift: null,
    ...over,
  };
}

function unassignCmd(over: Partial<UnassignCommand> = {}): UnassignCommand {
  return {
    intent: "unassign",
    operator: "everyone",
    place: [],
    day: null,
    span: null,
    existing: null,
    shift: null,
    until: null,
    ...over,
  };
}

function moveCmd(over: Partial<MoveCommand> = {}): MoveCommand {
  return {
    intent: "move",
    operator: "Sam Patel",
    place: ["Cell 1"],
    toPlace: ["Cell 2"],
    day: null,
    span: null,
    existing: null,
    shift: null,
    adjust: null,
    ...over,
  };
}

describe("groundReading (S71-m, F-212/F-215, R-435/R-431)", () => {
  it("GR-1: 'EF76.' read as an unassign of everyone is sweeping (F-215's own shape)", () => {
    const g = groundReading("EF76.", unassignCmd(), VERBS);
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason).toBe("sweeping");
  });

  it("GR-2: 'clear Cell 3 today' read as an unassign is grounded", () => {
    const g = groundReading("clear Cell 3 today", unassignCmd({ place: ["Cell 3"] }), VERBS);
    expect(g).toEqual({ ok: true });
  });

  it("GR-3: the F-212 transcript (the leading 'Assign Tom Baker to' lost) read as a book with no person is ungrounded", () => {
    const heard = "-2, Area 2, Frame A on cell 6, in line 3, from 8 a.m. to 2 p.m. today.";
    const g = groundReading(
      heard,
      bookCmd({ product: "Frame A", place: ["Cell 6", "Line 3"] }),
      VERBS,
    );
    expect(g).toEqual({ ok: false, reason: "no_intent_word", intent: "book" });
  });

  it("GR-4: 'book Bracket A on Cell 3 ...' read as a book is grounded", () => {
    const g = groundReading("book Bracket A on Cell 3 from 8 to 2", bookCmd(), VERBS);
    expect(g).toEqual({ ok: true });
  });

  it("GR-5: 'put Sam on Cell 1 8 to 4' read as an assign is grounded (a synonym the parser accepts)", () => {
    const g = groundReading("put Sam on Cell 1 8 to 4", assignCmd({ operator: "Sam" }), VERBS);
    expect(g).toEqual({ ok: true });
  });

  it("GR-6: 'Sam Patel to Cell 1 from 8am to 4pm' read as an assign (the verb lost) is ungrounded", () => {
    const g = groundReading(
      "Sam Patel to Cell 1 from 8am to 4pm",
      assignCmd({ operator: "Sam Patel" }),
      VERBS,
    );
    expect(g).toEqual({ ok: false, reason: "no_intent_word", intent: "assign" });
  });

  it("GR-7: a several whose members are ALL grounded is ok", () => {
    const heard = "assign Sam to Cell 1 from 8 to 4 and book Bracket A on Cell 3 from 8 to 4";
    const command: SeveralCommand = { intent: "several", commands: [assignCmd(), bookCmd()] };
    expect(groundReading(heard, command, VERBS)).toEqual({ ok: true });
  });

  it("GR-8: a several with ONE ungrounded member is not ok (no_intent_word)", () => {
    const heard = "Sam to Cell 1 from 8 to 4 and book Bracket A on Cell 3 from 8 to 4";
    const command: SeveralCommand = { intent: "several", commands: [assignCmd(), bookCmd()] };
    const g = groundReading(heard, command, VERBS);
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason).toBe("no_intent_word");
  });

  it("GR-9: a several of more than one command with NO word for any of them is sweeping", () => {
    const command: SeveralCommand = {
      intent: "several",
      commands: [unassignCmd({ operator: "Sam Patel" }), moveCmd()],
    };
    const g = groundReading("anything", command, VERBS);
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason).toBe("sweeping");
  });

  it("GR-10: case and punctuation are ignored", () => {
    expect(groundReading("PUT, Sam! on Cell-1.", assignCmd({ operator: "Sam" }), VERBS)).toEqual({
      ok: true,
    });
    expect(
      groundReading("CLEAR Cell 3, today!", unassignCmd({ place: ["Cell 3"] }), VERBS),
    ).toEqual({ ok: true });
  });

  it("GR-11: 'Sam is off from today until tomorrow' read as an unassign (R-409's absence grammar) is grounded", () => {
    const g = groundReading(
      "Sam is off from today until tomorrow",
      unassignCmd({ operator: "Sam", place: [], until: { kind: "tomorrow" } }),
      VERBS,
    );
    expect(g).toEqual({ ok: true });
  });

  it("GR-12: 'extend Sam's block by an hour' read as a move with an adjust (R-412) is grounded", () => {
    const g = groundReading(
      "extend Sam's block by an hour",
      moveCmd({
        operator: "Sam",
        place: [],
        toPlace: null,
        adjust: { edge: "end", by: 60 },
      }),
      VERBS,
    );
    expect(g).toEqual({ ok: true });
  });

  it("GR-13: a several with an assign grounded and an unassign ungrounded is no_intent_word, never sweeping", () => {
    const heard = "assign Sam to Cell 1 from 8 to 4 and Ana from Cell 3";
    const command: SeveralCommand = {
      intent: "several",
      commands: [assignCmd({ operator: "Sam" }), unassignCmd({ operator: "Ana" })],
    };
    const g = groundReading(heard, command, VERBS);
    expect(g).toEqual({ ok: false, reason: "no_intent_word", intent: "unassign" });
  });

  it("GR-14: a several of two ungrounded members (one of them an unassign) is sweeping", () => {
    const command: SeveralCommand = {
      intent: "several",
      commands: [unassignCmd({ operator: "Ana" }), assignCmd({ operator: "Sam" })],
    };
    const g = groundReading("anything at all", command, VERBS);
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason).toBe("sweeping");
  });

  it("GR-15: 'same as yesterday for Cell 1' read as a copy is grounded (R-408's own opener, not a COPY_VERBS word)", () => {
    const command: CopyCommand = {
      intent: "copy",
      place: ["Cell 1"],
      from: { kind: "yesterday" },
      to: { kind: "today" },
    };
    const g = groundReading("same as yesterday for Cell 1", command, VERBS);
    expect(g).toEqual({ ok: true });
  });
});
