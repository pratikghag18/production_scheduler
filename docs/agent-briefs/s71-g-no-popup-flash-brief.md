# S71-g — a sentence the bar writes for you never flashes the pop-up (F-205)

Serves finding **F-205** (the maintainer, 23 Sept: "when the board asks me a question, there is a
pop up which appears before vanishing. It happened now with selecting Housing A for #4") and
**R-384** (Enter on a typed sentence creates the block without a second press) and **R-431**
(nothing offered that the server refuses — the pop-up's checks are the gate and must still run).

## 0. Why it flashes

`src/features/board/components/CreatePopover.tsx` ~730-760: when the bar opens the pop-up
(`useDragGesture.ts` ~1998 `openCreateFromCommand` sets `autoCreate: true`), a mount effect
presses Create once if the pop-up's own verdicts read `clean`. The pop-up is fully rendered for
that frame and for the write's round trip, then closes on the result. The person sees a form
appear and vanish. The bar's readout already says what is being written, so the form adds
nothing in that case. Sentences the bar wrote directly ("read by the model") flash the same way;
the maintainer noticed it on the answered Did-you-mean because the eye was on the buttons.

## 1. The change

While `autoCreate` is set AND the pop-up's `clean` verdict is true AND the auto-press has not
answered yet, the pop-up renders NOTHING visible: keep the component mounted (its effect, its
checks and its `onResult` must run exactly as today) but return its markup wrapped so it is not
painted — the simplest honest way is a `hidden` attribute or `visibility: hidden` on the root
via a CSS-module class (`CreatePopover.module.css`), never `display: none` if any measurement
depends on layout (check `useLayoutEffect`/`getBoundingClientRect` in the file first; if none,
`hidden` is fine). If the auto-press is NOT taken (`clean` false — a warning the person must see,
or a not-certified question), the pop-up shows exactly as today. If the server refuses the
auto-press, the pop-up shows itself with the refusal, as today (read how a refusal is displayed
after `submitDirect`/`submitRun` and make sure hiding does not swallow it — the refusal must
become visible or reach the bar's thread through `onResult`; find out which it is today and keep
it).

Also cover `openCreateRunFromCommand` (the run/book path) the same way — same `autoCreate`.

## 2. Pins

`src/test/createPopover.test.tsx` (read its `autoCreate` cases — R-384 pins — and copy their
harness): CP-flash-1: `autoCreate` + clean → the root is not visible (`toBeVisible()` false or
`hidden` present) at first render and Create was pressed once; CP-flash-2: `autoCreate` + a
warning (not clean) → visible, no auto-press; CP-flash-3: `autoCreate` + clean + the server
refuses → the refusal is shown (visible) or reported through `onResult` exactly as the existing
refusal case asserts; CP-flash-4: a drag-opened pop-up (no `autoCreate`) is visible as before.

`npx vitest run src/test/createPopover.test.tsx src/test/commandBar.test.tsx`; prettier, eslint,
`npx tsc --noEmit -p .` (errors in your files only).

## 3. Files you own / must not touch

Own: `src/features/board/components/CreatePopover.tsx`, `CreatePopover.module.css`,
`src/test/createPopover.test.tsx`. Do not touch `useDragGesture.ts`, `CommandBar.tsx`,
`BoardPage.tsx`, `scripts/`, `docs/plan.yaml`. Do not run the full `npm run test`. Do not commit.

## 4. Report

Under 25 lines: how the hiding is done and why that attribute; what happens on a refusal (found,
kept); the pin ids; totals; lint status.
