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

function hasAnyWord(normalized: string, words: readonly string[]): boolean {
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

/**
 * One `SingleCommand`/board-command/headcount reading against its own verb
 * list. `unassign` is the one kind this piece's own reason rule (brief §1)
 * never lets ask: an ungrounded removal always refuses outright
 * (`"sweeping"`) rather than offering a button -- a write that deletes data
 * gets the stricter of the two, never a guess one press from running.
 */
function groundOne(normalized: string, intent: string, verbs: VerbLists): Grounding {
  const list: readonly string[] = isSingleKey(intent) ? verbs[intent] : [];
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
    const results = command.commands.map((c) => groundOne(normalized, c.intent, verbs));
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
  return groundOne(normalized, command.intent, verbs);
}
