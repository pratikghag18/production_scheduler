# S55-a — the grammar widens for the catalogue's groups 1 and 3 (R-404 to R-409, D130)

You are lane A of S55. You own `src/lib/command/parse.ts` and `src/test/commandParse.test.ts`
and nothing else. Read this brief, then `docs/design-plan.md` §19.101 (D130), then the header of
`parse.ts` and the S52-a brief (`docs/agent-briefs/s52-a-shift-grammar-brief.md`) for the house
style: every rule is a comment with the requirement it serves, every sentence in this brief is a
test case with an id, every contract change to an existing test is re-pinned with the reason
written beside it (CLAUDE.md §4, "a green case can be pinning the bug").

`parse.ts` imports nothing (`src/test/commandPurity.test.ts`); exported constants are fine.
`scripts/voice/lib/templates.mjs` imports the verb lists from this file — do not rename or remove
any export. Do not run the full `npm run test`; run `npx vitest run src/test/commandParse.test.ts
src/test/commandPurity.test.ts` and `npx tsc --noEmit -p tsconfig.json 2>&1 | grep parse.ts`
(errors in files you do not own are the other lanes' — ignore them, but list them in your report).

## 1. The types (other lanes build on these exact names)

```ts
export type DayWord =
  | { kind: "today" } | { kind: "tomorrow" } | { kind: "yesterday" }
  | { kind: "weekday"; day: 0|1|2|3|4|5|6 } | { kind: "date"; iso: string }
  | { kind: "this_week" } | { kind: "next_week" } | { kind: "last_week" };
```
The three week kinds are legal ONLY on a `copy`'s `from`/`to`; on any other form the grammar never
produces them (a "this week" on an assign is `bad_day`). `yesterday` is a day like any other.

`UnassignCommand` gains `until: DayWord | null` (null on every removal that is not an absence with
an until; a week kind never appears here).

Three new intents, none of which ever appears inside a `several`:

```ts
export interface ReplaceCommand { intent: "replace"; operator: string; with: string; place: string[];
  day: DayWord | null; span: { start: ClockTime; end: ClockTime } | null; shift: string | null; }
export interface SwapCommand { intent: "swap"; operator: string; other: string; place: string[];
  day: DayWord | null; span: { start: ClockTime; end: ClockTime } | null; shift: string | null; }
export interface CopyCommand { intent: "copy"; place: string[]; from: DayWord; to: DayWord; }
export type BoardCommand = ReplaceCommand | SwapCommand | CopyCommand;
export type Command = SingleCommand | SeveralCommand | BoardCommand;
```
`SingleCommand` stays the four. `place: []` on replace/swap means "wherever the person is".

Exported constants (spell them exactly; B, C, D and S56 import them):
```ts
export const EVERYONE = "everyone";          // the reserved operator word (R-407)
export const ALL_DAY = "all day";            // three reserved shift names (R-404)
export const END_OF_SHIFT = "end of shift";
export const END_OF_DAY = "end of day";
export const BOUNDARY_SHIFTS = [ALL_DAY, END_OF_SHIFT, END_OF_DAY] as const;
export const DAY_END: ClockTime = { hour: 23, minute: 59 };   // "after T" ends here; the resolver reads it as midnight
export const REPLACE_VERBS = ["cover", "replace"] as const;
export const SWAP_VERBS = ["swap", "exchange"] as const;
export const COPY_VERBS = ["copy", "repeat"] as const;        // plus the "same as" opener
export const ABSENCE_WORDS = ["off", "out", "away", "sick", "ill", "absent", "on leave", "on holiday", "on vacation"] as const;
export const TIME_OF_DAY_WORDS = ["morning", "afternoon", "evening", "night"] as const;
```
`UNASSIGN_VERBS` gains `"take"` (R-405). R-391's rule — every verb in exactly one list — holds:
"take Sam to Cell 2" is therefore read as a removal and fails on its place words; say so in a
comment, it is the price of the rule.

New `ParseFailure` members: `{ kind: "bad_duration"; text: string }` (not a length, or runs past
midnight), `{ kind: "open_span"; text: string }` ("after 2" on an assign or a booking: say both
ends), `{ kind: "copy_mismatch"; from: string; to: string }` (a day onto a week or the reverse),
`{ kind: "copy_same" }`.

## 2. The R-402 invariant, amended (R-404)

On assign and book: `shift === null` implies start and end non-null; `shift !== null` implies
end null, and start null too UNLESS `shift` is `END_OF_SHIFT` or `END_OF_DAY`, which name only the
other edge and may carry a start. `ALL_DAY` never carries a start. Update the comments on the
interfaces. `shift_and_hours` still fires for a shift name with both hours.

On unassign and move: `shift` non-null implies `span` null, as before. `ALL_DAY` on a removal or a
move is the same as saying nothing (shift null, span null) — read it and drop it, with a comment.
`END_OF_SHIFT`/`END_OF_DAY` on a removal or a move are shift names with no start (the resolver
starts them at now, or the day's start).

## 3. The sentences (each is a test; use the ids as case names)

Durations (R-404), tried BEFORE the headcount, product-last and shift clauses because the unit word
makes them unambiguous:
- DU1 `put Sam on Housing A on Cell 1 from 8 for 4 hours` → assign 08:00–12:00.
- DU2 `assign Sam to Housing A on Cell 1 at 8 for an hour` → 08:00–09:00.
- DU3 `… from 8 for 2 and a half hours` → 08:00–10:30; DU4 `… from 8 for 1.5 hours` → same; DU5 `… from 8 for 90 minutes` → 09:30; DU6 `… from 8 for half an hour` → 08:30; `hrs`, `hr`, `mins`, `min` accepted.
- DU7 `… from 10 pm for 4 hours` → `bad_duration` (past midnight; never clipped). DU8 `… from 8 for 0 hours` → `bad_duration`.
- DU9 `book Housing A on Cell 1 from 8 for 4 hours for 3 people` → book 08:00–12:00, headcount 3 (two "for" clauses; the unit word tells them apart).
- DU10 `assign Sam to Housing A on Cell 1 8 to 4 for 2 hours` → `bad_time`-class failure of your choice, never a pick; say which in the comment.

Boundaries (R-404):
- BD1 `assign Sam to Housing A on Cell 1 all day tomorrow` → shift `ALL_DAY`, start/end null, day tomorrow.
- BD2 `assign Sam to Housing A on Cell 1 from 10 until end of shift` → start 10:00, end null, shift `END_OF_SHIFT`. Also `till end of shift`, `to the end of the shift`, `until the end of shift`, `for the rest of the shift`.
- BD3 `put Sam on Housing A on Cell 1 for the rest of the day` → start null, shift `END_OF_DAY`; BD4 `… from 10 for the rest of the day` → start 10:00; `until end of day`, `till the end of the day` the same.
- BD5 `remove Sam from Cell 1 for the rest of the day` → unassign shift `END_OF_DAY`, span null; BD6 `remove Sam from Cell 1 all day` → shift null, span null.
- BD7 `assign Sam to Housing A on Cell 1 all day from 8 to 4` → `shift_and_hours`.
- BD8 `formatCommand` prints BD1 as `… all day tomorrow`, BD2 as `… from 10:00 until end of shift`, BD3 as `… for the rest of the day`, and each parses back equal (round trip).

Word orders (R-405). A sentence whose first word matches no verb list is tried against these before
the old "no verb" assign path:
- WO1 `Sam works on Housing A on Cell 1 8 to 4` → assign. WO2 `Sam is on Housing A on Cell 1 from 8 to 4` → assign.
- WO3 `Cell 1 gets Sam on Housing A 8 to 4` → assign, place ["Cell 1"]. WO4 `Cell 1 in Line 1 gets Sam on Housing A 8 to 4` → place ["Cell 1", "Line 1"].
- WO5 `Cell 1 runs Housing A 8 to 4` → book, headcount null. WO6 `Cell 1 runs Housing A 8 to 4 with 3 people` → headcount 3 (`with N people` joins `for N people` as a headcount clause, for every book form).
- WO7 quoted names still atomic: `"Sam is on" works on Housing A on Cell 1 8 to 4` → operator `Sam is on`.

Removals (R-405):
- RM1 `take Sam off Cell 1` → unassign, place ["Cell 1"], span null. RM2 `take Sam off Cell 1 today from 2 to 4`. RM3 `pull Sam from Cell 1`. RM4 `pull Sam off Cell 1 in Line 1`.
- RM5 `remove Sam from Cell 1 after 2 pm` → span 14:00–`DAY_END`. RM6 `remove Sam from Cell 1 before 2` → 00:00–14:00 (the afternoon rule does not apply to a lone edge: "before 2" is 02:00? NO — decide: a lone edge under 7 with no am/pm reads as pm, the same "workday" rule the pair uses; write the rule and pin it). RM7 `unassign Sam from Cell 1 until 2` → 00:00–14:00. RM8 `assign Sam to Housing A on Cell 1 after 2` → `open_span`.
- RM9 `formatCommand` prints RM5 as `… after 14:00` and RM6 as `… before 14:00`, both round-trip.

Time-of-day words (R-405, D130 item 7) — a shift NAME, never a clock:
- TD1 `assign Sam to Housing A on Cell 1 this afternoon` → shift "afternoon", day today. TD2 `… tonight` → "night", today. TD3 `… tomorrow morning` → "morning", tomorrow. TD4 `put Sam on Housing A on Cell 1 for the night` → "night", day null. TD5 `pull Sam off Cell 1 this afternoon` → unassign shift "afternoon", day today. TD6 `… this afternoon from 2 to 4` → `shift_and_hours`. TD7 `… this afternoon tomorrow` → `two_days`.

Everyone (R-407):
- EV1 `clear Cell 1 today` → unassign, operator `EVERYONE`, place ["Cell 1"], day today, span null, until null. EV2 `clear Cell 1 in Line 1 after 2 pm` → place ["Cell 1","Line 1"], span 14:00–DAY_END. EV3 `clear Sam from Cell 1` → operator "Sam" (a from/off keeps the person reading).
- EV4 `unassign everyone from Cell 3 after 2 pm`; EV5 `remove everybody from Line 1 tomorrow`; EV6 `remove all from Cell 1` — all three operator `EVERYONE` (canonical spelling, whatever was said).
- EV7 `move everyone on Line 1 to Cell 2` → move, operator `EVERYONE`, place ["Line 1"], toPlace ["Cell 2"]. EV8 `move everyone from Cell 1 to Cell 2 today`. EV9 `clear everyone` → unassign, `EVERYONE`, place [] (allowed; the resolver reads it as every cell shown).
- EV10 `assign everyone to Housing A on Cell 1 8 to 4` → operator "everyone" as a PERSON'S words, unchanged (the resolver will say no such person); the reserved reading is a removal's or a move's only. Pin it.

Cover, replace, swap (R-406):
- RP1 `cover Sam with Ana on Cell 1 today` → replace {Sam, Ana, ["Cell 1"], today, span null, shift null}. RP2 `replace Sam with Ana` → place []. RP3 `cover Sam with Ana from 2 to 4` → span. RP4 `replace Sam with Ana for shift 2 on Cell 1` → shift "2". RP5 `cover Sam with Ana from 2 to 4 for shift 2` → `shift_and_hours`. RP6 `cover Sam` → a failure of your choice naming what is missing (never a guess).
- SW1 `swap Sam and Ana` → swap {Sam, Ana, [], null, null, null}. SW2 `swap Sam with Ana on Cell 1 tomorrow`. SW3 `exchange Sam and Ana`. SW4 `swap Sam` → failure.
- RP7/SW5 `formatCommand` prints `cover Sam with Ana on Cell 1 today` and `swap Sam and Ana on Cell 1 tomorrow`; round trip.

Copy (R-408):
- CP1 `same as yesterday for Cell 1` → copy {["Cell 1"], yesterday, today}. CP2 `same as yesterday` → place []. CP3 `copy Monday to Tuesday` → weekday 1 → weekday 2, place []. CP4 `copy Monday to Tuesday for Cell 1 in Line 1` → ["Cell 1","Line 1"]. CP5 `repeat this week next week` → this_week → next_week. CP6 `copy this week to next week`. CP7 `same as last week for Line 1` → last_week → this_week. CP8 `copy Monday to next week` → `copy_mismatch`. CP9 `copy Monday to Monday` → `copy_same`. CP10 `copy 2026-09-07 to 2026-09-14 on Cell 1` → dates.
- CP11 `formatCommand` prints CP1 as `copy yesterday to today for Cell 1`, CP5 as `copy this week to next week`; round trip.

Absence (R-409), matched BEFORE any place parsing (the words "on leave" contain the place
preposition):
- AB1 `Sam is off today` → unassign {Sam, [], today, span null, shift null, until null}. AB2 `Sam is out` → day {kind: today} (explicit: an absence with no day means today). AB3 `Sam is sick tomorrow`. AB4 `Ana is on leave till Friday` → day today, until weekday 5. AB5 `Ana is away until Friday`. AB6 `Ana is off from Monday until Wednesday` → day Monday, until Wednesday. AB7 `Sam is on holiday`. AB8 `Ana is off until 2026-09-18` → until date.
- AB9 `formatCommand` prints AB4 as `remove Ana today until Friday` and reads it back (so `until <day>` is a clause the unassign grammar accepts on its own, after the day word).
- AB10 `Sam is on Housing A on Cell 1 8 to 4` stays WO2's assign (the absence pattern needs one of `ABSENCE_WORDS` right after "is").

## 4. What must not change

Every existing case in `commandParse.test.ts` passes unchanged unless a contract above changes it;
for each such case write the reason beside the re-pin. Lists (" and ") are not read inside the new
intents: `cover Sam and Bob with Ana` leaves `operator: "Sam and Bob"` for the resolver to refuse.
`formatCommand` for a `several` is unchanged.

## 5. Report

Your report names: every exported name added; every existing case re-pinned and why; the decision
you took at DU10, RM6 and RP6; the sentence(s) you could not make read and why; the test count
before and after for the file. No `npm run test`; no commits.
