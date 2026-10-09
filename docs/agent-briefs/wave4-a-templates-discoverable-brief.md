# Lane brief: R-358 — a saved template can be found and applied by the person most likely to look

You are a build lane. You own exactly these files and no others:

- `src/features/board/components/BoardToolbar.tsx`
- `src/features/board/components/SaveTemplateDialog.tsx`
- `src/features/board/components/CopyWeekDialog.tsx`
- `src/features/admin/components/TemplatesPanel.tsx`
- `src/features/admin/components/TemplatesPanel.module.css`
- `src/test/copyWeekDialogTemplate.test.tsx` (add cases; do not reword existing ones)
- `e2e/weekTemplates.spec.ts`

Another lane is changing absence (a migration, `src/lib/absence.ts`, the Absences panel, the
Operators panel). Do not touch anything under `src/features/admin/components/Absences*`,
`OperatorsPanel.tsx`, `src/lib/absence.ts`, `src/lib/api/absences.ts`, or `supabase/`. Ignore `tsc`
errors in files you do not own. Do NOT run the full `npm run test` and do NOT run any SQL suite.
Do not run `npm run db:reset` — the maintainer is using the app. Do not commit; do not edit
`docs/plan.yaml` or `docs/defects/*.md`.

Read first: `CLAUDE.md` §4 in full, then `docs/plan.yaml`'s **R-356** and **R-358** rows (grep
`^- id: R-356` and `^- id: R-358`), then `BoardToolbar.tsx` and `CopyWeekDialog.tsx` whole.

## The problem, measured — not a guess

`BoardToolbar.tsx` line ~131:

    const offerCopyWeek      = plant !== null && isAdmin;
    const offerApplyTemplate = plant !== null && canPlaceHere && !isAdmin;
    const offerSaveTemplate  = plant !== null && canPlaceHere;

An **admin** therefore never sees "Apply a template". Their only route to a saved template is the
`<select>` labelled "Copy from" inside `CopyWeekDialog`, reached from a button called "Copy week" —
a control named after the other thing it does. The maintainer, who is an admin, asked *"how do I
even use them?"* and that is the whole answer. Nothing is broken; the feature is unreachable.

## The decisions already made — do not re-litigate them

1. **"Apply a template" is offered to everyone who may place, admins included.** It opens the SAME
   `CopyWeekDialog` at the same anchor, already switched to the template source.
2. **"Copy week" keeps its own admin-only button.** The two are different jobs and both stay named.
   Order in the toolbar: `Copy week` (admin only), then `Apply a template`, then
   `Save this week as a template`.
3. **No permission changes at all.** Every control stays gated by the same `fetchIsAdminFor` /
   `fetchCanPlaceInPlant` answers the server gives (CLAUDE.md §4: a screen offers only what the
   server allows). A viewer is still offered none of the three. Nothing is offered while the ask is
   loading or after it failed.

## What to build

**A. `BoardToolbar.tsx`.** `offerApplyTemplate` becomes `plant !== null && canPlaceHere` — the
`!isAdmin` term goes. The Copy Week dialog needs to know which button opened it, so replace the
single `copyWeekAnchor` state with an anchor plus an opening mode
(`{ x, y, source: "week" | "template" }`, or a second piece of state — your call, one shape, not
two), and pass that mode to `CopyWeekDialog` as a new **optional** prop, defaulted so every existing
caller and every existing test keeps today's behaviour. Read `CopyWeekDialog`'s line 82 before you
choose the prop's name: `sourceMode` is initialised from `isAdmin` today and your prop must not
fight it — an admin opening "Copy week" still starts on the week source, an admin opening "Apply a
template" starts on the template source, and a supervisor is unchanged (template only). `CopyWeekDialog.tsx` is yours, so add the prop
there: a new OPTIONAL `initialSource?: "week" | "template"` whose absence leaves line 82 exactly as
it is today. Do not change `isAdmin`’s meaning — it still decides whether the source PICKER is
offered at all; the new prop only decides where the picker starts.

Update the two `title=` tooltips so each names what its own button does and neither describes the
other's job.

**B. `SaveTemplateDialog.tsx`.** After a successful save, the confirmation names the route back:
one sentence, in the repo's voice, telling the reader the template is now on this plant's list and
is applied with "Apply a template" on this toolbar. Keep it one sentence; do not add a control.

**C. `TemplatesPanel.tsx` + its CSS.** The panel lists, renames and deletes; it cannot apply, and
today it says nothing about where applying happens. Add, above the list, one short paragraph in the
panel's own register: what a template is (a whole week's runs and their people, saved from this
plant), where it is saved from, and where it is applied — the board's toolbar, "Apply a template".
Name the plant it is talking about. On "All plants" or a plant the reader may only view, the panel
already offers nothing; the paragraph must still make sense there or not render — your call, stated
in the report. Also show, per template row, the week it was **saved from** (`saved_from`, already on
`WeekTemplate` — check the type before using it) in the plant's date format if the panel already
resolves one, otherwise leave the row alone and say why. Do not add an Apply control here.

CSS: layout only, in the existing module, `rem` units — `src/test/scaleAudit.test.ts` audits every
admin stylesheet and it is already in `REM_SURFACES`, so no list needs editing, but a `px` value
will turn it red.

## Proving it

Run only these, and copy the runner's own summary lines into your report — never a number you
reasoned to:

1. `npx vitest run src/test/copyWeekDialogTemplate.test.tsx` — must be green, with **new cases you
   add** for: an admin is offered all three buttons; an admin's "Apply a template" opens the dialog
   already on the template source while their "Copy week" opens it on the week source; a placing
   supervisor is unchanged (Apply + Save, never Copy week); a viewer is offered none.
2. `npx vitest run src/test/weekTemplates.test.ts src/test/copyWeek.test.tsx` — must stay green
   unchanged. **If a case there goes red, read that case before touching your change** and say in
   writing whether the case was wrong or the contract changed (CLAUDE.md §4).
3. `npx tsc --noEmit` — report the count; ignore errors in files you do not own and say which.
4. `npx eslint src/features/board/components/BoardToolbar.tsx src/features/board/components/SaveTemplateDialog.tsx src/features/admin/components/TemplatesPanel.tsx`
5. **Drive it in a browser.** `npm run dev` is expected to be running on http://localhost:5173; if
   it is not, start it in the background and say so. Then
   `npx playwright test e2e/weekTemplates.spec.ts --project=chromium`, having updated that spec so
   the admin case reaches a template through the NEW button rather than through the Copy-week
   select. Also run `npx playwright test e2e/roleWalk.spec.ts --project=chromium` — the toolbar is
   on every role's board and this is the spec that walks the least-privileged people through it
   (CLAUDE.md §4). Paste both runners' summary lines.

## Report

Plain prose, no bullet lists. Include: the exact new predicate lines from `BoardToolbar.tsx`; the
wording you chose for the save confirmation and the panel paragraph, verbatim; every runner's own
summary line; the shape of the new prop and why an absent prop is byte-for-byte today’s behaviour; and anything
you noticed and did not fix.
