# Production Scheduler

A multi-tenant, real-time production staffing scheduler. Supervisors see a timeline board —
schedulable units (work cells, in the default vocabulary) as rows, time as columns — and drag
across a row to assign an operator to that unit for a time window, working on a product. Multiple
supervisors can edit the same schedule simultaneously and see each other's changes live.

## Prerequisites

- Node 20 (see `.nvmrc`)
- npm
- Docker Desktop, for running Supabase locally

## Quickstart

```bash
npm ci
cp .env.example .env.local   # fill in your Supabase project URL + anon key
npm run db:start
npm run db:reset
npm run dev
```

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Start the Vite dev server |
| `npm run build` | Typecheck (project references) then build for production |
| `npm run preview` | Preview the production build locally |
| `npm run typecheck` | `tsc -b --noEmit` across the project |
| `npm run lint` | ESLint over the whole tree |
| `npm run format` | Prettier, write mode |
| `npm run format:check` | Prettier, check mode (used in CI) |
| `npm run test` | Vitest unit tests, single run |
| `npm run test:watch` | Vitest in watch mode |
| `npm run e2e` | Playwright smoke tests |
| `npm run db:start` / `db:stop` | Start/stop the local Supabase stack |
| `npm run db:reset` | Reset the local DB and re-run migrations + seed |
| `npm run db:diff` | Diff local schema changes into a new migration |
| `npm run db:push` | Push local migrations to the linked remote project |
| `npm run db:types` | Regenerate `src/lib/database.types.ts` from the local schema |

## Folder conventions

- **Feature-first.** Everything owned by one screen lives under `src/features/<feature>/`. A
  feature never imports from another feature — shared code moves up into `src/components` or
  `src/lib` instead.
- `src/lib` holds non-React modules (clients, helpers, generated types); `src/components` and
  `src/hooks` hold cross-feature presentational components and hooks.
- Full conventions, including naming rules and the `@/` path alias, live in
  [`docs/conventions.md`](docs/conventions.md).

## Where the design lives

- [`docs/design-plan.md`](docs/design-plan.md) — the decisions: data model, real-time
  architecture, roles, UI architecture, cost posture.
- [`docs/roadmap.md`](docs/roadmap.md) — current state: what's built, what's next, the phase
  plan.
