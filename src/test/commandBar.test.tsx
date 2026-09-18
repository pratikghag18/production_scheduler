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
  type WriteOutcome,
} from "@/features/board/components/CommandBar";
import type { Reader, Reading } from "@/lib/voice/readSentence";
import type { Recognizer, RecognizerEvents } from "@/lib/voice/recognizer";
import type { TraceEntry } from "@/lib/voice/trace";

/**
 * F-168 (R-421/R-427/R-434): `settleWrite` no longer reads an `undefined`
 * answer as `written` (that was the exact bug F-168 fixes -- a refused
 * unassign/retime recorded as Written because nothing else was returned).
 * Every default writer mock below answers with this instead of a bare
 * `vi.fn()`, so every existing "Written: …" assertion still describes a
 * writer that actually said so, the same as the real `onOpen`/`onBook`/
 * `onSetHeadcount` implementations (which always answered for real; only
 * their TEST DOUBLE relied on the removed shim) and the real
 * `onRetime`/`onRetimeRun`/`onUnassign`/`onMove` implementations now do
 * too (F-168's own fix). A test that means to exercise a refusal or a
 * popup overrides the mock per-case, as every such test already does.
 */
const WRITTEN: WriteOutcome = { kind: "written" };

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
  const onOpen = vi.fn().mockReturnValue(WRITTEN);
  const onRetime = vi.fn().mockReturnValue(WRITTEN);
  const onBook = vi.fn().mockReturnValue(WRITTEN);
  const onRetimeRun = vi.fn().mockReturnValue(WRITTEN);
  const onUnassign = vi.fn().mockReturnValue(WRITTEN);
  const onMove = vi.fn().mockReturnValue(WRITTEN);
  const onSetHeadcount = vi.fn().mockReturnValue(WRITTEN);
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

/** The one `aria-live="polite"` STATUS element (brief 6). CR-4 (reviewer
 *  fix): tag-qualified as `p[...]` now that `threadBody` (a `div`) ALSO
 *  carries `aria-live="polite"` as the thread's own `role="log"` region --
 *  a bare `[aria-live="polite"]` would match that ancestor first. */
function statusText(): string {
  return document.querySelector('p[aria-live="polite"]')?.textContent ?? "";
}

/**
 * S63-a review fix (CP-5, the maintainer looking at the panel): once a turn
 * is filed (`commandConversation.ts`'s own `fileTurn`), its `sentence`/
 * `status` are cleared back to `null` so the live area never repeats the
 * words the thread already has -- so a written single's own readout (or a
 * refusal, or a "nothing happened" floor) is read back from HERE now,
 * never `statusText()`, which is empty for exactly that turn once it is
 * filed. `threadBody` scopes this to the conversation record itself, never
 * the input row or the panel chrome around it.
 *
 * CR-4 (reviewer fix, S63 review): this element is ALSO the announced
 * surface now (`role="log"`, `aria-live="polite"`, `aria-relevant="additions"`)
 * -- `fileTurn` clearing `status` the same tick `settleWrite` sets it means
 * a screen reader's own read of `statusText()`'s element never held a
 * finished turn's words long enough to be caught (React batches both), so
 * the announcement moved here, to whatever gets APPENDED (a new turn) --
 * which is exactly what this helper already reads for other reasons. `p`
 * tag-qualifies `statusText()`'s own selector below (`p[aria-live="polite"]`)
 * so it still finds the STATUS line's `<p>`, not this `<div>`, now that both
 * carry `aria-live="polite"`.
 *
 * CP-7 (CONTRACT CHANGED, CLAUDE.md §4, session 178, found by the typed
 * walk): a LOT's last word -- "Done: N commands." or "Did k of N; the next
 * failed: …" -- is filed into the thread the moment the lot finishes, the
 * same order a single's readout takes (CP-5), so the fifteen lot cases that
 * read it from `statusText()` read it from here now, and the live line is
 * empty once the turn is filed. It used to stay live as a second copy.
 */
function threadText(): string {
  return document.querySelector('[class*="threadBody"]')?.textContent ?? "";
}

/**
 * R-427 (CONTRACT CHANGED, CLAUDE.md 4): the bar renders a conversation
 * THREAD above the input now, and that thread has a "Clear history" control
 * of its own -- so a pin that means "this question offers no buttons" can no
 * longer ask the whole component. It asks the candidate strip, which is what
 * it was ever about. Same `[class*="..."]` convention `typedWalk.spec.ts`
 * already uses for the same strip.
 */
function candidateButtons(): HTMLElement[] {
  const strip = document.querySelector('[class*="candidates"]');
  return strip ? Array.from(strip.querySelectorAll("button")) : [];
}

/** R-427: the thread's own turns, in order. */
function threadTurns(): HTMLElement[] {
  return Array.from(document.querySelectorAll('[class*="turn"]')).filter((el) =>
    /(^|\s)[^\s]*turn_[^\s]*(\s|$)/.test(el.className),
  ) as HTMLElement[];
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

  // C2 (CONTRACT CHANGED, CLAUDE.md §4, S63-a review fix/CP-5): a written
  // single's own readout used to sit on the live status line indefinitely;
  // it is filed into the thread now and the live line goes back to empty
  // the moment that happens (`fileTurn`), which for a synchronous writer
  // (this file's own default `vi.fn()`) is the SAME tick as the Enter that
  // triggered it. The day-RENDERING this test is actually about
  // (`renderReadout`'s zone-aware label, F-153/R-426) only ever exists on
  // that live, optimistic line -- the thread keeps the raw ISO date verbatim
  // (`resolved.readout`, never reformatted) -- so `onOpen` is held pending
  // here instead of left to settle synchronously, the same shape CB-day-1
  // below now uses, to give the live line a moment to be read before it
  // would be filed.
  it("C2: a resolvable sentence opens the popover and shows the readout with the day rendered", () => {
    const { onOpen, input } = renderBar({ runs: [] });
    onOpen.mockReturnValue(new Promise(() => {}));

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

  // C4 (CONTRACT CHANGED, CLAUDE.md §4, R-437/CB-ent-4): this used to pin
  // that picking a candidate REWROTE the input with the completed, canonical
  // sentence (`setText(rendered)`). The maintainer's own words for R-437 are
  // "the box is empty after every Enter and every button press" -- the
  // completed form goes into the person's own bubble (`sentence`) instead,
  // never back into the box; CB-ent-4 (below) pins the box side of this
  // directly. This test keeps proving the ORIGINAL point (the chosen
  // person's id reaches the write) and adds the box's own new contract.
  it("C4: clicking a candidate empties the input and resolves the chosen person", () => {
    const { onOpen, input } = renderBar();
    fireEvent.change(input, {
      target: { value: "assign Sam to Housing A on Cell 1 in Line 1 from 10 to 2" },
    });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Sam Patel" }));

    expect(input.value).toBe("");
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

  // C7 (CONTRACT CHANGED, CLAUDE.md §4, R-437): this used to pin that Enter
  // left "gibberish" sitting in the box and a SECOND Escape was needed to
  // clear it. R-437 empties the box the instant Enter is pressed, whatever
  // it does with the sentence (CB-ent-2 pins the unreadable-sentence case
  // directly) -- there is nothing left in the input for a second Escape to
  // clear, so this keeps only the half that is still true: the first Escape
  // clears the status line.
  it("C7: Enter already empties the box for an unreadable sentence; Escape then clears the status line", () => {
    const { input } = renderBar();

    fireEvent.change(input, { target: { value: "gibberish" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(statusText()).toBe(SHAPE);
    expect(input.value).toBe("");

    fireEvent.keyDown(input, { key: "Escape" });
    expect(statusText()).toBe("");
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

  it("C10: joining the run sends the run target, the answer box is empty; Separate block sends direct", () => {
    const { onOpen, input } = renderBar({ runs: [RUN1] });
    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Housing A 08:00–16:00" }));

    // F-162 (CONTRACT CHANGED, CLAUDE.md 4 -- "say in writing whether they
    // were wrong or the contract changed"): the contract changed. While a
    // question stands the input is the ANSWER box, not the sentence box --
    // it was emptied when the question was raised, and answering with a
    // BUTTON never puts the sentence back. The sentence is not lost: it is
    // readable above the question line while it stands, and Escape restores
    // it to the input. Every one of these pins used to read `toBe(<the
    // sentence>)`.
    expect(input.value).toBe("");
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

  it("C12: pressing Change re-times the block through onRetime, the answer box is empty, readout says changing", () => {
    const { onOpen, onRetime, input } = renderBar({ assignments: [BLK1] });
    fireEvent.change(input, { target: { value: P1_RETIME_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Change 10:00–14:00" }));

    // F-162 (CONTRACT CHANGED, CLAUDE.md 4 -- "say in writing whether they
    // were wrong or the contract changed"): the contract changed. While a
    // question stands the input is the ANSWER box, not the sentence box --
    // it was emptied when the question was raised, and answering with a
    // BUTTON never puts the sentence back. The sentence is not lost: it is
    // readable above the question line while it stands, and Escape restores
    // it to the input. Every one of these pins used to read `toBe(<the
    // sentence>)`.
    expect(input.value).toBe("");
    expect(onOpen).not.toHaveBeenCalled();
    expect(onRetime).toHaveBeenCalledTimes(1);
    const [resolved] = onRetime.mock.calls[0] as [ResolvedCommand, { x: number; y: number }];
    expect(resolved.target).toEqual({ kind: "retime", assignmentId: "blk1" });
    expect(resolved.range).toEqual({ startMin: 3 * 1440 + 600, endMin: 3 * 1440 + 900 });
    // S63-a review fix (CP-5, CLAUDE.md §4): a synchronous write is filed
    // (and the live line cleared) in the same tick it happens -- the readout
    // reads from the thread now, not the live status line.
    expect(resolved.readout).toContain("· changing 10:00–14:00");
    expect(threadText()).toContain(`Written: ${resolved.readout}`);
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

    // S63-a review fix (CP-5, CLAUDE.md §4): filed (and the live line
    // cleared) the same tick -- the readout reads from the thread now.
    expect(threadText()).toContain(`Written: ${resolved.readout}`);
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

    // F-162 (CONTRACT CHANGED, CLAUDE.md 4 -- "say in writing whether they
    // were wrong or the contract changed"): the contract changed. While a
    // question stands the input is the ANSWER box, not the sentence box --
    // it was emptied when the question was raised, and answering with a
    // BUTTON never puts the sentence back. The sentence is not lost: it is
    // readable above the question line while it stands, and Escape restores
    // it to the input. Every one of these pins used to read `toBe(<the
    // sentence>)`.
    expect(input.value).toBe("");
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

  it("CU2: pressing Remove it calls onUnassign once with blk1, the answer box is empty, readout shown", () => {
    const { onUnassign, input } = renderBar({ assignments: [BLK1] });
    fireEvent.change(input, { target: { value: UNASSIGN_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));

    // F-162 (CONTRACT CHANGED, CLAUDE.md 4 -- "say in writing whether they
    // were wrong or the contract changed"): the contract changed. While a
    // question stands the input is the ANSWER box, not the sentence box --
    // it was emptied when the question was raised, and answering with a
    // BUTTON never puts the sentence back. The sentence is not lost: it is
    // readable above the question line while it stands, and Escape restores
    // it to the input. Every one of these pins used to read `toBe(<the
    // sentence>)`.
    expect(input.value).toBe("");
    expect(onUnassign).toHaveBeenCalledTimes(1);
    const [resolved] = onUnassign.mock.calls[0] as [ResolvedUnassign, { x: number; y: number }];
    expect(resolved.assignmentId).toBe("blk1");
    // S63-a review fix (CP-5, CLAUDE.md §4): filed (and the live line
    // cleared) the same tick -- the readout reads from the thread now.
    expect(threadText()).toContain(`Written: ${resolved.readout}`);
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

  // CM1 (CONTRACT CHANGED, CLAUDE.md §4, R-437 + S63-a review fix/CP-5): this
  // used to pin that the input kept the sentence after a written single
  // ("input unchanged" in its own title) -- the maintainer's own words for
  // R-437 are "Enter always empties it ... in every case", CB-ent-1's own
  // pin. The sentence is not lost, only moved: a synchronous write like this
  // file's own default `vi.fn()` is filed in the SAME tick (`fileTurn`), so
  // it reads from the thread, never a live bubble that would only ever flash
  // for an async write.
  it("CM1: naming BLK1 with a destination cell calls onMove once (move_cell), input empties (R-437), readout shown; nothing else called", () => {
    const { onOpen, onRetime, onBook, onRetimeRun, onUnassign, onMove, input } = renderBar({
      assignments: [BLK1],
    });

    fireEvent.change(input, { target: { value: MOVE_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(input.value).toBe("");
    expect(onMove).toHaveBeenCalledTimes(1);
    const [resolved] = onMove.mock.calls[0] as [ResolvedMove, { x: number; y: number }];
    expect(resolved.assignmentId).toBe("blk1");
    expect(resolved.target).toEqual({ kind: "move_cell" });
    expect(threadText()).toContain(`Written: ${resolved.readout}`);
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
    // S62-b re-check fix (1) (CONTRACT CHANGED, CLAUDE.md 4): a cancel used
    // to leave the status line BLANK, which on a screen whose input has just
    // been cleared too is indistinguishable from a bar that never heard the
    // word. Every cancel says the same two words now (`cancelStanding`).
    expect(statusText()).toBe("Left it.");
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
    // F-166 (CONTRACT CHANGED, CLAUDE.md 4): "none" no longer falls through
    // to the rules -- with a model reader wired, falling through MEANT
    // sending "yes" to the model, which has to answer with a form and so
    // invented one (a live run read a bare "yes" as `unassign "everyone" on
    // today`). A confirm word with nothing standing is answered, not parsed.
    // S63-a review fix (CP-5, CLAUDE.md §4): this "sentence" is filed (and
    // the live line cleared) as soon as it is answered -- the words are in
    // the thread's own `asked` bubble now, not the live status line.
    expect(threadText()).toContain("Nothing to say yes to.");
    // R-437 IS UNCONDITIONAL (CONTRACT CHANGED, CLAUDE.md §4, reviewer fix):
    // this used to keep "yes" in the box on purpose, reasoning that a bare
    // confirm/cancel word with nothing standing was "answered in place",
    // never a sentence of its own. The maintainer's own wording for R-437 --
    // "whether written, refused or standing" -- settles that judgment call
    // the other way: the word goes to the thread as the person's own bubble
    // like any other sentence, and the box empties the same as it does for
    // one.
    expect(input.value).toBe("");

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

  // F-162 (CONTRACT CHANGED, CLAUDE.md 4): this pin used to read "a typed
  // edit while a block question stands clears the question, the outline and
  // the stale button". That WAS the bug the maintainer reported: the input
  // still held the sentence while the question stood, so the only way to
  // type an answer was to edit the sentence, and editing the sentence was
  // read as abandoning it. The input is the ANSWER box now, and typing in it
  // keeps the question standing -- unless what is typed PARSES as a whole new
  // sentence, which is a new sentence and drops it (the CB-nc-6 rule,
  // widened to every question). Both halves are pinned here.
  it("CB-yes-10: typing an answer keeps the block question; typing a whole new sentence drops it, the outline and the stale button", () => {
    const { input, onUnassign, onHighlight } = renderBar({ assignments: [BLK1] });
    fireEvent.change(input, { target: { value: UNASSIGN_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("button", { name: "Remove it" })).toBeTruthy();
    // The answer box: emptied, and asking for what this question takes.
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("yes or no");

    // Half-typed nonsense is an ANSWER being composed, not a new sentence --
    // the question, its button and its outline all stand.
    fireEvent.change(input, { target: { value: `${UNASSIGN_SENTENCE}x` } });
    expect(screen.getByRole("button", { name: "Remove it" })).toBeTruthy();
    expect(statusText().startsWith("Remove Operator 1's Housing A block")).toBe(true);

    // A whole new sentence IS a new sentence: the question, the button and
    // the outline go.
    fireEvent.change(input, { target: { value: P1_SENTENCE } });

    expect(statusText()).toBe("");
    expect(screen.queryByRole("button", { name: "Remove it" })).toBeNull();
    expect(onHighlight).toHaveBeenLastCalledWith(null);
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
    // F-166 (CONTRACT CHANGED, CLAUDE.md 4): "none" no longer falls through
    // to the rules -- with a model reader wired, falling through MEANT
    // sending "yes" to the model, which has to answer with a form and so
    // invented one (a live run read a bare "yes" as `unassign "everyone" on
    // today`). A confirm word with nothing standing is answered, not parsed.
    // S63-a review fix (CP-5, CLAUDE.md §4): filed as soon as it is answered
    // -- reads from the thread's own `asked` bubble, not the live line.
    expect(threadText()).toContain("Nothing to say yes to.");
    // R-437 IS UNCONDITIONAL (CONTRACT CHANGED, CLAUDE.md §4, reviewer fix):
    // see CB-yes-8's own identical note -- the word goes to the thread as
    // the person's own bubble like any other sentence, box empty.
    expect(third.input.value).toBe("");
  });

  // -------------------------------------------------------------------
  // F-166 (found in S62-b's own live run of the real bar, 17 Sept): a bare
  // confirm or cancel word with NOTHING STANDING used to fall through to the
  // ordinary sentence path -- which, with the model reader wired, meant
  // sending it to the model. The model must answer with a form, so it made
  // one up: "yes" came back as `unassign "everyone" on today` and the bar
  // offered a lot that would have cleared the board. The word is answered
  // now, and never reaches the reader or the rules.
  // -------------------------------------------------------------------
  it("CB-yes-none-1: 'yes' with nothing standing is answered, never sent to the model", async () => {
    const fetchMock = stubFetch();
    const reader: Reader = vi.fn(async (): Promise<Reading> => ({ ok: false, reason: "garbled" }));
    const { input, onOpen } = renderBar({}, reader);

    fireEvent.change(input, { target: { value: "yes" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // S63-a review fix (CP-5, CLAUDE.md §4): filed (and the live line
    // cleared) as soon as it is answered -- reads from the thread's own
    // `asked` bubble now, not the live status line.
    expect(threadText()).toContain("Nothing to say yes to.");
    expect(reader).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
    // The turn is finished here -- nothing can ever answer it.
    const entry = postedEntry(fetchMock);
    expect(entry.heard).toBe("yes");
    expect(entry.model).toEqual({ skipped: "no question standing" });
    expect(entry.asked).toBe("Nothing to say yes to.");
    expect(entry.ran).toEqual([]);
  });

  it("CB-yes-none-2: 'no' and 'never mind' with nothing standing say so, and never reach the model either", () => {
    const reader: Reader = vi.fn(async (): Promise<Reading> => ({ ok: false, reason: "garbled" }));
    const first = renderBar({}, reader);
    fireEvent.change(first.input, { target: { value: "no" } });
    fireEvent.keyDown(first.input, { key: "Enter" });
    // S63-a review fix (CP-5, CLAUDE.md §4): filed (and the live line
    // cleared) as soon as it is answered -- reads from the thread now.
    expect(threadText()).toContain("Nothing to cancel.");
    expect(reader).not.toHaveBeenCalled();

    cleanup();
    const second = renderBar({}, reader);
    fireEvent.change(second.input, { target: { value: "never mind" } });
    fireEvent.keyDown(second.input, { key: "Enter" });
    expect(threadText()).toContain("Nothing to cancel.");
    expect(reader).not.toHaveBeenCalled();
  });

  it("CB-yes-none-3: 'ok' says the same -- but the create pop-up hand-off still fires when a sentence opened one", () => {
    const reader: Reader = vi.fn(async (): Promise<Reading> => ({ ok: false, reason: "garbled" }));
    // Nothing standing, and no pop-up either.
    const first = renderBar({}, reader, null, { onConfirmWord: () => "none" });
    fireEvent.change(first.input, { target: { value: "ok" } });
    fireEvent.keyDown(first.input, { key: "Enter" });
    // S63-a review fix (CP-5, CLAUDE.md §4): filed (and the live line
    // cleared) as soon as it is answered -- reads from the thread now.
    expect(threadText()).toContain("Nothing to say yes to.");
    expect(reader).not.toHaveBeenCalled();

    cleanup();
    // R-384, unchanged: a sentence-opened create pop-up still claims the word.
    const onConfirmWord = vi.fn((): ConfirmWordResult => "created");
    const second = renderBar({}, reader, null, { onConfirmWord });
    fireEvent.change(second.input, { target: { value: "ok" } });
    fireEvent.keyDown(second.input, { key: "Enter" });
    expect(onConfirmWord).toHaveBeenCalledTimes(1);
    expect(second.input.value).toBe("");
    expect(statusText()).not.toBe("Nothing to say yes to.");

    cleanup();
    // ... and a cancel word still closes it.
    const onCancelWord = vi.fn(() => true);
    const third = renderBar({}, reader, null, { onCancelWord });
    fireEvent.change(third.input, { target: { value: "no" } });
    fireEvent.keyDown(third.input, { key: "Enter" });
    expect(onCancelWord).toHaveBeenCalledTimes(1);
    expect(statusText()).toBe("");
  });

  // -------------------------------------------------------------------
  // S62-b reviewer fix (A): F-166's first guard only covered "no question
  // standing". At a question that did not itself take the word, "no" still
  // fell through to the model -- which read it as a removal, and the bar
  // WROTE it ("Removing Tom Baker's Housing A block"). A word that means
  // "leave it" must never delete anything. These three drive the shapes that
  // hole was open on.
  // -------------------------------------------------------------------
  it("CB-yes-none-4: 'no' at a run_exists question leaves it -- the reader is never asked, nothing is written", async () => {
    // The reader answers "no service", so the SENTENCE falls back to the
    // rules and raises its question exactly as it would with no reader at
    // all. What these pins count is the calls: one for the sentence, and
    // never one for the word.
    const reader: Reader = vi.fn(async (): Promise<Reading> => ({
      ok: false,
      reason: "no-service",
    }));
    const { input, onOpen, onRetime } = renderBar({ runs: [RUN1] }, reader);
    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    await act(async () => {});
    expect(reader).toHaveBeenCalledTimes(1);
    expect(statusText()).toBe(
      "A Housing A job is already booked on Cell 1, Housing A 08:00–16:00. Join it, or make a separate block?",
    );
    // The placeholder names what this question actually takes -- never "yes",
    // which it does not (reviewer fix A's other half).
    expect(input.placeholder).toBe("a name, or no");

    fireEvent.change(input, { target: { value: "no" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(reader).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
    expect(onRetime).not.toHaveBeenCalled();
    expect(statusText()).toBe("Left it.");
    expect(screen.queryByRole("button", { name: "Separate block" })).toBeNull();
    expect(input.value).toBe("");
  });

  it("CB-yes-none-5: 'yes' at a run_exists question re-asks rather than picking one -- and never reaches the reader", async () => {
    const reader: Reader = vi.fn(async (): Promise<Reading> => ({
      ok: false,
      reason: "no-service",
    }));
    const { input, onOpen } = renderBar({ runs: [RUN1] }, reader);
    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    await act(async () => {});

    fireEvent.change(input, { target: { value: "yes" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(reader).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
    expect(statusText()).toBe("Say which one.");
    // The question stands, with both its buttons.
    expect(screen.getByRole("button", { name: "Housing A 08:00–16:00" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Separate block" })).toBeTruthy();
  });

  it("CB-yes-none-6: 'no' at an ambiguous person question leaves it, drops the held sentence, and never reaches the reader", async () => {
    const reader: Reader = vi.fn(async (): Promise<Reading> => ({
      ok: false,
      reason: "no-service",
    }));
    const { input, onOpen } = renderBar({ runs: [] }, reader);
    fireEvent.change(input, {
      target: { value: "assign Sam to Housing A on Cell 1 in Line 1 from 10 to 2" },
    });
    fireEvent.keyDown(input, { key: "Enter" });
    await act(async () => {});
    expect(reader).toHaveBeenCalledTimes(1);
    expect(statusText()).toBe('Which person? "Sam" matches 2:');
    expect(input.placeholder).toBe("a name, or no");

    fireEvent.change(input, { target: { value: "no" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(reader).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
    expect(statusText()).toBe("Left it.");
    expect(screen.queryByRole("button", { name: "Sam Patel" })).toBeNull();
    // The held sentence went with it -- a later "yes" has nothing to act on.
    fireEvent.change(input, { target: { value: "yes" } });
    fireEvent.keyDown(input, { key: "Enter" });
    // S63-a review fix (CP-5, CLAUDE.md §4): filed (and the live line
    // cleared) as soon as it is answered -- reads from the thread now.
    expect(threadText()).toContain("Nothing to say yes to.");
    expect(reader).toHaveBeenCalledTimes(1);
  });

  it("CB-yes-none-7: every cancel says the same thing -- the lot's question, a block question and the reason question all leave it", () => {
    // S62-b re-check fix (1): three branches returned before F-166's floor
    // and called `setStatus(null)`, so a cancel at any of them left the status
    // line blank -- on a screen whose input had just been emptied, that is
    // indistinguishable from a bar that never heard the word.

    // 1. a block question (remove_which).
    const first = renderBar({ assignments: [BLK1] });
    fireEvent.change(first.input, { target: { value: UNASSIGN_SENTENCE } });
    fireEvent.keyDown(first.input, { key: "Enter" });
    expect(screen.getByRole("button", { name: "Remove it" })).toBeTruthy();
    fireEvent.change(first.input, { target: { value: "never mind" } });
    fireEvent.keyDown(first.input, { key: "Enter" });
    expect(statusText()).toBe("Left it.");
    expect(first.onUnassign).not.toHaveBeenCalled();

    cleanup();

    // 2. the lot's own "N commands ready".
    const second = renderBar({ assignments: [BLK1, BLK_SP] });
    fireEvent.change(second.input, { target: { value: LOT_REMOVE_SENTENCE } });
    fireEvent.keyDown(second.input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    expect(statusText()).toMatch(/^2 commands ready: /);
    fireEvent.change(second.input, { target: { value: "no" } });
    fireEvent.keyDown(second.input, { key: "Enter" });
    expect(statusText()).toBe("Left it.");
    expect(second.onRunLot).not.toHaveBeenCalled();
    // The lot went with it: a later "yes" has nothing to run.
    fireEvent.change(second.input, { target: { value: "yes" } });
    fireEvent.keyDown(second.input, { key: "Enter" });
    // S63-a review fix (CP-5, CLAUDE.md §4): filed (and the live line
    // cleared) as soon as it is answered -- reads from the thread now.
    expect(threadText()).toContain("Nothing to say yes to.");
    expect(second.onRunLot).not.toHaveBeenCalled();

    cleanup();

    // 3. the override-reason question.
    const third = renderBar({
      runs: [],
      certificateGaps: () => [{ skill: "Welding", state: "never-trained" as const }],
      eligibilityPolicy: () => "warn" as const,
    });
    fireEvent.change(third.input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(third.input, { key: "Enter" });
    expect(statusText()).toContain("Say the reason to schedule anyway");
    fireEvent.change(third.input, { target: { value: "no" } });
    fireEvent.keyDown(third.input, { key: "Enter" });
    expect(statusText()).toBe("Left it.");
    expect(third.onOpen).not.toHaveBeenCalled();
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

    await waitFor(() => expect(threadText()).toContain("Done: 2 commands."));

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
      expect(threadText()).toContain(
        `Did 1 of 2; the next failed: boom. The 1 done stayed: ${renderedReadout(resolvedList[0].readout)}.`,
      ),
    );
    // Not "boom.." -- the bar doesn't add a period on top of the message's
    // own.

    expect(input.value).toBe("yes");
    expect(onHighlight).toHaveBeenLastCalledWith(null);
  });

  // CR-1 (reviewer fix, S63 review): `rewriteCapRefusal` (brief §5, CB-ref-1)
  // was applied on the single-sentence write path only -- `runLotNow`'s own
  // `result.error` (`LotResult`'s own doc: "the same wording a toast would
  // show") is the identical capacity sentence and reached the thread/status
  // verbatim, "try the split again" included, the exact bug brief §5 exists
  // to fix, just through the lot door.
  it("CR-1: a lot step's capacity refusal is rewritten the same way a single sentence's is -- no 'try the split again' through the lot door either", async () => {
    const onRunLot = vi.fn(async (_resolved: ResolvedAny[]): Promise<LotResult> => ({
      done: 1,
      error:
        "Sam Patel would reach 110% (cap 100%). Someone else changed their load — try the split again.",
    }));
    const { input } = renderBar({ assignments: [BLK1, BLK_SP] }, null, null, {}, { onRunLot });

    fireEvent.change(input, { target: { value: LOT_REMOVE_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));

    fireEvent.change(input, { target: { value: "yes" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(onRunLot).toHaveBeenCalledTimes(1));

    // CP-7 (CONTRACT CHANGED, CLAUDE.md §4, session 178): a lot's last word
    // is filed into the thread the moment the lot finishes, the same as a
    // single's readout (CP-5), so it is read from the thread, not the live
    // line, which is empty once the turn is filed.
    await waitFor(() =>
      expect(threadText()).toContain(
        "Did 1 of 2; the next failed: Sam Patel would be over the cap today (110% of 100%). Nothing changed.",
      ),
    );
    expect(threadText()).not.toContain("try the split again");
    expect(statusText()).toBe("");
  });

  it("CP-7: a finished lot's 'Done' is in the thread once and the live line is empty -- the sentence after a lot starts from a clean live area", async () => {
    const onRunLot = vi.fn(async (_resolved: ResolvedAny[]): Promise<LotResult> => ({
      done: 2,
      error: null,
    }));
    const { input } = renderBar({ assignments: [BLK1, BLK_SP] }, null, null, {}, { onRunLot });

    fireEvent.change(input, { target: { value: LOT_REMOVE_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));

    fireEvent.change(input, { target: { value: "yes" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(onRunLot).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(threadText()).toContain("Done: 2 commands."));
    // Once, in the thread; nothing left on the live line (found by the typed
    // walk, session 178: "Done: 2 commands." used to stay live as a second
    // copy, and every sentence after a lot inherited a stale live turn).
    expect(threadText().split("Done: 2 commands.").length).toBe(2);
    expect(statusText()).toBe("");
    expect(input.value).toBe("");
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
    // S62-b re-check fix (1) (CONTRACT CHANGED, CLAUDE.md 4): a cancel used
    // to leave the status line BLANK, which on a screen whose input has just
    // been cleared too is indistinguishable from a bar that never heard the
    // word. Every cancel says the same two words now (`cancelStanding`).
    expect(statusText()).toBe("Left it.");
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

    // a typed edit. F-162 (CONTRACT CHANGED, CLAUDE.md 4): the lot's own
    // listing is an answer box too ("yes or no"), so half-typed nonsense
    // keeps it standing -- only a whole new sentence drops it. This leg used
    // to type `${LOT_REMOVE_SENTENCE}x` and expect the lot gone.
    ({ input, onHighlight } = reachLotStatus());
    fireEvent.change(input, { target: { value: `${LOT_REMOVE_SENTENCE}x` } });
    expect(statusText()).toMatch(/^2 commands ready: /);
    fireEvent.change(input, { target: { value: P1_SENTENCE } });
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
    await waitFor(() => expect(threadText()).toContain("Done: 2 commands."));
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
    await waitFor(() => expect(threadText()).toContain("Done: 2 commands."));
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
    await waitFor(() => expect(threadText()).toContain("Done: 2 commands."));
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
  const onOpen = vi.fn().mockReturnValue(WRITTEN);
  const onRetime = vi.fn().mockReturnValue(WRITTEN);
  const onBook = vi.fn().mockReturnValue(WRITTEN);
  const onRetimeRun = vi.fn().mockReturnValue(WRITTEN);
  const onUnassign = vi.fn().mockReturnValue(WRITTEN);
  const onMove = vi.fn().mockReturnValue(WRITTEN);
  const onSetHeadcount = vi.fn().mockReturnValue(WRITTEN);
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
    await waitFor(() => expect(threadText()).toContain("Done: 2 commands."));

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
    await waitFor(() => expect(threadText()).toContain("Done: 2 commands."));

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
    // S63-a review fix (CP-5, CLAUDE.md §4): a plain readout ends the entry
    // (`traceQuestionStatus`'s own "readout" branch) the same tick it is
    // shown, so it is filed (and the live line cleared) immediately -- it
    // reads from the thread's own `asked` bubble now.
    expect(threadText()).toContain(`Cell 3 has nobody on it ${dayLabel}.`);
    // R-427: the candidate strip, not the whole bar -- the thread's "Clear
    // history" control is a button too (see `candidateButtons`).
    expect(candidateButtons()).toHaveLength(0);
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
    // S63-a review fix (CP-5, CLAUDE.md §4): filed (and the live line
    // cleared) the same tick -- the readout reads from the thread now.
    expect(resolved.readout).toContain("10:15");
    expect(threadText()).toContain(`Written: ${resolved.readout}`);
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
    await waitFor(() => expect(threadText()).toContain("Done: 2 commands."));

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

    // R-437 (CONTRACT CHANGED, CLAUDE.md §4): this used to pin that picking
    // the candidate rewrote the input with the completed sentence
    // (`setText(rendered)`); the maintainer's own words are "the box is
    // empty after every ... button press" -- the completed form goes into
    // the person's own bubble (`sentence`) now, never back into the box.
    expect(input.value).toBe("");
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

    // R-437 (CONTRACT CHANGED, CLAUDE.md §4): see CB-x-10's own identical
    // note -- the completed sentence goes into the person's bubble now,
    // never back into the box.
    expect(input.value).toBe("");
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
    // S62-b re-check fix (1) (CONTRACT CHANGED, CLAUDE.md 4): a cancel used
    // to leave the status line BLANK, which on a screen whose input has just
    // been cleared too is indistinguishable from a bar that never heard the
    // word. Every cancel says the same two words now (`cancelStanding`).
    expect(statusText()).toBe("Left it.");
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

    // a typed edit -- a brand-new sentence works right after. F-162
    // (CONTRACT CHANGED, CLAUDE.md 4): "something else entirely" parses as
    // nothing, so it is an ANSWER being composed and the lot stands; the
    // sentence after it is what drops the lot.
    ({ input } = reachExpandedLot());
    fireEvent.change(input, { target: { value: "something else entirely" } });
    expect(statusText()).toMatch(/^2 commands ready: /);
    fireEvent.change(input, { target: { value: P1_SENTENCE } });
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
    await waitFor(() => expect(threadText()).toContain("Done: 4 commands."));
    expect(onRunLot).toHaveBeenCalledTimes(1);
  });

  it("CB-x-17: 'clear Cell 1 today' with nobody there is a plain readout, never the same-block collision message (no duplicates from an empty expansion)", () => {
    const { input, onRunLot } = renderXBar();

    fireEvent.change(input, { target: { value: "clear Cell 1 today" } });
    fireEvent.keyDown(input, { key: "Enter" });

    const dayLabel = formatDayLabel(new Date("2026-09-03T00:00:00Z"), "d_mon_yyyy", "UTC");
    // S63-a review fix (CP-5, CLAUDE.md §4): see CB-x-5's own identical note
    // -- a plain readout is filed (and the live line cleared) the same tick.
    expect(threadText()).toContain(`Cell 1 has nobody on it ${dayLabel}.`);
    expect(threadText()).not.toContain("name the same block");
    // R-427: see CB-x-5's own note.
    expect(candidateButtons()).toHaveLength(0);
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
    await waitFor(() => expect(threadText()).toContain("Done: 2 commands."));

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
    // S63-a review fix (CP-5, CLAUDE.md §4): filed (and the live line
    // cleared) the same tick -- the readout reads from the thread now.
    expect(resolved.readout).toContain("Sam · Cell 1 · ends 15:00, was 14:00");
    expect(threadText()).toContain(`Written: ${resolved.readout}`);
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
    // S63-a review fix (CP-5, CLAUDE.md §4): filed (and the live line
    // cleared) the same tick -- the readout reads from the thread now.
    expect(resolved.readout).toContain("4 people");
    expect(threadText()).toContain(`Written: ${resolved.readout}`);
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
    await waitFor(() => expect(threadText()).toContain("Done: 2 commands."));

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
    await waitFor(() => expect(threadText()).toContain("Done: 2 commands."));
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
    // S63-a review fix (CP-5, CLAUDE.md §4): filed (and the live line
    // cleared) the same tick -- the readout reads from the thread now.
    expect(resolved.readout).toContain("Sam · Cell 1 · ends 15:00, was 14:00");
    expect(threadText()).toContain(`Written: ${resolved.readout}`);
  });

  // S63-a review fix (CP-5, CLAUDE.md §4): `onSetHeadcount` is held pending
  // here now (never settling within the test), the same shape C2/CB-day-1
  // use -- this test's own point is the OPTIMISTIC readout showing before
  // the write is known to have succeeded, which is only observable on the
  // live line for a write that has not yet settled (a settled one -- this
  // file's own default synchronous `vi.fn()` -- is filed, and the live line
  // cleared, in the very same tick; `fileTurn`).
  it("CB-y-12: reviewer scenario 4 -- the headcount readout shows immediately on Enter regardless of the async write's own outcome (fire-and-forget, same shape as onRetime/onUnassign/onMove); a later mutation failure surfaces through the toast useDragGesture's own failWith writes, never the bar's status -- ACCEPTABLE, matches every other single-write intent", () => {
    const { onSetHeadcount, input } = renderXBar({ runs: [RUN_X] });
    onSetHeadcount.mockReturnValue(new Promise(() => {}));

    fireEvent.change(input, { target: { value: "make the Housing A job on Cell 1 4 people" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // The readout is shown SYNCHRONOUSLY, before `onSetHeadcount`'s own
    // (async, void) write could possibly have settled either way -- the bar
    // has no promise to await here, unlike `onRunLot`'s lot path.
    expect(onSetHeadcount).toHaveBeenCalledTimes(1);
    expect(statusText()).toContain("4 people");
    // R-437 (CONTRACT CHANGED, CLAUDE.md §4): this used to pin that the
    // input was "never cleared for a single (non-lot) write -- success or
    // failure look identical from here". R-437 (CB-ent-1) empties the box on
    // Enter regardless, so success and failure keep looking identical from
    // here -- just both empty now instead of both unchanged.
    expect(input.value).toBe("");
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

    // S63-a review fix (CP-5, CLAUDE.md §4): the " · read by the model"
    // suffix lives only on the live, OPTIMISTIC status line (`runCommand`'s
    // own `suffix` argument -- never stored in `entry.ran`, so the thread's
    // "Written: …" never carries it) -- `onOpen` is held pending so that
    // line is still there to read once the model has answered, the same
    // shape C2/CB-day-1 use.
    const { onOpen, input } = renderBar({ runs: [] }, fakeReader);
    onOpen.mockReturnValue(new Promise(() => {}));
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
    // S63-a review fix (CP-5, CLAUDE.md §4): see CB-model-1's own identical
    // note -- the "· read by the rules (…)" suffix only ever lives on the
    // live, optimistic status line.
    const { onOpen, input } = renderBar({ runs: [] }, fakeReader);
    onOpen.mockReturnValue(new Promise(() => {}));

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

  // CB-model-4 (CONTRACT CHANGED, CLAUDE.md §4, R-437): a bare second Enter
  // used to resubmit the SAME sentence, still sitting in the box while
  // "Reading…" stood. R-437 (CB-ent-1) empties the box the moment the first
  // Enter is pressed, so a second Enter with nothing retyped now submits an
  // empty string (no reader call at all) rather than reading again -- this
  // retypes the sentence first, the way a person actually retries a slow
  // read once the box is empty.
  it("CB-model-4: 'Reading…' shows while pending; a second Enter (after retyping) aborts the first (its signal) and reads again", async () => {
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

    fireEvent.change(input, { target: { value: P1_SENTENCE } });
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

    // R-437 (CONTRACT CHANGED, CLAUDE.md §4): "exactly as Enter does" now
    // includes emptying the box (CB-ent-1) -- this test's own title is the
    // reason the assertion follows Enter's contract rather than pinning its
    // own.
    expect(input.value).toBe("");
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
    // S63-a review fix (CP-5, CLAUDE.md §4): a synchronous write is filed
    // (and the live line cleared) the same tick -- the readout reads from
    // the thread now, not the live status line.
    expect(threadText()).not.toBe("");

    // The real API fires `onEnd` on its own once a final result has settled
    // the session -- nothing here presses the mic button again.
    fire.end();

    fireEvent.keyDown(input, { key: "Escape" });

    // Review finding 1: pre-fix, `recognitionRef` still held the dead
    // handle, so this Escape called `stop()` on it and returned before the
    // status line was cleared.
    expect(stop).not.toHaveBeenCalled();
    expect(statusText()).toBe("");
    // R-437 (CONTRACT CHANGED, CLAUDE.md §4): the final result already
    // emptied the box on arrival (CB-ent-1, same as an Enter's own written
    // single) and Escape no longer puts anything back into it (CB-ent-3).
    expect(input.value).toBe("");
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

      // S62-b re-check fix (1): every cancel says so (was `toBe("")`).
      expect(statusText()).toBe("Left it.");
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
    // R-437 (CONTRACT CHANGED, CLAUDE.md §4): a final result submits exactly
    // as Enter does (CB-mic-4's own title), which now empties the box
    // (CB-ent-1).
    expect(input.value).toBe("");

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

    await waitFor(() => expect(threadText()).toContain("Done: 2 commands."));
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
    // CB-t-10 (CONTRACT CHANGED, CLAUDE.md §4, R-437/CB-ent-3): this used to
    // say the sentence came back into the box for the second Escape (per the
    // old C7) to clear. R-437 empties the box the moment the question was
    // first asked (Enter, not Escape) and Escape no longer puts anything
    // back into it -- the box is already empty here, and stays that way.
    expect(input.value).toBe("");

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

    // R-437 (CONTRACT CHANGED, CLAUDE.md §4): a final result submits exactly
    // as Enter does (CB-mic-4's own title), which now empties the box
    // (CB-ent-1).
    expect(input.value).toBe("");
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

  // S63-a review fix (CP-5, CLAUDE.md §4): `onOpen` is held pending here --
  // this file's own default synchronous `vi.fn()` would file the turn (and
  // clear the live line, `fileTurn`) in the same tick as the Enter that
  // wrote it, leaving nothing here for a ctx flicker to prove it kept.
  it("CB-keep-3: a pop-up opening from a sentence keeps the status through a ctx that goes null and back", () => {
    const { onOpen, input, rerenderCtx } = renderBar({ runs: [] });
    onOpen.mockReturnValue(new Promise(() => {}));
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
  // S63-a review fix (CP-5, CLAUDE.md §4): `onBook` is held pending -- a
  // synchronous write would file this turn (and clear the live line,
  // `fileTurn`) in the same tick as the Enter that wrote it, and the
  // zone-aware day label this test is actually about (F-153/R-426) only
  // ever lives on that live, optimistic line -- the thread keeps the raw
  // ISO date verbatim, never reformatted.
  it("CB-day-1: a readout carrying 2026-09-16 under America/Chicago renders 'Wed Sep 16', never Tue", () => {
    const onBook = vi.fn(() => new Promise<never>(() => {}));
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
      expect(threadText()).toContain(
        `Did 1 of 2; the next failed: Tom Baker is not certified for Cell 1: missing Welding. The 1 done stayed: ${renderedReadout(resolved[0].readout)}.`,
      ),
    );
    expect(threadText()).not.toContain("reverted");
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
// ---------------------------------------------------------------------------
// F-162 (the maintainer, 17 Sept, two screenshots): THE ANSWER BOX.
//
// "Tom Baker is not certified for Cell 1: missing Welding. Say the reason to
// schedule anyway, or no." and a lot's "say or type yes to do them" -- both
// above an input still holding the sentence. The person had to clear the
// sentence to type the answer, and clearing the sentence was what the bar read
// as abandoning it; the trace shows the Tom Baker sentence typed three times
// with no answer ever recorded.
// ---------------------------------------------------------------------------
describe("CB-ans: the answer box (F-162)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("CB-ans-1: a candidate question empties the input, says what it takes, and keeps the sentence readable above", () => {
    const { input } = renderBar();
    const sentence = "assign Sam to Housing A on Cell 1 in Line 1 from 10 to 2";
    fireEvent.change(input, { target: { value: sentence } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toBe('Which person? "Sam" matches 2:');
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("a name, or no");
    // The sentence is still on screen -- in its OWN line, never inside the
    // aria-live status (which is the question).
    expect(document.body.textContent).toContain(`You said: ${sentence}`);
  });

  it("CB-ans-2: typing a candidate's name answers the question -- the held command is never dropped and the pick runs", () => {
    const { onOpen, input } = renderBar({ runs: [] });
    fireEvent.change(input, {
      target: { value: "assign Sam to Housing A on Cell 1 in Line 1 from 10 to 2" },
    });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(statusText()).toBe('Which person? "Sam" matches 2:');

    // Typed one character at a time is still an ANSWER, not a new sentence:
    // the question and its buttons stand throughout.
    fireEvent.change(input, { target: { value: "Sam" } });
    expect(statusText()).toBe('Which person? "Sam" matches 2:');
    fireEvent.change(input, { target: { value: "Sam Patel" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onOpen).toHaveBeenCalledTimes(1);
    const [resolved] = onOpen.mock.calls[0] as [ResolvedCommand, { x: number; y: number }];
    expect(resolved.operatorId).toBe("sp");
  });

  it("CB-ans-3: a not_certified warn question takes the reason in the empty box, with the placeholder that says so", () => {
    const { onOpen, input } = renderBar({
      runs: [],
      certificateGaps: () => [{ skill: "Welding", state: "never-trained" as const }],
      eligibilityPolicy: () => "warn" as const,
    });
    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toBe(
      "Operator 1 is not certified for Cell 1: missing Welding. Say the reason to schedule anyway, or no.",
    );
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("the reason, or no");

    fireEvent.change(input, { target: { value: "covering for Sam" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onOpen).toHaveBeenCalledTimes(1);
    const [resolved] = onOpen.mock.calls[0] as [ResolvedCommand, { x: number; y: number }];
    expect(resolved.override).toEqual({ reason: "covering for Sam" });
  });

  it("CB-ans-4: text that PARSES as a whole new sentence is a new sentence -- the question goes and the sentence runs", () => {
    const { onOpen, input } = renderBar({ runs: [] });
    fireEvent.change(input, {
      target: { value: "assign Sam to Housing A on Cell 1 in Line 1 from 10 to 2" },
    });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(statusText()).toBe('Which person? "Sam" matches 2:');

    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    expect(statusText()).toBe("");
    expect(input.placeholder).toBe("Assign Sam to Housing A on Cell 1 in Line 1 from 10 to 2");
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onOpen).toHaveBeenCalledTimes(1);
    const [resolved] = onOpen.mock.calls[0] as [ResolvedCommand, { x: number; y: number }];
    expect(resolved.operatorId).toBe("op1");
  });

  // CB-ans-5 (CONTRACT CHANGED, CLAUDE.md §4, R-437 + S63-a review fix/CP-5):
  // this pinned that Escape on a standing question put the sentence back in
  // the box, ready to edit. The maintainer's own words for R-437 are the
  // opposite: "Escape ... no longer puts the sentence back into the box --
  // it stays readable in its bubble ... the box stays empty." CB-ent-3 below
  // is this pin's direct replacement in spirit; this one is kept (updated)
  // rather than deleted because it still exercises the F-162 answer-box
  // question shape CB-ent-3 does not (a candidate question, not a plain
  // unreadable sentence). CP-5 narrows "its own bubble" further still:
  // Escape files the turn (`finishTrace`), which clears the live
  // `sentence`/`status` the same way a written single's own filing does --
  // the sentence reads from the THREAD's own bubble now, not a live one.
  it("CB-ans-5: Escape drops the question, empties the box, and files the turn into the thread", () => {
    stubFetch();
    const { input } = renderBar();
    const sentence = "assign Sam to Housing A on Cell 1 in Line 1 from 10 to 2";
    fireEvent.change(input, { target: { value: sentence } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("");

    fireEvent.keyDown(input, { key: "Escape" });

    expect(statusText()).toBe("");
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("Assign Sam to Housing A on Cell 1 in Line 1 from 10 to 2");
    expect(threadText()).toContain(sentence);
  });
});

// ---------------------------------------------------------------------------
// R-437 (the maintainer, S63-a): "Enter always empties it: the sentence goes
// into the store's sentence (the right bubble) in every case, and the box is
// empty for the next sentence." Before this, `submitText` left the sentence
// in the input on a written single, a shape hint, and a readout, and only
// F-162's own answer-box question (CB-ans-1..5 above) emptied it.
// ---------------------------------------------------------------------------
describe("CB-ent: Enter always empties the box (R-437)", () => {
  // CB-ent-1 (CONTRACT NARROWED, CLAUDE.md §4, S63-a review fix/CP-5): a
  // written single's own turn is filed the same tick it writes (this file's
  // default synchronous `vi.fn()`), which clears the live `sentence`/
  // `status` right back to idle (`fileTurn`) -- so there is no live "You
  // said" bubble left to read here; the sentence is in the THREAD's own
  // right bubble instead, once, exactly where CP-5 says it belongs.
  it("CB-ent-1: Enter on a written single leaves the box empty and the sentence in the thread", () => {
    const { input } = renderBar({ runs: [] });
    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(input.value).toBe("");
    expect(statusText()).toBe("");
    expect(threadText()).toContain(P1_SENTENCE);
    expect(threadText()).toContain("Written:");
  });

  it("CB-ent-2: Enter on an unreadable sentence leaves the box empty with the hint in the board's bubble", () => {
    const { input } = renderBar();
    fireEvent.change(input, { target: { value: "gibberish" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(input.value).toBe("");
    expect(statusText()).toBe(SHAPE);
    expect(document.body.textContent).toContain("You said: gibberish");
  });

  it("CB-ent-3: Escape on a standing question leaves the box empty", () => {
    const { input } = renderBar();
    fireEvent.change(input, {
      target: { value: "assign Sam to Housing A on Cell 1 in Line 1 from 10 to 2" },
    });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(statusText()).toBe('Which person? "Sam" matches 2:');

    fireEvent.keyDown(input, { key: "Escape" });

    expect(input.value).toBe("");
  });

  // CB-ent-4 (S63-a review fix, R-437): the maintainer's own screenshot
  // still showed the completed sentence sitting in the box after "Which
  // part?" was answered by a button (`pickCandidate`'s own `setText(rendered)`
  // -- fixed to set `sentence` instead, alongside `pickPartAsPlace`'s
  // identical call).
  it("CB-ent-4: answering a question by button leaves the box empty", () => {
    const { input } = renderBar();
    fireEvent.change(input, {
      target: { value: "assign Sam to Housing A on Cell 1 in Line 1 from 10 to 2" },
    });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(statusText()).toBe('Which person? "Sam" matches 2:');

    fireEvent.click(screen.getByRole("button", { name: "Sam Patel" }));

    expect(input.value).toBe("");
  });
});

// ---------------------------------------------------------------------------
// F-164 (found reading the trace of the maintainer's swap, 17 Sept): the
// trace's LAST WORD. `runLotNow` used to finish the entry BEFORE it set the
// "Did 3 of 4" status, so nothing in `bar.jsonl` said why the fourth step
// stopped; and a single pushed its readout into `ran` the instant it called
// the writer, so a sentence whose write never landed read exactly like one
// that did (F-165).
// ---------------------------------------------------------------------------
describe("CB-t-outcome: the writer's answer is the entry's last word (F-164)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("CB-t-15: a lot that stops part-way records its failure text as the entry's outcome, and only the steps that ran", async () => {
    const fetchMock = stubFetch();
    let settle: (r: LotResult) => void = () => {};
    const { input, onRunLot } = renderBar(
      { assignments: [BLK1, BLK_SP] },
      null,
      null,
      {},
      { onRunLot: () => new Promise<LotResult>((res) => (settle = res)) },
    );

    fireEvent.change(input, { target: { value: LOT_REMOVE_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    expect(statusText()).toMatch(/^2 commands ready: /);

    fireEvent.click(screen.getByRole("button", { name: "Do all 2" }));
    expect(onRunLot).toHaveBeenCalledTimes(1);
    await act(async () => {
      settle({ done: 1, error: "That person belongs to a different part of the structure." });
    });

    expect(threadText()).toContain("Did 1 of 2; the next failed:");
    const entry = postedEntry(fetchMock);
    // The one thing the maintainer's own trace could not tell him. CP-7
    // (session 178): the outcome is the whole sentence the thread shows, the
    // "stayed" clause included, so this reads the failure's own words rather
    // than the exact string.
    expect(entry.outcome).toContain(
      "Did 1 of 2; the next failed: That person belongs to a different part of the structure.",
    );
    // And only the step that actually ran.
    expect(entry.ran).toHaveLength(1);
  });

  it("CB-t-16: a single whose writer answers `popup` writes NOTHING under ran, and (F-167) keeps its entry OPEN until the pop-up answers", () => {
    const fetchMock = stubFetch();
    const { onOpen, input, unmount } = renderBar({ runs: [] });
    onOpen.mockReturnValue({ kind: "popup", waitingFor: "the create pop-up" });

    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onOpen).toHaveBeenCalledTimes(1);
    // F-167 (CONTRACT CHANGED, CLAUDE.md 4): this pin used to read the posted
    // entry HERE. Nothing is posted yet -- the write is with the pop-up and
    // the sentence is not over. What the person sees meanwhile is the turn in
    // the thread, waiting.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Waiting: the create pop-up");

    // A pop-up that never answers is still flushed when the bar goes away
    // (F-157), carrying what was actually known.
    unmount();
    const entry = postedEntry(fetchMock);
    expect(entry.outcome).toBe("popup: the create pop-up");
    expect(entry.ran).toEqual([]);
  });

  // -------------------------------------------------------------------
  // F-167 (the other half of F-165's silence): `popup` is honest but not
  // final. Every writer prop is handed a REPORTER as its third argument,
  // which the pop-up it opened calls once -- when Create succeeds, when the
  // server refuses, or when it is cancelled. The entry's `outcome`/`ran` come
  // from THAT, and only then is the entry finished.
  // -------------------------------------------------------------------
  it("CB-t-18: the pop-up reporting `written` fills ran and the outcome, posts ONE line, and the thread stops saying Waiting", () => {
    const fetchMock = stubFetch();
    const { onOpen, input } = renderBar({ runs: [] });
    onOpen.mockReturnValue({ kind: "popup", waitingFor: "the create pop-up" });

    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    const [, , report] = onOpen.mock.calls[0] as [
      ResolvedCommand,
      { x: number; y: number },
      (r: { kind: "written"; readout?: string }) => void,
    ];
    expect(document.body.textContent).toContain("Waiting: the create pop-up");

    act(() => report({ kind: "written", readout: "Operator 1 → Housing A · Cell 1" }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const entry = postedEntry(fetchMock);
    expect(entry.outcome).toBe("written");
    expect(entry.ran).toEqual(["Operator 1 → Housing A · Cell 1"]);
    expect(document.body.textContent).not.toContain("Waiting: the create pop-up");
    expect(document.body.textContent).toContain("Written: Operator 1 → Housing A · Cell 1");
    // Reporting twice (a pop-up that submits and then closes) changes nothing.
    act(() => report({ kind: "written" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("CB-t-19: the pop-up reporting `refused` records the server's own message and leaves ran empty", () => {
    const fetchMock = stubFetch();
    const { onOpen, input } = renderBar({ runs: [] });
    onOpen.mockReturnValue({ kind: "popup", waitingFor: "the create pop-up" });

    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    const [, , report] = onOpen.mock.calls[0] as [
      ResolvedCommand,
      { x: number; y: number },
      (r: { kind: "refused"; message: string }) => void,
    ];

    act(() =>
      report({
        kind: "refused",
        message: "That person does not belong to this part of the structure.",
      }),
    );

    const entry = postedEntry(fetchMock);
    expect(entry.outcome).toBe(
      "refused: That person does not belong to this part of the structure.",
    );
    expect(entry.ran).toEqual([]);
    expect(document.body.textContent).toContain(
      "Refused: That person does not belong to this part of the structure.",
    );
  });

  it("CB-t-20: the pop-up reporting `cancelled` says so -- neither written nor refused", () => {
    const fetchMock = stubFetch();
    const { onOpen, input } = renderBar({ runs: [] });
    onOpen.mockReturnValue({ kind: "popup", waitingFor: "the create pop-up" });

    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    const [, , report] = onOpen.mock.calls[0] as [
      ResolvedCommand,
      { x: number; y: number },
      (r: { kind: "cancelled" }) => void,
    ];

    act(() => report({ kind: "cancelled" }));

    const entry = postedEntry(fetchMock);
    expect(entry.outcome).toBe("cancelled");
    expect(entry.ran).toEqual([]);
    expect(document.body.textContent).toContain("Cancelled");
  });

  it("CB-t-17: a writer that answers through a promise -- `written` fills ran, `refused` fills the outcome with the message", async () => {
    let fetchMock = stubFetch();
    let onOpenResult = renderBar({ runs: [] });
    onOpenResult.onOpen.mockResolvedValue({ kind: "written" });
    fireEvent.change(onOpenResult.input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(onOpenResult.input, { key: "Enter" });
    // Nothing is posted until the writer has answered.
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => {});
    let entry = postedEntry(fetchMock);
    expect(entry.outcome).toBe("written");
    expect(entry.ran).toHaveLength(1);

    cleanup();
    vi.unstubAllGlobals();
    fetchMock = stubFetch();
    onOpenResult = renderBar({ runs: [] });
    onOpenResult.onOpen.mockResolvedValue({
      kind: "refused",
      message: "That person does not belong to this part of the structure.",
    });
    fireEvent.change(onOpenResult.input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(onOpenResult.input, { key: "Enter" });
    await act(async () => {});
    entry = postedEntry(fetchMock);
    expect(entry.outcome).toBe(
      "refused: That person does not belong to this part of the structure.",
    );
    expect(entry.ran).toEqual([]);
  });

  // -------------------------------------------------------------------
  // S62-b reviewer fixes (C) and (D): the two ways the answer never arrived.
  // -------------------------------------------------------------------
  it("CB-t-21: a split-coverage hand-off is reported as what it is, and the pop-up that took it over still finishes the sentence", () => {
    const fetchMock = stubFetch();
    const { onOpen, input } = renderBar({ runs: [] });
    onOpen.mockReturnValue({ kind: "popup", waitingFor: "the create pop-up" });

    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    const [, , report] = onOpen.mock.calls[0] as [
      ResolvedCommand,
      { x: number; y: number },
      (r: { kind: string; what?: string; readout?: string }) => void,
    ];

    // The create pop-up hands the write to the split pop-up: still nothing
    // written, still not over, and the thread says what it is waiting on now.
    act(() => report({ kind: "handed_off", what: "split coverage" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Waiting: split coverage");

    // The split pop-up's own Confirm finishes it through the SAME reporter.
    act(() => report({ kind: "written", readout: "Operator 1 → Housing A · Cell 1" }));
    const entry = postedEntry(fetchMock);
    expect(entry.outcome).toBe("written");
    expect(entry.ran).toEqual(["Operator 1 → Housing A · Cell 1"]);
    expect(document.body.textContent).not.toContain("Waiting:");
  });

  it("CB-t-22: a cancel through the pop-up's own door is reported, even after a hand-off", () => {
    const fetchMock = stubFetch();
    const { onOpen, input } = renderBar({ runs: [] });
    onOpen.mockReturnValue({ kind: "popup", waitingFor: "the create pop-up" });

    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    const [, , report] = onOpen.mock.calls[0] as [
      ResolvedCommand,
      { x: number; y: number },
      (r: { kind: string; what?: string }) => void,
    ];

    act(() => report({ kind: "handed_off", what: "split coverage" }));
    act(() => report({ kind: "cancelled" }));

    const entry = postedEntry(fetchMock);
    expect(entry.outcome).toBe("cancelled");
    expect(entry.ran).toEqual([]);
    expect(document.body.textContent).toContain("Cancelled");
  });

  it("CB-t-23: a write that lands AFTER the next sentence has started corrects both the thread and the file", async () => {
    const fetchMock = stubFetch();
    let settleFirst: (o: { kind: "written" }) => void = () => {};
    const { onOpen, input } = renderBar({ runs: [] });
    onOpen.mockImplementationOnce(
      () => new Promise<{ kind: "written" }>((res) => (settleFirst = res)),
    );

    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(fetchMock).not.toHaveBeenCalled();

    // A second sentence, before the first writer answered: the first entry is
    // flushed as it stands -- ran empty, outcome null.
    fireEvent.change(input, { target: { value: "gibberish" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstLine = postedEntry(fetchMock, 0);
    expect(firstLine.heard).toBe(P1_SENTENCE);
    expect(firstLine.ran).toEqual([]);
    expect(firstLine.outcome).toBeNull();

    // Now the first sentence's write lands.
    await act(async () => {
      settleFirst({ kind: "written" });
    });

    // The file gets a CORRECTED line -- same `at`, `revises: true` -- since it
    // is append-only and the first line is already in it.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const corrected = postedEntry(fetchMock, 1);
    expect(corrected.at).toBe(firstLine.at);
    expect(corrected.revises).toBe(true);
    expect(corrected.outcome).toBe("written");
    expect(corrected.ran).toHaveLength(1);
    // And the thread's own turn says it too, rather than staying blank.
    expect(document.body.textContent).toContain("Written:");
  });

  it("CB-t-24: after a hand-off, 'no' still reaches the pop-up that took the write over -- the turn ends Cancelled, never 'Nothing to cancel.'", () => {
    // S62-b re-check fix (2): `BoardPage`'s `onCancelWord` only ever claimed
    // a CREATE pop-up, and a hand-off replaces that with the split-coverage
    // one -- so a cancel word found nothing to claim, said "Nothing to
    // cancel.", and left the split pop-up standing over a sentence that was
    // still waiting. `BoardPage` now claims a split pop-up a sentence opened
    // too (`popover.commandResult` is set only then) and cancels it through
    // `dragApi.cancelSplit`, which reports. This drives the bar against that
    // contract: `onCancelWord` claims the word and the pop-up reports.
    const fetchMock = stubFetch();
    let report: ((r: { kind: "cancelled" }) => void) | null = null;
    const onCancelWord = vi.fn(() => {
      // What `dragApi.cancelSplit()` does: closes the pop-up and reports.
      report?.({ kind: "cancelled" });
      return true;
    });
    const { onOpen, input } = renderBar({ runs: [] }, null, null, { onCancelWord });
    onOpen.mockReturnValue({ kind: "popup", waitingFor: "the create pop-up" });

    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    const [, , reporter] = onOpen.mock.calls[0] as [
      ResolvedCommand,
      { x: number; y: number },
      (r: { kind: string; what?: string }) => void,
    ];
    report = reporter as (r: { kind: "cancelled" }) => void;

    act(() => reporter({ kind: "handed_off", what: "split coverage" }));
    expect(document.body.textContent).toContain("Waiting: split coverage");
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "no" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onCancelWord).toHaveBeenCalledTimes(1);
    // Never the "nothing standing" answer -- the pop-up claimed the word.
    expect(statusText()).not.toBe("Nothing to cancel.");
    const entry = postedEntry(fetchMock);
    expect(entry.outcome).toBe("cancelled");
    expect(entry.ran).toEqual([]);
    expect(document.body.textContent).toContain("Cancelled");
    expect(document.body.textContent).not.toContain("Waiting:");
  });
});

// ---------------------------------------------------------------------------
// F-168 (R-421/R-427/R-434): the four writers that used to answer `void` --
// `settleWrite` read that as `written`, so a refused unassign or retime was
// recorded as Written while the block stayed on the board (CLAUDE.md §4's own
// warning). Each prop now answers `WriteResult`; these pins are each writer's
// own REFUSED half -- the WRITTEN half is already proven by C12 (onRetime),
// CB2 (onRetimeRun), CU2 (onUnassign) and CM1/CM2 (onMove, both branches),
// all of which read `Written: <readout>` from the default mock now that it
// answers for real (see `WRITTEN`'s own doc above `findRunOverlap`).
// ---------------------------------------------------------------------------
describe("CB-w: the four silent writers answer for real (F-168)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("CB-w-1: a refused onUnassign shows Refused with the server's own reason, ran stays empty", async () => {
    const fetchMock = stubFetch();
    const { onUnassign, input } = renderBar({ assignments: [BLK1] });
    onUnassign.mockResolvedValue({
      kind: "refused",
      message: "You don't have permission to change that.",
    });

    fireEvent.change(input, { target: { value: UNASSIGN_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    await act(async () => {});

    expect(onUnassign).toHaveBeenCalledTimes(1);
    expect(threadText()).toContain("Refused: You don't have permission to change that.");
    const entry = postedEntry(fetchMock);
    expect(entry.outcome).toBe("refused: You don't have permission to change that.");
    expect(entry.ran).toEqual([]);
  });

  it("CB-w-2: a refused onRetime shows Refused with the server's own reason, ran stays empty", async () => {
    const fetchMock = stubFetch();
    const { onRetime, input } = renderBar({ assignments: [BLK1] });
    onRetime.mockResolvedValue({
      kind: "refused",
      message: "That block is no longer on the board.",
    });

    fireEvent.change(input, { target: { value: P1_RETIME_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Change 10:00–14:00" }));
    await act(async () => {});

    expect(onRetime).toHaveBeenCalledTimes(1);
    expect(threadText()).toContain("Refused: That block is no longer on the board.");
    const entry = postedEntry(fetchMock);
    expect(entry.outcome).toBe("refused: That block is no longer on the board.");
    expect(entry.ran).toEqual([]);
  });

  it("CB-w-3: a refused onRetimeRun shows Refused with the server's own reason, ran stays empty", async () => {
    const fetchMock = stubFetch();
    const { onRetimeRun, input } = renderBar({ runs: [JOB1] });
    onRetimeRun.mockResolvedValue({
      kind: "refused",
      message: "That job is no longer on the board.",
    });

    fireEvent.change(input, { target: { value: BOOK_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Change 08:00–16:00" }));
    await act(async () => {});

    expect(onRetimeRun).toHaveBeenCalledTimes(1);
    expect(threadText()).toContain("Refused: That job is no longer on the board.");
    const entry = postedEntry(fetchMock);
    expect(entry.outcome).toBe("refused: That job is no longer on the board.");
    expect(entry.ran).toEqual([]);
  });

  it("CB-w-4: a refused onMove (the retime half -- a move-in-time-only sentence) shows Refused, ran stays empty", async () => {
    const fetchMock = stubFetch();
    const { onMove, input } = renderBar({ assignments: [BLK1] });
    onMove.mockResolvedValue({
      kind: "refused",
      message: "You cannot place anyone on this board.",
    });

    fireEvent.change(input, { target: { value: MOVE_RETIME_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    await act(async () => {});

    expect(onMove).toHaveBeenCalledTimes(1);
    const [resolved] = onMove.mock.calls[0] as [ResolvedMove, { x: number; y: number }];
    expect(resolved.target).toEqual({ kind: "retime" });
    expect(threadText()).toContain("Refused: You cannot place anyone on this board.");
    const entry = postedEntry(fetchMock);
    expect(entry.outcome).toBe("refused: You cannot place anyone on this board.");
    expect(entry.ran).toEqual([]);
  });

  it("CB-w-5 (WR-4, reviewer fix): a writer that answers `undefined` anyway (a regression this file does not yet know about) is filed as a loud refusal, never a silent Written", async () => {
    // `WriteResult` no longer allows `void` at compile time (F-168's own
    // fix), so this reaches through the type system the same way a real
    // regression would -- a caller that stops answering. `settleWrite`'s
    // own defensive branch (`outcome === undefined`) exists precisely for
    // this, and had no pin: CLAUDE.md 4's own warning ("a write that
    // reports success can have changed nothing") applies to the DEFENCE
    // too if nothing ever exercises it.
    const fetchMock = stubFetch();
    const { onUnassign, input } = renderBar({ assignments: [BLK1] });
    onUnassign.mockResolvedValue(undefined as unknown as WriteOutcome);

    fireEvent.change(input, { target: { value: UNASSIGN_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    await act(async () => {});

    expect(threadText()).toContain("Refused: no answer from the writer");
    const entry = postedEntry(fetchMock);
    expect(entry.outcome).toBe("refused: no answer from the writer");
    expect(entry.ran).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// F-169 (R-419/R-421): the pending rerun a "Show that day" press sets was
// cleared on a typed edit, a cancel word and Escape, but not in `submitText`
// -- and a SPOKEN final transcript never passes through the typed-edit
// handler at all, so it could not clear it either. A spoken sentence arriving
// while the rerun still waits for the window to move used to survive it, and
// once the window landed the effect ran the STALE command, overwriting the
// new sentence's own trace.
// ---------------------------------------------------------------------------
describe("CB-rr: a spoken sentence clears a stale rerun (F-169)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const YESTERDAY_SENTENCE =
    "assign Operator 1 to Housing A on Cell 1 in Line 1 from 10 to 2 yesterday";
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

  it("CB-rr-1: 'Show that day' pending, then a SPOKEN final sentence arrives before the window lands -- the old command never runs, and the new sentence keeps its own trace", () => {
    const fetchMock = stubFetch();
    const { recognizer, fire } = makeFakeRecognizer();
    const { input, onOpen, rerenderCtx } = renderBar({ todayIndex: 0 }, null, recognizer);
    // Registers the fake recognizer's callbacks -- `fire.final` below is a
    // no-op until the recognizer function itself has been invoked once
    // (`makeFakeRecognizer`'s own `captured`, set only by `startListening`).
    fireEvent.click(screen.getByRole("button", { name: "Speak a sentence" }));

    fireEvent.change(input, { target: { value: YESTERDAY_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Show that day" }));

    // A SPOKEN final sentence -- never through `handleChange`, the one path
    // that already cleared the pending rerun before this fix.
    fire.final(P1_SENTENCE);
    expect(onOpen).toHaveBeenCalledTimes(1);

    // The window lands NOW -- "yesterday"'s own target is on the board.
    // Pre-fix, the effect watching `ctx` would find `pendingRerunRef` still
    // set and run the STALE "yesterday" command here, a second `onOpen` call
    // that would overwrite the spoken sentence's own trace entry.
    rerenderCtx({ days: SHIFTED_BACK_ONE_DAY, todayIndex: 1 });

    expect(onOpen).toHaveBeenCalledTimes(1);

    // The spoken sentence's own entry is intact -- its own `read`/`ran`/
    // `outcome`, never overwritten by the stale "yesterday" command's.
    const entries = fetchMock.mock.calls.map((call: unknown[]) => {
      const [, init] = call as [string, RequestInit];
      return JSON.parse(init.body as string) as TraceEntry;
    });
    const spokenEntry = entries.find((e) => e.heard === P1_SENTENCE);
    expect(spokenEntry).toBeTruthy();
    expect(spokenEntry?.outcome).toBe("written");
    expect(spokenEntry?.ran).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// R-434 (the audit item 3, docs/agent-briefs/s64-c-writers-answer-brief.md):
// exactly the four paths that brief names, nothing more in this lane -- every
// other path list A/B of s64-b's own audit found is queued elsewhere.
// ---------------------------------------------------------------------------
describe("CB-tr: the entry closes on R-434's four named paths", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("CB-tr-1: a recogniser error (mic refused, no speech, or stopped) files a turn -- heard empty, outcome refused", () => {
    const fetchMock = stubFetch();
    const { recognizer, fire } = makeFakeRecognizer();
    renderBar({}, null, recognizer);
    fireEvent.click(screen.getByRole("button", { name: "Speak a sentence" }));

    fire.error("no-speech", undefined);

    // The live line still shows the message (the same order `cancelStanding`
    // already uses: file the turn, THEN set the live status -- CB-mic-7's
    // own pin, unchanged by this fix).
    expect(statusText()).toBe("Nothing was heard.");
    expect(threadText()).toContain("Refused: Nothing was heard.");
    const entry = postedEntry(fetchMock);
    expect(entry.heard).toBe("");
    expect(entry.outcome).toBe("refused: Nothing was heard.");
  });

  it("CB-tr-2: a sentence arriving while a lot writes is reported dropped, not silently swallowed -- 'Working…' still stands (DECISION: dropped, not queued -- see submitText's own comment)", async () => {
    const fetchMock = stubFetch();
    const { recognizer, fire } = makeFakeRecognizer();
    let settle: (r: LotResult) => void = () => {};
    const { input } = renderBar(
      { assignments: [BLK1, BLK_SP] },
      null,
      recognizer,
      {},
      { onRunLot: () => new Promise<LotResult>((res) => (settle = res)) },
    );
    // Registers the fake recognizer's callbacks (`captured` inside
    // `makeFakeRecognizer`) BEFORE the lot starts -- `fire.final` below is a
    // no-op otherwise. Speaking, not typing: `handleChange`'s own no-op
    // while a lot runs already blocks a TYPED keystroke from ever reaching
    // the input's `text` state (the controlled input "redraws the keystroke
    // away", this file's own comment above `handleChange`'s guard) -- a
    // final transcript is delivered as a plain argument to `onFinal`/
    // `submitText` instead, which is exactly how a real spoken sentence
    // reaches this no-op branch per the audit's own words ("Enter or a
    // spoken final during runningLot").
    fireEvent.click(screen.getByRole("button", { name: "Speak a sentence" }));

    fireEvent.change(input, { target: { value: LOT_REMOVE_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    fireEvent.click(screen.getByRole("button", { name: "Do all 2" }));
    expect(statusText()).toBe("Working…");

    fire.final("gibberish");

    // "Working…" is untouched -- the dropped sentence never fights the lot
    // for the live status line.
    expect(statusText()).toBe("Working…");
    expect(threadText()).toContain("Refused: a lot was still writing; the sentence was dropped");
    const entry = postedEntry(fetchMock);
    expect(entry.heard).toBe("gibberish");
    expect(entry.outcome).toBe("refused: a lot was still writing; the sentence was dropped");

    // Let the lot resolve so nothing leaks into a later test.
    await act(async () => settle({ done: 2, error: null }));
  });

  it("CB-tr-2b (WR-1, reviewer fix): a TYPED sentence left in the box from before the lot started is emptied too, once Enter files it as dropped", async () => {
    const fetchMock = stubFetch();
    let settle: (r: LotResult) => void = () => {};
    const { input } = renderBar(
      { assignments: [BLK1, BLK_SP] },
      null,
      null,
      {},
      { onRunLot: () => new Promise<LotResult>((res) => (settle = res)) },
    );
    fireEvent.change(input, { target: { value: LOT_REMOVE_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    // The lot's own final "say yes to do them all" question stands here --
    // `runningLotRef.current` is still false (the lot has not been told to
    // RUN yet, only assembled), so `handleChange` still accepts a keystroke:
    // a person can type a brand-new sentence into the box while deciding
    // whether to run the lot. It does not parse as a command (`answerTakes`
    // treats a lot question as yes/no, so a non-parsing edit "keeps the
    // answer" per `handleChange`'s own F-162 exception) -- ordinary text
    // left sitting in the box, exactly as it would be left by a person who
    // typed ahead before clicking "Do all N".
    fireEvent.change(input, { target: { value: "a sentence typed ahead of the click" } });
    expect((input as HTMLInputElement).value).toBe("a sentence typed ahead of the click");

    fireEvent.click(screen.getByRole("button", { name: "Do all 2" }));
    expect(statusText()).toBe("Working…");
    // `runLotNow` does not clear `text` when it STARTS (only its own
    // `.then()` does, on a clean sweep) -- pre-WR-1, the typed sentence
    // above sat here untouched through the whole run.
    expect((input as HTMLInputElement).value).toBe("a sentence typed ahead of the click");

    fireEvent.keyDown(input, { key: "Enter" });

    // R-437 ("Enter empties the box... whether written, refused, or
    // standing") is unconditional -- this sentence is now genuinely SENT
    // (F-169/R-434's own fix files it as a dropped turn, not a silent
    // no-op), so it belongs in the thread, never in the input, the same as
    // every other exit `submitText` has.
    expect((input as HTMLInputElement).value).toBe("");
    expect(threadText()).toContain("a sentence typed ahead of the click");
    expect(threadText()).toContain("Refused: a lot was still writing; the sentence was dropped");
    const entry = postedEntry(fetchMock);
    expect(entry.heard).toBe("a sentence typed ahead of the click");

    // Let the lot resolve so nothing leaks into a later test.
    await act(async () => settle({ done: 2, error: null }));
  });

  it("CB-tr-1b (WR-3, reviewer fix): a recogniser error with nothing heard draws no empty 'you' bubble", () => {
    const fetchMock = stubFetch();
    const { recognizer, fire } = makeFakeRecognizer();
    renderBar({}, null, recognizer);
    fireEvent.click(screen.getByRole("button", { name: "Speak a sentence" }));

    fire.error("no-speech", undefined);

    // `heard` is "" for this turn -- nobody said a word, so there is
    // nothing for the person's own bubble to hold. Pre-WR-3 this rendered
    // an empty rounded box on the "you" side; now that bubble is skipped
    // entirely and the board's own bubble (the result line) carries the
    // whole turn alone.
    const empty = Array.from(document.querySelectorAll('[data-side="you"]')).filter(
      (el) => (el.textContent ?? "") === "",
    );
    expect(empty).toHaveLength(0);
    expect(threadText()).toContain("Refused: Nothing was heard.");
    const entry = postedEntry(fetchMock);
    expect(entry.heard).toBe("");
  });

  it("CB-tr-3: 'nothing to do' sets the outcome so the thread's last line is never blank, and the sentence is drawn ONCE (WR-2, reviewer fix)", () => {
    const fetchMock = stubFetch();
    const { input } = renderXBar();
    fireEvent.change(input, { target: { value: "clear Cell 3 today" } });
    fireEvent.keyDown(input, { key: "Enter" });

    const dayLabel = formatDayLabel(new Date("2026-09-03T00:00:00Z"), "d_mon_yyyy", "UTC");
    const readout = `Cell 3 has nobody on it ${dayLabel}.`;
    // The FILED entry still carries a non-null outcome -- R-434's own
    // "never blank" requirement is about the RECORD, and it holds.
    const entry = postedEntry(fetchMock);
    expect(entry.outcome).toBe(`refused: ${readout}`);
    // WR-2 (reviewer, S64-c review): the rendered thread said this sentence
    // TWICE before this fix -- once plain (the board's own bubble, `asked`)
    // and once again mislabelled "Refused:" (the result line, since
    // `questionToStatus` sets `outcome` to the identical rendered text).
    // Nothing was ever refused here -- it is a plain readout -- so the
    // "Refused:" bubble is gone and the sentence is drawn once.
    expect(threadText()).toContain(readout);
    expect(threadText()).not.toContain(`Refused: ${readout}`);
  });

  it("CB-tr-4: cancelStanding sets outcome to 'cancelled' so the thread's last line is never blank (already correct pre-F-168; pinned so it stays that way)", () => {
    const fetchMock = stubFetch();
    const { input } = renderBar({ assignments: [BLK1] });
    fireEvent.change(input, { target: { value: UNASSIGN_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: "no" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(threadText()).toContain("Cancelled");
    const entry = postedEntry(fetchMock);
    expect(entry.outcome).toBe("cancelled");
  });
});

// ---------------------------------------------------------------------------
// R-427 (the maintainer, 17 Sept): "The sentence clearing is not going to help
// unless we have conversation history ... It will be a good sanity check to
// see what options were provided and what was chosen." The store's own half
// (persistence, the day, the cap) is `commandConversation.test.ts`; these are
// what the BAR renders.
// ---------------------------------------------------------------------------
describe("CH: the conversation thread (R-427)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // CH-1 (CONTRACT CHANGED, CLAUDE.md §4, R-428): this pinned the past
  // turn's own "You: "/"Board: " prefixed lines. R-428 turns each finished
  // turn into bubbles, one colour per side (`data-side`), and drops both
  // prefixes on purpose ("the side says who") -- the text itself (what was
  // heard, what was asked) is unchanged, so this drops only the two literal
  // prefixes from what it looks for. CP-1..CP-4 below (R-428's own new pins)
  // cover the bubble STRUCTURE directly; this one keeps proving the thread's
  // older facts (both candidates shown, the chosen one ticked, a written
  // result, "Clear history") still hold.
  it("CH-1: a finished turn appears in the thread with the buttons that were offered, and the one chosen marked", () => {
    stubFetch();
    const { input } = renderBar({ runs: [] });
    fireEvent.change(input, {
      target: { value: "assign Sam to Housing A on Cell 1 in Line 1 from 10 to 2" },
    });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(statusText()).toBe('Which person? "Sam" matches 2:');

    fireEvent.click(screen.getByRole("button", { name: "Sam Patel" }));

    const thread = document.body.textContent ?? "";
    expect(thread).toContain("assign Sam to Housing A on Cell 1 in Line 1 from 10 to 2");
    expect(thread).toContain('Which person? "Sam" matches 2:');
    // Both options are shown; the chosen one carries the tick.
    expect(thread).toContain("Sam Ortiz");
    expect(thread).toContain("Sam Patel ✓");
    expect(thread).toContain("Written:");
    expect(screen.getByRole("button", { name: "Clear history" })).toBeTruthy();
  });

  it("CH-2: a refused write shows Refused with the writer's own message", async () => {
    stubFetch();
    const { onOpen, input } = renderBar({ runs: [] });
    onOpen.mockResolvedValue({
      kind: "refused",
      message: "That person does not belong to this part of the structure.",
    });
    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    await act(async () => {});

    expect(document.body.textContent).toContain(
      "Refused: That person does not belong to this part of the structure.",
    );
  });

  // CB-ref-1 (R-434, S63-a brief §5): a capacity refusal reaches the bar as
  // the DRAG's own toast wording (`useSchedulerToast.ts`'s `CapacityExceeded`
  // case) -- accurate for a drag, which really can retry the split; the bar
  // has no split to retry, so it rewrites this one shape of message before
  // filing it, matching the numbers but not the drag's own advice.
  it("CB-ref-1: a capacity refusal is rewritten -- the drag's 'try the split again' becomes 'Nothing changed', same numbers", async () => {
    stubFetch();
    const { onOpen, input } = renderBar({ runs: [] });
    onOpen.mockResolvedValue({
      kind: "refused",
      message:
        "Sam Patel would reach 110% (cap 100%). Someone else changed their load — try the split again.",
    });
    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    await act(async () => {});

    expect(document.body.textContent).toContain(
      "Refused: Sam Patel would be over the cap today (110% of 100%). Nothing changed.",
    );
    expect(document.body.textContent).not.toContain("try the split again");
  });

  it("CH-6: nothing in a past turn runs a command -- the thread is a record, and only the CURRENT question has live buttons", () => {
    stubFetch();
    const { onOpen, input } = renderBar({ runs: [] });
    fireEvent.change(input, {
      target: { value: "assign Sam to Housing A on Cell 1 in Line 1 from 10 to 2" },
    });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Sam Patel" }));
    expect(onOpen).toHaveBeenCalledTimes(1);

    // The past turn's chips are not buttons at all.
    expect(candidateButtons()).toHaveLength(0);
    const chips = Array.from(document.querySelectorAll('[class*="chip"]'));
    expect(chips.length).toBeGreaterThan(0);
    for (const chip of chips) {
      expect(chip.tagName).toBe("SPAN");
      fireEvent.click(chip);
    }
    // Clicking every one of them changed nothing.
    expect(onOpen).toHaveBeenCalledTimes(1);
    // The only button the thread offers is its own "Clear history".
    expect(threadTurns().length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Clear history" }));
    expect(threadTurns()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// R-428 (the maintainer, S63-a): the bar as a chat panel -- a finished turn
// is bubbles now, one colour per side (`data-side`, so a pin reads the side
// without the CSS module's hash), not the "You: "/"Board: " prefixed lines
// CH-1 (above) used to read. The CURRENT turn reads the same way, off the
// live `sentence`/`status` instead of a filed `HistoryTurn`.
// ---------------------------------------------------------------------------
describe("CP: a finished turn is bubbles, not prefixed lines (R-428)", () => {
  function bubbles(container: HTMLElement): { side: string | null; text: string }[] {
    return Array.from(container.querySelectorAll("[data-side]")).map((el) => ({
      side: el.getAttribute("data-side"),
      text: el.textContent ?? "",
    }));
  }

  it("CP-1: a finished turn renders one right bubble (heard) and left bubbles for the question and the result", () => {
    stubFetch();
    const { input } = renderBar({ runs: [] });
    fireEvent.change(input, {
      target: { value: "assign Sam to Housing A on Cell 1 in Line 1 from 10 to 2" },
    });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Sam Patel" }));

    const [turn] = threadTurns();
    const bs = bubbles(turn);
    expect(bs[0]).toEqual({
      side: "you",
      text: "assign Sam to Housing A on Cell 1 in Line 1 from 10 to 2",
    });
    expect(bs[1].side).toBe("board");
    expect(bs[1].text).toContain('Which person? "Sam" matches 2:');
    expect(bs[2].side).toBe("board");
    expect(bs[2].text).toContain("Written:");
  });

  it("CP-2: the offered chips sit inside the board's own bubble, the chosen one marked", () => {
    stubFetch();
    const { input } = renderBar({ runs: [] });
    fireEvent.change(input, {
      target: { value: "assign Sam to Housing A on Cell 1 in Line 1 from 10 to 2" },
    });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Sam Patel" }));

    const [turn] = threadTurns();
    const askedBubble = turn.querySelector('[data-side="board"]') as HTMLElement;
    const chips = Array.from(askedBubble.querySelectorAll('[class*="chip"]'));
    expect(chips.length).toBe(2);
    expect(askedBubble.textContent).toContain("Sam Patel ✓");
  });

  it("CP-3: the current turn reads the same way -- the sentence a right bubble, the live question a left one", () => {
    const { input } = renderBar();
    fireEvent.change(input, {
      target: { value: "assign Sam to Housing A on Cell 1 in Line 1 from 10 to 2" },
    });
    fireEvent.keyDown(input, { key: "Enter" });

    const said = document.querySelector('[class*="saidLine"]')?.closest("[data-side]");
    expect(said?.getAttribute("data-side")).toBe("you");
    const status = document.querySelector('p[aria-live="polite"]')?.closest("[data-side]");
    expect(status?.getAttribute("data-side")).toBe("board");
  });

  it("CP-4: nothing in a past turn is a button (CH-6 stays)", () => {
    // CH-6 (above) already drives this end to end -- clicking every chip
    // changes nothing. This confirms the structural fact the bubbles rely
    // on: every element carrying a `data-side` in a past turn is a plain
    // `div`, never a `button`.
    stubFetch();
    const { input } = renderBar({ runs: [] });
    fireEvent.change(input, {
      target: { value: "assign Sam to Housing A on Cell 1 in Line 1 from 10 to 2" },
    });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Sam Patel" }));

    const [turn] = threadTurns();
    for (const el of Array.from(turn.querySelectorAll("[data-side]"))) {
      expect(el.tagName).toBe("DIV");
    }
  });

  // CP-5 (S63-a review fix, the maintainer looking at the panel: "assign Sam
  // Patel to Cell 1 from 8 to 12" appeared as a written turn in the thread
  // AND again as the live "You said" + readout underneath it). Fixed at
  // `commandConversation.ts`'s own `fileTurn`, which clears the live
  // `sentence`/`status` back to `null` the moment a turn is actually filed
  // -- this pins the visible result for the commonest case, a plain
  // synchronous written single.
  it("CP-5: after a written single the readout is in the thread once and the live area is empty (apart from the input)", () => {
    const { input } = renderBar({ runs: [] });
    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(threadTurns()).toHaveLength(1);
    expect(threadText()).toContain("Written:");
    // The live area: no live bubble left standing, and the input is all
    // that remains outside the thread.
    expect(statusText()).toBe("");
    expect(document.body.textContent).not.toContain("You said:");
  });

  // CP-6 (S63-a review fix, the maintainer looking at the panel: input at
  // the top, a tall remembered size, nothing in the thread -- "feels out of
  // place and unprofessional"). The hint is not a turn: nothing in the
  // store, nothing traced, gone the instant a sentence is submitted or a
  // history turn exists.
  it("CP-6: an empty thread shows the example bubble; after a sentence it is gone", () => {
    const { input } = renderBar();
    expect(document.body.textContent).toContain(
      "Tell the board what to do. For example: clear Cell 1 today, or assign Sam Patel to Cell 1 from 8 to 12.",
    );

    fireEvent.change(input, { target: { value: "gibberish" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(document.body.textContent).not.toContain("Tell the board what to do.");
  });

  // CR-4 (reviewer fix, S63 review): the announcement was lost -- `status`
  // and `fileTurn`'s own clear of it happen in the same tick for a
  // synchronous write, so React batches both and the status line's own
  // `aria-live` element never actually held the finished words at a point a
  // screen reader could catch. The thread body is the announced surface
  // instead (`role="log"`, `aria-live="polite"`, `aria-relevant="additions"`)
  // -- every turn APPENDED to it is announced, which both a written single
  // and a refusal are.
  it("CR-4: after a written single the thread body is the announced log with the readout inside it, and the status line is empty; a refusal reads the same way", async () => {
    const { input } = renderBar({ runs: [] });
    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    const log = document.querySelector('[class*="threadBody"]');
    expect(log?.getAttribute("role")).toBe("log");
    expect(log?.getAttribute("aria-live")).toBe("polite");
    expect(log?.getAttribute("aria-relevant")).toBe("additions");
    expect(log?.textContent).toContain("Written:");
    expect(statusText()).toBe("");

    cleanup();
    const { onOpen, input: input2 } = renderBar({ runs: [] });
    onOpen.mockResolvedValue({ kind: "refused", message: "Nope." });
    fireEvent.change(input2, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input2, { key: "Enter" });
    await act(async () => {});

    const log2 = document.querySelector('[class*="threadBody"]');
    expect(log2?.getAttribute("role")).toBe("log");
    expect(log2?.textContent).toContain("Refused: Nope.");
    expect(statusText()).toBe("");
  });
});

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

  // S63-a review fix (CP-5, CLAUDE.md §4): `onOpen` is held pending -- the
  // "· override: …" suffix (`runCommand`'s own `suffix` argument) lives only
  // on the live, optimistic status line, never in `entry.ran`/the thread; a
  // synchronous write would file (and clear) it in the same tick.
  it("CB-nc-2: a reason runs with the override on the resolved command -- onOpen receives it, the readout is suffixed", () => {
    const { onOpen, input } = renderBar(notCertifiedCtx("warn"));
    onOpen.mockReturnValue(new Promise(() => {}));
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

    // S62-b re-check fix (1): every cancel says so (was `toBe("")`).
    expect(statusText()).toBe("Left it.");
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

  // S63-a review fix (CP-5, CLAUDE.md §4): `onOpen` is held pending -- see
  // CB-nc-2's own identical note.
  it("CB-nc-7: a person failing BOTH gates is asked twice, and the readout names BOTH overrides", () => {
    // Uncertified for the cell AND not from its area -- the two gates run
    // one after the other (certificate first), so the sentence is answered
    // twice before anything is written.
    const { onOpen, input } = renderBar({
      runs: [],
      certificateGaps: () => [{ skill: "Welding", state: "never-trained" as const }],
      eligibilityPolicy: () => "warn" as const,
      outsideArea: () => true,
    });
    onOpen.mockReturnValue(new Promise(() => {}));

    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(statusText()).toBe(
      "Operator 1 is not certified for Cell 1: missing Welding. Say the reason to schedule anyway, or no.",
    );

    fireEvent.change(input, { target: { value: "covering for Sam" } });
    fireEvent.keyDown(input, { key: "Enter" });
    // The certificate answer is kept, so the second question is a NEW one --
    // never the first asked again.
    expect(statusText()).toBe(
      "Operator 1 is not from Cell 1's area. Say the reason to schedule anyway, or no.",
    );
    expect(onOpen).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "short-handed on Line 1" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onOpen).toHaveBeenCalledTimes(1);
    const [resolved] = onOpen.mock.calls[0] as [ResolvedCommand, { x: number; y: number }];
    expect(resolved.override).toEqual({ reason: "covering for Sam" });
    expect(resolved.areaOverride).toEqual({ reason: "short-handed on Line 1" });
    // S62-b reviewer fix (E): the readout named only the LAST reason given,
    // so a block written with two overrides read as if it carried one.
    expect(statusText()).toContain("· override: covering for Sam");
    expect(statusText()).toContain("· area override: short-handed on Line 1");
  });
});
