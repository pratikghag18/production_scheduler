# S67-a — the board toolbar: one row, and "Show more" as a layer with labelled groups (R-445, F-170)

Read R-445 (its claim, its note with the two DECIDED points, and F-170) in `docs/plan.yaml`, and
CLAUDE.md §4 and §7 (the standards; "a screen that shows what the server will refuse" — every control in
the band keeps its existing rights check, and a control nobody at this level can use holds no space).
Then `src/features/board/components/BoardToolbar.tsx` (all 390 lines: the props, the key at ~327–340
mapping `products` straight out with no filter, the two leftovers at ~377–386), `BoardToolbar.module.css`,
where `BoardPage.tsx` renders `<BoardToolbar` (its props, the rights it passes), `e2e/roleWalk.spec.ts`
~183–195 (the observation fields the walk reads off the toolbar — `shiftChips`, `panelPresent`,
`commandBarPresent`) and any toolbar assertion in it, and `src/features/board/lib/panelSize.ts` (S63's,
uncommitted on disk) for the per-person remembered-state shape. `computeFitScale` (grep in
`src/features/board/lib/`) is why the band must be a layer: the board's height feeds the row scale.

You own: `BoardToolbar.tsx`, `BoardToolbar.module.css`, a new `src/test/boardToolbar.test.tsx`, and the
smallest possible edit to `BoardPage.tsx` (only the props the toolbar needs, e.g. the runs in the shown
window for the key; another lane edits BoardPage's rail render at the same time — touch nothing else
there). `e2e/roleWalk.spec.ts`: edit its toolbar observations only if a selector you change breaks them,
and say exactly what. Do not run the full `npm run test`; do NOT run playwright (the dev server is shared;
the developer runs the role walk after the lanes land); no commits; no docs edits; ignore `tsc` errors in
files you do not own. No new colour token; px/rem per `scaleAudit.ts`'s rules for this stylesheet (read
its header — the toolbar is chrome, `--chrome-scale`).

1. **One row.** The row keeps: the plant (the "Viewing as" / plant name as it is), the day navigation
   (Prev, Today, Next), the date range, and the three zoom levels. Everything else leaves the row.
   Nothing is renamed.
2. **Show more.** One button, "Show more" / "Show less", `aria-expanded`, `aria-controls`. It opens a
   band positioned ABSOLUTELY below the toolbar, over the board (z-index between the board content and
   the shared Popover's 90; read `CommandLauncher.module.css`'s reasoning and pick the same tier as the
   launcher, 80, or say why another), so the board's height never changes: pin that the grid's container
   height is identical open and closed. Closed on a fresh board; remembered per person: reuse
   `panelSize.ts`'s storage helpers with your own key prefix and the same per-person key BoardPage gives
   the launcher (`historyKey`), or a two-line helper beside it if the shape does not fit; say which.
   Escape inside the band closes it; a click on the board does not (it is a layer, like S63's panel);
   the button toggles.
3. **Labelled groups.** Inside the band: "Week plan" holding Copy week, Apply a template, Save this
   week as a template, each rendered under exactly the rights check it has today (move the JSX, do not
   re-derive the predicate); and "Key". A group with no control the current person may use is not
   rendered at all, and the same rule applies to the row: a control nobody at this level can act on
   holds no space (a viewer's toolbar is shorter). Pin TB-1..TB-4 with the three demo roles' rights.
4. **The key.** DECIDED: the key lists only products with a run inside the shown window (filter on the
   client from the runs BoardPage already holds — take the runs, or the set of product ids, as a prop),
   sorted by name as it reads (locale-aware `localeCompare`), drawn as even columns (CSS grid,
   `repeat(auto-fill, minmax(…))`, aligned swatch + name), never a ragged wrap. Pin TB-5..TB-6: a product
   with no run in the window is absent; order is by name.
5. **F-170.** Remove "snap: 30 min (P1-4b)" and its comment; if a snap value is worth showing at all
   beside the zoom, it is plain words ("snaps to 30 min") with no brief id — the developer's default is to
   remove it. The end-of-window note renders only when the person is actually at the edge of the loaded
   window (the toolbar or BoardPage must know the scroll position vs. the window's end — find the
   existing signal, e.g. the scroll container's `scrollLeft` at max, or the last shown day being the
   window's last; if nothing exists, add the smallest prop) and loses its "in P1-4a" title. Pin TB-7..TB-8.

Then `npx vitest run src/test/boardToolbar.test.tsx src/test/scaleAudit.test.ts src/test/fieldStandard.test.ts
src/test/popoverStandard.test.ts src/test/iconStandard.test.ts`, `npx tsc -b`, `npx eslint src/features/board
src/test`, `npx prettier --check` on your files. Report: the pins, the runners' totals verbatim, the exact
BoardPage lines you touched, the z-index you chose and why, how the edge signal is derived, and anything
the brief got wrong.
