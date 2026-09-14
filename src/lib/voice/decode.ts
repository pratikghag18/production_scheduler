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
 *
 * S50 (docs/agent-briefs/s50-b-data-brief.md §2 item 5): a `several` decodes
 * each inner object through the SAME four single-command decoders below —
 * one failure anywhere makes the whole form garbled (never a partial
 * several), fewer than two inner commands is refused (never a one-element
 * several, matching `parse.ts`'s own rule), and a nested `several` inside
 * `commands` is refused (an inner command is always a `SingleCommand`). The
 * model does not emit this shape yet (S50-b's training set does); the
 * decoder accepts it now so the pipeline is ready the day it does.
 *
 * S55 (brief docs/agent-briefs/s55-c-decoder-brief.md §1, design
 * §19.101/D130): `DayWord` gains `yesterday` (decoded anywhere a day word
 * already is) and three WEEK kinds (`this_week`/`next_week`/`last_week`),
 * legal ONLY on a `CopyCommand`'s `from`/`to` — `decodeDayWord` itself never
 * grows a case for them, so a week kind anywhere else (an assign's `day`, an
 * unassign's `until`) falls through to its existing `return undefined` and
 * the whole form is garbled; `decodeDayOrWeekWord`, used only by `decodeCopy`,
 * is the one place that adds them. `UnassignCommand` gains `until: DayWord |
 * null`, now REQUIRED — a missing key is garbled, the same strictness
 * `shift` got at S52-c's VR8. Three new top-level decoders, `replace`/`swap`/
 * `copy`, dispatched only from `decodeCommand` itself, never from
 * `decodeSingle` — D130 item 2's rule that a `several` never holds one of
 * these three holds here for free: `decodeSeveral` calls `decodeSingle` on
 * every inner item, which has no case for these three intents and simply
 * refuses them.
 */
import type {
  AssignCommand,
  BookCommand,
  ClockTime,
  Command,
  CopyCommand,
  DayWord,
  MoveCommand,
  ReplaceCommand,
  SeveralCommand,
  SingleCommand,
  SwapCommand,
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

/** R-402 (S52-a): same `undefined`-means-invalid convention as
 *  `decodeDayWord`/`decodeSpan` -- `null` is now a valid answer for
 *  `start`/`end` (a shift named instead of hours); the cross-check against
 *  `shift` happens in each caller. */
function decodeClockTimeOrNull(value: unknown): ClockTime | null | undefined {
  if (value === null) return null;
  const t = decodeClockTime(value);
  return t === null ? undefined : t;
}

/** R-402 (S52-a): the shift's name, or `null`. A MISSING key (`undefined`,
 *  every fixture and held-out row that predates this field) is read the
 *  same as an explicit `null` -- "no shift" -- so nothing that could decode
 *  before this field existed stops decoding now. */
function decodeShift(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return isNonEmptyString(value) ? value : undefined;
}

/** `undefined` means "invalid"; `null` is itself a valid answer ("the day
 *  the board is showing"), so the two must not share a sentinel. S55: adds
 *  `yesterday`, a day like any other. The three week kinds are deliberately
 *  NOT here — they are legal only on a `CopyCommand`'s `from`/`to`
 *  (`decodeDayOrWeekWord`, below); everywhere else this file uses
 *  `decodeDayWord`, so a week kind simply falls through to `return
 *  undefined` and garbles the form, the same way an unknown `kind` always
 *  has. */
function decodeDayWord(value: unknown): DayWord | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const kind = value.kind;
  if (kind === "today") return { kind: "today" };
  if (kind === "tomorrow") return { kind: "tomorrow" };
  if (kind === "yesterday") return { kind: "yesterday" };
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

/** S55 (D130 item 4): `CopyCommand.from`/`to` are the only fields where a
 *  week kind is legal, and they are REQUIRED, non-null `DayWord`s (unlike
 *  every other day field in this file, `null` is not itself a valid answer
 *  here — there is no "the day the board is showing" reading of a copy's
 *  source or destination). Reuses `decodeDayWord` for the five ordinary
 *  kinds so the two never disagree about what a plain day looks like; the
 *  day-vs-week PAIRING check (`copy_mismatch`/`copy_same`) is the grammar's
 *  own job, not this decoder's (brief §1 note; `form.schema.json` does not
 *  enforce it either) — this only decodes the shape. */
function decodeDayOrWeekWord(value: unknown): DayWord | undefined {
  if (!isRecord(value)) return undefined;
  const kind = value.kind;
  if (kind === "this_week") return { kind: "this_week" };
  if (kind === "next_week") return { kind: "next_week" };
  if (kind === "last_week") return { kind: "last_week" };
  const day = decodeDayWord(value);
  return day === null || day === undefined ? undefined : day;
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
  const shift = decodeShift(obj.shift);
  if (shift === undefined) return null;
  const start = decodeClockTimeOrNull(obj.start);
  if (start === undefined) return null;
  const end = decodeClockTimeOrNull(obj.end);
  if (end === undefined) return null;
  // R-402: refuse a form with both a shift and hours, and refuse
  // start/end null without a shift -- the type's own invariant.
  if (shift !== null && (start !== null || end !== null)) return null;
  if (shift === null && (start === null || end === null)) return null;
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
    shift,
  };
}

function decodeBook(obj: Record<string, unknown>): BookCommand | null {
  if (!isNonEmptyString(obj.product)) return null;
  if (!isNonEmptyStringArray(obj.place)) return null;
  const headcount = decodeHeadcount(obj.headcount);
  if (headcount === undefined) return null;
  const day = decodeDayWord(obj.day);
  if (day === undefined) return null;
  const shift = decodeShift(obj.shift);
  if (shift === undefined) return null;
  const start = decodeClockTimeOrNull(obj.start);
  if (start === undefined) return null;
  const end = decodeClockTimeOrNull(obj.end);
  if (end === undefined) return null;
  if (shift !== null && (start !== null || end !== null)) return null;
  if (shift === null && (start === null || end === null)) return null;
  return {
    intent: "book",
    product: obj.product,
    place: obj.place,
    headcount,
    day,
    start,
    end,
    existing: null,
    shift,
  };
}

function decodeUnassign(obj: Record<string, unknown>): UnassignCommand | null {
  if (!isNonEmptyString(obj.operator)) return null;
  if (!isStringArray(obj.place)) return null;
  const day = decodeDayWord(obj.day);
  if (day === undefined) return null;
  const span = decodeSpan(obj.span);
  if (span === undefined) return null;
  const shift = decodeShift(obj.shift);
  if (shift === undefined) return null;
  // R-402: never both a shift and hours.
  if (shift !== null && span !== null) return null;
  // S55 (R-409): `until` is REQUIRED -- a missing key (`undefined`) fails
  // `decodeDayWord`'s `isRecord` check and garbles the whole form, the same
  // strictness `shift` got at VR8. Plain `decodeDayWord`, not
  // `decodeDayOrWeekWord`: a week kind on `until` is garbled too (the
  // grammar never produces one there -- see `DayWord`'s own doc comment).
  const until = decodeDayWord(obj.until);
  if (until === undefined) return null;
  return {
    intent: "unassign",
    operator: obj.operator,
    place: obj.place,
    day,
    span,
    existing: null,
    shift,
    until,
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
  const shift = decodeShift(obj.shift);
  if (shift === undefined) return null;
  // R-402: never both a shift and hours.
  if (shift !== null && span !== null) return null;
  // R-389 (parseMoveRest's own `no_move` check, mirrored here), widened by
  // R-402: a move must give a new cell, new hours, or a shift -- naming none
  // of the three is nothing to move.
  if (toPlace === null && span === null && shift === null) return null;
  return {
    intent: "move",
    operator: obj.operator,
    place: obj.place,
    toPlace,
    day,
    span,
    existing: null,
    shift,
  };
}

/** S55 (R-406): "cover Sam with Ana on Cell 1 today" -- `place` may be empty
 *  ("wherever the operator is", the same reading `isStringArray` already
 *  gives unassign/move). R-402's shift-or-hours invariant, unchanged:
 *  non-null `shift` implies `span` null. */
function decodeReplace(obj: Record<string, unknown>): ReplaceCommand | null {
  if (!isNonEmptyString(obj.operator)) return null;
  if (!isNonEmptyString(obj.with)) return null;
  if (!isStringArray(obj.place)) return null;
  const day = decodeDayWord(obj.day);
  if (day === undefined) return null;
  const span = decodeSpan(obj.span);
  if (span === undefined) return null;
  const shift = decodeShift(obj.shift);
  if (shift === undefined) return null;
  if (shift !== null && span !== null) return null;
  return {
    intent: "replace",
    operator: obj.operator,
    with: obj.with,
    place: obj.place,
    day,
    span,
    shift,
  };
}

/** S55 (R-406): "swap Sam and Ana on Cell 1 tomorrow" -- same shape as
 *  `decodeReplace` with `other` in place of `with`. */
function decodeSwap(obj: Record<string, unknown>): SwapCommand | null {
  if (!isNonEmptyString(obj.operator)) return null;
  if (!isNonEmptyString(obj.other)) return null;
  if (!isStringArray(obj.place)) return null;
  const day = decodeDayWord(obj.day);
  if (day === undefined) return null;
  const span = decodeSpan(obj.span);
  if (span === undefined) return null;
  const shift = decodeShift(obj.shift);
  if (shift === undefined) return null;
  if (shift !== null && span !== null) return null;
  return {
    intent: "swap",
    operator: obj.operator,
    other: obj.other,
    place: obj.place,
    day,
    span,
    shift,
  };
}

/** S55 (R-408, D130 item 4): "same as yesterday for Cell 1" / "copy Monday
 *  to Tuesday" -- `place` may be empty (every cell the board shows).
 *  `from`/`to` are required, non-null `DayWord`s, decoded through
 *  `decodeDayOrWeekWord` so a week kind is accepted here and nowhere else in
 *  this file. No `copy_mismatch`/`copy_same` cross-check -- that pairing is
 *  the grammar's job, not the decoder's (see `decodeDayOrWeekWord`'s own
 *  comment). */
function decodeCopy(obj: Record<string, unknown>): CopyCommand | null {
  if (!isStringArray(obj.place)) return null;
  const from = decodeDayOrWeekWord(obj.from);
  if (from === undefined) return null;
  const to = decodeDayOrWeekWord(obj.to);
  if (to === undefined) return null;
  return { intent: "copy", place: obj.place, from, to };
}

/** Accepts an object whose `intent` is one of the four single shapes and
 *  every field of that intent's interface is present with the right shape;
 *  otherwise `null`. Never throws. Shared by `decodeCommand` (the top level)
 *  and `decodeSeveral` (each inner command) so the two never disagree about
 *  what a valid single command looks like. S55 (D130 item 2): deliberately
 *  has no case for `replace`/`swap`/`copy` -- those are dispatched only from
 *  `decodeCommand` itself, so a `several` (which decodes every inner item
 *  through this function) can never hold one of them; an inner object with
 *  one of those three intents simply falls through to `return null` below,
 *  same as any other unrecognised intent always has. */
function decodeSingle(obj: Record<string, unknown>): SingleCommand | null {
  const intent = obj.intent;
  if (intent === "assign") return decodeAssign(obj);
  if (intent === "book") return decodeBook(obj);
  if (intent === "unassign") return decodeUnassign(obj);
  if (intent === "move") return decodeMove(obj);
  return null;
}

/** S50: `commands` must be an array of two or three inner objects (matching
 *  `form.schema.json`'s own `minItems`/`maxItems` on the several branch --
 *  the generator and the notebook's `MAX_LEN` token cap both hold a several
 *  to at most three), each a valid `SingleCommand` of its own (never itself
 *  a `several` -- checked before `decodeSingle`, which would otherwise
 *  simply return `null` for an unrecognised `intent` and mask the real
 *  reason). One bad inner command fails the whole form -- a several is
 *  never partially read. */
function decodeSeveral(obj: Record<string, unknown>): SeveralCommand | null {
  if (!Array.isArray(obj.commands)) return null;
  if (obj.commands.length < 2 || obj.commands.length > 3) return null;
  const commands: SingleCommand[] = [];
  for (const item of obj.commands) {
    if (!isRecord(item) || item.intent === "several") return null;
    const decoded = decodeSingle(item);
    if (decoded === null) return null;
    commands.push(decoded);
  }
  return { intent: "several", commands };
}

/** Accepts an object whose `intent` is one of the four single shapes,
 *  `"several"` (S50: an array of two or more of them), or one of S55's three
 *  board-answered intents (`replace`/`swap`/`copy`); otherwise `null`. Never
 *  throws. */
export function decodeCommand(value: unknown): Command | null {
  if (!isRecord(value)) return null;
  if (value.intent === "several") return decodeSeveral(value);
  if (value.intent === "replace") return decodeReplace(value);
  if (value.intent === "swap") return decodeSwap(value);
  if (value.intent === "copy") return decodeCopy(value);
  return decodeSingle(value);
}
