/**
 * P1-7a — the typed command bar, half one: a sentence becomes a FORM.
 *
 * ⚠️ THIS MODULE IMPORTS NOTHING. Not React, not the api layer, not the board.
 * `node --experimental-strip-types` must be able to run it, and the small local
 * model that comes later (docs/voice-commands-plan.md, Stage 4) replaces THIS
 * file and nothing else: it must produce the same `AssignCommand` and hand it
 * to the same `resolve.ts`. Keeping the form here, dependency-free, is what
 * makes that swap a one-file change.
 *
 * The bar's whole job ends when the resolved form opens the existing create
 * pop-up pre-filled. Nothing in `src/lib/command/` may write to the database
 * or hold a copy of a rule the server, `scope.ts` or the pop-up already holds
 * (brief §2, "no second door"; `src/test/commandPurity.test.ts` fails the build
 * on a runtime import here).
 *
 * S41-a (docs/agent-briefs/s41-a-book-a-job-brief.md) adds a second intent,
 * `book`: "Book Housing A on Cell 1 in Line 1 from 6 to 2" — a JOB, never a
 * person. The intent is decided by the FIRST WORD (`book`/`run` -> book;
 * anything else, or no verb at all, -> assign, exactly as before this
 * stage). The time-clause and day-word steps are shared by both intents
 * through private helpers (`parseTimeAndDay`) so the assign grammar's own
 * P1–P24 keep their meaning unchanged.
 *
 * S50 (docs/agent-briefs/s50-a-grammar-brief.md, R-398, design §19.97/D126)
 * widens the grammar twice more, both times WITHOUT a new intent word:
 * (1) a removal or a move need no longer name a place at all -- an empty
 * `place: []` reads as "wherever the person is" (S49 already resolves it
 * that way); an assign or a booking still need one, and a move still needs
 * a new cell or new hours (`no_move`). (2) the OPERATOR segment (assign,
 * unassign, move) or the FIRST PLACE segment (assign, book) may list more
 * than one name or cell, joined by " and " (an operator list also accepts
 * ", " before a final " and "), and the sentence becomes a fifth `Command`
 * member, `several` -- one complete `SingleCommand` per item, in the
 * sentence's order, every other field copied onto each. A quoted "and" is
 * one name (the sentinel makes it atomic, same as every other keyword).
 *
 * S52-a (docs/agent-briefs/s52-a-shift-grammar-brief.md, R-401/R-402, design
 * §19.99/D128) widens the grammar twice more, again without a new intent
 * word: (1) "change" and "shift" join `MOVE_VERBS`, and a possessive timing
 * tail on the move grammar's operator segment ("A3's timing", "Sam's
 * hours") reads as the person. (2) every single command gains `shift:
 * string | null` -- a name that stands in for the hours, read anywhere
 * after the person as `for shift 2` / `during shift 3` (the NAMED form: only
 * "for"/"during" are its own preposition -- "on"/"in" are PLACE
 * prepositions, and a place is what follows them, so "on Shift Bay 2" stays
 * a place) or `for the night shift` / `on the morning shift` (the
 * TRAILING-WORD form, unambiguous, so it keeps "on" too). `shift` and hours
 * together is `shift_and_hours`, never a guess which wins.
 */

/** A clock time on the board's own clock, 24h. The plant's zone is the
 *  resolver's concern (`ResolveContext.wallToOffset`), never this module's. */
export interface ClockTime {
  hour: number; // 0–23
  minute: number; // 0–59
}

/**
 * Which day, as the person said it. `null` = "the day the board is showing".
 *
 * S55 (docs/agent-briefs/s55-a-grammar-brief.md, R-404/R-408, design
 * §19.101/D130) adds `yesterday` -- a day like any other, read anywhere a
 * `today`/`tomorrow` already is -- and three WEEK kinds, legal ONLY on a
 * `CopyCommand`'s `from`/`to`: on every other form (assign, book, unassign,
 * move, replace, swap) the grammar never produces one.
 *
 * S58 (docs/agent-briefs/s58-a-grammar-brief.md, R-416, design §19.103/D132
 * item 5) adds two REPEAT kinds -- "every weekday"/"weekdays" (`weekdays`)
 * and "every day" (`every_day`), each carrying which week ("this week" said
 * or implied, or "next week"). Produced ONLY on an assign or a booking
 * (`parseCommand`'s own `extractRepeatDayClause`/`applyRepeatDay`, stripped
 * from the sentence before any verb dispatch runs and reattached to the
 * finished command only when its intent allows it); on every other intent a
 * repeat phrase is `bad_day` -- the resolver has no lot machinery here (D130
 * built that for the BOARD's own expansion, not the grammar's).
 */
export type DayWord =
  | { kind: "today" }
  | { kind: "tomorrow" }
  | { kind: "yesterday" }
  | { kind: "weekday"; day: 0 | 1 | 2 | 3 | 4 | 5 | 6 } // 0 = Sunday
  | { kind: "date"; iso: string } // "2026-09-04"
  | { kind: "this_week" }
  | { kind: "next_week" }
  | { kind: "last_week" }
  | { kind: "weekdays"; week: "this_week" | "next_week" }
  | { kind: "every_day"; week: "this_week" | "next_week" };

/**
 * R-383 (the maintainer, 11 Sept): when the span lands inside a job already
 * booked for that part on that cell, the bar ASKS — join the job, or make a
 * separate block. The answer travels here. `null` = not asked yet (every fresh
 * parse). `formatCommand` never prints it; the bar carries it across the re-run
 * after the button press, the way it carries a chosen candidate.
 */
export type Attach = { kind: "run"; runId: string } | { kind: "direct" };

/**
 * R-385 (the maintainer, 11 Sept, session 142): when the sentence names a person, part
 * and cell the person is already on, with overlapping hours, the bar ASKS — change that
 * block's hours, or add a separate block. The answer travels here. `null` = not asked
 * yet (every fresh parse). `formatCommand` never prints it.
 *
 * S58-e (R-413, docs/agent-briefs/s58-e-split-separate-brief.md): `separate_from` is
 * `expandSplit`'s own answer for the second half of a split -- "add a separate block,
 * and the block with this id is the one I already know about (the one being cut)".
 * `resolveAssignCommand`'s own-block step treats it like `null` EXCEPT that the named
 * block is removed from the overlap check first, so a genuine second overlapping block
 * still asks `block_exists` (naming that other block), while the block being split out
 * of never trips the question against itself.
 */
export type Existing =
  | { kind: "retime"; assignmentId: string }
  | { kind: "separate" }
  | { kind: "separate_from"; assignmentId: string };

export interface AssignCommand {
  intent: "assign";
  /** The words the person used, trimmed, original case. NEVER an id. */
  operator: string;
  product: string;
  /** Place words, most specific first: "Cell 1 in Line 1" -> ["Cell 1", "Line 1"]. At least one. */
  place: string[];
  day: DayWord | null;
  /** R-402: the invariant is `shift === null` implies both non-null, and
   *  `shift !== null` implies both null -- a shift clause stands in for the
   *  hours, never alongside them (`shift_and_hours`). */
  start: ClockTime | null;
  end: ClockTime | null;
  attach: Attach | null;
  existing: Existing | null;
  /** R-402 (the maintainer, 13 Sept, session 163): the shift's name as said
   *  ("2", "B", "night", "Late Turn"), or `null` when the sentence gave hours
   *  instead. `resolve.ts` turns it into that cell's own band for the day. */
  shift: string | null;
}

/**
 * S41-b (docs/agent-briefs/s41-b-unassign-brief.md §3): "Unassign Sam from
 * Cell 1 in Line 1 from 10 to 2" -- removes an existing block, the same
 * removal the block's own Delete button does. `span: null` means the whole
 * day: every block of that person's on that cell that day.
 */
export interface UnassignCommand {
  intent: "unassign";
  /** The words the person used, trimmed, original case. NEVER an id. */
  operator: string;
  /** Place words, most specific first — same shape as `AssignCommand.place`.
   *  At least one for an assign or a booking; may be empty for a removal or
   *  a move: wherever the person is (S49, R-397). */
  place: string[];
  day: DayWord | null;
  /** null when the sentence gave no hours: the whole day. */
  span: { start: ClockTime; end: ClockTime } | null;
  /** The pressed button's answer; null until asked. */
  existing: { kind: "remove"; assignmentId: string } | null;
  /** R-402: a shift clause instead of hours -- non-null here implies `span`
   *  is null (the removal still means "the whole day", the shift's name is
   *  not yet resolved into a band). */
  shift: string | null;
  /** R-409 (S55): "off till Friday" / "on leave until Wednesday" -- `null`
   *  on every removal that is not an absence carrying its own `until`. A
   *  week kind (`this_week`/`next_week`/`last_week`) never appears here --
   *  those are legal only on a `CopyCommand`'s `from`/`to` (see `DayWord`). */
  until: DayWord | null;
}

/**
 * S41-a — "book a job": the sentence names a PART, a CELL and a SPAN, never a
 * person (brief docs/agent-briefs/s41-a-book-a-job-brief.md §3).
 */
export interface BookCommand {
  intent: "book";
  /** The words the person used, trimmed, original case. NEVER an id. */
  product: string;
  /** Place words, most specific first — same shape as `AssignCommand.place`. At least one. */
  place: string[];
  /** "for 3" / "for 3 people" — null when the sentence did not say. */
  headcount: number | null;
  day: DayWord | null;
  /** R-402: same invariant as `AssignCommand.start`/`end` -- non-null exactly
   *  when `shift` is null. */
  start: ClockTime | null;
  end: ClockTime | null;
  /** R-387: the answer to "change that job's hours?" — null until asked. */
  existing: { kind: "retime"; runId: string } | null;
  /** R-402: the shift's name in place of hours, or null. */
  shift: string | null;
}

/**
 * S58 (docs/agent-briefs/s58-a-grammar-brief.md, R-412, design §19.103/D132
 * item 1): a re-time by ONE edge -- "extend Sam's block by an hour", "end
 * Sam early at 3", "move Sam's start to 9". `by` is signed minutes (+60 = an
 * hour later); `at` is a new clock time for that edge, read through the same
 * workday rule a lone edge always gets (`applyLoneEdgeRule`: an hour under 7
 * with no explicit meridiem reads as pm). Never both, never neither -- the
 * union has no third member on purpose.
 */
export type Adjust =
  { edge: "start" | "end"; by: number } | { edge: "start" | "end"; at: ClockTime };

/**
 * S41-c (docs/agent-briefs/s41-c-move-brief.md §3): "Move Sam on Cell 1 to
 * Cell 2 in Line 1" moves an EXISTING block to another cell and/or other
 * hours -- never a create. `toPlace: null` means a move in time only (R-385's
 * `retime` target); `span: null` means the block keeps its own hours. At
 * least one of the two must be present (parseCommand's own check) -- a
 * sentence naming neither is `no_move`.
 */
export interface MoveCommand {
  intent: "move";
  /** The words the person used, trimmed, original case. NEVER an id. */
  operator: string;
  /** WHERE the block is now, most specific first. At least one for an
   *  assign or a booking; may be empty for a removal or a move: wherever
   *  the person is (S49, R-397). */
  place: string[];
  /** The new cell, most specific first -- or null for a move in time only. */
  toPlace: string[] | null;
  day: DayWord | null;
  /** The new hours, or null to keep the block's own. */
  span: { start: ClockTime; end: ClockTime } | null;
  /** Which block, when several match; null until asked. */
  existing: { kind: "move"; assignmentId: string } | null;
  /** R-402: a shift clause instead of new hours -- non-null here implies
   *  `span` is null. `toPlace === null && span === null` is only ever
   *  `no_move` when `shift` is ALSO null: a shift with no destination cell is
   *  a move in time (R-389's "new hours" satisfied by the shift's name). */
  shift: string | null;
  /** S58 (R-412): a re-time by one edge -- non-null implies `span`, `shift`
   *  and `toPlace` are all null (the block is the move's own, "wherever the
   *  person is", never a destination -- AJ16: "move Sam's start to 9 to Cell
   *  2" is `bad_adjust`, an adjust never carries one). */
  adjust: Adjust | null;
}

/** The four intents that name a single block/job/removal/move -- what
 *  `Command` was, in full, before S50. `SeveralCommand.commands` is typed on
 *  this narrower union: a several's inner forms are never themselves several. */
export type SingleCommand = AssignCommand | BookCommand | UnassignCommand | MoveCommand;

/**
 * S50 (brief §2 item 3, R-398): "assign A2 and A3 to Housing A on Cell 1 and
 * Cell 2 in Line 1 today from 3 to 5" -- the OPERATOR segment or the FIRST
 * PLACE segment (or both, paired in order) named more than one thing.
 * `commands` are complete forms, `attach`/`existing` included, in the
 * sentence's order; every other field of the sentence (product, qualifiers
 * after the first place, day, hours/span, toPlace, headcount) is copied onto
 * every one of them. `formatCommand` prints a several as its commands' own
 * `formatCommand`s joined by `"; "` -- a `;` is not grammar, so parsing that
 * string back need not reproduce this same several (the round trip is
 * per-inner-command instead). Never emitted by `decode.ts` yet (S50's data
 * brief is the next lane); `resolveCommand`'s only answer to one today is
 * the `several_unsupported` question -- resolving and confirming each inner
 * command is its own later stage.
 */
export interface SeveralCommand {
  intent: "several";
  commands: SingleCommand[];
}

/**
 * S55 (brief §1, R-406/R-408, design §19.101/D130): three board-answered
 * intents -- "cover Sam with Ana" (`replace`), "swap Sam and Ana" (`swap`),
 * "same as yesterday for Cell 1" / "copy Monday to Tuesday" (`copy`) -- whose
 * fields are only the words said. None of the three ever appears inside a
 * `SeveralCommand` (D130 item 2: a `several` never holds one of these; the
 * model says two or three plain commands, or one of these -- the BOARD makes
 * the many, via `resolve.ts`'s `expandCommand`, not the grammar).
 */
export interface ReplaceCommand {
  intent: "replace";
  /** The person being covered/replaced. */
  operator: string;
  /** The person covering/replacing them. */
  with: string;
  /** Place words, most specific first. `[]` means wherever the operator is. */
  place: string[];
  day: DayWord | null;
  span: { start: ClockTime; end: ClockTime } | null;
  /** R-402's same invariant, amended for R-406: non-null implies `span` null. */
  shift: string | null;
}

export interface SwapCommand {
  intent: "swap";
  operator: string;
  /** The person swapping with the operator. */
  other: string;
  place: string[];
  day: DayWord | null;
  span: { start: ClockTime; end: ClockTime } | null;
  shift: string | null;
}

/**
 * D130 item 4: a day copies to a day, a week to a week -- `from`/`to` are
 * never mixed kinds (`copy_mismatch`) and never the same day (`copy_same`).
 * `place: []` means every cell the board shows.
 */
export interface CopyCommand {
  intent: "copy";
  place: string[];
  from: DayWord;
  to: DayWord;
}

/**
 * S58 (docs/agent-briefs/s58-a-grammar-brief.md, R-413, design §19.103/D132
 * item 2): "split Sam's block at noon" -- a shorten plus an assign, but the
 * GRAMMAR only ever needs the four fields below; `resolve.ts`'s own
 * `expandCommand` (D130's board-answered machinery) writes the two inner
 * commands. Board-answered like `ReplaceCommand`/`SwapCommand`/`CopyCommand`:
 * never appears inside a `SeveralCommand`.
 */
export interface SplitCommand {
  intent: "split";
  operator: string;
  place: string[];
  day: DayWord | null;
  at: ClockTime;
}

/** The four board-answered intents -- D130 item 2's own name for the group,
 *  widened by S58's `SplitCommand` (R-413). */
export type BoardCommand = ReplaceCommand | SwapCommand | CopyCommand | SplitCommand;

/**
 * S58 (R-415, design §19.103/D132 item 4): "make the Housing A job on Cell 1
 * 4 people" -- one existing write, the run's own planned headcount, never a
 * create. `shift`/`span` name WHICH run when the day carries more than one
 * (R-402's invariant: at most one of the two is non-null). Never part of a
 * `SeveralCommand` (D132: "never part of a lot" -- there is nothing here for
 * the board's own lot machinery to expand).
 */
export interface HeadcountCommand {
  intent: "headcount";
  product: string;
  place: string[];
  day: DayWord | null;
  span: { start: ClockTime; end: ClockTime } | null;
  shift: string | null;
  headcount: number;
}

export type Command =
  | AssignCommand
  | BookCommand
  | UnassignCommand
  | MoveCommand
  | SeveralCommand
  | BoardCommand
  | HeadcountCommand;

export type ParseFailure =
  | { kind: "empty" }
  | { kind: "no_time" } // no "from <time> to <time>" clause at the end
  | { kind: "bad_time"; text: string }
  | { kind: "time_order" } // end not after start even after the afternoon rule
  | { kind: "no_product" } // operator given, nothing after it
  | { kind: "no_place" } // operator and product given, no place
  | { kind: "bad_day"; text: string }
  /** F-133: a day word BEFORE the hours and one AFTER them that disagree --
   *  never a pick (CLAUDE.md §4), `first` is the one said first. */
  | { kind: "two_days"; first: string; second: string }
  /** S41-a: a `for` clause whose number is not a whole number 1–99. */
  | { kind: "bad_headcount"; text: string }
  /** S41-c: neither a new cell nor new hours were said -- nothing to move. */
  | { kind: "no_move" }
  /** S50: an operator or first-place LIST segment is malformed -- a leading
   *  or trailing "and", or an empty item between two separators. */
  | { kind: "bad_list"; text: string }
  /** S50: the operator segment and the first place segment both listed more
   *  than one item, and the two counts disagree -- never a guess (R-379). */
  | { kind: "list_mismatch"; people: number; places: number }
  /** R-402: the sentence named BOTH a shift and hours -- never a guess which
   *  one wins. */
  | { kind: "shift_and_hours" }
  /** R-404 (S55): a duration clause ("for 4 hours") whose unit is not a
   *  recognised length, or whose arithmetic runs past midnight (never
   *  clipped -- CLAUDE.md §4). */
  | { kind: "bad_duration"; text: string }
  /** R-404 (S55): "after 2" on an assign or a booking (or any other single
   *  open-ended edge) -- those grammars need both ends said. */
  | { kind: "open_span"; text: string }
  /** R-408 (S55): a `CopyCommand`'s `from`/`to` named a day and a week, or
   *  the reverse -- never a guess which kind was meant. */
  | { kind: "copy_mismatch"; from: string; to: string }
  /** R-408 (S55): `from` and `to` named the same day (or week) -- a copy
   *  that would do nothing. */
  | { kind: "copy_same" }
  /** R-412 (S58): an adjust clause said no distance and no time at all, said
   *  a distance of zero, or (AJ16) tried to carry a destination -- an adjust
   *  never guesses which edge or by how much. */
  | { kind: "bad_adjust"; text: string }
  /** R-415 (S58): "make it 4 people" -- the bar keeps no memory of the last
   *  thing it did, so there is nothing "it" can name; the grammar asks for
   *  the job's own name rather than guess. */
  | { kind: "which_job" }
  /** R-413 (S58): "split Sam" -- a split with no "at <time>" clause at all. */
  | { kind: "no_split_time" };

export type ParseResult = { ok: true; command: Command } | { ok: false; failure: ParseFailure };

// ---------------------------------------------------------------------------
// Private helpers. None of these are exported; the model that later replaces
// this file owes nothing to their shape.
// ---------------------------------------------------------------------------

/** Private-use placeholders for quoted segments, so whitespace collapsing and
 *  keyword splitting never look inside a quoted name (brief §4, P17). */
const QUOTE_OPEN = "";
const QUOTE_CLOSE = "";

/**
 * R-391 (the maintainer, 12 Sept): the optional verb each sentence accepts,
 * one list per sentence, every verb in exactly one list so the first word
 * never needs a guess. `scripts/voice/lib/templates.mjs` draws its templates'
 * verbs from these same exports rather than hard-coding them (this file is
 * the one door).
 *
 * R-401 (the maintainer, 13 Sept, session 163): the exclusion of "shift" and
 * "change" below is WITHDRAWN -- both now join `MOVE_VERBS`. "shift" reads
 * as a noun everywhere else in this app (a shift chip, a shift pattern,
 * R-402's own shift clause), but the first-word rule already keeps a shift
 * clause or any other mid-sentence use of the word out of the verb's way --
 * only the FIRST word of the sentence is ever tried against a verb list.
 *
 * R-415 (S58, brief §3 HC9): "set" is the one documented EXCEPTION to "every
 * verb in exactly one list" -- it stays in `ASSIGN_VERBS` below (unchanged)
 * AND is exported again in `HEADCOUNT_VERBS` (the data lane's own template
 * verb for a headcount sentence). The developer's decision (brief §3, "choose,
 * say which"): the HEADCOUNT dispatch is tried FIRST, at the very top of
 * `parseCommand`, and claims a "make"/"set" sentence only when it structurally
 * matches "the <product> job/run ... <n> people"; anything else -- HC9: "set
 * Sam on Housing A on Cell 1 8 to 4" -- makes `parseHeadcountRest` return
 * `null`, and dispatch falls all the way through to the ordinary assign
 * pipeline below, which still finds "set" in `ASSIGN_VERBS` exactly as it
 * always did. No "second look" plumbing was needed because "set" was never
 * actually removed -- the two readings simply never overlap in shape (one
 * needs "the ... job/run", the other never has it).
 */
export const ASSIGN_VERBS = [
  "assign",
  "put",
  "schedule",
  "add",
  "staff",
  "place",
  "allocate",
  "give",
  "set",
] as const;

/** S41-a, widened by R-391. "schedule" stays with assign (above), on
 *  purpose -- it is never a book verb. */
export const BOOK_VERBS = ["book", "run", "plan", "open", "start", "launch", "create"] as const;

/** S41-b, widened by R-391; gains "take" at R-405 (S55). "take Sam to Cell 2"
 *  therefore reads as a removal, not a move, and fails on its place words --
 *  R-391's rule ("every verb in exactly one list") holds, and that reading is
 *  the price of it (brief §1); said so at the SH-equivalent case below. */
export const UNASSIGN_VERBS = [
  "unassign",
  "remove",
  "clear",
  "drop",
  "cancel",
  "delete",
  "pull",
  "free",
  "take",
] as const;

/** S41-c, widened by R-391; gains "change" and "shift" at R-401 (the
 *  maintainer, 13 Sept, session 163 -- see the comment above `ASSIGN_VERBS`). */
export const MOVE_VERBS = [
  "move",
  "reschedule",
  "transfer",
  "relocate",
  "switch",
  "change",
  "shift",
] as const;

/**
 * S58 (docs/agent-briefs/s58-a-grammar-brief.md, R-412, design §19.103/D132
 * item 1): a re-time by one edge. Its own list, never joining `MOVE_VERBS` --
 * these five name only the END edge (`extend`/`lengthen`/`shorten` always a
 * distance, `end`/`finish` a distance or a new time); the START edge, and a
 * distance/time on the END edge said a different way, are read through
 * `MOVE_VERBS`' own possessive-edge tail ("move Sam's start to 9", "shift
 * Sam's end an hour later") instead -- two doors to the same `adjust` field,
 * never two lists sharing one verb (R-391 still holds: none of these five
 * appear in any other list).
 */
export const ADJUST_VERBS = ["extend", "lengthen", "shorten", "end", "finish"] as const;

/**
 * S58 (R-415, design §19.103/D132 item 4): "make"/"set" a job's headcount.
 * See the R-391 comment above `ASSIGN_VERBS` for "set"'s one documented
 * exception to the one-verb-one-list rule.
 */
export const HEADCOUNT_VERBS = ["make", "set"] as const;

/**
 * S58 (R-416, design §19.103/D132 item 5): "every weekday this week", "every
 * day next week", "weekdays next week" -- stripped from the sentence by
 * `extractRepeatDayClause` before any verb dispatch runs (so every existing
 * grammar's own day-word reading never sees it), then reattached by
 * `applyRepeatDay` once the intent is known: legal only on an assign or a
 * booking, `bad_day` everywhere else. "every weekday" and "weekdays" are the
 * same `DayWord` kind (`weekdays`); "every day" is the other one
 * (`every_day`); either with no "this week"/"next week" said defaults to
 * "this week" (RW4).
 */
export const REPEAT_WORDS = ["every weekday", "every day", "weekdays"] as const;

/**
 * S55 (brief §1, R-406): "cover"/"replace" the two REPLACE_VERBS, "swap"/
 * "exchange" the two SWAP_VERBS -- one canonical word each, first in its own
 * list, so `formatCommand` prints "cover"/"swap" the same way the other four
 * intents print their own list's first word regardless of the synonym said.
 */
export const REPLACE_VERBS = ["cover", "replace"] as const;
export const SWAP_VERBS = ["swap", "exchange"] as const;
/** R-408 (S55): "copy"/"repeat" as leading verbs, plus the "same as" opener
 *  (not itself a verb word -- checked separately, brief §3 CP1/CP2). */
export const COPY_VERBS = ["copy", "repeat"] as const;

/** R-407 (S55): the reserved operator word on a removal or a move -- "clear
 *  Cell 1", "unassign everyone from Cell 3", "move everyone on Line 1".
 *  Never reserved on an assign or a booking (EV10): "everyone" there reads
 *  as a PERSON's words, unchanged, and the resolver says no such person. */
export const EVERYONE = "everyone";

/** R-404 (S55, D130 item 3): three shift names the RESOLVER answers from the
 *  cell's own pattern, never from the clock -- they travel exactly the way
 *  an ordinary shift name already does (D128/R-402). */
export const ALL_DAY = "all day";
export const END_OF_SHIFT = "end of shift";
export const END_OF_DAY = "end of day";
/** S58 (R-414, design §19.103/D132 item 3): "the job's hours" -- the fourth
 *  reserved shift name. Read only from "the <product> job"/"the <product>
 *  run" on the ASSIGN grammar (`tryJobHoursAssign`, below); the resolver
 *  finds that part's own run on that cell and day and takes its hours,
 *  never the clock. */
export const JOB_HOURS = "the job";
export const BOUNDARY_SHIFTS = [ALL_DAY, END_OF_SHIFT, END_OF_DAY, JOB_HOURS] as const;

/** R-404 (S55, D130 item 3): "after T" on a removal ends here -- the one
 *  value `ClockTime` can hold for midnight; the resolver reads it as such. */
export const DAY_END: ClockTime = { hour: 23, minute: 59 };

/** R-409 (S55): the absence grammar's own words, read right after "is" --
 *  "Sam is off today", "Ana is on leave till Friday". Order matters only in
 *  that the three two-word phrases must each stay intact in the regex built
 *  from this list (`ABSENCE_RE`, below). */
export const ABSENCE_WORDS = [
  "off",
  "out",
  "away",
  "sick",
  "ill",
  "absent",
  "on leave",
  "on holiday",
  "on vacation",
] as const;

/** R-405 (S55, D130 item 7): read as a SHIFT NAME, never a clock -- "this
 *  afternoon", "tonight" (irregular for "this night"), "tomorrow morning",
 *  "for the night" all resolve against the cell's own bands (D128), exactly
 *  like an ordinary shift name said any other way. */
export const TIME_OF_DAY_WORDS = ["morning", "afternoon", "evening", "night"] as const;

/** The first word decides book vs assign. Built from `BOOK_VERBS`. */
const BOOK_VERB_RE = new RegExp(`^(${BOOK_VERBS.join("|")})\\b\\s*`, "i");

/** The first word decides unassign vs everything else. Built from `UNASSIGN_VERBS`. */
const UNASSIGN_VERB_RE = new RegExp(`^(${UNASSIGN_VERBS.join("|")})\\b\\s*`, "i");

/** S55: the first word decides replace/swap/copy vs everything else. */
const REPLACE_VERB_RE = new RegExp(`^(${REPLACE_VERBS.join("|")})\\b\\s*`, "i");
const SWAP_VERB_RE = new RegExp(`^(${SWAP_VERBS.join("|")})\\b\\s*`, "i");
const COPY_VERB_RE = new RegExp(`^(${COPY_VERBS.join("|")})\\b\\s*`, "i");
/** R-408: the "same as yesterday" opener -- not a verb word, checked on its
 *  own, before `COPY_VERB_RE` (brief §3, CP1/CP2). */
const SAME_AS_RE = /^same\s+as\s+/i;

/** The first word decides move vs everything else. Built from `MOVE_VERBS`. */
const MOVE_VERB_RE = new RegExp(`^(${MOVE_VERBS.join("|")})\\b\\s*`, "i");

/** S58: the first word decides adjust/split/headcount vs everything else. */
const ADJUST_VERB_RE = new RegExp(`^(${ADJUST_VERBS.join("|")})\\b\\s*`, "i");
/** R-413: "split" is its own first word -- it joins no verb list (it names
 *  no other intent), so the first-word dispatch tries it directly rather
 *  than building it from an exported array of one. */
const SPLIT_RE = /^split\b\s*/i;
const HEADCOUNT_VERB_RE = new RegExp(`^(${HEADCOUNT_VERBS.join("|")})\\b\\s*`, "i");

const WEEKDAY_ALTS =
  "mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?";

const WEEKDAY_MAP: Record<string, 0 | 1 | 2 | 3 | 4 | 5 | 6> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

const WEEKDAY_ABBR: readonly string[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** S55 (R-404): adds "yesterday" -- a day like any other, read anywhere
 *  today/tomorrow already are. Week words are NOT here: they are legal only
 *  on a copy's own `from`/`to` (`DAY_OR_WEEK_TOKEN_RE`, below), never as a
 *  trailing day on assign/book/unassign/move. */
const DAY_TAIL_RE = new RegExp(
  `(^|\\s)(on\\s+)?(today|tomorrow|yesterday|${WEEKDAY_ALTS}|\\d{4}-\\d{2}-\\d{2})\\s*$`,
  "i",
);

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** S55 (R-408): one day-or-week token, for the copy grammar's own `from`/
 *  `to` -- the only place a week kind is legal (D130 item 4). Built as a
 *  plain string (not a compiled RegExp) so `parseCopyPair`/`parseCopySame`
 *  below can splice it into their own anchored patterns. */
const DAY_OR_WEEK_TOKEN =
  `(?:today|tomorrow|yesterday|this\\s+week|next\\s+week|last\\s+week|` +
  `${WEEKDAY_ALTS}|\\d{4}-\\d{2}-\\d{2})`;

/** F-1xx: the browser's speech recogniser writes "7:00 p.m." / "8 a.m." with
 *  dots -- `a\.?m\.?`/`p\.?m\.?` accepts the plain `am`/`pm` this already
 *  read, plus `a.m.`/`p.m.`/`a.m`/`p.m` (any case, the trailing dot always
 *  optional since `parseCommand` strips one sentence-final period before
 *  this ever runs). Normalised by stripping dots before the am/pm check
 *  below, so nothing past this line needs to know the dotted form exists. */
const TIME_TOKEN_RE = /^(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?$/i;

/** S41-a: only `for <digits>` is a headcount clause (brief §3, B5) — a `for`
 *  not followed by a whole number is ordinary place text ("for lunch"). R-405
 *  (S55, brief §3 WO6): "with N people" joins "for N people" as a headcount
 *  clause, for every book form -- not just the word-order grammar's own
 *  "runs". */
const HEADCOUNT_CLAUSE_RE =
  /\s+(?:for|with)\s+(\S+)(?:\s+(?:people|persons|operators|heads))?\s*$/i;

/**
 * R-402 (the maintainer, 13 Sept, session 163): the shift clause -- read
 * anywhere in the sentence (it is never the first word, so an unanchored
 * search is safe), BEFORE the time clause and the places are read (brief
 * item 3). One word stops a name early wherever it would otherwise swallow
 * the next clause's own preposition or the word "shift" itself.
 *
 * Reviewer fix, blocker 1: the NAMED form (`for shift 2`, `during shift 3`)
 * takes only "for"/"during" as its own preposition, never "on"/"in" -- those
 * are PLACE prepositions, and a place is what follows them ("on Shift Bay
 * 2" is a place named "Shift Bay 2", unquoted, and must stay one). The
 * TRAILING-WORD form ("for the night shift", "on the morning shift") is
 * unambiguous -- "shift" is the very last word, nothing to confuse with a
 * place -- so it keeps "on" (and drops "in", which was never exercised).
 */
const SHIFT_STOP_WORD = "(?:on|at|in|for|during|to|from|and|shift)";
/** One name word: not a quote placeholder (that is its own alternative,
 *  below), not a comma (the char class excludes it, so a name never reaches
 *  across one), and not one of the stop words above. */
const SHIFT_NAME_WORD = `(?:(?!\\b${SHIFT_STOP_WORD}\\b)[^\\s,]+)`;
/** One or two name words, or a whole quoted segment (already a single
 *  atomic token by the time this runs, brief item 3: `for shift "Late
 *  Turn"`). */
const SHIFT_NAME = `(${QUOTE_OPEN}\\d+${QUOTE_CLOSE}|${SHIFT_NAME_WORD}(?:\\s+${SHIFT_NAME_WORD})?)`;
/** "for shift 2", "during shift 3", "for the shift 2" -- the name follows
 *  the word "shift" itself. Never "on"/"in" (blocker 1): those introduce a
 *  PLACE ("on Shift Bay 2"), not this clause. */
const SHIFT_NAMED_RE = new RegExp(
  `\\s*\\b(?:for|during)\\s+(?:the\\s+)?shift\\s+${SHIFT_NAME}`,
  "i",
);
/** "for the night shift", "on the morning shift" -- the name PRECEDES the
 *  word "shift", which is unambiguous (nothing to confuse with a place). */
const SHIFT_TRAILING_WORD_RE = new RegExp(
  `\\s*\\b(?:for|on|during)\\s+the\\s+${SHIFT_NAME}\\s+shift\\b`,
  "i",
);

/** R-402: pulls the (at most one) shift clause out of `text`, wherever it
 *  sits, restoring a quoted name to its original words. `shift: null` and
 *  `text` unchanged when neither form is found. */
function extractShiftClause(
  text: string,
  quotes: string[],
): { rest: string; shift: string | null } {
  const m = text.match(SHIFT_NAMED_RE) ?? text.match(SHIFT_TRAILING_WORD_RE);
  if (!m || m.index === undefined) return { rest: text, shift: null };
  const shift = restoreQuotes(m[1], quotes);
  const rest = (text.slice(0, m.index) + text.slice(m.index + m[0].length))
    .replace(/\s+/g, " ")
    .trim();
  return { rest, shift };
}

/** Removes a matched clause from `text` and collapses the resulting
 *  whitespace -- the same shape every extractor in this file uses to drop a
 *  clause it found, pulled out once for the boundary/TOD helpers below. */
function removeMatch(text: string, m: RegExpMatchArray): string {
  if (m.index === undefined) return text;
  return (text.slice(0, m.index) + text.slice(m.index + m[0].length)).replace(/\s+/g, " ").trim();
}

/** One inline clock-time token, for splicing into a larger pattern (the
 *  boundary regexes below) -- the same shape `TIME_TOKEN_RE` validates on
 *  its own, minus the anchors. */
const TIME_TOKEN_INLINE = "\\d{1,2}(?:[:.]\\d{2})?\\s*(?:a\\.?m\\.?|p\\.?m\\.?)?";

/** R-404 (S55, D130 item 3): "all day" never carries a start -- the whole
 *  span is the cell's first band's start to its last band's end. */
const ALL_DAY_RE = /\ball\s+day\b/i;

/** R-404 (D130 item 3): the five phrasings the maintainer gave for "the shift
 *  ends here" -- an optional leading "from <time>" is the ONE edge this
 *  boundary may carry (it names only the other edge); `ALL_DAY_RE` above
 *  never gets this option. */
const END_OF_SHIFT_CORE =
  "(?:until\\s+end\\s+of\\s+shift|till\\s+end\\s+of\\s+shift|to\\s+the\\s+end\\s+of\\s+the\\s+shift|" +
  "until\\s+the\\s+end\\s+of\\s+shift|for\\s+the\\s+rest\\s+of\\s+the\\s+shift)";
const END_OF_DAY_CORE =
  "(?:for\\s+the\\s+rest\\s+of\\s+the\\s+day|until\\s+end\\s+of\\s+day|till\\s+the\\s+end\\s+of\\s+the\\s+day)";
const END_OF_SHIFT_RE = new RegExp(
  `\\b(?:from\\s+(${TIME_TOKEN_INLINE})\\s+)?${END_OF_SHIFT_CORE}\\b`,
  "i",
);
const END_OF_DAY_RE = new RegExp(
  `\\b(?:from\\s+(${TIME_TOKEN_INLINE})\\s+)?${END_OF_DAY_CORE}\\b`,
  "i",
);

/** R-405 (D130 item 7): a time-of-day word read as a shift NAME, never a
 *  clock. "this X"/"tonight"/"tomorrow X" also fix the DAY (merged with
 *  whatever day the caller finds elsewhere via `mergeDay` -- F-133's own
 *  never-guess rule, so "this afternoon tomorrow" is `two_days`, TD7); "for
 *  the X" alone fixes only the shift, day stays whatever else was said. */
const TOD_ALTS = TIME_OF_DAY_WORDS.join("|");
const TOD_THIS_RE = new RegExp(`\\bthis\\s+(${TOD_ALTS})\\b`, "i");
const TOD_TONIGHT_RE = /\btonight\b/i;
const TOD_TOMORROW_RE = new RegExp(`\\btomorrow\\s+(${TOD_ALTS})\\b`, "i");
const TOD_FOR_THE_RE = new RegExp(`\\bfor\\s+the\\s+(${TOD_ALTS})\\b`, "i");

interface ShiftOrBoundaryResult {
  rest: string;
  /** The shift's name -- a `BOUNDARY_SHIFTS` constant, an ordinary R-402
   *  name, or a time-of-day word (R-405); `null` when nothing was found. */
  shift: string | null;
  /** True only for `ALL_DAY` -- the one boundary a removal or a move reads
   *  as saying nothing at all (R-404's amendment; the caller drops it). */
  isAllDay: boolean;
  /** A start captured off an `end of shift`/`end of day` boundary's own
   *  optional "from <time>" prefix (assign/book only -- R-404's amendment to
   *  the invariant). A removal/move caller discards this (R-404: "read it
   *  and drop it" applies the same way `ALL_DAY` does -- neither grammar has
   *  anywhere to put a start next to a `span`). */
  start: ClockTime | null;
  /** The day a time-of-day clause fixed ("this afternoon" -> today,
   *  "tomorrow morning" -> tomorrow) -- merged by the caller via `mergeDay`. */
  impliedDay: DayWord | null;
  impliedDayWord: string | null;
}

/**
 * R-404 (S55): the single entry point every grammar (assign, book, unassign,
 * move) now calls instead of `extractShiftClause` directly -- tries, in
 * order, `ALL_DAY`, `end of shift`/`end of day` (both with their optional
 * start), the R-402 named-shift forms (unchanged), then the R-405
 * time-of-day forms. At most one of these ever fires; the caller reads the
 * shift clause exactly once, same as R-402 always has.
 */
function extractShiftOrBoundaryClause(text: string, quotes: string[]): ShiftOrBoundaryResult {
  const none: ShiftOrBoundaryResult = {
    rest: text,
    shift: null,
    isAllDay: false,
    start: null,
    impliedDay: null,
    impliedDayWord: null,
  };

  const allDayMatch = text.match(ALL_DAY_RE);
  if (allDayMatch) {
    return { ...none, rest: removeMatch(text, allDayMatch), shift: ALL_DAY, isAllDay: true };
  }

  const eos = text.match(END_OF_SHIFT_RE);
  if (eos) {
    const startToken = eos[1] ? parseTimeToken(eos[1]) : null;
    return {
      ...none,
      rest: removeMatch(text, eos),
      shift: END_OF_SHIFT,
      start: startToken ? { hour: startToken.hour, minute: startToken.minute } : null,
    };
  }
  const eod = text.match(END_OF_DAY_RE);
  if (eod) {
    const startToken = eod[1] ? parseTimeToken(eod[1]) : null;
    return {
      ...none,
      rest: removeMatch(text, eod),
      shift: END_OF_DAY,
      start: startToken ? { hour: startToken.hour, minute: startToken.minute } : null,
    };
  }

  const named = extractShiftClause(text, quotes);
  if (named.shift !== null) {
    return { ...none, rest: named.rest, shift: named.shift };
  }

  const thisTod = text.match(TOD_THIS_RE);
  if (thisTod) {
    return {
      ...none,
      rest: removeMatch(text, thisTod),
      shift: thisTod[1].toLowerCase(),
      impliedDay: { kind: "today" },
      impliedDayWord: thisTod[0].trim(),
    };
  }
  const tonightMatch = text.match(TOD_TONIGHT_RE);
  if (tonightMatch) {
    return {
      ...none,
      rest: removeMatch(text, tonightMatch),
      shift: "night",
      impliedDay: { kind: "today" },
      impliedDayWord: tonightMatch[0].trim(),
    };
  }
  const tomorrowTod = text.match(TOD_TOMORROW_RE);
  if (tomorrowTod) {
    return {
      ...none,
      rest: removeMatch(text, tomorrowTod),
      shift: tomorrowTod[1].toLowerCase(),
      impliedDay: { kind: "tomorrow" },
      impliedDayWord: tomorrowTod[0].trim(),
    };
  }
  const forTheTod = text.match(TOD_FOR_THE_RE);
  if (forTheTod) {
    return { ...none, rest: removeMatch(text, forTheTod), shift: forTheTod[1].toLowerCase() };
  }

  return none;
}

/** R-401: a person named by a possessive timing tail in the move grammar --
 *  "Operator A3's timing", "operator a3s timing" (F-144's dotted-recogniser
 *  spelling drops the apostrophe), "Sam's hours"/"time"/"schedule"/"slot" --
 *  reads as the person; the resolver has no timing to look up. Only ever
 *  applied to the move grammar's own operator segment.
 *
 *  Reviewer fix, should-fix 1: the bare-`s` alternative (no apostrophe --
 *  the recogniser's own dropped-apostrophe spelling) fires ONLY when the
 *  character right before it is a DIGIT ("a3s timing", "b12s hours") -- an
 *  ordinary name that happens to end in "s" ("Chris") is never mistaken for
 *  one. `'s`/`’s` (a real apostrophe, typed or spoken correctly) still
 *  apply to any name -- there the intent is unambiguous. */
const POSSESSIVE_TIMING_TAIL_RE = /\s*(?:'s|’s|(?<=\d)s)\s+(?:timing|hours|time|schedule|slot)$/i;

/** S58 (R-412, brief §2 AJ1/AJ5): "Sam's block" on the `ADJUST_VERBS`
 *  grammar reads as the person, exactly the way the move grammar's own
 *  possessive TIMING tail does -- same apostrophe/dropped-apostrophe shapes,
 *  a different trailing word. Anchored at the end of the OPERATOR segment
 *  only (the adjust clause itself is already stripped by the time this
 *  runs). */
const POSSESSIVE_BLOCK_TAIL_RE = /\s*(?:'s|’s|(?<=\d)s)\s+block$/i;

/** S58 (R-412, brief §1): a trailing possessive EDGE tail on the move
 *  grammar's operator segment -- "Sam's start", "Sam's end", "Sam's finish"
 *  -- names the person AND which edge to adjust; UNANCHORED (there is always
 *  more sentence after it: a new time or a distance), unlike
 *  `POSSESSIVE_TIMING_TAIL_RE`/`POSSESSIVE_BLOCK_TAIL_RE` which sit at the
 *  very end of their own segment. A quoted operator ("Sam's start" typed as
 *  one literal name) never reaches this regex at all -- its apostrophe is
 *  already hidden inside a quote placeholder token by the time
 *  `parseMoveRest`'s caller runs this (brief §3, "quoted names ... stay
 *  atomic"), so `tryMoveEdgeAdjust` finds nothing and the ordinary move
 *  grammar reads the whole quoted string as the person's name, unchanged. */
const POSSESSIVE_EDGE_TAIL_RE = /(?:'s|’s|(?<=\d)s)\s+(start|end|finish)\b/i;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Pulls every "..." segment out, leaving a placeholder with no whitespace in
 *  its place, so later splitting never breaks a quoted name apart. */
function extractQuotes(text: string): { text: string; quotes: string[] } {
  const quotes: string[] = [];
  const out = text.replace(/"([^"]*)"/g, (_m, inner: string) => {
    const token = `${QUOTE_OPEN}${quotes.length}${QUOTE_CLOSE}`;
    quotes.push(inner);
    return token;
  });
  return { text: out, quotes };
}

function restoreQuotes(text: string, quotes: string[]): string {
  return text
    .replace(new RegExp(`${QUOTE_OPEN}(\\d+)${QUOTE_CLOSE}`, "g"), (_m, i: string) => {
      return quotes[Number(i)] ?? "";
    })
    .trim();
}

/** One time token: `10`, `10am`, `10 am`, `10:30`, `10.30`, `14:00`, `noon`,
 *  `midnight`. `hasMeridiem` is what the afternoon rule (brief §4.2) keys on
 *  for the END of a pair. `explicitMeridiem` is narrower — true only for a
 *  literal `am`/`pm` suffix, never for the synthetic `noon`/`midnight`
 *  words — because F-134's START-side gate (`applyAfternoonRule`) must NOT
 *  fire on "noon" (P10 stays "noon to 3" -> 12:00-15:00) but must fire on an
 *  explicit "1pm" or "12am" (P33, P11). */
function parseTimeToken(
  raw: string,
): { hour: number; minute: number; hasMeridiem: boolean; explicitMeridiem: boolean } | null {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  if (lower === "noon") return { hour: 12, minute: 0, hasMeridiem: true, explicitMeridiem: false };
  if (lower === "midnight")
    return { hour: 0, minute: 0, hasMeridiem: true, explicitMeridiem: false };
  const m = trimmed.match(TIME_TOKEN_RE);
  if (!m) return null;
  const hourRaw = Number(m[1]);
  const minute = m[2] !== undefined ? Number(m[2]) : 0;
  const meridiem = m[3] ? m[3].toLowerCase().replace(/\./g, "") : null;
  if (minute > 59) return null;
  if (meridiem) {
    if (hourRaw < 1 || hourRaw > 12) return null;
    let hour = hourRaw % 12; // 12 -> 0
    if (meridiem === "pm") hour += 12;
    return { hour, minute, hasMeridiem: true, explicitMeridiem: true };
  }
  if (hourRaw < 0 || hourRaw > 23) return null;
  return { hour: hourRaw, minute, hasMeridiem: false, explicitMeridiem: false };
}

function totalMinutes(t: { hour: number; minute: number }): number {
  return t.hour * 60 + t.minute;
}

/**
 * F-134 (brief §3b): the afternoon rule adds 12h to an END with no meridiem
 * when it is not already after the START -- but only when the START itself
 * is still ambiguous about which half of the day it names (a bare hour
 * under 13, no explicit am/pm). A START that is already unambiguous (13:00
 * or later in 24h form, or an explicit "1pm"/"12am") fully pins the day
 * down; guessing at the END on top of that is exactly the bug this exists
 * to fix ("17:15 till 10:30" silently read as 17:15-22:30). Returns the
 * (possibly adjusted) end, or `null` when the end is still not after the
 * start -- the caller turns that into `time_order`.
 */
function applyAfternoonRule(
  start: { hour: number; minute: number; explicitMeridiem: boolean },
  end: { hour: number; minute: number; hasMeridiem: boolean },
): ClockTime | null {
  const startPinned = start.hour >= 13 || start.explicitMeridiem;
  let adjusted = { hour: end.hour, minute: end.minute };
  if (!startPinned && !end.hasMeridiem && !(totalMinutes(end) > totalMinutes(start))) {
    adjusted = { hour: (end.hour + 12) % 24, minute: end.minute };
  }
  if (!(totalMinutes(adjusted) > totalMinutes(start))) return null;
  return adjusted;
}

/**
 * F-146: true when `raw` -- an END token's own raw text, never a START's --
 * spells "the end of the day": "midnight", "12am"/"12 am"/"12:00am"/"12:00
 * am", or the literal "24:00"/"24.00" (`ClockTime.hour` cannot hold 24, so
 * "24:00" is not an ordinary time token at all — `parseTimeToken` refuses it
 * outright, `bad_time`). A START spelled "midnight" is NEVER read this way —
 * it stays the literal `{0,0}` `parseTimeToken` already gives it (the one
 * spelling the two ends share, disambiguated only by WHICH end of the pair
 * it is, exactly as English does).
 */
function isDayEndSpelling(raw: string): boolean {
  const t = raw.trim().toLowerCase();
  return t === "midnight" || t === "24:00" || t === "24.00" || /^12(?::00)?\s*a\.?m\.?$/.test(t);
}

/**
 * F-146: the END half of a "from X to Y" pair (or its "to X to Y"/bare-pair
 * siblings) — `endRaw` spelled `isDayEndSpelling` writes `DAY_END` (23:59,
 * the one value `ClockTime` can hold for the day's end) outright, the same
 * reserved spelling the removal grammar's own lone edge already writes
 * (`extractLoneEdgeSpan`'s "after 2 pm"); every other END still goes through
 * `applyAfternoonRule` unchanged. Before this fix a block that ends exactly
 * at midnight could not be said on the assign/book/unassign/move "from X to
 * Y" grammars at all: "from 8 pm to midnight" failed `time_order` (`{0,0}`
 * never reads as after 20:00), and "from 20:00 to 24:00" failed `bad_time`
 * (24 is not a legal `ClockTime` hour). No ordering check runs when the END
 * is `DAY_END`: read as the day's own 1440th minute (`resolve.ts`'s
 * `clockToMinuteOfDay`), it is later than every legal START.
 */
function resolveEndAgainstStart(
  start: { hour: number; minute: number; explicitMeridiem: boolean },
  endRaw: string,
): { ok: true; end: ClockTime } | { ok: false; failure: "bad_time" | "time_order" } {
  if (isDayEndSpelling(endRaw)) return { ok: true, end: DAY_END };
  const end = parseTimeToken(endRaw);
  if (!end) return { ok: false, failure: "bad_time" };
  const adjusted = applyAfternoonRule(start, end);
  if (!adjusted) return { ok: false, failure: "time_order" };
  return { ok: true, end: adjusted };
}

/**
 * S41-b: the day word, extracted from the END of `text` — moved out of
 * `parseTimeAndDay`'s step 3 unchanged (brief §3: "the day word as today")
 * so `parseUnassignRest`, which has no mandatory time clause to anchor day
 * detection on, shares it instead of retyping the ISO/weekday logic.
 */
function extractDayWord(
  text: string,
):
  | { ok: true; rest: string; day: DayWord | null; word: string | null }
  | { ok: false; failure: ParseFailure } {
  let rest = text;
  let day: DayWord | null = null;
  let word: string | null = null;
  const dayMatch = rest.match(DAY_TAIL_RE);
  if (dayMatch) {
    word = dayMatch[3];
    const lowerWord = word.toLowerCase();
    const isoMatch = word.match(ISO_DATE_RE);
    if (isoMatch) {
      const year = Number(isoMatch[1]);
      const month = Number(isoMatch[2]);
      const dayOfMonth = Number(isoMatch[3]);
      if (!isRealDate(year, month, dayOfMonth)) {
        return { ok: false, failure: { kind: "bad_day", text: word } };
      }
      day = { kind: "date", iso: word };
    } else if (lowerWord === "today") {
      day = { kind: "today" };
    } else if (lowerWord === "tomorrow") {
      day = { kind: "tomorrow" };
    } else if (lowerWord === "yesterday") {
      day = { kind: "yesterday" };
    } else {
      const weekday = WEEKDAY_MAP[lowerWord];
      day = { kind: "weekday", day: weekday };
    }
    rest = rest.slice(0, dayMatch.index).trim();
  }
  return { ok: true, rest, day, word };
}

/** F-133: true when a leading day word and a trailing one name different
 *  days -- the same day said twice (P27) is never a conflict. */
function sameDay(a: DayWord, b: DayWord): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "weekday" && b.kind === "weekday") return a.day === b.day;
  if (a.kind === "date" && b.kind === "date") return a.iso === b.iso;
  return true; // today/tomorrow: same kind already means the same day
}

/** F-133: merges a day word found BEFORE the hours with one found AFTER
 *  them. Never guesses (CLAUDE.md §4): two that disagree is `two_days`,
 *  named with the leading one first (the order they were said in). */
function mergeDay(
  leading: { day: DayWord | null; word: string | null },
  trailing: { day: DayWord | null; word: string | null },
): { ok: true; day: DayWord | null } | { ok: false; failure: ParseFailure } {
  if (leading.day !== null && trailing.day !== null && !sameDay(leading.day, trailing.day)) {
    return {
      ok: false,
      failure: {
        kind: "two_days",
        first: leading.word ?? "",
        second: trailing.word ?? "",
      },
    };
  }
  return { ok: true, day: leading.day ?? trailing.day };
}

/** F-133: true when `text` ends with a "from <x> <sep> <y>" shape (the
 *  LAST "from" in the string, everything after it matching the pair
 *  pattern to the very end). Purely syntactic -- never checks the tokens'
 *  VALIDITY, which the normal path still does -- so it can gate whether a
 *  trailing day word is really sitting after an hours clause without
 *  duplicating `parseTimeAndDay`'s own time-token parsing. */
function endsWithFromClauseShape(text: string): boolean {
  const fromRe = /\bfrom\b/gi;
  let lastFrom = -1;
  let fm: RegExpExecArray | null;
  while ((fm = fromRe.exec(text)) !== null) lastFrom = fm.index;
  if (lastFrom === -1) return false;
  const timeClauseText = text.slice(lastFrom + "from".length).trim();
  return /^.+?\s+(?:to|-|–|until|till)\s+.+$/i.test(timeClauseText);
}

/** F-133's same gate for `extractToTimeClause`'s "to <time> to <time>"
 *  shape -- tried from the string's LAST "to" backwards exactly like that
 *  function itself, so the two never disagree about which "to" starts the
 *  clause. */
function endsWithToClauseShape(text: string): boolean {
  const toRe = /\bto\b/gi;
  const positions: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = toRe.exec(text)) !== null) positions.push(m.index);
  for (let i = positions.length - 1; i >= 0; i--) {
    const suffix = text.slice(positions[i] + 2).trim();
    if (/^.+?\s+(?:to|-|–|until|till)\s+.+$/i.test(suffix)) return true;
  }
  return false;
}

/**
 * F-133: the day word may also come AFTER the hours, in every grammar.
 * Tries to read a day off the very END of `text`; only commits to it when
 * what is left still ends in a time clause per `hasTimeClauseTail` --
 * otherwise a trailing word that merely LOOKS like a day (P18/P28's "on
 * funday", never matched by `DAY_TAIL_RE` at all) or a real day word with
 * no hours clause behind it (an ordinary leading-day sentence) is left
 * alone for the normal path to read as before. Delegates the actual
 * extraction (and the `bad_day` check on an invalid trailing ISO date) to
 * `extractDayWord` once committed, so the two never disagree.
 */
function extractTrailingDay(
  text: string,
  hasTimeClauseTail: (candidate: string) => boolean,
):
  | { ok: true; rest: string; day: DayWord | null; word: string | null }
  | { ok: false; failure: ParseFailure } {
  const tailMatch = text.match(DAY_TAIL_RE);
  if (!tailMatch) return { ok: true, rest: text, day: null, word: null };
  const candidate = text.slice(0, tailMatch.index).trim();
  if (!hasTimeClauseTail(candidate)) return { ok: true, rest: text, day: null, word: null };
  return extractDayWord(text);
}

function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12) return false;
  if (day < 1) return false;
  const daysInMonth = [31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Shared by both intents (brief §3: "pull the time clause and day-word steps
 * into private helpers used by both"). Operates on the whole normalised,
 * quote-extracted text; returns everything before the day word (the verb,
 * the operator-or-nothing, the product, the places, and for a book sentence
 * the headcount clause, all still inside `rest`), the day, and the parsed
 * clock times. Unchanged from the pre-S41-a `parseCommand` steps 1–3.
 */
function parseTimeAndDay(
  norm: string,
):
  | { ok: true; rest: string; day: DayWord | null; start: ClockTime; end: ClockTime }
  | { ok: false; failure: ParseFailure } {
  // 0. F-133: a day word AFTER the hours, read off the end of the WHOLE
  // line before anything else -- only committed when what remains still
  // ends in a time clause (extractTrailingDay's own gate).
  const trailingDay = extractTrailingDay(norm, endsWithFromClauseShape);
  if (!trailingDay.ok) return trailingDay;
  const text = trailingDay.rest;

  // 1. Time clause — the LAST "from <time> <sep> <time>" at the end.
  const fromRe = /\bfrom\b/gi;
  let lastFrom = -1;
  let fm: RegExpExecArray | null;
  while ((fm = fromRe.exec(text)) !== null) {
    lastFrom = fm.index;
  }
  if (lastFrom === -1) return { ok: false, failure: { kind: "no_time" } };

  const beforeFrom = text.slice(0, lastFrom).trim();
  const timeClauseText = text.slice(lastFrom + "from".length).trim();
  const timeMatch = timeClauseText.match(/^(.+?)\s+(to|-|–|until|till)\s+(.+)$/i);
  if (!timeMatch) return { ok: false, failure: { kind: "no_time" } };
  const [, startRaw, , endRaw] = timeMatch;

  const start = parseTimeToken(startRaw);
  if (!start) return { ok: false, failure: { kind: "bad_time", text: startRaw.trim() } };
  // 2. The afternoon rule (F-134: gated on the START, applyAfternoonRule) --
  // F-146: an END spelled "midnight"/"12 am"/"24:00" writes DAY_END instead.
  const endResult = resolveEndAgainstStart(start, endRaw);
  if (!endResult.ok) {
    return endResult.failure === "bad_time"
      ? { ok: false, failure: { kind: "bad_time", text: endRaw.trim() } }
      : { ok: false, failure: { kind: "time_order" } };
  }
  const adjustedEnd = endResult.end;

  // 3. Day word, immediately before the time clause (shared, S41-b: extractDayWord),
  // merged with the trailing one found in step 0 (F-133: never guess).
  const dayResult = extractDayWord(beforeFrom);
  if (!dayResult.ok) return dayResult;
  const merged = mergeDay(
    { day: dayResult.day, word: dayResult.word },
    { day: trailingDay.day, word: trailingDay.word },
  );
  if (!merged.ok) return merged;

  return {
    ok: true,
    rest: dayResult.rest,
    day: merged.day,
    start: { hour: start.hour, minute: start.minute },
    end: adjustedEnd,
  };
}

/** Splits a product-and-places string on the shared delimiter set — never
 *  `for` (brief §3, B5: "the split words are on/at/in/comma, never for"). */
function splitProductPlaces(text: string): string[] {
  return text
    .split(/\s+on\s+|\s+at\s+|\s+in\s+|\s*,\s*/gi)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * S50 (brief §2 item 3): does `text` (the OPERATOR segment, or the FIRST
 * PLACE segment) list more than one item? Operates on the quote-sentineled
 * text, same as every other split in this file, so a quoted "Ann and Bob"
 * (one opaque token, no literal "and" left in the string) is never read as
 * a list. `allowCommas` additionally accepts a ", "-joined run before the
 * final " and " (an operator list only -- "A1, A2 and A3" -- a PLACE list
 * splits on " and " alone, since a comma there is already a qualifier
 * separator, `splitProductPlaces`'s own job, brief §2 item 3's own note).
 *
 * - `{ kind: "none" }` — no standalone "and" at all: not a list, the
 *   caller's existing single-item path runs exactly as before S50.
 * - `{ kind: "bad" }` — a leading or trailing "and" (on the WHOLE text, or
 *   -- reviewer fix -- on any ONE item after splitting, e.g. a doubled
 *   "Sam and and Bob" splits on the first " and " into "Sam" and "and Bob",
 *   which still starts with "and"), or an empty item between two
 *   separators: the caller turns this into `bad_list`.
 * - `{ kind: "list"; items }` — two or more items, in order.
 */
function detectAndList(
  text: string,
  allowCommas: boolean,
): { kind: "none" } | { kind: "bad" } | { kind: "list"; items: string[] } {
  const trimmed = text.trim();
  if (!/\band\b/i.test(trimmed)) return { kind: "none" };
  if (/^and\b/i.test(trimmed) || /\band$/i.test(trimmed)) return { kind: "bad" };
  const delimiter = allowCommas ? /\s*,\s*|\s+and\s+/gi : /\s+and\s+/gi;
  const items = trimmed.split(delimiter).map((s) => s.trim());
  if (items.length < 2) return { kind: "bad" };
  if (items.some((s) => s === "" || /^and\b/i.test(s) || /\band$/i.test(s))) return { kind: "bad" };
  return { kind: "list", items };
}

/**
 * S50 (brief §2 item 3): combines an optional OPERATOR list with an
 * optional FIRST-PLACE list into N pairs -- n people x 1 place broadcasts
 * the place onto every one; 1 person x m places broadcasts the person; n =
 * m pairs them in order; n != m with both > 1 is `list_mismatch`, never a
 * guess (R-379). `operatorItems`/`placeItems` are each either the single
 * original segment (length 1, "not a list" per `detectAndList`) or its
 * `items` (length >= 2).
 */
function combineLists<T>(
  operatorItems: string[],
  placeItems: string[],
  build: (operator: string, place: string) => T,
): { ok: true; items: T[] } | { ok: false; failure: ParseFailure } {
  const n = operatorItems.length;
  const m = placeItems.length;
  if (n > 1 && m > 1 && n !== m) {
    return { ok: false, failure: { kind: "list_mismatch", people: n, places: m } };
  }
  const count = Math.max(n, m);
  const items: T[] = [];
  for (let i = 0; i < count; i++) {
    items.push(
      build(n > 1 ? operatorItems[i] : operatorItems[0], m > 1 ? placeItems[i] : placeItems[0]),
    );
  }
  return { ok: true, items };
}

function parseAssignRest(
  rest: string,
  day: DayWord | null,
  start: ClockTime | null,
  end: ClockTime | null,
  quotes: string[],
  shift: string | null,
): ParseResult {
  // 4. Verb — optional leading verb, one of ASSIGN_VERBS.
  const verbMatch = rest.match(new RegExp(`^(${ASSIGN_VERBS.join("|")})\\s+`, "i"));
  if (verbMatch) rest = rest.slice(verbMatch[0].length);

  // 5. The middle — operator, then product-and-places.
  const sepMatch = rest.match(/ to work on | to | on /i);
  let operatorPart: string;
  let productPlaces: string;
  if (!sepMatch) {
    operatorPart = rest.trim();
    productPlaces = "";
  } else {
    operatorPart = rest.slice(0, sepMatch.index).trim();
    productPlaces = rest.slice((sepMatch.index ?? 0) + sepMatch[0].length).trim();
  }
  if (operatorPart === "") return { ok: false, failure: { kind: "empty" } };
  if (productPlaces === "") return { ok: false, failure: { kind: "no_product" } };

  // R-402 (brief item 4): once a shift clause has already been read out of
  // the sentence, a trailing "for <product>" left in `productPlaces` (the
  // LAST " for " -- the shift clause itself is already gone) names the
  // product LAST, and everything before it is ALL places, never a product
  // followed by places. Without a shift, or without a leftover " for ",
  // nothing here changes: pieces[0] is the product exactly as before.
  let productLastText: string | null = null;
  let placesOnlyText = productPlaces;
  if (shift !== null) {
    const forRe = /\bfor\b/gi;
    let lastFor = -1;
    let fm: RegExpExecArray | null;
    while ((fm = forRe.exec(productPlaces)) !== null) lastFor = fm.index;
    if (lastFor !== -1) {
      placesOnlyText = productPlaces.slice(0, lastFor).trim();
      productLastText = productPlaces.slice(lastFor + "for".length).trim();
    }
  }

  if (productLastText !== null) {
    if (placesOnlyText === "") return { ok: false, failure: { kind: "no_place" } };
    const placePieces = splitProductPlaces(placesOnlyText);
    if (placePieces.length === 0) return { ok: false, failure: { kind: "no_place" } };

    const operatorList = detectAndList(operatorPart, true);
    if (operatorList.kind === "bad")
      return { ok: false, failure: { kind: "bad_list", text: operatorPart } };
    const placeList = detectAndList(placePieces[0], false);
    if (placeList.kind === "bad")
      return { ok: false, failure: { kind: "bad_list", text: placePieces[0] } };

    const product = restoreQuotes(productLastText, quotes);
    if (operatorList.kind === "list" || placeList.kind === "list") {
      const operatorItems = operatorList.kind === "list" ? operatorList.items : [operatorPart];
      const placeItems = placeList.kind === "list" ? placeList.items : [placePieces[0]];
      const combined = combineLists(operatorItems, placeItems, (op, pl) => ({
        intent: "assign" as const,
        operator: restoreQuotes(op, quotes),
        product,
        place: [pl, ...placePieces.slice(1)].map((p) => restoreQuotes(p, quotes)),
        day,
        start,
        end,
        attach: null,
        existing: null,
        shift,
      }));
      if (!combined.ok) return combined;
      return { ok: true, command: { intent: "several", commands: combined.items } };
    }

    return {
      ok: true,
      command: {
        intent: "assign",
        operator: restoreQuotes(operatorPart, quotes),
        product,
        place: placePieces.map((p) => restoreQuotes(p, quotes)),
        day,
        start,
        end,
        attach: null,
        existing: null,
        shift,
      },
    };
  }

  const pieces = splitProductPlaces(productPlaces);
  if (pieces.length === 0) return { ok: false, failure: { kind: "no_product" } };
  if (pieces.length === 1) return { ok: false, failure: { kind: "no_place" } };

  // S50 (brief §2 item 3): the OPERATOR segment and the FIRST PLACE segment
  // (pieces[1] -- pieces[0] is the product, pieces[2:] are qualifiers that
  // apply to every inner command unchanged) may each list more than one
  // item.
  const operatorList = detectAndList(operatorPart, true);
  if (operatorList.kind === "bad")
    return { ok: false, failure: { kind: "bad_list", text: operatorPart } };
  const placeList = detectAndList(pieces[1], false);
  if (placeList.kind === "bad")
    return { ok: false, failure: { kind: "bad_list", text: pieces[1] } };

  if (operatorList.kind === "list" || placeList.kind === "list") {
    const operatorItems = operatorList.kind === "list" ? operatorList.items : [operatorPart];
    const placeItems = placeList.kind === "list" ? placeList.items : [pieces[1]];
    const combined = combineLists(operatorItems, placeItems, (op, pl) => ({
      intent: "assign" as const,
      operator: restoreQuotes(op, quotes),
      product: restoreQuotes(pieces[0], quotes),
      place: [pl, ...pieces.slice(2)].map((p) => restoreQuotes(p, quotes)),
      day,
      start,
      end,
      attach: null,
      existing: null,
      shift,
    }));
    if (!combined.ok) return combined;
    return { ok: true, command: { intent: "several", commands: combined.items } };
  }

  const operator = restoreQuotes(operatorPart, quotes);
  const product = restoreQuotes(pieces[0], quotes);
  const place = pieces.slice(1).map((p) => restoreQuotes(p, quotes));

  return {
    ok: true,
    command: {
      intent: "assign",
      operator,
      product,
      place,
      day,
      start,
      end,
      attach: null,
      existing: null,
      shift,
    },
  };
}

/** S41-a: strips an optional "for <n> [people|persons|operators|heads]"
 *  clause from the END of `text`. Only `for <digits>` (optionally decimal)
 *  counts — anything else is left untouched, as ordinary place text. */
function extractHeadcount(
  text: string,
): { ok: true; rest: string; headcount: number | null } | { ok: false; failure: ParseFailure } {
  const m = text.match(HEADCOUNT_CLAUSE_RE);
  if (!m) return { ok: true, rest: text, headcount: null };
  const token = m[1];
  if (!/^\d+(?:\.\d+)?$/.test(token)) {
    // "for lunch" and the like: not a headcount clause, leave it in place.
    return { ok: true, rest: text, headcount: null };
  }
  const n = Number(token);
  if (!Number.isInteger(n) || n < 1 || n > 99) {
    return { ok: false, failure: { kind: "bad_headcount", text: token } };
  }
  return { ok: true, rest: text.slice(0, m.index).trim(), headcount: n };
}

function parseBookRest(
  rest: string,
  day: DayWord | null,
  start: ClockTime | null,
  end: ClockTime | null,
  quotes: string[],
  shift: string | null,
): ParseResult {
  const hc = extractHeadcount(rest);
  if (!hc.ok) return { ok: false, failure: hc.failure };
  const middle = hc.rest;

  if (middle.trim() === "") return { ok: false, failure: { kind: "no_product" } };

  const pieces = splitProductPlaces(middle);
  if (pieces.length === 0) return { ok: false, failure: { kind: "no_product" } };
  if (pieces.length === 1) return { ok: false, failure: { kind: "no_place" } };

  // S50 (brief §2 item 3): book has no operator field, so only the FIRST
  // PLACE segment (pieces[1]) can list more than one item.
  const placeList = detectAndList(pieces[1], false);
  if (placeList.kind === "bad")
    return { ok: false, failure: { kind: "bad_list", text: pieces[1] } };

  if (placeList.kind === "list") {
    const commands = placeList.items.map((pl) => ({
      intent: "book" as const,
      product: restoreQuotes(pieces[0], quotes),
      place: [pl, ...pieces.slice(2)].map((p) => restoreQuotes(p, quotes)),
      headcount: hc.headcount,
      day,
      start,
      end,
      existing: null,
      shift,
    }));
    return { ok: true, command: { intent: "several", commands } };
  }

  const product = restoreQuotes(pieces[0], quotes);
  const place = pieces.slice(1).map((p) => restoreQuotes(p, quotes));

  return {
    ok: true,
    command: {
      intent: "book",
      product,
      place,
      headcount: hc.headcount,
      day,
      start,
      end,
      existing: null,
      shift,
    },
  };
}

/**
 * S41-b: the unassign grammar's time clause is OPTIONAL and `from` doubles
 * as the operator/place preposition (brief §3), so this is its own
 * extraction rather than `parseTimeAndDay`'s (mandatory-time-clause) one:
 * take the LAST "from" in `text`; if what follows it parses as
 * `<time> <sep> <time>`, that is the time clause; otherwise there is no time
 * clause at all and `text` is returned unchanged (never `no_time`).
 */
function extractOptionalTimeClause(text: string):
  | {
      ok: true;
      rest: string;
      span: { start: ClockTime; end: ClockTime } | null;
      /** F-133: a day word read off the end of `text`, AFTER this clause's
       *  own hours -- `null` when none was found (or none committed; see
       *  `extractTrailingDay`). The caller merges it with whatever day it
       *  finds on its own, leading side. */
      trailingDay: DayWord | null;
      trailingWord: string | null;
    }
  | { ok: false; failure: ParseFailure } {
  // F-133: try a trailing day word first, gated on the SAME shape check
  // this function's own time-clause search below uses.
  const trailing = extractTrailingDay(text, endsWithFromClauseShape);
  if (!trailing.ok) return trailing;
  const workText = trailing.rest;

  const fromRe = /\bfrom\b/gi;
  let lastFrom = -1;
  let fm: RegExpExecArray | null;
  while ((fm = fromRe.exec(workText)) !== null) {
    lastFrom = fm.index;
  }
  if (lastFrom === -1)
    return { ok: true, rest: text, span: null, trailingDay: null, trailingWord: null };

  const beforeFrom = workText.slice(0, lastFrom).trim();
  const timeClauseText = workText.slice(lastFrom + "from".length).trim();
  const timeMatch = timeClauseText.match(/^(.+?)\s+(to|-|–|until|till)\s+(.+)$/i);
  if (!timeMatch)
    return { ok: true, rest: text, span: null, trailingDay: null, trailingWord: null };
  const [, startRaw, , endRaw] = timeMatch;

  // S55 (RM7/EV8 -- fix): a syntactic "X sep Y" shape whose OWN start token
  // is not a time at all ("Cell 1 until 2": "until" is really the removal
  // grammar's lone-edge word, or a place text's own stray "to") is not this
  // clause -- reverts exactly like "no timeMatch" above, so the caller can
  // try the lone-edge span or its own day-word fallback instead of a hard
  // `bad_time`. An invalid END token (the START having parsed as real time)
  // stays a hard failure, unchanged -- U4's own pin.
  const start = parseTimeToken(startRaw);
  if (!start) return { ok: true, rest: text, span: null, trailingDay: null, trailingWord: null };
  // F-146: an END spelled "midnight"/"12 am"/"24:00" writes DAY_END instead
  // of `bad_time`/`time_order` (`resolveEndAgainstStart`).
  const endResult = resolveEndAgainstStart(start, endRaw);
  if (!endResult.ok) {
    return endResult.failure === "bad_time"
      ? { ok: false, failure: { kind: "bad_time", text: endRaw.trim() } }
      : { ok: false, failure: { kind: "time_order" } };
  }
  const adjustedEnd = endResult.end;

  return {
    ok: true,
    rest: beforeFrom,
    span: {
      start: { hour: start.hour, minute: start.minute },
      end: adjustedEnd,
    },
    trailingDay: trailing.day,
    trailingWord: trailing.word,
  };
}

/** S41-b: splits "<operator> (from|off|on|at) <place>..." on the FIRST of
 *  those four words (brief §3) -- the unassign grammar's own operator/place
 *  separator set (wider than assign's, which has no "off"). */
function splitOperatorPlaces(text: string): { operator: string; placesText: string } {
  const sepMatch = text.match(/\bfrom\b|\boff\b|\bon\b|\bat\b/i);
  if (!sepMatch || sepMatch.index === undefined) {
    return { operator: text.trim(), placesText: "" };
  }
  return {
    operator: text.slice(0, sepMatch.index).trim(),
    placesText: text.slice(sepMatch.index + sepMatch[0].length).trim(),
  };
}

/** R-407 (S55): the words that canonicalize to `EVERYONE` on a removal or a
 *  move, whichever was said (EV4-EV6/EV9). Never applied on an assign or a
 *  booking (EV10): those never call this. */
const EVERYONE_ALIASES = new Set(["everyone", "everybody", "all"]);

/**
 * Reviewer fix (S55 review): every call site used to be
 * `canonicalizeEveryone(restoreQuotes(raw, quotes))` -- checking the alias
 * set AFTER the quote placeholder had already been swapped back for its
 * real words. That reads a QUOTED person named "Everyone" (the brief's own
 * probe: 'remove "Everyone" from Cell 1' means a specific person, the whole
 * point of quoting the word) as the reserved operator instead -- the same
 * bug the "quoted names still atomic" rule (WO7) exists to prevent
 * everywhere else in this file. Checked here, on the RAW sentineled text,
 * before restoration: a quoted name's placeholder never spells "everyone"
 * itself, so only a truly unquoted alias ever canonicalizes.
 */
function canonicalizeEveryoneRaw(raw: string, quotes: string[]): string {
  return EVERYONE_ALIASES.has(raw.trim().toLowerCase()) ? EVERYONE : restoreQuotes(raw, quotes);
}

/** R-405 (S55): "until"/"till" followed by a DAY word (never a time -- a day
 *  word and a clock token never look alike) is the removal grammar's own
 *  trailing clause, `UnassignCommand.until` (AB4-AB6/AB8's shape, but legal
 *  on the ordinary verb-led grammar too -- AB9's round trip needs
 *  `parseUnassignRest` to read back what its own `formatCommand` prints).
 *  Tried BEFORE the ordinary day-word extraction below, since a bare
 *  trailing "Friday" would otherwise be read as the sentence's OWN day. */
const UNTIL_DAY_RE = new RegExp(
  `\\s+(?:until|till)\\s+(today|tomorrow|yesterday|${WEEKDAY_ALTS}|\\d{4}-\\d{2}-\\d{2})\\s*$`,
  "i",
);

/**
 * R-404 (S55, D130 item 3): a lone edge on the removal grammar -- "after 2
 * pm" is 14:00 to `DAY_END`, "before 2"/"until 2" is 00:00 to the edge.
 * Tried only once the paired "from X to Y" search has found nothing, so it
 * never competes with an ordinary "from 10 until 2" pair (there "until" is
 * already the pair's own separator word).
 *
 * RM6's decision: a bare hour under 7 with no explicit am/pm reads as PM --
 * the same "workday" instinct the paired afternoon rule already encodes
 * (`applyAfternoonRule`), so "before 2" is 14:00, never the literal 02:00. A
 * decision, not a fact (CLAUDE.md §4, "never guess" -- but a choice IS made
 * and pinned here, exactly the way F-134's own afternoon rule was); written
 * up in the brief report for the maintainer.
 */
const LONE_EDGE_RE = new RegExp(`\\s+(after|before|until)\\s+(${TIME_TOKEN_INLINE})\\s*$`, "i");

function applyLoneEdgeRule(t: {
  hour: number;
  minute: number;
  explicitMeridiem: boolean;
}): ClockTime {
  if (!t.explicitMeridiem && t.hour >= 1 && t.hour < 7) {
    return { hour: t.hour + 12, minute: t.minute };
  }
  return { hour: t.hour, minute: t.minute };
}

/** Tries the lone-edge clause described above; `null` when `text` does not
 *  end with one, or the token after after/before/until is not a valid time
 *  (in which case the caller's own "no_time"/normal reading is unaffected). */
function extractLoneEdgeSpan(
  text: string,
): { rest: string; span: { start: ClockTime; end: ClockTime } } | null {
  const m = text.match(LONE_EDGE_RE);
  if (!m) return null;
  const token = parseTimeToken(m[2]);
  if (!token) return null;
  const edge = applyLoneEdgeRule(token);
  const rest = removeMatch(text, m);
  if (m[1].toLowerCase() === "after") {
    return { rest, span: { start: edge, end: DAY_END } };
  }
  return { rest, span: { start: { hour: 0, minute: 0 }, end: edge } };
}

/**
 * S41-b: "unassign <op> from <cell> [in <line>] [on <day>] [from <time> to
 * <time>]" (brief §3). `rest` is the text after the verb has been stripped.
 *
 * S50 (brief §2 item 1, R-398): `from` is both the place preposition AND
 * the time clause's own word -- `extractOptionalTimeClause` above already
 * took the LAST `from` for the hours, so when the operator segment left
 * behind is the WHOLE rest (no `from`/`off`/`on`/`at` left to split it on),
 * `placesText` is `""` and that is the new empty place ("wherever the
 * person is", S49), never `no_place` -- UNLESS the operator segment is
 * itself empty ("remove" alone, or "remove from Cell 1" with no operator at
 * all), which is still `empty`, checked first, unchanged.
 *
 * S55 adds: R-404's boundary/time-of-day shift clause (`ALL_DAY` reads as
 * nothing at all and is dropped); the `until <day>` clause above; the
 * lone-edge span above; and R-407's `EVERYONE` reading -- explicit
 * (everyone/everybody/all, canonicalized whichever separator introduced a
 * place) or IMPLICIT: `verb === "clear"` with no operator/place separator at
 * all reads the whole remaining text as PLACE, not a person (EV1-EV3; `verb`
 * is `null` for every other caller so the flip only ever applies there).
 */

/**
 * Reviewer fix (S55 review): `extractOptionalTimeClause`'s own lenient
 * fallback (added for RM7/EV8) reverts to "no time clause found" whenever a
 * "from X <sep> Y" shape's START token is not a time -- but leaves that
 * whole clause sitting in `rest`, unconsumed, verbatim. Every OTHER caller
 * of the fallback (the lone-edge span, a trailing day word, the move
 * grammar's own destination split) then has a real chance to explain what
 * is left; when none of them does, the clause survives into an OPERATOR or
 * PLACE word instead of failing -- found by "remove Sam from Cell 1 from
 * Monday to Tuesday" silently reading place "Cell 1 from Monday to", day
 * Tuesday (it used to fail `bad_time`, before the fallback). `from` is
 * already a reserved preposition nowhere legitimate inside an unquoted
 * name in this grammar (`splitOperatorPlaces`/`splitProductPlaces` never
 * split on it on purpose -- it is the time clause's own word) -- its
 * survival here is proof a clause was found and never resolved, not that
 * the words were ordinary text. Checked on the pieces BEFORE `restoreQuotes`
 * runs, so a quoted name that happens to contain the word "from" (a real
 * place called "Building From The Sea") is unaffected -- its literal text
 * never reaches this check because it is still a placeholder token here.
 */
function hasStrayFromWord(...words: string[]): boolean {
  return words.some((w) => /\bfrom\b/i.test(w));
}

function parseUnassignRest(
  rest: string,
  quotes: string[],
  verb: string | null = null,
): ParseResult {
  // R-402/R-404: the shift/boundary/time-of-day clause, read before the
  // (optional) time clause and the places -- "for shift 1" on a removal
  // means span null, shift "1", never hours to compute. `ALL_DAY` reads as
  // nothing at all (R-404's amendment) -- dropped, never stored.
  const boundary = extractShiftOrBoundaryClause(rest, quotes);
  const shift = boundary.isAllDay ? null : boundary.shift;
  rest = boundary.rest;
  const impliedDay = boundary.impliedDay;
  const impliedDayWord = boundary.impliedDayWord;

  // R-405: the removal grammar's own `until <day>` clause, tried before any
  // day-word or time-clause reading of the rest of the sentence.
  let until: DayWord | null = null;
  const untilMatch = rest.match(UNTIL_DAY_RE);
  if (untilMatch) {
    const parsed = parseDayOrWeekToken(untilMatch[1]);
    if (parsed === null || isWeekKind(parsed)) {
      return { ok: false, failure: { kind: "bad_day", text: untilMatch[1] } };
    }
    until = parsed;
    rest = removeMatch(rest, untilMatch);
  }

  const tc = extractOptionalTimeClause(rest);
  if (!tc.ok) return tc;
  if (shift !== null && tc.span !== null) {
    return { ok: false, failure: { kind: "shift_and_hours" } };
  }

  // R-404: a lone edge ("after 2 pm", "before 2") once the paired search
  // above has found nothing.
  let span = tc.span;
  let afterSpan = tc.rest;
  if (span === null) {
    const loneEdge = extractLoneEdgeSpan(afterSpan);
    if (loneEdge) {
      span = loneEdge.span;
      afterSpan = loneEdge.rest;
    }
  }

  const dayResult = extractDayWord(afterSpan);
  if (!dayResult.ok) return dayResult;

  // F-133: merge the leading day (dayResult) with the trailing one
  // `extractOptionalTimeClause` may have read off the end of the hours, and
  // (R-405) with any day a time-of-day clause fixed.
  const merged = mergeDay(
    { day: dayResult.day, word: dayResult.word },
    { day: tc.trailingDay, word: tc.trailingWord },
  );
  if (!merged.ok) return merged;
  const mergedWithTod = mergeDay(
    { day: impliedDay, word: impliedDayWord },
    { day: merged.day, word: dayResult.word ?? tc.trailingWord },
  );
  if (!mergedWithTod.ok) return mergedWithTod;
  const day = mergedWithTod.day;

  const { operator: operatorPart, placesText } = splitOperatorPlaces(dayResult.rest);
  if (operatorPart === "") return { ok: false, failure: { kind: "empty" } };

  // R-407: "clear <place...>" with no operator/place separator at all (so
  // `placesText` is empty) reads as EVERYONE clearing that place, UNLESS
  // `operatorPart` is itself already one of the explicit EVERYONE words
  // (EV9's "clear everyone" stays the ordinary explicit reading, place []).
  // Every other unassign verb keeps the S50 reading unchanged (L1: "remove
  // Operator A3" is still a person's name, place []).
  let placeText = placesText;
  let isEveryoneClear = false;
  if (
    verb === "clear" &&
    placesText === "" &&
    operatorPart !== "" &&
    !EVERYONE_ALIASES.has(operatorPart.trim().toLowerCase())
  ) {
    placeText = operatorPart;
    isEveryoneClear = true;
  }

  const pieces = placeText === "" ? [] : splitProductPlaces(placeText);
  if (pieces.length === 0 && placeText !== "") return { ok: false, failure: { kind: "no_place" } };

  // Reviewer fix (S55 review): see `hasStrayFromWord`'s own comment above.
  if (hasStrayFromWord(operatorPart, placeText)) {
    return { ok: false, failure: { kind: "bad_time", text: placeText || operatorPart } };
  }

  if (isEveryoneClear) {
    return {
      ok: true,
      command: {
        intent: "unassign",
        operator: EVERYONE,
        place: pieces.map((p) => restoreQuotes(p, quotes)),
        day,
        span,
        existing: null,
        shift,
        until,
      },
    };
  }

  // S50 (brief §2 item 3): the OPERATOR segment may list more than one name.
  const operatorList = detectAndList(operatorPart, true);
  if (operatorList.kind === "bad")
    return { ok: false, failure: { kind: "bad_list", text: operatorPart } };

  if (operatorList.kind === "list") {
    const commands = operatorList.items.map((op) => ({
      intent: "unassign" as const,
      operator: canonicalizeEveryoneRaw(op, quotes),
      place: pieces.map((p) => restoreQuotes(p, quotes)),
      day,
      span,
      existing: null,
      shift,
      until,
    }));
    return { ok: true, command: { intent: "several", commands } };
  }

  const operator = canonicalizeEveryoneRaw(operatorPart, quotes);
  const place = pieces.map((p) => restoreQuotes(p, quotes));

  return {
    ok: true,
    command: {
      intent: "unassign",
      operator,
      place,
      day,
      span,
      existing: null,
      shift,
      until,
    },
  };
}

/**
 * S41-c: like `extractOptionalTimeClause` but anchored on "to" instead of
 * "from" -- the move grammar's time clause when the sentence gave no
 * "from"-led hours ("move Sam on Cell 1 in Line 1 to 10 to 3"). Tries the
 * LAST standalone "to" whose suffix parses as `<time> <sep> <time>`, scanning
 * from the end of the string backwards: the pair's own separator word in "to
 * 10 to 3" (the inner "to" between 10 and 3) has only "3" after it, which
 * never matches the pair pattern, so the search naturally continues one "to"
 * further back to the clause's real leading word.
 */
function extractToTimeClause(text: string):
  | {
      ok: true;
      rest: string;
      span: { start: ClockTime; end: ClockTime } | null;
      /** F-133, same as `extractOptionalTimeClause`'s own field. */
      trailingDay: DayWord | null;
      trailingWord: string | null;
    }
  | { ok: false; failure: ParseFailure } {
  // F-133: try a trailing day word first, gated on THIS function's own
  // "to <time> to <time>" shape.
  const trailing = extractTrailingDay(text, endsWithToClauseShape);
  if (!trailing.ok) return trailing;
  const workText = trailing.rest;

  const toRe = /\bto\b/gi;
  const positions: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = toRe.exec(workText)) !== null) positions.push(m.index);

  for (let i = positions.length - 1; i >= 0; i--) {
    const idx = positions[i];
    const before = workText.slice(0, idx).trim();
    const suffix = workText.slice(idx + 2).trim(); // "to" is always 2 chars
    const timeMatch = suffix.match(/^(.+?)\s+(to|-|–|until|till)\s+(.+)$/i);
    if (!timeMatch) continue;
    const [, startRaw, , endRaw] = timeMatch;

    const start = parseTimeToken(startRaw);
    if (!start) return { ok: false, failure: { kind: "bad_time", text: startRaw.trim() } };
    // F-146: an END spelled "midnight"/"12 am"/"24:00" writes DAY_END.
    const endResult = resolveEndAgainstStart(start, endRaw);
    if (!endResult.ok) {
      return endResult.failure === "bad_time"
        ? { ok: false, failure: { kind: "bad_time", text: endRaw.trim() } }
        : { ok: false, failure: { kind: "time_order" } };
    }
    const adjustedEnd = endResult.end;

    return {
      ok: true,
      rest: before,
      span: {
        start: { hour: start.hour, minute: start.minute },
        end: adjustedEnd,
      },
      trailingDay: trailing.day,
      trailingWord: trailing.word,
    };
  }
  return { ok: true, rest: text, span: null, trailingDay: null, trailingWord: null };
}

/** S41-c: splits "<operator> (on|at|from) <place>..." on the FIRST of those
 *  three words (brief §3) -- the move grammar's own operator/place
 *  separator set (no "off": that word belongs to the unassign grammar only). */
function splitMoveOperatorPlaces(text: string): { operator: string; placesText: string } {
  const sepMatch = text.match(/\bon\b|\bat\b|\bfrom\b/i);
  if (!sepMatch || sepMatch.index === undefined) {
    return { operator: text.trim(), placesText: "" };
  }
  return {
    operator: text.slice(0, sepMatch.index).trim(),
    placesText: text.slice(sepMatch.index + sepMatch[0].length).trim(),
  };
}

/** S50/R-398: splits `text` on the FIRST " to " (word-bounded,
 *  case-insensitive) into a before/after pair -- shared by `parseMoveRest`'s
 *  two branches (a named current place, or none) so a destination clause
 *  reads identically wherever the split happens. `after` is `null` when
 *  there is no " to " in `text` at all. */
function splitOnFirstTo(text: string): { before: string; after: string | null } {
  const toMatch = text.match(/\s+to\s+/i);
  if (!toMatch || toMatch.index === undefined) return { before: text, after: null };
  return {
    before: text.slice(0, toMatch.index).trim(),
    after: text.slice(toMatch.index + toMatch[0].length).trim(),
  };
}

/**
 * S41-c: "move <op> (on|at|from) <place> [to <place>] [on <day>] [<hours>]"
 * (brief §3). `rest` is the text after the verb has been stripped.
 *
 * Read back to front for the TIME clause (try a trailing "from <time> to
 * <time>" first, then a trailing "to <time> to <time>") -- that always sits
 * at the very end, whichever order the day word and the destination came in.
 * The day word does NOT: the brief's own worked example ("move Sam at Cell 1
 * on tomorrow to Cell 2") puts it BEFORE the destination clause, so day
 * extraction happens per PLACE SEGMENT rather than off the string's tail --
 * split operator from place text first (first on/at/from), split the place
 * text on the FIRST " to " into current/new, then try the day word at the
 * end of the CURRENT segment, falling back to the end of the NEW segment
 * (the order the grammar's own brackets list it in) when the current one
 * carries none.
 *
 * S50 (brief §2 item 2, R-398): when `splitMoveOperatorPlaces` finds NO
 * `on`/`at`/`from` at all, the sentence named no CURRENT place ("move A3 to
 * 8 pm to 11 pm", "move A3 to Cell 2", "move A3 tomorrow") -- `place` is
 * `[]` (S49: wherever the person is), never `no_place`. The OPERATOR
 * SEGMENT ITSELF may still carry a DESTINATION clause the time-clause
 * helpers above did not already consume (a new CELL, never a bare pair of
 * times -- `extractToTimeClause` always takes those first, greedily, from
 * the end): split it on the FIRST " to " -- the exact same word, and the
 * exact same `splitOnFirstTo` call, the placed branch below splits its OWN
 * place text on -- into the operator and that destination; with no " to "
 * at all, the whole segment is the operator and there is no destination.
 * The day word may sit on either side of that split, tried in the same
 * current-then-new order as the placed branch (`extractDayWord` on the
 * "before" half first, since that is where the operator itself lives, then
 * the "after" half) -- never on both (F-133's own rule, `mergeDay` below).
 */
function parseMoveRest(rest: string, quotes: string[]): ParseResult {
  // R-402/R-404: the shift clause -- an ordinary name, a boundary, or a
  // time-of-day word. R-404's amendment: `ALL_DAY` on a move means the same
  // as saying nothing at all -- read it and drop it (a move needs a new cell
  // or new hours; "all day" is neither). A captured boundary start (R-404's
  // other amendment, assign/book only) has nowhere to go on a move -- there
  // is no `start` field beside `span` -- so it is read and dropped the same
  // way `ALL_DAY` is.
  const boundary = extractShiftOrBoundaryClause(rest, quotes);
  const shift = boundary.isAllDay ? null : boundary.shift;
  rest = boundary.rest;
  const impliedDay = boundary.impliedDay;
  const impliedDayWord = boundary.impliedDayWord;

  const fromClause = extractOptionalTimeClause(rest);
  if (!fromClause.ok) return fromClause;
  let afterTime = fromClause.rest;
  let span = fromClause.span;
  let trailingDay = fromClause.trailingDay;
  let trailingWord = fromClause.trailingWord;
  if (span === null) {
    const toClause = extractToTimeClause(afterTime);
    if (!toClause.ok) return toClause;
    afterTime = toClause.rest;
    span = toClause.span;
    trailingDay = toClause.trailingDay;
    trailingWord = toClause.trailingWord;
  }

  const { operator: operatorPart, placesText } = splitMoveOperatorPlaces(afterTime);
  if (operatorPart === "") return { ok: false, failure: { kind: "empty" } };

  let operator: string;
  let day: DayWord | null = null;
  let dayWord: string | null = null;
  let placePieces: string[];
  let toPlaceText: string | null;

  if (placesText === "") {
    // S50 place-less branch (see the function comment above).
    const split = splitOnFirstTo(operatorPart);
    const dayBefore = extractDayWord(split.before);
    if (!dayBefore.ok) return dayBefore;
    if (dayBefore.day !== null) {
      day = dayBefore.day;
      dayWord = dayBefore.word;
      operator = dayBefore.rest;
      toPlaceText = split.after;
    } else if (split.after !== null) {
      const dayAfter = extractDayWord(split.after);
      if (!dayAfter.ok) return dayAfter;
      day = dayAfter.day;
      dayWord = dayAfter.word;
      operator = split.before;
      toPlaceText = dayAfter.rest;
    } else {
      operator = split.before;
      toPlaceText = null;
    }
    if (operator === "") return { ok: false, failure: { kind: "empty" } };
    placePieces = [];
  } else {
    operator = operatorPart;
    // The FIRST " to " splits the current place(s) from the new place(s) --
    // never the last, since a qualifier never uses "to" (on/at/in/comma only).
    const split = splitOnFirstTo(placesText);
    let placeText = split.before;
    toPlaceText = split.after;

    const dayInCurrent = extractDayWord(placeText);
    if (!dayInCurrent.ok) return dayInCurrent;
    if (dayInCurrent.day !== null) {
      day = dayInCurrent.day;
      dayWord = dayInCurrent.word;
      placeText = dayInCurrent.rest;
    } else if (toPlaceText !== null) {
      const dayInNew = extractDayWord(toPlaceText);
      if (!dayInNew.ok) return dayInNew;
      day = dayInNew.day;
      dayWord = dayInNew.word;
      toPlaceText = dayInNew.rest;
    }

    const pieces = splitProductPlaces(placeText);
    if (pieces.length === 0) return { ok: false, failure: { kind: "no_place" } };
    placePieces = pieces;
  }

  // R-401: a trailing possessive timing tail on the operator segment ("A3's
  // timing", "a3s timing", "Sam's hours") names the person -- the resolver
  // has no timing to look up. Only the move grammar strips this.
  operator = operator.replace(POSSESSIVE_TIMING_TAIL_RE, "").trim();

  // F-133: merge with the trailing day either time-clause helper may have
  // read off the end of the hours.
  const merged = mergeDay({ day, word: dayWord }, { day: trailingDay, word: trailingWord });
  if (!merged.ok) return merged;
  day = merged.day;

  // R-405 (D130 item 7): merge with a day a time-of-day clause fixed
  // ("this afternoon" -> today) -- never a guess (F-133's own rule).
  const mergedWithTod = mergeDay(
    { day: impliedDay, word: impliedDayWord },
    { day, word: dayWord ?? trailingWord },
  );
  if (!mergedWithTod.ok) return mergedWithTod;
  day = mergedWithTod.day;

  // Nit fix (S50 review): a doubled "to" ("move Sam to to Cell 2", or the
  // placed "move Sam on Cell 1 to to Cell 2") leaves a stray leading "to" on
  // the destination text -- splitting on the FIRST " to " cannot itself see
  // a second one right behind it. Stripped here, once, for both branches.
  if (toPlaceText !== null) {
    toPlaceText = toPlaceText.replace(/^to\s+/i, "");
  }

  const toPieces = toPlaceText !== null ? splitProductPlaces(toPlaceText) : [];
  const toPlace =
    toPlaceText !== null && toPieces.length > 0
      ? toPieces.map((p) => restoreQuotes(p, quotes))
      : null;

  // R-402: the sentence named both a shift and hours -- never a guess which wins.
  if (shift !== null && span !== null) {
    return { ok: false, failure: { kind: "shift_and_hours" } };
  }

  // R-389, widened by R-402: at least one of "a new cell" / "new hours" must
  // be said -- a shift's name stands in for the new hours (a move in time).
  if (toPlace === null && span === null && shift === null) {
    return { ok: false, failure: { kind: "no_move" } };
  }

  // S50 (brief §2 item 3): the OPERATOR segment may list more than one name.
  const operatorList = detectAndList(operator, true);
  if (operatorList.kind === "bad")
    return { ok: false, failure: { kind: "bad_list", text: operator } };

  if (operatorList.kind === "list") {
    const place = placePieces.map((p) => restoreQuotes(p, quotes));
    const commands = operatorList.items.map((op) => ({
      intent: "move" as const,
      operator: canonicalizeEveryoneRaw(op, quotes),
      place,
      toPlace,
      day,
      span,
      existing: null,
      shift,
      adjust: null,
    }));
    return { ok: true, command: { intent: "several", commands } };
  }

  // R-407: "everyone"/"everybody"/"all" canonicalize to the one reserved
  // spelling -- EV7/EV8 (a move never gets the "clear"-style implicit-place
  // reading; that is the removal grammar's own thing, R-407's other half).
  const finalOperator = canonicalizeEveryoneRaw(operator, quotes);
  const place = placePieces.map((p) => restoreQuotes(p, quotes));

  return {
    ok: true,
    command: {
      intent: "move",
      operator: finalOperator,
      place,
      toPlace,
      day,
      span,
      existing: null,
      shift,
      adjust: null,
    },
  };
}

// ---------------------------------------------------------------------------
// S58 (docs/agent-briefs/s58-a-grammar-brief.md, R-412, design §19.103/D132
// item 1): a re-time by one edge -- two doors to the same `Adjust` field.
// `tryMoveEdgeAdjust` is the possessive-edge-tail door ("move Sam's start to
// 9"), tried by `parseCommand` right after `MOVE_VERBS` strips its own verb,
// before the ordinary `parseMoveRest` ever runs. `parseAdjustRest` is the
// dedicated-verb door ("extend Sam's block by an hour"), dispatched on its
// own five-verb list (`ADJUST_VERBS`).
// ---------------------------------------------------------------------------

/** One inline clock-time token, or "noon"/"midnight" -- `parseTimeToken`
 *  already reads both specially; this just lets the adjust regexes below
 *  spot one without needing digits. */
const ADJUST_TIME_ALT = `(?:noon|midnight|${TIME_TOKEN_INLINE})`;

/** R-412: "to <time>", captured with whatever comes after it (AJ16's own
 *  destination check reads group 2: non-empty means the sentence tried to
 *  carry a destination too, which an adjust never does). */
const ADJUST_AT_DEST_RE = new RegExp(`^to\\s+(${ADJUST_TIME_ALT})\\s*(.*)$`, "i");

/**
 * S58 (R-412, brief §1 AJ12-AJ16): tries the possessive-edge-tail form of an
 * adjust on the MOVE grammar's own `rest` (already past its verb). `null`
 * when `rest` carries no such tail at all -- the quoted-name escape (see
 * `POSSESSIVE_EDGE_TAIL_RE`'s own comment) falls out of this for free, since
 * the regex then finds nothing and the caller runs the ordinary
 * `parseMoveRest` unchanged.
 */
/**
 * Reviewer fix (S58 review): the possessive-edge-tail door had no place
 * clause at all -- "move Sam's end to 3 pm on Cell 1" fell into the
 * destination check below and failed `bad_adjust` naming "on Cell 1" as
 * though it were a second destination, even though the dedicated-verb door
 * (`parseAdjustRest`) already supports a place clause on the very same field
 * (AJ3: "lengthen Sam on Cell 1 by 2 hours today"). `leftover` is whatever
 * text remains after the "to <time>"/"by <duration>"/"<duration>
 * earlier|later" clause is read off; `""` is fine (no place), a leading
 * on/at/from is a place clause, anything else (AJ16's "to Cell 2") is still
 * the destination violation R-412 refuses.
 */
function adjustPlaceFromLeftover(
  leftover: string,
  quotes: string[],
): { ok: true; place: string[] } | { ok: false; failure: ParseFailure } {
  const t = leftover.trim();
  if (t === "") return { ok: true, place: [] };
  const m = t.match(/^(?:on|at|from)\s+(.+)$/i);
  if (!m) return { ok: false, failure: { kind: "bad_adjust", text: t } };
  return { ok: true, place: splitProductPlaces(m[1]).map((p) => restoreQuotes(p, quotes)) };
}

function tryMoveEdgeAdjust(rest: string, quotes: string[]): ParseResult | null {
  const tailMatch = rest.match(POSSESSIVE_EDGE_TAIL_RE);
  if (!tailMatch || tailMatch.index === undefined) return null;

  const operatorPart = rest.slice(0, tailMatch.index).trim();
  if (operatorPart === "") return { ok: false, failure: { kind: "empty" } };
  const edge: "start" | "end" = tailMatch[1].toLowerCase() === "start" ? "start" : "end";
  const afterEdge = rest.slice(tailMatch.index + tailMatch[0].length);

  const dayResult = extractDayWord(afterEdge);
  if (!dayResult.ok) return dayResult;
  const clauseText = dayResult.rest.trim();

  let adjust: Adjust;
  let leftover = "";
  const toMatch = clauseText.match(ADJUST_AT_DEST_RE);
  if (toMatch) {
    // F-146: an END spelled "midnight"/"12 am"/"24:00" writes DAY_END, the
    // same as every other END position in this file -- a START spelled
    // "midnight" stays the literal {0,0} (`isDayEndSpelling`'s own comment).
    if (edge === "end" && isDayEndSpelling(toMatch[1])) {
      adjust = { edge, at: DAY_END };
    } else {
      const token = parseTimeToken(toMatch[1]);
      if (!token) return { ok: false, failure: { kind: "bad_time", text: toMatch[1].trim() } };
      adjust = { edge, at: applyLoneEdgeRule(token) };
    }
    leftover = toMatch[2];
  } else {
    // Reviewer fix (S58 review): the same lookahead-bounded shape as
    // `parseAdjustRest`'s own "by"/"earlier"/"later" clauses (see its
    // comments) -- a short match is only accepted when a place clause or
    // the end of the clause follows it, so "by an hour and a half" (not a
    // shape `DURATION_VALUE` knows) still fails together instead of
    // matching "an hour" and leaving "and a half" as an unexplained
    // `bad_adjust` leftover. `clauseText` is anchored at `^` here (unlike
    // `parseAdjustRest`'s `text`) because the operator was already sliced
    // off before this function ever built it.
    const byMatch = clauseText.match(
      new RegExp(`^by\\s+(${DURATION_VALUE})(?=\\s*(?:on|at|from)\\b|\\s*$)`, "i"),
    );
    if (byMatch) {
      // AJ14: "a bare 'by' is later" -- always positive, never a sign word.
      const minutes = parseDurationMinutes(byMatch[1]);
      if (minutes === null || minutes === 0) {
        return { ok: false, failure: { kind: "bad_adjust", text: byMatch[1].trim() } };
      }
      adjust = { edge, by: minutes };
      leftover = removeMatch(clauseText, byMatch);
    } else {
      const elMatch = clauseText.match(
        new RegExp(`^(${DURATION_VALUE})\\s+(earlier|later)(?=\\s*(?:on|at|from)\\b|\\s*$)`, "i"),
      );
      if (elMatch) {
        const minutes = parseDurationMinutes(elMatch[1]);
        if (minutes === null || minutes === 0) {
          return { ok: false, failure: { kind: "bad_adjust", text: elMatch[1].trim() } };
        }
        adjust = { edge, by: elMatch[2].toLowerCase() === "earlier" ? -minutes : minutes };
        leftover = removeMatch(clauseText, elMatch);
      } else {
        // Neither bounded form matched -- fall back to the unbounded
        // catch-all (pre-review shape) purely to surface a sensible
        // `bad_adjust` text for genuinely unrecognised trailing text,
        // exactly as `parseAdjustRest`'s own fallback does.
        const rawBy = clauseText.match(/^by\s+(.+)$/i);
        if (rawBy) return { ok: false, failure: { kind: "bad_adjust", text: rawBy[1].trim() } };
        const rawEl = clauseText.match(/^(.+?)\s+(earlier|later)$/i);
        if (rawEl) return { ok: false, failure: { kind: "bad_adjust", text: rawEl[1].trim() } };
        return { ok: false, failure: { kind: "bad_adjust", text: clauseText || edge } };
      }
    }
  }

  const placeResult = adjustPlaceFromLeftover(leftover, quotes);
  if (!placeResult.ok) return placeResult;

  return {
    ok: true,
    command: {
      intent: "move",
      operator: restoreQuotes(operatorPart, quotes),
      place: placeResult.place,
      toPlace: null,
      day: dayResult.day,
      span: null,
      existing: null,
      shift: null,
      adjust,
    },
  };
}

/**
 * S58 (R-412, brief §1 AJ1-AJ11): the dedicated-verb door. `verb` is already
 * lower-cased by the caller. `extend`/`lengthen` always add, `shorten`
 * always subtracts (both need a "by <duration>" clause, trailing once the
 * day word is gone -- AJ6/AJ11-style: none found is `bad_adjust`); `end`/
 * `finish` read an "(early) at <time>" clause found ANYWHERE (AJ8: the place
 * clause can follow it) or a trailing "<duration> earlier"/"<duration>
 * later". All five always adjust the END edge -- there is no verb-led door
 * to the START edge (that is `tryMoveEdgeAdjust`'s own, R-412's "two doors").
 */
function parseAdjustRest(verb: string, rest: string, quotes: string[]): ParseResult {
  const dayResult = extractDayWord(rest);
  if (!dayResult.ok) return dayResult;
  let text = dayResult.rest;
  const day = dayResult.day;

  let adjust: Adjust;
  if (verb === "extend" || verb === "lengthen" || verb === "shorten") {
    // Reviewer fix (S58 review): bounded to a recognised duration shape
    // (`DURATION_VALUE`, the same set `parseDurationMinutes` accepts) rather
    // than a greedy `.+$` to the very end of the sentence -- the old regex
    // swallowed a trailing place clause into the duration text and failed
    // `bad_adjust` on the whole lot ("extend Sam by 90 minutes on Cell 1"
    // read "90 minutes on Cell 1" as the duration and refused it). The
    // lookahead only accepts the short match when a place clause or the end
    // of the sentence follows it -- NOT bare `\b`, which would also accept
    // "an hour" as a short match inside "by an hour and a half" and leave
    // "and a half" dangling as part of the operator (a worse bug than the
    // one this fixes: a wrong SUCCESS instead of a clean failure). When the
    // lookahead can't be satisfied, the second, unbounded regex is tried
    // exactly as before this review -- so unrecognised duration text still
    // fails `bad_adjust` as one clause, never a partial match.
    const boundedM = text.match(
      new RegExp(`\\s+by\\s+(${DURATION_VALUE})(?=\\s*(?:on|at|from)\\b|\\s*$)`, "i"),
    );
    const m = boundedM ?? text.match(/\s+by\s+(.+)$/i);
    if (!m) return { ok: false, failure: { kind: "bad_adjust", text: text.trim() || verb } };
    const minutes = parseDurationMinutes(m[1]);
    if (minutes === null || minutes === 0) {
      return { ok: false, failure: { kind: "bad_adjust", text: m[1].trim() } };
    }
    adjust = { edge: "end", by: verb === "shorten" ? -minutes : minutes };
    text = removeMatch(text, m);
  } else {
    // "end"/"finish".
    const atRe = new RegExp(`\\b(?:early\\s+at|at)\\s+(${ADJUST_TIME_ALT})\\b`, "i");
    const atMatch = text.match(atRe);
    if (atMatch) {
      // F-146: an END spelled "midnight"/"12 am"/"24:00" writes DAY_END, the
      // same as every other END position in this file.
      if (isDayEndSpelling(atMatch[1])) {
        adjust = { edge: "end", at: DAY_END };
      } else {
        const token = parseTimeToken(atMatch[1]);
        if (!token) return { ok: false, failure: { kind: "bad_time", text: atMatch[1].trim() } };
        adjust = { edge: "end", at: applyLoneEdgeRule(token) };
      }
      text = removeMatch(text, atMatch);
    } else {
      // Reviewer fix (S58 review): bounded the same way as the "by" clause
      // above (lookahead, with the same unbounded fallback) -- "end Sam an
      // hour earlier on Cell 1" now leaves "on Cell 1" in `text` for the
      // place split below instead of failing to match at all, without
      // risking a short, wrong split of unrecognised duration text.
      const boundedEl = text.match(
        new RegExp(
          `\\s+(${DURATION_VALUE})\\s+(earlier|later)(?=\\s*(?:on|at|from)\\b|\\s*$)`,
          "i",
        ),
      );
      const elMatch = boundedEl ?? text.match(/\s+(.+?)\s+(earlier|later)$/i);
      if (!elMatch) {
        return { ok: false, failure: { kind: "bad_adjust", text: text.trim() || verb } };
      }
      const minutes = parseDurationMinutes(elMatch[1]);
      if (minutes === null || minutes === 0) {
        return { ok: false, failure: { kind: "bad_adjust", text: elMatch[1].trim() } };
      }
      adjust = { edge: "end", by: elMatch[2].toLowerCase() === "earlier" ? -minutes : minutes };
      text = removeMatch(text, elMatch);
    }
  }

  const { operator: opPart, placesText } = splitMoveOperatorPlaces(text);
  const operator = opPart.replace(POSSESSIVE_BLOCK_TAIL_RE, "").trim();
  if (operator === "") return { ok: false, failure: { kind: "empty" } };
  const place =
    placesText === "" ? [] : splitProductPlaces(placesText).map((p) => restoreQuotes(p, quotes));

  return {
    ok: true,
    command: {
      intent: "move",
      operator: restoreQuotes(operator, quotes),
      place,
      toPlace: null,
      day,
      span: null,
      existing: null,
      shift: null,
      adjust,
    },
  };
}

// ---------------------------------------------------------------------------
// S58 (R-413, brief §2 SP1-SP5, design §19.103/D132 item 2): "split Sam's
// block at noon" -- a shorten plus an assign, written by the board
// (`resolve.ts`'s own `expandCommand`); the grammar only needs the block
// (operator/place/day) and the split point.
// ---------------------------------------------------------------------------

/** R-413: "at <time>", found ANYWHERE (SP2: the place clause can follow it,
 *  same shape as the adjust grammar's own "end"/"finish" at-clause). No
 *  "early" alternative here -- split has no earlier/later reading at all. */
const SPLIT_AT_RE = new RegExp(`\\bat\\s+(${ADJUST_TIME_ALT})\\b`, "i");

function parseSplitRest(rest: string, quotes: string[]): ParseResult {
  const atMatch = rest.match(SPLIT_AT_RE);
  if (!atMatch) return { ok: false, failure: { kind: "no_split_time" } };
  const token = parseTimeToken(atMatch[1]);
  if (!token) return { ok: false, failure: { kind: "bad_time", text: atMatch[1].trim() } };
  // SP3: the same workday rule every other lone edge in this file gets.
  const at = applyLoneEdgeRule(token);
  let text = removeMatch(rest, atMatch);

  const dayResult = extractDayWord(text);
  if (!dayResult.ok) return dayResult;
  text = dayResult.rest;

  const { operator: opPart, placesText } = splitMoveOperatorPlaces(text);
  const operator = opPart.replace(POSSESSIVE_BLOCK_TAIL_RE, "").trim();
  if (operator === "") return { ok: false, failure: { kind: "empty" } };
  const place =
    placesText === "" ? [] : splitProductPlaces(placesText).map((p) => restoreQuotes(p, quotes));

  return {
    ok: true,
    command: {
      intent: "split",
      operator: restoreQuotes(operator, quotes),
      place,
      day: dayResult.day,
      at,
    },
  };
}

// ---------------------------------------------------------------------------
// S58 (R-415, brief §2 HC1-HC9, design §19.103/D132 item 4): a job's
// headcount -- one existing write, never a create, never part of a lot.
// ---------------------------------------------------------------------------

/** Shared by `tryJobHoursAssign` (R-414) and `parseHeadcountRest` (R-415):
 *  "the <product> job"/"the <product> run", non-greedy so a quoted product
 *  (a single opaque token) is captured exactly. */
const JOB_HOURS_PRODUCT_RE = /^the\s+(\S.*?)\s+(?:job|run)\b\s*(.*)$/i;

/** R-415: "<n> people", with an optional leading "to" (HC2's "set ... to 4
 *  people") -- always the sentence's very last clause.
 *
 *  Reviewer fix (S58 review): `(?:^|\s+)` -- not a bare `\s+` -- before the
 *  optional "to"/digits: "make the Housing A job 4 people" (HC-family, no
 *  place at all) has NOTHING before "4 people" to satisfy a required
 *  leading whitespace, so the old pattern never matched, `parseHeadcountRest`
 *  returned `null` (not headcount-shaped) instead of the promised
 *  `no_place`, and the sentence fell through to the ordinary assign
 *  pipeline and failed `no_time` -- a case D132 item 4 explicitly names
 *  ("no place" on a job's headcount). Every existing case still had a place
 *  (or "on"/"at"/"in") word before this clause, so `\s+` still matches
 *  there unchanged; `^` only ever fires on the newly-supported empty case. */
const HEADCOUNT_TRAILING_RE = /(?:^|\s+)(?:to\s+)?(\d+)\s+people\s*$/i;

/**
 * S58 (R-415, brief §2 HC1-HC9): `verb` is already lower-cased ("make" or
 * "set"). Returns `null` -- not a failure -- when `rest` does not name "the
 * <product> job/run" at all and does not start with "it": HC9's own escape,
 * "set Sam on Housing A on Cell 1 8 to 4" is not headcount-shaped, so
 * `parseCommand` falls all the way through to the ordinary assign pipeline,
 * which still has "set" in `ASSIGN_VERBS` (see the R-391 comment's own
 * account of this decision).
 */
function parseHeadcountRest(rest: string, quotes: string[]): ParseResult | null {
  const jobMatch = rest.match(JOB_HOURS_PRODUCT_RE);
  if (!jobMatch) {
    // HC5: "make it 4 people" -- nothing for "it" to name.
    if (/^it\b/i.test(rest.trim())) return { ok: false, failure: { kind: "which_job" } };
    return null;
  }
  const product = restoreQuotes(jobMatch[1], quotes);
  const tail = jobMatch[2];

  const countMatch = tail.match(HEADCOUNT_TRAILING_RE);
  if (!countMatch) return null;
  const n = Number(countMatch[1]);
  if (!Number.isInteger(n) || n < 1 || n > 99) {
    return { ok: false, failure: { kind: "bad_headcount", text: countMatch[1] } };
  }
  let body = tail.slice(0, countMatch.index).trim();
  body = body.replace(/^(?:on|at|in)\s+/i, "");

  const boundary = extractShiftOrBoundaryClause(body, quotes);
  const shift = boundary.isAllDay ? null : boundary.shift;
  body = boundary.rest;

  const tc = extractOptionalTimeClause(body);
  if (!tc.ok) return tc;
  if (shift !== null && tc.span !== null) {
    return { ok: false, failure: { kind: "shift_and_hours" } };
  }
  body = tc.rest;

  const dayResult = extractDayWord(body);
  if (!dayResult.ok) return dayResult;
  const merged = mergeDay(
    { day: dayResult.day, word: dayResult.word },
    { day: tc.trailingDay, word: tc.trailingWord },
  );
  if (!merged.ok) return merged;

  const placeText = dayResult.rest;
  const placePieces = placeText === "" ? [] : splitProductPlaces(placeText);
  if (placePieces.length === 0) return { ok: false, failure: { kind: "no_place" } };

  return {
    ok: true,
    command: {
      intent: "headcount",
      product,
      place: placePieces.map((p) => restoreQuotes(p, quotes)),
      day: merged.day,
      span: tc.span,
      shift,
      headcount: n,
    },
  };
}

// ---------------------------------------------------------------------------
// S58 (R-414, brief §2 JB1-JB7, design §19.103/D132 item 3): "the job's
// hours" -- the ASSIGN grammar only, tried before the mandatory time clause
// (a "the ... job" sentence has no hours of its own to find).
// ---------------------------------------------------------------------------

/**
 * S58 (R-414): mirrors `parseAssignRest`'s own leading-verb/operator split
 * (brief item 3) up to the point where the product would normally be read,
 * then looks for "the <product> job/run" there instead of an hours clause.
 * `null` -- not a failure -- when `norm` does not have that shape at all
 * (JB7: "add Sam to Housing A on Cell 1 8 to 4" falls through to the
 * ordinary assign pipeline, unchanged).
 */
function tryJobHoursAssign(norm: string, quotes: string[]): ParseResult | null {
  let rest = norm;
  const verbMatch = rest.match(new RegExp(`^(${ASSIGN_VERBS.join("|")})\\s+`, "i"));
  if (verbMatch) rest = rest.slice(verbMatch[0].length);

  const sepMatch = rest.match(/ to work on | to | on /i);
  let operatorPart: string;
  let productPlaces: string;
  if (!sepMatch || sepMatch.index === undefined) {
    operatorPart = rest.trim();
    productPlaces = "";
  } else {
    operatorPart = rest.slice(0, sepMatch.index).trim();
    productPlaces = rest.slice(sepMatch.index + sepMatch[0].length).trim();
  }
  if (operatorPart === "" || productPlaces === "") return null;

  const jobMatch = productPlaces.match(JOB_HOURS_PRODUCT_RE);
  if (!jobMatch) return null;
  const product = restoreQuotes(jobMatch[1], quotes);

  let tail = jobMatch[2].trim();
  tail = tail.replace(/^(?:on|at|in)\s+/i, "");

  const dayResult = extractDayWord(tail);
  if (!dayResult.ok) return dayResult;

  // JB4: hours said alongside "the ... job" -- never a guess which wins.
  const tc = extractOptionalTimeClause(dayResult.rest);
  if (!tc.ok) return tc;
  if (tc.span !== null) {
    return { ok: false, failure: { kind: "shift_and_hours" } };
  }

  // Reviewer fix (S58 review): the SAME conflict as JB4's plain hours, said
  // through a duration clause ("for 4 hours") or a named shift/boundary
  // clause ("for shift 2", "this afternoon", "all day") instead -- checked
  // here, now that this function is tried before both of those in
  // `parseCommand` (see the reviewer note at the call site), so neither one
  // gets a chance to swallow "the <product> job" as literal text first. Not
  // itself a hard failure to surface (`extractDurationClause`'s own
  // `bad_duration` is a real syntax problem in the duration, not this
  // conflict) -- the conflict is that a second hours-source was said at all.
  if (extractDurationClause(tc.rest) !== null) {
    return { ok: false, failure: { kind: "shift_and_hours" } };
  }
  if (extractShiftOrBoundaryClause(tc.rest, quotes).shift !== null) {
    return { ok: false, failure: { kind: "shift_and_hours" } };
  }

  const placeText = tc.rest;
  const placePieces = placeText === "" ? [] : splitProductPlaces(placeText);
  if (placePieces.length === 0) return { ok: false, failure: { kind: "no_place" } };

  const operatorList = detectAndList(operatorPart, true);
  if (operatorList.kind === "bad")
    return { ok: false, failure: { kind: "bad_list", text: operatorPart } };
  const placeList = detectAndList(placePieces[0], false);
  if (placeList.kind === "bad")
    return { ok: false, failure: { kind: "bad_list", text: placePieces[0] } };

  if (operatorList.kind === "list" || placeList.kind === "list") {
    const operatorItems = operatorList.kind === "list" ? operatorList.items : [operatorPart];
    const placeItems = placeList.kind === "list" ? placeList.items : [placePieces[0]];
    const combined = combineLists(operatorItems, placeItems, (op, pl) => ({
      intent: "assign" as const,
      operator: restoreQuotes(op, quotes),
      product,
      place: [pl, ...placePieces.slice(1)].map((p) => restoreQuotes(p, quotes)),
      day: dayResult.day,
      start: null,
      end: null,
      attach: null,
      existing: null,
      shift: JOB_HOURS,
    }));
    if (!combined.ok) return combined;
    return { ok: true, command: { intent: "several", commands: combined.items } };
  }

  return {
    ok: true,
    command: {
      intent: "assign",
      operator: restoreQuotes(operatorPart, quotes),
      product,
      place: placePieces.map((p) => restoreQuotes(p, quotes)),
      day: dayResult.day,
      start: null,
      end: null,
      attach: null,
      existing: null,
      shift: JOB_HOURS,
    },
  };
}

/** S55 (R-404): the first word decides assign vs the word-order grammar
 *  (R-405) -- built once, here, so `parseCommand`'s own dispatch and
 *  `tryWordOrder`'s guard read the same list without retyping it. */
const ASSIGN_VERB_RE = new RegExp(`^(${ASSIGN_VERBS.join("|")})\\b\\s*`, "i");

// ---------------------------------------------------------------------------
// R-404 (S55, brief §3 DU1-DU10): a duration clause stands in for the
// mandatory "from X to Y" pair on assign/book.
// ---------------------------------------------------------------------------

const DURATION_VALUE =
  "(?:an\\s+hour|half\\s+an\\s+hour|\\d+\\s+and\\s+a\\s+half\\s+(?:hours?|hrs?)|" +
  "\\d+(?:\\.\\d+)?\\s*(?:hours?|hrs?|minutes?|mins?))";

/** Parses a duration phrase into total minutes; `null` when the unit is not
 *  one this grammar recognises (`hours`/`hrs`/`minutes`/`mins`, the singular
 *  spellings, "an hour", "half an hour", "N and a half hours", a decimal). */
function parseDurationMinutes(raw: string): number | null {
  const t = raw.trim().toLowerCase();
  if (t === "an hour" || t === "an hr") return 60;
  if (t === "half an hour") return 30;
  let m = t.match(/^(\d+)\s+and\s+a\s+half\s+(?:hours?|hrs?)$/);
  if (m) return Number(m[1]) * 60 + 30;
  m = t.match(/^(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)$/);
  if (m) return Math.round(Number(m[1]) * 60);
  m = t.match(/^(\d+(?:\.\d+)?)\s*(?:minutes?|mins?)$/);
  if (m) return Math.round(Number(m[1]));
  return null;
}

/** "from 8 for 4 hours" / "at 8 for an hour" (DU2's own anchor word) -- the
 *  LAST such clause in the sentence, same convention as every other "last
 *  from" search here. Bounded to a recognised duration shape so DU9's SECOND
 *  "for" clause ("for 3 people") is never swallowed by this one. */
const DURATION_CLAUSE_RE = new RegExp(
  `\\b(?:from|at)\\s+(${TIME_TOKEN_INLINE})\\s+for\\s+(${DURATION_VALUE})\\b`,
  "gi",
);

/**
 * DU1-DU9: finds the duration clause, computes the end arithmetically, and
 * never clips a result that runs past midnight (DU7) or accepts a
 * zero-length one (DU8) -- both `bad_duration`. `null` (not a `ParseResult`)
 * when `text` has no such clause at all, so the caller can fall through to
 * the next kind of clause without mistaking "not found" for a failure.
 */
function extractDurationClause(
  text: string,
):
  | null
  | { ok: true; rest: string; start: ClockTime; end: ClockTime }
  | { ok: false; failure: ParseFailure } {
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  DURATION_CLAUSE_RE.lastIndex = 0;
  while ((m = DURATION_CLAUSE_RE.exec(text)) !== null) last = m;
  if (!last) return null;

  const startToken = parseTimeToken(last[1]);
  if (!startToken) return { ok: false, failure: { kind: "bad_time", text: last[1].trim() } };
  const minutes = parseDurationMinutes(last[2]);
  if (minutes === null || minutes === 0) {
    return { ok: false, failure: { kind: "bad_duration", text: last[2].trim() } };
  }
  const startTotal = startToken.hour * 60 + startToken.minute;
  const endTotal = startTotal + minutes;
  if (endTotal > 24 * 60) {
    // DU7: never clipped -- a duration that runs PAST midnight is refused,
    // not silently wrapped to the next day.
    return { ok: false, failure: { kind: "bad_duration", text: last[2].trim() } };
  }
  // F-146: a duration landing EXACTLY on 24:00 ("8 pm for 4 hours") writes
  // DAY_END, the same way an explicit "to midnight" now does -- only a
  // duration that runs past it stays `bad_duration` (the check above).
  if (endTotal === 24 * 60) {
    return {
      ok: true,
      rest: removeMatch(text, last),
      start: { hour: startToken.hour, minute: startToken.minute },
      end: DAY_END,
    };
  }
  return {
    ok: true,
    rest: removeMatch(text, last),
    start: { hour: startToken.hour, minute: startToken.minute },
    end: { hour: Math.floor(endTotal / 60), minute: endTotal % 60 },
  };
}

/**
 * DU10 (the developer's own decision, documented in the brief report): "8 to
 * 4 for 2 hours" with no "from"/"at" to anchor either reading is ambiguous --
 * a bare pair AND a duration both present, nothing says which one is real.
 * Only reached once `extractDurationClause` above has already found nothing
 * (so no "from"/"at"-anchored duration clause exists anywhere in the text),
 * which makes this a plain bare-pair-plus-duration check with nothing to
 * exclude. Reuses `bad_time` (never a new `ParseFailure` kind) since the
 * sentence, read as a whole, is a malformed TIME clause -- two candidate
 * readings, not one clean one missing a duration.
 */
const DURATION_AMBIGUOUS_RE = new RegExp(
  `\\b(${TIME_TOKEN_INLINE})\\s+(?:to|-|–|until|till)\\s+(${TIME_TOKEN_INLINE})\\s+for\\s+${DURATION_VALUE}\\s*$`,
  "i",
);

// ---------------------------------------------------------------------------
// R-405 (S55, brief §3 WO1-WO7): the word-order grammar, and (EV10/WO1/WO3/
// WO5-7) the bare-pair fallback the ordinary assign/book grammar shares it
// with once the mandatory "from X to Y" search has found nothing.
// ---------------------------------------------------------------------------

function endsWithBarePairShape(text: string): boolean {
  return new RegExp(
    `${TIME_TOKEN_INLINE}\\s+(?:to|-|–|until|till)\\s+${TIME_TOKEN_INLINE}\\s*$`,
    "i",
  ).test(text);
}

const BARE_PAIR_TRAILING_RE = new RegExp(
  `^(.*?)\\b(${TIME_TOKEN_INLINE})\\s+(to|-|–|until|till)\\s+(${TIME_TOKEN_INLINE})\\s*$`,
  "i",
);

/**
 * R-405: the word-order grammar's hours need no "from" at all ("Cell 1 runs
 * Housing A 8 to 4") -- and EV10's own pin ("assign everyone to Housing A on
 * Cell 1 8 to 4") shows the ordinary assign/book grammar accepts the SAME
 * bare pair, once the mandatory "from ... to ..." search has found nothing.
 * Never runs when a `from`-led clause exists (unchanged, tried first) or
 * when DU10's own ambiguity check has already refused the sentence (that
 * check runs before this function is ever called).
 */
function parseTimeAndDayOrBare(
  text: string,
):
  | { ok: true; rest: string; day: DayWord | null; start: ClockTime; end: ClockTime }
  | { ok: false; failure: ParseFailure } {
  const withFrom = parseTimeAndDay(text);
  if (withFrom.ok || withFrom.failure.kind !== "no_time") return withFrom;

  const trailing = extractTrailingDay(text, endsWithBarePairShape);
  if (!trailing.ok) return trailing;
  const bareMatch = trailing.rest.match(BARE_PAIR_TRAILING_RE);
  if (!bareMatch) return { ok: false, failure: { kind: "no_time" } };
  const [, before, startRaw, , endRaw] = bareMatch;

  const start = parseTimeToken(startRaw);
  if (!start) return { ok: false, failure: { kind: "bad_time", text: startRaw.trim() } };
  // F-146: an END spelled "midnight"/"12 am"/"24:00" writes DAY_END.
  const endResult = resolveEndAgainstStart(start, endRaw);
  if (!endResult.ok) {
    return endResult.failure === "bad_time"
      ? { ok: false, failure: { kind: "bad_time", text: endRaw.trim() } }
      : { ok: false, failure: { kind: "time_order" } };
  }
  const adjustedEnd = endResult.end;

  const dayResult = extractDayWord(before);
  if (!dayResult.ok) return dayResult;
  const merged = mergeDay(
    { day: dayResult.day, word: dayResult.word },
    { day: trailing.day, word: trailing.word },
  );
  if (!merged.ok) return merged;

  return {
    ok: true,
    rest: dayResult.rest,
    day: merged.day,
    start: { hour: start.hour, minute: start.minute },
    end: adjustedEnd,
  };
}

/** Runs the shared assign/book pipeline (mandatory-or-bare time clause, then
 *  the book-verb check, then the matching rest-parser) on an already
 *  verb-led string -- `parseCommand`'s own final fallback, and `tryWordOrder`
 *  below once it has rewritten a marker sentence into this same shape. */
function parseCanonicalAssign(text: string, quotes: string[]): ParseResult {
  const td = parseTimeAndDayOrBare(text);
  if (!td.ok) return td;

  const bookVerbMatch = td.rest.match(BOOK_VERB_RE);
  if (bookVerbMatch) {
    return parseBookRest(
      td.rest.slice(bookVerbMatch[0].length),
      td.day,
      td.start,
      td.end,
      quotes,
      null,
    );
  }
  return parseAssignRest(td.rest, td.day, td.start, td.end, quotes, null);
}

/** WO3/WO4: "Cell 1 [in Line 1] gets Sam on Housing A 8 to 4" -- the PLACE
 *  comes first, then the person, then "on <product>", then the hours (bare
 *  or "from"-led, `parseTimeAndDayOrBare`). */
function parseWoGets(placeText: string, afterGets: string, quotes: string[]): ParseResult {
  const tt = parseTimeAndDayOrBare(afterGets);
  if (!tt.ok) return tt;

  const sepMatch = tt.rest.match(/\son\s/i);
  if (!sepMatch || sepMatch.index === undefined) {
    return { ok: false, failure: { kind: "no_product" } };
  }
  const operatorPart = tt.rest.slice(0, sepMatch.index).trim();
  const productPart = tt.rest.slice(sepMatch.index + sepMatch[0].length).trim();
  if (operatorPart === "") return { ok: false, failure: { kind: "empty" } };
  if (productPart === "") return { ok: false, failure: { kind: "no_product" } };

  const placePieces = splitProductPlaces(placeText);
  if (placePieces.length === 0) return { ok: false, failure: { kind: "no_place" } };

  return {
    ok: true,
    command: {
      intent: "assign",
      operator: restoreQuotes(operatorPart, quotes),
      product: restoreQuotes(productPart, quotes),
      place: placePieces.map((p) => restoreQuotes(p, quotes)),
      day: tt.day,
      start: tt.start,
      end: tt.end,
      attach: null,
      existing: null,
      shift: null,
    },
  };
}

/** WO5/WO6: "Cell 1 runs Housing A 8 to 4 [with 3 people]" -- a BOOKING,
 *  place first. `extractHeadcount` already accepts "with" as well as "for"
 *  (widened for every book form, brief §3 WO6). */
function parseWoRuns(placeText: string, afterRuns: string, quotes: string[]): ParseResult {
  const hc = extractHeadcount(afterRuns);
  if (!hc.ok) return { ok: false, failure: hc.failure };

  const tt = parseTimeAndDayOrBare(hc.rest);
  if (!tt.ok) return tt;

  const product = tt.rest.trim();
  if (product === "") return { ok: false, failure: { kind: "no_product" } };
  const placePieces = splitProductPlaces(placeText);
  if (placePieces.length === 0) return { ok: false, failure: { kind: "no_place" } };

  return {
    ok: true,
    command: {
      intent: "book",
      product: restoreQuotes(product, quotes),
      place: placePieces.map((p) => restoreQuotes(p, quotes)),
      headcount: hc.headcount,
      day: tt.day,
      start: tt.start,
      end: tt.end,
      existing: null,
      shift: null,
    },
  };
}

/**
 * R-405: tried once the first word matches none of the six verb lists
 * (brief §3: "a sentence whose first word matches no verb list is tried
 * against these before the old 'no verb' assign path"). "gets"/"runs" are
 * PLACE-first (WO3-WO6); "works on"/"is on" are operator-first, rewritten
 * into the ordinary "assign <op> to <rest>" shape and handed to the shared
 * pipeline (`parseCanonicalAssign`) -- the same bare-pair time clause WO1
 * needs and P-series sentences never do. `null` when no marker is found at
 * all, so the caller falls through to the ordinary no-verb assign reading.
 */
function tryWordOrder(norm: string, quotes: string[]): ParseResult | null {
  const getsMatch = norm.match(/^(.+?)\s+gets\s+(.+)$/i);
  if (getsMatch) return parseWoGets(getsMatch[1].trim(), getsMatch[2].trim(), quotes);

  const runsMatch = norm.match(/^(.+?)\s+runs\s+(.+)$/i);
  if (runsMatch) return parseWoRuns(runsMatch[1].trim(), runsMatch[2].trim(), quotes);

  const worksOnMatch = norm.match(/\s+works\s+on\s+/i);
  if (worksOnMatch && worksOnMatch.index !== undefined) {
    const rewritten =
      "assign " +
      norm.slice(0, worksOnMatch.index) +
      " to " +
      norm.slice(worksOnMatch.index + worksOnMatch[0].length);
    return parseCanonicalAssign(rewritten, quotes);
  }

  const isOnMatch = norm.match(/\s+is\s+on\s+/i);
  if (isOnMatch && isOnMatch.index !== undefined) {
    const rewritten =
      "assign " +
      norm.slice(0, isOnMatch.index) +
      " to " +
      norm.slice(isOnMatch.index + isOnMatch[0].length);
    return parseCanonicalAssign(rewritten, quotes);
  }

  return null;
}

// ---------------------------------------------------------------------------
// R-406 (S55, brief §3 RP1-RP7/SW1-SW5): cover/replace and swap/exchange.
// ---------------------------------------------------------------------------

/**
 * RP1-RP6: "cover <op> with <name> [on <place>...] [on <day>] [from <time>
 * to <time>] [for shift <name>]". RP6's decision (documented in the brief
 * report): "cover Sam" with no "with <name>" at all reuses `no_product`
 * ("operator given, nothing after it") -- the closest existing kind, and the
 * literal truth of the sentence (nothing follows the operator that names a
 * replacement).
 */
function parseReplaceRest(rest: string, quotes: string[]): ParseResult {
  const shiftClause = extractShiftClause(rest, quotes);
  const shift = shiftClause.shift;
  rest = shiftClause.rest;

  const tc = extractOptionalTimeClause(rest);
  if (!tc.ok) return tc;
  if (shift !== null && tc.span !== null) {
    return { ok: false, failure: { kind: "shift_and_hours" } };
  }

  const dayResult = extractDayWord(tc.rest);
  if (!dayResult.ok) return dayResult;
  const merged = mergeDay(
    { day: dayResult.day, word: dayResult.word },
    { day: tc.trailingDay, word: tc.trailingWord },
  );
  if (!merged.ok) return merged;

  const withMatch = dayResult.rest.match(/\bwith\b/i);
  if (!withMatch || withMatch.index === undefined) {
    return { ok: false, failure: { kind: "no_product" } };
  }
  const operatorPart = dayResult.rest.slice(0, withMatch.index).trim();
  const afterWith = dayResult.rest.slice(withMatch.index + withMatch[0].length).trim();
  if (operatorPart === "") return { ok: false, failure: { kind: "empty" } };
  if (afterWith === "") return { ok: false, failure: { kind: "no_product" } };

  // Reviewer fix (S55 review): see `hasStrayFromWord`'s own comment above
  // `parseUnassignRest` -- the same leftover-clause garbage this grammar's
  // own `extractOptionalTimeClause` call can leave behind (FT5: "cover Sam
  // with Ana from Monday to Tuesday" used to fail `bad_time`).
  if (hasStrayFromWord(operatorPart, afterWith)) {
    return { ok: false, failure: { kind: "bad_time", text: afterWith } };
  }

  const pieces = splitProductPlaces(afterWith);
  const withName = restoreQuotes(pieces[0], quotes);
  const place = pieces.slice(1).map((p) => restoreQuotes(p, quotes));
  const operator = restoreQuotes(operatorPart, quotes);

  return {
    ok: true,
    command: {
      intent: "replace",
      operator,
      with: withName,
      place,
      day: merged.day,
      span: tc.span,
      shift,
    },
  };
}

/** SW1-SW4: "swap <op> (and|with) <other> [on <place>...] [on <day>] [from
 *  <time> to <time>] [for shift <name>]". SW4's decision: the same
 *  `no_product` choice as RP6 -- neither " and " nor " with " found at all. */
function parseSwapRest(rest: string, quotes: string[]): ParseResult {
  const shiftClause = extractShiftClause(rest, quotes);
  const shift = shiftClause.shift;
  rest = shiftClause.rest;

  const tc = extractOptionalTimeClause(rest);
  if (!tc.ok) return tc;
  if (shift !== null && tc.span !== null) {
    return { ok: false, failure: { kind: "shift_and_hours" } };
  }

  const dayResult = extractDayWord(tc.rest);
  if (!dayResult.ok) return dayResult;
  const merged = mergeDay(
    { day: dayResult.day, word: dayResult.word },
    { day: tc.trailingDay, word: tc.trailingWord },
  );
  if (!merged.ok) return merged;

  const sepMatch = dayResult.rest.match(/\bwith\b|\band\b/i);
  if (!sepMatch || sepMatch.index === undefined) {
    return { ok: false, failure: { kind: "no_product" } };
  }
  const operatorPart = dayResult.rest.slice(0, sepMatch.index).trim();
  const afterSep = dayResult.rest.slice(sepMatch.index + sepMatch[0].length).trim();
  if (operatorPart === "") return { ok: false, failure: { kind: "empty" } };
  if (afterSep === "") return { ok: false, failure: { kind: "no_product" } };

  // Reviewer fix (S55 review): see `hasStrayFromWord`'s own comment above
  // `parseUnassignRest` (FT6: "swap Sam and Ana from Monday to Tuesday"
  // used to fail `bad_time`).
  if (hasStrayFromWord(operatorPart, afterSep)) {
    return { ok: false, failure: { kind: "bad_time", text: afterSep } };
  }

  const pieces = splitProductPlaces(afterSep);
  const other = restoreQuotes(pieces[0], quotes);
  const place = pieces.slice(1).map((p) => restoreQuotes(p, quotes));
  const operator = restoreQuotes(operatorPart, quotes);

  return {
    ok: true,
    command: {
      intent: "swap",
      operator,
      other,
      place,
      day: merged.day,
      span: tc.span,
      shift,
    },
  };
}

// ---------------------------------------------------------------------------
// R-408 (S55, brief §3 CP1-CP11): "same as yesterday for Cell 1" / "copy
// Monday to Tuesday" -- D130 item 4.
// ---------------------------------------------------------------------------

function isWeekKind(d: DayWord): boolean {
  return d.kind === "this_week" || d.kind === "next_week" || d.kind === "last_week";
}

/** A single day-or-week token -- the only place a week kind is legal
 *  (`DayWord`'s own doc comment). `null` when `word` is not one of these. */
function parseDayOrWeekToken(word: string): DayWord | null {
  const trimmed = word.trim();
  const lower = trimmed.toLowerCase();
  if (lower === "today") return { kind: "today" };
  if (lower === "tomorrow") return { kind: "tomorrow" };
  if (lower === "yesterday") return { kind: "yesterday" };
  if (lower === "this week") return { kind: "this_week" };
  if (lower === "next week") return { kind: "next_week" };
  if (lower === "last week") return { kind: "last_week" };
  const isoMatch = trimmed.match(ISO_DATE_RE);
  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);
    const dayOfMonth = Number(isoMatch[3]);
    if (!isRealDate(year, month, dayOfMonth)) return null;
    return { kind: "date", iso: trimmed };
  }
  const weekday = WEEKDAY_MAP[lower];
  if (weekday !== undefined) return { kind: "weekday", day: weekday };
  return null;
}

/** "copy Monday to Tuesday" (mandatory "to"); CP5's own idiom, "repeat this
 *  week next week" (no "to" at all -- legal only when BOTH sides are a WEEK
 *  phrase, unambiguous since nothing else looks like one). */
const COPY_PAIR_WITH_TO_RE = new RegExp(
  `^(${DAY_OR_WEEK_TOKEN})\\s+to\\s+(${DAY_OR_WEEK_TOKEN})$`,
  "i",
);
const COPY_PAIR_NO_TO_RE =
  /^(this\s+week|next\s+week|last\s+week)\s+(this\s+week|next\s+week|last\s+week)$/i;

/** The place clause on a copy sentence takes EITHER preposition (CP1/CP4/CP7
 *  use "for", CP10 uses "on") -- the LAST one in the text, same "last
 *  occurrence" convention as everywhere else in this file. `null` when
 *  neither word appears at all (no place clause). */
function extractCopyPlaceClause(text: string): { rest: string; placeText: string | null } {
  const re = /\b(?:for|on)\b/gi;
  let lastIndex = -1;
  let lastLen = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    lastIndex = m.index;
    lastLen = m[0].length;
  }
  if (lastIndex === -1) return { rest: text, placeText: null };
  return {
    rest: text.slice(0, lastIndex).trim(),
    placeText: text.slice(lastIndex + lastLen).trim(),
  };
}

function copyPlace(placeText: string | null, quotes: string[]): string[] {
  if (!placeText) return [];
  return splitProductPlaces(placeText).map((p) => restoreQuotes(p, quotes));
}

/** CP1/CP2/CP7: "same as <day-or-week> [for|on <place>]". The implicit
 *  destination (D130 item 4): a week source copies to `this_week`, a day
 *  source copies to `today` -- "same as X" always means "make the CURRENT
 *  period same as X". */
function parseCopySameAs(rest: string, quotes: string[]): ParseResult {
  const { rest: dayText, placeText } = extractCopyPlaceClause(rest);
  const from = parseDayOrWeekToken(dayText);
  if (from === null) return { ok: false, failure: { kind: "bad_day", text: dayText } };
  const to: DayWord = isWeekKind(from) ? { kind: "this_week" } : { kind: "today" };
  return { ok: true, command: { intent: "copy", place: copyPlace(placeText, quotes), from, to } };
}

/** CP3/CP4/CP6/CP8-CP10: "(copy|repeat) <a> [to] <b> [for|on <place>]".
 *  `copy_mismatch` when one side is a week and the other a day; `copy_same`
 *  when both name the same day/week (`sameDay` already treats matching kind
 *  plus matching field as equal, extended here to `yesterday`/the week
 *  kinds by its own existing fallback). */
function parseCopyExplicit(rest: string, quotes: string[]): ParseResult {
  const { rest: pairText, placeText } = extractCopyPlaceClause(rest);
  const trimmed = pairText.trim();

  const withTo = trimmed.match(COPY_PAIR_WITH_TO_RE);
  const noTo = withTo ? null : trimmed.match(COPY_PAIR_NO_TO_RE);
  const m = withTo ?? noTo;
  if (!m) return { ok: false, failure: { kind: "bad_day", text: trimmed } };

  const fromText = m[1].trim();
  const toText = m[2].trim();
  const from = parseDayOrWeekToken(fromText);
  const to = parseDayOrWeekToken(toText);
  if (from === null) return { ok: false, failure: { kind: "bad_day", text: fromText } };
  if (to === null) return { ok: false, failure: { kind: "bad_day", text: toText } };

  if (isWeekKind(from) !== isWeekKind(to)) {
    return { ok: false, failure: { kind: "copy_mismatch", from: fromText, to: toText } };
  }
  if (sameDay(from, to)) {
    return { ok: false, failure: { kind: "copy_same" } };
  }

  return {
    ok: true,
    command: { intent: "copy", place: copyPlace(placeText, quotes), from, to },
  };
}

// ---------------------------------------------------------------------------
// R-409 (S55, brief §3 AB1-AB10): the absence grammar -- "<name> is <absence
// word> ..." -- matched BEFORE any place parsing (brief: "the words 'on
// leave' contain the place preposition").
// ---------------------------------------------------------------------------

const ABSENCE_WORD_ALTS = ABSENCE_WORDS.map((w) => w.replace(/ /g, "\\s+")).join("|");
/** AB10's own escape: this requires an ABSENCE_WORD right after "is" -- "Sam
 *  is on Housing A..." never matches (no alternative here reads "on" alone),
 *  so WO2's ordinary assign reading runs unaffected. */
const ABSENCE_RE = new RegExp(`^(.+?)\\s+is\\s+(${ABSENCE_WORD_ALTS})\\b(.*)$`, "i");

/**
 * AB1-AB9: `namePart` and `tailRaw` are `ABSENCE_RE`'s own capture groups 1
 * and 3 (group 2, the absence word itself, is read but not stored -- the
 * resolver only needs "this person is out", never which word said so).
 * AB2's explicit default: no day at all means TODAY, not "the board's own
 * day" (`null`) -- an absence always names a day, even the unstated one.
 */
function parseAbsenceRest(namePart: string, tailRaw: string, quotes: string[]): ParseResult {
  const operator = restoreQuotes(namePart.trim(), quotes);
  const rest = tailRaw.trim();

  let until: DayWord | null = null;
  const untilRe = /\b(?:till|until)\b/gi;
  let lastIndex = -1;
  let lastLen = 0;
  let m: RegExpExecArray | null;
  while ((m = untilRe.exec(rest)) !== null) {
    lastIndex = m.index;
    lastLen = m[0].length;
  }
  let dayPart = rest;
  if (lastIndex !== -1) {
    const untilWordText = rest.slice(lastIndex + lastLen).trim();
    const untilDay = parseDayOrWeekToken(untilWordText);
    if (untilDay === null || isWeekKind(untilDay)) {
      return { ok: false, failure: { kind: "bad_day", text: untilWordText } };
    }
    until = untilDay;
    dayPart = rest.slice(0, lastIndex).trim();
  }

  dayPart = dayPart.replace(/^from\s+/i, "").trim();

  let day: DayWord | null = null;
  if (dayPart !== "") {
    const parsed = parseDayOrWeekToken(dayPart);
    if (parsed === null || isWeekKind(parsed)) {
      return { ok: false, failure: { kind: "bad_day", text: dayPart } };
    }
    day = parsed;
  }

  return {
    ok: true,
    command: {
      intent: "unassign",
      operator,
      place: [],
      day: day ?? { kind: "today" },
      span: null,
      existing: null,
      shift: null,
      until,
    },
  };
}

/** `assign <op> to <product> on <place1>...`, `book <product> on <place1>...`
 *  or `unassign <op> from <place1>...` (brief §3/§4). Case-insensitive,
 *  whitespace collapsed, a trailing `.` ignored, double-quoted segments
 *  atomic. The FIRST WORD decides the intent: `unassign`/`remove`/`clear`/
 *  `take` -> unassign; `move`/`change`/`shift`/... -> move; `cover`/
 *  `replace` -> replace; `swap`/`exchange` -> swap; `copy`/`repeat`/"same
 *  as" -> copy; `book`/`run` -> book; anything else (including no verb at
 *  all) -> assign, tried through the word-order grammar (R-405) first.
 *
 * S55 (docs/agent-briefs/s55-a-grammar-brief.md, R-404-R-409, design
 * §19.101/D130) widens the grammar again, this time with two new
 * dispatch points ahead of everything else: the absence grammar (R-409,
 * no leading verb at all -- "Sam is off today") and three new intents with
 * their own leading verbs (R-406/R-408). Assign/book gain a duration clause
 * and a boundary/time-of-day shift clause (R-404), both tried before the
 * mandatory time clause, which itself now falls back to a bare "X to Y"
 * pair (no "from") once every other reading has failed to find hours at
 * all -- the same fallback the word-order grammar's own hours use.
 */
export function parseCommand(text: string): ParseResult {
  const { text: quoted, quotes } = extractQuotes(text);
  let norm = quoted.replace(/\s+/g, " ").trim();
  if (norm.endsWith(".")) norm = norm.slice(0, -1).trim();
  if (norm === "") return { ok: false, failure: { kind: "empty" } };

  // R-416 (S58): "every weekday"/"every day"/"weekdays" [this week|next
  // week] is stripped from the sentence HERE, before any dispatch, so every
  // grammar below reads exactly the sentence it always has -- none of them
  // needs to know this phrase exists. `applyRepeatDay`, at the very end,
  // decides whether the finished command may carry it (assign/book only) or
  // must fail `bad_day`.
  const repeat = extractRepeatDayClause(norm);
  const workingNorm = repeat ? repeat.rest : norm;

  const result = dispatch(workingNorm, quotes);
  return repeat ? applyRepeatDay(result, repeat) : result;

  /** The rest of the grammar's own first-word dispatch, unchanged from
   *  before S58 except for the four new branches marked S58 below --
   *  `extractRepeatDayClause` above already removed the one clause none of
   *  this needs to see. */
  function dispatch(norm: string, quotes: string[]): ParseResult {
    // R-409: the absence grammar has no leading verb at all -- checked first,
    // before every verb dispatch below. AB10 is the escape: with no
    // ABSENCE_WORD right after "is", this simply does not match.
    const absenceMatch = norm.match(ABSENCE_RE);
    if (absenceMatch) {
      return parseAbsenceRest(absenceMatch[1], absenceMatch[3], quotes);
    }

    // S41-b: decided before the mandatory-time-clause path runs -- the
    // unassign grammar's time clause is OPTIONAL, so it cannot share
    // `parseTimeAndDay`'s "no_time" requirement.
    const unassignVerbMatch = norm.match(UNASSIGN_VERB_RE);
    if (unassignVerbMatch) {
      return parseUnassignRest(
        norm.slice(unassignVerbMatch[0].length),
        quotes,
        unassignVerbMatch[1].toLowerCase(),
      );
    }

    // S41-c: decided before the mandatory-time-clause path runs too -- the
    // move grammar's time clause is OPTIONAL, exactly like unassign's.
    const moveVerbMatch = norm.match(MOVE_VERB_RE);
    if (moveVerbMatch) {
      const moveRest = norm.slice(moveVerbMatch[0].length);
      // S58 (R-412): the possessive-edge-tail door ("move Sam's start to
      // 9") -- tried before the ordinary move grammar; `null` when there is
      // no such tail at all (every move sentence before S58, unaffected).
      const edgeAdjust = tryMoveEdgeAdjust(moveRest, quotes);
      if (edgeAdjust) return edgeAdjust;
      return parseMoveRest(moveRest, quotes);
    }

    // S58 (R-412): the dedicated-verb door -- extend/lengthen/shorten/end/
    // finish, its own list (never joining MOVE_VERBS, see the comment above
    // `ADJUST_VERBS`).
    const adjustVerbMatch = norm.match(ADJUST_VERB_RE);
    if (adjustVerbMatch) {
      return parseAdjustRest(
        adjustVerbMatch[1].toLowerCase(),
        norm.slice(adjustVerbMatch[0].length),
        quotes,
      );
    }

    // S58 (R-413): "split" is its own first word (brief §2, "add it to no
    // verb list; the first-word dispatch handles it").
    const splitMatch = norm.match(SPLIT_RE);
    if (splitMatch) {
      return parseSplitRest(norm.slice(splitMatch[0].length), quotes);
    }

    // R-406: cover/replace and swap/exchange, decided the same way.
    const replaceVerbMatch = norm.match(REPLACE_VERB_RE);
    if (replaceVerbMatch) {
      return parseReplaceRest(norm.slice(replaceVerbMatch[0].length), quotes);
    }
    const swapVerbMatch = norm.match(SWAP_VERB_RE);
    if (swapVerbMatch) {
      return parseSwapRest(norm.slice(swapVerbMatch[0].length), quotes);
    }

    // R-408: "same as ..." (no destination said) or copy/repeat <a> [to] <b>.
    const sameAsMatch = norm.match(SAME_AS_RE);
    if (sameAsMatch) {
      return parseCopySameAs(norm.slice(sameAsMatch[0].length), quotes);
    }
    const copyVerbMatch = norm.match(COPY_VERB_RE);
    if (copyVerbMatch) {
      return parseCopyExplicit(norm.slice(copyVerbMatch[0].length), quotes);
    }

    // S58 (R-415): "make"/"set" a job's headcount, claimed FIRST (HC9's own
    // decision, see the R-391 comment above `ASSIGN_VERBS`) -- `null` when
    // the sentence is not headcount-shaped at all, so a plain "set ..."
    // falls all the way through to the ordinary assign pipeline below.
    const headcountVerbMatch = norm.match(HEADCOUNT_VERB_RE);
    if (headcountVerbMatch) {
      const headcount = parseHeadcountRest(norm.slice(headcountVerbMatch[0].length), quotes);
      if (headcount) return headcount;
    }

    // R-405: no verb from any of the lists above matched the first word --
    // tried against the word-order grammar before falling to the ordinary
    // "no verb" assign reading (brief §3).
    const hasLeadingVerb = ASSIGN_VERB_RE.test(norm) || BOOK_VERB_RE.test(norm);
    if (!hasLeadingVerb) {
      const wordOrder = tryWordOrder(norm, quotes);
      if (wordOrder) return wordOrder;
    }

    // S58 (R-414): "the <product> job/run" -- ASSIGN only (a booking already
    // names an existing run's own hours, never borrows another's).
    //
    // Reviewer fix (S58 review): moved here, BEFORE the duration clause and
    // the shift/boundary clause checks below -- both of those search the
    // WHOLE sentence unconditionally, and when "the <product> job" sat next
    // to a "for shift 2" or a "for 4 hours" clause they matched it FIRST and
    // returned an ordinary assign with "the Housing A job" read as a literal
    // (nonsense) product name, `tryJobHoursAssign` never even called ("add
    // Sam to the Housing A job on Cell 1 for shift 2" used to parse `ok`,
    // product "the Housing A job", shift "2" -- silently wrong). Tried here
    // first, this function sees its own shape before either one can steal
    // the sentence, and now refuses the same conflict itself
    // (`shift_and_hours`, the failure JB4 already gives for ordinary hours;
    // see the reviewer note inside `tryJobHoursAssign`). `null` -- not a
    // failure -- when the sentence has no such shape at all (JB7), so it
    // falls through to the duration/boundary/canonical paths exactly as
    // before.
    if (!BOOK_VERB_RE.test(norm)) {
      const jobHours = tryJobHoursAssign(norm, quotes);
      if (jobHours) return jobHours;
    }

    // R-404: a duration clause ("from 8 for 4 hours") stands in for the
    // mandatory time clause on assign/book -- tried BEFORE the headcount,
    // product-last and shift/boundary clauses (brief §3: the unit word makes
    // it unambiguous).
    const duration = extractDurationClause(norm);
    if (duration) {
      if (!duration.ok) return duration;
      const dayResult = extractDayWord(duration.rest);
      if (!dayResult.ok) return dayResult;

      const bookVerbMatch = dayResult.rest.match(BOOK_VERB_RE);
      if (bookVerbMatch) {
        return parseBookRest(
          dayResult.rest.slice(bookVerbMatch[0].length),
          dayResult.day,
          duration.start,
          duration.end,
          quotes,
          null,
        );
      }
      return parseAssignRest(
        dayResult.rest,
        dayResult.day,
        duration.start,
        duration.end,
        quotes,
        null,
      );
    }

    // DU10: a bare pair immediately followed by a duration clause, with no
    // "from"/"at" to anchor either one -- never a guess which wins (the
    // developer's own decision, documented in the brief report).
    const ambiguousDuration = norm.match(DURATION_AMBIGUOUS_RE);
    if (ambiguousDuration) {
      return { ok: false, failure: { kind: "bad_time", text: ambiguousDuration[0].trim() } };
    }

    // R-404: a shift clause (an ordinary name, a boundary, or a time-of-day
    // word) stands in for the mandatory hours on assign/book too -- tried
    // BEFORE `parseTimeAndDay`'s own (mandatory) time clause, since a shift
    // sentence need not have one at all.
    const boundary = extractShiftOrBoundaryClause(norm, quotes);
    if (boundary.shift !== null) {
      const stillHasTime = parseTimeAndDay(boundary.rest);
      if (stillHasTime.ok) {
        // Both a shift and hours were said -- never a guess which wins.
        return { ok: false, failure: { kind: "shift_and_hours" } };
      }
      if (stillHasTime.failure.kind !== "no_time") {
        // A real time-clause problem, unrelated to the shift -- surface it.
        return stillHasTime;
      }
      const dayResult = extractDayWord(boundary.rest);
      if (!dayResult.ok) return dayResult;
      // R-405 (TD7): the time-of-day clause's own implied day is said FIRST in
      // the sentence (it is read out of the text before the ordinary trailing
      // day word ever runs) -- leading/trailing order matters for `two_days`'
      // own `first`/`second` naming (F-133's rule).
      const merged = mergeDay(
        { day: boundary.impliedDay, word: boundary.impliedDayWord },
        { day: dayResult.day, word: dayResult.word },
      );
      if (!merged.ok) return merged;

      const bookVerbMatch = dayResult.rest.match(BOOK_VERB_RE);
      if (bookVerbMatch) {
        return parseBookRest(
          dayResult.rest.slice(bookVerbMatch[0].length),
          merged.day,
          boundary.start,
          null,
          quotes,
          boundary.shift,
        );
      }
      return parseAssignRest(
        dayResult.rest,
        merged.day,
        boundary.start,
        null,
        quotes,
        boundary.shift,
      );
    }

    const canonical = parseCanonicalAssign(norm, quotes);
    if (canonical.ok || canonical.failure.kind !== "no_time") return canonical;

    // R-404 (RM8): "after 2" (or "before"/"until") on an assign or a booking --
    // those two grammars need BOTH ends said; a lone edge here is
    // `open_span`, never a silent guess at the other one. Only reached once
    // the ordinary paired ("from X to Y") and bare-pair readings have both
    // failed to find hours at all (P21's "from 8 until 4" is a valid PAIR and
    // never reaches here).
    const openSpanMatch = norm.match(LONE_EDGE_RE);
    if (openSpanMatch) {
      return { ok: false, failure: { kind: "open_span", text: openSpanMatch[0].trim() } };
    }

    return canonical;
  }
}

/** S58 (R-416): one "every weekday"/"every day"/"weekdays" clause, with an
 *  optional "this week"/"next week" -- an unanchored search, since it sits
 *  between the place and the hours (RW1), not necessarily at either end.
 *  Defaults to "this week" when no week word is said (RW4). */
const REPEAT_DAY_RE = new RegExp(
  `\\b(${REPEAT_WORDS.join("|").replace(/ /g, "\\s+")})\\b(?:\\s+(this\\s+week|next\\s+week))?`,
  "i",
);

function extractRepeatDayClause(text: string): { rest: string; day: DayWord; text: string } | null {
  const m = text.match(REPEAT_DAY_RE);
  if (!m || m.index === undefined) return null;
  const kind: "weekdays" | "every_day" = /^every\s+day$/i.test(m[1]) ? "every_day" : "weekdays";
  const week: "this_week" | "next_week" = m[2] && /next/i.test(m[2]) ? "next_week" : "this_week";
  return { rest: removeMatch(text, m), day: { kind, week }, text: m[0].trim() };
}

/** S58 (R-416): reattaches the repeat-day clause `extractRepeatDayClause`
 *  stripped, once the finished command's intent is known -- legal ONLY on
 *  an assign or a booking (D132 item 5); everywhere else, `bad_day`. A
 *  `several`'s inner commands are always assign or move (S50) or assign or
 *  book (S41-a's own several), so the same per-command rule is applied to
 *  each in turn. */
function applyRepeatDay(result: ParseResult, repeat: { day: DayWord; text: string }): ParseResult {
  if (!result.ok) return result;
  if (result.command.intent === "several") {
    const commands: SingleCommand[] = [];
    for (const c of result.command.commands) {
      const applied = applyRepeatDayToSingle(c, repeat);
      if (!applied.ok) return applied;
      commands.push(applied.command as SingleCommand);
    }
    return { ok: true, command: { intent: "several", commands } };
  }
  return applyRepeatDayToSingle(result.command, repeat);
}

function applyRepeatDayToSingle(cmd: Command, repeat: { day: DayWord; text: string }): ParseResult {
  if (cmd.intent !== "assign" && cmd.intent !== "book") {
    return { ok: false, failure: { kind: "bad_day", text: repeat.text } };
  }
  if (cmd.day !== null) {
    return {
      ok: false,
      failure: { kind: "two_days", first: repeat.text, second: dayToCanonicalText(cmd.day) },
    };
  }
  return { ok: true, command: { ...cmd, day: repeat.day } };
}

/**
 * Reviewer fix (S55 review): a printed value that would itself re-trigger
 * one of this grammar's own UNANCHORED clause matchers once reinserted
 * unquoted -- the absence grammar's "<x> is <absence word>" (`ABSENCE_RE`,
 * tried on the WHOLE sentence before any verb dispatch, brief §3 AB-series)
 * or the `ALL_DAY` boundary phrase (`ALL_DAY_RE`, an unanchored "all day"
 * search inside assign/book/unassign/move) -- must round-trip quoted, the
 * same way a place/time keyword already does. Found by two round-trip
 * mismatches: a quoted operator "Sam is off" printed unquoted read back as
 * an absence command failing `bad_day`; a quoted cell "All Day" printed
 * unquoted read back as the `ALL_DAY` shift, either losing the place
 * (`remove Sam from "All Day"`) or colliding with real hours
 * (`shift_and_hours`). A third case, same family: a person QUOTED
 * "Everyone" (the fix to `canonicalizeEveryoneRaw` above keeps this a
 * literal name at parse time) printed back unquoted on a removal or a move
 * re-triggers `canonicalizeEveryoneRaw`'s own alias check on reparse and
 * collapses back into the reserved word -- so any of `EVERYONE_ALIASES`
 * round-trips quoted too, the same defensive way, on every intent (cheap
 * and harmless where it is not the reserved word's own intent, e.g. an
 * assign's operator).
 */
const ABSENCE_TRIGGER_RE = new RegExp(`\\bis\\s+(${ABSENCE_WORD_ALTS})\\b`, "i");

function needsQuoting(word: string): boolean {
  return (
    /\b(to|on|at|in)\b/i.test(word) ||
    word.includes(",") ||
    ABSENCE_TRIGGER_RE.test(word) ||
    ALL_DAY_RE.test(word) ||
    EVERYONE_ALIASES.has(word.trim().toLowerCase())
  );
}

function quoteIfNeeded(word: string): string {
  return needsQuoting(word) ? `"${word}"` : word;
}

/** Reviewer fix, blocker 2: a shift name of three-or-more words, or one
 *  containing any word of the shift grammar's own stop list (`SHIFT_STOP_WORD`
 *  above, spelled out here since that constant is a regex-alternation
 *  string, not a lookup set), never round-trips unquoted -- `for shift Day
 *  For Real` would re-read "For" as the NAMED form's own preposition and
 *  "Real" (or less) as the name. Quoted whenever it is more than one word,
 *  contains a comma, or IS (case-insensitively) one of those stop words. */
const SHIFT_QUOTING_STOP_WORDS = new Set([
  "on",
  "at",
  "in",
  "for",
  "during",
  "to",
  "from",
  "and",
  "shift",
]);

function needsShiftQuoting(name: string): boolean {
  if (name.includes(",")) return true;
  const words = name.trim().split(/\s+/);
  if (words.length > 1) return true;
  return SHIFT_QUOTING_STOP_WORDS.has(words[0].toLowerCase());
}

function quoteShiftIfNeeded(name: string): string {
  return needsShiftQuoting(name) ? `"${name}"` : name;
}

/** R-404 (S55): prints a shift clause -- an ordinary R-402 name (unchanged),
 *  or one of the three `BOUNDARY_SHIFTS`, each in its own words rather than
 *  the generic "for shift <name>" wrapper (`ALL_DAY` never carries a start;
 *  `END_OF_SHIFT`/`END_OF_DAY` print an optional leading "from HH:MM" when
 *  `start` is not null -- assign/book only, `null` from unassign/move). */
function formatShiftOrBoundary(shift: string, start: ClockTime | null): string[] {
  if (shift === ALL_DAY) return ["all", "day"];
  const prefix = start ? ["from", `${pad2(start.hour)}:${pad2(start.minute)}`] : [];
  if (shift === END_OF_SHIFT) return [...prefix, "until", "end", "of", "shift"];
  if (shift === END_OF_DAY) return [...prefix, "for", "the", "rest", "of", "the", "day"];
  return ["for", "shift", quoteShiftIfNeeded(shift)];
}

/** R-404 (S55, RM5/RM6/RM9): a removal's lone-edge span prints as "after
 *  HH:MM" (span.end is `DAY_END`) or "before HH:MM" (span.start is
 *  midnight) instead of the ordinary "from HH:MM to HH:MM" pair -- both
 *  read back through `extractLoneEdgeSpan` the same way. An ordinary paired
 *  span (neither edge a boundary) is unaffected. */
function formatSpanClause(span: { start: ClockTime; end: ClockTime }): string[] {
  const isMidnight = (t: ClockTime) => t.hour === 0 && t.minute === 0;
  const isDayEnd = (t: ClockTime) => t.hour === DAY_END.hour && t.minute === DAY_END.minute;
  if (isDayEnd(span.end) && !isMidnight(span.start)) {
    return ["after", `${pad2(span.start.hour)}:${pad2(span.start.minute)}`];
  }
  if (isMidnight(span.start) && !isDayEnd(span.end)) {
    return ["before", `${pad2(span.end.hour)}:${pad2(span.end.minute)}`];
  }
  return [
    "from",
    `${pad2(span.start.hour)}:${pad2(span.start.minute)}`,
    "to",
    `${pad2(span.end.hour)}:${pad2(span.end.minute)}`,
  ];
}

/** F-146: an END clock reading `DAY_END` prints as "midnight" (never the
 *  literal "23:59") on the assign/book/move grammars' own paired "from X to
 *  Y" hours -- the round trip holds because `isDayEndSpelling` reads
 *  "midnight" back the same way. Only ever applied to an END; a START is
 *  always printed as its literal HH:MM. */
function formatEndClock(t: ClockTime): string {
  if (t.hour === DAY_END.hour && t.minute === DAY_END.minute) return "midnight";
  return `${pad2(t.hour)}:${pad2(t.minute)}`;
}

/** S58 (R-416): prints "every weekday"/"every day", the week word ALWAYS
 *  said explicitly (RW7's own pin: "this week" prints even when the input
 *  left it implied -- the round trip only needs to read back the same
 *  `DayWord`, not the exact words said). */
function repeatWeekText(week: "this_week" | "next_week"): string {
  return week === "next_week" ? "next week" : "this week";
}

function dayToCanonicalText(day: DayWord): string {
  if (day.kind === "today") return "today";
  if (day.kind === "tomorrow") return "tomorrow";
  if (day.kind === "yesterday") return "yesterday";
  if (day.kind === "date") return day.iso;
  if (day.kind === "this_week") return "this week";
  if (day.kind === "next_week") return "next week";
  if (day.kind === "last_week") return "last week";
  if (day.kind === "weekdays") return `every weekday ${repeatWeekText(day.week)}`;
  if (day.kind === "every_day") return `every day ${repeatWeekText(day.week)}`;
  return WEEKDAY_ABBR[day.day];
}

/** S58 (R-416, RW7): true for the two REPEAT `DayWord` kinds -- printed
 *  WITHOUT the ordinary "on" prefix (`formatAssignCommand`/
 *  `formatBookCommand`'s own day clause), so the printed clause matches
 *  exactly what `extractRepeatDayClause` looks for and there is no stray
 *  "on" left dangling before the hours clause that follows it. */
function isRepeatDay(day: DayWord): boolean {
  return day.kind === "weekdays" || day.kind === "every_day";
}

/**
 * The canonical sentence for an `AssignCommand` — the inverse of
 * `parseAssignRest` for the §4 shape (24h times, `on … in …` places, names
 * quoted when they contain a separator word). Does NOT print `attach` or
 * `existing`.
 */
function formatAssignCommand(command: AssignCommand): string {
  // S58 (R-414, JB6): "the job's hours" prints its own "to the <product>
  // job" shape -- the reserved word travels IN the product clause, not as
  // an appended shift/boundary clause the way `ALL_DAY` etc. do, so it
  // round-trips through `tryJobHoursAssign`'s own "the ... job" reading.
  if (command.shift === JOB_HOURS) {
    const parts: string[] = ["assign", quoteIfNeeded(command.operator), "to", "the"];
    parts.push(quoteIfNeeded(command.product), "job");
    parts.push("on", quoteIfNeeded(command.place[0]));
    for (let i = 1; i < command.place.length; i++) {
      parts.push("in", quoteIfNeeded(command.place[i]));
    }
    if (command.day) {
      parts.push(...(isRepeatDay(command.day) ? [] : ["on"]), dayToCanonicalText(command.day));
    }
    return parts.join(" ");
  }

  const parts: string[] = [
    "assign",
    quoteIfNeeded(command.operator),
    "to",
    quoteIfNeeded(command.product),
  ];
  parts.push("on", quoteIfNeeded(command.place[0]));
  for (let i = 1; i < command.place.length; i++) {
    parts.push("in", quoteIfNeeded(command.place[i]));
  }
  if (command.day) {
    parts.push(...(isRepeatDay(command.day) ? [] : ["on"]), dayToCanonicalText(command.day));
  }
  // R-402/R-404: a shift or boundary clause prints in place of the hours;
  // the invariant (`shift` non-null <=> `start`/`end` null, `ALL_DAY`
  // excepted) means exactly one of the two branches below ever runs.
  if (command.shift !== null) {
    parts.push(...formatShiftOrBoundary(command.shift, command.start));
  } else {
    parts.push(
      "from",
      `${pad2(command.start!.hour)}:${pad2(command.start!.minute)}`,
      "to",
      formatEndClock(command.end!),
    );
  }
  return parts.join(" ");
}

/**
 * S41-a: the canonical sentence for a `BookCommand` — `book <part> on <cell>
 * [in <line>] [for <n> people] [on <day>] from HH:MM to HH:MM`. Does NOT
 * print `existing`.
 */
function formatBookCommand(command: BookCommand): string {
  const parts: string[] = ["book", quoteIfNeeded(command.product)];
  parts.push("on", quoteIfNeeded(command.place[0]));
  for (let i = 1; i < command.place.length; i++) {
    parts.push("in", quoteIfNeeded(command.place[i]));
  }
  if (command.headcount !== null) {
    parts.push("for", String(command.headcount), "people");
  }
  if (command.day) {
    parts.push(...(isRepeatDay(command.day) ? [] : ["on"]), dayToCanonicalText(command.day));
  }
  // R-402/R-404: a shift or boundary clause in place of the hours -- same
  // invariant as `formatAssignCommand`.
  if (command.shift !== null) {
    parts.push(...formatShiftOrBoundary(command.shift, command.start));
  } else {
    parts.push(
      "from",
      `${pad2(command.start!.hour)}:${pad2(command.start!.minute)}`,
      "to",
      formatEndClock(command.end!),
    );
  }
  return parts.join(" ");
}

/**
 * S41-b: the canonical sentence for an `UnassignCommand` — `unassign <person>
 * [from <cell> [in <line>]] [on <day>] [from HH:MM to HH:MM]`. Does NOT print
 * `existing`; the time clause is printed only when `span` is not null.
 *
 * S50 (reviewer blocker): `place` may be `[]` (a place-less removal) --
 * `command.place[0]` is then `undefined`, and `quoteIfNeeded` throws reading
 * `.includes` off it. The whole "from <cell> [in <line>]" clause is printed
 * ONLY when `place.length > 0`; a place-less removal reads back through
 * `parseUnassignRest`'s own empty-place branch (S50 §2 item 1) into the same
 * `place: []`, so the round trip still holds.
 */
function formatUnassignCommand(command: UnassignCommand): string {
  const parts: string[] = ["unassign", quoteIfNeeded(command.operator)];
  if (command.place.length > 0) {
    parts.push("from", quoteIfNeeded(command.place[0]));
    for (let i = 1; i < command.place.length; i++) {
      parts.push("in", quoteIfNeeded(command.place[i]));
    }
  }
  if (command.day) {
    parts.push("on", dayToCanonicalText(command.day));
  }
  // R-402/R-404: a shift or boundary clause in place of the hours -- `span`
  // is null whenever `shift` is not (the type's own invariant). A paired
  // span prints "from X to Y"; a lone-edge one (RM5/RM6) prints "after"/
  // "before" instead (`formatSpanClause`).
  if (command.shift !== null) {
    parts.push(...formatShiftOrBoundary(command.shift, null));
  } else if (command.span) {
    parts.push(...formatSpanClause(command.span));
  }
  // R-409 (S55): the absence grammar's own trailing clause -- AB9's own
  // pin. Real behaviour differs from the brief's illustrative prose (which
  // shows "remove ... today until Friday", the maintainer's casual gloss,
  // not the literal printed sentence): `formatUnassignCommand` always prints
  // the canonical "unassign" verb (PV4's own pin, unchanged by S55), "on
  // <day>" (the same prefix every other day clause in this file gets), and
  // a weekday prints as its three-letter `WEEKDAY_ABBR` spelling, not the
  // full word said. Pinned to the real, mechanically consistent output
  // (CLAUDE.md §4, "pinned to the real behaviour, not the brief's prose"),
  // same as L4's own precedent above -- the round trip is what matters, and
  // it holds either way.
  if (command.until !== null) {
    parts.push("until", dayToCanonicalText(command.until));
  }
  return parts.join(" ");
}

/**
 * R-406 (S55): the canonical sentence for a `ReplaceCommand` — `cover <op>
 * with <name> [on <cell> [in <line>]] [<day>] [from HH:MM to HH:MM | for
 * shift <name>]`. RP7's own pin: the day clause prints WITHOUT an "on"
 * prefix (unlike assign/book/unassign/move) -- it still reads back fine,
 * since `extractDayWord`'s own "on " prefix is always optional.
 */
function formatReplaceCommand(command: ReplaceCommand): string {
  const parts: string[] = [
    "cover",
    quoteIfNeeded(command.operator),
    "with",
    quoteIfNeeded(command.with),
  ];
  if (command.place.length > 0) {
    parts.push("on", quoteIfNeeded(command.place[0]));
    for (let i = 1; i < command.place.length; i++) {
      parts.push("in", quoteIfNeeded(command.place[i]));
    }
  }
  if (command.day) {
    parts.push(dayToCanonicalText(command.day));
  }
  if (command.shift !== null) {
    parts.push("for", "shift", quoteShiftIfNeeded(command.shift));
  } else if (command.span) {
    parts.push(
      "from",
      `${pad2(command.span.start.hour)}:${pad2(command.span.start.minute)}`,
      "to",
      `${pad2(command.span.end.hour)}:${pad2(command.span.end.minute)}`,
    );
  }
  return parts.join(" ");
}

/**
 * R-406 (S55): the canonical sentence for a `SwapCommand` — `swap <op> and
 * <other> [on <cell> [in <line>]] [<day>] [from HH:MM to HH:MM | for shift
 * <name>]`. SW5's own pin: always "and" (never "with", whichever the
 * sentence used), no "on" before the day, same as replace's.
 */
function formatSwapCommand(command: SwapCommand): string {
  const parts: string[] = [
    "swap",
    quoteIfNeeded(command.operator),
    "and",
    quoteIfNeeded(command.other),
  ];
  if (command.place.length > 0) {
    parts.push("on", quoteIfNeeded(command.place[0]));
    for (let i = 1; i < command.place.length; i++) {
      parts.push("in", quoteIfNeeded(command.place[i]));
    }
  }
  if (command.day) {
    parts.push(dayToCanonicalText(command.day));
  }
  if (command.shift !== null) {
    parts.push("for", "shift", quoteShiftIfNeeded(command.shift));
  } else if (command.span) {
    parts.push(
      "from",
      `${pad2(command.span.start.hour)}:${pad2(command.span.start.minute)}`,
      "to",
      `${pad2(command.span.end.hour)}:${pad2(command.span.end.minute)}`,
    );
  }
  return parts.join(" ");
}

/**
 * R-408 (S55): the canonical sentence for a `CopyCommand` — `copy <from> to
 * <to> [for <cell> [in <line>]]` (CP11's own pin: always "copy", always an
 * explicit "to", even when the source sentence used "repeat" or "same as"
 * and left the destination implicit; the place preposition is always "for",
 * even when the source used "on", CP10).
 */
function formatCopyCommand(command: CopyCommand): string {
  const parts: string[] = [
    "copy",
    dayToCanonicalText(command.from),
    "to",
    dayToCanonicalText(command.to),
  ];
  if (command.place.length > 0) {
    parts.push("for", quoteIfNeeded(command.place[0]));
    for (let i = 1; i < command.place.length; i++) {
      parts.push("in", quoteIfNeeded(command.place[i]));
    }
  }
  return parts.join(" ");
}

/**
 * S41-c: the canonical sentence for a `MoveCommand` — `move <person> [on
 * <cell> [in <line>]] [to <cell> [in <line>]] [on <day>] [from HH:MM to
 * HH:MM]` (always `from` for the hours when printing, whichever word the
 * sentence used). Does NOT print `existing`.
 *
 * S50 (reviewer blocker): `place` may be `[]` (a place-less move) --
 * `command.place[0]` is then `undefined`, and `quoteIfNeeded` throws reading
 * `.includes` off it. The whole "on <cell> [in <line>]" clause is printed
 * ONLY when `place.length > 0`. The rest of the sentence still reads back as
 * the SAME place-less move through the new split rule in `parseMoveRest`:
 * with no place clause, `splitMoveOperatorPlaces` finds no on/at/from at
 * all, so the place-less branch runs -- "move <person> to <cell>" splits on
 * the first " to " into operator/destination (toPlace), and "move <person>
 * from HH:MM to HH:MM" has no " to " left in the operator segment at all
 * (the hours are consumed first, by `extractOptionalTimeClause`'s own
 * "from"), so the whole remainder is the operator and there is no
 * destination -- both read back to the same command that was formatted.
 */
/** S58 (R-412): formats a signed minute count as ["<n>", "<unit>"] -- whole
 *  hours print as "N hour"/"N hours", anything else as raw minutes. Only
 *  ever called with the MAGNITUDE (the caller's own verb/word already says
 *  the sign): `formatAdjustCommand` below, never a negative number here. */
function formatDurationMinutes(minutes: number): string[] {
  if (minutes % 60 === 0) {
    const n = minutes / 60;
    return [String(n), n === 1 ? "hour" : "hours"];
  }
  return [String(minutes), minutes === 1 ? "minute" : "minutes"];
}

function formatClock(t: ClockTime): string {
  return `${pad2(t.hour)}:${pad2(t.minute)}`;
}

/** Reviewer fix (S58 review): `"on <place[0]> [in <place[1]> ...]"`, or `[]`
 *  when there is none -- shared by `formatAdjustCommand`'s two doors below. */
function formatAdjustPlace(place: string[]): string[] {
  if (place.length === 0) return [];
  const parts: string[] = ["on", quoteIfNeeded(place[0])];
  for (let i = 1; i < place.length; i++) parts.push("in", quoteIfNeeded(place[i]));
  return parts;
}

/**
 * S58 (R-412, brief §1 AJ17): the canonical sentence for a `MoveCommand`
 * whose `adjust` is set -- a different shape entirely from the ordinary
 * move sentence (no destination, no ordinary hours). The END edge always
 * prints through the dedicated-verb door ("extend"/"end", `at` printing as
 * "end <op> at HH:MM", a negative `by` as "end <op> N unit earlier"); the
 * START edge has no dedicated verb, so it always prints through the
 * possessive-edge-tail door ("move <op>'s start ..."), the same one
 * `tryMoveEdgeAdjust` reads back.
 *
 * Reviewer fix (S58 review): `command.place` was silently dropped here even
 * though both parse doors already accept it (AJ3's leading place on the
 * dedicated-verb door, AJ8's trailing place on the same door, and the
 * possessive-edge-tail door's own leftover place added by this review) --
 * `formatCommand(parseCommand("lengthen Sam on Cell 1 by 2 hours today"))`
 * printed "lengthen Sam by 2 hours on today" with the cell silently gone,
 * and reparsing it lost the place for good. Each door prints place in the
 * SAME position its own parser already reads it back from unambiguously:
 * the dedicated-verb door's `by`/`earlier` clauses read a place before OR
 * after the clause (both `splitMoveOperatorPlaces` calls are unanchored), so
 * printing it BEFORE the clause matches AJ3's own pinned order; the
 * possessive-edge-tail door only ever reads a place from the leftover AFTER
 * its clause, so it is printed there.
 */
function formatAdjustCommand(command: MoveCommand): string {
  const adjust = command.adjust!;
  const opQ = quoteIfNeeded(command.operator);
  const placeParts = formatAdjustPlace(command.place);
  let sentence: string;
  if (adjust.edge === "end") {
    if ("at" in adjust) {
      // F-146 (reviewer fix, S58 review): DAY_END prints as "midnight" here
      // too, the same as every other END clock in this file -- the parse
      // side above now writes DAY_END for "end Sam at midnight" and this
      // must read it back the same way, or the round trip breaks. Place, per
      // AJ8, prints AFTER the at-clause.
      sentence = ["end", opQ, "at", formatEndClock(adjust.at), ...placeParts].join(" ");
    } else if (adjust.by > 0) {
      sentence = ["extend", opQ, ...placeParts, "by", ...formatDurationMinutes(adjust.by)].join(
        " ",
      );
    } else {
      sentence = ["end", opQ, ...placeParts, ...formatDurationMinutes(-adjust.by), "earlier"].join(
        " ",
      );
    }
  } else if ("at" in adjust) {
    sentence = ["move", `${opQ}'s`, "start", "to", formatClock(adjust.at), ...placeParts].join(" ");
  } else if (adjust.by > 0) {
    sentence = [
      "move",
      `${opQ}'s`,
      "start",
      "by",
      ...formatDurationMinutes(adjust.by),
      ...placeParts,
    ].join(" ");
  } else {
    sentence = [
      "move",
      `${opQ}'s`,
      "start",
      ...formatDurationMinutes(-adjust.by),
      "earlier",
      ...placeParts,
    ].join(" ");
  }
  if (command.day) sentence += ` on ${dayToCanonicalText(command.day)}`;
  return sentence;
}

function formatMoveCommand(command: MoveCommand): string {
  if (command.adjust !== null) return formatAdjustCommand(command);

  const parts: string[] = ["move", quoteIfNeeded(command.operator)];
  if (command.place.length > 0) {
    parts.push("on", quoteIfNeeded(command.place[0]));
    for (let i = 1; i < command.place.length; i++) {
      parts.push("in", quoteIfNeeded(command.place[i]));
    }
  }
  if (command.toPlace) {
    parts.push("to", quoteIfNeeded(command.toPlace[0]));
    for (let i = 1; i < command.toPlace.length; i++) {
      parts.push("in", quoteIfNeeded(command.toPlace[i]));
    }
  }
  if (command.day) {
    parts.push("on", dayToCanonicalText(command.day));
  }
  // R-402/R-404: a shift or boundary clause in place of new hours -- `span`
  // is null whenever `shift` is not.
  if (command.shift !== null) {
    parts.push(...formatShiftOrBoundary(command.shift, null));
  } else if (command.span) {
    parts.push(
      "from",
      `${pad2(command.span.start.hour)}:${pad2(command.span.start.minute)}`,
      "to",
      `${pad2(command.span.end.hour)}:${pad2(command.span.end.minute)}`,
    );
  }
  return parts.join(" ");
}

/**
 * S58 (R-413): the canonical sentence for a `SplitCommand` -- `split <op>
 * [on <cell> [in <line>]] [on <day>] at HH:MM`.
 */
function formatSplitCommand(command: SplitCommand): string {
  const parts: string[] = ["split", quoteIfNeeded(command.operator)];
  if (command.place.length > 0) {
    parts.push("on", quoteIfNeeded(command.place[0]));
    for (let i = 1; i < command.place.length; i++) {
      parts.push("in", quoteIfNeeded(command.place[i]));
    }
  }
  if (command.day) {
    parts.push("on", dayToCanonicalText(command.day));
  }
  parts.push("at", formatClock(command.at));
  return parts.join(" ");
}

/**
 * S58 (R-415): the canonical sentence for a `HeadcountCommand` -- `make the
 * <product> job on <cell> [in <line>] [on <day>] [from HH:MM to HH:MM | for
 * shift <name>] <n> people`. Always "make" (never "set", PV4's own
 * canonical-verb rule applied to the one new list).
 */
function formatHeadcountCommand(command: HeadcountCommand): string {
  const parts: string[] = ["make", "the", quoteIfNeeded(command.product), "job"];
  parts.push("on", quoteIfNeeded(command.place[0]));
  for (let i = 1; i < command.place.length; i++) {
    parts.push("in", quoteIfNeeded(command.place[i]));
  }
  if (command.day) {
    parts.push("on", dayToCanonicalText(command.day));
  }
  if (command.shift !== null) {
    parts.push("for", "shift", quoteShiftIfNeeded(command.shift));
  } else if (command.span) {
    parts.push("from", formatClock(command.span.start), "to", formatClock(command.span.end));
  }
  parts.push(String(command.headcount), "people");
  return parts.join(" ");
}

/**
 * The canonical sentence for a `Command` — the inverse of `parseCommand` for
 * whichever shape the command's `intent` names. The bar rebuilds the input
 * from this after a candidate button is pressed. Never prints `attach` or
 * `existing`.
 *
 * S50: a `several`'s sentence is its inner commands' own sentences joined by
 * `"; "` -- a `;` is not grammar (brief §2 item 3), so `parseCommand` of
 * THIS string need not reproduce the same several; only each inner
 * command's own sentence round-trips on its own.
 */
export function formatCommand(command: Command): string {
  if (command.intent === "several") return command.commands.map((c) => formatCommand(c)).join("; ");
  if (command.intent === "book") return formatBookCommand(command);
  if (command.intent === "unassign") return formatUnassignCommand(command);
  if (command.intent === "move") return formatMoveCommand(command);
  if (command.intent === "replace") return formatReplaceCommand(command);
  if (command.intent === "swap") return formatSwapCommand(command);
  if (command.intent === "copy") return formatCopyCommand(command);
  if (command.intent === "split") return formatSplitCommand(command);
  if (command.intent === "headcount") return formatHeadcountCommand(command);
  return formatAssignCommand(command);
}

/** The one sentence the bar shows when parsing fails (brief §3: the three
 *  shapes in one sentence, S41-b adds the third, S41-c a fourth). */
export function expectedShape(): string {
  return "Say it like: assign <person> to <part> on <cell> [in <line>] [on <day>] from <time> to <time> [on <day>] — or: book <part> on <cell> [in <line>] [for <n> people] [on <day>] from <time> to <time> [on <day>] — or: unassign <person> from <cell> [in <line>] [on <day>] [from <time> to <time> [on <day>]] — or: move <person> on <cell> [in <line>] [to <cell> [in <line>]] [on <day>] [from <time> to <time> [on <day>]]";
}
