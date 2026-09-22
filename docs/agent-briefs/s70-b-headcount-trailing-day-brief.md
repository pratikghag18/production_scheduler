# S70-b — the rules read a day after a headcount's count

Read CLAUDE.md §4 and §7 (R-433, R-435) and F-182 in `docs/plan.yaml`. The bar has two readers:
the served model, and the rules in `src/lib/command/parse.ts` that answer when the model is slow
or absent. On 22 Sept the model read "make the Bracket A job on Cell 3 4 people tomorrow" as
headcount 4, tomorrow (probed with `npm run voice:probe`), and the rules refused it as `no_time`.
Every other form takes a trailing day word; the headcount form only reads one BEFORE the count
("make the Bracket A job on Cell 3 tomorrow 4 people" works).

## The change

1. `parseHeadcountRest` (grep `function parseHeadcountRest` in `parse.ts`) reads the count with
   `HEADCOUNT_TRAILING_RE` off the tail. Let a day word follow the count: strip a trailing day with
   `extractDayWord` (the shared helper every other form uses — never a second regex for a day) from
   the tail BEFORE the count is matched, then merge it with any day found before the count through
   `mergeDay`, exactly as the function already merges the body's day with the time clause's. Two
   day words that disagree stay `two_days` (F-133's rule); the same word twice is fine.
2. Pins in `src/test/commandParse.test.ts`, beside HC1 and HC2: a trailing "tomorrow", a trailing
   ISO date, the day before the count still working, and "tomorrow ... 4 people yesterday" refused
   as `two_days`. Keep the HC numbering.
3. `e2e/walk/sentences.ts` entry 13 may say the day after the count once the rules read it — change
   it back to the natural order and say so in the report; do NOT run the walk (the maintainer is
   using the app), the developer runs it.
4. `npx vitest run src/test/commandParse.test.ts src/test/commandPurity.test.ts
   src/test/commandResolve.test.ts`; then `npx prettier --write`, `npx eslint`, `npx tsc -b`.

## Boundaries

- You own: `src/lib/command/parse.ts`, `src/test/commandParse.test.ts`, entry 13 of
  `e2e/walk/sentences.ts`. Nothing else; `parse.ts` may import nothing at runtime
  (`commandPurity` U1).
- Do not run the full `npm run test`, the e2e suite, or the walk. Do not commit.
- Report: the diff of `parseHeadcountRest` in words, the new HC cases, the files changed from
  `git status`, and the runner output verbatim.
