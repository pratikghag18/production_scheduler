# Contributing

Thanks for looking. This is a personal project that is developed in the open, so the
bar for a change is "it makes the thing more correct", not "it matches a roadmap".

## Before you start

- Read [`docs/design-plan.md`](docs/design-plan.md) for the model and the decisions
  behind it, and [`docs/roadmap.md`](docs/roadmap.md) for what is actually built.
- Read [`docs/conventions.md`](docs/conventions.md) for naming, the `@/` alias, and the
  feature-first folder rule.
- For anything larger than a bug fix, **open an issue first**. Several parts of this
  codebase are the way they are because of a decision recorded in `design-plan.md`, and
  it is no fun to write a patch that argues with one by accident.

## Getting it running

```bash
npm ci
cp .env.example .env.local   # your own Supabase project URL + anon key
npm run db:start             # needs Docker Desktop
npm run db:reset
npm run dev
```

## The checks

Everything below has to pass before a pull request is mergeable — CI runs the same set:

```bash
npm run typecheck
npm run lint
npm run format:check
npm run test
npm run build
npm run e2e
```

Two notes that will save you time:

- **`src/lib/database.types.ts` is generated.** If you change a migration, run
  `npm run db:types` and commit the regenerated file in the same change. A migration and
  its types are one change, not two.
- **Database changes need database tests.** Schema and policy work goes in a new
  numbered file under `supabase/migrations/`, with cases added to `supabase/tests/`.
  `scripts/verify-db.sh` runs the SQL suite against a fresh local database.

## Authorization changes

Permission behaviour is the most load-bearing thing here. If your change touches an RLS
policy, an RPC, or anything under `src/features/admin/lib/`, the pull request should say
in plain language what the new rule is, and add a test case that fails without the
change — including the negative case, not only the positive one.

## Commits and pull requests

- One logical change per pull request.
- Describe what changed and why. If it settles a design question, say which one.
- Small, obvious fixes (typos, broken links, a clearly wrong comment) can skip the issue
  and come straight in as a pull request.

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE), the same license that covers the project.
