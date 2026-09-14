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

/** Which day, as the person said it. `null` = "the day the board is showing". */
export type DayWord =
  | { kind: "today" }
  | { kind: "tomorrow" }
  | { kind: "weekday"; day: 0 | 1 | 2 | 3 | 4 | 5 | 6 } // 0 = Sunday
  | { kind: "date"; iso: string }; // "2026-09-04"

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
 */
export type Existing = { kind: "retime"; assignmentId: string } | { kind: "separate" };

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
   *  instead. Read but not yet resolved -- `resolve.ts` asks
   *  `shift_unsupported` for now; the next lane turns it into that cell's own
   *  band for the day. */
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

export type Command = AssignCommand | BookCommand | UnassignCommand | MoveCommand | SeveralCommand;

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
  | { kind: "shift_and_hours" };

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

/** S41-b, widened by R-391. */
export const UNASSIGN_VERBS = [
  "unassign",
  "remove",
  "clear",
  "drop",
  "cancel",
  "delete",
  "pull",
  "free",
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

/** The first word decides book vs assign. Built from `BOOK_VERBS`. */
const BOOK_VERB_RE = new RegExp(`^(${BOOK_VERBS.join("|")})\\b\\s*`, "i");

/** The first word decides unassign vs everything else. Built from `UNASSIGN_VERBS`. */
const UNASSIGN_VERB_RE = new RegExp(`^(${UNASSIGN_VERBS.join("|")})\\b\\s*`, "i");

/** The first word decides move vs everything else. Built from `MOVE_VERBS`. */
const MOVE_VERB_RE = new RegExp(`^(${MOVE_VERBS.join("|")})\\b\\s*`, "i");

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

const DAY_TAIL_RE = new RegExp(
  `(^|\\s)(on\\s+)?(today|tomorrow|${WEEKDAY_ALTS}|\\d{4}-\\d{2}-\\d{2})\\s*$`,
  "i",
);

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** F-1xx: the browser's speech recogniser writes "7:00 p.m." / "8 a.m." with
 *  dots -- `a\.?m\.?`/`p\.?m\.?` accepts the plain `am`/`pm` this already
 *  read, plus `a.m.`/`p.m.`/`a.m`/`p.m` (any case, the trailing dot always
 *  optional since `parseCommand` strips one sentence-final period before
 *  this ever runs). Normalised by stripping dots before the am/pm check
 *  below, so nothing past this line needs to know the dotted form exists. */
const TIME_TOKEN_RE = /^(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?$/i;

/** S41-a: only `for <digits>` is a headcount clause (brief §3, B5) — a `for`
 *  not followed by a whole number is ordinary place text ("for lunch"). */
const HEADCOUNT_CLAUSE_RE = /\s+for\s+(\S+)(?:\s+(?:people|persons|operators|heads))?\s*$/i;

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
  const end = parseTimeToken(endRaw);
  if (!end) return { ok: false, failure: { kind: "bad_time", text: endRaw.trim() } };

  // 2. The afternoon rule (F-134: gated on the START, applyAfternoonRule).
  const adjustedEnd = applyAfternoonRule(start, end);
  if (!adjustedEnd) return { ok: false, failure: { kind: "time_order" } };

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

  const start = parseTimeToken(startRaw);
  if (!start) return { ok: false, failure: { kind: "bad_time", text: startRaw.trim() } };
  const end = parseTimeToken(endRaw);
  if (!end) return { ok: false, failure: { kind: "bad_time", text: endRaw.trim() } };

  const adjustedEnd = applyAfternoonRule(start, end);
  if (!adjustedEnd) return { ok: false, failure: { kind: "time_order" } };

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
 */
function parseUnassignRest(rest: string, quotes: string[]): ParseResult {
  // R-402: the shift clause, read before the (optional) time clause and the
  // places -- "for shift 1" on a removal means span null, shift "1", never
  // hours to compute.
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

  // F-133: merge the leading day (dayResult) with the trailing one
  // `extractOptionalTimeClause` may have read off the end of the hours.
  const merged = mergeDay(
    { day: dayResult.day, word: dayResult.word },
    { day: tc.trailingDay, word: tc.trailingWord },
  );
  if (!merged.ok) return merged;

  const { operator: operatorPart, placesText } = splitOperatorPlaces(dayResult.rest);
  if (operatorPart === "") return { ok: false, failure: { kind: "empty" } };

  const pieces = placesText === "" ? [] : splitProductPlaces(placesText);
  if (pieces.length === 0 && placesText !== "") return { ok: false, failure: { kind: "no_place" } };

  // S50 (brief §2 item 3): the OPERATOR segment may list more than one name.
  const operatorList = detectAndList(operatorPart, true);
  if (operatorList.kind === "bad")
    return { ok: false, failure: { kind: "bad_list", text: operatorPart } };

  if (operatorList.kind === "list") {
    const commands = operatorList.items.map((op) => ({
      intent: "unassign" as const,
      operator: restoreQuotes(op, quotes),
      place: pieces.map((p) => restoreQuotes(p, quotes)),
      day: merged.day,
      span: tc.span,
      existing: null,
      shift,
    }));
    return { ok: true, command: { intent: "several", commands } };
  }

  const operator = restoreQuotes(operatorPart, quotes);
  const place = pieces.map((p) => restoreQuotes(p, quotes));

  return {
    ok: true,
    command: {
      intent: "unassign",
      operator,
      place,
      day: merged.day,
      span: tc.span,
      existing: null,
      shift,
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
    const end = parseTimeToken(endRaw);
    if (!end) return { ok: false, failure: { kind: "bad_time", text: endRaw.trim() } };

    const adjustedEnd = applyAfternoonRule(start, end);
    if (!adjustedEnd) return { ok: false, failure: { kind: "time_order" } };

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
  // R-402: the shift clause, read before the time clause and the places.
  const shiftClause = extractShiftClause(rest, quotes);
  const shift = shiftClause.shift;
  rest = shiftClause.rest;

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
      operator: restoreQuotes(op, quotes),
      place,
      toPlace,
      day,
      span,
      existing: null,
      shift,
    }));
    return { ok: true, command: { intent: "several", commands } };
  }

  const finalOperator = restoreQuotes(operator, quotes);
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
    },
  };
}

/** `assign <op> to <product> on <place1>...`, `book <product> on <place1>...`
 *  or `unassign <op> from <place1>...` (brief §3/§4). Case-insensitive,
 *  whitespace collapsed, a trailing `.` ignored, double-quoted segments
 *  atomic. The FIRST WORD decides the intent: `unassign`/`remove`/`clear` ->
 *  unassign; `book`/`run` -> book; anything else (including no verb at all)
 *  -> assign. */
export function parseCommand(text: string): ParseResult {
  const { text: quoted, quotes } = extractQuotes(text);
  let norm = quoted.replace(/\s+/g, " ").trim();
  if (norm.endsWith(".")) norm = norm.slice(0, -1).trim();
  if (norm === "") return { ok: false, failure: { kind: "empty" } };

  // S41-b: decided before the mandatory-time-clause path runs -- the
  // unassign grammar's time clause is OPTIONAL, so it cannot share
  // `parseTimeAndDay`'s "no_time" requirement.
  const unassignVerbMatch = norm.match(UNASSIGN_VERB_RE);
  if (unassignVerbMatch) {
    return parseUnassignRest(norm.slice(unassignVerbMatch[0].length), quotes);
  }

  // S41-c: decided before the mandatory-time-clause path runs too -- the
  // move grammar's time clause is OPTIONAL, exactly like unassign's.
  const moveVerbMatch = norm.match(MOVE_VERB_RE);
  if (moveVerbMatch) {
    return parseMoveRest(norm.slice(moveVerbMatch[0].length), quotes);
  }

  // R-402: a shift clause stands in for the mandatory hours on assign/book
  // too -- tried BEFORE `parseTimeAndDay`'s own (mandatory) time clause,
  // since a shift sentence need not have one at all.
  const shiftClause = extractShiftClause(norm, quotes);
  if (shiftClause.shift !== null) {
    const stillHasTime = parseTimeAndDay(shiftClause.rest);
    if (stillHasTime.ok) {
      // Both a shift and hours were said -- never a guess which wins.
      return { ok: false, failure: { kind: "shift_and_hours" } };
    }
    if (stillHasTime.failure.kind !== "no_time") {
      // A real time-clause problem, unrelated to the shift -- surface it.
      return stillHasTime;
    }
    const dayResult = extractDayWord(shiftClause.rest);
    if (!dayResult.ok) return dayResult;

    const bookVerbMatch = dayResult.rest.match(BOOK_VERB_RE);
    if (bookVerbMatch) {
      return parseBookRest(
        dayResult.rest.slice(bookVerbMatch[0].length),
        dayResult.day,
        null,
        null,
        quotes,
        shiftClause.shift,
      );
    }
    return parseAssignRest(dayResult.rest, dayResult.day, null, null, quotes, shiftClause.shift);
  }

  const td = parseTimeAndDay(norm);
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

function needsQuoting(word: string): boolean {
  return /\b(to|on|at|in)\b/i.test(word) || word.includes(",");
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

function dayToCanonicalText(day: DayWord): string {
  if (day.kind === "today") return "today";
  if (day.kind === "tomorrow") return "tomorrow";
  if (day.kind === "date") return day.iso;
  return WEEKDAY_ABBR[day.day];
}

/**
 * The canonical sentence for an `AssignCommand` — the inverse of
 * `parseAssignRest` for the §4 shape (24h times, `on … in …` places, names
 * quoted when they contain a separator word). Does NOT print `attach` or
 * `existing`.
 */
function formatAssignCommand(command: AssignCommand): string {
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
    parts.push("on", dayToCanonicalText(command.day));
  }
  // R-402: a shift clause prints in place of the hours; the invariant
  // (`shift` non-null <=> `start`/`end` null) means exactly one of the two
  // branches below ever runs.
  if (command.shift !== null) {
    parts.push("for", "shift", quoteShiftIfNeeded(command.shift));
  } else {
    parts.push(
      "from",
      `${pad2(command.start!.hour)}:${pad2(command.start!.minute)}`,
      "to",
      `${pad2(command.end!.hour)}:${pad2(command.end!.minute)}`,
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
    parts.push("on", dayToCanonicalText(command.day));
  }
  // R-402: a shift clause in place of the hours -- same invariant as `formatAssignCommand`.
  if (command.shift !== null) {
    parts.push("for", "shift", quoteShiftIfNeeded(command.shift));
  } else {
    parts.push(
      "from",
      `${pad2(command.start!.hour)}:${pad2(command.start!.minute)}`,
      "to",
      `${pad2(command.end!.hour)}:${pad2(command.end!.minute)}`,
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
  // R-402: a shift clause in place of the hours -- `span` is null whenever
  // `shift` is not (the type's own invariant).
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
function formatMoveCommand(command: MoveCommand): string {
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
  // R-402: a shift clause in place of new hours -- `span` is null whenever
  // `shift` is not.
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
  return formatAssignCommand(command);
}

/** The one sentence the bar shows when parsing fails (brief §3: the three
 *  shapes in one sentence, S41-b adds the third, S41-c a fourth). */
export function expectedShape(): string {
  return "Say it like: assign <person> to <part> on <cell> [in <line>] [on <day>] from <time> to <time> [on <day>] — or: book <part> on <cell> [in <line>] [for <n> people] [on <day>] from <time> to <time> [on <day>] — or: unassign <person> from <cell> [in <line>] [on <day>] [from <time> to <time> [on <day>]] — or: move <person> on <cell> [in <line>] [to <cell> [in <line>]] [on <day>] [from <time> to <time> [on <day>]]";
}
