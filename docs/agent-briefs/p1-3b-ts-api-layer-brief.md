# Agent Brief P1-3b — TypeScript API Layer, Dev Auth, and a Data-Proof Panel

**Executor:** a fresh Sonnet agent (no prior context). **Phase:** 1, fourth build task.
**Depends on:** P1-1 (scaffold, now building clean), P1-2 + P1-3a (schema + RPCs, live in local Supabase), and generated `src/lib/database.types.ts`.
**Rules:** no design decisions of your own. Note assumptions; do not ask questions mid-run.

## 0. Read this first — you cannot run npm, and that is expected

This container's egress blocks the npm registry (**403 by policy** — also pip and apt). You cannot `npm install`, `npm run typecheck`, `npm test`, or start a dev server. Do not attempt it, do not hunt for mirrors, do not install anything.

That does **not** mean you should guess. `node_modules/` is already installed in the repo on the user's device, and the generated `src/lib/database.types.ts` is the authoritative contract. Read them. Everything you need to be exactly right is on disk.

Your deliverable is source code plus a §9 self-review you *can* perform by reading. The user runs the acceptance suite on his Windows machine and sends back the output. **Report every acceptance item as NOT RUN rather than inventing a result.** A previous brief on this project was reported honestly as blocked and that was the right call; a green checklist you did not execute is worse than no checklist.

## 1. Study first (in this order)

1. **`src/lib/database.types.ts`** — generated from the live database. The single source of truth for every argument and return type. Read the `public.Functions` block carefully.
2. **`docs/api.md`** — the P1-3a client contract: what each RPC does, the error-code table, which operations use RPC vs. plain PostgREST writes, and the worked split-coverage example.
3. **`docs/conventions.md`** — folder rules. Feature code may import from `src/lib`, `src/components`, `src/hooks`, `src/types`; never from another feature.
4. **`src/lib/supabase.ts`**, **`src/env.ts`**, **`src/components/AppShell.tsx`**, **`src/features/board/BoardPage.tsx`** — what already exists.
5. **`supabase/seed.sql`** — the three seeded profiles (Admin, Ana, Marco) and their fixed UUIDs.
6. **`docs/design-plan.md` §5** (optimistic edit flow, 409 handling), **§14.1** (hybrid rules), **§15.1** (split coverage).
7. **`docs/mockups/model-hybrid.html`** — the "Viewing as" profile switcher, for the dev sign-in UI in §7. You are not building the board.

Files are on the device at `C:\Users\prati\OneDrive\Documents\GitHub\production_scheduler` (`$HOME/mnt/production_scheduler` via `device_bash`). Stage with `device_stage_files` to read in the container.

## 2. What the generated types actually say — read this before designing anything

Two facts from `database.types.ts` shape the entire brief:

**Every RPC returns `Json`.** Postgres `jsonb` has no TypeScript structure, so the generated type is opaque. A wrapper that returns `Json` is not a typed wrapper — it just moves the `any` around. So §4 defines hand-written result interfaces, and §5's wrappers **narrow into them at runtime**, not by casting.

**`ltree` and `tstzrange` arguments are typed `unknown`.** PostgREST accepts them as strings and casts server-side. Wrappers take real TypeScript types (`string` for a path, `Date` for instants) and serialise at the boundary.

The exact generated signatures:

```ts
board_window:         { p_root_path: unknown; p_from: string; p_to: string }                    → Json
capacity_probe:       { p_operator_id: string; p_timerange: unknown; p_efficiency: number;
                        p_exclude_assignment_id?: string }                                       → Json
check_eligibility:    { p_node_id: string; p_operator_id: string; p_timerange: unknown }         → Json
create_run:           { p_node_id: string; p_product_id: string; p_timerange: unknown;
                        p_planned_headcount?: number; p_notes?: string }                         → Json
create_assignment:    { p_node_id: string; p_operator_id: string; p_run_id: string;
                        p_product_id: string; p_timerange: unknown; p_efficiency?: number;
                        p_target_qty?: number; p_target_unit?: string;
                        p_eligibility_override?: boolean; p_override_reason?: string }           → Json
move_run:             { p_run_id: string; p_node_id: string; p_timerange: unknown }              → Json
apply_split_coverage: { p_adjustments: Json; p_new_assignment: Json }                            → Json
delete_run:           { p_run_id: string; p_mode?: string }                                      → Json
```

Note `create_assignment` types `p_run_id` and `p_product_id` as required `string`, but the database requires **exactly one of them** to be non-null (`num_nonnulls(run_id, product_id) = 1`). The generated types cannot express that. Your wrapper must: take a discriminated union input (`{kind: "run", runId}` or `{kind: "direct", productId}`), and pass `null` for the unused one, casting at the single call site with a comment explaining why. Do not push that `null` handling onto callers.

## 3. Deliverables

```
src/lib/api/
├─ errors.ts        SchedulerError union + parser
├─ shapes.ts        result interfaces + runtime narrowing guards
├─ serde.ts         tstzrange / ltree / numeric serialisation helpers
├─ board.ts         board_window, capacity_probe, check_eligibility
├─ mutations.ts     create_run, create_assignment, move_run,
│                   apply_split_coverage, delete_run, plain-table updates
└─ index.ts         re-exports (the only path features import from)

src/features/board/hooks/
├─ useBoardWindow.ts
├─ useRunMutations.ts
└─ useAssignmentMutations.ts

src/features/auth/
├─ DevProfileSwitcher.tsx + .module.css   dev-only sign-in (§7)
└─ useSession.ts

src/test/
├─ errors.test.ts
├─ shapes.test.ts
├─ serde.test.ts
└─ fixtures/postgrest-errors.ts

supabase/seed.sql        AMENDED — passwords for the three dev users (§7)
docs/api-client.md       NEW — how a feature consumes this layer
```

Do not touch the board grid, do not add realtime subscriptions, do not add a dependency. The stack is fixed: React Query v5, Zustand, supabase-js v2. **No zod** — write hand-rolled type guards; a runtime-validation library is a stack decision nobody has made.

## 4. The error contract (`errors.ts`)

P1-3a raises typed failures with a machine code in `DETAIL` as JSON. supabase-js surfaces PostgREST errors as `{ message, details, hint, code }`, where `details` is that JSON **as a string**.

```ts
export type SchedulerErrorCode =
  | "capacity_exceeded" | "not_eligible" | "run_overlap"
  | "run_node_mismatch" | "not_permitted" | "invalid_argument";
```

Define a discriminated union on `kind`:

- `CapacityExceeded` — `operatorId`, `peak: number`, `cap: number`, `timerange: string`
- `NotEligible` — `operatorId`, `nodeId`, `missingSkills: SkillRef[]`, `expiringSkills: SkillRef[]`, `policy: "warn" | "block"`
- `RunOverlap` — `nodeId`, `timerange`, `conflictingRunId`
- `RunNodeMismatch` — `assignmentNodeId`, `runNodeId`, `runId`
- `NotPermitted` — `nodeId`
- `InvalidArgument` — `field`, `reason`
- `RaceLost` — the bare `23P01` exclusion-constraint violation on `runs`. `docs/api.md` documents this as "you lost the race": the client should refetch and retry **once**. Give it its own kind so a hook can act on it without string-matching.
- `Unauthenticated` — PostgREST 401/permission-denied on a function.
- `Unknown` — everything else. Carries the original error verbatim.

One parser, `toSchedulerError(err: unknown): SchedulerError`, is the **only** place that touches raw PostgREST shapes. It must survive, without throwing: `details` absent · `details` present but not JSON · `details` valid JSON with an unrecognised `error` value · a plain `Error` · a network failure with no `code` · `null`/`undefined`. Every one of those falls through to `Unknown` with the original preserved. **A parser that throws while parsing an error turns a handled failure into a crash** — that is the single most important property of this file, and §8 tests each case.

Also export `isSchedulerError(e): e is SchedulerError` and a `describeSchedulerError(e): string` returning a supervisor-readable sentence (`"Maria would reach 150% of capacity (limit 100%)"`), so UI code never assembles error prose itself.

## 5. Wrappers (`board.ts`, `mutations.ts`)

Every wrapper: call `supabase.rpc(...)`, and on `error` throw `toSchedulerError(error)`. On success, run the result through the matching guard from `shapes.ts` and return the narrowed type; if the guard fails, throw an `Unknown` SchedulerError naming the RPC and what was missing — a shape mismatch is a real bug and must be loud, never silently coerced.

`serde.ts` owns the boundary conversions:

- `toTstzRange(start: Date, end: Date): string` → `["2026-08-24T06:00:00.000Z","2026-08-24T14:00:00.000Z")` — half-open, matching every range in the database.
- `parseTstzRange(s: string): { start: Date; end: Date }` — must handle `[`/`(` and `]`/`)` bounds and quoted timestamps.
- `toEfficiency(percent: number): number` — the UI speaks percent (mockup uses `eff: 50`), the database stores `numeric(4,3)` (`0.500`). Convert in exactly one place; round to 3 decimals.
- `fromEfficiency(value: number): number` — the inverse.

Round-tripping is tested in §8. Getting this wrong means an operator at 50% is stored at 50000%, and the capacity trigger's `efficiency <= 2` check would be the only thing catching it.

`shapes.ts` defines the interfaces matching what P1-3a's functions actually return (read `docs/api.md` for each): `BoardWindow` (with `org`, `levels`, `nodes`, `runs`, `assignments`, `operators`, `products`, `skills`, `nodeSkillRequirements`, `shiftTemplates`, `nodeShiftMap`), `CapacityProbe`, `EligibilityResult`, `CreateRunResult`, `CreateAssignmentResult`, `MoveRunResult`, `SplitCoverageResult`, `DeleteRunResult`.

**Convert snake_case to camelCase at this boundary**, in the guards, so no snake_case leaks past `src/lib/api/`. React code should never read `node_id`.

## 6. Hooks (`src/features/board/hooks/`)

Query keys — one convention, exported as a `boardKeys` object so nothing hand-builds a key:

```ts
boardKeys.window(rootPath, from, to) // ["board","window",rootPath,fromISO,toISO]
```

`useBoardWindow(rootPath, from, to)` — `useQuery`, `staleTime: 30_000`, `retry: (count, err) => !isSchedulerError(err) && count < 1`. Never retry a typed scheduler error: a capacity rejection is an answer, not a flake.

Mutation hooks follow one optimistic pattern, and all of them do the same four things:

1. `onMutate`: `cancelQueries` on the affected board key, snapshot the cached `BoardWindow`, apply the change locally, return the snapshot as context.
2. `onError`: restore the snapshot, then rethrow so callers can branch on the typed error.
3. `onSettled`: `invalidateQueries` on that key.
4. Never swallow an error to keep the UI tidy.

Two behaviours are specified rather than left to judgment:

- **`useCreateAssignment` does not auto-retry a `CapacityExceeded`.** It rolls back and surfaces the typed error carrying `peak`/`cap`/`operatorId`, which is exactly the payload the split-coverage popover needs. Opening that popover is P1-4's job; your job is to make the data available without a second round trip.
- **`useMoveRun` retries exactly once on `RaceLost`**, after invalidating the board query, then gives up and surfaces the error. Once — not a loop.

## 7. Dev sign-in — required, because RLS means nothing works signed-out

`board_window` is `SECURITY INVOKER` and `anon` has `EXECUTE` revoked. Signed out, the app can read nothing. The seed inserts three `auth.users` rows with fixed UUIDs but **no passwords**, so they cannot sign in.

**Amend `supabase/seed.sql`** (append; do not restructure it) to give those three users usable local credentials. Set `encrypted_password = crypt('devpassword', gen_salt('bf'))` (pgcrypto is already installed), plus `email_confirmed_at = now()`, `aud = 'authenticated'`, `role = 'authenticated'`, and an `instance_id` of all zeros, matching how GoTrue writes rows locally. Emails: `admin@example.test`, `ana@example.test`, `marco@example.test`. Wrap it so re-running the seed is safe. Add a comment stating loudly that this is **local development only** and must never reach a hosted project.

**`useSession.ts`** — wraps `supabase.auth.getSession()` and `onAuthStateChange`, exposing `{ session, profile, loading }`, where `profile` is the caller's `user_profiles` row (readable under RLS by its own policy).

**`DevProfileSwitcher.tsx`** — a header control mirroring the mockup's "Viewing as" dropdown: pick Admin / Ana / Marco, sign in with that email and the shared dev password, show who is active, offer sign out. Render it **only** when `import.meta.env.DEV` is true, so it cannot ship. Style from tokens; keep it small.

Real auth — a proper sign-in page, password reset, invitations — is a later brief. This is the minimum that makes RLS-gated data visible while developing, and it doubles as a live demonstration that the subtree grants work: Ana sees five cells, Marco sees two, Admin sees seven.

## 8. Tests (Vitest, run by the user)

`errors.test.ts` — the parser against `fixtures/postgrest-errors.ts`, which holds realistic PostgREST error objects for **all six** machine codes plus: missing `details`, non-JSON `details`, unrecognised `error` value, bare `23P01`, a 401, a plain `Error`, and `null`. Assert the discriminated kind and every extracted field, and assert the parser never throws on any input.

`serde.test.ts` — `toTstzRange`/`parseTstzRange` round-trip including a range crossing midnight and one spanning a DST boundary in a non-UTC zone; `toEfficiency(50) === 0.5`, `toEfficiency(100) === 1`, `toEfficiency(37.5) === 0.375`, and round-trip stability.

`shapes.test.ts` — each guard accepts a valid payload (build fixtures from the real shapes in `docs/api.md`) and rejects: a missing top-level key, an array where an object belongs, and `null`.

No integration tests. You cannot reach the user's local Supabase, and a mocked integration test would only assert that your own mock matches your own code.

## 9. Your self-review (you CAN do all of this by reading)

Perform each and report the result explicitly:

1. Every RPC wrapper's arguments match `database.types.ts` exactly — name for name, optional for optional. Quote the generated signature next to yours for each of the eight.
2. No file under `src/features/` imports from another feature.
3. No snake_case identifier appears outside `src/lib/api/`. Grep and paste the result.
4. `toSchedulerError` has no code path that can throw — walk it and state why each branch is safe.
5. Nothing imports `database.types.ts` outside `src/lib/`.
6. No new dependency appears in `package.json`.
7. `DevProfileSwitcher` is unreachable in a production build — show the guard.
8. Every `supabase.rpc` call site is inside `src/lib/api/`.

## 10. The visible proof — a temporary panel on BoardPage

Replace `BoardPage`'s placeholder with a small panel that calls `useBoardWindow` for the seeded week and renders **counts and a plain list**: node count by level, run count, assignment count, operator count, and a simple table of the schedulable cells with each one's resolved shift template name. Include the signed-in profile's name and role.

This is deliberately not a board — no grid, no drag, no timeline. It exists so the user can see real rows from Postgres in the browser, and so switching profiles visibly changes what comes back (Admin 7 cells, Ana 5, Marco 2). Mark it clearly in the code as temporary and state that P1-4 replaces it wholesale.

Handle the three states honestly: loading, error (render `describeSchedulerError`), and signed-out (prompt to pick a dev profile).

## 11. Acceptance — the user runs this, not you

Include this block verbatim in your report so he can paste it:

```powershell
npm run typecheck
npm run lint
npm run format:check
npm run test
npm run build
```

Then: `supabase db reset` in the Ubuntu/WSL window (needed for the amended seed), then `npm run dev` in PowerShell, and in the browser at `localhost:5173`:

1. Signed out → the panel prompts for a dev profile.
2. Sign in as **Admin** → 7 cells, 8 runs, 12 assignments, Assembly cells showing `3 × 8h` and CNC cells `2 × 10h`.
3. Switch to **Ana** → 5 cells (Assembly only), fewer runs. Switch to **Marco** → 2 cells (CNC only).
4. No console errors.

## 12. Delivery

Build in the container, deliver to the device: tar `src/`, `supabase/seed.sql`, and `docs/api-client.md` **only** — never the whole `docs/` folder, and never `node_modules/` — then `SendUserFile` → `device_commit_files` to `…\production_scheduler\_delivery\api-client.tar.gz` → `device_bash` to extract in place → `git status --short`.

Two device gotchas, both hit before on this project: files extracted from a tarball land read-only, so `chmod u+w` before patching one in place; and `device_commit_files` can be refused outright by Windows Controlled Folder Access — if it is, do not retry the same path, write via `device_bash` heredoc instead and say so.

Write `docs/api-client.md` and the roadmap edit with `device_bash` heredocs so `docs/` is only added to. **Do not commit or push. Do not run any npm command.**

## 13. Required final step

Edit `docs/roadmap.md`: update the P1-3b row of the Phase 1 brief queue to "code delivered, acceptance pending user run", refresh **Last updated**, and add `docs/api-client.md` to the artifact index. Leave every other row alone.

## 14. Report format

Report: the full file tree you created · your §9 self-review, item by item, with the evidence · the §11 acceptance block for the user · every assumption where this brief was silent · anything left undone. Mark all §11 items **NOT RUN — no npm in container**. Do not estimate whether they would pass.
