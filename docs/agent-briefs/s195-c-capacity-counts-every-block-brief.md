# Lane brief: S195-C, a person busy where the caller cannot see is still busy (DEF-0053, R-465) -- the server's half

You are a build lane on the developer's tree (branch `Development`). Your work is SQL only: one
migration and its tests. The client half (the API wrapper, the rail, the bar's sentence) is a
later lane and is not yours. Read `CLAUDE.md` first, all of section 4 ("Extract, never retype" and
"Anything resolved by walking UP the tree is resolved by the server as a definer" are the two
rules this lane exists because of), then `docs/defects/DEF-0053.md` from top to bottom, then
R-465 and R-033 in `docs/plan.yaml` (grep `^- id: R-465` and `^- id: R-033`).

## The defect in one paragraph

A line supervisor (Ana, Line 1) books Priya from 10 am to noon while Priya is on Cell 4 (Line 2)
from 6 am to 2 pm. The server writes it; Priya is at 200% against a cap of 100%. The capacity sum
is computed from the caller's view: `operator_peak_load` is `LANGUAGE sql STABLE` with no
`SECURITY DEFINER`, its callers `check_operator_capacity` (the `assignments_capacity` trigger) and
`capacity_probe` are invokers too, and `assignments_select` lets a supervisor read only rows on
nodes in `app_readable_node_ids()`. So her sum leaves out every block on a place outside her grant.
`supabase/tests/20_capacity_test.sql` runs as one role that reads everything and cannot see it.

## The decision (the maintainer, 30 Sept) -- not open

R-465: the server counts every block wherever it is. When the block that makes a person busy is
on a place the caller cannot read, the caller is told **the place and the hours, never the product
or the job**: "Priya Shah is already on Cell 4 in Line 2 today from 6 am to 2 pm."

## What to build: migration `supabase/migrations/20260930000085_capacity_counts_every_block.sql`

Migrations are append-only; do not edit an earlier one. **Extract, never retype**: for each
function below, find its LAST definition with
`grep -in "function \(public\.\)\?<name>(" supabase/migrations/*.sql` (take the last hit; today
that is `20260904000043_assignment_delete_is_delete.sql` for all three, but check), slice the body
out of the file with a script, and assert the guards you expect are in the assembled text before
you write the new one. Say in the migration's header which file each body was extracted from.

1. **`operator_peak_load(uuid, tstzrange, numeric, uuid)` becomes `SECURITY DEFINER`** with the
   same signature, the same `SET search_path`, and the same peak arithmetic, byte for byte apart
   from the guard. It must guard the company boundary itself, because any signed-in person may
   call it (it is granted to `authenticated`): a caller with a company (`app_current_org()` is not
   null) gets a sum over that company's rows for an operator of that company, and for an operator
   of another company learns nothing (no sum of theirs; decide between returning the bare
   `p_efficiency` and raising, by reading how `DEF-0013`'s fix and `absence_overlap` /
   `check_eligibility` guard theirs, and do what they do). A caller with NO company context (the
   database owner running the seed, the service role, the SQL suite's setup role) must keep
   working exactly as today: the seed inserts assignments and the trigger fires. Read how existing
   definers tell those callers apart and copy that, do not invent a test on `current_user`.
2. **`check_operator_capacity()`**: read it; if it needs no change once its helper is a definer,
   leave it alone and say so. The trigger must refuse Ana's write.
3. **`capacity_probe(uuid, tstzrange, numeric, uuid)` becomes `SECURITY DEFINER`**, same
   signature, and answers the same `fits` / `peak` / `cap` for every caller in the company. It
   must refuse to answer about an operator the caller could not read as an invoker (another
   company's, or one the `operators_select` policy hides from this caller: find that policy's LAST
   definition, `grep -in "policy operators_select" supabase/migrations/*.sql`, and use the same
   predicate through the same helper functions, never a re-derivation). Its `overlapping` list
   changes shape per row:
   - a block on a node in `app_readable_node_ids()`: the row exactly as today, plus
     `"outside": false` and `"parent_name"` (the name of the node's parent);
   - a block on a node the caller cannot read: `"outside": true`, `node_name`, `parent_name`,
     `timerange`, `efficiency`, and **`assignment_id`, `node_id` and `product_name` all JSON null**.
     Nothing else about that block leaves the server.
4. **A new function, `operator_blocks_elsewhere(p_from timestamptz, p_to timestamptz)`**,
   `SECURITY DEFINER`, `STABLE`, returning a set of
   `(operator_id uuid, node_name text, parent_name text, timerange tstzrange, efficiency numeric)`:
   every assignment overlapping the window, in the caller's company, whose operator the caller can
   read and whose node the caller CANNOT read. It is what the operator rail and the bar will use to
   say "booked (Cell 4, 6 am to 2 pm)" for a person who is busy on another line. It returns nothing
   for a caller who reads the whole plant, nothing for another company, and never a product, a run
   or an assignment id. Model it on `absence_recordable_people()` in
   `20260921000084_absence_recordable_people.sql` (read that file's header: it is the same idea, a
   permission question answered by the server as a set) and on `app_readable_node_ids()` in
   `20260909000074_readable_nodes_as_a_set.sql`. `REVOKE ... FROM PUBLIC`, revoke from `anon`,
   `GRANT EXECUTE ... TO authenticated`, in the DO-block shape the other migrations use.
5. **Every other caller of `operator_peak_load`** (`apply_split_coverage` and whatever else the
   grep finds in the LAST definitions): list them and say for each whether a definer helper
   changes what it answers. Splitting coverage with a block the caller cannot edit must still be
   refused by whatever refuses it today; prove it with a case.
6. A `COMMENT ON FUNCTION` for each function you touch, in the register of 0074's and 0084's.

Do not change `assignments_select` or any RLS policy. Do not make a column nullable. Do not touch
`dev_demo.sql` or `seed.sql`.

## The tests: `supabase/tests/99_capacity_counts_every_block_test.sql`

Read two existing files first for the harness (how a case signs in as a person, how PASS/FAIL is
raised as a NOTICE, how the tally works): `supabase/tests/20_capacity_test.sql` and
`supabase/tests/88_absences_test.sql` (AB5 holds a set-returning permission function to its
writer, person by person; yours must do the same). Build the fixture from the constants and
helpers the harness gives you, not from retyped column lists.

Cases, each named, each failing by name when its clause is removed:

- a supervisor scoped to one line, an operator with a block on another line she cannot read: her
  `create_assignment` over the same hours is REFUSED with the capacity error; the same write by the
  plant admin is refused the same way; both read `capacity_probe` as `fits: false`, the same peak.
- half and half is still legal across the boundary: the outside block at 0.5, hers at 0.5, is
  accepted (R-033: "Split coverage such as 50/50 is legal").
- the supervisor's probe row for the outside block carries `outside: true`, the cell's name, its
  parent's name, the hours and the efficiency, and JSON null for `assignment_id`, `node_id`,
  `product_name`; the admin's row for the same block carries them.
- an UPDATE that moves or stretches her own block into the outside block's hours is refused (the
  trigger fires on UPDATE too; check which events it is declared for).
- another company: a person of company 2 asking `capacity_probe` or `operator_peak_load` about
  company 1's operator learns nothing (the DEF-0013 shape).
- a caller who cannot read the operator at all is refused by `capacity_probe`.
- `operator_blocks_elsewhere`: for the supervisor it lists exactly the outside blocks of people she
  can read, and **it is held to the writer**: for every row it returns, her overlapping
  `create_assignment` at full efficiency is refused, and for a person with no row and no readable
  block it is accepted. For the plant admin it returns no rows. For company 2 it returns none of
  company 1's.
- the seed path: an insert as the owner with no company context still fires the trigger and still
  refuses a real double-booking (20_capacity_test's own cases must stay green unchanged).

## How to run it

The tester's stack is UP (container `supabase_db_production_scheduler_tester`); the main session
started it and will stop it. Do not run `tester-stack.mjs up` or `down`, do not start or stop any
container, never `npm run db:reset`. The SQL runner builds its OWN scratch database inside that
container from the migrations on disk, so it proves your migration without touching the stack's
main database:

```
$env:SUPABASE_DB_CONTAINER = "supabase_db_production_scheduler_tester"
bash scripts/run-sql-test.sh --rebuild
bash scripts/run-sql-test.sh 99_capacity_counts_every_block_test.sql
bash scripts/run-sql-test.sh 20_capacity_test.sql
```

(read the head of `scripts/run-sql-test.sh` for how it takes the container's name and how
`--demo` works). **Do NOT apply the migration to the stack's main database** (no
`supabase migration up`, no `psql -f` against `postgres`): the main session is running the
browser suites against it and will rebuild it with your migration afterwards. Then the WHOLE SQL
suite, every numbered file and `--demo`, so nothing else moved: copy each file's tally line and
the sum. The last measured total was 906 passed in 64 files plus the demo's 17.

`src/test/defects/DEF-0053.test.ts` is a static pin (the last definition of `operator_peak_load`
must be a definer): `npx vitest run src/test/defects/DEF-0053.test.ts` must go green. Do not edit
it. `src/test/defects/DEF-0053.live.mjs` needs the migration on a live stack; the main session
runs it later.

## Mutations (copy the migration first, restore from the copy; rebuild the scratch database each time)

Each red BY NAME: `SECURITY DEFINER` removed from `operator_peak_load`; the company guard removed
from it; the outside row's `product_name` left in; the operator-readable guard removed from
`capacity_probe`; `operator_blocks_elsewhere`'s "node not readable" test inverted; its company
filter removed.

## Files you own

`supabase/migrations/20260930000085_capacity_counts_every_block.sql` and
`supabase/tests/99_capacity_counts_every_block_test.sql`. If the SQL suite has a manifest or a
count that lists test files (grep `98_home_shift_test` across `scripts/`, `supabase/` and
`src/test/`), add yours there and say so.

## Files you must not touch

Everything under `src/` and `e2e/` (other lanes are there), `src/lib/database.types.ts` (the main
session regenerates it), `docs/defects/**`, `docs/plan.yaml`, `CLAUDE.md`, every earlier migration,
`supabase/dev_demo.sql`, `supabase/seed.sql`, `supabase/config.toml`.

## Rules

Do not commit. PowerShell runs `npm`/`npx` (no `&&`; use `;`); bash runs the SQL runner. Never
patch a file with `Get-Content`/`Set-Content`. Never `git checkout -- <file>`. Read-only `psql`
queries against the tester's container are fine (for `pg_get_functiondef`); writes to its main
database are not.

## Report

Plain prose. Which file each function body was extracted from and the guards you asserted on it.
What each function does now, in two sentences each, and how a caller with no company context is
told apart. The list of `operator_peak_load`'s callers and what changed for each. Every case by
name with its PASS line; the mutations with their FAIL lines; the whole suite's tally lines and
sum, copied. The JSON a supervisor's probe returns for an outside block, copied from a run. What
the client lane needs to know: the exact JSON keys, the new function's row shape, and anything
about the refusal (`capacity_exceeded`'s message and detail) that changed. What you did not do or
could not prove. A draft commit message in the repo's style: plain ASCII, the reasoning in prose,
no bullet lists.
