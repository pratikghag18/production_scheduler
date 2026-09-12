# F-131 / R-383 — the server refuses a run-attached block whose span is not inside its run

_Brief for one Sonnet build lane and one Sonnet review lane. Written 11 Sept 2026 (session 144)
by the developer session, from reading the tree at commit 536dc6b. The plan entry is
`docs/plan.yaml` F-131 (open) under R-383 (covered on the client, uncovered on the server)._

## §1. What this is, in the product's words

The command bar (S40) is the first screen that can ask the server to make a NEW block inside a
job (`create_assignment` with `p_run_id`, R-383). The server's run branch checks training,
absence and the person's area for that row, but nothing on the server checks that the block's
hours lie INSIDE the job it joins. The bar only offers "join" when containment holds, so today
reaching the gap needs the board to refetch a shortened job between the question and Create,
or a shift chip moving the span after the join question (the tester's route, session 141). A
narrow gap, but the rule belongs on the server: **a block that joins a job lies inside that
job's hours, or the server refuses with a named reason.** The client already decides "join" by
the same containment predicate (`assignmentFitsRun`); the server now holds the same test.

## §2. ⛔ THE RULES THAT MATTER HERE

- **Extract, never retype** (CLAUDE.md §4). `create_assignment` has THREE definitions
  (migrations 0009, 0030, 0066). The LAST is 0066's, lines 439–536 of
  `supabase/migrations/20260907000066_absences.sql`. You produce the new migration by SLICING
  that text out with a script, inserting one block, and asserting on the assembled text that
  every guard you expect is present before writing the file: `num_nonnulls(p_run_id,
  p_product_id) <> 1`, `an area override must say why`, `app_can_edit_node(p_node_id)`,
  `check_eligibility(p_node_id, p_operator_id, p_timerange)`, `absence_overlap(p_operator_id,
  p_timerange)`, `'absence', v_absence`, and your new `outside_run`. DEF-0011 was a re-emitted
  function that silently dropped a rule; this is why.
- **Migrations are append-only.** New file `supabase/migrations/20260911000079_a_join_stays_inside_its_run.sql`.
  Never edit 0066.
- **Where the check goes: the FUNCTION, not a trigger.** Considered and rejected: a
  containment trigger on `assignments`. A run can legitimately be shrunk with its crew left
  outside it (the run-resize path asks "N crew assignments fall outside the new run window.
  Continue?" and proceeds), so "inside its run" is NOT an invariant of the table today and a
  trigger would refuse states the product allows. (Whether `apply_copy_week` also re-creates
  such crew is worth one read of its last definition in 0067 before you write the header; say
  what you found, but it does not change the decision.)
  The rule is about the moment of JOINING, and the one server path that joins a new block is
  `create_assignment`'s run branch. Put it there.
- **Order of the guards.** After `app_can_edit_node` (someone with no edit rights learns
  nothing about runs) and BEFORE `check_eligibility`. Read the run once into a `runs%ROWTYPE`
  variable.
- **The dev database's migration ledger is out of sync and must not be repaired here.**
  `supabase migration up` and `db:reset` are both forbidden on this machine (the maintainer is
  using the app; the ledger stops at 0038). Apply the new migration to the running stack the
  way 0045, 0053 and 0069 were applied: pipe the file into `psql` inside the container
  `supabase_db_production_scheduler` (`docker exec -i -e PGPASSWORD=postgres
  supabase_db_production_scheduler psql -U postgres -d postgres -v ON_ERROR_STOP=1 < file`).
  A `CREATE OR REPLACE FUNCTION` is safe while the app is open. Say in your report that you
  did this and that the ledger still does not know it.
- **`tsc` is inconclusive until `npm run db:types` has run** after the migration. The
  signature does not change, so expect NO diff in `src/lib/database.types.ts`; run it anyway
  and report whether the file changed.

## §3. The migration — exact

Header comment in the repo's style (see 0070's header for the register): what F-131 is, why
the function and not a trigger (the three sentences from §2), and that the body is 0066's
byte-for-byte plus one block.

The inserted block, placed immediately after the `app_can_edit_node` refusal and before
`SELECT org_id INTO v_org_id`:

```sql
  -- F-131 / R-383 (session 144): a block that joins a run lies inside it. The
  -- client decides "join" by the same containment (assignmentFitsRun); the
  -- server holds the same test so a refetch race or a shift chip moved after
  -- the question cannot land a block outside the job it names.
  IF p_run_id IS NOT NULL THEN
    SELECT * INTO v_run FROM runs WHERE id = p_run_id;
    IF NOT FOUND THEN
      PERFORM api_raise('invalid_argument', 'no such run',
        jsonb_build_object('field', 'p_run_id', 'reason', 'no such run'));
    END IF;
    IF NOT (v_run.timerange @> p_timerange) THEN
      PERFORM api_raise('outside_run',
        'a block that joins a run must lie inside the run''s window',
        jsonb_build_object('run_id', p_run_id, 'node_id', p_node_id,
                            'run_timerange', v_run.timerange::text,
                            'timerange', p_timerange::text));
    END IF;
  END IF;
```

Add `v_run runs%ROWTYPE;` to the DECLARE block. Nothing else in the body changes. `api_raise`
already raises SQLSTATE `PT409` with `error` and the detail keys; check its definition in
0009 (`grep -n "FUNCTION api_raise" supabase/migrations/*.sql`, last hit) to confirm the
SQLSTATE and that the detail is merged into the envelope as the other codes' are.

Then a `comment on function create_assignment(...)` naming 0066 as the base and this block as
the one addition, in the style of 0066's own comment.

Write the migration with a node script under `C:\Users\prati\.claude\jobs\0586b6d2\tmp\`:
read 0066, slice from `CREATE OR REPLACE FUNCTION create_assignment(` to the end of its
`$function$;`, insert the DECLARE line and the block by exact-anchor string replacement (throw
if an anchor is missing or not unique), assert every §2 guard string is present exactly once
(except `api_raise`, which is present many times), then write the file with LF endings.
Keep the script; name it in your report.

## §4. The client — `src/lib/api/errors.ts` and `docs/api.md`

- `SchedulerErrorCode` gains `"outside_run"` with a comment naming migration 0079 / F-131.
- `SchedulerError` gains
  `{ kind: "OutsideRun"; runId: string; nodeId: string; runTimerange: string; timerange: string }`;
  add `"OutsideRun"` to the kinds list beside `"RunOverlap"`.
- The parser (`case "run_overlap"` is the model) gains `case "outside_run"` requiring the four
  string props; anything else returns `undefined` as the others do.
- `describeSchedulerError` gains `case "OutsideRun": return "That block would fall outside
  the job it is joining."` — one sentence, no ids (the toast's audience is a scheduler).
- Update the comment that counts the closed set ("fourteen now, not twelve" and any later
  count) to the new number, and `docs/api.md` §1's table gains a row for `outside_run` with
  its SQLSTATE and extra fields, and `create_assignment`'s **Raises** line names it.

Nothing else on the client. `CreatePopover`'s submit already routes any `SchedulerError`
through `toast.schedulerError`, so the new kind reaches the screen with no further wiring —
confirm by reading `submitCreateDirect`'s `onError` in `useDragGesture.ts` and say so.

## §5. Tests

### `supabase/tests/96_a_join_stays_inside_its_run_test.sql`

Same shape as `88_absences_test.sql`: header listing the cases, the seed's org 1 fixture (Ana
supervises Assembly; Cell 1 is `30..07`; Elena `50..04`; Widget X `60..01`; a1 the company
admin; a viewer b1 if 88 shows how to add one), every case as `authenticated` with a real jwt
sub, `SAVEPOINT`/`ROLLBACK TO` per case, `NOTICE: PASS`/`NOTICE: FAIL` tallies as the runner
scans for. Place the run in a clean future week (2027-12-06 onward, past 88's weeks).

- **J0** premises: `create_assignment`'s current definition contains `outside_run` (read
  `pg_get_functiondef`), and `api_raise` raises `PT409`.
- **J1** a join fully inside the run (run 08:00–16:00, block 10:00–14:00) succeeds; the row
  reads back with `run_id` set and the timerange asked for.
- **J2** a join starting before the run (07:00–12:00) is refused `outside_run`; the DETAIL
  carries `run_id`, `node_id`, `run_timerange`, `timerange`; no row was written (count = 0).
- **J3** a join ending after the run (12:00–17:00) is refused the same way.
- **J4** a join equal to the run's whole window (08:00–16:00) succeeds — `@>` is inclusive of
  equality; this is the boundary the client's `assignmentFitsRun` also accepts.
- **J5** a DIRECT block (`p_product_id`, no run) over any hours in that window is untouched
  by this rule — it succeeds or fails for the reasons it always did, never `outside_run`.
- **J6** order: a signed-in VIEWER joining with an outside span gets `not_permitted`, not
  `outside_run` (the permission check comes first).
- **J7** an unknown `p_run_id` is refused `invalid_argument` naming `p_run_id`.
- **J8** `move_run` of a staffed run still succeeds with the new definition installed (its
  crew UPDATE is not a join; this proves the check did not leak beyond `create_assignment`).

Run it with real bash (Git Bash on this machine; `sh` cannot run the script):
`bash scripts/run-sql-test.sh --rebuild` once (the scratch database must include 0079), then
`bash scripts/run-sql-test.sh 96_a_join_stays_inside_its_run_test.sql`, then re-run
`88_absences_test.sql` and `78_copy_week_test.sql` (the two suites that exercise
`create_assignment` and run-attached rows most) and report their tallies unchanged.

Deliberate breakages, on a scratch copy of the MIGRATION, rebuilding the scratch database
each time (`--rebuild`), restoring from the copy afterwards (never `git checkout --`):
- **X1** delete the `outside_run` block → J2, J3 red.
- **X2** `@>` becomes `&&` (overlap instead of containment) → J2, J3 red, J1/J4 green.
- **X3** move the block ABOVE `app_can_edit_node` → J6 red.
Record which cases went red for each.

### `src/test/errors.test.ts`

- **E1** "parses outside_run with every field" beside the run_overlap case.
- **E2** `describeSchedulerError` on an `OutsideRun` returns the exact sentence in §4.

## §6. Files — exclusive to the build lane

| file | change |
| --- | --- |
| `supabase/migrations/20260911000079_a_join_stays_inside_its_run.sql` | new, produced by the script |
| `supabase/tests/96_a_join_stays_inside_its_run_test.sql` | new |
| `src/lib/api/errors.ts` | the code, the kind, the parser case, the sentence, the count comment |
| `src/lib/database.types.ts` | only if `npm run db:types` changes it (expected: no change) |
| `docs/api.md` | the table row and the Raises line |
| `src/test/errors.test.ts` | E1, E2 |

Nothing else. No change to `useDragGesture.ts`, `CreatePopover.tsx`, `resolve.ts` or the bar.

## §7. Acceptance — in order

1. The migration applied to the scratch database by `--rebuild` with no error, and the SQL
   file's own tally (copy the runner's PASS/FAIL line).
2. 88 and 78 re-run, tallies copied.
3. The migration applied to the RUNNING dev stack by `psql` (§2), output copied; then `npm
   run db:types` and whether `database.types.ts` changed.
4. `npx vitest run src/test/errors.test.ts` — count copied.
5. `npx tsc -b --force` clean (say "clean" only because step 3 ran).
6. `npx eslint src/lib/api/errors.ts src/test/errors.test.ts` clean; `npx prettier --check
   --end-of-line auto` on the two TypeScript files clean.
7. The X1–X3 table.
8. Do NOT run the full `npm run test`. Do NOT commit.

## §8. Your report

Plain prose: what you built, file by file; the script's path and the guard assertions it made;
the counts from every runner, copied; the breakage table; anything in this brief that was wrong
when you read the tree; anything not done and why.

## §9. The review lane (a second Sonnet, after the build lane reports)

One job: break it. Nothing is committed; read `git status` and `git diff`.
1. Diff the new migration's function body against 0066's lines 439–536 yourself (extract
   both to files, `diff`): the ONLY differences must be the DECLARE line, the inserted block,
   the header comment and the function comment. Name anything else.
2. Read `api_raise`'s last definition and confirm the new call's shape matches the others.
3. Rebuild the scratch database and run `96_…`, `88_…`, `78_…` and `57_area_override_test.sql`
   (the area guard shares the run branch); copy the tallies.
4. Apply X2 yourself on a scratch copy and confirm J2/J3 go red; restore from your copy.
5. Confirm the running dev stack has the new definition: `docker exec -i -e PGPASSWORD=postgres
   supabase_db_production_scheduler psql -U postgres -d postgres -c "select
   pg_get_functiondef('create_assignment(uuid,uuid,uuid,uuid,tstzrange,numeric,numeric,text,boolean,text,boolean,text)'::regprocedure)"
   | grep -c outside_run` reads 1 or more. Read-only; write nothing to that database.
6. Report: what you tried, what broke with exact text, the tallies, and one sentence on
   whether this can be called done.
