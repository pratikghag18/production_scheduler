import { test, expect, type Page } from "@playwright/test";
import { hasRealBackend, NO_BACKEND_REASON } from "./env";

/**
 * Named week templates (R-356), driven in a real browser against the real
 * server. Same shape as `copyWeek.spec.ts`: skips without a backend, signs in
 * as the dev world's own people, and works on a SCRATCH week far from the demo
 * so the world is left as it was. What the unit suite cannot see is whether
 * `save_week_template` / `list_week_templates` / `copy_week_plan` with a
 * template id exist, take these arguments, and answer in the shape the client
 * parses.
 *
 * ⚠️ IT WRITES TO THE DEMO DATABASE and cleans up after itself: every template
 * is named with a per-run suffix and deleted in the admin Templates tab at the
 * end, and the apply targets a week 120 weeks out that nothing else touches.
 */

test.skip(!hasRealBackend, NO_BACKEND_REASON);

const PASSWORD = "devpassword";
const ADMIN = "dana@example.test"; // site admin of Plant A
const SUPERVISOR = "ana@example.test"; // supervisor on Plant A / Area 1 / Line 1
const VIEWER = "viva@example.test"; // viewer on Plant A

const RUN = Date.now().toString().slice(-6);
const DANA_TPL = `E2E ${RUN} admin`;
const ANA_TPL = `E2E ${RUN} sup`;

async function signIn(page: Page, email: string, path = "/"): Promise<void> {
  await page.goto(`/sign-in?redirect=${encodeURIComponent(path)}`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(path, { timeout: 15_000 });
}

function mondayPlusWeeks(weeks: number): string {
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const day = new Date(today).getUTCDay();
  const sinceMonday = day === 0 ? 6 : day - 1;
  const monday = today - sinceMonday * 86_400_000 + weeks * 7 * 86_400_000;
  return new Date(monday).toISOString().slice(0, 10);
}

async function saveTemplate(page: Page, name: string): Promise<void> {
  await page
    .getByRole("button", { name: "Save this week as a template" })
    .click({ timeout: 15_000 });
  const dialog = page.getByRole("dialog", { name: "Save this week as a template" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Template name").fill(name);
  await dialog.getByRole("button", { name: "Save template" }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
}

/** Delete a named template in the admin Templates tab (admins only). No-op if absent. */
async function deleteTemplate(page: Page, name: string): Promise<void> {
  const row = page.locator("li", { hasText: name });
  if ((await row.count()) === 0) return;
  await row.getByRole("button", { name: "Delete" }).click();
  await row.getByRole("button", { name: "Yes, delete" }).click();
  await expect(page.locator("li", { hasText: name })).toHaveCount(0, { timeout: 15_000 });
}

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  try {
    await signIn(page, ADMIN, "/admin");
    await page.getByRole("button", { name: "Templates" }).click();
    await deleteTemplate(page, DANA_TPL);
    await deleteTemplate(page, ANA_TPL);
  } finally {
    await page.close();
  }
});

test("an admin saves this week as a template and applies it through Copy Week", async ({
  page,
}) => {
  await signIn(page, ADMIN, "/");
  await saveTemplate(page, DANA_TPL);

  await page.getByRole("button", { name: "Copy week" }).click({ timeout: 15_000 });
  const dialog = page.getByRole("dialog", { name: "Copy week" });
  await expect(dialog).toBeVisible();
  // Switch the source to the template just saved.
  await dialog.getByLabel("Copy from").selectOption({ label: "a template" });
  await dialog.getByLabel("Template").selectOption({ label: DANA_TPL });
  await dialog.getByLabel("Into the week starting").fill(mondayPlusWeeks(120));
  // The same preview path, now naming the template as the source.
  await expect(dialog.getByText(new RegExp(`From the template ${DANA_TPL}`))).toBeVisible({
    timeout: 15_000,
  });
  await expect(dialog.getByRole("alert")).toHaveCount(0);

  // Settle any clash a second run leaves behind, then apply.
  const groups = dialog.getByRole("group");
  for (let i = 0; i < (await groups.count()); i++) {
    const group = groups.nth(i);
    const copied = group.getByRole("radio", { name: "Take the copied plan" });
    if ((await copied.count()) > 0) await copied.check();
    else await group.getByRole("radio", { name: "Keep the prior plan" }).check();
  }
  await dialog.getByRole("button", { name: /^Apply/ }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
});

test("a supervisor is offered the controls and only the template source", async ({ page }) => {
  await signIn(page, SUPERVISOR, "/");
  await expect(page.getByRole("button", { name: "Save this week as a template" })).toBeVisible({
    timeout: 15_000,
  });
  // "Copy week" (from another week) is admin-only; she reaches templates through
  // "Apply a template" and is never shown the week source.
  await expect(page.getByRole("button", { name: "Copy week" })).toHaveCount(0);
  // She can save (the server resolves her line up to its plant).
  await saveTemplate(page, ANA_TPL);

  await page.getByRole("button", { name: "Apply a template" }).click({ timeout: 15_000 });
  const dialog = page.getByRole("dialog", { name: "Copy week" });
  await expect(dialog).toBeVisible();
  // No "another week" source for a supervisor: the template picker is the only one.
  await expect(dialog.getByLabel("Copy from")).toHaveCount(0);
  await expect(dialog.getByLabel("Template")).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole("button", { name: "Cancel" }).click();
});

test("a viewer is offered neither control", async ({ page }) => {
  await signIn(page, VIEWER, "/");
  // Give the board a moment to resolve the (negative) place answer.
  await expect(page.getByRole("heading", { name: "Board" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Save this week as a template" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Apply a template" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Copy week" })).toHaveCount(0);
});
