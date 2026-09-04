import { test, expect } from "@playwright/test";

/**
 * The smoke test runs against DUMMY Supabase values (see `playwright.config.ts`),
 * so there is no session and no data. That is not a limitation to work around:
 * it is the one state CI can reproduce exactly, and since P1-6b it is also the
 * state that decides the ENTIRE app — the auth gate wraps the whole shell, so
 * "signed out" is not one screen among many, it is the only screen.
 *
 * ⚠️⚠️ WHY THIS FILE WAS REWRITTEN A SECOND TIME (DEF-0001). It was already
 * rewritten once, in `f2ac33d`, around a signed-out BOARD shell: three cases
 * asserting that a visitor with no session sees `<h1>Board</h1>` and is offered
 * no Admin link. P1-6b then wrapped every route in `RequireAuth` and DELETED
 * that shell — a signed-out visitor is redirected to `/sign-in` and never
 * reaches the board at all. The file kept asserting the removed screen, so all
 * three cases were red.
 *
 * ⭐ AND NOTHING CAUGHT IT FOR A WEEK, WHICH IS THE POINT WORTH KEEPING. Its own
 * header already said "a test that has never executed is not a test — it is a
 * file", about `ci.yml` triggering on a branch nobody pushed. The trigger was
 * repaired in `21c868f`; this step has still never run green in CI, and this
 * commit is what makes the first run of it mean something. The lesson repeated
 * itself one level up: a stale test is not merely useless, it is a claim about
 * the product that stopped being true and said nothing when it did.
 *
 * ⭐ WHAT THIS FILE CAN AND CANNOT REACH. With no backend there is no way to
 * hold a session, so everything below is the signed-out half: the gate, the
 * redirect, and the door it sends people to. The signed-in halves — D97's
 * "Not available" for a signed-in NON-admin, and the redirect being FOLLOWED
 * after a successful sign-in — are unreachable here and are not faked. They are
 * covered as far as they can be by `src/test/authFlow.test.ts` (the decision
 * table D1-D4 and the open-redirect guard R1-R10, in unit form) and named as a
 * gap on R-321 rather than papered over with a mocked session.
 *
 * The signed-out state is reachable with no network at all: `useSession` calls
 * `loadProfile(null)`, which returns before touching Supabase, and its
 * `.finally` clears `loading` — so `decideAuthScreen` settles on "sign-in"
 * deterministically rather than racing a request.
 */

/** Where `RequireAuth` sends a signed-out visitor who asked for `path`. */
function signInUrlFor(path: string): string {
  return `/sign-in?redirect=${encodeURIComponent(path)}`;
}

test("the shell is behind the gate: / lands on the sign-in screen", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveURL(signInUrlFor("/"));
  await expect(page.getByRole("heading", { level: 1, name: "Production Scheduler" })).toBeVisible();
  await expect(page.getByText("Sign in to continue.")).toBeVisible();

  // The real door, not a placeholder: the form a person actually signs in with.
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();

  // ⚠️ AND THE BOARD IS NOT BEHIND IT. This is the assertion the old file had
  // backwards — it waited for this heading to be VISIBLE. P1-6b removed the
  // signed-out board; if it ever comes back, this is the case that says so.
  await expect(page.getByRole("heading", { level: 1, name: "Board" })).toHaveCount(0);
});

test("the sign-in screen carries no shell: no Board or Admin link to follow", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Production Scheduler" })).toBeVisible();

  // D97's original claim — a visitor with no session is offered no Admin link —
  // is now true for a stronger reason than a conditional nav: `/sign-in` lives
  // OUTSIDE `AppShell` entirely, so there is no nav to condition. Both links are
  // asserted, because "no Admin link" would also pass on a broken page with no
  // links at all, and the Board link's absence is what says the shell is gone.
  await expect(page.getByRole("link", { name: "Admin", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Board", exact: true })).toHaveCount(0);
});

test("/admin visited directly redirects, and does not render the admin refusal", async ({
  page,
}) => {
  await page.goto("/admin");

  await expect(page).toHaveURL(signInUrlFor("/admin"));

  // ⚠️ NOT "Not available". That refusal is D97's, and it is for a signed-in
  // NON-ADMIN; a visitor with no session must never reach it, because the auth
  // gate sits above `RequireAdmin` and intercepts first. Asserting its absence
  // is asserting the ORDER of the two gates, which is the thing that would
  // silently invert if the route tree were ever rearranged.
  await expect(page.getByRole("heading", { level: 1, name: "Not available" })).toHaveCount(0);

  // And the admin screen itself is absent, not merely invisible: D97 wraps the
  // guard around the Suspense boundary so the lazy chunk is never fetched.
  await expect(page.getByRole("heading", { level: 1, name: "Hierarchy" })).toHaveCount(0);
});

test("the gate remembers the whole path, query and all", async ({ page }) => {
  // ⭐ THE `redirect` PARAM IS A PROMISE TO COME BACK, and a deep link with a
  // query is where a half-built version of it shows: `RequireAuth` writes
  // `pathname + search`, so dropping the search would lose the section a person
  // was actually going to. Signing in and being returned needs a session and is
  // not reachable here; that the destination was RECORDED is.
  await page.goto("/admin?section=shifts");

  await expect(page).toHaveURL(signInUrlFor("/admin?section=shifts"));
  await expect(page.getByRole("heading", { level: 1, name: "Production Scheduler" })).toBeVisible();
});

test("an unknown route is gated too, not 404'd to a signed-out visitor", async ({ page }) => {
  // The catch-all lives INSIDE the gate, so a signed-out visitor to a bad URL
  // is asked to sign in rather than told the page does not exist — one fewer
  // fact leaked to someone who has not identified themselves, and a check that
  // the gate really does wrap every child route rather than the ones named.
  await page.goto("/no-such-page");

  await expect(page).toHaveURL(signInUrlFor("/no-such-page"));
  await expect(page.getByRole("heading", { level: 1, name: "Not found" })).toHaveCount(0);
});
