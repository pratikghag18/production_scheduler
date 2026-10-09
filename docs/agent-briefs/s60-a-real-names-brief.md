# S60-a — Plant A's demo people get real names (R-423)

The maintainer, 15 Sept (session 174): "the operator names being A1, A2, etc is a bit more
challenging to understand vs actual people names, should we try modifying plant A with actual
people names?" — a recogniser hears "Operator A3" as "operator a tree"; it hears "Priya Shah"
as itself. The demo operators live only in this machine's database (no seed file in the repo
creates them; the tester's worktree shares the same local database), so the rename is one SQL
script applied here plus the two e2e specs that name them.

You own `scripts/demo/rename-plant-a-operators.sql` (new), `e2e/voiceBar.spec.ts`,
`e2e/linePeople.spec.ts`, `e2e/env.ts` (one comment), and `docs/demo-data.md` if it exists (the
names table) — nothing else. Do not touch `scripts/voice/lib/pools.mjs` (the training pools keep
their own names; the model matches by words, and the resolver by the board's names).

1. The six operators with `employee_ref` EMP-1001 to EMP-1006 (display names Operator A1 to A6,
   homes Cell 1 to Cell 6) become, in that order: Sam Patel, Maria Lopez, John Kim, Priya Shah,
   Tom Baker, Lena Novak. Employee refs stay (so "A1"-style refs still resolve if anyone says
   them: check whether `employee_ref` is what the resolver matches as the ref — it is
   `EMP-1001`, so no; say so in the script's comment). The script: `UPDATE operators SET
   display_name = … WHERE employee_ref = …` six times inside one transaction, idempotent (a
   WHERE on the old name too, so running it twice changes nothing), with a comment naming R-423
   and how to apply it: `docker exec -i supabase_db_production_scheduler psql -U postgres -d
   postgres -v ON_ERROR_STOP=1 < scripts/demo/rename-plant-a-operators.sql`. Apply it here and
   show the six rows after.
2. The e2e specs: replace the name constants; keep everything else. Run `npx playwright test
   e2e/voiceBar.spec.ts e2e/linePeople.spec.ts --workers=1` against the running app and show the
   result. Then `npx playwright test e2e/roleWalk.spec.ts --workers=1` (it must still pass; it
   does not name operators, confirm).
3. `git grep -n "Operator A[1-6]"` outside `scripts/voice`, `src/test` and `docs`: anything left
   that the live app would show (a fixture the e2e load uses?) — report it; fix it only if it is
   an e2e file.
No commits, no plan edits. Report the rows after the update, the e2e results, and the grep.
