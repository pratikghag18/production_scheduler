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
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { formatDayLabel } from "@/features/board/lib/time";
import {
  formatCommand,
  parseCommand,
  type AssignCommand,
  type UnassignCommand,
  type MoveCommand,
  type ReplaceCommand,
  type CopyCommand,
  type HeadcountCommand,
  type SingleCommand,
  type SeveralCommand,
  type SplitCommand,
} from "@/lib/command/parse";
import type {
  ResolveContext,
  ResolvedCommand,
  ResolvedBook,
  ResolvedUnassign,
  ResolvedMove,
  ResolvedHeadcount,
  ContextRun,
  ContextAssignment,
  Candidate,
  BoardDay,
} from "@/lib/command/resolve";
// S59 (R-418's message): a runtime (not type-only) import, used ONLY by the
// CB-unknown describe block below to spy on `resolveCommand` for one test at
// a time -- see that block's own comment for why. Every other test in this
// file still drives the REAL, unmocked `resolveCommand` (this file's own
// header doc, unchanged).
import * as resolveLib from "@/lib/command/resolve";
import {
  CommandBar,
  type ConfirmWordResult,
  type ResolvedAny,
  type LotResult,
} from "@/features/board/components/CommandBar";
import type { Reader, Reading } from "@/lib/voice/readSentence";
import type { Recognizer, RecognizerEvents } from "@/lib/voice/recognizer";
import type { TraceEntry } from "@/lib/voice/trace";

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
 *  nearest end while `minuteOfDay` stays the real wall clock, exactly the
 *  shape that let the maintainer's real board read a block starting the
 *  day before the window as starting on day 0 at its own real hour.
 *  Unclamped, no fake in this file could ever see this class of bug. */
function clampedWallOf(
  boardDays: readonly { index: number }[],
): (m: number) => { dayIndex: number; minuteOfDay: number } {
  const lastIndex = boardDays.length > 0 ? boardDays[boardDays.length - 1].index : 0;
  return (m: number) => {
    const raw = Math.floor(m / 1440);
    const dayIndex = raw < 0 ? 0 : raw > lastIndex ? lastIndex : raw;
    return { dayIndex, minuteOfDay: ((m % 1440) + 1440) % 1440 };
  };
}

/** Brief §5's own days: a 7-day window from Monday 2026-08-31, today =
 *  index 3 (Thursday 2026-09-03). Named so `buildCtx`'s own `wallOf` can
 *  clamp against whichever `days` a test actually passed. */
const BUILD_CTX_DAYS: BoardDay[] = [
  { index: 0, iso: "2026-08-31", weekday: 1 },
  { index: 1, iso: "2026-09-01", weekday: 2 },
  { index: 2, iso: "2026-09-02", weekday: 3 },
  { index: 3, iso: "2026-09-03", weekday: 4 },
  { index: 4, iso: "2026-09-04", weekday: 5 },
  { index: 5, iso: "2026-09-05", weekday: 6 },
  { index: 6, iso: "2026-09-06", weekday: 0 },
];

/** Brief §5's fixture, verbatim: a 7-day window from Monday 2026-08-31,
 *  today = index 3 (Thursday 2026-09-03), the plain (no-changeover) stub. */
function buildCtx(over: Partial<ResolveContext> = {}): ResolveContext {
  const finalDays = over.days ?? BUILD_CTX_DAYS;
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
    days: BUILD_CTX_DAYS,
    todayIndex: 3,
    wallToOffset: (d: number, m: number) => d * 1440 + m,
    runs: [],
    fitsRun: (a, r) => a.startMin >= r.startMin && a.endMin <= r.endMin,
    minDurationMinutes: 15,
    assignments: [],
    overlaps: (a, b) => a.startMin < b.endMin && b.startMin < a.endMin,
    findRunOverlap,
    shiftsAt: () => [],
    // S55 (D130 item 3): null by default -- most cases here never touch a
    // boundary shift name (`ALL_DAY`/`END_OF_SHIFT`/`END_OF_DAY`), so "no
    // clock" is the safer default; CB-x-8 overrides it to test the rounding.
    nowMinuteOfDay: null,
    // F-152-b: `clampedWallOf` mirrors `time.ts`'s own clamp -- without it
    // CB-mid-2 (and CB-mid-1) could not see the class of bug the
    // maintainer's real board hit.
    wallOf: clampedWallOf(finalDays),
    // S61-b (R-425, F-155, landed on `resolve.ts` concurrently with this
    // lane's own S61-a work): every assign resolution now asks
    // `ctx.certificateGaps` before it is ever `ok: true`. This file's own
    // scope is the bar's conversation/trace/day-label behaviour, not the
    // certificate rule itself -- the default here is "fully eligible, no
    // gaps", which keeps every case in this file byte for byte its
    // pre-R-425 behaviour; a case that cares about a real gap overrides it.
    certificateGaps: () => [],
    eligibilityPolicy: () => "warn",
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
  productName: "Housing A",
  headcount: 3,
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
  productName: "Cover",
  headcount: null,
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
  runId: null,
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
  // S59-e (R-421): `recognizerName` defaults to `undefined` -- every
  // pre-S59-e call site (up to five positional arguments) is unaffected;
  // the CB-t describe block below is the only caller that passes it. S60-b
  // (the S59 reviewer, 15 Sept): widened to a getter, matching the real
  // prop -- a caller that wants to change what it reports mid-test (CB-t-8)
  // mutates whatever the getter closes over, never re-renders.
  s59trace: { recognizerName?: () => "browser" | "local" } = {},
) {
  const onOpen = vi.fn();
  const onRetime = vi.fn();
  const onBook = vi.fn();
  const onRetimeRun = vi.fn();
  const onUnassign = vi.fn();
  const onMove = vi.fn();
  const onSetHeadcount = vi.fn();
  const onHighlight = vi.fn();
  // S59 (R-419): always a fresh `vi.fn()`, same reason `onHighlight` is --
  // no case here needs a caller-supplied one, every test reads it off the
  // returned spy instead.
  const onShowDay = vi.fn();
  const onRunLot = vi.fn(s51.onRunLot ?? (() => new Promise<LotResult>(() => {})));
  // R-424: `null` simulates the gap CommandBar's own `ctx` prop must now
  // survive (CB-keep's own describe block) -- every pre-R-424 caller only
  // ever passes a `Partial<ResolveContext>`, so this is additive.
  const element = (ctxOver: Partial<ResolveContext> | null) => (
    <CommandBar
      ctx={ctxOver === null ? null : buildCtx(ctxOver)}
      dateFormat="d_mon_yyyy"
      zone="UTC"
      reader={reader}
      recognizer={recognizer}
      recognizerName={s59trace.recognizerName}
      onOpen={onOpen}
      onRetime={onRetime}
      onBook={onBook}
      onRetimeRun={onRetimeRun}
      onUnassign={onUnassign}
      onMove={onMove}
      onSetHeadcount={onSetHeadcount}
      onRunLot={onRunLot}
      onHighlight={onHighlight}
      onShowDay={onShowDay}
      onConfirmWord={s47.onConfirmWord}
      onCancelWord={s47.onCancelWord}
    />
  );
  const { rerender, unmount } = render(element(over));
  const input = screen.getByRole("textbox", { name: "Tell the board" }) as HTMLInputElement;
  return {
    onOpen,
    // R-424/F-157: exposed so a test can drive a genuine unmount (CB-t-14,
    // CB-keep's own describe block) without reaching past this helper into
    // `@testing-library/react` itself.
    unmount,
    onRetime,
    onBook,
    onRetimeRun,
    onUnassign,
    onMove,
    onSetHeadcount,
    onRunLot,
    onHighlight,
    onShowDay,
    input,
    // S59 (R-419): re-renders the SAME `CommandBar` (identical props, every
    // callback the SAME mock instance) against a NEW `ctx` built from
    // `nextOver` -- simulates the window actually moving and a fresh
    // `commandCtx` landing from `BoardPage`, without this file reaching into
    // any board/store code (this file drives `CommandBar` alone). R-424:
    // `null` simulates `commandCtx` going null for a render (a refetch gap
    // `BoardPage`'s own fix should prevent in practice, but this component
    // must survive on its own regardless -- CB-keep's own describe block).
    rerenderCtx: (nextOver: Partial<ResolveContext> | null) => rerender(element(nextOver)),
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

/**
 * S59-e (R-421): stubs `fetch` for one test and returns the mock -- moved to
 * module scope (was local to the "CB-t" describe block) so R-424's own
 * "CB-keep" and F-154's own "CB-lot-fail" describe blocks below can post
 * against the SAME stub without a second copy. Every caller still cleans up
 * with `vi.unstubAllGlobals()` in its own `afterEach`.
 */
function stubFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The trace entry `stubFetch`'s mock posted on call `call` (default the
 *  first) -- asserts the URL and method along the way. */
function postedEntry(fetchMock: ReturnType<typeof vi.fn>, call = 0): TraceEntry {
  const [url, init] = fetchMock.mock.calls[call] as [string, RequestInit];
  expect(url).toBe("/__trace");
  expect(init.method).toBe("POST");
  return JSON.parse(init.body as string) as TraceEntry;
}

/**
 * F-153/F-157: mirrors `CommandBar`'s own `renderReadout` (an ISO day
 * rendered through `zonedTimeToInstant` + `formatDayLabel`, never a bare
 * `Date`) for a raw readout string one of this file's fixtures produced,
 * under `renderBar`'s own fixed `dateFormat="d_mon_yyyy"`/`zone="UTC"` --
 * `zonedTimeToInstant("UTC", ...)` and a plain UTC-midnight `Date` agree for
 * `zone="UTC"` exactly (zero offset either way), so this is safe to build
 * the simpler way here. A trace pin asserts against what the bar actually
 * SHOWED (`status.message`/`entry.asked`), never the raw ISO token
 * `resolve.ts` wrote into `.readout`.
 */
function renderedReadout(rawReadout: string): string {
  return rawReadout.replace(/\d{4}-\d{2}-\d{2}/, (iso) =>
    formatDayLabel(new Date(`${iso}T00:00:00Z`), "d_mon_yyyy", "UTC"),
  );
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

  it("CB-lot-3: onRunLot resolving {done:1, error:'boom.'} shows the partial-failure message, input kept, highlight cleared", async () => {
    // A typed (if unused) param -- same as CB-lot-2's own `onRunLot` above --
    // so `mock.calls[0]` types as `[ResolvedAny[]]` for the cast below.
    // F-154 review fix: `error` is a plain sentence -- every real source
    // (`buildSchedulerErrorToast`, `LotStepRefused.message`) always ends in
    // its own terminal punctuation, so the bar no longer adds one; this
    // fixture matches that shape rather than the bar patching it in.
    const onRunLot = vi.fn(async (_resolved: ResolvedAny[]): Promise<LotResult> => ({
      done: 1,
      error: "boom.",
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

    await waitFor(() => expect(onRunLot).toHaveBeenCalledTimes(1));
    const [resolvedList] = onRunLot.mock.calls[0] as [ResolvedAny[]];

    // F-154 review fix: a partial lot says what actually stood, not just
    // the raw failure text -- "boom" pins the "stayed" clause; CB-lot-fail-1
    // pins that a message `useSchedulerToast.ts` itself would have worded
    // through `buildSchedulerErrorToast` (which no longer bakes in "—
    // reverted." at all, that F-154 fix's own clean half) reads verbatim.
    await waitFor(() =>
      expect(statusText()).toBe(
        `Did 1 of 2; the next failed: boom. The 1 done stayed: ${renderedReadout(resolvedList[0].readout)}.`,
      ),
    );
    // Not "boom.." -- the bar doesn't add a period on top of the message's
    // own.

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
      until: null,
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
      // S58 (R-412, D132 item 1): every `MoveCommand` now carries `adjust`
      // -- `null` here is byte-for-byte this case's pre-S58 shape (an
      // ordinary move in time, not an edge adjust).
      adjust: null,
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
// S55 (R-404, R-406 to R-410, D130/brief §5): `expandCommand` runs before
// EVERY several intercept, board-answered or not, so a "clear Cell 1"/
// "cover Sam with Ana"/"same as yesterday" sentence lands in the SAME lot
// machinery CB-lot already proved. `buildCtx`'s own fixture keeps two
// "Cell 1" nodes on purpose (S49's own ambiguity cases), which would make
// EVERY one of the brief's own sentences ("clear Cell 1", "cover Sam with
// Ana on Cell 1") ambiguous here -- so these cases get their OWN small
// fixture, `buildXCtx`, with three uniquely named cells, an unambiguous
// "Sam"/"Ana" pair, and `nowMinuteOfDay` set (CB-x-8's own rounding).
// -----------------------------------------------------------------------

/** CB-x's own nodes: one line, three uniquely-named cells (never two
 *  "Cell 1"s -- see the block comment above). */
function buildXNodes() {
  return [
    { id: "xp", name: "Plant X", path: "plant_x" },
    { id: "xl", name: "Line X", path: "plant_x.line_x" },
    { id: "xc1", name: "Cell 1", path: "plant_x.line_x.cell_1" },
    { id: "xc2", name: "Cell 2", path: "plant_x.line_x.cell_2" },
    { id: "xc3", name: "Cell 3", path: "plant_x.line_x.cell_3" },
  ];
}

/** Reuses `buildCtx`'s own defaults (days, `wallToOffset`, `overlaps`,
 *  `findRunOverlap`, `minDurationMinutes`, …) but with the nodes/operators
 *  above and `nowMinuteOfDay` set to 10:07 -- CB-x-8's own rounding, and
 *  inert everywhere else (only a boundary-shift sentence reads it). */
function buildXCtx(over: Partial<ResolveContext> = {}): ResolveContext {
  const nodes = buildXNodes();
  return buildCtx({
    cells: [nodes[2], nodes[3], nodes[4]],
    nodeById: new Map(nodes.map((n) => [n.id, n] as const)),
    operators: [
      { id: "op1", displayName: "Operator 1", employeeRef: "E100", active: true },
      { id: "sam", displayName: "Sam", employeeRef: null, active: true },
      { id: "ana", displayName: "Ana", employeeRef: null, active: true },
    ],
    nowMinuteOfDay: 10 * 60 + 7,
    ...over,
  });
}

/** Same shape as `renderBar` (brief §5), trimmed to what these cases need:
 *  `ctx` built by `buildXCtx`, an optional `reader` (CB-x-6) and an
 *  optional `onRunLot` mock (every lot case). */
function renderXBar(
  over: Partial<ResolveContext> = {},
  reader: Reader | null = null,
  s51: { onRunLot?: (resolved: ResolvedAny[]) => Promise<LotResult> } = {},
) {
  const onOpen = vi.fn();
  const onRetime = vi.fn();
  const onBook = vi.fn();
  const onRetimeRun = vi.fn();
  const onUnassign = vi.fn();
  const onMove = vi.fn();
  const onSetHeadcount = vi.fn();
  const onHighlight = vi.fn();
  const onRunLot = vi.fn(s51.onRunLot ?? (() => new Promise<LotResult>(() => {})));
  render(
    <CommandBar
      ctx={buildXCtx(over)}
      dateFormat="d_mon_yyyy"
      zone="UTC"
      reader={reader}
      onOpen={onOpen}
      onRetime={onRetime}
      onBook={onBook}
      onRetimeRun={onRetimeRun}
      onUnassign={onUnassign}
      onMove={onMove}
      onSetHeadcount={onSetHeadcount}
      onRunLot={onRunLot}
      onHighlight={onHighlight}
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
    onSetHeadcount,
    onRunLot,
    onHighlight,
    input,
  };
}

/** CB-x-1/CB-x-4/CB-x-7: two blocks on Cell 1 (xc1), today, direct. */
const XBLK1: ContextAssignment = {
  id: "xblk1",
  nodeId: "xc1",
  operatorId: "op1",
  productId: "ha",
  productName: "Housing A",
  startMin: 3 * 1440 + 600,
  endMin: 3 * 1440 + 840,
  label: "10:00–14:00",
  runId: null,
};
const XBLK2: ContextAssignment = {
  ...XBLK1,
  id: "xblk2",
  startMin: 3 * 1440 + 840,
  endMin: 3 * 1440 + 960,
  label: "14:00–16:00",
};

/** CB-x-2/CB-x-6: a headcounted run on Cell 1, and Sam's own block
 *  attached to it -- "cover Sam with Ana" must write the assign back onto
 *  the SAME run, not a direct block. */
const RUN_X: ContextRun = {
  id: "runX",
  nodeId: "xc1",
  productId: "ha",
  startMin: 3 * 1440 + 480,
  endMin: 3 * 1440 + 960,
  label: "Housing A 08:00–16:00",
  span: "08:00–16:00",
  productName: "Housing A",
  headcount: 3,
};
const XSAM: ContextAssignment = {
  id: "xsam",
  nodeId: "xc1",
  operatorId: "sam",
  productId: "ha",
  productName: "Housing A",
  startMin: 3 * 1440 + 600,
  endMin: 3 * 1440 + 840,
  label: "10:00–14:00",
  runId: "runX",
};

/** CB-x-3: Operator 1's block on Cell 1 YESTERDAY (day index 2) -- the
 *  fixture "same as yesterday for Cell 1" copies from. */
const XYESTERDAY_BLK: ContextAssignment = {
  id: "xyblk",
  nodeId: "xc1",
  operatorId: "op1",
  productId: "ha",
  productName: "Housing A",
  startMin: 2 * 1440 + 600,
  endMin: 2 * 1440 + 840,
  label: "10:00–14:00",
  runId: null,
};

/** CB-x-4: `n` distinct 5-minute blocks on Cell 1 today, never individually
 *  resolved (the ceiling question fires from the COUNT `expandCommand`
 *  builds, before any of them ever reaches `resolveCommand`) -- 5 minutes
 *  apart keeps 101 of them inside one day's 1440-minute window. */
function manyBlocksOnXC1(n: number): ContextAssignment[] {
  const out: ContextAssignment[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      ...XBLK1,
      id: `xn${i}`,
      startMin: 3 * 1440 + i * 5,
      endMin: 3 * 1440 + i * 5 + 5,
      label: `block ${i}`,
    });
  }
  return out;
}

/** CB-x-7: `n` distinct blocks on Cell 1 today, each 15 minutes (the
 *  fixture's own `minDurationMinutes` -- these DO reach `resolveCommand`,
 *  one per lot step, so each must be long enough to resolve clean) 20
 *  minutes apart; only the COUNT matters for the 5-and-more truncation. */
function spacedBlocksOnXC1(n: number): ContextAssignment[] {
  const out: ContextAssignment[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      ...XBLK1,
      id: `xs${i}`,
      startMin: 3 * 1440 + i * 20,
      endMin: 3 * 1440 + i * 20 + 15,
      label: `block ${i}`,
    });
  }
  return out;
}

describe("CB-x: the bar expands before it resolves (S55, R-404/R-406 to R-410, D130)", () => {
  it("CB-x-1: 'clear Cell 1 today' expands to a lot of two removals, both blocks outlined, one yes runs them in board order", async () => {
    const onRunLot = vi.fn(async (resolved: ResolvedAny[]): Promise<LotResult> => ({
      done: resolved.length,
      error: null,
    }));
    const { input, onHighlight } = renderXBar({ assignments: [XBLK1, XBLK2] }, null, { onRunLot });

    fireEvent.change(input, { target: { value: "clear Cell 1 today" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toMatch(/^2 commands ready: /);
    expect(onHighlight).toHaveBeenLastCalledWith([
      { kind: "remove", assignmentIds: ["xblk1"] },
      { kind: "remove", assignmentIds: ["xblk2"] },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Do all 2" }));
    await waitFor(() => expect(statusText()).toBe("Done: 2 commands."));

    expect(onRunLot).toHaveBeenCalledTimes(1);
    const [resolvedList] = onRunLot.mock.calls[0] as [ResolvedAny[]];
    expect(resolvedList.map((r) => r.intent)).toEqual(["unassign", "unassign"]);
    expect((resolvedList[0] as ResolvedUnassign).assignmentId).toBe("xblk1");
    expect((resolvedList[1] as ResolvedUnassign).assignmentId).toBe("xblk2");
  });

  it("CB-x-2: 'cover Sam with Ana on Cell 1 today' is a lot of two (remove, assign); the assign attaches to Sam's run", async () => {
    const onRunLot = vi.fn(async (resolved: ResolvedAny[]): Promise<LotResult> => ({
      done: resolved.length,
      error: null,
    }));
    const { input } = renderXBar({ assignments: [XSAM], runs: [RUN_X] }, null, { onRunLot });

    fireEvent.change(input, { target: { value: "cover Sam with Ana on Cell 1 today" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toMatch(/^2 commands ready: /);

    fireEvent.click(screen.getByRole("button", { name: "Do all 2" }));
    await waitFor(() => expect(statusText()).toBe("Done: 2 commands."));

    expect(onRunLot).toHaveBeenCalledTimes(1);
    const [resolvedList] = onRunLot.mock.calls[0] as [ResolvedAny[]];
    expect(resolvedList.map((r) => r.intent)).toEqual(["unassign", "assign"]);
    expect((resolvedList[0] as ResolvedUnassign).assignmentId).toBe("xsam");
    const assignResolved = resolvedList[1] as ResolvedCommand;
    expect(assignResolved.operatorId).toBe("ana");
    expect(assignResolved.target).toEqual({ kind: "run", runId: "runX" });
  });

  it("CB-x-3: 'same as yesterday for Cell 1' with one block yesterday resolves as a single create, not a lot", () => {
    const { onOpen, onRunLot, input } = renderXBar({ assignments: [XYESTERDAY_BLK] });

    fireEvent.change(input, { target: { value: "same as yesterday for Cell 1" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onRunLot).not.toHaveBeenCalled();
    expect(onOpen).toHaveBeenCalledTimes(1);
    const [resolved] = onOpen.mock.calls[0] as [ResolvedCommand, { x: number; y: number }];
    expect(resolved.nodeId).toBe("xc1");
    expect(resolved.operatorId).toBe("op1");
    expect(resolved.range).toEqual({ startMin: 3 * 1440 + 600, endMin: 3 * 1440 + 840 });
  });

  it("CB-x-4: an expansion over the 100 ceiling asks for a smaller span; nothing runs", () => {
    const { onOpen, onRunLot, input } = renderXBar({ assignments: manyBlocksOnXC1(101) });

    fireEvent.change(input, { target: { value: "clear Cell 1 today" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toBe(
      "That would be 101 changes; say a smaller span — one cell, or one day.",
    );
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(onOpen).not.toHaveBeenCalled();
    expect(onRunLot).not.toHaveBeenCalled();
  });

  it("CB-x-5: 'clear Cell 3 today' with nobody there is a readout in the resolver's own words, not a question", () => {
    const { input } = renderXBar();

    fireEvent.change(input, { target: { value: "clear Cell 3 today" } });
    fireEvent.keyDown(input, { key: "Enter" });

    const dayLabel = formatDayLabel(new Date("2026-09-03T00:00:00Z"), "d_mon_yyyy", "UTC");
    expect(statusText()).toBe(`Cell 3 has nobody on it ${dayLabel}.`);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("CB-x-6: the model path decodes a 'replace' form into the same lot the rules would build", async () => {
    const replaceForm: ReplaceCommand = {
      intent: "replace",
      operator: "Sam",
      with: "Ana",
      place: ["Cell 1"],
      day: { kind: "today" },
      span: null,
      shift: null,
    };
    const fakeReader: Reader = vi.fn(async (): Promise<Reading> => ({
      ok: true,
      command: replaceForm,
      by: "model",
    }));
    const { input } = renderXBar({ assignments: [XSAM], runs: [RUN_X] }, fakeReader);

    fireEvent.change(input, { target: { value: "cover Sam with Ana on Cell 1 today" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(statusText()).toMatch(/^2 commands ready: /));
  });

  it("CB-x-7: a lot over six shows five and a count of the rest; six or fewer show every one", () => {
    const { input } = renderXBar({ assignments: spacedBlocksOnXC1(8) });

    fireEvent.change(input, { target: { value: "clear Cell 1 today" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText().startsWith("8 commands ready: 1. ")).toBe(true);
    expect(statusText()).toContain("… and 3 more");
    expect(statusText()).not.toContain("6. ");

    cleanup();

    const three = renderXBar({ assignments: spacedBlocksOnXC1(3) });
    fireEvent.change(three.input, { target: { value: "clear Cell 1 today" } });
    fireEvent.keyDown(three.input, { key: "Enter" });

    expect(statusText().startsWith("3 commands ready: 1. ")).toBe(true);
    expect(statusText()).toContain("3. ");
    expect(statusText()).not.toContain("more");
  });

  it("CB-x-8: 'assign Sam to Housing A on Cell 1 for the rest of the day' at 10:07 today rounds the start to 10:15", () => {
    const { onOpen, input } = renderXBar({ nowMinuteOfDay: 10 * 60 + 7 });

    fireEvent.change(input, {
      target: { value: "assign Sam to Housing A on Cell 1 for the rest of the day" },
    });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onOpen).toHaveBeenCalledTimes(1);
    const [resolved] = onOpen.mock.calls[0] as [ResolvedCommand, { x: number; y: number }];
    expect(resolved.range.startMin).toBe(3 * 1440 + 615);
    expect(statusText()).toContain("10:15");
  });

  // -----------------------------------------------------------------------
  // Reviewer (S55 lane D), 14 Sept follow-up: the brief's own cases (CB-x-1
  // to CB-x-8) prove the happy paths; these attack the seams -- a mid-lot
  // question answered into the LOT (never `heldRef`'s replace/swap form), an
  // ambiguous SECOND person on a replace/swap filling the right field, the
  // lot's own confirm/cancel/edit surface, the model path for `copy` and an
  // absence's `until`, the exact ceiling, and the same-block collision guard
  // read against a `swap` (which touches two DIFFERENT blocks, never one
  // twice).
  // -----------------------------------------------------------------------

  /** CB-x-9: Ana's own block on Cell 1, same hours as Sam's (XSAM) --
   *  "cover Sam with Ana" then asks `block_exists` for the assign step. */
  const XANA_EXISTING: ContextAssignment = {
    id: "xanaExisting",
    nodeId: "xc1",
    operatorId: "ana",
    productId: "ha",
    productName: "Housing A",
    startMin: 3 * 1440 + 600,
    endMin: 3 * 1440 + 840,
    label: "10:00–14:00",
    runId: null,
  };

  it("CB-x-9: the assign step of an expanded lot asks block_exists, numbered '2 of 2', and the answer substitutes into the LOT, not heldRef's replace form", async () => {
    const onRunLot = vi.fn(async (resolved: ResolvedAny[]): Promise<LotResult> => ({
      done: resolved.length,
      error: null,
    }));
    const { input } = renderXBar({ assignments: [XSAM, XANA_EXISTING], runs: [RUN_X] }, null, {
      onRunLot,
    });

    fireEvent.change(input, { target: { value: "cover Sam with Ana on Cell 1 today" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // Step 1 (the removal) resolves cleanly and the lot advances on its own
    // to step 2 (the assign), which stops on Ana's own overlapping block --
    // numbered against the LOT's two commands, never the single replace
    // sentence `heldRef` would have held pre-S55.
    expect(statusText()).toMatch(/^2 of 2: /);
    expect(statusText()).toContain("Ana");

    fireEvent.click(screen.getByRole("button", { name: "Separate block" }));

    // The answer re-resolved the LOT's own step 2 -- the lot is now whole,
    // not a fresh single-command question against the original sentence.
    expect(statusText()).toMatch(/^2 commands ready: /);

    fireEvent.click(screen.getByRole("button", { name: "Do all 2" }));
    await waitFor(() => expect(statusText()).toBe("Done: 2 commands."));

    expect(onRunLot).toHaveBeenCalledTimes(1);
    const [resolvedList] = onRunLot.mock.calls[0] as [ResolvedAny[]];
    expect(resolvedList.map((r) => r.intent)).toEqual(["unassign", "assign"]);
    const assignResolved = resolvedList[1] as ResolvedCommand;
    expect(assignResolved.operatorId).toBe("ana");
  });

  /** CB-mid-1 (F-152 review follow-up, 16 Sept): Sam's own block crosses
   *  midnight (a leftover, the John Kim shape) and `buildXCtx`'s own
   *  `shiftsAt` default (`() => []`) means it matches no band either --
   *  `expandReplace` asks `across_midnight` before ANY command is built, so
   *  the bar's status is the question text directly, never a lot. */
  const XSAM_OVERNIGHT: ContextAssignment = {
    id: "xsamOvernight",
    nodeId: "xc1",
    operatorId: "sam",
    productId: "ha",
    productName: "Housing A",
    startMin: 2 * 1440 + 1320, // yesterday (index 2) 22:00
    endMin: 3 * 1440 + 360, // today (index 3) 06:00
    label: "22:00–06:00",
    runId: null,
  };

  it("CB-mid-1: a replace on a block that crosses midnight and matches no shift -- the bar's own across_midnight text, never the hours twice", () => {
    const { input } = renderXBar({ assignments: [XSAM_OVERNIGHT] });

    fireEvent.change(input, { target: { value: "cover Sam with Ana on Cell 1 today" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toBe(
      "Sam's Housing A 22:00–06:00 block on Cell 1 crosses midnight and matches no shift; split it at midnight first, or say the shift.",
    );
  });

  /** CB-mid-2 (F-152-b, the window-edge follow-up, MN13's own scenario): a
   *  ONE-DAY board that starts TODAY -- the maintainer's own shape -- with
   *  John Kim's block starting the day before it (`clampedWallOf`, the top
   *  of this file, is what lets this fixture see the bug at all). */
  const ONE_DAY_XBOARD: BoardDay[] = [{ index: 0, iso: "2026-09-03", weekday: 4 }];
  const XJOHN_OVERNIGHT: ContextAssignment = {
    id: "xjohnOvernight",
    nodeId: "xc1",
    operatorId: "john",
    productId: "ha",
    productName: "Housing A",
    startMin: -1320, // yesterday 02:00 -- before the one-day window starts
    endMin: 360, // today 06:00
    label: "02:00–06:00",
    runId: null,
  };
  const XSAMP_PLAIN: ContextAssignment = {
    id: "xsampPlain",
    nodeId: "xc1",
    operatorId: "samp",
    productId: "ha",
    productName: "Housing A",
    startMin: 540, // 09:00
    endMin: 660, // 11:00
    label: "09:00–11:00",
    runId: null,
  };

  it("CB-mid-2: the lot's adjust step readout for MN13's first command -- John Kim's own compact 'ends 00:00, was 06:00', never a re-dated span", () => {
    const { input } = renderXBar({
      assignments: [XJOHN_OVERNIGHT, XSAMP_PLAIN],
      days: ONE_DAY_XBOARD,
      todayIndex: 0,
      operators: [
        { id: "john", displayName: "John Kim", employeeRef: null, active: true },
        { id: "samp", displayName: "Sam Patel", employeeRef: null, active: true },
      ],
    });

    fireEvent.change(input, { target: { value: "clear Cell 1 today" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toMatch(/^2 commands ready: /);
    expect(statusText()).toContain("1. John Kim · Cell 1 · ends 00:00, was 06:00");
  });

  it("CB-x-10: an ambiguous SECOND person on a replace fills `with`, never `operator`, and the lot appears once picked", () => {
    const { input } = renderXBar({
      assignments: [XSAM],
      operators: [
        { id: "op1", displayName: "Operator 1", employeeRef: "E100", active: true },
        { id: "sam", displayName: "Sam", employeeRef: null, active: true },
        { id: "ana", displayName: "Ana", employeeRef: null, active: true },
        { id: "anna", displayName: "Anna", employeeRef: null, active: true },
      ],
    });

    fireEvent.change(input, { target: { value: "cover Sam with An on Cell 1 today" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // "Sam" resolved without a question (there is only one); "An" matches
    // both Ana and Anna -- if the bar had wrongly compared `text` against
    // `command.with` (or defaulted to `operator`), this button would
    // overwrite the ALREADY-RESOLVED "Sam" instead of the ambiguous "An".
    expect(statusText()).toContain('"An" matches 2');
    expect(screen.getByRole("button", { name: "Ana" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Anna" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Ana" }));

    expect(input.value).toBe("cover Sam with Ana on Cell 1 today");
    expect(statusText()).toMatch(/^2 commands ready: /);
  });

  it("CB-x-11: an ambiguous SECOND person on a swap fills `other`, never `operator`", () => {
    const XANA_SWAP2: ContextAssignment = {
      id: "xanaSwap2",
      nodeId: "xc1",
      operatorId: "ana",
      productId: "hb",
      productName: "Housing B",
      startMin: 3 * 1440 + 840,
      endMin: 3 * 1440 + 960,
      label: "14:00–16:00",
      runId: null,
    };
    const XSAM_DIRECT: ContextAssignment = {
      id: "xsamDirect",
      nodeId: "xc1",
      operatorId: "sam",
      productId: "ha",
      productName: "Housing A",
      startMin: 3 * 1440 + 600,
      endMin: 3 * 1440 + 840,
      label: "10:00–14:00",
      runId: null,
    };
    const { input } = renderXBar({
      assignments: [XSAM_DIRECT, XANA_SWAP2],
      operators: [
        { id: "op1", displayName: "Operator 1", employeeRef: "E100", active: true },
        { id: "sam", displayName: "Sam", employeeRef: null, active: true },
        { id: "ana", displayName: "Ana", employeeRef: null, active: true },
        { id: "anna", displayName: "Anna", employeeRef: null, active: true },
      ],
    });

    fireEvent.change(input, { target: { value: "swap Sam and An on Cell 1 today" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toContain('"An" matches 2');
    fireEvent.click(screen.getByRole("button", { name: "Ana" }));

    expect(input.value).toBe("swap Sam and Ana on Cell 1 today");
    expect(statusText()).toMatch(/^4 commands ready: /);
  });

  it("CB-x-12: Escape, a cancel word and a typed edit each drop an EXPANDED lot exactly as a raw several does (S51 CB-lot-7, replayed over expandCommand)", () => {
    function reachExpandedLot() {
      const rendered = renderXBar({ assignments: [XBLK1, XBLK2] });
      fireEvent.change(rendered.input, { target: { value: "clear Cell 1 today" } });
      fireEvent.keyDown(rendered.input, { key: "Enter" });
      expect(statusText()).toMatch(/^2 commands ready: /);
      return rendered;
    }

    // no
    const first = reachExpandedLot();
    let { input, onHighlight } = first;
    const { onRunLot } = first;
    fireEvent.change(input, { target: { value: "no" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(statusText()).toBe("");
    expect(input.value).toBe("");
    expect(onHighlight).toHaveBeenLastCalledWith(null);
    expect(onRunLot).not.toHaveBeenCalled();

    cleanup();

    // Escape
    ({ input, onHighlight } = reachExpandedLot());
    fireEvent.keyDown(input, { key: "Escape" });
    expect(statusText()).toBe("");
    expect(onHighlight).toHaveBeenLastCalledWith(null);

    cleanup();

    // a typed edit -- a brand-new sentence works right after
    ({ input } = reachExpandedLot());
    fireEvent.change(input, { target: { value: "something else entirely" } });
    expect(statusText()).toBe("");
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("CB-x-13: the model path decodes a 'copy' form into the same lot the rules would build", async () => {
    const XYESTERDAY_BLK2: ContextAssignment = {
      id: "xyblk2",
      nodeId: "xc1",
      operatorId: "sam",
      productId: "ha",
      productName: "Housing A",
      startMin: 2 * 1440 + 840,
      endMin: 2 * 1440 + 960,
      label: "14:00–16:00",
      runId: null,
    };
    const copyForm: CopyCommand = {
      intent: "copy",
      place: ["Cell 1"],
      from: { kind: "yesterday" },
      to: { kind: "today" },
    };
    const fakeReader: Reader = vi.fn(async (): Promise<Reading> => ({
      ok: true,
      command: copyForm,
      by: "model",
    }));
    const { input } = renderXBar({ assignments: [XYESTERDAY_BLK, XYESTERDAY_BLK2] }, fakeReader);

    fireEvent.change(input, { target: { value: "copy yesterday to today for Cell 1" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(statusText()).toMatch(/^2 commands ready: /));
  });

  it("CB-x-14: the model path decodes an unassign with `until` (an absence) into the same lot the rules would build", async () => {
    const XSAM_TODAY: ContextAssignment = {
      id: "xsamToday",
      nodeId: "xc1",
      operatorId: "sam",
      productId: "ha",
      productName: "Housing A",
      startMin: 3 * 1440 + 600,
      endMin: 3 * 1440 + 840,
      label: "10:00–14:00",
      runId: null,
    };
    const XSAM_TOMORROW: ContextAssignment = {
      ...XSAM_TODAY,
      id: "xsamTomorrow",
      startMin: 4 * 1440 + 600,
      endMin: 4 * 1440 + 840,
    };
    const untilForm: UnassignCommand = {
      intent: "unassign",
      operator: "Sam",
      place: [],
      day: { kind: "today" },
      span: null,
      existing: null,
      shift: null,
      until: { kind: "tomorrow" },
    };
    const fakeReader: Reader = vi.fn(async (): Promise<Reading> => ({
      ok: true,
      command: untilForm,
      by: "model",
    }));
    const { input } = renderXBar({ assignments: [XSAM_TODAY, XSAM_TOMORROW] }, fakeReader);

    fireEvent.change(input, { target: { value: "Sam is off from today until tomorrow" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(statusText()).toMatch(/^2 commands ready: /));
  });

  it("CB-x-15: exactly 100 is a lot (shows five and '… and 95 more'); 101 is still the refusal (CB-x-4)", () => {
    const { input } = renderXBar({
      assignments: manyBlocksOnXC1(100).map((b, i) => ({
        ...b,
        endMin: b.startMin + 15,
        label: `block ${i}`,
      })),
    });

    fireEvent.change(input, { target: { value: "clear Cell 1 today" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText().startsWith("100 commands ready: 1. ")).toBe(true);
    expect(statusText()).toContain("… and 95 more");
    expect(screen.getByRole("button", { name: "Do all 100" })).toBeTruthy();
  });

  it("CB-x-16: 'swap' writes two removals and two assigns on TWO DIFFERENT blocks -- the same-block collision refusal (S51 review fix) must never fire", async () => {
    const XANA_SWAP: ContextAssignment = {
      id: "xanaSwap",
      nodeId: "xc1",
      operatorId: "ana",
      productId: "hb",
      productName: "Housing B",
      startMin: 3 * 1440 + 840,
      endMin: 3 * 1440 + 960,
      label: "14:00–16:00",
      runId: null,
    };
    const XSAM_DIRECT: ContextAssignment = {
      id: "xsamDirect2",
      nodeId: "xc1",
      operatorId: "sam",
      productId: "ha",
      productName: "Housing A",
      startMin: 3 * 1440 + 600,
      endMin: 3 * 1440 + 840,
      label: "10:00–14:00",
      runId: null,
    };
    const onRunLot = vi.fn(async (resolved: ResolvedAny[]): Promise<LotResult> => ({
      done: resolved.length,
      error: null,
    }));
    const { input } = renderXBar({ assignments: [XSAM_DIRECT, XANA_SWAP] }, null, { onRunLot });

    fireEvent.change(input, { target: { value: "swap Sam and Ana on Cell 1 today" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toMatch(/^4 commands ready: /);
    expect(statusText()).not.toContain("name the same block");

    fireEvent.click(screen.getByRole("button", { name: "Do all 4" }));
    await waitFor(() => expect(statusText()).toBe("Done: 4 commands."));
    expect(onRunLot).toHaveBeenCalledTimes(1);
  });

  it("CB-x-17: 'clear Cell 1 today' with nobody there is a plain readout, never the same-block collision message (no duplicates from an empty expansion)", () => {
    const { input, onRunLot } = renderXBar();

    fireEvent.change(input, { target: { value: "clear Cell 1 today" } });
    fireEvent.keyDown(input, { key: "Enter" });

    const dayLabel = formatDayLabel(new Date("2026-09-03T00:00:00Z"), "d_mon_yyyy", "UTC");
    expect(statusText()).toBe(`Cell 1 has nobody on it ${dayLabel}.`);
    expect(statusText()).not.toContain("name the same block");
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(onRunLot).not.toHaveBeenCalled();
  });
});

/** CB-y-7: a SECOND Housing A job on Cell 1 (xc1), later in the day than
 *  RUN_X's own 08:00-16:00 -- the fixture "the job's hours" must refuse to
 *  guess between. */
const RUN_X2: ContextRun = {
  id: "runX2",
  nodeId: "xc1",
  productId: "ha",
  startMin: 3 * 1440 + 960,
  endMin: 3 * 1440 + 1200,
  label: "Housing A 16:00–20:00",
  span: "16:00–20:00",
  productName: "Housing A",
  headcount: 2,
};

describe("CB-y: group 2 of the catalogue -- adjust, split, the job's hours, a headcount, every weekday (S58, D132)", () => {
  it("CB-y-1: 'split Sam's block at noon' is a lot of two (move, then assign), both outlined, one yes runs them in order", async () => {
    const onRunLot = vi.fn(async (resolved: ResolvedAny[]): Promise<LotResult> => ({
      done: resolved.length,
      error: null,
    }));
    const { input } = renderXBar({ assignments: [XSAM], runs: [RUN_X] }, null, { onRunLot });

    fireEvent.change(input, { target: { value: "split Sam's block at noon" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toMatch(/^2 commands ready: /);

    fireEvent.click(screen.getByRole("button", { name: "Do all 2" }));
    await waitFor(() => expect(statusText()).toBe("Done: 2 commands."));

    expect(onRunLot).toHaveBeenCalledTimes(1);
    const [resolvedList] = onRunLot.mock.calls[0] as [ResolvedAny[]];
    expect(resolvedList.map((r) => r.intent)).toEqual(["move", "assign"]);
  });

  it("CB-y-2: 'assign Sam to Housing A on Cell 1 every weekday this week 8 to 4' is a lot of five", async () => {
    const onRunLot = vi.fn(async (resolved: ResolvedAny[]): Promise<LotResult> => ({
      done: resolved.length,
      error: null,
    }));
    const { input } = renderXBar({}, null, { onRunLot });

    fireEvent.change(input, {
      target: { value: "assign Sam to Housing A on Cell 1 every weekday this week 8 to 4" },
    });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toMatch(/^5 commands ready: /);
    expect(screen.getByRole("button", { name: "Do all 5" })).toBeTruthy();
  });

  it("CB-y-3: 'extend Sam's block by an hour' is the single move path, the adjust's own compact readout (F-152-b: names just the moved edge, never the whole block's arrow)", () => {
    const { onMove, input } = renderXBar({ assignments: [XSAM] });

    fireEvent.change(input, { target: { value: "extend Sam's block by an hour" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onMove).toHaveBeenCalledTimes(1);
    const [resolved] = onMove.mock.calls[0] as [ResolvedMove, { x: number; y: number }];
    expect(resolved.target).toEqual({ kind: "retime" });
    expect(resolved.range).toEqual({ startMin: 3 * 1440 + 600, endMin: 3 * 1440 + 900 });
    expect(statusText()).toContain("Sam · Cell 1 · ends 15:00, was 14:00");
  });

  it("CB-y-4: 'make the Housing A job on Cell 1 4 people' calls onSetHeadcount with the run and the number, and shows the readout", () => {
    const { onSetHeadcount, input } = renderXBar({ runs: [RUN_X] });

    fireEvent.change(input, { target: { value: "make the Housing A job on Cell 1 4 people" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSetHeadcount).toHaveBeenCalledTimes(1);
    const [resolved] = onSetHeadcount.mock.calls[0] as [
      ResolvedHeadcount,
      { x: number; y: number },
    ];
    expect(resolved.runId).toBe("runX");
    expect(resolved.headcount).toBe(4);
    expect(statusText()).toContain("4 people");
  });

  it("CB-y-5: 'make it 4 people' has no memory of \"it\" -- the grammar asks for the job's own name, nothing resolves", () => {
    const { onSetHeadcount, input } = renderXBar({ runs: [RUN_X] });

    fireEvent.change(input, { target: { value: "make it 4 people" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toBe(`Say which job — "make the Housing A job on Cell 1 4 people".`);
    expect(onSetHeadcount).not.toHaveBeenCalled();
  });

  it("CB-y-6: 'add Sam to the Housing A job on Cell 1' resolves an assign with the run target and the run's own hours", () => {
    const { onOpen, input } = renderXBar({ runs: [RUN_X] });

    fireEvent.change(input, { target: { value: "add Sam to the Housing A job on Cell 1" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onOpen).toHaveBeenCalledTimes(1);
    const [resolved] = onOpen.mock.calls[0] as [ResolvedCommand, { x: number; y: number }];
    expect(resolved.target).toEqual({ kind: "run", runId: "runX" });
    expect(resolved.range).toEqual({ startMin: 3 * 1440 + 480, endMin: 3 * 1440 + 960 });
  });

  it("CB-y-7: 'add Sam to the Housing A job on Cell 1' with two such jobs asks which, naming their hours", () => {
    const { onOpen, input } = renderXBar({ runs: [RUN_X, RUN_X2] });

    fireEvent.change(input, { target: { value: "add Sam to the Housing A job on Cell 1" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toBe(
      "Housing A runs more than once on Cell 1: 08:00–16:00, 16:00–20:00. Say the hours.",
    );
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("CB-y-8: the model path decodes a headcount form and reaches onSetHeadcount, same as the rules", async () => {
    const headcountForm: HeadcountCommand = {
      intent: "headcount",
      product: "Housing A",
      place: ["Cell 1"],
      day: null,
      span: null,
      shift: null,
      headcount: 5,
    };
    const fakeReader: Reader = vi.fn(async (): Promise<Reading> => ({
      ok: true,
      command: headcountForm,
      by: "model",
    }));
    const { onSetHeadcount, input } = renderXBar({ runs: [RUN_X] }, fakeReader);

    fireEvent.change(input, { target: { value: "make the Housing A job on Cell 1 5 people" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(onSetHeadcount).toHaveBeenCalledTimes(1));
    const [resolved] = onSetHeadcount.mock.calls[0] as [
      ResolvedHeadcount,
      { x: number; y: number },
    ];
    expect(resolved.runId).toBe("runX");
    expect(resolved.headcount).toBe(5);
  });

  /** CB-y-9's own second Sam block, GENUINELY separate from XSAM -- same
   *  cell, same product, overlapping the split's own SECOND half (noon-14:00)
   *  but not the split point itself (13:00 is not within XSAM's 10:00-14:00
   *  test point noon), so `expandSplit`'s own `at`-containment picks XSAM
   *  unambiguously. */
  const XSAM_OTHER: ContextAssignment = {
    id: "xsamOther",
    nodeId: "xc1",
    operatorId: "sam",
    productId: "ha",
    productName: "Housing A",
    startMin: 3 * 1440 + 780, // 13:00
    endMin: 3 * 1440 + 900, // 15:00
    label: "13:00–15:00",
    runId: null,
  };

  it("CB-y-9: a split whose second half overlaps ANOTHER of Sam's own blocks asks block_exists naming that OTHER block, and the answer completes the lot (S58-e, R-413 -- was: existing:'separate' skipped R-385 unconditionally, not only for the split's own shrinking first half; re-pinned to the right behaviour after the fix moved into resolve.ts)", async () => {
    const onRunLot = vi.fn(async (resolved: ResolvedAny[]): Promise<LotResult> => ({
      done: resolved.length,
      error: null,
    }));
    const { input } = renderXBar({ assignments: [XSAM, XSAM_OTHER], runs: [RUN_X] }, null, {
      onRunLot,
    });

    fireEvent.change(input, { target: { value: "split Sam's block at noon" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // Step 1 (the move, XSAM's own first half) resolves cleanly and the lot
    // advances on its own to step 2 (the assign), which stops on xsamOther --
    // a genuine second overlapping block of the same person/part/cell, never
    // exempted by `separate_from` (only XSAM, the block being split, is).
    expect(statusText()).toMatch(/^2 of 2: /);
    expect(statusText()).toContain("13:00–15:00");

    fireEvent.click(screen.getByRole("button", { name: "Separate block" }));

    // The answer re-resolved the LOT's own step 2 -- the lot is now whole.
    expect(statusText()).toMatch(/^2 commands ready: /);

    fireEvent.click(screen.getByRole("button", { name: "Do all 2" }));
    await waitFor(() => expect(statusText()).toBe("Done: 2 commands."));

    const [resolvedList] = onRunLot.mock.calls[0] as [ResolvedAny[]];
    expect(resolvedList.map((r) => r.intent)).toEqual(["move", "assign"]);
    const assignStep = resolvedList[1];
    if (assignStep.intent === "assign") {
      // Written onto runX, 12:00-14:00, deliberately alongside xsamOther --
      // the person answered "separate", not silence.
      expect(assignStep.target).toEqual({ kind: "run", runId: "runX" });
    } else {
      throw new Error("expected the second lot step to be an assign");
    }
  });

  it("CB-y-10: reviewer scenario 2 -- the split's own move step never asks move_which, even when Sam has TWO blocks on the split's cell, because expandSplit already chose the block by `at`", async () => {
    // Sam has two Housing A blocks on Cell 1 today: XSAM (10:00-14:00,
    // contains noon) and a second one that does NOT contain noon -- if
    // `expandSplit` did not pre-fill `existing` from `at`'s own containment
    // check, `resolveMoveCommand` would see two hits on this cell and ask
    // move_which for the FIRST lot step (the shorten) before ever reaching
    // the second (the assign, built from `blk` -- whichever the answer
    // implied). Proving that never happens is the point of this pin.
    const XSAM_LATER: ContextAssignment = {
      id: "xsamLater",
      nodeId: "xc1",
      operatorId: "sam",
      productId: "ha",
      productName: "Housing A",
      startMin: 3 * 1440 + 960, // 16:00
      endMin: 3 * 1440 + 1140, // 19:00
      label: "16:00–19:00",
      runId: "runX",
    };
    const onRunLot = vi.fn(async (resolved: ResolvedAny[]): Promise<LotResult> => ({
      done: resolved.length,
      error: null,
    }));
    const { input } = renderXBar({ assignments: [XSAM, XSAM_LATER], runs: [RUN_X] }, null, {
      onRunLot,
    });

    fireEvent.change(input, { target: { value: "split Sam's block at noon" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // Straight to the lot's own "2 commands ready" -- no "Move which?"
    // detour, no numbered "1 of 2: ..." question standing in the way.
    expect(statusText()).toMatch(/^2 commands ready: /);
    expect(statusText()).not.toMatch(/move which/i);

    fireEvent.click(screen.getByRole("button", { name: "Do all 2" }));
    await waitFor(() => expect(statusText()).toBe("Done: 2 commands."));
    const [resolvedList] = onRunLot.mock.calls[0] as [ResolvedAny[]];
    expect(resolvedList.map((r) => r.intent)).toEqual(["move", "assign"]);
    const moveStep = resolvedList[0];
    if (moveStep.intent === "move") {
      expect(moveStep.assignmentId).toBe("xsam"); // the block containing noon, not xsamLater
    } else {
      throw new Error("expected the first lot step to be a move");
    }
  });

  it("CB-y-11: reviewer scenario 3 -- 'extend Sam's block by an hour' with Sam on TWO cells asks move_which naming both, the pick substitutes and the readout shows the adjust's own compact form", () => {
    const XSAM2: ContextAssignment = {
      id: "xsam2",
      nodeId: "xc2",
      operatorId: "sam",
      productId: "ha",
      productName: "Housing A",
      startMin: 3 * 1440 + 960, // 16:00
      endMin: 3 * 1440 + 1200, // 20:00
      label: "16:00–20:00",
      runId: null,
    };
    const { onMove, input } = renderXBar({ assignments: [XSAM, XSAM2] });

    fireEvent.change(input, { target: { value: "extend Sam's block by an hour" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toContain("Move which?");
    const button = screen.getByRole("button", { name: /Cell 1.*10:00–14:00/ });
    fireEvent.click(button);

    expect(onMove).toHaveBeenCalledTimes(1);
    const [resolved] = onMove.mock.calls[0] as [ResolvedMove, { x: number; y: number }];
    expect(resolved.target).toEqual({ kind: "retime" });
    expect(resolved.range).toEqual({ startMin: 3 * 1440 + 600, endMin: 3 * 1440 + 900 });
    expect(statusText()).toContain("Sam · Cell 1 · ends 15:00, was 14:00");
  });

  it("CB-y-12: reviewer scenario 4 -- the headcount readout shows immediately on Enter regardless of the async write's own outcome (fire-and-forget, same shape as onRetime/onUnassign/onMove); a later mutation failure surfaces through the toast useDragGesture's own failWith writes, never the bar's status -- ACCEPTABLE, matches every other single-write intent", () => {
    const { onSetHeadcount, input } = renderXBar({ runs: [RUN_X] });

    fireEvent.change(input, { target: { value: "make the Housing A job on Cell 1 4 people" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // The readout is shown SYNCHRONOUSLY, before `onSetHeadcount`'s own
    // (async, void) write could possibly have settled either way -- the bar
    // has no promise to await here, unlike `onRunLot`'s lot path.
    expect(onSetHeadcount).toHaveBeenCalledTimes(1);
    expect(statusText()).toContain("4 people");
    // The input is never cleared for a single (non-lot) write -- success or
    // failure look identical from here; only `onRunLot`'s own lot path
    // clears the input on a clean "Done".
    expect(input.value).toBe("make the Housing A job on Cell 1 4 people");
  });

  it("CB-y-13: reviewer scenario 5 -- 'make the Housing A job on Cell 1 4 people' typed and run twice is a plain write both times, no dedupe", () => {
    const { onSetHeadcount, input } = renderXBar({ runs: [RUN_X] });

    fireEvent.change(input, { target: { value: "make the Housing A job on Cell 1 4 people" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: "make the Housing A job on Cell 1 4 people" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSetHeadcount).toHaveBeenCalledTimes(2);
    const [first] = onSetHeadcount.mock.calls[0] as [ResolvedHeadcount, { x: number; y: number }];
    const [second] = onSetHeadcount.mock.calls[1] as [ResolvedHeadcount, { x: number; y: number }];
    expect(first).toEqual(second);
  });

  it("CB-y-14: reviewer scenario 6a -- the model path decodes a 'split' form and reaches the lot, same as the rules (CB-y-1)", async () => {
    const decodedSplit: SplitCommand = {
      intent: "split",
      operator: "Sam",
      place: [],
      day: null,
      at: { hour: 12, minute: 0 },
    };
    const fakeReader: Reader = vi.fn(async (): Promise<Reading> => ({
      ok: true,
      command: decodedSplit,
      by: "model",
    }));
    const onRunLot = vi.fn(async (resolved: ResolvedAny[]): Promise<LotResult> => ({
      done: resolved.length,
      error: null,
    }));
    const { input } = renderXBar({ assignments: [XSAM], runs: [RUN_X] }, fakeReader, { onRunLot });

    fireEvent.change(input, { target: { value: "split Sam's block at noon" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(statusText()).toMatch(/^2 commands ready: /));
  });

  it("CB-y-15: reviewer scenario 6b -- the model path decodes a move with `adjust` set and reaches the single move path, same as the rules (CB-y-3)", async () => {
    const decodedAdjustMove: MoveCommand = {
      intent: "move",
      operator: "Sam",
      place: [],
      toPlace: null,
      day: null,
      span: null,
      existing: null,
      shift: null,
      adjust: { edge: "end", by: 60 },
    };
    const fakeReader: Reader = vi.fn(async (): Promise<Reading> => ({
      ok: true,
      command: decodedAdjustMove,
      by: "model",
    }));
    const { onMove, input } = renderXBar({ assignments: [XSAM] }, fakeReader);

    fireEvent.change(input, { target: { value: "extend Sam's block by an hour" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(onMove).toHaveBeenCalledTimes(1));
    const [resolved] = onMove.mock.calls[0] as [ResolvedMove, { x: number; y: number }];
    expect(resolved.target).toEqual({ kind: "retime" });
    expect(resolved.range).toEqual({ startMin: 3 * 1440 + 600, endMin: 3 * 1440 + 900 });
  });

  it("CB-y-16: reviewer scenario 6c -- a decoded 'headcount' form embedded in a several is garbled: the decoder's own job to prevent, but the bar must not freeze on 'Reading…' if one slips through", async () => {
    const garbledHeadcountInSeveral = {
      intent: "several",
      commands: [
        {
          intent: "headcount",
          product: "Housing A",
          place: ["Cell 1"],
          day: null,
          span: null,
          shift: null,
          headcount: 4,
        } as unknown as SingleCommand,
      ],
    } as SeveralCommand;
    const fakeReader: Reader = vi.fn(async (): Promise<Reading> => ({
      ok: true,
      command: garbledHeadcountInSeveral,
      by: "model",
    }));
    const { onSetHeadcount, onRunLot, input } = renderXBar({ runs: [RUN_X] }, fakeReader);

    fireEvent.change(input, { target: { value: "make the Housing A job on Cell 1 4 people" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(statusText()).toBe(
        "I could not read that as several commands. Say them one at a time.",
      ),
    );
    expect(onSetHeadcount).not.toHaveBeenCalled();
    expect(onRunLot).not.toHaveBeenCalled();
  });

  it("CB-y-17: reviewer scenario 7 -- Escape clears each of the five new group-2 questions", () => {
    // adjust_inverts: shortening past the block's own start.
    {
      const { input } = renderXBar({ assignments: [XSAM] });
      fireEvent.change(input, { target: { value: "shorten Sam's block by 5 hours" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(statusText()).toContain("would end before it starts");
      fireEvent.keyDown(input, { key: "Escape" });
      expect(statusText()).toBe("");
    }
    // adjust_off_day: extending past the day's own end.
    cleanup();
    {
      const { input } = renderXBar({ assignments: [XSAM] });
      fireEvent.change(input, { target: { value: "extend Sam's block by 20 hours" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(statusText()).toContain("would leave the day");
      fireEvent.keyDown(input, { key: "Escape" });
      expect(statusText()).toBe("");
    }
    // split_outside: a split point not inside any of Sam's blocks.
    cleanup();
    {
      const { input } = renderXBar({ assignments: [XSAM] });
      fireEvent.change(input, { target: { value: "split Sam's block at 3am" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(statusText()).toContain("is outside");
      fireEvent.keyDown(input, { key: "Escape" });
      expect(statusText()).toBe("");
    }
    // no_job: "the job's hours" with no run of that product on that cell.
    cleanup();
    {
      const { input } = renderXBar({});
      fireEvent.change(input, {
        target: { value: "add Sam to the Housing A job on Cell 1" },
      });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(statusText()).toContain("There is no");
      fireEvent.keyDown(input, { key: "Escape" });
      expect(statusText()).toBe("");
    }
    // which_job: two runs of the same product on the same cell.
    cleanup();
    {
      const { input } = renderXBar({ runs: [RUN_X, RUN_X2] });
      fireEvent.change(input, {
        target: { value: "add Sam to the Housing A job on Cell 1" },
      });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(statusText()).toContain("runs more than once");
      fireEvent.keyDown(input, { key: "Escape" });
      expect(statusText()).toBe("");
    }
  });

  it("CB-y-18: reviewer scenario 8 -- 'add Sam to the Housing A job on Cell 1' when Sam is already in it asks block_exists, and the retime answer works", () => {
    const { onRetime, input } = renderXBar({ assignments: [XSAM], runs: [RUN_X] });

    fireEvent.change(input, { target: { value: "add Sam to the Housing A job on Cell 1" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toContain("already");
    const changeButton = screen.getByRole("button", { name: /^Change /i });
    fireEvent.click(changeButton);

    expect(onRetime).toHaveBeenCalledTimes(1);
    const [resolved] = onRetime.mock.calls[0] as [ResolvedCommand, { x: number; y: number }];
    if (resolved.target.kind !== "retime") throw new Error("expected a retime target");
    expect(resolved.target.assignmentId).toBe("xsam");
    expect(resolved.range).toEqual({ startMin: 3 * 1440 + 480, endMin: 3 * 1440 + 960 });
  });

  it("CB-y-19: reviewer scenario 11a -- a five-command weekday lot lists all five, no '... and N more'", async () => {
    const onRunLot = vi.fn(async (resolved: ResolvedAny[]): Promise<LotResult> => ({
      done: resolved.length,
      error: null,
    }));
    const { input } = renderXBar({}, null, { onRunLot });

    fireEvent.change(input, {
      target: { value: "assign Sam to Housing A on Cell 1 every weekday this week 8 to 4" },
    });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toMatch(/^5 commands ready: /);
    expect(statusText()).not.toMatch(/and \d+ more/);
    expect(statusText()).toMatch(/^5 commands ready: 1\. .+; 2\. .+; 3\. .+; 4\. .+; 5\. .+ — say/);
  });

  it("CB-y-20: reviewer scenario 11b -- a seven-command every-day lot shows five and '… and 2 more'", async () => {
    const onRunLot = vi.fn(async (resolved: ResolvedAny[]): Promise<LotResult> => ({
      done: resolved.length,
      error: null,
    }));
    const { input } = renderXBar({}, null, { onRunLot });

    fireEvent.change(input, {
      target: { value: "assign Sam to Housing A on Cell 1 every day this week 8 to 4" },
    });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toMatch(/^7 commands ready: /);
    expect(statusText()).toContain("… and 2 more");
    expect(screen.getByRole("button", { name: "Do all 7" })).toBeTruthy();
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

// S59 (F-150, design §19.104/D133 item 2, brief docs/agent-briefs/s59-b-bar-brief.md
// §2): "the confirm words were the developer's, not the floor's" -- the
// maintainer said "yeah" to a one-block question and nothing happened, and had
// to click the button for a lot's own "yes". `normalizeWord` also now strips
// punctuation ANYWHERE, not only trailing, so a recogniser's "Yes." matches.
describe("CB-confirm: the floor's own confirm/cancel words (S59, F-150)", () => {
  // S60-b (the S59 reviewer, 15 Sept): "right" is WITHDRAWN from this list --
  // it is a floor filler word ("right, so...") that would confirm a standing
  // REMOVAL question the person never meant to say yes to, so it is no
  // longer in `UNIVERSAL_CONFIRM_WORDS` at all. See CB-confirm-4 below,
  // re-pinned, and CB-confirm-5, new, for what "right" does now.
  const NEW_CONFIRM_WORDS = [
    "yeah",
    "yep",
    "yup",
    "sure",
    "okay",
    "go ahead",
    "go on",
    "correct",
    "yes yes",
  ];
  const NEW_CANCEL_WORDS = ["nope", "nah", "never mind", "forget it"];

  for (const word of NEW_CONFIRM_WORDS) {
    it(`CB-confirm-1 ("${word}"): confirms a one-block question`, () => {
      const { input, onUnassign } = renderBar({ assignments: [BLK1] });
      fireEvent.change(input, { target: { value: UNASSIGN_SENTENCE } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(screen.getByRole("button", { name: "Remove it" })).toBeTruthy();

      fireEvent.change(input, { target: { value: word } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(onUnassign).toHaveBeenCalledTimes(1);
      const [resolved] = onUnassign.mock.calls[0] as [ResolvedUnassign, { x: number; y: number }];
      expect(resolved.assignmentId).toBe("blk1");
    });
  }

  for (const word of NEW_CONFIRM_WORDS) {
    it(`CB-confirm-2 ("${word}"): confirms a lot`, () => {
      const onRunLot = vi.fn(async (resolved: ResolvedAny[]): Promise<LotResult> => ({
        done: resolved.length,
        error: null,
      }));
      const { input } = renderBar({ assignments: [BLK1, BLK_SP] }, null, null, {}, { onRunLot });

      fireEvent.change(input, { target: { value: LOT_REMOVE_SENTENCE } });
      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
      fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
      expect(statusText()).toMatch(/^2 commands ready: /);

      fireEvent.change(input, { target: { value: word } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(onRunLot).toHaveBeenCalledTimes(1);
    });
  }

  it('CB-confirm-3: "Yes." from a recognised final result (capitalised, trailing period) runs the lot', async () => {
    const onRunLot = vi.fn(async (resolved: ResolvedAny[]): Promise<LotResult> => ({
      done: resolved.length,
      error: null,
    }));
    const { recognizer, fire } = makeFakeRecognizer();
    const { input } = renderBar(
      { assignments: [BLK1, BLK_SP] },
      null,
      recognizer,
      {},
      { onRunLot },
    );

    fireEvent.change(input, { target: { value: LOT_REMOVE_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    expect(statusText()).toMatch(/^2 commands ready: /);

    fireEvent.click(screen.getByRole("button", { name: "Speak a sentence" }));
    fire.final("Yes.");

    await waitFor(() => expect(onRunLot).toHaveBeenCalledTimes(1));
  });

  // Re-pinned (S60-b, the S59 reviewer, 15 Sept): this used to use "right" as
  // its confirm word, exercising "the first word of a longer sentence is not
  // a confirm" against a word that WAS then in `UNIVERSAL_CONFIRM_WORDS`.
  // "right" is withdrawn from that set now (a floor filler, never meant as a
  // yes -- see the describe block's own comment), so the same property is
  // pinned with "yeah" instead; CB-confirm-5, new below, covers "right"
  // itself.
  it('CB-confirm-4: "yeah" as the FIRST word of a longer sentence is not a confirm -- only the whole normalised transcript equal to a confirm word is', () => {
    const { input, onUnassign } = renderBar({ assignments: [BLK1] });
    fireEvent.change(input, { target: { value: UNASSIGN_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("button", { name: "Remove it" })).toBeTruthy();

    fireEvent.change(input, { target: { value: "yeah, put Sam on Cell 1" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onUnassign).not.toHaveBeenCalled();
  });

  // CB-confirm-5 (S60-b, the S59 reviewer, 15 Sept): "right" alone no longer
  // confirms a standing removal question -- it is neither a confirm nor a
  // cancel candidate any more, so it falls through to the ordinary parse
  // path exactly like any other word that means nothing here, and "right"
  // parses as no known sentence (the usual shape hint), never as a yes.
  it('CB-confirm-5: "right" alone no longer confirms a standing question', () => {
    const { input, onUnassign } = renderBar({ assignments: [BLK1] });
    fireEvent.change(input, { target: { value: UNASSIGN_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("button", { name: "Remove it" })).toBeTruthy();

    fireEvent.change(input, { target: { value: "right" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onUnassign).not.toHaveBeenCalled();
    expect(statusText()).toBe(SHAPE);
  });

  for (const word of NEW_CANCEL_WORDS) {
    it(`CB-confirm-5 ("${word}"): cancels a one-block question`, () => {
      const { input, onUnassign } = renderBar({ assignments: [BLK1] });
      fireEvent.change(input, { target: { value: UNASSIGN_SENTENCE } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(screen.getByRole("button", { name: "Remove it" })).toBeTruthy();

      fireEvent.change(input, { target: { value: word } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(statusText()).toBe("");
      expect(onUnassign).not.toHaveBeenCalled();
    });
  }

  it('CB-confirm-6: punctuation is stripped anywhere, not only trailing -- "Yeah," / "OKAY!" / "  yes  ." all confirm', () => {
    for (const word of ["Yeah,", "OKAY!", "  yes  ."]) {
      const { input, onUnassign } = renderBar({ assignments: [BLK1] });
      fireEvent.change(input, { target: { value: UNASSIGN_SENTENCE } });
      fireEvent.keyDown(input, { key: "Enter" });

      fireEvent.change(input, { target: { value: word } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(onUnassign).toHaveBeenCalledTimes(1);
      cleanup();
    }
  });
});

// S59 (R-419, design §19.104/D133 item 3, brief §3): "a day off the board is
// one button away" -- the day-off-board question gains "Show that day",
// which hands `onShowDay` the target verbatim and, once the caller's window
// move lands as a NEW `ctx` prop, re-runs the held command.
describe("CB-showday: Show that day (S59, R-419)", () => {
  const YESTERDAY_SENTENCE =
    "assign Operator 1 to Housing A on Cell 1 in Line 1 from 10 to 2 yesterday";
  const FRIDAY_SENTENCE =
    "assign Operator 1 to Housing A on Cell 1 in Line 1 from 10 to 2 on Friday";
  const FAR_DATE_SENTENCE =
    "assign Operator 1 to Housing A on Cell 1 in Line 1 from 10 to 2 2026-09-25";

  /** Monday-Wednesday only (narrower than the default 7-day fixture) --
   *  Friday (weekday 5) is off it. */
  const MON_WED_DAYS = [
    { index: 0, iso: "2026-08-31", weekday: 1 as const },
    { index: 1, iso: "2026-09-01", weekday: 2 as const },
    { index: 2, iso: "2026-09-02", weekday: 3 as const },
  ];

  /** The default fixture's own week, shifted back one calendar day -- the
   *  SHAPE `commandCtx` would take once `shiftWindowByDays(-1)`'s new window
   *  data has landed (this file drives `CommandBar` alone; the real axis
   *  arithmetic is `BoardPage`'s, not pinned here). Today (originally index
   *  0) is now index 1, so "yesterday" (index 0, 2026-08-30) is on the board. */
  const SHIFTED_BACK_ONE_DAY = [
    { index: 0, iso: "2026-08-30", weekday: 0 as const },
    { index: 1, iso: "2026-08-31", weekday: 1 as const },
    { index: 2, iso: "2026-09-01", weekday: 2 as const },
    { index: 3, iso: "2026-09-02", weekday: 3 as const },
    { index: 4, iso: "2026-09-03", weekday: 4 as const },
    { index: 5, iso: "2026-09-04", weekday: 5 as const },
    { index: 6, iso: "2026-09-05", weekday: 6 as const },
    { index: 7, iso: "2026-09-06", weekday: 0 as const },
  ];

  it("CB-showday-1: the button appears only on a day_off_board question", () => {
    const ambiguous = renderBar();
    fireEvent.change(ambiguous.input, {
      target: { value: "assign Sam to Housing A on Cell 1 in Line 1 from 10 to 2" },
    });
    fireEvent.keyDown(ambiguous.input, { key: "Enter" });
    expect(statusText()).toBe('Which person? "Sam" matches 2:');
    expect(screen.queryByRole("button", { name: "Show that day" })).toBeNull();
    cleanup();

    const { input } = renderBar({ todayIndex: 0 });
    fireEvent.change(input, { target: { value: YESTERDAY_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(statusText()).toBe("yesterday is not on the board. Move the board to that day first.");
    expect(screen.getByRole("button", { name: "Show that day" })).toBeTruthy();
  });

  it("CB-showday-2: clicking the button calls onShowDay with the target verbatim -- yesterday, Friday and an ISO date", () => {
    const yesterday = renderBar({ todayIndex: 0 });
    fireEvent.change(yesterday.input, { target: { value: YESTERDAY_SENTENCE } });
    fireEvent.keyDown(yesterday.input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Show that day" }));
    expect(yesterday.onShowDay).toHaveBeenCalledWith("yesterday");
    cleanup();

    const friday = renderBar({ days: MON_WED_DAYS, todayIndex: 0 });
    fireEvent.change(friday.input, { target: { value: FRIDAY_SENTENCE } });
    fireEvent.keyDown(friday.input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Show that day" }));
    expect(friday.onShowDay).toHaveBeenCalledWith("friday");
    cleanup();

    const date = renderBar();
    fireEvent.change(date.input, { target: { value: FAR_DATE_SENTENCE } });
    fireEvent.keyDown(date.input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Show that day" }));
    expect(date.onShowDay).toHaveBeenCalledWith("2026-09-25");
  });

  it("CB-showday-3: the rerun happens once the new ctx arrives -- not before, and against the NEW ctx, not the old one", () => {
    const { input, onOpen, rerenderCtx } = renderBar({ todayIndex: 0 });
    fireEvent.change(input, { target: { value: YESTERDAY_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Show that day" }));

    // No rerun yet -- the ctx prop has not changed.
    expect(onOpen).not.toHaveBeenCalled();

    rerenderCtx({ days: SHIFTED_BACK_ONE_DAY, todayIndex: 1 });

    expect(onOpen).toHaveBeenCalledTimes(1);
    const [resolved] = onOpen.mock.calls[0] as [ResolvedCommand, { x: number; y: number }];
    expect(resolved.operatorId).toBe("op1");
    // "yesterday" against the NEW ctx (today now at index 1) is day index 0
    // -- never the old ctx's failed answer.
    expect(resolved.range.startMin).toBe(0 * 1440 + 600);
  });

  it("CB-showday-4: a cancel word drops the pending rerun", () => {
    const { input, onOpen, rerenderCtx } = renderBar({ todayIndex: 0 });
    fireEvent.change(input, { target: { value: YESTERDAY_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Show that day" }));

    fireEvent.change(input, { target: { value: "no" } });
    fireEvent.keyDown(input, { key: "Enter" });

    rerenderCtx({ days: SHIFTED_BACK_ONE_DAY, todayIndex: 1 });

    expect(onOpen).not.toHaveBeenCalled();
  });

  it("CB-showday-5: Escape drops the pending rerun", () => {
    const { input, onOpen, rerenderCtx } = renderBar({ todayIndex: 0 });
    fireEvent.change(input, { target: { value: YESTERDAY_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Show that day" }));

    fireEvent.keyDown(input, { key: "Escape" });

    rerenderCtx({ days: SHIFTED_BACK_ONE_DAY, todayIndex: 1 });

    expect(onOpen).not.toHaveBeenCalled();
  });

  // CB-showday-6 (the S59 reviewer, 15 Sept): the rerun effect used to fire
  // on ANY ctx change at all, not only the window actually moving -- a
  // density click or a background refetch that produced a fresh ctx object
  // with the SAME days consumed the one-shot pending rerun and re-asked the
  // same question, leaving nothing pending for the LATER ctx that really did
  // move. A ctx change that still does not include the target ("yesterday",
  // todayIndex still 0 -- the same days as when the question was asked, just
  // a new object reference) must leave `pendingRerunRef` standing; only a
  // ctx that actually contains the target runs it, exactly once.
  it("CB-showday-6: a ctx change without the target leaves the pending rerun; the next one that has it runs it once", () => {
    const { input, onOpen, rerenderCtx } = renderBar({ todayIndex: 0 });
    fireEvent.change(input, { target: { value: YESTERDAY_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Show that day" }));

    // An irrelevant ctx change -- a fresh object, same days, "yesterday"
    // still off the board -- must not consume the pending rerun.
    rerenderCtx({ todayIndex: 0 });
    expect(onOpen).not.toHaveBeenCalled();
    expect(statusText()).toBe("yesterday is not on the board. Move the board to that day first.");

    // The window has now actually moved -- "yesterday" (index 0) is on it.
    rerenderCtx({ days: SHIFTED_BACK_ONE_DAY, todayIndex: 1 });

    expect(onOpen).toHaveBeenCalledTimes(1);
    const [resolved] = onOpen.mock.calls[0] as [ResolvedCommand, { x: number; y: number }];
    expect(resolved.operatorId).toBe("op1");
  });

  // CB-showday-7 (the S59 reviewer, 15 Sept): a WEEK target (a `CopyCommand`
  // naming `this_week`/`next_week`/`last_week`) is gated on all SEVEN of the
  // week's own ISOs, not just the first missing one `question.text` names --
  // a ctx that adds only that one day (the rest of the week still off the
  // board) must still leave the pending rerun standing.
  it("CB-showday-7: a week target waits for all seven of its own ISOs, not just the first missing one", () => {
    // "copy this week to next week": `this_week` (index 0-6, on the default
    // board already) resolves fine; `next_week` (Monday 2026-09-07 through
    // Sunday 2026-09-13) is entirely off it -- `day_off_board` names its
    // FIRST missing day, "2026-09-07" (resolve.ts's own `resolveWeekDays`,
    // "seven, Monday first").
    const { input, rerenderCtx } = renderBar();
    fireEvent.change(input, { target: { value: "copy this week to next week" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(statusText()).toBe("Mon Sep 7 is not on the board. Move the board to that day first.");
    fireEvent.click(screen.getByRole("button", { name: "Show that day" }));

    // Only the FIRST missing day of the week lands -- the rest of next week
    // still is not on the board. Must not consume the pending rerun (a
    // naive single-ISO check would wrongly treat this as "the target is
    // here" and re-ask the very same question).
    const onlyFirstDayOfNextWeek = [
      { index: 0, iso: "2026-08-31", weekday: 1 as const },
      { index: 1, iso: "2026-09-01", weekday: 2 as const },
      { index: 2, iso: "2026-09-02", weekday: 3 as const },
      { index: 3, iso: "2026-09-03", weekday: 4 as const },
      { index: 4, iso: "2026-09-04", weekday: 5 as const },
      { index: 5, iso: "2026-09-05", weekday: 6 as const },
      { index: 6, iso: "2026-09-06", weekday: 0 as const },
      { index: 7, iso: "2026-09-07", weekday: 1 as const },
    ];
    rerenderCtx({ days: onlyFirstDayOfNextWeek, todayIndex: 3 });
    expect(statusText()).toBe("Mon Sep 7 is not on the board. Move the board to that day first.");
    expect(screen.getByRole("button", { name: "Show that day" })).toBeTruthy();

    // The WHOLE of next week is now on the board -- the rerun fires. Both
    // weeks are empty in this fixture (no assignments, no runs), so the
    // copy itself has nothing to do -- a plain readout, not another
    // question, is what proves the rerun actually happened.
    const bothWeeks = [
      ...onlyFirstDayOfNextWeek,
      { index: 8, iso: "2026-09-08", weekday: 2 as const },
      { index: 9, iso: "2026-09-09", weekday: 3 as const },
      { index: 10, iso: "2026-09-10", weekday: 4 as const },
      { index: 11, iso: "2026-09-11", weekday: 5 as const },
      { index: 12, iso: "2026-09-12", weekday: 6 as const },
      { index: 13, iso: "2026-09-13", weekday: 0 as const },
    ];
    rerenderCtx({ days: bothWeeks, todayIndex: 3 });
    expect(statusText()).not.toContain("is not on the board");
    expect(screen.queryByRole("button", { name: "Show that day" })).toBeNull();
  });

  it('CB-showday-8 (F-158): a REPEAT day whose week is off the board names the week -- "Show that day" hands onShowDay the week word, and the rerun waits for all seven days of that week', () => {
    // A three-day board, the shape the typed walk runs on: Monday to
    // Wednesday, today Monday. "every weekday this week" needs Monday to
    // Sunday before it can expand (`resolveWeekDays`), so it asks -- and
    // F-158 is that it must ask by the WEEK, since only a week-word target
    // makes `BoardPage`'s handler widen the window to seven days. An ISO
    // target moved a three-day window and asked again about Thursday, for
    // ever.
    const { input, onOpen, onShowDay, rerenderCtx } = renderBar({
      days: MON_WED_DAYS,
      todayIndex: 0,
    });
    fireEvent.change(input, {
      target: {
        value: "assign Operator 1 to Housing A on Cell 1 in Line 1 every weekday this week 10 to 2",
      },
    });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(statusText()).toBe("this week is not on the board. Move the board to that day first.");

    fireEvent.click(screen.getByRole("button", { name: "Show that day" }));
    expect(onShowDay).toHaveBeenCalledWith("this week");

    // Six of the seven: still not enough, and the pending rerun must stand
    // rather than be consumed against a board that cannot answer yet.
    const monToSat = [
      ...MON_WED_DAYS,
      { index: 3, iso: "2026-09-03", weekday: 4 as const },
      { index: 4, iso: "2026-09-04", weekday: 5 as const },
      { index: 5, iso: "2026-09-05", weekday: 6 as const },
    ];
    rerenderCtx({ days: monToSat, todayIndex: 0 });
    expect(statusText()).toBe("this week is not on the board. Move the board to that day first.");

    // The whole week: the held sentence re-runs and becomes the lot of five
    // (Monday to Friday) CB-y-2 pins -- the count is unchanged by F-158.
    rerenderCtx({
      days: [...monToSat, { index: 6, iso: "2026-09-06", weekday: 0 as const }],
      todayIndex: 0,
    });
    expect(statusText()).toMatch(/^5 commands ready: /);
    expect(screen.queryByRole("button", { name: "Show that day" })).toBeNull();
    expect(onOpen).not.toHaveBeenCalled(); // a lot waits for its own yes
  });
});

// S59 (R-418's message, design §19.104/D133 item 1, brief §4): an `unknown`
// question WITH `suggestions` renders "No <part|person|place> called ...
// Did you mean one of these?" and the suggestions as candidate buttons, the
// same rendering `ambiguous` already gets -- a pick substitutes the name and
// re-runs.
describe("CB-unknown: nearest names as buttons (S59, R-418's message)", () => {
  /**
   * Lane A (resolver) is concurrently adding `suggestions?: Candidate[]` to
   * the `unknown` question (docs/agent-briefs/s59-b-bar-brief.md); until it
   * lands, the REAL resolver never answers `unknown` with one, so this file
   * cannot pin the new rendering against it end to end yet. This spies on
   * `resolveCommand` for the DURATION OF ONE CALL of `run` only -- calling
   * straight through to the real implementation and grafting `suggestions`
   * onto an `unknown` answer for the named field, everywhere else in this
   * describe block (and every other one in this file) still drives the
   * real, unmocked resolver (this file's own header doc, unchanged).
   * Restored in a `finally`, so a failed assertion never leaks the spy into
   * a later test.
   */
  function withUnknownSuggestions<T>(
    field: "operator" | "product" | "place",
    suggestions: Candidate[],
    run: () => T,
  ): T {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const real: any = resolveLib.resolveCommand;
    const spy = vi.spyOn(resolveLib, "resolveCommand").mockImplementation(((
      command: unknown,
      ctx: unknown,
    ) => {
      const result = real(command, ctx);
      if (!result.ok && result.question.kind === "unknown" && result.question.field === field) {
        return { ok: false, question: { ...result.question, suggestions } };
      }
      return result;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any);
    try {
      return run();
    } finally {
      spy.mockRestore();
    }
  }

  it('CB-unknown-1 (operator): "No person called ... Did you mean one of these?", a pick reaches onOpen', () => {
    withUnknownSuggestions(
      "operator",
      [{ id: "op1", label: "Operator 1", word: "Operator 1" }],
      () => {
        const { input, onOpen } = renderBar();
        fireEvent.change(input, {
          target: { value: "assign Zzznotaperson to Housing A on Cell 1 in Line 1 from 10 to 2" },
        });
        fireEvent.keyDown(input, { key: "Enter" });

        expect(statusText()).toBe(
          'No person called "Zzznotaperson" on this board. Did you mean one of these?',
        );
        fireEvent.click(screen.getByRole("button", { name: "Operator 1" }));

        expect(onOpen).toHaveBeenCalledTimes(1);
        const [resolved] = onOpen.mock.calls[0] as [ResolvedCommand, { x: number; y: number }];
        expect(resolved.operatorId).toBe("op1");
      },
    );
  });

  it('CB-unknown-2 (product): "No part called ... Did you mean one of these?", a pick reaches onOpen', () => {
    withUnknownSuggestions("product", [{ id: "ha", label: "Housing A", word: "Housing A" }], () => {
      const { input, onOpen } = renderBar();
      fireEvent.change(input, {
        target: { value: "assign Operator 1 to Zzznotapart on Cell 1 in Line 1 from 10 to 2" },
      });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(statusText()).toBe(
        'No part called "Zzznotapart" on this board. Did you mean one of these?',
      );
      fireEvent.click(screen.getByRole("button", { name: "Housing A" }));

      expect(onOpen).toHaveBeenCalledTimes(1);
      const [resolved] = onOpen.mock.calls[0] as [ResolvedCommand, { x: number; y: number }];
      expect(resolved.productId).toBe("ha");
    });
  });

  it('CB-unknown-3 (place): "No place called ... Did you mean one of these?", a pick reaches onOpen', () => {
    // "Cell 2" (c2), not "Cell 1" -- the fixture has TWO cells named "Cell
    // 1" (c1a in Line 1, c1b in Line 3); `pickCandidate`'s place branch
    // substitutes the WHOLE `place` array (dropping any "in Line 1"
    // qualifier the original sentence had), so picking an unqualified
    // "Cell 1" would land on `ambiguous`, not resolve -- the same thing
    // that already happens for an `ambiguous` place pick, not something new
    // here. "Cell 2" is unique, so this pins the pick reaching `onOpen`
    // cleanly.
    withUnknownSuggestions("place", [{ id: "c2", label: "Cell 2", word: "Cell 2" }], () => {
      const { input, onOpen } = renderBar();
      fireEvent.change(input, {
        target: { value: "assign Operator 1 to Housing A on Zzznotacell in Line 1 from 10 to 2" },
      });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(statusText()).toBe(
        'No place called "Zzznotacell" on this board. Did you mean one of these?',
      );
      fireEvent.click(screen.getByRole("button", { name: "Cell 2" }));

      expect(onOpen).toHaveBeenCalledTimes(1);
      const [resolved] = onOpen.mock.calls[0] as [ResolvedCommand, { x: number; y: number }];
      expect(resolved.nodeId).toBe("c2");
    });
  });

  it("CB-unknown-4: no suggestions (today's real resolver) keeps the plain message and no buttons", () => {
    const { input, onOpen } = renderBar();
    fireEvent.change(input, {
      target: { value: "assign Zzznotaperson to Housing A on Cell 1 in Line 1 from 10 to 2" },
    });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toBe('No person called "Zzznotaperson" on this board.');
    expect(screen.queryByRole("button")).toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
  });
});

// S60-b (docs/agent-briefs/s60-b-which-part-brief.md, R-422): a sentence
// naming a place and hours but no part asks "Which part? <cell> makes: ",
// offering the cell's own menu as buttons -- a pick substitutes and re-runs
// exactly like every other suggestion button (CB-unknown, above). "Cell 2"
// (c2) is used throughout, not "Cell 1" -- the fixture has TWO cells named
// "Cell 1" (c1a/c1b), and the single-piece grammar this question comes from
// (parse.ts's own R-422 branch) never carries an "in <line>" qualifier (see
// that branch's own comment), so an unqualified "Cell 1" would land on
// `ambiguous`, not this question at all.
describe("CB-wp: which part, from what the cell makes (S60-b, R-422)", () => {
  it("CB-wp-1: a typed sentence with no part shows the cell's own menu as buttons", () => {
    const { input } = renderBar();
    fireEvent.change(input, { target: { value: "Assign Operator 1 to Cell 2 from 10 to 2" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toBe("Which part? Cell 2 makes: ");
    expect(screen.getByRole("button", { name: "Housing A" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Housing B" })).toBeTruthy();
  });

  it("CB-wp-2: a pick substitutes the part and re-runs, reaching onOpen", () => {
    const { input, onOpen } = renderBar();
    fireEvent.change(input, { target: { value: "Assign Operator 1 to Cell 2 from 10 to 2" } });
    fireEvent.keyDown(input, { key: "Enter" });

    fireEvent.click(screen.getByRole("button", { name: "Housing A" }));

    expect(onOpen).toHaveBeenCalledTimes(1);
    const [resolved] = onOpen.mock.calls[0] as [ResolvedCommand, { x: number; y: number }];
    expect(resolved.productId).toBe("ha");
  });

  it("CB-wp-3: more than eight parts shows the first eight and the 'and more' tail", () => {
    const nineParts = Array.from({ length: 9 }, (_, i) => ({
      id: `pp${i + 1}`,
      sku: `PP-${i + 1}`,
      name: `Part ${i + 1}`,
    }));
    const { input } = renderBar({
      products: nineParts,
      offeredAt: () => nineParts.map((p) => ({ id: p.id })),
    });
    fireEvent.change(input, { target: { value: "Assign Operator 1 to Cell 2 from 10 to 2" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toBe("Which part? Cell 2 makes: … and more — say the part.");
    for (let i = 1; i <= 8; i++) {
      expect(screen.getByRole("button", { name: `Part ${i}` })).toBeTruthy();
    }
    expect(screen.queryByRole("button", { name: "Part 9" })).toBeNull();
  });
});

// Reviewer fix (S60-b review, R-422): "assign Sam to Housing A 8 to 4" has no
// separator, so parse.ts's own R-422 branch reads "Housing A" as the PLACE,
// product "" -- but "Housing A" is a PART in this fixture (`ha`), not a cell.
// `resolveCellStep` catches that (asPart on the `unknown`/place question) and
// the bar renders "<part> is a part; which cell?" with every track cell as a
// button, never the generic "No place called ..." wording a person who named
// the part has no reason to see. UNMOCKED end to end: this fixture's own
// "Housing A" is a genuine product, so the real resolver reaches this path
// without `withUnknownSuggestions`.
describe("CB-pp: a single-segment word recognised as a part asks which cell (S60-b review, R-422)", () => {
  it("CB-pp-1: a typed sentence naming a part with no separator shows every track cell as a button", () => {
    const { input } = renderBar();
    fireEvent.change(input, { target: { value: "assign Operator 1 to Housing A from 10 to 2" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toBe("Housing A is a part; which cell?");
    expect(
      screen.getByRole("button", { name: "Cell 2 — Plant 1 › Assembly › Line 1" }),
    ).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Cell 1 —/ }).length).toBe(2);
  });

  it("CB-pp-2: a pick substitutes BOTH the cell and the recognised part, and re-runs, reaching onOpen", () => {
    const { input, onOpen } = renderBar();
    fireEvent.change(input, { target: { value: "assign Operator 1 to Housing A from 10 to 2" } });
    fireEvent.keyDown(input, { key: "Enter" });

    fireEvent.click(screen.getByRole("button", { name: "Cell 2 — Plant 1 › Assembly › Line 1" }));

    expect(onOpen).toHaveBeenCalledTimes(1);
    const [resolved] = onOpen.mock.calls[0] as [ResolvedCommand, { x: number; y: number }];
    expect(resolved.nodeId).toBe("c2");
    expect(resolved.productId).toBe("ha");
  });

  it("CB-pp-3: more than eight track cells -- 'say the cell', no buttons", () => {
    const manyCells = Array.from({ length: 9 }, (_, i) => ({
      id: `mc${i + 1}`,
      name: `Bay ${i + 1}`,
      path: `plant_1.bay_${i + 1}`,
    }));
    const { input } = renderBar({
      cells: manyCells,
      nodeById: new Map(
        [
          { id: "p1", name: "Plant 1", path: "plant_1" },
          { id: "asm", name: "Assembly", path: "plant_1.assembly" },
          { id: "l1", name: "Line 1", path: "plant_1.assembly.line_1" },
          { id: "l3", name: "Line 3", path: "plant_1.assembly.line_3" },
          { id: "c1a", name: "Cell 1", path: "plant_1.assembly.line_1.cell_1" },
          { id: "c2", name: "Cell 2", path: "plant_1.assembly.line_1.cell_2" },
          { id: "c1b", name: "Cell 1", path: "plant_1.assembly.line_3.cell_1" },
          ...manyCells,
        ].map((n) => [n.id, n] as const),
      ),
    });
    fireEvent.change(input, { target: { value: "assign Operator 1 to Housing A from 10 to 2" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toBe("Housing A is a part; which cell? Say the cell.");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("CB-pp-4: inside a lot (several), an asPart item is numbered and its pick fills both fields before moving on", () => {
    // "Housing A and Cell 2" has no "on"/"in" separator, so parse.ts's own
    // R-422 branch reads the WHOLE thing as a place list -- item 1 (place
    // ["Housing A"]) is the asPart ambiguity this describe block is about;
    // item 2 (place ["Cell 2"]) is an ordinary empty-product "Which part?"
    // once its own turn comes -- the SAME generic lot numbering (`resolveLotStep`)
    // wraps both, nothing special needed for either.
    const { input } = renderBar();
    fireEvent.change(input, {
      target: { value: "assign Operator 1 to Housing A and Cell 2 8 to 4" },
    });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toBe("1 of 2: Housing A is a part; which cell?");
    // "Cell 1" is picked deliberately NOT: the fixture has two cells named
    // "Cell 1" (c1a/c1b), and `pickPartAsPlace` substitutes the bare word,
    // so picking it would land back on `ambiguous` -- the same pre-existing
    // tradeoff `CB-unknown-3`'s own comment documents for `pickCandidate`.
    // "Cell 2" (unique) is item 1's own pick here; item 2 (still unresolved,
    // its own turn not yet reached) separately names "Cell 2" too -- the two
    // are unrelated commands in the same lot, each resolved independently.
    fireEvent.click(screen.getByRole("button", { name: "Cell 2 — Plant 1 › Assembly › Line 1" }));

    expect(statusText()).toBe("2 of 2: Which part? Cell 2 makes: ");
  });
});

// -----------------------------------------------------------------------
// S59-e (R-421, brief docs/agent-briefs/s59-e-trace-brief.md §4): the bar's
// own trace, posted to the dev server's `/__trace` once a sentence's life
// ends. `fetch` is stubbed globally rather than injected through a prop --
// `CommandBar.tsx` calls the real global, wrapped so a synchronous throw or
// a rejected promise is always swallowed (brief §3: "fire-and-forget,
// errors swallowed"), which CB-t-5 exercises directly.
// -----------------------------------------------------------------------

describe("CB-t: the bar's trace (S59-e, R-421)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("CB-t-1: a typed sentence that resolves and runs posts one entry -- by, model, read, ran", () => {
    const fetchMock = stubFetch();
    const parsed = parseCommand(P1_SENTENCE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const { onOpen, input } = renderBar({ runs: [] });
    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onOpen).toHaveBeenCalledTimes(1);
    const [resolved] = onOpen.mock.calls[0] as [ResolvedCommand, { x: number; y: number }];

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const entry = postedEntry(fetchMock);
    expect(entry.heard).toBe(P1_SENTENCE);
    expect(entry.by).toBe("typed");
    // No `reader` prop set here -- the model was never consulted.
    expect(entry.model).toEqual({ skipped: "no reader" });
    expect(entry.read).toBe(formatCommand(parsed.command));
    // F-157 review fix (item 4/5): a plain single raises no question of its
    // own and is never answered by a word or a button -- it runs straight
    // off its own readout, so `asked` IS that readout and `answered` is the
    // literal "auto" (CB-t-11 below covers this directly; kept here too so
    // this test still speaks for the whole entry it posts).
    expect(entry.asked).toBe(renderedReadout(resolved.readout));
    expect(entry.answered).toBe("auto");
    expect(entry.ran).toEqual([resolved.readout]);
  });

  it("CB-t-2: a spoken sentence through the reader stub -- by 'local' and the raw answer", async () => {
    const fetchMock = stubFetch();
    const parsed = parseCommand(P1_SENTENCE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const raw = '{"intent":"assign","operator":"Operator 1"}';
    const fakeReader: Reader = vi.fn(async (): Promise<Reading> => ({
      ok: true,
      command: parsed.command,
      by: "model",
      raw,
    }));
    const { recognizer, fire } = makeFakeRecognizer();
    const { onOpen, input } = renderBar(
      { runs: [] },
      fakeReader,
      recognizer,
      {},
      {},
      { recognizerName: () => "local" },
    );

    fireEvent.click(screen.getByRole("button", { name: "Speak a sentence" }));
    fire.final(P1_SENTENCE);
    expect(input.value).toBe(P1_SENTENCE);

    await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const entry = postedEntry(fetchMock);
    expect(entry.heard).toBe(P1_SENTENCE);
    expect(entry.by).toBe("local");
    expect(entry.model).toEqual({ raw });
  });

  it("CB-t-3: a question answered by a button -- asked and answered, posted once (not while the question stands)", () => {
    const fetchMock = stubFetch();
    const { onOpen, input } = renderBar();
    fireEvent.change(input, {
      target: { value: "assign Sam to Housing A on Cell 1 in Line 1 from 10 to 2" },
    });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toBe('Which person? "Sam" matches 2:');
    // The sentence's life has not ended yet -- a question stands.
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Sam Patel" }));
    expect(onOpen).toHaveBeenCalledTimes(1);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const entry = postedEntry(fetchMock);
    expect(entry.asked).toBe('Which person? "Sam" matches 2:');
    expect(entry.answered).toBe("Sam Patel");
  });

  it("CB-t-4: a lot -- ran lists every command that was written, in order", async () => {
    const onRunLot = vi.fn(async (resolved: ResolvedAny[]): Promise<LotResult> => ({
      done: resolved.length,
      error: null,
    }));
    const fetchMock = stubFetch();
    const { input } = renderBar({ assignments: [BLK1, BLK_SP] }, null, null, {}, { onRunLot });

    fireEvent.change(input, { target: { value: LOT_REMOVE_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "yes" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(statusText()).toBe("Done: 2 commands."));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const entry = postedEntry(fetchMock);
    const [resolvedList] = onRunLot.mock.calls[0] as [ResolvedAny[]];
    expect(entry.ran).toEqual(resolvedList.map((r) => r.readout));
    expect(entry.ran).toHaveLength(2);
    expect(entry.answered).toBe("yes");
  });

  it("CB-t-5: a failed post is swallowed -- the bar itself is unaffected", () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);
    const { onOpen, input } = renderBar({ runs: [] });

    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The bar itself is unaffected -- a second sentence still runs cleanly.
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("CB-t-6: nothing is posted when not DEV", () => {
    vi.stubEnv("DEV", false);
    const fetchMock = stubFetch();
    const { onOpen, input } = renderBar({ runs: [] });

    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // CB-t-7 (the S59 reviewer, 15 Sept): Escape used to leave a trace entry
  // open forever -- none of the three life-end triggers (a readout, a
  // cancel, a new sentence) is what Escape does, so the line was simply
  // never written. Escape is now a FOURTH trigger, same shape as a typed
  // cancel word (`traceRef.current.answered = "escape"` then `finishTrace`),
  // in all three places Escape can find something open: a standing
  // question, a "Reading…" spinner, and an active listen.
  it("CB-t-7a: Escape on a standing question posts the entry, answered 'escape'", () => {
    const fetchMock = stubFetch();
    const { input } = renderBar();
    fireEvent.change(input, {
      target: { value: "assign Sam to Housing A on Cell 1 in Line 1 from 10 to 2" },
    });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(statusText()).toBe('Which person? "Sam" matches 2:');
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Escape" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const entry = postedEntry(fetchMock);
    expect(entry.asked).toBe('Which person? "Sam" matches 2:');
    expect(entry.answered).toBe("escape");
  });

  it("CB-t-7b: Escape on a 'Reading…' spinner posts the entry, answered 'escape'", () => {
    const fetchMock = stubFetch();
    const neverSettles: Reader = vi.fn(() => new Promise<Reading>(() => {}));
    const { input } = renderBar({ runs: [] }, neverSettles);

    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(statusText()).toBe("Reading…");
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Escape" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const entry = postedEntry(fetchMock);
    expect(entry.heard).toBe(P1_SENTENCE);
    expect(entry.answered).toBe("escape");
  });

  it("CB-t-7c: Escape on an active listen posts whatever entry was still open, answered 'escape'", () => {
    const fetchMock = stubFetch();
    const { recognizer } = makeFakeRecognizer();
    const { input } = renderBar({ runs: [] }, null, recognizer);

    // Opens a trace entry (`asked` set) that never posts on its own -- a
    // question stands.
    fireEvent.change(input, {
      target: { value: "assign Sam to Housing A on Cell 1 in Line 1 from 10 to 2" },
    });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(fetchMock).not.toHaveBeenCalled();

    // A fresh listen starts (clears the status, not the still-open entry).
    fireEvent.click(screen.getByRole("button", { name: "Speak a sentence" }));

    fireEvent.keyDown(input, { key: "Escape" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const entry = postedEntry(fetchMock);
    expect(entry.asked).toBe('Which person? "Sam" matches 2:');
    expect(entry.answered).toBe("escape");
  });

  // CB-t-9/CB-t-10 (the S60-b reviewer, 15 Sept): `finishTrace`'s own no-op
  // guard (`if (!entry) return`) means Escape with nothing open posts
  // nothing, and a second Escape -- after the first already closed and
  // posted the entry -- posts nothing a second time either. Neither was
  // pinned by CB-t-7a-c above, which only ever press Escape once against a
  // standing entry.
  it("CB-t-9: Escape with nothing standing (empty bar, no status) posts nothing", () => {
    const fetchMock = stubFetch();
    const { input } = renderBar();

    fireEvent.keyDown(input, { key: "Escape" });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("CB-t-10: Escape twice posts the entry once, not twice", () => {
    const fetchMock = stubFetch();
    const { input } = renderBar();
    fireEvent.change(input, {
      target: { value: "assign Sam to Housing A on Cell 1 in Line 1 from 10 to 2" },
    });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(statusText()).toBe('Which person? "Sam" matches 2:');

    fireEvent.keyDown(input, { key: "Escape" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // First Escape cleared the status; the sentence text itself is still in
    // the box, so the SECOND Escape's own job (per C7) is to clear that --
    // no trace entry is open any more (`finishTrace` already ran), so this
    // must not post again.
    expect(input.value).not.toBe("");

    fireEvent.keyDown(input, { key: "Escape" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // CB-t-8 (the S59 reviewer, 15 Sept): `recognizerName` is now a GETTER,
  // read at the moment `onFinal` sets the trace entry's `by` -- never a
  // static value fixed at render. A session that started as "local" but
  // fell back to the browser mid-session (the getter's own backing value
  // changes between the click and the final result, exactly how
  // `withFallback`'s own `onEngine` updates `engineRef.current` in
  // BoardPage.tsx) is traced by what actually ran, not by what the FIRST
  // render saw.
  it("CB-t-8: the recognizerName getter is read at final time, not at render", () => {
    const fetchMock = stubFetch();
    const parsed = parseCommand(P1_SENTENCE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    let engine: "local" | "browser" = "local";
    const { recognizer, fire } = makeFakeRecognizer();
    const { input } = renderBar(
      { runs: [] },
      null,
      recognizer,
      {},
      {},
      { recognizerName: () => engine },
    );

    fireEvent.click(screen.getByRole("button", { name: "Speak a sentence" }));
    // The engine "falls back" mid-session -- after the render that started
    // listening, before the clip's final result arrives.
    engine = "browser";
    fire.final(P1_SENTENCE);

    expect(input.value).toBe(P1_SENTENCE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const entry = postedEntry(fetchMock);
    expect(entry.by).toBe("browser");
  });

  // CB-t-11/12/13 (F-157, the maintainer's own 16 Sept trace read against
  // `data/voice/trace/bar.jsonl`): three of the four shapes that trace
  // showed with `asked`/`answered` missing even though the bar plainly
  // showed something and acted on it -- a single's own readout, a parse
  // failure's shape hint, and a headcount's own readout. (The fourth --
  // "the Show that day sentence and the split after it are absent
  // altogether because the bar unmounted" -- is R-424's own fix, covered by
  // CB-keep below and CB-t-14's unmount flush.) Numbered from 11 rather
  // than the brief's own 9/10, which CB-t-9/CB-t-10 above already use for a
  // different pair of Escape-no-op pins.
  it("CB-t-11: a single's own readout is recorded -- asked is the readout, answered is 'auto' (item 5: no separate yes)", () => {
    const fetchMock = stubFetch();
    // A booking with nothing in the way (CB1's own fixture) runs straight
    // off Enter, exactly like P1_SENTENCE's assign in CB-t-1 -- used here
    // instead so this pin covers a DIFFERENT resolved shape (`book`, not
    // `assign`), not a repeat of CB-t-1's own case.
    const { onBook, input } = renderBar({ runs: [] });

    fireEvent.change(input, { target: { value: BOOK_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onBook).toHaveBeenCalledTimes(1);
    const [resolved] = onBook.mock.calls[0] as [ResolvedBook, { x: number; y: number }];

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const entry = postedEntry(fetchMock);
    expect(entry.asked).toBe(renderedReadout(resolved.readout));
    expect(entry.answered).toBe("auto");
    expect(entry.ran).toEqual([resolved.readout]);
  });

  it("CB-t-12: a parse failure's own shape hint is recorded as asked", () => {
    const fetchMock = stubFetch();
    const { input } = renderBar();

    fireEvent.change(input, { target: { value: "gibberish" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(statusText()).toBe(SHAPE);
    // A shape hint alone is none of the three life-end triggers (a readout,
    // a cancel, a new sentence) -- the entry stays open until Escape closes
    // it (CB-t-7a's own pattern), which is what makes it observable here.
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Escape" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const entry = postedEntry(fetchMock);
    // `read` is whatever `ParseFailure.kind` this sentence hit -- not this
    // pin's own concern (`commandParse.test.ts` owns that table); only that
    // some failure kind was recorded at all.
    expect(entry.read.length).toBeGreaterThan(0);
    expect(entry.asked).toBe(SHAPE);
    expect(entry.answered).toBe("escape");
  });

  it("CB-t-13: a headcount's own readout is recorded -- asked and ran", () => {
    const fetchMock = stubFetch();
    const { onSetHeadcount, input } = renderBar({ runs: [RUN1] });

    // "in Line 1" names which "Cell 1" (the default fixture has two, c1a
    // under Line 1 and c1b under Line 3) -- without it the sentence asks
    // which place instead of resolving straight through.
    fireEvent.change(input, {
      target: { value: "make the Housing A job on Cell 1 in Line 1 4 people" },
    });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSetHeadcount).toHaveBeenCalledTimes(1);
    const [resolved] = onSetHeadcount.mock.calls[0] as [
      ResolvedHeadcount,
      { x: number; y: number },
    ];

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const entry = postedEntry(fetchMock);
    expect(entry.asked).toBe(renderedReadout(resolved.readout));
    expect(entry.answered).toBe("auto");
    expect(entry.ran).toEqual([resolved.readout]);
  });

  it("CB-t-14: an entry still open when the bar unmounts is flushed with navigator.sendBeacon", () => {
    const sendBeacon = vi.fn().mockReturnValue(true);
    const original = (navigator as unknown as { sendBeacon?: typeof sendBeacon }).sendBeacon;
    Object.defineProperty(navigator, "sendBeacon", {
      value: sendBeacon,
      configurable: true,
      writable: true,
    });
    try {
      const { input, unmount } = renderBar();
      fireEvent.change(input, {
        target: { value: "assign Sam to Housing A on Cell 1 in Line 1 from 10 to 2" },
      });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(statusText()).toBe('Which person? "Sam" matches 2:');

      unmount();

      expect(sendBeacon).toHaveBeenCalledTimes(1);
      // A plain string body (`traceServer.ts`'s own handler reads the raw
      // request body regardless of content type -- no `Blob` needed here).
      const [url, body] = sendBeacon.mock.calls[0] as [string, string];
      expect(url).toBe("/__trace");
      const posted = JSON.parse(body) as TraceEntry;
      expect(posted.asked).toBe('Which person? "Sam" matches 2:');
      expect(posted.answered).toBeNull();
    } finally {
      if (original) {
        Object.defineProperty(navigator, "sendBeacon", { value: original, configurable: true });
      } else {
        delete (navigator as { sendBeacon?: unknown }).sendBeacon;
      }
    }
  });
});

// R-424 (the maintainer, 16 Sept, the second walk: "when I went to check it,
// the chatbot vanished ... after show that day, the chatbot vanished"). The
// actual cause was `BoardPage`'s own mount gate: `useBoardWindow`'s query key
// carries the window's `from`/`to`, so a window move (or a same-window
// refetch after a write) made `boardQuery.data` go back to `undefined` for
// the gap, and every consumer gated on "the board has data" -- including the
// whole `{hasData && index && boardQuery.data && (...)}` block the command
// bar lives inside -- unmounted along with it, destroying every ref and
// every piece of state this component was holding. `useBoardWindow`'s own
// fix (`placeholderData: keepPreviousData`) is the real fix -- BoardPage
// should no longer produce a null `ctx` for this component after its first
// load -- but this component does not get to assume its caller never
// regresses that (`ctx`'s own doc above), so it holds its own fallback too:
// `lastCtxRef` remembers the last real `ResolveContext` and every functional
// use reads that instead of the prop directly. These pins drive `CommandBar`
// alone (this file's own header doc) -- `ctx` going `null` and coming back
// via `rerenderCtx(null)` / `rerenderCtx(over)` stands in for that gap.
describe("CB-keep: the bar keeps its conversation through a ctx that goes null and back (R-424)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("CB-keep-1: a ctx going null then back keeps the status and the open trace entry", () => {
    const fetchMock = stubFetch();
    const { onOpen, input, rerenderCtx } = renderBar();
    fireEvent.change(input, {
      target: { value: "assign Sam to Housing A on Cell 1 in Line 1 from 10 to 2" },
    });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(statusText()).toBe('Which person? "Sam" matches 2:');
    // The sentence's life has not ended -- a question stands, same as
    // CB-t-3's own identical case.
    expect(fetchMock).not.toHaveBeenCalled();

    // The window's ctx goes null (a refetch gap) -- must not crash, must
    // not lose the status, must not flush the still-open entry early.
    rerenderCtx(null);
    expect(statusText()).toBe('Which person? "Sam" matches 2:');
    expect(fetchMock).not.toHaveBeenCalled();

    // ... and comes back.
    rerenderCtx({});
    expect(statusText()).toBe('Which person? "Sam" matches 2:');

    // The candidate button still works -- `lastCtxRef` carried the board
    // through the gap, so resolving the pick never crashed either.
    fireEvent.click(screen.getByRole("button", { name: "Sam Patel" }));
    expect(onOpen).toHaveBeenCalledTimes(1);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const entry = postedEntry(fetchMock);
    expect(entry.asked).toBe('Which person? "Sam" matches 2:');
    expect(entry.answered).toBe("Sam Patel");
  });

  it("CB-keep-2: Show that day's rerun keeps the entry -- a null ctx in between neither fires early nor crashes, and the real ctx still completes it", () => {
    const YESTERDAY_SENTENCE =
      "assign Operator 1 to Housing A on Cell 1 in Line 1 from 10 to 2 yesterday";
    // The default fixture's own week, shifted back one calendar day -- the
    // shape `commandCtx` takes once the window has actually moved (mirrors
    // `CB-showday`'s own `SHIFTED_BACK_ONE_DAY`, kept local here on purpose:
    // this describe block drives its own scenario, not a shared fixture).
    const SHIFTED_BACK_ONE_DAY = [
      { index: 0, iso: "2026-08-30", weekday: 0 as const },
      { index: 1, iso: "2026-08-31", weekday: 1 as const },
      { index: 2, iso: "2026-09-01", weekday: 2 as const },
      { index: 3, iso: "2026-09-02", weekday: 3 as const },
      { index: 4, iso: "2026-09-03", weekday: 4 as const },
      { index: 5, iso: "2026-09-04", weekday: 5 as const },
      { index: 6, iso: "2026-09-05", weekday: 6 as const },
      { index: 7, iso: "2026-09-06", weekday: 0 as const },
    ];
    const fetchMock = stubFetch();
    const { input, onOpen, rerenderCtx } = renderBar({ todayIndex: 0 });
    fireEvent.change(input, { target: { value: YESTERDAY_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Show that day" }));
    // A question stood (the day_off_board one) -- the entry is still open.
    expect(fetchMock).not.toHaveBeenCalled();

    // R-424: the window ctx goes null before the new window's data lands.
    rerenderCtx(null);
    expect(onOpen).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    // ... and the real new ctx (the window actually moved) arrives.
    rerenderCtx({ days: SHIFTED_BACK_ONE_DAY, todayIndex: 1 });

    expect(onOpen).toHaveBeenCalledTimes(1);
    const [resolved] = onOpen.mock.calls[0] as [ResolvedCommand, { x: number; y: number }];
    expect(resolved.operatorId).toBe("op1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const entry = postedEntry(fetchMock);
    expect(entry.ran).toEqual([resolved.readout]);
  });

  it("CB-keep-3: a pop-up opening from a sentence keeps the status through a ctx that goes null and back", () => {
    const { onOpen, input, rerenderCtx } = renderBar({ runs: [] });
    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onOpen).toHaveBeenCalledTimes(1);
    const shown = statusText();
    expect(shown.length).toBeGreaterThan(0);

    rerenderCtx(null);
    expect(statusText()).toBe(shown);

    rerenderCtx({ runs: [] });
    expect(statusText()).toBe(shown);
    // A ctx flicker never re-opens the pop-up a second time.
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

// F-153: `renderReadout` used to build `new Date(iso + "T00:00:00Z")` and
// format THAT in the plant's own zone -- a UTC-midnight instant read back in
// America/Chicago is 19:00 the evening before, so the swap's own listing
// read "Tue Sep 15" for four blocks whose own readouts, once written, said
// 2026-09-16. Fixed by building the instant that reads back as midnight of
// the ISO day IN the zone (`zonedTimeToInstant`) instead.
describe("CB-day: the readout's ISO day renders in the plant's own zone (F-153)", () => {
  it("CB-day-1: a readout carrying 2026-09-16 under America/Chicago renders 'Wed Sep 16', never Tue", () => {
    const onBook = vi.fn();
    render(
      <CommandBar
        ctx={buildCtx({
          days: [{ index: 0, iso: "2026-09-16", weekday: 3 }],
          todayIndex: 0,
        })}
        dateFormat="d_mon_yyyy"
        zone="America/Chicago"
        onOpen={vi.fn()}
        onRetime={vi.fn()}
        onBook={onBook}
        onRetimeRun={vi.fn()}
        onUnassign={vi.fn()}
        onMove={vi.fn()}
        onSetHeadcount={vi.fn()}
        onRunLot={vi.fn(() => new Promise<LotResult>(() => {}))}
      />,
    );
    const input = screen.getByRole("textbox", { name: "Tell the board" }) as HTMLInputElement;

    fireEvent.change(input, { target: { value: BOOK_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onBook).toHaveBeenCalledTimes(1);
    expect(statusText()).toContain("Wed Sep 16");
    expect(statusText()).not.toContain("Tue Sep 15");
  });
});

// F-154: `runLot` (useDragGesture.ts, not this lane's file) stops on the
// first failed step and returns `{done, error}` -- `error` is worded through
// `buildSchedulerErrorToast`. THE CLEAN FIX LANDED (S61-a review, 16 Sept):
// `useSchedulerToast.ts` no longer bakes " — reverted." into that message at
// all (true for a real drag, which really does revert its own optimistic
// move, but false for a lot, which writes each step for real and simply
// stops at the first failure -- "swap Lena Novak and Tom Baker today" wrote
// three of four and the bar still said "reverted", reading as the whole lot
// undone). A genuine drag failure gets the suffix from its OWN caller now
// (`failWith`/`openMoveFromCommand`'s own `toast.reverted(message, kind)`
// calls, `useDragGesture.ts`), never baked in regardless of whether
// anything was actually rolled back -- so `LotResult.error` here is exactly
// what a real one would be: no "reverted" to begin with, nothing for this
// file to strip any more either.
// This pin is now just the "stayed" clause, same as CB-lot-3's "boom" case,
// against a message shaped the way a real certificate refusal reads.
describe("CB-lot-fail: a partial lot says what stood, never a false revert (F-154)", () => {
  it("CB-lot-fail-1: 'Did 1 of 2; the next failed: <message>. The 1 done stayed: <readout>.'", async () => {
    const onRunLot = vi.fn(async (_resolved: ResolvedAny[]): Promise<LotResult> => ({
      done: 1,
      error: "Tom Baker is not certified for Cell 1: missing Welding.",
    }));
    const { input } = renderBar({ assignments: [BLK1, BLK_SP] }, null, null, {}, { onRunLot });

    fireEvent.change(input, { target: { value: LOT_REMOVE_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));

    fireEvent.change(input, { target: { value: "yes" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(onRunLot).toHaveBeenCalledTimes(1));
    const [resolved] = onRunLot.mock.calls[0] as [ResolvedAny[]];

    await waitFor(() =>
      expect(statusText()).toBe(
        `Did 1 of 2; the next failed: Tom Baker is not certified for Cell 1: missing Welding. The 1 done stayed: ${renderedReadout(resolved[0].readout)}.`,
      ),
    );
    expect(statusText()).not.toContain("reverted");
  });
});

// S61-a (R-425, F-155, the resolver lane's `not_certified` question and
// `resolveCommand(command, ctx, { overrideReason })`): a resolved write that
// would put a person on a cell short a required certificate is asked about
// BEFORE anything is written. Under "warn", a single sentence's question
// offers a reason -- ANY typed or spoken text that is not a confirm word and
// not a cancel word IS that reason, re-resolving the SAME held command with
// `{ overrideReason }` and running it as usual, the readout suffixed
// " · override: <reason>". Under "block", or for a LOT's own expansion-time
// refusal (`inLot: true`), no reason is ever offered or accepted -- a plain
// refusal, dropped like any other question by a cancel word or fresh text.
describe("CB-nc: a not_certified question (S61-a, R-425, F-155)", () => {
  /** `certificateGaps` answers one gap ("Welding", never-trained) for
   *  Operator 1 (op1) on Cell 1 (c1a) -- P1_SENTENCE's own person and cell
   *  -- everyone/everywhere else stays fully eligible. */
  function notCertifiedCtx(policy: "warn" | "block"): Partial<ResolveContext> {
    return {
      certificateGaps: (operatorId: string, nodeId: string) =>
        operatorId === "op1" && nodeId === "c1a"
          ? [{ skill: "Welding", state: "never-trained" as const }]
          : [],
      eligibilityPolicy: () => policy,
    };
  }

  it("CB-nc-1: warn asks -- exact wording, single, inLot false", () => {
    const { input } = renderBar(notCertifiedCtx("warn"));
    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toBe(
      "Operator 1 is not certified for Cell 1: missing Welding. Say the reason to schedule anyway, or no.",
    );
  });

  it("CB-nc-2: a reason runs with the override on the resolved command -- onOpen receives it, the readout is suffixed", () => {
    const { onOpen, input } = renderBar(notCertifiedCtx("warn"));
    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpen).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "Covering an absence" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onOpen).toHaveBeenCalledTimes(1);
    const [resolved] = onOpen.mock.calls[0] as [ResolvedCommand, { x: number; y: number }];
    expect(resolved.override).toEqual({ reason: "Covering an absence" });
    expect(statusText()).toContain("· override: Covering an absence");
  });

  it("CB-nc-3: a bare confirm word re-asks -- 'Say the reason, not yes.', nothing runs", () => {
    const { onOpen, input } = renderBar(notCertifiedCtx("warn"));
    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    fireEvent.change(input, { target: { value: "yes" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toBe("Say the reason, not yes.");
    expect(onOpen).not.toHaveBeenCalled();

    // The question still stands -- a real reason still runs after the
    // refused "yes".
    fireEvent.change(input, { target: { value: "Covering an absence" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("CB-nc-4: a cancel word drops the question -- nothing runs", () => {
    const { onOpen, input } = renderBar(notCertifiedCtx("warn"));
    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    fireEvent.change(input, { target: { value: "no" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toBe("");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("CB-nc-5: block refuses outright and accepts no reason", () => {
    const { onOpen, input } = renderBar(notCertifiedCtx("block"));
    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toBe("Operator 1 is not certified for Cell 1: missing Welding.");

    // No reason is offered or accepted -- this is ordinary text now, which
    // fails to parse as a sentence (the shape hint), never an override.
    fireEvent.change(input, { target: { value: "Covering an absence" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpen).not.toHaveBeenCalled();
    expect(statusText()).not.toContain("Covering an absence");
  });

  it("CB-nc-5b: a lot's own refusal (inLot: true) adds 'Nothing was written.' and accepts no reason, regardless of policy", () => {
    // `inLot: true` is raised by `expandCommand`'s own lot expansion
    // (`expandReplace`/`expandSwap`/`expandCopy`), never by an ordinary
    // single sentence -- spied here (same technique "CB-unknown" above
    // uses) to pin the BAR's own rendering of this exact shape without
    // hand-building a real several/replace/swap fixture, which is the
    // resolver lane's own contract, not this file's fixture to construct.
    const spy = vi.spyOn(resolveLib, "resolveCommand").mockReturnValue({
      ok: false,
      question: {
        kind: "not_certified",
        person: "Operator 1",
        cell: "Cell 1",
        missing: ["Welding"],
        policy: "warn",
        inLot: true,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    try {
      const { onOpen, input } = renderBar(notCertifiedCtx("warn"));
      fireEvent.change(input, { target: { value: P1_SENTENCE } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(statusText()).toBe(
        "Operator 1 is not certified for Cell 1: missing Welding. Nothing was written.",
      );

      fireEvent.change(input, { target: { value: "Covering an absence" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onOpen).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("CB-nc-6: a second sentence typed while the question stands runs as a NEW sentence, never swallowed as the reason", () => {
    // The reviewer's own live find: a second sentence typed while a
    // not_certified question stood was silently treated as the reason
    // instead of running.
    const { onOpen, onBook, input } = renderBar(notCertifiedCtx("warn"));
    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(statusText()).toContain("Say the reason to schedule anyway, or no.");

    fireEvent.change(input, { target: { value: BOOK_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onBook).toHaveBeenCalledTimes(1);
    // Never the not_certified question's own answer -- an ordinary book
    // resolution ran instead (`ResolvedBook` carries no `override` field at
    // all -- only `assign`/`move` ever do).
    expect(onOpen).not.toHaveBeenCalled();
    expect(statusText()).not.toContain("override");
  });
});
