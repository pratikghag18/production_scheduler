# Folder & code conventions

Written by brief `p1-1-repo-scaffold-brief.md` §3. Keep this file in sync if a later brief changes
the rules.

- **Feature-first.** Everything owned by one screen lives under `src/features/<feature>/`. A
  feature may import from `src/lib`, `src/components`, `src/hooks`, `src/types`, and
  `src/styles` — **never from another feature**. Shared code moves *up* into `components/` or `lib/`, never sideways.

  **One named exception: `src/features/auth/`.** Any feature may import session and identity
  from it. The rule exists to stop *domain* features coupling to each other — the board
  reaching into admin's internals, and vice versa. Who is signed in is not a domain concern;
  it is app-level infrastructure that every screen needs, and duplicating it per feature would
  be worse than the coupling. This is an exception by name, not a precedent: adding a second
  one requires a decision recorded in `design-plan.md`, not a judgement call at the import site.
- `src/lib` = non-React modules (clients, pure helpers, generated types). `src/components` =
  cross-feature presentational React. `src/hooks` = cross-feature hooks.
- One CSS Module per component, colocated, named `<Component>.module.css`. Only `tokens.css` and
  `global.css` are global.
- Path alias `@/` → `src/`, configured in **both** `tsconfig.json` (`paths`) and `vite.config.ts`
  (`resolve.alias`), and in `vitest.config.ts`.
- Files: components `PascalCase.tsx`, everything else `camelCase.ts`. One React component per
  file, default-exported only for route-level pages; everything else named exports.
- Migrations are append-only (see P1-2). Never edit a migration that has run.

## Design standards

These are the app-wide UI standards. Like the pop-up standard, each is enforced by an audit so it
cannot quietly drift; add a surface to the standard and the audit checks it.

- **Pop-ups go through one shell.** Every floating dialog is the shared `src/components/Popover.tsx`
  (it sets `role="dialog"` once); no component hand-rolls a dialog. Guarded by
  `src/test/popoverStandard.test.ts` (any `role="dialog"` outside the allowlisted module fails).
- **Frozen table headers (R-372).** Any tab that can list a large number of rows scrolls the rows
  **within a bounded region, not the page**, so the column header (and any header controls) stay
  frozen while the body scrolls. The recipe: the scroll container sets `overflow: auto` with a
  viewport-relative `max-height` (e.g. `min(65dvh, 44rem)`), and the header cells are
  `position: sticky; top: 0` with an opaque `background` and a `z-index` above the body. Reported
  from the running app: scrolling the Activity log made the column names disappear. **The standard is
  the behaviour, not the markup:** a read-only tabular tab satisfies it with a `<table>` and sticky
  `<th>` cells (Activity), an interactive editor with a sticky grid-header row (Access's `.head`) —
  both register the same way, so there is no need to rebuild an editor as a `<table>` to comply.
  Guarded by `src/test/stickyHeaderStandard.test.ts`, which registers each list surface (naming its
  scroll-container class and its header class) and fails if the scroll container is unbounded or the
  header is not sticky. Every current long-row admin tab is registered — Activity, Access, Operators,
  Products, Trainings, Shifts, Absences, the Matrix (whose two stacked header rows freeze as one
  `<thead>`) and Cycle times — and any new one must register there too.

## Local setup: the developer's stack and the tester's

R-366. Two knobs keep the developer's dev server/Supabase stack and the tester's apart, so a
developer's edits or fixtures never reach a tester run: `E2E_PORT` (default 5173, read in
`e2e/env.ts`) picks the Vite port `playwright.config.ts` and Vite start on, and `TESTER_STACK_DIR`
(default `<repo>/../scheduler-test-stack`) is where `scripts/tester-stack.mjs up` generates the
tester's own Supabase workdir, ports, and `project_id`; `E2E_MAIL_URL` (default the developer's
inbucket, DEF-0026) is where the email-following specs read their own run's mail. None changes
anything for the developer until exported; the tester exports what `scripts/tester-stack.mjs env`
prints.
