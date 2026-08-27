/**
 * Acceptance suite for `src/features/admin/lib/operators.ts` — the client
 * mirror of `check_eligibility`.
 *
 * A VITEST suite, because `npm run test` is what guards this permanently and
 * vitest collects every `src/test/*.test.ts`.
 *
 * One plain `it()` per case, deliberately: `it.each` reports a table row, and
 * what a failure here needs to say is WHICH RULE OF THE MIRROR broke.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SUITE IS ACTUALLY DEFENDING. The module under test answers "can
 * this person work here" on the client, while the SERVER —
 * `check_eligibility` (`20260821000009_api_surface.sql:341-378`) — is the
 * authority and is re-asked at assignment time. The invariant is one-way:
 * a TICK here must be a tick there. So the bulk of the cases below are the
 * ones where the module could be tempted into a tick it has not earned:
 * a requirement inherited from a node it did not look at, a chain it could
 * not walk, a skill row it could not read, a date it could not compare.
 *
 * ---------------------------------------------------------------------------
 * THE FIXTURE — one company, drawn once, so every case reasons about the
 * same tree:
 *
 *   Plant 1                    requires Safety Induction   (root, not schedulable)
 *   ├─ Line A                  requires Forklift           (not schedulable)
 *   │   ├─ Cell 1              requires Welding            SCHEDULABLE
 *   │   └─ Cell 2              —                           SCHEDULABLE
 *   └─ Line B                  requires PHANTOM            (not schedulable)
 *       └─ Cell 3              —                           SCHEDULABLE
 *   Orphan Cell   parent points at a node that is not here SCHEDULABLE
 *   Loop A ⇄ Loop B            each other's parent         SCHEDULABLE
 *
 * PHANTOM is a requirement whose `skills` row is NOT in the array — the
 * shape a site admin sees when a skill is not readable to them. The server
 * counts it and cannot name it; so must this.
 *
 * Ana holds Safety Induction (no expiry), Forklift (expires 3 Sep 2026) and
 * Welding (expires 31 Dec 2026). Bob holds nothing. Cara is deactivated.
 */
import { expect, it } from "vitest";
import {
  deletePrecheck,
  describeSkillNameClash,
  effectiveRequirements,
  findExistingSkillByName,
  formatDay,
  operatorRows,
  summarisePlaces,
  ticketsFor,
  validateOperatorDraft,
  workPlacesFor,
  type NodeLike,
  type OperatorLike,
  type OperatorSkillLike,
  type RequirementLike,
  type SkillLike,
  type WorkPlace,
  type WorkPlaceInput,
} from "../features/admin/lib/operators.ts";

const L_PLANT = "10000000-0000-0000-0000-000000000001";
const L_LINE = "10000000-0000-0000-0000-000000000002";
const L_CELL = "10000000-0000-0000-0000-000000000003";

const PLANT = "20000000-0000-0000-0000-000000000001";
const LINE_A = "20000000-0000-0000-0000-000000000002";
const LINE_B = "20000000-0000-0000-0000-000000000003";
const CELL_1 = "20000000-0000-0000-0000-000000000004";
const CELL_2 = "20000000-0000-0000-0000-000000000005";
const CELL_3 = "20000000-0000-0000-0000-000000000006";
const ORPHAN = "20000000-0000-0000-0000-000000000007";
const LOOP_A = "20000000-0000-0000-0000-000000000008";
const LOOP_B = "20000000-0000-0000-0000-000000000009";
const NOWHERE = "20000000-0000-0000-0000-0000000000ff";

const SAFETY = "30000000-0000-0000-0000-000000000001";
const FORKLIFT = "30000000-0000-0000-0000-000000000002";
const WELDING = "30000000-0000-0000-0000-000000000003";
const PHANTOM = "30000000-0000-0000-0000-000000000004";
const FIRST_AID = "30000000-0000-0000-0000-000000000005";

const ANA = "40000000-0000-0000-0000-000000000001";
const BOB = "40000000-0000-0000-0000-000000000002";
const CARA = "40000000-0000-0000-0000-000000000003";

const NODES: readonly NodeLike[] = [
  { id: PLANT, parentId: null, levelId: L_PLANT, name: "Plant 1", active: true },
  { id: LINE_A, parentId: PLANT, levelId: L_LINE, name: "Line A", active: true },
  { id: LINE_B, parentId: PLANT, levelId: L_LINE, name: "Line B", active: true },
  { id: CELL_1, parentId: LINE_A, levelId: L_CELL, name: "Cell 1", active: true },
  { id: CELL_2, parentId: LINE_A, levelId: L_CELL, name: "Cell 2", active: true },
  { id: CELL_3, parentId: LINE_B, levelId: L_CELL, name: "Cell 3", active: true },
  { id: ORPHAN, parentId: NOWHERE, levelId: L_CELL, name: "Orphan Cell", active: true },
  { id: LOOP_A, parentId: LOOP_B, levelId: L_CELL, name: "Loop A", active: true },
  { id: LOOP_B, parentId: LOOP_A, levelId: L_CELL, name: "Loop B", active: false },
];

const LEVELS = [
  { id: L_PLANT, isSchedulable: false },
  { id: L_LINE, isSchedulable: false },
  { id: L_CELL, isSchedulable: true },
];

const REQUIREMENTS: readonly RequirementLike[] = [
  { nodeId: PLANT, skillId: SAFETY },
  { nodeId: LINE_A, skillId: FORKLIFT },
  { nodeId: CELL_1, skillId: WELDING },
  { nodeId: LINE_B, skillId: PHANTOM },
];

const SKILLS: readonly SkillLike[] = [
  { id: SAFETY, name: "Safety Induction", siteNodeId: null },
  { id: FORKLIFT, name: "Forklift", siteNodeId: null },
  { id: WELDING, name: "Welding", siteNodeId: null },
  { id: FIRST_AID, name: "First Aid", siteNodeId: null },
];

const ana: OperatorLike = {
  id: ANA, displayName: "Ana Silva", employeeRef: "E-1001", active: true, siteNodeId: null,
};
const bob: OperatorLike = {
  id: BOB, displayName: "bob jones", employeeRef: null, active: true, siteNodeId: PLANT,
};
const cara: OperatorLike = {
  id: CARA, displayName: "Cara Lin", employeeRef: "E-1003", active: false, siteNodeId: null,
};

const ANA_TICKETS: readonly OperatorSkillLike[] = [
  { operatorId: ANA, skillId: SAFETY, expiresAt: null },
  { operatorId: ANA, skillId: FORKLIFT, expiresAt: "2026-09-03" },
  { operatorId: ANA, skillId: WELDING, expiresAt: "2026-12-31" },
  // Bob's, sitting in the same array — nothing may leak across operators.
  { operatorId: BOB, skillId: SAFETY, expiresAt: null },
];

const TODAY = "2026-08-27";

function input(over: Partial<WorkPlaceInput> = {}): WorkPlaceInput {
  return {
    nodes: NODES,
    levels: LEVELS,
    requirements: REQUIREMENTS,
    skills: SKILLS,
    operatorSkills: ANA_TICKETS,
    ...over,
  };
}

function place(places: readonly WorkPlace[], nodeId: string): WorkPlace {
  const found = places.find((p) => p.nodeId === nodeId);
  // A distinguishable SENTINEL rather than `.find(...)!` — a fixture accessor
  // that throws scores the case as CRASHED instead of naming what is missing.
  return (
    found ?? {
      nodeId: `NOT-IN-RESULT:${nodeId}`,
      label: "", name: "", active: false, eligible: false,
      missing: [], expiring: [], unnamed: 0, complete: false, reasons: [],
    }
  );
}

const names = (xs: readonly { name: string }[]): string[] => xs.map((x) => x.name).sort();

/* ===========================================================================
 * effectiveRequirements — the ancestor union.
 * =========================================================================== */

it("E1: a requirement on the cell itself is required at that cell", () => {
  const req = effectiveRequirements(NODES, REQUIREMENTS).get(CELL_1);
  expect(req?.skillIds).toContain(WELDING);
});

it("E2: a requirement on the line inherits down to every cell under it", () => {
  const map = effectiveRequirements(NODES, REQUIREMENTS);
  expect(map.get(CELL_1)?.skillIds).toContain(FORKLIFT);
  expect(map.get(CELL_2)?.skillIds).toContain(FORKLIFT);
});

it("E3: a requirement on the root reaches the whole company", () => {
  const map = effectiveRequirements(NODES, REQUIREMENTS);
  expect(map.get(CELL_3)?.skillIds).toContain(SAFETY);
});

it("E4: a requirement on the cell does NOT leak up to its line", () => {
  const req = effectiveRequirements(NODES, REQUIREMENTS).get(LINE_A);
  expect(req?.skillIds).not.toContain(WELDING);
});

it("E5: a requirement on a sibling line does not reach this cell", () => {
  const req = effectiveRequirements(NODES, REQUIREMENTS).get(CELL_1);
  expect(req?.skillIds).not.toContain(PHANTOM);
});

it("E6: the same skill required twice up the chain is listed once (DISTINCT)", () => {
  const doubled = [...REQUIREMENTS, { nodeId: CELL_1, skillId: FORKLIFT }];
  const ids = effectiveRequirements(NODES, doubled).get(CELL_1)?.skillIds ?? [];
  expect(ids.filter((id) => id === FORKLIFT)).toHaveLength(1);
});

it("E7: a place with nothing required anywhere above it gets an empty list", () => {
  const map = effectiveRequirements(NODES, []);
  expect(map.get(CELL_1)?.skillIds).toEqual([]);
  expect(map.get(CELL_1)?.complete).toBe(true);
});

it("E8: a chain that reaches a root is marked complete", () => {
  expect(effectiveRequirements(NODES, REQUIREMENTS).get(CELL_1)?.complete).toBe(true);
});

it("E9: a parent id with no node beside it marks the chain INCOMPLETE", () => {
  expect(effectiveRequirements(NODES, REQUIREMENTS).get(ORPHAN)?.complete).toBe(false);
});

it("E10: an ancestor cycle marks the chain incomplete instead of hanging", () => {
  expect(effectiveRequirements(NODES, REQUIREMENTS).get(LOOP_A)?.complete).toBe(false);
});

it("E11: a requirement attached to a node nobody can see is simply not applicable", () => {
  const stray = [...REQUIREMENTS, { nodeId: NOWHERE, skillId: FIRST_AID }];
  expect(effectiveRequirements(NODES, stray).get(CELL_1)?.skillIds).not.toContain(FIRST_AID);
});

it("E12: every node given gets an entry, including the ones that are not places", () => {
  expect(effectiveRequirements(NODES, REQUIREMENTS).size).toBe(NODES.length);
});

/* ===========================================================================
 * workPlacesFor — the mirror.
 * =========================================================================== */

it("W1: only SCHEDULABLE nodes are offered as places", () => {
  const ids = workPlacesFor(ana, input(), TODAY).map((p) => p.nodeId);
  expect(ids).not.toContain(PLANT);
  expect(ids).not.toContain(LINE_A);
  expect(ids).toContain(CELL_1);
});

it("W2: with no requirements at all, every place is a tick", () => {
  const places = workPlacesFor(bob, input({ requirements: [] }), TODAY);
  expect(places.filter((p) => p.complete).every((p) => p.eligible)).toBe(true);
});

it("W3: holding every required ticket is a tick", () => {
  expect(place(workPlacesFor(ana, input(), TODAY), CELL_1).eligible).toBe(true);
});

it("W4: an INHERITED requirement that is not held is a cross naming the ticket", () => {
  const p = place(workPlacesFor(bob, input(), TODAY), CELL_2);
  expect(p.eligible).toBe(false);
  expect(names(p.missing)).toEqual(["Forklift"]);
});

it("W5: a requirement on the CELL ITSELF that is not held is a cross too", () => {
  const p = place(workPlacesFor(bob, input(), TODAY), CELL_1);
  expect(names(p.missing)).toEqual(["Forklift", "Welding"]);
});

it("W6: the cross reads 'missing <ticket>'", () => {
  const p = place(workPlacesFor(bob, input(), TODAY), CELL_2);
  expect(p.reasons).toContain("missing Forklift");
});

it("W7: a ticket expiring AFTER the window's upper bound is still a tick", () => {
  // Forklift lapses 3 Sep; the window asked about ends 27 Aug.
  expect(place(workPlacesFor(ana, input(), TODAY), CELL_2).eligible).toBe(true);
});

it("W8: a ticket expiring BEFORE the window's upper bound is a cross", () => {
  const p = place(workPlacesFor(ana, input(), "2026-09-04"), CELL_2);
  expect(p.eligible).toBe(false);
  expect(names(p.expiring)).toEqual(["Forklift"]);
});

it("W9: the expiry cross names the day, as 'Forklift expires 3 Sep 2026'", () => {
  const p = place(workPlacesFor(ana, input(), "2026-09-04"), CELL_2);
  expect(p.reasons).toContain("Forklift expires 3 Sep 2026");
});

it("W10: a ticket lapsing ON the last day of the window is NOT expiring (`<`, not `<=`)", () => {
  // The server's clause is `expires_at < upper(p_timerange)::date`.
  expect(place(workPlacesFor(ana, input(), "2026-09-03"), CELL_2).eligible).toBe(true);
});

it("W11: an ALREADY-expired ticket is reported as expiring, never as missing", () => {
  const lapsed = [{ operatorId: ANA, skillId: SAFETY, expiresAt: null },
                  { operatorId: ANA, skillId: FORKLIFT, expiresAt: "2026-01-01" }];
  const p = place(workPlacesFor(ana, input({ operatorSkills: lapsed }), TODAY), CELL_2);
  expect(names(p.missing)).toEqual([]);
  expect(names(p.expiring)).toEqual(["Forklift"]);
});

it("W12: a ticket with no expiry never lapses, however far the window runs", () => {
  const p = place(workPlacesFor(ana, input(), "2099-01-01"), CELL_2);
  expect(names(p.expiring)).toEqual(["Forklift"]);
  expect(p.expiring.some((e) => e.skillId === SAFETY)).toBe(false);
});

it("W13: a ticket nobody requires changes nothing", () => {
  const extra = [...ANA_TICKETS, { operatorId: ANA, skillId: FIRST_AID, expiresAt: "2020-01-01" }];
  const p = place(workPlacesFor(ana, input({ operatorSkills: extra }), TODAY), CELL_2);
  expect(p.eligible).toBe(true);
  expect(p.reasons).toEqual([]);
});

it("W14: a required skill whose row cannot be read COUNTS but is not named", () => {
  // Line B requires PHANTOM, which has no row in `skills` — exactly what the
  // server does when RLS hides the skill: `eligible:false`, empty list.
  const p = place(workPlacesFor(ana, input(), TODAY), CELL_3);
  expect(p.eligible).toBe(false);
  expect(p.missing).toEqual([]);
  expect(p.unnamed).toBe(1);
});

it("W15: and it says so, rather than leaving the cross unexplained", () => {
  const p = place(workPlacesFor(ana, input(), TODAY), CELL_3);
  expect(p.reasons).toContain("1 required ticket could not be read");
});

it("W16: a broken ancestor chain is a CROSS, never a tick", () => {
  const p = place(workPlacesFor(ana, input(), TODAY), ORPHAN);
  expect(p.complete).toBe(false);
  expect(p.eligible).toBe(false);
});

it("W17: and the cross for a broken chain says why", () => {
  const p = place(workPlacesFor(ana, input(), TODAY), ORPHAN);
  expect(p.reasons[0]).toBe(
    "the places above this one could not be read, so this is not a yes",
  );
});

it("W18: an ancestor cycle is a cross, not a hang and not a tick", () => {
  const p = place(workPlacesFor(ana, input(), TODAY), LOOP_A);
  expect(p.eligible).toBe(false);
});

it("W19: an expiry that is not a readable day is a cross, not a pass", () => {
  const junk = [{ operatorId: ANA, skillId: SAFETY, expiresAt: null },
                { operatorId: ANA, skillId: FORKLIFT, expiresAt: "not-a-date" }];
  const p = place(workPlacesFor(ana, input({ operatorSkills: junk }), TODAY), CELL_2);
  expect(p.eligible).toBe(false);
  expect(p.unnamed).toBe(1);
});

it("W20: an unreadable `asOf` makes every dated ticket a cross rather than a pass", () => {
  const p = place(workPlacesFor(ana, input(), "whenever"), CELL_2);
  expect(p.eligible).toBe(false);
});

it("W21: one operator's tickets never count for another", () => {
  // Bob holds only Safety Induction; Ana's rows sit in the same array.
  const p = place(workPlacesFor(bob, input(), TODAY), CELL_2);
  expect(names(p.missing)).toEqual(["Forklift"]);
});

it("W22: the label is the root-to-leaf path", () => {
  expect(place(workPlacesFor(ana, input(), TODAY), CELL_1).label).toBe(
    "Plant 1 › Line A › Cell 1",
  );
});

it("W23: a label whose chain broke is marked, not silently shortened", () => {
  expect(place(workPlacesFor(ana, input(), TODAY), ORPHAN).label).toBe("… › Orphan Cell");
});

it("W24: an inactive place is still listed, carrying its own active flag", () => {
  const p = place(workPlacesFor(ana, input(), TODAY), LOOP_B);
  expect(p.nodeId).toBe(LOOP_B);
  expect(p.active).toBe(false);
});

it("W25: granting the one missing ticket turns SEVERAL crosses green at once", () => {
  const before = workPlacesFor(bob, input(), TODAY);
  const after = workPlacesFor(
    bob,
    input({ operatorSkills: [...ANA_TICKETS, { operatorId: BOB, skillId: FORKLIFT, expiresAt: null }] }),
    TODAY,
  );
  expect(place(before, CELL_2).eligible).toBe(false);
  expect(place(after, CELL_2).eligible).toBe(true);
  // Cell 1 still needs Welding, so this is a real fan-out and not a blanket pass.
  expect(place(after, CELL_1).eligible).toBe(false);
});

it("W26: places come back in label order", () => {
  const labels = workPlacesFor(ana, input(), TODAY).map((p) => p.label);
  expect(labels).toEqual([...labels].sort());
});

/* ===========================================================================
 * summarisePlaces
 * =========================================================================== */

it("S1: the summary counts ticks and, separately, the crosses it could not explain", () => {
  const s = summarisePlaces(workPlacesFor(ana, input(), TODAY));
  // Six schedulable places: Cell 1-3, Orphan Cell and both halves of the loop.
  expect(s.total).toBe(6);
  expect(s.eligible).toBe(2); // Cell 1 and Cell 2
  // Cell 3 (a requirement it cannot name) plus the three broken chains.
  expect(s.unresolved).toBe(4);
});

it("S2: a fully readable, fully qualified answer reports nothing unresolved", () => {
  const clean = input({
    nodes: NODES.filter((n) => n.id === PLANT || n.id === LINE_A || n.id === CELL_2),
  });
  expect(summarisePlaces(workPlacesFor(ana, clean, TODAY)).unresolved).toBe(0);
});

/* ===========================================================================
 * operatorRows
 * =========================================================================== */

it("O1: deactivated people are hidden by default — deactivate is the main action", () => {
  const ids = operatorRows([ana, bob, cara], ANA_TICKETS).map((r) => r.id);
  expect(ids).not.toContain(CARA);
});

it("O2: and shown when asked for", () => {
  const ids = operatorRows([ana, bob, cara], ANA_TICKETS, { includeInactive: true }).map((r) => r.id);
  expect(ids).toContain(CARA);
});

it("O3: each row carries how many tickets that person holds", () => {
  const rows = operatorRows([ana, bob], ANA_TICKETS);
  expect(rows.find((r) => r.id === ANA)?.ticketCount).toBe(3);
  expect(rows.find((r) => r.id === BOB)?.ticketCount).toBe(1);
});

it("O4: the search box matches the employee reference, not just the name", () => {
  const rows = operatorRows([ana, bob], ANA_TICKETS, { query: "e-1001" });
  expect(rows.map((r) => r.id)).toEqual([ANA]);
});

it("O5: the search box is trimmed and case-insensitive", () => {
  const rows = operatorRows([ana, bob], ANA_TICKETS, { query: "  ANA  " });
  expect(rows.map((r) => r.id)).toEqual([ANA]);
});

it("O6: names sort case-insensitively, so 'bob jones' is not exiled below 'Ana Silva'", () => {
  const rows = operatorRows([bob, ana], ANA_TICKETS);
  expect(rows.map((r) => r.displayName)).toEqual(["Ana Silva", "bob jones"]);
});

/* ===========================================================================
 * validateOperatorDraft
 * =========================================================================== */

it("V1: a whitespace-only name is refused — there is no CHECK and no trim trigger", () => {
  const r = validateOperatorDraft({ displayName: "   ", employeeRef: "" });
  expect(r.ok).toBe(false);
});

it("V2: an accepted name is trimmed before it reaches the column", () => {
  const r = validateOperatorDraft({ displayName: "  Dee Patel  ", employeeRef: "" });
  expect(r.ok === true && r.displayName).toBe("Dee Patel");
});

it("V3: an empty employee reference becomes null, not an empty string", () => {
  const r = validateOperatorDraft({ displayName: "Dee", employeeRef: "   " });
  expect(r.ok === true && r.employeeRef).toBe(null);
});

it("V4: an employee reference is trimmed too", () => {
  const r = validateOperatorDraft({ displayName: "Dee", employeeRef: " E-7 " });
  expect(r.ok === true && r.employeeRef).toBe("E-7");
});

it("V5: someone already called this is a WARNING, not a refusal — no unique constraint exists", () => {
  const r = validateOperatorDraft({ displayName: "ana silva", employeeRef: "" }, [ana, bob]);
  expect(r.ok).toBe(true);
  expect(r.ok === true && r.duplicateNameOf).toBe(ANA);
});

it("V6: editing someone does not report them as a duplicate of themselves", () => {
  const r = validateOperatorDraft({ displayName: "Ana Silva", employeeRef: "" }, [ana, bob], ANA);
  expect(r.ok === true && r.duplicateNameOf).toBe(null);
});

/* ===========================================================================
 * findExistingSkillByName — the clash that is not an error.
 * =========================================================================== */

it("N1: a name that is byte-equal after trimming is an EXACT clash — the insert would be refused", () => {
  const clash = findExistingSkillByName(SKILLS, "  Forklift  ");
  expect(clash?.exact).toBe(true);
  expect(clash?.skill.id).toBe(FORKLIFT);
});

it("N2: a case-only difference is a LOOSE clash — Postgres would allow both rows", () => {
  const clash = findExistingSkillByName(SKILLS, "forklift");
  expect(clash?.exact).toBe(false);
  expect(clash?.skill.id).toBe(FORKLIFT);
});

it("N3: a genuinely new name clashes with nothing", () => {
  expect(findExistingSkillByName(SKILLS, "Crane")).toBe(null);
});

it("N4: an empty name is not treated as a clash with anything", () => {
  expect(findExistingSkillByName(SKILLS, "   ")).toBe(null);
});

it("N5: the exact clash reads as an offer to reuse, never as an error", () => {
  const clash = findExistingSkillByName(SKILLS, "Forklift");
  expect(clash === null ? "" : describeSkillNameClash(clash)).toBe(
    "There is already a company-wide Forklift — use that one.",
  );
});

it("N6: the loose clash leaves creating available, because it may be a different ticket", () => {
  const clash = findExistingSkillByName(SKILLS, "FORKLIFT");
  expect(clash === null ? "" : describeSkillNameClash(clash)).toContain("unless this is a different ticket");
});

/* ===========================================================================
 * deletePrecheck, ticketsFor, formatDay
 * =========================================================================== */

it("D1: someone holding tickets cannot be deleted, and the refusal says what is in the way", () => {
  const r = deletePrecheck(ana, ANA_TICKETS);
  expect(r.allowed).toBe(false);
  expect(r.blockedBy).toContain("3 tickets");
});

it("D2: one ticket is reported in the singular", () => {
  expect(deletePrecheck(bob, ANA_TICKETS).blockedBy).toContain("1 ticket is");
});

it("D3: with nothing visible in the way, delete is offered — assignments are still the server's call", () => {
  expect(deletePrecheck(cara, ANA_TICKETS)).toEqual({ allowed: true, blockedBy: null });
});

it("T1: a ticket whose skill row cannot be read is shown unnamed, never dropped", () => {
  const held = [{ operatorId: ANA, skillId: PHANTOM, expiresAt: null }];
  const tickets = ticketsFor(ana, SKILLS, held, TODAY);
  expect(tickets).toHaveLength(1);
  expect(tickets[0]?.name).toBe("(a ticket you can't see)");
});

it("T2: a ticket already lapsed on the day asked about is marked lapsed", () => {
  const tickets = ticketsFor(ana, SKILLS, ANA_TICKETS, "2026-09-04");
  expect(tickets.find((t) => t.skillId === FORKLIFT)?.lapsed).toBe(true);
  expect(tickets.find((t) => t.skillId === SAFETY)?.lapsed).toBe(false);
});

it("T3: tickets are listed for this person only", () => {
  expect(ticketsFor(bob, SKILLS, ANA_TICKETS, TODAY).map((t) => t.skillId)).toEqual([SAFETY]);
});

it("F1: a day is rendered the way the reason sentence needs it", () => {
  expect(formatDay("2026-09-03")).toBe("3 Sep 2026");
});

it("F2: anything that is not a day comes back untouched rather than as 'Invalid Date'", () => {
  expect(formatDay("sometime")).toBe("sometime");
});

/* ---------------------------------------------------------------------------
   GROUP V — THE THREE BRANCHES THE ADVERSARIAL PASS FOUND UNPINNED (27 Aug).
   Each was written because a deliberate break of that branch went NOT CAUGHT
   by the 66 cases above.
   --------------------------------------------------------------------------- */

it("V1: a place whose parent chain loops is labelled as truncated, not as a root", () => {
  // `truncated = true` in the CYCLE branch could be deleted and nothing failed:
  // W23 covers the missing-parent branch only. Without the marker, "Loop B ›
  // Loop A" reads as a complete path from a site, which it is not.
  const places = workPlacesFor(ana, input(), TODAY);
  expect(place(places, LOOP_A).label.startsWith("… › ")).toBe(true);
});

it("V2: a ticket that has LAPSED and whose skill row is unreadable is counted, not lost", () => {
  // The `unnamed` bump inside the EXPIRING branch could be deleted and nothing
  // failed: W14 covers unnamed-and-MISSING only. A ticket we cannot name and
  // cannot vouch for must still make the place unresolved, or an unreadable
  // row silently becomes a tick.
  const held = [
    ...ANA_TICKETS,
    { operatorId: ANA, skillId: PHANTOM, expiresAt: "2026-08-01" },
  ];
  const places = workPlacesFor(ana, input({ operatorSkills: held }), TODAY);
  expect(place(places, CELL_3).unnamed).toBeGreaterThan(0);
});

it("V3: a clash with a SITE-owned ticket does not claim the ticket is company-wide", () => {
  // Every skill in the fixture had `siteNodeId: null`, so the other arm of the
  // scope ternary had never once been evaluated. Telling someone a ticket is
  // company-wide when it belongs to one site is the difference between "use
  // that one" and a ticket they may not be able to reach.
  const owned = { id: WELDING, name: "Welding", siteNodeId: PLANT };
  expect(describeSkillNameClash({ skill: owned, exact: true })).toBe(
    "There is already a site-owned Welding — use that one.",
  );
});
