/**
 * Acceptance suite for `src/features/admin/lib/shapePicker.ts` (brief
 * P1-5f §8.3). A VITEST suite, because `npm run test` is what guards this
 * permanently and vitest collects every `src/test/*.test.ts`.
 *
 * It was first delivered as a standalone `node --experimental-strip-types`
 * script — which ran, and printed 42 passing assertions, and FAILED the
 * repo's own `npm run test` with *"No test suite found in file"* while
 * contributing zero of its 42 assertions to the 349 vitest reports. That is
 * brief-writing rule 11 (D78) in a second form: naming the suite's repo path
 * is necessary and not sufficient — the file must also be in the framework
 * the repo actually runs. `src/features/admin/lib/shapePicker.ts` is still
 * pure and `import type`-only, so an agent can still drive it from a
 * throwaway strip-types harness for mutation runs; that harness is not a
 * committed artifact. Same split as `scaleAudit.ts` / `scaleAudit.test.ts`.
 *
 * Every case runs inside its own try/catch: a thrown error is reported as
 * `THREW: …` rather than aborting the file, so a mutation that makes the
 * module throw fails its case BY NAME. (§9.3's own first defect was exactly
 * this — a fixture accessor using `.find(...)!` threw on a mutated build
 * instead of failing by name; the accessor below returns a distinguishable
 * SENTINEL instead.)
 *
 * THE FIXTURE (§6.4, rule 3 three times over) is built once, here, and
 * reused by every group below:
 *   - Shape A (Site › Department › Line › Work Cell, schedulable Work
 *     Cell) and Shape B (Site › Line, schedulable Line) share level NAMES
 *     at colliding POSITIONS (`Site` at position 0 in both; `Line` exists
 *     in both) so a filter accidentally keyed on `name` or `position`
 *     alone passes nothing and is caught immediately.
 *   - "New Shape" has ZERO levels (§6.3's own named trap).
 *   - Template ids, level ids and node ids are deliberately unrelated hex
 *     strings — none encodes which template/level it belongs to — so an id
 *     typo in this fixture cannot be mistaken for the behaviour under test.
 *   - `LEVELS` below is NOT in position order and interleaves the two
 *     templates' levels, so `.sort` is load-bearing, not accidentally
 *     satisfied by an already-sorted input (§9.3's second defect: N2/N12
 *     were inert in the design session's first pass because the fixture
 *     happened to already be sorted).
 *   - Nodes sit on Shape A only, so `hasNodes` differs across shapes
 *     instead of being uniformly true or false.
 */
import { expect, it } from "vitest";
import {
  buildShapeSummaries,
  levelsForShape,
  resolveSelectedShape,
  validateShapeName,
  type HierarchyTemplateRef,
  type ShapeSummary,
} from "../features/admin/lib/shapePicker.ts";
import type { BoardNode, HierarchyLevel } from "../lib/api/shapes.ts";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const TPL_A = "1c9e1a10-2b3c-4d5e-8f6a-7b8c9d0e1f2a"; // "Shape A"
const TPL_B = "2d0f2b21-3c4d-5e6f-9a7b-8c9d0e1f2a3b"; // "Shape B"
const TPL_NEW = "3e1f3c32-4d5e-6f7a-0b8c-9d0e1f2a3b4c"; // "New Shape" — zero levels

const LV_SITE_A = "aa11bb22-cc33-dd44-ee55-ff6600112233";
const LV_DEPT_A = "bb22cc33-dd44-ee55-ff66-001122334455";
const LV_LINE_A = "cc33dd44-ee55-ff66-0011-223344556677";
const LV_CELL_A = "dd44ee55-ff66-0011-2233-445566778899";
const LV_SITE_B = "ee55ff66-0011-2233-4455-66778899aabb";
const LV_LINE_B = "ff660011-2233-4455-6677-8899aabbccdd";

const ND_ROOT = "01122334-4556-6778-899a-abbccddeeff0";
const ND_CELL = "11223344-5566-7788-99aa-bbccddeeff01";

const TEMPLATES: readonly HierarchyTemplateRef[] = [
  { id: TPL_B, name: "Shape B" },
  { id: TPL_NEW, name: "New Shape" },
  { id: TPL_A, name: "Shape A" },
];

// Deliberately shuffled: not sorted by position, and the two templates'
// levels are interleaved rather than grouped.
const LEVELS: readonly HierarchyLevel[] = [
  { id: LV_LINE_A, templateId: TPL_A, position: 2, name: "Line", isSchedulable: false },
  { id: LV_SITE_B, templateId: TPL_B, position: 0, name: "Site", isSchedulable: false },
  { id: LV_CELL_A, templateId: TPL_A, position: 3, name: "Work Cell", isSchedulable: true },
  { id: LV_DEPT_A, templateId: TPL_A, position: 1, name: "Department", isSchedulable: false },
  { id: LV_LINE_B, templateId: TPL_B, position: 1, name: "Line", isSchedulable: true },
  { id: LV_SITE_A, templateId: TPL_A, position: 0, name: "Site", isSchedulable: false },
];

// Nodes on Shape A only.
const NODES: readonly BoardNode[] = [
  {
    id: ND_ROOT,
    parentId: null,
    levelId: LV_SITE_A,
    name: "Plant 1",
    path: "plant_1",
    sortOrder: 0,
    active: true,
  },
  {
    id: ND_CELL,
    parentId: ND_ROOT,
    levelId: LV_CELL_A,
    name: "Cell 1",
    path: "plant_1.cell_1",
    sortOrder: 0,
    active: true,
  },
];

// ---------------------------------------------------------------------------
// Tiny runner
// ---------------------------------------------------------------------------

// Each `check` registers one vitest case. The case body returns `true` on
// success or a DETAIL STRING on failure, and `expect(...).toBe(true)` then
// prints that string as the diff — so a failure names what was actually seen
// without every case needing its own matcher.
function check(id: string, fn: () => true | string): void {
  it(id, () => {
    let outcome: true | string;
    try {
      outcome = fn();
    } catch (e) {
      outcome = `THREW: ${e instanceof Error ? e.message : String(e)}`;
    }
    expect(outcome).toBe(true);
  });
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
}

function arraysEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// A SENTINEL, not a `!`-asserted lookup: §9.3's first defect was a fixture
// accessor that threw (`.find(...)!`) on a mutated build where the shape it
// looked for had vanished, hiding a real regression behind a crash. This
// returns a summary with obviously-wrong, distinguishable values instead,
// so a mutation that drops a shape fails its case BY NAME.
const MISSING_SENTINEL: ShapeSummary = {
  id: "__MISSING__",
  name: "__MISSING__",
  levelCount: -1,
  levelNames: ["__MISSING__"],
  schedulableLevelName: "__MISSING__",
  hasNodes: false,
};

function summaryFor(summaries: readonly ShapeSummary[], id: string): ShapeSummary {
  return summaries.find((s) => s.id === id) ?? MISSING_SENTINEL;
}

// ---------------------------------------------------------------------------
// Group B — buildShapeSummaries
// ---------------------------------------------------------------------------

const SUMMARIES = buildShapeSummaries(TEMPLATES, LEVELS, NODES);

check("B1: fixture is well-formed — every level's templateId is a real template", () => {
  const tplIds = new Set(TEMPLATES.map((t) => t.id));
  const ok = LEVELS.every((l) => tplIds.has(l.templateId));
  return ok || `a level references an unknown templateId`;
});

check("B1: fixture is well-formed — every node's levelId is a real level", () => {
  const levelIds = new Set(LEVELS.map((l) => l.id));
  const ok = NODES.every((n) => levelIds.has(n.levelId));
  return ok || `a node references an unknown levelId`;
});

check("B1: fixture is well-formed — no duplicate ids in any of the three lists", () => {
  const dupe = (ids: readonly string[]) => new Set(ids).size !== ids.length;
  if (dupe(TEMPLATES.map((t) => t.id))) return "duplicate template id";
  if (dupe(LEVELS.map((l) => l.id))) return "duplicate level id";
  if (dupe(NODES.map((n) => n.id))) return "duplicate node id";
  return true;
});

check("B2: every template appears in the summaries, none invented", () => {
  return (
    sameSet(SUMMARIES.map((s) => s.id), TEMPLATES.map((t) => t.id)) ||
    `got ids ${JSON.stringify(SUMMARIES.map((s) => s.id))}`
  );
});

check("B2b: summary count equals template count exactly", () => {
  return SUMMARIES.length === TEMPLATES.length || `got ${SUMMARIES.length} summaries`;
});

check("B3a: the zero-level template ('New Shape') has levelCount 0", () => {
  const s = summaryFor(SUMMARIES, TPL_NEW);
  return s.levelCount === 0 || `levelCount=${s.levelCount}`;
});

check("B3b: the zero-level template has levelNames []", () => {
  const s = summaryFor(SUMMARIES, TPL_NEW);
  return arraysEqual(s.levelNames, []) || `levelNames=${JSON.stringify(s.levelNames)}`;
});

check("B3c: the zero-level template has schedulableLevelName null", () => {
  const s = summaryFor(SUMMARIES, TPL_NEW);
  return s.schedulableLevelName === null || `schedulableLevelName=${s.schedulableLevelName}`;
});

check("B4: levelNames ascending by position (Shape A)", () => {
  const s = summaryFor(SUMMARIES, TPL_A);
  return (
    arraysEqual(s.levelNames, ["Site", "Department", "Line", "Work Cell"]) ||
    `got ${JSON.stringify(s.levelNames)}`
  );
});

check("B4b: levelNames ascending by position (Shape B)", () => {
  const s = summaryFor(SUMMARIES, TPL_B);
  return arraysEqual(s.levelNames, ["Site", "Line"]) || `got ${JSON.stringify(s.levelNames)}`;
});

check("B5a: schedulableLevelName picks the flagged level (Shape A -> Work Cell)", () => {
  const s = summaryFor(SUMMARIES, TPL_A);
  return s.schedulableLevelName === "Work Cell" || `got ${s.schedulableLevelName}`;
});

check("B5b: schedulableLevelName picks the flagged level (Shape B -> Line)", () => {
  const s = summaryFor(SUMMARIES, TPL_B);
  return s.schedulableLevelName === "Line" || `got ${s.schedulableLevelName}`;
});

check("B6: schedulableLevelName is null when no level is flagged (zero-level shape)", () => {
  const s = summaryFor(SUMMARIES, TPL_NEW);
  return s.schedulableLevelName === null || `got ${s.schedulableLevelName}`;
});

check("B7a: hasNodes true for Shape A (has nodes)", () => {
  const s = summaryFor(SUMMARIES, TPL_A);
  return s.hasNodes === true || `hasNodes=${s.hasNodes}`;
});

check("B7b: hasNodes false for Shape B (no nodes)", () => {
  const s = summaryFor(SUMMARIES, TPL_B);
  return s.hasNodes === false || `hasNodes=${s.hasNodes}`;
});

check("B7c: hasNodes false for the zero-level shape (no nodes, no levels)", () => {
  const s = summaryFor(SUMMARIES, TPL_NEW);
  return s.hasNodes === false || `hasNodes=${s.hasNodes}`;
});

check("B8a: ordering is by name ('New Shape' < 'Shape A' < 'Shape B')", () => {
  return (
    arraysEqual(
      SUMMARIES.map((s) => s.name),
      ["New Shape", "Shape A", "Shape B"],
    ) || `got ${JSON.stringify(SUMMARIES.map((s) => s.name))}`
  );
});

check("B8b: ordering is stable under a shuffled TEMPLATES input", () => {
  const shuffled = [TEMPLATES[2], TEMPLATES[0], TEMPLATES[1]]; // A, B, New
  const s2 = buildShapeSummaries(shuffled, LEVELS, NODES);
  return (
    arraysEqual(
      s2.map((s) => s.name),
      ["New Shape", "Shape A", "Shape B"],
    ) || `got ${JSON.stringify(s2.map((s) => s.name))}`
  );
});

check("B8c: two same-named templates tie-break by id", () => {
  const dupeA = { id: "88888888-0000-0000-0000-000000000000", name: "Same Name" };
  const dupeB = { id: "11111111-0000-0000-0000-000000000000", name: "Same Name" };
  const s3 = buildShapeSummaries([dupeA, dupeB], [], []);
  // "11111111..." < "88888888..." as plain code-unit comparison.
  return (
    (s3[0]?.id === dupeB.id && s3[1]?.id === dupeA.id) ||
    `got order ${JSON.stringify(s3.map((s) => s.id))}`
  );
});

// ---------------------------------------------------------------------------
// Group R — resolveSelectedShape
// ---------------------------------------------------------------------------

check("R1: a live selection is kept", () => {
  return resolveSelectedShape(SUMMARIES, TPL_B) === TPL_B || "selection was not kept";
});

// R2/R3 assert against a FIXED LITERAL id, never against `SUMMARIES[0]?.id`.
// MEASURED (design session, Aug 25): with the expected value derived from the
// same array under test, both cases PASSED under mutation N1 -- which deletes
// a whole summary from that array. A test whose expectation moves with the
// thing it is testing cannot disagree with it (verification standard rule 3).
// TPL_NEW ("New Shape") sorts first by name, and it is precisely the summary
// N1 removes, so a literal here is what gives these two cases teeth.
check("R2: a deleted selection falls back to the first summary", () => {
  const withoutB = SUMMARIES.filter((s) => s.id !== TPL_B);
  const got = resolveSelectedShape(withoutB, TPL_B);
  return got === TPL_NEW || `got ${got}, expected ${TPL_NEW}`;
});

check("R3: null selection resolves to the first summary", () => {
  const got = resolveSelectedShape(SUMMARIES, null);
  return got === TPL_NEW || `got ${got}, expected ${TPL_NEW}`;
});

check("R4: empty summaries resolves to null", () => {
  return resolveSelectedShape([], TPL_A) === null || "did not resolve to null";
});

// ---------------------------------------------------------------------------
// Group L — levelsForShape
// ---------------------------------------------------------------------------

check("L1: returns only the named template's levels (Shape A, on the colliding fixture)", () => {
  const got = levelsForShape(LEVELS, TPL_A);
  return (
    sameSet(
      got.map((l) => l.id),
      [LV_SITE_A, LV_DEPT_A, LV_LINE_A, LV_CELL_A],
    ) || `got ids ${JSON.stringify(got.map((l) => l.id))}`
  );
});

check("L1b: returns only the named template's levels (Shape B, on the colliding fixture)", () => {
  const got = levelsForShape(LEVELS, TPL_B);
  return (
    sameSet(
      got.map((l) => l.id),
      [LV_SITE_B, LV_LINE_B],
    ) || `got ids ${JSON.stringify(got.map((l) => l.id))}`
  );
});

check("L2: ascending by position, from a shuffled source array", () => {
  const got = levelsForShape(LEVELS, TPL_A).map((l) => l.position);
  return arraysEqual(got, [0, 1, 2, 3]) || `got ${JSON.stringify(got)}`;
});

check("L3: null templateId returns []", () => {
  const got = levelsForShape(LEVELS, null);
  return arraysEqual(got, []) || `got ${JSON.stringify(got)}`;
});

check("L4: an unknown template id returns []", () => {
  const got = levelsForShape(LEVELS, "99999999-9999-9999-9999-999999999999");
  return arraysEqual(got, []) || `got ${JSON.stringify(got)}`;
});

// ---------------------------------------------------------------------------
// Group V — validateShapeName
// ---------------------------------------------------------------------------

check("V1: a fresh name is ok", () => {
  const r = validateShapeName("Totally New Shape Name", SUMMARIES, null);
  return r.ok === true || `got ${JSON.stringify(r)}`;
});

check("V2: '' -> blank_name", () => {
  const r = validateShapeName("", SUMMARIES, null);
  return (!r.ok && r.reason === "blank_name") || `got ${JSON.stringify(r)}`;
});

const WHITESPACE_ONLY: readonly [string, string][] = [
  ["V3a (space)", " "],
  ["V3b (tab)", "\t"],
  ["V3c (NBSP U+00A0)", " "],
  ["V3d (BOM U+FEFF)", "﻿"],
];
for (const [label, input] of WHITESPACE_ONLY) {
  check(`V3: whitespace-only ${label} -> blank_name`, () => {
    const r = validateShapeName(input, SUMMARIES, null);
    return (!r.ok && r.reason === "blank_name") || `got ${JSON.stringify(r)}`;
  });
}

const missingKeyHolder: { name?: unknown } = {};
const NON_STRING_INPUTS: readonly [string, unknown][] = [
  ["V4a (null)", null],
  ["V4b (undefined)", undefined],
  ["V4c (42)", 42],
  ["V4d (missing key)", missingKeyHolder.name],
];
for (const [label, input] of NON_STRING_INPUTS) {
  check(`V4: non-string ${label} -> blank_name, no throw`, () => {
    const r = validateShapeName(input, SUMMARIES, null);
    return (!r.ok && r.reason === "blank_name") || `got ${JSON.stringify(r)}`;
  });
}

check("V5: an existing name -> duplicate_name", () => {
  const r = validateShapeName("Shape A", SUMMARIES, null);
  return (!r.ok && r.reason === "duplicate_name") || `got ${JSON.stringify(r)}`;
});

check("V6: duplicate detection is trim-aware (' Shape A ')", () => {
  const r = validateShapeName(" Shape A ", SUMMARIES, null);
  return (!r.ok && r.reason === "duplicate_name") || `got ${JSON.stringify(r)}`;
});

check("V7: the shape's own name under its own currentId -> ok", () => {
  const r = validateShapeName("Shape A", SUMMARIES, TPL_A);
  return r.ok === true || `got ${JSON.stringify(r)}`;
});

check("V8: 'shape a' vs 'Shape A' -> not a duplicate (case-sensitive)", () => {
  const r = validateShapeName("shape a", SUMMARIES, null);
  return r.ok === true || `got ${JSON.stringify(r)}`;
});
