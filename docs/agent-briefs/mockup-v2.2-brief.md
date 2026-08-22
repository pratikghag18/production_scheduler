# Agent Brief: Mockup v2.2 — Shifts, Breaks, Admin Shift Editor

**Executor:** the Sonnet agent that built v2/v2.1 (context assumed). Modify `/home/claude/mockups/model-hybrid.html` IN PLACE. Everything not named below stays exactly as it is. No design decisions of your own; note assumptions; don't ask questions. Reference for intent (not authority): design plan §16.

## Data model (JS)

```js
const SHIFT_TEMPLATES = {
  t38: { name: "3 × 8h", shifts: [
    { id:"s1", name:"Shift 1", start:360,  end:840,
      breaks:[{name:"Break 1",start:480,end:495},{name:"Lunch",start:600,end:630},{name:"Break 2",start:720,end:735}] },
    { id:"s2", name:"Shift 2", start:840,  end:1320,
      breaks:[{name:"Break 1",start:960,end:975},{name:"Lunch",start:1080,end:1110},{name:"Break 2",start:1200,end:1215}] },
    { id:"s3", name:"Shift 3", start:1320, end:1800,   // 22:00–06:00, wraps midnight
      breaks:[{name:"Break 1",start:1440,end:1455},{name:"Lunch",start:1560,end:1590},{name:"Break 2",start:1680,end:1695}] } ] },
  t210: { name: "2 × 10h", shifts: [
    { id:"d", name:"Days",   start:360, end:960,
      breaks:[{name:"Break 1",start:510,end:525},{name:"Lunch",start:660,end:690},{name:"Break 2",start:810,end:825}] },
    { id:"n", name:"Nights", start:960, end:1560,     // 16:00–02:00, wraps midnight
      breaks:[{name:"Break 1",start:1110,end:1125},{name:"Lunch",start:1260,end:1290},{name:"Break 2",start:1410,end:1425}] } ] }
};
// Attachment: any tree node id → template key. Nearest ancestor wins for a cell.
let nodeShiftTemplates = { assembly: "t38", cncline: "t210" };
```

Shift/break times are minutes from *that day's* midnight; `end > 1440` means the shift wraps into the next day but belongs to the day it starts. For rendering on the 3-day absolute axis, instantiate each shift/break for each of the 3 days (day offset 0/1440/2880... note: day 0 starts at absolute 0; also render the tail of a hypothetical previous-day Shift 3 (absolute -120→360 clipped to ≥0) so Monday 00:00–06:00 isn't misleadingly blank — instantiate day offsets -1..2 and clip to [0,4320]).

Resolution helper: `templateForCell(cellId)` — walk up cell → line → dept using the existing TREE structure; return the first node id present in `nodeShiftTemplates`. Assembly cells (c1–c5) resolve to t38; CNC cells (c6,c7) to t210.

## Change 1 — Rendering layer (under assignments)

Per track, render BEFORE bands/chips (lowest z):

- **Off-shift wash:** intervals covered by no shift get background `var(--page)` (e.g. CNC rows 02:00–06:00 daily).
- **Break bands:** one absolutely-positioned div per break instance, full row height, standard break style: `repeating-linear-gradient(45deg, rgba(137,135,129,.18) 0 4px, transparent 4px 8px)` over `rgba(137,135,129,.07)`; `title` tooltip `Lunch · 10:00–10:30`. Pointer-events none. Same style on every row — it is the product-wide "break" signifier.
- **Shift boundaries:** 1.5px dashed vertical line in `var(--axis)` at each shift start (skip where it coincides with a day boundary line). At Compact zoom only, add a small muted shift-name label (`Shift 1`, `Days`) at the top-left inside each shift segment on group-header rows for lines (not on every cell row — on the line's `grp-row` fill area, which currently renders empty `grp-fill`).
- Legend: add a `break` key using a small swatch of the hatch pattern.

## Change 2 — Snap-to-shift + full-shift quick actions

- At **Compact** zoom, drag-select/move/resize snap targets become the row's shift boundaries and break edges are NOT snap targets — snapping set = every shift start/end instant (absolute, all 3 days) for that row's template. Standard/Fine zooms keep 30/15-min snapping. Alt still frees the drag. Update the header snap note at Compact to `snap: shift`.
- Creation popover (both types): add a row of **full-shift chips** above the fields — one per shift of that row's template for the day where the drag started (`Shift 1 06:00–14:00`, etc.). Clicking a chip sets the pending range to that exact shift (overnight chips span into next day). The popover time line updates.

## Change 3 — Admin shift editor

- Header button `⚙ Shifts` visible ONLY when profile = Admin. Opens a modal panel (reuse popover styling, wider: 420px, centered, page-dim overlay).
- Contents: template tabs (`3 × 8h`, `2 × 10h`); per shift: name text input, start/end time inputs (`HH:MM`); per break: name, start/end, remove ×; `+ add break`; per line row at bottom: `Line 1 / Line 2 / CNC Line` each with a template `<select>` (reflects/edits `nodeShiftTemplates` — attach at line level; Assembly-level default becomes explicit line entries when edited, simplification OK).
- `Save` validates: shift end > start, duration ≤ 24h; breaks fully inside their shift; shifts within a template non-overlapping (compare on the wrapped scale). Invalid → inline red message, no commit. Valid → commit, close, re-render board (stripes, boundaries, snap sets, full-shift chips all reflect the change). `Cancel` discards.
- Assignments are NEVER modified by shift edits (shifts are a display/snapping layer).

## Seed sanity (expected visible results)

- Assembly rows: boundaries at 06/14/22 each day; 3 hatched breaks per 8h shift.
- CNC rows: boundaries at 06/16/02; off-shift wash 02:00–06:00; 3 breaks per 10h shift.
- Existing seed assignments happen to align with shifts (06–14 etc.) — unchanged.

## Tips panel — add/replace

- Add: `Hatched stripes are shift breaks (2×15 min + 1×30 min per shift); Assembly runs 3×8h, CNC runs 2×10h — dashed lines mark shift changes.`
- Add: `At Compact zoom, drags snap to shift boundaries. The create popover has one-click full-shift chips.`
- Add: `Admin profile → ⚙ Shifts to edit shift times, breaks, and which line uses which pattern.`

## Acceptance checklist

1. Zero console errors; stripes/boundaries/off-shift wash render correctly on Assembly vs CNC rows across all 3 days at all zooms; Monday 00:00–06:00 shows the previous-day night-shift tail, not blank off-shift, on Assembly rows.
2. Break tooltips correct; break layer never intercepts pointer events (drag-create through a break works).
3. Compact zoom: snap note says `shift`; drag-select lands exactly on shift boundaries; Standard/Fine unchanged.
4. Full-shift chips appear in creation popover, match the row's template + day, set the range correctly (including the overnight Shift 3 chip spanning midnight).
5. ⚙ Shifts visible only as Admin; editing Shift 1 start 06:00→05:30 re-renders boundaries/snap/chips; invalid edits (break outside shift, overlapping shifts) show inline error and don't commit.
6. Switching CNC Line's template to 3 × 8h via the editor re-stripes c6/c7 immediately.
7. All v2.1 behaviors still pass (panel pills, split coverage, cross-cell band moves, capacity block, profiles, effective headcount).
8. Legend shows the break key.

## Verification

Extend `verify-v2.js` in place; screenshots `hy3-*.png`; programmatically exercise items 1, 3, 4, 5, 6, 7 minimum; read screenshots for layout sanity; iterate to zero console errors.

## Required final step

Update `/home/claude/roadmap.md`: tick the Mockup v2.2 checkbox, refresh Last updated, set artifact-index hybrid row to `v2.2`. Report in the usual format.
