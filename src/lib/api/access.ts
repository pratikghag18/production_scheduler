/**
 * One typed wrapper over migration `20260826000019_scoped_roles.sql`'s
 * `app_is_admin_anywhere()`.
 *
 * ⚠️ THIS ANSWERS A VISIBILITY QUESTION AND NOTHING ELSE. It is true for a
 * company admin OR for anyone holding a `role = 'admin'` grant on any node,
 * which is exactly the set of people for whom the admin screen is not a dead
 * end. **It never authorises a write.** Every admin RPC re-asks the real
 * question against the specific node or structure being changed
 * (`app_is_admin_for`, `app_is_admin_for_template`), and migration 0019's
 * case S14 exists to pin that this predicate cannot stand in for them. A
 * caller that used this to decide whether to show a Save button would be
 * showing one that the server then refuses.
 *
 * Quoted from `src/lib/database.types.ts`, so the argument shape is read
 * rather than predicted (doc-drift rule 2 / brief rule 12):
 *
 *     app_is_admin_anywhere: { Args: never; Returns: boolean }
 *
 * FAILS CLOSED. A PostgREST error resolves to `false` rather than throwing:
 * the only consumer is a nav link and a route guard, and the honest fallback
 * for "we could not ask" is "do not show it". A company admin is unaffected
 * either way, because `adminAccess` answers them from their profile role
 * without needing this at all.
 *
 * AUTHOR-ONLY — imports `@/lib/supabase`, so it is not runnable under
 * `node --experimental-strip-types` in the design container. `tsc` and
 * `eslint` do cover it.
 */
import { supabase } from "@/lib/supabase";
import type { Json } from "@/lib/database.types";
import type { DateFormat } from "@/lib/format/dates";
import { toSchedulerError } from "./errors";

export async function fetchAdminAnywhere(): Promise<boolean> {
  const { data, error } = await supabase.rpc("app_is_admin_anywhere");
  if (error) return false;
  return data === true;
}

/* ===========================================================================
 * Migration `20260826000021_site_membership.sql` — "who can get in".
 *
 * Three wrappers. Signatures quoted from `src/lib/database.types.ts` so the
 * argument shapes are READ rather than predicted (doc-drift rule 2 / brief
 * rule 12):
 *
 *     site_people:        { Args: { p_node_id: string };                                   Returns: Json }
 *     set_site_member:    { Args: { p_node_id: string; p_profile_id: string; p_role: string }; Returns: Json }
 *     remove_site_member: { Args: { p_node_id: string; p_profile_id: string };             Returns: Json }
 *
 * ⚠️ THESE THREE FAIL **OPEN** — i.e. they THROW — while `fetchAdminAnywhere`
 * above fails closed, and the difference is deliberate. That one answers a
 * visibility question whose honest fallback is "do not show it". These are the
 * screen's content and its writes: a read that could not happen must reach the
 * user as an error, not as an empty list of colleagues, and a write that could
 * not happen must never look like it worked.
 *
 * ⚠️ AND `fetchSitePeople` RETURNS `unknown` ON PURPOSE. Every other read in
 * this layer runs its payload through a `parseXResult` guard and throws
 * `shapeMismatch` — right for a single row whose absence is an error, wrong
 * for a LIST a screen renders, where one malformed entry must not blank the
 * panel. The guard is `buildAccessRows` in
 * `src/features/admin/lib/siteAccess.ts`: pure, never throws, skips what it
 * cannot read and reports how many it skipped. Keeping it there is also what
 * makes it unit-testable without a network — this file is not runnable under
 * `node --experimental-strip-types` because it imports `@/lib/supabase`.
 * =========================================================================== */

/** The role a grant carries. Mirrors `profile_grants_role_check` (0019). */
export type SiteMemberRole = "admin" | "supervisor" | "viewer";

export interface SetSiteMemberInput {
  nodeId: string;
  profileId: string;
  role: SiteMemberRole;
}

export interface RemoveSiteMemberInput {
  nodeId: string;
  profileId: string;
}

/**
 * `site_people(p_node_id uuid)`. Raises: `invalid_argument` (no such node),
 * `not_permitted` (you do not administer this place).
 *
 * The payload is handed on unparsed — see the block comment above.
 */
export async function fetchSitePeople(nodeId: string): Promise<unknown> {
  const { data, error } = await supabase.rpc("site_people", { p_node_id: nodeId });
  if (error) throw toSchedulerError(error);
  return data;
}

/**
 * `set_site_member(p_node_id, p_profile_id, p_role)`. Adds the person or
 * changes the role they already hold there — one row either way, because
 * `profile_grants` is keyed `(profile_id, node_id)`.
 *
 * Raises: `invalid_argument` (no such node, carrying `node_id`; no such
 * person, carrying `profile_id`; unknown or null role, carrying
 * `field: "role"`), `not_permitted` (not your place; or your own admin access
 * here).
 */
export async function setSiteMember(input: SetSiteMemberInput): Promise<void> {
  const { error } = await supabase.rpc("set_site_member", {
    p_node_id: input.nodeId,
    p_profile_id: input.profileId,
    p_role: input.role,
  });
  if (error) throw toSchedulerError(error);
}

/**
 * `remove_site_member(p_node_id, p_profile_id)`. Removes the grant sitting on
 * this exact node.
 *
 * Raises: `invalid_argument` (no such node; nothing here to remove),
 * `not_permitted` (not your place; or your own admin access here).
 *
 * ⚠️ The return value is DISCARDED, and that is not laziness. A refused
 * DELETE under RLS is a silent no-op, which is the whole reason this is an
 * RPC — but the loudness comes from the server's pre-check raising, not from
 * anything this wrapper could inspect. Migration 0021 §5 records that its own
 * post-write outcome check was deleted for being unreachable; reading the
 * payload back here to "confirm" would be that same dead code one layer up.
 */
export async function removeSiteMember(input: RemoveSiteMemberInput): Promise<void> {
  const { error } = await supabase.rpc("remove_site_member", {
    p_node_id: input.nodeId,
    p_profile_id: input.profileId,
  });
  if (error) throw toSchedulerError(error);
}

/* ===========================================================================
 * Which places may this caller WRITE to — the two halves of
 * `app_can_edit_node`, fetched so a screen can stop offering controls the
 * server will refuse (D114).
 *
 * ⭐⭐ IT LIVES HERE BECAUSE IT IS A READ, and `src/lib/api/` is the only
 * place allowed to know `supabase` exists. It was written inside
 * `features/admin/hooks/useEditRights.ts` first, with a comment saying it
 * should move the moment a second screen needed it — Operators is that second
 * screen, so it moved. **A deviation that names its own expiry condition is
 * worth honouring when the condition arrives**, rather than becoming the
 * second copy of a thing.
 *
 * ⚠⚠ THIS THROWS WHERE `fetchAdminAnywhere` SWALLOWS, and the difference is
 * deliberate. That one answers *should this screen exist*, whose honest
 * fallback is "no", so it fails closed to `false`. This one decides whether to
 * OFFER a control, and its honest fallback is "offer it and let the server
 * refuse" (`scope.ts`'s rule: hiding is invisible and permanent). **Returning
 * empty arrays on failure would be indistinguishable from a real answer of
 * "you hold no grants"** — the one result that must never be guessed, because
 * it silently removes every button on the screen.
 * ======================================================================== */

export interface GrantPaths {
  /** Paths covered by an ADMIN grant — arm (2) of `app_can_edit_node`. */
  adminPaths: string[];
  /** Paths covered by an admin OR supervisor grant — arm (3)'s second half. */
  writablePaths: string[];
}

/**
 * ltree over PostgREST, narrowed at the boundary.
 *
 * ⭐ MEASURED, NOT ASSUMED: called against the running stack as `ana` and
 * `marco`, `setof ltree` comes back as a plain JSON array of strings
 * (`["plant_a.area_1.line_1"]`). The generated types say `Returns: unknown[]`,
 * so the compiler cannot narrow it and something has to.
 *
 * ⚠️ A NON-STRING ENTRY IS SKIPPED, NOT THROWN ON. One malformed path must
 * not cost the reader every button on the screen — that is `parseArrayOf`'s
 * whole-array failure (§19.76) in a place where the blast radius is a screen
 * full of dead controls rather than a visible error.
 */
export function parseGrantPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((p): p is string => typeof p === "string" && p !== "");
}

export async function fetchGrantPaths(): Promise<GrantPaths> {
  // Both are already executable by `authenticated` (0019), so D114 needed no
  // migration to answer this question on the client.
  const [admin, writable] = await Promise.all([
    supabase.rpc("app_grant_paths_for", { p_roles: ["admin"] }),
    supabase.rpc("app_grant_paths", { require_edit: true }),
  ]);
  if (admin.error) throw toSchedulerError(admin.error);
  if (writable.error) throw toSchedulerError(writable.error);
  return {
    adminPaths: parseGrantPaths(admin.data),
    writablePaths: parseGrantPaths(writable.data),
  };
}

/* ===========================================================================
 * The org-wide settings bag — read for everyone, written by the system admin.
 *
 * `orgs.settings` (0001) is the flat jsonb that already carries `capacity_cap`
 * and `eligibility_policy`; migration 0037 added the ONE write function it never
 * had, for `date_format`. `orgs_select` (0008) returns the caller's own org row
 * to everyone, so the READ is a plain PostgREST select; the WRITE is an RPC
 * because a non-admin UPDATE is a silent zero-row no-op under `orgs_update`
 * (0037's header / api.md §4).
 *
 * ⚠️ THE READ THROWS, like `fetchSitePeople` and unlike `fetchAdminAnywhere`:
 * the format decides how every date on the screen reads, and a read that could
 * not happen must reach the caller as an error, not as a wrong default silently
 * applied. The DEFENSIVE fallback lives one layer up, in `coerceDateFormat`
 * (`src/lib/format/dates.ts`), which turns an absent or unknown key into the
 * default -- so a settings bag that has never had `date_format` set reads as the
 * default without this throwing.
 *
 * AUTHOR-ONLY — imports `@/lib/supabase`, so not runnable under
 * `node --experimental-strip-types`. `tsc`/`eslint` cover it.
 * ======================================================================== */

/** The caller's org settings bag (`orgs.settings`). Throws if the read fails. */
export async function fetchOrgSettings(): Promise<Json> {
  // `.single()` is right: `orgs_select` returns exactly the caller's own org.
  const { data, error } = await supabase.from("orgs").select("settings").single();
  if (error) throw toSchedulerError(error);
  return data.settings;
}

/**
 * `set_org_date_format(p_format)`. Sets the org-wide date-display format.
 * Raises: `not_permitted` (not a system admin), `invalid_argument` (unknown or
 * null token, carrying `field: "date_format"`).
 *
 * ⚠️ The returned settings are DISCARDED: the caller (`useOrgSettings`)
 * invalidates and refetches, and the loudness of a refusal comes from the
 * server RAISE, not from anything this wrapper could inspect — the same shape as
 * `setSiteMember`.
 */
export async function setOrgDateFormat(format: DateFormat): Promise<void> {
  const { error } = await supabase.rpc("set_org_date_format", { p_format: format });
  if (error) throw toSchedulerError(error);
}

/**
 * What the org does when somebody is scheduled onto work they are not
 * certified for. Mirrors migration 0001's
 * `check (settings->>'eligibility_policy' in ('warn','block'))` — the same
 * shape, and for the same reason, as `SiteMemberRole` mirroring
 * `profile_grants_role_check` above.
 *
 *   "warn"  — the placement is allowed if the planner ticks an override and
 *             types a reason, which is stored on the assignment
 *             (`assignments.override_reason`). The 0001 default.
 *   "block" — the server refuses the placement outright; there is no override.
 *
 * ⚠️ THIS IS NOT A NEW CONCEPT, only a newly WRITEABLE one. The board has read
 * it since P1-4e (`readEligibilityPolicy` in
 * `src/features/board/lib/boardIndex.ts`, which spells the union inline) and
 * `create_assignment` / `move_run` / `apply_split_coverage` have enforced it
 * for as long. Until migration 0049 nothing could set it.
 */
export type EligibilityPolicy = "warn" | "block";

/**
 * `set_org_eligibility_policy(p_policy)` (migration 0049). Sets the org-wide
 * eligibility policy. Raises: `not_permitted` (not a system admin),
 * `invalid_argument` (anything but `warn`/`block`, carrying
 * `field: "eligibility_policy"`).
 *
 * ⚠️ The returned settings are DISCARDED, exactly as `setOrgDateFormat` above:
 * the caller invalidates and refetches, and the loudness of a refusal comes
 * from the server RAISE, not from anything this wrapper could inspect. A plain
 * `orgs` UPDATE could not do that — `orgs_update` (0008) filters a non-admin to
 * zero rows and raises nothing, which is why this is an RPC at all (0049's
 * header; `72_eligibility_policy_test.sql` X7 beside X8).
 */
export async function setOrgEligibilityPolicy(policy: EligibilityPolicy): Promise<void> {
  const { error } = await supabase.rpc("set_org_eligibility_policy", { p_policy: policy });
  if (error) throw toSchedulerError(error);
}

/* ===========================================================================
 * PER-PLANT SETTINGS — migration 0050 (R-331).
 *
 * The maintainer, session 62: "These settings I think cannot be applied plant
 * wise which defeats the purpose of both options. Lets make it possible to
 * assign settings individually for each plant."
 *
 * ⭐ THE STORE IS `node_settings`, NOT A SECOND JSONB BAG, AND THE REASON IS
 * THE STATE THIS SCREEN HAS TO RENDER. "Plant 2 is set to block" and "Plant 2
 * inherits the company's block" are DIFFERENT things — the first survives the
 * company changing its mind and the second does not — and a jsonb bag cannot
 * tell them apart, because `settings->>'k'` reads back null both for a missing
 * key and for a key holding a JSON null (F-088, measured). A row exists or it
 * does not; `override: null` below is the absence, and it is load-bearing.
 *
 * ⚠️ THE SERVER REMAINS THE AUTHORITY. `check_eligibility` and `move_run`
 * resolve the policy themselves, per node, through
 * `app_resolve_node_setting` — nearest ancestor-or-self with an override, else
 * the company's, else `warn`. Nothing here decides anything; it renders what
 * the server will do and writes what the person chose.
 *
 * AUTHOR-ONLY — imports `@/lib/supabase`.
 * ======================================================================== */

/** One plant's answer for one setting, as the Settings screen has to show it. */
export interface PlantEligibilityPolicy {
  nodeId: string;
  name: string;
  /**
   * ⛔ `null` MEANS INHERITING, and it is not the same as `effective` happening
   * to equal the company's value today. A plant deliberately set to `warn`
   * while the company is on `warn` stays on `warn` when the company moves to
   * `block`; a plant that is merely inheriting moves with it. The screen has to
   * be able to say which of the two it is looking at.
   */
  override: EligibilityPolicy | null;
  /** What the server will actually apply at this plant right now. */
  effective: EligibilityPolicy;
}

function asEligibilityPolicy(v: unknown): EligibilityPolicy | null {
  return v === "warn" || v === "block" ? v : null;
}

/**
 * Every plant (a ROOT node) the caller can see, with its own override and the
 * value that is actually in force there.
 *
 * ⛔ THE ONE-LINE RESOLUTION BELOW IS ONLY CORRECT FOR ROOTS, and the moment
 * this list stops being roots it becomes a bug. The server's rule is "the
 * nearest ancestor-or-self carrying an answer, else the company's". A root has
 * no ancestors, so for a root — and ONLY for a root — that reduces exactly to
 * "its own override, else the company's", which is what this computes. For any
 * deeper node the walk is real and the answer must come from the server
 * (`app_resolve_node_setting`), never from this shortcut: an override on an
 * ancestor the caller cannot READ would silently drop out and the screen would
 * claim the company's permissive default for a place that is strict.
 * `supabase/tests/73_plant_settings_test.sql` P16/P17 are that hazard, pinned
 * on the server side.
 *
 * ⚠️ `orgPolicy` IS PASSED IN rather than read here, because the Settings screen
 * has already fetched `orgs.settings` for the company-wide control and passing
 * its coerced value keeps the two halves of one screen from disagreeing about
 * the company's answer while a refetch is in flight.
 *
 * THROWS on a failed read, like `fetchOrgSettings` and for its reason: a plant
 * whose rule could not be read must reach the user as an error, not as a wrong
 * default silently rendered next to the word "block".
 */
export async function fetchPlantEligibilityPolicies(
  orgPolicy: EligibilityPolicy,
): Promise<PlantEligibilityPolicy[]> {
  const [plants, overrides] = await Promise.all([
    // ⚠️ NO `path` IN THE COLUMN LIST, and that is a decision rather than an
    // omission: `nodes.path` is a Postgres ltree, which `supabase gen types`
    // emits as `unknown` because it has no JS mapping, and every other reader of
    // it in this layer therefore carries a runtime guard (`parseShiftNodeRow`).
    // A list of plants needs a name and an id; asking for a column that would
    // buy a guard and nothing else is how a screen ends up silently dropping a
    // plant whose row failed to parse.
    supabase.from("nodes").select("id, name").is("parent_id", null).order("name"),
    supabase.from("node_settings").select("node_id, value").eq("key", "eligibility_policy"),
  ]);
  if (plants.error) throw toSchedulerError(plants.error);
  if (overrides.error) throw toSchedulerError(overrides.error);

  const byNode = new Map<string, EligibilityPolicy | null>();
  for (const row of overrides.data ?? []) byNode.set(row.node_id, asEligibilityPolicy(row.value));

  return (plants.data ?? []).map((n) => {
    const override = byNode.get(n.id) ?? null;
    return { nodeId: n.id, name: n.name, override, effective: override ?? orgPolicy };
  });
}

/**
 * `set_node_setting(p_node_id, 'eligibility_policy', p_policy)` (migration
 * 0050). Gives ONE plant its own answer, overriding the company's.
 *
 * Raises: `not_permitted` (not an admin of that plant — the gate is
 * `app_is_admin_for`, so a site admin may set their OWN plant and no other),
 * `invalid_argument` (an unknown value, carrying `field: "eligibility_policy"`;
 * an unknown node, carrying `field: "p_node_id"`).
 *
 * ⚠️ An RPC and not a plain upsert, for 0049's reason one level down: a write
 * a policy filters out reports success and changes nothing, and the screen
 * would show the choice "saving" and then reverting with nothing said.
 */
export async function setPlantEligibilityPolicy(
  nodeId: string,
  policy: EligibilityPolicy,
): Promise<void> {
  const { error } = await supabase.rpc("set_node_setting", {
    p_node_id: nodeId,
    p_key: "eligibility_policy",
    p_value: policy,
  });
  if (error) throw toSchedulerError(error);
}

/**
 * `clear_node_setting(p_node_id, 'eligibility_policy')` (migration 0050).
 * Returns ONE plant to inheriting the company's answer.
 *
 * ⛔ A SEPARATE CALL, NOT `setPlantEligibilityPolicy(nodeId, null)`. "Set to
 * nothing" is precisely the state migration 0050 spent a table avoiding, and a
 * screen with a broken binding that sent a null would silently return a strict
 * plant to the company's permissive default — the one direction nobody goes and
 * checks. Clearing is its own verb here because it is its own verb on the
 * server.
 *
 * Raises: `not_permitted` (not an admin of that plant). Clearing a plant that
 * had no override is not an error — it is already in the state asked for.
 */
export async function clearPlantEligibilityPolicy(nodeId: string): Promise<void> {
  const { error } = await supabase.rpc("clear_node_setting", {
    p_node_id: nodeId,
    p_key: "eligibility_policy",
  });
  if (error) throw toSchedulerError(error);
}
