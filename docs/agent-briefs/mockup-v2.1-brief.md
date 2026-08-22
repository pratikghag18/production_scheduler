# Agent Brief: Mockup v2.1 — Panel, Run Mobility, Split Coverage

**Executor:** the Sonnet agent that built model-hybrid.html (context assumed). Modify `/home/claude/mockups/model-hybrid.html` IN PLACE. Everything not named below stays exactly as it is. Do not touch model-a.html / model-b.html / verify.js. No design decisions of your own; note assumptions in the final report; do not ask questions.

## Change 1 — Operator tray becomes a left vertical panel

- Remove the bottom `#tray`. Add a left vertical panel as the first column of the page layout (body becomes a horizontal flex: panel | board column). Width 190px, own vertical scroll, `--surface` background, hairline right border.
- Panel header: `OPERATORS` in the existing `.lbl` style, plus a collapse toggle (`«` / `»`) that shrinks the panel to 28px showing only avatars.
- Each operator entry (vertical list): avatar, name, skill badges (existing chip internals), stacked with 4px gaps. Same pointerdown drag behavior as the old tray chips (drop on band = staff run; drop on empty track = direct-assignment popover).
- **Assigned indicator:** if the operator has ≥1 non-deleted assignment (either kind) anywhere in the 3-day domain, show a small count pill on the right of their entry (e.g. `2`) in `--ink-2` on `--page` with hairline border; tooltip = one line per assignment: `Cell 1 · Tue 06:00–14:00 · 100%`. Operators with zero assignments get no pill.
- **Fully-allocated dimming:** if an operator's peak load (see Change 3 algorithm) is ≥ 100% for the ENTIRE window Tue 06:00–22:00, render the entry at 55% opacity (still draggable). With seed data this applies to nobody by default — verify by staffing someone fully and checking the dim appears.
- Profile scoping (Ana/Marco/Admin) now filters this panel instead of the old tray.
- Update the tray-related tip line to mention the left panel.

## Change 2 — Run bands move across cells

Extend band drag (move mode only, not resize) with the same cross-row mechanics the direct blocks already use (`elementFromPoint` → `.track` under pointer, `drop-hint` outline):

- On drop onto another cell's track: reject with red flash + revert + toast if the target cell has an overlapping run; otherwise re-parent the run AND its crew to the target cell.
- Eligibility recheck for every crew member against the target cell: ineligible members get `override = true` + one summary warn toast (`2 of 3 crew not certified for Cell 6 — overrides recorded`); eligible members get `override = false`.
- While dragging a band, do NOT show operator-eligibility row dimming (that is operator-drag behavior); only the drop-hint outline.
- Time-axis movement during the same drag keeps working (diagonal drags allowed).

## Change 3 — Capacity model + split-coverage popover

Replace the flat `conflictOf` rejection with a capacity check: **an operator's instantaneous total efficiency must stay ≤ 100%.**

Algorithm (implement as `peakLoad(opId, s, e, eff, exclId)`): candidate points = `s` plus the starts of the operator's other non-deleted assignments (both kinds) overlapping `[s,e)`; for each point inside `[s,e)`, load = eff + sum of efficiencies of other assignments covering that point; return max load. Legal when peak ≤ 100.

Behavioral rules:

- Anywhere the code currently rejects via `conflictOf` (create popover Save, tray/panel drop on band, chip/block move & resize, run move carrying crew): compute peak instead. Peak ≤ 100 → proceed silently (overlap is now legal). Peak > 100 → open the **split-coverage popover** instead of a reject toast, EXCEPT during run-crew moves (Change 2) and multi-assignment operations, where per-operator popovers are impractical: there, reject with flash + revert + toast naming the overloaded operator (`Maria would exceed 100% (peak 150%) — reverted`).
- **Split-coverage popover** (new, reuse #pop styling): title `Split coverage — {operator}`; a row per overlapping assignment in the affected window (`Cell 1 · 06:00–14:00` + efficiency `number` input) plus a row for the incoming assignment (highlighted, same fields); live footer line `Peak load: 130%` red when > 100, `--ink` when ≤ 100, recomputed on any input change; buttons: `Cancel` (revert/abort), `Split evenly` (set every listed efficiency to `floor(100 / rowcount / 5) * 5`), `Confirm` (disabled while peak > 100; applies all efficiency edits + commits the incoming assignment).
- The create popover's operator `<select>`: replace the disabled `— busy` state with an enabled `— at 100% (will ask to split)` annotation when that operator's peak in the drag range is already ≥ 100; choosing them and hitting Create opens split-coverage.
- Busy annotations/tooltips elsewhere update accordingly.

## Seed data changes (demonstrate the model)

- Change Aisha's direct assignment: **c4, wy, Tue 06:00–12:00, eff 50** (was 100).
- Add direct assignment: **aisha, c5, rw, Tue 06:00–12:00, eff 50** — Aisha now covers two cells at 50/50; her panel pill shows `2`.
- Everything else unchanged.

## Tips panel — replace these lines only

- Replace the tray line with: `Operators live in the left panel — the pill shows how many assignments they hold. Drag them onto a band or empty space.`
- Add: `Aisha covers Cell 4 + Cell 5 at 50/50 — overlap is legal while total ≤ 100%.`
- Add: `Drop Elena onto Cell 6's Tue run → she's at 100% → the split-coverage dialog opens. Confirm only enables when the peak fits.`
- Add: `Run bands now drag to other cells — crew follows, certifications recheck.`
- Keep: zoom/Alt, profile, target, effective-headcount lines. Remove the now-false "she's busy → conflict" line.

## Acceptance checklist

1. Zero console errors; panel renders left with correct pills (Aisha `2`; unassigned operators no pill); collapse toggle works.
2. Old bottom tray gone; profile switching filters the panel; drag-from-panel works for both drop targets.
3. Aisha's 50/50 seed renders both blocks without any conflict complaint.
4. Dropping Elena (100% Tue 06–14) onto Cell 6's Tue run opens split-coverage; Confirm disabled at >100; `Split evenly` then Confirm commits and re-renders with adjusted efficiencies.
5. Creating a direct assignment over someone's existing 100% window via drag-select + popover also routes through split-coverage.
6. Band drag to another cell: rejected onto a cell with overlapping run; accepted onto a free cell with crew re-parented; override toast when crew lacks certification (drag Cell 2's Tue run to Cell 7).
7. Capacity still hard-blocks where it must: moving Maria's Monday run to overlap her Tuesday run reverts with the named overload toast.
8. Effective-headcount badges unchanged and correct after splits.
9. All three zooms + profile switches still clean after the layout change.

## Verification

Extend `/home/claude/mockups/verify-v2.js` in place (keep old steps that still apply; delete ones the new model invalidates — note which in the report). Screenshots `hy2-*.png`. Programmatically exercise items 1, 3, 4, 6, 7 minimum. Read screenshots to confirm: panel layout sane, popover on-screen, no text overlap. Iterate to zero console errors.

## Required final step

Update `/home/claude/roadmap.md`: tick the `Mockup v2.1` checkbox, refresh its `Last updated` date. Then produce the same report format as before (checklist table, assumptions, screenshots, console status).
