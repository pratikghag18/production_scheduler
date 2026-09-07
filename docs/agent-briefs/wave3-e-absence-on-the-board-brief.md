# Wave 3, lane E — absence on the board: the screen shows what the server will refuse (R-357)

You are one of two parallel lanes. Lane C (named templates) is editing `CopyWeekDialog.tsx`,
`BoardToolbar.tsx`, `src/lib/api/copyWeek.ts`, `TemplatesPanel`, `AdminPage.tsx`'s rail and
migration 0065 at the same time. **Touch only the files listed under "You own".** Ignore
`tsc`/ESLint errors in files you do not own. Do not run the full `npm run test`; run only your own
test files. Do not commit; do not edit `docs/plan.yaml` — report your plan additions as YAML in
your final message. **Never `npm run db:reset`, `supabase stop` or `supabase start`.** You need no
migration unless `board_window` must carry absences (see 1); if it must, yours is **0067**, applied
with `psql` as session 83 did, then `npm run db:types`, and say so.

Read first: `CLAUDE.md` (all of it, and §4's "a screen that shows what the server will refuse is
worse than one that refuses what the server allows" is the whole point of this lane),
`docs/plan-format.md`, requirement **R-357** in `docs/plan.yaml` (the maintainer's decision and
what lane D shipped: read its `verified_by` and the paragraph above it), R-338 (the expired
certificate: the pattern), and migration 0066 (`absence_overlap`, the `absent` error code, the
`absence` and `absence_warnings` payload keys, the `absent` clash reason in `copy_week_plan`);
`src/lib/absence.ts` (`absenceGaps`, the client mirror) and `src/lib/api/absences.ts`
(`fetchAbsences`); `src/features/board/lib/boardIndex.ts` (`certificateGaps` and its day note),
`src/features/board/components/CreatePopover.tsx` and `AssignmentPopover.tsx` (how the
certificate gap is shown before Save and how a server refusal is described), `OperatorPanel.tsx`,
`src/lib/api/shapes.ts` (`BoardWindow` — lane B has just added `timezone`; copy that shape),
`src/lib/api/errors.ts` (how a new error code gets its sentence).

Lane D's own words on what is owed, verbatim:

1. Create and assignment pop-ups: call `absenceGaps(absences, operatorId, { start, end })` from
   `@/lib/absence` beside `certificateGaps`, and surface the returned `{ from, to, reason }`
   before Save. The board needs each person's absences: either carry them on `board_window` or
   call `fetchAbsences()`.
2. The new server error code is `absent`. `create_assignment` and `reassign_assignment` raise
   `absent` under block; under warn they return the placement with `absence: { absent, from, to,
   reason }` in the payload. `move_run` returns `absence_warnings: [{ operator_id, absence }]`
   and raises `absent` under block, listing every absent crew member.
3. Copy Week: `CopyWeekClashReason` and its parse guard must add `absent`; `copy_week_plan` emits
   `clash.reason = "absent"` with `policy`, `prior`, `choices` and an `absence` object;
   `CopyWeekDialog` needs a sentence for it. — **Item 3 belongs to lane C, which owns those two
   files and is told so in its brief. Do not touch them.**

## What to build

1. **The board knows who is away.** Decide, and say why in the code: carry the window's absences
   on `board_window` (the plant's people's absences overlapping `[p_from, p_to)`, resolved by the
   same definer that resolves everything else on the payload, parsed from ONE column constant like
   `dateFormat` and `timezone` are — migration 0067 re-emitting `board_window` from its LAST
   definition, extracted by script with the guards asserted; ⚠️ 0063 and 0066 have both re-emitted
   functions this week, so read the live definition with `pg_get_functiondef`, never a file), or a
   second query keyed like the board's. Prefer the payload: one read, one loading state, one
   answer a line supervisor can see above her grant (DEF-0016 and DEF-0017 were both a client
   resolving what only the server could).
2. **Before the save.** In `CreatePopover` and `AssignmentPopover`, beside the certificate gap: a
   line "On leave 14 Sep – 18 Sep: <reason>" when `absenceGaps` says so, under the plant's policy
   the way the certificate gap is shown (a warning with the reason box under warn, the Save
   refused in place under block — read how R-338 does it and do exactly that). The operator panel
   marks a person who is away for any part of the shown window, the way it marks an untrained one.
3. **After the save.** `absent` gets a sentence in `errors.ts`'s describer ("<name> is on leave
   14 Sep – 18 Sep: <reason>"), and the warn-path payload keys (`absence`, `absence_warnings`) are
   parsed and shown in the same toast or line the other warnings use, never a raw key.
4. **The same predicate on both sides.** `absenceGaps` is already pinned against the SQL cases by
   name; your cases pin that the pop-up shows a gap exactly when the server would warn or refuse,
   using the same fixture days as AB8 and AB8b.

## The rules

- **The screen may not offer what the server refuses, nor refuse what it allows.** Every case in
  your tests names the SQL case it mirrors.
- **Anything resolved by walking up the tree is a definer.** If the board carries absences, the
  server resolves who is visible; the client filters nothing by grant.
- **Walk it as Ana** (Line 1 supervisor): record an absence for someone homed at Line 1 for
  tomorrow (through the Absences tab), open the board, open the create pop-up on that person and
  read the line; try to save under block (set Plant A's policy to block in Settings as Dana first,
  then back); then remove the absence. Then `e2e/roleWalk.spec.ts`.

## Tests

- `src/test/absenceOnBoard.test.tsx`: the pop-ups show the gap (warn and block), the panel mark,
  the describer sentence, the payload parse; each case named after its SQL twin.
- `supabase/tests/90_board_absences_test.sql` only if 0067 exists: the payload carries the
  window's absences for a line supervisor above her grant, and nothing from another plant.
- `e2e/absenceOnBoard.spec.ts`: the walk above, skipping on `!hasRealBackend`; leave the demo
  world as you found it.

## You own (exclusive)

- `supabase/migrations/20260907000067_board_absences.sql` and `supabase/tests/90_board_absences_test.sql` (only if needed)
- `src/lib/api/shapes.ts`, `src/lib/api/errors.ts`, `src/lib/api/board.ts` or wherever `fetchBoardWindow` lives
- `src/features/board/lib/boardIndex.ts`, `src/features/board/components/CreatePopover.tsx`, `AssignmentPopover.tsx`, `OperatorPanel.tsx`, `RunPopover.tsx` and their CSS Modules, `src/features/board/BoardPage.tsx` (passing absences down only)
- `src/test/absenceOnBoard.test.tsx`, `e2e/absenceOnBoard.spec.ts`
- `src/lib/database.types.ts` via `db:types` (never hand-edit)

You do NOT own `CopyWeekDialog.tsx`, `BoardToolbar.tsx`, `copyWeek.ts` (lane C), `src/lib/absence.ts`
or `absences.ts` (lane D's, finished; read them, and if the mirror needs a change, say so),
`AbsencesPanel`, or migrations 0063–0066.

## Finish

1. `npx prettier --write` and `npx eslint` on your files; `npx vitest run` on yours plus the existing board pop-up suites; the SQL file if any; `npx playwright test e2e/absenceOnBoard.spec.ts e2e/roleWalk.spec.ts`. Paste the runners' total lines verbatim.
2. Report, in order: what a person sees before and after a save; files from `git status`; the runner lines; the payload-versus-query decision and why; the walk as Ana; then YAML: additional `verified_by` entries for **R-357** and, if 0067 exists, a note for its claim; a `findings` card **F-112** only if something went wrong. Anything unfinished, said plainly.
