# Production Scheduler — Design Plan

**Status:** Draft v2.1 · August 25, 2026 (v1 Aug 18 · §14–15 Aug 20 · §16 shifts Aug 21 · §17 build decisions Aug 21 · §18 board rendering Aug 24 · §19 hierarchy admin Aug 25 · **§19.12 P1-5b verification + D78/D79 · §19.13 whitespace parity + D80 · §19.14 P1-5c + D81/D82 · §19.15 a second org + the cross-tenant leak (D83) · §19.16 scaling is the default (D84) · §19.17 the create_node regression 0012 caused and the harness that hid it (D85) · §19.18 hierarchy templates — a shape per site (D86) · §19.19 the level lookup D86 forgot to move (D87, OPEN)** Aug 25)
**Phase:** 1 — Core product. DB schema (P1-2), API surface (P1-3a/b), the board UI (P1-4a–e) and the hierarchy admin database + client + screens layers (P1-5a/b/c/d) are built and verified by independent design-session probes. **The SQL is at migration 0014; the CLIENT SIDE OF D86 is not written yet — see §19.18.**
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
