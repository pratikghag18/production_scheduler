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
import * as fs from "node:fs";
import * as path from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { formatDayLabel } from "@/features/board/lib/time";
// CH-scroll (F-192): the thread's own store, built directly so many turns
// can be seeded before the first render rather than driven one sentence at a
// time through the UI (`createConversationStore`/`appendTurn` are the same
// door `CommandBar`'s own `conversation` prop and `CommandLauncher` use).
import { createConversationStore } from "@/features/board/store/commandConversation";
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
  ResolvedRunRemoval,
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
// R-456 / F-222 (24 Sept, session 191): same reason as `resolveLib` above --
// `CB-verb`'s own describe block spies on `guessVerbs` for the duration of
// ONE call at a time (`vi.spyOn`, restored in a `finally`), so two controlled
// guesses can be pinned without depending on `verbGuess.ts`'s own exact
// heuristics; every other test in this file still drives the real,
// unmocked `guessVerbs` (already exercised indirectly by CB-ground-2/5/6).
import * as verbGuessLib from "@/lib/voice/verbGuess";
import type { VerbGuess } from "@/lib/voice/verbGuess";
import {
  CommandBar,
  renderIsoDays,
  type ConfirmWordResult,
  type ResolvedAny,
  type LotResult,
  type WriteOutcome,
  type CommandBarProps,
} from "@/features/board/components/CommandBar";
import type { Reader, Reading } from "@/lib/voice/readSentence";
import type { ClipInfo, Recognizer, RecognizerEvents } from "@/lib/voice/recognizer";
import type { TraceEntry } from "@/lib/voice/trace";
import { CREATE_WAITING, attachmentWaiting, splitWaiting } from "@/features/board/lib/popupWords";

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
/** F-191: the ISO of `todayIndex` among `days`, or a Monday far in the
 *  past when today is off the board (the resolver then asks about the week
 *  word, never about "today"). */
function todayIsoOf(
  days: ReadonlyArray<{ index: number; iso: string }>,
  todayIndex: number | null,
): string {
  return days.find((d) => d.index === todayIndex)?.iso ?? "2000-01-03";
}

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
      // DEF-0052: a FOURTH real, active, resolvable operator for the
      // longer-lot fixtures below (`BLK_PS`) -- "Lin On" fails to parse in a
      // several ("On" collides with the place grammar, see `BLK_SO`'s own
      // doc) and "Sam Gone" is inactive (excluded from resolution), so
      // neither of the two names already here could stand in.
      { id: "ps", displayName: "Priya Shah", employeeRef: null, active: true },
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
    // F-191: the plant's calendar today, derived from the days and
    // `todayIndex` a case passes so the two never disagree; a case with
    // today off the board gets a Monday far in the past unless it says
    // otherwise.
    todayIso: todayIsoOf(finalDays, over.todayIndex === undefined ? 3 : over.todayIndex),
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
    // R-455 / F-219 (24 Sept, session 191): every ctx this file builds is
    // fully settled the instant it exists -- `CB-showday-7..`'s own describe
    // block below is the one place that overrides this, to pin the race
    // `settled: false` exists to gate.
    settled: true,
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
  "I did not understand that. Say who, where and when, like: assign Sam Patel to Cell 1 today from 8 am to 4 pm.";
// R-459: `expectedShape()`'s own raw text -- what `failureToStatus` appends
// after naming the offending word ("I could not read "X". ..."), never
// carrying the "I did not understand that." lead-in `SHAPE` (above) has,
// which only the no-word-at-all fallback prints.
const RAW_SHAPE =
  "Say who, where and when, like: assign Sam Patel to Cell 1 today from 8 am to 4 pm.";
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

/** DEF-0052: BLK1's same cell and hours, Sam Ortiz's / Priya Shah's own
 *  blocks -- the four-and-more-person lot fixtures below need a THIRD and
 *  FOURTH real, resolvable operator beside Operator 1 and Sam Patel, so a
 *  lot longer than two can be built from real people. Not "Lin On": the
 *  grammar reads the trailing "On" of her own name as the start of an "on
 *  <place>" clause and fails the whole sentence (`bad_time`, found probing
 *  this fixture) -- a real, separate parsing gap outside this lane's files,
 *  named here rather than worked around silently. Not "Sam Gone" either:
 *  she is `active: false` in the fixture roster, so the board answers "No
 *  person called ... on this board" for her, the same as a stranger's name
 *  -- correct (an inactive person is off the board), but not what this
 *  fixture needs. Priya Shah (`buildCtx`'s own `operators` list, added for
 *  this lane) is a fourth active, resolvable name. */
const BLK_SO: ContextAssignment = { ...BLK1, id: "blkSo", operatorId: "so" };
const BLK_PS: ContextAssignment = { ...BLK1, id: "blkPs", operatorId: "ps" };

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
  // S71-d (R-451): the launcher's own Ctrl+M counter. Defaults to `0` --
  // every pre-S71-d call site (up to six positional arguments) renders
  // exactly as before; `CB-mic-11` below is the only caller that passes it,
  // and then only reads it back through `rerenderMicRequest`, never this
  // initial value directly (a mount with a non-zero count is CL-a/CL-b's
  // own scenario, already pinned end to end in `commandLauncher.test.tsx`).
  s71: { micRequest?: number } = {},
  // F-233 (S194-G): whether a placeholder row's own create is still in
  // flight. Defaults to `false` -- every pre-F-233 call site (up to seven
  // positional arguments) renders exactly as before; the F-233 describe
  // block below is the only caller that passes `true`.
  s233: { hasPendingCreate?: boolean } = {},
  // S196-A (DEF-0060, R-465): the capacity pre-check. Undefined -- every
  // earlier call site (up to eight positional arguments) -- is the bar with no
  // probe wired, byte for byte what it was; the CB-pre describe block below is
  // the only caller that passes one.
  s196: {
    precheck?: (step: ResolvedCommand | ResolvedMove) => Promise<string | null>;
  } = {},
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
  const element = (
    ctxOver: Partial<ResolveContext> | null,
    micRequest: number = s71.micRequest ?? 0,
    hasPendingCreate: boolean = s233.hasPendingCreate ?? false,
  ) => (
    <CommandBar
      ctx={ctxOver === null ? null : buildCtx(ctxOver)}
      hasPendingCreate={hasPendingCreate}
      dateFormat="d_mon_yyyy"
      zone="UTC"
      reader={reader}
      recognizer={recognizer}
      recognizerName={s59trace.recognizerName}
      micRequest={micRequest}
      onOpen={onOpen}
      onRetime={onRetime}
      onBook={onBook}
      onRetimeRun={onRetimeRun}
      onUnassign={onUnassign}
      onMove={onMove}
      onSetHeadcount={onSetHeadcount}
      onRunLot={onRunLot}
      precheck={s196.precheck}
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
    // S71-d (R-451): re-renders the SAME `CommandBar` against `over`
    // unchanged, with a NEW `micRequest` -- the shortcut's own counter prop
    // going up exactly as the launcher's `setMicRequest(n => n + 1)` would
    // (CB-mic-11, below).
    rerenderMicRequest: (next: number) => rerender(element(over, next)),
    // F-233 (S194-G): re-renders against `nextOver` (a fresh `ctx`, the same
    // shape a placeholder row's own refetch landing would produce) AND a
    // new `hasPendingCreate` in the SAME render, exactly as `BoardPage`
    // hands both down from the one `index` change -- CB-pending's own
    // describe block below is the only caller.
    rerenderPendingCreate: (nextOver: Partial<ResolveContext> | null, next: boolean) =>
      rerender(element(nextOver, s71.micRequest ?? 0, next)),
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
      // S71-f (brief §1.E): fires `onClip`, same as the real recogniser
      // does strictly before `onFinal`/`onError` for the same clip.
      clip(info: ClipInfo): void {
        act(() => captured?.onClip?.(info));
      },
      // S71-j (R-454, brief docs/agent-briefs/s71-j-progress-words-out-of-
      // the-input-brief.md §2): fires `onStatus`, the recogniser's own
      // progress -- `localRecognizer.ts` sends "listening" on start and
      // "transcribing" once a clip is posted, never through `onInterim`.
      status(phase: "listening" | "transcribing"): void {
        act(() => captured?.onStatus?.(phase));
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
 * walk): a LOT's last word -- "Done, N things." or (DEF-0052 / R-432, 28
 * Sept, replacing the old count-only "Did k of N things; the next failed:
 * …") `buildLotOutcome`'s SEPARATE-LINES failure sentence -- is filed into
 * the thread the moment the lot finishes, the
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

/**
 * The trace entry `stubFetch`'s mock posted on call `call` -- asserts the
 * URL and method along the way.
 *
 * DEF-0049 (CONTRACT CHANGED, 28 Sept, CLAUDE.md §4: not wrong when
 * written): an entry now posts at the ASK too, not only at the finish
 * (`postTrace`'s own doc, commandConversation.ts), so a sentence that asks a
 * question before it writes posts TWICE for the SAME entry -- an ask-time
 * line, then a `revises: true` correction. `call` with no argument used to
 * mean "the one and only post"; it now means "the LAST post" (`-1`,
 * `Array.prototype.at`'s own convention) -- the up-to-date state, exactly
 * what every real reader already does (`TraceEntry.revises`' own doc: "take
 * the LAST line for each `at`"). A caller that wants a SPECIFIC line (the
 * ask-time one, to prove it went out at all, or the FIRST of two DIFFERENT
 * entries) still passes an explicit index, unchanged.
 */
function postedEntry(fetchMock: ReturnType<typeof vi.fn>, call?: number): TraceEntry {
  const index = call ?? fetchMock.mock.calls.length - 1;
  const [url, init] = fetchMock.mock.calls[index] as [string, RequestInit];
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
  // S194-D third pass (CONTRACT CHANGED, every `Written:`/`ran` pin below): a
  // single write's thread line and trace `ran` are the readout AS SPOKEN now,
  // the lot path's rule since DEF-0043 -- they used to carry the raw ISO day.
  // The bar's OWN renderer, not a mirror -- the mirror this
  // used to be copied the bar's single-replace bug (only the first ISO day
  // rendered), so no case here could ever have caught a second raw date.
  return renderIsoDays(rawReadout, "UTC", "d_mon_yyyy");
}

/**
 * S196-A (F-239, R-431): a write the test settles itself. While it is pending
 * the live line says "Working…" -- never the done-form readout -- and only the
 * answer (`written`) puts the readout in the thread.
 */
function pendingWrite(): {
  promise: Promise<WriteOutcome>;
  settle: (outcome?: WriteOutcome) => Promise<void>;
} {
  let resolve: (o: WriteOutcome) => void = () => {};
  const promise = new Promise<WriteOutcome>((r) => (resolve = r));
  return {
    promise,
    settle: async (outcome: WriteOutcome = WRITTEN) => {
      await act(async () => {
        resolve(outcome);
      });
    },
  };
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
  // S196-A (F-239, R-431): CONTRACT CHANGED. While the writer is pending the
  // live line used to carry the done-form readout (this case pinned it); it
  // says "Working…" now, and the readout -- with its day rendered -- is what
  // the thread holds once the writer answers `written`. The day rendering is
  // still what this case proves; it is read from the place the readout lives.
  it("C2: a resolvable sentence opens the popover and shows the readout with the day rendered", async () => {
    const { onOpen, input } = renderBar({ runs: [] });
    const write = pendingWrite();
    onOpen.mockReturnValue(write.promise);

    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onOpen).toHaveBeenCalledTimes(1);
    const [resolved] = onOpen.mock.calls[0] as [ResolvedCommand, { x: number; y: number }];
    expect(resolved.nodeId).toBe("c1a");
    expect(resolved.operatorId).toBe("op1");
    expect(resolved.target).toEqual({ kind: "direct", productId: "ha" });
    expect(resolved.range).toEqual({ startMin: 3 * 1440 + 600, endMin: 3 * 1440 + 840 });

    const dayLabel = formatDayLabel(new Date("2026-09-03T00:00:00Z"), "d_mon_yyyy", "UTC");
    expect(statusText()).toBe("Working…");
    await write.settle();
    const thread = threadText();
    expect(thread).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(thread).toContain(dayLabel);
    expect(thread).toContain(
      `Operator 1 is on Cell 1 in Line 1 ${dayLabel} from 10 am to 2 pm, making Housing A.`,
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

    expect(statusText()).toBe(`I could not read "10:75". ${RAW_SHAPE}`);
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
      "A Housing A job is already booked on Cell 1, 8 am to 4 pm. Join it, or make a separate block?",
    );
    expect(
      screen.getByRole("button", { name: "Join the Housing A job, 8 am to 4 pm" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Separate block" })).toBeTruthy();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("C10: joining the run sends the run target, the answer box is empty; Separate block sends direct", () => {
    const { onOpen, input } = renderBar({ runs: [RUN1] });
    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Join the Housing A job, 8 am to 4 pm" }));

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
    expect(resolved.readout.endsWith("Joining the Housing A 8 am to 4 pm job already there.")).toBe(
      true,
    );

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
      "Operator 1 is already on Housing A at Cell 1 10 am to 2 pm. Change it to 10 am to 3 pm, or add a separate block?",
    );
    expect(
      screen.getByRole("button", { name: "Change Housing A on Cell 1, 10 am to 2 pm" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Separate block" })).toBeTruthy();
    expect(onOpen).not.toHaveBeenCalled();
    expect(onRetime).not.toHaveBeenCalled();
  });

  it("C12: pressing Change re-times the block through onRetime, the answer box is empty, readout says changing", () => {
    const { onOpen, onRetime, input } = renderBar({ assignments: [BLK1] });
    fireEvent.change(input, { target: { value: P1_RETIME_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(
      screen.getByRole("button", { name: "Change Housing A on Cell 1, 10 am to 2 pm" }),
    );

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
    expect(resolved.readout).toContain("Changing the block that ran 10 am to 2 pm.");
    expect(threadText()).toContain(`Written: ${renderedReadout(resolved.readout)}`);
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
      "A Housing A job is already booked on Cell 1, 8 am to 4 pm. Join it, or make a separate block?",
    );
    fireEvent.click(screen.getByRole("button", { name: "Join the Housing A job, 8 am to 4 pm" }));
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
      "Operator 1 is already on Housing A at Cell 1 10 am to 2 pm — nothing to change. Add a separate block?" +
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
    expect(threadText()).toContain(`Written: ${renderedReadout(resolved.readout)}`);
  });

  it("CB2: a job of the same part in the way asks to change it; Change calls onRetimeRun", () => {
    const { onBook, onRetimeRun, input } = renderBar({ runs: [JOB1] });

    fireEvent.change(input, { target: { value: BOOK_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toBe(
      "A Housing A job is already booked on Cell 1 8 am to 4 pm. Change it to 6 am to 2 pm, or pick other hours?",
    );
    expect(
      screen.getByRole("button", { name: "Change the Housing A job, 8 am to 4 pm" }),
    ).toBeTruthy();
    expect(onBook).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Change the Housing A job, 8 am to 4 pm" }));

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
      "Cell 1 already runs Cover 8 am to 4 pm; a cell runs one job at a time. Pick other hours, or change that job on the board.",
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
    expect(
      screen.getByRole("button", { name: "Change the Housing A job, 8 am to 4 pm" }),
    ).toBeTruthy();

    runsRef.length = 0;

    fireEvent.click(screen.getByRole("button", { name: "Change the Housing A job, 8 am to 4 pm" }));
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
      "Remove Operator 1's Housing A block on Cell 1, 10 am to 2 pm?" +
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
    expect(threadText()).toContain(`Written: ${renderedReadout(resolved.readout)}`);
  });

  it("CU3: a no-hours sentence with two blocks shows two buttons labelled with part and hours", () => {
    const { onUnassign, input } = renderBar({ assignments: [BLK1, BLK2] });
    fireEvent.change(input, { target: { value: UNASSIGN_WHOLE_DAY_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.getByRole("button", { name: "Remove Housing A 10 am to 2 pm" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove Housing A 2 pm to 4 pm" })).toBeTruthy();
    expect(onUnassign).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Remove Housing A 2 pm to 4 pm" }));
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
    expect(threadText()).toContain(`Written: ${renderedReadout(resolved.readout)}`);
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

    expect(screen.getByRole("button", { name: "Move Housing A 10 am to 2 pm" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Move Housing A 2 pm to 4 pm" })).toBeTruthy();
    expect(onMove).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Move Housing A 2 pm to 4 pm" }));
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
      "Remove Operator 1's Housing A block on Cell 1, 10 am to 2 pm? — say or type yes to do it, no to leave it.",
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
      "Which one? Remove Housing A 10 am to 2 pm, Remove Housing A 2 pm to 4 pm",
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

    fireEvent.click(screen.getByRole("button", { name: "Move Housing A 2 pm to 4 pm" }));

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
    expect(screen.getByRole("button", { name: "Move Housing A 10 am to 2 pm" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Move Housing A 2 pm to 4 pm" })).toBeTruthy();

    fireEvent.change(input, { target: { value: MOVE_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: "move it" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toBe(
      "Which one? Move Housing A 10 am to 2 pm, Move Housing A 2 pm to 4 pm",
    );
    fireEvent.click(screen.getByRole("button", { name: "Move Housing A 10 am to 2 pm" }));

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
    expect(
      screen.getByRole("button", { name: "Change Housing A on Cell 1, 10 am to 2 pm" }),
    ).toBeTruthy();
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
    expect(statusText()).toBe("Answer the window that is open first.");
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
      "A Housing A job is already booked on Cell 1, 8 am to 4 pm. Join it, or make a separate block?",
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
    expect(
      screen.getByRole("button", { name: "Join the Housing A job, 8 am to 4 pm" }),
    ).toBeTruthy();
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
    expect(statusText()).toMatch(/^Ready to do 2 things: /);
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
      "Operator 1 has no block on Cell 1 10 am to 2 pm, but has one on Cell 2: Housing A 10 am to 2 pm. Remove that one?" +
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
    expect(statusText()).toContain("Move that one to 10 am to 3 pm?");
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
      "Remove Operator 1's Housing A block on Cell 1, 10 am to 2 pm? — say or type yes to do it, no to leave it.",
    );
  });
});

// -----------------------------------------------------------------------
// S51 (R-400, design §19.98/D127): a several runs one question at a time,
// docs/agent-briefs/s51-a-lot-brief.md §2 items 5 (CB-lot-1..9).
// -----------------------------------------------------------------------

describe("CB-lot: a several runs one question at a time and writes on one yes (S51)", () => {
  // Reviewer fix (R-455 / F-219, 24 Sept session 191): `day_off_board`
  // changed from a "question" to a "readout" (`moving: true`) -- a lot step
  // landing off the board used to reach `resolveLotStep`'s own dead-code
  // branch (this file's OWN pre-fix comment said as much) with NO trace
  // update at all: no `asked`, no numbering, nothing for a cancel word (or
  // teardown) to post. `pendingRerunRef` still gets armed (that happens
  // inside `questionToStatus` itself, unconditionally) -- only the trace/
  // thread side of it was silent.
  it("CB-lot-4: a lot step landing off the board is numbered and recorded -- 'N of M: Moved the board to …', asked/answered set", () => {
    const fetchMock = stubFetch();
    const { input } = renderBar({ assignments: [BLK1, BLK_SP], todayIndex: 0 });
    fireEvent.change(input, {
      target: { value: `${LOT_REMOVE_SENTENCE} yesterday` },
    });
    fireEvent.keyDown(input, { key: "Enter" });
    // Numbered exactly as an ordinary lot question would be -- both live and
    // filed into the thread's own current-turn bubble (S63-a: the thread
    // shows the open turn too, not only finished ones).
    expect(statusText()).toBe("1 of 2: Moved the board to yesterday.");
    expect(threadText()).toContain("1 of 2: Moved the board to yesterday.");

    // A cancel word ends the lot -- the SAME entry (never filed or closed
    // early by the move itself) posts once, carrying the move's own
    // `asked`/`answered`, proving they were recorded rather than silently
    // dropped.
    fireEvent.change(input, { target: { value: "no" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // Reviewer fix, second half: the cancel word must actually END the lot
    // (not just leave `lotRef.current` stuck while claiming "Nothing to
    // cancel.") -- proven here by a SINGLE posted entry carrying the move's
    // own `asked`/`answered` AND the cancel's own `outcome`, never a second,
    // unrelated "no" entry.
    expect(statusText()).toBe("Left it.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const entry = postedEntry(fetchMock);
    expect(entry.heard).toBe(`${LOT_REMOVE_SENTENCE} yesterday`);
    expect(entry.asked).toBe("1 of 2: Moved the board to yesterday.");
    expect(entry.answered).toBe("no");
    expect(entry.outcome).toBe("cancelled");
  });

  it("CB-lot-1: a several of two removals from one cell, both people with one block, walks both questions to the lot status", () => {
    const { input, onHighlight } = renderBar({ assignments: [BLK1, BLK_SP] });

    fireEvent.change(input, { target: { value: LOT_REMOVE_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toBe(
      "1 of 2: Remove Operator 1's Housing A block on Cell 1, 10 am to 2 pm?" +
        " — say or type yes to do it, no to leave it.",
    );
    expect(onHighlight).toHaveBeenLastCalledWith({ kind: "remove", assignmentIds: ["blk1"] });

    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));

    expect(statusText()).toBe(
      "2 of 2: Remove Sam Patel's Housing A block on Cell 1, 10 am to 2 pm?" +
        " — say or type yes to do it, no to leave it.",
    );
    expect(onHighlight).toHaveBeenLastCalledWith({ kind: "remove", assignmentIds: ["blkSp"] });

    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));

    const dayLabel = formatDayLabel(new Date("2026-09-03T00:00:00Z"), "d_mon_yyyy", "UTC");
    expect(statusText()).toBe(
      "Ready to do 2 things: " +
        `1. Operator 1 is off Cell 1 in Line 1 ${dayLabel}; that was 10 am to 2 pm, making Housing A. ` +
        `2. Sam Patel is off Cell 1 in Line 1 ${dayLabel}; that was 10 am to 2 pm, making Housing A.` +
        " Say yes to do them, or no.",
    );
    expect(onHighlight).toHaveBeenLastCalledWith([
      { kind: "remove", assignmentIds: ["blk1"] },
      { kind: "remove", assignmentIds: ["blkSp"] },
    ]);
    expect(screen.getByRole("button", { name: "Do all 2" })).toBeTruthy();
  });

  it("CB-lot-2: yes + Enter calls onRunLot with two ResolvedUnassign in order and shows 'Done, 2 things.' with the input cleared", async () => {
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

    await waitFor(() => expect(threadText()).toContain("Done, 2 things."));

    expect(onRunLot).toHaveBeenCalledTimes(1);
    const [resolvedList] = onRunLot.mock.calls[0] as [ResolvedAny[]];
    expect(resolvedList).toHaveLength(2);
    expect(resolvedList.map((r) => r.intent)).toEqual(["unassign", "unassign"]);
    expect((resolvedList[0] as ResolvedUnassign).assignmentId).toBe("blk1");
    expect((resolvedList[1] as ResolvedUnassign).assignmentId).toBe("blkSp");
    expect(input.value).toBe("");
    expect(onHighlight).toHaveBeenLastCalledWith(null);
  });

  // S195-A (DEF-0043, tester 30 Sept): the list's joins. Every readout already
  // ends in its own full stop, so the readouts join with a SPACE -- never
  // ".; " -- in the listing, in the "Written:" line, and after "And N more."
  // the next sentence is its own. A lot of one is not numbered and says "1
  // thing", "do it".
  it("CB-lot-join: the listing and the 'Written:' line join whole sentences with a space -- no '.;' anywhere -- and 'Done, 2 things.' is followed by them", async () => {
    const onRunLot = vi.fn(async (resolved: ResolvedAny[]): Promise<LotResult> => ({
      done: resolved.length,
      error: null,
    }));
    const { input } = renderBar({ assignments: [BLK1, BLK_SP] }, null, null, {}, { onRunLot });
    fireEvent.change(input, { target: { value: LOT_REMOVE_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    expect(statusText()).not.toContain(".;");
    expect(statusText()).toMatch(/making Housing A\. 2\. Sam Patel is off /);
    fireEvent.change(input, { target: { value: "yes" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(threadText()).toContain("Done, 2 things."));
    expect(threadText()).not.toContain(".;");
  });

  // DEF-0052 / R-432 (CONTRACT CHANGED, 28 Sept, CLAUDE.md §4: not wrong
  // when written): the maintainer restated R-432 to SEPARATE LINES -- "I
  // made k of N changes." / "Done: ..." / "Not done: ..." / "Not tried:
  // ..." -- replacing the count-only "Did k of N things; the next failed:
  // ... What was already done stayed: ..." this pin used to read.
  it("CB-lot-3: onRunLot resolving {done:1, error:'boom.'} shows the SEPARATE-LINES partial-failure message, input kept, highlight cleared", async () => {
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

    // S194-D (R-432 as the maintainer chose it, CONTRACT CHANGED from lane E's
    // interim, which named the refused change by its READOUT -- a sentence
    // saying it happened -- and printed the raw refusal): the refused change
    // is its `attempted` ("who and where"), the reason in the plant's words
    // through the one rewriter, every change after it said as what stays.
    // "boom." has no shape `rewriteRefusal` rewrites, so it prints unchanged.
    await waitFor(() =>
      expect(threadText()).toContain(
        "I made 1 of the 2 changes.\n" +
          `Done: ${renderedReadout(resolvedList[0].readout)}\n` +
          "Not done: Sam Patel's block on Cell 1 in Line 1 Thu Sep 3, 10 am to 2 pm. boom.",
      ),
    );

    expect(input.value).toBe("yes");
    expect(onHighlight).toHaveBeenLastCalledWith(null);
  });

  // CR-1 (reviewer fix, S63 review): `rewriteCapRefusal` -- now `rewriteRefusal`, S194-D -- (brief §5, CB-ref-1)
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
    const [resolvedList] = onRunLot.mock.calls[0] as [ResolvedAny[]];

    // CP-7 (CONTRACT CHANGED, CLAUDE.md §4, session 178): a lot's last word
    // is filed into the thread the moment the lot finishes, the same as a
    // single's readout (CP-5), so it is read from the thread, not the live
    // line, which is empty once the turn is filed.
    // DEF-0052 / R-432 (CONTRACT CHANGED, 28 Sept): SEPARATE LINES -- the
    // rewritten capacity sentence is still the "Not done" reason, still
    // through the one rewriter (`rewriteRefusal`), still never "try the split again".
    await waitFor(() =>
      expect(threadText()).toContain(
        "I made 1 of the 2 changes.\n" +
          `Done: ${renderedReadout(resolvedList[0].readout)}\n` +
          "Not done: Sam Patel's block on Cell 1 in Line 1 Thu Sep 3, 10 am to 2 pm. Sam Patel would be over the cap today (110% of 100%). Nothing changed.",
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
    await waitFor(() => expect(threadText()).toContain("Done, 2 things."));
    // Once, in the thread; nothing left on the live line (found by the typed
    // walk, session 178: "Done, 2 things." used to stay live as a second
    // copy, and every sentence after a lot inherited a stale live turn).
    expect(threadText().split("Done, 2 things.").length).toBe(2);
    expect(statusText()).toBe("");
    expect(input.value).toBe("");
  });

  it("CB-lot-4: the first command's ambiguous block question is numbered and its buttons continue to the next command, then the lot status", () => {
    const { input } = renderBar({ assignments: [BLK1, BLK2, BLK_SP] });

    fireEvent.change(input, { target: { value: LOT_REMOVE_WHOLE_DAY_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toMatch(/^1 of 2: /);
    expect(screen.getByRole("button", { name: "Remove Housing A 10 am to 2 pm" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove Housing A 2 pm to 4 pm" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove Housing A 10 am to 2 pm" }));

    expect(statusText()).toMatch(/^2 of 2: /);
    expect(screen.getByRole("button", { name: "Remove it" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));

    expect(statusText()).toMatch(/^Ready to do 2 things: /);
    expect(screen.getByRole("button", { name: "Do all 2" })).toBeTruthy();
  });

  it("CB-lot-5: the first command's block is elsewhere (S49), numbered; yes answers that one-candidate question, then the lot", () => {
    const { input } = renderBar({ assignments: [BLK_C2, BLK_SP] });

    fireEvent.change(input, { target: { value: LOT_REMOVE_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toBe(
      "1 of 2: Operator 1 has no block on Cell 1 10 am to 2 pm, but has one on Cell 2: Housing A 10 am to 2 pm. Remove that one?" +
        " — say or type yes to do it, no to leave it.",
    );

    fireEvent.change(input, { target: { value: "yes" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toMatch(/^2 of 2: /);
    expect(screen.getByRole("button", { name: "Remove it" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));

    expect(statusText()).toMatch(/^Ready to do 2 things: /);
  });

  it("CB-lot-6: 'remove it' at the lot status is answered in place, no onRunLot", () => {
    const onRunLot = vi.fn(async (): Promise<LotResult> => ({ done: 2, error: null }));
    const { input } = renderBar({ assignments: [BLK1, BLK_SP] }, null, null, {}, { onRunLot });
    fireEvent.change(input, { target: { value: LOT_REMOVE_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    expect(statusText()).toMatch(/^Ready to do 2 things: /);

    fireEvent.change(input, { target: { value: "remove it" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toBe("That is 2 things at once; say yes to do them all, or no.");
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
      expect(statusText()).toMatch(/^Ready to do 2 things: /);
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
    expect(statusText()).toMatch(/^Ready to do 2 things: /);
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

    // S71-m (F-212/F-215, R-435/R-431): "anything" used to stand in here --
    // it worked only because nothing checked whether the heard text said
    // ANY of this, which is exactly the F-215 shape (a several read with no
    // textual basis at all is now refused, `groundReading`'s own
    // "sweeping" case). The heard text below names both real intents
    // (`unassign`, `move`) this test is actually about, so the fake `several`
    // it decodes into stays grounded and this stays a lot test, not a
    // grounding one.
    fireEvent.change(input, {
      target: {
        value: "unassign Operator 1 from Cell 1 in Line 1 and move Sam Patel on Cell 1 in Line 1",
      },
    });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(statusText()).toMatch(/^Ready to do 2 things: /));
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
    await waitFor(() => expect(threadText()).toContain("Done, 2 things."));
  });

  // DEF-0043 item 3 (CONTRACT CHANGED, 28 Sept, CLAUDE.md §4: not wrong when
  // written): "Those two lines (N and M)" answered a person who typed ONE
  // sentence with a position no supervisor said (R-459) -- rewritten to name
  // the block from the board's own facts instead.
  it("CB-lot-11: two commands naming the same block drop the lot with the collision message, naming the block", () => {
    const { input } = renderBar({ assignments: [BLK1] });

    fireEvent.change(input, {
      target: { value: "Unassign Operator 1 and Operator 1 from Cell 1 in Line 1 from 10 to 2" },
    });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(statusText()).toMatch(/^1 of 2: /);

    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    expect(statusText()).toMatch(/^2 of 2: /);

    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));

    expect(statusText()).toBe(
      "I could not do that in one go: two of the changes are about Operator 1's block on Cell 1. Say them one at a time.",
    );
    // DEF-0049 (CONTRACT CHANGED, 28 Sept): this refusal now closes the
    // trace entry (`finishTrace`) instead of leaving it dangling, which
    // files a turn into the thread -- "Clear history" now renders (history
    // is no longer empty), so this checks the CANDIDATE strip specifically,
    // not every button on the page (the same distinction `candidateButtons`
    // exists for).
    expect(candidateButtons()).toHaveLength(0);
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
    await waitFor(() => expect(threadText()).toContain("Done, 2 things."));
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
    await waitFor(() => expect(threadText()).toContain("Done, 2 things."));
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
  const element = (ctxOver: Partial<ResolveContext>) => (
    <CommandBar
      ctx={buildXCtx(ctxOver)}
      hasPendingCreate={false}
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
    />
  );
  const { rerender } = render(element(over));
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
    // F-233, second pass (S194-G2, review fix): re-renders against a FRESH
    // `ctx` reference -- the same shape `renderBar`'s own `rerenderCtx`
    // already has, added here so a caller can simulate "the board caught up
    // with an earlier write" (Finding 1) between two sentences, which this
    // helper's own callers now need at least once (CB-y-13).
    rerenderCtx: (nextOver: Partial<ResolveContext>) => rerender(element(nextOver)),
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

    expect(statusText()).toMatch(/^Ready to do 2 things: /);
    expect(onHighlight).toHaveBeenLastCalledWith([
      { kind: "remove", assignmentIds: ["xblk1"] },
      { kind: "remove", assignmentIds: ["xblk2"] },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Do all 2" }));
    await waitFor(() => expect(threadText()).toContain("Done, 2 things."));

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

    expect(statusText()).toMatch(/^Ready to do 2 things: /);

    fireEvent.click(screen.getByRole("button", { name: "Do all 2" }));
    await waitFor(() => expect(threadText()).toContain("Done, 2 things."));

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
      "That would be 101 things at once; say a smaller place or span (up to 100 at a time).",
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

    await waitFor(() => expect(statusText()).toMatch(/^Ready to do 2 things: /));
  });

  it("CB-x-7: a lot over six shows five and a count of the rest; six or fewer show every one", () => {
    const { input } = renderXBar({ assignments: spacedBlocksOnXC1(8) });

    fireEvent.change(input, { target: { value: "clear Cell 1 today" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText().startsWith("Ready to do 8 things: 1. ")).toBe(true);
    expect(statusText()).toContain("And 3 more. Say yes to do them, or no.");
    expect(statusText()).not.toContain("6. ");

    cleanup();

    const three = renderXBar({ assignments: spacedBlocksOnXC1(3) });
    fireEvent.change(three.input, { target: { value: "clear Cell 1 today" } });
    fireEvent.keyDown(three.input, { key: "Enter" });

    expect(statusText().startsWith("Ready to do 3 things: 1. ")).toBe(true);
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
    expect(threadText()).toContain(`Written: ${renderedReadout(resolved.readout)}`);
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
    expect(statusText()).toMatch(/^Ready to do 2 things: /);

    fireEvent.click(screen.getByRole("button", { name: "Do all 2" }));
    await waitFor(() => expect(threadText()).toContain("Done, 2 things."));

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
      "Sam's Housing A 10 pm to 6 am block on Cell 1 crosses midnight and matches no shift; split it at midnight first, or say the shift.",
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

  // S194-D (R-461, CONTRACT CHANGED): a clear across midnight now ASKS about
  // the other day's part first; the adjust the old case pinned is the answer
  // No, and its readout says which part stays and which is cleared. Both
  // answers asserted, each with its trace entry (R-434).
  function renderMid2(): { input: HTMLInputElement; fetchMock: ReturnType<typeof stubFetch> } {
    const fetchMock = stubFetch();
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
    return { input, fetchMock };
  }
  // CONTRACT CHANGED (R-461 amended 29 Sept): the question now ends "Say cancel to stop."
  const MID2_QUESTION =
    "John Kim's night shift started Wednesday at 2 am. Clear Wednesday's part too, 2 am to midnight? Say cancel to stop.";

  it("CB-mid-2: clear Cell 1 today over John Kim's block from yesterday asks first, Yes and No the same group; No keeps Wednesday's part", () => {
    const { fetchMock } = renderMid2();
    expect(statusText()).toBe(MID2_QUESTION);
    const yes = screen.getByRole("button", { name: "Yes" });
    const no = screen.getByRole("button", { name: "No" });
    expect(yes.parentElement).toBe(no.parentElement);
    expect(postedEntry(fetchMock).asked).toBe(MID2_QUESTION);

    fireEvent.click(no);

    expect(statusText()).toMatch(/^Ready to do 2 things: /);
    expect(statusText()).toContain(
      "1. John Kim's night shift on Cell 1 keeps its Wednesday part, 2 am to midnight; Thursday's part, midnight to 6 am, is cleared.",
    );
    expect(postedEntry(fetchMock).answered).toBe("No");
  });

  it("CB-mid-2b: the same question answered Yes -- John Kim's whole block goes, no trim", () => {
    renderMid2();
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    expect(statusText()).toMatch(/^Ready to do 2 things: 1\. John Kim is off Cell 1 /);
    expect(statusText()).not.toContain("keeps its");
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
    expect(statusText()).toMatch(/^Ready to do 2 things: /);
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
    expect(statusText()).toMatch(/^Ready to do 4 things: /);
  });

  it("CB-x-12: Escape, a cancel word and a typed edit each drop an EXPANDED lot exactly as a raw several does (S51 CB-lot-7, replayed over expandCommand)", () => {
    function reachExpandedLot() {
      const rendered = renderXBar({ assignments: [XBLK1, XBLK2] });
      fireEvent.change(rendered.input, { target: { value: "clear Cell 1 today" } });
      fireEvent.keyDown(rendered.input, { key: "Enter" });
      expect(statusText()).toMatch(/^Ready to do 2 things: /);
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
    expect(statusText()).toMatch(/^Ready to do 2 things: /);
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

    await waitFor(() => expect(statusText()).toMatch(/^Ready to do 2 things: /));
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

    await waitFor(() => expect(statusText()).toMatch(/^Ready to do 2 things: /));
  });

  it("CB-x-15: exactly 100 is a lot (shows five and 'And 95 more.'); 101 is still the refusal (CB-x-4)", () => {
    const { input } = renderXBar({
      assignments: manyBlocksOnXC1(100).map((b, i) => ({
        ...b,
        endMin: b.startMin + 15,
        label: `block ${i}`,
      })),
    });

    fireEvent.change(input, { target: { value: "clear Cell 1 today" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText().startsWith("Ready to do 100 things: 1. ")).toBe(true);
    expect(statusText()).toContain("And 95 more. Say yes to do them, or no.");
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

    expect(statusText()).toMatch(/^Ready to do 4 things: /);
    expect(statusText()).not.toContain("name the same block");

    fireEvent.click(screen.getByRole("button", { name: "Do all 4" }));
    await waitFor(() => expect(threadText()).toContain("Done, 4 things."));
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

  // ---------------------------------------------------------------------
  // S70-d (R-436, docs/agent-briefs/s70-d-clear-removes-the-job-brief.md):
  // "Unless specified clear means clearing everything" (the maintainer, 17
  // Sept), restated 22 Sept after "clear area 1" left the Bracket A job
  // standing -- an `everyone` clear now removes the RUNS on the place/day
  // too, listed AFTER the people, and a yes on that lot calls the
  // delete-run path (`deleteRun.mutateAsync`, `useDragGesture.ts`'s
  // `runLot`) once per job with the run's own id.
  // ---------------------------------------------------------------------

  it("CB-x-18: 'clear Cell 1 today' with two people and a job expands to a lot of three, the job worded and listed last, and yes calls onRunLot with a remove_run step for it (R-436)", async () => {
    const onRunLot = vi.fn(async (resolved: ResolvedAny[]): Promise<LotResult> => ({
      done: resolved.length,
      error: null,
    }));
    const { input, onHighlight } = renderXBar(
      { assignments: [XBLK1, XBLK2], runs: [RUN_X] },
      null,
      { onRunLot },
    );

    fireEvent.change(input, { target: { value: "clear Cell 1 today" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // Still only the two blocks outlined -- a run names no assignment id to
    // highlight (S51's own `buildLotHighlights` doc: a create/booking names
    // nothing either, and a run removal is the same shape of nothing-to-
    // outline here).
    expect(statusText()).toMatch(/^Ready to do 3 things: /);
    expect(statusText()).toContain(
      renderedReadout(
        "The Housing A job is off Cell 1 2026-09-03; that was 8 am to 4 pm, for 3 people.",
      ),
    );
    expect(onHighlight).toHaveBeenLastCalledWith([
      { kind: "remove", assignmentIds: ["xblk1"] },
      { kind: "remove", assignmentIds: ["xblk2"] },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Do all 3" }));
    await waitFor(() => expect(threadText()).toContain("Done, 3 things."));

    expect(onRunLot).toHaveBeenCalledTimes(1);
    const [resolvedList] = onRunLot.mock.calls[0] as [ResolvedAny[]];
    // People first, the job after -- brief §2: a job's `delete_run` cascade
    // must never remove a block the lot has already listed as its own
    // earlier step.
    expect(resolvedList.map((r) => r.intent)).toEqual(["unassign", "unassign", "remove_run"]);
    expect((resolvedList[0] as ResolvedUnassign).assignmentId).toBe("xblk1");
    expect((resolvedList[1] as ResolvedUnassign).assignmentId).toBe("xblk2");
    expect((resolvedList[2] as ResolvedRunRemoval).runId).toBe("runX");
  });

  it("CB-x-19: 'clear Cell 1 today' with a job and nobody on it lists the job alone -- never 'has nobody on it' -- and yes calls onRunLot with the one remove_run step (R-436)", async () => {
    const onRunLot = vi.fn(async (resolved: ResolvedAny[]): Promise<LotResult> => ({
      done: resolved.length,
      error: null,
    }));
    const { input } = renderXBar({ runs: [RUN_X] }, null, { onRunLot });

    fireEvent.change(input, { target: { value: "clear Cell 1 today" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toMatch(/^Ready to do 1 thing: /);
    // S195-A (DEF-0043): a lot of one is not numbered, and says "it".
    expect(statusText()).not.toMatch(/^Ready to do 1 thing: 1\. /);
    expect(statusText()).toMatch(/ Say yes to do it, or no\.$/);
    expect(statusText()).toContain("The Housing A job is off");
    expect(statusText()).not.toContain("has nobody on it");

    // S195-D (item 3, CONTRACT CHANGED, CLAUDE.md 4: the case was not wrong
    // when written, the button label is what changed): one thing is "Do it",
    // never "Do all 1"; two or more keep "Do all N" (CB-x-18 and its kin).
    expect(screen.queryByRole("button", { name: "Do all 1" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Do it" }));
    await waitFor(() => expect(threadText()).toContain("Done, 1 thing."));

    expect(onRunLot).toHaveBeenCalledTimes(1);
    const [resolvedList] = onRunLot.mock.calls[0] as [ResolvedAny[]];
    expect(resolvedList.map((r) => r.intent)).toEqual(["remove_run"]);
    expect((resolvedList[0] as ResolvedRunRemoval).runId).toBe("runX");
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

    expect(statusText()).toMatch(/^Ready to do 2 things: /);

    fireEvent.click(screen.getByRole("button", { name: "Do all 2" }));
    await waitFor(() => expect(threadText()).toContain("Done, 2 things."));

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

    expect(statusText()).toMatch(/^Ready to do 5 things: /);
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
    expect(resolved.readout).toContain("Sam's block on Cell 1 now ends 3 pm; it was 2 pm.");
    expect(threadText()).toContain(`Written: ${renderedReadout(resolved.readout)}`);
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
    expect(threadText()).toContain(`Written: ${renderedReadout(resolved.readout)}`);
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
      "Housing A runs more than once on Cell 1: 8 am to 4 pm, 4 pm to 8 pm. Say the hours.",
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
    expect(statusText()).toContain("1 pm to 3 pm");

    fireEvent.click(screen.getByRole("button", { name: "Separate block" }));

    // The answer re-resolved the LOT's own step 2 -- the lot is now whole.
    expect(statusText()).toMatch(/^Ready to do 2 things: /);

    fireEvent.click(screen.getByRole("button", { name: "Do all 2" }));
    await waitFor(() => expect(threadText()).toContain("Done, 2 things."));

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
    expect(statusText()).toMatch(/^Ready to do 2 things: /);
    expect(statusText()).not.toMatch(/move which/i);

    fireEvent.click(screen.getByRole("button", { name: "Do all 2" }));
    await waitFor(() => expect(threadText()).toContain("Done, 2 things."));
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
    const button = screen.getByRole("button", { name: /Cell 1.*10 am to 2 pm/ });
    fireEvent.click(button);

    expect(onMove).toHaveBeenCalledTimes(1);
    const [resolved] = onMove.mock.calls[0] as [ResolvedMove, { x: number; y: number }];
    expect(resolved.target).toEqual({ kind: "retime" });
    expect(resolved.range).toEqual({ startMin: 3 * 1440 + 600, endMin: 3 * 1440 + 900 });
    // S63-a review fix (CP-5, CLAUDE.md §4): filed (and the live line
    // cleared) the same tick -- the readout reads from the thread now.
    expect(resolved.readout).toContain("Sam's block on Cell 1 now ends 3 pm; it was 2 pm.");
    expect(threadText()).toContain(`Written: ${renderedReadout(resolved.readout)}`);
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
    // S196-A (F-239, R-431): CONTRACT CHANGED -- a write not yet answered is
    // "Working…", never the readout (which used to be pinned here as shown
    // "SYNCHRONOUSLY ... before the write could have settled"). The readout
    // appears with the answer; a pending write has none to show.
    expect(statusText()).toBe("Working…");
    // R-437 (CONTRACT CHANGED, CLAUDE.md §4): this used to pin that the
    // input was "never cleared for a single (non-lot) write -- success or
    // failure look identical from here". R-437 (CB-ent-1) empties the box on
    // Enter regardless, so success and failure keep looking identical from
    // here -- just both empty now instead of both unchanged.
    expect(input.value).toBe("");
  });

  // F-233, second pass (S194-G2, review fix): CONTRACT CHANGED. The second
  // "make it 4 people" used to run immediately behind the first, `ctx` never
  // having changed between the two Enters. Finding 1 now holds a sentence
  // typed before the board has caught up with the first write's own outcome
  // -- `rerenderXCtx` (this file's own twin of `renderBar`'s `rerenderCtx`)
  // simulates that catch-up between them; the point this case was written to
  // prove (running the SAME sentence twice writes twice, no dedupe) is
  // otherwise unchanged.
  it("CB-y-13: reviewer scenario 5 -- 'make the Housing A job on Cell 1 4 people' typed and run twice is a plain write both times, no dedupe", () => {
    const { onSetHeadcount, input, rerenderCtx } = renderXBar({ runs: [RUN_X] });

    fireEvent.change(input, { target: { value: "make the Housing A job on Cell 1 4 people" } });
    fireEvent.keyDown(input, { key: "Enter" });
    rerenderCtx({ runs: [RUN_X] });
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

    await waitFor(() => expect(statusText()).toMatch(/^Ready to do 2 things: /));
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
        "I could not read that as more than one thing. Say them one at a time.",
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

    expect(statusText()).toMatch(/^Ready to do 5 things: /);
    expect(statusText()).not.toMatch(/and \d+ more/);
    expect(statusText()).toMatch(
      /^Ready to do 5 things: 1\. .+ 2\. .+ 3\. .+ 4\. .+ 5\. .+ Say yes/,
    );
  });

  it("CB-y-20: reviewer scenario 11b -- a seven-command every-day lot shows five and 'And 2 more.'", async () => {
    const onRunLot = vi.fn(async (resolved: ResolvedAny[]): Promise<LotResult> => ({
      done: resolved.length,
      error: null,
    }));
    const { input } = renderXBar({}, null, { onRunLot });

    fireEvent.change(input, {
      target: { value: "assign Sam to Housing A on Cell 1 every day this week 8 to 4" },
    });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toMatch(/^Ready to do 7 things: /);
    expect(statusText()).toContain("And 2 more. Say yes to do them, or no.");
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
  it("CB-model-1: a clean model answer opens the popover exactly as the rules would, the readout carries no suffix (R-459)", async () => {
    const parsed = parseCommand(P1_SENTENCE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const fakeReader: Reader = vi.fn(async (): Promise<Reading> => ({
      ok: true,
      command: parsed.command,
      by: "model",
    }));

    // R-459 (the maintainer, 24 Sept): the " · read by the model" suffix is
    // gone from the thread entirely -- nothing replaces it. `onOpen` is held
    // pending so the live status line is still there to read once the model
    // has answered, the same shape C2/CB-day-1 use.
    const { onOpen, input } = renderBar({ runs: [] }, fakeReader);
    const write = pendingWrite();
    onOpen.mockReturnValue(write.promise);
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
    const dayLabel = formatDayLabel(new Date("2026-09-03T00:00:00Z"), "d_mon_yyyy", "UTC");
    // S196-A (F-239): "Working…" until the writer answers, then the readout.
    expect(statusText()).toBe("Working…");
    await write.settle();
    expect(threadText()).toContain(
      `Operator 1 is on Cell 1 in Line 1 ${dayLabel} from 10 am to 2 pm, making Housing A.`,
    );
  });

  it("CB-model-2: 'unavailable' falls back to the rules, the readout carries no suffix (R-459)", async () => {
    const fakeReader: Reader = vi.fn(async (): Promise<Reading> => ({
      ok: false,
      reason: "unavailable",
    }));
    // R-459: the "· read by the rules (…)" suffix is gone from the thread
    // entirely -- a rules fallback and a clean model reading print the
    // identical sentence now.
    const { onOpen, input } = renderBar({ runs: [] }, fakeReader);
    const write = pendingWrite();
    onOpen.mockReturnValue(write.promise);

    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));

    const dayLabel = formatDayLabel(new Date("2026-09-03T00:00:00Z"), "d_mon_yyyy", "UTC");
    // S196-A (F-239): "Working…" until the writer answers, then the readout.
    expect(statusText()).toBe("Working…");
    await write.settle();
    expect(threadText()).toContain(
      `Operator 1 is on Cell 1 in Line 1 ${dayLabel} from 10 am to 2 pm, making Housing A.`,
    );
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
      expect(statusText()).toBe(
        `I could not reach the voice model, so I read this as typed: ${SHAPE}`,
      ),
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

describe("CB-ground: the model's reading must be grounded in what was heard (S71-m, F-212/F-215, R-435/R-431)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("CB-ground-1: 'EF76.' read as an unassign of everyone is refused outright -- nothing ran, no buttons, the trace's outcome is the refused shape", async () => {
    const fetchMock = stubFetch();
    const command: UnassignCommand = {
      intent: "unassign",
      operator: "everyone",
      place: [],
      day: null,
      span: null,
      existing: null,
      shift: null,
      until: null,
    };
    const fakeReader: Reader = vi.fn(async (): Promise<Reading> => ({
      ok: true,
      command,
      by: "model",
    }));
    const { onUnassign, onRunLot, input } = renderBar({}, fakeReader);

    fireEvent.change(input, { target: { value: "EF76." } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(statusText()).toContain('Not done: nothing in "EF76." says');
    expect(statusText()).toContain("Say it again.");
    expect(candidateButtons()).toHaveLength(0);
    expect(onUnassign).not.toHaveBeenCalled();
    expect(onRunLot).not.toHaveBeenCalled();

    const entry = postedEntry(fetchMock);
    expect(entry.outcome).toBe("refused: ungrounded");
  });

  // R-456 / F-222 (24 Sept, session 191) -- CONTRACT CHANGED (CLAUDE.md §4):
  // this pinned `askUngrounded`'s own one-button "I heard ... Did you mean:
  // ..." ask for exactly this shape. `verbGuessStatus` now runs FIRST
  // (`applyReading`'s own ungrounded branch, before `refuseUngrounded`/
  // `askUngrounded`) -- `guessVerbs`' shape-candidate rule (no verb heard at
  // all, but the sentence has a part and a place) reconstructs the identical
  // "book Housing A on Cell 1 in Line 1 from 6 to 2" as its one candidate,
  // so the SAME one-button ask/write still happens, through `run_sentence`
  // (re-submitted through the reader) rather than `run_ungrounded` (the
  // model's already-parsed command run directly) -- `isYesShapedQuestion`'s
  // own widening (above) is what keeps CB-ground-5/6's "yes" still working.
  // Rewritten to assert the new question's own wording.
  it("CB-ground-2: the F-212 shape (a book with the leading 'Assign Tom Baker to' lost) is now a verb-guess question, one button, its readout the label; pressing it re-reads and writes", async () => {
    const parsedBook = parseCommand(BOOK_SENTENCE);
    expect(parsedBook.ok).toBe(true);
    if (!parsedBook.ok) return;
    const fakeReader: Reader = vi.fn(async (): Promise<Reading> => ({
      ok: true,
      command: parsedBook.command,
      by: "model",
    }));
    const { onBook, input } = renderBar({ runs: [] }, fakeReader);
    const heard = "Housing A on Cell 1 in Line 1 from 6 to 2";

    fireEvent.change(input, { target: { value: heard } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(candidateButtons()).toHaveLength(1));
    expect(statusText()).toBe("Did you mean:");
    expect(candidateButtons()[0].textContent).toBe(formatCommand(parsedBook.command));
    expect(onBook).not.toHaveBeenCalled();

    fireEvent.click(candidateButtons()[0]);
    await waitFor(() => expect(onBook).toHaveBeenCalledTimes(1));
  });

  it("CB-ground-3: the same ungrounded book, answered 'no' -- nothing written, answered 'no'", async () => {
    const fetchMock = stubFetch();
    const parsedBook = parseCommand(BOOK_SENTENCE);
    expect(parsedBook.ok).toBe(true);
    if (!parsedBook.ok) return;
    const fakeReader: Reader = vi.fn(async (): Promise<Reading> => ({
      ok: true,
      command: parsedBook.command,
      by: "model",
    }));
    const { onBook, input } = renderBar({ runs: [] }, fakeReader);
    const heard = "Housing A on Cell 1 in Line 1 from 6 to 2";

    fireEvent.change(input, { target: { value: heard } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(candidateButtons()).toHaveLength(1));

    fireEvent.change(input, { target: { value: "no" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onBook).not.toHaveBeenCalled();
    expect(statusText()).toBe("Left it.");
    const entry = postedEntry(fetchMock);
    expect(entry.answered).toBe("no");
  });

  it("CB-ground-4: a grounded reading runs unchanged (an existing case's shape, CB-model-1)", async () => {
    const parsed = parseCommand(P1_SENTENCE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const fakeReader: Reader = vi.fn(async (): Promise<Reading> => ({
      ok: true,
      command: parsed.command,
      by: "model",
    }));
    const { onOpen, input } = renderBar({ runs: [] }, fakeReader);
    const write = pendingWrite();
    onOpen.mockReturnValue(write.promise);

    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));
    // R-459: no suffix at all -- the readout is the plain sentence. S196-A
    // (F-239): it is in the thread once the writer has answered; until then
    // the live line is "Working…".
    const dayLabel = formatDayLabel(new Date("2026-09-03T00:00:00Z"), "d_mon_yyyy", "UTC");
    expect(statusText()).toBe("Working…");
    await write.settle();
    expect(threadText()).toContain(
      `Operator 1 is on Cell 1 in Line 1 ${dayLabel} from 10 am to 2 pm, making Housing A.`,
    );
    expect(candidateButtons()).toHaveLength(0);
  });

  // S71-m review fix (F-212, R-435): "yes" must answer a one-button question
  // -- `askUngrounded`'s own question carries no `blockHighlight` (nothing
  // has resolved yet to outline), so it needs `isYesShapedQuestion`'s own
  // widened test, not the block-question shape, to be yes-shaped at all.
  // R-456 / F-222 (24 Sept, session 191): this question is now the
  // verb-guess one (CB-ground-2's own note, above), a `run_sentence`
  // one-button ask rather than `run_ungrounded` -- `isYesShapedQuestion`'s
  // matching widening keeps this behaviour unchanged; still pinned here.
  it("CB-ground-5: typed 'yes' answers the one-button verb-guess question (onBook once, answered 'yes')", async () => {
    const fetchMock = stubFetch();
    const parsedBook = parseCommand(BOOK_SENTENCE);
    expect(parsedBook.ok).toBe(true);
    if (!parsedBook.ok) return;
    const fakeReader: Reader = vi.fn(async (): Promise<Reading> => ({
      ok: true,
      command: parsedBook.command,
      by: "model",
    }));
    const { onBook, input } = renderBar({ runs: [] }, fakeReader);
    const heard = "Housing A on Cell 1 in Line 1 from 6 to 2";

    fireEvent.change(input, { target: { value: heard } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(candidateButtons()).toHaveLength(1));

    fireEvent.change(input, { target: { value: "yes" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(onBook).toHaveBeenCalledTimes(1));
    // DEF-0049 (CONTRACT CHANGED, 28 Sept): TWO separate trace entries now,
    // not one -- the verb-guess question's OWN entry (posted at the ask,
    // call 0; revised to `answered: "yes"` when `run_sentence` starts a
    // FRESH entry for the guessed sentence, call 1) and that second
    // sentence's own entry (call 2, `answered: "auto"`, it ran straight off
    // its own readout). This pin is about the FIRST entry's own answer.
    const askedEntry = postedEntry(fetchMock, 0);
    expect(askedEntry.answered).toBeNull();
    const answeredEntry = postedEntry(fetchMock, 1);
    expect(answeredEntry.answered).toBe("yes");
  });

  it("CB-ground-6: the same ungrounded book, confirmed by a spoken 'yes' through the recogniser (a second press, same as CB-yes-5)", async () => {
    const parsedBook = parseCommand(BOOK_SENTENCE);
    expect(parsedBook.ok).toBe(true);
    if (!parsedBook.ok) return;
    const fakeReader: Reader = vi.fn(async (): Promise<Reading> => ({
      ok: true,
      command: parsedBook.command,
      by: "model",
    }));
    const { recognizer, fire } = makeFakeRecognizer();
    const { onBook, input } = renderBar({ runs: [] }, fakeReader, recognizer);
    const heard = "Housing A on Cell 1 in Line 1 from 6 to 2";

    fireEvent.change(input, { target: { value: heard } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(candidateButtons()).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "Speak a sentence" }));
    fire.final("yes");

    await waitFor(() => expect(onBook).toHaveBeenCalledTimes(1));
  });
});

/**
 * S72-e (docs/agent-briefs/s72-e-clear-over-a-week-brief.md §3, F-224,
 * R-435): `applyReading`'s own `groundDays` call site (the model path) --
 * grounded on its VERB (`groundReading` passes) does not mean the DAY
 * survived. CB-days-1/2 use an ordinary single day ("tomorrow"), not a
 * repeat week, because that is the smallest shape that exercises the same
 * guard and still writes through the ordinary single-command path
 * (`onOpen`) rather than a lot -- `grounded.test.ts`'s GD-3 already pins the
 * F-224 week shape itself, at the `groundDays` level.
 */
describe("CB-days: a day/week phrase heard but not read is asked about (S72-e, F-224, R-435)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("CB-days-1: the model heard 'tomorrow' but its own form still carries day: null -- a question naming the phrase, one button, the corrected re-parse as its label", async () => {
    const heard = `${P1_SENTENCE} tomorrow`;
    const parsed = parseCommand(P1_SENTENCE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const fakeReader: Reader = vi.fn(async (): Promise<Reading> => ({
      ok: true,
      // The model's own reading: every field right except `day`, which
      // stayed `null` (F-224's own shape -- the day word was heard and
      // silently dropped).
      command: parsed.command,
      by: "model",
    }));
    const { onOpen, input } = renderBar({ runs: [] }, fakeReader);

    fireEvent.change(input, { target: { value: heard } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(candidateButtons()).toHaveLength(1));
    expect(statusText()).toContain('I heard "tomorrow" but read it as today.');
    expect(statusText()).toContain("Did you mean:");
    const reparsed = parseCommand(heard);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(candidateButtons()[0].textContent).toBe(formatCommand(reparsed.command));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("CB-days-2: pressing the button runs the RE-PARSED (corrected) command, not the model's own dropped one", async () => {
    const heard = `${P1_SENTENCE} tomorrow`;
    const parsed = parseCommand(P1_SENTENCE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const fakeReader: Reader = vi.fn(async (): Promise<Reading> => ({
      ok: true,
      command: parsed.command,
      by: "model",
    }));
    const { onOpen, input } = renderBar({ runs: [] }, fakeReader);

    fireEvent.change(input, { target: { value: heard } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(candidateButtons()).toHaveLength(1));

    fireEvent.click(candidateButtons()[0]);
    await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));
  });

  it("CB-days-3: the heard phrase's own sentence does not re-parse at all (no operator/place said) -- the plain question, no button", async () => {
    const fakeReader: Reader = vi.fn(async (): Promise<Reading> => ({
      ok: true,
      command: {
        intent: "assign",
        operator: "Operator 1",
        product: "Housing A",
        place: ["Cell 1"],
        day: null,
        start: { hour: 10, minute: 0 },
        end: { hour: 14, minute: 0 },
        attach: null,
        existing: null,
        shift: null,
      },
      by: "model",
    }));
    const { onOpen, input } = renderBar({ runs: [] }, fakeReader);

    // "assign" grounds the VERB (`groundReading` passes); "today" is a day
    // phrase the fake model's own form (above) still reads as `day: null`;
    // and "assign today" alone -- no operator, part or place -- does not
    // re-parse into anything at all, so `askDayDropped`'s own fallback (no
    // button) is what has to show.
    fireEvent.change(input, { target: { value: "assign today" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(statusText()).toContain('I heard "today" but read it as today.'));
    expect(statusText()).toContain("Which days?");
    expect(candidateButtons()).toHaveLength(0);
    expect(onOpen).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------
// R-457 / F-220 (24 Sept, session 191): a `place_mismatch` question offers
// the parent as a button -- CB-pm-1..3. The fixture's two "Cell 1"s (c1a in
// Line 1, c1b in Line 3, `buildCtx`'s own comment) are exactly R5's own
// shape in commandResolve.test.ts (`elsewhere`: Line 1, Line 3), reused here
// as text through the whole bar rather than a bare `resolveCommand` call.
// -----------------------------------------------------------------------
describe("CB-pm: place_mismatch offers the parent (R-457, F-220)", () => {
  // "Cover" (not "Housing A"): `buildCtx`'s own `offeredAt` only offers
  // Cover at c1b (the Line 3 "Cell 1") -- picking "Line 3" below must reach
  // a real write, not a second question (`not_offered`) about the part.
  const PM_SENTENCE = "Assign Operator 1 to Cover on Cell 1 in Line 2 from 10 to 2";

  it("CB-pm-1: 'Cell 1 in Line 2' shows a 'Line 1' and a 'Line 3' button; pressing 'Line 3' writes on c1b", async () => {
    const { onOpen, input } = renderBar({ runs: [] });
    fireEvent.change(input, { target: { value: PM_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toBe("There is no Cell 1 in Line 2. Cell 1 is in Line 1, Line 3.");
    expect(screen.getByRole("button", { name: "Line 1" })).toBeTruthy();
    const line3 = screen.getByRole("button", { name: "Line 3" });
    expect(line3).toBeTruthy();

    fireEvent.click(line3);

    expect(onOpen).toHaveBeenCalledTimes(1);
    const [resolved] = onOpen.mock.calls[0] as [ResolvedCommand, { x: number; y: number }];
    expect(resolved.nodeId).toBe("c1b");
  });

  it("CB-pm-2: the readout and the trace both carry the pick -- answered: 'Line 3'", async () => {
    const fetchMock = stubFetch();
    const { input } = renderBar({ runs: [] });
    fireEvent.change(input, { target: { value: PM_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    fireEvent.click(screen.getByRole("button", { name: "Line 3" }));

    const entry = postedEntry(fetchMock);
    expect(entry.asked).toBe("There is no Cell 1 in Line 2. Cell 1 is in Line 1, Line 3.");
    expect(entry.answered).toBe("Line 3");
  });

  it("CB-pm-3: a place_mismatch with empty elsewhere shows no button (unchanged)", () => {
    // Both matched cells have no parent node at all -- `elsewhereParents`
    // excludes them rather than naming the cell itself (F-213's own edge
    // case, R5b in commandResolve.test.ts). A minimal ctx with a single
    // top-level cell and no line above it reproduces the same shape through
    // the bar: the cell matches, the qualifier does not, and there is no
    // ancestor to offer.
    const { input } = renderBar({
      cells: [{ id: "lone", name: "Cell 9", path: "cell_9" }],
      nodeById: new Map([["lone", { id: "lone", name: "Cell 9", path: "cell_9" }]]),
      offeredAt: () => [{ id: "ha" }, { id: "hb" }],
    });
    fireEvent.change(input, {
      target: { value: "Assign Operator 1 to Housing A on Cell 9 in Line 2 from 10 to 2" },
    });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toBe("There is no Cell 9 in Line 2.");
    expect(candidateButtons()).toHaveLength(0);
  });

  // Reviewer fix (R-457, 24 Sept session 191): CB-pm-1/2 both name the
  // mismatched qualifier at `place[1]` -- never assume that (CLAUDE.md §4).
  // A THREE-word place ("Cell 1 in Line 1 in Zone 9") puts the mismatch at
  // `place[2]`: "Line 1" (index 1) matches fine, narrowing to one cell;
  // "Zone 9" (index 2) does not. `elsewhereParents` always names the
  // matched cell's own IMMEDIATE parent (here, "Line 1" itself -- the same
  // node the FIRST qualifier already named, `resolve.ts`'s own unchanged
  // behaviour) -- pressing it must substitute `place[2]`, never `place[1]`.
  it("CB-pm-4: a place_mismatch whose qualifier is at index 2 of a three-word place substitutes index 2, not index 1", () => {
    const nodes = [
      { id: "p1", name: "Plant 1", path: "plant_1" },
      { id: "z1", name: "Zone 1", path: "plant_1.zone_1" },
      { id: "l1", name: "Line 1", path: "plant_1.zone_1.line_1" },
      { id: "c1", name: "Cell 1", path: "plant_1.zone_1.line_1.cell_1" },
    ];
    const { onOpen, input } = renderBar({
      cells: [nodes[3]],
      nodeById: new Map(nodes.map((n) => [n.id, n] as const)),
      offeredAt: () => [{ id: "ha" }, { id: "hb" }],
    });
    fireEvent.change(input, {
      target: {
        value: "Assign Operator 1 to Housing A on Cell 1 in Line 1 in Zone 9 from 10 to 2",
      },
    });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toBe("There is no Cell 1 in Zone 9. Cell 1 is in Line 1.");
    const line1Button = screen.getByRole("button", { name: "Line 1" });

    fireEvent.click(line1Button);

    // A wrong `qualifierIndex` (1, the first "Line 1") would have replaced
    // the ALREADY-CORRECT middle qualifier instead of the mismatched third
    // one, and the re-parsed sentence would still carry "Zone 9" -- refused
    // or re-asked again, never a write.
    expect(onOpen).toHaveBeenCalledTimes(1);
    const [resolved] = onOpen.mock.calls[0] as [ResolvedCommand, { x: number; y: number }];
    expect(resolved.nodeId).toBe("c1");
  });

  // Reviewer fix (R-457): `pickPlaceParent` takes a LOT branch
  // (`updateLotCommand`, never the sentence-level reparse) when a lot is
  // standing -- a place_mismatch on a LOT'S OWN CURRENT STEP (a per-step
  // `SingleCommand`, not the `SeveralCommand` itself -- that one's only
  // question is `several_unsupported`, with no candidates, so the button
  // path this test drives can never reach it) must still substitute the
  // right index and resolve the step, not the whole several sentence.
  it("CB-pm-5: a place_mismatch on a lot's own current step substitutes through updateLotCommand and resolves that step", () => {
    const { onOpen } = renderBar({ runs: [] });
    const input = screen.getByRole("textbox", { name: "Tell the board" });
    fireEvent.change(input, {
      target: {
        value: "Assign Operator 1 and Sam Patel to Cover on Cell 1 in Line 2 from 10 to 2",
      },
    });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toBe("1 of 2: There is no Cell 1 in Line 2. Cell 1 is in Line 1, Line 3.");
    fireEvent.click(screen.getByRole("button", { name: "Line 3" }));

    // The lot advances to its SECOND person on the SAME (now corrected)
    // place -- never a write yet (this several has two steps, so a write
    // only happens once both have resolved and "yes" runs the lot).
    expect(statusText()).toBe("2 of 2: There is no Cell 1 in Line 2. Cell 1 is in Line 1, Line 3.");
    expect(onOpen).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------
// R-456 / F-222 (24 Sept, session 191): the verb question -- CB-verb-1..4.
// `guessVerbs` is spied per test (restored in `afterEach`) so these pin the
// BAR's own wiring against two controlled guesses, not `verbGuess.ts`'s own
// heuristics (already exercised for real by CB-ground-2/5/6, above, and by
// `verbGuess.test.ts`).
// -----------------------------------------------------------------------
describe("CB-verb: the verb question (R-456, F-222)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A guess whose `sentence` genuinely parses -- `label` built the same way
   *  `guessVerbs` itself builds one (`formatCommand` of the parse), never
   *  hand-typed, so a press's own re-parse (`run_sentence`) has something
   *  real to run. */
  function guessFrom(verb: string, sentence: string): VerbGuess {
    const parsed = parseCommand(sentence);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(`CB-verb fixture sentence must parse: ${sentence}`);
    return { verb, sentence, label: formatCommand(parsed.command) };
  }

  it("CB-verb-1: two guesses render as two buttons -- never the grammar hint", () => {
    const guessA = guessFrom("assign", P1_SENTENCE);
    const guessB = guessFrom("book", BOOK_SENTENCE);
    vi.spyOn(verbGuessLib, "guessVerbs").mockReturnValue([guessA, guessB]);
    const { input } = renderBar({ runs: [] });

    fireEvent.change(input, { target: { value: "gibberish" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toBe("Did you mean:");
    expect(statusText()).not.toBe(SHAPE);
    const buttons = candidateButtons();
    expect(buttons).toHaveLength(2);
    expect(buttons[0].textContent).toBe(guessA.label);
    expect(buttons[1].textContent).toBe(guessB.label);
  });

  it("CB-verb-2: pressing a guess re-reads its own sentence and writes -- the trace shows the pressed button as the FIRST entry's answered and the guess's sentence as the SECOND entry's heard", () => {
    const fetchMock = stubFetch();
    const guessA = guessFrom("assign", P1_SENTENCE);
    const guessB = guessFrom("book", BOOK_SENTENCE);
    vi.spyOn(verbGuessLib, "guessVerbs").mockReturnValue([guessA, guessB]);
    const { onOpen, input } = renderBar({ runs: [] });

    fireEvent.change(input, { target: { value: "gibberish" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: guessA.label }));

    expect(onOpen).toHaveBeenCalledTimes(1);
    const entries = fetchMock.mock.calls.map((call: unknown[]) => {
      const [, init] = call as [string, RequestInit];
      return JSON.parse(init.body as string) as TraceEntry;
    });
    // DEF-0049 (CONTRACT CHANGED, 28 Sept): "gibberish"'s own entry now
    // posts TWICE -- once at the ask (`answered: null`), once flushed
    // (`answered: guessA.label`) when the guess's own sentence starts a
    // fresh entry -- `findLast` reads the up-to-date line, same as
    // `postedEntry`'s own updated default (this helper takes an array of
    // already-parsed entries, not `fetchMock` itself, so it uses the array
    // method directly rather than that helper).
    const firstEntry = entries.findLast((e) => e.heard === "gibberish");
    expect(firstEntry?.asked).toBe("Did you mean:");
    expect(firstEntry?.answered).toBe(guessA.label);
    const secondEntry = entries.findLast((e) => e.heard === guessA.sentence);
    expect(secondEntry).toBeTruthy();
    expect(secondEntry?.outcome).toBe("written");
  });

  it("CB-verb-3: guessVerbs returns [] -- the grammar hint shows, unchanged", () => {
    vi.spyOn(verbGuessLib, "guessVerbs").mockReturnValue([]);
    const { input } = renderBar();

    fireEvent.change(input, { target: { value: "gibberish" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toBe(SHAPE);
    expect(candidateButtons()).toHaveLength(0);
  });

  it('CB-verb-4: applyReading\'s SWEEPING ungrounded branch asks the verb question instead of refusing ("Show up Lena Novak and Priya Shah today")', async () => {
    const guessA = guessFrom("swap", "swap Lena Novak and Priya Shah today");
    vi.spyOn(verbGuessLib, "guessVerbs").mockReturnValue([guessA]);
    // The same sweeping shape CB-ground-1 uses (an unassign of "everyone",
    // no word in the heard text for it) -- the model's own guess when it
    // mishears "show up" (R-456's own worked example, verbGuess.ts's table).
    const command: UnassignCommand = {
      intent: "unassign",
      operator: "everyone",
      place: [],
      day: null,
      span: null,
      existing: null,
      shift: null,
      until: null,
    };
    const fakeReader: Reader = vi.fn(async (): Promise<Reading> => ({
      ok: true,
      command,
      by: "model",
    }));
    const { input } = renderBar({}, fakeReader);

    fireEvent.change(input, {
      target: { value: "Show up Lena Novak and Priya Shah today" },
    });
    fireEvent.keyDown(input, { key: "Enter" });

    // `misheardVerbWord` (real, not mocked) names "Show up" itself --
    // `describeVerbGuess`'s own wording for a table hit, never the bare
    // "Did you mean:" a shape-only guess (no word replaced) gets.
    await waitFor(() => expect(statusText()).toBe('I heard "Show up". Did you mean:'));
    expect(statusText()).not.toContain("Not done:");
    const buttons = candidateButtons();
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toBe(guessA.label);
  });

  // Reviewer fix (R-456): a guess's own `sentence` is built by `guessVerbs`
  // to parse (`guessFrom`'s own assertion above holds for every OTHER case
  // in this file) -- but a re-submission is an ordinary sentence like any
  // other once pressed, so if it somehow still fails to parse (or grounds to
  // nothing), the SAME `verbGuessStatus` call `fallbackToRules`/
  // `applyReading` already makes runs again on the RETRIED text -- never a
  // crash, and never stuck re-asking the identical question forever with no
  // way out (`guessVerbs` mocked to answer EMPTY the second time, the same
  // as the real function would for text it has nothing left to guess about,
  // falls through to the ordinary grammar hint).
  it("CB-verb-5: a guess whose own sentence fails to parse on re-submission falls through to the grammar hint, not a crash or a repeated question", () => {
    const badGuess: VerbGuess = { verb: "assign", sentence: "zzz not a sentence", label: "zzz" };
    vi.spyOn(verbGuessLib, "guessVerbs").mockReturnValueOnce([badGuess]).mockReturnValueOnce([]);
    const { input } = renderBar();

    fireEvent.change(input, { target: { value: "gibberish" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(statusText()).toBe("Did you mean:");

    fireEvent.click(screen.getByRole("button", { name: "zzz" }));

    expect(statusText()).toBe(SHAPE);
    expect(candidateButtons()).toHaveLength(0);
  });

  // Reviewer fix (R-456): `isYesShapedQuestion` widened to `run_sentence`
  // covers a ONE-candidate verb question -- but a bare "yes" must never
  // press one of TWO (the person has to say which), same as every other
  // multi-candidate question in this file.
  it('CB-verb-6: spoken/typed "yes" presses a ONE-candidate verb question but does NOT take a TWO-candidate one', () => {
    const guessA = guessFrom("assign", P1_SENTENCE);
    vi.spyOn(verbGuessLib, "guessVerbs").mockReturnValue([guessA]);
    const { onOpen, input } = renderBar({ runs: [] });

    fireEvent.change(input, { target: { value: "gibberish" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(candidateButtons()).toHaveLength(1);

    fireEvent.change(input, { target: { value: "yes" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onOpen).toHaveBeenCalledTimes(1);
    cleanup();

    const guessB = guessFrom("book", BOOK_SENTENCE);
    vi.spyOn(verbGuessLib, "guessVerbs").mockReturnValue([guessA, guessB]);
    const two = renderBar({ runs: [] });

    fireEvent.change(two.input, { target: { value: "gibberish" } });
    fireEvent.keyDown(two.input, { key: "Enter" });
    expect(candidateButtons()).toHaveLength(2);

    fireEvent.change(two.input, { target: { value: "yes" } });
    fireEvent.keyDown(two.input, { key: "Enter" });

    // Neither candidate ran -- a bare "yes" against two choices re-asks
    // which one, same as any other multi-candidate question that is not
    // itself yes-shaped.
    expect(two.onOpen).not.toHaveBeenCalled();
    expect(statusText()).toBe("Say which one.");
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

  it("CB-mic-2: pressing starts a session and sets aria-pressed, aborts an in-flight reading, and shows Listening… only once the recogniser announces the phase", () => {
    const { recognizer, fire } = makeFakeRecognizer();
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
    // F-214 (CONTRACT CHANGED, CLAUDE.md §4): `startListening` no longer sets
    // the "listening" phase itself the instant a session starts -- the
    // synchronous `setMicPhase("listening")` this pin used to name is gone.
    // The label now shows only once the recogniser ITSELF announces the
    // phase through `onStatus("listening")` (the local engine fires it once
    // its audio graph is connected; the browser engine from its own
    // `onstart`), so a bare fake recogniser that fires nothing yet shows
    // nothing yet.
    expect(screen.queryByText("Listening…")).toBeNull();

    fire.status("listening");
    expect(screen.getByText("Listening…")).toBeTruthy();
  });

  it("CB-mic-3: an interim result shows the heard text as the input's placeholder, never its value", () => {
    const { recognizer, fire } = makeFakeRecognizer();
    const { input } = renderBar({}, null, recognizer);
    fireEvent.click(screen.getByRole("button", { name: "Speak a sentence" }));

    fire.interim("put ana");

    expect(input.value).toBe("");
    expect(input.getAttribute("placeholder")).toBe("put ana");
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

  // S71-d (R-451, brief docs/agent-briefs/s71-d-mic-shortcut-brief.md §2):
  // the launcher's Ctrl+M reaches this component only through `micRequest`
  // (`CommandLauncher.tsx`'s own counter); `commandLauncher.test.tsx`'s
  // CL-a..CL-e already pin the key itself end to end, so this is the
  // counter prop's own wiring alone -- a mount already carrying a non-zero
  // count acts once (case 1), and each later increment toggles listening
  // the same way a click does (cases 2/3), with a mount at the default `0`
  // doing nothing.
  it("CB-mic-11: a non-zero micRequest at mount starts listening once; further increments toggle it like a click", () => {
    const { recognizer, stop } = makeFakeRecognizer();
    const { rerenderMicRequest } = renderBar({}, null, recognizer, {}, {}, {}, { micRequest: 1 });
    const micButton = screen.getByRole("button", { name: "Speak a sentence" });
    expect(micButton.getAttribute("aria-pressed")).toBe("true");

    rerenderMicRequest(2); // stop, same as CB-mic-5's own click
    expect(stop).toHaveBeenCalledTimes(1);
    expect(micButton.getAttribute("aria-pressed")).toBe("false");

    rerenderMicRequest(3); // start again
    expect(micButton.getAttribute("aria-pressed")).toBe("true");
  });

  it("CB-mic-12: micRequest left at its default (0) never starts listening on its own", () => {
    renderBar({}, null, null);
    // No recognizer at all (default prop), so no button -- proves the
    // effect's own `micRequest === 0` guard did not throw calling
    // `handleMicClick` against a null recogniser either.
    expect(screen.queryByRole("button", { name: "Speak a sentence" })).toBeNull();
  });

  // S71-j (R-454, docs/agent-briefs/s71-j-progress-words-out-of-the-input-
  // brief.md): the maintainer's 23 Sept screenshot -- "Why is it writing the
  // listening and transcribing in the chat box?" -- widened F-206's own fix
  // into a rule with no ref to maintain at all: the recogniser's progress is
  // a separate `onStatus` event now (never routed through `onInterim`), and
  // `onInterim` itself no longer writes into the input's VALUE -- only its
  // placeholder. So the box's value is simply "" or exactly what the person
  // typed, at every point in a session, with nothing left for a second mic
  // press to clean up. CB-mic-13..15 are rewritten to that contract (in
  // place of F-206's now-unnecessary ref); CB-mic-16..19 pin the new
  // `interimHint`/`micPhase` machinery directly.
  it("CB-mic-13: mic on, a partial transcript arrives, mic off -- the box's value stays empty throughout (an interim is never written into the value)", () => {
    const { recognizer, fire } = makeFakeRecognizer();
    const { input } = renderBar({}, null, recognizer);
    const micButton = screen.getByRole("button", { name: "Speak a sentence" });
    fireEvent.click(micButton);

    fire.status("listening");
    fire.interim("put ana");
    expect(input.value).toBe("");

    fireEvent.click(micButton); // stop

    expect(input.value).toBe("");
  });

  it("CB-mic-14: typed text survives an interim arriving and the mic being pressed off -- nothing overwrites or restores it", () => {
    const { recognizer, fire } = makeFakeRecognizer();
    const { input } = renderBar({}, null, recognizer);
    fireEvent.change(input, { target: { value: "clear cell 3" } });

    const micButton = screen.getByRole("button", { name: "Speak a sentence" });
    fireEvent.click(micButton);
    // Under the new contract `onInterim` never touches the value (only the
    // placeholder, CB-mic-17) -- the typed text is untouched the moment the
    // interim arrives, unlike the old (F-206) behaviour this replaces.
    fire.interim("put ana");
    expect(input.value).toBe("clear cell 3");

    fireEvent.click(micButton); // stop

    expect(input.value).toBe("clear cell 3");
  });

  it("CB-mic-15: a real final transcript is unaffected by the placeholder/phase rewrite -- it still empties the box on arrival and stays empty after a later stop", () => {
    const { recognizer, fire } = makeFakeRecognizer();
    const { input } = renderBar({ runs: [] }, null, recognizer);
    const micButton = screen.getByRole("button", { name: "Speak a sentence" });
    fireEvent.click(micButton);

    fire.status("listening");
    fire.interim("put ana");
    fire.final(P1_SENTENCE);
    // R-437: a final result already empties the box on arrival
    // (`submitText`'s own contract, CB-mic-4) -- unrelated to this rewrite,
    // but the session is still "listening" until `onEnd` (CB-mic-8's own
    // doc), so a stop press after a final is exactly the case it must leave
    // alone.
    expect(input.value).toBe("");

    fireEvent.click(micButton); // stop, same button, still listening

    expect(input.value).toBe("");
  });

  it('CB-mic-16: while listening the input value stays "" and the mic label reads "Listening…"', () => {
    const { recognizer, fire } = makeFakeRecognizer();
    const { input } = renderBar({}, null, recognizer);
    const micButton = screen.getByRole("button", { name: "Speak a sentence" });
    fireEvent.click(micButton);

    fire.status("listening");

    expect(input.value).toBe("");
    expect(screen.getByText("Listening…")).toBeTruthy();
  });

  it('CB-mic-17: a partial transcript arrives -- the input value stays "" and its placeholder shows the partial', () => {
    const { recognizer, fire } = makeFakeRecognizer();
    const { input } = renderBar({}, null, recognizer);
    const micButton = screen.getByRole("button", { name: "Speak a sentence" });
    fireEvent.click(micButton);

    fire.status("listening");
    fire.interim("put ana on cell");

    expect(input.value).toBe("");
    expect(input.getAttribute("placeholder")).toBe("put ana on cell");
  });

  it('CB-mic-18: phase "transcribing" shows "Transcribing…" beside the mic', () => {
    const { recognizer, fire } = makeFakeRecognizer();
    renderBar({}, null, recognizer);
    const micButton = screen.getByRole("button", { name: "Speak a sentence" });
    fireEvent.click(micButton);

    fire.status("listening");
    fire.status("transcribing");

    expect(screen.getByText("Transcribing…")).toBeTruthy();
    expect(screen.queryByText("Listening…")).toBeNull();
  });

  it('CB-mic-19: the person had typed "clear" and pressed the mic -- the typed text is untouched by an interim or a status', () => {
    const { recognizer, fire } = makeFakeRecognizer();
    const { input } = renderBar({}, null, recognizer);
    fireEvent.change(input, { target: { value: "clear" } });

    const micButton = screen.getByRole("button", { name: "Speak a sentence" });
    fireEvent.click(micButton);
    fire.status("listening");
    fire.interim("clear cell 3");

    expect(input.value).toBe("clear");
  });

  // R-458 / F-221 (24 Sept, session 191): a mic press no longer clears
  // `status`, whatever it is -- CB-mic-20..22 pin the three shapes the
  // maintainer named: a readout, a refusal, and a one-button question.
  // "Listening…" renders beside the mic button (CB-mic-2's own contract);
  // the readout/refusal/question line stays exactly where it was until the
  // next answer replaces it.
  // F-233, second pass (S194-G2, review fix): CONTRACT CHANGED. This used to
  // leave the FIRST `onOpen` call pending forever (`new Promise(() => {})`)
  // and still expect a fresh spoken final to reach a SECOND `onOpen` call --
  // exactly the shape Finding 1 now holds: a sentence arriving while an
  // earlier write's own outcome is not yet known must wait, so it never
  // resolves against a board that has not caught up. The first write is now
  // let to settle (its own promise resolved, explicitly, mid-test) and the
  // board given a fresh `ctx` (`rerenderCtx`, the same shape a real
  // invalidated refetch produces) before the spoken final is fired -- the
  // readout-stands-while-Listening… behaviour this test is actually about is
  // unchanged; only how the SECOND write becomes reachable is different.
  it("CB-mic-20: a readout stands, mic pressed -- the readout is still rendered while Listening… shows beside the button; a fresh final replaces it", async () => {
    const { recognizer, fire } = makeFakeRecognizer();
    const { onOpen, input, rerenderCtx } = renderBar({ runs: [] }, null, recognizer);
    let resolveFirst: (v: WriteOutcome) => void = () => {};
    onOpen.mockReturnValueOnce(new Promise<WriteOutcome>((r) => (resolveFirst = r)));
    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    const readout = statusText();
    // S196-A (F-239, R-431): CONTRACT CHANGED -- the line that stands while the
    // first write is pending is "Working…", no longer the done-form readout.
    // What this case proves (a standing line is untouched by the mic press,
    // and "Listening…" sits beside it) holds for whatever the line says.
    expect(readout).toBe("Working…");
    expect(screen.queryByText("Listening…")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Speak a sentence" }));

    // The readout is untouched by the press itself.
    expect(statusText()).toBe(readout);
    fire.status("listening");
    // "Listening…" renders beside the button; the readout line is still
    // there too -- neither replaces the other.
    expect(screen.getByText("Listening…")).toBeTruthy();
    expect(statusText()).toBe(readout);

    // The first write settles, and the board catches up with it -- only
    // THEN may a second sentence (the spoken final below) reach a writer.
    // Review fix: `rerenderCtx({ runs: [] })` alone is no longer enough --
    // finding 1's count-based wait (`awaitingRowCountRef`, `CommandBar.tsx`)
    // needs the board to show ONE MORE assignment than it did when the
    // create was dispatched, the same as a real invalidated refetch would.
    // A block at a time P1_SENTENCE's OWN second submission does not also
    // target (its own 10-to-2 slot is what this create is FOR): the
    // just-landed row, never the second sentence's own collision.
    const CREATED_BLOCK: ContextAssignment = {
      ...BLK1,
      id: "created1",
      startMin: 3 * 1440 + 60,
      endMin: 3 * 1440 + 120,
    };
    await act(async () => {
      resolveFirst({ kind: "written" });
      await Promise.resolve();
    });
    rerenderCtx({ runs: [], assignments: [CREATED_BLOCK] });

    // The next answer (a spoken final) replaces it, same as it always did.
    fire.final(P1_SENTENCE);
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it('CB-mic-21: a refusal ("Not done: …") stands, mic pressed -- the refusal is still rendered while Listening… shows', async () => {
    const fetchMock = stubFetch();
    const fakeReader: Reader = vi.fn(async (): Promise<Reading> => ({
      ok: true,
      command: {
        intent: "unassign",
        operator: "everyone",
        place: [],
        day: null,
        span: null,
        existing: null,
        shift: null,
        until: null,
      },
      by: "model",
    }));
    const { recognizer, fire } = makeFakeRecognizer();
    const { input } = renderBar({}, fakeReader, recognizer);

    fireEvent.change(input, { target: { value: "EF76." } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(statusText()).toContain("Not done:");

    fireEvent.click(screen.getByRole("button", { name: "Speak a sentence" }));

    expect(statusText()).toContain("Not done:");
    fire.status("listening");
    expect(screen.getByText("Listening…")).toBeTruthy();
    expect(statusText()).toContain("Not done:");
  });

  it("CB-mic-22: a one-button question stands, mic pressed -- the question and its button are still rendered while Listening… shows; the press still writes", async () => {
    const parsedBook = parseCommand(BOOK_SENTENCE);
    expect(parsedBook.ok).toBe(true);
    if (!parsedBook.ok) return;
    const fakeReader: Reader = vi.fn(async (): Promise<Reading> => ({
      ok: true,
      command: parsedBook.command,
      by: "model",
    }));
    const { recognizer, fire } = makeFakeRecognizer();
    const { onBook, input } = renderBar({ runs: [] }, fakeReader, recognizer);
    const heard = "Housing A on Cell 1 in Line 1 from 6 to 2";

    fireEvent.change(input, { target: { value: heard } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(candidateButtons()).toHaveLength(1));
    const question = statusText();

    fireEvent.click(screen.getByRole("button", { name: "Speak a sentence" }));

    expect(statusText()).toBe(question);
    expect(candidateButtons()).toHaveLength(1);
    fire.status("listening");
    expect(screen.getByText("Listening…")).toBeTruthy();
    expect(statusText()).toBe(question);

    fireEvent.click(candidateButtons()[0]);
    await waitFor(() => expect(onBook).toHaveBeenCalledTimes(1));
  });

  // Reviewer fix (R-455 / F-221, 24 Sept session 191): the maintainer's own
  // named shapes (CB-mic-20..22) cover a readout, a refusal and a one-button
  // question -- "Reading…" (an in-flight model read) is a FOURTH standing
  // shape, and a mic press does something none of the other three do: it
  // ABORTS the read outright (`startListening`'s own "press when idle aborts
  // any in-flight reading" branch, pre-existing) rather than merely leaving
  // it be. The rule still holds -- the status line itself is untouched.
  it('CB-mic-23: "Reading…" stands (an in-flight model read), mic pressed -- the read is aborted but the status line is untouched; a fresh final replaces it', () => {
    const pendingReader: Reader = vi.fn(() => new Promise<Reading>(() => {}));
    const { recognizer, fire } = makeFakeRecognizer();
    const { input } = renderBar({}, pendingReader, recognizer);

    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(statusText()).toBe("Reading…");

    fireEvent.click(screen.getByRole("button", { name: "Speak a sentence" }));
    expect(statusText()).toBe("Reading…");
    fire.status("listening");
    expect(screen.getByText("Listening…")).toBeTruthy();
    expect(statusText()).toBe("Reading…");

    // The aborted read can never itself land now (`readingSeqRef`'s own
    // guard) -- only the spoken final that follows replaces the line.
    fire.final(P1_SENTENCE);
    expect(threadText()).not.toBe("");
  });

  // The mic button's SECOND press (a stop) is the other half of R-458's own
  // rule -- `stopListening`'s own doc already promised this; pinned here
  // against the SAME three shapes CB-mic-20..22 cover, for the stop half.
  it('CB-mic-24: a mic STOP (second press) leaves the standing status untouched -- only "Listening…" disappears', () => {
    const { recognizer, fire } = makeFakeRecognizer();
    const { onOpen, input } = renderBar({ runs: [] }, null, recognizer);
    onOpen.mockReturnValue(new Promise(() => {})); // held pending -- readout stays live
    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    const readout = statusText();

    fireEvent.click(screen.getByRole("button", { name: "Speak a sentence" }));
    fire.status("listening");
    expect(screen.getByText("Listening…")).toBeTruthy();
    expect(statusText()).toBe(readout);

    fireEvent.click(screen.getByRole("button", { name: "Speak a sentence" }));
    expect(screen.queryByText("Listening…")).toBeNull();
    expect(statusText()).toBe(readout);
  });

  // The Ctrl+M path (`micRequest`) reaches the same `handleMicClick` a real
  // press does (this file's own header doc for the effect) -- pinned once,
  // directly, rather than assumed from CB-mic-20's own click-based coverage.
  it("CB-mic-25: Ctrl+M (micRequest) starting a session leaves the standing status untouched, same as a direct press", () => {
    const { recognizer, fire } = makeFakeRecognizer();
    const { onOpen, input, rerenderMicRequest } = renderBar(
      { runs: [] },
      null,
      recognizer,
      {},
      {},
      {},
      { micRequest: 0 },
    );
    onOpen.mockReturnValue(new Promise(() => {}));
    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    const readout = statusText();

    rerenderMicRequest(1);
    fire.status("listening");
    expect(screen.getByText("Listening…")).toBeTruthy();
    expect(statusText()).toBe(readout);
  });
});

// S71-j review: F-206's own two reproductions, re-run against the new
// interimHint/micPhase contract rather than the retired lastInterimTextRef --
// a stop must still leave the placeholder reading the ordinary default, not
// a stale status word or a stale partial transcript.
describe("S71-j review", () => {
  it("mic on, stop before any transcript -- the input is empty and the placeholder is back to the default", () => {
    const { recognizer, fire } = makeFakeRecognizer();
    const { input } = renderBar({}, null, recognizer);
    const micButton = screen.getByRole("button", { name: "Speak a sentence" });
    fireEvent.click(micButton);

    fire.status("listening");

    fireEvent.click(micButton); // stop, before any interim or final

    expect(input.value).toBe("");
    expect(input.getAttribute("placeholder")).toBe(
      "Assign Sam to Housing A on Cell 1 in Line 1 from 10 to 2",
    );
  });

  it("mic on, a partial transcript arrives, stop -- the placeholder is back to the default, not the stale partial", () => {
    const { recognizer, fire } = makeFakeRecognizer();
    const { input } = renderBar({}, null, recognizer);
    const micButton = screen.getByRole("button", { name: "Speak a sentence" });
    fireEvent.click(micButton);

    fire.status("listening");
    fire.interim("clear cel");
    expect(input.getAttribute("placeholder")).toBe("clear cel");

    fireEvent.click(micButton); // stop

    expect(input.value).toBe("");
    expect(input.getAttribute("placeholder")).toBe(
      "Assign Sam to Housing A on Cell 1 in Line 1 from 10 to 2",
    );
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
      expect(statusText()).toMatch(/^Ready to do 2 things: /);

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
    expect(statusText()).toMatch(/^Ready to do 2 things: /);

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

  // R-455 / F-219 (24 Sept, session 191) -- CONTRACT CHANGED (CLAUDE.md §4):
  // CB-showday-1..2 used to pin a "Show that day" button and a press. There
  // is no press any more -- Enter alone moves the board (a "Moved the board
  // to …" readout, `onShowDay` called immediately) -- CB-showday-1
  // rewritten below pins the move itself; CB-showday-2 (the button's own
  // presence test) is gone, folded into CB-showday-1 (there is no button
  // left to test for).
  it("CB-showday-1: a day_off_board sentence moves the board immediately -- a 'Moved the board to …' readout, onShowDay called with no press, no button", () => {
    const ambiguous = renderBar();
    fireEvent.change(ambiguous.input, {
      target: { value: "assign Sam to Housing A on Cell 1 in Line 1 from 10 to 2" },
    });
    fireEvent.keyDown(ambiguous.input, { key: "Enter" });
    expect(statusText()).toBe('Which person? "Sam" matches 2:');
    expect(ambiguous.onShowDay).not.toHaveBeenCalled();
    cleanup();

    const { input, onShowDay } = renderBar({ todayIndex: 0 });
    fireEvent.change(input, { target: { value: YESTERDAY_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    // CP-5 (CLAUDE.md §4): the readout files into the thread the same tick
    // it is set (`traceQuestionStatus`'s own readout branch finishes the
    // trace, which clears `status`/`sentence` back to idle) -- so it reads
    // from `threadText()`, not the now-empty live `statusText()`.
    expect(statusText()).toBe("");
    expect(threadText()).toContain("Moved the board to yesterday.");
    expect(onShowDay).toHaveBeenCalledWith("yesterday");
    expect(screen.queryByRole("button", { name: "Show that day" })).toBeNull();
  });

  it("CB-showday-2: onShowDay is called with the target verbatim -- yesterday, Friday and an ISO date -- as soon as Enter is pressed", () => {
    const yesterday = renderBar({ todayIndex: 0 });
    fireEvent.change(yesterday.input, { target: { value: YESTERDAY_SENTENCE } });
    fireEvent.keyDown(yesterday.input, { key: "Enter" });
    expect(yesterday.onShowDay).toHaveBeenCalledWith("yesterday");
    cleanup();

    const friday = renderBar({ days: MON_WED_DAYS, todayIndex: 0 });
    fireEvent.change(friday.input, { target: { value: FRIDAY_SENTENCE } });
    fireEvent.keyDown(friday.input, { key: "Enter" });
    expect(friday.onShowDay).toHaveBeenCalledWith("friday");
    cleanup();

    const date = renderBar();
    fireEvent.change(date.input, { target: { value: FAR_DATE_SENTENCE } });
    fireEvent.keyDown(date.input, { key: "Enter" });
    expect(date.onShowDay).toHaveBeenCalledWith("2026-09-25");
  });

  it("CB-showday-3: the rerun happens once the new ctx arrives -- not before, and against the NEW ctx, not the old one", () => {
    const { input, onOpen, rerenderCtx } = renderBar({ todayIndex: 0 });
    fireEvent.change(input, { target: { value: YESTERDAY_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

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

    fireEvent.change(input, { target: { value: "no" } });
    fireEvent.keyDown(input, { key: "Enter" });

    rerenderCtx({ days: SHIFTED_BACK_ONE_DAY, todayIndex: 1 });

    expect(onOpen).not.toHaveBeenCalled();
  });

  it("CB-showday-5: Escape drops the pending rerun", () => {
    const { input, onOpen, rerenderCtx } = renderBar({ todayIndex: 0 });
    fireEvent.change(input, { target: { value: YESTERDAY_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

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

    // An irrelevant ctx change -- a fresh object, same days, "yesterday"
    // still off the board -- must not consume the pending rerun. The turn
    // the "Moved the board …" readout already filed (CP-5) is untouched --
    // nothing here re-asks or re-writes it.
    rerenderCtx({ todayIndex: 0 });
    expect(onOpen).not.toHaveBeenCalled();
    expect(threadText()).toContain("Moved the board to yesterday.");

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
    const { input, onShowDay, rerenderCtx } = renderBar();
    fireEvent.change(input, { target: { value: "copy this week to next week" } });
    fireEvent.keyDown(input, { key: "Enter" });
    // CP-5 (CLAUDE.md §4): filed into the thread the instant it is set.
    expect(threadText()).toContain("Moved the board to Mon Sep 7.");
    expect(onShowDay).toHaveBeenCalledWith("2026-09-07");

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
    expect(threadText()).toContain("Moved the board to Mon Sep 7.");

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

  it("CB-showday-8 (F-158): a REPEAT day whose week is off the board names the week -- onShowDay gets the week word with no press, and the rerun waits for all seven days of that week", () => {
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
    // CP-5 (CLAUDE.md §4): filed into the thread the instant it is set.
    expect(threadText()).toContain("Moved the board to this week.");
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
    expect(threadText()).toContain("Moved the board to this week.");

    // The whole week: the held sentence re-runs and becomes the lot of five
    // (Monday to Friday) CB-y-2 pins -- the count is unchanged by F-158.
    rerenderCtx({
      days: [...monToSat, { index: 6, iso: "2026-09-06", weekday: 0 as const }],
      todayIndex: 0,
    });
    expect(statusText()).toMatch(/^Ready to do 5 things: /);
    expect(screen.queryByRole("button", { name: "Show that day" })).toBeNull();
    expect(onOpen).not.toHaveBeenCalled(); // a lot waits for its own yes
  });

  // R-455 / F-219 (b) (24 Sept, session 191): `ctx.settled` gates the rerun
  // exactly like `isTargetOnBoard` -- a ctx whose `days` axis already names
  // the target but whose `assignments`/`runs` are still the PREVIOUS
  // window's (`keepPreviousData`, `settled: false` while `BoardPage`'s own
  // fetch is in flight) must not fire the rerun; the next ctx, `settled:
  // true`, does. This is the race that told the maintainer "Maria Lopez has
  // no block Thu Sep 24" when she had one.
  it("CB-showday-9: the rerun does NOT fire on a ctx with settled: false even when the day is on it, and fires on the next ctx with settled: true", () => {
    const { input, onOpen, rerenderCtx } = renderBar({ todayIndex: 0 });
    fireEvent.change(input, { target: { value: YESTERDAY_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpen).not.toHaveBeenCalled();

    // The window's `days` axis already carries "yesterday" (index 0), but
    // the ctx is still the STALE window's rows under the new axis --
    // `settled: false`. The rerun must not consume `pendingRerunRef` here.
    rerenderCtx({ days: SHIFTED_BACK_ONE_DAY, todayIndex: 1, settled: false });
    expect(onOpen).not.toHaveBeenCalled();

    // The same axis, now genuinely settled -- the rerun fires exactly once.
    rerenderCtx({ days: SHIFTED_BACK_ONE_DAY, todayIndex: 1, settled: true });
    expect(onOpen).toHaveBeenCalledTimes(1);
    const [resolved] = onOpen.mock.calls[0] as [ResolvedCommand, { x: number; y: number }];
    expect(resolved.operatorId).toBe("op1");
  });

  // Reviewer fix (R-455 / F-219, 24 Sept session 191): a window whose new
  // ctx never arrives with the target on it (a query that errors, or any
  // other way the effect above never fires) used to leave `pendingRerunRef`
  // standing forever -- no readout, no refusal, the "Moved the board …" turn
  // never getting a second word. `armPendingRerun`'s own timeout bounds it.
  it("CB-showday-10: a rerun that never gets a settled ctx times out with a refusal, not a silent hang", () => {
    vi.useFakeTimers();
    try {
      const fetchMock = stubFetch();
      const { input } = renderBar({ todayIndex: 0 });
      act(() => {
        fireEvent.change(input, { target: { value: YESTERDAY_SENTENCE } });
        fireEvent.keyDown(input, { key: "Enter" });
      });
      expect(threadText()).toContain("Moved the board to yesterday.");
      expect(fetchMock).not.toHaveBeenCalled();

      // No ctx ever arrives with "yesterday" on it -- advance past the bound.
      act(() => {
        vi.advanceTimersByTime(15000);
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const entry = postedEntry(fetchMock);
      expect(entry.asked).toBe("Moved the board to yesterday.");
      expect(entry.answered).toBe("auto");
      expect(entry.outcome).toBe("refused: Could not load yesterday.");
      expect(threadText()).toContain("Not done: Could not load yesterday.");
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  // A cancel word before the timeout disarms it -- the stale timer must not
  // fire a SECOND, orphaned refusal after the sentence that dropped it has
  // already moved on.
  it("CB-showday-11: a cancel word before the timeout disarms it -- no orphaned refusal later", () => {
    vi.useFakeTimers();
    try {
      const fetchMock = stubFetch();
      const { input } = renderBar({ todayIndex: 0 });
      act(() => {
        fireEvent.change(input, { target: { value: YESTERDAY_SENTENCE } });
        fireEvent.keyDown(input, { key: "Enter" });
      });
      act(() => {
        fireEvent.change(input, { target: { value: "no" } });
        fireEvent.keyDown(input, { key: "Enter" });
      });
      const postedBeforeTimeout = fetchMock.mock.calls.length;

      act(() => {
        vi.advanceTimersByTime(15000);
      });

      // The timer armed for the dropped rerun must not have posted anything
      // new -- whatever "no" itself already posted is untouched.
      expect(fetchMock.mock.calls.length).toBe(postedBeforeTimeout);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  // Reviewer fix (R-455): `ctx.settled` gates the REROUN effect only --
  // resolve.ts never reads it (this module's own doc), so an UNRELATED
  // ordinary sentence submitted while the ctx happens to be mid-refetch
  // (`settled: false`, a plain background refetch of the SAME window, not a
  // move) must resolve and write exactly as it always would.
  it("CB-showday-12: settled: false blocks only the pending rerun, never an ordinary NEW sentence", () => {
    const { input, onOpen, rerenderCtx } = renderBar({ todayIndex: 3 });
    // A background refetch of the SAME window lands -- days/todayIndex
    // unchanged, just not yet settled (exactly `BoardPage`'s own shape for
    // "the current window is revalidating").
    rerenderCtx({ settled: false });
    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

/**
 * F-233 (S194-G): the fix, at the level that actually matters -- a sentence
 * submitted while `hasPendingCreate` is true (a placeholder row's own
 * create still in flight) is held, resolves NOTHING yet (no question, no
 * write), and reruns the instant `hasPendingCreate` turns false, landing on
 * whatever the ctx says then. Deliberately a DIFFERENT prop from
 * `ctx.settled` -- CB-showday-12 just above pins that `settled` must never
 * gate an ordinary sentence; this describe block is the proof that
 * `hasPendingCreate` is not the same flag reused, but its own, read only by
 * this new wait.
 */
describe("F-233: a sentence held while a placeholder row's own create is in flight", () => {
  it("a removal said while hasPendingCreate is true asks nothing yet, and reruns once it turns false", () => {
    const { input, onUnassign, rerenderPendingCreate } = renderBar(
      { assignments: [BLK1] },
      null,
      null,
      {},
      {},
      {},
      {},
      { hasPendingCreate: true },
    );
    fireEvent.change(input, { target: { value: UNASSIGN_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    // Held: no question stands, nothing was written.
    expect(screen.queryByRole("button", { name: "Remove it" })).toBeNull();
    expect(onUnassign).not.toHaveBeenCalled();

    // The placeholder resolves -- `BoardPage` would rebuild `index`/`ctx`
    // and flip `hasPendingCreate` to `false` in the same render; this
    // simulates exactly that (the SAME `ctx` shape, `hasPendingCreate` the
    // only thing that changed).
    rerenderPendingCreate({ assignments: [BLK1] }, false);

    // The held sentence has now run: the question it should always have
    // asked stands.
    expect(screen.getByRole("button", { name: "Remove it" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    expect(onUnassign).toHaveBeenCalledTimes(1);
    const [resolved] = onUnassign.mock.calls[0] as [ResolvedUnassign, { x: number; y: number }];
    expect(resolved.assignmentId).toBe("blk1");
  });

  it("a sentence submitted while hasPendingCreate is false (the ordinary case) is never held", () => {
    const { input, onOpen } = renderBar(
      {},
      null,
      null,
      {},
      {},
      {},
      {},
      { hasPendingCreate: false },
    );
    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

/**
 * F-233, second pass (S194-G2): docs/agent-briefs/s194-g2-the-hold-brief.md.
 * The reviewer's own repro -- the bar answering "Cell 1 has nobody on it"
 * over a block just placed -- traced to `hasPendingCreate` being derived
 * PURELY from the query cache (`hasPendingPlaceholder`), which has a real
 * gap on each side of a create's own life: before `onMutate`'s awaited
 * `cancelQueries` has written the placeholder, and after the write settles
 * but before the invalidated refetch has landed. This describe block proves
 * the fix at the unit level; `e2e/typedWalk.spec.ts`'s own throttled spec
 * proves it end to end, ten times at two different delays (the brief's own
 * proving step).
 */
describe("F-233, second pass: the bar's own write count, not just the cache", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Finding 1 (the cause): a plain, synchronous write dispatched by the bar
  // itself sets `barWritesInFlightRef` up BEFORE any await -- so a second
  // sentence submitted in the same tick a write is dispatched, well before
  // any cache-derived signal could ever see it, is still held. This is the
  // gap the cache-only signal (S194-G, first pass) could not close: nothing
  // about `hasPendingPlaceholder` changes until `onMutate` itself has run,
  // which for a REAL mutation is always at least one microtask away.
  it("holds a second sentence submitted in the SAME tick as the first write, before any cache signal could exist", () => {
    // An empty board (`runs: []`, unchanged by either write -- these mocks
    // do not actually mutate `ctx`): P1_SENTENCE writes straight through
    // (C2's own ctx, above) and, said again against the SAME still-empty
    // slot, would write straight through a second time too -- UNLESS it is
    // held.
    const { input, onOpen } = renderBar({ runs: [] });
    act(() => {
      fireEvent.change(input, { target: { value: P1_SENTENCE } });
      fireEvent.keyDown(input, { key: "Enter" });
    });
    // This file's own default writer mocks answer SYNCHRONOUSLY
    // (`mockReturnValue(WRITTEN)`, not a Promise) -- so by the time control
    // returns here, P1's own write has already run AND settled in the same
    // tick, and `barWritesInFlightRef` has already moved on to
    // `barWritesAwaitingCtxRef` (`barWriteSettled`, `CommandBar.tsx`),
    // which `writesStillSettling()` counts exactly the same as "in flight".
    // A sentence said right now is still held -- the board has not been
    // handed a fresh `ctx` reflecting this write yet.
    expect(onOpen).toHaveBeenCalledTimes(1);
    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    // Held, not a second write: the count stays at one.
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  // Proving item 3: "a create that fails while a sentence is held (the
  // sentence then runs against the board without the row, which is now the
  // truth)". A refused create never grows `ctx`'s own counts -- the review
  // fix (`popupReporterFor`, `CommandBar.tsx`) drops `awaitingRowCountRef`'s
  // own count-based wait for a refusal, falling back to the plain "a
  // genuinely new ctx" wait every other write already uses, so the held
  // sentence still drains once the board is simply told the create did not
  // happen -- never stuck waiting forever for a row that is never coming.
  it("a create that fails while a sentence is held: the held sentence still runs, against a board without the row", () => {
    const CREATE_SENTENCE = "Assign Operator 1 to Housing A on Cell 1 in Line 1 from 6 to 8";
    const { input, onOpen, onUnassign, rerenderCtx } = renderBar({ assignments: [BLK1] });
    let capturedReport: ((result: { kind: "refused"; message: string }) => void) | null = null;
    onOpen.mockImplementationOnce(
      (..._args: unknown[]): { kind: "popup"; waitingFor: string; standing: false } => {
        capturedReport = _args[2] as (result: { kind: "refused"; message: string }) => void;
        return { kind: "popup", waitingFor: "the create pop-up", standing: false };
      },
    );

    fireEvent.change(input, { target: { value: CREATE_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledTimes(1);

    fireEvent.change(input, { target: { value: UNASSIGN_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.queryByRole("button", { name: "Remove it" })).toBeNull();

    // The create pop-up REFUSES -- nothing was written, and never will be.
    act(() => {
      capturedReport?.({ kind: "refused", message: "Something went wrong." });
    });
    expect(screen.queryByRole("button", { name: "Remove it" })).toBeNull();

    // The board catches up with the REFUSAL (still just BLK1 -- no row
    // landed, correctly, since none was ever written). A genuinely new
    // `ctx` reference is enough now: the held sentence is not stuck waiting
    // for a row that will never come.
    rerenderCtx({ assignments: [BLK1] });

    expect(screen.getByRole("button", { name: "Remove it" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    expect(onUnassign).toHaveBeenCalledTimes(1);
  });

  /**
   * Proving item 1/4 (the id-based check itself, `awaitingRowIdRef`,
   * `CommandBar.tsx`): S194-G3 REPLACED the count proxy entirely (found
   * broken on the real app: `awaitingRowCountRef`'s own count moved for the
   * wrong reasons, and worse, `dropHeldQueue` never cleared it, leaking a
   * stale wait into every write after the first create for the rest of the
   * session). This test used to prove a COUNT that grew was enough; it now
   * proves the exact THING the brief asked for -- a `ctx` that is a
   * genuinely new reference (passes `lastDrainedCtxRef`'s own check) and
   * even shows ONE MORE assignment than before (a count-based check would
   * have released the hold right here) but NOT the specific row the create
   * actually answered with its own id must still not release it; only a
   * later `ctx` that actually contains THAT id does. Mutation-tested:
   * comparing by count instead of id (`CommandBar.tsx`) turns this red.
   */
  it("a genuinely NEW ctx with a grown count but not the answered id does not release the hold", () => {
    const { input, onOpen, onUnassign, rerenderCtx } = renderBar({ assignments: [BLK1] });
    let capturedReport: ((result: { kind: "written"; id?: string }) => void) | null = null;
    onOpen.mockImplementationOnce(
      (..._args: unknown[]): { kind: "popup"; waitingFor: string; standing: false } => {
        capturedReport = _args[2] as (result: { kind: "written"; id?: string }) => void;
        return { kind: "popup", waitingFor: "the create pop-up", standing: false };
      },
    );
    const CREATE_SENTENCE = "Assign Operator 1 to Housing A on Cell 1 in Line 1 from 6 to 8";

    fireEvent.change(input, { target: { value: CREATE_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledTimes(1);

    fireEvent.change(input, { target: { value: UNASSIGN_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.queryByRole("button", { name: "Remove it" })).toBeNull();

    act(() => {
      capturedReport?.({ kind: "written", id: "created-assignment-1" });
    });

    // A brand new `ctx` reference, with a DIFFERENT, unrelated row added
    // (Sam Patel's own, at a time that does not collide) -- the count grew
    // by one, exactly what the old proxy would have accepted, but the id
    // this create actually answered with is not among them: someone else's
    // row landed in the same refetch, not this one's.
    const UNRELATED: ContextAssignment = { ...BLK1, id: "unrelated-row", operatorId: "sp" };
    rerenderCtx({ assignments: [BLK1, UNRELATED] });
    expect(screen.queryByRole("button", { name: "Remove it" })).toBeNull();
    expect(onUnassign).not.toHaveBeenCalled();

    // A LATER ctx that actually contains the answered id releases it.
    const LANDED: ContextAssignment = { ...BLK1, id: "created-assignment-1", operatorId: "lin" };
    rerenderCtx({ assignments: [BLK1, UNRELATED, LANDED] });
    expect(screen.getByRole("button", { name: "Remove it" })).toBeTruthy();
  });

  // Finding 4: the trace entry is posted the instant a sentence is held
  // (DEF-0049's own shape, `postTrace`'s own doc, commandConversation.ts) --
  // not only once it finally resolves.
  it("posts the held sentence's own entry at once, saying it was heard and held", () => {
    const fetchMock = stubFetch();
    const { input } = renderBar(
      { assignments: [BLK1] },
      null,
      null,
      {},
      {},
      {},
      {},
      { hasPendingCreate: true },
    );
    fireEvent.change(input, { target: { value: UNASSIGN_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const entry = postedEntry(fetchMock);
    expect(entry.heard).toBe(UNASSIGN_SENTENCE);
    expect(entry.outcome).toBe("popup: the board to finish saving your last change");
  });

  // Finding 4, the teardown half: a page closed while a sentence is held
  // must not leave an entry with no outcome at all -- `flushTraceOnTeardown`
  // (F-157) reads whatever `postTrace` above already wrote into the entry.
  it("a page closed during the hold flushes an entry saying held, not one with no outcome", () => {
    const fetchMock = stubFetch();
    const { input, unmount } = renderBar(
      { assignments: [BLK1] },
      null,
      null,
      {},
      {},
      {},
      {},
      { hasPendingCreate: true },
    );
    fireEvent.change(input, { target: { value: UNASSIGN_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    fetchMock.mockClear();

    unmount();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const entry = postedEntry(fetchMock);
    expect(entry.outcome).toBe("popup: the board to finish saving your last change");
    expect(entry.heard).toBe(UNASSIGN_SENTENCE);
  });

  // Finding 2: a QUEUE, not a single slot -- three sentences held in a row
  // all run, in the order they were heard, each to its own writer, none
  // dropped for a later one.
  it("keeps THREE held sentences and runs each in its own turn, in order, as the board catches up one write at a time", () => {
    // A SECOND assign, 6am-8am -- P1_SENTENCE's own slot (10 to 2) is
    // BLK1's own, so a straight write needs a time that does not collide
    // with the block UNASSIGN/MOVE both need present.
    const P1_OFF_HOURS_SENTENCE = "Assign Operator 1 to Housing A on Cell 1 in Line 1 from 6 to 8";
    const { input, onUnassign, onOpen, onMove, rerenderPendingCreate } = renderBar(
      { assignments: [BLK1] },
      null,
      null,
      {},
      {},
      {},
      {},
      { hasPendingCreate: true },
    );

    fireEvent.change(input, { target: { value: UNASSIGN_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: P1_OFF_HOURS_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: MOVE_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onUnassign).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
    expect(onMove).not.toHaveBeenCalled();

    // The board catches up once -- only the FIRST (UNASSIGN, a question)
    // drains; a standing question stops the queue (F-162, unchanged), so
    // the other two are still waiting.
    rerenderPendingCreate({ assignments: [BLK1] }, false);
    expect(screen.getByRole("button", { name: "Remove it" })).toBeTruthy();
    expect(onOpen).not.toHaveBeenCalled();
    expect(onMove).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    expect(onUnassign).toHaveBeenCalledTimes(1);

    // The board catches up a second time (this write's own settle) -- P1
    // (a write straight through) drains next.
    rerenderPendingCreate({ assignments: [BLK1] }, false);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onMove).not.toHaveBeenCalled();

    // A third catch-up drains MOVE, the last one. Review fix: P1's own
    // create needs the board to show ONE MORE assignment than it did when
    // it was dispatched (`awaitingRowCountRef`, `CommandBar.tsx`) -- BLK1
    // stays (MOVE still needs it, uniquely -- the created row uses a
    // DIFFERENT operator, "sp", so it never becomes a second candidate for
    // "Operator 1's block on Cell 1").
    const P1_CREATED_BLOCK: ContextAssignment = {
      ...BLK1,
      id: "p1created",
      operatorId: "sp",
      startMin: 3 * 1440 + 360,
      endMin: 3 * 1440 + 480,
    };
    rerenderPendingCreate({ assignments: [BLK1, P1_CREATED_BLOCK] }, false);
    expect(onMove).toHaveBeenCalledTimes(1);

    expect(onUnassign.mock.invocationCallOrder[0]).toBeLessThan(onOpen.mock.invocationCallOrder[0]);
    expect(onOpen.mock.invocationCallOrder[0]).toBeLessThan(onMove.mock.invocationCallOrder[0]);
  });

  // Finding 3: Escape drops EVERY held sentence, not just the most recent
  // one -- none of the three below ever reaches its own writer.
  it("Escape drops every sentence in a multi-item queue, not only the last one held", () => {
    const { input, onUnassign, onOpen, onMove, rerenderPendingCreate } = renderBar(
      { assignments: [BLK1] },
      null,
      null,
      {},
      {},
      {},
      {},
      { hasPendingCreate: true },
    );

    fireEvent.change(input, { target: { value: UNASSIGN_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: MOVE_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    fireEvent.keyDown(input, { key: "Escape" });

    rerenderPendingCreate({ assignments: [BLK1] }, false);

    expect(onUnassign).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
    expect(onMove).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Remove it" })).toBeNull();
  });

  // A typed "yes"/"no" while something is held and nothing is standing is
  // NOT an answer to anything -- CB-yes-8's own existing rule -- and does
  // NOT drop the held sentence (only Escape/a cancel word do, finding 3).
  it("a typed 'no' while a sentence is held answers nothing and does not drop the hold", () => {
    const { input, onUnassign, rerenderPendingCreate } = renderBar(
      { assignments: [BLK1] },
      null,
      null,
      {},
      {},
      {},
      {},
      { hasPendingCreate: true },
    );
    fireEvent.change(input, { target: { value: UNASSIGN_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    fireEvent.change(input, { target: { value: "no" } });
    fireEvent.keyDown(input, { key: "Enter" });

    rerenderPendingCreate({ assignments: [BLK1] }, false);
    expect(screen.getByRole("button", { name: "Remove it" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    expect(onUnassign).toHaveBeenCalledTimes(1);
  });

  // Past the bound: a sentence still held five seconds after the FIRST one
  // was held is refused with the exact sentence the brief gives, never
  // resolved against a board that may still be missing what it is about.
  it("past the five-second bound, every held sentence is refused with the exact sentence, never resolved", () => {
    vi.useFakeTimers();
    try {
      const fetchMock = stubFetch();
      const { input, onUnassign, onOpen } = renderBar(
        { assignments: [BLK1] },
        null,
        null,
        {},
        {},
        {},
        {},
        { hasPendingCreate: true },
      );
      act(() => {
        fireEvent.change(input, { target: { value: UNASSIGN_SENTENCE } });
        fireEvent.keyDown(input, { key: "Enter" });
      });
      act(() => {
        fireEvent.change(input, { target: { value: P1_SENTENCE } });
        fireEvent.keyDown(input, { key: "Enter" });
      });

      act(() => {
        vi.advanceTimersByTime(5000);
      });

      expect(onUnassign).not.toHaveBeenCalled();
      expect(onOpen).not.toHaveBeenCalled();
      expect(
        threadText().includes(
          "The board is still saving your last change. Say it again in a moment.",
        ) ||
          (document.querySelector('[class*="statusLine"]')?.textContent ?? "").includes(
            "The board is still saving your last change. Say it again in a moment.",
          ),
      ).toBe(true);
      const entries = fetchMock.mock.calls.map((call) => {
        const [, init] = call as [string, RequestInit];
        return JSON.parse(init.body as string) as TraceEntry;
      });
      // `TraceEntry.revises`' own rule: take the LAST line for a given
      // `at`/`heard` -- the hold posts once at once (Finding 4) and again
      // when the bound corrects it, same `heard`, so the FIRST match would
      // still be the stale "popup: …" line, not the bound's own refusal.
      const unassignEntry = entries.filter((e) => e.heard === UNASSIGN_SENTENCE).at(-1);
      const p1Entry = entries.filter((e) => e.heard === P1_SENTENCE).at(-1);
      expect(unassignEntry?.outcome).toBe(
        "refused: The board is still saving your last change. Say it again in a moment.",
      );
      expect(p1Entry?.outcome).toBe(
        "refused: The board is still saving your last change. Say it again in a moment.",
      );
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  // The bound starts when the FIRST sentence is held, and a LATER hold does
  // not restart it -- so the second sentence, held only three seconds
  // before the bound fires, is refused at the SAME moment as the first,
  // two seconds early by its own clock.
  it("the bound starts at the FIRST hold and is not restarted by a later one", () => {
    vi.useFakeTimers();
    try {
      const { input, onUnassign, onOpen } = renderBar(
        { assignments: [BLK1] },
        null,
        null,
        {},
        {},
        {},
        {},
        { hasPendingCreate: true },
      );
      act(() => {
        fireEvent.change(input, { target: { value: UNASSIGN_SENTENCE } });
        fireEvent.keyDown(input, { key: "Enter" });
      });
      act(() => {
        vi.advanceTimersByTime(3000);
      });
      act(() => {
        fireEvent.change(input, { target: { value: P1_SENTENCE } });
        fireEvent.keyDown(input, { key: "Enter" });
      });
      // 2000ms more -- 5000ms since the FIRST hold, only 2000ms since the
      // second. A restarted bound would still be waiting on the second.
      act(() => {
        vi.advanceTimersByTime(2000);
      });

      expect(onUnassign).not.toHaveBeenCalled();
      expect(onOpen).not.toHaveBeenCalled();
      expect(
        threadText().includes(
          "The board is still saving your last change. Say it again in a moment.",
        ),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  /**
   * F-233, second pass, REVIEW FIX -- THE CAUSE, PROVED. Found by the
   * reviewer's own e2e reproduction ("Cell 1 has nobody on it" over a block
   * just placed) surviving the first version of this pass's fix, on a
   * genuinely clean run (no other work sharing the machine) -- so it was not
   * the resource contention it first looked like.
   *
   * The `[ctx, hasPendingCreate]` effect (`CommandBar.tsx`) fires whenever
   * EITHER dependency changes, and used to clear `barWritesAwaitingCtxRef`
   * unconditionally, using whatever `ctx` that render happened to carry. But
   * `hasPendingCreate`'s OWN fallback half (`pendingCreateSnapshot`,
   * `optimisticId.ts`) is a SEPARATE `useSyncExternalStore` subscription from
   * the query `ctx`/`commandCtx` is built from -- the two can notify React on
   * different ticks, so a render exists where `hasPendingCreate` has already
   * flipped false (the mutation's own `onSettled` ran) but `ctx` is STILL the
   * stale, pre-write reference (the board's own re-render, from the SAME
   * query's data changing, has not landed yet). This test builds exactly
   * that render by hand: a `ctx` that never changes reference across the
   * whole test, and `hasPendingCreate` toggled independently of it -- the
   * shape `renderBar`'s own `rerenderPendingCreate` CANNOT produce, since it
   * rebuilds a fresh `ctx` (via `buildCtx`) on every call, hiding this exact
   * gap.
   *
   * RED before the fix: the old code read `if (ctx !== null) { barWritesAwaitingCtxRef.current
   * = 0; drainHeldQueue(); }` inside the effect with no memory of which `ctx`
   * it had last acted on, so the `hasPendingCreate`-only render below drained
   * the held sentence against the SAME stale `ctx` — this test's own final
   * assertion (`onUnassign` still uncalled) failed. GREEN after: `CommandBar.tsx`'s
   * `lastDrainedCtxRef` remembers which `ctx` reference the effect has
   * already cleared the wait for, and only a GENUINELY NEW one (a reference
   * this ref has not seen) may clear it again.
   */
  it("finding 1, the cause: hasPendingCreate flipping ALONE must not clear the wait against a STALE ctx", () => {
    // BLK1 present -- UNASSIGN_SENTENCE (10 to 2) needs it there to ask its
    // own "Remove it" question, the observable this test actually reads.
    // The create sentence below targets 6 to 8 on the SAME cell instead of
    // P1_SENTENCE's own 10-to-2 (BLK1's own slot), so the two never collide.
    const fixedCtx = buildCtx({ assignments: [BLK1] });
    const CREATE_SENTENCE = "Assign Operator 1 to Housing A on Cell 1 in Line 1 from 6 to 8";
    let capturedReport: ((result: { kind: "written" }) => void) | null = null;
    const onOpen = vi.fn(
      (_resolved: unknown, _anchor: unknown, report: (result: { kind: "written" }) => void) => {
        capturedReport = report;
        return { kind: "popup", waitingFor: "the create pop-up", standing: false } as const;
      },
    );
    const onUnassign = vi.fn().mockReturnValue(WRITTEN);

    function Wrapper({ pending }: { pending: boolean }) {
      return (
        <CommandBar
          ctx={fixedCtx}
          hasPendingCreate={pending}
          dateFormat="d_mon_yyyy"
          zone="UTC"
          reader={null}
          recognizer={null}
          micRequest={0}
          onOpen={onOpen as unknown as CommandBarProps["onOpen"]}
          onRetime={vi.fn().mockReturnValue(WRITTEN)}
          onBook={vi.fn().mockReturnValue(WRITTEN)}
          onRetimeRun={vi.fn().mockReturnValue(WRITTEN)}
          onUnassign={onUnassign}
          onMove={vi.fn().mockReturnValue(WRITTEN)}
          onSetHeadcount={vi.fn().mockReturnValue(WRITTEN)}
          onRunLot={vi.fn(() => new Promise<LotResult>(() => {}))}
          onHighlight={vi.fn()}
          onShowDay={vi.fn()}
        />
      );
    }

    const { rerender } = render(<Wrapper pending={false} />);
    const input = screen.getByRole("textbox", { name: "Tell the board" }) as HTMLInputElement;

    // The bar's own create: dispatched straight through, hands off to a
    // pop-up, settles nothing yet.
    fireEvent.change(input, { target: { value: CREATE_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledTimes(1);

    // A second sentence, said before the create pop-up has answered: held
    // (`barWritesInFlightRef` is up) -- no question stands yet.
    fireEvent.change(input, { target: { value: UNASSIGN_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.queryByRole("button", { name: "Remove it" })).toBeNull();

    // The create pop-up reports written -- `barWritesInFlightRef` moves to
    // `barWritesAwaitingCtxRef`, still held (no fresh `ctx` yet).
    act(() => {
      capturedReport?.({ kind: "written" });
    });
    expect(screen.queryByRole("button", { name: "Remove it" })).toBeNull();

    // `hasPendingCreate` toggles true, then back to false -- exactly the
    // shape `pendingCreateSnapshot`'s own SEPARATE subscription can produce
    // on its own schedule, independent of `ctx`. `ctx` is `fixedCtx`, the
    // EXACT SAME reference through every render in this test: a real board
    // would never hand this component a `ctx` prop the `useMemo` it comes
    // from has not actually recomputed.
    rerender(<Wrapper pending={true} />);
    rerender(<Wrapper pending={false} />);

    // The held sentence must STILL be held: nothing has proven the board
    // caught up with the create's own write yet -- no question, no write.
    expect(screen.queryByRole("button", { name: "Remove it" })).toBeNull();
    expect(onUnassign).not.toHaveBeenCalled();
  });
});

/**
 * F-233, third pass (S194-G3): docs/agent-briefs/s194-g3-the-hold-regressed-brief.md.
 * The second pass broke the real app: `awaitingRowCountRef` (a snapshot of
 * `ctx.assignments.length`/`ctx.runs.length` taken at dispatch, waiting for
 * either to grow) replaced the second pass's own gap, but was itself never
 * the row -- and worse, `dropHeldQueue` (the bound's own refusal) never
 * cleared it, so once the FIRST create's own wait ever timed out, that
 * stale snapshot stayed armed and silently gated `barWritesAwaitingCtxRef`'s
 * own clearing for every write after it, for the rest of the session. On
 * the real walk this held every sentence after the first create for the
 * full five seconds, turning a thirty-second walk into four minutes, even
 * though the walk waits for each row to be confirmed in the database before
 * saying the next sentence -- the row was real, and the bar still refused.
 *
 * Replaced, not repaired, with the brief's own exact mechanism: the writers
 * answer the real id of the row they made, and the bar waits for THAT id
 * (`awaitingRowIdRef`), not a count.
 */
describe("F-233, third pass: the writers answer the row's own id, not a count", () => {
  /**
   * Proving item 1: reproduces TODAY'S regression -- a create whose row is
   * REAL and ALREADY IN `ctx` by the time a second sentence is typed, which
   * must run AT ONCE, never held. RED before this pass's own fix: reverting
   * `dropHeldQueue` to the second pass's own version (which never cleared
   * `awaitingRowIdRef`/`pendingCreateCollectionRef`) and running TWO creates
   * in a row -- the first timing out at the bound, the second's own real,
   * already-landed row then held anyway by the FIRST create's leaked
   * wait -- turns this red; this specific test only needs the single-create
   * shape to prove the id-based mechanism itself releases at once, which the
   * mutation section below proves is load-bearing by removing it outright.
   */
  it("a create whose row is real and already in ctx: the next sentence runs at once, never held", () => {
    const { input, onOpen, rerenderCtx } = renderBar({ assignments: [BLK1] });
    let capturedReport: ((result: { kind: "written"; id?: string }) => void) | null = null;
    onOpen.mockImplementationOnce(
      (..._args: unknown[]): { kind: "popup"; waitingFor: string; standing: false } => {
        capturedReport = _args[2] as (result: { kind: "written"; id?: string }) => void;
        return { kind: "popup", waitingFor: "the create pop-up", standing: false };
      },
    );
    const CREATE_SENTENCE = "Assign Operator 1 to Housing A on Cell 1 in Line 1 from 6 to 8";
    const P1_OFF_HOURS_SENTENCE = "Assign Sam Patel to Housing A on Cell 1 in Line 1 from 8 to 9";

    fireEvent.change(input, { target: { value: CREATE_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledTimes(1);

    // The create's own row is real, and the board has already caught up --
    // the SAME as the walk's own shape, which explicitly waits for the row
    // to be confirmed in the database before it ever says the next
    // sentence.
    act(() => {
      capturedReport?.({ kind: "written", id: "created-assignment-1" });
    });
    const LANDED: ContextAssignment = {
      ...BLK1,
      id: "created-assignment-1",
      startMin: 3 * 1440 + 360,
      endMin: 3 * 1440 + 480,
    };
    rerenderCtx({ assignments: [BLK1, LANDED] });

    // A second, unrelated sentence -- runs AT ONCE, no hold, no five-second
    // wait, no refusal.
    fireEvent.change(input, { target: { value: P1_OFF_HOURS_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Working…")).toBeNull();
    expect(
      threadText().includes(
        "The board is still saving your last change. Say it again in a moment.",
      ),
    ).toBe(false);
  });

  /**
   * `dropHeldQueue` (the bound's own refusal) now clears
   * `awaitingRowIdRef`/`pendingCreateCollectionRef` too, matching the
   * write counters just above it -- defensive completeness, proven by
   * mutation (removing the two lines) rather than by its own case: every
   * OTHER write's own dispatch (which always sets or nulls
   * `pendingCreateCollectionRef` before its own outcome is even known) and
   * settle (which always sets or nulls `awaitingRowIdRef` from THAT
   * outcome) already overwrites whatever a timed-out create left behind the
   * moment anything else is said, so this pass could not construct a
   * scenario where the omission alone was the ONLY thing standing between a
   * held sentence and running -- unlike `awaitingRowCountRef`, the count
   * proxy this pass removed, whose OWN comparison did not self-correct the
   * same way and which this omission genuinely left armed for the rest of
   * a session on the real walk.
   */

  /**
   * Proving item 4 ("a row outside the board's window"): `pendingCreateCollectionRef`
   * (and so `awaitingRowIdRef`) is ONLY ever armed by the single-write
   * dispatch inside `runCommandBody` -- a LOT's own writes (`runLotNow`,
   * `resolveLotStep`) never touch it at all, by construction, the same as
   * before this pass. A lot is exactly the shape the brief's own examples
   * name (a copy to another week, a repeat over next week, several rows
   * spanning days) -- only the FIRST day of a multi-day sentence is ever
   * guaranteed to be the one `ctx`'s own window was moved to (R-455), so a
   * lot step's own created row can legitimately never appear in `ctx` at
   * all. This proves the consequence directly: a lot that includes a
   * create never arms an id-wait, so a sentence said right after it is
   * governed only by the plain "a genuinely new ctx" rule (`lastDrainedCtxRef`),
   * never held waiting for a row that might not be inside this window.
   */
  it("a lot's own create never arms an id-wait -- a later sentence needs only a fresh ctx, never a specific row", async () => {
    const onRunLot = vi.fn((): Promise<LotResult> => Promise.resolve({ done: 2, error: null }));
    const { input, onOpen, rerenderCtx } = renderBar(
      { assignments: [BLK1, BLK_SP] },
      null,
      null,
      {},
      { onRunLot },
    );

    // A lot (two removals) -- runs through `runLotNow`/`onRunLot`, never
    // the single-write dispatch this pass's own `pendingCreateCollectionRef`
    // lives in.
    fireEvent.change(input, { target: { value: LOT_REMOVE_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    await act(async () => {
      fireEvent.change(input, { target: { value: "yes" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onRunLot).toHaveBeenCalledTimes(1);

    // A later, ordinary sentence -- held only until a fresh `ctx` (not any
    // specific row's id, which a lot never promised) arrives.
    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpen).not.toHaveBeenCalled();
    rerenderCtx({ assignments: [] });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  /**
   * Proving item 4, directly: `dayIsInCtxWindow` (`CommandBar.tsx`) itself.
   * A single (non-lot) create whose own resolved `range` falls outside the
   * days `ctx` covers -- built by spying on `resolveCommand` for one call
   * (the same pattern "CB-unknown" below uses) and overwriting the range an
   * ordinary create resolved to, since R-455 means the resolver itself
   * never produces one for a genuine single sentence in practice. The row
   * this create answers with can never appear in THIS `ctx` (it is never
   * added to the fixture) -- a later sentence must still run once the board
   * simply shows a fresh `ctx`, never stuck waiting five seconds and
   * refused for a row that was never going to be in it. Mutation-tested:
   * `dayIsInCtxWindow` changed to always return `true` (`CommandBar.tsx`)
   * turns this red -- the later sentence then waits forever for an id that
   * this fixture never supplies.
   */
  it("a create whose own row is outside ctx's window never arms an id-wait (item 4)", () => {
    const real = resolveLib.resolveCommand;
    const spy = vi.spyOn(resolveLib, "resolveCommand").mockImplementation(((
      command: unknown,
      ctx: unknown,
      options?: unknown,
    ) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = (real as any)(command, ctx, options);
      if (result.ok && result.resolved.intent === "assign") {
        return {
          ok: true,
          resolved: { ...result.resolved, range: { startMin: 999_000, endMin: 999_060 } },
        };
      }
      return result;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any);

    try {
      // P1_SENTENCE writes straight through against an EMPTY board -- BLK1
      // would collide with its own slot; the second sentence below is the
      // one that needs BLK1, added only once it is actually said.
      const { input, onOpen, onUnassign, rerenderCtx } = renderBar({ runs: [] });
      let capturedReport: ((result: { kind: "written"; id?: string }) => void) | null = null;
      onOpen.mockImplementationOnce(
        (..._args: unknown[]): { kind: "popup"; waitingFor: string; standing: false } => {
          capturedReport = _args[2] as (result: { kind: "written"; id?: string }) => void;
          return { kind: "popup", waitingFor: "the create pop-up", standing: false };
        },
      );

      fireEvent.change(input, { target: { value: P1_SENTENCE } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onOpen).toHaveBeenCalledTimes(1);

      // The create's own row is real, but its day is outside this ctx's own
      // window -- the fixture below never adds it, on purpose.
      act(() => {
        capturedReport?.({ kind: "written", id: "row-outside-window" });
      });

      // A later sentence -- held only until a fresh ctx (which never needs
      // to carry the out-of-window row's own id). BLK1 appears here for
      // the FIRST time, with the create's own row still never in it.
      fireEvent.change(input, { target: { value: UNASSIGN_SENTENCE } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(screen.queryByRole("button", { name: "Remove it" })).toBeNull();
      rerenderCtx({ assignments: [BLK1] });
      expect(screen.getByRole("button", { name: "Remove it" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
      expect(onUnassign).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
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

  it("CB-unknown-3b (S72-d review, R-459): a REAL place suggestion carries an arrow-path `label` from `placeLabel` -- the button must show `word` (the bare name), never it", () => {
    // CB-unknown-3 above never caught this: its mock candidate sets
    // `label` equal to `word` ("Cell 2"/"Cell 2"), which the real resolver
    // never does for a place -- `nodeSuggestions`/`trackCellSuggestions`
    // (resolve.ts) build a place candidate's `label` from `placeLabel`, an
    // ancestor-chain path ("Cell 2 — Plant 1 › Assembly › Line 1"), kept for
    // an off-screen id/key only (the doc on `cellDisplayName`, resolve.ts).
    // This candidate is shaped the way the REAL resolver actually returns
    // one, to prove the button reads the bare name and nothing with a "›"
    // or "—" in it ever reaches the screen (R-459: no arrow, no chain).
    withUnknownSuggestions(
      "place",
      [{ id: "c2", label: "Cell 2 — Plant 1 › Assembly › Line 1", word: "Cell 2" }],
      () => {
        const { input, onOpen } = renderBar();
        fireEvent.change(input, {
          target: { value: "assign Operator 1 to Housing A on Zzznotacell in Line 1 from 10 to 2" },
        });
        fireEvent.keyDown(input, { key: "Enter" });

        expect(statusText()).toBe(
          'No place called "Zzznotacell" on this board. Did you mean one of these?',
        );
        // The button's own accessible name is the bare name -- a query for
        // the path-shaped label must find nothing at all.
        expect(screen.queryByRole("button", { name: /›|—/ })).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Cell 2" }));

        expect(onOpen).toHaveBeenCalledTimes(1);
        const [resolved] = onOpen.mock.calls[0] as [ResolvedCommand, { x: number; y: number }];
        expect(resolved.nodeId).toBe("c2");
      },
    );
  });

  // S194-D (R-430 for a person, CONTRACT CHANGED -- this case pinned the
  // dead end the standard forbids: "No person called ..." with nothing to
  // choose): the caller's own active people are offered, board order, and a
  // pick runs the sentence with that name. The trace entry holds the ask.
  it("CB-unknown-4: no near name for a person -- offers the people on the caller's own board (active only), a pick reaches onOpen, the ask is traced", () => {
    const fetchMock = stubFetch();
    const { input, onOpen } = renderBar();
    fireEvent.change(input, {
      target: { value: "assign Zzznotaperson to Housing A on Cell 1 in Line 1 from 10 to 2" },
    });
    fireEvent.keyDown(input, { key: "Enter" });

    const asked = 'No person called "Zzznotaperson" on your board. Did you mean one of these?';
    expect(statusText()).toBe(asked);
    expect(candidateButtons().map((b) => b.textContent)).toEqual([
      "Operator 1",
      "Sam Patel",
      "Sam Ortiz",
      "Lin On",
      "Priya Shah",
    ]); // never "Sam Gone" (inactive)
    expect(postedEntry(fetchMock).asked).toBe(asked);
    expect(onOpen).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Sam Patel" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    const [resolved] = onOpen.mock.calls[0] as [ResolvedCommand, { x: number; y: number }];
    expect(resolved.operatorId).toBe("sp");
  });

  it("CB-unknown-4b (S194-D, R-430 checked for a part): a part with no near name gets the cell's own menu as buttons; with a cell that makes NOTHING, no part is offered -- every one would be refused there (R-431)", () => {
    const { input } = renderBar();
    fireEvent.change(input, {
      target: { value: "assign Sam Patel to Zzznotapart on Cell 1 in Line 1 from 10 to 2" },
    });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(candidateButtons().map((b) => b.textContent)).toEqual(["Housing A", "Housing B"]);

    cleanup();
    const bare = renderBar({ offeredAt: () => [] });
    fireEvent.change(bare.input, {
      target: { value: "assign Sam Patel to Zzznotapart on Cell 1 in Line 1 from 10 to 2" },
    });
    fireEvent.keyDown(bare.input, { key: "Enter" });
    expect(statusText()).toBe('No part called "Zzznotapart" on this board.');
    expect(candidateButtons()).toEqual([]);
  });

  /**
   * DEF-0051 / R-430 (28 Sept, tester): Ana types "clear Cell 3 today" --
   * Cell 3 is real (one line over) but not on her board, so the resolver's
   * own nearest-match suggestions (computed against HER `ctx`, which never
   * heard of Cell 3) come back empty -- CB-unknown-4's shape, one field
   * over. The fix (`questionToStatus`'s own `field === "place"` fallback,
   * CommandBar.tsx) never asks the server or the question for anything
   * further; it offers Ana's own board (`ctx.cells`) as buttons instead.
   * Two cells, no duplicate name, so a real, unmocked resolver drives it
   * end to end -- `withUnknownSuggestions` is not needed here (there is
   * nothing to mock: the whole point is the REAL empty-suggestions case).
   */
  it('CB-unknown-5 (DEF-0051, place, no server suggestions): "No cell called ... on your board" offers her own cells, a pick reaches onOpen', () => {
    const twoCells = [
      { id: "c1a", name: "Cell 1", path: "plant_1.assembly.line_1.cell_1" },
      { id: "c2", name: "Cell 2", path: "plant_1.assembly.line_1.cell_2" },
    ];
    const { input, onOpen } = renderBar({ cells: twoCells });
    fireEvent.change(input, {
      target: { value: "assign Operator 1 to Housing A on Cell 3 in Line 1 from 10 to 2" },
    });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toBe('No cell called "Cell 3" on your board. Did you mean one of these?');
    expect(screen.getByRole("button", { name: "Cell 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cell 2" })).toBeTruthy();
    // R-430/R-431: the client never says where Cell 3 really is -- nothing
    // on screen names Line 2, a path, or any other clue past Ana's grant.
    expect(threadText()).not.toContain("Line 2");

    fireEvent.click(screen.getByRole("button", { name: "Cell 2" }));

    expect(onOpen).toHaveBeenCalledTimes(1);
    const [resolved] = onOpen.mock.calls[0] as [ResolvedCommand, { x: number; y: number }];
    expect(resolved.nodeId).toBe("c2");
  });

  it("CB-unknown-6 (DEF-0051): a trace entry is asserted for the cell fallback question", () => {
    const fetchMock = stubFetch();
    const twoCells = [
      { id: "c1a", name: "Cell 1", path: "plant_1.assembly.line_1.cell_1" },
      { id: "c2", name: "Cell 2", path: "plant_1.assembly.line_1.cell_2" },
    ];
    const { input } = renderBar({ cells: twoCells });
    fireEvent.change(input, {
      target: { value: "assign Operator 1 to Housing A on Cell 3 in Line 1 from 10 to 2" },
    });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Cell 2" }));

    const entries = fetchMock.mock.calls.map((call: unknown[]) => {
      const [, init] = call as [string, RequestInit];
      return JSON.parse(init.body as string) as TraceEntry;
    });
    // DEF-0049 (CONTRACT CHANGED, 28 Sept): this question's own entry now
    // posts at the ask too (`answered: null`), then again once "Cell 2" is
    // picked and written -- `findLast` reads the up-to-date line.
    const asked = entries.findLast((e) =>
      (e.asked ?? "").startsWith('No cell called "Cell 3" on your board'),
    );
    expect(asked).toBeTruthy();
    expect(asked?.answered).toBe("Cell 2");
  });
});

/**
 * DEF-0046, the bar's half (28 Sept, tester): "extend everyone on Cell 1 by
 * 30 minutes" throws inside `resolveMoveCommand` (`resolve.ts`), reached
 * through `resolveCommand` -- lane B's own fix is the resolver no longer
 * throwing there; this lane's half is that ANY throw reaching `runCommand`/
 * `resolveLotStep`/`startLot`/`runCandidateAction` is caught, shown as one
 * plain turn, and recorded (`reportBarCrash`, CommandBar.tsx), rather than
 * freezing the question and its buttons with nothing in the console or the
 * trace. `resolveCommand` is mocked to throw directly (the same shape a
 * genuine `resolve.ts` regression would produce) -- this describe block does
 * not need the real crash reproduced, only that CATCHING one works.
 */
describe("CB-crash: DEF-0046, the bar's half -- a throw never freezes the thread (R-434)", () => {
  it("CB-crash-1: a throw resolving a typed sentence is caught, shown as one plain turn, and recorded with its outcome", () => {
    const spy = vi.spyOn(resolveLib, "resolveCommand").mockImplementation(() => {
      throw new TypeError("Cannot read properties of null (reading 'start')");
    });
    const fetchMock = stubFetch();
    try {
      const { input, onOpen } = renderBar({ assignments: [BLK1] });
      fireEvent.change(input, { target: { value: P1_SENTENCE } });
      fireEvent.keyDown(input, { key: "Enter" });

      // The live line -- the maintainer's own sentence, verbatim, no buttons.
      expect(statusText()).toBe("Something went wrong and nothing was changed. Say it again.");
      expect(candidateButtons()).toHaveLength(0);
      expect(onOpen).not.toHaveBeenCalled();

      // Filed into the thread through the SAME "refused:" rendering every
      // other refusal already uses (R-459's "Not done:" prefix).
      expect(threadText()).toContain(
        "Not done: Something went wrong and nothing was changed. Say it again.",
      );

      // R-434: a trace entry, with its outcome -- never silently dropped.
      const entries = fetchMock.mock.calls.map((call: unknown[]) => {
        const [, init] = call as [string, RequestInit];
        return JSON.parse(init.body as string) as TraceEntry;
      });
      const posted = entries.find((e) => (e.outcome ?? "").includes("Something went wrong"));
      expect(posted).toBeTruthy();
      expect(posted?.outcome).toBe(
        "refused: Something went wrong and nothing was changed. Say it again.",
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("CB-crash-2: the bar is not frozen after a crash -- a second, ordinary sentence still runs cleanly", () => {
    const spy = vi.spyOn(resolveLib, "resolveCommand").mockImplementationOnce(() => {
      throw new Error("boom");
    });
    const { input, onOpen } = renderBar({ assignments: [BLK1] });
    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(statusText()).toBe("Something went wrong and nothing was changed. Say it again.");
    spy.mockRestore();

    // The REAL resolver, unmocked, on a fresh sentence -- nothing held over
    // (no stale lot, no frozen question, no leftover input text) from the
    // crash before it.
    fireEvent.change(input, { target: { value: UNASSIGN_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));

    expect(onOpen).not.toHaveBeenCalled();
  });

  it("CB-crash-3: a throw from a candidate press (the model's ungrounded-reading button, DEF-0046's own real shape) is caught the same way", async () => {
    // S71-m's own ungrounded-reading button (`askUngrounded`) runs
    // `runCommand(action.command)` directly with the command OBJECT, never
    // a re-parse -- the same door DEF-0046's own second route (the model
    // misreading a sentence, the person pressing the one button offered)
    // goes through. The heard text and the move-with-`adjust`-on-"everyone"
    // reading are DEF-0046's own shapes: "sorry, this will take a few extra
    // minutes, go ahead without me" has no clock/domain word/name/possessive
    // (`looksLikeCommand` false, so `verbGuessStatus` offers nothing) and no
    // MOVE_VERBS/ADJUST_VERBS word either (`no_intent_word`, not the
    // sweeping unassign case DEF-0041 covers) -- `applyReading` reaches
    // `askUngrounded` exactly as it did for the tester, WITHOUT ever calling
    // `resolveCommand` (the button's own action hands the command object
    // straight to `runCommand`, never a re-parse) -- so `resolveCommand` can
    // throw unconditionally here; the button press is its first real call.
    const fakeReader: Reader = vi.fn(async (): Promise<Reading> => ({
      ok: true,
      by: "model",
      command: {
        intent: "move",
        operator: "everyone",
        place: ["Cell 2"],
        toPlace: null,
        day: null,
        span: null,
        existing: null,
        shift: null,
        adjust: { edge: "end", by: 30 },
      },
    }));
    const spy = vi.spyOn(resolveLib, "resolveCommand").mockImplementation(() => {
      throw new TypeError("Cannot read properties of null (reading 'start')");
    });
    try {
      // BLK_C2: a real block on Cell 2 -- "everyone on Cell 2" must expand
      // to at least one real move for `resolveCommand` to ever be reached
      // at all (an empty expansion is a plain `nothing_to_do` readout, no
      // resolution attempted, nothing here to catch).
      const { input } = renderBar({ assignments: [BLK_C2] }, fakeReader);
      fireEvent.change(input, {
        target: { value: "sorry, this will take a few extra minutes, go ahead without me" },
      });
      fireEvent.keyDown(input, { key: "Enter" });

      await waitFor(() => expect(statusText()).toMatch(/^I heard ".*"\. Did you mean: /));
      const button = candidateButtons()[0];
      fireEvent.click(button);

      expect(statusText()).toBe("Something went wrong and nothing was changed. Say it again.");
      expect(candidateButtons()).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
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
    expect(entry.ran).toEqual([renderedReadout(resolved.readout)]);
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

  // S71-f (R-453, R-434, brief docs/agent-briefs/s71-f-clip-capture-brief.md
  // §1.E): `onClip` fires strictly before `onFinal` for the same clip
  // (`localRecognizer.ts`'s own doc), same as the real recogniser --
  // `makeFakeRecognizer`'s `fire.clip` mirrors that ordering. The numbers
  // land on the sentence's own trace entry, and the WAV bytes post to
  // `/__clip` under that entry's own `at`.
  it("CB-clip-1: onClip's numbers land on the sentence's trace entry, and the WAV posts to /__clip under the entry's own at (S71-f)", async () => {
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
    renderBar({ runs: [] }, fakeReader, recognizer, {}, {}, { recognizerName: () => "local" });

    fireEvent.click(screen.getByRole("button", { name: "Speak a sentence" }));

    const wav = new ArrayBuffer(48);
    const clip: ClipInfo = {
      wav,
      durationMs: 1500,
      recordedMs: 1500,
      endedBy: "silence",
      speechStarted: true,
      peakRms: 0.35,
      meanRms: 0.12,
      framesAboveFloor: 5,
      hint: null,
    };
    fire.clip(clip);
    fire.final(P1_SENTENCE);

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => url === "/__trace")).toBe(true),
    );

    const clipCall = fetchMock.mock.calls.find(
      ([url]) => typeof url === "string" && url.startsWith("/__clip"),
    ) as [string, RequestInit] | undefined;
    expect(clipCall).toBeDefined();
    const [clipUrl, clipInit] = clipCall!;
    expect(clipInit.method).toBe("POST");
    expect(clipInit.body).toBe(wav);
    expect(clipUrl).toMatch(/^\/__clip\?at=/);

    const traceCall = fetchMock.mock.calls.find(([url]) => url === "/__trace") as
      [string, RequestInit] | undefined;
    expect(traceCall).toBeDefined();
    const entry = JSON.parse(traceCall![1].body as string) as TraceEntry;
    expect(entry.clip).toEqual({
      durationMs: 1500,
      recordedMs: 1500,
      endedBy: "silence",
      speechStarted: true,
      peakRms: 0.35,
      meanRms: 0.12,
      framesAboveFloor: 5,
    });
    // The `/__clip` post's own `at` is the SAME string as the trace entry's
    // `at` -- the join key `score.mjs --from-trace` uses.
    const atParam = new URL(clipUrl, "http://localhost").searchParams.get("at");
    expect(atParam).toBe(entry.at);
  });

  // S71-f review fix (session leak): a clip stashed by session A must never
  // attach to session B's unrelated entry when A is superseded (stop, then
  // a fresh press) before A's own onFinal/onError ever arrives -- the
  // reviewer's exact repro (B's "Nothing was heard" entry used to carry A's
  // durationMs 900 / silence). Custom recognizer here (not
  // `makeFakeRecognizer`) since each session needs its OWN captured
  // `RecognizerEvents` -- that helper only ever keeps the latest.
  it("CB-clip-2: a clip from a superseded session never attaches to a later session's trace entry, and its WAV is never posted (S71-f review fix)", () => {
    const fetchMock = stubFetch();
    const sessions: RecognizerEvents[] = [];
    const recognizer: Recognizer = (events) => {
      sessions.push(events);
      return { stop: vi.fn() };
    };
    renderBar({ runs: [] }, null, recognizer);
    const micButton = screen.getByRole("button", { name: "Speak a sentence" });

    // Session A starts.
    fireEvent.click(micButton);
    expect(sessions).toHaveLength(1);
    const a = sessions[0];

    // A's onClip fires -- a clip WAS captured.
    const clipA: ClipInfo = {
      wav: new ArrayBuffer(16),
      durationMs: 900,
      recordedMs: 900,
      endedBy: "silence",
      speechStarted: true,
      peakRms: 0.2,
      meanRms: 0.1,
      framesAboveFloor: 3,
      hint: null,
    };
    act(() => a.onClip?.(clipA));

    // A is superseded: stop (still listening -- a second click stops it),
    // then a fresh press starts session B -- A's own onFinal/onError never
    // arrives.
    fireEvent.click(micButton); // stop
    fireEvent.click(micButton); // fresh press -- session B
    expect(sessions).toHaveLength(2);
    const b = sessions[1];

    // B ends with no speech heard -- a real onError, no clip ever fired
    // for B itself.
    act(() => b.onError("no-speech"));

    expect(
      fetchMock.mock.calls.some(([url]) => typeof url === "string" && url.startsWith("/__clip")),
    ).toBe(false);

    const traceCall = fetchMock.mock.calls.find(([url]) => url === "/__trace") as
      [string, RequestInit] | undefined;
    expect(traceCall).toBeDefined();
    const entry = JSON.parse(traceCall![1].body as string) as TraceEntry;
    expect(entry.clip).toBeUndefined();
  });

  it("CB-t-3: a question answered by a button -- posted at the ask (DEF-0049), corrected when answered", () => {
    const fetchMock = stubFetch();
    const { onOpen, input } = renderBar();
    fireEvent.change(input, {
      target: { value: "assign Sam to Housing A on Cell 1 in Line 1 from 10 to 2" },
    });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toBe('Which person? "Sam" matches 2:');
    // DEF-0049: the sentence's life has not ended yet (the entry stays
    // OPEN, unanswered), but the ask itself already posted.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(postedEntry(fetchMock).answered).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Sam Patel" }));
    expect(onOpen).toHaveBeenCalledTimes(1);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const entry = postedEntry(fetchMock);
    expect(entry.asked).toBe('Which person? "Sam" matches 2:');
    expect(entry.answered).toBe("Sam Patel");
    expect(entry.revises).toBe(true);
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
    // DEF-0049 (CONTRACT CHANGED, 28 Sept): each of the lot's own per-step
    // questions posts at its own ask now (`resolveLotStep`'s new call,
    // CommandBar.tsx) -- three so far: "1 of 2: ..." (the ask), "2 of 2:
    // ..." (a revision once the first is answered and the second is asked),
    // "Ready to do 2 things: ..." (a revision once the second is answered).
    expect(fetchMock).toHaveBeenCalledTimes(3);

    fireEvent.change(input, { target: { value: "yes" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(threadText()).toContain("Done, 2 things."));
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const entry = postedEntry(fetchMock);
    const [resolvedList] = onRunLot.mock.calls[0] as [ResolvedAny[]];
    // DEF-0043 item 1 (CONTRACT CHANGED, 28 Sept, CLAUDE.md §4: not wrong
    // when written): `ran` used to hold the RAW readout (a raw ISO date
    // token and all) -- the same field the thread's own "Written: ..." line
    // reads (`turnResultLine`), so a raw `2026-...` date used to show there
    // too. `renderReadout`'d now, same builder the question before it uses.
    expect(entry.ran).toEqual(resolvedList.map((r) => renderedReadout(r.readout)));
    expect(entry.ran).toHaveLength(2);
    expect(entry.answered).toBe("yes");
  });

  // F-233, second pass (S194-G2, review fix): CONTRACT CHANGED. The second
  // sentence used to run immediately, `ctx` never having changed between the
  // two Enters. Finding 1 now holds a sentence typed before the board has
  // caught up with the FIRST write's own outcome -- `rerenderCtx` simulates
  // that catch-up (the same shape a real invalidated refetch produces)
  // between the two, which is the only thing this test adds; the point it
  // was written to prove (a failed trace post never affects the bar's own
  // writes) is otherwise unchanged. Review fix: a plain `{ runs: [] }`
  // rerender is not enough on its own any more -- `awaitingRowCountRef`
  // (`CommandBar.tsx`) needs the board to show one more assignment than it
  // did when this create was dispatched, so the "catch-up" rerender below
  // adds one, at a time P1_SENTENCE's own second submission does not also
  // target.
  it("CB-t-5: a failed post is swallowed -- the bar itself is unaffected", () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);
    const { onOpen, input, rerenderCtx } = renderBar({ runs: [] });
    const CREATED_BLOCK: ContextAssignment = {
      ...BLK1,
      id: "created1",
      startMin: 3 * 1440 + 60,
      endMin: 3 * 1440 + 120,
    };

    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The board catches up with the first write before the second is said.
    rerenderCtx({ runs: [], assignments: [CREATED_BLOCK] });

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
  // DEF-0049 (CONTRACT CHANGED, 28 Sept, CLAUDE.md §4: not wrong when
  // written): "a question left open when the page closes ... went missing"
  // -- these three used to pin that an entry stayed unposted until it
  // FINISHED (a readout, a cancel, Escape); the whole point of the fix is
  // that a standing question posts the moment it is ASKED too
  // (`traceQuestionStatus`, CommandBar.tsx) -- so `fetchMock` is called
  // once right after Enter now, and Escape's own post is a SECOND line, a
  // `revises: true` correction (`postedEntry`'s own updated doc: no
  // argument now means the LAST line, the up-to-date state).
  it("CB-t-7a: a standing question posts at the ask; Escape corrects it, answered 'escape'", () => {
    const fetchMock = stubFetch();
    const { input } = renderBar();
    fireEvent.change(input, {
      target: { value: "assign Sam to Housing A on Cell 1 in Line 1 from 10 to 2" },
    });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(statusText()).toBe('Which person? "Sam" matches 2:');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const asked = postedEntry(fetchMock);
    expect(asked.asked).toBe('Which person? "Sam" matches 2:');
    expect(asked.answered).toBeNull();
    expect(asked.revises).toBeUndefined();

    fireEvent.keyDown(input, { key: "Escape" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const entry = postedEntry(fetchMock);
    expect(entry.asked).toBe('Which person? "Sam" matches 2:');
    expect(entry.answered).toBe("escape");
    expect(entry.revises).toBe(true);
  });

  it("CB-t-7b: a 'Reading…' spinner opens no question yet, so nothing posts until Escape, answered 'escape'", () => {
    const fetchMock = stubFetch();
    const neverSettles: Reader = vi.fn(() => new Promise<Reading>(() => {}));
    const { input } = renderBar({ runs: [] }, neverSettles);

    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(statusText()).toBe("Reading…");
    // "Reading…" is not a question (no `asked` yet) -- nothing to post.
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Escape" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const entry = postedEntry(fetchMock);
    expect(entry.heard).toBe(P1_SENTENCE);
    expect(entry.answered).toBe("escape");
  });

  it("CB-t-7c: Escape on an active listen corrects whatever entry was already posted at the ask, answered 'escape'", () => {
    const fetchMock = stubFetch();
    const { recognizer } = makeFakeRecognizer();
    const { input } = renderBar({ runs: [] }, null, recognizer);

    // Opens a trace entry (`asked` set) -- posted the instant it is asked
    // now (DEF-0049), not only once it is answered.
    fireEvent.change(input, {
      target: { value: "assign Sam to Housing A on Cell 1 in Line 1 from 10 to 2" },
    });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A fresh listen starts -- R-458 (24 Sept): the status (and the
    // still-open trace entry) stand untouched; a mic press never clears
    // either any more.
    fireEvent.click(screen.getByRole("button", { name: "Speak a sentence" }));

    fireEvent.keyDown(input, { key: "Escape" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const entry = postedEntry(fetchMock);
    expect(entry.asked).toBe('Which person? "Sam" matches 2:');
    expect(entry.answered).toBe("escape");
    expect(entry.revises).toBe(true);
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

  it("CB-t-10: Escape CLOSES the entry once, not twice (DEF-0049: the ask-time post is call 1, Escape's own correction is call 2, a second Escape adds nothing)", () => {
    const fetchMock = stubFetch();
    const { input } = renderBar();
    fireEvent.change(input, {
      target: { value: "assign Sam to Housing A on Cell 1 in Line 1 from 10 to 2" },
    });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(statusText()).toBe('Which person? "Sam" matches 2:');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(input, { key: "Escape" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // CB-t-10 (CONTRACT CHANGED, CLAUDE.md §4, R-437/CB-ent-3): this used to
    // say the sentence came back into the box for the second Escape (per the
    // old C7) to clear. R-437 empties the box the moment the question was
    // first asked (Enter, not Escape) and Escape no longer puts anything
    // back into it -- the box is already empty here, and stays that way.
    expect(input.value).toBe("");

    fireEvent.keyDown(input, { key: "Escape" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
    expect(entry.ran).toEqual([renderedReadout(resolved.readout)]);
  });

  it("CB-t-12: a parse failure's own shape hint is recorded as asked, posted at the ask (DEF-0049)", () => {
    const fetchMock = stubFetch();
    const { input } = renderBar();

    fireEvent.change(input, { target: { value: "gibberish" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(statusText()).toBe(SHAPE);
    // DEF-0049: a shape hint is a question the bar asked (R-434) -- posted
    // the instant it is shown, not only once Escape (or a later sentence)
    // closes it; the entry stays OPEN (unanswered) until then, but the line
    // is already in the file, which is the whole point of the fix (a page
    // closed here before Escape must not lose this turn).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const asked = postedEntry(fetchMock);
    expect(asked.asked).toBe(SHAPE);
    expect(asked.answered).toBeNull();

    fireEvent.keyDown(input, { key: "Escape" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const entry = postedEntry(fetchMock);
    // `read` is whatever `ParseFailure.kind` this sentence hit -- not this
    // pin's own concern (`commandParse.test.ts` owns that table); only that
    // some failure kind was recorded at all.
    expect(entry.read.length).toBeGreaterThan(0);
    expect(entry.asked).toBe(SHAPE);
    expect(entry.answered).toBe("escape");
    expect(entry.revises).toBe(true);
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
    expect(entry.ran).toEqual([renderedReadout(resolved.readout)]);
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
    // DEF-0049: posted at the ask (the sentence's life has not ENDED -- the
    // entry stays open, same as CB-t-3's own identical case -- but the ask
    // itself is already in the file).
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The window's ctx goes null (a refetch gap) -- must not crash, must
    // not lose the status, must not flush the still-open entry early or post
    // again on its own.
    rerenderCtx(null);
    expect(statusText()).toBe('Which person? "Sam" matches 2:');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // ... and comes back.
    rerenderCtx({});
    expect(statusText()).toBe('Which person? "Sam" matches 2:');

    // The candidate button still works -- `lastCtxRef` carried the board
    // through the gap, so resolving the pick never crashed either.
    fireEvent.click(screen.getByRole("button", { name: "Sam Patel" }));
    expect(onOpen).toHaveBeenCalledTimes(1);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const entry = postedEntry(fetchMock);
    expect(entry.asked).toBe('Which person? "Sam" matches 2:');
    expect(entry.answered).toBe("Sam Patel");
    expect(entry.revises).toBe(true);
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
    // Reviewer fix (S72-b's own known hole, 24 Sept): the "Moved the board
    // …" readout FILES into the thread the instant it is set (CP-5,
    // unchanged), but the entry itself is NOT posted yet -- the rerun this
    // move queues (`pendingRerunRef`) still owes an answer, and posting here
    // would leave that answer with nowhere to land (the hole this fix
    // closes: the write used to post no trace entry at all, since
    // `traceRef.current` was already null by the time it ran). So nothing
    // has gone over the wire yet.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(threadText()).toContain("Moved the board to yesterday.");

    // R-424: the window ctx goes null before the new window's data lands.
    rerenderCtx(null);
    expect(onOpen).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    // ... and the real new ctx (the window actually moved) arrives.
    rerenderCtx({ days: SHIFTED_BACK_ONE_DAY, todayIndex: 1 });

    expect(onOpen).toHaveBeenCalledTimes(1);
    const [resolved] = onOpen.mock.calls[0] as [ResolvedCommand, { x: number; y: number }];
    expect(resolved.operatorId).toBe("op1");
    // Reviewer fix: the rerun's write runs OUTSIDE `submitText` (the
    // pending-rerun effect calls `runCommand` directly, never `startTrace`)
    // but lands on the SAME entry the move opened (`traceRef.current` was
    // kept open, not finished, by the move) -- so it posts exactly ONCE,
    // carrying the whole story: the move AND what the write it triggered
    // actually did. Two posts (one empty for the move, one orphaned for the
    // write) would be the hole this fix closes; a second post here would be
    // a regression back into it.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const entry = postedEntry(fetchMock);
    expect(entry.asked).toBe("Moved the board to yesterday.");
    expect(entry.answered).toBe("auto");
    expect(entry.outcome).toBe("written");
    expect(entry.ran).toHaveLength(1);
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
  it("CB-day-1: a readout carrying 2026-09-16 under America/Chicago renders 'Wed Sep 16', never Tue", async () => {
    const write = pendingWrite();
    const onBook = vi.fn(() => write.promise);
    render(
      <CommandBar
        ctx={buildCtx({
          days: [{ index: 0, iso: "2026-09-16", weekday: 3 }],
          todayIndex: 0,
        })}
        hasPendingCreate={false}
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
    // S196-A (F-239): CONTRACT CHANGED -- the readout lives in the thread once
    // the writer answers; the live line is "Working…" until then.
    expect(statusText()).toBe("Working…");
    await write.settle();
    expect(threadText()).toContain("Wed Sep 16");
    expect(threadText()).not.toContain("Tue Sep 15");
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
// DEF-0052 / R-432 (CONTRACT CHANGED, 28 Sept, CLAUDE.md §4: not wrong when
// written): the maintainer restated R-432 to SEPARATE LINES on 28 Sept --
// this pin's own count-only "Did 1 of 2 things; the next failed: ... What
// was already done stayed: ..." is the OLD form; DEF-0052 filed against it
// because a lot longer than two never named the changes after the refused
// one at all. Rewritten to "I made k of N changes." / "Done: ..." / "Not
// done: ..." / "Not tried: ...".
describe("CB-lot-fail: a partial lot says what stood, never a false revert (F-154)", () => {
  it("CB-lot-fail-1: 'I made 1 of the 2 changes.\\nDone: <readout>\\nNot done: <who and where>. <the reason in the plant's words>'", async () => {
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
        "I made 1 of the 2 changes.\n" +
          `Done: ${renderedReadout(resolved[0].readout)}\n` +
          "Not done: Sam Patel's block on Cell 1 in Line 1 Thu Sep 3, 10 am to 2 pm. Tom Baker is not certified for Welding, which Cell 1 needs.",
      ),
    );
    expect(threadText()).not.toContain("reverted");
    // n=2, done=1: nothing after the refused step -- no "Not tried" line.
    expect(threadText()).not.toContain("Not tried:");
  });

  // F-233 (S194-G): an UNEXPECTED error a lot step hits (an `Unknown`-kind
  // `SchedulerError`, `errors.ts` -- the placeholder-id race this lane
  // fixes was one instance; any other unclassified server error is
  // another) used to reach the thread as the raw, generic
  // "Something went wrong. Please try again." -- a reason that names
  // nothing about THIS lot, THIS step. `rewriteRefusal` (R-449, the one
  // rewriter both the single-sentence and the lot paths share) now
  // recognises that exact string and rewrites it, so the "Not done:" line
  // still says what stood (`buildLotOutcome`'s own job, unchanged) with a
  // reason scoped to the one step that failed.
  it("CB-lot-fail-3 (F-233): an unexpected error's generic reason reads 'Something went wrong with that one.', not the raw 'try again' text", async () => {
    const onRunLot = vi.fn(async (_resolved: ResolvedAny[]): Promise<LotResult> => ({
      done: 1,
      error: "Something went wrong. Please try again.",
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
        "I made 1 of the 2 changes.\n" +
          `Done: ${renderedReadout(resolved[0].readout)}\n` +
          "Not done: Sam Patel's block on Cell 1 in Line 1 Thu Sep 3, 10 am to 2 pm. Something went wrong with that one.",
      ),
    );
    expect(threadText()).not.toContain("Please try again.");
  });

  // DEF-0052's own report: a lot of four with the SECOND refused (one done,
  // one not done, two not tried) -- the brief's own example is a lot of
  // five; four real operators is what `buildCtx`'s own fixture roster gives
  // without inventing a name it would refuse to resolve, and two "Not
  // tried" items already proves the join (a THIRD would only repeat it).
  it("CB-lot-fail-2 (DEF-0052): a lot of four with the second refused -- one Done, one Not done, two Not tried", async () => {
    const onRunLot = vi.fn(async (_resolved: ResolvedAny[]): Promise<LotResult> => ({
      done: 1,
      error: "Sam Patel is not certified for Cell 1: missing Welding.",
    }));
    const { input } = renderBar(
      { assignments: [BLK1, BLK_SP, BLK_SO, BLK_PS] },
      null,
      null,
      {},
      { onRunLot },
    );

    fireEvent.change(input, {
      target: {
        value:
          "Unassign Operator 1 and Sam Patel and Sam Ortiz and Priya Shah from Cell 1 in Line 1 from 10 to 2",
      },
    });
    fireEvent.keyDown(input, { key: "Enter" });
    for (let i = 0; i < 4; i++) {
      fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    }
    await waitFor(() => expect(statusText()).toMatch(/^Ready to do 4 things: /));

    fireEvent.change(input, { target: { value: "yes" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(onRunLot).toHaveBeenCalledTimes(1));
    const [resolved] = onRunLot.mock.calls[0] as [ResolvedAny[]];

    await waitFor(() =>
      expect(threadText()).toContain(
        "I made 1 of the 4 changes.\n" +
          `Done: ${renderedReadout(resolved[0].readout)}\n` +
          "Not done: Sam Patel's block on Cell 1 in Line 1 Thu Sep 3, 10 am to 2 pm. Sam Patel is not certified for Welding, which Cell 1 needs.\n" +
          "Not tried: Sam Ortiz stays on Cell 1 in Line 1 Thu Sep 3, 10 am to 2 pm. Priya Shah stays on Cell 1 in Line 1 Thu Sep 3, 10 am to 2 pm.",
      ),
    );
  });

  // DEF-0052's own report: a lot whose FIRST is refused -- no "Done" line.
  it("CB-lot-fail-3 (DEF-0052): a lot of three whose first is refused -- 'I made none of the 3 changes.', no Done line, two Not tried", async () => {
    const onRunLot = vi.fn(async (_resolved: ResolvedAny[]): Promise<LotResult> => ({
      done: 0,
      error: "Operator 1 is not certified for Cell 1: missing Welding.",
    }));
    const { input } = renderBar(
      { assignments: [BLK1, BLK_SP, BLK_SO] },
      null,
      null,
      {},
      { onRunLot },
    );

    fireEvent.change(input, {
      target: {
        value: "Unassign Operator 1 and Sam Patel and Sam Ortiz from Cell 1 in Line 1 from 10 to 2",
      },
    });
    fireEvent.keyDown(input, { key: "Enter" });
    for (let i = 0; i < 3; i++) {
      fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    }
    await waitFor(() => expect(statusText()).toMatch(/^Ready to do 3 things: /));

    fireEvent.change(input, { target: { value: "yes" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(onRunLot).toHaveBeenCalledTimes(1));

    await waitFor(() =>
      expect(threadText()).toContain(
        "I made none of the 3 changes.\n" +
          "Not done: Operator 1's block on Cell 1 in Line 1 Thu Sep 3, 10 am to 2 pm. Operator 1 is not certified for Welding, which Cell 1 needs.\n" +
          "Not tried: Sam Patel stays on Cell 1 in Line 1 Thu Sep 3, 10 am to 2 pm. Sam Ortiz stays on Cell 1 in Line 1 Thu Sep 3, 10 am to 2 pm.",
      ),
    );
    expect(threadText()).not.toContain("Done:");
  });

  // DEF-0052's own report: a lot whose LAST is refused -- no "Not tried" line.
  it("CB-lot-fail-4 (DEF-0052): a lot of three whose last is refused -- no 'Not tried' line", async () => {
    const onRunLot = vi.fn(async (_resolved: ResolvedAny[]): Promise<LotResult> => ({
      done: 2,
      error: "Sam Ortiz is not certified for Cell 1: missing Welding.",
    }));
    const { input } = renderBar(
      { assignments: [BLK1, BLK_SP, BLK_SO] },
      null,
      null,
      {},
      { onRunLot },
    );

    fireEvent.change(input, {
      target: {
        value: "Unassign Operator 1 and Sam Patel and Sam Ortiz from Cell 1 in Line 1 from 10 to 2",
      },
    });
    fireEvent.keyDown(input, { key: "Enter" });
    for (let i = 0; i < 3; i++) {
      fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    }
    await waitFor(() => expect(statusText()).toMatch(/^Ready to do 3 things: /));

    fireEvent.change(input, { target: { value: "yes" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(onRunLot).toHaveBeenCalledTimes(1));
    const [resolved] = onRunLot.mock.calls[0] as [ResolvedAny[]];

    await waitFor(() =>
      expect(threadText()).toContain(
        "I made 2 of the 3 changes.\n" +
          "Done: " +
          resolved
            .slice(0, 2)
            .map((r) => renderedReadout(r.readout))
            .join(" ") +
          "\n" +
          "Not done: Sam Ortiz's block on Cell 1 in Line 1 Thu Sep 3, 10 am to 2 pm. Sam Ortiz is not certified for Welding, which Cell 1 needs.",
      ),
    );
    expect(threadText()).not.toContain("Not tried:");
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
      "Not done: Operator 1 is not certified for Cell 1, missing Welding. Say the reason to schedule anyway, or no.",
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
    expect(statusText()).toMatch(/^Ready to do 2 things: /);

    fireEvent.click(screen.getByRole("button", { name: "Do all 2" }));
    expect(onRunLot).toHaveBeenCalledTimes(1);
    await act(async () => {
      // The server's own area refusal, as `describeSchedulerError` words it.
      settle({
        done: 1,
        error:
          "That person belongs to a different part of the structure, so it can't be used here.",
      });
    });

    // DEF-0052 / R-432 (CONTRACT CHANGED, 28 Sept, CLAUDE.md §4: not wrong
    // when written): SEPARATE LINES, the count-only "Did k of N things; the
    // next failed: ..." replaced.
    expect(threadText()).toContain("I made 1 of the 2 changes.");
    const entry = postedEntry(fetchMock);
    // S194-D (CONTRACT CHANGED from lane E's interim, which printed the raw
    // refusal after the refused step's READOUT): the whole outcome, exactly
    // -- the refused change named by who and where, the area refusal in the
    // plant's words through the one rewriter.
    expect(entry.outcome).toBe(
      `I made 1 of the 2 changes.\nDone: ${entry.ran[0]}\n` +
        "Not done: Sam Patel's block on Cell 1 in Line 1 Thu Sep 3, 10 am to 2 pm. That person is not from this cell's area.",
    );
    // And only the step that actually ran.
    expect(entry.ran).toHaveLength(1);
  });

  it("CB-t-16: a single whose writer answers `popup` writes NOTHING under ran, keeps its entry OPEN until the pop-up answers (F-167), and is POSTED at the ask (DEF-0054)", () => {
    const fetchMock = stubFetch();
    const { onOpen, input, unmount } = renderBar({ runs: [] });
    onOpen.mockReturnValue({ kind: "popup", waitingFor: CREATE_WAITING });

    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onOpen).toHaveBeenCalledTimes(1);
    // DEF-0054 (CONTRACT CHANGED, CLAUDE.md 4: not wrong when written -- it
    // pinned the F-167 shape, "nothing is posted until the pop-up answers",
    // which is exactly the hole DEF-0054 names: a page closed with the pop-up
    // standing left NO line in the trace): the entry is posted the moment the
    // pop-up stands, saying what the board asked, DEF-0049's shape.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const asked = postedEntry(fetchMock);
    expect(asked.outcome).toBe(`popup: ${CREATE_WAITING}`);
    expect(asked.asked).toBe(CREATE_WAITING);
    expect(asked.ran).toEqual([]);
    // What the person sees meanwhile is the sentence, once, and never the
    // done-form readout (R-431).
    expect(threadText()).toContain(CREATE_WAITING);
    expect(threadText()).not.toMatch(/making Housing A/);

    // A pop-up that never answers is still flushed when the bar goes away
    // (F-157), carrying what was actually known -- as a correction of the
    // ask-time line, same `at`.
    unmount();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const entry = postedEntry(fetchMock);
    expect(entry.at).toBe(asked.at);
    expect(entry.revises).toBe(true);
    expect(entry.outcome).toBe(`popup: ${CREATE_WAITING}`);
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
    onOpen.mockReturnValue({ kind: "popup", waitingFor: CREATE_WAITING });

    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    const [, , report] = onOpen.mock.calls[0] as [
      ResolvedCommand,
      { x: number; y: number },
      (r: { kind: "written"; readout?: string }) => void,
    ];
    expect(document.body.textContent).toContain(CREATE_WAITING);
    // DEF-0054: the ask-time line is already in the file.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => report({ kind: "written", readout: "Operator 1 → Housing A · Cell 1" }));

    // ... and the answer CORRECTS it (same `at`, `revises`): one entry, two lines.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const entry = postedEntry(fetchMock);
    expect(entry.revises).toBe(true);
    expect(entry.outcome).toBe("written");
    expect(entry.ran).toEqual(["Operator 1 → Housing A · Cell 1"]);
    expect(document.body.textContent).not.toContain("Waiting:");
    expect(document.body.textContent).toContain("Written: Operator 1 → Housing A · Cell 1");
    // Reporting twice (a pop-up that submits and then closes) changes nothing.
    act(() => report({ kind: "written" }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
      "Not done: That person does not belong to this part of the structure.",
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
    // S196-A (F-239, R-434): CONTRACT CHANGED -- this used to pin "nothing is
    // posted until the writer has answered". The entry is posted at the ask
    // now (DEF-0049's shape) so a slow write leaves a line at once; what it
    // holds is the truth so far: nothing asked, nothing ran, waiting on the
    // board. The readout is `asked` only once the write is written.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const atAsk = postedEntry(fetchMock, 0);
    expect(atAsk.asked).toBeNull();
    expect(atAsk.ran).toEqual([]);
    expect(atAsk.outcome).toBe("writing");
    await act(async () => {});
    let entry = postedEntry(fetchMock);
    expect(entry.outcome).toBe("written");
    expect(entry.ran).toHaveLength(1);
    expect(entry.asked).toBe(
      "Operator 1 is on Cell 1 in Line 1 " +
        formatDayLabel(new Date("2026-09-03T00:00:00Z"), "d_mon_yyyy", "UTC") +
        " from 10 am to 2 pm, making Housing A.",
    );

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
    // S196-A (F-239, R-431): a refused write never claims the readout -- the
    // bar asked nothing and printed nothing as done.
    expect(entry.asked).toBeNull();
    expect(threadText()).not.toContain("making Housing A");
    expect(threadText()).toContain(
      "Not done: That person does not belong to this part of the structure.",
    );
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
    // written, still not over, and the thread says what it is waiting on now
    // (DEF-0054: the one plain sentence, posted at the ask).
    const SPLIT = splitWaiting("Operator 1");
    act(() => report({ kind: "handed_off", what: SPLIT }));
    // Posted at EACH ask: the create pop-up's own, then the split pop-up's --
    // one entry, the second line a correction of the first.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(postedEntry(fetchMock).outcome).toBe(`popup: ${SPLIT}`);
    expect(postedEntry(fetchMock).revises).toBe(true);
    expect(document.body.textContent).toContain(SPLIT);

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

    act(() => report({ kind: "handed_off", what: splitWaiting("Operator 1") }));
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
    // S196-A (F-239): CONTRACT CHANGED -- the entry is posted at the ask (call
    // index 0), waiting on the board, where it used to be posted only when
    // the next sentence flushed it.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A second sentence, before the first writer answered: the first entry is
    // flushed as it stands -- ran empty, still waiting (call index 1, a
    // correction of index 0). DEF-0049 (CONTRACT CHANGED, 28 Sept):
    // "gibberish" ALSO asks its own shape-hint question now, posted at the ask
    // (`traceQuestionStatus`'s new call) -- a SECOND, separate entry, call
    // index 2.
    fireEvent.change(input, { target: { value: "gibberish" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const firstLine = postedEntry(fetchMock, 1);
    expect(firstLine.heard).toBe(P1_SENTENCE);
    expect(firstLine.ran).toEqual([]);
    expect(firstLine.outcome).toBe("writing");
    const gibberishAsked = postedEntry(fetchMock, 2);
    expect(gibberishAsked.heard).toBe("gibberish");
    expect(gibberishAsked.asked).toBe(SHAPE);

    // Now the first sentence's write lands.
    await act(async () => {
      settleFirst({ kind: "written" });
    });

    // The file gets a CORRECTED line for P1's OWN entry -- same `at`,
    // `revises: true` -- since it is append-only and the first line is
    // already in it; call index 3, after gibberish's own ask-time post.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const corrected = postedEntry(fetchMock, 3);
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

    act(() => reporter({ kind: "handed_off", what: splitWaiting("Operator 1") }));
    expect(document.body.textContent).toContain(splitWaiting("Operator 1"));
    expect(fetchMock).toHaveBeenCalledTimes(2); // DEF-0054: posted at each ask

    fireEvent.change(input, { target: { value: "no" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onCancelWord).toHaveBeenCalledTimes(1);
    // Never the "nothing standing" answer -- the pop-up claimed the word.
    expect(statusText()).not.toBe("Nothing to cancel.");
    const entry = postedEntry(fetchMock);
    expect(entry.outcome).toBe("cancelled");
    expect(entry.ran).toEqual([]);
    expect(document.body.textContent).toContain("Cancelled. Nothing changed.");
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
    // S194-D (R-432/R-459, CONTRACT CHANGED): the one rewriter now puts a
    // permission refusal in the plant's words.
    expect(threadText()).toContain("Not done: You cannot change that from here.");
    const entry = postedEntry(fetchMock);
    expect(entry.outcome).toBe("refused: You cannot change that from here.");
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
    fireEvent.click(
      screen.getByRole("button", { name: "Change Housing A on Cell 1, 10 am to 2 pm" }),
    );
    await act(async () => {});

    expect(onRetime).toHaveBeenCalledTimes(1);
    expect(threadText()).toContain("Not done: That block is no longer on the board.");
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
    fireEvent.click(screen.getByRole("button", { name: "Change the Housing A job, 8 am to 4 pm" }));
    await act(async () => {});

    expect(onRetimeRun).toHaveBeenCalledTimes(1);
    expect(threadText()).toContain("Not done: That job is no longer on the board.");
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
    expect(threadText()).toContain("Not done: You cannot place anyone on this board.");
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

    expect(threadText()).toContain("Not done: no answer from the writer");
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
    // Reviewer fix (S72-b's own known hole): the move's entry is filed into
    // the thread but stays OPEN, unposted -- nothing has gone over the wire
    // for it yet, only the pending rerun is queued.
    expect(fetchMock).not.toHaveBeenCalled();

    // A SPOKEN final sentence -- never through `handleChange`, the one path
    // that already cleared the pending rerun before this fix. `startTrace`
    // flushes the still-open "yesterday" move entry first (a new sentence is
    // one of the three life-end triggers, unchanged) -- WITH NO WRITE
    // attached, since the rerun never got the chance to run it -- then opens
    // its own fresh entry for this sentence.
    fire.final(P1_SENTENCE);
    expect(onOpen).toHaveBeenCalledTimes(1);

    // The window lands NOW -- "yesterday"'s own target is on the board.
    // Pre-fix, the effect watching `ctx` would find `pendingRerunRef` still
    // set and run the STALE "yesterday" command here, a second `onOpen` call
    // that would overwrite the spoken sentence's own trace entry.
    rerenderCtx({ days: SHIFTED_BACK_ONE_DAY, todayIndex: 1 });

    expect(onOpen).toHaveBeenCalledTimes(1);

    // TWO entries now: the abandoned move (flushed empty by the spoken
    // sentence's own `startTrace`) and the spoken sentence's own, intact --
    // its own `read`/`ran`/`outcome`, never overwritten by the stale
    // "yesterday" command's.
    const entries = fetchMock.mock.calls.map((call: unknown[]) => {
      const [, init] = call as [string, RequestInit];
      return JSON.parse(init.body as string) as TraceEntry;
    });
    expect(entries).toHaveLength(2);
    const movedEntry = entries.find((e) => e.heard === YESTERDAY_SENTENCE);
    expect(movedEntry).toBeTruthy();
    expect(movedEntry?.asked).toBe("Moved the board to yesterday.");
    expect(movedEntry?.answered).toBe("auto");
    // The rerun never ran against this entry -- dropped by the spoken
    // sentence, exactly as F-169's own guard intends.
    expect(movedEntry?.ran).toHaveLength(0);
    expect(movedEntry?.outcome).toBeNull();
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
    expect(threadText()).toContain("Not done: Nothing was heard.");
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
    expect(threadText()).toContain("Not done: a lot was still writing; the sentence was dropped");
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
    expect(threadText()).toContain("Not done: a lot was still writing; the sentence was dropped");
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
    expect(threadText()).toContain("Not done: Nothing was heard.");
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

  // CH-scroll (F-192, R-427/R-429): `.threadBody` used to bottom-anchor its
  // turns with `justify-content: flex-end`, which in a flex column pushes
  // whatever overflows ABOVE the box's own top edge -- outside the
  // scrollbar's reach (`CommandBar.module.css`'s own comment on the fix).
  // jsdom computes no layout at all (no scroll height, no flex line
  // position), so this cannot measure where the oldest turn actually sits
  // the way a browser could -- the same limit `TB-13` in
  // `boardToolbar.test.tsx` documents for R-447. What IS honestly testable
  // from here: (1) every one of many turns is genuinely IN the DOM inside
  // the one scrolling element (`overflow-y: auto` has something to scroll,
  // and nothing above it is silently dropped or windowed), and (2) the
  // stylesheet's own `.threadBody` rule no longer declares the offending
  // `flex-end` value and a `.turn:first-child` rule now carries the
  // replacement (`margin-top: auto`) -- the same "read the module's own
  // source text" technique `fieldStandard.test.ts` uses for a property value
  // jsdom cannot compute either. The maintainer's own look at the real
  // browser (this brief's §1, reported below) is what actually proves
  // scrolling; this pin only stops a future edit from quietly bringing
  // `flex-end` back.
  it("CH-scroll: many turns all render inside the one scrolling threadBody, and the stylesheet no longer bottom-anchors it with flex-end", () => {
    stubFetch();
    // F-204: the store prunes turns older than HISTORY_MAX_AGE_MS against the
    // REAL clock, so fixed "at" stamps went stale the day after this pin was
    // written and the oldest fifteen turns vanished before the render. The
    // clock is frozen just after the newest stamp; restored in the finally.
    vi.setSystemTime(new Date("2026-09-22T18:00:00.000Z"));
    try {
      const conversation = createConversationStore();
      for (let i = 0; i < 20; i++) {
        conversation.getState().appendTurn({
          at: `2026-09-22T17:${String(30 + i).padStart(2, "0")}:00.000Z`,
          heard: `Turn number ${i}`,
          by: "typed",
          read: `read ${i}`,
          asked: `asked ${i}`,
          offered: [],
          answered: "auto",
          ran: [`ran ${i}`],
          outcome: "written",
        });
      }
      render(
        <CommandBar
          ctx={buildCtx({ runs: [] })}
          hasPendingCreate={false}
          dateFormat="d_mon_yyyy"
          zone="UTC"
          reader={null}
          recognizer={null}
          onOpen={vi.fn().mockReturnValue(WRITTEN)}
          onRetime={vi.fn().mockReturnValue(WRITTEN)}
          onBook={vi.fn().mockReturnValue(WRITTEN)}
          onRetimeRun={vi.fn().mockReturnValue(WRITTEN)}
          onUnassign={vi.fn().mockReturnValue(WRITTEN)}
          onMove={vi.fn().mockReturnValue(WRITTEN)}
          onSetHeadcount={vi.fn().mockReturnValue(WRITTEN)}
          onRunLot={vi.fn()}
          onHighlight={vi.fn()}
          onShowDay={vi.fn()}
          conversation={conversation}
        />,
      );

      const threadBody = document.querySelector('[class*="threadBody"]') as HTMLElement;
      expect(threadBody).toBeTruthy();
      // Every turn, oldest first, is actually in the DOM inside it -- nothing
      // above the newest one is dropped or lazily windowed.
      for (let i = 0; i < 20; i++) {
        expect(threadBody.textContent).toContain(`Turn number ${i}`);
      }
      expect(threadBody.getAttribute("role")).toBe("log");

      // The stylesheet itself: `.threadBody` no longer carries `flex-end`, and
      // `.turn:first-child` carries the replacement. Comments stripped first
      // (`fieldStandard.test.ts`'s own warning: a matcher that read comments
      // would flag this file's OWN prose about the fix, which names the very
      // declaration being matched).
      const cssPath = path.join(
        process.cwd(),
        "src/features/board/components/CommandBar.module.css",
      );
      const raw = fs.readFileSync(cssPath, "utf8");
      const withoutComments = raw.replace(/\/\*[\s\S]*?\*\//g, "");
      const threadBodyRule = /\.threadBody\s*\{[^}]*\}/.exec(withoutComments)?.[0] ?? "";
      expect(threadBodyRule).not.toBe("");
      expect(threadBodyRule).not.toMatch(/flex-end/);
      const firstChildRule = /\.turn:first-child\s*\{[^}]*\}/.exec(withoutComments)?.[0] ?? "";
      expect(firstChildRule).toMatch(/margin-top:\s*auto/);
    } finally {
      vi.useRealTimers();
    }
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
      "Not done: That person does not belong to this part of the structure.",
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
      "Not done: Sam Patel would be over the cap today (110% of 100%). Nothing changed.",
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
    // F-207 (CONTRACT CHANGED, CLAUDE.md §4): a button press now draws its
    // own answer bubble too, the same one a spoken/typed answer draws (the
    // chip tick alone, on the bubble above, was not enough to read voice
    // and button the same way -- CH-answer-2, below, is this fix's own
    // pin). It sits between the question and the result, so the result is
    // now bs[3], not bs[2].
    expect(bs[2]).toEqual({ side: "you", text: "Sam Patel" });
    expect(bs[3].side).toBe("board");
    expect(bs[3].text).toContain("Written:");
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

  // F-207 (the maintainer's spoken walk, 23 Sept, trace 20:01:17 -> 20:01:49):
  // a button press already reads back through the chip tick (CP-2, above),
  // but a VOICE or TYPED answer folded straight into `turn.answered` with no
  // bubble at all -- a "say or type yes" question has no chips to tick in
  // the first place, so nothing on screen changed until the result line
  // landed, and the person said "yes" again and got "Nothing to say yes
  // to." CH-answer-1..3 pin the fix (`turn.answered !== null &&
  // turn.answered !== "auto"` draws a "you" bubble reading the literal
  // answer); CH-answer-4 is CH-scroll, above -- every one of its 20 turns is
  // built with `answered: "auto"` and empty `offered`, so this fix must
  // (and does, per that pin's own still-green run) draw exactly as many
  // bubbles as it always did.
  it("CH-answer-1: a typed 'yes' to a confirm question (no chips at all) shows a 'you' bubble reading 'yes', between the question and the result", () => {
    const { input } = renderBar({ assignments: [BLK1] });
    fireEvent.change(input, { target: { value: UNASSIGN_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: "yes" } });
    fireEvent.keyDown(input, { key: "Enter" });

    const [turn] = threadTurns();
    const bs = bubbles(turn);
    expect(bs[0]).toEqual({ side: "you", text: UNASSIGN_SENTENCE });
    expect(bs[1].side).toBe("board");
    expect(bs[1].text).toContain("say or type yes to do it, no to leave it.");
    // The one chip-less question kind F-207's own trace named: nothing
    // above this bubble could have ticked, so this is the ONLY place the
    // answer shows at all.
    expect(bs[2]).toEqual({ side: "you", text: "yes" });
    expect(bs[3].side).toBe("board");
    expect(bs[3].text).toContain("Written:");
  });

  it("CH-answer-1b: a SPOKEN final 'yes' (CB-yes-5's own setup) shows the identical bubble a typed 'yes' does", () => {
    const { recognizer, fire } = makeFakeRecognizer();
    const { input } = renderBar({ assignments: [BLK1] }, null, recognizer);
    fireEvent.change(input, { target: { value: UNASSIGN_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Speak a sentence" }));
    fire.final("yes");

    const [turn] = threadTurns();
    const bs = bubbles(turn);
    expect(bs[2]).toEqual({ side: "you", text: "yes" });
    expect(bs[3].side).toBe("board");
    expect(bs[3].text).toContain("Written:");
  });

  it("CH-answer-2: a button-picked candidate draws the same answer bubble a spoken/typed answer would, and keeps its own chip tick too", () => {
    stubFetch();
    const { input } = renderBar({ runs: [] });
    fireEvent.change(input, {
      target: { value: "assign Sam to Housing A on Cell 1 in Line 1 from 10 to 2" },
    });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Sam Patel" }));

    const [turn] = threadTurns();
    const bs = bubbles(turn);
    // The tick stays on the chip inside the question's own bubble (CP-2) --
    // this is the SAME turn's new bubble alongside it, not a replacement.
    expect(bs[1].side).toBe("board");
    expect(bs[1].text).toContain("Sam Patel ✓");
    expect(bs[2]).toEqual({ side: "you", text: "Sam Patel" });
    expect(bs[3].side).toBe("board");
    expect(bs[3].text).toContain("Written:");
  });

  it('CH-answer-3: a turn with no real question (an unambiguous single that ran straight off its own readout, `answered: "auto"`) shows no answer bubble', () => {
    const { input } = renderBar({ runs: [] });
    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    const [turn] = threadTurns();
    const bs = bubbles(turn);
    // Exactly the "you" (heard) bubble and the board side's own two
    // (the readout `asked`, then the "Written:" result) -- no third "you"
    // bubble for the "auto" sentinel `settleWrite`'s own doc names ("never
    // asked anything and never answered by a word or a button").
    expect(bs.filter((b) => b.side === "you")).toHaveLength(1);
    expect(bs).toHaveLength(3);
  });

  // F-207 review fix (the maintainer, 23 Sept): "escape" is `handleKeyDown`'s
  // own sentinel for a CANCEL, not a word the person said -- `NON_ANSWER_
  // SENTINELS` (`CommandBar.tsx`, above `turnResultLine`) excludes it
  // alongside "auto" for exactly that reason.
  it("CH-answer-5: a question cancelled by Escape shows no answer bubble", () => {
    const { input } = renderBar({ assignments: [BLK1] });
    fireEvent.change(input, { target: { value: UNASSIGN_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    fireEvent.keyDown(input, { key: "Escape" });

    const [turn] = threadTurns();
    const bs = bubbles(turn);
    // Only the heard bubble is "you" -- no second one reading "escape".
    expect(bs.filter((b) => b.side === "you")).toHaveLength(1);
    expect(bs.some((b) => b.text === "escape")).toBe(false);
  });

  describe("S71-i review", () => {
    it("a spoken override REASON (F-197's path) shows as its own 'you' bubble, and the trace is unaffected", () => {
      const fetchMock = stubFetch();
      const { input } = renderBar({
        certificateGaps: (operatorId: string, nodeId: string) =>
          operatorId === "op1" && nodeId === "c1a"
            ? [{ skill: "Welding", state: "never-trained" as const }]
            : [],
        eligibilityPolicy: () => "warn",
      });
      fireEvent.change(input, { target: { value: P1_SENTENCE } });
      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.change(input, { target: { value: "Covering an absence" } });
      fireEvent.keyDown(input, { key: "Enter" });

      const [turn] = threadTurns();
      const bs = bubbles(turn);
      expect(bs[0]).toEqual({ side: "you", text: P1_SENTENCE });
      expect(bs[1].side).toBe("board");
      expect(bs[1].text).toContain("not certified");
      expect(bs[2]).toEqual({ side: "you", text: "Covering an absence" });
      expect(bs[3].side).toBe("board");
      expect(bs[3].text).toContain("Written:");

      const entry = postedEntry(fetchMock);
      expect(entry.answered).toBe("Covering an absence");
      expect(entry.outcome).toBe("written");
    });
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
    expect(log2?.textContent).toContain("Not done: Nope.");
    expect(statusText()).toBe("");
  });
});

describe("CB-nc: a not_certified question (S61-a, R-425, F-155)", () => {
  // CB-nc-8 (F-197, below) is the one case in this block that stubs `fetch`
  // (to read the trace it posts) -- unstubbed after every test here, same
  // as the "CH"/"CB-t" describe blocks' own `afterEach`, so a later
  // `describe` never inherits a stub this block set.
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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
      "Not done: Operator 1 is not certified for Cell 1, missing Welding. Say the reason to schedule anyway, or no.",
    );
  });

  // S63-a review fix (CP-5, CLAUDE.md §4): `onOpen` is held pending -- the
  // "· override: …" suffix (`runCommand`'s own `suffix` argument) lives only
  // on the live, optimistic status line, never in `entry.ran`/the thread; a
  // synchronous write would file (and clear) it in the same tick.
  it("CB-nc-2: a reason runs with the override on the resolved command -- onOpen receives it, the readout is suffixed", async () => {
    const { onOpen, input } = renderBar(notCertifiedCtx("warn"));
    const write = pendingWrite();
    onOpen.mockReturnValue(write.promise);
    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpen).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "Covering an absence" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onOpen).toHaveBeenCalledTimes(1);
    const [resolved] = onOpen.mock.calls[0] as [ResolvedCommand, { x: number; y: number }];
    expect(resolved.override).toEqual({ reason: "Covering an absence" });
    // S196-A (F-239, R-425, R-459): "Working…" until the writer answers (no
    // readout is printed as done before it is); then the reason the person
    // typed is read back on the WRITTEN readout -- the thread's Written line --
    // in the same words as before, and the trace's `ran` carries it too.
    expect(statusText()).toBe("Working…");
    await write.settle();
    expect(threadText()).toContain(
      "Written: Operator 1 is on Cell 1 in Line 1 Thu Sep 3 from 10 am to 2 pm, making Housing A. The reason given: Covering an absence.",
    );
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

    expect(statusText()).toBe("Not done: Operator 1 is not certified for Cell 1, missing Welding.");

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
        "Not done: Operator 1 is not certified for Cell 1, missing Welding. Nothing changed.",
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
  it("CB-nc-7: a person failing BOTH gates is asked twice, and the readout names BOTH overrides", async () => {
    // Uncertified for the cell AND not from its area -- the two gates run
    // one after the other (certificate first), so the sentence is answered
    // twice before anything is written.
    const { onOpen, input } = renderBar({
      runs: [],
      certificateGaps: () => [{ skill: "Welding", state: "never-trained" as const }],
      eligibilityPolicy: () => "warn" as const,
      outsideArea: () => true,
    });
    const write = pendingWrite();
    onOpen.mockReturnValue(write.promise);

    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(statusText()).toBe(
      "Not done: Operator 1 is not certified for Cell 1, missing Welding. Say the reason to schedule anyway, or no.",
    );

    fireEvent.change(input, { target: { value: "covering for Sam" } });
    fireEvent.keyDown(input, { key: "Enter" });
    // The certificate answer is kept, so the second question is a NEW one --
    // never the first asked again.
    expect(statusText()).toBe(
      "Not done: Operator 1 is not from Cell 1's area. Say the reason to schedule anyway, or no.",
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
    // S196-A (F-239): "Working…" until the writer answers; both reasons are
    // then read back on the written readout, in the order they were asked.
    expect(statusText()).toBe("Working…");
    await write.settle();
    expect(threadText()).toContain(
      "Written: Operator 1 is on Cell 1 in Line 1 Thu Sep 3 from 10 am to 2 pm, making Housing A. The reason given: covering for Sam. The area reason given: short-handed on Line 1.",
    );
  });

  // CB-nc-8 (F-197, R-425/R-434, the spoken walk 22 Sept): typed, a reason
  // answers a standing warn question and runs the override (CB-nc-2, above).
  // Spoken, the walk's own trace shows the same reason recorded as
  // `answered` with `outcome: null` -- nothing written. Root cause (two
  // guards, both fixed together): `startListening`'s own mic-press guard
  // only preserved a `blockHighlight` question, so pressing the mic to
  // ANSWER a `not_certified` question wiped it before a word was said; and
  // `onInterim` unconditionally cleared `heldRef.current` (the command the
  // reason re-resolves), so even with the question surviving, the final
  // transcript's own `awaitingOverrideReason` branch found no held command
  // and returned having already set `answered` but never `outcome`. This
  // drives the SAME fake recogniser the CB-t/CB-mic cases use through both:
  // a standing warn question, an interim result while the reason is still
  // being spoken (the exact moment that used to drop `heldRef`), then the
  // final transcript.
  it("CB-nc-8: a spoken answer to a standing warn question runs the override exactly as a typed one, and the trace shows both answered and the outcome", () => {
    const fetchMock = stubFetch();
    const { recognizer, fire } = makeFakeRecognizer();
    const { onOpen, input } = renderBar(notCertifiedCtx("warn"), null, recognizer);
    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(statusText()).toBe(
      "Not done: Operator 1 is not certified for Cell 1, missing Welding. Say the reason to schedule anyway, or no.",
    );

    fireEvent.click(screen.getByRole("button", { name: "Speak a sentence" }));
    // The mic press alone must not wipe the standing question (the first of
    // the two bugs: the guard used to preserve only a `blockHighlight`
    // question).
    expect(statusText()).toBe(
      "Not done: Operator 1 is not certified for Cell 1, missing Welding. Say the reason to schedule anyway, or no.",
    );

    // An interim result while the reason is still being spoken (the second
    // bug: this used to null out `heldRef.current` unconditionally).
    fire.interim("Covering");
    fire.final("Covering an absence");

    expect(onOpen).toHaveBeenCalledTimes(1);
    const [resolved] = onOpen.mock.calls[0] as [ResolvedCommand, { x: number; y: number }];
    expect(resolved.override).toEqual({ reason: "Covering an absence" });

    const entry = postedEntry(fetchMock);
    expect(entry.answered).toBe("Covering an absence");
    expect(entry.outcome).toBe("written");
  });
});

// CB-stale (F-197 review fix, the reviewer, 22 Sept): F-197 widened
// `startListening`'s own mic-press guard from "preserve a blockHighlight
// question" to "preserve anything `answerTakes` recognises" -- an ambiguous
// name, a not_certified reason, a lot's yes/no, all now genuinely survive a
// mic press. That widening opened a second door nobody walked through: a
// browser recognition session keeps running (nothing here ever calls its own
// `stop()`) until it produces a result, so a session started while one of
// these NOW-preserved questions stood can still be alive after the SAME
// question is instead answered a different way (typing, in this pin) --
// `onFinal`'s own callback was created back when `startListening` ran and
// closed over `status` as it stood THEN, so its eventual, leftover final
// transcript was matched against a question that had already been answered
// and moved on from. Root cause and fix: `submitText` decides what a
// transcript MEANS (a reason, a candidate pick, a lot's yes, a new sentence)
// by reading `status` -- it now reads it fresh off the store
// (`store.getState().status`) as its very first line, rather than closing
// over whatever render's `status` `submitText` happened to be defined
// against, so a late spoken result is judged against what is standing NOW,
// never a stale snapshot.
describe("CB-stale: a leftover voice session must not re-answer an already-resolved question (F-197 review fix)", () => {
  it("CB-stale-1: an ambiguous question survives a mic press (F-197's own widening); the person types the answer instead; the mic's own leftover final must not re-pick a candidate against the question it already answered", () => {
    const { recognizer, fire } = makeFakeRecognizer();
    const { onOpen, input } = renderBar({}, null, recognizer);
    fireEvent.change(input, {
      target: { value: "assign Sam to Housing A on Cell 1 in Line 1 from 10 to 2" },
    });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(statusText()).toBe('Which person? "Sam" matches 2:');

    // Mic pressed -- the widened guard now preserves this ambiguous
    // question (it did not before F-197: no blockHighlight on it).
    fireEvent.click(screen.getByRole("button", { name: "Speak a sentence" }));

    // The person answers by TYPING instead of finishing the voice turn --
    // the mic is still "listening" (never stopped, never produced a final).
    fireEvent.change(input, { target: { value: "Sam Patel" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledTimes(1);
    const [resolved1] = onOpen.mock.calls[0] as [ResolvedCommand, { x: number; y: number }];
    expect(resolved1.operatorId).toBe("sp");

    // A LEFTOVER final now arrives from the still-active (stale) voice
    // session -- e.g. the browser recogniser finally settles on words heard
    // before the person switched to typing. The question it closed over is
    // long gone (already answered above). Pre-fix this matched the SAME
    // candidate list and wrote a second block for a different person onto
    // the same cell -- a genuine double write, found by the reviewer.
    fire.final("Sam Ortiz");

    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// S194-D second pass -- the bar's half of R-461 (the night shift questions),
// R-409 (the absence record), and R-432's answer said properly.
// ---------------------------------------------------------------------------

describe("CB-night: R-461's two questions in the bar (S194-D)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const w = (d: number, m: number): number => d * 1440 + m;
  // Cell 2 (c2, one name on the board). Today is Thursday (index 3).
  const SAM_INTO: ContextAssignment = {
    ...BLK1,
    id: "samInto",
    nodeId: "c2",
    operatorId: "sp",
    startMin: w(2, 1320), // Wed 22:00
    endMin: w(3, 360), // Thu 06:00
    label: "22:00–06:00",
  };
  const ORTIZ_OUT: ContextAssignment = {
    ...BLK1,
    id: "ortizOut",
    nodeId: "c2",
    operatorId: "so",
    startMin: w(3, 1320), // Thu 22:00
    endMin: w(4, 360), // Fri 06:00
    label: "22:00–06:00",
  };
  // CONTRACT CHANGED (R-461 amended 29 Sept): the question now ends "Say cancel to stop."
  const Q_PREV =
    "Sam Patel's night shift started Wednesday at 10 pm. Clear Wednesday's part too, 10 pm to midnight? Say cancel to stop.";
  // CONTRACT CHANGED (R-461 amended 29 Sept): the question now ends "Say cancel to stop."
  const Q_NEXT =
    "Sam Ortiz's night shift runs into Friday. Clear Friday's part too, midnight to 6 am? Say cancel to stop.";

  it("CB-night-1: one sentence, both questions in order -- Yes pressed, 'no' typed (an answer here, never the cancel) -- ONE trace entry holding both asks and both answers", async () => {
    const fetchMock = stubFetch();
    const onRunLot = vi.fn(async (resolved: ResolvedAny[]): Promise<LotResult> => ({
      done: resolved.length,
      error: null,
    }));
    const { input } = renderBar(
      { assignments: [SAM_INTO, ORTIZ_OUT] },
      null,
      null,
      {},
      { onRunLot },
    );
    fireEvent.change(input, { target: { value: "clear Cell 2 today" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toBe(Q_PREV);
    expect(input.placeholder).toContain("yes or no");
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));

    expect(statusText()).toBe(Q_NEXT);
    fireEvent.change(input, { target: { value: "no" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toMatch(/^Ready to do 2 things: /);
    expect(statusText()).toContain("1. Sam Patel is off Cell 2 ");
    expect(statusText()).toContain(
      "2. Sam Ortiz's night shift on Cell 2 keeps its Friday part, midnight to 6 am; Thursday's part, 10 pm to midnight, is cleared.",
    );
    const mid = postedEntry(fetchMock);
    expect(mid.asked?.split("\n").slice(0, 2)).toEqual([Q_PREV, Q_NEXT]);
    expect(mid.answered).toBe("Yes\nNo");

    fireEvent.click(screen.getByRole("button", { name: "Do all 2" }));
    await waitFor(() => expect(onRunLot).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(threadText()).toContain("Done, 2 things."));
    const last = postedEntry(fetchMock);
    expect(last.asked?.split("\n")[0]).toBe(Q_PREV);
    expect(last.asked?.split("\n")[1]).toBe(Q_NEXT);
    expect(last.answered).toBe("Yes\nNo\nDo all 2");
    expect(last.outcome).toBe("Done, 2 things.");
  });

  it("CB-night-2: the Yes and No buttons are one group, drawn from the one pair style (R-447)", () => {
    renderBar({ assignments: [SAM_INTO] });
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "clear Cell 2 today" } });
    fireEvent.keyDown(input, { key: "Enter" });
    const yes = screen.getByRole("button", { name: "Yes" });
    const no = screen.getByRole("button", { name: "No" });
    expect(yes.parentElement).toBe(no.parentElement);
    expect(yes.parentElement?.className).toMatch(/answerPair/);
  });

  it("CB-night-3: a cancel word other than 'no' still drops the sentence at a night shift question", () => {
    const { input } = renderBar({ assignments: [SAM_INTO] });
    fireEvent.change(input, { target: { value: "clear Cell 2 today" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: "cancel" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(threadText()).toContain("Cancelled");
    expect(screen.queryByRole("button", { name: "Yes" })).toBeNull();
  });

  // R-461 as amended (the maintainer, 29 Sept): every night shift question
  // ends "Say cancel to stop.", and a cancel -- typed, or Escape -- at EITHER
  // question drops the whole sentence and writes nothing. The trace entry
  // holds the questions asked, the answers given before the cancel, and the
  // cancel itself.
  it("CB-night-5: 'cancel' at the FIRST question -- nothing written; the trace holds the question and the cancel", () => {
    const fetchMock = stubFetch();
    const { input, onUnassign, onRunLot } = renderBar({ assignments: [SAM_INTO, ORTIZ_OUT] });
    fireEvent.change(input, { target: { value: "clear Cell 2 today" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(statusText()).toBe(Q_PREV);
    fireEvent.change(input, { target: { value: "cancel" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(threadText()).toContain("Cancelled");
    expect(onUnassign).not.toHaveBeenCalled();
    expect(onRunLot).not.toHaveBeenCalled();
    const entry = postedEntry(fetchMock);
    expect(entry.asked).toBe(Q_PREV);
    expect(entry.answered).toBe("cancel");
    expect(entry.outcome).toBe("cancelled");
  });

  it("CB-night-6: 'cancel' at the SECOND question, after Yes to the first -- the whole sentence drops, nothing written; the trace holds both questions, the Yes and the cancel", () => {
    const fetchMock = stubFetch();
    const { input, onUnassign, onRunLot } = renderBar({ assignments: [SAM_INTO, ORTIZ_OUT] });
    fireEvent.change(input, { target: { value: "clear Cell 2 today" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    expect(statusText()).toBe(Q_NEXT);
    fireEvent.change(input, { target: { value: "cancel" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(threadText()).toContain("Cancelled");
    expect(screen.queryByRole("button", { name: "Yes" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Do all/ })).toBeNull();
    expect(onUnassign).not.toHaveBeenCalled();
    expect(onRunLot).not.toHaveBeenCalled();
    const entry = postedEntry(fetchMock);
    expect(entry.asked?.split("\n")).toEqual([Q_PREV, Q_NEXT]);
    expect(entry.answered).toBe("Yes\ncancel");
    expect(entry.outcome).toBe("cancelled");
  });

  it("CB-night-7: Escape at the FIRST question drops the sentence, nothing written; the trace says escape", () => {
    const fetchMock = stubFetch();
    const { input, onUnassign, onRunLot } = renderBar({ assignments: [SAM_INTO, ORTIZ_OUT] });
    fireEvent.change(input, { target: { value: "clear Cell 2 today" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(statusText()).toBe(Q_PREV);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("button", { name: "Yes" })).toBeNull();
    expect(onUnassign).not.toHaveBeenCalled();
    expect(onRunLot).not.toHaveBeenCalled();
    const entry = postedEntry(fetchMock);
    expect(entry.asked).toBe(Q_PREV);
    expect(entry.answered).toBe("escape");
  });

  it("CB-night-8: Escape at the SECOND question, after No to the first -- the whole sentence drops, nothing written; the trace keeps the No before the escape", () => {
    const fetchMock = stubFetch();
    const { input, onUnassign, onRunLot } = renderBar({ assignments: [SAM_INTO, ORTIZ_OUT] });
    fireEvent.change(input, { target: { value: "clear Cell 2 today" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "No" }));
    expect(statusText()).toBe(Q_NEXT);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("button", { name: "Yes" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Do all/ })).toBeNull();
    expect(onUnassign).not.toHaveBeenCalled();
    expect(onRunLot).not.toHaveBeenCalled();
    const entry = postedEntry(fetchMock);
    expect(entry.asked?.split("\n")).toEqual([Q_PREV, Q_NEXT]);
    expect(entry.answered).toBe("No\nescape");
  });

  // CONTRACT CHANGED (R-461 amended 29 Sept): the re-ask was "Say yes or
  // no."; it now names the way out as the question itself does. Only a
  // confirm word that is not a yes ("remove it", "move it") reaches this
  // re-ask -- any other text is read as a new sentence, as at every question.
  it("CB-night-9: a confirm word that is not a yes re-asks, naming the way out", () => {
    const { input, onUnassign } = renderBar({ assignments: [SAM_INTO] });
    fireEvent.change(input, { target: { value: "clear Cell 2 today" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: "remove it" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(statusText()).toBe("Say yes or no, or cancel to stop.");
    expect(screen.getByRole("button", { name: "Yes" })).toBeTruthy();
    expect(onUnassign).not.toHaveBeenCalled();
  });

  it("CB-night-4 (R-455): the answers already given survive the board moving and the sentence re-running -- the question is not asked again", () => {
    // A one-day board (Thursday). Sam Patel's block and his job run from
    // Wednesday 22:00; Sam Ortiz sits on the same job on Wednesday morning,
    // outside the job's own hours -- so a Yes removes the job whole, which
    // must list Sam Ortiz, whose day is off this board: the bar moves the
    // board and re-runs.
    const thu: BoardDay[] = [{ index: 0, iso: "2026-09-03", weekday: 4 }];
    const run: ContextRun = {
      ...RUN1,
      id: "nightJob",
      nodeId: "c2",
      startMin: -120,
      endMin: 360,
      label: "Housing A 22:00–06:00",
      span: "22:00–06:00",
      headcount: 2,
    };
    const crew1: ContextAssignment = {
      ...SAM_INTO,
      id: "crew1",
      runId: "nightJob",
      startMin: -120,
      endMin: 360,
    };
    const crew2: ContextAssignment = {
      ...BLK1,
      id: "crew2",
      nodeId: "c2",
      operatorId: "so",
      runId: "nightJob",
      startMin: -840,
      endMin: -720,
      label: "10:00–12:00",
    };
    const { input, onShowDay, rerenderCtx } = renderBar({
      days: thu,
      todayIndex: 0,
      assignments: [crew1, crew2],
      runs: [run],
    });
    fireEvent.change(input, { target: { value: "clear Cell 2 today" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(statusText()).toMatch(/^Sam Patel's night shift started Wednesday at 10 pm\./);
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    expect(onShowDay).toHaveBeenCalledWith("2026-09-02");

    // The board lands on Wednesday and Thursday; the same rows, re-based.
    const two: BoardDay[] = [
      { index: 0, iso: "2026-09-02", weekday: 3 },
      { index: 1, iso: "2026-09-03", weekday: 4 },
    ];
    const shift = (x: ContextAssignment): ContextAssignment => ({
      ...x,
      startMin: x.startMin + 1440,
      endMin: x.endMin + 1440,
    });
    act(() => {
      rerenderCtx({
        days: two,
        todayIndex: 1,
        assignments: [shift(crew1), shift(crew2)],
        runs: [{ ...run, startMin: run.startMin + 1440, endMin: run.endMin + 1440 }],
      });
    });
    // Never the same question a second time: the Yes rode the rerun.
    expect(statusText()).not.toContain("Clear Wednesday's part too");
    expect(statusText()).toMatch(/^Ready to do 3 things: /);
  });
});

describe("CB-abs: an absence sentence in the bar (S194-D, R-409, R-431)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const SAM_MORNING: ContextAssignment = {
    ...BLK_SP,
    id: "samAm",
    startMin: 3 * 1440 + 480,
    endMin: 3 * 1440 + 600,
    label: "08:00–10:00",
  };
  const SAM_AFTERNOON: ContextAssignment = {
    ...BLK_SP,
    id: "samPm",
    nodeId: "c2",
    startMin: 3 * 1440 + 780,
    endMin: 3 * 1440 + 900,
    label: "13:00–15:00",
  };

  it("CB-abs-1: 'Sam Patel is off today', recordable -- both blocks and the absence in one lot, the absence LAST; the Done line says it was recorded", async () => {
    const fetchMock = stubFetch();
    const onRunLot = vi.fn(async (resolved: ResolvedAny[]): Promise<LotResult> => ({
      done: resolved.length,
      error: null,
    }));
    const { input } = renderBar(
      { assignments: [SAM_MORNING, SAM_AFTERNOON], absenceRecordable: new Set(["sp"]) },
      null,
      null,
      {},
      { onRunLot },
    );
    fireEvent.change(input, { target: { value: "Sam Patel is off today" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(statusText()).toMatch(/^Ready to do 3 things: /);
    expect(statusText()).toContain(
      `3. ${renderedReadout("Sam Patel is recorded as off 2026-09-03.")}`,
    );

    fireEvent.click(screen.getByRole("button", { name: "Do all 3" }));
    // S195 review: the waits are on the machine, not the bar -- this failed once
    // in a full run under load and never alone or in its file; RTL's 1 s default
    // was the flake (no timer or promise in the bar is left unawaited).
    await waitFor(() => expect(onRunLot).toHaveBeenCalledTimes(1), { timeout: 5000 });
    const [steps] = onRunLot.mock.calls[0] as [ResolvedAny[]];
    expect(steps.map((s) => s.intent)).toEqual(["unassign", "unassign", "record_absence"]);
    const done =
      "Done, 3 things. " +
      renderedReadout(
        "Sam Patel is off 2026-09-03. Their 2 blocks on Cell 1 in Line 1 and Cell 2 are cleared and the absence is recorded.",
      );
    await waitFor(() => expect(threadText()).toContain(done), { timeout: 5000 });
    expect(postedEntry(fetchMock).outcome).toBe(done);
  });

  it("CB-abs-2: the recordable set still loading (unknown) -- the one block is removed, and the thread says the absence was not recorded, and why", () => {
    const { input, onUnassign } = renderBar({ assignments: [SAM_MORNING] });
    fireEvent.change(input, { target: { value: "Sam Patel is off today" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onUnassign).toHaveBeenCalledTimes(1);
    expect(threadText()).toContain(
      renderedReadout(
        "Sam Patel is off 2026-09-03. Their block on Cell 1 in Line 1 is cleared; the absence is not recorded, because I could not check whether you may record it.",
      ),
    );
  });

  it("CB-abs-3: 'remove Sam Patel today' is not an absence -- it still asks which block", () => {
    const { input } = renderBar({
      assignments: [SAM_MORNING, SAM_AFTERNOON],
      absenceRecordable: new Set(["sp"]),
    });
    fireEvent.change(input, { target: { value: "remove Sam Patel today" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(statusText()).toMatch(/Remove which\?/);
  });
});

describe("CB-432: R-432's answer, every new step kind, a refusal in the middle (S194-D)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const w = (d: number, m: number): number => d * 1440 + m;
  // Cell 2: Sam Patel's block and his job run from Wednesday 22:00 into
  // today (No keeps Wednesday's part: a block trim and a JOB TRIM), and a
  // second job wholly inside today (a JOB REMOVAL).
  const nightJob: ContextRun = {
    ...RUN1,
    id: "nightJob",
    nodeId: "c2",
    startMin: w(2, 1320),
    endMin: w(3, 360),
    label: "Housing A 22:00–06:00",
    span: "22:00–06:00",
    headcount: 1,
  };
  const dayJob: ContextRun = {
    ...RUN1,
    id: "dayJob",
    nodeId: "c2",
    startMin: w(3, 600),
    endMin: w(3, 720),
    label: "Housing A 10:00–12:00",
    span: "10:00–12:00",
    headcount: null,
  };
  const crew: ContextAssignment = {
    ...BLK1,
    id: "nightCrew",
    nodeId: "c2",
    operatorId: "sp",
    runId: "nightJob",
    startMin: w(2, 1320),
    endMin: w(3, 360),
    label: "22:00–06:00",
  };

  it("CB-432-1: the job trim is refused -- Done names what was made, Not done the job in the plant's words, Not tried says the job removal stays as it was", async () => {
    const onRunLot = vi.fn(async (_r: ResolvedAny[]): Promise<LotResult> => ({
      done: 1,
      error: "You don't have permission to edit Cell 2.",
    }));
    const { input } = renderBar(
      { assignments: [crew], runs: [nightJob, dayJob] },
      null,
      null,
      {},
      { onRunLot },
    );
    fireEvent.change(input, { target: { value: "clear Cell 2 today" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "No" }));
    expect(statusText()).toMatch(/^Ready to do 3 things: /);
    fireEvent.click(screen.getByRole("button", { name: "Do all 3" }));
    await waitFor(() => expect(onRunLot).toHaveBeenCalledTimes(1));
    const [steps] = onRunLot.mock.calls[0] as [ResolvedAny[]];
    expect(steps.map((s) => s.intent)).toEqual(["move", "trim_run", "remove_run"]);
    await waitFor(() =>
      expect(threadText()).toContain(
        "I made 1 of the 3 changes.\n" +
          "Done: Sam Patel's night shift on Cell 2 keeps its Wednesday part, 10 pm to midnight; Thursday's part, midnight to 6 am, is cleared.\n" +
          "Not done: The Housing A job on Cell 2 Thu Sep 3, 10 pm to 6 am. You cannot change Cell 2 from here.\n" +
          "Not tried: The Housing A job on Cell 2 Thu Sep 3 stays as it was, 10 am to noon.",
      ),
    );
  });

  it("CB-432-2: an absence lot whose record is refused (an absence already there) -- the blocks are Done, the record Not done in words", async () => {
    const onRunLot = vi.fn(async (_r: ResolvedAny[]): Promise<LotResult> => ({
      done: 1,
      error:
        "This person already has an absence over some of those days (2026-09-03 – 2026-09-03).",
    }));
    const { input } = renderBar(
      { assignments: [BLK_SP], absenceRecordable: new Set(["sp"]) },
      null,
      null,
      {},
      { onRunLot },
    );
    fireEvent.change(input, { target: { value: "Sam Patel is sick today" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Do all 2" }));
    await waitFor(() => expect(onRunLot).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(threadText()).toContain(
        `Not done: ${renderedReadout("An absence for Sam Patel 2026-09-03")}. An absence is already recorded on some of those days.`,
      ),
    );
  });

  it("CB-432-3: the runner REJECTS but says how many it made -- answered like any partial failure, and traced", async () => {
    const fetchMock = stubFetch();
    const onRunLot = vi.fn((_r: ResolvedAny[]): Promise<LotResult> =>
      Promise.reject({ done: 1, error: "boom." }),
    );
    const { input } = renderBar({ assignments: [BLK1, BLK_SP] }, null, null, {}, { onRunLot });
    fireEvent.change(input, { target: { value: LOT_REMOVE_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    fireEvent.click(screen.getByRole("button", { name: "Do all 2" }));
    await waitFor(() =>
      expect(threadText()).toContain(
        "Not done: Sam Patel's block on Cell 1 in Line 1 Thu Sep 3, 10 am to 2 pm. boom.",
      ),
    );
    expect(postedEntry(fetchMock).outcome).toMatch(/^I made 1 of the 2 changes\./);
  });

  it("CB-432-4: the runner REJECTS with no count -- never 'nothing was changed'; the thread says some may have been, and it is traced", async () => {
    const fetchMock = stubFetch();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onRunLot = vi.fn((_r: ResolvedAny[]): Promise<LotResult> =>
      Promise.reject(new Error("network down")),
    );
    const { input } = renderBar({ assignments: [BLK1, BLK_SP] }, null, null, {}, { onRunLot });
    fireEvent.change(input, { target: { value: LOT_REMOVE_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    fireEvent.click(screen.getByRole("button", { name: "Do all 2" }));
    const said =
      "Something went wrong while making the changes; some may have been made. Check the board before saying it again.";
    await waitFor(() => expect(threadText()).toContain(said));
    expect(threadText()).not.toContain("nothing was changed");
    expect(postedEntry(fetchMock).outcome).toBe(`refused: ${said}`);
    errSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// S194-D third pass: the reviewer's five items, the bar's cases.
// ---------------------------------------------------------------------------

describe("CB-iso: every ISO day in a sentence is spoken, never only the first (S194-D third pass)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });
  const RAW = /\d{4}-\d{2}-\d{2}/;
  const SAM_THU: ContextAssignment = { ...BLK_SP, id: "samThu" };

  it("CB-iso-1: 'Sam Patel is off until Saturday' -- the listing, the Done line and the trace entry carry no raw date anywhere", async () => {
    const fetchMock = stubFetch();
    const onRunLot = vi.fn(async (r: ResolvedAny[]): Promise<LotResult> => ({
      done: r.length,
      error: null,
    }));
    const { input } = renderBar(
      { assignments: [SAM_THU], absenceRecordable: new Set(["sp"]) },
      null,
      null,
      {},
      { onRunLot },
    );
    fireEvent.change(input, { target: { value: "Sam Patel is off until Saturday" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(statusText()).toMatch(/^Ready to do 2 things: /);
    expect(statusText()).not.toMatch(RAW);
    expect(statusText()).toContain(
      renderedReadout("Sam Patel is recorded as off from 2026-09-03 to 2026-09-05."),
    );
    fireEvent.click(screen.getByRole("button", { name: "Do all 2" }));
    await waitFor(() => expect(threadText()).toContain("Done, 2 things."));
    expect(threadText()).not.toMatch(RAW);
    const entry = postedEntry(fetchMock);
    expect(`${entry.asked} ${entry.outcome} ${entry.ran.join(" ")}`).not.toMatch(RAW);
  });

  it("CB-iso-2: nothing on the board over the span and the set unknown -- 'has no block from X to Y' is spoken whole", () => {
    const { input } = renderBar({ assignments: [] });
    fireEvent.change(input, { target: { value: "Sam Patel is off until Saturday" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(threadText()).toContain(
      renderedReadout("Sam Patel has no block from 2026-09-03 to 2026-09-05;"),
    );
    expect(threadText()).not.toMatch(RAW);
  });

  it("CB-iso-3: an absence already on some of the days -- 'on some of the days from X to Y' is spoken whole", () => {
    const { input } = renderBar({
      assignments: [SAM_THU],
      absenceRecordable: new Set(["sp"]),
      hasWholeDayAbsence: () => true,
    });
    fireEvent.change(input, { target: { value: "Sam Patel is off until Saturday" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(threadText()).toContain(
      renderedReadout(
        "already has an absence recorded on some of the days from 2026-09-03 to 2026-09-05",
      ),
    );
    expect(threadText()).not.toMatch(RAW);
  });

  it("CB-iso-4: the day_order question names two days -- both spoken", () => {
    const { input } = renderBar({ assignments: [SAM_THU] });
    fireEvent.change(input, {
      target: { value: "Sam Patel is off from 2026-09-05 until 2026-09-03" },
    });
    fireEvent.keyDown(input, { key: "Enter" });
    // The person's own typed words keep their dates; the board's never do.
    expect(statusText()).not.toMatch(RAW);
    expect(statusText()).toContain("is before");
  });

  it("CB-iso-5: a refused absence over a span -- the Not done line's 'An absence for Sam Patel from X to Y' is spoken whole", async () => {
    const onRunLot = vi.fn(async (_r: ResolvedAny[]): Promise<LotResult> => ({
      done: 1,
      error: "This person already has an absence over some of those days.",
    }));
    const { input } = renderBar(
      { assignments: [SAM_THU], absenceRecordable: new Set(["sp"]) },
      null,
      null,
      {},
      { onRunLot },
    );
    fireEvent.change(input, { target: { value: "Sam Patel is off until Saturday" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Do all 2" }));
    await waitFor(() =>
      expect(threadText()).toContain(
        `Not done: ${renderedReadout("An absence for Sam Patel from 2026-09-03 to 2026-09-05")}.`,
      ),
    );
    expect(threadText()).not.toMatch(RAW);
  });
});

describe("CB-hole: a window inside a job offers the windows that would work (S194-D third pass, R-430)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });
  const dayJob: ContextRun = {
    ...RUN1,
    id: "dayJob",
    nodeId: "c2",
    startMin: 3 * 1440 + 600,
    endMin: 3 * 1440 + 960,
    label: "Housing A 10:00–16:00",
    span: "10:00–16:00",
  };

  it("CB-hole-1: 'clear Cell 2 from 1 to 2 pm' on a 10 am to 4 pm job -- two buttons; pressing one clears to that end of the job, traced", () => {
    const fetchMock = stubFetch();
    const { input } = renderBar({ runs: [dayJob] });
    fireEvent.change(input, { target: { value: "clear Cell 2 today from 1pm to 2pm" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(statusText()).toContain("would leave a hole in it");
    expect(candidateButtons().map((b) => b.textContent)).toEqual([
      "Clear 1 pm to 4 pm",
      "Clear 10 am to 2 pm",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Clear 1 pm to 4 pm" }));
    expect(statusText()).toMatch(
      /^Ready to do 1 thing: The Housing A job on Cell 2 keeps 10 am to 1 pm; /,
    );
    // The hole question was posted AT THE ASK (R-434); the entry then moved
    // on to the lot's own question, answered by the pressed window.
    const asks = fetchMock.mock.calls.map((_c, i) => postedEntry(fetchMock, i).asked ?? "");
    expect(asks.some((a) => a.includes("would leave a hole in it"))).toBe(true);
    expect(postedEntry(fetchMock).answered).toBe("Clear 1 pm to 4 pm");
  });
});

describe("CB-held: three branches the reviewer found no test holding (S194-D third pass)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("CB-held-1: a MODEL reading of 'Sam Patel is off tomorrow' comes back as a plain unassign -- the heard words mark it an absence: every block, the record, no which-block question", async () => {
    const plain: UnassignCommand = {
      intent: "unassign",
      operator: "Sam Patel",
      place: [],
      day: { kind: "tomorrow" },
      span: null,
      existing: null,
      shift: null,
      until: null,
    };
    const reader: Reader = vi.fn(async (): Promise<Reading> => ({
      ok: true,
      command: plain,
      by: "model",
    }));
    const friAm: ContextAssignment = {
      ...BLK_SP,
      id: "friAm",
      startMin: 4 * 1440 + 480,
      endMin: 4 * 1440 + 600,
      label: "08:00–10:00",
    };
    const friPm: ContextAssignment = {
      ...BLK_SP,
      id: "friPm",
      nodeId: "c2",
      startMin: 4 * 1440 + 780,
      endMin: 4 * 1440 + 900,
      label: "13:00–15:00",
    };
    const onRunLot = vi.fn(async (r: ResolvedAny[]): Promise<LotResult> => ({
      done: r.length,
      error: null,
    }));
    const { input } = renderBar(
      { assignments: [friAm, friPm], absenceRecordable: new Set(["sp"]) },
      reader,
      null,
      {},
      { onRunLot },
    );
    fireEvent.change(input, { target: { value: "Sam Patel is off tomorrow" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(statusText()).toMatch(/^Ready to do 3 things: /));
    expect(statusText()).not.toContain("Remove which?");
    fireEvent.click(screen.getByRole("button", { name: "Do all 3" }));
    await waitFor(() => expect(onRunLot).toHaveBeenCalledTimes(1));
    const [steps] = onRunLot.mock.calls[0] as [ResolvedAny[]];
    expect(steps.map((s) => s.intent)).toEqual(["unassign", "unassign", "record_absence"]);
  });

  it("CB-held-2: a single write whose answer then throws -- the thread names the write that was made and never says nothing changed", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { input, onUnassign } = renderBar({ assignments: [BLK1] });
    onUnassign.mockReturnValue({
      then: () => {
        throw new Error("the writer blew up after writing");
      },
    } as never);
    fireEvent.change(input, { target: { value: UNASSIGN_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    expect(onUnassign).toHaveBeenCalledTimes(1);
    expect(threadText()).toContain(
      "Something went wrong after that; check the board before saying it again.",
    );
    expect(threadText()).not.toContain("nothing was changed");
    errSpy.mockRestore();
  });

  it("CB-held-3: a person dead end with more than eight people on the board -- eight buttons and 'and more'", () => {
    const many = Array.from({ length: 11 }, (_, i) => ({
      id: `p${i}`,
      displayName: `Person ${String.fromCharCode(65 + i)}`,
      employeeRef: null,
      active: true,
    }));
    const { input } = renderBar({ operators: many });
    fireEvent.change(input, {
      target: { value: "assign Qqqq to Housing A on Cell 1 in Line 1 from 10 to 2" },
    });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(candidateButtons()).toHaveLength(8);
    expect(statusText()).toBe(
      'No person called "Qqqq" on your board. Did you mean one of these? … and more — say the person.',
    );
  });
});

// ---------------------------------------------------------------------------
// S195-A (DEF-0055, R-430, R-435, R-434): "clear <a person>" is about the
// person. The grammar hands the bar a place with the reserved "everyone"; the
// board knows the words are a name.
// ---------------------------------------------------------------------------

describe("CB-clear: 'clear <a person>' (S195-A, DEF-0055)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("CB-clear-1: 'clear Sam Patel today' is answered about Sam Patel -- the one-block question with 'Remove it', never 'No cell called' -- and the trace READS the person, as the sentence 'remove Sam Patel today' does", () => {
    const fetchMock = stubFetch();
    const { input } = renderBar({ assignments: [BLK_SP] });
    fireEvent.change(input, { target: { value: "clear Sam Patel today" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(statusText()).not.toContain("No cell called");
    expect(statusText()).toContain("Remove Sam Patel's Housing A block");
    expect(screen.getByRole("button", { name: "Remove it" })).toBeTruthy();
    const entry = postedEntry(fetchMock);
    expect(entry.read).toBe("unassign Sam Patel on today");
    expect(entry.read).not.toContain("everyone");
  });

  it("CB-clear-2: 'clear Sam Patal today' (a slip of the tongue) offers the nearest people and places; pressing the person reads the sentence as that person", () => {
    const fetchMock = stubFetch();
    const { input } = renderBar({ assignments: [BLK_SP] });
    fireEvent.change(input, { target: { value: "clear Sam Patal today" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(statusText()).toBe(
      'No cell or person called "Sam Patal" on this board. Did you mean one of these?',
    );
    expect(candidateButtons().map((b) => b.textContent)).toContain("Sam Patel");
    fireEvent.click(screen.getByRole("button", { name: "Sam Patel" }));
    expect(statusText()).toContain("Remove Sam Patel's Housing A block");
    expect(screen.getByRole("button", { name: "Remove it" })).toBeTruthy();
    expect(postedEntry(fetchMock).read).toBe("unassign Sam Patel on today");
  });

  it("CB-clear-3: a name that is both a person and a cell asks with both as buttons; 'The place' clears the cell and is not asked again, 'The person' is the person's removal", () => {
    const twin = { id: "twin", displayName: "Cell 2", employeeRef: null, active: true };
    const roster = [...buildCtx().operators, twin];
    const first = renderBar({ operators: roster });
    fireEvent.change(first.input, { target: { value: "clear Cell 2 today" } });
    fireEvent.keyDown(first.input, { key: "Enter" });
    expect(statusText()).toBe(
      '"Cell 2" is the name of a person and of a place on this board. Which did you mean?',
    );
    expect(candidateButtons().map((b) => b.textContent)).toEqual([
      "The person Cell 2",
      "The place Cell 2",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "The place Cell 2" }));
    expect(statusText()).not.toContain("is the name of a person");
    cleanup();

    const second = renderBar({ operators: roster });
    fireEvent.change(second.input, { target: { value: "clear Cell 2 today" } });
    fireEvent.keyDown(second.input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "The person Cell 2" }));
    expect(statusText()).toContain("Cell 2 has no block");
    expect(statusText()).not.toContain("is the name of a person");
  });
});

// ---------------------------------------------------------------------------
// S195-A (DEF-0052, tester 30 Sept): a block that is GONE and a block that is
// FORBIDDEN are different facts and read differently -- through the one
// rewriter, in a lot's "Not done" line and in a single sentence's refusal
// alike. The writer (`deleteAssignment`, `deleteRun`) says which; see
// `src/test/writeGoneOrForbidden.test.ts` for that half.
// ---------------------------------------------------------------------------

describe("CB-gone: a vanished block and a forbidden one are told apart (S195-A, DEF-0052)", () => {
  async function runLotRefusedWith(error: string): Promise<string> {
    const onRunLot = vi.fn(async (_r: ResolvedAny[]): Promise<LotResult> => ({ done: 1, error }));
    const { input } = renderBar({ assignments: [BLK1, BLK_SP] }, null, null, {}, { onRunLot });
    fireEvent.change(input, { target: { value: LOT_REMOVE_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    fireEvent.change(input, { target: { value: "yes" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onRunLot).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(threadText()).toContain("I made 1 of the 2 changes."));
    return threadText();
  }

  it("CB-gone-1: the block was removed underneath -- 'That block is no longer on the board.', the day and the hours in the Not done line", async () => {
    const said = await runLotRefusedWith("That block is no longer on the board.");
    expect(said).toContain(
      "Not done: Sam Patel's block on Cell 1 in Line 1 Thu Sep 3, 10 am to 2 pm. That block is no longer on the board.",
    );
    expect(said).not.toContain("You cannot change that from here.");
  });

  it("CB-gone-2: the block is still there and the person may not change it -- 'You cannot change that from here.'", async () => {
    const said = await runLotRefusedWith("You don't have permission to change that.");
    expect(said).toContain(
      "Not done: Sam Patel's block on Cell 1 in Line 1 Thu Sep 3, 10 am to 2 pm. You cannot change that from here.",
    );
    expect(said).not.toContain("no longer on the board");
  });

  it("CB-gone-3: a single sentence's removal says the same two things through the same rewriter -- gone passes through, forbidden is 'You cannot change that from here.'", async () => {
    const cases: Array<[string, string]> = [
      ["That block is no longer on the board.", "Not done: That block is no longer on the board."],
      ["You don't have permission to change that.", "Not done: You cannot change that from here."],
    ];
    for (const [refusal, want] of cases) {
      const { onUnassign, input } = renderBar({ assignments: [BLK1] });
      onUnassign.mockResolvedValue({ kind: "refused", message: refusal });
      fireEvent.change(input, { target: { value: UNASSIGN_SENTENCE } });
      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
      await act(async () => {});
      expect(threadText()).toContain(want);
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// S195-A (DEF-0043): the join button's words changed ("Join the Housing A job,
// 8 am to 4 pm"); a person may still TYPE or SAY the button's own words as the
// answer (F-162) -- the answer is matched against the labels the bar is showing,
// so it follows the new words. (A block question's buttons -- Remove, Change,
// Move -- were never answered by typing their label: the outline branch asks
// "Say which one." That is unchanged.)
// ---------------------------------------------------------------------------

describe("CB-typed: the join button's own words, typed, are the answer (S195-A)", () => {
  it("CB-typed-1: typing the join button's label picks that run", () => {
    const { onOpen, input } = renderBar({ runs: [RUN1] });
    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: "Join the Housing A job, 8 am to 4 pm" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledTimes(1);
    const [resolved] = onOpen.mock.calls[0] as [ResolvedCommand, { x: number; y: number }];
    expect(resolved.target).toEqual({ kind: "run", runId: "run1" });
  });
});

// ---------------------------------------------------------------------------
// S195-D (DEF-0054, R-434, R-431, R-459): a sentence that ends in one of the
// board's own pop-ups is FINISHED by that pop-up's answer. Until then the thread
// says ONE plain sentence -- what the board is asking -- and never the done-form
// readout; the entry is posted at the ask (DEF-0049's shape); Continue settles
// it Written, Cancel settles it "Cancelled. Nothing changed.", the server's
// refusal settles it "Not done: ...". The writers' own answers are proved in
// `dragGesture.test.ts` (P-1..P-12) and `createPopover.test.tsx`; this drives
// the BAR against that contract.
// ---------------------------------------------------------------------------
describe("CB-pop: a sentence that ends in the board's own pop-up is finished by its answer (DEF-0054)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const ASKING = attachmentWaiting({
    person: "Operator 1",
    from: "Housing A",
    to: null,
  });

  /** The retime path a Continue? pop-up opens from: BLK1 is on the board, the
   *  sentence changes its hours, and the writer answers with the sentence. */
  function retimeBar() {
    const fetchMock = stubFetch();
    const bar = renderBar({ assignments: [BLK1] });
    bar.onMove.mockReturnValue({ kind: "popup", waitingFor: ASKING });
    fireEvent.change(bar.input, { target: { value: MOVE_RETIME_SENTENCE } });
    fireEvent.keyDown(bar.input, { key: "Enter" });
    const [resolved, , report] = bar.onMove.mock.calls[0] as [
      ResolvedCommand,
      { x: number; y: number },
      (r: { kind: string; message?: string; readout?: string }) => void,
    ];
    return { ...bar, fetchMock, resolved, report };
  }

  it("CB-pop-1: while the pop-up stands the thread says what the board is asking, ONCE, and never the done-form readout (R-431)", () => {
    const { resolved, fetchMock } = retimeBar();
    const done = renderedReadout(resolved.readout);

    expect(threadText()).toContain(ASKING);
    // Said once: the live area is empty (the turn is filed), not a second copy.
    expect(threadText().split(ASKING)).toHaveLength(2);
    expect(statusText()).toBe("");
    // The done-form readout is nowhere: not in the thread, not on the live line.
    expect(threadText()).not.toContain(done);
    expect(document.body.textContent).not.toContain(done);
    // The code's words are not the person's (R-459).
    expect(threadText()).not.toMatch(/re-time|attachment|keep\/scale|pop-up|standalone/i);

    // Posted AT THE ASK, with the sentence as what the turn asked (DEF-0049).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const posted = postedEntry(fetchMock);
    expect(posted.heard).toBe(MOVE_RETIME_SENTENCE);
    expect(posted.asked).toBe(ASKING);
    expect(posted.answered).toBeNull(); // nobody has answered yet (DEF-0049's shape)
    expect(posted.outcome).toBe(`popup: ${ASKING}`);
    expect(posted.ran).toEqual([]);
  });

  it("CB-pop-2: Continue -- the server accepts -- settles the turn Written with the readout the direct path uses, and the trace outcome is written", () => {
    const { resolved, report, fetchMock } = retimeBar();
    const done = renderedReadout(resolved.readout);

    act(() => report({ kind: "written" }));

    expect(threadText()).toContain(`Written: ${done}`);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const entry = postedEntry(fetchMock);
    expect(entry.revises).toBe(true);
    expect(entry.outcome).toBe("written");
    expect(entry.ran).toEqual([done]);
    // Reported twice (Continue then the shell's own close): nothing more.
    act(() => report({ kind: "cancelled" }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("CB-pop-3: Cancel settles the turn 'Cancelled. Nothing changed.' -- the readout is NOT in the thread -- and the trace outcome is cancelled", () => {
    const { resolved, report, fetchMock } = retimeBar();
    const done = renderedReadout(resolved.readout);

    act(() => report({ kind: "cancelled" }));

    expect(threadText()).toContain("Cancelled. Nothing changed.");
    // DEF-0054's own symptom: after Cancel the thread still said the block
    // "now ends 5:30 pm".
    expect(threadText()).not.toContain(done);
    const entry = postedEntry(fetchMock);
    expect(entry.outcome).toBe("cancelled");
    expect(entry.ran).toEqual([]);
  });

  it("CB-pop-4: the server refusing the write after Continue settles 'Not done: <reason>' through the one rewriter, and the trace says refused", () => {
    const { report, fetchMock } = retimeBar();

    act(() => report({ kind: "refused", message: "You don't have permission to change that." }));

    expect(threadText()).toContain("Not done: You cannot change that from here.");
    expect(threadText()).not.toContain("You don't have permission");
    const entry = postedEntry(fetchMock);
    expect(entry.outcome).toBe("refused: You cannot change that from here.");
    expect(entry.ran).toEqual([]);
  });

  it("CB-pop-5: the page closed while the pop-up stands leaves the entry in the trace, still saying what it asked (answered: null is the ask's own line)", () => {
    const { unmount, fetchMock } = retimeBar();
    // The ask-time line is already there BEFORE any close.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    unmount();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const last = postedEntry(fetchMock);
    expect(last.heard).toBe(MOVE_RETIME_SENTENCE);
    expect(last.asked).toBe(ASKING);
    expect(last.answered).toBeNull();
    expect(last.outcome).toBe(`popup: ${ASKING}`);
  });

  it("CB-pop-6: a second sentence while the pop-up stands is read AT ONCE (never held behind it), and the pop-up's later answer still corrects the first turn", () => {
    const { input, onOpen, report, fetchMock, resolved } = retimeBar();
    const done = renderedReadout(resolved.readout);

    // F-162's rule, the standing question's: a new sentence ends whatever
    // stood -- nothing is being WRITTEN while a person decides, so nothing is
    // held ("The board is still saving your last change" would be a lie).
    fireEvent.change(input, {
      target: { value: "Assign Operator 1 to Housing A on Cell 1 in Line 1 from 6 to 8" },
    });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(threadText()).not.toContain("still saving your last change");

    // The first turn is filed as it stood, and the pop-up's answer arriving
    // later corrects that SAME turn and its file line (CB-t-23's shape).
    fetchMock.mockClear();
    act(() => report({ kind: "written" }));
    expect(threadText()).toContain(`Written: ${done}`);
    expect(postedEntry(fetchMock).outcome).toBe("written");
    expect(postedEntry(fetchMock).revises).toBe(true);
  });

  it("CB-pop-7: a create the bar may press by itself says NOTHING is waiting until the pop-up reports it stands -- then the sentence, then the answer", () => {
    const fetchMock = stubFetch();
    const { onOpen, input } = renderBar({ runs: [] });
    onOpen.mockReturnValue({ kind: "popup", waitingFor: CREATE_WAITING, standing: false });

    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    const [resolved, , report] = onOpen.mock.calls[0] as [
      ResolvedCommand,
      { x: number; y: number },
      (r: { kind: string; what?: string; message?: string }) => void,
    ];
    const done = renderedReadout(resolved.readout);

    // Hidden auto-press (F-205): nothing to finish on the board, nothing done
    // yet either -- "Working…", no done-form readout, no waiting sentence.
    expect(statusText()).toBe("Working…");
    expect(document.body.textContent).not.toContain(CREATE_WAITING);
    expect(document.body.textContent).not.toContain(done);
    expect(postedEntry(fetchMock).outcome).toBe(`popup: ${CREATE_WAITING}`);

    // The pop-up reports it is on screen: now the sentence is said.
    act(() => report({ kind: "handed_off", what: CREATE_WAITING }));
    expect(threadText()).toContain(CREATE_WAITING);
    expect(statusText()).toBe("");

    // A decision made on the board settles it.
    act(() => report({ kind: "written" }));
    expect(threadText()).toContain(`Written: ${done}`);
    expect(postedEntry(fetchMock).outcome).toBe("written");
  });

  it("CB-pop-8: an auto-pressed create that never stood ends exactly as a direct write always did -- the readout, then Written", () => {
    const fetchMock = stubFetch();
    const { onOpen, input } = renderBar({ runs: [] });
    onOpen.mockReturnValue({ kind: "popup", waitingFor: CREATE_WAITING, standing: false });

    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    const [resolved, , report] = onOpen.mock.calls[0] as [
      ResolvedCommand,
      { x: number; y: number },
      (r: { kind: string }) => void,
    ];
    const done = renderedReadout(resolved.readout);

    act(() => report({ kind: "written" }));

    // The turn's board line is the readout (as CB-t-17's direct write), and
    // the waiting sentence was never said, so it is never in the thread.
    expect(threadText()).toContain(done);
    expect(threadText()).toContain(`Written: ${done}`);
    expect(threadText()).not.toContain(CREATE_WAITING);
    const entry = postedEntry(fetchMock);
    expect(entry.outcome).toBe("written");
    expect(entry.asked).toBe(done);
  });

  it("CB-pop-10: a person busy on a place she cannot read is refused in the place's words -- through the writer's answer and through the pop-up's report -- untouched by the cap rewriter (R-465)", () => {
    const SAID = "Priya Shah is already on Cell 4 in Line 2 today from 6 am to 2 pm.";

    // Through the writer's own answer (a write refused at once).
    let fetchMock = stubFetch();
    let bar = renderBar({ runs: [] });
    bar.onOpen.mockReturnValue({ kind: "refused", message: SAID });
    fireEvent.change(bar.input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(bar.input, { key: "Enter" });
    expect(threadText()).toContain(`Not done: ${SAID}`);
    expect(postedEntry(fetchMock).outcome).toBe(`refused: ${SAID}`);
    expect(postedEntry(fetchMock).ran).toEqual([]);

    cleanup();
    vi.unstubAllGlobals();

    // Through the create pop-up's report (an auto-press the server refused).
    fetchMock = stubFetch();
    bar = renderBar({ runs: [] });
    bar.onOpen.mockReturnValue({ kind: "popup", waitingFor: CREATE_WAITING, standing: false });
    fireEvent.change(bar.input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(bar.input, { key: "Enter" });
    const [, , report] = bar.onOpen.mock.calls[0] as [
      ResolvedCommand,
      { x: number; y: number },
      (r: { kind: string; message?: string }) => void,
    ];
    act(() => report({ kind: "refused", message: SAID }));
    expect(threadText()).toContain(`Not done: ${SAID}`);
    expect(threadText()).not.toMatch(/would be over the cap/);
    expect(postedEntry(fetchMock).outcome).toBe(`refused: ${SAID}`);
  });

  it("CB-pop-9: a lot of ONE reads 'Do it'; two or more read 'Do all N' (S195-D item 3)", () => {
    const { input } = renderBar({ assignments: [BLK1, BLK_SP] });

    fireEvent.change(input, { target: { value: LOT_REMOVE_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    expect(statusText()).toMatch(/^Ready to do 2 things: /);
    expect(screen.getByRole("button", { name: "Do all 2" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Do it" })).toBeNull();
  });
});

/**
 * S196-A (DEF-0060, F-239, R-465, R-431): the bar asks the server's capacity
 * probe BEFORE it prints a readout or asks a question whose every answer leads
 * to a placement. A person busy on a place the caller cannot read is refused in
 * ONE sentence and nothing else: no readout, no join question, no write. The
 * probe is scripted (`precheck`, what `useDragGesture.precheckCommandStep` is
 * in the real app); the real probe's own decision is in busyElsewhere.test.ts.
 */
describe("CB-pre: the bar refuses before it speaks (S196-A, DEF-0060, F-239)", () => {
  const BUSY = "Operator 1 is already on Cell 4 in Line 2 today from 6 am to 2 pm.";
  const busy = vi.fn(async (): Promise<string | null> => BUSY);
  const free = vi.fn(async (): Promise<string | null> => null);
  const nothingBut = (): void => {
    expect(threadText()).toContain(`Not done: ${BUSY}`);
    expect(threadText()).not.toMatch(/making Housing A|Join it|Separate block|Ready to do/);
    expect(statusText()).toBe("");
    expect(candidateButtons()).toHaveLength(0);
  };
  const bar = (
    over: Partial<ResolveContext>,
    precheck: (step: ResolvedCommand | ResolvedMove) => Promise<string | null>,
  ) => renderBar(over, null, null, {}, {}, {}, {}, {}, { precheck });

  afterEach(() => {
    busy.mockClear();
    free.mockClear();
    vi.unstubAllGlobals();
  });

  it("CB-pre-1: a create -- 'Working…' while the probe is out, then the one refusal; no readout, nothing written, the trace says refused with nothing asked", async () => {
    const fetchMock = stubFetch();
    const { onOpen, input } = bar({ runs: [] }, busy);
    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    // Not a readout: the probe has not answered, nothing is said as done.
    expect(statusText()).toBe("Working…");
    await act(async () => {});

    expect(busy).toHaveBeenCalledTimes(1);
    const [step] = busy.mock.calls[0] as unknown as [ResolvedCommand];
    expect(step.intent).toBe("assign");
    expect(step.operatorId).toBe("op1");
    nothingBut();
    expect(onOpen).not.toHaveBeenCalled();
    const entry = postedEntry(fetchMock);
    // R-434: the turn traces. `asked` is empty on purpose: the bar asked
    // nothing and printed nothing as done -- the outcome is the whole story.
    expect(entry.asked).toBeNull();
    expect(entry.ran).toEqual([]);
    expect(entry.outcome).toBe(`refused: ${BUSY}`);
  });

  it("CB-pre-2: a move to another cell is refused the same way, before any readout", async () => {
    const { onMove, input } = bar({ assignments: [BLK1] }, busy);
    fireEvent.change(input, { target: { value: MOVE_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(statusText()).toBe("Working…");
    await act(async () => {});
    expect(busy).toHaveBeenCalledTimes(1);
    const [step] = busy.mock.calls[0] as unknown as [ResolvedMove];
    expect(step.intent).toBe("move");
    expect(step.target).toEqual({ kind: "move_cell" });
    expect(threadText()).toContain(`Not done: ${BUSY}`);
    expect(threadText()).not.toMatch(/is moving from/);
    expect(onMove).not.toHaveBeenCalled();
  });

  it("CB-pre-3: a re-time (a move in time) is refused the same way, before any readout", async () => {
    const { onMove, input } = bar({ assignments: [BLK1] }, busy);
    fireEvent.change(input, { target: { value: MOVE_RETIME_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(statusText()).toBe("Working…");
    await act(async () => {});
    expect(busy).toHaveBeenCalledTimes(1);
    expect(threadText()).toContain(`Not done: ${BUSY}`);
    expect(threadText()).not.toMatch(/now runs|now ends/);
    expect(onMove).not.toHaveBeenCalled();
  });

  it("CB-pre-4: the join-or-separate question is not asked when BOTH answers lead to the refused write -- the one refusal, no buttons", async () => {
    const fetchMock = stubFetch();
    const { onOpen, input } = bar({ runs: [RUN1] }, busy);
    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(statusText()).toBe("Working…");
    await act(async () => {});

    // Every answer was put to the probe: join, and separate.
    expect(busy).toHaveBeenCalledTimes(2);
    nothingBut();
    expect(onOpen).not.toHaveBeenCalled();
    const entry = postedEntry(fetchMock);
    expect(entry.outcome).toBe(`refused: ${BUSY}`);
    expect(entry.asked).toBeNull();
  });

  it("CB-pre-5: the join-or-separate question IS asked when the probe allows the write (the question the bar always asked)", async () => {
    const { onOpen, input } = bar({ runs: [RUN1] }, free);
    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    await act(async () => {});
    expect(statusText()).toBe(
      "A Housing A job is already booked on Cell 1, 8 am to 4 pm. Join it, or make a separate block?",
    );
    expect(screen.getByRole("button", { name: "Separate block" })).toBeTruthy();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("CB-pre-6: the which-shift question is not asked when EVERY shift leads to the refused write; asked when only one does", async () => {
    const shifts = (nodeId: string) =>
      nodeId === "c1a"
        ? [
            { name: "Day A", startMin: 360, endMin: 840 },
            { name: "Day B", startMin: 840, endMin: 1320 },
          ]
        : [];
    const sentence = "assign Operator 1 to Housing A on Cell 1 in Line 1 for the day shift";
    const all = bar({ runs: [], shiftsAt: shifts }, busy);
    fireEvent.change(all.input, { target: { value: sentence } });
    fireEvent.keyDown(all.input, { key: "Enter" });
    expect(statusText()).toBe("Working…");
    await act(async () => {});
    expect(busy).toHaveBeenCalledTimes(2);
    nothingBut();
    cleanup();

    // Only the first shift is refused: the second is fine, so the question
    // is still the person's to answer.
    const first = vi.fn(async (step: ResolvedCommand | ResolvedMove) =>
      step.range.startMin === 3 * 1440 + 360 ? BUSY : null,
    );
    const some = bar({ runs: [], shiftsAt: shifts }, first);
    fireEvent.change(some.input, { target: { value: sentence } });
    fireEvent.keyDown(some.input, { key: "Enter" });
    await act(async () => {});
    expect(first).toHaveBeenCalledTimes(2);
    expect(candidateButtons().length).toBe(2);
    expect(screen.getByRole("button", { name: /Day B/ })).toBeTruthy();
  });

  it("CB-pre-7: a readable-only overlap (the probe says nothing is refused) still reaches the writer and its readout, as before", async () => {
    const { onOpen, input } = bar({ runs: [] }, free);
    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(statusText()).toBe("Working…");
    await act(async () => {});
    expect(free).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(threadText()).toContain("Written: Operator 1 is on Cell 1 in Line 1");
  });

  it("CB-pre-8: no probe wired -- the sentence is synchronous and exactly as it was (the writer is called inside the Enter)", () => {
    const { onOpen, input } = renderBar({ runs: [] });
    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("CB-pre-9: a slow write that succeeds -- 'Working…' on the line, nothing as done in the thread or the file, then Written", async () => {
    const fetchMock = stubFetch();
    const { onOpen, input } = renderBar({ runs: [] });
    const write = pendingWrite();
    onOpen.mockReturnValue(write.promise);
    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    // In flight: the line says the bar is working, the thread holds nothing
    // said as done, and the entry is already in the file, waiting.
    expect(statusText()).toBe("Working…");
    expect(threadText()).not.toContain("making Housing A");
    const atAsk = postedEntry(fetchMock, 0);
    expect(atAsk.outcome).toBe("writing");
    expect(atAsk.asked).toBeNull();
    expect(atAsk.ran).toEqual([]);

    await write.settle();
    expect(threadText()).toContain("Written: Operator 1 is on Cell 1 in Line 1");
    const done = postedEntry(fetchMock);
    expect(done.outcome).toBe("written");
    // `asked` holds the readout only now that it is true.
    expect(done.asked).toContain("making Housing A");
  });

  it("CB-pre-10: a slow write that is refused -- no readout before it, 'Not done' after, the file says refused with nothing asked", async () => {
    const fetchMock = stubFetch();
    const { onOpen, input } = renderBar({ runs: [] });
    const write = pendingWrite();
    onOpen.mockReturnValue(write.promise);
    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(statusText()).toBe("Working…");
    expect(threadText()).not.toContain("making Housing A");

    await write.settle({ kind: "refused", message: BUSY });
    expect(threadText()).toContain(`Not done: ${BUSY}`);
    expect(threadText()).not.toContain("making Housing A");
    const entry = postedEntry(fetchMock);
    expect(entry.outcome).toBe(`refused: ${BUSY}`);
    expect(entry.asked).toBeNull();
    expect(entry.ran).toEqual([]);
  });

  it("CB-pre-11: a lot with one step busy elsewhere drops it, names it in one sentence, and lists the rest", async () => {
    const onlyOp1 = vi.fn(async (step: ResolvedCommand | ResolvedMove) =>
      step.intent === "assign" && step.operatorId === "op1" ? BUSY : null,
    );
    const { input, onRunLot } = bar({ runs: [] }, onlyOp1);
    fireEvent.change(input, {
      target: {
        value: "Assign Operator 1 and Sam Patel to Housing A on Cell 1 in Line 1 from 10 to 2",
      },
    });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(statusText()).toBe("Working…");
    await act(async () => {});

    // Both steps were probed together, before any listing.
    expect(onlyOp1).toHaveBeenCalledTimes(2);
    expect(statusText()).toMatch(
      /^Not doing Operator 1 on Cell 1 in Line 1 Thu Sep 3, 10 am to 2 pm: Operator 1 is already on Cell 4 in Line 2 today from 6 am to 2 pm\. Ready to do 1 thing: /,
    );
    expect(statusText()).toContain("Sam Patel is on Cell 1");
    expect(statusText()).not.toMatch(/Operator 1 is on Cell 1/);
    expect(screen.getByRole("button", { name: "Do it" })).toBeTruthy();

    // And what the lot then writes is the kept step alone.
    fireEvent.click(screen.getByRole("button", { name: "Do it" }));
    expect(onRunLot).toHaveBeenCalledTimes(1);
    const [resolved] = onRunLot.mock.calls[0] as [ResolvedAny[]];
    expect(resolved).toHaveLength(1);
    expect((resolved[0] as ResolvedCommand).operatorId).toBe("sp");
  });

  it("CB-pre-12: a lot whose every step is busy elsewhere is the refusal alone -- no listing, nothing to say yes to", async () => {
    const fetchMock = stubFetch();
    const { input, onRunLot } = bar({ runs: [] }, busy);
    fireEvent.change(input, {
      target: {
        value: "Assign Operator 1 and Sam Patel to Housing A on Cell 1 in Line 1 from 10 to 2",
      },
    });
    fireEvent.keyDown(input, { key: "Enter" });
    await act(async () => {});
    expect(busy).toHaveBeenCalledTimes(2);
    expect(threadText()).toContain(
      "Not doing Operator 1 on Cell 1 in Line 1 Thu Sep 3, 10 am to 2 pm: ",
    );
    expect(threadText()).toContain(
      "Not doing Sam Patel on Cell 1 in Line 1 Thu Sep 3, 10 am to 2 pm: ",
    );
    expect(threadText()).not.toMatch(/Ready to do/);
    expect(candidateButtons()).toHaveLength(0);
    expect(onRunLot).not.toHaveBeenCalled();
    expect(postedEntry(fetchMock).outcome).toMatch(/^refused: Not doing /);
  });
});
