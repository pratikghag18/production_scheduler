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
