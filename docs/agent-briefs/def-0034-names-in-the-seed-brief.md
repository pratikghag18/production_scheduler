# DEF-0034 — Plant A's real names live in the demo seed (R-423 restated)

The tester (session 181t) found that every fresh stack shows Operator A1..A6: the rename script
R-423 relied on (`scripts/demo/rename-plant-a-operators.sql`) is run by no reset or e2e path, so
`e2e/linePeople.spec.ts` and `e2e/viewerBoard.spec.ts` fail on every automated run. The maintainer,
21 Sept: **"put the real names in the seed"**. So the script goes away and `supabase/dev_demo.sql`
itself names the six.

You own: `supabase/dev_demo.sql`, `supabase/tests/dev_demo_test.sql`,
`scripts/demo/rename-plant-a-operators.sql` (delete it), `src/test/defects/DEF-0034.test.ts`,
`e2e/linePeople.spec.ts`, `e2e/viewerBoard.spec.ts`, `e2e/env.ts` (comments only). Nothing else.
Ignore `tsc` errors in files you do not own. Do not run the full `npm run test`. No commits, no
`docs/plan.yaml` edits.

## What to build

1. **The seed.** `dev_demo.sql` creates the six people in the `v_letter` loop as
   `'Operator ' || v_letter || i` (line ~299), and LATER steps key on that display name: the
   trainings (lines ~354-357 and ~371, the F-181 Welding row), the schedule's assignments
   (line ~482). The home-shift pick (line ~424) keys on `employee_ref`. So the rename goes in as a
   **new section after section 6 (the week of schedule) and before section 7 (dev credentials)**,
   never inside the loop, as six `UPDATE operators SET display_name = … WHERE org_id = v_org AND
   employee_ref = 'EMP-1001'` statements (one per person; the EMP refs, not the old names, are the
   key — this seed builds fresh, so there is no "old name" to guard on). Order and names, exactly:
   EMP-1001 Sam Patel, EMP-1002 Maria Lopez, EMP-1003 John Kim, EMP-1004 Priya Shah,
   EMP-1005 Tom Baker, EMP-1006 Lena Novak. `employee_ref` is untouched (the resolver matches the
   ref field's literal contents; the deleted script's header explained this — carry that one
   sentence into the new section's comment). Add a check to the closing DO block: exactly these
   six `display_name`s exist for those six refs, else `RAISE EXCEPTION 'dev_demo: Plant A real
   names missing (R-423)'`. Say in the section comment why the rename is here and not in the loop
   (the display-name keys downstream), and that the maintainer chose the seed over a script on
   21 Sept (DEF-0034).
2. **The SQL case.** `supabase/tests/dev_demo_test.sql` runs `dev_demo.sql` as its fixture. Add one
   case in that file's own style asserting the six names on EMP-1001..EMP-1006 and that no
   operator in the demo org is named `Operator A1`..`Operator A6`. Run it:
   `bash scripts/run-sql-test.sh --demo` (it builds the demo world in ITS OWN scratch database;
   it does not touch the live one). Paste the PASS/FAIL tally.
3. **Delete the script.** `git rm scripts/demo/rename-plant-a-operators.sql`. If
   `scripts/demo/` is then empty, that is fine.
4. **The pin.** `src/test/defects/DEF-0034.test.ts` was written to the old contract (wire the
   script in). The maintainer changed the contract, so rewrite it — keep the file name and the
   `DEF-0034` describe title — to assert the NEW one statically: (a) `supabase/dev_demo.sql`
   contains all six real names and the six EMP refs; (b) `supabase/tests/dev_demo_test.sql`
   names all six (the case exists); (c) `scripts/demo/rename-plant-a-operators.sql` does NOT
   exist and no file under `scripts/`, `e2e/`, `supabase/`, `playwright.config.ts` or
   `package.json` mentions `rename-plant-a-operators` (no path depends on the deleted script).
   Put a header comment saying the contract changed on 21 Sept and why. Run only
   `npx vitest run src/test/defects/DEF-0034.test.ts`.
5. **The e2e comments.** `e2e/linePeople.spec.ts` (lines ~39-45), `e2e/viewerBoard.spec.ts`
   (lines ~49-51) and `e2e/env.ts` (line ~123) explain the old script; reword them to say the seed
   itself names the six (R-423, 21 Sept). In `viewerBoard.spec.ts` the chip regex keeps the
   `Operator A\d` alternative "for a stack seeded without that script"; that stack no longer
   exists — drop the placeholder alternative so the spec asserts the real names. Do not run the
   e2e specs; the developer resets the live database and runs them after the lanes finish.

## Report

The seed diff (the new section and the check), the `--demo` tally line copied verbatim, the pin's
run line, and `git status --short`.
