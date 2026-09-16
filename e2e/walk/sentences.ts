/**
 * S61-c (docs/agent-briefs/s61-c-typed-walk-spec-brief.md) -- the sentence
 * list as DATA. `typedWalk.spec.ts` drives these, in order, against the real
 * bar on the real board; nothing here touches the DOM or the database --
 * that is entirely the spec's own job (brief §1/§3). A `voice: true` entry
 * (none exist yet -- brief §5, "the developer hands the voice sentences from
 * the same data file") is a future lane's addition; the spec skips any it
 * finds.
 *
 * `expect` reads the bar's status line the moment `say` has been submitted
 * and settled (after any "Reading…" -> model/rules resolution) --
 *   - a plain `RegExp`: what the bar shows right then IS the end of this
 *     entry's turn (an ordinary single sentence's own readout, S47's "runs on
 *     its readout with no yes", or a terminal refusal with no candidates at
 *     all -- `nothing_to_do`, an `inLot` certificate refusal).
 *   - `{ button, then }`: a question with a named button stands (a
 *     near-miss's Did-you-mean, "Which part?", "Show that day") -- the spec
 *     presses it and `then` is what the bar shows once that settles.
 * `answer` is set only when the status the bar showed for `say` needs a
 * typed reply to finish the turn: "yes"/"no" for a single block question's
 * own yes/no suffix or a lot's "N commands ready", or a free-text override
 * reason for a `not_certified` "warn" question. `expect` in that case still
 * names what `say` alone produced (the question/lot text) -- the spec reads
 * that, types `answer`, and the DATABASE (not a second `expect`) is what
 * proves the answer actually ran (brief §3).
 */

export interface Sentence {
  say: string;
  answer?: "yes" | "no" | string;
  /** `{ button, then }` may also carry `question`: the exact status line the
   *  bar must be showing at the moment that button stands. Omitted where the
   *  button's own label is the whole of what the entry is proving (a
   *  Did-you-mean pick, a "Which part?" menu item); given where the QUESTION
   *  is the finding -- see the swap entry's own `model gap` note. */
  expect: RegExp | { button: string; then: RegExp; question?: RegExp };
  note?: string;
  voice?: true;
}

/** En dash (U+2013, a span's own separator) and the arrow/middle-dot/chain
 *  separators `resolve.ts`'s own readouts are built from (its own doc
 *  comments on `ResolvedCommand`/`ResolvedBook`/etc.) -- named once so a
 *  typo in one regex is not a second, silently different, copy. */
const EN_DASH = "–";
const ARROW = "→";
const DOT = " · ";

/** The optional "read by the model"/"read by the rules (...)" suffix S44-b
 *  adds to a WRITE readout only -- never a question, never `nothing_to_do`
 *  (`CommandBar.tsx`'s own `runCommand`: the suffix is appended solely on
 *  the `resolution.ok` branch's readout). This dev machine's server is up
 *  with the model container running, so most writes are expected to carry
 *  it -- but the suffix is not the fact this walk is testing, so every
 *  write regex below tolerates its absence too rather than overfitting to
 *  which engine happened to answer. */
const READ_SUFFIX = `(?:${DOT}read by the (?:model|rules \\([^)]*\\)))?`;

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `<who> → <product> · <chain ending in Cell N> · <day> · HH:MM–HH:MM`,
 *  optionally suffixed -- an assign's own readout (`resolve.ts`'s doc on
 *  `ResolvedCommand.readout`). The chain's PLANT/AREA/LINE segments are left
 *  as `.*` -- this walk asserts the DATABASE row for exactness (brief §3);
 *  the regex only has to prove the STATUS LINE named the right person,
 *  product, cell and hours. */
export function assignReadoutRe(
  who: string,
  product: string,
  cell: string,
  start: string,
  end: string,
): RegExp {
  return new RegExp(
    `^${esc(who)} ${ARROW} ${esc(product)}${DOT}.*${esc(cell)}${DOT}.+${DOT}${start}${EN_DASH}${end}${READ_SUFFIX}$`,
  );
}

/** `<product> · <chain> · <day> · HH:MM–HH:MM[ · N people]` -- a book's own
 *  readout. */
export function bookReadoutRe(
  product: string,
  cell: string,
  start: string,
  end: string,
  people?: number,
): RegExp {
  const tail = people !== undefined ? `${DOT}${people} people` : "";
  return new RegExp(
    `^${esc(product)}${DOT}.*${esc(cell)}${DOT}.+${DOT}${start}${EN_DASH}${end}${esc(tail)}${READ_SUFFIX}$`,
  );
}

/** `<who> · <cell> · <edge>s HH:MM, was HH:MM` -- an adjust's own readout
 *  (`resolve.ts` line ~2819). */
export function adjustReadoutRe(
  who: string,
  cell: string,
  edge: "end" | "start",
  newT: string,
  oldT: string,
): RegExp {
  return new RegExp(
    `^${esc(who)}${DOT}${esc(cell)}${DOT}${edge}s ${newT}, was ${oldT}${READ_SUFFIX}$`,
  );
}

/** `<product> · <chain> · <day> · <span> · N people` -- the headcount form's
 *  own readout (`resolve.ts` line ~2883). `<span>` is the run's own hours,
 *  asserted loosely here (the DB read after is what proves it). */
export function headcountReadoutRe(product: string, cell: string, n: number): RegExp {
  return new RegExp(
    `^${esc(product)}${DOT}.*${esc(cell)}${DOT}.+${DOT}.+${DOT}${n} people${READ_SUFFIX}$`,
  );
}

export interface WalkDates {
  /** ISO `YYYY-MM-DD` of today, tomorrow and a day well past the board's
   *  default 3-day window (`boardView.ts`'s own `windowDayCount: 3`), in
   *  Plant A's own zone (America/Chicago). */
  today: string;
  tomorrow: string;
  far: string;
}

/**
 * The ordered sentence list. Every person named holds the cell's own
 * training unless the entry IS the certification case (Tom Baker on Cell 1,
 * a Welding requirement Line 1 carries and Line 2/3 do not -- brief's own
 * plant facts). Every clock is the entry's own words: "8am"/"1pm"/etc. never
 * hand-summed into a different display elsewhere.
 */
export function buildSentences(dates: WalkDates): Sentence[] {
  return [
    // 1. A clear of an empty cell -- nothing_to_do, a plain readout in the
    // resolver's own words (`resolve.ts`: `"${label} has nobody on it
    // ${iso}."`), never a question (CB-x-5's own pin).
    {
      say: "clear Cell 4 today",
      expect: /^Cell 4 has nobody on it .+\.$/,
    },

    // 2. Assign with a part -- an ordinary single sentence, runs on its own
    // readout, no yes (S47).
    {
      say: "Assign John Kim to Housing A on Cell 3 in Line 2 from 8am to 12pm today",
      expect: assignReadoutRe("John Kim", "Housing A", "Cell 3", "08:00", "12:00"),
    },

    // 3. The plural near-miss: "Common Fasteners" matches "Common Fastener"
    // directly through `matchName`'s own plural-stripping fallback tier --
    // no question at all.
    {
      say: "Assign Priya Shah to Common Fasteners on Cell 4 in Line 2 from 8am to 12pm today",
      note: '"Common Fasteners" matches "Common Fastener" directly (the plural-stripping tier in matchName) -- no Did-you-mean question raised.',
      expect: assignReadoutRe("Priya Shah", "Common Fastener", "Cell 4", "08:00", "12:00"),
    },

    // 4. A real near-miss: "Housing Pay" clears the Dice-coefficient floor
    // against "Housing A" (D133 item 2) and offers it as a Did-you-mean
    // button.
    {
      say: "Assign Maria Lopez to Housing Pay on Cell 4 in Line 2 from 1pm to 3pm today",
      expect: {
        button: "Housing A",
        then: assignReadoutRe("Maria Lopez", "Housing A", "Cell 4", "13:00", "15:00"),
      },
    },

    // 5. A sentence with no part at all -- "Which part? Cell 1 makes:" with
    // the cell's own menu as buttons (S60-b, R-422).
    {
      say: "Assign Sam Patel to Cell 1 from 8am to 4pm today",
      note: 'no part named -- "Which part?" with Cell 1\'s own menu.',
      expect: {
        button: "Housing A",
        then: assignReadoutRe("Sam Patel", "Housing A", "Cell 1", "08:00", "16:00"),
      },
    },

    // 6. A booking with headcount.
    {
      say: "book Bracket A on Cell 3 in Line 2 for 3 people from 1pm to 5pm today",
      expect: bookReadoutRe("Bracket A", "Cell 3", "13:00", "17:00", 3),
    },

    // 7. "from 2 until end of shift" -- F-151's lone-start rule reads a bare
    // "2" as 14:00 (afternoon), so the rules land on Shift 2 (14:00-22:00);
    // a model reading may instead take "2" literally as 02:00 and land on
    // Shift 3 (22:00-06:00) -- the bar's own status line is asserted either
    // way, never hand-picked.
    {
      say: "Assign Priya Shah to Line 1 Subassembly A on Cell 2 in Line 1 from 2 until end of shift today",
      note: 'model gap until the sixth run: the rules read "2" as 14:00 (Shift 2, ends 22:00); a model reading may take it literally as 02:00 (Shift 3, ends 06:00). Both are accepted; the spec records which one the bar actually showed.',
      expect: new RegExp(
        `^Priya Shah ${ARROW} Line 1 Subassembly A${DOT}.*Cell 2${DOT}.+${DOT}(?:14:00${EN_DASH}22:00|02:00${EN_DASH}06:00)${READ_SUFFIX}$`,
      ),
    },

    // 8. Tom Baker's setup block, off Line 1 (no certification needed) --
    // plumbing for the swap-refusal case next.
    {
      say: "Assign Tom Baker to Area 2 Frame A on Cell 6 in Line 3 from 8am to 2pm today",
      note: "setup: Tom Baker's own block, so the swap-refusal entry below has a block of his to swap FROM.",
      expect: assignReadoutRe("Tom Baker", "Area 2 Frame A", "Cell 6", "08:00", "14:00"),
    },

    // 9. end/extend adjusts -- "end" shortens Sam's own Cell 1 block.
    {
      say: "end Sam Patel's block at 2pm",
      expect: adjustReadoutRe("Sam Patel", "Cell 1", "end", "14:00", "16:00"),
    },

    // 10. An uncertified person swapped ONTO Cell 1 -- refused before the
    // lot's own yes (S61-b/R-425: the certificate gate runs at EXPANSION
    // time for a swap, `inLot: true`, and never offers a reason).
    //
    // MODEL GAP. The served model does not hear this sentence's first name.
    // It returns `"operator": "Tom Bakker"` -- a name nobody on this board
    // has -- so the bar never reaches the certificate gate at all: it stops
    // one step earlier, on the person-not-found near-miss question, offering
    // "Tom Baker" as the Did-you-mean. That question IS what the bar shows,
    // so that is what this entry expects; pressing the offered name
    // substitutes the real person and re-runs the swap, and THEN the
    // certification refusal this entry exists for lands (`then`). Nothing is
    // written either way, which the spec's own database reads after this
    // entry still prove.
    {
      say: "swap Tom Baker and Sam Patel today",
      note: "model gap: Tom Bakker (sixth run)",
      expect: {
        question: /^No person called "Tom Bakker" on this board\. Did you mean one of these\?$/,
        button: "Tom Baker",
        then: /^Tom Baker is not certified for Cell 1: missing Welding\. Nothing was written\.$/,
      },
    },

    // 11. A split -- Sam's own Cell 1 block (now 08:00-14:00) split at 1pm.
    // CB-y-1: a split is a lot of two (move, then assign), one yes runs both.
    {
      say: "split Sam Patel's block at 1pm",
      answer: "yes",
      note: "splits Sam's 08:00-14:00 Cell 1 block into 08:00-13:00 and 13:00-14:00; a two-command lot (move, then assign), one yes runs both (CB-y-1).",
      expect: /^2 commands ready: .+ — say or type yes to do them, no to leave them\.$/,
    },

    // 12. extend -- John Kim's own Cell 3 block (08:00-12:00) by an hour.
    {
      say: "extend John Kim's block by an hour",
      expect: adjustReadoutRe("John Kim", "Cell 3", "end", "13:00", "12:00"),
    },

    // 13. The headcount form -- the run booked in entry 6.
    {
      say: "make the Bracket A job on Cell 3 4 people",
      expect: headcountReadoutRe("Bracket A", "Cell 3", 4),
    },

    // 14. Lena Novak's setup block -- plumbing for the (successful) swap
    // next; matches John Kim's own Cell 3 window (08:00-13:00, post-extend)
    // exactly, so the swap crosses two full blocks cleanly.
    {
      say: "Assign Lena Novak to Area 2 Frame A on Cell 5 in Line 3 from 8am to 1pm today",
      note: "setup: gives Lena Novak a block of her own to swap with John Kim's.",
      expect: assignReadoutRe("Lena Novak", "Area 2 Frame A", "Cell 5", "08:00", "13:00"),
    },

    // 15. A swap -- both hold no Line 1 cell, so nothing is refused; a lot
    // of four (two removals, two crossed assigns), one yes runs all of it.
    {
      say: "swap Lena Novak and John Kim today",
      answer: "yes",
      expect: /^4 commands ready: .+ — say or type yes to do them, no to leave them\.$/,
    },

    // 16. A copy to tomorrow -- Cell 3's own blocks/runs, copied forward a
    // day.
    {
      say: "copy today to tomorrow for Cell 3",
      answer: "yes",
      expect: /^\d+ commands? ready: .+$/,
    },

    // 17. A repeat day, answered no: nothing written. R-416's rule is that
    // every day the repeat names must be ON THE BOARD, and "Show that day"
    // is the door when it is not -- "next week" was simply a day the walk's
    // own window never held, so the list, not the bar, was wrong.
    //
    // "this week" is the nearest week the board can hold. Note what
    // `resolveWeekDays` actually asks for: the WHOLE week, Monday to Sunday,
    // must be on the board before a `weekdays` repeat expands at all, and
    // what it then expands to is `days.slice(0, 5)` -- Monday to Friday, a
    // lot of FIVE (`src/test/commandBar.test.tsx`'s own CB-y-2 pins that
    // number). It is never the two or three of the week that happen to be in
    // the window.
    // The door is "Show that day", and F-158 is what makes it one: the
    // question now names the WEEK, so the board widens to the seven days the
    // repeat needs and anchors on that week's Monday, rather than shuffling a
    // three-day window from one missing day to the next. The window is
    // Mon-Sun afterwards, which still holds today -- entries 18 to 22 below
    // say "today" and are unaffected.
    {
      say: "Assign Lena Novak to Bracket A on Cell 4 in Line 2 every weekday this week from 8am to 12pm",
      answer: "no",
      note: "a repeat day must be on the board (R-416); F-158 makes the question name the week, so its own Show that day widens the board to seven days. Five commands, Monday to Friday (CB-y-2), and no leaves every one of them unwritten.",
      expect: {
        question: /^this week is not on the board\. Move the board to that day first\.$/,
        button: "Show that day",
        then: /^5 commands ready: .+ — say or type yes to do them, no to leave them\.$/,
      },
    },

    // 18. An uncertified person on Cell 1, as an ordinary single sentence --
    // under "warn", a typed reason re-resolves with the override and writes
    // the block anyway (S61-b/R-425).
    {
      say: "Assign Tom Baker to Housing A on Cell 1 in Line 1 from 3pm to 5pm today",
      answer: "the line supervisor approved the cover",
      note: "not_certified under warn: the typed reason re-resolves with eligibility_override -- the DB read after asserts eligibility_override = true.",
      expect:
        /^Tom Baker is not certified for Cell 1: missing Welding\. Say the reason to schedule anyway, or no\.$/,
    },

    // 19. A day past the board's own window -- "Show that day" moves it,
    // then the held sentence re-runs on its own once the new ctx lands.
    {
      say: `Assign Maria Lopez to Bracket A on Cell 3 in Line 2 from 8am to 12pm ${dates.far}`,
      expect: {
        button: "Show that day",
        then: assignReadoutRe("Maria Lopez", "Bracket A", "Cell 3", "08:00", "12:00"),
      },
    },

    // 20. A day-LESS sentence (defaults to "today") once the window has
    // moved away from today (entry 19's own "Show that day") -- today is
    // off the board now, so the SAME question is asked again, this time
    // naming "today". "Show that day" here returns the window to today,
    // which the final cleanup entry below needs.
    {
      say: "Assign Maria Lopez to Bracket A on Cell 3 in Line 2 from 8am to 12pm",
      note: 'no day word at all (defaults to "today"); the board is still showing the far date entry 19 moved it to, so today is off it -- day_off_board asks about "today" specifically.',
      expect: {
        button: "Show that day",
        then: assignReadoutRe("Maria Lopez", "Bracket A", "Cell 3", "08:00", "12:00"),
      },
    },

    // 21 and 22. The clear of today, at the end -- TWO sentences, one per
    // area. R-407's `everyone` form takes ONE place, and a place ABOVE the
    // cells clears every cell under it, so an area is the whole of its
    // lines' cells in a single sentence. A comma-separated list of cells is
    // not a sentence this grammar has at all: the parser reads "Cell 1, Cell
    // 2, … and Cell 6" as one nested place PATH ("Cell 1 in Cell 2 in …"),
    // which is why the list, not the bar, was wrong.
    //
    // Plant A's own shape (the walk's readouts above): Area 1 carries Line 1
    // (Cells 1-2) and Line 2 (Cells 3-4); Area 2 carries Line 3 (Cells 5-6).
    // Between them the two sentences name every cell this walk has written
    // to, and the spec asserts the two listings' counts SUM to an
    // independent database count of today's rows taken just before the
    // first of them -- never a hand-summed number here.
    {
      say: "clear Area 1 today",
      answer: "yes",
      note: "R-407: a place above the cells clears every cell under it -- Area 1 is Cells 1 to 4.",
      expect: /^\d+ commands? ready: .+$/,
    },
    {
      say: "clear Area 2 today",
      answer: "yes",
      note: "the other half of the clear -- Area 2 is Cells 5 and 6.",
      expect: /^\d+ commands? ready: .+$/,
    },
  ];
}
