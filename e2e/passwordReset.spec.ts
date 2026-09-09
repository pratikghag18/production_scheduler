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

/**
 * ⭐⭐ THE EMAILED LINK ITSELF, FOLLOWED THE WAY A BROWSER FOLLOWS IT (F-106).
 *
 * ⛔ WHY THIS EXISTS BESIDE THE TEST ABOVE, WHICH LOOKS LIKE IT ALREADY COVERS
 * THIS. It does not, and the difference is the whole bug. `recoveryHash` pulls
 * the token out of the mail and calls `verifyOtp` THROUGH THE API, then builds
 * the URL hash itself and navigates straight to `/reset-password`. So it proves
 * the reset SCREEN works while never once travelling through GoTrue's own
 * `/auth/v1/verify` redirect --- and that redirect is the only place the bug
 * lives. F-106: a `redirect_to` whose host is neither `site_url` nor on
 * `additional_redirect_urls` is rejected, GoTrue falls back to the site_url ROOT
 * and STRIPS THE PATH, and the recovery tokens land on `/` --- so the board
 * renders for someone who has not chosen the password they are now signed in
 * with, and the reset form never appears. The existing test cannot fail on that.
 *
 * ⭐ SO THIS ONE NAVIGATES TO THE RAW LINK OUT OF THE EMAIL and asserts where the
 * browser ENDS UP. It is the only case in the suite that exercises the
 * configuration rather than the code, which is what F-106 turned out to be:
 * `supabase/config.toml` lists `http://localhost:5173/**`, and that line does
 * nothing until the stack is restarted.
 *
 * ⚠️ IT ASSERTS THE PATH, NOT THE FORM ALONE. A test that only waited for the
 * password fields could pass on a redirect to `/` if the route gate happened to
 * bounce a recovery session to the reset screen --- which it deliberately does
 * (R-347's `recovery` flag is the belt to this braces). Both are wanted, and
 * they are different promises: the flag makes a stripped link recoverable, this
 * makes the link land right in the first place. Asserting the URL keeps them
 * apart, so a regression in the CONFIG cannot hide behind the flag.
 *
 * Measured both ways on 9 Sept before this was written: asking for
 * `localhost:5173/reset-password` (on the list) answers a 303 to
 * `http://localhost:5173/reset-password#access_token=...&type=recovery`, while
 * asking for an off-list host answers a 303 to `http://127.0.0.1:5173#...` ---
 * the site_url root, path gone, tokens still attached.
 */
test("the emailed reset link lands on the reset screen, not the board", async ({
  page,
  baseURL,
}) => {
  const email = `link-${Date.now()}@example.test`;
  const client = createClient(supabaseUrl, supabaseAnonKey);

  const signUp = await client.auth.signUp({ email, password: "initial-pass-1" });
  expect(signUp.error, signUp.error?.message).toBeNull();

  // The app asks for `window.location.origin + "/reset-password"`; `baseURL` IS
  // that origin under Playwright, so this is the real request rather than a
  // hard-coded copy of it that could drift from ForgotPasswordPage.
  const redirectTo = `${baseURL}/reset-password`;
  const reset = await client.auth.resetPasswordForEmail(email, { redirectTo });
  expect(reset.error, reset.error?.message).toBeNull();

  // The raw link, exactly as it appears in the mail -- no verifyOtp, no
  // hand-built hash. Everything after this is GoTrue's own redirect.
  const link = await fetchResetLink(email);

  /*
   * ⭐ ASSERT THE LINK BEFORE FOLLOWING IT, so a regression fails HERE with the
   * cause in the message rather than four steps later with a symptom. GoTrue
   * rewrites `redirect_to` in the mail itself when the host is not allowed, so
   * this one parameter IS the bug, readable without a browser. Measured under a
   * deliberately off-list host: the link comes back carrying
   * `redirect_to=http://127.0.0.1:5173` -- the site_url root, path gone.
   *
   * ⚠️ AND WITHOUT THIS THE FAILURE IS ACTIVELY MISLEADING ON THIS MACHINE.
   * Following the stripped link puts the browser on `http://127.0.0.1:5173`,
   * where Vite is not listening (it binds `localhost`), so the run dies with a
   * bare `net::ERR_CONNECTION_REFUSED` that reads like the dev server is down
   * rather than like the auth config is wrong. That is the queue entry's own
   * words for this bug -- "lands on 127.0.0.1, where the dev server does not
   * answer" -- and it is exactly the wrong place to start debugging from.
   */
  const asked = new URL(link).searchParams.get("redirect_to");
  expect(
    asked,
    `GoTrue rewrote the emailed link's redirect_to. Asked for ${redirectTo}, the mail carries ${asked}. ` +
      "That means the host is not on the auth server's allow-list, so it fell back to site_url's ROOT " +
      "and stripped the path (F-106). Check `additional_redirect_urls` in supabase/config.toml -- and " +
      "remember that line does nothing until the stack is restarted (`supabase stop && supabase start`).",
  ).toBe(redirectTo);

  await page.goto(link);

  // WHERE IT LANDED is the second assertion. A stripped path puts this on `/`.
  await expect(page).toHaveURL(/\/reset-password/, { timeout: 15_000 });
  await expect(page.getByLabel("New password", { exact: true })).toBeVisible({ timeout: 15_000 });
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
