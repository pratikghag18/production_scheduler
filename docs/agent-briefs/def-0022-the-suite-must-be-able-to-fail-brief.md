# Lane brief: DEF-0022 — the part-day boundary has no SQL case that can fail on it

You are a build lane closing one filed defect. **The code is correct and you are not changing it.**
DEF-0022 is a `test-cannot-fail` defect: the SQL suite is green for a behaviour it cannot actually
detect, so the day someone breaks the boundary, nothing goes red. Your job is to add the cases that
would go red, and then to PROVE they go red by breaking the code on purpose and putting it back.

You own exactly these files and no others:

- `supabase/tests/88_absences_test.sql` (add cases only — never reword or renumber an existing one)
- `src/test/absence.test.ts` (only if you find a gap on the client side; see part D)

Do not touch `supabase/migrations/20260907000069_absence_by_the_hour.sql` except temporarily, as a
mutation you revert (part C). Do not touch `src/test/defects/DEF-0022.test.ts` — that pin belongs to
the tester and only the tester marks a defect verified. Do not commit. Do not edit `docs/plan.yaml`
or `docs/defects/*.md`. The local dev database was just reset and is clean; you may rebuild the SQL
scratch database freely, and you are the only lane running.

**Read first, in full:** `docs/defects/DEF-0022.md` (the whole thing, including its Lead), then
`CLAUDE.md` §4 — in particular *"a green case can be pinning the bug"* and the rule about a column
list that appears twice, because this defect is that family. Then `docs/plan.yaml`'s **R-359** row
(grep `^- id: R-359`), then `supabase/tests/88_absences_test.sql`'s AB8, AB15, AB16 and AB17, and
`src/test/absence.test.ts`'s boundary cases.

## The rule the cases must pin

A part-day absence is stored `tstzrange(starts_at, ends_at, '[)')` — half-open — and
`absence_overlap` compares it with the placement window using Postgres's `&&`. **Touching is not
overlapping.** A shift starting at exactly the instant an absence ends does NOT clash; a shift
ending at exactly the instant an absence starts does NOT clash. The same half-open rule governs the
`absences_part_day_excl` exclusion constraint: two part-day absences that merely touch are both
legal.

## What is missing, measured

Two holes, and the second was found while verifying the first — the defect names only the first.

1. **AB15's "miss" case is a shift at 14:00-16:00** against an absence ending at 13:00 — a full hour
   clear. It proves the hours branch exists at all, which is worth keeping, but it is nowhere near
   the boundary. Closing the range's upper bound (`'[)'` to `'[]'`) leaves every case in the file
   green, which the tester demonstrated.
2. **AB16's two "non-overlapping" part-day absences are 08:00-09:00 and 17:00-18:00** — eight hours
   apart. So the exclusion constraint's own touching boundary is untested by the same mistake: two
   absences at 08:00-09:00 and 09:00-10:00 must BOTH be accepted, and no case says so.

## What to add — three new cases, next free ids

The file's highest id is AB22, so yours are **AB23, AB24, AB25**. Write each in the file's exact
existing style: an `\echo` line, a `SAVEPOINT sp_ABnn`, a `DO $$ ... $$` block ending in
`RAISE NOTICE 'PASS ABnn'` / `'FAIL ABnn: <why>'` with the `EXCEPTION WHEN OTHERS` arm, and a
`ROLLBACK TO SAVEPOINT`. Add their one-line summaries to the header comment block at the top of the
file, where AB15-AB22 already have theirs. Copy AB15's shape; do not invent a new one.

- **AB23** — a shift starting at exactly the instant a part-day absence ENDS does not clash.
  Absence 09:00-13:00, window `tstzrange(13:00, 15:00)`, expect `absent: false`.
- **AB24** — a shift ending at exactly the instant a part-day absence STARTS does not clash.
  Absence 09:00-13:00, window `tstzrange(07:00, 09:00)`, expect `absent: false`.
- **AB25** — the same person may hold two part-day absences that TOUCH: 08:00-09:00 and 09:00-10:00
  on one day, both written, neither refused by `absences_part_day_excl`.

**Name AB23 and AB24 to mirror `src/test/absence.test.ts`'s two boundary cases** — read those `it`
titles and echo their wording, so the two sides of the same rule can be found by the same words.
That mirroring is the thing R-359 already claims and does not yet have.

## Proving it — this is the actual deliverable

A case that cannot fail is exactly the defect you are closing, so a green run proves nothing on its
own. For **each** of the three mutations below: apply it, `bash scripts/run-sql-test.sh --rebuild`,
run `bash scripts/run-sql-test.sh 88_absences_test.sql`, record which case names went red **and
which stayed green**, then revert the mutation and confirm the file is byte-identical to HEAD
(`git diff --exit-code` on the migration) before moving to the next.

1. `'[)'` to `'[]'` on the part-day range in 0069 — the tester's own mutation. **AB23 must go red.**
   Report whether AB24 and AB25 also moved; say so either way.
2. `'[)'` to `'(]'` on the same range. **AB24 must go red.**
3. In the `absences_part_day_excl` exclusion constraint, widen the touching rule so touching counts
   as overlapping — if there is no single-token way to do that, mutate `absence_overlap`'s part-day
   term from `&&` to something that treats touching as overlapping, and say exactly what you changed
   instead. **AB25 must go red.**

If a mutation turns a case red that you did NOT expect, read that case before concluding anything
and say in writing whether the case was wrong or your understanding was.

Then the clean run: `bash scripts/run-sql-test.sh --rebuild` and every file in order,
`for f in supabase/tests/[0-9]*_test.sql; do bash scripts/run-sql-test.sh $(basename $f) || echo "RED: $f"; done`.
The measured baseline on this tree is **760 passed, 0 failed** across the 51 numbered suites; yours
must be 763 with zero failed.

Also run, and copy their own summary lines:

- `npx vitest run src/test/defects/DEF-0022.test.ts` — the tester's pin, which calls the LIVE server
  over PostgREST. It should already pass; it is not yours to change, and if it fails, stop and
  report rather than touching it.
- `npx vitest run src/test/absence.test.ts` — must stay green.

## Part D — the client side, only if there is a gap

`src/test/absence.test.ts` already has both boundary cases for `absenceGaps`. Read them and confirm
they genuinely sit on the boundary rather than near it, the same way you just judged AB15. If they
do, change nothing and say so. If one of them is also a coarse counter-example, add the real
boundary case beside it and prove it fails by mutating `absenceGaps`' comparison operator and
putting it back.

## Report

Plain prose, no bullet lists. Lead with the mutation table in sentences: for each of the three
mutations, what you changed, which case names went red, and which stayed green. Then the full SQL
suite total copied from the runner, the two vitest summary lines, what you concluded about the
client side, and anything you noticed and did not fix. Confirm explicitly that 0069 is back to its
committed content.
