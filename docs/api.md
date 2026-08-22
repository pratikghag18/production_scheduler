# Database API surface (brief P1-3a)

The client contract for the production-scheduler database: eight RPCs
(three read, five write), one shared error contract, and the rule for which
mutations go through an RPC versus a plain PostgREST table write. This is
the **database half only** — see the caveat in §0 below before building
anything on top of it.

Written for whoever builds brief **P1-3b** (the TypeScript half: typed
wrappers, a `SchedulerError` discriminated union, TanStack Query hooks). Do
not build P1-3b's scope from this document without reading the brief itself.

## 0. The one thing this document cannot verify

**PostgREST is not available in the build container** (it needs Docker), so
the mapping from a `PTxxx` SQLSTATE to an HTTP status code (`PT409` → 409,
`PT400` → 400, `PT403` → 403) **is unverified**. It needs confirming on a
machine with Docker (`supabase start`, then trigger each error path over the
real PostgREST endpoint and check the HTTP status).

**This is why the rule below is not optional:**

> **The client must switch on the `error` field of the parsed `DETAIL` JSON,
> never on the HTTP status.** If the SQLSTATE→HTTP mapping turns out
> different than expected once verified against real PostgREST, the contract
> below still holds, because nothing depends on the status code being any
> particular number — only on `error` being one of the six closed-set values.

Every test in `supabase/tests/60_api_test.sql` asserts on **SQLSTATE and the
parsed `DETAIL` JSON**, which is verifiable with plain `psql` — never on HTTP
status.

## 1. The error contract

Every failure a supervisor can cause arrives as a typed, machine-readable
payload. PostgREST surfaces a raised exception's `DETAIL` as the `details`
field of its JSON error body; every raise in migration `0009` routes through
one helper (`api_raise`) so this shape cannot drift:

```json
{"error": "capacity_exceeded", "operator_id": "…", "peak": 1.500, "cap": 1.000, "timerange": "[…,…)"}
```

`error` is a stable machine code from this closed set:

| `error` | SQLSTATE | Raised when | Extra fields |
|---|---|---|---|
| `capacity_exceeded` | `PT409` | operator's instantaneous peak would exceed the org cap | `operator_id`, `peak`, `cap`, `timerange` |
| `not_eligible` | `PT409` | operator lacks a required skill (or it expires inside the window) under `block` policy, or under `warn` policy without an explicit override | `operator_id`, `node_id`, `missing_skills[]`, `expiring_skills[]`, `policy` |
| `run_overlap` | `PT409` | a run would overlap another active run on the same node | `node_id`, `timerange`, `conflicting_run_id` |
| `run_node_mismatch` | `PT409` | an assignment's `node_id` ≠ its run's `node_id` | `assignment_node_id`, `run_node_id`, `run_id` |
| `not_permitted` | `PT403` | the caller lacks an edit grant on a node the operation touches | `node_id` |
| `invalid_argument` | `PT400` | malformed input to an RPC (bad jsonb shape, null where required, `timerange` empty) | `field`, `reason` |

**The `23P01` exception:** the `runs_no_overlap_on_node` exclusion
constraint (a database-level invariant, migration `0003`) raises a bare
Postgres `23P01` and cannot be routed through `api_raise` — a trigger cannot
intercept an exclusion-constraint violation before it fires. `create_run`
and `move_run` check for an overlapping run *before* writing and raise
`run_overlap` themselves (see the table above); the exclusion constraint
stays as the race-safe backstop for the rare case where two writers commit
in the same instant. **A bare `23P01` on `runs` at the client means the race
was lost — refetch and retry once**, it does not mean the request was
invalid.

## 2. Read functions

All `STABLE`, `SECURITY INVOKER` (RLS applies — a `SECURITY DEFINER` read
function here would silently expose every tenant), `SET search_path =
public, pg_temp`.

### `board_window(p_root_path ltree, p_from timestamptz, p_to timestamptz) RETURNS jsonb`

The single board-load call. One round trip, one payload, everything already
filtered by RLS because the function runs with the caller's own privileges.

Raises `invalid_argument` if `p_from`/`p_to` is null, if `p_from >= p_to`, or
if the window exceeds **92 days** — the board never needs more, and a
mis-typed date must not pull a year of history.

Every array key is always present and array-valued (`[]`, never `null`),
via `COALESCE(jsonb_agg(...), '[]'::jsonb)` — the client never has to branch
on a missing or null key.

```json
{
  "org": {"id": "10000000-...0001", "name": "Northwind Manufacturing", "settings": {"capacity_cap": 1.0, "eligibility_policy": "warn", ...}},
  "levels": [{"id": "...", "position": 0, "name": "Site", "is_schedulable": false}, "... 3 more"],
  "nodes": [{"id": "...", "parent_id": null, "level_id": "...", "name": "Plant 1", "path": "plant_1", "sort_order": 0, "active": true}, "... rest ordered by path"],
  "runs": ["... rows on the returned nodes intersecting [p_from, p_to)"],
  "assignments": ["... rows on the returned nodes intersecting the window"],
  "operators": [{"id": "...", "home_node_id": "...", "display_name": "Maria", "employee_ref": "EMP-001", "active": true, "skill_ids": ["40000000-...0001"]}],
  "products": [{"id": "...", "sku": "WX", "name": "Widget X", "active": true}],
  "skills": [{"id": "40000000-...0001", "name": "CNC"}],
  "node_skill_requirements": [{"node_id": "...cnc_line...", "skill_id": "40000000-...0001"}],
  "shift_templates": [{"id": "...", "name": "3 × 8h", "shifts": [{"id": "...", "name": "Shift 1", "start_min": 360, "end_min": 840, "breaks": [{"id": "...", "name": "Break 1", "start_min": 480, "end_min": 495}]}]}],
  "node_shift_map": [{"node_id": "...cell_1...", "template_id": "...3x8h..."}, "... one entry per returned node, template_id may be null"]
}
```

**Raises:** `invalid_argument` only.

**ASSUMPTION** (brief silent on scope): `node_skill_requirements` is scoped
to nodes under `p_root_path`, not the whole org — every requirement
relevant to a returned node is attached at or above some node already
included in `nodes` (`p_root_path` itself is always included, since ltree
`<@` is reflexive), so this stays complete for any `p_root_path` without
leaking an unrelated subtree's skill configuration into a narrower-scoped
board load.

### `capacity_probe(p_operator_id uuid, p_timerange tstzrange, p_efficiency numeric, p_exclude_assignment_id uuid DEFAULT NULL) RETURNS jsonb`

Powers the split-coverage popover *before* the user commits — the UI can
open it pre-populated instead of opening it in response to a rejection.
`peak` is computed by the exact same code as the capacity trigger (see
§4 below): both call `operator_peak_load()`.

```json
{
  "fits": false,
  "peak": 1.500,
  "cap": 1.000,
  "overlapping": [
    {"assignment_id": "9000000a-...000a", "node_id": "3000000a-...000a", "node_name": "Cell 4",
     "product_name": "Widget Y", "timerange": "[\"2026-08-18 06:00:00+00\",\"2026-08-18 12:00:00+00\")", "efficiency": 0.500},
    {"assignment_id": "9000000a-...000b", "node_id": "3000000a-...000b", "node_name": "Cell 5",
     "product_name": "Rework", "timerange": "[\"2026-08-18 06:00:00+00\",\"2026-08-18 12:00:00+00\")", "efficiency": 0.500}
  ]
}
```

**Raises:** nothing — it is a pure probe, never a gate.

### `check_eligibility(p_node_id uuid, p_operator_id uuid, p_timerange tstzrange) RETURNS jsonb`

Required skills = the union along the node's ltree ancestors (not just the
node's own row). Expiry is checked against `upper(p_timerange)`, **not**
`now()` — scheduling someone three weeks out fails if their cert lapses in
two. An unbounded upper bound on the window counts as expiring for any
non-null `expires_at` (there is no finite date to compare against, so any
real expiry falls "inside" an open-ended window).

```json
{"eligible": false, "policy": "warn",
 "missing_skills": [{"id": "40000000-...0001", "name": "CNC"}],
 "expiring_skills": []}
```

```json
{"eligible": false, "policy": "warn", "missing_skills": [],
 "expiring_skills": [{"id": "40000000-...0001", "name": "CNC", "expires_at": "2099-06-15"}]}
```

**Raises:** nothing — used internally by `create_assignment` and `move_run`
as well as being callable directly for pre-drop UI feedback.

## 3. Write functions

All `VOLATILE`, `SECURITY INVOKER`, `SET search_path = public, pg_temp`. RLS
and the P1-2 triggers remain the authority; these functions add the
*contract* (typed errors, pre-write permission checks), not a second
security layer. Every one checks `app_can_edit_node()` on every node it
touches **before** writing anything and raises `not_permitted` if the check
fails — RLS would refuse the write anyway, but raising first turns a silent
zero-row UPDATE/INSERT into a typed error the client can show. Every write
function returns the affected rows as `jsonb` so the client can reconcile
its optimistic state without a refetch.

### `create_run(p_node_id uuid, p_product_id uuid, p_timerange tstzrange, p_planned_headcount int DEFAULT NULL, p_notes text DEFAULT NULL) RETURNS jsonb`

Pre-checks for an overlapping active run on the node (→ `run_overlap` with
`conflicting_run_id`) before writing. Sets `created_by = auth.uid()`.

```json
{"run": {"id": "...", "org_id": "...", "node_id": "...", "product_id": "...",
         "timerange": "[...)", "planned_headcount": 3, "status": "planned",
         "notes": null, "created_by": "...", "created_at": "...", "updated_at": "..."}}
```

**Raises:** `invalid_argument` (null/empty `p_timerange`), `not_permitted`, `run_overlap`.

### `create_assignment(p_node_id uuid, p_operator_id uuid, p_run_id uuid, p_product_id uuid, p_timerange tstzrange, p_efficiency numeric DEFAULT 1.000, p_target_qty numeric DEFAULT NULL, p_target_unit text DEFAULT NULL, p_eligibility_override boolean DEFAULT false, p_override_reason text DEFAULT NULL) RETURNS jsonb`

The eligibility gate:

1. Calls `check_eligibility`. If eligible, proceeds.
2. Not eligible + `block` policy → `not_eligible`, no override possible.
3. Not eligible + `warn` policy + `p_eligibility_override = false` → `not_eligible` (client shows the override prompt and retries with the flag — **never silently allowed**).
4. Not eligible + `warn` policy + `p_eligibility_override = true` → inserts with `eligibility_override = true`, `override_reason = p_override_reason`.

Capacity is **not** pre-checked here — the `assignments_capacity` trigger
owns it and is the race-safe authority. Call `capacity_probe` first if the
UI wants to open the split popover proactively instead of reacting to a
rejection.

```json
{
  "assignment": {"id": "...", "node_id": "...", "operator_id": "...", "eligibility_override": true,
                  "override_reason": "supervisor override", "efficiency": 1.000, "..."},
  "eligibility": {"eligible": false, "policy": "warn",
                   "missing_skills": [{"id": "40000000-...0001", "name": "CNC"}], "expiring_skills": []}
}
```

**Raises:** `invalid_argument` (null/empty `p_timerange`; exactly one of
`p_run_id`/`p_product_id` must be set), `not_permitted`, `not_eligible`,
`capacity_exceeded` (via the trigger).

**ASSUMPTION** (brief silent): `eligibility_override` is only ever stored
`true` when it actually overrode a genuine ineligibility. Passing
`p_eligibility_override = true` while the operator is already eligible is a
no-op flag with no effect on the stored row.

### `move_run(p_run_id uuid, p_node_id uuid, p_timerange tstzrange) RETURNS jsonb`

Atomic run + crew move (design-plan §15.2). `p_node_id` may equal the
current node (pure time move); `p_timerange` may equal the current range
(pure cell move).

1. Edit rights on **both** source and target node (else `not_permitted`).
2. Target node must have no other overlapping active run (else `run_overlap`).
3. Updates the run **first** — so `assignments_check_run_consistency` sees
   the new `node_id` when the crew rows update next.
4. Every attached assignment's `node_id` moves to the target and its
   `timerange` shifts by the same delta as the run's new start. An
   assignment that extended beyond the run's old bounds keeps its own
   duration — nothing is clamped.
5. Crew re-checked against the target node. Under `block`, any ineligible
   crew member aborts the **whole** move (nothing changes) with
   `not_eligible` listing every affected operator. Under `warn`, the move
   succeeds; offenders come back as warnings **and** are marked
   `eligibility_override = true` with `override_reason = 'run moved to
   <node name>'`.

```json
{
  "run": {"id": "...", "node_id": "...target...", "timerange": "[...)", "..."},
  "assignments": [{"id": "...", "node_id": "...target...", "timerange": "[...shifted...)", "..."}],
  "eligibility_warnings": [{"operator_id": "...", "missing_skills": [{"id": "...", "name": "CNC"}]}]
}
```

**Raises:** `invalid_argument`, `not_permitted`, `run_overlap`, `not_eligible` (block only), `capacity_exceeded` (via the trigger, if a shifted crew timerange now clashes with that operator's other work).

### `apply_split_coverage(p_adjustments jsonb, p_new_assignment jsonb) RETURNS jsonb`

The split-coverage commit. `p_adjustments` is
`[{"assignment_id": "…", "efficiency": 0.500}, …]` — the existing
assignments the supervisor dialled down. `p_new_assignment` is the same
argument shape `create_assignment` takes, or `null` for a pure rebalance.

**Adjustments are applied first, then the new assignment.** The capacity
trigger fires per row: inserting the new assignment first would check its
capacity against the *un-adjusted* (still-high) peak of the existing rows
and reject the whole transaction, even though the end state is legal. This
ordering is the entire reason this function exists instead of the client
sending three separate writes — see the comment in migration `0009` right
above the loop, and `supabase/tests/60_api_test.sql` item 20, which
demonstrates the reverse order failing inside a savepoint.

```json
{
  "adjusted": [{"id": "...", "efficiency": 0.500, "..."}],
  "assignment": {"id": "...", "node_id": "...", "efficiency": 0.500, "..."}
}
```

**Raises:** `invalid_argument` (malformed `p_adjustments`/`p_new_assignment`,
naming the offending field), `not_permitted`, plus anything
`create_assignment` can raise when `p_new_assignment` is not null.

#### Worked example: the split-coverage flow end to end

1. **Probe** (before opening the popover): operator is at 1.0 on Cell 1;
   supervisor drags them onto Cell 2 for an overlapping window.

   ```
   capacity_probe(p_operator_id, '[2026-08-18 08:00+00,2026-08-18 12:00+00)', 0.5, NULL)
   → {"fits": false, "peak": 1.500, "cap": 1.000,
      "overlapping": [{"assignment_id": "a1", "node_id": "cell_1", "node_name": "Cell 1",
                        "product_name": "Widget X", "timerange": "[...)", "efficiency": 1.000}]}
   ```

2. **Popover** opens pre-populated from that response: Cell 1's existing
   1.0 dialled down to 0.5, the new Cell 2 assignment at 0.5, a live peak
   indicator. Supervisor clicks "Split evenly", confirm re-enables once the
   projected peak (client-side arithmetic, same numbers) reads ≤ cap.

3. **Commit:**

   ```
   apply_split_coverage(
     [{"assignment_id": "a1", "efficiency": 0.5}],
     {"node_id": "cell_2", "operator_id": "...", "product_id": "wx",
      "timerange": "[2026-08-18 08:00+00,2026-08-18 12:00+00)", "efficiency": 0.5}
   )
   → {"adjusted": [{"id": "a1", "efficiency": 0.500, "..."}],
      "assignment": {"id": "a2", "node_id": "cell_2", "efficiency": 0.500, "..."}}
   ```

   End-state peak for the operator in that window is exactly 1.0 —
   confirmed by `operator_peak_load()`, the same function the capacity
   trigger used to allow the write.

### `delete_run(p_run_id uuid, p_mode text DEFAULT 'cascade') RETURNS jsonb`

The FK from `assignments` has no `ON DELETE`, so a staffed run cannot simply
be deleted. Two modes:

- `'cascade'` — delete the run's assignments, then the run.
- `'detach'` — convert each attached assignment to a **direct** assignment
  carrying the run's product (`run_id = NULL, product_id = <run's product>`,
  both set in the same `UPDATE` so the row satisfies
  `num_nonnulls(run_id, product_id) = 1` the instant it changes), then
  delete the run. The staffing survives; only the run goes away.

Any other `p_mode` → `invalid_argument`.

```json
{"deleted_run_id": "80000000-...0004", "detached_assignment_ids": ["90000000-...0005", "90000000-...0006"]}
```

(`detached_assignment_ids` is `[]` for `'cascade'`.)

**Raises:** `invalid_argument` (bad mode, run not found), `not_permitted`.

## 4. RPC vs. plain PostgREST table writes

Simple field edits — a run's `notes` or `planned_headcount`; an
assignment's `efficiency`, `target_qty`, `target_unit`, `status`; a plain
time resize that does not change node — go through **ordinary PostgREST
table updates** (`PATCH /assignments?id=eq....`), not an RPC. There is no
CRUD-wrapper RPC for these. RLS and the `assignments_capacity` /
`assignments_check_run_consistency` triggers still guard every one of them,
and the typed error contract still applies, because migration `0009`
amended the triggers themselves (§1 above) — a capacity-busting `PATCH` on
`efficiency` still comes back as `PT409`/`capacity_exceeded` with a parsed
`DETAIL`, exactly like a `create_assignment` call would.

An RPC exists only where the operation needs to touch **more than one row
atomically** (`move_run`, `apply_split_coverage`, `delete_run`), needs a
**pre-write permission or overlap check** ahead of RLS/the trigger to avoid
a silent zero-row result (`create_run`, `create_assignment`), or is a
**pure read aggregation** (`board_window`, `capacity_probe`,
`check_eligibility`).

## 5. Internal helpers (not part of the client contract)

`api_raise(p_error, p_message, p_detail)` and
`operator_peak_load(p_operator_id, p_timerange, p_efficiency, p_exclude_assignment_id)`
are shared internals, granted `EXECUTE` to `authenticated` only because
`SECURITY INVOKER` means the caller's own privileges apply all the way down
the call chain — every RPC above calls one or both of them. Neither is
meant to be called directly by client code; they carry no independent
authorization logic of their own (RLS + the calling RPC's own checks are
still the actual gate).

`operator_peak_load` is the **single** implementation of the §15.1
instant-wise peak calculation. Both `check_operator_capacity()` (the
`assignments_capacity` trigger) and `capacity_probe()` call it — see
`supabase/tests/60_api_test.sql` item 9 / brief §9 for the mutation test
that proves this (neutering the function breaks both call sites
identically).

## 6. Known deviations from the brief's literal text

Recorded here, not silently fixed — see the full agent report for detail:

1. **`api_raise`'s ERRCODE selection.** The brief's own code sample hardcodes
   `ERRCODE = 'PT409'` in `api_raise`, then separately instructs "use PT400
   for `invalid_argument`, PT403 for `not_permitted`" — two literal
   instructions that cannot both hold with one hardcoded value.
   Implemented as a `CASE` mapping `p_error` → the correct SQLSTATE.
2. **Function grants need `REVOKE ... FROM PUBLIC`, not just `FROM anon`.**
   PostgreSQL grants `EXECUTE` on newly created functions to `PUBLIC` by
   default (unlike tables, which get no default `PUBLIC` privileges). The
   brief's §6 template only does `REVOKE ALL ... FROM anon`, which never
   touches the separate `PUBLIC` grant — `anon` would still execute every
   RPC through it. Every function in migration `0009` has `EXECUTE` revoked
   from `PUBLIC` explicitly, in addition to the brief's `anon`-specific
   revoke.
3. **The test harness needed `GRANT USAGE ON SCHEMA auth TO authenticated,
   anon`.** A real Supabase project grants this by default; the P1-2 harness
   never needed it because every P1-2 caller of `auth.uid()` went through a
   `SECURITY DEFINER` function. P1-3a's write RPCs are `SECURITY INVOKER` by
   explicit requirement and call `auth.uid()` directly for `created_by`, so
   without this grant every write RPC fails immediately with "permission
   denied for schema auth" — not a bug in the RPCs, a gap in the shim.
4. **Acceptance item 15's literal scenario is mathematically impossible on
   the seed data.** "Move the Tuesday Cell 1 Widget X run to Cell 2" (run
   r1) at its own unchanged window collides with r3, which the seed already
   places on Cell 2 at that exact Tuesday window with the same product.
   `move_run` correctly raises `run_overlap`. `supabase/tests/60_api_test.sql`
   demonstrates this collision explicitly, then demonstrates the actual
   move-run-and-crew capability on a conflict-free target window.
