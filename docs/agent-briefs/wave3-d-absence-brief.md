# Wave 3, lane D — absence: recorded in the app, imported by file, and a clash on the board (R-357)

You are one of three parallel lanes. Two other agents are editing this repo at the same time: lane
A (invitations: `supabase/functions/`, `SiteAccessPanel.tsx`, `src/lib/api/access.ts`,
`session.ts`, `ResetPasswordPage.tsx`, migration 0064) and lane B (plant-local time: EVERYTHING
under `src/features/board/`, `src/lib/api/shapes.ts`, `SettingsPanel.tsx`, migration 0063).
**Touch only the files listed under "You own".** Ignore `tsc`/ESLint errors in files you do not
own. Do not run the full `npm run test`; run only your own test files. Do not commit; do not edit
`docs/plan.yaml` — report your plan additions as YAML in your final message. **Never
`npm run db:reset`, `supabase stop` or `supabase start`.** Your migration is **0066**
(`supabase/migrations/20260907000066_absences.sql`); apply it with `psql` against the running
container (`supabase_db_production_scheduler`) as session 83 did, then `npm run db:types`, and say so.

Read first: `CLAUDE.md` (all of it), `docs/plan-format.md`, requirement **R-357** in
`docs/plan.yaml` (the maintainer's decision, verbatim — it is your contract), R-338 (the expired
certificate: the pattern for "the screen shows what the server will refuse"), R-331 (the
warn-or-block policy per plant), and the S35 stage card (Copy Week's clash kinds); migrations
0002 (`operators`), 0003 (`assignments`), 0023 and 0050 (`check_eligibility`, and how
`create_assignment`, `move_run`, `reassign_assignment` read it under the resolved policy), 0055
(`copy_week_plan` and its clash reasons `run_overlap` / `operator_busy` / `not_eligible`), 0060
(`site_people`, for the RLS shape of "who may read whom"); `src/lib/api/imports.ts` and
`src/features/admin/lib/operatorImport.ts` + `ImportWizard.tsx` (the import pipeline's shape:
detect columns, plan rows with outcomes, write through the API); `src/features/admin/AdminPage.tsx`
(the rail and its section ids), `src/features/auth/session.ts` (`adminSectionsFor`);
`src/lib/api/copyWeek.ts` (the clash types the client parses).

## The decision (do not re-ask)

An absence is a PERSON, a DATE RANGE and a REASON. It enters the app two ways: recorded on an
Absences tab in admin by a supervisor or admin of the person's place, and imported by file
through the existing import pipeline in the same shape as operators and trainings. On the board
and in Copy Week an assignment overlapping an absence is a clash of its own kind, decided by the
same server function that decides eligibility, refused or warned under the plant's existing
warn-or-block policy, and shown on the screen before the save by the same predicate the server
runs.

## What to build

1. **Migration 0066.** Table `absences` (`id`, `org_id`, `operator_id` with the D3 composite FK,
   `daterange` as `daterange` NOT NULL with an exclusion constraint so one person cannot have two
   overlapping absences, `reason` text NOT NULL (a short closed list is wrong here: leave it free
   text, trimmed, non-empty), `source` text default `'manual'`, `external_id` text with the same
   `(org_id, external_id)` uniqueness the operators table uses so a re-import is an upsert, and
   the audit columns). RLS: readable by anyone who can read the person (`operators`' own policy,
   reuse its predicate, never a second copy); written only through RPCs. Writers:
   `set_absence(p_operator_id, p_from date, p_to date, p_reason, p_external_id default null)`
   returning the row, `remove_absence(p_id)`, and `import_absences(p_rows jsonb)` that upserts on
   `external_id` and returns per-row outcomes the way the operator import reports them — each
   gated on `app_can_edit_node(operator.home_node_id)` (a supervisor or admin OF THE PERSON'S PLACE,
   the maintainer's words), refusing `not_permitted` otherwise, and reading the row back before
   answering (a write that reports success can have changed nothing). A predicate
   `absence_overlap(p_operator_id, p_timerange) returns jsonb` (SECURITY DEFINER, like
   `check_eligibility`: the caller may not be able to read the person's home) answering
   `{ absent: bool, from, to, reason }` for the first absence overlapping the range's DAYS in the
   server's date terms. Then the writers: `create_assignment`, `move_run` (its crew loop),
   `reassign_assignment` and `copy_week_plan` each consult it beside `check_eligibility` — extract
   the LAST definition of each with a script, assert the guards you expect on the assembled text,
   add the one call and the one branch, and re-emit; a new error code `absent` and Copy Week
   clash reason `absent`, both under the same resolved `eligibility_policy` (warn → a warning in
   the payload, block → a refusal). SQL cases in `supabase/tests/88_absences_test.sql`: the
   exclusion constraint; a supervisor of the person's place may record, one of another place may
   not; a viewer may read and not write; a direct INSERT is refused; an assignment over an absence
   is refused under block and warned under warn, for create, move, reassign and the copy plan;
   the definer predicate answers for a line supervisor asking about a person homed at the plant.
2. **The API and the pure half.** `src/lib/api/absences.ts` (fetch by plant and date range,
   set, remove, import — parsers built from ONE column constant), exported from `index.ts` by one
   line you append at the end of the file (re-read the file immediately before editing it: lane A
   may add a line too). `src/lib/absence.ts`: the pure predicate `absenceGaps(absences, operatorId,
   timerange)` that mirrors `absence_overlap` exactly (the day arithmetic in UTC, the way
   `certificateGaps` does, and say so in its header), and the import planner
   `src/features/admin/lib/absenceImport.ts` in the shape of `operatorImport.ts` (column detection
   for `employee_ref` / `external_id` / `display_name`, `from`, `to`, `reason`; row outcomes; a
   template the wizard can download).
3. **The Absences tab.** A new rail section `absences` in `AdminPage.tsx` (label "Absences"),
   offered to everyone `adminSectionsFor` offers Operators to (a supervisor's list) — widen that
   one function, nothing else. `src/features/admin/components/AbsencesPanel.tsx` + its CSS
   Module: the plant filter the other panels use, a list of absences for the visible people (the
   person, the dates in the plant's date format, the reason), add and remove, refusals in words.
   Fields are the shared field (R-318, `Field.module.css`) — never a copied input skin. Plus an
   Absences importer in the import wizard beside the others (`AbsencesImport.tsx`).
4. **NOT in this lane: the board.** The board's own surfacing (a chip in the create pop-up, the
   panel's people list, the Copy Week dialog's new clash kind) lives under `src/features/board/`,
   which lane B owns right now. Write down in your report exactly what the board needs to call
   (`absenceGaps`, the `absent` error code and clash reason it must describe) so a follow-up
   lane wires it in one sitting. The server refuses correctly with or without that wiring; that is
   why the server half comes first.

## The rules

- **The server decides; the client mirrors the same predicate.** `absenceGaps` and
  `absence_overlap` must agree on the boundary days; pin both sides of the boundary (an absence
  ending on the day the shift starts, a shift ending at midnight) in the SQL file and in vitest.
- **Anything resolved by walking up the tree is a definer.** The predicate and the policy read
  (`app_resolve_node_setting`) are definers; the writers are what they are today.
- **A column list that appears twice is a bug with a delay on it.** One `ABSENCE_COLUMNS`
  constant; fixtures built from it.
- **Walk it as the least-privileged person.** As Ana (Line 1 supervisor): record an absence for
  someone homed at Line 1, see it, remove it; try to record one for someone homed at Plant B and
  read the refusal. As Viva (viewer): the tab is not offered, and a direct RPC call refuses. As
  Dana: import a three-row CSV, one row bad, and read the outcomes.
- **Leave the demo world as you found it.** Remove what you recorded; imported rows too.

## Tests

- `supabase/tests/88_absences_test.sql` as above.
- `src/test/absence.test.ts`: `absenceGaps` boundary cases, mirrored on the SQL cases by name.
- `src/test/absenceImport.test.ts`: the planner (column detection, outcomes, a bad row).
- `src/test/absencesPanel.test.tsx`: the tab renders for a supervisor and not for a viewer, add
  and remove call the API and show refusals as sentences.
- `e2e/absences.spec.ts`: the walk above, skipping on `!hasRealBackend`.

## You own (exclusive)

- `supabase/migrations/20260907000066_absences.sql`, `supabase/tests/88_absences_test.sql`
- `src/lib/api/absences.ts` (new), `src/lib/absence.ts` (new), `src/lib/api/index.ts` (one appended export line)
- `src/features/admin/AdminPage.tsx` (the section id and rail entry), `src/features/auth/session.ts` ONLY the `adminSectionsFor` list (lane A owns `initialRecoveryFlag` in the same file: edit only your function, re-read before editing)
- `src/features/admin/components/AbsencesPanel.tsx` + CSS Module, `AbsencesImport.tsx`, `ImportWizard.tsx` / `ImportPanel.tsx` (adding the importer), `src/features/admin/lib/absenceImport.ts`
- `src/test/absence.test.ts`, `src/test/absenceImport.test.ts`, `src/test/absencesPanel.test.tsx`, `e2e/absences.spec.ts`
- `src/lib/database.types.ts` via `db:types` (the other lanes regenerate it too; regenerate after applying yours and never hand-edit it)

You do NOT own anything under `src/features/board/`, `src/lib/api/shapes.ts`, `copyWeek.ts`
(read it; if the client's clash-reason union needs `absent`, say so in your report),
`SettingsPanel.tsx`, `SiteAccessPanel.tsx`, `access.ts`, or migrations 0063–0065.

## Finish

1. `npx prettier --write` and `npx eslint` on your files; `npx vitest run` on yours; the SQL file via the repo's runner; the e2e spec. Paste the runners' total lines verbatim.
2. Report, in order: what a supervisor, an admin and a viewer can now do; files from `git status`; the runner lines; the walks; the exact board wiring still owed (function names, error code, clash reason, where each belongs); then YAML: `verified_by` entries and `status: covered` for **R-357** (do not restate its claim; it is the maintainer's), plus a `findings` card **F-111** only if something went wrong. Anything unfinished, said plainly.
