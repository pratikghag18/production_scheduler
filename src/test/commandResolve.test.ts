/**
 * P1-7a — `src/lib/command/resolve.ts`, brief §5's fixture and worked examples
 * (R1–R33), run verbatim. The fixture below is copied from the brief exactly
 * so a reviewer can diff this file against §5 rather than re-derive it.
 *
 * `runs` defaults to `[]`; `withRuns` builds the fixture WITH `run1` (and,
 * for R32, `run2`) added, per row.
 */
import { describe, it, expect } from "vitest";
import { resolveCommand, describeQuestion, expandCommand } from "@/lib/command/resolve";
import type {
  ResolveContext,
  ContextRun,
  ContextAssignment,
  BoardDay,
  Candidate,
} from "@/lib/command/resolve";
import { formatCommand, markAbsence, parseCommand } from "@/lib/command/parse";
import type { Expansion, ResolveOptions } from "@/lib/command/resolve";
import { buildDayAxis, wallOf as wallOfAxis, zonedTimeToInstant } from "@/features/board/lib/time";
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
  SingleCommand,
  Attach,
  Existing,
} from "@/lib/command/parse";

// ---------------------------------------------------------------------------
// §5 fixture, verbatim.
// ---------------------------------------------------------------------------

const days: BoardDay[] = [
  { index: 0, iso: "2026-08-31", weekday: 1 },
  { index: 1, iso: "2026-09-01", weekday: 2 },
  { index: 2, iso: "2026-09-02", weekday: 3 },
  { index: 3, iso: "2026-09-03", weekday: 4 },
  { index: 4, iso: "2026-09-04", weekday: 5 },
  { index: 5, iso: "2026-09-05", weekday: 6 },
  { index: 6, iso: "2026-09-06", weekday: 0 },
];

const wallToOffset = (d: number, m: number): number => d * 1440 + m;
const wallToOffsetDst = (d: number, m: number): number => d * 1440 + m - (d >= 1 ? 60 : 0);

const p1 = { id: "p1", name: "Plant 1", path: "plant_1" };
const asm = { id: "asm", name: "Assembly", path: "plant_1.assembly" };
const l1 = { id: "l1", name: "Line 1", path: "plant_1.assembly.line_1" };
const l3 = { id: "l3", name: "Line 3", path: "plant_1.assembly.line_3" };
const c1a = { id: "c1a", name: "Cell 1", path: "plant_1.assembly.line_1.cell_1" };
const c2 = { id: "c2", name: "Cell 2", path: "plant_1.assembly.line_1.cell_2" };
const c1b = { id: "c1b", name: "Cell 1", path: "plant_1.assembly.line_3.cell_1" };

const allNodes = [p1, asm, l1, l3, c1a, c2, c1b];
const nodeById = new Map(allNodes.map((n) => [n.id, n]));

const cells = [c1a, c2, c1b];

const op1 = { id: "op1", displayName: "Operator 1", employeeRef: "E100", active: true };
const sp = { id: "sp", displayName: "Sam Patel", employeeRef: null, active: true };
const so = { id: "so", displayName: "Sam Ortiz", employeeRef: "E200", active: true };
const lin = { id: "lin", displayName: "Lin On", employeeRef: null, active: true };
const gone = { id: "gone", displayName: "Sam Gone", employeeRef: null, active: false };
const operators = [op1, sp, so, lin, gone];

const ha = { id: "ha", sku: "HA-1", name: "Housing A" };
const hb = { id: "hb", sku: "HB-1", name: "Housing B" };
const cov = { id: "cov", sku: "CV-9", name: "Cover" };
const products = [ha, hb, cov];

function offeredAt(nodeId: string): ReadonlyArray<{ id: string }> {
  if (nodeId === "c1a" || nodeId === "c2") return [{ id: "ha" }, { id: "hb" }];
  if (nodeId === "c1b") return [{ id: "cov" }];
  return [];
}

function fitsRun(
  a: { startMin: number; endMin: number },
  run: { startMin: number; endMin: number },
): boolean {
  return a.startMin >= run.startMin && a.endMin <= run.endMin;
}

const run1: ContextRun = {
  id: "run1",
  nodeId: "c1a",
  productId: "ha",
  startMin: 3 * 1440 + 480,
  endMin: 3 * 1440 + 960,
  label: "Housing A 8 am to 4 pm",
  span: "8 am to 4 pm",
  productName: "Housing A",
  headcount: null,
};

const run2: ContextRun = {
  id: "run2",
  nodeId: "c1a",
  productId: "ha",
  startMin: 3 * 1440 + 540,
  endMin: 3 * 1440 + 900,
  label: "Housing A 09:00–15:00",
  span: "09:00–15:00",
  productName: "Housing A",
  headcount: null,
};

/** S41-a RB6: a Cover run on c1a (a different part than Housing A, which is
 *  all c1a is offered per the fixture's `offeredAt` -- fine, per the brief:
 *  "the OTHER job's part need not be offered, only the sentence's"). */
const runCov: ContextRun = {
  id: "runCov",
  nodeId: "c1a",
  productId: "cov",
  startMin: 3 * 1440 + 480,
  endMin: 3 * 1440 + 960,
  label: "Cover 8 am to 4 pm",
  span: "8 am to 4 pm",
  productName: "Cover",
  headcount: null,
};

/** R-385: half-open overlap, the same stub shape the bar passes in. */
function overlaps(
  a: { startMin: number; endMin: number },
  b: { startMin: number; endMin: number },
): boolean {
  return a.startMin < b.endMin && b.startMin < a.endMin;
}

/** S41-a: `findRunOverlap`, the same stub shape `interaction.ts`'s own
 *  function has (half-open, `excludeRunId` skipped). */
function findRunOverlap(
  range: { startMin: number; endMin: number },
  runs: ContextRun[],
  excludeRunId: string | null,
): ContextRun | null {
  for (const r of runs) {
    if (excludeRunId !== null && r.id === excludeRunId) continue;
    if (range.startMin < r.endMin && r.startMin < range.endMin) return r;
  }
  return null;
}

/** F-152-b: mirrors `src/features/board/lib/time.ts`'s own `wallOf` -- an
 *  offset outside the board's own window clamps its `dayIndex` to the
 *  NEAREST end (0 or the last day's own index) while `minuteOfDay` stays
 *  the real wall clock, exactly the shape that let the maintainer's real
 *  board read a block starting the day before the window as starting on
 *  day 0 at its own real hour. Unclamped, no fake in this file could ever
 *  see this class of bug. Takes the days actually in play (never a fixed
 *  count): a builder calls this with whatever `days` the test passed. */
function clampedWallOf(
  boardDays: readonly BoardDay[],
): (m: number) => { dayIndex: number; minuteOfDay: number } {
  const lastIndex = boardDays.length > 0 ? boardDays[boardDays.length - 1].index : 0;
  return (m: number) => {
    const raw = Math.floor(m / 1440);
    const dayIndex = raw < 0 ? 0 : raw > lastIndex ? lastIndex : raw;
    return { dayIndex, minuteOfDay: ((m % 1440) + 1440) % 1440 };
  };
}

function baseCtx(overrides: Partial<ResolveContext> = {}): ResolveContext {
  const finalDays = overrides.days ?? days;
  return {
    cells,
    nodeById,
    operators,
    products,
    offeredAt,
    days,
    todayIndex: 3,
    // F-191: the plant's calendar today, derived from the days and
    // `todayIndex` a case passes so the two never disagree; a case with
    // today off the board gets a Monday far in the past unless it says
    // otherwise.
    todayIso:
      overrides.todayIso ??
      finalDays.find(
        (d) => d.index === (overrides.todayIndex === undefined ? 3 : overrides.todayIndex),
      )?.iso ??
      "2000-01-03",
    wallToOffset,
    runs: [],
    fitsRun,
    minDurationMinutes: 15,
    assignments: [],
    overlaps,
    findRunOverlap,
    shiftsAt: () => [],
    nowMinuteOfDay: null,
    wallOf: clampedWallOf(finalDays),
    // S61-b (R-425, F-155): nobody has a gap and every cell warns by
    // default -- every pin before this stage, and every pin here that does
    // not name a cert issue, stays byte-identical. `certGapsFixture` below
    // builds the ONE override every NC case passes instead.
    certificateGaps: () => [],
    eligibilityPolicy: () => "warn",
    // R-455 / F-219 (24 Sept, session 191): every ctx this module's own
    // tests build is fully settled the instant it exists -- there is no
    // window/query race to model here at all, only `CommandBar.tsx`'s own
    // rerun effect reads this.
    settled: true,
    ...overrides,
  };
}

/** S61-b (R-425, F-155): a `certificateGaps` fake keyed by operator id +
 *  node id -- `entries` is `[operatorId, nodeId, gaps[]]`; any pair not
 *  listed answers no gaps (eligible), the same "absent means nothing wrong"
 *  shape `ctx.certificateGaps` itself documents. */
function certGapsFixture(
  entries: [string, string, { skill: string; state: "never-trained" | "lapsed" }[]][],
): ResolveContext["certificateGaps"] {
  const map = new Map(entries.map(([opId, nodeId, gaps]) => [`${opId} ${nodeId}`, gaps]));
  return (operatorId, nodeId) => map.get(`${operatorId} ${nodeId}`) ?? [];
}

function withRuns(runs: ContextRun[], overrides: Partial<ResolveContext> = {}): ResolveContext {
  return baseCtx({ runs, ...overrides });
}

/** R-385: the fixture blocks, brief §9, all on day index 3, op1, c1a. */
function withBlocks(
  blocks: ContextAssignment[],
  overrides: Partial<ResolveContext> = {},
): ResolveContext {
  return baseCtx({ assignments: blocks, ...overrides });
}

function cmd(overrides: Partial<AssignCommand> = {}): AssignCommand {
  return {
    intent: "assign",
    operator: "Operator 1",
    product: "Housing A",
    place: ["Cell 1", "Line 1"],
    day: null,
    start: { hour: 10, minute: 0 },
    end: { hour: 14, minute: 0 },
    attach: null,
    shift: null,
    existing: null,
    ...overrides,
  };
}

/** S41-a: "Book Housing A on Cell 1 in Line 1 from 6 to 2" -- the §9 book
 *  fixture, same cell/product/day as `cmd()` above. */
function bookCmd(overrides: Partial<BookCommand> = {}): BookCommand {
  return {
    intent: "book",
    product: "Housing A",
    place: ["Cell 1", "Line 1"],
    headcount: null,
    day: null,
    start: { hour: 6, minute: 0 },
    end: { hour: 14, minute: 0 },
    shift: null,
    existing: null,
    ...overrides,
  };
}

/** S41-c: "Move Operator 1 on Cell 1 in Line 1 to Cell 2" -- the move
 *  fixture, same source cell/day as `blk1`. Defaults to a cell-only move
 *  (span null); individual cases override `toPlace`/`span` as needed. */
function moveCmd(overrides: Partial<MoveCommand> = {}): MoveCommand {
  return {
    intent: "move",
    operator: "Operator 1",
    place: ["Cell 1", "Line 1"],
    toPlace: ["Cell 2"],
    day: null,
    span: null,
    shift: null,
    existing: null,
    adjust: null,
    ...overrides,
  };
}

/** S41-b: "Unassign Operator 1 from Cell 1 in Line 1 from 10 to 14" -- the §9
 *  unassign fixture, same cell/day/hours as `blk1`. */
function unassignCmd(overrides: Partial<UnassignCommand> = {}): UnassignCommand {
  return {
    intent: "unassign",
    operator: "Operator 1",
    place: ["Cell 1", "Line 1"],
    day: null,
    span: { start: { hour: 10, minute: 0 }, end: { hour: 14, minute: 0 } },
    shift: null,
    existing: null,
    until: null,
    ...overrides,
  };
}

const R1_READOUT =
  "Operator 1 is on Cell 1 in Line 1 2026-09-03 from 10 am to 2 pm, making Housing A.";

const RB1_READOUT = "Cell 1 in Line 1 is booked 2026-09-03 from 6 am to 2 pm, making Housing A.";

// R-385 §9 fixture blocks, verbatim. `productName` added for S41-b (brief
// §3): the effective part's NAME, the same as its id -- contract changed,
// CLAUDE.md §4 (`ContextAssignment` gained the field; nothing here reads it
// except the new unassign cases below).
const blk1: ContextAssignment = {
  id: "blk1",
  nodeId: "c1a",
  operatorId: "op1",
  productId: "ha",
  productName: "Housing A",
  startMin: 3 * 1440 + 600,
  endMin: 3 * 1440 + 840,
  label: "10 am to 2 pm",
  runId: null,
}; // the maintainer's first sentence
const blk2: ContextAssignment = {
  ...blk1,
  id: "blk2",
  startMin: 3 * 1440 + 840,
  endMin: 3 * 1440 + 960,
  label: "2 pm to 4 pm",
};
const blkHb: ContextAssignment = {
  ...blk1,
  id: "blkHb",
  productId: "hb",
  productName: "Housing B",
  label: "10 am to 2 pm",
};
const blkSp: ContextAssignment = { ...blk1, id: "blkSp", operatorId: "sp" };
const blkGone: ContextAssignment = { ...blk1, id: "blkGone", operatorId: null };
const blkC2: ContextAssignment = { ...blk1, id: "blkC2", nodeId: "c2" };
/** S49: op1's block on the OTHER "Cell 1" (Line 3) -- distinct from blk1's
 *  c1a, same name as the sentence's named cell (both are called "Cell 1"). */
const blkC1b: ContextAssignment = { ...blk1, id: "blkC1b", nodeId: "c1b" };

describe("commandResolve: brief §5 worked examples", () => {
  it("R1: ok, direct, today's index, the readout byte-for-byte", () => {
    const res = resolveCommand(cmd(), baseCtx({ runs: [] }));
    expect(res).toEqual({
      ok: true,
      resolved: {
        intent: "assign",
        nodeId: "c1a",
        operatorId: "op1",
        productId: "ha",
        target: { kind: "direct", productId: "ha" },
        range: { startMin: 3 * 1440 + 600, endMin: 3 * 1440 + 840 },
        readout: R1_READOUT,
        attempted: "Operator 1 on Cell 1 in Line 1",
        notTried: "Operator 1 is not on Cell 1 in Line 1.",
      },
    });
  });

  it("R2: too_short -- 9:00-9:10 is only 10 minutes", () => {
    const res = resolveCommand(
      cmd({ start: { hour: 9, minute: 0 }, end: { hour: 9, minute: 10 } }),
      baseCtx({ runs: [] }),
    );
    expect(res).toEqual({ ok: false, question: { kind: "too_short", minutes: 10, min: 15 } });
  });

  it("R3: 'Cell 1' alone, no qualifier -- ambiguous place, cells order", () => {
    const res = resolveCommand(cmd({ place: ["Cell 1"] }), baseCtx());
    expect(res).toEqual({
      ok: false,
      question: {
        kind: "ambiguous",
        field: "place",
        text: "Cell 1",
        candidates: [
          { id: "c1a", label: "Cell 1 — Plant 1 › Assembly › Line 1", word: "Cell 1" },
          { id: "c1b", label: "Cell 1 — Plant 1 › Assembly › Line 3", word: "Cell 1" },
        ] as Candidate[],
      },
    });
  });

  it("R4: 'Cell 1 in Line 3' with Cover -- ok, c1b", () => {
    const res = resolveCommand(cmd({ place: ["Cell 1", "Line 3"], product: "Cover" }), baseCtx());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.resolved.nodeId).toBe("c1b");
      expect(res.resolved.productId).toBe("cov");
    }
  });

  // F-213 (S71-l, R-430): `elsewhere` used to be built from the CANDIDATE
  // cells' own labels -- "Cell 1 is in Cell 1 -- Plant 1 (...) Line 1",
  // naming the thing as its own container, the exact shape a misheard "on
  // Cell 5, Main Line 3" hit live (21:23:22, 23 Sept). It is now the
  // candidates' own PARENT (the line each one actually sits in) -- a real
  // choice the refusal can offer (R-430), never the cell repeated.
  it("R5: 'Cell 1 in Line 2' -- place_mismatch, each cell's own LINE offered elsewhere (F-213)", () => {
    const res = resolveCommand(cmd({ place: ["Cell 1", "Line 2"] }), baseCtx());
    expect(res).toEqual({
      ok: false,
      question: {
        kind: "place_mismatch",
        cell: "Cell 1",
        qualifier: "Line 2",
        elsewhere: [
          { id: "l1", label: "Line 1 — Plant 1 › Assembly", word: "Line 1" },
          { id: "l3", label: "Line 3 — Plant 1 › Assembly", word: "Line 3" },
        ],
      },
    });
    if (!res.ok) {
      expect(describeQuestion(res.question)).toBe(
        "There is no Cell 1 in Line 2. Cell 1 is in Line 1, Line 3.",
      );
    }
  });

  // F-213 follow-up (reviewer, R-430): `elsewhere` can come back EMPTY -- a
  // matched cell with no parent NODE at all (`elsewhereParents` excludes it
  // rather than naming the cell itself) -- and `describeQuestion` used to
  // print "Cell 9 is in ." either way. The message now stops after the
  // first sentence when there is truly nothing else to say, and offers no
  // buttons (CommandBar's own `place_mismatch` branch already sends
  // `candidates: []` unconditionally -- there was never a button to send
  // wrong, only a dangling half-sentence in the words).
  it("R5b: a matched cell with no parent node -- place_mismatch stops after the first sentence, no dangling 'is in .' (F-213)", () => {
    const depot = { id: "depot", name: "Depot", path: "depot" }; // a root node: no dot in its path
    const ctx = baseCtx({
      cells: [...cells, depot],
      nodeById: new Map([...nodeById, [depot.id, depot]]),
    });
    const res = resolveCommand(cmd({ place: ["Depot", "Line 1"] }), ctx);
    expect(res).toEqual({
      ok: false,
      question: {
        kind: "place_mismatch",
        cell: "Depot",
        qualifier: "Line 1",
        elsewhere: [],
      },
    });
    if (!res.ok) {
      expect(describeQuestion(res.question)).toBe("There is no Depot in Line 1.");
    }
  });

  it("R6: 'Cell 9' -- unknown place", () => {
    const res = resolveCommand(cmd({ place: ["Cell 9"] }), baseCtx());
    expect(res).toEqual({
      ok: false,
      question: { kind: "unknown", field: "place", text: "Cell 9" },
    });
    if (!res.ok)
      expect(describeQuestion(res.question)).toBe('No cell called "Cell 9" on this board.');
  });

  it("R7: 'Sam' at c1a -- ambiguous operator, Sam Patel and Sam Ortiz, never Sam Gone", () => {
    const res = resolveCommand(cmd({ operator: "Sam", place: ["Cell 1", "Line 1"] }), baseCtx());
    expect(res).toEqual({
      ok: false,
      question: {
        kind: "ambiguous",
        field: "operator",
        text: "Sam",
        candidates: [
          { id: "sp", label: "Sam Patel", word: "Sam Patel" },
          { id: "so", label: "Sam Ortiz", word: "Sam Ortiz" },
        ],
      },
    });
  });

  it("R8: 'sam patel' -- ok, exact tier, case-insensitive", () => {
    const res = resolveCommand(cmd({ operator: "sam patel" }), baseCtx());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.resolved.operatorId).toBe("sp");
  });

  it("R9: 'E200' -- ok, employeeRef fallback", () => {
    const res = resolveCommand(cmd({ operator: "E200" }), baseCtx());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.resolved.operatorId).toBe("so");
  });

  it("R10: 'Pat' -- ok, contains tier, one hit", () => {
    const res = resolveCommand(cmd({ operator: "Pat" }), baseCtx());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.resolved.operatorId).toBe("sp");
  });

  it("R11: 'Nobody' -- unknown operator", () => {
    const res = resolveCommand(cmd({ operator: "Nobody" }), baseCtx());
    expect(res).toEqual({
      ok: false,
      question: { kind: "unknown", field: "operator", text: "Nobody" },
    });
  });

  it("R12: 'Housing' -- ambiguous product, ha and hb", () => {
    const res = resolveCommand(cmd({ product: "Housing" }), baseCtx());
    expect(res).toEqual({
      ok: false,
      question: {
        kind: "ambiguous",
        field: "product",
        text: "Housing",
        candidates: [
          { id: "ha", label: "Housing A", word: "Housing A" },
          { id: "hb", label: "Housing B", word: "Housing B" },
        ],
      },
    });
  });

  it("R13: 'HA-1' -- ok, ha (sku)", () => {
    const res = resolveCommand(cmd({ product: "HA-1" }), baseCtx());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.resolved.productId).toBe("ha");
  });

  it("R14: 'Product A/Housing A' -- ok, ha (one slash piece hits, the other hits nothing)", () => {
    const res = resolveCommand(cmd({ product: "Product A/Housing A" }), baseCtx());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.resolved.productId).toBe("ha");
  });

  it("R15: 'Cover' at c1a -- not_offered", () => {
    const res = resolveCommand(cmd({ product: "Cover" }), baseCtx());
    expect(res).toEqual({
      ok: false,
      question: { kind: "not_offered", product: "Cover", cell: "Cell 1" },
    });
    if (!res.ok) {
      expect(describeQuestion(res.question)).toBe(
        "Cover is not made at Cell 1, so it cannot be scheduled there.",
      );
    }
  });

  // R-422 (S60-b): re-pinned -- "Gasket" still matches no product AND no
  // near name (R-418's own floor), but the cell it resolved (Cell 1, c1a)
  // DOES offer something (Housing A, Housing B per the fixture's own
  // `offeredAt`), so the resolver now offers the cell's own menu instead of
  // a bare unknown -- the maintainer's own words, 15 Sept: "it can also ask
  // what product ... from the list of available products for the hierarchy
  // level." Byte-identical to the pre-R-422 behaviour would only remain for
  // a cell with NO offerings at all (RS-WP4, commandResolve.test.ts).
  it("R16 (R-422 re-pin): 'Gasket' -- no near name either, so the cell's own menu (Housing A, Housing B)", () => {
    const res = resolveCommand(cmd({ product: "Gasket" }), baseCtx());
    expect(res).toEqual({
      ok: false,
      question: {
        kind: "unknown",
        field: "product",
        text: "Gasket",
        suggestions: [
          { id: "ha", label: "Housing A", word: "Housing A" },
          { id: "hb", label: "Housing B", word: "Housing B" },
        ],
      },
    });
  });

  it("R17: day tomorrow -- index 4 (Fri)", () => {
    const res = resolveCommand(cmd({ day: { kind: "tomorrow" } }), baseCtx());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.resolved.range).toEqual({ startMin: 4 * 1440 + 600, endMin: 4 * 1440 + 840 });
    }
  });

  it("R17 twin: todayIndex 6 -- tomorrow is off the board", () => {
    const res = resolveCommand(cmd({ day: { kind: "tomorrow" } }), baseCtx({ todayIndex: 6 }));
    expect(res).toEqual({ ok: false, question: { kind: "day_off_board", text: "tomorrow" } });
  });

  it("R18: weekday 1 (Monday) -- day index 0", () => {
    const res = resolveCommand(cmd({ day: { kind: "weekday", day: 1 } }), baseCtx());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.resolved.range.startMin).toBe(0 * 1440 + 600);
  });

  it("R19: weekday 0 (Sunday) -- day index 6", () => {
    const res = resolveCommand(cmd({ day: { kind: "weekday", day: 0 } }), baseCtx());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.resolved.range.startMin).toBe(6 * 1440 + 600);
  });

  it("R20: date 2026-09-08 -- off the board", () => {
    const res = resolveCommand(cmd({ day: { kind: "date", iso: "2026-09-08" } }), baseCtx());
    expect(res).toEqual({ ok: false, question: { kind: "day_off_board", text: "2026-09-08" } });
  });

  it("R20 twin: date 2026-09-06 -- day index 6", () => {
    const res = resolveCommand(cmd({ day: { kind: "date", iso: "2026-09-06" } }), baseCtx());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.resolved.range.startMin).toBe(6 * 1440 + 600);
  });

  // F-156 (S61-b, the maintainer, 16 Sept): this pinned the BUG, not the
  // contract -- "day null with todayIndex null" is a sentence with no day
  // at all, which means TODAY, and today is off the board here (todayIndex
  // null). The old `?? 0` silently answered the window's first day instead
  // of asking, which is how "split Tom Baker at 10" once looked on the
  // wrong date after "Show that day" moved the window (F-156's own story).
  // The corrected pin is NC8, in the S61-b describe below; kept here too
  // (byte-identical assertion) so this exact case stays covered at its
  // original numbered spot.
  it('R21 (corrected by F-156): day null with todayIndex null -- day_off_board "today", never the window\'s first day', () => {
    const res = resolveCommand(cmd({ day: null }), baseCtx({ todayIndex: null }));
    expect(res).toEqual({ ok: false, question: { kind: "day_off_board", text: "today" } });
  });

  it("R22: both an unknown cell and an unknown operator -- the question is about the cell", () => {
    const res = resolveCommand(cmd({ place: ["Cell 9"], operator: "Nobody" }), baseCtx());
    expect(res).toEqual({
      ok: false,
      question: { kind: "unknown", field: "place", text: "Cell 9" },
    });
  });

  it("R23: ctx.cells = [] -- unknown place, never throws", () => {
    const res = resolveCommand(cmd(), baseCtx({ cells: [] }));
    expect(res).toEqual({
      ok: false,
      question: { kind: "unknown", field: "place", text: "Cell 1" },
    });
  });

  it("R24: exactly the minimum duration (15) is allowed", () => {
    const res = resolveCommand(
      cmd({ start: { hour: 10, minute: 0 }, end: { hour: 10, minute: 15 } }),
      baseCtx(),
    );
    expect(res.ok).toBe(true);
  });

  it("R25: DST stub -- the resolver uses ctx.wallToOffset, never dayIndex * 1440 + minute", () => {
    const res = resolveCommand(
      cmd({ day: { kind: "tomorrow" } }),
      baseCtx({ wallToOffset: wallToOffsetDst }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.resolved.range).toEqual({
        startMin: 4 * 1440 + 600 - 60,
        endMin: 4 * 1440 + 840 - 60,
      });
    }
  });

  it("R26: day today with todayIndex 5", () => {
    const res = resolveCommand(cmd({ day: { kind: "today" } }), baseCtx({ todayIndex: 5 }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.resolved.range.startMin).toBe(5 * 1440 + 600);
  });

  it("R26 twin: today with todayIndex null -- day_off_board", () => {
    const res = resolveCommand(cmd({ day: { kind: "today" } }), baseCtx({ todayIndex: null }));
    expect(res).toEqual({ ok: false, question: { kind: "day_off_board", text: "today" } });
  });

  it("R27: run1 exists on the cell/product/span -- run_exists, verbatim describeQuestion", () => {
    const res = resolveCommand(cmd(), withRuns([run1]));
    expect(res).toEqual({
      ok: false,
      question: {
        kind: "run_exists",
        product: "Housing A",
        cell: "Cell 1",
        runs: [{ id: "run1", label: "Housing A 8 am to 4 pm", word: "" }],
      },
    });
    if (!res.ok) {
      expect(describeQuestion(res.question)).toBe(
        "A Housing A job is already booked on Cell 1, Housing A 8 am to 4 pm. Join it, or make a separate block?",
      );
    }
  });

  it("R28: attach run1 among the hits -- ok, target run, readout gains joining", () => {
    const attach: Attach = { kind: "run", runId: "run1" };
    const res = resolveCommand(cmd({ attach }), withRuns([run1]));
    expect(res).toEqual({
      ok: true,
      resolved: {
        intent: "assign",
        nodeId: "c1a",
        operatorId: "op1",
        productId: "ha",
        target: { kind: "run", runId: "run1" },
        range: { startMin: 3 * 1440 + 600, endMin: 3 * 1440 + 840 },
        readout: `${R1_READOUT} Joining the Housing A 8 am to 4 pm job already there.`,
        attempted: "Operator 1 on Cell 1 in Line 1",
        notTried: "Operator 1 is not on Cell 1 in Line 1.",
      },
    });
  });

  it("R29: attach direct -- ok, target direct, R1's readout", () => {
    const attach: Attach = { kind: "direct" };
    const res = resolveCommand(cmd({ attach }), withRuns([run1]));
    expect(res).toEqual({
      ok: true,
      resolved: {
        intent: "assign",
        nodeId: "c1a",
        operatorId: "op1",
        productId: "ha",
        target: { kind: "direct", productId: "ha" },
        range: { startMin: 3 * 1440 + 600, endMin: 3 * 1440 + 840 },
        readout: R1_READOUT,
        attempted: "Operator 1 on Cell 1 in Line 1",
        notTried: "Operator 1 is not on Cell 1 in Line 1.",
      },
    });
  });

  it("R30: run1 exists but the span is not contained -- ok, target direct, no question", () => {
    const res = resolveCommand(
      cmd({ start: { hour: 7, minute: 0 }, end: { hour: 14, minute: 0 } }),
      withRuns([run1]),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.resolved.target).toEqual({ kind: "direct", productId: "ha" });
  });

  it("R31: run1 is for Housing A, this sentence asks for Housing B -- ok, target direct hb", () => {
    const res = resolveCommand(cmd({ product: "Housing B" }), withRuns([run1]));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.resolved.target).toEqual({ kind: "direct", productId: "hb" });
  });

  it("R32: run1 AND run2 -- run_exists lists both, in runs order, plural describeQuestion", () => {
    const res = resolveCommand(cmd(), withRuns([run1, run2]));
    expect(res).toEqual({
      ok: false,
      question: {
        kind: "run_exists",
        product: "Housing A",
        cell: "Cell 1",
        runs: [
          { id: "run1", label: "Housing A 8 am to 4 pm", word: "" },
          { id: "run2", label: "Housing A 09:00–15:00", word: "" },
        ],
      },
    });
    if (!res.ok) {
      expect(describeQuestion(res.question)).toBe(
        "2 Housing A jobs are already booked on Cell 1. Join one, or make a separate block?",
      );
    }
  });

  it("R33: attach names a runId that is not among the hits -- run_exists again, never a silent direct", () => {
    const attach: Attach = { kind: "run", runId: "run9" };
    const res = resolveCommand(cmd({ attach }), withRuns([run1]));
    expect(res).toEqual({
      ok: false,
      question: {
        kind: "run_exists",
        product: "Housing A",
        cell: "Cell 1",
        runs: [{ id: "run1", label: "Housing A 8 am to 4 pm", word: "" }],
      },
    });
  });

  // -------------------------------------------------------------------------
  // R-385: the own-block question (R34-R44), brief §9.
  // -------------------------------------------------------------------------

  it("R34: the maintainer's case -- block_exists, same false, verbatim describeQuestion", () => {
    const res = resolveCommand(cmd({ end: { hour: 15, minute: 0 } }), withBlocks([blk1]));
    expect(res).toEqual({
      ok: false,
      question: {
        kind: "block_exists",
        person: "Operator 1",
        product: "Housing A",
        cell: "Cell 1",
        span: "10 am to 3 pm",
        blocks: [{ id: "blk1", label: "10 am to 2 pm", word: "" }],
        same: false,
      },
    });
    if (!res.ok) {
      expect(describeQuestion(res.question)).toBe(
        "Operator 1 is already on Housing A at Cell 1 10 am to 2 pm. Change it to 10 am to 3 pm, or add a separate block?",
      );
    }
  });

  it("R35: the identical sentence -- same true, 'nothing to change'", () => {
    const res = resolveCommand(cmd(), withBlocks([blk1]));
    expect(res).toEqual({
      ok: false,
      question: {
        kind: "block_exists",
        person: "Operator 1",
        product: "Housing A",
        cell: "Cell 1",
        span: "10 am to 2 pm",
        blocks: [{ id: "blk1", label: "10 am to 2 pm", word: "" }],
        same: true,
      },
    });
    if (!res.ok) {
      expect(describeQuestion(res.question)).toBe(
        "Operator 1 is already on Housing A at Cell 1 10 am to 2 pm — nothing to change. Add a separate block?",
      );
    }
  });

  it("R36: answer retime -- ok, target retime, range extended, readout gains changing", () => {
    const existing: Existing = { kind: "retime", assignmentId: "blk1" };
    const res = resolveCommand(cmd({ end: { hour: 15, minute: 0 }, existing }), withBlocks([blk1]));
    expect(res).toEqual({
      ok: true,
      resolved: {
        intent: "assign",
        nodeId: "c1a",
        operatorId: "op1",
        productId: "ha",
        target: { kind: "retime", assignmentId: "blk1" },
        range: { startMin: 3 * 1440 + 600, endMin: 3 * 1440 + 900 },
        readout: `${R1_READOUT.replace("10 am to 2 pm", "10 am to 3 pm")} Changing the block that ran 10 am to 2 pm.`,
        attempted: "Operator 1's block on Cell 1 in Line 1",
        notTried: "Operator 1's block on Cell 1 in Line 1 stays as it was, 10 am to 2 pm.",
      },
    });
  });

  it("R37: answer separate, no run -- ok, direct, no question", () => {
    const existing: Existing = { kind: "separate" };
    const res = resolveCommand(cmd({ existing }), withBlocks([blk1]));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.resolved.target).toEqual({ kind: "direct", productId: "ha" });
  });

  it("R38: answer separate, inside a run -- the two questions chain, run question not skipped", () => {
    const existing: Existing = { kind: "separate" };
    const res = resolveCommand(cmd({ existing }), withRuns([run1], { assignments: [blk1] }));
    expect(res).toEqual({
      ok: false,
      question: {
        kind: "run_exists",
        product: "Housing A",
        cell: "Cell 1",
        runs: [{ id: "run1", label: "Housing A 8 am to 4 pm", word: "" }],
      },
    });
  });

  it("R39: a different part asks nothing -- ok, direct", () => {
    const res = resolveCommand(cmd(), withBlocks([blkHb]));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.resolved.target).toEqual({ kind: "direct", productId: "ha" });
  });

  it("R40: a different person, a departed person, and another cell each ask nothing", () => {
    const bySp = resolveCommand(cmd(), withBlocks([blkSp]));
    expect(bySp.ok).toBe(true);
    const gone = resolveCommand(cmd(), withBlocks([blkGone]));
    expect(gone.ok).toBe(true);
    const c2 = resolveCommand(cmd(), withBlocks([blkC2]));
    expect(c2.ok).toBe(true);
  });

  it("R41: no overlap asks nothing -- half-open, touching at 14:00 is not overlapping", () => {
    const res = resolveCommand(
      cmd({ start: { hour: 14, minute: 0 }, end: { hour: 16, minute: 0 } }),
      withBlocks([blk1]),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.resolved.target).toEqual({ kind: "direct", productId: "ha" });
  });

  it("R42: two overlapping blocks list both in board order", () => {
    const res = resolveCommand(
      cmd({ start: { hour: 10, minute: 0 }, end: { hour: 16, minute: 0 } }),
      withBlocks([blk1, blk2]),
    );
    expect(res).toEqual({
      ok: false,
      question: {
        kind: "block_exists",
        person: "Operator 1",
        product: "Housing A",
        cell: "Cell 1",
        span: "10 am to 4 pm",
        blocks: [
          { id: "blk1", label: "10 am to 2 pm", word: "" },
          { id: "blk2", label: "2 pm to 4 pm", word: "" },
        ],
        same: false,
      },
    });
    if (!res.ok) {
      expect(describeQuestion(res.question)).toBe(
        "Operator 1 already has 2 Housing A blocks at Cell 1 (10 am to 2 pm, 2 pm to 4 pm). Change one to 10 am to 4 pm, or add a separate block?",
      );
    }
  });

  it("R43: a stale retime re-asks, never falls back, and reports block_gone when the block vanished", () => {
    const existing: Existing = { kind: "retime", assignmentId: "blk9" };
    const stillThere = resolveCommand(cmd({ existing }), withBlocks([blk1]));
    expect(stillThere.ok).toBe(false);
    if (!stillThere.ok) expect(stillThere.question.kind).toBe("block_exists");

    const gone = resolveCommand(cmd({ existing }), withBlocks([]));
    expect(gone).toEqual({
      ok: false,
      question: { kind: "block_gone", person: "Operator 1", product: "Housing A", cell: "Cell 1" },
    });
    if (!gone.ok) {
      expect(describeQuestion(gone.question)).toBe(
        "That Housing A block of Operator 1's at Cell 1 is no longer on the board. Add it as a new block?",
      );
    }
  });

  it("R44: the own-block question comes BEFORE the run question", () => {
    const res = resolveCommand(
      cmd({ end: { hour: 15, minute: 0 } }),
      withRuns([run1], { assignments: [blk1] }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.question.kind).toBe("block_exists");
  });

  // -------------------------------------------------------------------------
  // S41-a: "book a job" (RB1-RB11), brief s41-a-book-a-job-brief.md §5.
  // -------------------------------------------------------------------------

  it("RB1: book Housing A on Cell 1 in Line 1 from 6 to 2, no runs -- ok, run_create, RB1_READOUT", () => {
    const res = resolveCommand(bookCmd(), baseCtx());
    expect(res).toEqual({
      ok: true,
      resolved: {
        intent: "book",
        nodeId: "c1a",
        productId: "ha",
        target: { kind: "run_create", productId: "ha", headcount: null },
        range: { startMin: 3 * 1440 + 360, endMin: 3 * 1440 + 840 },
        readout: RB1_READOUT,
        attempted: "The Housing A job on Cell 1 in Line 1",
        notTried: "No Housing A job is booked on Cell 1 in Line 1.",
      },
    });
  });

  it("RB2: with for 3 -- headcount 3, readout ends ' · 3 people'", () => {
    const res = resolveCommand(bookCmd({ headcount: 3 }), baseCtx());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.resolved.target).toEqual({ kind: "run_create", productId: "ha", headcount: 3 });
      expect(res.resolved.readout).toBe(`${RB1_READOUT} For 3 people.`);
    }
  });

  it("RB3: run1 (same part) overlaps -- job_exists, verbatim, same false", () => {
    const res = resolveCommand(bookCmd(), withRuns([run1]));
    expect(res).toEqual({
      ok: false,
      question: {
        kind: "job_exists",
        product: "Housing A",
        cell: "Cell 1",
        span: "6 am to 2 pm",
        run: { id: "run1", label: "8 am to 4 pm", word: "" },
        same: false,
      },
    });
    if (!res.ok) {
      expect(describeQuestion(res.question)).toBe(
        "A Housing A job is already booked on Cell 1 8 am to 4 pm. Change it to 6 am to 2 pm, or pick other hours?",
      );
    }
  });

  it("RB4: span exactly 08:00-16:00 -- same true, 'nothing to change' verbatim", () => {
    const res = resolveCommand(
      bookCmd({ start: { hour: 8, minute: 0 }, end: { hour: 16, minute: 0 } }),
      withRuns([run1]),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.question).toEqual({
        kind: "job_exists",
        product: "Housing A",
        cell: "Cell 1",
        span: "8 am to 4 pm",
        run: { id: "run1", label: "8 am to 4 pm", word: "" },
        same: true,
      });
      expect(describeQuestion(res.question)).toBe(
        "A Housing A job is already booked on Cell 1 8 am to 4 pm — nothing to change.",
      );
    }
  });

  it("RB5: existing retime run1 -- ok, retime_run, readout gains changing", () => {
    const existing: BookCommand["existing"] = { kind: "retime", runId: "run1" };
    const res = resolveCommand(bookCmd({ existing }), withRuns([run1]));
    expect(res).toEqual({
      ok: true,
      resolved: {
        intent: "book",
        nodeId: "c1a",
        productId: "ha",
        target: { kind: "retime_run", runId: "run1" },
        range: { startMin: 3 * 1440 + 360, endMin: 3 * 1440 + 840 },
        readout: `${RB1_READOUT} Changing the job that ran Housing A 8 am to 4 pm.`,
        attempted: "The Housing A job on Cell 1 in Line 1",
        notTried: "The Housing A job on Cell 1 in Line 1 stays as it was, 8 am to 4 pm.",
      },
    });
  });

  it("RB6: a Cover run in the way -- job_in_the_way verbatim (Cover need not be offered at c1a)", () => {
    const res = resolveCommand(bookCmd(), withRuns([runCov]));
    expect(res).toEqual({
      ok: false,
      question: {
        kind: "job_in_the_way",
        product: "Housing A",
        cell: "Cell 1",
        other: "Cover 8 am to 4 pm",
      },
    });
    if (!res.ok) {
      expect(describeQuestion(res.question)).toBe(
        "Cell 1 already runs Cover 8 am to 4 pm; a cell runs one job at a time. Pick other hours, or change that job on the board.",
      );
    }
  });

  it("RB7: a run on another cell, or touching (not overlapping) this cell's span, asks nothing", () => {
    const runOtherCell: ContextRun = { ...run1, id: "runOtherCell", nodeId: "c2" };
    const otherCellRes = resolveCommand(bookCmd(), withRuns([runOtherCell]));
    expect(otherCellRes.ok).toBe(true);

    const runTouch: ContextRun = {
      id: "runTouch",
      nodeId: "c1a",
      productId: "ha",
      startMin: 3 * 1440 + 840, // 14:00 -- exactly where bookCmd()'s span ends
      endMin: 3 * 1440 + 960,
      label: "Housing A 2 pm to 4 pm",
      span: "2 pm to 4 pm",
      productName: "Housing A",
      headcount: null,
    };
    const touchRes = resolveCommand(bookCmd(), withRuns([runTouch]));
    expect(touchRes.ok).toBe(true);
  });

  it("RB8: existing retime 'run9' (gone) -- job_gone verbatim", () => {
    const existing: BookCommand["existing"] = { kind: "retime", runId: "run9" };
    const res = resolveCommand(bookCmd({ existing }), withRuns([run1]));
    expect(res).toEqual({
      ok: false,
      question: { kind: "job_gone", product: "Housing A", cell: "Cell 1" },
    });
    if (!res.ok) {
      expect(describeQuestion(res.question)).toBe(
        "That Housing A job on Cell 1 is no longer on the board. Book it again?",
      );
    }
  });

  it("RB9: retime run1, but run2 also overlaps the new span -- job_in_the_way naming run2", () => {
    const existing: BookCommand["existing"] = { kind: "retime", runId: "run1" };
    const res = resolveCommand(bookCmd({ existing }), withRuns([run1, run2]));
    expect(res).toEqual({
      ok: false,
      question: {
        kind: "job_in_the_way",
        product: "Housing A",
        cell: "Cell 1",
        other: "Housing A 09:00–15:00",
      },
    });
  });

  it("RB10: part not offered -- not_offered; too short -- too_short", () => {
    const notOffered = resolveCommand(bookCmd({ product: "Cover" }), baseCtx());
    expect(notOffered).toEqual({
      ok: false,
      question: { kind: "not_offered", product: "Cover", cell: "Cell 1" },
    });

    const tooShort = resolveCommand(
      bookCmd({ start: { hour: 6, minute: 0 }, end: { hour: 6, minute: 10 } }),
      baseCtx(),
    );
    expect(tooShort).toEqual({
      ok: false,
      question: { kind: "too_short", minutes: 10, min: 15 },
    });
  });

  it("RB11: the assign path (R1, R34) is byte-identical after the sharing refactor", () => {
    const r1 = resolveCommand(cmd(), baseCtx({ runs: [] }));
    expect(r1).toEqual({
      ok: true,
      resolved: {
        intent: "assign",
        nodeId: "c1a",
        operatorId: "op1",
        productId: "ha",
        target: { kind: "direct", productId: "ha" },
        range: { startMin: 3 * 1440 + 600, endMin: 3 * 1440 + 840 },
        readout: R1_READOUT,
        attempted: "Operator 1 on Cell 1 in Line 1",
        notTried: "Operator 1 is not on Cell 1 in Line 1.",
      },
    });

    const r34 = resolveCommand(cmd({ end: { hour: 15, minute: 0 } }), withBlocks([blk1]));
    expect(r34).toEqual({
      ok: false,
      question: {
        kind: "block_exists",
        person: "Operator 1",
        product: "Housing A",
        cell: "Cell 1",
        span: "10 am to 3 pm",
        blocks: [{ id: "blk1", label: "10 am to 2 pm", word: "" }],
        same: false,
      },
    });
  });
});

// -----------------------------------------------------------------------
// S41-b: "unassign" (RU1-RU9), brief s41-b-unassign-brief.md §5.
// -----------------------------------------------------------------------

describe("commandResolve: S41-b unassign worked examples", () => {
  it("RU1: the maintainer's sentence -- remove_which, verbatim, one candidate", () => {
    const res = resolveCommand(unassignCmd(), withBlocks([blk1]));
    expect(res).toEqual({
      ok: false,
      question: {
        kind: "remove_which",
        person: "Operator 1",
        cell: "Cell 1",
        when: "10 am to 2 pm",
        blocks: [{ id: "blk1", label: "Housing A 10 am to 2 pm", word: "", part: "Housing A" }],
      },
    });
    if (!res.ok) {
      expect(describeQuestion(res.question)).toBe(
        "Remove Operator 1's Housing A block on Cell 1, 10 am to 2 pm?",
      );
    }
  });

  it("RU2: answering remove blk1 -- ok, assignmentId blk1, readout verbatim", () => {
    const existing = { kind: "remove" as const, assignmentId: "blk1" };
    const res = resolveCommand(unassignCmd({ existing }), withBlocks([blk1]));
    expect(res).toEqual({
      ok: true,
      resolved: {
        intent: "unassign",
        assignmentId: "blk1",
        readout:
          "Operator 1 is off Cell 1 in Line 1 2026-09-03; that was 10 am to 2 pm, making Housing A.",
        attempted: "Operator 1's block on Cell 1 in Line 1",
        notTried: "Operator 1 stays on Cell 1 in Line 1.",
      },
    });
  });

  it("RU3: no hours with two blocks -- remove_which, both candidates in board order", () => {
    const res = resolveCommand(unassignCmd({ span: null }), withBlocks([blk1, blk2]));
    expect(res).toEqual({
      ok: false,
      question: {
        kind: "remove_which",
        person: "Operator 1",
        cell: "Cell 1",
        when: "2026-09-03",
        blocks: [
          { id: "blk1", label: "Housing A 10 am to 2 pm", word: "", part: "Housing A" },
          { id: "blk2", label: "Housing A 2 pm to 4 pm", word: "", part: "Housing A" },
        ],
      },
    });
    if (!res.ok) {
      expect(describeQuestion(res.question)).toBe(
        "Operator 1 has 2 blocks on Cell 1 2026-09-03. Remove which?",
      );
    }
  });

  it("RU4: no_block, verbatim, whole-day and with hours", () => {
    const wholeDay = resolveCommand(unassignCmd({ span: null }), withBlocks([]));
    expect(wholeDay).toEqual({
      ok: false,
      question: {
        kind: "no_block",
        person: "Operator 1",
        cell: "Cell 1",
        when: "2026-09-03",
      },
    });
    if (!wholeDay.ok) {
      expect(describeQuestion(wholeDay.question)).toBe(
        "Operator 1 has no block on Cell 1 2026-09-03.",
      );
    }

    const withHours = resolveCommand(unassignCmd(), withBlocks([]));
    expect(withHours).toEqual({
      ok: false,
      question: { kind: "no_block", person: "Operator 1", cell: "Cell 1", when: "10 am to 2 pm" },
    });
    if (!withHours.ok) {
      expect(describeQuestion(withHours.question)).toBe(
        "Operator 1 has no block on Cell 1 10 am to 2 pm.",
      );
    }
  });

  it("RU5: touching (not overlapping) at 14:00 -- no_block, half-open", () => {
    const res = resolveCommand(
      unassignCmd({ span: { start: { hour: 14, minute: 0 }, end: { hour: 16, minute: 0 } } }),
      withBlocks([blk1]),
    );
    expect(res).toEqual({
      ok: false,
      question: { kind: "no_block", person: "Operator 1", cell: "Cell 1", when: "2 pm to 4 pm" },
    });
  });

  it("RU6: another person's block asks nothing but no_block; the person's own block on another cell is offered (S49, R-397)", () => {
    const bySp = resolveCommand(unassignCmd(), withBlocks([blkSp]));
    expect(bySp).toEqual({
      ok: false,
      question: { kind: "no_block", person: "Operator 1", cell: "Cell 1", when: "10 am to 2 pm" },
    });
    // Until S49 this half pinned `no_block` for the person's OWN block on
    // Cell 2 -- the refusal F-144 was about. The contract changed (R-397):
    // the block elsewhere is offered, with both cells named. RE1 pins the
    // full shape and message; this keeps the kind and the flag.
    const byC2 = resolveCommand(unassignCmd(), withBlocks([blkC2]));
    expect(byC2.ok).toBe(false);
    if (!byC2.ok) {
      expect(byC2.question.kind).toBe("remove_which");
      if (byC2.question.kind === "remove_which") {
        expect(byC2.question.elsewhere).toBe(true);
        expect(byC2.question.cell).toBe("Cell 1");
        expect(byC2.question.blocks.map((b) => b.id)).toEqual(["blkC2"]);
      }
    }
  });

  it("RU7: a stale answer re-asks, never falls back, and reports block_gone_remove when the block vanished", () => {
    const existing = { kind: "remove" as const, assignmentId: "blk9" };
    const stillThere = resolveCommand(unassignCmd({ existing }), withBlocks([blk1]));
    expect(stillThere.ok).toBe(false);
    if (!stillThere.ok) expect(stillThere.question.kind).toBe("remove_which");

    const gone = resolveCommand(unassignCmd({ existing }), withBlocks([]));
    expect(gone).toEqual({
      ok: false,
      question: { kind: "block_gone_remove", person: "Operator 1", cell: "Cell 1" },
    });
    if (!gone.ok) {
      expect(describeQuestion(gone.question)).toBe(
        "That block of Operator 1's on Cell 1 is already gone.",
      );
    }
  });

  it("RU8: the assign path (R1, R34) and the book path (RB1, RB3) are byte-identical after the person-step extraction", () => {
    const r1 = resolveCommand(cmd(), baseCtx({ runs: [] }));
    expect(r1).toEqual({
      ok: true,
      resolved: {
        intent: "assign",
        nodeId: "c1a",
        operatorId: "op1",
        productId: "ha",
        target: { kind: "direct", productId: "ha" },
        range: { startMin: 3 * 1440 + 600, endMin: 3 * 1440 + 840 },
        readout: R1_READOUT,
        attempted: "Operator 1 on Cell 1 in Line 1",
        notTried: "Operator 1 is not on Cell 1 in Line 1.",
      },
    });

    const r34 = resolveCommand(cmd({ end: { hour: 15, minute: 0 } }), withBlocks([blk1]));
    expect(r34.ok).toBe(false);
    if (!r34.ok) expect(r34.question.kind).toBe("block_exists");

    const rb1 = resolveCommand(bookCmd(), baseCtx());
    expect(rb1).toEqual({
      ok: true,
      resolved: {
        intent: "book",
        nodeId: "c1a",
        productId: "ha",
        target: { kind: "run_create", productId: "ha", headcount: null },
        range: { startMin: 3 * 1440 + 360, endMin: 3 * 1440 + 840 },
        readout: RB1_READOUT,
        attempted: "The Housing A job on Cell 1 in Line 1",
        notTried: "No Housing A job is booked on Cell 1 in Line 1.",
      },
    });

    const rb3 = resolveCommand(bookCmd(), withRuns([run1]));
    expect(rb3.ok).toBe(false);
    if (!rb3.ok) expect(rb3.question.kind).toBe("job_exists");
  });

  it("RU9: whole-day span uses ctx.wallToOffset, never dayIndex * 1440 (DST stub)", () => {
    // Under `wallToOffsetDst` (an hour lost overnight into day 1, R25's
    // stub), tomorrow's (day 4) whole-day window is real minutes
    // [4*1440-60, 4*1440+1440-60) = [5700, 7140). A block sitting exactly in
    // the 60-minute gap that only the CORRECT (shifted) window covers --
    // never `dayIndex * 1440`'s [5760, 7200) -- proves which arithmetic ran:
    // `dayIndex * 1440` would miss it and report `no_block` (M46).
    const blkDst: ContextAssignment = {
      ...blk1,
      id: "blkDst",
      startMin: 5700,
      endMin: 5760,
      label: "in the DST gap",
    };
    const res = resolveCommand(
      unassignCmd({ span: null, day: { kind: "tomorrow" } }),
      withBlocks([blkDst], { wallToOffset: wallToOffsetDst }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.question.kind).toBe("remove_which");
  });

  it("RU10: a block with an unknown product reads 'block', never a doubled word", () => {
    const blkUnknown: ContextAssignment = { ...blk1, id: "blkUnknown", productName: null };
    const res = resolveCommand(unassignCmd(), withBlocks([blkUnknown]));
    expect(res).toEqual({
      ok: false,
      question: {
        kind: "remove_which",
        person: "Operator 1",
        cell: "Cell 1",
        when: "10 am to 2 pm",
        blocks: [{ id: "blkUnknown", label: "block 10 am to 2 pm", word: "", part: null }],
      },
    });
    if (!res.ok) {
      expect(describeQuestion(res.question)).toBe(
        "Remove Operator 1's block on Cell 1, 10 am to 2 pm?",
      );
    }
  });
});

/**
 * S41-c — the "move" resolver path, brief docs/agent-briefs/
 * s41-c-move-brief.md §5's worked examples (RM1-RM10).
 */
describe("commandResolve: S41-c move worked examples", () => {
  // R-459: a move-in-time readout ("now runs <day> from <hours>") and a
  // move-to-another-cell readout ("is moving from <cell> to <cell>, <day>
  // from <hours>") are two different sentences (`resolveMoveCommand`'s own
  // `destCellName !== null` branch) -- one constant per shape, not one
  // shared prefix that only fit the OLD arrow-suffix format.
  const MOVE_IN_TIME_PREFIX = "Operator 1's Housing A block on Cell 1 in Line 1";
  const MOVE_TO_CELL_PREFIX =
    "Operator 1 is moving from Cell 1 in Line 1 to Cell 2, 2026-09-03 from";

  it("RM1: the move in time -- retime, readout with the arrow naming the hours", () => {
    const res = resolveCommand(
      moveCmd({
        toPlace: null,
        span: { start: { hour: 10, minute: 0 }, end: { hour: 15, minute: 0 } },
      }),
      withBlocks([blk1]),
    );
    expect(res).toEqual({
      ok: true,
      resolved: {
        intent: "move",
        assignmentId: "blk1",
        nodeId: "c1a",
        operatorId: "op1",
        productId: "ha",
        range: { startMin: 3 * 1440 + 600, endMin: 3 * 1440 + 900 },
        target: { kind: "retime" },
        readout: `${MOVE_IN_TIME_PREFIX} now runs 2026-09-03 from 10 am to 3 pm.`,
        attempted: "Operator 1's block on Cell 1 in Line 1",
        notTried: "Operator 1's block on Cell 1 in Line 1 stays as it was, 10 am to 2 pm.",
      },
    });
  });

  it("RM2: the move in place, keeping the block's own hours", () => {
    const res = resolveCommand(moveCmd({ toPlace: ["Cell 2"], span: null }), withBlocks([blk1]));
    expect(res).toEqual({
      ok: true,
      resolved: {
        intent: "move",
        assignmentId: "blk1",
        nodeId: "c2",
        operatorId: "op1",
        productId: "ha",
        range: { startMin: 3 * 1440 + 600, endMin: 3 * 1440 + 840 },
        target: { kind: "move_cell" },
        readout: `${MOVE_TO_CELL_PREFIX} 10 am to 2 pm.`,
        attempted: "Operator 1 on Cell 2",
        notTried: "Operator 1 stays on Cell 1 in Line 1.",
      },
    });
  });

  it("RM3: both a new cell and new hours", () => {
    const res = resolveCommand(
      moveCmd({
        toPlace: ["Cell 2"],
        span: { start: { hour: 10, minute: 0 }, end: { hour: 15, minute: 0 } },
      }),
      withBlocks([blk1]),
    );
    expect(res).toEqual({
      ok: true,
      resolved: {
        intent: "move",
        assignmentId: "blk1",
        nodeId: "c2",
        operatorId: "op1",
        productId: "ha",
        range: { startMin: 3 * 1440 + 600, endMin: 3 * 1440 + 900 },
        target: { kind: "move_cell" },
        readout: `${MOVE_TO_CELL_PREFIX} 10 am to 3 pm.`,
        attempted: "Operator 1 on Cell 2",
        notTried: "Operator 1 stays on Cell 1 in Line 1.",
      },
    });
  });

  it("RM4: the part not offered at the NEW cell -- not_offered naming the new cell", () => {
    const res = resolveCommand(
      moveCmd({ toPlace: ["Cell 1", "Line 3"], span: null }),
      withBlocks([blk1]),
    );
    expect(res).toEqual({
      ok: false,
      question: { kind: "not_offered", product: "Housing A", cell: "Cell 1" },
    });
  });

  it("RM5: no block at all -- no_block", () => {
    const res = resolveCommand(moveCmd(), withBlocks([]));
    expect(res).toEqual({
      ok: false,
      question: { kind: "no_block", person: "Operator 1", cell: "Cell 1", when: "2026-09-03" },
    });
  });

  it("RM6: two blocks -- move_which, and the answer picks one", () => {
    const asked = resolveCommand(moveCmd(), withBlocks([blk1, blk2]));
    expect(asked).toEqual({
      ok: false,
      question: {
        kind: "move_which",
        person: "Operator 1",
        cell: "Cell 1",
        when: "2026-09-03",
        blocks: [
          { id: "blk1", label: "Housing A 10 am to 2 pm", word: "", part: "Housing A" },
          { id: "blk2", label: "Housing A 2 pm to 4 pm", word: "", part: "Housing A" },
        ],
      },
    });
    if (!asked.ok) {
      expect(describeQuestion(asked.question)).toBe(
        "Operator 1 has 2 blocks on Cell 1 2026-09-03. Move which?",
      );
    }

    const existing = { kind: "move" as const, assignmentId: "blk2" };
    const picked = resolveCommand(moveCmd({ existing }), withBlocks([blk1, blk2]));
    expect(picked.ok).toBe(true);
    if (picked.ok) expect(picked.resolved.assignmentId).toBe("blk2");
  });

  it("RM7: the new cell ambiguous (two 'Cell 1's) -- ambiguous place for the DESTINATION", () => {
    const res = resolveCommand(moveCmd({ toPlace: ["Cell 1"] }), withBlocks([blk1]));
    expect(res).toEqual({
      ok: false,
      question: {
        kind: "ambiguous",
        field: "place",
        text: "Cell 1",
        candidates: [
          { id: "c1a", label: "Cell 1 — Plant 1 › Assembly › Line 1", word: "Cell 1" },
          { id: "c1b", label: "Cell 1 — Plant 1 › Assembly › Line 3", word: "Cell 1" },
        ],
      },
    });
  });

  it("RM8: a stale answer re-asks, never falls back", () => {
    const existing = { kind: "move" as const, assignmentId: "blk9" };
    const res = resolveCommand(moveCmd({ existing }), withBlocks([blk1, blk2]));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.question.kind).toBe("move_which");
  });

  it("RM9: the sentence's hours are the DESTINATION -- the block is found by the DAY even though the new hours do not overlap it", () => {
    const res = resolveCommand(
      moveCmd({
        toPlace: null,
        span: { start: { hour: 16, minute: 0 }, end: { hour: 18, minute: 0 } },
      }),
      withBlocks([blk1]),
    );
    expect(res).toEqual({
      ok: true,
      resolved: {
        intent: "move",
        assignmentId: "blk1",
        nodeId: "c1a",
        operatorId: "op1",
        productId: "ha",
        range: { startMin: 3 * 1440 + 960, endMin: 3 * 1440 + 1080 },
        target: { kind: "retime" },
        readout: `${MOVE_IN_TIME_PREFIX} now runs 2026-09-03 from 4 pm to 6 pm.`,
        attempted: "Operator 1's block on Cell 1 in Line 1",
        notTried: "Operator 1's block on Cell 1 in Line 1 stays as it was, 10 am to 2 pm.",
      },
    });
  });

  it("RM10: the three regression pins -- assign (R1), book (RB1) and unassign (RU2) unchanged", () => {
    const r1 = resolveCommand(cmd(), baseCtx({ runs: [] }));
    expect(r1).toEqual({
      ok: true,
      resolved: {
        intent: "assign",
        nodeId: "c1a",
        operatorId: "op1",
        productId: "ha",
        target: { kind: "direct", productId: "ha" },
        range: { startMin: 3 * 1440 + 600, endMin: 3 * 1440 + 840 },
        readout: R1_READOUT,
        attempted: "Operator 1 on Cell 1 in Line 1",
        notTried: "Operator 1 is not on Cell 1 in Line 1.",
      },
    });

    const rb1 = resolveCommand(bookCmd(), baseCtx());
    expect(rb1).toEqual({
      ok: true,
      resolved: {
        intent: "book",
        nodeId: "c1a",
        productId: "ha",
        target: { kind: "run_create", productId: "ha", headcount: null },
        range: { startMin: 3 * 1440 + 360, endMin: 3 * 1440 + 840 },
        readout: RB1_READOUT,
        attempted: "The Housing A job on Cell 1 in Line 1",
        notTried: "No Housing A job is booked on Cell 1 in Line 1.",
      },
    });

    const ru2 = resolveCommand(
      unassignCmd({ existing: { kind: "remove", assignmentId: "blk1" } }),
      withBlocks([blk1]),
    );
    expect(ru2).toEqual({
      ok: true,
      resolved: {
        intent: "unassign",
        assignmentId: "blk1",
        readout:
          "Operator 1 is off Cell 1 in Line 1 2026-09-03; that was 10 am to 2 pm, making Housing A.",
        attempted: "Operator 1's block on Cell 1 in Line 1",
        notTried: "Operator 1 stays on Cell 1 in Line 1.",
      },
    });
  });
});

/**
 * S49 (R-397, §19.96/D125, docs/agent-briefs/s49-a-elsewhere-brief.md §5):
 * a removal or a move whose named cell is wrong -- or whose place is empty
 * altogether -- looks further, RE1-RE12.
 */
describe("commandResolve: S49 the block is elsewhere", () => {
  it("RE1: removal, wrong cell, one block elsewhere -- remove_which, elsewhere:true, verbatim", () => {
    const res = resolveCommand(unassignCmd(), withBlocks([blkC2]));
    expect(res).toEqual({
      ok: false,
      question: {
        kind: "remove_which",
        person: "Operator 1",
        cell: "Cell 1",
        when: "10 am to 2 pm",
        blocks: [
          {
            id: "blkC2",
            label: "Cell 2 · Housing A 10 am to 2 pm",
            word: "",
            part: "Housing A",
            cell: "Cell 2",
            when: "10 am to 2 pm",
          },
        ],
        elsewhere: true,
      },
    });
    if (!res.ok) {
      expect(describeQuestion(res.question)).toBe(
        "Operator 1 has no block on Cell 1 10 am to 2 pm, but has one on Cell 2: Housing A 10 am to 2 pm. Remove that one?",
      );
    }
  });

  it("RE2: the same, whole day -- the brief's own worked example, verbatim", () => {
    const res = resolveCommand(unassignCmd({ span: null }), withBlocks([blkC2]));
    expect(res).toEqual({
      ok: false,
      question: {
        kind: "remove_which",
        person: "Operator 1",
        cell: "Cell 1",
        when: "2026-09-03",
        blocks: [
          {
            id: "blkC2",
            label: "Cell 2 · Housing A 10 am to 2 pm",
            word: "",
            part: "Housing A",
            cell: "Cell 2",
            when: "10 am to 2 pm",
          },
        ],
        elsewhere: true,
      },
    });
    if (!res.ok) {
      expect(describeQuestion(res.question)).toBe(
        "Operator 1 has no block on Cell 1 2026-09-03, but has one on Cell 2: Housing A 10 am to 2 pm. Remove that one?",
      );
    }
  });

  it("RE3: removal, wrong cell, several elsewhere -- board order, verbatim", () => {
    const res = resolveCommand(unassignCmd(), withBlocks([blkC2, blkC1b]));
    expect(res).toEqual({
      ok: false,
      question: {
        kind: "remove_which",
        person: "Operator 1",
        cell: "Cell 1",
        when: "10 am to 2 pm",
        blocks: [
          {
            id: "blkC2",
            label: "Cell 2 · Housing A 10 am to 2 pm",
            word: "",
            part: "Housing A",
            cell: "Cell 2",
            when: "10 am to 2 pm",
          },
          {
            id: "blkC1b",
            label: "Cell 1 · Housing A 10 am to 2 pm",
            word: "",
            part: "Housing A",
            cell: "Cell 1",
            when: "10 am to 2 pm",
          },
        ],
        elsewhere: true,
      },
    });
    if (!res.ok) {
      expect(describeQuestion(res.question)).toBe(
        "Operator 1 has no block on Cell 1 10 am to 2 pm, but has 2 elsewhere. Remove which?",
      );
    }
  });

  it("RE4: removal, wrong cell, none anywhere -- no_block unchanged", () => {
    const res = resolveCommand(unassignCmd(), withBlocks([blkSp]));
    expect(res).toEqual({
      ok: false,
      question: { kind: "no_block", person: "Operator 1", cell: "Cell 1", when: "10 am to 2 pm" },
    });
  });

  it("RE5: the answer names the elsewhere block -- ok, readout chain names the block's own cell", () => {
    const existing = { kind: "remove" as const, assignmentId: "blkC2" };
    const res = resolveCommand(unassignCmd({ existing }), withBlocks([blkC2]));
    expect(res).toEqual({
      ok: true,
      resolved: {
        intent: "unassign",
        assignmentId: "blkC2",
        readout: "Operator 1 is off Cell 2 2026-09-03; that was 10 am to 2 pm, making Housing A.",
        attempted: "Operator 1's block on Cell 2",
        notTried: "Operator 1 stays on Cell 2.",
      },
    });
  });

  it("RE6: a stale answer re-asks with elsewhere, block_gone_remove when nothing is anywhere", () => {
    const existing = { kind: "remove" as const, assignmentId: "blk9" };
    const stillThere = resolveCommand(unassignCmd({ existing }), withBlocks([blkC2]));
    expect(stillThere.ok).toBe(false);
    if (!stillThere.ok) {
      expect(stillThere.question).toEqual({
        kind: "remove_which",
        person: "Operator 1",
        cell: "Cell 1",
        when: "10 am to 2 pm",
        blocks: [
          {
            id: "blkC2",
            label: "Cell 2 · Housing A 10 am to 2 pm",
            word: "",
            part: "Housing A",
            cell: "Cell 2",
            when: "10 am to 2 pm",
          },
        ],
        elsewhere: true,
      });
    }

    const gone = resolveCommand(unassignCmd({ existing }), withBlocks([]));
    expect(gone).toEqual({
      ok: false,
      question: { kind: "block_gone_remove", person: "Operator 1", cell: "Cell 1" },
    });
  });

  it("RE7: move in time, wrong cell, one block elsewhere -- move_which asks, destination is the hours", () => {
    const res = resolveCommand(
      moveCmd({
        toPlace: null,
        span: { start: { hour: 10, minute: 0 }, end: { hour: 14, minute: 0 } },
      }),
      withBlocks([blkC2]),
    );
    expect(res).toEqual({
      ok: false,
      question: {
        kind: "move_which",
        person: "Operator 1",
        cell: "Cell 1",
        when: "2026-09-03",
        blocks: [
          {
            id: "blkC2",
            label: "Cell 2 · Housing A 10 am to 2 pm",
            word: "",
            part: "Housing A",
            cell: "Cell 2",
            when: "10 am to 2 pm",
          },
        ],
        elsewhere: true,
        destination: "10 am to 2 pm",
      },
    });
    if (!res.ok) {
      expect(describeQuestion(res.question)).toBe(
        "Operator 1 has no block on Cell 1 2026-09-03, but has one on Cell 2: Housing A 10 am to 2 pm. Move that one to 10 am to 2 pm?",
      );
    }
  });

  it("RE8: move to a named place with new hours, wrong current cell -- destination names both", () => {
    const res = resolveCommand(
      moveCmd({
        toPlace: ["Cell 2", "Line 1"],
        span: { start: { hour: 12, minute: 0 }, end: { hour: 16, minute: 0 } },
      }),
      withBlocks([blkC2]),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.question.kind).toBe("move_which");
      if (res.question.kind === "move_which") {
        expect(res.question.destination).toBe("Cell 2 in Line 1 from noon to 4 pm");
      }
    }
  });

  it("RE9: the answer for a move-in-time picks the elsewhere block -- retime targets its own cell", () => {
    const existing = { kind: "move" as const, assignmentId: "blkC2" };
    const res = resolveCommand(
      moveCmd({
        toPlace: null,
        span: { start: { hour: 10, minute: 0 }, end: { hour: 15, minute: 0 } },
        existing,
      }),
      withBlocks([blkC2]),
    );
    expect(res).toEqual({
      ok: true,
      resolved: {
        intent: "move",
        assignmentId: "blkC2",
        nodeId: "c2",
        operatorId: "op1",
        productId: "ha",
        range: { startMin: 3 * 1440 + 600, endMin: 3 * 1440 + 900 },
        target: { kind: "retime" },
        readout: "Operator 1's Housing A block on Cell 2 now runs 2026-09-03 from 10 am to 3 pm.",
        attempted: "Operator 1's block on Cell 2",
        notTried: "Operator 1's block on Cell 2 stays as it was, 10 am to 2 pm.",
      },
    });
  });

  it("RE10: move, wrong cell, several elsewhere -- move_which lists all, board order", () => {
    const res = resolveCommand(moveCmd(), withBlocks([blkC2, blkC1b]));
    expect(res).toEqual({
      ok: false,
      question: {
        kind: "move_which",
        person: "Operator 1",
        cell: "Cell 1",
        when: "2026-09-03",
        blocks: [
          {
            id: "blkC2",
            label: "Cell 2 · Housing A 10 am to 2 pm",
            word: "",
            part: "Housing A",
            cell: "Cell 2",
            when: "10 am to 2 pm",
          },
          {
            id: "blkC1b",
            label: "Cell 1 · Housing A 10 am to 2 pm",
            word: "",
            part: "Housing A",
            cell: "Cell 1",
            when: "10 am to 2 pm",
          },
        ],
        elsewhere: true,
        destination: "Cell 2",
      },
    });
  });

  it("RE11: empty place -- one block asks plainly, several use the cell:null message, none is no_block", () => {
    const one = resolveCommand(unassignCmd({ place: [] }), withBlocks([blk1]));
    expect(one).toEqual({
      ok: false,
      question: {
        kind: "remove_which",
        person: "Operator 1",
        cell: null,
        when: "10 am to 2 pm",
        blocks: [
          {
            id: "blk1",
            label: "Cell 1 · Housing A 10 am to 2 pm",
            word: "",
            part: "Housing A",
            cell: "Cell 1",
            when: "10 am to 2 pm",
          },
        ],
      },
    });
    if (!one.ok) {
      expect(describeQuestion(one.question)).toBe(
        "Remove Operator 1's Housing A block on Cell 1, 10 am to 2 pm?",
      );
    }

    const several = resolveCommand(unassignCmd({ place: [] }), withBlocks([blk1, blkC2]));
    expect(several.ok).toBe(false);
    if (!several.ok) {
      expect(several.question.kind).toBe("remove_which");
      if (several.question.kind === "remove_which") {
        expect(several.question.cell).toBeNull();
        expect(several.question.elsewhere).toBeUndefined();
        expect(several.question.blocks.map((b) => b.id)).toEqual(["blk1", "blkC2"]);
      }
      expect(describeQuestion(several.question)).toBe(
        "Operator 1 has 2 blocks 10 am to 2 pm. Remove which?",
      );
    }

    const none = resolveCommand(unassignCmd({ place: [] }), withBlocks([blkSp]));
    expect(none).toEqual({
      ok: false,
      question: { kind: "no_block", person: "Operator 1", cell: null, when: "10 am to 2 pm" },
    });
    if (!none.ok) {
      expect(describeQuestion(none.question)).toBe("Operator 1 has no block 10 am to 2 pm.");
    }
  });

  it("RE12: empty place, move -- one block is taken, two ask (cell:null, no destination)", () => {
    const taken = resolveCommand(
      moveCmd({
        place: [],
        toPlace: null,
        span: { start: { hour: 10, minute: 0 }, end: { hour: 15, minute: 0 } },
      }),
      withBlocks([blkC2]),
    );
    expect(taken.ok).toBe(true);
    if (taken.ok) {
      expect(taken.resolved.assignmentId).toBe("blkC2");
      expect(taken.resolved.nodeId).toBe("c2");
      expect(taken.resolved.target).toEqual({ kind: "retime" });
    }

    const asked = resolveCommand(
      moveCmd({
        place: [],
        toPlace: null,
        span: { start: { hour: 10, minute: 0 }, end: { hour: 15, minute: 0 } },
      }),
      withBlocks([blkC2, blkC1b]),
    );
    expect(asked.ok).toBe(false);
    if (!asked.ok) {
      expect(asked.question.kind).toBe("move_which");
      if (asked.question.kind === "move_which") {
        expect(asked.question.cell).toBeNull();
        expect(asked.question.elsewhere).toBeUndefined();
        expect(asked.question.destination).toBeUndefined();
      }
      expect(describeQuestion(asked.question)).toBe(
        "Operator 1 has 2 blocks 2026-09-03. Move which?",
      );
    }
  });

  // Reviewer fix (S49): `decodeMove`/the text grammar both refuse a move
  // naming neither a new cell nor new hours, but `resolveCommand` takes any
  // `MoveCommand` -- this shape must still get a Resolution back, never
  // throw (`buildDestinationText` used to read `command.span!.start`
  // unguarded).
  it("RE13: a move naming neither a new cell nor new hours never throws -- move_which, the fallback destination", () => {
    const res = resolveCommand(moveCmd({ toPlace: null, span: null }), withBlocks([blkC2]));
    expect(res).toEqual({
      ok: false,
      question: {
        kind: "move_which",
        person: "Operator 1",
        cell: "Cell 1",
        when: "2026-09-03",
        blocks: [
          {
            id: "blkC2",
            label: "Cell 2 · Housing A 10 am to 2 pm",
            word: "",
            part: "Housing A",
            cell: "Cell 2",
            when: "10 am to 2 pm",
          },
        ],
        elsewhere: true,
        destination: "the same place and hours",
      },
    });
  });

  // Nit fix (S49): the `block_gone_remove` message for an empty place
  // (`cell: null`) was untested.
  it("RE14: empty place, a stale answer with nothing anywhere -- block_gone_remove, cell:null, verbatim", () => {
    const existing = { kind: "remove" as const, assignmentId: "blk9" };
    const res = resolveCommand(unassignCmd({ place: [], existing }), withBlocks([]));
    expect(res).toEqual({
      ok: false,
      question: { kind: "block_gone_remove", person: "Operator 1", cell: null },
    });
    if (!res.ok) {
      expect(describeQuestion(res.question)).toBe("That block of Operator 1's is already gone.");
    }
  });
});

/**
 * S50 (docs/agent-briefs/s50-a-grammar-brief.md §2 item 4, R-398): a
 * `several` resolves to the `several_unsupported` question -- read, but not
 * yet run (the bar's one-yes-for-the-lot confirmation is its own later
 * stage).
 */
describe("commandResolve: S50 a several is read but not yet run", () => {
  it("RS1: a several resolves to several_unsupported with the count and the message verbatim", () => {
    const several = {
      intent: "several" as const,
      commands: [cmd(), cmd({ operator: "Operator 2" })],
    };
    const res = resolveCommand(several, baseCtx());
    expect(res).toEqual({
      ok: false,
      question: { kind: "several_unsupported", count: 2 },
    });
    if (!res.ok) {
      expect(describeQuestion(res.question)).toBe(
        "I can only run one thing at a time from a typed sentence; say them one at a time for now.",
      );
    }
  });
});

/**
 * S52-b (docs/agent-briefs/s52-b-shift-resolver-brief.md §2 item 4, R-402,
 * design §19.99/D128): a shift's name resolves to the NAMED cell's own band
 * for the day, from `ctx.shiftsAt` -- the pop-up's own shift-chip source,
 * no copy. SR1-SR10; SR11-SR13 -- R-402 / D128 (docs/design-plan.md
 * §19.99): a place-less sentence with a shift never ignores it silently,
 * and never depends on the order of the person's blocks either.
 */
describe("commandResolve: S52 a shift by name", () => {
  /** The demo pattern, c1a only: Shift 1 06:00-14:00, Shift 2 14:00-22:00,
   *  Shift 3 22:00-06:00 (overnight, `endMin` past 1440). */
  const demoShiftsAt = (nodeId: string): { name: string; startMin: number; endMin: number }[] =>
    nodeId === "c1a"
      ? [
          { name: "Shift 1", startMin: 360, endMin: 840 },
          { name: "Shift 2", startMin: 840, endMin: 1320 },
          { name: "Shift 3", startMin: 1320, endMin: 1800 },
        ]
      : [];

  it("SR1: 'for shift 2' on an assign resolves exactly as 14:00-22:00 typed, readout included", () => {
    const ctx = baseCtx({ shiftsAt: demoShiftsAt });
    const shiftRes = resolveCommand(cmd({ start: null, end: null, shift: "2" }), ctx);
    const hoursRes = resolveCommand(
      cmd({ start: { hour: 14, minute: 0 }, end: { hour: 22, minute: 0 } }),
      ctx,
    );
    expect(shiftRes).toEqual(hoursRes);
    expect(shiftRes.ok).toBe(true);
    if (shiftRes.ok) {
      expect(shiftRes.resolved.range).toEqual({
        startMin: 3 * 1440 + 840,
        endMin: 3 * 1440 + 1320,
      });
    }
  });

  it("SR2: 'shift 2', 'Shift 2' and '2' all match Shift 2", () => {
    const ctx = baseCtx({ shiftsAt: demoShiftsAt });
    for (const text of ["shift 2", "Shift 2", "2"]) {
      const res = resolveCommand(cmd({ start: null, end: null, shift: text }), ctx);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.resolved.range).toEqual({ startMin: 3 * 1440 + 840, endMin: 3 * 1440 + 1320 });
      }
    }
  });

  it("SR3: 'night' matches a band named 'Night Shift' by its last significant token", () => {
    const shiftsAt = (nodeId: string) =>
      nodeId === "c2" ? [{ name: "Night Shift", startMin: 0, endMin: 480 }] : [];
    const res = resolveCommand(
      cmd({ place: ["Cell 2"], start: null, end: null, shift: "night" }),
      baseCtx({ shiftsAt }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.resolved.range).toEqual({ startMin: 3 * 1440, endMin: 3 * 1440 + 480 });
    }
  });

  it("SR4: 'shift 9' -- no_shift, message verbatim listing the three", () => {
    const res = resolveCommand(
      cmd({ start: null, end: null, shift: "9" }),
      baseCtx({ shiftsAt: demoShiftsAt }),
    );
    expect(res).toEqual({
      ok: false,
      question: {
        kind: "no_shift",
        text: "9",
        cell: "Cell 1",
        shifts: ["Shift 1", "Shift 2", "Shift 3"],
      },
    });
    if (!res.ok) {
      expect(describeQuestion(res.question)).toBe(
        'No shift called "9" on Cell 1; it has Shift 1, Shift 2, Shift 3.',
      );
    }
  });

  it("SR5: a cell with no pattern -- no_shift_pattern, verbatim", () => {
    const res = resolveCommand(cmd({ start: null, end: null, shift: "2" }), baseCtx());
    expect(res).toEqual({
      ok: false,
      question: { kind: "no_shift_pattern", cell: "Cell 1" },
    });
    if (!res.ok) {
      expect(describeQuestion(res.question)).toBe("Cell 1 has no shift pattern, so say the hours.");
    }
  });

  it("SR6: two bands sharing a word -- ambiguous field shift, both candidates, and the answer resolves", () => {
    const dayBands = [
      { name: "Day A", startMin: 360, endMin: 840 },
      { name: "Day B", startMin: 840, endMin: 1320 },
    ];
    const ctx = baseCtx({ shiftsAt: () => dayBands });
    const res = resolveCommand(cmd({ start: null, end: null, shift: "day" }), ctx);
    expect(res).toEqual({
      ok: false,
      question: {
        kind: "ambiguous",
        field: "shift",
        text: "day",
        candidates: [
          { id: "Day A", label: "Day A 6 am to 2 pm", word: "Day A" },
          { id: "Day B", label: "Day B 2 pm to 10 pm", word: "Day B" },
        ],
      },
    });
    if (!res.ok && res.question.kind === "ambiguous") {
      const picked = resolveCommand(
        cmd({ start: null, end: null, shift: res.question.candidates[0].word }),
        ctx,
      );
      expect(picked.ok).toBe(true);
      if (picked.ok) {
        expect(picked.resolved.range).toEqual({ startMin: 3 * 1440 + 360, endMin: 3 * 1440 + 840 });
      }
    }
  });

  it("SR7: Shift 3 (overnight) -- endMin lands on the next day, timeText as the board prints it", () => {
    const res = resolveCommand(
      cmd({ start: null, end: null, shift: "3" }),
      baseCtx({ shiftsAt: demoShiftsAt }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.resolved.range).toEqual({ startMin: 3 * 1440 + 1320, endMin: 4 * 1440 + 360 });
      expect(res.resolved.readout).toContain("10 pm to 6 am");
    }
  });

  it("SR8: a removal 'for shift 1' finds the block overlapping 06:00-14:00", () => {
    const res = resolveCommand(
      unassignCmd({ span: null, shift: "1" }),
      withBlocks([blk1], { shiftsAt: demoShiftsAt }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.question.kind).toBe("remove_which");
      if (res.question.kind === "remove_which") {
        expect(res.question.blocks.map((b) => b.id)).toEqual(["blk1"]);
      }
    }
  });

  it("SR9: a move 'during shift 3' re-times to the overnight band", () => {
    const res = resolveCommand(
      moveCmd({ toPlace: null, span: null, shift: "3" }),
      withBlocks([blk1], { shiftsAt: demoShiftsAt }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.resolved.range).toEqual({ startMin: 3 * 1440 + 1320, endMin: 4 * 1440 + 360 });
      expect(res.resolved.readout).toContain("10 pm to 6 am");
    }
  });

  it("SR10: a book 'for shift 1' resolves the same as the hours form", () => {
    const ctx = baseCtx({ shiftsAt: demoShiftsAt });
    const shiftRes = resolveCommand(bookCmd({ start: null, end: null, shift: "1" }), ctx);
    const hoursRes = resolveCommand(bookCmd(), ctx);
    expect(shiftRes).toEqual(hoursRes);
    expect(shiftRes.ok).toBe(true);
  });

  it("SR11: a place-less removal with a shift resolves the window from the FIRST block's own cell's band; a block elsewhere overlapping it is also a candidate; an unmatched name names that cell; no blocks at all is no_block, cell null", () => {
    const ctx = withBlocks([blk1, blkC2], { shiftsAt: demoShiftsAt });

    const res = resolveCommand(unassignCmd({ place: [], span: null, shift: "1" }), ctx);
    expect(res).toEqual({
      ok: false,
      question: {
        kind: "remove_which",
        person: "Operator 1",
        cell: null,
        when: "6 am to 2 pm",
        blocks: [
          {
            id: "blk1",
            label: "Cell 1 · Housing A 10 am to 2 pm",
            word: "",
            part: "Housing A",
            cell: "Cell 1",
            when: "10 am to 2 pm",
          },
          {
            id: "blkC2",
            label: "Cell 2 · Housing A 10 am to 2 pm",
            word: "",
            part: "Housing A",
            cell: "Cell 2",
            when: "10 am to 2 pm",
          },
        ],
      },
    });

    const noShift = resolveCommand(unassignCmd({ place: [], span: null, shift: "9" }), ctx);
    expect(noShift).toEqual({
      ok: false,
      question: {
        kind: "no_shift",
        text: "9",
        cell: "Cell 1",
        shifts: ["Shift 1", "Shift 2", "Shift 3"],
      },
    });

    const none = resolveCommand(
      unassignCmd({ place: [], span: null, shift: "1" }),
      withBlocks([], { shiftsAt: demoShiftsAt }),
    );
    expect(none).toEqual({
      ok: false,
      question: { kind: "no_block", person: "Operator 1", cell: null, when: "2026-09-03" },
    });
  });

  it("SR12: a place-less move 'during shift 3' retimes to the overnight band on the block's own cell; no block is no_block", () => {
    const res = resolveCommand(
      moveCmd({ place: [], toPlace: null, span: null, shift: "3" }),
      withBlocks([blk1], { shiftsAt: demoShiftsAt }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.resolved.assignmentId).toBe("blk1");
      expect(res.resolved.nodeId).toBe("c1a");
      expect(res.resolved.range).toEqual({ startMin: 3 * 1440 + 1320, endMin: 4 * 1440 + 360 });
      expect(res.resolved.readout).toContain("10 pm to 6 am");
    }

    const none = resolveCommand(
      moveCmd({ place: [], toPlace: null, span: null, shift: "3" }),
      withBlocks([], { shiftsAt: demoShiftsAt }),
    );
    expect(none).toEqual({
      ok: false,
      question: { kind: "no_block", person: "Operator 1", cell: null, when: "2026-09-03" },
    });
  });

  it("SR13: a place-less removal never depends on block order -- [blkC2, blk1] still resolves via Cell 1 (the reviewer's exact case); when no cell resolves, no_shift names the first cell WITH a pattern, no_shift_pattern only when none has one", () => {
    const ctx = withBlocks([blkC2, blk1], { shiftsAt: demoShiftsAt });

    // The reviewer's exact case: blkC2 (Cell 2, no pattern) sorts FIRST,
    // blk1 (Cell 1, has Shift 1) second -- the old "first block only" rule
    // refused with no_shift_pattern naming Cell 2; trying every cell in
    // order, it now resolves via Cell 1, exactly as SR11's [blk1, blkC2]
    // order does.
    const res = resolveCommand(unassignCmd({ place: [], span: null, shift: "1" }), ctx);
    expect(res).toEqual({
      ok: false,
      question: {
        kind: "remove_which",
        person: "Operator 1",
        cell: null,
        when: "6 am to 2 pm",
        blocks: [
          {
            id: "blkC2",
            label: "Cell 2 · Housing A 10 am to 2 pm",
            word: "",
            part: "Housing A",
            cell: "Cell 2",
            when: "10 am to 2 pm",
          },
          {
            id: "blk1",
            label: "Cell 1 · Housing A 10 am to 2 pm",
            word: "",
            part: "Housing A",
            cell: "Cell 1",
            when: "10 am to 2 pm",
          },
        ],
      },
    });

    // Neither cell's pattern (only Cell 1 has one) has a band called "9" --
    // no_shift names the first cell WITH a pattern (Cell 1), never the
    // first block's cell (Cell 2, which has none).
    const noMatch = resolveCommand(unassignCmd({ place: [], span: null, shift: "9" }), ctx);
    expect(noMatch).toEqual({
      ok: false,
      question: {
        kind: "no_shift",
        text: "9",
        cell: "Cell 1",
        shifts: ["Shift 1", "Shift 2", "Shift 3"],
      },
    });

    // The all-fail case: NEITHER cell has a pattern at all -- no_shift_
    // pattern, naming the very first block's cell (Cell 2).
    const noPatternAnywhere = resolveCommand(
      unassignCmd({ place: [], span: null, shift: "1" }),
      withBlocks([blkC2], { shiftsAt: () => [] }),
    );
    expect(noPatternAnywhere).toEqual({
      ok: false,
      question: { kind: "no_shift_pattern", cell: "Cell 2" },
    });
  });
});

// ---------------------------------------------------------------------------
// S55 (R-404 to R-410, D130): `expandCommand`'s own fixture, brief §5 --
// three cells (Cell 1, Cell 2 under Line 1; Cell 3 under Line 2), a pattern
// on Line 1 only (Shift 1 06:00-14:00, Shift 2 14:00-22:00), five days,
// today = index 1.
// ---------------------------------------------------------------------------

describe("commandResolve: S55 expandCommand (R-404 to R-410, D130)", () => {
  const zp1 = { id: "zp1", name: "Plant Z", path: "zp1" };
  const zl1 = { id: "zl1", name: "Line 1", path: "zp1.zl1" };
  const zl2 = { id: "zl2", name: "Line 2", path: "zp1.zl2" };
  const zc1 = { id: "zc1", name: "Cell 1", path: "zp1.zl1.zc1" };
  const zc2 = { id: "zc2", name: "Cell 2", path: "zp1.zl1.zc2" };
  const zc3 = { id: "zc3", name: "Cell 3", path: "zp1.zl2.zc3" };
  const zNodeById = new Map([zp1, zl1, zl2, zc1, zc2, zc3].map((n) => [n.id, n]));
  const zCells = [zc1, zc2, zc3];

  const zDays: BoardDay[] = [
    { index: 0, iso: "2026-09-01", weekday: 2 },
    { index: 1, iso: "2026-09-02", weekday: 3 }, // today
    { index: 2, iso: "2026-09-03", weekday: 4 },
    { index: 3, iso: "2026-09-04", weekday: 5 },
    { index: 4, iso: "2026-09-05", weekday: 6 },
  ];

  const zSam = { id: "zsam", displayName: "Sam", employeeRef: null, active: true };
  const zAna = { id: "zana", displayName: "Ana", employeeRef: null, active: true };
  const zLin = { id: "zlin", displayName: "Lin", employeeRef: null, active: true };
  const zOperators = [zSam, zAna, zLin];

  const zHa = { id: "zha", sku: "HA-1", name: "Housing A" };
  const zHb = { id: "zhb", sku: "HB-1", name: "Housing B" };
  const zProducts = [zHa, zHb];

  const zOfferedAt = (): ReadonlyArray<{ id: string }> => [{ id: "zha" }, { id: "zhb" }];

  /** The pattern -- Line 1's own cells only (Cell 1, Cell 2); none on Cell 3
   *  (Line 2). Contiguous, per the brief's own fixture text. */
  const zShiftsAt = (nodeId: string): { name: string; startMin: number; endMin: number }[] =>
    nodeId === "zc1" || nodeId === "zc2"
      ? [
          { name: "Shift 1", startMin: 360, endMin: 840 },
          { name: "Shift 2", startMin: 840, endMin: 1320 },
        ]
      : [];

  const zFitsRun = (
    a: { startMin: number; endMin: number },
    run: { startMin: number; endMin: number },
  ): boolean => a.startMin >= run.startMin && a.endMin <= run.endMin;
  const zOverlaps = (
    a: { startMin: number; endMin: number },
    b: { startMin: number; endMin: number },
  ): boolean => a.startMin < b.endMin && b.startMin < a.endMin;
  const zFindRunOverlap = (
    range: { startMin: number; endMin: number },
    runs: ContextRun[],
    excludeRunId: string | null,
  ): ContextRun | null => {
    for (const r of runs) {
      if (excludeRunId !== null && r.id === excludeRunId) continue;
      if (range.startMin < r.endMin && r.startMin < range.endMin) return r;
    }
    return null;
  };
  const zWallToOffset = (d: number, m: number): number => d * 1440 + m;

  function zCtx(overrides: Partial<ResolveContext> = {}): ResolveContext {
    const finalDays = overrides.days ?? zDays;
    return {
      cells: zCells,
      nodeById: zNodeById,
      operators: zOperators,
      products: zProducts,
      offeredAt: zOfferedAt,
      days: zDays,
      todayIndex: 1,
      // F-191: see baseCtx -- the plant's today, consistent with `todayIndex`.
      todayIso:
        overrides.todayIso ??
        finalDays.find(
          (d) => d.index === (overrides.todayIndex === undefined ? 1 : overrides.todayIndex),
        )?.iso ??
        "2000-01-03",
      wallToOffset: zWallToOffset,
      runs: [],
      fitsRun: zFitsRun,
      minDurationMinutes: 15,
      assignments: [],
      overlaps: zOverlaps,
      findRunOverlap: zFindRunOverlap,
      shiftsAt: zShiftsAt,
      nowMinuteOfDay: null,
      // F-152-b: `clampedWallOf` (top of file) mirrors `time.ts`'s own
      // clamp; without it none of MN13-MN19 below could see the class of
      // bug the maintainer's real board hit.
      wallOf: clampedWallOf(finalDays),
      // S61-b (R-425, F-155): same defaults as `baseCtx` -- no gaps, warn.
      certificateGaps: () => [],
      eligibilityPolicy: () => "warn",
      // R-455 / F-219 (24 Sept, session 191): same default as `baseCtx`.
      settled: true,
      ...overrides,
    };
  }

  function zBlk(overrides: Partial<ContextAssignment> = {}): ContextAssignment {
    return {
      id: "zblk",
      nodeId: "zc1",
      operatorId: "zsam",
      productId: "zha",
      productName: "Housing A",
      startMin: 2 * 1440 + 600, // day 2, 10:00
      endMin: 2 * 1440 + 840, // day 2, 14:00
      label: "10 am to 2 pm",
      runId: null,
      ...overrides,
    };
  }

  function zRun(overrides: Partial<ContextRun> = {}): ContextRun {
    return {
      id: "zrun",
      nodeId: "zc1",
      productId: "zha",
      startMin: 2 * 1440 + 480,
      endMin: 2 * 1440 + 960,
      label: "Housing A 8 am to 4 pm",
      span: "8 am to 4 pm",
      productName: "Housing A",
      headcount: 3,
      ...overrides,
    };
  }

  // -------------------------------------------------------------------------
  // BN1-BN10: boundary names (R-404), inside resolveShiftSpanStep and the
  // place-less path.
  // -------------------------------------------------------------------------

  function zAssign(overrides: Partial<AssignCommand> = {}): AssignCommand {
    return {
      intent: "assign",
      operator: "Sam",
      product: "Housing A",
      place: ["Cell 1"],
      day: { kind: "date", iso: "2026-09-03" }, // index 2, not today
      start: null,
      end: null,
      attach: null,
      existing: null,
      shift: null,
      ...overrides,
    };
  }

  it("BN1: 'all day' -- first band's start to last band's end", () => {
    const res = resolveCommand(zAssign({ shift: "all day" }), zCtx());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.resolved.range).toEqual({ startMin: 2 * 1440 + 360, endMin: 2 * 1440 + 1320 });
    }
  });

  it("BN2: 'end of shift' with a start INSIDE a band -- that band's own end", () => {
    const res = resolveCommand(
      zAssign({ shift: "end of shift", start: { hour: 10, minute: 0 } }),
      zCtx(),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      // Shift 1 06:00-14:00 contains 10:00 -- its own end, 14:00.
      expect(res.resolved.range).toEqual({ startMin: 2 * 1440 + 600, endMin: 2 * 1440 + 840 });
    }
  });

  it("BN3: 'end of shift' with a start BETWEEN bands -- the next band's own end", () => {
    // A gap 14:00-15:00 between Shift 1 and a Shift 2 that starts late.
    const gappy = () => [
      { name: "Shift 1", startMin: 360, endMin: 840 },
      { name: "Shift 2", startMin: 900, endMin: 1320 },
    ];
    const res = resolveCommand(
      zAssign({ shift: "end of shift", start: { hour: 14, minute: 30 } }),
      zCtx({ shiftsAt: gappy }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      // 14:30 falls in the gap -- the next band that starts after it, Shift
      // 2, its own end 22:00.
      expect(res.resolved.range).toEqual({ startMin: 2 * 1440 + 870, endMin: 2 * 1440 + 1320 });
    }
  });

  it("BN4: 'end of shift' with a start AFTER the last band -- no_shift_at", () => {
    const res = resolveCommand(
      zAssign({ shift: "end of shift", start: { hour: 23, minute: 0 } }),
      zCtx(),
    );
    expect(res).toEqual({
      ok: false,
      question: { kind: "no_shift_at", cell: "Cell 1", time: "11 pm" },
    });
  });

  it("BN5: 'end of day' with a pattern -- the last band's own end", () => {
    const res = resolveCommand(
      zAssign({ shift: "end of day", start: { hour: 10, minute: 0 } }),
      zCtx(),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.resolved.range).toEqual({ startMin: 2 * 1440 + 600, endMin: 2 * 1440 + 1320 });
    }
  });

  it("BN6: 'end of day' with NO pattern on the cell -- midnight", () => {
    const res = resolveCommand(
      zAssign({ place: ["Cell 3"], shift: "end of day", start: { hour: 10, minute: 0 } }),
      zCtx(),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.resolved.range).toEqual({ startMin: 2 * 1440 + 600, endMin: 3 * 1440 });
    }
  });

  it("BN7: no start, TODAY -- rounds 'now' up to the next quarter hour", () => {
    const res = resolveCommand(
      zAssign({ day: { kind: "today" }, shift: "end of day" }),
      zCtx({ nowMinuteOfDay: 607 }), // 10:07
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      // 10:07 -> 10:15 (615); end of day with a pattern -> last band's end.
      expect(res.resolved.range).toEqual({ startMin: 1 * 1440 + 615, endMin: 1 * 1440 + 1320 });
    }
  });

  it("BN8: no start, TOMORROW -- an assign asks; a removal covers the whole day", () => {
    const assignRes = resolveCommand(
      zAssign({ day: { kind: "date", iso: "2026-09-03" }, shift: "end of day" }),
      zCtx(),
    );
    expect(assignRes).toEqual({
      ok: false,
      question: { kind: "no_start", text: "Say when it starts — from 10, say." },
    });

    const removalBlock = zBlk({ startMin: 2 * 1440 + 600, endMin: 2 * 1440 + 700 });
    const removalRes = resolveCommand(
      {
        intent: "unassign",
        operator: "Sam",
        place: ["Cell 1"],
        day: { kind: "date", iso: "2026-09-03" },
        span: null,
        shift: "end of day",
        existing: null,
        until: null,
      },
      zCtx({ assignments: [removalBlock] }),
    );
    expect(removalRes.ok).toBe(false);
    if (!removalRes.ok) {
      expect(removalRes.question.kind).toBe("remove_which");
      if (removalRes.question.kind === "remove_which") {
        expect(removalRes.question.when).toBe("midnight to 10 pm"); // whole day, to end of day's own end
      }
    }
  });

  it("DEF-0044 item 5 (mutation-provable): no start, TODAY, 'now' exactly on a quarter hour -- stays exactly there, never rounds a full 15 minutes past", () => {
    // BN7 above only proves the ROUND-UP half (10:07 -> 10:15). This proves
    // the on-the-quarter short-circuit in `roundUpToQuarterHour` (`m % 15
    // === 0 ? m : ...`) by itself: with `nowMinuteOfDay` sitting exactly on
    // :00/:15/:30/:45, deleting that short-circuit (`return m + (15 - r)`
    // unconditionally, `r` computed as `m % 15 || 15`) would push the start
    // a full 15 minutes late even though nothing needed rounding. Frozen
    // clock via `nowMinuteOfDay`, no real `Date`/`Intl` involved (R-426 is
    // not in play here -- this is minute-of-day arithmetic, not a calendar
    // day or an instant).
    const res = resolveCommand(
      zAssign({ day: { kind: "today" }, shift: "end of day" }),
      zCtx({ nowMinuteOfDay: 600 }), // exactly 10:00
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      // 10:00 stays 10:00 (600); end of day with a pattern -> last band's end.
      expect(res.resolved.range).toEqual({ startMin: 1 * 1440 + 600, endMin: 1 * 1440 + 1320 });
    }
  });

  it("BN9: a removal's span end at 23:59 reads as midnight (1440), never 1439", () => {
    // A block sitting exactly in the last minute of the day (23:59-00:00) --
    // matched only when the window's end is read as midnight, never a
    // literal 23:59 (which would exclude it, half-open).
    const edgeBlock = zBlk({ startMin: 2 * 1440 + 1439, endMin: 3 * 1440 });
    const res = resolveCommand(
      {
        intent: "unassign",
        operator: "Sam",
        place: ["Cell 1"],
        day: { kind: "date", iso: "2026-09-03" },
        span: { start: { hour: 9, minute: 0 }, end: { hour: 23, minute: 59 } },
        shift: null,
        existing: null,
        until: null,
      },
      zCtx({ assignments: [edgeBlock] }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.question.kind).toBe("remove_which");
  });

  it("BN10: a boundary word never matches a band literally named 'All Day'", () => {
    const named = () => [
      { name: "All Day", startMin: 0, endMin: 480 },
      { name: "Shift 2", startMin: 480, endMin: 1320 },
    ];
    const res = resolveCommand(zAssign({ shift: "all day" }), zCtx({ shiftsAt: named }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      // The FIRST band's start (0) to the LAST band's end (1320) across
      // every band -- NOT the "All Day" band's own 0-480, which a plain
      // name lookup would have returned.
      expect(res.resolved.range).toEqual({ startMin: 2 * 1440, endMin: 2 * 1440 + 1320 });
    }
  });

  // -------------------------------------------------------------------------
  // F-146: a block that ends exactly at midnight -- `clockToMinuteOfDay`'s
  // own "23:59 reads as 1440" helper, already used by `resolveDaySpanStep`
  // for EVERY intent (not only a removal's span, BN9 above), now actually
  // REACHABLE from the assign/book/move grammars too (parse.ts's own fix:
  // an END spelled "midnight"/"12 am"/"24:00" now writes `DAY_END` instead
  // of failing `time_order`/`bad_time`/`bad_duration`).
  // -------------------------------------------------------------------------

  it("F146-R1: an assign 20:00-DAY_END resolves to endMin at the day's own 1440 offset, not 1439", () => {
    const res = resolveCommand(
      zAssign({
        start: { hour: 20, minute: 0 },
        end: { hour: 23, minute: 59 }, // DAY_END, the one value ClockTime holds
      }),
      zCtx(),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      // Day index 2: 20:00 is 2*1440+1200; midnight (1440) is 3*1440+0, which
      // is the SAME real minute as 2*1440+1440 -- the resolver never reduces
      // mod 1440, so the literal check is against the day's own +1440.
      expect(res.resolved.range).toEqual({ startMin: 2 * 1440 + 1200, endMin: 2 * 1440 + 1440 });
    }
  });

  it("F146-R2: the minimum-duration check still runs against a DAY_END span -- 23:50 to midnight is only 10 minutes", () => {
    const res = resolveCommand(
      zAssign({
        start: { hour: 23, minute: 50 },
        end: { hour: 23, minute: 59 }, // DAY_END -- 23:50 to 24:00 is 10 minutes
      }),
      zCtx({ minDurationMinutes: 15 }),
    );
    expect(res).toEqual({
      ok: false,
      question: { kind: "too_short", minutes: 10, min: 15 },
    });
  });

  it("F146-R3: a book 06:00-DAY_END resolves the same way (the shared resolveDaySpanStep, not an assign-only path)", () => {
    const res = resolveCommand(
      {
        intent: "book",
        product: "Housing A",
        place: ["Cell 1"],
        headcount: null,
        day: { kind: "date", iso: "2026-09-03" },
        start: { hour: 6, minute: 0 },
        end: { hour: 23, minute: 59 },
        existing: null,
        shift: null,
      },
      zCtx(),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.resolved.range).toEqual({ startMin: 2 * 1440 + 360, endMin: 2 * 1440 + 1440 });
    }
  });

  it("F146-R4: a move's own new-hours span to DAY_END resolves the same way", () => {
    const blk = zBlk({ startMin: 2 * 1440 + 600, endMin: 2 * 1440 + 700 });
    const res = resolveCommand(
      {
        intent: "move",
        operator: "Sam",
        place: ["Cell 1"],
        toPlace: null,
        day: { kind: "date", iso: "2026-09-03" },
        span: { start: { hour: 20, minute: 0 }, end: { hour: 23, minute: 59 } },
        existing: null,
        shift: null,
        adjust: null,
      },
      zCtx({ assignments: [blk] }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.resolved.range).toEqual({ startMin: 2 * 1440 + 1200, endMin: 2 * 1440 + 1440 });
    }
  });

  // -------------------------------------------------------------------------
  // EX1-EX6: `everyone` (R-407).
  // -------------------------------------------------------------------------

  describe("EX: everyone", () => {
    it("EX1: clear Cell 1 with two blocks -- a several of two removals, board order, existing filled", () => {
      const blkA = zBlk({
        id: "blkA",
        operatorId: "zsam",
        startMin: 2 * 1440 + 600,
        endMin: 2 * 1440 + 720,
        label: "10 am to noon",
      });
      const blkB = zBlk({
        id: "blkB",
        operatorId: "zana",
        productId: "zhb",
        productName: "Housing B",
        startMin: 2 * 1440 + 780,
        endMin: 2 * 1440 + 900,
        label: "13:00–15:00",
      });
      const command: UnassignCommand = {
        intent: "unassign",
        operator: "everyone",
        place: ["Cell 1"],
        day: { kind: "date", iso: "2026-09-03" },
        span: null,
        shift: null,
        existing: null,
        until: null,
      };
      const res = expandCommand(command, zCtx({ assignments: [blkA, blkB] }));
      expect(res.ok).toBe(true);
      if (res.ok && res.command.intent === "several") {
        expect(res.command.commands).toHaveLength(2);
        const [c1, c2] = res.command.commands as UnassignCommand[];
        expect(c1.operator).toBe("Sam");
        expect(c1.existing).toEqual({ kind: "remove", assignmentId: "blkA" });
        expect(c1.place).toEqual(["Cell 1", "Line 1"]);
        expect(c1.span).toEqual({ start: { hour: 10, minute: 0 }, end: { hour: 12, minute: 0 } });
        expect(c2.operator).toBe("Ana");
        expect(c2.existing).toEqual({ kind: "remove", assignmentId: "blkB" });
      } else {
        throw new Error("expected a several");
      }
    });

    it("EX2: a line -- every cell under it, never a cell on another line", () => {
      const onCell1 = zBlk({ id: "onCell1", nodeId: "zc1" });
      const onCell2 = zBlk({ id: "onCell2", nodeId: "zc2", operatorId: "zana" });
      const onCell3 = zBlk({ id: "onCell3", nodeId: "zc3", operatorId: "zlin" });
      const command: UnassignCommand = {
        intent: "unassign",
        operator: "everyone",
        place: ["Line 1"],
        day: { kind: "date", iso: "2026-09-03" },
        span: null,
        shift: null,
        existing: null,
        until: null,
      };
      const res = expandCommand(command, zCtx({ assignments: [onCell1, onCell2, onCell3] }));
      expect(res.ok).toBe(true);
      if (res.ok && res.command.intent === "several") {
        const ids = (res.command.commands as UnassignCommand[]).map(
          (c) => (c.existing as { assignmentId: string }).assignmentId,
        );
        expect(ids).toEqual(["onCell1", "onCell2"]); // never onCell3 (Line 2)
      } else {
        throw new Error("expected a several");
      }
    });

    // F-213 (R-430): `resolveEveryonePlaceCells` had the SAME textually
    // identical `elsewhere` construction as `resolveCellStep` (R5's own
    // fix) -- naming the mismatched cell as its own container, "Cell 1 is
    // in Cell 1". Both now share one helper, `elsewhereParents`, and this
    // is the EVERYONE/`clear` path's own pin for it: the parent LINE is
    // offered, never the cell again.
    it("EX2b: 'clear Cell 1 in Line 5' -- place_mismatch, Cell 1's own Line 1 offered elsewhere, never Cell 1 itself (F-213)", () => {
      const command: UnassignCommand = {
        intent: "unassign",
        operator: "everyone",
        place: ["Cell 1", "Line 5"],
        day: { kind: "date", iso: "2026-09-03" },
        span: null,
        shift: null,
        existing: null,
        until: null,
      };
      const res = expandCommand(command, zCtx());
      expect(res).toEqual({
        ok: false,
        question: {
          kind: "place_mismatch",
          cell: "Cell 1",
          qualifier: "Line 5",
          elsewhere: [{ id: "zl1", label: "Line 1 — Plant Z", word: "Line 1" }],
        },
      });
      if (!res.ok) {
        expect(describeQuestion(res.question)).toBe(
          "There is no Cell 1 in Line 5. Cell 1 is in Line 1.",
        );
      }
    });

    it("EX3: after 14:00 with a straddling 08:00-16:00 block -- an edge adjust, end to 14:00 (F-152-b, rule 1: never a re-dated span)", () => {
      const straddle = zBlk({
        startMin: 2 * 1440 + 480,
        endMin: 2 * 1440 + 960,
        label: "8 am to 4 pm",
      });
      const command: UnassignCommand = {
        intent: "unassign",
        operator: "everyone",
        place: ["Cell 1"],
        day: { kind: "date", iso: "2026-09-03" },
        span: { start: { hour: 14, minute: 0 }, end: { hour: 23, minute: 59 } },
        shift: null,
        existing: null,
        until: null,
      };
      const res = expandCommand(command, zCtx({ assignments: [straddle] }));
      expect(res.ok).toBe(true);
      if (res.ok && res.command.intent !== "several") {
        const move = res.command as MoveCommand;
        expect(move.intent).toBe("move");
        expect(move.toPlace).toBeNull();
        expect(move.day).toEqual({ kind: "date", iso: "2026-09-03" });
        expect(move.span).toBeNull();
        expect(move.adjust).toEqual({ edge: "end", at: { hour: 14, minute: 0 } });
        expect(move.existing).toEqual({ kind: "move", assignmentId: "zblk" });

        // The adjust resolves to the same 08:00-14:00 kept part the old
        // re-dated span used to name directly.
        const resolved = resolveCommand(move, zCtx({ assignments: [straddle] }));
        expect(resolved.ok).toBe(true);
        if (resolved.ok && resolved.resolved.intent === "move") {
          expect(resolved.resolved.range).toEqual({
            startMin: 2 * 1440 + 480,
            endMin: 2 * 1440 + 840,
          });
        }
      } else {
        throw new Error("expected a single move");
      }
    });

    it("EX4: a block across BOTH edges -- split_needed, nothing built", () => {
      const wide = zBlk({
        startMin: 2 * 1440 + 480,
        endMin: 2 * 1440 + 960,
        label: "8 am to 4 pm",
      });
      const command: UnassignCommand = {
        intent: "unassign",
        operator: "everyone",
        place: ["Cell 1"],
        day: { kind: "date", iso: "2026-09-03" },
        span: { start: { hour: 10, minute: 0 }, end: { hour: 12, minute: 0 } },
        shift: null,
        existing: null,
        until: null,
      };
      const res = expandCommand(command, zCtx({ assignments: [wide] }));
      expect(res).toEqual({
        ok: false,
        question: {
          kind: "split_needed",
          person: "Sam",
          cell: "Cell 1",
          block: "Housing A 8 am to 4 pm",
          span: "10 am to noon",
        },
      });
    });

    it("EX5: nobody on the cell -- nothing_to_do", () => {
      const command: UnassignCommand = {
        intent: "unassign",
        operator: "everyone",
        place: ["Cell 1"],
        day: { kind: "date", iso: "2026-09-03" },
        span: null,
        shift: null,
        existing: null,
        until: null,
      };
      const res = expandCommand(command, zCtx());
      expect(res).toEqual({
        ok: false,
        question: { kind: "nothing_to_do", text: "Cell 1 has nobody on it 2026-09-03." },
      });
    });

    it("EX6: move everyone on Line 1 to Cell 3 -- moves, existing filled", () => {
      const onCell1 = zBlk({ id: "onCell1", nodeId: "zc1" });
      const onCell2 = zBlk({ id: "onCell2", nodeId: "zc2", operatorId: "zana" });
      const command: MoveCommand = {
        intent: "move",
        operator: "everyone",
        place: ["Line 1"],
        toPlace: ["Cell 3"],
        day: { kind: "date", iso: "2026-09-03" },
        span: null,
        shift: null,
        existing: null,
        adjust: null,
      };
      const res = expandCommand(command, zCtx({ assignments: [onCell1, onCell2] }));
      expect(res.ok).toBe(true);
      if (res.ok && res.command.intent === "several") {
        const moves = res.command.commands as MoveCommand[];
        expect(moves).toHaveLength(2);
        expect(moves[0].toPlace).toEqual(["Cell 3"]);
        expect(moves[0].existing).toEqual({ kind: "move", assignmentId: "onCell1" });
        expect(moves[1].existing).toEqual({ kind: "move", assignmentId: "onCell2" });
      } else {
        throw new Error("expected a several");
      }
    });

    // -----------------------------------------------------------------------
    // EX7-EX8 (S70-d, R-436): a clear removes the RUNS on the place/day too,
    // never just the people on them -- the maintainer, 17 Sept: "Unless
    // specified clear means clearing everything," restated 22 Sept after
    // "clear area 1" left the Bracket A job standing. `runRemovals` rides
    // beside `res.command` (see `ResolvedRunRemoval`'s own doc in
    // `resolve.ts` for why it can never be one of `commands`).
    // -----------------------------------------------------------------------

    it("EX7: clear Cell 1 with two people and one job -- a several of the two people, the job listed separately, worded and headcounted", () => {
      const blkA = zBlk({
        id: "blkA",
        operatorId: "zsam",
        startMin: 2 * 1440 + 600,
        endMin: 2 * 1440 + 720,
        label: "10 am to noon",
      });
      const blkB = zBlk({
        id: "blkB",
        operatorId: "zana",
        productId: "zhb",
        productName: "Housing B",
        startMin: 2 * 1440 + 780,
        endMin: 2 * 1440 + 900,
        label: "13:00–15:00",
      });
      const job = zRun({ id: "zrun" }); // default: Housing A, Cell 1, 08:00-16:00, 3 people
      const command: UnassignCommand = {
        intent: "unassign",
        operator: "everyone",
        place: ["Cell 1"],
        day: { kind: "date", iso: "2026-09-03" },
        span: null,
        shift: null,
        existing: null,
        until: null,
      };
      const res = expandCommand(command, zCtx({ assignments: [blkA, blkB], runs: [job] }));
      expect(res.ok).toBe(true);
      if (res.ok && res.command.intent === "several") {
        // The people alone in `commands` -- a run is never a `SingleCommand`.
        expect(res.command.commands).toHaveLength(2);
        const [c1, c2] = res.command.commands as UnassignCommand[];
        expect(c1.operator).toBe("Sam");
        expect(c2.operator).toBe("Ana");
        // The job rides on `runRemovals`, already resolved, after the people.
        expect(res.runRemovals).toHaveLength(1);
        expect(res.runRemovals?.[0]).toEqual({
          intent: "remove_run",
          runId: "zrun",
          readout:
            "The Housing A job is off Cell 1 2026-09-03; that was 8 am to 4 pm, for 3 people.",
          attempted: "The Housing A job on Cell 1",
          notTried: "The Housing A job on Cell 1 stays as it was, 8 am to 4 pm.",
        });
      } else {
        throw new Error("expected a several");
      }
    });

    it("EX8: clear Cell 1 with a job and nobody on it -- the job listed alone, never nothing_to_do", () => {
      const job = zRun({ id: "zrun2" });
      const command: UnassignCommand = {
        intent: "unassign",
        operator: "everyone",
        place: ["Cell 1"],
        day: { kind: "date", iso: "2026-09-03" },
        span: null,
        shift: null,
        existing: null,
        until: null,
      };
      const res = expandCommand(command, zCtx({ assignments: [], runs: [job] }));
      expect(res.ok).toBe(true);
      if (res.ok && res.command.intent === "several") {
        expect(res.command.commands).toHaveLength(0);
        expect(res.runRemovals).toHaveLength(1);
        expect(res.runRemovals?.[0].runId).toBe("zrun2");
        expect(res.runRemovals?.[0].readout).toBe(
          "The Housing A job is off Cell 1 2026-09-03; that was 8 am to 4 pm, for 3 people.",
        );
      } else {
        throw new Error("expected a several (the job alone)");
      }
    });

    it("EX9: a job with no headcount set carries no ' · N people' suffix", () => {
      const job = zRun({ id: "zrun3", headcount: null });
      const command: UnassignCommand = {
        intent: "unassign",
        operator: "everyone",
        place: ["Cell 1"],
        day: { kind: "date", iso: "2026-09-03" },
        span: null,
        shift: null,
        existing: null,
        until: null,
      };
      const res = expandCommand(command, zCtx({ assignments: [], runs: [job] }));
      expect(res.ok).toBe(true);
      if (res.ok && res.command.intent === "several") {
        expect(res.runRemovals?.[0].readout).toBe(
          "The Housing A job is off Cell 1 2026-09-03; that was 8 am to 4 pm.",
        );
      } else {
        throw new Error("expected a several (the job alone)");
      }
    });

    // -------------------------------------------------------------------
    // EX10-EX11 (S70-d review): `deleteRun`'s `cascade` mode has no window
    // of its own -- its SQL is `DELETE FROM assignments WHERE run_id =
    // p_run_id` (migration 20260821000009_api_surface.sql), never scoped
    // to a timerange. A run is gathered into `runRemovals` the moment its
    // OWN timerange overlaps the sentence's (possibly narrower, "this
    // afternoon") window at all -- so, before the reviewer fix above, a
    // crew member's block on that SAME run sitting entirely outside that
    // narrower window was cascaded away without ever being named in the
    // lot the person said yes to. EX10 pins the fix (list it); EX11 pins
    // the null-product wording bug the same review found alongside it.
    // -------------------------------------------------------------------

    it("EX10 (R-436 amended 28 Sept, CONTRACT CHANGED -- the job used to go whole and take this crew block with it): a clear of the afternoon keeps the job's morning, and the crew block wholly in the morning is untouched and said to stay", () => {
      const job = zRun({ id: "zrunB", startMin: 2 * 1440 + 480, endMin: 2 * 1440 + 960 });
      const morningBlk = zBlk({
        id: "morningBlk",
        operatorId: "zsam",
        runId: "zrunB",
        startMin: 2 * 1440 + 480,
        endMin: 2 * 1440 + 600, // 08:00-10:00, outside the afternoon window
        label: "08:00–10:00",
      });
      const command: UnassignCommand = {
        intent: "unassign",
        operator: "everyone",
        place: ["Cell 1"],
        day: { kind: "date", iso: "2026-09-03" },
        span: { start: { hour: 13, minute: 0 }, end: { hour: 17, minute: 0 } }, // afternoon only
        shift: null,
        existing: null,
        until: null,
      };
      const res = expandCommand(command, zCtx({ assignments: [morningBlk], runs: [job] }));
      expect(res.ok).toBe(true);
      if (res.ok && res.command.intent === "several") {
        // Sam's morning block is not touched at all -- no command names it.
        expect(res.command.commands).toHaveLength(0);
        expect(res.runRemovals).toBeUndefined();
        expect(res.runTrims).toEqual([
          {
            intent: "trim_run",
            runId: "zrunB",
            nodeId: "zc1",
            range: { startMin: 2 * 1440 + 480, endMin: 2 * 1440 + 780 },
            readout:
              "The Housing A job on Cell 1 keeps 8 am to 1 pm, and Sam is still on it; the part from 1 pm to 4 pm is cleared.",
            attempted: "The Housing A job on Cell 1",
            notTried: "The Housing A job on Cell 1 stays as it was, 8 am to 4 pm.",
          },
        ]);
      } else {
        throw new Error("expected a several");
      }
    });

    it("EX11 (reviewer fix): a run whose product has been deleted (D110, productName null) reads 'Removing the job', never the doubled 'the job job'", () => {
      const job = zRun({ id: "zrunC", productId: null, productName: null });
      const command: UnassignCommand = {
        intent: "unassign",
        operator: "everyone",
        place: ["Cell 1"],
        day: { kind: "date", iso: "2026-09-03" },
        span: null,
        shift: null,
        existing: null,
        until: null,
      };
      const res = expandCommand(command, zCtx({ assignments: [], runs: [job] }));
      expect(res.ok).toBe(true);
      if (res.ok && res.command.intent === "several") {
        expect(res.runRemovals?.[0].readout).toBe(
          "The job is off Cell 1 2026-09-03; that was 8 am to 4 pm, for 3 people.",
        );
      } else {
        throw new Error("expected a several (the job alone)");
      }
    });

    // -----------------------------------------------------------------------
    // RS-midnight-1..3 (F-199): a block ending exactly at midnight (the
    // START of the next calendar day) read as a removal -- the maintainer,
    // 23 Sept: "Clear, Area 1" answered "1 of 7: That is -840 minutes; a
    // block is at least 15 minutes", four times, removing nothing, on Sam
    // Patel's 14:00-00:00 block. `expandEveryoneUnassign`'s `hoursOfBlock`
    // read the block's END through `clockOfOffset`, which is `ctx.wallOf`'s
    // own `minuteOfDay` (0..1439 by contract) with no DAY_END check at all --
    // a block ending at the NEXT day's 00:00 came back `{hour:0,minute:0}`,
    // the SAME day's own midnight, 14 hours before its own start. The single
    // command `expandEveryoneUnassign` builds is then re-resolved by
    // `resolveUnassignCommand`'s `command.span` branch, which reads that
    // `{0,0}` through `resolveDaySpanStep` -- the same `-840` `too_short`
    // question the maintainer saw. The fix reuses `copyableSpan`'s own
    // DAY_END rule (`expandCopy`, ~4830), never a second one.
    // -----------------------------------------------------------------------

    it("RS-midnight-1: unassign everyone on Cell 1 today, a block 14:00 to midnight -- DAY_END, not -840", () => {
      const midnightBlk = zBlk({
        id: "blkMid",
        operatorId: "zsam",
        startMin: 2 * 1440 + 840, // 14:00 on 2026-09-03 (day index 2)
        endMin: 3 * 1440 + 0, // exactly midnight -- 2026-09-04, day index 3
        label: "14:00–00:00",
      });
      const command: UnassignCommand = {
        intent: "unassign",
        operator: "everyone",
        place: ["Cell 1"],
        day: { kind: "date", iso: "2026-09-03" },
        span: null,
        shift: null,
        existing: null,
        until: null,
      };
      const ctx = zCtx({ assignments: [midnightBlk] });
      const expanded = expandCommand(command, ctx);
      expect(expanded.ok).toBe(true);
      // `wrapMany` returns a lone `SingleCommand` unwrapped, never a
      // one-member `several` -- exactly one block on the cell/day means the
      // built command comes back as an ordinary `unassign` directly.
      if (!expanded.ok || expanded.command.intent !== "unassign") {
        throw new Error("expected a lone unassign");
      }
      const c1 = expanded.command;
      expect(c1.existing).toEqual({ kind: "remove", assignmentId: "blkMid" });
      // The span the several itself carries must already read DAY_END, not
      // the same day's own midnight.
      expect(c1.span).toEqual({ start: { hour: 14, minute: 0 }, end: { hour: 23, minute: 59 } });
      // The real repro: the bar resolves each `several` member on its own --
      // this must not come back `too_short` with `-840`.
      const resolved = resolveCommand(c1, ctx);
      expect(resolved.ok).toBe(true);
      if (resolved.ok) {
        expect(resolved.resolved).toEqual({
          intent: "unassign",
          assignmentId: "blkMid",
          readout: "Sam is off Cell 1 2026-09-03; that was 2 pm to midnight, making Housing A.",
          attempted: "Sam's block on Cell 1",
          notTried: "Sam stays on Cell 1.",
        });
      }
    });

    it("RS-midnight-2: clear Cell 1 today, two blocks, one ending at midnight -- both removed, neither -840", () => {
      const dayBlk = zBlk({
        id: "blkDay",
        operatorId: "zana",
        productId: "zhb",
        productName: "Housing B",
        startMin: 2 * 1440 + 600,
        endMin: 2 * 1440 + 720,
        label: "10 am to noon",
      });
      const midnightBlk = zBlk({
        id: "blkMid",
        operatorId: "zsam",
        startMin: 2 * 1440 + 840, // 14:00
        endMin: 3 * 1440 + 0, // exactly midnight, next day
        label: "14:00–00:00",
      });
      const command: UnassignCommand = {
        intent: "unassign",
        operator: "everyone",
        place: ["Cell 1"],
        day: { kind: "date", iso: "2026-09-03" },
        span: null,
        shift: null,
        existing: null,
        until: null,
      };
      const ctx = zCtx({ assignments: [dayBlk, midnightBlk] });
      const expanded = expandCommand(command, ctx);
      expect(expanded.ok).toBe(true);
      if (!expanded.ok || expanded.command.intent !== "several") {
        throw new Error("expected a several");
      }
      expect(expanded.command.commands).toHaveLength(2);
      const [, c2] = expanded.command.commands as UnassignCommand[];
      expect(c2.existing).toEqual({ kind: "remove", assignmentId: "blkMid" });
      expect(c2.span).toEqual({ start: { hour: 14, minute: 0 }, end: { hour: 23, minute: 59 } });
      for (const c of expanded.command.commands as UnassignCommand[]) {
        const resolved = resolveCommand(c, ctx);
        expect(resolved.ok).toBe(true);
      }
    });

    it("RS-midnight-3: remove Sam Patel from Cell 1 today, the same midnight block -- found and removed, no too_short", () => {
      const midnightBlk = zBlk({
        id: "blkMid",
        operatorId: "zsam",
        startMin: 2 * 1440 + 840,
        endMin: 3 * 1440 + 0,
        label: "14:00–00:00",
      });
      const command: UnassignCommand = {
        intent: "unassign",
        operator: "Sam",
        place: ["Cell 1"],
        day: { kind: "date", iso: "2026-09-03" },
        span: null,
        shift: null,
        existing: null,
        until: null,
      };
      const ctx = zCtx({ assignments: [midnightBlk] });
      const asked = resolveCommand(command, ctx);
      expect(asked.ok).toBe(false);
      if (asked.ok) throw new Error("expected remove_which");
      expect(asked.question.kind).toBe("remove_which");
      const resolved = resolveCommand(
        { ...command, existing: { kind: "remove", assignmentId: "blkMid" } },
        ctx,
      );
      expect(resolved.ok).toBe(true);
      if (resolved.ok) {
        expect(resolved.resolved).toEqual({
          intent: "unassign",
          assignmentId: "blkMid",
          readout: "Sam is off Cell 1 2026-09-03; that was 2 pm to midnight, making Housing A.",
          attempted: "Sam's block on Cell 1",
          notTried: "Sam stays on Cell 1.",
        });
      }
    });

    // -----------------------------------------------------------------------
    // S71-a REVIEW (F-199): adversarial checks on top of RS-midnight-1..3,
    // not part of the author's own pins. Left in place -- both pass.
    // -----------------------------------------------------------------------
    describe("S71-a review", () => {
      it("review-1: the removal is by assignment id, not a trimmable span -- no `span`/`range` field to clip to 23:59", () => {
        const midnightBlk = zBlk({
          id: "blkMid",
          operatorId: "zsam",
          startMin: 2 * 1440 + 840, // 14:00, day index 2
          endMin: 3 * 1440 + 0, // exactly midnight, day index 3
          label: "14:00–00:00",
        });
        const command: UnassignCommand = {
          intent: "unassign",
          operator: "Sam",
          place: ["Cell 1"],
          day: { kind: "date", iso: "2026-09-03" },
          span: null,
          shift: null,
          existing: null,
          until: null,
        };
        const ctx = zCtx({ assignments: [midnightBlk] });
        const asked = resolveCommand(command, ctx);
        expect(asked.ok).toBe(false);
        if (asked.ok) throw new Error("expected remove_which");
        const resolved = resolveCommand(
          { ...command, existing: { kind: "remove", assignmentId: "blkMid" } },
          ctx,
        );
        expect(resolved.ok).toBe(true);
        if (resolved.ok) {
          expect(resolved.resolved).toEqual({
            intent: "unassign",
            assignmentId: "blkMid",
            readout: "Sam is off Cell 1 2026-09-03; that was 2 pm to midnight, making Housing A.",
            attempted: "Sam's block on Cell 1",
            notTried: "Sam stays on Cell 1.",
          });
          expect(resolved.resolved).not.toHaveProperty("span");
          expect(resolved.resolved).not.toHaveProperty("range");
        }
      });

      it("review-2: clear Cell 1 today does not also sweep in a block that STARTS exactly at that midnight (the next calendar day's own block)", () => {
        const midnightBlk = zBlk({
          id: "blkMid",
          operatorId: "zsam",
          startMin: 2 * 1440 + 840, // 14:00 on day 2
          endMin: 3 * 1440 + 0, // midnight -- day 3
          label: "14:00–00:00",
        });
        const nextDayBlk = zBlk({
          id: "blkNext",
          operatorId: "zana",
          productId: "zhb",
          productName: "Housing B",
          startMin: 3 * 1440 + 0, // starts exactly at that same midnight -- day 3's own block
          endMin: 3 * 1440 + 60,
          label: "00:00–01:00",
        });
        const command: UnassignCommand = {
          intent: "unassign",
          operator: "everyone",
          place: ["Cell 1"],
          day: { kind: "date", iso: "2026-09-03" }, // day 2 only
          span: null,
          shift: null,
          existing: null,
          until: null,
        };
        const ctx = zCtx({ assignments: [midnightBlk, nextDayBlk] });
        const expanded = expandCommand(command, ctx);
        expect(expanded.ok).toBe(true);
        if (!expanded.ok) throw new Error("expected ok");
        // Only Sam's midnight-ending block belongs to "today" (day 2); Ana's
        // block, which STARTS at that midnight, is day 3's own block and
        // must not be folded into a "today" clear (whole, edge-adjusted, or
        // otherwise).
        if (expanded.command.intent === "several") {
          const ids = (expanded.command.commands as UnassignCommand[]).map((c) =>
            c.existing && "assignmentId" in c.existing ? c.existing.assignmentId : null,
          );
          expect(ids).toEqual(["blkMid"]);
        } else if (expanded.command.intent === "unassign") {
          expect(expanded.command.existing).toEqual({ kind: "remove", assignmentId: "blkMid" });
        } else {
          throw new Error(`expected unassign or several, got ${expanded.command.intent}`);
        }
      });
    });
  });

  // -------------------------------------------------------------------------
  // RP1-RP4: replace (R-406).
  // -------------------------------------------------------------------------

  describe("RP: replace", () => {
    function replaceCmd(overrides: Partial<ReplaceCommand> = {}): ReplaceCommand {
      return {
        intent: "replace",
        operator: "Sam",
        with: "Ana",
        place: ["Cell 1"],
        day: { kind: "date", iso: "2026-09-03" },
        span: null,
        shift: null,
        ...overrides,
      };
    }

    it("RP1: one direct block -- remove then assign direct", () => {
      const blk = zBlk();
      const res = expandCommand(replaceCmd(), zCtx({ assignments: [blk] }));
      expect(res.ok).toBe(true);
      if (res.ok && res.command.intent === "several") {
        const [removal, assign] = res.command.commands;
        expect(removal.intent).toBe("unassign");
        expect((removal as UnassignCommand).operator).toBe("Sam");
        expect((removal as UnassignCommand).existing).toEqual({
          kind: "remove",
          assignmentId: "zblk",
        });
        expect(assign.intent).toBe("assign");
        expect((assign as AssignCommand).operator).toBe("Ana");
        expect((assign as AssignCommand).product).toBe("Housing A");
        expect((assign as AssignCommand).attach).toEqual({ kind: "direct" });
      } else {
        throw new Error("expected a several of two");
      }
    });

    it("RP2: one block attached to a run -- the new assign attaches the same run", () => {
      const blk = zBlk({ runId: "run9" });
      const res = expandCommand(replaceCmd(), zCtx({ assignments: [blk] }));
      expect(res.ok).toBe(true);
      if (res.ok && res.command.intent === "several") {
        const assign = res.command.commands[1] as AssignCommand;
        expect(assign.attach).toEqual({ kind: "run", runId: "run9" });
      } else {
        throw new Error("expected a several of two");
      }
    });

    it("RP3: two blocks -- four commands, removals first", () => {
      const blk1 = zBlk({ id: "r1", startMin: 2 * 1440 + 360, endMin: 2 * 1440 + 480 });
      const blk2 = zBlk({ id: "r2", startMin: 2 * 1440 + 600, endMin: 2 * 1440 + 720 });
      const res = expandCommand(replaceCmd(), zCtx({ assignments: [blk1, blk2] }));
      expect(res.ok).toBe(true);
      if (res.ok && res.command.intent === "several") {
        const kinds = res.command.commands.map((c) => c.intent);
        expect(kinds).toEqual(["unassign", "unassign", "assign", "assign"]);
      } else {
        throw new Error("expected a several of four");
      }
    });

    it("RP4: Sam with Sam -- nothing_to_do", () => {
      const res = expandCommand(replaceCmd({ with: "Sam" }), zCtx({ assignments: [zBlk()] }));
      expect(res).toEqual({
        ok: false,
        question: { kind: "nothing_to_do", text: "Sam cannot cover for Sam" },
      });
    });

    it("NC6 (S61-b, R-425): Ana's own replace block uncertified -- checked at expansion time (a lot), nothing resolved", () => {
      const blk = zBlk();
      const res = expandCommand(
        replaceCmd(),
        zCtx({
          assignments: [blk],
          certificateGaps: certGapsFixture([
            ["zana", "zc1", [{ skill: "Welding", state: "never-trained" }]],
          ]),
        }),
      );
      expect(res).toEqual({
        ok: false,
        question: {
          kind: "not_certified",
          person: "Ana",
          cell: "Cell 1",
          missing: ["Welding"],
          policy: "warn",
          inLot: true,
        },
      });
    });
  });

  // -------------------------------------------------------------------------
  // SW1-SW3: swap (R-406).
  // -------------------------------------------------------------------------

  describe("SW: swap", () => {
    function swapCmd(overrides: Partial<SwapCommand> = {}): SwapCommand {
      return {
        intent: "swap",
        operator: "Sam",
        other: "Ana",
        place: [],
        day: { kind: "date", iso: "2026-09-03" },
        span: null,
        shift: null,
        ...overrides,
      };
    }

    it("SW1: one block each -- four commands, crossed", () => {
      const samBlk = zBlk({ id: "samBlk", nodeId: "zc1", operatorId: "zsam" });
      const anaBlk = zBlk({
        id: "anaBlk",
        nodeId: "zc2",
        operatorId: "zana",
        productId: "zhb",
        productName: "Housing B",
        startMin: 2 * 1440 + 900,
        endMin: 2 * 1440 + 1020,
        label: "15:00–17:00",
      });
      const res = expandCommand(swapCmd(), zCtx({ assignments: [samBlk, anaBlk] }));
      expect(res.ok).toBe(true);
      if (res.ok && res.command.intent === "several") {
        const cmds = res.command.commands;
        expect(cmds).toHaveLength(4);
        expect(cmds[0].intent).toBe("unassign");
        expect((cmds[0] as UnassignCommand).existing).toEqual({
          kind: "remove",
          assignmentId: "samBlk",
        });
        expect(cmds[1].intent).toBe("unassign");
        expect((cmds[1] as UnassignCommand).existing).toEqual({
          kind: "remove",
          assignmentId: "anaBlk",
        });
        // Sam takes Ana's old block (Housing B, Cell 2, 15:00-17:00).
        expect(cmds[2].intent).toBe("assign");
        expect((cmds[2] as AssignCommand).operator).toBe("Sam");
        expect((cmds[2] as AssignCommand).product).toBe("Housing B");
        expect((cmds[2] as AssignCommand).place).toEqual(["Cell 2", "Line 1"]);
        // Ana takes Sam's old block (Housing A, Cell 1, 10:00-14:00).
        expect(cmds[3].intent).toBe("assign");
        expect((cmds[3] as AssignCommand).operator).toBe("Ana");
        expect((cmds[3] as AssignCommand).product).toBe("Housing A");
        expect((cmds[3] as AssignCommand).place).toEqual(["Cell 1", "Line 1"]);
      } else {
        throw new Error("expected a several of four");
      }
    });

    it("SW2: two blocks for one person -- swap_which", () => {
      const samBlk1 = zBlk({ id: "s1", startMin: 2 * 1440 + 360, endMin: 2 * 1440 + 480 });
      const samBlk2 = zBlk({ id: "s2", startMin: 2 * 1440 + 600, endMin: 2 * 1440 + 720 });
      const anaBlk = zBlk({ id: "anaBlk", operatorId: "zana", nodeId: "zc2" });
      const res = expandCommand(swapCmd(), zCtx({ assignments: [samBlk1, samBlk2, anaBlk] }));
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.question.kind).toBe("swap_which");
    });

    it("SW3: no block for the other person -- no_block", () => {
      const samBlk = zBlk();
      const res = expandCommand(swapCmd(), zCtx({ assignments: [samBlk] }));
      expect(res).toEqual({
        ok: false,
        question: { kind: "no_block", person: "Ana", cell: null, when: "2026-09-03" },
      });
    });

    it("NC5 (S61-b, R-425): the SECOND new block (Ana onto Sam's old Cell 1) uncertified -- the question, at expansion time, nothing resolved", () => {
      const samBlk = zBlk({ id: "samBlk", nodeId: "zc1", operatorId: "zsam" });
      const anaBlk = zBlk({
        id: "anaBlk",
        nodeId: "zc2",
        operatorId: "zana",
        productId: "zhb",
        productName: "Housing B",
        startMin: 2 * 1440 + 900,
        endMin: 2 * 1440 + 1020,
        label: "15:00–17:00",
      });
      const res = expandCommand(
        swapCmd(),
        zCtx({
          assignments: [samBlk, anaBlk],
          // Sam onto Cell 2 (the FIRST new block) is fine -- only Ana onto
          // Cell 1 (the SECOND) has a gap, so the first gate must pass and
          // the second must be the one that asks.
          certificateGaps: certGapsFixture([
            ["zana", "zc1", [{ skill: "Welding", state: "never-trained" }]],
          ]),
        }),
      );
      expect(res).toEqual({
        ok: false,
        question: {
          kind: "not_certified",
          person: "Ana",
          cell: "Cell 1",
          missing: ["Welding"],
          policy: "warn",
          inLot: true,
        },
      });
    });
  });

  // -------------------------------------------------------------------------
  // CP1-CP6: copy (R-408).
  // -------------------------------------------------------------------------

  describe("CP: copy", () => {
    it("CP1: a day onto a day for one cell -- a run becomes a booking, a block a direct assign", () => {
      const run = zRun();
      const blk = zBlk({ nodeId: "zc2", startMin: 2 * 1440 + 600, endMin: 2 * 1440 + 720 });
      const command: CopyCommand = {
        intent: "copy",
        place: ["Cell 1"],
        from: { kind: "date", iso: "2026-09-03" },
        to: { kind: "date", iso: "2026-09-04" },
      };
      const res = expandCommand(command, zCtx({ runs: [run], assignments: [] }));
      expect(res.ok).toBe(true);
      // Exactly one command (the run's own booking) -- wrapMany returns the
      // single command itself, never a one-item several.
      if (res.ok && res.command.intent === "book") {
        const b = res.command;
        expect(b.product).toBe("Housing A");
        expect(b.headcount).toBe(3);
        expect(b.day).toEqual({ kind: "date", iso: "2026-09-04" });
        expect(b.start).toEqual({ hour: 8, minute: 0 });
        expect(b.end).toEqual({ hour: 16, minute: 0 });
        expect(b.place).toEqual(["Cell 1", "Line 1"]);
      } else {
        throw new Error("expected a single book");
      }

      // Blocks on Cell 2 are not touched -- only Cell 1 was named -- so
      // adding one changes nothing about the (still single) result.
      const cellFilteredRes = expandCommand(command, zCtx({ runs: [run], assignments: [blk] }));
      expect(cellFilteredRes.ok).toBe(true);
      if (cellFilteredRes.ok) expect(cellFilteredRes.command.intent).toBe("book");
    });

    it("NC7 (S61-b, R-425): a day onto a day with one uncertified member -- a copy is a lot too, the question names them", () => {
      const srcBlk = zBlk({ startMin: 2 * 1440 + 600, endMin: 2 * 1440 + 720 }); // 10:00-12:00
      const command: CopyCommand = {
        intent: "copy",
        place: ["Cell 1"],
        from: { kind: "date", iso: "2026-09-03" },
        to: { kind: "date", iso: "2026-09-04" },
      };
      const res = expandCommand(
        command,
        zCtx({
          assignments: [srcBlk],
          // Sam, the block's own operator (`zBlk`'s default `operatorId`),
          // lacks Cell 1's Welding -- on the DESTINATION day (index 3),
          // the exact window this copy would place him into.
          certificateGaps: certGapsFixture([
            ["zsam", "zc1", [{ skill: "Welding", state: "never-trained" }]],
          ]),
        }),
      );
      expect(res).toEqual({
        ok: false,
        question: {
          kind: "not_certified",
          person: "Sam",
          cell: "Cell 1",
          missing: ["Welding"],
          policy: "warn",
          inLot: true,
        },
      });
    });

    it("CP2: a block already on the target with the same person/part/hours is skipped", () => {
      const srcBlk = zBlk({ startMin: 2 * 1440 + 600, endMin: 2 * 1440 + 720 });
      const alreadyThere = zBlk({
        id: "already",
        startMin: 3 * 1440 + 600,
        endMin: 3 * 1440 + 720,
      });
      const otherBlk = zBlk({
        id: "other",
        operatorId: "zana",
        startMin: 2 * 1440 + 780,
        endMin: 2 * 1440 + 900,
      });
      const command: CopyCommand = {
        intent: "copy",
        place: ["Cell 1"],
        from: { kind: "date", iso: "2026-09-03" },
        to: { kind: "date", iso: "2026-09-04" },
      };
      const res = expandCommand(command, zCtx({ assignments: [srcBlk, alreadyThere, otherBlk] }));
      expect(res.ok).toBe(true);
      if (res.ok) {
        // Sam's block is skipped (already there); Ana's is copied.
        if (res.command.intent === "several") throw new Error("expected exactly one");
        expect((res.command as AssignCommand).operator).toBe("Ana");
      }
    });

    it("CP3: everything already there -- nothing_to_do", () => {
      const srcBlk = zBlk({ startMin: 2 * 1440 + 600, endMin: 2 * 1440 + 720 });
      const alreadyThere = zBlk({
        id: "already",
        startMin: 3 * 1440 + 600,
        endMin: 3 * 1440 + 720,
      });
      const command: CopyCommand = {
        intent: "copy",
        place: ["Cell 1"],
        from: { kind: "date", iso: "2026-09-03" },
        to: { kind: "date", iso: "2026-09-04" },
      };
      const res = expandCommand(command, zCtx({ assignments: [srcBlk, alreadyThere] }));
      expect(res).toEqual({
        ok: false,
        question: { kind: "nothing_to_do", text: "Cell 1 already matches 2026-09-03." },
      });
    });

    it("CP4/CP5: week onto week pairs Monday to Monday; a week off the board is day_off_board", () => {
      // A 21-day window: last week (Mon 2026-08-24 .. Sun 2026-08-30),
      // this week (Mon 08-31 .. Sun 09-06, today = Wed 09-02), next week
      // (Mon 09-07 .. Sun 09-13).
      const weekIsos = [
        "2026-08-24",
        "2026-08-25",
        "2026-08-26",
        "2026-08-27",
        "2026-08-28",
        "2026-08-29",
        "2026-08-30",
        "2026-08-31",
        "2026-09-01",
        "2026-09-02",
        "2026-09-03",
        "2026-09-04",
        "2026-09-05",
        "2026-09-06",
        "2026-09-07",
        "2026-09-08",
        "2026-09-09",
        "2026-09-10",
        "2026-09-11",
        "2026-09-12",
        "2026-09-13",
      ];
      const weekdays = [1, 2, 3, 4, 5, 6, 0, 1, 2, 3, 4, 5, 6, 0, 1, 2, 3, 4, 5, 6, 0] as const;
      const fullWeekDays: BoardDay[] = weekIsos.map((iso, i) => ({
        index: i,
        iso,
        weekday: weekdays[i],
      }));
      const weekCtx = (days: BoardDay[]) =>
        zCtx({
          days,
          todayIndex: 9,
          assignments: [zBlk({ nodeId: "zc1", startMin: 7 * 1440 + 600, endMin: 7 * 1440 + 720 })],
        });
      // index 7 = Monday of this_week.

      const command: CopyCommand = {
        intent: "copy",
        place: ["Cell 1"],
        from: { kind: "this_week" },
        to: { kind: "next_week" },
      };
      const res = expandCommand(command, weekCtx(fullWeekDays));
      expect(res.ok).toBe(true);
      if (res.ok && res.command.intent !== "several" && res.command.intent === "assign") {
        // Monday (index 7) pairs to next Monday (index 14, 2026-09-07).
        expect(res.command.day).toEqual({ kind: "date", iso: "2026-09-07" });
      } else if (res.ok && res.command.intent === "several") {
        throw new Error("expected exactly one assign (a single block on a single day)");
      }

      // Cut the board off before next week finishes -- day_off_board.
      const partialWeekDays = fullWeekDays.slice(0, 18); // missing index 18-20
      const offBoardRes = expandCommand(command, weekCtx(partialWeekDays));
      expect(offBoardRes).toEqual({
        ok: false,
        question: { kind: "day_off_board", text: "2026-09-11" },
      });
    });

    it("CP6: over the ceiling -- lot_too_big with the count", () => {
      const many: ContextAssignment[] = [];
      for (let i = 0; i < 101; i++) {
        many.push(
          zBlk({
            id: `many${i}`,
            operatorId: i % 2 === 0 ? "zsam" : "zana",
            startMin: 2 * 1440 + 360 + i,
            endMin: 2 * 1440 + 400 + i,
          }),
        );
      }
      const command: CopyCommand = {
        intent: "copy",
        place: [],
        from: { kind: "date", iso: "2026-09-03" },
        to: { kind: "date", iso: "2026-09-04" },
      };
      const res = expandCommand(command, zCtx({ assignments: many }));
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.question.kind).toBe("lot_too_big");
        if (res.question.kind === "lot_too_big") {
          expect(res.question.count).toBe(101);
          expect(res.question.max).toBe(100);
        }
      }
    });

    it("CP6b (reviewer finding): EXACTLY at the ceiling -- 100 commands succeeds (a several of 100), never truncated and never refused", () => {
      const exactly100: ContextAssignment[] = [];
      for (let i = 0; i < 100; i++) {
        exactly100.push(
          zBlk({
            id: `hundred${i}`,
            operatorId: i % 2 === 0 ? "zsam" : "zana",
            startMin: 2 * 1440 + 360 + i,
            endMin: 2 * 1440 + 400 + i,
          }),
        );
      }
      const command: CopyCommand = {
        intent: "copy",
        place: [],
        from: { kind: "date", iso: "2026-09-03" },
        to: { kind: "date", iso: "2026-09-04" },
      };
      const res = expandCommand(command, zCtx({ assignments: exactly100 }));
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.command.intent).toBe("several");
        if (res.command.intent === "several") expect(res.command.commands.length).toBe(100);
      }
    });

    it("CP7 (reviewer finding, 14 Sept follow-up): a week off the board names the right ISO ACROSS A YEAR BOUNDARY -- addDaysToIso's own manual calendar arithmetic, not new Date(...) (commandPurity.test.ts's U1 forbids constructing one at all)", () => {
      // A short window ending 2026-12-31 (today), so `next_week` (which
      // starts the Monday after today's own week) runs off the board and
      // must be named by ADDING days past the window's own last iso --
      // exactly the arithmetic `addDaysToIso` does, crossing Dec 31 into
      // January of the following year.
      const decDays: BoardDay[] = [
        { index: 0, iso: "2026-12-28", weekday: 1 }, // Mon
        { index: 1, iso: "2026-12-29", weekday: 2 },
        { index: 2, iso: "2026-12-30", weekday: 3 },
        { index: 3, iso: "2026-12-31", weekday: 4 }, // today, Thu
      ];
      const command: CopyCommand = {
        intent: "copy",
        place: ["Cell 1"],
        from: { kind: "this_week" },
        to: { kind: "next_week" },
      };
      const res = expandCommand(command, zCtx({ days: decDays, todayIndex: 3 }));
      // this_week's own Monday (2026-12-28) is index 0 -- on the board; its
      // OWN days 4-6 (Fri/Sat/Sun) are already off the board too, so the
      // first missing day is this_week's own Friday, 2027-01-01 -- proving
      // the month AND year both roll over correctly.
      expect(res).toEqual({
        ok: false,
        question: { kind: "day_off_board", text: "2027-01-01" },
      });
    });

    it("CP8 (reviewer finding): a week off the board whose SOURCE week has a block on Sunday and the TARGET week's Sunday specifically is missing -- day_off_board names that exact iso, not a generic 'off the board'", () => {
      // this_week's own Monday MUST be on the board too (resolveWeekDays
      // checks every one of the seven days before this_week even counts as
      // resolved) -- a Monday-anchored 13-day window, today Wednesday
      // (index 2), that stops one day short of next_week's own Sunday.
      const narrowDays: BoardDay[] = [
        { index: 0, iso: "2026-08-31", weekday: 1 }, // Mon, this_week
        { index: 1, iso: "2026-09-01", weekday: 2 },
        { index: 2, iso: "2026-09-02", weekday: 3 }, // today, Wed
        { index: 3, iso: "2026-09-03", weekday: 4 },
        { index: 4, iso: "2026-09-04", weekday: 5 },
        { index: 5, iso: "2026-09-05", weekday: 6 },
        { index: 6, iso: "2026-09-06", weekday: 0 }, // Sun, this_week's own
        { index: 7, iso: "2026-09-07", weekday: 1 }, // Mon, next_week
        { index: 8, iso: "2026-09-08", weekday: 2 },
        { index: 9, iso: "2026-09-09", weekday: 3 },
        { index: 10, iso: "2026-09-10", weekday: 4 },
        { index: 11, iso: "2026-09-11", weekday: 5 },
        { index: 12, iso: "2026-09-12", weekday: 6 },
        // 2026-09-13 (next_week's own Sunday) deliberately missing.
      ];
      const sourceSundayBlock = zBlk({
        nodeId: "zc1",
        startMin: 6 * 1440 + 600,
        endMin: 6 * 1440 + 840,
      });
      const command: CopyCommand = {
        intent: "copy",
        place: ["Cell 1"],
        from: { kind: "this_week" },
        to: { kind: "next_week" },
      };
      const res = expandCommand(
        command,
        zCtx({ days: narrowDays, todayIndex: 2, assignments: [sourceSundayBlock] }),
      );
      expect(res).toEqual({
        ok: false,
        question: { kind: "day_off_board", text: "2026-09-13" },
      });
    });

    it("CP9 (reviewer finding, 14 Sept follow-up, probing 'wallOf on a block spanning midnight'): a genuinely overnight run (22:00-02:00) cannot be written as one book command and is skipped, never a negative-duration question", () => {
      const overnightRun = zRun({
        startMin: 2 * 1440 + 1320, // 22:00 on 2026-09-03 (day index 2)
        endMin: 3 * 1440 + 120, // 02:00 on 2026-09-04 (day index 3)
        span: "22:00-02:00",
      });
      const command: CopyCommand = {
        intent: "copy",
        place: ["Cell 1"],
        from: { kind: "date", iso: "2026-09-03" },
        to: { kind: "date", iso: "2026-09-04" },
      };
      const res = expandCommand(command, zCtx({ runs: [overnightRun] }));
      // Nothing else to copy from that day/cell -- skipped down to nothing,
      // never a `too_short` question with a negative minute count.
      expect(res).toEqual({
        ok: false,
        question: { kind: "nothing_to_do", text: "Cell 1 already matches 2026-09-03." },
      });
    });

    it("CP10 (reviewer finding): a block ending EXACTLY at midnight copies as an ordinary DAY_END assign, and the written command resolves cleanly", () => {
      const midnightBlock = zBlk({
        startMin: 2 * 1440 + 1200, // 20:00 on 2026-09-03 (day index 2)
        endMin: 3 * 1440 + 0, // exactly midnight -- 2026-09-04, day index 3
      });
      const command: CopyCommand = {
        intent: "copy",
        place: ["Cell 1"],
        from: { kind: "date", iso: "2026-09-03" },
        to: { kind: "date", iso: "2026-09-04" },
      };
      const ctxWithBlock = zCtx({ assignments: [midnightBlock] });
      const res = expandCommand(command, ctxWithBlock);
      expect(res.ok).toBe(true);
      if (res.ok && res.command.intent === "assign") {
        expect(res.command.start).toEqual({ hour: 20, minute: 0 });
        expect(res.command.end).toEqual({ hour: 23, minute: 59 }); // DAY_END
        const resolved = resolveCommand(res.command, ctxWithBlock);
        expect(resolved.ok).toBe(true);
        if (resolved.ok) {
          expect(resolved.resolved.range).toEqual({
            startMin: 3 * 1440 + 1200,
            endMin: 4 * 1440,
          });
        }
      } else {
        throw new Error("expected a single assign");
      }
    });
  });

  // -------------------------------------------------------------------------
  // AB1-AB3: an absence with `until` (R-409).
  // -------------------------------------------------------------------------

  describe("AB: absence with until", () => {
    it("AB1: three days, two blocks on two of them -- two removals", () => {
      const blkDay1 = zBlk({
        id: "d1",
        nodeId: "zc1",
        startMin: 1 * 1440 + 600,
        endMin: 1 * 1440 + 720,
      });
      const blkDay3 = zBlk({
        id: "d3",
        nodeId: "zc2",
        startMin: 3 * 1440 + 600,
        endMin: 3 * 1440 + 720,
      });
      const command: UnassignCommand = {
        intent: "unassign",
        operator: "Sam",
        place: [],
        day: { kind: "date", iso: "2026-09-02" }, // index 1
        span: null,
        shift: null,
        existing: null,
        until: { kind: "date", iso: "2026-09-04" }, // index 3
      };
      const res = expandCommand(command, zCtx({ assignments: [blkDay1, blkDay3] }));
      expect(res.ok).toBe(true);
      if (res.ok && res.command.intent === "several") {
        expect(res.command.commands).toHaveLength(2);
        expect((res.command.commands[0] as UnassignCommand).existing).toEqual({
          kind: "remove",
          assignmentId: "d1",
        });
        expect((res.command.commands[1] as UnassignCommand).existing).toEqual({
          kind: "remove",
          assignmentId: "d3",
        });
      } else {
        throw new Error("expected a several of two");
      }
    });

    it("AB2: until before the day -- day_order", () => {
      const command: UnassignCommand = {
        intent: "unassign",
        operator: "Sam",
        place: [],
        day: { kind: "date", iso: "2026-09-04" },
        span: null,
        shift: null,
        existing: null,
        until: { kind: "date", iso: "2026-09-02" },
      };
      const res = expandCommand(command, zCtx());
      expect(res).toEqual({
        ok: false,
        question: { kind: "day_order", first: "2026-09-04", second: "2026-09-02" },
      });
    });

    it("AB3: nothing over the whole range -- nothing_to_do", () => {
      const command: UnassignCommand = {
        intent: "unassign",
        operator: "Sam",
        place: [],
        day: { kind: "date", iso: "2026-09-02" },
        span: null,
        shift: null,
        existing: null,
        until: { kind: "date", iso: "2026-09-04" },
      };
      const res = expandCommand(command, zCtx());
      expect(res).toEqual({
        ok: false,
        question: {
          kind: "nothing_to_do",
          // S194-D (item 8 of the bar's half, CONTRACT CHANGED): an absence with the
          text:
            // recordable set unknown says it was not recorded, and why.
            "Sam has no block from 2026-09-02 to 2026-09-04; the absence is not recorded, because I could not check whether you may record it.",
        },
      });
    });
  });

  // -------------------------------------------------------------------------
  // AJ1-AJ11: adjust (R-412, D132 item 1) -- inside resolveMoveCommand.
  // -------------------------------------------------------------------------

  describe("AJ: adjust", () => {
    function adjustMove(overrides: Partial<MoveCommand> = {}): MoveCommand {
      return {
        intent: "move",
        operator: "Sam",
        place: ["Cell 1"],
        toPlace: null,
        day: { kind: "date", iso: "2026-09-03" },
        span: null,
        shift: null,
        existing: null,
        adjust: null,
        ...overrides,
      };
    }

    it("AJ1: extend -- the end moves later by a positive `by`", () => {
      const res = resolveCommand(
        adjustMove({ adjust: { edge: "end", by: 60 } }),
        zCtx({ assignments: [zBlk()] }),
      );
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.resolved.range).toEqual({ startMin: 2 * 1440 + 600, endMin: 2 * 1440 + 900 });
        expect(res.resolved.target).toEqual({ kind: "retime" });
      }
    });

    it("AJ2: shorten -- a negative `by` on the end shortens", () => {
      const res = resolveCommand(
        adjustMove({ adjust: { edge: "end", by: -60 } }),
        zCtx({ assignments: [zBlk()] }),
      );
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.resolved.range).toEqual({ startMin: 2 * 1440 + 600, endMin: 2 * 1440 + 780 });
      }
    });

    it("AJ3: end at -- the end is set to a wall-clock time on the block's own day", () => {
      const res = resolveCommand(
        adjustMove({ adjust: { edge: "end", at: { hour: 15, minute: 30 } } }),
        zCtx({ assignments: [zBlk()] }),
      );
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.resolved.range).toEqual({ startMin: 2 * 1440 + 600, endMin: 2 * 1440 + 930 });
      }
    });

    it('AJ3b (S72-d review, R-459/F-146): "end ... at midnight" -- an explicit DAY_END target ({23, 59}, parse.ts\'s own literal) reads as "midnight" in the sentence, never "11:59 pm"', () => {
      // `adjust.at` holds parse.ts's DAY_END constant LITERALLY for a
      // spoken "midnight"/"12 am"/"24:00" end (resolve.ts's own comment on
      // `resolveMoveCommand`'s `adjustReadout.newClock`), never normalized
      // through `clockOfOffset`'s 1440-wraps-to-0 the way a plain range clip
      // is. `spokenClock` (resolve.ts) special-cased only literal {0, 0}
      // before this pin -- {23, 59} fell through to the ordinary am/pm
      // branch and printed "11:59 pm", contradicting both this function's
      // own doc comment ("DAY_END included, reads back as 'midnight'") and
      // parse.ts's OWN twin special case (`formatClock`, parse.ts ~4089).
      const res = resolveCommand(
        adjustMove({ adjust: { edge: "end", at: { hour: 23, minute: 59 } } }),
        zCtx({ assignments: [zBlk()] }),
      );
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.resolved.readout).toBe("Sam's block on Cell 1 now ends midnight; it was 2 pm.");
      }
    });

    it('AJ3c (S72-d review, R-459): a minute-precision hour reads "10:30 am", not "10:0 am"/"10:3 am" -- `spokenClock`\'s own zero-padded minute, pinned end to end', () => {
      // Bar-sentences.md's own R-459 doc names "10:30 am" as the worked
      // example of a non-zero-minute clock (CLAUDE.md §0/the brief's own
      // register), and no pin anywhere in this suite or `commandBar.test.tsx`
      // exercised a non-zero minute through `spokenClock` before this one --
      // every existing readout/adjust fixture happens to land on the hour.
      const res = resolveCommand(
        adjustMove({ adjust: { edge: "end", at: { hour: 10, minute: 30 } } }),
        zCtx({ assignments: [zBlk()] }),
      );
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.resolved.readout).toBe("Sam's block on Cell 1 now ends 10:30 am; it was 2 pm.");
      }
    });

    it("AJ4: start at -- the start is set to a wall-clock time", () => {
      const res = resolveCommand(
        adjustMove({ adjust: { edge: "start", at: { hour: 9, minute: 0 } } }),
        zCtx({ assignments: [zBlk()] }),
      );
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.resolved.range).toEqual({ startMin: 2 * 1440 + 540, endMin: 2 * 1440 + 840 });
      }
    });

    it("AJ5: a negative `by` on the start -- it starts earlier", () => {
      const res = resolveCommand(
        adjustMove({ adjust: { edge: "start", by: -60 } }),
        zCtx({ assignments: [zBlk()] }),
      );
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.resolved.range).toEqual({ startMin: 2 * 1440 + 540, endMin: 2 * 1440 + 840 });
      }
    });

    it("AJ6: a positive `by` on the start -- it starts later", () => {
      const res = resolveCommand(
        adjustMove({ adjust: { edge: "start", by: 60 } }),
        zCtx({ assignments: [zBlk()] }),
      );
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.resolved.range).toEqual({ startMin: 2 * 1440 + 660, endMin: 2 * 1440 + 840 });
      }
    });

    it("AJ7: inverted -- the new end would fall at or before the new start", () => {
      const res = resolveCommand(
        adjustMove({ adjust: { edge: "end", by: -300 } }),
        zCtx({ assignments: [zBlk()] }),
      );
      expect(res).toEqual({
        ok: false,
        question: {
          kind: "adjust_inverts",
          person: "Sam",
          block: "Housing A 10 am to 2 pm",
        },
      });
    });

    it("AJ8: too short -- the new span is under the minimum", () => {
      const res = resolveCommand(
        adjustMove({ adjust: { edge: "end", by: -230 } }),
        zCtx({ assignments: [zBlk()], minDurationMinutes: 15 }),
      );
      expect(res).toEqual({
        ok: false,
        question: { kind: "too_short", minutes: 10, min: 15 },
      });
    });

    it("AJ9: off the day -- the new range would cross the block's own day's midnight", () => {
      const res = resolveCommand(
        adjustMove({ adjust: { edge: "start", by: -700 } }),
        zCtx({ assignments: [zBlk()] }),
      );
      expect(res).toEqual({
        ok: false,
        question: {
          kind: "adjust_off_day",
          person: "Sam",
          block: "Housing A 10 am to 2 pm",
        },
      });
    });

    it("AJ10: which block, when several overlap the day -- move_which, same as an ordinary move", () => {
      const blkA = zBlk({
        id: "a",
        startMin: 2 * 1440 + 480,
        endMin: 2 * 1440 + 600,
        label: "08:00–10:00",
      });
      const blkB = zBlk({
        id: "b",
        startMin: 2 * 1440 + 720,
        endMin: 2 * 1440 + 840,
        label: "noon to 2 pm",
      });
      const res = resolveCommand(
        adjustMove({ adjust: { edge: "end", by: 30 } }),
        zCtx({ assignments: [blkA, blkB] }),
      );
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.question.kind).toBe("move_which");
    });

    it("AJ11: adjust with a destination, a span or a shift -- bad_adjust, one line (the grammar never produces it)", () => {
      const withToPlace = resolveCommand(
        adjustMove({ adjust: { edge: "end", by: 60 }, toPlace: ["Cell 2"] }),
        zCtx(),
      );
      expect(withToPlace.ok).toBe(false);
      if (!withToPlace.ok) expect(withToPlace.question.kind).toBe("bad_adjust");

      const withSpan = resolveCommand(
        adjustMove({
          adjust: { edge: "end", by: 60 },
          span: { start: { hour: 9, minute: 0 }, end: { hour: 10, minute: 0 } },
        }),
        zCtx(),
      );
      expect(withSpan.ok).toBe(false);
      if (!withSpan.ok) expect(withSpan.question.kind).toBe("bad_adjust");

      const withShift = resolveCommand(
        adjustMove({ adjust: { edge: "end", by: 60 }, shift: "1" }),
        zCtx(),
      );
      expect(withShift.ok).toBe(false);
      if (!withShift.ok) expect(withShift.question.kind).toBe("bad_adjust");
    });
  });

  // -------------------------------------------------------------------------
  // SP1-SP5: split (R-413, D132 item 2) -- in expandCommand.
  // -------------------------------------------------------------------------

  describe("SP: split", () => {
    function splitCmd(overrides: Partial<SplitCommand> = {}): SplitCommand {
      return {
        intent: "split",
        operator: "Sam",
        place: ["Cell 1"],
        day: { kind: "date", iso: "2026-09-03" },
        at: { hour: 12, minute: 0 },
        ...overrides,
      };
    }

    it("SP1: a direct block -- a move in time (first half) then an assign (second half), move first", () => {
      const res = expandCommand(splitCmd(), zCtx({ assignments: [zBlk()] }));
      expect(res.ok).toBe(true);
      if (res.ok && res.command.intent === "several") {
        const [move, assign] = res.command.commands;
        expect(move.intent).toBe("move");
        const m = move as MoveCommand;
        expect(m.existing).toEqual({ kind: "move", assignmentId: "zblk" });
        expect(m.span).toEqual({ start: { hour: 10, minute: 0 }, end: { hour: 12, minute: 0 } });
        expect(m.adjust).toBeNull();
        expect(assign.intent).toBe("assign");
        const a = assign as AssignCommand;
        expect(a.start).toEqual({ hour: 12, minute: 0 });
        expect(a.end).toEqual({ hour: 14, minute: 0 });
        expect(a.attach).toEqual({ kind: "direct" });
      } else {
        throw new Error("expected a several of two");
      }
    });

    it("SP2: a run-attached block -- the second half keeps the same attachment", () => {
      const res = expandCommand(splitCmd(), zCtx({ assignments: [zBlk({ runId: "run9" })] }));
      expect(res.ok).toBe(true);
      if (res.ok && res.command.intent === "several") {
        const assign = res.command.commands[1] as AssignCommand;
        expect(assign.attach).toEqual({ kind: "run", runId: "run9" });
      } else {
        throw new Error("expected a several of two");
      }
    });

    it("SP3: `at` outside the block -- split_outside, nothing built", () => {
      const res = expandCommand(
        splitCmd({ at: { hour: 7, minute: 0 } }),
        zCtx({ assignments: [zBlk()] }),
      );
      expect(res).toEqual({
        ok: false,
        question: {
          kind: "split_outside",
          person: "Sam",
          at: "7 am",
          blocks: ["Housing A 10 am to 2 pm"],
        },
      });
    });

    it("SP4: a part too short -- too_short, neither half built", () => {
      const shortBlk = zBlk({
        startMin: 2 * 1440 + 600,
        endMin: 2 * 1440 + 620,
        label: "10:00–10:20",
      });
      const res = expandCommand(
        splitCmd({ at: { hour: 10, minute: 10 } }),
        zCtx({ assignments: [shortBlk] }),
      );
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.question.kind).toBe("too_short");
    });

    it("SP5: no block at all -- no_block, cell named", () => {
      const res = expandCommand(splitCmd(), zCtx());
      expect(res).toEqual({
        ok: false,
        question: { kind: "no_block", person: "Sam", cell: "Cell 1", when: "2026-09-03" },
      });
    });

    // ---------------------------------------------------------------------
    // SP6-SP7 (reviewer fix, S58-b lane review): D127's "never write before
    // the yes" means `CommandBar`'s `resolveLotStep` resolves EVERY member of
    // a lot against the SAME unwritten `ctx` -- the split's own move (first
    // half) has not actually shrunk the block by the time the assign (second
    // half) is resolved, so the block sits in `ctx.assignments` at its FULL
    // original length the whole time. The second half's own new range always
    // falls entirely inside that still-full block -- same person, same
    // product, same cell -- so `resolveAssignCommand`'s own R-385 own-block
    // step (own.length > 0) would ask `block_exists` on every single split,
    // reproduced below with `existing: null` (a caller's own bug, never a
    // crash -- but never a working split either). The S58-b fix was
    // `existing: { kind: "separate" }` on the assign -- R-385's own "add a
    // separate block" answer -- but that silenced the own-block question for
    // EVERY overlapping block of the same person/part/cell, not only the
    // block being split (CB-y-9, two S58 reviewers). S58-e (R-413) narrows it
    // to `existing: { kind: "separate_from", assignmentId: blk.id }`: only
    // the named block is exempted, so a genuine second block still asks
    // (SP9), and nothing left over falls through exactly as `separate` did
    // (SP10).
    // ---------------------------------------------------------------------

    it("SP6: a direct block's two halves BOTH resolve against the pre-split ctx (the lot's own contract)", () => {
      const ctx = zCtx({ assignments: [zBlk()] });
      const exp = expandCommand(splitCmd(), ctx);
      expect(exp.ok).toBe(true);
      if (!exp.ok || exp.command.intent !== "several") throw new Error("expected a several of two");
      const [move, assign] = exp.command.commands;

      const moveRes = resolveCommand(move as MoveCommand, ctx);
      expect(moveRes.ok).toBe(true);

      // The bug this pins: resolving the assign against the SAME ctx (the
      // block has not actually been shrunk yet) must NOT see the split's own
      // full-length source block as a rival -- `existing: { kind:
      // "separate_from", assignmentId: "zblk" }` (S58-e) is what keeps the
      // own-block step from firing on THAT block while still leaving a
      // genuine second block able to ask (SP9 below).
      expect((assign as AssignCommand).existing).toEqual({
        kind: "separate_from",
        assignmentId: "zblk",
      });
      const assignRes = resolveCommand(assign as AssignCommand, ctx);
      expect(assignRes.ok).toBe(true);
      if (assignRes.ok) {
        expect(assignRes.resolved.range).toEqual({
          startMin: 2 * 1440 + 720,
          endMin: 2 * 1440 + 840,
        });
        expect(assignRes.resolved.target).toEqual({ kind: "direct", productId: "zha" });
      }
    });

    it("SP7: a run-attached block's second half resolves its target to the SAME run, through resolveCommand", () => {
      const run = zRun({ id: "run9", startMin: 2 * 1440 + 480, endMin: 2 * 1440 + 960 });
      const ctx = zCtx({ assignments: [zBlk({ runId: "run9" })], runs: [run] });
      const exp = expandCommand(splitCmd(), ctx);
      expect(exp.ok).toBe(true);
      if (!exp.ok || exp.command.intent !== "several") throw new Error("expected a several of two");
      const assign = exp.command.commands[1] as AssignCommand;
      const res = resolveCommand(assign, ctx);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.resolved.target).toEqual({ kind: "run", runId: "run9" });
    });

    it("SP8 (reviewer fix): a block ending exactly at the day's own end -- the second half's `end` is DAY_END, not midnight", () => {
      // F146: a block CAN legitimately end at the day's own 1440th minute
      // ("20:00 to DAY_END"). `hoursOfBlock`'s own `clockOfOffset` read that
      // through `ctx.wallOf` (whose `minuteOfDay` is always 0..1439) as
      // `{ hour: 0, minute: 0 }` -- midnight of THIS day, not the day's own
      // end -- so the second half's `end` silently read as EARLIER than its
      // own `start` once re-resolved, surfacing as `too_short` with a
      // negative count instead of the split completing.
      const blk = zBlk({
        startMin: 2 * 1440 + 1200,
        endMin: 2 * 1440 + 1440,
        label: "20:00–23:59",
      });
      const ctx = zCtx({ assignments: [blk] });
      const exp = expandCommand(splitCmd({ at: { hour: 22, minute: 0 } }), ctx);
      expect(exp.ok).toBe(true);
      if (!exp.ok || exp.command.intent !== "several") throw new Error("expected a several of two");
      const assign = exp.command.commands[1] as AssignCommand;
      expect(assign.end).toEqual({ hour: 23, minute: 59 });
      const res = resolveCommand(assign, ctx);
      expect(res.ok).toBe(true);
      if (res.ok)
        expect(res.resolved.range).toEqual({ startMin: 2 * 1440 + 1320, endMin: 2 * 1440 + 1440 });
    });

    // -----------------------------------------------------------------------
    // SP9-SP10 (S58-e, R-413, docs/agent-briefs/s58-e-split-separate-brief.md
    // §3): `separate_from` exempts ONLY the block named on it, so the
    // own-block step still catches a genuine second overlapping block
    // (CB-y-9's own bug) while a split with nothing else there still
    // resolves fresh, exactly as SP6 did under the old blanket `separate`.
    // -----------------------------------------------------------------------

    it("SP9: a second overlapping block of the same person/part/cell -- block_exists naming the OTHER block only", () => {
      const other = zBlk({
        id: "zblk2",
        startMin: 2 * 1440 + 780, // 13:00
        endMin: 2 * 1440 + 900, // 15:00
        label: "13:00–15:00",
      });
      const ctx = zCtx({ assignments: [zBlk(), other] });
      const exp = expandCommand(splitCmd(), ctx);
      expect(exp.ok).toBe(true);
      if (!exp.ok || exp.command.intent !== "several") throw new Error("expected a several of two");
      const assign = exp.command.commands[1] as AssignCommand;
      expect(assign.existing).toEqual({ kind: "separate_from", assignmentId: "zblk" });

      const res = resolveCommand(assign, ctx);
      expect(res).toEqual({
        ok: false,
        question: {
          kind: "block_exists",
          person: "Sam",
          product: "Housing A",
          cell: "Cell 1",
          span: "noon to 2 pm",
          blocks: [{ id: "zblk2", label: "13:00–15:00", word: "" }],
          same: false,
        },
      });
    });

    it("SP10: no OTHER block remains once the source block is removed -- resolves fresh, as SP6", () => {
      // A non-overlapping block of the same person/part/cell elsewhere in the
      // day proves the fall-through is about overlap, not merely "some other
      // assignment exists somewhere".
      const elsewhere = zBlk({
        id: "zblk3",
        startMin: 2 * 1440 + 60, // 01:00
        endMin: 2 * 1440 + 120, // 02:00
        label: "01:00–02:00",
      });
      const ctx = zCtx({ assignments: [zBlk(), elsewhere] });
      const exp = expandCommand(splitCmd(), ctx);
      expect(exp.ok).toBe(true);
      if (!exp.ok || exp.command.intent !== "several") throw new Error("expected a several of two");
      const assign = exp.command.commands[1] as AssignCommand;
      expect(assign.existing).toEqual({ kind: "separate_from", assignmentId: "zblk" });

      const res = resolveCommand(assign, ctx);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.resolved.range).toEqual({ startMin: 2 * 1440 + 720, endMin: 2 * 1440 + 840 });
        expect(res.resolved.target).toEqual({ kind: "direct", productId: "zha" });
      }
    });
  });

  // -------------------------------------------------------------------------
  // MN1-MN19: F-152 (docs/agent-briefs/f-152-midnight-remainder-brief.md,
  // docs/agent-briefs/f-152-b-window-edge-brief.md). "clear Cell 1 today" on
  // a block that crosses midnight used to date the KEPT part by the
  // sentence's own day, never the day it itself starts on, so
  // `resolveDaySpanStep` read the rendered clock pair as negative (the first
  // fix, MN1-MN12). That fix still failed on the maintainer's real board: a
  // block starting BEFORE the window clamps under the real `wallOf`
  // (`zClampedWallOf` below mirrors it), so `copyableSpan` called it
  // representable and rendered a still-wrong clock pair. The second fix
  // (MN13-MN19) makes the kept part an EDGE ADJUST on the sentence's own
  // day instead -- no `wallOf` read on the block's own untouched edge at
  // all -- and guards every WHOLE-block builder with `edgeOnBoard` first.
  // `zDays` (index 0 = 2026-09-01 .. index 4 = 2026-09-05, today = index 1)
  // spans five days -- MN1/MN4 lean on index -1/0 (off the left edge) and
  // MN2 on index 3 (tomorrow of "today" = index 2) to prove the fix without
  // a separate fixture. Every span below is `zWallToOffset`/`zWallOf`
  // arithmetic, never a hand-summed minute count.
  // -------------------------------------------------------------------------

  describe("MN: F-152 midnight remainder", () => {
    it("MN1: yesterday 02:00 to today 06:00, clear today -- a several of two: an edge adjust dated TODAY (end to 00:00), the other block removed", () => {
      const overnight = zBlk({
        id: "mn1a",
        startMin: zWallToOffset(1, 120), // 2026-09-02 (index 1) 02:00
        endMin: zWallToOffset(2, 360), // 2026-09-03 (index 2) 06:00
        label: "02:00–06:00",
      });
      const sameDay = zBlk({
        id: "mn1b",
        operatorId: "zana",
        startMin: zWallToOffset(2, 600), // today 10:00
        endMin: zWallToOffset(2, 720), // today 12:00
        label: "10 am to noon",
      });
      const command: UnassignCommand = {
        intent: "unassign",
        operator: "everyone",
        place: ["Cell 1"],
        day: { kind: "date", iso: "2026-09-03" },
        span: null,
        shift: null,
        existing: null,
        until: null,
      };
      const ctx = zCtx({ assignments: [overnight, sameDay] });
      // R-461 (28 Sept, CONTRACT CHANGED): the block crosses today's first
      // midnight, so the clear asks about yesterday's part before anything
      // is built; the trim below is the answer No ("keep").
      const asked = expandCommand(command, ctx);
      expect(asked).toMatchObject({
        ok: false,
        question: { kind: "other_day_part", direction: "previous" },
      });
      const res = expandCommand(command, ctx, { previousDayPart: "keep" });
      expect(res.ok).toBe(true);
      if (res.ok && res.command.intent === "several") {
        expect(res.command.commands).toHaveLength(2);
        const [move, remove] = res.command.commands;
        expect(move.intent).toBe("move");
        const m = move as MoveCommand;
        // F-152-b, rule 1: dated the SENTENCE's own day (never re-dated to
        // "yesterday" -- that read is exactly what clamped and broke on
        // the real board), span null, an edge adjust instead.
        expect(m.day).toEqual({ kind: "date", iso: "2026-09-03" });
        expect(m.span).toBeNull();
        expect(m.adjust).toEqual({ edge: "end", at: { hour: 0, minute: 0 } });
        expect(m.existing).toEqual({ kind: "move", assignmentId: "mn1a" });
        expect(remove.intent).toBe("unassign");
        expect((remove as UnassignCommand).existing).toEqual({
          kind: "remove",
          assignmentId: "mn1b",
        });

        // Resolved, the block's own untouched start (02:00 yesterday) and
        // its new end (00:00 today) come back as real minutes, no question.
        const moveRes = resolveCommand(m, ctx);
        expect(moveRes.ok).toBe(true);
        if (moveRes.ok && moveRes.resolved.intent === "move") {
          expect(moveRes.resolved.range).toEqual({
            startMin: zWallToOffset(1, 120),
            endMin: zWallToOffset(2, 0),
          });
        }
      } else {
        throw new Error("expected a several of two");
      }
    });

    it("MN2: today 22:00 to tomorrow 06:00, clear today -- an edge adjust dated today (start to DAY_END)", () => {
      const overnight = zBlk({
        id: "mn2",
        startMin: zWallToOffset(2, 1320), // today 22:00
        endMin: zWallToOffset(3, 360), // tomorrow (index 3) 06:00
        label: "10 pm to 6 am",
      });
      const command: UnassignCommand = {
        intent: "unassign",
        operator: "everyone",
        place: ["Cell 1"],
        day: { kind: "date", iso: "2026-09-03" },
        span: null,
        shift: null,
        existing: null,
        until: null,
      };
      const ctx = zCtx({ assignments: [overnight] });
      // R-461 (CONTRACT CHANGED): tomorrow's part is asked about first; the
      // trim below is the answer No ("keep").
      expect(expandCommand(command, ctx)).toMatchObject({
        ok: false,
        question: { kind: "other_day_part", direction: "next" },
      });
      const res = expandCommand(command, ctx, { nextDayPart: "keep" });
      expect(res.ok).toBe(true);
      if (res.ok && res.command.intent !== "several") {
        const move = res.command as MoveCommand;
        expect(move.intent).toBe("move");
        // F-152-b, rule 1: dated TODAY (the sentence's own day), never
        // "tomorrow" -- the window's own end is DAY_END on today's own day.
        expect(move.day).toEqual({ kind: "date", iso: "2026-09-03" });
        expect(move.span).toBeNull();
        expect(move.adjust).toEqual({ edge: "start", at: { hour: 23, minute: 59 } });
        expect(move.existing).toEqual({ kind: "move", assignmentId: "mn2" });

        const moveRes = resolveCommand(move, ctx);
        expect(moveRes.ok).toBe(true);
        if (moveRes.ok && moveRes.resolved.intent === "move") {
          expect(moveRes.resolved.range).toEqual({
            startMin: zWallToOffset(3, 0), // today's own 1440th minute = tomorrow 00:00
            endMin: zWallToOffset(3, 360), // the block's own untouched end
          });
        }
      } else {
        throw new Error("expected a single move");
      }
    });

    it('MN3: yesterday 22:00 to tomorrow 02:00 -- across_midnight (the review follow-up: the window\'s own bounds would have been the untrue, unanswerable "00:00-00:00")', () => {
      const wide = zBlk({
        id: "mn3",
        startMin: zWallToOffset(1, 1320), // yesterday 22:00
        endMin: zWallToOffset(3, 120), // tomorrow 02:00
        label: "10 pm to 2 am",
      });
      const command: UnassignCommand = {
        intent: "unassign",
        operator: "everyone",
        place: ["Cell 1"],
        day: { kind: "date", iso: "2026-09-03" },
        span: null,
        shift: null,
        existing: null,
        until: null,
      };
      // R-461 (CONTRACT CHANGED): a block across BOTH of the day's midnights
      // asks both questions, previous first; only when BOTH answers keep a
      // part is it the hole the app cannot make -- the same refusal as before.
      const c = zCtx({ assignments: [wide] });
      expect(expandCommand(command, c)).toMatchObject({
        ok: false,
        question: { kind: "other_day_part", direction: "previous" },
      });
      expect(expandCommand(command, c, { previousDayPart: "keep" })).toMatchObject({
        ok: false,
        question: { kind: "other_day_part", direction: "next" },
      });
      const res = expandCommand(command, c, { previousDayPart: "keep", nextDayPart: "keep" });
      expect(res).toEqual({
        ok: false,
        question: {
          kind: "across_midnight",
          person: "Sam",
          cell: "Cell 1",
          block: "Housing A 10 pm to 2 am",
          hours: "10 pm to 2 am", // the block's OWN real hours, never the window's
        },
      });
    });

    it("MN4 (F-152-b, rule 1: item 4 no longer applies here): a block starting off zDays entirely still clears via an edge adjust -- the untouched edge's own day is never read at all", () => {
      const overnight = zBlk({
        id: "mn4",
        startMin: zWallToOffset(-1, 120), // 2026-08-31, off zDays entirely -- 02:00
        endMin: zWallToOffset(0, 360), // 2026-09-01 (index 0, on board) 06:00
        label: "02:00–06:00",
      });
      const command: UnassignCommand = {
        intent: "unassign",
        operator: "everyone",
        place: ["Cell 1"],
        day: { kind: "date", iso: "2026-09-01" }, // index 0
        span: null,
        shift: null,
        existing: null,
        until: null,
      };
      const ctx = zCtx({ assignments: [overnight] });
      // R-461 (CONTRACT CHANGED): asked first; the trim is the answer No.
      expect(expandCommand(command, ctx)).toMatchObject({
        ok: false,
        question: { kind: "other_day_part", direction: "previous", day: "Monday" },
      });
      const res = expandCommand(command, ctx, { previousDayPart: "keep" });
      expect(res.ok).toBe(true);
      if (res.ok && res.command.intent !== "several") {
        const move = res.command as MoveCommand;
        expect(move.day).toEqual({ kind: "date", iso: "2026-09-01" });
        expect(move.span).toBeNull();
        expect(move.adjust).toEqual({ edge: "end", at: { hour: 0, minute: 0 } });
        expect(move.existing).toEqual({ kind: "move", assignmentId: "mn4" });

        // Resolves clean too -- `resolveMoveCommand` finds the block by
        // OVERLAP with today's window, never by asking `ctx.days` whether
        // day -1 exists.
        const moveRes = resolveCommand(move, ctx);
        expect(moveRes.ok).toBe(true);
        if (moveRes.ok && moveRes.resolved.intent === "move") {
          expect(moveRes.resolved.range).toEqual({
            startMin: zWallToOffset(-1, 120),
            endMin: zWallToOffset(0, 0),
          });
        }
      } else {
        throw new Error("expected a single move");
      }
    });

    it("MN5: a block wholly inside today is unchanged -- a plain remove dated today", () => {
      const inside = zBlk({
        id: "mn5",
        startMin: zWallToOffset(2, 600),
        endMin: zWallToOffset(2, 720),
        label: "10 am to noon",
      });
      const command: UnassignCommand = {
        intent: "unassign",
        operator: "everyone",
        place: ["Cell 1"],
        day: { kind: "date", iso: "2026-09-03" },
        span: null,
        shift: null,
        existing: null,
        until: null,
      };
      const res = expandCommand(command, zCtx({ assignments: [inside] }));
      expect(res.ok).toBe(true);
      if (res.ok && res.command.intent !== "several") {
        const remove = res.command as UnassignCommand;
        expect(remove.intent).toBe("unassign");
        expect(remove.day).toEqual({ kind: "date", iso: "2026-09-03" });
        expect(remove.span).toEqual({
          start: { hour: 10, minute: 0 },
          end: { hour: 12, minute: 0 },
        });
        expect(remove.existing).toEqual({ kind: "remove", assignmentId: "mn5" });
      } else {
        throw new Error("expected a single remove");
      }
    });

    it("MN6 (extra site: expandAbsence, the `until` form): a block spanning two of its own day windows dedupes to one removal, dated by its own start day, span null when not representable", () => {
      const overnight = zBlk({
        id: "mn6",
        startMin: zWallToOffset(1, 1320), // 2026-09-02 (index 1) 22:00
        endMin: zWallToOffset(2, 360), // 2026-09-03 (index 2) 06:00
        label: "10 pm to 6 am",
      });
      const command: UnassignCommand = {
        intent: "unassign",
        operator: "Sam",
        place: [],
        day: { kind: "date", iso: "2026-09-02" }, // index 1
        span: null,
        shift: null,
        existing: null,
        until: { kind: "date", iso: "2026-09-03" }, // index 2 -- the block overlaps BOTH day windows
      };
      const res = expandCommand(command, zCtx({ assignments: [overnight] }));
      expect(res.ok).toBe(true);
      if (res.ok && res.command.intent !== "several") {
        const remove = res.command as UnassignCommand;
        expect(remove.day).toEqual({ kind: "date", iso: "2026-09-02" }); // its own start day
        expect(remove.span).toBeNull(); // ends 06:00, not midnight -- not representable, never a guess
        expect(remove.existing).toEqual({ kind: "remove", assignmentId: "mn6" });
      } else {
        throw new Error("expected a single remove, never one per day it overlaps");
      }
    });

    it("MN7 (extra site: expandSplit, the split builder): splitting a block that starts the day before -- split_needed, never a negative span dated on the split's own day", () => {
      const overnight = zBlk({
        id: "mn7",
        startMin: zWallToOffset(1, 1320), // yesterday 22:00
        endMin: zWallToOffset(2, 360), // today 06:00
        label: "10 pm to 6 am",
      });
      const command: SplitCommand = {
        intent: "split",
        operator: "Sam",
        place: ["Cell 1"],
        day: { kind: "date", iso: "2026-09-03" }, // today, index 2
        at: { hour: 2, minute: 0 }, // today 02:00 -- inside the block, not at midnight
      };
      const res = expandCommand(command, zCtx({ assignments: [overnight] }));
      expect(res).toEqual({
        ok: false,
        question: {
          kind: "split_needed",
          person: "Sam",
          cell: "Cell 1",
          block: "Housing A 10 pm to 6 am",
          span: "10 pm to 6 am",
        },
      });
    });

    it("MN8 (extra site: expandReplace): replacing someone on a leftover overnight block that matches no band -- across_midnight naming the block's own real hours, never a negative span or the window's bounds", () => {
      const overnight = zBlk({
        id: "mn8",
        startMin: zWallToOffset(1, 1320), // yesterday 22:00
        endMin: zWallToOffset(2, 360), // today 06:00
        label: "10 pm to 6 am",
      });
      const command: ReplaceCommand = {
        intent: "replace",
        operator: "Sam",
        with: "Ana",
        place: ["Cell 1"],
        day: { kind: "date", iso: "2026-09-03" },
        span: null,
        shift: null,
      };
      const res = expandCommand(command, zCtx({ assignments: [overnight] }));
      expect(res).toEqual({
        ok: false,
        question: {
          kind: "across_midnight",
          person: "Sam",
          cell: "Cell 1",
          block: "Housing A 10 pm to 6 am",
          hours: "10 pm to 6 am",
        },
      });
    });

    it("MN9 (extra site: expandSwap): swapping someone on a leftover overnight block that matches no band -- across_midnight before either half is written", () => {
      const overnight = zBlk({
        id: "mn9a",
        startMin: zWallToOffset(1, 1320), // yesterday 22:00
        endMin: zWallToOffset(2, 360), // today 06:00
        label: "10 pm to 6 am",
      });
      const anaBlock = zBlk({
        id: "mn9b",
        operatorId: "zana",
        startMin: zWallToOffset(2, 600),
        endMin: zWallToOffset(2, 720),
        label: "10 am to noon",
      });
      const command: SwapCommand = {
        intent: "swap",
        operator: "Sam",
        other: "Ana",
        place: ["Cell 1"],
        day: { kind: "date", iso: "2026-09-03" },
        span: null,
        shift: null,
      };
      const res = expandCommand(command, zCtx({ assignments: [overnight, anaBlock] }));
      expect(res).toEqual({
        ok: false,
        question: {
          kind: "across_midnight",
          person: "Sam",
          cell: "Cell 1",
          block: "Housing A 10 pm to 6 am",
          hours: "10 pm to 6 am",
        },
      });
    });

    // -----------------------------------------------------------------------
    // MN10-MN12 (the maintainer's follow-up, 16 Sept): a replace/swap on a
    // night-shift block must WORK -- "cover Sam with Tom" on Shift 3 (22:00
    // to 06:00) is the everyday case, not an edge case a `split_needed`
    // refusal may hit nightly. `zShiftsAt` (the outer fixture) carries only
    // Shift 1/Shift 2, neither overnight -- these three pins add their own
    // `shiftsAt` naming a genuine overnight Shift 3 (`endMin` past 1440,
    // R-402/D128 §19.99's own convention), the SAME shape `ctx.shiftsAt`
    // documents.
    // -----------------------------------------------------------------------

    const shiftsWithNight3 = (
      nodeId: string,
    ): { name: string; startMin: number; endMin: number }[] =>
      nodeId === "zc1"
        ? [
            { name: "Shift 1", startMin: 360, endMin: 840 },
            { name: "Shift 2", startMin: 840, endMin: 1320 },
            { name: "Shift 3", startMin: 1320, endMin: 1800 }, // 22:00-06:00, crosses midnight
          ]
        : [];

    it('MN10: replace on a Shift 3 block -- the removal carries the existing id with a null span, the assign carries `shift: "Shift 3"` dated the block\'s own start day', () => {
      const overnight = zBlk({
        id: "mn10",
        startMin: zWallToOffset(1, 1320), // yesterday 22:00 -- exactly Shift 3's own start
        endMin: zWallToOffset(2, 360), // today 06:00 -- exactly Shift 3's own end
        label: "10 pm to 6 am",
      });
      const command: ReplaceCommand = {
        intent: "replace",
        operator: "Sam",
        with: "Ana",
        place: ["Cell 1"],
        day: { kind: "date", iso: "2026-09-03" },
        span: null,
        shift: null,
      };
      const res = expandCommand(
        command,
        zCtx({ assignments: [overnight], shiftsAt: shiftsWithNight3 }),
      );
      expect(res.ok).toBe(true);
      if (res.ok && res.command.intent === "several") {
        expect(res.command.commands).toHaveLength(2);
        const [removal, assign] = res.command.commands;
        expect(removal.intent).toBe("unassign");
        const r = removal as UnassignCommand;
        expect(r.day).toEqual({ kind: "date", iso: "2026-09-02" }); // the block's own start day
        expect(r.span).toBeNull(); // needs no hours -- `existing`'s own id finds it
        expect(r.existing).toEqual({ kind: "remove", assignmentId: "mn10" });
        expect(assign.intent).toBe("assign");
        const a = assign as AssignCommand;
        expect(a.operator).toBe("Ana");
        expect(a.day).toEqual({ kind: "date", iso: "2026-09-02" });
        expect(a.shift).toBe("Shift 3");
        expect(a.start).toBeNull();
        expect(a.end).toBeNull();
      } else {
        throw new Error("expected a several of two");
      }
    });

    it("MN11: swap where one block is on Shift 3 -- that block's own removal and its new assign both carry the shift form", () => {
      const overnight = zBlk({
        id: "mn11a",
        startMin: zWallToOffset(1, 1320), // yesterday 22:00, exactly Shift 3
        endMin: zWallToOffset(2, 360), // today 06:00
        label: "10 pm to 6 am",
      });
      const anaBlock = zBlk({
        id: "mn11b",
        operatorId: "zana",
        startMin: zWallToOffset(2, 600), // today 10:00, an ordinary same-day block
        endMin: zWallToOffset(2, 720), // today 12:00
        label: "10 am to noon",
      });
      const command: SwapCommand = {
        intent: "swap",
        operator: "Sam",
        other: "Ana",
        place: ["Cell 1"],
        day: { kind: "date", iso: "2026-09-03" },
        span: null,
        shift: null,
      };
      const res = expandCommand(
        command,
        zCtx({ assignments: [overnight, anaBlock], shiftsAt: shiftsWithNight3 }),
      );
      expect(res.ok).toBe(true);
      if (res.ok && res.command.intent === "several") {
        const cmds = res.command.commands;
        expect(cmds).toHaveLength(4);
        // Sam's own removal -- the Shift 3 block, dated its own start day,
        // no hours needed.
        const removeSam = cmds[0] as UnassignCommand;
        expect(removeSam.existing).toEqual({ kind: "remove", assignmentId: "mn11a" });
        expect(removeSam.day).toEqual({ kind: "date", iso: "2026-09-02" });
        expect(removeSam.span).toBeNull();
        // Ana's own removal -- an ordinary same-day block, unchanged shape.
        const removeAna = cmds[1] as UnassignCommand;
        expect(removeAna.existing).toEqual({ kind: "remove", assignmentId: "mn11b" });
        expect(removeAna.day).toEqual({ kind: "date", iso: "2026-09-03" });
        expect(removeAna.span).toEqual({
          start: { hour: 10, minute: 0 },
          end: { hour: 12, minute: 0 },
        });
        // Sam takes Ana's old (ordinary) block -- plain hours.
        const assignSam = cmds[2] as AssignCommand;
        expect(assignSam.operator).toBe("Sam");
        expect(assignSam.day).toEqual({ kind: "date", iso: "2026-09-03" });
        expect(assignSam.start).toEqual({ hour: 10, minute: 0 });
        expect(assignSam.end).toEqual({ hour: 12, minute: 0 });
        expect(assignSam.shift).toBeNull();
        // Ana takes Sam's old Shift 3 block -- the shift form, dated the
        // block's own start day, never "today".
        const assignAna = cmds[3] as AssignCommand;
        expect(assignAna.operator).toBe("Ana");
        expect(assignAna.day).toEqual({ kind: "date", iso: "2026-09-02" });
        expect(assignAna.shift).toBe("Shift 3");
        expect(assignAna.start).toBeNull();
        expect(assignAna.end).toBeNull();
      } else {
        throw new Error("expected a several of four");
      }
    });

    it("MN12: a night block matching NO band (close, not exact) -- across_midnight still, never a guess at the nearest one", () => {
      const closeButNotShift3 = zBlk({
        id: "mn12",
        startMin: zWallToOffset(1, 1260), // yesterday 21:00 -- an hour off Shift 3's own 22:00
        endMin: zWallToOffset(2, 360), // today 06:00
        label: "9 pm to 6 am",
      });
      const command: ReplaceCommand = {
        intent: "replace",
        operator: "Sam",
        with: "Ana",
        place: ["Cell 1"],
        day: { kind: "date", iso: "2026-09-03" },
        span: null,
        shift: null,
      };
      const res = expandCommand(
        command,
        zCtx({ assignments: [closeButNotShift3], shiftsAt: shiftsWithNight3 }),
      );
      expect(res).toEqual({
        ok: false,
        question: {
          kind: "across_midnight",
          person: "Sam",
          cell: "Cell 1",
          block: "Housing A 9 pm to 6 am",
          hours: "9 pm to 6 am",
        },
      });
    });

    // -----------------------------------------------------------------------
    // MN13-MN19 (docs/agent-briefs/f-152-b-window-edge-brief.md): the first
    // fix (MN1-MN12 above) still failed on the maintainer's real board --
    // his window starts TODAY, so John Kim's block (starting yesterday)
    // clamped under the real `wallOf` and rendered wrong. A ONE-DAY board,
    // the maintainer's own shape, operators named for the real report.
    // -----------------------------------------------------------------------

    const oneDay: BoardDay[] = [{ index: 0, iso: "2026-09-03", weekday: 4 }];
    const zJohn = { id: "zjohn", displayName: "John Kim", employeeRef: null, active: true };
    const zSamP = { id: "zsamp", displayName: "Sam Patel", employeeRef: null, active: true };
    const zTom = { id: "ztom", displayName: "Tom Baker", employeeRef: null, active: true };

    /** MN13-MN19's own ctx: `zCtx` narrowed to ONE day (today, index 0, no
     *  day before it at all -- the maintainer's own board), with John
     *  Kim/Sam Patel/Tom Baker added and no shift pattern (MN10/MN11 above
     *  already cover the shift-match path, on the wider `zDays` board). */
    function edgeCtx(overrides: Partial<ResolveContext> = {}): ResolveContext {
      return zCtx({
        days: oneDay,
        todayIndex: 0,
        operators: [...zOperators, zJohn, zSamP, zTom],
        shiftsAt: () => [],
        ...overrides,
      });
    }

    it("MN13: John Kim -1320..360 (starts before the window) and Sam Patel 540..660, clear Cell 1 today -- an edge adjust for John (existing id, span null, day today), a plain remove for Sam, both resolve clean", () => {
      const john = zBlk({
        id: "mn13john",
        operatorId: "zjohn",
        startMin: -1320,
        endMin: 360,
        label: "02:00–06:00",
      });
      const sam = zBlk({
        id: "mn13sam",
        operatorId: "zsamp",
        startMin: 540,
        endMin: 660,
        label: "09:00–11:00",
      });
      const command: UnassignCommand = {
        intent: "unassign",
        operator: "everyone",
        place: ["Cell 1"],
        day: { kind: "date", iso: "2026-09-03" },
        span: null,
        shift: null,
        existing: null,
        until: null,
      };
      const ctx = edgeCtx({ assignments: [john, sam] });
      // R-461 (CONTRACT CHANGED): John's block crosses today's first
      // midnight -- asked first (naming him and his own real start, read
      // off the clamped axis without trusting its day); the trim is No.
      const asked = expandCommand(command, ctx);
      expect(asked).toEqual({
        ok: false,
        question: {
          kind: "other_day_part",
          direction: "previous",
          day: "Wednesday",
          first: { kind: "person", name: "John Kim" },
          others: 0,
          at: "2 am",
          hours: "2 am to midnight",
          answers: [
            { id: "clear", label: "Yes", word: "yes" },
            { id: "keep", label: "No", word: "no" },
          ],
        },
      });
      const res = expandCommand(command, ctx, { previousDayPart: "keep" });
      expect(res.ok).toBe(true);
      if (!res.ok || res.command.intent !== "several") throw new Error("expected a several of two");
      expect(res.command.commands).toHaveLength(2);
      const [move, remove] = res.command.commands;
      expect(move.intent).toBe("move");
      const m = move as MoveCommand;
      expect(m.day).toEqual({ kind: "date", iso: "2026-09-03" });
      expect(m.span).toBeNull();
      expect(m.adjust).toEqual({ edge: "end", at: { hour: 0, minute: 0 } });
      expect(m.existing).toEqual({ kind: "move", assignmentId: "mn13john" });
      expect(remove.intent).toBe("unassign");
      expect((remove as UnassignCommand).existing).toEqual({
        kind: "remove",
        assignmentId: "mn13sam",
      });

      // No question anywhere -- both steps resolve clean against the SAME
      // ctx, John's own untouched start and the window's own new end.
      const moveRes = resolveCommand(m, ctx);
      expect(moveRes.ok).toBe(true);
      if (moveRes.ok && moveRes.resolved.intent === "move") {
        expect(moveRes.resolved.range).toEqual({ startMin: -1320, endMin: 0 });
      }
      const removeRes = resolveCommand(remove as UnassignCommand, ctx);
      expect(removeRes.ok).toBe(true);
    });

    it("MN14: 22:00 today to 06:00 tomorrow (tomorrow off the one-day board), clear Cell 1 today -- an edge adjust (start to DAY_END), resolved start = 1440", () => {
      const block = zBlk({
        id: "mn14",
        operatorId: "zjohn",
        startMin: 1320,
        endMin: 1800,
        label: "10 pm to 6 am",
      });
      const command: UnassignCommand = {
        intent: "unassign",
        operator: "everyone",
        place: ["Cell 1"],
        day: { kind: "date", iso: "2026-09-03" },
        span: null,
        shift: null,
        existing: null,
        until: null,
      };
      const ctx = edgeCtx({ assignments: [block] });
      // R-461 (CONTRACT CHANGED): tomorrow (off this one-day board) is named
      // by its weekday, never a read of a day the board does not have.
      expect(expandCommand(command, ctx)).toMatchObject({
        ok: false,
        question: { kind: "other_day_part", direction: "next", day: "Friday", at: "6 am" },
      });
      const res = expandCommand(command, ctx, { nextDayPart: "keep" });
      expect(res.ok).toBe(true);
      if (!res.ok || res.command.intent === "several") throw new Error("expected a single move");
      const move = res.command as MoveCommand;
      expect(move.day).toEqual({ kind: "date", iso: "2026-09-03" });
      expect(move.span).toBeNull();
      expect(move.adjust).toEqual({ edge: "start", at: { hour: 23, minute: 59 } });
      expect(move.existing).toEqual({ kind: "move", assignmentId: "mn14" });

      const moveRes = resolveCommand(move, ctx);
      expect(moveRes.ok).toBe(true);
      if (moveRes.ok && moveRes.resolved.intent === "move") {
        expect(moveRes.resolved.range).toEqual({ startMin: 1440, endMin: 1800 });
      }
    });

    it("MN15: replacing John Kim (whose block starts before the one-day board) with Tom Baker -- day_off_board naming yesterday's own ISO", () => {
      const john = zBlk({
        id: "mn15",
        operatorId: "zjohn",
        startMin: -1320,
        endMin: 360,
        label: "02:00–06:00",
      });
      const command: ReplaceCommand = {
        intent: "replace",
        operator: "John Kim",
        with: "Tom Baker",
        place: ["Cell 1"],
        day: { kind: "date", iso: "2026-09-03" },
        span: null,
        shift: null,
      };
      const res = expandCommand(command, edgeCtx({ assignments: [john] }));
      expect(res).toEqual({
        ok: false,
        question: { kind: "day_off_board", text: "2026-09-02" },
      });
    });

    it("MN16: swapping John Kim (block starts before the board) with Tom Baker -- the same day_off_board, before either half is written", () => {
      const john = zBlk({
        id: "mn16john",
        operatorId: "zjohn",
        startMin: -1320,
        endMin: 360,
        label: "02:00–06:00",
      });
      const tom = zBlk({
        id: "mn16tom",
        operatorId: "ztom",
        startMin: 540,
        endMin: 660,
        label: "09:00–11:00",
      });
      const command: SwapCommand = {
        intent: "swap",
        operator: "John Kim",
        other: "Tom Baker",
        place: ["Cell 1"],
        day: { kind: "date", iso: "2026-09-03" },
        span: null,
        shift: null,
      };
      const res = expandCommand(command, edgeCtx({ assignments: [john, tom] }));
      expect(res).toEqual({
        ok: false,
        question: { kind: "day_off_board", text: "2026-09-02" },
      });
    });

    it("MN17: splitting John Kim's block (which starts before the board) at 3am -- day_off_board, never a negative span", () => {
      const john = zBlk({
        id: "mn17",
        operatorId: "zjohn",
        startMin: -1320,
        endMin: 360,
        label: "02:00–06:00",
      });
      const command: SplitCommand = {
        intent: "split",
        operator: "John Kim",
        place: ["Cell 1"],
        day: { kind: "date", iso: "2026-09-03" },
        at: { hour: 3, minute: 0 },
      };
      const res = expandCommand(command, edgeCtx({ assignments: [john] }));
      expect(res).toEqual({
        ok: false,
        question: { kind: "day_off_board", text: "2026-09-02" },
      });
    });

    it("MN18 (R-461, CONTRACT CHANGED -- was day_off_board): an absence over John Kim's block that starts before the board asks about yesterday's part; Yes removes it by id with no clock pair, No trims it -- never a negative span, never a read of the day off the board", () => {
      const john = zBlk({
        id: "mn18",
        operatorId: "zjohn",
        startMin: -1320,
        endMin: 360,
        label: "02:00–06:00",
      });
      const command: UnassignCommand = {
        intent: "unassign",
        operator: "John Kim",
        place: [],
        day: { kind: "date", iso: "2026-09-03" },
        span: null,
        shift: null,
        existing: null,
        until: { kind: "date", iso: "2026-09-03" },
      };
      const ctx = edgeCtx({ assignments: [john] });
      expect(expandCommand(command, ctx)).toMatchObject({
        ok: false,
        question: {
          kind: "other_day_part",
          direction: "previous",
          first: { kind: "person", name: "John Kim" },
        },
      });
      const yes = expandCommand(command, ctx, { previousDayPart: "clear" });
      if (!yes.ok || yes.command.intent !== "unassign") throw new Error("expected one removal");
      expect(yes.command.existing).toEqual({ kind: "remove", assignmentId: "mn18" });
      expect(yes.command.day).toEqual({ kind: "date", iso: "2026-09-03" });
      expect(yes.command.span).toBeNull();
      expect(resolveCommand(yes.command, ctx).ok).toBe(true);
      const no = expandCommand(command, ctx, { previousDayPart: "keep" });
      if (!no.ok || no.command.intent !== "move") throw new Error("expected one trim");
      expect(no.command.adjust).toEqual({ edge: "end", at: { hour: 0, minute: 0 } });
      const trimmed = resolveCommand(no.command, ctx);
      expect(trimmed.ok && trimmed.resolved.intent === "move" && trimmed.resolved.range).toEqual({
        startMin: -1320,
        endMin: 0,
      });
    });

    it("MN19: a block starting exactly at the window's own first minute (0..360) is ON the board -- a cover resolves as a plain same-day pair, never a refusal", () => {
      const john = zBlk({
        id: "mn19",
        operatorId: "zjohn",
        startMin: 0,
        endMin: 360,
        label: "00:00–06:00",
      });
      const command: ReplaceCommand = {
        intent: "replace",
        operator: "John Kim",
        with: "Tom Baker",
        place: ["Cell 1"],
        day: { kind: "date", iso: "2026-09-03" },
        span: null,
        shift: null,
      };
      const res = expandCommand(command, edgeCtx({ assignments: [john] }));
      expect(res.ok).toBe(true);
      if (res.ok && res.command.intent === "several") {
        const [removal, assign] = res.command.commands;
        expect(removal.intent).toBe("unassign");
        const r = removal as UnassignCommand;
        expect(r.day).toEqual({ kind: "date", iso: "2026-09-03" });
        expect(r.span).toEqual({ start: { hour: 0, minute: 0 }, end: { hour: 6, minute: 0 } });
        expect(r.existing).toEqual({ kind: "remove", assignmentId: "mn19" });
        expect(assign.intent).toBe("assign");
        const a = assign as AssignCommand;
        expect(a.operator).toBe("Tom Baker");
        expect(a.day).toEqual({ kind: "date", iso: "2026-09-03" });
        expect(a.start).toEqual({ hour: 0, minute: 0 });
        expect(a.end).toEqual({ hour: 6, minute: 0 });
      } else {
        throw new Error("expected a several of two");
      }
    });

    it("MN20 (reviewer fix, F-152-b rule 2): expandCopy SKIPS a source block with an edge off the board -- John's leftover never blocks copying Sam's, and never asks a question", () => {
      // A minimal two-day board (today, tomorrow) -- narrower than `zDays`,
      // the same today-starting shape MN13-MN19 use, widened by exactly the
      // one extra day a copy's own destination needs to resolve at all.
      const twoDay: BoardDay[] = [
        { index: 0, iso: "2026-09-03", weekday: 4 },
        { index: 1, iso: "2026-09-04", weekday: 5 },
      ];
      const john = zBlk({
        id: "mn20john",
        operatorId: "zjohn",
        startMin: -1320, // off the board entirely -- yesterday 02:00
        endMin: 360,
        label: "02:00–06:00",
      });
      const sam = zBlk({
        id: "mn20sam",
        operatorId: "zsamp",
        startMin: 480, // 08:00, an ordinary same-day block
        endMin: 960, // 16:00
        label: "8 am to 4 pm",
      });
      const command: CopyCommand = {
        intent: "copy",
        place: ["Cell 1"],
        from: { kind: "date", iso: "2026-09-03" },
        to: { kind: "date", iso: "2026-09-04" },
      };
      const ctx = zCtx({
        days: twoDay,
        operators: [...zOperators, zJohn, zSamP],
        shiftsAt: () => [],
        assignments: [john, sam],
      });
      const res = expandCommand(command, ctx);
      expect(res.ok).toBe(true);
      // Exactly ONE command -- Sam's own copy, never a `several` (John's
      // leftover contributed nothing, not even a skipped placeholder).
      if (res.ok && res.command.intent !== "several") {
        const a = res.command as AssignCommand;
        expect(a.intent).toBe("assign");
        expect(a.operator).toBe("Sam Patel");
        expect(a.day).toEqual({ kind: "date", iso: "2026-09-04" });
        expect(a.start).toEqual({ hour: 8, minute: 0 });
        expect(a.end).toEqual({ hour: 16, minute: 0 });
      } else {
        throw new Error("expected a single assign (Sam's), never a several and never a question");
      }
    });
  });

  // -------------------------------------------------------------------------
  // JB1-JB6: "the job's hours" (R-414, D132 item 3) -- resolveShiftSpanStep's
  // own `jobProduct` branch, and the assign path.
  // -------------------------------------------------------------------------

  describe("JB: the job's hours", () => {
    it("JB1: one run -- its own hours become the block's, attached without asking", () => {
      const res = resolveCommand(zAssign({ shift: "the job" }), zCtx({ runs: [zRun()] }));
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.resolved.range).toEqual({ startMin: 2 * 1440 + 480, endMin: 2 * 1440 + 960 });
        expect(res.resolved.target).toEqual({ kind: "run", runId: "zrun" });
      }
    });

    it("JB2: no run of that part on that cell -- no_job", () => {
      const res = resolveCommand(zAssign({ shift: "the job" }), zCtx());
      expect(res).toEqual({
        ok: false,
        question: { kind: "no_job", product: "Housing A", cell: "Cell 1", when: "2026-09-03" },
      });
    });

    it("JB3: two runs of that part overlapping the day -- which_job, naming their hours", () => {
      const runA = zRun({
        id: "rA",
        startMin: 2 * 1440 + 360,
        endMin: 2 * 1440 + 480,
        span: "06:00–08:00",
      });
      const runB = zRun({
        id: "rB",
        startMin: 2 * 1440 + 780,
        endMin: 2 * 1440 + 900,
        span: "13:00–15:00",
      });
      const res = resolveCommand(zAssign({ shift: "the job" }), zCtx({ runs: [runA, runB] }));
      expect(res).toEqual({
        ok: false,
        question: {
          kind: "which_job",
          product: "Housing A",
          cell: "Cell 1",
          runs: ["06:00–08:00", "13:00–15:00"],
        },
      });
    });

    it("JB4: the own-block question (R-385) still runs, before the target is decided", () => {
      const res = resolveCommand(
        zAssign({ shift: "the job" }),
        zCtx({ runs: [zRun()], assignments: [zBlk()] }),
      );
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.question.kind).toBe("block_exists");
    });

    it("JB5: on a booking, 'the job' is meaningless -- the ordinary no_shift refusal, naming it", () => {
      const res = resolveCommand(
        {
          intent: "book",
          product: "Housing A",
          place: ["Cell 1"],
          headcount: null,
          day: { kind: "date", iso: "2026-09-03" },
          start: null,
          end: null,
          existing: null,
          shift: "the job",
        },
        zCtx({ runs: [zRun()] }),
      );
      expect(res).toEqual({
        ok: false,
        question: {
          kind: "no_shift",
          text: "the job",
          cell: "Cell 1",
          shifts: ["Shift 1", "Shift 2"],
        },
      });
    });

    it("JB6: on a move, 'the job' reads as the block's job's hours -- not needed now, refused the same way", () => {
      const res = resolveCommand(
        {
          intent: "move",
          operator: "Sam",
          place: ["Cell 1"],
          toPlace: null,
          day: { kind: "date", iso: "2026-09-03" },
          span: null,
          shift: "the job",
          existing: null,
          adjust: null,
        },
        zCtx({ runs: [zRun()], assignments: [zBlk()] }),
      );
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.question.kind).toBe("no_shift");
    });
  });

  // -------------------------------------------------------------------------
  // HC1-HC4: headcount (R-415, D132 item 4) -- a new resolver branch.
  // -------------------------------------------------------------------------

  describe("HC: headcount", () => {
    function headcountCmd(overrides: Partial<HeadcountCommand> = {}): HeadcountCommand {
      return {
        intent: "headcount",
        product: "Housing A",
        place: ["Cell 1"],
        day: { kind: "date", iso: "2026-09-03" },
        span: null,
        shift: null,
        headcount: 5,
        ...overrides,
      };
    }

    it("HC1: one run -- resolves to a write on that run", () => {
      const res = resolveCommand(headcountCmd(), zCtx({ runs: [zRun()] }));
      expect(res).toEqual({
        ok: true,
        resolved: {
          intent: "headcount",
          runId: "zrun",
          nodeId: "zc1",
          headcount: 5,
          readout:
            "The Housing A job on Cell 1 now takes 5 people; it runs 2026-09-03 from 8 am to 4 pm.",
          attempted: "The Housing A job on Cell 1",
          notTried: "The Housing A job on Cell 1 stays at 3 people.",
        },
      });
    });

    it("HC2: no run of that part on that cell -- no_job", () => {
      const res = resolveCommand(headcountCmd(), zCtx());
      expect(res).toEqual({
        ok: false,
        question: { kind: "no_job", product: "Housing A", cell: "Cell 1", when: "2026-09-03" },
      });
    });

    it("HC3: two runs overlapping the whole day -- which_job", () => {
      const runA = zRun({
        id: "rA",
        startMin: 2 * 1440 + 360,
        endMin: 2 * 1440 + 480,
        span: "06:00–08:00",
      });
      const runB = zRun({
        id: "rB",
        startMin: 2 * 1440 + 780,
        endMin: 2 * 1440 + 900,
        span: "13:00–15:00",
      });
      const res = resolveCommand(headcountCmd(), zCtx({ runs: [runA, runB] }));
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.question.kind).toBe("which_job");
    });

    it("HC4: a span narrows to the one run it covers, among two on the day", () => {
      const morning = zRun({
        id: "rMorning",
        startMin: 2 * 1440 + 360,
        endMin: 2 * 1440 + 480,
        span: "06:00–08:00",
      });
      const afternoon = zRun({
        id: "rAfternoon",
        startMin: 2 * 1440 + 780,
        endMin: 2 * 1440 + 900,
        span: "13:00–15:00",
      });
      const res = resolveCommand(
        headcountCmd({ span: { start: { hour: 6, minute: 0 }, end: { hour: 9, minute: 0 } } }),
        zCtx({ runs: [morning, afternoon] }),
      );
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.resolved.runId).toBe("rMorning");
    });
  });

  // -------------------------------------------------------------------------
  // RW1-RW5: every weekday / every day (R-416, D132 item 5) -- in
  // expandCommand. A wider, Monday-anchored 14-day window (this_week and
  // next_week both fully on the board), since the outer fixture's own 5 days
  // do not reach a Monday at all (CP4/CP5's own reason for a separate window).
  // -------------------------------------------------------------------------

  describe("RW: every weekday / every day", () => {
    const rwDays: BoardDay[] = [
      { index: 0, iso: "2026-08-31", weekday: 1 }, // Mon, this_week
      { index: 1, iso: "2026-09-01", weekday: 2 },
      { index: 2, iso: "2026-09-02", weekday: 3 }, // today, Wed
      { index: 3, iso: "2026-09-03", weekday: 4 },
      { index: 4, iso: "2026-09-04", weekday: 5 },
      { index: 5, iso: "2026-09-05", weekday: 6 },
      { index: 6, iso: "2026-09-06", weekday: 0 }, // Sun, this_week's own
      { index: 7, iso: "2026-09-07", weekday: 1 }, // Mon, next_week
      { index: 8, iso: "2026-09-08", weekday: 2 },
      { index: 9, iso: "2026-09-09", weekday: 3 },
      { index: 10, iso: "2026-09-10", weekday: 4 },
      { index: 11, iso: "2026-09-11", weekday: 5 },
      { index: 12, iso: "2026-09-12", weekday: 6 },
      { index: 13, iso: "2026-09-13", weekday: 0 }, // Sun, next_week's own
    ];
    const rwCtx = (days: BoardDay[] = rwDays) => zCtx({ days, todayIndex: 2 });

    it("RW1: 'every weekday this week' -- five assigns, Monday to Friday, in order", () => {
      const command = zAssign({ day: { kind: "weekdays", week: "this_week" } });
      const res = expandCommand(command, rwCtx());
      expect(res.ok).toBe(true);
      if (res.ok && res.command.intent === "several") {
        const isos = (res.command.commands as AssignCommand[]).map(
          (c) => (c.day as { iso: string }).iso,
        );
        expect(isos).toEqual([
          "2026-08-31",
          "2026-09-01",
          "2026-09-02",
          "2026-09-03",
          "2026-09-04",
        ]);
        // Every other field copied onto each, unchanged.
        for (const c of res.command.commands as AssignCommand[]) {
          expect(c.operator).toBe("Sam");
          expect(c.product).toBe("Housing A");
          expect(c.place).toEqual(["Cell 1"]);
        }
      } else {
        throw new Error("expected a several of five");
      }
    });

    it("RW2: a booking 'every day next week' -- seven books, Monday to Sunday", () => {
      const command: BookCommand = {
        intent: "book",
        product: "Housing A",
        place: ["Cell 1"],
        headcount: null,
        day: { kind: "every_day", week: "next_week" },
        start: { hour: 6, minute: 0 },
        end: { hour: 14, minute: 0 },
        existing: null,
        shift: null,
      };
      const res = expandCommand(command, rwCtx());
      expect(res.ok).toBe(true);
      if (res.ok && res.command.intent === "several") {
        const isos = (res.command.commands as BookCommand[]).map(
          (c) => (c.day as { iso: string }).iso,
        );
        expect(isos).toEqual([
          "2026-09-07",
          "2026-09-08",
          "2026-09-09",
          "2026-09-10",
          "2026-09-11",
          "2026-09-12",
          "2026-09-13",
        ]);
      } else {
        throw new Error("expected a several of seven");
      }
    });

    it('RD-1 (F-158): a weekdays/this_week repeat on a board too narrow for the week -- day_off_board names the WEEK, "this week", never the missing iso', () => {
      const command = zAssign({ day: { kind: "weekdays", week: "this_week" } });
      // Friday (2026-09-04, index 4) and everything after it missing -- a
      // three-day board, the shape the typed walk runs on.
      const res = expandCommand(command, rwCtx(rwDays.slice(0, 4)));
      expect(res).toEqual({
        ok: false,
        question: { kind: "day_off_board", text: "this week" },
      });
    });

    it('RD-2 (F-158): the same for next_week -- "next week"', () => {
      const command = zAssign({ day: { kind: "weekdays", week: "next_week" } });
      const res = expandCommand(command, rwCtx(rwDays.slice(0, 4)));
      expect(res).toEqual({
        ok: false,
        question: { kind: "day_off_board", text: "next week" },
      });
    });

    it("RD-3 (F-158): once the board holds the week, the repeat expands as it always did -- five commands, Monday to Friday", () => {
      const command = zAssign({ day: { kind: "weekdays", week: "this_week" } });
      const res = expandCommand(command, rwCtx());
      expect(res.ok).toBe(true);
      if (res.ok && res.command.intent === "several") {
        expect(res.command.commands).toHaveLength(5);
        expect(
          (res.command.commands as AssignCommand[]).map((c) => (c.day as { iso: string }).iso),
        ).toEqual(["2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"]);
      } else {
        throw new Error("expected a several of five");
      }
    });

    // F-191: a week word is the PLANT'S week, anchored on the plant's calendar
    // today, not on the window. A board already showing next week, with today
    // off it, used to answer "every weekday next week" with "today is not on
    // the board" -- a question about a day the sentence never named -- and the
    // Show-that-day handler then anchored the week on the window's first day.
    it("RW6 (F-191): 'every weekday next week' with the board ON next week and today off it -- five assigns, no question about today", () => {
      const nextWeek: BoardDay[] = [
        { index: 0, iso: "2026-09-07", weekday: 1 },
        { index: 1, iso: "2026-09-08", weekday: 2 },
        { index: 2, iso: "2026-09-09", weekday: 3 },
        { index: 3, iso: "2026-09-10", weekday: 4 },
        { index: 4, iso: "2026-09-11", weekday: 5 },
        { index: 5, iso: "2026-09-12", weekday: 6 },
        { index: 6, iso: "2026-09-13", weekday: 0 },
      ];
      const command = zAssign({ day: { kind: "weekdays", week: "next_week" } });
      const res = expandCommand(
        command,
        zCtx({ days: nextWeek, todayIndex: null, todayIso: "2026-09-02" }),
      );
      expect(res.ok).toBe(true);
      if (res.ok && res.command.intent === "several") {
        const isos = (res.command.commands as AssignCommand[]).map(
          (c) => (c.day as { iso: string }).iso,
        );
        expect(isos).toEqual([
          "2026-09-07",
          "2026-09-08",
          "2026-09-09",
          "2026-09-10",
          "2026-09-11",
        ]);
      }
    });

    it("RW7 (F-191): 'every weekday next week' with today AND next week both off the board -- asks about next week, never about today", () => {
      const weekAfterNext: BoardDay[] = [
        { index: 0, iso: "2026-09-14", weekday: 1 },
        { index: 1, iso: "2026-09-15", weekday: 2 },
        { index: 2, iso: "2026-09-16", weekday: 3 },
      ];
      const res = expandCommand(
        zAssign({ day: { kind: "weekdays", week: "next_week" } }),
        zCtx({ days: weekAfterNext, todayIndex: null, todayIso: "2026-09-02" }),
      );
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.question).toEqual({ kind: "day_off_board", text: "next week" });
    });

    it("RW4: an ordinary day word -- unaffected, the same pass-through as ever", () => {
      const command = zAssign({ day: { kind: "today" } });
      const res = expandCommand(command, rwCtx());
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.command).toBe(command);
    });

    it("RW5 (defensive): a repeat day reaching resolveDay on an intent other than assign/book -- bad_repeat_day, never a crash", () => {
      const res = resolveCommand(
        {
          intent: "unassign",
          operator: "Sam",
          place: [],
          day: { kind: "weekdays", week: "this_week" },
          span: null,
          shift: null,
          existing: null,
          until: null,
        },
        rwCtx(),
      );
      expect(res).toEqual({
        ok: false,
        question: { kind: "bad_repeat_day", text: "every weekday this week" },
      });
    });

    // -----------------------------------------------------------------------
    // UW-r: expandRepeatUnassign -- S72-e (F-224, R-416, R-435,
    // docs/agent-briefs/s72-e-clear-over-a-week-brief.md §2/§5). Same
    // rwDays/rwCtx fixture as the rest of this block (Mon 2026-08-31 ..
    // Sun 2026-09-13, today = Wed 2026-09-02, index 2): Mon/Tue (indexes
    // 0/1) are BEFORE today, Wed..Sun (2..6) are this_week's own remaining
    // days.
    // -----------------------------------------------------------------------

    describe("UW-r: unassign's own repeat expansion", () => {
      it("UW-r-1: 'clear Cell 1 this week' (everyone) -- blocks on Mon (before today), Thu and Fri, none on Wed/Sat/Sun -- exactly TWO removals, Thu then Fri; Monday's block never reached the lot", () => {
        const monBlk = zBlk({
          id: "uwMon",
          nodeId: "zc1",
          operatorId: "zsam",
          startMin: 0 * 1440 + 600,
          endMin: 0 * 1440 + 840,
        });
        const thuBlk = zBlk({
          id: "uwThu",
          nodeId: "zc1",
          operatorId: "zsam",
          startMin: 3 * 1440 + 600,
          endMin: 3 * 1440 + 840,
        });
        const friBlk = zBlk({
          id: "uwFri",
          nodeId: "zc1",
          operatorId: "zana",
          startMin: 4 * 1440 + 480,
          endMin: 4 * 1440 + 720,
        });
        const command: UnassignCommand = {
          intent: "unassign",
          operator: "everyone",
          place: ["Cell 1"],
          day: { kind: "every_day", week: "this_week" },
          span: null,
          existing: null,
          shift: null,
          until: null,
        };
        const res = expandCommand(
          command,
          zCtx({ days: rwDays, todayIndex: 2, assignments: [monBlk, thuBlk, friBlk] }),
        );
        expect(res.ok).toBe(true);
        if (res.ok && res.command.intent === "several") {
          const cmds = res.command.commands as UnassignCommand[];
          expect(cmds).toHaveLength(2);
          expect(cmds.map((c) => c.existing)).toEqual([
            { kind: "remove", assignmentId: "uwThu" },
            { kind: "remove", assignmentId: "uwFri" },
          ]);
        } else {
          throw new Error("expected a several of two");
        }
      });

      it("UW-r-2: 'clear Sam from Cell 1 this week' (a named person) -- Sam's own Monday block (before today) is dropped, Ana's Friday block is never Sam's, only Sam's Thursday block is removed", () => {
        const monBlk = zBlk({
          id: "uwMon2",
          nodeId: "zc1",
          operatorId: "zsam",
          startMin: 0 * 1440 + 600,
          endMin: 0 * 1440 + 840,
        });
        const thuBlk = zBlk({
          id: "uwThu2",
          nodeId: "zc1",
          operatorId: "zsam",
          startMin: 3 * 1440 + 600,
          endMin: 3 * 1440 + 840,
        });
        const friBlk = zBlk({
          id: "uwFri2",
          nodeId: "zc1",
          operatorId: "zana",
          startMin: 4 * 1440 + 480,
          endMin: 4 * 1440 + 720,
        });
        const command: UnassignCommand = {
          intent: "unassign",
          operator: "Sam",
          place: ["Cell 1"],
          day: { kind: "every_day", week: "this_week" },
          span: null,
          existing: null,
          shift: null,
          until: null,
        };
        const res = expandCommand(
          command,
          zCtx({ days: rwDays, todayIndex: 2, assignments: [monBlk, thuBlk, friBlk] }),
        );
        expect(res.ok).toBe(true);
        if (res.ok && res.command.intent !== "several") {
          expect((res.command as UnassignCommand).existing).toEqual({
            kind: "remove",
            assignmentId: "uwThu2",
          });
        } else {
          throw new Error("expected exactly one removal (Sam's Thursday block)");
        }
      });

      it("UW-r-3: 'clear Cell 2 this week' (everyone) -- nobody at all on Cell 2 any day of the week -- refuses naming the SPAN, never a single day", () => {
        const command: UnassignCommand = {
          intent: "unassign",
          operator: "everyone",
          place: ["Cell 2"],
          day: { kind: "every_day", week: "this_week" },
          span: null,
          existing: null,
          shift: null,
          until: null,
        };
        const res = expandCommand(command, zCtx({ days: rwDays, todayIndex: 2, assignments: [] }));
        expect(res).toEqual({
          ok: false,
          question: { kind: "nothing_to_do", text: "Cell 2 has nobody on it this week." },
        });
      });

      it("UW-r-4: a board too narrow for the week -- day_off_board names the WEEK, same as an assign's own repeat (RD-1)", () => {
        const command: UnassignCommand = {
          intent: "unassign",
          operator: "everyone",
          place: ["Cell 1"],
          day: { kind: "every_day", week: "this_week" },
          span: null,
          existing: null,
          shift: null,
          until: null,
        };
        const res = expandCommand(
          command,
          zCtx({ days: rwDays.slice(0, 4), todayIndex: 2, assignments: [] }),
        );
        expect(res).toEqual({
          ok: false,
          question: { kind: "day_off_board", text: "this week" },
        });
      });

      it("UW-r-5 (reviewer, S72-e): a named person with TWO blocks the same day -- both are removed in the same lot, no per-day 'which block' question. Documented on purpose (§2's own brief: 'never a second which-block ambiguity question here, R-407's everyone shape has none either') -- the lot's own confirmation (the readout naming both blocks) is where the maintainer sees and can decline the second one, the same as `expandEveryoneUnassign` never asks per block either. Pinned so a future change to this choice is a decision, not a silent drift.", () => {
        const thuBlkA = zBlk({
          id: "uwAmbigA",
          nodeId: "zc1",
          operatorId: "zsam",
          startMin: 3 * 1440 + 480,
          endMin: 3 * 1440 + 600,
        });
        const thuBlkB = zBlk({
          id: "uwAmbigB",
          nodeId: "zc1",
          operatorId: "zsam",
          startMin: 3 * 1440 + 780,
          endMin: 3 * 1440 + 900,
        });
        const command: UnassignCommand = {
          intent: "unassign",
          operator: "Sam",
          place: ["Cell 1"],
          day: { kind: "every_day", week: "this_week" },
          span: null,
          existing: null,
          shift: null,
          until: null,
        };
        const res = expandCommand(
          command,
          zCtx({ days: rwDays, todayIndex: 2, assignments: [thuBlkA, thuBlkB] }),
        );
        expect(res.ok).toBe(true);
        if (res.ok && res.command.intent === "several") {
          const cmds = res.command.commands as UnassignCommand[];
          expect(cmds.map((c) => c.existing)).toEqual([
            { kind: "remove", assignmentId: "uwAmbigA" },
            { kind: "remove", assignmentId: "uwAmbigB" },
          ]);
        } else {
          throw new Error("expected a several of two same-day removals");
        }
      });

      it("DEF-0044 item 2 (mutation-provable): a week clear whose removals exceed LOT_CEILING answers lot_too_big, not a silent partial write", () => {
        // A cell full of short, non-overlapping blocks across all seven days
        // of next_week: 15 blocks/day is well under `expandEveryoneUnassign`'s
        // OWN per-day ceiling (CP6 already covers that check on `expandCopy`),
        // but the week's total (105) crosses `expandRepeatUnassign`'s own
        // `total > LOT_CEILING` -- this is the one the tester's mutation
        // (deleting that refusal) found no fixture holds.
        const many: ContextAssignment[] = [];
        for (let d = 7; d <= 13; d++) {
          for (let i = 0; i < 15; i++) {
            many.push(
              zBlk({
                id: `lotBlk_${d}_${i}`,
                nodeId: "zc1",
                operatorId: "zsam",
                startMin: d * 1440 + 480 + i * 20,
                endMin: d * 1440 + 480 + i * 20 + 10,
              }),
            );
          }
        }
        const command: UnassignCommand = {
          intent: "unassign",
          operator: "everyone",
          place: ["Cell 1"],
          day: { kind: "every_day", week: "next_week" },
          span: null,
          existing: null,
          shift: null,
          until: null,
        };
        const res = expandCommand(
          command,
          zCtx({ days: rwDays, todayIndex: 2, assignments: many }),
        );
        expect(res).toEqual({
          ok: false,
          question: { kind: "lot_too_big", count: 105, max: 100 },
        });
      });

      it("DEF-0044 item 6 (mutation-provable): a block edge sitting exactly on the board's own last midnight is ON the board, not day_off_board", () => {
        // The board's own last day is rwDays' index 13 (2026-09-13);
        // `wallToOffset(13, 1440)` is that day's own midnight -- the exact
        // boundary `edgeOnBoard`'s `<=` allows. A block ending exactly there
        // (Sun 22:00 to the board's last midnight) must be found and removed
        // by 'clear Sam next week', never asked `day_off_board`.
        const edgeBlk = zBlk({
          id: "uwEdge",
          nodeId: "zc1",
          operatorId: "zsam",
          startMin: 13 * 1440 + 1320, // Sun 2026-09-13, 22:00
          endMin: 13 * 1440 + 1440, // exactly the board's own last midnight
        });
        const command: UnassignCommand = {
          intent: "unassign",
          operator: "Sam",
          place: ["Cell 1"],
          day: { kind: "every_day", week: "next_week" },
          span: null,
          existing: null,
          shift: null,
          until: null,
        };
        const res = expandCommand(
          command,
          zCtx({ days: rwDays, todayIndex: 2, assignments: [edgeBlk] }),
        );
        expect(res.ok).toBe(true);
        if (res.ok && res.command.intent !== "several") {
          expect((res.command as UnassignCommand).existing).toEqual({
            kind: "remove",
            assignmentId: "uwEdge",
          });
        } else {
          throw new Error("expected exactly one removal (the edge block)");
        }
      });
    });
  });

  // -------------------------------------------------------------------------
  // PT1-PT2: an ordinary command and a several come back as the SAME object.
  // -------------------------------------------------------------------------

  describe("PT: pass-through", () => {
    it("PT1: an ordinary single -- the exact same object, never a copy", () => {
      const command = zAssign();
      const res = expandCommand(command, zCtx());
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.command).toBe(command);
    });

    it("PT2: an already-built several -- the exact same object", () => {
      const command = { intent: "several" as const, commands: [zAssign(), zAssign()] };
      const res = expandCommand(command, zCtx());
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.command).toBe(command);
    });
  });

  // -------------------------------------------------------------------------
  // SWEEP (reviewer finding, 14 Sept follow-up): one representative written
  // command per board-answered intent (everyone-unassign, everyone-move,
  // replace, swap, copy, an absence's until), run through BOTH
  // resolveCommand AND formatCommand -- neither may throw, and every literal
  // field the brief names (attach/existing/shift/until, by intent) must be
  // present, not `undefined`. `commandResolve.test.ts` never called
  // `formatCommand` at all before this -- the bar's own lot re-runs a
  // written command's WORDS through the rules parser after every button
  // press (D127), so a command whose literal is incomplete (a field quietly
  // `undefined` instead of `null`) would only ever be caught there, live.
  // -------------------------------------------------------------------------

  describe("SWEEP: every written command is a complete literal; resolveCommand/formatCommand never throw", () => {
    function sweep(label: string, cmd: SingleCommand, ctxForResolve: ResolveContext) {
      it(`${label}: complete literal, resolveCommand and formatCommand both run clean`, () => {
        expect(() => resolveCommand(cmd, ctxForResolve)).not.toThrow();
        let text = "";
        expect(() => {
          text = formatCommand(cmd);
        }).not.toThrow();
        expect(text.length).toBeGreaterThan(0);
        if (cmd.intent === "assign") {
          expect(cmd.attach).not.toBeUndefined();
          expect(cmd.existing).not.toBeUndefined();
          expect(cmd.shift).not.toBeUndefined();
          expect(cmd.start).not.toBeUndefined();
          expect(cmd.end).not.toBeUndefined();
        } else if (cmd.intent === "unassign") {
          expect(cmd.existing).not.toBeUndefined();
          expect(cmd.shift).not.toBeUndefined();
          expect(cmd.until).not.toBeUndefined();
          expect(cmd.span).not.toBeUndefined();
        } else if (cmd.intent === "move") {
          expect(cmd.existing).not.toBeUndefined();
          expect(cmd.toPlace).not.toBeUndefined();
          expect(cmd.span).not.toBeUndefined();
          expect(cmd.shift).not.toBeUndefined();
          expect(cmd.adjust).not.toBeUndefined();
        } else if (cmd.intent === "book") {
          expect(cmd.existing).not.toBeUndefined();
          expect(cmd.shift).not.toBeUndefined();
          expect(cmd.headcount).not.toBeUndefined();
          expect(cmd.start).not.toBeUndefined();
          expect(cmd.end).not.toBeUndefined();
        }
      });
    }

    function writtenCommandsOf(exp: ReturnType<typeof expandCommand>): SingleCommand[] {
      if (!exp.ok) return [];
      // S58: `expandCommand`'s own success type also allows a pass-through
      // `HeadcountCommand` (R-415: never part of a lot) -- never produced by
      // any sweep case below, filtered out here only so this stays typed as
      // `SingleCommand[]`.
      const cmds = exp.command.intent === "several" ? exp.command.commands : [exp.command];
      return cmds.filter((c): c is SingleCommand => c.intent !== "headcount");
    }

    // everyone-unassign.
    {
      const b1 = zBlk({ startMin: 2 * 1440 + 600, endMin: 2 * 1440 + 720 });
      const c = zCtx({ assignments: [b1] });
      const cmds = writtenCommandsOf(
        expandCommand(
          {
            intent: "unassign",
            operator: "everyone",
            place: ["Cell 1"],
            day: { kind: "date", iso: "2026-09-03" },
            span: null,
            existing: null,
            shift: null,
            until: null,
          },
          c,
        ),
      );
      cmds.forEach((cc, i) => sweep(`SWEEP-EX-unassign-${i}`, cc, c));
    }

    // everyone-move.
    {
      const b1 = zBlk({ startMin: 2 * 1440 + 600, endMin: 2 * 1440 + 720 });
      const c = zCtx({ assignments: [b1] });
      const cmds = writtenCommandsOf(
        expandCommand(
          {
            intent: "move",
            operator: "everyone",
            place: ["Cell 1"],
            toPlace: ["Cell 3"],
            day: { kind: "date", iso: "2026-09-03" },
            span: null,
            existing: null,
            shift: null,
            adjust: null,
          },
          c,
        ),
      );
      cmds.forEach((cc, i) => sweep(`SWEEP-EX-move-${i}`, cc, c));
    }

    // replace.
    {
      const b1 = zBlk({ operatorId: "zsam", startMin: 2 * 1440 + 600, endMin: 2 * 1440 + 720 });
      const c = zCtx({ assignments: [b1] });
      const cmds = writtenCommandsOf(
        expandCommand(
          {
            intent: "replace",
            operator: "Sam",
            with: "Ana",
            place: [],
            day: { kind: "date", iso: "2026-09-03" },
            span: null,
            shift: null,
          },
          c,
        ),
      );
      cmds.forEach((cc, i) => sweep(`SWEEP-RP-${i}`, cc, c));
    }

    // swap.
    {
      const b1 = zBlk({
        id: "swb1",
        operatorId: "zsam",
        nodeId: "zc1",
        startMin: 2 * 1440 + 600,
        endMin: 2 * 1440 + 720,
      });
      const b2 = zBlk({
        id: "swb2",
        operatorId: "zana",
        nodeId: "zc2",
        startMin: 2 * 1440 + 780,
        endMin: 2 * 1440 + 900,
      });
      const c = zCtx({ assignments: [b1, b2] });
      const cmds = writtenCommandsOf(
        expandCommand(
          {
            intent: "swap",
            operator: "Sam",
            other: "Ana",
            place: [],
            day: { kind: "date", iso: "2026-09-03" },
            span: null,
            shift: null,
          },
          c,
        ),
      );
      cmds.forEach((cc, i) => sweep(`SWEEP-SW-${i}`, cc, c));
    }

    // copy.
    {
      const run1 = zRun();
      const c = zCtx({ runs: [run1] });
      const cmds = writtenCommandsOf(
        expandCommand(
          {
            intent: "copy",
            place: ["Cell 1"],
            from: { kind: "date", iso: "2026-09-03" },
            to: { kind: "date", iso: "2026-09-04" },
          },
          c,
        ),
      );
      cmds.forEach((cc, i) => sweep(`SWEEP-CP-${i}`, cc, c));
    }

    // an absence's own until.
    {
      const b1 = zBlk({ operatorId: "zsam", startMin: 2 * 1440 + 600, endMin: 2 * 1440 + 720 });
      const b2 = zBlk({
        id: "absb2",
        operatorId: "zsam",
        startMin: 3 * 1440 + 600,
        endMin: 3 * 1440 + 720,
      });
      const c = zCtx({ assignments: [b1, b2] });
      const cmds = writtenCommandsOf(
        expandCommand(
          {
            intent: "unassign",
            operator: "Sam",
            place: [],
            day: { kind: "date", iso: "2026-09-03" },
            span: null,
            existing: null,
            shift: null,
            until: { kind: "date", iso: "2026-09-04" },
          },
          c,
        ),
      );
      cmds.forEach((cc, i) => sweep(`SWEEP-AB-${i}`, cc, c));
    }

    // S58 (R-413, D132 item 2): a split -- the board's move-then-assign pair.
    {
      const b1 = zBlk({ startMin: 2 * 1440 + 600, endMin: 2 * 1440 + 840 });
      const c = zCtx({ assignments: [b1] });
      const cmds = writtenCommandsOf(
        expandCommand(
          {
            intent: "split",
            operator: "Sam",
            place: ["Cell 1"],
            day: { kind: "date", iso: "2026-09-03" },
            at: { hour: 12, minute: 0 },
          },
          c,
        ),
      );
      cmds.forEach((cc, i) => sweep(`SWEEP-SP-${i}`, cc, c));
    }
  });

  // -------------------------------------------------------------------------
  // §4: `resolveCommand` on the new shapes.
  // -------------------------------------------------------------------------

  describe("§4: resolveCommand on unexpanded board commands and everyone/until", () => {
    it("a BoardCommand reaching resolveCommand unexpanded -- expand_first, never a crash", () => {
      const replace: ReplaceCommand = {
        intent: "replace",
        operator: "Sam",
        with: "Ana",
        place: [],
        day: null,
        span: null,
        shift: null,
      };
      expect(resolveCommand(replace, zCtx())).toEqual({
        ok: false,
        question: { kind: "expand_first", intent: "replace" },
      });

      const swap: SwapCommand = {
        intent: "swap",
        operator: "Sam",
        other: "Ana",
        place: [],
        day: null,
        span: null,
        shift: null,
      };
      expect(resolveCommand(swap, zCtx())).toEqual({
        ok: false,
        question: { kind: "expand_first", intent: "swap" },
      });

      const copy: CopyCommand = {
        intent: "copy",
        place: [],
        from: { kind: "today" },
        to: { kind: "tomorrow" },
      };
      expect(resolveCommand(copy, zCtx())).toEqual({
        ok: false,
        question: { kind: "expand_first", intent: "copy" },
      });
    });

    it("an EVERYONE unassign reaching resolveCommand unexpanded -- unknown operator, naturally", () => {
      const command: UnassignCommand = {
        intent: "unassign",
        operator: "everyone",
        place: ["Cell 1"],
        day: null,
        span: null,
        shift: null,
        existing: null,
        until: null,
      };
      const res = resolveCommand(command, zCtx());
      expect(res).toEqual({
        ok: false,
        question: { kind: "unknown", field: "operator", text: "everyone" },
      });
    });

    it("an unassign with `until` reaching resolveCommand unexpanded -- until is simply never read", () => {
      const withUntil: UnassignCommand = {
        intent: "unassign",
        operator: "Sam",
        place: ["Cell 1"],
        day: { kind: "date", iso: "2026-09-03" },
        span: null,
        shift: null,
        existing: null,
        until: { kind: "date", iso: "2026-09-05" },
      };
      const withoutUntil: UnassignCommand = { ...withUntil, until: null };
      const blk = zBlk();
      expect(resolveCommand(withUntil, zCtx({ assignments: [blk] }))).toEqual(
        resolveCommand(withoutUntil, zCtx({ assignments: [blk] })),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// S59-a (docs/agent-briefs/s59-a-nearest-brief.md, D133 item 1): a word that
// matches nothing offers the nearest names as `unknown`'s own optional
// `suggestions`. NN1 onward.
// ---------------------------------------------------------------------------

describe("commandResolve: S59-a nearest names for a word that matches nothing (D133 item 1)", () => {
  const commonFastener = { id: "cf1", sku: "CF-1", name: "Common Fastener" };
  const bracketA = { id: "brA", sku: "BR-A", name: "Bracket A" };
  const bracketB = { id: "brB", sku: "BR-B", name: "Bracket B" };
  const housingA = { id: "hoA", sku: "HA-9", name: "Housing A" };
  const housingB = { id: "hoB", sku: "HB-9", name: "Housing B" };
  const housingC = { id: "hoC", sku: "HC-9", name: "Housing C" };
  const opA1 = { id: "oa1", displayName: "Operator A1", employeeRef: null, active: true };
  const opA2 = { id: "oa2", displayName: "Operator A2", employeeRef: null, active: true };
  const opA3 = { id: "oa3", displayName: "Operator A3", employeeRef: null, active: true };

  // NN1: the plural passes (brief §1). A plural search word finds a
  // singular item ("Common Fasteners" -> "Common Fastener") -- resolved
  // fully, no question at all (also NN4's own case: "resolves without a
  // question, the plural pass wins first").
  it("NN1: 'Common Fasteners' finds 'Common Fastener' -- resolves, no question", () => {
    const ctx = baseCtx({ products: [commonFastener], offeredAt: () => [{ id: "cf1" }] });
    const res = resolveCommand(cmd({ product: "Common Fasteners" }), ctx);
    expect(res.ok).toBe(true);
    if (res.ok && res.resolved.intent === "assign") {
      expect(res.resolved.productId).toBe("cf1");
    }
  });

  // NN1 twin: a word the plain three tiers already resolve never reaches
  // the plural passes -- "Bracket" still an ambiguous starts-with list, not
  // narrowed or changed by the new fallback.
  it("NN1 twin: 'Bracket' still finds Bracket A and Bracket B (a starts-with, unaffected)", () => {
    const ctx = baseCtx({
      products: [bracketA, bracketB],
      offeredAt: () => [{ id: "brA" }, { id: "brB" }],
    });
    const res = resolveCommand(cmd({ product: "Bracket" }), ctx);
    expect(res).toEqual({
      ok: false,
      question: {
        kind: "ambiguous",
        field: "product",
        text: "Bracket",
        candidates: [
          { id: "brA", label: "Bracket A", word: "Bracket A" },
          { id: "brB", label: "Bracket B", word: "Bracket B" },
        ],
      },
    });
  });

  // NN2: "Housing Pay" (a misheard "Housing A", D133's own example) offers
  // every close product name, fixture order.
  it("NN2: 'Housing Pay' offers Housing A, Housing B and Housing C, fixture order", () => {
    const ctx = baseCtx({ products: [housingA, housingB, housingC], offeredAt: () => [] });
    const res = resolveCommand(cmd({ product: "Housing Pay" }), ctx);
    expect(res).toEqual({
      ok: false,
      question: {
        kind: "unknown",
        field: "product",
        text: "Housing Pay",
        suggestions: [
          { id: "hoA", label: "Housing A", word: "Housing A" },
          { id: "hoB", label: "Housing B", word: "Housing B" },
          { id: "hoC", label: "Housing C", word: "Housing C" },
        ],
      },
    });
  });

  // NN3: the same word offers only what the fixture actually has.
  it("NN3: 'Housing Pay' offers only Housing A when only it exists", () => {
    const ctx = baseCtx({ products: [housingA], offeredAt: () => [] });
    const res = resolveCommand(cmd({ product: "Housing Pay" }), ctx);
    expect(res).toEqual({
      ok: false,
      question: {
        kind: "unknown",
        field: "product",
        text: "Housing Pay",
        suggestions: [{ id: "hoA", label: "Housing A", word: "Housing A" }],
      },
    });
  });

  // NN5: a word that already prefix-matches more than one name is still
  // `ambiguous` -- never routed through `nearestNames` at all.
  it("NN5: 'Operator A' (a prefix of two) is still ambiguous, not a suggestion", () => {
    const ctx = baseCtx({ operators: [opA1, opA2] });
    const res = resolveCommand(cmd({ operator: "Operator A" }), ctx);
    expect(res).toEqual({
      ok: false,
      question: {
        kind: "ambiguous",
        field: "operator",
        text: "Operator A",
        candidates: [
          { id: "oa1", label: "Operator A1", word: "Operator A1" },
          { id: "oa2", label: "Operator A2", word: "Operator A2" },
        ],
      },
    });
  });

  // NN6: a word close to nothing offers nothing -- byte-identical to the
  // question before `suggestions` existed.
  it("NN6: 'xyzzy' is close to nothing -- no suggestions field at all", () => {
    const ctx = baseCtx({ operators: [opA1, opA2] });
    const res = resolveCommand(cmd({ operator: "xyzzy" }), ctx);
    expect(res).toEqual({
      ok: false,
      question: { kind: "unknown", field: "operator", text: "xyzzy" },
    });
  });

  // NN7: a person. "Opertor A3" prefix-matches nothing (its own middle
  // letters are swapped), but its trailing digit picks out the one operator
  // whose own digit matches -- "Operator A1"/"A2" score 0 (R22/R23's own
  // digit-exact rule), only "Operator A3" is offered.
  it("NN7: a person ('Opertor A3') offers the suggestion Operator A3", () => {
    const ctx = baseCtx({ operators: [opA1, opA2, opA3] });
    const res = resolveCommand(cmd({ operator: "Opertor A3" }), ctx);
    expect(res).toEqual({
      ok: false,
      question: {
        kind: "unknown",
        field: "operator",
        text: "Opertor A3",
        suggestions: [{ id: "oa3", label: "Operator A3", word: "Operator A3" }],
      },
    });
  });

  // NN8: a place. "Sell 1" (a misheard "Cell 1") offers Cell 1, the two
  // cells sharing that name (c1a, c1b, brief §5's own fixture) collapsed to
  // one suggestion; "Cell 2" is excluded by the same digit-exact rule R22/
  // R23 pin ("1" against "2").
  it("NN8: a place ('Sell 1') offers Cell 1, not Cell 2", () => {
    const res = resolveCommand(cmd({ place: ["Sell 1", "Line 1"] }), baseCtx());
    expect(res).toEqual({
      ok: false,
      question: {
        kind: "unknown",
        field: "place",
        text: "Sell 1",
        suggestions: [{ id: "c1a", label: "Cell 1 — Plant 1 › Assembly › Line 1", word: "Cell 1" }],
      },
    });
  });

  // NN9: every suggestion's own `word`, fed back into the field it named
  // and the sentence re-run through `resolveCommand`, resolves to exactly
  // one thing -- an operator suggestion and a place suggestion both.
  it("NN9: a suggestion's word re-resolves to exactly one thing through resolveCommand", () => {
    const placeCtx = baseCtx();
    const placeAnswer = resolveCommand(cmd({ place: ["Sell 1", "Line 1"] }), placeCtx);
    if (placeAnswer.ok || placeAnswer.question.kind !== "unknown") throw new Error("setup");
    const placeWord = placeAnswer.question.suggestions?.[0]?.word;
    expect(placeWord).toBe("Cell 1");
    const placeRerun = resolveCommand(cmd({ place: [placeWord!, "Line 1"] }), placeCtx);
    expect(placeRerun.ok).toBe(true);

    const opCtx = baseCtx({ operators: [opA1, opA2, opA3] });
    const opAnswer = resolveCommand(cmd({ operator: "Opertor A3" }), opCtx);
    if (opAnswer.ok || opAnswer.question.kind !== "unknown") throw new Error("setup");
    const opWord = opAnswer.question.suggestions?.[0]?.word;
    expect(opWord).toBe("Operator A3");
    const opRerun = resolveCommand(cmd({ operator: opWord! }), opCtx);
    expect(opRerun.ok).toBe(true);
  });

  // NN10 (reviewer): `resolveEveryonePlaceCells` -- the EVERYONE/`copy`
  // place resolution (R-407/D130 item 5, D130 item 4) -- built its OWN
  // `unknown` question on a dead end and never offered a suggestion, unlike
  // every other intent's place field (`resolveCellStep`, above): "copy Cell
  // 1 to tomorrow" misheard as "copy Sell 1 to tomorrow" got a dead end with
  // no way to pick "Cell 1", while the identical typo on an assign's place
  // already did (NN8). Fixed by routing its dead end through the same
  // `nodeSuggestions` helper, scoped to `allNodes` -- the SAME pool this
  // function itself searches (never `ctx.cells`: a line or area can be this
  // function's OWN match, so it must be a possible SUGGESTION too).
  it("NN10: expandCommand's copy offers a place suggestion on a dead end, the same as an ordinary assign", () => {
    const copyCmd: CopyCommand = {
      intent: "copy",
      place: ["Sell 1"],
      from: { kind: "today" },
      to: { kind: "tomorrow" },
    };
    const result = expandCommand(copyCmd, baseCtx());
    expect(result).toEqual({
      ok: false,
      question: {
        kind: "unknown",
        field: "place",
        text: "Sell 1",
        suggestions: [{ id: "c1a", label: "Cell 1 — Plant 1 › Assembly › Line 1", word: "Cell 1" }],
      },
    });
  });

  // NN10 twin: the same function backs the EVERYONE reading of unassign and
  // move (R-407) -- "unassign everyone from Sell 1" gets the same offer.
  it("NN10 twin: 'unassign everyone from Sell 1' offers the same place suggestion", () => {
    const result = expandCommand(
      unassignCmd({ operator: "everyone", place: ["Sell 1"] }),
      baseCtx(),
    );
    expect(result).toEqual({
      ok: false,
      question: {
        kind: "unknown",
        field: "place",
        text: "Sell 1",
        suggestions: [{ id: "c1a", label: "Cell 1 — Plant 1 › Assembly › Line 1", word: "Cell 1" }],
      },
    });
  });

  // NN11: a display name shared by two operators (S59-b's demo-person
  // convention doesn't cover this, so built here) -- a near-miss suggestion
  // offers the shared name ONCE (deduplicated, same as NN8's two same-named
  // cells), but picking it must re-ask `ambiguous` between the two real
  // people, never silently resolve to one of them.
  it("NN11: a suggestion for a name shared by two people re-asks ambiguous, never picks one", () => {
    const james1 = { id: "j1", displayName: "James", employeeRef: "E1", active: true };
    const james2 = { id: "j2", displayName: "James", employeeRef: "E2", active: true };
    const ctx = baseCtx({ operators: [james1, james2] });
    const answer = resolveCommand(cmd({ operator: "Jaymes" }), ctx);
    expect(answer).toEqual({
      ok: false,
      question: {
        kind: "unknown",
        field: "operator",
        text: "Jaymes",
        suggestions: [{ id: "j1", label: "James", word: "James" }],
      },
    });
    if (answer.ok || answer.question.kind !== "unknown") throw new Error("setup");
    const word = answer.question.suggestions?.[0]?.word;
    expect(word).toBe("James");
    const rerun = resolveCommand(cmd({ operator: word! }), ctx);
    expect(rerun).toEqual({
      ok: false,
      question: {
        kind: "ambiguous",
        field: "operator",
        text: "James",
        candidates: [
          { id: "j1", label: "James", word: "James" },
          { id: "j2", label: "James", word: "James" },
        ],
      },
    });
  });

  // NN12: the plural pass never over-fires on a name that already IS its
  // own plural spelling, or one that merely ends in "s" -- "James" resolves
  // to James directly (never truncated to a search for "Jame"), and "Buses"
  // to the actual product named "Buses" (never to a "Bus" it also has).
  it("NN12: 'James' (ends in s) resolves to James, never a search for 'Jame'", () => {
    const james = { id: "j1", displayName: "James", employeeRef: null, active: true };
    const res = resolveCommand(cmd({ operator: "James" }), baseCtx({ operators: [james] }));
    expect(res.ok).toBe(true);
    if (res.ok && res.resolved.intent === "assign") expect(res.resolved.operatorId).toBe("j1");
  });

  it("NN12 twin: 'Buses' resolves to the product literally named Buses, not 'Bus'", () => {
    const bus = { id: "bu1", sku: "BU-1", name: "Bus" };
    const buses = { id: "bu2", sku: "BU-2", name: "Buses" };
    const ctx = baseCtx({
      products: [bus, buses],
      offeredAt: () => [{ id: "bu1" }, { id: "bu2" }],
    });
    const res = resolveCommand(cmd({ product: "Buses" }), ctx);
    expect(res.ok).toBe(true);
    if (res.ok && res.resolved.intent === "assign") expect(res.resolved.productId).toBe("bu2");
  });

  // NN13: the suggestions' own `word`, fed back through EVERY step that can
  // ask an `unknown` question (D133 item 1's own list) -- a loop, not one
  // case per intent, so a step added later that forgets to wire suggestions
  // in fails here too. `book`/`headcount` use `resolvePartStep`; `assign`/
  // `unassign`/`move`/`replace`/`swap`/`split` use `resolvePersonStep`;
  // `copy` (and the EVERYONE reading NN10 pins) uses `resolveEveryonePlace
  // Cells`. Every one of the nine must clear the dead end once the
  // suggested word is substituted back in.
  it("NN13: a suggestion's word re-resolves cleanly through every intent (assign, book, unassign, move, replace, swap, copy, split, headcount)", () => {
    // "Opertor Sam" -> "Operator Sam" is the same letter-transposition typo
    // NN7 already pins for a person ("Opertor A3" -> "Operator A3"); reused
    // here so every intent's own near-miss is known, independently, to
    // clear the floor.
    const sam = { id: "sam", displayName: "Operator Sam", employeeRef: null, active: true };
    const sam2 = { id: "sam2", displayName: "Sam Two", employeeRef: null, active: true };
    const opCtx = baseCtx({ operators: [sam] });
    const twoOpCtx = baseCtx({ operators: [sam, sam2] });

    function assertUnknownWithSuggestion(
      label: string,
      result: { ok: boolean; question?: unknown },
      expectedWord: string,
    ): string {
      expect(result.ok, `${label} first pass`).toBe(false);
      const q = (result as { question: { kind: string; suggestions?: Candidate[] } }).question;
      if (q.kind !== "unknown") {
        throw new Error(`${label}: expected an unknown question, got ${JSON.stringify(result)}`);
      }
      const word = q.suggestions?.[0]?.word;
      expect(word, `${label} suggestion word`).toBe(expectedWord);
      return word!;
    }

    // assign
    const assignFirst = resolveCommand(cmd({ operator: "Opertor Sam" }), opCtx);
    const assignWord = assertUnknownWithSuggestion("assign", assignFirst, "Operator Sam");
    expect(resolveCommand(cmd({ operator: assignWord }), opCtx).ok).toBe(true);

    // book
    const bookFirst = resolveCommand(bookCmd({ product: "Houseing A" }), baseCtx());
    const bookWord = assertUnknownWithSuggestion("book", bookFirst, "Housing A");
    expect(resolveCommand(bookCmd({ product: bookWord }), baseCtx()).ok).toBe(true);

    // unassign -- no block on the board for Operator Sam here, so the
    // clearest fixture-independent proof the NAME resolved is that the
    // second pass is no longer the SAME dead end (a different question,
    // "no_block", not "unknown" again).
    const unassignFirst = resolveCommand(unassignCmd({ operator: "Opertor Sam" }), opCtx);
    const unassignWord = assertUnknownWithSuggestion("unassign", unassignFirst, "Operator Sam");
    const unassignRerun = resolveCommand(unassignCmd({ operator: unassignWord }), opCtx);
    expect(unassignRerun.ok || unassignRerun.question.kind !== "unknown").toBe(true);

    // move -- same reasoning as unassign.
    const moveFirst = resolveCommand(moveCmd({ operator: "Opertor Sam" }), opCtx);
    const moveWord = assertUnknownWithSuggestion("move", moveFirst, "Operator Sam");
    const moveRerun = resolveCommand(moveCmd({ operator: moveWord }), opCtx);
    expect(moveRerun.ok || moveRerun.question.kind !== "unknown").toBe(true);

    // headcount
    const hc = (product: string): HeadcountCommand => ({
      intent: "headcount",
      product,
      place: ["Cell 1", "Line 1"],
      day: null,
      span: null,
      shift: null,
      headcount: 4,
    });
    // headcount needs an existing RUN to update (S58, R-415) -- none is set
    // up here, so (as with unassign/move above) the proof the NAME resolved
    // is that the second pass asks something else, not "unknown" again.
    const headcountFirst = resolveCommand(hc("Houseing A"), baseCtx());
    const headcountWord = assertUnknownWithSuggestion("headcount", headcountFirst, "Housing A");
    const headcountRerun = resolveCommand(hc(headcountWord), baseCtx());
    expect(headcountRerun.ok || headcountRerun.question.kind !== "unknown").toBe(true);

    // replace/swap/copy/split are board-answered -- `expandCommand`, not
    // `resolveCommand` (D130 item 1/2).
    const replace = (withWord: string): ReplaceCommand => ({
      intent: "replace",
      operator: "Sam Two",
      with: withWord,
      place: ["Cell 1", "Line 1"],
      day: null,
      span: { start: { hour: 10, minute: 0 }, end: { hour: 14, minute: 0 } },
      shift: null,
    });
    // No block on the board for either operator here, so (as with unassign/
    // move/headcount above) the second pass asking something OTHER than
    // "unknown" is the proof the name itself resolved.
    const replaceFirst = expandCommand(replace("Opertor Sam"), twoOpCtx);
    const replaceWord = assertUnknownWithSuggestion("replace", replaceFirst, "Operator Sam");
    const replaceRerun = expandCommand(replace(replaceWord), twoOpCtx);
    expect(replaceRerun.ok || replaceRerun.question.kind !== "unknown").toBe(true);

    const swap = (otherWord: string): SwapCommand => ({
      intent: "swap",
      operator: "Sam Two",
      other: otherWord,
      place: ["Cell 1", "Line 1"],
      day: null,
      span: { start: { hour: 10, minute: 0 }, end: { hour: 14, minute: 0 } },
      shift: null,
    });
    const swapFirst = expandCommand(swap("Opertor Sam"), twoOpCtx);
    const swapWord = assertUnknownWithSuggestion("swap", swapFirst, "Operator Sam");
    const swapRerun = expandCommand(swap(swapWord), twoOpCtx);
    expect(swapRerun.ok || swapRerun.question.kind !== "unknown").toBe(true);

    const copy = (place: string): CopyCommand => ({
      intent: "copy",
      place: [place],
      from: { kind: "today" },
      to: { kind: "tomorrow" },
    });
    const copyFirst = expandCommand(copy("Sell 1"), baseCtx());
    const copyWord = assertUnknownWithSuggestion("copy", copyFirst, "Cell 1");
    const copyRerun = expandCommand(copy(copyWord), baseCtx());
    expect(copyRerun.ok || copyRerun.question.kind !== "unknown").toBe(true);

    const split = (operator: string): SplitCommand => ({
      intent: "split",
      operator,
      place: ["Cell 1", "Line 1"],
      day: null,
      at: { hour: 12, minute: 0 },
    });
    const splitFirst = expandCommand(split("Opertor Sam"), opCtx);
    const splitWord = assertUnknownWithSuggestion("split", splitFirst, "Operator Sam");
    const splitRerun = expandCommand(split(splitWord), opCtx);
    expect(splitRerun.ok || splitRerun.question.kind !== "unknown").toBe(true);
  });
});

// ---------------------------------------------------------------------------
// S60-b (docs/agent-briefs/s60-b-which-part-brief.md, R-422): a sentence with
// no part -- or a product word that matches nothing and clears no near name
// either (R-418's own floor) -- asks which part, offered from the RESOLVED
// CELL's own menu (`ctx.offeredAt`), never the whole product list. RS-WP1
// onward.
// ---------------------------------------------------------------------------

describe("commandResolve: S60-b which part, from what the cell makes (R-422)", () => {
  // RS-WP1: an empty product on a cell offering three parts -- all three,
  // `text` naming the CELL (there is no word said to report).
  it("RS-WP1: empty product on a cell with three parts -- three suggestions", () => {
    const ctx = baseCtx({
      products: [ha, hb, cov],
      offeredAt: () => [{ id: "ha" }, { id: "hb" }, { id: "cov" }],
    });
    const res = resolveCommand(cmd({ product: "" }), ctx);
    expect(res).toEqual({
      ok: false,
      question: {
        kind: "unknown",
        field: "product",
        text: "Cell 1",
        suggestions: [
          { id: "ha", label: "Housing A", word: "Housing A" },
          { id: "hb", label: "Housing B", word: "Housing B" },
          { id: "cov", label: "Cover", word: "Cover" },
        ],
      },
    });
  });

  // RS-WP2: a near-miss word ("Housing Pay") still gets R-418's own nearest
  // names FIRST -- never merged with the cell's own (larger) menu, even
  // though this cell offers three parts. Only Housing A/B clear the floor
  // against "Housing Pay" (same fixture NN2 already uses); "Cover" does not,
  // and is never added in just because the cell happens to offer it too --
  // a near name is a better guess at what was actually SAID than the whole
  // menu is, so the two lists are never combined into one (see
  // `resolvePartStep`'s own comment).
  it("RS-WP2: a near-miss word still gets the nearest names first, never merged with the cell's menu", () => {
    const ctx = baseCtx({
      products: [ha, hb, cov],
      offeredAt: () => [{ id: "ha" }, { id: "hb" }, { id: "cov" }],
    });
    const res = resolveCommand(cmd({ product: "Housing Pay" }), ctx);
    expect(res).toEqual({
      ok: false,
      question: {
        kind: "unknown",
        field: "product",
        text: "Housing Pay",
        suggestions: [
          { id: "ha", label: "Housing A", word: "Housing A" },
          { id: "hb", label: "Housing B", word: "Housing B" },
        ],
      },
    });
  });

  // RS-WP3: a cell with nine parts -- the first eight, board order, and
  // `more: true` (never a ninth button, never a silent drop).
  const nineParts = Array.from({ length: 9 }, (_, i) => ({
    id: `pp${i + 1}`,
    sku: `PP-${i + 1}`,
    name: `Part ${i + 1}`,
  }));
  it("RS-WP3: a cell with nine parts -- the first eight, and more: true", () => {
    const ctx = baseCtx({
      products: nineParts,
      offeredAt: () => nineParts.map((p) => ({ id: p.id })),
    });
    const res = resolveCommand(cmd({ product: "" }), ctx);
    expect(res).toEqual({
      ok: false,
      question: {
        kind: "unknown",
        field: "product",
        text: "Cell 1",
        suggestions: nineParts.slice(0, 8).map((p) => ({ id: p.id, label: p.name, word: p.name })),
        more: true,
      },
    });
  });

  // RS-WP4: a cell with no offerings at all -- the existing plain `unknown`,
  // no `suggestions` key at all (byte for byte what every OTHER unknown
  // looked like before R-422).
  it("RS-WP4: empty product on a cell with no offerings at all -- the existing plain unknown", () => {
    const ctx = baseCtx({ products: [ha, hb], offeredAt: () => [] });
    const res = resolveCommand(cmd({ product: "" }), ctx);
    expect(res).toEqual({
      ok: false,
      question: { kind: "unknown", field: "product", text: "" },
    });
  });

  // RS-WP5: every suggestion's own `word` re-resolves to exactly one part --
  // the same dead-end-clearing discipline D133 item 1 already requires of
  // every other `unknown` suggestion (NN13, above), extended to the cell's
  // own menu.
  it("RS-WP5: a suggestion's word re-resolves to exactly one part", () => {
    const ctx = baseCtx({
      products: [ha, hb, cov],
      offeredAt: () => [{ id: "ha" }, { id: "hb" }, { id: "cov" }],
    });
    const res = resolveCommand(cmd({ product: "" }), ctx);
    if (res.ok || res.question.kind !== "unknown" || !res.question.suggestions) {
      throw new Error(`expected an unknown question with suggestions, got ${JSON.stringify(res)}`);
    }
    for (const s of res.question.suggestions) {
      const picked = resolveCommand(cmd({ product: s.word }), ctx);
      expect(picked.ok, `picking "${s.word}" must resolve cleanly`).toBe(true);
    }
  });

  // RS-PP1-RS-PP4 (the S60-b reviewer, 15 Sept): "assign Sam to Housing A 8
  // to 4" -- no separator, so parse.ts's own R-422 branch reads the one
  // segment as the PLACE, product "". "Housing A" is a PART in this fixture
  // (`ha`), not a cell -- `resolveCellStep` must recognise that before
  // falling back to an ordinary "no place" question.
  it("RS-PP1: a single segment that names no cell but names a part exactly -- asPart, every track cell offered", () => {
    const res = resolveCommand(cmd({ product: "", place: ["Housing A"] }), baseCtx());
    expect(res).toEqual({
      ok: false,
      question: {
        kind: "unknown",
        field: "place",
        text: "Housing A",
        asPart: true,
        suggestions: [
          { id: "c1a", label: "Cell 1 — Plant 1 › Assembly › Line 1", word: "Cell 1" },
          { id: "c2", label: "Cell 2 — Plant 1 › Assembly › Line 1", word: "Cell 2" },
          { id: "c1b", label: "Cell 1 — Plant 1 › Assembly › Line 3", word: "Cell 1" },
        ],
      },
    });
  });

  it("RS-PP2: a single segment that near-misses a part (no cell, no exact part) -- asPart too", () => {
    // "Housing Pay" clears R-418's own floor against "Housing A"/"Housing B"
    // (the same fixture NN2/RS-WP2 already use) but matches no cell either.
    const res = resolveCommand(cmd({ product: "", place: ["Housing Pay"] }), baseCtx());
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected a question");
    expect(res.question).toMatchObject({ kind: "unknown", field: "place", asPart: true });
  });

  it("RS-PP3: a single segment that matches neither a cell nor any part (near or exact) -- the ordinary place unknown, no asPart", () => {
    const res = resolveCommand(cmd({ product: "", place: ["Zzyzx"] }), baseCtx());
    expect(res).toEqual({
      ok: false,
      question: { kind: "unknown", field: "place", text: "Zzyzx" },
    });
  });

  it("RS-PP4: more than eight track cells -- asPart with no suggestions at all, never a partial list", () => {
    const manyCells = Array.from({ length: 9 }, (_, i) => ({
      id: `mc${i + 1}`,
      name: `Bay ${i + 1}`,
      path: `plant_1.assembly.bay_${i + 1}`,
    }));
    const ctx = baseCtx({
      cells: manyCells,
      nodeById: new Map([...allNodes, ...manyCells].map((n) => [n.id, n])),
    });
    const res = resolveCommand(cmd({ product: "", place: ["Housing A"] }), ctx);
    expect(res).toEqual({
      ok: false,
      question: { kind: "unknown", field: "place", text: "Housing A", asPart: true },
    });
  });

  it("RS-PP5: picking one of RS-PP1's own suggested cells, part substituted alongside it, resolves cleanly", () => {
    const first = resolveCommand(cmd({ product: "", place: ["Housing A"] }), baseCtx());
    if (first.ok || first.question.kind !== "unknown" || !first.question.suggestions) {
      throw new Error(
        `expected an unknown/place question with suggestions, got ${JSON.stringify(first)}`,
      );
    }
    // c2 ("Cell 2") is the one unambiguous cell among RS-PP1's three
    // suggestions -- the bar's own `pickPartAsPlace` sets BOTH `place` (the
    // picked cell) and `product` (the word recognised as a part, "Housing
    // A") from one button; this proves the combination resolves, not just
    // either field alone.
    const c2Suggestion = first.question.suggestions.find((s) => s.id === "c2");
    if (!c2Suggestion) throw new Error("expected c2 among RS-PP1's suggestions");
    const picked = resolveCommand(
      cmd({ product: "Housing A", place: [c2Suggestion.word] }),
      baseCtx(),
    );
    expect(picked.ok).toBe(true);
    if (picked.ok && picked.resolved.intent === "assign") expect(picked.resolved.nodeId).toBe("c2");
  });

  // NW1-NW3 (the S59 reviewer, 15 Sept): a recogniser writes "Cell one" for
  // "Cell 1" -- `normalizeForMatch`'s own spelled-digit step, exercised
  // through the ordinary cell/operator match tiers and the nearest-name
  // score, the one place it runs for every field.
  it("NW1: 'Cell one' matches Cell 1 exactly (never ties with Cell 2)", () => {
    // Both `c1a` (Line 1) and `c1b` (Line 3) are named "Cell 1" in the
    // fixture -- the "Line 1" qualifier (same as `cmd()`'s own default
    // place) narrows to the one this pins, exactly as plain "Cell 1" would.
    const res = resolveCommand(cmd({ place: ["Cell one", "Line 1"] }), baseCtx());
    expect(res.ok).toBe(true);
    if (res.ok && res.resolved.intent === "assign") expect(res.resolved.nodeId).toBe("c1a");
  });

  // NW2: "decide, and pin what is true" (the brief's own words) -- a
  // standalone word becomes a digit, but the SPACE it leaves behind is not
  // itself dropped ("Operator A three" -> "operator a 3", one space short of
  // "Operator A3"'s own "operator a3"), so the two are never an EXACT tier
  // hit; the near-name floor (D133 item 2) still offers "Operator A3" as a
  // SUGGESTION instead, since a shared digit trail never zeroes the score
  // and the bigram overlap otherwise is near total. Never a silent guess.
  it("NW2: 'Operator A three' does not exact-match 'Operator A3' (the space is not dropped) -- offered as the nearest name instead", () => {
    const opA3 = { id: "oa3x", displayName: "Operator A3", employeeRef: null, active: true };
    const res = resolveCommand(
      cmd({ operator: "Operator A three" }),
      baseCtx({ operators: [opA3] }),
    );
    expect(res).toEqual({
      ok: false,
      question: {
        kind: "unknown",
        field: "operator",
        text: "Operator A three",
        suggestions: [{ id: "oa3x", label: "Operator A3", word: "Operator A3" }],
      },
    });
  });

  // NW3: "one" inside "Stone Cell" is a SUBSTRING, never a standalone word --
  // `\b`-anchored, so it is left untouched; "Stone Cell" still resolves as
  // its own plain name, never corrupted into something with a stray "1".
  it("NW3: 'one' inside 'Stone Cell' is untouched -- resolves as its own name, unaffected", () => {
    const stoneCell = { id: "stc", name: "Stone Cell", path: "plant_1.assembly.line_1.stone_cell" };
    const ctx = baseCtx({
      cells: [...cells, stoneCell],
      nodeById: new Map([...nodeById, [stoneCell.id, stoneCell]]),
      offeredAt: (nodeId: string) => (nodeId === "stc" ? [{ id: "ha" }] : offeredAt(nodeId)),
    });
    const res = resolveCommand(cmd({ place: ["Stone Cell"] }), ctx);
    expect(res.ok).toBe(true);
    if (res.ok && res.resolved.intent === "assign") expect(res.resolved.nodeId).toBe("stc");
  });
});

// -----------------------------------------------------------------------------
// S61-b (docs/agent-briefs/s61-b-training-before-the-yes-brief.md, R-425,
// F-155, F-156): training before the yes -- every resolved write that puts a
// person on a cell asks first when `ctx.certificateGaps` names a gap. NC5-NC7
// (swap/replace/copy) live beside their own fixtures above (`SW`/`RP`/`CP`
// describes, S55); NC1-NC4/NC8/NC9 use the top-of-file fixture (`baseCtx`/
// `cmd`/`op1`/`sp`).
// -----------------------------------------------------------------------------

describe("commandResolve: S61-b training before the yes (R-425, F-155, F-156)", () => {
  it("NC1: assign, uncertified under warn -- not_certified, the skill named, nothing written", () => {
    const res = resolveCommand(
      cmd(),
      baseCtx({
        certificateGaps: certGapsFixture([
          ["op1", "c1a", [{ skill: "Welding", state: "never-trained" }]],
        ]),
      }),
    );
    expect(res).toEqual({
      ok: false,
      question: {
        kind: "not_certified",
        person: "Operator 1",
        cell: "Cell 1",
        missing: ["Welding"],
        policy: "warn",
        inLot: false,
      },
    });
  });

  it('NC2: the same gap under block -- policy: "block", no reason offered; a reason cannot suppress it either', () => {
    const ctx = baseCtx({
      certificateGaps: certGapsFixture([
        ["op1", "c1a", [{ skill: "Welding", state: "never-trained" }]],
      ]),
      eligibilityPolicy: () => "block",
    });
    const expected = {
      ok: false,
      question: {
        kind: "not_certified",
        person: "Operator 1",
        cell: "Cell 1",
        missing: ["Welding"],
        policy: "block",
        inLot: false,
      },
    };
    expect(resolveCommand(cmd(), ctx)).toEqual(expected);
    // "Block" offers no reason to suppress with -- passing one anyway (a
    // caller's bug, never trusted) still asks, byte-identical.
    expect(resolveCommand(cmd(), ctx, { overrideReason: "Supervisor said it's fine" })).toEqual(
      expected,
    );
  });

  it("NC3: a certified person -- no question (the gap belongs to a DIFFERENT operator, proving the check reads operator+cell, not just cell)", () => {
    const res = resolveCommand(
      cmd(),
      baseCtx({
        certificateGaps: certGapsFixture([
          ["sp", "c1a", [{ skill: "Welding", state: "never-trained" }]],
        ]),
      }),
    );
    expect(res.ok).toBe(true);
  });

  it('NC4: a lapsed certificate -- "Welding (lapsed)", never the bare skill name', () => {
    const res = resolveCommand(
      cmd(),
      baseCtx({
        certificateGaps: certGapsFixture([["op1", "c1a", [{ skill: "Welding", state: "lapsed" }]]]),
      }),
    );
    expect(res).toEqual({
      ok: false,
      question: {
        kind: "not_certified",
        person: "Operator 1",
        cell: "Cell 1",
        missing: ["Welding (lapsed)"],
        policy: "warn",
        inLot: false,
      },
    });
  });

  it('NC8 (F-156): resolveDay(null) with todayIndex null -- day_off_board "today", never the window\'s day 0', () => {
    const res = resolveCommand(cmd(), baseCtx({ todayIndex: null }));
    expect(res).toEqual({ ok: false, question: { kind: "day_off_board", text: "today" } });
  });

  it('NC9: resolveCommand\'s own { overrideReason } option suppresses a "warn" question and fills override.reason on the resolved single', () => {
    const ctx = baseCtx({
      certificateGaps: certGapsFixture([
        ["op1", "c1a", [{ skill: "Welding", state: "never-trained" }]],
      ]),
    });
    // Unchanged: no option still asks.
    expect(resolveCommand(cmd(), ctx).ok).toBe(false);

    const res = resolveCommand(cmd(), ctx, {
      overrideReason: "Covering a call-out, supervisor approved",
    });
    expect(res).toEqual({
      ok: true,
      resolved: {
        intent: "assign",
        nodeId: "c1a",
        operatorId: "op1",
        productId: "ha",
        target: { kind: "direct", productId: "ha" },
        range: { startMin: 3 * 1440 + 600, endMin: 3 * 1440 + 840 },
        readout: R1_READOUT,
        attempted: "Operator 1 on Cell 1 in Line 1",
        notTried: "Operator 1 is not on Cell 1 in Line 1.",
        override: { reason: "Covering a call-out, supervisor approved" },
      },
    });

    // Blank/whitespace-only is "no reason given" -- still asks.
    expect(resolveCommand(cmd(), ctx, { overrideReason: "   " }).ok).toBe(false);
  });

  it('NC10 (S72-d review, R-459/R-449): a "block"-policy gap INSIDE A LOT still says nothing changed -- inLot is checked before policy', () => {
    // Untested combination before this pin: NC2 covers policy "block" alone
    // (inLot: false) and NC6/NC5/NC7 cover inLot: true alone (policy
    // "warn"). Merging CommandBar.tsx's own wording into this one builder
    // (R-459) briefly checked `policy === "block"` before `inLot`, which
    // silently dropped the "Nothing changed." suffix for exactly this
    // combination -- the old CommandBar.tsx copy checked `inLot` first and
    // never had the bug.
    expect(
      describeQuestion({
        kind: "not_certified",
        person: "Operator 1",
        cell: "Cell 1",
        missing: ["Welding"],
        policy: "block",
        inLot: true,
      }),
    ).toBe("Not done: Operator 1 is not certified for Cell 1, missing Welding. Nothing changed.");
  });
});

// ---------------------------------------------------------------------------
// ND1-ND12 (S194-D, DEF-0040, R-461 -- the maintainer, 28 Sept: "each day is
// its own bucket"): a clear of a day removes only that day's part of every
// block AND every job across midnight, and asks first, Yes or No, whether the
// other day's part goes too -- one question per direction, previous first.
// The invariant (DEF-0040's pin, stated as a property and run over every
// case): nothing the lot keeps or trims is removed by another step of it, and
// no job removed whole by cascade has a crew block the lot does not itself
// remove.
// ---------------------------------------------------------------------------

describe("commandResolve: S194-D R-461 the night shift split at midnight (DEF-0040)", () => {
  const ndDays: BoardDay[] = [
    { index: 0, iso: "2026-10-11", weekday: 0 }, // Sun
    { index: 1, iso: "2026-10-12", weekday: 1 }, // Mon (today)
    { index: 2, iso: "2026-10-13", weekday: 2 }, // Tue
    { index: 3, iso: "2026-10-14", weekday: 3 }, // Wed
  ];
  const line2 = { id: "line2", name: "Line 2", path: "line2" };
  const cell4 = { id: "cell4", name: "Cell 4", path: "line2.cell4" };
  const cell2 = { id: "cell2", name: "Cell 2", path: "line2.cell2" };
  const cell5 = { id: "cell5", name: "Cell 5", path: "line2.cell5" };
  const priya = { id: "priya", displayName: "Priya Shah", employeeRef: null, active: true };
  const maria = { id: "maria", displayName: "Maria Lopez", employeeRef: null, active: true };
  const ahmed = { id: "ahmed", displayName: "Ahmed Ali", employeeRef: null, active: true };
  const linC = { id: "linc", displayName: "Lin Chen", employeeRef: null, active: true };
  const w = (d: number, m: number): number => d * 1440 + m;

  function ndCtx(overrides: Partial<ResolveContext> = {}): ResolveContext {
    return {
      cells: [cell4, cell2, cell5],
      nodeById: new Map([line2, cell4, cell2, cell5].map((n) => [n.id, n])),
      operators: [priya, maria, ahmed, linC],
      products: [{ id: "ha", sku: "HA", name: "Housing A" }],
      offeredAt: () => [{ id: "ha" }],
      days: ndDays,
      todayIndex: 1,
      todayIso: "2026-10-12",
      wallToOffset: w,
      runs: [],
      fitsRun: (a, r) => a.startMin >= r.startMin && a.endMin <= r.endMin,
      minDurationMinutes: 15,
      assignments: [],
      overlaps: (a, b) => a.startMin < b.endMin && b.startMin < a.endMin,
      findRunOverlap: () => null,
      shiftsAt: () => [],
      nowMinuteOfDay: null,
      wallOf: clampedWallOf(ndDays),
      certificateGaps: () => [],
      eligibilityPolicy: () => "warn",
      settled: true,
      ...overrides,
    } as ResolveContext;
  }
  function blk(
    id: string,
    operatorId: string,
    startMin: number,
    endMin: number,
    over: Partial<ContextAssignment> = {},
  ): ContextAssignment {
    return {
      id,
      nodeId: "cell4",
      operatorId,
      productId: "ha",
      productName: "Housing A",
      startMin,
      endMin,
      label: "",
      runId: null,
      ...over,
    };
  }
  function job(
    id: string,
    startMin: number,
    endMin: number,
    span: string,
    over: Partial<ContextRun> = {},
  ): ContextRun {
    return {
      id,
      nodeId: "cell4",
      productId: "ha",
      startMin,
      endMin,
      label: `Housing A ${span}`,
      span,
      productName: "Housing A",
      headcount: 1,
      ...over,
    };
  }
  function clear(iso: string, place: string[] = ["Cell 4"]): UnassignCommand {
    return {
      intent: "unassign",
      operator: "everyone",
      place,
      day: { kind: "date", iso },
      span: null,
      shift: null,
      existing: null,
      until: null,
    };
  }
  function flat(res: Expansion): SingleCommand[] {
    if (!res.ok) return [];
    if (res.command.intent === "several") return res.command.commands;
    return res.command.intent === "headcount" ? [] : [res.command];
  }
  const removedIds = (res: Expansion): string[] =>
    flat(res).flatMap((c) =>
      c.intent === "unassign" && c.existing?.kind === "remove" ? [c.existing.assignmentId] : [],
    );
  const trimmedIds = (res: Expansion): string[] =>
    flat(res).flatMap((c) =>
      c.intent === "move" && c.existing?.kind === "move" ? [c.existing.assignmentId] : [],
    );
  /** DEF-0040's invariant, as a property: every block is named at most once;
   *  no job is both trimmed and removed; every crew block of a job removed by
   *  cascade is itself a listed removal (so nothing kept, trimmed or left
   *  alone is swept away by the cascade). */
  function holdsInvariant(res: Expansion, ctx: ResolveContext): void {
    if (!res.ok) return;
    const named = [...removedIds(res), ...trimmedIds(res)];
    expect(new Set(named).size, `a block named twice: ${named.join(", ")}`).toBe(named.length);
    const removedRuns = (res.runRemovals ?? []).map((r) => r.runId);
    const trimmedRuns = (res.runTrims ?? []).map((r) => r.runId);
    for (const id of removedRuns) expect(trimmedRuns).not.toContain(id);
    const removed = new Set(removedIds(res));
    for (const runId of removedRuns) {
      for (const x of ctx.assignments) {
        if (x.runId !== runId) continue;
        expect(removed.has(x.id), `crew ${x.id} of cascaded ${runId} is not a listed removal`).toBe(
          true,
        );
      }
    }
  }
  const yesNo = [
    { id: "clear", label: "Yes", word: "yes" },
    { id: "keep", label: "No", word: "no" },
  ];

  // The DEF-0040 fixture: Priya and her Housing A job, Sun 22:00 to Mon 06:00.
  const priyaNight = blk("priyaBlk", "priya", w(0, 1320), w(1, 360), {
    runId: "run1",
    label: "10 pm to 6 am",
  });
  const run1 = job("run1", w(0, 1320), w(1, 360), "10 pm to 6 am");
  // The tester's second pass: Maria and her job, Mon 22:00 to Tue 06:00.
  const mariaNight = blk("mariaBlk", "maria", w(1, 1320), w(2, 360), {
    runId: "run2",
    label: "10 pm to 6 am",
  });
  const run2 = job("run2", w(1, 1320), w(2, 360), "10 pm to 6 am");

  it("ND1: clear Monday over Priya's Sunday night job -- asks about Sunday's part; No trims her block AND the job to end at midnight, nothing removed whole; Yes removes both whole, no trim", () => {
    const ctx = ndCtx({ assignments: [priyaNight], runs: [run1] });
    const asked = expandCommand(clear("2026-10-12"), ctx);
    expect(asked).toEqual({
      ok: false,
      question: {
        kind: "other_day_part",
        direction: "previous",
        day: "Sunday",
        first: { kind: "person", name: "Priya Shah" },
        others: 0,
        at: "10 pm",
        hours: "10 pm to midnight",
        answers: yesNo,
      },
    });
    if (asked.ok) return;
    expect(describeQuestion(asked.question)).toBe(
      "Priya Shah's night shift started Sunday at 10 pm. Clear Sunday's part too, 10 pm to midnight?",
    );

    const no = expandCommand(clear("2026-10-12"), ctx, { previousDayPart: "keep" });
    holdsInvariant(no, ctx);
    if (!no.ok) throw new Error("expected a lot");
    expect(removedIds(no)).toEqual([]);
    expect(trimmedIds(no)).toEqual(["priyaBlk"]);
    expect(no.runRemovals).toBeUndefined();
    expect(no.runTrims).toEqual([
      {
        intent: "trim_run",
        runId: "run1",
        nodeId: "cell4",
        range: { startMin: w(0, 1320), endMin: w(1, 0) },
        readout:
          "The Housing A job on Cell 4 keeps its Sunday part, 10 pm to midnight; Monday's part, midnight to 6 am, is cleared.",
        attempted: "The Housing A job on Cell 4",
        notTried: "The Housing A job on Cell 4 stays as it was, 10 pm to 6 am.",
      },
    ]);
    const move = flat(no)[0] as MoveCommand;
    expect(move.adjust).toEqual({ edge: "end", at: { hour: 0, minute: 0 } });
    const moved = resolveCommand(move, ctx);
    expect(moved.ok).toBe(true);
    if (moved.ok && moved.resolved.intent === "move") {
      expect(moved.resolved.range).toEqual({ startMin: w(0, 1320), endMin: w(1, 0) });
      expect(moved.resolved.readout).toBe(
        "Priya Shah's night shift on Cell 4 keeps its Sunday part, 10 pm to midnight; Monday's part, midnight to 6 am, is cleared.",
      );
    }

    const yes = expandCommand(clear("2026-10-12"), ctx, { previousDayPart: "clear" });
    holdsInvariant(yes, ctx);
    if (!yes.ok) throw new Error("expected a lot");
    expect(trimmedIds(yes)).toEqual([]);
    expect(removedIds(yes)).toEqual(["priyaBlk"]);
    expect(yes.runTrims).toBeUndefined();
    expect(yes.runRemovals).toEqual([
      {
        intent: "remove_run",
        runId: "run1",
        readout:
          "The Housing A job is off Cell 4 2026-10-12; that was 10 pm to 6 am, for 1 person.",
        attempted: "The Housing A job on Cell 4",
        notTried: "The Housing A job on Cell 4 stays as it was, 10 pm to 6 am.",
      },
    ]);
    const removal = flat(yes)[0] as UnassignCommand;
    expect(removal.span).toBeNull(); // 10 pm to 6 am is no one-day clock pair
    expect(resolveCommand(removal, ctx).ok).toBe(true);
  });

  it("ND2: clear Monday over Maria's Monday night job -- asks about Tuesday's part; No keeps Tuesday's part of her block and the job, Yes removes both whole", () => {
    const ctx = ndCtx({ assignments: [mariaNight], runs: [run2] });
    const asked = expandCommand(clear("2026-10-12"), ctx);
    if (asked.ok) throw new Error("expected the question");
    expect(describeQuestion(asked.question)).toBe(
      "Maria Lopez's night shift runs into Tuesday. Clear Tuesday's part too, midnight to 6 am?",
    );
    expect(asked.question).toMatchObject({ direction: "next", day: "Tuesday", at: "6 am" });

    const no = expandCommand(clear("2026-10-12"), ctx, { nextDayPart: "keep" });
    holdsInvariant(no, ctx);
    if (!no.ok) throw new Error("expected a lot");
    expect(trimmedIds(no)).toEqual(["mariaBlk"]);
    expect(removedIds(no)).toEqual([]);
    expect(no.runRemovals).toBeUndefined();
    expect(no.runTrims?.map((t) => [t.runId, t.range, t.readout])).toEqual([
      [
        "run2",
        { startMin: w(2, 0), endMin: w(2, 360) },
        "The Housing A job on Cell 4 keeps its Tuesday part, midnight to 6 am; Monday's part, 10 pm to midnight, is cleared.",
      ],
    ]);
    const moved = resolveCommand(flat(no)[0], ctx);
    expect(moved.ok && moved.resolved.intent === "move" && moved.resolved.readout).toBe(
      "Maria Lopez's night shift on Cell 4 keeps its Tuesday part, midnight to 6 am; Monday's part, 10 pm to midnight, is cleared.",
    );

    const yes = expandCommand(clear("2026-10-12"), ctx, { nextDayPart: "clear" });
    holdsInvariant(yes, ctx);
    if (!yes.ok) throw new Error("expected a lot");
    expect(removedIds(yes)).toEqual(["mariaBlk"]);
    expect(trimmedIds(yes)).toEqual([]);
    expect(yes.runRemovals?.map((r) => r.runId)).toEqual(["run2"]);
    expect(yes.runTrims).toBeUndefined();
  });

  it("ND3: both at once -- the previous question first, then the next one, each answered on its own; all four answer pairs give the lot they say", () => {
    const ctx = ndCtx({ assignments: [priyaNight, mariaNight], runs: [run1, run2] });
    const first = expandCommand(clear("2026-10-12"), ctx);
    expect(first).toMatchObject({
      ok: false,
      question: { kind: "other_day_part", direction: "previous" },
    });
    for (const prev of ["keep", "clear"] as const) {
      const second = expandCommand(clear("2026-10-12"), ctx, { previousDayPart: prev });
      expect(second).toMatchObject({
        ok: false,
        question: { kind: "other_day_part", direction: "next" },
      });
      for (const next of ["keep", "clear"] as const) {
        const res = expandCommand(clear("2026-10-12"), ctx, {
          previousDayPart: prev,
          nextDayPart: next,
        });
        holdsInvariant(res, ctx);
        if (!res.ok) throw new Error(`expected a lot for ${prev}/${next}`);
        expect(trimmedIds(res).includes("priyaBlk"), `${prev}/${next}`).toBe(prev === "keep");
        expect(removedIds(res).includes("priyaBlk"), `${prev}/${next}`).toBe(prev === "clear");
        expect(trimmedIds(res).includes("mariaBlk"), `${prev}/${next}`).toBe(next === "keep");
        expect(removedIds(res).includes("mariaBlk"), `${prev}/${next}`).toBe(next === "clear");
        const trimmedRuns = (res.runTrims ?? []).map((t) => t.runId);
        const removedRuns = (res.runRemovals ?? []).map((r) => r.runId);
        expect(trimmedRuns.includes("run1")).toBe(prev === "keep");
        expect(removedRuns.includes("run1")).toBe(prev === "clear");
        expect(trimmedRuns.includes("run2")).toBe(next === "keep");
        expect(removedRuns.includes("run2")).toBe(next === "clear");
      }
    }
  });

  it("ND4: three night blocks in one direction -- ONE question naming the first by board order and '2 others'; the hours are left out when their starts differ", () => {
    const three = [
      blk("a", "priya", w(0, 1320), w(1, 360)),
      blk("b", "maria", w(0, 1320), w(1, 360), { nodeId: "cell2" }),
      blk("c", "ahmed", w(0, 1320), w(1, 360), { nodeId: "cell5" }),
    ];
    const same = expandCommand(clear("2026-10-12", ["Line 2"]), ndCtx({ assignments: three }));
    if (same.ok) throw new Error("expected the question");
    expect(same.question).toMatchObject({ others: 2, at: "10 pm", hours: null });
    expect(describeQuestion(same.question)).toBe(
      "Priya Shah and 2 others started their night shift Sunday at 10 pm. Clear Sunday's part too?",
    );
    const differ = [three[0], three[1], { ...three[2], startMin: w(0, 1260) }];
    const mixed = expandCommand(clear("2026-10-12", ["Line 2"]), ndCtx({ assignments: differ }));
    if (mixed.ok) throw new Error("expected the question");
    expect(describeQuestion(mixed.question)).toBe(
      "Priya Shah and 2 others started their night shift Sunday. Clear Sunday's part too?",
    );
    // The other direction's several-people wording.
    const outs = [
      blk("d", "maria", w(1, 1320), w(2, 360)),
      blk("e", "linc", w(1, 1380), w(2, 360), { nodeId: "cell2" }),
    ];
    const next = expandCommand(clear("2026-10-12", ["Line 2"]), ndCtx({ assignments: outs }));
    if (next.ok) throw new Error("expected the question");
    expect(describeQuestion(next.question)).toBe(
      "Maria Lopez and 1 other have night shifts running into Tuesday until 6 am. Clear Tuesday's part too?",
    );
    // One answer covers all three.
    const ctx = ndCtx({ assignments: three });
    const res = expandCommand(clear("2026-10-12", ["Line 2"]), ctx, { previousDayPart: "keep" });
    holdsInvariant(res, ctx);
    expect(trimmedIds(res)).toEqual(["a", "b", "c"]);
  });

  it("ND5: a direct block with no job -- the question, then a trim on No and a removal on Yes, never a job step", () => {
    const direct = blk("direct", "priya", w(0, 1320), w(1, 360));
    const ctx = ndCtx({ assignments: [direct] });
    expect(expandCommand(clear("2026-10-12"), ctx)).toMatchObject({
      ok: false,
      question: {
        kind: "other_day_part",
        direction: "previous",
        first: { kind: "person", name: "Priya Shah" },
      },
    });
    const no = expandCommand(clear("2026-10-12"), ctx, { previousDayPart: "keep" });
    if (!no.ok || no.command.intent !== "move") throw new Error("expected one trim");
    expect(no.runTrims).toBeUndefined();
    expect(no.runRemovals).toBeUndefined();
    const yes = expandCommand(clear("2026-10-12"), ctx, { previousDayPart: "clear" });
    if (!yes.ok || yes.command.intent !== "unassign") throw new Error("expected one removal");
    expect(yes.command.existing).toEqual({ kind: "remove", assignmentId: "direct" });
  });

  it("ND6: a job with no crew is named as the job -- No trims it, Yes removes it", () => {
    const ctx = ndCtx({ runs: [run1] });
    const asked = expandCommand(clear("2026-10-12"), ctx);
    if (asked.ok) throw new Error("expected the question");
    expect(asked.question).toMatchObject({
      first: { kind: "job", product: "Housing A", cell: "Cell 4" },
      others: 0,
    });
    expect(describeQuestion(asked.question)).toBe(
      "The Housing A job on Cell 4 started Sunday at 10 pm. Clear Sunday's part too?",
    );
    const no = expandCommand(clear("2026-10-12"), ctx, { previousDayPart: "keep" });
    if (!no.ok || no.command.intent !== "several") throw new Error("expected the job alone");
    expect(no.command.commands).toEqual([]);
    expect(no.runTrims?.map((t) => t.runId)).toEqual(["run1"]);
    expect(no.runRemovals).toBeUndefined();
    const yes = expandCommand(clear("2026-10-12"), ctx, { previousDayPart: "clear" });
    if (!yes.ok) throw new Error("expected the job alone");
    expect(yes.runRemovals?.map((r) => r.runId)).toEqual(["run1"]);
    expect(yes.runTrims).toBeUndefined();
    // The other direction, a crewless job running into Tuesday.
    const out = expandCommand(clear("2026-10-12"), ndCtx({ runs: [run2] }));
    if (out.ok) throw new Error("expected the question");
    expect(describeQuestion(out.question)).toBe(
      "The Housing A job on Cell 4 runs into Tuesday until 6 am. Clear Tuesday's part too?",
    );
  });

  it("ND7: a crew member whose block sits wholly on Sunday (the S70-d reviewer's case) is never touched and is said to stay -- on No the job keeps Sunday's part; on Yes too, because someone is still on it", () => {
    const run = job("runA", w(0, 1200), w(1, 360), "8 pm to 6 am", { headcount: 3 });
    const ahmedSunday = blk("ahmedSun", "ahmed", w(0, 1200), w(0, 1320), { runId: "runA" });
    const priyaCross = blk("priyaX", "priya", w(0, 1320), w(1, 360), { runId: "runA" });
    const linMonday = blk("linMon", "linc", w(1, 0), w(1, 360), { runId: "runA" });
    const ctx = ndCtx({ assignments: [ahmedSunday, priyaCross, linMonday], runs: [run] });
    const asked = expandCommand(clear("2026-10-12"), ctx);
    if (asked.ok) throw new Error("expected the question");
    // Only Priya's part goes on a Yes -- Ahmed is not named, and the job's
    // own 8 pm start does not muddle her hours.
    expect(describeQuestion(asked.question)).toBe(
      "Priya Shah's night shift started Sunday at 10 pm. Clear Sunday's part too, 10 pm to midnight?",
    );
    for (const answer of ["keep", "clear"] as const) {
      const res = expandCommand(clear("2026-10-12"), ctx, { previousDayPart: answer });
      holdsInvariant(res, ctx);
      if (!res.ok) throw new Error("expected a lot");
      expect([...removedIds(res), ...trimmedIds(res)]).not.toContain("ahmedSun");
      expect(removedIds(res)).toContain("linMon");
      expect(res.runRemovals).toBeUndefined();
      expect(res.runTrims?.map((t) => [t.runId, t.range])).toEqual([
        ["runA", { startMin: w(0, 1200), endMin: w(1, 0) }],
      ]);
      expect(res.runTrims?.[0].readout).toBe(
        answer === "keep"
          ? "The Housing A job on Cell 4 keeps its Sunday part, 8 pm to midnight, and Ahmed Ali is still on it; Monday's part, midnight to 6 am, is cleared."
          : "The Housing A job on Cell 4 keeps its Sunday part, 8 pm to midnight, because Ahmed Ali is still on it; Monday's part, midnight to 6 am, is cleared.",
      );
      expect(trimmedIds(res).includes("priyaX")).toBe(answer === "keep");
      expect(removedIds(res).includes("priyaX")).toBe(answer === "clear");
    }
  });

  it("ND8 (R-436 amended 28 Sept, CONTRACT CHANGED -- the job used to go whole and its crew with it): the invariant over a narrower window -- 'after 1 pm' keeps the job's morning, the crew block across the edge is trimmed with it, the block on no job keeps its part too", () => {
    const run = job("runN", w(1, 480), w(1, 960), "8 am to 4 pm");
    const crew = blk("crewN", "priya", w(1, 480), w(1, 960), { runId: "runN" });
    const direct = blk("directN", "maria", w(1, 480), w(1, 960));
    const ctx = ndCtx({ assignments: [crew, direct], runs: [run] });
    const res = expandCommand(afterOnePm(), ctx);
    holdsInvariant(res, ctx);
    if (!res.ok) throw new Error("expected a lot, never a question for a narrower window");
    expect(removedIds(res)).toEqual([]);
    expect(trimmedIds(res)).toEqual(["crewN", "directN"]);
    expect(res.runRemovals).toBeUndefined();
    expect(res.runTrims?.map((t) => [t.runId, t.range])).toEqual([
      ["runN", { startMin: w(1, 480), endMin: w(1, 780) }],
    ]);
  });

  // -------------------------------------------------------------------------
  // NW1-NW5 (S194-D second pass, R-436 as amended 28 Sept): a clear of PART
  // of a day clears only that part of a job -- R-461's rule at an edge the
  // sentence named, so no question is asked. Crew first, then the job.
  // -------------------------------------------------------------------------

  function spanOf(fromH: number, toH: number): UnassignCommand {
    return {
      ...clear("2026-10-12"),
      span: {
        start: { hour: fromH, minute: 0 },
        end: toH === 24 ? { hour: 23, minute: 59 } : { hour: toH, minute: 0 },
      },
    };
  }
  function afterOnePm(): UnassignCommand {
    return spanOf(13, 24);
  }
  const dayJob = job("dayJob", w(1, 600), w(1, 960), "10 am to 4 pm", { headcount: 2 });
  const crossCrew = blk("cross", "priya", w(1, 600), w(1, 960), { runId: "dayJob" });
  const morningCrew = blk("morning", "ahmed", w(1, 600), w(1, 720), { runId: "dayJob" });

  it("NW1: 'clear Cell 4 after 1 pm' over a 10 am to 4 pm job -- no question; the job keeps 10 am to 1 pm, the crew block across the edge is trimmed to match, the morning crew is untouched and said to stay", () => {
    const ctx = ndCtx({ assignments: [crossCrew, morningCrew], runs: [dayJob] });
    const res = expandCommand(afterOnePm(), ctx);
    holdsInvariant(res, ctx);
    if (!res.ok) throw new Error("expected a lot, no question");
    expect(trimmedIds(res)).toEqual(["cross"]);
    expect(removedIds(res)).toEqual([]);
    expect(res.runRemovals).toBeUndefined();
    expect(res.runTrims).toEqual([
      {
        intent: "trim_run",
        runId: "dayJob",
        nodeId: "cell4",
        range: { startMin: w(1, 600), endMin: w(1, 780) },
        readout:
          "The Housing A job on Cell 4 keeps 10 am to 1 pm, and Ahmed Ali is still on it; the part from 1 pm to 4 pm is cleared.",
        attempted: "The Housing A job on Cell 4",
        notTried: "The Housing A job on Cell 4 stays as it was, 10 am to 4 pm.",
      },
    ]);
    const moved = resolveCommand(flat(res)[0], ctx);
    expect(moved.ok && moved.resolved.intent === "move" && moved.resolved.range).toEqual({
      startMin: w(1, 600),
      endMin: w(1, 780),
    });
  });

  it("NW2: across the window's END ('clear Cell 4 before 1 pm', midnight to 1 pm) -- the job keeps 1 pm to 4 pm", () => {
    const ctx = ndCtx({ runs: [dayJob] });
    const res = expandCommand(spanOf(0, 13), ctx);
    holdsInvariant(res, ctx);
    if (!res.ok) throw new Error("expected a lot");
    expect(res.runTrims?.map((t) => [t.range, t.readout])).toEqual([
      [
        { startMin: w(1, 780), endMin: w(1, 960) },
        "The Housing A job on Cell 4 keeps 1 pm to 4 pm; the part from 10 am to 1 pm is cleared.",
      ],
    ]);
  });

  it("NW3 (S194-D third pass, CONTRACT CHANGED -- R-430: this was a plain refusal with nothing to choose): a window INSIDE a job would leave it in two pieces -- the two windows that WOULD work are offered, each reaching one end of the job", () => {
    const res = expandCommand(spanOf(13, 14), ndCtx({ runs: [dayJob] }));
    expect(res).toEqual({
      ok: false,
      question: {
        kind: "job_hole",
        text: "The Housing A job on Cell 4 runs from 10 am to 4 pm, so clearing 1 pm to 2 pm would leave a hole in it; one job cannot be in two pieces. Clear to one end of it instead?",
        spans: [
          {
            label: "Clear 1 pm to 4 pm",
            start: { hour: 13, minute: 0 },
            end: { hour: 16, minute: 0 },
          },
          {
            label: "Clear 10 am to 2 pm",
            start: { hour: 10, minute: 0 },
            end: { hour: 14, minute: 0 },
          },
        ],
      },
    });
    // Each offered window is a clear the job CAN take: no hole, one trim.
    for (const [from, to] of [
      [13, 16],
      [10, 14],
    ]) {
      const again = expandCommand(spanOf(from, to), ndCtx({ runs: [dayJob] }));
      expect(again.ok, `${from} to ${to}`).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // MIN1-MIN5 (S194-D third pass): a job kept to a remnant under the minimum
  // asks exactly as a block's does (`too_short`), the job named. The server
  // enforces no minimum on a run; the minimum is the client's own D31 value.
  // -------------------------------------------------------------------------

  it("MIN1: 'after 10:10 am' on a 10 am to 4 pm job would keep ten minutes -- too_short, the job named", () => {
    const res = expandCommand(
      {
        ...clear("2026-10-12"),
        span: { start: { hour: 10, minute: 10 }, end: { hour: 23, minute: 59 } },
      },
      ndCtx({ runs: [dayJob] }),
    );
    expect(res).toEqual({
      ok: false,
      question: {
        kind: "too_short",
        minutes: 10,
        min: 15,
        subject: "the Housing A job on Cell 4",
      },
    });
    if (!res.ok) {
      expect(describeQuestion(res.question)).toBe(
        "That would leave the Housing A job on Cell 4 10 minutes; a job is at least 15 minutes.",
      );
    }
  });

  it("MIN2: a job that ENDS exactly at the window's start is untouched -- no step at all", () => {
    const morning = job("am", w(1, 600), w(1, 780), "10 am to 1 pm");
    const res = expandCommand(afterOnePm(), ndCtx({ runs: [morning] }));
    expect(res).toMatchObject({ ok: false, question: { kind: "nothing_to_do" } });
  });

  it("MIN3: a job that STARTS exactly at the window's start goes whole", () => {
    const pm = job("pm", w(1, 780), w(1, 960), "1 pm to 4 pm");
    const res = expandCommand(afterOnePm(), ndCtx({ runs: [pm] }));
    if (!res.ok) throw new Error("expected a lot");
    expect(res.runRemovals?.map((r) => r.runId)).toEqual(["pm"]);
    expect(res.runTrims).toBeUndefined();
  });

  it("MIN4: crew 12:30 to 3 on a job 10 to 4, after 1 pm -- the crew keeps 12:30 to 1 (thirty minutes, fine) and the job 10 to 1; a crew remnant under the minimum asks as a block always has", () => {
    const crew = blk("c1230", "priya", w(1, 750), w(1, 900), { runId: "dayJob" });
    const ctx = ndCtx({ assignments: [crew], runs: [dayJob] });
    const res = expandCommand(afterOnePm(), ctx);
    holdsInvariant(res, ctx);
    if (!res.ok) throw new Error("expected a lot");
    const moved = resolveCommand(flat(res)[0], ctx);
    expect(moved.ok && moved.resolved.intent === "move" && moved.resolved.range).toEqual({
      startMin: w(1, 750),
      endMin: w(1, 780),
    });
    expect(res.runTrims?.[0].range).toEqual({ startMin: w(1, 600), endMin: w(1, 780) });

    const late = blk("c1250", "priya", w(1, 770), w(1, 900), { runId: "dayJob" });
    const ctx2 = ndCtx({ assignments: [late], runs: [dayJob] });
    const res2 = expandCommand(afterOnePm(), ctx2);
    if (!res2.ok) throw new Error("expected a lot");
    expect(resolveCommand(flat(res2)[0], ctx2)).toEqual({
      ok: false,
      question: { kind: "too_short", minutes: 10, min: 15 },
    });
  });

  it("MIN5: the night of a clock change (America/Chicago, 8 March 2026) -- a job from Saturday 11:50 pm kept to its Saturday part would be ten minutes: too_short at midnight too", () => {
    const march = realCtx(
      "America/Chicago",
      [2026, 3, 6],
      ["2026-03-06", "2026-03-07", "2026-03-08", "2026-03-09"],
      [5, 6, 0, 1],
    );
    const start = march.axis.wallToOffset(1, 23 * 60 + 50);
    const end = march.axis.wallToOffset(2, 360);
    const ctx = march.make({ runs: [job("late", start, end, "11:50 pm to 6 am")] });
    const res = expandCommand(clear("2026-03-08"), ctx, { previousDayPart: "keep" });
    expect(res).toMatchObject({
      ok: false,
      question: { kind: "too_short", minutes: 10, subject: "the Housing A job on Cell 4" },
    });
  });

  it("NW4: a job wholly inside the window goes whole as before, its crew listed", () => {
    const inner = job("inner1", w(1, 840), w(1, 900), "2 pm to 3 pm");
    const crew = blk("innerCrew", "linc", w(1, 840), w(1, 900), { runId: "inner1" });
    const ctx = ndCtx({ assignments: [crew], runs: [inner] });
    const res = expandCommand(afterOnePm(), ctx);
    holdsInvariant(res, ctx);
    if (!res.ok) throw new Error("expected a lot");
    expect(removedIds(res)).toEqual(["innerCrew"]);
    expect(res.runRemovals?.map((r) => r.runId)).toEqual(["inner1"]);
    expect(res.runTrims).toBeUndefined();
  });

  it("NW5: the invariant, as a property over every narrow-window fixture", () => {
    const fixtures: ResolveContext[] = [
      ndCtx({ assignments: [crossCrew, morningCrew], runs: [dayJob] }),
      ndCtx({ runs: [dayJob] }),
      ndCtx({
        assignments: [blk("i1", "linc", w(1, 840), w(1, 900), { runId: "inner1" }), crossCrew],
        runs: [job("inner1", w(1, 840), w(1, 900), "2 pm to 3 pm"), dayJob],
      }),
    ];
    let lots = 0;
    for (const ctx of fixtures) {
      for (const c of [afterOnePm(), spanOf(0, 13), spanOf(15, 24)]) {
        const res = expandCommand(c, ctx);
        holdsInvariant(res, ctx);
        if (res.ok) lots++;
      }
    }
    expect(lots).toBeGreaterThan(5);
  });

  // -------------------------------------------------------------------------
  // AW1-AW5 (S194-D second pass, R-409 as amended again 28 Sept): "Sam is off
  // this week" records ONE absence over the span the sentence covers.
  // -------------------------------------------------------------------------

  const twoWeeks: BoardDay[] = Array.from({ length: 15 }, (_, i) => ({
    index: i,
    iso: `2026-10-${String(11 + i).padStart(2, "0")}`,
    weekday: (i % 7) as BoardDay["weekday"],
  }));
  function weekCtx(over: Partial<ResolveContext> = {}): ResolveContext {
    return ndCtx({ days: twoWeeks, wallOf: clampedWallOf(twoWeeks), ...over });
  }
  const tue = blk("tue", "priya", w(2, 480), w(2, 720));
  const thu = blk("thu", "priya", w(4, 480), w(4, 720));

  it("AW1: 'Priya Shah is off this week' (today Monday) -- the week's blocks go with one yes and ONE absence is recorded from today to Sunday, written last", () => {
    const ctx = weekCtx({ assignments: [tue, thu], absenceRecordable: new Set(["priya"]) });
    const res = expandCommand(absence("Priya Shah is off this week"), ctx);
    holdsInvariant(res, ctx);
    if (!res.ok || res.command.intent !== "several") throw new Error("expected a several");
    expect(removedIds(res)).toEqual(["tue", "thu"]);
    expect(res.absenceRecord).toMatchObject({
      intent: "record_absence",
      operatorId: "priya",
      from: "2026-10-12",
      to: "2026-10-18",
      reason: "Off",
      readout: "Priya Shah is recorded as off from 2026-10-12 to 2026-10-18.",
      attempted: "An absence for Priya Shah from 2026-10-12 to 2026-10-18",
    });
    expect(res.summary).toBe(
      "Priya Shah is off from 2026-10-12 to 2026-10-18. Their 2 blocks on Cell 4 are cleared and the absence is recorded.",
    );
  });

  it("AW2: 'Priya Shah is on leave next week' -- the whole of next week, one record", () => {
    const ctx = weekCtx({ absenceRecordable: new Set(["priya"]) });
    const res = expandCommand(absence("Priya Shah is on leave next week"), ctx);
    if (!res.ok) throw new Error("expected the record alone");
    expect(res.absenceRecord).toMatchObject({
      from: "2026-10-19",
      to: "2026-10-25",
      reason: "On leave",
    });
    expect(res.summary).toBe(
      "Priya Shah has nothing on the board from 2026-10-19 to 2026-10-25; the absence is recorded.",
    );
  });

  it("AW3: a whole-day absence already on ONE day of the span -- the server refuses any overlap, so nothing is offered to record, and the answer says some of the days", () => {
    // The server's rule, transcribed (`absences_whole_day_excl`, 0069): any
    // whole-day row whose days overlap the span at all.
    const existing = { from: "2026-10-14", to: "2026-10-14" };
    const ctx = weekCtx({
      assignments: [tue, thu],
      absenceRecordable: new Set(["priya"]),
      hasWholeDayAbsence: (id, from, to) =>
        id === "priya" && existing.from <= to && existing.to >= from,
    });
    const res = expandCommand(absence("Priya Shah is off this week"), ctx);
    if (!res.ok) throw new Error("expected the blocks");
    expect(res.absenceRecord).toBeUndefined();
    expect(res.summary).toBe(
      "Priya Shah already has an absence recorded on some of the days from 2026-10-12 to 2026-10-18; their 2 blocks on Cell 4 are cleared.",
    );
  });

  it("AW4: not recordable for this caller -- the week's blocks go, nothing is recorded, said plainly", () => {
    const ctx = weekCtx({ assignments: [tue], absenceRecordable: new Set() });
    const res = expandCommand(absence("Priya Shah is off this week"), ctx);
    if (!res.ok) throw new Error("expected the block");
    expect(res.absenceRecord).toBeUndefined();
    expect(res.summary).toBe(
      "I cannot record an absence for Priya Shah from here; their block on Cell 4 is cleared.",
    );
  });

  it("AW5: a night shift at the span's outer edge asks as the week clear asks -- into today from Sunday, out of the last Sunday into Monday", () => {
    const into = blk("into", "priya", w(0, 1320), w(1, 360));
    const out = blk("out", "priya", w(7, 1320), w(8, 360));
    const ctx = weekCtx({ assignments: [into, out], absenceRecordable: new Set(["priya"]) });
    expect(expandCommand(absence("Priya Shah is off this week"), ctx)).toMatchObject({
      ok: false,
      question: { kind: "other_day_part", direction: "previous", day: "Sunday" },
    });
    expect(
      expandCommand(absence("Priya Shah is off this week"), ctx, { previousDayPart: "keep" }),
    ).toMatchObject({
      ok: false,
      question: { kind: "other_day_part", direction: "next", day: "Monday" },
    });
    const res = expandCommand(absence("Priya Shah is off this week"), ctx, {
      previousDayPart: "keep",
      nextDayPart: "clear",
    });
    holdsInvariant(res, ctx);
    if (!res.ok) throw new Error("expected a lot");
    expect(trimmedIds(res)).toEqual(["into"]);
    expect(removedIds(res)).toEqual(["out"]);
    expect(res.absenceRecord).toMatchObject({ from: "2026-10-12", to: "2026-10-18" });
  });

  it("ND9: the invariant, as a property over every fixture above and every answer", () => {
    const fixtures: ResolveContext[] = [
      ndCtx({ assignments: [priyaNight], runs: [run1] }),
      ndCtx({ assignments: [mariaNight], runs: [run2] }),
      ndCtx({ assignments: [priyaNight, mariaNight], runs: [run1, run2] }),
      ndCtx({ runs: [run1, run2] }),
      ndCtx({
        assignments: [
          blk("s1", "ahmed", w(0, 1200), w(0, 1320), { runId: "runA" }),
          blk("s2", "priya", w(0, 1320), w(1, 360), { runId: "runA" }),
          blk("s3", "linc", w(1, 0), w(1, 360), { runId: "runA" }),
          blk("s4", "maria", w(1, 1320), w(2, 360)),
        ],
        runs: [job("runA", w(0, 1200), w(1, 360), "8 pm to 6 am")],
      }),
    ];
    const answers: ResolveOptions[] = [];
    for (const p of [undefined, "keep", "clear"] as const) {
      for (const n of [undefined, "keep", "clear"] as const) {
        answers.push({
          ...(p ? { previousDayPart: p } : {}),
          ...(n ? { nextDayPart: n } : {}),
        });
      }
    }
    let lots = 0;
    for (const ctx of fixtures) {
      for (const a of answers) {
        const res = expandCommand(clear("2026-10-12"), ctx, a);
        holdsInvariant(res, ctx);
        if (res.ok) lots++;
      }
    }
    expect(lots).toBeGreaterThan(10); // the property actually ran over real lots
  });

  it("ND10: a week clear's inside midnights ask nothing -- only the span's outer edges ask (a named person's week follows the same rule)", () => {
    const weekDays: BoardDay[] = [
      { index: 0, iso: "2026-10-11", weekday: 0 }, // Sun (before the week)
      { index: 1, iso: "2026-10-12", weekday: 1 }, // Mon (today)
      { index: 2, iso: "2026-10-13", weekday: 2 },
      { index: 3, iso: "2026-10-14", weekday: 3 },
      { index: 4, iso: "2026-10-15", weekday: 4 },
      { index: 5, iso: "2026-10-16", weekday: 5 },
      { index: 6, iso: "2026-10-17", weekday: 6 },
      { index: 7, iso: "2026-10-18", weekday: 0 }, // Sun (last day of the week)
      { index: 8, iso: "2026-10-19", weekday: 1 }, // Mon (after the week)
    ];
    const inside = blk("in", "maria", w(3, 1320), w(4, 360));
    const into = blk("into", "priya", w(0, 1320), w(1, 360));
    const out = blk("out", "ahmed", w(7, 1320), w(8, 360));
    const ctx = ndCtx({
      days: weekDays,
      wallOf: clampedWallOf(weekDays),
      assignments: [inside, into, out],
    });
    const week: UnassignCommand = {
      ...clear("", ["Cell 4"]),
      day: { kind: "every_day", week: "this_week" },
    };
    const first = expandCommand(week, ctx);
    if (first.ok) throw new Error("expected the previous question");
    expect(first.question).toMatchObject({
      direction: "previous",
      day: "Sunday",
      first: { name: "Priya Shah" },
    });
    const second = expandCommand(week, ctx, { previousDayPart: "keep" });
    if (second.ok) throw new Error("expected the next question");
    expect(second.question).toMatchObject({
      direction: "next",
      day: "Monday",
      first: { name: "Ahmed Ali" },
    });
    const res = expandCommand(week, ctx, { previousDayPart: "keep", nextDayPart: "keep" });
    holdsInvariant(res, ctx);
    expect(removedIds(res)).toEqual(["in"]);
    expect(trimmedIds(res)).toEqual(["into", "out"]);

    // A named person's week: Ahmed's block out of the last day asks too.
    const named: UnassignCommand = { ...week, operator: "Ahmed Ali", place: [] };
    expect(expandCommand(named, ctx)).toMatchObject({
      ok: false,
      question: { kind: "other_day_part", direction: "next", first: { name: "Ahmed Ali" } },
    });
    const namedYes = expandCommand(named, ctx, { nextDayPart: "clear" });
    if (!namedYes.ok || namedYes.command.intent !== "unassign")
      throw new Error("expected one removal");
    expect(namedYes.command.span).toBeNull();
    expect(resolveCommand(namedYes.command, ctx).ok).toBe(true);
  });

  it("ND13: a job removed whole by a Yes whose crew block runs out the OTHER midnight (kept by a No) -- that block becomes a listed removal, never a trim the cascade would delete", () => {
    // Not contained in its job (the server allows it): the job crosses
    // Sunday's midnight, this crew block Monday's.
    const odd = blk("odd", "maria", w(1, 1320), w(2, 120), { runId: "run1" });
    const ctx = ndCtx({ assignments: [priyaNight, odd], runs: [run1] });
    const res = expandCommand(clear("2026-10-12"), ctx, {
      previousDayPart: "clear",
      nextDayPart: "keep",
    });
    holdsInvariant(res, ctx);
    if (!res.ok) throw new Error("expected a lot");
    expect(res.runRemovals?.map((r) => r.runId)).toEqual(["run1"]);
    expect(removedIds(res)).toEqual(["priyaBlk", "odd"]);
    expect(trimmedIds(res)).toEqual([]);
  });

  it("ND14: a crew block across midnight on a job wholly inside the cleared day asks nothing -- the job goes whole and takes it, so it is a listed removal", () => {
    const inner = job("inner", w(1, 0), w(1, 360), "midnight to 6 am");
    const crossing = blk("cross", "priya", w(0, 1320), w(1, 360), { runId: "inner" });
    const ctx = ndCtx({ assignments: [crossing], runs: [inner] });
    const res = expandCommand(clear("2026-10-12"), ctx);
    holdsInvariant(res, ctx);
    if (!res.ok) throw new Error("expected a lot, no question");
    expect(removedIds(res)).toEqual(["cross"]);
    expect(res.runRemovals?.map((r) => r.runId)).toEqual(["inner"]);
  });

  // ---- ND11-ND12: the plant's midnight on the REAL axis, across a clock
  // change (R-426), west and east of UTC -- `buildDayAxis`/`wallOf`, never
  // d*1440.
  function realCtx(
    zone: string,
    start: [number, number, number],
    isos: string[],
    weekdays: number[],
  ): {
    axis: ReturnType<typeof buildDayAxis>;
    make: (o: Partial<ResolveContext>) => ResolveContext;
  } {
    const axis = buildDayAxis(
      zonedTimeToInstant(zone, start[0], start[1], start[2], 0, 0),
      isos.length,
      zone,
    );
    const rdays: BoardDay[] = isos.map((iso, i) => ({
      index: i,
      iso,
      weekday: weekdays[i] as BoardDay["weekday"],
    }));
    return {
      axis,
      make: (over) =>
        ndCtx({
          days: rdays,
          todayIndex: 0,
          todayIso: isos[0],
          wallToOffset: axis.wallToOffset,
          wallOf: (m: number) => wallOfAxis(axis, m),
          ...over,
        }),
    };
  }

  it("ND11: America/Chicago, 8 March 2026 (spring forward) and 1 November 2026 (fall back) -- the split is the plant's own midnight, the hours its wall clock", () => {
    // Fri 6 .. Mon 9 March; Saturday 22:00 to Sunday 06:00 is 7 real hours.
    const march = realCtx(
      "America/Chicago",
      [2026, 3, 6],
      ["2026-03-06", "2026-03-07", "2026-03-08", "2026-03-09"],
      [5, 6, 0, 1],
    );
    const mStart = march.axis.wallToOffset(1, 1320);
    const mEnd = march.axis.wallToOffset(2, 360);
    expect(mEnd - mStart).toBe(7 * 60);
    const mCtx = march.make({
      assignments: [blk("dst", "priya", mStart, mEnd, { runId: "runD" })],
      runs: [job("runD", mStart, mEnd, "10 pm to 6 am")],
    });
    // Clear Sunday: Saturday's part is asked about.
    const sun = expandCommand(clear("2026-03-08"), mCtx);
    if (sun.ok) throw new Error("expected the question");
    expect(describeQuestion(sun.question)).toBe(
      "Priya Shah's night shift started Saturday at 10 pm. Clear Saturday's part too, 10 pm to midnight?",
    );
    const sunNo = expandCommand(clear("2026-03-08"), mCtx, { previousDayPart: "keep" });
    holdsInvariant(sunNo, mCtx);
    if (!sunNo.ok) throw new Error("expected a lot");
    const sunMidnight = march.axis.wallToOffset(2, 0);
    expect(sunNo.runTrims?.[0].range).toEqual({ startMin: mStart, endMin: sunMidnight });
    const trimmed = resolveCommand(flat(sunNo)[0], mCtx);
    expect(trimmed.ok && trimmed.resolved.intent === "move" && trimmed.resolved.range).toEqual({
      startMin: mStart,
      endMin: sunMidnight,
    });
    expect(trimmed.ok && trimmed.resolved.readout).toBe(
      "Priya Shah's night shift on Cell 4 keeps its Saturday part, 10 pm to midnight; Sunday's part, midnight to 6 am, is cleared.",
    );
    // Clear Saturday: Sunday's part is asked about, and kept from Sunday's own midnight.
    const sat = expandCommand(clear("2026-03-07"), mCtx);
    if (sat.ok) throw new Error("expected the question");
    expect(describeQuestion(sat.question)).toBe(
      "Priya Shah's night shift runs into Sunday. Clear Sunday's part too, midnight to 6 am?",
    );
    const satNo = expandCommand(clear("2026-03-07"), mCtx, { nextDayPart: "keep" });
    if (!satNo.ok) throw new Error("expected a lot");
    expect(satNo.runTrims?.[0].range).toEqual({ startMin: sunMidnight, endMin: mEnd });
    const satMoved = resolveCommand(flat(satNo)[0], mCtx);
    expect(satMoved.ok && satMoved.resolved.intent === "move" && satMoved.resolved.range).toEqual({
      startMin: sunMidnight,
      endMin: mEnd,
    });

    // Fri 30 Oct .. Mon 2 Nov; Saturday 22:00 to Sunday 06:00 is 9 real hours.
    const nov = realCtx(
      "America/Chicago",
      [2026, 10, 30],
      ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"],
      [5, 6, 0, 1],
    );
    const nStart = nov.axis.wallToOffset(1, 1320);
    const nEnd = nov.axis.wallToOffset(2, 360);
    expect(nEnd - nStart).toBe(9 * 60);
    const nCtx = nov.make({ assignments: [blk("dstN", "priya", nStart, nEnd)] });
    const nNo = expandCommand(clear("2026-11-01"), nCtx, { previousDayPart: "keep" });
    if (!nNo.ok) throw new Error("expected a lot");
    const nMoved = resolveCommand(flat(nNo)[0], nCtx);
    expect(nMoved.ok && nMoved.resolved.intent === "move" && nMoved.resolved.range).toEqual({
      startMin: nStart,
      endMin: nov.axis.wallToOffset(2, 0),
    });
    // The kept Saturday part is the plain two wall-clock hours, 10 pm to midnight.
    expect(nov.axis.wallToOffset(2, 0) - nStart).toBe(120);
    expect(nMoved.ok && nMoved.resolved.readout).toBe(
      "Priya Shah's night shift on Cell 4 keeps its Saturday part, 10 pm to midnight; Sunday's part, midnight to 6 am, is cleared.",
    );
  });

  it("ND12: Europe/Berlin, 29 March 2026 (spring forward, east of UTC) -- clear Saturday, Sunday's part asked about and kept from the plant's own midnight", () => {
    const berlin = realCtx(
      "Europe/Berlin",
      [2026, 3, 27],
      ["2026-03-27", "2026-03-28", "2026-03-29", "2026-03-30"],
      [5, 6, 0, 1],
    );
    const bStart = berlin.axis.wallToOffset(1, 1320);
    const bEnd = berlin.axis.wallToOffset(2, 360);
    expect(bEnd - bStart).toBe(7 * 60);
    const bCtx = berlin.make({
      assignments: [blk("dstB", "maria", bStart, bEnd, { runId: "runB" })],
      runs: [job("runB", bStart, bEnd, "10 pm to 6 am")],
    });
    const asked = expandCommand(clear("2026-03-28"), bCtx);
    if (asked.ok) throw new Error("expected the question");
    expect(describeQuestion(asked.question)).toBe(
      "Maria Lopez's night shift runs into Sunday. Clear Sunday's part too, midnight to 6 am?",
    );
    const no = expandCommand(clear("2026-03-28"), bCtx, { nextDayPart: "keep" });
    holdsInvariant(no, bCtx);
    if (!no.ok) throw new Error("expected a lot");
    const sunMidnight = berlin.axis.wallToOffset(2, 0);
    expect(no.runTrims?.[0]).toMatchObject({
      range: { startMin: sunMidnight, endMin: bEnd },
      readout:
        "The Housing A job on Cell 4 keeps its Sunday part, midnight to 6 am; Saturday's part, 10 pm to midnight, is cleared.",
    });
    const yes = expandCommand(clear("2026-03-28"), bCtx, { nextDayPart: "clear" });
    holdsInvariant(yes, bCtx);
    if (!yes.ok) throw new Error("expected a lot");
    expect(removedIds(yes)).toEqual(["dstB"]);
    expect(yes.runRemovals?.map((r) => r.runId)).toEqual(["runB"]);
  });

  // -------------------------------------------------------------------------
  // AD1-AD11 (S194-D, DEF-0048, R-409 amended 28 Sept): the one-day absence
  // takes every block that day with one yes and records the absence.
  // -------------------------------------------------------------------------

  const early = blk("early", "priya", w(1, 480), w(1, 720), { label: "8 am to noon" });
  const late = blk("late", "priya", w(1, 780), w(1, 1020), {
    nodeId: "cell2",
    label: "1 pm to 5 pm",
  });
  function absence(sentence: string): UnassignCommand {
    const parsed = parseCommand(sentence);
    if (!parsed.ok || parsed.command.intent !== "unassign")
      throw new Error(`${sentence} must parse`);
    return markAbsence(parsed.command, sentence);
  }

  it("AD1: 'Priya Shah is off today', two blocks, the recordable set unknown -- two removals with one yes, no which-block question, no record claimed", () => {
    const ctx = ndCtx({ assignments: [early, late] });
    const res = expandCommand(absence("Priya Shah is off today"), ctx);
    if (!res.ok || res.command.intent !== "several") throw new Error("expected a several");
    expect(removedIds(res)).toEqual(["early", "late"]);
    expect(res.absenceRecord).toBeUndefined();
    expect(res.summary).toBe(
      "Priya Shah is off 2026-10-12. Their 2 blocks on Cell 4 and Cell 2 are cleared; the absence is not recorded, because I could not check whether you may record it.",
    );
    for (const c of res.command.commands) expect(resolveCommand(c, ctx).ok).toBe(true);
  });

  it("AD2: the same, recordable -- the absence is recorded LAST, whole-day, with the sentence's own word as the reason", () => {
    const ctx = ndCtx({ assignments: [early, late], absenceRecordable: new Set(["priya"]) });
    const res = expandCommand(absence("Priya Shah is off today"), ctx);
    if (!res.ok || res.command.intent !== "several") throw new Error("expected a several");
    expect(removedIds(res)).toEqual(["early", "late"]);
    expect(res.absenceRecord).toEqual({
      intent: "record_absence",
      operatorId: "priya",
      person: "Priya Shah",
      from: "2026-10-12",
      to: "2026-10-12",
      reason: "Off",
      readout: "Priya Shah is recorded as off 2026-10-12.",
      attempted: "An absence for Priya Shah 2026-10-12",
      notTried: "No absence is recorded for Priya Shah.",
    });
    expect(res.summary).toBe(
      "Priya Shah is off 2026-10-12. Their 2 blocks on Cell 4 and Cell 2 are cleared and the absence is recorded.",
    );
  });

  it("AD3: one block -- one removal plus the record", () => {
    const ctx = ndCtx({ assignments: [early], absenceRecordable: new Set(["priya"]) });
    const res = expandCommand(absence("Priya Shah is sick today"), ctx);
    if (!res.ok || res.command.intent !== "several") throw new Error("expected a several");
    expect(removedIds(res)).toEqual(["early"]);
    expect(res.absenceRecord?.reason).toBe("Sick");
    expect(res.summary).toBe(
      "Priya Shah is off 2026-10-12. Their block on Cell 4 is cleared and the absence is recorded.",
    );
  });

  it("AD4: nothing on the board that day -- the absence is still recorded, and the answer says so; unknown recordable is the plain answer", () => {
    const res = expandCommand(
      absence("Priya Shah is off today"),
      ndCtx({ absenceRecordable: new Set(["priya"]) }),
    );
    if (!res.ok || res.command.intent !== "several") throw new Error("expected a several of none");
    expect(res.command.commands).toEqual([]);
    expect(res.absenceRecord?.from).toBe("2026-10-12");
    expect(res.summary).toBe(
      "Priya Shah has nothing on the board 2026-10-12; the absence is recorded.",
    );
    expect(expandCommand(absence("Priya Shah is off today"), ndCtx())).toEqual({
      ok: false,
      question: {
        kind: "nothing_to_do",
        text: "Priya Shah has no block 2026-10-12; the absence is not recorded, because I could not check whether you may record it.",
      },
    });
  });

  it("AD5: not recordable for this caller (R-431) -- the blocks go, nothing is recorded, and the answer says so plainly", () => {
    const ctx = ndCtx({ assignments: [early, late], absenceRecordable: new Set(["maria"]) });
    const res = expandCommand(absence("Priya Shah is off today"), ctx);
    if (!res.ok) throw new Error("expected the blocks");
    expect(removedIds(res)).toEqual(["early", "late"]);
    expect(res.absenceRecord).toBeUndefined();
    expect(res.summary).toBe(
      "I cannot record an absence for Priya Shah from here; their 2 blocks on Cell 4 and Cell 2 are cleared.",
    );
    expect(
      expandCommand(absence("Priya Shah is off today"), ndCtx({ absenceRecordable: new Set() })),
    ).toEqual({
      ok: false,
      question: {
        kind: "nothing_to_do",
        text: "Priya Shah has no block 2026-10-12, and I cannot record an absence for them from here.",
      },
    });
  });

  it("AD6: already absent (set_absence's whole-day overlap refusal) -- known before the yes, never offered", () => {
    const ctx = ndCtx({
      assignments: [early],
      absenceRecordable: new Set(["priya"]),
      hasWholeDayAbsence: (id, from, to) =>
        id === "priya" && from <= "2026-10-12" && to >= "2026-10-12",
    });
    const res = expandCommand(absence("Priya Shah is off today"), ctx);
    if (!res.ok) throw new Error("expected the block");
    expect(res.absenceRecord).toBeUndefined();
    expect(res.summary).toBe(
      "Priya Shah already has an absence recorded 2026-10-12; their block on Cell 4 is cleared.",
    );
  });

  it("AD7: 'remove Priya Shah today' (no absence in the words) still asks which of the two", () => {
    const parsed = parseCommand("remove Priya Shah today");
    if (!parsed.ok) throw new Error("must parse");
    const marked = markAbsence(parsed.command, "remove Priya Shah today");
    expect(marked).toBe(parsed.command); // untouched, the same object
    const ctx = ndCtx({ assignments: [early, late], absenceRecordable: new Set(["priya"]) });
    const expanded = expandCommand(marked, ctx);
    expect(expanded).toEqual({ ok: true, command: parsed.command });
    const asked = resolveCommand(parsed.command as UnassignCommand, ctx);
    expect(asked.ok === false && asked.question.kind).toBe("remove_which");
  });

  it("AD8: an absence of one day against a night shift follows R-461 -- the same question, then Yes removes it whole and No keeps Sunday's part", () => {
    const ctx = ndCtx({ assignments: [priyaNight], absenceRecordable: new Set(["priya"]) });
    const asked = expandCommand(absence("Priya Shah is off today"), ctx);
    if (asked.ok) throw new Error("expected the question");
    expect(describeQuestion(asked.question)).toBe(
      "Priya Shah's night shift started Sunday at 10 pm. Clear Sunday's part too, 10 pm to midnight?",
    );
    const yes = expandCommand(absence("Priya Shah is off today"), ctx, {
      previousDayPart: "clear",
    });
    if (!yes.ok) throw new Error("expected a lot");
    expect(removedIds(yes)).toEqual(["priyaBlk"]);
    expect(yes.absenceRecord?.from).toBe("2026-10-12");
    const no = expandCommand(absence("Priya Shah is off today"), ctx, { previousDayPart: "keep" });
    if (!no.ok) throw new Error("expected a lot");
    expect(trimmedIds(no)).toEqual(["priyaBlk"]);
    expect(no.absenceRecord?.to).toBe("2026-10-12");
  });

  it("AD9: the until form with the recordable set -- one record over every day, the word as the reason", () => {
    const ctx = ndCtx({ assignments: [early, late], absenceRecordable: new Set(["priya"]) });
    const res = expandCommand(absence("Priya Shah is on leave until Wednesday"), ctx);
    if (!res.ok) throw new Error("expected a lot");
    expect(res.absenceRecord).toMatchObject({
      from: "2026-10-12",
      to: "2026-10-14",
      reason: "On leave",
    });
    expect(res.summary).toBe(
      "Priya Shah is off from 2026-10-12 to 2026-10-14. Their 2 blocks on Cell 4 and Cell 2 are cleared and the absence is recorded.",
    );
  });

  it("AD10: markAbsence reads the words the model heard -- the decoded removal gets the same mark the rules sentence gets", () => {
    const decoded: UnassignCommand = {
      intent: "unassign",
      operator: "Priya Shah",
      place: [],
      day: { kind: "today" },
      span: null,
      existing: null,
      shift: null,
      until: null,
    };
    expect(markAbsence(decoded, "priya shah is out today")).toEqual({ ...decoded, absence: "out" });
    expect(markAbsence(decoded, "Priya Shah is on  Leave")).toEqual({
      ...decoded,
      absence: "on leave",
    });
    expect(markAbsence(decoded, "take priya shah off cell 4 today")).toBe(decoded);
  });

  it("AD11: every sentence an absence adds is R-459's -- no 24-hour clock, no dash chain, no arrow", () => {
    const ctx = ndCtx({ assignments: [early, late], absenceRecordable: new Set(["priya"]) });
    const res = expandCommand(absence("Priya Shah is off today"), ctx);
    if (!res.ok) throw new Error("expected a lot");
    for (const s of [
      res.summary ?? "",
      res.absenceRecord?.readout ?? "",
      res.absenceRecord?.notTried ?? "",
    ]) {
      expect(s).not.toMatch(/\d{1,2}:\d{2}/);
      expect(s).not.toMatch(/ -- | – |->|→/);
    }
  });
});
