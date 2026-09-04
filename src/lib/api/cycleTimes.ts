/**
 * Standard cycle times — the admin section's data layer (R-315, migration 0040).
 *
 * `src/lib/api/` is the ONLY place allowed to touch `supabase`, snake_case
 * column names, or `database.types.ts` (docs/conventions.md). Everything past
 * this file works in camelCase and never learns that `seconds_per_unit` exists.
 *
 * ⚠️ THE WRITES HERE ARE PLAIN TABLE CALLS, so RLS is the only gate and a
 * refusal arrives as a bare SQLSTATE rather than a machine code — except when
 * `app_guard_cycle_time_scope` fires, which DOES raise one (`not_offered_here`,
 * or `invalid_argument` with reason `not_schedulable`). `toSchedulerError` maps
 * both, and the panel names each.
 *
 * ⭐ AND THE HALF THAT RAISES NOTHING AT ALL. A policy's `WITH CHECK` raises
 * 42501; its `USING` clause merely FILTERS. A refused UPDATE or DELETE is
 * therefore a SUCCESS THAT CHANGED NOTHING — pinned as case C7 in
 * `supabase/tests/64_cycle_times_test.sql`, where a second plant's admin
 * updates a row they cannot see and gets no error and no change. So every write
 * below ends `.select()` and passes the rows through `requireWritten`, which
 * throws `WriteRefused` on an empty result. That step is not decorative:
 * without it a plant admin editing another plant's cell is told "saved".
 *
 * AUTHOR-ONLY — imports `@/lib/supabase`. The logic that IS unit-tested lives
 * in `src/features/admin/lib/cycleTimes.ts`, which imports nothing at runtime.
 */
import { supabase } from "@/lib/supabase";
import { requireWritten, toSchedulerError } from "./errors";

/**
 * One `node_product_cycle_times` row as the admin screen needs it.
 *
 * ALWAYS SECONDS. The screen offers seconds, minutes and hours and converts on
 * the way in and out (`toSeconds` / `displayCycle` in the pure module), so that
 * a sum across two cells is a sum rather than a unit-conversion bug.
 */
export interface AdminCycleTime {
  nodeId: string;
  productId: string;
  secondsPerUnit: number;
}

/**
 * The columns every read below selects, in one place so they cannot drift.
 *
 * Exported so `apiCycleTimeShape.test.ts` can hold it against
 * `parseAdminCycleTime` — the two halves of a read are a column list and a
 * guard, and when they drift apart every row is rejected quietly and the screen
 * renders empty. That is not hypothetical here: it happened to the trainings
 * read, which is why that test exists.
 */
export const CYCLE_TIME_COLUMNS = "node_id, product_id, seconds_per_unit";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The shape guard: one raw row in, an `AdminCycleTime` or `null` out.
 *
 * Returns `null` rather than throwing, because the caller is a grid one
 * malformed row must not blank. The skipping and counting is the pure module's
 * job; this only answers "is this row readable".
 */
export function parseAdminCycleTime(row: unknown): AdminCycleTime | null {
  if (!isRecord(row)) return null;
  const { node_id, product_id, seconds_per_unit } = row;
  if (
    typeof node_id !== "string" ||
    typeof product_id !== "string" ||
    typeof seconds_per_unit !== "number" ||
    !Number.isFinite(seconds_per_unit)
  ) {
    return null;
  }
  return { nodeId: node_id, productId: product_id, secondsPerUnit: seconds_per_unit };
}

/**
 * Every cycle time the caller can read.
 *
 * RLS-scoped downward by `app_can_read_node`, so a plant admin gets their own
 * plant's cells and nothing else — the same cut `product_sites` reads take.
 * An empty result is the ordinary state, not an error: cycle times are optional
 * everywhere and most orgs will have set none.
 *
 * THROWS on a failed read: this is the screen's content, and an empty grid is a
 * lie when the truth is that the read did not happen.
 */
export async function fetchCycleTimes(): Promise<ReadonlyArray<AdminCycleTime | null>> {
  const { data, error } = await supabase
    .from("node_product_cycle_times")
    .select(CYCLE_TIME_COLUMNS);
  if (error) throw toSchedulerError(error);
  return (data ?? []).map((row) => parseAdminCycleTime(row));
}

export interface CycleTimeInput {
  /** `org_id` has NO DEFAULT — supplied from `useSession().profile.orgId`. */
  orgId: string;
  nodeId: string;
  productId: string;
  /** Seconds. The screen converts from whatever unit was typed. */
  secondsPerUnit: number;
}

/**
 * Sets the standard cycle time for one part at one cell, creating or replacing.
 *
 * An upsert rather than an insert-or-update pair because the PK is
 * `(node_id, product_id)` and the screen's act is "this cell makes this part in
 * N seconds" — whether a number was there before is not something the person
 * editing it should have to know.
 *
 * ⚠️ `onConflict` NAMES THE PRIMARY KEY COLUMNS. Without it PostgREST resolves
 * the conflict target itself, and a mismatch would turn an edit into a
 * duplicate-key error rather than a replace.
 */
export async function upsertCycleTime(input: CycleTimeInput): Promise<void> {
  const { data, error } = await supabase
    .from("node_product_cycle_times")
    .upsert(
      {
        org_id: input.orgId,
        node_id: input.nodeId,
        product_id: input.productId,
        seconds_per_unit: input.secondsPerUnit,
      },
      { onConflict: "node_id,product_id" },
    )
    .select("node_id");
  if (error) throw toSchedulerError(error);
  requireWritten(data);
}

export interface RemoveCycleTimeInput {
  nodeId: string;
  productId: string;
}

/**
 * Clears the standard cycle time for one part at one cell.
 *
 * Clearing is a real act, not a failure: the assignments there go back to
 * showing no target, which is what they showed before anyone measured it.
 */
export async function deleteCycleTime(input: RemoveCycleTimeInput): Promise<void> {
  const { data, error } = await supabase
    .from("node_product_cycle_times")
    .delete()
    .eq("node_id", input.nodeId)
    .eq("product_id", input.productId)
    .select("node_id");
  if (error) throw toSchedulerError(error);
  requireWritten(data);
}
