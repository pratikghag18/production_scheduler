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
import { groundReading, groundDays, type VerbLists } from "@/lib/command/grounded";
import { parseCommand } from "@/lib/command/parse";
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
  DAY_GROUNDING_WORDS,
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

/**
 * DEF-0041 (28 Sept, tester): the brief's own two lists, checked against the
 * exact sentences it names -- the strong words ground a sweeping unassign
 * (`unassignCmd()`'s own default: operator "everyone", place []) on their
 * own; the everyday words ("take", "out", "off", "away") need a word for
 * "everyone" or the board itself alongside them. Every sentence here is the
 * SWEEPING case; GR-11 (above) already covers the narrow case (a named
 * person keeps today's looser rule) and DEF-0041.test.ts itself pins the
 * two garbled transcripts the tester found.
 */
describe("groundReading: DEF-0041's own sweeping-case sentence list", () => {
  it.each(["clear everyone", "take everyone off the board", "everybody out", "clear the board"])(
    "grounds: %s",
    (heard) => {
      const g = groundReading(heard, unassignCmd(), VERBS);
      expect(g).toEqual({ ok: true });
    },
  );

  it.each(["I will be out of the office tomorrow", "take your time"])(
    "does not ground: %s",
    (heard) => {
      const g = groundReading(heard, unassignCmd(), VERBS);
      expect(g.ok).toBe(false);
      if (!g.ok) expect(g.reason).toBe("sweeping");
    },
  );
});

/**
 * S194-D third pass (DEF-0041 / F-215, the main session's rule): a sweeping
 * clear read by the model grounds ONLY on a REMOVAL PHRASE -- a removal word
 * bound to "everyone"/"everybody"/"the board", ending its clause (THE RULE,
 * grounded.ts). GS-G grounds, GS-R refuses; each sentence by name. GS-O are
 * this lane's own ten attempts to get an ordinary sentence through.
 */
describe("groundReading: THE RULE for a sweeping clear (S194-D third pass)", () => {
  const mustGround = [
    "clear everyone",
    "clear the board",
    "clear the whole board",
    "remove everybody",
    "empty the board",
    "wipe the board",
    "unassign everyone",
    "take everyone off",
    "get everyone off",
    "pull everyone off",
    "send everyone home",
    "everybody out",
    "everyone off",
    "take everyone off the board",
    "clear the board today",
    "remove everyone from the board",
    "send everyone home early today",
  ];
  for (const heard of mustGround) {
    it(`GS-G grounds: "${heard}"`, () => {
      expect(groundReading(heard, unassignCmd(), VERBS)).toEqual({ ok: true });
    });
  }
  const mustRefuse = [
    "everyone is out to lunch",
    "the board meeting is off",
    "take the board down to the office",
    "everybody take a break",
    "clear skies today",
    "remove your gloves",
    "drop by my office",
    "pull up a chair",
    "cancel my lunch",
    "free coffee in the break room",
  ];
  const ownTen = [
    "can you clear your desk before everyone leaves",
    "remove the wrapper, everyone can have one",
    "everyone off to the canteen",
    "please take everyone out for pizza",
    "get everyone out of the rain",
    "we should clear the board of directors meeting",
    "delete everyone's old messages",
    "empty the board room bins",
    "remove everyone from the group chat",
    "clear everyone's plates after lunch",
  ];
  for (const heard of [...mustRefuse, ...ownTen]) {
    it(`GS-R refuses: "${heard}"`, () => {
      const g = groundReading(heard, unassignCmd(), VERBS);
      expect(g.ok).toBe(false);
      if (!g.ok) expect(g.reason).toBe("sweeping");
    });
  }
  it("GS-N: the NARROW rule is unchanged -- a named person grounds on any removal word", () => {
    expect(groundReading("Sam is off today", unassignCmd({ operator: "Sam" }), VERBS)).toEqual({
      ok: true,
    });
  });
});

/**
 * S72-e (docs/agent-briefs/s72-e-clear-over-a-week-brief.md §3, F-224,
 * R-435): `groundDays`'s own pins, GD-1..GD-6. `DAY_GROUNDING_WORDS` is
 * `parse.ts`'s own export, unioned with nothing here -- unlike `VerbLists`
 * above, this is a single flat list, so there is only one to hand in.
 */
describe("groundDays (S72-e, F-224, R-435)", () => {
  it("GD-1: 'Sam is off today' carries today -- no guard (the day was read, just not the exact word 'today' necessarily)", () => {
    const g = groundDays(
      "Sam is off today",
      unassignCmd({ operator: "Sam", day: { kind: "today" } }),
      DAY_GROUNDING_WORDS,
    );
    expect(g).toEqual({ ok: true });
  });

  it("GD-2: 'Sam is off' says no day/span phrase at all -- no guard (nothing was heard, so nothing can have been dropped)", () => {
    const g = groundDays("Sam is off", unassignCmd({ operator: "Sam" }), DAY_GROUNDING_WORDS);
    expect(g).toEqual({ ok: true });
  });

  it("GD-3: F-224's own shape -- 'clear Cell 5 for the whole week' heard, but the command still carries day: null (a stale/untrained model answer) -- day_dropped, naming the phrase", () => {
    const g = groundDays(
      "clear Cell 5 for the whole week",
      unassignCmd({ place: ["Cell 5"] }),
      DAY_GROUNDING_WORDS,
    );
    expect(g).toEqual({
      ok: false,
      reason: "day_dropped",
      phrase: "for the whole week",
    });
  });

  it("GD-4: the same heard phrase, but the command DID keep the week (day: every_day/this_week) -- no guard; R-435 is about silence, never paraphrase", () => {
    const g = groundDays(
      "clear Cell 5 for the whole week",
      unassignCmd({ place: ["Cell 5"], day: { kind: "every_day", week: "this_week" } }),
      DAY_GROUNDING_WORDS,
    );
    expect(g).toEqual({ ok: true });
  });

  it("GD-5: an unassign with 'until' carrying the day (an absence's own end) counts as kept, never dropped", () => {
    const g = groundDays(
      "Sam is off until Friday",
      unassignCmd({ operator: "Sam", until: { kind: "weekday", day: 5 } }),
      DAY_GROUNDING_WORDS,
    );
    expect(g).toEqual({ ok: true });
  });

  it("GD-6: an ISO-shaped date said aloud, dropped by the command -- checked by shape, not as a literal word in the list", () => {
    const g = groundDays(
      "clear Cell 5 on 2026-09-04",
      unassignCmd({ place: ["Cell 5"] }),
      DAY_GROUNDING_WORDS,
    );
    expect(g).toEqual({ ok: false, reason: "day_dropped", phrase: "2026-09-04" });
  });

  /**
   * DEF-0044 item 7 (28 Sept, tester): `groundDays`'s own comment (its
   * header doc, above) names the mixed several -- "a phrase said once for
   * the whole sentence is not a drop as long as AT LEAST ONE member kept a
   * day" -- but no existing case built one: GD-3/GD-4 are a single
   * unassign, GR-7/GR-8/GR-9 (`groundReading`'s own severals) never check
   * `groundDays` at all. Mutating the `.some` in `groundDays`' `several`
   * branch to `.every` makes every OTHER case here pass unchanged (none of
   * them is a mixed several) while this one goes red: Sam kept "tomorrow",
   * Ana's own member dropped it, and the rule the comment states is that
   * one kept day is enough.
   */
  it("GD-7 (DEF-0044 item 7): a several where one member kept 'tomorrow' and the other dropped it is not flagged -- one kept day is enough", () => {
    const command: SeveralCommand = {
      intent: "several",
      commands: [
        unassignCmd({ operator: "Sam", day: { kind: "tomorrow" } }),
        unassignCmd({ operator: "Ana" }),
      ],
    };
    const g = groundDays("Sam is off tomorrow and clear Ana", command, DAY_GROUNDING_WORDS);
    expect(g).toEqual({ ok: true });
  });
});

/**
 * GD-fp: reviewer sweep (S72-e review) of the brief's own §3 false-positive
 * list -- every board/adjust/book/headcount shape whose day field is NOT
 * literally named `day` on the wire still has to be read by
 * `commandCarriesNoDay` (`grounded.ts`), and every one of them (swap, split,
 * move/adjust, headcount, book) DOES carry a field literally called `day`
 * (`parse.ts`'s own `Command` union), so the generic `command.day === null`
 * branch already covers them -- this sweep runs each sentence through the
 * REAL `parseCommand` (never a hand-built literal) so a future field rename
 * is caught here first, not by a maintainer report.
 */
describe("groundDays: the brief's §3 false-positive sweep, through parseCommand (S72-e review)", () => {
  const cases = [
    "Sam Patel is off today",
    "copy today to Friday for Cell 5",
    "same as yesterday for Cell 3",
    "swap Lena Novak and Priya Shah today",
    "split Tom Baker's block at 10am today",
    "make the Common Fastener job on Cell 6 5 people today",
    "extend Sam Patel's assignment by an hour today",
    "book Common Fastener on Cell 6 for 2 people from 1pm to 5pm today",
  ];
  for (const sentence of cases) {
    it(`does not fire on: ${sentence}`, () => {
      const parsed = parseCommand(sentence);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(groundDays(sentence, parsed.command, DAY_GROUNDING_WORDS)).toEqual({ ok: true });
    });
  }
});

/**
 * GD-fn: reviewer sweep of the brief's own §3 false-negative list, through
 * `parseCommand`. Before this review, "Sam Patel is off for the rest of the
 * week" failed to PARSE at all (`bad_day`) -- a grammar bug one level below
 * `groundDays` (`parse.ts`'s week-phrase gate only checked `UNASSIGN_VERB_
 * RE`, never the absence grammar's own name-first shape); fixed in
 * `extractRepeatDayClause` (also gate on `ABSENCE_RE`) and
 * `parseAbsenceRest` (skip AB2's "default to today" when a repeat clause was
 * found, so it does not collide with the reattached repeat as `two_days`).
 * With the grammar fixed, none of these should ever reach `groundDays`
 * carrying a dropped day -- confirmed here, at the parse level and the
 * guard level both, so a regression in either shows up.
 */
describe("groundDays: the brief's §3 false-negative sweep -- these must parse AND keep their day (S72-e review)", () => {
  const cases = [
    "clear Cell 5 for the whole of next week",
    "remove Sam Patel this week",
    "Sam Patel is off for the rest of the week",
  ];
  for (const sentence of cases) {
    it(`parses and is not flagged as dropped: ${sentence}`, () => {
      const parsed = parseCommand(sentence);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(groundDays(sentence, parsed.command, DAY_GROUNDING_WORDS)).toEqual({ ok: true });
    });
  }
});
