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
 *
 * S58 (brief docs/agent-briefs/s58-c-decoder-brief.md, design section 19.103
 * D132): `MoveCommand` gains `adjust: Adjust | null`, now REQUIRED --
 * `null`, `{edge, by}` (a non-zero integer) or `{edge, at}` (a `ClockTime`);
 * when non-null, `toPlace`, `span` and `shift` must all be null (the same
 * house rule as R-402's shift-vs-hours invariant: never a guess, the decoder
 * refuses the form outright). Two more top-level decoders, `split` and
 * `headcount`, dispatched only from `decodeCommand`, never from
 * `decodeSingle` -- same D130 item 2 reasoning as `replace`/`swap`/`copy`:
 * neither may sit inside a `several`. `DayWord` also gains two REPEAT kinds,
 * `weekdays`/`every_day` (each carrying `week: "this_week" | "next_week"`),
 * legal ONLY on an `assign`'s or a `book`'s own `day` --
 * `decodeDayWordOrRepeat`, used only by those two, is the one place that
 * adds them. Every other `day` field in this file (including `unassign`'s
 * own `until`) stays plain `decodeDayWord`, so a repeat kind there falls
 * through to `return undefined` and garbles the whole form, the same way a
 * week kind already does everywhere but a copy's `from`/`to`.
 *
 * S59 (brief docs/agent-briefs/s59-b-bar-brief.md, F-149): every NAME string
 * the model can write (`operator`, `product`, `with`, `other`, every element
 * of `place`/`toPlace`, and a non-null `shift`) must hold at least one letter
 * or digit (`/\p{L}|\p{N}/u`) -- a string of pure punctuation (`"],"`, the
 * model's own garbled answer that started this) is refused the same way a
 * missing field already is, so the whole form is garbled and the bar falls
 * back to the rules parser, which refuses or reads the sentence cleanly. Day
 * words (`iso` strings), clock times and headcounts are UNCHANGED -- this is
 * a NAME check, not a general string check. `isValidName`/`isNonEmptyNameArray`/
 * `isNameArray` replace the pre-S59 `isNonEmptyString`/`isNonEmptyStringArray`/
 * `isStringArray` everywhere a NAME is being checked (every call site below),
 * one letter/digit check narrower; `isNonEmptyString` itself stays, still
 * used for `decodeDayWord`'s own `iso` field, which is not a name.
 *
 * S60-b (docs/agent-briefs/s60-b-which-part-brief.md, R-422): the maintainer,
 * 15 Sept -- "it can also ask what product if I don't give it one". `product`
 * may now decode as the empty string on `assign`, `book` and `headcount`
 * ONLY (`isValidProductOrEmpty`, used nowhere else) -- "no part was said,
 * the resolver asks which"; F-149's letter-or-digit rule keeps applying the
 * moment the string is non-empty, so a garbled non-empty product is still
 * refused exactly as before. Every other name field is untouched.
 */
import type {
  Adjust,
  AssignCommand,
  BookCommand,
  ClockTime,
  Command,
  CopyCommand,
  DayWord,
  HeadcountCommand,
  MoveCommand,
  ReplaceCommand,
  SeveralCommand,
  SingleCommand,
  SplitCommand,
  SwapCommand,
  UnassignCommand,
} from "../command/parse.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** S59 (F-149): true for any non-empty string that holds at least one letter
 *  or digit, any script (`\p{L}`/`\p{N}`) -- a string of pure punctuation
 *  (`"],"`, `","`) is garbled, never a name. */
function hasLetterOrDigit(value: string): boolean {
  return /\p{L}|\p{N}/u.test(value);
}

/** S59 (F-149): `isNonEmptyString` narrowed to a NAME -- operator, product,
 *  `with`, `other` and a non-null `shift` all go through this instead. */
function isValidName(value: unknown): value is string {
  return isNonEmptyString(value) && hasLetterOrDigit(value);
}

/** S60-b (R-422, brief §2): a product may be the EMPTY string on assign,
 *  book and headcount ONLY -- "no part was said, the resolver asks which".
 *  F-149's letter-or-digit rule keeps applying to a NON-empty product (a
 *  string of pure punctuation is still garbled); every other name field
 *  (`operator`, `with`, `other`, `place`/`toPlace` elements, `shift`) stays
 *  on plain `isValidName`, unchanged. */
function isValidProductOrEmpty(value: unknown): value is string {
  return value === "" || isValidName(value);
}

/** S59 (F-149): a `place`/`toPlace` whose every element is a valid name --
 *  and non-empty (assign/book/headcount's own required `place`, and
 *  `decodeToPlace`'s non-null branch, which a create always needs). */
function isNonEmptyNameArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(isValidName);
}

/** S49 (R-397) + S59 (F-149): `place` for a removal or a move may be empty
 *  ("wherever the person is") -- still an array of names, just possibly none
 *  of them; every element PRESENT must be a valid name. `assign`/`book`/
 *  `headcount` keep the non-empty check above (a create, or an existing run's
 *  own edit, always needs a place). */
function isNameArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isValidName);
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
  // S59 (F-149): a shift's name is a NAME too -- garbled if it holds no
  // letter or digit.
  return isValidName(value) ? value : undefined;
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

/** S58 (R-416, design section 19.103/D132 item 5): the two REPEAT kinds,
 *  legal ONLY on an assign's or a book's own `day` -- used nowhere else in
 *  this file (not `until`, not any other form's `day`, not a copy's own
 *  `from`/`to`). Falls back to plain `decodeDayWord` for the five ordinary
 *  kinds, so the two never disagree about what a plain day looks like; a
 *  bad or missing `week` on a `weekdays`/`every_day` kind is `undefined`,
 *  same as every other malformed shape in this file. */
function decodeDayWordOrRepeat(value: unknown): DayWord | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const kind = value.kind;
  if (kind === "weekdays" || kind === "every_day") {
    const week = value.week;
    if (week === "this_week" || week === "next_week") return { kind, week };
    return undefined;
  }
  return decodeDayWord(value);
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

/** A booking's own `headcount: number | null` -- "not yet the run's fixed
 *  count", never to be confused with `HeadcountCommand.headcount` below,
 *  which is required and range-checked 1-99 (S58, `decodeHeadcountValue`). */
function decodeOptionalHeadcount(value: unknown): number | null | undefined {
  if (value === null) return null;
  return isInt(value) && value > 0 ? value : undefined;
}

/** S58 (R-415, design section 19.103/D132 item 4): `HeadcountCommand`'s own
 *  `headcount` -- REQUIRED, never null, a whole number 1-99 (HC6: 0 people
 *  is refused; HC7: 100 is refused -- the grammar's own bound, mirrored here
 *  so the decoder never accepts a count the sentence grammar could not have
 *  produced). */
function decodeHeadcountValue(value: unknown): number | undefined {
  return isInt(value) && value >= 1 && value <= 99 ? value : undefined;
}

function decodeToPlace(value: unknown): string[] | null | undefined {
  if (value === null) return null;
  // S59 (F-149): every element must be a valid name.
  return isNonEmptyNameArray(value) ? value : undefined;
}

function decodeAssign(obj: Record<string, unknown>): AssignCommand | null {
  if (!isValidName(obj.operator)) return null;
  // S60-b (R-422): the product may be "" -- no part named at all.
  if (!isValidProductOrEmpty(obj.product)) return null;
  if (!isNonEmptyNameArray(obj.place)) return null;
  // S58 (R-416): assign's own `day` accepts the two REPEAT kinds too.
  const day = decodeDayWordOrRepeat(obj.day);
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
  // S60-b (R-422): the product may be "" -- no part named at all.
  if (!isValidProductOrEmpty(obj.product)) return null;
  if (!isNonEmptyNameArray(obj.place)) return null;
  const headcount = decodeOptionalHeadcount(obj.headcount);
  if (headcount === undefined) return null;
  // S58 (R-416): book's own `day` accepts the two REPEAT kinds too.
  const day = decodeDayWordOrRepeat(obj.day);
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
  if (!isValidName(obj.operator)) return null;
  if (!isNameArray(obj.place)) return null;
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
  // `decodeDayOrWeekWord` and not `decodeDayWordOrRepeat`: a week kind or an
  // S58 repeat kind on `until` is garbled too (the grammar never produces
  // either there -- see `DayWord`'s own doc comment).
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

/** S58 (R-412, design section 19.103/D132 item 1): a re-time by one edge --
 *  `null`, `{edge, by}` (a non-zero signed integer of minutes) or `{edge,
 *  at}` (a `ClockTime`); never both keys, never neither -- the union has no
 *  third member and this decoder does not invent one. `by === 0` is refused
 *  (AJ5: "extend Sam's block by 0 minutes" is `bad_adjust`, never a
 *  no-op). */
function decodeAdjust(value: unknown): Adjust | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const edge = value.edge;
  if (edge !== "start" && edge !== "end") return undefined;
  const hasBy = value.by !== undefined;
  const hasAt = value.at !== undefined;
  if (hasBy === hasAt) return undefined; // never both, never neither
  if (hasBy) {
    const by = value.by;
    if (!isInt(by) || by === 0) return undefined;
    return { edge, by };
  }
  const at = decodeClockTime(value.at);
  if (at === null) return undefined;
  return { edge, at };
}

function decodeMove(obj: Record<string, unknown>): MoveCommand | null {
  if (!isValidName(obj.operator)) return null;
  if (!isNameArray(obj.place)) return null;
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
  // S58 (R-412): `adjust` is REQUIRED -- a missing key garbles the form, the
  // same strictness `shift`/`until` already have. Non-null implies
  // `toPlace`, `span` and `shift` are all null (AJ16: "move Sam's start to 9
  // to Cell 2" is `bad_adjust`-class -- an adjust never carries a
  // destination, new hours or a shift alongside it).
  const adjust = decodeAdjust(obj.adjust);
  if (adjust === undefined) return null;
  if (adjust !== null && (toPlace !== null || span !== null || shift !== null)) return null;
  // R-389 (parseMoveRest's own `no_move` check, mirrored here), widened by
  // R-402 and S58: a move must give a new cell, new hours, a shift, or an
  // adjust -- naming none of the four is nothing to move.
  if (toPlace === null && span === null && shift === null && adjust === null) return null;
  return {
    intent: "move",
    operator: obj.operator,
    place: obj.place,
    toPlace,
    day,
    span,
    existing: null,
    shift,
    adjust,
  };
}

/** S55 (R-406): "cover Sam with Ana on Cell 1 today" -- `place` may be empty
 *  ("wherever the operator is", the same reading `isNameArray` already
 *  gives unassign/move). R-402's shift-or-hours invariant, unchanged:
 *  non-null `shift` implies `span` null. */
function decodeReplace(obj: Record<string, unknown>): ReplaceCommand | null {
  if (!isValidName(obj.operator)) return null;
  if (!isValidName(obj.with)) return null;
  if (!isNameArray(obj.place)) return null;
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
  if (!isValidName(obj.operator)) return null;
  if (!isValidName(obj.other)) return null;
  if (!isNameArray(obj.place)) return null;
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
  if (!isNameArray(obj.place)) return null;
  const from = decodeDayOrWeekWord(obj.from);
  if (from === undefined) return null;
  const to = decodeDayOrWeekWord(obj.to);
  if (to === undefined) return null;
  return { intent: "copy", place: obj.place, from, to };
}

/** S58 (R-413, design section 19.103/D132 item 2): "split Sam's block at
 *  noon" -- board-answered like `replace`/`swap`/`copy` above, never part of
 *  a `several`. `place` may be empty ("wherever the operator is", the same
 *  reading `isNameArray` already gives move/unassign); `at` is REQUIRED
 *  and never null -- unlike every other clock-time-bearing field in this
 *  file, `SplitCommand` has no "the block's own hours" reading. Plain
 *  `decodeDayWord`, not `decodeDayWordOrRepeat`: a repeat kind on a split's
 *  `day` is garbled too (only assign/book's own `day` admits one). */
function decodeSplit(obj: Record<string, unknown>): SplitCommand | null {
  if (!isValidName(obj.operator)) return null;
  if (!isNameArray(obj.place)) return null;
  const day = decodeDayWord(obj.day);
  if (day === undefined) return null;
  const at = decodeClockTime(obj.at);
  if (at === null) return null;
  return { intent: "split", operator: obj.operator, place: obj.place, day, at };
}

/** S58 (R-415, design section 19.103/D132 item 4): "make the Housing A job
 *  on Cell 1 4 people" -- board-answered like `replace`/`swap`/`copy`/
 *  `split` above, never part of a `several` (there is nothing here for the
 *  board's own lot machinery to expand). `place` is non-empty (a headcount
 *  always names the run's own cell, same as an assign or a booking); `span`/
 *  `shift` follow R-402's own invariant (at most one non-null -- naming
 *  neither is fine here, unlike assign/book, since a headcount edits an
 *  EXISTING run rather than creating hours); `headcount` is REQUIRED, 1-99
 *  (`decodeHeadcountValue`, above). */
function decodeHeadcountCommand(obj: Record<string, unknown>): HeadcountCommand | null {
  // S60-b (R-422): the product may be "" -- no part named at all.
  if (!isValidProductOrEmpty(obj.product)) return null;
  if (!isNonEmptyNameArray(obj.place)) return null;
  const day = decodeDayWord(obj.day);
  if (day === undefined) return null;
  const span = decodeSpan(obj.span);
  if (span === undefined) return null;
  const shift = decodeShift(obj.shift);
  if (shift === undefined) return null;
  if (shift !== null && span !== null) return null;
  const headcount = decodeHeadcountValue(obj.headcount);
  if (headcount === undefined) return null;
  return {
    intent: "headcount",
    product: obj.product,
    place: obj.place,
    day,
    span,
    shift,
    headcount,
  };
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
 *  `"several"` (S50: an array of two or more of them), one of S55's three
 *  board-answered intents (`replace`/`swap`/`copy`), or one of S58's two more
 *  (`split`/`headcount`); otherwise `null`. Never throws. */
export function decodeCommand(value: unknown): Command | null {
  if (!isRecord(value)) return null;
  if (value.intent === "several") return decodeSeveral(value);
  if (value.intent === "replace") return decodeReplace(value);
  if (value.intent === "swap") return decodeSwap(value);
  if (value.intent === "copy") return decodeCopy(value);
  if (value.intent === "split") return decodeSplit(value);
  if (value.intent === "headcount") return decodeHeadcountCommand(value);
  return decodeSingle(value);
}
