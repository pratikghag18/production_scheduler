# Agent Brief P1-4d — Fit-to-Height (automatic vertical scale)

**Executor:** a fresh Sonnet agent (no prior context). **Phase:** 1, eighth build task.
**Depends on:** P1-4c (density table, `--ui-scale`, measured rail width) — built and working.
**Rules:** no design decisions of your own. Note assumptions; do not ask questions mid-run.

**One-line scope:** the board scales its rows to fill the available height automatically, instead of rendering at a fixed size and leaving the bottom half of a large screen empty.

**This supersedes part of P1-4c's D46.** That decision made density a manual, user-chosen setting on the reasoning that a 4K screen might be a wall display or a dense planning station and the pixel count cannot tell you which. That is true and it answered the wrong question: **the variable that matters is row count, not screen size.** An admin sees 7 cells, an Assembly supervisor 5, a line supervisor 2 — on the same screen. No fixed density fills the viewport for all three. D46 is amended, not deleted: manual density stays available as an override.

---

## 0. The npm block, and the hole in it

You cannot run npm (registry blocked, 403 by policy — also pip and apt). Node 22 here runs `node --experimental-strip-types`, so the usual split applies:

| Part | What | You validate it? |
| --- | --- | --- |
| **A** | `computeFitScale` + `scaleDensity` in `lib/geometry.ts`. Pure. | **YES — §6 and §7 are mandatory, with real output.** |
| **B** | Wiring the measured height in, the Fit toggle, `--ui-scale` | No. Author only; §9 items are **NOT RUN — no npm in container**. |

Reporting §6 or §7 as NOT RUN makes the delivery incomplete.

---

## 1. Study first

1. **`src/features/board/lib/geometry.ts`** — `DENSITIES`, `Density`, `trackRowHeight`, `buildRowOffsets`. You are adding two pure functions here.
2. **`src/features/board/lib/boardIndex.ts`** — `buildBoardIndex(data, windowStart, windowEnd, density)` and `BoardIndex.rows[].height`. **Its signature does not change**; it receives an already-scaled density.
3. **`src/features/board/components/BoardGrid.tsx`** — the `ResizeObserver` (which already measures viewport height and the rail probe), the virtualization, and the T1 scroll-anchor effect.
4. **`src/features/board/BoardPage.tsx`** — where `buildBoardIndex` is called and where the density custom properties are set.
5. **`src/features/board/store/boardView.ts`** — `densityIndex` lives here.
6. **`src/features/board/components/BoardToolbar.tsx`** + `.module.css` — the density button group you are extending.
7. **`src/styles/global.css`** — the `--ui-scale` block and its `@supports` guard.
8. **`docs/design-plan.md` §18.9** — what P1-4c did and what it deliberately left.

Files are on the device at `<repo root>`. Stage with `device_stage_files`.

---

## 2. Scope fence

Do **not**: change the horizontal/time axis (zoom stays exactly as it is), change any drag/popover/mutation/query behaviour, build a separate kiosk or mobile layout, add a dependency, or touch `src/lib/api/`.

---

## 3. Decisions already made — implement, do not revisit

**D51 — the fit scale is one number, computed in one pass, and is not circular.**

```
naturalHeight = Σ row heights computed at DENSITIES[1] (Standard), unscaled
fitScale      = clamp(FIT_MIN, availableHeight / naturalHeight, FIT_MAX)
FIT_MIN = 0.75   FIT_MAX = 2.5
```

`availableHeight` is the scroll container's measured client height minus the sticky header track's height. **Compute the scale from the *natural* heights, never from the scaled ones** — that is what makes it a single pass instead of a feedback loop that oscillates.

The clamps are not arbitrary. Measured against the seed board: Admin (7 cells, 740px natural) needs 1.54× on a 4K browser viewport and 0.97× on a laptop; Ana (5 cells, 544px) needs 2.09× and 1.32×. Both land inside the range, so **the common cases fill the screen exactly**. A line supervisor with 2 cells (254px) would need 4.5× on 4K and 7.8× on a TV — clamped to 2.5×, because a single row 600px tall is not a better board, it is a worse one. Some empty space below a two-row board is the correct answer; see §10.

**D52 — `scaleDensity(base, factor)` is pure and returns integers.**

```ts
export function scaleDensity(base: Density, factor: number): Density;
```

Every numeric field multiplied by `factor` and **rounded to an integer** — row offsets are pixel positions and a sub-pixel one blurs every border on the board. `name` is preserved. `scaleDensity(d, 1)` must return values **equal to `d`** for every field: that is the identity guard, and it is what proves Fit-off is unchanged from P1-4c.

**D53 — four mutually exclusive modes in one toolbar group: `Fit | Comfortable | Standard | Compact`. `Fit` is the default.**

- **Fit** computes `fitScale` per D51 and renders `scaleDensity(DENSITIES[1], fitScale)`.
- The three named densities are a manual override: picking one turns Fit off and renders that density unscaled, exactly as P1-4c does today.
- Clicking **Fit** returns to automatic.

Store this as `densityMode: "fit" | 0 | 1 | 2` replacing `densityIndex`. Default `"fit"`.

**D54 — under Fit, `--ui-scale` follows the fit scale, not the viewport.** A row 2.5× taller with 11px text looks broken. When Fit is on, set `--ui-scale` as an inline style on the board root to `clamp(1, fitScale, 1.75)` — computed in JS as a plain number, so the `@supports` path is not involved at all. When Fit is off, leave `--ui-scale` to the existing viewport-driven CSS from P1-4c. Text therefore grows with the rows under Fit, and with the screen otherwise, and never by both at once.

**D55 — recompute on every input that changes either term.** `availableHeight` changes on viewport resize; `naturalHeight` changes when the row set changes — collapse/expand, an identity switch, a data refetch that alters lane counts. Both already trigger a render; derive `fitScale` with `useMemo` from the measured height and the natural heights. **Add no new observer** — `BoardGrid`'s existing `ResizeObserver` already reports the height.

**D56 — when the content fits, the board must not be vertically scrollable.** That falls out of D51 when `fitScale` is unclamped, but assert it: if `naturalHeight * fitScale <= availableHeight`, there is no vertical overflow. At `FIT_MIN` with many rows it will overflow and scroll normally — that is correct.

---

## 4. Part A — the two functions

In `lib/geometry.ts`, under the usual constraints (no React, no DOM, `import type` only, no enums, pure):

```ts
export const FIT_MIN = 0.75;
export const FIT_MAX = 2.5;

/** D51. `naturalHeights` are row heights at Standard, unscaled. Returns 1
 *  when there is nothing to measure (no rows, or availableHeight <= 0) — a
 *  board that has not been measured yet must render at its natural size,
 *  never at a degenerate scale. */
export function computeFitScale(naturalHeights: number[], availableHeight: number): number;

/** D52. Every numeric field × factor, rounded to an integer. */
export function scaleDensity(base: Density, factor: number): Density;
```

That is the whole of Part A. Small, and it is the part that can silently make every row the wrong height — so it is the part that gets tested.

---

## 5. Part B

- **`store/boardView.ts`**: `densityMode: DensityMode` (default `"fit"`) + `setDensityMode`. Remove `densityIndex`; leave no deprecated alias.
- **`BoardGrid`**: expose the measured available height (container client height − header height) upward, or compute `fitScale` there and pass the effective density down — **your choice, but say which and why in your report.** Whichever you pick, `buildBoardIndex` must end up receiving the effective density.
- **`BoardPage`**: mode → effective density; set `--ui-scale` inline under Fit (D54).
- **`BoardToolbar`**: the four-button group. **Compound selector — `.density button.densityOn`, never a bare `.densityOn`** (§18.7: this trap has bitten this project three times).

---

## 6. Part A validation — MANDATORY

Harness in `/tmp/harness/`, `node --experimental-strip-types run.ts`, PASS/FAIL lines, non-zero exit on failure. Minimum cases:

1. **Identity:** `scaleDensity(d, 1)` deep-equals `d`, for all three densities. (The Fit-off regression guard.)
2. `scaleDensity` returns integers for every field at factors 0.75, 1.37, 2.5.
3. `scaleDensity(d, 2)` roughly doubles each field (within rounding), and preserves `name`.
4. `computeFitScale([], 800) === 1` and `computeFitScale([100,200], 0) === 1` — degenerate inputs never produce 0, NaN or Infinity.
5. `computeFitScale([500], 1000) === 2` exactly; `computeFitScale([1000], 500) === 0.75` (clamped from 0.5); `computeFitScale([100], 10000) === 2.5` (clamped from 100).
6. **Fill property:** for a natural total `N` and available `A` where `A/N` lies inside `[FIT_MIN, FIT_MAX]`, `N * computeFitScale([N], A)` equals `A` (within 1px of rounding). This is the point of the whole brief — assert it.
7. **Ordering survives scaling:** a 2-lane row stays taller than a 1-lane row after `scaleDensity`, at factors 0.75, 1, 2.5.
8. `scaleDensity` does not mutate its input.
9. A band still fits above the first lane after scaling: `bandTop + bandHeight <= laneTopOffset`, at factors 0.75, 1.37 and 2.5. **Rounding is what can break this** — check it rather than assuming.

---

## 7. Mutation testing — MANDATORY, report the exact failing line

| # | Break | Must fail |
| --- | --- | --- |
| M1 | `computeFitScale` — drop the clamp entirely | case 5's two clamped cases |
| M2 | `computeFitScale` — return `availableHeight / naturalTotal` with no zero-guard | case 4 |
| M3 | `scaleDensity` — `Math.floor` instead of `Math.round` | case 1's identity at some field, or case 3 |
| M4 | `scaleDensity` — skip `bandTop` (leave it unscaled) | case 9 at factor 2.5 |
| M5 | `computeFitScale` — compute from already-scaled heights (pass the scaled total back in) | case 6's fill property |

If a mutation does not fail, the test is the bug — fix it, say so, re-run. **Prescribed mutation tables on this project have twice named a case that could not distinguish mutated from correct code**, and both times the agent caught it. Check each rather than trusting the table.

---

## 8. Self-review (by reading)

1. `computeFitScale` is called with **natural** heights, never scaled ones. Name the lines.
2. No new `ResizeObserver` (D55). Show a grep for `ResizeObserver` in the feature.
3. `densityIndex` no longer exists anywhere. Show a grep.
4. The `useMemo` deriving `fitScale` has a complete dependency array.
5. Fit-scale change routes through the existing T1 anchor path, as density change already does.
6. The new state class keeps its element (§18.7). Show the selector.
7. `buildBoardIndex`'s signature is unchanged; it receives an effective density.
8. No new dependency; `package.json` unchanged; `src/lib/api/` untouched.

---

## 9. Acceptance — the user runs this

```powershell
npm run format
npm run lint; npm run typecheck; npm run test; npm run build
```

Then `npm run dev -- --host`:

1. **Fit is on by default** and the board fills the window vertically with no dead area below the last row, as Admin, on both a laptop and the 4K display.
2. Switch to **Ana** (5 cells) and back to **Admin** (7 cells): the board re-fits each time, still filling the height.
3. Collapse a group: the remaining rows grow to fill the space. Expand: they shrink back.
4. Resize the window: rows re-fit smoothly, and the same rows stay on screen.
5. Picking **Comfortable / Standard / Compact** turns Fit off and renders that density unscaled — **Standard must look exactly as it does today**, the P1-4c regression guard.
6. Clicking **Fit** returns to automatic.
7. Text grows with the rows under Fit, and is not tiny on the 4K screen.
8. No console errors.

Mark every item **NOT RUN — no npm in container**.

---

## 10. Known limit — state it, do not try to fix it

A board with very few rows on a very large screen still leaves space. Measured: 2 cells on a 2160px TV needs 7.8× to fill and is clamped to 2.5×, leaving ~68% empty. **That is intended.** Rows 600px tall are not a better board. Genuinely filling a wall display with two rows needs a different layout — bigger type, fewer columns, a summary panel — which is a separate design question and explicitly **not** this brief. If you find yourself raising `FIT_MAX` past 2.5 to chase it, stop and flag it instead.

---

## 11. Delivery

Tar `src/` **only**. `SendUserFile` → `device_commit_files` to `…\production_scheduler\_delivery\fit-to-height.tar.gz` → `device_bash` to extract → `git status --short`. **Or** write files directly via `device_bash` heredoc and verify each with `md5sum` on both sides — the previous agent chose this and it worked well, because:

- **On this OneDrive-backed mount an in-place `tar` overwrite of an EXISTING file silently no-ops** — tar reports success, content stays old. This brief edits mostly existing files. Whichever route you take, **verify every file with `md5sum` on both sides.**
- Extracted files land read-only — `chmod u+w` before patching.
- `device_bash` cannot delete or move files.
- `device_commit_files` can be refused by Windows Controlled Folder Access — do not retry the same path.
- If you run `git`, a stray `.git/index.lock` may need `Remove-Item .git\index.lock` from PowerShell.

**Do not commit or push. Do not run any npm command.**

---

## 12. Required final step

Edit `docs/roadmap.md`: update the P1-4d row to "code delivered, acceptance pending user run" and refresh **Last updated**. Leave every other row alone.

---

## 13. Report format

1. File tree, one line each.
2. **§6 harness output — the real printed text.**
3. **§7 mutation results — the exact failing line for M1–M5.**
4. §8 self-review with evidence, including your D53/§5 choice of where `fitScale` is computed and why.
5. §9 acceptance block, every item NOT RUN.
6. **Every assumption, and anything in this brief that is wrong, impossible, or contradicted by what you find on disk.** On this project that section has repeatedly been the most valuable part of the report — a false premise in a brief was correctly rejected last time rather than "fixed".
7. Anything left undone.
