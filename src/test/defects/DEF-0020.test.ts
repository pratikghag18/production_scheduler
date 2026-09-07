import { describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { hasRealBackend, NO_BACKEND_REASON, supabaseUrl, supabaseAnonKey } from "../../../e2e/env";

/**
 * DEF-0020: the invite function's "say nothing about the other org" promise
 * (R-351) depends on `findAuthUser` locating the target address through
 * GoTrue's own `admin.auth.admin.listUsers`. That call only sees rows GoTrue
 * itself manages (`instance_id` set to the local instance's zero-uuid); a row
 * with a NULL `instance_id` — every seeded person in this project's org 2
 * fixture (`admin@contoso.example`, `sofia@contoso.example`), and any future
 * bulk-loaded auth row created the same way — is invisible to it. The
 * function then treats the email as brand new and calls
 * `admin.auth.admin.inviteUserByEmail`, which hits the real uniqueness
 * constraint on `auth.users.email` and answers a raw, distinguishable error
 * ("Database error saving new user") instead of the intended silent
 * `other_org` refusal — a live side channel for "does this email exist
 * ANYWHERE in this Supabase instance", exactly what R-351 says never happens.
 *
 * A live reproduction, not a unit test of a pure function: there is no pure
 * seam here (`findAuthUser` is Deno Edge Function code, calling GoTrue over
 * HTTP), so this calls the deployed function directly, the same way
 * e2e/invite.spec.ts does, and skips honestly when there is no backend to
 * call — the same discipline `hasRealBackend` gives every signed-in spec.
 *
 * Reproduction, by hand, against the running local stack:
 *   1. `docker exec -i supabase_db_production_scheduler psql -U postgres -d postgres \
 *        -c "select instance_id, email from auth.users where email='sofia@contoso.example';"`
 *      shows instance_id is NULL (and encrypted_password NULL) — a fixture
 *      shim `seed.sql` never credentialed, unlike the nine demo accounts
 *      `dev_demo.sql`'s §7 UPDATE gives real GoTrue identities.
 *   2. Sign in as dana@example.test, POST /functions/v1/invite with
 *      { email: "sofia@contoso.example", nodeId: <Plant A's id>, role: "viewer" }.
 *   3. Expected (R-351): { ok: false, reason: "other_org", ... } — nothing
 *      said about the other org.
 *   4. Actual: { ok: false, reason: "invalid", error: { message: "invalid
 *      argument", details: "...Database error saving new user..." } } — a
 *      shape a normal already-taken-elsewhere invite never produces, and a
 *      normal genuinely-free email never produces either, so the two are
 *      distinguishable from the response alone.
 */

const FUNCTIONS_BASE = `${supabaseUrl.replace(/\/$/, "")}/functions/v1`;

async function functionServed(): Promise<boolean> {
  try {
    const res = await fetch(`${FUNCTIONS_BASE}/invite`, { method: "OPTIONS" });
    return res.status === 200 || res.status === 204;
  } catch {
    return false;
  }
}

async function tokenFor(email: string, password: string): Promise<string> {
  const client = createClient(supabaseUrl, supabaseAnonKey);
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session) {
    throw new Error(`sign-in for ${email} failed: ${error?.message ?? "no session"}`);
  }
  return data.session.access_token;
}

async function plantAId(danaToken: string): Promise<string> {
  const client = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${danaToken}` } },
  });
  const { data, error } = await client.from("nodes").select("id, name").is("parent_id", null);
  if (error) throw new Error(error.message);
  const plantA = (data ?? []).find((n) => (n.name as string).startsWith("Plant A"));
  if (!plantA) throw new Error("Plant A should be readable by Dana");
  return plantA.id as string;
}

async function callInvite(
  token: string,
  body: { email: string; nodeId: string; role: string },
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${FUNCTIONS_BASE}/invite`, {
    method: "POST",
    headers: {
      apikey: supabaseAnonKey,
      Authorization: `Bearer ${token}`,
      Origin: "http://localhost:5173",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("DEF-0020: an email that belongs to another org, but whose auth row GoTrue cannot list, is not silently refused", () => {
  it("Dana inviting sofia@contoso.example (org 2) answers other_org, not a raw database error", async () => {
    if (!hasRealBackend) {
      console.warn(`DEF-0020 pin skipped: ${NO_BACKEND_REASON}`);
      return;
    }
    if (!(await functionServed())) {
      console.warn(`DEF-0020 pin skipped: the invite function is not being served at ${FUNCTIONS_BASE}`);
      return;
    }
    const dana = await tokenFor("dana@example.test", "devpassword");
    const plantA = await plantAId(dana);
    const result = await callInvite(dana, {
      email: "sofia@contoso.example",
      nodeId: plantA,
      role: "viewer",
    });
    expect(result.json.ok, JSON.stringify(result.json)).toBe(false);
    expect(
      result.json.reason,
      `R-351: "one in another org is refused and nothing is said about the other org" -- got ${JSON.stringify(result.json)}`,
    ).toBe("other_org");
  });
});
