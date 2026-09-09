import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import {
  hasRealBackend,
  NO_BACKEND_REASON,
  supabaseUrl,
  supabaseAnonKey,
  e2eBaseUrl,
  mailUrl,
} from "./env";

/**
 * The INVITE loop (P1-6c, S24), driven end to end against the live local stack
 * AND the `invite` Edge Function served beside it.
 *
 * ⚠️ SKIPS WITHOUT A BACKEND, like the other signed-in specs (a skip is not a
 * pass). And ⚠️ SKIPS WHEN THE FUNCTION IS NOT SERVED, with a named reason: the
 * Edge runtime is a separate process (`supabase functions serve invite`, added
 * to `scripts/ci-e2e.sh`), and a suite that goes quiet when it is absent would
 * be pretending. It is NOT faked — the check is a live probe of the endpoint.
 *
 * ⭐ THE INVITED PERSON IS A THROWAWAY ADDRESS, invited by Dana (Plant A site
 * admin). After they set their password they hold a viewer grant on Plant A and
 * land on the board — the proof the whole chain (invite → email → password →
 * grant) is real. Nothing a demo person relies on is touched.
 */

test.skip(!hasRealBackend, NO_BACKEND_REASON);

// DEF-0026: this run's OWN mail catcher, from e2e/env.ts -- never a literal port.
const MAIL_BASE = mailUrl;
const FUNCTIONS_BASE = `${supabaseUrl.replace(/\/$/, "")}/functions/v1`;
const PASSWORD = "devpassword";

/** Is the invite function actually being served? A live probe, not a guess. */
async function functionServed(): Promise<boolean> {
  try {
    const res = await fetch(`${FUNCTIONS_BASE}/invite`, { method: "OPTIONS" });
    return res.status === 200 || res.status === 204;
  } catch {
    return false;
  }
}

/** Pull the most recent invite link for `recipient` out of the mail catcher. */
async function fetchInviteLink(recipient: string): Promise<string> {
  const mailbox = recipient.split("@")[0];
  for (let attempt = 0; attempt < 30; attempt++) {
    const body = (await mailpitBody(recipient)) ?? (await inbucketBody(mailbox));
    if (body) {
      const link = extractVerifyLink(body);
      if (link) return link;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`No invite email arrived for ${recipient} within 15s`);
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

/** The GoTrue confirmation URL (`…/auth/v1/verify?…type=invite…`) in the mail. */
function extractVerifyLink(body: string): string | null {
  const match = body.match(/https?:\/\/[^"'\s<>]*(?:verify|invite)[^"'\s<>]*/i);
  return match ? match[0].replace(/&amp;/g, "&") : null;
}

/** Sign in with supabase-js and return the access token. */
async function tokenFor(email: string): Promise<string> {
  const client = createClient(supabaseUrl, supabaseAnonKey);
  const { data, error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  expect(error, error?.message).toBeNull();
  const at = data.session?.access_token;
  expect(at, `sign-in for ${email} should return a session`).toBeTruthy();
  return at!;
}

/** Plant A's node id, read as Dana (she administers it). */
async function plantAId(danaToken: string): Promise<string> {
  const client = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${danaToken}` } },
  });
  const { data, error } = await client.from("nodes").select("id, name").is("parent_id", null);
  expect(error, error?.message).toBeNull();
  const plantA = (data ?? []).find((n) => (n.name as string).startsWith("Plant A"));
  expect(plantA, "Plant A should be readable by Dana").toBeTruthy();
  return plantA!.id as string;
}

/** A node BELOW a plant root, read as Dana (she administers Plant A). Used to
 *  make `set_site_member` refuse an ADMIN grant with `admin_below_root` — admin
 *  is a plant-root-only role. */
async function belowRootNodeId(danaToken: string): Promise<string> {
  const client = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${danaToken}` } },
  });
  const { data, error } = await client
    .from("nodes")
    .select("id, name, parent_id")
    .not("parent_id", "is", null);
  expect(error, error?.message).toBeNull();
  const child = (data ?? [])[0];
  expect(child, "Dana should read at least one node below a plant root").toBeTruthy();
  return child!.id as string;
}

/** POST the invite function with a bearer token; return the parsed body. */
async function callInvite(
  token: string,
  body: { email: string; nodeId: string; role: string },
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${FUNCTIONS_BASE}/invite`, {
    method: "POST",
    headers: {
      apikey: supabaseAnonKey,
      Authorization: `Bearer ${token}`,
      // R-366: the origin a real browser would send is wherever THIS run's
      // dev server is listening, not always 5173 — the tester's is 5174.
      Origin: e2eBaseUrl,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

/** Exchange the invite token for a session and build the URL hash it produces. */
async function inviteHash(email: string): Promise<string> {
  const link = await fetchInviteLink(email);
  const token = new URL(link).searchParams.get("token");
  expect(token, "the invite email should carry a verify token").toBeTruthy();
  const client = createClient(supabaseUrl, supabaseAnonKey);
  const verified = await client.auth.verifyOtp({ token_hash: token!, type: "invite" });
  expect(verified.error, verified.error?.message).toBeNull();
  const at = verified.data.session?.access_token;
  const rt = verified.data.session?.refresh_token;
  expect(at && rt, "verifyOtp(invite) should return a session").toBeTruthy();
  return `#access_token=${at}&refresh_token=${rt}&expires_in=3600&token_type=bearer&type=invite`;
}

test("an admin invites by email; the person sets a password and lands with their grant", async ({
  page,
}) => {
  test.skip(
    !(await functionServed()),
    `the invite function is not being served at ${FUNCTIONS_BASE}`,
  );

  const email = `invitee-${Date.now()}@example.test`;
  const newPassword = "welcome-pass-9";

  // Dana invites the throwaway address to Plant A as a viewer.
  const dana = await tokenFor("dana@example.test");
  const plantA = await plantAId(dana);
  const invited = await callInvite(dana, { email, nodeId: plantA, role: "viewer" });
  expect(invited.json.ok, JSON.stringify(invited.json)).toBe(true);
  expect(invited.json.invited).toBe(true);

  // The invited person follows the email: the set-password screen greets them
  // with the INVITE copy ("Set your password"), not the reset copy.
  await page.goto(`/reset-password${await inviteHash(email)}`);
  await expect(page.getByRole("heading", { name: "Set your password" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByLabel("New password", { exact: true })).toBeVisible({ timeout: 15_000 });
  await page.getByLabel("New password", { exact: true }).fill(newPassword);
  await page.getByLabel("Confirm new password").fill(newPassword);
  await page.getByRole("button", { name: "Set password" }).click();

  // They hold a viewer grant on Plant A, so they land on the board (NOT the
  // no-access dead-end), still signed in.
  await expect(page).toHaveURL("/", { timeout: 15_000 });
  await expect(
    page.getByRole("heading", { level: 1, name: "No access in this workspace" }),
  ).toHaveCount(0);
  // Signed in on the board, NOT the no-access dead-end (asserted above): the
  // viewer grant the invite created is what lets them through. Scoped to the
  // banner because the board shell renders its own Sign out too.
  await expect(page.getByRole("banner").getByRole("button", { name: "Sign out" })).toBeVisible({
    timeout: 15_000,
  });
});

/**
 * ⭐ A REFUSED GRANT ON A BRAND-NEW INVITE LEAVES NO ORPHANED AUTH USER.
 *
 * The brand-new branch invites the auth user (creating it and SENDING the email)
 * BEFORE `set_site_member` runs. When the grant is then refused, the fix deletes
 * the freshly-minted auth user along with the profile — otherwise an orphan who
 * has already received the invite email survives, and a later corrected invite
 * of the same address takes the "known auth user, no profile" branch and sends
 * NO fresh mail.
 *
 * ⚠️ PROVEN END TO END, not by peeking at `auth.users`: the same address invited
 * correctly afterwards must take the brand-new path (`invited: true`) AND a fresh
 * email must arrive. A left-behind auth user flips both — `invited: false`, and
 * no mail at all — which is exactly the state before the fix.
 */
test("a refused grant on a fresh invite leaves no orphan: the address invites afresh and gets mail", async () => {
  test.skip(
    !(await functionServed()),
    `the invite function is not being served at ${FUNCTIONS_BASE}`,
  );

  const email = `orphan-${Date.now()}@example.test`;
  const dana = await tokenFor("dana@example.test");
  const plantA = await plantAId(dana);
  const belowRoot = await belowRootNodeId(dana);

  // Dana invites the FRESH address as ADMIN at a node below the plant root. The
  // auth user is minted and the email sent, then `set_site_member` refuses the
  // admin grant (`admin_below_root`) — and the rollback must remove the auth user
  // it just created.
  const refused = await callInvite(dana, { email, nodeId: belowRoot, role: "admin" });
  expect(refused.json.ok, JSON.stringify(refused.json)).toBe(false);
  expect(refused.json.reason).toBe("grant_refused");

  // The same address, invited correctly to the plant root as a viewer, must be
  // treated as BRAND NEW again (the orphan is gone) and receive a fresh email.
  const ok = await callInvite(dana, { email, nodeId: plantA, role: "viewer" });
  expect(ok.json.ok, JSON.stringify(ok.json)).toBe(true);
  expect(
    ok.json.invited,
    "a cleaned-up address must invite afresh, not be silently adopted with no email",
  ).toBe(true);
  const link = await fetchInviteLink(email);
  expect(link, "the corrected invite must send a fresh email").toBeTruthy();
});

test("a supervisor cannot invite: the function refuses her directly", async () => {
  test.skip(
    !(await functionServed()),
    `the invite function is not being served at ${FUNCTIONS_BASE}`,
  );

  // Ana is a supervisor (Line 1) — an admin nowhere. The function refuses before
  // any email is sent. (The panel also never offers her the control; she has no
  // place to administer, which is `siteAccessInvite.test.tsx` / the panel's
  // no-place state.)
  const ana = await tokenFor("ana@example.test");
  const dana = await tokenFor("dana@example.test");
  const plantA = await plantAId(dana);
  const refused = await callInvite(ana, {
    email: `should-not-send-${Date.now()}@example.test`,
    nodeId: plantA,
    role: "viewer",
  });
  expect(refused.json.ok).toBe(false);
  expect(refused.json.reason).toBe("not_admin");
});
