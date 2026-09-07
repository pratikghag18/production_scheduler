# Wave 3, lane C — named templates: a whole week saved, and applied through Copy Week (R-356)

You are one of the parallel lanes of wave three. Others may be editing this repo at the same
time: lane A (invitations: `supabase/functions/`, `SiteAccessPanel.tsx`, `src/lib/api/access.ts`,
`session.ts`, `ResetPasswordPage.tsx`, migration 0064) and lane D (absence: `AbsencesPanel`,
`AbsencesImport`, `ImportWizard`/`ImportPanel`, `src/lib/api/absences.ts`, `src/lib/absence.ts`,
`AdminPage.tsx`'s rail, migration 0066). **Touch only the files listed under "You own".** Ignore
`tsc`/ESLint errors in files you do not own. Do not run the full `npm run test`; run only your own
test files. Do not commit; do not edit `docs/plan.yaml` — report your plan additions as YAML in
your final message. **Never `npm run db:reset`, `supabase stop` or `supabase start`.** Your
migration is **0065** (`supabase/migrations/20260907000065_week_templates.sql`); apply it with
`psql` against the running container (`supabase_db_production_scheduler`) as session 83 did, then
`npm run db:types`, and say so. ⚠️ Migrations 0063 (plant-local time) and 0064 (invitations) may
have been applied to the live stack before yours and may have re-emitted `board_window` and
`site_people`; yours must not touch either. Copy Week's functions are yours alone.

Read first: `CLAUDE.md` (all of it), `docs/plan-format.md`, requirement **R-356** in
`docs/plan.yaml` (the maintainer's decision, verbatim — your contract), the S35 stage card and the
requirements titled "Copy Week always previews conflicts before committing" and "Copy Week shows
every clash and lets the person choose which plan wins, one by one"; migration 0055 in full
(`copy_week_plan`, `apply_copy_week`, their keys, clash reasons and the "no column list is
repeated: copies are written through the RPCs' parameters" rule) and the LAST re-emissions of both
(grep as CLAUDE.md §4 says: `-i`, optional `public.`, take the last hit); `src/lib/api/copyWeek.ts`;
`src/features/board/components/CopyWeekDialog.tsx` and `BoardToolbar.tsx`; `e2e/copyWeek.spec.ts`
(how a spec picks a scratch week and leaves the demo world intact); `src/test/copyWeek*.test.*`.

## The decision (do not re-ask)

A template is a NAMED COPY OF ONE WEEK'S RUNS WITH THEIR ASSIGNMENTS, stored relative to that
week's Monday, belonging to the plant it was saved from. Saving one is "Save this week as a
template" from the board; applying one is Copy Week with the template as the source instead of
another week, so every clash rule, the preview and the choose-per-clash flow apply unchanged, and
nothing is written that Copy Week would not write. A template is listed, renamed and deleted by
the plant's admins; a supervisor can apply one to a week they can place on and cannot delete one.

## What to build

1. **Migration 0065.** `week_templates` (`id`, `org_id`, `plant_id` with the D3 composite FK and a
   check through `app_node_is_plant_root`, `name` text NOT NULL, unique per plant
   case-insensitively, `saved_from` date, `created_by`, audit columns) and `week_template_items`
   (`template_id`, `kind` run|assignment, `item_ref` text unique per template (the run's key so an
   assignment item can point at its run item by `run_ref`), `node_id`, `operator_id` nullable,
   `product_id` nullable, `day_offset` 0–6 from Monday, `start_min`, `end_min` (minutes from that
   day's midnight; an overnight item's `end_min` exceeds 1440), and every field Copy Week copies
   from a run and an assignment TODAY — read 0055's copied set and carry exactly those, no more).
   RLS: readable by anyone who can read the plant; written only through RPCs. Writers:
   `save_week_template(p_plant_id, p_source_start date, p_name)` (snapshots the week through the
   same reads `copy_week_plan` uses for its "copied" set, so the two can never disagree about what
   a week contains; gated as `apply_copy_week` is gated for the source), `rename_week_template`,
   `delete_week_template` (both `app_is_admin_for(plant)`), `list_week_templates(p_plant_id)`.
   Then `copy_week_plan` and `apply_copy_week` gain `p_template_id uuid default null`: when set,
   `p_source_start` is ignored and the "copied" items are the template's, materialised onto
   `p_target_start` — extract the LAST definitions with a script, assert the guards you expect on
   the assembled text, add the branch, re-emit; the keys become `run:<item_ref>` /
   `assignment:<item_ref>` so decisions round-trip unchanged. Every clash reason 0055 knows applies
   to a template source exactly as to a week source, including lane D's `absent` if 0066 has added
   it by the time you re-emit (read the live definition with `pg_get_functiondef`, not the file).
   SQL cases in `supabase/tests/89_week_templates_test.sql`: save then list; a duplicate name
   refused; a supervisor may save from and apply to a week they can place on and may not delete;
   a viewer refused everywhere; a plan from a template equals a plan from the week it was saved
   from, item for item, when applied to the same target; an overnight shift crosses the day
   boundary correctly; apply writes exactly what Copy Week writes (compare the rows).
2. **The API.** `src/lib/api/weekTemplates.ts` (list, save, rename, delete; parsers from ONE column
   constant), `copyWeek.ts` widened with the optional template source on both inputs, `index.ts`
   one appended export line (re-read the file immediately before editing; lanes A and D append
   lines too).
3. **The board.** In `BoardToolbar`, beside Copy Week, "Save this week as a template" (a name
   field, the shared field of R-318; offered under the same rights as Copy Week's source). In
   `CopyWeekDialog`, a source picker: "another week" (today's flow, unchanged) or "a template"
   (a `<select>` of the plant's templates); everything after the source — the preview, the counts,
   the per-clash choice, the result sentence — is the same code path with the template id passed
   through. `describeCounts`/`describeHistory` say "from the template <name>" where they now say
   the source week.
4. **Admin.** A "Templates" section in the admin rail (`AdminPage.tsx`: lane D added an "absences"
   entry; re-read before editing and add yours beside it) listing the plant's templates with
   rename and delete, admins only (`adminSectionsFor`: it is NOT in a supervisor's list).

## The rules

- **Nothing is written that Copy Week would not write.** `apply_copy_week` with a template source
  goes through the same writers as with a week source. Pin it by comparing rows.
- **One reader of a week.** The snapshot and the plan read the week through one query; if you
  find yourself writing a second SELECT over runs and assignments, stop and reuse.
- **A column list that appears twice is a bug with a delay on it.** Constants; fixtures from them.
- **A green case can be pinning the bug.** If an existing Copy Week case goes red, read it first.
- **Walk it as the least-privileged person.** As Ana (Line 1 supervisor): save this week as a
  template, apply it to a scratch week, read the preview, settle a clash, confirm; try to delete it
  and read the refusal. As Dana: rename and delete it. As Viva: no control anywhere. Run
  `e2e/copyWeek.spec.ts` and `e2e/roleWalk.spec.ts` afterwards; the demo week must be as it was.

## Tests

- `supabase/tests/89_week_templates_test.sql` as above.
- `src/test/weekTemplates.test.ts`: parsers, the input shapes, `describe*` sentences for a template source.
- `src/test/copyWeekDialogTemplate.test.tsx`: the source picker, the same preview path with a template, the save control's rights.
- `e2e/weekTemplates.spec.ts`: the walk above, on a scratch week, skipping on `!hasRealBackend`.

## You own (exclusive)

- `supabase/migrations/20260907000065_week_templates.sql`, `supabase/tests/89_week_templates_test.sql`
- `src/lib/api/weekTemplates.ts` (new), `src/lib/api/copyWeek.ts`, `src/lib/api/index.ts` (one appended line)
- `src/features/board/components/CopyWeekDialog.tsx` + CSS Module, `BoardToolbar.tsx` + CSS Module (lane B has finished with the board by the time you start; if `git status` shows uncommitted changes there from another agent, stop and say so rather than editing over them)
- `src/features/admin/components/TemplatesPanel.tsx` + CSS Module, `AdminPage.tsx` (your rail entry only), `src/features/auth/session.ts` (nothing: templates are admin-only and "all" already covers admins)
- `src/test/weekTemplates.test.ts`, `src/test/copyWeekDialogTemplate.test.tsx`, `e2e/weekTemplates.spec.ts`
- `src/lib/database.types.ts` via `db:types` (never hand-edit)

You do NOT own `src/features/board/lib/*`, `BoardPage.tsx`, `shapes.ts`, `SettingsPanel.tsx`,
`AbsencesPanel`, `SiteAccessPanel`, `access.ts`, `absences.ts`, or migrations 0063, 0064, 0066.

## Finish

1. `npx prettier --write` and `npx eslint` on your files; `npx vitest run` on yours plus the existing Copy Week suites; the SQL file via the repo's runner; `npx playwright test e2e/weekTemplates.spec.ts e2e/copyWeek.spec.ts e2e/roleWalk.spec.ts`. Paste the runners' total lines verbatim.
2. Report, in order: what a supervisor and an admin can now do; files from `git status`; the runner lines; the row comparison that proves apply-from-template equals Copy Week; the walks; then YAML: `verified_by` entries and `status: covered` for **R-356** (do not restate its claim), plus a `findings` card **F-110** only if something went wrong. Anything unfinished, said plainly.
