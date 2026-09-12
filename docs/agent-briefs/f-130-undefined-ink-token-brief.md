# F-130 — sweep the undefined `--ink-1` token, and make the audit catch the next one

_Brief for one Sonnet build lane. Written 11 Sept 2026 (session 144) by the developer session
from the tree at 536dc6b. Plan entry: `docs/plan.yaml` F-130 (open), queued under R-373._

## §1. What this is

Six declarations in four CSS modules read `var(--ink-1)`; `src/styles/tokens.css` defines
`--ink` (#0b0b0b, primary text) and `--ink-2` (#52514e, secondary) and no `--ink-1`. An
undefined custom property makes `color` fall back to the inherited value, which happens to
look right on a light page and is a silent bug on any other. Every one of the six is a bold
heading or a name (`.plant`, `.name`, `.rootName`, `.rootPicker`), so the intended token is
`--ink`, the primary text colour.

The existing audit `src/test/scaleAudit.test.ts` G10 checks only `--drag-*`/`--drop-*` tokens
on the drag surfaces. Nothing checks the rest, which is why this sat unnoticed since the
templates work. The fix is the sweep AND an audit that walks every module stylesheet.

## §2. Files — exclusive to this lane

| file | change |
| --- | --- |
| `src/features/admin/components/TemplatesPanel.module.css` | lines 11, 79: `var(--ink-1)` → `var(--ink)` |
| `src/features/board/components/BoardToolbar.module.css` | lines 43, 52: same |
| `src/features/board/components/CopyWeekDialog.module.css` | line 22: same |
| `src/features/board/components/SaveTemplateDialog.module.css` | line 12: same |
| `src/test/scaleAudit.ts` | `undefinedTokens(tokensCss, sheets)` — a general matcher (§3) |
| `src/test/scaleAudit.test.ts` | G13 and G14 (§4) |

Nothing else. Do not touch `CommandBar.module.css` (its comment mentions `--ink-1` in prose
only and G13 must not flag prose). Do not add `--ink-1` to `tokens.css`.

## §3. The matcher

In `src/test/scaleAudit.ts`, beside `undefinedDragTokens`, add and export
`undefinedTokens(tokensCss: string, sheets: ReadonlyArray<{ path: string; css: string }>): string[]`:

- Strip CSS comments (`/* … */`) from every sheet first, so a token named in prose is not a
  read.
- A READ is `var(--name)` with NO fallback; `var(--name, <fallback>)` is never an offence
  (that is what a fallback is for; `--chrome-scale` is read that way on purpose).
- A DEFINITION is `--name:` at the start of a declaration, in `tokens.css` OR in the same
  sheet (a module may define its own local tokens).
- Return `"<path>: --name"` for every read with no definition, sorted, de-duplicated.
- Do not change `undefinedDragTokens`; G10/G11 stay as they are.

## §4. The cases

- **G13** "every var(--token) read without a fallback by any module stylesheet is defined in
  tokens.css or locally": glob `src/**/*.module.css` (use the same `fs`/`path` walk the file
  already uses for other directory audits — read how `REM_SURFACE_DIR` is walked; do NOT add a
  hand-kept list, so a new module is audited the day it appears), read
  `src/styles/tokens.css`, expect `[]`. Before the sweep this case must list exactly the six
  `--ink-1` reads; run it once BEFORE editing the CSS and paste that output in your report,
  then do the sweep, then it is green.
- **G14** the matcher's self-tests, in the shape of G11: a read of an undefined token is
  reported with its path; a read WITH a fallback is not; a token defined locally in the same
  sheet is not; a token that appears only inside a comment is not; the same undefined token
  read twice in one sheet is reported once.

## §5. Acceptance

1. `npx vitest run src/test/scaleAudit.test.ts` — count copied from the runner.
2. `npx tsc -b --force` clean; `npx eslint src/test/scaleAudit.ts src/test/scaleAudit.test.ts`
   clean; `npx prettier --check --end-of-line auto` on the two test files and the four CSS
   modules clean.
3. Mutation: on a scratch copy, put `var(--ink-1)` back into one of the four modules; G13
   must go red naming that path and `--ink-1`; restore from your copy (never `git checkout --`).
4. Do NOT run the full `npm run test`; do NOT commit. You have no browser: say so rather than
   describing the four surfaces; the developer session eyeballs them.

## §6. Report

Plain prose: the six edits; G13's output before the sweep, verbatim; the counts; the mutation
result; anything in this brief that was wrong when you read the tree.
