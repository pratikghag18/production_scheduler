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
import type {
  AssignCommand,
  BookCommand,
  UnassignCommand,
  MoveCommand,
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
        existing: null,
      },
    });
  });

  it("MV12: move, a trailing day after the hours", () => {
    expect(parseCommand("Move Sam on Cell 1 to Cell 2 from 10 to 3 on Saturday")).toEqual({
      ok: true,
      command: {
        intent: "move",
        operator: "Sam",
        place: ["Cell 1"],
        toPlace: ["Cell 2"],
        day: { kind: "weekday", day: 6 },
        span: { start: { hour: 10, minute: 0 }, end: { hour: 15, minute: 0 } },
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
        existing: null,
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

  it("U6: unassign Sam from 10 to 2 -- no_place (the only 'from' is consumed by the time clause)", () => {
    expect(parseCommand("unassign Sam from 10 to 2")).toEqual({
      ok: false,
      failure: { kind: "no_place" },
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
        operator: "Sam",
        place: ["Cell 1"],
        toPlace: null,
        day: null,
        span: null,
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

  it("MV5: move Sam to Cell 2 -- no_place (no on/at/from before a place at all)", () => {
    expect(parseCommand("move Sam to Cell 2")).toEqual({
      ok: false,
      failure: { kind: "no_place" },
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
        existing: null,
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
  const NEW_MOVE_VERBS = ["reschedule", "transfer", "relocate", "switch"];

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

  it("PV2: the four exported verb lists are pairwise disjoint and contain neither 'shift' nor 'change'", () => {
    const lists: readonly (readonly string[])[] = [
      ASSIGN_VERBS,
      BOOK_VERBS,
      UNASSIGN_VERBS,
      MOVE_VERBS,
    ];
    const all = lists.flatMap((list) => list);
    expect(new Set(all).size).toBe(all.length);
    expect(all).not.toContain("shift");
    expect(all).not.toContain("change");
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
