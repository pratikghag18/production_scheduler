/**
 * Acceptance suite for `certificationImport.ts` — the training-records plan. A
 * JOIN import: each row resolves a PERSON (by employee ref) and a TRAINING (by
 * name, on the person's branch) and records a grant. The realistic path is
 * exercised: a CSV string -> `parseCsvTable` -> `detectColumns` -> `planCertificationImport`.
 */
import { describe, expect, it } from "vitest";
import { parseCsvTable } from "../features/admin/lib/csv.ts";
import {
  detectColumns,
  planCertificationImport,
  CERTIFICATION_TEMPLATE,
  type CertificationData,
} from "../features/admin/lib/certificationImport.ts";
import { scopeIndex, type ScopeNode } from "../features/admin/lib/scope.ts";

/* ---- fixtures: two plants, people, trainings, some already held ---------- */
const NODES: ScopeNode[] = [
  { id: "pa", name: "Plant A", parentId: null, path: "a" },
  { id: "pa-l1", name: "Line 1", parentId: "pa", path: "a.l1" },
  { id: "pb", name: "Plant B", parentId: null, path: "b" },
];
const BY_ID = scopeIndex(NODES);

const op = (id: string, employeeRef: string | null, siteNodeId: string) => ({
  id,
  displayName: id,
  employeeRef,
  active: true,
  siteNodeId,
  source: "manual",
  externalId: null,
});
const skill = (id: string, name: string, siteNodeId: string) => ({
  id,
  name,
  siteNodeId,
  active: true,
});

const DATA: CertificationData = {
  operators: [
    op("o-alice", "EMP-1", "pa"), // Plant A person
    op("o-bob", "EMP-2", "pb"), // Plant B person
    op("o-dupA", "EMP-DUP", "pa"), // same ref as...
    op("o-dupB", "EMP-DUP", "pb"), // ...this one -> ambiguous
  ],
  skills: [
    skill("s-fork-a", "Forklift", "pa"), // Forklift owned by Plant A
    skill("s-fork-b", "Forklift", "pb"), // and by Plant B
    skill("s-weld-l1", "Welding", "pa-l1"), // Welding owned by Line 1 (under Plant A)
  ],
  operatorSkills: [
    {
      operatorId: "o-alice",
      skillId: "s-fork-a",
      expiresAt: null,
      certifiedAt: null,
      signedOffBy: null,
    },
  ],
};

function planFrom(csv: string) {
  const table = parseCsvTable(csv);
  return planCertificationImport(table, DATA, BY_ID, detectColumns(table.headerKeys));
}
const only = (p: ReturnType<typeof planFrom>) => p.rows[0].outcome;

describe("detectColumns", () => {
  it("C1: maps the five fields from their aliases", () => {
    const m = detectColumns(["employee ref", "training", "signed off by", "certified", "expiry"]);
    expect(m).toEqual({
      employeeRef: "employee ref",
      training: "training",
      signedOffBy: "signed off by",
      certifiedAt: "certified",
      expiresAt: "expiry",
    });
  });
  it("C2: names the required columns absent", () => {
    const p = planFrom("foo,bar\n1,2");
    expect([...p.missingRequired]).toEqual(["employee ref", "training"]);
  });
});

describe("resolving the person and the training", () => {
  it("R1: a held training -> UPDATE (Alice already has Forklift)", () => {
    const o = only(planFrom("employee ref,training,signed off by\nEMP-1,Forklift,Jo"));
    expect(o.kind).toBe("update");
    expect(o.kind !== "error" && [o.operatorId, o.skillId, o.signedOffBy]).toEqual([
      "o-alice",
      "s-fork-a",
      "Jo",
    ]);
  });
  it("R2: an unheld training on the person's plant -> INSERT (Bob gets Plant B Forklift)", () => {
    const o = only(planFrom("employee ref,training\nEMP-2,Forklift"));
    expect(o.kind).toBe("insert");
    expect(o.kind !== "error" && [o.operatorId, o.skillId]).toEqual(["o-bob", "s-fork-b"]);
  });
  it("R3 ⭐: the training is matched ON THE PERSON'S BRANCH — Alice gets the Line 1 Welding", () => {
    // Welding is owned by Line 1 (under Plant A). Alice is Plant-A-wide, so the
    // Line-1 training is comparable (below her) and applies to her.
    const o = only(planFrom("employee ref,training\nEMP-1,Welding"));
    expect(o.kind).toBe("insert");
    expect(o.kind !== "error" && o.skillId).toBe("s-weld-l1");
  });
  it("R4: Bob CANNOT get Welding — it is on Plant A's branch, not his", () => {
    const o = only(planFrom("employee ref,training\nEMP-2,Welding"));
    expect(o.kind).toBe("error");
    expect(o.kind === "error" && o.messages.join(" ")).toContain("this person's plant");
  });
  it("R5: an unknown employee ref is refused", () => {
    const o = only(planFrom("employee ref,training\nEMP-NOPE,Forklift"));
    expect(o.kind === "error" && o.messages.join(" ")).toContain("no person with employee ref");
  });
  it("R6 ⭐: an AMBIGUOUS employee ref (two people) is refused, not guessed", () => {
    const o = only(planFrom("employee ref,training\nEMP-DUP,Forklift"));
    expect(o.kind === "error" && o.messages.join(" ")).toContain("matches 2 people");
  });
  it("R7: an unknown training name is refused", () => {
    const o = only(planFrom("employee ref,training\nEMP-1,Crane"));
    expect(o.kind === "error" && o.messages.join(" ")).toContain('no training named "Crane"');
  });
});

describe("the record fields", () => {
  it("D1: a valid expiry and certified date are carried through", () => {
    const o = only(
      planFrom("employee ref,training,certified,expiry\nEMP-2,Forklift,2026-01-15,2027-06-30"),
    );
    expect(o.kind !== "error" && [o.certifiedAt, o.expiresAt]).toEqual([
      "2026-01-15",
      "2027-06-30",
    ]);
  });
  it("D2: a blank expiry is null (never expires), not an error", () => {
    const o = only(planFrom("employee ref,training,expiry\nEMP-2,Forklift,"));
    expect(o.kind !== "error" && o.expiresAt).toBe(null);
  });
  it("D3 ⭐: a malformed date is refused — no silent bad date", () => {
    const o = only(planFrom("employee ref,training,expiry\nEMP-2,Forklift,30/06/2027"));
    expect(o.kind === "error" && o.messages.join(" ")).toContain("YYYY-MM-DD");
  });
  it("D4: an impossible date (2026-13-40) is refused", () => {
    const o = only(planFrom("employee ref,training,expiry\nEMP-2,Forklift,2026-13-40"));
    expect(o.kind).toBe("error");
  });
});

describe("within-file duplicates and counts", () => {
  it("V1: the same person+training on two rows are BOTH errors", () => {
    const p = planFrom("employee ref,training\nEMP-2,Forklift\nEMP-2,Forklift");
    expect(p.rows.every((r) => r.outcome.kind === "error")).toBe(true);
    expect(p.counts.error).toBe(2);
  });
  it("V2: counts tally insert/update/error", () => {
    const p = planFrom("employee ref,training\nEMP-1,Forklift\nEMP-2,Forklift\nEMP-1,Crane");
    expect(p.counts).toEqual({ insert: 1, update: 1, error: 1 });
  });
});

describe("the template", () => {
  it("M1: every template header auto-detects to its field", () => {
    const keys = CERTIFICATION_TEMPLATE.headers.map((h) => h.toLowerCase());
    const m = detectColumns(keys);
    expect([m.employeeRef, m.training, m.signedOffBy, m.certifiedAt, m.expiresAt]).toEqual(keys);
    expect(CERTIFICATION_TEMPLATE.legend.map((l) => l.column)).toEqual([
      ...CERTIFICATION_TEMPLATE.headers,
    ]);
  });
});
