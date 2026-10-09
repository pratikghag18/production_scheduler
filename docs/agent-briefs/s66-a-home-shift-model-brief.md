# S66-a — a person belongs to a shift: the model and the server (R-441, R-442, R-443)

Read R-441, R-442, R-443 in `docs/plan.yaml`, D137 in `docs/design-plan.md` (§19.108, with its
correction), and CLAUDE.md §4 and §7 (the standards; three of §4's bullets are about migrations:
extract never retype, a nullable column is a client change, `tsc` is inconclusive until `db:types`).
Then read, in this order: `supabase/migrations/20260821000005_shifts.sql` (the tables: `shifts` is
the band, `end_min` may exceed 1440 for a night band; `node_shift_templates` is one pattern per
node), `20260907000068_definer_helpers_answer_only_about_the_callers_company.sql:128-158` (the LAST
`resolve_shift_template`), `20260821000002_people_products_skills.sql:8-22` and
`20260827000023_shared_list_owners.sql:68-73` (`operators`), `20260821000006_profiles_and_grants.sql:26-36`
and `20260826000019_scoped_roles.sql:103-125` (`profile_grants` and its `role`),
`20260904000050_plant_settings.sql:458-554` (the LAST `check_eligibility` and how a per-node policy is
resolved), `20260907000069_absence_by_the_hour.sql:122-192` (`absence_overlap`, the model for a
per-person time predicate), the five writers that forward eligibility and absence
(`create_assignment` last body `20260911000079_a_join_stays_inside_its_run.sql:107-160`,
`reassign_assignment` `20260907000066_absences.sql:609`, `move_assignment` `20260911000080:120`,
`move_run` `0066:744/773`, `apply_copy_week` `0066:974`), the resize guard
`20260908000070_a_resize_asks_the_same_questions.sql:94-149`, and the board payload
`20260906000058_same_plant.sql:430, 584-604` (how `shift_templates`/`node_shift_map` and `operators`
are emitted). For the SQL suite's shape read `supabase/tests/88_absences_test.sql` (its header names
the seed's fixed fixture) and `30_shifts_test.sql:95-115` (owner-context cases after `RESET ROLE`).

You own: one new migration `supabase/migrations/20260918000082_home_shift.sql`, one new SQL test
`supabase/tests/98_home_shift_test.sql` (wired by `scripts/verify-db.sh` automatically — check),
`src/lib/database.types.ts` (regenerated only, by `npm run db:types`), `src/lib/api/shapes.ts` (the
board operator shape and the payload parser), `src/lib/api/operators.ts` (`OperatorRecord`,
`OPERATOR_COLUMNS`, the parser, the create/update inputs), `src/lib/api/shifts.ts` (a band-link
type if one is needed), `src/features/admin/lib/siteAccess.ts` (the grant's two new fields in
`AccessRow`), and their tests (`apiShiftShape.test.ts`, `apiOperators*.test.ts` if it exists, a new
`homeShift.test.ts` for the parsers). NOT the screens, the rail, the pop-ups, the bar, the seed or
the e2e — those are S66-b to S66-e. Do not run the full `npm run test`; no commits; no docs edits.
Never `db:reset`; apply the migration with `supabase migration up` (or `supabase db push --local`
per the repo's scripts — read `package.json`) and run the SQL suite with `scripts/verify-db.sh`.

## 1. The columns (R-443: the band itself, never its words)

- `operators.home_shift_id uuid null references shifts(id) on delete set null`, plus
  `foreign key (org_id, home_shift_id) references shifts(org_id, id)` if `shifts` has that unique
  pair (add `unique (org_id, id)` on `shifts` if it does not; `shift_templates` already has one).
  A band from another company is a constraint error, never a silent NULL. `ON DELETE SET NULL`
  is the "retired anyway" case of R-443: the person is visibly without a shift, never moved.
- `profile_grants.plans_shift_id uuid null` (same FK shape; NULL means the whole day) and
  `profile_grants.outside_shift boolean not null default true` (R-442: may place people outside
  their shift; the defaults change nothing for anyone).
- Column comments in the migration saying what each means in one sentence.

## 2. The server's verdict, `shift_fit`

A DEFINER function beside `check_eligibility`, guarded to the caller's company the way
`resolve_shift_template` is (copy its guard text; extract, never retype):
`shift_fit(p_operator_id uuid, p_node_id uuid, p_timerange tstzrange) returns jsonb` answering
`{"fit": "in" | "overtime" | "no_shift", "band": <name or null>, "band_start_min", "band_end_min",
"overtime_minutes": n}`. The rule: resolve the person's band by id when the node's pattern
(`resolve_shift_template(p_node_id)`) holds that band; else match a band of that pattern by name,
`lower()` both sides (R-443's last sentence); else `no_shift`. With a band, the range's minutes
outside the band's daily window (in the plant's zone — take the zone the way `absence_overlap` does;
a night band's `end_min > 1440` wraps into the next day) are `overtime_minutes`; zero means `in`.
The supervisor half: `supervisor_shift_allows(p_node_id uuid, p_timerange tstzrange) returns
boolean` for `auth.uid()`: true when no grant covering the node (the same covering rule the writers
use, `isAtOrBelow` on the path) has `plans_shift_id`, or when `outside_shift` is true, or when the
range lies inside the planned band; false otherwise. Owner exemption exactly as the other definers
(`auth.uid() IS NULL`).

## 3. The writers forward it

In each of the five writers and the resize guard, beside the absence question: call `shift_fit`
for the row's person and node and range; put the answer in the write's envelope under `shift`
(the same envelope that carries `absence`), so the client, the trace and the thread can name
overtime. Overtime is NEVER refused by the server (R-441: "can extend"; a plant switch is later).
`supervisor_shift_allows` false IS refused, with `api_raise('outside_shift', …)` in the writers'
own style and a message in plant words: "You plan Shift 2; 06:00–08:00 is outside it." Every
function re-emitted must be sliced from its LAST definition by a script and the guards you expect
asserted on the assembled text before it is written (CLAUDE.md §4, DEF-0011).

## 4. The board payload

`board_window` emits `home_shift_id` on each operator and, on each grant of the caller that covers
the root, `plans_shift_id` and `outside_shift` (or one `me` object with the caller's effective
planning band for this root — say which and why). The rail, the pop-ups and the bar (S66-c/d) read
these; nothing walks the tree on the client (DEF-0016).

## 5. The client shapes

`OperatorRecord`/`BoardOperator` gain `homeShiftId: string | null`; `OPERATOR_COLUMNS` gains the
column (grep for the second copy of that list before adding, §4); `AccessRow` gains
`plansShiftId` and `outsideShift`; the parsers accept the new keys and reject a wrong type as they
do today; the create/update inputs carry them. Run `npm run db:types`, then `npx tsc -b`, and say
"inconclusive" about tsc if you did not.

## 6. Proofs

`98_home_shift_test.sql` on the seed's fixed fixture: a person given a band; rename the band and the
person still resolves to it; retire the band (delete the row) and the person's `home_shift_id` is
NULL; a company-B band refused by the constraint; `shift_fit` in / overtime (with the minutes) /
no_shift, a night band across midnight, a cell whose pattern is another template matched by name
ignoring case; `supervisor_shift_allows` true by default, false for a grant that plans Shift 1 with
`outside_shift` false and a range at 15:00, true again with `outside_shift` true; every writer's
envelope carrying `shift`; the resize guard re-asking; the viewer and the line supervisor reading
the payload's fields (Ana on Line 1 sees the same band for a person as Dana does — the DEF-0016
shape). Vitest: the parsers, both directions.

Report: the migration's functions with the guard lines you asserted, the SQL suite's totals line
verbatim, `db:types` diff summary, tsc/eslint/prettier, every file touched, and anything this brief
got wrong.
