import { test, expect, type Page } from "@playwright/test";
import { hasRealBackend, NO_BACKEND_REASON } from "./env";

/**
 * A viewer's board (R-346, the viewer clause; DEF-0015), driven in a real
 * browser against the real server.
 *
 * The maintainer: "for a viewer, the left panel serves no purpose, so we
 * should hide it, the only thing they see is the board." And R-239: a control
 * is never shown for something the server refuses. The demo world gained
 * three viewers on 6 Sept, one per plant, for exactly this case: Viva holds a
 * viewer grant on Plant A and nothing else.
 *
 * Same shape as `signedIn.spec.ts`: skips without a backend, signs in through
 * the real form, asserts what is on the screen.
 */

test.skip(!hasRealBackend, NO_BACKEND_REASON);

const PASSWORD = "devpassword";
const VIEWER = "viva@example.test"; // viewer grant on Plant A, nothing else

async function signIn(page: Page, email: string, path = "/"): Promise<void> {
  await page.goto(`/sign-in?redirect=${encodeURIComponent(path)}`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(path, { timeout: 15_000 });
}

/** `YYYY-MM-DD` of the Monday of the current UTC week, where the demo's runs sit. */
function mondayOfThisWeek(): string {
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const day = new Date(today).getUTCDay();
  const sinceMonday = day === 0 ? 6 : day - 1;
  return new Date(today - sinceMonday * 86_400_000).toISOString().slice(0, 10);
}

test("a viewer sees the board and nothing to pick from: no panel, no Copy week", async ({
  page,
}) => {
  await signIn(page, VIEWER, "/");
  await page.locator("#board-window-start").fill(mondayOfThisWeek());

  // The board itself, with its rows, is hers to read.
  await expect(page.getByRole("button", { name: /Operator A\d on /i }).first()).toBeVisible({
    timeout: 15_000,
  });
  // And nothing that exists to place people with.
  await expect(page.getByRole("complementary", { name: "Operators" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Copy week" })).toHaveCount(0);
});

test("a viewer cannot open the create form, and a chip opens read-only", async ({ page }) => {
  await signIn(page, VIEWER, "/");
  await page.locator("#board-window-start").fill(mondayOfThisWeek());
  const chip = page.getByRole("button", { name: /Operator A\d on /i }).first();
  await expect(chip).toBeVisible({ timeout: 15_000 });

  // Enter on a track is how a supervisor starts a placement; for a viewer it
  // does nothing at all (the quiet choice, DEF-0015).
  const track = page.getByLabel(/Cell \d+ track/).first();
  await track.focus();
  await track.press("Enter");
  await page.waitForTimeout(500);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // A chip still opens, read-only: the details and Close, no Person, no Save,
  // no Delete -- every one of which the server would refuse.
  await chip.click();
  const pop = page.getByRole("dialog").first();
  await expect(pop).toBeVisible({ timeout: 15_000 });
  await expect(pop.getByRole("button", { name: "Close" })).toBeVisible();
  await expect(pop.getByRole("button", { name: /^Save/ })).toHaveCount(0);
  await expect(pop.getByRole("button", { name: "Delete" })).toHaveCount(0);
  await expect(pop.getByLabel("Person")).toHaveCount(0);
});
