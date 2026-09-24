/**
 * S72-a (docs/agent-briefs/s72-a-verb-guess-and-comma-qualifier-brief.md §2,
 * R-456, F-222): `guessVerbs`/`describeVerbGuess`/`misheardVerbWord`'s own
 * pins, VG-1... `VERBS` mirrors `grounded.test.ts`'s own `VERBS` constant,
 * which mirrors `CommandBar.tsx`'s own `GROUNDING_VERBS` -- one shared
 * shape, not three hand-synced copies (CLAUDE.md §4).
 *
 * The four trace sentences are read verbatim off `data/voice/trace/
 * bar.jsonl` (`node -e`, entries `at >= 2026-09-24T19:25`) EXCEPT VG-2 (the
 * "Tom Baker" sentence), which swaps "18 to 12 p.m." for "8 a.m. to 12
 * p.m." -- the trace's own literal wording (`"...from 18 to 12 p.m.
 * today."`) fails to parse EVEN WITH "assign" put in front (`parseCommand`
 * itself returns `time_order`: 18:00 is after 12:00, a genuine, separate
 * defect in the NUMBERS the maintainer said, nothing to do with the
 * missing verb) -- VG-1 pins that finding directly, and this file's own
 * report names it for the main session.
 *
 * Reviewer (S72-a): `guessVerbs`/etc. moved from `src/lib/command/
 * verbGuess.ts` to `src/lib/voice/verbGuess.ts` (see that file's own header
 * for why -- the top-level `await import` it used to dodge U1 was gaming
 * the audit, not meeting it); this test's import path moved with it.
 */
import { describe, it, expect } from "vitest";
import {
  guessVerbs,
  describeVerbGuess,
  misheardVerbWord,
  VERB_CONFUSIONS,
} from "@/lib/voice/verbGuess";
import type { VerbLists } from "@/lib/command/grounded";
import {
  ASSIGN_VERBS,
  BOOK_VERBS,
  UNASSIGN_VERBS,
  MOVE_VERBS,
  HEADCOUNT_VERBS,
  REPLACE_VERBS,
  SWAP_VERBS,
  COPY_VERBS,
  ABSENCE_WORDS,
  ADJUST_VERBS,
  SAME_AS_WORDS,
  parseCommand,
} from "@/lib/command/parse";

const VERBS: VerbLists = {
  assign: ASSIGN_VERBS,
  book: BOOK_VERBS,
  unassign: [...UNASSIGN_VERBS, ...ABSENCE_WORDS],
  move: [...MOVE_VERBS, ...ADJUST_VERBS],
  headcount: HEADCOUNT_VERBS,
  replace: REPLACE_VERBS,
  swap: SWAP_VERBS,
  copy: [...COPY_VERBS, ...SAME_AS_WORDS],
  split: ["split"],
};

describe("guessVerbs (S72-a, R-456, F-222): the four trace complaints", () => {
  it("VG-1: the maintainer's own 'Tom Baker...18 to 12 p.m.' sentence gives [] -- the times themselves are backwards, not just the missing verb (a separate, genuine gap: say so, never guess past it)", () => {
    const heard = "Tom Baker to Cell 3 from 18 to 12 p.m. today.";
    // Confirms the finding directly: even with the verb correctly guessed
    // and put in front, parseCommand itself refuses this sentence.
    expect(parseCommand(`assign ${heard}`)).toEqual({
      ok: false,
      failure: { kind: "time_order" },
    });
    expect(guessVerbs(heard, VERBS)).toEqual([]);
  });

  it("VG-2: the same sentence with a working time clause guesses 'assign', in front, first", () => {
    const heard = "Tom Baker to Cell 3 from 8 a.m. to 12 p.m. today.";
    const guesses = guessVerbs(heard, VERBS);
    expect(guesses.length).toBeGreaterThan(0);
    expect(guesses[0].verb).toBe("assign");
    expect(guesses[0].sentence).toBe(`assign ${heard}`);
    expect(guesses[0].label).toBe("assign Tom Baker to Cell 3 on today from 08:00 to 12:00");
  });

  it("VG-3: 'and John Kim's block at 10 a.m. today' ('end' heard as 'and') replaces the first word, not a shape guess", () => {
    const heard = "and John Kim's block at 10 a.m. today";
    const guesses = guessVerbs(heard, VERBS);
    expect(guesses.length).toBeGreaterThan(0);
    expect(guesses[0].verb).toBe("end");
    expect(guesses[0].sentence).toBe("end John Kim's block at 10 a.m. today");
    // F-223 (fixed, parse.ts's own top-level dot normalisation): this used
    // to read "end John Kim's block . at 10:00 on today" -- a stray "."
    // stranded in the operator by the dotted "a.m." + trailing day-word
    // interaction in `parseAdjustRest`'s own "at <time>" clause. Now clean.
    expect(guesses[0].label).toBe("end John Kim at 10:00 on today");
    expect(misheardVerbWord(heard, VERBS)).toBe("and");
    expect(describeVerbGuess("and", guesses)).toBe('I heard "and". Did you mean:');
  });

  it("VG-3b: without the trailing day word, the same replacement is equally clean ('end John Kim at 10:00') -- confirms F-223's fix covers both shapes, not just the one with a day word", () => {
    const heard = "and John Kim's block at 10 a.m.";
    const guesses = guessVerbs(heard, VERBS);
    expect(guesses[0]).toEqual({
      verb: "end",
      sentence: "end John Kim's block at 10 a.m.",
      label: "end John Kim at 10:00",
    });
  });

  it("VG-4: 'Show up Lena Novak and Priya Shah today.' ('swap') replaces the first TWO words", () => {
    const heard = "Show up Lena Novak and Priya Shah today.";
    const guesses = guessVerbs(heard, VERBS);
    expect(guesses.length).toBeGreaterThan(0);
    expect(guesses[0].verb).toBe("swap");
    expect(guesses[0].sentence).toBe("swap Lena Novak and Priya Shah today.");
    expect(guesses[0].label).toBe("swap Lena Novak and Priya Shah today");
    expect(misheardVerbWord(heard, VERBS)).toBe("Show up");
    expect(describeVerbGuess("Show up", guesses)).toBe('I heard "Show up". Did you mean:');
  });
});

describe("guessVerbs: the edge cases the brief names", () => {
  it("VG-5: a sentence that already has a verb gives []", () => {
    expect(guessVerbs("assign Tom Baker to Cell 3 from 8 to 12", VERBS)).toEqual([]);
    expect(guessVerbs("Sam Patel is off today.", VERBS)).toEqual([]); // ABSENCE_WORDS, unioned into unassign
    expect(misheardVerbWord("assign Tom Baker to Cell 3 from 8 to 12", VERBS)).toBe("");
  });

  it("VG-6: 'See you at the next one.' gives [] (no clock time, no domain word, no two-capitalised-word name, no possessive)", () => {
    expect(guessVerbs("See you at the next one.", VERBS)).toEqual([]);
  });

  it("VG-7: 'Please, Cell 6 today.' gives [] -- 'Please' sounds close enough to 'place' (ASSIGN_VERBS) to be tried, but the resulting candidate 'place, Cell 6 today.' has no time clause and parseCommand refuses it, so nothing survives rule 5's parse-ok filter (decided by rule 2/rule 5 together, not a hard rule-2 refusal -- see this lane's report)", () => {
    expect(guessVerbs("Please, Cell 6 today.", VERBS)).toEqual([]);
  });

  it("VG-8: a candidate that does not parse is dropped, not returned broken", () => {
    // 'assign' shape fires (person + place), but there is no time clause at
    // all -- parseCommand refuses every candidate, so guessVerbs must not
    // hand back a button that cannot run (brief §2 rule 5's own closing
    // line).
    expect(guessVerbs("Tom Baker to Cell 3 today.", VERBS)).toEqual([]);
  });

  it("VG-9: at most three candidates", () => {
    for (const heard of [
      "Tom Baker to Cell 3 from 8 a.m. to 12 p.m. today.",
      "and John Kim's block at 10 a.m. today",
      "Show up Lena Novak and Priya Shah today.",
    ]) {
      expect(guessVerbs(heard, VERBS).length).toBeLessThanOrEqual(3);
    }
  });

  it("VG-10: describeVerbGuess's two wordings", () => {
    expect(describeVerbGuess("", [])).toBe("Did you mean:");
    expect(describeVerbGuess("and", [])).toBe('I heard "and". Did you mean:');
  });

  it("VG-11 (reviewer): a NAME within edit distance of a verb ('Ed' ~ 'end', distance 1) does not become the verb -- it falls through to the SHAPE guess ('assign') instead of a dead end. Found running the review: the original code returned [] outright here because a sound-alike hit existed (even though it never parsed), never trying rule 4 at all.", () => {
    const heard = "Ed Kim to Cell 3 from 8 a.m. to 12 p.m. today.";
    const guesses = guessVerbs(heard, VERBS);
    expect(guesses.length).toBeGreaterThan(0);
    expect(guesses[0].verb).toBe("assign");
    expect(guesses[0].sentence).toBe("assign Ed Kim to Cell 3 from 8 a.m. to 12 p.m. today.");
    expect(guesses[0].label).toBe("assign Ed Kim to Cell 3 on today from 08:00 to 12:00");
    // The name is kept intact -- nothing here claims "Ed" was misheard.
    expect(misheardVerbWord(heard, VERBS)).toBe("");
    expect(describeVerbGuess("", guesses)).toBe("Did you mean:");
  });

  it("VG-12 (reviewer): 'Ann'/'Sid' (also within edit distance of real verb words) likewise keep the name and use the SHAPE guess, not a replacement", () => {
    for (const name of ["Ann Baker", "Sid Patel"]) {
      const heard = `${name} to Cell 3 from 8 a.m. to 12 p.m. today.`;
      const guesses = guessVerbs(heard, VERBS);
      expect(guesses.length).toBeGreaterThan(0);
      expect(guesses[0].verb).toBe("assign");
      expect(guesses[0].sentence).toBe(`assign ${heard}`);
      expect(misheardVerbWord(heard, VERBS)).toBe("");
    }
  });

  it("VG-13 (reviewer): 'and' in the MIDDLE of an already-verbed swap sentence never trips the table (rule 1 catches the real verb first; the table only ever looks at the sentence's own first word/first two words)", () => {
    expect(guessVerbs("swap Lena Novak and Priya Shah today.", VERBS)).toEqual([]);
    expect(guessVerbs("swap Lena and Priya", VERBS)).toEqual([]);
  });

  it("VG-14 (reviewer): a bare answer word never fires the shape rule -- no person, place, part or hour to hang a guess on", () => {
    for (const heard of ["yes", "no", "Do all 2", "Show that day"]) {
      expect(guessVerbs(heard, VERBS)).toEqual([]);
    }
  });

  it("VG-15 (reviewer): a sentence already carrying a verb in ANOTHER spelling gives [] -- 'put'/'take' (ASSIGN_VERBS/UNASSIGN_VERBS' own words) and the absence words unassign's list unions in", () => {
    expect(guessVerbs("put Sam on Cell 1", VERBS)).toEqual([]);
    expect(guessVerbs("take Sam off Cell 1", VERBS)).toEqual([]);
    expect(guessVerbs("Sam is off today", VERBS)).toEqual([]);
  });
});

describe("guessVerbs: every VERB_CONFUSIONS entry, table-driven (a future addition is one line)", () => {
  // One sentence shape per table entry that gives the replaced word an
  // actual command to land in -- built once here rather than per case, so
  // adding a row to `VERB_CONFUSIONS` is the only thing a future fix needs.
  const CARRIER: Record<string, string> = {
    end: "TRIGGER Sam Patel's block at 10 a.m.",
    swap: "TRIGGER Lena Novak and Priya Shah today.",
    assign: "TRIGGER Tom Baker to Cell 3 from 8 a.m. to 12 p.m. today.",
    book: "TRIGGER Common Fastener on Cell 6 for 2 people from 1 p.m. to 5 p.m. today.",
    split: "TRIGGER Tom Baker's block at 10 a.m. today",
    extend: "TRIGGER Sam Patel's block by 30 minutes today",
  };

  // "book it" and "split it" both start with the verb's OWN canonical word
  // ("book", "split") -- rule 1 (`hasAnyWord` against the real VerbLists)
  // sees that word and returns `[]` before the table in rule 3 is ever
  // consulted, for every sentence that literally contains "book it"/"split
  // it" as consecutive words. Found running this very test (both entries
  // came back with zero guesses); not a bug in the table or in rule 1
  // individually, but a real shadowing between the two rules together --
  // named for the main session's report rather than quietly special-cased
  // away. Pinned as the actual, current behaviour below instead of skipped.
  const SHADOWED_BY_RULE_1 = new Set(["book it", "split it"]);

  for (const [heardWord, verb] of VERB_CONFUSIONS) {
    if (SHADOWED_BY_RULE_1.has(heardWord)) {
      it(`VG-table: "${heardWord}" -> "${verb}" is shadowed by rule 1 ("${verb}" is itself already a recognised verb word)`, () => {
        const heard = `${heardWord} Common Fastener on Cell 6 from 1 p.m. to 5 p.m. today.`;
        expect(guessVerbs(heard, VERBS)).toEqual([]);
        expect(misheardVerbWord(heard, VERBS)).toBe("");
      });
      continue;
    }
    it(`VG-table: "${heardWord}" -> "${verb}"`, () => {
      const carrier = CARRIER[verb];
      if (!carrier) throw new Error(`no carrier sentence wired up for verb "${verb}"`);
      const heard = carrier.replace("TRIGGER", heardWord);
      const guesses = guessVerbs(heard, VERBS);
      expect(guesses.length).toBeGreaterThan(0);
      expect(guesses[0].verb).toBe(verb);
      expect(misheardVerbWord(heard, VERBS)).toBe(heardWord);
    });
  }
});
