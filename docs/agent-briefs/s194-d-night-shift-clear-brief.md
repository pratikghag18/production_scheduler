# Lane brief: S194-D, the night shift clear and the one-day absence -- DEF-0040 (R-461), DEF-0048 (R-409), DEF-0044 item 4

You are a build lane, on Opus by the maintainer's word for this one lane, because it has a design in
it. The design questions that are the MAINTAINER'S are already answered below; do not reopen them.
The ones that are yours (how the resolver represents a split, how a job is trimmed) you decide, and
you write the reasoning down.

Line numbers are from 28 Sept; trust the names.

## Who else is in the tree

- Lane E is building in `src/features/board/components/CommandBar.tsx`, `src/lib/command/grounded.ts`,
  `src/lib/voice/verbGuess.ts`, the trace files, `commandConversation.ts` and
  `src/test/commandBar.test.tsx`. **You do not touch those until the main session tells you lane E has
  landed** (see "The bar's half" below).
- Lane A is finishing a small fix in `AbsencesPanel.tsx`. A reviewer is in `scripts/`, `supabase/
  dev_demo*`, `e2e/`.

Do not commit. Do not run the full `npm run test`. **Never `npm run db:reset`; write nothing to the
running databases** (`supabase_db_production_scheduler` is the maintainer's,
`supabase_db_production_scheduler_tester` the tester's; read-only `psql` is fine). Do not run
Playwright. Do not edit `docs/defects/*.md`, `docs/plan.yaml`, `CLAUDE.md`, or anything under
`src/test/defects/`. PowerShell runs npm and npx (no `&&`); the Bash tool runs `.sh`. Never
`git checkout -- <file>` (copy first). Never patch with `Get-Content`/`Set-Content`.

## Files you own

- `src/lib/command/resolve.ts`, `src/test/commandResolve.test.ts`
- `src/features/board/hooks/useDragGesture.ts` (the lot runner, about l.2842 to l.2930) and
  `src/test/dragGesture.test.ts`
- `src/lib/command/parse.ts` or wherever the absence grammar lives, and `src/test/commandParse.test.ts`
  (piece 2 only, and only if the parser must mark an absence)
- a new migration and its SQL test ONLY if piece 1's design needs one (see there)
- `src/test/s194bReview.test.ts` exists from the reviewer of the lane before you; keep it green, add
  to it or to `commandResolve.test.ts` as you see fit.

## Read first

1. `CLAUDE.md` §4 whole (every line cost a defect; "extract, never retype", "a write that reports
   success can have changed nothing", "a green case can be pinning the bug") and §7 whole.
2. `docs/defects/DEF-0040.md` and `DEF-0048.md` whole, including the tester's second-pass notes and
   the maintainer's decisions at the end of DEF-0040; `DEF-0044.md` item 4; `DEF-0047.md`.
3. In `docs/plan.yaml`: the rows `R-461`, `R-409`, `R-407`, `R-436`, `R-431`, `R-432`, `R-357`
   (grep `^- id: R-461` and so on). R-461's claim and note ARE the specification.
4. `git diff -- src/lib/command/resolve.ts`: the lane before you (S194-B) and its reviewer changed
   this file today and nothing is committed. Read `docs/agent-briefs/s194-b-resolver-brief.md` and
   `docs/agent-briefs/s194-b-review-brief.md` for what they did. Their changes stay.
5. `expandEveryoneUnassign` (resolve.ts, about l.3724 to l.3900) with its comments, especially the
   REVIEWER FIX comment about `delete_run`'s cascade; `expandRepeatUnassign`; `expandAbsence`.
6. The LAST definitions of `delete_run` and `move_run`
   (`grep -in "function \(public\.\)\?move_run(" supabase/migrations/*.sql`, LAST hit; the same for
   `delete_run`, `set_absence`, `absence_recordable_people`). `move_run` was re-emitted many times;
   only the last one is the function.
7. The pins: `src/test/defects/DEF-0040.test.ts`, `src/test/defects/DEF-0048.test.ts`.

## Piece 1 -- R-461: a night shift is split at midnight

### What the maintainer decided (28 Sept), not open

- A block or a job across midnight belongs to two days. Clearing a day removes ONLY that day's part
  of every block and every JOB on the place.
- Before anything is written the board asks, Yes or No, whether the other day's part goes too. At
  most TWO questions for the whole clear, however many shifts it touches: one for every
  previous-day part, one for every next-day part. Each is answered on its own. A clear that touches
  one direction asks one question.
- No keeps the other day's part. Yes removes the whole shift (block and, where the whole job then
  has nothing left, the job).
- The readout says exactly which parts went and which stayed. Nothing the readout says stayed may be
  removed by any other step of the same clear. This last sentence is the pin's invariant.
- How the questions read (chosen from two candidates): they name the people and the hours.
  "Priya Shah's night shift started Sunday at 10 pm. Clear Sunday's part too, 10 pm to midnight?"
  "Maria Lopez's night shift runs into Tuesday. Clear Tuesday's part too, midnight to 6 am?"
  Several people: first by board order and the count of the rest: "Priya Shah and 2 others started
  their night shift Sunday at 10 pm. Clear Sunday's part too?" When the parts do not share hours,
  the hours are left out of the question rather than listing each. A job with no crew on it is named
  as the job: "The Housing A job on Cell 4 started Sunday at 10 pm. Clear Sunday's part too?"
- Every sentence is R-459's: spoken hours ("10 pm", "midnight"), spoken days ("Sunday", "Mon Oct
  12" in the forms the existing builders produce), no ISO date, no 24-hour span, no dash chain.

### What is wrong today

The clear trims the person's block at midnight (a `move` of one edge) and then removes each JOB that
overlaps the day with `delete_run` in `cascade` mode, which deletes every assignment with that
`run_id` regardless of time. The job's removal takes the trimmed block with it, and the job's own
other-day part. The bar said kept; the database says gone.

### What you design

1. **How a job is trimmed.** A job across the cleared day's edge must keep its other-day part (on
   No) with its crew's other-day parts. Look at the last `move_run`: does re-timing a run to the
   shorter range move or clip its crew's blocks, refuse when crew sit outside, or leave them? Can
   the existing RPCs (`move_run` for the job, the block edge move for each crew block) express "trim
   the job and its crew to the part outside the day" in an order that never passes through a state a
   guard refuses? If yes, no migration. If the existing RPCs cannot do it safely, write ONE new
   migration (append-only, next number, the repo's header style) with a definer RPC that trims a run
   and its crew in one transaction, gated by the same permission test `move_run` uses, extracted not
   retyped, with a SQL test file beside the others holding it person by person (Ana on Line 1
   trimming a job on Line 2 is refused). Say which you chose and why, in the report and in the
   code's comment. After a migration: `npm run db:types` is needed before `tsc` means anything;
   you cannot apply a migration to the running stack (the maintainer's), so say "tsc inconclusive
   until db:types" and hand back the command.
2. **A job wholly inside the cleared day** is removed as today. **A job across the edge whose answer
   is Yes** is removed whole as today. The cascade is then correct, and no trim of its crew is
   queued in the same lot (that pair is the defect).
3. **How the questions reach the person.** The resolver already answers with questions that carry
   candidate answers (the which-block question is one; read how `Question` kinds carry candidates
   and how the bar feeds the chosen answer back through `ResolveOptions` on the rerun). Add the two
   questions in that same shape so the bar's existing machinery can ask them: a kind for the
   previous-day parts and a kind for the next-day parts (or one kind with a direction), each with
   Yes and No, each answer carried back as an option on the rerun. Asked one at a time, previous day
   first. The expansion is pure: given the command, the context and the answers so far, it returns
   either the next question or the lot.
4. **The week clear** (`expandRepeatUnassign`, everyone branch) calls the one-day expansion per day.
   Inside the span, a night block between two cleared days is ONE removal, no question (both its
   days are being cleared). Only the span's outer edges ask: a shift running INTO the first day
   from the day before, and one running OUT of the last day. Still at most two questions for the
   whole sentence. The reviewer before you may have already made the inside case one removal; read
   what is there and build on it. The week clear of a NAMED person follows the same rule.
5. **The readout** for each part: what went, what stayed. "Priya Shah's Sunday night shift on Cell 4
   now ends at midnight; Monday's part, midnight to 6 am, is cleared." Build it with the builders
   the file has (`spokenizeSpans`, the day words); read three or four existing readouts first and
   match their register.
6. **Clock changes.** Midnight is the plant's midnight (R-426): a split goes through the context's
   own day windows, never arithmetic on 1440. Cases on the night of 8 March 2026 and 1 November 2026
   in America/Chicago and one in Europe/Berlin, on the REAL axis (`buildDayAxis`/`wallOf`), as
   `DEF-0047.test.ts` builds it.

### Cases (commandResolve.test.ts), at least

Clear Monday, one block Sunday 22:00 to Monday 06:00 on a job: asks the previous-day question; No
gives a lot that trims the block AND the job to end at midnight, nothing removed whole; Yes gives a
lot that removes the block and the job whole, no trim. Clear Monday, a block Monday 22:00 to Tuesday
06:00: the next-day question, both answers. Both at once: two questions in order, the four answer
pairs. Three night blocks in one direction: ONE question naming the first and "2 others". A direct
block with no job. A job with no crew. A crew member whose block sits wholly on the other day (the
REVIEWER FIX comment's case): on No it stays untouched and is said to stay. The invariant, as a
property over every case above: no assignment id the lot says it keeps or trims appears under a
removal, and no run removed by cascade has a crew block the lot says stays.

### What the reviewer of the lane before you left for you (it landed; read this before you start)

`src/test/s194bReview.test.ts` holds 15 cases, ONE red on purpose, and it is yours to turn green:

- **DEF-0047's own live sentence is still broken.** "clear Line 1 for the rest of the week" takes
  the EVERYONE branch of `expandRepeatUnassign`. For a night block whose both days are inside the
  span, each day's call to `expandEveryoneUnassign` emits an edge trim (`move`) on the same
  assignment id: `{edge:"start", at 23:59}` then `{edge:"end", at 00:00}`. Two commands on one
  block, which the bar's duplicate guard refuses. The lane before you de-duplicated removals and run
  removals only. The red case is `doubt 1 > "FINDING: ... becomes ONE removal ... (currently two
  conflicting trims)"`; the green case beside it records today's shape and will need rewriting when
  you fix it (say so: the contract changed). The same is reproduced in clock-change weeks in Chicago
  and Berlin. This is item 4 of "What you design" above.
- **A de-duplication nothing tests.** In the everyone branch, removing the `queuedAssignmentIds`
  check for plain removals turns no case red. The shape it guards is a run across midnight whose
  crew member sits outside a narrowed window, re-added by two day-calls. Your rework of this branch
  either keeps that guard with a case that holds it, or makes it unnecessary; say which.
- **The adjust carry** (DEF-0046) is now held by a case in `s194bReview.test.ts`; keep it green.
- **`s194bReview.test.ts` has a type error** (`npx tsc -b`: TS2677 / TS2339, a type predicate on
  `Resolution`). Vitest does not type-check, so the file runs; fix the predicate so `tsc` is clean
  over it.
- **A run's headcount of 0** reads "0 people" and no database constraint forbids 0. Not yours to
  fix; do not build on a headcount being at least 1.
- **Two NUL bytes in the committed `src/test/commandResolve.test.ts`** (byte offsets 8037 and 8114,
  each where a space belongs inside a template literal in a helper near the top; both the key
  builder and the lookup carry it, so it is self-consistent). Replace each with a space, with node
  (read the file as a buffer, write it back as UTF-8, no BOM), and confirm the suite's count does not
  change.
- The "nothing to change" guard in `resolveMoveCommand` cannot be reached by any sentence the parser
  produces today; it guards hand-built commands. Leave it.

## Piece 2 -- DEF-0048 / R-409: "Sam Patel is off tomorrow"

Decided by the maintainer (28 Sept): the one-day form takes EVERY block the person has that day
with one yes, never a which-block question; and the same yes RECORDS THE ABSENCE through
`set_absence`, the function the absence form uses.

1. The parse of "Sam is off tomorrow" is identical to "remove Sam tomorrow" today (only `until`
   marks an absence). Mark the absence in the parsed command (a field, null or false otherwise) so
   the resolver can tell them apart; "remove Sam Patel tomorrow" with two blocks keeps asking which.
   The served model's decoder and the training data have a shape for unassign
   (`src/test/voiceRead.test.ts`, `src/test/voiceData.test.ts`): a new REQUIRED field would break
   both. Make the mark something the rules parser sets from the words (off, out, sick, on leave,
   away) and the model's reading gets by the same words being present in what was heard, without
   changing the decoder's schema. If that cannot be done without touching the decoder, stop and
   describe the two options in your report.
2. `expandAbsence` handles the `until` form. Extend it (do not build a second expansion) so the
   one-day form goes through it: one removal per block that day, board order.
3. The absence record. A new resolved step, written LAST in the lot by the runner through the same
   client function the absence form calls (find it from `AbsenceForm.tsx`; do not write a second
   caller shape). The day or days are the sentence's; whole-day. R-431: the bar must not offer a yes
   the server will refuse, so before the lot is offered the resolver needs to know the person is
   recordable for this caller. The context (`ResolveContext`) is built by the bar; you may need a
   new field on it carrying the ids from `absence_recordable_people()`. Define the field and the
   resolver's use of it; building the context in the bar is lane E's file, so describe the wiring
   for the main session (see "The bar's half"). When the person is not recordable for the caller,
   the blocks may still be the caller's to remove: the lot removes the blocks and the answer says
   plainly the absence was not recorded and why ("I cannot record an absence for John Kim from
   here; his blocks are cleared."). Night shift: an absence of one day against a block across
   midnight follows R-461's split, and asks the same question.
4. A person with nothing on the board that day: the absence is still recorded (that is what the
   sentence said), and the answer says so.
5. Readout: "Sam Patel is off tomorrow. His 2 blocks on Cell 1 are cleared and the absence is
   recorded." You do not know a person's pronoun: use the name or "their". 

Cases: two blocks one yes; one block; no block; not recordable; the `until` form unchanged (AB1 to
AB3 stay green untouched); "remove Sam Patel tomorrow" still asks which.

## Piece 3 -- DEF-0044 item 4: the job removal is held at the execution layer

With `await deleteRun.mutateAsync({ runId, mode: "cascade" })` deleted from the runner, 664 cases
stayed green. Add a case in `dragGesture.test.ts` (or where the lot runner is tested) that runs a
lot holding a `remove_run` and asserts the mutation was called with that run id and mode; and the
same for whatever new step kinds you add (the job trim, the absence record). Prove each by
mutation: delete the call on a copy-backed file, red by name, restore, green.

R-432 (restated 28 Sept) wants the answer after a failure to name what was not tried. The runner
returns `{ done, error }` and the bar holds the list; if your new step kinds need to say "what stays"
for a change never tried, make sure each resolved step carries the facts to say it (person, place,
day, hours). Lane E may report a missing field; the main session will pass it on.

## The bar's half

You will reach a point where the resolver and the runner are done and proved by their own suites,
and what remains is in `CommandBar.tsx`: the two new questions drawn with Yes and No, their answers
fed back, the recordable set put on the context, the new step kinds in the confirm listing and the
Done line, a trace entry for each question and answer (R-434). STOP THERE and report. List exactly
what the bar must do, with the names of the types and fields you added. The main session will tell
you when lane E has landed and you then do the bar's half in a second pass.

## Proving it

1. `npx vitest run src/test/defects/DEF-0040.test.ts src/test/defects/DEF-0048.test.ts`: green by
   name. If a pin cannot go green without the bar's half, say which assertion and why.
2. `npx vitest run src/test/commandResolve.test.ts src/test/s194bReview.test.ts src/test/dragGesture.test.ts src/test/commandParse.test.ts src/test/voiceRead.test.ts src/test/voiceData.test.ts src/test/dateSeam.test.ts src/test/defects/DEF-0046.test.ts src/test/defects/DEF-0047.test.ts src/test/defects/DEF-0043.test.ts src/test/defects/DEF-0043-headcount.test.ts`
3. `npx vitest run src/test/commandBar.test.tsx`: not yours, and lane E is changing it as you work,
   so a red case there may be theirs. List any red case that names a clear, a job removal or an
   absence, with the old and new expectation; do not edit the file.
4. Existing cases of yours that go red: read them BEFORE touching your fix. R-461 changes the
   contract of a clear across midnight, so some were right when written. Say for each, in writing,
   whether it was wrong or the contract changed.
5. If you wrote a migration: `bash scripts/run-sql-test.sh --rebuild`, then your SQL file and the
   neighbours that call `move_run` or `delete_run`; paste the tally lines.

## Report

Plain prose. The design decisions you made and why, first: how a job is trimmed, migration or not,
how the questions are represented, how the absence is marked. Then per piece what changed. Every
existing case you changed and whether it was wrong or the contract changed. A two-column table of
every sentence you added, as the person reads it. The mutations, red by name then green. The
runner's totals, copied. The list for the bar's half. What you did not do. A draft commit message in
the repo's style: plain ASCII, reasoning in prose, no bullets.
