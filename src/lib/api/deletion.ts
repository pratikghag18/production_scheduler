/**
 * Deletion — the preview and the delete itself (migration 0029, D110).
 *
 * The maintainer, 28 August: *"When it is deleted, we give a warning to the user that
 * all the corresponding data will be deleted and encourage them deactivate to
 * retain the data instead. This will be handled by site admin so it their call
 * in the end."*
 *
 * ⭐ TWO RPCs OVER FOUR KINDS, AND ONE WRAPPER OVER BOTH, because the dialog is
 * one component: whatever it is about, it asks the same question ("what would
 * this take with it?"), shows the same two lists and offers the same two ways
 * out. A wrapper per table would be four copies of that, and four places for
 * the phrasing to drift.
 *
 * ⚠️ THIS IS THE FIRST WRITE ON THE ADMIN SCREENS THAT IS AN RPC AND NOT A
 * TABLE CALL, and that changes the error story back. `src/lib/api/products.ts`
 * says in its header that products writes are plain PostgREST calls, so RLS is
 * the only gate and a refusal arrives as a bare SQLSTATE — which is why §19.63
 * added `WriteRefused` and friends. These two functions end in `api_raise`, so
 * a refusal arrives with a machine code in `DETAIL` and `toSchedulerError`
 * reads it: `NotPermitted` when you may not administer the site, and
 * `InvalidArgument` when the row is not there. There is NO `requireWritten`
 * step here and none is owed — an RPC that refuses RAISES, it does not return
 * an empty result set.
 *
 * ⚠️ `deletion_preview` and `delete_owned_row` are new in 0029, so
 * `database.types.ts` does not know them until `npm run db:types` is run
 * against the local stack. Typecheck is INCONCLUSIVE on this file over the
 * device bridge until then (§19.72a lesson 1) — the two `rpc(...)` calls are
 * exactly where a stale generated type shows up.
 *
 * AUTHOR-ONLY — imports `@/lib/supabase`, so it is not runnable under
 * `node --experimental-strip-types`. The logic that IS unit-tested is
 * `parseDeletionPreview` in `shapes.ts` and the phrasing in
 * `features/admin/lib/deletion.ts`, neither of which imports anything at
 * runtime.
 */
import { supabase } from "@/lib/supabase";
import { shapeMismatch, toSchedulerError } from "./errors";
import { parseDeletionPreview, type DeletableKind, type DeletionPreview } from "./shapes";

/**
 * What would happen. A read, so it is safe to call the moment somebody opens
 * the confirmation, and safe to call again.
 *
 * ⚠️ `deletion_preview` is `SECURITY INVOKER`, so the counts are the caller's
 * own visible world, and a row in another tenant answers "not found"
 * (`InvalidArgument`) rather than "forbidden". Do not re-word that into "you
 * may not" anywhere upstream: a refusal that confirms the row exists is itself
 * a leak, and `56_`'s D26 is what pins it.
 */
export async function previewDeletion(kind: DeletableKind, id: string): Promise<DeletionPreview> {
  const { data, error } = await supabase.rpc("deletion_preview", { p_kind: kind, p_id: id });
  if (error) throw toSchedulerError(error);
  const parsed = parseDeletionPreview(data);
  if (parsed === null) {
    throw shapeMismatch("deletion_preview", "expected a DeletionPreview object (see shapes.ts)");
  }
  return parsed;
}

/**
 * Do it. Returns the same shape, with the counts being what ACTUALLY happened
 * and `deleted` true.
 *
 * ⭐ REPORT FROM THIS RESULT, NEVER FROM THE PREVIEW THAT PRECEDED IT. The two
 * calls answer at different instants and somebody may have scheduled a job in
 * between, so a screen that shows the prediction as the outcome is a screen
 * that lies once a year — and lies about the one thing nobody can undo.
 */
export async function deleteOwnedRow(kind: DeletableKind, id: string): Promise<DeletionPreview> {
  const { data, error } = await supabase.rpc("delete_owned_row", { p_kind: kind, p_id: id });
  if (error) throw toSchedulerError(error);
  const parsed = parseDeletionPreview(data);
  if (parsed === null) {
    throw shapeMismatch("delete_owned_row", "expected a DeletionPreview object (see shapes.ts)");
  }
  return parsed;
}
