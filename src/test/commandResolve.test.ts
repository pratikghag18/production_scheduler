/**
 * P1-7a — `src/lib/command/resolve.ts`, brief §5's fixture and worked examples
 * (R1–R33), run verbatim. The fixture below is copied from the brief exactly
 * so a reviewer can diff this file against §5 rather than re-derive it.
 *
 * `runs` defaults to `[]`; `withRuns` builds the fixture WITH `run1` (and,
 * for R32, `run2`) added, per row.
 */
import { describe, it, expect } from "vitest";
import { resolveCommand, describeQuestion } from "@/lib/command/resolve";
import type {
  ResolveContext,
  ContextRun,
  ContextAssignment,
  BoardDay,
  Candidate,
} from "@/lib/command/resolve";
import type {
  AssignCommand,
  BookCommand,
  UnassignCommand,
  MoveCommand,
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
  label: "Housing A 08:00–16:00",
  span: "08:00–16:00",
};

const run2: ContextRun = {
  id: "run2",
  nodeId: "c1a",
  productId: "ha",
  startMin: 3 * 1440 + 540,
  endMin: 3 * 1440 + 900,
  label: "Housing A 09:00–15:00",
  span: "09:00–15:00",
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
  label: "Cover 08:00–16:00",
  span: "08:00–16:00",
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

function baseCtx(overrides: Partial<ResolveContext> = {}): ResolveContext {
  return {
    cells,
    nodeById,
    operators,
    products,
    offeredAt,
    days,
    todayIndex: 3,
    wallToOffset,
    runs: [],
    fitsRun,
    minDurationMinutes: 15,
    assignments: [],
    overlaps,
    findRunOverlap,
    ...overrides,
  };
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
    existing: null,
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
    existing: null,
    ...overrides,
  };
}

const R1_READOUT =
  "Operator 1 → Housing A · Plant 1 › Assembly › Line 1 › Cell 1 · 2026-09-03 · 10:00–14:00";

const RB1_READOUT = "Housing A · Plant 1 › Assembly › Line 1 › Cell 1 · 2026-09-03 · 06:00–14:00";

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
  label: "10:00–14:00",
}; // the maintainer's first sentence
const blk2: ContextAssignment = {
  ...blk1,
  id: "blk2",
  startMin: 3 * 1440 + 840,
  endMin: 3 * 1440 + 960,
  label: "14:00–16:00",
};
const blkHb: ContextAssignment = {
  ...blk1,
  id: "blkHb",
  productId: "hb",
  productName: "Housing B",
  label: "10:00–14:00",
};
const blkSp: ContextAssignment = { ...blk1, id: "blkSp", operatorId: "sp" };
const blkGone: ContextAssignment = { ...blk1, id: "blkGone", operatorId: null };
const blkC2: ContextAssignment = { ...blk1, id: "blkC2", nodeId: "c2" };

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

  it("R5: 'Cell 1 in Line 2' -- place_mismatch, both cells listed elsewhere", () => {
    const res = resolveCommand(cmd({ place: ["Cell 1", "Line 2"] }), baseCtx());
    expect(res).toEqual({
      ok: false,
      question: {
        kind: "place_mismatch",
        cell: "Cell 1",
        qualifier: "Line 2",
        elsewhere: [
          { id: "c1a", label: "Cell 1 — Plant 1 › Assembly › Line 1", word: "Cell 1" },
          { id: "c1b", label: "Cell 1 — Plant 1 › Assembly › Line 3", word: "Cell 1" },
        ],
      },
    });
    if (!res.ok) {
      expect(describeQuestion(res.question)).toBe(
        "There is no Cell 1 in Line 2. Cell 1 is in Cell 1 — Plant 1 › Assembly › Line 1 / Cell 1 — Plant 1 › Assembly › Line 3.",
      );
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

  it("R16: 'Gasket' -- unknown product", () => {
    const res = resolveCommand(cmd({ product: "Gasket" }), baseCtx());
    expect(res).toEqual({
      ok: false,
      question: { kind: "unknown", field: "product", text: "Gasket" },
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

  it("R21: day null with todayIndex null -- the window's first day", () => {
    const res = resolveCommand(cmd({ day: null }), baseCtx({ todayIndex: null }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.resolved.range.startMin).toBe(0 * 1440 + 600);
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
        runs: [{ id: "run1", label: "Housing A 08:00–16:00", word: "" }],
      },
    });
    if (!res.ok) {
      expect(describeQuestion(res.question)).toBe(
        "A Housing A job is already booked on Cell 1, Housing A 08:00–16:00. Join it, or make a separate block?",
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
        readout: `${R1_READOUT} · joining Housing A 08:00–16:00`,
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
          { id: "run1", label: "Housing A 08:00–16:00", word: "" },
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
        runs: [{ id: "run1", label: "Housing A 08:00–16:00", word: "" }],
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
        span: "10:00–15:00",
        blocks: [{ id: "blk1", label: "10:00–14:00", word: "" }],
        same: false,
      },
    });
    if (!res.ok) {
      expect(describeQuestion(res.question)).toBe(
        "Operator 1 is already on Housing A at Cell 1 10:00–14:00. Change it to 10:00–15:00, or add a separate block?",
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
        span: "10:00–14:00",
        blocks: [{ id: "blk1", label: "10:00–14:00", word: "" }],
        same: true,
      },
    });
    if (!res.ok) {
      expect(describeQuestion(res.question)).toBe(
        "Operator 1 is already on Housing A at Cell 1 10:00–14:00 — nothing to change. Add a separate block?",
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
        readout: `${R1_READOUT.replace("10:00–14:00", "10:00–15:00")} · changing 10:00–14:00`,
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
        runs: [{ id: "run1", label: "Housing A 08:00–16:00", word: "" }],
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
        span: "10:00–16:00",
        blocks: [
          { id: "blk1", label: "10:00–14:00", word: "" },
          { id: "blk2", label: "14:00–16:00", word: "" },
        ],
        same: false,
      },
    });
    if (!res.ok) {
      expect(describeQuestion(res.question)).toBe(
        "Operator 1 already has 2 Housing A blocks at Cell 1 (10:00–14:00, 14:00–16:00). Change one to 10:00–16:00, or add a separate block?",
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
      },
    });
  });

  it("RB2: with for 3 -- headcount 3, readout ends ' · 3 people'", () => {
    const res = resolveCommand(bookCmd({ headcount: 3 }), baseCtx());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.resolved.target).toEqual({ kind: "run_create", productId: "ha", headcount: 3 });
      expect(res.resolved.readout).toBe(`${RB1_READOUT} · 3 people`);
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
        span: "06:00–14:00",
        run: { id: "run1", label: "08:00–16:00", word: "" },
        same: false,
      },
    });
    if (!res.ok) {
      expect(describeQuestion(res.question)).toBe(
        "A Housing A job is already booked on Cell 1 08:00–16:00. Change it to 06:00–14:00, or pick other hours?",
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
        span: "08:00–16:00",
        run: { id: "run1", label: "08:00–16:00", word: "" },
        same: true,
      });
      expect(describeQuestion(res.question)).toBe(
        "A Housing A job is already booked on Cell 1 08:00–16:00 — nothing to change.",
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
        readout: `${RB1_READOUT} · changing Housing A 08:00–16:00`,
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
        other: "Cover 08:00–16:00",
      },
    });
    if (!res.ok) {
      expect(describeQuestion(res.question)).toBe(
        "Cell 1 already runs Cover 08:00–16:00; a cell runs one job at a time. Pick other hours, or change that job on the board.",
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
      label: "Housing A 14:00–16:00",
      span: "14:00–16:00",
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
        span: "10:00–15:00",
        blocks: [{ id: "blk1", label: "10:00–14:00", word: "" }],
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
        when: "10:00–14:00",
        blocks: [{ id: "blk1", label: "Housing A 10:00–14:00", word: "", part: "Housing A" }],
      },
    });
    if (!res.ok) {
      expect(describeQuestion(res.question)).toBe(
        "Remove Operator 1's Housing A block on Cell 1, 10:00–14:00?",
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
          "Removing Operator 1's Housing A block · Plant 1 › Assembly › Line 1 › Cell 1 · 2026-09-03 · 10:00–14:00",
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
          { id: "blk1", label: "Housing A 10:00–14:00", word: "", part: "Housing A" },
          { id: "blk2", label: "Housing A 14:00–16:00", word: "", part: "Housing A" },
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
      question: { kind: "no_block", person: "Operator 1", cell: "Cell 1", when: "10:00–14:00" },
    });
    if (!withHours.ok) {
      expect(describeQuestion(withHours.question)).toBe(
        "Operator 1 has no block on Cell 1 10:00–14:00.",
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
      question: { kind: "no_block", person: "Operator 1", cell: "Cell 1", when: "14:00–16:00" },
    });
  });

  it("RU6: another person's or another cell's block asks nothing but no_block", () => {
    const bySp = resolveCommand(unassignCmd(), withBlocks([blkSp]));
    expect(bySp).toEqual({
      ok: false,
      question: { kind: "no_block", person: "Operator 1", cell: "Cell 1", when: "10:00–14:00" },
    });
    const byC2 = resolveCommand(unassignCmd(), withBlocks([blkC2]));
    expect(byC2).toEqual({
      ok: false,
      question: { kind: "no_block", person: "Operator 1", cell: "Cell 1", when: "10:00–14:00" },
    });
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
        when: "10:00–14:00",
        blocks: [{ id: "blkUnknown", label: "block 10:00–14:00", word: "", part: null }],
      },
    });
    if (!res.ok) {
      expect(describeQuestion(res.question)).toBe(
        "Remove Operator 1's block on Cell 1, 10:00–14:00?",
      );
    }
  });
});

/**
 * S41-c — the "move" resolver path, brief docs/agent-briefs/
 * s41-c-move-brief.md §5's worked examples (RM1-RM10).
 */
describe("commandResolve: S41-c move worked examples", () => {
  const MOVE_READOUT_PREFIX =
    "Moving Operator 1's Housing A block · Plant 1 › Assembly › Line 1 › Cell 1 · 2026-09-03 · 10:00–14:00";

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
        readout: `${MOVE_READOUT_PREFIX} → 10:00–15:00`,
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
        readout: `${MOVE_READOUT_PREFIX} → Cell 2 · 10:00–14:00`,
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
        readout: `${MOVE_READOUT_PREFIX} → Cell 2 · 10:00–15:00`,
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
          { id: "blk1", label: "Housing A 10:00–14:00", word: "", part: "Housing A" },
          { id: "blk2", label: "Housing A 14:00–16:00", word: "", part: "Housing A" },
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
        readout: `${MOVE_READOUT_PREFIX} → 16:00–18:00`,
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
          "Removing Operator 1's Housing A block · Plant 1 › Assembly › Line 1 › Cell 1 · 2026-09-03 · 10:00–14:00",
      },
    });
  });
});
