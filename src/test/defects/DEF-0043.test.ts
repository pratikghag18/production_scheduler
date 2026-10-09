/**
 * DEF-0043: `expandRepeatUnassign` (src/lib/command/resolve.ts, S72-e/F-224)
 * answers "The board has nobody on it this week." for a NAMED-PERSON week
 * clear with no place named and no matching blocks -- "clear Sam Patel this
 * week" when Sam has no blocks at all that week. The label is built purely
 * from `command.place.length > 0` (`"The board"` otherwise), never from
 * whether the removal is a named person or `everyone`; for `everyone` that
 * label is correct ("The board has nobody on it..." -- nothing at all was
 * cleared). For a NAMED person it is not: nothing said "the board" was
 * empty, only that Sam Patel has no block this week, and the sentence
 * should say so the way every other named-person refusal does (AB3: "Sam
 * has no block from ... to ...", EX5: "Cell 1 has nobody on it ...").
 */
import { describe, it, expect } from "vitest";
import { expandCommand, type ResolveContext, type BoardDay } from "@/lib/command/resolve";
import type { UnassignCommand } from "@/lib/command/parse";

const days: BoardDay[] = [
  { index: 0, iso: "2026-08-31", weekday: 1 },
  { index: 1, iso: "2026-09-01", weekday: 2 },
  { index: 2, iso: "2026-09-02", weekday: 3 },
  { index: 3, iso: "2026-09-03", weekday: 4 },
  { index: 4, iso: "2026-09-04", weekday: 5 },
  { index: 5, iso: "2026-09-05", weekday: 6 },
  { index: 6, iso: "2026-09-06", weekday: 0 },
];

const node = { id: "c1", name: "Cell 1", path: "plant.cell_1" };

function ctx(overrides: Partial<ResolveContext> = {}): ResolveContext {
  return {
    cells: [node],
    nodeById: new Map([[node.id, node]]),
    operators: [{ id: "sam", displayName: "Sam Patel", employeeRef: null, active: true }],
    products: [],
    offeredAt: () => [],
    days,
    todayIndex: 2,
    todayIso: "2026-09-02",
    wallToOffset: (d, m) => d * 1440 + m,
    runs: [],
    fitsRun: () => true,
    minDurationMinutes: 15,
    assignments: [],
    overlaps: (a, b) => a.startMin < b.endMin && b.startMin < a.endMin,
    findRunOverlap: () => null,
    shiftsAt: () => [],
    nowMinuteOfDay: null,
    wallOf: (m) => ({ dayIndex: Math.floor(m / 1440), minuteOfDay: m % 1440 }),
    certificateGaps: () => [],
    eligibilityPolicy: () => "warn",
    settled: true,
    ...overrides,
  } as ResolveContext;
}

describe("DEF-0043: a named-person week clear with nothing to remove says 'The board', not the person's name", () => {
  it("'clear Sam Patel this week' with no blocks at all names Sam, not 'The board'", () => {
    const command: UnassignCommand = {
      intent: "unassign",
      operator: "Sam Patel",
      place: [],
      day: { kind: "every_day", week: "this_week" },
      span: null,
      existing: null,
      shift: null,
      until: null,
    };
    const res = expandCommand(command, ctx());
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.question.kind).toBe("nothing_to_do");
      const text = (res.question as { text?: string }).text ?? "";
      expect(text).toContain("Sam Patel");
      expect(text).not.toContain("The board");
    }
  });
});
