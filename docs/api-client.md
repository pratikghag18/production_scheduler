# Consuming the TypeScript API layer

Written for whoever builds on top of brief **P1-3b** (the board grid,
P1-4, and beyond). This is the feature-author's view: what to import, what
each hook does, and how to handle the typed errors. For the underlying RPC
contract itself (what each function does, its error codes, the worked
split-coverage example) see `docs/api.md` — this document doesn't repeat
that, it explains the TypeScript wrapper on top of it.

## The one import path

Every feature imports from `@/lib/api` — never reach past it into
`src/lib/api/errors.ts` / `shapes.ts` / `serde.ts` / `board.ts` /
`mutations.ts` directly, and never import `@/lib/database.types` from
feature code. `database.types.ts` is the generated contract that
`src/lib/api/` itself is built from; nothing downstream should need it, and
nothing downstream should ever see a `snake_case` field — every wrapper and
hook converts at the `src/lib/api/` boundary.

```ts
import {
  useBoardWindow,
  useCreateRun,
  useCreateAssignment,
  useMoveRun,
  useApplySplitCoverage,
  useDeleteRun,
  isSchedulerError,
  describeSchedulerError,
} from "@/lib/api";
```

(The two hooks-only exports, `useBoardWindow`/`useCreateRun`/etc., actually
live under `src/features/board/hooks/` per `docs/conventions.md`'s
feature-first rule — import them from there, e.g.
`@/features/board/hooks/useBoardWindow`. Everything else —
`SchedulerError`, `isSchedulerError`, `describeSchedulerError`,
`toEfficiency`/`fromEfficiency`, the result types like `BoardWindow` — comes
from `@/lib/api`.)

## Reading the board

```tsx
import { useBoardWindow } from "@/features/board/hooks/useBoardWindow";

const { data, status, error } = useBoardWindow(rootPath, from, to);
// status: "pending" | "error" | "success" (TanStack Query v5)
```

`rootPath` is a plain string node path (e.g. `"plant_1"` or
`"plant_1.assembly"`) — no serialisation needed, PostgREST accepts `ltree`
as a string. `from`/`to` are `Date`s; the hook handles the `tstzrange`
conversion internally. `data` is a fully camelCased `BoardWindow` — see
`src/lib/api/shapes.ts` for the exact interface (`org`, `levels`, `nodes`,
`runs`, `assignments`, `operators`, `products`, `skills`,
`nodeSkillRequirements`, `shiftTemplates`, `nodeShiftMap`).

`staleTime` is 30s and a typed `SchedulerError` is never auto-retried — see
"Errors" below.

## Mutating

Every write goes through a hook, never through `supabase.rpc`/`supabase.from`
directly (those calls live only in `src/lib/api/board.ts` and
`src/lib/api/mutations.ts`). Every mutation hook follows the same
optimistic-update shape: it applies the change to the cached `BoardWindow`
immediately, rolls back on error, and invalidates the query once the
request settles — so most call sites just need `.mutate(input)` /
`.mutateAsync(input)` and a way to show the error if one comes back.

```tsx
const createAssignment = useCreateAssignment(rootPath, from, to);

createAssignment.mutate({
  nodeId,
  operatorId,
  target: { kind: "run", runId }, // or { kind: "direct", productId }
  start,
  end,
  efficiencyPercent: 50, // UI percent — see "Efficiency" below. Omit for the DB default (100%).
});
```

`target` is a discriminated union (`{ kind: "run"; runId }` or
`{ kind: "direct"; productId }`) because the database requires **exactly
one** of `run_id`/`product_id` to be set — the generated RPC types can't
express that (`docs/agent-briefs/p1-3b-ts-api-layer-brief.md` §2), so the
wrapper resolves it internally. Callers never pass `null` themselves.

Two mutation behaviours are intentional, not bugs:

- **`useCreateAssignment` never auto-retries a `CapacityExceeded`.** It
  rolls back and hands you the typed error, which carries `operatorId`,
  `peak`, and `cap` — exactly what a split-coverage popover needs to open
  pre-populated (`docs/api.md` §3's worked example). Building that popover
  is a later brief's job; this layer just makes the data available without
  a second round trip. If you want to probe capacity *before* committing
  (to open the popover proactively instead of reacting to a rejection), call
  `probeCapacity` from `@/lib/api` directly.
- **`useMoveRun` retries exactly once** if the write loses the race against
  another writer (`RaceLost` — a bare Postgres `23P01` on the exclusion
  constraint, `docs/api.md` §1: "you lost the race"). It refetches the
  board first, then retries the same move once. A second failure of any
  kind (including another `RaceLost`) surfaces to the caller — it does not
  loop.

The plain-field-edit hooks (`useUpdateRunFields`, `useUpdateAssignmentFields`)
cover the simple cases `docs/api.md` §4 documents as ordinary PostgREST
writes rather than RPCs — a run's `notes`/`plannedHeadcount`, an
assignment's `efficiencyPercent`/`targetQty`/`targetUnit`/`status`, or a
plain resize (`timerange`) that doesn't change node. Don't call
`supabase.from(...).update(...)` yourself for these; the wrapper is what
keeps the snake_case/camelCase boundary and the efficiency conversion (see
below) in one place.

## Efficiency: always pass a percent

Every place a hook or wrapper takes an efficiency value, it takes it as a
**UI percent** (`50` for 50%, matching the mockup's `eff: 50`) —
`efficiencyPercent` on `CreateAssignmentInput`, `SplitAdjustment`, and
`AssignmentFieldEdit`. The percent -> `numeric(4,3)` conversion happens in
exactly one function, `toEfficiency` (`src/lib/api/serde.ts`), which every
one of those call sites uses. **Never multiply/divide by 100 yourself** —
call `toEfficiency`/`fromEfficiency` from `@/lib/api` if you need the
conversion outside a wrapper (e.g. to display a stored `0.500` as `50%` in
a UI label: `fromEfficiency(assignment.efficiency)`). Getting this wrong
is the one mistake that's silent at the type level and wrong at the
database: an operator meant to be at 50% ends up stored as `50.000`
(50,000%) instead of `0.500`.

## Errors

Every failure from a wrapper (RPC or plain-table write) arrives as a typed
`SchedulerError` — never a raw PostgREST/Postgres error, and the parser
that produces it (`toSchedulerError`, `src/lib/api/errors.ts`) is
guaranteed not to throw, so a network blip or an unrecognised shape falls
through to `{ kind: "Unknown" }` rather than crashing the mutation.

```tsx
if (createAssignment.isError) {
  const err = createAssignment.error; // already a SchedulerError
  if (isSchedulerError(err) && err.kind === "CapacityExceeded") {
    // err.operatorId, err.peak, err.cap, err.timerange — open the split-coverage popover
  } else if (isSchedulerError(err)) {
    showToast(describeSchedulerError(err));
  }
}
```

`describeSchedulerError` returns a supervisor-readable sentence for any
`SchedulerError` — use it instead of assembling error prose in UI code.
One limitation worth knowing: `CapacityExceeded`/`NotEligible` only carry
`operatorId` (a uuid), not a display name — the error layer has no access
to the operators list to resolve one. If you have the board's operator list
loaded, look the name up yourself for a nicer message; otherwise the id is
what you get.

The full `SchedulerError` kind list: `CapacityExceeded`, `NotEligible`,
`RunOverlap`, `RunNodeMismatch`, `NotPermitted`, `InvalidArgument`,
`RaceLost`, `Unauthenticated`, `Unknown`. See `src/lib/api/errors.ts` for
every kind's exact fields.

`useBoardWindow`'s retry policy never retries a typed `SchedulerError` — a
capacity rejection or a permission error is an answer, not a flake. Only an
`Unknown`-shaped (network-ish) failure gets React Query's normal single
retry.

## Auth (dev only)

`src/features/auth/useSession.ts` exposes `{ session, profile, loading }`.
`profile` is the caller's `user_profiles` row (`id`, `orgId`, `userId`,
`role`, `defaultCreateMode`) — it's `null` while signed out or before the
row loads.

`src/features/auth/DevProfileSwitcher.tsx` is a **temporary, dev-only**
"Viewing as" control (rendered only when `import.meta.env.DEV`) that signs
in as one of the three seeded profiles with a shared local password. It
does not exist in a production build. A real sign-in flow is a later
brief's scope.

## What this layer does not do

- No realtime subscriptions (design-plan §5's channel architecture is a
  later brief).
- No board grid, no drag interactions — `BoardPage`/`BoardProof` are a
  temporary data-proof panel (brief P1-3b §10), not the board.
- No zod or other runtime-validation dependency — the guards in
  `shapes.ts` are hand-rolled per the brief's explicit stack constraint.
