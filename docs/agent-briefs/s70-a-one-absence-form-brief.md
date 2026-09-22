# S70-a — one absence form, mounted on two screens (R-360 amended, R-449)

Read R-360, R-449, R-357 and R-431 in `docs/plan.yaml`, DEF-0035 in `docs/defects/`, and CLAUDE.md
§4 and §7. The maintainer, 22 Sept: the person's block on the Operators tab keeps showing and
removing that person's absences, and records through the SAME form the Absences tab uses, not a
second one. "Why can't we reuse the form on the same page itself?"

## What exists

- `src/features/admin/components/AbsencesPanel.tsx`: the plant-wide tab. Its create form is the
  one DEF-0035 hardened: the Person list is the visible people intersected with the server's
  `absence_recordable_people` answer (`fetchRecordableAbsencePeople`), it shows Loading while that
  is pending and the error in words if it fails, and it never guesses on the client. Read its
  header comment; every rule in it stays.
- `src/features/admin/components/OperatorAbsences.tsx`: the person's block under "Where X can
  work". Its own `<form>`, its own add and remove mutations, near-identical code. This is the
  duplicate the audit found (`docs/agent-briefs/s69-b-one-place-audit-brief.md`, the Absences row).
- Pins: `src/test/absencesPanel.test.tsx`, `src/test/operatorAbsences.test.tsx`,
  `src/test/defects/DEF-0035.test.tsx`, `src/test/defects/DEF-0035-reopen.test.ts` (a static pin
  that greps the panel's text for `fetchRecordableAbsencePeople` and `recordableIds.has(p.id)` and
  for the absence of `canEdit(` / `useEditRights`; read it before moving code, since a moved line
  must still be found where it looks, or the pin's path updated in the same commit and said so).

## The change

1. Extract the create form from `AbsencesPanel.tsx` into one component, `AbsenceForm.tsx` beside
   it, with its own CSS Module. It takes the people it may offer (the visible people, already
   intersected with the server's answer, exactly as today), an optional fixed person, the
   from/to/reason state, the add mutation's error, and reports the submit. When a person is fixed,
   the Person control is not a dropdown: the name is shown as text and the form records for that
   person only, and only if the server's recordable answer includes them — otherwise the form says
   in words that this person cannot be recorded for from here, the same sentence the server would
   raise, and offers no Record button (R-431: nothing offered that the server refuses).
2. `AbsencesPanel.tsx` mounts it. Behaviour, wording and every test stay the same; the recordable
   query, the loading gate and the error alert stay in the panel or move into the form, whichever
   keeps the pins honest — say which in the report.
3. `OperatorAbsences.tsx` loses its own form and mounts `AbsenceForm` with the person fixed. It
   keeps its list, its "show past" toggle and its Remove. It needs the recordable answer too: use
   the same query key and the same fetch so react-query shares one request between the two screens.
4. Pins: `operatorAbsences.test.tsx` asserts the block records through the shared form (the form's
   own test id or role, not a copy of the markup) and no longer holds a form of its own — grep the
   file for the words of the old form after deleting it (CLAUDE.md §4: tsc cannot see a string
   expectation). Add to `absencesPanel.test.tsx` or a new `absenceForm.test.tsx`: with a fixed
   person the server does not accept, the form offers no Record and says so; with one it does, it
   records for exactly that person. `DEF-0035.test.tsx` and the reopen pin must still pass; if the
   reopen pin's grep target moved, update the path it reads and say so in the report.
5. Run `npx vitest run` on every test file named above plus `src/test/scaleAudit.test.ts` (a new
   admin stylesheet is walked by the audit: add it where the audit's lists say) and
   `src/test/popoverStandard.test.ts`. Then `npx prettier --write` and `npx eslint` on what you
   changed, and `npx tsc -b`.

## Boundaries

- You own: `src/features/admin/components/AbsencesPanel.tsx`, `OperatorAbsences.tsx`, the new
  `AbsenceForm.tsx` and its module, the four pins named above and any new test file, and the two
  `scaleAudit` lists if a stylesheet is added. Nothing under `src/lib/`, `supabase/`, `e2e/`,
  `docs/plan.yaml`, `CLAUDE.md`.
- Do not run the full `npm run test`. Do not commit. Do not `db:reset`.
- Report: what moved where, how the fixed-person case reads on screen (the exact sentence), the
  files changed from `git status`, and the runner output verbatim.
