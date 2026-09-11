/**
 * P1-7a — the typed command bar, half two: the FORM's words become RECORDS.
 *
 * ⚠️ THIS MODULE IMPORTS ONLY TYPES FROM `./parse.ts`. Every rule it needs
 * from the board is PASSED IN through `ResolveContext` by `BoardPage` — the
 * product scope (`offeredAt`, the same `productsOfferedAtNode` the pop-up's
 * list is built with), the run-containment rule (`fitsRun`, the same
 * `assignmentFitsRun` a drag uses), the plant-local day axis (`days`,
 * `todayIndex`, `wallToOffset`, all from `index.dayAxis`) and the minimum
 * duration. This module holds NO copy of any of them, so the bar and the
 * pop-up cannot disagree (CLAUDE.md §4: whatever a client offers is decided by
 * the same test the server runs).
 *
 * Never guesses: two candidates is a question, not a coin toss (R-379).
 *
 * Pre-seated as a type-only skeleton by the developer session (11 Sept) so the
 * two build lanes compile against one interface. Lane A fills the bodies.
 */
import type { AssignCommand } from "./parse.ts";

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
}

/**
 * Structurally identical to `AssignmentTarget` in `src/lib/api/mutations.ts`
 * (declared again here so this module keeps its no-import rule; `tsc` in the
 * board proves the two assign to each other at the one place they meet,
 * `openCreateFromCommand`).
 */
export type CommandTarget = { kind: "run"; runId: string } | { kind: "direct"; productId: string };

export interface ResolvedCommand {
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

export type Candidate = {
  id: string;
  label: string;
  /** What to put in the sentence when this button is pressed ("" for a run: the
   *  answer goes into `attach`, not the sentence). */
  word: string;
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
  | { kind: "run_exists"; product: string; cell: string; runs: Candidate[] };

export type Resolution =
  { ok: true; resolved: ResolvedCommand } | { ok: false; question: Question };

// ---------------------------------------------------------------------------
// Private helpers. None of these are exported; nothing here is a copy of a
// board rule — they are string/shape plumbing only (matching tiers, ancestor
// walks, label building). The rules themselves (offeredAt, fitsRun, the day
// axis, the minimum duration) all come from ResolveContext.
// ---------------------------------------------------------------------------

type Node = { id: string; name: string; path: string };

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

/** Order of resolution: cell, then part, then person, then day and span, then
 *  the run question (brief §5). One question at a time. */
export function resolveCommand(command: AssignCommand, ctx: ResolveContext): Resolution {
  const byPath = buildPathIndex(ctx.nodeById);

  // 1. Cell.
  const firstPlaceWord = command.place[0] ?? "";
  let cellCandidates = matchName(firstPlaceWord, ctx.cells, (c) => c.name) as Node[];
  if (cellCandidates.length === 0) {
    return { ok: false, question: { kind: "unknown", field: "place", text: firstPlaceWord } };
  }
  for (const qualifier of command.place.slice(1)) {
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
  const cell = cellCandidates[0];

  // 2. Part.
  let productHits = matchName(command.product, ctx.products, (p) => p.name);
  if (productHits.length === 0) {
    productHits = matchName(command.product, ctx.products, (p) => p.sku);
  }
  if (productHits.length === 0) {
    productHits = matchName(command.product, ctx.products, (p) => `${p.sku}/${p.name}`);
  }
  if (productHits.length === 0 && command.product.includes("/")) {
    const pieces = command.product
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
    return { ok: false, question: { kind: "unknown", field: "product", text: command.product } };
  }
  if (productHits.length > 1) {
    return {
      ok: false,
      question: {
        kind: "ambiguous",
        field: "product",
        text: command.product,
        candidates: productHits.map((p) => ({ id: p.id, label: p.name, word: p.name })),
      },
    };
  }
  const product = productHits[0];
  const offered = ctx.offeredAt(cell.id);
  if (!offered.some((o) => o.id === product.id)) {
    return { ok: false, question: { kind: "not_offered", product: product.name, cell: cell.name } };
  }

  // 3. Person.
  const activeOperators = ctx.operators.filter((o) => o.active);
  let operatorHits = matchName(command.operator, activeOperators, (o) => o.displayName);
  if (operatorHits.length === 0) {
    const withRef = activeOperators.filter((o) => o.employeeRef !== null);
    operatorHits = matchName(command.operator, withRef, (o) => o.employeeRef as string);
  }
  if (operatorHits.length === 0) {
    return { ok: false, question: { kind: "unknown", field: "operator", text: command.operator } };
  }
  if (operatorHits.length > 1) {
    return {
      ok: false,
      question: {
        kind: "ambiguous",
        field: "operator",
        text: command.operator,
        candidates: operatorHits.map((o) => ({
          id: o.id,
          label: o.displayName,
          word: o.displayName,
        })),
      },
    };
  }
  const operator = operatorHits[0];

  // 4. Day and span.
  const dayResolution = resolveDay(command.day, ctx);
  if (!dayResolution.ok) return { ok: false, question: dayResolution.question };
  const dayIndex = dayResolution.dayIndex;
  const startMin = ctx.wallToOffset(dayIndex, command.start.hour * 60 + command.start.minute);
  const endMin = ctx.wallToOffset(dayIndex, command.end.hour * 60 + command.end.minute);
  if (endMin - startMin < ctx.minDurationMinutes) {
    return {
      ok: false,
      question: { kind: "too_short", minutes: endMin - startMin, min: ctx.minDurationMinutes },
    };
  }

  // 5. The run question (R-383).
  const hits = ctx.runs.filter(
    (r) =>
      r.nodeId === cell.id && r.productId === product.id && ctx.fitsRun({ startMin, endMin }, r),
  );
  const runCandidates = (): Candidate[] =>
    hits.map((r) => ({ id: r.id, label: r.label, word: "" }));
  let target: CommandTarget;
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

  // Readout.
  const ancestorNames = ancestorsOf(cell, byPath).map((n) => n.name);
  const chain = [...ancestorNames, cell.name].join(" › ");
  const iso = ctx.days.find((d) => d.index === dayIndex)?.iso ?? "";
  const timeText = `${pad2(command.start.hour)}:${pad2(command.start.minute)}–${pad2(command.end.hour)}:${pad2(command.end.minute)}`;
  let readout = `${operator.displayName} → ${product.name} · ${chain} · ${iso} · ${timeText}`;
  if (target.kind === "run") {
    const runLabel = hits.find((r) => r.id === target.runId)?.label ?? "";
    readout += ` · joining ${runLabel}`;
  }

  return {
    ok: true,
    resolved: {
      nodeId: cell.id,
      operatorId: operator.id,
      productId: product.id,
      target,
      range: { startMin, endMin },
      readout,
    },
  };
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
  }
}
