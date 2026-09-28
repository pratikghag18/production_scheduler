/**
 * S194-B independent review (docs/agent-briefs/s194-b-review-brief.md). Not a
 * defect pin -- a reviewer's own cases, built on the REAL board axis
 * (`buildDayAxis`/`wallOf`, the same door DEF-0047.test.ts uses), never the
 * `d*1440+m` stub. Every case here is either a documented finding (left red
 * on purpose, with a name that says what it shows) or a mutation-provable
 * guard the review confirmed by hand.
 */
import { describe, it, expect } from "vitest";
import {
  expandCommand,
  resolveCommand,
  type ResolveContext,
  type BoardDay,
  type ContextAssignment,
  type ContextRun,
} from "@/lib/command/resolve";
import {
  parseCommand,
  type UnassignCommand,
  type MoveCommand,
  type SingleCommand,
} from "@/lib/command/parse";
import { buildDayAxis, wallOf as wallOfAxis, zonedTimeToInstant } from "@/features/board/lib/time";

// ---------------------------------------------------------------------------
// Shared board: Mon 2026-08-31 .. Mon 2026-09-14 (15 days), the same span
// commandResolve.test.ts's own `rwDays` uses for "next_week" (extended by one
// day so a block that runs into the day AFTER the span still has somewhere
// to land). Today = Wed 2026-09-02 (index 2), same as `rwCtx`. Chicago has no
// DST change in this window -- the clock-change cases below use their own,
// separate axis.
// ---------------------------------------------------------------------------
const ZONE = "America/Chicago";
const isoOf = [
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
  "2026-09-14",
];
const weekdayOf = [1, 2, 3, 4, 5, 6, 0, 1, 2, 3, 4, 5, 6, 0, 1];
const axis = buildDayAxis(zonedTimeToInstant(ZONE, 2026, 8, 31, 0, 0), isoOf.length, ZONE);
const days: BoardDay[] = isoOf.map((iso, i) => ({
  index: i,
  iso,
  weekday: weekdayOf[i] as BoardDay["weekday"],
}));

const cellA = { id: "cA", name: "Cell A", path: "cellA" };
const cellB = { id: "cB", name: "Cell B", path: "cellB" };
const cellC = { id: "cC", name: "Cell C", path: "cellC" };
const nodeById = new Map([
  [cellA.id, cellA],
  [cellB.id, cellB],
  [cellC.id, cellC],
]);
const jamie = { id: "jamie", displayName: "Jamie Lee", employeeRef: null, active: true };
const sam = { id: "sam", displayName: "Sam Rivera", employeeRef: null, active: true };

// Doubt 1, primary case: a night block that lies WHOLLY inside the cleared
// span -- both Wed 2026-09-09 (day 9) and Thu 2026-09-10 (day 10) are inside
// next_week (days 7..13).
const jamieBlock: ContextAssignment = {
  id: "jamieNight",
  nodeId: cellA.id,
  operatorId: jamie.id,
  productId: "hA",
  startMin: axis.wallToOffset(9, 22 * 60),
  endMin: axis.wallToOffset(10, 6 * 60),
  label: "10:00 pm-6:00 am",
  productName: "Housing A",
  runId: null,
};

// Doubt 1, run-dedup case: a crewless run spanning the same midnight, both
// days inside the span -- only `runRemovals`/`queuedRunIds` is exercised
// (no assignment on this run for the block loop to also trip on).
const runB: ContextRun = {
  id: "runB",
  nodeId: cellB.id,
  productId: "hB",
  startMin: axis.wallToOffset(9, 22 * 60),
  endMin: axis.wallToOffset(10, 6 * 60),
  label: "Housing B 10:00 pm-6:00 am",
  span: "10:00 pm-6:00 am",
  productName: "Housing B",
  headcount: null,
};

// Doubt 1, contrast case: a block on the SPAN'S OWN LAST DAY (Sun 2026-09-13,
// day 13) running into the day after the span (Mon 2026-09-14, day 14, not in
// next_week's own days). Only day 13's call ever sees it -- must stay ONE trim.
const samBlock: ContextAssignment = {
  id: "samEdge",
  nodeId: cellC.id,
  operatorId: sam.id,
  productId: "hA",
  startMin: axis.wallToOffset(13, 22 * 60),
  endMin: axis.wallToOffset(14, 6 * 60),
  label: "10:00 pm-6:00 am",
  productName: "Housing A",
  runId: null,
};

function ctx(overrides: Partial<ResolveContext> = {}): ResolveContext {
  return {
    cells: [cellA, cellB, cellC],
    nodeById,
    operators: [jamie, sam],
    products: [
      { id: "hA", sku: "HA", name: "Housing A" },
      { id: "hB", sku: "HB", name: "Housing B" },
    ],
    offeredAt: () => [{ id: "hA" }, { id: "hB" }],
    days,
    todayIndex: 2,
    todayIso: "2026-09-02",
    wallToOffset: axis.wallToOffset,
    runs: [runB],
    fitsRun: (a, r) => a.startMin >= r.startMin && a.endMin <= r.endMin,
    minDurationMinutes: 15,
    assignments: [jamieBlock, samBlock],
    overlaps: (a, b) => a.startMin < b.endMin && b.startMin < a.endMin,
    findRunOverlap: () => null,
    shiftsAt: () => [],
    nowMinuteOfDay: null,
    wallOf: (offsetMin: number) => wallOfAxis(axis, offsetMin),
    certificateGaps: () => [],
    eligibilityPolicy: () => "warn",
    settled: true,
    ...overrides,
  } as ResolveContext;
}

const everyoneClearNextWeek: UnassignCommand = {
  intent: "unassign",
  operator: "everyone",
  place: [],
  day: { kind: "every_day", week: "next_week" },
  span: null,
  existing: null,
  shift: null,
  until: null,
};

function moveCommandsFor(
  res: ReturnType<typeof expandCommand>,
  assignmentId: string,
): SingleCommand[] {
  if (!res.ok) return [];
  const cmds = res.command.intent === "several" ? res.command.commands : [res.command];
  return cmds.filter(
    (c): c is SingleCommand =>
      c.intent === "move" &&
      c.existing?.kind === "move" &&
      c.existing.assignmentId === assignmentId,
  );
}

describe("S194-B review, doubt 1: one block is one removal, over the whole cleared span", () => {
  it("FINDING: a night block whose both days are inside the week clear becomes ONE removal, no trims (currently two conflicting trims)", () => {
    // S194-D: GREEN. `samEdge` runs out of the span's last day, so under
    // R-461 the clear first asks about Monday's part; answered No here (the
    // question itself is pinned by the contrast case below).
    const res = expandCommand(everyoneClearNextWeek, ctx(), { nextDayPart: "keep" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const jamieMoves = moveCommandsFor(res, "jamieNight");
    const cmds = res.command.intent === "several" ? res.command.commands : [res.command];
    const jamieRemoves = cmds.filter(
      (c) =>
        c.intent === "unassign" &&
        c.existing?.kind === "remove" &&
        c.existing.assignmentId === "jamieNight",
    );
    // The right answer (main session's doubt 1, review brief step 1): the
    // block lies wholly inside the span, so it is ONE removal and no move at
    // all -- never two edge trims on the same assignment id (the exact shape
    // the bar's `findDuplicateBlockPair` refuses with "those two lines are
    // about the same block").
    expect({ moves: jamieMoves.length, removes: jamieRemoves.length }).toEqual({
      moves: 0,
      removes: 1,
    });
  });

  it("the same fixture (S194-D, CONTRACT CHANGED -- this case recorded the buggy two-trim shape): jamieNight is ONE removal by id with no clock pair, and nothing else in the lot names it", () => {
    const res = expandCommand(everyoneClearNextWeek, ctx(), { nextDayPart: "keep" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const cmds = res.command.intent === "several" ? res.command.commands : [res.command];
    const naming = cmds.filter(
      (c) =>
        (c.intent === "unassign" || c.intent === "move") &&
        c.existing !== null &&
        "assignmentId" in c.existing &&
        c.existing.assignmentId === "jamieNight",
    );
    expect(naming).toHaveLength(1);
    const only = naming[0] as UnassignCommand;
    expect(only.intent).toBe("unassign");
    // Dated the first cleared day it touches (Wed 2026-09-09), span null:
    // "10 pm to 6 am" is no one-day clock pair (`resolveDaySpanStep` would
    // read it backwards); the id pins the block.
    expect(only.day).toEqual({ kind: "date", iso: "2026-09-09" });
    expect(only.span).toBeNull();
    const resolved = resolveCommand(only, ctx());
    expect(
      resolved.ok && resolved.resolved.intent === "unassign" && resolved.resolved.assignmentId,
    ).toBe("jamieNight");
  });

  it("contrast: a block on the span's LAST day running into the day after asks about Monday's part first (R-461), then stays ONE trim on No and ONE removal on Yes", () => {
    const asked = expandCommand(everyoneClearNextWeek, ctx());
    expect(asked).toMatchObject({
      ok: false,
      question: {
        kind: "other_day_part",
        direction: "next",
        day: "Monday",
        first: { kind: "person", name: "Sam Rivera" },
        others: 0,
        hours: "midnight to 6 am",
      },
    });
    const no = expandCommand(everyoneClearNextWeek, ctx(), { nextDayPart: "keep" });
    expect(no.ok).toBe(true);
    if (!no.ok) return;
    expect(moveCommandsFor(no, "samEdge").length).toBe(1);
    const yes = expandCommand(everyoneClearNextWeek, ctx(), { nextDayPart: "clear" });
    expect(yes.ok).toBe(true);
    if (!yes.ok) return;
    expect(moveCommandsFor(yes, "samEdge").length).toBe(0);
    const cmds = yes.command.intent === "several" ? yes.command.commands : [yes.command];
    expect(
      cmds.filter(
        (c) =>
          c.intent === "unassign" &&
          c.existing?.kind === "remove" &&
          c.existing.assignmentId === "samEdge",
      ),
    ).toHaveLength(1);
  });

  it("the run-dedup half: a crewless run across the same midnight is removed once (queuedRunIds), not twice", () => {
    const res = expandCommand(everyoneClearNextWeek, ctx(), { nextDayPart: "keep" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const runRemovals = res.runRemovals ?? [];
    expect(runRemovals.map((rr) => rr.runId)).toEqual(["runB"]);
  });

  it("headcount 0: a crewless run's own planned headcount of 0 (DB-sourced, never typed by a person -- the parser clamps n >= 1) reads '0 people', not a crash or '0 person'", () => {
    // Reachability check for the main session's own question: nothing in
    // `peopleCount` or in `ContextRun.headcount`'s type stops a DB row from
    // holding 0 (no CHECK constraint found on `planned_headcount` in
    // `supabase/migrations/*.sql`); the PARSER refuses a typed "for 0
    // people"/"... 0 people" (`bad_headcount`, n < 1), so this path is only
    // reachable from data, never from a sentence. `peopleCount(0)` itself
    // reads the plural branch (0 !== 1), which is correct English.
    const zeroRun: ContextRun = {
      id: "runZero",
      nodeId: cellB.id,
      productId: "hB",
      startMin: axis.wallToOffset(1, 8 * 60),
      endMin: axis.wallToOffset(1, 16 * 60),
      label: "Housing B 8:00 am-4:00 pm",
      span: "8:00 am-4:00 pm",
      productName: "Housing B",
      headcount: 0,
    };
    const command: UnassignCommand = {
      intent: "unassign",
      operator: "everyone",
      place: ["Cell B"],
      day: { kind: "date", iso: "2026-09-01" },
      span: null,
      existing: null,
      shift: null,
      until: null,
    };
    const res = expandCommand(command, ctx({ runs: [zeroRun], assignments: [] }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.runRemovals?.[0]?.readout).toContain("for 0 people");
  });
});

describe("S194-B review, FINDING: DEF-0046 piece 1 (the adjust carry) is unpinned -- DEF-0046.test.ts stays green even with it removed", () => {
  // Lane B's own brief (docs/agent-briefs/s194-b-resolver-brief.md, piece 1)
  // asked for this exact case in commandResolve.test.ts ("extend everyone on
  // a cell by 30 (two blocks, both extended, board order)") plus three more
  // ("shorten everyone"; "an adjust on a cell with no blocks"; "the bare move
  // with nothing to change"). None of the four were added -- grepped, no
  // "extend everyone"/"shorten everyone"/"DEF-0046" text anywhere in
  // commandResolve.test.ts. This left a real hole: `DEF-0046.test.ts` only
  // asserts `not.toThrow()`, and piece 2's own guard (the nothing_to_do
  // early return in `resolveMoveCommand`, a few lines below the adjust carry
  // in `expandEveryoneMove`) independently stops any crash the moment the
  // per-block command carries no destination at all -- INCLUDING the shape
  // produced by dropping the adjust carry. So mutating `adjust: command.
  // toPlace === null ? command.adjust : null` back to `adjust: null` (the
  // pre-fix line) leaves DEF-0046.test.ts green, silently turning "extend
  // everyone on Cell D by 30 minutes" into a no-op ("nothing to change") on
  // every block, never an extension. This case is the one that actually
  // proves the extension happens; written here since lane B's own brief
  // never got it into commandResolve.test.ts.
  const cellD = { id: "cD", name: "Cell D", path: "cellD" };
  const dana = { id: "dana", displayName: "Dana Kim", employeeRef: null, active: true };
  const eli = { id: "eli", displayName: "Eli Park", employeeRef: null, active: true };
  const danaBlk: ContextAssignment = {
    id: "danaBlk",
    nodeId: cellD.id,
    operatorId: dana.id,
    productId: "hA",
    startMin: axis.wallToOffset(2, 8 * 60),
    endMin: axis.wallToOffset(2, 16 * 60),
    label: "8:00 am-4:00 pm",
    productName: "Housing A",
    runId: null,
  };
  const eliBlk: ContextAssignment = {
    id: "eliBlk",
    nodeId: cellD.id,
    operatorId: eli.id,
    productId: "hA",
    startMin: axis.wallToOffset(2, 9 * 60),
    endMin: axis.wallToOffset(2, 17 * 60),
    label: "9:00 am-5:00 pm",
    productName: "Housing A",
    runId: null,
  };
  function extendCtx(): ResolveContext {
    return {
      cells: [cellD],
      nodeById: new Map([[cellD.id, cellD]]),
      operators: [dana, eli],
      products: [{ id: "hA", sku: "HA", name: "Housing A" }],
      offeredAt: () => [{ id: "hA" }],
      days,
      todayIndex: 2,
      todayIso: "2026-09-02",
      wallToOffset: axis.wallToOffset,
      runs: [],
      fitsRun: (a, r) => a.startMin >= r.startMin && a.endMin <= r.endMin,
      minDurationMinutes: 15,
      assignments: [danaBlk, eliBlk],
      overlaps: (a, b) => a.startMin < b.endMin && b.startMin < a.endMin,
      findRunOverlap: () => null,
      shiftsAt: () => [],
      nowMinuteOfDay: null,
      wallOf: (m: number) => wallOfAxis(axis, m),
      certificateGaps: () => [],
      eligibilityPolicy: () => "warn",
      settled: true,
    } as ResolveContext;
  }

  it("'extend everyone on Cell D by 30 minutes' -- both blocks actually extended, board order, never a no-op", () => {
    const c = extendCtx();
    const command: MoveCommand = {
      intent: "move",
      operator: "everyone",
      place: ["Cell D"],
      toPlace: null,
      day: null, // today, day 2
      span: null,
      existing: null,
      shift: null,
      adjust: { edge: "end", by: 30 },
    };
    const expanded = expandCommand(command, c);
    expect(expanded.ok).toBe(true);
    if (!expanded.ok) return;
    const steps =
      expanded.command.intent === "several" ? expanded.command.commands : [expanded.command];
    expect(steps).toHaveLength(2);
    const results = steps.map((s) => resolveCommand(s, c));
    for (const r of results) {
      expect(r.ok, JSON.stringify(r)).toBe(true);
    }
    // S194-D: narrowed by control flow instead of a hand-written type
    // predicate, whose type was not assignable to `Resolution` (tsc read
    // TS2677/TS2339 here -- vitest never type-checks, so the file still ran).
    const ranges = results
      .flatMap((r) => (r.ok && r.resolved.intent === "move" ? [r.resolved.range] : []))
      .map((range) => range.endMin);
    // Board order: danaBlk pushed first (`ctx.assignments` order), original
    // ends 16:00/17:00 -> extended ends 16:30/17:30.
    expect(ranges).toEqual([
      axis.wallToOffset(2, 16 * 60 + 30),
      axis.wallToOffset(2, 17 * 60 + 30),
    ]);
  });
});

describe("S194-B review, doubt 2: the bare-move nothing_to_do wording (R-459)", () => {
  it("no case anywhere pinned the old '-- nothing to change' text before this review (grepped src/test)", () => {
    // Documented here rather than asserted mechanically -- a grep of
    // src/test for the literal old string ("'s block on ${...} -- nothing to
    // change") found nothing in commandResolve.test.ts, commandBar.test.tsx
    // or the DEF-0046 pin (which only asserts `not.toThrow()`, never reads
    // `question.text`). Free to change; changed below.
    expect(true).toBe(true);
  });

  it("FIXED: 'move Jamie Lee's block' with nothing to change reads as one plain sentence, no ASCII dash", () => {
    const command: MoveCommand = {
      intent: "move",
      operator: "Jamie Lee",
      place: ["Cell A"],
      toPlace: null,
      day: { kind: "date", iso: "2026-09-09" },
      span: null,
      existing: null,
      shift: null,
      adjust: null,
    };
    const res = resolveCommand(command, ctx());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.question).toEqual({
      kind: "nothing_to_do",
      text: "Jamie Lee's block on Cell A has nothing to change.",
    });
  });
});

describe("S194-B review, doubt 3: can a parsed move legitimately reach resolveMoveCommand with adjust/toPlace/span/shift all null?", () => {
  it("REFUTED: 'move Jamie Lee's block to tomorrow' (day only, no destination) is refused at PARSE time, no_move -- never reaches the resolver", () => {
    const res = parseCommand("move Jamie Lee's block to tomorrow");
    expect(res).toEqual({ ok: false, failure: { kind: "no_move" } });
  });

  it("REFUTED: 'move Jamie Lee to tomorrow' (no place, no destination) is the same no_move refusal", () => {
    const res = parseCommand("move Jamie Lee to tomorrow");
    expect(res).toEqual({ ok: false, failure: { kind: "no_move" } });
  });

  it("REFUTED: the ordinary move door's own no_move check (parse.ts) requires at least one of toPlace/span/shift; the two adjust doors always set `adjust` non-null -- so intent:'move' never reaches resolveCommand with all four null except via expandEveryoneMove's per-block step, which now carries the sentence's own adjust (DEF-0046 fix, confirmed above)", () => {
    // A same-day move naming only a new cell (toPlace set) is the one other
    // shape that reaches resolveMoveCommand ordinarily -- confirms the
    // parser's own invariant holds for the everyday case too.
    const res = parseCommand("move Jamie Lee to Cell B");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.command).toMatchObject({ intent: "move", toPlace: ["Cell B"], adjust: null });
  });
});

describe("S194-B review: named-person empty week, every WEEK_WORD phrasing", () => {
  const emptyWeekCtx = ctx({ assignments: [], runs: [] });

  it("'this week' and 'next week' both name the person, not 'The board'", () => {
    const thisWeek: UnassignCommand = {
      intent: "unassign",
      operator: "Jamie Lee",
      place: [],
      day: { kind: "every_day", week: "this_week" },
      span: null,
      existing: null,
      shift: null,
      until: null,
    };
    const nextWeek: UnassignCommand = {
      ...thisWeek,
      day: { kind: "every_day", week: "next_week" },
    };
    const resThis = expandCommand(thisWeek, emptyWeekCtx);
    const resNext = expandCommand(nextWeek, emptyWeekCtx);
    expect(resThis).toEqual({
      ok: false,
      question: { kind: "nothing_to_do", text: "Jamie Lee has no block this week." },
    });
    expect(resNext).toEqual({
      ok: false,
      question: { kind: "nothing_to_do", text: "Jamie Lee has no block next week." },
    });
  });

  it("every UNASSIGN_WEEK_PHRASES spelling folds to the same two DayWords at PARSE time -- 'for the rest of the week'/'all week'/'for the whole week' all read as this_week, only 'next week' differs", () => {
    const phrasings: Array<[string, "this_week" | "next_week"]> = [
      ["clear Jamie Lee this week", "this_week"],
      ["clear Jamie Lee next week", "next_week"],
      ["clear Jamie Lee for the rest of the week", "this_week"],
      ["clear Jamie Lee for the whole week", "this_week"],
      ["clear Jamie Lee all week", "this_week"],
    ];
    for (const [sentence, expectedWeek] of phrasings) {
      const res = parseCommand(sentence);
      expect(res.ok, sentence).toBe(true);
      if (!res.ok) continue;
      const day = (res.command as UnassignCommand).day as { kind: string; week: string };
      expect([sentence, day.kind, day.week]).toEqual([sentence, "every_day", expectedWeek]);
    }
  });
});

// ---------------------------------------------------------------------------
// Doubt 1, re-run in a clock-change week, both directions of UTC -- the bug
// is real-minute per-day windowing, not a DST-specific miscalculation, but
// the review brief asks for a case west and a case east of UTC to rule out
// a DST-only escape hatch. Each builds its OWN small axis, the same door
// DEF-0047.test.ts uses (`buildDayAxis`/`wallOf`, never `d*1440+m`).
// ---------------------------------------------------------------------------
describe("S194-B review, doubt 1 in a clock-change week", () => {
  function dstCase(
    zone: string,
    label: string,
    startIso: [number, number, number], // [year, month, day] of the axis's own day 0
    isoOf7: string[],
    weekdayOf7: BoardDay["weekday"][],
    blockDay: number, // index of the day the block STARTS on (block runs blockDay..blockDay+1)
    expectedRealHours: number,
  ) {
    it(`${label}: a night block across the clock change, both its days inside the week clear, is ONE removal and no trim (real hours = ${expectedRealHours}) -- S194-D, CONTRACT CHANGED from the two-trim evidence`, () => {
      const a = buildDayAxis(
        zonedTimeToInstant(zone, startIso[0], startIso[1], startIso[2], 0, 0),
        7,
        zone,
      );
      const d: BoardDay[] = isoOf7.map((iso, i) => ({ index: i, iso, weekday: weekdayOf7[i] }));
      const cell = { id: "dstCell", name: "Cell 1", path: "dstCell" };
      const op = { id: "op", displayName: "Robin Ortiz", employeeRef: null, active: true };
      const blk: ContextAssignment = {
        id: "dstBlk",
        nodeId: cell.id,
        operatorId: op.id,
        productId: "hA",
        startMin: a.wallToOffset(blockDay, 22 * 60),
        endMin: a.wallToOffset(blockDay + 1, 6 * 60),
        label: "10:00 pm-6:00 am",
        productName: "Housing A",
        runId: null,
      };
      const c: ResolveContext = {
        cells: [cell],
        nodeById: new Map([[cell.id, cell]]),
        operators: [op],
        products: [{ id: "hA", sku: "HA", name: "Housing A" }],
        offeredAt: () => [{ id: "hA" }],
        days: d,
        todayIndex: 0,
        todayIso: isoOf7[0],
        wallToOffset: a.wallToOffset,
        runs: [],
        fitsRun: (x, r) => x.startMin >= r.startMin && x.endMin <= r.endMin,
        minDurationMinutes: 15,
        assignments: [blk],
        overlaps: (x, y) => x.startMin < y.endMin && y.startMin < x.endMin,
        findRunOverlap: () => null,
        shiftsAt: () => [],
        nowMinuteOfDay: null,
        wallOf: (m: number) => wallOfAxis(a, m),
        certificateGaps: () => [],
        eligibilityPolicy: () => "warn",
        settled: true,
      } as ResolveContext;

      expect(blk.endMin - blk.startMin).toBe(expectedRealHours * 60);

      // "this_week" (not "next_week"): the 7-day axis built above IS the
      // display week itself, todayIndex 0 -- `resolveWeekDays("this_week",
      // ...)` finds Monday of TODAY's own week inside `ctx.days`, which is
      // exactly this window. `next_week` would ask about days off this
      // 7-day board (`day_off_board`), which is not what this case tests.
      const command: UnassignCommand = {
        intent: "unassign",
        operator: "everyone",
        place: [],
        day: { kind: "every_day", week: "this_week" },
        span: null,
        existing: null,
        shift: null,
        until: null,
      };
      const res = expandCommand(command, c);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const moves = moveCommandsFor(res, "dstBlk");
      // S194-D: the span is planned once (`planClear`), so the block lying
      // wholly inside it is one removal, whatever the clock did that night.
      expect(moves.length).toBe(0);
      const cmds = res.command.intent === "several" ? res.command.commands : [res.command];
      const removes = cmds.filter(
        (x) =>
          x.intent === "unassign" &&
          x.existing?.kind === "remove" &&
          x.existing.assignmentId === "dstBlk",
      );
      expect(removes).toHaveLength(1);
      expect(resolveCommand(removes[0], c).ok).toBe(true);
    });
  }

  // West of UTC: America/Chicago, 8 Mar 2026 -- spring forward, 02:00 ->
  // 03:00, so Sun 8 Mar is a 23-hour day; the block Sat 22:00 -> Sun 06:00
  // runs only 7 real hours instead of 8.
  dstCase(
    "America/Chicago",
    "west of UTC",
    [2026, 3, 2],
    [
      "2026-03-02",
      "2026-03-03",
      "2026-03-04",
      "2026-03-05",
      "2026-03-06",
      "2026-03-07",
      "2026-03-08",
    ],
    [1, 2, 3, 4, 5, 6, 0],
    5, // Sat (index 5) 22:00 -> Sun (index 6) 06:00, the spring-forward night
    7,
  );

  // East of UTC: Europe/Berlin, 25 Oct 2026 -- fall back, 03:00 -> 02:00, so
  // Sun 25 Oct is a 25-hour day; the block Sat 22:00 -> Sun 06:00 runs 9 real
  // hours instead of 8.
  dstCase(
    "Europe/Berlin",
    "east of UTC",
    [2026, 10, 19],
    [
      "2026-10-19",
      "2026-10-20",
      "2026-10-21",
      "2026-10-22",
      "2026-10-23",
      "2026-10-24",
      "2026-10-25",
    ],
    [1, 2, 3, 4, 5, 6, 0],
    5, // Sat (index 5) 22:00 -> Sun (index 6) 06:00, the fall-back night
    9,
  );
});
