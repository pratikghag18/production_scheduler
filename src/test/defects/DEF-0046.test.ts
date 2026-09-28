/**
 * DEF-0046 -- the button the bar offers for a misheard sentence crashes when pressed.
 *
 * Live (tester's stack, the served model on, 28 Sept): heard "sorry, this will take a few extra
 * minutes, go ahead without me"; the model read it as a move of everyone, end edge +30 minutes;
 * grounding said no_intent_word, so the bar asked "Did you mean: extend \"everyone\" by 30
 * minutes?" with that as a one-press button. The press ran runCommand -> startLot ->
 * resolveLotStep -> resolveCommand and threw in the browser:
 *   TypeError: Cannot read properties of null (reading 'start') at resolveMoveCommand
 * The question stayed on screen, nothing was written, no trace entry was filed.
 * This pin takes the same path runCommand does (expand, then resolve every step) on the
 * model's exact reading, and asserts no step throws. Green when every step resolves to an
 * answer or a question.
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
import type { MoveCommand, SingleCommand } from "@/lib/command/parse";

const days: BoardDay[] = [
  { index: 0, iso: "2026-10-11", weekday: 0 }, // Sun
  { index: 1, iso: "2026-10-12", weekday: 1 }, // Mon
];

const line2 = { id: "line2", name: "Line 2", path: "line2" };
const cell4 = { id: "cell4", name: "Cell 4", path: "line2.cell4" };

const priyaBlk: ContextAssignment = {
  id: "priyaBlk",
  nodeId: "cell4",
  operatorId: "priya",
  productId: "wx",
  startMin: 0 * 1440 + 22 * 60, // Sun 22:00
  endMin: 1 * 1440 + 6 * 60, // Mon 06:00
  label: "10 pm to 6 am",
  productName: "Housing A",
  runId: "run1",
};

const housingRun: ContextRun = {
  id: "run1",
  nodeId: "cell4",
  productId: "wx",
  startMin: 0 * 1440 + 22 * 60,
  endMin: 1 * 1440 + 6 * 60,
  label: "Housing A 10 pm to 6 am",
  span: "10 pm to 6 am",
  productName: "Housing A",
  headcount: 1,
};

function ctx(): ResolveContext {
  return {
    cells: [cell4],
    nodeById: new Map([
      ["line2", line2],
      ["cell4", cell4],
    ]),
    operators: [{ id: "priya", displayName: "Priya Shah", employeeRef: null, active: true }],
    products: [{ id: "wx", sku: "WX", name: "Housing A" }],
    offeredAt: () => [{ id: "wx" }],
    days,
    todayIndex: 0,
    todayIso: "2026-10-11",
    wallToOffset: (d, m) => d * 1440 + m,
    runs: [housingRun],
    fitsRun: () => true,
    minDurationMinutes: 15,
    assignments: [priyaBlk],
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

describe("DEF-0046: pressing the offered 'extend everyone' reading does not crash", () => {
  it("expand then resolve every step of the model's own reading, as runCommand does, without a throw", () => {
    const reading = {
      intent: "move",
      operator: "everyone",
      place: [],
      toPlace: null,
      day: null,
      span: null,
      existing: null,
      shift: null,
      adjust: { edge: "end", by: 30 },
    } as unknown as MoveCommand;
    const c = ctx();
    const expanded = expandCommand(reading, c);
    if (!expanded.ok) return; // a question is a fine answer
    const steps = (
      expanded.command.intent === "several" ? expanded.command.commands : [expanded.command]
    ) as readonly SingleCommand[];
    for (const step of steps) {
      expect(() => resolveCommand(step, c), JSON.stringify(step)).not.toThrow();
    }
  });
});
