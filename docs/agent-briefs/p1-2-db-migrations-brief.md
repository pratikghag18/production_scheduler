# Agent Brief P1-2 — Database Migrations, RLS, Audit, Seed

**Executor:** a fresh Sonnet agent (no prior context). **Phase:** 1, second build task.
**Depends on:** brief P1-1 (repo scaffold) being on disk — you write into `supabase/` in that repo.
**Rules:** no design decisions of your own. Every open question this touches is answered below; where the design plan and this brief differ, **this brief wins** (the deltas are listed in §2 and you must echo them in your report). Note assumptions; do not ask questions mid-run.

## 0. Study first (in this order)

1. `docs/design-plan.md` — **§3** (core tables, query shape), **§6** (skills/eligibility), **§9** (tenancy, roles), **§14.2/§14.3** (efficiency, target, profiles, grants), **§15.1** (capacity model — the SQL there is already validated, do not redesign it), **§16.1** (shift model).
2. `docs/roadmap.md` — Phase 1 item 3 is this task.
3. `docs/mockups/model-hybrid.html` — lines ~385–560 hold the seed constants (`PRODUCTS`, `OPERATORS`, `TREE`, `SHIFT_TEMPLATES`, `nodeShiftTemplates`, `PROFILES`, `runs`, `assignments`). The seed you write in §6 mirrors these exactly.

Files live on the user's device at `<repo root>` (mounted for `device_bash` at `$HOME/mnt/production_scheduler`). Stage them with `device_stage_files` to read them in the container.

**Important:** the design plan is a *narrative* record — it shows the schema evolving (a `no_double_booking` constraint that §15.1 later drops, `ALTER TABLE`s in §14.2 that add columns). Your migrations implement the **final shape only**. Do not replay history: no dropped constraint, no add-column-later. Migration 0001 is a fresh database, not a replay of design sessions.

## 1. Deliverables

```
supabase/
├─ migrations/
│  ├─ 20260821000001_extensions_and_core.sql
│  ├─ 20260821000002_people_products_skills.sql
│  ├─ 20260821000003_runs_and_assignments.sql
│  ├─ 20260821000004_operator_capacity.sql
│  ├─ 20260821000005_shifts.sql
│  ├─ 20260821000006_profiles_and_grants.sql
│  ├─ 20260821000007_audit_log.sql
│  └─ 20260821000008_rls_policies.sql
├─ seed.sql
└─ tests/
   ├─ 00_harness.sql          ← test-only auth shim, NEVER a migration
   ├─ 10_constraints_test.sql
   ├─ 20_capacity_test.sql
   ├─ 30_shifts_test.sql
   ├─ 40_rls_test.sql
   └─ 50_audit_test.sql
scripts/
└─ verify-db.sh
docs/
└─ schema.md                  ← one page: table list, what each is for, the four invariants
```

Migrations are **append-only** from here on. Anything you get wrong is fixed by a new migration, never by editing one that has run — state that at the top of `docs/schema.md`.

Every migration starts with a comment block naming the design-plan section it implements.

## 2. Decisions this brief makes (deltas from the design plan — echo these in your report)

| # | Decision | Why |
|---|---|---|
| D1 | `user_profiles.user_ref text` becomes **`user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE`**, `UNIQUE (org_id, user_id)` | The stack is Supabase Auth (§5). A text ref would need a second lookup on every RLS check. |
| D2 | Capacity cap is read from **`orgs.settings->>'capacity_cap'`**, defaulting to `1.0`, not hardcoded | §15.1 flagged this as "final build: read from orgs.settings". This is the final build. |
| D3 | **Composite tenant FKs** everywhere: parent tables get `UNIQUE (org_id, id)`; child FKs are `(org_id, parent_id) REFERENCES parent (org_id, id)` | Makes cross-tenant row stitching structurally impossible, not just RLS-impossible. Costs one index per parent. |
| D4 | `runs` gets `EXCLUDE USING gist (node_id WITH =, timerange WITH &&) WHERE (status <> 'cancelled')` | §15.2 requires "the target cell must have no overlapping run" when a run moves. That is a database invariant, not a UI check. |
| D5 | `assignments` gets `CHECK (num_nonnulls(run_id, product_id) = 1)` | §14.1: run-attached assignments inherit product from the run; direct assignments carry their own. Exactly one, never both, never neither. |
| D6 | `nodes.path` is **maintained by a trigger** (slugified name appended to parent path, cascading to descendants on move/rename), not by the application | The application enforces *level* rules (§2, deliberately). Path is mechanical derivation — leaving it to the app guarantees drift. |
| D7 | `org_id` is carried on `shifts`, `shift_breaks`, and `node_shift_templates` even though it is derivable | §3's rule is "every tenant-scoped table carries `org_id`". Uniform RLS beats a saved column. |
| D8 | `operators`, `products`, and `skills` are readable **org-wide** under RLS; the subtree grant restricts which rows a user may *write* and which nodes they may see | A supervisor must be able to render "Maria is already on Cell 7" even when Cell 7 is outside their grant. Filtering the *assignable* roster to the granted subtree (§14.3) is a UI/API concern, not an RLS one. |
| D9 | `audit_log` is **admin-read-only** in v1 | Supervisor-scoped audit reads need a node-path join on every row; not worth it before anyone has asked. |
| D10 | Seed anchors day 0 to **the Monday of the current week, in UTC**, so the board always has data on load | The mockup hardcodes Mon–Wed Aug 17–19. Timezone-per-site is not decided; UTC is the honest placeholder. Flag it in `docs/schema.md` as a known deferral. |
| D11 | The CNC skill requirement attaches to the **CNC Line** node, not to Cells 6 and 7 individually | The mockup put it on the cells; attaching one level up is equivalent in effect and exercises the §6 ancestor-inheritance query in the seed itself. |
| D12 | Shift non-overlap within a template becomes an exclusion constraint; nearest-ancestor resolution ships as the `resolve_shift_template(node)` function | §16.3 requires this validation on save — as an invariant, the admin editor is no longer the only thing enforcing it. |

These are recorded in `docs/design-plan.md` §17 with the same numbering; if you find §17 and this table disagreeing, §17 is the record and you should flag the drift rather than pick one.

## 3. Migration contents

### 0001 — extensions and core

- `CREATE EXTENSION IF NOT EXISTS ltree;` and `btree_gist`.
- `set_updated_at()` trigger function (`NEW.updated_at := now(); RETURN NEW;`) — used by later migrations.
- `slugify(text) returns text` — immutable; lowercases, replaces every run of non-`[a-z0-9]` with `_`, trims leading/trailing `_`, and prefixes `n_` if the result starts with a digit or is empty. ltree labels accept only `A-Za-z0-9_`, so this must be airtight; test it in `10_constraints_test.sql` with `"Cell 1"`, `"CNC Line"`, `"3 × 8h"`, `"  "`, and `"2nd Shift"`.
- `orgs` per §3, with `settings` default:
  ```sql
  settings jsonb NOT NULL DEFAULT
    '{"capacity_cap": 1.0, "eligibility_policy": "warn", "week_start": 1, "default_snap_minutes": 30}'::jsonb
  ```
  Add `CHECK ((settings->>'capacity_cap')::numeric > 0)` and `CHECK (settings->>'eligibility_policy' IN ('warn','block'))`.
- `hierarchy_levels` per §3, plus a partial unique index enforcing **at most one schedulable level per org**:
  `CREATE UNIQUE INDEX hierarchy_levels_one_schedulable ON hierarchy_levels (org_id) WHERE is_schedulable;`
- `nodes` per §3, plus `UNIQUE (org_id, id)` (D3), `created_at`/`updated_at`, and the path trigger (D6):
  - `BEFORE INSERT OR UPDATE OF name, parent_id`: `NEW.path := CASE WHEN NEW.parent_id IS NULL THEN slugify(NEW.name)::ltree ELSE (SELECT path FROM nodes WHERE id = NEW.parent_id) || slugify(NEW.name)::ltree END;`
  - `AFTER UPDATE OF path`: when `OLD.path <> NEW.path`, rewrite descendants — `UPDATE nodes SET path = NEW.path || subpath(path, nlevel(OLD.path)) WHERE path <@ OLD.path AND id <> NEW.id;` Guard against recursion with `pg_trigger_depth() = 1` or a `WHEN (OLD.path IS DISTINCT FROM NEW.path)` clause plus the `id <> NEW.id` filter.
  - Make `path` `NOT NULL` but never require callers to supply it — inserts pass `name` and `parent_id` only.
- Indexes from §3: `nodes_path_idx` (gist), `nodes_org_parent_idx`.
- **Do not** enforce "parent is exactly one level above" in the schema — §2 says that stays in the application so hierarchy edits stay cheap. Put a comment saying so, so nobody adds it later thinking it was an oversight.

### 0002 — people, products, skills

`operators`, `products` (§3) and `skills`, `operator_skills`, `node_skill_requirements` (§6). Add to each: `UNIQUE (org_id, id)` where it will be referenced (D3), `created_at`/`updated_at` with the shared trigger, and `org_id` on `operator_skills` and `node_skill_requirements` (D7 pattern) with composite FKs. `operators.home_node_id` uses the composite FK to `nodes (org_id, id)`. Index `operators (org_id, home_node_id)` — the roster panel filters on it.

### 0003 — runs and assignments

Final shape, §3 + §14.2 folded together:

- `runs`: §3 columns plus `created_by uuid`, `created_at`, `updated_at` (+ trigger), `UNIQUE (org_id, id)`, composite FKs to `nodes` and `products`, `CHECK (status IN ('planned','active','done','cancelled'))`, the `runs_node_time_idx` gist index, and the D4 exclusion constraint.
- `assignments`: §3 columns **plus** `efficiency numeric(4,3) NOT NULL DEFAULT 1.000 CHECK (efficiency > 0 AND efficiency <= 2)`, `target_qty numeric CHECK (target_qty > 0)`, `target_unit text`, `eligibility_override boolean NOT NULL DEFAULT false`, `override_reason text`, `created_at`, `updated_at` (+ trigger). Composite FKs to `nodes`, `operators`, `runs`, `products`. The D5 check. **No `no_double_booking` exclusion constraint** — it was superseded before it shipped; add a comment saying migration 0004 owns that invariant.
- `assignments_run_consistency` trigger (BEFORE INSERT OR UPDATE OF `run_id`, `node_id`): when `run_id IS NOT NULL`, `node_id` must equal the run's `node_id` — raise otherwise with a message naming both. This is what keeps a run's crew on the run's cell when the run moves (§15.2); the API moves run and crew together, the database refuses the half-move.
- Indexes: `assignments_node_time_idx` (gist), `assignments_operator_idx`, plus `assignments_run_idx (run_id) WHERE run_id IS NOT NULL`.

### 0004 — operator capacity

Take the `check_operator_capacity()` function and trigger from design plan §15.1 **verbatim**, with exactly one change: replace `cap numeric := 1.0;` with a lookup —

```sql
SELECT COALESCE((o.settings->>'capacity_cap')::numeric, 1.0) INTO cap
FROM orgs o WHERE o.id = NEW.org_id;
```

placed after the `status = 'cancelled'` early return and before the advisory lock. **Do not restructure the peak query.** It was validated against live PostgreSQL 16 and the instant-wise math is subtle: the 60/60/40 case must pass at peak 1.0 while 60/60/50 fails at peak 1.1, where a naive sum would report 1.7. If you "simplify" it you will silently break that and your tests in `20_capacity_test.sql` will tell you so.

Improve only the error surface: raise with `ERRCODE = 'check_violation'` and a message of the form `capacity exceeded: operator %s would reach %s (cap %s)`, and add `USING DETAIL` carrying the operator id and peak so the API layer can build the split-coverage popover (§15.1) without re-querying.

### 0005 — shifts

`shift_templates`, `shifts`, `shift_breaks`, `node_shift_templates` per §16.1, plus `org_id` on all four (D7) with composite FKs, and `updated_at` triggers. Keep the §16.1 CHECKs exactly (`end_min > start_min`, duration ≤ 1440, `start_min` in `[0,1440)`) — note `shifts.end_min` is deliberately allowed above 1440 for overnight shifts, and `shift_breaks` uses the same coordinate space.

Add two things §16 describes but does not spell out in SQL:

1. `shifts_no_overlap_within_template` — an exclusion constraint on `(template_id WITH =, int4range(start_min, end_min) WITH &&)`. §16.3 requires non-overlapping shifts within a template on save; make it a database invariant.
2. `resolve_shift_template(p_node_id uuid) returns uuid` — `STABLE`, nearest-ancestor-wins:
   ```sql
   SELECT nst.template_id
   FROM nodes target
   JOIN nodes anc ON target.path <@ anc.path AND anc.org_id = target.org_id
   JOIN node_shift_templates nst ON nst.node_id = anc.id
   WHERE target.id = p_node_id
   ORDER BY nlevel(anc.path) DESC
   LIMIT 1;
   ```
   Breaks-inside-their-shift stays application-validated per §16.1 — comment it.

### 0006 — profiles and grants

`user_profiles` per §14.3 with D1 applied, plus `created_at`/`updated_at`, `CHECK (role IN ('admin','supervisor','viewer'))`, and index `user_profiles (user_id)` (every RLS check hits it). `profile_grants` per §14.3 plus `org_id` and composite FKs, and index `profile_grants (profile_id)`.

### 0007 — audit log

```sql
CREATE TABLE audit_log (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id     uuid NOT NULL REFERENCES orgs(id),
  actor_id   uuid,                    -- auth.uid() at write time; NULL for seed/system writes
  table_name text NOT NULL,
  row_id     uuid NOT NULL,
  action     text NOT NULL CHECK (action IN ('insert','update','delete')),
  before     jsonb,
  after      jsonb,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_org_at_idx ON audit_log (org_id, at DESC);
CREATE INDEX audit_log_row_idx ON audit_log (table_name, row_id);
```

One `SECURITY DEFINER` trigger function `write_audit_log()` attached AFTER INSERT/UPDATE/DELETE FOR EACH ROW on **`runs` and `assignments`** (only those two in v1 — schedule mutations are what §14.4 promised to audit). `actor_id` comes from `auth.uid()` wrapped so it never throws when `auth` is absent. On UPDATE, skip writing a row when `to_jsonb(OLD) = to_jsonb(NEW)`.

### 0008 — RLS policies

Helper functions first, all `STABLE SECURITY DEFINER SET search_path = public, pg_temp`:

- `app_current_profile_id() returns uuid` — `SELECT id FROM user_profiles WHERE user_id = (SELECT auth.uid()) LIMIT 1`
- `app_current_org() returns uuid`
- `app_is_admin() returns boolean` — role = `'admin'`
- `app_can_write() returns boolean` — role IN (`'admin'`,`'supervisor'`)
- `app_grant_paths(require_edit boolean) returns setof ltree` — the granted nodes' paths for the current profile, filtered by `can_edit` when `require_edit`
- `app_can_read_node(p_node uuid) returns boolean` — `app_is_admin() OR EXISTS (SELECT 1 FROM nodes n, app_grant_paths(false) gp WHERE n.id = p_node AND n.path <@ gp)`
- `app_can_edit_node(p_node uuid) returns boolean` — same with `app_can_write()` and `app_grant_paths(true)`

Always write `(SELECT auth.uid())` rather than bare `auth.uid()` — the scalar subquery is evaluated once per statement instead of once per row, which is the difference between a fast board query and a slow one.

Enable RLS on **every** table created in 0001–0007. Policies:

| Table | SELECT | INSERT / UPDATE / DELETE |
|---|---|---|
| `orgs` | `id = app_current_org()` | admin only |
| `hierarchy_levels` | org match | admin only |
| `nodes` | org match AND `app_can_read_node(id)` | admin only |
| `operators`, `products`, `skills`, `operator_skills`, `node_skill_requirements` | org match (D8) | admin only |
| `runs`, `assignments` | `app_can_read_node(node_id)` | `app_can_edit_node(node_id)` — `USING` on the old row, `WITH CHECK` on the new one, so a cross-cell move (§15.2) requires edit rights on **both** cells |
| `shift_templates`, `shifts`, `shift_breaks`, `node_shift_templates` | org match | admin only |
| `user_profiles` | `user_id = (SELECT auth.uid())` OR (`app_is_admin()` AND org match) | admin only |
| `profile_grants` | own profile OR admin | admin only |
| `audit_log` | `app_is_admin()` AND org match (D9) | no policy — writes arrive only through the `SECURITY DEFINER` trigger |

Then, guarded so the file also runs on a scratch Postgres that may lack the Supabase roles:

```sql
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA public TO authenticated';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon';
  END IF;
END $$;
```

Never `FORCE` RLS on tables the audit trigger writes to, and remember the table owner bypasses RLS — that is why §4's tests must run as `authenticated`, not as the superuser.

## 4. What this brief does NOT cover

Auth UI · the API/board-window query layer (a later brief owns `board_window()`) · realtime publication config · Copy Week / templates (Phase 2) · `assignments_archive` and the retention job (§3, deferred) · `integration_connections` (Phase 3) · partitioning (§3, explicitly deferred). Do not create tables for any of these.

## 5. Validation — scratch Postgres, because Docker is not available

> **Environment facts, verified in this container on 2026-08-21 — read before you plan anything.**
>
> - **There is no package-manager network access.** `registry.npmjs.org`, `pypi.org`, `archive.ubuntu.com`, and `download.docker.com` all return **403 Forbidden** through the egress proxy. `npm install`, `pip install`, and `apt-get install` cannot succeed. Brief P1-1 lost most of its acceptance run to this. **Do not attempt any install, and do not hunt for mirrors — the denial is policy, not a transient failure.** If you conclude you need to install something, stop and report that instead.
> - **You do not need to.** PostgreSQL 16 is already present: binaries at `/usr/lib/postgresql/16/bin/` (including `initdb`), client at `/usr/bin/psql`, and the extensions this schema needs — `ltree`, `btree_gist`, `pgcrypto` — are all in `/usr/share/postgresql/16/extension/`.
> - **`initdb` refuses to run as root, and you are root.** Use the existing non-root user `ubuntu` (uid 1000): `runuser -u ubuntu -- /usr/lib/postgresql/16/bin/initdb -D /tmp/pgdata`. Keep the data directory and socket somewhere `ubuntu` can write (`/tmp/pgdata`, `/tmp/pgsock`), not under `/home/claude`.
> - **Nothing in this brief needs npm.** Type generation is explicitly out of scope (§8), so the npm blockage does not block you. If it somehow does, that is a signal you have wandered outside the brief.

`supabase start` needs Docker; this container has none. Validate against a locally-initialised PostgreSQL instead. `scripts/verify-db.sh` must do all of this, idempotently, and be re-runnable:

1. Locate the preinstalled PostgreSQL 16 binaries (see the environment note above). Verify with `psql --version` and report it. Do **not** install anything; if the binaries are missing, stop and report rather than trying to fetch them.
2. `initdb` **as `ubuntu`, not root** into `/tmp/pgdata`, start with `-k /tmp/pgsock -h ''` (unix socket only, no TCP). `chmod 0777 /tmp/pgsock` so root can connect to it too.
3. `createdb scheduler_test`.
4. Apply `supabase/tests/00_harness.sql` — the **test-only** auth shim. It must live only here, never in `migrations/`:
   ```sql
   CREATE SCHEMA IF NOT EXISTS auth;
   CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY, email text);
   CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
     SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
   DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated')
       THEN CREATE ROLE authenticated NOLOGIN; END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon')
       THEN CREATE ROLE anon NOLOGIN; END IF;
   END $$;
   ```
5. Apply every migration in filename order with `psql -v ON_ERROR_STOP=1`.
6. Apply `supabase/seed.sql`.
7. Run every `supabase/tests/[1-9]*.sql` in order with `ON_ERROR_STOP=1`.
8. Print a summary and exit non-zero on any failure.

Write test assertions as `DO $$ BEGIN IF NOT (<condition>) THEN RAISE EXCEPTION 'FAIL: <what>'; END IF; END $$;`, each preceded by a `\echo` naming the case, so a failure reads like a test report. Use savepoints (`BEGIN; SAVEPOINT s; ... ROLLBACK TO s;`) so tests that provoke exceptions leave the seed intact. Structure them to be portable to pgTAP + `supabase test db` later; do not add a pgTAP dependency now.

RLS tests switch identity with:
```sql
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a2';
```
and reset with `RESET ROLE;`.

## 6. Seed data — mirror the mockup exactly

Read the constants out of `docs/mockups/model-hybrid.html` and translate them. Use fixed UUIDs for anything a test references. Day 0 = `date_trunc('week', current_date)::timestamptz` (Monday, UTC — D10); write a `seed_t(day int, minute int)` local helper so the ranges read like the mockup's `T(1, 360)`.

- **Org:** `Northwind Manufacturing`, default settings.
- **Levels:** `0 Site` · `1 Department` · `2 Line` · `3 Work Cell` (**`is_schedulable`**). The mockup starts at Department; the design's default vocabulary is Site → Department → Line → Work Cell (§1), so add the Site root.
- **Nodes:** Site `Plant 1` → `Assembly`, `Machining`; Assembly → `Line 1`, `Line 2`; Machining → `CNC Line`; Line 1 → `Cell 1..3`, Line 2 → `Cell 4..5`, CNC Line → `Cell 6..7`. Let the D6 trigger compute every path; assert afterwards that Cell 6's path is `plant_1.machining.cnc_line.cell_6`.
- **Skills:** `CNC`; requirement attached to the **CNC Line** node (D11).
- **Operators** (9, from the mockup): Maria, Raj, Aisha — skill `CNC`, home `Machining`; Elena, Tom, Ben, Lily, Sam, Noah — no skills, home `Assembly`. `employee_ref` = `EMP-001`…`EMP-009`, `source = 'manual'`.
- **Products:** `WX` Widget X · `WY` Widget Y · `GZ` Gadget Z · `RW` Rework. Colors are a UI concern and do **not** go in the database — the products table has no color column and must not gain one; the client maps sku → token (`--product-1`…`--product-4`, brief P1-1 §4).
- **Shift templates:** `3 × 8h` and `2 × 10h` with the exact shifts and breaks from `SHIFT_TEMPLATES` (including the two overnight shifts: Shift 3 `1320→1800`, Nights `960→1560`). Attachments: `Assembly → 3 × 8h`, `CNC Line → 2 × 10h` (mirrors `nodeShiftTemplates`).
- **Runs** (8) and **assignments** (12): exactly the mockup's `runs` and `assignments` arrays, efficiencies converted from percent to the numeric scale (`eff: 50` → `0.500`), Ben's `target_qty = 500, target_unit = 'units'`. Aisha's two 50% direct assignments on Cells 4 and 5 in the same window are the load-bearing case: they must insert cleanly at a peak of exactly 1.0. If your seed cannot insert them, the capacity trigger is wrong — fix the trigger, do not change the seed.
- **Users and profiles** (from `PROFILES`), with a comment marking the `auth.users` inserts as local-dev only — production identities come from Supabase Auth signup:

  | user_id | name | role | grant | default_create_mode |
  |---|---|---|---|---|
  | `…0000a1` | Admin | `admin` | `Plant 1` (root), can_edit | `run` |
  | `…0000a2` | Ana — Assembly supervisor | `supervisor` | `Assembly`, can_edit | `run` |
  | `…0000a3` | Marco — Machining supervisor | `supervisor` | `Machining`, can_edit | `direct` |

  (Full UUIDs: `00000000-0000-0000-0000-0000000000a1/a2/a3`.) Insert with `ON CONFLICT DO NOTHING` so `npm run db:reset` is repeatable.

The whole seed must be idempotent-safe under `supabase db reset` and must not depend on the audit trigger being disabled — audit rows for seed writes are expected (`actor_id` NULL).

## 7. Acceptance checklist

`scripts/verify-db.sh` must exercise every item and print a pass line for each. Paste its full output in your report.

**Constraints (`10_`)**
1. `slugify` cases from §3 all produce valid ltree labels.
2. Path trigger: inserting the tree yields the expected paths; renaming `Line 1` → `Line One` rewrites all three of its cells' paths; re-parenting `Cell 3` to `Line 2` updates its path.
3. Two schedulable levels in one org → rejected.
4. `assignments` with both `run_id` and `product_id` → rejected; with neither → rejected.
5. Assignment whose `node_id` differs from its run's `node_id` → rejected by `assignments_run_consistency`.
6. Cross-tenant stitching (assignment in org A referencing an operator in org B) → rejected by the composite FK. Create a throwaway second org for this.
7. Overlapping runs on the same cell → rejected (D4); the same window on a different cell → accepted; an overlapping run with `status='cancelled'` → accepted.

**Capacity (`20_`)** — replay the six §15.1 cases and prove the cap is configurable:
8. 100% + 50% overlapping → rejected (peak 1.5). 
9. 50% + 50% → accepted. 
10. 100% + 100% → rejected (2.0 — the old double-booking protection is intact). 
11. Adjacent ranges (half-open) → accepted. 
12. 60/60/40 → accepted at peak exactly 1.0. 
13. 60/60/50 → rejected at peak exactly **1.1**, not 1.7 — assert on the error message text, since that number is the proof the math is instant-wise rather than a naive sum.
14. Set `orgs.settings` `capacity_cap` to `1.2`, retry case 8 → now accepted; reset to 1.0.
15. The seed's Aisha 50/50 pair is present after seeding.

**Shifts (`30_`)**
16. Overnight shift (`1320→1800`) accepted; inverted (`840→360`) rejected; 25-hour shift rejected.
17. Overlapping shifts within one template rejected; the same times in a different template accepted.
18. `resolve_shift_template` returns `3 × 8h` for Cell 1 (inherited from Assembly, two levels up) and `2 × 10h` for Cell 6 (nearest ancestor CNC Line overrides). Re-point `Line 2` to `2 × 10h` and confirm Cells 4–5 flip while Cells 1–3 do not.
19. Effective skill requirements for Cell 6 include `CNC` via the ancestor query (D11); Cell 1's are empty.

**RLS (`40_`)**
20. As **anon** (no JWT claim): zero rows from `nodes`, `runs`, `assignments`.
21. As **Ana**: sees Cells 1–5, not 6–7; sees Assembly runs, not the Machining ones; can insert an assignment on Cell 1; **cannot** on Cell 6.
22. As **Marco**: the mirror image.
23. As **Admin**: sees all 7 cells and all 8 runs.
24. As **Ana**: `UPDATE` moving a run from Cell 1 to Cell 6 is rejected (edit rights required on both sides); moving it Cell 1 → Cell 2 succeeds.
25. As **Ana**: can read operator `Maria` (org-wide roster read, D8) but cannot `UPDATE` her.
26. As **Ana**: reads exactly one `user_profiles` row (her own); `audit_log` returns zero rows. As **Admin**: `audit_log` returns rows.

**Audit (`50_`)**
27. Updating an assignment's `timerange` writes one audit row with `action='update'` and `before`/`after` differing on `timerange` only.
28. A no-op update writes no audit row.
29. Deleting a run writes `action='delete'` with `before` populated.

**Integration**
30. `EXPLAIN (ANALYZE, BUFFERS)` on §3's board-window query (subtree × time range, as Admin) shows the gist indexes in use and no sequential scan on `assignments`. Paste the plan.
31. `psql -c "\d+ <table>"` for every table, saved to `docs/schema.md` as an appendix.

## 8. Delivering to the device repo

Same procedure as brief P1-1 §7: build and validate in the container, tar the delivered paths only (`supabase/`, `scripts/`, and `docs/schema.md` — nothing else, and never the whole `docs/` folder), `SendUserFile` → `device_commit_files` to `…\production_scheduler\_delivery\db.tar.gz`, then `device_bash` to extract in place and `git status --short`. Write `docs/schema.md` and the roadmap edit with `device_bash` heredocs so `docs/` is only added to. **Do not commit or push.** Note in your report that `_delivery/` is gitignored and the user can delete it.

Do **not** run `npm run db:types` — it needs a running local Supabase. Instead, leave `src/lib/database.types.ts` as the P1-1 placeholder and put a line in your report telling the user to run `npm run db:start && npm run db:reset && npm run db:types` on their machine, where Docker exists, to generate real types and verify the migrations against actual Supabase (which will also confirm the `auth.users` FK, the one thing your scratch harness only shims).

## 9. Required final step

Edit `docs/roadmap.md` on the device: tick the database-migrations item with a one-line summary, refresh **Last updated**, add `docs/schema.md` and `supabase/migrations/` to the artifact index, and add `p1-2` to the agent-briefs row.

## 10. Report format

Report: every §2 delta, restated, with anything you had to deviate from further · the full `verify-db.sh` output · the `EXPLAIN` plan · the PostgreSQL version you validated on · every assumption where this brief was silent · anything left undone. If a case in §7 fails and you cannot fix it inside this brief's scope, report it as failed with the error text. A schema that is honestly 90% done is worth more than one reported as finished that the next brief discovers is not.
