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
 * Pre-seated as a type-only skeleton by the developer session (11 Sept) so the
 * two build lanes compile against one interface. Lane A fills the bodies.
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

export type ParseFailure =
  | { kind: "empty" }
  | { kind: "no_time" } // no "from <time> to <time>" clause at the end
  | { kind: "bad_time"; text: string }
  | { kind: "time_order" } // end not after start even after the afternoon rule
  | { kind: "no_product" } // operator given, nothing after it
  | { kind: "no_place" } // operator and product given, no place
  | { kind: "bad_day"; text: string };

export type ParseResult =
  { ok: true; command: AssignCommand } | { ok: false; failure: ParseFailure };

// ---------------------------------------------------------------------------
// Private helpers. None of these are exported; the model that later replaces
// this file owes nothing to their shape.
// ---------------------------------------------------------------------------

/** Private-use placeholders for quoted segments, so whitespace collapsing and
 *  keyword splitting never look inside a quoted name (brief §4, P17). */
const QUOTE_OPEN = "";
const QUOTE_CLOSE = "";

const VERBS = ["assign", "put", "schedule", "add"];

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
 *  `midnight`. `hasMeridiem` is what the afternoon rule (brief §4.2) keys on. */
function parseTimeToken(
  raw: string,
): { hour: number; minute: number; hasMeridiem: boolean } | null {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  if (lower === "noon") return { hour: 12, minute: 0, hasMeridiem: true };
  if (lower === "midnight") return { hour: 0, minute: 0, hasMeridiem: true };
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
    return { hour, minute, hasMeridiem: true };
  }
  if (hourRaw < 0 || hourRaw > 23) return null;
  return { hour: hourRaw, minute, hasMeridiem: false };
}

function totalMinutes(t: { hour: number; minute: number }): number {
  return t.hour * 60 + t.minute;
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

/** `assign <op> to <product> on <place1>...` (brief §4). Case-insensitive,
 *  whitespace collapsed, a trailing `.` ignored, double-quoted segments atomic. */
export function parseCommand(text: string): ParseResult {
  const { text: quoted, quotes } = extractQuotes(text);
  let norm = quoted.replace(/\s+/g, " ").trim();
  if (norm.endsWith(".")) norm = norm.slice(0, -1).trim();
  if (norm === "") return { ok: false, failure: { kind: "empty" } };

  // 1. Time clause — the LAST "from <time> <sep> <time>" at the end.
  const fromRe = /\bfrom\b/gi;
  let lastFrom = -1;
  let fm: RegExpExecArray | null;
  while ((fm = fromRe.exec(norm)) !== null) {
    lastFrom = fm.index;
  }
  if (lastFrom === -1) return { ok: false, failure: { kind: "no_time" } };

  const beforeFrom = norm.slice(0, lastFrom).trim();
  const timeClauseText = norm.slice(lastFrom + "from".length).trim();
  const timeMatch = timeClauseText.match(/^(.+?)\s+(to|-|–|until|till)\s+(.+)$/i);
  if (!timeMatch) return { ok: false, failure: { kind: "no_time" } };
  const [, startRaw, , endRaw] = timeMatch;

  const start = parseTimeToken(startRaw);
  if (!start) return { ok: false, failure: { kind: "bad_time", text: startRaw.trim() } };
  let end = parseTimeToken(endRaw);
  if (!end) return { ok: false, failure: { kind: "bad_time", text: endRaw.trim() } };

  // 2. The afternoon rule.
  if (!end.hasMeridiem && !(totalMinutes(end) > totalMinutes(start))) {
    end = { ...end, hour: (end.hour + 12) % 24 };
  }
  if (!(totalMinutes(end) > totalMinutes(start))) {
    return { ok: false, failure: { kind: "time_order" } };
  }

  // 3. Day word, immediately before the time clause.
  let rest = beforeFrom;
  let day: DayWord | null = null;
  const dayMatch = rest.match(DAY_TAIL_RE);
  if (dayMatch) {
    const word = dayMatch[3];
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

  // 4. Verb — optional leading assign/put/schedule/add.
  const verbMatch = rest.match(new RegExp(`^(${VERBS.join("|")})\\s+`, "i"));
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

  const pieces = productPlaces
    .split(/\s+on\s+|\s+at\s+|\s+in\s+|\s*,\s*/gi)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
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
      start: { hour: start.hour, minute: start.minute },
      end: { hour: end.hour, minute: end.minute },
      attach: null,
      existing: null,
    },
  };
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
 * The canonical sentence for a command — the inverse of `parseCommand` for the
 * §4 shape (24h times, `on … in …` places, names quoted when they contain a
 * separator word). The bar rebuilds the input from this after a candidate
 * button is pressed. Does NOT print `attach`.
 */
export function formatCommand(command: AssignCommand): string {
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

/** The one sentence the bar shows when parsing fails (brief §6). */
export function expectedShape(): string {
  return "Say it like: assign <person> to <part> on <cell> [in <line>] [on <day>] from <time> to <time>";
}
