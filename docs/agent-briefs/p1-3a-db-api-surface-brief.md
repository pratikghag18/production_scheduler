# Agent Brief P1-3a — Database API Surface (RPCs, Error Contract, Probes)

**Executor:** a fresh Sonnet agent (no prior context). **Phase:** 1, third build task.
**Depends on:** P1-2 (migrations 0001–0008) being on disk and passing `scripts/verify-db.sh`. Verify that before you start.
**Rules:** no design decisions of your own. Note assumptions; do not ask questions mid-run.

## Why this brief is SQL-only

The API layer has two halves: the database surface (functions the client calls) and the TypeScript data layer (typed wrappers, React Query hooks, optimistic updates). This brief is **only the first half**, because the container has no npm registry access — a TypeScript half would be authored but completely unvalidated, which is how brief P1-1 lost its entire acceptance checklist. Everything below runs on the preinstalled PostgreSQL and is fully testable. The TypeScript half is brief P1-3b, written once `npm install` has run on the user's machine.

Do not write TypeScript in this brief. Do not touch `src/`.

## 0. Study first (in this order)

1. `docs/schema.md` — the P1-2 schema reference. This is your primary source for what exists.
2. `supabase/migrations/20260821000003_runs_and_assignments.sql`, `…0004_operator_capacity.sql`, `…0008_rls_policies.sql` — you will be building directly on these.
3. `docs/design-plan.md` **§3** (query shape), **§5** (edit flow, optimistic + 409), **§6** (eligibility, warn/block, expiry vs assignment dates), **§14.1** (hybrid rules), **§15.1** (capacity + the split-coverage flow), **§15.2** (run mobility), **§17/§17.1** (build locks and corrections).
4. `docs/mockups/model-hybrid.html` — for the *interaction* the split-coverage popover and run move must be able to support. You are building the data the mockup's UX needs, not the UX.
5. `supabase/tests/20_capacity_test.sql` — the existing test idiom you will extend.

Files are on the device at `<repo root>` (`$HOME/mnt/production_scheduler` for `device_bash`). Stage them with `device_stage_files` to read them in the container.

## 1. Environment (verified 2026-08-21 — read before planning)

- **No package-manager network.** npm, pip, apt all return **403** by policy. Do not attempt installs, do not hunt mirrors. You need none.
- PostgreSQL 16 is preinstalled: `/usr/lib/postgresql/16/bin/` (incl. `initdb`), client `/usr/bin/psql`, extensions `ltree`/`btree_gist`/`pgcrypto` present.
- **`initdb` refuses to run as root and you are root.** Use `runuser -u ubuntu -- /usr/lib/postgresql/16/bin/initdb -D /tmp/pgdata`, socket `/tmp/pgsock`, everything under `/tmp`.
- `scripts/verify-db.sh` from P1-2 already does the whole setup. Extend it; do not rewrite it.
- **PostgREST is not available here** (it needs Docker). One consequence is called out in §3.1 — read it, it is the single most important caveat in this brief.

## 2. Deliverables

```
supabase/
├─ migrations/
│  └─ 20260821000009_api_surface.sql      ← the only new migration
└─ tests/
   └─ 60_api_test.sql                     ← new
scripts/
└─ verify-db.sh                            ← extended to run 60_api_test.sql
docs/
└─ api.md                                  ← new: the client contract
```

Migrations stay **append-only**. 0009 uses `CREATE OR REPLACE FUNCTION` to amend P1-2's trigger functions; it never edits a P1-2 file.

## 3. The error contract

Every failure a supervisor can cause must arrive at the client as a *typed, machine-readable* payload — not a string the UI has to regex. This is what lets §5's optimistic edit revert with "Maria is already on Cell 7, 8:00–12:00" instead of a generic toast.

Define one shape, used by every raise in this migration. Put it in `DETAIL` as compact JSON (PostgREST surfaces `DETAIL` as the `details` field of its error body):

```json
{"error":"capacity_exceeded","operator_id":"…","peak":1.500,"cap":1.000,"timerange":"[…,…)"}
```

`error` is a stable machine code from this closed set — the client switches on it:

| `error` | Raised when | Extra fields |
|---|---|---|
| `capacity_exceeded` | operator's instantaneous peak would exceed the org cap | `operator_id`, `peak`, `cap`, `timerange` |
| `not_eligible` | operator lacks a required skill (or it expires inside the window) under `block` policy, or under `warn` policy without an explicit override | `operator_id`, `node_id`, `missing_skills[]`, `expiring_skills[]`, `policy` |
| `run_overlap` | a run would overlap another active run on the same node | `node_id`, `timerange`, `conflicting_run_id` |
| `run_node_mismatch` | an assignment's `node_id` ≠ its run's `node_id` | `assignment_node_id`, `run_node_id`, `run_id` |
| `not_permitted` | the caller lacks an edit grant on a node the operation touches | `node_id` |
| `invalid_argument` | malformed input to an RPC (bad jsonb shape, null where required, `timerange` empty or unbounded) | `field`, `reason` |

Write one helper and route every raise through it, so the shape cannot drift:

```sql
CREATE OR REPLACE FUNCTION api_raise(p_error text, p_message text, p_detail jsonb)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%', p_message
    USING ERRCODE = 'PT409',
          DETAIL  = (p_detail || jsonb_build_object('error', p_error))::text;
END $$;
```

Use `PT400` instead of `PT409` for `invalid_argument`, and `PT403` for `not_permitted`.

### 3.1 The one thing you cannot verify here — say so in your report

PostgREST maps a SQLSTATE of the form `PTxxx` to HTTP status `xxx`. That is why the codes above are `PT409`/`PT400`/`PT403`. **PostgREST is not running in this container, so you cannot prove that mapping holds.** Do not try to; do not install anything to try.

Two consequences, both required:

1. Your tests assert on **SQLSTATE and the parsed `DETAIL` JSON**, which you *can* verify with `psql`. They must not assert on HTTP status.
2. `docs/api.md` must state plainly that the HTTP-status mapping is unverified in this environment and needs confirming on a machine with Docker, and must specify that **the client switches on the `error` field of the parsed detail, never on the HTTP status** — so the contract holds even if the mapping turns out different. Put this in your report too.

### 3.2 Amend the P1-2 triggers

`CREATE OR REPLACE` these two so they route through `api_raise`:

- `check_operator_capacity()` — same peak query, **still verbatim from §15.1, still do not restructure it**; only the `RAISE` becomes `api_raise('capacity_exceeded', …)` carrying `operator_id`, `peak`, `cap`, `timerange`.
- `assignments_check_run_consistency()` — raise `run_node_mismatch` with the three ids.

The `runs_no_overlap_on_node` exclusion constraint raises `23P01` from the engine and cannot route through `api_raise`. Do not try to trap it in a trigger. Instead, `create_run` and `move_run` (§5) check for an overlapping run *before* writing and raise `run_overlap` themselves; the constraint stays as the race-safe backstop, and `docs/api.md` documents that a bare `23P01` on `runs` means the race was lost and the client should refetch and retry once.

## 4. Read functions

All `STABLE`, **`SECURITY INVOKER`** (RLS must still apply — this is the whole point), `SET search_path = public, pg_temp`.

### `board_window(p_root_path ltree, p_from timestamptz, p_to timestamptz) RETURNS jsonb`

The single board-load call from §3's query shape. One round trip, one payload. Returns a `jsonb` object with these keys — every array already filtered by RLS because the function is invoker-rights:

| Key | Contents |
|---|---|
| `org` | `{id, name, settings}` for the caller's org |
| `levels` | all `hierarchy_levels` rows, ordered by `position` |
| `nodes` | nodes under `p_root_path`, each `{id, parent_id, level_id, name, path, sort_order, active}`, ordered by `path` |
| `runs` | runs on those nodes intersecting `[p_from, p_to)` |
| `assignments` | assignments on those nodes intersecting the window |
| `operators` | the org roster: `{id, home_node_id, display_name, employee_ref, active, skill_ids[]}` |
| `products` | `{id, sku, name, active}` |
| `skills` | `{id, name}` |
| `node_skill_requirements` | `{node_id, skill_id}` — raw; the client computes the ancestor union |
| `shift_templates` | only templates resolved for the returned nodes, each with nested `shifts[]`, each with nested `breaks[]` |
| `node_shift_map` | `{node_id, template_id}` for every returned node, resolved via `resolve_shift_template` (so the client never walks ancestors itself) |

Guard rails: raise `invalid_argument` if `p_from >= p_to`, if either bound is NULL, or if the window exceeds **92 days** (a mis-typed date must not pull a year of history — the board never needs more, and §11's cost posture depends on it). Use `jsonb_agg(… ORDER BY …)` with `COALESCE(…, '[]'::jsonb)` so every key is always an array, never `null` — the client should never branch on that.

### `capacity_probe(p_operator_id uuid, p_timerange tstzrange, p_efficiency numeric, p_exclude_assignment_id uuid DEFAULT NULL) RETURNS jsonb`

Powers the split-coverage popover *before* the user commits, so the UI can open it pre-populated instead of opening it in response to a rejection. Returns:

```json
{"fits": false, "peak": 1.500, "cap": 1.000,
 "overlapping": [{"assignment_id":"…","node_id":"…","node_name":"Cell 7",
                  "product_name":"Widget X","timerange":"[…,…)","efficiency":1.000}]}
```

`peak` is computed by **the same instant-wise method as the trigger** — the peak the operator would reach if this assignment were added at `p_efficiency`. Do not write a second, subtly different implementation: extract the peak calculation from `check_operator_capacity()` into a shared `operator_peak_load(p_operator_id uuid, p_timerange tstzrange, p_efficiency numeric, p_exclude_assignment_id uuid) RETURNS numeric` and have **both** the trigger and this probe call it. Two implementations of that math will diverge, and the divergence will be a bug that only shows up as "the popover said it fit and the server said it didn't."

`overlapping` lists the operator's non-cancelled assignments intersecting `p_timerange` (excluding `p_exclude_assignment_id`), with the node and product names denormalised so the popover needs no follow-up query.

### `check_eligibility(p_node_id uuid, p_operator_id uuid, p_timerange tstzrange) RETURNS jsonb`

```json
{"eligible": true, "policy": "warn", "missing_skills": [], "expiring_skills": [{"id":"…","name":"CNC","expires_at":"2026-09-01"}]}
```

- Required skills = the **union along the node's ltree ancestors** (§6), not just the node's own row.
- `missing_skills` = required skills the operator does not hold at all.
- `expiring_skills` = held skills whose `expires_at` falls **before `upper(p_timerange)`** — checked against the assignment's window, not against `now()` (§6: "scheduling someone three weeks out fails if their cert lapses in two"). An unbounded upper bound counts as expiring for any non-null `expires_at`.
- `eligible` is `missing_skills = [] AND expiring_skills = []`.
- `policy` comes from `orgs.settings->>'eligibility_policy'`.

## 5. Write functions

All `VOLATILE`, **`SECURITY INVOKER`**, `SET search_path = public, pg_temp`. RLS and the P1-2 triggers remain the authority — these functions add the *contract*, not a second security layer. Every one of them returns the affected rows as `jsonb` so the client can reconcile its optimistic state without a refetch.

Before any write, each function checks `app_can_edit_node()` on **every** node it touches and raises `not_permitted` if the check fails. RLS would refuse anyway; raising first turns a silent zero-row result into a typed error.

### `create_run(p_node_id uuid, p_product_id uuid, p_timerange tstzrange, p_planned_headcount int DEFAULT NULL, p_notes text DEFAULT NULL) RETURNS jsonb`

Pre-checks for an overlapping active run on the node → `run_overlap` with `conflicting_run_id`. Sets `created_by = auth.uid()`. Returns `{"run": {…}}`.

### `create_assignment(p_node_id uuid, p_operator_id uuid, p_run_id uuid, p_product_id uuid, p_timerange tstzrange, p_efficiency numeric DEFAULT 1.000, p_target_qty numeric DEFAULT NULL, p_target_unit text DEFAULT NULL, p_eligibility_override boolean DEFAULT false, p_override_reason text DEFAULT NULL) RETURNS jsonb`

The eligibility gate, which is the substantive logic here:

- Call `check_eligibility`. If `eligible`, proceed.
- If not eligible and policy is **`block`** → raise `not_eligible`. No override is possible; that is what `block` means.
- If not eligible and policy is **`warn`**:
  - `p_eligibility_override = false` → raise `not_eligible` with `policy: "warn"`. The client shows the override prompt and retries with the flag. **Never silently allow it** — an override that the supervisor did not consciously make is not an override.
  - `p_eligibility_override = true` → insert with `eligibility_override = true` and `override_reason = p_override_reason`.
- Capacity is *not* pre-checked here — the trigger owns it, and it is the race-safe authority. The client calls `capacity_probe` first if it wants to open the split popover proactively.

Returns `{"assignment": {…}, "eligibility": {…}}` — the eligibility result rides along so the UI can badge a warn-override block without a second call.

### `move_run(p_run_id uuid, p_node_id uuid, p_timerange tstzrange) RETURNS jsonb`

§15.2, atomically. `p_node_id` may equal the current node (a pure time move) and `p_timerange` may equal the current range (a pure cell move).

1. Edit rights on **both** the source and target node, else `not_permitted`.
2. Target node must have no other overlapping active run → `run_overlap`.
3. Update the run.
4. Update **every attached assignment's** `node_id` to the target and shift its `timerange` by the same delta as the run's start (the crew follows — §15.2). An assignment that extended beyond the run's old bounds keeps its own duration; clamp nothing.
5. Re-check eligibility for each crew member against the target node. Under `block`, any ineligible crew member aborts the whole move with `not_eligible` listing every affected operator. Under `warn`, the move succeeds and the offenders are returned as warnings **and** marked `eligibility_override = true` with `override_reason = 'run moved to <node name>'`.

Order matters: update the run before the assignments, so `assignments_check_run_consistency` sees the new node.

Returns `{"run": {…}, "assignments": [ … ], "eligibility_warnings": [{"operator_id":"…","missing_skills":[…]}]}`.

### `apply_split_coverage(p_adjustments jsonb, p_new_assignment jsonb) RETURNS jsonb`

The §15.1 split-coverage commit. `p_adjustments` is `[{"assignment_id":"…","efficiency":0.500}, …]` — the existing assignments the supervisor dialled down. `p_new_assignment` is the same argument object `create_assignment` takes.

**Apply the adjustments first, then the new assignment.** The capacity trigger fires per row, so inserting first would trip the cap against the un-adjusted state and the whole transaction would fail even though the end state is legal. This ordering is the entire reason this function exists rather than the client sending three separate writes. Put that reasoning in a comment — the next person to "optimise" this will otherwise reorder it.

`p_new_assignment` may be `null` (pure rebalance with no new work). Validate both arguments' shapes and raise `invalid_argument` naming the offending field. Returns `{"adjusted": [ … ], "assignment": {…}|null}`.

### `delete_run(p_run_id uuid, p_mode text DEFAULT 'cascade') RETURNS jsonb`

The FK from `assignments` has no `ON DELETE`, so a run with crew cannot simply be deleted. Two modes:

- `'cascade'` — delete the run's assignments, then the run.
- `'detach'` — convert each attached assignment to a **direct** assignment carrying the run's product (`run_id = NULL, product_id = <run's product>`), then delete the run. This is the hybrid model earning its keep (§14.1): the run goes away, the staffing survives. Note the `num_nonnulls(run_id, product_id) = 1` check makes the naive "just null the run_id" impossible — that check is what forces this to be a deliberate choice.

Any other `p_mode` → `invalid_argument`. Returns `{"deleted_run_id":"…","detached_assignment_ids":[…]}`.

### Not RPCs — deliberately

Simple field edits (a run's `notes` or `planned_headcount`; an assignment's `efficiency`, `target_qty`, `target_unit`, `status`; a plain time resize that does not change node) go through **ordinary PostgREST table updates**. RLS and the capacity trigger still guard them, and the error contract still applies because §3.2 amended the trigger itself. Do not write CRUD wrappers for these. Document in `docs/api.md` which operations take which path and why.

## 6. Grants

Guarded the same way migration 0008 does it:

```sql
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION board_window(ltree,timestamptz,timestamptz) TO authenticated';
    -- … one line per function in §4 and §5 …
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION … FROM anon';  -- every function
  END IF;
END $$;
```

`operator_peak_load` and `api_raise` are internal helpers: grant them to `authenticated` only if a granted function's invoker-rights execution requires it (it does — invoker rights means the caller's privileges apply), but state in `docs/api.md` that they are not part of the client contract.

## 7. `docs/api.md`

One page, written for whoever builds P1-3b. Sections: every function with signature, arguments, return shape (a real JSON example, not a prose description), and which errors it can raise · the full error-code table from §3 · the §3.1 caveat about the unverified HTTP mapping and the rule that clients switch on `error`, never on status · which operations use RPC vs. plain PostgREST table writes and why · the `23P01`-means-you-lost-the-race note · a worked end-to-end example of the split-coverage flow (probe → popover → `apply_split_coverage`) with actual payloads.

## 8. Acceptance checklist

Extend `scripts/verify-db.sh` to run `60_api_test.sql` after `50_audit_test.sql`. Same assertion idiom as P1-2 (`DO $$ … RAISE EXCEPTION 'FAIL: …' … $$`, savepoints around cases that provoke errors, `\echo` naming each case). Paste the full output in your report.

**board_window**
1. As Admin over `plant_1`, a window covering the seed week returns all 7 cells, all 8 runs, all 12 assignments, and `node_shift_map` giving `3 × 8h` for Cells 1–5 and `2 × 10h` for Cells 6–7.
2. As Ana, the same call returns Cells 1–5 only, and only Assembly runs/assignments — RLS survives the function boundary. This is the single most important test in this brief: a `SECURITY DEFINER` slip here would silently expose every tenant.
3. Every key is present and array-valued even when empty (query a window in 2030 → arrays empty, no nulls, no error).
4. `p_from >= p_to` → `invalid_argument`; a 100-day window → `invalid_argument`; a 92-day window → succeeds.
5. `shift_templates` includes nested `shifts[]` with nested `breaks[]`, and the overnight Shift 3 is present with `end_min` 1800.

**capacity_probe / operator_peak_load**
6. Probe Aisha (seeded at 0.5 + 0.5) for another 0.5 in the same window → `fits: false`, `peak` 1.5, `overlapping` lists both existing assignments with node and product names.
7. Probe the same for 0.0-adjacent window → `fits: true`.
8. The §15.1 60/60/40 case through the probe reports peak exactly 1.0 and `fits: true`; the 60/60/50 case reports exactly **1.1** and `fits: false` — same numbers the trigger produces, proving the shared helper is genuinely shared.
9. **Prove it is one implementation, not two:** break `operator_peak_load` (make it return 0) and confirm *both* `20_capacity_test.sql` and case 8 fail. Restore it afterwards. Report this result.

**check_eligibility**
10. Maria on Cell 6 → eligible. Elena on Cell 6 → `missing_skills` contains `CNC` (inherited from CNC Line, D11). Elena on Cell 1 → eligible.
11. Give Maria's CNC cert an `expires_at` inside a future window → she is ineligible for that window but still eligible for a window ending before the expiry. This is the §6 requirement that expiry is checked against the assignment dates, not today.

**create_assignment / eligibility gate**
12. Under `warn` (seed default): Elena on Cell 6 without override → `not_eligible` with `policy: "warn"`. With `p_eligibility_override = true` → succeeds, row has `eligibility_override = true` and the reason stored.
13. Flip `orgs.settings->>'eligibility_policy'` to `block`: the same call **with** override → still `not_eligible`. Restore to `warn`.
14. A capacity-exceeding create raises SQLSTATE `PT409` and a `DETAIL` that parses as JSON with `error = "capacity_exceeded"` and a numeric `peak`. Assert on the parsed JSON, not on the message string.

**move_run**
15. As Admin, move the Tuesday Cell 1 Widget X run to Cell 2 → run and all its assignments now on Cell 2, `assignments_check_run_consistency` never fires, crew timeranges shifted by the same delta.
16. Move it onto a cell that already has an overlapping run → `run_overlap` with `conflicting_run_id`, and **nothing is changed** (assert the run's node afterwards).
17. Move an Assembly run to a Machining cell as Ana → `not_permitted` (she has edit rights on the source, not the target).
18. Under `warn`, move a run whose crew lacks the target's skills → succeeds, `eligibility_warnings` non-empty, affected assignments marked overridden. Under `block` → `not_eligible` and nothing changes.

**apply_split_coverage**
19. The canonical flow: an operator at 1.0 on Cell 1, supervisor wants them on Cell 2 for an overlapping window. `apply_split_coverage([{existing → 0.5}], {new at 0.5})` succeeds and the end state is peak exactly 1.0.
20. **Prove the ordering matters:** the same end state attempted as insert-then-adjust fails. Demonstrate it explicitly in the test (insert first inside a savepoint, observe `PT409`, roll back) so the comment in the function is backed by a test rather than a claim.
21. Malformed `p_adjustments` (missing `efficiency`) → `invalid_argument` naming the field.
22. `p_new_assignment = null` with valid adjustments → pure rebalance succeeds.

**delete_run**
23. `'cascade'` on a staffed run removes run and crew.
24. `'detach'` on a staffed run removes the run and leaves the assignments as direct ones carrying the run's product, satisfying `num_nonnulls = 1`.
25. `p_mode = 'wat'` → `invalid_argument`.

**Contract-wide**
26. Every function in §4/§5 is `SECURITY INVOKER` — assert programmatically over `pg_proc.prosecdef` that none of them is definer-rights. (`api_raise` and the P1-2 audit trigger are the permitted exceptions; assert the exact allow-list rather than skipping the check.)
27. As `anon`, every function raises permission-denied.
28. Every raise from §3.2 and §5 produces a `DETAIL` that parses as valid JSON containing an `error` key from the §3 closed set. Iterate the set; do not spot-check.

## 9. Required: mutation-test your own suite

A suite written alongside the implementation can pass vacuously. Before reporting, break each of these and confirm the named test fails, then restore:

- `operator_peak_load` returns 0 → capacity cases fail (this is acceptance item 9).
- `board_window` changed to `SECURITY DEFINER` → item 2 fails.
- The eligibility gate in `create_assignment` short-circuited to always-allow → item 12 fails.
- `apply_split_coverage` reordered to insert-before-adjust → item 19 fails.

Mutate the **live scratch database** with `CREATE OR REPLACE`, never the migration files, so nothing needs restoring on disk. Report each mutation and the exact failure message it produced. **A mutation that does not produce a failure means the test is vacuous — fix the test, and say so in your report.**

## 10. Delivery

As P1-2 §8: tar `supabase/`, `scripts/`, `docs/api.md` **only** (never the whole `docs/`) → `SendUserFile` → `device_commit_files` to `…\production_scheduler\_delivery\api.tar.gz` → `device_bash` to extract in place → `git status --short`. Write `docs/api.md` and the roadmap edit via `device_bash` heredocs. **Do not commit or push.** Do not run any npm script.

## 11. Required final step

Edit `docs/roadmap.md`: update the Phase 1 API-layer line to note that the database half is built and the TypeScript half is brief P1-3b, refresh **Last updated**, add `docs/api.md` and migration 0009 to the artifact index, and update the Phase 1 brief queue's P1-3 row (splitting it into P1-3a done / P1-3b pending). Leave the P1-1 row untouched — it is deliberately unticked because its build could not be validated.

## 12. Report format

Report: every function you created with its final signature · the full `verify-db.sh` output · the §9 mutation results with exact failure messages · the §3.1 caveat restated (which mapping is unverified and what confirms it) · every assumption where this brief was silent · anything left undone. Report failed items as failed with the error text rather than working around them.

---

## Appendix — scope note for brief P1-3b (do not build this now)

Recorded here so the boundary is not re-litigated. P1-3b covers, once npm works: `src/lib/api/` typed wrappers over these RPCs · a `SchedulerError` discriminated union parsing the §3 payloads · generated `database.types.ts` · TanStack Query hooks in `src/features/board/hooks/` with the §5 optimistic-update + rollback-on-error pattern · Vitest coverage of the error parser against fixtures captured from *this* brief's tests. It does **not** cover realtime subscriptions, which are their own brief.
