# S67-b — the toolbar band as the maintainer's mock: two columns, the whole key with its count, the range as one control, "More" (R-445 corrected 18 Sept)

The maintainer saw the shipped band on 18 Sept and said: "The product keys are missing from show more, the
position of the buttons is also not correct." Their mock (approved with a second agent on 17 Sept; the
plan's R-445 note describes it, the image is theirs) is the contract now. Read R-445 in `docs/plan.yaml`
(its claim, its note, and the CORRECTED lines dated 18 Sept), CLAUDE.md §4 and §7, then
`src/features/board/components/BoardToolbar.tsx`, `BoardToolbar.module.css`, `src/test/boardToolbar.test.tsx`,
`src/components/icons.tsx` (the chevron; `iconStandard.test.ts` bans arrow glyphs in text), and how
`BoardPage.tsx` renders `<BoardToolbar` (its props; you may drop `productIdsInWindow` from both ends).

You own `BoardToolbar.tsx`, `BoardToolbar.module.css`, `boardToolbar.test.tsx`, `e2e/toolbarShowMore.ts`,
and the `<BoardToolbar` props hunk in `BoardPage.tsx` only. Another lane works in the admin screens at the
same time; ignore its files and any tsc error in them. No commits, no docs edits, no full `npm run test`,
no playwright (the developer runs the walks).

The mock, in words (match it, not the current band):

1. **The row**, left to right: "Board" · the plant picker · a prev/Today/next group drawn as one segmented
   control (‹ · Today · ›) · the date range as ONE dropdown control reading "Thu Sep 17 – Sat Sep 19" with a
   chevron, which opens a small pop-over holding the From date field and the Days field that today sit in
   the row · the three zoom levels as one segmented control · the "More" button, last, with a chevron
   that points up when open and down when closed (the `Chevron` from icons.tsx, never a glyph in text);
   `aria-expanded` and `aria-controls` stay; the accessible name stays "Show more" / "Show less" via
   `aria-label` so the existing pins and the specs' helper keep working, while the visible text is "More".
   Nothing else is in the row; "refreshing…" may stay as a quiet text at the row's end.
2. **The band**, still a layer over the board (S67-a's positioning, height bound and focus rules stay), is
   TWO columns: left, "WEEK PLAN" as a small uppercase heading with the three buttons in a plain row
   beneath it (no bordered strip around them); right, taking the remaining width, "KEY — N PRODUCTS" as the
   heading, then the products as swatch + name in even columns (four at the mock's width, `auto-fill`),
   then a thin divider, then the understaffed and break marks. A viewer, who has no Week plan, gets the
   key alone across the full width.
3. **The key lists the whole readable catalogue** the board is given (`products`), sorted by name as it
   reads, with the count in the heading. The 17 Sept filter to products with a run in the window is
   withdrawn by the maintainer's words ("the product keys are missing"): remove `productIdsInWindow` and
   its BoardPage memo; rewrite TB-5 to pin the catalogue and the count (say in the file that the contract
   changed and why), keep TB-6's order pin.
4. Pins: TB-9 the row's control order by accessible name; TB-10 the range control opens a pop-over with
   the From and Days fields and closes on Escape with focus back on it; TB-11 the two columns exist for
   the admin and only the key for the viewer; TB-12 the More button's visible text and its accessible name.
   Update `e2e/toolbarShowMore.ts` if the accessible name it clicks changes (it should not).

Then `npx vitest run src/test/boardToolbar.test.tsx src/test/copyWeek.test.tsx src/test/copyWeekDialogTemplate.test.tsx
src/test/scaleAudit.test.ts src/test/iconStandard.test.ts src/test/fieldStandard.test.ts src/test/popoverStandard.test.ts`,
`npx tsc -b`, `npx eslint src/features/board src/test`, `npx prettier --check` on your files, and a
screenshot of the real band open as Dana at 1340px wide to `test-results/s67-b-band.png` (sign-in as in
`e2e/typedWalk.spec.ts`; no writes). Report: the pins, the cases changed with reasons, the runners'
totals verbatim, the screenshot path, and anything the brief got wrong.
