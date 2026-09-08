// ============================================================================
// invite --- the project's FIRST Supabase Edge Function (Deno). Wave 3 lane A,
// P1-6c, S24.
//
// WHY THIS IS A SERVER FUNCTION AT ALL. `auth.admin.inviteUserByEmail` is a
// GoTrue ADMIN call: it needs the service-role key, which must never reach a
// browser. So the one operation the client cannot do --- create an auth user by
// email --- lives here, behind `verify_jwt = true`, and everything that CAN be
// authorised by the database is still authorised by the database.
//
// ⭐ THE DATABASE KEEPS THE FINAL SAY. This function authorises nothing by
// itself. It does two cheap things first --- rejects a caller who is not an
// admin anywhere (`app_is_admin_anywhere()`, AS THE CALLER, so an unauthorised
// caller costs no email) --- and then the ONE grant goes through
// `set_site_member` AS THE CALLER, which already knows every rule (admin only
// at a plant root, a company admin's row is not a site admin's, and so on). If
// that RPC refuses (or its write does not read back), everything this call
// created is rolled back so nothing is left behind: the profile row is deleted,
// and when this call MINTED A BRAND-NEW AUTH USER (`invited === true`) that auth
// user is deleted too. Leaving it would strand an orphan who has ALREADY
// received the invite email — and a later, corrected invite of the same address
// would then take the "known auth user, no profile" branch and send NO fresh
// mail. A PRE-EXISTING auth user (one already in another org, or adopted here
// with no profile) is NEVER deleted — only the profile row this call inserted
// is. The refusal is returned verbatim, in the shape `src/lib/api/errors.ts`
// already parses.
//
// ⚠️ A WRITE THAT REPORTS SUCCESS CAN HAVE CHANGED NOTHING (CLAUDE.md §4). The
// profile is read back after insert (`.select()`), and the grant is read back
// after `set_site_member` returns, before this answers `ok`.
//
// CONTRACT
//   POST /functions/v1/invite
//   Authorization: Bearer <caller jwt>            (verify_jwt = true)
//   body: { email: string, nodeId: string, role: "viewer"|"supervisor"|"admin" }
//
//   200 { ok: true,  userId, invited: true }      a new person was invited
//   200 { ok: true,  userId, invited: false }     they already had an account
//                                                  (already_member, or a known
//                                                  auth user with no profile)
//   200 { ok: false, reason, error }              a refusal; `error` is a
//                                                  PostgREST-shaped object that
//                                                  `toSchedulerError` parses
//
//   reason ∈ "not_admin" | "other_org" | "invalid" | "grant_refused"
//
// ⚠️ REFUSALS RETURN HTTP 200 ON PURPOSE. `supabase.functions.invoke` hands a
// non-2xx body back only through `error.context`, which every caller would then
// have to unwrap; a 200 with `{ ok: false, error }` lets the client read the
// SchedulerError shape directly (see `src/lib/api/access.ts::invite`). A
// genuine crash still throws a 500 and reaches the client as a FunctionsError.
// ============================================================================

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// The redirect the invite email lands on is checked against this allow-list:
// the function's own SITE_URL env plus localhost for the dev server. An Origin
// that is not on the list falls back to SITE_URL (never to an attacker's host).
const LOCAL_ORIGIN = "http://localhost:5173";

type Role = "viewer" | "supervisor" | "admin";
const ROLES: readonly Role[] = ["viewer", "supervisor", "admin"];

/** A PostgREST-shaped error object `toSchedulerError` can parse. */
function notPermitted(nodeId: string) {
  return {
    code: "PT403",
    message: "not permitted",
    details: JSON.stringify({ error: "not_permitted", node_id: nodeId }),
  };
}
function invalidArgument(field: string, reason: string) {
  return {
    code: "PT400",
    message: "invalid argument",
    details: JSON.stringify({ error: "invalid_argument", field, reason }),
  };
}

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

function json(status: number, body: unknown, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
  });
}

/**
 * DEF-0020: does this `inviteUserByEmail` failure mean the address is already
 * taken somewhere in this Supabase project? Measured live against the local
 * stack on 2026-09-07:
 *
 *   - a listable, GoTrue-managed duplicate (ana@example.test) →
 *       { code: "email_exists", status: 422,
 *         message: "A user with this email address has already been registered" }
 *   - a duplicate whose auth.users row GoTrue's admin listing cannot see
 *     (sofia@contoso.example — seed.sql's org-2 fixture shim, NULL instance_id) →
 *       { name: "AuthRetryableFetchError", status: 500,
 *         message: "Database error saving new user" }   (no `code`)
 *
 * We match on the STABLE parts: GoTrue's `code` where it sets one, and the raw
 * database message for the path that has none. Every other failure is treated
 * as unmeasured and answered generically by the caller.
 */
function isAlreadyTaken(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  const code = err.code ?? "";
  if (code === "email_exists" || code === "user_already_exists") return true;
  const msg = (err.message ?? "").toLowerCase();
  return msg.includes("database error saving new user");
}

/** Find an existing auth user by email, paging listUsers to the end. */
async function findAuthUser(admin: SupabaseClient, email: string): Promise<{ id: string } | null> {
  const target = email.trim().toLowerCase();
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const hit = data.users.find((u) => (u.email ?? "").toLowerCase() === target);
    if (hit) return { id: hit.id };
    if (data.users.length < 200) break; // last page
  }
  return null;
}

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin");

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(origin) });
  }
  if (req.method !== "POST") {
    return json(
      200,
      { ok: false, reason: "invalid", error: invalidArgument("method", "POST expected") },
      origin,
    );
  }

  // Where the invite email may land, checked against the allow-list.
  const siteUrl = Deno.env.get("SITE_URL") ?? LOCAL_ORIGIN;
  const allowed = new Set([siteUrl, LOCAL_ORIGIN]);
  const redirectOrigin = origin && allowed.has(origin) ? origin : siteUrl;

  // ---- body ----
  let email: unknown, nodeId: unknown, role: unknown;
  try {
    const parsed = await req.json();
    email = parsed.email;
    nodeId = parsed.nodeId;
    role = parsed.role;
  } catch {
    return json(
      200,
      { ok: false, reason: "invalid", error: invalidArgument("body", "expected JSON") },
      origin,
    );
  }
  if (typeof email !== "string" || email.trim() === "") {
    return json(
      200,
      { ok: false, reason: "invalid", error: invalidArgument("email", "required") },
      origin,
    );
  }
  if (typeof nodeId !== "string" || nodeId === "") {
    return json(
      200,
      { ok: false, reason: "invalid", error: invalidArgument("nodeId", "required") },
      origin,
    );
  }
  if (typeof role !== "string" || !ROLES.includes(role as Role)) {
    return json(
      200,
      {
        ok: false,
        reason: "invalid",
        error: invalidArgument("role", "one of viewer, supervisor, admin"),
      },
      origin,
    );
  }
  const normalisedEmail = email.trim().toLowerCase();

  // ---- caller client (AS THE CALLER) ----
  const authHeader = req.headers.get("Authorization") ?? "";
  const caller = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userErr } = await caller.auth.getUser();
  if (userErr || !userData?.user) {
    // verify_jwt = true means the platform rejects a missing/invalid token
    // before this runs, so this is defensive; kept 200 like every other handled
    // refusal so the client always reads the body directly (see the header).
    return json(200, { ok: false, reason: "not_admin", error: notPermitted(nodeId) }, origin);
  }
  const callerUserId = userData.user.id;

  // ⭐ THE CHEAP CHECK FIRST, so an unauthorised caller costs no email.
  const { data: adminAnywhere, error: adminErr } = await caller.rpc("app_is_admin_anywhere");
  if (adminErr || adminAnywhere !== true) {
    return json(200, { ok: false, reason: "not_admin", error: notPermitted(nodeId) }, origin);
  }

  // The caller's org, read from their OWN profile row (always readable).
  const { data: prof, error: profErr } = await caller
    .from("user_profiles")
    .select("org_id")
    .eq("user_id", callerUserId)
    .single();
  if (profErr || !prof) {
    return json(200, { ok: false, reason: "not_admin", error: notPermitted(nodeId) }, origin);
  }
  const orgId = prof.org_id as string;

  // ---- service-role client (only for the two things the caller cannot do) ----
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let userId: string;
  let invited: boolean;

  let existing: { id: string } | null;
  try {
    existing = await findAuthUser(admin, normalisedEmail);
  } catch {
    return json(
      200,
      { ok: false, reason: "invalid", error: invalidArgument("email", "could not be looked up") },
      origin,
    );
  }

  if (existing) {
    // Which orgs does this auth user already have a profile in?
    const { data: profiles, error: pErr } = await admin
      .from("user_profiles")
      .select("id, org_id")
      .eq("user_id", existing.id);
    if (pErr) {
      return json(
        200,
        { ok: false, reason: "invalid", error: invalidArgument("email", "could not be looked up") },
        origin,
      );
    }
    const here = (profiles ?? []).find((p) => p.org_id === orgId);
    const elsewhere = (profiles ?? []).find((p) => p.org_id !== orgId);

    if (here) {
      // Already a member of this company: make sure the grant on this place is
      // set (idempotent), then answer already_member. invited: false.
      const grant = await caller.rpc("set_site_member", {
        p_node_id: nodeId,
        p_profile_id: here.id,
        p_role: role,
      });
      if (grant.error) {
        return json(200, { ok: false, reason: "grant_refused", error: grant.error }, origin);
      }
      // `userId` is the AUTH user id on every ok answer, never the profile id,
      // so the field means one thing across the new-invite and already-member
      // paths alike.
      return json(200, { ok: true, userId: existing.id, invited: false }, origin);
    }
    if (elsewhere) {
      // Say NOTHING about the other org.
      return json(200, { ok: false, reason: "other_org", error: notPermitted(nodeId) }, origin);
    }
    // A known auth user with no profile anywhere: adopt them into this org
    // without a fresh invite email (they already have an account).
    userId = existing.id;
    invited = false;
  } else {
    // Brand new: this is the one privileged call.
    const { data: inv, error: invErr } = await admin.auth.admin.inviteUserByEmail(normalisedEmail, {
      redirectTo: `${redirectOrigin}/reset-password`,
    });
    if (invErr || !inv?.user) {
      // DEF-0020 (R-351). The invite call is itself the oracle for "this
      // address is already taken somewhere in this Supabase project". We reach
      // here only because `findAuthUser` answered null — GoTrue's admin listing
      // could not see the row, so there is no auth id to look profiles up by —
      // yet the auth.users insert was refused. For an address the listing could
      // not see, the only thing that refuses the insert is a row with that
      // email that already exists but is invisible to listUsers (a NULL
      // instance_id). Every such row this project has is seed.sql's org-2
      // fixture shim, which is in ANOTHER org; no product path creates an
      // auth.users row this listing cannot see whose profile is nevertheless in
      // the CALLER's org. So we answer exactly what the `elsewhere` branch
      // answers — the response is now indistinguishable from any other-org
      // refusal, which is the promise R-351 makes.
      if (isAlreadyTaken(invErr)) {
        return json(200, { ok: false, reason: "other_org", error: notPermitted(nodeId) }, origin);
      }
      // Any OTHER invite failure: the raw GoTrue message is itself a side
      // channel for shapes nobody has measured yet, so it is logged server-side
      // and never returned. The caller gets a fixed, uninformative refusal.
      console.error("invite: inviteUserByEmail failed", {
        code: invErr?.code,
        status: invErr?.status,
        message: invErr?.message,
      });
      return json(
        200,
        { ok: false, reason: "invalid", error: invalidArgument("email", "invite failed") },
        origin,
      );
    }
    userId = inv.user.id;
    invited = true;
  }

  // ---- the profile row (service role) ----
  const { data: newProfile, error: newErr } = await admin
    .from("user_profiles")
    .insert({ org_id: orgId, user_id: userId, role: "viewer", default_create_mode: "run" })
    .select("id")
    .single();
  if (newErr || !newProfile) {
    return json(
      200,
      {
        ok: false,
        reason: "invalid",
        error: invalidArgument("email", "profile could not be created"),
      },
      origin,
    );
  }
  const profileId = newProfile.id as string;

  // Undo everything this call created, newest first, so a refused grant or a
  // failed read-back leaves NOTHING behind. The profile row always goes; the
  // auth user goes ONLY when this call minted it (`invited`) — deleting a
  // pre-existing auth user would evict someone who was already a member of
  // another org. Leaving a freshly-minted one behind is the orphan the header
  // describes: it has already received the invite email, and the next attempt
  // at this address would take the "known auth user, no profile" branch and send
  // no fresh mail.
  const rollback = async () => {
    await admin.from("user_profiles").delete().eq("id", profileId);
    if (invited) await admin.auth.admin.deleteUser(userId);
  };

  // ---- the grant, AS THE CALLER: the database's final say ----
  const grant = await caller.rpc("set_site_member", {
    p_node_id: nodeId,
    p_profile_id: profileId,
    p_role: role,
  });
  if (grant.error) {
    await rollback();
    return json(200, { ok: false, reason: "grant_refused", error: grant.error }, origin);
  }

  // ⚠️ READ THE GRANT BACK before answering ok (CLAUDE.md §4).
  const { data: back } = await admin
    .from("profile_grants")
    .select("role")
    .eq("profile_id", profileId)
    .eq("node_id", nodeId)
    .maybeSingle();
  if (!back) {
    await rollback();
    return json(200, { ok: false, reason: "grant_refused", error: notPermitted(nodeId) }, origin);
  }

  return json(200, { ok: true, userId, invited }, origin);
});
