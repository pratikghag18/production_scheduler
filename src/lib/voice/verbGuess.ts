/**
 * S72-a (R-456, F-222): the verb the board did not hear, offered as a choice.
 * The maintainer, session 191: "even if it did not hear assign, it should
 * have figured out that I was trying to assign someone and give me an
 * option accordingly" -- a grammar hint is not an option, and a model
 * invention ("move") that was never asked is worse than a refusal (R-435
 * "when in doubt, ask"; R-430 "a dead end offers the nearest choices",
 * applied to a VERB instead of a person/place/product/day).
 *
 * Reviewer (S72-a): this lane originally lived at `src/lib/command/
 * verbGuess.ts` and reached `parse.ts`'s real `parseCommand`/`formatCommand`
 * through a top-level `await import(...)` -- a line whose own first word is
 * "const", not "import", chosen specifically because `commandPurity.test.ts`'s
 * U1 (`commandModuleOffences`) is a textual check that only flags lines
 * starting with the literal word "import". That is gaming the audit's
 * wording, not meeting its purpose: U1's own header says the point of
 * `src/lib/command/` importing nothing at runtime is that "the later local
 * model can swap `parse.ts` out as a one-file change" -- a file in that same
 * directory that runtime-imports `parse.ts` (through any door) defeats
 * exactly that, whether or not U1's regex happens to notice. This file
 * genuinely needs the real parser (rule 5: build a candidate sentence, then
 * ask `parseCommand` itself whether it is honest, never a second hand-rolled
 * copy of its grammar -- CLAUDE.md's own "extract, never retype"), so it
 * does not belong inside `src/lib/command/` at all. Moved to
 * `src/lib/voice/` -- the heard-sentence side, which already imports
 * (type-only, so far) from `src/lib/command/parse.ts` at runtime and is
 * never walked by U1's `fs.readdirSync` in the first place -- with plain
 * static imports below. `CommandBar.tsx` (lane S72-b, editing concurrently)
 * still imports this file from its OLD path (`@/lib/command/verbGuess`);
 * the exact one-line fix for the main session to make once S72-b lands is
 * in this lane's report.
 */
import type { VerbLists } from "@/lib/command/grounded";
import { hasAnyWord } from "@/lib/command/grounded";
import { parseCommand, formatCommand } from "@/lib/command/parse";

/** One candidate reading of a sentence with a verb put in. `label` is the
 *  board's own reading of `sentence` (`formatCommand` of its parse), the
 *  words the button shows; `sentence` is the text the press runs. */
export interface VerbGuess {
  verb: string;
  sentence: string;
  label: string;
}

/** Same shape as `grounded.ts`'s own private `normalize` -- duplicated
 *  rather than imported (that function is not exported, and the one export
 *  this lane is allowed to add there is `hasAnyWord` alone, per brief §0).
 *  Lowercased, every run of non-alphanumeric characters collapsed to one
 *  space, padded with a leading/trailing space. */
function normalize(text: string): string {
  return ` ${text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()} `;
}

function allVerbWords(verbs: VerbLists): readonly (readonly [keyof VerbLists, string])[] {
  const out: [keyof VerbLists, string][] = [];
  const keys: (keyof VerbLists)[] = [
    "assign",
    "book",
    "unassign",
    "move",
    "headcount",
    "replace",
    "swap",
    "copy",
    "split",
  ];
  for (const key of keys) {
    for (const word of verbs[key]) out.push([key, word]);
  }
  return out;
}

/** Plain Levenshtein edit distance, case-insensitive callers only (both
 *  arguments are expected already lower-cased). */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  return dp[m][n];
}

/**
 * The hand table of known Whisper/small.en confusions the four trace
 * complaints (and the maintainer's earlier rounds) actually produced --
 * consulted BEFORE the general Levenshtein pass (§2 rule 3). Multi-word
 * entries are matched as the sentence's first TWO words, single-word
 * entries as the first word alone. Table-driven so a future addition is
 * one line (`VG-table-*` in `verbGuess.test.ts` walks this array itself).
 */
export const VERB_CONFUSIONS: ReadonlyArray<readonly [string, string]> = [
  ["and", "end"],
  ["an", "end"],
  ["close", "end"],
  ["so", "swap"],
  ["show up", "swap"],
  ["swab", "swap"],
  ["a sign", "assign"],
  ["sign", "assign"],
  ["a string", "assign"],
  ["assigned", "assign"],
  ["book it", "book"],
  ["split it", "split"],
  ["spit", "split"],
  ["extent", "extend"],
  ["and of", "end"],
];

/** A clock time ("10", "10:30", "8 am", "7 p.m."), "noon"/"midnight", one of
 *  the domain nouns, a two-capitalised-word name, or a "'s" possessive --
 *  §2 rule 2's five shape signals, verbatim off the brief. */
const CLOCK_TIME_RE = /\d{1,2}(:\d{2})?\s*(am|pm|a\.m\.|p\.m\.)?/i;
const NOON_MIDNIGHT_RE = /\b(noon|midnight)\b/i;
const DOMAIN_WORD_RE = /\b(block|assignment|shift|cell|line|area|job|people)\b/i;
const CAP_NAME_RE = /\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/;
const POSSESSIVE_RE = /[A-Za-z](?:'|’)s\b/;

function looksLikeCommand(heard: string): boolean {
  return (
    CLOCK_TIME_RE.test(heard) ||
    NOON_MIDNIGHT_RE.test(heard) ||
    DOMAIN_WORD_RE.test(heard) ||
    CAP_NAME_RE.test(heard) ||
    POSSESSIVE_RE.test(heard)
  );
}

function stripLeadingPunct(text: string): string {
  return text.replace(/^[\s,.:;!?"]+/, "");
}

/** The next bare word at the front of `text` (letters/apostrophes only,
 *  case preserved) plus everything left after it, punctuation and all --
 *  `sentence`-building (§2 rule 5) needs the ORIGINAL remainder verbatim,
 *  never a re-joined, punctuation-stripped one. `null` when `text` starts
 *  with nothing word-shaped at all (`"7 to 3..."`, a bare number). */
function leadingWord(text: string): { word: string; rest: string } | null {
  const s = stripLeadingPunct(text);
  const m = s.match(/^([A-Za-z']+)/);
  if (!m) return null;
  return { word: m[1], rest: s.slice(m[1].length) };
}

interface WordMatch {
  /** The literal text matched at the front of the sentence -- one word or
   *  two -- so `describeVerbGuess` can name exactly what it heard. */
  heardText: string;
  /** The replacement verb word (a table hit's own mapped word, or the verb
   *  list entry a close Levenshtein match landed on). */
  verb: string;
  /** Sentence remainder AFTER `heardText`, original spacing/punctuation. */
  rest: string;
  /** Sort key: table hits first (distance -1), then real edit distance. */
  distance: number;
}

/** §2 rule 3, factored out so `guessVerbs` and `describeVerbGuess`'s own
 *  helper (`misheardWord`, below) never disagree about what "the sentence
 *  sounded like a verb" means -- one place, not two hand-synced copies. */
function soundAlikeMatches(heard: string, verbs: VerbLists): WordMatch[] {
  const first = leadingWord(heard);
  if (!first) return [];
  const w1 = first.word.toLowerCase();
  const second = leadingWord(first.rest);
  const w2 = second ? `${w1} ${second.word.toLowerCase()}` : null;

  const matches: WordMatch[] = [];
  const seenVerbs = new Set<string>();

  // Table, longest phrase first -- checked before any Levenshtein pass.
  for (const [key, verb] of VERB_CONFUSIONS) {
    if (w2 !== null && key === w2 && second) {
      matches.push({
        heardText: `${first.word} ${second.word}`,
        verb,
        rest: second.rest,
        distance: -1,
      });
      seenVerbs.add(verb);
    }
  }
  if (matches.length === 0) {
    for (const [key, verb] of VERB_CONFUSIONS) {
      if (key === w1) {
        matches.push({ heardText: first.word, verb, rest: first.rest, distance: -1 });
        seenVerbs.add(verb);
        break;
      }
    }
  }

  // Levenshtein pass against every list, declared order, W1 only.
  const threshold = w1.length <= 3 ? 1 : 2;
  const scored: WordMatch[] = [];
  for (const [, word] of allVerbWords(verbs)) {
    if (seenVerbs.has(word)) continue;
    const d = levenshtein(w1, word.toLowerCase());
    if (d <= threshold) {
      scored.push({ heardText: first.word, verb: word, rest: first.rest, distance: d });
      seenVerbs.add(word);
    }
  }
  scored.sort((a, b) => a.distance - b.distance);
  matches.push(...scored);
  return matches;
}

/** §2 rule 4: the verb was not heard at all -- rank by sentence SHAPE,
 *  fixed order (assign, book, unassign, move, split, end), each a plain
 *  boolean read off the whole sentence. These are this lane's own
 *  heuristics for "a person"/"a place"/"a part"/"hours"/"a span"/"one at
 *  time" -- `parse.ts`'s real grammar is the only thing that gets the last
 *  word (rule 5 below drops anything it refuses); this is a coarse, honest
 *  guess at what is even worth trying, documented here rather than assumed
 *  shared knowledge (see this lane's report, "departures from §2 rule 4"). */
function shapeCandidates(heard: string): string[] {
  const hasPersonName = CAP_NAME_RE.test(heard);
  const hasPlace = /\b(cell|line|area)\b/i.test(heard);
  const hasPart = /\bjob\b/i.test(heard) || (/\bon\b/i.test(heard) && !hasPersonName);
  const hasHours = /\bfrom\b/i.test(heard) && CLOCK_TIME_RE.test(heard);
  const hasBlockTail = /(?:'|’|(?<=\d)s)\s*s?\s+(block|assignment)\b/i.test(heard);
  const hasSpanOrTo = /\bto\b/i.test(heard) && !/'s|’s/.test(heard.split(/\bto\b/i)[0] ?? "");
  const hasAtClause = /\bat\b/i.test(heard) && CLOCK_TIME_RE.test(heard);

  // "Tom Baker to Cell 3" reads as an assign candidate above; without that
  // same "to <place>" shape ruled out here too, "unassign" fires ALONGSIDE
  // it for the same words and -- because UNASSIGN_VERBS' own grammar has no
  // place clause at all -- swallows "Tom Baker to Cell 3" whole as one
  // quoted operator name rather than failing (found running VG-8; see this
  // lane's report).
  const looksLikeAssign = hasPersonName && hasPlace;

  const out: string[] = [];
  if (hasPersonName && hasPlace) out.push("assign");
  if (hasPart && hasPlace && !hasPersonName) out.push("book");
  if (hasPersonName && !hasHours && !looksLikeAssign) out.push("unassign");
  if (hasBlockTail && (hasSpanOrTo || /\bto\b/i.test(heard))) out.push("move");
  if (hasBlockTail && hasAtClause) out.push("split");
  if (hasBlockTail && hasAtClause) out.push("end");
  return out.slice(0, 3);
}

/** Result of the one shared walk `guessVerbs` and `misheardVerbWord` both
 *  need -- factored out (reviewer, S72-a): the original code ran the
 *  sound-alike pass, and the instant it found ANY sound-alike candidate
 *  ("Ed" ~ "end", distance 1) returned early even when every one of those
 *  candidates failed to parse -- "Ed Kim to Cell 3 from 8 a.m. to 12 p.m.
 *  today." (a NAME, "Ed Kim", that happens to sound like "end") got `[]`
 *  and never fell through to try the SHAPE guess ("assign Ed Kim to Cell 3
 *  ...", which parses cleanly) -- a dead end with a real answer sitting
 *  right there, exactly what R-430 says not to do. `heardWord` must track
 *  which branch actually produced the returned guesses -- a plain
 *  `soundAlike.length > 0` check (the original `misheardVerbWord`) claims
 *  "I heard Ed" even on a sentence whose candidates all came from the SHAPE
 *  branch (the name "Ed" was never replaced), so it is computed here from
 *  the SAME branch the guesses themselves came from, not recomputed
 *  independently. */
function computeVerbGuess(
  heard: string,
  verbs: VerbLists,
): { guesses: VerbGuess[]; heardWord: string } {
  const normalized = normalize(heard);
  // Rule 1: already has a verb.
  for (const key of Object.keys(verbs) as (keyof VerbLists)[]) {
    if (hasAnyWord(normalized, verbs[key])) return { guesses: [], heardWord: "" };
  }
  // Rule 2: no shape of a command at all.
  if (!looksLikeCommand(heard)) return { guesses: [], heardWord: "" };

  const soundAlike = soundAlikeMatches(heard, verbs);
  const usedVerbs = new Set<string>();

  if (soundAlike.length > 0) {
    const built: VerbGuess[] = [];
    for (const m of soundAlike) {
      if (built.length >= 3) break;
      if (usedVerbs.has(m.verb)) continue;
      const sentence = `${m.verb}${m.rest}`.trim();
      const parsed = parseCommand(sentence);
      if (!parsed.ok) continue;
      built.push({ verb: m.verb, sentence, label: formatCommand(parsed.command) });
      usedVerbs.add(m.verb);
    }
    // Only report this branch's candidates -- and only name what it
    // replaced -- when at least one of them actually parsed. Otherwise
    // fall through to rule 4: the sound-alike hit was a dead end, not
    // evidence the sentence has no honest reading at all.
    if (built.length > 0) return { guesses: built, heardWord: soundAlike[0].heardText };
  }

  // Rule 4: the verb was simply not heard (or every sound-alike reading
  // above failed to parse) -- prefix, never replace.
  const built: VerbGuess[] = [];
  for (const verb of shapeCandidates(heard)) {
    if (built.length >= 3) break;
    if (usedVerbs.has(verb)) continue;
    const sentence = `${verb} ${heard}`.trim();
    const parsed = parseCommand(sentence);
    if (!parsed.ok) continue;
    built.push({ verb, sentence, label: formatCommand(parsed.command) });
    usedVerbs.add(verb);
  }
  return { guesses: built, heardWord: "" };
}

/**
 * The verbs a sentence with no (or a misheard) command word could have meant,
 * best first, at most three; `[]` when the sentence already carries a verb the
 * board knows, or has no shape of a command at all (no person, place, part or
 * hour), in which case the caller keeps its old answer.
 */
export function guessVerbs(heard: string, verbs: VerbLists): VerbGuess[] {
  return computeVerbGuess(heard, verbs).guesses;
}

/**
 * S72-a's own addition, beyond the two exports the brief names (§2's last
 * paragraph only specifies `describeVerbGuess(heardWord, guesses)`, not how
 * the bar is meant to come by `heardWord` without re-running this file's
 * detection logic a second time) -- the exact word or two-word phrase
 * `guessVerbs` replaced to reach its first candidate, or `""` when the
 * candidates came from sentence SHAPE alone (rule 4: the verb was not heard
 * at all, nothing to name). `CommandBar.tsx` calls this once, then passes
 * its result straight into `describeVerbGuess`.
 *
 * CALLER CONTRACT (reviewer, S72-a: corrected): this now shares
 * `computeVerbGuess` with `guessVerbs` itself, so the two never disagree --
 * `""` whenever the guesses `guessVerbs` returns came from sentence SHAPE
 * (rule 4), including when a sound-alike hit existed but every candidate it
 * produced failed to parse (see `computeVerbGuess`'s own comment: "Ed Kim to
 * Cell 3 ..." sounds like "end" but the only guesses that survive are
 * SHAPE-based "assign" ones, so this correctly answers "", not "Ed").
 */
export function misheardVerbWord(heard: string, verbs: VerbLists): string {
  return computeVerbGuess(heard, verbs).heardWord;
}

/** The question's own text -- the bar appends the candidate buttons after
 *  this. `heardWord` is `misheardVerbWord`'s own answer: the literal word a
 *  candidate replaced, or `""` when the verb was simply missing. */
export function describeVerbGuess(heardWord: string, _guesses: VerbGuess[]): string {
  if (heardWord === "") return "Did you mean:";
  return `I heard "${heardWord}". Did you mean:`;
}
