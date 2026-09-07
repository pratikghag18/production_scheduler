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

function planFrom(csv: string, absences: AbsenceRecord[] = []) {
  const table = parseCsvTable(csv);
  const columns = detectColumns(table.headerKeys);
  return planAbsenceImport(table, PEOPLE, absences, columns);
}

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
