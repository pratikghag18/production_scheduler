# Agent Brief P1-4c — Responsive Layout & Density

**Executor:** a fresh Sonnet agent (no prior context). **Phase:** 1, seventh build task.
**Depends on:** P1-4a (board renders) and P1-4b (board is editable) — both built and working.
**Rules:** no design decisions of your own. Note assumptions; do not ask questions mid-run.

**One-line scope:** make the board use whatever screen it is on. Today it renders at one fixed size: on a 4K display everything is small and the rows stop partway down leaving a large empty area; on a phone it is legible only by pinch-zooming.

**This is a small, self-contained brief.** It changes sizing, spacing and layout. It changes **no** behaviour, no data flow, no mutation, and no interaction logic.

---

## 0. The npm block, and the hole in it

You cannot run npm (registry blocked, 403 by policy — also pip and apt). But Node 22 here runs TypeScript directly via `node --experimental-strip-types`, so the same split as the last two briefs applies:

| Part | What | You validate it? |
| --- | --- | --- |
| **A** | The density table and density-aware row geometry in `lib/geometry.ts` + `lib/boardIndex.ts`. Pure. | **YES — §8 and §9 are mandatory, with real output.** |
| **B** | CSS, the density control, the height chain, touch behaviour | No. Author only; §11 items are **NOT RUN — no npm in container**. |

Reporting §8 or §9 as NOT RUN makes the delivery incomplete.

---

## 1. Study first

1. **`src/features/board/lib/geometry.ts`** — `GROUP_ROW_HEIGHT`, `BAND_TOP`, `LANE_TOP_OFFSET`, `LANE_HEIGHT`, `trackRowHeight`, `ZOOMS`. These constants are what you are making density-aware.
2. **`src/features/board/lib/boardIndex.ts`** — `buildBoardIndex` calls `trackRowHeight` and `GROUP_ROW_HEIGHT` to compute row heights. It gains one parameter.
3. **`src/features/board/components/BoardGrid.tsx`** — the scroll container, `RAIL_WIDTH`, the virtualization, and the T1/T2/T7 scroll-anchoring effects.
4. **`src/features/board/components/BoardToolbar.tsx`** + `.module.css` — where the density control goes, next to the zoom buttons.
5. **`src/features/board/store/boardView.ts`** — view state lives here.
6. **`src/styles/tokens.css`** — `--rail-w`, `--band-h`, `--lane-h` already exist and are currently unused by the board's TS. Read the note in §3 about that.
7. **`src/styles/global.css`**, **`index.html`** — the height chain and the (already present) viewport meta.
8. **`docs/design-plan.md` §18–§18.8** — the board's decisions.

Files are on the device at `C:\Users\prati\OneDrive\Documents\GitHub\production_scheduler`. Stage with `device_stage_files`.

---

## 2. Scope fence

Do **not**:

- build a separate mobile layout, a bottom sheet, or any small-screen-specific board. **The Phase 3 "operator mobile read-only view" is not this brief.** Here, a phone must render the board legibly and pan/pinch sanely — nothing more.
- change any drag, popover, mutation or query behaviour
- change what the board *shows*, only how big it is
- add a dependency (no container-query polyfill, no `react-responsive`)
- touch `src/lib/api/`

---

## 3. Decisions already made — implement, do not revisit

**D43 — three densities, one table, same shape as `ZOOMS`.** Zoom is the *horizontal* scale (px per hour); density is the *vertical* one. They are independent and both are user-chosen.

```ts
export const DENSITIES = [
  { name: "Comfortable", laneHeight: 34, laneTopOffset: 42, groupRowHeight: 36, bandTop: 5, bandHeight: 30, rowPadBottom: 6 },
  { name: "Standard",    laneHeight: 28, laneTopOffset: 36, groupRowHeight: 30, bandTop: 4, bandHeight: 26, rowPadBottom: 4 },
  { name: "Compact",     laneHeight: 22, laneTopOffset: 28, groupRowHeight: 24, bandTop: 3, bandHeight: 22, rowPadBottom: 3 },
] as const;
export type DensityIndex = 0 | 1 | 2;
```

**Standard's numbers are exactly today's constants** — so at the default density nothing moves by a pixel. That is deliberate: it makes any visual diff at Standard a bug, not a design change.

**D44 — `trackRowHeight` takes a density.** It becomes `trackRowHeight(laneCount, density)` = `density.laneTopOffset + max(1, laneCount) * density.laneHeight + density.rowPadBottom`. `GROUP_ROW_HEIGHT`, `BAND_TOP`, `LANE_TOP_OFFSET`, `LANE_HEIGHT` stop being exported constants and become fields on the density object. Every reader takes them from there. **Do not leave a deprecated constant behind** — a second source of truth for row geometry is exactly the drift `docs/agent-briefs` rule 4 exists to prevent.

**D45 — `buildBoardIndex` gains a `density` parameter**, `buildBoardIndex(data, windowStart, windowEnd, density)`, and `BoardIndex` gains a `density` field so components read it from the index rather than being passed it separately. Row heights are computed in exactly one place and stay there.

**D46 — density is user-chosen, not viewport-derived.** A toggle in the toolbar beside the zoom buttons, stored in `boardView`, default **Standard** (index 1). Rationale: a 4K screen might be a wall display seen from three metres (wants Comfortable) or a dense planning station (wants Compact) — the pixel count does not tell you which. Guessing from viewport width would be wrong half the time and unoverridable.

**D47 — UI scale is fluid and separate from density.** One custom property on `:root` in `global.css`, driven by viewport width:

```css
:root { --ui-scale: clamp(1, 0.75 + 0.25 * (100vw / 1440px), 1.35); }
```

Type sizes, the rail width and control padding multiply by it — so a 4K display gets proportionally larger text without anything being re-laid-out. **The board's time geometry (px-per-hour, row heights) does NOT scale with it** — those are zoom and density, which the user controls. Scaling both would compound and make Comfortable-on-4K absurd.

Because `--rail-w` now varies, `RAIL_WIDTH` in `BoardGrid.tsx` can no longer be a hardcoded `232`. **Read it from the DOM once per layout** (`getComputedStyle` on the container, or measure the rail cell) into state, and feed that value everywhere `RAIL_WIDTH` is used today — including T2's zoom-centring maths and the max-scroll clamp, both of which are already rail-aware (§18.4). Measure in the existing `ResizeObserver` callback; do not add a second observer and do not measure in a pointer handler.

**D48 — the board fills the viewport.** Today the grid stops after the last row and leaves a white void. `#root` → the router outlet → `BoardPage`'s `.page` → `.body` → `BoardGrid`'s scroll container must form an unbroken `height: 100%` / `flex: 1; min-height: 0` chain, so the scroll container occupies all space below the toolbar and its own background covers it. `min-height: 0` on every flex child in that chain is the part people forget — without it a flex item refuses to shrink below its content and the chain silently breaks.

**D49 — tokens are the source of truth for anything CSS also needs.** `--rail-w`, `--band-h`, `--lane-h` already exist in `tokens.css` and are currently ignored by the TS. Set them from the active density at runtime (one `style` prop on the board root, or `document.documentElement.style.setProperty`), so CSS and TS cannot disagree about a lane's height. Say in your report which mechanism you chose and why.

**D50 — phone legibility, not a phone UI.** The viewport meta already exists. Required: the page must not scroll horizontally as a *page* (only the board's own container scrolls); the toolbar wraps rather than overflowing; the operator panel starts collapsed below 900px viewport width; and `touch-action` on the scroll container permits pan and pinch. Everything else about small screens is Phase 3.

---

## 4. Part A — the pure changes

Confined to `lib/geometry.ts` and `lib/boardIndex.ts`, under the same constraints as before: **no React, no DOM, every import `import type`** (except `boardIndex.ts`'s existing value imports), no enums, every function pure.

- `DENSITIES`, `DensityIndex`, and a `Density` type (D43)
- `trackRowHeight(laneCount, density)` (D44)
- `buildBoardIndex(..., density)` and `BoardIndex.density` (D45)

That is the whole of Part A. It is small on purpose — but it is the part that can silently make every row the wrong height, so it is the part that gets tested.

---

## 5. Part B — the rest

- **`store/boardView.ts`**: `densityIndex: DensityIndex` (default 1) + `setDensityIndex`.
- **`BoardToolbar`**: a three-button density group beside the zoom group, same segmented styling. **Use the compound selector `.density button.densityOn`, never a bare `.densityOn`** — see §7.
- **`BoardPage`**: pass the density into `buildBoardIndex`; apply the `--rail-w`/`--band-h`/`--lane-h` custom properties per D49.
- **`BoardGrid`**: measured rail width replacing the `RAIL_WIDTH` constant (D47); the height chain (D48).
- **`global.css`**: `--ui-scale` (D47) and the `height: 100%` chain (D48).
- **CSS modules**: multiply font sizes and control padding by `--ui-scale` via `calc()`. Row/lane/band sizing comes from the density tokens, not from hardcoded px.

---

## 6. Transitions

**T17 — changing density must not lose the user's place.** Every row height changes at once, so a preserved `scrollTop` in pixels jumps the view. P1-4a's T1 already anchors by node id across a row-height change; **density change must go through that same path**, not around it. If it does not, the board jumps to a different part of the schedule every time the user tries a density.

**T18 — changing density mid-drag.** The toolbar is not reachable without ending a pointer drag, but the keyboard path (P1-4b §8) is. Cancel any active drag on density change, exactly as a collapse toggle does.

**T19 — `--ui-scale` changes on window resize**, which changes the rail width, which changes the horizontal geometry. Re-measure the rail in the existing `ResizeObserver` and clamp `scrollLeft` afterwards so the board cannot end up scrolled past its own content.

**T20 — the operator panel auto-collapsing at 900px** must not fight the user. Auto-collapse applies **once**, on crossing the threshold downward; if the user then opens it, it stays open until they cross the threshold again. A panel that snaps shut on every resize tick is worse than one that never collapses.

---

## 7. The specificity trap — third strike

P1-4a lost the zoom button's selected state to it. P1-4b's brief called it out explicitly, the agent fixed it for `.seg button.segOn`, and then shipped the same bug in `.pri` in three files, where it rendered white-on-white (design plan §18.7).

The mockup (`docs/mockups/model-hybrid.html`) is written entirely in `#pop` / `#shiftModal`-scoped **descendant** selectors, so every state class in it is a compound that ties-and-wins on source order. Flattened into a CSS Module, a bare `.state` class is (0,1,0) and **loses** to the base `.parent element` rule at (0,1,1).

**Every state class you write or touch in this brief must keep the element in the selector.** The ones in play: `.on` / `.segOn`, `.pri`, `.under`, `.override`, `.dragging`, `.full`, and your new `.densityOn`. Write `.density button.densityOn`, never `.densityOn`.

Also from §18.7: **when porting a rule from the mockup, port all of its declarations.** `#pop`'s `width: 260px` was dropped in the P1-4b port and the popover overflowed its own edge as a result.

---

## 8. Part A validation — MANDATORY

Copy `geometry.ts` and `boardIndex.ts` into `/tmp/harness/`, rewrite the `./geometry` specifier to `./geometry.ts`, and run `node --experimental-strip-types /tmp/harness/run.ts`. Print PASS/FAIL; exit non-zero on failure. Minimum cases:

1. **`DENSITIES[1]` ("Standard") reproduces today's numbers exactly**: `trackRowHeight(1, DENSITIES[1]) === 68` (i.e. `36 + 1*28 + 4`), and `groupRowHeight === 30`. This is the regression guard for D43.
2. `trackRowHeight(0, d) === trackRowHeight(1, d)` for **all three** densities (the `max(1, …)` floor).
3. Comfortable > Standard > Compact for the same lane count — strictly, for lane counts 1, 2 and 5.
4. `buildBoardIndex` with Compact produces strictly smaller row heights than the same payload with Comfortable, for both a track row and a group row.
5. `BoardIndex.density` round-trips the density it was given.
6. Row heights still respect lane packing: a node whose assignments pack into 2 lanes is exactly one `laneHeight` taller than one packing into 1, at every density.
7. **The prefix-sum offsets stay consistent**: `buildRowOffsets(rows.map(r => r.height))` totals equal the sum of heights, at every density (guards against a stale constant leaking into one path but not another).

---

## 9. Mutation testing — MANDATORY, report the exact failing line

Break each in `/tmp` only, re-run, record the failing line, restore.

| # | Break | Must fail |
| --- | --- | --- |
| M1 | `trackRowHeight` — ignore the `density` argument and use Standard's numbers always | case 3 or 4 |
| M2 | `DENSITIES[1].laneHeight` 28 → 26 | case 1 |
| M3 | `trackRowHeight` — drop the `max(1, …)` floor | case 2 |
| M4 | `buildBoardIndex` — compute group-row height from a hardcoded 30 instead of the density | case 4's group row |
| M5 | `buildBoardIndex` — ignore the density parameter and default to Standard | cases 4 and 5 |

If a mutation does not fail, the test is the bug — fix it, say so, re-run. **Two of P1-4b's prescribed mutations named a case that could not distinguish mutated from correct code, and the agent caught both.** Check each of these the same way rather than assuming the table is right.

---

## 10. Self-review (all by reading)

1. `GROUP_ROW_HEIGHT` / `BAND_TOP` / `LANE_TOP_OFFSET` / `LANE_HEIGHT` no longer exist as exported constants, and nothing imports them. Show a grep.
2. `232` appears nowhere as a rail width in TS. Show a grep.
3. Every new/edited state class in CSS keeps its element (§7). Show the selectors.
4. No hardcoded row/lane/band px in any CSS module — all from tokens. Show a grep for `px` in the board's modules and justify each survivor.
5. The height chain (D48) is unbroken and every flex child in it has `min-height: 0`. Name the files and lines.
6. Density change routes through T1's anchor path (T17). Name the lines.
7. No new dependency; `package.json` unchanged.
8. Nothing under `src/lib/api/` was touched.

---

## 11. Acceptance — the user runs this

```powershell
npm run format
npm run lint; npm run typecheck; npm run test; npm run build
```

Then `npm run dev -- --host`:

1. At **Standard** density and Standard zoom, the board is **pixel-identical to before this brief**. This is the most important item — anything else is a regression.
2. Comfortable / Compact visibly change row heights; blocks stay correctly positioned within their lanes.
3. Changing density keeps the same rows on screen (T17) — no jump to a different part of the schedule.
4. On the 4K display: text and controls are proportionally larger, and the board fills the window with no white void below the last row.
5. Resizing the window re-scales smoothly; the board never scrolls past its own right edge (T19).
6. Narrow the window below 900px: the operator panel collapses once, and reopening it sticks (T20).
7. On a phone at `http://<lan-ip>:5173`: the board is legible without pinch-zoom, the **page** does not scroll sideways, the toolbar wraps, and the board pans by touch.
8. No console errors.

Mark every item **NOT RUN — no npm in container**.

**Note for the user, include verbatim in your report:** reaching the dev server from a phone needs `npm run dev -- --host` **and** `VITE_SUPABASE_URL` in `.env.local` changed from `http://127.0.0.1:54321` to the laptop's LAN IP — otherwise the page loads and the board stays empty, because the phone resolves `127.0.0.1` to itself.

---

## 12. Delivery

Tar `src/` and `index.html` **only** — never `docs/`, never `node_modules/`, never `/tmp/harness/`. `SendUserFile` → `device_commit_files` to `…\production_scheduler\_delivery\responsive.tar.gz` → `device_bash` to extract → `git status --short`.

Device hazards, all previously hit:

- **On this OneDrive-backed mount an in-place `tar` overwrite of an EXISTING file silently no-ops** — tar reports success, content stays old. This brief edits mostly existing files, so **verify every one with `md5sum` on both sides**, and prefer writing them via a `device_bash` heredoc.
- Extracted files land read-only — `chmod u+w` before patching in place.
- `device_bash` cannot delete files.
- `device_commit_files` can be refused by Windows Controlled Folder Access — do not retry the same path, use a heredoc and say so.
- If you run `git`, a stray `.git/index.lock` may need `Remove-Item .git\index.lock` from PowerShell.

**Do not commit or push. Do not run any npm command.**

---

## 13. Required final step

Edit `docs/roadmap.md`: update the P1-4c row to "code delivered, acceptance pending user run" and refresh **Last updated**. Leave every other row alone.

---

## 14. Report format

1. File tree, one line each.
2. **§8 harness output — the real printed text.**
3. **§9 mutation results — the exact failing line for M1–M5.**
4. §10 self-review, item by item, with evidence.
5. §11 acceptance block, every item NOT RUN, including the verbatim LAN-access note.
6. **Every assumption where this brief was silent, and anything you had to decide.** On this project the agent's flagged deviations have repeatedly been real bugs in the brief.
7. Anything left undone.
