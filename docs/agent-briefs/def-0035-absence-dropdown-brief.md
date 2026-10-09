# DEF-0035 — The Absences "Person" dropdown offers only the people the server would accept (R-357, R-431)

The tester (session 181t): signed in as Ana (a Line 1 supervisor on Plant A), the Absences tab's
Person dropdown lists all six Plant A people, but `set_absence` (migration 0069, line ~285)
refuses everyone whose home is off her line with `not_permitted` ("you cannot record an absence
for someone at that place"). The screen offers what the server refuses — CLAUDE.md §4 and the
standard R-431. The panel's header comment argues the opposite on purpose ("offer all, let the
server refuse"); the maintainer, 21 Sept, sided with the tester: **filter the dropdown by the
server's own predicate.** Nothing new is placed on the screen; the list gets shorter.

You own: `src/features/admin/components/AbsencesPanel.tsx`, `src/test/absencesPanel.test.tsx`,
a new pin `src/test/defects/DEF-0035.test.tsx`, and comments only in `e2e/absenceOnBoard.spec.ts`
and `e2e/absences.spec.ts`. If the admin operator row lacks the person's home node you may make an
ADDITIVE change to `src/features/admin/hooks/useOperators.ts` and `src/features/admin/lib/operators.ts`
(a new optional field, nothing renamed). Nothing else. Ignore `tsc` errors in files you do not own.
Do not run the full `npm run test`. No commits, no `docs/plan.yaml` edits.

## The predicate, transcribed, never re-derived

The server gates on `app_can_edit_node(coalesce(home_node_id, site_node_id))` of the chosen person.
The client already carries that predicate: `useEditRights(enabled, role)` in
`src/features/admin/hooks/useEditRights.ts` returns `canEdit(ownerPath)`, which is `canEditNode` in
`src/features/admin/lib/editRights.ts` — read that file's header; it quotes the SQL clause by clause
and it FAILS OPEN (rights not yet known, or a path the client cannot resolve, answers true).
`TrainingsPanel.tsx` line ~611 is the pattern: `canEdit(nodesById.get(row.siteNodeId)?.path ?? null)`.

## What to build

1. In `AbsencesPanel.tsx`, take `const { canEdit } = useEditRights(canQuery, profile?.role ?? null)`
   (the panel already reads `useSession()`; take `profile` from it too). Derive the dropdown's
   people from `visiblePeople` filtered by
   `canEdit(nodesById.get(person.homeNodeId ?? person.siteNodeId)?.path ?? null)` — the SAME
   coalesce order the server uses. Check what `useOperatorsAdmin` hands the panel: if its operator
   rows carry no `homeNodeId`, add it (the API shape in `src/lib/api/shapes.ts` line ~361 already
   parses `home_node_id`, so it is a matter of passing it through). The absences TABLE keeps
   listing every visible person's rows (reading is wider than writing, by design); only the
   create form's Person list narrows.
2. Rewrite the panel's header paragraph that starts "TAKES NO PROPS and DECIDES NO PERMISSION":
   it must now say that the Person list is decided by the same predicate `set_absence` runs
   (`canEditNode`, fail-open), citing DEF-0035 and R-431, and that a refusal is STILL shown in
   words if the server disagrees (the fail-open case). Keep the R-333 and R-359 paragraphs.
3. `src/test/absencesPanel.test.tsx` mocks `@/lib/api` without `fetchGrantPaths` and
   `useSession` without `profile.role`; extend the mocks so the panel renders (add
   `fetchGrantPaths` returning a controllable value, and `role` on the profile). Existing cases
   must keep passing with rights that cover everyone; if any case turns red, say in the report
   whether it was wrong or the contract changed, per CLAUDE.md §4.
4. The pin `src/test/defects/DEF-0035.test.tsx`, in the style of the other files under
   `src/test/defects/`: render the panel with two people — one homed on `plant.line1` (a path
   the reader's writable grant covers) and one homed on `plant.line2` (not covered), reader role
   `supervisor`, grant paths `writablePaths: ["plant.line1"]`, `adminPaths: []` — and assert the
   Person dropdown offers the first and not the second, while the absences table still lists
   both people's rows. A second case: rights unknown (`fetchGrantPaths` pending or rejected)
   offers both (fail-open). A third: a person with `homeNodeId: null` is decided on
   `siteNodeId`. Assert with `getByRole("option")`. Run only
   `npx vitest run src/test/defects/DEF-0035.test.tsx src/test/absencesPanel.test.tsx`.
5. `e2e/absenceOnBoard.spec.ts` line ~65 and `e2e/absences.spec.ts` line ~34 say "the first
   person Ana may place" / "the panel offers only the people she can see" — reword to "the
   panel offers only the people she may record for (DEF-0035)". No other e2e edits; the developer
   runs them after the lanes finish.

## Report

The filter expression as written, whether `homeNodeId` had to be threaded through (and where), the
vitest run lines for both files copied verbatim, any pre-existing case you had to change and why,
and `git status --short`.
