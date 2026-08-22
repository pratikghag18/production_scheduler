# Agent Brief: Mockup v2 — Hybrid Scheduler Board

**Executor:** Sonnet/Opus agent. Follow this brief exactly. Make no design decisions of your own; where this brief is silent, copy what `model-a.html` / `model-b.html` already do. Do not ask questions — if you must assume something, note it in your final report.

## Inputs (read these first, in this order)

1. `/home/claude/mockups/model-b.html` — your architectural base. Study its data model, render loop, drag engine, popovers, toasts, tips panel.
2. `/home/claude/mockups/model-a.html` — source for the direct-assignment block style (`.blk`) and its create popover.
3. `/home/claude/mockups/verify.js` — the verification pattern you will adapt.
4. `/home/claude/design-plan.md` §14 — context only; the brief below is the authority for what to build.

## Output

One file: `/home/claude/mockups/model-hybrid.html`. Self-contained single-file HTML/CSS/JS. No external resources, no frameworks, no localStorage/sessionStorage. Do NOT modify model-a.html or model-b.html.

Plus: `/home/claude/mockups/verify-v2.js` and passing verification output (see §Verification).

## Non-negotiable constants (copy verbatim from the existing mockups)

- CSS custom properties/tokens, fonts, header/tray/popover/toast/tips styling.
- Product colors, in this order only: Widget X `#2a78d6`, Widget Y `#eb6834`, Gadget Z `#1baf7a`, Rework `#eda100`. Color always follows the product; operators stay neutral ink; amber `#fab219` = understaffed/override; red `#d03b3b` = conflict.
- Zoom levels `Compact 64px/h · snap 60m`, `Standard 104px/h · snap 30m`, `Fine 168px/h · snap 15m`; Alt bypasses snap; snap note in header.
- Hierarchy tree, collapsible groups, sticky rail/header, hour gridlines.
- Model badge style; text: `HYBRID · RUNS + DIRECT ASSIGNMENTS`, badge background `#4a3aa7`.

## 1. Timeline: three continuous days

- Time domain: absolute minutes from Monday 00:00. Range Mon Aug 17 00:00 → Wed Aug 19 24:00 (0 … 4320).
- The track renders the full 72h; the board scrolls horizontally (native overflow scroll; no virtualization needed).
- Header shows two sticky rows inside the existing header track: day labels ("Mon Aug 17", "Tue Aug 18", "Wed Aug 19") each spanning its day's width, and hour ticks below (label every 2h at Compact zoom, every 1h otherwise).
- Day boundaries: 2px vertical line in `--axis` color across all rows (render as absolutely positioned divs per track, or a second background-image layer).
- On load, auto-scroll so Tue 06:00 is at the left edge of the visible track.
- Header buttons `◀ Prev day` `Today` `Next day ▶` scroll the board by 24h / to Tue 06:00. Smooth scroll.
- All existing time helpers change from a 06:00–22:00 day to the 0–4320 domain. Clamp drags to [0, 4320].

## 2. Hybrid creation model

Two entity kinds coexist on every row:

- **Run** (from model-b): `{cell, prod, s, e, planned}` band + staffing chips attached via `runId`.
- **Direct assignment** (from model-a): `{cell, op, prod, s, e}` standalone block, `runId: null`, rendered in the model-a `.blk` style (with product chip text) but at the chip height used in model-b lanes.

Rules:

- Drag-select on empty row space opens ONE creation popover containing a two-option segmented control at the top: `Product run` | `Direct assignment`. Which option is pre-selected comes from the current profile's `defaultCreate` (see §4). Fields below swap with the selection:
  - Product run → Product select, Planned headcount number (default 2).
  - Direct assignment → Operator select (same busy/eligibility annotations as model-a), Product select, Efficiency, Target (see §3).
- Tray chip dropped **on a run band** → staff that run (model-b behavior) at 100% efficiency, target NA.
- Tray chip dropped **on empty row space** → creation popover pre-set to Direct assignment with that operator selected, range = snapped drop point + 4h (clamp to 4320).
- Runs may not overlap other runs on the same cell (model-b rule). A direct assignment MAY overlap a run on its cell (a floater helping mid-run) but operator double-booking is always rejected with the red flash + revert + toast, across all days and both entity kinds.
- Lane packing: bands at top strip as in model-b; all chips/blocks (run staffing + direct) share the lane area below, packed by the same greedy algorithm.
- Direct assignment click popover: product select, efficiency, target, time text, Delete, Save. Move/resize identical to model-a blocks (cross-row move re-checks eligibility, override warn pattern).

## 3. Efficiency and target (both assignment kinds)

- `eff`: integer percent 10–150, default 100. Popover input `type=number, min=10, max=150, step=5`.
- Render: when `eff !== 100`, append ` · 75%` to the chip/block time text and include it in the tooltip.
- Run badge becomes **effective headcount**: `sum(eff)/100` over its staffing, shown as `1.5/3` (strip trailing `.0`). Understaffed (amber) when effective < planned. Update model-b's badge logic accordingly.
- `target`: number or null (null renders nowhere; tooltip says `target: NA`). Popover: number input (blank = NA) + unit text input (default `units`, max 8 chars). Render when set: append ` · ⌖ 80 units` to tooltip AND a small ` ⌖80` suffix on the chip/block label. Semantics are total-for-the-window; on resize of a targeted assignment show no prompt (mockup simplification) — just keep the number; note this in the tips panel as "final build will ask keep-or-scale".

## 4. Profiles and scoped visibility

Header dropdown `Viewing as:` with exactly three profiles:

| Profile | role | sees | roster | defaultCreate |
|---|---|---|---|---|
| Admin (all) | admin | everything | all operators | run |
| Ana — Assembly supervisor | supervisor | Assembly department subtree only | operators with `home: "assembly"` | run |
| Marco — Machining supervisor | supervisor | Machining department subtree only | operators with `home: "machining"` | direct |

- Switching profile re-renders: tree/rows filtered to granted subtree, tray filtered to home-department operators, creation popover pre-selects that profile's `defaultCreate`.
- Add `home` field to every operator: maria/raj/aisha → `machining`; elena/tom/ben/lily/sam/noah → `assembly`.
- A small muted note next to the dropdown when non-admin: `scoped to Assembly` / `scoped to Machining`.
- No permission enforcement beyond visibility (mockup): whatever is visible is editable.

## 5. Seed data (absolute minutes; Mon=day 0, Tue=day 1 offset 1440, Wed=day 2 offset 2880)

Reuse the v1 factory tree and operators (plus `home` fields, plus Noah). Products unchanged.

Runs:
| cell | product | window | planned |
|---|---|---|---|
| c1 | wx | Tue 06:00–14:00 | 3 |
| c1 | wy | Tue 14:30–22:00 | 1 |
| c2 | wx | Tue 06:00–14:00 | 1 |
| c3 | gz | Tue 08:00–16:00 | 2 |
| c6 | gz | Tue 06:00–14:00 | 1 |
| c7 | rw | Tue 10:00–18:00 | 2 |
| c1 | wx | Wed 06:00–14:00 | 3 |
| c6 | gz | Mon 06:00–14:00 | 1 |

Run staffing (eff 100, target NA unless noted):
- c1-Tue-wx: elena, tom. c1-Tue-wy: elena. c2-Tue-wx: ben with `target 500, unit "units"`. c3-Tue-gz: lily; sam with `eff 50` (training). c6-Tue-gz: maria. c7-Tue-rw: raj. c6-Mon-gz: maria. c1-Wed-wx: (unstaffed — shows 0/3 amber).

Direct assignments (runId null):
- aisha, c4, wy, Tue 06:00–12:00, eff 100.
- noah, c5, rw, Tue 09:00–11:00, eff 75 (helper).

Expected consequences you can verify: c3-Tue badge shows `1.5/2` amber; c2-Tue ben block shows the ⌖500 suffix; Mon and Wed have content proving multi-day works.

## 6. Tips panel content (replace wholesale)

- Scroll sideways — the board spans Mon–Wed. Use ◀ Today ▶ to jump.
- Drag empty space → choose **Product run** or **Direct assignment** in the popover. Your profile sets the default.
- Switch **Viewing as** to Ana or Marco → the board and roster scope to their department; note their different default create type.
- Sam runs at **50%** on Cell 3 → the run shows effective staffing `1.5/2`, understaffed.
- Ben carries a **target of 500 units** on Cell 2 (⌖ suffix).
- Cross-day conflicts still caught: try moving Maria's Monday run onto Tuesday morning (she's busy).
- Drag **Noah** onto CNC Cell 6 → certification override. Hold **Alt** for free drag.

## 7. Acceptance checklist (all must pass)

1. Loads with zero console errors; board auto-scrolled to Tue 06:00.
2. Day labels + boundary lines correct for all three days at all three zooms.
3. Creation popover: segmented control works, fields swap, profile default respected.
4. Both entity kinds create, move, resize, delete; run bands still carry their crew on move and clamp on resize.
5. Double-booking rejected across days and across entity kinds (run staffing vs direct), with flash + revert + named toast.
6. Effective headcount math: c3-Tue = `1.5/2` amber; staffing Cell 1 Wed with one 100% operator → `1/3` amber.
7. Eligibility dim + override warn works for both creation paths.
8. Profile switching filters rows AND roster both directions (Ana ↔ Marco ↔ Admin) without errors; collapsed-group state survives.
9. Efficiency badge and target suffix render; efficiency editable via popover Save.
10. Zoom switching preserves data and scroll-position day.

## Verification (required)

Adapt `/home/claude/mockups/verify.js` into `verify-v2.js`: headless Chromium (Playwright is installed; browsers at `/opt/pw-browsers`), viewport 1980×950, capture console/page errors, and programmatically exercise checklist items 1, 3, 5, 6, 8 at minimum, with screenshots at each step (`hy-1-*.png`, `hy-2-*.png`, …). Read your own screenshots to confirm layout sanity (no overlapping text, popovers on-screen, bands aligned to gridlines). Iterate until everything passes and errors list is `none`.

## Final report format

Return: (1) checklist table with pass/fail per item, (2) any assumptions made, (3) list of screenshots produced, (4) console error status. Do not paste file contents.
