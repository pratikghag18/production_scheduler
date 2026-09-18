import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HierarchyLevel, ShiftTemplate } from "@/lib/api";
import { describeSchedulerError, isSchedulerError } from "@/lib/api";
import { DevProfileSwitcher } from "@/features/auth/DevProfileSwitcher";
import { useSession } from "@/features/auth/useSession";
import { canQueryAsUser } from "@/features/auth/session";
import { productsOfferedAtNode } from "@/features/admin/lib/scope";
import {
  DEFAULT_DATE_FORMAT,
  dayMarker,
  isoMondayOfWeek,
  isoPlusDays,
  weekdayOfIso,
} from "@/lib/format/dates";
import { DEFAULT_TIMEZONE, partsInZone } from "@/lib/format/timezones";
import type { ResolveContext, BoardDay, ContextRun } from "@/lib/command/resolve";
import { voiceServiceUrl, readSentence, type Reader } from "@/lib/voice/readSentence";
import { browserRecognizer, type Recognizer } from "@/lib/voice/recognizer";
import { localRecognizer, whisperServiceUrl, withFallback } from "@/lib/voice/localRecognizer";
import { buildRecognizerHint } from "@/lib/voice/recognizerHint";
import { operatorViewFor, productViewFor } from "./lib/history";
import { useBoardWindow } from "./hooks/useBoardWindow";
import { useAbsences } from "./hooks/useAbsences";
import type { AbsenceRow } from "@/lib/absence";
import { useRootPath } from "./hooks/useRootPath";
import { NO_PLACES_MESSAGE } from "./lib/rootSelection";
import { useBoardViewStore } from "./store/boardView";
import { useDragGesture } from "./hooks/useDragGesture";
import {
  buildBoardIndex,
  policyForNode,
  certificateGaps as certificateGapsFor,
  type BoardIndex,
} from "./lib/boardIndex";
import { outsideAreaOperatorIds as outsideAreaFor, splitPeopleFor } from "./lib/outsideArea";
import { DENSITIES, scaleDensity } from "./lib/geometry";
import {
  splitFits,
  assignmentFitsRun,
  rangesOverlap,
  findRunOverlap,
  MIN_DURATION_MINUTES,
} from "./lib/interaction";
import { commandAssignments } from "./lib/commandAssignments";
import { launcherFor } from "./lib/commandBarGate";
import { cycleTimeKey, standardTargetQty } from "./lib/standardTarget";
import {
  addMinutes,
  boardFetchBounds,
  buildDayAxis,
  formatClock,
  MINUTES_PER_DAY,
  wallOf as wallOfAxis,
} from "./lib/time";
import { BoardToolbar } from "./components/BoardToolbar";
import { CommandLauncher } from "./components/CommandLauncher";
import { historyStorageKey } from "./store/commandConversation";
import { BoardGrid } from "./components/BoardGrid";
import { OperatorPanel } from "./components/OperatorPanel";
import { BoardEmptyState } from "./components/BoardEmptyState";
import { Toasts } from "./components/Toasts";
import { CreatePopover, type PopoverConfirmHandle } from "./components/CreatePopover";
import { HighlightProvider, type Highlight } from "./lib/highlight";
import { RunPopover } from "./components/RunPopover";
import { AssignmentPopover } from "./components/AssignmentPopover";
import { SplitCoveragePopover } from "./components/SplitCoveragePopover";
import { ConfirmPopover } from "./components/ConfirmPopover";
import styles from "./BoardPage.module.css";
// P1-4e D65: the panel-drag ghost (below) reuses `.chipGhost`/`.avatar`/
// `.nm` from `OperatorPanel.module.css` rather than duplicating them — it
// IS a `.chip` variant, not a new visual language (see that file's own
// comment on `.chipGhost`).
import operatorPanelStyles from "./components/OperatorPanel.module.css";

/** P1-4c D50: the operator panel auto-collapses once when the viewport
 *  crosses this width downward — see the `useEffect` below (T20). */
const OPERATOR_PANEL_COLLAPSE_QUERY = "(max-width: 899px)";

/** S44-b: computed once at module load -- `voiceServiceUrl()` only reads
 *  `import.meta.env`, and `readSentence` is a reference, so this makes no
 *  request. `null` (no `VITE_VOICE_URL`) leaves the bar's `reader` prop at
 *  its own default, unchanged from before this stage. */
const COMMAND_BAR_READER: Reader | null = voiceServiceUrl() ? readSentence : null;

/** S46-a: computed once at module level, beside `COMMAND_BAR_READER` --
 *  `browserRecognizer()` only reads `window` for the constructor, so this
 *  makes no request and starts no session; `null` (no browser recogniser)
 *  leaves the bar's `recognizer` prop at its own default, unchanged.
 *
 * S57-a (brief §4, design-plan §19.102 / D131 §3): `VITE_WHISPER_URL` set
 * picks the local (whisper.cpp) recogniser first, falling back once to the
 * browser's own if the service does not answer; unset leaves this exactly
 * as S46-a left it. Computing `browserRecognizer()` unconditionally (not
 * only when there is no local one) keeps that fallback available even when
 * a local URL is configured. */
const WHISPER_URL = whisperServiceUrl();
const BROWSER_RECOGNIZER: Recognizer | null = browserRecognizer();

/** S59-c (brief §2-3, design-plan §19.104 / D133 item 4): the current
 *  recogniser hint, a module-level singleton beside `BOARD_RECOGNIZER`
 *  itself -- `localRecognizer`'s third argument reads it at clip time
 *  through the closure below, so the component only ever needs to keep
 *  THIS assigned (its own `useEffect`, keyed on `commandCtx`); the
 *  recogniser built once at module load never has to be rebuilt when the
 *  board window changes. */
let recognizerHint = "";

/** S60-b (the S59 reviewer, 15 Sept): which engine actually ran the most
 *  recent clip -- a module-level singleton beside `recognizerHint` above and
 *  for the same reason (`BOARD_RECOGNIZER` is built once, outside any
 *  component). Starts at "local" when a local URL is configured (matching
 *  the OLD static prop's own assumption) or "browser" when it is not (there
 *  is no local engine to have run); `withFallback`'s own `onEngine` below
 *  updates it synchronously, per clip, the instant a fallback actually
 *  happens -- `CommandBar`'s `recognizerName` getter reads `.current` at
 *  trace time, never a value fixed at render (the bug this fixes: a clip
 *  that fell back to the browser was traced as "local" regardless). */
const engineRef: { current: "local" | "browser" } = {
  current: WHISPER_URL !== null ? "local" : "browser",
};

const BOARD_RECOGNIZER: Recognizer | null =
  WHISPER_URL !== null
    ? withFallback(
        localRecognizer(WHISPER_URL, undefined, () => recognizerHint),
        BROWSER_RECOGNIZER,
        (engine) => {
          engineRef.current = engine;
        },
      )
    : BROWSER_RECOGNIZER;

/** S59 (R-419, design §19.104/D133 item 3): lowercase weekday full names,
 *  0=Sunday .. 6=Saturday -- the exact spelling `resolve.ts`'s own private
 *  `WEEKDAY_FULL_NAMES` writes into a `day_off_board` question's `text`
 *  (mirrored here, not imported: `resolve.ts` exports no VALUES, only types,
 *  by design -- CLAUDE.md §4/`commandPurity.test.ts`'s U1). */
const SHOW_DAY_WEEKDAY_NAMES = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

// R-426 (S62-a): `isoPlusDays` and `mondayIsoOfWeekContaining` used to live
// here, each with its own paragraph explaining why UTC arithmetic on a day
// STRING is zone-free. Both are now `isoPlusDays`/`isoMondayOfWeek` in
// `@/lib/format/dates` — one implementation, one explanation, and the seam
// audit refuses a sixth copy.

/** S59 (R-419, design §19.104/D133 item 3): a week word's own start-of-week
 *  offset from the week containing the anchor day, in days -- `this_week`'s
 *  own Monday, or seven either side. Read as `weekWordOffsets[target]` only
 *  after `target in weekWordOffsets` has already narrowed `target` to one of
 *  these three keys (`handleShowDay`, below). */
const SHOW_DAY_WEEK_WORD_OFFSETS: Record<string, number> = {
  "this week": 0,
  "next week": 7,
  "last week": -7,
};

/**
 * S65-a (R-438): the board ROOT's own shift pattern, threaded into
 * `OperatorPanel` for its `bookingWords` band. `templateForNode` resolves
 * nearest-ancestor-or-self for a NODE id; the root is the one node whose own
 * `path` equals `rootPath` (`useRootPath`'s own selection). A plain function,
 * not a memo — this adds no new hook to a component several other lanes are
 * editing at the same time, and `index.nodeById` is small enough (one
 * board's worth of nodes) that the scan costs nothing worth memoizing.
 */
function rootTemplateFor(index: BoardIndex | null, rootPath: string | null): ShiftTemplate | null {
  if (!index || !rootPath) return null;
  for (const n of index.nodeById.values()) {
    if (n.path === rootPath) return index.templateForNode.get(n.id) ?? null;
  }
  return null;
}

/**
 * The board (brief P1-4a read-only + P1-4b interactions + P1-4c responsive
 * layout/density). Composes `BoardToolbar` + `OperatorPanel` + `BoardGrid`
 * + `Toasts` + the active popover, calls `useBoardWindow`, builds the
 * index with `buildBoardIndex`, and owns the single `useDragGesture`
 * instance (D29) that every draggable block/track reads through
 * `BoardGrid`'s `dragApi` prop. The only data call in this file (or
 * anywhere in the feature) is `useBoardWindow` — every mutation goes
 * through `useDragGesture`'s wrapped hooks (§2).
 */
export default function BoardPage() {
  const { session, profile, loading: sessionLoading } = useSession();
  const {
    rootPath,
    roots,
    isLoading: rootsLoading,
    isError: rootsError,
    selectRootPath,
  } = useRootPath();

  const zoomIndex = useBoardViewStore((s) => s.zoomIndex);
  const setZoomIndex = useBoardViewStore((s) => s.setZoomIndex);
  const densityMode = useBoardViewStore((s) => s.densityMode);
  const windowStartDate = useBoardViewStore((s) => s.windowStartDate);
  const windowDayCount = useBoardViewStore((s) => s.windowDayCount);
  const setWindowStartDate = useBoardViewStore((s) => s.setWindowStartDate);
  const setWindowDayCount = useBoardViewStore((s) => s.setWindowDayCount);
  const collapsedNodeIds = useBoardViewStore((s) => s.collapsedNodeIds);
  const toggleCollapsed = useBoardViewStore((s) => s.toggleCollapsed);
  const shiftWindowByDays = useBoardViewStore((s) => s.shiftWindowByDays);
  const goToToday = useBoardViewStore((s) => s.goToToday);
  const scrollToNowNonce = useBoardViewStore((s) => s.scrollToNowNonce);
  const operatorPanelOpen = useBoardViewStore((s) => s.operatorPanelOpen);
  const setOperatorPanelOpen = useBoardViewStore((s) => s.setOperatorPanelOpen);

  // P1-4d D51/D55: the fit scale itself is computed inside `BoardGrid` —
  // that is the one place that already has both `visibleRows` (the
  // collapse-filtered row set, whose ancestor-path filtering logic lives
  // there and is not duplicated here) and the measured available height
  // (from its existing `ResizeObserver`, per D55's "add no new observer").
  // `BoardGrid` reports the resulting number up through this callback
  // regardless of `densityMode` — it does not need to know whether Fit is
  // actually selected. `buildBoardIndex`'s call site, its single `density`
  // argument, and ownership of "which density is effective" all stay here,
  // unchanged in shape from P1-4c. See the agent report §5 for the fuller
  // rationale and the two-render settle this produces on mount/resize.
  //
  // Starts at 1 (computeFitScale's own "unmeasured -> natural size"
  // default, brief §4), so the very first render — before BoardGrid has
  // mounted and its ResizeObserver has fired even once — renders at
  // Standard rather than at a degenerate scale.
  const [fitScale, setFitScale] = useState(1);
  const handleFitScaleChange = useCallback((scale: number) => setFitScale(scale), []);

  // D43/D46/D53: DENSITIES[densityMode] is referentially stable across
  // renders (DENSITIES is a module-level const array) whenever densityMode
  // is a manual override and unchanged. Under Fit, `scaleDensity` returns a
  // NEW object every call — memoized here so `density`'s identity only
  // changes when `densityMode`/`fitScale` actually change, exactly as
  // `buildBoardIndex`'s own memoization below depends on.
  const density = useMemo(
    () => (densityMode === "fit" ? scaleDensity(DENSITIES[1], fitScale) : DENSITIES[densityMode]),
    [densityMode, fitScale],
  );

  // D14/D88a: `from`/`to` are the UTC "which day" MARKERS the store produces (the
  // zone is unknown at store-init). `buildBoardIndex` re-anchors `from` into the
  // plant zone for the axis origin (`zonedTimeToInstant`), so these stay the UTC
  // markers the index and axis have always been built from — that half did not
  // move. The QUERY's own bounds are `fetchFrom`/`fetchTo` below.
  const from = windowStartDate;
  // S67 (F-170): whether the person has scrolled the grid to the loaded
  // window's right edge -- `BoardGrid`'s own scroll position compared
  // against its own max scroll left (its `onWindowEdgeChange` prop doc),
  // bubbled up the same way `fitScale` is above. `BoardToolbar`'s
  // end-of-window note renders only while this is true, replacing the
  // unconditional render F-170 found.
  const [atWindowEnd, setAtWindowEnd] = useState(false);
  const handleWindowEdgeChange = useCallback((atEnd: boolean) => setAtWindowEnd(atEnd), []);

  const to = useMemo(
    () => addMinutes(windowStartDate, windowDayCount * MINUTES_PER_DAY),
    [windowStartDate, windowDayCount],
  );

  // ⭐ THE QUERY'S BOUNDS FOLLOW THE PLANT'S ZONE, NOT UTC. The axis is anchored
  // at plant-local midnight (`zonedTimeToInstant`, boardIndex.ts) while
  // `board_window` was still asked for whole UTC days: under America/Chicago a
  // run at 22:00 local on the last visible day fell PAST the UTC `p_to`, so
  // `board_window` omitted it — it saved, then vanished on reload.
  // `boardFetchBounds` places `p_from`/`p_to` on the same local midnights the
  // axis uses. Kept SEPARATE from `from`/`to` above on purpose: `buildBoardIndex`
  // re-derives its origin from `from`'s UTC calendar day, so feeding it a
  // local-midnight instant would double-shift the axis for a zone whose local
  // midnight lands on another UTC date. Only the fetch moves.
  //
  // ⚠️ The zone rides on the very payload these bounds fetch, so it is unknown on
  // the first load (and until fresh data lands after a plant switch): `fetchZone`
  // is null then and `boardFetchBounds` pads a whole day each side — a safe
  // superset (every IANA zone is within ±14h of UTC), never a miss. The effect
  // below sets the zone once the payload lands, tightening the bounds to the exact
  // local midnights and refetching on the narrower key — the same settle the axis
  // makes. `fetchFrom`/`fetchTo` feed BOTH the query and `useDragGesture`'s cache
  // keys, so the optimistic patches touch the same key the query reads.
  const [fetchZone, setFetchZone] = useState<string | null>(null);
  const { from: fetchFrom, to: fetchTo } = useMemo(
    () => boardFetchBounds(windowStartDate, windowDayCount, fetchZone),
    [windowStartDate, windowDayCount, fetchZone],
  );

  // Do not query as nobody: until the session resolves, an RLS-scoped read can
  // only come back 401. One shared predicate, never re-derived inline (§19.8).
  const canQuery = canQueryAsUser(session?.user.id ?? null, sessionLoading);
  // ⚠️ AND NOT UNTIL WE KNOW WHERE. `rootPath` is null while the places read is
  // in flight and stays null for someone with no access to any of them; asking
  // `board_window` for `""` would be the old hardcoded constant with extra
  // steps. The empty string can never reach the server because `enabled` is
  // false whenever it would be used — it exists only to keep the query key a
  // stable shape.
  const boardQuery = useBoardWindow(
    rootPath ?? "",
    fetchFrom,
    fetchTo,
    canQuery && rootPath !== null,
  );

  // Keep `fetchZone` in step with the payload's own resolved zone. Reset to null
  // on a place change so a plant switch re-pads (the safe superset) until the new
  // plant's payload lands, rather than fetching one render in the previous
  // plant's zone; then adopt the payload's zone to tighten the bounds.
  useEffect(() => {
    setFetchZone(null);
  }, [rootPath]);
  useEffect(() => {
    const z = boardQuery.data?.timezone ?? null;
    if (z !== null) setFetchZone((prev) => (prev === z ? prev : z));
  }, [boardQuery.data]);

  // R-357: who is on leave, read beside the board (never a browser-side walk up
  // the tree — see `useAbsences`). RLS scopes it to exactly the people the board
  // shows, so `absenceGaps` in the pop-ups and the panel judges against the same
  // rows the server would. Gated identically to the board read.
  const absencesQuery = useAbsences(canQuery && rootPath !== null);
  const absences = useMemo<AbsenceRow[]>(() => absencesQuery.data ?? [], [absencesQuery.data]);

  // T4: spinner only on "pending" with no cached data; keep rendering
  // stale data during a background refetch (isFetching), with a subtle
  // indicator in the toolbar instead of blanking the board every 30s.
  const hasData = boardQuery.data !== undefined;

  // DEF-0015 / R-239 / R-346: the ONE place the viewer question is decided.
  // `board_window` computes `can_place` from the same `app_grant_paths(true)`
  // set the write policies bind (migration 0058), so this single boolean is
  // the server's own answer for this person on this board. It is read here
  // once and handed down: to the panel (hidden when false), to `useDragGesture`
  // (which then refuses to open a write pop-up or start a block/create drag),
  // and to the assignment/run pop-ups as `readOnly` so a viewer who clicks a
  // chip or a band still SEES it, with no editable control the server refuses.
  // No pop-up sprinkles its own check — they render the decision made here.
  const canPlace = boardQuery.data?.canPlace ?? false;

  /**
   * R-333 / migration 0062 (DEF-0017): the date format for the board's day
   * labels, RESOLVED FOR THIS BOARD'S OWN ROOT ON THE SERVER.
   *
   * IT IS READ OFF THE PAYLOAD, not from `useDateFormat(canQuery, root)` any
   * more. That hook answered the ROOT node's OWN `node_settings` row, else the
   * company value -- and a board rooted at a LINE has no row of its own, while
   * the plant's row above the grant is not readable by a supervisor
   * (`node_settings_select`). So her board showed the company format on a plant
   * that had chosen otherwise. `board_window` now carries the value
   * `app_resolve_node_setting` walked to under SECURITY DEFINER, the same way it
   * already carried `nodePolicies` (R-331), so the board reads one resolved
   * answer instead of re-deriving a wrong one. The admin rail keeps its own
   * `useDateFormat` for the Settings screen -- untouched.
   *
   * Falls back to `DEFAULT_DATE_FORMAT` only while the window is still loading
   * (no payload yet); once it lands, the payload's token is always one of the
   * eight (`board_window` COALESCEs the resolver's NULL at the call site).
   */
  const dateFormat = boardQuery.data?.dateFormat ?? DEFAULT_DATE_FORMAT;

  /**
   * D88a / migration 0063 (R-353): the IANA zone the board's axis renders in,
   * READ OFF THE PAYLOAD exactly as `dateFormat` is — resolved for this board's
   * own root on the server (`app_resolve_node_setting`, SECURITY DEFINER), so a
   * line supervisor sees her PLANT's zone though she cannot read the plant's own
   * `node_settings` row. The client never walks the ancestry for it. Falls back
   * to 'UTC' only while the window is still loading; `buildBoardIndex` uses this
   * same token off `data` to build the day axis, so the axis and every label
   * agree.
   */
  const zone = boardQuery.data?.timezone ?? DEFAULT_TIMEZONE;

  /**
   * ⭐ F-159: THE BOARD OPENS ON THE PLANT'S CALENDAR DAY. The store is
   * created before any payload exists, so its "which day" marker is the UTC
   * date — a first guess that is the plant's date for most of the day and
   * TOMORROW's for the evening hours west of UTC (19:00 America/Chicago is
   * already 00:00Z). The reproduction was exactly that: the board opened on
   * the 17th at 19:09 on the 16th, `todayIndex` was -1, and the command bar
   * answered "today is not on the board".
   *
   * So the moment the payload says which zone the plant keeps, correct the
   * guess — ONCE, and only if nobody has moved the window themselves
   * (`windowMovedByUser`, which every store move including `goToToday` sets).
   * `anchorToZone` sets `anchoredToZone`, which is what makes this a
   * correction and not a loop. Read through `getState()` rather than
   * subscribed selectors on purpose: these two flags must not re-render the
   * board, and this effect's only trigger is the zone arriving.
   */
  const payloadZone = boardQuery.data?.timezone ?? null;
  const anchorToZone = useBoardViewStore((s) => s.anchorToZone);
  useEffect(() => {
    if (payloadZone === null) return;
    const state = useBoardViewStore.getState();
    if (state.windowMovedByUser || state.anchoredToZone) return;
    const plantToday = partsInZone(new Date(), payloadZone);
    const marker = state.windowStartDate;
    const sameDay =
      marker.getUTCFullYear() === plantToday.year &&
      marker.getUTCMonth() + 1 === plantToday.month &&
      marker.getUTCDate() === plantToday.day;
    if (sameDay) return;
    anchorToZone(payloadZone);
  }, [payloadZone, anchorToZone]);

  /**
   * R-403 / migration 0081 (D129): the command bar mode, read off the payload
   * exactly as `dateFormat`/`zone` are -- resolved for this board's own root
   * on the server. Falls back to the key's own default ('voice', the board's
   * behaviour before this setting existed) only while the window is still
   * loading; once it lands, `parseCommandBarMode` (shapes.ts) has already
   * failed an unrecognised STORED value to 'off'. `launcherFor` turns this
   * and `canPlace` into the one decision `CommandLauncher`'s render below
   * needs (`src/features/board/lib/commandBarGate.ts`, pinned without
   * rendering this component by `commandBarGate.test.ts`).
   */
  const commandBarLaunch = launcherFor(boardQuery.data?.commandBar ?? "voice", canPlace);

  // P1-4c D45/T17: `density` is part of this dependency array, so a density
  // change produces a brand-new `index` (new `rows` array identity) exactly
  // the way a data refetch or window change does — `BoardGrid`'s existing
  // T1 scroll-anchor-by-node-id effect (keyed off `visibleRows` identity)
  // picks it up with no density-specific code of its own. This IS the "goes
  // through that same path, not around it" T17 requires.
  const index = useMemo(() => {
    if (!boardQuery.data) return null;
    return buildBoardIndex(boardQuery.data, from, to, density);
  }, [boardQuery.data, from, to, density]);

  const levelById = useMemo<Map<string, HierarchyLevel>>(() => {
    if (!boardQuery.data) return new Map();
    return new Map(boardQuery.data.levels.map((l) => [l.id, l] as const));
  }, [boardQuery.data]);

  // D35: profile.defaultCreateMode is a plain string on the wire (no DB
  // check constraint the client can rely on) — narrowed here, once, rather
  // than trusting it as "run" | "direct" everywhere downstream.
  const defaultCreateMode: "run" | "direct" =
    profile?.defaultCreateMode === "direct" ? "direct" : "run";

  // D29: one drag/gesture controller for the whole page. `index` is only
  // ever non-null once `hasData` is true, so this is called with a
  // placeholder empty index before data loads (the hook itself never
  // dereferences it before a drag begins, and no block exists to start one
  // against). Hooks must run unconditionally, so this call cannot be
  // skipped behind `hasData`.
  const emptyIndex = useMemo<BoardIndex>(
    () =>
      index ?? {
        windowStart: from,
        windowMinutes: (to.getTime() - from.getTime()) / 60_000,
        dayCount: windowDayCount,
        // D88a: a not-yet-loaded board has no payload zone, so its axis is the
        // pre-D88 UTC one — `from` is a UTC midnight and every day is 1440 min.
        // The moment data lands, `index` (built with the payload's zone) takes
        // over. No drag can start against an empty board, so the axis here only
        // needs to be shaped right.
        zone: DEFAULT_TIMEZONE,
        dayAxis: buildDayAxis(from, windowDayCount, DEFAULT_TIMEZONE),
        rows: [],
        runsByNode: new Map(),
        assignmentsByNode: new Map(),
        assignmentsByRun: new Map(),
        assignmentsByOperator: new Map(),
        templateForNode: new Map(),
        cycleTimeByKey: new Map(),
        skillsForNode: new Map(),
        productById: new Map(),
        operatorById: new Map(),
        skillById: new Map(),
        nodeById: new Map(),
        // P1-4e §9 debt 1: same rows as `runsByNode`/`assignmentsByNode`,
        // keyed by id instead of node — see `boardIndex.ts`.
        runById: new Map(),
        assignmentById: new Map(),
        capacityCap: 1,
        // P1-4e D64: defaults to "warn" (same default `readEligibilityPolicy`
        // itself falls back to) so a not-yet-loaded board never behaves as
        // the stricter "block" policy by accident.
        eligibilityPolicy: "warn",
        // R-331: EMPTY, not populated with the company's answer. An empty map
        // is `policyForNode`'s "no per-node answers exist" state, in which it
        // falls back to `eligibilityPolicy` above — which is exactly what a
        // board with no data should do. A map with entries but a MISS is the
        // other state, and that one fails safe to "block".
        eligibilityPolicyByNode: new Map(),
        droppedRanges: 0,
        density,
      },
    [index, from, to, windowDayCount, density],
  );

  const dragApi = useDragGesture({
    // Only ever used to build cache keys, and unreachable while null: with no
    // place to open there is no board and nothing to drag.
    rootPath: rootPath ?? "",
    // The QUERY'S bounds (`board_window`'s `p_from`/`p_to`), so the mutation
    // hooks' optimistic patches touch the same react-query key the board read
    // populates — not the UTC axis markers, which no longer bound the fetch.
    from: fetchFrom,
    to: fetchTo,
    index: emptyIndex,
    defaultCreateMode,
    // R-357: the drag success toast names the leave a warn-move went ahead over
    // in the plant's own date format, the same seam the create/reassign pop-ups
    // read it through (`leaveLine`).
    dateFormat,
    sessionUserId: session?.user.id ?? null,
    // DEF-0015: the server's `can_place` for this person, so the gesture layer
  // S67 (R-445) DECIDED: the toolbar's Key lists only products with a run
  // inside the shown window -- `index.runById` IS that window's runs
  // (`boardIndex.ts` builds it from exactly the fetched `[from, to)` range,
  // clipped to it), so this reads the ids off runs already held here rather
  // than a second, narrower fetch of the readable catalogue `products`
  // (below) stays. Empty (not null) before the board has data, same
  // convention `emptyIndex` above uses.
  const productIdsInWindow = useMemo(() => {
    const ids = new Set<string>();
    for (const run of emptyIndex.runById.values()) {
      if (run.productId !== null) ids.add(run.productId);
    }
    return ids;
  }, [emptyIndex]);

    // refuses to open a create pop-up, start a block move/resize, or begin a
    // panel drag when it is false. Read-only pop-ups still open on a click.
    canPlace,
    // P1-4e D65: the panel-drop's default-duration snap needs the active
    // zoom's shift-chip/snap config, same as every other create-drag.
    zoomIndex,
  });

  // P1-4c T18: changing density mid-drag cancels any active drag first,
  // `handleDensityChange` removed with the toolbar's density control
  // (Aug 25). `setDensityMode` stays wired to the store so restoring that
  // control is a UI-only change; nothing else calls it today.

  // The popovers and toasts are `createPortal(node, document.body)` — they
  // are NOT descendants of the board root, so a `--ui-scale` set in the
  // style prop below never reaches them and every `calc(Npx * var(--ui-scale))`
  // inside them silently resolves to the 1 fallback. Publish it on
  // `document.documentElement` instead, where portaled content inherits it
  // too, and clear it when Fit is off so P1-4c's viewport-driven `:root`
  // rule takes back over rather than being permanently overridden by an
  // inline style.
  useEffect(() => {
    const root = document.documentElement;
    if (densityMode !== "fit") {
      root.style.removeProperty("--ui-scale");
      return;
    }
    root.style.setProperty("--ui-scale", String(Math.min(1.75, Math.max(1, fitScale))));
    // Braces matter: `removeProperty` returns a string, so a brace-less arrow
    // makes this `() => string`, which is not a valid effect destructor
    // (TS2345). Caught by tsc, invisible to the test run.
    return () => {
      root.style.removeProperty("--ui-scale");
    };
  }, [densityMode, fitScale]);

  // P1-4c D50/T20: the operator panel auto-collapses ONCE when the
  // viewport crosses 900px downward (matchMedia's `change` event fires on
  // BOTH crossings; `e.matches` distinguishes direction, so only the
  // downward one calls `setOperatorPanelOpen(false)`). If the user then
  // re-opens it, it stays open — this effect never fires again until the
  // viewport crosses back above 900px and then back down, matching T20's
  // "applies once, on crossing the threshold downward" exactly. Runs once
  // on mount too, so loading directly on a phone starts collapsed.
  const hasAutoCollapsedRef = useRef(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(OPERATOR_PANEL_COLLAPSE_QUERY);
    function applyIfNarrow(matches: boolean) {
      if (matches && !hasAutoCollapsedRef.current) {
        hasAutoCollapsedRef.current = true;
        setOperatorPanelOpen(false);
      } else if (!matches) {
        // Re-armed: the next downward crossing should auto-collapse again.
        hasAutoCollapsedRef.current = false;
      }
    }
    applyIfNarrow(mq.matches);
    function handleChange(e: MediaQueryListEvent) {
      applyIfNarrow(e.matches);
    }
    mq.addEventListener("change", handleChange);
    return () => mq.removeEventListener("change", handleChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // D108/0028: the products the create popover may offer AT THE CELL IT IS
  // OPEN ON. Two filters, both of which the server already enforces or the
  // schema already states:
  //
  //  1. SCOPE. `app_guard_run_scope`/`app_guard_assignment_scope` refuse a
  //     product not owned by an ancestor-or-self of the target node with
  //     `not_offered_here`, and — unlike eligibility — there is NO override.
  //     Offering one is offering something that cannot work.
  //  2. `active`. 0029 §1 leaves the flag ADVISORY on purpose — "nothing in
  //     the database refuses a run of a deactivated product today, and this
  //     migration does not start refusing one" — while the column comments it
  //     ships read "False = retired: not offered when …". Advisory plus "not
  //     offered" leaves the client as the only thing that can make the second
  //     half true, and nothing on the board did. `OperatorPanel` already
  //     filters operators exactly this way (`operators.filter((o) => o.active)`).
  //     This is a PICKER filter, not a hide: runs of a retired product that
  //     already exist keep rendering, and only new work stops being offered.
  //
  // Resolved HERE, from `index` + the popover's node, and passed down as a
  // list — the same shape as `requiredSkills={index?.skillsForNode.get(...)}`
  // below (D64/D65). The popover takes a list, never a rule.
  const popover = dragApi.popover;
  // S47 / R-395: what the bar told us is in question, drawn on the board via
  // `HighlightProvider` below -- read by `DirectBlock`/`AssignmentChip`
  // through `useHighlightKind`, never threaded through `BoardGrid`/`TrackRow`
  // as a prop (`../lib/highlight.ts`'s own file comment says why). S51: a
  // several's finished lot widens this to a LIST -- one outline per block a
  // removal or a move in it would touch -- `HighlightProvider`/
  // `useHighlightKind` already normalise either shape.
  const [highlight, setHighlight] = useState<Highlight | Highlight[] | null>(null);
  // S47 / R-395 item 4: the currently-open create pop-up's imperative handle
  // (null when none is mounted) -- `CommandBar`'s `onConfirmWord` reaches
  // through it for a spoken yes that arrives after mount, once R-384's own
  // auto-press has already had its one chance.
  const createPopoverRef = useRef<PopoverConfirmHandle | null>(null);
  const createNodeId = popover?.kind === "create" ? popover.nodeId : null;
  const offeredProducts = useMemo(() => {
    if (!boardQuery.data || createNodeId === null) return [];
    const active = boardQuery.data.products.filter((p) => p.active);
    // ⭐⭐ THE SERVER DECIDES THIS, AND THE CLIENT ONLY READS THE ANSWER
    // (DEF-0005, migration 0042). `board_window` sends, per product, the nodes
    // in THIS window where a run of it would be accepted — computed through the
    // same predicate the write guard runs — so the offer is membership and
    // nothing else.
    //
    // ⚠️ IT USED TO DERIVE THE ANSWER from `site_node_ids` and the board's node
    // map, and that list is RLS-filtered: a supervisor granted a LINE cannot
    // read the PLANT, so a plant-wide part arrived with no places at all and
    // was offered nowhere. Ana, granted Line 1, was offered ONE part out of the
    // four on her own legend while the server accepted all four. No node map is
    // consulted here any more, and no path is compared — those were the moving
    // parts that could disagree with the server.
    return productsOfferedAtNode(active, createNodeId);
  }, [boardQuery.data, createNodeId]);

  /**
   * ⭐⭐ THE PLANT'S PEOPLE, AS THE SERVER SENT THEM. No client filter at all.
   *
   * ⚠️ THIS USED TO BE `ownedInScope(all, index.nodeById.keys())` AND IT EMPTIED
   * A SUPERVISOR'S PANEL. The maintainer, 6 Sept: *"Ana can't see any operators
   * on the left panel. What am I missing? Something is definitely wrong."* The
   * cut kept only people whose owner node was on this board, and `board_window`
   * sends the nodes at or below the READER'S root -- so for Ana, granted Line 1,
   * the plant node was absent and the five people homed at it were dropped.
   * Nothing here could have told "another plant" from "above your grant".
   *
   * Migration 0058 moved the question to the server: `operators` is now the
   * people whose home is in the board's PLANT, computed where the whole tree is
   * visible. R-345's table guard makes that the same set the writers accept, so
   * the list the screen offers and the list the database takes are one answer.
   * `productsOfferedAtNode` above is the same move, made once already.
   */
  const operatorPool = useMemo(() => boardQuery.data?.operators ?? [], [boardQuery.data]);

  /**
   * P1-7a: the typed command bar's whole view of the board (brief §6). Built
   * beside `offeredProducts` above, from the SAME sources -- `operatorPool`
   * itself, `productsOfferedAtNode`, `index.dayAxis`, `assignmentFitsRun` -- so
   * the bar and the create pop-up cannot disagree about what is on offer; they
   * are handed the same functions and the same lists, never a copy (brief §2).
   * `null` before the board has data, which also gates the bar off screen.
   */
  const commandCtx = useMemo<ResolveContext | null>(() => {
    if (!boardQuery.data || index === null) return null;
    const active = boardQuery.data.products.filter((p) => p.active);
    const axis = index.dayAxis;
    const pad = (n: number) => String(n).padStart(2, "0");
    const days: BoardDay[] = [];
    for (let i = 0; i < axis.dayCount; i++) {
      const p = partsInZone(axis.dayStarts[i], index.zone);
      const iso = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
      // WHICH day this is was decided above, in the plant's zone
      // (`partsInZone`) -- that is D88a. `weekdayOfIso` then reads the weekday
      // off the NAMED day, which is the same number in every zone; the seam
      // owns that arithmetic (R-426) so no screen re-derives it.
      days.push({
        index: i,
        iso,
        weekday: weekdayOfIso(iso) as BoardDay["weekday"],
      });
    }
    const now = new Date();
    const t = axis.dayStarts.findIndex(
      (s, i) => i < axis.dayCount && now >= s && now < axis.dayStarts[i + 1],
    );
    // S55 (D130 item 3): `now`'s own wall-clock reading, in the plant's
    // zone -- `nowMinuteOfDay` below is built from this, never `getHours()`.
    const nowParts = partsInZone(now, index.zone);
    const runs: ContextRun[] = [];
    for (const [nodeId, list] of index.runsByNode) {
      for (const r of list) {
        const p = productViewFor(r, index.productById);
        const span = `${formatClock(addMinutes(index.windowStart, r.startMin), index.zone)}–${formatClock(addMinutes(index.windowStart, r.endMin), index.zone)}`;
        runs.push({
          id: r.id,
          nodeId,
          productId: r.productId,
          startMin: r.startMin,
          endMin: r.endMin,
          // The same D66 label `runLabelById` builds in `useDragGesture.ts`
          // (`<product name> <start>–<end>`, board zone) -- REBUILT here
          // rather than exposed from that hook, because this stage's file
          // fence keeps `useDragGesture.ts`'s edits to the two preset fields,
          // `openCreateFromCommand` and `submitCreateDirect`'s target only;
          // adding a return value beyond those three is a fourth change to a
          // file this lane does not otherwise touch. `productViewFor` and
          // `formatClock` are the same two calls that label is built from, so
          // the two cannot drift into different words for the same run.
          label: `${p?.name ?? "Run"} ${span}`,
          // S41-a: the same two `formatClock` calls, without the product
          // name — the `job_exists` sentence already names the product, so
          // this is what keeps it from repeating ("A Housing A job ...
          // Housing A 08:00-16:00" would be worse than naming the hours
          // once).
          span,
          // S55 (D130 item 4): `expandCommand`'s `copy` writes these onto a
          // copied `book` command -- the SAME `productViewFor` call `label`
          // above is already built from (`p`), one step further, and the
          // run's own field, not retyped.
          productName: p?.name ?? null,
          headcount: r.plannedHeadcount,
        });
      }
    }
    return {
      cells: index.rows.filter((r) => r.isTrack).map((r) => r.node),
      nodeById: index.nodeById,
      operators: operatorPool,
      products: active,
      offeredAt: (nodeId: string) => productsOfferedAtNode(active, nodeId),
      days,
      todayIndex: t === -1 ? null : t,
      wallToOffset: axis.wallToOffset,
      runs,
      fitsRun: assignmentFitsRun,
      minDurationMinutes: MIN_DURATION_MINUTES,
      // R-385: the own-block question's view of the window and its overlap test.
      assignments: commandAssignments(index),
      overlaps: rangesOverlap,
      // S41-a: a cell runs one job at a time — the same rule a run drag/
      // resize refuses a drop with, passed in rather than re-decided here.
      findRunOverlap,
      // S52-b (R-402): the SAME map `shiftChipsFor` reads for the pop-up's
      // own shift chips (`index.templateForNode`, the nearest-ancestor
      // pattern) -- no ancestry walk of the resolver's own, CLAUDE.md §4.
      shiftsAt: (nodeId: string) =>
        (index.templateForNode.get(nodeId)?.shifts ?? []).map((s) => ({
          name: s.name,
          startMin: s.startMin,
          endMin: s.endMin,
        })),
      // S55 (D130 item 3): the SAME `now`/`t` this memo already computed
      // `todayIndex` with, read as a wall-clock minute of day through the
      // SAME zone helper `formatClock` is built on (`partsInZone`) -- never
      // `getHours()` on the local clock. `null` exactly when `todayIndex` is
      // (today is off the board).
      nowMinuteOfDay: t === -1 ? null : nowParts.hour * 60 + nowParts.minute,
      // S55 (D130 item 3/4): the inverse of `wallToOffset` for a window
      // offset -- `lib/time.ts`'s own `wallOf`, over this window's axis.
      wallOf: (offsetMin: number) => wallOfAxis(axis, offsetMin),
      // S61-b (R-425, F-155): the SAME two calls the create pop-up already
      // makes for its own verdict (`CreatePopover.tsx`) -- `index.
      // skillsForNode` (rule 5, already unioned up the node's ancestor
      // path) and `certificateGapsFor` (`boardIndex.ts`'s `certificateGaps`,
      // the server's rule transcribed), with `windowEnd` built the pop-up's
      // own way (`addMinutes(index.windowStart, endMin)`). An unknown
      // operator id answers no gaps -- never a reason to ask, never a
      // reason to write either (`resolvePersonStep` already refused any
      // sentence naming nobody real before a certificate question could be
      // reached).
      certificateGaps: (operatorId: string, nodeId: string, endMin: number) => {
        const op = index.operatorById.get(operatorId);
        if (!op) return [];
        const required = index.skillsForNode.get(nodeId) ?? [];
        const windowEnd = addMinutes(index.windowStart, endMin);
        return certificateGapsFor(op, required, windowEnd).map((g) => ({
          skill: g.skill.name,
          state: g.state,
        }));
      },
      // S61-b (R-425, F-155): the SAME per-node policy the create pop-up
      // reads (`policyForNode`, R-331's own answer) -- never a second copy.
      eligibilityPolicy: (nodeId: string) => policyForNode(index, nodeId),
      // F-165 (S62-b): the server's AREA rule, through the SAME helper the
      // create pop-up already marks people with -- `outsideAreaOperatorIds`
      // over the cell's own ltree path, whose `isAtOrBelow` IS the `@>` test
      // `app_owner_covers_in_org` runs (migration 0072). Never a second copy
      // of the rule, and never a guess: a node this window does not carry
      // resolves to no path, which the helper itself reads as "mark nobody"
      // (its own documented fail-open -- the server still decides).
      outsideArea: (operatorId: string, nodeId: string) =>
        outsideAreaFor(operatorPool, index.nodeById.get(nodeId)?.path ?? null).has(operatorId),
    };
  }, [boardQuery.data, index, operatorPool]);

  /**
   * S59-c (brief §3, design-plan §19.104 / D133 item 4): the same four
   * sources the resolver itself reads off `commandCtx` -- cells, every node
   * (for the lines/places above a cell), active parts, active people --
   * built once per board window and handed to the local recogniser as its
   * next clip's prompt. `commandCtx.products` is already active-only (the
   * `active` filter above, at this memo's own top); `commandCtx.operators`
   * is the raw pool (S52-b's own doc on that field: the resolver itself
   * filters `active` before matching), so filtered here the same way.
   */
  const recognizerHintText = useMemo(() => {
    if (!commandCtx) return "";
    return buildRecognizerHint({
      cells: commandCtx.cells.map((c) => c.name),
      places: [...commandCtx.nodeById.values()].map((n) => n.name),
      parts: commandCtx.products.map((p) => p.name),
      people: commandCtx.operators.filter((o) => o.active).map((o) => o.displayName),
    });
  }, [commandCtx]);

  // S59-c (brief §2-3): keeps the module-level `recognizerHint` singleton
  // (`localRecognizer`'s own closure reads it at clip time) in step with
  // this window's names -- a plain assignment, not a ref, because
  // `localRecognizer(...)` was built once at module load, outside any
  // component instance, and has no ref of its own to read.
  useEffect(() => {
    recognizerHint = recognizerHintText;
  }, [recognizerHintText]);

  /**
   * S59 / R-419 (design §19.104/D133 item 3): `CommandBar`'s "Show that day"
   * button hands back `question.text` VERBATIM (that prop's own doc: "the
   * target is what the question names") -- every shape `resolve.ts`'s
   * `day_off_board` question can ever carry, read off every place it is
   * built there: "today", "tomorrow", "yesterday", a lowercase weekday name,
   * an ISO date, or a week word. The week word is NOT defensive (F-158; this
   * comment used to say it was): a `weekdays`/`every_day` repeat whose week
   * is not wholly on the board asks `day_off_board` naming that week, exactly
   * so this handler's own week-word branch -- the only one that WIDENS the
   * window -- is what its button reaches. Every branch below moves the window
   * through the STORE'S OWN
   * `setWindowStartDate`/`setWindowDayCount`/`shiftWindowByDays`/`goToToday`
   * -- never a second axis of its own. `CommandBar`'s own effect (keyed on
   * `ctx`) re-runs the held command once `commandCtx` above recomputes for
   * the new window.
   */
  function handleShowDay(target: string): void {
    if (!commandCtx || commandCtx.days.length === 0) return;
    if (target === "today") {
      // F-159: the plant's today, the same day the question judged itself
      // against (`todayIndex` is read off the axis, which is in `zone`).
      // `goToToday()` computed the UTC date, so after 19:00 Chicago the
      // button moved the board to tomorrow -- where the sentence was
      // already sitting -- and nothing on screen changed.
      goToToday(zone);
      return;
    }
    if (target === "yesterday") {
      shiftWindowByDays(-1);
      return;
    }
    if (target === "tomorrow") {
      shiftWindowByDays(1);
      return;
    }
    const weekdayIndex = SHOW_DAY_WEEKDAY_NAMES.indexOf(target);
    if (weekdayIndex !== -1) {
      // The nearest occurrence AT OR AFTER the window's own first day --
      // "move the board to that day" (R-419's own words), never a day
      // already behind the window someone deliberately opened.
      const anchor = commandCtx.days[0];
      const delta = (((weekdayIndex - anchor.weekday) % 7) + 7) % 7;
      const iso = isoPlusDays(anchor.iso, delta);
      setWindowStartDate(dayMarker(iso));
      return;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(target)) {
      setWindowStartDate(dayMarker(target));
      return;
    }
    // F-158: this is the branch a REPEAT DAY's own "Show that day" lands on.
    // A `weekdays`/`every_day` repeat needs its whole week on the board
    // before it expands, and `resolveWeekDays` now names that week ("this
    // week"/"next week") when it is not -- precisely so the button arrives
    // here, where the window is anchored on that week's Monday AND widened
    // to seven days. The widening is the point: the ISO branch above only
    // moves a three-day window, so an ISO-named repeat asked about Monday,
    // moved, then asked about Thursday, for ever.
    if (target in SHOW_DAY_WEEK_WORD_OFFSETS) {
      const anchorDay =
        commandCtx.todayIndex !== null
          ? commandCtx.days[commandCtx.todayIndex]
          : commandCtx.days[0];
      const monday = isoMondayOfWeek(anchorDay.iso);
      const iso = isoPlusDays(monday, SHOW_DAY_WEEK_WORD_OFFSETS[target]);
      setWindowStartDate(dayMarker(iso));
      setWindowDayCount(Math.max(windowDayCount, 7));
      return;
    }
    // Every other string is defensive only -- a no-op rather than a guess.
    // (This comment used to claim a repeat day "never reaches
    // `day_off_board`". It does, and always did: `expandRepeatDay` raises one
    // whenever the week is not wholly on the board. The S61-c typed walk
    // caught it saying so on a real board -- F-158 -- and the week-word
    // branch above is where it now lands.)
  }

  /** A node's ltree path, or `null` when this window does not carry the node. */
  const pathOf = useCallback(
    (nodeId: string | null): string | null =>
      nodeId === null ? null : (index?.nodeById.get(nodeId)?.path ?? null),
    [index],
  );

  /**
   * ⭐⭐ R-346, THE MAINTAINER'S RULE: *"If a operator is assigned to higher
   * hierarchy they should automatically become available to all lower hierarchy
   * within that hierarchy ... That should be the default behaviour. For other
   * operators in the plant we need to give an option to the supervisor to click
   * through something so show remaining operators."*
   *
   * So every person picker gets TWO lists rather than one: `here` for the place
   * it is about, and `elsewhere` behind a click. The rule lives in
   * `lib/outsideArea.ts` and is resolved HERE, exactly as `requiredSkills` and
   * `offeredProducts` are -- the panel and the pop-ups render a decision, they
   * do not make one, so the three cannot disagree.
   *
   * The panel's place is the BOARD'S ROOT (the plant, the area or the line the
   * reader opened); each pop-up's place is its own cell.
   */
  const panelSplit = useMemo(
    () => splitPeopleFor(operatorPool, rootPath),
    [operatorPool, rootPath],
  );
  const panelHereIds = useMemo(() => new Set(panelSplit.here.map((o) => o.id)), [panelSplit]);

  const createSplit = useMemo(
    () => splitPeopleFor(operatorPool, pathOf(createNodeId)),
    [operatorPool, pathOf, createNodeId],
  );
  const createHereIds = useMemo(() => new Set(createSplit.here.map((o) => o.id)), [createSplit]);

  const assignmentNodeId = popover?.kind === "assignment" ? popover.assignment.nodeId : null;
  const assignmentSplit = useMemo(
    () => splitPeopleFor(operatorPool, pathOf(assignmentNodeId)),
    [operatorPool, pathOf, assignmentNodeId],
  );
  const assignmentHereIds = useMemo(
    () => new Set(assignmentSplit.here.map((o) => o.id)),
    [assignmentSplit],
  );
  const assignmentOutsideAreaIds = useMemo(
    () => outsideAreaFor(operatorPool, pathOf(assignmentNodeId)),
    [operatorPool, pathOf, assignmentNodeId],
  );

  /**
   * D113: the people who do NOT belong at this cell -- the ones a picker marks
   * "not from this area (override)" and asks a reason for.
   *
   * ⚠️ THE OPPOSITE TREATMENT FROM `offeredProducts` ABOVE, AND DELIBERATELY.
   * A product outside its scope is refused by the database with no way through
   * (0030 leaves the product half absolute, because migration 0029's proof
   * depends on it), so it is filtered OUT of the picker. A person outside
   * theirs can be placed anyway by anyone who may schedule here, with a reason
   * -- so they stay in the list and are ANNOTATED. Filtering them would delete
   * the feature; offering the product would offer a guaranteed refusal.
   *
   * ⚠️ AND IT IS NOT THE SAME SET AS `elsewhere` ABOVE. The split is about a
   * PLACE and is generous downward -- somebody homed at Cell 1 is offered by
   * default on Line 1's board, because that is their line. The mark is about
   * THIS CELL and is the write guard transcribed, so that same person is marked
   * on Cell 2. `outsideArea.ts` states the difference at both definitions.
   */
  const outsideAreaOperatorIds = useMemo(
    () => outsideAreaFor(operatorPool, pathOf(createNodeId)),
    [operatorPool, pathOf, createNodeId],
  );

  /**
   * R-316: what the cell's standard cycle time makes of a span, for the two
   * popovers. Null whenever there is no cycle time for that (cell, part) —
   * which is the normal case, and renders as no placeholder at all.
   *
   * The popovers hold no rule: they render one, exactly as they do for
   * `requiredSkills` and `outsideAreaOperatorIds` above. The arithmetic lives
   * in `standardTarget.ts` and is shared with the board index, so a chip and
   * the form that edits it can never disagree.
   */
  function standardFor(
    nodeId: string,
    productId: string | null,
    range: { startMin: number; endMin: number },
    efficiencyPercent: number,
  ): number | null {
    if (index === null || productId === null || productId === "") return null;
    return standardTargetQty({
      range,
      template: index.templateForNode.get(nodeId) ?? null,
      efficiencyPercent,
      secondsPerUnit: index.cycleTimeByKey.get(cycleTimeKey(nodeId, productId)),
    });
  }

  if (sessionLoading) {
    return <p>Loading session…</p>;
  }

  // ⚠️ THERE IS NO `if (!session)` BRANCH HERE ANY MORE, AND ITS ABSENCE IS THE
  // POINT. It used to render "Sign in with a dev profile to see schedule data"
  // with a `DevProfileSwitcher` under it — the whole signed-out door, from
  // before P1-6b gave the app a real one. `RequireAuth` now wraps every route
  // below the shell and renders `<Outlet />` ONLY for `screen === "app"`, which
  // is `!loading && hasSession && hasProfile`; a signed-out visitor is
  // redirected to `/sign-in` and never mounts this component at all. So the
  // branch could not be reached, and a second signed-out screen that disagreed
  // with the real one was the failure waiting in it.
  //
  // ⭐ `sessionLoading` ABOVE IS NOT DEAD AND STAYS. `useSession` keeps its
  // `session`/`loading` in per-instance `useState` (only `lastUserId` is at
  // module scope), so this component mounts with `loading: true` and repeats
  // the `getSession()` round trip `RequireAuth` has already made. That flash is
  // real, it is the "five duplicated getSession() round trips" debt the queue
  // records under `SessionProvider`, and it is not this change's to fix.

  // ⭐ NOWHERE TO OPEN IS A REAL STATE, NOT AN ERROR. An org member with no
  // grant on any node has no board — pinned server-side by 0027's case V8 —
  // and the honest sentence describes THEM rather than the app. Rendering a
  // spinner forever, or "no data", would both be lies.
  if (!rootsLoading && !rootsError && roots.length === 0) {
    return (
      <div className={styles.panel}>
        <h1>Board</h1>
        <p>{NO_PLACES_MESSAGE}</p>
        <DevProfileSwitcher />
      </div>
    );
  }

  return (
    <div
      className={styles.page}
      // P1-4c D49: tokens are the source of truth for anything CSS also
      // needs — `--band-h`/`--lane-h` are set here, once, from the active
      // density, so `RunBand.module.css`'s `height: var(--band-h)` (and any
      // other CSS that reads these tokens) can never disagree with the
      // pixel math `TrackRow`/`RunBand`/`DirectBlock`/`AssignmentChip`
      // compute in JS from this same `density` object. Chosen over
      // `document.documentElement.style.setProperty`: a style prop here is
      // scoped to the board (no global mutation outside React's own
      // lifecycle) and updates automatically when `density` changes, with
      // no extra effect/cleanup to write. `--rail-w` is deliberately NOT
      // set here — per D47 it is driven by `--ui-scale` (viewport width),
      // not density, and stays defined in tokens.css/global.css only. P1-4d
      // D54: under Fit, `--ui-scale` follows the fit scale instead (a row
      // 2.5x taller with 11px text looks broken) — set inline here, same
      // pattern as `--band-h`/`--lane-h`, computed in JS as a plain number
      // so the viewport-driven `@supports` CSS path is not involved at all.
      // Left `undefined` (not set) when Fit is off, so the element falls
      // back through the CSS cascade to P1-4c's existing viewport-driven
      // `:root { --ui-scale }` — text then grows with the rows under Fit,
      // and with the screen otherwise, never by both at once (D54).
      style={{
        ["--band-h" as string]: `${density.bandHeight}px`,
        ["--lane-h" as string]: `${density.laneHeight}px`,
        ["--chip-h" as string]: `${density.chipHeight}px`,
        ["--avatar-size" as string]: `${density.avatarSize}px`,
        ["--ui-scale" as string]:
          densityMode === "fit" ? String(Math.min(1.75, Math.max(1, fitScale))) : undefined,
      }}
    >
      {/* Dev-only identity switcher. MUST stay reachable WHILE SIGNED IN, not
          only on the signed-out screen: acceptance items 6-7 (switch Admin ->
          Ana -> Marco and watch for stale rows) are untestable otherwise, and
          T3 is specifically about that switch. Self-gates on
          `import.meta.env.DEV`. This was lost once when the file was rebuilt
          from a stale copy — if it disappears again, look here first. */}
      <DevProfileSwitcher />

      <BoardToolbar
        roots={roots}
        rootPath={rootPath}
        onRootChange={selectRootPath}
        zoomIndex={zoomIndex}
        onZoomChange={setZoomIndex}
        windowStartDate={windowStartDate}
        windowDayCount={windowDayCount}
        onWindowChange={(start, days) => {
          setWindowStartDate(start);
          setWindowDayCount(days);
        }}
        onShiftWindowByDays={shiftWindowByDays}
        onGoToToday={() => goToToday(zone)}
        products={boardQuery.data?.products ?? []}
        isFetching={boardQuery.isFetching && hasData}
        dateFormat={dateFormat}
        zone={zone}
      />

      {boardQuery.status === "pending" && !hasData && (
        <p className={styles.status}>Loading board window…</p>
      )}

      {boardQuery.status === "error" && (
        <p className={styles.error}>
          {isSchedulerError(boardQuery.error)
            ? describeSchedulerError(boardQuery.error)
            : "Something went wrong loading the board."}
        </p>
      )}

        // S67 (R-445) DECIDED: filters the Key to what is actually on the
        // board in the shown window; `products` above stays the readable
        // catalogue the create/copy pop-ups need.
        productIdsInWindow={productIdsInWindow}
        // F-170: the end-of-window note renders only while this is true.
        atWindowEnd={atWindowEnd}
      {hasData && index && boardQuery.data && (
        <>
          {import.meta.env.DEV && index.droppedRanges > 0 && (
        // S67 (R-445): the same per-person, per-board key `CommandLauncher`
        // below is given (`historyStorageKey`), computed again here rather
        // than lifted to a shared variable so this edit touches nothing the
        // launcher's own lane owns. "Show more" remembers itself under its
        // own storage prefix (`BoardToolbar.tsx`'s `readShowMore`), so the
        // two never collide even though both key off the same value.
        historyKey={
          session?.user.id && rootPath ? historyStorageKey(session.user.id, rootPath) : null
        }
            <p className={styles.devWarning}>
              dev warning: {index.droppedRanges} row(s) had an unparseable time range and were
              dropped from the board.
            </p>
          )}
          {/* P1-7a: the SAME server flag that gates the panel below and the
              create pop-up further down (`canPlace`, DEF-0015/R-239) -- a
              viewer never sees a bar whose pop-up cannot open. `commandCtx`
              is null until the board has data, which the outer `hasData &&
              index` guard already ensures once this renders.

              S48-a / R-396: the bar itself now lives behind `CommandLauncher`
              -- a fixed corner button and the panel it opens -- rather than
              rendering at the top of the board; it is still gated on the
              same `canPlace && commandCtx !== null` a viewer never clears,
              and can render anywhere in the page tree since the launcher is
              fixed-positioned regardless of where this sits.

              R-403 / D129 (S54): a THIRD gate now sits beside those two --
              `commandBarLaunch.show`, the plant's own command_bar setting
              (off/typed/voice) resolved for this board's root and folded
              through `launcherFor` with `canPlace` already. `off` hides the
              launcher for EVERYONE on that board, admin included -- the
              requirement's own words, "a viewer's view, for everyone". */}
          {canPlace && commandCtx !== null && commandBarLaunch.show && (
            <CommandLauncher
              // R-427: this person, THIS BOARD -- the key the conversation
              // thread is kept under (last 24 hours, in localStorage). The
              // second half is the board ROOT, not the plant (S62-b reviewer
              // fix F): a line supervisor and a plant admin are looking at
              // different boards, and the turns are about the cells in front
              // of you. Null until both are known, which only happens before
              // the board has loaded at all; a change to either flushes the
              // sentence in progress and starts the other thread clean.
              historyKey={
                session?.user.id && rootPath ? historyStorageKey(session.user.id, rootPath) : null
              }
              ctx={commandCtx}
              dateFormat={dateFormat}
              zone={index.zone}
              reader={COMMAND_BAR_READER}
              recognizer={commandBarLaunch.voice ? BOARD_RECOGNIZER : null}
              recognizerName={() => engineRef.current}
              onOpen={(resolved, anchor, report) => {
                // R-385: a `retime` target is never a create; `onRetime`
                // below is the caller for that branch of the union.
                if (resolved.target.kind === "retime") return;
                // F-164: the outcome is RETURNED, so the bar's trace records
                // what the writer answered rather than assuming it wrote.
                return dragApi.openCreateFromCommand({
                  nodeId: resolved.nodeId,
                  range: resolved.range,
                  operatorId: resolved.operatorId,
                  target: resolved.target,
                  anchor,
                  // S61-a review fix (R-425, F-155): set only when a
                  // not_certified "warn" question was suppressed by a
                  // reason the bar already collected -- without this,
                  // `openCreateFromCommand` opens the popover unchecked,
                  // ignoring the reason entirely (the reviewer's own live
                  // bug: the readout said "· override: ..." and nothing was
                  // written).
                  override: resolved.override,
                  // F-165 (S62-b): the AREA twin -- set only when an
                  // `outside_area` question was answered with a reason.
                  areaOverride: resolved.areaOverride,
                  // F-167: the pop-up this opens reports back through here.
                  onResult: report,
                });
              }}
              onRetime={(resolved, anchor) => {
                if (resolved.target.kind !== "retime") return;
                dragApi.retimeAssignmentFromCommand({
                  assignmentId: resolved.target.assignmentId,
                  range: resolved.range,
                  anchor,
                });
              }}
              onBook={(resolved, anchor, report) => {
                if (resolved.target.kind !== "run_create") return;
                return dragApi.openCreateRunFromCommand({
                  nodeId: resolved.nodeId,
                  range: resolved.range,
                  productId: resolved.target.productId,
                  headcount: resolved.target.headcount,
                  anchor,
                  onResult: report,
                });
              }}
              onRetimeRun={(resolved, anchor) => {
                if (resolved.target.kind !== "retime_run") return;
                dragApi.retimeRunFromCommand({
                  runId: resolved.target.runId,
                  range: resolved.range,
                  anchor,
                });
              }}
              // S41-b: no second door -- the SAME removal the assignment
              // pop-up's own Delete button calls (`onDelete=
              // {dragApi.removeAssignment}` below).
              onUnassign={(resolved) => dragApi.removeAssignment(resolved.assignmentId)}
              // S41-c: called for BOTH targets -- a `retime` re-times through
              // the drag's own path (R-385's, no second path for the
              // move-in-time half); a `move_cell` opens the create pop-up
              // preset under `presetMove` (no second door).
              onMove={(resolved, anchor, report) => {
                if (resolved.target.kind === "retime") {
                  dragApi.retimeAssignmentFromCommand({
                    assignmentId: resolved.assignmentId,
                    range: resolved.range,
                    anchor,
                  });
                  return;
                } else {
                  return dragApi.openMoveFromCommand({
                    assignmentId: resolved.assignmentId,
                    nodeId: resolved.nodeId,
                    range: resolved.range,
                    operatorId: resolved.operatorId,
                    productId: resolved.productId,
                    anchor,
                    // S61-a review fix (R-425, F-155): same reasoning as
                    // `onOpen` above -- a `move_cell` target is the only
                    // shape `ResolvedMove.override` is ever set for.
                    override: resolved.override,
                    // F-165 (S62-b): the AREA twin, same reasoning as
                    // `onOpen`'s above.
                    areaOverride: resolved.areaOverride,
                    onResult: report,
                  });
                }
              }}
              // S58 / R-415 (D132 item 4): a headcount sentence writes one
              // existing field, never a create or a re-time -- through the
              // SAME `updateRunFields` mutation the job panel's own
              // headcount field uses (`saveRunFields`'s own door, no second
              // one), keyed on the run and number the resolver already
              // found.
              // F-164: `setHeadcountFromCommand` answers with a promise
              // now -- the bar waits for it before recording the readout.
              onSetHeadcount={(resolved) =>
                dragApi.setHeadcountFromCommand(resolved.runId, resolved.headcount)
              }
              // S47 / R-395: told what is in question -- drawn on the board
              // through `HighlightProvider` below.
              onHighlight={setHighlight}
              // S59 / R-419: "Show that day" -- see `handleShowDay`'s own
              // doc above for what each target shape does.
              onShowDay={handleShowDay}
              // S51 / R-400 (design §19.98/D127): the several-lot's one
              // writer -- runs the resolved commands in order through the
              // SAME doors the props above already use, never a second copy
              // (see `useDragGesture.ts`'s own `runLot` doc for the writer
              // each resolved shape reaches).
              onRunLot={dragApi.runLot}
              // S47 / R-395 item 4: a spoken/typed yes with no question
              // standing reaches the currently-open create pop-up ONLY when
              // a sentence opened it (`autoCreate`) -- `submitIfClean` itself
              // reads R-384's `clean` and refuses a second fire.
              onConfirmWord={() => createPopoverRef.current?.submitIfClean() ?? "none"}
              onCancelWord={() => {
                // S62-b re-check fix (2): the SPLIT pop-up counts too. A create
                // pop-up a sentence opened can hand its write on to the
                // split-coverage one (F-167's `handed_off`), and from that
                // moment the create pop-up is gone -- so a spoken or typed
                // "no" found nothing to claim, said "Nothing to cancel" and
                // left the split pop-up standing over a sentence that was
                // still waiting. `commandResult` is set on it only when a
                // sentence opened the pop-up it came from, which is exactly
                // the case a cancel word may claim.
                if (popover?.kind === "split" && popover.commandResult) {
                  dragApi.cancelSplit();
                  return true;
                }
                if (popover?.kind === "create" && popover.autoCreate) {
                  // S62-b reviewer fix (C): through the POP-UP's own cancel,
                  // never `dragApi.closePopover()` -- closing it from outside
                  // unmounts it without its `onResult` ever firing, and the
                  // sentence that opened it waits for an answer that can no
                  // longer come. `cancel()` closes it the same way the Cancel
                  // button does, reporting `cancelled` on the way out.
                  if (createPopoverRef.current) createPopoverRef.current.cancel();
                  else dragApi.closePopover();
                  return true;
                }
                return false;
              }}
            />
          )}
          {boardQuery.data.nodes.length === 0 ? (
            <BoardEmptyState />
          ) : (
            <div className={styles.body}>
              {/* R-346, the viewer clause: the panel is a place to pick people
                 from, so someone who cannot place anyone on this board does
                 not get one. The server says who can (`can_place`); the board
                 renders the answer. "For a viewer, the left panel serves no
                 purpose, so we should hide it, the only thing they see is
                 the board." */}
              {canPlace && (
                <OperatorPanel
                  operators={operatorPool}
                  /* R-346: who is offered here by DEFAULT -- everyone whose home
                     covers the board's own place or sits inside it. The rest of
                     the plant is the same list minus these, shown by the panel's
                     own control. Decided in `lib/outsideArea.ts`, never here. */
                  hereOperatorIds={panelHereIds}
                  /* R-357: the panel marks anyone on leave over the shown window
                     the way it marks someone from another area. */
                  absences={absences}
                  skillById={index.skillById}
                  nodeById={index.nodeById}
                  assignmentsByOperator={index.assignmentsByOperator}
                  windowStart={index.windowStart}
                  windowMinutes={index.windowMinutes}
                  zone={zone}
                  capacityCap={index.capacityCap}
                  /* S65-a (R-438): the root's own shift pattern, the band
                     `bookingWords` measures every chip against. */
                  rootTemplate={rootTemplateFor(index, rootPath)}
                  open={operatorPanelOpen}
                  onToggleOpen={() => setOperatorPanelOpen(!operatorPanelOpen)}
                  draggingOperatorId={
                    dragApi.activeDrag?.subject.kind === "panel"
                      ? dragApi.activeDrag.subject.operator.id
                      : null
                  }
                  /* S65-a (R-439): the SAME per-person, per-board value
                     `CommandLauncher`'s `historyKey` above is given --
                     computed again here, not lifted to a shared variable,
                     for the same reason `BoardToolbar`'s own copy gives
                     (S67): this edit touches nothing another lane owns.
                     `railWidth.ts`'s `railKey` (inside `OperatorPanel`)
                     prefixes it before it reaches storage, so the rail's
                     remembered width never collides with the command
                     panel's remembered size under this same value. */
                  widthStorageKey={
                    session?.user.id && rootPath
                      ? historyStorageKey(session.user.id, rootPath)
                      : null
                  }
                  dragApi={{
                    beginPanelDrag: dragApi.beginPanelDrag,
                    updatePanelDrag: dragApi.updatePanelDrag,
                    endPanelDrag: dragApi.endPanelDrag,
                    cancelDrag: dragApi.cancelDrag,
                  }}
                />
              )}
              {/* S47 / R-395: the only subtree with an assignment block in
                  it -- `DirectBlock`/`AssignmentChip` read `highlight`
                  through this, never as a prop threaded through
                  `BoardGrid`/`TrackRow`. */}
              <HighlightProvider value={highlight}>
                <BoardGrid
                  index={index}
                  levelById={levelById}
                  collapsedNodeIds={collapsedNodeIds}
                  onToggleCollapsed={toggleCollapsed}
                  zoomIndex={zoomIndex}
                  productById={index.productById}
                  operatorById={index.operatorById}
                  scrollToNowNonce={scrollToNowNonce}
                  dragApi={dragApi}
                  setDropRowResolver={dragApi.setDropRowResolver}
                  onFitScaleChange={handleFitScaleChange}
                  dateFormat={dateFormat}
                />
              </HighlightProvider>
            </div>
          )}
        </>
      )}

      <Toasts />

      {/* ⭐ R-331: `eligibilityPolicy` below is THE RULE OF THE CELL THIS
          POPOVER IS ON, not the company's. `board_window` resolves one answer
          per node (migration 0051) because a supervisor cannot read the
          override on their own plant's root and a browser-side walk would
          therefore fall through to the company default and offer an override
          tick on a plant set to refuse. An unknown node falls back to the
          STRICT answer, never the permissive one — see `policyForNode`. */}
      {/* DEF-0015 / R-239: the create pop-up is a place to PLACE people, so it
          is gated on the server's `can_place`. In practice `useDragGesture`
          already refuses to open it for a viewer (Enter on a track and a
          click-drag both do nothing), so this guard is belt-and-braces at the
          render boundary and the single answer the whole board reads. */}
      {canPlace && popover?.kind === "create" && (
        <CreatePopover
          // The review lane's finding: keyed on `seq` so a second typed
          // command opening this popover while an earlier one is still in
          // flight is always a fresh mount -- an unkeyed re-render would
          // update this component's props in place and the mount-only
          // R-384 auto-press effect would never re-arm for it.
          key={popover.seq}
          ref={createPopoverRef}
          nodeId={popover.nodeId}
          anchor={popover.anchor}
          initialRange={popover.range}
                  onWindowEdgeChange={handleWindowEdgeChange}
          shiftChips={popover.shiftChips}
          defaultCreateMode={defaultCreateMode}
          products={offeredProducts}
          // R-342, the maintainer: "Operators from other plants should not be shown
          // in the list, period, it is the same as the operators shown on the left
          // panel." So this is the panel's own list, the same variable, not a
          // second filter that could drift from it.
          operators={operatorPool}
          hereOperatorIds={createHereIds}
          windowStart={index?.windowStart ?? from}
          requiredSkills={index?.skillsForNode.get(popover.nodeId) ?? []}
          outsideAreaOperatorIds={outsideAreaOperatorIds}
          eligibilityPolicy={policyForNode(index, popover.nodeId)}
          /* R-357: the leave check runs beside the certificate check, under the
             same resolved policy — a line before Save, the same predicate the
             server runs (`absenceGaps`). */
          absences={absences}
          presetOperatorId={popover.presetOperatorId}
          presetProductId={popover.presetProductId}
          presetRun={popover.presetRun}
          presetMode={popover.presetMode}
          presetHeadcount={popover.presetHeadcount}
          presetMove={popover.presetMove}
          autoCreate={popover.autoCreate}
          dateFormat={dateFormat}
          onCancel={dragApi.closePopover}
          /* F-167: set only when the typed command bar opened this pop-up --
             its way of telling the bar whether the write landed. */
          onResult={popover.commandResult}
          onSubmitRun={dragApi.submitCreateRun}
          onSubmitDirect={dragApi.submitCreateDirect}
          onSubmitMove={dragApi.submitMove}
          defaultTargetFor={(productId, range, efficiencyPercent) =>
            standardFor(popover.nodeId, productId, range, efficiencyPercent)
          }
        />
      )}

      {popover?.kind === "run" && (
        <RunPopover
          // DEF-0015 / R-239: a viewer may open a run band read-only (details
          // shown, no editable field, Save or Delete), so it opens rather than
          // being gated away, but honours the server's `can_place`.
          readOnly={!canPlace}
          run={popover.run}
          crew={popover.crew}
          anchor={popover.anchor}
          windowStart={index?.windowStart ?? from}
          dateFormat={dateFormat}
          zone={zone}
          products={boardQuery.data?.products ?? []}
          onCancel={dragApi.closePopover}
          onSave={dragApi.saveRunFields}
          onDelete={dragApi.deleteRunWithMode}
        />
      )}

      {/* P1-4e D61/D62: opened proactively from `capacity_probe`, never
          from a rejection — see `openSplitPopover` in useDragGesture. */}
      {popover?.kind === "split" && (
        <SplitCoveragePopover
          operatorName={popover.operatorName}
          capPercent={popover.capPercent}
          participants={popover.participants}
          anchor={popover.anchor}
          onChangeParticipant={dragApi.updateSplitParticipant}
          onSplitEvenly={dragApi.splitEvenlyAction}
          onConfirm={dragApi.confirmSplit}
          onCancel={dragApi.cancelSplit}
          fits={splitFits(
            popover.participants.map((p) => p.efficiencyPercent),
            popover.capPercent,
          )}
        />
      )}

      {/* §9 debt 2: `window.confirm` replacement for the crew-outside-the-
          run-window warning on a run resize. */}
      {popover?.kind === "confirm" && (
        <ConfirmPopover
          message={popover.message}
          anchor={popover.anchor}
          onConfirm={dragApi.confirmYes}
          onCancel={dragApi.confirmNo}
          title={popover.title}
          choices={popover.choices}
          onChoose={dragApi.confirmChoose}
        />
      )}

      {/* P1-4e D65: ported from the mockup's `.chip-ghost` — follows the
          raw pointer (`position: fixed`, viewport coordinates) while a
          panel drag is in flight; T24: read fresh off `activeDrag` every
          render, never a value captured at drag-start. */}
      {dragApi.activeDrag?.subject.kind === "panel" && (
        <div
          className={operatorPanelStyles.chipGhost}
          style={{
            left: dragApi.activeDrag.pointerClientX + 8,
            top: dragApi.activeDrag.pointerClientY - 14,
          }}
        >
          <span className={operatorPanelStyles.avatar}>
            {dragApi.activeDrag.subject.operator.displayName.slice(0, 2).toUpperCase()}
          </span>
          <span className={operatorPanelStyles.nm}>
            {dragApi.activeDrag.subject.operator.displayName}
          </span>
        </div>
      )}

      {popover?.kind === "assignment" && (
        <AssignmentPopover
          /* DEF-0015 / R-239: a viewer may open a chip read-only (the details
             are shown, but no Person select, no editable field, no Save or
             Delete -- only Close), so it opens rather than being gated away,
             and honours the server's `can_place`. */
          readOnly={!canPlace}
          /* R-343 / R-342: the person picker offers the LEFT PANEL'S list --
             this plant's people, the same variable the panel is given, never a
             second filter that could drift from it. */
          operators={operatorPool}
          /* R-346, resolved for THIS chip's cell -- not for `createNodeId`,
             which belongs to a different pop-up. */
          hereOperatorIds={assignmentHereIds}
          assignment={popover.assignment}
          homeRun={popover.homeRun}
          operator={
            index === null ? undefined : operatorViewFor(popover.assignment, index.operatorById)
          }
          /* D113: the same helper the create pop-up uses marks the people from
             another AREA of this plant, resolved for THIS chip's cell -- not
             for `createNodeId`, which belongs to a different pop-up. */
          outsideAreaOperatorIds={assignmentOutsideAreaIds}
          products={boardQuery.data?.products ?? []}
          anchor={popover.anchor}
          windowStart={index?.windowStart ?? from}
          dateFormat={dateFormat}
          zone={zone}
          /* R-357: the leave line for the CHOSEN person, over this row's own
             window, refused in place under `block`. The policy is resolved for
             this chip's cell exactly as the create pop-up resolves its own, so
             the two pop-ups cannot disagree about who is refused. */
          absences={absences}
          eligibilityPolicy={policyForNode(index, popover.assignment.nodeId)}
          onCancel={dragApi.closePopover}
          onSave={dragApi.saveAssignmentFields}
          onReassign={dragApi.reassignAssignment}
          onDelete={dragApi.removeAssignment}
          defaultTargetFor={(efficiencyPercent) =>
            standardFor(
              popover.assignment.nodeId,
              // D5: a run-attached chip carries no product of its own.
              popover.assignment.productId ?? popover.homeRun?.productId ?? null,
              { startMin: popover.assignment.startMin, endMin: popover.assignment.endMin },
              efficiencyPercent,
            )
          }
        />
      )}
    </div>
  );
}
