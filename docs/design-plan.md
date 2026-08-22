# Production Scheduler — Design Plan

**Status:** Draft v1.4 · August 21, 2026 (v1 Aug 18 · §14–15 Aug 20 · §16 shifts Aug 21 · §17 build decisions Aug 21)
**Phase:** 1 — Core product. DB schema (P1-2) and API surface (P1-3a) built and verified; app scaffold (P1-1) authored but unvalidated.
**Progress tracking:** current status and remaining work live in [`docs/roadmap.md`](roadmap.md) — this document holds decisions, that one holds state.

---

## 1. What we're building

A multi-tenant, real-time production staffing scheduler. Supervisors see a timeline board — schedulable units (work cells, in the default vocabulary) as rows, time as columns — and drag across a row to assign an operator to that unit for a time window, working on a product. Multiple supervisors can edit the same schedule simultaneously and see each other's changes live.

The product differentiator is that the organizational hierarchy is **not hardcoded**. One customer runs Site → Department → Line → Work Cell; another runs Plant → Zone → Station; a third needs five levels. Each org defines its own hierarchy — names, depth, and which level carries the schedule — during onboarding. This mirrors the ISA-95 equipment model conceptually, but the schema never bakes the levels in.

### Design decisions already made

| Decision | Choice |
| --- | --- |
| Deployment model | Multi-tenant SaaS from day one |
| Scale target | Multi-site orgs, thousands of operators |
| Hierarchy | Org-defined levels, arbitrary depth, one level flagged schedulable |
| Time granularity | Exact timestamps in storage; snapping is purely a UI setting |
| Product attachment | Open — both models explored in mockups (§4), schema supports both |
| Operator/product source | Both manual admin entry and ERP/MES sync (§7) |
| Skill enforcement | Yes — certification-based drop eligibility (§6) |
| Templates | Yes — copy-week / reusable schedule templates (§8) |

---

## 2. The dynamic hierarchy

Two concepts replace hardcoded level tables:

**Hierarchy definition** — each org configures an ordered list of levels. Position 0 is the root level; exactly one level is flagged `is_schedulable`, and its nodes become the rows of the scheduling board. Renaming a level is a metadata edit, never a migration.

**Node tree** — one self-referencing table holds every unit at every level. Each node knows its level and its parent. A materialized path (`ltree` in PostgreSQL) makes subtree queries — "everything under Department X" — a single indexed lookup regardless of depth.

Rules the application enforces (not the schema, so hierarchy edits stay cheap):

- A node's parent must be exactly one level above it in the org's definition.
- Only nodes at the schedulable level accept runs/assignments.
- Levels can be added at the bottom or renamed freely; inserting a level mid-hierarchy is a guided migration tool (Phase 3), not a v1 feature.

This makes onboarding the product's front door: a new org names its levels, builds its tree (typed in or CSV-imported), and immediately has a working board.

---

## 3. Data model

PostgreSQL 16+. Every tenant-scoped table carries `org_id` with row-level security (§9). Full DDL below has been validated against a live PostgreSQL 16 instance.

```sql
CREATE EXTENSION IF NOT EXISTS ltree;
CREATE EXTENSION IF NOT EXISTS btree_gist;  -- required for the exclusion constraint

CREATE TABLE orgs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  settings   jsonb NOT NULL DEFAULT '{}'   -- snap defaults, week start, locale, etc.
);

-- The org's hierarchy definition: one row per level, ordered by position.
CREATE TABLE hierarchy_levels (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES orgs(id),
  position       int  NOT NULL,             -- 0 = root level
  name           text NOT NULL,             -- "Site", "Plant", "Zone", ...
  is_schedulable boolean NOT NULL DEFAULT false,
  UNIQUE (org_id, position)
);

-- One table for every unit at every level.
CREATE TABLE nodes (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id    uuid NOT NULL REFERENCES orgs(id),
  level_id  uuid NOT NULL REFERENCES hierarchy_levels(id),
  parent_id uuid REFERENCES nodes(id),      -- NULL only at the root level
  name      text NOT NULL,
  path      ltree NOT NULL,                 -- e.g. 'siteA.dept2.line1.cell3' (label-safe slugs)
  sort_order int NOT NULL DEFAULT 0,
  active    boolean NOT NULL DEFAULT true,
  UNIQUE (org_id, parent_id, name)
);
CREATE INDEX nodes_path_idx ON nodes USING gist (path);
CREATE INDEX nodes_org_parent_idx ON nodes (org_id, parent_id);

CREATE TABLE operators (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES orgs(id),
  home_node_id uuid REFERENCES nodes(id),   -- default site/dept for filtering the roster
  display_name text NOT NULL,
  employee_ref text,                        -- badge / payroll number
  source       text NOT NULL DEFAULT 'manual',  -- 'manual' | 'sync'
  external_id  text,                        -- ID in the source ERP/MES system
  active       boolean NOT NULL DEFAULT true,
  UNIQUE (org_id, external_id)
);

CREATE TABLE products (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES orgs(id),
  sku         text NOT NULL,
  name        text NOT NULL,
  source      text NOT NULL DEFAULT 'manual',
  external_id text,
  active      boolean NOT NULL DEFAULT true,
  UNIQUE (org_id, sku)
);
```

### Runs and assignments — one schema, both product models

The undecided A/B question (product on the person-assignment vs. product on a cell "run") is deliberately **not** a schema fork. The schema below implements model B (runs), and model A falls out of it by leaving `run_id` NULL and putting `product_id` directly on the assignment. The mockups decide the *interaction*; the database supports either without migration.

```sql
-- A run: "this cell produces this product during this window."
CREATE TABLE runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES orgs(id),
  node_id           uuid NOT NULL REFERENCES nodes(id),    -- must be schedulable level
  product_id        uuid NOT NULL REFERENCES products(id),
  timerange         tstzrange NOT NULL,
  planned_headcount int,
  status            text NOT NULL DEFAULT 'planned',  -- planned | active | done | cancelled
  notes             text
);
CREATE INDEX runs_node_time_idx ON runs USING gist (node_id, timerange);

-- An assignment: "this operator staffs this cell during this window."
CREATE TABLE assignments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES orgs(id),
  node_id     uuid NOT NULL REFERENCES nodes(id),
  operator_id uuid NOT NULL REFERENCES operators(id),
  run_id      uuid REFERENCES runs(id),      -- model B: attached to a run
  product_id  uuid REFERENCES products(id),  -- model A: product carried directly
  timerange   tstzrange NOT NULL,
  status      text NOT NULL DEFAULT 'planned',
  created_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assignments_node_time_idx ON assignments USING gist (node_id, timerange);
CREATE INDEX assignments_operator_idx  ON assignments (org_id, operator_id);

-- The keystone: the database itself refuses to double-book an operator,
-- even when two supervisors submit conflicting edits in the same instant.
ALTER TABLE assignments ADD CONSTRAINT no_double_booking
  EXCLUDE USING gist (operator_id WITH =, timerange WITH &&)
  WHERE (status <> 'cancelled');
```

> **Superseded by §15.1 (v1.2):** the flat exclusion constraint is replaced by the operator *capacity model* — instantaneous `sum(efficiency)` ≤ cap, enforced by a validated trigger with per-operator advisory locking. Same race-safety, but 50/50 multi-cell coverage becomes legal. Kept here to show the evolution.

That exclusion constraint is the concurrency story in one line. Optimistic UI on the client, and if two supervisors race for the same operator, exactly one write wins; the loser gets a structured 409 with the conflicting assignment attached, and the UI reverts the block with a "Maria is already on Cell 7, 8:00–12:00" message.

**Why exact timestamps:** `tstzrange` stores precise instants. Fifteen-minute snapping, shift snapping, free drag — all pure UI behavior (§10). No bucket tables, no granularity migrations, no re-import when a customer wants finer control.

### Query shape

Every board load and refresh is one shape: *assignments (and runs) for nodes under X, intersecting window [T1, T2)*:

```sql
SELECT a.* FROM assignments a
JOIN nodes n ON n.id = a.node_id
WHERE n.org_id = :org
  AND n.path <@ :root_path            -- subtree via ltree
  AND a.timerange && tstzrange(:t1, :t2);
```

The GiST indexes serve both halves. This is why the model stays cheap: the UI only ever asks for a subtree × time-window slice, never "all assignments."

### Partitioning — deliberately deferred

A single well-indexed `assignments` table comfortably handles tens of millions of rows — years of history for a large org. Rather than partition on day one (PostgreSQL's partitioning interacts awkwardly with exclusion constraints, which must include the partition key), v1 ships unpartitioned with a scheduled job that moves assignments older than a retention window into an `assignments_archive` table (same shape, no exclusion constraint, cheap storage). Revisit true partitioning only if production data demands it. This is the cost-effective choice, not the lazy one.

---

## 4. The A/B product-model question — what the mockups must answer

**Model A — product on the assignment.** Drag on a row → an operator block appears carrying its own product. One gesture, one entity. Weakness: five operators on the same cell each duplicate the product; a changeover means editing five blocks.

**Model B — runs + staffing.** The row shows a product band (the run); operators are dropped onto it and inherit product and boundaries. Enables `planned_headcount` ("this run needs 4 — you've staffed 3") and one-edit changeovers. Weakness: two-step creation; possibly heavier than small teams need.

Because the schema is a superset (§3), this is purely an interaction decision. Both mockups will be interactive HTML with real drag behavior, evaluated on: gesture count for the common case, changeover editing cost, visual scanability of a full day, and how naturally understaffing surfaces.

---

## 5. Real-time architecture

**Transport:** WebSockets, publishing row-level change events (insert/update/delete on `runs` and `assignments`).

**Channel scoping is the cost model.** Channels are per `(org, site-subtree)` — e.g. `org:{id}:node:{site_id}`. A client subscribes only to the subtree it's viewing and filters events to its visible time window client-side. A supervisor watching Line 3 this week never receives — or pays for — events from another plant. No polling anywhere; a board that isn't being looked at costs nothing.

**Edit flow:** client applies the change optimistically → server validates (RLS, eligibility, exclusion constraint) → commit broadcasts the event to the channel → other clients converge; on 409 the originating client reverts with the conflict details. Presence (who else is viewing this board) rides the same channel for near-free and builds trust in v1.

**Build vs. buy (DECIDED Aug 21 — Supabase confirmed):** Supabase Realtime gives Postgres + RLS + WebSocket broadcast + auth in one managed unit and is the v1 substrate — fastest path and cheapest at small scale. The design assumes only "Postgres + row-event broadcast," so swapping to a self-managed WebSocket tier (e.g. Fastify + Redis pub/sub) later is an infrastructure change, not a redesign.

---

## 6. Skills and eligibility

```sql
CREATE TABLE skills (
  id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id),
  name   text NOT NULL,
  UNIQUE (org_id, name)
);

CREATE TABLE operator_skills (
  operator_id  uuid NOT NULL REFERENCES operators(id),
  skill_id     uuid NOT NULL REFERENCES skills(id),
  certified_at date,
  expires_at   date,                        -- NULL = no expiry
  PRIMARY KEY (operator_id, skill_id)
);

-- Requirements attach to ANY node and inherit downward:
-- a requirement on a Line applies to every cell under it.
CREATE TABLE node_skill_requirements (
  node_id  uuid NOT NULL REFERENCES nodes(id),
  skill_id uuid NOT NULL REFERENCES skills(id),
  PRIMARY KEY (node_id, skill_id)
);
```

A cell's *effective requirements* are the union of requirements along its `ltree` path — one ancestor query. Enforcement happens twice:

1. **In the UI, before the drop.** When a supervisor picks up an operator, ineligible rows dim; expiring certifications show a warning tint. Eligibility is computed client-side from the cached skills matrix (small data), so the board feels instant.
2. **At the API on write** — the authoritative check, so no client bug or race staffs an uncertified operator. Certification expiry is checked against the assignment's time range, not "today" — scheduling someone three weeks out fails if their cert lapses in two.

Policy is org-configurable: **block** (hard refusal) or **warn** (allowed with a recorded override — some plants need supervisor discretion). Default: warn, per-org upgradeable to block.

---

## 7. Operators and products: manual entry + ERP/MES sync

Both sources, one design — every syncable table carries `source` and `external_id`.

**Tier 0 (v1): manual + CSV.** Admin CRUD plus CSV import (which is upsert-by-`external_id`, meaning re-importing an updated export just works). This is the zero-integration onboarding path and — importantly — CSV import *is* the sync pipeline with a manual trigger, so building it validates the whole upsert machinery before any connector exists.

**Tier 1 (Phase 3): connectors.** An adapter interface per source system (SAP, Dynamics, generic REST/file-drop), each implementing `fetchOperators()` / `fetchProducts()` with scheduled incremental pulls, writing through the same idempotent upsert keyed on `(org_id, external_id)`. Connection configs, credentials (vaulted), and sync run logs live in an `integration_connections` table.

**Conflict policy:** synced records lock their synced fields in-app (the ERP is the source of truth; local edits would be silently overwritten later, which is worse than read-only). App-owned fields — skills, home node — stay editable everywhere. Deactivations propagate as `active = false`, never as deletes, so schedule history survives.

---

## 8. Templates and copy-week

The most-requested scheduling feature, in two stages:

**Stage 1 (early, cheap): Copy Week.** Clone a source week's assignments (and runs) forward by N × 7 days as a bulk insert — with a mandatory **dry-run preview** first: "42 assignments will copy cleanly; 3 conflict (Maria is on PTO Tuesday); 1 references a deactivated operator." Supervisor resolves or skips, then commits. Never a blind paste.

**Stage 2: named templates.** A template stores *relative* placements — day-of-week + start/end offsets + operator/product/node references — so "Standard Week," "Holiday Skeleton Crew," and "Product X Launch" can be stamped onto any future week through the same preview-then-commit flow. Same machinery as Copy Week; a copy is just an anonymous single-use template.

---

## 9. Multi-tenancy, roles, and security

- `org_id` on every tenant table, enforced by **row-level security** in Postgres — isolation holds even if an application bug drops a WHERE clause.
- **Roles:** *Org admin* (hierarchy, skills, integrations, users) · *Planner/Supervisor* (edit schedules within granted subtrees — subtree grants reuse the `ltree` machinery: a grant is just a path prefix) · *Viewer* (read-only) · *Operator* (future: reads own schedule on mobile — likely the wedge for v2 adoption).
- Auth: standard OIDC via the platform (Supabase Auth in v1); SSO/SAML deferred to enterprise tier.

---

## 10. UI architecture

**The board is a virtualized grid, not a chart library.** Chart libraries fight custom drag interactions; scheduler suites (Bryntum et al.) are licensed and constrain the product's signature interaction. The board is the product — it warrants an owned component. React + TypeScript; render only visible rows × visible time span; target 60fps pan/zoom with hundreds of rows via virtualization both axes.

**Layout:** left rail = collapsible hierarchy tree (site → … → cell), rows = schedulable nodes, header = time axis. Collapsing a department collapses its rows. An unassigned-operator tray (roster filtered by site/eligibility) sits at the edge for drag-on staffing.

**Zoom-adaptive snapping** (the "maximum flexibility yet efficient" answer):

| Zoom level | Visible span | Default snap |
| --- | --- | --- |
| Month | 4–5 weeks | shift |
| Week | 7 days | 1 hour |
| Day | 24 h | 15 min |
| Fine | ≤ 8 h | 5 min |

Org-configurable defaults; holding a modifier key drags free to the minute. Because storage is exact timestamps, snapping never touches the backend.

**Gestures:** drag across empty row-space → create (assignment or run, per A/B outcome) · drag block edges → resize · drag block body → move in time or across rows (re-checks eligibility live) · click → details popover. Every mutation optimistic with rollback-on-409 (§5).

---

## 11. Cost posture

Designed to run lean: one managed Postgres instance covers multi-site scale for a long time (§3's query shape and archive strategy keep the hot set small); real-time is delta-events-only over subtree-scoped channels (no polling, no fan-out to inactive viewers); the frontend is a static bundle on a CDN; and v1 on Supabase collapses database, auth, RLS, and realtime into one bill with a designed escape hatch. The most expensive thing this design avoids: refetching whole schedules on change, which turns every edit into O(viewers × board size).

---

## 12. Open questions

1. **A/B product model** — decided by the mockups (§4).
2. **Shift definitions** — org-level named shifts (e.g. "Days 6a–2p") are assumed for snap-to-shift and templates; how flexible must these be (per-site? rotating patterns?)?
3. **PTO/absence** — Copy Week's conflict preview wants absence data. In-app entry, or synced from an HR system? (Affects Phase 2 scope.)
4. **Changeover time** — model B could represent setup/teardown between runs explicitly. Real need or v2 polish?
5. **Operator mobile view** — confirmed future direction, but does v1 need even a read-only share link?

---

## 13. Roadmap

| Phase | Scope |
| --- | --- |
| **0 — now** | This design plan; two interactive mockups (model A vs B); pick the interaction model |
| **1 — core** | Org + hierarchy config, manual/CSV operators & products, the board (single site), assignments CRUD with exclusion-constraint conflicts, real-time channels, RLS + roles |
| **2 — scheduling depth** | Skills matrix + eligibility (warn/block), Copy Week with dry-run preview, shift definitions, named templates |
| **3 — scale & integration** | ERP/MES connectors (SAP first), multi-site hardening, archive job, subtree permission grants, mid-hierarchy level-insertion tool |

**Immediate next step:** build the two interactive HTML mockups — same fake factory, same week of data, one per product model — and drag them until the right answer is obvious.

---

## 14. Addendum v1.1 — decisions from mockup review (Aug 20, 2026)

Both mockups were built and exercised. The outcome was not "A or B" but **both, coexisting** — plus three new assignment attributes and a sharpened visibility model. All SQL in this section has been validated against live PostgreSQL 16, same as §3.

### 14.1 The hybrid board (A + B coexist)

The schema anticipated this (`assignments.run_id` is nullable), so it is a UI decision only. The rule set:

- Every board supports **both** creation paths at all times: drag-select can create a *product run* (Model B) or a *direct assignment* (Model A); a type selector in the creation popover chooses which.
- A **profile preference** (`default_create_mode`) picks which type the popover *pre-selects* — it never changes how existing data renders. Two supervisors with different preferences see the identical board.
- Direct assignments render as standalone operator blocks carrying their own product chip; run-attached assignments render as staffing chips under their band. Both can coexist on the same row (a direct assignment must not time-overlap a run on the same cell for the same operator — the exclusion constraint already covers the operator side; run-vs-direct on one cell is allowed, since a floater can help a cell mid-run).
- Rationale for rejecting a per-user *rendering mode*: mixed data created by one mode renders confusingly in the other, and shared boards must look the same to everyone.

### 14.2 Efficiency and per-window target

Two new columns on `assignments` (validated):

```sql
ALTER TABLE assignments
  ADD COLUMN efficiency numeric(4,3) NOT NULL DEFAULT 1.000
    CHECK (efficiency > 0 AND efficiency <= 2),
  ADD COLUMN target_qty numeric CHECK (target_qty > 0),
  ADD COLUMN target_unit text;
```

**Efficiency** defaults to 1.000 (100%). Semantics: the supervisor's expectation of output for this window (training, light duty, running two cells at once). It feeds capacity math: a run's **effective headcount** is `SUM(efficiency)` over its staffing — two operators at 50% satisfy a planned headcount of 1, not 2 — so the understaffing signal upgrades from counting heads to counting expected output. UI shows a badge on any block ≠ 100%.

**Target** defaults to NULL (renders "NA"). Semantics decided: **total for the window** ("80 units off this cell today"), not a rate — matching how supervisors phrase expectations. Consequence: resizing an assignment that carries a target prompts *keep total or scale proportionally*. `target_unit` is free text in v1 ("units", "kg"); standard targets derived from product routing data are a future concept (§14.5).

### 14.3 Profiles and subtree visibility

The §9 role sketch is now concrete (validated):

```sql
CREATE TABLE user_profiles (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id   uuid NOT NULL REFERENCES orgs(id),
  user_ref text NOT NULL,
  role     text NOT NULL DEFAULT 'supervisor',   -- admin | supervisor | viewer
  default_create_mode text NOT NULL DEFAULT 'run'
    CHECK (default_create_mode IN ('run','direct')),
  UNIQUE (org_id, user_ref)
);

CREATE TABLE profile_grants (
  profile_id uuid NOT NULL REFERENCES user_profiles(id),
  node_id    uuid NOT NULL REFERENCES nodes(id),  -- grant = this subtree
  can_edit   boolean NOT NULL DEFAULT true,
  PRIMARY KEY (profile_id, node_id)
);
```

A grant is a node; its meaning is "everything under this path" via `ltree` — typically a department, but any level works. Grants scope three things at once: the rows a user sees, the roster they assign from (operators whose home node falls under a granted subtree), and what RLS lets them write. Admins hold a root grant. This is enforced in RLS policies, not just the UI.

### 14.4 Timeline is continuous

Confirmed: the time axis scrolls continuously across days — forward to pre-assign future weeks, backward to correct the past. The v1 mockups were single-day for scope only. The board virtualizes both axes and loads data by visible window (§3's query shape already takes any [T1, T2)). Editing the past is allowed in v1 and always audit-logged.

### 14.5 New open questions

6. **Past-edit policy** — lock edits older than N days (org setting)? Or always-open with audit? (v1: always-open + audit.)
7. **Standard targets** — product routing data ("Widget X standard rate on Cell 1 = 12/hr") would let targets default intelligently and make efficiency measurable after the fact. ERP-adjacent; Phase 3 candidate.
8. **Efficiency vs actuals** — once MES/production counts sync in, efficiency becomes comparable to reality. Explicitly out of scope until integrations exist.

### 14.6 Division of labor note (see also §15.4)

Design/brainstorming happens in a high-reasoning session (Fable); mockups and mechanical builds are executed by cheaper agents (Sonnet/Opus) from written briefs stored in `docs/agent-briefs/`. Briefs must be judgment-free: exact files, exact behaviors, seed data, acceptance checklist, and a self-verification procedure.

---

## 15. Addendum v1.2 — capacity model, run mobility, layout (Aug 20, 2026)

Driven by hands-on review of the hybrid mockup. All SQL validated against live PostgreSQL 16.

### 15.1 The operator capacity model (supersedes flat double-booking)

**Motivation.** During labor shortages a supervisor legitimately assigns one operator across multiple cells in the same window — covering two cells at 50% each. The §3 exclusion constraint forbade *any* overlap, which made that impossible. Efficiency (§14.2) already expresses partial attention, so the rule generalizes cleanly:

> At any instant, the sum of an operator's active assignment efficiencies must not exceed a cap (default **1.0**, org-configurable in `orgs.settings` — e.g. 1.2 where overtime-style overloading is policy).

The old rule is the special case where every assignment is at 100% — so full double-booking protection is preserved, while 50/50, 60/40, or three-way 40/30/30 splits become legal.

**Enforcement.** The `EXCLUDE` constraint cannot express a sum, so it is replaced by a trigger that (a) takes a per-operator advisory lock — preserving the race-safety the constraint gave us when two supervisors write simultaneously — and (b) computes the **instantaneous peak**, not a naive sum of overlapping rows. The distinction matters: with 60% on 08:00–10:00 and 60% on 10:00–12:00, adding 40% on 09:00–11:00 is legal (peak exactly 1.0) even though the naive sum says 1.6. The peak only needs evaluating at the new range's start and at the starts of overlapping assignments inside it.

```sql
ALTER TABLE assignments DROP CONSTRAINT no_double_booking;

CREATE OR REPLACE FUNCTION check_operator_capacity() RETURNS trigger AS $fn$
DECLARE
  cap numeric := 1.0;   -- final build: read from orgs.settings
  peak numeric;
BEGIN
  IF NEW.status = 'cancelled' THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.operator_id::text, 42));
  SELECT COALESCE(max(load), 0) INTO peak FROM (
    SELECT (SELECT COALESCE(sum(a.efficiency), 0)
            FROM assignments a
            WHERE a.operator_id = NEW.operator_id
              AND a.id <> NEW.id AND a.status <> 'cancelled'
              AND a.timerange @> p.pt) + NEW.efficiency AS load
    FROM (
      SELECT lower(NEW.timerange) AS pt
      UNION
      SELECT lower(a.timerange) FROM assignments a
      WHERE a.operator_id = NEW.operator_id
        AND a.id <> NEW.id AND a.status <> 'cancelled'
        AND a.timerange && NEW.timerange
    ) p
    WHERE NEW.timerange @> p.pt
  ) q;
  IF peak > cap THEN
    RAISE EXCEPTION 'capacity exceeded: operator % would reach % (cap %)',
      NEW.operator_id, peak, cap;
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;

CREATE TRIGGER assignments_capacity
BEFORE INSERT OR UPDATE OF timerange, efficiency, status, operator_id ON assignments
FOR EACH ROW EXECUTE FUNCTION check_operator_capacity();
```

Validation results: 100%+50% overlap rejected (peak 1.5) · 50%+50% accepted · 100%+100% rejected (2.0 — old protection intact) · adjacency accepted (half-open ranges) · the 60/60/40 boundary case accepted at peak exactly 1.0 · the 60/60/50 case rejected at peak exactly **1.1** — proving instant-wise math, since a naive sum would report 1.7.

**UX: the split-coverage flow.** A drop that would exceed capacity no longer dead-ends in a rejection toast. It opens a *split coverage* popover: the operator's overlapping assignments in that window with editable efficiency fields, the new assignment alongside, a live peak-load indicator, and a one-click **Split evenly** action. Confirm stays disabled while the peak exceeds the cap. A flat reject (red flash + revert) remains only when the user cancels.

### 15.2 Runs move across cells too

The v2 mockup only allowed run bands to move in time — an inherited scope cut from Model B, **not** a design decision. Corrected: a run drags to another cell like any block. On drop: the target cell must have no overlapping run; the crew comes along; every crew member is eligibility-rechecked against the target cell (override-warn policy per §6); capacity is unaffected (times don't change). Product changeover, headcount, and crew all being one-edit operations on the run is the whole point of runs — mobility completes the set.

### 15.3 Layout: operator panel moves left

The bottom tray created a bottom→top→bottom eye path. The roster becomes a **left vertical panel** (collapsible), before the hierarchy rail, so the flow reads left→right: pick a person → place them in time. Each entry: avatar, name, skill badges, and an **assignment indicator** — a count pill when the operator has any assignment in the loaded window, with a tooltip listing them; operators at full allocation in the visible window render dimmed. This also gives the roster room to grow (search/filter at scale — hundreds of operators per site).

### 15.4 The living roadmap

Complaint from review: the design plan records decisions but not state. Fixed by convention, not by bloating this document: **`docs/roadmap.md`** is the single status file — done / in progress / remaining, phase by phase, checkbox granularity. Every working session and every agent brief ends by updating it (agent briefs now include this as a required final step). This document stays a decision record; the roadmap answers "where are we."

---

## 16. Addendum v1.3 — shift definitions and breaks (Aug 21, 2026)

Spec from Pratik at v2.1 sign-off. All SQL validated on live PostgreSQL 16.

### 16.1 Model

A **shift template** is a named daily pattern ("3 × 8h", "2 × 10h") owned by the org and fully admin-editable. A template contains **shifts** (name, start, end) and each shift contains **breaks** (name, start, end). Templates attach to **any hierarchy node** and inherit downward — attach "3 × 8h" once at the Assembly department and every line and cell under it follows it; attach "2 × 10h" at the CNC Line and that line overrides its department. Resolution is nearest-ancestor-wins, the same `ltree` mechanic as skill requirements — so "some lines run 3 shifts, some run 2" costs two rows, and a future site with different patterns costs zero schema changes.

Times are minutes from the shift-day's midnight; `end_min` may exceed 1440 to express an overnight shift (22:00–06:00 = 1320–1800), and an overnight shift belongs to the day it **starts**. Break times use the same coordinate space and must lie inside their shift (application-validated).

```sql
CREATE TABLE shift_templates (
  id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id),
  name   text NOT NULL,
  UNIQUE (org_id, name)
);

CREATE TABLE shifts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES shift_templates(id) ON DELETE CASCADE,
  name        text NOT NULL,
  start_min   smallint NOT NULL CHECK (start_min >= 0 AND start_min < 1440),
  end_min     smallint NOT NULL,
  CHECK (end_min > start_min AND end_min - start_min <= 1440)
);

CREATE TABLE shift_breaks (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id  uuid NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  name      text NOT NULL DEFAULT 'Break',
  start_min smallint NOT NULL,
  end_min   smallint NOT NULL,
  CHECK (end_min > start_min)
);

CREATE TABLE node_shift_templates (
  node_id     uuid PRIMARY KEY REFERENCES nodes(id),
  template_id uuid NOT NULL REFERENCES shift_templates(id)
);
```

Validation: overnight shift accepted; inverted shift rejected by CHECK; department-level attachment resolves for a cell three levels down; line-level attachment overrides the department (nearest-ancestor query returns 2×10h for the CNC cell, 3×8h for assembly cells).

### 16.2 Board rendering

Breaks render as a **standard break color** on every affected row — a neutral hatched band (from the chrome tokens, never a product color) beneath the assignment layer, with a tooltip naming the break. Shift boundaries render as stronger dashed verticals with shift-name labels at coarse zooms; time outside any shift gets a faint off-shift wash. Because patterns attach per-subtree, adjacent rows can legitimately show different stripes — that contrast is information, not noise.

Interaction: at Compact zoom, drag-select snaps to shift boundaries (the §10 zoom-snap table's "shift" row, now concrete); the creation popover gains **full-shift quick actions** (one click = the whole shift for that row's pattern). Breaks do not block assignments and are not subtracted from targets or capacity in v1 — display-only (open question 9).

### 16.3 Admin editing

Shift configuration is org-admin surface: edit template/shift/break names and times, add/remove breaks, and re-point any node's template. Validation on save: breaks inside their shift; shifts within a template non-overlapping. Edits apply to the whole subtree immediately (schedule data is untouched — shifts are a rendering/snapping layer over exact-timestamp assignments, so redefining shifts never corrupts existing assignments).

### 16.4 New open question

9. **Break-aware math** — should targets/effective capacity net out break time (an 8h assignment = 7h productive)? v1: no, display-only. Revisit with standard-targets work (Q6).

---

## 17. Addendum v1.4 — schema decisions locked for build (Aug 21, 2026)

Written alongside the Phase 1 briefs. §3/§14/§15/§16 are a *narrative* record — they show the schema evolving (an exclusion constraint §15.1 later drops, `ALTER TABLE`s that add columns). The migrations implement the **final shape only**; the decisions below close the gaps that the narrative left for build time. Full execution detail lives in `docs/agent-briefs/p1-2-db-migrations-brief.md`.

| # | Decision | Rationale |
| --- | --- | --- |
| D1 | `user_profiles.user_ref text` → `user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE`, `UNIQUE (org_id, user_id)` | Supabase Auth is the stack (§5); a text ref costs a second lookup on every RLS check. |
| D2 | Capacity cap reads from `orgs.settings->>'capacity_cap'`, default `1.0` | §15.1 flagged this as final-build work. Closes open question 3. |
| D3 | Composite tenant FKs throughout: parents carry `UNIQUE (org_id, id)`, children reference `(org_id, id)` | Cross-tenant row stitching becomes structurally impossible, not merely RLS-impossible. |
| D4 | `runs` gains `EXCLUDE USING gist (node_id WITH =, timerange WITH &&) WHERE status <> 'cancelled'` | §15.2's "target cell must have no overlapping run" is a database invariant, not a UI check. |
| D5 | `assignments CHECK (num_nonnulls(run_id, product_id) = 1)` + a trigger forcing a run-attached assignment's `node_id` to equal its run's | §14.1's hybrid rule, enforced. The trigger is what refuses a half-completed cross-cell run move. |
| D6 | `nodes.path` is trigger-maintained (slugified name appended to parent path, cascading on rename/move) | Level rules stay in the application by design (§2); path is mechanical derivation and drifts if left to callers. |
| D7 | `org_id` carried on `shifts`, `shift_breaks`, `node_shift_templates`, `operator_skills`, `node_skill_requirements` | §3's uniform rule. Uniform RLS beats a saved column. |
| D8 | Under RLS, `operators`/`products`/`skills` are readable org-wide; subtree grants restrict node visibility and all writes | A supervisor must render "Maria is already on Cell 7" even when Cell 7 is outside their grant. The *assignable* roster filter (§14.3) is a UI/API concern. |
| D9 | `audit_log` is admin-read-only in v1; rows are written by a `SECURITY DEFINER` trigger on `runs` and `assignments` only | Supervisor-scoped audit reads need a path join per row; deferred until asked for. |
| D10 | Seed anchors day 0 to the Monday of the current week **in UTC** | Per-site timezone is undecided; UTC is the honest placeholder. Recorded as a deferral in `docs/schema.md`, not silently assumed. |
| D11 | The seed attaches the `CNC` skill requirement to the **CNC Line** node rather than to Cells 6 and 7 individually | Identical in effect, and it exercises §6's ancestor-inheritance query in the seed itself. |
| D12 | Shift non-overlap within a template becomes an exclusion constraint; nearest-ancestor resolution ships as `resolve_shift_template(node)` | §16.3 required the validation on save; making it an invariant means the admin editor cannot be the only thing enforcing it. |

**Not built in Phase 1:** `assignments_archive` + retention job (§3), partitioning (§3), `integration_connections` (§7), Copy Week / templates (§8). The migrations must not create tables for these.

**Validation posture.** Docker is unavailable in the agent container, so `supabase start` cannot run there. Migrations are validated against a scratch PostgreSQL with a *test-only* `auth` shim (`supabase/tests/00_harness.sql` — never a migration), covering the §15.1 capacity cases, shift resolution, constraint behaviour, RLS per profile, and audit writes. The one thing the shim cannot prove — the real `auth.users` FK — is confirmed by running `supabase db reset` on a machine with Docker.

### 17.1 Corrections found during the P1-2 build (Aug 21, 2026)

Three errors in the P1-2 brief surfaced only when the SQL actually ran. Recorded here because two of them are schema decisions, not typos.

1. **The `nodes.path` cascade fires on `name, parent_id`, not on `path`.** The brief specified `AFTER UPDATE OF path`. PostgreSQL evaluates `UPDATE OF <cols>` against the columns named in the statement's own `SET` clause, not against what a `BEFORE` trigger recomputed — so on a design (D6) whose whole point is that callers never set `path` directly, that trigger could never fire, and renaming a node silently left every descendant's path stale. Corrected to `AFTER UPDATE OF name, parent_id`, same `WHEN (OLD.path IS DISTINCT FROM NEW.path)` guard, same cascade body.
2. **The audit no-op check must exclude `updated_at`.** `runs` and `assignments` carry an unconditional `set_updated_at` BEFORE trigger, so `to_jsonb(OLD) = to_jsonb(NEW)` is never true and every no-op update would have written an audit row. The skip-decision now compares `to_jsonb(OLD) - 'updated_at'` against `to_jsonb(NEW) - 'updated_at'`; the stored `before`/`after` snapshots remain complete.
3. **`app_can_edit_node()` gates on the grant subtree, not on the role alone.** `app_can_write()` is a bare role check; ORing it with the subtree test the way the brief's shorthand read would have let any supervisor edit any node and erased subtree grants entirely. Correct shape: admin bypasses, otherwise `app_can_write()` gates *entry to* the `app_grant_paths(true)` subtree check.

Also noted: the brief's capacity acceptance case "raise the cap to 1.2 and the 100%+50% case is accepted" was arithmetically impossible (that case peaks at 1.5). Cap configurability is instead proven with the 1.1-peak case — rejected at cap 1.0, accepted at cap 1.2.

**Verification posture confirmed.** The SQL suite was mutation-tested by the design session, not merely re-run: neutering `check_operator_capacity()` made `20_capacity_test.sql` fail with `FAIL: 100%+50% overlap (peak 1.5) was not rejected`, and disabling RLS on `assignments` made `40_rls_test.sql` fail with `FAIL: Ana was able to insert an assignment on Cell 6`. The assertions have teeth. Treat that mutation check as the standard for accepting any future test suite in this project.

### 17.2 Corrections found during the P1-3a build (Aug 21, 2026)

Four more errors surfaced when the API surface ran. Two are Postgres facts worth remembering, not typos.

1. **Functions grant `EXECUTE` to `PUBLIC` by default — tables do not.** Revoking from `anon` is therefore not enough to keep an unauthenticated caller out of an RPC; the `PUBLIC` grant still lets them in, and a test asserting "anon is refused" can pass for the wrong reason or fail confusingly. Every function in the API surface now carries an explicit `REVOKE EXECUTE … FROM PUBLIC` alongside its `GRANT … TO authenticated`. Verified: `board_window`'s ACL is `ubuntu=X/ubuntu | authenticated=X/ubuntu`, with no bare `PUBLIC` entry.
2. **`SECURITY INVOKER` functions that call `auth.uid()` need `USAGE` on schema `auth`.** Every P1-2 caller reached `auth.uid()` through a `SECURITY DEFINER` helper, which masked the gap. P1-3a's write RPCs are invoker-rights by design and call it directly for `created_by`, so they failed immediately with "permission denied for schema auth" until the test harness granted `USAGE ON SCHEMA auth TO authenticated, anon` — matching what a real Supabase project already does. The harness was wrong, not the migration.
3. **The `api_raise` helper maps the error code to the SQLSTATE.** The brief's sample hardcoded `PT409` while the surrounding text called for `PT400` and `PT403` on two of the six codes. Resolved with a `CASE` over the error code inside `api_raise`, so the mapping lives in exactly one place.
4. **Changing the capacity trigger's SQLSTATE breaks P1-2's tests mechanically.** `20_capacity_test.sql`'s `EXCEPTION WHEN check_violation` handlers became `WHEN SQLSTATE 'PT409'`. Not a design change — a consequence of §3.2, noted so nobody later reads it as a regression.

Also: acceptance item 15's literal scenario was impossible on the seed data (the target cell already held an overlapping run of the same product at that window), so `move_run` correctly raised `run_overlap`. Handled the same way as P1-2's impossible cap case — surfaced as a warning, with a conflict-free supplementary case proving the real capability.

**Verification.** Cold re-run by the design session: exit 0, all suites green, migration 0009 confirmed applied and all ten API functions confirmed `SECURITY INVOKER` via `pg_proc.prosecdef`. Beyond the four mutations the brief prescribed, the design session ran an **unprescribed** one — rewriting `check_eligibility`'s ltree ancestor containment (`<@`) to exact node equality — and the suite caught it with `FAIL: Elena/Cell6 should be ineligible: {"eligible": true, …}`. A suite that catches a mutation nobody told it to expect is the standard worth holding to.
