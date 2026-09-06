import { test, expect, type Page } from "@playwright/test";
import { hasRealBackend, NO_BACKEND_REASON } from "./env";

/**
 * Copy Week (R-339 / S35), driven in a real browser against the real server.
 *
 * Same shape as `signedIn.spec.ts`: skips without a backend, signs in through
 * the real form as the dev world's own people, and asserts what is on the
 * screen. What the unit suite (`src/test/copyWeek.test.tsx`) cannot see is
 * whether `copy_week_plan` / `apply_copy_week` exist, take these arguments,
 * and answer in the shape the client parses -- that is this file's job.
 *
 * ⚠️ THE APPLY CASE WRITES TO THE DEMO DATABASE. The source is the Monday of
 * the current week (where `dev_demo.sql` puts its runs) and the target is one
 * hundred weeks later, a week nothing else touches. On a fresh seed that week
 * is clean and Apply copies at once; on a second run the rows the first run
 * left there clash, and the case answers "take the copied plan" for every
 * clash it is offered before applying -- so the flow is exercised either way
 * and the case does not go red because it was run twice. It never invents a
 * choice: it only ticks the "copied" control where the server drew one.
 *
 * ⛔ THIS FILE CANNOT PASS UNTIL MIGRATION 0055 IS APPLIED to the database
 * the run points at. Until then the plan read is refused and the dialog shows
 * that refusal, which the first case will report as a failure -- by design.
 */

test.skip(!hasRealBackend, NO_BACKEND_REASON);

const PASSWORD = "devpassword";
const SITE_ADMIN = "dana@example.test"; // role 'viewer' + an admin GRANT on Plant A
const SUPERVISOR = "ana@example.test"; // role 'supervisor', no admin grant anywhere

async function signIn(page: Page, email: string, path = "/"): Promise<void> {
  await page.goto(`/sign-in?redirect=${encodeURIComponent(path)}`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(path, { timeout: 15_000 });
}

/** `YYYY-MM-DD` of the Monday of the current UTC week, plus a number of weeks. */
function mondayPlusWeeks(weeks: number): string {
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const day = new Date(today).getUTCDay();
  const sinceMonday = day === 0 ? 6 : day - 1;
  const monday = today - sinceMonday * 86_400_000 + weeks * 7 * 86_400_000;
  return new Date(monday).toISOString().slice(0, 10);
}

test("a plant admin opens Copy week for her plant and reads the counts", async ({ page }) => {
  await signIn(page, SITE_ADMIN, "/");
  await page.getByRole("button", { name: "Copy week" }).click({ timeout: 15_000 });
  const dialog = page.getByRole("dialog", { name: "Copy week" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Plant A")).toBeVisible();
  // The counts sentence, whatever the numbers are this week. A refusal would
  // render as role=alert instead, and that is the failure this case exists for.
  await expect(dialog.getByText(/copies cleanly|copy cleanly|nothing to copy/)).toBeVisible({
    timeout: 15_000,
  });
  await expect(dialog.getByRole("alert")).toHaveCount(0);
});

test("a plant admin applies the copy onto a week nothing else touches", async ({ page }) => {
  await signIn(page, SITE_ADMIN, "/");
  await page.getByRole("button", { name: "Copy week" }).click({ timeout: 15_000 });
  const dialog = page.getByRole("dialog", { name: "Copy week" });
  await dialog.getByLabel("Copy the week starting").fill(mondayPlusWeeks(0));
  await dialog.getByLabel("Into the week starting").fill(mondayPlusWeeks(100));
  await expect(dialog.getByText(/copies cleanly|copy cleanly|nothing to copy/)).toBeVisible({
    timeout: 15_000,
  });

  // A second run finds the first run's rows in the target week. Take the
  // copied plan wherever the server offered it; keep the prior plan where it
  // offered only that. Never a choice the screen did not draw.
  const groups = dialog.getByRole("group");
  const count = await groups.count();
  for (let i = 0; i < count; i++) {
    const group = groups.nth(i);
    const copied = group.getByRole("radio", { name: "Take the copied plan" });
    if ((await copied.count()) > 0) await copied.check();
    else await group.getByRole("radio", { name: "Keep the prior plan" }).check();
  }

  const apply = dialog.getByRole("button", { name: /^Apply/ });
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await expect(page.getByRole("status")).toContainText(/Copied|Nothing was copied/);
});

test("a supervisor with no admin grant is not offered Copy week", async ({ page }) => {
  await signIn(page, SUPERVISOR, "/");
  // The board has rendered once its day controls are there.
  await expect(page.getByRole("button", { name: "Today" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Copy week" })).toHaveCount(0);
});
