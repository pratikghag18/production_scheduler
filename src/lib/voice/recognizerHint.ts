/**
 * S59-c (brief docs/agent-briefs/s59-c-whisper-hint-brief.md §1, design-plan
 * §19.104 / D133 item 4) — whisper.cpp's server takes an initial prompt (the
 * multipart field `prompt`, confirmed against the running container:
 * `curl -F file=@… -F prompt="…" 127.0.0.1:8090/inference` measurably
 * changes what comes back -- "Operator A3 on Housing A on Cell 1" instead of
 * "operator a3 on housing a on cell 1") that biases what it hears. D133 item
 * 4: "The bar hands it the names on the board (cells, lines, parts, people)
 * and the bar's own vocabulary (cell, shift, job, the digits), built once
 * per board window, capped in length. It does not fix a quiet microphone;
 * it fixes 'cell' heard as 'sell' and 'A' as 'pay'."
 *
 * Pure and side-effect free: `BoardPage.tsx` is the only caller, memoised on
 * its own `commandCtx` (`recognizerHint.test.ts` covers this file alone).
 */

/** The bar's own words, ahead of any board name -- D133 item 4's own list,
 *  verbatim, plus the ten digits spelled and typed (the model's own two
 *  forms for a headcount or a shift index, S55/S58's own commands). */
const VOCABULARY =
  "cell, line, shift, job, people, everyone, assign, book, remove, move, cover, swap, split, extend, one two three four five six seven eight nine ten, 1 2 3 4 5 6 7 8 9 10";

/** Roughly whisper.cpp's own comfortable prompt length -- long enough to
 *  carry a full plant's worth of cells and parts, short enough that the
 *  model does not start weighting the prompt over the actual audio. */
const MAX_WORDS = 200;

export interface RecognizerHintNames {
  cells: readonly string[];
  places: readonly string[];
  parts: readonly string[];
  people: readonly string[];
}

/** Cuts `text` to at most `maxWords` whitespace-separated words, ON a word
 *  boundary -- the 200th word's own end, never mid-word -- and drops a
 *  trailing comma the cut might otherwise leave dangling. `text` is
 *  returned untouched when it is already short enough. */
function capAtWords(text: string, maxWords: number): string {
  const words = [...text.matchAll(/\S+/g)];
  if (words.length <= maxWords) return text;
  const last = words[maxWords - 1];
  const end = last.index + last[0].length;
  return text.slice(0, end).replace(/,\s*$/, "");
}

/**
 * `buildRecognizerHint(names)` -- brief §1. One line: the bar's own
 * vocabulary first, then the names in board order (`cells`, then `places`,
 * then `parts`, then `people` -- each array's own order kept, never
 * resorted), de-duplicated case-insensitively across all four lists (a name
 * that is also a place, or repeated within one list, is written once, at
 * its first occurrence), joined by ", ", cut at roughly 200 words on a word
 * boundary. An empty board (every list empty) is the vocabulary alone.
 */
export function buildRecognizerHint(names: RecognizerHintNames): string {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const list of [names.cells, names.places, names.parts, names.people]) {
    for (const raw of list) {
      const name = raw.trim();
      if (name === "") continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      ordered.push(name);
    }
  }
  const full = ordered.length === 0 ? VOCABULARY : `${VOCABULARY}, ${ordered.join(", ")}`;
  return capAtWords(full, MAX_WORDS);
}
