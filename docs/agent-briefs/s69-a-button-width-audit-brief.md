# S69-a — the audit R-447 owes: every button group in the app at one width

Read R-447 in `docs/plan.yaml` (its `claim` and `note`) and CLAUDE.md §7. The standard: the buttons
that belong to one system share one width — a segmented control's segments (one grid track), a
stacked group (a stretched column), a toggle whose label changes (one min-width in em), a dialog
footer, and, answered 18 Sept, the per-row Edit/Deactivate/Delete clusters in admin tables. Nothing
moves when a label changes or a state flips. The one exception is a strip whose labels are data
(the bar's candidate answers, the rail's shift chips, the delete dialog's sentence, the counted
Apply); those four are already written on R-447.

What 18 Sept (session 179, commit 2d2ed3e) already did: the toolbar's four groups (TB-13 in
`src/test/boardToolbar.test.tsx` is the pin), every pop-up footer stretched, the import tabs, the
level editor footer and the template row actions. Do not redo those; read them as the pattern.

## The walk

1. Grep every stylesheet (`src/**/*.module.css`) and every component for a row or column of two or
   more buttons: `display: flex` / `grid` containers whose children are `<button>`s, `role="group"`,
   `aria-pressed` sets, `<footer>` and `.actions`/`.footer`/`.row` classes, table cells holding more
   than one button. Walk the admin tabs (Operators, Products, Cells, Access, Absences, Templates,
   Settings, Audit, imports), every pop-up and dialog, the rail, the command panel, the launcher,
   the sign-in and reset screens.
2. For each group write one row in the table below: file, the group, what it is (segmented, stack,
   toggle, footer, row cluster), whether its buttons already share one width (say how: grid track,
   stretched column, min-width), and if not, the fix or the reason it is a data exception.
3. Fix every hit that is not a data exception. Prefer the mechanism the toolbar used (one grid
   track class, a shared `min-width` in em for a toggle). One CSS Module per component; no bare px
   on a board stylesheet — a length there is `calc(Npx * var(--ui-scale, 1))`, and
   `src/test/scaleAudit.test.ts` will fail otherwise. Board stylesheets named in `BOARD_PX_LEGACY`
   in `src/test/scaleAudit.ts` are exempt today; if you clean one entirely, remove it from that list.
4. Pin the admin row clusters: one vitest file `src/test/buttonGroups.test.tsx` that renders the
   admin tables that have Edit/Deactivate/Delete clusters and asserts the cluster carries the class
   that gives its buttons one width (the TB-13 shape: assert the class, not a measured pixel).
5. Write every data exception you find that R-447 does not already list at the end of this file
   under "Exceptions found", so the developer copies them onto R-447.

## Boundaries

- You own: `src/**/*.module.css`, `src/test/buttonGroups.test.tsx`, this file. In `.tsx` files you
  may only add or change a `className` on a button-group wrapper; do not move, remove or rename
  controls (another lane is removing duplicate controls in the admin screens at the same time).
- Do not edit `docs/plan.yaml`, `CLAUDE.md`, `e2e/`, `src/lib/`, `src/test/scaleAudit*.ts` beyond
  shrinking `BOARD_PX_LEGACY`.
- Ignore tsc errors in files you do not own. Do not run the full `npm run test`; run
  `npx vitest run <file>` for the files you touch plus `src/test/scaleAudit.test.ts` and
  `src/test/boardToolbar.test.tsx`. Run `npx prettier --write` on what you changed and
  `npx eslint <files>`.
- Do not commit. Finish by appending the table and the exceptions to this file and reporting: the
  table, the files changed, the test results verbatim.

## The table

Walked: every `.module.css` in `src/components`, `src/features/board/components`,
`src/features/admin`, `src/features/admin/components`, `src/features/auth`, matched against every
`<button` in the corresponding `.tsx` (and the handful with no `className` at all, found by
scripting the JSX rather than trusting the CSS file list). "Already" rows were fixed by an earlier
session (mostly 2d2ed3e / ce631e7, 18 Sept) and are re-verified here, not re-fixed.

| file | group | kind | one width today? | fix / exception |
|---|---|---|---|---|
| BoardToolbar.module.css | `.zoom` (Compact/Standard/Fine) | segmented | yes — grid track | already (18 Sept, TB-13) |
| BoardToolbar.module.css | `.daynav` (Prev day/Today/Next day) | segmented | yes — grid track | already |
| BoardToolbar.module.css | `.density` | segmented | yes — grid track | already |
| BoardToolbar.module.css | `.weekPlanButtons` | stack | yes — stretched column | already |
| BoardToolbar.module.css | `.moreButton` (Show more/Show less) | toggle | yes — min-width em | already |
| ImportPanel.module.css | `.entityTabs` | segmented (tablist) | yes — grid track | already |
| ImportPanel.module.css / ImportWizard.tsx | Apply — add N, update N / Start over | footer | data label | already-written exception ("the counted Apply") |
| LevelEditor.module.css | `.actions` (Cancel/Save) | footer | yes — min-width em | already |
| LevelEditor.module.css | `.moveCol` (↑/↓) | icon pair | yes — fixed px box | already, not R-447's concern (icon glyphs, not words) |
| TemplatesPanel.module.css | `.rowActions` (Save/Cancel, Yes delete/Keep, Rename/Delete) | footer, morphing button | yes — min-width em | already |
| ProductsPanel.module.css | `.actions` (Deactivate\|Reactivate/Edit/Delete, Save/Cancel) | row cluster | yes — grid track | already |
| TrainingsPanel.module.css | `.actions` (Retire\|Unretire/Edit/Delete, Save/Cancel, move-confirm footer) | row cluster + footer | yes — grid track | already |
| TrainingsPanel.module.css | `.docActions` | footer | yes — grid track | already |
| ShiftsPanel.module.css | `.rowActions` (Retire\|Unretire/Edit) | row cluster | yes — grid track | already |
| ShiftsPanel.module.css | `.shiftActions` (Edit\|Cancel/Add break\|Cancel break/Delete) | row cluster | yes — grid track | already |
| ShiftsPanel.module.css | `.confirmActions` | footer | yes — grid track | already |
| ShapePicker.module.css | `.actions` (Rename/Delete/+ new structure) | row cluster | yes — grid track | already |
| ShapePicker.module.css | `.popActions` (rename Cancel/Rename) | footer | yes — min-width em | already |
| SiteAccessPanel.module.css | `.removeBtn`/`.addBtn`/`.deactivateBtn`/`.reactivateBtn` | per-column single buttons | yes — one shared box | already, not a group (each column holds at most one) |
| SiteAccessPanel.module.css | `.confirm` (Remove/Cancel) | footer | yes — min-width rem | already |
| DeleteDialog.module.css | `.actions` (Deactivate instead/Delete N.../Cancel) | footer | data label | already-written exception ("the delete dialog's sentence") |
| AssignmentPopover / ConfirmPopover / CopyWeekDialog / CreatePopover / RunPopover / SaveTemplateDialog / SplitCoveragePopover `.module.css` | `.row button` (every popover footer) | footer | yes — `flex: 1` stretched row | already |
| CommandBar.module.css | the bar's candidate-answer strip | strip | data label | already-written exception ("the bar's candidate answers") |
| OperatorPanel.module.css | `.shiftChips` | strip | data label | already-written exception ("the rail's shift chips") |
| OperatorsPanel.module.css | `.renameRow` (Edit/Deactivate\|Reactivate/Delete, Save/Cancel) | row cluster (detail header) | **no** | **fixed this lane — `.renameRow button { min-width: 6.5rem }`** |
| MatrixPanel.module.css | `.opActions` (All/None) | segmented | **no** | **fixed this lane — grid track, same as `.zoom`** |
| NodeTreeEditor.module.css | `.popActions` (Cancel/Rename\|Add, Cancel/Deactivate\|Delete) | footer | **no** | **fixed this lane — min-width em** |
| NodeTreeEditor.module.css | `.addRootForm` (Add/Cancel, no class on either button) | footer | **no** | **fixed this lane — min-width em on `.addRootForm button`** |
| NodeTreeEditor.module.css | `.menuList` (Rename/Add child/Move/Delete) | stack (row menu) | yes — stretched column (flex column, default `align-items: stretch`) | already, by construction |
| NodeTreeEditor.module.css | `.moveList` (destination names) | stack | data label | not a hit — labels are node names |
| ShapePicker.module.css | `.createForm` (Create/Cancel, no class on either button) | footer | **no** | **fixed this lane — min-width em on `.createForm button`** |
| matrixCells.module.css | `.popActions` (Save changes\|Record training / Remove / Cancel) | footer | **no** | **fixed this lane — min-width em, `.popPrimary`/`.popDanger`/`.popCancel`** |
| Field.module.css | `.editor` (InlineEdit's Save/Cancel — every editable cell in the app) | footer | **no** | **fixed this lane — `.editor .btn`/`.editor .primaryBtn { min-width: 4.5em }`** |
| AbsencesPanel / OperatorAbsences / AuditPanel / RequireAuth / SiteAccessPanel `Back`/`Add`/`Invite` etc. | single button | n/a | n/a | not a hit — one button has nothing to match widths with |
| DevProfileSwitcher.module.css | Sign out | single button | n/a | not a hit — dev-only, one button |
| AdminPage.module.css | `.railItem`/`.railItemActive` (section nav) | vertical nav | yes — stretched column (`.rail` is a flex column, default stretch) | already, by construction |
| Sign-in / Change-password / Forgot-password / Reset-password pages | submit | single button | n/a | not a hit — one button per screen |

## Exceptions found

None beyond the four already written on R-447 (the bar's candidate answers, the rail's shift
chips, the delete dialog's sentence, the counted Apply) — no new data-carrying strip turned up in
this walk.

## Fixes made this lane

Four genuine hits (buttons sized to their own word, sitting in the same cluster) plus two forms
whose buttons carried no class at all and so shared nothing even by coincidence:

1. **OperatorsPanel.module.css** — `.renameRow` holds the detail header's whole cluster (name,
   inputs, a select, AND the buttons), so it cannot become a grid track the way a dedicated
   `.actions` wrapper can without pulling the text and controls into columns too. Fixed with a
   shared `min-width: 6.5rem` reaching every `<button>` inside `.renameRow` directly — the
   `min-width`-in-em mechanism CLAUDE.md itself names for a toggle, applied through the row rather
   than a class unique to the buttons.
2. **NodeTreeEditor.module.css** — `.popActions` (the rename/add-child and delete-confirm
   footers) and `.addRootForm` (whose Add/Cancel had no class at all) both got a shared
   `min-width` on `button`, sized to the longest word each footer ever shows ("Deactivate").
3. **MatrixPanel.module.css** — `.opActions` (the operator picker's All/None pair) is the same
   segmented shape as the toolbar's `.zoom`/`.daynav`, fixed the same way: `inline-grid` with
   `grid-auto-columns: 1fr`.
4. **ShapePicker.module.css** — `.createForm`'s Create/Cancel carried no class either; same
   `min-width` fix, reached through the form wrapper.
5. **matrixCells.module.css** — `.popPrimary`/`.popDanger`/`.popCancel` (Save changes / Record
   training, Remove, Cancel) got a shared `min-width: 9em`, sized to the longest word ("Record
   training").
6. **Field.module.css** — `InlineEdit`'s own Save/Cancel (`.editor`), composed into every
   editable cell in the app. Scoped to `.editor .btn`/`.editor .primaryBtn` rather than the base
   `.btn`/`.primaryBtn` classes, which this module also hands out as single standalone buttons
   elsewhere (AbsencesPanel's Remove, the auth pages' submit) with nothing beside them to match.

Not fixed, and not a hit: `NodeTreeEditor.module.css`'s `.menuList` and `AdminPage.module.css`'s
`.railItem` are already one width by construction — both are `display: flex; flex-direction:
column` with no `align-items` override, so every child stretches to the container's full width by
default. Nothing to add.

Not pinned: `MatrixPanel`'s `.opActions` fix (item 3 above) is real but left out of
`src/test/buttonGroups.test.tsx` — its picker sits inside a native `<details>`/`<summary>`, and
jsdom does not implement the UA stylesheet rule that hides a closed `<details>`'s content, so a
render test cannot honestly tell "open" from "closed" the way a browser reader would. The class is
verified by reading the rendered CSS instead; a real-browser screenshot (the same exemption TB-13's
own header claims for pixel measurement) is the honest pin for it.

## Runner output (verbatim)

```
$ npx vitest run src/test/buttonGroups.test.tsx src/test/scaleAudit.test.ts src/test/boardToolbar.test.tsx

 RUN  v4.1.11 C:/Users/prati/OneDrive/Documents/GitHub/production_scheduler


 Test Files  3 passed (3)
      Tests  96 passed (96)
   Start at  09:48:27
   Duration  1.90s (transform 876ms, setup 549ms, import 837ms, tests 978ms, environment 1.63s)
```

```
$ npx prettier --write src/components/Field.module.css src/features/admin/components/MatrixPanel.module.css src/features/admin/components/NodeTreeEditor.module.css src/features/admin/components/OperatorsPanel.module.css src/features/admin/components/ShapePicker.module.css src/features/admin/components/matrixCells.module.css src/test/buttonGroups.test.tsx

src/components/Field.module.css 31ms (unchanged)
src/features/admin/components/MatrixPanel.module.css 22ms (unchanged)
src/features/admin/components/NodeTreeEditor.module.css 48ms (unchanged)
src/features/admin/components/OperatorsPanel.module.css 41ms (unchanged)
src/features/admin/components/ShapePicker.module.css 10ms (unchanged)
src/features/admin/components/matrixCells.module.css 10ms (unchanged)
src/test/buttonGroups.test.tsx 86ms
```

```
$ npx eslint src/test/buttonGroups.test.tsx src/components/Field.module.css src/features/admin/components/MatrixPanel.module.css src/features/admin/components/NodeTreeEditor.module.css src/features/admin/components/OperatorsPanel.module.css src/features/admin/components/ShapePicker.module.css src/features/admin/components/matrixCells.module.css

(six "File ignored because no matching configuration was supplied" warnings on the .module.css
files — eslint has no CSS parser configured in this repo; buttonGroups.test.tsx itself: 0
problems)
```

