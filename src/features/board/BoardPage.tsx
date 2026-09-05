import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HierarchyLevel } from "@/lib/api";
import { describeSchedulerError, isSchedulerError } from "@/lib/api";
import { DevProfileSwitcher } from "@/features/auth/DevProfileSwitcher";
import { useSession } from "@/features/auth/useSession";
import { canQueryAsUser } from "@/features/auth/session";
import { offeredHere, ownedInScope, productsOfferedAtNode } from "@/features/admin/lib/scope";
import { useDateFormat } from "@/features/admin/hooks/useOrgSettings";
import { operatorViewFor } from "./lib/history";
import { useBoardWindow } from "./hooks/useBoardWindow";
import { useRootPath } from "./hooks/useRootPath";
import { NO_PLACES_MESSAGE } from "./lib/rootSelection";
import { useBoardViewStore } from "./store/boardView";
import { useDragGesture } from "./hooks/useDragGesture";
import { buildBoardIndex, policyForNode, type BoardIndex } from "./lib/boardIndex";
import { DENSITIES, scaleDensity } from "./lib/geometry";
import { splitFits } from "./lib/interaction";
import { cycleTimeKey, standardTargetQty } from "./lib/standardTarget";
import { addMinutes, MINUTES_PER_DAY } from "./lib/time";
import { BoardToolbar } from "./components/BoardToolbar";
import { BoardGrid } from "./components/BoardGrid";
import { OperatorPanel } from "./components/OperatorPanel";
import { BoardEmptyState } from "./components/BoardEmptyState";
import { Toasts } from "./components/Toasts";
import { CreatePopover } from "./components/CreatePopover";
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

  // D14: the board window is always whole UTC days — from = 00:00:00.000Z
  // of the start date, to = 00:00:00.000Z of the day after the end date.
  const from = windowStartDate;
  const to = useMemo(
    () => addMinutes(windowStartDate, windowDayCount * MINUTES_PER_DAY),
    [windowStartDate, windowDayCount],
  );

  // Do not query as nobody: until the session resolves, an RLS-scoped read can
  // only come back 401. One shared predicate, never re-derived inline (§19.8).
  const canQuery = canQueryAsUser(session?.user.id ?? null, sessionLoading);
  // R-309: the org-wide date format for the board's day labels. Same shared
  // React Query cache as the Settings screen, so a change there re-renders the
  // board without a board refetch. Gated on `canQuery` (D91).
  /**
   * ⚠️ THE BOARD SHOWS EXACTLY ONE PLANT, so it asks that plant for its format.
   * It did not until F-090: the token was read company-wide, which was the only
   * possible answer until settings became per-plant, and afterwards was simply
   * the wrong one on every plant that had chosen otherwise.
   *
   * `rootPath` is a path and `useDateFormat` wants a node id, so the id comes
   * off the root already loaded rather than from a second read. Null while the
   * roots are still resolving, which falls back to the company answer — the
   * board renders no dates before it knows where it is.
   */
  const rootNodeId = useMemo(
    () => roots.find((r) => r.path === rootPath)?.id ?? null,
    [roots, rootPath],
  );
  const dateFormat = useDateFormat(canQuery, rootNodeId);
  // ⚠️ AND NOT UNTIL WE KNOW WHERE. `rootPath` is null while the places read is
  // in flight and stays null for someone with no access to any of them; asking
  // `board_window` for `""` would be the old hardcoded constant with extra
  // steps. The empty string can never reach the server because `enabled` is
  // false whenever it would be used — it exists only to keep the query key a
  // stable shape.
  const boardQuery = useBoardWindow(rootPath ?? "", from, to, canQuery && rootPath !== null);

  // T4: spinner only on "pending" with no cached data; keep rendering
  // stale data during a background refetch (isFetching), with a subtle
  // indicator in the toolbar instead of blanking the board every 30s.
  const hasData = boardQuery.data !== undefined;

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
    from,
    to,
    index: emptyIndex,
    defaultCreateMode,
    sessionUserId: session?.user.id ?? null,
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
   * D113: the people who do NOT belong at this cell.
   *
   * ⚠️ THE OPPOSITE TREATMENT FROM `offeredProducts` ABOVE, AND DELIBERATELY.
   * A product outside its scope is refused by the database with no way through
   * (0030 leaves the product half absolute, because migration 0029's proof
   * depends on it), so it is filtered OUT of the picker. A person outside
   * theirs can be placed anyway by anyone who may schedule here, with a reason
   * — so they stay in the list and are ANNOTATED. Filtering them would delete
   * the feature; offering the product would offer a guaranteed refusal.
   *
   * Fails open on an unresolvable node for the same reason `offeredHere` does:
   * an empty set annotates nobody, and the server still decides.
   */
  const outsideAreaOperatorIds = useMemo(() => {
    const out = new Set<string>();
    if (!boardQuery.data || createNodeId === null || index === null) return out;
    const path = index.nodeById.get(createNodeId)?.path;
    if (path === undefined) return out;
    const belongs = new Set(
      offeredHere(boardQuery.data.operators, path, index.nodeById).map((o) => o.id),
    );
    for (const o of boardQuery.data.operators) if (!belongs.has(o.id)) out.add(o.id);
    return out;
  }, [boardQuery.data, index, createNodeId]);

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

  /**
   * ⭐ THE ASSIGNABLE POOL, CUT TO THE CHOSEN PLANT. Reported from the app: a
   * system admin who picks one plant still saw every plant's operators in the
   * left panel. A site admin already sees only their plant's people (RLS scopes
   * their read); this makes a system admin's chosen plant behave the same.
   *
   * ⭐⭐ THE CUT IS MEMBERSHIP IN THE SCOPED NODES, not a path comparison.
   * `board_window` returns EVERY operator on purpose (S18 — so a cross-plant
   * assignment can still be DRAWN) but its `nodes` are scoped to the selected
   * root, so `index.nodeById` IS exactly this plant's subtree. An operator
   * belongs here iff its owner is one of those nodes. (An earlier version
   * resolved owner PATHS through `nodeById` and "failed open" on an owner it
   * could not find — but a different plant's owner is never in the scoped map,
   * so every out-of-plant operator was kept: the bug this replaces.)
   * `index.operatorById` still holds every operator, so an out-of-plant
   * assignment's chip still resolves its name.
   */
  const operatorPool = useMemo(() => {
    const all = boardQuery.data?.operators ?? [];
    if (index === null) return all;
    return ownedInScope(all, new Set(index.nodeById.keys()));
  }, [boardQuery.data, index]);

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
        onGoToToday={goToToday}
        products={boardQuery.data?.products ?? []}
        isFetching={boardQuery.isFetching && hasData}
        dateFormat={dateFormat}
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

      {hasData && index && boardQuery.data && (
        <>
          {import.meta.env.DEV && index.droppedRanges > 0 && (
            <p className={styles.devWarning}>
              dev warning: {index.droppedRanges} row(s) had an unparseable time range and were
              dropped from the board.
            </p>
          )}
          {boardQuery.data.nodes.length === 0 ? (
            <BoardEmptyState />
          ) : (
            <div className={styles.body}>
              <OperatorPanel
                operators={operatorPool}
                skillById={index.skillById}
                nodeById={index.nodeById}
                assignmentsByOperator={index.assignmentsByOperator}
                windowStart={index.windowStart}
                windowMinutes={index.windowMinutes}
                capacityCap={index.capacityCap}
                open={operatorPanelOpen}
                onToggleOpen={() => setOperatorPanelOpen(!operatorPanelOpen)}
                draggingOperatorId={
                  dragApi.activeDrag?.subject.kind === "panel"
                    ? dragApi.activeDrag.subject.operator.id
                    : null
                }
                dragApi={{
                  beginPanelDrag: dragApi.beginPanelDrag,
                  updatePanelDrag: dragApi.updatePanelDrag,
                  endPanelDrag: dragApi.endPanelDrag,
                  cancelDrag: dragApi.cancelDrag,
                }}
              />
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
      {popover?.kind === "create" && (
        <CreatePopover
          nodeId={popover.nodeId}
          anchor={popover.anchor}
          initialRange={popover.range}
          shiftChips={popover.shiftChips}
          defaultCreateMode={defaultCreateMode}
          products={offeredProducts}
          operators={boardQuery.data?.operators ?? []}
          windowStart={index?.windowStart ?? from}
          requiredSkills={index?.skillsForNode.get(popover.nodeId) ?? []}
          outsideAreaOperatorIds={outsideAreaOperatorIds}
          eligibilityPolicy={policyForNode(index, popover.nodeId)}
          presetOperatorId={popover.presetOperatorId}
          dateFormat={dateFormat}
          onCancel={dragApi.closePopover}
          onSubmitRun={dragApi.submitCreateRun}
          onSubmitDirect={dragApi.submitCreateDirect}
          defaultTargetFor={(productId, range, efficiencyPercent) =>
            standardFor(popover.nodeId, productId, range, efficiencyPercent)
          }
        />
      )}

      {popover?.kind === "run" && (
        <RunPopover
          run={popover.run}
          crew={popover.crew}
          anchor={popover.anchor}
          windowStart={index?.windowStart ?? from}
          dateFormat={dateFormat}
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
          assignment={popover.assignment}
          homeRun={popover.homeRun}
          operator={
            index === null ? undefined : operatorViewFor(popover.assignment, index.operatorById)
          }
          products={boardQuery.data?.products ?? []}
          anchor={popover.anchor}
          windowStart={index?.windowStart ?? from}
          dateFormat={dateFormat}
          onCancel={dragApi.closePopover}
          onSave={dragApi.saveAssignmentFields}
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
