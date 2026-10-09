# S69-b — the audit R-449 owes: every admin screen and pop-up walked for a fact changed in two places

Read R-449 in `docs/plan.yaml` (its `claim` and `note`) and CLAUDE.md §7. The standard: any fact
about a thing — a person's shift, a grant's role, a product's places, a pattern's bands, a cell's
parent, a setting — is changed on the one screen where that thing is defined, and nowhere else. A
second control for the same fact anywhere is a defect; a new capability folds into the existing
control rather than adding a parallel one. The first hit was the shift on the Operators tab list
row, fixed 18 Sept (OS-2 and OS-6 in `src/test/operatorsPanel.test.tsx`); read that fix as the
pattern.

## The walk

1. List every fact the admin screens and the board's pop-ups can change. Walk
   `src/features/admin/**` (every tab: Operators, Products, Cells and the tree, Access and grants,
   Absences, Templates and patterns, Settings, imports) and `src/features/board/**` (the create
   and edit pop-ups, the rail, the command panel's writes, the toolbar's week plan), and the
   sign-in/account screens. For each write, name the fact (table.column or the RPC) and the
   control that changes it.
2. Group by fact. Any fact with two or more controls is a hit. A read-only display of the fact
   elsewhere is not a hit; a second place that WRITES it is. A control on the board that writes a
   fact the admin screen also writes (an assignment, a run, an absence) is a hit only if the two
   are the same fact about the same thing — an absence recorded on the Absences tab and the same
   absence removed from a board pop-up is a hit; a block placed on the board and a template applied
   from the toolbar are two different things.
3. For each hit decide which is the defining screen (where the thing itself is created and edited)
   and remove the other control, folding anything it could do that the defining control cannot
   into the defining control. Update or add the vitest case that asserts the second control is
   gone, in the panel's own test file (the OS-2/OS-6 shape).
4. Where removing a control would take away a capability the defining screen does not have, do
   not remove it: write the hit down with what the fold would need, and leave the code.

## Boundaries

- You own: `src/features/admin/**/*.tsx`, `src/features/board/components/*Popup*.tsx` and the
  pop-ups' tests, the admin panel tests under `src/test/*Panel*.test.tsx`, this file. Another lane
  is editing every `*.module.css` and adding classNames to button-group wrappers at the same time:
  do not edit stylesheets (leave a dead class behind and list it in your report); if a file you
  edit already has an unexpected className change, keep it.
- Do not edit `docs/plan.yaml`, `CLAUDE.md`, `e2e/`, `src/lib/`, `supabase/`.
- Ignore tsc errors in files you do not own. Do not run the full `npm run test`; run
  `npx vitest run <file>` for every test file you touch. Run `npx prettier --write` on what you
  changed and `npx eslint <files>`.
- Do not commit. Finish by appending the fact table below and reporting: every hit with its
  decision, the files changed, the test results verbatim, and any dead CSS class left behind.

## The facts

| fact (table.column / rpc) | thing | defining screen | other controls that write it | decision |
|---|---|---|---|---|
| `operators.home_shift_id` (`update_operator`) | a person's shift | Operators tab, Edit form (`OperatorsPanel.tsx`) | none — list row control removed 18 Sept (OS2/OS6, S66-b). `ShiftsPanel.tsx`'s retire-band flow (`confirmRetire`, ~line 525) also calls `useUpdateOperator()` for every displaced person, but it is the SAME hook instance the Edit form calls, invoked as one step of retiring a band, not a second picker a person uses to choose a shift. | Already compliant. Confirmed the retire-flow reuse is not a parallel control (checked both files import `useUpdateOperator` from the same place). |
| `absences` (`set_absence` / `remove_absence`) | an operator's absence record | Absences tab (`AbsencesPanel.tsx`) — plant-wide, and the one DEF-0035/R-431 hardened to offer only people the server will accept | Operators tab, per-person block (`OperatorAbsences.tsx`, rendered under "Where X can work") — its own `<form>`, its own `addMutation`/`removeMutation`, calling the same `setAbsence`/`removeAbsence` but NOT the same component (copy-shaped, not shared, unlike the matrix cells below) | **HIT, not folded.** This is the real second control R-449 is aimed at (two independently reachable screens, two separately-coded forms, same fact). But `docs/plan.yaml` R-360 (maintainer, 7 Sept, `status: covered`) is a standing, reasoned requirement that this exact duplication exist: *"The Absences tab stays: it is the company-wide view, this is the person-wide one."* Its own vitest proof (`src/test/operatorAbsences.test.tsx`) asserts recording and removing in place on this component. Removing the form here would pass R-449 but fail R-360 and break that pin — a maintainer-vs-maintainer conflict (7 Sept decision vs 18 Sept standard), not mine to resolve by deleting code under an audit brief. Left both files untouched; flagging for the maintainer to say which requirement gives way (fold OperatorAbsences down to read-only + a link to the Absences tab, or add an explicit carve-out for R-360 in R-449's note). |
| `operator_skills` grant (certified on / expires / signed off by) | a person's qualification for a product/skill | the shared `RecordPopover` in `matrixCells.tsx` (D100, "ONE SOURCE FOR BOTH MATRICES", anti-drift) | Matrix tab (`MatrixPanel.tsx`) and the Operators tab's own per-person matrix (`OperatorsPanel.tsx`) both mount it | Not a hit. One control, two entry points — not two implementations that can disagree, which is the shape R-449 forbids. This is the pattern done right; left as-is. |
| `products.site_node_ids` (assign/unassign a plant) | a product's places | Products tab (`ProductsPanel.tsx`) | none found elsewhere (checked `NodeTreeEditor.tsx`, `CycleTimesPanel.tsx`) | Not a hit. |
| `products.color_token` | a product's swatch | `ProductsPanel.tsx` (one palette component, staged in the Edit form or written at once from the standalone swatch — same screen, same mutation, already documented as deliberate) | none | Not a hit — one screen, one mutation, two entry points into the same widget. |
| `cycle_times.seconds_per_unit` | a product's cycle time at a node | Cell Times tab (`CycleTimesPanel.tsx`) | none | Not a hit. |
| `site_people` role / supervisor plan / active | a person's access grant | Access tab (`SiteAccessPanel.tsx`) | none — `OperatorsPanel.tsx`'s `setActive` toggles `operators.active` (employment/roster status), a different table and a different fact | Not a hit. |
| `hierarchy_levels` (name, schedulable) | the level vocabulary | `LevelEditor.tsx` | none | Not a hit. |
| `nodes.parent_id` / node moves (move, place, promote, demote) | a cell's parent | `NodeTreeEditor.tsx` | none | Not a hit. |
| `hierarchy_templates` (create/rename/delete) | a cell shape template | `ShapePicker.tsx` | none | Not a hit. |
| shifts / breaks / patterns (create, update, attach, detach, retire) | a pattern's bands | `ShiftsPanel.tsx` | none | Not a hit. |
| `week_templates` (rename/delete) vs `save_week_template` vs `apply_copy_week` | a saved week template | `TemplatesPanel.tsx` (admin: rename/delete the record) | `SaveTemplateDialog.tsx` (board: create one from the current week), `CopyWeekDialog.tsx` (board: apply one to a week) | Not a hit — three different actions on three different moments (create, manage the record, apply elsewhere), the brief's own "a block placed and a template applied are two different things" example. |
| org/plant settings (timezone, date format, command bar mode, eligibility policy) | plant/org settings | `SettingsPanel.tsx` | none | Not a hit. |
| board assignments / runs (create, reassign, split, direct-place) | a scheduled block or run | `CreatePopover.tsx`, `AssignmentPopover.tsx`, `RunPopover.tsx`, `DirectBlock.tsx`, `SplitCoveragePopover.tsx` | each is its own fact (create vs edit vs run detail vs split) | Not a hit — checked each popup's own header comment; no two write the same fact about the same thing. |
| operators / products / trainings / certifications / absences, bulk (CSV) | same facts as the rows above | the Imports tab (`ImportPanel.tsx` / `ImportWizard.tsx` + `OperatorsImport.tsx`, `ProductsImport.tsx`, `TrainingsImport.tsx`, `CertificationsImport.tsx`, `AbsencesImport.tsx`) | duplicates each interactive panel's fact, one row at a time vs many at once | HIT in principle, kept under step 4: a file-load capability the single-record form cannot do (nobody pastes hundreds of rows into an Edit form). Written down, code untouched. |
| board blocks removed for a period ("`<name> is out until <day>`") | assignments unassigned over a date range | `CommandBar.tsx` / `src/lib/command/resolve.ts`'s `expandAbsence` | none — read `expandAbsence` (resolve.ts ~4472): it walks the person's existing blocks and emits `unassign` commands, it never calls `set_absence`. A DIFFERENT fact from the Absences row above (retroactively clearing the board vs a tracked leave record that blocks future placement), so not the same-thing test the brief sets. Out of my ownership (`src/lib/`) regardless. | Not a hit. |
| a person's password | account credential | `ChangePasswordPage.tsx` (authenticated) vs `ForgotPasswordPage.tsx`/`ResetPasswordPage.tsx` (locked-out recovery) | each other | Not a hit — mutually exclusive scenarios (a locked-out person cannot reach the authenticated control). Noted for completeness only; `src/features/auth/**` is outside my file ownership and was not touched. |
| popover chrome | the pop-up shell every admin/board/matrix popover sits in | `src/components/Popover.tsx` | historical: admin, board and the matrix each carried their own clone before consolidation | Already fixed pre-existing work; `src/test/popoverStandard.test.ts` enforces it. Confirmed still compliant, no action needed. |

### Summary

The walk covered every admin tab and pop-up under `src/features/admin/**`, every board pop-up and the
command bar under `src/features/board/**`, and the auth/account screens for completeness. One genuine,
unfolded hit was found (Absences: `AbsencesPanel.tsx` vs `OperatorAbsences.tsx`), and it is blocked by a
standing, reasoned, maintainer-stated requirement (R-360) that predates R-449 and explicitly chose this
exact duplication on purpose — a conflict between two maintainer decisions, not a coding call, so no file
was changed. The bulk-import tabs are a second, lower-stakes instance of the same shape, kept under the
brief's own step-4 exemption (a capability — many rows at once — the defining screen cannot offer). Every
other candidate (the skills matrix, products, cycle times, access, levels, the node tree, shapes, shift
patterns, templates, settings, the board's own pop-ups, and the bar's absence grammar) checked out as
either a single shared control mounted twice (not a hit) or two genuinely different facts. No `.tsx`,
`.ts`, `.css`, or test file besides this brief was edited by this lane; nothing was committed.

