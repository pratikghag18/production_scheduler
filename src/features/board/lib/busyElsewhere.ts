/**
 * R-465 (S195-D, the maintainer, 30 Sept): a person busy on a place the caller
 * cannot read is still busy, and the caller is told the PLACE and the HOURS --
 * never the product, the job or the block's id:
 *
 *   Priya Shah is already on Cell 4 in Line 2 today from 6 am to 2 pm.
 *
 * `capacity_probe` reports such a block as a row with `outside: true` (its
 * `nodeName`, `parentName` and `timerange` only; `shapes.ts`'s
 * `CapacityProbeOverlap`). This module is the ONE place that row becomes words,
 * and the one place a refusal is asked to explain itself with it, so the create
 * path, the drag and re-time paths, the move and the lot's steps all say the
 * same sentence.
 *
 * Every day and hour in it is in the PLANT'S zone (R-426): the day through
 * `partsInZone`, the label through `formatDayLabel`, today and tomorrow from
 * the plant's own calendar, the hours through the bar's own spoken clock
 * (`formatSpan`, resolve.ts) -- never the machine's zone.
 */
import type { CapacityProbe, CapacityProbeOverlap, SchedulerError } from "@/lib/api";
import { parseTstzRange } from "@/lib/api/serde";
import { isoPlusDays, type DateFormat } from "@/lib/format/dates";
import { partsInZone } from "@/lib/format/timezones";
import { formatSpan } from "@/lib/command/resolve";
import { formatDayLabel } from "./time";

/** The probe rows that sit on a place the caller cannot read. */
export function outsideRows(rows: readonly CapacityProbeOverlap[]): CapacityProbeOverlap[] {
  return rows.filter((r) => r.outside);
}

/**
 * True when the probe says the person does not fit AND at least one block that
 * makes them busy is one the caller cannot read. Such a write is refused in
 * words, never offered the split pop-up: the caller cannot change that block,
 * so the server would refuse the split (R-431).
 */
export function isBusyElsewhere(probe: CapacityProbe): boolean {
  return !probe.fits && probe.overlapping.some((o) => o.outside);
}

function isoOfParts(p: { year: number; month: number; day: number }): string {
  const pad = (n: number, w: number): string => String(n).padStart(w, "0");
  return `${pad(p.year, 4)}-${pad(p.month, 2)}-${pad(p.day, 2)}`;
}

function joinWithAnd(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export interface BusyElsewhereFacts {
  person: string;
  rows: readonly CapacityProbeOverlap[];
  zone: string;
  dateFormat: DateFormat;
  /** The instant "today" is read from, in `zone`. */
  now: Date;
}

/** What a block on a place the caller cannot read carries: the place and the
 *  hours. `CapacityProbeOverlap` (an `outside` row) and `BlockElsewhere` (the
 *  rail's read) both satisfy it. */
export interface ElsewhereBlockFacts {
  nodeName: string;
  parentName: string | null;
  timerange: string;
}

/** The hours of a block in the plant's zone, as the bar says them: "6 am to 2 pm". */
export function elsewhereHours(row: ElsewhereBlockFacts, zone: string): string {
  const { start, end } = parseTstzRange(row.timerange);
  const startParts = partsInZone(start, zone);
  const endParts = partsInZone(end, zone);
  return formatSpan(
    { hour: startParts.hour, minute: startParts.minute },
    { hour: endParts.hour, minute: endParts.minute },
  );
}

/**
 * The rail's brackets for a person busy elsewhere: "(Cell 4, 6 am to 2 pm)",
 * the cell's own name and the hours only (R-465: never the product, the job or
 * the parent). More than one block: the first, then "and 1 more". `rows` are
 * the blocks that matter to the caller, in any order; null when there are none.
 */
export function elsewhereBrackets(
  rows: readonly ElsewhereBlockFacts[],
  zone: string,
): string | null {
  if (rows.length === 0) return null;
  const ordered = [...rows].sort(
    (a, b) =>
      parseTstzRange(a.timerange).start.getTime() - parseTstzRange(b.timerange).start.getTime(),
  );
  const first = `${ordered[0].nodeName}, ${elsewhereHours(ordered[0], zone)}`;
  const more = ordered.length - 1;
  return more === 0 ? `(${first})` : `(${first} and ${more} more)`;
}

/** "<person> is on <block> and <block>." -- the rail chip's hover sentence. */
export function elsewhereTitle(
  person: string,
  rows: readonly ElsewhereBlockFacts[],
  zone: string,
  dateFormat: DateFormat,
  now: Date,
): string | null {
  if (rows.length === 0) return null;
  const todayIso = isoOfParts(partsInZone(now, zone));
  const ordered = [...rows].sort(
    (a, b) =>
      parseTstzRange(a.timerange).start.getTime() - parseTstzRange(b.timerange).start.getTime(),
  );
  const blocks = ordered.map((r) => describeBlock(r, zone, dateFormat, todayIso));
  return `${person} is on ${joinWithAnd(blocks)}.`;
}

/** One outside block as "Cell 4 in Line 2 today from 6 am to 2 pm". */
function describeBlock(
  row: ElsewhereBlockFacts,
  zone: string,
  dateFormat: DateFormat,
  todayIso: string,
): string {
  const { start, end } = parseTstzRange(row.timerange);
  const startParts = partsInZone(start, zone);
  const startDay = isoOfParts(startParts);
  // The end is exclusive: a block that stops at midnight ends ON its own day.
  const lastMoment = partsInZone(new Date(end.getTime() - 1), zone);
  const endsNextDay = isoOfParts(lastMoment) !== startDay;

  const place = row.parentName !== null ? `${row.nodeName} in ${row.parentName}` : row.nodeName;
  const day =
    startDay === todayIso
      ? "today"
      : startDay === isoPlusDays(todayIso, 1)
        ? "tomorrow"
        : startDay === isoPlusDays(todayIso, -1)
          ? "yesterday"
          : formatDayLabel(start, dateFormat, zone);
  const hours = elsewhereHours(row, zone);
  return `${place} ${day} from ${hours}${endsNextDay ? " the next day" : ""}`;
}

/**
 * "<person> is already on <block> and <block>." from a probe's outside rows, in
 * the order they start; null when none of the rows is outside (nothing to say
 * beyond what the caller can already see).
 */
export function busyElsewhereSentence(facts: BusyElsewhereFacts): string | null {
  const rows = outsideRows(facts.rows);
  if (rows.length === 0) return null;
  const todayIso = isoOfParts(partsInZone(facts.now, facts.zone));
  const ordered = [...rows].sort(
    (a, b) =>
      parseTstzRange(a.timerange).start.getTime() - parseTstzRange(b.timerange).start.getTime(),
  );
  const blocks = ordered.map((r) => describeBlock(r, facts.zone, facts.dateFormat, todayIso));
  return `${facts.person} is already on ${joinWithAnd(blocks)}.`;
}

/** What a write was asking for -- the same person, hours and share the probe is asked about. */
export interface CapacityAttempt {
  operatorId: string;
  start: Date;
  end: Date;
  efficiencyPercent: number;
  /** The block being moved or re-timed: it is not "another block" to itself. */
  excludeAssignmentId?: string;
}

export interface ExplainDeps {
  probe: (input: CapacityAttempt) => Promise<CapacityProbe>;
  personName: string;
  zone: string;
  dateFormat: DateFormat;
  now?: () => Date;
}

/**
 * After a `CapacityExceeded` refusal: ask `capacity_probe` the same question
 * and, when a block the caller cannot read is what makes the person busy, hand
 * the refusal back carrying the R-465 sentence (`elsewhere`), which every reader
 * of a capacity refusal then says instead of the numbers. Any other error, a
 * probe that fails, and a probe that finds nothing outside all hand the refusal
 * back unchanged -- today's words stand.
 */
export async function explainCapacityRefusal(
  err: SchedulerError,
  attempt: CapacityAttempt,
  deps: ExplainDeps,
): Promise<SchedulerError> {
  if (err.kind !== "CapacityExceeded") return err;
  let probe: CapacityProbe;
  try {
    probe = await deps.probe(attempt);
  } catch {
    return err;
  }
  const sentence = busyElsewhereSentence({
    person: deps.personName,
    rows: probe.overlapping,
    zone: deps.zone,
    dateFormat: deps.dateFormat,
    now: (deps.now ?? (() => new Date()))(),
  });
  return sentence === null ? err : { ...err, elsewhere: sentence };
}
