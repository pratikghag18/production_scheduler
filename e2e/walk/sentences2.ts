/**
 * S71-n (docs/agent-briefs/s71-n-second-walk-list-brief.md) -- a SECOND,
 * fresh sentence list, same shape as `sentences.ts`'s own `buildSentences`,
 * different people/cells/hours/days. Selected by `WALK_SET=2` in
 * `typedWalk.spec.ts`. The regex builders (`assignReadoutRe`,
 * `bookReadoutRe`, `adjustReadoutRe`, `headcountReadoutRe`) are
 * `sentences.ts`'s own exports, reused verbatim -- not retyped (CLAUDE.md
 * §4, "extract, never retype"). This file adds two small readout builders
 * of its own for two shapes the first list never used at all (a swap's
 * certificate refusal already exists as a literal string there, reused
 * below; a plain-day absence's own "remove_which" question/write do not).
 *
 * Two shapes named in the brief's own §1 were tried and DROPPED rather than
 * forced (brief: "If a shape ... turns out not to be supported by the
 * grammar, drop it and say so"); both are recorded in this lane's own
 * report, not here.
 *
 *   - item 7, "from 10 to 2" with no am/pm asking which half of the day:
 *     `applyAfternoonRule` (src/lib/command/parse.ts) resolves a bare
 *     "from 10 to 2" DETERMINISTICALLY to 10:00-14:00 -- no question exists
 *     in the grammar for this shape today (confirmed against
 *     `commandParse.test.ts`'s own P-series pins, e.g. line 88).
 *   - item 15, "same as yesterday for Cell 3": `parseCopySameAs` gives a
 *     bare "same as X" an IMPLICIT destination of "today" with no way to
 *     override it. F-182 (this walk's own reason for never naming today at
 *     all) exists because an earlier walk wrote to the maintainer's live
 *     board that way; forcing this shape would run the same risk on
 *     purpose, so it is dropped for safety, not merely unsupported.
 *
 * Dropping both lands the list at 22 entries (24 raw category slots in the
 * brief's own §1, minus these two) -- the number the brief's own header
 * names, so the two drops read as anticipated rather than a shortfall.
 *
 * ⭐ Sam Patel is the one demo person OWNED BY A LINE, not the plant
 * (`operators.site_node_id = Line 1`, dev_demo.sql) -- the area gate
 * (F-165, `outside_area`) refuses him outside Line 1 (Cell 1/Cell 2) the
 * same way the certificate gate refuses an uncertified person on Cell 1/2.
 * Every Sam Patel entry below stays on Cell 2 for exactly this reason.
 */
import {
  assignReadoutRe,
  bookReadoutRe,
  adjustReadoutRe,
  headcountReadoutRe,
  type Sentence,
  type WalkDates,
} from "./sentences";

/** R-459: a cell's own name in a sentence carries "in <line>" only when the
 *  board has more than one cell of that name (`cellDisplayName`,
 *  `resolve.ts`) -- this walk's own board may or may not, so both builders
 *  below allow either. */
function cellPhrase(cell: string): string {
  return `${cell}(?: in [^,.;]+)?`;
}

/** `Remove <who>'s <part> block on <cell>, <when>? — say or type yes to do
 *  it, no to leave it.` -- the absence grammar's own `remove_which`
 *  question, one candidate (S49/R-409, `resolve.ts`'s `describeQuestion`,
 *  the `q.cell === null` branch: an absence names no cell of its own, so
 *  the ONE candidate names its own), with `CommandBar.tsx`'s own
 *  `YES_SUFFIX` appended for exactly one candidate (`withBlockHighlight`).
 *  `when` is spoken ("8 am to 10 am"), the same as every other hour this
 *  file names (R-459) -- never the raw "HH:MM–HH:MM" a board label carries. */
function removeWhichQuestionRe(who: string, part: string, cell: string, when: string): RegExp {
  return new RegExp(
    `^Remove ${who}'s ${part} block on ${cell}, ${when}\\? — say or type yes to do it, no to leave it\\.$`,
  );
}

/** `<who> is off <cell>[ in <line>] <day>; that was <when>, making <part>.`
 *  -- the same question answered (`finishRemoval`'s own readout, R-459). */
function removedReadoutRe(who: string, part: string, cell: string, when: string): RegExp {
  return new RegExp(`^${who} is off ${cellPhrase(cell)} .+; that was ${when}, making ${part}\\.$`);
}

/** Any "Ready to do N things: ..." lot listing (R-459) -- the generic shape
 *  every multi-command turn (split/swap/copy/repeat/clear) settles on, the
 *  same flexible pattern `sentences.ts`'s own copy/repeat/clear entries use
 *  (their own comment: the exact trailing "Say yes..." suffix is not the
 *  fact under test). */
const LOT_RE = /^Ready to do \d+ things: .+$/;

export function buildSentences2(dates: WalkDates): Sentence[] {
  return [
    // 1. A clear of an empty cell -- nothing_to_do, before anyone is on it
    // (Maria's own assign below lands on this same cell, entry 3).
    {
      say: `clear Cell 6 ${dates.day}`,
      expect: /^Cell 6 has nobody on it .+\.$/,
    },

    // 2-5. Four assigns, different cells/lines from the first list (brief
    // §1 item 2): Priya on Cell 1 (certified, Welding), Maria on Cell 6
    // (Line 3, no cert needed), Lena on Cell 2 (Line 1 -- NOT certified,
    // the ONE not-certified case, answered with a reason), John on Cell 5
    // (Line 3, no cert needed).
    {
      say: `Assign Priya Shah to Line 1 Subassembly A on Cell 1 in Line 1 from 6am to 2pm ${dates.day}`,
      expect: assignReadoutRe("Priya Shah", "Line 1 Subassembly A", "Cell 1", "06:00", "14:00"),
    },
    {
      say: `Assign Maria Lopez to Area 2 Frame A on Cell 6 in Line 3 from 8am to 12pm ${dates.day}`,
      expect: assignReadoutRe("Maria Lopez", "Area 2 Frame A", "Cell 6", "08:00", "12:00"),
    },
    {
      say: `Assign Lena Novak to Bracket A on Cell 2 in Line 1 from 8am to 12pm ${dates.day}`,
      answer: "Lena is covering for the Line 1 shortfall today",
      note: "not_certified under warn (Lena lacks Welding, Cell 2 is Line 1): the typed reason re-resolves with eligibility_override -- the DB read after asserts eligibility_override = true.",
      expect:
        /^Not done: Lena Novak is not certified for Cell 2, missing Welding\. Say the reason to schedule anyway, or no\.$/,
    },
    {
      say: `Assign John Kim to Common Fastener on Cell 5 in Line 3 from 8am to 12pm ${dates.day}`,
      expect: assignReadoutRe("John Kim", "Common Fastener", "Cell 5", "08:00", "12:00"),
    },

    // 6. Misheard part -- "Bracket Pay" clears the Dice-coefficient near-miss
    // floor against "Bracket A" the same way the first list's "Housing Pay"
    // cleared it against "Housing A". Sam Patel stays on Cell 2 (Line 1) --
    // the area gate's own boundary (this file's header doc) -- at a window
    // (3pm-7pm) that never overlaps Priya's 06:00-14:00 Cell 1 block or
    // Lena's 08:00-12:00 Cell 2 block.
    {
      say: `Assign Sam Patel to Bracket Pay on Cell 2 in Line 1 from 3pm to 7pm ${dates.day}`,
      expect: {
        button: "Bracket A",
        then: assignReadoutRe("Sam Patel", "Bracket A", "Cell 2", "15:00", "19:00"),
      },
    },

    // 7. No part named -- "Which part?" with Cell 3's own menu (Housing A /
    // Bracket A / Common Fastener -- Cell 3 is Line 2, no line-only part).
    {
      say: `Assign Tom Baker to Cell 3 from 8am to 12pm ${dates.day}`,
      note: 'no part named -- "Which part?" with Cell 3\'s own menu.',
      expect: {
        button: "Housing A",
        then: assignReadoutRe("Tom Baker", "Housing A", "Cell 3", "08:00", "12:00"),
      },
    },

    // 8. A booking with headcount, on a Line 3 cell.
    {
      say: `book Common Fastener on Cell 6 in Line 3 for 2 people from 1pm to 5pm ${dates.day}`,
      expect: bookReadoutRe("Common Fastener", "Cell 6", "13:00", "17:00", 2),
    },

    // 9. "end" -- shortens John Kim's own Cell 5 block (08:00-12:00).
    {
      say: `end John Kim's block at 10am ${dates.day}`,
      expect: adjustReadoutRe("John Kim", "Cell 5", "end", "10:00", "12:00"),
    },

    // 10. "shorten" -- a shape the first list never used. Lena Novak's own
    // Cell 2 block (08:00-12:00), by 30 minutes.
    {
      say: `shorten Lena Novak's block by 30 minutes ${dates.day}`,
      expect: adjustReadoutRe("Lena Novak", "Cell 2", "end", "11:30", "12:00"),
    },

    // 11. "extend" -- Sam Patel's own Cell 2 block (15:00-19:00), by an
    // hour. The "assignment" spelling (BLOCK_TAIL_WORDS), used once, so the
    // second round measures both against the first list's "block".
    {
      say: `extend Sam Patel's assignment by an hour ${dates.day}`,
      expect: adjustReadoutRe("Sam Patel", "Cell 2", "end", "20:00", "19:00"),
    },

    // 12. "split" -- Tom Baker's own Cell 3 block (08:00-12:00) at 10am.
    // CB-y-1: a lot of two (move, then assign), one yes runs both.
    //
    // MODEL GAP (the same one entry 10 of the first list carries a whole
    // paragraph on): the served model does not always hear this sentence's
    // first name -- it returns "Tom Bakker" on some runs, which the bar
    // reads as a near-miss and asks "Did you mean Tom Baker?" before it
    // ever reaches the split's own lot. `orDirect` covers the run where the
    // name lands correctly the first time; the button covers the one where
    // it does not. Either way "yes" answers the lot once it is showing.
    {
      say: `split Tom Baker's block at 10am ${dates.day}`,
      answer: "yes",
      note: 'model gap: the served model may hear "Tom Bakker" (the same gap the first list\'s entry 10 carries) -- on some runs the Did-you-mean question comes first, on others the lot lands directly.',
      expect: {
        button: "Tom Baker",
        then: LOT_RE,
        orDirect: LOT_RE,
      },
    },

    // 13. An uncertified person swapped ONTO a Line 1 cell -- refused before
    // the yes (S61-b/R-425: the certificate gate runs at EXPANSION time for
    // a swap, `inLot: true`, and never offers a reason). Lena's own Cell 2
    // block crosses to Priya's Cell 1; Lena is not certified for Cell 1.
    {
      say: `swap Lena Novak and Priya Shah ${dates.day}`,
      expect:
        /^Not done: Lena Novak is not certified for Cell 1, missing Welding\. Nothing changed\.$/,
    },

    // 14. A swap that writes -- Maria Lopez (Cell 6) and John Kim (Cell 5,
    // shortened by entry 9 to 08:00-10:00), neither on a Line 1 cell, so
    // nothing is refused; a lot of four (two removals, two crossed
    // assigns), one yes runs all of it.
    {
      say: `swap Maria Lopez and John Kim ${dates.day}`,
      answer: "yes",
      expect: LOT_RE,
    },

    // 15. The headcount form, on the run booked in entry 8 -- deliberately
    // NOT right after entry 8 (a back-to-back book-then-headcount-change
    // raced the client's own realtime sync on the first try here and was
    // refused, "That job is no longer on the board", the same distance the
    // first list keeps between its own two -- entries 6 and 13, seven
    // apart).
    {
      say: `make the Common Fastener job on Cell 6 5 people ${dates.day}`,
      expect: headcountReadoutRe("Common Fastener", "Cell 6", 5),
    },

    // 16. "from 4 until end of shift" -- the model-gap case, a fresh hour
    // from the first list's "2". F-151's lone-start rule reads a bare "4"
    // under 6 as the afternoon (16:00, Shift 2, ends 22:00); a model reading
    // may take it literally as 04:00 (wraps into Shift 3, ends 06:00 the
    // next day). John Kim now holds Cell 6 (post-swap, entry 14); either
    // reading lands outside his existing 08:00-12:00 block there.
    {
      say: `Assign John Kim to Housing A on Cell 6 in Line 3 from 4 until end of shift ${dates.day}`,
      note: 'model gap: the rules read "4" as 16:00 (Shift 2, ends 22:00); a model reading may take it literally as 04:00 (Shift 3, ends 06:00 the next day). Both accepted; the table records which one the bar showed.',
      expect: new RegExp(
        `^John Kim is on ${cellPhrase("Cell 6")} .+ from (?:4 pm to 10 pm|4 am to 6 am), making Housing A\\.(?: .+)?$`,
      ),
    },

    // 17. A copy, to "tomorrow" rather than the brief's own suggested named
    // weekday ("Friday") -- tried first and dropped (brief §1 item 11's own
    // permission: "if not, use tomorrow and say so"). The copy grammar DOES
    // parse a bare weekday (DAY_OR_WEEK_TOKEN in parse.ts includes
    // WEEKDAY_ALTS), and pressing "Show that day" for it genuinely widens
    // the board -- but the widened window drops the WALK DAY itself back
    // off the board (it is not a week-wide widen, F-158's own kind, just a
    // few days anchored near the named day), so the copy's own SOURCE then
    // asks its own day_off_board question instead of ever reaching a lot.
    // Confirmed live (24 Sept): "friday is not on the board" -> pressed
    // Show that day -> "Mon Sep 28 is not on the board" -- a genuine second
    // question this sentence never gets past. "tomorrow" needs no widening
    // at all -- Cell 5 now holds Maria Lopez's own block (08:00-10:00,
    // crossed to her by entry 14's swap).
    //
    // Confirmed live, three runs running (24 Sept, `data/voice/trace/
    // bar.jsonl`): copying exactly ONE block never asks at all -- S47's
    // "runs on its own readout, no yes" applies here too (`answered:
    // "auto"` in every trace line this entry has produced), the SAME
    // assign-shaped readout an ordinary single sentence gets, naming the
    // DESTINATION day and cell. A `yes` was tried first here and would have
    // been typed into an empty bar with nothing standing to answer.
    {
      say: `copy ${dates.day} to ${dates.tomorrow} for Cell 5`,
      note: 'copying exactly one block auto-runs (S47), no yes -- confirmed live across three runs (`answered: "auto"` in the trace each time), the same shape an ordinary single assign gets.',
      expect: assignReadoutRe("Maria Lopez", "Common Fastener", "Cell 5", "08:00", "10:00"),
    },

    // 18. A repeat day, answered no -- "next week" is off the board (F-158:
    // the move names the WEEK, widens to seven days, Monday to Friday is a
    // lot of five, CB-y-2). Lena Novak's own Cell 2 block (entry 4) is on
    // THIS week, so next week's Cell 4 is untouched either way. (Not Tom
    // Baker: this entry doesn't need his own block, and the model-gap
    // mishearing this file's entry 12 already carries is better kept to one
    // place than risked here too.)
    //
    // R-455 (24 Sept, lane S72-b, d5a8829) retired the "Show that day"
    // button this used to press: the bar now moves the window on its own,
    // posts "Moved the board to next week." as one line, and reruns the
    // held sentence once the new window's data lands -- no press left to
    // wait on. The plain final regex is proof enough of both steps
    // (`expectAnswered` in `typedWalk.spec.ts` polls the live status line
    // and the filed thread turn the move updates in place).
    {
      say: "Assign Lena Novak to Common Fastener on Cell 4 in Line 2 every weekday next week from 9am to 1pm",
      answer: "no",
      note: "a repeat day must be on the board (R-416); F-158 widens to the week, five commands (Monday-Friday, CB-y-2), and no leaves every one of them unwritten. R-455's own move runs with no press.",
      expect: LOT_RE,
    },

    // 19. An absence -- R-409's shape, pinned as it actually behaves rather
    // than assumed: "<person> is off <day>" is an UNASSIGN with no cell of
    // its own (whole day, every cell), which asks `remove_which` even for
    // ONE candidate (S49: a removal always asks, `resolve.ts`'s own
    // comment) rather than writing silently. Maria Lopez holds exactly one
    // block at this point (Cell 5, 08:00-10:00, crossed to her by entry
    // 14's swap) -- John Kim, by contrast, now holds two (entry 16 gave him
    // a second), which is why Maria is the one named here.
    {
      say: `Maria Lopez is off ${dates.day}`,
      note: "R-409: the absence grammar is an unassign with no cell of its own -- pinned here as remove_which (one candidate still asks, never a silent whole-day wipe): press the one button, then the DB read proves the row gone.",
      expect: {
        button: "Remove it",
        question: removeWhichQuestionRe(
          "Maria Lopez",
          "Common Fastener",
          "Cell 5",
          "8 am to 10 am",
        ),
        then: removedReadoutRe("Maria Lopez", "Common Fastener", "Cell 5", "8 am to 10 am"),
      },
    },

    // 20. A cover -- the S-series shape, pinned the same way. Priya Shah's
    // own Cell 1 block (untouched since entry 2) becomes Sam Patel's (he is
    // certified AND, per this file's header doc, legally on Line 1); a lot
    // of two (one removal, one crossed assign), one yes runs both.
    {
      say: `cover Priya Shah with Sam Patel ${dates.day}`,
      answer: "yes",
      note: "the S-series cover shape (replace): Priya's whole-day blocks (just the one, Cell 1) become Sam's -- Sam is certified for Cell 1 and, being Line-1-owned himself, legally there too.",
      expect: LOT_RE,
    },

    // 21 and 22. The clears at the end -- Line 2, then Area 2 (a DIFFERENT
    // pair of places than the first list's Area 1/Area 2, per brief §1 item
    // 16). Line 2 is Cell 3 (Tom's two split blocks) and Cell 4 (never used
    // on the walk day itself -- entry 18's own Cell 4 work is next week).
    // Area 2 is Cell 5 (emptied by entry 19's absence) and Cell 6 (John's
    // two blocks plus the run from entries 8/15). Cell 1 and Cell 2 (Line 1)
    // are deliberately NOT cleared by any sentence here -- the walk's own
    // teardown (`clearWindow`) still removes them, same as always.
    {
      say: `clear Line 2 ${dates.day}`,
      answer: "yes",
      note: "R-407: a place above the cells clears every cell under it -- Line 2 is Cell 3 and Cell 4.",
      expect: LOT_RE,
    },
    {
      say: `clear Area 2 ${dates.day}`,
      answer: "yes",
      note: "the other half of the clear -- Area 2 is Cell 5 and Cell 6.",
      expect: LOT_RE,
    },
  ];
}
