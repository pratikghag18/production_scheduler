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
 *     all -- `nothing_to_do`, an `inLot` certificate refusal). R-455 (24
 *     Sept, lane S72-b, d5a8829) moved `day_off_board` into this bucket too
 *     -- the bar posts "Moved the board to <day>." and reruns the held
 *     sentence on its own, no button, no press; `expectAnswered`
 *     (`typedWalk.spec.ts`) already polls both the live status line and the
 *     filed thread turn the move updates in place, so the FINAL text is
 *     proof enough of both steps without a separate assertion of the moved
 *     line.
 *   - `{ button, then }`: a question with a named button stands (a
 *     near-miss's Did-you-mean, "Which part?") -- the spec presses it and
 *     `then` is what the bar shows once that settles. "Show that day" was
 *     this shape's own example until R-455 retired the button entirely; a
 *     day off the board is a plain `RegExp` of the final text now (see
 *     above).
 * `answer` is set only when the status the bar showed for `say` needs a
 * typed reply to finish the turn: "yes"/"no" for a single block question's
 * own yes/no suffix or a lot's "Ready to do N things" (R-459), or a free-text override
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
  /** A button-form entry may also carry `orDirect`: the bar is allowed to
   *  skip the question and land on this readout at once. Entry 10 is the
   *  case -- the served model hears "Tom Bakker" on some runs and "Tom
   *  Baker" on others (22 Sept: both seen, one run apart, on the same
   *  wording), and either way the certificate refusal is what the entry
   *  proves; the table records which path the bar took. */
  expect: RegExp | { button: string; then: RegExp; question?: RegExp; orDirect?: RegExp };
  note?: string;
  voice?: true;
}

/** R-459 (S72-d, 24 Sept): the bar's own readouts stopped being an arrow
 *  chain of "·"-joined fields ("Sam Patel → Housing A · Plant 1 › Assembly ›
 *  Line 1 › Cell 1 · 2026-09-03 · 10:00–14:00") and became one or two plain
 *  sentences, the register CLAUDE.md §0 names: "Done. John Kim is on Cell 6
 *  today from 4 pm to 10 pm, making Housing A." No more arrow, middle dot,
 *  chain or 24-hour span -- every builder below matches the new shape.
 *  `esc` still escapes every literal fragment a regex is built from. */
function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** R-459: a spoken clock the same way `resolve.ts`'s own `spokenClock`
 *  reads one -- "4 pm", "10:30 am", "noon", "midnight" -- built once here
 *  from the walk list's own "HH:MM" fixture strings (`assignReadoutRe`'s
 *  own params, unchanged) so every call site below keeps naming hours the
 *  way the board itself does, never retyped per entry. */
function spokenClock(hhmm: string): string {
  const [hStr, mStr] = hhmm.split(":");
  const h = Number(hStr);
  const m = Number(mStr);
  if (h === 0 && m === 0) return "midnight";
  if (h === 12 && m === 0) return "noon";
  const period = h < 12 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12} ${period}` : `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

/** `<start> to <end>`, spoken -- `formatSpan`'s own words (`resolve.ts`). */
function spokenSpan(start: string, end: string): string {
  return `${spokenClock(start)} to ${spokenClock(end)}`;
}

/** A cell's own name in a sentence carries "in <line>" only when the board
 *  has more than one cell of that name (`cellDisplayName`, `resolve.ts`) --
 *  this walk's own board may or may not, so every builder below allows
 *  either: the bare name, or the name plus one optional "in <place>" tail. */
function cellPhrase(cell: string): string {
  return `${esc(cell)}(?: in [^,.;]+)?`;
}

/** `<who> is on <cell>[ in <line>] <day> from <span>, making <product>.`
 *  (+ " Joining the <run> job already there." / " Changing the block that
 *  ran <hours>." for a run/retime target) -- an assign's own readout
 *  (`resolve.ts`'s doc on `ResolvedCommand.readout`). The day word is left
 *  as `.+` -- this walk asserts the DATABASE row for exactness (brief §3);
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
    `^${esc(who)} is on ${cellPhrase(cell)} .+ from ${spokenSpan(start, end)}, making ${esc(product)}\\.(?: .+)?$`,
  );
}

/** `<cell>[ in <line>] is booked <day> from <span>, making <product>.[ For N
 *  people.]` -- a book's own readout. */
export function bookReadoutRe(
  product: string,
  cell: string,
  start: string,
  end: string,
  people?: number,
): RegExp {
  const tail = people !== undefined ? ` For ${people} people\\.` : "(?: .+)?";
  return new RegExp(
    `^${cellPhrase(cell)} is booked .+ from ${spokenSpan(start, end)}, making ${esc(product)}\\.${tail}$`,
  );
}

/** `<who>'s block on <cell>[ in <line>] now <edge>s <new>; it was <old>.` --
 *  an adjust's own readout (`resolve.ts`, the `adjustReadout` branch). */
export function adjustReadoutRe(
  who: string,
  cell: string,
  edge: "end" | "start",
  newT: string,
  oldT: string,
): RegExp {
  return new RegExp(
    `^${esc(who)}'s block on ${cellPhrase(cell)} now ${edge}s ${spokenClock(newT)}; it was ${spokenClock(oldT)}\\.$`,
  );
}

/** `The <product> job on <cell>[ in <line>] now takes N people; it runs
 *  <day> from <span>.` -- the headcount form's own readout (`resolve.ts`'s
 *  `resolveHeadcountCommand`). `<span>` is the run's own hours, asserted
 *  loosely here (the DB read after is what proves it). */
export function headcountReadoutRe(product: string, cell: string, n: number): RegExp {
  return new RegExp(
    `^The ${esc(product)} job on ${cellPhrase(cell)} now takes ${n} people; it runs .+ from .+\\.$`,
  );
}

export interface WalkDates {
  /** ISO `YYYY-MM-DD` of the walk's own day, the day after it, and a day
   *  well past the board's default 3-day window (`boardView.ts`'s own
   *  `windowDayCount: 3`), in Plant A's own zone (America/Chicago).
   *  F-182: `day` is the Monday of NEXT week (`walkDayInZone`), never
   *  today -- every sentence below that names a day says it as its ISO
   *  date, the shape entry 19 always used, so the walk's writes and its
   *  closing clears land on a day nobody is using. R-463 (29 Sept) retired
   *  the last day-less sentence (entry 20): its old too_short refusal was
   *  day-independent and wrote nothing regardless of which day it landed
   *  on, but the new one-minute floor turns that same span into a real
   *  write, so entry 20 now names its day explicitly too, like every other
   *  writing entry here. */
  day: string;
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
      say: `clear Cell 4 ${dates.day}`,
      expect: /^Cell 4 has nobody on it .+\.$/,
    },

    // 1b/1c and 1d/1e -- R-461's own end-to-end proof (28 Sept, S194-C
    // follow-up), placed here rather than near the end: R-461 needs a block
    // that actually crosses the WALK DAY's own midnight into the day after,
    // and nothing else in this walk (or the seed it starts from) leaves one
    // standing -- DEF-0042's own fix trims the seed's Sunday-night spill to
    // end EXACTLY at that midnight, on purpose, so it no longer crosses it
    // at all. So the walk makes its own crossing block, clears it, and
    // proves both of R-461's answers -- Cell 5 and Cell 6 are still wholly
    // untouched this early (entries 8 and 14 below are the first to reach
    // them, both on ordinary daytime hours that never overlap a 10 pm-6 am
    // block or its day-after remnant), so each pair is a lot of exactly ONE
    // change and never disturbs anything after it.
    //
    // 1b. Setup: Priya's own Shift 3 block on Cell 5, 10 pm to 6 am the day
    // after -- an ordinary single assign (S47), no question.
    {
      say: `Assign Priya Shah to Area 2 Frame A on Cell 5 in Line 3 ${dates.day} for shift 3`,
      note: "setup for 1c: R-461's own proof needs a block that crosses the walk day's midnight; the seed no longer leaves one (DEF-0042), so this makes one. The DAY WORD COMES BEFORE THE SHIFT CLAUSE -- confirmed live (28 Sept, S194-C): 'for shift 3 <day>' reads the day as part of the shift's own NAME (`extractShiftClause`'s `SHIFT_NAME` takes up to two words with no day/date word in its stop list, parse.ts), so the bar answered a Did-you-mean for a shift literally named \"3 2026-10-05\" and no block was ever written. `<day> for shift 3` parses cleanly (the same order RW3, commandParse.test.ts, already pins: 'weekdays next week for shift 2').",
      expect: assignReadoutRe("Priya Shah", "Area 2 Frame A", "Cell 5", "22:00", "06:00"),
    },

    // 1c. R-461 (DEF-0040), answered No: clearing Cell 5 for the walk day
    // finds ONE block whose part after the walk day's own midnight belongs
    // to the NEXT day -- the bar asks before touching it, previous/next
    // question shape, before any "Ready to do N things" (there is only one
    // change here, so a No/Yes answer runs it directly, S47 again -- no lot
    // question follows). No keeps the other day's part: the block is
    // TRIMMED (an edge move, R-461's `keep_after` fate), never deleted,
    // which the DB read below proves by its new range starting exactly at
    // that day's own midnight.
    {
      say: `clear Cell 5 ${dates.day}`,
      answer: "no",
      note: "R-461: a whole-day clear of a cell whose one block crosses the NEXT midnight asks first; No keeps the other day's part (a trim, not a delete) -- the DB read after asserts the block's new range starts that day's midnight, proving the OTHER day's part (10 pm to midnight) was cleared and this one survived, not the reverse.",
      // R-461 as amended (29 Sept): the question ends "Say cancel to stop."
      expect:
        /^Priya Shah's night shift runs into \w+\. Clear \w+'s part too, midnight to 6 am\? Say cancel to stop\.$/,
    },

    // 1d. Setup: Maria's own Shift 3 block on Cell 6 -- the symmetric case,
    // answered the other way next.
    {
      say: `Assign Maria Lopez to Area 2 Frame A on Cell 6 in Line 3 ${dates.day} for shift 3`,
      note: "setup for 1e: the other half of R-461's proof, answered Yes this time -- day before the shift clause, see 1b's own note.",
      expect: assignReadoutRe("Maria Lopez", "Area 2 Frame A", "Cell 6", "22:00", "06:00"),
    },

    // 1e. R-461, answered Yes: the SAME question, this time the other day's
    // part is cleared TOO, so the whole night-shift block is removed --
    // proved by its absence below, both days' worth, not merely trimmed.
    {
      say: `clear Cell 6 ${dates.day}`,
      answer: "yes",
      note: "R-461's other answer: Yes clears the other day's part too, so the whole crossing block is removed rather than trimmed -- the DB read after asserts no row at all remains for it.",
      expect:
        /^Maria Lopez's night shift runs into \w+\. Clear \w+'s part too, midnight to 6 am\? Say cancel to stop\.$/,
    },

    // 2. Assign with a part -- an ordinary single sentence, runs on its own
    // readout, no yes (S47).
    {
      say: `Assign John Kim to Housing A on Cell 3 in Line 2 from 8am to 12pm ${dates.day}`,
      expect: assignReadoutRe("John Kim", "Housing A", "Cell 3", "08:00", "12:00"),
    },

    // 3. The plural near-miss: "Common Fasteners" matches "Common Fastener"
    // directly through `matchName`'s own plural-stripping fallback tier --
    // no question at all.
    {
      say: `Assign Priya Shah to Common Fasteners on Cell 4 in Line 2 from 8am to 12pm ${dates.day}`,
      note: '"Common Fasteners" matches "Common Fastener" directly (the plural-stripping tier in matchName) -- no Did-you-mean question raised.',
      expect: assignReadoutRe("Priya Shah", "Common Fastener", "Cell 4", "08:00", "12:00"),
    },

    // 4. A real near-miss: "Housing Pay" clears the Dice-coefficient floor
    // against "Housing A" (D133 item 2) and offers it as a Did-you-mean
    // button.
    {
      say: `Assign Maria Lopez to Housing Pay on Cell 4 in Line 2 from 1pm to 3pm ${dates.day}`,
      expect: {
        button: "Housing A",
        then: assignReadoutRe("Maria Lopez", "Housing A", "Cell 4", "13:00", "15:00"),
      },
    },

    // 5. A sentence with no part at all -- "Which part? Cell 1 makes:" with
    // the cell's own menu as buttons (S60-b, R-422).
    {
      say: `Assign Sam Patel to Cell 1 from 8am to 4pm ${dates.day}`,
      note: 'no part named -- "Which part?" with Cell 1\'s own menu.',
      expect: {
        button: "Housing A",
        then: assignReadoutRe("Sam Patel", "Housing A", "Cell 1", "08:00", "16:00"),
      },
    },

    // 6. A booking with headcount.
    {
      say: `book Bracket A on Cell 3 in Line 2 for 3 people from 1pm to 5pm ${dates.day}`,
      expect: bookReadoutRe("Bracket A", "Cell 3", "13:00", "17:00", 3),
    },

    // 7. "from 2 until end of shift" -- F-151's lone-start rule reads a bare
    // "2" as 14:00 (afternoon), so the rules land on Shift 2 (14:00-22:00);
    // a model reading may instead take "2" literally as 02:00 and land on
    // Shift 3 (22:00-06:00) -- the bar's own status line is asserted either
    // way, never hand-picked.
    {
      say: `Assign Priya Shah to Line 1 Subassembly A on Cell 2 in Line 1 from 2 until end of shift ${dates.day}`,
      note: 'model gap until the sixth run: the rules read "2" as 14:00 (Shift 2, ends 22:00); a model reading may take it literally as 02:00 (Shift 3, ends 06:00). Both are accepted; the spec records which one the bar actually showed.',
      expect: new RegExp(
        `^Priya Shah is on ${cellPhrase("Cell 2")} .+ from (?:2 pm to 10 pm|2 am to 6 am), making Line 1 Subassembly A\\.(?: .+)?$`,
      ),
    },

    // 8. Tom Baker's setup block, off Line 1 (no certification needed) --
    // plumbing for the swap-refusal case next.
    {
      say: `Assign Tom Baker to Area 2 Frame A on Cell 6 in Line 3 from 8am to 2pm ${dates.day}`,
      note: "setup: Tom Baker's own block, so the swap-refusal entry below has a block of his to swap FROM.",
      expect: assignReadoutRe("Tom Baker", "Area 2 Frame A", "Cell 6", "08:00", "14:00"),
    },

    // 9. end/extend adjusts -- "end" shortens Sam's own Cell 1 block.
    {
      say: `end Sam Patel's block at 2pm ${dates.day}`,
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
      say: `swap Tom Baker and Sam Patel ${dates.day}`,
      note: "model gap: Tom Bakker (sixth run) -- on some runs; on others the name is heard and the refusal lands at once (orDirect)",
      expect: {
        question: /^No person called "Tom Bakker" on this board\. Did you mean one of these\?$/,
        button: "Tom Baker",
        then: /^Not done: Tom Baker is not certified for Cell 1, missing Welding\. Nothing changed\.$/,
        orDirect:
          /^Not done: Tom Baker is not certified for Cell 1, missing Welding\. Nothing changed\.$/,
      },
    },

    // 11. A split -- Sam's own Cell 1 block (now 08:00-14:00) split at 1pm.
    // CB-y-1: a split is a lot of two (move, then assign), one yes runs both.
    {
      say: `split Sam Patel's block at 1pm ${dates.day}`,
      answer: "yes",
      note: "splits Sam's 08:00-14:00 Cell 1 block into 08:00-13:00 and 13:00-14:00; a two-command lot (move, then assign), one yes runs both (CB-y-1).",
      expect: /^Ready to do 2 things: .+ Say yes to do them, or no\.$/,
    },

    // 12. extend -- John Kim's own Cell 3 block (08:00-12:00) by an hour.
    {
      say: `extend John Kim's block by an hour ${dates.day}`,
      expect: adjustReadoutRe("John Kim", "Cell 3", "end", "13:00", "12:00"),
    },

    // 13. The headcount form -- the run booked in entry 6. F-182: the day
    // now reads AFTER the count too, so this says it in the natural order.
    {
      say: `make the Bracket A job on Cell 3 4 people ${dates.day}`,
      expect: headcountReadoutRe("Bracket A", "Cell 3", 4),
    },

    // 14. Lena Novak's setup block -- plumbing for the (successful) swap
    // next; matches John Kim's own Cell 3 window (08:00-13:00, post-extend)
    // exactly, so the swap crosses two full blocks cleanly.
    {
      say: `Assign Lena Novak to Area 2 Frame A on Cell 5 in Line 3 from 8am to 1pm ${dates.day}`,
      note: "setup: gives Lena Novak a block of her own to swap with John Kim's.",
      expect: assignReadoutRe("Lena Novak", "Area 2 Frame A", "Cell 5", "08:00", "13:00"),
    },

    // 15. A swap -- both hold no Line 1 cell, so nothing is refused; a lot
    // of four (two removals, two crossed assigns), one yes runs all of it.
    {
      say: `swap Lena Novak and John Kim ${dates.day}`,
      answer: "yes",
      expect: /^Ready to do 4 things: .+ Say yes to do them, or no\.$/,
    },

    // 16. A copy to the day after -- Cell 3's own blocks/runs, copied
    // forward a day (both days said as dates: F-182).
    {
      say: `copy ${dates.day} to ${dates.tomorrow} for Cell 3`,
      answer: "yes",
      expect: /^Ready to do \d+ things: .+$/,
    },

    // 17. A repeat day, answered no: nothing written. R-416's rule is that
    // every day the repeat names must be ON THE BOARD, and "Show that day"
    // is the door when it is not -- "next week" was simply a day the walk's
    // own window never held, so the list, not the bar, was wrong.
    //
    // "next week" IS the walk's own week (F-182: the walk day is next
    // Monday), so the five days named are the walk's, never the week a
    // person is using. Note what
    // `resolveWeekDays` actually asks for: the WHOLE week, Monday to Sunday,
    // must be on the board before a `weekdays` repeat expands at all, and
    // what it then expands to is `days.slice(0, 5)` -- Monday to Friday, a
    // lot of FIVE (`src/test/commandBar.test.tsx`'s own CB-y-2 pins that
    // number). It is never the two or three of the week that happen to be in
    // the window.
    // The door used to be a "Show that day" button (S59/R-419); R-455 (24
    // Sept, lane S72-b, d5a8829) retired the press -- the bar moves the
    // window on its own and posts "Moved the board to next week." as one
    // line in the thread, then reruns the held sentence once the new
    // window's data lands, landing on the SAME lot question below with no
    // press at all. `expectAnswered` (typedWalk.spec.ts) already polls both
    // the live line and the filed thread turn, so the plain final regex
    // below is proof enough of both steps -- there is no button locator
    // left to wait on. The window is Mon-Sun afterwards, which still holds
    // the walk day -- entries 18, 21 and 22 below name it and are
    // unaffected.
    {
      say: "Assign Lena Novak to Bracket A on Cell 4 in Line 2 every weekday next week from 8am to 12pm",
      answer: "no",
      note: "a repeat day must be on the board (R-416); F-158 makes the move name the week, so R-455's own move widens the board to seven days on its own, no press. Five commands, Monday to Friday (CB-y-2), and no leaves every one of them unwritten.",
      expect: /^Ready to do 5 things: .+ Say yes to do them, or no\.$/,
    },

    // 18. An uncertified person on Cell 1, as an ordinary single sentence --
    // under "warn", a typed reason re-resolves with the override and writes
    // the block anyway (S61-b/R-425).
    {
      say: `Assign Tom Baker to Housing A on Cell 1 in Line 1 from 3pm to 5pm ${dates.day}`,
      answer: "the line supervisor approved the cover",
      note: "not_certified under warn: the typed reason re-resolves with eligibility_override -- the DB read after asserts eligibility_override = true.",
      expect:
        /^Not done: Tom Baker is not certified for Cell 1, missing Welding\. Say the reason to schedule anyway, or no\.$/,
    },

    // 19. A day past the board's own window -- R-455's own move (no press)
    // moves it, posting "Moved the board to <day>." first, then the held
    // sentence re-runs on its own once the new ctx lands.
    {
      say: `Assign Maria Lopez to Bracket A on Cell 3 in Line 2 from 8am to 12pm ${dates.far}`,
      expect: assignReadoutRe("Maria Lopez", "Bracket A", "Cell 3", "08:00", "12:00"),
    },

    // 20. RETIRED AGAIN, 29 Sept (R-463, S194-F): this entry's whole reason
    // for existing (see the 24 Sept history just below, kept for the
    // record) was a REFUSAL that had nothing to do with the day -- a
    // five-minute span used to be `too_short` unconditionally, so a
    // day-less sentence could still prove R-455's no-press move fires for
    // "today" while writing nothing anywhere. R-463 deleted the fifteen-
    // minute floor: five minutes is now a perfectly good block, so this
    // sentence, left day-less, would WRITE Lena Novak's block onto the REAL
    // machine's actual current day on the maintainer's live server -- the
    // exact hazard the 24 Sept repoint (and F-182 before it) both exist to
    // avoid. There is no longer a same-cell refusal this walk can lean on
    // that is BOTH unconditional and day-independent (every other Cell 1
    // refusal in this walk -- not_certified, outside-area -- sets an
    // override-reason flag the bar would then misread entry 21's own
    // sentence through, per the 24 Sept note below).
    //
    // So this entry is repointed AGAIN, this time onto an ordinary, dated,
    // successful write -- proving the new floor itself (R-463's "New cases:
    // a 1-minute block assigned... is written", the block form of RB13 in
    // `commandResolve.test.ts`) instead of a refusal. It carries the walk's
    // own day explicitly (`${dates.day}`) rather than defaulting to "today"
    // -- R-455's day-less move is no longer anything this entry needs to
    // prove (entry 19 already covers a day past the window; the day-less
    // path itself has no more day-independent refusal left to pair it
    // with), and a REAL write needs the walk's own synthetic day so the
    // closing "clear Area 1/2" sentences (21, 22) actually clean it up --
    // otherwise it would land on, and stay on, whatever day the machine
    // running the walk calls "today". The hour is 2pm-2:05pm, not 1pm-1:05pm
    // as the original sentence read: Cell 1 already holds Sam Patel's own
    // two blocks 8am-1pm and 1pm-2pm by this point (entries 9 and 11 above,
    // the "end"/"split" pair) and Tom Baker's 3pm-5pm block follows (entry
    // 18) -- 2pm-2:05pm is the one gap on Cell 1 that afternoon nothing else
    // in this walk touches.
    //
    // FOUND LIVE (running this lane's own rewrite, 29 Sept): Lena Novak is
    // not certified for Cell 1 (Welding, Line 1's own requirement) -- the
    // bar answers `not_certified` under `warn` before it ever reaches the
    // span/floor check at all, the exact same refusal entry 18 already
    // exercises for Tom Baker on this same cell. Rather than pick a
    // different, certified person (which would stop this entry proving what
    // R-463 actually changed for an UNCERTIFIED write too), this entry now
    // answers the certificate question the same way entry 18 does -- a
    // typed override reason -- so the 5-minute write still lands, proven by
    // the same `eligibility_override` read.
    //
    // History (24 Sept, R-459 review, S72-d): this used to be a day-LESS
    // sentence (defaults to "today") that the walk deliberately left
    // UNMOVED (F-182) -- the window sat on the walk's own week, today was
    // off it, "Show that day" stood unpressed, and the standing question was
    // the proof. R-455 (lane S72-b, d5a8829) removed that door: a
    // day_off_board move fires with no press at all now, so a day-less
    // sentence would move the window to the real machine's actual current
    // day and write there -- which is why this entry was repointed off its
    // original Maria Lopez/Cell 3 target onto a target refused for a reason
    // that had nothing to do with the day (a five-minute span, then
    // `too_short` unconditionally). R-463 is what retired THAT refusal in
    // turn, above.
    {
      say: `Assign Lena Novak to Housing A on Cell 1 in Line 1 from 2pm to 2:05pm ${dates.day}`,
      answer: "the line supervisor approved the cover",
      note: "R-463: proves the new one-minute floor itself -- a 5-minute block now WRITES. Lands on Cell 1's one free slot that afternoon (2pm-2:05pm, between Sam Patel's 1pm-2pm and Tom Baker's 3pm start), and, found live, Lena Novak needs the same not_certified override Tom Baker needed at entry 18 -- so this proves the floor AND an overridden write together, the DB read after asserting eligibility_override = true.",
      expect:
        /^Not done: Lena Novak is not certified for Cell 1, missing Welding\. Say the reason to schedule anyway, or no\.$/,
    },

    // 21 and 22. The clear of the walk day, at the end -- TWO sentences,
    // one per area. R-407's `everyone` form takes ONE place, and a place ABOVE the
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
    // independent database count of the walk day's rows taken just before
    // the first of them -- never a hand-summed number here.
    // R-455 (24 Sept, lane S72-b, d5a8829): the window is off the walk day
    // here no matter what came before (entry 19 left it on the far Monday;
    // entry 20 above, repointed after R-455, leaves it on the REAL
    // machine's actual current day) -- there is no button left to press
    // either way, the bar just moves and reruns on its own, posting "Moved
    // the board to <day>." first. The plain final regex below is proof
    // enough of both steps (`expectAnswered` polls the live line and the
    // filed thread turn the move updates in place, `typedWalk.spec.ts`).
    {
      say: `clear Area 1 ${dates.day}`,
      answer: "yes",
      note: "R-407: a place above the cells clears every cell under it -- Area 1 is Cells 1 to 4. Reached through R-455's own move, no press.",
      expect: /^Ready to do \d+ things: .+$/,
    },
    {
      say: `clear Area 2 ${dates.day}`,
      answer: "yes",
      note: "the other half of the clear -- Area 2 is Cells 5 and 6.",
      expect: /^Ready to do \d+ things: .+$/,
    },
  ];
}
