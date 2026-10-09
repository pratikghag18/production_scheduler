# S41-c — "Move Sam on Cell 1 to Cell 2 in Line 1": the typed MOVE command, and the server function it needs

_Brief for one Sonnet build lane and one Sonnet review lane. Written 11 Sept 2026 (session 146)
by the developer session after S41-a and S41-b landed. Third of the three commands the maintainer
ordered after assign (session 139). Stage S41; requirement R-389. Background, in order:
`p1-7a-typed-command-bar-brief.md` §2, `f-132-the-bar-sees-your-own-block-brief.md` §2 and §6,
`s41-a-book-a-job-brief.md` §2–§3, `s41-b-unassign-brief.md` §2–§3, and for the server half
`f-131-a-join-stays-inside-its-run-brief.md` §2 (extract, never retype; how a migration is
applied on this machine). Read the CURRENT `parse.ts`, `resolve.ts`, `CommandBar.tsx`,
`CreatePopover.tsx`, `useDragGesture.ts`, `BoardPage.tsx`, `mutations.ts`,
`useAssignmentMutations.ts` and `errors.ts` before writing a line; this brief names
identifiers, never line numbers. EDIT files in place; never rewrite a whole file (S41-a's lane
lost the parser's private-use quote sentinels that way)._

## §1. What this is, in the product's words

Two sentences, one command. *"Move Sam on Cell 1 to 10 to 3"* changes the hours of Sam's block
on Cell 1 — that is R-385's "change it" path, reached by a sentence that says so directly
instead of by re-typing an assign sentence. *"Move Sam on Cell 1 to Cell 2 in Line 1"* moves
Sam's block to another cell with the same hours (or *"… to Cell 2 from 10 to 3"* with new
ones). No screen can do the second today: a chip drag is same-row only (D66), and the only
cross-cell writer is `move_run`, for a whole job. So the second half needs ONE new server
function, `move_assignment`, in the family of `reassign_assignment` (0057, the person changes)
and `move_run` (the job changes cell): the block changes cell and hours, and the server asks
every question a new placement is asked — permission on both cells, training, absence and the
area rule under the target's policy, capacity by the existing trigger — and detaches the block
from its run on the way (a run lives on one cell; on the new cell the block is direct with the
run's product, exactly as a detach drag does). On the screen the move opens the SAME "New"
pop-up on the target cell, preset with the person, the part and the hours, and the pop-up's
one door sends `move_assignment` instead of `create_assignment`; every box the pop-up shows
(training, area, leave) is the same box, and Enter moves when there is nothing to decide
(R-384). The old block disappears when the row moves — it is the same row.

## §2. ⛔ THE RULES

- **The server function is written by a script that assembles it from `reassign_assignment`'s
  last definition (0066, `grep -in "function \(public\.\)\?reassign_assignment(" supabase/migrations/*.sql`,
  the LAST hit that is a `CREATE`, not the `comment on function` line — 0066 has both; read the
  file around the hit) and asserts on the assembled text** that every guard survived
  (`an area override must say why`, `assignment not found`, `app_can_edit_node`,
  `check_eligibility`, `absence_overlap`, `an eligibility override must say why`, `GET
  DIAGNOSTICS v_rows = ROW_COUNT`, `the assignment was not written`) and that the new ones are
  present exactly once (`p_node_id`, `p_timerange`, `run_id = NULL`, `edit rights required on
  both source and target node`). Migration `20260911000080_move_assignment.sql`, append-only.
- **Apply it to the running dev stack by `psql` into `supabase_db_production_scheduler`** (never
  `supabase migration up`, never `db:reset`); then `npm run db:types` — the signature is NEW,
  so `src/lib/database.types.ts` MUST change and `tsc` is inconclusive until it has.
- **No second door on the client.** The pop-up gains a `presetMove` and its submit sends
  `moveAssignment` through a new `useMoveAssignment` hook in `useAssignmentMutations.ts` in the
  exact shape of `useReassignAssignment` (optimistic patch of `nodeId`, `timerange`, `runId`,
  `productId`, the overrides; snapshot and rollback as there). `CommandBar.tsx` imports nothing
  from the API; the purity audit stays green.
- **The move-in-time half adds no path:** it resolves to R-385's `retime` target and the bar's
  existing `onRetime`.

## §3. The server — `move_assignment`

```sql
CREATE OR REPLACE FUNCTION public.move_assignment(
  p_assignment_id uuid,
  p_node_id uuid,
  p_timerange tstzrange,
  p_eligibility_override boolean DEFAULT false,
  p_override_reason text DEFAULT NULL,
  p_area_override boolean DEFAULT false,
  p_area_override_reason text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp' AS $function$
```

Body, assembled from `reassign_assignment`'s with these substitutions and insertions, in order:
1. Argument checks: `p_assignment_id` required; `p_node_id` required; `p_timerange` non-empty
   (copy `create_assignment`'s check verbatim); the area-override-must-say-why check as is.
2. `SELECT * INTO v_row … WHERE id = p_assignment_id`; not found → `invalid_argument` as is.
3. Permission on BOTH cells: `IF NOT app_can_edit_node(v_row.node_id) OR NOT
   app_can_edit_node(p_node_id) THEN api_raise('not_permitted', 'edit rights required on both
   source and target node', jsonb_build_object('node_id', p_node_id))` — `move_run`'s wording.
4. The person: `v_operator := v_row.operator_id`; if NULL (a departed person's row, D110) →
   `api_raise('invalid_argument', 'a departed person''s block cannot be moved',
   jsonb_build_object('field', 'p_assignment_id', 'reason', 'operator is null'))`.
5. Eligibility and absence exactly as `reassign_assignment`, but against `p_node_id` and
   `p_timerange` (the TARGET placement), the operator being `v_operator`.
6. The effective product: `v_product := COALESCE(v_row.product_id, (SELECT product_id FROM runs
   WHERE id = v_row.run_id))`; when the row was attached and the run's product is NULL (a
   deleted product, D110) → `api_raise('invalid_argument', 'the run''s product is gone',
   jsonb_build_object('field', 'p_assignment_id', 'reason', 'no product to carry'))`.
7. The UPDATE: `node_id = p_node_id, timerange = p_timerange, run_id = NULL, product_id =
   v_product, eligibility_override = v_use_override, override_reason = …, area_override =
   p_area_override, area_override_reason = …` with the same `GET DIAGNOSTICS` / `v_rows = 0`
   refusal and the same `RETURN jsonb_build_object('assignment', …, 'eligibility', …, 'absence', …)`.
   `assignments_scope_guard` (the area rule, D113) and `assignments_capacity` fire on this UPDATE
   as on any; `assignments_resize_guard` (0070) will re-ask eligibility and absence — a double
   check that agrees, as 0070's header explains for the other writers; `assignments_run_consistency`
   is satisfied because `run_id` becomes NULL. Say in the header which triggers fire and why each
   agrees.
8. `GRANT EXECUTE … TO authenticated` as the other writers have (read how 0057 grants; copy).
9. A `comment on function` naming 0057/0066 as the base and this brief.

`docs/api.md`: a `move_assignment` section in the shape of `reassign_assignment`'s, with its
raises (`invalid_argument`, `not_permitted`, `not_eligible`, `absent`, `not_offered_here` from the
trigger, `capacity_exceeded` from the trigger).

### `supabase/tests/97_move_assignment_test.sql`

In 79's shape (its own plant, its own week, every refusal as `authenticated` with a jwt sub,
the row photographed before and compared after). Cases: MA0 premises (the function exists and
carries `run_id = NULL`); MA1 a direct block moves cell and hours: the row reads back on the new
cell with the new window, every other column unchanged (79's RA1 photograph); MA2 a run-attached
block moves: `run_id` NULL and `product_id` the run's product afterwards; MA3 the same hours, a
new cell only; MA4 the same cell, new hours only (the function does not care which changed);
MA5 target cell requires a training the person lacks under BLOCK → `not_eligible`, row
unchanged; MA6 the same under WARN without an override → `not_eligible`; with the override and a
reason → moved, `eligibility_override` true; with the override and no reason → `invalid_argument`
naming `p_override_reason`; MA7 the person is absent over the target window under BLOCK →
`absent`, row unchanged; MA8 the person belongs to another area than the target cell → the
trigger's `not_offered_here` without an area override; with `p_area_override` and a reason →
moved; MA9 a viewer (a read grant only) → `not_permitted`; an editor of the source cell but not
the target → `not_permitted` (build the grants so the two cells differ); MA10 capacity: the
person already at 100% on another cell over the target window → `capacity_exceeded`, row
unchanged; MA11 unknown assignment id → `invalid_argument`; a departed person's row →
`invalid_argument` naming the reason; MA12 the same call twice: the second is a no-op move
that succeeds and changes nothing (idempotent). Breakages on a scratch copy of the migration,
rebuilding each time: X1 drop the target-cell permission check → MA9's second case red; X2 keep
`run_id` instead of NULLing it → MA2 red (and `assignments_run_consistency` may raise — record
what happened); X3 eligibility asked against the SOURCE cell → MA5 red.

## §4. The client shapes

### `mutations.ts`, `useAssignmentMutations.ts`

`MoveAssignmentInput { assignmentId; nodeId; start: Date; end: Date; eligibilityOverride?;
overrideReason?; areaOverride?; areaOverrideReason? }`; `moveAssignment(input)` calls the RPC
and parses with `parseCreateAssignmentResult` (same envelope). `useMoveAssignment(rootPath,
from, to)` mirrors `useReassignAssignment` (optimistic: `nodeId`, `timerange` as the API's
range string is built elsewhere — read how `updateAssignmentFields`'s optimistic patch writes
`timerange` and do the same; `runId: null`; `productId` the effective one is unknown on the
client for a run-attached row — leave `productId` untouched optimistically and let the refetch
settle it, say so in a comment). `errors.ts` needs no new code (every refusal above already
exists).

### `parse.ts`

```ts
export interface MoveCommand {
  intent: "move";
  operator: string;
  place: string[];                       // WHERE the block is now
  toPlace: string[] | null;              // the new cell, or null for a move in time only
  day: DayWord | null;
  span: { start: ClockTime; end: ClockTime } | null;   // new hours, or null = keep
  /** Which block, when several match; null until asked. */
  existing: { kind: "move"; assignmentId: string } | null;
}
```
At least one of `toPlace` / `span` must be present, else `no_move` (a new `ParseFailure`).
Grammar, first word `move` (and `shift`? — no: `shift` is a noun everywhere in this app; `move`
only):
```
move <operator> (on | at | from) <place> { (in | on | at | ,) <place> }
     [to <place> { (in | ,) <place> }]        -- the new cell
     [on <day>]
     [to <time> (to | - | – | until | till) <time>  |  from <time> (…) <time>]
```
Read back to front: the time clause is the LAST `from <time> <sep> <time>` OR the last `to
<time> <sep> <time>` at the end (try `from` first, then `to`); then the day word; then the verb;
then the middle: split on the FIRST ` on ` / ` at ` / ` from ` into operator and the rest; the
rest splits on ` to ` into the current place(s) and the new place(s), each then split on the
place separators as today. `formatCommand` prints `move <person> on <cell> [in <line>] [to
<cell> [in <line>]] [on <day>] [from HH:MM to HH:MM]` (always `from` for the hours when
printing). `expectedShape()` gains a fourth clause: `— or: move <person> on <cell> [in <line>]
[to <cell> [in <line>]] [on <day>] [from <time> to <time>]`.

### `resolve.ts`

`ResolvedMove { intent: "move"; assignmentId; nodeId /* target */; operatorId; productId;
range; target: { kind: "retime" } | { kind: "move_cell" }; readout }`. The path: 1 the
current cell (shared step), 2 the person (shared), 3 the day (shared) and the block: with hours
given, the block(s) of that person on that cell overlapping the sentence's DAY (not the new
hours — the new hours are the destination); without hours, the same over the whole day. 0 →
`no_block` (reuse the unassign question); >1 and no answer → `move_which` (a new question in
`remove_which`'s shape, buttons `Move <part> <label>`); exactly 1 or answered → the block. 4 the
destination: `toPlace` null → `target: retime`, `range` = the new hours on that day; `toPlace`
given → the new cell by the shared cell step (a second `resolveCellStep` call), the part must be
offered there (`offeredAt`, else `not_offered`), `range` = the new hours if said else the block's
own `startMin/endMin`, `target: move_cell`, `nodeId` the new cell. Readout: `"Moving Sam Patel's
Housing A block · Plant 1 › Assembly › Line 1 › Cell 1 · 2026-09-03 · 10:00–14:00 → Cell 2 ·
10:00–14:00"` (the arrow part names what changes: the cell, the hours, or both).

### `CommandBar.tsx`, `BoardPage.tsx`, `useDragGesture.ts`, `CreatePopover.tsx`

- Bar: one new prop `onMove(resolved: ResolvedMove, anchor)`. The bar's `runCommand` for
  `intent === "move"` calls it for BOTH targets (keep the types honest: do not build a
  `ResolvedCommand`-shaped call to reach `onRetime`), and `BoardPage` dispatches on
  `resolved.target.kind`:
  `retime` → `dragApi.retimeAssignmentFromCommand({ assignmentId, range, anchor })` (exists);
  `move_cell` → `dragApi.openMoveFromCommand({ assignmentId, nodeId, range, operatorId,
  productId, anchor })` (new).
- Hook: `openMoveFromCommand` sets the create popover with `presetOperatorId`,
  `presetProductId`, `presetMove: { assignmentId }`, `autoCreate: true`, on the TARGET node and
  range. `PopoverState`'s create member gains `presetMove?: { assignmentId: string }`.
  `submitMove(nodeId, range, assignmentId, overrides…)` calls `useMoveAssignment`'s
  `mutateAsync` the way `reassignAssignment` does (no toast; the pop-up prints refusals) —
  read `reassignAssignment` in the hook and mirror it.
- Pop-up: when `presetMove` is set, direct mode forced (as `presetOperatorId` already does),
  the operator select fixed to the preset (read-only line "Moving Sam Patel's block"), the
  product select preset, and `submitDirect()` calls `onSubmitMove(nodeId, range,
  presetMove.assignmentId, eligibilityOverride, overrideReason, areaOverride,
  areaOverrideReason)` instead of `onSubmitDirect`; `clean` unchanged in meaning (the same six
  verdicts, now about the target cell), so Enter moves when clean. The capacity probe: read
  what `submitCreateDirect` does before `createAssignment` (the probe and the split pop-up) —
  a move sends no probe (the trigger refuses over capacity and the pop-up prints it, as a
  reassign does); say so in a comment and in `docs/api.md`.

## §5. Files

Server: the migration, `supabase/tests/97_move_assignment_test.sql`, `docs/api.md`,
`src/lib/database.types.ts` (regenerated). Client: `src/lib/api/mutations.ts`,
`src/features/board/hooks/useAssignmentMutations.ts`, `src/lib/command/parse.ts`,
`src/lib/command/resolve.ts`, `src/features/board/components/CommandBar.tsx`,
`src/features/board/components/CreatePopover.tsx`, `src/features/board/hooks/useDragGesture.ts`,
`src/features/board/BoardPage.tsx`. Tests: `commandParse.test.ts` (MV1–MV10),
`commandResolve.test.ts` (RM1–RM10), `commandBar.test.tsx` (CM1–CM3),
`createPopover.test.tsx` (AC12–AC14: presetMove forces direct with the person fixed; Enter
calls `onSubmitMove` once under StrictMode with a click's arguments; an ineligible target
opens the training box and calls nothing), `dragGesture.test.ts` (D10: `openMoveFromCommand`
sets the popover with `presetMove` and `autoCreate` on the target node), a new
`src/test/moveAssignment.test.ts` for the API function's argument mapping and result parsing
(mock `supabase.rpc` the way the sibling API tests do — find one). `commandPurity.test.ts`
unchanged.

Parser cases: MV1 `Move Sam on Cell 1 to Cell 2 in Line 1` → toPlace `["Cell 2","Line 1"]`,
span null; MV2 `move Sam on Cell 1 in Line 1 to 10 to 3` → toPlace null, span 10:00–15:00; MV3
`move Sam on Cell 1 to Cell 2 from 10 to 3` → both; MV4 `move Sam on Cell 1` → `no_move`; MV5
`move Sam to Cell 2` → `no_place`; MV6 `move on Cell 1 to Cell 2` → `empty`; MV7 `move Sam at
Cell 1 on tomorrow to Cell 2` → day tomorrow; MV8 quoted names atomic; MV9 round trips of
MV1–MV3; MV10 the shape sentence; plus the three regression pins (assign, book, unassign
unchanged). Resolver cases: RM1 the move in time → `retime`, readout with the arrow naming the
hours; RM2 the move in place with the block's own hours; RM3 both; RM4 the part not offered at
the new cell → `not_offered` naming the NEW cell; RM5 no block → `no_block`; RM6 two blocks →
`move_which`, and the answer picks one; RM7 the new cell ambiguous (two "Cell 1"s) →
`ambiguous` place for the destination; RM8 a stale answer re-asks; RM9 the sentence's hours
on the day are the destination, the block is found by the DAY (a block 10–14 moved "to 16 to
18" is found even though 16–18 does not overlap it); RM10 the three regression pins.

## §6. Mutations

| id | mutation | must be caught by |
| --- | --- | --- |
| M50 | the server asks eligibility against the source cell | MA5 |
| M51 | the server keeps `run_id` | MA2 |
| M52 | the server checks permission on the source cell only | MA9 (second case) |
| M53 | `moveAssignment` sends `p_node_id` as the source | moveAssignment.test.ts |
| M54 | the resolver finds the block by the new hours instead of the day | RM9 |
| M55 | `toPlace` null resolves to `move_cell` | RM1 |
| M56 | the pop-up's `submitDirect` under `presetMove` calls `onSubmitDirect` | AC13 |
| M57 | `openMoveFromCommand` omits `presetMove` | D10 |
| M58 | the parser reads `to 10 to 3` as a place | MV2 |

## §7. Acceptance

1. `bash scripts/run-sql-test.sh --rebuild`; `97_…`; then `79_…`, `88_…`, `57_…` unchanged — tallies copied.
2. The migration applied to the running stack by `psql`; `npm run db:types` — `database.types.ts`
   MUST show the new function; `npx tsc -b --force` clean after that.
3. `npx vitest run` on the named test files — counts copied. `eslint` and `prettier --check
   --end-of-line auto` on every touched file clean.
4. §3's X1–X3 and §6 filled in. No full `npm run test`; no commit; no browser claims.

## §8. Report — as before, plus the sentinel-bytes confirmation for `parse.ts`.

## §9. The review lane

Break it: (1) diff the assembled function against `reassign_assignment`'s body yourself;
(2) apply X3 and M56 on scratch copies, confirm, restore from copies; (3) live as Dana: create
a block by sentence on a clean day (`Assign Operator A3 to Housing A on Cell 3 in Line 2 from
10 to 2`), then `Move Operator A3 on Cell 3 to Cell 4 in Line 2` — the pop-up opens on Cell 4
preset, and if Operator A3 is trained and homed for Cell 4 Enter moves it with no pop-up left
(otherwise the training/area box shows and nothing is written — say which happened and why,
reading the demo world); the database shows ONE row for that person that day, now on Cell 4;
then `Move Operator A3 on Cell 4 to 10 to 3` — the hours change on the same row; then delete
through the app; zero rows. Screenshots `move-01…`. (4) Report with one closing sentence.
