# Wave 2, lane A — password reset and change-password (P1-6d, S24)

You are one of three parallel lanes. Two other agents are editing this repo at the same time.
**Touch only the files listed under "You own" below.** Ignore `tsc`/ESLint errors in files you do
not own. Do not run the full `npm run test`; run only your own test files. Do not commit; do not
edit `docs/plan.yaml` — report your plan additions as YAML text in your final message and the
developer session will place them.

Read first: `CLAUDE.md` (all of it, it is short), `docs/plan-format.md`, the `requirements` rows
R-337 and R-338 in `docs/plan.yaml` (for the shape of a requirement row), and every file under
`src/features/auth/`. Read `src/test/authFlow.test.ts` for the test style: one plain `it()` per
case, cases lettered and numbered, no `it.each`.

## What the maintainer wants

The queue's own words: *"Same browser-only shape as the sign-in screen. One browser call, no server
piece, no migration."* Two things a person can do that they cannot do today:

1. **Forgot password.** On `/sign-in`, a "Forgot your password?" link opens a screen that takes an
   email address and sends the reset email. The screen says the same neutral sentence whether or
   not the address exists ("If that address has an account, a reset link is on its way"), because
   "no account with that email" is a leak. Clicking the link in the email lands on a screen inside
   the app that takes a new password twice and sets it. Afterwards the person is signed in and lands
   on the board.
2. **Change password.** A signed-in person changes their own password from inside the app: current
   screen or a small page reached from the shell's header, next to Sign out. New password twice,
   a sentence on success, the person stays signed in.

Nothing else: no email change, no invitations (tabled by the maintainer; do not touch), no
server-side code, no migration.

## The mechanism (Supabase, local stack)

- Request: `supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin + "/reset-password" })`.
- The local stack's `supabase/config.toml` has `site_url = "http://127.0.0.1:5173"` and the email
  goes to the local mail catcher on port 54324 (Inbucket or Mailpit depending on the CLI version;
  open `http://127.0.0.1:54324` and look). A `redirectTo` the config does not list falls back to
  `site_url`, so the link may land on `127.0.0.1:5173` rather than `localhost:5173`. That is fine
  locally. **Do not edit `supabase/config.toml`** — a change there needs the stack restarted, which
  you must not do while the maintainer is using the app.
- On landing, supabase-js reads the tokens from the URL hash (`detectSessionInUrl`), establishes a
  session, and `onAuthStateChange` fires with the `PASSWORD_RECOVERY` event. The reset page then
  calls `supabase.auth.updateUser({ password })`.
- Change password, signed in: the same `supabase.auth.updateUser({ password })`.
- Errors come back as the same `AuthErrorLike` shape `describeSignInError` already reads. Add a
  sibling describer for the new calls rather than widening the sign-in one; the sentences differ
  ("That reset link has expired. Request a new one." for an expired or already-used token, a
  weak-password message for `weak_password`/422, the rate-limit sentence for 429).

## The rules this must follow (each cost a defect before)

- **Pure first.** Every decision that can be made from plain values goes in
  `src/features/auth/lib/authFlow.ts` (or a sibling `passwordFlow.ts` you create) with no React, no
  supabase import: form validation (two fields match, minimum length — read `[auth]` in
  `supabase/config.toml` for `minimum_password_length` and use that number, defaulting to 6 if it is
  absent), the recovery-screen state machine (waiting for the token, token present, done, failed),
  and the error describers. `attemptSignIn` is the model: an `AuthLike`-style structural interface
  the test drives with a two-line fake.
- **The route gate.** `/reset-password` must sit OUTSIDE `RequireAuth`, beside `/sign-in` in
  `src/routes.tsx`, because the person arriving has a recovery session but the gate would otherwise
  redirect them or show the no-access page. `/forgot-password` likewise. The change-password page
  sits INSIDE the shell.
- **Open redirect.** Nothing new reads `?redirect=`. If you navigate after success, navigate to `/`.
- **The sign-in page's own effect** navigates away as soon as a session exists. A recovery session IS
  a session, so a person landing on `/reset-password` must not be bounced to the board before setting
  the password. Read `SignInPage.tsx`'s effect before writing the reset page and make sure the new
  page has no such effect until the password has been set.
- **`autoComplete` attributes**: `new-password` on both new-password fields, `username` on the email.
- **Say what happened in words.** Every failure is a sentence a supervisor can read, never a raw
  provider string (the `describeSignInError` contract).
- **Walk it as the least-privileged person.** Before you report done, drive change-password in the
  running app at `http://localhost:5173` as Vina (`vina@example.test`, the Plant C viewer in
  `supabase/dev_demo.sql`) and put the password BACK to `devpassword` afterwards. Use Vina and not
  Viva or Vito: another lane is driving Viva's board in the browser at the same time. The demo
  passwords are fixed and every browser spec signs in with them; a changed one breaks the whole
  suite, so restore it in a `finally` in the spec too.

## Tests

- `src/test/passwordFlow.test.ts` (vitest): the pure half. Cases: matching and non-matching
  passwords, length floor, the state machine, every describer branch, `attemptReset` and
  `attemptChange` against fakes (success, provider error, thrown network error).
- `src/test/passwordPages.test.tsx` (vitest + testing-library, the style of
  `src/test/adminNoGrants.test.tsx`): the three screens render, the forgot screen shows the neutral
  sentence on success and on "user not found" alike, the reset screen refuses to submit until the
  recovery session exists, the change screen keeps the person signed in.
- `e2e/passwordReset.spec.ts` (Playwright, the style of `e2e/signedIn.spec.ts`, skipping on
  `!hasRealBackend`): the full loop against the live stack. Read the mail catcher's HTTP API to
  fetch the reset link (Inbucket: `GET /api/v1/mailbox/<name>` then `/api/v1/mailbox/<name>/<id>`;
  Mailpit: `GET /api/v1/messages` then `/api/v1/message/<id>`; probe which one answers). Use a
  throwaway account for the reset loop: `supabase.auth.signUp` works locally with confirmations off,
  and a person with no `user_profiles` row can still complete a reset (they land on the no-access
  page afterwards, which proves the new password works). For change-password use a demo viewer and
  restore `devpassword` in a `finally`, and say in the spec's header why.
- Run `npx playwright test e2e/passwordReset.spec.ts` against the running dev server, and
  `npx playwright test e2e/roleWalk.spec.ts` afterwards to prove no demo password was left changed.

## You own (exclusive)

- `src/routes.tsx`
- `src/components/AppShell.tsx` and `AppShell.module.css` (a link to change password next to Sign out; nothing else there)
- `src/features/auth/SignInPage.tsx` (the forgot link only)
- `src/features/auth/lib/authFlow.ts` and any new `src/features/auth/lib/*.ts`
- New files under `src/features/auth/`: the three pages and their CSS Modules (one module per component)
- `src/test/authFlow.test.ts`, `src/test/passwordFlow.test.ts`, `src/test/passwordPages.test.tsx`
- `e2e/passwordReset.spec.ts`
- `e2e/smoke.spec.ts` ONLY to add one signed-out case: `/reset-password` and `/forgot-password` render without the shell and without redirecting to sign-in

You do NOT own `src/features/auth/useSession.ts`, `src/App.tsx`, `src/features/auth/RequireAuth.tsx`,
`src/features/auth/RequireAdmin.tsx` (lane B is rebuilding the session provider there), anything under
`src/features/board/` or `playwright.config.ts` (lane C). If you believe you need a change in one of
those, write what and why in your final report and stop short of making it.

## Finish

1. `npx prettier --write` on every file you touched; `npx eslint` on them; `npx vitest run src/test/authFlow.test.ts src/test/passwordFlow.test.ts src/test/passwordPages.test.tsx`; the two Playwright specs above. Paste the runners' total lines verbatim.
2. Final report, in this order: what a person can now do; the files added and changed (from `git status`, not memory); the runner lines; the walk as the viewer and what the screen showed; then the plan additions as YAML: two `requirements` rows with ids **R-347** (reset) and **R-348** (change), `stated_by: maintainer`, `source: [queue item "P1-6d password reset and change-password", session 84 conversation]`, each with `verified_by` naming your test files and cases; and a `findings` card **F-106** only if you found something that went wrong on the way (plain language, the `story` shape of F-105). Anything you could not finish, said plainly.
