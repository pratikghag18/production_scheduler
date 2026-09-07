# Wave 2 — the reviewer's brief

You did not write any of this. Your one job is to **break it**: find what a person using the app
would see go wrong, or what the tester will file as a defect, before it is committed. You may edit
nothing except a scratch file under your job's tmp directory; you report, and the developer session
decides. Read `CLAUDE.md` section 4 first — every line there is a way this repo has been broken
before, and several of them are exactly the shapes to look for here.

Three lanes worked in parallel from three briefs in `docs/agent-briefs/`:

- `wave2-a-password-reset-brief.md` — forgot/reset/change-password screens.
- `wave2-b-session-provider-brief.md` — one `SessionProvider` at the root; `useSession()` reads context.
- `wave2-c-touch-pass-brief.md` — a touch project in Playwright, `e2e/touch.spec.ts`, fixes as found.

Take the changed file list from `git status` and `git diff --stat`, never from the reports. The
three lanes' final reports are in the message that launched you.

## Walk in through the other door (the rule from session 83)

The developer's reviewer passed DEF-0016 and DEF-0017 because he drove the feature as the plant
admin. The tester found both by being the line supervisor. So: drive every changed screen in the
running app at `http://localhost:5173` as the LEAST-privileged person it touches, not as the admin
who built it. Demo people, all with password `devpassword`: Ana `ana@example.test` (Line 1
supervisor), Viva `viva@example.test` (Plant A viewer), Vina `vina@example.test` (Plant C viewer),
Dana `dana@example.test` (Plant A site admin), `admin@example.test` (company admin). Put any password
you change back to `devpassword` before you finish, and say that you did.

## What to try, lane by lane

**Lane A, passwords.**
- The recovery landing: does `SignInPage`'s "navigate as soon as a session exists" effect, or
  `RequireAuth`, bounce a person off `/reset-password` before they have set a password? Land on the
  reset page with a real link from the mail catcher at `http://127.0.0.1:54324` and watch.
- A recovery session is a full session. Can a person who clicked a reset link browse the whole app
  WITHOUT setting a new password? If yes, is that acceptable or a hole? Say which and why.
- Is the "forgot" screen's answer identical for a known and an unknown address, in text AND in
  timing that a person would notice?
- `sanitizeRedirect`: does any new page read `?redirect=`? Does the reset page navigate anywhere it
  should not?
- Does a viewer (Vina) reach change-password, change it, stay signed in, and get back in with the
  new password? Is the OLD password refused afterwards? Restore `devpassword`.
- Does the mail catcher API the e2e spec reads actually exist on this stack (Inbucket vs Mailpit)?
  Run `npx playwright test e2e/passwordReset.spec.ts` yourself.
- Any raw provider string reaching the screen? Any `console.error` on the happy path?

**Lane B, the provider.**
- Count the round trips yourself: open the board as Ana with the network tab, hard-reload, and
  count `user_profiles`, `app_is_admin_anywhere` and `/auth/v1/user` or `/auth/v1/token` requests.
  Report the numbers before (stash the lane's change? no — read the old code and reason) and after.
- Two consumers disagreeing was the bug. Is there any path where `RequireAdmin` admits and
  `AdminPage` still sees `loading: true`? Is there any path where the `SignInPage` (OUTSIDE
  `RequireAuth`, but is it inside the provider?) has no provider and throws?
- Lane A's new pages call `useSession()`. Are they inside the provider in the tree lane B built?
  Open `/forgot-password` and `/reset-password` signed out and look for a thrown "must be used
  within" error.
- Does a token refresh still reset nothing? Read the code; if you can, shorten nothing, just
  reason from `decideSessionUpdate`.
- Did any existing test change to make the provider pass? `git diff --stat src/test/` — a green
  case can be pinning the bug; if one was edited, read it and say whether the case was wrong or
  the contract changed.
- Sign out and sign in as a different person in the same tab: does the query cache reset exactly
  once (the board must not show the previous person's rows for even a beat)?

**Lane C, touch.**
- Run `npx playwright test --project=touch` and then `npx playwright test --project=chromium
  e2e/roleWalk.spec.ts`. Do the two projects double-run anything? Does `scripts/ci-e2e.sh` still
  run one command that covers both?
- Read the touch spec's assertions: does any case pass for the wrong reason (a drag that "did
  nothing" asserted as "refused", a scroll asserted as a drag)? Are the CDP touch sequences stepped
  through the 4 px threshold?
- A viewer's finger must start no drag. Is that asserted, and as Viva?
- If a fix landed in `useDragGesture.ts` or a block component, does the MOUSE path still behave
  (run `e2e/copyWeek.spec.ts` and `e2e/linePeople.spec.ts` on the chromium project)?
- Was the demo week left intact? Compare `roleWalk` before and after.

**Across lanes.**
- `npm run typecheck`, `npm run lint`, `npm run format:check` on the whole tree — the lanes were
  told to ignore each other's errors, so you are the first to see the union.
- Run the FULL `npm run test` once and paste the total line. Baseline before wave two was
  `Test Files 92 passed (92) / Tests 2272 passed (2272)`.
- Any file edited by two lanes? `git diff --stat` and the three "You own" lists.
- Anything a lane reported as "could not finish" or "needs a change in a file I do not own".

## Report

For each real thing you broke: what a person would see, which lane, the file and line, and the
exact steps. Then the runner lines. Then a one-line verdict per lane: ship, ship after a named
fix, or hold. Do not pad; three real findings beat ten cosmetic ones, and "nothing found" for a
lane is a valid answer when you drove it and tried.
