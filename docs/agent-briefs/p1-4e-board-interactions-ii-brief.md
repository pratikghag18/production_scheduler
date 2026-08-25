# Agent Brief P1-4e — Board Interactions II: Cross-Cell Moves, Split Coverage, Overrides

**Executor:** a fresh Sonnet agent (no prior context). **Phase:** 1, ninth build task — **the last one for the board.**
**Depends on:** P1-4a (render), P1-4b (create/move/resize + popovers + toasts), P1-4c (density), P1-4d (fit-to-height). All built and working.
**Rules:** no design decisions of your own. Note assumptions; do not ask questions mid-run.

**One-line scope:** the four interactions P1-4b deliberately deferred — **moving a run to another cell with its crew**, the **split-coverage flow** when an operator is over capacity, **eligibility overrides**, and **dragging an operator from the panel onto the board** — plus three debts P1-4b left behind (§9).

This is the concurrency-heavy half. Nothing here is hard to render; everything here is hard to get right when two things happen at once.

---

## 0. The npm block, and the hole in it

You cannot run npm (registry blocked, 403 by policy — also pip and apt). Node 22 here runs `node --experimental-strip-types`, so:

| Part | What | You validate it? |
| --- | --- | --- |
| **A** | `lib/interaction.ts` additions: split allocation, drop-target resolution, crew shift planning. Pure. | **YES — §10 and §11 are mandatory, with real output.** |
| **B** | Pointer wiring, the split popover, the override flow, panel drag | No. Author only; §13 items are **NOT RUN — no npm in container**. |

Reporting §10 or §11 as NOT RUN makes the delivery incomplete.

---

## 1. Study first

1. **`docs/api.md` §1, §3, §4** — the error table, `move_run`, `apply_split_coverage`, `capacity_probe`, `check_eligibility`. **§3's worked split-coverage example is the specification for §5 of this brief.**
2. **`docs/api-client.md`** — the hooks and their two deliberate behaviours: `useCreateAssignment` never auto-retries `CapacityExceeded` and hands you a typed error carrying `operatorId`/`peak`/`cap`; `useMoveRun` retries `RaceLost` exactly once.
3. **`src/lib/api/mutations.ts`** and **`src/features/board/hooks/{useRunMutations,useAssignmentMutations}.ts`** — `useMoveRun` and `useApplySplitCoverage` already exist, fully written, with optimistic update and rollback, and have **never been called by any component**. You are their first caller. **Do not rewrite them**; if one is missing something, say so in your report.
4. **`src/features/board/hooks/useDragGesture.ts`** — the existing state machine (D29). You are extending it, not replacing it.
5. **`src/features/board/lib/interaction.ts`** — the pure layer you are adding to.
6. **`src/features/board/components/OperatorPanel.tsx`** — the drag source for §7.
7. **`docs/mockups/model-hybrid.html`** — `startBandDrag`'s cross-cell branch, `startStaffDrag`'s `targetBand` logic, `startPanelDrag`, `openSplitPop`, `markEligibility`/`clearHints`, and the `.drop-hint` / `.ineligible` / `.split-row` CSS.
8. **`docs/design-plan.md` §15.1** (the capacity model and the split-coverage UX), **§15.2** (run mobility), **§6** (eligibility policy), **§18.7** (the CSS specificity trap), **§18.9–§18.12** (what the last three builds corrected).

Files are on the device at `C:\Users\prati\OneDrive\Documents\GitHub\production_scheduler`. Stage with `device_stage_files`.

---

## 2. Scope fence

Do **not**: add realtime subscriptions, change the density/fit system, change zoom, add a dependency, or touch `src/lib/api/`. Do not implement Copy Week, templates, or anything from Phase 2.

---

## 3. Decisions already made — implement, do not revisit

**D57 — a cross-cell run move is ONE call to `move_run`, never N writes.** P1-4b refused to move a staffed run precisely because shifting each crew assignment separately is N un-transacted writes whose partial failure leaves the board wrong. `move_run` does it atomically and returns `{ run, assignments, eligibility_warnings }`. Call it through the existing `useMoveRun`. **The refusal message P1-4b shows ("Moving a staffed run is coming in the next build") is deleted, not reworded.**

**D58 — the drop target is the row under the pointer, resolved from geometry, not from `elementFromPoint`.** The mockup hides the dragged element and calls `document.elementFromPoint`; that forces a synchronous layout on every pointermove over a virtualized grid. You already have `offsets` and the visible row slice — resolve the target row by binary search on the pointer's y within the scroll container. Put that in Part A (`resolveDropRow`).

**D59 — a cross-cell drag shows the target row and refuses illegal drops before sending.** While dragging over a row that is not the origin: highlight it (`.drop-hint`). If the target already has an overlapping run, mark it refused and do not send on drop — `findRunOverlap` from P1-4b already answers this. Group rows are never drop targets.

**D60 — eligibility on a cross-cell move is a warning, never a block.** `move_run` returns `eligibility_warnings[]`. The move **succeeds**; you surface a toast naming how many of the crew are not certified for the target cell, exactly as the mockup does. This is design-plan §6's override-warn policy for runs, and it is deliberately not the same as §5's rule for a single new assignment.

**D61 — the split-coverage popover opens PROACTIVELY, not from a rejection.** `docs/api-client.md` says to call `probeCapacity` before committing when you want the popover up-front. Do that: on a drop or a create that would put an operator over cap, call `capacity_probe` first; if `fits` is false, open the split popover pre-populated from `overlapping[]`, and only send `apply_split_coverage` when the user confirms. A `CapacityExceeded` toast remains the fallback for the race where the probe said yes and the write said no.

**D62 — the split popover is the mockup's `openSplitPop`, ported.** The operator's overlapping assignments with editable efficiency fields, the incoming assignment alongside, a live peak-load readout, a **Split evenly** button, and **Confirm disabled while the peak exceeds the cap**. Cancel reverts and sends nothing.

**D63 — peak load is NEVER recomputed in the client.** `capacity_probe` and the capacity trigger share `operator_peak_load()` in the database precisely so they cannot diverge (design plan §17.2, [[brief-writing-rules]] rule 4). The popover's live readout recomputes only the **arithmetic the user is editing** — the sum of the efficiencies shown — and re-probes on confirm. **If you find yourself porting the mockup's `peakLoad()` function, stop.** That is a second implementation of a database invariant and it is exactly what rule 4 forbids.

**D64 — an eligibility override is explicit and reasoned.** When `check_eligibility` returns `eligible: false` with `policy: "warn"`, the create/drop popover shows what is missing and offers an override checkbox with a required free-text reason; only then send `p_eligibility_override: true` and `p_override_reason`. With `policy: "block"` there is no override — the operation is refused and the toast says why. **Never send an override the user did not tick.**

**D65 — dragging an operator from the panel creates an assignment at the drop point.** Port `startPanelDrag`: a ghost follows the pointer, eligible/ineligible target rows are hinted (`check_eligibility` per hovered row is too chatty — hint from `skillsForNode` + `operator.skillIds`, which the index already carries, and let the server be authoritative on commit). On drop, open the create popover pre-filled with that operator and the dropped time range, in **direct** mode, then follow D61/D64.

**D66 — re-parenting an assignment between runs.** Dropping a run-attached chip onto a different run band in the same cell moves it to that run; dropping it on empty track in the cell detaches it to a direct assignment. Both are `useUpdateAssignmentFields` on `runId`/`productId` — **there is no RPC for this and none is needed**. Dropping onto a run whose time range does not contain the assignment is refused before sending.

---

## 4. Part A — additions to `lib/interaction.ts`

Same constraints as before: **no React, no DOM, `import type` only** (plus the existing `./geometry` value import), no enums, every function pure.

```ts
/** D58. `rowTops` is the prefix-sum offsets array; `rowHeights` the matching
 *  heights. Returns the index of the row containing `y`, or null if outside.
 *  Binary search — this runs on every pointermove. */
export function resolveDropRow(rowTops: number[], rowHeights: number[], y: number): number | null;

/** D62's "Split evenly": given a cap and N participants (the existing
 *  overlapping assignments plus the incoming one), propose an efficiency for
 *  each so the total is exactly the cap. Returns UI percents, integers,
 *  summing to `Math.round(cap * 100)` — the remainder goes to the FIRST
 *  participant, so three-way at 100% is 34/33/33 and never 33/33/33. */
export function splitEvenly(participantCount: number, capPercent: number): number[];

/** D62's live readout: does this proposed set of percents fit under the cap?
 *  Pure arithmetic over what the user is editing — NOT a peak-load
 *  computation (D63). */
export function splitFits(percents: number[], capPercent: number): boolean;

/** D57. The crew ranges after a run moves by `deltaMin`. Used to render the
 *  drag preview only — the actual move is one `move_run` call. */
export function planCrewShift<T extends { id: string; startMin: number; endMin: number }>(
  crew: T[], deltaMin: number, windowMinutes: number,
): { id: string; startMin: number; endMin: number }[];

/** D66. May this assignment live on this run? Plain containment:
 *  `a.startMin >= run.startMin && a.endMin <= run.endMin`.
 *  Do NOT add a third `a.startMin < run.endMin` clause — with any
 *  positive-duration assignment it is implied by the other two, and the
 *  design session verified it is unreachable (MIN_DURATION_MINUTES is 15,
 *  so a zero-length assignment cannot exist). A redundant guard reads as a
 *  case someone thought about, which is worse than not writing it. */
export function assignmentFitsRun(
  assignment: { startMin: number; endMin: number },
  run: { startMin: number; endMin: number },
): boolean;
```

---

## 5. The split-coverage flow, end to end

This is the single most intricate path in the product. `docs/api.md` §3 has the worked example; follow it.

1. User drops an operator (panel drag, chip move, or create) into a range.
2. Client calls `probeCapacity(operatorId, timerange, efficiency)`.
3. `fits: true` → proceed with the ordinary create/update.
4. `fits: false` → open the split popover, pre-populated with `overlapping[]` (each carries `assignmentId`, `nodeName`, `productName`, `timerange`, `efficiency`) plus the incoming one.
5. User edits efficiencies or clicks **Split evenly**. Confirm stays disabled while `splitFits` is false.
6. Confirm → **one** `apply_split_coverage` call carrying the adjustments *and* the new assignment. **Not** a set of individual updates followed by a create: design plan §17.2 item 5 records that per-row triggers see intermediate state, so lowering the existing efficiencies and inserting the new row must happen inside one function or the capacity trigger trips against un-adjusted state and the whole transaction fails.
7. Cancel → nothing sent, board unchanged.

---

## 6. Transitions

P1-4a's T1–T9 and P1-4b's T10–T16 still apply. New:

**T21 — the probe is stale by the time the user confirms.** Between opening the split popover and confirming, someone else may have changed the operator's load. `apply_split_coverage` is authoritative; a `CapacityExceeded` on confirm is normal, not exceptional. Show it in the popover — do not close the popover and toast it, because the user's edits are still there and re-editing is the natural next step.

**T22 — a cross-cell drag whose target row disappears mid-drag.** A refetch or a collapse can remove the row under the pointer. Re-resolve the drop target from the *current* rows on every move; on drop, if the target no longer exists, cancel silently.

**T23 — `move_run` returns eligibility warnings AND succeeds.** Do not treat a non-empty `eligibility_warnings[]` as a failure. The run has moved. Toast the warning as information (D60).

**T24 — the panel drag ghost must survive a scroll.** The board can scroll under a panel drag. The ghost follows the pointer in viewport coordinates; the drop *time* is resolved from the container's current scroll position at drop, not at drag start.

**T25 — a split popover open when identity changes.** `DevProfileSwitcher` resets the cache. Close the popover and send nothing — the assignments it references may not be visible to the new identity.

---

## 7. Part B

- Extend `useDragGesture` with the cross-cell branch, panel-drag origin, and run re-parenting. **One state machine** (D29) — do not add a second.
- `SplitCoveragePopover.tsx` + `.module.css`, built on the existing `BoardPopover` shell.
- Eligibility override UI inside the existing create popover.
- `.drop-hint` / `.ineligible` row states, ported from the mockup.
- `OperatorPanel` becomes a drag source.

**The CSS specificity trap has bitten this project three times** (§18.7). Every state class you write keeps its element: `.track .dropHint`, `.row button.pri` — never a bare `.dropHint`. And when you port a rule from the mockup, **port all of its declarations** — a dropped `width: 260px` made a popover overflow its own edge in P1-4b.

---

## 8. Do not reimplement what the database owns

Explicitly forbidden, because each already exists exactly once:

- **peak load** — `operator_peak_load()`, reached via `capacity_probe` (D63)
- **eligibility** — `check_eligibility`, including ancestor skill inheritance
- **run overlap** — the exclusion constraint; `findRunOverlap` is a pre-send courtesy, not the authority
- **the split write order** — `apply_split_coverage`

If a mockup function tempts you to duplicate one of these, that is the signal to stop and use the RPC.

---

## 9. Debts from P1-4b — close these

1. **T12 for popover-fired mutations.** `saveRunFields`, `deleteRunWithMode`, `saveAssignmentFields`, `removeAssignment` call `toast.schedulerError` without a block label, so a failure there says "You don't have permission" with no clue which block reverted. `revertLabel`/`failWith` already exist in `useDragGesture`. Those call sites only receive an id — so **add `runById` and `assignmentById` to `BoardIndex`** (`boardIndex.ts` already builds `runsByNode`/`assignmentsByNode`; these are the same rows keyed differently) and label from them. `ToastResolveCtx` already anticipates a `runById`.
2. **Replace `window.confirm`.** The crew-outside-the-run warning uses a blocking browser dialog. Move it into the popover shell as a confirm step — it cannot be styled or tested through the DOM as it stands.
3. **Chip height at Compact.** Not yours unless it falls out naturally; noted so it is not forgotten.

---

## 10. Part A validation — MANDATORY

Harness in `/tmp/harness/`, `node --experimental-strip-types run.ts`, PASS/FAIL, non-zero exit on failure.

1. `resolveDropRow` on 20 rows of mixed heights: exact hit at a row's top edge, one px inside, one px above the first row (null), past the last row (null), and the last row's final pixel.
2. `resolveDropRow` agrees with a linear scan for 500 random y values — the binary search must not disagree with the obvious implementation.
3. `splitEvenly(2, 100)` ⇒ `[50, 50]`; `splitEvenly(3, 100)` ⇒ `[34, 33, 33]` (remainder to the first); `splitEvenly(4, 100)` ⇒ `[25,25,25,25]`.
4. `splitEvenly(n, cap)` sums to exactly `cap` for every n in 1..8 and cap in {100, 120, 150}.
5. `splitEvenly` never returns a zero or negative percent for n ≤ 8 at cap 100.
6. `splitFits([50,50], 100)` true; `[50,51]` false; `[100]` true at cap 100; `[60,60]` false.
7. `planCrewShift` preserves every duration and clamps to the window without squashing (the P1-4b clamp-vs-squash rule, re-verified here).
8. `planCrewShift` with delta 0 returns equal ranges and does not mutate its input.
9. `assignmentFitsRun`: exactly coincident ⇒ true; assignment one minute past the run's end ⇒ false; assignment starting exactly at the run's end ⇒ false (half-open).
10. Every function is pure — call each twice with the same input and deep-compare.

---

## 11. Mutation testing — MANDATORY, and RUN each one

| # | Break | Must fail |
| --- | --- | --- |
| M1 | `resolveDropRow` — off-by-one in the binary search (`<` for `<=`) | case 1's exact-edge or case 2's cross-check |
| M2 | `splitEvenly` — give the remainder to the last participant | case 3's three-way |
| M3 | `splitEvenly` — `Math.floor` each share with no remainder handling | case 4's sum |
| M4 | `splitFits` — `<=` becomes `<` | case 6's `[50,50]` |
| M5 | `planCrewShift` — clamp each edge independently | case 7 |
| M6 | `assignmentFitsRun` — `a.endMin <= run.endMin` becomes `<` | case 9a's coincident case |

**This table was executed against a reference implementation before the brief shipped**, and one entry was wrong and has been corrected — the original M6 ("inclusive upper bound") could not fail any case, because the clause it mutated was redundant. That is the fifth mutation-table error on this project, and the first caught before an agent saw it.

**Still do not trust it.** Apply each mutation, record which case actually fails, and correct the table in your report if it is wrong. Two of the previous four were caught by the agent, not the design session.

---

## 12. Self-review (by reading)

1. No client-side peak-load computation (D63/§8). Show a grep for `peak` in the feature and justify every hit.
2. `p_eligibility_override` is only ever sent when the user ticked the box (D64). Name the lines.
3. `apply_split_coverage` is called **once** per confirm, carrying both adjustments and the new assignment (§5 step 6). Name the lines.
4. `move_run` is called once for a cross-cell move; no per-crew writes (D57). Show a grep for `useUpdateAssignmentFields` in the move path.
5. No `elementFromPoint` (D58). Show a grep.
6. Every new state class keeps its element (§7). Show the selectors.
7. Each of T21–T25: file and lines, or "unimplemented".
8. §9's debts 1 and 2: name the lines.
9. No new dependency; `src/lib/api/` untouched.
10. One drag state machine, not two.

---

## 13. Acceptance — the user runs this

```powershell
npm run format
npm run lint; npm run typecheck; npm run test; npm run build
```

Then `npm run dev -- --host`, as Admin, on **Tue Aug 25** where the seeded runs are:

1. Drag the **unstaffed** Widget X run on Cell 2 down to Cell 4 → it moves; Cell 4 shows it, Cell 2 does not.
2. Drag the **staffed** Widget X run on Cell 1 (Elena + Tom) to Cell 4 → it moves **with its crew**, in one step. No "coming in the next build" message.
3. Drag a run onto a cell that already has an overlapping run → the target is marked refused and the drop reverts.
4. Drag a run onto **Cell 6 or 7** (CNC-required) with uncertified crew → the move succeeds and a toast names how many are not certified.
5. Drag **Maria** from the operator panel onto Cell 4 at ~08:00 → create popover opens pre-filled with Maria, direct mode.
6. Maria is already at 100% on Cell 6 06:00–14:00, so that same drop → **the split popover opens before anything is sent**, showing her Cell 6 assignment and the incoming one. **Split evenly** → 50/50. Confirm → both exist at 50%.
7. Cancel a split popover → nothing changes.
8. Drag an operator with no CNC skill onto Cell 6 → missing-skill warning with an override checkbox; ticking it requires a reason; without ticking, the create is refused.
9. Drag a chip from one run band onto another in the same cell → it re-parents. Drag it to empty track → it detaches to a direct assignment.
10. A failed popover edit names the block it reverted (§9 debt 1).
11. The crew-outside-the-run warning is an in-app confirm, not a browser dialog (§9 debt 2).
12. No console errors.

Mark every item **NOT RUN — no npm in container**.

---

## 14. Delivery

Write files directly via `device_bash` heredoc and **verify each with `md5sum` on both sides** — the last two agents did this and it worked. **On this OneDrive-backed mount an in-place `tar` overwrite of an EXISTING file silently no-ops**, reporting success while leaving old content. Extracted files land read-only (`chmod u+w`). `device_bash` cannot delete or move files. `device_commit_files` can be refused by Windows Controlled Folder Access — do not retry the same path. If you run `git`, a stray `.git/index.lock` may need manual removal; mention it.

**Do not commit or push. Do not run any npm command.**

---

## 15. Required final step

Edit `docs/roadmap.md`: update the P1-4e row to "code delivered, acceptance pending user run" and refresh **Last updated**. Leave every other row alone.

---

## 16. Report format

1. File tree, one line each.
2. **§10 harness output — the real printed text.**
3. **§11 mutation results — the exact failing line for M1–M6, and any correction to the table.**
4. §12 self-review with evidence.
5. §13 acceptance block, every item NOT RUN.
6. **Every assumption, and anything in this brief that is wrong, impossible, or contradicted by what you find on disk.** This section has been the most valuable part of every report on this project — a false premise was correctly rejected two briefs ago, and two mutation-table errors were caught one brief ago. Do the same.
7. Anything left undone.
