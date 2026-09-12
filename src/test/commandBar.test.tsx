/**
 * P1-7a — the typed command bar's own component tests (brief §9, C1-C10).
 *
 * UNMOCKED. Lane A's `src/lib/command/parse.ts` and `resolve.ts` had already
 * landed real bodies (no more `"not implemented"`) by the time this lane
 * finished, so this file drives `CommandBar` against the REAL
 * `parseCommand`/`formatCommand`/`expectedShape`/`resolveCommand`/
 * `describeQuestion` — the mocked version the brief's "Working before Lane A
 * lands" section describes was not needed as the committed test. `ctx` is the
 * §5 fixture, verbatim (window, nodes, operators, products, run1).
 *
 * `CommandBar` itself holds no rule (§2, "no second door") -- it only turns
 * those two modules' answers into a text box, a status line and some buttons,
 * so this file is a thin behavioural test over that wiring, not a second copy
 * of `commandParse.test.ts`/`commandResolve.test.ts`'s own case tables.
 *
 * Same shape as `settingsPanel.test.tsx`: `@testing-library/react` + jsdom.
 */
import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { formatDayLabel } from "@/features/board/lib/time";
import { formatCommand, type AssignCommand } from "@/lib/command/parse";
import type {
  ResolveContext,
  ResolvedCommand,
  ResolvedBook,
  ResolvedUnassign,
  ResolvedMove,
  ContextRun,
  ContextAssignment,
} from "@/lib/command/resolve";
import { CommandBar } from "@/features/board/components/CommandBar";

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

/** Brief §5's fixture, verbatim: a 7-day window from Monday 2026-08-31,
 *  today = index 3 (Thursday 2026-09-03), the plain (no-changeover) stub. */
function buildCtx(over: Partial<ResolveContext> = {}): ResolveContext {
  const nodes = [
    { id: "p1", name: "Plant 1", path: "plant_1" },
    { id: "asm", name: "Assembly", path: "plant_1.assembly" },
    { id: "l1", name: "Line 1", path: "plant_1.assembly.line_1" },
    { id: "l3", name: "Line 3", path: "plant_1.assembly.line_3" },
    { id: "c1a", name: "Cell 1", path: "plant_1.assembly.line_1.cell_1" },
    { id: "c2", name: "Cell 2", path: "plant_1.assembly.line_1.cell_2" },
    { id: "c1b", name: "Cell 1", path: "plant_1.assembly.line_3.cell_1" },
  ];
  return {
    cells: [nodes[4], nodes[5], nodes[6]],
    nodeById: new Map(nodes.map((n) => [n.id, n] as const)),
    operators: [
      { id: "op1", displayName: "Operator 1", employeeRef: "E100", active: true },
      { id: "sp", displayName: "Sam Patel", employeeRef: null, active: true },
      { id: "so", displayName: "Sam Ortiz", employeeRef: "E200", active: true },
      { id: "lin", displayName: "Lin On", employeeRef: null, active: true },
      { id: "gone", displayName: "Sam Gone", employeeRef: null, active: false },
    ],
    products: [
      { id: "ha", sku: "HA-1", name: "Housing A" },
      { id: "hb", sku: "HB-1", name: "Housing B" },
      { id: "cov", sku: "CV-9", name: "Cover" },
    ],
    offeredAt: (nodeId: string) =>
      nodeId === "c1b" ? [{ id: "cov" }] : [{ id: "ha" }, { id: "hb" }],
    days: [
      { index: 0, iso: "2026-08-31", weekday: 1 },
      { index: 1, iso: "2026-09-01", weekday: 2 },
      { index: 2, iso: "2026-09-02", weekday: 3 },
      { index: 3, iso: "2026-09-03", weekday: 4 },
      { index: 4, iso: "2026-09-04", weekday: 5 },
      { index: 5, iso: "2026-09-05", weekday: 6 },
      { index: 6, iso: "2026-09-06", weekday: 0 },
    ],
    todayIndex: 3,
    wallToOffset: (d: number, m: number) => d * 1440 + m,
    runs: [],
    fitsRun: (a, r) => a.startMin >= r.startMin && a.endMin <= r.endMin,
    minDurationMinutes: 15,
    assignments: [],
    overlaps: (a, b) => a.startMin < b.endMin && b.startMin < a.endMin,
    findRunOverlap,
    ...over,
  };
}

/** R27's run: Housing A 08:00-16:00 on Cell 1 (c1a), Thursday (day index 3). */
const RUN1: ContextRun = {
  id: "run1",
  nodeId: "c1a",
  productId: "ha",
  startMin: 3 * 1440 + 480,
  endMin: 3 * 1440 + 960,
  label: "Housing A 08:00–16:00",
  span: "08:00–16:00",
};

/** S41-a: the same job as RUN1, standing in for "the job of this part
 *  already booked" (CB2's fixture -- `id`/`label`/`span` mirror it). */
const JOB1 = RUN1;

/** S41-a: a Cover job on Cell 1 (a DIFFERENT part than the book sentence's
 *  Housing A) -- CB3's "job in the way" fixture. */
const JOB_COV: ContextRun = {
  id: "jobCov",
  nodeId: "c1a",
  productId: "cov",
  startMin: 3 * 1440 + 480,
  endMin: 3 * 1440 + 960,
  label: "Cover 08:00–16:00",
  span: "08:00–16:00",
};

/** R-385: the sentence's own hours (10:00-14:00), already on the board for
 *  Operator 1 / Housing A / Cell 1 (c1a), Thursday (day index 3). */
const BLK1: ContextAssignment = {
  id: "blk1",
  nodeId: "c1a",
  operatorId: "op1",
  productId: "ha",
  productName: "Housing A",
  startMin: 3 * 1440 + 600,
  endMin: 3 * 1440 + 840,
  label: "10:00–14:00",
};

const P1_SENTENCE = "Assign Operator 1 to Housing A on Cell 1 in Line 1 from 10 to 2";
const P1_RETIME_SENTENCE = "Assign Operator 1 to Housing A on Cell 1 in Line 1 from 10 to 3";
/** S41-a/S41-b/S41-c: the four shapes in one sentence -- this changes a
 *  string C5/C6/C7 test verbatim (contract changed again, CLAUDE.md §4). */
/** F-133 (contract changed again, CLAUDE.md §4): every clause gains
 *  `[on <day>]` after its time clause too, now that the day word may come
 *  after the hours. */
const SHAPE =
  "Say it like: assign <person> to <part> on <cell> [in <line>] [on <day>] from <time> to <time> [on <day>] — or: book <part> on <cell> [in <line>] [for <n> people] [on <day>] from <time> to <time> [on <day>] — or: unassign <person> from <cell> [in <line>] [on <day>] [from <time> to <time> [on <day>]] — or: move <person> on <cell> [in <line>] [to <cell> [in <line>]] [on <day>] [from <time> to <time> [on <day>]]";
/** S41-a: RB1's sentence -- book, no run in the way, on/in/from 6 to 2. */
const BOOK_SENTENCE = "book Housing A on Cell 1 in Line 1 from 6 to 2";
/** S41-b: RU1's sentence -- names BLK1 exactly. */
const UNASSIGN_SENTENCE = "Unassign Operator 1 from Cell 1 in Line 1 from 10 to 2";
/** S41-b: no hours -- the whole day, RU3's shape with two blocks present. */
const UNASSIGN_WHOLE_DAY_SENTENCE = "Unassign Operator 1 from Cell 1 in Line 1";
/** S41-c: RM2's sentence -- names BLK1, moves it to Cell 2 with its own hours. */
const MOVE_SENTENCE = "Move Operator 1 on Cell 1 in Line 1 to Cell 2";
/** S41-c: RM1's shape -- a move in time only (no destination cell). */
const MOVE_RETIME_SENTENCE = "Move Operator 1 on Cell 1 in Line 1 to 10 to 3";
/** S41-b: RU3's second block, right after BLK1. */
const BLK2: ContextAssignment = {
  ...BLK1,
  id: "blk2",
  startMin: 3 * 1440 + 840,
  endMin: 3 * 1440 + 960,
  label: "14:00–16:00",
};

function renderBar(over: Partial<ResolveContext> = {}) {
  const onOpen = vi.fn();
  const onRetime = vi.fn();
  const onBook = vi.fn();
  const onRetimeRun = vi.fn();
  const onUnassign = vi.fn();
  const onMove = vi.fn();
  render(
    <CommandBar
      ctx={buildCtx(over)}
      dateFormat="d_mon_yyyy"
      zone="UTC"
      onOpen={onOpen}
      onRetime={onRetime}
      onBook={onBook}
      onRetimeRun={onRetimeRun}
      onUnassign={onUnassign}
      onMove={onMove}
    />,
  );
  const input = screen.getByRole("textbox", { name: "Tell the board" }) as HTMLInputElement;
  return { onOpen, onRetime, onBook, onRetimeRun, onUnassign, onMove, input };
}

/** The one `aria-live="polite"` status element (brief §6). */
function statusText(): string {
  return document.querySelector('[aria-live="polite"]')?.textContent ?? "";
}

describe("CommandBar (P1-7a, brief §9)", () => {
  it("C1: the input has the accessible name 'Tell the board' and the example placeholder", () => {
    const { input } = renderBar();
    expect(input.placeholder).toBe("Assign Sam to Housing A on Cell 1 in Line 1 from 10 to 2");
  });

  it("C2: a resolvable sentence opens the popover and shows the readout with the day rendered", () => {
    const { onOpen, input } = renderBar({ runs: [] });

    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onOpen).toHaveBeenCalledTimes(1);
    const [resolved] = onOpen.mock.calls[0] as [ResolvedCommand, { x: number; y: number }];
    expect(resolved.nodeId).toBe("c1a");
    expect(resolved.operatorId).toBe("op1");
    expect(resolved.target).toEqual({ kind: "direct", productId: "ha" });
    expect(resolved.range).toEqual({ startMin: 3 * 1440 + 600, endMin: 3 * 1440 + 840 });

    const dayLabel = formatDayLabel(new Date("2026-09-03T00:00:00Z"), "d_mon_yyyy", "UTC");
    const status = statusText();
    expect(status).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(status).toContain(dayLabel);
    expect(status).toBe(
      `Operator 1 → Housing A · Plant 1 › Assembly › Line 1 › Cell 1 · ${dayLabel} · 10:00–14:00`,
    );
  });

  it("C3: an ambiguous operator shows the question and both candidates, and opens nothing", () => {
    const { onOpen, input } = renderBar();

    fireEvent.change(input, {
      target: { value: "assign Sam to Housing A on Cell 1 in Line 1 from 10 to 2" },
    });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toBe('Which person? "Sam" matches 2:');
    expect(screen.getByRole("button", { name: "Sam Patel" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sam Ortiz" })).toBeTruthy();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("C4: clicking a candidate rewrites the input and resolves the chosen person", () => {
    const { onOpen, input } = renderBar();
    fireEvent.change(input, {
      target: { value: "assign Sam to Housing A on Cell 1 in Line 1 from 10 to 2" },
    });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Sam Patel" }));

    const expectedCommand: AssignCommand = {
      intent: "assign",
      operator: "Sam Patel",
      product: "Housing A",
      place: ["Cell 1", "Line 1"],
      day: null,
      start: { hour: 10, minute: 0 },
      end: { hour: 14, minute: 0 },
      attach: null,
      existing: null,
    };
    expect(input.value).toBe(formatCommand(expectedCommand));
    expect(onOpen).toHaveBeenCalledTimes(1);
    const [resolved] = onOpen.mock.calls[0] as [ResolvedCommand, { x: number; y: number }];
    expect(resolved.operatorId).toBe("sp");
  });

  it("C5: an empty Enter shows the expected shape and calls nothing", () => {
    const { onOpen, input } = renderBar();

    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toBe(SHAPE);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("C6: a bad time shows 'I could not read \"10:75\".' before the shape", () => {
    const { input } = renderBar();

    fireEvent.change(input, {
      target: { value: "assign Sam to Housing A on Cell 1 from 10:75 to 2" },
    });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toBe(`I could not read "10:75". ${SHAPE}`);
  });

  it("C7: Escape once clears the status line and keeps the input; Escape twice clears the input", () => {
    const { input } = renderBar();

    fireEvent.change(input, { target: { value: "gibberish" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(statusText()).toBe(SHAPE);
    expect(input.value).toBe("gibberish");

    fireEvent.keyDown(input, { key: "Escape" });
    expect(statusText()).toBe("");
    expect(input.value).toBe("gibberish");

    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("");
  });

  it("C8: onOpen's anchor is the input's bounding-rect bottom-left", () => {
    const { onOpen, input } = renderBar();
    input.getBoundingClientRect = () =>
      ({ left: 123, bottom: 456, top: 0, right: 0, width: 0, height: 0 }) as DOMRect;

    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onOpen).toHaveBeenCalledTimes(1);
    const [, anchor] = onOpen.mock.calls[0] as [ResolvedCommand, { x: number; y: number }];
    expect(anchor).toEqual({ x: 123, y: 456 });
  });

  it("C9: a span landing inside an existing run asks to join it, verbatim, with both buttons", () => {
    const { onOpen, input } = renderBar({ runs: [RUN1] });

    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toBe(
      "A Housing A job is already booked on Cell 1, Housing A 08:00–16:00. Join it, or make a separate block?",
    );
    expect(screen.getByRole("button", { name: "Housing A 08:00–16:00" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Separate block" })).toBeTruthy();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("C10: joining the run sends the run target, unchanged input; Separate block sends direct", () => {
    const { onOpen, input } = renderBar({ runs: [RUN1] });
    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Housing A 08:00–16:00" }));

    expect(input.value).toBe(P1_SENTENCE);
    expect(onOpen).toHaveBeenCalledTimes(1);
    const [resolved] = onOpen.mock.calls[0] as [ResolvedCommand, { x: number; y: number }];
    expect(resolved.target).toEqual({ kind: "run", runId: "run1" });
    expect(resolved.readout.endsWith("· joining Housing A 08:00–16:00")).toBe(true);

    cleanup();
    const second = renderBar({ runs: [RUN1] });
    fireEvent.change(second.input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(second.input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Separate block" }));

    expect(second.onOpen).toHaveBeenCalledTimes(1);
    const [resolvedDirect] = second.onOpen.mock.calls[0] as [
      ResolvedCommand,
      { x: number; y: number },
    ];
    expect(resolvedDirect.target).toEqual({ kind: "direct", productId: "ha" });
  });

  it("C11: a sentence re-timing the person's own block shows the question and both buttons", () => {
    const { onOpen, onRetime, input } = renderBar({ assignments: [BLK1] });

    fireEvent.change(input, { target: { value: P1_RETIME_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toBe(
      "Operator 1 is already on Housing A at Cell 1 10:00–14:00. Change it to 10:00–15:00, or add a separate block?",
    );
    expect(screen.getByRole("button", { name: "Change 10:00–14:00" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Separate block" })).toBeTruthy();
    expect(onOpen).not.toHaveBeenCalled();
    expect(onRetime).not.toHaveBeenCalled();
  });

  it("C12: pressing Change re-times the block through onRetime, input unchanged, readout says changing", () => {
    const { onOpen, onRetime, input } = renderBar({ assignments: [BLK1] });
    fireEvent.change(input, { target: { value: P1_RETIME_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Change 10:00–14:00" }));

    expect(input.value).toBe(P1_RETIME_SENTENCE);
    expect(onOpen).not.toHaveBeenCalled();
    expect(onRetime).toHaveBeenCalledTimes(1);
    const [resolved] = onRetime.mock.calls[0] as [ResolvedCommand, { x: number; y: number }];
    expect(resolved.target).toEqual({ kind: "retime", assignmentId: "blk1" });
    expect(resolved.range).toEqual({ startMin: 3 * 1440 + 600, endMin: 3 * 1440 + 900 });
    expect(statusText()).toContain("· changing 10:00–14:00");
  });

  it("C13: Separate block sends direct; with a run also present it asks the run question instead", () => {
    const { onOpen, onRetime, input } = renderBar({ assignments: [BLK1] });
    fireEvent.change(input, { target: { value: P1_RETIME_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Separate block" }));

    expect(onRetime).not.toHaveBeenCalled();
    expect(onOpen).toHaveBeenCalledTimes(1);
    const [resolved] = onOpen.mock.calls[0] as [ResolvedCommand, { x: number; y: number }];
    expect(resolved.target).toEqual({ kind: "direct", productId: "ha" });

    cleanup();
    const second = renderBar({ assignments: [BLK1], runs: [RUN1] });
    fireEvent.change(second.input, { target: { value: P1_RETIME_SENTENCE } });
    fireEvent.keyDown(second.input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Separate block" }));

    expect(statusText()).toBe(
      "A Housing A job is already booked on Cell 1, Housing A 08:00–16:00. Join it, or make a separate block?",
    );
    fireEvent.click(screen.getByRole("button", { name: "Housing A 08:00–16:00" }));
    expect(second.onOpen).toHaveBeenCalledTimes(1);
    const [resolvedRun] = second.onOpen.mock.calls[0] as [
      ResolvedCommand,
      { x: number; y: number },
    ];
    expect(resolvedRun.target).toEqual({ kind: "run", runId: "run1" });
  });

  it("C14: the same-span sentence shows R35's text and ONLY the Separate block button", () => {
    const { onOpen, onRetime, input } = renderBar({ assignments: [BLK1] });
    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toBe(
      "Operator 1 is already on Housing A at Cell 1 10:00–14:00 — nothing to change. Add a separate block?",
    );
    expect(screen.getByRole("button", { name: "Separate block" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Change /i })).toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
    expect(onRetime).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // S41-a: "book a job" (CB1-CB4), brief s41-a-book-a-job-brief.md §5.
  // -------------------------------------------------------------------------

  it("CB1: a book sentence with nothing in the way calls onBook once, readout shown", () => {
    const { onBook, onRetimeRun, input } = renderBar({ runs: [] });

    fireEvent.change(input, { target: { value: BOOK_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onBook).toHaveBeenCalledTimes(1);
    const [resolved, anchor] = onBook.mock.calls[0] as [ResolvedBook, { x: number; y: number }];
    expect(resolved.nodeId).toBe("c1a");
    expect(resolved.productId).toBe("ha");
    expect(resolved.target).toEqual({ kind: "run_create", productId: "ha", headcount: null });
    expect(resolved.range).toEqual({ startMin: 3 * 1440 + 360, endMin: 3 * 1440 + 840 });
    expect(anchor).toBeTruthy();
    expect(onRetimeRun).not.toHaveBeenCalled();

    const dayLabel = formatDayLabel(new Date("2026-09-03T00:00:00Z"), "d_mon_yyyy", "UTC");
    expect(statusText()).toBe(
      `Housing A · Plant 1 › Assembly › Line 1 › Cell 1 · ${dayLabel} · 06:00–14:00`,
    );
  });

  it("CB2: a job of the same part in the way asks to change it; Change calls onRetimeRun", () => {
    const { onBook, onRetimeRun, input } = renderBar({ runs: [JOB1] });

    fireEvent.change(input, { target: { value: BOOK_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toBe(
      "A Housing A job is already booked on Cell 1 08:00–16:00. Change it to 06:00–14:00, or pick other hours?",
    );
    expect(screen.getByRole("button", { name: "Change 08:00–16:00" })).toBeTruthy();
    expect(onBook).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Change 08:00–16:00" }));

    expect(input.value).toBe(BOOK_SENTENCE);
    expect(onRetimeRun).toHaveBeenCalledTimes(1);
    const [resolved] = onRetimeRun.mock.calls[0] as [ResolvedBook, { x: number; y: number }];
    expect(resolved.target).toEqual({ kind: "retime_run", runId: "run1" });
  });

  it("CB3: a job of another part in the way shows no buttons and calls nothing", () => {
    const { onBook, onRetimeRun, input } = renderBar({ runs: [JOB_COV] });

    fireEvent.change(input, { target: { value: BOOK_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toBe(
      "Cell 1 already runs Cover 08:00–16:00; a cell runs one job at a time. Pick other hours, or change that job on the board.",
    );
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(onBook).not.toHaveBeenCalled();
    expect(onRetimeRun).not.toHaveBeenCalled();
  });

  it("CB4: job_gone shows 'Book it', which re-runs as a fresh sentence (calls onBook)", () => {
    // A mutable array so the SAME `ctx` object can be made to reflect the
    // job vanishing between the question and the click (a background
    // refetch), without re-rendering `CommandBar` with a new `ctx` prop.
    const runsRef: ContextRun[] = [JOB1];
    const { onBook, onRetimeRun, input } = renderBar({ runs: runsRef });

    fireEvent.change(input, { target: { value: BOOK_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("button", { name: "Change 08:00–16:00" })).toBeTruthy();

    runsRef.length = 0;

    fireEvent.click(screen.getByRole("button", { name: "Change 08:00–16:00" }));
    expect(statusText()).toBe(
      "That Housing A job on Cell 1 is no longer on the board. Book it again?",
    );
    expect(onRetimeRun).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Book it" }));
    expect(onBook).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // S41-b: "unassign" (CU1-CU4), brief s41-b-unassign-brief.md §5.
  // -------------------------------------------------------------------------

  it("CU1: naming BLK1 exactly shows RU1's text and one 'Remove it' button, calls nothing", () => {
    const { onOpen, onRetime, onBook, onRetimeRun, onUnassign, input } = renderBar({
      assignments: [BLK1],
    });

    fireEvent.change(input, { target: { value: UNASSIGN_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toBe("Remove Operator 1's Housing A block on Cell 1, 10:00–14:00?");
    expect(screen.getByRole("button", { name: "Remove it" })).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(1);
    expect(onOpen).not.toHaveBeenCalled();
    expect(onRetime).not.toHaveBeenCalled();
    expect(onBook).not.toHaveBeenCalled();
    expect(onRetimeRun).not.toHaveBeenCalled();
    expect(onUnassign).not.toHaveBeenCalled();
  });

  it("CU2: pressing Remove it calls onUnassign once with blk1, input unchanged, readout shown", () => {
    const { onUnassign, input } = renderBar({ assignments: [BLK1] });
    fireEvent.change(input, { target: { value: UNASSIGN_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));

    expect(input.value).toBe(UNASSIGN_SENTENCE);
    expect(onUnassign).toHaveBeenCalledTimes(1);
    const [resolved] = onUnassign.mock.calls[0] as [ResolvedUnassign, { x: number; y: number }];
    expect(resolved.assignmentId).toBe("blk1");
    expect(statusText()).toBe(
      "Removing Operator 1's Housing A block · Plant 1 › Assembly › Line 1 › Cell 1 · " +
        formatDayLabel(new Date("2026-09-03T00:00:00Z"), "d_mon_yyyy", "UTC") +
        " · 10:00–14:00",
    );
  });

  it("CU3: a no-hours sentence with two blocks shows two buttons labelled with part and hours", () => {
    const { onUnassign, input } = renderBar({ assignments: [BLK1, BLK2] });
    fireEvent.change(input, { target: { value: UNASSIGN_WHOLE_DAY_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.getByRole("button", { name: "Remove Housing A 10:00–14:00" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove Housing A 14:00–16:00" })).toBeTruthy();
    expect(onUnassign).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Remove Housing A 14:00–16:00" }));
    expect(onUnassign).toHaveBeenCalledTimes(1);
    const [resolved] = onUnassign.mock.calls[0] as [ResolvedUnassign, { x: number; y: number }];
    expect(resolved.assignmentId).toBe("blk2");
  });

  it("CU4: the ISO day in a question is rendered through formatDayLabel, never raw", () => {
    const { input } = renderBar({ assignments: [] });
    fireEvent.change(input, { target: { value: UNASSIGN_WHOLE_DAY_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    const dayLabel = formatDayLabel(new Date("2026-09-03T00:00:00Z"), "d_mon_yyyy", "UTC");
    const status = statusText();
    expect(status).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(status).toBe(`Operator 1 has no block on Cell 1 ${dayLabel}.`);
  });

  // -------------------------------------------------------------------------
  // S41-c: "move" (CM1-CM3), brief s41-c-move-brief.md §5.
  // -------------------------------------------------------------------------

  it("CM1: naming BLK1 with a destination cell calls onMove once (move_cell), input unchanged, readout shown; nothing else called", () => {
    const { onOpen, onRetime, onBook, onRetimeRun, onUnassign, onMove, input } = renderBar({
      assignments: [BLK1],
    });

    fireEvent.change(input, { target: { value: MOVE_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(input.value).toBe(MOVE_SENTENCE);
    expect(onMove).toHaveBeenCalledTimes(1);
    const [resolved] = onMove.mock.calls[0] as [ResolvedMove, { x: number; y: number }];
    expect(resolved.assignmentId).toBe("blk1");
    expect(resolved.target).toEqual({ kind: "move_cell" });
    expect(statusText()).toBe(
      "Moving Operator 1's Housing A block · Plant 1 › Assembly › Line 1 › Cell 1 · " +
        formatDayLabel(new Date("2026-09-03T00:00:00Z"), "d_mon_yyyy", "UTC") +
        " · 10:00–14:00 → Cell 2 · 10:00–14:00",
    );
    expect(onOpen).not.toHaveBeenCalled();
    expect(onRetime).not.toHaveBeenCalled();
    expect(onBook).not.toHaveBeenCalled();
    expect(onRetimeRun).not.toHaveBeenCalled();
    expect(onUnassign).not.toHaveBeenCalled();
  });

  it("CM2: a move-in-time-only sentence calls onMove once with a retime target -- never onRetime (that callback is the assign path's own)", () => {
    const { onOpen, onRetime, onMove, input } = renderBar({ assignments: [BLK1] });

    fireEvent.change(input, { target: { value: MOVE_RETIME_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onMove).toHaveBeenCalledTimes(1);
    const [resolved] = onMove.mock.calls[0] as [ResolvedMove, { x: number; y: number }];
    expect(resolved.assignmentId).toBe("blk1");
    expect(resolved.target).toEqual({ kind: "retime" });
    expect(resolved.range).toEqual({ startMin: 3 * 1440 + 600, endMin: 3 * 1440 + 900 });
    expect(onOpen).not.toHaveBeenCalled();
    expect(onRetime).not.toHaveBeenCalled();
  });

  it("CM3: two blocks show 'Move <part> <hours>' buttons; pressing one calls onMove once with the picked block", () => {
    const { onMove, input } = renderBar({ assignments: [BLK1, BLK2] });
    fireEvent.change(input, { target: { value: MOVE_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.getByRole("button", { name: "Move Housing A 10:00–14:00" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Move Housing A 14:00–16:00" })).toBeTruthy();
    expect(onMove).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Move Housing A 14:00–16:00" }));
    expect(onMove).toHaveBeenCalledTimes(1);
    const [resolved] = onMove.mock.calls[0] as [ResolvedMove, { x: number; y: number }];
    expect(resolved.assignmentId).toBe("blk2");
  });

  // -------------------------------------------------------------------------
  // F-133: the day word after the hours (C15), brief
  // f-133-day-word-after-the-hours-brief.md §4.
  // -------------------------------------------------------------------------

  it("C15: a two-days sentence renders 'I read two days...' verbatim and calls nothing", () => {
    const { onOpen, onRetime, onBook, onRetimeRun, onUnassign, onMove, input } = renderBar();

    fireEvent.change(input, {
      target: {
        value: "assign Sam to Housing A on Cell 1 on Monday from 10 to 2 on Saturday",
      },
    });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toBe('I read two days, "Monday" and "Saturday". Say one.');
    expect(onOpen).not.toHaveBeenCalled();
    expect(onRetime).not.toHaveBeenCalled();
    expect(onBook).not.toHaveBeenCalled();
    expect(onRetimeRun).not.toHaveBeenCalled();
    expect(onUnassign).not.toHaveBeenCalled();
    expect(onMove).not.toHaveBeenCalled();
  });
});
