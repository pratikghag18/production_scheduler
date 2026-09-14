# S58-a — the grammar for group 2: adjust an edge, split, the job's hours, a headcount, every weekday (R-412 to R-416, D132)

You are lane A of S58. You own `src/lib/command/parse.ts` and `src/test/commandParse.test.ts`
only. Read `docs/design-plan.md` §19.103 (D132) and §19.101 (D130), the header of `parse.ts` and
the S55-a brief (`docs/agent-briefs/s55-a-grammar-brief.md`) for the house style and the S55 names
(`BOUNDARY_SHIFTS`, `DAY_END`, `EVERYONE`, the possessive timing tail of S52). `parse.ts` imports
nothing; keep every export (the data templates import them). Run only `npx vitest run
src/test/commandParse.test.ts src/test/commandPurity.test.ts` and `npx tsc --noEmit -p
tsconfig.json` (errors in resolve.ts/decode.ts/CommandBar/tests you do not own are lanes B–D's —
list them). No commits, no plan edits. Re-pin an existing case only with the reason beside it.

## 1. Types and exports (B, C, D and the data lane build on these exact names)
```ts
export type Adjust =
  | { edge: "start" | "end"; by: number }        // signed minutes; +60 = an hour later
  | { edge: "start" | "end"; at: ClockTime };
// MoveCommand gains:  adjust: Adjust | null;   — non-null implies span, shift and toPlace are all null
export interface SplitCommand { intent: "split"; operator: string; place: string[]; day: DayWord | null; at: ClockTime; }
export interface HeadcountCommand { intent: "headcount"; product: string; place: string[]; day: DayWord | null;
  span: { start: ClockTime; end: ClockTime } | null; shift: string | null; headcount: number; }
export type BoardCommand = ReplaceCommand | SwapCommand | CopyCommand | SplitCommand;   // split expands
export type Command = SingleCommand | SeveralCommand | BoardCommand | HeadcountCommand;  // headcount resolves on its own, never in a several
export type DayWord = … | { kind: "weekdays"; week: "this_week" | "next_week" } | { kind: "every_day"; week: "this_week" | "next_week" };
export const JOB_HOURS = "the job";                 // the fourth reserved shift name (R-414)
export const BOUNDARY_SHIFTS = [ALL_DAY, END_OF_SHIFT, END_OF_DAY, JOB_HOURS] as const;   // JOB_HOURS joins it
export const ADJUST_VERBS = ["extend", "lengthen", "shorten", "end", "finish"] as const;   // R-391: each in one list only
export const HEADCOUNT_VERBS = ["make", "set"] as const;   // "set" LEAVES ASSIGN_VERBS (see §3) — say so in the R-391 comment
export const REPEAT_WORDS = ["every weekday", "every day", "weekdays"] as const;
```
The two repeat day kinds are produced ONLY on an assign or a booking; anywhere else they are
`bad_day`. New `ParseFailure` members: `{ kind: "bad_adjust"; text: string }` (no distance or
time, or a distance of zero), `{ kind: "which_job" }` ("make it N people": say the job's name),
`{ kind: "no_split_time" }`.

## 2. Sentences (each a test case with this id)
Adjust (R-412), all a `move` with `adjust` set, `span`/`shift`/`toPlace` null:
- AJ1 `extend Sam's block by an hour` → operator Sam, place [], {edge end, by 60}. AJ2 `extend Sam by 30 minutes` → by 30. AJ3 `lengthen Sam on Cell 1 by 2 hours today` → place ["Cell 1"], day today, by 120. AJ4 `shorten Sam by an hour` → by −60. AJ5 `extend Sam's block by 0 minutes` → `bad_adjust`. AJ6 `extend Sam` → `bad_adjust`.
- AJ7 `end Sam early at 3` → {end, at 15:00} (the workday rule: a lone hour under 7 reads pm, as S55's edges). AJ8 `finish Sam at 15:30 on Cell 1` → place. AJ9 `end Sam an hour earlier` → {end, by −60}. AJ10 `finish Sam 30 minutes later` → {end, by 30}. AJ11 `end Sam` → `bad_adjust`.
- AJ12 `move Sam's start to 9` → {start, at 09:00}. AJ13 `shift Sam's end an hour later` → {end, by 60}. AJ14 `change Sam's start by an hour` → {start, by 60} (a bare "by" is later). AJ15 `move Sam's finish to 3 tomorrow` → {end, at 15:00}, day tomorrow ("finish" is an end). AJ16 `move Sam's start to 9 to Cell 2` → `bad_adjust`-class failure (an adjust never carries a destination) — pin which.
- AJ17 `formatCommand` prints AJ1 as `extend Sam by 1 hour`, AJ7 as `end Sam at 15:00`, AJ12 as `move Sam's start to 09:00`, AJ9 as `end Sam 1 hour earlier`; each round-trips. AJ18 `move Sam's timing to 8 pm to 11 pm` (S52's tail) is unchanged — pin it again beside the new tail.

Split (R-413):
- SP1 `split Sam's block at noon` → split {Sam, [], null, 12:00}. SP2 `split Sam on Cell 1 at 12 today` → place, day. SP3 `split Sam at 3` → 15:00 (workday rule). SP4 `split Sam` → `no_split_time`. SP5 round trip `split Sam on Cell 1 at 12:00 today`. `split` is its own first word (add it to no verb list; the first-word dispatch handles it — say how).

The job's hours (R-414), an assign with `shift: JOB_HOURS`, start/end null:
- JB1 `add Sam to the Housing A job on Cell 1` → product Housing A, place ["Cell 1"]. JB2 `put Sam on the Housing A run on Cell 1 tomorrow`. JB3 `add Sam to the "Bracket, left" job on Cell 1` (quoted part). JB4 `add Sam to the Housing A job on Cell 1 from 8 to 4` → `shift_and_hours`. JB5 `assign Sam to the Housing A job` → `no_place` (a job needs its cell). JB6 round trip: `formatCommand` prints JB1 as `add Sam to the Housing A job on Cell 1` and it parses back equal. JB7 `add Sam to Housing A on Cell 1 8 to 4` stays an ordinary assign (no "the … job").

Headcount (R-415):
- HC1 `make the Housing A job on Cell 1 4 people` → headcount {Housing A, ["Cell 1"], null, null, null, 4}. HC2 `set the Housing A job on Cell 1 to 4 people`. HC3 `make the Housing A job on Cell 1 today from 8 to 4 4 people` → span. HC4 `make the Housing A job on Cell 1 for shift 2 3 people` → shift "2". HC5 `make it 4 people` → `which_job`. HC6 `make the Housing A job on Cell 1 0 people` → `bad_headcount`. HC7 `set the Housing A job on Cell 1 to 100 people` → `bad_headcount`. HC8 round trip `make the Housing A job on Cell 1 4 people`.
- HC9 `set Sam on Housing A on Cell 1 8 to 4` — "set" was an ASSIGN verb (R-391); it now dispatches by what follows: "set the <x> job" is a headcount, anything else stays the assign it was. Keep the R-391 one-list rule honest: put "set" in `HEADCOUNT_VERBS` and make the assign path accept it as a SECOND-LOOK (document the exception in the R-391 comment and in the test), or keep it in `ASSIGN_VERBS` and let the headcount pattern claim "set the … job" first — choose, say which, and pin HC9 and PV2's verb-list expectations accordingly (re-pin PV2 with the reason if the lists change).

Every weekday (R-416):
- RW1 `assign Sam to Housing A on Cell 1 every weekday this week 8 to 4` → day {weekdays, this_week}. RW2 `book Housing A on Cell 2 every day next week 6 to 2` → {every_day, next_week}. RW3 `put Sam on Housing A on Cell 1 weekdays next week for shift 2` → {weekdays, next_week}, shift "2". RW4 `assign … every weekday 8 to 4` (no week) → this week. RW5 `remove Sam from Cell 1 every weekday this week` → `bad_day`. RW6 `assign … every weekday this week tomorrow …` → `two_days`. RW7 round trip: prints `every weekday this week` / `every day next week`.

## 3. Rules to keep
Every S55 and older case stays green unless a contract above changes it. `formatCommand` for
every new shape round-trips. Lists (" and ") are not read in split/headcount. Quoted names
containing the new keywords stay atomic (add one case: a person quoted as `"Sam's start"`).

## 4. Report
Exports added; the "set" decision and the "split" dispatch; re-pins and why; anything you could
not read; case counts before/after; tsc errors outside your files.
