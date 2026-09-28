# Lane brief: S194-D, second pass -- the bar's half of R-461 and R-409, and R-432's answer said properly

Lane E has landed in the command bar. You now own the bar as well as the resolver. This pass wires
what you built in the first pass into the bar, and repairs one thing lane E could not do without
your file.

## Who else is in the tree

A reviewer is still in `scripts/voice/clips/`, `scripts/voice/serve/`, `supabase/dev_demo.sql`,
`supabase/tests/dev_demo_test.sql`, `e2e/`. Nobody else. Do not touch those.

Same hard rules as your first brief (`docs/agent-briefs/s194-d-night-shift-clear-brief.md`): do not
commit; no full `npm run test`; never `npm run db:reset`; write nothing to either running database;
no Playwright; no edits to `docs/defects/*.md`, `docs/plan.yaml`, `CLAUDE.md` or `src/test/defects/`;
never `git checkout -- <file>`; never `Get-Content`/`Set-Content` patching.

## Files you own in this pass

Everything from your first pass, plus:
- `src/features/board/components/CommandBar.tsx` and its CSS Module
- `src/features/board/store/commandConversation.ts`
- `src/features/board/BoardPage.tsx`, ONLY where the bar's context is built and the bar is mounted
- `src/lib/command/grounded.ts`, `src/lib/voice/verbGuess.ts` only if a new command kind forces it
- `src/test/commandBar.test.tsx`, `src/test/commandConversation.test.ts`, and the BoardPage test
  that covers the context, if one exists

## Read first

1. `git diff -- src/features/board/components/CommandBar.tsx src/features/board/store/commandConversation.ts src/test/commandBar.test.tsx`:
   lane E's work, uncommitted. Its brief is `docs/agent-briefs/s194-e-bar-conversation-brief.md`.
   Read `buildLotOutcome`, `reportBarCrash`, the ask-time `postTrace` calls, `turnResultLine`, and
   the `place` fallback in `questionToStatus`. These stay; you build on them.
2. `docs/plan.yaml`, rows `R-432` (its claim AND its note: the layout the maintainer chose) and
   `R-459`.

## Piece 1 -- your own nine items

The list you wrote at the end of your follow-up report, items 1 to 9, as written there. Notes:

- Item 2: the Yes and No buttons belong to one group; R-447 says they are the same width. Look at
  how the bar's other two-button questions are laid out and use that.
- Item 3: R-434. Every question asked and every answer given is in the trace entry. Lane E made the
  bar post the entry AT THE ASK and post a correction at the answer; your two questions follow that
  pattern, and a sentence that asks both questions is still ONE entry with both asks and both
  answers in it, in order. A pin for a bar feature asserts its trace entry.
- Item 8: `absenceRecordable` comes from the same read and the same query key the Absences screens
  use, so one cache serves all three. While it is loading or has failed the set is `undefined`,
  which your resolver already treats as unknown: nothing recorded, nothing claimed. Say in the
  thread, in that case, that the absence was not recorded and why, in a plain sentence.
- `CB-mid-2` in `commandBar.test.tsx` is red because a clear across midnight now asks first. The
  contract changed (R-461); rewrite it to answer the question and assert both outcomes.
- R-455: when the bar moves the board and reruns the sentence, the answers already given to the
  night shift questions survive the rerun. Write the case.

## Piece 2 -- R-432: the answer must not say a refused change happened

Lane E built the three labelled lines. But the resolved steps carry only a `readout`, the sentence
for a change that WAS made, so today the answer reads:

    Not done: Lena Novak is on Cell 3 today from 8 am to 4 pm. Lena Novak is not certified for Cell 3: missing Welding
    Not tried: Tom Baker is on Cell 1 today from 8 am to 4 pm. was not tried.

The first tells a supervisor Lena IS on Cell 3 under a label that says she is not. The reason is the
raw error. The second is not a sentence. The maintainer chose this:

    I made 1 of the 3 changes.
    Done: Sam Patel is on Cell 2 today from 8 am to 4 pm.
    Not done: Lena Novak on Cell 3. Lena Novak is not certified for Welding, which Cell 3 needs.
    Not tried: Tom Baker stays on Cell 1.

Build:
1. In `resolve.ts`, every resolved step kind carries two more strings beside `readout`, built by the
   same builders from the same facts at the same moment: `attempted` (who and where, no verb of
   completion: "Lena Novak on Cell 3", "the Housing A job on Cell 4", "Priya Shah's block on Cell
   4") and `notTried` (what stays as it was: "Tom Baker stays on Cell 1.", "Priya Shah's block on
   Cell 4 stays as it was, 10 pm to 6 am.", "Sam Patel is not on Cell 2." for a placement never
   made). You already gave `notTried` to `trim_run` and `record_absence`; this makes it every kind:
   assign, book, unassign, move, headcount, run removal, run trim, absence record. One builder per
   kind; no sentence is assembled in the bar. Names only, never a pronoun: the board does not know
   anyone's.
2. `buildLotOutcome` uses `attempted` and `notTried`. Lane E's fallback ("... was not tried.") is
   removed once every kind carries its own.
3. The reason, in the plant's words. Find where a certificate refusal's text is made (the client's
   `certificateGaps` and the server's refusal both produce one; find what reaches the lot's error)
   and give the refusal kinds a plain sentence through ONE rewriter, the one the single-sentence
   path uses (`rewriteCapRefusal` is the existing one; extend it or the function it sits in, do not
   add a second, R-449). At least: a certificate gap ("Lena Novak is not certified for Welding,
   which Cell 3 needs."), a capacity refusal (already done), an area refusal, an absence overlap, a
   permission refusal ("You cannot change Cell 3 from here."). Any kind still printing raw text is
   listed in your report. The single-sentence path gains the same sentences by construction; check
   its cases and say which strings changed.
4. An async rejection from `onRunLot` (lane E named it: `runLotNow`'s promise chain has no catch) is
   caught, answered through `buildLotOutcome` when the runner reports how many were done and through
   `reportBarCrash` when it cannot, and traced.
5. Cases: lane E's CB-lot-fail-1 to 4, CB-lot-3, CR-1, CB-t-4, CB-t-15 pin the interim wording;
   rewrite them to the sentences above (the contract is R-432's claim; lane E's wording was a
   stopgap, say so). Add a lot that holds one of each new step kind with a refusal in the middle.

## Piece 3 -- what lane E left open, which you now own

- The `unknown` question with no suggestions offers the caller's own cells for a PLACE only. R-430
  is a standard for a person, a product and a day too. Check each: when the resolver has no near
  match for a person or a product, does the bar stop with nothing to choose? If so, offer the
  nearest the caller can see (her own people, the board's products), capped the way the place list
  is capped, with the trace asserted.
- "Lin On", a fixture person, cannot appear in a list of several changes: the grammar reads the
  "On" of her name as the start of "on <place>". A real person could be called that. If the fix is
  in `parse.ts` and small (match known names before splitting on "on"), make it with a case; if it
  is not small, describe it and leave it.

## Proving it

1. `npx vitest run src/test/commandBar.test.tsx src/test/commandConversation.test.ts src/test/commandResolve.test.ts src/test/s194bReview.test.ts src/test/dragGesture.test.ts src/test/commandParse.test.ts src/test/grounded.test.ts src/test/verbGuess.test.ts src/test/trace.test.ts src/test/traceServer.test.ts src/test/voiceRead.test.ts src/test/voiceData.test.ts src/test/dateSeam.test.ts src/test/scaleAudit.test.ts src/test/defects`
   Expected red, and only these: DEF-0040's pin, DEF-0043-headcount's pin (the main session is
   writing developer notes for both), and DEF-0020's live pin if it fails under load (run it alone
   and say what it did). Anything else red is yours to explain.
2. The R-459 wording inventory suite (grep `src/test` for it): every sentence you add has its pin
   there in that suite's style.
3. Mutations, copy-backed, red by name: drop the options pass-through; answer the second question
   with the first's answer; drop the absence record from the lot's order; make `attempted` the
   readout; drop the `onRunLot` catch.
4. `npx tsc -b` and `npx eslint` over your files: clean.
5. Grep `e2e/` for every sentence you changed or that lane E changed ("Ready to do", "Done,",
   "things", "the next failed", "now ends midnight", "on this board") and list each hit with file,
   line, old string and new string. You do not edit `e2e/`; the main session hands the list on.

## Report

Plain prose. Per piece what changed. Every existing case rewritten and whether it was wrong or the
contract changed. A two-column table of every sentence a person reads that is new or changed in
this pass. The mutations. The runner's totals, copied. The `e2e/` list. What you did not do. A draft
commit message in the repo's style: plain ASCII, reasoning in prose, no bullets.
