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
  placesUnderSameRoot,
  resolveSelectedOperator,
  rootIdFor,
  summarisePlaces,
  ticketsFor,
  validateOperatorDraft,
  workPlacesFor,
  type NodeLike,
  type OperatorLike,
  type OperatorSkillLike,
  type RequirementLike,
  type SkillLike,
  type SkillNameClash,
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
// There is no such row now, so they belong to the plant.
//
// ⚠️ EVERY ONE OF THEM SHARES AN OWNER, WHICH IS FINE FOR THE W/A/S BLOCKS AND
// BLIND FOR THE N BLOCK: an owner-scoped name search and an unscoped one cannot
// disagree on a single-owner fixture. `OTHER_PLANT_SKILLS`, down beside the N
// cases, is the second owner — the same job Cara does for the area rule.
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
      // The sentinel answers "no" to everything and "cannot tell" about both
      // the root and the area — a missing place must never read as a tick, as
      // `inside`, or as belonging to somebody's plant.
      rootId: null,
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
 * HOW FAR THE LIST REACHES — `rootIdFor` and `placesUnderSameRoot`.
 *
 * ⭐⭐ THE MAINTAINER, 31 AUGUST, AFTER SEEING THE THREE STATES: *"I see all
 * plants not just Plant A for him, it does say that he's not from this area
 * for other plants, but those locations should not be visible at all is my
 * point."* A system admin reads every node in the org, so the list was every
 * schedulable cell in the company. **Annotating them was not enough.**
 *
 * ⚠️ THE CUT IS THE ROOT, NOT THE PERSON'S OWN AREA — R5 and R6 are the pair
 * that pins that, and they are the reason the ⚠ state still appears on this
 * screen at all.
 *
 * A SECOND TREE, local to this block: Plant 2 with one cell, so "a different
 * root" is a thing the fixture can express. The shared `NODES` deliberately
 * keeps ONE root, because every case above it reasons about totals.
 * =========================================================================== */

const PLANT_2 = "20000000-0000-0000-0000-0000000000a1";
const CELL_9 = "20000000-0000-0000-0000-0000000000a2";

const TWO_PLANTS: readonly NodeLike[] = [
  ...NODES,
  { id: PLANT_2, parentId: null, levelId: L_PLANT, name: "Plant 2", active: true },
  { id: CELL_9, parentId: PLANT_2, levelId: L_CELL, name: "Cell 9", active: true },
];

const twoPlants = () => input({ nodes: TWO_PLANTS });
const byIdOf = (nodes: readonly NodeLike[]) => new Map(nodes.map((n) => [n.id, n]));

it("R1: a cell reports the root it descends from, however deep it sits", () => {
  expect(rootIdFor(CELL_1, byIdOf(TWO_PLANTS))).toBe(PLANT);
  expect(rootIdFor(CELL_9, byIdOf(TWO_PLANTS))).toBe(PLANT_2);
});

it("R2: a root is its own root, and a node nobody can see has none", () => {
  expect(rootIdFor(PLANT, byIdOf(TWO_PLANTS))).toBe(PLANT);
  expect(rootIdFor(NOWHERE, byIdOf(TWO_PLANTS))).toBe(null);
});

it("R3: a broken chain and a cycle both report NO root, rather than guessing one", () => {
  expect(rootIdFor(ORPHAN, byIdOf(TWO_PLANTS))).toBe(null);
  expect(rootIdFor(LOOP_A, byIdOf(TWO_PLANTS))).toBe(null);
});

it("R4: workPlacesFor still answers about every place it was handed — the trim is elsewhere", () => {
  // ⚠️ The reach rule is PRESENTATION and mirrors no server rule, so it must
  // not be buried inside the function that mirrors the server.
  const ids = workPlacesFor(ana, twoPlants(), TODAY).map((p) => p.nodeId);
  expect(ids).toContain(CELL_9);
  expect(ids).toHaveLength(7);
});

it("R5 ⭐: a person owned by a PLANT sees that plant and no other", () => {
  // Ana belongs to Plant 1. This is every operator's case except the one below.
  const kept = placesUnderSameRoot(
    workPlacesFor(ana, twoPlants(), TODAY),
    ana.siteNodeId,
    byIdOf(TWO_PLANTS),
  );
  expect(kept.map((p) => p.nodeId)).not.toContain(CELL_9);
  expect(kept.map((p) => p.nodeId)).toContain(CELL_1);
});

it("R6 ⭐: a person owned by a LINE sees their whole PLANT, not just their line", () => {
  // Cara belongs to Line A. Cell 3 is under Line B — outside her area, inside
  // her plant — and it MUST survive: that is the ⚠ state, and D113 is why.
  const kept = placesUnderSameRoot(
    workPlacesFor(cara, twoPlants(), TODAY),
    cara.siteNodeId,
    byIdOf(TWO_PLANTS),
  );
  const ids = kept.map((p) => p.nodeId);
  expect(ids).toContain(CELL_1); // her own area
  expect(ids).toContain(CELL_3); // her plant, not her area — the ⚠ row
  expect(ids).not.toContain(CELL_9); // another plant — gone
  expect(place(kept, CELL_3).area).toBe("outside");
});

it("R7: a place whose own root cannot be resolved is KEPT — hiding on uncertainty is invisible", () => {
  const kept = placesUnderSameRoot(
    workPlacesFor(ana, twoPlants(), TODAY),
    ana.siteNodeId,
    byIdOf(TWO_PLANTS),
  );
  const ids = kept.map((p) => p.nodeId);
  expect(ids).toContain(ORPHAN);
  expect(ids).toContain(LOOP_A);
});

it("R8: a person whose OWN root cannot be resolved filters nothing at all", () => {
  const stranger = { ...ana, siteNodeId: NOWHERE };
  const all = workPlacesFor(stranger, twoPlants(), TODAY);
  expect(placesUnderSameRoot(all, stranger.siteNodeId, byIdOf(TWO_PLANTS))).toHaveLength(
    all.length,
  );
});

it("R9: the trim leaves the three states alone — it removes rows, it does not change verdicts", () => {
  const all = workPlacesFor(cara, twoPlants(), TODAY);
  const kept = placesUnderSameRoot(all, cara.siteNodeId, byIdOf(TWO_PLANTS));
  for (const p of kept) {
    expect(placeVerdict(p)).toBe(placeVerdict(place(all, p.nodeId)));
  }
});

it("R10: and the count line is computed AFTER the trim — Cara is '0 of 2', with 4 beside it", () => {
  const kept = placesUnderSameRoot(
    workPlacesFor(cara, twoPlants(), TODAY),
    cara.siteNodeId,
    byIdOf(TWO_PLANTS),
  );
  const s = summarisePlaces(kept);
  expect(s.ownArea).toBe(2); // Cell 1 and Cell 2
  expect(s.eligible).toBe(0); // she holds nothing
  expect(s.outsideArea).toBe(4); // Cell 3 and the three unresolvable ones
  expect(s.total).toBe(6); // Cell 9 is gone; 7 handed in, 6 shown
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
 * resolveSelectedOperator — a selection must not outlive the list it came from.
 *
 * ⭐⭐ THIS RULE LIVED INSIDE `OperatorsPanel` UNTIL THE PLANT FILTER (roadmap
 * 1(c)) GAVE THE LIST A SECOND WAY TO SHRINK. It is the same family as
 * `resolveSelectedShape` and `resolvePlace`, and it is here rather than in the
 * component for §19.77's reason: a rule about who may appear on a screen,
 * written inside the component that draws it, is a rule nothing can pin.
 * =========================================================================== */

it("R11: the selected person comes back when they are still in the list", () => {
  expect(resolveSelectedOperator([ana, bob], ANA)?.id).toBe(ANA);
});

it("R12 ⭐: and is dropped the moment the list stops containing them", () => {
  // The plant filter is the second way this happens — the first was the search
  // box. Reading `selectedId` out of the UNFILTERED array put somebody from
  // Plant B in the detail pane beside a list holding only Plant A.
  expect(resolveSelectedOperator([bob], ANA)).toBe(null);
});

it("R13 ⭐: it falls back to NOBODY, not to the first row", () => {
  // The one place this differs from `resolveSelectedShape` / `resolvePlace`.
  // "Pick someone on the left" is this screen's real opening state, so a
  // first-row fallback would open a person nobody asked for on every visit —
  // and their name, area and tickets are the entire right-hand column.
  expect(resolveSelectedOperator([ana, bob], "no-such-person")).toBe(null);
});

it("R14: nothing selected stays nothing selected", () => {
  expect(resolveSelectedOperator([ana, bob], null)).toBe(null);
});

it("R15: an empty list resolves to nobody rather than throwing", () => {
  expect(resolveSelectedOperator([], ANA)).toBe(null);
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
 * findExistingSkillByName — the clash that is not an error, and is now LOCAL.
 *
 * ⭐⭐ MIGRATION 0031 / D111a: a training's name is unique PER OWNER
 * (`skills_owner_name_unique`, `unique (org_id, site_node_id, name)`), not per
 * org. N1–N6 were written against the org-wide rule; they are re-aimed here
 * rather than relaxed — every one of them still asserts a refusal or a warning,
 * and the owner is now supplied where the org used to be implied.
 *
 * ⚠️ THE FIXTURE ABOVE CANNOT TELL THE NEW RULE FROM THE OLD ONE ON ITS OWN.
 * Every skill in `SKILLS` belongs to `PLANT`, so an owner-scoped search and an
 * unscoped one return the same answer for all four rows — rule 3g, the same
 * blind spot Cara was added to fix for the area rule. `OTHER_PLANT_SKILLS`
 * below is the second owner that makes the difference observable, and N7–N10
 * are the cases that could not have existed before 0031.
 * =========================================================================== */

/**
 * A second plant, with its own "Forklift" — the row 0031 makes legal and the
 * demo seed used to spell `B-Forklift` to avoid.
 *
 * ⚠️ IT SHARES A NAME WITH `SKILLS`'s FORKLIFT ON PURPOSE, and the ids differ,
 * so any case that reports the wrong row names the wrong id rather than merely
 * the wrong count.
 *
 * The owner is the R block's `PLANT_2`, reused rather than redeclared: one
 * second root in this file, so "a different owner" and "a different root" are
 * the same node and cannot drift apart.
 */
const FORKLIFT_P2 = "30000000-0000-0000-0000-0000000000a1";
const OTHER_PLANT_SKILLS: readonly SkillLike[] = [
  ...SKILLS,
  { id: FORKLIFT_P2, name: "Forklift", siteNodeId: PLANT_2 },
];

it("N1: a name byte-equal after trimming, under this owner, is an EXACT clash — the insert would be refused", () => {
  const clash = findExistingSkillByName(SKILLS, "  Forklift  ", PLANT);
  expect(clash?.exact).toBe(true);
  expect(clash?.skill.id).toBe(FORKLIFT);
});

it("N2: a case-only difference under this owner is a LOOSE clash — the constraint is case-sensitive, so Postgres would allow both rows", () => {
  const clash = findExistingSkillByName(SKILLS, "forklift", PLANT);
  expect(clash?.exact).toBe(false);
  expect(clash?.skill.id).toBe(FORKLIFT);
});

it("N3: a genuinely new name clashes with nothing", () => {
  expect(findExistingSkillByName(SKILLS, "Crane", PLANT)).toBe(null);
});

it("N4: an empty name is not treated as a clash with anything", () => {
  expect(findExistingSkillByName(SKILLS, "   ", PLANT)).toBe(null);
});

it("N5: the exact clash reads as an offer to reuse, never as an error", () => {
  const clash = findExistingSkillByName(SKILLS, "Forklift", PLANT);
  // ⭐ "This place", not "site-owned". Since D108 every training is site-owned,
  // so that word separated nothing; under 0031 the question is whether the
  // place being created in already holds one, because that is the only way a
  // name can collide now. See `describeSkillNameClash`.
  expect(clash === null ? "" : describeSkillNameClash(clash)).toBe(
    "This place already has a Forklift — use that one.",
  );
});

it("N6: the loose clash leaves creating available, because it may be a different ticket", () => {
  const clash = findExistingSkillByName(SKILLS, "FORKLIFT", PLANT);
  // ⭐ `exact: false` IS WHAT LEAVES THE BUTTON LIVE — the panel disables
  // "Create & attach" on `clash.exact` alone — so it is asserted beside the
  // sentence rather than left implied by the wording.
  expect(clash?.exact).toBe(false);
  // ⚠️ THE WHOLE SENTENCE, NOT A SUBSTRING OF ITS TAIL. This read
  // `toContain("unless this is a different ticket")`, which is the half of the
  // line that 0031 did NOT change — so reverting the opening clause to "There
  // is already a site-owned…" went through it green. Measured, not guessed: the
  // deliberate break was not caught until this became an equality. N5 pins the
  // exact arm the same way; the two arms are separate strings and need separate
  // anchors.
  expect(clash === null ? "" : describeSkillNameClash(clash)).toBe(
    "This place already has a Forklift. Attach that one unless this is a different ticket.",
  );
});

it("N7 ⭐⭐: the same name under a DIFFERENT owner is not a clash at all — this is the defect 0031 fixes", () => {
  // The whole of D111a in one case. Plant 2's admin types "Forklift"; Plant 1
  // already has one. Before 0031 that was a 23505 citing a row Plant 2 could
  // not see, open, edit or reuse — a refusal naming something unreachable — and
  // the demo seed dodged it by calling everything `A-Forklift` / `B-Forklift`.
  // `unique (org_id, site_node_id, name)` makes it legal, so the screen must
  // say nothing at all.
  expect(findExistingSkillByName(SKILLS, "Forklift", PLANT_2)).toBe(null);
});

it("N8 ⭐: a case-only match under a different owner is not even a WARNING", () => {
  // ⚠️ THE OWNER TEST HAS TO GUARD BOTH ARMS. Letting the loose arm see other
  // owners would keep the old sentence alive in a quieter register: a warning
  // about a row that is legal, invisible to the reader, and none of their
  // business. This is the case that fails if the owner check is put after the
  // exact comparison instead of before both.
  expect(findExistingSkillByName(SKILLS, "forklift", PLANT_2)).toBe(null);
});

it("N9 ⭐⭐: with two owners holding the same name, the clash is the one under the owner asked about", () => {
  // ⚠️ NOT MERELY "a clash is found". A function that returned the FIRST name
  // match would pass N1 and N7 and still be wrong here — it would offer Plant
  // 1's Forklift to somebody in Plant 2, and "Attach Forklift" would grant a
  // training from a plant they do not work in. The id is what pins it.
  const inP1 = findExistingSkillByName(OTHER_PLANT_SKILLS, "Forklift", PLANT);
  expect(inP1?.skill.id).toBe(FORKLIFT);
  const inP2 = findExistingSkillByName(OTHER_PLANT_SKILLS, "Forklift", PLANT_2);
  expect(inP2?.skill.id).toBe(FORKLIFT_P2);
  // Both are exact: each really would be refused, in its own place.
  expect(inP1?.exact).toBe(true);
  expect(inP2?.exact).toBe(true);
});

it("N10: with no owner there is nothing to clash with — and that is not 'checked and clear'", () => {
  // The panel's state before anybody is picked. There is no owner, so there is
  // no insert to refuse; `createAndAttach` refuses separately, with a sentence,
  // rather than reading this `null` as permission.
  //
  // ⚠️ THIS CASE PINS THE ANSWER AND NOT THE GUARD, AND THAT WAS MEASURED:
  // deleting `owner === null` from the function leaves this green, because the
  // owner comparison rejects every row against `null` on its own while
  // `site_node_id` is NOT NULL. The guard's own comment says so rather than
  // letting it read as load-bearing — a line nothing can break is a line the
  // next reader will trust for the wrong reason (`scope.ts`'s dead `canEdit`).
  expect(findExistingSkillByName(SKILLS, "Forklift", null)).toBe(null);
});

it("N11: the REFUSAL is matched on the owner exactly, never by ancestry — N12 is the warning that is not", () => {
  // ⚠️ THE SERVER COMPARES `site_node_id` AS A VALUE, NOT AS AN LTREE
  // ANCESTOR: `unique (org_id, site_node_id, name)` is an equality over the
  // column. 0031's own header records the loosening this leaves behind — Line A
  // and Line B inside one plant may each hold a "TRN-4471" — and it is
  // deliberate. A mirror that tested "at or below" here would refuse a row the
  // database accepts, which is the stale-refusal direction.
  const onTheLine: readonly SkillLike[] = [
    { id: FIRST_AID, name: "First Aid", siteNodeId: LINE_A },
  ];
  //
  // ⚠️ AND NOTE WHAT IS NOT PASSED: no node map, so the plant-wide pass does
  // not run here at all. That pass WARNS about exactly this row (N12); this
  // case is about the answer that refuses.
  expect(findExistingSkillByName(onTheLine, "First Aid", PLANT)).toBe(null);
  expect(findExistingSkillByName(onTheLine, "First Aid", LINE_A)?.skill.id).toBe(FIRST_AID);
});

/* ---------------------------------------------------------------------------
 * The plant-wide WARNING — what pays for 0031's loosening.
 *
 * ⭐⭐ THE MIGRATION MAKES A PROMISE AND THIS BLOCK IS WHERE IT IS KEPT.
 * `unique (org_id, site_node_id, name)` knowingly lets Line A and Line B inside
 * one plant each hold a "Forklift", and 0031's header justifies that by saying
 * *"the database refuses per owner; the screen warns per plant"* — honest only
 * because a plant admin can READ their whole plant, which was never true across
 * plants. Without these cases that sentence is a doc describing code that does
 * not exist, which is the drift this project keeps finding.
 * ------------------------------------------------------------------------- */

const PLANT_SKILLS: readonly SkillLike[] = [
  { id: FIRST_AID, name: "First Aid", siteNodeId: LINE_B },
];

it("N12 ⭐⭐: another place in the SAME plant is a WARNING, not a refusal", () => {
  const clash = findExistingSkillByName(PLANT_SKILLS, "First Aid", LINE_A, byIdOf(TWO_PLANTS));
  expect(clash?.where).toBe("this-plant");
  expect(clash?.exact).toBe(true);
  // ⚠️ `where` is the field the screen reads to decide whether to DISABLE
  // Create. A case that only checked `exact` would pass against a client that
  // blocked a name the database accepts — §19.74's stale refusal, the quiet kind.
  expect(clash?.skill.id).toBe(FIRST_AID);
});

it("N13: a clash under THIS owner wins over one merely in the same plant", () => {
  // Both exist. The one the database will actually refuse has to be the one
  // reported, or the screen offers a warning where a refusal was owed and the
  // create goes through to a 23505 nobody predicted.
  const both: readonly SkillLike[] = [
    { id: FIRST_AID, name: "First Aid", siteNodeId: LINE_B },
    { id: WELDING, name: "First Aid", siteNodeId: LINE_A },
  ];
  const clash = findExistingSkillByName(both, "First Aid", LINE_A, byIdOf(TWO_PLANTS));
  expect(clash?.where).toBe("here");
  expect(clash?.skill.id).toBe(WELDING);
});

it("N14 ⚠️: with no tree there is no plant pass — and that is silence, not a clean bill of health", () => {
  // The same rows that produce a warning in N12 produce nothing here, because
  // the caller could not say where anything sits. Pinned so the day somebody
  // drops the argument at a call site, the loss is visible as a behaviour
  // change rather than as a warning that quietly stopped appearing.
  expect(findExistingSkillByName(PLANT_SKILLS, "First Aid", LINE_A)).toBe(null);
});

it("N15: a name in a DIFFERENT plant is still nothing at all", () => {
  // The original defect, and the reason 0031 exists: this must not warn, must
  // not refuse, and must not send anybody looking for a row they cannot read.
  const elsewhere: readonly SkillLike[] = [
    { id: FIRST_AID, name: "First Aid", siteNodeId: PLANT_2 },
  ];
  expect(findExistingSkillByName(elsewhere, "First Aid", LINE_A, byIdOf(TWO_PLANTS))).toBe(null);
});

it("N16: an unresolvable root says nothing, rather than matching everything equally unresolvable", () => {
  // ⚠️ Two rows whose roots both come back `null` are not "in the same plant".
  // Comparing `null === null` would make every unreadable owner clash with
  // every other one — an invented warning, in the direction that costs trust.
  const orphaned: readonly SkillLike[] = [{ id: FIRST_AID, name: "First Aid", siteNodeId: LOOP_B }];
  expect(findExistingSkillByName(orphaned, "First Aid", ORPHAN, byIdOf(TWO_PLANTS))).toBe(null);
});

it("N17: a case-only match elsewhere in the plant warns too, and says it is spelled differently", () => {
  const clash = findExistingSkillByName(PLANT_SKILLS, "first aid", LINE_A, byIdOf(TWO_PLANTS));
  expect(clash?.where).toBe("this-plant");
  expect(clash?.exact).toBe(false);
});

it("N18 ⭐: the warning NAMES the other place, and does not read as a refusal", () => {
  const clash = findExistingSkillByName(PLANT_SKILLS, "First Aid", LINE_A, byIdOf(TWO_PLANTS));
  // ⭐ "already has", never "cannot" — the Create button is live underneath this
  // sentence, and a warning that sounds like a refusal in front of a working
  // button is how people learn to ignore the ones that are.
  expect(describeSkillNameClash(clash as SkillNameClash, "Line B")).toBe(
    "Line B already has a First Aid. Create this one only if it is a different ticket.",
  );
  // Without a label it still says something true rather than naming nothing.
  expect(describeSkillNameClash(clash as SkillNameClash)).toContain("Another place in this plant");
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

it("V3 ⭐: the clash sentence asks about THIS PLACE — the axis 0031 moved it to", () => {
  // ⭐ THIS CASE HAS NOW BEEN RE-AIMED TWICE AND ITS HISTORY IS THE POINT.
  // Written when every skill in the fixture had `siteNodeId: null`, to reach a
  // "site-owned" arm of a ternary that had never once been evaluated. D108 then
  // deleted the OTHER arm, which left the word describing every training
  // equally and therefore describing none of them — the case went on passing
  // while asserting a sentence with no information in it. 0031 supplies the
  // information the word was standing in for: the clash is LOCAL, and "this
  // place" is the fact that decides whether the reader can reach the row.
  //
  // ⚠️ The owner's NAME is still not in this sentence, and that is deliberate,
  // not unfinished: `operators.ts` is dependency-free and holds ids. The name
  // is rendered beside the training by `OperatorsPanel` via `scopeLabel`, and
  // `operatorsPanel.test.tsx`'s O18/O19 are what pin it.
  const owned = { id: WELDING, name: "Welding", siteNodeId: PLANT };
  expect(describeSkillNameClash({ skill: owned, exact: true, where: "here" })).toBe(
    "This place already has a Welding — use that one.",
  );
});
