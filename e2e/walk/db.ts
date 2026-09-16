/**
 * S61-c -- the typed walk's own database door.
 *
 * The brief (docs/agent-briefs/s61-c-typed-walk-spec-brief.md §1) says to
 * read how `copyWeek.spec.ts` gets a client that may write and reuse that
 * exact door. Every e2e spec in this repo that writes as a real person does
 * it the same way `invite.spec.ts` does (`tokenFor`/its own authenticated
 * `createClient` calls): `supabase-js`, signed in with the person's own
 * password, so every write runs under THEIR OWN RLS grant -- never a service
 * key, never a second door around the policies the app itself is bound by.
 * This file is that one pattern, factored out so `typedWalk.spec.ts` calls
 * it once instead of retyping it.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { supabaseUrl, supabaseAnonKey } from "../env";

export const PASSWORD = "devpassword";
/** The plant admin the role walk uses for Plant A (`dana@example.test`,
 *  `supabase/seed.sql`/`supabase/dev_demo.sql`) -- the one identity this
 *  whole spec signs in as, both in the browser and through this door. */
export const PLANT_A_ADMIN = "dana@example.test";

export type Db = SupabaseClient;

/** A supabase-js client signed in as `email`, writing under that person's own
 *  RLS grant -- the same shape `invite.spec.ts`'s `tokenFor`/its own client
 *  calls build, collapsed into one call. */
export async function signedInClient(email: string): Promise<SupabaseClient> {
  const anon = createClient(supabaseUrl, supabaseAnonKey);
  const { data, error } = await anon.auth.signInWithPassword({ email, password: PASSWORD });
  if (error || !data.session) {
    throw new Error(`sign-in for ${email} failed: ${error?.message ?? "no session"}`);
  }
  return createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${data.session.access_token}` } },
  });
}

export interface PlantANodes {
  plantId: string;
  /** Cell display name ("Cell 1" .. "Cell 6") -> node id. */
  cellIdByName: Map<string, string>;
  /** Every node id under (and including) Plant A -- what setup/teardown
   *  clears, walked from `parent_id` rather than trusting the `path` ltree's
   *  own label scheme (CLAUDE.md §4: never a second copy of a rule this
   *  file does not need to understand). */
  allNodeIds: string[];
}

/** Every node in the org, read once as Dana (she administers Plant A and
 *  reads Plant A's own subtree; a bare `nodes` select is small enough --
 *  a few dozen rows across three plants -- to fetch whole and walk in JS
 *  rather than lean on the `path` column's own trigger-maintained scheme,
 *  which this file has no need to parse. */
export async function loadPlantANodes(dana: SupabaseClient): Promise<PlantANodes> {
  const { data, error } = await dana.from("nodes").select("id, name, parent_id");
  if (error) throw new Error(`reading nodes: ${error.message}`);
  const rows = (data ?? []) as { id: string; name: string; parent_id: string | null }[];
  const plant = rows.find((n) => n.parent_id === null && n.name.startsWith("Plant A"));
  if (!plant) throw new Error("Plant A root node not found");

  const byParent = new Map<string, string[]>();
  for (const n of rows) {
    if (n.parent_id === null) continue;
    byParent.set(n.parent_id, [...(byParent.get(n.parent_id) ?? []), n.id]);
  }
  const allNodeIds: string[] = [];
  const stack = [plant.id];
  while (stack.length > 0) {
    const id = stack.pop()!;
    allNodeIds.push(id);
    for (const child of byParent.get(id) ?? []) stack.push(child);
  }

  const cellIdByName = new Map<string, string>();
  for (const id of allNodeIds) {
    const row = rows.find((n) => n.id === id);
    if (row && /^Cell \d$/.test(row.name)) cellIdByName.set(row.name, row.id);
  }

  return { plantId: plant.id, cellIdByName, allNodeIds };
}

export async function operatorId(dana: SupabaseClient, displayName: string): Promise<string> {
  const { data, error } = await dana
    .from("operators")
    .select("id")
    .eq("display_name", displayName)
    .limit(1);
  if (error) throw new Error(`reading operator ${displayName}: ${error.message}`);
  const id = (data ?? [])[0]?.id as string | undefined;
  if (!id) throw new Error(`operator not found: ${displayName}`);
  return id;
}

export async function productId(dana: SupabaseClient, name: string): Promise<string> {
  const { data, error } = await dana.from("products").select("id").eq("name", name).limit(1);
  if (error) throw new Error(`reading product ${name}: ${error.message}`);
  const id = (data ?? [])[0]?.id as string | undefined;
  if (!id) throw new Error(`product not found: ${name}`);
  return id;
}

/** `assignments`' own four-placement columns, plus the two S61-b override
 *  ones this walk's certification case asserts (CLAUDE.md §4: named once,
 *  reused by every read below, never a second column list). */
const ASSIGNMENT_COLUMNS =
  "id, node_id, operator_id, product_id, run_id, timerange, eligibility_override, override_reason";

export interface AssignmentRow {
  id: string;
  node_id: string;
  operator_id: string | null;
  product_id: string | null;
  run_id: string | null;
  timerange: string;
  eligibility_override: boolean;
  override_reason: string | null;
}

/** Postgres's own tstzrange text, e.g. `["2026-09-16 13:00:00+00","2026-09-16
 *  17:00:00+00")` -- turned into two epoch-ms bounds. Not a general range
 *  parser: this walk's own rows are always finite, always inclusive-start/
 *  exclusive-end, exactly as `assignments.timerange`'s own column is. */
export function parseTimerange(raw: string): { startMs: number; endMs: number } {
  const inner = raw.slice(1, -1);
  const [a, b] = inner.split(",").map((s) => s.replace(/^"|"$/g, ""));
  const toIso = (ts: string): string => {
    const spaced = ts.trim().replace(" ", "T");
    const m = spaced.match(/^(.*)([+-]\d{2})(:?(\d{2}))?$/);
    if (!m) return spaced;
    const offMin = m[4] ?? "00";
    return `${m[1]}${m[2]}:${offMin}`;
  };
  return { startMs: new Date(toIso(a)).getTime(), endMs: new Date(toIso(b)).getTime() };
}

/** Every assignment currently on one of `nodeIds`, no time filter -- the
 *  spec's own "what's on Plant A right now" reads (the per-row table it
 *  prints, and the final clear's own count check). */
export async function plantAAssignments(
  dana: SupabaseClient,
  nodeIds: string[],
): Promise<AssignmentRow[]> {
  if (nodeIds.length === 0) return [];
  const { data, error } = await dana
    .from("assignments")
    .select(ASSIGNMENT_COLUMNS)
    .in("node_id", nodeIds);
  if (error) throw new Error(`reading assignments: ${error.message}`);
  return (data ?? []) as unknown as AssignmentRow[];
}

/** Every run currently on one of `nodeIds`, no time filter -- same shape as
 *  `plantAAssignments`, for the table's own "N run(s)" column. */
export async function plantARuns(
  dana: SupabaseClient,
  nodeIds: string[],
): Promise<{ id: string; node_id: string; timerange: string }[]> {
  if (nodeIds.length === 0) return [];
  const { data, error } = await dana
    .from("runs")
    .select("id, node_id, timerange")
    .in("node_id", nodeIds);
  if (error) throw new Error(`reading runs: ${error.message}`);
  return (data ?? []) as unknown as { id: string; node_id: string; timerange: string }[];
}

/** Every assignment on one of `nodeIds` whose range STARTS within
 *  `[fromMs, toMs)` -- fetched whole (a plant's own window is a few dozen
 *  rows at most) and filtered in JS against the parsed range, since
 *  PostgREST has no operator this file wants to lean on for a range column's
 *  lower bound. */
export async function assignmentsStartingInWindow(
  dana: SupabaseClient,
  nodeIds: string[],
  fromMs: number,
  toMs: number,
): Promise<AssignmentRow[]> {
  if (nodeIds.length === 0) return [];
  const { data, error } = await dana
    .from("assignments")
    .select(ASSIGNMENT_COLUMNS)
    .in("node_id", nodeIds);
  if (error) throw new Error(`reading assignments: ${error.message}`);
  const rows = (data ?? []) as unknown as AssignmentRow[];
  return rows.filter((r) => {
    const { startMs } = parseTimerange(r.timerange);
    return startMs >= fromMs && startMs < toMs;
  });
}

/** Every run on one of `nodeIds` whose range starts within `[fromMs, toMs)`
 *  -- same shape as `assignmentsStartingInWindow`, for setup/teardown. */
export async function runsStartingInWindow(
  dana: SupabaseClient,
  nodeIds: string[],
  fromMs: number,
  toMs: number,
): Promise<{ id: string }[]> {
  if (nodeIds.length === 0) return [];
  const { data, error } = await dana
    .from("runs")
    .select("id, node_id, timerange")
    .in("node_id", nodeIds);
  if (error) throw new Error(`reading runs: ${error.message}`);
  const rows = (data ?? []) as unknown as { id: string; node_id: string; timerange: string }[];
  return rows.filter((r) => {
    const { startMs } = parseTimerange(r.timerange);
    return startMs >= fromMs && startMs < toMs;
  });
}

/** Deletes every assignment, then every run, on `nodeIds` whose range starts
 *  in `[fromMs, toMs)` -- assignments first, since a run-attached assignment
 *  references its run (`assignments_org_id_run_id_fkey`) and the reverse
 *  order would refuse on the foreign key. Used by both `beforeAll` and
 *  `afterAll` (brief §1: "afterAll deletes the same again"). */
export async function clearWindow(
  dana: SupabaseClient,
  nodeIds: string[],
  fromMs: number,
  toMs: number,
): Promise<void> {
  const assignments = await assignmentsStartingInWindow(dana, nodeIds, fromMs, toMs);
  if (assignments.length > 0) {
    const { error } = await dana
      .from("assignments")
      .delete()
      .in(
        "id",
        assignments.map((a) => a.id),
      );
    if (error) throw new Error(`clearing assignments: ${error.message}`);
  }
  const runs = await runsStartingInWindow(dana, nodeIds, fromMs, toMs);
  if (runs.length > 0) {
    const { error } = await dana
      .from("runs")
      .delete()
      .in(
        "id",
        runs.map((r) => r.id),
      );
    if (error) throw new Error(`clearing runs: ${error.message}`);
  }
}

/**
 * How long a row the bar's readout has just promised may take to actually
 * be there. The readout appears the moment the board is TOLD to write
 * (`onOpen`/`onBook`/…); the write itself goes out through the board's own
 * pop-up auto-submit (R-384) and then the server, and on this machine -- a
 * board that has just finished re-rendering a whole lot -- 15s was not
 * always enough, which read as "the bar lied" when the row landed a moment
 * later. Generous on purpose: nothing here waits the full budget when the
 * row is there, so the cost of the larger number is paid only by a genuine
 * failure.
 */
const ROW_TIMEOUT_MS = 45_000;

/** Waits for exactly one assignment matching `operatorId`+`nodeId` whose
 *  range starts at `startMs` and ends at `endMs` to exist -- the bar's own
 *  readout shows the moment `onOpen`/`onBook`/etc. is called, before the
 *  popover's own auto-submit (R-384) has actually reached the server, so a
 *  synchronous read right after the readout is exactly the race CLAUDE.md §4
 *  warns about ("a write that reports success can have changed nothing").
 *  Polls instead. */
export async function waitForAssignment(
  dana: SupabaseClient,
  params: { operatorId: string; nodeId: string; startMs: number; endMs: number },
  timeoutMs = ROW_TIMEOUT_MS,
): Promise<AssignmentRow> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { data, error } = await dana
      .from("assignments")
      .select(ASSIGNMENT_COLUMNS)
      .eq("operator_id", params.operatorId)
      .eq("node_id", params.nodeId);
    if (error) throw new Error(`polling assignments: ${error.message}`);
    const rows = (data ?? []) as unknown as AssignmentRow[];
    const hit = rows.find((r) => {
      const { startMs, endMs } = parseTimerange(r.timerange);
      return startMs === params.startMs && endMs === params.endMs;
    });
    if (hit) return hit;
    if (Date.now() > deadline) {
      throw new Error(
        `no assignment for operator ${params.operatorId} on node ${params.nodeId} ` +
          `spanning ${new Date(params.startMs).toISOString()}-${new Date(params.endMs).toISOString()} ` +
          `appeared within ${timeoutMs}ms (rows on that node/operator: ${JSON.stringify(rows.map((r) => r.timerange))})`,
      );
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** Waits for the row `operatorId`+`nodeId`+`startMs`/`endMs` matched to be
 *  GONE -- the removal twin of `waitForAssignment`, same polling reason. */
export async function waitForAssignmentGone(
  dana: SupabaseClient,
  params: { operatorId: string; nodeId: string; startMs: number; endMs: number },
  timeoutMs = ROW_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { data, error } = await dana
      .from("assignments")
      .select(ASSIGNMENT_COLUMNS)
      .eq("operator_id", params.operatorId)
      .eq("node_id", params.nodeId);
    if (error) throw new Error(`polling assignments: ${error.message}`);
    const rows = (data ?? []) as unknown as AssignmentRow[];
    const hit = rows.find((r) => {
      const { startMs, endMs } = parseTimerange(r.timerange);
      return startMs === params.startMs && endMs === params.endMs;
    });
    if (!hit) return;
    if (Date.now() > deadline) {
      throw new Error(
        `assignment for operator ${params.operatorId} on node ${params.nodeId} was still there after ${timeoutMs}ms`,
      );
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}
