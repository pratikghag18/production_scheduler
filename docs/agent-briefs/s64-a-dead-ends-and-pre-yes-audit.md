# S64-a — the audit R-430 and R-431 trigger: every dead end without choices, and the two checks that come after the yes

Read R-430 and R-431 in `docs/plan.yaml` and CLAUDE.md §7. This file is the audit itself (read-only
pass, 17 Sept, session 178, over `src/lib/command/resolve.ts` and `CommandBar.tsx` as they stood at
3e5a7b0; line numbers drift with S63 — grep the message text). A fix lane takes this list, fixes or
queues every row, and pins each fix. Nothing here is an opinion about priority; the standard says
every hit.

## R-430 — dead ends that name a thing the board could not find and offer no choices

Every question is built in `resolve.ts` and rendered by `questionToStatus` in `CommandBar.tsx`; the
fall-through (~CommandBar 2471) renders `candidates: []` for anything unmapped.

| # | built (resolve.ts) | message | rendered (CommandBar) | data to offer choices is at hand? |
|---|---|---|---|---|
| 1 | ~1443 `unknown` place, no suggestions | `No cell called "X" on this board.` | ~2270 | Yes: `ctx.cells` in scope; `placeSuggestions` (~984) returned nothing only because `NEAREST_FLOOR = 0.35` (~779) rejected all; `trackCellSuggestions` (~1054) already builds the whole-cell fallback for the sibling branch. |
| 2 | ~1539 `unknown` product, no near name, no menu | `No part called "X" …` | ~2270 | Partly: `ctx.products` in scope; the cell offers nothing, but cells that DO make the part come from `ctx.cells` + `ctx.offeredAt`. |
| 3 | ~2074 `unknown` operator, no suggestions | `No person called "X" …` | ~2270 | Yes: `activeOperators` (~2061) is the full pool. |
| 4 | ~1425 `unknown` place as part, `sayOnly` when >8 cells (~1058) | `X is a part; which cell? Say the cell.` | ~2229 | Yes: `ctx.cells`; the empty list is a deliberate cap (comment ~1045). Offer the first eight and "another". |
| 5 | ~1456 `place_mismatch` | `There is no <cell> in <qual>. <cell> is in …` | ~2471 | Already built and thrown away: `elsewhere: Candidate[]` (~1449) printed inside the sentence, never rendered as buttons. |
| 6 | ~1566 (assign/book), ~2884 (move) `not_offered` | `<part> is not made at <cell> …` | ~2471 | Yes: `ctx.offeredAt(cell.id)` just called; `offeredSuggestions` (~1031) turns it into candidates already for the empty-product case. |
| 7 | ~2487, ~2569, ~2727 `no_block` | `<person> has no block on <cell> <when>.` | ~2468 | Partly: `ctx.assignments` holds the person's blocks on other days/cells; `remove_which` (~2545) and `move_which` (~2705) build candidates from the same source via `elsewhereCandidates` (~1164). |
| 8 | ~2596 `block_gone_remove` | `That block of <person>'s … is already gone.` | ~2468 | Yes: same source as row 7. |
| 9 | ~1818 `no_job` (hours and headcount) | `There is no <part> job on <cell> <when>; book it first…` | ~2126 | Yes: `ctx.runs`; the part's runs on other days and the other jobs on that cell that day are one filter away. |
| 10 | ~1820 `which_job` | `<part> runs more than once on <cell>: …. Say the hours.` | ~2133 | Ids discarded at the call site (`runs.map(r => r.span)` drops `r.id`). |
| 11 | ~3975, ~3986 `swap_which` | `… Say the hours.` | ~2026 | Ids discarded (`blocks: string[]`, type doc ~576 says "never a button list"). |
| 12 | ~4646 `split_outside` | `<time> is outside <person>'s blocks (…)` | ~2119 | Ids discarded (`blocks: string[]`, ~604). |
| 13 | ~2361, ~2382 `job_in_the_way` | `<cell> already runs <other>; a cell runs one job at a time.` | ~2381 | Yes: the blocking run came from `ctx.findRunOverlap`; only its product name kept. |
| 14 | CommandBar-only `job_exists` with `same: true` | `… — nothing to change.` | ~2361 | Yes: `question.run` is a full Candidate, dropped on this branch only. Arguably a readout, not a dead end — decide and say. |
| 15 | ~1935, ~2040 `no_shift` | `No shift called "X" on <cell>; it has A, B, C.` | ~2471 | Already in the question (`shifts: string[]`) and only printed. A shift name gets no `nearestNames` pass at all, unlike person/place/part. |
| 16 | ~1775 `no_shift_at` | `No shift on <cell> covers <time>.` | ~2047 | Yes: `bands` in scope; each band's start is a candidate time. |
| 17 | ~1739, ~1767, ~1928, ~2016, ~2047 `no_shift_pattern` | `<cell> has no shift pattern, so say the hours.` | ~2471 | Weak: that cell has none; probably an honest dead end. Decide and say. |
| 18 | ~1331 `not_certified` | bare refusal in a lot, no buttons, no reason box | ~2073 | Yes for "who else could": `ctx.operators` + `ctx.certificateGaps`. |
| 19 | ~1369 `outside_area` in a lot | `… Nothing was written.` | ~2086 | Yes: `ctx.outsideArea` + `ctx.operators`. |
| 20 | ~1199–1250, ~3213 `day_off_board` | `<text> is not on the board.` | ~2163 | Half: one button ("Show that day") but no day candidates; `ctx.days` is at hand. |

Not dead ends (grammar or arithmetic refusals, nothing the board could have found): `too_short`,
`no_start`, `several_unsupported`, `lot_too_big`, `split_needed`, `across_midnight`, `day_order`,
`adjust_inverts`, `adjust_off_day`, `bad_adjust`, `bad_repeat_day`, `expand_first`, `nothing_to_do`.

Already compliant, for completeness: `unknown` with R-418 near names (place ~1442, product ~1518,
operator ~2073 → CommandBar ~2260); R-422's cell menu (~1541 → ~2247); `asPart` cell list (~1425 →
~2211); every `ambiguous` (→ ~2143); `run_exists` (→ ~2272), `block_exists` (→ ~2300), `block_gone`
(→ ~2340), `job_exists` same:false (→ ~2358), `job_gone` (→ ~2384), `remove_which` (→ ~2398),
`move_which` (→ ~2442), the lot's "Do all N" (~1606). Builders to reuse: `nearestNames` ~864,
`candidatesForNames` ~886, `nodeSuggestions` ~957, `placeSuggestions` ~984, `productSuggestions`
~1000, `offeredSuggestions` ~1031, `trackCellSuggestions` ~1054, `operatorSuggestions` ~1076,
`elsewhereCandidates` ~1164.

## R-431 — what is asked before the yes, and what is not

**Before the yes today (the server's rule, transcribed):** certificates via `certificateGate`
(resolve.ts ~1318; `ctx.certificateGaps`, `ctx.eligibilityPolicy`) at assign ~2262 (not for a
`retime`), move ~2913, replace ~3861, swap ~4048/4052, copy ~4417; the area rule via `areaGate`
(~1358; `ctx.outsideArea`) at assign ~2270, move ~2919, replace ~3868, swap ~4050/4060, copy ~4427.
Fed from the same helpers the pop-ups use (`BoardPage.tsx` ~743–764: `boardIndex.certificateGaps`,
`policyForNode`, `outsideAreaOperatorIds` from `lib/outsideArea.ts`). Not gated: book (no person),
unassign, a retime of the person's own block, an adjust, headcount.

**Absence — never asked by the bar; everything needed is already in hand.** `ResolveContext` has no
absence field. `BoardPage` already loads `absences` (~298, `useAbsences`) and hands them to both
pop-ups; the `commandCtx` memo (~635–765) simply does not pass them. The predicate is
`absenceGaps(absences, operatorId, {start, end})` in `src/lib/absence.ts` (~117; its header says it
is the transcription of the server's `absence_overlap`), used by `CreatePopover.tsx` (~541–575) and
`useDragGesture.ts` (~606). Wording helper `leaveLine` in `src/features/board/lib/leave.ts`. The
server refuses only under `policy = 'block'` (`create_assignment`, last body in
`20260911000079_a_join_stays_inside_its_run.sql` ~128–136; under `warn` the absence rides back in the
envelope and the placement is taken) and re-asks on a resize (`app_guard_assignment_resize`,
`20260908000071_resize_guard_owner_exemption.sql` ~83–136). `absence_overlap` last defined in
`20260907000069_absence_by_the_hour.sql` ~122–190. Today the bar learns of it only from the toast
(`useSchedulerToast.ts` ~203–232). Fix shape: an `absenceGaps`-backed function on `ResolveContext`
from `BoardPage`, an `absenceGate` beside `certificateGate` with R-425's ask-before-the-yes shape and
the same policy switch.

**Capacity — never asked by the bar, and there is no client predicate by design.** No capacity field
in `ResolveContext`. The only client pre-check anywhere is the server RPC `capacity_probe` via
`probeCapacity` (`src/lib/api/board.ts` ~63), called by the create pop-up's own Create
(`submitCreateDirect`, `useDragGesture.ts` ~2260). The bar's write path skips even that:
`openCreateFromCommand`'s override branch (~1950) → `createFromCommand` (~1876, documented ~1860 as
deliberately probe-free), and the lot writer `runLot` (~2763). The refusal is the toast at
`useSchedulerToast.ts` ~127–142 from `SchedulerError` kind `CapacityExceeded`. `CreatePopover.tsx`
~44 records that a client-side `peakLoad()` was rejected as a second implementation of
`operator_peak_load()`. The server rule is the trigger `check_operator_capacity()`
(`20260821000004_operator_capacity.sql` ~11–52, never replaced; trigger re-created in
`20260904000043_assignment_delete_is_delete.sql` ~397): an instantaneous PEAK of overlapping
efficiency against `orgs.settings->>'capacity_cap'` (default 1.0), no override. The bar may not
import `src/lib/api` (`commandPurity.test.ts`), so the probe must arrive as a `ResolveContext`
function from `BoardPage`, exactly as `certificateGaps` does — async, so the gate runs where the
resolver's async reads already run (the model read), or in the bar between resolve and the question.
Fix shape: a `capacityProbe` on the context, called before the yes for every create/move/replace/
swap/copy step, refusing in the bar's own words (S63 item 5's sentence) with nothing written; the
lot's per-step probes run against the board as the lot would leave it, which the probe cannot see
(it reads the database) — say so in the lane's report and pin what it can.
