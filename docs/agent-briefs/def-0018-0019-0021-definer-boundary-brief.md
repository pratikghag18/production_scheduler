# Lane brief: DEF-0018, DEF-0019, DEF-0021 — definer helpers answer only about the caller's company

You are a build lane. You own exactly these files and no others:

- `supabase/migrations/20260907000068_definer_helpers_answer_only_about_the_callers_company.sql` (new)
- `supabase/tests/73_plant_settings_test.sql` (add cases only)
- `supabase/tests/84_shift_pattern_resolves_upward_test.sql` (add cases only)
- `supabase/tests/89_week_templates_test.sql` (add cases only)

Another lane is editing `supabase/functions/invite/index.ts` and its tests at the same time. Do not
touch them; ignore anything about DEF-0020. Do not run the full `npm run test`; run the named pins.
Do not run `npm run db:reset` (the maintainer is using the app). Do not commit.

Read first, in this order: `CLAUDE.md` §4 (every line about migrations and definers), then
`docs/defects/DEF-0018.md`, `DEF-0019.md`, `DEF-0021.md` in full, then the last definition of each
of the four functions you will re-emit (`grep -in "function \(public\.\)\?<name>(" supabase/migrations/*.sql`,
LAST hit: `app_resolve_node_setting` is 0050, `resolve_shift_template` is 0061,
`rename_week_template` and `delete_week_template` are 0067). Read 0061's header whole: it is the
reasoning you are correcting, and the header of 0068 must say why.

## The rule (R-341)

A SECURITY DEFINER helper that takes a node or row id answers, for a row in another company and
for a uuid that exists nowhere, the same thing. `app_node_exists_in_org` (0020) is the model.

## The decision already made — do not re-litigate it

**The owner exemption is keyed on `auth.uid() IS NULL`, not on `app_current_org() IS NULL` and
not on `session_user`.**

- `app_current_org() IS NULL` is what 0061 used and is DEF-0019: it is also true for every signed-in
  session that has no `user_profiles` row yet (a fresh sign-up), which is a tenant caller and must
  be bounded.
- `session_user` is ruled out by migration 0020's own note (grep `session_user` in
  `20260826000020_site_ownership.sql`): under PostgREST it is `authenticator`, and in this repo's
  SQL harness it is the superuser, so a test keyed on it would disagree with production in the
  direction that hides the hole.
- `auth.uid() IS NULL` means "no caller identity at all": the seed, a superuser psql session, a
  suite case after `RESET ROLE` with the claim cleared. That is exactly how 84's ST4 already
  produces owner context (`set_config('request.jwt.claim.sub','',true)`), and how 30_shifts Case
  18a-c and 56_delete D24 reach the resolver. A PostgREST `authenticated` session always carries a
  `sub`; `anon` is revoked from every one of these functions and stays revoked.

Write the predicate the same way in every function you touch, so the two resolvers cannot drift:

    (auth.uid() IS NULL OR target.org_id = app_current_org())

Check the harness note at the top of `supabase/tests/00_harness.sql` about `auth.uid()` before you
rely on it; all four of these functions are DEFINER, and `app_current_profile_id` (0018) already
calls `auth.uid()` from a DEFINER body, so it is the established path. If the note says something
that breaks this shape, stop and say so in your report rather than picking a third shape.

## What 0068 does

One migration, append-only, four `CREATE OR REPLACE`s, each **extracted from its last definition**
(slice the body out of the file with a script, apply the minimal edit, and assert on the assembled
text that every clause you expect is present exactly once before writing; 0053 retyped and dropped
a rule, DEF-0011). Signatures unchanged. Grants re-stated after each function exactly as the last
definition states them (0061 shows the pattern).

1. `app_resolve_node_setting(uuid, text)` — DEF-0018. Both branches gain the boundary: on the
   ancestor scan `WHERE (auth.uid() IS NULL OR target.org_id = app_current_org()) AND target.id = p_node_id`;
   on the company branch the same term on `n.org_id`. Result for another company's node or a bogus
   uuid: NULL, for every key (`date_format`, `eligibility_policy`, `timezone`, any future key).
2. `resolve_shift_template(uuid)` — DEF-0019. Replace `app_current_org() IS NULL` with
   `auth.uid() IS NULL` in the first predicate; nothing else moves.
3. `rename_week_template(uuid, text)` and `delete_week_template(uuid)` — DEF-0021. Add
   `AND org_id = app_current_org()` to the existence lookup so a foreign row and a bogus id both
   fall into the `no_such_template` branch. No owner exemption here: these are writers called by a
   signed-in admin, and `list_week_templates` two functions above them already carries the bare term.
   Confirm nothing in the SQL suites calls rename/delete as the owner without a claim; if something
   does, tell me rather than adding an exemption.

The header of 0068 must explain, in the repo's register (read 0061's header for the voice), why
`auth.uid()` is the key and why the two alternatives are wrong, citing 0020's note and DEF-0019.
Update each function's `COMMENT ON FUNCTION` so the last definition's comment describes the
boundary it actually has.

## Proving it

1. **The pins**, one at a time: `npx vitest run src/test/defects/DEF-0018.test.ts`, then 0019,
   then 0021. Each must go green by name. Read each pin's regex before writing the SQL so the text
   you emit is the text it looks for (DEF-0019's pin fails while the text carries
   `app_current_org() IS NULL` anywhere in the body, comments stripped).
2. **New SQL cases**, in the suites you own, each as `PASS <id>` / `FAIL <id>: <why>` notices in
   the file's own style:
   - 73: as Ana (sub `…a2`, `SET LOCAL ROLE authenticated`) the other company's root answers NULL
     for `date_format`, `eligibility_policy` and `timezone` when the owner has set all three there,
     and the same NULL for a bogus uuid; and in owner context (claim cleared) the same call answers
     the value. Also: as an `authenticated` session whose `auth.users` row has no profile, NULL.
   - 84: an `authenticated` session with no profile row (insert an `auth.users` row inside the
     savepoint, as DEF-0019's reproduction does) resolves NULL for org 2's root AND for org 1's
     Plant A. ST4 and ST5 must stay green unchanged.
   - 89: as Dana (sub `…dec1`), rename and delete of a fabricated org-2 template id raise the same
     `invalid_argument` / `no_such_template` a bogus id raises, and the row survives.
3. **The SQL suite, whole.** `bash scripts/run-sql-test.sh --rebuild` (the scratch database must
   pick up 0068), then every file in `supabase/tests/` in order:
   `for f in supabase/tests/[0-9]*_test.sql; do bash scripts/run-sql-test.sh $(basename $f) || echo "RED: $f"; done`.
   Session 87 measured 758 passed, 0 failed. Your total must be 758 plus your new cases and zero
   failed. If a pre-existing case goes red, read it before touching your fix and say in your report
   whether the case was wrong or the contract changed. 74's N7 and 85's B1 (the board as Ana) are
   the ones most likely to notice.
4. **Live.** Apply 0068 to the running local stack without a reset: `supabase migration up` from
   PowerShell (or `npx supabase migration up`); if the CLI is not on PATH say so and apply the file
   with `docker exec -i supabase_db_production_scheduler psql -U postgres -d postgres < <file>`
   and note that the migration table was not updated. Then run the three defects' **Reproduction**
   blocks verbatim (the psql heredocs) and paste the result tables into your report. DEF-0018's
   table must show NULL in the three other-org columns and the bogus column; DEF-0019's must show
   NULL for both templates; DEF-0021's two NOTICEs must be the same sentence.
5. `npm run db:types` then `npx tsc --noEmit`: no signature changed so the types file should be
   content-identical (a CRLF-only diff is the known false positive; say which you saw).
6. `e2e/roleWalk.spec.ts` (`npx playwright test e2e/roleWalk.spec.ts --project=chromium`): Ana's
   board must still carry the plant's date format, timezone, policy and shift pattern after the
   boundary. If the dev server is not running, start it (`npm run dev` in the background) and say so.

## Report

Plain prose, no bullets in the commit-message part. Include: the exact SQL text of each new
predicate; the three psql result tables; the SQL suite's totals (copied from the runner's tally
lines, never reasoned to); the vitest line for each pin; anything you found that you did not fix.
Do not edit `docs/defects/*.md` or `docs/plan.yaml`; the main session does that.
