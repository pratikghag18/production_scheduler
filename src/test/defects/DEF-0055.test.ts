/**
 * DEF-0055: "clear Maria Lopez tomorrow" -- a supervisor naming a PERSON after
 * the word clear. The grammar reads whatever follows "clear" as a PLACE
 * (`unassign "everyone" from Maria Lopez`), the resolver finds no cell of that
 * name, and the bar answers `No cell called "Maria Lopez" on your board. Did
 * you mean one of these?` with the board's CELLS as buttons -- one press turns
 * a sentence about one person into a clear of a whole cell. Seen live on 30
 * Sept as Ana and as the plant admin, for a person with a block that day and
 * for one with none. "remove Maria Lopez tomorrow" reads the person correctly.
 *
 * R-430: the closest match to "Maria Lopez" is the person called Maria Lopez.
 * R-435: two honest readings (a place, a person) become a question with both,
 * never a quiet pick of the one that does not exist.
 *
 * Pinned at the parser and the resolver, the two steps the bar runs before it
 * speaks. A fix may read the person outright or ask which was meant; either
 * way the answer is not "no cell called <a person's exact name>".
 */
import { describe, it, expect } from "vitest";
import { parseCommand } from "@/lib/command/parse";
import {
  expandCommand,
  describeQuestion,
  type ResolveContext,
  type BoardDay,
  type ContextAssignment,
} from "@/lib/command/resolve";

const days: BoardDay[] = [
  { index: 0, iso: "2026-09-30", weekday: 3 },
  { index: 1, iso: "2026-10-01", weekday: 4 },
];
const line1 = { id: "line1", name: "Line 1", path: "line1" };
const cell1 = { id: "cell1", name: "Cell 1", path: "line1.cell1" };
const cell2 = { id: "cell2", name: "Cell 2", path: "line1.cell2" };

const mariaBlk: ContextAssignment = {
  id: "mariaBlk",
  nodeId: "cell2",
  operatorId: "maria",
  productId: "ha",
  startMin: 1 * 1440 + 14 * 60,
  endMin: 1 * 1440 + 22 * 60,
  label: "2 pm to 10 pm",
  productName: "Housing A",
  runId: null,
};

function ctx(): ResolveContext {
  return {
    cells: [cell1, cell2],
    nodeById: new Map([line1, cell1, cell2].map((n) => [n.id, n])),
    operators: [{ id: "maria", displayName: "Maria Lopez", employeeRef: null, active: true }],
    products: [{ id: "ha", sku: "HA", name: "Housing A" }],
    offeredAt: () => [{ id: "ha" }],
    days,
    todayIndex: 0,
    todayIso: "2026-09-30",
    wallToOffset: (d, m) => d * 1440 + m,
    runs: [],
    fitsRun: () => true,
    minDurationMinutes: 1,
    assignments: [mariaBlk],
    overlaps: (a, b) => a.startMin < b.endMin && b.startMin < a.endMin,
    findRunOverlap: () => null,
    shiftsAt: () => [],
    nowMinuteOfDay: null,
    wallOf: (m) => ({ dayIndex: Math.floor(m / 1440), minuteOfDay: m % 1440 }),
    certificateGaps: () => [],
    eligibilityPolicy: () => "warn",
    settled: true,
  } as ResolveContext;
}

describe("DEF-0055: 'clear <a person's name> <day>' is about that person, not a cell that does not exist", () => {
  it("'clear Maria Lopez tomorrow' is not answered 'No cell called \"Maria Lopez\"'", () => {
    const parsed = parseCommand("clear Maria Lopez tomorrow");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const res = expandCommand(parsed.command, ctx());
    const said = res.ok ? "(a lot)" : describeQuestion(res.question);
    expect(said).not.toMatch(/^No cell called "Maria Lopez"/);
  });

  it("'remove Maria Lopez tomorrow' reads the person (the control)", () => {
    const parsed = parseCommand("remove Maria Lopez tomorrow");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const res = expandCommand(parsed.command, ctx());
    const said = res.ok ? "(a lot)" : describeQuestion(res.question);
    expect(said).not.toMatch(/No cell called/);
  });
});
