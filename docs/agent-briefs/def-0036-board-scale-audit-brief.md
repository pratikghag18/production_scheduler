# DEF-0036 — The scale audit's completeness guard covers the board too (R-D84, D89)

The tester (session 181t): `src/test/scaleAudit.ts` names its surfaces in two hand-kept lists —
`CHROME_FILES` (chrome outside the fitted container: must NOT use `--ui-scale`) and
`REM_SURFACES` (admin: sizes in rem, no bare px) — and the D89 completeness walk
(`missingRemSurfaces`) covers `src/features/admin` only. So a new board stylesheet is audited only
if somebody remembers to list it, and nobody did for `OperatorPanel.module.css` (S65) and
`ShiftLayer.module.css` (S66-c). The pin `src/test/defects/DEF-0036.test.ts` asserts that
`scaleAudit.ts` names both files.

You own: `src/test/scaleAudit.ts`, `src/test/scaleAudit.test.ts`,
`src/features/board/components/OperatorPanel.module.css`,
`src/features/board/components/ShiftLayer.module.css`. Nothing else — in particular no other board
stylesheet, however tempting. Ignore `tsc` errors in files you do not own. Do not run the full
`npm run test`; run `npx vitest run src/test/scaleAudit.test.ts src/test/defects/DEF-0036.test.ts`.
No commits, no `docs/plan.yaml` edits.

## What to build

1. **The board's own classification.** Add `BOARD_SURFACE_DIR = "src/features/board"` and
   `BOARD_SCALED_SURFACES: readonly string[]` — every `*.module.css` under the board that lives
   INSIDE the fitted geometry and scales through `calc(Npx * var(--ui-scale))` (R-D84: "the board
   keeps calc(px * scale) because its geometry is computed in pixels"). Today that is every board
   module that is not in `CHROME_FILES` (`BoardToolbar` and `BoardPage` are chrome); list them by
   walking the directory once by hand, sorted. `OperatorPanel.module.css` (the rail sits beside
   the grid, its width never feeds `computeFitScale`, which takes heights only — say so in the
   comment) and `ShiftLayer.module.css` belong here.
2. **The completeness walk.** `missingBoardSurfaces(root, dir = BOARD_SURFACE_DIR, chrome =
   CHROME_FILES, scaled = BOARD_SCALED_SURFACES): string[]` — the same shape as
   `missingRemSurfaces`: every `*.module.css` under the board must be in exactly one of the two
   lists; report those in neither, AND those in both (a file cannot be chrome and scaled). Share
   the directory walk with `missingRemSurfaces` (one private `moduleCssUnder(base, rel)` helper,
   not a second copy of the loop).
3. **The scaled-surface rule.** `unscaledBoardPx(css): string[]` — like `unscaledPxLengths` but
   a px length is exempt when the SAME declaration multiplies it by `var(--ui-scale…)` inside a
   `calc(`; keep the existing exemptions (hairline `border`/`outline` widths ≤ 2px, `box-shadow`,
   `@media`, `0px`, comments stripped first, split on `;{}` only). Reuse `unscaledPxLengths`'s
   loop by lifting a shared declaration iterator rather than copying the split-and-match loop.
   `auditBoardSurfaces(root, files = BOARD_SCALED_SURFACES)` returns `{file, offenders}` per file.
4. **Run it over all the scaled surfaces and report the counts per file before changing any
   CSS.** Then: the two NEW files (`OperatorPanel`, `ShiftLayer`) must come out clean — fix their
   bare px by wrapping in `calc(Npx * var(--ui-scale, 1))`, matching the idiom the rest of each
   file already uses. In `OperatorPanel.module.css` that is `gap: 6px`, `gap: 4px`, `padding: 0
   3px`, `border-radius: 7px`, `border-radius: 4px`, `letter-spacing: 0.3px`, and the
   `.resizeHandle` `width: 8px`; for the handle, look at how `CommandLauncher.module.css` sizes its
   own resize strips (`.resizeCorner`/`.resizeTop`/`.resizeLeft`) and match that. Do not change
   any comment's meaning; the OR-3 comment explains `right: 0`, leave it. `ShiftLayer`'s `1.5px`
   dashed border is a hairline and should already pass — confirm, do not "fix" it.
   For the PRE-EXISTING scaled surfaces that have offenders, do NOT edit them: add
   `BOARD_PX_LEGACY: readonly string[]` — the files audited but allowed offenders on 21 Sept,
   with the count each had that day in a comment — following `FIELD_LEGACY` in
   `src/test/fieldStandard.test.ts` (read its header: the list may only shrink; a file leaving
   the list must be clean; a file not on the list must be clean). The two new files must not be
   on it.
5. **The cases**, in `scaleAudit.test.ts`, in its lettered style (pick a new letter, e.g. `B`):
   B1 no unaudited `*.module.css` under the board; B2 the walk can fail (drop one file from the
   scaled list and see it reported, the way the D89 case does with `ShapePicker`); B3 a file in
   both lists is reported; B4 every scaled surface not on the legacy list is clean; B5 every
   legacy file still has offenders (the list may only shrink — a clean file on it is a stale
   entry, fail with a message saying to remove it); B6 the matcher exempts `calc(6px *
   var(--ui-scale, 1))`; B7 it flags a bare `gap: 6px`; B8 a hairline border stays exempt; B9
   `BOARD_SCALED_SURFACES` is exactly the literal list (the same "exactly these files" shape as
   A10/R10, so a new board file forces the two-place edit). Update A10's comment if it explains
   why the board is not walked. Keep `CHROME_FILES` unchanged.

## Report

The per-file offender counts before any CSS change (a small table), the CSS diff for the two new
files, the final list of `BOARD_PX_LEGACY` with counts, the vitest run line copied verbatim, and
`git status --short`.
