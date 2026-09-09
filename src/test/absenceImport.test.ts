/**
 * absenceImport.test.ts — the PREVIEW half of the absences import lane
 * (`src/features/admin/lib/absenceImport.ts`, R-357). CSV string ->
 * `parseCsvTable` -> `detectColumns` -> `planAbsenceImport`, exactly as
 * `AbsencesImport` drives it. The person is matched by import id, then employee
 * ref, then name (a non-unique match is an error, never a guess); a re-upload of
 * the same sheet updates in place on the derived absence id `<handle>:<from>`.
 */
import { describe, expect, it } from "vitest";
import type { AbsenceRecord, OperatorRecord } from "@/lib/api";
import { parseCsvTable } from "../features/admin/lib/csv.ts";
import {
  detectColumns,
  planAbsenceImport,
  planToImportRows,
  ABSENCE_TEMPLATE,
} from "../features/admin/lib/absenceImport.ts";

function operator(over: Partial<OperatorRecord> = {}): OperatorRecord {
  return {
    id: "O1",
    displayName: "Jane Smith",
    employeeRef: "EMP-1",
    active: true,
    siteNodeId: "N1",
    source: "manual",
    externalId: "EXT-1",
    ...over,
  };
}

const PEOPLE: OperatorRecord[] = [
  operator(),
  operator({ id: "O2", displayName: "John Doe", employeeRef: "EMP-2", externalId: "EXT-2" }),
  // Two people share an employee ref and a name, to force the ambiguity rules.
  operator({ id: "O3", displayName: "Sam Twin", employeeRef: "DUP", externalId: "EXT-3" }),
  operator({ id: "O4", displayName: "Sam Twin", employeeRef: "DUP", externalId: "EXT-4" }),
];

function planFrom(
  csv: string,
  absences: AbsenceRecord[] = [],
  zoneFor?: (op: OperatorRecord) => string | null,
) {
  const table = parseCsvTable(csv);
  const columns = detectColumns(table.headerKeys);
  return planAbsenceImport(table, PEOPLE, absences, columns, zoneFor);
}

/** R-359: every plant on one clock, the ordinary case. */
const inZone = (zone: string) => () => zone;

const only = (plan: ReturnType<typeof planFrom>) => plan.rows[0].outcome;

describe("detectColumns", () => {
  it("maps every template header to its field", () => {
    const table = parseCsvTable(
      [ABSENCE_TEMPLATE.headers.join(","), ABSENCE_TEMPLATE.example.join(",")].join("\n"),
    );
    const cols = detectColumns(table.headerKeys);
    expect(cols.externalId).not.toBeNull();
    expect(cols.employeeRef).not.toBeNull();
    expect(cols.displayName).not.toBeNull();
    expect(cols.from).not.toBeNull();
    expect(cols.to).not.toBeNull();
    expect(cols.reason).not.toBeNull();
  });

  it("reports from/to/reason as required-to-map when the header lacks them", () => {
    const plan = planFrom("Import ID\nEXT-1");
    expect([...plan.missingRequired].sort()).toEqual(["from", "reason", "to"]);
  });
});

describe("resolving the person", () => {
  it("matches on import id and plans an insert", () => {
    const o = only(planFrom("Import ID,From,To,Reason\nEXT-1,2027-01-01,2027-01-03,Sick"));
    expect(o.kind).toBe("insert");
    if (o.kind !== "insert") throw new Error("expected insert");
    expect(o.operatorId).toBe("O1");
    expect(o.externalId).toBe("EXT-1:2027-01-01");
  });

  it("matches on employee ref when no import id is given", () => {
    const o = only(planFrom("Employee ref,From,To,Reason\nEMP-2,2027-02-01,2027-02-02,Leave"));
    expect(o.kind).toBe("insert");
    if (o.kind !== "insert") throw new Error("expected insert");
    expect(o.operatorId).toBe("O2");
  });

  it("matches on name when neither id nor ref is given", () => {
    const o = only(planFrom("Name,From,To,Reason\nJohn Doe,2027-02-01,2027-02-02,Leave"));
    expect(o.kind).toBe("insert");
    if (o.kind !== "insert") throw new Error("expected insert");
    expect(o.operatorId).toBe("O2");
  });

  it("a non-unique employee ref is an ERROR, not a guess", () => {
    const o = only(planFrom("Employee ref,From,To,Reason\nDUP,2027-02-01,2027-02-02,Leave"));
    expect(o.kind).toBe("error");
    if (o.kind !== "error") throw new Error("expected error");
    expect(o.messages.join(" ")).toMatch(/more than one person/);
  });

  it("a non-unique name is an ERROR", () => {
    const o = only(planFrom("Name,From,To,Reason\nSam Twin,2027-02-01,2027-02-02,Leave"));
    expect(o.kind).toBe("error");
  });

  it("a row that names nobody is an ERROR", () => {
    const o = only(planFrom("Name,From,To,Reason\n,2027-02-01,2027-02-02,Leave"));
    expect(o.kind).toBe("error");
    if (o.kind !== "error") throw new Error("expected error");
    expect(o.messages.join(" ")).toMatch(/a person is required/);
  });

  it("an unknown import id is an ERROR", () => {
    const o = only(planFrom("Import ID,From,To,Reason\nNOPE,2027-02-01,2027-02-02,Leave"));
    expect(o.kind).toBe("error");
  });
});

describe("dates and reason", () => {
  it("a non-date is an ERROR", () => {
    const o = only(planFrom("Import ID,From,To,Reason\nEXT-1,not-a-date,2027-02-02,Leave"));
    expect(o.kind).toBe("error");
    if (o.kind !== "error") throw new Error("expected error");
    expect(o.messages.join(" ")).toMatch(/is not a date/);
  });

  it("an end before the start is an ERROR", () => {
    const o = only(planFrom("Import ID,From,To,Reason\nEXT-1,2027-02-05,2027-02-01,Leave"));
    expect(o.kind).toBe("error");
    if (o.kind !== "error") throw new Error("expected error");
    expect(o.messages.join(" ")).toMatch(/before the start date/);
  });

  it("a blank reason is an ERROR", () => {
    const o = only(planFrom("Import ID,From,To,Reason\nEXT-1,2027-02-01,2027-02-02,"));
    expect(o.kind).toBe("error");
  });
});

describe("insert vs update, and the counts", () => {
  it("a row whose derived id already exists is an UPDATE", () => {
    const existing: AbsenceRecord = {
      id: "A1",
      operatorId: "O1",
      from: "2027-01-01",
      to: "2027-01-01",
      reason: "old",
      source: "import",
      externalId: "EXT-1:2027-01-01",
    };
    const o = only(
      planFrom("Import ID,From,To,Reason\nEXT-1,2027-01-01,2027-01-03,Sick", [existing]),
    );
    expect(o.kind).toBe("update");
  });

  it("counts a mixed file and drops error rows from the apply list", () => {
    const csv = [
      "Import ID,From,To,Reason",
      "EXT-1,2027-01-01,2027-01-03,Sick", // insert
      "EXT-2,bad,2027-02-02,Leave", // error (bad date)
      "EXT-2,2027-02-01,2027-02-02,Leave", // insert
    ].join("\n");
    const plan = planFrom(csv);
    expect(plan.counts).toEqual({ insert: 2, update: 0, error: 1 });
    const rows = planToImportRows(plan);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.operatorId !== undefined)).toBe(true);
    expect(rows.map((r) => r.line).sort()).toEqual([2, 4]);
  });
});

/* ===========================================================================
 * R-359 — an imported absence can be part of a day.
 *
 * The rules are migration 0073's, which are `set_absence`'s: both times or
 * neither, the end after the start, and a part-day absence is a single day.
 * They are checked in the PREVIEW so the screen refuses exactly what the server
 * would refuse, rather than showing a row as fine and having it come back
 * failed.
 * ======================================================================== */

const HDR = "Import ID,From,To,Reason,From time,To time";

describe("planAbsenceImport: part of a day (R-359)", () => {
  it("detects the two time columns from the template's own headers", () => {
    const table = parseCsvTable(
      [ABSENCE_TEMPLATE.headers.join(","), ABSENCE_TEMPLATE.example.join(",")].join("\n"),
    );
    const cols = detectColumns(table.headerKeys);
    expect(cols.fromTime).not.toBeNull();
    expect(cols.toTime).not.toBeNull();
    // And the DATE columns are still theirs. "start"/"end" are `from`/`to`
    // aliases, so a time alias of "start" would have stolen the date column.
    expect(cols.from).not.toBe(cols.fromTime);
    expect(cols.to).not.toBe(cols.toTime);
  });

  it("turns a wall clock into instants on the person's own plant zone", () => {
    const plan = planFrom(
      `${HDR}\nEXT-1,2026-06-10,2026-06-10,Appointment,09:00,13:00`,
      [],
      inZone("UTC"),
    );
    const out = only(plan);
    expect(out.kind).toBe("insert");
    if (out.kind === "error") throw new Error("unreachable");
    expect(out.startsAt).toBe("2026-06-10T09:00:00.000Z");
    expect(out.endsAt).toBe("2026-06-10T13:00:00.000Z");
  });

  it("the SAME sheet read on a different plant's clock is a different instant", () => {
    // This is the whole reason the zone is per person rather than per file.
    const utc = planFrom(
      `${HDR}\nEXT-1,2026-06-10,2026-06-10,Appointment,09:00,13:00`,
      [],
      inZone("UTC"),
    );
    const chi = planFrom(
      `${HDR}\nEXT-1,2026-06-10,2026-06-10,Appointment,09:00,13:00`,
      [],
      inZone("America/Chicago"),
    );
    const a = only(utc);
    const b = only(chi);
    if (a.kind === "error" || b.kind === "error") throw new Error("unreachable");
    expect(a.startsAt).not.toBe(b.startsAt);
    expect(b.startsAt).toBe("2026-06-10T14:00:00.000Z"); // CDT, UTC-5
  });

  it("reads each person on their OWN plant, not one zone for the file", () => {
    const plan = planFrom(
      `${HDR}\nEXT-1,2026-06-10,2026-06-10,Appointment,09:00,13:00\nEXT-2,2026-06-10,2026-06-10,Appointment,09:00,13:00`,
      [],
      (op) => (op.id === "O1" ? "UTC" : "America/Chicago"),
    );
    const [a, b] = plan.rows.map((r) => r.outcome);
    if (a.kind === "error" || b.kind === "error") throw new Error("unreachable");
    expect(a.startsAt).toBe("2026-06-10T09:00:00.000Z");
    expect(b.startsAt).toBe("2026-06-10T14:00:00.000Z");
  });

  it("a sheet with no time columns is a whole-day row, exactly as before", () => {
    const plan = planFrom("Import ID,From,To,Reason\nEXT-1,2026-06-10,2026-06-12,Sick");
    const out = only(plan);
    expect(out.kind).toBe("insert");
    if (out.kind === "error") throw new Error("unreachable");
    expect(out.startsAt).toBeUndefined();
    expect(out.endsAt).toBeUndefined();
  });

  it("blank time cells are a whole-day row, not an error", () => {
    const plan = planFrom(`${HDR}\nEXT-1,2026-06-10,2026-06-12,Sick,,`, [], inZone("UTC"));
    const out = only(plan);
    expect(out.kind).toBe("insert");
    if (out.kind === "error") throw new Error("unreachable");
    expect(out.startsAt).toBeUndefined();
  });

  it("one time without the other is refused, the way the server refuses it", () => {
    const plan = planFrom(
      `${HDR}\nEXT-1,2026-06-10,2026-06-10,Appointment,09:00,`,
      [],
      inZone("UTC"),
    );
    const out = only(plan);
    expect(out.kind).toBe("error");
    if (out.kind !== "error") throw new Error("unreachable");
    expect(out.messages.join(" ")).toContain("both a start and an end time");
  });

  it("an end time that is not after the start is refused", () => {
    const plan = planFrom(
      `${HDR}\nEXT-1,2026-06-10,2026-06-10,Appointment,13:00,09:00`,
      [],
      inZone("UTC"),
    );
    const out = only(plan);
    if (out.kind !== "error") throw new Error("unreachable");
    expect(out.messages.join(" ")).toContain("not after the start time");
  });

  it("equal times are refused too -- the window would be empty", () => {
    const plan = planFrom(
      `${HDR}\nEXT-1,2026-06-10,2026-06-10,Appointment,09:00,09:00`,
      [],
      inZone("UTC"),
    );
    const out = only(plan);
    if (out.kind !== "error") throw new Error("unreachable");
    expect(out.messages.join(" ")).toContain("not after the start time");
  });

  it("a part-day absence spanning two dates is refused", () => {
    const plan = planFrom(
      `${HDR}\nEXT-1,2026-06-10,2026-06-11,Appointment,09:00,13:00`,
      [],
      inZone("UTC"),
    );
    const out = only(plan);
    if (out.kind !== "error") throw new Error("unreachable");
    expect(out.messages.join(" ")).toContain("single day");
  });

  it("an unreadable time is an error, never a guess", () => {
    for (const bad of ["9am", "0900", "25:00", "09:70", "noon"]) {
      const plan = planFrom(
        `${HDR}\nEXT-1,2026-06-10,2026-06-10,Appointment,${bad},13:00`,
        [],
        inZone("UTC"),
      );
      const out = only(plan);
      expect(out.kind, `"${bad}" should not be accepted`).toBe("error");
    }
  });

  it("accepts 9:00 and 09:00:00, the two shapes a spreadsheet exports", () => {
    for (const ok of ["9:00", "09:00:00"]) {
      const plan = planFrom(
        `${HDR}\nEXT-1,2026-06-10,2026-06-10,Appointment,${ok},13:00`,
        [],
        inZone("UTC"),
      );
      const out = only(plan);
      if (out.kind === "error") throw new Error(`"${ok}" was refused: ${out.messages.join("; ")}`);
      expect(out.startsAt).toBe("2026-06-10T09:00:00.000Z");
    }
  });

  /*
   * THE ONE THAT MATTERS MOST. A row with times whose plant zone is unknown must
   * be an ERROR. Falling back to "whole day" would take a two-hour appointment
   * and book the person off for the day -- the exact bug this whole piece exists
   * to close, reintroduced by a helpful-looking default.
   */
  it("times with no known plant zone are an error, NOT a silent whole day", () => {
    const plan = planFrom(
      `${HDR}\nEXT-1,2026-06-10,2026-06-10,Appointment,09:00,13:00`,
      [],
      () => null,
    );
    const out = only(plan);
    expect(out.kind).toBe("error");
    if (out.kind !== "error") throw new Error("unreachable");
    expect(out.messages.join(" ")).toContain("clock");
  });

  it("and so is a sheet with times when no zoneFor was supplied at all", () => {
    const plan = planFrom(`${HDR}\nEXT-1,2026-06-10,2026-06-10,Appointment,09:00,13:00`);
    expect(only(plan).kind).toBe("error");
  });

  it("planToImportRows forwards the pair, and omits it on a whole-day row", () => {
    const plan = planFrom(
      `${HDR}\nEXT-1,2026-06-10,2026-06-10,Appointment,09:00,13:00\nEXT-2,2026-07-01,2026-07-03,Sick,,`,
      [],
      inZone("UTC"),
    );
    const rows = planToImportRows(plan);
    expect(rows).toHaveLength(2);
    expect(rows[0].startsAt).toBe("2026-06-10T09:00:00.000Z");
    expect(rows[0].endsAt).toBe("2026-06-10T13:00:00.000Z");
    expect(rows[1].startsAt).toBeUndefined();
    expect(rows[1].endsAt).toBeUndefined();
  });

  it("a clock-change day is judged on elapsed time, not on the digits", () => {
    // 8 Mar 2026 is the US spring-forward (02:00 local vanishes). 01:30 -> 03:30
    // is ONE real hour, and must still be accepted as end-after-start.
    const plan = planFrom(
      `${HDR}\nEXT-1,2026-03-08,2026-03-08,Appointment,01:30,03:30`,
      [],
      inZone("America/Chicago"),
    );
    const out = only(plan);
    if (out.kind === "error") throw new Error(out.messages.join("; "));
    const started = new Date(out.startsAt as string).getTime();
    const ended = new Date(out.endsAt as string).getTime();
    expect(ended).toBeGreaterThan(started);
    // One hour of real time, despite two hours on the clock face.
    expect(ended - started).toBe(60 * 60 * 1000);
  });
});
