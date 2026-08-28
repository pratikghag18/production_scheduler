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
| `not_permitted` | `PT403` | the caller lacks an edit grant on a node the operation touches, **or** (brief P1-5a) is not an org admin calling one of the five hierarchy-admin RPCs | `node_id` (edit-grant case) or none (admin-check case) |
| `invalid_argument` | `PT400` | malformed input to an RPC (bad jsonb shape, null where required, `timerange` empty) | `field`, `reason` |
| `path_collision` *(brief P1-5a)* | `PT409` | `create_node`/`rename_node`/`move_node` would produce an `nodes.path` another node in the org already holds | `path`, `existing_node_id` |
| `node_cycle` *(brief P1-5a)* | `PT409` | a node would become its own ancestor — from `move_node`'s own pre-check, or from the `nodes_before_cycle` trigger on a direct `UPDATE` | `node_id` |
| `level_mismatch` *(brief P1-5a)* | `PT409` | a node's level is not exactly one position below its parent's (or, for a root node, not position 0) — from `create_node`/`move_node`'s own pre-check, or from the `nodes_before_level` trigger on a direct `INSERT`/`UPDATE` | `node_id` **only when raised by the trigger** — an RPC's own pre-check omits it deliberately, so the key's presence tells the two apart (see `docs/agent-briefs/p1-5a-hierarchy-db-brief.md` §6.4, case N17) |
| `level_in_use` *(brief P1-5a)* | `PT409` | `save_hierarchy_levels` would remove a hierarchy level that still has nodes | `level_ids` |
| `node_in_use` *(brief P1-5a)* | `PT409` | `delete_node(p_mode := 'delete')` on a node that still has children, runs, or assignments | `children`, `runs`, `assignments` |
| `schedulable_level_locked` *(brief P1-5a)* | `PT409` | `save_hierarchy_levels` would move the schedulable flag off a level that still has runs **or** direct assignments on it | `blocking_rows`, `level_id` |
| `not_offered_here` *(migration 0028, D109)* | `PT409` | a run, assignment, training requirement, shift-pattern attachment, operator home cell or held training names a row whose owning node does not contain the node in question | `kind`, `id`, `owner_node_id`, `node_id` |
| `owner_change_blocked` *(migration 0028 §5)* | `PT409` | re-homing a product, operator, training or shift pattern that is already used outside the site it is being moved to | `kind`, `id`, `new_owner_node_id`, `stranded` |

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
  "products": [{"id": "...", "sku": "WX", "name": "Widget X", "active": true, "color_token": "product-1"}],
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

### 3.5 Hierarchy admin (brief P1-5a)

Five more RPCs, added by migration `0010`. Same shape as everything above —
`LANGUAGE plpgsql`, `SECURITY INVOKER`, `SET search_path = public, pg_temp`,
every raise through `api_raise`. All five open with an `app_is_admin()`
check the brief's own §6.2-6.5 text does not spell out explicitly, but which
mirrors `hierarchy_levels`/`nodes`' own RLS write policies (migration
`0008`: `nodes_insert`/`update`/`delete` are *all* admin-only) — see `docs/
agent-briefs/p1-5a-hierarchy-db-brief.md`'s agent report §5 for the reasoning.
Without it, a non-admin caller would either get a silent all-`NULL` `jsonb`
result (an `UPDATE ... RETURNING` that RLS filtered to zero rows) or a raw
RLS-violation error outside this contract — exactly the failure mode the
rest of this document exists to prevent.

#### `save_hierarchy_levels(p_levels jsonb) RETURNS jsonb`

Saves the org's hierarchy level list **whole**, as an ordered JSON array —
the array index *is* the position, so a payload cannot express a gap:

```json
[{"id": "uuid or null", "name": "Site", "is_schedulable": false}, "..."]
```

`id: null` means a new level; an existing level absent from the array is
removed. Exactly one entry must have `is_schedulable: true`. Capped at 64
entries. Writes in three passes internally (clear `is_schedulable`, offset
every position by +1000, then set final values) because neither
`hierarchy_levels`' `(org_id, position)` unique constraint nor its
one-schedulable partial index can be deferred — a direct `UPDATE` that
tries to reorder or move the schedulable flag in one statement hits a raw
`23505` (see `docs/design-plan.md` §19.1, findings F1/F2).

```json
[{"id": "...", "position": 0, "name": "Site", "is_schedulable": false}, "... ordered by position"]
```

**Raises:** `not_permitted`, `invalid_argument` (not an array; empty; over
64 entries; not exactly one schedulable; a blank name; **a non-null `id`
that does not parse as a uuid** — found in design-session verification,
Aug 25: an unparseable `id` such as `"nope"` previously reached the
function's own `::uuid` cast unguarded and raised a raw `22P02` outside
this document's closed set), `level_in_use` (a removed level still has
nodes), `schedulable_level_locked` (the schedulable level is changing and
the *current* one still has runs, or — with zero runs — direct assignments;
see D72 in `docs/design-plan.md` §19.2).

#### `create_node(p_parent_id uuid, p_name text, p_sort_order int DEFAULT 0, p_template_id uuid DEFAULT NULL) RETURNS jsonb`

`p_template_id` added by migration `0015` (D87, brief P1-5f): since
migration `0014` a level's identity is `(template_id, position)`, not
`(org_id, position)`, and an org may hold more than one hierarchy shape —
`create_node` is the one write path 0014 left asking the old question, so
with two shapes present it used to place a root in an ARBITRARY one with
no error (§4 of the brief; not a race, and not a corruption risk with one
shape per org, but a correct request could not be expressed at all).

`p_parent_id = NULL` creates a ROOT node, and now resolves the shape first:

- `p_template_id` omitted (`NULL`) — legal only when the org holds
  **exactly one** hierarchy template, which is inferred and used. Every
  existing three-argument caller keeps working unchanged.
- `p_template_id` given — must name a template that exists **in the
  caller's own org** (checked explicitly; not made redundant by RLS under
  `SECURITY INVOKER` — see `supabase/tests/90_hierarchy_template_test.sql`
  T22, which runs with RLS bypassed for exactly this reason).
- Either way, the resolved template must already have a level at
  position 0 — a **freshly-created, still-empty** template (`create_
  hierarchy_template` returns one on purpose) has none yet.

Otherwise (`p_parent_id` given) this is a CHILD: the new node's level is
whatever sits at *parent position + 1*, **within the parent's own
template** — a child's shape is fixed by its parent, so `p_template_id`
is not a choice here. Passing one is fine ONLY when it names that same
template; passing a template that CONTRADICTS the parent's is refused
rather than silently accepted, so a caller can never believe it chose a
child's shape when it did not.

`path` is never supplied by the caller — trigger-derived, same as every
other node write (D6). Pre-checks the prospective path for a collision
before inserting, so two siblings that slugify alike (`"Cell 1"` /
`"Cell-1"`) get a typed `path_collision` instead of the raw `23505` that
`nodes_org_path_unique` (D67) would otherwise surface. `p_name` is trimmed
before both the collision check and the insert, so the stored row never
carries leading/trailing whitespace even though the SQL-level `DEFAULT 0`
signature suggests otherwise. `p_sort_order` is coalesced to `0`
internally — found in design-session verification, Aug 25: the function
signature's own `DEFAULT 0` only applies when the argument is *omitted*,
not when a caller passes `NULL` explicitly, and an uncoalesced `NULL`
previously reached the `INSERT` and raised a raw `23502` (not-null
violation) instead of succeeding cleanly.

```json
{"id": "...", "name": "Cell 9", "path": "plant_1.assembly.line_1.cell_9",
 "parent_id": "...", "level_id": "...", "sort_order": 3, "active": true}
```

**Raises:** `not_permitted`, `invalid_argument` (blank name; unknown
parent; and — new in migration 0015, all still `invalid_argument`,
distinguished only by `DETAIL.reason` — a root with `p_template_id` NULL
and the org holding zero or more than one template:
`{field: "p_template_id", reason: "no templates" | "ambiguous",
template_count: <n>}`; a root naming an unknown/foreign template:
`{field: "p_template_id", reason: "not found"}`; a child naming a
template that contradicts its parent's:
`{field: "p_template_id", reason: "not the parent's template",
parent_template_id: <uuid>}`), `level_mismatch` (no level exists one
position below the parent — `{node_id: <uuid>}`; **or, new in migration
0015**, a root resolved to a template with no levels yet at all —
`{template_id: <uuid>}`), `path_collision`. No new error CODE — the
closed set in `docs/api.md` §1 stays at twelve; every new failure above
is `invalid_argument` or `level_mismatch` with a new `DETAIL` shape, the
same convention migration 0014 already used for the three template RPCs
below.

#### `rename_node(p_node_id uuid, p_name text) RETURNS jsonb`

Descendant paths cascade via the existing `nodes_after_path` trigger
(migration `0001`) — not reimplemented here. The path-collision check
excludes the node's own current row, so renaming a node to its own name (or
to a different name that happens to slugify the same) is a no-op, not a
false-positive collision.

```json
{"id": "...", "name": "Line One", "path": "plant_1.assembly.line_one"}
```

**Raises:** `not_permitted`, `invalid_argument` (blank name; unknown node),
`path_collision`.

#### `move_node(p_node_id uuid, p_new_parent_id uuid, p_sort_order int DEFAULT NULL) RETURNS jsonb`

Re-parents only — **never changes `level_id`** (D71). The new parent must
be exactly one level above the node's *existing* level. Checks a self/
descendant cycle **before** level adjacency (deliberately — every move
beneath one's own descendant also skips a level, so checking level first
would misreport a genuine cycle as `level_mismatch`; see `docs/design-plan.
md` §19.3 item 4). `p_new_parent_id = NULL` is legal only when the node is
already at level position 0.

```json
{"id": "...", "name": "Cell 1", "path": "plant_1.assembly.line_2.cell_1",
 "parent_id": "...", "sort_order": 0}
```

**Raises:** `not_permitted`, `invalid_argument` (unknown node or parent),
`node_cycle`, `level_mismatch` (this RPC's own pre-check's `DETAIL`
deliberately omits `node_id` — see the error table in §1), `path_collision`.

#### `delete_node(p_node_id uuid, p_mode text DEFAULT 'deactivate') RETURNS jsonb`

Two modes, mirroring `delete_run`'s (D73):

- `'deactivate'` — sets `active = false` on the node **and its whole
  subtree** (`path <@` the node's path, which is reflexive, so the node
  itself is included).
- `'delete'` — refuses with `node_in_use` while the node has children,
  runs, or assignments; otherwise deletes its `profile_grants`,
  `node_shift_templates` and `node_skill_requirements` rows, then the node.

`p_mode` is validated as `p_mode IS NULL OR p_mode NOT IN (...)` — found in
design-session verification, Aug 25: `p_mode NOT IN ('deactivate','delete')`
alone evaluates to `NULL`, not `true`, when `p_mode IS NULL`, so a `NULL`
mode silently fell through every guard to the **`'delete'` branch** — the
more destructive of the two documented modes — instead of the safer
`'deactivate'` default the signature implies. A malformed argument must
never select the more dangerous of two explicit behaviours; this was a bug
in the original spec, not a deviation from it.

```json
{"mode": "deactivate", "deactivated": 4}
```
```json
{"mode": "delete", "deleted": 1}
```

**Raises:** `not_permitted`, `invalid_argument` (bad mode; unknown node),
`node_in_use`.

### 3.6 Site membership (migration `0021`)

Three functions, and the split between them is `§4`'s rule applied literally:
one pure read aggregation, and two writes whose refusal would otherwise be
**silent**. Adding somebody, re-roling them and removing them are the only
operations, because `profile_grants` is keyed `(profile_id, node_id)` — "add"
and "change role" are the same row.

`p_node_id` is any node the caller administers. For a site admin that is their
site's root; for a department admin it is their department. All three refuse
with `not_permitted` unless `app_is_admin_for(p_node_id)`.

#### `editable_shape_ids() RETURNS jsonb`

`SECURITY INVOKER`. The ids of the structures the caller may edit — every
structure in the org for a company admin, their own site's for a site admin.
Returns a jsonb **array**, `[]` and never `null`.

It restricts nothing. `hierarchy_templates_select` stays org-wide on purpose
(`0020` §5: a structure's name and level list are not secrets; the nodes inside
a site are, and `nodes_select` governs those). This answers a question the
client cannot compute, so the shape picker can stop offering structures whose
first edit would come back `not_permitted`. The client mirror
(`filterEditableShapes`) **fails open** on a missing answer — see its own
comment for why that is the opposite call from `adminAccess` and still right.

```json
["21000000-0000-0000-0000-000000000001"]
```

**Raises:** nothing. A caller who administers nothing gets `[]`.

#### `site_people(p_node_id uuid) RETURNS jsonb`

`SECURITY DEFINER`, because `auth.users` is not readable by `authenticated`
and the sign-in email is the only human-readable thing this system knows about
a person — `user_profiles` has no name column.

One entry per person **in the company**, each carrying the grants they hold
inside `p_node_id`'s subtree (`path <@`, so a department admin inside the plant
shows up when you ask about the plant). The server does not split them into
"members" and "candidates"; the client does, from `grants` and `companyAdmin`.

⚠️ `companyAdmin` matters: a company admin reaches every site with no grant at
all, so without it a screen lists them under "no access" beside a button that
would do nothing for them.

The list is **unbounded** — no `LIMIT`, no search parameter. A silent cap would
make a missing person look like a person who does not exist. When it needs
paging it gets an argument and a documented bound.

```json
{
  "nodeId": "30000000-0000-0000-0000-000000000001",
  "nodeName": "Plant 1",
  "people": [
    {
      "profileId": "d0000000-0000-0000-0000-000000000004",
      "email": "sam@example.test",
      "orgRole": "viewer",
      "companyAdmin": false,
      "grants": [
        {"nodeId": "30000000-0000-0000-0000-000000000001",
         "nodeName": "Plant 1", "role": "supervisor"}
      ]
    }
  ]
}
```

**Raises:** `invalid_argument` (unknown node — checked *before* permission, so a
typo does not read as a permissions problem), `not_permitted`.

#### `set_site_member(p_node_id uuid, p_profile_id uuid, p_role text) RETURNS jsonb`

`SECURITY INVOKER`; the `0020` policies are the real gate. Adds the person or
changes the role they already hold there. `p_role` is `admin` | `supervisor` |
`viewer`.

Check order, and each step is a different sentence to the user: node exists →
caller administers it → **person exists** → role is legal → the caller is not
taking away their own admin access here → write.

⚠️ The person-existence check runs **after** the permission check, which
inverts `0020` §8's "existence first" ordering on purpose. "Does an account for
this address exist in the company" is not a question an outsider gets to ask.

⚠️ **You cannot take away your own `admin` role on this exact node** —
`not_permitted`, `reason: "self"`. A company admin is exempt. The rule is
narrow by design: adding yourself as a *viewer* somewhere inside your own site
is allowed, because the strongest covering grant wins and it takes nothing
away.

```json
{"nodeId": "30000000-…-0001", "profileId": "d0000000-…-0006", "role": "supervisor"}
```

**Raises:** `invalid_argument` (unknown node — carries `node_id`; unknown
person — carries `profile_id`; unknown or null role — carries `field: "role"`),
`not_permitted`.

#### `remove_site_member(p_node_id uuid, p_profile_id uuid) RETURNS jsonb`

`SECURITY INVOKER`. Removes the grant sitting on this exact node.

**This is the one that most needs to exist.** A `DELETE` under RLS removes the
rows the `USING` clause admits and reports success for the rest, so wired
straight to PostgREST a refused removal is a silent no-op: the row leaves the
list, the refetch puts it back, and nothing explains why. The pre-check is what
makes it loud. There is no post-write outcome check — one was written and
deleted, because with the pre-check in place it is unreachable (mutation Y33,
NOT CAUGHT).

Removing access that is not there is `invalid_argument`, not a shrug: two
admins with the same screen open should not both be told they succeeded.

```json
{"nodeId": "30000000-…-0001", "profileId": "d0000000-…-0004", "removedRole": "supervisor"}
```

**Raises:** `invalid_argument` (unknown node; nothing here to remove),
`not_permitted` (not yours; your own admin access).

#### What `0021` deliberately does not add

`user_profiles` is untouched. A site admin still cannot create or delete a
company membership and cannot write `user_profiles.role`, the company-wide
admin flag. There is no invitation flow — `site_people` can only offer people
who already have a `user_profiles` row, because a grant's foreign key requires
one, and inviting a new person is a GoTrue operation that does not exist for
company admins either. There is no "last admin" rule and no audit row for
access changes; both are named in the migration as tasks.

### 3.7 Changing a node's rung — `promote_node` / `demote_node` (P1-5k, migration 0017; error contract fixed by 0024)

```
promote_node(p_node_id uuid)                       returns jsonb
demote_node (p_node_id uuid, p_new_parent_id uuid) returns jsonb
```

Move a node **and its whole subtree** one rung up or down inside its own site
structure. Both return the moved subtree as an array of
`{ id, name, level_id, parent_id, path }` — every row of it, because every row's
level changed.

**Two functions, not one with a nullable argument.** Promote **derives** its
destination (the grandparent, or the top level when the parent is a root);
demote is **given** one, and the target must be a node at the moving node's
**own** level in the same structure. A shared signature with a nullable
`p_new_parent_id` would invite demoting with no target, and generated types
cannot express a nullable RPC argument anyway (§0).

**Raises:**

- `not_permitted` — not an admin, or no admin rights on the destination.
- `invalid_argument` — unknown node, or unknown destination node.
- `node_cycle` — demoting a node beneath its own descendant.
- `level_mismatch` — a top-level node cannot be promoted; a target that is not
  at the node's own level in the same structure; or **no destination rung for
  some level in the subtree**, which is checked UP FRONT (`{reason: "no
  destination level", delta}`).
- **`path_collision`** — the destination already holds a node with this path
  (`{path, existing_node_id}`). **NEW IN 0024**: this was a raw `23505` with an
  empty DETAIL, outside the twelve-code contract entirely.
- **`schedulable_level_locked`** — the move would leave runs or assignments on a
  node that has just left the schedulable rung, `{blocking_rows, level_id,
  reason}`. **The payload shape changed in 0024**: it was `{reason, count}`,
  which `parseSchedulerError` cannot decode, so this refusal reached the client
  as `Unknown`. `level_id` names the level the blocking rows landed on.

⚠️ **`app_relevel_subtree(p_node_id, p_new_parent_id, p_delta)` is granted to
`authenticated` and is therefore reachable directly**, not only through these
two wrappers. It carries its own admin, org-scope and destination checks for
that reason; case N16 in `76_relevel_contract_test.sql` calls it directly with a
destination in another org.

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
5. **(Brief P1-5a) The four node-mutating RPCs' own admin check is not in
   the brief's literal text.** §6.2-6.5 give `save_hierarchy_levels` an
   explicit "caller is not an admin -> `not_permitted`" step but say nothing
   of the kind for `create_node`/`rename_node`/`move_node`/`delete_node`.
   All four still open with it, because `nodes`' own RLS write policies
   (migration `0008`) are admin-only with no supervisor path at all — a
   non-admin caller without this pre-check would get either a silent
   all-`NULL` result (RLS filtered the `RETURNING` to zero rows) or a raw
   RLS-violation error outside the `api_raise` contract.
6. **(Brief P1-5a) `scripts/verify-db.sh` had been broken since Aug 22.**
   P1-3b's dev-login seed block needed ~20 more `auth.users` columns and an
   `auth.identities` table than `supabase/tests/00_harness.sql` declared;
   nothing caught it because P1-4a-P1-4e were frontend-only briefs. Fixed in
   the harness, never the seed — see that file's own header comment and the
   agent report for the full before/after.
7. **(Brief P1-5a, found in design-session verification, Aug 25) Three real
   defects, none prescribed by the brief and none caught by either this
   build's own 36-case suite or the design session's independent one at the
   time.** All three came from mutations the brief never listed and from
   probing every RPC with `NULL` arguments:
   - `delete_node(id, NULL)` **silently hard-deleted** a node instead of
     rejecting the call. `p_mode NOT IN (...)` evaluates to `NULL`, not
     `true`, when `p_mode IS NULL`, so the guard did not fire and control
     fell through to the `'delete'` branch — the more destructive of the
     two documented modes, chosen by a malformed argument instead of
     refused. This is a bug in the brief's own §6.5 text and its reference
     implementation, not a deviation from either.
   - `create_node(parent, name, NULL)` raised a raw `23502` (not-null
     violation) instead of succeeding with `sort_order: 0` — the function
     signature's `DEFAULT 0` only applies when the argument is *omitted*,
     not when a caller passes `NULL` explicitly. `move_node` already
     guarded the equivalent case correctly; `create_node` did not.
   - `save_hierarchy_levels` raised a raw `22P02` (invalid uuid syntax) on
     a payload with a malformed `id`. Not in the brief's original 8-step
     validation list; added as a 9th check.

   All three now raise (or, for the `create_node` case, succeed) through
   the documented `invalid_argument` contract; see the affected RPCs' own
   sections above and `supabase/tests/70_hierarchy_test.sql` cases D1/D2/D3.
