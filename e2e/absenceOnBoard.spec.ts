import { test, expect, type Page } from "@playwright/test";
import { hasRealBackend, NO_BACKEND_REASON } from "./env";

/**
 * Absence on the board, driven as the real person (R-357), the follow-up to
 * lane D's Absences tab. The walk the brief names: Ana (a Line 1 supervisor)
 * records an absence for someone she can place over the shown week, opens the
 * board, and reads that the person is marked on leave — on the operator panel
 * and in the create pop-up's line before Save — then removes the absence so the
 * demo world is left as it was found.
 *
 * ⛔ SKIPS WITHOUT A BACKEND rather than failing (the discipline every signed-in
 * spec keeps): a skip is not a pass.
 *
 * ⚠️ WHAT THIS DOES NOT AUTOMATE, AND WHY. "Try to save under block" needs Plant
 * A's eligibility policy flipped to `block` and back — a write on a SHARED org
 * setting that, if the run failed between the flip and the restore, would leave
 * the demo world on `block` for everyone. That is exactly the "leave the demo
 * world as you found it" rule this file otherwise keeps, so the block refusal is
 * pinned in the unit suite instead (`absenceOnBoard.test.tsx`, AB9-block, which
 * asserts Create is disabled with no override under `block`) and was walked by
 * hand — see the lane report. This spec exercises the non-destructive half: the
 * mark and the warn-path line.
 */
test.skip(!hasRealBackend, NO_BACKEND_REASON);

const PASSWORD = "devpassword";
const SUPERVISOR = "ana@example.test"; // supervisor on Plant A / Line 1

async function signIn(page: Page, email: string, path = "/"): Promise<void> {
  await page.goto(`/sign-in?redirect=${encodeURIComponent(path)}`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(path, { timeout: 15_000 });
}

function mondayOfThisWeek(): string {
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const day = new Date(today).getUTCDay();
  const sinceMonday = day === 0 ? 6 : day - 1;
  const monday = today - sinceMonday * 86_400_000;
  return new Date(monday).toISOString().slice(0, 10);
}

/** `n` days after a `YYYY-MM-DD`, still `YYYY-MM-DD`, at explicit UTC. */
function plusDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

test("Ana records an absence and the board marks the person on leave", async ({ page }) => {
  const monday = mondayOfThisWeek();
  // An absence spanning the whole shown week, so any window the create pop-up
  // opens on it overlaps — the mark does not depend on where the shift lands.
  const from = monday;
  const to = plusDays(monday, 13);
  const reason = `E2E on-board leave ${Date.now()}`;

  // 1. Record the absence for the first person Ana may place.
  await signIn(page, SUPERVISOR, "/admin");
  await page.getByRole("button", { name: "Absences" }).click();
  await expect(page.getByRole("heading", { name: "Absences" })).toBeVisible({ timeout: 15_000 });
  await page.getByLabel("Person").selectOption({ index: 1 });
  await page.getByLabel("From").fill(from);
  await page.getByLabel("To").fill(to);
  await page.getByLabel("Reason").fill(reason);
  await page.getByRole("button", { name: "Record absence" }).click();
  const row = page.getByRole("row").filter({ hasText: reason });
  await expect(row).toBeVisible({ timeout: 15_000 });

  // 2. Open the board on that week.
  await page.goto("/");
  const firstTrack = page.getByLabel(/press Enter to create/).first();
  await expect(firstTrack).toBeVisible({ timeout: 20_000 });
  await page.locator("#board-window-start").fill(monday);
  await expect(firstTrack).toBeVisible({ timeout: 20_000 });

  // 3. The operator panel marks whoever is away this week.
  await expect(page.getByText("on leave").first()).toBeVisible({ timeout: 15_000 });

  // 4. The create pop-up names the leave BEFORE Save. Open it, choose the
  //    absent person (the option carrying the "on leave" suffix — revealing the
  //    rest of the plant if they are not a default offer on this track), and
  //    read the line. Under the demo's default policy this is a warning, so
  //    Create stays enabled.
  await firstTrack.press("Enter");
  const dialog = page.getByRole("dialog", { name: "New" });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  const direct = dialog.getByRole("button", { name: "Direct assignment" });
  if ((await direct.count()) > 0) await direct.click();

  const operator = dialog.getByLabel("Operator");
  let onLeaveOption = operator.locator("option", { hasText: "on leave" });
  if ((await onLeaveOption.count()) === 0) {
    const showOthers = dialog.getByRole("button", { name: /other people in this plant/ });
    if ((await showOthers.count()) > 0) await showOthers.click();
    onLeaveOption = operator.locator("option", { hasText: "on leave" });
  }
  await expect(onLeaveOption.first()).toHaveCount(1, { timeout: 15_000 });
  const value = await onLeaveOption.first().getAttribute("value");
  if (value !== null) await operator.selectOption(value);
  await expect(dialog.getByText(/On leave/)).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole("button", { name: "Cancel" }).click();

  // 5. Remove the absence — leave the demo world as we found it.
  await page.goto("/admin");
  await page.getByRole("button", { name: "Absences" }).click();
  const cleanupRow = page.getByRole("row").filter({ hasText: reason });
  await expect(cleanupRow).toBeVisible({ timeout: 15_000 });
  await cleanupRow.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText(reason)).toHaveCount(0, { timeout: 15_000 });
});
