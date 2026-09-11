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
import type { AssignCommand } from "@/lib/command/parse";

function ok(command: AssignCommand) {
  return { ok: true as const, command };
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
    };
    const sentence = formatCommand(command);
    expect(sentence).toContain('"Lin On"');
    const reparsed = parseCommand(sentence);
    expect(reparsed).toEqual({ ok: true, command });

    const withAttach: AssignCommand = { ...command, attach: { kind: "direct" } };
    expect(formatCommand(withAttach)).toBe(formatCommand(command));
  });
});

describe("commandParse: expectedShape()", () => {
  it("is the one sentence the bar shows on a parse failure", () => {
    expect(expectedShape()).toBe(
      "Say it like: assign <person> to <part> on <cell> [in <line>] [on <day>] from <time> to <time>",
    );
  });
});
