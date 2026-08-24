# Production Scheduler — Roadmap & Status

> **The living status file.** `design-plan.md` records *decisions*; this file records *state*.
> **Convention:** every working session — human, Fable, or Sonnet/Opus agent — updates this file when it completes or starts anything below. Agent briefs include this as a required final step.

**Last updated:** 2026-08-24 (**P1-4b delivered — create/move/resize, popovers, toasts.** Part A independently probed: 33 cases green, 7 mutations run, 6 caught by the probe + M5 by the agent's own extra case. Agent was killed by an org spend limit before reporting, so **no deviations list** — see design plan §18.5. **Part B never compiled: `npm` acceptance is the outstanding step.**) · **Current phase:** 1 — Core product

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
- [x] Pratik sign-off on v2.2/v2.3 → **Phase 0 CLOSED, UX spec frozen** (Aug 22). P1-4a builds against v2.3 as-is.

## Phase 1 — Core product (multi-tenant walking skeleton)

*Each unchecked item becomes one or more agent briefs in `docs/agent-briefs/` before build starts.*

- [x] Tech stack DECIDED (Aug 21): Supabase (Postgres+Auth+Realtime+RLS API) · React+TypeScript · static hosting (Vercel/Cloudflare Pages) · escape hatch to self-hosted documented in design plan §5
- [x] **Repo scaffold + CI** — Vite/React-TS + Supabase client + CI. Authored by agent Aug 21 (unvalidated, no npm in container); `npm install` + full acceptance run completed on Pratik's machine Aug 22: typecheck, lint, format:check, unit tests, build, and Playwright e2e all green, `npm audit` reports 0 vulnerabilities.
- [x] Database migrations from design plan §3/§14/§15/§16/§17 (incl. capacity trigger, shift tables, RLS policies) + seed scripts — **built and validated** (Sonnet, Aug 21) against a scratch PostgreSQL 16 instance; all 31 `docs/agent-briefs/p1-2-db-migrations-brief.md` §7 acceptance items pass via `scripts/verify-db.sh`. **Confirmed against real Supabase (Aug 22)**: all 9 migrations + seed applied cleanly via `supabase start` on WSL2/Docker, so the `auth.users` FK is real, not shimmed. `database.types.ts` generated from the live DB — all 17 tables and all 8 RPCs typed.
- [ ] Org onboarding settings pages (same pattern as ⚙ Shifts): hierarchy level editor + node tree editor + CSV import (operators, products, tree)
- [ ] Auth, profiles, subtree grants (admin / supervisor / viewer), RLS wiring
- [x] API layer, **database half** — `board_window` / `capacity_probe` / `check_eligibility` reads, `create_run` / `create_assignment` / `move_run` / `apply_split_coverage` / `delete_run` writes, machine-readable error contract (SQLSTATE + parsed `DETAIL` JSON) — **built, validated and mutation-tested** (Sonnet, Aug 22) via migration 0009 + `scripts/verify-db.sh`; all 28 `docs/agent-briefs/p1-3a-db-api-surface-brief.md` §8 acceptance items pass. **TypeScript half (P1-3b) also DONE Aug 22**: typed wrappers, `SchedulerError` union + parser, serde boundary, React Query hooks with optimistic rollback, dev sign-in, data-proof panel. Verified end to end in the browser.
- [x] Board UI: virtualized timeline grid (continuous dates), hierarchy rail, zoom-adaptive snap, shift/break rendering layer — **P1-4a code delivered, acceptance pending user run**
- [ ] Board interactions: hybrid create popover, move/resize both kinds, cross-cell run moves, split-coverage flow
- [ ] Left operator panel: roster, skills, assigned indicators, search — read-only half folded into P1-4a; drag-from-panel is P1-4b
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

**Before you start, get the local stack up** (order matters, and note which window each runs in):

1. Launch **Docker Desktop**. Wait for the whale icon to read "Running".
2. In the **Ubuntu / WSL** window:
   `cd /mnt/c/Users/prati/OneDrive/Documents/GitHub/production_scheduler && supabase start`
   (Only `supabase` commands run here. Studio: http://127.0.0.1:54323)
3. In **PowerShell**, from the same folder: `npm run dev` → http://localhost:5173
   (Only `npm` commands run here — `node_modules` holds win32-arm64 binaries that won't execute under Linux.)

**Then open the Claude session in this project folder** and paste:

> Continue the production scheduler. Read project memory, `docs/roadmap.md`, and `docs/design-plan.md` (especially §17–§17.4), then pick up at the next unchecked item. The local Supabase stack is already running.

That is all it needs. Project memory carries every decision, the workflow, the environment constraints, and the exact resume point; this file carries state; the design plan carries the reasoning.

**What does NOT carry over:** the in-session Sonnet agent (spawn a fresh one — every brief already names the files it must study first) and the cloud container's scratch Postgres (rebuilt by `scripts/verify-db.sh` in a couple of minutes).

**Known friction to expect, so it doesn't read as breakage:**

- Build agents cannot run npm (the cloud container's registry access is blocked by policy). Frontend briefs are authored by the agent and validated by Pratik: run the acceptance commands, tee the output to `checks.txt` in this folder, and Claude reads it directly rather than asking for a paste.
- Agents cannot delete files. They sometimes leave strays behind — including `.git/index.lock`, which blocks every git command until removed from PowerShell (`Remove-Item .git\index.lock`).
- Files an agent delivers land read-only; `chmod u+w` before editing one in place.

**Division of labour:** the design session (a high-reasoning model) does brainstorming, briefs, and verification only. Sonnet agents execute from judgment-free briefs in `docs/agent-briefs/`. Every completed step updates this file.

## Artifact index

| Artifact | Path | State |
|---|---|---|
| Design plan (decisions) | `docs/design-plan.md` | v1.5 (§18 board rendering, Aug 22) |
| This roadmap (state) | `docs/roadmap.md` | living |
| Mockup A / B (reference) | `docs/mockups/model-a.html`, `model-b.html` | frozen |
| Hybrid mockup (current) | `docs/mockups/model-hybrid.html` | v2.3 — **signed off Aug 22, frozen**; P1-4a ports its render engine |
| Agent briefs | `docs/agent-briefs/` | mockup-v2, v2.1, v2.2, v2.3 · p1-1, p1-2, p1-3a, p1-3b (all built) · **p1-4a (written, not built)** |
| App scaffold | repo root (`src/`, `supabase/`, `.github/`) | v1 (code complete, build/CI unvalidated) |
| Folder conventions | `docs/conventions.md` | v1 |
| Schema reference | `docs/schema.md` | v1 (P1-2, Aug 21) |
| DB migrations, seed, SQL tests | `supabase/migrations/`, `supabase/seed.sql`, `supabase/tests/` | v1 (P1-2, Aug 21) — built + validated; migration `20260821000009_api_surface.sql` and `60_api_test.sql` added (P1-3a, Aug 22) |
| Database API contract | `docs/api.md` | v1 (P1-3a, Aug 22) — DB half only; HTTP-status mapping unverified (no Docker/PostgREST here) |
| TypeScript API client guide | `docs/api-client.md` | v1 (P1-3b, Aug 22) — code delivered; no npm in delivery container, acceptance pending user run |

### Build output after `manualChunks` (Aug 24, first real measurement)

| chunk | raw | gzipped |
|---|---|---|
| app (`index`) | 40.15 kB | 14.05 kB |
| query | 47.32 kB | 14.75 kB |
| router | 94.32 kB | 31.81 kB |
| react | 180.98 kB | 56.86 kB |
| supabase | 219.90 kB | 57.42 kB |
| **total JS** | **582.67 kB** | **174.89 kB** |

Read this honestly: the pre-split baseline was 560 kB / 165 kB in one chunk, so **first-load bytes went slightly UP**, not down. `manualChunks` buys *caching granularity* — vendor chunks keep their hashes across deploys, so a board-code change re-downloads 40 kB instead of 560 kB — it does not defer anything, because every chunk is still imported by the entry. Actual first-load reduction needs route-level `React.lazy`, which belongs in a later brief. The genuinely good number: the whole board feature added only ~22 kB raw / ~6 kB gzipped to the app chunk.

## Phase 1 brief queue

Briefs are written by the design session (Opus) and executed by fresh Sonnet agents. Order matters — each assumes the previous one landed.

| # | Brief | Produces | State |
|---|---|---|---|
| P1-1 | `p1-1-repo-scaffold-brief.md` | Vite/React-TS app shell, Supabase client, CSS tokens ported from the mockup, ESLint/Prettier/Vitest/Playwright, GitHub Actions CI, `docs/conventions.md` | **built + validated** — all §6 acceptance items pass on Node 24 / Windows (Aug 22) after four config fixes: `engines` relaxed to `>=20`, `.nvmrc` → 24, vitest 2→4 (killed a duplicate-Vite type clash and all 5 audit findings), `tsconfig.node.json` emits declarations (TS6310), `typecheck` script dropped a redundant `--noEmit`, `.prettierignore` added for `docs/` |
| P1-2 | `p1-2-db-migrations-brief.md` | 8 migrations (core → capacity trigger → shifts → profiles → audit → RLS), `seed.sql` mirroring the mockup, SQL test suite + `scripts/verify-db.sh`, `docs/schema.md` | **built + validated** (Sonnet, Aug 21) — scratch PostgreSQL 16, all 31 §7 acceptance items pass; real Supabase/Docker confirmation of the `auth.users` FK still outstanding |
| P1-3a | `p1-3a-db-api-surface-brief.md` | Migration 0009: `board_window` / `capacity_probe` / `check_eligibility` reads, `create_run` / `create_assignment` / `move_run` / `apply_split_coverage` / `delete_run` writes, machine-readable error contract, `docs/api.md`, SQL tests + required mutation pass | **built + validated + mutation-tested** (Sonnet, Aug 22) — scratch PostgreSQL 16, all 28 §8 acceptance items pass via `scripts/verify-db.sh`; all 4 §9 mutations confirmed to break their named test and restored; PostgREST HTTP-status mapping unverified (no Docker) |
| P1-3b | `p1-3b-ts-api-layer-brief.md` | Typed RPC wrappers, `SchedulerError` union + parser, serde boundary, React Query hooks with optimistic update + rollback, dev profile sign-in, data-proof panel | **built + validated** (Sonnet + Pratik, Aug 22) — typecheck/lint/format/build clean, 68 unit tests pass, verified in-browser against local Supabase: Admin sees 7 cells, Ana 5, Marco 2. Four fixes after delivery, all traceable to gaps in the brief (see design plan §17.4) |
| P1-4a | `p1-4a-board-render-brief.md` | The read-only board: pure geometry/index layer (`src/features/board/lib/`), hand-rolled two-axis virtualization, hierarchy rail, shift/break layer, run bands + assignment chips/blocks, left operator panel (read-only half), zoom + collapse, `manualChunks` code-splitting. Replaces `BoardProof` wholesale | **Code delivered + design-session verified Aug 22.** Agent: 19 §12 cases pass, 6 §13 mutations all break their named case (M4/M6 needed supplementary cases the agent added — two real brief bugs). Design session then ran an **independent 23-case probe** (cold: all pass) and **7 unprescribed mutations** — 6 caught; deleting `buildBoardIndex`'s pre-`packLanes` sort passed silently, gap closed by a new test (§18.3). Scope fence, T1–T9, and the token/import rules verified by grep. **§15 `npm` acceptance RUN AND GREEN Aug 24** on Windows/Node 24: `format`, `lint`, `typecheck`, `build` all clean, **99 tests pass**, board renders. Two fixes applied after the first run — a dead `eslint-disable` on the T1 effect (its dep array was already complete) and the T2 zoom handler open-coding the minute↔pixel conversion instead of calling `pxToMinutes`/`minutesToPx` (brief-writing rule 4). **Outstanding: the 8 in-browser §15 checks, especially T2/T4/T7** |
| P1-4b | *not yet written* | Board interactions: hybrid create popover, move/resize both kinds, cross-cell run moves, split-coverage flow via `capacity_probe`, eligibility overrides, drag from the operator panel | blocked on P1-4a landing. Write it against the §10 transition list, extended for drag-in-flight cases |

Briefs build in the cloud container and deliver to this repo via a tarball through `_delivery/` (gitignored); no agent commits or pushes — review and commit yourself.

**New as of P1-4a:** frontend briefs are no longer wholly unverifiable. `node --experimental-strip-types` runs a `.ts` file with no runtime imports, so any pure, `import type`-only module can be executed and mutation-tested in the agent container despite the npm block. Shape future frontend briefs to put the load-bearing logic in such a module — see design plan §18.1.
