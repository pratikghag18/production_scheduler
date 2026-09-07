# Wave 3, lane A — invitations (P1-6c, S24): the project's first server-side code

You are one of two parallel lanes. Another agent is editing this repo at the same time (the
board's timezone, under `src/features/board/`, `src/lib/api/shapes.ts`, the Settings panel and a
migration numbered 0063). **Touch only the files listed under "You own".** Ignore `tsc`/ESLint
errors in files you do not own. Do not run the full `npm run test`; run only your own test files.
Do not commit; do not edit `docs/plan.yaml` — report your plan additions as YAML in your final
message. **Never `npm run db:reset`, `supabase stop` or `supabase start`**: the maintainer is using
the app on this stack. Your migration is numbered **0064** (`supabase/migrations/20260907000064_*.sql`)
so it cannot collide with the other lane's 0063; apply it with `psql` against the running
container (`supabase_db_production_scheduler`) the way session 83 did, and say so.

Read first: `CLAUDE.md` (all of it), `docs/plan-format.md`, the S24 stage card in `docs/plan.yaml`
and requirements R-321, R-347, R-348; migrations 0021 (`site_membership`), 0054 (the last
`set_site_member`) and 0060 (`site_people`); `src/lib/api/access.ts`;
`src/features/admin/components/SiteAccessPanel.tsx`; `src/features/auth/SessionProvider.tsx`,
`session.ts` (`initialRecoveryFlag`) and `ResetPasswordPage.tsx`; `supabase/dev_demo.sql` §
where it creates `auth.users` rows; `scripts/ci-e2e.sh`.

## What the maintainer wants

The queue's words: *"An admin invites by email; the person sets a password and lands with their
grants."* Today a new person has to be created by hand in the database. After this lane:

1. On the Access panel, an admin searches by email. When nobody in the company matches, the
   panel offers **"Invite <email> to <this place> as viewer / supervisor / admin"** (the same
   three roles `set_site_member` accepts, gated exactly as that RPC gates them: a site admin may
   not grant company admin, admin only at a plant root, and so on — reuse the existing predicate,
   never a second copy).
2. The person receives an email with a link. The link lands on the app's set-password screen
   (the existing `/reset-password` page, whose copy reads "Set your password" when it arrived from
   an invite), they choose a password, and land on the board of the place they were granted.
3. The admin sees the person in the Access panel at once, as "invited, not yet signed in" until
   their first sign-in.

## The mechanism

`auth.admin.inviteUserByEmail` is a GoTrue admin call: it needs the service-role key, which must
never reach a browser, so this is **the project's first Supabase Edge Function**:
`supabase/functions/invite/index.ts` (Deno). Contract:

- `POST /functions/v1/invite` with the caller's bearer token and `{ email, nodeId, role }`.
- The function builds a user-scoped client from the caller's token and asks the database, AS THE
  CALLER, whether this grant is allowed: call `set_site_member` only AFTER the user exists, so the
  authorisation is the one RPC that already knows the rules. Before inviting, check the cheap
  thing as the caller (`app_is_admin_anywhere()`), so an unauthorised caller costs no email.
- With the service-role client: `inviteUserByEmail(email, { redirectTo: <origin>/reset-password })`,
  where origin comes from the request's `Origin` header checked against an allow-list (the
  `SITE_URL` env of the function, plus `http://localhost:5173` for local); then insert the
  `user_profiles` row for the caller's org with role `viewer` and `default_create_mode` as the
  demo rows use. If the email already has an auth user in this org, answer `already_member` with
  the existing id and skip the invite; if it exists in ANOTHER org, refuse (`not_permitted`,
  say nothing about the other org).
- Then, still as the caller, `set_site_member(nodeId, userId, role)`. If that refuses, the
  profile row is deleted again (service role) and the refusal is returned verbatim, in the
  `SchedulerError` shape the client already parses (`src/lib/api/errors.ts`).
- Responses: `{ ok: true, userId, invited: true|false }` or the error shape. CORS handled.
- `[functions.invite] verify_jwt = true` in `supabase/config.toml`.

Local run: `npx supabase functions serve invite --env-file supabase/functions/.env` in its own
terminal reads the running stack's service-role key from `npx supabase status`; the email lands in
the mail catcher at `http://127.0.0.1:54324`. Write the exact commands into
`supabase/functions/README.md`. Secrets never enter the repo: `.env` is gitignored (add it), the
README says what goes in it.

**The invited person's landing.** GoTrue sends an invite link with `type=invite`; supabase-js
turns it into a session and fires `SIGNED_IN`, not `PASSWORD_RECOVERY`. Widen
`initialRecoveryFlag` in `session.ts` so a `type=invite` fragment seeds the flag too (a case in
`session.test.ts` beside P5–P7), and let `ResetPasswordPage` read a `type=invite` hash as "Set your
password" copy. The gate then does what it does for a reset.

**"Invited, not yet signed in."** `auth.users.last_sign_in_at` is NULL until the first sign-in.
`site_people` already LEFT JOINs `auth.users` for the email; carry `invited_pending`
(`last_sign_in_at IS NULL`) in the same row (migration 0064 re-emits `site_people` — extract the
body from 0060 with a script and assert the guards you expect on the assembled text before
writing it, per CLAUDE.md §4), and the panel shows a small "invited" mark. `db:types` after the
migration; `tsc` is inconclusive until then.

## The rules

- **The database keeps the final say.** The function authorises nothing by itself; every grant
  goes through `set_site_member` as the caller. Pin with a SQL case that an invited user with no
  grant can read nothing (RLS as before), and with an e2e case that a supervisor cannot invite
  (the panel does not offer it, and the function refuses if called directly).
- **A write that reports success can have changed nothing.** Read the profile and the grant back
  in the function before answering ok.
- **Walk it as the least-privileged person it touches.** Invite a throwaway address as Dana
  (Plant A site admin) with role viewer, open the mail, set the password, and read the board as
  the new person: Plant A only, no panel. Then sign in as Ana (supervisor) and confirm the Access
  panel offers her no invite control.
- **CI.** `scripts/ci-e2e.sh` starts a throwaway stack; add `npx supabase functions serve` to it
  behind the same "did this script start the stack" guard, with a `.env` written from
  `supabase status`, so `e2e/invite.spec.ts` runs in CI. If that cannot be made to work in the
  time you have, the spec skips with a named reason and you say so — do not fake it.

## Tests

- `supabase/tests/86_invite_test.sql`: `site_people` carries `invited_pending`; the re-emitted
  function keeps 0060's search, limit and refusal guards (copy 0060's cases forward).
- `src/test/inviteFlow.test.ts` (vitest): the pure half in `src/features/admin/lib/invite.ts` —
  when the panel offers an invite (search by email, zero rows, caller may grant here), the role
  choices for this caller and place (reuse `siteAccess.ts`'s predicates), the request and response
  shapes, error sentences.
- `src/test/siteAccessInvite.test.tsx`: the panel shows the invite control for an admin with an
  unmatched email search and not for a matched one, and the "invited" mark on a pending row.
- `e2e/invite.spec.ts`: the loop above against `functions serve`, reading the mail catcher the way
  `e2e/passwordReset.spec.ts` does; skips with a reason if the function is not being served.

## You own (exclusive)

- `supabase/functions/**` (new), `supabase/config.toml` (the `[functions.invite]` block only), `.gitignore` (the `.env` line), `supabase/migrations/20260907000064_*.sql`, `supabase/tests/86_invite_test.sql`, `src/lib/database.types.ts` (via `npm run db:types`)
- `src/lib/api/access.ts` (additions), `src/lib/api/index.ts` (exports only), `src/features/admin/lib/invite.ts` (new), `src/features/admin/components/SiteAccessPanel.tsx` and its CSS Module
- `src/features/auth/session.ts` (`initialRecoveryFlag` only), `src/features/auth/ResetPasswordPage.tsx` (copy only), `src/test/session.test.ts` (new cases only)
- `src/test/inviteFlow.test.ts`, `src/test/siteAccessInvite.test.tsx`, `e2e/invite.spec.ts`, `scripts/ci-e2e.sh`, `supabase/functions/README.md`

You do NOT own anything under `src/features/board/`, `src/lib/api/shapes.ts`, `SettingsPanel.tsx`,
`src/features/board/lib/time.ts`, `geometry.ts`, or migration 0063 (the other lane). If you need a
change there, write what and why in your report and stop short.

## Finish

1. `npx prettier --write` and `npx eslint` on your files; `npx vitest run` on yours; the SQL file via the repo's SQL runner (read `scripts/` for how session 83 ran one file); the e2e spec against the served function. Paste the runners' total lines verbatim.
2. Report, in order: what an admin and an invited person can now do; files from `git status`; the runner lines; the walk as Dana and as the invited viewer and as Ana; the exact commands to serve the function locally; then YAML: `requirements` rows **R-351** (an admin invites by email and the person lands with their grants) and **R-352** (an invited person sets a password from the link and is "invited" in the panel until first sign-in), `stated_by: maintainer`, `source: [queue item "P1-6c invitations — an Edge Function calling auth.admin.inviteUserByEmail", session 85 conversation]`; a `findings` card **F-108** only if something went wrong. Anything unfinished, said plainly.
