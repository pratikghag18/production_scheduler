/**
 * DEF-0047 (tester lane): "clear Priya Shah every day this week", with Priya's
 * night block sitting across the Saturday-into-Sunday DST changeover (America/
 * Chicago springs forward at 02:00->03:00 on Sun 8 Mar 2026, so Sunday is a
 * 23-hour day). The REAL board axis (`buildDayAxis`/`wallOf` from
 * `src/features/board/lib/time.ts`, never the `d*1440+m` stub the resolver's
 * own suite uses) resolves the block's wall-clock hours correctly (10 pm to 6
 * am) -- but `expandRepeatUnassign`'s named-person path (src/lib/command/
 * resolve.ts ~5168-5206) loops the week's SEVEN days and, for each day whose
 * window overlaps the block, pushes a SEPARATE `remove` command for the SAME
 * assignment id. A block that crosses midnight overlaps two days' windows, so
 * it is queued for removal TWICE in one lot: the readout says two things were
 * done (both naming the same block, same hours) when only one assignment ever
 * existed. There is no DST bug in the wall-clock reading itself; the bug is
 * that the day loop de-dupes nothing, and it happens to be exactly the shape
 * (a night block, this week) the DST scenario the tester's brief asks for.
 */
import { describe, it, expect } from "vitest";
import { expandCommand } from "@/lib/command/resolve";
import type { ResolveContext, ContextAssignment, BoardDay } from "@/lib/command/resolve";
import type { UnassignCommand } from "@/lib/command/parse";
import { buildDayAxis, wallOf as wallOfAxis, zonedTimeToInstant } from "@/features/board/lib/time";

const ZONE = "America/Chicago";

// Window: Mon 2026-03-02 .. Sun 2026-03-08 (7 days), the week the DST change
// (Sun 8 Mar, 02:00 -> 03:00) falls inside. Day 0 = Monday.
const isoOf = [
  "2026-03-02",
  "2026-03-03",
  "2026-03-04",
  "2026-03-05",
  "2026-03-06",
  "2026-03-07",
  "2026-03-08",
];
const weekdayOf = [1, 2, 3, 4, 5, 6, 0]; // Mon..Sat, then Sun

const axis = buildDayAxis(
  // day 0's own local midnight instant, computed the same way BoardPage does
  // (never `new Date("2026-03-02T00:00")`, which is the MACHINE's zone).
  zonedTimeToInstant(ZONE, 2026, 3, 2, 0, 0),
  7,
  ZONE,
);

const days: BoardDay[] = isoOf.map((iso, i) => ({
  index: i,
  iso,
  weekday: weekdayOf[i] as BoardDay["weekday"],
}));

const SAT = 5; // 2026-03-07
const SUN = 6; // 2026-03-08, the 23-hour day

const cellNode = { id: "c4", name: "Cell 4", path: "cell_4" };
const nodeById = new Map([[cellNode.id, cellNode]]);
const priya = { id: "priya", displayName: "Priya Shah", employeeRef: null, active: true };

// Priya's real night block: Sat 22:00 -> Sun 06:00, plant-local, spanning the
// spring-forward night (only 7 REAL hours, since 02:00-03:00 does not occur).
const priyaBlock: ContextAssignment = {
  id: "priyaNight",
  nodeId: cellNode.id,
  operatorId: priya.id,
  productId: "hA",
  startMin: axis.wallToOffset(SAT, 22 * 60),
  endMin: axis.wallToOffset(SUN, 6 * 60),
  label: "22:00-06:00",
  productName: "Housing A",
  runId: null,
};

function ctx(overrides: Partial<ResolveContext> = {}): ResolveContext {
  return {
    cells: [cellNode],
    nodeById,
    operators: [priya],
    products: [{ id: "hA", sku: "HA", name: "Housing A" }],
    offeredAt: () => [{ id: "hA" }],
    days,
    todayIndex: SAT,
    todayIso: "2026-03-07",
    wallToOffset: axis.wallToOffset,
    runs: [],
    fitsRun: (a, r) => a.startMin >= r.startMin && a.endMin <= r.endMin,
    minDurationMinutes: 15,
    assignments: [priyaBlock],
    overlaps: (a, b) => a.startMin < b.endMin && b.startMin < a.endMin,
    findRunOverlap: () => null,
    shiftsAt: () => [],
    nowMinuteOfDay: null,
    wallOf: (offsetMin: number) => wallOfAxis(axis, offsetMin),
    certificateGaps: () => [],
    eligibilityPolicy: () => "warn",
    settled: true,
    ...overrides,
  };
}

const command: UnassignCommand = {
  intent: "unassign",
  operator: "Priya Shah",
  place: [],
  day: { kind: "every_day", week: "this_week" },
  span: null,
  existing: null,
  shift: null,
  until: null,
};

describe("DEF-0047 (DST week, named-person repeat clear)", () => {
  it("real DST axis: Priya's block real duration is 7 hours, not 8, across the spring-forward night", () => {
    // Sanity check that this fixture actually exercises the missing hour --
    // otherwise the case below would not be testing DST at all.
    expect(priyaBlock.endMin - priyaBlock.startMin).toBe(7 * 60);
  });

  it("'clear Priya Shah every day this week' removes her one Sat/Sun night block exactly ONCE, not once per day it overlaps", () => {
    const res = expandCommand(command, ctx());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const cmds =
      res.command.intent === "several"
        ? (res.command.commands as UnassignCommand[])
        : [res.command as UnassignCommand];
    const removalIds = cmds
      .map((c) => c.existing)
      .filter((e): e is { kind: "remove"; assignmentId: string } => e?.kind === "remove")
      .map((e) => e.assignmentId);
    // BUG: the day loop finds `priyaNight` on BOTH Saturday's window and
    // Sunday's window (it genuinely overlaps both in real minutes) and
    // queues a `remove` for the SAME assignment id twice.
    expect(removalIds).toEqual(["priyaNight"]);
  });

  // WIDENED by the tester, 30 Sept (session 195t), at the developer's request
  // in the defect file: the sentence in the Reproduction ("clear Line 1 for the
  // rest of the week") takes the EVERYONE-on-a-place branch, which the case
  // above never reached. Same block, same real axis, named by place instead.
  it("'clear Cell 4 every day this week' (everyone on the place) names her one night block exactly ONCE in the lot", () => {
    const everyone: UnassignCommand = { ...command, operator: "everyone", place: ["Cell 4"] };
    // Monday is "today" so the whole week, Saturday and Sunday both, is in the clear.
    const res = expandCommand(everyone, ctx({ todayIndex: 0, todayIso: "2026-03-02" }), {
      previousDayPart: "clear",
      nextDayPart: "clear",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const cmds = res.command.intent === "several" ? res.command.commands : [res.command];
    const named = cmds.flatMap((c) =>
      "existing" in c && c.existing && "assignmentId" in c.existing
        ? [c.existing.assignmentId]
        : [],
    );
    expect(named).toEqual(["priyaNight"]);
  });
});
