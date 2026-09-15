/**
 * P1-7a — `src/lib/command/parse.ts`, brief §4's worked examples (P1–P24),
 * run verbatim rather than reasoned about (§4: "Run the table; do not reason
 * it."). One plain `it()` per case, no `it.each`, so a failing row names
 * itself in the runner's output the way the brief expects a developer to read
 * it. Every `ok` row asserts the WHOLE `AssignCommand`, including `attach:
 * null` and `intent: "assign"` (P24's point: `parseCommand` never sets `attach`
 * to anything else, and `formatCommand` never prints it).
 */
import { describe, it, expect } from "vitest";
import { parseCommand, formatCommand, expectedShape } from "@/lib/command/parse";
import { ASSIGN_VERBS, BOOK_VERBS, UNASSIGN_VERBS, MOVE_VERBS } from "@/lib/command/parse";
import {
  REPLACE_VERBS,
  SWAP_VERBS,
  COPY_VERBS,
  EVERYONE,
  ALL_DAY,
  END_OF_SHIFT,
  END_OF_DAY,
  BOUNDARY_SHIFTS,
  DAY_END,
  ABSENCE_WORDS,
  TIME_OF_DAY_WORDS,
  JOB_HOURS,
  ADJUST_VERBS,
  HEADCOUNT_VERBS,
  REPEAT_WORDS,
} from "@/lib/command/parse";
import type {
  AssignCommand,
  BookCommand,
  UnassignCommand,
  MoveCommand,
  ReplaceCommand,
  SwapCommand,
  CopyCommand,
  SplitCommand,
  HeadcountCommand,
  Command,
} from "@/lib/command/parse";

function ok(command: Command) {
  return { ok: true as const, command };
}

function bookOk(overrides: Partial<BookCommand> = {}): { ok: true; command: BookCommand } {
  return {
    ok: true,
    command: {
      intent: "book",
      product: "Housing A",
      place: ["Cell 1"],
      headcount: null,
      day: null,
      start: { hour: 6, minute: 0 },
      end: { hour: 14, minute: 0 },
      shift: null,
      existing: null,
      ...overrides,
    },
  };
}

describe("commandParse: brief §4 worked examples", () => {
  it("P1: the maintainer's own example, to work on / on / in, no day", () => {
    expect(
      parseCommand(
        "Assign Operator 1 to work on Product A/Housing A on Cell 1 in Line 1 from 10AM to 2PM",
      ),
    ).toEqual(
      ok({
        intent: "assign",
        operator: "Operator 1",
        product: "Product A/Housing A",
        place: ["Cell 1", "Line 1"],
        day: null,
        start: { hour: 10, minute: 0 },
        end: { hour: 14, minute: 0 },
        attach: null,
        shift: null,
        existing: null,
      }),
    );
  });

  it("P2: put ... on ... at ..., bare 24h-ish times needing the afternoon rule", () => {
    expect(parseCommand("put sam on housing a at cell 1 from 10 to 2")).toEqual(
      ok({
        intent: "assign",
        operator: "sam",
        product: "housing a",
        place: ["cell 1"],
        day: null,
        start: { hour: 10, minute: 0 },
        end: { hour: 14, minute: 0 },
        attach: null,
        shift: null,
        existing: null,
      }),
    );
  });

  it("P3: no verb, comma-separated places, colon times", () => {
    expect(
      parseCommand("Sam Patel to Housing A on Cell 1, Line 1, Assembly from 6:30 to 14:30"),
    ).toEqual(
      ok({
        intent: "assign",
        operator: "Sam Patel",
        product: "Housing A",
        place: ["Cell 1", "Line 1", "Assembly"],
        day: null,
        start: { hour: 6, minute: 30 },
        end: { hour: 14, minute: 30 },
        attach: null,
        shift: null,
        existing: null,
      }),
    );
  });

  it("P4: on tomorrow", () => {
    expect(parseCommand("assign Sam to Housing A on Cell 1 on tomorrow from 10 to 2")).toEqual(
      ok({
        intent: "assign",
        operator: "Sam",
        product: "Housing A",
        place: ["Cell 1"],
        day: { kind: "tomorrow" },
        start: { hour: 10, minute: 0 },
        end: { hour: 14, minute: 0 },
        attach: null,
        shift: null,
        existing: null,
      }),
    );
  });

  it("P5: bare weekday abbreviation, no 'on'", () => {
    expect(parseCommand("assign Sam to Housing A on Cell 1 tue from 10 to 2")).toEqual(
      ok({
        intent: "assign",
        operator: "Sam",
        product: "Housing A",
        place: ["Cell 1"],
        day: { kind: "weekday", day: 2 },
        start: { hour: 10, minute: 0 },
        end: { hour: 14, minute: 0 },
        attach: null,
        shift: null,
        existing: null,
      }),
    );
  });

  it("P6: on <iso date>", () => {
    expect(parseCommand("assign Sam to Housing A on Cell 1 on 2026-09-04 from 10 to 2")).toEqual(
      ok({
        intent: "assign",
        operator: "Sam",
        product: "Housing A",
        place: ["Cell 1"],
        day: { kind: "date", iso: "2026-09-04" },
        start: { hour: 10, minute: 0 },
        end: { hour: 14, minute: 0 },
        attach: null,
        shift: null,
        existing: null,
      }),
    );
  });

  it("P7: dash separator", () => {
    expect(parseCommand("assign Sam to Housing A on Cell 1 from 10 - 2")).toEqual(
      ok({
        intent: "assign",
        operator: "Sam",
        product: "Housing A",
        place: ["Cell 1"],
        day: null,
        start: { hour: 10, minute: 0 },
        end: { hour: 14, minute: 0 },
        attach: null,
        shift: null,
        existing: null,
      }),
    );
  });

  it("P8: time_order — 22 to 2, and 2->14 is still before 22", () => {
    expect(parseCommand("assign Sam to Housing A on Cell 1 from 22 to 2")).toEqual({
      ok: false,
      failure: { kind: "time_order" },
    });
  });

  it("P9: from 10 to 10 -- the afternoon rule fires because the end is not after the start, giving 10:00-22:00", () => {
    expect(parseCommand("assign Sam to Housing A on Cell 1 from 10 to 10")).toEqual(
      ok({
        intent: "assign",
        operator: "Sam",
        product: "Housing A",
        place: ["Cell 1"],
        day: null,
        start: { hour: 10, minute: 0 },
        end: { hour: 22, minute: 0 },
        attach: null,
        shift: null,
        existing: null,
      }),
    );
  });

  it("P10: noon to 3", () => {
    expect(parseCommand("assign Sam to Housing A on Cell 1 from noon to 3")).toEqual(
      ok({
        intent: "assign",
        operator: "Sam",
        product: "Housing A",
        place: ["Cell 1"],
        day: null,
        start: { hour: 12, minute: 0 },
        end: { hour: 15, minute: 0 },
        attach: null,
        shift: null,
        existing: null,
      }),
    );
  });

  it("P11: 12am to 4 -- 12am is midnight, and 4 is already after 0:00 so no afternoon adjustment", () => {
    expect(parseCommand("assign Sam to Housing A on Cell 1 from 12am to 4")).toEqual(
      ok({
        intent: "assign",
        operator: "Sam",
        product: "Housing A",
        place: ["Cell 1"],
        day: null,
        start: { hour: 0, minute: 0 },
        end: { hour: 4, minute: 0 },
        attach: null,
        shift: null,
        existing: null,
      }),
    );
  });

  it("P12: bad_time -- 10:75 has an invalid minute", () => {
    expect(parseCommand("assign Sam to Housing A on Cell 1 from 10:75 to 2")).toEqual({
      ok: false,
      failure: { kind: "bad_time", text: "10:75" },
    });
  });

  it("P13: no_time -- no from clause at all", () => {
    expect(parseCommand("assign Sam to Housing A on Cell 1")).toEqual({
      ok: false,
      failure: { kind: "no_time" },
    });
  });

  it("P14: no_product -- nothing after the operator but the time clause", () => {
    expect(parseCommand("assign Sam from 10 to 2")).toEqual({
      ok: false,
      failure: { kind: "no_product" },
    });
  });

  it("P15: no_place -- a product but no place", () => {
    expect(parseCommand("assign Sam to Housing A from 10 to 2")).toEqual({
      ok: false,
      failure: { kind: "no_place" },
    });
  });

  it("P16: empty -- whitespace only", () => {
    expect(parseCommand("   ")).toEqual({ ok: false, failure: { kind: "empty" } });
  });

  it("P17: quoted segments are atomic, even one containing ' in '", () => {
    expect(
      parseCommand('assign "Lin On" to Housing A on "Cell in 2" in Line 1 from 10 to 2'),
    ).toEqual(
      ok({
        intent: "assign",
        operator: "Lin On",
        product: "Housing A",
        place: ["Cell in 2", "Line 1"],
        day: null,
        start: { hour: 10, minute: 0 },
        end: { hour: 14, minute: 0 },
        attach: null,
        shift: null,
        existing: null,
      }),
    );
  });

  it("P18: 'on funday' is a place, not a day word, because funday is not a real weekday", () => {
    expect(parseCommand("assign Sam to Housing A on Cell 1 on funday from 10 to 2")).toEqual(
      ok({
        intent: "assign",
        operator: "Sam",
        product: "Housing A",
        place: ["Cell 1", "funday"],
        day: null,
        start: { hour: 10, minute: 0 },
        end: { hour: 14, minute: 0 },
        attach: null,
        shift: null,
        existing: null,
      }),
    );
  });

  it("P19: bad_day -- 2026-13-40 looks like an iso date but is not a real one", () => {
    expect(parseCommand("assign Sam to Housing A on Cell 1 on 2026-13-40 from 10 to 2")).toEqual({
      ok: false,
      failure: { kind: "bad_day", text: "2026-13-40" },
    });
  });

  it("P20: all-caps input keeps the original case in the extracted words, trailing period ignored", () => {
    expect(parseCommand("ASSIGN SAM TO HOUSING A ON CELL 1 FROM 10AM TO 2PM.")).toEqual(
      ok({
        intent: "assign",
        operator: "SAM",
        product: "HOUSING A",
        place: ["CELL 1"],
        day: null,
        start: { hour: 10, minute: 0 },
        end: { hour: 14, minute: 0 },
        attach: null,
        shift: null,
        existing: null,
      }),
    );
  });

  it("P21: 'until' separator, no leading verb", () => {
    expect(parseCommand("Sam to Housing A on Cell 1 from 8 until 4")).toEqual(
      ok({
        intent: "assign",
        operator: "Sam",
        product: "Housing A",
        place: ["Cell 1"],
        day: null,
        start: { hour: 8, minute: 0 },
        end: { hour: 16, minute: 0 },
        attach: null,
        shift: null,
        existing: null,
      }),
    );
  });

  it("P22: 9 to 9:15 -- the parser does not enforce a minimum duration (the resolver does, R2)", () => {
    expect(parseCommand("assign Sam to Housing A on Cell 1 from 9 to 9:15")).toEqual(
      ok({
        intent: "assign",
        operator: "Sam",
        product: "Housing A",
        place: ["Cell 1"],
        day: null,
        start: { hour: 9, minute: 0 },
        end: { hour: 9, minute: 15 },
        attach: null,
        shift: null,
        existing: null,
      }),
    );
  });

  it("P23: formatCommand is the inverse of parseCommand for P1's sentence (round trip)", () => {
    const first = parseCommand(
      "Assign Operator 1 to work on Product A/Housing A on Cell 1 in Line 1 from 10AM to 2PM",
    );
    if (!first.ok) throw new Error("P1 must parse");
    const sentence = formatCommand(first.command);
    const second = parseCommand(sentence);
    expect(second).toEqual(first);
  });

  it("P24: a name that contains a separator word is quoted in formatCommand and round-trips; attach is never printed", () => {
    const command: AssignCommand = {
      intent: "assign",
      operator: "Lin On",
      product: "Housing A",
      place: ["Cell 1"],
      day: null,
      start: { hour: 10, minute: 0 },
      end: { hour: 14, minute: 0 },
      attach: null,
      shift: null,
      existing: null,
    };
    const sentence = formatCommand(command);
    expect(sentence).toContain('"Lin On"');
    const reparsed = parseCommand(sentence);
    expect(reparsed).toEqual({ ok: true, command });

    const withAttach: AssignCommand = { ...command, attach: { kind: "direct" } };
    expect(formatCommand(withAttach)).toBe(formatCommand(command));
  });
});

/**
 * F-133 (docs/agent-briefs/f-133-day-word-after-the-hours-brief.md §3/§4) —
 * the day word may come AFTER the hours too, in every grammar, so long as a
 * leading and a trailing day word never disagree (P27's `two_days`). F-134
 * (brief §3b, same file) — the afternoon rule now reads the START: an
 * unambiguous start (24h hour 13+, or an explicit am/pm) blocks the +12h
 * guess on the end (P32/P33), while a bare small-hour start keeps it
 * (P34-P36).
 */
describe("commandParse: F-133 the day word after the hours / F-134 the afternoon rule reads the start", () => {
  it("P25: the maintainer's own sentence verbatim, day trailing the hours", () => {
    expect(
      parseCommand(
        "put operator 1 to work on product A on Cell 1 in Line 1 from 10 to 2 on Saturday",
      ),
    ).toEqual(
      ok({
        intent: "assign",
        operator: "operator 1",
        product: "product A",
        place: ["Cell 1", "Line 1"],
        day: { kind: "weekday", day: 6 },
        start: { hour: 10, minute: 0 },
        end: { hour: 14, minute: 0 },
        attach: null,
        shift: null,
        existing: null,
      }),
    );
  });

  it("P26: a trailing iso date, tomorrow, today, and a short weekday", () => {
    const base = (day: AssignCommand["day"]) =>
      ok({
        intent: "assign",
        operator: "Sam",
        product: "Housing A",
        place: ["Cell 1"],
        day,
        start: { hour: 10, minute: 0 },
        end: { hour: 14, minute: 0 },
        attach: null,
        shift: null,
        existing: null,
      });
    expect(parseCommand("assign Sam to Housing A on Cell 1 from 10 to 2 on 2026-09-12")).toEqual(
      base({ kind: "date", iso: "2026-09-12" }),
    );
    expect(parseCommand("assign Sam to Housing A on Cell 1 from 10 to 2 tomorrow")).toEqual(
      base({ kind: "tomorrow" }),
    );
    expect(parseCommand("assign Sam to Housing A on Cell 1 from 10 to 2 today")).toEqual(
      base({ kind: "today" }),
    );
    expect(parseCommand("assign Sam to Housing A on Cell 1 from 10 to 2 sat")).toEqual(
      base({ kind: "weekday", day: 6 }),
    );
  });

  it("P27: the same day said twice is not a conflict; two different days is two_days", () => {
    expect(
      parseCommand("assign Sam to Housing A on Cell 1 on Saturday from 10 to 2 on Saturday"),
    ).toEqual(
      ok({
        intent: "assign",
        operator: "Sam",
        product: "Housing A",
        place: ["Cell 1"],
        day: { kind: "weekday", day: 6 },
        start: { hour: 10, minute: 0 },
        end: { hour: 14, minute: 0 },
        attach: null,
        shift: null,
        existing: null,
      }),
    );
    expect(
      parseCommand("assign Sam to Housing A on Cell 1 on Monday from 10 to 2 on Saturday"),
    ).toEqual({
      ok: false,
      failure: { kind: "two_days", first: "Monday", second: "Saturday" },
    });
  });

  it("P28: 'on funday' at the end is still swallowed into the time clause, exactly as before (not a day)", () => {
    expect(parseCommand("assign Sam to Housing A on Cell 1 from 10 to 2 on funday")).toEqual({
      ok: false,
      failure: { kind: "bad_time", text: "2 on funday" },
    });
  });

  it("P29: a trailing ISO-looking date that is not a real one is still bad_day", () => {
    expect(parseCommand("assign Sam to Housing A on Cell 1 from 10 to 2 on 2026-13-40")).toEqual({
      ok: false,
      failure: { kind: "bad_day", text: "2026-13-40" },
    });
  });

  it("P30: round trip — formatCommand keeps printing the day BEFORE the hours", () => {
    const first = parseCommand(
      "put operator 1 to work on product A on Cell 1 in Line 1 from 10 to 2 on Saturday",
    );
    if (!first.ok) throw new Error("P25's sentence must parse");
    const sentence = formatCommand(first.command);
    // quoteIfNeeded's real output for these words: none of "operator 1",
    // "product A", "Cell 1" or "Line 1" contain a whole-word to/on/at/in or
    // a comma, so none of them are quoted here (unlike the brief's own
    // illustrative example, which showed quotes — checked against the real
    // `quoteIfNeeded`, not assumed).
    expect(sentence).toBe(
      "assign operator 1 to product A on Cell 1 in Line 1 on sat from 10:00 to 14:00",
    );
    expect(parseCommand(sentence)).toEqual(first);
  });

  it("B12: book, a trailing day after the hours", () => {
    expect(parseCommand("Book Housing A on Cell 1 in Line 1 from 6 to 2 on Saturday")).toEqual(
      bookOk({ place: ["Cell 1", "Line 1"], day: { kind: "weekday", day: 6 } }),
    );
  });

  it("B13: book, headcount before the hours, day after", () => {
    expect(parseCommand("book Housing A on Cell 1 for 3 from 6 to 2 tomorrow")).toEqual(
      bookOk({ headcount: 3, day: { kind: "tomorrow" } }),
    );
  });

  it("U10: unassign, a trailing day after the hours", () => {
    expect(parseCommand("Unassign Sam from Cell 1 in Line 1 from 10 to 2 on Saturday")).toEqual({
      ok: true,
      command: {
        intent: "unassign",
        operator: "Sam",
        place: ["Cell 1", "Line 1"],
        day: { kind: "weekday", day: 6 },
        span: { start: { hour: 10, minute: 0 }, end: { hour: 14, minute: 0 } },
        shift: null,
        existing: null,
        until: null,
      },
    });
  });

  it("MV12: move, a trailing day after the hours", () => {
    expect(parseCommand("Move Sam on Cell 1 to Cell 2 from 10 to 3 on Saturday")).toEqual({
      ok: true,
      command: {
        intent: "move",
        adjust: null,
        operator: "Sam",
        place: ["Cell 1"],
        toPlace: ["Cell 2"],
        day: { kind: "weekday", day: 6 },
        span: { start: { hour: 10, minute: 0 }, end: { hour: 15, minute: 0 } },
        shift: null,
        existing: null,
      },
    });
  });

  it("P31: expectedShape() gains [on <day>] after the time clause in every clause", () => {
    expect(expectedShape()).toBe(
      "Say it like: assign <person> to <part> on <cell> [in <line>] [on <day>] from <time> to <time> [on <day>] — or: book <part> on <cell> [in <line>] [for <n> people] [on <day>] from <time> to <time> [on <day>] — or: unassign <person> from <cell> [in <line>] [on <day>] [from <time> to <time> [on <day>]] — or: move <person> on <cell> [in <line>] [to <cell> [in <line>]] [on <day>] [from <time> to <time> [on <day>]]",
    );
  });

  it("P32 (F-134): from 17:15 till 10:30 — an unambiguous 24h start blocks the afternoon guess, time_order", () => {
    expect(parseCommand("assign Sam to Housing A on Cell 1 from 17:15 till 10:30")).toEqual({
      ok: false,
      failure: { kind: "time_order" },
    });
  });

  it("P33 (F-134): from 1pm to 10 — an explicit meridiem start blocks the guess too, time_order", () => {
    expect(parseCommand("assign Sam to Housing A on Cell 1 from 1pm to 10")).toEqual({
      ok: false,
      failure: { kind: "time_order" },
    });
  });

  it("P34 (F-134): from 13:00 to 22:00 — already after the start, unaffected", () => {
    expect(parseCommand("assign Sam to Housing A on Cell 1 from 13:00 to 22:00")).toEqual(
      ok({
        intent: "assign",
        operator: "Sam",
        product: "Housing A",
        place: ["Cell 1"],
        day: null,
        start: { hour: 13, minute: 0 },
        end: { hour: 22, minute: 0 },
        attach: null,
        shift: null,
        existing: null,
      }),
    );
  });

  it("P35 (F-134): P9 and P11 keep their meaning under the new rule", () => {
    expect(parseCommand("assign Sam to Housing A on Cell 1 from 10 to 10")).toEqual(
      ok({
        intent: "assign",
        operator: "Sam",
        product: "Housing A",
        place: ["Cell 1"],
        day: null,
        start: { hour: 10, minute: 0 },
        end: { hour: 22, minute: 0 },
        attach: null,
        shift: null,
        existing: null,
      }),
    );
    expect(parseCommand("assign Sam to Housing A on Cell 1 from 12am to 4")).toEqual(
      ok({
        intent: "assign",
        operator: "Sam",
        product: "Housing A",
        place: ["Cell 1"],
        day: null,
        start: { hour: 0, minute: 0 },
        end: { hour: 4, minute: 0 },
        attach: null,
        shift: null,
        existing: null,
      }),
    );
  });

  it("P36 (F-134, M64's pin): from 12 to 3 — a bare hour-12 start is NOT pinned, P9's twin still gets the afternoon rule", () => {
    expect(parseCommand("assign Sam to Housing A on Cell 1 from 12 to 3")).toEqual(
      ok({
        intent: "assign",
        operator: "Sam",
        product: "Housing A",
        place: ["Cell 1"],
        day: null,
        start: { hour: 12, minute: 0 },
        end: { hour: 15, minute: 0 },
        attach: null,
        shift: null,
        existing: null,
      }),
    );
  });
});

/**
 * S41-a — the "book a job" grammar, brief docs/agent-briefs/
 * s41-a-book-a-job-brief.md §5's worked examples (B1-B11), run verbatim, the
 * same one-`it()`-per-case shape as the P-cases above.
 */
describe("commandParse: S41-a book-a-job worked examples", () => {
  it("B1: Book Housing A on Cell 1 in Line 1 from 6 to 2 -- book, no headcount", () => {
    expect(parseCommand("Book Housing A on Cell 1 in Line 1 from 6 to 2")).toEqual(
      bookOk({ place: ["Cell 1", "Line 1"] }),
    );
  });

  it("B2: run Housing A on Cell 1 for 3 people from 6 to 2 -- headcount 3", () => {
    expect(parseCommand("run Housing A on Cell 1 for 3 people from 6 to 2")).toEqual(
      bookOk({ headcount: 3 }),
    );
  });

  it("B3: book ... for 3 on tomorrow ... -- headcount 3, day tomorrow", () => {
    expect(parseCommand("book Housing A on Cell 1 for 3 on tomorrow from 6 to 2")).toEqual(
      bookOk({ headcount: 3, day: { kind: "tomorrow" } }),
    );
  });

  it("B4: for 0 and for 3.5 are both bad_headcount, with the offending text", () => {
    expect(parseCommand("book Housing A on Cell 1 for 0 from 6 to 2")).toEqual({
      ok: false,
      failure: { kind: "bad_headcount", text: "0" },
    });
    expect(parseCommand("book Housing A on Cell 1 for 3.5 from 6 to 2")).toEqual({
      ok: false,
      failure: { kind: "bad_headcount", text: "3.5" },
    });
  });

  it("B5: 'for lunch' is ordinary place text, not a headcount clause", () => {
    expect(parseCommand("book Housing A on Cell 1 for lunch from 6 to 2")).toEqual(
      bookOk({ place: ["Cell 1 for lunch"] }),
    );
  });

  it("B6: book Housing A from 6 to 2 -- no_place", () => {
    expect(parseCommand("book Housing A from 6 to 2")).toEqual({
      ok: false,
      failure: { kind: "no_place" },
    });
  });

  it("B7: book from 6 to 2 -- no_product", () => {
    expect(parseCommand("book from 6 to 2")).toEqual({
      ok: false,
      failure: { kind: "no_product" },
    });
  });

  it("B8: quoted names are atomic", () => {
    expect(parseCommand('Book "Cell in 2 Part" on "Cell in 2" from 6 to 2')).toEqual(
      bookOk({ product: "Cell in 2 Part", place: ["Cell in 2"] }),
    );
  });

  it("B9: formatCommand round-trips B2 and B3", () => {
    const b2 = parseCommand("run Housing A on Cell 1 for 3 people from 6 to 2");
    if (!b2.ok) throw new Error("B2 must parse");
    const sentence = formatCommand(b2.command);
    expect(sentence).toBe("book Housing A on Cell 1 for 3 people from 06:00 to 14:00");
    expect(parseCommand(sentence)).toEqual(b2);

    const b3 = parseCommand("book Housing A on Cell 1 for 3 on tomorrow from 6 to 2");
    if (!b3.ok) throw new Error("B3 must parse");
    expect(parseCommand(formatCommand(b3.command))).toEqual(b3);
  });

  it("B10: the first-word rule does not disturb assign -- 'assign'/'schedule' both parse as assign", () => {
    const expected: AssignCommand = {
      intent: "assign",
      operator: "Sam",
      product: "Housing A",
      place: ["Cell 1"],
      day: null,
      start: { hour: 10, minute: 0 },
      end: { hour: 14, minute: 0 },
      attach: null,
      shift: null,
      existing: null,
    };
    expect(parseCommand("assign Sam to Housing A on Cell 1 from 10 to 2")).toEqual(ok(expected));
    expect(parseCommand("schedule Sam to Housing A on Cell 1 from 10 to 2")).toEqual(ok(expected));
  });

  it("B11: expectedShape() is the exact two-shape sentence", () => {
    // S41-b adds a third clause and S41-c a fourth (contract changed twice
    // now, CLAUDE.md §4) -- see MV10 in the move describe block below for
    // the full four-shape text.
    expect(expectedShape()).toBe(
      "Say it like: assign <person> to <part> on <cell> [in <line>] [on <day>] from <time> to <time> [on <day>] — or: book <part> on <cell> [in <line>] [for <n> people] [on <day>] from <time> to <time> [on <day>] — or: unassign <person> from <cell> [in <line>] [on <day>] [from <time> to <time> [on <day>]] — or: move <person> on <cell> [in <line>] [to <cell> [in <line>]] [on <day>] [from <time> to <time> [on <day>]]",
    );
  });
});

/**
 * S41-b — the "unassign" grammar, brief docs/agent-briefs/
 * s41-b-unassign-brief.md §5's worked examples (U1-U9), run verbatim, the
 * same one-`it()`-per-case shape as the P- and B-cases above.
 */
describe("commandParse: S41-b unassign worked examples", () => {
  // S55 re-pin (R-409): `UnassignCommand` gains `until: DayWord | null`
  // (brief §1). Every existing unassign-shaped case in this file -- every
  // call through this helper, and every raw literal elsewhere (U10, MV11,
  // SH10, the dotted section, L1-L4, L15, L18) -- is re-pinned with
  // `until: null` added; none of their asserted VALUES changed, so one note
  // here stands for all of them rather than repeating it at each site.
  function unassignOk(overrides: Partial<UnassignCommand> = {}): {
    ok: true;
    command: UnassignCommand;
  } {
    return {
      ok: true,
      command: {
        intent: "unassign",
        operator: "Sam",
        place: ["Cell 1"],
        day: null,
        span: null,
        shift: null,
        existing: null,
        until: null,
        ...overrides,
      },
    };
  }

  it("U1: Unassign Sam from Cell 1 in Line 1 from 10 to 2 -- operator, place, span", () => {
    expect(parseCommand("Unassign Sam from Cell 1 in Line 1 from 10 to 2")).toEqual(
      unassignOk({
        place: ["Cell 1", "Line 1"],
        span: { start: { hour: 10, minute: 0 }, end: { hour: 14, minute: 0 } },
      }),
    );
  });

  it("U2: remove Sam from Cell 1 -- span null (no hours)", () => {
    expect(parseCommand("remove Sam from Cell 1")).toEqual(unassignOk());
  });

  it("U3: clear Sam off Cell 1 on tomorrow -- day tomorrow, span null", () => {
    expect(parseCommand("clear Sam off Cell 1 on tomorrow")).toEqual(
      unassignOk({ day: { kind: "tomorrow" } }),
    );
  });

  it("U4: unassign Sam from Cell 1 from 10 to 10:75 -- bad_time '10:75'", () => {
    expect(parseCommand("unassign Sam from Cell 1 from 10 to 10:75")).toEqual({
      ok: false,
      failure: { kind: "bad_time", text: "10:75" },
    });
  });

  it("U5: unassign from Cell 1 from 10 to 2 -- empty (no operator)", () => {
    expect(parseCommand("unassign from Cell 1 from 10 to 2")).toEqual({
      ok: false,
      failure: { kind: "empty" },
    });
  });

  it("U6: unassign Sam from 10 to 2 -- S50/R-398: the only 'from' is consumed by the time clause, leaving an empty place, not no_place", () => {
    expect(parseCommand("unassign Sam from 10 to 2")).toEqual({
      ok: true,
      command: {
        intent: "unassign",
        operator: "Sam",
        place: [],
        day: null,
        span: { start: { hour: 10, minute: 0 }, end: { hour: 14, minute: 0 } },
        shift: null,
        existing: null,
        until: null,
      },
    });
  });

  it("U7: formatCommand round-trips U1 and U2", () => {
    const u1 = parseCommand("Unassign Sam from Cell 1 in Line 1 from 10 to 2");
    if (!u1.ok) throw new Error("U1 must parse");
    expect(parseCommand(formatCommand(u1.command))).toEqual(u1);

    const u2 = parseCommand("remove Sam from Cell 1");
    if (!u2.ok) throw new Error("U2 must parse");
    expect(parseCommand(formatCommand(u2.command))).toEqual(u2);
  });

  it("U8: expectedShape() is the exact three-clause sentence", () => {
    // S41-c adds a fourth clause (contract changed again) -- see MV10 below.
    expect(expectedShape()).toBe(
      "Say it like: assign <person> to <part> on <cell> [in <line>] [on <day>] from <time> to <time> [on <day>] — or: book <part> on <cell> [in <line>] [for <n> people] [on <day>] from <time> to <time> [on <day>] — or: unassign <person> from <cell> [in <line>] [on <day>] [from <time> to <time> [on <day>]] — or: move <person> on <cell> [in <line>] [to <cell> [in <line>]] [on <day>] [from <time> to <time> [on <day>]]",
    );
  });

  it("U9: assign/book sentences still parse as before -- the first-word rule is unaffected", () => {
    const assignResult = parseCommand("assign Sam to Housing A on Cell 1 from 10 to 2");
    expect(assignResult).toEqual({
      ok: true,
      command: {
        intent: "assign",
        operator: "Sam",
        product: "Housing A",
        place: ["Cell 1"],
        day: null,
        start: { hour: 10, minute: 0 },
        end: { hour: 14, minute: 0 },
        attach: null,
        shift: null,
        existing: null,
      },
    });

    const bookResult = parseCommand("book Housing A on Cell 1 from 6 to 2");
    expect(bookResult).toEqual({
      ok: true,
      command: {
        intent: "book",
        product: "Housing A",
        place: ["Cell 1"],
        headcount: null,
        day: null,
        start: { hour: 6, minute: 0 },
        end: { hour: 14, minute: 0 },
        shift: null,
        existing: null,
      },
    });
  });
});

/**
 * S41-c — the "move" grammar, brief docs/agent-briefs/s41-c-move-brief.md
 * §5's worked examples (MV1-MV10), the same one-`it()`-per-case shape as
 * the describe blocks above.
 */
describe("commandParse: S41-c move worked examples", () => {
  function moveOk(overrides: Partial<MoveCommand> = {}): { ok: true; command: MoveCommand } {
    return {
      ok: true,
      command: {
        intent: "move",
        adjust: null,
        operator: "Sam",
        place: ["Cell 1"],
        toPlace: null,
        day: null,
        span: null,
        shift: null,
        existing: null,
        ...overrides,
      },
    };
  }

  it("MV1: Move Sam on Cell 1 to Cell 2 in Line 1 -- toPlace given, span null", () => {
    expect(parseCommand("Move Sam on Cell 1 to Cell 2 in Line 1")).toEqual(
      moveOk({ toPlace: ["Cell 2", "Line 1"] }),
    );
  });

  it("MV2: move Sam on Cell 1 in Line 1 to 10 to 3 -- toPlace null, span 10:00-15:00", () => {
    expect(parseCommand("move Sam on Cell 1 in Line 1 to 10 to 3")).toEqual(
      moveOk({
        place: ["Cell 1", "Line 1"],
        span: { start: { hour: 10, minute: 0 }, end: { hour: 15, minute: 0 } },
      }),
    );
  });

  it("MV3: move Sam on Cell 1 to Cell 2 from 10 to 3 -- both toPlace and span", () => {
    expect(parseCommand("move Sam on Cell 1 to Cell 2 from 10 to 3")).toEqual(
      moveOk({
        toPlace: ["Cell 2"],
        span: { start: { hour: 10, minute: 0 }, end: { hour: 15, minute: 0 } },
      }),
    );
  });

  it("MV4: move Sam on Cell 1 -- no_move (neither a new cell nor new hours)", () => {
    expect(parseCommand("move Sam on Cell 1")).toEqual({ ok: false, failure: { kind: "no_move" } });
  });

  it("MV5: move Sam to Cell 2 -- S50/R-398: no on/at/from before a place at all, so the destination is read out of the operator segment, empty place, not no_place", () => {
    expect(parseCommand("move Sam to Cell 2")).toEqual({
      ok: true,
      command: {
        intent: "move",
        adjust: null,
        operator: "Sam",
        place: [],
        toPlace: ["Cell 2"],
        day: null,
        span: null,
        shift: null,
        existing: null,
      },
    });
  });

  it("MV6: move on Cell 1 to Cell 2 -- empty (no operator)", () => {
    expect(parseCommand("move on Cell 1 to Cell 2")).toEqual({
      ok: false,
      failure: { kind: "empty" },
    });
  });

  it("MV7: move Sam at Cell 1 on tomorrow to Cell 2 -- day tomorrow, read from the CURRENT place segment", () => {
    expect(parseCommand("move Sam at Cell 1 on tomorrow to Cell 2")).toEqual(
      moveOk({ day: { kind: "tomorrow" }, toPlace: ["Cell 2"] }),
    );
  });

  it("MV8: quoted names are atomic", () => {
    expect(parseCommand('Move "Sam, the new guy" on "Cell, One" to "Cell, Two" in Line 1')).toEqual(
      moveOk({
        operator: "Sam, the new guy",
        place: ["Cell, One"],
        toPlace: ["Cell, Two", "Line 1"],
      }),
    );
  });

  it("MV9: formatCommand round-trips MV1-MV3", () => {
    const mv1 = parseCommand("Move Sam on Cell 1 to Cell 2 in Line 1");
    if (!mv1.ok) throw new Error("MV1 must parse");
    const sentence = formatCommand(mv1.command);
    expect(sentence).toBe("move Sam on Cell 1 to Cell 2 in Line 1");
    expect(parseCommand(sentence)).toEqual(mv1);

    const mv2 = parseCommand("move Sam on Cell 1 in Line 1 to 10 to 3");
    if (!mv2.ok) throw new Error("MV2 must parse");
    expect(parseCommand(formatCommand(mv2.command))).toEqual(mv2);

    const mv3 = parseCommand("move Sam on Cell 1 to Cell 2 from 10 to 3");
    if (!mv3.ok) throw new Error("MV3 must parse");
    expect(parseCommand(formatCommand(mv3.command))).toEqual(mv3);
  });

  it("MV10: expectedShape() is the exact four-clause sentence", () => {
    expect(expectedShape()).toBe(
      "Say it like: assign <person> to <part> on <cell> [in <line>] [on <day>] from <time> to <time> [on <day>] — or: book <part> on <cell> [in <line>] [for <n> people] [on <day>] from <time> to <time> [on <day>] — or: unassign <person> from <cell> [in <line>] [on <day>] [from <time> to <time> [on <day>]] — or: move <person> on <cell> [in <line>] [to <cell> [in <line>]] [on <day>] [from <time> to <time> [on <day>]]",
    );
  });

  it("MV11 (brief's three regression pins): assign, book and unassign sentences still parse exactly as before", () => {
    expect(parseCommand("assign Sam to Housing A on Cell 1 from 10 to 2")).toEqual({
      ok: true,
      command: {
        intent: "assign",
        operator: "Sam",
        product: "Housing A",
        place: ["Cell 1"],
        day: null,
        start: { hour: 10, minute: 0 },
        end: { hour: 14, minute: 0 },
        attach: null,
        shift: null,
        existing: null,
      },
    });
    expect(parseCommand("book Housing A on Cell 1 from 6 to 2")).toEqual({
      ok: true,
      command: {
        intent: "book",
        product: "Housing A",
        place: ["Cell 1"],
        headcount: null,
        day: null,
        start: { hour: 6, minute: 0 },
        end: { hour: 14, minute: 0 },
        shift: null,
        existing: null,
      },
    });
    expect(parseCommand("unassign Sam from Cell 1 in Line 1 from 10 to 2")).toEqual({
      ok: true,
      command: {
        intent: "unassign",
        operator: "Sam",
        place: ["Cell 1", "Line 1"],
        day: null,
        span: { start: { hour: 10, minute: 0 }, end: { hour: 14, minute: 0 } },
        shift: null,
        existing: null,
        until: null,
      },
    });
  });
});

describe("commandParse: R-391 the optional verb widens, one list per sentence", () => {
  // Hard-coded, never derived from the exported lists themselves -- a
  // mutation that drops a verb from its list must still be tried here to be
  // caught (brief §4, M70).
  const NEW_ASSIGN_VERBS = ["staff", "place", "allocate", "give", "set"];
  const NEW_BOOK_VERBS = ["plan", "open", "start", "launch", "create"];
  const NEW_UNASSIGN_VERBS = ["drop", "cancel", "delete", "pull", "free"];
  // R-401 (13 Sept, session 163): "change" and "shift" join the move list --
  // the maintainer withdrew R-391's exclusion.
  const NEW_MOVE_VERBS = ["reschedule", "transfer", "relocate", "switch", "change", "shift"];

  const ASSIGN_TAIL = "Sam to Housing A on Cell 1 from 10 to 2";
  const BOOK_TAIL = "Housing A on Cell 1 in Line 1 from 6 to 2";
  const UNASSIGN_TAIL = "Sam from Cell 1 in Line 1 from 10 to 2";
  const MOVE_TAIL = "Sam on Cell 1 to Cell 2 in Line 1";

  for (const verb of NEW_ASSIGN_VERBS) {
    it(`PV1 ${verb}: parses like the P1-shaped assign example, same command as 'assign'`, () => {
      expect(parseCommand(`${verb} ${ASSIGN_TAIL}`)).toEqual(parseCommand(`assign ${ASSIGN_TAIL}`));
    });
  }

  for (const verb of NEW_BOOK_VERBS) {
    it(`PV1 ${verb}: parses like the B1-shaped book example, same command as 'book'`, () => {
      expect(parseCommand(`${verb} ${BOOK_TAIL}`)).toEqual(parseCommand(`book ${BOOK_TAIL}`));
    });
  }

  for (const verb of NEW_UNASSIGN_VERBS) {
    it(`PV1 ${verb}: parses like the U1-shaped unassign example, same command as 'unassign'`, () => {
      expect(parseCommand(`${verb} ${UNASSIGN_TAIL}`)).toEqual(
        parseCommand(`unassign ${UNASSIGN_TAIL}`),
      );
    });
  }

  for (const verb of NEW_MOVE_VERBS) {
    it(`PV1 ${verb}: parses like the MV1-shaped move example, same command as 'move'`, () => {
      expect(parseCommand(`${verb} ${MOVE_TAIL}`)).toEqual(parseCommand(`move ${MOVE_TAIL}`));
    });
  }

  it("PV2 (re-pinned, R-401): the four exported verb lists are pairwise disjoint; 'shift' and 'change' are both in the move list only", () => {
    const lists: readonly (readonly string[])[] = [
      ASSIGN_VERBS,
      BOOK_VERBS,
      UNASSIGN_VERBS,
      MOVE_VERBS,
    ];
    const all = lists.flatMap((list) => list);
    expect(new Set(all).size).toBe(all.length);
    expect(MOVE_VERBS).toContain("shift");
    expect(MOVE_VERBS).toContain("change");
    expect(ASSIGN_VERBS).not.toContain("shift");
    expect(ASSIGN_VERBS).not.toContain("change");
    expect(BOOK_VERBS).not.toContain("shift");
    expect(BOOK_VERBS).not.toContain("change");
    expect(UNASSIGN_VERBS).not.toContain("shift");
    expect(UNASSIGN_VERBS).not.toContain("change");
  });

  it("PV3: 'schedule Housing A on Cell 1 from 6 to 2' is still read as an assign sentence and fails no_place", () => {
    expect(parseCommand("schedule Housing A on Cell 1 from 6 to 2")).toEqual({
      ok: false,
      failure: { kind: "no_place" },
    });
  });

  it("PV4: formatCommand still prints the canonical verb for a command parsed from any synonym (round trip)", () => {
    const cases: Array<{ sentence: string; canonicalVerb: string }> = [
      { sentence: `staff ${ASSIGN_TAIL}`, canonicalVerb: "assign" },
      { sentence: `plan ${BOOK_TAIL}`, canonicalVerb: "book" },
      { sentence: `drop ${UNASSIGN_TAIL}`, canonicalVerb: "unassign" },
      { sentence: `reschedule ${MOVE_TAIL}`, canonicalVerb: "move" },
    ];
    for (const { sentence, canonicalVerb } of cases) {
      const result = parseCommand(sentence);
      if (!result.ok) throw new Error(`${sentence} must parse`);
      const printed = formatCommand(result.command);
      expect(printed.startsWith(`${canonicalVerb} `)).toBe(true);
      expect(parseCommand(printed)).toEqual(result);
    }
  });

  it("PV5: a capitalised or all-caps new verb works like the old ones (case rule unchanged)", () => {
    expect(parseCommand(`STAFF ${ASSIGN_TAIL}`)).toEqual(parseCommand(`assign ${ASSIGN_TAIL}`));
    expect(parseCommand(`Reschedule ${MOVE_TAIL}`)).toEqual(parseCommand(`move ${MOVE_TAIL}`));
  });
});

/**
 * S52-a (docs/agent-briefs/s52-a-shift-grammar-brief.md, R-401/R-402, design
 * §19.99/D128) -- change and shift join the move verb list, a possessive
 * timing tail on the move grammar's operator segment reads as the person,
 * and a shift clause anywhere after the person stands in for the hours on
 * every intent. SH1-SH14, one `it()` per case.
 */
describe("commandParse: S52 change, shift, and a shift by name", () => {
  it("SH1 (R-401): change Operator A3's timing to 8 pm to 11 pm -- move in time, no place, the possessive tail names the person", () => {
    expect(parseCommand("change Operator A3's timing to 8 pm to 11 pm")).toEqual(
      ok({
        intent: "move",
        adjust: null,
        operator: "Operator A3",
        place: [],
        toPlace: null,
        day: null,
        span: { start: { hour: 20, minute: 0 }, end: { hour: 23, minute: 0 } },
        existing: null,
        shift: null,
      }),
    );
  });

  it("SH2 (R-401, F-144): change operator a3s timing to 8:00 p.m. to 11:00 p.m. -- the recogniser's bare-s, dotted-meridiem spelling reads the same person", () => {
    expect(parseCommand("change operator a3s timing to 8:00 p.m. to 11:00 p.m.")).toEqual(
      ok({
        intent: "move",
        adjust: null,
        operator: "operator a3",
        place: [],
        toPlace: null,
        day: null,
        span: { start: { hour: 20, minute: 0 }, end: { hour: 23, minute: 0 } },
        existing: null,
        shift: null,
      }),
    );
  });

  it("SH3 (R-401): change Sam’s hours to 9 to 5 -- the curly apostrophe and the 'hours' spelling both strip", () => {
    expect(parseCommand("change Sam’s hours to 9 to 5")).toEqual(
      ok({
        intent: "move",
        adjust: null,
        operator: "Sam",
        place: [],
        toPlace: null,
        day: null,
        span: { start: { hour: 9, minute: 0 }, end: { hour: 17, minute: 0 } },
        existing: null,
        shift: null,
      }),
    );
  });

  it("SH4 (R-401): change Operator A3s schedule to 8 to 9 -- the bare-s spelling with 'schedule' also strips", () => {
    expect(parseCommand("change Operator A3s schedule to 8 to 9")).toEqual(
      ok({
        intent: "move",
        adjust: null,
        operator: "Operator A3",
        place: [],
        toPlace: null,
        day: null,
        span: { start: { hour: 8, minute: 0 }, end: { hour: 9, minute: 0 } },
        existing: null,
        shift: null,
      }),
    );
  });

  it("SH5 (R-401): shift Operator A3 to Cell 2 -- shift as a verb, moved to Cell 2", () => {
    expect(parseCommand("shift Operator A3 to Cell 2")).toEqual(
      ok({
        intent: "move",
        adjust: null,
        operator: "Operator A3",
        place: [],
        toPlace: ["Cell 2"],
        day: null,
        span: null,
        existing: null,
        shift: null,
      }),
    );
  });

  it("SH6 (R-401): change Sam on Cell 1 to Cell 2 -- the placed move, no possessive tail to strip", () => {
    expect(parseCommand("change Sam on Cell 1 to Cell 2")).toEqual(
      ok({
        intent: "move",
        adjust: null,
        operator: "Sam",
        place: ["Cell 1"],
        toPlace: ["Cell 2"],
        day: null,
        span: null,
        existing: null,
        shift: null,
      }),
    );
  });

  it("SH7 (R-402): move Sam on Cell 1 for shift 2 -- 'shift' mid-sentence is the shift clause, not a verb, and it alone satisfies R-389's new hours", () => {
    expect(parseCommand("move Sam on Cell 1 for shift 2")).toEqual(
      ok({
        intent: "move",
        adjust: null,
        operator: "Sam",
        place: ["Cell 1"],
        toPlace: null,
        day: null,
        span: null,
        existing: null,
        shift: "2",
      }),
    );
  });

  it("SH8 (R-402): assign Sam to Housing A on Cell 1 for shift 2 -- start/end null, shift '2'", () => {
    expect(parseCommand("assign Sam to Housing A on Cell 1 for shift 2")).toEqual(
      ok({
        intent: "assign",
        operator: "Sam",
        product: "Housing A",
        place: ["Cell 1"],
        day: null,
        start: null,
        end: null,
        attach: null,
        existing: null,
        shift: "2",
      }),
    );
  });

  it("SH9 (R-402): book Housing A on Cell 1 in Line 1 on the night shift -- the name PRECEDES the word 'shift'", () => {
    expect(parseCommand("book Housing A on Cell 1 in Line 1 on the night shift")).toEqual(
      bookOk({
        place: ["Cell 1", "Line 1"],
        start: null,
        end: null,
        shift: "night",
      }),
    );
  });

  it("SH10 (R-402): unassign Sam from Cell 1 for shift 1 -- a removal, span null", () => {
    expect(parseCommand("unassign Sam from Cell 1 for shift 1")).toEqual(
      ok({
        intent: "unassign",
        operator: "Sam",
        place: ["Cell 1"],
        day: null,
        span: null,
        existing: null,
        shift: "1",
        until: null,
      }),
    );
  });

  it('SH11 (R-402): assign Sam to Housing A on Cell 1 for shift "Late Turn" -- a quoted, multi-word shift name', () => {
    expect(parseCommand('assign Sam to Housing A on Cell 1 for shift "Late Turn"')).toEqual(
      ok({
        intent: "assign",
        operator: "Sam",
        product: "Housing A",
        place: ["Cell 1"],
        day: null,
        start: null,
        end: null,
        attach: null,
        existing: null,
        shift: "Late Turn",
      }),
    );
  });

  it("SH12 (R-402): a shift AND hours together -- shift_and_hours, never a guess which wins", () => {
    expect(parseCommand("assign Sam to Housing A on Cell 1 for shift 2 from 10 to 2")).toEqual({
      ok: false,
      failure: { kind: "shift_and_hours" },
    });
  });

  it("SH13 (R-402): no hours and no shift on an assign -- no_time, unchanged", () => {
    expect(parseCommand("assign Sam to Housing A on Cell 1")).toEqual({
      ok: false,
      failure: { kind: "no_time" },
    });
  });

  it("SH14 (R-402): the maintainer's product-last sentence, its comma variant, a product-first sentence with a shift, both round trips, and a several copying shift onto both", () => {
    const productLast = parseCommand(
      "assign Operator A2 to work for shift 2 on Cell 1 in Line 1 for Housing A",
    );
    const expectedProductLast = ok({
      intent: "assign",
      operator: "Operator A2",
      product: "Housing A",
      place: ["Cell 1", "Line 1"],
      day: null,
      start: null,
      end: null,
      attach: null,
      existing: null,
      shift: "2",
    });
    expect(productLast).toEqual(expectedProductLast);

    // The comma qualifier reads the same way.
    expect(
      parseCommand("Assign Operator A2 to work for shift 2 on Cell 1, Line 1 for Housing A"),
    ).toEqual(expectedProductLast);

    // A product-first sentence with a shift also works (the product precedes
    // the places, so nothing after the operator separator needs the
    // trailing-"for" reading at all).
    expect(parseCommand("put Sam on Housing A on Cell 1 for shift 1")).toEqual(
      ok({
        intent: "assign",
        operator: "Sam",
        product: "Housing A",
        place: ["Cell 1"],
        day: null,
        start: null,
        end: null,
        attach: null,
        existing: null,
        shift: "1",
      }),
    );

    // formatCommand round-trips a shift assign...
    if (productLast.ok) {
      const printed = formatCommand(productLast.command);
      expect(parseCommand(printed)).toEqual(productLast);
    }
    // ...and a shift removal.
    const removal = parseCommand("unassign Sam from Cell 1 for shift 1");
    expect(removal.ok).toBe(true);
    if (removal.ok) {
      const printed = formatCommand(removal.command);
      expect(parseCommand(printed)).toEqual(removal);
    }

    // A several with a shift copies it onto every inner command.
    expect(parseCommand("assign A2 and A3 to Housing A on Cell 1 for shift 2")).toEqual({
      ok: true,
      command: {
        intent: "several",
        commands: [
          {
            intent: "assign",
            operator: "A2",
            product: "Housing A",
            place: ["Cell 1"],
            day: null,
            start: null,
            end: null,
            attach: null,
            existing: null,
            shift: "2",
          },
          {
            intent: "assign",
            operator: "A3",
            product: "Housing A",
            place: ["Cell 1"],
            day: null,
            start: null,
            end: null,
            attach: null,
            existing: null,
            shift: "2",
          },
        ],
      },
    });
  });

  it("SH15 (reviewer, blocker 1): 'on Shift Bay 2' is a place (on/in are never the NAMED form's own preposition), while a quoted 'for shift \"Bay 2\"' is still a shift", () => {
    expect(parseCommand("assign Sam to Housing A on Shift Bay 2 from 8 to 4")).toEqual(
      ok({
        intent: "assign",
        operator: "Sam",
        product: "Housing A",
        place: ["Shift Bay 2"],
        day: null,
        start: { hour: 8, minute: 0 },
        end: { hour: 16, minute: 0 },
        attach: null,
        existing: null,
        shift: null,
      }),
    );

    expect(parseCommand('assign Sam to Housing A on Cell 1 for shift "Bay 2"')).toEqual(
      ok({
        intent: "assign",
        operator: "Sam",
        product: "Housing A",
        place: ["Cell 1"],
        day: null,
        start: null,
        end: null,
        attach: null,
        existing: null,
        shift: "Bay 2",
      }),
    );
  });

  it("SH16 (reviewer, blocker 2): formatCommand quotes a shift name whenever printing it unquoted would not round-trip", () => {
    const base = {
      intent: "assign" as const,
      operator: "Sam",
      product: "Housing A",
      place: ["Cell 1"],
      day: null,
      start: null,
      end: null,
      attach: null,
      existing: null,
    };
    const cases: Array<{ shift: string; quoted: boolean }> = [
      { shift: "2", quoted: false },
      { shift: "Night", quoted: false },
      { shift: "Late Turn", quoted: true },
      { shift: "Day For Real", quoted: true },
      { shift: "Late Turn Alpha", quoted: true },
    ];
    for (const { shift, quoted } of cases) {
      const command: AssignCommand = { ...base, shift };
      const printed = formatCommand(command);
      expect(printed.includes(`"${shift}"`), `${shift}: quoted in "${printed}"`).toBe(quoted);
      if (!quoted) expect(printed.endsWith(`shift ${shift}`), printed).toBe(true);
      expect(parseCommand(printed)).toEqual(ok(command));
    }
  });

  it("SH17 (reviewer, should-fix 1): the bare-s possessive only fires right after a digit -- 'a3s timing' still strips, 'Chris time' does not", () => {
    expect(parseCommand("change operator a3s timing to 8 pm to 11 pm")).toEqual(
      ok({
        intent: "move",
        adjust: null,
        operator: "operator a3",
        place: [],
        toPlace: null,
        day: null,
        span: { start: { hour: 20, minute: 0 }, end: { hour: 23, minute: 0 } },
        existing: null,
        shift: null,
      }),
    );

    // "Chris" ends in "s" but not right after a digit -- the possessive
    // tail is left alone (a choice, pinned so it stays one).
    expect(parseCommand("move Chris time to Cell 2")).toEqual(
      ok({
        intent: "move",
        adjust: null,
        operator: "Chris time",
        place: [],
        toPlace: ["Cell 2"],
        day: null,
        span: null,
        existing: null,
        shift: null,
      }),
    );
  });
});

describe("commandParse: dotted a.m./p.m. from the recogniser", () => {
  it("assign, dotted meridiem with a trailing sentence period: 7:00 p.m. to 8:00 p.m.", () => {
    expect(parseCommand("assign Sam to Housing A on Cell 1 from 7:00 p.m. to 8:00 p.m.")).toEqual(
      ok({
        intent: "assign",
        operator: "Sam",
        product: "Housing A",
        place: ["Cell 1"],
        day: null,
        start: { hour: 19, minute: 0 },
        end: { hour: 20, minute: 0 },
        attach: null,
        shift: null,
        existing: null,
      }),
    );
  });

  it("unassign, mixed case dotted meridiem: 8 a.m. to 11 A.M.", () => {
    expect(parseCommand("unassign Sam from Cell 1 from 8 a.m. to 11 A.M.")).toEqual(
      ok({
        intent: "unassign",
        operator: "Sam",
        place: ["Cell 1"],
        day: null,
        span: { start: { hour: 8, minute: 0 }, end: { hour: 11, minute: 0 } },
        shift: null,
        existing: null,
        until: null,
      }),
    );
  });

  it("move, dotted meridiem with no trailing dots: 7 p.m to 9 p.m", () => {
    expect(parseCommand("move Sam on Cell 1 to 7 p.m to 9 p.m")).toEqual(
      ok({
        intent: "move",
        adjust: null,
        operator: "Sam",
        place: ["Cell 1"],
        toPlace: null,
        day: null,
        span: { start: { hour: 19, minute: 0 }, end: { hour: 21, minute: 0 } },
        shift: null,
        existing: null,
      }),
    );
  });

  it("existing-behaviour guard: 'from 7 to 8' with no meridiem at all is unaffected", () => {
    expect(parseCommand("assign Sam to Housing A on Cell 1 from 7 to 8")).toEqual(
      ok({
        intent: "assign",
        operator: "Sam",
        product: "Housing A",
        place: ["Cell 1"],
        day: null,
        start: { hour: 7, minute: 0 },
        end: { hour: 8, minute: 0 },
        attach: null,
        shift: null,
        existing: null,
      }),
    );
  });
});

/**
 * S50 (docs/agent-briefs/s50-a-grammar-brief.md §2, R-398, design §19.97/
 * D126) — a removal or a move need not name a place, and the operator
 * segment or the first place segment may list more than one item. L1–L16,
 * run verbatim, the same one-`it()`-per-case shape as every describe block
 * above.
 */
describe("commandParse: S50 no place, and several in one sentence", () => {
  it("L1: remove Operator A3 -- empty place, span null, no day", () => {
    expect(parseCommand("remove Operator A3")).toEqual({
      ok: true,
      command: {
        intent: "unassign",
        operator: "Operator A3",
        place: [],
        day: null,
        span: null,
        shift: null,
        existing: null,
        until: null,
      },
    });
  });

  it("L2: remove Operator A3 today -- empty place, with a day", () => {
    expect(parseCommand("remove Operator A3 today")).toEqual({
      ok: true,
      command: {
        intent: "unassign",
        operator: "Operator A3",
        place: [],
        day: { kind: "today" },
        span: null,
        shift: null,
        existing: null,
        until: null,
      },
    });
  });

  it("L3: unassign Operator A3 from 3 to 5 -- empty place, hours only (the 'from' the time clause consumed leaves nothing for a place)", () => {
    expect(parseCommand("unassign Operator A3 from 3 to 5")).toEqual({
      ok: true,
      command: {
        intent: "unassign",
        operator: "Operator A3",
        place: [],
        day: null,
        span: { start: { hour: 3, minute: 0 }, end: { hour: 5, minute: 0 } },
        shift: null,
        existing: null,
        until: null,
      },
    });
  });

  it('L4: unassign "Ann At Bay" from 3 to 5 -- a quoted name with hours, empty place', () => {
    // The brief's own illustrative parenthetical for this sentence reads
    // "span 15:00-17:00" -- checked against the real, already-pinned (P9/
    // P35/P36) afternoon rule, which only ever shifts the END, never the
    // START, and only when the end is not already after the start (it is
    // here: 5 > 3) -- so the actual, mechanically consistent span is
    // 03:00-05:00, exactly what "clear A3 tomorrow from 8 to 11" (S50's own
    // next example, 8 to 11, no shift) computes by the same rule. Pinned to
    // the real behaviour, not the brief's prose (CLAUDE.md §4: never guess;
    // reported in the final summary for the maintainer to confirm).
    expect(parseCommand('unassign "Ann At Bay" from 3 to 5')).toEqual({
      ok: true,
      command: {
        intent: "unassign",
        operator: "Ann At Bay",
        place: [],
        day: null,
        span: { start: { hour: 3, minute: 0 }, end: { hour: 5, minute: 0 } },
        shift: null,
        existing: null,
        until: null,
      },
    });
  });

  it("L5: remove alone -- still empty (no operator at all)", () => {
    expect(parseCommand("remove")).toEqual({ ok: false, failure: { kind: "empty" } });
  });

  it("L5b: remove from Cell 1 -- still empty (no operator, place-less rule does not touch this)", () => {
    expect(parseCommand("remove from Cell 1")).toEqual({ ok: false, failure: { kind: "empty" } });
  });

  it("L6: move Operator A3 to 8 pm to 11 pm -- empty place, toPlace null, span from the hours", () => {
    expect(parseCommand("move Operator A3 to 8 pm to 11 pm")).toEqual({
      ok: true,
      command: {
        intent: "move",
        adjust: null,
        operator: "Operator A3",
        place: [],
        toPlace: null,
        day: null,
        span: { start: { hour: 20, minute: 0 }, end: { hour: 23, minute: 0 } },
        shift: null,
        existing: null,
      },
    });
  });

  it("L7: move A3 tomorrow to Cell 2 -- a day BEFORE the destination, empty place, toPlace given", () => {
    expect(parseCommand("move A3 tomorrow to Cell 2")).toEqual({
      ok: true,
      command: {
        intent: "move",
        adjust: null,
        operator: "A3",
        place: [],
        toPlace: ["Cell 2"],
        day: { kind: "tomorrow" },
        span: null,
        shift: null,
        existing: null,
      },
    });
  });

  it("L8: move A3 to Cell 2 -- empty place, toPlace given, no hours", () => {
    expect(parseCommand("move A3 to Cell 2")).toEqual({
      ok: true,
      command: {
        intent: "move",
        adjust: null,
        operator: "A3",
        place: [],
        toPlace: ["Cell 2"],
        day: null,
        span: null,
        shift: null,
        existing: null,
      },
    });
  });

  it("L9: move A3 -- still no_move (neither a new cell nor new hours, place-less or not)", () => {
    expect(parseCommand("move A3")).toEqual({ ok: false, failure: { kind: "no_move" } });
  });

  it("L9b: move A3 on Cell 1 -- still no_move (a place was said, but nothing to move it to)", () => {
    expect(parseCommand("move A3 on Cell 1")).toEqual({ ok: false, failure: { kind: "no_move" } });
  });

  it("L10: the maintainer's own sentence -- two people, two cells, pairs in order, every field copied", () => {
    expect(
      parseCommand(
        "assign Operator A2 and Operator A3 to Housing A on Cell 1 and Cell 2 in Line 1 today from 3 to 5",
      ),
    ).toEqual({
      ok: true,
      command: {
        intent: "several",
        commands: [
          {
            intent: "assign",
            operator: "Operator A2",
            product: "Housing A",
            place: ["Cell 1", "Line 1"],
            day: { kind: "today" },
            start: { hour: 3, minute: 0 },
            end: { hour: 5, minute: 0 },
            attach: null,
            shift: null,
            existing: null,
          },
          {
            intent: "assign",
            operator: "Operator A3",
            product: "Housing A",
            place: ["Cell 2", "Line 1"],
            day: { kind: "today" },
            start: { hour: 3, minute: 0 },
            end: { hour: 5, minute: 0 },
            attach: null,
            shift: null,
            existing: null,
          },
        ],
      },
    });
  });

  it("L11: two people, one cell -- both land on the same place", () => {
    expect(parseCommand("assign A2 and A3 to Housing A on Cell 1 from 10 to 2")).toEqual({
      ok: true,
      command: {
        intent: "several",
        commands: [
          {
            intent: "assign",
            operator: "A2",
            product: "Housing A",
            place: ["Cell 1"],
            day: null,
            start: { hour: 10, minute: 0 },
            end: { hour: 14, minute: 0 },
            attach: null,
            shift: null,
            existing: null,
          },
          {
            intent: "assign",
            operator: "A3",
            product: "Housing A",
            place: ["Cell 1"],
            day: null,
            start: { hour: 10, minute: 0 },
            end: { hour: 14, minute: 0 },
            attach: null,
            shift: null,
            existing: null,
          },
        ],
      },
    });
  });

  it("L12: one person, two cells -- that person lands on each", () => {
    expect(parseCommand("assign A2 to Housing A on Cell 1 and Cell 2 from 10 to 2")).toEqual({
      ok: true,
      command: {
        intent: "several",
        commands: [
          {
            intent: "assign",
            operator: "A2",
            product: "Housing A",
            place: ["Cell 1"],
            day: null,
            start: { hour: 10, minute: 0 },
            end: { hour: 14, minute: 0 },
            attach: null,
            shift: null,
            existing: null,
          },
          {
            intent: "assign",
            operator: "A2",
            product: "Housing A",
            place: ["Cell 2"],
            day: null,
            start: { hour: 10, minute: 0 },
            end: { hour: 14, minute: 0 },
            attach: null,
            shift: null,
            existing: null,
          },
        ],
      },
    });
  });

  it("L13: three people, two cells -- list_mismatch, never a guess", () => {
    expect(
      parseCommand("assign A1, A2 and A3 to Housing A on Cell 1 and Cell 2 from 10 to 2"),
    ).toEqual({
      ok: false,
      failure: { kind: "list_mismatch", people: 3, places: 2 },
    });
  });

  it('L14: a quoted "Ann and Bob" is one name (single command); A1, A2 and A3 is three', () => {
    expect(parseCommand('assign "Ann and Bob" to Housing A on Cell 1 from 10 to 2')).toEqual(
      ok({
        intent: "assign",
        operator: "Ann and Bob",
        product: "Housing A",
        place: ["Cell 1"],
        day: null,
        start: { hour: 10, minute: 0 },
        end: { hour: 14, minute: 0 },
        attach: null,
        shift: null,
        existing: null,
      }),
    );

    const three = parseCommand("assign A1, A2 and A3 to Housing A on Cell 1 from 10 to 2");
    expect(three.ok).toBe(true);
    if (three.ok) {
      expect(three.command.intent).toBe("several");
      if (three.command.intent === "several") {
        expect(
          three.command.commands.map((c) => (c.intent === "assign" ? c.operator : null)),
        ).toEqual(["A1", "A2", "A3"]);
      }
    }
  });

  it("L15: remove A2 and A3 from Cell 1 -- several unassign, same place on both", () => {
    expect(parseCommand("remove A2 and A3 from Cell 1")).toEqual({
      ok: true,
      command: {
        intent: "several",
        commands: [
          {
            intent: "unassign",
            operator: "A2",
            place: ["Cell 1"],
            day: null,
            span: null,
            shift: null,
            existing: null,
            until: null,
          },
          {
            intent: "unassign",
            operator: "A3",
            place: ["Cell 1"],
            day: null,
            span: null,
            shift: null,
            existing: null,
            until: null,
          },
        ],
      },
    });
  });

  it("L16: formatCommand of L10 joins the inner sentences with '; ', and each round-trips on its own", () => {
    const l10 = parseCommand(
      "assign Operator A2 and Operator A3 to Housing A on Cell 1 and Cell 2 in Line 1 today from 3 to 5",
    );
    if (!l10.ok || l10.command.intent !== "several") throw new Error("L10 must parse as several");
    const rendered = formatCommand(l10.command);
    const innerSentences = l10.command.commands.map((c) => formatCommand(c));
    expect(rendered).toBe(innerSentences.join("; "));
    for (let i = 0; i < l10.command.commands.length; i++) {
      const inner = l10.command.commands[i];
      expect(parseCommand(innerSentences[i])).toEqual({ ok: true, command: inner });
    }
    // A ';' is not grammar -- parsing the JOINED sentence back need not
    // reproduce the same several (brief §2 item 3); it is not asserted here.
  });

  it("L17: formatCommand round-trips all four place-less shapes (reviewer blocker -- place[0] was read unconditionally and threw)", () => {
    const sentences = [
      "remove Operator A3",
      "unassign Operator A3 from 10:00 to 14:00",
      "move Operator A3 to 8 pm to 11 pm",
      "move A3 to Cell 2",
    ];
    for (const sentence of sentences) {
      const parsed = parseCommand(sentence);
      if (!parsed.ok) throw new Error(`${sentence} must parse`);
      // The crash was `formatCommand` throwing on `command.place[0]` when
      // `place` is `[]` -- calling it at all is the regression test; the
      // round trip on top confirms the fix reads back to the SAME command
      // (never asserting the exact printed string, since e.g.
      // `formatMoveCommand` always prints the hours clause with "from",
      // never "to", whichever word the sentence used -- read from the
      // runner, not reasoned to).
      const rendered = formatCommand(parsed.command);
      expect(parseCommand(rendered)).toEqual(parsed);
    }
  });

  it("L18: a several of place-less removals ('remove A2 and A3 today') round-trips per inner command and joins with '; '", () => {
    const parsed = parseCommand("remove A2 and A3 today");
    if (!parsed.ok || parsed.command.intent !== "several") {
      throw new Error("must parse as several");
    }
    expect(parsed.command.commands).toEqual([
      {
        intent: "unassign",
        operator: "A2",
        place: [],
        day: { kind: "today" },
        span: null,
        shift: null,
        existing: null,
        until: null,
      },
      {
        intent: "unassign",
        operator: "A3",
        place: [],
        day: { kind: "today" },
        span: null,
        shift: null,
        existing: null,
        until: null,
      },
    ]);
    const rendered = formatCommand(parsed.command);
    const innerSentences = parsed.command.commands.map((c) => formatCommand(c));
    expect(rendered).toBe(innerSentences.join("; "));
    for (let i = 0; i < parsed.command.commands.length; i++) {
      expect(parseCommand(innerSentences[i])).toEqual({
        ok: true,
        command: parsed.command.commands[i],
      });
    }
  });

  it("L19: a doubled 'and' ('Sam and and Bob') is bad_list, never a two-item list with a mangled second name (should-fix)", () => {
    expect(parseCommand("assign Sam and and Bob to Housing A on Cell 1 from 3 to 5")).toEqual({
      ok: false,
      failure: { kind: "bad_list", text: "Sam and and Bob" },
    });
  });

  it("L20 (nit): 'move Sam to to Cell 2' -- a doubled preposition strips to the same destination as a single one", () => {
    expect(parseCommand("move Sam to to Cell 2")).toEqual(parseCommand("move Sam to Cell 2"));
    expect(parseCommand("move Sam to to Cell 2")).toEqual({
      ok: true,
      command: {
        intent: "move",
        adjust: null,
        operator: "Sam",
        place: [],
        toPlace: ["Cell 2"],
        day: null,
        span: null,
        shift: null,
        existing: null,
      },
    });
  });
});

/**
 * S55 (docs/agent-briefs/s55-a-grammar-brief.md, R-404-R-409, design
 * §19.101/D130) — the grammar widens for the catalogue's groups 1 and 3:
 * durations and boundaries (R-404), the word-order grammar (R-405), cover/
 * replace and swap (R-406), everyone (R-407), copy (R-408), and absence
 * (R-409). Each id below is the brief's own test-case id, one `it()` per
 * case, the same shape as every describe block above.
 */
describe("commandParse: S55 durations (R-404)", () => {
  const TAIL = "Sam on Housing A on Cell 1";

  it("DU1: put Sam on Housing A on Cell 1 from 8 for 4 hours -- 08:00-12:00", () => {
    expect(parseCommand(`put ${TAIL} from 8 for 4 hours`)).toEqual(
      ok({
        intent: "assign",
        operator: "Sam",
        product: "Housing A",
        place: ["Cell 1"],
        day: null,
        start: { hour: 8, minute: 0 },
        end: { hour: 12, minute: 0 },
        attach: null,
        existing: null,
        shift: null,
      }),
    );
  });

  it("DU2: assign Sam to Housing A on Cell 1 at 8 for an hour -- 08:00-09:00", () => {
    expect(parseCommand(`assign ${TAIL} at 8 for an hour`)).toEqual(
      ok({
        intent: "assign",
        operator: "Sam",
        product: "Housing A",
        place: ["Cell 1"],
        day: null,
        start: { hour: 8, minute: 0 },
        end: { hour: 9, minute: 0 },
        attach: null,
        existing: null,
        shift: null,
      }),
    );
  });

  it("DU3: ... from 8 for 2 and a half hours -- 08:00-10:30", () => {
    expect(parseCommand(`put ${TAIL} from 8 for 2 and a half hours`)).toEqual(
      ok({
        intent: "assign",
        operator: "Sam",
        product: "Housing A",
        place: ["Cell 1"],
        day: null,
        start: { hour: 8, minute: 0 },
        end: { hour: 10, minute: 30 },
        attach: null,
        existing: null,
        shift: null,
      }),
    );
  });

  it("DU4: ... from 8 for 1.5 hours -- 90 minutes: the developer's own reading of the brief's 'same' is 'same as DU5' (both are 1.5 hours = 90 minutes = 09:30), not 'same as DU3' (2.5 hours) -- the arithmetic is unambiguous even where the prose is not", () => {
    expect(parseCommand(`put ${TAIL} from 8 for 1.5 hours`)).toEqual(
      ok({
        intent: "assign",
        operator: "Sam",
        product: "Housing A",
        place: ["Cell 1"],
        day: null,
        start: { hour: 8, minute: 0 },
        end: { hour: 9, minute: 30 },
        attach: null,
        existing: null,
        shift: null,
      }),
    );
  });

  it("DU5: ... from 8 for 90 minutes -- 09:30", () => {
    expect(parseCommand(`put ${TAIL} from 8 for 90 minutes`)).toEqual(
      ok({
        intent: "assign",
        operator: "Sam",
        product: "Housing A",
        place: ["Cell 1"],
        day: null,
        start: { hour: 8, minute: 0 },
        end: { hour: 9, minute: 30 },
        attach: null,
        existing: null,
        shift: null,
      }),
    );
  });

  it("DU6: ... from 8 for half an hour -- 08:30; hrs/hr/mins/min accepted", () => {
    expect(parseCommand(`put ${TAIL} from 8 for half an hour`)).toEqual(
      ok({
        intent: "assign",
        operator: "Sam",
        product: "Housing A",
        place: ["Cell 1"],
        day: null,
        start: { hour: 8, minute: 0 },
        end: { hour: 8, minute: 30 },
        attach: null,
        existing: null,
        shift: null,
      }),
    );
    expect(parseCommand(`put ${TAIL} from 8 for 4 hrs`).ok).toBe(true);
    expect(parseCommand(`put ${TAIL} from 8 for 1 hr`).ok).toBe(true);
    expect(parseCommand(`put ${TAIL} from 8 for 30 mins`).ok).toBe(true);
    expect(parseCommand(`put ${TAIL} from 8 for 30 min`).ok).toBe(true);
  });

  it("DU7: ... from 10 pm for 4 hours -- bad_duration, past midnight, never clipped", () => {
    expect(parseCommand(`put ${TAIL} from 10 pm for 4 hours`)).toEqual({
      ok: false,
      failure: { kind: "bad_duration", text: "4 hours" },
    });
  });

  it("DU8: ... from 8 for 0 hours -- bad_duration", () => {
    expect(parseCommand(`put ${TAIL} from 8 for 0 hours`)).toEqual({
      ok: false,
      failure: { kind: "bad_duration", text: "0 hours" },
    });
  });

  it("DU9: book Housing A on Cell 1 from 8 for 4 hours for 3 people -- two 'for' clauses, the unit word tells them apart", () => {
    expect(parseCommand("book Housing A on Cell 1 from 8 for 4 hours for 3 people")).toEqual(
      bookOk({
        start: { hour: 8, minute: 0 },
        end: { hour: 12, minute: 0 },
        headcount: 3,
      }),
    );
  });

  it("DU10 (the developer's own decision -- see the brief report): assign Sam to Housing A on Cell 1 8 to 4 for 2 hours -- a bare pair AND a duration, neither anchored by from/at, so nothing says which reading is real; reuses bad_time (never a new ParseFailure kind) since the sentence, read as a whole, is a malformed time clause", () => {
    expect(parseCommand("assign Sam to Housing A on Cell 1 8 to 4 for 2 hours")).toEqual({
      ok: false,
      failure: { kind: "bad_time", text: "8 to 4 for 2 hours" },
    });
  });
});

describe("commandParse: F-146 -- a block that can end exactly at midnight", () => {
  const TAIL = "Sam to Housing A on Cell 1";

  it("F146-1: assign Sam to Housing A on Cell 1 from 8 pm to midnight -- end DAY_END, not time_order", () => {
    expect(parseCommand(`assign ${TAIL} from 8 pm to midnight`)).toEqual(
      ok({
        intent: "assign",
        operator: "Sam",
        product: "Housing A",
        place: ["Cell 1"],
        day: null,
        start: { hour: 20, minute: 0 },
        end: DAY_END,
        attach: null,
        existing: null,
        shift: null,
      }),
    );
  });

  it("F146-2: assign Sam ... from 8 pm to 12 am -- end DAY_END too, the explicit-meridiem spelling", () => {
    expect(parseCommand(`assign ${TAIL} from 8 pm to 12 am`)).toEqual(
      ok({
        intent: "assign",
        operator: "Sam",
        product: "Housing A",
        place: ["Cell 1"],
        day: null,
        start: { hour: 20, minute: 0 },
        end: DAY_END,
        attach: null,
        existing: null,
        shift: null,
      }),
    );
  });

  it("F146-3: assign Sam ... from 20:00 to 24:00 -- literal 24:00 is not bad_time, end DAY_END", () => {
    expect(parseCommand(`assign ${TAIL} from 20:00 to 24:00`)).toEqual(
      ok({
        intent: "assign",
        operator: "Sam",
        product: "Housing A",
        place: ["Cell 1"],
        day: null,
        start: { hour: 20, minute: 0 },
        end: DAY_END,
        attach: null,
        existing: null,
        shift: null,
      }),
    );
  });

  it("F146-4: assign Sam ... from 8 pm for 4 hours -- a duration landing exactly on 24:00 writes DAY_END, never bad_duration", () => {
    expect(parseCommand(`assign ${TAIL} from 8 pm for 4 hours`)).toEqual(
      ok({
        intent: "assign",
        operator: "Sam",
        product: "Housing A",
        place: ["Cell 1"],
        day: null,
        start: { hour: 20, minute: 0 },
        end: DAY_END,
        attach: null,
        existing: null,
        shift: null,
      }),
    );
  });

  it("F146-5: from 8 pm for 5 hours -- still bad_duration (runs PAST midnight, not onto it)", () => {
    expect(parseCommand(`assign ${TAIL} from 8 pm for 5 hours`)).toEqual({
      ok: false,
      failure: { kind: "bad_duration", text: "5 hours" },
    });
  });

  it("F146-6: from midnight to 8 -- a START spelled midnight stays the literal 0:00, never DAY_END", () => {
    expect(parseCommand(`assign ${TAIL} from midnight to 8`)).toEqual(
      ok({
        intent: "assign",
        operator: "Sam",
        product: "Housing A",
        place: ["Cell 1"],
        day: null,
        start: { hour: 0, minute: 0 },
        end: { hour: 8, minute: 0 },
        attach: null,
        existing: null,
        shift: null,
      }),
    );
  });

  it("F146-7: formatCommand prints a DAY_END end as 'midnight' ('from 20:00 to midnight'), and the round trip holds", () => {
    const first = parseCommand(`assign ${TAIL} from 8 pm to midnight`);
    if (!first.ok) throw new Error("F146-1 must parse");
    const sentence = formatCommand(first.command);
    expect(sentence).toBe("assign Sam to Housing A on Cell 1 from 20:00 to midnight");
    expect(parseCommand(sentence)).toEqual(first);
  });

  it("F146-8: book Housing A on Cell 1 from 20:00 to midnight -- the booking grammar gets DAY_END too, and round-trips", () => {
    const first = parseCommand("book Housing A on Cell 1 from 20:00 to midnight");
    expect(first).toEqual(bookOk({ start: { hour: 20, minute: 0 }, end: DAY_END }));
    if (!first.ok) throw new Error("must parse");
    expect(parseCommand(formatCommand(first.command))).toEqual(first);
  });

  it("F146-9: unassign Sam from Cell 1 from 20:00 to midnight -- the removal grammar's own PAIRED clause gets DAY_END too (distinct from its lone-edge 'after 2 pm')", () => {
    const first = parseCommand("unassign Sam from Cell 1 from 20:00 to midnight");
    expect(first).toEqual({
      ok: true,
      command: {
        intent: "unassign",
        operator: "Sam",
        place: ["Cell 1"],
        day: null,
        span: { start: { hour: 20, minute: 0 }, end: DAY_END },
        existing: null,
        shift: null,
        until: null,
      },
    });
    if (!first.ok) throw new Error("must parse");
    expect(parseCommand(formatCommand(first.command))).toEqual(first);
  });

  it("F146-10: move Sam on Cell 1 to Cell 2 from 20:00 to midnight -- the move grammar's 'from' clause (extractOptionalTimeClause) gets DAY_END, round-trips", () => {
    const first = parseCommand("move Sam on Cell 1 to Cell 2 from 20:00 to midnight");
    expect(first).toEqual({
      ok: true,
      command: {
        intent: "move",
        adjust: null,
        operator: "Sam",
        place: ["Cell 1"],
        toPlace: ["Cell 2"],
        day: null,
        span: { start: { hour: 20, minute: 0 }, end: DAY_END },
        existing: null,
        shift: null,
      },
    });
    if (!first.ok) throw new Error("must parse");
    expect(parseCommand(formatCommand(first.command))).toEqual(first);
  });

  it("F146-11: move Sam on Cell 1 in Line 1 to 20:00 to midnight -- the move grammar's OTHER time clause (extractToTimeClause, no 'from' at all) gets DAY_END too", () => {
    expect(parseCommand("move Sam on Cell 1 in Line 1 to 20:00 to midnight")).toEqual({
      ok: true,
      command: {
        intent: "move",
        adjust: null,
        operator: "Sam",
        place: ["Cell 1", "Line 1"],
        toPlace: null,
        day: null,
        span: { start: { hour: 20, minute: 0 }, end: DAY_END },
        existing: null,
        shift: null,
      },
    });
  });

  it("F146-12: assign Sam ... 20:00 to midnight -- the bare (word-order) pair grammar's own END slot never matches 'midnight' at all (TIME_TOKEN_INLINE is digit-only) -- unaffected, out of F-146's scope, stays no_time/bad_time the way it always did", () => {
    // Documents the boundary of the fix rather than asserting a specific
    // failure kind, since the sentence still needs a leading verb reading to
    // decide which of several failures applies; the point is only that the
    // bare-pair grammar was never claimed fixed.
    const result = parseCommand("Cell 1 runs Housing A 20:00 to midnight");
    expect(result.ok).toBe(false);
  });
});

describe("commandParse: S55 boundaries -- ALL_DAY/END_OF_SHIFT/END_OF_DAY (R-404, D130 item 3)", () => {
  it("BD1: assign Sam to Housing A on Cell 1 all day tomorrow -- shift ALL_DAY, start/end null, day tomorrow", () => {
    expect(parseCommand("assign Sam to Housing A on Cell 1 all day tomorrow")).toEqual(
      ok({
        intent: "assign",
        operator: "Sam",
        product: "Housing A",
        place: ["Cell 1"],
        day: { kind: "tomorrow" },
        start: null,
        end: null,
        attach: null,
        existing: null,
        shift: ALL_DAY,
      }),
    );
  });

  it("BD2: from 10 until end of shift -- start 10:00, end null, shift END_OF_SHIFT; till/to the end of the shift/until the end of shift/for the rest of the shift all read the same", () => {
    const expected = ok({
      intent: "assign",
      operator: "Sam",
      product: "Housing A",
      place: ["Cell 1"],
      day: null,
      start: { hour: 10, minute: 0 },
      end: null,
      attach: null,
      existing: null,
      shift: END_OF_SHIFT,
    });
    expect(parseCommand("assign Sam to Housing A on Cell 1 from 10 until end of shift")).toEqual(
      expected,
    );
    expect(parseCommand("assign Sam to Housing A on Cell 1 from 10 till end of shift")).toEqual(
      expected,
    );
    expect(
      parseCommand("assign Sam to Housing A on Cell 1 from 10 to the end of the shift"),
    ).toEqual(expected);
    expect(
      parseCommand("assign Sam to Housing A on Cell 1 from 10 until the end of shift"),
    ).toEqual(expected);
    expect(
      parseCommand("assign Sam to Housing A on Cell 1 from 10 for the rest of the shift"),
    ).toEqual(expected);
  });

  it("BD3: put Sam on Housing A on Cell 1 for the rest of the day -- start null, shift END_OF_DAY; until end of day / till the end of the day the same", () => {
    const expected = ok({
      intent: "assign",
      operator: "Sam",
      product: "Housing A",
      place: ["Cell 1"],
      day: null,
      start: null,
      end: null,
      attach: null,
      existing: null,
      shift: END_OF_DAY,
    });
    expect(parseCommand("put Sam on Housing A on Cell 1 for the rest of the day")).toEqual(
      expected,
    );
    expect(parseCommand("put Sam on Housing A on Cell 1 until end of day")).toEqual(expected);
    expect(parseCommand("put Sam on Housing A on Cell 1 till the end of the day")).toEqual(
      expected,
    );
  });

  it("BD4: ... from 10 for the rest of the day -- start 10:00", () => {
    expect(parseCommand("put Sam on Housing A on Cell 1 from 10 for the rest of the day")).toEqual(
      ok({
        intent: "assign",
        operator: "Sam",
        product: "Housing A",
        place: ["Cell 1"],
        day: null,
        start: { hour: 10, minute: 0 },
        end: null,
        attach: null,
        existing: null,
        shift: END_OF_DAY,
      }),
    );
  });

  it("BD5: remove Sam from Cell 1 for the rest of the day -- unassign shift END_OF_DAY, span null", () => {
    expect(parseCommand("remove Sam from Cell 1 for the rest of the day")).toEqual({
      ok: true,
      command: {
        intent: "unassign",
        operator: "Sam",
        place: ["Cell 1"],
        day: null,
        span: null,
        existing: null,
        shift: END_OF_DAY,
        until: null,
      },
    });
  });

  it("BD6: remove Sam from Cell 1 all day -- shift null, span null (ALL_DAY on a removal reads as nothing, and is dropped)", () => {
    expect(parseCommand("remove Sam from Cell 1 all day")).toEqual({
      ok: true,
      command: {
        intent: "unassign",
        operator: "Sam",
        place: ["Cell 1"],
        day: null,
        span: null,
        existing: null,
        shift: null,
        until: null,
      },
    });
  });

  it("BD7: assign Sam to Housing A on Cell 1 all day from 8 to 4 -- shift_and_hours", () => {
    expect(parseCommand("assign Sam to Housing A on Cell 1 all day from 8 to 4")).toEqual({
      ok: false,
      failure: { kind: "shift_and_hours" },
    });
  });

  it("BD8: formatCommand round-trips BD1-BD3 (exact printed text pinned to the real output, not reasoned about)", () => {
    const bd1 = parseCommand("assign Sam to Housing A on Cell 1 all day tomorrow");
    if (!bd1.ok) throw new Error("BD1 must parse");
    expect(parseCommand(formatCommand(bd1.command))).toEqual(bd1);

    const bd2 = parseCommand("assign Sam to Housing A on Cell 1 from 10 until end of shift");
    if (!bd2.ok) throw new Error("BD2 must parse");
    expect(formatCommand(bd2.command)).toContain("from 10:00 until end of shift");
    expect(parseCommand(formatCommand(bd2.command))).toEqual(bd2);

    const bd3 = parseCommand("put Sam on Housing A on Cell 1 for the rest of the day");
    if (!bd3.ok) throw new Error("BD3 must parse");
    expect(formatCommand(bd3.command)).toContain("for the rest of the day");
    expect(parseCommand(formatCommand(bd3.command))).toEqual(bd3);
  });
});

describe("commandParse: S55 word order (R-405)", () => {
  it("WO1: Sam works on Housing A on Cell 1 8 to 4 -- assign", () => {
    expect(parseCommand("Sam works on Housing A on Cell 1 8 to 4")).toEqual(
      ok({
        intent: "assign",
        operator: "Sam",
        product: "Housing A",
        place: ["Cell 1"],
        day: null,
        start: { hour: 8, minute: 0 },
        end: { hour: 16, minute: 0 },
        attach: null,
        existing: null,
        shift: null,
      }),
    );
  });

  it("WO2: Sam is on Housing A on Cell 1 from 8 to 4 -- assign", () => {
    expect(parseCommand("Sam is on Housing A on Cell 1 from 8 to 4")).toEqual(
      ok({
        intent: "assign",
        operator: "Sam",
        product: "Housing A",
        place: ["Cell 1"],
        day: null,
        start: { hour: 8, minute: 0 },
        end: { hour: 16, minute: 0 },
        attach: null,
        existing: null,
        shift: null,
      }),
    );
  });

  it("WO3: Cell 1 gets Sam on Housing A 8 to 4 -- assign, place ['Cell 1']", () => {
    expect(parseCommand("Cell 1 gets Sam on Housing A 8 to 4")).toEqual(
      ok({
        intent: "assign",
        operator: "Sam",
        product: "Housing A",
        place: ["Cell 1"],
        day: null,
        start: { hour: 8, minute: 0 },
        end: { hour: 16, minute: 0 },
        attach: null,
        existing: null,
        shift: null,
      }),
    );
  });

  it("WO4: Cell 1 in Line 1 gets Sam on Housing A 8 to 4 -- place ['Cell 1','Line 1']", () => {
    expect(parseCommand("Cell 1 in Line 1 gets Sam on Housing A 8 to 4")).toEqual(
      ok({
        intent: "assign",
        operator: "Sam",
        product: "Housing A",
        place: ["Cell 1", "Line 1"],
        day: null,
        start: { hour: 8, minute: 0 },
        end: { hour: 16, minute: 0 },
        attach: null,
        existing: null,
        shift: null,
      }),
    );
  });

  it("WO5: Cell 1 runs Housing A 8 to 4 -- book, headcount null", () => {
    expect(parseCommand("Cell 1 runs Housing A 8 to 4")).toEqual(
      bookOk({
        place: ["Cell 1"],
        start: { hour: 8, minute: 0 },
        end: { hour: 16, minute: 0 },
      }),
    );
  });

  it("WO6: Cell 1 runs Housing A 8 to 4 with 3 people -- headcount 3 ('with N people' joins 'for N people' as a headcount clause, for every book form)", () => {
    expect(parseCommand("Cell 1 runs Housing A 8 to 4 with 3 people")).toEqual(
      bookOk({
        place: ["Cell 1"],
        start: { hour: 8, minute: 0 },
        end: { hour: 16, minute: 0 },
        headcount: 3,
      }),
    );
    expect(parseCommand("book Housing A on Cell 1 with 3 people from 6 to 2")).toEqual(
      bookOk({ headcount: 3 }),
    );
  });

  it('WO7: quoted names still atomic: "Sam is on" works on Housing A on Cell 1 8 to 4 -- operator "Sam is on"', () => {
    expect(parseCommand('"Sam is on" works on Housing A on Cell 1 8 to 4')).toEqual(
      ok({
        intent: "assign",
        operator: "Sam is on",
        product: "Housing A",
        place: ["Cell 1"],
        day: null,
        start: { hour: 8, minute: 0 },
        end: { hour: 16, minute: 0 },
        attach: null,
        existing: null,
        shift: null,
      }),
    );
  });
});

describe("commandParse: S55 removals -- take, lone edges (R-404/R-405)", () => {
  it("RM1: take Sam off Cell 1 -- unassign, place ['Cell 1'], span null", () => {
    expect(parseCommand("take Sam off Cell 1")).toEqual({
      ok: true,
      command: {
        intent: "unassign",
        operator: "Sam",
        place: ["Cell 1"],
        day: null,
        span: null,
        existing: null,
        shift: null,
        until: null,
      },
    });
  });

  it("RM2: take Sam off Cell 1 today from 2 to 4 -- 02:00-04:00 (the afternoon rule never fires here: 4 is already after 2, exactly like P9/L4's own precedent)", () => {
    expect(parseCommand("take Sam off Cell 1 today from 2 to 4")).toEqual({
      ok: true,
      command: {
        intent: "unassign",
        operator: "Sam",
        place: ["Cell 1"],
        day: { kind: "today" },
        span: { start: { hour: 2, minute: 0 }, end: { hour: 4, minute: 0 } },
        existing: null,
        shift: null,
        until: null,
      },
    });
  });

  it("RM3: pull Sam from Cell 1", () => {
    expect(parseCommand("pull Sam from Cell 1")).toEqual({
      ok: true,
      command: {
        intent: "unassign",
        operator: "Sam",
        place: ["Cell 1"],
        day: null,
        span: null,
        existing: null,
        shift: null,
        until: null,
      },
    });
  });

  it("RM4: pull Sam off Cell 1 in Line 1", () => {
    expect(parseCommand("pull Sam off Cell 1 in Line 1")).toEqual({
      ok: true,
      command: {
        intent: "unassign",
        operator: "Sam",
        place: ["Cell 1", "Line 1"],
        day: null,
        span: null,
        existing: null,
        shift: null,
        until: null,
      },
    });
  });

  it("RM5: remove Sam from Cell 1 after 2 pm -- span 14:00-DAY_END", () => {
    expect(parseCommand("remove Sam from Cell 1 after 2 pm")).toEqual({
      ok: true,
      command: {
        intent: "unassign",
        operator: "Sam",
        place: ["Cell 1"],
        day: null,
        span: { start: { hour: 14, minute: 0 }, end: DAY_END },
        existing: null,
        shift: null,
        until: null,
      },
    });
  });

  it("RM6 (the developer's own decision -- see the brief report): remove Sam from Cell 1 before 2 -- 00:00-14:00, the 'workday' rule: a lone edge under 7 with no am/pm reads as PM, the same instinct the paired afternoon rule already encodes", () => {
    expect(parseCommand("remove Sam from Cell 1 before 2")).toEqual({
      ok: true,
      command: {
        intent: "unassign",
        operator: "Sam",
        place: ["Cell 1"],
        day: null,
        span: { start: { hour: 0, minute: 0 }, end: { hour: 14, minute: 0 } },
        existing: null,
        shift: null,
        until: null,
      },
    });
  });

  it("RM7: unassign Sam from Cell 1 until 2 -- 00:00-14:00", () => {
    expect(parseCommand("unassign Sam from Cell 1 until 2")).toEqual({
      ok: true,
      command: {
        intent: "unassign",
        operator: "Sam",
        place: ["Cell 1"],
        day: null,
        span: { start: { hour: 0, minute: 0 }, end: { hour: 14, minute: 0 } },
        existing: null,
        shift: null,
        until: null,
      },
    });
  });

  it("RM8: assign Sam to Housing A on Cell 1 after 2 -- open_span (assign/book need both ends said)", () => {
    expect(parseCommand("assign Sam to Housing A on Cell 1 after 2")).toEqual({
      ok: false,
      failure: { kind: "open_span", text: "after 2" },
    });
  });

  it("RM9: formatCommand prints RM5 as '... after 14:00' and RM6 as '... before 14:00', both round-trip", () => {
    const rm5 = parseCommand("remove Sam from Cell 1 after 2 pm");
    if (!rm5.ok) throw new Error("RM5 must parse");
    expect(formatCommand(rm5.command)).toBe("unassign Sam from Cell 1 after 14:00");
    expect(parseCommand(formatCommand(rm5.command))).toEqual(rm5);

    const rm6 = parseCommand("remove Sam from Cell 1 before 2");
    if (!rm6.ok) throw new Error("RM6 must parse");
    expect(formatCommand(rm6.command)).toBe("unassign Sam from Cell 1 before 14:00");
    expect(parseCommand(formatCommand(rm6.command))).toEqual(rm6);
  });

  it("R-405 comment case (UNASSIGN_VERBS doc comment): 'take Sam to Cell 2' reads as a removal, not a move -- 'to' is not one of the removal grammar's own place prepositions (from/off/on/at), so the whole remainder reads as the operator; the price of R-391's one-list-per-verb rule", () => {
    expect(parseCommand("take Sam to Cell 2")).toEqual({
      ok: true,
      command: {
        intent: "unassign",
        operator: "Sam to Cell 2",
        place: [],
        day: null,
        span: null,
        existing: null,
        shift: null,
        until: null,
      },
    });
  });
});

describe("commandParse: S55 time-of-day words (R-405, D130 item 7)", () => {
  it("TD1: assign Sam to Housing A on Cell 1 this afternoon -- shift 'afternoon', day today", () => {
    expect(parseCommand("assign Sam to Housing A on Cell 1 this afternoon")).toEqual(
      ok({
        intent: "assign",
        operator: "Sam",
        product: "Housing A",
        place: ["Cell 1"],
        day: { kind: "today" },
        start: null,
        end: null,
        attach: null,
        existing: null,
        shift: "afternoon",
      }),
    );
  });

  it("TD2: ... tonight -- 'night', today", () => {
    expect(parseCommand("assign Sam to Housing A on Cell 1 tonight")).toEqual(
      ok({
        intent: "assign",
        operator: "Sam",
        product: "Housing A",
        place: ["Cell 1"],
        day: { kind: "today" },
        start: null,
        end: null,
        attach: null,
        existing: null,
        shift: "night",
      }),
    );
  });

  it("TD3: assign Sam to Housing A on Cell 1 tomorrow morning -- 'morning', tomorrow", () => {
    expect(parseCommand("assign Sam to Housing A on Cell 1 tomorrow morning")).toEqual(
      ok({
        intent: "assign",
        operator: "Sam",
        product: "Housing A",
        place: ["Cell 1"],
        day: { kind: "tomorrow" },
        start: null,
        end: null,
        attach: null,
        existing: null,
        shift: "morning",
      }),
    );
  });

  it("TD4: put Sam on Housing A on Cell 1 for the night -- 'night', day null", () => {
    expect(parseCommand("put Sam on Housing A on Cell 1 for the night")).toEqual(
      ok({
        intent: "assign",
        operator: "Sam",
        product: "Housing A",
        place: ["Cell 1"],
        day: null,
        start: null,
        end: null,
        attach: null,
        existing: null,
        shift: "night",
      }),
    );
  });

  it("TD5: pull Sam off Cell 1 this afternoon -- unassign shift 'afternoon', day today", () => {
    expect(parseCommand("pull Sam off Cell 1 this afternoon")).toEqual({
      ok: true,
      command: {
        intent: "unassign",
        operator: "Sam",
        place: ["Cell 1"],
        day: { kind: "today" },
        span: null,
        existing: null,
        shift: "afternoon",
        until: null,
      },
    });
  });

  it("TD6: ... this afternoon from 2 to 4 -- shift_and_hours", () => {
    expect(parseCommand("pull Sam off Cell 1 this afternoon from 2 to 4")).toEqual({
      ok: false,
      failure: { kind: "shift_and_hours" },
    });
  });

  it("TD7: ... this afternoon tomorrow -- two_days, never a guess", () => {
    expect(parseCommand("assign Sam to Housing A on Cell 1 this afternoon tomorrow")).toEqual({
      ok: false,
      failure: { kind: "two_days", first: "this afternoon", second: "tomorrow" },
    });
  });
});

describe("commandParse: S55 everyone (R-407)", () => {
  it("EV1: clear Cell 1 today -- unassign, EVERYONE, place ['Cell 1'], day today, span null, until null", () => {
    expect(parseCommand("clear Cell 1 today")).toEqual({
      ok: true,
      command: {
        intent: "unassign",
        operator: EVERYONE,
        place: ["Cell 1"],
        day: { kind: "today" },
        span: null,
        existing: null,
        shift: null,
        until: null,
      },
    });
  });

  it("EV2: clear Cell 1 in Line 1 after 2 pm -- place ['Cell 1','Line 1'], span 14:00-DAY_END", () => {
    expect(parseCommand("clear Cell 1 in Line 1 after 2 pm")).toEqual({
      ok: true,
      command: {
        intent: "unassign",
        operator: EVERYONE,
        place: ["Cell 1", "Line 1"],
        day: null,
        span: { start: { hour: 14, minute: 0 }, end: DAY_END },
        existing: null,
        shift: null,
        until: null,
      },
    });
  });

  it("EV3: clear Sam from Cell 1 -- operator 'Sam' (a from/off keeps the person reading)", () => {
    expect(parseCommand("clear Sam from Cell 1")).toEqual({
      ok: true,
      command: {
        intent: "unassign",
        operator: "Sam",
        place: ["Cell 1"],
        day: null,
        span: null,
        existing: null,
        shift: null,
        until: null,
      },
    });
  });

  it("EV4/EV5/EV6: unassign everyone / remove everybody / remove all -- all three canonicalize to EVERYONE, whatever was said", () => {
    expect(parseCommand("unassign everyone from Cell 3 after 2 pm")).toEqual({
      ok: true,
      command: {
        intent: "unassign",
        operator: EVERYONE,
        place: ["Cell 3"],
        day: null,
        span: { start: { hour: 14, minute: 0 }, end: DAY_END },
        existing: null,
        shift: null,
        until: null,
      },
    });
    expect(parseCommand("remove everybody from Line 1 tomorrow")).toEqual({
      ok: true,
      command: {
        intent: "unassign",
        operator: EVERYONE,
        place: ["Line 1"],
        day: { kind: "tomorrow" },
        span: null,
        existing: null,
        shift: null,
        until: null,
      },
    });
    expect(parseCommand("remove all from Cell 1")).toEqual({
      ok: true,
      command: {
        intent: "unassign",
        operator: EVERYONE,
        place: ["Cell 1"],
        day: null,
        span: null,
        existing: null,
        shift: null,
        until: null,
      },
    });
  });

  it("EV7: move everyone on Line 1 to Cell 2 -- move, EVERYONE, place ['Line 1'], toPlace ['Cell 2']", () => {
    expect(parseCommand("move everyone on Line 1 to Cell 2")).toEqual({
      ok: true,
      command: {
        intent: "move",
        adjust: null,
        operator: EVERYONE,
        place: ["Line 1"],
        toPlace: ["Cell 2"],
        day: null,
        span: null,
        existing: null,
        shift: null,
      },
    });
  });

  it("EV8: move everyone from Cell 1 to Cell 2 today", () => {
    expect(parseCommand("move everyone from Cell 1 to Cell 2 today")).toEqual({
      ok: true,
      command: {
        intent: "move",
        adjust: null,
        operator: EVERYONE,
        place: ["Cell 1"],
        toPlace: ["Cell 2"],
        day: { kind: "today" },
        span: null,
        existing: null,
        shift: null,
      },
    });
  });

  it("EV9: clear everyone -- unassign, EVERYONE, place [] (allowed -- the resolver reads it as every cell shown)", () => {
    expect(parseCommand("clear everyone")).toEqual({
      ok: true,
      command: {
        intent: "unassign",
        operator: EVERYONE,
        place: [],
        day: null,
        span: null,
        existing: null,
        shift: null,
        until: null,
      },
    });
  });

  it("EV10: assign everyone to Housing A on Cell 1 8 to 4 -- operator 'everyone' as a PERSON'S words, unchanged; the reserved reading is a removal's or a move's only", () => {
    expect(parseCommand("assign everyone to Housing A on Cell 1 8 to 4")).toEqual(
      ok({
        intent: "assign",
        operator: "everyone",
        product: "Housing A",
        place: ["Cell 1"],
        day: null,
        start: { hour: 8, minute: 0 },
        end: { hour: 16, minute: 0 },
        attach: null,
        existing: null,
        shift: null,
      }),
    );
  });
});

describe("commandParse: S55 cover, replace, swap (R-406)", () => {
  function replaceOk(overrides: Partial<ReplaceCommand> = {}): {
    ok: true;
    command: ReplaceCommand;
  } {
    return {
      ok: true,
      command: {
        intent: "replace",
        operator: "Sam",
        with: "Ana",
        place: [],
        day: null,
        span: null,
        shift: null,
        ...overrides,
      },
    };
  }
  function swapOk(overrides: Partial<SwapCommand> = {}): { ok: true; command: SwapCommand } {
    return {
      ok: true,
      command: {
        intent: "swap",
        operator: "Sam",
        other: "Ana",
        place: [],
        day: null,
        span: null,
        shift: null,
        ...overrides,
      },
    };
  }

  it("RP1: cover Sam with Ana on Cell 1 today", () => {
    expect(parseCommand("cover Sam with Ana on Cell 1 today")).toEqual(
      replaceOk({ place: ["Cell 1"], day: { kind: "today" } }),
    );
  });

  it("RP2: replace Sam with Ana -- place []", () => {
    expect(parseCommand("replace Sam with Ana")).toEqual(replaceOk());
  });

  it("RP3: cover Sam with Ana from 2 to 4 -- span (the same afternoon-rule mechanics as every other time clause in this file: 4 is already after 2, so no +12h)", () => {
    expect(parseCommand("cover Sam with Ana from 2 to 4")).toEqual(
      replaceOk({ span: { start: { hour: 2, minute: 0 }, end: { hour: 4, minute: 0 } } }),
    );
  });

  it('RP4: replace Sam with Ana for shift 2 on Cell 1 -- shift "2"', () => {
    expect(parseCommand("replace Sam with Ana for shift 2 on Cell 1")).toEqual(
      replaceOk({ place: ["Cell 1"], shift: "2" }),
    );
  });

  it("RP5: cover Sam with Ana from 2 to 4 for shift 2 -- shift_and_hours", () => {
    expect(parseCommand("cover Sam with Ana from 2 to 4 for shift 2")).toEqual({
      ok: false,
      failure: { kind: "shift_and_hours" },
    });
  });

  it("RP6 (the developer's own decision -- see the brief report): cover Sam -- no_product (operator given, nothing after it that names a replacement)", () => {
    expect(parseCommand("cover Sam")).toEqual({ ok: false, failure: { kind: "no_product" } });
  });

  it("SW1: swap Sam and Ana", () => {
    expect(parseCommand("swap Sam and Ana")).toEqual(swapOk());
  });

  it("SW2: swap Sam with Ana on Cell 1 tomorrow", () => {
    expect(parseCommand("swap Sam with Ana on Cell 1 tomorrow")).toEqual(
      swapOk({ place: ["Cell 1"], day: { kind: "tomorrow" } }),
    );
  });

  it("SW3: exchange Sam and Ana", () => {
    expect(parseCommand("exchange Sam and Ana")).toEqual(swapOk());
  });

  it("SW4 (the developer's own decision -- see the brief report): swap Sam -- no_product, the same choice as RP6", () => {
    expect(parseCommand("swap Sam")).toEqual({ ok: false, failure: { kind: "no_product" } });
  });

  it("RP7/SW5: formatCommand prints the canonical cover/swap sentences and round-trips", () => {
    const rp1 = parseCommand("cover Sam with Ana on Cell 1 today");
    if (!rp1.ok) throw new Error("RP1 must parse");
    expect(formatCommand(rp1.command)).toBe("cover Sam with Ana on Cell 1 today");
    expect(parseCommand(formatCommand(rp1.command))).toEqual(rp1);

    const sw2 = parseCommand("swap Sam with Ana on Cell 1 tomorrow");
    if (!sw2.ok) throw new Error("SW2 must parse");
    expect(formatCommand(sw2.command)).toBe("swap Sam and Ana on Cell 1 tomorrow");
    expect(parseCommand(formatCommand(sw2.command))).toEqual(sw2);
  });
});

describe("commandParse: S55 copy (R-408)", () => {
  function copyOk(overrides: Partial<CopyCommand> & Pick<CopyCommand, "from" | "to">): {
    ok: true;
    command: CopyCommand;
  } {
    return { ok: true, command: { intent: "copy", place: [], ...overrides } };
  }

  it("CP1: same as yesterday for Cell 1 -- copy {['Cell 1'], yesterday, today}", () => {
    expect(parseCommand("same as yesterday for Cell 1")).toEqual(
      copyOk({ place: ["Cell 1"], from: { kind: "yesterday" }, to: { kind: "today" } }),
    );
  });

  it("CP2: same as yesterday -- place []", () => {
    expect(parseCommand("same as yesterday")).toEqual(
      copyOk({ from: { kind: "yesterday" }, to: { kind: "today" } }),
    );
  });

  it("CP3: copy Monday to Tuesday -- weekday 1 -> weekday 2, place []", () => {
    expect(parseCommand("copy Monday to Tuesday")).toEqual(
      copyOk({ from: { kind: "weekday", day: 1 }, to: { kind: "weekday", day: 2 } }),
    );
  });

  it("CP4: copy Monday to Tuesday for Cell 1 in Line 1", () => {
    expect(parseCommand("copy Monday to Tuesday for Cell 1 in Line 1")).toEqual(
      copyOk({
        place: ["Cell 1", "Line 1"],
        from: { kind: "weekday", day: 1 },
        to: { kind: "weekday", day: 2 },
      }),
    );
  });

  it("CP5: repeat this week next week -- this_week -> next_week, no 'to' needed", () => {
    expect(parseCommand("repeat this week next week")).toEqual(
      copyOk({ from: { kind: "this_week" }, to: { kind: "next_week" } }),
    );
  });

  it("CP6: copy this week to next week", () => {
    expect(parseCommand("copy this week to next week")).toEqual(
      copyOk({ from: { kind: "this_week" }, to: { kind: "next_week" } }),
    );
  });

  it("CP7: same as last week for Line 1 -- last_week -> this_week", () => {
    expect(parseCommand("same as last week for Line 1")).toEqual(
      copyOk({ place: ["Line 1"], from: { kind: "last_week" }, to: { kind: "this_week" } }),
    );
  });

  it("CP8: copy Monday to next week -- copy_mismatch, a day onto a week", () => {
    expect(parseCommand("copy Monday to next week")).toEqual({
      ok: false,
      failure: { kind: "copy_mismatch", from: "Monday", to: "next week" },
    });
  });

  it("CP9: copy Monday to Monday -- copy_same", () => {
    expect(parseCommand("copy Monday to Monday")).toEqual({
      ok: false,
      failure: { kind: "copy_same" },
    });
  });

  it("CP10: copy 2026-09-07 to 2026-09-14 on Cell 1 -- dates, place preposition 'on' as well as 'for'", () => {
    expect(parseCommand("copy 2026-09-07 to 2026-09-14 on Cell 1")).toEqual(
      copyOk({
        place: ["Cell 1"],
        from: { kind: "date", iso: "2026-09-07" },
        to: { kind: "date", iso: "2026-09-14" },
      }),
    );
  });

  it("CP11: formatCommand prints CP1 as 'copy yesterday to today for Cell 1', CP5 as 'copy this week to next week'; round trip", () => {
    const cp1 = parseCommand("same as yesterday for Cell 1");
    if (!cp1.ok) throw new Error("CP1 must parse");
    expect(formatCommand(cp1.command)).toBe("copy yesterday to today for Cell 1");
    expect(parseCommand(formatCommand(cp1.command))).toEqual(cp1);

    const cp5 = parseCommand("repeat this week next week");
    if (!cp5.ok) throw new Error("CP5 must parse");
    expect(formatCommand(cp5.command)).toBe("copy this week to next week");
    expect(parseCommand(formatCommand(cp5.command))).toEqual(cp5);
  });
});

describe("commandParse: S55 absence (R-409)", () => {
  it("AB1: Sam is off today", () => {
    expect(parseCommand("Sam is off today")).toEqual({
      ok: true,
      command: {
        intent: "unassign",
        operator: "Sam",
        place: [],
        day: { kind: "today" },
        span: null,
        existing: null,
        shift: null,
        until: null,
      },
    });
  });

  it("AB2: Sam is out -- day today (explicit default: an absence with no day means today)", () => {
    expect(parseCommand("Sam is out")).toEqual({
      ok: true,
      command: {
        intent: "unassign",
        operator: "Sam",
        place: [],
        day: { kind: "today" },
        span: null,
        existing: null,
        shift: null,
        until: null,
      },
    });
  });

  it("AB3: Sam is sick tomorrow", () => {
    expect(parseCommand("Sam is sick tomorrow")).toEqual({
      ok: true,
      command: {
        intent: "unassign",
        operator: "Sam",
        place: [],
        day: { kind: "tomorrow" },
        span: null,
        existing: null,
        shift: null,
        until: null,
      },
    });
  });

  it("AB4: Ana is on leave till Friday -- day today, until weekday 5", () => {
    expect(parseCommand("Ana is on leave till Friday")).toEqual({
      ok: true,
      command: {
        intent: "unassign",
        operator: "Ana",
        place: [],
        day: { kind: "today" },
        span: null,
        existing: null,
        shift: null,
        until: { kind: "weekday", day: 5 },
      },
    });
  });

  it("AB5: Ana is away until Friday", () => {
    expect(parseCommand("Ana is away until Friday")).toEqual({
      ok: true,
      command: {
        intent: "unassign",
        operator: "Ana",
        place: [],
        day: { kind: "today" },
        span: null,
        existing: null,
        shift: null,
        until: { kind: "weekday", day: 5 },
      },
    });
  });

  it("AB6: Ana is off from Monday until Wednesday -- day Monday, until Wednesday", () => {
    expect(parseCommand("Ana is off from Monday until Wednesday")).toEqual({
      ok: true,
      command: {
        intent: "unassign",
        operator: "Ana",
        place: [],
        day: { kind: "weekday", day: 1 },
        span: null,
        existing: null,
        shift: null,
        until: { kind: "weekday", day: 3 },
      },
    });
  });

  it("AB7: Sam is on holiday -- day today", () => {
    expect(parseCommand("Sam is on holiday")).toEqual({
      ok: true,
      command: {
        intent: "unassign",
        operator: "Sam",
        place: [],
        day: { kind: "today" },
        span: null,
        existing: null,
        shift: null,
        until: null,
      },
    });
  });

  it("AB8: Ana is off until 2026-09-18 -- until date", () => {
    expect(parseCommand("Ana is off until 2026-09-18")).toEqual({
      ok: true,
      command: {
        intent: "unassign",
        operator: "Ana",
        place: [],
        day: { kind: "today" },
        span: null,
        existing: null,
        shift: null,
        until: { kind: "date", iso: "2026-09-18" },
      },
    });
  });

  it("AB9: formatCommand reads back AB4's own until-clause (real output differs from the brief's illustrative prose -- see the comment on formatUnassignCommand, R-409)", () => {
    const ab4 = parseCommand("Ana is on leave till Friday");
    if (!ab4.ok) throw new Error("AB4 must parse");
    expect(parseCommand(formatCommand(ab4.command))).toEqual(ab4);
  });

  it("AB10: Sam is on Housing A on Cell 1 8 to 4 -- stays WO2's assign reading (the absence pattern needs an ABSENCE_WORD right after 'is')", () => {
    expect(parseCommand("Sam is on Housing A on Cell 1 8 to 4")).toEqual(
      ok({
        intent: "assign",
        operator: "Sam",
        product: "Housing A",
        place: ["Cell 1"],
        day: null,
        start: { hour: 8, minute: 0 },
        end: { hour: 16, minute: 0 },
        attach: null,
        existing: null,
        shift: null,
      }),
    );
  });
});

describe("commandParse: S55 exported constants", () => {
  it("UNASSIGN_VERBS gains 'take' (R-405); every verb list stays pairwise disjoint", () => {
    expect(UNASSIGN_VERBS).toContain("take");
    const lists: readonly (readonly string[])[] = [
      ASSIGN_VERBS,
      BOOK_VERBS,
      UNASSIGN_VERBS,
      MOVE_VERBS,
      REPLACE_VERBS,
      SWAP_VERBS,
      COPY_VERBS,
    ];
    const all = lists.flatMap((list) => list);
    expect(new Set(all).size).toBe(all.length);
  });

  it("BOUNDARY_SHIFTS/ABSENCE_WORDS/TIME_OF_DAY_WORDS are exported with the brief's own spellings (re-pinned, S58: BOUNDARY_SHIFTS gains JOB_HOURS, R-414)", () => {
    expect(BOUNDARY_SHIFTS).toEqual([ALL_DAY, END_OF_SHIFT, END_OF_DAY, JOB_HOURS]);
    expect(ABSENCE_WORDS).toContain("on leave");
    expect(TIME_OF_DAY_WORDS).toEqual(["morning", "afternoon", "evening", "night"]);
  });
});

describe("commandParse: S55 reviewer fixes (lane A review, four regressions found and fixed here)", () => {
  it("REV1: a QUOTED person named 'Everyone' stays that literal name on a removal, never the reserved EVERYONE word -- canonicalizeEveryone used to run AFTER restoreQuotes, so a quoted alias collapsed into the reserved reading same as an unquoted one", () => {
    expect(parseCommand('remove "Everyone" from Cell 1')).toEqual(
      ok({
        intent: "unassign",
        operator: "Everyone",
        place: ["Cell 1"],
        day: null,
        span: null,
        existing: null,
        shift: null,
        until: null,
      } satisfies UnassignCommand),
    );
  });

  it("REV2: the same fix on 'clear', where the operator/place split is implicit", () => {
    const r = parseCommand('clear "Everyone" from Cell 1');
    expect(r.ok).toBe(true);
    if (r.ok && r.command.intent === "unassign") expect(r.command.operator).toBe("Everyone");
  });

  it("REV3: the same fix on move -- a quoted 'Everyone' operator is a person, not R-407's reserved word", () => {
    expect(parseCommand('move "Everyone" on Line 1 to Cell 2')).toEqual(
      ok({
        intent: "move",
        adjust: null,
        operator: "Everyone",
        place: ["Line 1"],
        toPlace: ["Cell 2"],
        day: null,
        span: null,
        existing: null,
        shift: null,
      } satisfies MoveCommand),
    );
  });

  it("REV4: formatCommand round-trips a quoted operator containing an absence-grammar trigger word ('Sam is off') -- ABSENCE_RE runs unanchored on the WHOLE sentence before any verb dispatch, so printing this name unquoted used to read back as an absence command failing bad_day", () => {
    const parsed = parseCommand('assign "Sam is off" to Housing A on Cell 1 8 to 4');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("must parse");
    const printed = formatCommand(parsed.command);
    expect(printed).toBe('assign "Sam is off" to Housing A on Cell 1 from 08:00 to 16:00');
    expect(parseCommand(printed)).toEqual(parsed);
  });

  it("REV5: the same fix on replace's operator ('cover \"Sam is off\" with Ana ...')", () => {
    const parsed = parseCommand('cover "Sam is off" with Ana on Cell 1 today');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("must parse");
    expect(parseCommand(formatCommand(parsed.command))).toEqual(parsed);
  });

  it("REV6: formatCommand round-trips a quoted place named 'All Day' on an assign -- ALL_DAY_RE is an unanchored 'all day' search over the whole sentence, so printing this place unquoted used to be misread as the ALL_DAY boundary shift and collide with the real hours (shift_and_hours)", () => {
    const parsed = parseCommand('assign Sam to Housing A on "All Day" 8 to 4');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("must parse");
    const printed = formatCommand(parsed.command);
    expect(printed).toBe('assign Sam to Housing A on "All Day" from 08:00 to 16:00');
    expect(parseCommand(printed)).toEqual(parsed);
  });

  it("REV7: the same fix on a removal's place -- 'remove Sam from \"All Day\"' used to lose the place entirely on round trip (ALL_DAY read and dropped, per R-404's own amendment)", () => {
    const parsed = parseCommand('remove Sam from "All Day"');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("must parse");
    const printed = formatCommand(parsed.command);
    expect(printed).toBe('unassign Sam from "All Day"');
    expect(parseCommand(printed)).toEqual(parsed);
  });

  it("REV8: 'remove Sam from Cell 1 from Monday to Tuesday' is bad_time, not a silent garbage place -- extractOptionalTimeClause's own lenient fallback (added for RM7/EV8: revert to 'no time clause' when a found from-X-to-Y pair's START is not a time) used to leave the whole clause sitting unconsumed, so this read as place 'Cell 1 from Monday to', day Tuesday, with no error at all", () => {
    expect(parseCommand("remove Sam from Cell 1 from Monday to Tuesday")).toEqual({
      ok: false,
      failure: { kind: "bad_time", text: "Cell 1 from Monday to" },
    });
  });

  it("REV9: the same shape with two non-day, non-time words ('from lunch to dinner') is bad_time too -- not just a day-shaped false positive", () => {
    expect(parseCommand("remove Sam from Cell 1 from lunch to dinner")).toEqual({
      ok: false,
      failure: { kind: "bad_time", text: "Cell 1 from lunch to dinner" },
    });
  });

  it("REV10: the same leftover-clause guard on replace ('cover Sam with Ana from Monday to Tuesday')", () => {
    expect(parseCommand("cover Sam with Ana from Monday to Tuesday")).toEqual({
      ok: false,
      failure: { kind: "bad_time", text: "Ana from Monday to" },
    });
  });

  it("REV11: the same leftover-clause guard on swap ('swap Sam and Ana from Monday to Tuesday')", () => {
    expect(parseCommand("swap Sam and Ana from Monday to Tuesday")).toEqual({
      ok: false,
      failure: { kind: "bad_time", text: "Ana from Monday to" },
    });
  });

  it("REV12: RM7/EV8's own fix still holds after the above -- a lone 'until <time>' still reads as the lone-edge span, not bad_time (extractOptionalTimeClause's fallback is still needed and still fires for the case it was written for)", () => {
    expect(parseCommand("unassign Sam from Cell 1 until 2")).toEqual(
      ok({
        intent: "unassign",
        operator: "Sam",
        place: ["Cell 1"],
        day: null,
        span: { start: { hour: 0, minute: 0 }, end: { hour: 14, minute: 0 } },
        existing: null,
        shift: null,
        until: null,
      } satisfies UnassignCommand),
    );
    expect(parseCommand("move everyone from Cell 1 to Cell 2 today")).toEqual(
      ok({
        intent: "move",
        adjust: null,
        operator: EVERYONE,
        place: ["Cell 1"],
        toPlace: ["Cell 2"],
        day: { kind: "today" },
        span: null,
        existing: null,
        shift: null,
      } satisfies MoveCommand),
    );
  });
});

/**
 * S58 (docs/agent-briefs/s58-a-grammar-brief.md, R-412 to R-416, design
 * §19.103/D132) -- group 2 of the catalogue: a re-time by one edge
 * (`adjust`), a split, the job's own hours, a job's headcount, and "every
 * weekday"/"every day". AJ/SP/JB/HC/RW ids match the brief's own §2/§3.
 */
describe("commandParse: S58 grammar widening, group 2 (R-412 to R-416, D132)", () => {
  function moveAdjustOk(overrides: Partial<MoveCommand> = {}): { ok: true; command: MoveCommand } {
    return {
      ok: true,
      command: {
        intent: "move",
        operator: "Sam",
        place: [],
        toPlace: null,
        day: null,
        span: null,
        existing: null,
        shift: null,
        adjust: null,
        ...overrides,
      },
    };
  }

  function splitOk(overrides: Partial<SplitCommand> = {}): { ok: true; command: SplitCommand } {
    return {
      ok: true,
      command: {
        intent: "split",
        operator: "Sam",
        place: [],
        day: null,
        at: { hour: 12, minute: 0 },
        ...overrides,
      },
    };
  }

  function headcountOk(overrides: Partial<HeadcountCommand> = {}): {
    ok: true;
    command: HeadcountCommand;
  } {
    return {
      ok: true,
      command: {
        intent: "headcount",
        product: "Housing A",
        place: ["Cell 1"],
        day: null,
        span: null,
        shift: null,
        headcount: 4,
        ...overrides,
      },
    };
  }

  // -------------------------------------------------------------------
  // Adjust (R-412) -- AJ1-AJ11 the dedicated-verb door, AJ12-AJ16 the
  // possessive-edge-tail door, AJ17 the round trip, AJ18 the S52 tail
  // re-pinned beside it, AJ19 the quoted-name escape.
  // -------------------------------------------------------------------

  it("AJ1: extend Sam's block by an hour -- operator Sam, place [], {edge end, by 60}", () => {
    expect(parseCommand("extend Sam's block by an hour")).toEqual(
      moveAdjustOk({ adjust: { edge: "end", by: 60 } }),
    );
  });

  it("AJ2: extend Sam by 30 minutes -- by 30", () => {
    expect(parseCommand("extend Sam by 30 minutes")).toEqual(
      moveAdjustOk({ adjust: { edge: "end", by: 30 } }),
    );
  });

  it("AJ3: lengthen Sam on Cell 1 by 2 hours today -- place, day, by 120", () => {
    expect(parseCommand("lengthen Sam on Cell 1 by 2 hours today")).toEqual(
      moveAdjustOk({
        place: ["Cell 1"],
        day: { kind: "today" },
        adjust: { edge: "end", by: 120 },
      }),
    );
  });

  it("AJ4: shorten Sam by an hour -- by -60", () => {
    expect(parseCommand("shorten Sam by an hour")).toEqual(
      moveAdjustOk({ adjust: { edge: "end", by: -60 } }),
    );
  });

  it("AJ5: extend Sam's block by 0 minutes -- bad_adjust (a distance of zero)", () => {
    expect(parseCommand("extend Sam's block by 0 minutes")).toEqual({
      ok: false,
      failure: { kind: "bad_adjust", text: "0 minutes" },
    });
  });

  it("AJ6: extend Sam -- bad_adjust (no distance or time at all)", () => {
    expect(parseCommand("extend Sam")).toEqual({
      ok: false,
      failure: { kind: "bad_adjust", text: "Sam" },
    });
  });

  it("AJ7: end Sam early at 3 -- {end, at 15:00} (the workday rule: a lone hour under 7 reads pm)", () => {
    expect(parseCommand("end Sam early at 3")).toEqual(
      moveAdjustOk({ adjust: { edge: "end", at: { hour: 15, minute: 0 } } }),
    );
  });

  it("AJ8: finish Sam at 15:30 on Cell 1 -- place, the at-clause is not trailing", () => {
    expect(parseCommand("finish Sam at 15:30 on Cell 1")).toEqual(
      moveAdjustOk({
        place: ["Cell 1"],
        adjust: { edge: "end", at: { hour: 15, minute: 30 } },
      }),
    );
  });

  it("AJ9: end Sam an hour earlier -- {end, by -60}", () => {
    expect(parseCommand("end Sam an hour earlier")).toEqual(
      moveAdjustOk({ adjust: { edge: "end", by: -60 } }),
    );
  });

  it("AJ10: finish Sam 30 minutes later -- {end, by 30}", () => {
    expect(parseCommand("finish Sam 30 minutes later")).toEqual(
      moveAdjustOk({ adjust: { edge: "end", by: 30 } }),
    );
  });

  it("AJ11: end Sam -- bad_adjust (no distance or time at all)", () => {
    expect(parseCommand("end Sam")).toEqual({
      ok: false,
      failure: { kind: "bad_adjust", text: "Sam" },
    });
  });

  it("AJ12: move Sam's start to 9 -- {start, at 09:00}", () => {
    expect(parseCommand("move Sam's start to 9")).toEqual(
      moveAdjustOk({ adjust: { edge: "start", at: { hour: 9, minute: 0 } } }),
    );
  });

  it("AJ13: shift Sam's end an hour later -- {end, by 60}", () => {
    expect(parseCommand("shift Sam's end an hour later")).toEqual(
      moveAdjustOk({ adjust: { edge: "end", by: 60 } }),
    );
  });

  it("AJ14: change Sam's start by an hour -- {start, by 60} (a bare 'by' is later)", () => {
    expect(parseCommand("change Sam's start by an hour")).toEqual(
      moveAdjustOk({ adjust: { edge: "start", by: 60 } }),
    );
  });

  it("AJ15: move Sam's finish to 3 tomorrow -- {end, at 15:00}, day tomorrow ('finish' is an end)", () => {
    expect(parseCommand("move Sam's finish to 3 tomorrow")).toEqual(
      moveAdjustOk({
        day: { kind: "tomorrow" },
        adjust: { edge: "end", at: { hour: 15, minute: 0 } },
      }),
    );
  });

  it("AJ16: move Sam's start to 9 to Cell 2 -- bad_adjust (an adjust never carries a destination)", () => {
    expect(parseCommand("move Sam's start to 9 to Cell 2")).toEqual({
      ok: false,
      failure: { kind: "bad_adjust", text: "to Cell 2" },
    });
  });

  it("AJ17: formatCommand prints AJ1 as 'extend Sam by 1 hour', AJ7 as 'end Sam at 15:00', AJ12 as 'move Sam's start to 09:00', AJ9 as 'end Sam 1 hour earlier'; each round-trips", () => {
    const aj1 = parseCommand("extend Sam's block by an hour");
    if (!aj1.ok) throw new Error("AJ1 must parse");
    expect(formatCommand(aj1.command)).toBe("extend Sam by 1 hour");
    expect(parseCommand(formatCommand(aj1.command))).toEqual(aj1);

    const aj7 = parseCommand("end Sam early at 3");
    if (!aj7.ok) throw new Error("AJ7 must parse");
    expect(formatCommand(aj7.command)).toBe("end Sam at 15:00");
    expect(parseCommand(formatCommand(aj7.command))).toEqual(aj7);

    const aj12 = parseCommand("move Sam's start to 9");
    if (!aj12.ok) throw new Error("AJ12 must parse");
    expect(formatCommand(aj12.command)).toBe("move Sam's start to 09:00");
    expect(parseCommand(formatCommand(aj12.command))).toEqual(aj12);

    const aj9 = parseCommand("end Sam an hour earlier");
    if (!aj9.ok) throw new Error("AJ9 must parse");
    expect(formatCommand(aj9.command)).toBe("end Sam 1 hour earlier");
    expect(parseCommand(formatCommand(aj9.command))).toEqual(aj9);
  });

  it("AJ18: move Sam's timing to 8 pm to 11 pm (S52's tail) is unchanged -- pinned again beside the new edge tail", () => {
    expect(parseCommand("move Sam's timing to 8 pm to 11 pm")).toEqual(
      ok({
        intent: "move",
        adjust: null,
        operator: "Sam",
        place: [],
        toPlace: null,
        day: null,
        span: { start: { hour: 20, minute: 0 }, end: { hour: 23, minute: 0 } },
        existing: null,
        shift: null,
      } satisfies MoveCommand),
    );
  });

  it("AJ19 (brief §3, 'quoted names ... stay atomic'): a person quoted as \"Sam's start\" stays atomic on an ordinary move, never read as an edge tail", () => {
    expect(parseCommand('move "Sam\'s start" to Cell 2')).toEqual(
      ok({
        intent: "move",
        adjust: null,
        operator: "Sam's start",
        place: [],
        toPlace: ["Cell 2"],
        day: null,
        span: null,
        existing: null,
        shift: null,
      } satisfies MoveCommand),
    );
  });

  // -------------------------------------------------------------------
  // Reviewer fixes (S58 review): place after the adjust clause, on both
  // doors, and F-146's DAY_END rule applied to the adjust "at" clause.
  // -------------------------------------------------------------------

  it("AJ20 (reviewer fix): extend Sam by 90 minutes on Cell 1 tomorrow -- the dedicated-verb door's 'by' clause used to swallow a TRAILING place into the duration text and refuse the whole sentence", () => {
    expect(parseCommand("extend Sam by 90 minutes on Cell 1 tomorrow")).toEqual(
      moveAdjustOk({
        place: ["Cell 1"],
        day: { kind: "tomorrow" },
        adjust: { edge: "end", by: 90 },
      }),
    );
  });

  it("AJ21 (reviewer fix): move Sam's end to 3 pm on Cell 1 -- the possessive-edge-tail door had NO place clause at all and misread 'on Cell 1' as a second destination (AJ16's own failure)", () => {
    expect(parseCommand("move Sam's end to 3 pm on Cell 1")).toEqual(
      moveAdjustOk({
        place: ["Cell 1"],
        adjust: { edge: "end", at: { hour: 15, minute: 0 } },
      }),
    );
  });

  it("AJ22 (reviewer fix, F-146): end Sam at midnight -- an END spelled 'midnight' writes DAY_END here too, the same as every other END position in this file; round trip", () => {
    const aj22 = parseCommand("end Sam at midnight");
    expect(aj22).toEqual(moveAdjustOk({ adjust: { edge: "end", at: { hour: 23, minute: 59 } } }));
    if (!aj22.ok) throw new Error("AJ22 must parse");
    expect(formatCommand(aj22.command)).toBe("end Sam at midnight");
    expect(parseCommand(formatCommand(aj22.command))).toEqual(aj22);
  });

  it("AJ23 (reviewer fix): extend Sam's block by an hour and a half -- STILL bad_adjust (DURATION_VALUE has no such shape); guards against AJ20's own fix matching just 'an hour' and leaving 'and a half' dangling as part of the operator", () => {
    expect(parseCommand("extend Sam's block by an hour and a half")).toEqual({
      ok: false,
      failure: { kind: "bad_adjust", text: "an hour and a half" },
    });
  });

  it("AJ24 (reviewer fix): round trip -- AJ3's and AJ8's own place now prints (it used to be silently dropped by formatCommand, so re-parsing the printed sentence lost the cell for good)", () => {
    const aj3 = parseCommand("lengthen Sam on Cell 1 by 2 hours today");
    if (!aj3.ok) throw new Error("AJ3 must parse");
    expect(formatCommand(aj3.command)).toBe("extend Sam on Cell 1 by 2 hours on today");
    expect(parseCommand(formatCommand(aj3.command))).toEqual(aj3);

    const aj8 = parseCommand("finish Sam at 15:30 on Cell 1");
    if (!aj8.ok) throw new Error("AJ8 must parse");
    expect(formatCommand(aj8.command)).toBe("end Sam at 15:30 on Cell 1");
    expect(parseCommand(formatCommand(aj8.command))).toEqual(aj8);

    const aj21 = parseCommand("move Sam's end to 3 pm on Cell 1");
    if (!aj21.ok) throw new Error("AJ21 must parse");
    expect(parseCommand(formatCommand(aj21.command))).toEqual(aj21);
  });

  // -------------------------------------------------------------------
  // Split (R-413)
  // -------------------------------------------------------------------

  it("SP1: split Sam's block at noon -- split {Sam, [], null, 12:00}", () => {
    expect(parseCommand("split Sam's block at noon")).toEqual(splitOk());
  });

  it("SP2: split Sam on Cell 1 at 12 today -- place, day", () => {
    expect(parseCommand("split Sam on Cell 1 at 12 today")).toEqual(
      splitOk({ place: ["Cell 1"], day: { kind: "today" } }),
    );
  });

  it("SP3: split Sam at 3 -- 15:00 (the workday rule)", () => {
    expect(parseCommand("split Sam at 3")).toEqual(splitOk({ at: { hour: 15, minute: 0 } }));
  });

  it("SP4: split Sam -- no_split_time", () => {
    expect(parseCommand("split Sam")).toEqual({
      ok: false,
      failure: { kind: "no_split_time" },
    });
  });

  it("SP5: round trip -- split Sam on Cell 1 at 12:00 today", () => {
    const sp5 = parseCommand("split Sam on Cell 1 at 12:00 today");
    if (!sp5.ok) throw new Error("SP5 must parse");
    expect(parseCommand(formatCommand(sp5.command))).toEqual(sp5);
  });

  // S58-e (R-413, docs/agent-briefs/s58-e-split-separate-brief.md §3): the
  // new `Existing` member `expandSplit` writes on the second half round-trips
  // through parse/format exactly like `separate` and `retime` already do --
  // `formatCommand` never prints `existing` at all, so a command carrying it
  // formats identically to one without and re-parses back to `existing: null`.
  it("SP6: existing: separate_from is left alone by formatCommand (never printed, same as retime/separate)", () => {
    const command: AssignCommand = {
      intent: "assign",
      operator: "Sam",
      product: "Housing A",
      place: ["Cell 1"],
      day: null,
      start: { hour: 12, minute: 0 },
      end: { hour: 14, minute: 0 },
      attach: null,
      shift: null,
      existing: { kind: "separate_from", assignmentId: "blk1" },
    };
    const sentence = formatCommand(command);
    expect(sentence).toBe(formatCommand({ ...command, existing: null }));
    expect(parseCommand(sentence)).toEqual({
      ok: true,
      command: { ...command, existing: null },
    });
  });

  // -------------------------------------------------------------------
  // The job's hours (R-414) -- an assign with shift: JOB_HOURS, start/end
  // null.
  // -------------------------------------------------------------------

  it("JB1: add Sam to the Housing A job on Cell 1 -- product Housing A, place ['Cell 1']", () => {
    expect(parseCommand("add Sam to the Housing A job on Cell 1")).toEqual(
      ok({
        intent: "assign",
        operator: "Sam",
        product: "Housing A",
        place: ["Cell 1"],
        day: null,
        start: null,
        end: null,
        attach: null,
        existing: null,
        shift: JOB_HOURS,
      } satisfies AssignCommand),
    );
  });

  it("JB2: put Sam on the Housing A run on Cell 1 tomorrow -- 'run' reads the same as 'job'", () => {
    expect(parseCommand("put Sam on the Housing A run on Cell 1 tomorrow")).toEqual(
      ok({
        intent: "assign",
        operator: "Sam",
        product: "Housing A",
        place: ["Cell 1"],
        day: { kind: "tomorrow" },
        start: null,
        end: null,
        attach: null,
        existing: null,
        shift: JOB_HOURS,
      } satisfies AssignCommand),
    );
  });

  it('JB3: add Sam to the "Bracket, left" job on Cell 1 -- a quoted product stays atomic', () => {
    expect(parseCommand('add Sam to the "Bracket, left" job on Cell 1')).toEqual(
      ok({
        intent: "assign",
        operator: "Sam",
        product: "Bracket, left",
        place: ["Cell 1"],
        day: null,
        start: null,
        end: null,
        attach: null,
        existing: null,
        shift: JOB_HOURS,
      } satisfies AssignCommand),
    );
  });

  it("JB4: add Sam to the Housing A job on Cell 1 from 8 to 4 -- shift_and_hours", () => {
    expect(parseCommand("add Sam to the Housing A job on Cell 1 from 8 to 4")).toEqual({
      ok: false,
      failure: { kind: "shift_and_hours" },
    });
  });

  it("JB5: assign Sam to the Housing A job -- no_place (a job needs its cell)", () => {
    expect(parseCommand("assign Sam to the Housing A job")).toEqual({
      ok: false,
      failure: { kind: "no_place" },
    });
  });

  it("JB6: formatCommand round-trips JB1 (real output: the canonical 'assign' verb, PV4's own rule)", () => {
    const jb1 = parseCommand("add Sam to the Housing A job on Cell 1");
    if (!jb1.ok) throw new Error("JB1 must parse");
    const printed = formatCommand(jb1.command);
    expect(printed).toBe("assign Sam to the Housing A job on Cell 1");
    expect(parseCommand(printed)).toEqual(jb1);
  });

  it('JB7: add Sam to Housing A on Cell 1 8 to 4 stays an ordinary assign (no "the ... job")', () => {
    expect(parseCommand("add Sam to Housing A on Cell 1 8 to 4")).toEqual(
      ok({
        intent: "assign",
        operator: "Sam",
        product: "Housing A",
        place: ["Cell 1"],
        day: null,
        start: { hour: 8, minute: 0 },
        end: { hour: 16, minute: 0 },
        attach: null,
        existing: null,
        shift: null,
      } satisfies AssignCommand),
    );
  });

  it("JB8 (reviewer fix): add Sam to the Housing A job on Cell 1 for shift 2 -- shift_and_hours; the dispatch used to run the ordinary boundary/shift-clause check on the WHOLE sentence BEFORE tryJobHoursAssign ever saw it, matched 'for shift 2' first, and returned an assign with the literal (nonsense) product 'the Housing A job' and shift '2'", () => {
    expect(parseCommand("add Sam to the Housing A job on Cell 1 for shift 2")).toEqual({
      ok: false,
      failure: { kind: "shift_and_hours" },
    });
  });

  it("JB9 (reviewer fix): add Sam to the Housing A job on Cell 1 from 8 for 4 hours -- the SAME conflict, said as a duration clause instead of a named shift; also used to fall through the duration-clause dispatch first and read the literal product", () => {
    expect(parseCommand("add Sam to the Housing A job on Cell 1 from 8 for 4 hours")).toEqual({
      ok: false,
      failure: { kind: "shift_and_hours" },
    });
  });

  // -------------------------------------------------------------------
  // Headcount (R-415)
  // -------------------------------------------------------------------

  it("HC1: make the Housing A job on Cell 1 4 people", () => {
    expect(parseCommand("make the Housing A job on Cell 1 4 people")).toEqual(headcountOk());
  });

  it("HC2: set the Housing A job on Cell 1 to 4 people", () => {
    expect(parseCommand("set the Housing A job on Cell 1 to 4 people")).toEqual(headcountOk());
  });

  it("HC3: make the Housing A job on Cell 1 today from 8 to 4 4 people -- span", () => {
    expect(parseCommand("make the Housing A job on Cell 1 today from 8 to 4 4 people")).toEqual(
      headcountOk({
        day: { kind: "today" },
        span: { start: { hour: 8, minute: 0 }, end: { hour: 16, minute: 0 } },
      }),
    );
  });

  it("HC4: make the Housing A job on Cell 1 for shift 2 3 people -- shift '2'", () => {
    expect(parseCommand("make the Housing A job on Cell 1 for shift 2 3 people")).toEqual(
      headcountOk({ shift: "2", headcount: 3 }),
    );
  });

  it("HC5: make it 4 people -- which_job (the bar keeps no memory of the last thing it did)", () => {
    expect(parseCommand("make it 4 people")).toEqual({
      ok: false,
      failure: { kind: "which_job" },
    });
  });

  it("HC6: make the Housing A job on Cell 1 0 people -- bad_headcount", () => {
    expect(parseCommand("make the Housing A job on Cell 1 0 people")).toEqual({
      ok: false,
      failure: { kind: "bad_headcount", text: "0" },
    });
  });

  it("HC7: set the Housing A job on Cell 1 to 100 people -- bad_headcount", () => {
    expect(parseCommand("set the Housing A job on Cell 1 to 100 people")).toEqual({
      ok: false,
      failure: { kind: "bad_headcount", text: "100" },
    });
  });

  it("HC8: round trip -- make the Housing A job on Cell 1 4 people", () => {
    const hc8 = parseCommand("make the Housing A job on Cell 1 4 people");
    if (!hc8.ok) throw new Error("HC8 must parse");
    const printed = formatCommand(hc8.command);
    expect(printed).toBe("make the Housing A job on Cell 1 4 people");
    expect(parseCommand(printed)).toEqual(hc8);
  });

  it("HC10 (reviewer fix): make the Housing A job 4 people -- no_place; HEADCOUNT_TRAILING_RE required a LEADING whitespace before the count, so a headcount sentence with no place at all ('4 people' sits directly after 'job', nothing before it to satisfy that) was never even recognised as headcount-shaped and fell through to a generic no_time instead of D132 item 4's own no_place", () => {
    expect(parseCommand("make the Housing A job 4 people")).toEqual({
      ok: false,
      failure: { kind: "no_place" },
    });
  });

  it("HC9 (the developer's decision, R-391): set Sam on Housing A on Cell 1 8 to 4 -- 'set' stays the assign verb it was; the headcount pattern claims 'set the ... job' first (Option B -- see the R-391 comment above ASSIGN_VERBS)", () => {
    expect(parseCommand("set Sam on Housing A on Cell 1 8 to 4")).toEqual(
      ok({
        intent: "assign",
        operator: "Sam",
        product: "Housing A",
        place: ["Cell 1"],
        day: null,
        start: { hour: 8, minute: 0 },
        end: { hour: 16, minute: 0 },
        attach: null,
        existing: null,
        shift: null,
      } satisfies AssignCommand),
    );
  });

  // -------------------------------------------------------------------
  // Every weekday (R-416)
  // -------------------------------------------------------------------

  it("RW1: assign Sam to Housing A on Cell 1 every weekday this week 8 to 4 -- day {weekdays, this_week}", () => {
    expect(
      parseCommand("assign Sam to Housing A on Cell 1 every weekday this week 8 to 4"),
    ).toEqual(
      ok({
        intent: "assign",
        operator: "Sam",
        product: "Housing A",
        place: ["Cell 1"],
        day: { kind: "weekdays", week: "this_week" },
        start: { hour: 8, minute: 0 },
        end: { hour: 16, minute: 0 },
        attach: null,
        existing: null,
        shift: null,
      } satisfies AssignCommand),
    );
  });

  it("RW2: book Housing A on Cell 2 every day next week 6 to 2 -- {every_day, next_week}", () => {
    expect(parseCommand("book Housing A on Cell 2 every day next week 6 to 2")).toEqual(
      ok({
        intent: "book",
        product: "Housing A",
        place: ["Cell 2"],
        headcount: null,
        day: { kind: "every_day", week: "next_week" },
        start: { hour: 6, minute: 0 },
        end: { hour: 14, minute: 0 },
        shift: null,
        existing: null,
      } satisfies BookCommand),
    );
  });

  it("RW3: put Sam on Housing A on Cell 1 weekdays next week for shift 2 -- {weekdays, next_week}, shift '2'", () => {
    expect(parseCommand("put Sam on Housing A on Cell 1 weekdays next week for shift 2")).toEqual(
      ok({
        intent: "assign",
        operator: "Sam",
        product: "Housing A",
        place: ["Cell 1"],
        day: { kind: "weekdays", week: "next_week" },
        start: null,
        end: null,
        attach: null,
        existing: null,
        shift: "2",
      } satisfies AssignCommand),
    );
  });

  it("RW4: assign Sam to Housing A on Cell 1 every weekday 8 to 4 (no week) -- defaults to this week", () => {
    expect(parseCommand("assign Sam to Housing A on Cell 1 every weekday 8 to 4")).toEqual(
      ok({
        intent: "assign",
        operator: "Sam",
        product: "Housing A",
        place: ["Cell 1"],
        day: { kind: "weekdays", week: "this_week" },
        start: { hour: 8, minute: 0 },
        end: { hour: 16, minute: 0 },
        attach: null,
        existing: null,
        shift: null,
      } satisfies AssignCommand),
    );
  });

  it("RW5: remove Sam from Cell 1 every weekday this week -- bad_day (a repeat day is legal on assign/book only)", () => {
    expect(parseCommand("remove Sam from Cell 1 every weekday this week")).toEqual({
      ok: false,
      failure: { kind: "bad_day", text: "every weekday this week" },
    });
  });

  it("RW6: assign Sam to Housing A on Cell 1 every weekday this week tomorrow from 8 to 4 -- two_days, never a guess", () => {
    expect(
      parseCommand(
        "assign Sam to Housing A on Cell 1 every weekday this week tomorrow from 8 to 4",
      ),
    ).toEqual({
      ok: false,
      failure: { kind: "two_days", first: "every weekday this week", second: "tomorrow" },
    });
  });

  it("RW7: formatCommand prints 'every weekday this week' / 'every day next week'; both round-trip", () => {
    const rw1 = parseCommand("assign Sam to Housing A on Cell 1 every weekday this week 8 to 4");
    if (!rw1.ok) throw new Error("RW1 must parse");
    const printed1 = formatCommand(rw1.command);
    expect(printed1).toContain("every weekday this week");
    expect(parseCommand(printed1)).toEqual(rw1);

    const rw2 = parseCommand("book Housing A on Cell 2 every day next week 6 to 2");
    if (!rw2.ok) throw new Error("RW2 must parse");
    const printed2 = formatCommand(rw2.command);
    expect(printed2).toContain("every day next week");
    expect(parseCommand(printed2)).toEqual(rw2);
  });

  // -------------------------------------------------------------------
  // R-391 honesty: the new lists stay disjoint from every other list
  // except the one documented exception ("set").
  // -------------------------------------------------------------------

  it("ADJUST_VERBS/HEADCOUNT_VERBS/REPEAT_WORDS are exported with the brief's own spellings; the verb lists stay pairwise disjoint except 'set' (R-391's one documented exception, HC9)", () => {
    expect(ADJUST_VERBS).toEqual(["extend", "lengthen", "shorten", "end", "finish"]);
    expect(HEADCOUNT_VERBS).toEqual(["make", "set"]);
    expect(REPEAT_WORDS).toEqual(["every weekday", "every day", "weekdays"]);

    const disjointLists: readonly (readonly string[])[] = [
      ASSIGN_VERBS,
      BOOK_VERBS,
      UNASSIGN_VERBS,
      MOVE_VERBS,
      REPLACE_VERBS,
      SWAP_VERBS,
      COPY_VERBS,
      ADJUST_VERBS,
    ];
    const all = disjointLists.flatMap((list) => list);
    expect(new Set(all).size).toBe(all.length);

    expect(ASSIGN_VERBS).toContain("set");
    expect(HEADCOUNT_VERBS).toContain("set");
    expect(HEADCOUNT_VERBS).toContain("make");
    expect(disjointLists.some((list) => list !== ASSIGN_VERBS && list.includes("make"))).toBe(
      false,
    );
  });
});
