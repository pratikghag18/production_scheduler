# Review brief: S195-C review, break the capacity migration (DEF-0053, R-465)

You are a reviewer, not the author. Lane S195-C wrote
`supabase/migrations/20260930000085_capacity_counts_every_block.sql` and
`supabase/tests/99_capacity_counts_every_block_test.sql`, and edited
`supabase/tests/60_api_test.sql`. Nothing is committed. **You have one job: break it.** A review
that finds nothing must say what it tried. Read `CLAUDE.md` section 4 first (every paragraph there
cost a defect, and half of them are about exactly this kind of migration), then
`docs/defects/DEF-0053.md`, R-465 and R-033 in `docs/plan.yaml`, the lane's brief
`docs/agent-briefs/s195-c-capacity-counts-every-block-brief.md`, then the three files.

## What the migration claims

1. `operator_peak_load` is SECURITY DEFINER, sums every block of a person in the caller's company
   (`auth.uid() IS NULL OR a.org_id = app_current_org()`), and is REVOKED from `authenticated`,
   `anon` and PUBLIC: only its two definer callers reach it.
2. `check_operator_capacity` (the `assignments_capacity` trigger) is SECURITY DEFINER with a
   pinned search_path, otherwise byte for byte 0043's.
3. `capacity_probe` is SECURITY DEFINER; refuses a person the caller could not read
   (`app_can_read_operator`); a block on a place the caller cannot read comes back with
   `outside: true`, the node's name, its parent's name, the hours and the efficiency, and JSON null
   for `assignment_id`, `node_id`, `product_name`.
4. `operator_blocks_elsewhere(p_from, p_to)` returns the blocks of people the caller can read on
   places the caller cannot read; nothing for a whole-plant reader, another company, a session
   with no profile, or the owner.
5. "Extracted, never retyped": the three re-emitted bodies are the LAST definitions' bodies with
   only the stated edits.

## Where to push (each is a way this kind of change has gone wrong here before)

- **Extraction.** For each of `operator_peak_load`, `check_operator_capacity`, `capacity_probe`:
  find the LAST definition before 0085 yourself
  (`grep -in "function \(public\.\)\?<name>(" supabase/migrations/*.sql`, the `-i` and the optional
  `public.` matter: DEF-0011) and diff its body against 0085's, line by line. Every difference
  must be one the header states. Also `pg_get_functiondef` from a scratch database built WITHOUT
  0085 (move the file aside in a copy of the migrations directory, or read the tester container's
  main database, which does not have 0085 yet: read-only) and compare with the file-derived text.
- **The trigger as a definer.** What else does `check_operator_capacity` touch that now runs as the
  owner? Could a caller use the trigger to learn or change anything she could not before? Does
  the trigger still fire for the same events (INSERT, UPDATE OF which columns)? An UPDATE of
  `node_id` alone, or of `run_id`, does not re-check: was that so before, and is it still right?
  A block moved by `move_assignment` (0080), by `move_run`, by `apply_split_coverage`, by a week
  copy, by a template apply: does each of those writes reach the trigger and get the full sum?
  Write a case per writer you can reach: a supervisor using THAT writer to put a person over the
  cap against a block on a line she cannot read.
- **The search path and `auth.uid()`.** A definer with `SET search_path = public, pg_temp`: is
  `auth.uid()` schema-qualified everywhere, and `app_current_org()`? A session with a JWT but no
  profile row (DEF-0019's caller): what does each function answer? A service-role call (no
  `auth.uid()`)? The seed (`supabase/dev_demo.sql`, applied by `--demo`)?
- **The probe's refusal.** `app_can_read_operator` is claimed to be `operators_select`'s own
  predicate. Find the policy's LAST definition and the function's LAST definition and confirm they
  are the same test. Then find every caller of `capacity_probe` in the last definitions (the
  copy-week and template planners in 0055, 0066, 0067, anything later) and every client call
  (`grep -rn "capacity_probe" src/`): can any of them now raise PT403 where it used to answer? A
  supervisor applying a template or copying a week that contains a person homed in another plant,
  a deactivated person, a deleted person (`operator_id` NULL): try each.
- **What leaks.** The outside row: is there any path by which a product name, a run, an assignment
  id or a node id of a place she cannot read reaches a supervisor (the `overlapping` list, an
  error's `detail` jsonb from the trigger's `api_raise`, `operator_blocks_elsewhere`)? The
  trigger's refusal carries `timerange` in its detail: whose? Is the parent's name ever the name
  of something above the plant that she should not see? A node with no parent?
- **`operator_blocks_elsewhere`.** `NOT IN (SELECT app_readable_node_ids())`: what if the set is
  empty (a viewer with no grant, a person with a grant on a deleted node)? What does a company
  admin get, a plant admin of another plant in the same company, a supervisor with two grants?
  People with `operator_id` NULL rows? A window where `p_from >= p_to`, a NULL argument, an
  unbounded range? Is it held to the writer in BOTH directions (every row it returns is refused at
  full efficiency; every overlap the trigger would refuse because of an unreadable block is in the
  set)? The lane says its company filter is redundant and is held only by a source-text check:
  find a caller for whom it is NOT redundant, or say why none exists.
- **The tests themselves.** The lane found that fixture rows written as the owner left a "warm
  plan" that made a blind helper look sighted, and worked around it by disabling the trigger
  while writing fixtures. Is that explanation right? Re-run its first mutation (SECURITY DEFINER
  off `operator_peak_load`, revoke kept, trigger definer kept) and understand what it actually
  proves now. Is any case green for the wrong reason (CLAUDE.md: "a green case can be pinning the
  bug")? CB5's helper half now runs "on the owner connection carrying a jwt sub": does that still
  test what it says? `60_api_test.sql`'s hand-typed second copy of `operator_peak_load`: diff it
  against the migration's body; a copy that has drifted is a bug with a delay on it.
- **20_capacity_test.sql** still runs as one role that reads everything. Say whether any of its
  cases now means something different.

## How to work

The tester's stack is UP (container `supabase_db_production_scheduler_tester`). Its MAIN database
does not have 0085 and another lane's browser tests are running against it: read-only `psql` there
is fine, writes are not, and do not apply the migration to it. Everything you run goes through
scratch databases:

```
$env:SUPABASE_DB_CONTAINER = "supabase_db_production_scheduler_tester"
bash scripts/run-sql-test.sh --rebuild
bash scripts/run-sql-test.sh 99_capacity_counts_every_block_test.sql
```

(read the head of `scripts/run-sql-test.sh`). Write your adversarial cases in a NEW file,
`supabase/tests/99_capacity_review_test.sql`, in the harness's style (read
`99_capacity_counts_every_block_test.sql` for how a case signs in as a person and how PASS / FAIL
is raised), one named case per attack, so every attack that holds becomes a standing test and
every one that breaks is a red line you can paste. Mutations of the migration are copy-backed
(copy the file first, restore from the copy, diff to confirm) with `--rebuild` each time.

You may FIX what you break, in the migration and the two test files, when the fix is small and
you are sure of it; say exactly what you changed and re-run the whole suite (every numbered file
and `--demo`, tally lines copied; the lane's last total was 902 in 64 files plus the demo's 17).
Anything larger, or anything that is a product decision, you report and do not build.

Do not touch anything under `src/` or `e2e/`, any earlier migration, `supabase/dev_demo.sql`,
`seed.sql`, `config.toml`, `docs/defects/**`, `docs/plan.yaml`, `CLAUDE.md`. Do not commit. Do not
start, stop or reset any container; never `npm run db:reset`. PowerShell runs npm/npx (no `&&`);
bash runs the SQL runner. Never `git checkout -- <file>`; never patch with
`Get-Content`/`Set-Content`.

## Report

Plain prose, findings first, most serious first: for each, what a person could do or see that
they should not (or what is refused that should not be), the exact case that shows it with its
FAIL or PASS line, and whether you fixed it. Then every attack that held, one line each, with the
case that now holds it. Then the suite's tally lines and sum. Then what you did not try. If you
changed the migration, an updated paragraph for the commit message in the repo's style (plain
ASCII, prose, no bullets).
