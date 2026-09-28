/**
 * S71-m (docs/agent-briefs/s71-m-grounded-reading-brief.md, F-212/F-215;
 * R-435 "when in doubt ask", R-431 "nothing offered the server would
 * refuse"): a reading the MODEL hands back is not safe to run just because
 * it parses. F-215's transcript was `"EF76."` and the model answered an
 * unassign of everyone on the day, one press ("Do all 7") from clearing the
 * board. F-212's transcript lost its own leading "Assign Tom Baker to" and
 * the model answered a BOOKING with no person, written at once -- "read by
 * the model" was the only word that said a guess had happened at all.
 *
 * `groundReading` is the one check between "the model produced a `Command`"
 * and "the bar runs it": the heard text must contain, in some spelling
 * `parse.ts` itself accepts, the word that names the command's own intent.
 *
 * PURE, and held to `commandPurity.test.ts`'s U1 the same as every other
 * `.ts` file `fs.readdirSync`s out of this directory: every line here is
 * `import type` or nothing at all. The actual verb-list ARRAYS
 * (`ASSIGN_VERBS`, `BOOK_VERBS`, ... `parse.ts`'s own exports) travel in as
 * the `verbs` argument instead of a sibling import -- `CommandBar.tsx` sits
 * outside this directory and is free to import them at runtime, and does
 * (see its own `GROUNDING_VERBS` constant). That keeps this file exactly as
 * swappable as `resolve.ts` already is (that file's own doc, "so the later
 * local model can swap parse.ts out as a one-file change") -- extending the
 * one door to cover a NEW file dropped into this directory, not only the
 * two it names.
 *
 * A NOTE ON "board" (this piece's brief calls the group "(show/go
 * to...)"): nothing in this codebase reads a sentence as a board
 * NAVIGATION command -- there is no "show"/"go to" grammar anywhere in
 * `parse.ts`. What `parse.ts` actually calls the "board-answered" group
 * (D130 item 2's own name for it) is `BoardCommand`: `replace`/`swap`/
 * `copy`/`split`. CLAUDE.md's own "extract, never retype" standard means
 * that real union wins over the brief's prose example; see this lane's own
 * report for the same note, spelled out for the maintainer.
 */
import type { Command } from "./parse";

export type Grounding =
  { ok: true } | { ok: false; intent: string; reason: "no_intent_word" | "sweeping" };

/**
 * One accepted-spelling list per intent this module checks, handed in by
 * the caller rather than imported (see this file's own header doc). Three
 * of these are not simply `parse.ts`'s own same-named export -- two found
 * by running `commandBar.test.tsx`'s existing model-reader cases red first
 * (this lane's own brief §2), the third by a reviewer reading `parse.ts`
 * directly -- `CommandBar.tsx`'s own `GROUNDING_VERBS` constant carries the
 * full story for each:
 *
 *   - `unassign` must also accept `parse.ts`'s `ABSENCE_WORDS` ("off", "on
 *     leave", ...) -- R-409's own grammar reads "Sam is off today" as a
 *     removal exactly as much as "clear Cell 1" is (CB-x-14 pins it).
 *   - `move` must also accept `parse.ts`'s `ADJUST_VERBS` ("extend",
 *     "shorten", ...) -- `parseAdjustRest` dispatches every one of them to
 *     `intent: "move"` (CB-y-15 pins it).
 *   - `copy` must also accept `parse.ts`'s `SAME_AS_WORDS` ("same as") --
 *     `SAME_AS_RE` is checked before `COPY_VERB_RE` and dispatches to the
 *     same `intent: "copy"` (GR-15 pins it).
 *
 * A multi-word entry (`"on leave"`, `"same as"`) is matched as a whole
 * phrase, not a bag of words -- see `hasAnyWord` below.
 */
export interface VerbLists {
  assign: readonly string[];
  book: readonly string[];
  unassign: readonly string[];
  move: readonly string[];
  headcount: readonly string[];
  replace: readonly string[];
  swap: readonly string[];
  copy: readonly string[];
  split: readonly string[];
}

/** Lowercased, every run of non-alphanumeric characters collapsed to one
 *  space, padded with a leading/trailing space -- so a whole-word (or
 *  whole-phrase) membership check is one `includes` against `" word "`,
 *  case and punctuation never in the way (GR-10). */
function normalize(text: string): string {
  return ` ${text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()} `;
}

/** S72-a (R-456): exported so `verbGuess.ts` can reuse the same whole-word
 *  membership check rather than a second, hand-retyped copy of it (CLAUDE.md
 *  §4 "extract, never retype") -- `normalized` must already be `normalize`'s
 *  own shape (lowercased, padded, punctuation collapsed to single spaces). */
export function hasAnyWord(normalized: string, words: readonly string[]): boolean {
  return words.some((w) => normalized.includes(` ${w.toLowerCase()} `));
}

/** "clear, remove or unassign" -- the phrase a refusal names, built from
 *  the list itself rather than a second, hand-picked copy of a few of its
 *  words (CLAUDE.md §4, "extract, never retype"). */
function wordsPhrase(words: readonly string[]): string {
  if (words.length === 0) return "";
  if (words.length === 1) return words[0];
  return `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}`;
}

const SINGLE_KEYS = [
  "assign",
  "book",
  "unassign",
  "move",
  "headcount",
  "replace",
  "swap",
  "copy",
  "split",
] as const;
type SingleKey = (typeof SINGLE_KEYS)[number];

function isSingleKey(intent: string): intent is SingleKey {
  return (SINGLE_KEYS as readonly string[]).includes(intent);
}

/** DEF-0041 (28 Sept, tester) first fixed this by splitting the unassign
 *  words into strong and everyday ones; the reviewer (S194-D) showed a strong
 *  word alone and an everyday word beside "everyone"/"board" anywhere both
 *  still grounded ordinary speech. THE RULE below replaces that split. */
/** R-407's reserved operator word ("clear the whole board" parses with
 *  `operator: "everyone"`) -- hardcoded, not imported: this file's purity
 *  rule (header doc) forbids a runtime import of `parse.ts`'s own `EVERYONE`
 *  export, the same reason `GROUNDING_VERBS` (`CommandBar.tsx`) hands the
 *  verb lists in rather than this file importing them. */
const SWEEPING_OPERATOR = "everyone";

/** DEF-0041: a removal with no named person AND no named place -- "clear
 *  everyone", "clear the board", the F-215/GR-1 shape (`unassignCmd()`'s own
 *  default). Anything else (a named person, or a place the sentence
 *  narrowed the removal to) is a NARROW removal and keeps today's looser
 *  rule -- see `EVERYDAY_UNASSIGN_WORDS`' own doc above. */
function isSweepingUnassign(command: { operator: string; place: string[] }): boolean {
  return command.operator.trim().toLowerCase() === SWEEPING_OPERATOR && command.place.length === 0;
}

/**
 * DEF-0041 / F-215, S194-D third pass (the main session's rule, in the safe
 * direction): THE RULE. A sweeping clear read by the model (no named person,
 * no named place -- one press from emptying the whole board) is grounded ONLY
 * when the heard text holds a REMOVAL PHRASE: a removal word BOUND to a word
 * for everyone or the board, never merely both present somewhere. Three
 * shapes, and nothing else: (1) a removal verb with "everyone"/"everybody"
 * starting within the next three words ("clear everyone", "remove
 * everybody"), or with "the board"/"the whole board" DIRECTLY after it
 * ("clear the board", "wipe the board", "empty the board"); (2) a verb that
 * needs its particle, with "everyone"/"everybody" directly after it and the
 * particle directly after that ("take everyone off", "get everyone off",
 * "pull everyone off", "send everyone home"); (3) "everyone"/"everybody"
 * directly followed by "out"/"off" ("everybody out", "everyone off") -- a
 * word between them ("everyone IS out to lunch") makes it a statement about
 * people, not an order, so it does not count. Each phrase must also END its
 * clause: after it may come only the end of the sentence or a comma, "the
 * board" ("take everyone off the board", "remove everyone from the board"),
 * or a word that only says when ("today", "Monday"); "the board ROOM bins",
 * "everyone off TO the canteen", "remove everyone FROM THE GROUP CHAT" are
 * about something else. A possessive ("everyone's plates") is never the
 * object, and no phrase reaches across a comma. A bare strong word ("clear
 * skies today", "cancel my lunch") no longer grounds, nor does an everyday
 * word beside a pairing word anywhere ("the board meeting is off"). Refusing
 * more is the safe side: a refusal only asks the person to say it again.
 * The narrow cases (a named person or place) keep the older rule unchanged.
 * Data below, one small matcher (`hasRemovalPhrase`).
 */
const SWEEP_PEOPLE = ["everyone", "everybody"];
/** Shape (1): a removal verb, then a people word within this many words. */
const SWEEP_VERB_REACH = 3;
const SWEEP_VERBS = ["clear", "remove", "unassign", "empty", "wipe", "delete"];
/** Shape (1), the board: only these word sequences, directly after the verb. */
const SWEEP_BOARD_OBJECTS = [
  ["the", "board"],
  ["the", "whole", "board"],
];
/** Shape (2): verb, then a people word, then its particle, each adjacent. */
const SWEEP_PARTICLE_VERBS: ReadonlyArray<{ verb: string; particles: string[] }> = [
  { verb: "take", particles: ["off", "out", "away"] },
  { verb: "get", particles: ["off", "out"] },
  { verb: "pull", particles: ["off", "out"] },
  { verb: "send", particles: ["home"] },
];
/** Shape (3): a people word directly followed by one of these. */
const SWEEP_ORDER_PARTICLES = ["out", "off"];
/** What may FOLLOW a board object (shape 1), a particle (shape 2) or an
 *  order (shape 3) for the phrase to still be the whole order: the end of
 *  the clause, "the board" itself ("take everyone off the board"), or a
 *  word that only says WHEN. Anything else ("the board ROOM bins", "out
 *  FOR pizza", "off TO the canteen") makes it about something other than
 *  the board. A people word followed by "s" is a possessive ("everyone's
 *  old messages"), never the object. A comma, full stop or other clause
 *  mark is a break the phrase may not reach across. */
const SWEEP_TAIL_WORDS = [
  "today",
  "tomorrow",
  "tonight",
  "now",
  "please",
  "early",
  "this",
  "next",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];
const BREAK = "|";

function startsWithAt(tokens: readonly string[], at: number, seq: readonly string[]): boolean {
  return seq.every((w, k) => tokens[at + k] === w);
}

/** True when the words from `at` on end the clause or only say when. */
function endsClause(t: readonly string[], at: number): boolean {
  const next = t[at];
  if (next === undefined || next === BREAK || SWEEP_TAIL_WORDS.includes(next)) return true;
  if (startsWithAt(t, at, ["the", "board"])) return endsClause(t, at + 2);
  for (const lead of ["of", "from", "off"]) {
    if (startsWithAt(t, at, [lead, "the", "board"])) return endsClause(t, at + 3);
  }
  return false;
}

/** The heard text as words, clause marks kept as a break token. */
function sweepTokens(heard: string): string[] {
  return heard
    .toLowerCase()
    .replace(/[.,;:!?]+/g, ` ${BREAK} `)
    .replace(/[^a-z0-9|]+/g, " ")
    .trim()
    .split(/\s+/);
}

function isPeople(t: readonly string[], at: number): boolean {
  return SWEEP_PEOPLE.includes(t[at]) && t[at + 1] !== "s";
}

/** The one matcher for the three shapes of THE RULE, over whole words. */
function hasRemovalPhrase(heard: string): boolean {
  const t = sweepTokens(heard);
  for (let i = 0; i < t.length; i++) {
    const w = t[i];
    if (SWEEP_VERBS.includes(w)) {
      for (let k = 1; k <= SWEEP_VERB_REACH && t[i + k] !== BREAK; k++) {
        if (!isPeople(t, i + k)) continue;
        // "clear everyone", "clear everyone out", "remove everyone from the
        // board" -- never "remove everyone from the group chat".
        const after = i + k + 1;
        const tail =
          SWEEP_ORDER_PARTICLES.includes(t[after]) || t[after] === "away" ? after + 1 : after;
        if (endsClause(t, tail)) return true;
      }
      const board = SWEEP_BOARD_OBJECTS.find((seq) => startsWithAt(t, i + 1, seq));
      if (board && endsClause(t, i + 1 + board.length)) return true;
    }
    const pv = SWEEP_PARTICLE_VERBS.find((p) => p.verb === w);
    if (pv && isPeople(t, i + 1) && pv.particles.includes(t[i + 2]) && endsClause(t, i + 3)) {
      return true;
    }
    if (isPeople(t, i) && SWEEP_ORDER_PARTICLES.includes(t[i + 1]) && endsClause(t, i + 2)) {
      return true;
    }
  }
  return false;
}

/** DEF-0041's own stricter check for the sweeping case alone -- see THE RULE
 *  just above. */
function groundSweepingUnassign(heard: string, verbs: VerbLists): Grounding {
  if (hasRemovalPhrase(heard)) return { ok: true };
  return { ok: false, reason: "sweeping", intent: wordsPhrase(verbs.unassign) };
}

/**
 * One `SingleCommand`/board-command/headcount reading against its own verb
 * list. `unassign` is the one kind this piece's own reason rule (brief §1)
 * never lets ask: an ungrounded removal always refuses outright
 * (`"sweeping"`) rather than offering a button -- a write that deletes data
 * gets the stricter of the two, never a guess one press from running.
 *
 * DEF-0041: `command` (not just its `intent`) is needed to tell a SWEEPING
 * unassign (`isSweepingUnassign`, above) from a narrow one -- the stricter
 * word check applies only to the former.
 */
function groundOne(
  heard: string,
  normalized: string,
  command: Exclude<Command, { intent: "several" }>,
  verbs: VerbLists,
): Grounding {
  const intent = command.intent;
  const list: readonly string[] = isSingleKey(intent) ? verbs[intent] : [];
  if (intent === "unassign" && isSweepingUnassign(command)) {
    return groundSweepingUnassign(heard, verbs);
  }
  if (hasAnyWord(normalized, list)) return { ok: true };
  if (intent === "unassign") {
    return { ok: false, reason: "sweeping", intent: wordsPhrase(verbs.unassign) };
  }
  return { ok: false, reason: "no_intent_word", intent };
}

/**
 * `heard`/`command` as the model answered them, `verbs` as the caller
 * extracted them from `parse.ts` (see this file's own header doc for why
 * that extraction cannot happen in here). A `several`'s members are each
 * grounded on their own; a lot of more than one command with NO word for
 * ANY of them is the F-215 shape one level up -- "Do all N" one press away
 * from a totally baseless reading -- and refuses the same way a wide
 * ungrounded unassign does.
 *
 * S71-m review fix (R-435): a MIXED several -- some members grounded, one
 * (or more) not -- must never be refused whole just because the ungrounded
 * member happens to be an unassign. `groundOne`'s own "unassign is always
 * sweeping" rule is right for a STANDALONE unassign (nothing else in the
 * reading to weigh it against) and for a several where NOTHING is grounded
 * (the `allUngrounded` branch above already refuses that whole reading);
 * for a mixed lot it is downgraded to `no_intent_word` here -- the one-
 * button question, `formatCommand` naming every member (its own `several`
 * branch already joins them with "; "), never a silent refusal of the
 * grounded members along with the one that is not.
 */
export function groundReading(heard: string, command: Command, verbs: VerbLists): Grounding {
  const normalized = normalize(heard);
  if (command.intent === "several") {
    const results = command.commands.map((c) => groundOne(heard, normalized, c, verbs));
    const allUngrounded = results.every((r) => !r.ok);
    if (command.commands.length > 1 && allUngrounded) {
      return { ok: false, reason: "sweeping", intent: "run more than one command" };
    }
    const firstBad = results.find((r) => !r.ok);
    if (!firstBad) return { ok: true };
    // Only an ungrounded `unassign` member ever comes back "sweeping"
    // (`groundOne`, above) -- downgraded to the plain kind label a
    // `no_intent_word` result normally carries, never the words-phrase a
    // standalone refusal's message would have used.
    if (firstBad.reason === "sweeping") {
      return { ok: false, reason: "no_intent_word", intent: "unassign" };
    }
    return firstBad;
  }
  return groundOne(heard, normalized, command, verbs);
}

/**
 * S72-e (docs/agent-briefs/s72-e-clear-over-a-week-brief.md §3, F-224,
 * R-435): a SECOND, independent check beside `groundReading` above -- that
 * one asks "did the heard text name this command's VERB"; this one asks
 * "did the heard text name a DAY, and did the command keep one". F-224's own
 * trace is exactly this shape twice over: the model's unassign form has no
 * week kind at all, so "clear Cell 5 for the whole week" came back
 * `day: null` (today) with the week simply gone; the rules grammar (before
 * this lane's own §1 work) swallowed the same words into the PLACE instead.
 * Neither reader said a word about it -- the board just did less than it was
 * asked, silently, which is exactly what R-435 ("when in doubt, ask") exists
 * to stop.
 *
 * Checked on the finished `command`, never re-derived from `heard` -- a day
 * carried correctly (`command.day !== null`, or for `unassign` the `until`
 * clause that stands in for one) is not a drop even when the printed word
 * is not the word said (R-435 is about SILENCE, never paraphrase -- the same
 * distinction `groundReading`'s own header doc draws for a verb).
 */
export type DayGrounding = { ok: true } | { ok: false; reason: "day_dropped"; phrase: string };

/** An ISO-shaped date said aloud ("2026-09-04") -- checked by shape, not as
 *  a literal word in the caller's `dayWords` list (there is no bounded list
 *  of every date), the same way `parse.ts`'s own `ISO_DATE_RE` reads one. */
const ISO_DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/;

/** Every SINGLE command's own day-shaped field(s), by intent -- a `several`
 *  is handled one level up by `groundDays` itself, never here (its own
 *  members are always one of these). A `copy`'s `from`/`to` are REQUIRED,
 *  non-null `DayWord`s in the type itself (`parse.ts`'s own `CopyCommand`
 *  doc) -- there is no shape in which a copy silently carries no day at
 *  all, so it is always "kept" here; listed anyway, for totality, the same
 *  reason `WEEK_WORD.last_week` is listed in `resolve.ts` though nothing
 *  ever produces it. */
function commandCarriesNoDay(command: Exclude<Command, { intent: "several" }>): boolean {
  if (command.intent === "unassign") return command.day === null && command.until === null;
  if (command.intent === "copy") return false;
  return command.day === null;
}

/**
 * `heard`/`command` as the model (or the rules) answered them, `dayWords`
 * as the caller extracted from `parse.ts` (`DAY_GROUNDING_WORDS` --
 * `CommandBar.tsx`'s own import, this file's header doc explains why the
 * list travels in rather than being imported here). A `several`'s members
 * are checked together: a phrase said once for the whole sentence is not a
 * drop as long as AT LEAST ONE member kept a day (the same "mixed lot"
 * caution `groundReading` takes for a verb, just above) -- flagged only
 * when EVERY member lost it, F-224's own shape one level up.
 */
export function groundDays(
  heard: string,
  command: Command,
  dayWords: readonly string[],
): DayGrounding {
  const normalized = normalize(heard);
  const isoMatch = heard.match(ISO_DATE_RE);
  const phrase = isoMatch ? isoMatch[0] : dayWords.find((w) => hasAnyWord(normalized, [w]));
  if (phrase === undefined) return { ok: true };
  if (command.intent === "several") {
    const anyKept = command.commands.some((c) => !commandCarriesNoDay(c));
    return anyKept ? { ok: true } : { ok: false, reason: "day_dropped", phrase };
  }
  return commandCarriesNoDay(command) ? { ok: false, reason: "day_dropped", phrase } : { ok: true };
}
