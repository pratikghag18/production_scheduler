/**
 * S44-b (brief docs/agent-briefs/s44-b-read-by-model-brief.md §3.1) — the
 * model's JSON answer becomes a `Command`, the exact type `parseCommand`
 * (`src/lib/command/parse.ts`) already produces from a typed sentence. This
 * module is pure and imports nothing but that TYPE: the model's answer is
 * untrusted text off the network, so every field is checked field by field
 * and a fresh object is built — never the parsed input handed back with a
 * cast. `attach` and `existing` are forced to `null` regardless of what the
 * model wrote (the app fills those in later, never the model, per
 * `scripts/voice/train/system_prompt.txt`).
 *
 * F-140's lesson: an invented key, at the top level or inside `day`/`start`/
 * `end`/`span`, is ignored rather than refused — this only ever READS the
 * fields it knows, so an extra key never reaches the returned object.
 */
import type {
  AssignCommand,
  BookCommand,
  ClockTime,
  Command,
  DayWord,
  MoveCommand,
  UnassignCommand,
} from "../command/parse.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

/** S49 (R-397): `place` for a removal or a move may be empty ("wherever the
 *  person is") -- still an array of non-empty strings, just possibly none of
 *  them. `assign`/`book` keep the non-empty check above (a create always
 *  needs a place). */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

/** `null` here always means "invalid" — a `ClockTime` itself has no valid
 *  null state (every intent's `start`/`end` is required). */
function decodeClockTime(value: unknown): ClockTime | null {
  if (!isRecord(value)) return null;
  const { hour, minute } = value;
  if (!isInt(hour) || hour < 0 || hour > 23) return null;
  if (!isInt(minute) || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/** `undefined` means "invalid"; `null` is itself a valid answer ("the day
 *  the board is showing"), so the two must not share a sentinel. */
function decodeDayWord(value: unknown): DayWord | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const kind = value.kind;
  if (kind === "today") return { kind: "today" };
  if (kind === "tomorrow") return { kind: "tomorrow" };
  if (kind === "weekday") {
    const day = value.day;
    if (isInt(day) && day >= 0 && day <= 6) {
      return { kind: "weekday", day: day as 0 | 1 | 2 | 3 | 4 | 5 | 6 };
    }
    return undefined;
  }
  if (kind === "date") {
    return isNonEmptyString(value.iso) ? { kind: "date", iso: value.iso } : undefined;
  }
  return undefined;
}

/** Same `undefined`-means-invalid convention as `decodeDayWord`: `null`
 *  ("the whole day" / "the block's own hours") is a valid answer. */
function decodeSpan(value: unknown): { start: ClockTime; end: ClockTime } | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const start = decodeClockTime(value.start);
  const end = decodeClockTime(value.end);
  if (start === null || end === null) return undefined;
  return { start, end };
}

function decodeHeadcount(value: unknown): number | null | undefined {
  if (value === null) return null;
  return isInt(value) && value > 0 ? value : undefined;
}

function decodeToPlace(value: unknown): string[] | null | undefined {
  if (value === null) return null;
  return isNonEmptyStringArray(value) ? value : undefined;
}

function decodeAssign(obj: Record<string, unknown>): AssignCommand | null {
  if (!isNonEmptyString(obj.operator)) return null;
  if (!isNonEmptyString(obj.product)) return null;
  if (!isNonEmptyStringArray(obj.place)) return null;
  const day = decodeDayWord(obj.day);
  if (day === undefined) return null;
  const start = decodeClockTime(obj.start);
  if (start === null) return null;
  const end = decodeClockTime(obj.end);
  if (end === null) return null;
  return {
    intent: "assign",
    operator: obj.operator,
    product: obj.product,
    place: obj.place,
    day,
    start,
    end,
    attach: null,
    existing: null,
  };
}

function decodeBook(obj: Record<string, unknown>): BookCommand | null {
  if (!isNonEmptyString(obj.product)) return null;
  if (!isNonEmptyStringArray(obj.place)) return null;
  const headcount = decodeHeadcount(obj.headcount);
  if (headcount === undefined) return null;
  const day = decodeDayWord(obj.day);
  if (day === undefined) return null;
  const start = decodeClockTime(obj.start);
  if (start === null) return null;
  const end = decodeClockTime(obj.end);
  if (end === null) return null;
  return {
    intent: "book",
    product: obj.product,
    place: obj.place,
    headcount,
    day,
    start,
    end,
    existing: null,
  };
}

function decodeUnassign(obj: Record<string, unknown>): UnassignCommand | null {
  if (!isNonEmptyString(obj.operator)) return null;
  if (!isStringArray(obj.place)) return null;
  const day = decodeDayWord(obj.day);
  if (day === undefined) return null;
  const span = decodeSpan(obj.span);
  if (span === undefined) return null;
  return {
    intent: "unassign",
    operator: obj.operator,
    place: obj.place,
    day,
    span,
    existing: null,
  };
}

function decodeMove(obj: Record<string, unknown>): MoveCommand | null {
  if (!isNonEmptyString(obj.operator)) return null;
  if (!isStringArray(obj.place)) return null;
  const toPlace = decodeToPlace(obj.toPlace);
  if (toPlace === undefined) return null;
  const day = decodeDayWord(obj.day);
  if (day === undefined) return null;
  const span = decodeSpan(obj.span);
  if (span === undefined) return null;
  // R-389 (parseMoveRest's own `no_move` check, mirrored here): a move must
  // give a new cell or new hours -- naming neither is nothing to move.
  if (toPlace === null && span === null) return null;
  return {
    intent: "move",
    operator: obj.operator,
    place: obj.place,
    toPlace,
    day,
    span,
    existing: null,
  };
}

/** Accepts an object whose `intent` is one of the four and every field of
 *  that intent's interface is present with the right shape; otherwise
 *  `null`. Never throws. */
export function decodeCommand(value: unknown): Command | null {
  if (!isRecord(value)) return null;
  const intent = value.intent;
  if (intent === "assign") return decodeAssign(value);
  if (intent === "book") return decodeBook(value);
  if (intent === "unassign") return decodeUnassign(value);
  if (intent === "move") return decodeMove(value);
  return null;
}
