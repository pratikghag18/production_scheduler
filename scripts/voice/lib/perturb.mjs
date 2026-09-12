// scripts/voice/lib/perturb.mjs — the perturbation catalogue (S42-a §5).
// Every function here is `(sentence, rng) => sentence`: pure, and a no-op
// (returns the SAME string, `===`) when it finds nothing in `sentence` to
// perturb, so callers can tell "applied" from "not applicable" by identity.
// None of these touch a row's recorded `form` -- perturbed sentences carry
// the clean sentence's form unchanged (brief §2); that is enforced by the
// generator never re-deriving the form for a perturbed row, not by anything
// here.
import { randInt, chance } from "./rng.mjs";

const KEYWORDS = new Set([
  "assign",
  "put",
  "schedule",
  "add",
  "book",
  "run",
  "unassign",
  "remove",
  "clear",
  "move",
  "from",
  "to",
  "on",
  "at",
  "in",
  "off",
  "today",
  "tomorrow",
  "until",
  "till",
  "for",
  "people",
  "persons",
  "operators",
  "heads",
  "noon",
  "midnight",
  "am",
  "pm",
  "sun",
  "sunday",
  "mon",
  "monday",
  "tue",
  "tuesday",
  "wed",
  "wednesday",
  "thu",
  "thursday",
  "fri",
  "friday",
  "sat",
  "saturday",
]);

const NUMBER_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
  "twenty",
];

const LETTER_SOUND = {
  A: "eh",
  B: "bee",
  C: "see",
  D: "dee",
  E: "ee",
  F: "eff",
  G: "jee",
  H: "aitch",
  I: "eye",
  J: "jay",
  K: "kay",
  L: "el",
  M: "em",
  N: "en",
  O: "oh",
  P: "pee",
  Q: "cue",
  R: "are",
  S: "ess",
  T: "tee",
  U: "you",
  V: "vee",
  W: "double you",
  X: "ex",
  Y: "why",
  Z: "zee",
};

function wordTokens(sentence) {
  const out = [];
  const re = /[A-Za-z]+/g;
  let m;
  while ((m = re.exec(sentence)) !== null) {
    out.push({ word: m[0], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

function replaceAt(sentence, start, end, replacement) {
  return sentence.slice(0, start) + replacement + sentence.slice(end);
}

function dropLetter(word) {
  if (word.length < 3) return word;
  const mid = Math.floor(word.length / 2);
  return word.slice(0, mid) + word.slice(mid + 1);
}

function doubleLetter(word, rng) {
  const i = randInt(rng, 0, word.length - 1);
  return word.slice(0, i + 1) + word[i] + word.slice(i + 1);
}

function swapAdjacent(word, rng) {
  if (word.length < 2) return word;
  const i = randInt(rng, 0, word.length - 2);
  const chars = word.split("");
  const tmp = chars[i];
  chars[i] = chars[i + 1];
  chars[i + 1] = tmp;
  return chars.join("");
}

/** Picks one word token whose lowercase form is/is-not a grammar keyword,
 *  eligible by a minimum length, or null when none exists. */
function pickWord(sentence, rng, { keyword, minLen }) {
  const candidates = wordTokens(sentence).filter((t) => {
    const isKeyword = KEYWORDS.has(t.word.toLowerCase());
    return isKeyword === keyword && t.word.length >= minLen;
  });
  if (candidates.length === 0) return null;
  return candidates[randInt(rng, 0, candidates.length - 1)];
}

function spellOn({ keyword, mutate, minLen }) {
  return (sentence, rng) => {
    const tok = pickWord(sentence, rng, { keyword, minLen });
    if (!tok) return sentence;
    const mutated = mutate(tok.word, rng);
    if (mutated === tok.word) return sentence;
    return replaceAt(sentence, tok.start, tok.end, mutated);
  };
}

// ---------------------------------------------------------------------------
// Spelling -- a NAME (the common case) and, separately (lower weight, see
// `WEIGHTS` below), a KEYWORD ("assign" misheard as "a sign").
// ---------------------------------------------------------------------------

const spellDropName = spellOn({ keyword: false, minLen: 4, mutate: dropLetter });
const spellDoubleName = spellOn({ keyword: false, minLen: 3, mutate: doubleLetter });
const spellSwapName = spellOn({ keyword: false, minLen: 4, mutate: swapAdjacent });
const spellDropKeyword = spellOn({ keyword: true, minLen: 4, mutate: dropLetter });
const spellDoubleKeyword = spellOn({ keyword: true, minLen: 2, mutate: doubleLetter });
const spellSwapKeyword = spellOn({ keyword: true, minLen: 4, mutate: swapAdjacent });

// ---------------------------------------------------------------------------
// Speech -- what a recognizer actually mishears.
// ---------------------------------------------------------------------------

/** "Housing A" -> "Housing eh": a word followed by a lone capital letter. */
function speechLetterSound(sentence) {
  const re = /\b([A-Za-z]+) ([A-Z])\b/;
  const m = sentence.match(re);
  if (!m) return sentence;
  const sound = LETTER_SOUND[m[2]];
  if (!sound) return sentence;
  return sentence.slice(0, m.index) + `${m[1]} ${sound}` + sentence.slice(m.index + m[0].length);
}

/** "Cell 1" -> "sell one": the cell keyword misheard AND its number spelled
 *  out, exactly brief §5's own example. */
function speechCellSoundsLikeSell(sentence) {
  const re = /\bCell (\d{1,2})\b/i;
  const m = sentence.match(re);
  if (!m) return sentence;
  const n = Number(m[1]);
  if (n >= NUMBER_WORDS.length) return sentence;
  const replacement = `sell ${NUMBER_WORDS[n]}`;
  return sentence.slice(0, m.index) + replacement + sentence.slice(m.index + m[0].length);
}

/** "Line 1" -> "line one": the number spoken as a word, keyword untouched. */
function speechLineNumberWord(sentence) {
  const re = /\bLine (\d{1,2})\b/i;
  const m = sentence.match(re);
  if (!m) return sentence;
  const n = Number(m[1]);
  if (n >= NUMBER_WORDS.length) return sentence;
  const replacement = `line ${NUMBER_WORDS[n]}`;
  return sentence.slice(0, m.index) + replacement + sentence.slice(m.index + m[0].length);
}

/** The time-clause "to" heard as "two" or "too". */
function speechToAsTwoOrToo(sentence, rng) {
  const re = /\bto\b/g;
  const positions = [];
  let m;
  while ((m = re.exec(sentence)) !== null) positions.push(m.index);
  if (positions.length === 0) return sentence;
  const idx = positions[randInt(rng, 0, positions.length - 1)];
  const word = chance(rng, 0.5) ? "two" : "too";
  return replaceAt(sentence, idx, idx + 2, word);
}

/** Any bare number 0-20 spoken as a word -- brief's own example is "10" -> "ten". */
function speechDigitAsWord(sentence, rng) {
  const re = /\b\d{1,2}\b/g;
  const hits = [];
  let m;
  while ((m = re.exec(sentence)) !== null) {
    const n = Number(m[0]);
    if (n < NUMBER_WORDS.length) hits.push({ start: m.index, end: m.index + m[0].length, n });
  }
  if (hits.length === 0) return sentence;
  const hit = hits[randInt(rng, 0, hits.length - 1)];
  return replaceAt(sentence, hit.start, hit.end, NUMBER_WORDS[hit.n]);
}

/** "10am" / "10 am" -> "10 a m" (and the pm equivalent). */
function speechAmPmSpacedLetters(sentence) {
  const re = /\b(am|pm)\b/i;
  const m = sentence.match(re);
  if (!m) return sentence;
  const spaced = m[0].split("").join(" ");
  return sentence.slice(0, m.index) + spaced + sentence.slice(m.index + m[0].length);
}

/** Drops one comma -- a recognizer rarely transcribes punctuation. */
function speechMissingComma(sentence) {
  const idx = sentence.indexOf(",");
  if (idx === -1) return sentence;
  return sentence.slice(0, idx) + sentence.slice(idx + 1);
}

// ---------------------------------------------------------------------------
// Case and spacing.
// ---------------------------------------------------------------------------

function caseAllLower(sentence) {
  const lower = sentence.toLowerCase();
  return lower === sentence ? sentence : lower;
}

function caseAllUpper(sentence) {
  const upper = sentence.toUpperCase();
  return upper === sentence ? sentence : upper;
}

function spacingDoubleSpaces(sentence) {
  if (!sentence.includes(" ")) return sentence;
  return sentence.replace(/ /g, "  ");
}

function spacingTrailingPeriod(sentence) {
  if (sentence.endsWith(".")) return sentence;
  return `${sentence}.`;
}

function spacingNoSpaceAfterComma(sentence) {
  if (!sentence.includes(", ")) return sentence;
  return sentence.replace(/,\s+/g, ",");
}

// ---------------------------------------------------------------------------
// Filler.
// ---------------------------------------------------------------------------

function fillerPleaseStart(sentence) {
  return `please ${sentence}`;
}
function fillerCanYouStart(sentence) {
  return `can you ${sentence}`;
}
function fillerUmStart(sentence) {
  return `um ${sentence}`;
}
function fillerThanksEnd(sentence) {
  return `${sentence} thanks`;
}

// ---------------------------------------------------------------------------
// The catalogue.
// ---------------------------------------------------------------------------

export const CATALOG = {
  "spell-drop-name": spellDropName,
  "spell-double-name": spellDoubleName,
  "spell-swap-name": spellSwapName,
  "spell-drop-keyword": spellDropKeyword,
  "spell-double-keyword": spellDoubleKeyword,
  "spell-swap-keyword": spellSwapKeyword,
  "speech-letter-sound": speechLetterSound,
  "speech-cell-sounds-like-sell": speechCellSoundsLikeSell,
  "speech-line-number-word": speechLineNumberWord,
  "speech-to-as-two-or-too": speechToAsTwoOrToo,
  "speech-digit-as-word": speechDigitAsWord,
  "speech-am-pm-spaced-letters": speechAmPmSpacedLetters,
  "speech-missing-comma": speechMissingComma,
  "case-all-lower": caseAllLower,
  "case-all-upper": caseAllUpper,
  "spacing-double-spaces": spacingDoubleSpaces,
  "spacing-trailing-period": spacingTrailingPeriod,
  "spacing-no-space-after-comma": spacingNoSpaceAfterComma,
  "filler-please-start": fillerPleaseStart,
  "filler-canyou-start": fillerCanYouStart,
  "filler-um-start": fillerUmStart,
  "filler-thanks-end": fillerThanksEnd,
};

export const PERTURBATION_IDS = Object.keys(CATALOG);

/**
 * The form recorded for a PERTURBED row is always the clean row's own form,
 * whatever perturbation ids were applied -- a perturbation changes the
 * SENTENCE, never what it means (brief §2: "perturbed sentences carry the
 * clean sentence's form"). This is the one place in the pipeline that
 * decides a perturbed row's `form`, kept as its own function (rather than
 * inlined where it is called) so a careless future perturbation that wants
 * to also touch a field has exactly one place to do it -- and
 * `src/test/voiceData.test.ts`'s V3 is the test that turns red the day it
 * does.
 */
export function perturbedRowForm(cleanForm, _appliedIds) {
  return cleanForm;
}

/** Keyword-spelling perturbations are real (a recognizer does mishear
 *  "assign" as "a sign") but rarer than a misheard NAME (brief §5: "as
 *  separate perturbation ids with a lower weight"). */
const WEIGHTS = {
  "spell-drop-keyword": 0.35,
  "spell-double-keyword": 0.35,
  "spell-swap-keyword": 0.35,
};

function weightOf(id) {
  return WEIGHTS[id] ?? 1;
}

function weightedPickIndex(rng, ids) {
  const weights = ids.map(weightOf);
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < ids.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return ids.length - 1;
}

/**
 * Applies up to `n` DISTINCT perturbations (by id) to `sentence`, skipping
 * any that turn out not to apply (the sentence is unchanged) and trying
 * another instead. Returns `{ sentence, ids }` where `ids` names only the
 * ones that actually changed something -- that is what a row's `source`
 * field records (brief §3: `"<template id>+<perturbation ids>"`).
 */
export function perturbAll(sentence, rng, n) {
  const remaining = PERTURBATION_IDS.slice();
  const ids = [];
  let current = sentence;
  let guard = 0;
  while (ids.length < n && remaining.length > 0 && guard < 100) {
    guard++;
    const idx = weightedPickIndex(rng, remaining);
    const id = remaining[idx];
    remaining.splice(idx, 1);
    const next = CATALOG[id](current, rng);
    if (next !== current) {
      current = next;
      ids.push(id);
    }
  }
  return { sentence: current, ids };
}
