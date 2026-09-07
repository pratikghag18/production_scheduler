import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { hasRealBackend, NO_BACKEND_REASON, supabaseUrl, supabaseAnonKey } from "./env";

/**
 * The password RESET / CHANGE loop, driven end to end in a real browser against
 * the live local stack (roadmap P1-6d, S24).
 *
 * ⚠️ SKIPS WITHOUT A BACKEND rather than failing, the same discipline as
 * `signedIn.spec.ts`: there is nothing to sign in to on a dummy URL, and a skip
 * is honest where a fake session would not be. A skip is not a pass.
 *
 * ⭐ THE RESET LOOP USES A THROWAWAY ACCOUNT, NOT A DEMO PERSON. `signUp` works
 * locally with confirmations off (`supabase/config.toml` `enable_confirmations
 * = false`), and a user with no `user_profiles` row can still complete a reset —
 * they simply land on the no-access dead-end afterwards, which is the proof the
 * new password and the recovery session are real. Nothing a demo person relies
 * on is touched.
 *
 * ⚠️⚠️ THE CHANGE-PASSWORD LOOP TOUCHES A DEMO VIEWER (Vina, Plant C), because
 * the brief requires the least-privileged walk. The demo passwords are FIXED —
 * every browser spec signs in with `devpassword` — so a changed one breaks the
 * whole suite. This restores `devpassword` in a `finally` through a fresh admin-
 * anon client that will authenticate with whichever password is currently set,
 * so the demo world is left exactly as it was even if a UI step fails midway.
 * Vina, not Viva or Vito: another lane is driving Viva's board in the browser at
 * the same time.
 */

test.skip(!hasRealBackend, NO_BACKEND_REASON);

const PASSWORD = "devpassword";
const VIEWER = "vina@example.test"; // Plant C viewer — the least-privileged demo person
const MAIL_BASE = "http://127.0.0.1:54324";

/** Sign in through the real form and wait for the redirect to be FOLLOWED. */
async function signIn(page: Page, email: string, password: string, path = "/"): Promise<void> {
  await page.goto(`/sign-in?redirect=${encodeURIComponent(path)}`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(path, { timeout: 15_000 });
}

/**
 * Pull the most recent reset link for `recipient` out of the local mail catcher.
 *
 * ⚠️ PROBES WHICH CATCHER IS RUNNING, per the brief: newer CLIs ship Mailpit
 * (`/api/v1/messages`, `/api/v1/message/<id>`), older ones Inbucket
 * (`/api/v1/mailbox/<name>`, `/api/v1/mailbox/<name>/<id>`). This tries Mailpit
 * first and falls back to Inbucket, so it keeps working across a CLI bump.
 */
async function fetchResetLink(recipient: string): Promise<string> {
  const mailbox = recipient.split("@")[0];
  for (let attempt = 0; attempt < 30; attempt++) {
    const body = (await mailpitBody(recipient)) ?? (await inbucketBody(mailbox));
    if (body) {
      const link = extractVerifyLink(body);
      if (link) return link;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`No reset email arrived for ${recipient} within 15s`);
}

async function mailpitBody(recipient: string): Promise<string | null> {
  try {
    const list = await fetch(
      `${MAIL_BASE}/api/v1/search?query=${encodeURIComponent(`to:${recipient}`)}`,
    );
    if (!list.ok) return null;
    const json = (await list.json()) as { messages?: { ID: string }[] };
    const id = json.messages?.[0]?.ID;
    if (!id) return null;
    const msg = await fetch(`${MAIL_BASE}/api/v1/message/${id}`);
    if (!msg.ok) return null;
    const parsed = (await msg.json()) as { HTML?: string; Text?: string };
    return `${parsed.Text ?? ""}\n${parsed.HTML ?? ""}`;
  } catch {
    return null;
  }
}

async function inbucketBody(mailbox: string): Promise<string | null> {
  try {
    const list = await fetch(`${MAIL_BASE}/api/v1/mailbox/${mailbox}`);
    if (!list.ok) return null;
    const json = (await list.json()) as { id: string }[];
    const id = json[json.length - 1]?.id;
    if (!id) return null;
    const msg = await fetch(`${MAIL_BASE}/api/v1/mailbox/${mailbox}/${id}`);
    if (!msg.ok) return null;
    const parsed = (await msg.json()) as { body?: { text?: string; html?: string } };
    return `${parsed.body?.text ?? ""}\n${parsed.body?.html ?? ""}`;
  } catch {
    return null;
  }
}

/** The GoTrue confirmation URL (`…/auth/v1/verify?…type=recovery…`) in the mail. */
function extractVerifyLink(body: string): string | null {
  const match = body.match(/https?:\/\/[^"'\s<>]*(?:verify|recovery)[^"'\s<>]*/i);
  return match ? match[0].replace(/&amp;/g, "&") : null;
}

/**
 * Sign a throwaway account up (no profile -- enough to prove the reset loop),
 * request its reset, and exchange the emailed one-time token for a recovery
 * session: the tokens a reset link hands the browser, returned as the URL
 * hash GoTrue's redirect produces.
 */
async function recoveryHash(email: string): Promise<string> {
  const admin = createClient(supabaseUrl, supabaseAnonKey);
  const signUp = await admin.auth.signUp({ email, password: "initial-pass-1" });
  expect(signUp.error, signUp.error?.message).toBeNull();

  const reset = await admin.auth.resetPasswordForEmail(email, {
    redirectTo: "http://localhost:5173/reset-password",
  });
  expect(reset.error, reset.error?.message).toBeNull();

  const link = await fetchResetLink(email);
  const token = new URL(link).searchParams.get("token");
  expect(token, "the reset email should carry a verify token").toBeTruthy();
  const verified = await admin.auth.verifyOtp({ token_hash: token!, type: "recovery" });
  expect(verified.error, verified.error?.message).toBeNull();
  const at = verified.data.session?.access_token;
  const rt = verified.data.session?.refresh_token;
  expect(at && rt, "verifyOtp should return a recovery session").toBeTruthy();
  return `#access_token=${at}&refresh_token=${rt}&expires_in=3600&token_type=bearer&type=recovery`;
}

test("a forgotten password is reset by email and the new one works", async ({ page }) => {
  const email = `reset-${Date.now()}@example.test`;
  const newPassword = "brand-new-pass-9";

  await page.goto(`/reset-password${await recoveryHash(email)}`);

  // The recovery session lands and the form appears. Set the new password.
  // `exact` because "New password" is a substring of "Confirm new password".
  await expect(page.getByLabel("New password", { exact: true })).toBeVisible({ timeout: 15_000 });
  await page.getByLabel("New password", { exact: true }).fill(newPassword);
  await page.getByLabel("Confirm new password").fill(newPassword);
  await page.getByRole("button", { name: "Set password" }).click();

  // Signed in with a recovery session but no profile: the no-access dead-end.
  // Reaching it at all proves updateUser succeeded on a live recovery session.
  await expect(
    page.getByRole("heading", { level: 1, name: "No access in this workspace" }),
  ).toBeVisible({ timeout: 15_000 });

  // ⭐ THE STRONGER PROOF: sign out, then sign in with the NEW password. Landing
  // on the same dead-end means the new password is the account's password now.
  await page.getByRole("button", { name: "Sign out" }).click();
  // The gate re-appends its own `?redirect=` as it re-decides, so match the path.
  await expect(page).toHaveURL(/\/sign-in/, { timeout: 15_000 });
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(newPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "No access in this workspace" }),
  ).toBeVisible({ timeout: 15_000 });
});

test("a signed-in viewer changes her own password and stays signed in", async ({ page }) => {
  const tempPassword = "vina-temp-pass-7";
  try {
    // Vina is a viewer with a profile, so she lands on the board.
    await signIn(page, VIEWER, PASSWORD, "/");

    // Reach change-password from the header link next to Sign out.
    await page.getByRole("link", { name: "Change password" }).click();
    await expect(page).toHaveURL("/change-password");

    // `exact` because "New password" is a substring of "Confirm new password".
    await page.getByLabel("New password", { exact: true }).fill(tempPassword);
    await page.getByLabel("Confirm new password").fill(tempPassword);
    await page.getByRole("button", { name: "Change password" }).click();

    // The success sentence, and — the whole point — still signed in: no redirect
    // to /sign-in, the header's Sign out is still there.
    await expect(page.getByText("Your password has been changed.")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page).toHaveURL("/change-password");
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  } finally {
    // ⚠️ ALWAYS restore devpassword, whatever happened above, so the fixed demo
    // password every other spec signs in with is left untouched. Authenticate
    // with whichever password is currently set (the temp one if the change
    // landed, the original if it did not) and put it back.
    const client = createClient(supabaseUrl, supabaseAnonKey);
    let signedIn = await client.auth.signInWithPassword({ email: VIEWER, password: tempPassword });
    if (signedIn.error) {
      signedIn = await client.auth.signInWithPassword({ email: VIEWER, password: PASSWORD });
    }
    if (!signedIn.error) {
      await client.auth.updateUser({ password: PASSWORD });
    }
    await client.auth.signOut();
  }
});

/**
 * F-106. GoTrue strips the redirect path whenever the app's origin is not the
 * project's site_url -- the local stack's `127.0.0.1` against the dev
 * server's `localhost` -- so the recovery tokens land on `/`. The route gate
 * must send that session to the reset screen rather than let it use the app
 * with a password the person never chose.
 */
test("a recovery session dropped on the board's URL is sent to the reset screen", async ({
  page,
}) => {
  const email = `reset-root-${Date.now()}@example.test`;
  const newPassword = "brand-new-pass-8";

  await page.goto(`/${await recoveryHash(email)}`);

  await expect(page).toHaveURL(/\/reset-password$/, { timeout: 15_000 });
  await expect(page.getByLabel("New password", { exact: true })).toBeVisible({ timeout: 15_000 });
  await page.getByLabel("New password", { exact: true }).fill(newPassword);
  await page.getByLabel("Confirm new password").fill(newPassword);
  await page.getByRole("button", { name: "Set password" }).click();

  // The flag drops with USER_UPDATED, so the gate now lets the person through
  // to where they belong -- the no-access dead-end for a throwaway account.
  await expect(
    page.getByRole("heading", { level: 1, name: "No access in this workspace" }),
  ).toBeVisible({ timeout: 15_000 });
});
