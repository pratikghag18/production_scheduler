# S63-a — the bar as a chat panel: bubbles, a layer that stays open, resizable, and Enter empties the box (R-428, R-429, R-437)

Read R-427, R-428, R-429 and R-437 in `docs/plan.yaml` (and CLAUDE.md §7, the standards — R-434
applies: anything you add to the bar that hears, asks, writes or refuses must land in the trace and
the thread). Then read `src/features/board/components/CommandLauncher.tsx` (the module doc: what
closes, what cancels, the `[role="dialog"]` exemption, the focus rules), `CommandLauncher.module.css`,
`CommandBar.tsx` from `turnResultLine` (about line 660) and its render tree (from line 3120), `CommandBar.module.css`,
and `src/features/board/store/commandConversation.ts` (`HistoryTurn`, `ConversationValues`,
`historyStorageKey`). Look at `src/test/commandLauncher.test.tsx` (CL-1..CL-9, CB-keep-4..6, CH-5) and
the CH-1, CH-2, CH-6 and CB-ans-1..5 cases in `src/test/commandBar.test.tsx` before you change either.

You own: `CommandBar.tsx`, `CommandBar.module.css`, `CommandLauncher.tsx`, `CommandLauncher.module.css`,
`commandBar.test.tsx`, `commandLauncher.test.tsx`, and one new pure module for the remembered size
(`src/features/board/lib/panelSize.ts` + `src/test/panelSize.test.ts`). Nothing else; if the work leads
anywhere else, stop and say where. Do not run the full `npm run test`; no commits; no docs edits. Ignore
`tsc` errors in files you do not own.

Wording is unchanged unless this brief names the line: every sentence the thread says today is what the
bubbles say tomorrow. Only the shape changes. No new colour (F-130): every colour is a token from
`src/styles/tokens.css`. `fieldStandard.test.ts` bans a `--axis` border together with a radius outside
the field module — bubbles use `--grid` or no border. The launcher's CSS is px on purpose (its header
says why); keep it so.

1. **R-428 — bubbles.** Each finished turn in the thread becomes: the person's words (`heard`) in a
   bubble on the RIGHT; the board's lines on the LEFT, each its own bubble — `asked` (with the offered
   chips INSIDE that bubble, the chosen one marked as today), then the result line (`Written: …`,
   `Refused: …`, `Waiting: …`, `Cancelled`) as its own left bubble. Drop the "You: " and "Board: "
   prefixes — the side says who. Two colours: the person's bubble is `--ink` on `--avatar-fg` text
   (the launcher button's own pair), the board's is `--page` with `--ink` text and a `--grid` border.
   The CURRENT turn reads the same way: the sentence (`sentence`, F-162's said line) is a right bubble,
   the live status line is a left bubble with the live candidate buttons inside it (the lot's own
   "Do all N" included — that button inside the bubble is one of the card's two wording items; the
   label stays). Keep the status element's `aria-live="polite"` and its role exactly where the pins
   read it (the text content of the status line is what every existing pin asserts; put the bubble
   styling on the element or a wrapper, never change what `getByText`/the aria-live query returns).
   The "Earlier today" head and "Clear history" stay, above the bubbles. The thread scrolls to the
   bottom as today. Give the bubbles a `data-side="you"|"board"` attribute so the pins can read the
   side without the class hash. Pin CP-1..CP-4: a finished turn renders one right bubble with the
   heard text and left bubbles for the question and the result; the chips sit inside the board's
   bubble with the chosen one marked; the current sentence and question are right/left; nothing in a
   past turn is a button (CH-6 stays).

2. **R-429 — a panel that stays open.** In `CommandLauncher.tsx` REMOVE the close-on-outside-mousedown
   effect and everything that exists only for it (`FOCUSABLE_SELECTOR`, the `refocusButton` exception,
   the `[role="dialog"]` walk); rewrite the module doc so it says what is true now. The panel closes
   only by: the launcher button (it already toggles), a new close control in the panel header (a
   button labelled "Close", replacing the "Esc closes" text or beside it — it must have an accessible
   name), and Escape inside the panel (the existing two rules). Scrolling, dragging and clicking the
   board or the toolbar leave it open; the board stays fully usable beside it (no backdrop, no
   `aria-modal`, no pointer capture). Focus: the close button and Escape return focus to the launcher
   button as `close()` does today. Say in a comment in the file which cases you rewrote and why:
   CL-5 and CB-keep-4 pinned the outside close; the contract changed (R-429), so their assertions
   invert (a mousedown outside leaves the panel open and the store untouched); CL-5b becomes moot —
   delete it and say so. CL-9's focus cases: keep the Escape half, drop the mousedown half.

3. **R-429 — resizable, remembered.** The panel is anchored bottom-right, so it grows from its top and
   left edges: a drag handle on the top-left corner (and, if cheap, the top and left edges) changes
   width and height with pointer events; clamp to a minimum (320 × 240) and to the viewport minus the
   18px margins. The thread body's `max-height` goes; the thread takes the panel's spare height
   (`flex: 1 1 auto; min-height: 0; overflow-y: auto`) so a taller panel shows more turns. The size is
   remembered per person: `panelSize.ts` is a pure module — `readPanelSize(key)`, `writePanelSize(key,
   size)`, `clampPanelSize(size, viewport)` — over `localStorage`, tolerant of missing/corrupt storage
   (the same shape `commandConversation.ts` uses for the thread), keyed off the launcher's `historyKey`
   with its own prefix (null key → not persisted, size still works for the session). Pin PS-1..PS-4
   (round trip, corrupt JSON ignored, clamp both ways, null key) and CL-10..CL-11 (a pointer drag on
   the handle changes the panel's inline width/height; reopening the panel restores the remembered size).

4. **R-437 — Enter empties the box.** Today `submitText` leaves the sentence in the input on a written
   single, a shape hint ("Say it like: …") and a readout, and only F-162's answer box empties it when a
   question stands. Now Enter always empties it: the sentence goes into the store's `sentence` (the
   right bubble) in every case, and the box is empty for the next sentence. Escape on a standing
   question no longer puts the sentence back into the box — it stays readable in its bubble and the
   turn closes as today (`answered = "escape"`); the box stays empty. The `handleChange` rule ("any edit
   drops the held command", CB-nc-6) and the answer-box placeholders (F-162) are unchanged. Rewrite
   the CB-ans cases whose contract this changes (say which and why in the test file) and add CB-ent-1..3:
   Enter on a written single leaves the box empty and the sentence in a bubble; Enter on an unreadable
   sentence leaves the box empty with the hint in the board's bubble; Escape on a standing question
   leaves the box empty.

5. **The refusal that borrows the drag's words.** A capacity refusal reaches the thread as
   `refused: <name> would reach 110% (cap 100%). Someone else changed their load — try the split again.`
   (`useSchedulerToast.ts:139`, the drag's own toast, arriving through the writer's `refused:`
   outcome at CommandBar.tsx ~1199/1288). The bar has no split. Where the bar turns a writer's refusal
   into the status and the outcome, rewrite THAT message (and only that one — match on its shape, not
   on the whole text) as `<name> would be over the cap today (<peak>% of <cap>%). Nothing changed.`
   Do not touch the toast or the drag. Pin CB-ref-1. R-434: the trace's `outcome` carries the new words.

Then: `npx vitest run src/test/commandBar.test.tsx src/test/commandLauncher.test.tsx src/test/panelSize.test.ts
src/test/popoverStandard.test.ts src/test/fieldStandard.test.ts src/test/scaleAudit.test.ts src/test/dateSeam.test.ts`,
`npx tsc -b`, `npx eslint src/features/board src/test`, `npx prettier --check` on your files, then
`npx playwright test e2e/typedWalk.spec.ts e2e/roleWalk.spec.ts --workers=1` once each (they drive the
real bar through the launcher; both must still pass — the dev server on 5173 and the local stack are
running; never `db:reset`). Finally drive the real bar as Dana in a browser (the typedWalk spec shows
the sign-in), run "clear Cell 1 today" then "assign Sam Patel to Cell 1 from 8 to 12" (answer any
question), resize the panel taller, click the board beside it, and screenshot the open panel with the
thread to `test-results/s63-chat-panel.png`. Clean every row you wrote; leave Plant A's 17 Sept as
you found it. Report: the pins added and every existing case changed with its reason, the runners'
totals verbatim, the screenshot path, and anything the brief got wrong.
