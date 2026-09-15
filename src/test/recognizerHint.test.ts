/**
 * S59-c (brief §1, design-plan §19.104 / D133 item 4) — `buildRecognizerHint`
 * pinned alone: order, de-duplication, the ~200-word cap, an empty board.
 */
import { describe, expect, it } from "vitest";
import { buildRecognizerHint } from "@/lib/voice/recognizerHint";

const VOCAB_WORD_COUNT =
  "cell, line, shift, job, people, everyone, assign, book, remove, move, cover, swap, split, extend, one two three four five six seven eight nine ten, 1 2 3 4 5 6 7 8 9 10".split(
    /\s+/,
  ).length; // 34: 14 single-word terms + 10 spelled digits + 10 typed digits

describe("RHINT: buildRecognizerHint (S59-c brief §1)", () => {
  it("RHINT-1: an empty board is the vocabulary alone", () => {
    const hint = buildRecognizerHint({ cells: [], places: [], parts: [], people: [] });
    expect(hint).toBe(
      "cell, line, shift, job, people, everyone, assign, book, remove, move, cover, swap, split, extend, one two three four five six seven eight nine ten, 1 2 3 4 5 6 7 8 9 10",
    );
  });

  it("RHINT-2: the vocabulary comes first, then names in board order -- cells, places, parts, people", () => {
    const hint = buildRecognizerHint({
      cells: ["Cell 1", "Cell 2"],
      places: ["Line A"],
      parts: ["Housing A"],
      people: ["Ana", "Sam"],
    });
    expect(hint.startsWith(`${vocab()}, Cell 1, Cell 2, Line A, Housing A, Ana, Sam`)).toBe(true);
  });

  it("RHINT-3: each list keeps its own order -- never resorted", () => {
    const hint = buildRecognizerHint({
      cells: ["Zeta Cell", "Alpha Cell"],
      places: [],
      parts: [],
      people: [],
    });
    expect(hint).toBe(`${vocab()}, Zeta Cell, Alpha Cell`);
  });

  it("RHINT-4: a name repeated within one list is written once, at its first occurrence", () => {
    const hint = buildRecognizerHint({
      cells: ["Cell 1", "Cell 1"],
      places: [],
      parts: [],
      people: [],
    });
    expect(hint).toBe(`${vocab()}, Cell 1`);
  });

  it("RHINT-5: a name repeated across lists is written once, case-insensitively", () => {
    // "Cell 1" is both a cell's own name and (implausibly, but the resolver
    // walks the whole node map) a place's -- the second copy is dropped.
    const hint = buildRecognizerHint({
      cells: ["Cell 1"],
      places: ["cell 1", "Line A"],
      parts: [],
      people: [],
    });
    expect(hint).toBe(`${vocab()}, Cell 1, Line A`);
  });

  it("RHINT-6: blank/whitespace-only names are dropped, not written as empty items", () => {
    const hint = buildRecognizerHint({
      cells: ["Cell 1", "  ", ""],
      places: [],
      parts: [],
      people: [],
    });
    expect(hint).toBe(`${vocab()}, Cell 1`);
  });

  it("RHINT-7: a name is trimmed before it is written or compared", () => {
    const hint = buildRecognizerHint({
      cells: ["  Cell 1  "],
      places: [],
      parts: [],
      people: [],
    });
    expect(hint).toBe(`${vocab()}, Cell 1`);
  });

  it("RHINT-8: cut at roughly 200 words, on a word boundary -- never mid-word", () => {
    const manyCells = Array.from({ length: 250 }, (_, i) => `Cell-${i}`);
    const hint = buildRecognizerHint({ cells: manyCells, places: [], parts: [], people: [] });
    const words = hint.split(/\s+/);
    expect(words.length).toBeLessThanOrEqual(200);
    // The cut lands exactly on the 200th word's own boundary -- what
    // survives is a PREFIX of the uncut string's word list, not a
    // truncated fragment of the 200th word itself.
    const uncutWords = `${vocab()}, ${manyCells.join(", ")}`.split(/\s+/);
    // Every word but the last matches the uncut string's own word at that
    // position verbatim; the last word matches too, minus the trailing
    // comma the cut strips so nothing is left dangling.
    expect(words.slice(0, -1)).toEqual(uncutWords.slice(0, words.length - 1));
    const lastWord = words[words.length - 1];
    expect(uncutWords[words.length - 1]).toBe(`${lastWord},`);
    // No dangling comma left by the cut.
    expect(hint.endsWith(",")).toBe(false);
  });

  it("RHINT-9: a board with few names never triggers the cap", () => {
    const hint = buildRecognizerHint({
      cells: ["Cell 1", "Cell 2"],
      places: ["Line A"],
      parts: ["Housing A", "Bracket B"],
      people: ["Ana"],
    });
    // "Cell 1"(2) + "Cell 2"(2) + "Line A"(2) + "Housing A"(2) + "Bracket B"(2) + "Ana"(1) = 11 words
    expect(hint.split(/\s+/).length).toBe(VOCAB_WORD_COUNT + 11);
  });
});

function vocab(): string {
  return "cell, line, shift, job, people, everyone, assign, book, remove, move, cover, swap, split, extend, one two three four five six seven eight nine ten, 1 2 3 4 5 6 7 8 9 10";
}
