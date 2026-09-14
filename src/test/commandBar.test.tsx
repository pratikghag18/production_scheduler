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
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { formatDayLabel } from "@/features/board/lib/time";
import {
  formatCommand,
  parseCommand,
  type AssignCommand,
  type UnassignCommand,
  type MoveCommand,
} from "@/lib/command/parse";
import type {
  ResolveContext,
  ResolvedCommand,
  ResolvedBook,
  ResolvedUnassign,
  ResolvedMove,
  ContextRun,
  ContextAssignment,
} from "@/lib/command/resolve";
import {
  CommandBar,
  type ConfirmWordResult,
  type ResolvedAny,
  type LotResult,
} from "@/features/board/components/CommandBar";
import type { Reader, Reading } from "@/lib/voice/readSentence";
import type { Recognizer, RecognizerEvents } from "@/lib/voice/recognizer";

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
    shiftsAt: () => [],
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

/** S49: BLK1's same hours, but on Cell 2 (c2) instead of Cell 1 (c1a) --
 *  UNASSIGN_SENTENCE/MOVE_RETIME_SENTENCE both name Cell 1 in Line 1 (c1a),
 *  so this block is "elsewhere". */
const BLK_C2: ContextAssignment = { ...BLK1, id: "blkC2", nodeId: "c2" };
/** S49: BLK1's same hours, on the OTHER "Cell 1" (Line 3, c1b) -- same name
 *  as the sentence's named cell, a different node. */
const BLK_C1B: ContextAssignment = { ...BLK1, id: "blkC1b", nodeId: "c1b" };

/** S51: BLK1's same cell and hours, but Sam Patel's block instead of
 *  Operator 1's -- the several-lot fixtures' second person. */
const BLK_SP: ContextAssignment = { ...BLK1, id: "blkSp", operatorId: "sp" };

/** S51: "assign A2 and A3 ..." shape -- two removals in one sentence,
 *  Operator 1 and Sam Patel, both from Cell 1 in Line 1, 10 to 2. */
const LOT_REMOVE_SENTENCE = "Unassign Operator 1 and Sam Patel from Cell 1 in Line 1 from 10 to 2";
/** S51: the same two people, no hours -- the whole day (CU3's shape),
 *  used where a command needs more than one candidate to ask about. */
const LOT_REMOVE_WHOLE_DAY_SENTENCE = "Unassign Operator 1 and Sam Patel from Cell 1 in Line 1";

/** S44-b: `reader` defaults to `null` -- every pre-S44-b call site (one
 *  argument only) is unaffected; the CB-model describe block below is the
 *  only caller that passes a second argument. S46-a widens this with a
 *  third, also defaulted, argument the same way -- every earlier call site
 *  (one or two arguments) is unaffected. S47 widens it again with a fourth,
 *  optional, options object -- `onHighlight` is always a fresh `vi.fn()`
 *  (a plain callback prop here has no case that needs a caller-supplied
 *  one; every test reads it off the returned spy instead) and
 *  `onConfirmWord`/`onCancelWord` default to `undefined` (CommandBar's own
 *  default), so every pre-S47 call site (up to three positional arguments)
 *  is unaffected either way. */
function renderBar(
  over: Partial<ResolveContext> = {},
  reader: Reader | null = null,
  recognizer: Recognizer | null = null,
  s47: {
    onConfirmWord?: () => ConfirmWordResult;
    onCancelWord?: () => boolean;
  } = {},
  // S51: `onRunLot` defaults to a no-op that never resolves, since almost
  // every case in this file never triggers a lot at all -- CB-lot's own
  // tests pass a real mock through this.
  s51: { onRunLot?: (resolved: ResolvedAny[]) => Promise<LotResult> } = {},
) {
  const onOpen = vi.fn();
  const onRetime = vi.fn();
  const onBook = vi.fn();
  const onRetimeRun = vi.fn();
  const onUnassign = vi.fn();
  const onMove = vi.fn();
  const onHighlight = vi.fn();
  const onRunLot = vi.fn(s51.onRunLot ?? (() => new Promise<LotResult>(() => {})));
  render(
    <CommandBar
      ctx={buildCtx(over)}
      dateFormat="d_mon_yyyy"
      zone="UTC"
      reader={reader}
      recognizer={recognizer}
      onOpen={onOpen}
      onRetime={onRetime}
      onBook={onBook}
      onRetimeRun={onRetimeRun}
      onUnassign={onUnassign}
      onMove={onMove}
      onRunLot={onRunLot}
      onHighlight={onHighlight}
      onConfirmWord={s47.onConfirmWord}
      onCancelWord={s47.onCancelWord}
    />,
  );
  const input = screen.getByRole("textbox", { name: "Tell the board" }) as HTMLInputElement;
  return {
    onOpen,
    onRetime,
    onBook,
    onRetimeRun,
    onUnassign,
    onMove,
    onRunLot,
    onHighlight,
    input,
  };
}

/** S46-a: a fake recogniser (brief §2.4) -- records the `RecognizerEvents`
 *  object the bar hands it and returns a handle with a `stop` spy. `fire`
 *  lets a test drive the captured events without reaching into internals. */
function makeFakeRecognizer() {
  const stop = vi.fn();
  let captured: RecognizerEvents | null = null;
  const recognizer: Recognizer = (events) => {
    captured = events;
    return { stop };
  };
  return {
    recognizer,
    stop,
    fire: {
      interim(text: string): void {
        act(() => captured?.onInterim(text));
      },
      final(text: string): void {
        act(() => captured?.onFinal(text));
      },
      error(kind: "not-allowed" | "no-speech" | "other", detail?: string): void {
        act(() => captured?.onError(kind, detail));
      },
      end(): void {
        act(() => captured?.onEnd());
      },
    },
  };
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
      shift: null,
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

    // S47 / R-395: one candidate ("Separate block") -- the message now
    // gains the yes/no suffix (CB-yes-1's rule applies to block_exists too).
    expect(statusText()).toBe(
      "Operator 1 is already on Housing A at Cell 1 10:00–14:00 — nothing to change. Add a separate block?" +
        " — say or type yes to do it, no to leave it.",
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

    // S47 / R-395: one candidate ("Remove it") -- the message now gains the
    // yes/no suffix (CB-yes-1).
    expect(statusText()).toBe(
      "Remove Operator 1's Housing A block on Cell 1, 10:00–14:00?" +
        " — say or type yes to do it, no to leave it.",
    );
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

// -----------------------------------------------------------------------
// S47 / R-395: the outline and the spoken yes (brief
// docs/agent-briefs/s47-a-outline-and-yes-brief.md). `onHighlight` is the
// bar telling the board what a remove/move/retime question is about; a
// confirm/cancel word is `submitText`'s own shortcut around that same
// question BEFORE parsing, and, with none standing, around
// `onConfirmWord`/`onCancelWord` (R-384's pop-up).
// -----------------------------------------------------------------------

describe("CB-yes: the outline and the spoken yes (S47, R-395)", () => {
  it("CB-yes-1: a remove sentence with one matching block highlights it and the message gains the yes suffix", () => {
    const { input, onHighlight } = renderBar({ assignments: [BLK1] });

    fireEvent.change(input, { target: { value: UNASSIGN_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onHighlight).toHaveBeenLastCalledWith({ kind: "remove", assignmentIds: ["blk1"] });
    expect(statusText()).toBe(
      "Remove Operator 1's Housing A block on Cell 1, 10:00–14:00? — say or type yes to do it, no to leave it.",
    );
  });

  it("CB-yes-2: typing yes + Enter calls onUnassign with that block and clears the highlight", () => {
    const { input, onUnassign, onHighlight } = renderBar({ assignments: [BLK1] });
    fireEvent.change(input, { target: { value: UNASSIGN_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    fireEvent.change(input, { target: { value: "yes" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onUnassign).toHaveBeenCalledTimes(1);
    const [resolved] = onUnassign.mock.calls[0] as [ResolvedUnassign, { x: number; y: number }];
    expect(resolved.assignmentId).toBe("blk1");
    expect(onHighlight).toHaveBeenLastCalledWith(null);
  });

  it("CB-yes-3: no clears the status, the outline and the input; onUnassign is never called", () => {
    const { input, onUnassign, onHighlight } = renderBar({ assignments: [BLK1] });
    fireEvent.change(input, { target: { value: UNASSIGN_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    fireEvent.change(input, { target: { value: "no" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onUnassign).not.toHaveBeenCalled();
    expect(statusText()).toBe("");
    expect(input.value).toBe("");
    expect(onHighlight).toHaveBeenLastCalledWith(null);
  });

  it("CB-yes-4: two matching blocks highlight both with no suffix; a bare yes asks which one and writes nothing", () => {
    const { input, onUnassign, onHighlight } = renderBar({ assignments: [BLK1, BLK2] });
    fireEvent.change(input, { target: { value: UNASSIGN_WHOLE_DAY_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onHighlight).toHaveBeenLastCalledWith({
      kind: "remove",
      assignmentIds: ["blk1", "blk2"],
    });
    expect(statusText()).not.toMatch(/say or type yes/);

    fireEvent.change(input, { target: { value: "yes" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toBe(
      "Which one? Remove Housing A 10:00–14:00, Remove Housing A 14:00–16:00",
    );
    expect(onUnassign).not.toHaveBeenCalled();
  });

  it("CB-yes-5: a spoken final result 'yes' confirms exactly like typing", () => {
    // The sentence is typed; "yes" is spoken as its OWN session (the browser
    // recogniser ends a session after one final result -- `recognizer.ts`'s
    // `continuous = false` -- so a second word always takes a second press).
    // The press itself must not erase the standing question -- see
    // `startListening`'s S47 comment.
    const { recognizer, fire } = makeFakeRecognizer();
    const { input, onUnassign } = renderBar({ assignments: [BLK1] }, null, recognizer);
    fireEvent.change(input, { target: { value: UNASSIGN_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    fireEvent.click(screen.getByRole("button", { name: "Speak a sentence" }));
    fire.final("yes");

    expect(onUnassign).toHaveBeenCalledTimes(1);
    const [resolved] = onUnassign.mock.calls[0] as [ResolvedUnassign, { x: number; y: number }];
    expect(resolved.assignmentId).toBe("blk1");
  });

  it("CB-yes-6: Escape clears the highlight", () => {
    const { input, onHighlight } = renderBar({ assignments: [BLK1] });
    fireEvent.change(input, { target: { value: UNASSIGN_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    fireEvent.keyDown(input, { key: "Escape" });

    expect(statusText()).toBe("");
    expect(onHighlight).toHaveBeenLastCalledWith(null);
  });

  it("CB-yes-7: a new sentence replaces the highlight with the new one", () => {
    const { input, onHighlight } = renderBar({ assignments: [BLK1, BLK2] });
    fireEvent.change(input, { target: { value: UNASSIGN_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onHighlight).toHaveBeenLastCalledWith({ kind: "remove", assignmentIds: ["blk1"] });

    fireEvent.change(input, { target: { value: MOVE_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onHighlight).toHaveBeenLastCalledWith({
      kind: "move",
      assignmentIds: ["blk1", "blk2"],
    });
  });

  it("CB-yes-8: yes with no question defers to onConfirmWord -- 'none' falls to the rules, 'created' clears the input", () => {
    const onConfirmWordNone = vi.fn((): ConfirmWordResult => "none");
    const { input } = renderBar({}, null, null, { onConfirmWord: onConfirmWordNone });

    fireEvent.change(input, { target: { value: "yes" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onConfirmWordNone).toHaveBeenCalledTimes(1);
    expect(statusText()).toBe(SHAPE);
    expect(input.value).toBe("yes");

    cleanup();
    const onConfirmWordCreated = vi.fn((): ConfirmWordResult => "created");
    const second = renderBar({}, null, null, { onConfirmWord: onConfirmWordCreated });

    fireEvent.change(second.input, { target: { value: "yes" } });
    fireEvent.keyDown(second.input, { key: "Enter" });

    expect(onConfirmWordCreated).toHaveBeenCalledTimes(1);
    expect(second.input.value).toBe("");
  });

  it("CB-yes-9: a move sentence highlights both candidates as kind move; picking one (after a bare yes asks which) reaches onMove", () => {
    const { input, onMove, onHighlight } = renderBar({ assignments: [BLK1, BLK2] });
    fireEvent.change(input, { target: { value: MOVE_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onHighlight).toHaveBeenLastCalledWith({
      kind: "move",
      assignmentIds: ["blk1", "blk2"],
    });

    fireEvent.change(input, { target: { value: "yes" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onMove).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Move Housing A 14:00–16:00" }));

    expect(onMove).toHaveBeenCalledTimes(1);
    const [resolved] = onMove.mock.calls[0] as [ResolvedMove, { x: number; y: number }];
    expect(resolved.assignmentId).toBe("blk2");
    expect(onHighlight).toHaveBeenLastCalledWith(null);
  });

  it("CB-yes-10: a typed edit while a block question stands clears the question, the outline and the stale button", () => {
    const { input, onUnassign, onHighlight } = renderBar({ assignments: [BLK1] });
    fireEvent.change(input, { target: { value: UNASSIGN_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("button", { name: "Remove it" })).toBeTruthy();

    fireEvent.change(input, { target: { value: `${UNASSIGN_SENTENCE}x` } });

    expect(statusText()).toBe("");
    expect(screen.queryByRole("button", { name: "Remove it" })).toBeNull();
    expect(onHighlight).toHaveBeenLastCalledWith(null);

    // The stale button is really gone, not just hidden -- confirm words
    // now go to the ordinary path (the sentence-plus-"x" makes "yes" alone
    // moot here, so this instead proves nothing is bound to click any more:
    // there is no button left to click).
    expect(onUnassign).not.toHaveBeenCalled();
  });

  it("CB-yes-11: an interim speech result leaves a standing block question (and its highlight) alone; a final 'yes' then confirms", () => {
    const { recognizer, fire } = makeFakeRecognizer();
    const { input, onUnassign, onHighlight } = renderBar({ assignments: [BLK1] }, null, recognizer);
    fireEvent.change(input, { target: { value: UNASSIGN_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    onHighlight.mockClear();

    // A fresh mic press preserves the standing question (see
    // `startListening`'s S47 comment) -- an interim result must not undo
    // that just because the input's text now reads "ye".
    fireEvent.click(screen.getByRole("button", { name: "Speak a sentence" }));
    fire.interim("ye");

    expect(screen.getByRole("button", { name: "Remove it" })).toBeTruthy();
    expect(statusText().endsWith(" — say or type yes to do it, no to leave it.")).toBe(true);
    expect(onHighlight).not.toHaveBeenCalled();

    fire.final("yes");

    expect(onUnassign).toHaveBeenCalledTimes(1);
    const [resolved] = onUnassign.mock.calls[0] as [ResolvedUnassign, { x: number; y: number }];
    expect(resolved.assignmentId).toBe("blk1");
  });

  it('CB-yes-12: "remove it" does not confirm a standing MOVE question -- answered in place, the question stands; "move it" does', () => {
    // move_which is never asked for exactly one block (CM3's own comment:
    // "a move takes it without asking" -- resolve.ts's `resolveMoveCommand`
    // only ever calls `askMoveWhich` when more than one block matches), so
    // the smallest standing "move" question has two candidates. That is
    // enough to prove the kind gate at the point it actually acts: a
    // mismatched word is answered IN PLACE (S50 fix, CB-yes-12: it is never
    // a sentence, so it must never reach the rules parser -- the question,
    // its outline and its buttons all stand, only the message changes),
    // while a matching one is accepted as a confirm and reaches `onMove`,
    // same as any other confirm word would.
    const { input, onMove, onHighlight } = renderBar({ assignments: [BLK1, BLK2] });
    fireEvent.change(input, { target: { value: MOVE_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onHighlight).toHaveBeenLastCalledWith({
      kind: "move",
      assignmentIds: ["blk1", "blk2"],
    });

    fireEvent.change(input, { target: { value: "remove it" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onMove).not.toHaveBeenCalled();
    expect(statusText()).toBe('That question is about a move; say "move it", yes, or no.');
    // The outline is still standing -- the last highlight call is still the
    // move's, not cleared to null -- and the buttons are still there.
    expect(onHighlight).toHaveBeenLastCalledWith({
      kind: "move",
      assignmentIds: ["blk1", "blk2"],
    });
    expect(screen.getByRole("button", { name: "Move Housing A 10:00–14:00" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Move Housing A 14:00–16:00" })).toBeTruthy();

    fireEvent.change(input, { target: { value: MOVE_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: "move it" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toBe("Which one? Move Housing A 10:00–14:00, Move Housing A 14:00–16:00");
    fireEvent.click(screen.getByRole("button", { name: "Move Housing A 10:00–14:00" }));

    expect(onMove).toHaveBeenCalledTimes(1);
    const [resolved] = onMove.mock.calls[0] as [ResolvedMove, { x: number; y: number }];
    expect(resolved.assignmentId).toBe("blk1");
  });

  it('CB-yes-12b: the symmetric case -- "move it" does not confirm a standing REMOVAL question, answered in place', () => {
    const { input, onUnassign, onHighlight } = renderBar({ assignments: [BLK1] });
    fireEvent.change(input, { target: { value: UNASSIGN_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onHighlight).toHaveBeenLastCalledWith({ kind: "remove", assignmentIds: ["blk1"] });

    fireEvent.change(input, { target: { value: "move it" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onUnassign).not.toHaveBeenCalled();
    expect(statusText()).toBe('That question is about a removal; say "remove it", yes, or no.');
    expect(onHighlight).toHaveBeenLastCalledWith({ kind: "remove", assignmentIds: ["blk1"] });
    expect(screen.getByRole("button", { name: "Remove it" })).toBeTruthy();
  });

  it('CB-yes-12c: "remove it" does not confirm a standing RETIME (block_exists) question, answered with the move message', () => {
    const { input, onRetime, onHighlight } = renderBar({ assignments: [BLK1] });
    fireEvent.change(input, { target: { value: P1_RETIME_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onHighlight).toHaveBeenLastCalledWith({ kind: "retime", assignmentIds: ["blk1"] });

    fireEvent.change(input, { target: { value: "remove it" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onRetime).not.toHaveBeenCalled();
    expect(statusText()).toBe('That question is about a move; say "move it", yes, or no.');
    expect(onHighlight).toHaveBeenLastCalledWith({ kind: "retime", assignmentIds: ["blk1"] });
    expect(screen.getByRole("button", { name: "Change 10:00–14:00" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Separate block" })).toBeTruthy();
  });

  it("CB-yes-13: onConfirmWord's three results -- 'created' clears the input, 'needs-decision' shows the message and keeps the input, 'none' goes to the rules", () => {
    const created = vi.fn((): ConfirmWordResult => "created");
    const first = renderBar({}, null, null, { onConfirmWord: created });
    fireEvent.change(first.input, { target: { value: "yes" } });
    fireEvent.keyDown(first.input, { key: "Enter" });
    expect(created).toHaveBeenCalledTimes(1);
    expect(first.input.value).toBe("");

    cleanup();
    const needsDecision = vi.fn((): ConfirmWordResult => "needs-decision");
    const second = renderBar({}, null, null, { onConfirmWord: needsDecision });
    fireEvent.change(second.input, { target: { value: "yes" } });
    fireEvent.keyDown(second.input, { key: "Enter" });
    expect(needsDecision).toHaveBeenCalledTimes(1);
    expect(statusText()).toBe("The pop-up needs a decision first.");
    expect(second.input.value).toBe("yes");

    cleanup();
    const none = vi.fn((): ConfirmWordResult => "none");
    const third = renderBar({}, null, null, { onConfirmWord: none });
    fireEvent.change(third.input, { target: { value: "yes" } });
    fireEvent.keyDown(third.input, { key: "Enter" });
    expect(none).toHaveBeenCalledTimes(1);
    expect(statusText()).toBe(SHAPE);
    expect(third.input.value).toBe("yes");
  });
});

// -----------------------------------------------------------------------
// S49 / R-397 (§19.96/D125, docs/agent-briefs/s49-a-elsewhere-brief.md §5):
// a wrong or missing cell offers the person's blocks elsewhere -- the bar's
// own wiring (the resolver's own cases are commandResolve.test.ts's RE1-12).
// -----------------------------------------------------------------------

describe("CB-else: a wrong or missing cell offers the person's blocks elsewhere (S49)", () => {
  it("CB-else-1: a wrong-cell removal outlines the elsewhere block; yes removes it", () => {
    const { input, onUnassign, onHighlight } = renderBar({ assignments: [BLK_C2] });

    fireEvent.change(input, { target: { value: UNASSIGN_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onHighlight).toHaveBeenLastCalledWith({ kind: "remove", assignmentIds: ["blkC2"] });
    expect(statusText()).toBe(
      "Operator 1 has no block on Cell 1 10:00–14:00, but has one on Cell 2: Housing A 10:00–14:00. Remove that one?" +
        " — say or type yes to do it, no to leave it.",
    );

    fireEvent.change(input, { target: { value: "yes" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onUnassign).toHaveBeenCalledTimes(1);
    const [resolved] = onUnassign.mock.calls[0] as [ResolvedUnassign, { x: number; y: number }];
    expect(resolved.assignmentId).toBe("blkC2");
  });

  it("CB-else-2: a wrong-cell move in time asks (no onMove yet); the message names the destination hours; yes retimes the elsewhere block", () => {
    const { input, onMove, onHighlight } = renderBar({ assignments: [BLK_C2] });

    fireEvent.change(input, { target: { value: MOVE_RETIME_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onMove).not.toHaveBeenCalled();
    expect(onHighlight).toHaveBeenLastCalledWith({ kind: "move", assignmentIds: ["blkC2"] });
    expect(statusText()).toContain("Move that one to 10:00–15:00?");
    expect(screen.getByRole("button", { name: "Move it" })).toBeTruthy();

    fireEvent.change(input, { target: { value: "yes" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onMove).toHaveBeenCalledTimes(1);
    const [resolved] = onMove.mock.calls[0] as [ResolvedMove, { x: number; y: number }];
    expect(resolved.assignmentId).toBe("blkC2");
    expect(resolved.target).toEqual({ kind: "retime" });
  });

  it("CB-else-3: several elsewhere blocks outline all; a bare yes asks which one", () => {
    const { input, onUnassign, onHighlight } = renderBar({ assignments: [BLK_C2, BLK_C1B] });

    fireEvent.change(input, { target: { value: UNASSIGN_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onHighlight).toHaveBeenLastCalledWith({
      kind: "remove",
      assignmentIds: ["blkC2", "blkC1b"],
    });
    expect(statusText()).not.toMatch(/say or type yes/);

    fireEvent.change(input, { target: { value: "yes" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toMatch(/^Which one\? /);
    expect(onUnassign).not.toHaveBeenCalled();
  });

  it("CB-else-4: a right-cell removal behaves as CB-yes-1 -- no 'but has' wording", () => {
    const { input, onHighlight } = renderBar({ assignments: [BLK1] });

    fireEvent.change(input, { target: { value: UNASSIGN_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onHighlight).toHaveBeenLastCalledWith({ kind: "remove", assignmentIds: ["blk1"] });
    expect(statusText()).not.toContain("but has");
    expect(statusText()).toBe(
      "Remove Operator 1's Housing A block on Cell 1, 10:00–14:00? — say or type yes to do it, no to leave it.",
    );
  });
});

// -----------------------------------------------------------------------
// S51 (R-400, design §19.98/D127): a several runs one question at a time,
// docs/agent-briefs/s51-a-lot-brief.md §2 items 5 (CB-lot-1..9).
// -----------------------------------------------------------------------

describe("CB-lot: a several runs one question at a time and writes on one yes (S51)", () => {
  it("CB-lot-1: a several of two removals from one cell, both people with one block, walks both questions to the lot status", () => {
    const { input, onHighlight } = renderBar({ assignments: [BLK1, BLK_SP] });

    fireEvent.change(input, { target: { value: LOT_REMOVE_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toBe(
      "1 of 2: Remove Operator 1's Housing A block on Cell 1, 10:00–14:00?" +
        " — say or type yes to do it, no to leave it.",
    );
    expect(onHighlight).toHaveBeenLastCalledWith({ kind: "remove", assignmentIds: ["blk1"] });

    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));

    expect(statusText()).toBe(
      "2 of 2: Remove Sam Patel's Housing A block on Cell 1, 10:00–14:00?" +
        " — say or type yes to do it, no to leave it.",
    );
    expect(onHighlight).toHaveBeenLastCalledWith({ kind: "remove", assignmentIds: ["blkSp"] });

    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));

    const dayLabel = formatDayLabel(new Date("2026-09-03T00:00:00Z"), "d_mon_yyyy", "UTC");
    expect(statusText()).toBe(
      "2 commands ready: " +
        `1. Removing Operator 1's Housing A block · Plant 1 › Assembly › Line 1 › Cell 1 · ${dayLabel} · 10:00–14:00; ` +
        `2. Removing Sam Patel's Housing A block · Plant 1 › Assembly › Line 1 › Cell 1 · ${dayLabel} · 10:00–14:00` +
        " — say or type yes to do them, no to leave them.",
    );
    expect(onHighlight).toHaveBeenLastCalledWith([
      { kind: "remove", assignmentIds: ["blk1"] },
      { kind: "remove", assignmentIds: ["blkSp"] },
    ]);
    expect(screen.getByRole("button", { name: "Do all 2" })).toBeTruthy();
  });

  it("CB-lot-2: yes + Enter calls onRunLot with two ResolvedUnassign in order and shows 'Done: 2 commands.' with the input cleared", async () => {
    const onRunLot = vi.fn(async (resolved: ResolvedAny[]): Promise<LotResult> => ({
      done: resolved.length,
      error: null,
    }));
    const { input, onHighlight } = renderBar(
      { assignments: [BLK1, BLK_SP] },
      null,
      null,
      {},
      { onRunLot },
    );

    fireEvent.change(input, { target: { value: LOT_REMOVE_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));

    fireEvent.change(input, { target: { value: "yes" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(statusText()).toBe("Done: 2 commands."));

    expect(onRunLot).toHaveBeenCalledTimes(1);
    const [resolvedList] = onRunLot.mock.calls[0] as [ResolvedAny[]];
    expect(resolvedList).toHaveLength(2);
    expect(resolvedList.map((r) => r.intent)).toEqual(["unassign", "unassign"]);
    expect((resolvedList[0] as ResolvedUnassign).assignmentId).toBe("blk1");
    expect((resolvedList[1] as ResolvedUnassign).assignmentId).toBe("blkSp");
    expect(input.value).toBe("");
    expect(onHighlight).toHaveBeenLastCalledWith(null);
  });

  it("CB-lot-3: onRunLot resolving {done:1, error:'boom'} shows the partial-failure message, input kept, highlight cleared", async () => {
    const onRunLot = vi.fn(async (): Promise<LotResult> => ({ done: 1, error: "boom" }));
    const { input, onHighlight } = renderBar(
      { assignments: [BLK1, BLK_SP] },
      null,
      null,
      {},
      { onRunLot },
    );

    fireEvent.change(input, { target: { value: LOT_REMOVE_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));

    fireEvent.change(input, { target: { value: "yes" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(statusText()).toBe("Did 1 of 2; the next failed: boom"));

    expect(input.value).toBe("yes");
    expect(onHighlight).toHaveBeenLastCalledWith(null);
  });

  it("CB-lot-4: the first command's ambiguous block question is numbered and its buttons continue to the next command, then the lot status", () => {
    const { input } = renderBar({ assignments: [BLK1, BLK2, BLK_SP] });

    fireEvent.change(input, { target: { value: LOT_REMOVE_WHOLE_DAY_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toMatch(/^1 of 2: /);
    expect(screen.getByRole("button", { name: "Remove Housing A 10:00–14:00" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove Housing A 14:00–16:00" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove Housing A 10:00–14:00" }));

    expect(statusText()).toMatch(/^2 of 2: /);
    expect(screen.getByRole("button", { name: "Remove it" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));

    expect(statusText()).toMatch(/^2 commands ready: /);
    expect(screen.getByRole("button", { name: "Do all 2" })).toBeTruthy();
  });

  it("CB-lot-5: the first command's block is elsewhere (S49), numbered; yes answers that one-candidate question, then the lot", () => {
    const { input } = renderBar({ assignments: [BLK_C2, BLK_SP] });

    fireEvent.change(input, { target: { value: LOT_REMOVE_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toBe(
      "1 of 2: Operator 1 has no block on Cell 1 10:00–14:00, but has one on Cell 2: Housing A 10:00–14:00. Remove that one?" +
        " — say or type yes to do it, no to leave it.",
    );

    fireEvent.change(input, { target: { value: "yes" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toMatch(/^2 of 2: /);
    expect(screen.getByRole("button", { name: "Remove it" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));

    expect(statusText()).toMatch(/^2 commands ready: /);
  });

  it("CB-lot-6: 'remove it' at the lot status is answered in place, no onRunLot", () => {
    const onRunLot = vi.fn(async (): Promise<LotResult> => ({ done: 2, error: null }));
    const { input } = renderBar({ assignments: [BLK1, BLK_SP] }, null, null, {}, { onRunLot });
    fireEvent.change(input, { target: { value: LOT_REMOVE_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    expect(statusText()).toMatch(/^2 commands ready: /);

    fireEvent.change(input, { target: { value: "remove it" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toBe("That is a lot of 2 commands; say yes to do them all, or no.");
    expect(onRunLot).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Do all 2" })).toBeTruthy();
  });

  it("CB-lot-7: no / Escape / a typed edit each drop the lot and clear the highlight", () => {
    function reachLotStatus() {
      const { input, onUnassign, onHighlight } = renderBar({ assignments: [BLK1, BLK_SP] });
      fireEvent.change(input, { target: { value: LOT_REMOVE_SENTENCE } });
      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
      fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
      expect(statusText()).toMatch(/^2 commands ready: /);
      return { input, onUnassign, onHighlight };
    }

    // no
    const first = reachLotStatus();
    let { input, onHighlight } = first;
    const { onUnassign } = first;
    fireEvent.change(input, { target: { value: "no" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(statusText()).toBe("");
    expect(input.value).toBe("");
    expect(onHighlight).toHaveBeenLastCalledWith(null);
    expect(onUnassign).not.toHaveBeenCalled();

    cleanup();

    // Escape
    ({ input, onHighlight } = reachLotStatus());
    fireEvent.keyDown(input, { key: "Escape" });
    expect(statusText()).toBe("");
    expect(onHighlight).toHaveBeenLastCalledWith(null);

    cleanup();

    // a typed edit
    ({ input, onHighlight } = reachLotStatus());
    fireEvent.change(input, { target: { value: `${LOT_REMOVE_SENTENCE}x` } });
    expect(statusText()).toBe("");
    expect(onHighlight).toHaveBeenLastCalledWith(null);
  });

  it("CB-lot-8: a mixed lot (one removal, one move in time) outlines with two kinds and onRunLot receives both resolved shapes", async () => {
    const unassignCmd: UnassignCommand = {
      intent: "unassign",
      operator: "Operator 1",
      place: ["Cell 1", "Line 1"],
      day: null,
      span: { start: { hour: 10, minute: 0 }, end: { hour: 14, minute: 0 } },
      existing: { kind: "remove", assignmentId: "blk1" },
      shift: null,
    };
    const moveCmd: MoveCommand = {
      intent: "move",
      operator: "Sam Patel",
      place: ["Cell 1", "Line 1"],
      toPlace: null,
      day: null,
      span: { start: { hour: 10, minute: 0 }, end: { hour: 15, minute: 0 } },
      existing: null,
      shift: null,
    };
    // S51's own note (brief §2 item 1 / design §19.98): a mixed-intent
    // several never comes off the TEXT grammar (each `parseXRest` only ever
    // lists one intent) -- this drives it through the model-reader path
    // instead, exactly as the several form will arrive once the model
    // learns it, standing in for that here with a fake `reader`.
    const reader: Reader = vi.fn(async (): Promise<Reading> => ({
      ok: true,
      by: "model",
      command: { intent: "several", commands: [unassignCmd, moveCmd] },
    }));
    const onRunLot = vi.fn(async (resolved: ResolvedAny[]): Promise<LotResult> => ({
      done: resolved.length,
      error: null,
    }));
    const { input, onHighlight } = renderBar(
      { assignments: [BLK1, BLK_SP] },
      reader,
      null,
      {},
      { onRunLot },
    );

    fireEvent.change(input, { target: { value: "anything" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(statusText()).toMatch(/^2 commands ready: /));
    expect(onHighlight).toHaveBeenLastCalledWith([
      { kind: "remove", assignmentIds: ["blk1"] },
      { kind: "retime", assignmentIds: ["blkSp"] },
    ]);

    fireEvent.change(input, { target: { value: "yes" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(onRunLot).toHaveBeenCalledTimes(1));
    const [resolvedList] = onRunLot.mock.calls[0] as [ResolvedAny[]];
    expect(resolvedList.map((r) => r.intent)).toEqual(["unassign", "move"]);
    expect((resolvedList[0] as ResolvedUnassign).assignmentId).toBe("blk1");
    expect((resolvedList[1] as ResolvedMove).assignmentId).toBe("blkSp");
  });

  it("CB-lot-9: a single sentence still calls onUnassign, never onRunLot (regression pin)", () => {
    const { onUnassign, onRunLot, input } = renderBar({ assignments: [BLK1] });
    fireEvent.change(input, { target: { value: UNASSIGN_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));

    expect(onUnassign).toHaveBeenCalledTimes(1);
    expect(onRunLot).not.toHaveBeenCalled();
  });

  it("CB-lot-10: a second yes while Working… does not call onRunLot again", async () => {
    let resolveRunLot: ((r: LotResult) => void) | null = null;
    const onRunLot = vi.fn(
      () =>
        new Promise<LotResult>((resolve) => {
          resolveRunLot = resolve;
        }),
    );
    const { input } = renderBar({ assignments: [BLK1, BLK_SP] }, null, null, {}, { onRunLot });

    fireEvent.change(input, { target: { value: LOT_REMOVE_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));

    fireEvent.change(input, { target: { value: "yes" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRunLot).toHaveBeenCalledTimes(1);
    expect(statusText()).toBe("Working…");

    // A second "yes" while the first run is still in flight -- the same
    // word that started it -- must never start a second one (small 2).
    fireEvent.change(input, { target: { value: "yes" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRunLot).toHaveBeenCalledTimes(1);

    resolveRunLot!({ done: 2, error: null });
    await waitFor(() => expect(statusText()).toBe("Done: 2 commands."));
  });

  it("CB-lot-11: two commands naming the same block drop the lot with the collision message", () => {
    const { input } = renderBar({ assignments: [BLK1] });

    fireEvent.change(input, {
      target: { value: "Unassign Operator 1 and Operator 1 from Cell 1 in Line 1 from 10 to 2" },
    });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(statusText()).toMatch(/^1 of 2: /);

    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    expect(statusText()).toMatch(/^2 of 2: /);

    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));

    expect(statusText()).toBe("Commands 1 and 2 name the same block; say them one at a time.");
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("CB-lot-12: Escape during Working… leaves it standing, and the result message still arrives", async () => {
    let resolveRunLot: ((r: LotResult) => void) | null = null;
    const onRunLot = vi.fn(
      () =>
        new Promise<LotResult>((resolve) => {
          resolveRunLot = resolve;
        }),
    );
    const { input } = renderBar({ assignments: [BLK1, BLK_SP] }, null, null, {}, { onRunLot });

    fireEvent.change(input, { target: { value: LOT_REMOVE_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));

    fireEvent.change(input, { target: { value: "yes" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(statusText()).toBe("Working…");

    // Escape closes nothing while a lot is writing in the background --
    // not even the launcher's own "nothing left, close the panel" signal.
    fireEvent.keyDown(input, { key: "Escape" });
    expect(statusText()).toBe("Working…");

    resolveRunLot!({ done: 2, error: null });
    await waitFor(() => expect(statusText()).toBe("Done: 2 commands."));
  });

  it("CB-lot-13: a typed edit during Working… is ignored -- the input stays unchanged", async () => {
    let resolveRunLot: ((r: LotResult) => void) | null = null;
    const onRunLot = vi.fn(
      () =>
        new Promise<LotResult>((resolve) => {
          resolveRunLot = resolve;
        }),
    );
    const { input } = renderBar({ assignments: [BLK1, BLK_SP] }, null, null, {}, { onRunLot });

    fireEvent.change(input, { target: { value: LOT_REMOVE_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));

    fireEvent.change(input, { target: { value: "yes" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("yes");
    expect(statusText()).toBe("Working…");

    // A typed edit while the lot is writing in the background is a no-op --
    // the controlled input snaps straight back, and the status stands.
    fireEvent.change(input, { target: { value: "something else entirely" } });
    expect(input.value).toBe("yes");
    expect(statusText()).toBe("Working…");

    resolveRunLot!({ done: 2, error: null });
    await waitFor(() => expect(statusText()).toBe("Done: 2 commands."));
    expect(input.value).toBe("");
  });
});

// -----------------------------------------------------------------------
// S44-b: the bar reads through the model service, with a fake `reader`
// (brief docs/agent-briefs/s44-b-read-by-model-brief.md §3.5). `readSentence`
// itself (the real `fetch`-backed one) is `src/test/voiceRead.test.ts`'s
// concern (VR1-VR7); these tests are only about `CommandBar`'s OWN wiring
// -- the pending status, the abort-and-restart on a second Enter, Escape,
// and the rules fallback with its readout suffix.
// -----------------------------------------------------------------------

describe("CB-model: the bar reads through a model reader (S44-b)", () => {
  it("CB-model-1: a clean model answer opens the popover exactly as the rules would, readout says read by the model", async () => {
    const parsed = parseCommand(P1_SENTENCE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const fakeReader: Reader = vi.fn(async (): Promise<Reading> => ({
      ok: true,
      command: parsed.command,
      by: "model",
    }));

    const { onOpen, input } = renderBar({ runs: [] }, fakeReader);
    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toBe("Reading…");
    await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));

    // The same fields C2 asserts for the rules reading this exact sentence.
    const [resolved] = onOpen.mock.calls[0] as [ResolvedCommand, { x: number; y: number }];
    expect(resolved.nodeId).toBe("c1a");
    expect(resolved.operatorId).toBe("op1");
    expect(resolved.target).toEqual({ kind: "direct", productId: "ha" });
    expect(resolved.range).toEqual({ startMin: 3 * 1440 + 600, endMin: 3 * 1440 + 840 });
    expect(statusText().endsWith(" · read by the model")).toBe(true);
  });

  it("CB-model-2: 'unavailable' falls back to the rules, readout says why", async () => {
    const fakeReader: Reader = vi.fn(async (): Promise<Reading> => ({
      ok: false,
      reason: "unavailable",
    }));
    const { onOpen, input } = renderBar({ runs: [] }, fakeReader);

    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));

    expect(statusText()).toContain("· read by the rules (the model service is off)");
  });

  it("CB-model-3: a failed parse under 'timeout' is prefixed with why the rules read it", async () => {
    const fakeReader: Reader = vi.fn(async (): Promise<Reading> => ({
      ok: false,
      reason: "timeout",
    }));
    const { input } = renderBar({ runs: [] }, fakeReader);

    fireEvent.change(input, { target: { value: "gibberish" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(statusText()).toBe(`The model took too long, so the rules read this: ${SHAPE}`),
    );
  });

  it("CB-model-4: 'Reading…' shows while pending; a second Enter aborts the first (its signal) and reads again", async () => {
    const captured: { first: AbortSignal | null } = { first: null };
    let calls = 0;
    const fakeReader: Reader = vi.fn((_text: string, signal: AbortSignal) => {
      calls += 1;
      if (calls === 1) {
        captured.first = signal;
        return new Promise<Reading>(() => {
          // Never settles -- superseded by the second Enter below.
        });
      }
      return Promise.resolve({ ok: false, reason: "no-service" } as Reading);
    });

    const { onOpen, input } = renderBar({ runs: [] }, fakeReader);
    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(statusText()).toBe("Reading…");
    expect(calls).toBe(1);
    expect(captured.first?.aborted ?? false).toBe(false);

    fireEvent.keyDown(input, { key: "Enter" });
    expect(calls).toBe(2);
    expect(captured.first?.aborted).toBe(true);

    // The second reading answers "no-service" -> exactly the null-reader
    // path -- the rules read P1_SENTENCE and open the popover, no suffix.
    await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));
    expect(statusText().endsWith("· read by")).toBe(false);
  });

  it("CB-model-5: Escape while reading aborts it and clears the status", () => {
    const captured: { signal: AbortSignal | null } = { signal: null };
    const fakeReader: Reader = vi.fn((_text: string, sig: AbortSignal) => {
      captured.signal = sig;
      return new Promise<Reading>(() => {
        // Never settles.
      });
    });

    const { input } = renderBar({ runs: [] }, fakeReader);
    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(statusText()).toBe("Reading…");

    fireEvent.keyDown(input, { key: "Escape" });
    expect(captured.signal?.aborted).toBe(true);
    expect(statusText()).toBe("");
  });

  it("CB-model-6: a null reader makes no call -- the bar behaves exactly as before S44-b", () => {
    const spyReader: Reader = vi.fn();
    const { onOpen, input } = renderBar({ runs: [] }, null);

    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(spyReader).not.toHaveBeenCalled();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(statusText().includes("read by")).toBe(false);
  });

  // Review finding 1: an edit while reading used to leave "Reading…" on
  // screen (a stuck-looking spinner) until the next Enter or Escape.
  it("CB-model-7: an edit while reading aborts it and clears the 'Reading…' status", () => {
    const fakeReader: Reader = vi.fn(
      (): Promise<Reading> =>
        new Promise(() => {
          // Never settles.
        }),
    );
    const { input } = renderBar({ runs: [] }, fakeReader);

    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(statusText()).toBe("Reading…");

    fireEvent.change(input, { target: { value: `${P1_SENTENCE} more` } });
    expect(statusText()).toBe("");
  });

  // Review finding 2: Enter on empty/whitespace-only text used to reach the
  // reader (a network round trip, possibly a 20s wait) and then fall back
  // with a misleading "not a form" prefix. It must take exactly the
  // null-reader path instead.
  it("CB-model-8: empty or whitespace-only text never reaches the reader", () => {
    const fakeReader: Reader = vi.fn();
    const { input } = renderBar({ runs: [] }, fakeReader);

    fireEvent.keyDown(input, { key: "Enter" });
    expect(fakeReader).not.toHaveBeenCalled();
    expect(statusText()).toBe(SHAPE);

    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(fakeReader).not.toHaveBeenCalled();
    expect(statusText()).toBe(SHAPE);
  });
});

// -----------------------------------------------------------------------
// S46-a: the microphone -- the browser's recogniser types the sentence
// (brief docs/agent-briefs/s46-a-microphone-brief.md §2, CB-mic-1..7). A
// fake `Recognizer` (`makeFakeRecognizer` above) stands in for the browser's
// Web Speech API; `browserRecognizer()`'s own mapping onto that API is
// `src/lib/voice/recognizer.ts`'s concern, untested here (jsdom has no
// `SpeechRecognition`) -- these tests are only about `CommandBar`'s own
// wiring of whatever `Recognizer` it is given.
// -----------------------------------------------------------------------

describe("CB-mic: the microphone button (S46-a)", () => {
  it("CB-mic-1: no recognizer renders no button; a fake one does", () => {
    renderBar({}, null, null);
    expect(screen.queryByRole("button", { name: "Speak a sentence" })).toBeNull();

    cleanup();
    const { recognizer } = makeFakeRecognizer();
    renderBar({}, null, recognizer);
    expect(screen.getByRole("button", { name: "Speak a sentence" })).toBeTruthy();
  });

  it("CB-mic-2: pressing starts a session, shows Listening… and aria-pressed, and aborts an in-flight reading", () => {
    const { recognizer } = makeFakeRecognizer();
    const captured: { signal: AbortSignal | null } = { signal: null };
    const neverResolves: Reader = vi.fn((_text: string, signal: AbortSignal) => {
      captured.signal = signal;
      return new Promise<Reading>(() => {
        // Never settles -- superseded by pressing the mic button below.
      });
    });
    const { input } = renderBar({ runs: [] }, neverResolves, recognizer);

    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(statusText()).toBe("Reading…");

    const micButton = screen.getByRole("button", { name: "Speak a sentence" });
    fireEvent.click(micButton);

    expect(neverResolves).toHaveBeenCalledTimes(1);
    expect(captured.signal?.aborted).toBe(true);
    expect(micButton.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Listening…")).toBeTruthy();
  });

  it("CB-mic-3: an interim result puts the heard text in the input", () => {
    const { recognizer, fire } = makeFakeRecognizer();
    const { input } = renderBar({}, null, recognizer);
    fireEvent.click(screen.getByRole("button", { name: "Speak a sentence" }));

    fire.interim("put ana");

    expect(input.value).toBe("put ana");
  });

  it("CB-mic-4: a final result submits exactly as Enter does", async () => {
    const first = makeFakeRecognizer();
    const { onOpen, input } = renderBar({ runs: [] }, null, first.recognizer);
    fireEvent.click(screen.getByRole("button", { name: "Speak a sentence" }));

    first.fire.final(P1_SENTENCE);

    expect(input.value).toBe(P1_SENTENCE);
    expect(onOpen).toHaveBeenCalledTimes(1);
    const [resolved] = onOpen.mock.calls[0] as [ResolvedCommand, { x: number; y: number }];
    expect(resolved.operatorId).toBe("op1");

    cleanup();
    const second = makeFakeRecognizer();
    const fakeReader: Reader = vi.fn(async (): Promise<Reading> => ({
      ok: false,
      reason: "no-service",
    }));
    const { onOpen: onOpen2 } = renderBar({ runs: [] }, fakeReader, second.recognizer);
    fireEvent.click(screen.getByRole("button", { name: "Speak a sentence" }));

    second.fire.final(P1_SENTENCE);

    expect(fakeReader).toHaveBeenCalledWith(P1_SENTENCE, expect.anything());
    await waitFor(() => expect(onOpen2).toHaveBeenCalledTimes(1));
  });

  it("CB-mic-5: pressing again while listening stops it, keeps the text, and returns to idle", () => {
    const { recognizer, stop } = makeFakeRecognizer();
    const { input } = renderBar({}, null, recognizer);
    const micButton = screen.getByRole("button", { name: "Speak a sentence" });
    fireEvent.click(micButton);
    fireEvent.change(input, { target: { value: "put ana" } });

    fireEvent.click(micButton);

    expect(stop).toHaveBeenCalledTimes(1);
    expect(input.value).toBe("put ana");
    expect(micButton.getAttribute("aria-pressed")).toBe("false");
  });

  it("CB-mic-6: Escape while listening stops it, keeps text and status", () => {
    const { recognizer, stop } = makeFakeRecognizer();
    const { input } = renderBar({}, null, recognizer);
    fireEvent.click(screen.getByRole("button", { name: "Speak a sentence" }));
    fireEvent.change(input, { target: { value: "put ana" } });

    fireEvent.keyDown(input, { key: "Escape" });

    expect(stop).toHaveBeenCalledTimes(1);
    expect(input.value).toBe("put ana");
    expect(statusText()).toBe("");
  });

  it("CB-mic-7: each error kind sets the status line and ends listening", () => {
    const cases: Array<[Parameters<RecognizerEvents["onError"]>[0], string | undefined, string]> = [
      [
        "not-allowed",
        undefined,
        "The microphone was refused. Allow it in the browser's address bar and try again.",
      ],
      ["no-speech", undefined, "Nothing was heard."],
      ["other", "network", "The recogniser stopped: network."],
    ];
    for (const [kind, detail, expected] of cases) {
      cleanup();
      const { recognizer, fire } = makeFakeRecognizer();
      renderBar({}, null, recognizer);
      const micButton = screen.getByRole("button", { name: "Speak a sentence" });
      fireEvent.click(micButton);

      fire.error(kind, detail);

      expect(statusText()).toBe(expected);
      expect(micButton.getAttribute("aria-pressed")).toBe("false");
    }
  });

  // Review findings 1-3 (races caught reviewing S46-a): CB-mic-8 to CB-mic-10.

  it("CB-mic-8: onEnd after a final clears the session, so a later Escape runs the normal rules instead of stopping a dead handle", () => {
    const { recognizer, fire, stop } = makeFakeRecognizer();
    const { input, onOpen } = renderBar({ runs: [] }, null, recognizer);
    fireEvent.click(screen.getByRole("button", { name: "Speak a sentence" }));

    fire.final(P1_SENTENCE);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(statusText()).not.toBe("");

    // The real API fires `onEnd` on its own once a final result has settled
    // the session -- nothing here presses the mic button again.
    fire.end();

    fireEvent.keyDown(input, { key: "Escape" });

    // Review finding 1: pre-fix, `recognitionRef` still held the dead
    // handle, so this Escape called `stop()` on it and returned before the
    // status line was cleared.
    expect(stop).not.toHaveBeenCalled();
    expect(statusText()).toBe("");
    expect(input.value).toBe(P1_SENTENCE);
  });

  it("CB-mic-9: a synchronous onError from the recognizer factory itself leaves the button idle with the error status", () => {
    // recognizer.ts's own `start()` try/catch can call `onError` before
    // `browserRecognizer()`'s inner function returns a handle -- this fake
    // reproduces exactly that shape (review finding 2).
    const stop = vi.fn();
    const recognizer: Recognizer = (events) => {
      events.onError("other", "sync-boom");
      return { stop };
    };
    renderBar({}, null, recognizer);
    const micButton = screen.getByRole("button", { name: "Speak a sentence" });

    fireEvent.click(micButton);

    expect(micButton.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByText("Listening…")).toBeNull();
    expect(statusText()).toBe("The recogniser stopped: sync-boom.");
  });

  it("CB-mic-10: a final result arriving after stop is a no-op", () => {
    const { recognizer, fire } = makeFakeRecognizer();
    const { input, onOpen } = renderBar({ runs: [] }, null, recognizer);
    const micButton = screen.getByRole("button", { name: "Speak a sentence" });
    fireEvent.click(micButton);
    fireEvent.click(micButton); // stop -- listening ends before any result

    fire.final(P1_SENTENCE);

    expect(input.value).toBe("");
    expect(onOpen).not.toHaveBeenCalled();
  });
});

/**
 * S52-b (docs/agent-briefs/s52-b-shift-resolver-brief.md §2 item 4, R-402):
 * a shift's name resolves through the bar the same way it does through the
 * resolver directly -- `commandResolve.test.ts`'s SR cases own the matching
 * tiers and the questions' exact shape; this file only proves the wiring
 * (a real sentence, through `ctx.shiftsAt`, reaches `onOpen`/the status
 * line the same as `commandResolve.test.ts` already pins).
 */
describe("CB-shift: a shift's name reaches onOpen (S52-b, R-402)", () => {
  /** The demo pattern brief §2 item 4 names: Shift 1 06:00-14:00, Shift 2
   *  14:00-22:00, Shift 3 22:00-06:00 (overnight), on Cell 1 (c1a) only. */
  const demoShiftsAt = (nodeId: string) =>
    nodeId === "c1a"
      ? [
          { name: "Shift 1", startMin: 360, endMin: 840 },
          { name: "Shift 2", startMin: 840, endMin: 1320 },
          { name: "Shift 3", startMin: 1320, endMin: 1800 },
        ]
      : [];

  it("CB-shift-1: the maintainer's sentence reaches onOpen with range 14:00-22:00", () => {
    const { onOpen, input } = renderBar({
      runs: [],
      shiftsAt: demoShiftsAt,
      operators: [{ id: "a2", displayName: "Operator A2", employeeRef: null, active: true }],
    });

    fireEvent.change(input, {
      target: { value: "assign Operator A2 to work for shift 2 on Cell 1 in Line 1 for Housing A" },
    });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onOpen).toHaveBeenCalledTimes(1);
    const [resolved] = onOpen.mock.calls[0] as [ResolvedCommand, { x: number; y: number }];
    expect(resolved.nodeId).toBe("c1a");
    expect(resolved.operatorId).toBe("a2");
    expect(resolved.range).toEqual({ startMin: 3 * 1440 + 840, endMin: 3 * 1440 + 1320 });
  });

  it("CB-shift-2: 'shift 9' shows the no_shift message, verbatim, and opens nothing", () => {
    const { onOpen, input } = renderBar({ runs: [], shiftsAt: demoShiftsAt });

    fireEvent.change(input, {
      target: { value: "assign Operator 1 to Housing A on Cell 1 in Line 1 for shift 9" },
    });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toBe('No shift called "9" on Cell 1; it has Shift 1, Shift 2, Shift 3.');
    expect(onOpen).not.toHaveBeenCalled();
  });
});
