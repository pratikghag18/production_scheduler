import { test, expect } from "@playwright/test";

test("board loads and nav to admin works", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { level: 1, name: "Board" })).toBeVisible();

  await page.getByRole("link", { name: "Admin" }).click();

  await expect(page.getByRole("heading", { level: 1, name: "Admin" })).toBeVisible();
});
