// scripts/voice/clips/lib/score.mjs — S71-c (brief
// docs/agent-briefs/s71-c-clip-harness-brief.md §1.B): the pure half of the
// clip scorer -- normalisation, word error rate, name hits, and the exact
// match test -- with no I/O, so `src/test/voiceClips.test.ts` can pin it
// directly. `scripts/voice/clips/score.mjs` is the only caller; it does the
// network and file work and prints/writes what this file computes.

/** Plant A's own names (docs/agent-briefs/s71-c-clip-harness-brief.md §0),
 *  in the order `buildRecognizerHint` walks them (cells, places, parts,
 *  people) -- the default `names` list `nameHits` scores a sentence
 *  against when the caller does not pass its own. */
export const BOARD_NAMES = [
  "Cell 1",
  "Cell 2",
  "Cell 3",
  "Cell 4",
  "Cell 5",
  "Cell 6",
  "Area 1",
  "Area 2",
  "Line 1",
  "Line 2",
  "Line 3",
  "Housing A",
  "Bracket A",
  "Common Fastener",
  "Line 1 Subassembly A",
  "Area 2 Frame A",
  "Sam Patel",
  "Maria Lopez",
  "John Kim",
  "Priya Shah",
  "Tom Baker",
  "Lena Novak",
];

const CARDINAL_WORDS = {
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
  eleven: "11",
  twelve: "12",
};

const ORDINAL_WORDS = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  eleventh: 11,
  twelfth: 12,
  thirteenth: 13,
  fourteenth: 14,
  fifteenth: 15,
  sixteenth: 16,
  seventeenth: 17,
  eighteenth: 18,
  nineteenth: 19,
  twentieth: 20,
  thirtieth: 30,
};

const TENS_ORDINAL_PREFIX = { twenty: 20, thirty: 30 };

/** Normalises `text` for comparison (brief §1.B): lower-case; `a.m.`/`am`/
 *  `a m` -> `am` (same for `pm`); spelled numbers one..twelve -> digits;
 *  `twenty-eighth`/`28th` -> `28`; apostrophes dropped with no gap
 *  (`patel's` -> `patels`); punctuation stripped; whitespace collapsed.
 *  Never throws on an empty string. */
export function normalizeText(text) {
  let s = String(text ?? "").toLowerCase();

  // Review finding: an apostrophe used to fall into the generic punctuation
  // strip below, which turns any non-word character into a SPACE -- so
  // "Patel's" became "patel s", a dangling extra word "s" that "Patels"
  // (no apostrophe) never had, scoring two spellings of the same name 0.67
  // WER apart. Dropped here, before anything else, with no replacement
  // character at all -- "patel's" and "patels" both come out "patels".
  s = s.replace(/['’]/g, "");

  // Review finding: a digit glued straight to "am"/"pm" ("8am", "12pm") is
  // ONE run of word characters (digits and letters are both `\w`), so no
  // `\b` ever sits between the digit and the letter -- the dotted/spaced
  // rules below never fired on it, and "8am" scored a WER of 2.0 against
  // "8 a.m."/"8 AM"/"eight am". Splitting the digit from a trailing
  // "am"/"pm" first means every later step (the dotted/spaced rules here,
  // and the cardinal-word rule further down for "eight am") lands on the
  // same two tokens.
  s = s.replace(/(\d)(am|pm)\b/g, "$1 $2");

  // am/pm, dotted or spaced, before punctuation is stripped -- a bare `\b`
  // right after a consumed trailing period sits between two non-word
  // characters and never matches, so these are literal, not `\b`-anchored
  // at the tail.
  s = s.replace(/\ba\.m\.?/g, "am");
  s = s.replace(/\bp\.m\.?/g, "pm");
  s = s.replace(/\ba\s+m\b/g, "am");
  s = s.replace(/\bp\s+m\b/g, "pm");

  // Hyphenated ordinal words ("twenty-eighth") -> digits, before the
  // generic punctuation strip below would otherwise turn the hyphen into a
  // word break and lose the tens part.
  s = s.replace(/\b(twenty|thirty)-(\w+)\b/g, (whole, tensWord, onesWord) => {
    const tens = TENS_ORDINAL_PREFIX[tensWord];
    const ones = ORDINAL_WORDS[onesWord] ?? Number(CARDINAL_WORDS[onesWord]);
    if (tens !== undefined && Number.isFinite(ones)) return String(tens + ones);
    return whole;
  });

  // Digit ordinal suffix: 28th -> 28.
  s = s.replace(/\b(\d+)(st|nd|rd|th)\b/g, "$1");

  // Bare ordinal/cardinal words -> digits.
  s = s.replace(/\b[a-z]+\b/g, (word) => {
    if (word in ORDINAL_WORDS) return String(ORDINAL_WORDS[word]);
    if (word in CARDINAL_WORDS) return CARDINAL_WORDS[word];
    return word;
  });

  // Strip remaining punctuation (periods, commas, hyphens left over from a
  // non-ordinal hyphenated word, ...) to a space. Apostrophes are already
  // gone (dropped with no gap, above) -- if they landed here too they would
  // turn "patel's" into "patel s" again.
  s = s.replace(/[^\w\s]/g, " ");

  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/** Levenshtein edit distance between two word arrays. */
function wordEditDistance(refWords, hypWords) {
  const n = refWords.length;
  const m = hypWords.length;
  const d = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 0; i <= n; i++) d[i][0] = i;
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (refWords[i - 1] === hypWords[j - 1]) {
        d[i][j] = d[i - 1][j - 1];
      } else {
        d[i][j] = 1 + Math.min(d[i - 1][j], d[i][j - 1], d[i - 1][j - 1]);
      }
    }
  }
  return d[n][m];
}

/** Word error rate: normalised Levenshtein distance over the words / the
 *  normalised reference's word count. An empty reference is a WER of 0
 *  against an empty hypothesis, 1 otherwise (never a divide-by-zero). */
export function wordErrorRate(reference, hypothesis) {
  const refWords = normalizeText(reference).split(" ").filter(Boolean);
  const hypWords = normalizeText(hypothesis).split(" ").filter(Boolean);
  if (refWords.length === 0) return hypWords.length === 0 ? 0 : 1;
  return wordEditDistance(refWords, hypWords) / refWords.length;
}

/** True when the normalised reference and hypothesis are the same string. */
export function isExact(reference, hypothesis) {
  return normalizeText(reference) === normalizeText(hypothesis);
}

/** True when `haystackWord` is `needleWord`, or `needleWord` with a bare
 *  possessive "s" merged onto it -- `normalizeText`'s apostrophe drop turns
 *  "Kim's" into the single token "kims" (never "kim s"), so a name whose
 *  last word is spoken possessively in the sentence ("John Kim's block")
 *  would otherwise never token-match "Kim" at all. Only the trailing "s"
 *  case is allowed, not a general prefix match, so an unrelated longer word
 *  that happens to start with the name is not counted. */
function wordMatchesAllowingPossessive(haystackWord, needleWord) {
  return haystackWord === needleWord || haystackWord === `${needleWord}s`;
}

/** Whether `needleWords` appears as a contiguous run inside `haystackWords`
 *  -- every word but the last matched exactly, the last allowing a merged
 *  possessive "s" (see `wordMatchesAllowingPossessive`). */
function containsSequence(haystackWords, needleWords) {
  if (needleWords.length === 0) return true;
  const lastIndex = needleWords.length - 1;
  for (let i = 0; i + needleWords.length <= haystackWords.length; i++) {
    let ok = true;
    for (let j = 0; j < needleWords.length; j++) {
      const matches =
        j === lastIndex
          ? wordMatchesAllowingPossessive(haystackWords[i + j], needleWords[j])
          : haystackWords[i + j] === needleWords[j];
      if (!matches) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/** For each name in `names` (default `BOARD_NAMES`) that appears in the
 *  normalised `reference`, whether it also appears in the normalised
 *  `hypothesis` -- brief §1.B. Returns `{ hits, total, missed }`, `missed`
 *  being the names present in the reference but not heard. A name absent
 *  from the reference is not counted at all (in either direction). */
export function nameHits(reference, hypothesis, names = BOARD_NAMES) {
  const refWords = normalizeText(reference).split(" ").filter(Boolean);
  const hypWords = normalizeText(hypothesis).split(" ").filter(Boolean);
  let hits = 0;
  let total = 0;
  const missed = [];
  for (const name of names) {
    const nameWords = normalizeText(name).split(" ").filter(Boolean);
    if (!containsSequence(refWords, nameWords)) continue;
    total++;
    if (containsSequence(hypWords, nameWords)) {
      hits++;
    } else {
      missed.push(name);
    }
  }
  return { hits, total, missed };
}
