# Review brief: S194-D and S194-E, the command bar and the resolver -- one job: break it

You are a reviewer, not the author. Two lanes changed the command bar and the resolver today and
nothing is committed. Lane E (Sonnet) built the bar's conversation; lane D (Opus) built the night
shift clear, the absence, the partial-day job trim, and then rewired the bar over lane E's work.
The main session ran the full suite: 4576 passed, 3 failed (two tester pins that cannot go green,
one live pin whose server is down). Green is where you START.

## Read, in this order

1. `CLAUDE.md` §4 and §7, whole.
2. `docs/plan.yaml` rows `R-461`, `R-409`, `R-432`, `R-436`, `R-462`, `R-430`, `R-431`, `R-434`,
   `R-435`, `R-459` (grep `^- id: R-461` and so on): claims AND notes. The notes carry the wording
   the maintainer chose today.
3. The defects: `docs/defects/DEF-0040.md`, `0041`, `0043`, `0046`, `0047`, `0048`, `0049`, `0051`,
   `0052`.
4. The briefs the lanes worked from, for what was asked: `docs/agent-briefs/s194-e-bar-conversation-brief.md`,
   `s194-d-night-shift-clear-brief.md`, `s194-d2-the-bars-half-brief.md`.
5. The diff: `git diff -- src/lib/command src/features/board/components/CommandBar.tsx src/features/board/components/CommandBar.module.css src/features/board/store/commandConversation.ts src/features/board/hooks/useDragGesture.ts src/features/board/BoardPage.tsx src/lib/voice scripts/voice/lib/form.mjs`
   It is large. Read the resolver's `planClear` and `absenceOutcome`, the runner's lot loop, and the
   bar's `runCommand`, `questionToStatus`, `buildLotOutcome`, `reportBarCrash`, `rewriteRefusal`,
   and every `postTrace` call.

## Rules

Another agent is editing `e2e/walk/**` and `e2e/typedWalk.spec.ts`; leave `e2e/` alone. Do not
commit. Do not run the full `npm run test` more than once, at the end. Never `npm run db:reset`.
**Write nothing to either running database** (read-only `psql` is fine). Do not run Playwright. Do
not run `bash scripts/run-sql-test.sh` (a leftover scratch database is waiting on the maintainer).
Do not edit `docs/defects/*.md`, `docs/plan.yaml`, `CLAUDE.md`, `src/test/defects/`. PowerShell runs
npm and npx (no `&&`). Never `git checkout -- <file>`: copy first, restore from the copy, and
confirm with a hash or `diff` after every mutation that the file is back. Never patch with
`Get-Content`/`Set-Content`.

## What you may write

New cases in ONE new file, `src/test/s194deReview.test.tsx` (use the render harness the way
`src/test/commandBar.test.tsx` does; import what it exports, copy what it does not). A case that goes
red is a finding; leave it red. You may FIX a finding in the lanes' files when the fix is a few
lines and the right answer is not in doubt; anything that changes what a person reads in a way the
maintainer has not chosen, or that is more than a few lines, you report. Say which you did.

## The main session's doubts -- test these first

1. **The server's rules, transcribed or re-derived?** Two client predicates now decide what the bar
   offers, and CLAUDE.md §4 says each cost a defect when the client guessed.
   (a) `hasWholeDayAbsence` in `BoardPage.tsx` claims to transcribe `absences_whole_day_excl`. Find
   that constraint's LAST definition in `supabase/migrations/` and the LAST `set_absence`
   (`grep -in "function \(public\.\)\?set_absence(" supabase/migrations/*.sql`, last hit; two
   signatures exist, find which the client calls). Compare term by term: whole-day against
   by-the-hour rows, inclusive or exclusive day ends, the plant's zone (R-426), a whole-day absence
   against an existing HOURLY absence on the same day. Any sentence where the bar says "recorded"
   and the server would refuse, or the bar says "already recorded" and the server would accept, is
   the finding that matters most.
   (b) The absence record is written LAST in the lot, after the removals. If `set_absence` refuses,
   the blocks are already gone. Under R-432 that is allowed and must be SAID. Build the case: two
   removals succeed, the record is refused. Read the answer as a supervisor would.
   (c) The trim of a job uses the run's timerange PATCH, not an RPC. What permission rule guards
   that PATCH (RLS policy on `runs`, a trigger)? As Ana, a Line 1 supervisor, clearing her own cell
   where a job's crew includes a block on a cell she cannot write: what does the resolver offer and
   what would the server do? The resolver sees only her board. CLAUDE.md §4: "anything resolved by
   walking up the tree", "a write that reports success can have changed nothing" (an RLS-filtered
   UPDATE changes zero rows and raises nothing). Does the runner read back, or check the row count,
   after the trim PATCH and after each crew trim? If a PATCH can silently change nothing, the bar
   prints Done over nothing: prove it or refute it from the code and the policies.

2. **"no" is now an answer.** At a night shift question a typed or spoken "no" presses No (keep the
   other day's part and GO ON to the lot) where everywhere else "no" cancels. A person who says "no"
   meaning "stop, do nothing" gets a lot offered. Check: after No, is anything written before a
   further yes? What do "cancel", "stop", "never mind", "nope", Escape do at the question? What does
   the question's own text tell the person their choices are? Is "Say yes or no." enough when
   neither of those cancels? Report what a person sees; propose the sentence; do not change it.

3. **Two questions, one sentence, a board move in between (R-455, R-461).** Clear a day that is off
   the board's window, with night shifts in both directions: the bar moves the board, reruns, asks
   previous, asks next, offers the lot. Are the answers held across the move, in the right order,
   against the right command? Answer Yes then No and No then Yes; the lots must differ exactly as
   the answers say. Then say a DIFFERENT sentence while the first question is standing: the held
   answers must not leak into it. Then press a Yes button from a FILED (old) turn in the thread, if
   filed turns keep live buttons.

4. **The trace (R-434), after two lanes edited it.** Lane E made the entry post at the ask and
   re-post as a correction; lane D joined asks and answers with newlines in one entry. For each of:
   a plain written sentence; one question answered; two questions answered; a question left open
   (teardown); a crash; a lot refused part-way; a board move then a refusal -- how many lines reach
   the server, and does the LAST line for that `at` hold the whole truth? Read
   `scripts/voice/clips/score.mjs` `readBarByAt` and anything else that reads `bar.jsonl`
   (`src/lib/voice/traceServer.ts` eviction at 500: do corrections count toward the cap, and can a
   long session now evict real turns sooner?). A newline inside `asked` or `answered`: does any
   reader split on newlines?

5. **The grounding guard (DEF-0041), attacked from both sides.** (a) Sentences that must NOT ground
   a clear of everyone: build twenty ordinary ones containing the everyday words with a pairing word
   by accident ("everyone is out to lunch", "the board meeting is off", "take the board down to the
   office", "everybody take a break", "clear skies today", "remove your gloves", "drop by my office",
   "pull up a chair", "cancel my lunch", "free coffee in the break room"). "clear", "remove", "drop",
   "pull", "cancel", "free" are STRONG words that ground alone: every one of those sentences with a
   model reading of clear-everyone grounds. Is that acceptable? The guard's job is that a misheard
   sentence never reaches a "Do all" button for the whole board. Report the list with ground or
   refuse beside each, and say what rule would refuse the bad ones without refusing "clear the
   board". Do not change the lists. (b) Sentences that MUST ground and might not: "get everyone
   off", "empty the board", "wipe Cell 3", "nobody on Line 1 tomorrow", "send everyone home".

6. **The done / not done answer on real lots.** Build lots of each kind and refuse the middle step:
   a swap; a copy; "everyone"; a clear with a job trim; an absence. Read every `attempted` and
   `notTried` as a supervisor. Look for: a sentence that says something stays which the lot already
   changed (a swap's second half never tried, after its first half moved a person); an ISO date
   (`An absence for Priya Shah 2026-10-12` is `attempted` and passes through `renderReadout` or it
   does not: check); a 24-hour span; "their" where the name would be clearer; "1 changes". The
   first line for a lot of one refused change.

7. **The partial-day trim (R-436) at its edges.** "Clear Cell 1 after 1 pm" when the job ends AT
   1 pm; starts AT 1 pm; when the window's edge leaves a remnant shorter than the minimum duration
   (`minDurationMinutes`: a 10-minute job remnant); on the night of a clock change; when the crew
   block's edge and the job's edge differ (crew 12:30 to 3, job 10 to 4). The refusal for a window
   inside a job: does it offer anything (R-430 says a dead end offers the nearest choices)?

8. **`CommandBar.tsx` is past 4,700 lines and two lanes wrote into it the same day.** Look for the
   seams: a helper both lanes wrote (two ways of setting `asked`), a wrapper lane E added that lane
   D's new path bypasses (does `answer_other_day_part` run inside the crash catch? does it post the
   trace at the ask?), dead code left by the rename `rewriteCapRefusal` to `rewriteRefusal`, the
   unused `eslint-disable` lane D reported.

## Then break it your own way

Mutate, copy-backed, and see a case go red BY NAME; a change no case notices is a finding. At least:
the `yesNo` equal-width style (R-447) removed; `markAbsence` call removed from `runCommand`;
`absenceRecordable` treated as "everyone" when undefined (fail open); the person fallback's cap of
eight removed; `reportBarCrash` claiming "nothing was changed" after a write; the sweeping-case
test in `groundReading` inverted.

## Run, at the end

`npm run test` once. Expected red: `DEF-0040.test.ts`, `DEF-0043-headcount.test.ts`,
`DEF-0020.test.ts`, and whatever findings you left red in your own file. Copy the total line.

## Report

Plain prose, findings first, most serious first. For each: what a person at the bar would see, the
case that shows it (name and the runner's line), whether you fixed it. Then each of the eight doubts,
confirmed or refuted with evidence; for doubt 1 the server's text and the client's side by side. The
mutations and what caught each. The runner's total, copied. What you did not examine.
