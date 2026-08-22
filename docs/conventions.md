# Folder & code conventions

Written by brief `p1-1-repo-scaffold-brief.md` §3. Keep this file in sync if a later brief changes
the rules.

- **Feature-first.** Everything owned by one screen lives under `src/features/<feature>/`. A
  feature may import from `src/lib`, `src/components`, `src/hooks`, `src/types`, and
  `src/styles` — **never from another feature**. Shared code moves *up* into `components/` or
  `lib/`, never sideways.
- `src/lib` = non-React modules (clients, pure helpers, generated types). `src/components` =
  cross-feature presentational React. `src/hooks` = cross-feature hooks.
- One CSS Module per component, colocated, named `<Component>.module.css`. Only `tokens.css` and
  `global.css` are global.
- Path alias `@/` → `src/`, configured in **both** `tsconfig.json` (`paths`) and `vite.config.ts`
  (`resolve.alias`), and in `vitest.config.ts`.
- Files: components `PascalCase.tsx`, everything else `camelCase.ts`. One React component per
  file, default-exported only for route-level pages; everything else named exports.
- Migrations are append-only (see P1-2). Never edit a migration that has run.
