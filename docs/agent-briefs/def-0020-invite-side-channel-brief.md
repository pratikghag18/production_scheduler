# Lane brief: DEF-0020 — the invite function says nothing about an account it cannot list

You are a build lane. You own exactly these files and no others:

- `supabase/functions/invite/index.ts`
- `e2e/invite.spec.ts` (add a case only if it can run against the local stack; otherwise leave it)

Another lane is writing migration 0068 and editing SQL suites 73, 84 and 89 at the same time. Do
not add a migration, do not run `scripts/run-sql-test.sh`, do not touch the scratch database, do
not run the full `npm run test`, never `npm run db:reset`. Do not commit.

Read first: `CLAUDE.md` §4, then `docs/defects/DEF-0020.md` in full, then the whole of
`supabase/functions/invite/index.ts` (it is short and its header is the contract), then the pin
`src/test/defects/DEF-0020.test.ts` so you know exactly what shape it asserts.

## The rule (R-351, stated by the maintainer)

"An email already in this org answers already_member; one in another org is refused and nothing is
said about the other org." The response SHAPE is the promise: a caller must not be able to tell,
from the answer alone, that an address exists somewhere in this Supabase project outside their
own company.

## The decision already made — do not re-litigate it

The tester offered two closures. Take the second: **re-derive "this account exists" from the
invite call's own failure instead of trusting `findAuthUser`'s emptiness.** The first (a
SECURITY DEFINER lookup over `auth.users`) needs a migration, and the migration lane is busy;
record it in your report as the fuller fix if you think it is, but do not build it.

Concretely, in the brand-new branch:

1. When `admin.auth.admin.inviteUserByEmail` fails with the shape GoTrue gives for an address that
   is already taken, answer exactly what the `elsewhere` branch answers:
   `{ ok: false, reason: "other_org", error: notPermitted(nodeId) }`. Find out what that shape is
   by provoking it live (the reproduction in the defect file does), and match on the stable parts:
   GoTrue's `code` (`email_exists` / `user_already_exists` where it sets one) and, for the raw
   database path the defect shows, the `"Database error saving new user"` message. Put the
   classification in one small named function at module level with a comment that quotes the
   observed shapes, so the next reader knows what was measured rather than guessed.
2. Reason this is right: `findAuthUser` answered null, so there is no auth id to look profiles up
   by, and an account whose row GoTrue's own listing cannot see and whose profile is nevertheless
   in the CALLER's org is not something any product path creates (only `seed.sql`'s fixture shim
   does, for org 2). Say this in the code comment.
3. For every OTHER `inviteUserByEmail` failure, stop passing `invErr.message` through to the
   caller: log it server-side (`console.error`) and answer the fixed
   `invalidArgument("email", "invite failed")`. The raw message is the side channel; the fixed
   text closes it for shapes nobody has measured yet. Note this in the report as a small widening
   you made on purpose.

Nothing else in the function moves. `findAuthUser` stays as it is.

## Proving it

1. Get the function served with your change. The local stack's bundled edge runtime under
   `supabase start` serves `supabase/functions/*` and may hot-reload on save; check by hitting
   `OPTIONS http://127.0.0.1:54321/functions/v1/invite` and then by provoking the changed
   behaviour. If it does not reload, run `supabase functions serve invite` in the background
   (PowerShell, or `npx supabase ...`) and say which you used. If neither works, say so plainly and
   stop; do not claim a live result you did not get.
2. `npx vitest run src/test/defects/DEF-0020.test.ts` — must go green by name, not skip. If it
   prints a skip reason, the function is not being reached; fix that first.
3. The defect's Reproduction block by hand (the `curl` as Dana against `sofia@contoso.example`):
   paste the JSON you got. Then the three neighbours, so the fix did not move them:
   - `ana@example.test` (a credentialed org-1 person) → `{ ok: true, invited: false, ... }`
     (already_member path);
   - a genuinely free address such as `nobody-<random>@example.test` → `{ ok: true, invited: true }`
     — then delete that auth user and its profile afterwards through the admin API or psql so the
     local stack is left as you found it, and say that you did;
   - Ana (not an admin anywhere) inviting anyone → `not_admin`.
4. `npx vitest run src/test/inviteFlow.test.ts src/test/siteAccessInvite.test.tsx` — the client
   side must be untouched and green.
5. `npx playwright test e2e/invite.spec.ts --project=chromium` — green or honestly skipped, and
   say which.

## Report

Plain prose. Include: the observed failure shape(s) you matched on, quoted; the JSON of each of
the four live calls; the vitest lines; the playwright line; anything you found that you did not
fix. Do not edit `docs/defects/*.md` or `docs/plan.yaml`; the main session does that.
