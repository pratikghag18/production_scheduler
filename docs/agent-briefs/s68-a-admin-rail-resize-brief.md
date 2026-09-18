# S68-a — the admin rail resizes and remembers: the side-panel standard's first hit (R-446)

Read R-446 in `docs/plan.yaml` and CLAUDE.md §7 (the standard as written there), then
`src/features/board/lib/panelSize.ts` (the one size module: `readPanelSize`, `writePanelSize`,
`clampPanelSize`), `src/features/board/lib/railWidth.ts` (how the operator rail wraps it for a width only,
with its own storage prefix and clamp) and `src/features/board/components/OperatorPanel.tsx` (the drag
handle with pointer capture, `onPointerDown/Move/Up/Cancel` on the handle, the CR-2 pattern), then
`src/features/admin/AdminPage.tsx` (the section `<nav` at ~689, `railToggle` ~701, the collapse state) and
`AdminPage.module.css` (`.rail { width: var(--rail-w) }` ~11, `.railCollapsed` ~25).

You own `AdminPage.tsx`, `AdminPage.module.css`, a new `src/test/adminRail.test.tsx`, and, if `railWidth.ts`
needs to become generic (a prefix argument instead of the rail's own), that file and its test
(`src/test/operatorPanel.test.tsx`'s OP cases must keep passing). Two other lanes work in
`src/features/admin/components/*` (the Operators, Shifts and Access panels) and in `BoardToolbar` at the
same time: do not touch those files; ignore tsc errors in them. No commits, no docs edits, no full
`npm run test`, no playwright.

1. The admin rail's right edge is a drag handle (same markup and pointer-capture shape as the operator
   rail's), the width clamped to [the current `--rail-w` value, 480px] and applied as an inline style on
   the rail; the collapse toggle keeps working and reopening restores the chosen width.
2. The width is remembered per person through `panelSize.ts` under the prefix `admin-rail:`, keyed by
   the signed-in user's id (find how AdminPage knows the session; the board keys by user + root path,
   the admin page has no root, so the user id alone), null key → session only.
3. Nothing else in the admin layout changes; the content column takes the remaining width as it does
   today. `scaleAudit.ts`'s rem rules for admin stylesheets apply (read its header) — the inline width
   is a px value set by the drag, like the operator rail's, which the audit already accepts.
4. Pins AR-1..AR-4 in `adminRail.test.tsx`: a drag changes the width; the width is remembered and
   restored on remount; collapse then reopen keeps it; the clamp both ways. Reuse the operator rail's
   test shape (`operatorPanel.test.tsx` OP-1..OP-4).

Then `npx vitest run src/test/adminRail.test.tsx src/test/operatorPanel.test.tsx src/test/scaleAudit.test.ts
src/test/fieldStandard.test.ts`, `npx tsc -b`, `npx eslint src/features/admin/AdminPage.tsx src/test/adminRail.test.tsx`,
`npx prettier --check` on your files. Report the pins, the runners' totals verbatim, what you changed in
`railWidth.ts` if anything, and anything the brief got wrong.
