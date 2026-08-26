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
