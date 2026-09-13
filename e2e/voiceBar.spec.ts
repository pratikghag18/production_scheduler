import { execFileSync, spawn } from "node:child_process";
import { test, expect, type Page, type Locator } from "@playwright/test";
import { hasRealBackend, NO_BACKEND_REASON } from "./env";

/**
 * R-393's manual step, proved in a real browser against a real container.
 * GATED: needs `npm run voice:serve` and the e2e dev server started with
 * `VITE_VOICE_URL=/voice`, so this file is a no-op under CI or the tester:
 *   $env:VITE_VOICE_URL='/voice'; $env:VOICE_E2E='1'; npx playwright test e2e/voiceBar.spec.ts
 * Case 3 also stops/restarts `scheduler-voice`, so it runs only under
 * VOICE_E2E_STOP_CONTAINER=1 -- set only when nothing else (a held-out probe
 * run) is using it. `serial`: Case 3's stop must never overlap Cases 1-2.
 */
test.skip(!process.env.VOICE_E2E, "needs VOICE_E2E=1 with npm run voice:serve running");
test.skip(!hasRealBackend, NO_BACKEND_REASON);

const PASSWORD = "devpassword";
const HEALTH_URL = "http://127.0.0.1:8089/health";
// A demo person who can place, Plant A / Line 1 / Cell 1 (supabase/seed.sql).
const EMAIL = "dana@example.test";
const OPERATOR = "Operator A1";
const PRODUCT = "Housing A";
const FIXED_SENTENCE = `Assign ${OPERATOR} to ${PRODUCT} on Cell 1 in Line 1 from 9 to 11 tomorrow`;
const FREE_SENTENCE = `could you put ${OPERATOR} on ${PRODUCT} at Cell 1 tomorrow between 9 and 11`;
const READ_BY_MODEL = / · read by the model$/;
const READ_BY_RULES_OFF = / · read by the rules \(the model service is off\)$/;

/** Sign in through the real form -- copied from roleWalk.spec.ts's helper. */
async function signIn(page: Page, email: string, path = "/"): Promise<void> {
  await page.goto(`/sign-in?redirect=${encodeURIComponent(path)}`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(path, { timeout: 15_000 });
}

function statusLine(page: Page): Locator {
  return page.locator('p[aria-live="polite"]');
}

/** Sign in, wait for the board, type a sentence, press Enter. */
async function openBoardAndType(page: Page, sentence: string): Promise<void> {
  await signIn(page, EMAIL, "/");
  await expect(page.getByLabel(/press Enter to create/).first()).toBeVisible({ timeout: 20_000 });
  await page.locator("#command-bar-input").fill(sentence);
  await page.locator("#command-bar-input").press("Enter");
}

async function waitForHealth(want: boolean, timeoutMs = 30_000): Promise<void> {
  await expect(async () => {
    const ok = await fetch(HEALTH_URL)
      .then((r) => r.ok)
      .catch(() => false);
    expect(ok).toBe(want);
  }).toPass({ timeout: timeoutMs, intervals: [500] });
}

test.describe.serial("voice bar, against the real model service", () => {
  test("Case 1: a free phrasing the rules can't read is read by the model, pop-up opens preset", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await openBoardAndType(page, FREE_SENTENCE);
    // Soft/short: the first call pays the cold-cache prompt, may already be past this.
    await expect
      .soft(statusLine(page))
      .toHaveText("Reading…", { timeout: 1_500 })
      .catch(() => undefined);

    const dialog = page.getByRole("dialog", { name: "New" });
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect(dialog).toContainText(OPERATOR);
    await expect(dialog).toContainText("09:00");
    await expect(dialog).toContainText("11:00");
    await expect(statusLine(page)).toHaveText(READ_BY_MODEL);
    await dialog.getByRole("button", { name: "Cancel" }).click(); // do not create the block
  });

  test("Case 2: a fixed sentence the rules also read is, model on, still read by the model", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await openBoardAndType(page, FIXED_SENTENCE);

    const dialog = page.getByRole("dialog", { name: "New" });
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect(statusLine(page)).toHaveText(READ_BY_MODEL);
    await dialog.getByRole("button", { name: "Cancel" }).click();
  });

  test("Case 3: with the model service off, the fixed sentence is read by the rules, and says so", async ({
    page,
  }) => {
    test.skip(
      process.env.VOICE_E2E_STOP_CONTAINER !== "1",
      "container stop not requested -- unsafe while a held-out probe run may be using it",
    );
    test.setTimeout(120_000);

    // `--rm`'d by serve.mjs: a stopped container is GONE, so restarting means
    // `npm run voice:serve` again, not `docker start`.
    execFileSync("docker", ["stop", "scheduler-voice"]);
    try {
      await waitForHealth(false);
      await openBoardAndType(page, FIXED_SENTENCE);

      const dialog = page.getByRole("dialog", { name: "New" });
      await expect(dialog).toBeVisible({ timeout: 30_000 });
      await expect(statusLine(page)).toHaveText(READ_BY_RULES_OFF);
      await dialog.getByRole("button", { name: "Cancel" }).click();
    } finally {
      const opts = { detached: true, stdio: "ignore" as const, shell: true };
      spawn("npm", ["run", "voice:serve"], opts).unref();
      await waitForHealth(true, 60_000);
    }
  });
});
