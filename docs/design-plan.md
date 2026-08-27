# Production Scheduler — Design Plan

**Status:** Draft v2.1 · August 25, 2026 (v1 Aug 18 · §14–15 Aug 20 · §16 shifts Aug 21 · §17 build decisions Aug 21 · §18 board rendering Aug 24 · §19 hierarchy admin Aug 25 · **§19.12 P1-5b verification + D78/D79 · §19.13 whitespace parity + D80 · §19.14 P1-5c + D81/D82 · §19.15 a second org + the cross-tenant leak (D83) · §19.16 scaling is the default (D84) · §19.17 the create_node regression 0012 caused and the harness that hid it (D85) · §19.18 hierarchy templates — a shape per site (D86) · §19.19 the level lookup D86 forgot to move (D87) + its two corrections · §19.20 P1-5f written, both its mutation tables executed · §19.21 D88 per-site timezone — site-local, wall-clock, Phase 2** Aug 25)
**Phase:** 1 — Core product. DB schema (P1-2), API surface (P1-3a/b), the board UI (P1-4a–e) and the hierarchy admin database + client + screens layers (P1-5a/b/c/d) are built and verified by independent design-session probes. **The SQL is at migration 0014 and the client side of D86 shipped as P1-5e. D87 is OPEN and blocks D86's whole point; its brief (P1-5f) is written and not yet built — see §19.19/§19.20.**
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

⛔ **SUPERSEDED IN PART by D101 (§19.59) and migration 0023: shift patterns are SITE-OWNED, and a site admin edits their own. Unowned patterns stay company-wide, which is what "we can have defaults" means. Ownership decides who may EDIT a pattern; nearest-ancestor resolution of which pattern APPLIES is unchanged.** Shift configuration is admin surface: edit template/shift/break names and times, add/remove breaks, and re-point any node's template. Validation on save: breaks inside their shift; shifts within a template non-overlapping. Edits apply to the whole subtree immediately (schedule data is untouched — shifts are a rendering/snapping layer over exact-timestamp assignments, so redefining shifts never corrupts existing assignments).

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

### 17.3 Frontend build-config corrections (Aug 22, 2026)

The scaffold was authored without a package registry, so nothing in it had ever been compiled. Running `npm install` and the acceptance suite on a real machine surfaced five config errors — all mine, none in the application code, which linted clean and passed its tests and e2e smoke on the first real run.

1. **`engines: "20.x"` was a hard pin** that fails on Node 24. Relaxed to `>=20`, and `.nvmrc` moved to `24` so CI runs the same Node as the dev machine. Matching those two is worth more than pinning an older LTS.
2. **vitest 2.x drags its own nested Vite 5** alongside the root Vite 6. TypeScript then sees two distinct `Plugin` types and emits a wall of `Type 'Plugin<any>' is not assignable to type 'Plugin<any>'` — nonsense until you notice the paths differ by `node_modules/vitest/node_modules/`. Upgrading to vitest 4 dedupes onto root Vite and, as a side effect, cleared **all five** `npm audit` findings including the critical: every one traced to the nested `esbuild`/`vite`, not to anything we chose.
3. **A referenced composite project may not disable emit (TS6310).** `tsconfig.node.json` had both `composite: true` and `noEmit: true`. It now emits declarations only, into `node_modules/.tmp`.
4. **`tsc -b --noEmit` re-triggers TS6310 even when `tsc -b` succeeds.** The flag was redundant — the root project already sets `noEmit` in its own options — so `typecheck` is now plain `tsc -b`, identical to what `build` already does.
5. **Prettier must not touch `docs/`.** It flagged fifteen files, nearly all design docs, briefs, and the deliberately frozen mockups, and would have reflowed their tables and rewritten the mockup HTML. Added `.prettierignore`.

**Requirement withdrawn.** The P1-1 brief demanded exact pinned versions with no `^` ranges. That was over-strict: `package-lock.json` pins every resolution, and CI uses `npm ci`, which installs strictly from the lockfile and ignores the ranges. Caret ranges plus a committed lockfile is the conventional, reproducible setup.

**Known follow-up.** The empty shell already bundles to 548 kB (161 kB gzipped) — React, Router, TanStack Query, supabase-js. Not a problem yet; `manualChunks` code-splitting belongs in the board-UI brief, where the heaviest code lands, rather than as config churn now.

### 17.4 What the P1-3b build taught us (Aug 22, 2026)

The TypeScript API layer landed and works end to end — browser → typed client → RPC → RLS → Postgres, with the permission model visibly correct (Admin 7 cells, Ana 5, Marco 2). Four corrections were needed after delivery. **Every one traces to something the brief left unstated rather than to the code**, which is the pattern worth carrying forward.

1. **Hand-written `auth.users` rows break GoTrue.** Four token columns — `confirmation_token`, `recovery_token`, `email_change_token_new`, `email_change` — are the only ones with no database default, so a partial INSERT leaves them NULL. GoTrue scans them into non-nullable Go strings and every user load fails with the opaque "Database error querying schema"; sign-in never reaches the password check. Seeded auth users must set all token columns to `''` and carry a matching `auth.identities` row. The seed now asserts both.
2. **The client cache must be dropped when the signed-in identity changes.** Every cached query was fetched *as* a particular user and RLS scoped it to them, so it is not merely stale for anyone else — it is wrong. Query keys deliberately do not carry the user id: that would give each identity its own entry while leaving the previous user's rows resident in memory.
3. **`queryClient.clear()` is the wrong API for that.** It empties the cache but leaves mounted observers pending with nothing to re-run them, so the screen sticks on "Loading…" until a manual refresh. `resetQueries()` drops the data *and* refetches the active queries.
4. **Two config rules the code assumed and the config did not provide**: ESLint's `^_` convention for deliberately-unused destructured values, and Prettier ignoring `supabase/.temp/` (CLI runtime state, regenerated on every `supabase start`).

**Also settled: `src/features/auth/` is a named exception to the no-cross-feature-imports rule** (`docs/conventions.md`). The rule exists to stop *domain* features coupling to each other; who is signed in is app-level infrastructure every screen needs. An exception by name, not a precedent.

**The lesson for P1-4.** Both real bugs here were *transitions*, not steady states: what happens when identity changes, what happens to a query mid-swap. The board has far more of them — what happens to a drag in progress when a refetch lands, to a selection when the window scrolls, to an optimistic block when someone else moves its run. The P1-4 brief must specify transitions as carefully as it specifies rendering.

---

## 18. Addendum v1.5 — board rendering decisions locked for build (Aug 22, 2026)

Written alongside brief P1-4a. §16.2 described *what* the board shows; these close the gaps between the mockup's fixed three-day fake world and a continuous, RLS-filtered, up-to-92-day real one. Full execution detail lives in `docs/agent-briefs/p1-4a-board-render-brief.md`.

**P1-4 is split in two.** P1-4a is the read-only board — grid, hierarchy rail, shift/break layer, run bands, assignment chips, the left operator panel's read-only half, zoom, collapse, code-splitting. P1-4b is every interaction on top of it. The roadmap already listed rendering and interactions as separate lines; the split follows that, keeps each brief reviewable, and puts a working board on screen a cycle earlier.

| # | Decision | Rationale |
| --- | --- | --- |
| D13 | **The board renders in UTC in v1.** `BOARD_ZONE` in `src/features/board/lib/time.ts` is the single seam; no component may call a local-time `Date` method. | D10 anchored the seed to UTC and per-site timezone is still an open question. The load-bearing consequence: in v1 every day is exactly 1440 minutes, so board geometry has no DST discontinuity. |
| D14 | **The board window is always whole UTC days** — the date control picks dates, and `board_window` is called with midnight-to-midnight instants. | Day boundaries then sit at exact multiples of 1440 from the window origin, so the mockup's day strip ports over unchanged instead of needing per-day width math. |
| D15 | The x coordinate is **minutes since `windowStart`**; the mockup's hardcoded `DAY_MIN = 4320` becomes a computed `windowMinutes`, and every `for (day = -1; day <= 2)` becomes `day <= dayCount`. | The `-1` is load-bearing — it is what makes the previous day's overnight shift tail appear on the first rendered morning. Verified: starting that loop at 0 loses the tail *and* invents a spurious 00:00–06:00 off-shift gap on both seeded templates. |
| D16 | Zoom table ported verbatim (Compact 64 px/h, Standard 104, Fine 168; snap 60/30/15), default Standard. The `snap` column ships in P1-4a although only P1-4b uses it. | It is one table; splitting it across two briefs is how the two halves drift. |
| D17 | Default window = 3 days from the UTC Monday of the current week. | Matches seed decision D10, so a freshly seeded database shows populated rows on first load. |
| D18 | **A node is a track row iff its level is schedulable**; indentation comes from ltree path depth. Nothing anywhere hardcodes "department / line / cell". | §2's dynamic hierarchy. The mockup's three fixed tiers are a mockup artifact, not a model. |
| D19 | **No virtualization library** — windowing is hand-rolled from prefix-sum row offsets and a binary search. | Row heights here are *computed* from lane packing, not measured, so a measuring virtualizer buys nothing; and hand-rolling puts every line of the math in a pure module that can be executed and mutation-tested in the agent container. Same precedent as `shapes.ts`'s hand-rolled guards instead of zod. |

**Nearest-ancestor resolution walks ltree paths, never `parent_id` chains.** Both the shift template and the node's skill requirements resolve this way. A node's parent may sit outside the loaded window when `p_root_path` starts mid-tree; the path always works.

**A malformed `timerange` degrades to one missing block, never a blank board.** `parseTstzRange` throws by contract, so the index builder catches per row, drops it, and counts it. Silent coercion would be worse and a white screen would be much worse.

### 18.1 The npm block has a hole, and the brief is shaped around it

`node --experimental-strip-types` runs a `.ts` file directly by erasing its annotations, and Node 22 is already in the agent container. So a module with **no runtime imports** — only `import type` — is executable there even though npm is unreachable.

P1-4a is therefore split along that line rather than along a conceptual one, per [[brief-writing-rules]] rule 1: the whole load-bearing math layer (`time.ts`, `geometry.ts`, `boardIndex.ts`) is pure and dependency-free, and the brief makes running it *and* mutation-testing it mandatory with real reported output. The React half stays author-only. This is the first brief on this project where a frontend deliverable has a genuinely verifiable half.

Constraints this imposes on those three files, all stated in the brief: `import type` on every import (a value import would need alias resolution strip-types does not do), and no enums, namespaces, parameter properties, or decorators (strip-types erases, it does not transform).

**Verified before the brief shipped.** The design session ran the harness pattern in the container against ported copies of the mockup's shift functions and lane packer: the day −1 tail, the 3×8h zero-gap case, the 2×10h one-240-minute-gap-per-day case, and the boundary-dedup case all pass, and mutations M1 and M3 both break their named cases. One error was caught this way *in the brief itself* — the lane-packing acceptance case asserted the wrong lane number, since greedy first-fit puts the two short blocks on lane 0 and the long one on lane 1, not the other way round. Same failure mode as P1-2's impossible cap case and P1-3a's impossible `move_run` case: an acceptance case written from reasoning rather than execution.

### 18.2 Transitions the board must specify (the §17.4 lesson, applied)

§17.4 ended by saying the P1-4 brief must specify transitions as carefully as rendering. P1-4a §10 enumerates nine and each is a required behaviour, not a note. The four that shape the architecture:

- **Scroll anchoring is by node id, not by pixel.** A refetch can change a row's height (a new assignment adds a lane), so restoring `scrollTop` in pixels silently jumps the view. The board records the first visible row's node id and its offset within the viewport and restores *that*, with an ancestor fallback for when the node is gone — which is exactly what an identity change does.
- **Zoom preserves the instant under the viewport's horizontal centre.** The mockup preserved the left edge; centre is the correction.
- **A background refetch must not blank the board.** With a 30s `staleTime`, rendering the spinner on `isFetching` rather than on "pending with no cached data" makes the board flash empty every half minute.
- **Scrolling never triggers a fetch in P1-4a.** The loaded window is exactly what the toolbar asked for, and the board marks its own end rather than letting the limit read as a bug. Window-extension-on-scroll is deliberately deferred.

### 18.3 Verifying the P1-4a build (Aug 22, 2026)

The agent's own numbers: 19 §12 cases green under `node --experimental-strip-types`, all 6 §13 mutations confirmed to break their named case and restored, delivered `lib/` files never mutated. Then the design session verified independently, per [[verification-standard]] — a cold re-run of the agent's own harness proves only determinism, so none was performed.

**An independent 23-case probe, written to cover what the brief never prescribed** — binary-search off-by-one at exact row boundaries, `visibleMinuteRange` clamping at both edges, `clipToWindow`'s half-open behaviour at 0 and at `windowMinutes`, `isFullyAllocated` exactly at the cap, a string `capacity_cap`, assignment attribution when `run.node_id` and `assignment.node_id` disagree, `droppedRanges` counting runs as well as assignments, and `depth` under a mid-tree `p_root_path`. All 23 passed cold against the delivered files.

**Seven unprescribed mutations. Six were caught; one was not.** Deleting `buildBoardIndex`'s `withRanges.sort(...)` — the line that orders assignments before `packLanes` — passed the agent's entire suite *and* the first 23 probe cases in silence. Greedy first-fit is order-sensitive, but every fixture in play happened to pack identically either way. The case that exposes it is three back-to-back blocks fed out of chronological order: A(00:00–01:40), B(01:40–03:20), C(03:20–05:00) occupy **one** lane sorted and **two** unsorted, so the row silently renders a lane taller with the sort gone. That test now lives in `src/test/boardIndex.test.ts` and fails correctly when the sort is removed.

The general lesson, worth more than the specific bug: **a fixture that passes both with and without the behaviour under test is not a test of that behaviour.** The brief's §12 case 5 sorted its own input before calling `packLanes`, which made it structurally incapable of seeing the integration-level sort disappear. When a brief extracts a helper *and* specifies who is responsible for its precondition, it must also require a case where the precondition is violated.

Two other coverage holes, both found by the agent and both real bugs in the brief rather than in the code:

- **§13's M4 named a case that cannot distinguish the mutation.** `isUnderstaffed(1, null)` returns `false` whether `null` short-circuits or is coerced to `0`, since `1 < 0` is false either way. Needs a negative effective headcount (`-1 < 0` is true) to separate them.
- **§13's M6 likewise.** None of §12's case-11 assertions tested the overscan margin, so dropping it passed. Needs a case asserting the returned range extends past the viewport on both sides.

Scope fence and conventions were checked by grep across the whole delivery, all clean: no `pointerdown`/drag/mutation-hook code, no local-time `Date` methods, no colour literals outside `tokens.css`, no `database.types` import outside `src/lib/api/`, `BoardProof` no longer imported.

**One nit carried to P1-4b, not fixed here:** `BoardGrid`'s T2 zoom handler open-codes the minute↔pixel conversion inline instead of calling `pxToMinutes`/`minutesToPx`. It is arithmetically identical today, but it is exactly the duplication [[brief-writing-rules]] rule 4 exists to prevent — two implementations of one conversion that can drift. The P1-4b brief should require it routed through `geometry.ts`.

**Still outstanding:** the entire `npm` acceptance run (typecheck, lint, format:check, test, build, plus the eight in-browser checks). Nothing in Part B has ever been compiled. §17.3 is the precedent for what that surfaces — five config errors in code that was otherwise correct.

### 18.4 D17 revised — the board opens on today, not on Monday (Aug 24, 2026)

**D17 as written anchored the default window to the Monday of the current week.** That was wrong, and it was wrong for a revealing reason: the rule was chosen to line up with the *seed's* anchor (D10, "day 0 = Monday of the current week in UTC"), which is a fixture concern. It leaked into the product. Open the board on a Friday and the useful part of the schedule sits four days off the right-hand edge — the user has to go looking for the present before they can do anything.

**Revised:** the default window starts on **today** (`startOfUtcDay(now)`), keeping the 3-day span. Surfaced by Pratik at P1-4a acceptance.

Two things landed with it, both gaps in the P1-4a brief rather than in the build:

- **The mockup's `.daynav` cluster (◀ Prev day · Today · Next day ▶) was never mentioned in the brief**, so it was never ported. §7 said "port the toolbar" and then enumerated zoom, date range, snap note and legend — an enumeration that silently *replaced* the mockup's day navigation with a From/Days control. Restored. Lesson for P1-4b: when a brief lists what a ported component contains, that list is read as exhaustive; say "plus everything else the mockup has" or enumerate completely.
- **Opening on the right day is not the same as opening at the right time.** The board now scrolls the current instant into view on first mount and whenever "Today" is pressed, placing `now` a quarter of the way across the visible track so there is a little context behind and most of the screen ahead. Prev/Next day deliberately do *not* re-scroll — that would fight the user who just paged somewhere to look at it.

**Also fixed at acceptance, both real bugs found from screenshots:**

1. **T2's zoom centring ignored the rail.** The operator rail is `position: sticky; left: 0`, so it overlays the first `RAIL_WIDTH` (232px) of the viewport and the track is visible only in the remainder. The handler used `viewport.width / 2` as the centre, biasing it by 116px — and because that bias converts to a *different* number of minutes at each zoom (≈109 min at Compact, ≈41 min at Fine), the view drifted later on every zoom-in instead of holding still. Measured from three screenshots at 10:21 → 11:08 → 11:37 (+47, +29 min) against a predicted +42, +26. Now uses `viewport.width - RAIL_WIDTH`. The max-scroll clamp had the same omission and is fixed with it.
2. **The active zoom button never highlighted.** A CSS-specificity loss in the port: the mockup's `.zoom button.on` (0,2,1) outranks `.zoom button` (0,1,1), but the flattened CSS-Module class `.zoomOn` is only (0,1,0) and *loses*. Now `.zoom button.zoomOn`. Worth remembering generally — flattening a descendant selector into a CSS Module class silently drops specificity, and the symptom is a style that appears to do nothing.

### 18.5 P1-4b — delivered, Part A verified, agent report LOST (Aug 24, 2026)

The build agent completed and delivered P1-4b (create / move / resize, popovers, toasts, keyboard paths) and extracted it into the repo — every file in the brief's §9 list is present, and the pre-existing components genuinely picked up the drag wiring. **It was then killed mid-run by an org monthly spend limit, before writing its §17 report.** Nothing technical failed.

**What that costs us:** no §11 harness output, no §12 mutation table, no §7 PostgREST finding, no §13 self-review, and — most valuable of all on this project — **no list of the agent's assumptions and deviations**. Every previous build surfaced real brief bugs there.

**What the design session verified directly instead**, which is the more trustworthy half anyway:

- **An independent probe of the delivered `interaction.ts`: 33 cases green cold** — the brief's 19 plus 14 unprescribed (exactly-15-minute create, resize clamped to 0, a block longer than the window, non-mutation of inputs, nearest-vs-first shift snapping, `minuteToDate` exactness, tie-break determinism at the grip edge).
- **All seven prescribed mutations run. Six were caught by that probe.** M5 (use shift points whenever non-empty, ignoring `useShiftSnap`) slipped — because no probe case supplied `shiftPoints` while the flag was false. **The agent's own suite does catch it**: it added `case1c (extra, M5 coverage)` because §12's M5 row explicitly said "add that case if yours does not already cover it". The brief's warning worked, and the design session's probe was the weaker of the two on that point. Probe case U14 now closes it.
- **Scope fence holds by grep**: no component calls `useMoveRun` or `useApplySplitCoverage`, no `p_override` is ever sent, no `supabase.*` outside `src/lib/api/`, `pointercancel` is handled, and both `getBoundingClientRect` calls are in keydown handlers rather than the pointermove path (§5.1's perf rule).
- `DevProfileSwitcher` survived the rewrite of `BoardPage.tsx` — checked specifically, because a stale-copy rebuild silently dropped it once during P1-4a acceptance.

**Not verified, and this is the whole outstanding risk:** Part B has never been compiled. No typecheck, no lint, no build, no browser. P1-4a's precedent says expect two or so cosmetic config errors; P1-1's says expect five.

**Process note worth keeping.** A subagent can die for reasons that have nothing to do with the work, and its report is not recoverable. The code survives because delivery happens before reporting — that ordering is worth preserving in every brief. Where a report is lost, the design session's own probe plus a scope-fence grep recovers most of the signal; what it cannot recover is the deviations list, so a lost report should be treated as "unreviewed brief", not merely "unreported build".

### 18.6 What P1-4b's first compile found (Aug 24, 2026)

`npm run test` went **132 green** (was 99). Three lint/typecheck findings, and one of them mattered.

**`revertLabel` was dead code — and it was T12.** TypeScript flagged `useDragGesture.ts:234` as assigned-but-never-read. The obvious fix is to delete it. That would have been wrong: `revertLabel` builds exactly the string T12 requires (*"Widget X 06:00–14:00 — reverted"*), and `useSchedulerToast` even ships a `reverted(message)` helper whose own comment says it exists so a caller can control that wording. Both halves were built; nothing connected them. **T12 was unimplemented, and the only visible symptom was an unused variable.**

Wired in instead of deleted, as `failWith(err, label)`: `CapacityExceeded` / `NotEligible` / `RunOverlap` already name the operator or the cell, so they go through D37's one true path untouched; every other kind gets the block label prefixed, because a bare *"You don't have permission"* gives no clue which of a screenful of blocks just snapped back.

**The general lesson, and it is not a small one: dead code is evidence.** An unused symbol in agent-delivered work is a claim that something was built and then not connected — which is exactly what a half-implemented requirement looks like from the outside. Before deleting one, check the brief for a behaviour whose name matches it. Had the agent's report survived, this would presumably have been a flagged deviation; instead the compiler surfaced it. That is a second, weaker safety net, and it only works if dead code is investigated rather than swept.

The other two were genuinely trivial: an unused `Assignment` type import in `dragGesture.test.ts`, and an `eslint-disable-next-line no-alert` for a rule this config does not enable.

**Noted for P1-4c, not fixed here:** the crew-outside-the-run warning (§5.3) uses `window.confirm`. It satisfies the brief, which specified the behaviour but not the mechanism — but a blocking browser dialog sits oddly beside the popover system the same brief asked for, and it cannot be styled or tested through the DOM. Replace it with a real confirm step in the popover shell when P1-4c revisits these paths.

**Still outstanding:** the four popover-fired mutations (`saveRunFields`, `deleteRunWithMode`, `saveAssignmentFields`, `removeAssignment`) still call `toast.schedulerError` without a label, so T12 holds for drag reverts but not yet for popover edits. Those call sites only receive an id, not the subject, so closing it needs an id→label lookup that `BoardIndex` does not currently expose. P1-4c should add `runById`/`assignmentById` to the index — `ToastResolveCtx` already anticipates a `runById`.

### 18.7 The CSS-Module specificity trap, a third time (Aug 24, 2026)

P1-4a lost the zoom button's selected state to it (§18.4). The P1-4b brief called it out as §10.1 with a worked example. The agent **fixed it for `.seg button.segOn`** — and wrote a good comment explaining the cascade while doing so — then shipped the identical bug in `.pri`, three times, in all three popovers.

The failure mode is nastier than the zoom one because it is *partial*. `.row button` sets `background` and `border`; `.pri` sets `background`, `border-color` and `color`. `.row button` (0,1,1) beats `.pri` (0,1,0) for the two they share — but `color` has no competitor, so it applies. The primary button therefore rendered **white text on a white background**: not "unstyled", but invisible. A rule that half-applies is much harder to see than one that does nothing.

Fixed as `.row button.pri` in all three. The four remaining `#fff` literals went to `var(--avatar-fg)` at the same time (P1-4a's no-literals rule, which nobody re-checked for the new files).

**The rule to carry forward, and to put in every future brief that ports mockup CSS:** the mockup is written with `#pop`-scoped descendant selectors, so *every* state class in it (`.on`, `.pri`, `.under`, `.override`, `.dragging`, `.full`) is a compound `#pop element.class` that ties-and-wins on source order. Flattening any of them to a bare `.class` in a CSS Module drops it below the base `.parent element` rule. **Porting a state class means porting its compound shape** — `.row button.pri`, never `.pri`. Naming the specific trap once was not enough; the brief should enumerate the state classes.

**Also fixed:** the create popover's target row gave the unit field the same width as the quantity field. Faithful to the mockup, but wrong — the unit is `maxlength=8`. Now 2:1.

**Not a bug:** an "Unexpected Application Error! Rendered more hooks than during the previous render" seen while the app sat idle. That is Vite HMR swapping a live hook module whose hook count had just changed — the design session had added one `useCallback` (`failWith`, §18.6) to `useDragGesture` while the dev server was running. React counts hooks across renders and the hot-swapped module has one more than the mounted tree. A hard refresh clears it; it cannot occur in a production build. Worth recognising on sight, because it looks exactly like a conditional-hook bug and both `BoardPage` and `useDragGesture` were checked, hook by hook, before that conclusion was reached — every hook in both is unconditional and above every early return.

### 18.8 CLOSED: PostgREST does map `PTxxx` to HTTP status (Aug 24, 2026)

Open since §17.2, because nothing in the app could trigger a rejection for real until P1-4b made the board editable. Forced deliberately at acceptance — a second 100% assignment for an operator already fully loaded — and observed in DevTools:

```
POST http://127.0.0.1:54321/rest/v1/rpc/create_assignment
Status Code: 409 capacity exceeded: operator 50000000-…-000000000001 would reach 2.000 (cap 1.0)
Proxy-Status: PostgREST; error=PT409
```

**The mapping holds.** `api_raise`'s `PT409` SQLSTATE surfaces as a real HTTP 409, with the message intact and PostgREST naming the code in `Proxy-Status`. The client contract's decision to switch on the JSON `error` field rather than the HTTP status (§17.2 item 3, `docs/api.md` §1) turns out to be belt-and-braces rather than load-bearing — which is the right way for that bet to resolve. **No client change; the assumption is now a verified fact.** Item removed from the outstanding list.

**Also seen and NOT a bug:** a sibling `create_assignment` row returning `PGRST202` — *"Searched for the function public.create_assignment without parameters"*. That is the CORS **preflight**. The app runs on `localhost:5173` and Supabase on `127.0.0.1:54321` — different origins — and the request carries `Authorization`/`apikey`/`Content-Profile`, so Chrome sends an `OPTIONS` first. An OPTIONS has no body, so PostgREST tries to resolve the overload with no arguments and cannot. Harmless, and worth recognising on sight because it looks like a malformed call. There is exactly one `create_assignment` call site and it sends all ten arguments.

### 18.9 P1-4c delivered and verified — plus a bug in the brief's own CSS (Aug 24, 2026)

Delivered by a fresh agent in **69k tokens against P1-4b's 336k** — the tighter, more mechanical brief did what it was meant to. Full §14 report this time, including a proper deviations list.

**Design-session verification** (per [[verification-standard]] — own probe, not a re-run of the agent's):

- **17 independent cases, all green cold.** Beyond the brief's seven: that a band still fits above the first lane at every density, that every density field is strictly ordered (not just `laneHeight`), that heights stay integers so row offsets never land on a sub-pixel, that a track row always exceeds a group row, and that lane packing is unaffected by density.
- **Five unprescribed mutations, all five caught.** Drifting Standard's `laneTopOffset` by 2px, letting a band overlap lane 1 at Compact, reading group height from Standard regardless of density, dropping `rowPadBottom`, and reordering the density table. The end-to-end pixel-identity guard (`I4`) catches the first directly.
- **Scope fence clean**: no `src/lib/api/`, no `package.json` change, no stale geometry constant outside comments, `.density button.densityOn` correctly compound.

**The brief's `--ui-scale` formula was a bug — but not the one first suspected.** `clamp(1, 0.75 + 0.25 * (100vw / 1440px), 1.35)` divides a length by a length to get a unitless number. That reads as invalid CSS, and the initial diagnosis was that it would break every scaled declaration. **Executed in headless Chromium instead of reasoned about, and the diagnosis was wrong**: it works, giving 11px → 13.14px → 14.85px across 1440/2560/3840 and clamping correctly. CSS Values 4 permits it and Chromium implements it.

The *real* risk was different and worse than a no-op. A browser lacking the capability does **not** fall back through `var(--ui-scale, 1)` — the custom property is set, merely invalid at computed-value time, so the whole `font-size` declaration is dropped and the element jumps to the **UA default**. Measured: an unguarded element rendered at **16px** instead of its intended 11px. Now wrapped in `@supports (line-height: calc(100vw / 1440px))` with a plain `--ui-scale: 1` default, so the failure mode is "no scaling" rather than "no styling". Both branches verified in the browser.

**The lesson is the one this project keeps relearning, now pointing at the design session rather than the agent:** reasoning about a formula produced a confident and wrong answer twice over — first "this is invalid", then implicitly "the fallback will catch it". Executing it produced the truth in one step. Rule 5 of [[brief-writing-rules]] said to run acceptance cases before shipping a brief; that was done for the *arithmetic* here (all ten density cases) and not for the *CSS*, which is exactly where the bug was.

**The agent's best deviation: D48's premise was wrong.** The brief asserted the height chain was broken and told it to fix `#root` → outlet → `.page` → `.body`. The agent traced it and found `.shell { height: 100% }` and `.main { flex: 1; min-height: 0; overflow: auto }` already correct, and said so rather than inventing a change. The white area below the last row is not a broken chain — it is simply the scroll container's background where there is no content, because seven cells do not fill a 4K display. Cosmetic if it is worth anything at all. **A brief that asserts a diagnosis rather than a symptom invites the agent to "fix" something that was never broken; this one didn't take the bait.**

**Known gap, deliberately not closed:** chip/block height stays a hardcoded 22px with no density field, which the agent flagged rather than inventing one. At Compact (`laneHeight: 22`) a block therefore exactly fills its lane with no gap, where Standard leaves 6px and Comfortable 12px. Blocks will look flush at Compact. Add `blockHeight` to the density table when someone finds that annoying.

### 18.10 D46 amended — the board fits its height automatically (Aug 25, 2026)

**P1-4c's D46 was wrong, and Pratik was right to push on it.** It made density a manual setting, reasoning that a 4K screen might be a wall display or a dense planning station and the pixel count cannot distinguish them. True — and it answered the wrong question. **The variable that matters is row count, not screen size**, and row count is not a property of the display at all: an admin sees 7 cells, an Assembly supervisor 5, a line supervisor 2, on the same monitor. No fixed density fills the viewport for all three, so density buttons only move the dead space around rather than removing it.

Measured against the seed board at Standard, natural content height is **740px for Admin, 544px for Ana, 254px for a two-cell line supervisor**. Required scale to fill:

| viewport | Admin | Ana | line supervisor |
| --- | --- | --- | --- |
| laptop 900px | 0.97 | 1.32 | 2.82 → clamped |
| 4K browser ~1320px | 1.54 | 2.09 | 4.47 → clamped |
| TV 2160px | 2.67 → clamped | 3.63 → clamped | 7.78 → clamped |

With `FIT_MIN 0.75` / `FIT_MAX 2.5`, **the cases that actually occur — Admin and Ana on a laptop or a 4K browser — land inside the band and fill the screen exactly, 0% dead space.**

**The design (brief P1-4d).** `fitScale = clamp(0.75, availableHeight / naturalHeight, 2.5)`, where `naturalHeight` is the row total at Standard, **unscaled**. Computing from natural rather than scaled heights is what makes it a single pass instead of a feedback loop. `scaleDensity(base, factor)` multiplies every density field and **rounds to integers**, because a sub-pixel row offset blurs every border on the board. The toolbar becomes `Fit | Comfortable | Standard | Compact` with Fit default; the named densities remain as a manual override, so D46 is amended rather than deleted. **SUPERSEDED (D75, §19.7): the three manual density buttons were removed from the toolbar on Aug 25 and Fit is now the only mode.** The mechanism survives unreferenced — do not read this paragraph as a description of the shipped UI.

Under Fit, `--ui-scale` follows the fit scale (clamped to 1.75) rather than the viewport, so text grows with the rows — a row 2.5× taller with 11px text looks broken — and never scales by both inputs at once. That also sidesteps P1-4c's `@supports` path entirely on the Fit branch, since JS computes a plain number.

**The limit, stated rather than chased.** Two rows on a 2160px TV would need 7.8× and is clamped to 2.5×, leaving ~68% empty. That is intended: rows 600px tall are not a better board. Filling a wall display with two rows needs a genuinely different layout — bigger type, fewer columns, a summary panel — which is a separate design question. The brief tells the agent that if it finds itself raising `FIT_MAX` to chase this, it should stop and flag it instead.

**All 11 acceptance cases were executed against a reference implementation before the brief shipped** ([[brief-writing-rules]] rule 5), including the one most at risk from rounding: that `bandTop + bandHeight <= laneTopOffset` still holds at 0.75×, 1.37× and 2.5× after `Math.round`. It does.

### 18.11 P1-4d delivered and verified — and my mutation tables need the same treatment as my acceptance cases (Aug 25, 2026)

Fit-to-height landed. Verification per [[verification-standard]] — own probe, not a re-run of the agent's.

**16 independent cases, 15 green cold, one real hole found.** `computeFitScale` let **NaN propagate**: `computeFitScale([NaN], 800)` and `computeFitScale([100], NaN)` both returned NaN, which would flow into `scaleDensity`, make every row height NaN, and render a blank board. Not reachable through today's call path — `ResizeObserver` always reports finite numbers — but this single number is what all board geometry hangs off, so it now has layered `Number.isFinite` guards on `availableHeight`, on the natural total, and on the raw ratio. Verified: removing any one layer is still caught by the next.

**This was my gap, not the agent's.** The brief's case 4 *said* "degenerate inputs never produce 0, NaN or Infinity" but the assertions it prescribed only covered an empty array and a zero height. The agent implemented exactly what was asserted. Prose in a brief is not a test.

**Four unprescribed mutations run; two initially slipped.** Reversing the clamp was caught; dropping `rowPadBottom` from `scaleDensity` and flooring `laneTopOffset` while rounding the rest were **not**, because the probe checked invariants (band fits above lane, heights are integers, ordering survives) without ever checking that *every field* equals `Math.round(base × factor)`. One added case closes both. A partially-scaled density is exactly the kind of bug that looks fine at a glance and drifts by a pixel per field.

**Two more errors in my own mutation table, both caught by the agent and both verified rather than asserted.** M3 (floor vs round) cited cases 1 and 3 — but both use integer factors (1 and 2), where `floor` and `round` are identical, so neither could ever catch it. M4 (leave `bandTop` unscaled) cited case 9's geometric invariant — but leaving `bandTop` *smaller* while `laneTopOffset` scales up keeps that invariant comfortably true. Both are actually caught by the exact-value check at fractional factors.

**That is four mutation-table mis-mappings across three briefs** (P1-4b's M4 and M6, P1-4d's M3 and M4). The pattern is now clear enough to name: [[brief-writing-rules]] rule 5 says to *run* acceptance cases before shipping a brief, and that has been done faithfully for the acceptance list — but the **mutation table has been written from reasoning every time**, and reasoning about which assertion catches which mutation is exactly as unreliable as reasoning about arithmetic. Rule 5 now extends to the mutation table: apply each mutation to the reference implementation and record which case actually fails, rather than predicting it.

**One agent claim that did not survive checking.** Its deviations list flagged a pre-existing bug — `BoardGrid` passing `density={index.density}` to `TrackRow`, "whose props type declares no `density` field". `TrackRow.tsx:87` declares `density: Density`. The agent misread. The deviations section has been the highest-value part of every report on this project, but it is not infallible, and a flagged deviation is a lead to check rather than a fact to act on.

**Architecture the agent chose (§5 was left to it, correctly):** `fitScale` is computed inside `BoardGrid` — where the `ResizeObserver` and the collapse-filtered row list already live — and reported up via `onFitScaleChange`, leaving `BoardPage` as the sole owner of the `buildBoardIndex` call and its `density` argument. Crucially it derives `naturalHeights` from `laneCount`/`isTrack` rather than from `row.height`, since the latter already reflects whatever density the index was built with — which under Fit is a function of the previous `fitScale`. That is precisely the circularity D51 exists to prevent, and it reasoned the settle behaviour through explicitly rather than assuming it.

### 18.12 Two more P1-4d corrections found at compile and on screen (Aug 25, 2026)

**1. `as const` and a scaling function are mutually exclusive — the brief asked for both.** P1-4c's D43 wrote `DENSITIES` `as const`, which made `Density = (typeof DENSITIES)[number]` a union of **literal** types (`laneHeight: 34 | 28 | 22`). That was fine while the only densities were the three in the table. P1-4d's `scaleDensity` returns computed numbers, and no literal type can hold one — six `TS2322`s, one per field. The agent implemented exactly what both briefs specified; the specifications contradicted each other and only the compiler could say so. Fixed by declaring an explicit `interface Density` with `number` fields and typing the table `readonly Density[]`.

Worth generalising: **`as const` on a table is a bet that nothing will ever derive a new member of that type.** P1-4c took that bet reasonably; P1-4d broke it one brief later. When a table's type is going to be produced as well as consumed, widen it at the point the producer is introduced.

**2. The rows scaled; what lives in them did not.** Fit made every row taller and left the bands, chips and text at their original size, so a 2× row was mostly empty space. Three separate causes, all gaps in the briefs rather than the build:

- **Chips and blocks had no density field at all** — `height: 22px` and a `15px` avatar, hardcoded in CSS. The P1-4c agent flagged this explicitly ("no density field exists for it and none was added, per the no-independent-design-decisions instruction") and the design session acknowledged it and did not close it. It became visible the moment rows could grow. Added `chipHeight` (26/22/18) and `avatarSize` (18/15/13), published as `--chip-h` / `--avatar-size` alongside the existing `--band-h` / `--lane-h`.
- **`--ui-scale` was never applied to band, chip or block CSS.** P1-4c scaled the toolbar and header fonts and stopped there, because at the time nothing else could change size. Every `font-size` in those three modules now goes through `calc(Npx * var(--ui-scale, 1))`.
- Standard's new fields are **22 and 15 — exactly the values the CSS hardcoded**, preserving the Fit-off regression guard.

**New invariant, verified rather than assumed:** a chip must fit inside its lane (`chipHeight <= laneHeight`) and an avatar inside its chip, at every density and **after rounding** across the whole 0.75–2.5 factor range. Independent `Math.round` on two fields is exactly the kind of thing that holds at the three factors anyone would test by hand and fails at some fourth. It holds; now asserted.

**Pattern worth naming across §18.9–§18.12: every one of these was found by execution, none by review.** The NaN leak, the `as const` collision, the unscaled chips — the first by a probe, the second by `tsc`, the third by looking at a screenshot. Reading the code found none of them. The corollary for a design session that cannot run the app: get the thing compiled and on screen as early as possible, and treat "it reads correctly" as worth very little.

### 18.13 P1-4e delivered — the board is feature-complete (Aug 25, 2026)

Cross-cell run moves, split coverage, eligibility overrides, panel drag and run re-parenting all landed, plus the three debts P1-4b left. The agent ran 29 acceptance cases and all six mutations, and filed two refinements to the mutation table (M3 also fails case 3; M4 also fails the single-participant-at-cap assertion) — both correct.

**Two findings from the agent that are worth more than the code.**

**1. The brief's scope fence and its headline feature were mutually exclusive.** §12 item 9 said "`src/lib/api/` untouched"; D66 (re-parent a chip between runs, or detach it to direct) requires patching `run_id`/`product_id` on an existing assignment, and no field on `AssignmentFieldEdit` could carry that. The agent extended the interface by 26 lines, guarded (`if ("runId" in edit)`), and **flagged it as a deliberate deviation** rather than either inventing an RPC or quietly duplicating a write path. Correct call, correctly surfaced. The lesson for future briefs: a scope fence written as a blanket file prohibition will eventually collide with a feature that needs one field in that file — say "no new RPC and no second write path" instead, which is the property actually being protected.

**2. `apply_split_coverage` cannot express a move-and-split in one call.** §5 step 1 lists a chip *move* as a split-coverage trigger. But `p_adjustments` is `[{assignment_id, efficiency}]` — **no timerange** (verified in `docs/api.md` §3). An assignment that is simultaneously moving in time *and* needing its efficiency reduced therefore cannot go through that RPC without a second write, which §5 step 6 forbids for exactly the intermediate-state reason recorded in §17.2 item 5. The agent left the chip-move path as an ordinary field update and let the capacity trigger reject it server-side, documenting why in the code. That is the right resolution given the API, and it means **the split flow is reachable from a create or a panel drop but not from moving an existing chip.** If that turns out to matter in use, the fix is a widened `p_adjustments` accepting an optional timerange — a database change, not a client one, and out of scope here.

**A real bug in `splitEvenly`, and my brief caused it.** The brief said *"the remainder goes to the FIRST participant, so three-way at 100% is 34/33/33"*. The agent implemented that literally — `out[0] += remainder` — which is correct for every example the brief gave (n=2, 3, 4 at cap 100 all have a remainder of 0 or 1) and wrong in general: an eight-way split at 100% produced `[16,12,12,12,12,12,12,12]`, a spread of 4, which is not an even split. Corrected to one unit each to the first `remainder` participants: `[13,13,13,13,12,12,12,12]`, spread 1. n=3 still gives 34/33/33, so the brief's stated example is unchanged.

**How it was caught matters more than the bug.** No example-based case could find it, because every example in the brief had a remainder small enough that both implementations agree. It fell out of a **property** test — *max share − min share ≤ 1* — which is true of an even split by definition and holds for every n and every cap. The recurring lesson across §18.9–§18.13 is that acceptance cases written as examples keep failing to distinguish two implementations; the ones that catch real bugs assert a property that must hold across a range. [[brief-writing-rules]] rule 5 now covers running the mutation table; this adds: **where a function has an obvious invariant, assert the invariant rather than three worked examples.**

### 18.14 The scaling audit — a custom property does not cross a portal (Aug 25, 2026)

The create popover did not scale on a 4K display. The obvious reading is "P1-4c left the popovers out of scope, so add `calc()` to their CSS" — and that alone would **not have worked**, which is why it is worth recording.

**`BoardPopover` is `createPortal(node, document.body)`.** A portaled node is not a DOM descendant of the board root, and `--ui-scale` was published as an inline style *on the board root*. Custom properties inherit down the DOM tree, so every `var(--ui-scale, 1)` inside a popover would have silently resolved to the `1` fallback. Verified in headless Chromium, three ways:

| where `--ui-scale: 1.6` is set | portaled popover renders |
| --- | --- |
| board root only (what P1-4c did) | 12.5px / 260px — **no effect** |
| `document.documentElement` | 20px / 416px — correct |
| removed again | 12.5px / 260px — stylesheet cascade restored |

Fixed by publishing the fit scale on `document.documentElement` in an effect, and removing it when Fit is off so P1-4c's viewport-driven `:root` rule takes back over instead of being permanently shadowed by an inline style. The board-root inline copy is left in place as harmless duplication.

**The audit, because "which else is affected" is not answerable by inspection.** Every `*.module.css` was checked mechanically for a bare `font-size: Npx`. Fourteen files had one, and none of them had been scaled: both popovers *and* app chrome (`AppShell`, `HealthPill`, `DevProfileSwitcher`), the drag ghost, the toasts, and stray declarations in `GroupRow` and `TrackRow` that P1-4c's partial pass had missed. All now go through `calc(Npx * var(--ui-scale, 1))`; a repeat grep returns nothing.

The popover's own `width: 260px` and `padding: 12px` scale too — a fixed box holding 1.75× text overflows in exactly the way P1-4b's unit field did (§18.7).

**Two lessons.** First: **P1-4c's scaling pass was partial and nobody noticed for three briefs**, because the surfaces it missed were ones nothing else had reason to change. A cross-cutting concern like scale needs an exhaustive sweep with a grep, not a per-file judgement — "which files did I touch" is the wrong question, "which files declare a font size" is the right one. Second: **portals break custom-property inheritance**, and the failure is silent — the fallback value makes it look deliberate. Any future `--*` published for the board must go on `:root`, not the board root, unless it is genuinely board-local.

**Also corrected here:** the day strip was 20px tall with an 11.5px label, the same weight as an hour tick, so the date read as noise rather than a heading. Now 28px with a 15px bold label, and `.hdrTrack` grew 54px → 62px. That number is **duplicated** in `BoardGrid`'s `HEADER_HEIGHT_PX`, which fit-to-height subtracts from the container height; changing one without the other under-measures the available height. Both are now changed and both carry a comment pointing at the other.

### 18.15 `--chrome-scale`: the header cannot scale with fit, or fit becomes circular (Aug 25, 2026)

The day label scaled but its 28px strip did not, so at high fit scales the text clipped. The obvious fix — scale the strip's height by `--ui-scale` too — introduces a **feedback loop**: header height depends on `--ui-scale`, which is the fit scale, which is derived from the available height, which is the container height *minus the header*. A fixed point that can oscillate between two adjacent values, and one that nothing in the current design would damp.

The P1-4d agent anticipated this exactly, in a comment on `HEADER_HEIGHT_PX`: the constant is safe *"unless `.hdrTrack`'s height ever becomes `--ui-scale`-dependent"*, in which case it must become a measured probe. Making it a probe would work but would also make the loop real.

**Resolved by splitting the two scales rather than measuring:**

- **`--ui-scale`** — fit-driven, up to 1.75, published on `:root` by `BoardPage`. Used by everything *inside* the fitted content: bands, chips, blocks, popovers, toasts.
- **`--chrome-scale`** — viewport-driven only, up to 1.35, pure CSS, never overridden. Used by the header.

The header's size is then a pure function of viewport width, so `HEADER_HEIGHT_PX` stays a constant and no loop exists. It is also the better model: **the header is chrome around the fitted content, not part of it.** A board with two rows should not get a giant date bar just because its rows grew.

Verified in headless Chromium at 1440 / 2560 / 3840 with `--ui-scale` deliberately pinned at 1.75: the label renders 15 / 17.9 / 20.25px, a 16 / 20 / 22px line box inside the 30px strip, fitting at every width and never following the fit scale. Strip 28px → 30px and `.hdrTrack` 62px → 64px for headroom, with `HEADER_HEIGHT_PX` moved in step.

**The general shape, worth carrying:** when a derived value feeds back into its own input, the fix is usually to find the second, independent variable the thing should actually depend on — not to measure harder.

---

## 19. Addendum v1.6 — onboarding and the hierarchy admin surface (Aug 25, 2026)

Written alongside brief P1-5a, the first brief since P1-3a whose whole deliverable is
executable in the agent container. Everything below was **executed against the seeded
scratch database**, not reasoned about — including the mutation table, which
[[brief-writing-rules]] rule 5 was extended to cover after P1-4d.

### 19.0 Before anything else: the SQL suite had been broken for three days

`scripts/verify-db.sh` aborts at step 6 with `ERROR: column u.created_at does not exist`.
P1-3b's dev sign-in work (Aug 22) appended a GoTrue block to `seed.sql` that writes ~20 real
`auth.users` columns and an `auth.identities` row; `supabase/tests/00_harness.sql`, the
scratch-DB auth shim, still declared only `auth.users (id uuid, email text)`.

Nobody noticed because **P1-4a through P1-4e were all frontend briefs** — nothing had run the
SQL suite since P1-3a. Fixed by extending the harness, never the seed (the same call as §17.2
item 3: the seed legitimately targets real Supabase; the shim is the thing that drifted). With
the harness extended, all 9 migrations + seed + 6 test files are green again.

**The process lesson:** the SQL suite has no CI, so it rots silently across frontend briefs.
Re-run `verify-db.sh` at the start of any session that touches the database, *before* trusting it.

### 19.1 Six invariants the schema does not hold — all measured

The admin tree editor is the first surface in the product that can create these states. Today
nothing prevents any of them.

| # | State the database accepts today | Measured consequence |
| --- | --- | --- |
| F1 | Levels cannot be reordered in one `UPDATE` | `unique (org_id, position)` is non-deferrable; swapping positions 1↔2 fails with a duplicate-key error |
| F2 | Nor can the schedulable flag be moved in one `UPDATE` | `hierarchy_levels_one_schedulable` is a partial **index**, and an index can never be deferred |
| F3 | Two root nodes may share a name | `unique (org_id, parent_id, name)` treats NULLs as distinct; both roots get `path = plant_1` |
| F4 | Sibling names that slugify alike produce duplicate paths | "Cell 1" and "Cell-1" are distinct `name`s but both slugify to `cell_1` |
| F4a | **That collision leaks subtree grants** | A profile granted *only* Cell 1 was measured to get `app_can_read_node` **and `app_can_edit_node` = true** on `Cell-1`, a different node, because `app_grant_paths` compares `n.path <@ gp` and the two paths are byte-identical. `Cell 2` correctly stayed invisible — a specific leak, not a broad one |
| F5 | A node can become its own ancestor | The composite self-FK does not detect cycles. `nodes_cascade_path` then re-roots the subtree under itself, and **a recursive `parent_id` walk never terminates** (measured: alternating Cell 1 / Line 1 forever, stopped only by an explicit hop guard) |
| F6 | Level adjacency is enforced nowhere | Re-parenting a Work Cell (position 3) directly under a Department (position 1) is accepted, skipping Line entirely |

F5 has not bitten yet only because §18 requires nearest-ancestor resolution to walk ltree paths,
never `parent_id`. **An admin tree editor walks `parent_id` by nature**, so the board's discipline
does not protect it.

Checked and *not* holes: deleting a `hierarchy_level` that still has nodes is correctly blocked by
`nodes_level_id_fkey`, and a legal same-depth re-parent cascades descendant paths correctly.

### 19.2 Decisions

| # | Decision | Rationale |
| --- | --- | --- |
| D67 | **`(org_id, path)` carries a unique index.** | Closes F3 and F4 — and therefore F4a — as a *database* invariant, so no client, import or future RPC can bypass it. Verified: the existing seed satisfies it. |
| D68 | **A `BEFORE INSERT OR UPDATE OF parent_id` trigger rejects a parent that is the node itself or one of its descendants.** Trigger named `nodes_before_cycle` so it sorts *before* `nodes_before_path` and sees a coherent `OLD.path`. | Closes F5 structurally. Postgres fires same-timing triggers in **name order**, so the name is load-bearing, not cosmetic. |
| D69 | **Level adjacency is enforced by a trigger with a documented escape hatch** — skipped when `current_setting('app.hierarchy_migration')` is `'on'`. | §2 put this rule in "the application" so hierarchy edits stay cheap, and migration 0001 carries an explicit *do not add it here later* note. That note was protecting the Phase-3 mid-level-insertion tool, not the invariant. A trigger plus a named escape hatch keeps the invariant on by default and still lets that tool run. This **amends** the 0001 note rather than ignoring it. |
| D70 | **The hierarchy definition is saved whole, as an ordered array**, by `save_hierarchy_levels(p_levels jsonb)`; the array index *is* the position. | Removes "positions must be contiguous" from the validation surface entirely — a payload cannot express a gap. F1/F2 then reduce to one internal concern: write in two passes (clear `is_schedulable`, offset every position by +1000, then set final values). Capped at 64 levels so the offset can never collide. |
| D71 | **`move_node` re-parents only; it never changes `level_id`.** The new parent must be exactly one level above the node's *existing* level. | Moving a Work Cell under a Department could otherwise silently promote it to a Line, taking its runs onto a no-longer-schedulable node. Refusing is the honest answer. |
| D72 | **The schedulable level cannot move while scheduled work exists** (`schedulable_level_locked`), counting runs **and** direct assignments. | Moving it would orphan every run onto a non-schedulable node — rows the board can no longer render or reach. The assignments half is not redundant: after P1-4e a direct assignment can exist with no run at all. |
| D73 | **`delete_node(p_mode)` is `'deactivate'` \| `'delete'`**, mirroring `delete_run(mode)`. Deactivate cascades to the whole subtree; delete refuses while the node has children, runs or assignments. | A deactivated parent with active children is not a state anyone means. Delete stays available for onboarding typos and is refused the moment history depends on the node. |
| D74 | **Six new machine error codes** join the closed set: `path_collision`, `node_cycle`, `level_mismatch`, `level_in_use`, `node_in_use`, `schedulable_level_locked`. All routed through `api_raise`, all `PT409`. | §17.2 item 3's contract: clients switch on the JSON `error` field. Raw constraint violations are not part of that contract, so every RPC pre-checks and raises a named code rather than letting `23505` surface. |

### 19.3 What executing the acceptance cases and the mutation table actually found

36 acceptance cases, all green cold against the reference implementation. Twelve mutations,
each applied on its own and re-run — **every mapping in the brief's table is a recorded
observation, not a prediction.** That was worth doing four times over:

**1. Two mutations were NOT CAUGHT on the first pass, and both were my gaps.**

- **M9** (count runs only, ignore assignments) survived, because the only case exercising the
  schedulable lock had runs present. New case L12 detaches every assignment and deletes the runs
  first. This is D72's second half having no test — prose in a brief is not a test, again.
- **M11** (drop `move_node`'s level pre-check) survived, because the trigger caught the write with
  the *same* error code and nothing could tell the two apart. Textbook "a mutation of a redundant
  clause cannot fail anything". Resolved by noticing the payloads differ — the trigger's `DETAIL`
  carries `node_id`, the RPC's does not — so new case N17 asserts the *absence* of that key.

**2. A bug in the reference implementation that no amount of reading would have found.** Two
cases failed with `record "r" is not assigned yet` (SQLSTATE 55000). The cause: the blocking-work
query was written `FROM runs r JOIN nodes n`, and `r` was also the name of the declared record
variable for the write loop. **PL/pgSQL resolves a table alias against a declared variable of the
same name**, and the variable was still unassigned. Filed to [[postgres-supabase-gotchas]]. The
brief warns about it by name, because it is invisible until the exact branch runs.

**3. A bug in the harness, which mislabelled a whole class of failure.** The helper that extracts
the machine code did `v_detail::jsonb` inside a nested handler and, on failure, returned
`SQLSTATE` — but inside that handler `SQLSTATE` is the *cast's* code (`22P02`), not the error
under test. Every non-`api_raise` failure was therefore reported as `22P02`. Capture
`RETURNED_SQLSTATE` in the outer handler *first*. Worth stating because the same shape will
appear in whatever harness the agent writes.

**4. One thing I inferred and then disproved.** M4 (remove `move_node`'s own cycle pre-check)
reported `level_mismatch` instead of `node_cycle`, and the first reading was "the two pre-checks
are in the wrong order". They are not — the cycle check already runs first, and M4 removes it, so
the level check is simply what remains. The real finding underneath is sharper and did survive:
**every move beneath one's own descendant necessarily also skips a level**, so `move_node`'s
`node_cycle` is reachable only because it is checked first. The cycle pre-check is load-bearing
for *error quality*, not for safety — the trigger is what makes it safe. Checking the source
order took one command; writing the wrong version into this document would have cost a cycle.

**5. Over-broad mutations are worth naming as such.** M7 (level trigger off by one) fails six
cases and M3 (cycle test reversed) fails three, including cases about unrelated behaviour. The
table names one primary case for each and records the collateral, so a future reader is not
misled into thinking those cases are *about* the mutated line.

### 19.4 Scope boundary for P1-5

> **SUPERSEDED (Aug 25) — the three-way split below is stale.** §19.9 re-split P1-5 into four
> and §19.13 renumbered again. **Current: 5a database ✓ · 5b client layer ✓ · 5c board debts ·
> 5d admin screens · 5e CSV import.** The Part-A/Part-B reasoning below still holds; only the
> brief NUMBERS changed. Read §19.9 and §19.13 before quoting this section.

Onboarding splits into three briefs along the line [[brief-writing-rules]] rule 1 draws:

- **P1-5a — hierarchy levels + node tree, database half.** Everything above. Fully executable
  in-container; no author-only half at all.
- **P1-5b — the admin pages.** Part A: a pure `lib/hierarchy.ts` (tree assembly from the flat node
  list, legal-drop-target computation, level-editor validation mirroring the RPC's rules). Part B:
  React, author-only.
- **P1-5c — CSV import.** Part A: a pure parse/plan module (RFC 4180 quoting, BOM, CRLF, header
  mapping, duplicate detection, parents-before-children ordering for the tree). Part B: the
  import wizard, plus the upsert-by-`external_id` RPC. §7 calls CSV import "the sync pipeline with
  a manual trigger", so this brief is what validates the whole upsert machinery.

**A scope fence written as a blanket file prohibition is banned from here on** — §18.13's lesson.
P1-5a's fence names the properties being protected (no new write path outside the RPCs, no client
reimplementation of the tree rules), not a list of untouchable files.

### 19.5 P1-5a delivered and verified — the probe found three real defects, and two of them were mine (Aug 25, 2026)

Built by a fresh agent in **329k tokens** across two rounds. All six §3 files delivered, `md5sum`-matched
both sides, `src/` untouched, migrations 0001–0009 untouched, no `SECURITY DEFINER` anywhere, both
triggers correctly named, `proacl` clean on all five functions.

**Design-session verification, per [[verification-standard]] — my own probe, never a re-run of theirs.**
The 36-case harness written *before the agent existed* passed cold against its migration. All 12
prescribed mutations broke exactly the cases §10 names. Then the part that mattered:

**Six unprescribed mutations. Not one was caught — by either suite.** Four were genuine coverage
gaps (`create_node` never asserted it trims the name; `delete_node`'s `profile_grants` cleanup is
unreachable from the seed fixtures, because every seeded grant sits on a node with children; a
direct `INSERT` with `parent_id = id`; a direct `INSERT` of a non-root-level node with a NULL
parent). Two were **correctly** uncaught and are worth recording as such: scoping `create_node`'s
collision check to siblings is equivalent to scoping it org-wide, because a path collision can only
occur between siblings; and `move_node`'s "only a position-0 node may have no parent" check is the
M11 shape again — the trigger catches it identically, so it buys error-payload quality, not safety.

**Then I probed every RPC with NULL arguments, and found three defects no suite caught.**

| # | Defect | Severity |
| --- | --- | --- |
| D1 | **`delete_node(id, NULL)` silently HARD-DELETED the node.** `p_mode NOT IN (...)` is NULL — not true — when `p_mode` is NULL, so the guard never fired; `p_mode = 'deactivate'` is also NULL, so control fell through to the *delete* branch. Measured on a childless, work-free node: `{"mode": "delete", "deleted": 1}`, row gone | **A malformed argument performing the destructive action when the documented default is the safe one.** |
| D2 | `create_node(parent, name, NULL)` raised a raw `23502` | outside the §7 closed set — the client's parser cannot read it |
| D3 | `save_hierarchy_levels` raised a raw `22P02` on an unparseable `id` | same |

**D1 and D3 were bugs in my brief and in my own reference implementation, not deviations by the
agent.** The reference had the identical NULL-blind `NOT IN`, and my 36 cases never passed a NULL
argument to anything. The agent implemented the specification faithfully; the specification was
wrong. Round two fixed all three, added seven cases (D1–D3, U1/U4/U5/U7), and I confirmed each new
case has teeth by reverting the fix it guards and watching it fail.

**The lesson, and it is a sharper version of one this project keeps relearning.** §18.11 said prose
in a brief is not a test. This adds: **an acceptance suite that only ever passes well-formed
arguments tests the happy path of the error handling, not the error handling.** Every one of the 36
cases exercised a *wrong* input — a name that collides, a move that cycles, a level that is in use —
and not one exercised a *malformed* one. Those are different axes, and the second was completely
absent. Worth a standing item: for any function reachable from a client, probe every argument with
NULL before the brief ships.

**One agent claim that did not survive checking, and one that did.** Its deviation list said case
N15 does not fail under M7 because "N15 exercises the root branch" — I could not reproduce that
against my reference, where N15 re-parents a level-3 cell to a level-2 line, squarely the non-root
branch. On being asked, the agent found the real cause and it was better than either reading: **its
own N15 used Plant 1**, the one node with a legal NULL parent, so the case never tested the
non-root move its name promised. Rewritten. Its other claim — that mutating a trigger which fires
during seed loading breaks the *seed*, a louder signal than a failing case, and one my live-patch
mutation runner never sees — is correct, and is the better methodology for trigger mutations.

**Explicitly NOT verified by me:** the seven remaining prescribed mutations (M1, M3, M4, M7, M10,
M11, M12) were re-run by the agent against round two but not by me; I re-ran only the five that
touch the three functions round two changed (M2, M5, M6, M8, M9), all correct. And there is still
only one org in the seed, so **no test anywhere proves cross-org isolation of these five RPCs** —
`(org_id, path)` unique would not catch a missing `org_id` filter with a single tenant. That is a
seed limitation, not a code one, and it is the strongest argument for a second seeded org before
P1-5c's CSV import goes anywhere near an upsert.

### 19.6 The fit loop was real after all — and it was the toolbar, not the header (Aug 25, 2026)

Reported as "the app is flashy, moving non-stop". Rows visibly resizing forever.

**What it was.** `BoardToolbar` sits above `.body` inside `.page`, so its height is subtracted from
the board's available height — the input to `computeFitScale`, whose output becomes `--ui-scale`.
Eighteen of the toolbar's dimensions were driven by `--ui-scale`, including paddings and input
widths, and `.header` is `flex-wrap: wrap`. Past roughly `--ui-scale` 1.06 the controls stop fitting
on one line and the toolbar grows **~56px in one step**.

Measured in the browser, three samples deep:

| state | `--ui-scale` | `--lane-h` | board `clientHeight` | `scrollHeight` |
| --- | --- | --- | --- | --- |
| A | 1.01548 | 28px | 871 | 871 (content-sized, no scrollbar) |
| B | 1.09035 | 31px | 815 | 873 (constrained, scrolling) |

Alternating 50/50. The arithmetic closes exactly, against §18.10's recorded 740px natural height for
Admin: `(871 − 64)/740 = 1.0905` — state **B**'s scale; `(815 − 64)/740 = 1.0149` — state **A**'s.
**Each state's height computes the other state's scale.** A two-cycle with no fixed point.

**Why it could not settle, when §18.15's version could.** §18.15 reasoned about this loop as a
*gradient* and concluded the danger was oscillation "between two adjacent values". A design-session
repro in headless Chromium confirmed the gradient case is harmless — the app header moves ~5px
across the whole scale range and the fixed point converges in three iterations at every viewport
tested. **The wrap makes the coupling discontinuous.** A step function has no fixed point to
converge to, so it cannot settle at all. That distinction is the whole finding: *a feedback loop
through a continuous quantity usually damps; a feedback loop through a layout threshold — a wrap, a
scrollbar appearing, a breakpoint — cannot.*

**The fix is §18.15's own rule, applied where §18.15 did not look.** `--chrome-scale`
(viewport-driven, ≤1.35) now drives every dimension in `BoardToolbar.module.css`, plus the app
chrome above it (`AppShell`, `HealthPill`, `DevProfileSwitcher`) and `BoardPage`'s
`.status`/`.error`/`.devWarning`, all of which sit outside the fitted scroll container and consume
vertical space. `--ui-scale` now reaches only fitted content (bands, chips, blocks, rows) and
portals (popovers, toasts, drag ghost), which is what it was always for.

**How this got missed, which is the part worth keeping.** §18.14's sweep asked the right question —
"which files declare a font size?" — and wired `--ui-scale` into fourteen of them, the toolbar
included. §18.15, the very next entry, wrote the rationale for why chrome must *not* use `--ui-scale`
and applied it to exactly one element, the one whose text had been seen clipping. The rule and its
violation were written on consecutive days by the same session. The comment block in `global.css`
describing this loop was already correct and already there — nothing was ever audited against it.

**The standing rule, now in the code:** anything outside the fitted scroll container that consumes
vertical space is chrome and belongs on `--chrome-scale`. The audit question is not "which files
declare a font size" but **"which elements' heights are subtracted from the height that drives the
fit"** — and it must be re-run whenever an element moves into or out of `.page` above `.body`.

**Unrelated, seen in the same console and worth recognising on sight:** `401 (Unauthorized)` on
`rpc/board_window` after a `supabase db reset`. The reset recreates `auth.users`/`auth.identities`,
so the JWT in local storage points at a user row that no longer exists. Clearing site data and
signing in again fixes it. A latent bug sits behind it, not yet fixed: `useSession`'s
`onAuthStateChange` guards `resetQueries()` on the identity actually changing but calls
`setLoading(true)` unconditionally, and `BoardPage` renders a bare "Loading session…" for that state
— so even a routine hourly token refresh blanks the whole board. §17.4's comment says the guard
exists precisely to prevent that; it was applied to one of the two statements.

### 19.7 D75/D76 — the density control is gone, and the decision record did not say so (Aug 25, 2026)

Surfaced by Pratik when a debugging instruction referenced a toolbar button that does not exist.
The instruction was wrong; chasing *why* it was wrong found a documentation gap that had been
sitting there since the control was removed.

| # | Decision | Rationale |
| --- | --- | --- |
| D75 | **The three manual density buttons are removed. Fit is the only mode.** `densityMode` stays in the store (default `"fit"`), `BoardPage` still branches on it, and `DENSITIES`/`scaleDensity` remain — they are what Fit is built from. Restoring the control is re-adding one button group and nothing else. | Fit already shrinks toward Compact when there are many rows and grows toward Comfortable when there are few, so the override only ever mattered for taste, and four buttons is a lot of chrome to spend on taste. |
| D76 | **Anything outside the fitted scroll container that consumes vertical space is chrome and uses `--chrome-scale`, never `--ui-scale`.** | §19.6. Generalises §18.15's header rule to the class of elements it belongs to, rather than the one element that was noticed. |

**The gap, stated plainly.** The removal was recorded in an excellent code comment in
`BoardToolbar.tsx` — what was removed, why, that the mechanism is unreferenced *on purpose rather
than by oversight*, and how to restore it. It was recorded **nowhere else**. §18.10 still read "the
toolbar becomes `Fit | Comfortable | Standard | Compact` … the named densities remain as a manual
override", and the roadmap's P1-4d row said the same. Both now carry a correction.

This is the failure mode this project has hit before from the other direction: §18.6's *dead code is
evidence*. Here the dead code is deliberate and well-explained at the call site, which is right — but
a decision that lives only in a code comment is invisible to anyone reading the decision record,
which is precisely what a design session reads before writing the next brief. **A code comment
documents an implementation; it does not amend a design decision. Both have to move.**

Two consequences worth carrying, beyond the correction:

- **P1-5b was about to be written against a stale premise.** The admin-pages brief would have been
  authored from §18.10's description of a toolbar that has not existed since Aug 25.
- **Fit is now load-bearing with no user-facing fallback.** When it was one of four modes, a fit bug
  had an escape hatch — the user could pick Standard and carry on. With the buttons gone there is
  none, which is exactly why §19.6's oscillation was so disruptive rather than merely annoying. This
  is not an argument for restoring the buttons; it is an argument that **the correctness bar for the
  fit path is now higher than it was when D53 chose the default**, and that any future change to
  `computeFitScale`, `scaleDensity`, or anything feeding `availableHeight` should be treated as
  touching the only rendering path there is.

### 19.8 `useSession` blanked the board on every token refresh (Aug 25, 2026)

Found while diagnosing §19.6, in the `401`s that turned out to be unrelated. `onAuthStateChange`
called `clearCacheOnIdentityChange(nextSession)` — which correctly guards the cache reset on the user
id actually changing, exactly as §17.4 intended — and then called `setLoading(true)`
**unconditionally**. `BoardPage` renders a bare `Loading session…` for that state, so every auth
event tore the whole board down and rebuilt it. supabase-js fires one roughly hourly on token refresh.

The guard existed and was correct; only one of the two statements it was written for was using it.
`clearCacheOnIdentityChange` now returns whether the identity changed, and the listener bails out
before `setLoading` when it did not — which also drops a pointless `user_profiles` re-fetch on every
refresh. The `getSession()` path is unchanged, since first mount must always load.

**Third instance today of one shape:** a guarded statement standing next to an unguarded neighbour
that needed the same guard. §19.5's `delete_node(id, NULL)` fell through a NULL-blind `NOT IN` into
the destructive branch; §19.6's `--ui-scale` was kept off the board header and left on the toolbar;
this one guards the cache and not the spinner. **When a guard is introduced, the question to ask is
not "is this statement guarded" but "what else in this function is conditioned on the same fact".**

### 19.9 Brief P1-5b written — and the mutation table found three blind fixtures and a harness bug

P1-5b covers the client half of the hierarchy admin: a pure `src/features/admin/lib/hierarchy.ts`
(Part A, executable in-container) plus the five typed RPC wrappers, six error codes and React Query
hooks (Part B, author-only). **The admin screens move to P1-5c and CSV import to P1-5d** — a change
from §19.4's split, made because P1-4c cost 69k against P1-4b's 336k purely on tightness.

A reference implementation was written and all 74 assertions run before the brief shipped, then all
12 mutations applied one at a time. Three findings worth keeping:

**1. `slugify` is duplicated logic, so the corpus is the contract.** 33 inputs were run through the
SQL `slugify()` on a scratch database and the expectations recorded verbatim. Two rows do the real
work: `ÀÉÎÕÜ` → `n_` (Postgres does **not** transliterate, so the instinctive
`.normalize("NFD")` implementation is wrong) and `Ünïcödé Zoné` → `n_c_d_zon` (the leading `n` is a
letter from the input, not the empty-string prefix).

**2. Three mutations caught nothing, all for the same reason.** Every fixture had been copied from
the shape of the seed, where `parentId` agrees with `path` and `sortOrder` agrees with `name` — so
building the tree from the wrong signal produced an identical tree, and dropping the `sortOrder`
comparison changed no order. The third was a sibling-path prefix: nothing in the fixture had a path
that was a string prefix of another's without a dot boundary, so `line_10` vs `line_1` went untested.
This is §18.3's rule for the third time — **a fixture that passes with and without the behaviour is
not a test of that behaviour** — and the generalisation is now sharper: *when two fields could each
explain the same output, the fixture must make them disagree.*

**3. A mutation can crash the harness, and a naive runner scores that as "not caught".** M6 changes
the tree's shape, so an assertion indexing into it throws; the uncaught throw aborted the file, no
`FAIL` line printed, and the runner reported NOT CAUGHT. Two defences, both now required by the
brief: evaluate every assertion inside try/catch so a throw becomes a named failure, and make the
runner treat *non-zero exit with zero failures* as CRASHED rather than passing. **That is the second
harness bug in two briefs** — P1-5a's mislabelled every non-`api_raise` failure as `22P02`. The
harness is code, and it is the code no one tests.

**Cost controls written into the brief, since P1-5a cost 329k.** Delivery is `device_bash` heredocs
only — no tarball, no `SendUserFile`, no base64 fallback (that fallback moved ~94KB of source as
~125KB of base64, each chunk appearing twice in context, plausibly a third of the run). The suite
must be table-driven: ~200 lines for 74 assertions here, against 1,453 lines for 43 cases in P1-5a.

### 19.10 D77 — portaled floating UI is chrome too, and the popover scaling pass was `font-size`-only (Aug 25, 2026)

Raised by Pratik: "I thought the scaling for pop windows was fixed, what's wrong?" Three separate
things were tangled together, and only one of them was a regression.

**1. Nothing broke. The popovers were scaling — by about 1.09.** Under Fit, `--ui-scale` *is* the fit
scale, and a 7-cell board on that display needs only ~1.09 to fill the height. The popover was
faithfully scaled by a number barely above 1, which reads as unscaled.

**2. D77: a portaled, fixed-position panel is chrome, and uses `--chrome-scale`.** §19.7's D76 said
chrome uses `--chrome-scale` but scoped it to *"elements that consume vertical space"* — which a
fixed-position popover does not, so popovers fell outside a rule that should always have covered
them. The argument is §18.15's, unchanged: **a floating panel is chrome around the fitted content,
not part of it.** Tying it to the fit scale produces an incoherence — two supervisors on identical
monitors, one seeing 7 cells (fit 1.09) and one seeing 2 (fit clamped to 2.5), get wildly different
popovers for a reason that has nothing to do with popovers. All six popovers and the toast stack now
use `--chrome-scale`.

**The drag ghost deliberately stays on `--ui-scale`** — it is a preview of a block, i.e. fitted
content that happens to be rendered above the page. The test is not "does it float" but "is it a
picture of something inside the fitted board".

**3. The real miss: the popover scaling pass only ever touched `font-size`.** The shell's `width` and
`padding` scaled and every font scaled, but every child popover's `padding`, `gap`, `margin`, single-
side offsets, and `SplitCoveragePopover`'s hardcoded `width: 60px` did not. 22 scale references moved
and **48 box dimensions** now scale that never did.

This is §18.14's own lesson landing in the place §18.14 declared fixed. Its audit is quoted there:
*"Every `*.module.css` was checked mechanically for a bare `font-size: Npx`."* It asked about
font-size and answered exactly that. **The audit question for a scale token is not "which files
declare a font size" but "which declarations carry a length".**

Verified in headless Chromium against the real repo CSS: at `--chrome-scale` 1.0 / 1.1 / 1.2 / 1.35
the popover is 286 / 314 / 343 / 385px wide with **no overflow at any scale** and a height:width
ratio holding to within 4.6% across the whole range (the residual is line-height rounding, not a
defect). Before the change the box did not scale at all.

**CORRECTION (§19.11): those widths are what the STYLESHEET does, not what the app renders.** The
repro was built from the CSS files alone; `BoardPopover.tsx` adds an inline `width`, which overrides
it. The padding and font numbers above hold; the width ones do not.

**What was NOT fixed, deliberately.** The reported symptom included "Direct assignment" wrapping to
two lines in the segmented control. **That does not reproduce here** — measured with `Range`
rects (see below), the label sits on one line at every scale from 1.0 to 2.5, with the button 130px
wide at scale 1. It wraps on Windows, so the cause is font metrics, not scale. Blind-fixing an
unreproducible symptom is §18.9's D48 trap — the brief asserted a broken height chain, the chain was
fine, and the agent was right to refuse. Waiting on a measurement from the affected machine.

**A measurement bug worth recording, because it nearly sent this the wrong way.** The first pass
counted lines as `height / line-height`, which counts **padding** as lines — it reported a one-line
button as "1.7 lines" and would have justified a fix to something that was never broken. The correct
measure is `range.selectNodeContents(el); range.getClientRects().length`. **Third time today that a
shortcut in the measurement, not in the code, produced the wrong answer** — after P1-5a's harness
mislabelling every non-`api_raise` failure as `22P02`, and P1-5b's mutation runner scoring a crash as
"not caught". Instruments need the same scepticism as the thing they measure.

### 19.11 The popover width has never scaled — an inline style has been overriding the CSS all along (Aug 25, 2026)

Surfaced only because Pratik pasted a measurement that did not match a prediction: `--chrome-scale`
≈ 1.243 and a font of 13.67px (= 11 × 1.243, so the token *is* reaching the subtree), but a popover
**272px** wide where `260 × 1.243 = 323px` was expected.

```tsx
// BoardPopover.tsx
width = 272,                    // default prop
style={{ left, top, width }}    // inline — outranks any stylesheet rule
```

**`.pop`'s `width` declaration has been dead since it was written.** The popover is a hard 272px at
every scale.

**This falsifies a claim in §18.14** — *"The popover's own `width: 260px` and `padding: 12px` scale
too"* — which was never true. The padding does scale (nothing sets it inline); the width never has.
The note was written in the same session as the change it describes and nobody checked it against a
render.

**And it falsifies half of §19.10's verification, which is the more useful failure.** That repro was
built from the repo's CSS files and measured 286 / 314 / 343 / 385px across the scale range. Those
numbers are correct *for the stylesheet*. They are not what the app renders, because the repro had no
way to know about an inline style living in a `.tsx` file it never read. **A repro assembled from the
CSS verifies the CSS, not the application** — it is blind to inline styles, to anything a component
sets imperatively, and to any rule the repro's own markup fails to match. The check that would have
caught it is the one that did: compare the repro's number against the running app's.

That makes four instances in one day of the *instrument* being wrong rather than the code — P1-5a's
harness mislabelling every non-`api_raise` failure as `22P02`, P1-5b's mutation runner scoring a
crash as "not caught", the line-count metric that counted padding as lines, and now a CSS repro that
measured a declaration the app overrides.

**Deferred to P1-5c, deliberately.** The inline width is not gratuitous — the positioning code needs
the number *before* layout to keep the popover on screen:

```js
Math.min(anchor.x, window.innerWidth - width - 10)
```

Simply deleting it lets CSS win the width and leaves the clamp computing against 272 while the box is
really ~338, so the popover would overhang the right edge by ~66px at this scale. The fix needs **one
source of truth for the scaled width, feeding both the inline style and the edge clamp**, and this
codebase already has the pattern: `BoardGrid`'s `railProbe` (P1-4c D47) — a zero-height element sized
to a token, whose computed width JS reads back through the used-value chain. Reading
`getComputedStyle(root).getPropertyValue('--chrome-scale')` is *not* an option: for an unregistered
custom property it returns the raw `clamp(...)` token stream, not a number, which is exactly what the
diagnostic snippet showed.

**P1-5c must therefore specify:** the popover's scaled width computed once via the probe pattern,
used for both `style.width` and the edge clamp; an acceptance case asserting the rendered width
equals `272 × chromeScale` at more than one scale; and a case asserting the popover stays inside the
viewport when anchored near the right edge at maximum scale. **Assert against the rendered app, not
against a CSS-only fixture.**

### 19.12 P1-5b built and verified — and the suite that proved it did not survive the container (Aug 25, 2026)

The build agent delivered all five files at **243k tokens**, against P1-5a's 329k. The three cost
controls held: `device_bash` heredocs (no tarball, no `SendUserFile`, no base64 fallback), a
table-driven suite, and mutations executed before the brief shipped. Its report flagged three real
brief errors, all confirmed here. **But the most important finding is one nobody flagged.**

#### D78 — a brief that specifies a suite must also ship the suite as a repo file

The brief's §8 demanded 76 assertions and §10 specified the harness; its **§3 file table listed no
test file**, and neither did §13's final step. The agent did exactly as told: it built a table-driven
suite, ran it, mutation-tested it, reported the results — **in a scratch container that no longer
exists**. Nothing landed in `src/test/`. Every other pure module in this repo (`boardGeometry`,
`boardIndex`, `interaction`, `serde`, `shapes`, `errors`, `dragGesture`) has a vitest file; the
hierarchy layer had none, so `npm test` and CI would have gone on reporting green while guarding
nothing.

This is [[brief-writing-rules]] rule 1 in a shape it had not taken before. Rule 1 splits a brief by
*what the container can validate*, and that split is right — but it silently conflates **"executable
by the agent, once"** with **"guarded permanently."** P1-5b's Part A was the most thoroughly
validated frontend work on this project *and* the only frontend module with no regression test.

**D78: every brief that requires a suite must name the suite's repo path in its file table, in the
project's own test framework — not merely require that a suite be run.** The in-container harness is
the agent's proof; the committed test file is the project's. They are different artifacts and a brief
must ask for both.

The design session wrote the replacement: **`src/test/hierarchy.test.ts`, 488 lines, 101 assertions**,
carrying the brief's §6 corpus and §8 groups plus everything the independent probe found. All 12 of
the brief's mutations and 5 unprescribed ones were applied against it — **17 of 17 caught.**

#### The independent probe: one defect, three parity divergences, three instrument errors

A 54-assertion probe covering what the brief never prescribed — malformed arguments, Unicode case
mapping, structural edges, and the §5 subset invariant — was run cold against the delivered file.

**The defect (fixed).** `validateLevelDraft` **threw** on a null name, a missing `name` key, a null
array element, and a numeric name. The server returns a typed `blank_name` for the first three
(`trim(coalesce(e->>'name',''))=''`) and accepts the fourth. A validator the admin form will call on
every keystroke must never throw — this is [[verification-standard]] rule 4 (probe *malformed*
arguments, not merely wrong ones) landing for the second brief running, and it is the same shape as
P1-5a's `delete_node(id, NULL)`. Two `?.` and one `String(… ?? "")` close it; reverting the fix
produces four named failures.

**Divergence 1 — the whitespace one, and it is the server's bug.** Postgres `trim()` with no explicit
character set strips **spaces only**, so `trim(E'  \t ')` is `E'\t'` and the server **accepts** a
tab- or newline-only level name. JS `.trim()` strips all whitespace, so the client rejects it. That
is the client rejecting what the server accepts — precisely the direction §5 forbids. The right fix
is to tighten the **server** (`btrim` over a whitespace set) rather than weaken the client, and it is
**owed before P1-5d**, which pipes CSV — the most likely source of a pasted tab — straight into this.
A test pins the current client behaviour so the divergence cannot be closed by accident.

**Divergence 2 — `is_schedulable: 1`.** `('{"is_schedulable":1}'::jsonb->>'is_schedulable')::boolean`
is **true** in Postgres, so the server counts a numeric 1 as schedulable while the client's
`=== true` does not. Only reachable from untyped JSON; recorded, not fixed.

**Divergence 3 — an unknown TARGET level.** §4 step 1 covers an unknown *dragged* level
(`invalid_argument`) but never says what an unknown *target* level does; it falls through step 6 as
`level_mismatch`. Either answer breaks the subset invariant if the caller passes a partial array, so
**P1-5c must always pass the complete level list** — a constraint, not a code change.

**Three instrument errors, caught by the instrument being tested.** Continuing §19.11's run:
(1) the probe asserted `slugify(slugify("###")) === "n_"`; the real SQL returns `"n"` — the empty-name
sentinel is **not a fixed point**, which matters for P1-5d if it ever re-slugifies stored values.
(2) A `canDropOn` fixture used hand-written paths (`p1.a1.c1`) whose slugs did not match the node
names, so **M10 — the collision check forgetting to exclude the dragged node — was invisible**: with
the path and the name disagreeing, nothing ever holds the prospective path. Making the fixture
slug-consistent, as the database actually derives it, caught it immediately. This is
[[verification-standard]] rule 3 inverted and worth stating that way: **the brief's own advice to make
fields disagree is right for the fields the rule chooses *between*, and wrong for the fields the rule
*derives from each other*.** `parentId` vs `path` must disagree; `name` vs `path` must agree.
(3) One mutation was a no-op that scored "NOT CAUGHT".

**Unicode parity, confirmed rather than assumed.** Six inputs beyond the brief's corpus — the Kelvin
sign U+212A, Turkish dotted İ, fullwidth Ａ, Roman numeral Ⅰ, and the two accented rows — were run
through the real SQL `slugify()` on a UTF-8 PostgreSQL 16 database and against the client.
**All six agree**, including the two where JS's full Unicode case mapping and Postgres `lower()` were
most likely to diverge. Those rows are now in the committed suite as observations.

#### Confirmed brief errors from the agent's report

- **§5's "four of eight" is wrong.** §4 names five reason codes; the server now has nine checks
  (P1-5a's round-2 malformed-uuid guard made it nine). Corrected in the module's comment.
- **§7.3's query key presupposes a read hook that does not exist.** The agent introduced
  `hierarchyKeys.all = ["hierarchy"]` and documented it. **P1-5c must confirm or override it
  deliberately.**
- **`create_node`'s `level_mismatch` DETAIL puts the PARENT's id under the key `node_id`**, because
  the node being created has no id yet. Any UI reading that field must not assume it identifies the
  subject of the error.

#### Acceptance: three runs, seven errors, zero defects in the delivered logic

Part B had never been compiled by anything. The first `npm` run produced **7 `tsc` errors, all in
`src/lib/api/hierarchy.ts`, and none of them a bug in what the agent wrote.**

**Run 1 — the generated types were three days stale.** `src/lib/database.types.ts` was generated
Aug 22, before migration 0010, so none of the five hierarchy RPCs appear in its `Functions` union:
five `TS2345`s on the RPC names, and two more where `data` falls back to `unknown` because the
`.rpc()` overload cannot resolve. **A migration and its regenerated types are ONE change, not two** —
P1-5a landed 0010 and did not regenerate. Recorded in [[decision-record-drift]] rule 2: a generated
file is a decision record, and it is the one that drifts without anybody noticing, because the
roadmap's artifact index went on claiming "all 8 RPCs typed" and nothing in the container can compile.

**Run 2 — a nullability the generator structurally cannot express.** Two errors survived:
`p_parent_id` and `p_new_parent_id` are typed `string`, never `string | null`, because **Postgres
function parameters carry no nullability declaration**, so `supabase gen types` emits every required
argument as non-null. But 0010 branches on `p_parent_id is null` (create a root node) and
`p_new_parent_id is null` (move to the root) — both first-class paths. **Regenerating will never
widen this.** The codebase had already solved the identical problem: `mutations.ts` casts
`create_assignment`'s `p_run_id`/`p_product_id` pair at the single call site with a comment, exactly
as the P1-3b brief §2 prescribed. Same fix applied, same shape, one shared note.

**Run 3 — green.** typecheck, lint and build clean; **236 unit tests pass** (135 before this brief).
P1-5b added 1.5 kB raw to the app chunk.

**D79 — the §11 question was the wrong question.** Both misses have one root cause: the agent
**reasoned about generated artifacts instead of reading them.** It verified every RPC argument *name*
against migration 0010 line by line — careful, correct work — then answered §11 item 4 ("what would
you expect `tsc` to complain about") with "clean", and wrote doc comments asserting the generated
signature was `p_parent_id: string | null`. Both predictions were wrong, and it had never opened
`database.types.ts`. A correct method aimed at the wrong artifact.

**So future briefs replace that question with: "which generated or third-party artifacts does your
code depend on, and what does each one actually say — quote the line."** The first phrasing invites
reasoning and got two confident wrong answers; the second forces reading. This is rule 5's
"execution, not reasoning" applied to the *inputs* of the work rather than its output.

#### Not verified

Part B (five wrappers, six error codes, hooks) was never compiled — no npm in the container. The
agent's own flag is worth carrying: `useMutation<TData, SchedulerError, TVars>` puts a typed error in
the second generic, which nothing else in this codebase does. **Cross-org isolation remains untested
by anything** — the seed still has one org.

### 19.13 The whitespace fix, and the four days the SQL suite spent on the wrong database (Aug 25, 2026)

§19.12 recorded one client/server divergence: Postgres `trim()` strips spaces only, so
`save_hierarchy_levels` accepted a tab-only level name the client rejects. Fixing it took three
attempts, each wrong for a different reason, and turned up something considerably larger than the
bug it started from.

#### It was four sites, not one (verification-standard rule 7, third time)

The client only disagreed about one call. Grepping for what *else* was conditioned on the same fact
found **four bare `trim()` calls across three functions** — and two of them **store** the result
rather than validate it, so tab-padded names were being persisted:

| function | call | role |
| --- | --- | --- |
| `save_hierarchy_levels` | blank-name check | validate |
| `save_hierarchy_levels` | `v_name` assignment | **store** |
| `create_node` | `v_name` assignment | validate + **store** |
| `rename_node` | `v_name` assignment | validate + **store** |

`create_node(parent, E'\t')` therefore created a real node named `E'\t'`, whose slug is `n_`. Fixing
only the site the client complained about would have left three, and the mutation that reverts
exactly those three (X5 below) fails four cases — so this is measured, not asserted.

#### Three candidate character sets, two of them measurably wrong

**Attempt 1 — `btrim(x, E' \t\n\r\f\v')`.** This is what §19.12 itself recommended, and it is wrong.
Measured against JS `String.trim()` over a 12-character probe it matches on **6 of 12**, silently
leaving NBSP, EM SPACE, IDEOGRAPHIC SPACE, LINE SEPARATOR and OGHAM SPACE diverging. It is the shape
of fix that looks complete and closes half the hole.

**Attempt 2 — `[\s\uFEFF]`.** Matched JS on 12 of 12 when measured. Then it **failed in the actual
test suite**, because `\s` is **collation-dependent**: under the `C` locale it does not match NBSP at
all. A fix that passes on the machine it was written on and fails on the machine it ships to.

**Attempt 3 — an explicit code-point class**, exactly ECMA-262's WhiteSpace + LineTerminator:

```
[\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]
```

Naming code points makes it collation-independent. Verified character by character against Node v22
on an 18-point probe: exact parity, including U+FEFF (the character a CSV file opens with) and
excluding U+200B ZWSP, which JS does not strip either. **Parity is the requirement, not
aggressiveness** — a server that strips *more* than the client is the same invariant violation
pointing the other way.

One authoritative implementation, `app_trim_ws(text)`, now backs all four sites; nothing open-codes a
trim. Its comment says why, because the next reader's instinct will be to simplify it back to
`trim()`.

#### D80 — the scratch database was SQL_ASCII, and had been all along

Attempt 2 failed for a reason worth more than the fix: `scripts/verify-db.sh` ran a bare `initdb`,
the container sets no locale, and PostgreSQL therefore defaulted to **SQL_ASCII / C**. **Every SQL
test this project has ever run — all of P1-2's 31 cases, P1-3a's 28, P1-5a's 43 — has run against a
database whose encoding and collation do not match Supabase, which is UTF-8.**

What that actually cost:

- Non-ASCII cases were not merely untested but **unwritable**: `chr(5760)` raises *"requested
  character too large for encoding"*. The whitespace cases could not have been expressed at all.
- `lower()` stops doing Unicode case mapping — and `lower()` is the first thing `slugify()` does.
  The function whose corpus the P1-5b brief calls "the contract" was being exercised by a database
  that cannot reproduce half of it.
- It is invisible. Every test passed. A suite reports green just as loudly on the wrong database.

This is [[verification-standard]] rule 6 — the instrument is code and it is the code no one tests —
at the largest scale it has appeared yet. §19.11's version was a CSS repro that modelled the
stylesheet instead of the app; this one is a *whole database* configured unlike production, and it
sat under every SQL result this project has recorded.

**D80: `verify-db.sh` creates the scratch cluster and database as UTF-8 (`--encoding=UTF8
--locale=C.utf8`), re-initialising an existing cluster that has the wrong encoding, and then
ASSERTS the resulting encoding rather than trusting it.** The assertion is the part that matters:
its absence is what let this run for four days.

`C.utf8` is the only UTF-8 locale in the container. Before settling for it, the full `slugify`
corpus was run on a `C.utf8` database and on an ICU `en-US` database and **every row agrees** — so
the collation *provider* changes no answer here and the **encoding** was the whole problem. That
also retroactively clears the six Unicode rows committed to `src/test/hierarchy.test.ts` in §19.12:
they depend on UTF-8, not on a particular collation, so they hold on Supabase.

#### Verification

All 11 migrations apply cleanly and **all seven SQL test files pass cold on UTF-8**, with
`70_hierarchy_test.sql` now at **50 cases** (43 + W1–W7). Six mutations, each applied alone and
restored:

| # | Mutation | Cases that failed |
| --- | --- | --- |
| X1 | `app_trim_ws` reverts to bare `trim()` | W1, W2, W3, W4, W5 |
| X2 | the plausible `btrim(ASCII set)` fix — **attempt 1** | W3, W5 |
| X3 | the collation-dependent `[\s\uFEFF]` class — **attempt 2** | W3 |
| X4 | class wrongly includes U+200B ZWSP | W6 |
| X5 | only `save_hierarchy_levels` fixed, the other two reverted | W2, W3, W4, W5 |
| X6 | `app_trim_ws` drops the NULL coalesce | W7 |

X2 and X3 are the two wrong answers this section describes, kept as mutations so that a future
"simplification" back to either one fails a named test instead of quietly reopening the hole. W3
(NBSP) is the load-bearing case: it is the single case that separates all three candidate
character sets.

#### The §19.4 split is stale — read §19.9 instead

§19.4 still describes P1-5 as three briefs with "P1-5b — the admin pages" and "P1-5c — CSV import".
§19.9 re-split it into four and never came back to correct §19.4. The current split is: **5a
database ✓ · 5b client layer ✓ · 5c board debts · 5d admin screens · 5e CSV import** — the last
three renumbered again here, because the popover defect and the two missing regression tests are
board work that has nothing to do with the admin feature and should not ride inside it.
[[decision-record-drift]] with the design plan drifting against *itself*.

### 19.14 P1-5c built — and the delivery rule that was right for new files and wrong for edits (Aug 25, 2026)

All three board debts closed: the popover's inline-width defect (§19.11), and committed regression
tests for §19.6 and §19.8, neither of which had been guarded by anything.

**The agent found a real error in the brief and it was mine.** §4.3 said `OperatorPanel.module.css`
uses `--ui-scale` "19 times". It uses it **24 times across 19 lines** — I had run `grep -c`, which
counts lines, not occurrences. The conclusion was unaffected (the panel is correctly excluded), but
the number was wrong, and it was wrong in the section that tells the agent how to count.

#### D81 — reasoning about a token's DEFINITION instead of its RANGE

The brief left the resize-tracking mechanism to the agent, asking it to say which it chose and why.
It chose a `ResizeObserver` on the popover alone, with this argument: `--chrome-scale` is a `clamp()`
of `100vw`, so a viewport resize changes the box's own computed width, which *is* a resize of the
observed element — so no `window` resize listener is needed. It quoted the real line to support it,
which is exactly what §11 item 4 asked for.

**The argument is true of the definition and false across the range this app runs in.** Evaluating
`clamp(1, 0.75 + 0.25 * (100vw / 1440px), 1.35)`:

| viewport | `--chrome-scale` | popover width |
| --- | --- | --- |
| 800–1440px | **1.0000 (pinned)** | **272.0px (constant)** |
| 1600px | 1.0278 | 279.6px |
| 1920px | 1.0833 | 294.7px |
| 3456px+ | 1.3500 (pinned) | 367.2px |

It is **flat at 1.0 for every viewport ≤ 1440px** — which is every ordinary laptop, and every
windowed browser. Below that width, resizing changes the popover's width by exactly nothing, the
observer never fires, and the `window.innerWidth` captured at the last render goes stale. Open a
popover near the right edge, narrow the window, and it stays where it was and ends up off screen —
*the precise failure this component was being fixed to prevent.*

Fixed by tracking the viewport in state behind a `window` resize listener, with the same
change-guard as the size measurement.

**D81 sharpens D79.** D79 said: quote the artifact, do not predict it. That is necessary and not
sufficient — the agent *did* quote the line. The missing step is the next one: **evaluate the
expression across the range you actually operate in.** A `clamp()`, a media query, a breakpoint and
a `Math.min` all have the same property — they are locally constant, and reading them tells you the
formula while only evaluating them tells you the behaviour. Ask "at what input does this stop
changing?"

#### Two more from the independent probe

**A NaN anchor propagated all the way to the DOM.** The §8 table probed wrong-but-well-formed inputs
and never a malformed one — [[verification-standard]] rule 4 for the third brief running, after
P1-5a's `delete_node(id, NULL)` and P1-5b's throwing `validateLevelDraft`. `NaN` survives both
`Math.max` and `Math.min`, so `resolvePopoverPlacement` returned `{ left: NaN }`, React wrote
`left: NaNpx`, the browser discarded it, and a `position: fixed` popover then renders at its **static**
position instead of being clamped on screen.

The tell was rule 7 again: the function sanitised **three of its five** numeric inputs — `width`,
`height`, and both viewport dimensions — and not the anchor, `margin` or `gap`. A function that is
carefully defensive about some of its arguments and not others is describing where its author's
attention went, not where the risk is. Fixed; `P17`–`P24` guard it, and reverting the fix fails four
by name.

**The agent's suite is stronger than the reference I wrote.** Its group-P cases assert the whole
`{left, top}` object with `toEqual`; my reference probe asserted single fields for several cases. So
M3 and M4 break more cases in its build than the brief's table predicted, and it reported the
difference rather than quietly matching the table. That is the right behaviour and the table has
been annotated rather than the suite weakened.

#### D82 — heredoc delivery is right for NEW files and wrong for EDITS

**The run cost 370k against P1-5b's 243k, for a brief with half the assertions.** 239 tool calls
against 62. The structural difference is not brief length: **P1-5b created five new files; P1-5c
edited eight existing ones.**

§2.2 mandates `cat > file <<'EOF'` heredoc delivery for everything, a rule adopted after P1-5a lost
a third of its run to a base64 fallback. For a new file it is optimal. For an *edit* it is close to
the worst available option: the whole file has to be read into context, transcribed with the change
applied, and written back — so a three-line change to a 311-line component costs 311 lines of input
and 311 of output, and risks transcription drift. The agent noticed the risk, defended against it by
md5-verifying its transcription against the original before every edit, and **caught a real
mismatch that way in `RunPopover.tsx`.** The defence worked; it also doubled the cost of every edit.

**D82: briefs specify delivery by operation, not by file.**

- **New file** → `device_bash` heredoc, as now.
- **Edit to an existing file** → a targeted in-place `python3` read-modify-write over `device_bash`
  (read, assert the old substring is present, replace, write), which never brings the untouched
  parts of the file through context at all. The `assert old in s` is the integrity check that
  replaces the md5 dance.
- Still never a tarball, `SendUserFile`, or base64.

This session used exactly that technique for migration 0011 and the §19.13 edits; the brief simply
never told the agent it was allowed to.

### 19.15 A second org, and the cross-tenant leak it found in under ten minutes (Aug 25, 2026)

Every verification note since P1-5a has carried the same line: *cross-org isolation is not tested by
anything, because the seed has one org.* With a single tenant, a query that forgets `org_id` returns
exactly the same rows as one that remembers, so **every** RLS test, RPC test and acceptance case in
this repo passed under that blind spot.

Seeding a second org found a real cross-tenant read **and write** leak almost immediately.

#### The fixture is the finding

Org 2 (Contoso) is deliberately **not** a distinct fixture. Its levels, nodes, product SKU, skill,
shift template and employee ref all reuse org 1's actual values, so its node paths are *identical*:
`plant_1`, `plant_1.assembly`, `plant_1.assembly.line_1`, `plant_1.assembly.line_1.cell_1`.

Every uniqueness constraint in this schema is `(org_id, …)` — `(org_id, path)`, `(org_id, sku)`,
`(org_id, name)`, `(org_id, position)` — so all of that is legal *by design*. And that is the point:
**a leak between tenants is invisible when the two tenants look different, and unmissable when they
look the same.** One node, `Cell Z`, has no counterpart in org 1, so "org 1 must never see Cell Z" is
a single unambiguous assertion.

Writing the fixture also caught four wrong assumptions of my own: I had guessed org 1's skill, SKU,
shift-template name and employee ref, and all four were wrong (`CNC`, `WX`, `3 × 8h`, `EMP-001`). A
fixture whose comment claims collisions it does not have is worse than no fixture, because it reads
as covered.

#### D83 — the read leak, measured

`app_can_read_node` / `app_can_edit_node` are `SECURITY DEFINER`, so RLS on `nodes` does not apply
inside them, and they tested **only ltree containment**:

```sql
SELECT app_is_admin() OR EXISTS (
  SELECT 1 FROM nodes n, app_grant_paths(false) gp
  WHERE n.id = p_node AND n.path <@ gp)
```

Two independent holes: `app_is_admin()` short-circuits the whole expression and is not org-scoped,
so **any admin passed for any node in any org**; and the grant branch compared paths only, so a grant
on `plant_1.assembly` matched the *other* tenant's subtree.

Measured, not inferred:

| caller | saw | of which another tenant's |
| --- | --- | --- |
| org-1 admin | runs 9, assignments 13 | 1 run, 1 assignment |
| org-2 admin | runs 9 | all 8 of org 1's |
| Ana (org-1 supervisor) | runs 6 | 1 |
| Ana | `app_can_read_node(org-2 cell)` = **TRUE**, `app_can_edit_node` = **TRUE** | |
| Ana | `UPDATE runs WHERE org_id = <org 2>` | **1 row affected** |

A cross-tenant **write**, by a non-admin, in a multi-tenant product.

**Why it survived review.** `nodes_select` carries its own `org_id = app_current_org()` predicate, so
nodes never leaked and the hierarchy always looked right. All eight `runs` and `assignments` policies
delegate *entirely* to these two functions and add no org predicate — so the leak lived in exactly
the tables that carry the schedule, and nowhere it could be seen.

Fixed in migration 0012 by resolving the node together with its org inside both functions. That one
change covers all nine delegating policies; per [[brief-writing-rules]] rule 9 the org test is
deliberately **not** duplicated into the policies, because a redundant clause is one no mutation can
catch.

#### The second bug — and the correction I nearly shipped with it

`10_constraints_test.sql` then failed with `ERROR: invalid positions`. The cause is
`nodes_cascade_path()`:

```sql
update nodes set path = new.path || subpath(path, nlevel(old.path))
 where path <@ old.path and id <> new.id;
```

No org filter, and `<@` includes equality — so renaming org 1's `Line 1` matched org 2's node at the
identical path. `subpath()` then errored because the offset equalled the path length.

**My first write-up called this a second active leak. That was wrong, and running it is what
corrected me.** `nodes_cascade_path()` is `SECURITY INVOKER`, so RLS *does* apply to its internal
UPDATE, and `nodes_update`'s own org predicate blocks the cross-tenant rows. An org-1 admin renaming
through `rename_node()` leaves org 2 untouched **with or without the fix** — the first version of
case C19 passed under the mutation, which is how the overstatement was caught.

So this half is **latent, not active**: reachable only where RLS does not apply — the table owner, a
service role, a `SECURITY DEFINER` function, a migration, a bulk import. `10_constraints_test`
renames as the owner, which is why it saw it at all. It is fixed now because **P1-5e's CSV upsert is
exactly that shape**, and because the error was luck: had org 2 held a *deeper* node under the same
path, `subpath()` would have succeeded and silently re-pathed another tenant's subtree.

C19 now runs as the owner deliberately, with a comment saying why an org-1-admin version of the same
case tests nothing.

#### Verification

`supabase/tests/80_cross_org_test.sql`, **20 cases, all failing before 0012**. All eight SQL files
pass cold on UTF-8; three mutations, each caught by a named case:

| # | Mutation | Caught by |
| --- | --- | --- |
| Y1 | `app_can_read_node` loses its org scope | C1, C2, C3, C4, C5, C7 |
| Y2 | `app_can_edit_node` loses its org scope | **C6 alone** |
| Y3 | `nodes_cascade_path` loses its org scope | **C19** |

**Y2 is the instructive one.** It was expected to break C8/C9/C10 — the "an UPDATE of another
tenant's runs affects zero rows" cases. It did not: Postgres requires a row to be visible under the
SELECT policy before UPDATE or DELETE can touch it, so those three are guarded by the **read** path
and would keep passing while the edit path was wide open. C6, which calls `app_can_edit_node`
directly, is the only case that actually guards editing. Three cases that look like write tests are
read tests wearing a disguise — noted in the file so nobody deletes C6 as redundant.

#### What this changes about the standard

[[verification-standard]] rule 5 says to record what you did *not* verify. That line has been in
every note since P1-5a, and it was load-bearing: the moment the blind spot was closed, it produced a
security bug on the first run. **An untested invariant in a multi-tenant product is not a gap in
coverage, it is an unexamined claim about safety** — and the cost of leaving it untested rises with
every RPC written on top of it. Two migrations, five RPCs and a whole board UI were built over this
one.

### 19.16 D84 — scaling is the default, not a discipline (Aug 25, 2026)

Reported: the admin page does not scale on a 4K display. Measured: **129 raw pixel values across
three of the four admin stylesheets, and zero uses of `--chrome-scale`.** On a 4K screen the board
scaled to 1.35× and the entire admin surface stayed at 1×.

**The one admin file that DID scale was the popover** — the only one whose brief happened to mention
the mechanism (P1-5d §7.4, which told the agent to carry `BoardPopover`'s fix across). Nothing in the
brief said the surface itself must scale, so nothing did. The build followed its instructions exactly.

#### The rule was the problem, not the build

Every scaled dimension in this app is written by hand as `calc(12px * var(--chrome-scale))`. That
works and it is **something a person has to remember on every new stylesheet.** `BoardToolbar` has 24
of them; `AppShell` has 2; admin had 0. A convention that must be recalled per property will be
forgotten, and the only question is which surface forgets first.

So the unit changes instead:

```css
:root { font-size: calc(100% * var(--chrome-scale)); }
```

and new surfaces size in `rem`. **Scaling becomes the behaviour of the unit** — a stylesheet is
scalable with nothing to remember, and forgetting stops being possible rather than merely being
caught later.

`100%` rather than `16px`, so a user who has raised their browser's default font size keeps that
preference *and* gets viewport scaling on top of it.

**The guard from D47 is what makes this safe.** `--chrome-scale: 1` is declared unconditionally on
`:root` and only then overridden inside `@supports`. Without that, a browser that cannot divide a
length by a length leaves the custom property set but invalid at computed-value time, the whole
`font-size` declaration is dropped, and the element falls back to the UA default — which for *this*
declaration would mean every `rem` in the app shifting at once. The failure mode stays "no scaling",
never "no styling". That guard was written for a single element's `font-size`; it is now load-bearing
for the whole document.

**Verified before writing it:** the only `rem`/`em` in the entire codebase was one `0.04em`
letter-spacing, which resolves against its own element rather than the root. Nothing existing moves.

**The board keeps `calc(px * var(--chrome-scale))`, deliberately.** Its geometry is computed in real
pixels by JS — `HEADER_HEIGHT_PX`, lane heights, minutes-to-pixels — so px there is a decision, not
an oversight. Two idioms, with a reason for the boundary.

#### The conversion found two bugs of its own

**A media query in `rem` moves with the scale.** `@media (max-width: 56.25rem)` resolves against the
root font-size, which now scales — so on a 4K display the "narrow layout" breakpoint would have fired
at ~1215px instead of 900px. **A breakpoint is about the DEVICE; only content sizes are `rem`.**
Reverted to px, with the reasoning in the file.

**A converter that does not strip comments rewrites its own documentation.** The script turned
`272px` inside a comment *it had just written* into `17rem`, producing "17rem is 17rem at the default
root size". Third instance on this project of a CSS matcher that had to be taught the difference
between code and prose.

#### Enforcement — the half that makes it a default

`src/test/scaleAudit.ts` already guarded "no `--ui-scale` in chrome files" (D76). It now also guards
**"no unscaled pixel dimensions in a rem surface"**, with 12 committed cases. Exemptions are by
VALUE, not by property family: hairline widths (≤2px) on a border or outline, `box-shadow` offsets,
anything inside a `@media` prelude, and `0px`.

Seven mutations, each caught by a named case. Two are worth keeping:

- **The first version exempted anything matching `/^(border|outline)/`, which also swallowed
  `border-radius: 20px`** — a radius is a real dimension and must scale. Exempting by property
  family was the mistake; exempting by value is the fix.
- **Mutation Z2 reported NOT CAUGHT because it mutated the wrong function.** `countUiScaleUses` and
  `unscaledPxLengths` contain the *identical* comment-stripping line, so a single-occurrence replace
  never touched the function under test. **A mutation must be anchored on something unique to the
  function it targets** — otherwise the table records a hole that does not exist and hides one that
  does. New, and it goes in [[verification-standard]].

Also fixed en route: the matcher was line-oriented, so it depended on Prettier's one-declaration-per-
line formatting and would have reported **zero offenders** — indistinguishable from a pass — the day
two declarations shared a line. It now splits on newlines, semicolons and braces.

#### Multiple sites, and a limit worth naming

Checked directly rather than assumed: **multiple root nodes in one org render correctly.** Two Sites,
each with their own subtree, flatten in the right order with the right depths, and `+ add root node`
exists.

**But every site in an org must have the SAME shape.** `hierarchy_levels` is unique on
`(org_id, position)` — one ordered vocabulary per org — and `nodes_check_level_adjacency` requires
each node's level position to be exactly its parent's + 1. So an org cannot have
Site → Department → Line → Cell at one plant and Site → Line → Cell at another: the second plant's
Lines would have to sit at position 1 and position 2 simultaneously.

That is a consequence of D69/D70. It was never written down as a constraint, and it contradicts a
requirement Pratik stated at the start of this project: hierarchy levels are whatever the site wants.
**I recorded it as an open question and asked him to re-decide it, which was the wrong move and he
said so** — a gap between the code and a requirement already given is a DEFECT, not a question. It is
fixed in §19.18. The note stays because the shape of the mistake is worth keeping: finding an
undocumented limit is good; turning it into a question for the person who already answered it is not.

### 19.17 D85 — the regression 0012 caused, and the harness that reported it as PASS (Aug 25, 2026)

`create_node` had been dead since §19.15 shipped. For every caller, admins included:

```
ERROR:  new row violates row-level security policy for table "nodes"
CONTEXT: insert into nodes (...) values (...) returning *
```

**The fix in 0012 was right; its side effect was not.** Making `app_can_read_node` org-correct turned
it from an expression that could answer `app_is_admin()` without touching a table into one that
ALWAYS runs `SELECT 1 FROM nodes WHERE id = p_node AND n.org_id = ...`. `nodes_select` calls it as
`app_can_read_node(id)` — the id of the row the policy is being applied to. For an
`INSERT ... RETURNING`, PostgreSQL applies the SELECT policy to the NEW row, and the function is a
separate query running under the command's own snapshot, **which by definition does not contain the
row being inserted**. The lookup finds nothing, the policy is FALSE, the INSERT is rejected.

**Only `nodes` is affected, and that is why nothing else broke.** Every other policy that delegates to
`app_can_read_node` passes a FOREIGN key — `runs.node_id`, `assignments.node_id` — naming an
already-committed row. `60_api_test.sql`'s whole surface stayed green.

Migration 0013 puts the short-circuit back where it can be evaluated without a table read:

```sql
create policy nodes_select on nodes for select
  using (org_id = app_current_org() and (app_is_admin() or app_can_read_node(id)));
```

`app_is_admin() or` **looks** redundant — the function ORs the same test internally — and it is the
entire fix. Deleting it as a duplicate re-breaks `create_node` silently. Tenancy is not weakened:
`org_id = app_current_org()` is still the first conjunct and still gates the admin branch, which is
precisely the hole D83 closed.

#### The half that matters more: the harness said PASS

`70_hierarchy_test.sql` reports per case with `RAISE NOTICE 'PASS x'` / `'FAIL x'`, and wraps each
case in `EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'FAIL ...'` — deliberately, so one failure cannot
abort a mutation run (§9 of the P1-5a brief). **A NOTICE is not an error. psql exits 0 no matter how
many cases failed.** `verify-db.sh` step 7 tested only the exit code.

Measured the first time anyone looked: **42 PASS, 8 FAIL, and the Summary block said
`PASS: 70_hierarchy_test.sql`.** Those eight were this regression. It shipped under a green run.

Step 7 now captures each file's output and greps it for `NOTICE:  FAIL`, failing the step with the
count. A file emitting zero PASS notices is NOT treated as suspicious — 10–60 use the
raise-on-failure idiom and legitimately emit neither. **Mutation-proved**: with 0013 removed, the
harness reports `FAIL: 70_hierarchy_test.sql (8 case(s) reported FAIL via RAISE NOTICE; 42 reported
PASS)`. The instrument now catches what it hid.

Twelfth logged instance of the measuring instrument being the defect — and the first where the
instrument was reading the wrong SIGNAL rather than reading the right signal wrongly.

---

### 19.18 D86 — hierarchy templates: a shape per site, not one per org (Aug 25, 2026)

§19.16 named the constraint. This removes it. The requirement was never in question: **hierarchy
levels are whatever the site wants**, and an org must be able to run Site › Department › Line › Cell
at one plant and Site › Line at another, scheduling at a different depth in each.

#### Shape

The idiom already in this schema is `shift_templates` / `node_shift_templates`, so this mirrors it: a
named, org-scoped **template** owns the ordered level list.

- `hierarchy_templates (id, org_id, name, unique (org_id, name), unique (org_id, id))`.
- `hierarchy_levels` gains `template_id`; `unique (org_id, position)` becomes
  `unique (template_id, position)`; the one-schedulable partial index moves from `(org_id)` to
  `(template_id)`.
- **`nodes` gets NO template column.** A node's template is its level's template, and
  `nodes_check_level_adjacency` now requires a node's level and its parent's level to share one — so
  a tree cannot straddle two templates, and there is no second copy of that fact to keep in sync. Two
  identical plants SHARE a template rather than duplicating its levels; that is the point of naming
  it.
- `save_hierarchy_levels(p_levels, p_template_id)`. The 1-argument version is **DROPPED, not
  overloaded**, and `p_template_id` has **no default**. Leaving the old one exposed through PostgREST
  would let any un-updated client go on rewriting every template's positions, and "the org's only
  template" is a guess — guessing which shape the admin meant is the failure this removes.
- `board_window` returns only the levels of the templates present in its window, and emits
  `template_id` per level. It was already scoped to one subtree by `p_root_path`; before D86,
  `WHERE hl.org_id = v_org_id` was harmless because an org had one vocabulary, and with several it
  would have interleaved two shapes into one array with two rows claiming position 1.
- Three new RPCs: `create_hierarchy_template`, `rename_hierarchy_template`,
  `delete_hierarchy_template`. **No new error code.** The client's closed set stays at twelve: an
  unknown or foreign template is `invalid_argument` with `field: p_template_id`, and a template whose
  levels still carry nodes is `level_in_use` — the same fact `save_hierarchy_levels` already reports
  with the same `level_ids` detail key.
- A new template is created EMPTY. Seeding it with a starter level would decide the site's shape on
  the admin's behalf, which is the thing this whole migration exists to stop doing.

**Check order is the contract.** Adjacency tests POSITION first and TEMPLATE second, and `canDropOn`
must mirror that: a Line at position 2 of shape A dropped under a Department at position 1 of shape B
passes the arithmetic and is caught by the template test, while the same Line dropped under a Zone at
position 2 of shape B fails the arithmetic first.

**The most consequential line in the diff** is `v_removed_ids` scoped
`where hl.template_id = v_template_id`. Scoped by org instead — which is what the old code said —
saving one shape deletes every other shape's levels. It is one of the twelve mutations.

#### A D3 gap found while writing it

`nodes.level_id` was a plain `references hierarchy_levels(id)` — **the only child FK in this schema
that was not tenant-composite.** A node in org A could structurally reference a level in org B.
`hierarchy_levels` had no `unique (org_id, id)` for a composite FK to point at, which is presumably
why it was left plain; it has one now, so `foreign key (org_id, level_id)` is added. Same class of
hole as D83, one table over.

#### A trap every future migration inherits

Migration 0008's grants are `GRANT ... ON ALL TABLES IN SCHEMA public` — a **one-shot** grant over the
tables that existed then, not a standing rule. `hierarchy_templates` therefore arrived with four
carefully-written RLS policies and **no table privilege behind them**, and every caller got
`permission denied for table hierarchy_templates (42501)` before a policy was ever consulted. Sixteen
cases failed that way. **Every migration that creates a table needs its own guarded GRANT block.**

#### Verification

`supabase/tests/90_hierarchy_template_test.sql` — **19 cases, all green; 12 mutations, 11 caught.**

- **T6 is the requirement itself**: one org holding a 4-level plant and a 2-level plant, two
  schedulable levels at two different depths, two levels at position 0.
- **T7 is the only case guarding the template half of adjacency**, and its fixture is built so the
  position arithmetic PASSES — otherwise it would be a duplicate of an existing level-mismatch case.
- **T17** asserts `save_hierarchy_levels(jsonb)` is gone rather than overloaded.
- **T18 runs as the TABLE OWNER on purpose.** Deleting `and org_id = v_org_id` from the function's own
  template lookup was **NOT CAUGHT** by anything until T18 existed: `save_hierarchy_levels` is
  SECURITY INVOKER, so under the `authenticated` role RLS was quietly doing the scoping. Any future
  SECURITY DEFINER wrapper, service-role script or bulk import gets no RLS at all. Same reasoning as
  `80_cross_org_test`'s C19.
- **The one NOT CAUGHT, recorded rather than papered over:** scoping the `update hierarchy_levels set
  position = ...` pass by `org_id` instead of `template_id` changes nothing observable, because the
  wrong-template guard rejects a foreign id before that pass can run.

`10_constraints_test.sql` Case 3 was **wrong, not merely differently phrased**, after this change: "a
second schedulable level in the same org is rejected" is now the opposite of the requirement. It is
split into Case 3 (same TEMPLATE → rejected) and Case 3b (different template → accepted). **Either
half alone still passes if the constraint is simply dropped**, which is why a relocated constraint
needs both.

#### Two process notes from building it

**A 129-line function was nearly retyped by hand to change two lines of it.** The first draft of the
`board_window` replacement was written from memory of a partial read and silently lost six
subqueries and the `STABLE` marker. The delivered version is extracted from migration 0009
programmatically, has exactly two hunks applied by string replacement, and the diff was inspected;
the migration says so in a comment, so nobody re-types it next time either.

**A mutation whose anchor matches nothing must not be reported as NOT CAUGHT.** The runner's first
pass silently scored one mutation as a hole because its anchor string had the wrong indentation.
That is the D84 Z2 lesson again, from the other direction: the runner now asserts its anchor is
unique and present, and reports `ANCHOR NOT UNIQUE` distinctly.

#### What the client side cost, and the one thing that broke

Migration 0014 changed three things the client got wrong, all fixed in the same session:
`saveHierarchyLevels` called the dropped 1-argument RPC; `HierarchyLevel`/`LevelRow` had no
`templateId`; and **`canDropOn` compared level POSITION only**, so with two shapes in one org it
would have approved dropping a Line from shape A under a Department from shape B whenever the
arithmetic lined up. It now mirrors the server's order — position, then template — and five
committed cases guard it, of which **D2 is built so the arithmetic PASSES**. Replacing the template
comparison with `false` breaks D2 and only D2.

`LevelEditor` **fails closed** when the loaded levels span more than one template, rather than
editing `levels[0]`'s shape: the shape picker is P1-5e's job, and silently guessing which vocabulary
an admin is reordering is the same guess the RPC was built to reject.

The acceptance run came back typecheck / lint / build clean with **347 of 348 tests passing**, and the
single failure was the right one: `shapes.test.ts`'s `board_window` fixture had a level with no
`template_id`, so `parseLevel` correctly rejected the whole payload. **The parser was right and the
fixture was stale** — the fourth fixture-vs-code disagreement this project has had, and the second in
this session. Fixed, and a case now asserts that a level with no `template_id` fails the parse, so
the requirement has teeth instead of being enforced only by a fixture nobody would think to check.

---

### 19.19 D87 — `create_node` still looks a level up by `(org_id, position)` (Aug 25, 2026)

**Open. Found by Pratik asking "how would one add one more hierarchy?", not by any test.**

§19.18 moved level identity from `(org_id, position)` to `(template_id, position)`. It did not move
the two places `create_node` (migration 0010, untouched by 0014) resolves a level:

```sql
-- root:
select id into v_level_id from hierarchy_levels
 where org_id = v_org_id and position = 0;
-- child:
select id into v_level_id from hierarchy_levels
 where org_id = v_org_id and position = v_parent_position + 1;
```

Both predicates were UNIQUE until 0014 and are not any more. These are two different problems and
only one of them is a scoping bug.

**The child branch has a determined right answer.** A child's template is fixed by its parent, so the
lookup should read `where template_id = <the parent's level's template> and position =
v_parent_position + 1`. As written it can select another shape's level at that position, and the
adjacency trigger then rejects the insert with `level_mismatch` — so it fails CLOSED. Confusing, not
corrupting.

**The root branch cannot be fixed by scoping, because the RPC cannot express the question.**
`create_node(p_parent_id, p_name, p_sort_order)` takes no template, and for a root node there is
nothing to derive one from. **So there is currently no way through the API to create a second site
with a different shape** — only a direct `INSERT INTO nodes`, which RLS permits for an admin. The
schema supports per-site shapes and the write path does not. `create_node` needs `p_template_id`,
required when `p_parent_id is null` and the org holds more than one template; when it holds exactly
one, defaulting to that one is not a guess but the only possible answer — the same reasoning
`LevelEditor` already uses.

**Severity, stated precisely.** With two shapes in one org, `SELECT ... INTO` picked the seeded
template in all three trials, and forcing a sequential scan versus an index scan did not change it.
`SELECT ... INTO` over a multi-row result takes an arbitrary row, so this is unspecified behaviour
that will pass testing — it is **not** something measured going wrong. The provable defect is the
missing parameter, not a race, and the writeup should not overstate it.

**How it survived.** This is [[verification-standard]] rule 7, missed by the design session. When a
constraint moves, the question is not "is this statement guarded" but "what else in this schema is
conditioned on the same fact". `save_hierarchy_levels`, `board_window` and the adjacency trigger were
all checked and updated; a two-minute grep for every level lookup keyed on org and position would
have found `create_node` immediately. **`90_hierarchy_template_test.sql` never calls `create_node`
once** — nineteen cases about hierarchy templates, none of which create a node the ordinary way.
Rule 5 applies too: that absence was never written down as a gap.

Filed as P1-5f, first in the queue, since it blocks the requirement §19.18 exists to satisfy.

#### Two corrections to the paragraphs above, both measured while writing P1-5f (Aug 25)

**1. The live `create_node` is in migration 0011, not 0010.** The sentence "migration 0010,
untouched by 0014" is true about 0014 and misleading about everything else: **0011
re-created `create_node`** to route its name handling through `app_trim_ws` (the D80
whitespace-parity fix). 0010's copy is superseded, and extracting the body from it — which
is exactly what a careful agent following verification-standard rule 12 would do — would
silently revert D80. The P1-5f brief names 0011 explicitly and carries the md5 of the
73-line extraction so the agent can check its own work. This is [[decision-record-drift]]
in a new form: not a decision recorded only in a comment, but a decision recorded in the
*wrong file*, where a later reader looking up "which migration defines X" gets the first
answer rather than the last.

**2. "Not something measured going wrong" was too generous, and the reason matters.**
`SELECT ... INTO` over a multi-row result takes an arbitrary row, and the row it takes
tracks **physical heap order**. Re-saving the *other* shape's level list — an ordinary
supported admin action, e.g. renaming a level — rewrites its rows and **flips which template
an unqualified root create lands in**: measured 5/5 Standard before, 5/5 Compact after. So
"the seeded template wins every time" (n=13 now, not 3) is a property of a freshly-loaded
database, not of the code.

The precise statement, which is what any future writeup should use:

- It is **not a race** and not a concurrency bug. Deterministic for a given heap state.
- It is **not stable either**. An unrelated, legitimate admin action changes the answer.
- **The root branch writes a wrong-but-legal row with no error.** A root node at position 0
  of *any* template satisfies `nodes_check_level_adjacency` — parent NULL, position 0 — so
  the trigger structurally cannot catch it. The admin gets a node in the wrong shape and no
  indication. That is worse than §19.19's original "confusing, not corrupting".
- **The child branch fails closed**, so the second shape cannot grow children either. The
  net effect is that the API can build trees only in whichever shape happens to be
  physically first.
- **No existing row is at risk, and with one shape per org — every org today — behaviour is
  unchanged and correct.** The provable defect is still the one §19.19 named: a correct
  request cannot be expressed.

A third measurement, recorded because it is a *non*-defect and someone will otherwise
"fix" it: creating a root into a template with **no levels** (the ordinary state right after
`create_hierarchy_template`) already fails inside the closed error set — the BEFORE trigger
sees a NULL `level_id` before the NOT NULL constraint fires, so it raises `level_mismatch`,
not a raw `23502`. 0015 adds an explicit guard for the *message*, which today reads "its
level is not position 0" about a level that does not exist. That is a legibility fix, not a
leak.

---

### 19.20 P1-5f written — and what executing its two mutation tables cost (Aug 25, 2026)

`docs/agent-briefs/p1-5f-hierarchy-shape-picker-brief.md`. Migration 0015 plus the shape
picker, as one brief, because they are the same feature from the database and from the
screen. Both halves were **executed by the design session before the brief shipped**
(brief-writing rule 5), and both tables were wrong on the first pass.

**SQL: eleven cases (T20–T28, T30, T31), eight mutations shipped of ten designed.**

- **T22 had no teeth.** Written as `authenticated`, mutation M5 — deleting the explicit
  template lookup's `and org_id = v_org_id` — was **NOT CAUGHT by any case in the file**,
  because `create_node` is SECURITY INVOKER and the `hierarchy_templates` SELECT policy was
  quietly supplying the org scope. Re-running T22 under `RESET ROLE` gives it teeth. Third
  instance of this exact masking here ([[verification-standard]] rule 10); the same reason
  T18 and C19 exist.
- **T21 and T26 assert BOTH shapes**, not just the second one. A one-sided assertion is
  order-dependent: an org-scoped lookup returns one arbitrary row for both calls, so whether
  it happens to be right depends on heap layout. Asserting both means whichever row it
  picks, one side fails — which is what makes M1 and M2 reliably catchable.
- **There is deliberately no T29.** The case written there first asserted the §19.19 heap
  flip directly. Its *behaviour* half was right; its *precondition* half was a heap-order
  assertion, and heap order depends on what free space earlier savepoint rollbacks left
  behind. It passed standalone and failed inside a full-file run **against the unmutated
  build** — i.e. it appeared to be broken by all ten mutations including one independently
  proved inert. That is the signature of a broken instrument, not a caught defect. Sixteenth
  logged instance, and the first where the design session caught its own before shipping it.
- Two mutations were **executed, found inert, and left out** rather than listed as holes:
  `<> 1` → `< 1` (identical to M3) and collapsing the zero-template `reason` string (no case
  reaches the root branch with zero templates, and there is no supported way to).
- Ten of the eleven cases fail against a 0001–0014 build — but **eight fail with
  `function create_node(..., uuid) does not exist`**, a signature failure any signature
  change would produce. **Exactly one case demonstrates the defect**: T20, which on the
  unfixed build reports `caught=f` — the call *succeeds silently*. The brief says so, so
  nobody reads ten red lines as ten proofs.

**TypeScript: `shapePicker.ts`, 41 assertions, ten mutations shipped of twelve designed.**
Three defects, all in the *suite*, none visible until the table was run:

1. A mutation **CRASHED** where a named failure belonged (`S.find(...)!` returned undefined).
2. Two sort-deleting mutations were **INERT because the fixture was already in position
   order** — a fixture that agrees with the field being derived cannot test the derivation
   ([[verification-standard]] rule 3). The fixture is now deliberately shuffled.
3. A mutation anchor **matched zero lines** (wrong indentation) and would have been recorded
   as a coverage hole; the runner reported `ANCHOR NOT UNIQUE (count=0)` distinctly, which is
   the only reason it was caught. The D84 Z2 / D86 lesson, working.

**The single most likely bug in the client half, named in the brief with its own case:**
deriving the shape list from the distinct `templateId`s present in `levels` rather than from
`hierarchy_templates`. It is the cheap path, it works for every seeded org, and it makes a
**newly created shape vanish the instant it is created** — because `create_hierarchy_template`
returns an EMPTY template on purpose. `fetchHierarchyTree` does not read
`hierarchy_templates` today, so this is not a hypothetical.

---

### 19.21 D88 — per-site timezone: site-local, wall-clock, Phase 2 (Aug 25, 2026)

Flagged as blocking-adjacent since D86, decided with Pratik today. The mismatch was narrow
and specific, and worth stating because it is not what "we hardcoded UTC" sounds like:

- **Runs and assignments are `tstzrange`** — absolute instants. Already zone-independent and
  correct. Nothing to fix.
- **Shifts are `start_min`/`end_min`, minutes from midnight, with no zone attached** (§16).
  Wall-clock by construction.
- **D13 renders the board in UTC**, `BOARD_ZONE` in `src/features/board/lib/time.ts` the
  single seam.

So a shift defined 06:00–14:00 draws at 06:00 **UTC** wherever the plant is; for a Texas
plant that band sits over midnight–08:00 local. It has never bitten because D10 anchors the
seed to UTC.

**Decisions:**

- **D88a — the board's axis is SITE-LOCAL.** `board_window` already takes one `p_root_path`,
  so a board usually *is* one site. A 06:00 shift must read 06:00 to the people working it.
- **D88b — a shift keeps its posted WALL-CLOCK start across a DST change.** On the changeover
  day that shift is 7 or 9 hours long and the crew works it short or long. Pratik's call, and
  it matches how plants actually post schedules.
- **D88c — Phase 2, not v1.** Recorded now so nothing new is built assuming UTC; scheduled
  after P1-5f/5g/5h. Nothing shipped is wrong for a single-zone customer.

**Where the attribute lives was never a question** and was not asked: "site" is not a fixed
level any more, so the timezone hangs off a **node** and resolves nearest-ancestor — the same
mechanic `node_shift_templates` / `resolve_shift_template` already uses for shifts, and the
same shape D86 used for hierarchy shapes. A nullable `timezone` on `nodes` with an org-level
fallback, reusing the resolution that exists.

**The load-bearing consequence, so it is not discovered late.** D13's note that "in v1 every
day is exactly 1440 minutes, so board geometry has no DST discontinuity" **stops being true
under D88a.** Two days a year a local day is 1380 or 1500 minutes, and the shift-band mapping
stops being `dayStart + start_min`. That is the actual cost of D88 and it lands in
`src/features/board/lib/time.ts` and `geometry.ts`, not in the schema.

---

### 19.22 P1-5f built — and the review found two blind tests and one unguarded clause (Aug 25, 2026)

Agent cost **107k**, the cheapest P1-5 build yet (P1-5d was 264k, P1-5c 370k) — delivery-by-operation
(D82) plus a brief whose tables were measurements rather than predictions. The build is good: 15
migrations apply, **101 SQL cases green**, 42 TS assertions green, every prescribed mutation caught.
The design-session review found three things anyway, and two of them were tests that could not fail.

#### 1. `R2`/`R3` asserted against the array under test — measured blind

`shapePicker.test.ts` wrote its expectations as `got === withoutB[0]?.id` and
`got === SUMMARIES[0]?.id`, deriving the expected value from the very array `buildShapeSummaries`
produces. **Measured: both PASSED under mutation N1**, which deletes a whole summary from that array
— `SUMMARIES[0]` simply became a different template and the assertion moved with it. The agent
reported this as a *table correction* ("the brief predicted R2/R3, they don't break"), which is the
wrong diagnosis: the brief's prediction was right and its own reference cases did break. Fixed to a
fixed literal (`TPL_NEW`), after which N1 breaks R2 and R3 exactly as predicted, and N6 — the
mutation those cases actually exist for — still breaks R2/R4.

**This is [[verification-standard]] rule 3 in its purest form**, and worth stating as a general tell:
*when a mutation the design session measured as caught comes back "not caught", suspect the test
before the table.*

#### 2. Three unprescribed mutations caught by nothing — one of them a real hole

The review ran five mutations the brief never named. Three survived both suites:

- deleting the org scope from the root branch's **template count**,
- deleting it from the **sole-template pick**,
- widening the root level lookup from `position = 0` to `position >= 0`.

The first two are the RLS-masking of §19.18's T18 and this brief's T22, one clause further in: under
`authenticated`, the `hierarchy_templates` SELECT policy supplies the org scope, so a SECURITY
INVOKER function's own clause is untestable. **T32 was added, running under `RESET ROLE`** — org 1
and org 2 hold one template each, so an unscoped count sees 2 and wrongly raises `ambiguous`. It
catches the first.

**The second could not be caught by any functional test, and the fix was to delete the clause, not
add a case.** The root branch ran two queries — a scoped `count(*)`, then a separate scoped
`select id into` — so there were two org scopes to keep in sync, and removing the one on the *pick*
makes `select ... into` arbitrary across every org's templates. That is the same unordered-single-row
hazard D87 is about, reintroduced one line over. Catching it deterministically would require
controlling which row an unordered `SELECT ... INTO` returns, which is precisely the thing that
cannot be controlled. Folded into one statement:

```sql
select count(*), (array_agg(id order by id))[1]
  into v_template_count, v_resolved_template_id
  from hierarchy_templates where org_id = v_org_id;
```

One scope instead of two, and a deterministic pick where a bare `select id into` was not. **The
general form: when a mutation cannot be caught by a test, the answer is often to remove the thing
that needed guarding.** [[verification-standard]] rule 7 — what else is conditioned on the same fact
— pointed at a *second copy of the fact*, not a second guard.

The third (`position >= 0`) is guarded by T21's assertion on the exact expected `level_id`, but only
non-deterministically: whether the mutation is caught depends on which row the widened query returns.
Recorded as a known soft spot rather than papered over.

#### 3. `min(uuid)` does not exist, and reasoning said it did

The first draft of the fold above used `min(id)`. PostgreSQL 16 has **no min/max aggregate for
`uuid`** — `42883` at runtime, not at `create function` time, because plpgsql bodies are not
resolved when defined. The harness caught it immediately (three cases red across two files). `uuid`
*does* have a btree ordering, so `order by` inside `array_agg` works. Filed in
[[postgres-supabase-gotchas]].

Worth noting what this cost and what it did not: nothing shipped, because the change was executed
before it was written down. This is the same rule that caught the brief's own two tables.

#### 4. What the review confirmed rather than found

An unprescribed probe of the new parameter (rule 4, malformed-argument sweep) came back clean on all
seven: an explicit `NULL` `p_template_id` behaves exactly like omitting it on both branches; D2's
`coalesce(p_sort_order, 0)` survived the function rewrite; a *level* id passed as a template id
returns `invalid_argument`/`not found` rather than leaking; a supervisor gets `not_permitted` before
any template lookup runs, so no existence is disclosed; org 2's admin can build a root in org 2's own
template; and org 2's admin naming org 1's template gets `not found`, not a distinguishable error.

#### 4b. The acceptance run found what neither the agent nor the review did: the suite was not in the framework

`npm run test` failed. Not on an assertion — on collection:

```
FAIL  src/test/shapePicker.test.ts [ src/test/shapePicker.test.ts ]
Error: No test suite found in file .../src/test/shapePicker.test.ts
Test Files  1 failed | 15 passed (16)
     Tests  349 passed (349)
```

The file was delivered as a **standalone `node --experimental-strip-types` script** with its own
`check()` runner and `console.log` reporting. It runs, and the acceptance log even contains all 42 of
its assertions printed as PASS — while vitest, which collects every `src/test/*.test.ts`, finds no
`describe`/`it` and fails the run. **The suite was simultaneously passing and failing, depending on
which runner you asked.**

The tell was in the numbers and nobody read it: **349 tests before P1-5f, 349 after.** Forty-two new
assertions contributed exactly zero to the count that CI reports.

This is **[[brief-writing-rules]] rule 11 (D78) in a second form.** D78's lesson was that a suite run
once in a scratch container and never committed leaves a module unguarded while CI reports green.
P1-5f's brief applied that correctly — §3's file table names `src/test/shapePicker.test.ts`, §12 item
7 requires it to exist in the repo — and the file does exist, in the right place, containing the
right assertions. **Naming the path is necessary and not sufficient: the file must also be in the
framework the repo's own `npm run test` actually runs.** The rule now says both.

Converted to a vitest suite by keeping every `check(...)` call verbatim and changing only what
`check` does — it registers an `it()` whose body returns `true` or a detail string, asserted with
`expect(outcome).toBe(true)`, so a failure still names what was seen and a throw still fails BY NAME
rather than aborting the file. Verified in-container against a 30-line vitest shim: 42 registered, 42
passing, and mutation N1 still breaks the same eleven cases including the repaired R2/R3.

The standalone harness is not a committed artifact and does not need to be: `shapePicker.ts` is still
pure and `import type`-only, so any future agent can drive it from a throwaway strip-types runner for
mutation work. That is the same split the repo already uses for `scaleAudit.ts` / `scaleAudit.test.ts`
— logic in a plain `.ts`, vitest wrapper in the `.test.ts`.

**Worth being precise about what this cost:** nothing shipped, and the acceptance run is exactly the
gate that is supposed to catch a container-unverifiable defect. It did. But the design-session review
had already run this file's 42 assertions and its whole mutation table and called it verified —
**against the wrong runner.** Nineteenth logged instance of the instrument being the defect, and the
first where the instrument was *the design session's own choice of how to execute a committed file*.

#### 5. A brief error worth recording, because it will recur

§9.1 predicted M1's collateral as T27/T28 and M2's as T27. Measured: M1 breaks T21/T25/T26, M2 breaks
T26 alone. **The brief was wrong, and not because the mutation table was reasoned — it was executed.**
It was executed against the design session's *own reference cases*, and the agent wrote a valid T27
that satisfies the brief's prose ("child + `p_template_id` equal to the parent's → accepted") using
the seeded single-shape tree rather than building a second shape. Collateral is a property of the
cases as written, not of the requirement. See [[brief-writing-rules]] rule 14.

---

---

### 19.23 D89 — the hole D84 left: form controls do not inherit fonts (Aug 25, 2026)

Reported by Pratik for the **third** time, as "the popup scaling is so bad, why do I have to keep
talking about this?" He is right that it kept coming back, and the reason is worth stating plainly:
every previous fix treated an instance.

**Measured in headless Chromium** against the real repo stylesheets and the real popover markup —
not reasoned about, because §19.11 already burned this project once by verifying a stylesheet
instead of the app:

| viewport | root font-size | `.h3` (rem-sized) | unstyled `<input>` / `<button>` |
|---|---|---|---|
| 1440 | 16px | 13px system-ui | **13.3333px Arial** |
| 2560 | 19.11px | 15.53px system-ui | **13.3333px Arial** |
| 3840 | 21.6px | 17.55px system-ui | **13.3333px Arial** |

Two defects, one local and one systemic.

#### The systemic one: D84 only covered what the CSS sizes

`input`, `button`, `select` and `textarea` do not inherit fonts — the UA gives them their own
absolute one. So they are immune **both** to D84's scaled root font-size and to anything inherited
from `body`. Every stylesheet involved was fully D84-compliant; `scaleAudit` reported green; the
defect was an **absent declaration**, which no file-content audit of the existing files could ever
see.

The same measurement found a second, wider miss: **`body { font: 13px/1.45 ... }` was absolute**, so
D84's scaled root only ever reached text explicitly sized in `rem`. Anything that merely inherited
was frozen at 13px on a 4K display. Now `0.8125rem` — 13/16 exactly, so byte-identical at
`--chrome-scale: 1` and scaling above it.

The fix is one rule in `global.css`:

```css
input, button, select, textarea, optgroup { font: inherit; letter-spacing: inherit; }
```

After which forgetting `font: inherit` in a component stylesheet costs a border, **never the
typeface or the scale**. Verified: at 2560 the rename popover's title, input and both buttons now
compute to 15.53 / 15.53 / 14.33px system-ui and move together.

#### The local one, and what it says about why this recurs

`NodeTreeEditor.module.css` writes `font: inherit` on all four of its popover modes.
`ShapePicker.module.css` writes it on the two controls the card renders **inline** (`.select`,
`.createForm input`) and forgot the two it hands to `AdminPopover` **as children** — which carried no
class at all, so its own stylesheet could not reach them even in principle. That is the screenshot:
a raw UA text box and two default grey buttons inside an otherwise designed surface.

**A component remembers for the controls it styles and forgets for the ones it passes to a shared
container.** Every recurrence of this complaint has had that shape. It is not a person failing to
concentrate; it is a rule that exists only as a habit. Fixed by giving the input a class and copying
`NodeTreeEditor`'s proven `.popActions button` values rather than inventing new ones.

#### Enforcement, because D84 taught us not to ship a rule without one

`scaleAudit.ts` now guards four things instead of two. The two new ones:

- **`missingControlFontReset`** — the reset exists and names all four controls. It has a case proving
  it does **not** pass on the prose documenting the rule (the third CSS matcher on this project that
  had to be taught code from comments) and one proving a partial reset reports exactly the omitted
  control.
- **`missingRemSurfaces`** — walks `src/features/admin` and fails on any `*.module.css` that
  `REM_SURFACES` does not name. **`ShapePicker.module.css` shipped in P1-5f without being added to
  that list**, so an entire new admin surface sat outside the D84 audit while the audit reported
  green. A hand-maintained list is untested unless something asserts it. It has a case proving the
  completeness guard can fail.

Eight assertions, all executed in-container against the real files, including the two
prove-it-can-fail cases.

#### The fix broke a test, and that is the second instance of the same mistake in two turns

`R10: REM_SURFACES is exactly the four admin stylesheets` — a case that has existed since D84,
pinning the list literally so that dropping a file from it cannot pass silently. Adding
`ShapePicker.module.css` to `REM_SURFACES` made it five. **The guard did exactly what it exists for**,
and the acceptance run reported `1 failed | 397 passed (398)`.

The mistake was not the stale literal, it was how the change was verified: an eight-assertion harness
was written for the two NEW audit functions and run in-container, and **the existing suite that
guards the file being edited was never run.** That is [[verification-standard]] rule 2b — *run the
committed file in the runner that will guard it* — which was written one turn earlier, after
`shapePicker.test.ts` shipped as a standalone script. The same error twice in two turns, in two
sizes.

The correction is mechanical and now habitual: the whole of `scaleAudit.test.ts` was run against the
real repo files under a vitest shim (33 cases, matching vitest's own collection count exactly), and
then mutation-tested:

| mutation | breaks |
|---|---|
| drop `ShapePicker.module.css` from `REM_SURFACES` | **R10** *and* `missingRemSurfaces` |
| drop `textarea` from the control reset | `missingControlFontReset` coverage case |
| revert `body` to an absolute `13px` | the body-sizes-in-rem case |

Belt and braces on the first one is deliberate, not redundant: R10 catches the list drifting for any
reason, and `missingRemSurfaces` catches a surface existing on disk that the list never learned
about. The second is the one that would have caught P1-5f; the first is the one that caught me.

#### One thing deliberately not fixed here

The console shows seven `401 (Unauthorized)` responses on first load — the hierarchy reads and
`board_window` firing before the dev sign-in resolves. Every check Pratik ran then worked, so this is
noise rather than breakage, but it is the §19.8 class of problem (a query firing against an identity
that is not established yet) and it wastes a round trip per query on every load. Filed rather than
fixed, because it is unrelated to D89 and wants its own measurement.

---

### 19.24 D90 — the node tree lost its meaning when shapes went per-site (Aug 25, 2026)

Raised by Pratik looking at the built admin screen: *"there should be a better way to visualize this,
one which leaves no ambiguity."* He is right, and this is a defect we introduced rather than a
matter of taste.

**Before D86, indentation WAS the level.** One vocabulary per org meant depth 2 always said
"Department", so an indent-only tree encoded everything. Per-site shapes made that false: `Plant 2`
sits at the same indent as `Plant 1`, but its children are **Lines** where `Plant 1`'s are
**Departments** — and on the Compact shape a Line is *schedulable*, so the two rows at equal indent
are not merely different levels, one of them takes bookings and the other cannot. **The tree's only
encoding of level is indentation, and indentation stopped being reliable the moment D86 shipped.**
Nothing in P1-5e/5f caught it because every test asserts data, and this is a defect in what the
screen *communicates*.

Four options mocked up in `docs/mockups/hierarchy-tree-options.html`, all rendering the same
two-shape dataset:

- **A — level label on every row.** Smallest possible fix; the level name is already in scope in
  `buildTreeRows`, so no new data. Says nothing about which *shape* a root belongs to.
- **B — group by shape, plus level labels (recommended).** Fixes both the per-row level and the
  per-subtree vocabulary, and makes the tree agree with the picker instead of silently disagreeing.
  Heading only appears when the org holds more than one shape.
- **C — Miller columns.** The level *is* the column header, so it cannot be misread, and it stays
  scannable at hundreds of cells. Costs the whole-tree overview and makes P1-5g's drag harder, not
  easier. A rebuild of `NodeTreeEditor`.
- **D — flat table, one row per schedulable cell.** Unambiguous, sorts and filters, and it is the
  natural preview format for P1-5h's CSV import. **Two shapes do not share a column set** — the
  mockup shows the seam honestly — so it wants a separator or a table per shape, and it is a *second*
  view, not a replacement for editing.

#### Two decisions already taken

- **D90a — the section is renamed "Site Structure"** (Pratik's wording, from "Site type" and
  "Structure"). It reads correctly in the flow that actually matters: the shape dropdown when adding
  a root becomes *"which site structure does Plant 2 use?"*, a question a plant manager can answer.
  "Shape" was abstract, and "Hierarchy type" collides with the admin section it sits inside.
- **D90b — the picker merges INTO the Levels card.** They were laid out as peers while being
  parent and child: the Levels card only ever edits whichever shape is selected above it, and nothing
  on screen said so. One card, structure selector on top, `Levels in this structure` beneath.

#### Decided: option B, and why C was dropped

**Option B built.** Pratik's reason for rejecting C is sharper than the one in the mockup and is
worth keeping: the mockup argued C loses the whole-tree overview and complicates drag. The real flaw
is **the first column**. The panes only have a well-defined header *after* a root is selected — the
Site column itself mixes roots of every structure, and it only looks coherent because both seeded
shapes happen to name level 0 "Site". Rename Compact's root level to "Facility" and that header has
nothing honest to say. A visualisation whose correctness depends on two independent vocabularies
coincidentally agreeing is the same bug as the one being fixed, one level up.

#### What was built

- **`groupRowsByShape(rows, levels, templates)`** in `treeView.ts`, pure and strip-types-runnable,
  returning `ShapeGroup[]` — each with `templateId`, `templateName`, `levelPath` and rows carrying
  `levelName`. Grouping never splits a subtree, because a node's structure is its level's template
  and the adjacency trigger requires a node and its parent to share one (D86).
- **Two invariants worth naming.** Row order within a group is the depth-first flatten, untouched.
  And **a row can never disappear**: an unresolvable level lands in a trailing `templateId: null`
  group rather than being skipped, because a node you cannot see is a node you cannot fix. Groups
  sort by template name with a code-unit comparison, not `localeCompare` — that has already produced
  two answers on two machines here.
- **The heading renders only when the org holds more than one structure.** For a single-plant
  customer it would be a label on the only thing there is.
- `NodeTreeEditor` renders the groups and a level chip per row; `NodeTreeEditor.module.css` gains
  `.group` / `.shapeHead` / `.shapePath` / `.levelChip`, all in `rem`.
- **A D89-class bug fixed in passing:** the row indent was an inline `paddingLeft: row.depth * 18`.
  An inline style is invisible to `scaleAudit`, which reads CSS files — so that indent silently did
  not scale and nothing could have caught it. Now `${row.depth * 1.125}rem`, the same 18px at the
  default root.

**Verification:** `groupRowsByShape` has 12 cases and **8 mutations, every one caught** — group by
level name, sort by id, drop the `levelPath` sort, re-sort rows within a group, drop unresolvable
rows, build groups from templates so empty ones appear, take the level id instead of its name, and
put the unresolved group first. The fixture is a two-shape org whose level names **collide**
(`Site` at position 0 in both, `Line` in both at different positions), so a grouping keyed on name or
position passes nothing. The whole 37-case `treeView` suite and the whole 33-case `scaleAudit` suite
were re-run against the real repo files, not just the new cases — [[verification-standard]] rule 2b,
which this session has now broken twice.

One case was renamed after the mutation run: `G7` was called "no row is ever dropped" but runs on a
fully-resolvable fixture, so it cannot catch dropping — measured, the drop mutation breaks G9 and not
G7. It is now "every row lands in exactly one group, none duplicated", which is what it actually
tests. **A case whose name promises more than its fixture can deliver is how a coverage gap hides in
plain sight.**

#### The guides were promised and not built — and building them found a real bug

The mockup drew vertical connector lines and the covering note called them "cheap and worth adding
alongside whichever option". Option B then shipped without them. Pratik: *"I don't see the vertical
line as in the proposals."*

The mockup got them free from nested `<div>`s, whose borders end where the container ends.
`flattenTree` deliberately produces a **flat** list — that is what makes the tree keyboard-navigable,
since up/down is index ±1 — and a flat list has no containers to hang borders on. Nesting `<ul>`s
would buy the lines and cost the navigability, which is the wrong trade. So `TreeRow` gained the data
instead: `guides: boolean[]`, one entry per ancestor depth, true when that ancestor still has
siblings below, plus `isLastSibling` so a last child's rail stops at its own elbow. Rendered as
fixed-width rails that also **provide the indent**, replacing the inline `paddingLeft` D89 flagged.

**Then the render was screenshotted in headless Chromium, and it was wrong.** A vertical rule ran the
full height of the Standard Plant block. `flattenTree` seats the depth-0 rail against every root *in
the org*; `groupRowsByShape` then splits those roots across blocks, so `Plant 1` — not last overall,
because `Plant 2` exists — kept drawing a rail down to a sibling that renders **in a different group,
above it**. A line pointing at nothing.

**All 45 `treeView` cases passed while that was on screen.** Both functions are correct in isolation;
the defect lives in their COMPOSITION, and every case asserted on one function at a time. Closed by
`reseatRootGuides`, which re-seats index 0 against the group's own roots — and only index 0, because
every deeper rail describes siblings inside one subtree and grouping never splits a subtree. Six new
cases (K1–K6) assert on the composed output, K1 pinning the precondition so the block cannot quietly
stop proving anything.

**This is the lesson of §19.22 and D89 arriving a third time, in its strongest form yet.** A suite
that passes tells you each part is right. It does not tell you the screen is right, and for anything
visual **the only instrument that reads the actual output is a rendered picture.** Chromium is
available in-container — `--headless --screenshot`, then look at it. That is now the last step for
any visual change here, and it is what should have happened before the first version was handed over.

#### Vocabulary note, so the next reader is not surprised

The UI now says **"Site Structure"**; the code and the database still say *shape* and
*hierarchy_templates*. That split is deliberate — renaming the DB is not worth a migration, and
churning every comment adds diff noise — but it is exactly the kind of thing that reads as a mistake
later. Likewise **`ShapePicker.tsx` keeps its filename**: renaming it needs a delete this session
cannot perform, and a stray dead module is worse than a stale filename.

#### Not changed, deliberately

The mockup showed `schedulable` as a chip on the level row rather than a radio. **The radio stayed.**
A chip is a marker; the radio is the *control* that changes which level is schedulable, and the
mockup version had no way to perform that action. Flagged at the time and not confirmed, so changing
an interaction on the strength of a picture would have been a guess.

#### Worth noting about how this was found

Prose was not enough — the first attempt described all four layouts in text and the answer came back
*"give me visual options, I can't imagine what you're proposing."* Fair. This project already has the
convention (`docs/mockups/`, four files now); **a layout question wants a rendering, not a
paragraph.**

---

### 19.25 D91 — do not query as nobody: the 401s on every page load (Aug 25, 2026)

Seven red `401 (Unauthorized)` lines in the console on every load, spotted by Pratik in a screenshot
taken for a different reason. Nothing was broken — the data arrived and every acceptance check
passed — which is exactly why it had survived.

**Cause, read from the code rather than inferred.** `useSession` starts `loading: true` with no
identity and resolves asynchronously; `useQuery` fires the moment its component mounts. Neither
`AdminPage`'s hierarchy read nor `useBoardWindow` carried an `enabled` guard, so on every load both
went out before there was a session. **Every read in this app is RLS-scoped to the caller, so a query
sent with no identity is not merely early — it is a request the server MUST refuse.** Auth then
landed, the queries re-ran, and the screen was correct.

The cost was small and real: a wasted round trip per query on every visit, invisible against local
Supabase and not against a hosted one, plus a console full of red that would hide the next genuine
failure. Twice this session an instrument that looked fine turned out not to be, so that second cost
is not hypothetical.

**Fixed with one predicate, `canQueryAsUser(userId, loading)`, in `features/auth/session.ts`** — the
module that already exists because §19.8's cache-reset and loading flags drifted apart by being
open-coded at more than one call site. This condition now has two callers (`BoardPage`, `AdminPage`),
which is precisely the shape that produced that bug. It takes a user id rather than a `Session` for
the same reason `decideSessionUpdate` does: the module stays import-free of @supabase/supabase-js.

**`enabled` is a REQUIRED parameter on both query hooks, not optional with a `true` default.** A
default would let the next caller reintroduce the 401 silently, which is the whole failure being
removed.

#### The trap inside the fix, which is §19.8 over again

`enabled: false` does **not** make `isLoading` true. Verified against the installed source rather
than from memory — `@tanstack/query-core` 5.102.0, `queryObserver.js:237`:

```js
const isLoading = isPending && isFetching;
```

With `enabled: false` the query is `pending` but `fetchStatus` is `idle`, so `isFetching` is false
and **`isLoading` is false while the session resolves**. Gating the query without widening the
render condition would have swapped seven console errors for a blank admin card — **guarding the
cache but not the spinner, which is §19.8's exact mistake.** `AdminPage` now renders its spinner on
`!canQuery || isLoading`. `BoardPage` needs no change: it already early-returns on `sessionLoading`
and on a missing session, so its render never reaches the board query in that state — checked, not
assumed.

Six cases (Q1–Q6) and five mutations, all caught. Two are worth naming: **Q5** asserts that exactly
one of the four input combinations returns true, so a guard that ignored either argument — or
returned a constant — fails; and **Q6** pins that an empty-string id is an identity, not a
signed-out state, because guarding on truthiness rather than `!== null` would silently treat `""` as
nobody. The session layer's contract is `string | null`, and only `null` means nobody.

#### Why it is filed as a decision and not a bug fix

"Do not issue an RLS-scoped read before the identity is settled" is a rule the next query hook needs
to know, and there was nowhere it was written down. It is now one exported predicate with a doc
comment, which is the same move D89 made for control fonts: **a rule that exists only as a habit
will be forgotten by the next component.**

---

### 19.26 P1-5g written — the refusal is the feature, and the render found three defects (Aug 25, 2026)

P1-5d shipped half the re-parenting decision. Pratik chose *"both — drag, with the menu as
fallback"*; the menu exists (`⋮` → **Move to…**, listing exactly `legalParentsFor`) and
`NodeTreeEditor.tsx` has zero drag handlers. Brief written:
`docs/agent-briefs/p1-5g-tree-drag-drop-brief.md`. Four files, two of them executable.

#### The one thing in it that is not wiring

`canDropOn` is already the single implementation of "is this a legal parent", already
mutation-tested, and already shared by the menu, the preview and the server. So the drag itself is
plumbing. **The part that is not is the refusal.**

A menu can only ever show legal targets, so it never explains itself. A drag goes wherever the
pointer goes and lands on illegal targets constantly. And `canDropOn` structurally cannot help:
step 6 (wrong depth) and step 6b (different template, D86) **both raise `level_mismatch`**, and
they are right to, because `canDropOn` exists to predict the server's code and
`nodes_check_level_adjacency` raises one code for both. But a plant manager experiences
*"a Line can only sit under a Department"* and *"that block is a different site structure"* as
completely unrelated problems.

So P1-5g adds a separate explanation layer, `describeDrop`, whose **`kind` is derived entirely from
`canDropOn` and whose `message` is chosen by reading the same data.** The invariant — that the two
can never disagree about legality, only about wording — is asserted as a property over the whole
fixture (L1–L4), not written in a comment.

Two orderings are load-bearing and they are **different from each other**:

- `canDropOn` asks position, then template, because that is the server's order.
- `describeDrop` asks *"can we even name the structure"* first (an unresolvable level must not be
  reported as "different structure" — that is a wrong explanation, not a vaguer one), then
  structure, then depth. When a drop is both cross-structure and wrong-depth, **the structure is the
  dominant fact.**

#### What a cross-structure refusal LOOKS like, which is what the brief actually owed

The block is muted **by colour** — never `opacity` — and says why once in its heading
(*"different structure — not a destination"*), so twenty rows do not each refuse separately. The
hovered row keeps its red outline at full strength. Nothing in the block is ever dashed, because
`eligibleTargetIds` cannot contain any of it. `groupDropState` returns `"foreign"` for the whole
block in one call, and **F3 asserts that implication against `canDropOn` directly** — every node ×
every group — rather than trusting the reasoning.

`"candidate"` is deliberately the weak half of that pair: it means *not ruled out wholesale*, not
*everything here is legal*. **F7 asserts the weakness**, so nobody can strengthen it later without a
test objecting.

#### D90's `guides` bought something concrete

The drop indicator is an **adopt tick**: a stub at the target row's bottom edge sitting in the *same
rail a real child's elbow occupies*, computed by `dropRailIndex(depth) = depth + 1` from the
ancestry `flattenTree` now emits. It lines up with the children the target already has instead of
floating at an invented indent — and it is returned as a **unitless count**, multiplied by a `rem`
rail width in the stylesheet, because a px number in a `style` prop is invisible to `scaleAudit`.
That is exactly how this same component's indent shipped unscaled (D89/D90).

It is deliberately **not** an insertion caret. And the reason changed while the brief was being
written: the first draft said `move_node` cannot reorder. **Reading migration 0010 says otherwise** —
`move_node(p_node_id, p_new_parent_id, p_sort_order int default null)` writes
`sort_order = coalesce(p_sort_order, sort_order)`. So reordering is a **scope decision** (P1-5i),
not a limitation, and a dropped node keeps its `sort_order` and lands wherever `compareSiblings`
puts it — **not necessarily last**, which is itself why an adopt mark on the parent is honest and a
caret between two specific rows would not be.

#### Rule 2c ran BEFORE handover for the first time, and it earned its keep

Part A: 43 cases green cold, **12 designed mutations all caught, 5 unprescribed also all caught**,
one executed and reported **inert** (a redundant clause unreachable past `canDropOn`'s own
`invalid_argument` — kept anyway, because it is load-bearing for TypeScript's narrowing).

Then Part B was rendered in headless Chromium against the real stylesheets, with markup emitted by
the real pure functions. **Three defects the suite could not possibly see:**

1. **The eligible-row highlight was invisible.** `background: var(--page)` on `var(--surface)` is a
   three-unit difference, with a `--grid` hairline on top. Every declaration correct; the one
   affordance drag adds over the menu simply did not render. **D89's shape exactly — a defect made
   of absent contrast.**
2. **`opacity: .42` on the foreign group dimmed the refusal it was explaining.** An `opacity` below
   1 creates a stacking context its children cannot escape, so the red outline on the hovered row
   was dimmed too. *The message you most need to read was the one you could least see.*
3. **The adopt tick had no positioned ancestor.** `.row` is not `position: relative`, so it was laid
   out against the initial containing block and rendered off the card. **The most novel piece of the
   whole affordance was silently absent while everything passed.**

Then the alignment was **measured**, not eyeballed — the tick's computed left against the left edge
of the elbow drawn by the target's existing child:

| viewport | root font | tick left | child elbow | delta |
|---|---|---|---|---|
| 1440 | 16px | 437.00 | 437.00 | 0.00 |
| 2560 | 19.11px | 731.77 | 731.76 | 0.01 |
| 3840 | 21.60px | 1063.60 | 1063.58 | 0.02 |

Render kept at `docs/mockups/p1-5g-drag-states.png`.

#### Three instrument bugs, all in the design session's own tools

Recorded because they are the failure modes of this exact procedure, and all three were caught by
guards that exist because of earlier ones:

1. **M1's anchor had the wrong indentation and matched zero lines** — which would have scored NOT
   CAUGHT if the anchor-present-and-unique assertion had not been there. Instrument failure #16,
   arriving again one brief later.
2. **The strip-types shim's `toEqual` could not see Sets.** `JSON.stringify(new Set(["a"]))` is
   `"{}"`, so every pair of Sets compared equal and M6 read as caught-by-one-case when it actually
   breaks four. **vitest's own `toEqual` handles Sets correctly, so this would have passed in CI and
   been wrong here** — rule 2b in a new form: the measuring instrument disagreed with the runner
   that will guard the code. The committed cases now compare **sorted arrays**, so they do not
   depend on any runner's Set support.
3. **V9 dropped `n5` onto `n5`'s own descendant**, so it measured a `node_cycle` and silently
   stopped testing "a position-0 node is always top-level". Fixed by adding a second Standard root
   to the fixture. **A case whose name promises more than its fixture can deliver** — rule 3b, and
   the mutation run is what exposed it: M2 (reordering the explain branches) was caught by *nothing*
   until case V14 was added.

**Prediction for Pratik's acceptance run: 430 → 473 tests, 16 → 17 files.**

---

### 19.27 D92 — reordering a level silently corrupts every node under it (Aug 25, 2026)

Raised by Pratik looking at the Levels card: *"This should also be able to drag, don't you think?"* The
answer is yes (§19.28), but checking what a level reorder actually does first turned up a defect in
the **↑/↓ buttons that already ship**.

#### What `save_hierarchy_levels` guards, and the one thing it does not

Read straight off migration 0014, not recalled:

- **Check 7** refuses to REMOVE a level that still has nodes → `level_in_use`.
- **Check 8** (D72) refuses to move the schedulable flag off a level that still has runs or
  assignments → `schedulable_level_locked`.
- **Nothing at all guards a REORDER.** The write pass is three unconditional statements:
  `is_schedulable = false` for the template, `position = position + 1000`, then
  `update hierarchy_levels set position = v_idx, name = v_name` per entry.

And the adjacency trigger cannot cover for it: `nodes_before_level` is declared
`before insert or update of parent_id, level_id **on nodes**`. Rewriting `hierarchy_levels.position`
never touches a `nodes` row, so the trigger never fires. **There is no trigger on
`hierarchy_levels` at all** (checked with grep, not assumed).

#### Measured, on a scratch PG16 with the real migrations and the real seed

Swapping `Department` (position 1) and `Line` (position 2) in Northwind's Standard Plant — both of
which hold nodes — as a genuine `authenticated` admin:

| | |
|---|---|
| adjacency violations before | **0** |
| `save_hierarchy_levels` result | **success**, no error, no warning |
| adjacency violations after | **12** |

```
   name   | child_level | child_pos | parent_level | parent_pos
 Assembly | Department  |         2 | Site         |          0
 Line 1   | Line        |         1 | Department   |          2      <-- child ABOVE its parent
 Cell 1   | Work Cell   |         3 | Line         |          1
 ...
```

Every node in the org is now in a state `create_node` and `move_node` would both refuse to build.

#### The downstream behaviour is worse than a refusal

Also measured, on the corrupted tree:

- **`create_node` SUCCEEDS and puts the node on the wrong level.** An admin clicks *Add child* on
  `Assembly` — a Department — intending a Line. `create_node` resolves the child level as
  `parent position + 1 = 3`, and creates a **Work Cell**. No error. **Silently wrong data is a
  worse outcome than a refusal**, and it is the outcome the most ordinary action produces.
- **`move_node` is REFUSED**, with `level_mismatch` / *"the new parent is not exactly one level
  above the node's existing level"* — an accurate message about a cause the admin has no way to
  connect to a level reorder they did ten minutes ago.
- **It IS recoverable**: swapping the two levels back returns violations to 0. Nothing is destroyed.
  But nodes created at the wrong level in the meantime are **not** repaired by the undo, and nothing
  reports them.
- Not measured: whether `board_window` still reads. The probe used a wrong signature and the call
  errored; the board indexes by `path`, not by level, so it very likely does — **but that is
  reasoning, not a measurement, and it is written here as such.**

#### Reachable from the UI today, with no warning

`LevelEditor` renders ↑/↓ per row wired to `applyLevelAction({kind:"moveUp"|"moveDown"})`, then
**Save** calls `saveHierarchyLevels`. `validateLevelDraft` checks array-ness, emptiness, the 64 cap,
exactly-one-schedulable and blank names — **nothing about positions or nodes**. So the whole path is
open, and the screenshot Pratik sent is a picture of it.

#### The fix, and why it is a refusal rather than a cascade

**A level that has nodes may not change position.** Same shape as check 7, same error family:
`level_in_use`, with the offending `level_ids` in DETAIL. Consistent with every other place in this
schema where adjacency is a hard invariant, and it degrades honestly — adding a level at the END
still works (nothing moves), renaming still works, and reordering a structure whose levels are still
empty still works, which is the case that matters while an org is being set up.

**Not a cascade.** Re-levelling everyone's nodes to match a new order is a silent rewrite of the
customer's plant, on the strength of two clicks. The one legitimate case a refusal blocks — inserting
a level in the MIDDLE of a hierarchy that already has nodes — genuinely does invalidate everything
below it, and belongs to a re-import (P1-5h), not to a drag.

Client half: `LevelEditor` must show which rows are pinned and why, so Save is not the first place
the admin learns. Same division as P1-5g — **the server refuses, the client explains.**

Filed as **P1-5j**, and it **blocks P1-5i** (§19.28): a drag affordance over the ↑/↓ buttons makes an
unguarded operation easier and more inviting to perform.

#### The lesson, which is rule 7 again

*"When a guard is introduced or a constraint MOVES, ask not 'is this statement guarded' but 'what
else is conditioned on the same fact'."* Adjacency is conditioned on `hierarchy_levels.position`,
and every guard in the system watches `nodes`. D86 moved level identity and D87 was the fallout on
`create_node`; **this is the same fact leaking on the other side — the level table can move under
the nodes, and nothing is watching that direction.**

---

### 19.28 P1-5i — dragging the level list (Aug 25, 2026)

Pratik's actual question. **Yes**, and it is materially cheaper than the tree drag, for one reason:
**a level reorder has no illegal target.** The list is a local `LevelDraft[]` until Save, the array
index IS the position (D70), and `validateLevelDraft` cares about names, the cap and the schedulable
count — none of which a reorder changes. So there is no `canDropOn`, no refusal, no explanation
layer, no `describeDrop`. Every position is legal, right up until Save.

- **Logic:** `applyLevelAction` already reorders, by adjacent swap. A drag from `i` to `j` is exactly
  the composition of those swaps, so one new action — `{kind:"moveTo", from, to}` — is the honest
  single-step version, and it is testable against the existing swap chain.
- **Mechanism:** this is where an insertion caret between rows is CORRECT, unlike P1-5g §5.1 — a
  level list is an ordering and nothing else.
- **The thing to decide before building it:** P1-5g puts pointer-capture drag into
  `NodeTreeEditor`; this puts it into `LevelEditor`. **Two copies of pointer handling is exactly what
  `useDragGesture` was extracted to prevent** on the board — *"three separate copies of pointer
  handling is how the mockup's four `start*Drag` functions ended up subtly different from each
  other."* Either share the mechanism from the start, or accept the second copy deliberately and say
  so. Deciding after P1-5g ships means a refactor.

**Sequenced after P1-5j (§19.27).** Building it first would put a nicer handle on a loaded gun.

---

### 19.29 P1-5j built (SQL half) — migration 0016, and the grant block 0014 never carried (Aug 26, 2026)

D92 (§19.27) is closed on the database side. **`scripts/verify-db.sh`: 107 named cases, exit 0**, up
from 101.

#### The guard, and why it is phrased as an outcome

`save_hierarchy_levels` gains a check that runs **after** its three write passes and reads the real
rows:

- every node in the saved template with `parent_id is null` must sit on a level at position 0;
- every node with a parent must sit exactly one position below it.

Either failing raises `level_in_use` — **no thirteenth error code**; the closed set stays at twelve.
The raise aborts the transaction, so a refused save leaves the stored order untouched (case L14).

**The phrasing is the design.** "A level with nodes may not change position" is the obvious rule and
it is a trap: a database already scrambled by a pre-0016 save could never be repaired, because the
repair is itself a move of an in-use level. Asking whether the RESULT is sound instead permits the
repair (**L15 repairs 12 violations**), refuses the damage, and — the reason it is worth writing this
way — **needs no change when nodes become re-levellable (P1-5k)**, since a save that reorders levels
and fixes the nodes in one transaction simply ends in a sound state.

Running the check after the write rather than predicting it from `p_levels` is deliberate too: it
cannot drift from what the write actually did, which is the duplicated-logic failure this project
keeps paying for.

#### Two defects found while verifying it, neither of which anything was looking for

**1. A parent-join alone misses a stranded ROOT.** The first version checked only
`child position = parent position + 1`. A structure holding one root and no children has no
parent/child pair at all, so swapping its levels scores **zero** join violations while the root sits
off position 0 — measured, the swap was ALLOWED. Both halves of `nodes_before_level`'s rule have to
be mirrored, not just the one an obvious fixture reaches. Case **L13**.

**2. THE SUITE WAS PINNING THE BUG AS THE CONTRACT.** `70_hierarchy_test.sql`'s **L1** was called
*"reorder — swap Department and Line"*, ran that exact swap on the seeded populated org, and asserted
it **succeeded**. L10's first save did the same. Both went green for as long as the defect existed.
This is worse than the D87 shape (a workaround in a test file is an unfiled defect): **a passing case
is evidence a behaviour is intended, not that it is correct**, and here the intent recorded was
wrong. L1 now asserts the refusal; the "a reorder can succeed" coverage it used to provide moved to
**L1b**, which runs it on a structure where it is legal.

#### D93 — every RPC migration 0014 created is executable by `anon`

Found by case L17 while verifying this migration. 0010 explicitly revoked EXECUTE from PUBLIC and
from `anon` for `save_hierarchy_levels(jsonb)`. **0014 dropped that function and created
`save_hierarchy_levels(jsonb, uuid)` plus three template RPCs — and its grant block covers only the
`hierarchy_templates` TABLE.** All four arrived with Postgres's PUBLIC default.

Measured: of thirteen public RPCs, **exactly the four from 0014** answer
`has_function_privilege('anon', …, 'EXECUTE')` = true. The other nine are false.

Exposure is small and fails closed — `anon` cannot reach `api_raise` either, and every one of these
opens with an `app_is_admin()` check — but it fails with a **raw Postgres error outside the
twelve-code closed set**, and "every RPC is explicitly revoked from anon" is a property this schema
otherwise holds without exception. Restored in 0016's own grant block.

**This is the project's own recorded trap arriving again**, and the reason 0016 needed a grant block
regardless: a migration that drops and recreates a function must carry one. (0016 itself uses
`create or replace`, which PRESERVES grants — measured, not assumed.)

#### Six mutations, all caught — after the runner and two fixtures were fixed

| # | mutation | caught by |
|---|---|---|
| M1 | drop the ROOT half of the guard | L13 |
| M2 | drop the PARENT-JOIN half | L1, L14 |
| M3 | scope the parent-join by ORG instead of TEMPLATE | L16 |
| M4 | invert the parent-join comparison | L1 + 8 others |
| M5 | remove the revoke block | L17 |
| M6 | scope the ROOT half by ORG instead of TEMPLATE | L16 |

**Three instrument failures on the way there, all of them mine:**

1. **The runner scored a DEAD SERVER as five clean passes.** Between two mutation runs the scratch
   server stopped; a dead socket produces zero `FAIL` lines, and a runner that only greps for
   failures reads that as NOT CAUGHT — including for four mutations proved catchable minutes
   earlier. Fixed by counting the cases that actually **reported** and treating a drop as CRASHED.
   **A guard must not be able to fail silently** — instrument failure #2 and #7, together.
2. **L16's first fixture scrambled a template in the OTHER ORG**, where org-scoping and
   template-scoping give the same answer, so M3 was NOT CAUGHT. Rule 3: make the two candidates
   disagree.
3. **L16's second fixture had a root and no child**, so the second template's only breakage was a
   stranded root — which the parent-join clause never looks at, leaving M3 still uncaught. **The
   fixture has to be able to break the specific clause under test.**

#### What is left of P1-5j

The client half. **The description that stood here was wrong and is superseded by §19.30** — it said
to grey out the rows that cannot move, which would make the client stricter than the server and
forbid the very repair L15 proves the server allows. The correct shape is to mirror 0016's OUTCOME
check against the draft order and disable SAVE, not the arrows. `database.types.ts` is unaffected
either way: the signature did not change.

---

### 19.30 P1-5j's client half — mirror the OUTCOME, do not grey out the rows (Aug 26, 2026)

The first description of this half, written into §19.29 and the roadmap the same evening, was
**wrong**. Recording why rather than quietly replacing it, because the mistake has a general shape.

It said: *grey out the levels that have nodes; since a node's parent is always one rung up, the
in-use levels are always the top ones, so the rule is "the top N are pinned".* The derivation is
sound for valid data — populated positions do form a prefix — and it is still a useful thing to know
about how the screen will look.

**But it is the wrong RULE, because it is not the server's rule.** 0016 does not refuse *"a move of a
level that has nodes"*. It refuses *"an order whose result strands a node"* — phrased that way
deliberately (§19.29) so a database already scrambled by a pre-0016 save can be repaired, which case
**L15** proves. A client that disabled the arrows on every populated level would forbid **exactly the
repair the server permits**: the client stricter than the server, which is the one direction this
project's authority rule forbids and the invariant `canDropOn` exists to hold.

#### What it should be

- **The arrows stay enabled** (and later the drag). The admin arranges freely.
- **A pure function mirrors 0016's check against the DRAFT order**: every root would land on a
  position-0 level, and every child exactly one position below its parent.
- **Save is disabled while that fails**, naming the levels that would strand nodes — so the refusal
  is on the button that performs the write, not on the controls that compose it.
- **A scrambled structure therefore lights up the moment the admin drags it back into a sound
  order.** The UI leads to the repair instead of blocking it.

#### Two facts to build on, both checked rather than assumed

- **`LevelEditor` does NOT currently receive `nodes`** — its props are `levels` and `templateId`
  only. `AdminPage` has the node list (it passes it to `NodeTreeEditor`), so this half threads it
  down. Four files: the pure module, its vitest suite, `LevelEditor.tsx`, `AdminPage.tsx`.
- The natural home for the logic is beside `applyLevelAction` in
  `src/features/admin/lib/levelDraft.ts`, which is already pure, already `import type`-only, and
  already the module that owns "what this draft means".

#### The general lesson

**When a server guard is phrased as an OUTCOME, the client mirror must be phrased as an outcome
too.** A client that re-derives the rule as a restriction on the *action* will diverge from a server
that judges the *result* — and it will diverge in the direction that blocks legitimate work, which is
the expensive direction. The tell that this was heading wrong: the client rule and the server rule
could be stated in the same sentence only by dropping the word "result".

---

### 19.31 P1-5j's client half — BUILT (Aug 26, 2026)

Built by the design session directly, per §19.30, in four files plus one deliberate fifth (below).

#### `findLevelOrderProblems`, beside `applyLevelAction` in `levelDraft.ts`

It mirrors **three** server questions, not two, because all three raise `level_in_use` and all three
are the same question — *"what does this save do to the nodes that already exist?"*:

| | server | when |
| --- | --- | --- |
| check 7 | a level being **removed** still has nodes | before the write |
| D92 #1 | a **root** sits on a level whose position is not 0 | after the write |
| D92 #2 | a **child**'s level is not exactly one below its parent's | after the write |

Check 7 was folded in on purpose. Its refusal is unconditional — a level of this template that is
dropped from the draft while nodes still sit on it is *always* refused — so reporting it cannot make
the client stricter than the server, and leaving it out would have meant the `×` button kept the
exact defect D92's client half exists to remove: Save as the place you find out.

Positions come from the **draft index**, never from `hierarchy_levels.position` — the RPC takes the
whole ordered array and the index IS the position (D70). That single choice is what makes the repair
case work, and case S5 pins it: a stored order that is already scrambled, dragged back into shape,
reports nothing.

`levels` is passed **complete**, not filtered by template, and the function scopes by template
itself, exactly as the RPC does (`nl.template_id = v_template_id` / `cl.template_id =
v_template_id` — the template of the level the node ITSELF sits on, never its parent's).

#### Threading `nodes` down

`LevelEditor`'s props were `levels` and `templateId`. It now also takes `nodes` — the same complete
array `NodeTreeEditor` already gets from `AdminPage`'s one shared `fetchHierarchyTree` read. The
editor renders no node and never will; it needs the list only to answer the outcome question.

#### The message

Save goes dark and a short list appears above the buttons, each line describing the RESULT rather
than a rule about which row may move:

- *2 nodes on "Site" have no parent, and this order would leave them below the first level.*
- *6 nodes on "Department" would no longer sit directly under their parent.*
- *Removing "Work Cell" would leave 1 node with no level to sit on.*

A level is named by its **draft** name, not its stored one, so the sentence points at a row that is
actually on screen; a blank draft name falls back to the stored one (S13, S14).

#### Verification

- **18 cases** (S1–S18) in `src/test/levelDraft.test.ts`, taking that file from 20 to 38.
- **11 designed mutations, all caught. 7 unprescribed, 6 caught.** Every run reported 38 of 38
  cases, so no result was a dead runner scored as a pass.
- **U1 executed and proved INERT, and kept**: `fateOf` returns another template's *stored* position
  for a level this save does not touch. Unreachable — a node and its parent always share a template
  (`nodes_check_level_adjacency`), and the node loop is pre-filtered to this template — so no
  fixture can drive it. It is the faithful mirror of what the RPC would read, and it costs one line.
- **⭐ U3 found a hole in the case list, and S18 was written because of it.** Keying the tally on the
  level alone instead of on `(kind, level)` passed all seventeen cases that existed. **One level can
  carry two different kinds of problem at once** — a stranded root and a stranded child — and that is
  exactly what a database scrambled by a pre-0016 save looks like, since roots stay put while
  `create_node` puts new children one rung under a parent that has moved. S18 is that fixture.
- **`node node_modules/typescript/lib/tsc.js -b --force` → exit 0**, and `node
  node_modules/eslint/bin/eslint.js .` → exit 0, both run by the design session on Pratik's own
  machine. **This is new and it changes the handover**: `tsc` and `eslint` are pure JS and run under
  the Linux node on the device VM even though `node_modules` holds Windows-ARM binaries. `vitest`
  does NOT (`Cannot find module '@rollup/rollup-linux-arm64-gnu'`), and npm has no network there, so
  the vitest count remains Pratik's to run. The tsc instrument was itself checked: an injected
  `nodes={42}` produced `TS2322` on both call sites, so the clean run was a real run.
- **RENDERED IN HEADLESS CHROMIUM AND LOOKED AT** (`docs/mockups/p1-5j-save-gate.png`), in three
  states — a sound order with Save live, a swapped order with Save dark, and a removal with the
  singular copy. Two defects came out of the picture that no case could see:
  1. **The reasons read as three separate failures.** Every line wore `.errorLine`'s weight, colour
     and 0.625rem top margin, including the heading, so nothing on screen said the sentences belonged
     to the line above them. Fixed with `.problemList` / `.problemItem` — **the deliberate fifth
     file**, `LevelEditor.module.css`, all in `rem` because it is a `REM_SURFACE`.
  2. **The singular copy said "it" twice about two different things** — *""Department" still holds 1
     node, so removing it would leave it nowhere to sit."* Rewritten as *"Removing "Department" would
     leave 1 node with no level to sit on."* Only rendering the one-node state showed it; the
     plural state reads fine and is what every earlier draft had in front of it.

**What is NOT mirrored, deliberately:** check 8, `schedulable_level_locked` — moving the schedulable
flag off a level that still has scheduled work. That is a question about ASSIGNMENTS, and this screen
holds no assignment data. It still surfaces through `describeSchedulerError` on the round trip.

---

### 19.32 P1-5g — BUILT by a Sonnet agent, and reviewed (Aug 26, 2026)

Delivered: `treeDrag.ts` (230), `treeDrag.test.ts` (341, **43 plain `it()`**),
`NodeTreeEditor.tsx` (511 → 659), `NodeTreeEditor.module.css` (317 → 530). Nothing else in the
working tree moved.

#### The agent found a real defect IN THE BRIEF

§6.3's worked pseudocode for `describeDrop` **does not typecheck**. Written as the brief has it —
`if (result.ok && !result.noop) {…} if (result.ok && result.noop) {…} return {…result.reason…}` —
TypeScript's control-flow analysis does not eliminate `CanDropResult`'s `{ok:true}` arm through a
compound condition, so the trailing `result.reason` is `TS2339`. The agent restructured to plain
discriminant checks (`if (!result.ok)` first, then `if (result.noop)`), re-ran all 43 cases and all
12 mutations against the refactor with identical outcomes, and reported it. The brief has been
amended. **This is brief-writing rule 12 landing on the design session again: the reference
implementation was executed under `--experimental-strip-types`, which STRIPS types without checking
them, so a pure typing defect could survive a green mutation run.**

#### The independent review (verification-standard rule 2 — not a re-read of the report)

- **Own shim, own harness, real modules by absolute path** — not the agent's scratch copies. 43 of
  43 pass. The first run said 4 FAIL: my shim was missing `toBeNull`, `toBeGreaterThan` and
  `toContain`. **Instrument failure #25** — and the tell was that all four failures were
  `expect(...).toX is not a function`, an instrument shape, never an assertion shape.
- **7 unprescribed mutations. 6 caught.** U1 — `eligibleTargetIds` keeping `legalParentsFor`'s
  `(root)` entry — is **executed and INERT**, and provably so rather than by argument: probing every
  node in the fixture shows `canDropOn(x, null)` is `{ok:true,noop:true}` for all three roots and
  `level_mismatch` for everything else, so **no node is ever offered `(root)`** and no fixture can
  drive the filter. It is kept for type narrowing (`ParentChoice.id` is `string | null`).
- **Malformed-argument sweep, 70 probes.** Every throw is `nodes.map`/`levels.map` inside
  `hierarchy.ts`, reached only by a non-array — which `src/lib/api/shapes.ts`'s parser cannot
  produce. Pre-existing, out of P1-5g's scope, not filed. `dropRailIndex(NaN) → NaN` follows N6's
  documented "recorded, not clamped" contract and lands in a CSS custom property, where an invalid
  value simply drops the declaration.
- **`tsc -b --force` exit 0 and `eslint .` exit 0**, run by the design session, not quoted from the
  report.
- **The predicted defect did not happen.** Pointer capture is correct: `setPointerCapture` on the
  handle, `document.elementFromPoint(...).closest("[data-node-id]")` for the hit test rather than
  `e.target`, and `.dragChip` is `position: fixed` with `pointer-events: none` — which it must be,
  since the chip is rendered AT the pointer and would otherwise become its own hit-test result and
  make `hoverId` permanently null.

#### Rule 2c — rendered, and the alignment measured rather than eyeballed

`docs/mockups/p1-5g-review-render.png`: dragging *Cell 1* shows two eligible Lines (one dashed, the
hovered one solid with the adopt tick), the dragged row muted, and BOTH foreign blocks — *Compact
Site* and *Unknown structure* — muted with "different structure — not a destination". Dragging
*Line 1* onto a Site shows the red refusal outline and the reason in the chip.

**The tick's claim is that it lines up with the elbows of the children the target already has**, so
it was measured against a target that HAS one. Dropping *Line 2* onto *Packing*, whose child *Line 1*
is one rung down: tick left edge **89.00px**, that child's elbow stroke **89.00px** — delta
**0.00px** at both 640 and 1280, and **0.01px** at 2560 (106.10 vs 106.09), where the rail measures
21.50px instead of 18.00px, so the whole affordance is scaling as `rem` should.

One thing the picture reports that is NOT a defect: with two cards on one page both `position: fixed`
chips land in the first card. That is the render harness, not the component — a real screen holds one
tree.

#### One judgment call the agent made and flagged, upheld

§7.1 says the pointer block must "touch no tree-specific state… nothing about levels, templates or
`canDropOn`", while the same section's own worked example has `onPointerDown` call
`eligibleTargetIds(row.node.id, nodes, levels)`. The agent read "tree-specific state" as *this
component's other state* (`collapsedIds`, `popover`) and kept the block contiguous and untangled from
those. That is the right reading — the requirement exists so P1-5i can LIFT the block, and what makes
a lift hard is entanglement with a component's own state, not a call to a pure function. **The brief's
wording is what is wrong, and it is now amended.**

---

### 19.33 P1-5k — promote / demote a node and its subtree by one rung (design, Aug 26, 2026)

Raised by Pratik as *"what if we changed a level's nature on the nodes?"* The hole underneath the
question: **`nodes.level_id` is immutable.** Nothing in sixteen migrations updates it; `move_node`
changes only `parent_id` and `sort_order`; and with one level per rung a node's level is fully
determined by its parent's. So a subtree built at the wrong rung can only be deleted and rebuilt.

Everything below was **measured on a scratch PG16** with all sixteen migrations and `seed.sql`, as
real rows, not reasoned.

#### 1. Why this cannot be done one row at a time — measured

`nodes_before_level` fires `before insert or update of parent_id, level_id on nodes`. Promoting
*Line 1* under Contoso means it becomes a child of *Plant 1* and its level becomes *Department*.
Either half alone is refused:

- `update nodes set parent_id = <grandparent>` → `level_mismatch`, *"node … level position is not
  exactly one below its parent's"*.
- `update nodes set level_id = <one up>` → **the same error**.

There is no order that works. The operation is atomic or it is nothing, and that is exactly what
**0010's `app.hierarchy_migration` escape hatch (D69) was reserved for** — its own comment names "the
Phase-3 mid-level-insertion tool". P1-5k is the first caller.

#### 2. What the hatch does and does not turn off — measured

With `set local app.hierarchy_migration = 'on'`, both updates land. Afterwards:

- **0 adjacency violations** in the org. The tree is structurally sound.
- **The path triggers still ran.** `nodes_before_path` / `nodes_cascade_path` fire on
  `update of name, parent_id` and are NOT gated by the hatch, so
  `plant_1.assembly.line_1.cell_1` became `plant_1.line_1.cell_1` for the whole subtree with nothing
  extra to write. **The hatch suspends the LEVEL invariant only.**
- **1 run and 1 assignment were left sitting on a node that is no longer on the schedulable level**,
  silently, with every structural check passing.

That last line is the whole feature. The tree is perfect and the schedule is broken.

#### 3. The stranded-work rule — and why it is scoped, not global

Refuse. Phrased as an OUTCOME per rule 7b — *"after this move, does every run and assignment in the
moved subtree still sit on a schedulable node?"* — never as *"a node with work may not be
promoted"*, which would be the D92 mistake a second time.

**But the outcome check is scoped to the MOVED SUBTREE, and that scoping is load-bearing.** A pure
org-wide "no stranded work anywhere" check would refuse every promote and demote in the org for as
long as one already-stranded run existed — and P1-5k offers no way to un-strand it, so the admin
would be locked out with no repair path. Scoped to the subtree the check still permits a move that
*fixes* a stranding (the answer after the move is what is asked), still refuses one that *causes*
one, and leaves the rest of the org alone. **Everything the operation could have changed is inside
the subtree, so the scoped check and a full outcome check see the same rows.**

Code: `schedulable_level_locked`, already in the closed set, already meaning exactly this — check 8
in `save_hierarchy_levels` refuses moving the schedulable flag off a level that still has work, and
this is the same refusal from the other side. **No thirteenth code.** Note check 8's own shape:
runs first, and assignments consulted only when the run count is zero, because after P1-4e a direct
assignment can exist with no run at all (D72). P1-5k must count both.

#### 4. The other four refusals, each measured rather than argued

| | measured | raise |
|---|---|---|
| promote a node whose level is position 0 | there is no row at `position - 1` in that template — 0 rows | `level_mismatch` |
| demote whose deepest descendant has no rung below | **the `position + 1` update matched 0 ROWS and the parent change stood — leaving 1 adjacency violation, silently, because the hatch was on** | `level_mismatch` |
| the new parent already has a child of that name | **raw `23505 nodes_org_id_parent_id_name_key` — outside the twelve-code set** | catch and re-raise `path_collision` |
| demote onto a target inside the node's own subtree | `path <@ path` | `node_cycle` |

The second row is the one to take seriously. **A demote that runs off the bottom of the template
does not fail — it half-succeeds and corrupts the tree.** The post-write adjacency check is not
belt-and-braces here; it is the only thing standing between this feature and a fresh D92.

#### 5. Shape

**Two RPCs, not one with a nullable argument.**

```
promote_node(p_node_id uuid)                       returns jsonb
demote_node (p_node_id uuid, p_new_parent_id uuid) returns jsonb
```

Promote's new parent is **derived** — the node's grandparent, or `null` when the node's parent is a
root and the node itself becomes one. Demote's must be **chosen**: the target is a node at the
node's own level, in the same template, outside its own subtree. That asymmetry is the design, and
one function with `p_new_parent_id uuid default null` invites exactly the bug of demoting with no
target. It also walks into a recorded trap — **generated types cannot express a nullable RPC
argument**, so a shared signature would need a cast at every call site (§ the `createNode` /
`moveNode` casts). Two signatures, both non-nullable, need none.

#### 6. Body, in order — and the one ordering that matters

1. Admin check, org scope, resolve the node. (D83: a SECURITY DEFINER function taking a node id must
   scope by `app_current_org()` itself.)
2. **Capture the subtree's node ids into an array FIRST, before any write.** The re-parent rewrites
   every descendant's `path`, so a `path <@ …` predicate evaluated afterwards is reading a different
   tree than the one the caller named. Capturing ids up front makes the two writes order-independent.
3. Compute the destination level (`position ± 1`, same `template_id`) for every distinct level in the
   subtree. Refuse if any is missing.
4. `set local app.hierarchy_migration = 'on'`.
5. Update `parent_id` on the one node; update `level_id` across the captured ids.
6. **`set local app.hierarchy_migration = 'off'` — inside the function, before the checks.** The
   setting is transaction-scoped, and nothing later in the transaction should run unguarded.
7. Post-write outcome checks, reading real rows: 0016's two adjacency queries, then the scoped
   schedulable-work query. Each raises; the raise aborts the transaction and nothing persists.
8. Return the moved subtree.

#### 7. ⚠️ OPEN — the escape hatch is not privileged, and nobody had checked

Measured: `set local role authenticated; set local app.hierarchy_migration = 'on';` **succeeds.**
`app.*` is a plain GUC and any role can set it, so the level-adjacency invariant holds only because
no path lets a client run arbitrary SQL — PostgREST executes each RPC in its own transaction and
offers no way to inject a `SET`. **Not reachable today, and it has been true since 0010.** But
"unreachable because of something outside the database" is an unexamined claim about safety in a
multi-tenant product (rule 5), and P1-5k is the first feature that makes the hatch load-bearing
rather than theoretical. Worth deciding before the brief: leave it, or gate it on
`current_user = <owner>` / a SECURITY DEFINER context. **Not fixed here — filed, and named as
Pratik's call.**

#### 8. What P1-5k does NOT do

- It does not fix D92. Adjacency is a chain, so re-levelling is bulk or nothing; a level reorder
  still has to be refused when it strands nodes.
- It does not move work. A promote that would strand a run is refused, not repaired — the admin
  moves the work first. Repair is a later feature and 0016's outcome phrasing already survives it.
- It does not move a node between templates. Up and down within one shape only.
- **It DOES unlock inserting a level mid-hierarchy** — the case §19.30's S7/S8 currently refuse:
  insert the level, then promote or demote the subtrees that need to straddle it.

---

### 19.34 D94 — the first thing a real user tried was the one gesture P1-5g excluded (Aug 26, 2026)

Pratik, minutes after P1-5g landed: *"I tried moving cell 3 between cell 1 and cell 2, but it turned
red saying work cell can only sit under a line."*

**The drag is doing exactly what the brief told it to do. The brief is wrong.**

Cell 1, Cell 2 and Cell 3 are all children of Line 1 (`seed.sql`), so that gesture is a **sibling
reorder**. P1-5g §5.1 decided *"drop means RE-PARENT, never re-order"* and §5.2 excluded the
insertion caret. So the pointer resolved to a Work Cell row, `canDropOn(Cell 3, Cell 2)` returned
`level_mismatch`, and `describeDrop` produced a correct explanation **of an operation he was not
attempting**. Reproduced on the scratch DB as a real `authenticated` admin:
`move_node(Cell 3, Cell 2)` → `level_mismatch`, *"the new parent is not exactly one level above the
node's existing level"*.

#### Why this got excluded, and why that reason had already evaporated

P1-5g's first draft justified the exclusion as *"`move_node` cannot reorder siblings — it has no
argument for one."* That was false, and it was caught before the brief shipped: `move_node` takes
`p_sort_order int default null` and writes `sort_order = coalesce(p_sort_order, sort_order)`
(migration 0010, its only definition). The rationale was corrected to *"deliberately out of scope"*
and **the scope decision itself was never re-examined once its premise died.** That is the actual
failure here, and it is a new shape: a conclusion outliving the argument that produced it. Brief-
writing rule 12 caught the false claim; nothing went back and asked whether the decision it had been
supporting still stood.

#### What the server can already do — measured, not read

As a real admin, in one transaction:

```
move_node(Cell 1, Line 1, 10)
move_node(Cell 3, Line 1, 20)   ->  Cell 1, Cell 3, Cell 2
move_node(Cell 2, Line 1, 30)
```

and **every `path` was untouched**, which is right: a reorder moves nothing in the tree. So the
capability has been there since 0010 and only the client declines to use it.

#### But one `move_node` call cannot express this reorder — also measured

**`seed.sql` sets no `sort_order` at all, so every sibling in the database sits at 0.** There is no
integer between 0 and 0. Measured cross-parent as well: `move_node(Cell 3, Line 2, 1)` against
incumbents Cell 4 and Cell 5 — both at `sort_order` 0 — lands Cell 3 **after both of them**, not
between them.

**So this is not client-only work.** Placing a node at a position requires renumbering the
destination's children, which is a multi-row write and must be atomic. Filed as **P1-5l**, and it
needs migration 0017.

#### P1-5l, proposed

**One RPC, not two.** `place_node(p_node_id uuid, p_new_parent_id uuid, p_index int)`:

- re-parents when the parent changes, reusing `move_node`'s existing guards (cycle, level adjacency,
  path collision, org scope) rather than restating them;
- then renumbers the destination's children `0, 1, 2, …` so the node lands at `p_index`;
- atomic, one round trip, one gesture.

`move_node` stays exactly as it is — it is what the "Move to…" menu calls, and that path re-parents
without caring about position.

**On the screen**: the top and bottom bands of a row mean *place before / after this row, as a
sibling of it*; the middle band keeps today's *adopt into this row*. **An insertion caret IS correct
here** — unlike P1-5g's adopt tick, a between-drop genuinely determines the resulting position, which
is precisely the reason §5.1 gave for refusing a caret then. Legality for a between-drop is
`canDropOn(dragged, referenceRow.parentId)` being `ok` **or `noop`** — the noop case is the pure
reorder, and treating noop as illegal here is the mistake to avoid.

**And the refusal message needs a same-level branch regardless.** When the dragged node and the
hovered row are on the SAME level, "A Work Cell can only sit under a Line" answers a question the
admin did not ask. Until P1-5l ships it should read as what it is — an attempt to reorder that is not
supported yet — not as a lecture about levels.

#### Queue

**P1-5l jumps ahead of the P1-5k brief.** P1-5k re-levels a subtree that was built wrong; P1-5l fixes
a gesture every admin will try in their first minute, and it was found by using the product rather
than by reading it.

---

### 19.35 D95 — the whole row is the drag source (for a mouse), and levels get their drag WITH P1-5l (Aug 26, 2026)

Both from Pratik, immediately after D94: *"Can't we make the whole row draggable instead of just one
point?"* and *"When do levels get their own dragging?"*

#### D95a — yes for mouse, no for touch, and that split IS the design

A `⠿`-only hit target is a 1.375rem square in a row several inches wide. Widening it is right. But
the handle is not arbitrary, and the reason is already in the stylesheet:

```css
.dragHandle {
  cursor: grab;
  /* A touch drag must move the node, not scroll the page. */
  touch-action: none;
}
```

`touch-action: none` is what makes a touch drag move the node instead of scrolling. **Put that on the
whole row and there is no longer anywhere on the tree a finger can scroll from** — and the tree is
most of the admin page's area. (Checked: the only `overflow-y: auto` in this component is on
`.moveList`, the "Move to…" popover, so the scroller a touch drag would be fighting is the PAGE.)

So:

- **Mouse and pen: the whole `<li>` is the drag source.** `cursor: grab` moves onto `.row`.
- **Touch: the handle stays the only drag source**, keeping its `touch-action: none` while the rest
  of the row stays scrollable. `e.pointerType` is on the event already; this is a branch, not a
  second implementation.
- **`⠿` stays** — no longer the only hit area, but still the thing that tells you rows are draggable
  at all. Removing it would make the affordance invisible and undiscoverable on every device.
- **`closest("button")` guards the disclosure and `⋮`** so a pointerdown on either is a click, never
  a drag.

**And this costs the thing P1-5g was proud of.** §7.1 says *"a pointerdown on the handle is
unambiguously a drag start and no threshold logic exists to get wrong."* On a whole row that stops
being true: without a movement threshold every click on a row becomes a zero-length drag. So P1-5l
gains a **drag threshold predicate — ~4px, pure, in the shared module, mutation-tested**. Trading a
"nothing to get wrong" for a small testable thing is the right trade, but it must be made on purpose
and the brief has to say so rather than quietly inheriting the old sentence.

#### D95b — P1-5i ships WITH P1-5l, not after it

The honest state of play: Pratik asked for level dragging two sessions ago (*"this should also be
able to drag, don't you think?"*) and got **D92, D93, migration 0016 and a Save gate** instead. Every
one of those was worth having and none of them was the drag.

Merging them is not a favour, it is the cheaper build:

- **The level list is the EASY case.** A flat list, no re-parenting, no illegal targets, no cross-
  structure refusal — and **no server work at all**: `save_hierarchy_levels` already takes the whole
  ordered array with the index AS the position (D70), so a level drag is a pure draft edit. No
  migration, no `database.types.ts` regeneration. One new `{ kind: "moveTo", from, to }` beside
  `moveUp`/`moveDown` in `levelDraft.ts`.
- **P1-5j already built its safety net.** `findLevelOrderProblems` runs over the draft order, so a
  drag that produces an order stranding nodes already disables Save with the reason. The dangerous
  half of level dragging — the thing that made D92 — shipped this session.
- **⭐ And the sequencing argument is the real one: P1-5l CHANGES the pointer block** (threshold, and
  row bands for drop-between). Lifting the block into `LevelEditor` first and then changing it would
  mean editing two copies — **exactly what P1-5g's "keep the pointer mechanics in one liftable
  block" requirement (§7.1) exists to prevent.** Build it once, in its final shape, and use it in
  both places in the same build.

**Revised queue: P1-5l + P1-5i as one build → P1-5k's brief → P1-5h.** Nodes and levels both get
drag-to-reorder, with one set of pointer mechanics, one insertion caret, and one threshold.

---

### 19.36 Three parallel reviews, and what they found (Aug 26, 2026)

Pratik asked whether the design session could work in parallel. It can: three read-only Sonnet
agents ran concurrently on disjoint targets while the design session worked on migration 0017. All
three found something. Findings below are triaged, not quoted — a flagged deviation is a lead.

#### A. Adversarial review of P1-5j — the work the design session graded itself on

This closes a real hole in the process: `findLevelOrderProblems` was written, tested and
mutation-tested by the same session, which is precisely what verification-standard rule 2 exists to
forbid. A fresh reviewer was given the migration as the authority and told to hunt the
**stricter-than-server** direction specifically.

**It could not break it.** 38/38 cold; a **2401-probe** malformed sweep (the full cross product of
seven bad values in four argument positions) with zero throws; and no constructible input where the
client reports a problem `save_hierarchy_levels` would allow — including the `cl.template_id`-only
asymmetry it was pointed at, which it independently confirmed is mirrored correctly.

**Two silent gaps in the SUITE, though, both real:**

1. **No fixture ever gives a root `parentId: undefined`.** The code guards
   `=== null || === undefined`; deleting the `undefined` half passes all 38. No live bug — the
   direction is under-report, which is the safe one — but zero test pressure on a line a future
   "simplification" would remove.
2. **⭐ S12 is a vacuous case.** Deleting `if (templateId === null) return [];` outright changes
   nothing observable: every later comparison is `own.templateId !== templateId`, no real level has a
   null `templateId`, so the loop skips every node and still returns `[]`. **The guard is unreachable
   in the same sense as U1** — kept for clarity, not for behaviour — but the case reads as a real
   test and provides almost no kill pressure. **This is rule 3b landing on the design session's own
   suite**: a case whose name promises more than its fixture can deliver.

**Deliberately NOT fixed in this session.** Pratik has been handed a prediction of **491 tests in 17
files** and may already be running it; moving the count now would break the one thing that makes his
run self-verifying. Both go into P1-5l's build, which edits `levelDraft.test.ts` anyway for the
`moveTo` action.

#### B. Independent read of P1-5g's Part B — the half nobody could execute

`NodeTreeEditor.tsx` and its stylesheet were written from prose and shipped without ever running.
Reading them against §7 is the only check that exists, and the design session's own review had read
them for the *predicted* defect (pointer capture) rather than line by line against the spec.

1. **`releasePointerCapture` is never called.** §7.1 says *"Release capture, clear state."* Neither
   `handleDragPointerUp` nor `handleDragPointerCancel` takes the event, so the call is not merely
   omitted — it is inaccessible as written. **The corroborating tell: `DragState.pointerId` is
   written at drag start and never read anywhere in the file.** Dead state is the fingerprint of a
   dropped requirement. No user-visible symptom, because the Pointer Events spec has the UA release
   capture implicitly on `pointerup`/`pointercancel` — but the code now carries a field whose only
   purpose was the missing call.
2. **The Escape listener is keyed on the wrong dependency.** `useEffect(..., [drag])`, and `drag` is
   replaced with a fresh object on **every `pointermove`** — so a `window` keydown listener is torn
   down and reinstalled dozens of times a second for the length of every drag. Not a correctness
   bug (React runs cleanup and setup in the same commit, so no keystroke is missed) but exactly the
   "removed on the wrong dependency" shape. Should key on `drag !== null`.
3. Everything else in §7.1–§7.4 checks out, including two things the design session had asserted and
   this reviewer verified independently: the `pointer-events: none` on the chip really is what stops
   it becoming its own `elementFromPoint` hit, and `.dropOk` really does follow `.eligible` in
   source order, so the dashed hint really is suppressed on the chosen target.
4. It also names something §7 never wrote down: **the drag handle is keyboard-focusable and does
   nothing on Enter or Space.** That IS the accepted trade — the "Move to…" menu is the keyboard
   path, and P1-5g's non-goals say so — but §7 does not, so it reads as an oversight. Record it.

**Both defects land in the exact block D95a rewrites**, so they fold into P1-5l rather than being
patched twice.

#### C. P1-5h groundwork — and the headline is that the feature's premise does not exist

The roadmap has said for weeks that P1-5h is *"upsert-by-`external_id`"*. Measured:

**`nodes` has no `external_id` column.** Grepping every migration finds exactly two, both in
`20260821000002`: `operators.external_id` (with a real `unique (org_id, external_id)`) and
`products.external_id` (with **no** uniqueness constraint on it at all). Nothing anywhere writes to
either. So "upsert by external id" describes a target, not a mechanism, and **P1-5h needs its own
migration before any of its client work can mean anything.** Not folded into 0017 — a column with no
writer is exactly the kind of thing that drifts (see the `app.hierarchy_migration` hatch, unused
since 0010).

Four more facts a designer would otherwise have guessed at:

- **`create_node` is insert-only.** No update path, no `on conflict`, no batch variant. A re-import
  cannot use it for rows that already exist — it hits `path_collision` every time.
- **Parent-before-child is structural, not stylistic.** It fails in `create_node`'s own parent
  lookup before any trigger runs; a direct insert fails instead in `nodes_before_level`.
- **The BOM claim in the roadmap is half right.** `app_trim_ws` does strip `U+FEFF`, so a BOM cannot
  survive into a stored *name*. But it only ever runs on `p_name`. A BOM on the **header row's first
  cell** is a column-mapping problem no schema guard touches, and it is the parser's job.
- **A bulk import re-runs D85's exact path 5,000 times.** Every `create_node` ends in
  `INSERT … RETURNING`, which applies `nodes_select` to the fresh row; that is safe today only
  because migration 0013 restored the `app_is_admin() or` short-circuit. Design-plan §19.17 already
  named bulk import as the shape most likely to re-expose it, and this is the first measurement
  confirming the volume.
- An empty-string parent reference reaching a `uuid` cast raises a raw **`22P02`**, outside the
  twelve-code closed set.

#### What this says about running agents in parallel

Three concurrent read-only reviews on disjoint targets, no file contention, three real findings, and
the design session kept working throughout. **The constraint is not agent count — it is that the
review targets must be disjoint and read-only, and that briefs remain serial.** Two agents writing
to one file is the thing to avoid, which is also why P1-5l and P1-5i must stay one agent (D95b).

---

### 19.37 Migration 0017 — the three node-mobility RPCs, prototyped and measured (Aug 26, 2026)

All three exist and behave, on a scratch PG16 carrying all sixteen migrations and `seed.sql`, driven
as a real `authenticated` admin. Written here before the migration file is assembled, because the
decisions below were settled by running them, not by choosing them.

#### `place_node(p_node_id, p_new_parent_id, p_index)` — D94's fix

**It delegates every structural guard to `move_node` rather than restating one.** `move_node` already
carries seven: admin, org scope, unknown node, NULL-parent-only-at-position-0, self-parent, unknown
parent, descendant-cycle, level adjacency and path collision. `place_node` calls it and then
renumbers. Brief-writing rule 4's strongest form — *make the two things the SAME CALL* — and it shows
in the error output, where a refused place reports through the chain
`place_node → move_node → api_raise` with the existing code. Calling it when the parent is unchanged
is safe: that is a measured no-op.

**Dense renumbering, 0..n-1. No gap scheme.** Gaps (10, 20, 30) would let a later insert avoid
touching siblings, but every sibling in the database sits at `sort_order` 0 today, so the first
placement has to renumber regardless — and a gap scheme re-collapses and needs a rebalancer nobody
will maintain. Sibling counts here are small and this only ever rewrites one parent's children.
After the renumber every `sort_order` is distinct, so `compareSiblings`' name and id tiebreaks can
never fire again and the stored order becomes authoritative.

**The SOURCE parent is deliberately not renumbered** when the parent changes. Removing an element
does not change the relative order of the rest, so there is nothing to assert there — and the
destination is renumbered precisely because that is where an ordinal was asserted.

**`p_index` is clamped to `[0, n]`, and NULL coalesces to 0.** A drop can only produce an index in
range; refusing an out-of-range one would hand the caller a refusal with nothing useful to do about
it, and "before everything" / "after everything" are unambiguous.

Measured: **Pratik's exact case** — `place_node(Cell 3, Line 1, 1)` returns Cell 1 / Cell 3 / Cell 2
at `sort_order` 0/1/2 **with every `path` untouched**. Also measured: idempotent when repeated; clamps
at both ends; cross-parent placement works and leaves the source alone; zero adjacency violations
afterwards; NULL and unknown ids give `invalid_argument`; **an org-1 admin naming an org-2 node gets
`invalid_argument` "node not found"**; a supervisor gets `not_permitted` from `place_node`'s own check
before any delegation.

#### `promote_node(p_node_id)` / `demote_node(p_node_id, p_new_parent_id)` — P1-5k

Both are thin wrappers over one internal engine, **`app_relevel_subtree(p_node_id, p_new_parent_id,
p_delta)`**, so the escape hatch, the subtree capture and the two post-write checks exist exactly
once. Promote DERIVES its new parent (the grandparent, or NULL when the node becomes a root) and
passes `-1`; demote is GIVEN one and passes `+1`.

The order inside the engine is the part that matters, and each step was measured:

1. Admin, org scope, resolve the node.
2. **Capture the subtree ids BEFORE any write** — the re-parent rewrites every descendant's `path`,
   so a `path <@` predicate evaluated afterwards reads a different tree.
3. **Refuse up front if any distinct level in the subtree has no rung to land on.** This is the one
   that mattered: measured before the guard existed, a demote off the bottom of the template did not
   fail — the `position + 1` update matched zero rows, the parent change stood, and the tree was left
   with an adjacency violation, silently, because the hatch was on.
4. Hatch on, re-parent the one node, re-level the captured ids.
5. **Hatch off inside the function, before the checks** — the setting is transaction-scoped and
   nothing later should run unguarded.
6. Adjacency, both halves, **scoped to the captured subtree**. Every internal link is inside it; the
   only boundary is the moved node's own parent, which is checked on the moved node's own row.
7. Scheduled work, same scope: runs first, assignments only when the run count is zero (D72).

Measured, in order: a promote whose subtree holds a run and an assignment on the schedulable rung is
refused with **`schedulable_level_locked`, count 1** — the exact damage §19.33 recorded as silent.
**Move the work off first and the identical promote succeeds**: Line 1 becomes a Department, its two
cells become Lines, the paths rewrite to `plant_1.line_1.cell_1`, and adjacency violations are **0**.
That second half is what proves the check is a guard and not a lock-out. Promoting a root is refused
(`level_mismatch`); demoting off the bottom is refused before any write; demoting onto a node at the
wrong level is `level_mismatch`; demoting onto one's own descendant is `node_cycle`.

**No thirteenth error code.** All four refusals reuse `level_mismatch`, `node_cycle`,
`schedulable_level_locked` and `not_permitted`.

#### Still to do on 0017

Assemble the file, **with its own GRANT/REVOKE block covering all four new functions including
`app_relevel_subtree`** — D93 is exactly the trap of creating functions and granting only a table —
then the SQL cases and a mutation table, then `verify-db.sh` end to end.

---

### 19.38 D97 — the permission model Pratik asked for, and the three gaps between it and what exists (Aug 26, 2026)

Pratik, after approving the escape-hatch lock: *"there are certain tasks only an admin should be
able to do… there should be a system admin (all powers, any site), a site admin (changes only to a
particular site they belong), user/supervisor (assignments only, no access to admin page). We don't
want people lurking around where they have no knowledge or business."*

**A REQUIREMENT, not a question.** Recorded as such. What follows is what it collides with, measured
rather than read.

#### The reading of "site", stated because it changes the design

Today the tenant boundary is an **org**, and "Site" is also the name of the top LEVEL in the default
hierarchy (Site → Department → Line → Work Cell). "Site admin" is therefore ambiguous. Taking
*"a particular site they belong"* plus *"any site"* together, and given one company can hold several
plants in one org, this is read as **a Site NODE inside the org** — which is exactly what
`profile_grants` already points at. If he meant *org*, the shape below still holds but the grant
target changes; one sentence from him settles it.

#### What already exists, and it is more than expected

- **Three roles are already in the schema**, not two: `user_profiles.role check (role in
  ('admin','supervisor','viewer'))`. The app only ever uses two.
- **`profile_grants(profile_id, node_id, can_edit)` already exists** and is already load-bearing:
  `app_can_edit_node` is `app_is_admin() OR (app_can_write() AND EXISTS (SELECT 1 FROM
  app_grant_paths(true) gp WHERE n.path <@ gp))`. **That ltree containment IS site-scoping**, already
  wired into every node read and write. The machinery for a site admin is largely built.

#### Gap 1 — nothing hides the admin page. Measured.

**There is not one role check anywhere in the client.** `grep` for `profile.role` / `role ===` /
`isAdmin` across `src/` returns only the dev profile switcher. `/admin` is an ordinary route with no
guard, and the nav link is unconditional.

Measured as the seeded supervisor: the admin page's own read returns **1 structure, 4 levels and 8
nodes**. Writes are correctly refused (`create_node` → `not_permitted`), so nothing can be damaged —
but the entire hierarchy admin screen renders, populated, for someone with no business there. That is
precisely the complaint, and it is the cheapest thing on this page to fix.

#### Gap 2 — "site admin" has nowhere to attach. 94 call sites.

An admin today is all-or-nothing across the org, because **every admin function asks
`app_is_admin()` and stops**. `grep -c` across the migrations: **94 occurrences.** The grant
machinery that would scope them exists and is already correct; what does not exist is any admin
function consulting it. Adding a tier is therefore not a schema change so much as a change to the
question every one of those 94 places asks — from *"are you an admin?"* to *"are you an admin
**for this node**?"*

#### ⭐ Gap 3 — the system cannot tell which site you are acting in. This one is latent today and blocks the whole model.

```sql
create function app_current_org() ... as $$
  SELECT org_id FROM user_profiles WHERE user_id = (SELECT auth.uid()) LIMIT 1;
$$;
```

**`LIMIT 1` with no `ORDER BY`** — an arbitrary row tracking physical heap order. This is D87's exact
shape, in the function that every tenant check in the product depends on. And `app_is_admin()` has
**no org predicate at all**:

```sql
SELECT EXISTS (SELECT 1 FROM user_profiles WHERE user_id = (SELECT auth.uid()) AND role = 'admin');
```

so a user who is admin in one org and a supervisor in another is `app_is_admin() = true` in **both**.

Both are harmless today for one reason only: **every seeded person has exactly one profile.**
Verified by inserting a second profile for the Contoso admin in Northwind — the insert succeeds, and
from that moment which org they act in is undefined. **A system admin who spans sites is, by
definition, a person with more than one scope. The requirement cannot be built until "which scope am
I acting in" is an answer rather than a guess** — it is the first thing the design has to settle, and
it is a bigger change than the role tier itself.

#### Proposed order

1. **Lock the escape hatch** — approved, already folding into 0017. Free.
2. **Hide the admin page from non-admins** — client-only, small, closes the lurking complaint today
   and does not wait on any of the above. Route guard plus the nav link, off the role already on
   `useSession`'s profile.
3. **Design the three tiers properly**, starting with acting-scope, then the 94 call sites. Its own
   design section, then its own brief. This is foundational and should not be rushed into the drag
   work.
4. **The drag build continues in parallel** — it is an agent's build against a finished design, and
   the role work is the design session's. Genuinely concurrent, on disjoint files.

**Not deferred quietly: item 3 is the largest single piece of work now on the list**, larger than
P1-5k, because it touches every RLS policy and every admin RPC in the product.

---

### 19.39 D97 step 2 — the admin screen is admin-only. BUILT (Aug 26, 2026)

The cheap half of §19.38, done in full rather than sketched, because it closes the actual complaint
and waits on none of the foundational work.

**One predicate, `adminAccess(role, loading)` in `features/auth/session.ts`, beside
`canQueryAsUser`** — the module D91 created for exactly this reason. Two call sites depend on it
agreeing with itself: the nav link in `AppShell` and the route guard. **A nav link that disagrees
with its own route is how a user ends up staring at a link that refuses them.**

**THREE STATES, NOT A BOOLEAN, and that is the whole design.** `useSession` resolves the profile
asynchronously; `loading` starts true with no profile. A boolean has to answer *something* in that
window and both answers are wrong — `false` bounces a real admin who navigated straight to `/admin`,
`true` shows the screen to whoever turns out not to be one. **This is D91 one component over**: there,
gating a query without widening the render condition would have swapped seven console errors for a
blank card, because `enabled: false` leaves `isLoading` FALSE. The fix both times is to make the
unresolved state explicit instead of letting it collapse into one of the two answers.

**It fails closed on a role it does not recognise**, and case A8 pins it. `user_profiles.role` already
allows `admin | supervisor | viewer` and the tier model will add more; an old client must refuse
`site_admin` rather than decide a role with "admin" in the name is probably fine, because it has no
idea how to scope the screen. **`adminAccess` is the single place to widen when that lands.**

**The guard wraps the Suspense boundary, not the reverse**, so a non-admin never triggers the lazy
`AdminPage` chunk fetch at all — the refusal costs no download.

**This is a SECOND lock, not the lock.** The database is the authority and always was: every admin
RPC opens with `app_is_admin()`, and a supervisor's writes were already refused (`not_permitted`,
measured). This stops the screen being rendered to someone who cannot use it, and must never be
treated as though it were what keeps the data safe.

**Verification.** 11 cases (A1–A11), taking `session.test.ts` from 15 to 26 and the suite to a
predicted **502 in 17 files**. **9 mutations, all caught, 26 of 26 reporting on every run.** The pair
that earns its keep is A1/A2: a predicate written as
`role === "admin" ? "granted" : loading ? "pending" : "denied"` passes A1 and fails A2 — **M2 is
exactly that wrong ordering and A2 alone catches it.** `tsc -b --force` and `eslint src/` both clean.
**Rendered and looked at** (`docs/mockups/d97-admin-gate.png`): admin sees Board | Admin; supervisor
sees Board only, with the Admin link simply absent rather than present-and-dead; and a supervisor
typing `/admin` gets a plain "Not available" with a way back, inside the real shell — not a blank
page, not a crash, and not an alarming security notice for what is usually just the wrong bookmark.

Files: `session.ts`, `session.test.ts`, `RequireAdmin.tsx` (new), `routes.tsx`, `AppShell.tsx`.

---

### 19.40 D98 — multi-role is the same change as site-admin, and doing it naively opens a cross-tenant hole. MEASURED (Aug 26, 2026)

Pratik: *"a user can have multiple roles, for example a supervisor can be an admin as well, it is a
case by case basis, not every supervisor will be an admin."*

**A requirement.** And it turns out to be the SAME requirement as §19.38's site admin, not a second
one — plus it walks straight into a latent privilege escalation.

#### The two asks are one change

Today a role belongs to a PERSON: `user_profiles.role text check (role in
('admin','supervisor','viewer'))`, one value, with `unique (org_id, user_id)` — **one profile per
person per org, so a second role is not merely absent, it is forbidden by a constraint.** And the
roles are a LADDER: `app_can_write()` is `role in ('admin','supervisor')`, so admin implies
supervisor by construction.

Both asks dissolve if a role belongs to a **(person, scope)** pair instead:

| what he asked for | what it becomes |
| --- | --- |
| system admin | admin, scoped to the whole org |
| site admin | admin, scoped to one Site node's subtree |
| supervisor | supervisor, scoped to their nodes |
| "a supervisor who is also an admin" | two rows. Falls straight out. |

**And that table already exists.** `profile_grants(profile_id, node_id, can_edit)` is exactly the
(person, scope) table — `app_grant_paths` turns it into ltree paths and `n.path <@ gp` tests
containment, already wired into every node read and write. It carries a BOOLEAN where it needs a
ROLE. That is the shape of the change, and it is far less invention than it first looked.

#### ⭐ But first: a viewer in one org can write to it if they are an admin in another. MEASURED.

```sql
create function app_is_admin() ... $$
  SELECT EXISTS (SELECT 1 FROM user_profiles
                 WHERE user_id = (SELECT auth.uid()) AND role = 'admin');
$$;                                          -- NO org predicate

create function app_current_org() ... $$
  SELECT org_id FROM user_profiles WHERE user_id = (SELECT auth.uid()) LIMIT 1;
$$;                                          -- LIMIT 1, NO ORDER BY
```

Nearly every write policy is `app_is_admin() and org_id = app_current_org()`. The first term asks
*"are you an admin anywhere"*; the second asks *"which org am I in"* and answers with an arbitrary
row. **The two terms can therefore be satisfied by two DIFFERENT profiles.**

Constructed and run on the scratch database, as a real `authenticated` caller — a user given a
**viewer** profile in Northwind and an **admin** profile in Contoso:

```
 app_says_admin |        acting_in        | actual_role_there
----------------+-------------------------+-------------------
 t              | Northwind Manufacturing | viewer
```

and then `create_node(null,'Escalated',0,null)` **SUCCEEDED**, writing a root node into the org where
that person is a viewer.

**This is not currently exploitable**: it needs a person with two profiles, and nothing in the
product creates one — the seed never reuses a `user_id` across orgs, and no test in the repo
constructs it. **It is exactly the shape of D83**, which was invisible for weeks for the same reason
(one org in the seed, so no test could have caught it).

**The consequence for the plan is the whole point: the multi-role feature makes "a person with more
than one profile" the NORMAL case. The escalation must be closed BEFORE multi-role is switched on,
not alongside it.** `app_current_org()` has ~100 call sites and `app_is_admin()` 82; "which scope am
I acting in" has to become an answer rather than a guess, and that is the first piece of work.

#### Three more findings from the same survey, each of which would have cost a cycle

1. **`nodes_select`'s `app_is_admin() or` is load-bearing for a NON-permissions reason.** D85: it is
   the only term that answers without reading `nodes`, which is what lets `INSERT … RETURNING`
   see its own row. **A scoped admin check is by definition a table lookup.** Replace that term
   naively and `create_node` breaks for every scoped admin — the same outage, on a narrower and
   less-tested population. Case N1 in `70_hierarchy_test.sql` is the committed guard and must survive.
2. **The seed masks the very behaviour the tests appear to prove.** `seed.sql` gives each admin an
   explicit root `profile_grants` row, so admin writes to runs/assignments would still pass through
   the GRANT branch even if the `app_is_admin()` bypass were deleted. **No current test can
   distinguish "admin writes because of the bypass" from "admin writes because of the seeded
   grant"** — verification-standard rule 3 exactly, in the fixture that guards permissions.
3. **The client breaks first, and quietly.** `useSession` fetches the profile with
   `.eq("user_id", …).maybeSingle()` and **no org filter**. `maybeSingle()` errors on two rows, the
   error path sets `profile` to null, and the person becomes signed-in-but-role-less everywhere. It
   fails closed, which is right, but silently — and it triggers on the first person who holds two
   roles.

#### And what it means for `adminAccess`, built hours earlier (§19.39)

It takes one `role: string` and asks `role === "admin"`. Its docstring calls itself "the single place
to widen", and it was right that widening would be needed — but it anticipated a **bigger enum**, not
a **set of (role, scope) pairs**. Widening it is no longer adding a case; the input type changes.
Case A8's assertion will not survive, though **its intent — refuse a shape you do not recognise
rather than guess — is exactly what should carry forward.** Recorded rather than quietly patched: it
is a good example of a design that was correctly built to be extended and still needs replacing,
because the axis it will be extended along was not the one anticipated.

---

### 19.41 Migration 0017 — assembled, and the regression it caught in me (Aug 26, 2026)

`supabase/migrations/20260826000017_node_mobility.sql`, 427 lines: `place_node`,
`app_relevel_subtree` + `promote_node` + `demote_node`, the escape-hatch lock, and its own grant
block.

#### ⭐ The escape hatch turned out not to be needed at all

§19.33 designed P1-5k around `app.hierarchy_migration`, on the reasoning that a bulk re-level cannot
be done row by row. **Measured, that reasoning was wrong.** `nodes_before_level` fires per row and
compares that row to its **parent** only — it never looks down at children. So if each node is moved
*after* its parent already sits at its final level, every intermediate state is legal:

```
step 1  the moved node: new parent AND new level in ONE statement   -> trigger sees both, passes
step 2  descendants, shallowest first                               -> each parent is already final
```

Measured with the trigger fully armed and the hatch never set: a three-generation promote across 14
nodes, **0 adjacency violations**, paths cascaded correctly; and a demote in the other direction the
same. **The invariant is now enforced CONTINUOUSLY rather than suspended and re-checked**, which is
strictly safer — the post-write check drops from *the only thing standing between this and D92* to a
second opinion. And it is why locking the hatch costs nothing: **nothing in the product uses it.**

The lock itself: honoured only when `pg_has_role(current_user, <owner of nodes>, 'USAGE')` — no
hardcoded role name, so it works on Supabase (`postgres`) and in the harness (`ubuntu`) alike;
measured true for the owner, false for `authenticated` and `anon`. It **raises** rather than ignoring
the flag, so a caller cannot believe they bypassed the check and hit a confusing adjacency error
later.

#### ⭐ And it caught a real regression I introduced — by running the WHOLE suite

Assembling the trigger, I extracted its body programmatically from **0010** (rule 12: never
hand-retype a function to change part of it) — and 0010 is not where it lives. **0014's
`create or replace` is the live definition, because D86 added the TEMPLATE half of the rule there.**
Extracting 0010's body silently reverted D86: a node could be inserted under a parent in a *different
structure* whose position arithmetic happened to work.

**Nothing in my own 33-case probe would have found it.** The whole suite did: `T7` in
`90_hierarchy_template_test.sql` went from PASS to `caught=f`, and its own comment says it exists for
exactly this and is not a duplicate of the level cases. **This is decision-record-drift rule 3, hit
for the second time in this project** — the first was `create_node`, also re-created by a later
migration than the one that introduced it. The rule is written down, I applied the technique it
prescribes, and still took the body from the wrong file. **`grep -n "function <name>"` across ALL
migrations and take the LAST hit is not advice, it is a step.** 0017 now carries that warning inline.

#### N14 rewritten, N14b added

`N14` asserted that a plain `authenticated` caller could set the hatch and skip the level check —
true, deliberately removed, so the case now asserts the **refusal**. **N14b rescues the coverage N14
was legitimately providing** (the hatch works, and the path cascade still runs underneath it), moved
to the caller it is now reserved for: the owner. Same shape as L1/L1b when D92 landed.

#### Where it stands

- **`verify-db.sh` exit 0**, all 17 migrations apply cleanly from scratch, **108 named SQL cases**
  (70_ now 57, 90_ 31, 80_ 20).
- **33 of 33** on a purpose-built probe of the new functions: the reorder Pratik actually tried, path
  immutability, clamping both ends, all seven delegated guards, cross-org refusal, non-admin refusal,
  the stranded-work refusal and its repair, the up-front rung check, a three-generation promote, the
  hatch lock in all four directions, and all eight grant/revoke assertions.
- Two of those 33 failed on the first run and **both were my harness, not the code** — a malformed
  subquery and a grep that matched the wrong output line. Instrument failures #27 and #28.

#### ⚠️ NOT DONE, and it is the trap this project has been burned by

**Those 33 checks live in a scratch script, not in `supabase/tests/`.** That is exactly rule 11's
failure — a suite that ran once in a scratch container and vanished, leaving the most thoroughly
validated code as the only code with no committed guard. **The next step is to write them into the
committed suite and then mutation-test them**, not to move on. Nothing about 0017 should be called
verified until that is done.

---

### 19.42 Migration 0017 — finished. 33 committed cases, 16 mutations (Aug 26, 2026)

§19.41 ended with the checks living in a scratch script. They now live in
`supabase/tests/75_node_mobility_test.sql`, 617 lines, **33 cases (M1–M33)**, picked up automatically
by `verify-db.sh`'s `[1-9]*.sql` glob. **`verify-db.sh` exit 0; 141 named SQL cases** (70_ 57, 75_ 33,
80_ 20, 90_ 31).

#### The mutation table — 16 run, 13 caught, 3 executed and proved inert

| | mutation | verdict | case |
| --- | --- | --- | --- |
| X2 | siblings never renumbered | caught | M1 |
| X3 | the moved node is not spliced back in | caught | M3 |
| X4 | `move_node` delegation dropped | caught | M8 |
| X6 | the up-front rung check dropped | caught | **M17** |
| X7 | the scheduled-work check dropped | caught | **M11** |
| X8 | descendants updated deepest-first | caught | **M14** |
| X9 | subtree captured after the re-parent | caught | M11 |
| X10 | promote moves under the parent, not the grandparent | caught | M12 |
| X11 | demote's same-level check dropped | caught | M18 |
| X12 | demote's cycle check dropped | caught | M19 |
| X13 | the hatch lock removed | caught | M22 |
| X14 | the hatch lock inverted | caught | M24 |
| X16 | both revokes forgotten for one function | caught | M29 |

#### ⭐ X8 found a fixture that could not deliver what its case name promised

**M14 was named "a THREE-generation promote" and could not test the thing it existed for.** It
promoted Line 1, whose descendants are all Work Cells — **one depth band**. The loop that orders
descendants shallowest-first therefore had nothing to order, and reversing it to deepest-first was
**caught by nothing**. The entire justification for dropping the escape hatch is that ordering, and
it was untested.

Fixed by promoting **Assembly** instead: two bands of descendants (Lines, then Cells), which is the
minimum that can tell top-down from bottom-up. X8 is now caught by M14 alone. **And the case asserts
its own fixture depth** (`v_bands >= 2`) so it can never silently regress to the shallow version —
rule 3b's remedy, not just its diagnosis.

This is the third time the mutation run has found a hole in the case list rather than in the code
(P1-5g's M2, P1-5j's U3, now this), and the first time the hole was in the case protecting the
design's central claim.

#### Three executed and proved INERT — kept, with reasons

- **X1, the index clamp.** `least(greatest(...))` is behaviourally redundant: Postgres array slicing
  already clamps out-of-range bounds, so `v_ids[1:99]` and `v_ids[1:3]` are the same value, and
  `v_ids[1:-5]` is empty. **Kept as explicit intent** — the code should not depend on a reader
  knowing PG's slice semantics — but no case can distinguish it, and none should be invented to.
- **X5, `place_node`'s own admin check.** Removing it changes nothing because
  `perform move_node(...)` runs its own `app_is_admin()` immediately after and raises the same
  `not_permitted`. **Kept as a fail-fast guard**; genuinely redundant given the delegation.
- **X15, the `REVOKE … FROM PUBLIC` line.** Inert on its own because the `REVOKE ALL … FROM anon` in
  the DO block covers the same role. **The pair is belt-and-braces for each other, and X16 proves the
  pair is not vacuous** — removing both is caught by M29. Reporting only X15 would have read as a
  coverage hole; running X16 is what shows it is not.

#### Instrument failures this session

Two in the first probe run (a malformed subquery; a grep matching the wrong output line) and both
were the harness, not the code — **#27 and #28**. The mutation runner counts cases that REPORTED and
treats any drop from 33 as CRASHED, per #24.

---

### 19.43 Migration 0018 — the cross-company escalation, closed (Aug 26, 2026)

D98's security half, alone, in four function bodies. **No table changes, no policy changes, no RPC
signature changes.** It lands before anything switches multi-role on, and it is testable on its own.

#### What was wrong, in one line

Nearly every write policy is `app_is_admin() and org_id = app_current_org()`. The two terms ask
different questions of different rows — *"are you an admin ANYWHERE"* and *"which org am I in"*,
the latter answered by `LIMIT 1` with no `ORDER BY` — **so they can be satisfied by two different
profiles.** Measured: a user made viewer in Northwind and admin in Contoso created a node in
Northwind.

#### The fix, in two moves

1. **One acting profile, chosen deterministically.** `app_current_profile_id()` gains
   `ORDER BY org_id, id`. Which org a multi-profile user acts in is still a *default* rather than a
   choice — letting them choose is the next migration — but it is now stable and reproducible
   instead of tracking physical heap order, which is D87's exact shape in the function every tenant
   check depends on.
2. **Everything else DERIVES from that one profile.** `app_current_org()` is now
   `SELECT org_id FROM user_profiles WHERE id = app_current_profile_id()`, and `app_is_admin()` /
   `app_can_write()` ask about that profile rather than about the user. Two functions each running
   their own `LIMIT 1` could disagree about who you are *within a single statement*; deriving makes
   that impossible by construction rather than by both happening to sort the same way.

#### The trap that was flagged loudly and did not fire

`app_is_admin()` is the term in `nodes_select` that answers **without reading `nodes`** — the
property that lets `INSERT … RETURNING` see its own row, and whose loss killed `create_node` for
every caller in D85. The new body still never touches `nodes`; it reads `user_profiles`. **Case A8
exists to pin that**, and any future scoping of admin-ness that introduces a `nodes` lookup here
re-breaks D85.

#### Verification

`supabase/tests/45_acting_scope_test.sql`, **11 cases (A1–A11)**. **`verify-db.sh` exit 0, 18
migrations, 152 named SQL cases.** Five mutations, all caught.

**The fixture is the test.** Every multi-profile case has to build its own second profile, because
nothing in `seed.sql` creates one — which is precisely why the hole survived. And each of those
cases **asserts its own fixture first** (*they really are an admin somewhere*), or it would pass for
the wrong reason.

**A6–A10 are the regression half, and they are not padding.** A security fix that quietly breaks the
ordinary single-profile case is not a fix. **A10 is the one that matters most**: admin-here +
viewer-elsewhere must *still be able to write here*. A change that made every multi-profile user
powerless everywhere would pass A1 and be just as wrong.

#### ⭐ A mutation found a missing case, for the third time this session

Reverting **`app_can_write()`** to its unscoped form was **caught by nothing**. A2 covered
`app_is_admin` for the multi-profile case; A7 covered `app_can_write` for the single-profile case;
between them they left the one combination that matters uncovered. `app_can_write` gates every
subtree edit through `app_can_edit_node`, so *"can write anywhere"* is the same class of escalation
as *"admin anywhere"* — it just has one caller instead of eighty-two. **A11 is that case**, and Y4
is now caught by it alone.

The pattern across P1-5g's M2, P1-5j's U3, 0017's X8 and now this: **the mutation run keeps finding
holes in the case list, not bugs in the code.** Four for four. That is the argument for running it
every time, including — especially — when the code is believed correct.

#### Instrument failure #29

A4 used `min(uuid)`, which does not exist in Postgres (42883), and reported as a case failure rather
than as the harness bug it was. Same shape as #25: the message named a missing function, not a wrong
value.

#### What this does NOT do

It does not let a multi-site person choose which site they are acting for — they get the lowest
org_id. **That is the next migration and it is a feature, not a fix.** Until it lands, a genuine
system admin spanning two orgs can only act in one of them. Nobody is in that position today.

---

## §19.44 — Migration 0019: the (role, scope) permission model. Substrate only.

**Status: built, verified, mutated, delivered. Not yet run on Pratik's machine.**

### What Pratik asked for

> *"there should be a system admin (who has all the powers to affect anything at any site), a site
> admin (allowed to make changes only to a particular site they belong), user/supervisor (allowed to
> only do assignments, does not have access to admin page)… We don't want people lurking around
> where they have no knowledge or business."*
>
> *"a user can have multiple roles, for example, a supervisor can be an admin as well, it is a case
> by case basis, not every supervisor will be an admin."*

### The one idea

**A role stops being a property of a person and becomes a property of a (person, place) pair.**
`profile_grants` has carried `(profile_id, node_id)` since migration 0006 — it *already was* that
pair. The only thing it said about the pair was a boolean, `can_edit`. 0019 replaces that boolean
with **the role held there**.

| Who | How it is expressed |
|---|---|
| System admin | `user_profiles.role = 'admin'` — org-wide, unchanged |
| Site admin | a `profile_grants` row with `role = 'admin'` on a Site node |
| Supervisor | a `profile_grants` row with `role = 'supervisor'` |
| Viewer | a `profile_grants` row with `role = 'viewer'` |
| **Multiple roles** | **multiple rows.** Supervisor on Line 3 *and* admin on Plant 2 is two grants. That is the whole mechanism. |

**Why not a new table.** The primary key `(profile_id, node_id)` permits exactly one role per person
per node, and that is correct rather than a limitation: admin ⊇ supervisor ⊇ viewer at a single
node, so a second row on the *same* node could only ever be redundant with or dominated by the
first. Multiple roles are multiple **places**, which the existing key models exactly.

**Grants add power; they never subtract it.** Coverage is a union over every grant whose node is an
ancestor-or-self of the row, and the strongest wins. Admin on Plant 1 plus viewer on Line 3 makes
you an **admin** on Line 3. Anything else would make *"give this person read access to one line"*
silently demote a plant admin — a booby trap, not a feature. Case **S7** pins it.

### Scope, stated so 0020 is unambiguous

**In:** the column, the backfill, the predicates, `app_can_edit_node`, and the four `nodes` policies
— everything that decides *who is what, where*.

**Out:** the call-site sweep. Every node RPC still opens with `if not app_is_admin() then
api_raise('not_permitted')`, and every non-node policy still reads `app_is_admin() and org match`.
**A site admin therefore gains no new ability from this migration**: the substrate admits them, the
doors are still bolted. Case **S17** pins that on purpose, so 0020 has to rewrite it deliberately
rather than find it broken.

**Also out, and it matters:** the policies on `profile_grants` *itself* are untouched, so granting
stays org-wide-admin-only. Not an oversight — the safe order. If 0020 lets a site admin write
`profile_grants` without a subtree predicate, a site admin grants themselves `'admin'` on the root
and the whole model is decorative. **That is item 1 in 0020 and it gets its own escalation test, the
way D98 did.**

### The new predicates

| Function | Answers | Note |
|---|---|---|
| `app_grant_paths_for(text[])` | paths of my grants with these roles | the primitive; every other predicate is a phrasing of it |
| `app_grant_paths(boolean)` | 0008's signature, kept | `require_edit` → `admin, supervisor`. Unchanged callers keep working |
| `app_is_admin_on_path(ltree)` | admin over this **path**? | **takes a path, never reads `nodes`** — safe in an `INSERT … WITH CHECK` |
| `app_is_admin_for(uuid)` | admin over this **node**? | tenant-scoped internally, 0012's shape. **Not** safe in a WITH CHECK |
| `app_is_admin_anywhere()` | should I see the admin section at all? | **visibility only.** Never authorises a write — case S14 |

### D85 is dissolved, not dodged

0012 made `app_can_read_node` read `nodes`, and `create_node`'s `INSERT … RETURNING` returned zero
rows for everyone. 0013 rescued it by putting `app_is_admin()` **first** in `nodes_select` — an
admin-only term answerable from `user_profiles` alone, so admins short-circuit past the self-read.

**That fix had an expiry date, and this migration is it.** A site admin is not `app_is_admin()`. The
moment 0020 lets one create a node they fall through to the second term, hit the self-read, and get
D85's silent empty RETURNING — the exact failure, on the exact path, for the exact reason.

The real fix is to stop asking the table. `path` is a **column of the row under test**, populated by
a BEFORE trigger, so the policy reads it directly:

```sql
create policy nodes_select on nodes for select
  using (
    org_id = app_current_org()
    and (app_is_admin()
         or exists (select 1 from app_grant_paths(false) gp where nodes.path <@ gp))
  );
```

Measured before the migration was written: a supervisor ran `INSERT … RETURNING` under a policy of
this shape and got `PathTest | plant_1.assembly.line_1.pathtest` back. Case **S10** is the standing
version of that measurement, and mutation X5 (revert to the id-based self-read) is caught by it
alone.

### ⭐ A new finding: `level_mismatch` is standing in for `not_permitted`

Found while mutating this migration, not by reading it.

`nodes_check_level_adjacency()` is **SECURITY INVOKER** and resolves both the parent
(`from nodes pn where pn.id = new.parent_id`) and the level
(`from hierarchy_levels where id = new.level_id`) **as the caller**. For a site admin, anything
outside their grant is invisible, the lookup returns no row, and the trigger reports:

> `level_mismatch: node … level position is not exactly one below its parent's`

**Measured:** a system admin moving Line 1 under Machining succeeds (`plant_1.machining.line_1`); a
site admin of Assembly attempting the identical move gets `level_mismatch`. It is not a level
problem at all — it is an invisibility problem wearing a level problem's error code, from a closed
set of twelve the client switches on.

No move that *should* be allowed is refused by this (a destination inside the grant is by definition
visible), so it is a wrong-code defect, not a lockout. **It goes to 0020**, where `move_node` gains
an `app_is_admin_for(new parent)` pre-check that fires *before* the trigger.

**It also has a testing consequence, which is how it was found.** It **masks policy defects**: S11's
first draft moved a node to an invisible destination, the trigger refused it before the policy was
consulted, and a deliberately broken `WITH CHECK` (mutation X6) was caught by nothing. S11 now
straddles between two **visible** nodes — an admin grant on Line 1 and a *viewer* grant on Line 2 —
so the policy is the only thing that can say no.

### Verification

`scripts/verify-db.sh`: **171 named cases across 8 files, exit 0, zero `NOTICE: FAIL`**, plus the
new step 5b's 5 upgrade cases. `46_scoped_roles_test.sql` is 19 cases, S1–S19.

**The fixture is the test, and it is sharper here than in 45.** Every site admin in the file is given
the org-wide role **`'viewer'`**. That is not colour: if the fixture made them an org-wide `'admin'`,
`app_is_admin()` would be true and would short-circuit every predicate under test — all nineteen
cases would pass against a migration that did nothing at all.

#### Step 5b: the first migration whose *upgrade path* is tested

Every numbered test runs against a database where all migrations have already been applied to an
empty schema. **A migration whose job is to transform existing data therefore runs against zero rows
and is, in effect, untested.** 0019's backfill could have read `can_edit = true` as `'admin'` —
handing every existing subtree grantee the power to restructure the hierarchy, on the morning of the
upgrade, with a fully green suite. Mutation **X8** does exactly that, and before step 5b existed it
was caught by nothing.

`verify-db.sh` now builds a **second database**, stops at 0018, plants a fixture in the old shape
(one row per branch of the backfill's `CASE`), applies 0019 to it, and asserts the translation row
by row — `upgrade_0019_backfill.sql`, cases U0–U4. **This is the pattern for any future
data-transforming migration.**

#### Mutation table — 16 deliberate breakages, 15 caught

| # | Mutation | Verdict | Caught by |
|---|---|---|---|
| X1 | `app_grant_paths_for` ignores `p_roles` | caught | S5, S11, S15 |
| X2 | `app_is_admin_on_path` containment reversed | caught | S3, S7, S8, S9, S10, S11, S12 |
| X3 | `app_is_admin_for` drops its org predicate | caught | S6 |
| X4 | `app_is_admin_anywhere` authorises the write | caught | S13 |
| X5 | `nodes_select` reverts to the id-based self-read | caught | S10 |
| X6 | `nodes_update` WITH CHECK relaxed | caught | S11 |
| X7 | `nodes_update` USING relaxed | caught | S11, S15 |
| X8 | backfill over-promotes `can_edit = true` to `'admin'` | caught | U2, U4 |
| X9 | `app_grant_paths(true)` excludes admin grants | caught | S19 |
| X10 | `app_can_edit_node` reverts to its 0012 form | caught | S8 |
| X11 | role check constraint dropped | caught | S2 |
| X12 | `nodes_delete` stays system-admin-only | caught | S12 |
| X13 | supervisor grants treated as admin grants | caught | S5, S15 |
| X14 | `nodes_insert` drops its org term | caught | S18 |
| X15 | GRANT to `authenticated` removed, revoke kept | caught | S1 |
| X16 | REVOKE FROM PUBLIC removed, grant kept | **not caught** | — (reasoned below) |

**Three cases exist only because a mutation escaped.** S11's fixture was rebuilt (X6), S18 was
written (X14), S19 was written (X9). **Five for five** across P1-5g's M2, P1-5j's U3, 0017's X8,
0018's Y4 and now 0019 — the mutation run keeps finding holes in the *case list*, not bugs in the
code.

**X15 is worth its own line.** The first draft of the grant block was four bare
`grant execute … to authenticated` statements — **and deleting one changed nothing**, because
PostgreSQL grants EXECUTE on every new function to PUBLIC by default and `authenticated` is a member
of PUBLIC. The grants would have shipped as decoration. The **revoke** is the load-bearing half,
which is exactly the idiom 0009 and 0010 already use for every RPC; 0019 now matches it, and S1
catches the grant going missing.

**X16 is an accepted no-op, with a reason.** Removing `revoke … from public` leaves the function
reachable by PUBLIC — but the guarded block immediately below explicitly revokes it from `anon`, and
`authenticated` was going to get it anyway. It is defence in depth against a role that does not
exist in this project yet (a bare login role, a future `service_role`). Adding a test for a role
nobody has would be theatre; the line stays, the escape is recorded.

**S18 is structural, not behavioural, and that is a deliberate concession.** Two behavioural routes
at a cross-tenant insert were measured and *both* are refused before the policy is consulted, by the
adjacency trigger's invisibility (under a parent: the other org's node; as a root: the other org's
level). No query a client can issue distinguishes the org guard being present from it being absent.
That does not make it redundant — it is shadowed by an accident of the trigger's security mode, and
**0020 is likely to make that trigger SECURITY DEFINER precisely to fix the `level_mismatch`
confusion above.** The moment it does, the guard is the only thing between two tenants. Asserting
the policy *text* is the weakest thing that still catches someone deleting it.

### What has to happen on Pratik's machine

`npm run db:reset && npm run db:types`. **0019 changes `database.types.ts`** — four new functions and
`profile_grants.can_edit` → `profile_grants.role`. Nothing in `src/` reads `can_edit` (checked), so
no client code moves; the app suite should stay at **502 tests in 17 files**.

### 0020, in order

1. **`profile_grants` policies first.** A site admin must be able to grant *within their subtree*
   and must not be able to grant themselves admin on the root. Own escalation test, D98 shape.
2. **The RPC sweep.** 21 node-scoped call sites → `app_is_admin_for(...)`; 15 structure-scoped and
   38 org-wide keep `app_is_admin()`; 8 ambiguous (`node_skill_requirements`,
   `node_shift_templates`) need a decision. S17 gets rewritten here, on purpose.
3. **`nodes_check_level_adjacency` → SECURITY DEFINER**, plus an `app_is_admin_for(new parent)`
   pre-check in `move_node`, so a permission refusal says `not_permitted` and not `level_mismatch`.
   Note that this un-shadows the tenant guard S18 protects.
4. **The admin-page gate**, server and client: `app_is_admin_anywhere()` is the server half of D97's
   `adminAccess()`, which currently fails closed on anything that is not org-wide `'admin'` — so a
   site admin cannot see the admin page yet.

---

## §19.45 — Migration 0020: "each site is its own instance." IN PROGRESS.

**Status: SUPERSEDED BY §19.46 — 0020 IS FINISHED.** This section records §1–§7 and the plan for the rest; §19.46 records what §8–§12 actually became, including the two sections this plan did not have (§8.0, §8.5) and the one it asked for and did not get (§11). **Read §19.46 before acting on anything below.**

### The frame, in Pratik's words

> *"the system-admin or company-admin has access to all sites across the company and they basically can change whatever they want at any site, but the site-admin who are locked to the site can do whatever changes are needed for that particular site… It is like **each site could have their own instance for the app** so they're part of the larger system but only get to access their own site."*

That frame gives one test, and it decides every line: **can a site admin do this without touching another site?** If yes, it is theirs. The split is about **reach**, not about how much power to hand out.

### Two things he corrected

1. **Level vocabulary is a site admin's job**, not a company admin's. My §19.44 assumption was wrong.
2. **"Site admins can't create people" was the wrong conclusion** from a right worry. There are three separate things — a login (auth; no invite flow exists for anyone yet), a company membership row (which carries the company-admin flag), and access to a place. Only the flag is an escalation. The rule is *"a site admin cannot write the company-admin field"*, not *"a site admin cannot add people."*

### Two decisions asked and answered

- **The shared lists** (operators, products, skills, shift patterns) **get an owning site.** A site admin creates and edits their site's entries and cannot touch another site's; entries with no owning site stay company-admin. `operators.home_node_id` already exists and is the natural hook; the other three need a column each. **Its own migration, after this one.**
- **A new site gets its OWN COPY of a structure, chosen from existing shapes.** Not a shared reference.

### ⚠️ What blocked the level vocabulary, and it was not a permission problem

**A site's level wording does not live on the site.** It lives in a `hierarchy_templates` row, and **nothing had ever tied a template to a site** — `hierarchy_templates` has no node column and `nodes` has no template column (D86 chose that: a node's template is derived through its level). Two roots could quietly share one template, and a site admin renaming "Line" to "Cell Group" would have reshaped the other plant.

Measured before writing anything: every template in the database is used by exactly one root. Nobody is sharing. But *"happens to be 1:1"* is not an invariant, and the model needs one.

**§1–§3 make it one**: `hierarchy_templates.site_node_id` → the ROOT node, a partial unique index (one site, one structure), a composite `(org_id, site_node_id)` FK, and a trigger refusing any owner that is not a root. **Cost accepted knowingly**: a structure shared across several sites stops being expressible. "Roll this shape out to five plants" becomes a company-admin action that COPIES it into each — safer anyway, because they can then diverge.

### ⭐ The backfill CANNOT help a `db:reset`, and the first version of this shipped broken

`db:reset` (and `verify-db.sh`) apply every migration to an empty schema and only then run the seed. So at backfill time **there are no nodes**, nothing is claimed, and the statement is a no-op. **The first run left every template unowned — no site admin could have edited anything — and the entire numbered suite was green while it did.**

Ownership on a fresh database is therefore established by the **seed**, which now claims each template for its single root and then **raises if any template is left unowned**. The migration's backfill exists for exactly one path — a real upgrade of a populated database — and `upgrade_0020_site_ownership.sql` (V0–V4) is the only thing that exercises it.

This generalises: **any migration that transforms existing data is untested by a suite built from empty.** `verify-db.sh` now carries a table of upgrade checks (`UPGRADE_CHECKS`), each building its own database, applying migrations **stopping at** the one under test, planting a fixture in the old shape, applying that migration, and asserting. Add a row and a file that takes the migration path as `:mig`.

### ⭐ Three existing cases said the guard was in the wrong place, and they were right

Putting `app_is_admin_for_template` at the TOP of `save_hierarchy_levels`, `rename_hierarchy_template` and `delete_hierarchy_template` broke **T9, T10a and T18**: a mistyped or cross-tenant template id started answering `not_permitted` where it had answered `invalid_argument / not found`. The existence lookup is org-scoped, so cross-tenant callers still learn nothing either way — moving permission ahead of existence only made every typo in the caller's *own* org less informative. **The guard now sits immediately after the existence check**, and those three cases pin the ordering.

### ⭐ The harness nearly reported a pass over a failure for the fourth time

The generalised upgrade-check loop was first written as `echo "$UPGRADE_CHECKS" | while … done`. **A pipe makes the loop a subshell**, so every `note_fail` inside it would have set `FAILED=1` in a process that then exits — printing the failure and still exiting 0. Rewritten as a here-string. **Then deliberately broken (expected count 5 → 9) to confirm the script actually goes red: it does, exit 1.** See [[verify-db-harness-drift]].

### `scripts/mutate-migration.py`

The mutation discipline is now a committed tool rather than a scratch script rebuilt each session. It takes a migration and a JSON list of `[name, old, new]`, and for each one **builds a complete database from scratch** (harness + every migration with the target swapped + seed) and runs **every numbered test plus every upgrade check**. Rebuilding per mutation is the only honest way once a migration contains `ALTER TABLE` or `DROP POLICY`.

Its docstring states the rule this project learned the hard way: **`NOT CAUGHT` means either a missing case or an inert mutation, and which one it is must be WRITTEN DOWN.** A verdict with no explanation is a hole.

### Mutation table so far — 10 run, 3 caught, and that is the POINT

`supabase/tests/mutations/0020.json`. Run: `python3 scripts/mutate-migration.py supabase/migrations/20260826000020_site_ownership.sql supabase/tests/mutations/0020.json`

| # | Mutation | Verdict | Caught by |
|---|---|---|---|
| Z1 | backfill claims a SHARED template for one of its roots | caught | V2 |
| Z2 | `site_node_id` uniqueness dropped (a site owns two structures) | **not caught** | — |
| Z3 | a non-root may own a structure | caught | V4 |
| Z4 | `app_is_admin_for_template` drops its org predicate | **not caught** | — |
| Z5 | an UNOWNED structure becomes editable by any site admin | **not caught** | — |
| Z6 | `save_hierarchy_levels` reverts to company-admin-only | **not caught** | — |
| Z7 | `hierarchy_levels_update` loses its WITH CHECK scope | **not caught** | — |
| Z8 | `hierarchy_templates_insert` lets a site admin create unowned structures | **not caught** | — |
| Z9 | REVOKE FROM PUBLIC removed (grant kept) | **not caught** | — |
| Z10 | GRANT to authenticated removed (revoke kept) | caught | 41 cases died |

**Seven escapes, and not one of them is a surprise: `47_site_ownership_test.sql` DOES NOT EXIST YET.** This table is not a report card, it is the **specification for that file** — every "not caught" row names a case that has to be written. Z9/Z10 together prove the revoke/grant pair is load-bearing here in a way it was not in 0019 (the predicate is called from POLICIES, evaluated as the caller).

### What is left in 0020

1. **§8 — the node RPCs.** `create_node` / `rename_node` / `move_node` / `delete_node` / `place_node` / `promote_node` / `demote_node` still open with `if not app_is_admin()`. Each becomes node-scoped: admin for the node, and for `move`/`demote` for the NEW PARENT too; a parentless (root) operation stays company-admin. **Extract every body with `pg_get_functiondef` from the live database, never from the migration that first wrote it** — doc-drift rule 3 has bitten this project twice.
2. **§9 — `profile_grants` policies.** A site admin may grant within their admin scope and must NOT be able to grant themselves admin on the root. Own escalation test, D98 shape. `user_profiles` stays company-admin — that is where the company-admin flag lives.
3. **§10 — `create_node`'s root branch COPIES the chosen structure** into a new one owned by the new site (his answer above). Changes what `p_template_id` means: "the shape to copy from", not "the shape to use".
4. **§11 — `nodes_check_level_adjacency` → SECURITY DEFINER**, plus an `app_is_admin_for(new parent)` pre-check in `move_node`, so a permission refusal says `not_permitted` and not `level_mismatch` (§19.44). **Note this un-shadows the tenant guard that case S18 protects structurally** — after it, S18 can and should become behavioural.
5. **§12 — node-attachment policies**: `node_skill_requirements`, `node_shift_templates` → `app_is_admin_for(node_id)`. Safe in a WITH CHECK because `node_id` names an EXISTING row in a different table.
6. **`47_site_ownership_test.sql`**, driven by the escape list above, then a full mutation re-run with every verdict explained.

---

## §19.46 — Migration 0020 FINISHED: §8–§12, the two sections the plan did not have, and the one it asked for and did not get

**Status: built, verified, mutated, delivered. NOT yet run on Pratik's machine.**
`scripts/verify-db.sh`: **221 named cases across 9 files, exit 0, zero `NOTICE: FAIL`** (171 → 211 numbered, plus 10 upgrade cases). Mutation table: **35 run, 34 caught, 1 escape explained.**

### What §8–§12 do, in one table

`app_is_admin_for(node)` everywhere a node is named; `app_is_admin()` kept for the three operations that are not *inside* a site because they are operations *on* one.

| RPC | guard |
|---|---|
| `create_node`, no parent | `app_is_admin()` — it creates a SITE |
| `create_node`, with a parent | `app_is_admin_for(p_parent_id)` |
| `rename_node` | `app_is_admin_for(p_node_id)` — including a root, see §8.5 |
| `delete_node`, a root | `app_is_admin()` — and this covers `deactivate` too, which takes the subtree |
| `delete_node`, otherwise | `app_is_admin_for(p_node_id)` |
| `move_node`, source is a root | `app_is_admin()` |
| `move_node`, destination NULL | `app_is_admin()` — a parentless node IS a site |
| `move_node`, otherwise | `app_is_admin_for(source)` **and** `app_is_admin_for(destination)` |
| `place_node` | **no guard of its own** — `move_node` runs first (gotcha 17) |
| `promote_node` / `demote_node` | **no guard of their own** — `app_relevel_subtree` has the only copy |
| `app_relevel_subtree` | both ends; `app_is_admin()` when the destination is NULL |

**Both ends of every move, and it is not belt-and-braces.** A grant covers a subtree *downward*, so being admin for a node says nothing about being admin for that node's grandparent, which is *above* the grant. A source-only guard lets a department admin promote a line clean out of their department. Mutation **Z20** deletes the destination half alone and case **W25** is the only thing that catches it.

**Three guards were deliberately NOT written.** `place_node`, `promote_node` and `demote_node` carry none: a second copy of a check that always runs first cannot be mutation-tested — no case can distinguish deleting it from leaving it — and the honest response to an unfalsifiable guard is to remove it, not to keep it for comfort. **W22 and W26 exist to make those deletions safe rather than merely tidy**, by proving the remaining guard is reachable from every entry point (M30 in `75_` asserts `authenticated` can call `app_relevel_subtree` directly, so it is a public door whatever anyone intended).

### §8.0 — `app_node_exists_in_org`, and why "not found" had become a lie

Every node RPC opens with an org-scoped read of `nodes` **as the caller**. For a company admin an empty result really did mean "no such node". For a site admin it does not: everything outside their grant is invisible, so a real node in their own company read back as `invalid_argument / not found`. Same class of defect as §19.44's `level_mismatch` — a code from the closed twelve describing the wrong thing because a lookup could not see its subject.

One SECURITY DEFINER predicate, scoped to `app_current_org()`, separates the two. **The tenant boundary keeps its silence**: another company's node is still "not found", which is what T9/T10a/T18 protect. Case **W14** asserts all three arms, and the third arm is the one that matters.

#### ⭐ And the mutation run deleted the *second* helper, because its premise was false

`app_node_parent_in_org` was written so `promote_node` could read a node's **grandparent** with RLS out of the way, reasoning that a site admin whose grant sits ON the parent cannot see the grandparent, so an RLS read returns NULL — indistinguishable from "the parent is a root", silently turning a promote into a site create.

**Wrong, and only running it showed that.** The grandparent is not a row being read; it is the `parent_id` **column** of the parent's row, and the parent is necessarily visible to anyone who could name its child. *RLS filters rows; it does not blank out columns.* Measured side by side, both forms refuse identically (`not_permitted`). The helper is gone. This is [[decision-record-drift]] rule 6 applied to a rationale written twenty minutes earlier, and gotcha 17 applied to its own author.

### ⭐ §8.5 — a site admin could not rename their own site, and the policy refusing it was not the one anybody would look at

Not in the plan. Found by running §8, and it is the first thing a site admin would try.

```
site admin renames Line 1                        -> OK
site admin renames PLANT 1 ITSELF                -> "new row violates RLS policy for nodes"
department admin renames their own department    -> same refusal
```

**Why**: a grant is stored as a node id but *used* as a path (`app_grant_paths_for` joins to `nodes` and reads `n.path`). Renaming the grant node moves the whole scope — the new path `plant_one` is not `<@` the grant path `plant_1`, which the same statement has not yet published. Scope and row move together and the policy sees only one of them. D85's family.

#### ⭐⭐ The measurement that mattered, and it took four bisection runs

| what was opened | result |
|---|---|
| real UPDATE policy, cascade trigger disabled | FAILED |
| `nodes_update` opened to `with check (true)` | **FAILED** |
| `with check (true)` **+ open `nodes_select`** | OK |
| real UPDATE policy + open `nodes_select` | OK |

**AN UPDATE'S NEW ROW IS CHECKED AGAINST THE *SELECT* POLICY AS WELL AS THE UPDATE POLICY'S WITH CHECK.** A row you may edit but could not then see is refused — reported with `nodes_update`'s error message, naming a policy that is not the one saying no. **A fix applied to the obvious policy alone looks correct and changes nothing.** New gotcha 20.

#### The fix, and the hole the obvious version would have opened

- `app_is_admin_on_grant_node(uuid)` — answered from the grant's `node_id`, never from a path, so it survives a rename.
- Added to **both** `nodes_select` and `nodes_update`'s WITH CHECK, as `parent_id is null and app_is_admin_on_grant_node(id)`.
- `nodes_cascade_path` becomes SECURITY DEFINER: renaming a site rewrites every descendant's path, and that rewrite ran as the caller with every new path outside a grant still reading the old one. **The root row would pass and the cascade would fail.** Safe here in a way it was *not* safe for the adjacency trigger (§11 below): it decides nothing, maintains a derived column for rows whose triggering update was already authorised, carries its own tenant scope, and reads no session state — so there is no `current_user` for the security context to change the meaning of. `set search_path` added with it.

**`parent_id is null` is load-bearing and is not a heuristic.** A plain "or I hold a grant on this node" term also lets a mid-tree admin **re-parent** their grant node — Line 1 out of Plant 1 and into Plant 2 — by a direct table update. Measured: for that pair the level rungs line up and nothing else refuses. Restricting the term to parentless rows means it only ever applies to a node not being put anywhere, and *detaching* to reach it is refused independently by the adjacency trigger. **Case W23 has both arms**, because "it is safe because something else refuses first" is exactly the shadowing gotcha 18 keeps catching this project with, and mutation **Z24** was NOT CAUGHT until the re-parent arm existed.

**📌 Known limitation, recorded rather than left as folklore: a mid-tree admin still cannot rename the node their own grant sits on.** A site admin is unaffected (their grant is on the root, which W16 proves works). This bites a *department* admin renaming their department. Closing it means grants stopping being resolved through a mutable path — a schema change and its own migration; widening the term here reopens the re-parent hole. **Case W24 asserts the unwanted refusal on purpose**, so whoever fixes it has to delete that case deliberately, the way 0019's S17 had to be deleted by this migration.

### §9 — who may hand out access

`profile_grants` becomes node-scoped on all four commands; **`user_profiles` does not move.** Pratik's correction is the whole section: *"site admins can't create people"* was the wrong conclusion from a right worry — a login, a **company membership row** (which carries the company-admin flag) and **access to a place** are three things, and only the flag is an escalation.

`app_is_admin_for(node_id)` is safe in a WITH CHECK here because `node_id` names a row in a **different** table, committed before the statement began. D85 only bites a policy asking about its own row.

- **W28 is the escalation case**, both directions: upward (a department admin granting themselves admin on the plant) and sideways (a site admin granting themselves admin on another site). Direct table INSERTs, because that is the shape of the attack — there is no RPC to blame, only the policy.
- **W29 is the positive half**, and without it the section is one long refusal that a migration granting nothing would pass entirely.

**📌 Named cost, so it is a task and not a surprise:** `user_profiles_select` is still *own row, or company admin*, so a site admin can WRITE a grant for a person they cannot READ. Everything works — the FK resolves with RLS out of the way — but a UI cannot offer a person picker yet. That is `add_site_member`, the next RPC, where the reciprocal read gets designed rather than bolted on here.

### §10 — a new site gets its own COPY of a structure

`p_template_id` stops meaning *"the structure this root uses"* and starts meaning *"the structure to copy from"*.

**This is what makes §1 true, not a nicety.** `nodes` has no template column (D86) — a node's structure is reached through its level — so nothing stopped two roots being built on one template's position-0 level, and §1's unique index **cannot see that happen**, because such a create never touches `hierarchy_templates` at all. Before §10, "one site, one structure" was enforced against the only path that could not violate it.

Order: check the source has levels → create the template → copy every level *including `is_schedulable`* → create the root on the copy → **claim the copy for the root**. The claim cannot happen earlier: §1's composite FK points at a `nodes` row and §3 insists it be a root, which is exactly why `site_node_id` is nullable. The copy is named for the site, with a bounded suffix loop — `unique (org_id, name)` makes a collision a real path (**W36**), not defensive padding, and without the loop it raises a raw `23505` outside the twelve-code set.

`create_node` now returns `template_id` — the id of the **copy**, never of the source, so a caller cannot go on to edit the shape they copied from. Additive; `database.types.ts` types this as `Json` and does not change shape.

#### ⭐ It broke six existing cases, and every one had to be read before anything was touched

Rule 1b. None was pinning a bug; all six were the correct contract for 0015 and the contract deliberately changed. The coverage each provided was **rescued**, one indirection further along:

| case | was asserting | now asserts |
|---|---|---|
| T21 | both roots land ON the template each named | both land on a **copy of** the one each named, each copy owned by its own root, level names intact |
| T24 | an omitted `p_template_id` resolves the sole template | it still resolves — and the root gets a copy of it |
| T26 | a child lands on its parent's template | a child lands on its **parent's copy**, and makes no copy of its own (`template_id` is NULL) |
| T32 | with RLS bypassed, the root branch is org-scoped | the **copy** is org 1's and carries org 1's wording |
| L13 | a reorder stranding a lone ROOT is refused | same, against the structure the site actually owns — reordering the now-empty source strands nothing and the case would have passed for the wrong reason |
| L16 | a broken second template in the SAME org does not block this one | same, but scrambling **the copy**, which is what holds the nodes — otherwise the two org-vs-template mutations go quietly uncaught for the third time |

**L13 and L16 are rule 3b arriving on cases that were already correct.** Nobody changed them; the world moved and their fixtures stopped being able to deliver what their names claimed.

**S17 was rewritten on purpose**, which is what 0019 split itself in half to make possible: its old form asserted that a site admin who could write the `nodes` table still could not call `create_node`. It now asserts all three halves of §8's rule — inside the grant succeeds, elsewhere in the company says `not_permitted` (not "not found"), a root create says `not_permitted`.

### ⛔ §11 — the planned change this migration REFUSED to make

§19.44 ended with an instruction to itself: make `nodes_check_level_adjacency` SECURITY DEFINER so a site admin reaching an invisible destination stops getting `level_mismatch`.

**That instruction predates D97 and is now unsafe. Measured on a scratch PG16 carrying this exact migration:**

```
trigger as it ships (SECURITY INVOKER):
  set local role authenticated; set local app.hierarchy_migration='on';
  update nodes ...                          -> REFUSED   (D97 holding)
same trigger, altered to SECURITY DEFINER:
  identical statements                      -> ACCEPTED  (D97 BROKEN)
```

D97 gated the escape hatch on `pg_has_role(current_user, <owner of public.nodes>, 'USAGE')`. **Inside a SECURITY DEFINER function `current_user` IS the owner**, so the test becomes true for every caller and the hatch swings open for anyone signed in — undoing, as a side effect of fixing something else, the change Pratik asked for. `session_user` is not a repair either: under PostgREST it is `authenticator` and in this harness it is the superuser, so the test would disagree with production **in the direction that hides the hole**.

**The defect is fixed anyway, without touching the trigger.** The wrong code was only ever produced by a lookup that could not see its subject, and §8 answers the permission question *before* any such lookup runs — `move_node` step 4b, and `app_node_exists_in_org` at every existence check. Every route a client has is an RPC and every one now says `not_permitted` (**W17**, both arms). What remains is a direct `UPDATE nodes SET parent_id` aimed at an invisible parent, which `nodes_update`'s WITH CHECK refuses in the next breath.

**📌 Consequence, recorded rather than quietly dropped: 0019's case S18 STAYS STRUCTURAL.** §19.44 expected this migration to un-shadow the tenant guard on `nodes_insert`. It does not. Do not "upgrade" S18 without re-reading this. **W39 asserts both the behaviour and `prosecdef = false`**, so anyone later finishing §11 by flipping the flag meets a red test rather than nobody.

### §12 — what hangs off a node belongs to the node

`node_skill_requirements` and `node_shift_templates` → `app_is_admin_for(node_id)` on insert/update/delete; SELECT stays org-wide, because `nodes_select` is what decides visibility and a requirement row for an invisible node is a pair of ids resolving to nothing. **Both tables**, walked in W37 and W38 — D93's lesson is that a guard checking one member of a set will not tell you the migration forgot the set.

### `47_site_ownership_test.sql` — 40 cases, W0–W39

**Specified by a mutation run rather than written and then mutated.** With §1–§7 built and no test file, ten mutations were run and **seven escaped**; that list was the requirements document.

**The fixture is the test, and it needed TWO SITES IN ONE ORG**, which the seed does not have — org 1 seeds a single root, so "another site" and "another tenant" would be the same fixture, and a cross-tenant refusal proves nothing about a cross-site one because org scoping refuses it three layers earlier. Plant 2 is built through the real RPCs, so §10's copy is exercised by the fixture itself. Every site admin holds the org-wide role **`viewer`** (0019's lesson: an org-wide `admin` would short-circuit every predicate under test).

**W0 asserts the fixture**, per D86's corollary — an id typo is indistinguishable from the behaviour under test whenever the honest answer can be empty.

#### ⭐ Two fixture people exist because a mutation escaped, and both are the same lesson

1. **d3's supervisor grant on Machining.** A node a caller cannot SEE is already refused by §8.0's existence lookup, so a fixture where "not mine" always means "invisible" **cannot tell §8's own guards from that earlier refusal**. Measured: deleting `move_node`'s source check *and* its destination check were **both NOT CAUGHT**. A supervisor grant makes Machining visible and still not theirs — the only state those guards cover alone. W17 and W18 each gained a second arm.
2. **d5, admin on Line 1 + supervisor on Machining.** To reach §8.5's WITH CHECK term a caller needs an admin grant ON a node that can be legally re-parented somewhere they can see. Without one person holding both, **Z24 was caught by nothing**.

**This is the seventh consecutive migration where the mutation run found a hole in the CASE LIST rather than a bug in the code** — P1-5g's M2, P1-5j's U3, 0017's X8, 0018's Y4, 0019's X6/X9/X14, and now 0020's Z14/Z15/Z24.

### Mutation table — 35 run, 34 caught

`supabase/tests/mutations/0020.json`. Z1–Z10 are §1–§7's; Z11–Z35 are this session's.

| # | Mutation | Verdict | Caught by |
|---|---|---|---|
| Z1 | backfill claims a SHARED template for one of its roots | caught | V2 |
| Z2 | `site_node_id` uniqueness dropped | caught | W1 |
| Z3 | a non-root may own a structure | caught | V4, W2 |
| Z4 | `app_is_admin_for_template` drops its org predicate | caught | W3 |
| Z5 | an UNOWNED structure becomes editable by any site admin | caught | W4, W7, W8, W10 |
| Z6 | `save_hierarchy_levels` reverts to company-admin-only | caught | W6, W35 |
| Z7 | `hierarchy_levels_update` loses its WITH CHECK scope | caught | W8 |
| Z8 | `hierarchy_templates_insert` lets a site admin create unowned structures | caught | W9 |
| Z9 | REVOKE FROM PUBLIC removed | caught | W12 |
| Z10 | GRANT to `authenticated` removed | **CRASHED(140)** | 140 cases die — caught, loudly |
| Z11 | `create_node`'s CHILD check removed | caught | W27 |
| Z12 | a ROOT create stops being company-admin-only | caught | A1, S17, W15 |
| Z13 | `rename_node`'s check removed | caught | W27 |
| Z14 | `move_node`'s DESTINATION check removed | caught | W17 |
| Z15 | `move_node`'s SOURCE check removed | caught | W18 |
| Z16 | detaching a node into a site stops being company-admin-only | caught | W19 |
| Z17 | moving a SITE stops being company-admin-only | caught | W20 |
| Z18 | removing a SITE stops being company-admin-only | caught | W21 |
| Z19 | `delete_node`'s node check removed | caught | W27 |
| Z20 | `app_relevel_subtree`'s DESTINATION check removed | caught | W25 |
| Z21 | `app_relevel_subtree` reverts to company-admin-only | caught | W25, W26 |
| Z22 | `app_node_exists_in_org` drops its org scope | caught | C16–C18, M9, W14 |
| Z23 | `app_node_exists_in_org` bypassed entirely | caught | S17, W13, W14 |
| Z24 | `parent_id is null` dropped from `nodes_update`'s new term | caught | W23 |
| Z25 | the new term dropped from `nodes_select` | caught | W16 |
| Z26 | `nodes_cascade_path` back to SECURITY INVOKER | caught | W16 |
| Z27 | `profile_grants_insert` reverts to company-admin-only | caught | W29 |
| Z28 | `profile_grants_insert` loses the NODE scope | caught | W28 |
| Z29 | `profile_grants_update` loses its USING scope | **not caught** | — inert, measured below |
| Z30 | the copied structure is never claimed by its site | caught | T21, T24, W0, W34, W35 |
| Z31 | the copy loses the schedulable flag | caught | L13, W34, W35 |
| Z32 | the root is put on the SOURCE structure, not its copy | caught | L13, L16, T26, T32, W0, W7, W8, W10, W34 |
| Z33 | the copy's name-collision loop removed | caught | W36 |
| Z34 | `node_skill_requirements_insert` reverts to company-admin-only | caught | W37 |
| Z35 | `node_shift_templates_insert` loses its node scope | caught | W38 |

**Z10 is CRASHED, not NOT CAUGHT, and the distinction is the runner working.** Removing the grant kills 140 cases outright; the case *count* drops, which the runner scores as CRASHED rather than reading the absence of FAIL lines as "all clear". That counter exists because a dead server once scored as five clean passes (§19.29).

#### ⭐ Z29 is inert, and the measurement is what says so

`profile_grants_update`'s USING clause is **exactly shadowed by `profile_grants_select`**. Measured as a site admin: the number of rows they can SELECT that are neither their own nor inside their admin scope is **0**, and an `UPDATE ... WHERE profile_id <> me` touches only the three rows the USING clause would have permitted anyway. Every row the edit rule would refuse is already invisible.

**The clause stays.** It is the semantically correct place for an edit rule, and the read rule may legitimately widen later — letting people see who else is on their team is a reasonable future change, and it would silently un-guard UPDATE. **W30 now asserts the shadow itself** (`selectable-but-not-editable rows = 0`), which turns that future widening from a surprise into a red test pointing at this paragraph. Same treatment as 0019's X16 and S18: an escape with a reason and a tripwire, not an escape with a blank.

### What has to happen on Pratik's machine

`npm run db:reset && npm run db:types`. **0020 changes `database.types.ts`**: `hierarchy_templates` gains `site_node_id`, and four new functions appear (`app_is_admin_for_template`, `app_node_exists_in_org`, `app_is_admin_on_grant_node`, plus 0019's set). Nothing in `src/` reads any of them yet, so no client code moves — **the app suite should stay at 502 tests in 17 files.** A different number means a test file did not load.

---

## §19.47 — The admin-page gate: 0020 was unreachable through the product

**Status: built, typechecked, linted, delivered. Awaiting one `npm run test`.**

### The gap, and it is the "what does a user try first" question again

0020 gave a site admin the run of their own plant and `adminAccess()` still asked one thing: `role === "admin"`. That is `user_profiles.role`, the ORG-WIDE flag — and a site admin is an org-wide **`viewer`** carrying an `admin` GRANT. **Every door 0020 opened was behind a gate that denied all of them.** Nothing in the product changed when 0020 landed.

D97 wrote the gate's own expiry date into itself: *"`user_profiles.role` already allows admin | supervisor | viewer, and the three-tier model will add more. A client that has not been taught a new role must not decide it is probably fine — this function is the single place to widen when that lands."* This is that widening.

### No migration. The server half has existed since 0019

`app_is_admin_anywhere()` — `app_is_admin() OR exists(a grant with role 'admin')` — is exactly "should I see the admin section at all", is granted to `authenticated`, revoked from `anon`, and 0019's case **S14** pins that it never authorises a write.

### Where the answer is fetched, and why not a second query

`SessionProfile` gains `adminAnywhere`, fetched **inside `loadProfile`**, so ONE `loading` covers the profile and the probe together. A separate `useQuery` would add a second unresolved window for `adminAccess` to fold into `pending` — and **D91 is the standing reminder that `enabled: false` leaves `isLoading` FALSE**, which is precisely the fold that is easy to get silently wrong. The read is sequential rather than concurrent because the early return above it means a caller with no profile never fires it at all.

`fetchAdminAnywhere` (`src/lib/api/access.ts`) **fails CLOSED**: a PostgREST error resolves to `false`, not a throw. The only consumers are a nav link and a route guard, and the honest fallback for "could not ask" is "do not show it".

### The shape of the predicate

```ts
export function adminAccess(
  role: string | null | undefined,
  adminAnywhere: boolean | null | undefined,
  loading: boolean,
): AdminAccess {
  if (loading) return "pending";
  if (role === "admin") return "granted";
  return adminAnywhere === true ? "granted" : "denied";
}
```

**The role term is kept even though the server predicate subsumes it.** `app_is_admin_anywhere()` already answers true for a company admin, so this could be one line — it is two because the wrapper fails closed, and a company admin who cannot reach that RPC should still see their own admin screen from a profile they already hold. **Case A16 is what makes that a decision rather than dead weight.**

**`adminAnywhere === true`, not truthiness.** The value crosses a network boundary, so "truthy" would admit a `1` or a non-empty string a shape change started returning. **A17 is the only case that can tell the two apart** — measured: rewriting the term as `Boolean(adminAnywhere)` passes A12–A16 and fails A17 alone.

### Verification

Design-session probe under `--experimental-strip-types`: **19 assertions, 8 mutations, all 8 caught.**

| # | Mutation | Caught by |
|---|---|---|
| N1 | `loading` no longer dominates | G1–G4 |
| N2 | the site-admin term is dropped | G8, G9 |
| N3 | the company-admin term is dropped | G5–G7 |
| N4 | loose equality on the RPC result | **the malformed sweep only** |
| N5 | truthiness on the role instead of equality | G10, G11, G14 |
| N6 | `pending` collapses to `granted` | G1–G4 |
| N7 | `pending` collapses to `denied` | G1–G4 |
| N8 | the whole gate opens | G10–G12 |

**N4 is why A17 exists.** It fell to a 64-pair malformed sweep and to nothing else, so the committed suite would not have caught it — a sweep in a scratch harness is not a regression test. Rule 4's "record a clean sweep as a pass" has a corollary: **when the sweep is the ONLY thing that catches a mutation, the sweep has found a missing committed case.**

`node node_modules/typescript/lib/tsc.js -b --force` exit 0 and `node node_modules/eslint/bin/eslint.js .` exit 0, both on Pratik's machine. **Instrument-checked**: a deliberate 2-argument call was injected into `RequireAdmin.tsx`, `TS2554: Expected 3 arguments, but got 2` fired at the expected line, and the restore re-ran clean.

### A1–A11 gained an argument and kept their meaning

Each existing case now passes `adminAnywhere = false` — the value that leaves the ROLE term as the only thing that can decide — so all eleven still measure exactly what they were written to measure. `src/test/session.test.ts` goes **26 → 32 `it()`**, and the app suite **502 → 508 in 17 files**.

### 📌 Rough edge, named rather than left to be discovered

With the gate open, a site admin opening `/admin` sees the shape picker listing **every structure in the org**, because `hierarchy_templates_select` is deliberately org-wide (0020 §5, so a company admin can pick a shape to copy). Choosing another site's and saving gets a correct `not_permitted`, but that is a refusal where a filter belongs. **It goes with `add_site_member`, which is the next piece of screen work for a site admin, and it should be looked at on screen rather than reasoned about** ([[verification-standard]] rule 2c).

---

## §19.48 — P1-5l/P1-5i part A: the pure layer, and the three-band row that cannot exist

**Status: pure logic written, probed and mutation-tested in-container. NOT yet delivered to the repo — the React half is still to come, and these functions ship with it.**

### ⭐ D94's design is wrong in one specific way, and running it is what showed that

§19.34 specified the gesture as **three bands per row**: *"top/bottom row bands = place before/after as a sibling, middle = today's adopt"*, and left "the exact band fractions" as the thing to settle before a brief. The fractions do not need settling, because **a row can never offer all three zones at once.**

Adoption requires the dragged node to sit **one rung below the reference row**. A sibling slot requires it to sit one rung below the reference row's **parent** — that is, on the **same rung as the reference row**. Every node here sits exactly one rung below its parent, enforced by `nodes_check_level_adjacency`. The two demands are contradictory: a row is either a **peer** of the dragged node or a possible **home** for it, never both.

So every row is one of three things, and there is no fourth:

| the row is… | zones | the row is split |
|---|---|---|
| a peer of the dragged node | `before`, `after` | in half |
| a possible parent | `adopt` | not at all — the whole row |
| neither | none | it refuses |

**Case P7 proves this by exhaustion** over all 121 (dragged, reference) pairs in the fixture rather than by repeating the argument, because an argument is not a measurement and a future schema change could falsify it silently.

**It deleted two pieces of code I had already written.** The three-way band split (30/40/30), and the `offsetY` clamp — against a single 0.5 boundary a negative offset is already below it and an over-long one already above it, so clamping changes no answer. Both were mutation-tested, both came back `NOT CAUGHT`, and both were removed (gotcha 17). A `sort` over the returned zones went the same way. **Three unfalsifiable lines, one theorem.**

### ⭐ And `noop` is what makes a reorder LEGAL — the D94 bug in one line

`canDropOn(dragged, referenceRow.parentId)` returns `noop` **exactly when the dragged node already has that parent**, which is the definition of a pure reorder. `rowDropZones` therefore accepts `sibling.ok` outright — `noop` included. Adopt is the opposite: there, `noop` means "already a child of this row", which really does nothing, so adopt still requires `ok` and not `noop`. Mutation **P1** restores the old reading and is caught by six cases.

### Two things the fixture taught that reading would not have

1. **Roots are siblings of each other**, and `describeDrop` cannot express that at all — it takes a `string`, and a root's parent is `null`. `rowDropZones` calls `canDropOn` directly, which already takes `string | null` and already refuses a null parent for anything off level position 0. Reordering plants is a real (company-admin) operation; `place_node(node, NULL, i)` handles it. Cases D8/D9, mutation P8.
2. **A name collision at the destination blocks a sibling slot**, and my first cross-parent case tripped straight into one — both Lines in the fixture are called "Line 1", so `plant_1.packing.line_1` already existed and the case measured a `path_collision` while claiming to measure a level rule. Rule 3b, on a case I had just written. Re-fixtured, and the collision kept as its own case (D7b).

### The index handed to `place_node`

Counted among the destination parent's children **with the dragged node removed**, which is exactly the list `place_node` splices into. Taken from the **already-flattened rows**, not from re-sorting `nodes`: the index has to mean the same thing the admin just saw, and re-deriving the order here would be a second `compareSiblings` free to drift from the one that painted the screen. Collapsing hides descendants, never siblings, so a visible row's siblings are all present even in a collapsed tree (case D34).

### P1-5i: one new level action, and the off-by-one it exists to prevent

`{ kind: "moveTo", from, to }` in `levelDraft.ts`. **Splice out, then splice in** — removing the row first shifts later indices down by one, so `to` is read against the shortened array, which is what a caret means. Insert-then-remove makes a downward drag land one short; that is mutation **Q1**, and it is the classic bug in every list-reorder implementation. One action rather than a chain of adjacent swaps is the point: **case L12 asserts the new action equals the swap chain it replaces**, rather than against a second hand-written expectation.

The level list needs **no server work at all** — the array index IS the stored position (D70), there is no illegal target, and P1-5j's Save gate already refuses an order that would strand nodes.

### Verification

| | assertions | mutations | caught |
|---|---|---|---|
| `treeDrag.ts` (`rowDropZones`, `resolveDropZone`) | 36 | 16 | **16** |
| `levelDraft.ts` (`moveTo`) | 23 | 7 | **7** |

**Two instrument failures on the way, both mine.** A probe that indexed `zones(...)[0]` on a possibly-empty array **threw**, scoring a cleanly-caught mutation as `CRASHED` (instrument #17, again) — the helper now returns `"(no such zone)"` instead. And mutation **Q6** (`draft.slice()` for `cloneRows()`) came back `NOT CAUGHT` because a reposition mutates no row; rather than record an escape, **case L16 asserts the rows are copies**, which is the convention every other arm of that reducer already follows and the thing that would silently break the day someone adds a field edit to this arm.

### Rendered before writing any of this into a brief

`docs/mockups/p1-5l-drop-zones.png`, built against the real `NodeTreeEditor.module.css` + `tokens.css` + `global.css`. **Two rounds, and the first was wrong twice:**

- the caret was drawn at `-var(--row-pad-y) - 1px`, which is **inside the row above** — it read as that row's underline rather than as a seam between two rows;
- and the "place below" panel put the caret directly above the **dragged** row, which is where the node already was, so the picture showed a no-op. Rule 2c: a screenshot of the wrong state is as blind as no screenshot. Re-staged with three sibling Lines so the destination is somewhere the node is not.

The caret starts at the indent the dragged node will occupy and carries a knob there, so a caret at depth 3 cannot be read as one at depth 2.

**📌 And an expired decision record found in passing.** `NodeTreeEditor.module.css`'s `.dropTick` comment says the affordance is *"deliberately NOT a horizontal line BETWEEN two rows… P1-5g does not ship reordering, so a caret would promise an outcome the drop does not deliver."* That reasoning was correct and is now spent — P1-5l ships exactly that outcome. **The comment must be rewritten in the same change, or it becomes the third instance of [[decision-record-drift]] rule 6 in this project.**

### What is left

The React half: the ~4px pointer threshold, the whole-row drag source with `pointerType` branching (D95a), the caret element, and lifting the shared pointer block so `LevelEditor` and `NodeTreeEditor` do not each get a copy (D95b, and the reason these two ship as ONE build). That is an agent brief, and the verified fixture and CSS above splice into it verbatim.

---

## §19.49 — P1-5l/P1-5i part B built, and D99: a shipped affordance that was rendering into the wrong row

**Status: built by a Sonnet agent from `docs/agent-briefs/p1-5l-drag-to-reorder-brief.md`, reviewed independently, `tsc` and `eslint` exit 0 on Pratik's machine. NEEDS `npm run test` — predicted 580 in 18 files.**

### ⭐ D99 — the adopt tick has been rendering 4px into the NEXT row since P1-5g

Found by the build agent reading the geometry, then MEASURED in headless Chromium against this stylesheet:

```
.tree is a gapless flex column   ->  Line1.bottom == Line2.top == 604.89
.dropTick::after  bottom: -4px   ->  the tick's top edge is 4px INTO Line 2
```

**Why it happened, and it is a reference-frame error rather than a typo.** The `-1 * var(--row-pad-y)` idiom is *correct* where it came from: `.guideOn::before` hangs off `.guideOn`, a flex child stretched to the row's **content** box, so it must bleed by a padding to reach the row's outer edge. `.dropTick::after` hangs off `.row` itself, and an absolutely-positioned child is laid out against its ancestor's **padding box** — which for a border-less `.row` already starts at that outer edge. Copying the idiom across changed the reference frame silently.

**Why nobody saw it, and this is the reusable half.** P1-5g's render, P1-5g's review render, and my own P1-5l render all put the adopt target on the **last row**, where there is no next row to intrude on. Rule 2c already says *"choose demo states that can actually show the state you claim"* — this is that rule one level up: **the state that exposes a spacing bug is the one with a NEIGHBOUR**, and three consecutive renders picked a fixture that could not fail.

**And the first fix was also wrong, which the render caught immediately.** `bottom: 0` puts the tick exactly on the row's bottom edge — where `.dropOk` already paints a 2px inset ring in the same `--signal-ok`. **The tick vanished.** Same colour, same pixels, green suite either way; the D89 family, a defect made of absent contrast. Shipped value is `bottom: 0.125rem`, just inside the ring, rendered and looked at.

### The brief was wrong in four ways, all found by the agent

1. **§6's "verbatim" CSS would have turned `scaleAudit` red.** Seven raw pixel lengths (`7px` knob, `1px`/`3px`/`4px` offsets) in a file that is in `REM_SURFACES`. Only a border/outline ≤2px is exempt. The agent re-expressed the knob as `--caret-knob: 0.4375rem` and the offsets as `calc()` over it — which is the *point* of D84: a 7px dot that stays 7px at 4K is precisely what the audit exists to catch. **I pasted CSS I had rendered but never audited.**
2. **§6.1's code contradicted §6.1's own comment, and the comment was right (rule 17, again).** The comment says `-var(--row-pad-y)` *is* the seam and condemns adding `- 1px`; the pasted code then had `- 1px`. Both were wrong anyway for the reason in D99 above — against `.row` the seam is `0`. Measured: `Assembly.bottom == Line1.top == 122.30`, caret `top: 0px`.
3. **§6.3 does not survive contact with `LevelEditor.module.css`.** "The same two rules" assumes the tree's gapless column; `.list` there is a flex column with `gap: 0.375rem`, so the seam is a **band**, not an edge. The agent named the gap and centred the rule in it.
4. **§2.5's "no change to `place_node`" was true of the database and misleading about the client.** There was **no `placeNode` wrapper and no `usePlaceNode` hook anywhere in `src/`** — `place_node` appears only in migrations, `database.types.ts`, the SQL tests and this plan. A before/after drop has nothing to call. The agent added both, modelled on `moveNode`/`useMoveNode`, with a guard for the RPC's **array** return. Three files outside §3's table, each reported as a breach. **Rule 10 again: plan by property, not by file count.**

### ⭐ And it found a hole in the brief's own case list

The brief forbids a `thresholdPx <= 0` short-circuit because `Math.hypot` is never negative — I had proved that inert. The agent proved it inert far more thoroughly (**0 behavioural differences over 371,293 input tuples**) and then found the case I had missed: **written as the FIRST line, before the finite guards, the same branch is NOT inert** — it returns `true` for a non-finite origin whenever the threshold is ≤ 0, so an unmeasurable pointer starts a drag. No case combines a non-finite coordinate with a non-positive threshold. It did not add a 20th case (the brief pins the file at 19 and the branch is forbidden anyway) and flagged it instead. **That is the right call and the escape is recorded here rather than closed.**

### Verification

- Agent's own table: **7 mutations, all caught.** Collateral differed from my prediction in two rows (its T7 fixture also kills U1 and U2) — measured, not chased, exactly as rule 14 asks.
- **Independent review probe against the DELIVERED module** (not the agent's copy): **16 unprescribed assertions, all passing**, including subpixel thresholds, `-Infinity` at both ends, a NaN threshold, pointer-type casing and padding, and a **243-combination malformed sweep with zero throws**.
- `tsc -b --force` exit 0 and `eslint .` exit 0, re-run by the design session, not taken from the report.
- Counts re-derived independently: 18 test files, `dragPointer.test.ts` 19, `interaction.test.ts` 30, `treeDrag.test.ts` 79, `levelDraft.test.ts` 54, `session.test.ts` 32. **580 predicted.** The agent also caught that my brief said "17 files" while adding an eighteenth.

### Open, flagged by the agent, for the design session to decide

1. **A no-op caret is still drawn** — `rowDropZones` emits `after` on the row above the dragged node, whose index equals where it already is. Suppressing it needs a rule in the pure layer, which the agent was told not to edit.
2. **`.eligible` still means "legal adoption parent" only.** With reorder shipping, peer rows are destinations too and get no dashed hint.
3. **No touch drag on the level list** — no `⠿` handle was added there, and `rowIsDragSource` is fail-closed, so a finger gets the arrows. Consistent with D95a, but a real gap if touch reordering of levels was expected.
4. **StrictMode double-invocation**: the agent found P1-5g fires `move_node` twice per drop in development, because side effects sat inside a state updater. It moved both components to a `useRef` mirror with synchronous transitions. **A behaviour change to existing code the brief did not ask for** — judged in scope because §5.3 is about that review's findings. Worth a second look.
5. `src/test/treeDrag.test.ts`'s header still says *"43 plain `it()` cases"* while the file has 79 — the same expired-comment class as §6.2.

---

## §19.50 — The no-op caret: closing open item 1 of §19.49, and the second theorem about a row's zones

§19.49 left five items flagged. This closes the first. The other four are still open and still
listed there.

### The defect

`rowDropZones` offered a `before`/`after` placement on every legal sibling row, including the two
seams the dragged node is already sitting on. Concretely: dragging **Cell B** out of `[A, B, C]`,
the `after` half of **A** and the `before` half of **C** both resolve to index 1 — where B already
is. The user got a caret that promised a move, dropped, and nothing happened. Two dead zones per
drag, on every drag, on both surfaces.

It is not a rendering bug and it is not in the component. `place_node` splices the dragged node
into its siblings *with itself removed*, so the resulting order is unchanged exactly when

- the destination parent **is** the node's current parent, **and**
- the destination index **equals** the node's own position in the full sibling list.

That is a fact about the placement algebra, so the rule belongs in the pure layer — which is why
the agent was correct to flag it rather than fix it (its brief forbade editing `treeDrag.ts`).

### The rule as shipped

`siblingIndex` is called a second time, with `excludeId = null`, to get the dragged node's own
position in the *unfiltered* sibling list. The two indices are compared:

```ts
const currentIndex = siblingIndex(draggedId, reference.parentId, null, rows);
const isNoop = (i: number): boolean =>
  reference.parentId === (findNode(draggedId, nodes)?.parentId ?? null) && i === currentIndex;
```

The `excludeId` asymmetry is load-bearing and is the part most likely to be "simplified" later.
The reference index is computed with the dragged node **excluded**, because that is the list
`place_node` splices into. The current index is computed with it **included**, because that is
where it visibly sits now. Passing the same flag to both makes the rule silently wrong for every
reference row below the dragged node — and green, because the symmetric cases still pass.

The zone is **dropped, not flagged**. A flagged-but-present zone would give the row a dead half
that swallows a drop; dropping it lets the surviving placement take the whole row, which is
already exactly how an adopt-only row behaves. No new geometry, no new state.

### The second theorem

§19.48 recorded: *a row can never offer all three zones* (adopt requires the reference to be a
legal parent; sibling requires the reference's parent to be one; the level rules cannot admit
both at once). This adds a companion:

> **A placement that lands where the node already is offers nothing, and appears on exactly two
> rows per drag** — the row directly above the dragged node (as `after`) and the row directly
> below it (as `before`). They are the same seam approached from either side.

Together the two theorems bound the case space: a reference row emits 0, 1 or 2 zones, and the
"2" is never `{before, after, adopt}`. The test file asserts both as properties, not just as
examples.

### Verification

- **Probe: 41 assertions, all passing**, written in the design session and run against the file
  as delivered to Pratik's machine (re-staged and byte-compared to the delivered copy first, so
  this is the module that ships, not a local variant). Five of the 41 are new and are the rule
  itself — D35 the seam approached from above, D36 the same seam from below, D37 a real reorder
  keeping both zones, D38/D39 the same pair among *roots*. **D38's first draft measured nothing**:
  it used `n10`, the node with a missing level, which offers no zones at all, so the case would
  have passed against a deleted rule. A case name is a claim; that one was re-fixtured onto two
  real roots.
- **5 mutations, V1-V5, all CAUGHT** — run, not remembered, with the killing cases recorded:

  | # | breakage | verdict | killed by |
  |---|---|---|---|
  | V1 | the parent comparison is dropped, so any row at that index counts as the seam | CAUGHT | D3, D16, D17, D22, D32, D37 |
  | V2 | the after-seam is tested with the before-seam's index | CAUGHT | D1, D9, D13, D34, D35, D36, D38, D39 |
  | V3 | the current index EXCLUDES the dragged node (the `excludeId` asymmetry above) | CAUGHT | D13, D34, D36, D39 |
  | V4 | the guard is inverted, so *only* the no-op seam is offered | CAUGHT | D1, D3, D8, D9, D13, D15, D21, D23-D27, D31, D32, D34-D39 |
  | V5 | the rule is reverted for the after-seam only | CAUGHT | D1, D9, D35, D38 |

  **V3 is the one worth reading.** It is killed by exactly four cases -- D13, D34, D36, D39 --
  and every one of them puts the reference row *below* the dragged node. That is the measured
  proof of the asymmetry claim above: make both `siblingIndex` calls agree and the rule stays
  green for every reference row above the dragged node. Four cases stand between that mistake and
  a silent regression, and D34 (the collapsed tree) is one of them, which is not where anyone
  would look for it.

- **Committed cases**: `src/test/treeDrag.test.ts` 79 → 83. Four added (R37–R40) and **five
  existing cases updated**, because they asserted the old two-zone shape on rows adjacent to the
  dragged node. Those five were pinning the defect as the contract — a green case is a claim, and
  those claims were wrong.
- `tsc -b --force` exit 0. In-container vitest shim over the pure modules: 137 passed, 0 failed.
- Suite prediction moves **580 → 584 in 18 files**.

### Still open from §19.49

Items 2–5 are unchanged: `.eligible` still means "legal adoption parent" only and now under-hints
peer rows; no touch drag on the level list; the StrictMode change to existing code deserves a
second look; and `treeDrag.test.ts`'s header comment still says "43 cases".

---

## §19.51 — Migration 0021: the reciprocal read 0020 named, and the three pieces of code the mutation run deleted

**Status: written, applied and green on a scratch PG16 in the design session — 21 migrations, `48_site_membership_test.sql` 41 cases, 262 SQL cases total, cold, from scratch, twice. 32 mutations, 30 caught. `eslint .` exit 0. `tsc` has ONE error and it is the expected one — see "what Pratik owes" at the end.**

### What it is, in his frame

0020 settled that *"a site admin may add people to their site and set that person's role there"* and then left the sentence unusable, in a comment that named its own successor:

> `user_profiles_select` is still `own row, or company admin`, so a site admin can WRITE a grant for a person they cannot READ. … a UI cannot offer a person picker yet. That is `add_site_member`, the next RPC after this migration, and it is where the reciprocal read is designed rather than bolted on here.

0021 is that read, plus the two writes whose refusal would otherwise be silent, plus the shape-picker filter §19.47 flagged and left open.

### The read: a function, not a wider policy — and the reason is gotcha 21

The obvious move is to widen `user_profiles_select` so a site admin can see their colleagues. It is the wrong move, and **RLS filters rows, not columns** is why. A policy cannot hand out the email and withhold `user_profiles.role` — the company-wide admin flag — because a policy has no say over columns at all. A function chooses its projection explicitly. This is the same gotcha that deleted a helper in 0020, arriving from the opposite side: there it made a guard pointless, here it makes a policy the wrong instrument.

**The exposure is bounded by an ACTION, not by a standing privilege.** `site_people(p_node_id)` answers only for a node the caller already administers. Administering a place is what makes "who works here" your business. A caller who administers nothing gets `not_permitted` from all three functions, and `user_profiles_select` is untouched.

**People show as their email address**, because that is all the system knows: `user_profiles` has no name column and the seed sets `raw_user_meta_data` to `{}`. Worth saying out loud rather than discovering on screen.

### The writes: two, not four, and `docs/api.md` §4 decided it rather than me

> An RPC exists only where the operation needs to touch more than one row atomically, needs a pre-write permission check ahead of RLS to avoid a silent zero-row result, or is a pure read aggregation.

- `site_people` — pure read aggregation. RPC.
- `set_site_member` / `remove_site_member` — **a refused UPDATE or DELETE under RLS is zero rows and no error.** Plant 2's admin clicks "remove" on Plant 1's admin, gets a green tick, the row leaves the list, the refetch puts it back and nothing explains why. RPC.
- Everything else — a plain PostgREST write against the 0020 policies, like a run's `notes`.

Adding and re-roling are **one** function because they are one row: `profile_grants` is keyed `(profile_id, node_id)`.

**And the pre-check is not the duplicate-of-RLS that gotcha 17 condemns.** Delete it and the refusal still happens — as a raw `42501 new row violates row-level security policy`. The mutation is caught because *the shape of the refusal changes*, and case X16 asserts `PT403` and a typed detail rather than merely "it was refused" — which is green against the deletion.

### ⭐ The self-rule, and rule 17 catching me in my own file

A site admin who sets their own role on their own site to `viewer` loses the screen they are standing on and only a company admin can put it back. So the write functions refuse it.

**The first draft refused any change to your own row, and its own comment described a narrower rule** — that a change to a *different* node is fine. Two sentences apart, contradicting each other, exactly §19.49's item 2 in a file I had just written. The comment was right: adding yourself as a viewer somewhere inside your own site takes nothing away, because the strongest covering grant wins (0019) and your admin grant on the site above still decides. Refusing it would refuse a harmless thing with a frightening message.

Shipped rule: **only the row that currently grants you `admin` on THIS EXACT node is protected.** Cases X21 and X31 are the harmless changes that must be ALLOWED, and they are the cases the broad version fails.

### ⭐ Three pieces of code the mutation run deleted

Each of these was written with a plausible justification, and the run measured the justification to be false. Recorded the way 0020 recorded its deleted helper.

1. **`editable_shape_ids`' own `t.org_id = app_current_org()` term (Y3, NOT CAUGHT).** The argument was rule 10's: isolation cases run as the TABLE OWNER, where RLS is off and an org term is the only scope left. Measured, `app_is_admin_for_template` is SECURITY DEFINER and carries the org scope itself, refusing org 2's structure before the outer query sees the row. **X3 changed meaning rather than being deleted** — it now tests the composition with RLS off, which is a real property.

2. **`set_site_member`'s outcome check (Y27, NOT CAUGHT).** Rule 7b says read the row back rather than trust the statement, and D92 earned that rule. It does not apply here: the pre-check has already established `app_is_admin_for(p_node_id)`, and the INSERT WITH CHECK, UPDATE USING and UPDATE WITH CHECK are all that same predicate — so if any of them disagreed, RLS would **raise**, and 42501 is not something a read-back can improve.

3. **`remove_site_member`'s outcome check (Y33, NOT CAUGHT).** Same reasoning from the DELETE side, and it sharpens rule 7b into something more useful than "always read it back": **rule 7b is for writes that can do nothing QUIETLY, and what makes a refused removal loud here is the PRE-check, not a post-check.** That is the whole reason the function exists instead of a PostgREST `DELETE`, and X28 measures it — the typed refusal AND the row surviving.

The row read-back stays in `set_site_member`, without the raise, because the honest thing to return is what is stored rather than an echo of the argument.

### ⭐ Y12: inert, KEPT, and the impossibility pinned as its own case

`site_people`'s grant subquery carries `pg.org_id = v_org` and `gn.org_id = v_org`. Removing both was **NOT CAUGHT**. The terms are not pointless — 0012's lesson is that a path is unique only per `(org_id, path)`, so org 2 has its own `plant_1.assembly` and it *is* contained in `plant_1`. What masks it is a **foreign key in another migration**: `profile_grants` carries composite `(org_id, profile_id)` and `(org_id, node_id)` FKs, so the leaking row cannot be constructed.

Because the masking lives somewhere else, **case X39 asserts the impossibility directly** — as the table owner, an insert pairing org 1's person with org 2's node must fail with `23503`. Relax either FK and X39 goes red and points at this decision, instead of a cross-tenant leak appearing quietly. Same device 0020 §9 used for its shadowed UPDATE clause.

### ⭐ Y5b: a flaky case, caught by running it twice

The first version of X38 asserted `editable_shape_ids()` comes back ascending, and mutation Y5b (the `ORDER BY` removed entirely) came back **NOT CAUGHT on one run and CAUGHT on the next, with nothing changed between them.** Two of the three fixture structures get `gen_random_uuid()` ids, so the heap order is ascending by luck a good share of the time.

A fixture row with a deliberately low id was added to break the tie **and did not work** — the planner reuses free slots, so **physical order is not something a test may assume.** The row was removed again rather than left looking load-bearing.

The fix was to fix the *mutation*, not the fixture: `ORDER BY t.id DESC` is caught on every run at any size, and it is the shape a careless edit actually takes. Y5b stays in the table marked NOT CAUGHT and environment-dependent so nobody re-derives this.

### ⭐ Instrument failure 34: a TEMP table is not readable by `authenticated`

X16's first run reported `sqlstate=42501, detail=<NULL>` and read exactly like "the pre-check is missing, RLS refused instead" — which is the defect that case exists to catch. It was `permission denied for table x_fix`: a TEMP table belongs to the session user, and the case read the fixture id *after* `SET LOCAL ROLE authenticated`. **The RLS refusal and the temp-table refusal are the same SQLSTATE with the same empty DETAIL.** Every fixture read now happens before the role change, and X1 carries the note.

### The client half

- **`filterEditableShapes(summaries, editableIds)`** in `shapePicker.ts`, and **it fails OPEN** — the opposite call from `adminAccess`, which fails closed. The difference is what the answer buys: `adminAccess` decides whether a screen OPENS, so an unanswered question there must mean no. This decides only what a list OFFERS, and the server refuses every edit on its own (0020's W6/W7), so an unanswered question degrades to exactly the behaviour that shipped before — every structure listed, `not_permitted` on the ones that are not yours. Failing closed would hide a site admin's OWN structure the moment one RPC hiccups.
- `null`, `undefined` and anything that is not an array all mean "no answer". **F7 pins the specific failure the `Array.isArray` guard prevents**: `new Set("abc")` has three members, so a truthiness check would match single characters.
- `fetchHierarchyTree` calls `editable_shape_ids()` **in the same `Promise.all`, not a second `useQuery`** — §19.47's lesson, and D91's reminder that `enabled: false` leaves `isLoading` FALSE. One read, one spinner. It is the only one of the four that does not throw on error, and the asymmetry is the point: the other three are the screen's content, this is a preview.
- `AdminPage` filters **before** `resolveSelectedShape`, so the selection can never land on a structure the list no longer shows.

### Verification

- **41 cases in `48_site_membership_test.sql`**, green cold twice. 262 SQL cases in total across 21 migrations, `verify-db.sh` exit 0.
- **32 mutations, 30 caught.** The two NOT CAUGHT are Y5b (environment-dependent, above) and Y12 (inert, kept, X39 pins the masking). Three further mutations have no entry because **the code they broke was deleted** — Y3, Y27, Y33.
- **No `UPGRADE_CHECKS` row and no `upgrade_0021_*.sql`, deliberately**: 0021 adds no column, table, policy or trigger and transforms no existing data. Stated in the migration header so the absence is a decision rather than an omission.
- Client: `eslint .` exit 0. `src/test/shapePicker.test.ts` 34 → 45 cases (F1–F11). **Suite prediction 584 → 595, still 18 files.**
- **`tsc -b --force` exits 2 with exactly one error**, `TS2345` on `supabase.rpc("editable_shape_ids")` — `database.types.ts` does not know the function yet. It goes away with `npm run db:types` and nothing else in the tree is affected. (**Instrument 35**: `tsc … | head` reports *head's* exit code, not tsc's — it printed the error and reported `exit=0`. Redirect to a file, echo `$?`, then read.)
- **In-container vitest shim over the pure modules, run against the files as delivered: 190 passed, 0 failed** (`treeDrag` 83, `levelDraft` 54, `shapePicker` 53). The shim implements only the matchers these files use, grepped not guessed — `shapePicker.test.ts` uses `.toBe` and nothing else.

### What is NOT verified, stated as work (rule 5)

1. **The wire shape of `editable_shape_ids()` through PostgREST has not been exercised.** The function returns `jsonb`, and the client reads `editableRes.data` as an array of strings — the same shape `board_window` establishes for a jsonb-returning RPC. There is no PostgREST in this container, so this is reasoning from precedent, not a measurement. **The first thing to check when the screen is wired up**; `filterEditableShapes` fails open on anything that is not an array, so the failure mode is "no filtering", not a crash.
2. **`site_people`, `set_site_member` and `remove_site_member` have no client caller at all yet**, so their jsonb shapes are unexercised outside SQL. That is stage 10's work.
3. **Nothing here has been seen on screen.** The shape picker's filter changes what a real admin sees and has not been rendered (rule 2c). It should be, with a site-admin session, before it is called done.

### What Pratik owes, in order

1. `npm run db:reset && npm run db:types` — applies 0021 and regenerates the types, which is what clears the single `tsc` error.
2. `npm run test` → **595 in 18 files**.
3. One commit for everything since `055300c`.

---

## §19.52 — P1-6a "Who can get in": the first screen in this app that shows a person

**Status: built. Pure layer written and mutation-tested by the design session; the panel, its stylesheet and the hooks built by a Sonnet agent from `docs/agent-briefs/p1-6a-site-access-panel-brief.md` and reviewed independently. `tsc -b --force` exit 0 and `eslint .` exit 0, both re-run by the design session rather than taken from the agent's report. NEEDS `npm run test` — predicted 652 in 19 files.**

### What it is

0021 made "a site admin may add people to their site" true and reachable from a client. It had no screen, and neither did anything else: **measured, the app had no UI anywhere that showed a person's name or address** — the only `display_name` in the product is `operators`, a scheduling resource. This is the first.

The panel scopes to the site that owns the currently selected structure. `fetchHierarchyTree` gained a `siteNodeIds` map for that — **a separate map rather than a field on `HierarchyTemplateSummary`, because that type is shared with `create_hierarchy_template` and `rename_hierarchy_template`, whose payloads carry no `site_node_id`.** Adding a required field there would make two parsers reject every response they have ever received; an optional one would make "absent" and "unowned" the same value.

### The split, again, and it held

Same shape as §19.48/§19.49: **the design session writes and breaks the rules; an agent builds the screen from a brief.** The pure layer is `src/features/admin/lib/siteAccess.ts` — `buildAccessRows`, `partitionAccess`, `allowedRoles`, `canRemoveAccess`, `removalNote`, `describeAccess`, `matchesQuery`, `accessPanelState` — and the brief forbids editing it.

The rule the whole panel turns on: **`AccessRow` splits `directRole` (the grant on THIS node, the only one this screen can edit) from `inheritedGrants` (further down the subtree, real access, not editable here).** Collapsing the two is the most likely bug in the module, and **case A5 is the only one that catches it** — the person holding a grant on this node *and* one below. A3 and A4 are both green against a collapse.

### ⭐ Instrument 36: twenty-eight mutations "NOT CAUGHT" at once

The first run of the mutation table reported **every one of 28 as NOT CAUGHT**, against a suite that was green. The runner decided the verdict by parsing failure names with `line.startswith("FAIL ")` — and the shim prints `  FAIL <name>` with two leading spaces, so the list was always empty.

This is rule 6's standing signal in its loudest possible form: *when several mutations go NOT CAUGHT at once, suspect the instrument before the table.* Twenty-eight at once is not a result. The fix is also the general one: **the verdict is the COUNT the runner reports, not the list it managed to parse** — names are for the table, the number is for the decision.

### The two escapes that survived a working runner

- **B9 — the `nodeId === null ? undefined : …` guard, deleted.** It was written so that a payload with no node makes every grant inherited and none direct. That behaviour is real and A16 still pins it; the guard was not what produced it. `parseGrant` only admits a grant whose `nodeId` is a string, so `find` against `null` cannot match either way. Gotcha 17: a second copy of a check that always holds cannot be mutation-tested.
- **B27 — `asString` coercing instead of dropping, NOT CAUGHT because no fixture had a non-string address.** Every address in the fixture was a real string or already `null`, so the coercion had nothing to bite. **Case A49 added**: a numeric address must become `null`, never the text "12345" beside a person's row. An address the screen invented is worse than a blank one.

### ⭐ C4 rewritten: a case whose name claimed more than it guarded

C4 was named *"no place beats a FALSE loading flag — the D91 trap"*. The mutation that swaps those branches (B29) is caught by **C5**, not by C4: with a disabled query `peopleLoading` is false, so both branch orders answer `"no-place"` and C4 cannot tell them apart. It was rule 3b sitting in a case I had just written.

Rewritten to guard what it can: **a null place is never `"ready"`, whatever the loading flags say** — swept over both — which is the mutation that actually ships the D91 bug (B33, added). An unasked query resolving to `"ready"` renders an empty list of colleagues as though the company had nobody in it.

### ⭐ Rule 0 earning its place again

`node --experimental-strip-types` was green on `A30`'s third clause, `s !== v`. `tsc` rejected it: **TS2367, a comparison between two string literal types that provably cannot overlap.** The compiler proved an assertion inert before any run did. Removed, with the reason in the case.

### The brief was wrong, and the agent found it

**§7 said adding the new stylesheet to `REM_SURFACES` was "one line, and the suite fails without it". It is two.** `src/test/scaleAudit.test.ts`'s case **R10** hardcodes the exact list of admin stylesheets, so the mandated entry turns R10 red the moment it lands. That file was in neither §2's forbidden table nor §3's file list. The agent found it, fixed it the way that file's own comment prescribes (*"Adding a sixth admin surface means updating this literal AND nothing else"*), and reported it. **That is the fourth brief in a row with a real error in it, and the fourth time the agent found it.**

Verified independently that this changed no case count: `scaleAudit.test.ts` has 28 static `it(` plus one `it.each` over `CHROME_FILES`, which is a hardcoded five-file list containing nothing under `src/features/admin`. 28 + 5 = 33, unchanged.

### ⭐ Two findings from LOOKING at it, which no suite could have produced

Rendered in headless Chromium from the **real** module — the row data is computed by importing `siteAccess.ts` and running it, not by re-implementing it — with the real stylesheet, real tokens and real `global.css` inlined.

1. **The company-admin row printed the same sentence twice.** `describeAccess` said *"Company admin — reaches every plant"* and `removalNote` said *"Company admins reach every plant; there's no access here to take away."* — side by side, two columns apart. The note's only job is to explain the ABSENT button; the reason is already on the row. Shortened to *"Nothing to take away here."*, and **A37 now asserts the note is not equal to `describeAccess`'s output**, so the duplication cannot come back.
2. **People with no address on file vanish from every search with nothing said.** That is `matchesQuery`'s correct behaviour and A43 pins it — an address is the only thing that can be typed for. But on screen it is the same failure `skipped` is reported to avoid one line up. The panel now counts them and says so.

Neither is visible to a passing suite. Both took one screenshot.

### Verification

- **`siteAccess.test.ts`: 57 cases, green.** In-container shim over the real modules: **247 passed, 0 failed** (`treeDrag` 83, `levelDraft` 54, `shapePicker` 53, `siteAccess` 57).
- **32 mutations, all 32 caught** — after the instrument fix, and after the two escapes above were closed by deleting one guard and adding one case.
- `tsc -b --force` exit 0, `eslint .` exit 0, both re-run by the design session. The agent's own instrument-check produced `TS2741` at the expected call site.
- Scale audit re-run by the design session against the real files: 6 `REM_SURFACES` entries, **zero** unscaled pixel lengths, **zero** admin stylesheets on disk missing from the list, control font reset present. (My first probe passed the repo root to `missingControlFontReset`, which takes the file CONTENTS, and got a false positive naming all four controls — instrument caution, corrected before reading anything into it.)
- Changed files re-derived from mtimes rather than from the report: exactly the eleven expected, nothing else.
- **Suite prediction 595 → 652, and 18 files → 19.**

### Open, flagged, not closed

1. **A department admin gets `"no-place"`.** A structure is owned by a ROOT (0020 §1), so somebody who administers a department administers no structure and this panel has nothing to be about. Correct today, named in 0021 §7, and it needs a real answer eventually — most likely `site_people` being reachable for any node the caller administers, which the RPC already supports.
2. **The role control renders the raw enum text** (`admin` / `supervisor` / `viewer`, lower case). Fine, but it is the only place in the product showing a database value unformatted.
3. **Nothing here has been seen against a real Supabase.** The wire shapes of all four RPCs are still reasoning from precedent — `site_people`'s payload most of all, since `buildAccessRows` is written against the shape the SQL tests assert rather than against a response anyone has received.

---

## §19.53 — The demo cast, an id collision that broke two orgs, and the panel that had no control of its own

Two defects, both found by Pratik in the running app within minutes of each other, and the first is the worst thing I have shipped in this project.

### ⭐⭐ D100 — `dev_demo.sql` hijacked org 2's two accounts

The script created its two site admins at `00000000-…-0000000000b1` and `…b2`. **Those ids are not free**: `seed.sql` hands them to org 2's company admin and to Sofia. What followed was silent at every step:

1. `INSERT INTO auth.users (id, email) … ON CONFLICT (id) DO NOTHING` — did **nothing**, because the rows existed.
2. The GoTrue credentials `UPDATE`, keyed by those ids, then **renamed org 2's admin to `dana@example.test`** and Sofia to `quinn@example.test`, and set both passwords to the dev one.
3. The `user_profiles` insert hung a **second, org-1 profile** off each of those accounts.

`user_profiles` is unique on `(org_id, user_id)`, **not** on `user_id`, so step 3 is perfectly legal. The damage surfaced two layers away: `user_profiles_select` admits a row on `user_id = auth.uid()`, so signing in returned **two** rows, and `loadProfile` reads that with **`.maybeSingle()`, which errors on more than one row**. The session therefore had *no profile at all* — no Admin link for anybody, and a board that told a site admin holding a grant that they "may not have a grant on any node".

**Why my own assertions missed it.** The script asserted its own properties — two plants, two structures, Dana runs Plant 1, both org-wide viewers — and every one of them was **true**. Not one of them asked whether the ids had belonged to somebody else first. *The demo was internally consistent and externally destructive.*

Three things changed:

- New ids (`…dec1`/`…dec2`, `dec00000-…`), chosen after **enumerating every id `seed.sql` uses** rather than assuming.
- **A precondition that refuses to run**: if either auth id exists with any other email, the script raises and names it. Measured — squatting an id produces `dev_demo refuses to run: … is already someone.else@example.test`.
- **The assertion whose absence let it ship**: no demo account may hold a profile in more than one org. Counting the demo's own rows could never have seen this; counting rows *per account* does.

**The general lesson, and it is rule 3's in a new place: an id you did not verify is free is a fixture that can pass every check while overwriting somebody.** The seed's id space is a shared resource and this file is the first thing to write into it from outside.

### D101 — the Access panel was scoped by a control on a different tab

"Where is Plant 1?" The panel derived its site from `resolvedShapeId`, which is owned by the **structure picker on the Hierarchy tab**. A company admin standing on the Access tab was shown whichever plant that other tab happened to have selected, with no control and nothing on screen explaining why.

The panel now owns its selection: `resolvePlace(places, selectedId)` in the pure layer (same falls-back-never-sticks shape as `resolveSelectedShape`, and the same reason — a selection pointing at a place you no longer administer must fall back rather than ask the server about something it will refuse). `AdminPage` builds the list from the structures the viewer may edit, **named by the SITE that owns each** rather than by the structure: an admin is looking for "Plant 2", not "Standard Plant". The picker renders only when there is more than one — a site admin administers one plant, and a one-item dropdown answers nothing.

### Also this round

- **Uniform button widths.** `Remove`/`Add`/`Remove`/`Cancel` were each as wide as their own label, so the right edge of the list zig-zagged. One `min-width` set from the longest label.
- **`ON CONFLICT` on `auth.identities` lost its column target.** That constraint is GoTrue's, not this project's, and it has been renamed across versions; naming columns infers a constraint that may not exist on the reader's Supabase. A bare `DO NOTHING` works against any of them — and this file cannot be tested against a real Supabase from the design container, which is exactly when to prefer the portable form.

### Verification

- `siteAccess.test.ts` **57 → 72 cases**; **38 mutations, all 38 caught**.
- `tsc -b --force` exit 0, `eslint .` exit 0, scale audit clean (6 surfaces, zero unscaled px, nothing unlisted).
- The corrected `dev_demo.sql` run twice on a fresh database: org 2's two accounts **intact**, every demo account holding **exactly one** profile, Dana 13 visible nodes and one shape, Quinn 5 and a different one, `app_is_admin_anywhere()` true for both.
- **Suite prediction 652 → 667, still 19 files.**

### D102 — the panel was a list of flex rows, so it had no columns at all

*"The data and columns should be presented in a structural manner; buttons and text in weird locations doesn't look professional."* Reported from the running app, and correct.

Every row was a flex container sizing its own children from its own content, so the description, the role control and the action each landed at a different x on every line. Nothing was misaligned by a bug — there were simply **no columns**, only twelve independent rows that happened to contain similar things.

Rebuilt on **one grid template declared once and used by both the header and every row**: two `fr` tracks for the person and their access, then two FIXED tracks for the role control and the action. Fixed on purpose — a control that sizes to its own label is what made the right-hand edge zig-zag, and `width: 100%` inside a fixed track makes every select and every button identical whether it offers three roles or one.

Two things fell out of the rebuild that are worth recording:

- **Anything that cannot fit a column takes its own full-width line**: the explanation of a missing button, the error, the remove confirmation. The first attempt put the note in the 6.5rem action column, where *"You can't take away your own admin access here."* wrapped to four lines.
- **The plant picker reused `.select` and stretched across the whole card**, because that class is now a grid item sized to fill column 3. It sits outside the grid and needed its own rule. Visible the instant the grid landed, and invisible to every test — the same class of finding as the two in §19.52, and the third and fourth time on this screen that a render has been the only thing that could see the defect.

`describeAccess` is now rendered for candidates too. It reads "No access", which is true, and it stops column 2 being a hole that made the two lists look like different tables.

No test changes: the grid is layout, and the pure layer was untouched. `tsc` exit 0, `eslint` exit 0, scale audit clean — six surfaces, zero unscaled pixel lengths.

---

## §19.54 — Migration 0022: a company admin's row is not a site admin's to edit

**Status: applied and green. `verify-db.sh` exit 0, 22 migrations, `49_company_admin_rows_test.sql` 9 cases, 271 SQL cases in total, cold. 8 mutations, all 8 caught. Client mirror: `siteAccess.test.ts` 72 → 79, 44 mutations all caught. `tsc` and `eslint` exit 0. NEEDS `npm run test` — predicted 674 in 19 files.**

*"I logged in as Dana and I have ability to remove the company admin, this is a very big issue."*

### Measured before deciding the size of the fix

```
site admin removes the company admin's grant on Plant 1 -> ALLOWED, row deleted
the company admin immediately afterwards
    app_is_admin       = true
    admin_for(Plant 1) = true
    nodes visible      = 18 / 18
```

**Not an escalation, and it took nothing away.** A company admin's authority is `user_profiles.role`, and 0020 §9 keeps that field company-admin-only — a site admin cannot write it. The grant they could delete is redundant for that person.

Answering that honestly mattered more than fixing it quickly. It is still wrong, for three reasons:

1. **A role inversion** — the person with less authority editing the record of the person with more. Harmless *today* only because of a fact in a different table, which is the exact shape that becomes a hole when the model changes.
2. **It lies.** The button appears to remove a company admin's access and removes nothing; only the row's wording moves.
3. If that person ever loses the org-wide flag, a grant a site admin silently deleted is gone.

### ⭐ The server was fixed first, and the order is the whole point

The cheap fix was to hide the button. That would have **broken the invariant this entire feature rests on**, stated in `shapePicker.ts` and again in `siteAccess.ts`: *anything the client hides, the server must also refuse; never the converse.* A client that hides a permitted action is a feature nobody can reach — the same failure as `filterEditableShapes` failing closed, which §19.51 rejected for the same reason.

So: `app_profile_is_company_admin` (the third of 0020 §8.0's family — org-scoped, boolean, grants nothing, because a site admin cannot SELECT `user_profiles` at all), and one guard in each write RPC. **Both bodies were extracted from the LIVE database with `pg_get_functiondef`** and edited by string replacement with a uniqueness assertion, never retyped (rule 12).

`NOT app_is_admin()` is half the condition and **X43/X44/G3/G4 are why**: a guard keyed only on the target's flag stops two company admins being peers, and one keyed only on the caller refuses everybody and breaks the whole screen. Mutations Z3 and Z4 are those two mistakes; both caught.

### Where the guard sits, and the case that proves it

`remove_site_member` checks it **after** "there is nothing here to remove" and **before** the self-rule. **X45 is the only state that can tell those apart**: a company admin who holds no grant on the node, so both rules are live at once. The absent row is the truer sentence — putting the new guard first answers "you may not edit that person" about a row that is not there, sending an admin to argue about permissions over a typo. Mutation Z7 swaps them; caught by X45 alone.

### ⭐ The gap this does NOT close, asserted rather than left to be found

`profile_grants`' RLS is untouched, so a caller reaching **PostgREST directly** can still delete a company admin's grant on a node they administer — 0020 §9's policy asks only `app_is_admin_for(node_id)`. The guard is on the RPCs, which is where the screen goes.

That is a choice, not an oversight: putting it in the policy means `profile_grants_delete` reading `user_profiles`, and a policy that delegates into another table's contents is precisely what verification rule 9 warns about — it greps clean and inherits every hole of the thing it reads. **Case X46 asserts the gap directly**, the way 0020's W24 asserts its unwanted refusal: whoever closes it deletes that case deliberately.

### The client half, and one case the first run killed

`protectedRow` folds into `canRemoveAccess`, plus a new `canSetRole` — **separate from `allowedRoles` on purpose**: one decides whether the control belongs on the row at all, the other narrows which options it offers. A control showing one option and writing nothing is worse than no control, because it looks live.

**G5**: the two company-admin rows do NOT get the same sentence. One genuinely has nothing to take away; the other *has* something and the viewer is simply not the person who may touch it. Saying "nothing" to the second would be the same lie the button told.

**G7 started as an ordering assertion and the first run killed it.** It claimed the protection outranks the self-rule; `removalReason` answers `"self"`, because `selfLocked` is checked first. Both refuse, so nothing unsafe turns on the order — and the state it described (a row that is both *you* and a company admin, seen by a viewer who is not one) is a contradiction: if that row is you and it is a company admin, you are one. Reachable only as a transient artefact while the session's own profile resolves. Pinning an arbitrary order on an input nobody can produce deliberately is rule 3b's trap; rewritten to assert **the property** — a protected row is never editable and never without an explanation — swept over every combination.

### ⭐ Rule 0, twice now, and the pattern is clear

`tsc` rejected `withGrant !== without` as **TS2367**: two string literal types that provably cannot overlap. That is the second "so it cannot come back" inequality in this file to turn out vacuous — A30 was the first. **Once both sides narrow to literals the compiler has already proved the claim**, and writing it costs a red build rather than buying coverage. `node --experimental-strip-types` was green on both.

### Verification

- `49_company_admin_rows_test.sql` **9 cases**; 271 SQL cases total across 22 migrations, cold, `verify-db.sh` exit 0.
- **8 mutations, all 8 caught.** Z3 was caught by 48's **X36** rather than 49's own X44 — the two files were already covering the same property from opposite sides, which is the good kind of redundancy.
- Client: `siteAccess.test.ts` 72 → **79 cases**, **44 mutations, all 44 caught**.
- `tsc -b --force` exit 0, `eslint .` exit 0, scale audit clean.
- **No `UPGRADE_CHECKS` row and no `upgrade_0022_*.sql`**: no column, table, policy or trigger, and nothing transformed. Stated in the migration header.
- **Suite prediction 667 → 674, still 19 files.**

---

## §19.55 — "Why show people if they're not assigned to a plant?" — adding becomes an action

Not a bug report. A design question, and the right one:

> *"Shouldn't Quinn not be visible here at all since he's not assigned to Plant 1? Why show people if they're not assigned to a plant? What is the idea?"*

**The idea was sound and the shape was wrong.** That list is the pool you add *from* — it is the entire reason 0021 exists, because 0020 gave a site admin the power to grant access and then left them unable to SEE anybody to grant it to (0020 §9's own words: *"a UI cannot offer a person picker yet"*). Quinn appeared because he is addable, not because he is associated with Plant 1.

**But a standing list of everyone in the company, sitting under the people who actually have access, asserts a relationship that does not exist.** It reads as "these people are somehow associated with this plant" when the only thing true of them is that they work here. In a real company it also buries the member list under hundreds of strangers.

The member list is the screen. **Adding is an action**, and an action's subject appears when you go looking for it. `partitionAccess` now returns candidates only for a non-blank query; the section below the members reads *"Search above by email address to give someone access to Plant 1."* until somebody searches.

Three things fall out of that:

- **It retires 0021 §3's unbounded-list limit** in the place that was actually hurting. A company of ten thousand no longer renders ten thousand rows, because nothing renders until a query narrows it. The server still returns everyone, and the honest place to bound *that* remains `site_people` with a documented limit — not a client that quietly drops people.
- **One box, two questions.** Blank: "who can get in here". Typed: that, plus "who could I add". A second search box for the picker would have been clutter, and `.trim()` decides both "does this match everyone" and "is this a search at all", so the two can never disagree about a box cleared to spaces (A44c).
- **A44 was rewritten, not deleted** — rule 1b-ii. It asserted that a blank query lists every candidate, which was the correct contract for the shape that shipped first. A44b is the other half: a rule that returned candidates *never* would pass A44 and destroy the only reason the screen exists.

### And one more thing the render caught

An empty `Has access (0)` still printed its column header — a table pretending to have rows. Both headers are now hidden when their list is empty, with a sentence in their place that distinguishes *"nobody has access yet"* from *"nobody with access matches this search"*. **Fifth defect on this screen found by looking at it rather than by running anything.**

### Verification

- `siteAccess.test.ts` 79 → **81 cases** (A44 rewritten, A44b/A44c added). **48 mutations, all 48 caught**, including the two that matter here: candidates returning with no search (B50, the shape Pratik rejected) and candidates never returning at all (B51, the feature deleted).
- `tsc -b --force` exit 0, `eslint .` exit 0, scale audit clean.
- **Suite prediction 674 → 676, still 19 files.**

---

## §19.56 — P1-6e: the grip, and the bug that was hiding behind it

Pratik put this first and called it "capability first". Two claims were already
proved before this session started and they stayed separate all the way
through: **the level drag is wired, and its target is unhittable.** What was
*not* proved was correctness — nothing had ever driven the gesture.

### The affordance

Measured before, by hit-testing every pixel of a rendered row with the
component's own guard: **21 px of 526 on the row's centre line**, three 7 px
flex gutters, no handle, and `cursor: grab` nowhere. The only cursor that
changed anywhere on the row was `pointer`, over the four controls that are
precisely *not* draggable — the affordance pointed at the one place the
gesture does not work.

Three changes, and they answer three different questions:

1. **A `⠿` handle**, first child of the row, declaration-identical to
   `NodeTreeEditor.module.css`'s. It carries `touch-action: none` and its own
   `onPointerDown`, which is not optional: `handleLevelPointerDown` refuses any
   pointerdown inside a `button`, so without it the grip would have been the one
   part of the row that could not start a drag. **It also closes the level half
   of "no touch path for either drag"** — a consequence of matching the tree,
   not a separate feature.
2. **`cursor: grab` on `.row`, plus a hover tint.** The whole row has been a
   mouse/pen drag source since D95a and said so nowhere. Measured after: the
   grab cursor appears on exactly the 53 draggable pixels and nowhere else,
   because the input, the buttons and the label each state their own — the
   cursor now *is* the hit map.
3. **The tint is `--ring`, not `--page`.** `--page` on `--surface` is a
   three-unit difference and rendered as nothing in P1-5g. `--ring` over
   `--surface` is `#e4e4e3`, plainly visible in the render.

**⭐ AND THE RENDER FOUND A DEFECT IN THE FIX ITSELF.** The caret sits 3 px
above the row it marks; the hover tint's `box-shadow` spread reaches 4 px above
the same row. On every live drag the pointer is over a row, that row is hovered,
and the band's top edge lands **one pixel** from the green rule — the caret
stops reading as "it lands between these two rows" and starts reading as "this
row has a green top border". `.dragging .row:hover` now stands the tint down
while a drag is live, so the caret owns the seam. D99's corollary exactly: the
state you need is the one with a neighbour.

**⭐ AND A MEASURED CONTRAST FAILURE ON BOTH SURFACES.** The tree's `⠿` ships
`color: var(--grid)`. Computed: `#e1e0d9` on `#fcfcfb` is **1.29:1**, and on the
hover ground **1.04:1** — below the 3:1 a non-text affordance needs, and low
enough that the handle reads as absent. Shipping the new grip at the same value
would have been P1-6e's own defect in a different colour. Both files now use
`--muted` (3.50:1 resting, `--ink-2` 6.24:1 on hover) and stay
declaration-identical, which is the whole point of the copy.

### ⭐⭐ The bug behind the affordance, and it is §19.50's bug on the other surface

The Chrome bridge is not connected, so the running app could not be driven. The
substitute: the **real** markup and the **real** stylesheet laid out by a real
engine in headless Chromium, the component's own handlers driven over that
geometry, and the result fed through the **real** `applyLevelAction`. 672
pointer positions, four drag sources.

Two answers came back:

- **The algebra is correct. 528 of 528 drop pixels agreed with the caret**, in
  both directions. `landingIndex`'s off-by-one was right.
- **231 of those 528 (43.8%) drew a caret and changed nothing.**

That is §19.50, on the surface §19.50 did not touch. It fixed `rowDropZones` in
`treeDrag.ts`; the level list has its own copy of the rule, in the component,
and never got it. The two dead seams are the seam directly above the dragged row
and the seam directly below it — the same position approached from either side,
exactly as §19.50's companion theorem says.

**Nobody could have found this by opening the screen, because nobody could grab
the row.** The affordance defect was hiding the behaviour defect.

### The rule, and why it is NOT the tree's rule

§19.50 **drops** the dead zone and the row's surviving placement (adopt) takes
the whole row. A level row has no second meaning to fall back on — one seam per
half and nothing else — so dropping the zone would leave a dead half-row with no
feedback at all. Here the dead half **collapses into the live one**: the whole of
the row above the dragged row means "land above it", the whole of the row below
means "land below it". Same principle in §19.50's own words (*"dropping it lets
the surviving placement take the whole row"*), different mechanics, because a
flat list has no adopt.

**And the dragged row is not a special case.** Both its halves are dead, both
candidates are refused, the function returns `null` and no caret is drawn —
which is what its 0.45 opacity was already saying. An explicit
`overIndex === from` branch was written first and **deleted**: a second copy of
a check that always holds is gotcha 17 and cannot be mutation-tested. Case P12
pins that the general rule subsumes it.

### Where it lives now

`levelDropTarget` is in `levelDraft.ts`, beside `applyLevelAction` — the
function it has to agree with. **`landingIndex` moved out of the component with
it.** That off-by-one had a nineteen-line comment and no test able to reach it;
it now has 25.

### Verification

- **25 committed cases (group P), green cold**, and the whole
  `levelDraft.test.ts` re-run in a shim against the **delivered** module:
  **79 reported, 79 pass, 0 fail, 0 crashed.**
- **11 mutations. 10 CAUGHT, 1 executed and measured INERT**, killing cases
  recorded per mutation, reproduced identically by the design session's own
  reference run and by the committed suite:

  | # | breakage | verdict | killed by |
  |---|---|---|---|
  | W1 | `isNoop` loses the seam-above term | CAUGHT | P7 P9 P12 P14 P17 P23 P24 P25 |
  | W2 | `isNoop` loses the seam-below term | CAUGHT | P8 P10 P12 P14 P17 P23 P24 P25 |
  | W3 | the collapse is deleted — the pre-P1-6e dead caret | CAUGHT | P7 P8 P9 P10 P12 P14 P17 P23 P24 P25 |
  | W4 | the two candidates are tried in the wrong order | CAUGHT | P1 P2 P3 P4 P18 |
  | W5 | the splice shift uses `<=` instead of `<` | **NOT CAUGHT — INERT** | — |
  | W6 | the off-by-one is deleted, `landAt` is the seam | CAUGHT | P3 P4 P5 P8 P15 P16 P17 P18 P24 |
  | W7 | the `overIndex` range guard is deleted | CAUGHT | P19 |
  | W8 | the `from` range guard is deleted | CAUGHT | P20 |
  | W9 | the integer guard is deleted | CAUGHT | P21 P22 |
  | W10 | the half-split ignores `above` | CAUGHT | P2 P4 P10 P11 P18 |
  | W11 | both halves dead falls back to the dead seam instead of `null` | CAUGHT | P12 P14 P17 P23 P25 |

  **W5 is inert, and the reason is a consequence of the fix rather than of the
  line it mutates.** `caretAt` can never *be* `from`, because `isNoop` refuses
  that seam — so `<` and `<=` are indistinguishable over the whole reachable
  domain. Rule 13 says report which kind: *a value no case can reach*. **Case
  P25 pins the impossibility directly**, so deleting the collapse turns W5 live
  and P25 red in the same run, instead of quietly reopening the boundary.
- **Re-measured end to end after the fix, through the real modules: 396 caret
  pixels, 0 dead, 0 disagreements with `applyLevelAction`.** 132 pixels draw no
  caret (the dragged row's own body) and 144 are outside any row.
- `tsc -b --force` exit 0, **instrument-checked** with an injected `TS2322` at
  the expected line. `eslint` exit 0 on the three touched TS files (`eslint .`
  over the whole repo exceeds the 45 s `device_bash` ceiling and is Pratik's
  acceptance run).
- Scale audit re-run against the real files: 6 `REM_SURFACES` entries, 6 admin
  stylesheets on disk, zero unlisted, zero unscaled px lengths, control font
  reset present. **Noted soft spot:** `unscaledPxLengths` exempts `box-shadow`
  by property name as "decorative", and the new hover tint's shadow *spread*
  carries real geometry. It is written in `rem` anyway, so nothing is wrong —
  but the exemption's premise is now one case weaker than its comment claims.
- **Rendered and looked at, four states** — `docs/mockups/p1-6e-level-grip.png`.

### Not proved

Nothing has still driven the *running application*. The probe supplies real
geometry and calls the real modules, but the handlers it drives are a
**transcription** of `LevelEditor.tsx`, not the component. It cannot see React
state, pointer capture, `<StrictMode>` double-invocation, or the HMR path. The
committed cases guard the rule; the browser still owes an acceptance pass — and
the Chrome bridge (`mcp__claude-in-chrome__list_connected_browsers` returns `[]`)
would remove that gap entirely if it were connected.

---

## §19.57 — Can four agents build Shifts, Operators, Products and Import in parallel? Measured, not argued

Pratik asked directly. Four **read-only** survey agents were run concurrently,
one per section, each told that the migrations are the authority and the
narrative docs are not, and each required to return an exhaustive NEW/EDIT file
table with a SHARED column. All four landed. They agree.

### The answer: not as four build agents, and the reason is a short list of files

Every one of the four sections edits the same handful of files, in the same
places:

| shared file | what each agent does to it | why it conflicts |
|---|---|---|
| `src/features/admin/AdminPage.tsx` | flip one `enabled: false` in the `SECTIONS` array **and** add one `{section === "x" && …}` block to the same JSX child list | two overlapping hunks, four times |
| `src/test/scaleAudit.ts` | append its `.module.css` to `REM_SURFACES` | one sorted literal |
| `src/test/scaleAudit.test.ts` | append to **R10's hardcoded copy of that list**, and change its title ("six" → N) | one sorted literal, and the case fails the build if missed |
| `src/lib/api/index.ts` | one `export * from "./x";` line | same anchor |
| `src/lib/database.types.ts` | regenerated wholesale, Docker-only, on Pratik's machine | unmergeable, and single-threaded by construction |
| `docs/roadmap.md`, `docs/design-plan.md` | long prose appends | the worst textual collision in the repo |

**And they all need the same migration.** "The shared lists get an owner" is
*one* migration covering `operators`, `products`, `skills` and
`shift_templates`: one sequence number, one policy surface, one
`board_window` re-emission (which `0014:557-563` forbids hand-retyping), one
`database.types.ts` regeneration. It cannot be four migrations and it cannot be
co-authored — `docs/conventions.md:24` makes migrations append-only.

### ⭐ But the collisions are all in files that can be edited ONCE, up front

That is the finding that changes the answer from "no" to "yes, after two serial
steps". Every shared edit above is small, mechanical, and knowable before any
section is designed. So:

**Serial step 1 (design session): migration 0023, the shared lists get an
owner.** It is already item 3 on Pratik's own list. One migration, one test
file, one mutation table.

**Serial step 2 (Pratik): `db:reset`, `db:types`, commit.**

**Serial step 3 (design session, one small commit): pre-seat every shared
file.** All four sections turned on in `SECTIONS` with empty placeholder panels;
all four stylesheets created empty and listed in `REM_SURFACES` **and** in
R10's literal; all four `src/lib/api/*.ts` modules created empty and exported
from `index.ts`. After that commit each section agent creates **only its own
new files** and the collision surface is genuinely zero.

**Then four lanes really are parallel**, because the FILE TABLEs minus the
shared rows are disjoint: each is a panel, a stylesheet, a hook, a pure module,
its vitest suite and one API module.

### What the surveys found that nobody had asked for

- **⚠️ `src/lib/database.types.ts` is one migration stale.**
  `app_profile_is_company_admin` is granted to `authenticated`
  (`0022:75-81`) and does **not** appear in the generated types. Verified
  independently. `npm run db:types` is owed.
- **⚠️ A site admin can edit no operator, no product and no shift pattern
  today** — those policies still ask `app_is_admin()`, the org-wide flag —
  **while `RequireAdmin` lets them onto the page** via
  `app_is_admin_anywhere()`. Turning any of these four sections on before 0023
  ships a screen that opens for a site admin and silently discards every edit.
  That is 0022's lesson pointing the other way: **anything the client SHOWS,
  the server must allow.**
- **⚠️ The Shifts scope is genuinely undecided in writing.**
  `design-plan.md:508` says shift patterns are a company-admin concern;
  `roadmap.md:146-147` says they become site-owned. Nothing resolves it. It
  decides whether Shifts carries zero migrations or shares 0023.
- **⚠️ Products has no colour of its own.** `--product-1…4` are assigned
  **positionally** and org-wide, so inserting a product re-shuffles the colours
  of existing ones and the fifth product has none. A Products screen cannot
  avoid showing a colour, and there is no stable colour to show.
- **⚠️ "Products, their skill requirements and standard targets" is one third
  of a feature.** Skill requirements attach to **nodes**, not products
  (`0002:76`); standard targets do not exist in the schema at all.
- **⭐ A second missing premise under CSV import, beyond `nodes.external_id`.**
  `products.external_id` exists with **no unique constraint**
  (`0002:34,38-39`), so the products half cannot upsert either. And
  `create_node` **clones the hierarchy shape on every root create** since
  `0020:861-914` — so importing a multi-site CSV silently multiplies
  `hierarchy_templates`. `docs/api.md` §3.5 documents the pre-0020 behaviour
  and is wrong before the brief is even written.
- **The roadmap's own parallelism note is now out of date.** `:300` says
  P1-5h *"is the only queued item with zero file overlap with the drag work"*.
  True against the drag work; **false** against Shifts/Operators/Products,
  which land in the same admin shell — and Import additionally touches seven
  fixture files if `BoardNode` gains a field.

### The one thing that did parallelise, immediately

Four read-only surveys on disjoint targets, run concurrently, all four useful,
zero conflict. That is the shape [[agent-run-hazards]] already records, and it
held: **groundwork surveys for undesigned features are the reliable parallel
lane, and building four screens at once is not.**

---

## §19.58 — D100: one drag surface, two screens. "Shouldn't this be done by default?"

Pratik, looking at the node tree and the level list side by side the morning
after P1-6e:

> *"Can we make sure we match the colors on drag selection in all areas,
> shouldn't this be done by default? It seems we're reinventing stuff vs
> reusing it. The drag is also present right next to arrows which seems weird."*

Three separate observations, all correct, and the first one names the fix: **by
default**, not by matching.

### What was actually different, measured

| | node tree | level list |
|---|---|---|
| row hover background | `--page` — three units on `--surface` | `--ring` |
| row padding | real, `--row-pad-y` | none, faked with a `box-shadow` spread |
| grip block | its own 14 lines | a copy of those 14 lines |
| ghost opacity | `0.45`, written out | `0.45`, written out again |
| grip position | last but one, before `⋮` | **first**, at the left edge |
| caret / drop colour | `var(--signal-ok)` | `var(--signal-ok)` |

**Every declaration in both files was correct. The defect was that there were
two of them** — and one of the two hovers was the exact `--page`-on-`--surface`
value P1-5g had already measured as rendering nothing, so "matching" would have
meant copying an invisible tint onto the second screen.

### The fix is D84's fix, in a second domain

D84's lesson was *scaling is the behaviour of the UNIT, not a discipline*. Same
move here:

- **`src/styles/tokens.css` gains a `--drag-*` / `--drop-*` block.** Nothing in a
  drag surface names `--signal-ok` any more; it names `--drag-caret` or
  `--drop-ok`, so the two can be re-pointed in one place.
- **`dragSurface.module.css` is new and owns the RULES**, not just the values:
  `.dragRow` (padding, radius, `cursor: grab`, the hover tint, and the
  suppression of that tint while a drag is live), `.grip`, `.ghost`,
  `.noSelect`. Both surfaces `composes:` them.
- **What stays local is only what genuinely differs**, and it is geometry rather
  than taste: the tree's caret indents to the dragged node's depth in a gapless
  column, the level list's spans the full width and is centred in a real flex
  gap. Each file says so where it diverges.

The level list gained real padding in the process and lost the `box-shadow`
spread that was imitating it — the reinvention removing itself.

### ⭐ And the audit, because a default that nobody checks is a habit

`scaleAudit.ts` grows a drag audit with four functions and twelve cases
(group G):

- `missingDragCompose` — a drag surface that stops composing has started its own copy.
- `unsharedDragRules` — `cursor: grab`, `cursor: grabbing`, `user-select: none`,
  `touch-action: none` and the four shared tokens may be written in the shared
  file and **nowhere else**.
- `rawDragColours` — no drag surface may name `var(--signal-ok)` directly.
- `undefinedDragTokens` — every `--drag-*` / `--drop-*` a surface reads must be
  defined in `tokens.css`. An undefined token resolves to nothing: for a colour
  that is transparent, for an opacity the whole declaration is dropped, and both
  look like a design choice rather than a typo.

**10 mutations, all 10 caught** — and the tenth exists because the ninth
escaped:

| # | breakage | verdict | killed by |
|---|---|---|---|
| V1 | the level list grows its own `cursor: grab` again | CAUGHT | G4 |
| V2 | the node tree grows its own grip block again | CAUGHT | G4 |
| V3 | the level caret goes back to the raw `--signal-ok` | CAUGHT | G8 |
| V4 | the tree's drop ring goes back to the raw `--signal-ok` | CAUGHT | G8 |
| V5 | a surface reads a token nobody defines | CAUGHT | G10 |
| V6 | `--drag-row-hover` is deleted from `tokens.css` | CAUGHT | G10 |
| V7 | the shared file stops declaring `touch-action` | CAUGHT | G5 |
| V8 | the new stylesheet is dropped from `REM_SURFACES` | CAUGHT | R10 |
| V9 | a needle is quietly removed from `SHARED_DRAG_DECLARATIONS` | **CAUGHT by G12, which exists because of this** | G12 |
| V10 | the comment stripper is removed from the drag matchers | CAUGHT | G4, G7 |

**V9 is the one to read.** Deleting `"user-select:none"` from the needle list was
caught by *nothing*: G4 finds one fewer thing to complain about and G5 has one
fewer thing to require, so both go **greener**. That is the standing finding *a
list that drives a test is itself untested unless something asserts the list* —
the same hole `R10` exists to close one level up — and **G12 is that assertion**,
a sorted literal of all eight.

Half of group G runs against synthetic CSS on purpose (rule 3): a case that only
ever looks at the repo passes for as long as the repo is clean and says nothing
about whether the matcher can fail at all.

### The grip moved, and the reason is his

*"The drag is also present right next to arrows which seems weird."* Right
twice over: it put two ways of moving the same row side by side, so the pair
read as one control with a broken half; and it made the two surfaces disagree
about where a grip lives, which is the reinvention D100 exists to stop. It now
sits **last but one, immediately before `×`** — exactly as the tree puts `⠿`
immediately before `⋮`. Left-edge is the more common convention in the abstract;
**matching the surface next to it wins, because these two screens are looked at
together.**

### ⭐ And a colour that matched nothing, visible only in HIS screenshot

The level row's `↑` / `↓` render **blue** on his machine. Not a stylesheet bug:
`U+2191` / `U+2193` have emoji presentation, Windows falls through to an emoji
font, and an emoji glyph carries its own colour — immune to the
`color: var(--ink-2)` two lines above it. **No render in this container could
ever have shown it**, because the container's font stack has no emoji face to
fall through to. Fixed with `U+FE0E`, the text-presentation selector.
**Worth keeping as a class: a font-fallback defect is invisible to every
screenshot taken on a different machine.**

### Verification

- `tsc -b --force` exit 0; `eslint` exit 0 on the four touched TS files.
- Scale audit re-run against the real files: **7 `REM_SURFACES` entries, 7 admin
  stylesheets on disk, zero unlisted, zero unscaled px lengths.**
- `scaleAudit.test.ts` run end to end in a shim against the real module:
  **45 reported, 45 pass** (33 before). `levelDraft.test.ts` re-run unchanged:
  79 of 79.
- **Rendered both surfaces side by side in three states and looked at the
  picture** — `docs/mockups/d100-drag-surface.png`. `p1-6e-level-grip.png` was
  regenerated from the current files rather than left showing the old left-edge
  grip; a mockup that lies is decision-record drift with pictures.
- **Re-measured after the move: the level row's centre line goes 21 px → 61 px**
  (53 before the row gained real padding), and the grab cursor falls on exactly
  those 61. The tree row measures 457 of 495, unchanged — a level row is mostly
  a text field and can never match that, which is the whole reason it needs a
  grip and the tree barely does.
- **Suite prediction 701 → 713, still 19 files.**
- **One instrument note, third occurrence:** the shim used for the run above was
  missing `toMatch` and scored a real case as CRASHED. Grep the suite for the
  matchers it uses before writing the shim.

---

## §19.59 — D101 and D102: shift patterns and product colours are the site admin's, with defaults

Both asked in §19.57's blockers; both answered in one line:

> *"The shift pattern will be per-site, we can have defaults but I'd rather the
> site admin set them up for their site, same thing for colours."*

### D101 — shift patterns are per-site

This settles the contradiction §19.57 found between §16's *"attached to any
node, org-admin"* and the roadmap's *"becomes site-owned"*. **Site-owned wins**,
and it means shift templates join `operators` / `products` / `skills` in
migration 0023 rather than sitting outside it. Consequences, so the brief is not
written against a guess:

- `shift_templates` and `shifts` are org-scoped today with no owning-node
  column, and their RLS asks `app_is_admin()` — the org-wide flag. Both change.
- *"We can have defaults"* is the same rule 0023 already carries for the other
  lists: **an entry with no owner stays company-wide.** A company admin seeds a
  standard pattern once; a site admin's own patterns sit alongside it.
- **The nearest-ancestor inheritance (§16) is untouched.** Which template a node
  runs is still resolved up the tree; ownership decides who may *edit* the
  template, not which one applies.

### D102 — a product's colour belongs to whoever owns the product

Today `--product-1…4` are handed out **by position** in an org-wide list, so
inserting a product re-shuffles the colours of the existing ones and the fifth
product has none. §19.57 flagged it because a Products screen cannot avoid
showing a colour and there was no stable one to show.

The decision, in the same shape as everything else here: **whoever owns the row
owns its colour.**

- `products` gains a colour, stored as a **palette token name, never a hex** —
  the board resolves it through `tokens.css`, so a theme change stays one edit
  and the value cannot escape `scaleAudit`'s reach the way D89's inline
  `paddingLeft` did.
- Nullable, with a **deterministic default** assigned within the owner's scope,
  so an unset product still has a stable colour and *"we can have defaults"* is
  literally true.
- The palette grows past four. Four was the mockup's cast, not a design.
  **⚠️ AMENDED WHEN 0023 WAS BUILT, and the amendment is the whole of the lesson:
  it shipped at FOUR.** Widening it in the database alone is the wrong half of
  the change — `tokens.css` defines `--product-1` through `--product-4` and
  nothing else, so the moment `app_product_palette()` handed out `product-5` the
  board resolved `var(--product-5)` to nothing and the product rendered with
  **no colour at all**, which is strictly worse than the wrong one. It was
  written at eight and `upgrade_0023_product_colour.sql` caught it: with six
  products, two changed colour and the fifth came back `product-5`. On a fresh
  database nothing would have shown it, because the seed has exactly four.
  **The palette is as wide as the stylesheet and not one token wider**; widening
  it is `app_product_palette()` + `tokens.css` + case Q31, in one commit.
- A site admin edits the colour of the products their site owns; a company-wide
  product's colour is the company admin's. **No `(site, product)` override
  table** — that was the alternative and it is rejected here on purpose: it
  makes one product two different colours on two boards, which is exactly the
  confusion a colour exists to prevent, and it doubles the resolution path for a
  case nobody has asked for.

**Both land in migration 0023**, which is D96's rule (Pratik's CLI is the scarce
serial resource, so a migration plus its regenerated types is one round trip)
and is now carrying: owning site on operators / products / skills /
shift_templates, plus the product colour column and its default.

---

## §19.60 — Migration 0023: the shared lists get an owner, and a product gets a colour of its own

**Status: built, applied to a scratch PostgreSQL 16 by the design session, and reviewed adversarially by two independent agents. `scripts/verify-db.sh` exit 0, 23 migrations, 315 named cases (271 before), 38 new cases in `51_shared_list_owners_test.sql` and 6 in `upgrade_0023_product_colour.sql`. 28 mutations, 24 caught and 4 executed-and-inert with the fact each depends on pinned by a case. NEEDS `npm run db:reset && npm run db:types`.**

D101 and D102 answered §19.57's two blockers, so this is the migration that was gating all four SOON admin sections.

### The scoping decision, and it is the one that decides everything else

**0023 changes WHO MAY EDIT. It does not change who may READ.** Every `_select` policy is left exactly as 0008 wrote it, org-wide.

That is a measured requirement, not caution. `check_eligibility` (0009) is `SECURITY INVOKER` and reads `operator_skills` and `skills` **as the caller**: a skill the caller cannot see drops out of its `held` CTE, lands in `missing`, and flips `eligible` to false — and `create_assignment` gates on that verdict. **A read narrowing would have become a silent write refusal one indirection along.** It is also exactly what Pratik said the rule was for shift patterns, and what 0020 §12 already decided for node attachments. Case **Q11** is the tripwire: it asserts the reads are still org-wide, so narrowing one goes red before eligibility starts quietly answering "no".

### What it does

| | |
|---|---|
| `site_node_id uuid` | nullable, composite `(org_id, site_node_id)` FK, on `operators` / `products` / `skills` / `shift_templates`. **NULL = company-wide**, which is what "we can have defaults" means. No unique index — a site has many of each, unlike `hierarchy_templates` |
| root enforcement | **ONE** trigger function on four tables. Four copies would be D100's defect in SQL |
| write policies | 21 rewritten across **seven** tables. Four ask their own column; `shifts` and `shift_breaks` ask their template (two hops for a break); `operator_skills` asks its **operator** |
| `products.color_token` | NOT NULL, a palette **token name** never a hex, filled on insert by the least-used token **within the owner's scope** |
| the D93 hole | `resolve_shift_template(uuid)` has been anon-executable since 0005. Closed in passing |
| `board_window` | re-emitted by `pg_get_functiondef` extraction, one key added |
| **not** done | no ownership backfill; no `_select` change; `node_shift_templates` untouched; no thirteenth error code |

**`operators.home_node_id` is not this column**, however much it looks like it: its FK admits any node, every seeded value points at a Department or a Work Cell, and it is read by nothing anywhere. A backfill from it would have failed the root check on every row in the seed.

**INSERT is a real widening.** `app_is_admin()` reads the org-wide flag, so before 0023 a site admin could write **nothing** in any of those seven tables. All 21 policies are strict supersets of 0008's; nothing here can regress a permission, and the only way to get it wrong is to hand out too much — which is what the review was for.

### ⭐ Four defects found before this shipped, and none by reading

**1. The root trigger was answering the permission question.** Written first as plain plpgsql, exactly like 0020's, it resolved `nodes` **as the caller** — so a site admin naming another site's root got `not found` from the trigger instead of a refusal from the policy. Measured: Q6 and Q9 came back `PT400`, not `42501`. Two things wrong, the second worse: "not found" was a lie about a node that exists (0020 §8.0, one table over), and **the trigger was masking the policy, which would have made every mutation of a WITH CHECK term look caught when it was the trigger catching it.** Now SECURITY DEFINER — safe here where 0020 §11 refused it for the adjacency trigger, because that one reaches D97's gate and reads `current_user`. Q6/Q9 assert `42501` so the two cannot swap jobs again.

**2. ⭐⭐ The palette shipped at eight and the upgrade test caught it.** §9 had argued, in writing, that there was no `UPGRADE_CHECKS` row to write. Case Q24 proved otherwise: the colour backfill **is** a data transform. Writing `upgrade_0023_product_colour.sql` immediately found that with six products the fifth came back `product-5` — a token `tokens.css` does not define, so `var(--product-5)` resolves to nothing and the product renders with **no colour at all**. The seed has exactly four products, so no fresh-database test could ever have shown it. **An absence argued for in a comment is not the same as an absence measured.**

**3. ⭐⭐ A cross-tenant leak, found by the adversarial reviewer.** `app_pick_product_color` was SECURITY DEFINER, took the org as a free parameter, was granted to `authenticated` — and its own comment claimed it was "tenant-scoped internally in 0012's shape". It was the opposite. It lives in `public`, so PostgREST exposed it: any viewer in org 1 could ask it about org 2 and read back which of another tenant's palette slots were least used. **D83/0012's finding, verbatim, in a new function.** And the obvious fix was measured wrong: `where p_org_id = app_current_org()` returns NULL during the backfill and the seed, where there is no session profile, so the guard would have written NULL into a NOT NULL column. **The boundary is a GRANT, not a predicate** — revoked from PUBLIC, granted to nobody, with the insert trigger made SECURITY DEFINER so it can still reach it. Case Q35 pins that `authenticated` cannot execute it, because a grant is a thing people delete (0019's X15).

**4. `color_token` was nullable and its comment said "NULL only transiently".** The reviewer showed the UPDATE path made that untrue: a site admin may edit their own row, the CHECK permitted NULL, and no trigger fires on UPDATE — so a product could be left with no colour by an ordinary edit. Case Q23 was asserting an invariant nothing enforced. `set not null` after the backfill, and it retired mutation R23 as well, whose inertness had rested on a NULL being unwritable.

Two smaller ones from the same reviews: a §6 comment cited 0019's `nodes` shape as its precedent when 0019 used `app_is_admin_on_path` **precisely because** `app_is_admin_for` reads `nodes` — the opposite of the truth; and case Q21's name claimed a cross-site pair its fixture could not deliver, because the fixture had no Plant-2-owned skill (**Q37** is that row).

### ⭐ The colour, measured

`board_window` emits products `ORDER BY p.sku` and the client takes the row's ordinal modulo four — **in two independent places**, `BoardGrid.tsx` and, separately, the legend in `BoardToolbar.tsx`. Against the seed that means:

| product | renders as | whose comment says |
|---|---|---|
| Gadget Z | `--product-1` | "Widget X" |
| Rework | `--product-2` | "Widget Y" |
| Widget X | `--product-3` | "Gadget Z" |
| Widget Y | `--product-4` | "Rework" |

**All four have been wrong since P1-1**, because `tokens.css` was written from the mockup's insertion order and the server sorts by SKU. Nobody noticed because every colour is still a colour.

The new rule is least-used-in-scope, which buys two things the ordinal never had: **inserting a product cannot change the colour of one that already exists**, and **two sites can both hold `product-1` without re-shuffling each other**. Over four tokens walked in sku order it reproduces the old assignment exactly, so an existing board does not move (upgrade V1). **On a fresh `db:reset` it does move, once**: no products exist at backfill time, so the insert trigger assigns in the seed's INSERT order and Widget X becomes `product-1` — which is what `tokens.css`'s own comments have always claimed. The reset path makes the file honest, and it will look like a regression the first time it is seen.

### Verification

- **`scripts/verify-db.sh` exit 0, cold: 315 named cases, zero `NOTICE: FAIL`.** Baseline before the migration was 271, re-run first for exactly that reason.
- **38 cases (Q0–Q37)** in `51_shared_list_owners_test.sql`, on a fixture with **two sites in one org** (the seed has one) where **every site admin is an org-wide `viewer`** — 46's lesson, and Q0 asserts it, or `app_is_admin()` would short-circuit every predicate and the file would pass against a migration that did nothing. **And an owned AND an unowned row of every kind**, because a fixture where everything is owned cannot tell "that site's row" from "a company-wide row" and those are two different branches of one predicate.
- **28 mutations. 24 caught, 4 executed and measured inert**, each with the fact its inertness depends on pinned by a case:

  | # | verdict | note |
  |---|---|---|
  | R7, R15 | INERT | a `site_node_id is not null` term is redundant because `app_is_admin_for` is an `EXISTS` and an EXISTS never returns NULL. **Q32 pins that**, measured — the day it stops being an EXISTS, both go live and Q32 goes red in the same run |
  | R14 | INERT | masked by `operator_skills`' composite FK in migration **0002**, a different file — rule 9b's exact shape. **Q34 pins the impossibility** |
  | R23 | INERT | the trigger body only fills a NULL, and after fix 4 a NULL cannot be written. Inert **because of** the NOT NULL, not on its own |

  ⚠️ Six mutations first came back **CRASHED**, and the cause was mine: a widened `USING` turns a silent zero-row refusal into a raised `42501`, and cases that only asserted `ROW_COUNT = 0` died instead of reporting. Rewritten to assert **the shape of the refusal** — `rows = 0 AND no exception` — which is rule 7e, and all six then named their killing case.
- **The harness's own gap closed on the way past:** step 7 counts PASS notices only to phrase the result, never to require a number, so a deleted test file is 38 cases vanishing under a green run. `verify-db.sh` now guards `51_`'s existence, the same idiom as the 60/70/90 guards. **Fourth place this has had to be closed by hand.**
- **`docs/schema.md`'s source heredoc** — inside `verify-db.sh`, not the generated file — said *"`products` … No color column"*. Corrected, along with the `operators` row, which now distinguishes `site_node_id` from `home_node_id`.
- **Not verified by me:** anything in the client (nothing reads the new columns yet), and the migration against real Supabase.

### Open, recorded, not closed

1. **The root invariant is checked at write time and never re-checked.** `move_node` lets a company admin re-parent a site; every shared row owned by the old root then names a mid-tree node, and the admin of the new parent inherits them. Inherited from 0020 — `hierarchy_templates.site_node_id` has the identical shape — but 0023 multiplies it from one table to four.
2. **`app_check_site_owner` is a three-way oracle** over node ids a site admin cannot SELECT: absent / mid-tree / a root that is not theirs. Uuids are unguessable and a site admin already knows their org has other sites; recorded in the function's own comment rather than closed.
3. **The seed and `dev_demo.sql` own nothing**, so after `db:reset` **a site admin signing in sees the feature do nothing** — every row is company-wide and company-wide is company-admin-only. `dev_demo.sql` is the only fixture with a second plant and is where a couple of owned rows belong. 0020 hit exactly this and fixed it in the seed.
4. **`app_is_admin_for_operator` is granted to `authenticated`** and, under R14's mutation, would answer about another tenant through the direct RPC path. Q34 pins the policy path only; the RPC path is unmeasured.

---

### 19.61 P1-5k client half — and the two things promote/demote were saying wrong (migration 0024, Aug 27, 2026)

The SQL half of P1-5k shipped in **0017** and has been applied and tested since. This is the screen
for it, and building the screen meant asking the one question a SQL suite never asks: **what does the
user SEE when this is refused?** Both answers were wrong, and neither was visible from reading.

#### 1. The two server defects, both measured on a scratch PG16 before a line of UI was written

| | before | measured | after (0024) |
|---|---|---|---|
| destination already has that name | raw **`23505`**, `nodes_org_id_parent_id_name_key`, **DETAIL empty** | reproduced on both `promote_node` and `demote_node` | `path_collision` with `{path, existing_node_id}` |
| the move would strand scheduled work | `{reason, count}` | `parseSchedulerError` accepts **only** `{blocking_rows, level_id}`, so it decoded as `Unknown` | `{blocking_rows, level_id, reason}` |

The first is the one worth dwelling on: **§19.33 §4 measured it while P1-5k was being designed and
wrote down "catch and re-raise `path_collision`" — and 0017 never did it.** A recorded decision that
never reached the code, [[decision-record-drift]]'s exact shape, and nothing downstream noticed
because no case asserted what a *collision* looked like; every case asserted what a *legal* move did.

The second is worse in kind and quieter in effect. `app_relevel_subtree`'s stranded-work refusal is
**the whole point of the feature** — it is what stands between a re-level and a schedule pointing at
nodes that can no longer hold work — and it would have rendered as *"Something went wrong. Please
try again."*

**Neither is a new rule.** Both are the twelve-code contract (`docs/api.md` §1) being kept where it
was already being broken, so 0024 introduces no thirteenth code and no behaviour that was not
already on paper.

#### 2. What 0024 does, and the one thing it deliberately keeps

Extracted from the **live** database with `pg_get_functiondef` — `grep` returns `app_relevel_subtree`
in 0017 **and** 0020, and 0020's re-emission is the live one, so extracting 0017 would have silently
reverted its node-scoped admin check (rule 12, and the second time that trap has been stepped over
rather than into).

- A **prospective-path pre-check** over every node in the moved subtree, mirroring what
  `create_node`, `rename_node` and `move_node` have each done since 0010.
- The **stranded payload** reshaped, with `level_id` naming the level the blocking rows landed on —
  which exists by construction, because rows were just counted there.
- **17 cases** (`76_relevel_contract_test.sql`), **11 mutations, 7 caught, 4 executed-and-inert**,
  each inert one with the fact it depends on pinned by a named case: the subtree exclusion (N12/N5),
  the org filter that RLS already provides (**N15**), the destination check that runs first (**N16**),
  and the path-prefix invariant (**N17**). **332 named database checks**, up from 315.

**No `UPGRADE_CHECKS` row, deliberately**: 0024 transforms no data, it changes only what an
already-failing call says. There is no before/after row state to compare.

#### 3. The client half, and why the menu names a LEVEL instead of an operation

`src/features/admin/lib/relevel.ts` — pure, `import type` only — answers three questions and no
others: is a promote worth offering, which nodes could this be demoted under, and **what is the
destination rung called**. That third one is the design decision:

> **"Make this a Department"**, not "Promote". The org has already told us what it calls its rungs
> (D90 — the screen speaks the customer's vocabulary), and a plant manager reading *promote* has to
> guess. When the rung cannot be resolved the label falls back to "Move up a level" rather than
> hiding the control, because whether the action is OFFERED is a different question.

**Every mirror in this module fails OPEN** ([[verification-standard]] rule 8b): it decides only what
a menu offers, so an unresolvable fact means *offer it and let the server refuse*. The forbidden
direction is refusing client-side something the server would accept, because that is invisible — the
user simply never sees the option.

**⚠️ AND IT NEVER PREDICTS SCHEDULED WORK.** The admin tree carries no run or assignment counts, and
loading the schedule to draw a menu is not a trade worth making. So the offer is made, the server
refuses, and 0024 is what makes that refusal a sentence.

**A blocked entry is shown and explained, never hidden** — the opposite of "Move to…", which can
shorten a list because there is a list. Here there is exactly one thing to click, and silently
omitting it leaves an admin with a tree they cannot fix and no idea why.

**`canDropOn` is deliberately NOT reused.** It answers "may this node become a child of that one AT
ITS CURRENT LEVEL" — target exactly one rung above. A demote changes the level as part of the same
operation, so its target sits at the node's **own** rung, which `canDropOn` refuses by construction.
Different questions about the same tree, not two copies of one question.

#### 4. Verification

- **36 cases** (group K, `src/test/relevel.test.ts`), **15 mutations, all 15 caught.**
- Two cases were written wrong first and their own assertions caught it: K16 claimed a fixture state
  the tree could not produce (`d1`'s subtree reaches the work cells, so it is blocked before any list
  is built), and K26 claimed "no company at its own rung" while actually testing "no rung below".
  Rule 3b, twice in one file.
- **`describeSchedulerError` reworded**, because `schedulable_level_locked` now has two callers that
  mean different things by it: `save_hierarchy_levels` refuses moving the **flag** off a level with
  work, `app_relevel_subtree` refuses moving the **nodes** off the schedulable rung. *"The schedulable
  level can't be changed"* was simply untrue of the second. Two new cases in `errors.test.ts`.
- **Rendered and looked at** (rule 2c): five states in headless Chromium against the real stylesheet,
  with every label and every refusal computed by the real modules and read into the page rather than
  typed. The render is what caught the disabled entries keeping `cursor: pointer` and a hover tint —
  they looked clickable and did nothing — and a sentence that read *"leave scheduled work on a level
  that can't hold scheduled work"*.
- **`--muted` on `--surface` is 3.50:1**, computed. That is the disabled-control colour; the *reason*
  beneath each blocked entry is `--ink-2` at **7.73:1**, because the reason is the part that has to
  be read.

#### 5. What this does NOT do

- It does not move work out of the way. A promote that would strand a run is refused, not repaired.
- It does not offer a keyboard path distinct from the menu — the menu **is** the keyboard path.
- It does not touch the drag. Drag re-parents; this re-levels; §19.34 is the record of what happens
  when those two are confused.

---

### 19.62 The pre-seat commit — spending four collisions once (Aug 27, 2026)

§19.57 measured, with four concurrent read-only surveys, that Shifts, Operators,
Products and Import cannot be built by four agents at once — not because the
work overlaps, but because **five shared files do**. It also found the thing that
changes the answer: every one of those collisions is small, mechanical and
knowable before any section is designed. This is the commit that spends them.

#### 1. What was pre-seated

| shared file | edited ONCE, here | what a lane does now |
|---|---|---|
| `AdminPage.tsx` | four imports, four `SECTIONS` entries, four JSX branches | **nothing** |
| `src/lib/api/index.ts` | four `export *` lines | **nothing** |
| `src/test/scaleAudit.ts` (`REM_SURFACES`) | four stylesheets listed | **nothing** |
| `src/test/scaleAudit.test.ts` (R10's copy) | the same four, and the title | **nothing** |
| `src/lib/database.types.ts` | untouched — no migration here | Pratik regenerates when a lane adds one |

New, and owned by nobody but their lane: `ShiftsPanel.tsx`/`.module.css`,
`OperatorsPanel.*`, `ProductsPanel.*`, `ImportPanel.*`, and
`src/lib/api/{shifts,operators,products,imports}.ts`.

#### 2. ⭐ The switch lives in the panel, not in the shell

`SECTIONS` used to carry `enabled: false` as a literal. It now reads a flag the
panel itself exports:

```tsx
{ id: "shifts", label: "Shifts", enabled: SHIFTS_PANEL_READY },
```

That is the difference between "the lane edits one line of a shared file" and
"the lane edits its own file", and it makes the invariant structural rather than
remembered: **a section cannot be switched on without a panel behind it, because
the switch is part of the panel.** Same shape as D84 (scaling is the default),
D89 (the control reset is global) and D100 (one drag surface): [[doc_drift]]
rule 4 — *a rule that exists only as a habit will be forgotten by the next
component.*

#### 3. And the other direction is audited, because two lists had to agree

`AdminPage.tsx` holds two lists that must match and never referred to each
other: `SECTIONS`, which the rail renders, and the `{section === "x" && …}`
chain, which decides what the pane shows. A section in the first and absent from
the second is a rail button that opens onto nothing — and before this commit
that was four waiting to happen.

**Group H** (`scaleAudit.test.ts`, 6 cases) parses `SECTIONS` out of the file and
requires a branch for every id. Half its cases run against synthetic source, so
the matcher is proved able to fail; **H2 pins the id list itself**, because a
list that drives a test is untested unless something asserts it — the hole R10
and G12 each exist to close one level up.

**Six mutations, all six caught**, and one of them earned a case: making the
array match greedy runs it to the last `];` in the file, which captures exactly
the same ids today and would therefore have been invisible until someone wrote
another object with an `id` after it. **H6 is the fixture that makes that
difference observable.** And **H4 exists because of instrument 37**: a parser
that reads comments finds branches that do not exist, and `AdminPage.tsx`'s own
comments name section ids.

#### 4. What this changes on screen: nothing, deliberately

All four flags are `false`, so all four rail buttons stay disabled with their
`soon` chip and the four new panels are unreachable. The only thing that moved
is where the switch lives. **Acceptance goes 751 → 757 in 20 files** — six new
cases, no new file.

#### 5. What a lane does now

Creates its own pure module and vitest suite, its own hook, fills in its panel
and its stylesheet, fills in its `src/lib/api` module, and flips one boolean in
its own panel file. It appends to `docs/roadmap.md` and `docs/design-plan.md` —
**the one shared surface that cannot be pre-seated**, which is why lanes hand
their prose back rather than writing it, and the design session integrates.

---

### 19.63 What a table write fails with — the contract the three lanes all needed (Aug 27, 2026)

Three read-only surveys ran concurrently over Shifts, Operators and Products.
They agreed on the finding that mattered most, and none of them was looking for
it: **none of these three sections has a single RPC.** Every write is a plain
PostgREST table write, governed entirely by 0023's policies.

That is fine — `docs/api.md` §4 already sanctions it, and `mutations.ts` has done
it since P1-4. What was not fine is that **the client's error layer was written
when every write was an RPC**, so a table write fails in ways it had no words
for. All three lanes would have papered over the same four holes, three
different ways. Spending it once, here, is the same move as the pre-seat.

#### 1. The four wrong answers, all measured on a scratch PG16

| what the user did | what Postgres said | what the app said |
|---|---|---|
| site admin creates a company-wide product | `42501 new row violates row-level security policy for table "products"` | **"You need to sign in to do that."** |
| site admin edits a row they do not own | *nothing* — `USING` filters, so zero rows and no error | **"Saved."** |
| duplicate SKU / skill name / pattern name | `23505 … unique constraint "products_org_id_sku_key"` | "Something went wrong." |
| delete a product with runs against it | `23503 … foreign key constraint "runs_org_id_product_id_fkey"` | "Something went wrong." |
| two overlapping shifts in one pattern | `23P01 … exclusion constraint "shifts_no_overlap_within_template"` | **"Someone else changed this run first."** |

The last one is the sharpest. `23P01` was mapped unconditionally to `RaceLost`
because, when that mapping was written, `runs_no_overlap_on_node` was the only
exclusion constraint that could fire. A shifts editor makes that false.

#### 2. Five kinds, and the two that needed a discriminator

`WriteRefused`, `DuplicateValue`, `StillInUse`, `InvalidValue`, `ShiftOverlap`.
Nothing here touches the twelve-code contract — these are bare SQLSTATEs that
never went through `api_raise` at all.

**`42501` means two different things and only the message separates them**, both
measured: `new row violates row-level security policy for table "products"`
(a signed-in user touching a row that is not theirs) versus `permission denied
for function app_product_palette` (a role that may not call the function). The
first is now `WriteRefused`; the second stays `Unauthenticated`, so the existing
case for it is unchanged. **Telling the first "you need to sign in" is how a site
admin ends up signing out and back in to fix a permission they do not have.**

**`23P01` likewise**, by constraint name — and the fallback deliberately stays
`RaceLost`, because a retry is the safe default for an exclusion constraint
nobody has classified yet.

⚠️ **The constraint name is a database identifier mirrored into the client**, so
`30_shifts_test.sql` now asserts both names exist in `pg_constraint`. Renaming
one without touching the other is exactly the drift [[doc_drift]] rule 3 records.

#### 3. `requireWritten` — the silent half

A policy's `WITH CHECK` **raises**; its `USING` clause **filters**. So a refused
INSERT is an error and a refused UPDATE or DELETE is a success that changed
nothing — measured in `51_shared_list_owners_test.sql:251`. Every table write in
`src/lib/api/` now ends `.select()` and passes the rows through
`requireWritten`, which throws `WriteRefused` on an empty result. Without it,
"you may not touch that row" arrives as "saved" and the screen redraws unchanged.

#### 4. Verification

**18 new cases** (group W plus two rewritten), **11 mutations, all 11 caught.**
Every fixture is a message string measured by making the real statement fail as
`authenticated` against migrations 0001–0024 — none was composed from memory.

**⚠️ And one existing case changed its answer, which is rule 1b-ii, not 1b.**
`falls through to Unknown when details is not JSON` used a fixture that is a real
foreign-key violation; it fell through to `Unknown` only because nothing had an
answer for `23503` yet. **The case was right and the contract changed.** It now
asserts `StillInUse`, and the coverage it was legitimately providing — a
non-JSON `details` must not crash the parse path — is rescued by a new case
using an error with no recognised code, so the parse path is actually reached.

**The extractor anchors on the word `constraint`, not on the first quoted
string.** The foreign-key message quotes the TABLE before it names the
constraint, so `/"([^"]+)"/` returns `products` — a plausible-looking wrong
answer. W5 is the case that fails when someone simplifies it.

**Acceptance 757 → 775 in 20 files. No migration** — 0024 remains the last one.

### 19.64 Three lanes built at once, then attacked — the eleven things that survived my own green suite (Aug 27, 2026)

**Shifts, Operators and Products were built in parallel** on the seats §19.62
laid down, against the write-error contract §19.63 settled. The fence held: 21
files modified, exactly the three file tables, no shared file touched twice.
`tsc` 0, `eslint` 0, all three suites green (91 / 66 / 96), and **20
unprescribed mutations of my own across the three pure modules, all 20 caught.**

**That was the state in which the following eleven defects were still in the
tree.** Every one of them was found by the third wave — one read-only
adversarial reviewer per lane, each told to hunt a named defect CLASS rather
than to "review the code" — and every one was then reproduced by me before a
line was changed. That reproduction step is not ceremony: of the reviewers'
claims, **one was wrong on its own example** (a collision it predicted between
two labels was real, but not for the pair it named), and **one turned out to be
an inert mutation rather than a missing case** (V4 below). A green suite plus my
own mutations plus a picture was not enough. The three-wave shape is what found
these, and the wave that found them cost less than any of the three that built
the lanes.

#### 1. The six code defects

**⚠️ `crossesMidnight` used `>` where the rest of the module uses `>= 1440`.**
A shift stored `960..1440` is 16:00 until midnight. `dayOffset(1440)` is 1 and
`span` prints `"16:00–00:00 +1d"` — but `crossesMidnight` said **false**, and
that flag is what hands the break form its "+1 day" checkbox. Without the box,
the only way to reach minute 1440 is the literal string `"24:00"`, which an
`<input type="time">` can never emit. **So the legal wash-up break 23:45–00:00
was unenterable**, refused by our own validator with "ends before it starts",
on a row the database would have taken. One object was answering the same
question three ways.

**⚠️ `describeSpan` marked the day on the END only** — justified by `shifts`'
own `CHECK (start_min < 1440)`, which is true of shifts and **not of breaks**.
`shift_breaks` carries no range check at all, and the seed's own night shift
stores breaks at 1440, 1560 and 1680. Measured: `{1440,1455}` and `{0,1455}` —
two different, both-storable rows — rendered the **identical** string
`"00:00–00:15 +1d"`, and every after-midnight break read as starting twenty
hours before the shift it belongs to. The invariant was real; the function it
was written for was not the only caller.

**⚠️ `addedProblems` compared MESSAGE STRINGS**, and the outside-shift sentence
embeds the shift's own label. So editing a shift's times rewrote the sentence
for a break nobody had touched, the new string was absent from the "already
wrong" set, and **the edit was blocked — permanently**, since the panel offers
no way to move a break, only to remove it. The refusal then quoted the break
rather than the times just changed. Reproduced end to end: 22:00–06:00 → 06:30
on a shift carrying a stray 10:00–11:00 break. Identity is now
`(field, shiftIndex, breakIndex)`; the message is what we SHOW, the coordinates
are what make two problems the same problem.

**⚠️ `previewUnavailable` was gated on `treeQuery.data !== undefined`**, which
made it unreachable in the failure it was written for. When the whole hierarchy
read throws, `data` stays undefined for good (`retry: 1`, no refetch on focus),
so the flag was false and the add-form fell through to *"You don't administer a
site, so there's nowhere to add a product."* — **a flat lie to a site admin
whose writes the server would have accepted**, with every row simultaneously
labelled "Another site" and every button dead. `loading` did not include that
query either, so the same dead screen flashed on every normal load. This is the
fail-closed trap from the other side: the fallback was chosen deliberately and
documented, and the MESSAGE explaining it could not fire.

**The operators headline counted places the list hides.** `summarisePlaces(places)`
over a list rendered as `places.filter(p => p.active)` put *"2 of 6 places"*
above five rows. Two numbers a reader cannot reconcile.

**Two labels that made claims the panel itself contradicts.** The pattern list's
**"Used by"** column counts DIRECT rows in `node_shift_templates`, but
`resolve_shift_template` is nearest-ancestor-wins, so every descendant without
an attachment of its own also uses the pattern — the panel's own hint says so
two cards down. It is now **"Attached to"**, which is what it counts, and the
delete warning that also counts direct rows stays as it was, because the FK
counts direct rows. And the overlap banner said **"Two of these shifts share
minutes"** over an `overlaps` array of PAIRS: five shifts in a row produced four
of them, so a fixed "two" under-reported the mess by half.

**One wording defect that shipped because no fixture ever reached it.**
`describeSkillNameClash`'s site-owned arm produced *"There is already a existing
Welding"* — ungrammatical, and it told the person nothing they did not already
know. Every skill in the fixture had `siteNodeId: null`, so that arm had never
once been evaluated. It now says **site-owned**, which is the part that decides
whether they can reach the ticket at all.

#### 2. The mutation table — nine deliberate breaks that the green suite ignored

Run against the delivered modules, in the shim, at the counts shown.

| # | mutation | before | after |
|---|---|---|---|
| V1 | `patternRows` stops computing `overlaps` at all | NOT CAUGHT | caught (V1) |
| V2 | the 24h limit becomes exclusive (a legal 24h shift is refused) | NOT CAUGHT | caught (V2) |
| V3 | a zero-length shift stops being refused | NOT CAUGHT | caught (V3) |
| V4 | `breakProblems` drops its `usable` filter | NOT CAUGHT | **NOT CAUGHT — INERT** |
| V5 | `crossesMidnight` boundary moves | NOT CAUGHT | caught (V5) |
| V6 | `describeSpan` marks the end only | NOT CAUGHT | caught (V6) |
| V7 | the path-cycle branch stops flagging truncation | NOT CAUGHT | caught (V1-ops) |
| V8 | an EXPIRING ticket with an unreadable skill row stops counting | NOT CAUGHT | caught (V2-ops) |
| V9 | a site-owned clash is described as company-wide | NOT CAUGHT | caught (V3-ops) |

**V4's verdict is INERT, and writing that down is the point of the column.**
`spansOverlap` guards empty ranges itself, and every comparison against `NaN` is
false, so no input exists where the `usable` filter changes an answer. It is
defensive duplication and it may stay. The case written for it pins what
actually matters — an unreadable bound surfaces as exactly one `"empty"`, never
as a phantom overlap and never silently dropped — and its comment says so
rather than claiming coverage it does not have.

**⚠️ Six NOT CAUGHT in one run is the signal §-standing says to distrust the
instrument over.** So a control was run in the same harness: `spansOverlap`
forced to always-false was **caught by 11 cases**, and the missing-parent branch
of `labelFor` by W23. The instrument was fine; the case list had holes.

#### 3. What the picture caught that the suite could not

The render is the three panels' **real** stylesheets over an element-by-element
transcription of their JSX, with every string computed by the lanes' own pure
modules and read in as JSON. Two findings came from looking at it, and neither
is expressible as an assertion:

- **A break's "Remove" was thrown to the far right edge** by the same `.spacer`
  the shift head uses — landing a few pixels from, and level with, the shift's
  own **Delete**. Two different destructive actions on one sight-line, one of
  them nowhere near the thing it removes. Inside a break row the spacer is now
  a plain gap; the right-hand rail belongs to the shift.
- **The pre-delete warning was `--muted`**, which measures **3.50:1** on
  `--surface` — under AA for 12px text, and this line is the sentence that says
  a delete is about to be refused. It is now `--ink-2` (6.7:1), matching
  `ProductsPanel`'s `.note`, which is the same class of line.

**And the first render was wrong about the panel, not about the CSS** — my
transcription had put the list header INSIDE the pattern row, so the shift list
appeared shoved into a grid column. Twenty minutes went into a layout defect
that did not exist. A transcription is evidence only to the degree it is
checked against the JSX line by line, and the first one was not.

#### 4. Verification

`tsc -b --force` 0, `eslint .` 0 errors 0 warnings, the D84 rem audit clean over
all 11 surfaces, all three suites re-run in the shim against the delivered
modules — **103 / 69 / 91** — and the nine mutations above re-run to confirm the
new cases kill them. **Acceptance 1030 → 1040 in 23 files. No migration.** ⚠️ **The file count moves too — 20 → 23** — and saying so matters: a case count that rises while the FILE count sits still is exactly what a test file failing to load looks like.

#### 5. Five findings NOT fixed here, because each needs a decision or a bigger change

**⚠️ 1. Every read in `src/lib/api/` is unbounded, and PostgREST caps them at
1000 rows — silently.** `supabase/config.toml` sets `max_rows = 1000`; there is
no `.range(` or `.limit(` anywhere in `src/lib/api/`. A capped response arrives
as **200 with no error**, so every `if (error) throw` passes and `skipped`
counts 0. At 500 people × 3 tickets the `operator_skills` read — which has no
`.order()` either, so *which* rows survive is arbitrary and changes between
refetches — starts dropping rows, and a person's Forklift going missing renders
a confident red ✕ reading "missing Forklift" for a place they are qualified for.
Drop a `node_skill_requirements` row instead and it renders a confident **✓** for
a place the server will refuse. **This is pre-existing and project-wide, not a
lane defect** — it is the same in the hierarchy and board reads — which is
exactly why it should be its own step rather than a patch inside this commit.

**2. `skipped` never reaches the thing that computes the answer.** The operators
read counts unparseable rows and shows a banner, but hands `workPlacesFor` the
shortened arrays with no flag. A row that was DROPPED is indistinguishable from
a row that does not exist, so the module's careful `complete: false` machinery
cannot fire for it. The fix is to thread `skipped > 0` into `WorkPlaceInput`.

**3. "Can't tell" is painted as a confident ✕.** `WorkPlace` carries `complete`
and `unnamed` so the screen can distinguish a refusal from an unanswerable
question; `PlaceRow` reads neither, and the stylesheet defines exactly two
states. Below the responsive breakpoint the reason column collapses entirely,
leaving a bare red cross with no explanation. A third mark is a design decision,
not a bug fix.

**4. `asOf` defaults to today**, so every ✓ is a promise about work booked
today, while the server compares against the real shift window — essentially
always in the future. Ana reads ✓ on 27 Aug and is refused for 5 Sep. Whether
the default should be the board's planning window is Pratik's call.

**5. `adminSiteIds` is derived from STRUCTURE ownership, not node grants.**
`editable_shape_ids()` answers "which structures may I edit"; the product
policies ask `app_is_admin_for(site_node_id)`, which never touches
`hierarchy_templates`. A site whose root has no claimed template — which 0020's
`having count(*) = 1` backfill deliberately creates for shared structures —
drops out of `adminSiteIds` while remaining fully writable server-side. The
error is one-directional and it is the CLOSED direction. Fixing it needs a read
of the grants themselves, which the client does not currently make.

### 19.65 Six things Pratik found by using the screens — and D103, what "belongs to" is going to mean (Aug 27, 2026)

The three sections went in front of him and came back with six notes in about
ten minutes. **Five of the six are things no test I could have written would
have found**, because each is about what the screen fails to OFFER rather than
about what it computes wrongly — and a suite only ever checks the things
somebody thought to build.

#### 1. Breaks were a sentence; they needed a table

*"Why are the breaks not in tabular form?"*

They were a flex row: name, clock span, duration, all at a different x on every
line. The two questions a person actually asks of a break list — **which is the
long one**, and **do these two collide** — both need reading down a column, and
there were no columns. Four fixed-width columns now, tabular figures, a header
per shift because the list is nested two levels in and `15m` beside
`08:00–08:15` otherwise reads as a second time rather than a duration.

**⚠️ And the first attempt was the same defect again.** `minmax(6rem, 1.6fr)`
for the name column stretched it to the panel's full width and put "Lunch" and
"10:00–10:30" six hundred pixels apart — a table whose columns are that far
apart is a flex row with extra steps, and it is exactly the disease that had
just been fixed on the *Remove* link. Fixed widths and `justify-content: start`.
**The render caught it; nothing else would have.**

#### 2. A break could only be deleted and retyped — and the write already existed

*"There is no option to edit an existing break, the only option is to remove it
completely and add again, not very user friendly."*

`useUpdateBreak` → `updateBreak` → `shift_breaks.update` was **built, exported,
covered by the write-error contract, and reachable from nothing on screen.** So
moving a break by five minutes meant a destructive action offered for a
non-destructive intent, and it silently lost the break's name.

**The tell is one the P1-5g review already named: dead state is the fingerprint
of a dropped requirement.** A dead *export* is the same fingerprint one level
up. `grep` for exported writers with no importer is a cheap check and this
project has now been bitten by the shape twice.

#### 3. Nothing said a pattern row opens

*"I pressed on an existing shift pattern to open the details, there is nothing
pointing towards that it can be done for a new user, they'll be clueless."*

The pattern name was a `<button>` with `border: 0; background: none` — pixel
identical to the plain text in the column beside it — and the entire shift list
of that pattern was behind it. He found it by clicking on the off-chance. A
caret that turns, an underline that darkens on hover and focus, and a
"show shifts" hint that appears on hover: one affordance in three parts.

**This is D90's rule arriving from the other direction.** D90 was "the screen
must say what a row IS"; this is "the screen must say what a row DOES". Both are
invisible to every assertion in the suite.

#### 4. Colour is now the user's to set (D102 amended)

*"No option to edit or assign colour for the user."*

D102 said a product's colour is chosen for it and never changes, and the reason
was good: a colour that moves on its own is a surprise, and one that moves
because someone re-assigned the product is worse. **That argument is about the
SYSTEM changing its mind. It says nothing about a person deciding.**

So: the automatic pick at creation stays exactly as it was, nothing re-picks on
a rename or a re-assignment, and **the swatch is now a button** that opens the
four-token palette. `setProductColor` is its own call rather than a field on
`updateProduct` — one write, one thing that can be wrong with it, so a colour
change cannot fail on a duplicate SKU.

**⚠️ And the hint under the form had to change in the same breath.** It ended
*"and never changes afterwards"*, which became false the moment the picker
existed. **A hint describing the old behaviour is worse than no hint: it tells
someone the control they are looking at does not exist.** ([[doc_drift]] rule 4
and rule 17's second bullet, on a user-facing string this time.)

**⚠️ One import was written and backed out.** `setProductColor` first validated
the token against `PRODUCT_PALETTE` by importing `isPaletteToken` from
`features/admin/lib/products` — which is the ONLY `src/lib/ → src/features/`
import in the repo, and a real runtime cycle, because that file imports its
types from `src/lib/api`. The narrow rule now lives beside the palette and the
panel applies it; the API layer documents why it does not.

#### 5. `addedProblems` moved out of the panel, and the mutation found a second hole

The break editor needed the same "only the problems THIS change caused"
validation the shift editor uses — which was **pure logic sitting in a `.tsx`
file where no test could reach it**, and which had carried the 27 Aug defect
(§19.64). It is now `shiftDraft.addedProblems`, with **group W, six cases**.
W3 is that defect pinned in the pure layer.

**Four mutations, and the third was not inert.** Dropping `field` from
`problemKey` went NOT CAUGHT — and it is a real hole, not a masked change: a
shift-name problem and a shift-time problem both carry
`(shiftIndex 0, breakIndex null)`, so without the field they key identically and
**a shift that already had a naming problem could be given an illegal time with
the save going through silently.** W6 is that case. This is the third time a
mutation has found a hole rather than a bug in code I had just written.

#### 6. Verification

`tsc` 0, `eslint` 0, the D84 rem audit clean over all 11 surfaces, the shift
suite re-run in the shim against the delivered module — **109** — and the four
`addedProblems` mutations re-run to confirm the new cases kill them. The three
panels re-rendered and read. **Acceptance 1040 → 1046 in 23 files. No
migration.**

---

### D103 — "Belongs to" becomes a SCOPE, not just an owner

*"The products/operators/shifts could belong to a particular hierarchy within
the plant and not necessarily to the whole plant... how do we assign them to a
specific hierarchy level so the lower levels inherit them?"*

Two things that sentence could mean were drawn and put to him, and **he chose
the larger one**: ownership decides **where a thing is offered**, not only who
may edit it. A product scoped to Line 1 is offered on every cell at or below
Line 1 and nowhere else; company-wide stays the everywhere fallback.

**⭐ AND OPERATORS ARE DELIBERATELY NOT PART OF THAT RULE (his call).** Where a
person may work is already answered by tickets and requirements. A second
mechanism that can disagree with `check_eligibility` would mean two systems
saying no for different reasons with nothing on screen able to reconcile them.
**An operator's scope filters the roster and nothing else** — who you see and
who you administer, never who may be assigned where.

**The shape, and why it is cheaper than it looks:**

1. **The migration is a WIDENING, so there is no backfill.** Every existing row
   holds `NULL` or a root node id, and both stay legal. The only change is that
   `app_check_site_owner` stops requiring `parent_id is null`. **Nothing in
   `UPGRADE_CHECKS` is owed** — but rule 5b says the argument for that is not
   the evidence, so it gets an upgrade case anyway.
2. **The permission half already works.** `app_is_admin_for(node_id)` takes any
   node and covers its subtree; only the trigger was forcing roots. No policy
   changes.
3. **Resolution is one predicate**: available at node X when the scope is NULL
   or `X.path <@ scope.path`. That is the same nearest-ancestor family
   `resolve_shift_template` already lives in.
4. **The board filters CLIENT-SIDE, from data it already holds.** `board_window`
   returns the whole org's products and skills and the client already has every
   node's `path`, so the migration adds `site_node_id` to those two payload
   objects and a pure `availableAt(scopeId, nodePath, nodes)` does the rest.
   **Filtering server-side is not an option**: one board window spans many
   nodes, so there is no single node to filter by.
5. **The pickers change from "roots only" to a depth-indented tree** — the
   `NodeAttachmentView` shape the shifts panel already builds is exactly that,
   so it is reused rather than rebuilt.

**⚠️ The one thing to decide while building it, not after: what a run ALREADY
carrying an out-of-scope product does.** Scoping the picker does not un-schedule
history, and it must not — a product moved to Line 1 tomorrow was legitimately
run on Line 2 yesterday. So the filter belongs to what is OFFERED, and every
read-back path must keep rendering a product it would no longer offer. That is
the same rule the retired-product list already follows, and it is the half a
"just filter the list" implementation gets wrong.

### 19.66 Migration 0025 — D103 built: "belongs to" is a scope, and a colour may be a colour (Aug 27, 2026)

Pratik picked meaning B off the drawing, then opened the app and found the thing
he had asked for was not there — because §19.65 had *recorded* D103 and built
nothing. **A decision written down and not built is indistinguishable, from the
screen, from a decision nobody made.** This is that, built.

#### 1. The migration is a widening, and that is the whole risk

`app_check_site_owner` loses exactly one branch: the one requiring
`parent_id is null`. Every existing row holds NULL or a root id and both stay
legal, so **nothing is backfilled** and **no policy changes at all** —
`app_is_admin_for(node_id)` has taken any node and covered its subtree since
0019, and only the trigger was forcing roots.

**⚠️ WHICH IS PRECISELY WHY THE TEST FILE IS SHAPED THE WAY IT IS.** A widening
is the one migration shape where a suite goes green over a change that went too
far: everything legal before is legal after, so every pre-existing case passes
no matter what. So **more than half of `52_scope_and_colour_test.sql` asserts
what must STILL BE REFUSED** — the org boundary (now the trigger's *only*
remaining branch, and therefore load-bearing rather than one of two), the
supervisor who is not an admin, the site admin reaching outside their grant, and
five near-miss colour spellings.

#### 2. Two existing cases went red, and both were rule 1b-ii

`51_`'s **Q12** asserted a mid-tree node is refused with `reason: 'not a root
node'`; **Q27** asserted a hex raises `23514`. Both were correct for as long as
the contract was what it was. **The cases were right and the contract changed** —
and both were rewritten in place rather than deleted, with the coverage they
were legitimately providing rescued: Q12 now pins the widening and points at Q13
(the org branch it used to share the work with), and Q27 walks four spellings
instead of one, so a CHECK widened into uselessness fails it.

#### 3. The colour union

`products_color_token_shape` becomes `product-N` **or** `#rrggbb`, lower case,
six digits, both anchored. **D102's argument survives untouched**: the four
tokens are still the presets, still what a new product is given, still the thing
that follows `tokens.css`. What is added is the case the palette cannot serve —
more than four products in one area that have to be told apart.

**⚠️ One canonical spelling per colour**, which is why `#FFF`, `#FFFFFF` and
`white` are all refused. The client is lenient about what a person *types*
(`normaliseHexInput` accepts `#1BAF7A`, `1baf7a`, `#1ba`, and trims) and strict
about what it *stores* — refusing a typed `#1BAF7A` with "that value isn't
allowed here" would be technically correct and indefensible.

**⚠️ And the hex is a FILL, never a text colour.** `RunBand` and `DirectBlock`
mix it into `--surface` at 16–22%; `AssignmentChip` uses it as a 3px border. So
there is no contrast obligation on a user-picked colour. There is also no theme
to adapt to — `tokens.css` defines no dark variant of `--product-N`. If one ever
lands, the four tokens follow it and a stored hex does not; that is the cost of
the freedom and 0025's §2 records it so nobody rediscovers it.

#### 4. Three copies of one rule, found while adding a branch to it

Turning a stored colour into CSS was written out in
`features/admin/lib/products.ts`, in `BoardGrid.tsx` and in `BoardToolbar.tsx` —
**with a comment on the board copies saying they were "kept in step with" the
admin one.** That sentence is the definition of a rule that is a habit rather
than a default, and D100 already measured what happens next.

Adding the hex arm is exactly the edit that would have made them disagree: a
hand-set colour correct on the admin screen and drawn as `--product-1` on the
board. **`src/lib/productColor.ts` is now the one place**, in `src/lib/` rather
than a feature because a board feature may not import from admin — which is
*why* the copies existed. D100's rule 2e, arriving a second time: the answer to
a mismatch is not "match them", it is "make it impossible to mismatch".

#### 5. The client mirror, and the direction it fails

`src/features/admin/lib/scope.ts` — `offeredAt`, `offeredHere`, `scopeOptions`,
`scopeLabel`, `scopePathLabel`. **26 cases; 9 mutations, all 9 caught.**

- **⚠️ IT IS A UNION, NOT NEAREST-ANCESTOR-WINS.** It looks identical to
  `resolve_shift_template` from a distance and is the opposite shape: a node
  runs ONE shift pattern, and OFFERS MANY products. Anyone reusing that
  function's `ORDER BY nlevel(...) DESC LIMIT 1` here would silently offer one
  product out of three. SQL case S10 and JS case X9 both exist to say so.
- **⚠️ THE PREFIX TEST IS ON LABELS, NOT CHARACTERS.** `plant1.line1` is a
  string prefix of `plant1.line10` and is not its ancestor. The fixture has both
  in it; mutation Y1 (a bare `startsWith`) is caught by three cases. Ten lines
  is not an exotic plant.
- **⭐ AND IT FAILS OPEN** — the opposite default from `canEditProduct`, and
  rule 8b is why. This decides what a list SHOWS, where a wrong "no" is
  invisible and permanent; that decides whether to offer a WRITE.

#### 6. `canEditProduct` flips to fail-open, closing §19.64's finding 5

The review wave measured that `adminSiteIds` — derived from `editable_shape_ids()`,
i.e. STRUCTURE ownership — is not the question the product policies ask, which is
`app_is_admin_for(site_node_id)` over node GRANTS. A site whose root has no
claimed structure (0020's `having count(*) = 1` backfill creates exactly that for
any shared shape) dropped out while remaining fully writable server-side.

**0025 made it worse before it made it better**: under D103 a scope can be any
node, so "is the scope one of my sites" is not even the right shape of question.

So the default flips, and **rule 8b is the reason: ask what the answer buys.**
When the fail-closed choice was made, a refused write said *"You need to sign in
to do that"* or silently did nothing. §19.63 changed that — it now reads *"You
don't have permission to change this."* **A wrong "yes" is one clear sentence; a
wrong "no" is still invisible.** Company-wide stays company-admin-only, because
that answer comes from the profile role with no grant lookup and there is
nothing to fail open about.

#### 7. Verification

**verify-db.sh exit 0.** `52_scope_and_colour_test.sql` **19 cases**,
`upgrade_0025_scope_widening.sql` **5**, database total **332 → 356**.
**15 mutations, none uncaught** — 12 killed by cases, one (S1) killing 52_'s
fixture outright, and two (S5, S10) failing the BUILD, which is the strongest
instrument there is. Both verdicts are recorded as such rather than as "caught",
because a mutation that stops the seed applying and a mutation a case notices are
different facts.

**⚠️ MUTATION S8 FOUND A REAL HOLE.** An unanchored hex arm went NOT CAUGHT:
every other spelling in case S14 fails on LENGTH as well as content, so none of
them could tell an anchored pattern from a "contains" one. `'teal #1baf7a'` is
the only input that separates them — and it is exactly what a paste from a
design tool looks like.

Client: `tsc` 0, `eslint` 0, rem audit clean, suites re-run in the shim —
**scope 26 / products 101 / shiftDraft 109 / operators 69** — and **11 client
mutations, all caught after two more holes were closed**: `normaliseHexInput`
accepting any six characters (every "not a colour" fixture failed on length too),
and `colorUnknown` flagging a legal hex (nothing asserted the flag for a hex
row). **Acceptance 1046 → 1082 in 24 files.**

#### 8. What is NOT in this migration, deliberately

**The operators' area rule.** Pratik corrected his earlier answer — he does want
people assignable to a level, because *"there are facilities where certain people
can only work in certain areas"* — and chose **refused by the server, with a
supervisor override that records a reason.** That is a change to
`check_eligibility` and `assign_operator`, and `assignments` already carries
`eligibility_override`, `override_reason` and `created_by` from 0003, so the
pattern exists and does not need inventing.

**⚠️ It should be a SECOND flag, not the existing one.** A supervisor overriding
"missing Welding" must not silently also place someone in an area they are not
cleared for; conflating them means the weaker override grants the stronger one.

**And the board's filtering.** `board_window` now REPORTS each scope and filters
nothing, which is the point: **narrowing what is OFFERED must never change what
the board can DRAW.** A product moved under Line 1 today was legitimately run on
Line 2 yesterday and that run has to keep rendering it. Case S18 exists to fail
the day someone moves the filter into the function.

---

### D104 — Trainings, not tickets (Pratik, Aug 27) — DECIDED, NOT BUILT

*"I don't like the name, it's something like Training, where is X person trained
and signed off to work. Maybe we need a section for trainings where the
supervisor can add trainings."*

He chose the largest of the three options: **rename, sign-off fields, and its own
section.**

- **The vocabulary changes and the schema keeps its names.** "Training" replaces
  "ticket" in every label; `skills` / `operator_skills` stay as they are. That is
  D90's precedent exactly — the UI says "site structure" and the database says
  `hierarchy_templates`.
- **What is genuinely missing is the RECORD.** `operator_skills` holds only
  `expires_at`. A training record wants **trained on**, **signed off by** (a
  named person, FK to `user_profiles`), and the expiry it already has. "Who
  signed this off" is the question an audit asks and the current table cannot
  answer at all.
- **Its own section**, so a supervisor manages the catalogue and sees who holds
  what — rather than the catalogue living behind a link inside Operators, which
  is where it is today.
- **⚠️ AND IT LANDS AFTER THE AREA RULE, NOT BEFORE.** Both touch
  `operator_skills` and the operators screen; the area rule is the one with a
  refusal path and an override to get right, and doing the rename first would
  mean renaming everything twice.

### D105 — What you can set once, you must be able to change (Aug 27, 2026)

*"Still no option to change the area for an existing operator, edit does not have
the option. No option to edit area for an existing product either. I've talked
about this a couple of times now, please let me know if I'm unclear about certain
instructions."*

He was not unclear. **I built the CREATE path three times and left the EDIT path
with fewer fields each time**, and did not see the pattern until the third
report. From where I was standing the feature worked — the picker was there, on
the form I had just finished.

#### 1. Why it kept happening, and why it is worse than a missing control

A create form without its matching edit does not merely lack a button. **It
asserts that the value is a property of the row's birth** — which for
where-something-belongs is simply false. A line gets reorganised and its
products have to follow it.

It had already happened once wearing different clothes: §19.65's break, which
could only be deleted and retyped while `updateBreak` sat exported and
unimported. Same defect, and I recorded the *instance* ("a dead export is the
fingerprint of a dropped requirement") without generalising the *rule*.

#### 2. What changed

`updateProduct`, `updateOperator` and `renamePattern` all take an optional
`siteNodeId`; all three edit forms carry the picker. **⚠️ Optional, and
`undefined ≠ null`**: `null` is a real value in this column (company-wide), so
"not supplied" cannot be spelled the same way as "move it company-wide", or a
rename that forgot the field would silently move the row.

**⚠️ AND `updateProduct`'S OWN COMMENT ARGUED AGAINST THIS.** It said, in
writing, *"Owner is set once, at creation"* — because moving a product between
owners would leave it holding a colour token drawn from the old owner's palette.
That was a real argument with a premise, and **0025 removed the premise**: a
colour can be set by hand now, so a possible collision is a reason to let someone
change the colour, not to freeze the owner. [[doc_drift]] rule 6 — when you
correct a premise, go back and re-examine the decision it was supporting.

**Shift patterns got it too, unasked**, because they had the identical gap and
he would have found it next.

#### 3. The rule becomes a test — group J, 7 cases

`scopeParityOffences` reads `src/lib/api/{products,operators,shifts}.ts` and
fails if any scoped table can SET `site_node_id` at creation and not CHANGE it
afterwards. **This is D89 and D100's move again: a rule that lives only as a
habit will be forgotten by the next component.**

**⚠️ AND THE AUDIT ITSELF FAILED TWICE BEFORE IT WORKED, both found by breaking
working code rather than by reading it:**

- **Instrument failure 42.** It sliced each write chain from the nearest `{`
  before `.from("products")` — which is the `{ data, error }` destructuring on
  the *same statement*, so the slice began AFTER the `patch` object three lines
  above. **It reported a real-looking failure about correct code.** The function
  is the unit that owns a write, so the function is the slice.
- **Then it could not fail at all.** With the slicing fixed, deleting the exact
  line the audit exists to protect left `site_node_id?: string | null` in the
  patch TYPE, and a plain `includes` read that as a write. **The audit reported
  nothing for the defect it was written to catch** — rule 3 arriving within the
  hour. `writesScopeColumn` strips type declarations first, and case J4 pins it.
- **And the rule had to become unconditional.** Written as "if it can be set it
  must be changeable", a module that could do *neither* reported no offence at
  all. J5 is that case.

**3 mutations of the audit, all caught. Acceptance 1082 → 1089 in 24 files.**

#### 4. Two things about how this was reported, which are also findings

**The gameplan's stage borders had drifted from its own chips.** The left border
comes from a class on the card and the DONE pill from a chip inside it — two
statements of one fact, kept in step by hand, so of course stage 16 read DONE
with an in-progress border for two sessions and every stage added after it did
the same. **That is D100's defect appearing in the document that describes
D100.** The class is now derived from the chip, computed for every card.

**And the 1000-row finding was written in jargon he could not act on** — *"I have
no idea what you need from me"*. It offered him a choice between paging and
refusing to render, which are both *how* and neither of which is a business
question. **Asking the user to arbitrate an implementation detail is not
consultation, it is offloading.** The card now says what I am going to do, in one
sentence, with the consequence in his terms ("about 350 people with three
trainings each"), and asks nothing. **The decision: page every read to
exhaustion, and where a screen COMPUTES rather than lists, refuse to show an
answer built on a read known to be short.**


---

## §19.67 — Four reports, one word: "Rename" was the only door to "Belongs to"

**Pratik, four times: *"I still cannot edit a product."*** Migration 0025 was in,
D105's create/edit parity was in, `updateProduct` took a scope, the row's editor
had a "Belongs to" picker, group J of `scaleAudit` was green, and the screen was
still, to him, a screen with no way to change where a product belongs.

**Three previous attempts read the code and concluded it was correct. They were
right about the code and wrong about the screen.** This one started by rendering
it.

### 1. What was actually on the screen

The panel was mounted in headless Chromium against fixtures taken from
`supabase/seed.sql` — the real `ProductsPanel`, the real `../lib/products` and
`../lib/scope`, with only the I/O leaves stubbed. Signed in as **Admin
(company)**, every catalogue row offered exactly three controls:

> `Deactivate` · `Rename` · `Delete`

**There is no control named "Edit" anywhere on the row, and the "Belongs to"
column is static text.** The picker, the code field and the name field all live
behind `Rename` — and `Rename` is a promise that only the name changes. A person
looking for a way to move a product to a line reads that row and correctly
concludes the product cannot be moved. He was never going to press it.

Press it and everything works: the editor opens with a code box, a name box, a
**Belongs to** select carrying `Everywhere (company-wide)` and every node
indented beneath it, and Save sends
`{id, sku, name, siteNodeId: "<node>"}` — the scope, key present, correct value.
**The feature was complete. The doorway was mislabelled.**

`ShiftsPanel` had the identical defect: its `{renaming ? "Cancel" : "Rename"}`
toggle opens a draft carrying the pattern's name **and its `Owned by` scope**.
`OperatorsPanel` did not — its equivalent button already said `Edit`, which is
exactly why the operator half of D105 stopped being reported and the product
half did not.

### 2. The fix

Both buttons now read **Edit**, with a `title` that names what is behind them
("Change its code, name, or where it belongs"). Nothing else in the write path
moved, because nothing else was wrong.

### 3. Why every test was green while he was blocked — and this is the bigger finding

**`scaleAudit` group J was written to make this exact defect impossible, and it
cannot see this screen at all.** `scopeParityOffences` opens three files —
`src/lib/api/products.ts`, `operators.ts`, `shifts.ts` — slices the text around
each `.from("products")`, and asks whether the substring `site_node_id` survives
inside a window that also contains `.update(`. Today `products.ts:212` satisfies
that, so the audit reports zero offences.

⚠️ **The audit would report zero offences with `ProductsPanel.tsx` deleted from
the repo.** It asks whether the DATA LAYER can express the change. Everything
between that and a person making the change — the hook, the panel, the
permission predicate, the feature flag, and the word on the button — was
unmeasured, because **no test in this repo mounted a single React component.**
24 test files, `jsdom` configured, `@testing-library/react` installed, an
`afterEach(cleanup)` in `src/test/setup.ts` waiting for a caller — and the only
file that imported the library called `renderHook`, never `render`.

**That is the second time this project has had a green test over a live
failure**, and both times the instrument was measuring the thing it could reach
rather than the thing that mattered. Group J is not deleted — the data-layer
parity rule is still worth holding — but it may never again be cited as evidence
that a user can do something.

### 4. `productsPanel.test.tsx` — the first test in this repo that mounts a component

Seven cases, and the load-bearing choice is that they look for controls **by
accessible name**, the way a person looks for them:

| | |
|---|---|
| T1 | every row offers a control named `Edit`, and none named `Rename` |
| T2 | that control opens a form carrying the `Belongs to` picker |
| T3 | the picker opens on the row's CURRENT scope, not a default |
| T4 | a company admin is offered company-wide and every node, indented |
| T5 | changing the picker and saving SENDS the new scope |
| T6 | a row left company-wide sends `null`, **with the key present** (`undefined ≠ null`) |
| T7 | a site admin gets a disabled `Edit` on a company-wide row, and is told why |

**Mutation table — 7 mutations, 7 caught, run in the browser against the real
component, plus one live inert control:**

| # | mutation | expected | verdict |
|---|---|---|---|
| M1 | the button says `Rename` again (**the shipped defect**) | T1 | CAUGHT |
| M2 | the edit row renders no picker at all | T2 T3 T4 T5 | CAUGHT |
| M3 | `beginEdit` seeds the draft scope as `""` instead of the row's | T3 | CAUGHT |
| M4 | `saveEdit` drops `siteNodeId` from the payload | T5 T6 | CAUGHT |
| M5 | company-wide is never offered, even to a company admin | T4 | CAUGHT |
| M6 | `editable` forced true | T7 | CAUGHT |
| M7 | **control: a comment word changed** | nothing | correctly NOT caught |

⚠️ **And the probe itself failed three times before it measured anything**, each
failure reading exactly like a broken screen. (i) React 19 renders roots
concurrently, so setting a module-global identity in a loop leaked the LAST
case's profile into all three panels — every row rendered disabled and the first
photograph was a picture of the wrong user. (ii) `flushSync` does **not** flush a
root's initial mount, so the next build read every host div while it was still
empty and scored **all seven checks FAIL against working code**. (iii) Under
`--virtual-time-budget` a `setTimeout` tick fires *before* React's scheduler
`MessageChannel` task, so a timer-based wait reads the same empty DOM.
**Seven simultaneous FAILs is the same signal as 28 simultaneous NOT CAUGHTs:
suspect the instrument, not the code** — that rule paid for itself three times in
one afternoon.

### 5. The other thing the render found, and it is not the label

**With the data as `seed.sql` leaves it, the Products screen is completely dead
for every admin who is not a company admin.** No product row in `seed.sql` names
a `site_node_id`, so all five are company-wide; `canEditProduct` returns false
for a company-wide row unless the caller's own profile role is `admin`; and Dana
and Quinn — the two site admins in `dev_demo.sql`, both org-wide `viewer` — see
four rows with every control greyed and the same sentence four times: *"Company-
wide — only a company admin can change this."*

**The client is right and the server agrees** (`products_update`'s `USING` and
`WITH CHECK` both demand `app_is_admin()` or a non-null scope they administer),
so this is not a permission bug. It is the demo data making a working screen
look broken to two of the three identities that can reach it — which is roadmap
item 6, and it is now worth more than it looked.

### D106 — a control may not be named after less than it does

**D105: what you can SET once, you must be able to CHANGE. D106 is its other
half: the control that opens the change has to say so.** A button labelled
`Rename` sitting beside a field called `Belongs to` is not an incomplete
affordance, it is a *false* one — it tells the person the other fields are not
there, and they stop looking. Four rounds of "I still cannot edit a product"
were spent on a screen where the answer was one press away behind a word that
promised something narrower.

The rule, and it is now T1: **when a control opens a form, its name must not be
narrower than the fields in that form.** If the form edits a name and a scope,
the button is `Edit`, not `Rename`. The audit that enforces it has to ask the
question the way a user asks it — by the name on the control — because every
audit that asked it of the module underneath answered "fine" for four rounds.

### §19.67 continued — the test I wrote to close this shipped broken, and the reason is the same shape as the defect

**Pratik ran it: 5 of the 8 cases failed.** `Test Files 1 failed | 24 passed (25)`,
`Tests 5 failed | 1091 passed (1096)`. `tsc` clean, `eslint` clean, `vite build` clean,
and **every one of the five failures was in `productsPanel.test.tsx`, all from one
helper line.** T1 (the label) and T7 (the site admin) passed — so the FIX was real and
the app was never in question. The test was.

```
TestingLibraryElementError: Found multiple elements with the role "textbox"
and name "Product code"
```

**⭐ WHY, AND IT IS RULE 2b §3 AGAIN IN A NEW COSTUME.** I verified the file in a
browser probe that found the row's boxes with `input[aria-label="Product code"]` — an
**attribute** match, which sees one element. Testing Library computes the
**accessible name**, and the *Add a product* card's field is labelled "Product code"
by its own visible `<label>`, so `getByRole` saw **two** and threw. The probe scored
**7/7 PASS on a file that could not run.** *"Which assertion does the shim implement
differently from the real one?"* — this time it was not the assertion, it was the
**query**, which is the half I had not thought to ask about.

**And the disagreement was hiding a real thing about the screen, not just about the
test.** With the row's boxes labelled plainly, opening an editor put **two controls
named "Product code" and two named "Belongs to"** on one screen with nothing to tell
them apart — which is precisely what someone using a screen reader has to resolve by
guessing. The row's controls are now named for their row (`Product code for WX`,
`Name for WX`, `Where WX belongs`), matching the convention the swatch button in the
same file already used. The Add card keeps the plain names, because its labels are
visible text and an `aria-label` that disagrees with a visible label is its own defect.
**T8 is the case that pins it**, and it asserts the count, not the absence.

**⭐⭐ THE PROBE NOW BUNDLES THE REAL `@testing-library/dom`** — `aria-query` and
`dom-accessibility-api` included, 197 modules, with only the failure-message
formatters stubbed. There is no longer a query semantics gap between what the probe
measures and what `vitest` will run. Three things that fell out of doing it, each of
which had looked like broken code:
- **Bare-specifier resolution created a SECOND React.** Once the bundler could resolve
  `require("react")` into `node_modules`, the component was built by one copy and
  rendered by another: *"Cannot read properties of null (reading 'useContext')"*.
  Vendored ids are now matched **before** node resolution.
- **The same widening silently un-stubbed `@tanstack/react-query`**, so every render
  died on *"No QueryClient set"*. A stub keyed by specifier is only a stub while the
  specifier is unresolvable — **widening a resolver disarms every stub it can now
  resolve**, and that is invisible until something throws.
- **One `try`/`catch` per stage.** `vitest` renders each `it` on its own, so one throw
  fails one case; a single promise chain lets one throw blank the whole table.

**Mutation table, re-run through the real matchers — 8 mutations, 8 caught, 1 live
inert control:**

| # | mutation | expected | verdict |
|---|---|---|---|
| **M8** | **the row's boxes go back to the plain `aria-label` — the state that actually shipped** | T2 T3 T4 T5 T6 T8 | **CAUGHT, and it reproduces Pratik's run exactly: 5 fail, T1 and T7 pass** |
| M1 | the button says `Rename` again (the original defect) | T1, and every stage that must press it | CAUGHT |
| M2 | the edit row renders no picker at all | T2 T3 T4 T5 | CAUGHT |
| M3 | `beginEdit` seeds the draft scope as `""` | T3 | CAUGHT |
| M4 | `saveEdit` drops `siteNodeId` from the payload | T5 T6 | CAUGHT |
| M5 | company-wide never offered, even to a company admin | T4 | CAUGHT |
| M6 | `editable` forced true | T7 | CAUGHT |
| M7 | **control: a comment word changed** | nothing | correctly NOT caught |

**M8 is the entry that matters.** Before this rewrite the probe scored it PASS; it now
scores it exactly as `vitest` did. **A verification instrument that cannot reproduce
the failure you already know about has not been tested — it has been agreed with.**

#### The other half of that run, which was noise and should have been checked first

`npm run format:check` reported **44 files** with style issues. **Forty-three of them
were already non-conforming and have nothing to do with this work** — the generated
`database.types.ts`, six `supabase/tests/mutations/*.json`, twelve test files, eight
`src/lib/api/` files, `NodeTreeEditor`, `SiteAccessPanel`, `BoardToolbar`. **I put
`format:check` into an acceptance block without ever having seen it pass**, which
turned a long-standing state into what looked like a wall of new failures, on the one
run where he was checking whether a four-times-reported defect was finally fixed.
`productsPanel.test.tsx` was the 44th and is now formatted. **An acceptance block is a
claim that these commands pass; do not add a command to it you have not run.**
