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
  start: ClockTime;
  end: ClockTime;
  attach: Attach | null;
  existing: Existing | null;
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
  /** Place words, most specific first — same shape as `AssignCommand.place`. At least one. */
  place: string[];
  day: DayWord | null;
  /** null when the sentence gave no hours: the whole day. */
  span: { start: ClockTime; end: ClockTime } | null;
  /** The pressed button's answer; null until asked. */
  existing: { kind: "remove"; assignmentId: string } | null;
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
  start: ClockTime;
  end: ClockTime;
  /** R-387: the answer to "change that job's hours?" — null until asked. */
  existing: { kind: "retime"; runId: string } | null;
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
  /** WHERE the block is now. Most specific first, at least one. */
  place: string[];
  /** The new cell, most specific first -- or null for a move in time only. */
  toPlace: string[] | null;
  day: DayWord | null;
  /** The new hours, or null to keep the block's own. */
  span: { start: ClockTime; end: ClockTime } | null;
  /** Which block, when several match; null until asked. */
  existing: { kind: "move"; assignmentId: string } | null;
}

export type Command = AssignCommand | BookCommand | UnassignCommand | MoveCommand;

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
  | { kind: "no_move" };

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
 * the one door). "shift" (a noun everywhere else in this app -- a shift
 * chip, a shift pattern) and "change" (too broad) are never verbs here, on
 * purpose, in any list.
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

/** S41-c, widened by R-391. */
export const MOVE_VERBS = ["move", "reschedule", "transfer", "relocate", "switch"] as const;

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

const TIME_TOKEN_RE = /^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?$/i;

/** S41-a: only `for <digits>` is a headcount clause (brief §3, B5) — a `for`
 *  not followed by a whole number is ordinary place text ("for lunch"). */
const HEADCOUNT_CLAUSE_RE = /\s+for\s+(\S+)(?:\s+(?:people|persons|operators|heads))?\s*$/i;

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
  const meridiem = m[3] ? m[3].toLowerCase() : null;
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

function parseAssignRest(
  rest: string,
  day: DayWord | null,
  start: ClockTime,
  end: ClockTime,
  quotes: string[],
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

  const pieces = splitProductPlaces(productPlaces);
  if (pieces.length === 0) return { ok: false, failure: { kind: "no_product" } };
  if (pieces.length === 1) return { ok: false, failure: { kind: "no_place" } };

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
  start: ClockTime,
  end: ClockTime,
  quotes: string[],
): ParseResult {
  const hc = extractHeadcount(rest);
  if (!hc.ok) return { ok: false, failure: hc.failure };
  const middle = hc.rest;

  if (middle.trim() === "") return { ok: false, failure: { kind: "no_product" } };

  const pieces = splitProductPlaces(middle);
  if (pieces.length === 0) return { ok: false, failure: { kind: "no_product" } };
  if (pieces.length === 1) return { ok: false, failure: { kind: "no_place" } };

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
 */
function parseUnassignRest(rest: string, quotes: string[]): ParseResult {
  const tc = extractOptionalTimeClause(rest);
  if (!tc.ok) return tc;

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
  if (placesText === "") return { ok: false, failure: { kind: "no_place" } };

  const pieces = splitProductPlaces(placesText);
  if (pieces.length === 0) return { ok: false, failure: { kind: "no_place" } };

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
 */
function parseMoveRest(rest: string, quotes: string[]): ParseResult {
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
  if (placesText === "") return { ok: false, failure: { kind: "no_place" } };

  // The FIRST " to " splits the current place(s) from the new place(s) --
  // never the last, since a qualifier never uses "to" (on/at/in/comma only).
  const toMatch = placesText.match(/\s+to\s+/i);
  let placeText = placesText;
  let toPlaceText: string | null = null;
  if (toMatch && toMatch.index !== undefined) {
    placeText = placesText.slice(0, toMatch.index).trim();
    toPlaceText = placesText.slice(toMatch.index + toMatch[0].length).trim();
  }

  let day: DayWord | null = null;
  let dayWord: string | null = null;
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

  // F-133: merge with the trailing day either time-clause helper may have
  // read off the end of the hours.
  const merged = mergeDay({ day, word: dayWord }, { day: trailingDay, word: trailingWord });
  if (!merged.ok) return merged;
  day = merged.day;

  const pieces = splitProductPlaces(placeText);
  if (pieces.length === 0) return { ok: false, failure: { kind: "no_place" } };

  const toPieces = toPlaceText !== null ? splitProductPlaces(toPlaceText) : [];
  const toPlace =
    toPlaceText !== null && toPieces.length > 0
      ? toPieces.map((p) => restoreQuotes(p, quotes))
      : null;

  // R-389: at least one of "a new cell" / "new hours" must be said.
  if (toPlace === null && span === null) {
    return { ok: false, failure: { kind: "no_move" } };
  }

  const operator = restoreQuotes(operatorPart, quotes);
  const place = pieces.map((p) => restoreQuotes(p, quotes));

  return {
    ok: true,
    command: {
      intent: "move",
      operator,
      place,
      toPlace,
      day,
      span,
      existing: null,
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

  const td = parseTimeAndDay(norm);
  if (!td.ok) return td;

  const bookVerbMatch = td.rest.match(BOOK_VERB_RE);
  if (bookVerbMatch) {
    return parseBookRest(td.rest.slice(bookVerbMatch[0].length), td.day, td.start, td.end, quotes);
  }
  return parseAssignRest(td.rest, td.day, td.start, td.end, quotes);
}

function needsQuoting(word: string): boolean {
  return /\b(to|on|at|in)\b/i.test(word) || word.includes(",");
}

function quoteIfNeeded(word: string): string {
  return needsQuoting(word) ? `"${word}"` : word;
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
  parts.push(
    "from",
    `${pad2(command.start.hour)}:${pad2(command.start.minute)}`,
    "to",
    `${pad2(command.end.hour)}:${pad2(command.end.minute)}`,
  );
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
  parts.push(
    "from",
    `${pad2(command.start.hour)}:${pad2(command.start.minute)}`,
    "to",
    `${pad2(command.end.hour)}:${pad2(command.end.minute)}`,
  );
  return parts.join(" ");
}

/**
 * S41-b: the canonical sentence for an `UnassignCommand` — `unassign <person>
 * from <cell> [in <line>] [on <day>] [from HH:MM to HH:MM]`. Does NOT print
 * `existing`; the time clause is printed only when `span` is not null.
 */
function formatUnassignCommand(command: UnassignCommand): string {
  const parts: string[] = ["unassign", quoteIfNeeded(command.operator)];
  parts.push("from", quoteIfNeeded(command.place[0]));
  for (let i = 1; i < command.place.length; i++) {
    parts.push("in", quoteIfNeeded(command.place[i]));
  }
  if (command.day) {
    parts.push("on", dayToCanonicalText(command.day));
  }
  if (command.span) {
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
 * S41-c: the canonical sentence for a `MoveCommand` — `move <person> on
 * <cell> [in <line>] [to <cell> [in <line>]] [on <day>] [from HH:MM to
 * HH:MM]` (always `from` for the hours when printing, whichever word the
 * sentence used). Does NOT print `existing`.
 */
function formatMoveCommand(command: MoveCommand): string {
  const parts: string[] = ["move", quoteIfNeeded(command.operator)];
  parts.push("on", quoteIfNeeded(command.place[0]));
  for (let i = 1; i < command.place.length; i++) {
    parts.push("in", quoteIfNeeded(command.place[i]));
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
  if (command.span) {
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
 */
export function formatCommand(command: Command): string {
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
