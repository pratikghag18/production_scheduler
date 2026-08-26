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

export async function fetchAdminAnywhere(): Promise<boolean> {
  const { data, error } = await supabase.rpc("app_is_admin_anywhere");
  if (error) return false;
  return data === true;
}
