/**
 * P1-7a — the typed command bar, half two: the FORM's words become RECORDS.
 *
 * ⚠️ THIS MODULE IMPORTS ONLY TYPES FROM `./parse.ts`. Every rule it needs
 * from the board is PASSED IN through `ResolveContext` by `BoardPage` — the
 * product scope (`offeredAt`, the same `productsOfferedAtNode` the pop-up's
 * list is built with), the run-containment rule (`fitsRun`, the same
 * `assignmentFitsRun` a drag uses), the run-overlap rule (`findRunOverlap`,
 * the same one a drag uses when dropping a run onto a cell), the plant-local
 * day axis (`days`, `todayIndex`, `wallToOffset`, all from `index.dayAxis`)
 * and the minimum duration. This module holds NO copy of any of them, so the
 * bar and the pop-up cannot disagree (CLAUDE.md §4: whatever a client offers
 * is decided by the same test the server runs).
 *
 * Never guesses: two candidates is a question, not a coin toss (R-379).
 *
 * S41-a (docs/agent-briefs/s41-a-book-a-job-brief.md) adds `resolveCommand`'s
 * second intent, `book` — a JOB (a run of a part on a cell for a span), never
 * a person. `resolveCommand` dispatches on `command.intent`; the assign path
 * (`resolveAssignCommand`) is unchanged in meaning. The cell step, the part
 * step, and the day-and-span step are shared by both intents through private
 * helpers (`resolveCellStep`, `resolvePartStep`, `resolveDaySpanStep`).
 */
import type { AssignCommand, BookCommand, Command, MoveCommand, UnassignCommand } from "./parse.ts";

/** One day of the board's window, as the plant's calendar sees it. Built by
 *  `BoardPage` from `index.dayAxis.dayStarts` + `partsInZone(_, index.zone)`. */
export interface BoardDay {
  /** 0-based position in the window. */
  index: number;
  /** "2026-09-03" in the PLANT'S zone. */
  iso: string;
  /** 0 = Sunday … 6 = Saturday, of `iso`. */
  weekday: 0 | 1 | 2 | 3 | 4 | 5 | 6;
}

/** A block the board is showing, in the pop-up's own minute coordinates (R-385). */
export interface ContextAssignment {
  id: string;
  nodeId: string;
  /** null for a departed person (D110) — such a block never matches. */
  operatorId: string | null;
  /** The block's EFFECTIVE part: its own `productId` for a direct block, its run's
   *  product for a run-attached block; null when neither is known (deleted product,
   *  D110) — such a block never matches. */
  productId: string | null;
  startMin: number;
  endMin: number;
  /** "10:00–14:00" in the plant's zone — the same `formatClock` pair the run label
   *  uses, without the name (the question sentence supplies person, part and cell). */
  label: string;
  /** S41-b: the effective part's NAME (its own product for a direct block,
   *  its run's product for a run-attached one — the same lookup that builds
   *  `productId` above, one step further, in `commandAssignments`). null
   *  when the id itself is null or the product is unknown. */
  productName: string | null;
}

/** A run the board is showing, in the pop-up's own minute coordinates. */
export interface ContextRun {
  id: string;
  nodeId: string;
  /** null once the product has been deleted (D110) — such a run never matches. */
  productId: string | null;
  startMin: number;
  endMin: number;
  /** The D66 label a drag's confirm prompt uses: "<product name> <start>–<end>". */
  label: string;
  /** S41-a: "08:00–16:00" — the same two `formatClock` calls `label` is built
   *  from, without the product name (the `job_exists` sentence already names
   *  the product, so the run's own label would repeat it). */
  span: string;
}

/** What the resolver is allowed to know. Built by `BoardPage` beside `offeredProducts`. */
export interface ResolveContext {
  /** Track rows only (`row.isTrack`), in board order. */
  cells: ReadonlyArray<{ id: string; name: string; path: string }>;
  /** Every node the index knows, for walking a cell's ancestors by name. */
  nodeById: ReadonlyMap<string, { id: string; name: string; path: string }>;
  /** THE SAME VARIABLE the create pop-up receives as `operators` (`operatorPool`,
   *  R-342 / `pickerPool.test.ts`). The resolver matches ACTIVE people only —
   *  the pop-up's `here` and `elsewhere` lists both filter on `active` first. */
  operators: ReadonlyArray<{
    id: string;
    displayName: string;
    employeeRef: string | null;
    active: boolean;
  }>;
  /** Active parts, NOT yet narrowed to a cell. */
  products: ReadonlyArray<{ id: string; sku: string; name: string }>;
  /** The board's own scope rule, passed in: `BoardPage` hands
   *  `(nodeId) => productsOfferedAtNode(activeProducts, nodeId)`. */
  offeredAt: (nodeId: string) => ReadonlyArray<{ id: string }>;
  /** The window's days, index order, length = dayCount. */
  days: ReadonlyArray<BoardDay>;
  /** The day `now` falls on in the plant's zone, or null when today is not on the board. */
  todayIndex: number | null;
  /** D88a/D88b: real minutes from the window's origin to wall-clock `minuteOfDay`
   *  on day `dayIndex` — `index.dayAxis.wallToOffset`. On a DST changeover day
   *  this is NOT `dayIndex * 1440 + minuteOfDay`; never do that arithmetic here. */
  wallToOffset: (dayIndex: number, minuteOfDay: number) => number;
  /** Every run in the window (`index.runsByNode`, flattened, board order). */
  runs: ReadonlyArray<ContextRun>;
  /** D66 containment, passed in (`assignmentFitsRun` from `lib/interaction.ts`). */
  fitsRun: (
    a: { startMin: number; endMin: number },
    run: { startMin: number; endMin: number },
  ) => boolean;
  /** `MIN_DURATION_MINUTES` (D31), passed in, never retyped. */
  minDurationMinutes: number;
  /** R-385: every block in the window (`commandAssignments(index)`), board order. */
  assignments: ReadonlyArray<ContextAssignment>;
  /** R-385: half-open overlap, passed in (`rangesOverlap` from `lib/interaction.ts`). */
  overlaps: (
    a: { startMin: number; endMin: number },
    b: { startMin: number; endMin: number },
  ) => boolean;
  /** S41-a: a cell runs one job at a time — the SAME `findRunOverlap` a run
   *  drag/resize refuses a drop with, passed in from `lib/interaction.ts`.
   *  `excludeRunId` lets a re-time check against every OTHER job on the cell. */
  findRunOverlap: (
    range: { startMin: number; endMin: number },
    runs: ContextRun[],
    excludeRunId: string | null,
  ) => ContextRun | null;
}

/**
 * The first two members are structurally identical to `AssignmentTarget` in
 * `src/lib/api/mutations.ts` (declared again here so this module keeps its
 * no-import rule; `tsc` in `BoardPage` proves the narrowing before
 * `openCreateFromCommand`, which only ever receives an `AssignmentTarget`).
 */
export type CommandTarget =
  | { kind: "run"; runId: string }
  | { kind: "direct"; productId: string }
  /** R-385: not a create at all — re-time this existing block to `range`. */
  | { kind: "retime"; assignmentId: string };

export interface ResolvedCommand {
  intent: "assign";
  nodeId: string;
  operatorId: string;
  productId: string;
  target: CommandTarget;
  /** Real minutes from the window's origin — the pop-up's own `Range`. */
  range: { startMin: number; endMin: number };
  /** "Sam Patel → Housing A · Plant 1 › Assembly › Line 1 › Cell 1 · 2026-09-03 · 10:00–14:00"
   *  (+ " · joining <run label>" for a run target). The ISO day is a token the bar
   *  re-renders through `formatDayLabel(_, dateFormat, zone)`. */
  readout: string;
}

/** S41-a: a "book a job" sentence resolves to either a brand-new job (never
 *  written by this module — `CreatePopover`'s run mode writes it) or a
 *  re-time of an existing one (the drag's own `retimeRun`, R-387). */
export type BookTarget =
  | { kind: "run_create"; productId: string; headcount: number | null }
  | { kind: "retime_run"; runId: string };

export interface ResolvedBook {
  intent: "book";
  nodeId: string;
  productId: string;
  target: BookTarget;
  range: { startMin: number; endMin: number };
  /** "Housing A · Plant 1 › Assembly › Line 1 › Cell 1 · 2026-09-03 · 06:00–14:00 · 3 people"
   *  (+ " · changing <run label>" for a retime; the " · N people" part only
   *  when the sentence said a number). */
  readout: string;
}

/**
 * S41-b (docs/agent-briefs/s41-b-unassign-brief.md §3): "Unassign Sam from
 * Cell 1 in Line 1 from 10 to 2" resolves to the ONE existing block it names
 * -- never a create, never written by this module. The pressed button's
 * answer is `assignmentId`; the caller removes it through the SAME
 * `dragApi.removeAssignment` the block's own Delete button calls.
 */
export interface ResolvedUnassign {
  intent: "unassign";
  assignmentId: string;
  /** "Removing Sam Patel's Housing A block · Plant 1 › Assembly › Line 1 ›
   *  Cell 1 · 2026-09-03 · 10:00–14:00" */
  readout: string;
}

/**
 * S41-c (docs/agent-briefs/s41-c-move-brief.md §4): "Move Sam on Cell 1 to
 * Cell 2 in Line 1" resolves to the ONE existing block it names, moved to
 * `nodeId` (the TARGET -- the source cell for a `retime`, the new cell for a
 * `move_cell`) over `range`. Never written by this module: the caller sends
 * `moveAssignment` (a `move_cell` target) or re-times through the SAME path
 * R-385's own retime uses (a `retime` target -- no second door for the
 * move-in-time half).
 */
export interface ResolvedMove {
  intent: "move";
  assignmentId: string;
  /** The TARGET node: unchanged for a `retime`, the new cell for `move_cell`. */
  nodeId: string;
  operatorId: string;
  /** The block's EFFECTIVE part today (its own, or its run's). */
  productId: string;
  range: { startMin: number; endMin: number };
  target: { kind: "retime" } | { kind: "move_cell" };
  /** "Moving Sam Patel's Housing A block · Plant 1 › Assembly › Line 1 ›
   *  Cell 1 · 2026-09-03 · 10:00–14:00 → Cell 2 · 10:00–14:00" (the arrow
   *  names what changes: the cell, the hours, or both). */
  readout: string;
}

export type Candidate = {
  id: string;
  label: string;
  /** What to put in the sentence when this button is pressed ("" for a run: the
   *  answer goes into `attach`, not the sentence). */
  word: string;
  /** S41-b: the block's effective part NAME, `null` when unknown -- ONLY set
   *  by the unassign path's `remove_which` candidates, so the one-block
   *  message doesn't have to recover it by parsing `label` back apart.
   *  Every other question leaves this undefined. */
  part?: string | null;
};

export type Question =
  | {
      kind: "ambiguous";
      field: "operator" | "product" | "place";
      text: string;
      candidates: Candidate[];
    }
  | { kind: "unknown"; field: "operator" | "product" | "place"; text: string }
  | { kind: "not_offered"; product: string; cell: string }
  | { kind: "place_mismatch"; cell: string; qualifier: string; elsewhere: Candidate[] }
  | { kind: "day_off_board"; text: string }
  | { kind: "too_short"; minutes: number; min: number }
  /** R-383: the span sits inside one or more jobs for this part on this cell,
   *  and `command.attach` is still null. `runs` are the candidates, board order. */
  | { kind: "run_exists"; product: string; cell: string; runs: Candidate[] }
  /** R-385: the person already has one or more blocks for this part on this cell whose
   *  hours overlap the sentence's, and `command.existing` is still null. `blocks` are
   *  the candidates, board order; `span` is the sentence's "HH:MM–HH:MM"; `same` is
   *  true when there is exactly one block and its hours equal the sentence's. */
  | {
      kind: "block_exists";
      person: string;
      product: string;
      cell: string;
      span: string;
      blocks: Candidate[];
      same: boolean;
    }
  /** R-385: `command.existing` names a block that is no longer among the hits and no
   *  other block of this person's overlaps — the board changed under the question. */
  | { kind: "block_gone"; person: string; product: string; cell: string }
  /** S41-a / R-387: a job of the SAME part already overlaps the sentence's
   *  hours on that cell. `run` is that job (`word` is always "" — the answer
   *  goes into `existing`, not the sentence); `same` is true when its hours
   *  already equal the sentence's. */
  | {
      kind: "job_exists";
      product: string;
      cell: string;
      span: string;
      run: Candidate;
      same: boolean;
    }
  /** S41-a: a job of ANOTHER part overlaps — a cell runs one job at a time;
   *  nothing to offer but the sentence's own words. */
  | { kind: "job_in_the_way"; product: string; cell: string; other: string }
  /** S41-a: `command.existing` names a job that is no longer on this cell and
   *  no other job overlaps — the board changed under the question. */
  | { kind: "job_gone"; product: string; cell: string }
  /** S41-b / R-388: the blocks the sentence names, each a button; `same` is
   *  irrelevant here (a removal, never a re-time). */
  | { kind: "remove_which"; person: string; cell: string; when: string; blocks: Candidate[] }
  /** S41-b: no block of this person's on this cell (for the sentence's
   *  hours, or the whole day when it gave none) — nothing to remove. */
  | { kind: "no_block"; person: string; cell: string; when: string }
  /** S41-b: `command.existing` names a block that is no longer among the
   *  hits and no other block overlaps — the board changed under the
   *  question. */
  | { kind: "block_gone_remove"; person: string; cell: string }
  /** S41-c / R-389: more than one block matches the move sentence's person,
   *  cell and day, and `command.existing` is still null -- each a button,
   *  in `remove_which`'s shape (a removal asks even for one; a move never
   *  does -- exactly one hit is taken without asking). */
  | { kind: "move_which"; person: string; cell: string; when: string; blocks: Candidate[] };

export type Resolution =
  | { ok: true; resolved: ResolvedCommand | ResolvedBook | ResolvedUnassign | ResolvedMove }
  | { ok: false; question: Question };

// ---------------------------------------------------------------------------
// Private helpers. None of these are exported; nothing here is a copy of a
// board rule — they are string/shape plumbing only (matching tiers, ancestor
// walks, label building). The rules themselves (offeredAt, fitsRun,
// findRunOverlap, the day axis, the minimum duration) all come from
// ResolveContext.
// ---------------------------------------------------------------------------

type Node = { id: string; name: string; path: string };
type ProductLike = ResolveContext["products"][number];

function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[^a-z0-9 /-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The one matching function (brief §5): exact, then starts-with, then
 *  contains; first tier with ANY hit wins; never the "best" of several. */
function matchName<T>(word: string, items: readonly T[], keyOf: (t: T) => string): T[] {
  const w = normalizeForMatch(word);
  if (w === "") return [];
  const withKeys = items.map((it) => ({ it, key: normalizeForMatch(keyOf(it)) }));
  const exact = withKeys.filter((x) => x.key === w).map((x) => x.it);
  if (exact.length > 0) return exact;
  const starts = withKeys.filter((x) => x.key.startsWith(w)).map((x) => x.it);
  if (starts.length > 0) return starts;
  return withKeys.filter((x) => x.key.includes(w)).map((x) => x.it);
}

/** Root-first ancestor path prefixes, EXCLUDING the node's own full path
 *  (brief §5: "copy `ancestorPaths`'s idea ... not its export"). */
function ancestorPrefixes(path: string): string[] {
  const segments = path.split(".");
  const out: string[] = [];
  for (let i = 1; i < segments.length; i++) {
    out.push(segments.slice(0, i).join("."));
  }
  return out;
}

function buildPathIndex(nodeById: ResolveContext["nodeById"]): Map<string, Node> {
  const byPath = new Map<string, Node>();
  for (const n of nodeById.values()) byPath.set(n.path, n);
  return byPath;
}

function ancestorsOf(cell: Node, byPath: Map<string, Node>): Node[] {
  return ancestorPrefixes(cell.path)
    .map((p) => byPath.get(p))
    .filter((n): n is Node => n !== undefined);
}

function placeLabel(cell: Node, byPath: Map<string, Node>): string {
  const names = ancestorsOf(cell, byPath).map((n) => n.name);
  return `${cell.name} — ${names.join(" › ")}`;
}

/** Filters a set of cell candidates by one qualifier word, using the same
 *  three-tier rule as `matchName`, applied to each candidate's ancestor
 *  names as a group (first tier with ANY hit, across all candidates, wins). */
function filterByQualifier(cands: Node[], qualifier: string, byPath: Map<string, Node>): Node[] {
  const w = normalizeForMatch(qualifier);
  const exact: Node[] = [];
  const starts: Node[] = [];
  const contains: Node[] = [];
  for (const c of cands) {
    const names = ancestorsOf(c, byPath).map((n) => normalizeForMatch(n.name));
    if (names.some((n) => n === w)) {
      exact.push(c);
    } else if (names.some((n) => n.startsWith(w))) {
      starts.push(c);
    } else if (names.some((n) => n.includes(w))) {
      contains.push(c);
    }
  }
  if (exact.length > 0) return exact;
  if (starts.length > 0) return starts;
  return contains;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

const WEEKDAY_FULL_NAMES: readonly string[] = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

function resolveDay(
  day: AssignCommand["day"],
  ctx: ResolveContext,
): { ok: true; dayIndex: number } | { ok: false; question: Question } {
  if (day === null) {
    return { ok: true, dayIndex: ctx.todayIndex ?? 0 };
  }
  if (day.kind === "today") {
    if (ctx.todayIndex === null)
      return { ok: false, question: { kind: "day_off_board", text: "today" } };
    return { ok: true, dayIndex: ctx.todayIndex };
  }
  if (day.kind === "tomorrow") {
    if (ctx.todayIndex === null) {
      return { ok: false, question: { kind: "day_off_board", text: "tomorrow" } };
    }
    const idx = ctx.todayIndex + 1;
    if (ctx.days.some((d) => d.index === idx)) return { ok: true, dayIndex: idx };
    return { ok: false, question: { kind: "day_off_board", text: "tomorrow" } };
  }
  if (day.kind === "weekday") {
    const found = ctx.days.find((d) => d.weekday === day.day);
    if (found) return { ok: true, dayIndex: found.index };
    return { ok: false, question: { kind: "day_off_board", text: WEEKDAY_FULL_NAMES[day.day] } };
  }
  // day.kind === "date"
  const found = ctx.days.find((d) => d.iso === day.iso);
  if (found) return { ok: true, dayIndex: found.index };
  return { ok: false, question: { kind: "day_off_board", text: day.iso } };
}

// ---------------------------------------------------------------------------
// Shared steps (brief §3: "the parser and resolver share the assign path's
// ... cell and part steps through private helpers"). Both `AssignCommand` and
// `BookCommand` carry `place`/`product`/`day`/`start`/`end` in the same shape,
// so these take just those fields rather than a whole command.
// ---------------------------------------------------------------------------

/** Step 1 (both intents): the first place word against `ctx.cells`, each
 *  further word a qualifier over ancestor names, exactly as brief §5
 *  describes. */
function resolveCellStep(
  place: readonly string[],
  ctx: ResolveContext,
  byPath: Map<string, Node>,
): { ok: true; cell: Node } | { ok: false; question: Question } {
  const firstPlaceWord = place[0] ?? "";
  let cellCandidates = matchName(firstPlaceWord, ctx.cells, (c) => c.name) as Node[];
  if (cellCandidates.length === 0) {
    return { ok: false, question: { kind: "unknown", field: "place", text: firstPlaceWord } };
  }
  for (const qualifier of place.slice(1)) {
    const filtered = filterByQualifier(cellCandidates, qualifier, byPath);
    if (filtered.length === 0) {
      const elsewhere = cellCandidates.map((c) => ({
        id: c.id,
        label: placeLabel(c, byPath),
        word: c.name,
      }));
      return {
        ok: false,
        question: { kind: "place_mismatch", cell: firstPlaceWord, qualifier, elsewhere },
      };
    }
    cellCandidates = filtered;
  }
  if (cellCandidates.length > 1) {
    return {
      ok: false,
      question: {
        kind: "ambiguous",
        field: "place",
        text: firstPlaceWord,
        candidates: cellCandidates.map((c) => ({
          id: c.id,
          label: placeLabel(c, byPath),
          word: c.name,
        })),
      },
    };
  }
  return { ok: true, cell: cellCandidates[0] };
}

/** Step 2 (both intents): match the product word, then check `offeredAt`
 *  this cell — exactly brief §5's matching tiers and scope check. */
function resolvePartStep(
  productWord: string,
  cell: Node,
  ctx: ResolveContext,
): { ok: true; product: ProductLike } | { ok: false; question: Question } {
  let productHits = matchName(productWord, ctx.products, (p) => p.name);
  if (productHits.length === 0) {
    productHits = matchName(productWord, ctx.products, (p) => p.sku);
  }
  if (productHits.length === 0) {
    productHits = matchName(productWord, ctx.products, (p) => `${p.sku}/${p.name}`);
  }
  if (productHits.length === 0 && productWord.includes("/")) {
    const pieces = productWord
      .split("/")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const matchedIds = new Set<string>();
    for (const piece of pieces) {
      for (const p of matchName(piece, ctx.products, (x) => x.name)) matchedIds.add(p.id);
      for (const p of matchName(piece, ctx.products, (x) => x.sku)) matchedIds.add(p.id);
    }
    if (matchedIds.size === 1) {
      const [onlyId] = matchedIds;
      productHits = ctx.products.filter((p) => p.id === onlyId);
    }
  }
  if (productHits.length === 0) {
    return { ok: false, question: { kind: "unknown", field: "product", text: productWord } };
  }
  if (productHits.length > 1) {
    return {
      ok: false,
      question: {
        kind: "ambiguous",
        field: "product",
        text: productWord,
        candidates: productHits.map((p) => ({ id: p.id, label: p.name, word: p.name })),
      },
    };
  }
  const product = productHits[0];
  const offered = ctx.offeredAt(cell.id);
  if (!offered.some((o) => o.id === product.id)) {
    return { ok: false, question: { kind: "not_offered", product: product.name, cell: cell.name } };
  }
  return { ok: true, product };
}

/** Step 3 (both intents): resolve the day word to an index, compute the span
 *  in real minutes, and refuse a too-short one — exactly brief §5's rules. */
function resolveDaySpanStep(
  day: AssignCommand["day"],
  start: { hour: number; minute: number },
  end: { hour: number; minute: number },
  ctx: ResolveContext,
):
  | { ok: true; dayIndex: number; startMin: number; endMin: number; timeText: string }
  | { ok: false; question: Question } {
  const dayResolution = resolveDay(day, ctx);
  if (!dayResolution.ok) return { ok: false, question: dayResolution.question };
  const dayIndex = dayResolution.dayIndex;
  const startMin = ctx.wallToOffset(dayIndex, start.hour * 60 + start.minute);
  const endMin = ctx.wallToOffset(dayIndex, end.hour * 60 + end.minute);
  if (endMin - startMin < ctx.minDurationMinutes) {
    return {
      ok: false,
      question: { kind: "too_short", minutes: endMin - startMin, min: ctx.minDurationMinutes },
    };
  }
  const timeText = `${pad2(start.hour)}:${pad2(start.minute)}–${pad2(end.hour)}:${pad2(end.minute)}`;
  return { ok: true, dayIndex, startMin, endMin, timeText };
}

type OperatorLike = ResolveContext["operators"][number];

/** Step (assign AND unassign, S41-b brief §2: extracted rather than
 *  duplicated so the assign path's own meaning is untouched): match the
 *  person word against active operators, name first then employeeRef —
 *  exactly brief §5's tiers, unchanged from the pre-S41-b inline step 3 of
 *  `resolveAssignCommand`. */
function resolvePersonStep(
  operatorWord: string,
  ctx: ResolveContext,
): { ok: true; operator: OperatorLike } | { ok: false; question: Question } {
  const activeOperators = ctx.operators.filter((o) => o.active);
  let operatorHits = matchName(operatorWord, activeOperators, (o) => o.displayName);
  if (operatorHits.length === 0) {
    const withRef = activeOperators.filter((o) => o.employeeRef !== null);
    operatorHits = matchName(operatorWord, withRef, (o) => o.employeeRef as string);
  }
  if (operatorHits.length === 0) {
    return { ok: false, question: { kind: "unknown", field: "operator", text: operatorWord } };
  }
  if (operatorHits.length > 1) {
    return {
      ok: false,
      question: {
        kind: "ambiguous",
        field: "operator",
        text: operatorWord,
        candidates: operatorHits.map((o) => ({
          id: o.id,
          label: o.displayName,
          word: o.displayName,
        })),
      },
    };
  }
  return { ok: true, operator: operatorHits[0] };
}

/** The assign path (unchanged in meaning from before S41-a/S41-b): cell,
 *  part, person (shared, `resolvePersonStep`), day and span, the own-block
 *  question (R-385), the run question (R-383), then the readout. */
function resolveAssignCommand(command: AssignCommand, ctx: ResolveContext): Resolution {
  const byPath = buildPathIndex(ctx.nodeById);

  // 1. Cell.
  const cellResult = resolveCellStep(command.place, ctx, byPath);
  if (!cellResult.ok) return { ok: false, question: cellResult.question };
  const cell = cellResult.cell;

  // 2. Part.
  const partResult = resolvePartStep(command.product, cell, ctx);
  if (!partResult.ok) return { ok: false, question: partResult.question };
  const product = partResult.product;

  // 3. Person (shared with unassign, S41-b: resolvePersonStep).
  const personResult = resolvePersonStep(command.operator, ctx);
  if (!personResult.ok) return { ok: false, question: personResult.question };
  const operator = personResult.operator;

  // 4. Day and span.
  const spanResult = resolveDaySpanStep(command.day, command.start, command.end, ctx);
  if (!spanResult.ok) return { ok: false, question: spanResult.question };
  const { dayIndex, startMin, endMin, timeText } = spanResult;

  // 5. The own-block question (R-385).
  const own = ctx.assignments.filter(
    (x) =>
      x.nodeId === cell.id &&
      x.operatorId === operator.id &&
      x.productId === product.id &&
      ctx.overlaps({ startMin, endMin }, x),
  );
  const blockCandidates = (): Candidate[] =>
    own.map((x) => ({ id: x.id, label: x.label, word: "" }));
  const askBlock = (): Resolution => ({
    ok: false,
    question: {
      kind: "block_exists",
      person: operator.displayName,
      product: product.name,
      cell: cell.name,
      span: timeText,
      blocks: blockCandidates(),
      same: own.length === 1 && own[0].startMin === startMin && own[0].endMin === endMin,
    },
  });
  let retime: ContextAssignment | null = null;
  if (own.length > 0 && command.existing === null) {
    return askBlock();
  } else if (command.existing !== null && command.existing.kind === "retime") {
    const wantedId = command.existing.assignmentId;
    const hit = own.find((x) => x.id === wantedId) ?? null;
    if (hit) {
      retime = hit;
    } else if (own.length > 0) {
      return askBlock(); // the board changed: re-ask, never guess
    } else {
      return {
        ok: false,
        question: {
          kind: "block_gone",
          person: operator.displayName,
          product: product.name,
          cell: cell.name,
        },
      };
    }
  }
  // `existing.kind === "separate"`, or no own block at all: fall through to the run question.

  // 6. The run question (R-383) — skipped entirely when re-timing a block: a
  // re-timed block's attachment is decided by the drag's own containment
  // logic on the way to the write (§6), not by the resolver.
  let target: CommandTarget;
  let hits: ContextRun[] = [];
  if (retime !== null) {
    target = { kind: "retime", assignmentId: retime.id };
  } else {
    hits = ctx.runs.filter(
      (r) =>
        r.nodeId === cell.id && r.productId === product.id && ctx.fitsRun({ startMin, endMin }, r),
    );
    const runCandidates = (): Candidate[] =>
      hits.map((r) => ({ id: r.id, label: r.label, word: "" }));
    if (hits.length === 0) {
      target = { kind: "direct", productId: product.id };
    } else if (command.attach === null) {
      return {
        ok: false,
        question: {
          kind: "run_exists",
          product: product.name,
          cell: cell.name,
          runs: runCandidates(),
        },
      };
    } else if (command.attach.kind === "run") {
      const runId = command.attach.runId;
      const matchedRun = hits.find((r) => r.id === runId);
      if (matchedRun) {
        target = { kind: "run", runId: matchedRun.id };
      } else {
        return {
          ok: false,
          question: {
            kind: "run_exists",
            product: product.name,
            cell: cell.name,
            runs: runCandidates(),
          },
        };
      }
    } else {
      target = { kind: "direct", productId: product.id };
    }
  }

  // Readout.
  const ancestorNames = ancestorsOf(cell, byPath).map((n) => n.name);
  const chain = [...ancestorNames, cell.name].join(" › ");
  const iso = ctx.days.find((d) => d.index === dayIndex)?.iso ?? "";
  let readout = `${operator.displayName} → ${product.name} · ${chain} · ${iso} · ${timeText}`;
  if (target.kind === "run") {
    const runLabel = hits.find((r) => r.id === target.runId)?.label ?? "";
    readout += ` · joining ${runLabel}`;
  } else if (target.kind === "retime" && retime !== null) {
    readout += ` · changing ${retime.label}`;
  }

  return {
    ok: true,
    resolved: {
      intent: "assign",
      nodeId: cell.id,
      operatorId: operator.id,
      productId: product.id,
      target,
      range: { startMin, endMin },
      readout,
    },
  };
}

/**
 * S41-a — the book path: cell, part (shared with assign), day and span
 * (shared), then the job question (brief §3): a cell runs one job at a
 * time, so an overlap of the SAME part asks whether to change its hours
 * (R-387); an overlap of ANOTHER part just says which job is in the way.
 */
function resolveBookCommand(command: BookCommand, ctx: ResolveContext): Resolution {
  const byPath = buildPathIndex(ctx.nodeById);

  // 1. Cell.
  const cellResult = resolveCellStep(command.place, ctx, byPath);
  if (!cellResult.ok) return { ok: false, question: cellResult.question };
  const cell = cellResult.cell;

  // 2. Part.
  const partResult = resolvePartStep(command.product, cell, ctx);
  if (!partResult.ok) return { ok: false, question: partResult.question };
  const product = partResult.product;

  // 3. Day and span.
  const spanResult = resolveDaySpanStep(command.day, command.start, command.end, ctx);
  if (!spanResult.ok) return { ok: false, question: spanResult.question };
  const { dayIndex, startMin, endMin, timeText } = spanResult;

  // 4. The job question (R-387).
  const runsOnCell = ctx.runs.filter((r) => r.nodeId === cell.id);
  let target: BookTarget;
  let retimeHit: ContextRun | null = null;
  if (command.existing === null) {
    const overlap = ctx.findRunOverlap({ startMin, endMin }, runsOnCell, null);
    if (overlap && overlap.productId === product.id) {
      const same = overlap.startMin === startMin && overlap.endMin === endMin;
      return {
        ok: false,
        question: {
          kind: "job_exists",
          product: product.name,
          cell: cell.name,
          span: timeText,
          run: { id: overlap.id, label: overlap.span, word: "" },
          same,
        },
      };
    }
    if (overlap) {
      return {
        ok: false,
        question: {
          kind: "job_in_the_way",
          product: product.name,
          cell: cell.name,
          other: overlap.label,
        },
      };
    }
    target = { kind: "run_create", productId: product.id, headcount: command.headcount };
  } else {
    // existing.kind === "retime"
    const hit = runsOnCell.find((r) => r.id === command.existing!.runId) ?? null;
    if (!hit) {
      return { ok: false, question: { kind: "job_gone", product: product.name, cell: cell.name } };
    }
    // The retime must not collide with ANOTHER job on the cell — the same
    // rule a drag applies before writing.
    const other = ctx.findRunOverlap({ startMin, endMin }, runsOnCell, hit.id);
    if (other) {
      return {
        ok: false,
        question: {
          kind: "job_in_the_way",
          product: product.name,
          cell: cell.name,
          other: other.label,
        },
      };
    }
    retimeHit = hit;
    target = { kind: "retime_run", runId: hit.id };
  }

  // Readout.
  const ancestorNames = ancestorsOf(cell, byPath).map((n) => n.name);
  const chain = [...ancestorNames, cell.name].join(" › ");
  const iso = ctx.days.find((d) => d.index === dayIndex)?.iso ?? "";
  let readout = `${product.name} · ${chain} · ${iso} · ${timeText}`;
  if (target.kind === "run_create" && command.headcount !== null) {
    readout += ` · ${command.headcount} people`;
  } else if (target.kind === "retime_run" && retimeHit !== null) {
    readout += ` · changing ${retimeHit.label}`;
  }

  return {
    ok: true,
    resolved: {
      intent: "book",
      nodeId: cell.id,
      productId: product.id,
      target,
      range: { startMin, endMin },
      readout,
    },
  };
}

/**
 * S41-b — the unassign path: cell, person (shared, `resolvePersonStep`), day
 * and span, then the block(s) to remove (brief §3/§6). `command.span ===
 * null` means "the whole day": `ctx.wallToOffset(dayIndex, 0)` through
 * `ctx.wallToOffset(dayIndex, 24 * 60)` — `wallToOffset` accepts a
 * minute-of-day past 1440 directly (`src/features/board/lib/time.ts`'s own
 * doc comment: "the excess carries into the following day"), so no special
 * case is needed even on the window's last day; the minimum-duration check
 * (part of `resolveDaySpanStep`) does not apply to the whole-day case since
 * it never calls that step.
 */
function resolveUnassignCommand(command: UnassignCommand, ctx: ResolveContext): Resolution {
  const byPath = buildPathIndex(ctx.nodeById);

  // 1. Cell.
  const cellResult = resolveCellStep(command.place, ctx, byPath);
  if (!cellResult.ok) return { ok: false, question: cellResult.question };
  const cell = cellResult.cell;

  // 2. Person (shared with assign).
  const personResult = resolvePersonStep(command.operator, ctx);
  if (!personResult.ok) return { ok: false, question: personResult.question };
  const operator = personResult.operator;

  // 3. Day and span.
  let dayIndex: number;
  let startMin: number;
  let endMin: number;
  let whenText: string;
  if (command.span !== null) {
    const spanResult = resolveDaySpanStep(command.day, command.span.start, command.span.end, ctx);
    if (!spanResult.ok) return { ok: false, question: spanResult.question };
    dayIndex = spanResult.dayIndex;
    startMin = spanResult.startMin;
    endMin = spanResult.endMin;
    whenText = spanResult.timeText;
  } else {
    const dayResolution = resolveDay(command.day, ctx);
    if (!dayResolution.ok) return { ok: false, question: dayResolution.question };
    dayIndex = dayResolution.dayIndex;
    startMin = ctx.wallToOffset(dayIndex, 0);
    endMin = ctx.wallToOffset(dayIndex, 24 * 60);
    whenText = ctx.days.find((d) => d.index === dayIndex)?.iso ?? "";
  }

  // 4. The block(s) -- brief §3: NO product filter (the sentence never names
  // a part), just person, cell and overlap.
  const hits = ctx.assignments.filter(
    (x) =>
      x.nodeId === cell.id && x.operatorId === operator.id && ctx.overlaps({ startMin, endMin }, x),
  );
  const blockCandidates = (): Candidate[] =>
    hits.map((x) => ({
      id: x.id,
      label: `${x.productName ?? "block"} ${x.label}`,
      word: "",
      part: x.productName,
    }));
  const askRemoveWhich = (): Resolution => ({
    ok: false,
    question: {
      kind: "remove_which",
      person: operator.displayName,
      cell: cell.name,
      when: whenText,
      blocks: blockCandidates(),
    },
  });

  if (command.existing === null) {
    if (hits.length === 0) {
      return {
        ok: false,
        question: {
          kind: "no_block",
          person: operator.displayName,
          cell: cell.name,
          when: whenText,
        },
      };
    }
    return askRemoveWhich();
  }
  const hit = hits.find((x) => x.id === command.existing!.assignmentId) ?? null;
  if (!hit) {
    if (hits.length > 0) return askRemoveWhich(); // the board changed: re-ask, never guess
    return {
      ok: false,
      question: { kind: "block_gone_remove", person: operator.displayName, cell: cell.name },
    };
  }

  // Readout.
  const ancestorNames = ancestorsOf(cell, byPath).map((n) => n.name);
  const chain = [...ancestorNames, cell.name].join(" › ");
  const iso = ctx.days.find((d) => d.index === dayIndex)?.iso ?? "";
  const readout = `Removing ${operator.displayName}'s ${hit.productName ?? "block"} block · ${chain} · ${iso} · ${hit.label}`;

  return { ok: true, resolved: { intent: "unassign", assignmentId: hit.id, readout } };
}

/**
 * S41-c — the move path: the current cell, the person (both shared), then
 * the day and the block -- found across the WHOLE DAY regardless of whether
 * the sentence gave hours (brief §4: "not the new hours — the new hours are
 * the destination"; RM9 pins a block found by the day even though the new
 * hours it is moved TO do not overlap it). Then the destination: `toPlace`
 * null resolves to R-385's own `retime` target; `toPlace` given resolves the
 * new cell by the shared cell step, checks the part is offered there, and
 * uses the sentence's new hours if given, else the block's own.
 */
function resolveMoveCommand(command: MoveCommand, ctx: ResolveContext): Resolution {
  const byPath = buildPathIndex(ctx.nodeById);

  // 1. The current cell.
  const cellResult = resolveCellStep(command.place, ctx, byPath);
  if (!cellResult.ok) return { ok: false, question: cellResult.question };
  const cell = cellResult.cell;

  // 2. The person (shared with assign/unassign).
  const personResult = resolvePersonStep(command.operator, ctx);
  if (!personResult.ok) return { ok: false, question: personResult.question };
  const operator = personResult.operator;

  // 3. The day, and the block(s) -- searched over the WHOLE DAY.
  const dayResolution = resolveDay(command.day, ctx);
  if (!dayResolution.ok) return { ok: false, question: dayResolution.question };
  const dayIndex = dayResolution.dayIndex;
  const dayStart = ctx.wallToOffset(dayIndex, 0);
  const dayEnd = ctx.wallToOffset(dayIndex, 24 * 60);
  const whenText = ctx.days.find((d) => d.index === dayIndex)?.iso ?? "";

  const hits = ctx.assignments.filter(
    (x) =>
      x.nodeId === cell.id &&
      x.operatorId === operator.id &&
      ctx.overlaps({ startMin: dayStart, endMin: dayEnd }, x),
  );
  const blockCandidates = (): Candidate[] =>
    hits.map((x) => ({
      id: x.id,
      label: `${x.productName ?? "block"} ${x.label}`,
      word: "",
      part: x.productName,
    }));
  const askMoveWhich = (): Resolution => ({
    ok: false,
    question: {
      kind: "move_which",
      person: operator.displayName,
      cell: cell.name,
      when: whenText,
      blocks: blockCandidates(),
    },
  });

  let blk: ContextAssignment;
  if (hits.length === 0) {
    return {
      ok: false,
      question: { kind: "no_block", person: operator.displayName, cell: cell.name, when: whenText },
    };
  } else if (hits.length === 1) {
    blk = hits[0];
  } else if (command.existing === null) {
    return askMoveWhich();
  } else {
    const hit = hits.find((x) => x.id === command.existing!.assignmentId) ?? null;
    if (!hit) return askMoveWhich(); // the board changed: re-ask, never guess
    blk = hit;
  }

  // 4. The destination.
  let target: { kind: "retime" } | { kind: "move_cell" };
  let targetNodeId: string;
  let startMin: number;
  let endMin: number;
  let arrow: string;

  if (command.toPlace === null) {
    // Move in time only -- R-385's own retime target (command.span is
    // guaranteed non-null here: parseMoveRest never returns toPlace null
    // and span null together).
    const spanResult = resolveDaySpanStep(command.day, command.span!.start, command.span!.end, ctx);
    if (!spanResult.ok) return { ok: false, question: spanResult.question };
    startMin = spanResult.startMin;
    endMin = spanResult.endMin;
    target = { kind: "retime" };
    targetNodeId = cell.id;
    arrow = spanResult.timeText;
  } else {
    const newCellResult = resolveCellStep(command.toPlace, ctx, byPath);
    if (!newCellResult.ok) return { ok: false, question: newCellResult.question };
    const newCell = newCellResult.cell;
    const offered = ctx.offeredAt(newCell.id);
    if (blk.productId === null || !offered.some((o) => o.id === blk.productId)) {
      return {
        ok: false,
        question: { kind: "not_offered", product: blk.productName ?? "", cell: newCell.name },
      };
    }
    if (command.span !== null) {
      const spanResult = resolveDaySpanStep(command.day, command.span.start, command.span.end, ctx);
      if (!spanResult.ok) return { ok: false, question: spanResult.question };
      startMin = spanResult.startMin;
      endMin = spanResult.endMin;
      arrow = `${newCell.name} · ${spanResult.timeText}`;
    } else {
      startMin = blk.startMin;
      endMin = blk.endMin;
      arrow = `${newCell.name} · ${blk.label}`;
    }
    target = { kind: "move_cell" };
    targetNodeId = newCell.id;
  }

  // Readout.
  const ancestorNames = ancestorsOf(cell, byPath).map((n) => n.name);
  const chain = [...ancestorNames, cell.name].join(" › ");
  const readout = `Moving ${operator.displayName}'s ${blk.productName ?? "block"} block · ${chain} · ${whenText} · ${blk.label} → ${arrow}`;

  return {
    ok: true,
    resolved: {
      intent: "move",
      assignmentId: blk.id,
      nodeId: targetNodeId,
      operatorId: operator.id,
      productId: blk.productId ?? "",
      range: { startMin, endMin },
      target,
      readout,
    },
  };
}

/** Order of resolution: cell, then part, then (assign only) person, then day
 *  and span, then the job/run/own-block question(s) (brief §5, extended by
 *  §3 for `book`, and S41-b for `unassign`). One question at a time.
 *  Dispatches on `command.intent`; the assign and book paths' own meaning
 *  are untouched by this dispatch.
 *
 * Overloaded (not just typed as `Command -> Resolution`) so a caller holding
 * a concrete `AssignCommand`, `BookCommand` or `UnassignCommand` — every
 * existing test's `cmd()`/`bookCmd()` fixture, for one — gets back the
 * narrower result type without a cast; only `CommandBar`, which holds the
 * `Command` union, sees the full `Resolution`.
 */
export function resolveCommand(
  command: AssignCommand,
  ctx: ResolveContext,
): { ok: true; resolved: ResolvedCommand } | { ok: false; question: Question };
export function resolveCommand(
  command: BookCommand,
  ctx: ResolveContext,
): { ok: true; resolved: ResolvedBook } | { ok: false; question: Question };
export function resolveCommand(
  command: UnassignCommand,
  ctx: ResolveContext,
): { ok: true; resolved: ResolvedUnassign } | { ok: false; question: Question };
export function resolveCommand(
  command: MoveCommand,
  ctx: ResolveContext,
): { ok: true; resolved: ResolvedMove } | { ok: false; question: Question };
export function resolveCommand(command: Command, ctx: ResolveContext): Resolution;
export function resolveCommand(command: Command, ctx: ResolveContext): Resolution {
  if (command.intent === "book") return resolveBookCommand(command, ctx);
  if (command.intent === "unassign") return resolveUnassignCommand(command, ctx);
  if (command.intent === "move") return resolveMoveCommand(command, ctx);
  return resolveAssignCommand(command, ctx);
}

function fieldWord(field: "operator" | "product" | "place"): string {
  if (field === "operator") return "person";
  if (field === "product") return "part";
  return "cell";
}

/** The sentence for a Question — the words the bar shows. Pure, so it is tested verbatim. */
export function describeQuestion(q: Question): string {
  switch (q.kind) {
    case "ambiguous":
      return `Which ${fieldWord(q.field)}? "${q.text}" matches ${q.candidates.length}:`;
    case "unknown":
      return `No ${fieldWord(q.field)} called "${q.text}" on this board.`;
    case "not_offered":
      return `${q.product} is not made at ${q.cell}, so it cannot be scheduled there.`;
    case "place_mismatch":
      return `There is no ${q.cell} in ${q.qualifier}. ${q.cell} is in ${q.elsewhere
        .map((c) => c.label)
        .join(" / ")}.`;
    case "day_off_board":
      return `${q.text} is not on the board. Move the board to that day first.`;
    case "too_short":
      return `That is ${q.minutes} minutes; a block is at least ${q.min} minutes.`;
    case "run_exists":
      if (q.runs.length === 1) {
        return `A ${q.product} job is already booked on ${q.cell}, ${q.runs[0].label}. Join it, or make a separate block?`;
      }
      return `${q.runs.length} ${q.product} jobs are already booked on ${q.cell}. Join one, or make a separate block?`;
    case "block_exists":
      if (q.blocks.length === 1) {
        if (q.same) {
          return `${q.person} is already on ${q.product} at ${q.cell} ${q.blocks[0].label} — nothing to change. Add a separate block?`;
        }
        return `${q.person} is already on ${q.product} at ${q.cell} ${q.blocks[0].label}. Change it to ${q.span}, or add a separate block?`;
      }
      return `${q.person} already has ${q.blocks.length} ${q.product} blocks at ${q.cell} (${q.blocks.map((b) => b.label).join(", ")}). Change one to ${q.span}, or add a separate block?`;
    case "block_gone":
      return `That ${q.product} block of ${q.person}'s at ${q.cell} is no longer on the board. Add it as a new block?`;
    case "job_exists":
      if (q.same) {
        return `A ${q.product} job is already booked on ${q.cell} ${q.run.label} — nothing to change.`;
      }
      return `A ${q.product} job is already booked on ${q.cell} ${q.run.label}. Change it to ${q.span}, or pick other hours?`;
    case "job_in_the_way":
      return `${q.cell} already runs ${q.other}; a cell runs one job at a time. Pick other hours, or change that job on the board.`;
    case "job_gone":
      return `That ${q.product} job on ${q.cell} is no longer on the board. Book it again?`;
    case "remove_which": {
      if (q.blocks.length === 1) {
        const candidate = q.blocks[0];
        // The candidate's own `part` (S41-b), never recovered by parsing
        // `label` back apart -- `label` stays the combined "<part> <time>"
        // string the many-block buttons read, so only the KNOWN prefix
        // (`part` plus one space, or the "block" fallback) is stripped to
        // get the bare time back out.
        const prefix = `${candidate.part ?? "block"} `;
        const when = candidate.label.startsWith(prefix)
          ? candidate.label.slice(prefix.length)
          : candidate.label;
        return candidate.part
          ? `Remove ${q.person}'s ${candidate.part} block on ${q.cell}, ${when}?`
          : `Remove ${q.person}'s block on ${q.cell}, ${when}?`;
      }
      return `${q.person} has ${q.blocks.length} blocks on ${q.cell} ${q.when}. Remove which?`;
    }
    case "no_block":
      return `${q.person} has no block on ${q.cell} ${q.when}.`;
    case "block_gone_remove":
      return `That block of ${q.person}'s on ${q.cell} is already gone.`;
    case "move_which":
      return `${q.person} has ${q.blocks.length} blocks on ${q.cell} ${q.when}. Move which?`;
  }
}
