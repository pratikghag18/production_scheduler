# Wave 2, lane B — one SessionProvider at the root (S24 debt, now a correctness item)

You are one of three parallel lanes. Two other agents are editing this repo at the same time.
**Touch only the files listed under "You own" below.** Ignore `tsc`/ESLint errors in files you do
not own. Do not run the full `npm run test`; run only the test files named here. Do not commit; do
not edit `docs/plan.yaml` — report your plan additions as YAML text in your final message and the
developer session will place them.

Read first: `CLAUDE.md` (all of it), `docs/plan-format.md`, and in `docs/plan.yaml` the finding
whose story begins *"The first browser test that ever signed in failed on its first full run"*
(search for `useSession()` is called in five components`) and requirement R-337. Then read
`src/features/auth/useSession.ts` and `src/features/auth/session.ts` in full, `src/App.tsx`,
`src/main.tsx`, and `src/test/adminNoGrants.test.tsx` (case N8 and the `vi.mock` pattern every
admin suite uses).

## What is wrong today, in one paragraph

`useSession()` is a hook that every caller instantiates separately: `AppShell`, `AdminPage`,
`BoardPage`, `RequireAuth`, `RequireAdmin`, `SignInPage`, `DevProfileSwitcher`, every admin panel and
several hooks — around thirty call sites. Each instance runs its own `getSession()` round trip, its
own `user_profiles` read, its own `fetchAdminAnywhere()` RPC, and its own `onAuthStateChange`
listener, and each holds its own `loading` and `profile`. The identity term (`lastUserId`) was moved
to module scope in a previous session so the cache reset fires once, but the LOADING state was not:
`RequireAdmin`'s copy can resolve and mount `AdminPage` while `AdminPage`'s copy is still
`loading`, which is how a company admin saw a supervisor's three-tab rail for a beat. The guard in
`AdminPage` (R-337, pinned by N8) is the patch; **this lane is the cure**: one provider at the root,
one round trip per fact, one `loading`, one `profile`, one listener, and every `useSession()` reads
the same object from context.

## The shape

- `src/features/auth/SessionProvider.tsx`: a context provider mounted ONCE in `src/App.tsx`, inside
  `QueryClientProvider` (it needs `useQueryClient` for the identity-change reset) and outside
  `RouterProvider`. It owns everything the hook's `useEffect` does today, unchanged in behaviour:
  `getSession()` then `applyStep(…, "initial")`, the `onAuthStateChange` listener with
  `applyStep(…, "change")`, `decideSessionUpdate` as the single decision, `resetQueries()` on an
  identity change, the sequential profile-then-`adminAnywhere` read. Move the code; do not rewrite
  the decisions. The header comments in `useSession.ts` are the record of why each line is the way it
  is — carry them with the code they describe.
- `useSession()` keeps its exact signature and return type (`{ session, profile, loading }`) and
  becomes `useContext(SessionContext)`. Calling it outside the provider throws a plain error naming
  the provider, so a test that forgot to wrap says so at once.
- `lastUserId` and `__resetSessionIdentityForTests` stay module-scoped in whichever file owns the
  identity term; keep the export name so existing suites that call it keep compiling.
- **No caller changes.** Every existing `useSession()` call site stays as it is. Every suite that
  does `vi.mock("@/features/auth/useSession", …)` keeps working because it mocks the module. Do not
  touch any of those files.

## The rules

- **Behaviour is frozen; the structure moves.** Before you begin, write down the observable
  contract from the file's comments: a token refresh resets nothing and spins no loading state; a
  genuine identity change resets the query cache exactly once; a signed-out initial load still
  clears `loading`; a failed profile read gives `profile: null` and never calls the RPC; `loading`
  starts true. Then pin each of those with a test BEFORE you move the code, and watch them stay
  green after.
- **One round trip per fact, measured.** Prove the point of the change: a test that mounts the
  provider with several `useSession()` consumers and counts calls on a fake `supabase.auth` and a
  fake profile read (see how `attemptSignIn` takes a structural `AuthLike`; do the same, or
  `vi.mock("@/lib/supabase")` the way other suites do). Exactly one `getSession`, one
  `onAuthStateChange` subscription, one profile read, one `fetchAdminAnywhere`, however many consumers.
- **A green case can be pinning the bug.** If any existing case goes red under the provider, read it
  before touching the provider and say in writing whether the case was wrong or the contract changed.
- **The browser proves it.** `e2e/signedIn.spec.ts` and `e2e/roleWalk.spec.ts` are the only tests
  that ever saw two instances disagree. Run both against the live stack
  (`npx playwright test e2e/signedIn.spec.ts e2e/roleWalk.spec.ts`), three times in a row for
  `signedIn` as the finding's story asks. Then look at the board's initial load in the running app
  at `http://localhost:5173` as Ana (`ana@example.test` / `devpassword`) and as Dana and say what
  loading states you saw. The "Loading session…" flash on the board that session 57 left in place
  should now be a single flash at most, never one per screen region; if it is gone entirely, say so.
- **Do not widen the scope.** No new fields on the profile, no new RPCs, no change to
  `adminAccess`/`adminSectionsFor`/`decideAuthScreen`, no change to what `RequireAdmin` or
  `RequireAuth` render. The `AdminPage` guard (R-337) STAYS; it is correct with or without the
  provider and N8 pins it.

## Tests

- `src/test/sessionProvider.test.tsx` (vitest + testing-library): the contract cases above, lettered
  S1…, one plain `it()` per case, no `it.each`. Include the "throws outside the provider" case and
  the consumer-count case.
- Existing files you must run and keep green (do not edit them): `src/test/authFlow.test.ts`,
  `src/test/adminNoGrants.test.tsx`, `src/test/session.test.ts` if it exists, and every file that
  `vi.mock`s `useSession` — list them with
  `grep -l "features/auth/useSession" src/test/*` and run that list with `npx vitest run <files>`.

## You own (exclusive)

- `src/features/auth/useSession.ts`
- `src/features/auth/SessionProvider.tsx` (new) and, if a test needs it, `src/features/auth/session.ts` (pure additions only)
- `src/App.tsx`
- `src/test/sessionProvider.test.tsx` (new)
- `src/test/setup.ts` ONLY if a global test wrapper is the right place for the provider; say so if you do

You do NOT own `src/routes.tsx`, `src/components/AppShell.tsx`, `src/features/auth/SignInPage.tsx`,
`RequireAuth.tsx`, `RequireAdmin.tsx`, `authFlow.ts`, anything new under `src/features/auth/` that
lane A is adding (forgot/reset/change-password pages), anything under `src/features/board/`, or
`playwright.config.ts`. Lane A's new pages will call `useSession()` and must work under your provider
with no change on their side; that is the whole point of keeping the signature. If you believe you
need a change in a file you do not own, write what and why in your final report and stop short.

## Finish

1. `npx prettier --write` and `npx eslint` on your files; `npx vitest run` on your file plus the mocked list; the Playwright runs above. Paste the runners' total lines verbatim.
2. Final report, in this order: what changed for a person using the app (probably: nothing visible, one fewer flash); the files added and changed (from `git status`); the contract you pinned and whether any existing case went red and why; the round-trip count before and after, measured; the browser runs; then the plan additions as YAML: one `requirements` row with id **R-349** ("The app resolves who is signed in once, at the root, and every screen reads that one answer"), `stated_by: agent`, `source: [queue item "Debt: useSession() called in five components", the finding named above]`, `verified_by` naming your cases and the two browser specs; and a `findings` card **F-107** only if something went wrong on the way. Anything you could not finish, said plainly.
