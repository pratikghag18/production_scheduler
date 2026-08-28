/**
 * Shift patterns, the pure half — clock arithmetic, the overlap rules the
 * database enforces (and the one it does NOT), and the row assembly the panel
 * renders.
 *
 * Dependency-free at runtime, exactly like `siteAccess.ts`: the only imports
 * are `import type`, which are erased, so this module runs under
 * `node --experimental-strip-types` with nothing to resolve and is unit
 * testable without a network.
 *
 * ---------------------------------------------------------------------------
 * ⭐ MINUTES ARE AN IMPLEMENTATION DETAIL AND MUST NEVER REACH THE SCREEN.
 *
 * `shifts.start_min` / `end_min` are `smallint` minutes from the pattern's
 * midnight. A supervisor thinks in `06:00–14:00`. Every number that leaves
 * this module for a label goes through `minutesToLabel` / `describeSpan`, and
 * every number that enters from a control comes back through
 * `clockToMinutes` / `labelToMinutes`. There is no third path.
 *
 * ---------------------------------------------------------------------------
 * ⭐ PAST MIDNIGHT, AND WHY IT IS NOT WRAPPING.
 *
 * Migration 0005 constrains `start_min >= 0 and start_min < 1440` but puts NO
 * upper bound on `end_min` beyond `end_min - start_min <= 1440`. So a night
 * shift is stored UNWRAPPED and runs off the end of the day: the seed's
 * `1320..1800` is 22:00 until 06:00 the following morning, not `1320..360`.
 * `minutesToLabel(1500)` is therefore `"01:00 +1d"` — the clock the person
 * reads plus the day it lands on — and 1440 itself is `"00:00 +1d"`, midnight
 * at the END of the shift's day rather than at its start.
 *
 * Break minutes share that coordinate space. A break at `1440..1455` is
 * 00:00–00:15 the next morning and IS inside a 1320..1800 shift; a break at
 * `600..660` reads 10:00–11:00 and is NOT, even though 10:00 "looks like" a
 * daytime hour the shift never touches. That pair is the whole reason this
 * module exists rather than a `%1440` sprinkled through the panel.
 *
 * ---------------------------------------------------------------------------
 * ⭐ NOTHING WRAPS IN `overlappingShifts` EITHER, AND THAT IS FIDELITY, NOT AN
 * OVERSIGHT. The database's `shifts_no_overlap_within_template` is
 * `exclude using gist (template_id with =, int4range(start_min, end_min) with
 * &&)` on the RAW minute values. `1320..1800` and `0..480` therefore do NOT
 * collide as far as Postgres is concerned, even though 1440..1800 is the same
 * wall-clock morning as 0..360. A client-side check that wrapped would refuse
 * a save the server accepts — which is the forbidden direction (see
 * `siteAccess.ts`: anything the client hides the server must also refuse,
 * never the converse). This mirrors the constraint literally. See
 * `overlappingShifts`' own note for the empty-range case.
 *
 * ---------------------------------------------------------------------------
 * ⭐ `breakProblems` IS THE ONLY THING THAT CHECKS BREAKS AT ALL.
 *
 * `shift_breaks` carries `check (end_min > start_min)` and NOTHING else.
 * Migration 0005:55-56 says so in as many words: *"break lies inside its shift
 * stays application-validated — not a database constraint in v1."* Breaks may
 * overlap each other and may sit outside their shift as far as the server is
 * concerned. This function is the application half of that sentence, so it
 * REPORTS rather than blocks: a break that is already outside its shift in the
 * database still renders, flagged, because refusing to draw it would hide the
 * only evidence that it is wrong.
 *
 * ---------------------------------------------------------------------------
 * WHITESPACE. `.trim()` and nothing cleverer, matching `app_trim_ws`
 * (migration 0011) — but note that 0011 does NOT cover `shift_templates`,
 * `shifts` or `shift_breaks`, so there is no server-side backstop here at all.
 * The trim this module performs is the only one that happens.
 */
import type {
  ShiftBreakRow,
  ShiftNodeRow,
  ShiftPatternsPayload,
  ShiftRow,
  ShiftTemplateRow,
} from "@/lib/api";

/** Minutes in a day. `start_min < 1440`; `end_min` may exceed it. */
export const MINUTES_PER_DAY = 1440;

/** The longest a single shift may be — migration 0005's own CHECK. */
export const MAX_SHIFT_MINUTES = 1440;

/** A span in the pattern's minute coordinate space. */
export interface Span {
  startMin: number;
  endMin: number;
}

/* ===========================================================================
 * CLOCK ARITHMETIC
 * =========================================================================== */

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function isFiniteInt(v: number): boolean {
  return Number.isFinite(v) && Number.isInteger(v);
}

/**
 * How many whole days past the pattern's midnight this minute lands on.
 * `0` for anything inside the first day, `1` for 1440 upwards.
 *
 * ⚠️ 1440 IS DAY 1, NOT DAY 0. Midnight belongs to the day it opens, and a
 * shift ending at `1440` ends at 00:00 the NEXT morning — writing that as
 * "00:00" with no marker is the single most misreadable label this screen
 * could print, so `Math.floor` is used with no special case for the boundary.
 */
export function dayOffset(min: number): number {
  if (!isFiniteInt(min)) return 0;
  return Math.floor(min / MINUTES_PER_DAY);
}

/**
 * The clock face alone: `1500` -> `"01:00"`, `1440` -> `"00:00"`.
 *
 * This is what an `<input type="time">` wants as its `value`; the day marker
 * is carried beside it as a separate control, because a time input cannot
 * express one. `minutesToLabel` is what a READER should ever see.
 */
export function minutesToClock(min: number): string {
  if (!isFiniteInt(min)) return "--:--";
  const within = ((min % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return `${pad2(Math.floor(within / 60))}:${pad2(within % 60)}`;
}

/**
 * The clock face plus the day it falls on: `360` -> `"06:00"`,
 * `1500` -> `"01:00 +1d"`, `1440` -> `"00:00 +1d"`.
 */
export function minutesToLabel(min: number): string {
  const clock = minutesToClock(min);
  if (clock === "--:--") return clock;
  const days = dayOffset(min);
  if (days === 0) return clock;
  return days > 0 ? `${clock} +${days}d` : `${clock} ${days}d`;
}

/**
 * A whole span as one phrase: `"06:00–14:00"`, `"22:00–01:00 +1d"`.
 *
 * ⚠️ THE MARKER GOES ON BOTH ENDS, and the earlier "END only" rule was wrong.
 * It was justified by `shifts`' own CHECK (`start_min < 1440`) — but this
 * function is also applied to BREAKS (`toBreakView`, and the outside-shift
 * message), and `shift_breaks` carries no range check at all: the seed's own
 * night shift has breaks stored at 1440, 1560 and 1680. Marking the end only,
 * `{1440,1455}` and `{0,1455}` — two different, both-storable rows — BOTH
 * rendered "00:00–00:15 +1d", and every after-midnight break read as starting
 * twenty hours before its shift. `minutesToLabel` returns a bare clock for day
 * 0, so no day-shift label changes. Measured 27 Aug.
 *
 * An EN DASH, not a hyphen: this is a range, it is read at a glance, and the
 * hyphen version was indistinguishable from a minus sign beside four digits.
 */
export function describeSpan(span: Span): string {
  return `${minutesToLabel(span.startMin)}–${minutesToLabel(span.endMin)}`;
}

/** `"8h"`, `"7h 30m"`, `"45m"`. Empty or reversed spans get `"—"`. */
export function durationLabel(span: Span): string {
  const total = span.endMin - span.startMin;
  if (!isFiniteInt(total) || total <= 0) return "—";
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/**
 * A bare clock face plus a day offset, back to minutes.
 * `clockToMinutes("01:00", 1)` -> `1500`.
 *
 * Returns `null` — never a guess and never `NaN` — for anything it cannot
 * read, so a half-typed control reads as "no value yet" rather than as
 * midnight. `NaN` was the first version and it silently became `00:00` two
 * conversions later.
 *
 * `"24:00"` is accepted as the end of a day (1440) because that is how people
 * write a shift that finishes at midnight, and `"00:00"` for the same instant
 * would be day 0 and fail `end_min > start_min`. It is the ONLY hour past 23,
 * and only on the exact minute.
 */
export function clockToMinutes(clock: string, days = 0): number | null {
  const m = /^\s*(\d{1,2})\s*:\s*(\d{2})\s*$/.exec(clock);
  if (m === null) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!isFiniteInt(h) || !isFiniteInt(min)) return null;
  if (min > 59) return null;
  if (h > 24) return null;
  if (h === 24 && min !== 0) return null;
  if (!isFiniteInt(days) || days < 0 || days > 1) return null;
  return h * 60 + min + days * MINUTES_PER_DAY;
}

/**
 * The inverse of `minutesToLabel`, tolerant of how a person types it:
 * `"06:00"`, `"6:00"`, `"01:00 +1d"`, `"01:00+1"`, `"24:00"`.
 *
 * Round-trips every value `minutesToLabel` can produce for a legal shift.
 * Returns `null` on anything else.
 */
export function labelToMinutes(label: string): number | null {
  const m = /^\s*(\d{1,2}\s*:\s*\d{2})\s*(?:\+\s*(\d)\s*d?)?\s*$/.exec(label);
  if (m === null) return null;
  const days = m[2] === undefined ? 0 : Number(m[2]);
  return clockToMinutes(m[1], days);
}

/* ===========================================================================
 * OVERLAP — the mirror of `shifts_no_overlap_within_template`
 * =========================================================================== */

/** A saved or drafted shift, as the overlap rules need it. */
export interface ShiftSpan extends Span {
  id: string;
  name: string;
}

/** One colliding pair, `aId` always the earlier-starting of the two. */
export interface ShiftOverlap {
  aId: string;
  bId: string;
}

/**
 * `int4range(a.start, a.end) && int4range(b.start, b.end)`, in JS.
 *
 * Half-open, so `06:00–14:00` and `14:00–22:00` are NEIGHBOURS, not an
 * overlap — `a.end === b.start` is the commonest shape a real pattern has and
 * a closed-interval test would refuse every three-shift day in the world.
 *
 * ⚠️ AN EMPTY RANGE OVERLAPS NOTHING. `int4range(5, 5)` is the empty range and
 * `&&` against it is false for every operand, so a degenerate span is reported
 * here as colliding with nothing at all. Its real problem — `end_min >
 * start_min` — is a CHECK constraint and belongs to `validatePatternDraft`,
 * which names it properly. Reporting it as an overlap as well would put two
 * unrelated sentences on one row.
 */
export function spansOverlap(a: Span, b: Span): boolean {
  if (a.endMin <= a.startMin || b.endMin <= b.startMin) return false;
  return a.startMin < b.endMin && b.startMin < a.endMin;
}

/**
 * Every colliding pair within ONE pattern. The caller must not mix templates:
 * the constraint is scoped `template_id with =`, and two patterns' shifts are
 * allowed to sit on top of each other.
 */
export function overlappingShifts(shifts: readonly ShiftSpan[]): ShiftOverlap[] {
  const ordered = [...shifts].sort((x, y) => x.startMin - y.startMin);
  const out: ShiftOverlap[] = [];
  for (let i = 0; i < ordered.length; i += 1) {
    for (let j = i + 1; j < ordered.length; j += 1) {
      if (spansOverlap(ordered[i], ordered[j])) {
        out.push({ aId: ordered[i].id, bId: ordered[j].id });
      }
    }
  }
  return out;
}

/* ===========================================================================
 * BREAKS — the half of migration 0005 that has no database behind it
 * =========================================================================== */

/** A saved or drafted break. */
export interface BreakSpan extends Span {
  id: string;
  name: string;
}

export type BreakProblemKind =
  /** `end_min > start_min` — the ONE thing the database also refuses. */
  | "empty"
  /** Starts before, or ends after, the shift it belongs to. */
  | "outside-shift"
  /** Shares minutes with another break on the same shift. */
  | "overlaps-break";

export interface BreakProblem {
  breakId: string;
  kind: BreakProblemKind;
  /** The other break, for `"overlaps-break"`; `null` otherwise. */
  otherBreakId: string | null;
  /** Ready to render. Clock times only — see this file's header. */
  message: string;
}

/**
 * Everything wrong with one shift's breaks, in a stable order (by break, then
 * by kind). Never throws; an unreadable number is reported as `"empty"`
 * rather than skipped, because a break the panel cannot describe is still a
 * row somebody has to fix.
 *
 * ⚠️ THE COMPARISON IS AGAINST THE SHIFT'S RAW MINUTES, NOT ITS CLOCK FACE.
 * A break at `1440..1455` on a `1320..1800` shift is inside it; a break at
 * `600..660` is not. Doing this on `%1440` clock values gets both backwards,
 * which is exactly the bug this module was written to make impossible.
 */
export function breakProblems(
  shift: Span,
  breaks: readonly BreakSpan[],
): BreakProblem[] {
  const out: BreakProblem[] = [];
  const shiftLabel = describeSpan(shift);

  for (const b of breaks) {
    const empty = !isFiniteInt(b.startMin) || !isFiniteInt(b.endMin) || b.endMin <= b.startMin;
    if (empty) {
      out.push({
        breakId: b.id,
        kind: "empty",
        otherBreakId: null,
        message: "This break ends before it starts, or lasts no time at all.",
      });
      continue;
    }
    if (b.startMin < shift.startMin || b.endMin > shift.endMin) {
      out.push({
        breakId: b.id,
        kind: "outside-shift",
        otherBreakId: null,
        message: `${describeSpan(b)} falls outside the shift (${shiftLabel}).`,
      });
    }
  }

  const usable = breaks.filter(
    (b) => isFiniteInt(b.startMin) && isFiniteInt(b.endMin) && b.endMin > b.startMin,
  );
  for (let i = 0; i < usable.length; i += 1) {
    for (let j = i + 1; j < usable.length; j += 1) {
      const a = usable[i];
      const b = usable[j];
      if (!spansOverlap(a, b)) continue;
      // Reported on BOTH rows. One break is not more at fault than the other,
      // and a message on only the second is invisible to anyone looking at the
      // first — which is where the person usually is when they created it.
      out.push({
        breakId: a.id,
        kind: "overlaps-break",
        otherBreakId: b.id,
        message: `Overlaps ${b.name.trim() === "" ? "another break" : b.name.trim()}.`,
      });
      out.push({
        breakId: b.id,
        kind: "overlaps-break",
        otherBreakId: a.id,
        message: `Overlaps ${a.name.trim() === "" ? "another break" : a.name.trim()}.`,
      });
    }
  }
  return out;
}

/* ===========================================================================
 * THE DRAFT — what the editor holds before it is saved
 * =========================================================================== */

export interface BreakDraft {
  /** `null` for a break that has never been saved. */
  id: string | null;
  name: string;
  /** `null` while the control is empty or half-typed — never `NaN`. */
  startMin: number | null;
  endMin: number | null;
}

export interface ShiftDraft {
  id: string | null;
  name: string;
  startMin: number | null;
  endMin: number | null;
  breaks: readonly BreakDraft[];
}

export interface PatternDraft {
  id: string | null;
  name: string;
  shifts: readonly ShiftDraft[];
}

export type DraftProblemField =
  | "pattern-name"
  | "shift-name"
  | "shift-time"
  | "shift-overlap"
  | "break-time";

export interface DraftProblem {
  field: DraftProblemField;
  /** Which shift, by index in `draft.shifts`; `null` for a pattern-level problem. */
  shiftIndex: number | null;
  /** Which break, by index in that shift's `breaks`; `null` otherwise. */
  breakIndex: number | null;
  message: string;
}

/**
 * The problems a change WOULD ADD, and only those.
 *
 * Validating the edited pattern on its own reports everything already wrong
 * with it — including rows this person has not touched and may not be able to
 * fix — which reads as "your new shift is invalid" when it is not. Comparing
 * against the same pattern before the change leaves exactly the sentences the
 * change is responsible for.
 *
 * ⚠️ IDENTITY IS (field, shiftIndex, breakIndex), NOT THE MESSAGE, and that
 * distinction is the whole reason this lives here rather than in the panel.
 * The outside-shift sentence EMBEDS the shift's own label, so editing a shift's
 * times rewrites the sentence for a break nobody touched; keyed on the text,
 * the old problem read as a new one and the edit was blocked — permanently,
 * since the panel offers no way to move a break, only to remove it. Measured
 * 27 Aug on a night shift carrying a stray 10:00–11:00 break, which the
 * database allows and `patternRows` deliberately renders flagged. The message
 * is what we SHOW; the coordinates are what make two problems the same
 * problem.
 */
export function problemKey(p: DraftProblem): string {
  return `${p.field}|${p.shiftIndex ?? "-"}|${p.breakIndex ?? "-"}`;
}

export function addedProblems(before: PatternDraft, after: PatternDraft): string[] {
  const was = new Set(validatePatternDraft(before).problems.map(problemKey));
  return validatePatternDraft(after)
    .problems.filter((p) => !was.has(problemKey(p)))
    .map((p) => p.message);
}

export interface DraftValidation {
  ok: boolean;
  /** The name as it would be WRITTEN — trimmed here because nothing trims it later. */
  name: string;
  problems: readonly DraftProblem[];
}

/**
 * Everything that would stop this draft saving, in the order a person reads
 * the form.
 *
 * `existingNames` is EVERY OTHER PATTERN NAME IN THE ORG, not just the site's:
 * `shift_templates` carries `unique (org_id, name)` with no `site_node_id` in
 * it, so two sites cannot both have a pattern called "Standard". That is a
 * genuine surprise on a per-site feature and it is worth saying out loud in
 * the message rather than letting a 23505 arrive as "already uses that name".
 *
 * Comparison is on the TRIMMED strings and is case-SENSITIVE, because the
 * unique index is: "Standard" and "standard" are two rows to Postgres, and
 * refusing the second here would hide something the server permits.
 *
 * ⚠️ NOT A PERMISSION CHECK. Whether this person may write this pattern at
 * all is `app_is_admin_for(site_node_id)` (or company admin) and is decided
 * by the server; a refusal arrives as `{kind:"WriteRefused"}`. This function
 * only knows about shapes and times.
 */
export function validatePatternDraft(
  draft: PatternDraft,
  existingNames: readonly string[] = [],
): DraftValidation {
  const problems: DraftProblem[] = [];
  const name = draft.name.trim();

  if (name === "") {
    problems.push({
      field: "pattern-name",
      shiftIndex: null,
      breakIndex: null,
      message: "Give this shift pattern a name.",
    });
  } else if (existingNames.some((n) => n.trim() === name)) {
    problems.push({
      field: "pattern-name",
      shiftIndex: null,
      breakIndex: null,
      message: "Another shift pattern in this company already uses that name.",
    });
  }

  if (draft.shifts.length === 0) {
    problems.push({
      field: "shift-time",
      shiftIndex: null,
      breakIndex: null,
      message: "Add at least one shift.",
    });
  }

  const spans: ShiftSpan[] = [];
  /** span id -> its index in `draft.shifts`, so an overlap can name its row. */
  const spanIndex = new Map<string, number>();
  draft.shifts.forEach((shift, shiftIndex) => {
    if (shift.name.trim() === "") {
      problems.push({
        field: "shift-name",
        shiftIndex,
        breakIndex: null,
        message: "Give this shift a name.",
      });
    }
    const { startMin, endMin } = shift;
    if (startMin === null || endMin === null) {
      problems.push({
        field: "shift-time",
        shiftIndex,
        breakIndex: null,
        message: "Enter a start and an end time.",
      });
      return;
    }
    if (startMin < 0 || startMin >= MINUTES_PER_DAY) {
      problems.push({
        field: "shift-time",
        shiftIndex,
        breakIndex: null,
        message: "A shift has to start within the day it belongs to.",
      });
      return;
    }
    if (endMin <= startMin) {
      problems.push({
        field: "shift-time",
        shiftIndex,
        breakIndex: null,
        message: "This shift ends before it starts. For a night shift, mark the end as +1 day.",
      });
      return;
    }
    if (endMin - startMin > MAX_SHIFT_MINUTES) {
      problems.push({
        field: "shift-time",
        shiftIndex,
        breakIndex: null,
        message: "A shift can't be longer than 24 hours.",
      });
      return;
    }
    const spanId = shift.id ?? `draft-${shiftIndex}`;
    spanIndex.set(spanId, shiftIndex);
    spans.push({ id: spanId, name: shift.name, startMin, endMin });

    const breakSpans: BreakSpan[] = shift.breaks.map((b, breakIndex) => ({
      id: b.id ?? `draft-${shiftIndex}-${breakIndex}`,
      name: b.name,
      startMin: b.startMin ?? Number.NaN,
      endMin: b.endMin ?? Number.NaN,
    }));
    const byId = new Map(breakSpans.map((b, i) => [b.id, i]));
    for (const p of breakProblems({ startMin, endMin }, breakSpans)) {
      problems.push({
        field: "break-time",
        shiftIndex,
        breakIndex: byId.get(p.breakId) ?? null,
        message: p.message,
      });
    }
  });

  const byShiftId = new Map(spans.map((s) => [s.id, s]));
  for (const pair of overlappingShifts(spans)) {
    const a = byShiftId.get(pair.aId);
    const b = byShiftId.get(pair.bId);
    const aName = a === undefined || a.name.trim() === "" ? "this shift" : a.name.trim();
    const bName = b === undefined || b.name.trim() === "" ? "another shift" : b.name.trim();
    problems.push({
      field: "shift-overlap",
      shiftIndex: spanIndex.get(pair.aId) ?? null,
      breakIndex: null,
      message: `${aName} overlaps ${bName} — two shifts in one pattern can't share minutes.`,
    });
  }

  return { ok: problems.length === 0, name, problems };
}

/* ===========================================================================
 * PATTERN ROWS — the read, assembled, with the unreadable rows counted
 * =========================================================================== */

export interface BreakView extends Span {
  id: string;
  name: string;
  /** `"12:00–12:30"`. */
  span: string;
  duration: string;
}

export interface ShiftView extends Span {
  id: string;
  name: string;
  span: string;
  duration: string;
  /** True when this shift runs past its own midnight — `end_min > 1440`. */
  crossesMidnight: boolean;
  breaks: readonly BreakView[];
  problems: readonly BreakProblem[];
}

export interface PatternView {
  id: string;
  name: string;
  /**
   * The node this pattern belongs to. NOT NULL since 0028 / D108. Who owns it
   * decides who may EDIT it and, since 0028, who may READ it.
   */
  siteNodeId: string;
  /** The owning node's name, or "Another site". Never a raw uuid. */
  ownerLabel: string;
  shifts: readonly ShiftView[];
  /** Pairs already sitting in the database that the constraint would now refuse. */
  overlaps: readonly ShiftOverlap[];
  attachedNodeIds: readonly string[];
  /** Why a delete can be refused — `node_shift_templates` has no `ON DELETE`. */
  attachedCount: number;
}

/** One place, and the pattern attached DIRECTLY to it (not the resolved one). */
export interface NodeAttachmentView {
  nodeId: string;
  nodeName: string;
  path: string;
  depth: number;
  templateId: string | null;
  templateName: string | null;
}

export interface PatternsView {
  patterns: readonly PatternView[];
  nodes: readonly NodeAttachmentView[];
  /**
   * Rows the read carried that could not be used: a guard returned `null`, or
   * a row pointed at a parent that is not in the payload.
   *
   * Reported rather than swallowed, for the reason `siteAccess.ts` gives: a
   * silently shortened list is indistinguishable from a company with fewer
   * shift patterns in it.
   */
  skipped: number;
}

const EMPTY_VIEW: PatternsView = { patterns: [], nodes: [], skipped: 0 };

function toBreakView(row: ShiftBreakRow): BreakView {
  return {
    id: row.id,
    name: row.name,
    startMin: row.startMin,
    endMin: row.endMin,
    span: describeSpan(row),
    duration: durationLabel(row),
  };
}

/**
 * The whole read, turned into what the panel draws. NEVER THROWS.
 *
 * Skip-and-count, not fail: one malformed template must not blank a screen
 * that is somebody's only way to fix it. A shift whose `templateId` names no
 * template, and a break whose `shiftId` names no shift, are counted the same
 * way — under org-wide read policies that should be impossible, which is
 * exactly why it is worth noticing if it ever happens.
 *
 * ⚠️ `ownerLabel` RESOLVES THROUGH `nodes`, AND THAT IS NOT COSMETIC. A uuid
 * on this screen is unreadable, and "which site owns this" is the difference
 * between a pattern this admin may edit and one they may only attach. The two
 * permissions are separate (0023) and the label is how the screen says so.
 */
export function patternRows(payload: ShiftPatternsPayload | null | undefined): PatternsView {
  if (payload === null || payload === undefined) return EMPTY_VIEW;
  let skipped = 0;

  const nodesById = new Map<string, ShiftNodeRow>();
  for (const n of payload.nodes) {
    if (n === null) {
      skipped += 1;
      continue;
    }
    nodesById.set(n.id, n);
  }

  const templates: ShiftTemplateRow[] = [];
  for (const t of payload.templates) {
    if (t === null) {
      skipped += 1;
      continue;
    }
    templates.push(t);
  }
  const templateIds = new Set(templates.map((t) => t.id));

  const shiftsByTemplate = new Map<string, ShiftRow[]>();
  const shiftIds = new Set<string>();
  for (const s of payload.shifts) {
    if (s === null || !templateIds.has(s.templateId)) {
      skipped += 1;
      continue;
    }
    shiftIds.add(s.id);
    const list = shiftsByTemplate.get(s.templateId);
    if (list === undefined) shiftsByTemplate.set(s.templateId, [s]);
    else list.push(s);
  }

  const breaksByShift = new Map<string, ShiftBreakRow[]>();
  for (const b of payload.breaks) {
    if (b === null || !shiftIds.has(b.shiftId)) {
      skipped += 1;
      continue;
    }
    const list = breaksByShift.get(b.shiftId);
    if (list === undefined) breaksByShift.set(b.shiftId, [b]);
    else list.push(b);
  }

  // `node_shift_templates` is keyed on `node_id` alone, so `templateByNode` is
  // total: one pattern per place, never a list.
  const attachedByTemplate = new Map<string, string[]>();
  const templateByNode = new Map<string, string>();
  for (const a of payload.attachments) {
    if (a === null || !templateIds.has(a.templateId)) {
      skipped += 1;
      continue;
    }
    templateByNode.set(a.nodeId, a.templateId);
    const list = attachedByTemplate.get(a.templateId);
    if (list === undefined) attachedByTemplate.set(a.templateId, [a.nodeId]);
    else list.push(a.nodeId);
  }

  const patterns: PatternView[] = templates
    .map((t) => {
      const rows = (shiftsByTemplate.get(t.id) ?? []).slice().sort((a, b) => a.startMin - b.startMin);
      const shifts: ShiftView[] = rows.map((s) => {
        const breaks = (breaksByShift.get(s.id) ?? [])
          .slice()
          .sort((a, b) => a.startMin - b.startMin)
          .map(toBreakView);
        return {
          id: s.id,
          name: s.name,
          startMin: s.startMin,
          endMin: s.endMin,
          span: describeSpan(s),
          duration: durationLabel(s),
          // >=, NOT >. A shift stored `960..1440` is 16:00 until midnight, and
          // `dayOffset(1440)` is already 1 -- `span` prints it "16:00–00:00 +1d".
          // With `>` this same object then said crossesMidnight:false, and that
          // flag is what hands the break form its "+1 day" box. Without the box
          // the only way to reach minute 1440 is the literal "24:00", which an
          // <input type="time"> can never emit -- so the legal wash-up break
          // 23:45–00:00 was UNENTERABLE, refused by our own validator with
          // "ends before it starts". A false "you can't" for a row the DB
          // accepts. Measured 27 Aug.
          crossesMidnight: s.endMin >= MINUTES_PER_DAY,
          breaks,
          problems: breakProblems(s, breaks),
        };
      });
      const owner = nodesById.get(t.siteNodeId);
      const attached = attachedByTemplate.get(t.id) ?? [];
      return {
        id: t.id,
        name: t.name,
        siteNodeId: t.siteNodeId,
        // ⭐ 0028 removed the "Company-wide" arm with the state it named. The
        // "Another site" fallback stays: it should be unreachable now (a
        // pattern you can read is owned on one of your own branches) and it is
        // what the screen says the day that stops being true.
        ownerLabel: owner?.name ?? "Another site",
        shifts,
        overlaps: overlappingShifts(shifts),
        attachedNodeIds: attached,
        attachedCount: attached.length,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const templateNames = new Map(templates.map((t) => [t.id, t.name]));
  const nodes: NodeAttachmentView[] = [...nodesById.values()]
    .map((n) => {
      const templateId = templateByNode.get(n.id) ?? null;
      return {
        nodeId: n.id,
        nodeName: n.name,
        path: n.path,
        depth: n.path === "" ? 0 : n.path.split(".").length - 1,
        templateId,
        templateName: templateId === null ? null : (templateNames.get(templateId) ?? null),
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  return { patterns, nodes, skipped };
}
