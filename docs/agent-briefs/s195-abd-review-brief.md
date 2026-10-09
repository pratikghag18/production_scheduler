# Review brief: S195-ABD review, break the bar's work of 30 Sept (DEF-0043, 0044, 0052, 0054, 0055, 0056, R-465's client half)

You are a reviewer, not the author. Three lanes built this today, uncommitted, in the working tree
at 992ffbc plus their edits: S195-A (`docs/agent-briefs/s195-a-bar-words-brief.md`), S195-B
(`s195-b-guard-and-proofs-brief.md`) and S195-D (`s195-d-the-popups-answer-brief.md`). **You
have one job: break it.** A review that finds nothing must say what it tried. Read `CLAUDE.md`
first (sections 4 and 7), then the three briefs, then the defect files they name
(`docs/defects/DEF-0043.md`, `0044`, `0052`, `0054`, `0055`, `0056`, `0057`), then
`git diff` for the files each brief lists.

Another reviewer is attacking the SQL half (`supabase/**`) on scratch databases; the tester's
stack's main database does not have migration 0085, so R-465's client half (the busy-elsewhere
sentence) is proved by scripted probes only, and you review it by reading and by unit cases, not
in the browser.

## What is claimed, and where to push

1. **The which-block and join buttons** read "Housing A on Cell 2, 2 pm to 10 pm", a night block
   names both days, the join button reads "Join the Housing A job, 6 am to 2 pm". Push: a block
   with no product; a job with no product; a person with three blocks on two cells; a block that
   starts at midnight; two blocks with identical hours on different cells (are the labels
   distinct?); what a typed answer must say to pick one, and whether the recognizer hint
   vocabulary (`src/lib/voice/recognizerHint*`, `src/test/recognizerHint.test.ts`) still names the
   words a person would say at these buttons. Lane D added "Do it" for a lot of one and did not
   put it in that vocabulary: check whether that matters and fix it if it is one line.
2. **"1 thing", the joins, "And 3 more."** Push: a lot of exactly six and of seven; a lot whose
   readouts contain a semicolon of their own; the `Written:` line for one and for many; the trace
   entry's `outcome` for each.
3. **Not done / Not tried carry the day and hours; a vanished block reads "no longer on the
   board".** Push the read-back in `src/lib/api/mutations.ts` (`throwIfGone`): a row that is gone
   AND the read-back fails (network); a row that is readable but the delete was refused by RLS
   (still "You cannot change that from here"?); a run deleted underneath (`deleteRun` maps
   `invalid_argument` "run not found": is that the only shape the server sends?); PostgREST's
   `PGRST116` on `maybeSingle` versus `single`: read the writer and say whether the code path is
   the one the real client library takes (the lane could not run it against a database). Two
   steps of one lot on the same day and cell for the same person: are the Not tried sentences
   still distinguishable?
4. **"clear Maria Lopez tomorrow" reads the person.** Push: a person whose name is also a cell's
   ("Cell 2" as a person is the lane's own case; try "Line 1"); a first name only ("clear Maria
   tomorrow"); a misspelling; "clear Maria Lopez and Sam Patel tomorrow"; "clear Maria Lopez"
   with no day; "clear everyone" and "clear the board" unchanged; the trace's `read` line. Does
   the person reading go through the SAME code the named-person removal uses, or a copy?
5. **The clear-everyone guard.** Push `src/lib/command/grounded.ts` with sentences of your own on
   both sides: orders that must ground ("yeah clear the board", "clear the board please", "clear
   everybody now", "right, clear everyone", "can you please clear the board", "clear out the
   whole board", "clear all of them"), and non-orders that must refuse ("we cleared everyone
   yesterday", "clear everyone? no", "I would never clear the board", "before you clear the board
   check with me", "clear the board is what he said"). For each that fails, decide from the
   file's own header which side is right and say so; fix the rule only if the fix is small and
   keeps every existing case, otherwise report.
6. **The pop-ups' answers (DEF-0054).** This is the one that depends on WHEN things happen, so it
   is the one to attack hardest. Read `src/features/board/hooks/useDragGesture.ts` (the
   `PopupReporter`), `CommandBar.tsx` (the popup outcome, post-at-the-ask, `supersedePopup`),
   `BoardPage.tsx` wiring, `CreatePopover.tsx` (`standing`, the StrictMode latch). Push: Continue
   pressed twice fast; Cancel then Continue (the pop-up is gone: what does the thread say?); a
   second sentence typed while the Continue? pop-up stands, then the pop-up answered; Escape on
   the pop-up; a typed "no" while the pop-up stands (the lane wired `onCancelWord` and did not
   drive it: DRIVE IT, in a unit case and in the browser); a re-time whose server write is refused
   after Continue; the lot runner with a step that would need the pop-up; a drag that replaces a
   standing create pop-up (the lane says the old turn is left waiting: is that a defect under
   R-434? say so); a page reload with the pop-up standing (the trace file has the ask; does the
   thread on reload say anything?); the hidden auto-press create (`standing: false`): a create
   that auto-presses and is REFUSED by the server; one that auto-presses and the server is slow.
   Everything you can drive in the browser, drive in the browser as Ana on the tester's stack, and
   copy the thread and the trace lines.
7. **Nothing printed as done before it is done (R-431), everywhere.** Grep `CommandBar.tsx` for
   every place a readout reaches the thread and say for each whether a write has been confirmed
   by then.
8. **A flake.** `src/test/commandBar.test.tsx` "CB-abs-1: 'Sam Patel is off today', recordable --
   both blocks and the absence in one lot, the absence LAST" failed ONCE in a full `npx vitest
   run` under load (four lanes' tests running) and passed alone and in its file twice. Read the
   case and the code it drives for a timer or a promise that is not awaited; run the file with
   `--repeat-each=5` or under `--maxWorkers=1` with the whole suite. If it is a real race, that is
   a finding; if the case itself waits on a wall clock, fix the case.
9. **Smaller leftovers from the lanes' own reports:** `AssignmentPopover.tsx`'s `describeRefusal`
   prints "would reach N% of capacity" and does not print the busy-elsewhere sentence when the
   refusal carries one (the lane says one line does it: do it, with a case);
   `CopyWeekDialog.tsx` ~l.653 says "X is already booked at this time." with no place (report
   only: it needs a shapes change); `SplitCoveragePopover` is claimed unreachable with an outside
   row (confirm by reading).
10. **The line ending trap.** `git ls-files --eol | findstr "w/crlf"` lists working copies with
    CRLF; `.gitattributes` (new today) says `* text=auto eol=lf`. Confirm `git diff` shows no
    whole-file line-ending churn in any of the lanes' files, and that `npx prettier --check` over
    every changed file passes (a CRLF working copy fails it; if so, normalise that file to LF in
    place, which changes nothing for git).

## How to work

The tester's stack is UP; do not run `tester-stack.mjs up`/`down`, start or stop a container, or
`npm run db:reset`; never touch the databases `sql_test_db` / `sql_demo_db` in its container (the
other reviewer's). Set the environment from `node scripts/tester-stack.mjs env` in the same
PowerShell command as each Playwright run (`$env:VITE_SUPABASE_URL` must be
`http://127.0.0.1:54421`). ONE Playwright process at a time, `--workers=1`, FOREGROUND; put back
whatever your browser runs write (the D lane restored Sam Patel's block with Dana's client; read
its DEF-0054 case in `e2e/typedWalk.spec.ts` for the shape). Throwaway specs under `e2e/` are
deleted before you report. The voice model is not served; `/v1/chat/completions` proxy errors are
noise. `npx vitest run --maxWorkers=2 <files>` for targeted runs; one full `npx vitest run` at the
end is allowed (the last total was `2 failed | 4847 passed (4849)` in 191 files; the two are live
pins that need the developer's stack, which is down).

You may FIX what you break when the fix is small and you are sure of it, in the files the three
briefs list as owned, plus `AssignmentPopover.tsx` and the recognizer hint files; every fix gets a
case, red without it. Say exactly what you changed. Anything larger, or anything that is a product
decision (a wording the maintainer has not chosen), you report and do not build. Mutations are
copy-backed (copy first, restore from the copy, diff to confirm). Do not touch `supabase/**`,
`src/lib/api/shapes.ts`, `src/lib/api/board.ts`, `src/features/board/components/OperatorPanel.tsx`,
`src/features/board/lib/railWords.ts`, `src/test/defects/**`, `docs/defects/**`, `docs/plan.yaml`,
`CLAUDE.md`. Do not commit. PowerShell runs npm/npx (no `&&`). Never `git checkout -- <file>`;
never patch with `Get-Content`/`Set-Content`.

## Report

Plain prose, findings first, most serious first: what a person would see go wrong, the exact
case or browser transcript that shows it, and whether you fixed it (with the case that now holds
it). Then every attack that held, one line each. Then the runner lines, copied. Then what you did
not try. If you changed code, a paragraph for the commit message in the repo's style (plain
ASCII, prose, no bullets).
