# Wave 2, lane C — the touch acceptance pass on both drags

You are one of three parallel lanes. Two other agents are editing this repo at the same time.
**Touch only the files listed under "You own" below.** Ignore `tsc`/ESLint errors in files you do
not own. Do not run the full `npm run test`; run only the test files named here. Do not commit; do
not edit `docs/plan.yaml` — report your plan additions as YAML text in your final message and the
developer session will place them.

Read first: `CLAUDE.md` (all of it), `docs/plan-format.md`, and in `docs/plan.yaml` the
requirements titled "Whole row drags with a mouse; handle alone on touch" and "The level list has a
drag grip that works by touch", and the queue's standing note *"touch acceptance pass on both
drags"*. Then read `src/features/board/hooks/useDragGesture.ts` (the header and every
`setPointerCapture` site), `src/features/admin/lib/dragPointer.ts`, `src/lib/interaction.ts`,
`playwright.config.ts`, `e2e/env.ts`, `e2e/roleWalk.spec.ts` (how a spec signs in and finds the
board), and `e2e/copyWeek.spec.ts` (how a spec drives the board with a mouse).

## What the maintainer wants

The queue's own words: *"Drags use pointer events but have never been tried on a tablet. Verified
on a touch screen, fixes as found."* There is no tablet on the developer's machine, so "verified"
means: driven with real touch input in a browser, asserted, and kept as a test that runs with the
rest of the browser suite.

The gestures in question, and what each must do under a finger:

1. **The board (`useDragGesture`), three gestures on a track:** create (press on empty track and
   drag), move (press on a block and drag), resize (press on a block's edge and drag), plus the
   roster-chip drag from the operator panel onto a track. The blocks carry `touch-action: none`
   and the grid `touch-action: pan-x pan-y pinch-zoom`, so a finger on a block drags the block and a
   finger on the grid background scrolls the board. Assert both halves: a drag on a block moves it
   (the popover or the moved block appears, exactly as the mouse spec asserts), and a drag on
   empty grid background — where `TrackRow` starts a CREATE gesture on pointerdown — either creates
   or scrolls, whichever the current code does; write down which, because the answer is a
   requirement and the maintainer has not been asked. Recommend one in your report.
2. **The admin tree (`NodeTreeEditor`) and the level list (`LevelEditor`):** by the two requirements
   above, on touch ONLY the `⠿` grip drags (`rowIsDragSource` refuses `"touch"`), so the rest of the
   row stays scrollable. Assert that a finger on the row body does not reorder, and a finger on the
   grip does.
3. **The popover's title bar** (`Popover.tsx`) is a drag handle with `touch-action: none`. Assert a
   finger can move the popover and that a tap on a button inside it still works.

## How to drive touch in Playwright

Playwright's `page.touchscreen` only taps. For a drag you need real touch events with a pointer type
of `touch`, and the Chromium way is the CDP command `Input.dispatchTouchEvent`:

```ts
const cdp = await page.context().newCDPSession(page);
await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x2, y: y2 }] });
await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
```

Step the move in several increments (the board's `DRAG_THRESHOLD_PX` is 4 and the tree starts a
drag only after the threshold) so the sequence is what a finger produces. The browser context must
be created with `hasTouch: true` for `touch-action` and pointer type to behave as on a tablet: add a
second Playwright project named `touch` to `playwright.config.ts` using a tablet device profile
(`devices["iPad (gen 7)"]` or `devices["Galaxy Tab S4"]`; pick one whose default browser is
Chromium, since CDP is Chromium-only) with `testMatch: /touch\.spec\.ts/`, and give the existing
`chromium` project `testIgnore: /touch\.spec\.ts/` so the touch spec runs only under the touch
profile. Keep the CI runner able to run it: `scripts/ci-e2e.sh` runs `npx playwright test`; check
that adding a project does not double-run the other specs.

Do not `page.evaluate` synthetic `PointerEvent`s as the primary path — they bypass `touch-action`
and prove nothing about scrolling. Use them only if CDP touch cannot reach a case, and say so.

## The rules

- **Fixes as found, minimally.** If a gesture fails under touch, fix it in the file that owns the
  gesture and pin the fix with the same spec case that found it. Say for each fix what a person on a
  tablet would have seen. Do not restyle, refactor, or "improve" anything that passed.
- **Walk it as the least-privileged person.** The board cases sign in as Ana (`ana@example.test`,
  Line 1 supervisor) and as a viewer (Viva, `viva@example.test`) — a viewer's finger must not start a
  drag at all (read `e2e/viewerBoard.spec.ts` for what a viewer's board refuses). Admin tree cases
  sign in as Dana (`dana@example.test`, Plant A site admin). All passwords are `devpassword`.
- **Leave the demo world as you found it.** Every drag that changes data must be undone in the same
  test or done on a week the other specs do not read (see `copyWeek.spec.ts` for how it picks a
  scratch week). `e2e/roleWalk.spec.ts` reads the demo week and must still pass after your run.
- **A drag that scrolls is not a failed drag.** Distinguish "the gesture did nothing because it was
  refused" from "the gesture scrolled the container" in your assertions, and from "the gesture
  started and the server refused the write" (a toast or a refusal sentence).

## Tests

- `e2e/touch.spec.ts` (new): cases T1… covering the list above, one `test()` per case, each
  skipping on `!hasRealBackend` the way `signedIn.spec.ts` does.
- If a fix touches a pure helper (`dragPointer.ts`, `src/features/board/lib/*`), pin it in the
  existing vitest file for that helper (`src/test/dragPointer.test.ts` or the board's geometry
  tests) with a new lettered case, and run that file alone.

## You own (exclusive)

- `e2e/touch.spec.ts` (new), `playwright.config.ts`, `scripts/ci-e2e.sh` (only if the project split needs it)
- Everything under `src/features/board/` and `src/components/Popover.tsx` / `Popover.module.css`
- `src/features/admin/components/NodeTreeEditor.tsx`, `LevelEditor.tsx`, their CSS Modules, `dragSurface.module.css`, `src/features/admin/lib/dragPointer.ts`
- `src/lib/interaction.ts`
- The vitest files for those helpers, and only to add cases

You do NOT own anything under `src/features/auth/`, `src/routes.tsx`, `src/App.tsx`,
`src/components/AppShell.tsx`, or the other `e2e/*.spec.ts` files (lanes A and B). If you believe
you need a change in one of those, write what and why in your final report and stop short.

## Finish

1. `npx prettier --write` and `npx eslint` on your files; `npx playwright test --project=touch`; then `npx playwright test --project=chromium e2e/roleWalk.spec.ts` to prove the demo world is intact and the project split did not break the mouse suite. Paste the runners' total lines verbatim.
2. Final report, in this order: what a person on a tablet can now rely on, gesture by gesture, with the ones that FAILED before a fix called out first; the files added and changed (from `git status`); the runner lines; the open question on "finger on empty grid: create or scroll" with your recommendation; then the plan additions as YAML: one `requirements` row with id **R-350** ("Every drag on the board and in the admin tree works under a finger, and a finger on a scrollable surface scrolls"), `stated_by: maintainer`, `source: [queue item "touch acceptance pass on both drags", session 84 conversation]`, `verified_by` naming your cases; and a `findings` card **F-108** for each real thing that was broken under touch (one card, several paragraphs, in the `story` shape of F-105), or none if nothing was. Anything you could not finish, said plainly.
