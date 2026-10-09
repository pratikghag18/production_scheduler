# F-133 — the day word may come after the hours, in every typed sentence

_Brief for one Sonnet build lane. Written 11 Sept 2026 (session 148) by the developer session.
Starts after S42's lane has finished, because S42 reads `parse.ts` as its oracle while it runs.
Plan entry: `docs/plan.yaml` F-133 (open) under R-382 and R-378._

## §1. What this is, in the product's words

The maintainer typed *"put operator 1 to work on product A on Cell 1 in Line 1 from 10 to 2 on
Saturday"* and the bar refused it with *I could not read "2 on Saturday"*. The same sentence with
the day before the hours — *"… on Saturday from 10 to 2"* — works. People say the day at either
end. After this piece both orders read, for all four sentences (assign, book, unassign, move),
and the shape sentence the bar shows on a refusal says so.

## §2. The rules

- One file of logic: `src/lib/command/parse.ts`, in the SHARED time-and-day helper
  (`parseTimeAndDay` / `extractDayWord` / `extractOptionalTimeClause` / `extractToTimeClause` —
  read the current file; three lanes have reshaped it today). EDIT in place; never rewrite the
  file; confirm `QUOTE_OPEN`/`QUOTE_CLOSE` match `git show HEAD:src/lib/command/parse.ts`
  (U+E000, U+E001) after your edit.
- The resolver, the bar and the board do not change. `commandPurity.test.ts` stays green.
- Never guess: a day word in BOTH places that disagree is a parse failure, not a pick.

## §3. The change

Read the day off the END of the line first: if the normalized line ends with a day word
(`DAY_TAIL_RE`'s alternatives, with or without a leading `on`) AND what precedes it still ends
with a time clause, strip the trailing day and remember it. Then the time clause as today, then
the day word before it as today. If both a trailing and a leading day were found and they are
not the same day, return a new `ParseFailure` `{ kind: "two_days"; first: string; second:
string }`, rendered by the bar as `I read two days, "<first>" and "<second>". Say one.` (the
`failureToStatus` branch in `CommandBar.tsx` — that is the one line outside `parse.ts` this piece
touches, plus its C-case). "on funday" at the end is NOT a day (P18's rule holds at both ends): if
the trailing token is not a real day word the line is unchanged and the time clause must still
end the line. A trailing ISO-looking date that is not a real date is `bad_day`, as before.

`formatCommand` keeps printing the day BEFORE the hours (canonical form is unchanged; round
trips of a trailing-day sentence re-print it leading — assert exactly that).

`expectedShape()` gains `[on <day>]` after the time clause in each of its four clauses, e.g.
`assign <person> to <part> on <cell> [in <line>] [on <day>] from <time> to <time> [on <day>]`.
This changes a string R-382 tests verbatim in several files: update every assertion and say in
writing that the contract changed.

## §3b. F-134, in the same helper — the afternoon rule reads the start

S42's review lane found a held-out row a person would not read the way the parser does:
*"Book Motor Mount on Assembly Bench 1 in Electrical Line from 17:15 till 10:30"* parses as
17:15–22:30, because the afternoon rule adds twelve hours to any end without am/pm that is not
after the start, and never looks at the start. Change the rule: when the START's hour is 13 or
more, or the start carries a meridiem, the afternoon rule does not apply to the end; an end
that is then not after the start is `time_order`. "from 10 to 2" (10:00–14:00), "from 8 to 4",
"from 10 to 10" (P9: 10:00–22:00) and "from 12am to 4" (P11) keep their meaning; "from 17:15
till 10:30" and "from 1pm to 10" become `time_order`. The generator's independent afternoon
rule in `scripts/voice/lib/time.mjs` must change the same way, or S42's V2 goes red on the
templates that draw such pairs — change it, and re-run `npm run voice:score`: the committed
held-out set must still score 1.0 on clean rows (if a committed clean row now fails to parse,
that row was recorded under the old rule; say so, and regenerate the held-out set ONCE with
the same seed 20260911 as the one documented exception to "never regenerated", recording the
old and new row counts per intent). Cases: **P32** `… from 17:15 till 10:30` → `time_order`;
**P33** `… from 1pm to 10` → `time_order`; **P34** `… from 13:00 to 22:00` → 13:00–22:00;
**P35** P9 and P11 unchanged (assert them again by name). Mutation **M64**: the start check
uses `>= 12` instead of `>= 13` → P9's twin `from 12 to 3` (12:00–15:00) must still parse; add
it as **P36** and let M64 be caught by it.

## §4. Tests — `src/test/commandParse.test.ts`

- **P25** the maintainer's sentence verbatim → ok, day `{weekday: 6}`, 10:00–14:00, everything
  else as P1's shape (operator `operator 1`, product `product A`, places `["Cell 1","Line 1"]`).
- **P26** `… from 10 to 2 on 2026-09-12` → day `{date: "2026-09-12"}`; `… from 10 to 2 tomorrow`
  → tomorrow; `… from 10 to 2 today` → today; `… from 10 to 2 sat` → weekday 6.
- **P27** `… on Saturday from 10 to 2 on Saturday` → ok, weekday 6 (the same day twice is not a
  conflict); `… on Monday from 10 to 2 on Saturday` → `two_days` with `first "Monday"`, `second
  "Saturday"`.
- **P28** `… from 10 to 2 on funday` → `bad_time` `2 on funday` (a non-day trailing word is
  still swallowed into the time, exactly as today — the shape needs a real day word there).
- **P29** `… from 10 to 2 on 2026-13-40` → `bad_day` `2026-13-40`.
- **P30** round trip: P25's sentence formats to `assign operator 1 to "product A" on "Cell 1"
  in "Line 1" on sat from 10:00 to 14:00` — check `quoteIfNeeded`'s actual output for these
  names and assert what it really produces, then that parsing it again yields P25's command.
- **B12, U10, MV12** one trailing-day case per other intent; **B13** `book Housing A on Cell 1
  for 3 from 6 to 2 tomorrow` (headcount before the hours, day after).
- **P31** `expectedShape()` verbatim, all four clauses.
- The existing P1–P24, B1–B11, U1–U9, MV1–MV11 unchanged in meaning.

`src/test/commandBar.test.tsx`: **C15** the `two_days` failure renders the sentence above and
calls nothing; the shape-sentence assertions updated.

## §5. Mutations

| id | mutation | must be caught by |
| --- | --- | --- |
| M60 | the trailing day is read but the time clause is not re-anchored (the day stays in the end time) | P25 |
| M61 | two disagreeing days: the trailing one wins silently | P27 |
| M62 | a trailing non-day word is stripped as if it were a day | P28 |
| M63 | `formatCommand` prints the day after the hours | P30 (the round trip still parses, so assert the exact string) |

## §6. Acceptance

`npx vitest run src/test/commandParse.test.ts src/test/commandBar.test.tsx src/test/commandResolve.test.ts src/test/commandPurity.test.ts src/test/voiceData.test.ts` (the last one proves S42's held-out set still parses — it must, since this only widens) — counts copied; `npx tsc -b --force` clean; eslint and prettier clean on the touched files; the §5 table filled in; no full `npm run test`; no commit. Report as the other briefs' §8.
