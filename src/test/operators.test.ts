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
 *
 * ---------------------------------------------------------------------------
 * ⭐ WHO BELONGS WHERE, WHICH IS NOW HALF THE ANSWER. Ana and Bob belong to
 * PLANT 1, so every cell under it is their own area — which is why the whole
 * W block above kept its answers when the area rule was mirrored.
 *
 * ⭐⭐ CARA BELONGS TO LINE A, AND SHE IS THE DEFECT, REPRODUCED. Two places
 * in her own area (Cell 1 and Cell 2), Cell 3 outside it under Line B, and no
 * tickets at all: *"0 of 2 places in their own area"*. That is the same shape
 * as the screen the maintainer measured, which said **"12 of 18 places"** and
 * ticked twelve cells the database refuses. A3 and S3 are that case.
 *
 * ⚠️ A FIXTURE WHERE EVERY OPERATOR BELONGS TO THE ROOT CANNOT TELL "reads
 * the owner" FROM "ignores the owner" — rule 3g. Cara is what keeps the A
 * block from being uniformly `inside`, exactly as `history.test.ts` holds a
 * live product AND a deleted one on purpose.
 */
import { expect, it } from "vitest";
import {
  areaStandingFor,
  describeSkillNameClash,
  effectiveRequirements,
  findExistingSkillByName,
  formatDay,
  operatorRows,
  placeVerdict,
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

// ⭐ 0028 / D108: these were all `siteNodeId: null` — company-wide trainings.
// There is no such row now, so they belong to the plant. `describeSkillNameClash`
// lost the branch that told the two apart; see its comment.
const SKILLS: readonly SkillLike[] = [
  { id: SAFETY, name: "Safety Induction", siteNodeId: PLANT },
  { id: FORKLIFT, name: "Forklift", siteNodeId: PLANT },
  { id: WELDING, name: "Welding", siteNodeId: PLANT },
  { id: FIRST_AID, name: "First Aid", siteNodeId: PLANT },
];

const ana: OperatorLike = {
  id: ANA,
  displayName: "Ana Silva",
  employeeRef: "E-1001",
  active: true,
  siteNodeId: PLANT,
};
const bob: OperatorLike = {
  id: BOB,
  displayName: "bob jones",
  employeeRef: null,
  active: true,
  siteNodeId: PLANT,
};
const cara: OperatorLike = {
  id: CARA,
  displayName: "Cara Lin",
  employeeRef: "E-1003",
  active: false,
  siteNodeId: LINE_A,
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
      label: "",
      name: "",
      active: false,
      // The sentinel answers "no" to everything and "cannot tell" about the
      // area — a missing place must never read as a tick or as `inside`.
      area: "unknown" as const,
      qualified: false,
      eligible: false,
      missing: [],
      expiring: [],
      unnamed: 0,
      complete: false,
      reasons: [],
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
  const lapsed = [
    { operatorId: ANA, skillId: SAFETY, expiresAt: null },
    { operatorId: ANA, skillId: FORKLIFT, expiresAt: "2026-01-01" },
  ];
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
  expect(p.reasons[0]).toBe("the places above this one could not be read, so this is not a yes");
});

it("W18: an ancestor cycle is a cross, not a hang and not a tick", () => {
  const p = place(workPlacesFor(ana, input(), TODAY), LOOP_A);
  expect(p.eligible).toBe(false);
});

it("W19: an expiry that is not a readable day is a cross, not a pass", () => {
  const junk = [
    { operatorId: ANA, skillId: SAFETY, expiresAt: null },
    { operatorId: ANA, skillId: FORKLIFT, expiresAt: "not-a-date" },
  ];
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
  expect(place(workPlacesFor(ana, input(), TODAY), CELL_1).label).toBe("Plant 1 › Line A › Cell 1");
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
    input({
      operatorSkills: [...ANA_TICKETS, { operatorId: BOB, skillId: FORKLIFT, expiresAt: null }],
    }),
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
 * The AREA rule — `app_guard_assignment_scope` (0028 / D109), mirrored.
 *
 * ⭐⭐ THIS BLOCK EXISTS BECAUSE THE MODULE ANSWERED "where can this person
 * work" ON TRAININGS ALONE. `OperatorLike.siteNodeId` was declared, carried a
 * comment citing D109, and was never read — so the screen ticked every cell in
 * every plant a person's tickets covered. A stale PERMISSION: the client
 * showing what the server refuses, which is the direction that produces a
 * screen looking like it works. Every case below is one the old code passed
 * with a green tick it had not earned.
 * =========================================================================== */

it("A1: a person owned by their line can work in the cells under it", () => {
  const p = place(workPlacesFor(cara, input(), TODAY), CELL_1);
  expect(p.area).toBe("inside");
});

it("A2: and the same person is OUTSIDE a cell under the sibling line", () => {
  const p = place(workPlacesFor(cara, input(), TODAY), CELL_3);
  expect(p.area).toBe("outside");
});

it("A3 ⭐: the defect — a place outside their area is NEVER a tick, however complete the tickets", () => {
  // Ana holds every ticket Cell 3 could ask for; the only requirement there is
  // PHANTOM, so make it readable and held so that TRAININGS alone say yes.
  const ana3 = { ...ana, siteNodeId: LINE_A };
  const held = [...ANA_TICKETS, { operatorId: ANA, skillId: PHANTOM, expiresAt: null }];
  const p = place(
    workPlacesFor(
      ana3,
      input({
        operatorSkills: held,
        skills: [...SKILLS, { id: PHANTOM, name: "Phantom", siteNodeId: PLANT }],
      }),
      TODAY,
    ),
    CELL_3,
  );
  expect(p.qualified).toBe(true); // the trainings say yes — this is the old answer
  expect(p.area).toBe("outside"); // and the server says no
  expect(p.eligible).toBe(false); // so the screen must not tick it
});

it("A4: the training answer is kept beside the area one, not swallowed by it", () => {
  // Cell 3 requires PHANTOM, which Cara does not hold: outside AND unqualified.
  const p = place(workPlacesFor(cara, input(), TODAY), CELL_3);
  expect(p.area).toBe("outside");
  expect(p.qualified).toBe(false);
  expect(p.unnamed).toBe(1);
});

it("A5: the owner node itself is inside — `<@` is reflexive (scope.ts, case S9)", () => {
  const owned = { ...ana, siteNodeId: CELL_2 };
  expect(place(workPlacesFor(owned, input(), TODAY), CELL_2).area).toBe("inside");
});

it("A6: a person owned by the root is inside every cell beneath it", () => {
  const places = workPlacesFor(ana, input(), TODAY);
  expect(place(places, CELL_1).area).toBe("inside");
  expect(place(places, CELL_2).area).toBe("inside");
  expect(place(places, CELL_3).area).toBe("inside");
});

it("A7: the outside place says what it would take, rather than sitting there unexplained", () => {
  const p = place(workPlacesFor(cara, input(), TODAY), CELL_3);
  expect(p.reasons).toContain("not from this area — needs a recorded reason");
});

it("A8: and the area sentence comes FIRST — it is what decides the mark on the row", () => {
  const p = place(workPlacesFor(cara, input(), TODAY), CELL_3);
  expect(p.reasons[0]).toBe("not from this area — needs a recorded reason");
});

it("A9: a broken ancestor chain is UNKNOWN, never inside", () => {
  expect(place(workPlacesFor(ana, input(), TODAY), ORPHAN).area).toBe("unknown");
});

it("A10: an ancestor cycle is unknown too, not a hang and not an inside", () => {
  expect(place(workPlacesFor(ana, input(), TODAY), LOOP_A).area).toBe("unknown");
});

it("A11: an unknown area says nothing extra — the broken-chain sentence already said it", () => {
  const p = place(workPlacesFor(ana, input(), TODAY), ORPHAN);
  expect(p.reasons).not.toContain("not from this area — needs a recorded reason");
  expect(p.reasons[0]).toBe("the places above this one could not be read, so this is not a yes");
});

it("A12: unknown IMPLIES an incomplete requirement chain — it is the same walk", () => {
  // The invariant `areaStandingFor` is written against: the only two ways the
  // area walk ends early are the two that stop `effectiveRequirements`
  // reaching a root. If this ever fails, an unknown area has lost its sentence.
  for (const p of workPlacesFor(ana, input(), TODAY)) {
    if (p.area === "unknown") expect(p.complete).toBe(false);
  }
  expect(workPlacesFor(ana, input(), TODAY).some((p) => p.area === "unknown")).toBe(true);
});

it("A13: and the converse does NOT hold — an owner below a break is a confident inside", () => {
  // Orphan Cell's parent is not in the array, so its chain is incomplete; a
  // person owned BY Orphan Cell is still definitely inside it.
  const p = place(workPlacesFor({ ...ana, siteNodeId: ORPHAN }, input(), TODAY), ORPHAN);
  expect(p.complete).toBe(false);
  expect(p.area).toBe("inside");
});

it("A14: areaStandingFor walks the parent chain, not the string — a sibling is not an ancestor", () => {
  const byId = new Map(NODES.map((n) => [n.id, n]));
  const cell3 = NODES.find((n) => n.id === CELL_3) as NodeLike;
  expect(areaStandingFor(cell3, LINE_B, byId)).toBe("inside");
  expect(areaStandingFor(cell3, LINE_A, byId)).toBe("outside");
  expect(areaStandingFor(cell3, PLANT, byId)).toBe("inside");
});

it("A15: an owner this reader cannot see at all is outside, never inside", () => {
  // `NOWHERE` is not in `nodes`. The walk reaches the root without meeting it,
  // which is a confident "outside" — and never a tick.
  const stranger = { ...ana, siteNodeId: NOWHERE };
  const p = place(workPlacesFor(stranger, input(), TODAY), CELL_1);
  expect(p.area).toBe("outside");
  expect(p.eligible).toBe(false);
});

/* ===========================================================================
 * placeVerdict — the three states the screen draws.
 * =========================================================================== */

it("Q1: inside their area and qualified reads as 'can work here'", () => {
  expect(placeVerdict(place(workPlacesFor(ana, input(), TODAY), CELL_1))).toBe("can-work");
});

it("Q2: inside their area without the ticket is a capability answer, not an area one", () => {
  expect(placeVerdict(place(workPlacesFor(bob, input(), TODAY), CELL_2))).toBe("missing-training");
});

it("Q3: outside their area is the area answer even when the trainings say yes", () => {
  const p = place(workPlacesFor({ ...ana, siteNodeId: LINE_A }, input(), TODAY), CELL_3);
  expect(placeVerdict(p)).toBe("outside-area");
});

it("Q4: an area that could not be resolved reads as outside, never as can-work", () => {
  expect(placeVerdict(place(workPlacesFor(ana, input(), TODAY), ORPHAN))).toBe("outside-area");
});

it("Q5: outside AND untrained is one mark and two sentences — two decisions, not one", () => {
  const p = place(workPlacesFor(cara, input(), TODAY), CELL_3);
  expect(placeVerdict(p)).toBe("outside-area");
  expect(p.reasons).toContain("not from this area — needs a recorded reason");
  expect(p.reasons).toContain("1 required ticket could not be read");
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

it("S3 ⭐: the count line's denominator is their OWN AREA — Cara is '0 of 2', not '0 of 6'", () => {
  // The maintainer's screen said "12 of 18 places" for somebody whose own line
  // held two, both of them refusals. This is that sentence, made true.
  const s = summarisePlaces(workPlacesFor(cara, input(), TODAY));
  expect(s.ownArea).toBe(2); // Cell 1 and Cell 2, under Line A
  expect(s.eligible).toBe(0); // she holds no tickets at all
  expect(s.total).toBe(6); // and the other four are still listed below
});

it("S4: everywhere else is counted, not hidden — D113 means it is reachable", () => {
  const s = summarisePlaces(workPlacesFor(cara, input(), TODAY));
  expect(s.outsideArea).toBe(4); // Cell 3, Orphan Cell, and both halves of the loop
  expect(s.ownArea + s.outsideArea).toBe(s.total);
});

it("S5: an area that could not be resolved counts as outside, never towards their own", () => {
  // Orphan Cell and the two loop halves are `unknown`. Counting an unproven
  // "inside" would put a denominator in front of a reader that the server
  // will not honour.
  const s = summarisePlaces(workPlacesFor(ana, input(), TODAY));
  expect(s.ownArea).toBe(3); // Cell 1, Cell 2, Cell 3 — Ana belongs to the plant
  expect(s.outsideArea).toBe(3);
});

/* ===========================================================================
 * operatorRows
 * =========================================================================== */

it("O1: deactivated people are hidden by default — deactivate is the main action", () => {
  const ids = operatorRows([ana, bob, cara], ANA_TICKETS).map((r) => r.id);
  expect(ids).not.toContain(CARA);
});

it("O2: and shown when asked for", () => {
  const ids = operatorRows([ana, bob, cara], ANA_TICKETS, { includeInactive: true }).map(
    (r) => r.id,
  );
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
  // ⭐ "site-owned", not "company-wide": 0028/D108 removed the state and the
  // word. `describeSkillNameClash` has one arm now — see its comment.
  expect(clash === null ? "" : describeSkillNameClash(clash)).toBe(
    "There is already a site-owned Forklift — use that one.",
  );
});

it("N6: the loose clash leaves creating available, because it may be a different ticket", () => {
  const clash = findExistingSkillByName(SKILLS, "FORKLIFT");
  expect(clash === null ? "" : describeSkillNameClash(clash)).toContain(
    "unless this is a different ticket",
  );
});

/* ===========================================================================
 * ticketsFor, formatDay
 * =========================================================================== */

/* Cases D1-D3 tested `deletePrecheck` and were deleted with it in 0029: the
 * cascade it existed to anticipate now removes the tickets, so the rule it
 * enforced refused something the database allows. `56_`'s D19 measures the new
 * behaviour end to end, and `deletion.test.ts`'s K9/K10 cover the counting the
 * dialog does in its place.
 */
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
  const held = [...ANA_TICKETS, { operatorId: ANA, skillId: PHANTOM, expiresAt: "2026-08-01" }];
  const places = workPlacesFor(ana, input({ operatorSkills: held }), TODAY);
  expect(place(places, CELL_3).unnamed).toBeGreaterThan(0);
});

it("V3 ⭐: a clash names the ticket as site-owned — the word that survived 0028", () => {
  // Written when every skill in the fixture had `siteNodeId: null` and the
  // other arm of the scope ternary had never once been evaluated. D108 then
  // deleted the arm this case was added to reach, which leaves the message with
  // no information in it — the real fix is to name the OWNER, and that is
  // recorded on `SkillLike` rather than done here, because a training's name is
  // still unique per ORG and that is the thing actually pulling wrong.
  const owned = { id: WELDING, name: "Welding", siteNodeId: PLANT };
  expect(describeSkillNameClash({ skill: owned, exact: true })).toBe(
    "There is already a site-owned Welding — use that one.",
  );
});
