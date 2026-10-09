# S58-b — the resolver for group 2: adjust, split, the job's hours, a headcount, every weekday (R-412 to R-416, D132)

You are lane B of S58. You own `src/lib/command/resolve.ts` and `src/test/commandResolve.test.ts`
only. Lane A has landed the types (read `docs/agent-briefs/s58-a-grammar-brief.md` §1 and the
header of `parse.ts`: `Adjust`, `MoveCommand.adjust`, `SplitCommand`, `HeadcountCommand`, the two
repeat day kinds, `JOB_HOURS` in `BOUNDARY_SHIFTS`). Read `docs/design-plan.md` §19.103 (D132)
and §19.101 (D130), then the S55-b brief for the house style of `expandCommand` and the written
commands' words. Run only `npx vitest run src/test/commandResolve.test.ts` and `npx tsc --noEmit
-p tsconfig.json` (errors elsewhere are lanes C/D's — list them). No commits, no plan edits.

## 1. Adjust (R-412) — inside `resolveMoveCommand`
When `command.adjust` is set: find the block exactly as a place-less or placed move does today
(the person, the cell or wherever they are, the day, `move_which` when several, `existing` when
answered). Then the new range: `by` → the named edge moves by that many minutes (a negative
`by` on the end shortens; on the start it starts earlier); `at` → the named edge is set to that
wall-clock time on the block's day (`wallToOffset`). Checks, in order: the new start must be
before the new end (`time_order`-class question — reuse `too_short` with the resulting minutes when
it is ≤ 0? No: a new question `{ kind: "adjust_inverts"; person; block }` "…would end before it
starts"); the new span must be at least the minimum (`too_short`); a result crossing the day's
midnight is a question `{ kind: "adjust_off_day"; person; block }`. The target is `retime` with the
new range; the readout names the block's old hours and the new. `adjust` with `toPlace` or `span`
or `shift` set is a contradiction the grammar never produces — `expand_first`-style refusal, one
line.

## 2. Split (R-413) — in `expandCommand`
`SplitCommand` → the person's block (placed or anywhere, that day, `move_which`-style: when several
blocks overlap the day, the `at` picks the one containing it; none contains it → `{ kind:
"split_outside"; person; at: string; blocks: string[] }`). Both parts must reach the minimum
duration (`too_short` otherwise). Writes a `move` in time (`existing` filled, `span` = start–at,
`adjust` null) and an `assign` (the block's part, cell words, day, at–end, `attach` run/direct from
`runId`, `existing` null, `shift` null) — the move first. A `split` reaching `resolveCommand`
unexpanded → `expand_first`.

## 3. The job's hours (R-414) — in `resolveShiftSpanStep` and the assign path
`shift === JOB_HOURS` (case-insensitive) on an assign: after the cell and the part resolve, the
runs of that part on that cell overlapping the day: none → `{ kind: "no_job"; product; cell;
when }`; more than one → `{ kind: "which_job"; product; cell; runs: string[] }` (the runs' `span`
strings); one → the span is the run's minutes and the target is `{ kind: "run", runId }`
(`attach` need not be asked — the sentence named the job). Every later check (the own-block
question R-385, `too_short`) runs as for any assign. On a booking, `JOB_HOURS` is meaningless →
`no_shift`-class refusal naming it. On a removal or a move it reads as "the block's job's hours":
not needed now — refuse the same way, one line, pinned.

## 4. Headcount (R-415) — a new resolver branch and result
`HeadcountCommand` → cell, part, day, then the run: the span or shift narrows when given, else
the whole day; none → `no_job`; several → `which_job`; one → `ResolvedHeadcount { intent:
"headcount"; runId: string; nodeId; headcount: number; readout }` (a new member of the resolved
union — the bar's `onSetHeadcount` takes it). Nothing here checks the number beyond the grammar's
1–99. A `headcount` inside a `several` cannot occur (types); `expandCommand` returns it unchanged.

## 5. Every weekday / every day (R-416) — in `expandCommand`
An assign or a booking whose `day.kind` is `weekdays` or `every_day`: the week's day indexes as
D130's copy does (`this_week` = the Monday-to-Sunday week containing today; `weekdays` = Monday to
Friday of it); every day must be on the board (`day_off_board` naming the first missing iso); write
one copy of the command per day with `day: { kind: "date", iso }`, in order, every other field
copied (`attach`/`existing` as given). Any other intent with such a day → `bad_day`-class question
(the grammar never produces it; one line). `resolveDay` on these kinds → the same refusal.

## 6. Tests (`commandResolve.test.ts`), one id each
AJ1–AJ8 (extend, shorten, end at, start at, earlier/later, inverted, too short, off the day, which
block when several), SP1–SP5 (a direct block; a run block keeps the attachment; at outside; a part
too short; no block), JB1–JB4 (one run; none; two; the own-block question still runs), HC1–HC3
(one run; none; two), RW1–RW4 (five assigns in order; a booking every day of next week; a day off
the board; the other kinds unchanged), and the SWEEP describe extended to the new written commands.
Every S55 case stays green unless a contract changed; write why beside any re-pin.

## 7. Report
New question kinds with fields; the new resolved member; ctx changes if any (avoid them);
re-pins; case counts; tsc errors outside your files.
