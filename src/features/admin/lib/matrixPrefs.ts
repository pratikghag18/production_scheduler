/**
 * matrixPrefs.ts — what one viewer has chosen on the training matrix and wants
 * back next visit: the "expiring soon" window, and the area / line the grid is
 * narrowed to.
 *
 * ---------------------------------------------------------------------------
 * ⭐ THE SECOND PERSISTED PREFERENCE IN THIS PROJECT, AND IT FOLLOWS THE FIRST.
 * `plantFilter.ts` set the convention (a guarded, per-org `localStorage` value)
 * and wrote down why every rule there is a rule; this file obeys the same ones
 * rather than inventing its own:
 *
 *   • EVERY ACCESS IS WRAPPED. Reading `localStorage` THROWS — not returns null
 *     — in a browser set to block site data. An unguarded read takes the whole
 *     matrix down for a reader whose only crime is a privacy setting, to save a
 *     convenience. Parsing throws too on a value some other version wrote, so
 *     the parse sits inside the same guard.
 *   • IT IS SCOPED PER ORG. `user_profiles` is unique on `(org_id, user_id)`, so
 *     a node id remembered in one org is meaningless in another; the org is in
 *     the key so switching orgs cannot restore the wrong area.
 *   • A STORED CHOICE IS NEVER TRUSTED TO STILL RESOLVE. This file only reads and
 *     writes; reconciling a remembered area against what the reader can see now
 *     is the panel's job, exactly as `resolvePlantChoice` reconciles the plant.
 *     `MatrixPanel`'s `effectiveAreaId` / `effectiveLineId` already collapse a
 *     stale area or line to "All", so a deleted node falls back to a wider view,
 *     never to an empty grid.
 *
 * ---------------------------------------------------------------------------
 * ⚠️ WHAT IS HERE AND WHAT IS DELIBERATELY NOT. The window and the area / line
 * are a viewer's standing scope and are remembered. The operator multi-select is
 * NOT: it is a momentary "show just these two", it has none of the staleness
 * machinery area / line inherit from the plant cascade, and re-opening the panel
 * wanting the whole team back is the right default. Persisting it would be the
 * one way this feature could bring a reader back to a grid that looks empty.
 */

/* ===========================================================================
 * The window that decides "expiring soon".
 * =========================================================================== */

/** The days-ahead window offered on the matrix. A fixed, small set — the
 *  maintainer named 30 / 60 / 90 (§19.86) — so the control is three buttons and
 *  a stored value is validated against membership, never a free number. */
export type ExpiryWindow = 30 | 60 | 90;

/** The choices, in the order the control shows them. */
export const EXPIRY_WINDOWS: readonly ExpiryWindow[] = [30, 60, 90];

/** The default before anyone chooses — the constant the matrix shipped with. */
export const DEFAULT_EXPIRY_WINDOW: ExpiryWindow = 30;

/** Fold any stored / unknown value back onto a legal window. Anything that is
 *  not 60 or 90 becomes the 30-day default, so a corrupt or hand-edited value
 *  can only ever widen the grid's "clear" band, never crash it. */
export function coerceWindow(value: unknown): ExpiryWindow {
  return value === 60 ? 60 : value === 90 ? 90 : DEFAULT_EXPIRY_WINDOW;
}

/* ===========================================================================
 * The whole remembered view.
 * =========================================================================== */

/**
 * One viewer's remembered matrix view. `areaId` / `lineId` are node ids or
 * `null` for "All"; they are stored raw and reconciled by the panel against the
 * plant cascade, the same way `plantChoice` is reconciled by `resolvePlantChoice`.
 */
export interface MatrixView {
  window: ExpiryWindow;
  areaId: string | null;
  lineId: string | null;
}

/** The view before anyone has chosen anything. */
export const DEFAULT_MATRIX_VIEW: MatrixView = {
  window: DEFAULT_EXPIRY_WINDOW,
  areaId: null,
  lineId: null,
};

/** Is this view the untouched default? A default view REMOVES the key rather
 *  than storing a blob equal to the default — the absence of a key and an
 *  explicit default mean the same thing to `loadMatrixView`, and one
 *  representation cannot drift from the other (`savePlantChoice`'s rule). */
function isDefaultView(view: MatrixView): boolean {
  return view.window === DEFAULT_EXPIRY_WINDOW && view.areaId === null && view.lineId === null;
}

const KEY_PREFIX = "ps.admin.matrix.";

/**
 * The remembered view for this org, or the default when there is none, it
 * cannot be read, or it is a value some other version wrote. The parse is inside
 * the guard on purpose: `JSON.parse` throws on a malformed value exactly as
 * `getItem` throws when site data is blocked, and both must land on the default.
 */
export function loadMatrixView(orgId: string | null): MatrixView {
  if (orgId === null) return { ...DEFAULT_MATRIX_VIEW };
  try {
    const raw = window.localStorage.getItem(KEY_PREFIX + orgId);
    if (raw === null) return { ...DEFAULT_MATRIX_VIEW };
    const parsed = JSON.parse(raw) as Partial<Record<keyof MatrixView, unknown>>;
    return {
      window: coerceWindow(parsed.window),
      areaId: typeof parsed.areaId === "string" ? parsed.areaId : null,
      lineId: typeof parsed.lineId === "string" ? parsed.lineId : null,
    };
  } catch {
    return { ...DEFAULT_MATRIX_VIEW }; // blocked, unavailable, or unparseable
  }
}

/** Remember the view, or forget it when it is back to the default. Silent on a
 *  storage that throws: the choice still applies this session, it just will not
 *  outlive it. */
export function saveMatrixView(orgId: string | null, view: MatrixView): void {
  if (orgId === null) return;
  try {
    if (isDefaultView(view)) window.localStorage.removeItem(KEY_PREFIX + orgId);
    else window.localStorage.setItem(KEY_PREFIX + orgId, JSON.stringify(view));
  } catch {
    // Nothing to do and nothing to say.
  }
}

/* ===========================================================================
 * Where the area / line cascade hangs.
 *
 * ⭐ THE BUG THIS FIXES (the maintainer, 2 Sept): "site admins and supervisors
 * have no hierarchy level filters in the matrix tab, only the system admin has
 * them." The plant CHOOSER appears only for someone who can read more than one
 * plant, and the cascade used to anchor on that chooser's value — so anyone with
 * a single readable root (every site admin, every supervisor) got no area or
 * line filter at all. The cascade must instead anchor on what the reader can
 * see, whether or not a chooser was drawn.
 * =========================================================================== */

/**
 * The ids of the topmost nodes THIS READER can see — each a node whose parent is
 * not itself readable (`parentId` null, or an id absent from the set).
 *
 * ⚠️ NOT the same as `readablePlants` (the plant CHOOSER's list), which keeps to
 * true roots (`parentId === null`) on purpose. A supervisor granted an area reads
 * that area with its plant unreadable above it: the area is their top here, so
 * the cascade reaches one level further than the chooser does and they get a
 * filter. RLS already returns only readable nodes, so "no readable parent" is
 * exactly "topmost visible".
 */
export function readableRootIds(
  nodes: readonly { id: string; parentId: string | null }[],
): string[] {
  const known = new Set(nodes.map((n) => n.id));
  return nodes.filter((n) => n.parentId === null || !known.has(n.parentId)).map((n) => n.id);
}

/**
 * Which node the area / line cascade hangs off: the chosen plant when there is
 * one, else the reader's SOLE readable root (so a one-root site admin or
 * supervisor gets a cascade), else `null`.
 *
 * ⚠️ SEVERAL READABLE ROOTS AND NO CHOICE ("All plants") RESOLVES TO `null` — an
 * area cascade across plants is ambiguous ("Area 1" in which plant?), so there is
 * none until a plant is picked. This keeps the multi-plant system admin's
 * behaviour exactly as it was: no area filter at All plants, an area filter once
 * a plant is chosen.
 */
export function cascadeBaseId(choice: string | null, rootIds: readonly string[]): string | null {
  if (choice !== null) return choice;
  return rootIds.length === 1 ? rootIds[0] : null;
}

/* ===========================================================================
 * The honest empty state.
 * =========================================================================== */

/** Why the grid has nothing to draw — each a different thing to tell the reader,
 *  because "no trainings here", "no people here" and "you filtered everyone out"
 *  are three different problems with three different fixes. `ok` means draw the
 *  grid. */
export type MatrixEmptyReason = "ok" | "no-trainings" | "no-operators" | "none-selected";

/**
 * Which empty state (if any) the matrix is in, decided from the counts the panel
 * already has. Ordered so the WIDER absence wins: no trainings at all is named
 * before no operators, and both before "you unchecked everyone", so the message
 * points at the outermost thing to widen first.
 *
 * @param trainings   columns in scope.
 * @param opsInScope  operators the scope resolves to, before the multi-select.
 * @param shownOps    operators still shown after the multi-select.
 */
export function matrixEmptyReason(
  trainings: number,
  opsInScope: number,
  shownOps: number,
): MatrixEmptyReason {
  if (trainings === 0) return "no-trainings";
  if (opsInScope === 0) return "no-operators";
  if (shownOps === 0) return "none-selected";
  return "ok";
}

/** The sentence for each empty reason — plain, and each names its own fix. */
export const MATRIX_EMPTY_TEXT: Record<Exclude<MatrixEmptyReason, "ok">, string> = {
  "no-trainings": "No trainings apply to this scope yet — widen a filter above, or add a training.",
  "no-operators": "No operators in this scope — widen a filter above.",
  "none-selected": "No operators selected — choose some in the operator filter, or pick All.",
};
