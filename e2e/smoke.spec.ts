import { test, expect } from "@playwright/test";

/**
 * The smoke test runs against DUMMY Supabase values (see `playwright.config.ts`),
 * so there is no session and no data. That is not a limitation to work around:
 * it is the one state CI can reproduce exactly, and it is precisely the state
 * D97's admin gate exists for. So this file pins the signed-out shell and BOTH
 * halves of that gate, and asserts nothing that needs a backend.
 *
 * ⚠️ WHY IT WAS REWRITTEN. The original test clicked an "Admin" link and
 * expected an `<h1>Admin</h1>`. Both had been gone for a week:
 *   - D97 (§19.38) made the nav link conditional on
 *     `adminAccess(...) === "granted"`, so a signed-out visitor is offered no
 *     Admin link at all — `AppShell.tsx`.
 *   - P1-5d replaced the single admin heading with per-section ones
 *     (Hierarchy / Access / Shifts / Operators / Products / Import), so no
 *     `<h1>Admin</h1>` exists anywhere in `src/`.
 * Nothing caught either change, because `ci.yml` triggered on a branch nobody
 * pushed: 43 commits, zero checks. The first run this workflow ever got, it
 * failed here. A test that has never executed is not a test — it is a file.
 *
 * The signed-out state is reachable with no network at all: `useSession` calls
 * `loadProfile(null)`, which returns before touching Supabase, and its
 * `.finally` clears `loading` — so `adminAccess(undefined, undefined, false)`
 * settles on "denied" deterministically rather than racing a request.
 */

test("the shell and the board render without a backend", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { level: 1, name: "Production Scheduler" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Board" })).toBeVisible();
});

test("D97: a visitor with no session is offered no Admin link", async ({ page }) => {
  await page.goto("/");

  // Wait for the board's signed-out panel FIRST. Without it, "there is no
  // Admin link" is also true for the frame in which `adminAccess` is still
  // "pending" — the assertion would pass before the thing it measures has
  // happened, which is the emptiest kind of green.
  await expect(page.getByRole("heading", { level: 1, name: "Board" })).toBeVisible();

  await expect(page.getByRole("link", { name: "Board", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Admin", exact: true })).toHaveCount(0);
});

test("D97: /admin visited directly refuses instead of rendering", async ({ page }) => {
  await page.goto("/admin");

  await expect(page.getByRole("heading", { level: 1, name: "Not available" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to Board" })).toBeVisible();

  // The refusal must not merely hide the content — the admin headings must be
  // absent, not invisible. D97's own comment says the guard wraps the Suspense
  // boundary so the lazy chunk is never fetched; this is that claim, asserted.
  await expect(page.getByRole("heading", { level: 1, name: "Hierarchy" })).toHaveCount(0);
});
