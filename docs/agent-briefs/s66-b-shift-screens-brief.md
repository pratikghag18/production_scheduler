# S66-b — a person belongs to a shift: the admin screens (R-442, R-443, R-444)

Read R-441 to R-444 in `docs/plan.yaml`, D137 in `docs/design-plan.md` (§19.108 and its correction), and
CLAUDE.md §4 and §7. The model and the server are in (S66-a, commit 68badab): `operators.home_shift_id`
(a band by id), `profile_grants.plans_shift_id` and `outside_shift`, `OperatorRecord.homeShiftId`,
`AccessRow.plansShiftId`/`outsideShift`, the bands readable through `src/lib/api/shifts.ts` (`ShiftRow`,
`ShiftTemplateRow`, `NodeShiftTemplateRow`), and `98_home_shift_test.sql`. Nothing is on screen yet: the
maintainer looked at the Operators tab and the Access tab on 18 Sept and asked what had been marked
complete. This lane puts the rule on screen. Read `src/features/admin/components/OperatorsPanel.tsx`
(the create and edit fields ~550–555 and ~607–609; the rows from `src/features/admin/lib/operators.ts`),
`src/lib/api/operators.ts` (the create/update inputs the lane extended), `src/features/admin/lib/operatorImport.ts`
(the CSV columns ~56–72, template header ~106, `OPERATOR_FIELDS` ~326), `src/features/admin/components/SiteAccessPanel.tsx`
and `lib/siteAccess.ts` (the role row, `canSetRole`, `allowedRoles`), `src/features/admin/components/ShiftsPanel.tsx`
and `lib/shiftDraft.ts` (retiring a band or a pattern: the delete-refusal reasons ~605, `active`/retire ~310, ~1038–1068),
`src/features/admin/components/AuditPanel.module.css` (~140–200: the left-edge accent in `--crit`, an inset
box-shadow on the first cell), `src/test/scaleAudit.ts:88-105` and `scaleAudit.test.ts:221-229` (the admin
stylesheet list, edited in BOTH places if you add a stylesheet), and the write RPCs for operators and grants
(`set_site_member`, the operator update path) to see which of them must carry the new fields.

You own: `OperatorsPanel.tsx` and its stylesheet, `lib/operators.ts`, `operatorImport.ts` and `OperatorsImport.tsx`,
`SiteAccessPanel.tsx` and `lib/siteAccess.ts`, `ShiftsPanel.tsx` and `lib/shiftDraft.ts`, `src/lib/api/operators.ts`,
`src/lib/api/site*.ts` as needed for the grant fields, their tests, and IF a server write must learn the new
fields, one new migration `20260918000083_home_shift_writers.sql` (extract from the LAST definition with a
script, assert the guards on the assembled text, `npm run db:types`, a SQL test file `99_home_shift_writers_test.sql`;
say plainly if you did not need one). Another lane works in `BoardToolbar` at the same time; ignore its
files and tsc errors in them. No commits, no docs edits, no full `npm run test`, no playwright, never
`db:reset`.

1. **The Operators tab, R-443 and R-444.** Each person's row gains a Shift column: a dropdown of the bands
   of the pattern the person's home place resolves (`resolve_shift_template` through the board or admin
   payload — use what the admin data already carries; if the admin payload has no pattern per place, add
   the smallest read), showing "No shift" when empty. A person with no shift carries the activity tab's
   red left-edge bar on the row (the same inset box-shadow in `--crit`) and the words "No shift" in the
   column; those rows sort to the top; the tab's head says "N people have no shift". The create form
   offers the same dropdown. Saving writes `home_shift_id` through the existing operator update path (a
   nullable uuid; extend the input, not a second door). Pins OS-1..OS-5: the dropdown lists exactly the
   pattern's bands; No shift on top with the bar and the words; the count line; a save writes the id;
   a person whose band was retired reads No shift.
2. **The CSV importer.** A fifth column, "Shift", matched by band NAME against the person's plant pattern
   (case-insensitive), blank allowed; an unknown name is a row error naming the pattern's bands. Template
   header gains it. Pins OI-1..OI-3.
3. **Retiring a band or its pattern, R-443.** In the Shifts panel, retiring a band (or a pattern holding
   bands) that people point at first shows the count ("12 people work Shift 2") and asks where they go:
   the other bands of that pattern and of any newer pattern on that place, or "Leave them without a
   shift"; the dialog says the straightforward order in one sentence (create the new shift first, then
   retire). Moving them is one write per person through the same update path (or one RPC if the lane
   must add one — say which). Left without, they show at the top of the Operators tab as in item 1.
   Pins SH-1..SH-3.
4. **The Access tab, R-442.** The grant row gains two controls beside the role: "Plans" (Whole day, or a
   band of the place's pattern) and "May place outside their shift" (a checkbox, on by default), both
   enabled under the same test the role control uses (`canSetRole`, site admin or above, at or below
   their place), written through `set_site_member` (extend its arguments in the migration if it does not
   take them; extract, never retype). Pins SA-1..SA-4: the defaults, the controls disabled for a
   supervisor viewing an admin's grant, a save writing both fields, a viewer's row unchanged.

Then `npx vitest run` on your test files plus `src/test/scaleAudit.test.ts src/test/fieldStandard.test.ts
src/test/iconStandard.test.ts src/test/popoverStandard.test.ts`, `npx tsc -b`, `npx eslint src/features/admin src/lib src/test`,
`npx prettier --check` on your files, and if a migration was added `bash scripts/run-sql-test.sh --rebuild`
then your test file and `98_home_shift_test.sql`, tallies verbatim. Report: the pins, every existing case
changed with its reason, the runners' totals, the migration's guard lines if any, and anything the brief
got wrong.
