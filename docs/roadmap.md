# Production Scheduler — Roadmap & Status

> **The living status file.** `design-plan.md` records *decisions*; this file records *state*.
> **Convention:** every working session — human, Fable, or Sonnet/Opus agent — updates this file when it completes or starts anything below. Agent briefs include this as a required final step.

**Last updated:** 2026-08-22 (P1-1 scaffold now BUILDS and fully passes acceptance — npm unblocked on Pratik's machine; P1-2 + P1-3a database built, validated and mutation-tested) · **Current phase:** 1 — Core product

---

## Phase 0 — Design & mockups

- [x] Core brainstorm: hierarchy, data model, real-time, cost posture (Aug 18)
- [x] Design plan v1 — schema validated on live PostgreSQL 16 (Aug 18)
- [x] Mockups v1: Model A (product on block) + Model B (runs + staffing) (Aug 18)
- [x] A/B decision → **hybrid** (both coexist; profile sets default gesture) (Aug 20)
- [x] Design plan v1.1 — efficiency %, window-total target, profiles/subtree grants, continuous timeline (Aug 20)
- [x] Mockup v2: hybrid board, 3-day scroll, efficiency, target, Viewing-as profiles (Sonnet-built, Aug 20)
- [x] Design plan v1.2 — capacity model (peak `sum(eff)` ≤ cap, trigger validated), cross-cell run moves, left operator panel (Aug 20)
- [x] **Mockup v2.1** — left operator panel + assigned indicators, cross-cell run moves, split-coverage popover (Sonnet-built, Aug 20)
- [x] Pratik sign-off on v2.1 interaction set (Aug 21)
- [x] Shift definitions model decided + validated: templates → shifts → breaks, attached to any node, nearest-ancestor inheritance, overnight wrap (design plan §16, Aug 21)
- [x] Past-edit policy default confirmed: always-open + audit (org lock setting later)
- [x] **Mockup v2.2** — shift boundaries + break bands on rows, snap-to-shift at Compact zoom, full-shift quick actions, admin shift editor (Sonnet-built, Aug 21)
- [x] **Mockup v2.3** — shift template CRUD: create/rename/delete templates, add/remove shifts per template, dynamic line→template assignment (Sonnet-built, Aug 21)
- [ ] Pratik sign-off on v2.2/v2.3 → Phase 0 closes, UX spec frozen

## Phase 1 — Core product (multi-tenant walking skeleton)

*Each unchecked item becomes one or more agent briefs in `docs/agent-briefs/` before build starts.*

- [x] Tech stack DECIDED (Aug 21): Supabase (Postgres+Auth+Realtime+RLS API) · React+TypeScript · static hosting (Vercel/Cloudflare Pages) · escape hatch to self-hosted documented in design plan §5
- [x] **Repo scaffold + CI** — Vite/React-TS + Supabase client + CI. Authored by agent Aug 21 (unvalidated, no npm in container); `npm install` + full acceptance run completed on Pratik's machine Aug 22: typecheck, lint, format:check, unit tests, build, and Playwright e2e all green, `npm audit` reports 0 vulnerabilities.
- [x] Database migrations from design plan §3/§14/§15/§16/§17 (incl. capacity trigger, shift tables, RLS policies) + seed scripts — **built and validated** (Sonnet, Aug 21) against a scratch PostgreSQL 16 instance; all 31 `docs/agent-briefs/p1-2-db-migrations-brief.md` §7 acceptance items pass via `scripts/verify-db.sh`. Real Supabase/Docker confirmation (the `auth.users` FK the scratch harness only shims) still outstanding.
- [ ] Org onboarding settings pages (same pattern as ⚙ Shifts): hierarchy level editor + node tree editor + CSV import (operators, products, tree)
- [ ] Auth, profiles, subtree grants (admin / supervisor / viewer), RLS wiring
- [x] API layer, **database half** — `board_window` / `capacity_probe` / `check_eligibility` reads, `create_run` / `create_assignment` / `move_run` / `apply_split_coverage` / `delete_run` writes, machine-readable error contract (SQLSTATE + parsed `DETAIL` JSON) — **built, validated and mutation-tested** (Sonnet, Aug 22) via migration 0009 + `scripts/verify-db.sh`; all 28 `docs/agent-briefs/p1-3a-db-api-surface-brief.md` §8 acceptance items pass. **TypeScript half is brief P1-3b** (typed wrappers, `SchedulerError` union, TanStack Query hooks) — blocked until `npm install` works, same as P1-1.
- [ ] Board UI: virtualized timeline grid (continuous dates), hierarchy rail, zoom-adaptive snap, shift/break rendering layer
- [ ] Board interactions: hybrid create popover, move/resize both kinds, cross-cell run moves, split-coverage flow
- [ ] Left operator panel: roster, skills, assigned indicators, search
- [ ] Real-time: per-site channels, optimistic edits, conflict reconciliation, presence
- [ ] Audit log on all schedule mutations
- [ ] E2E test pass (Playwright) + load sanity (hundreds of rows, thousands of assignments)

## Phase 2 — Scheduling depth

- [ ] Skills matrix admin UI + eligibility enforcement (warn/block org policy)
- [ ] Certification expiry checks vs assignment dates
- [ ] Copy Week with dry-run conflict preview
- [ ] Named templates (relative-time placements)
- [ ] Shift admin UI in product (templates/breaks editor, node attachment) + target keep-or-scale prompt on resize
- [ ] PTO/absence source decision + conflict surfacing

## Phase 3 — Scale & integration

- [ ] ERP/MES connector framework + first adapter (SAP) over the CSV upsert pipeline
- [ ] Multi-site hardening: archive job, per-site channel fan-out review, load tests
- [ ] Subtree permission grants admin UI
- [ ] Mid-hierarchy level-insertion migration tool
- [ ] Standard targets from routing data; efficiency vs actuals (needs MES data)
- [ ] Operator mobile read-only view

## Open questions (not blocking unless marked)

| # | Question | Status |
|---|---|---|
| 1 | ~~Shift definitions~~ — decided §16; rotating patterns deferred to Phase 2/3 | closed Aug 21 |
| 2 | Past-edit lock policy (v1 default: always-open + audit) | default chosen; org setting later |
| 3 | Capacity cap > 1.0 as org policy (overtime-style overload) | default 1.0; setting exists in design |
| 4 | PTO/absence data source (in-app vs HR sync) | Phase 2 |
| 5 | Changeover/setup time as explicit run phases | Phase 2/3 |
| 6 | Standard targets from product routing | Phase 3 |
| 7 | Operator mobile view scope | Phase 3 |
| 9 | Break-aware math (net targets/capacity of break time?) | v1: display-only; revisit with Q6 |

## Resuming work in a new session

1. Start the session in this project folder (`production_scheduler`) — project memory carries the decisions and workflow.
2. Tell Claude: **"Continue the production scheduler. Read project memory, docs/roadmap.md, and docs/design-plan.md, then pick up at the next unchecked item."**
3. What does NOT carry over between sessions: the in-session Sonnet agent (spawn a fresh one; every brief already tells it which files to study first) and the scratch Postgres instance (rebuilt from the design plan's SQL in minutes when needed).
4. Fable = design/briefs/verification; Sonnet = execution from `docs/agent-briefs/`. Every completed step updates this file.

## Artifact index

| Artifact | Path | State |
|---|---|---|
| Design plan (decisions) | `docs/design-plan.md` | v1.3 |
| This roadmap (state) | `docs/roadmap.md` | living |
| Mockup A / B (reference) | `docs/mockups/model-a.html`, `model-b.html` | frozen |
| Hybrid mockup (current) | `docs/mockups/model-hybrid.html` | v2.3 |
| Agent briefs | `docs/agent-briefs/` | mockup-v2, v2.1, v2.2, v2.3 · **p1-1 (scaffold), p1-2 (migrations, built)** |
| App scaffold | repo root (`src/`, `supabase/`, `.github/`) | v1 (code complete, build/CI unvalidated) |
| Folder conventions | `docs/conventions.md` | v1 |
| Schema reference | `docs/schema.md` | v1 (P1-2, Aug 21) |
| DB migrations, seed, SQL tests | `supabase/migrations/`, `supabase/seed.sql`, `supabase/tests/` | v1 (P1-2, Aug 21) — built + validated; migration `20260821000009_api_surface.sql` and `60_api_test.sql` added (P1-3a, Aug 22) |
| Database API contract | `docs/api.md` | v1 (P1-3a, Aug 22) — DB half only; HTTP-status mapping unverified (no Docker/PostgREST here) |

## Phase 1 brief queue

Briefs are written by the design session (Opus) and executed by fresh Sonnet agents. Order matters — each assumes the previous one landed.

| # | Brief | Produces | State |
|---|---|---|---|
| P1-1 | `p1-1-repo-scaffold-brief.md` | Vite/React-TS app shell, Supabase client, CSS tokens ported from the mockup, ESLint/Prettier/Vitest/Playwright, GitHub Actions CI, `docs/conventions.md` | **built + validated** — all §6 acceptance items pass on Node 24 / Windows (Aug 22) after four config fixes: `engines` relaxed to `>=20`, `.nvmrc` → 24, vitest 2→4 (killed a duplicate-Vite type clash and all 5 audit findings), `tsconfig.node.json` emits declarations (TS6310), `typecheck` script dropped a redundant `--noEmit`, `.prettierignore` added for `docs/` |
| P1-2 | `p1-2-db-migrations-brief.md` | 8 migrations (core → capacity trigger → shifts → profiles → audit → RLS), `seed.sql` mirroring the mockup, SQL test suite + `scripts/verify-db.sh`, `docs/schema.md` | **built + validated** (Sonnet, Aug 21) — scratch PostgreSQL 16, all 31 §7 acceptance items pass; real Supabase/Docker confirmation of the `auth.users` FK still outstanding |
| P1-3a | `p1-3a-db-api-surface-brief.md` | Migration 0009: `board_window` / `capacity_probe` / `check_eligibility` reads, `create_run` / `create_assignment` / `move_run` / `apply_split_coverage` / `delete_run` writes, machine-readable error contract, `docs/api.md`, SQL tests + required mutation pass | **built + validated + mutation-tested** (Sonnet, Aug 22) — scratch PostgreSQL 16, all 28 §8 acceptance items pass via `scripts/verify-db.sh`; all 4 §9 mutations confirmed to break their named test and restored; PostgREST HTTP-status mapping unverified (no Docker) |
| P1-3b | *not yet written* | TypeScript half of the API layer: typed RPC wrappers, `SchedulerError` union, generated `database.types.ts`, TanStack Query hooks with optimistic update + rollback | **UNBLOCKED** (npm works as of Aug 22) — ready to brief |
| P1-4 | *not yet written* | Board UI: virtualized grid, hierarchy rail, shift/break layer — ports the mockup engine to React. Fold in `manualChunks` code-splitting; the empty shell is already 548 kB / 161 kB gzipped | **UNBLOCKED** — ready to brief after P1-3b |

Both briefs build in the cloud container and deliver to this repo via a tarball through `_delivery/` (gitignored); neither agent commits or pushes — review and commit yourself.
