import { test, expect, type Page } from "@playwright/test";
import { hasRealBackend, NO_BACKEND_REASON } from "./env";

/**
 * Absences on the real app, driven as the real people (R-357). The walk the
 * brief names: Ana (a Line 1 supervisor) records an absence for someone she can
 * place, sees it and removes it; Viva (a viewer) is never offered the tab; Dana
 * (a site admin) imports a CSV and reads that a bad row is refused.
 *
 * ⛔ SKIPS WITHOUT A BACKEND rather than failing — the same discipline
 * `signedIn.spec.ts` keeps: these prove nothing on a push until CI stands a
 * database up, and a skip is not a pass.
 */
test.skip(!hasRealBackend, NO_BACKEND_REASON);

const PASSWORD = "devpassword";
const SUPERVISOR = "ana@example.test"; // supervisor on Plant A / Line 1
const VIEWER = "viva@example.test"; // viewer on Plant A
const SITE_ADMIN = "dana@example.test"; // site admin on Plant A

async function signIn(page: Page, email: string, path = "/"): Promise<void> {
  await page.goto(`/sign-in?redirect=${encodeURIComponent(path)}`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(path, { timeout: 15_000 });
}

test("Ana records an absence, sees it and removes it", async ({ page }) => {
  await signIn(page, SUPERVISOR, "/admin");
  await page.getByRole("button", { name: "Absences" }).click();
  await expect(page.getByRole("heading", { name: "Absences" })).toBeVisible();

  // Pick the first real person the supervisor may place (the panel offers only
  // the people she can see) and record a distinctive absence.
  const reason = `E2E leave ${Date.now()}`;
  await page.getByLabel("Person").selectOption({ index: 1 });
  await page.getByLabel("From").fill("2027-09-14");
  await page.getByLabel("To").fill("2027-09-18");
  await page.getByLabel("Reason").fill(reason);
  await page.getByRole("button", { name: "Record absence" }).click();

  // It appears in the list…
  const row = page.getByRole("row").filter({ hasText: reason });
  await expect(row).toBeVisible({ timeout: 15_000 });

  // …and Remove takes it away again (leave the demo world as we found it).
  await row.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText(reason)).toHaveCount(0, { timeout: 15_000 });
});

test("Viva the viewer is never offered the Absences tab", async ({ page }) => {
  await signIn(page, VIEWER, "/");
  // A viewer is denied the admin screen entirely; navigating there shows no rail.
  await page.goto("/admin");
  // Either there is no admin rail at all, or if one renders it does not carry
  // Absences — both are "not offered". Assert the button is absent.
  await expect(page.getByRole("button", { name: "Absences" })).toHaveCount(0, { timeout: 15_000 });
});

test("Dana imports absences and a bad row is refused", async ({ page }) => {
  await signIn(page, SITE_ADMIN, "/admin");
  await page.getByRole("button", { name: "Import" }).click();
  await page.getByRole("tab", { name: "Absences" }).click();

  // A two-row file: one row names nobody the app can resolve (a bad row), so the
  // preview must flag at least one error regardless of the demo roster.
  const csv = [
    "Import ID,From,To,Reason",
    "NO-SUCH-IMPORT-ID,2027-09-14,2027-09-18,Annual leave",
  ].join("\n");
  await page.getByLabel("Choose a CSV file").setInputFiles({
    name: "absences.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv, "utf8"),
  });

  // The preview appears and reports the unresolved row as an error, in words.
  await expect(page.getByRole("heading", { name: "Preview" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/no person with import id/i)).toBeVisible({ timeout: 15_000 });
});
