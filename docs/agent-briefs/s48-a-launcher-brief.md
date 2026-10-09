# Brief S48-a: the corner launcher — the bar behind a button in the lower right

Stage S48, requirement R-396 (read it in `docs/plan.yaml`; its claim is the contract), design
§19.95 (D124). No other lane is running. The command bar, the reader, the recogniser and the
outline are all committed and must not change in behaviour.

## 1. What exists (read first)

- `src/features/board/components/CommandBar.tsx`: the bar, with props `ctx`, `dateFormat`,
  `zone`, the six `on*` callbacks, `reader`, `recognizer`, `onHighlight`, `onConfirmWord`,
  `onCancelWord`. Its Escape rules: while listening, stop; else if a status stands, clear it;
  else clear the input. Its microphone button currently renders the 🎤 emoji with
  `aria-label="Speak a sentence"` and a `Listening…` label while listening. On unmount it
  aborts a reading, stops listening and reports `onHighlight(null)`.
- `src/features/board/BoardPage.tsx` renders `{canPlace && commandCtx !== null && (<CommandBar .../>)}`
  near line 788, above the board grid. Read the surrounding JSX and the `HighlightProvider`.
- `src/components/icons.tsx`: the app's only icon file (a `Chevron`); add here.
- `src/components/Popover.module.css` uses `position: fixed` for pop-ups; read how it layers
  (`z-index`) so the panel sits above the board but below pop-ups the bar opens.
- The mock the maintainer approved: `C:\Users\prati\.claude\jobs\0586b6d2\tmp\launcher-mock.html`
  (open it in a browser). Match it: a 48px round launcher, `--ink` on `--surface`, 18px from
  the right and bottom edges, a speech-bubble glyph; the open state swaps the glyph for a
  close cross and the button turns `--surface` with a `--grid` border; the panel is 372px wide
  (max 100% minus 36px), anchored 76px from the bottom and 18px from the right, `--surface`,
  1px `--grid` border, 8px radius, a soft shadow; a small header row "TELL THE BOARD" in the
  muted small-caps style and "Esc closes" on the right; then the bar. Use the app's tokens
  only; no new colours. A `press /` hint in `--muted` may sit left of the closed button.
- Tests: `src/test/commandBar.test.tsx` (`renderBar`), the role walk `e2e/roleWalk.spec.ts`
  (line ~288 asserts the bar's textbox by name "Tell the board"), and the gated
  `e2e/voiceBar.spec.ts` (types into `#command-bar-input`). Both must open the panel first.
- The tester's role walk runs in CI without a service and without VOICE_E2E; keep it green.

## 2. What to build

1. `src/components/icons.tsx`: `SpeechBubble` and `Microphone` (props: `size`, `filled?` for
   the microphone's listening state), inline SVG, `currentColor`, `aria-hidden`. Draw them as
   in the mock (a rounded bubble with two lines; a capsule mic with the arc stand).
2. `src/features/board/components/CommandLauncher.tsx` + `CommandLauncher.module.css`:
   - Props: everything `CommandBar` takes (pass through) plus nothing else; the launcher owns
     `open` state.
   - Renders the fixed launcher button (`aria-label="Tell the board"`, `aria-expanded`,
     `aria-controls` the panel id) and, when open, the panel (`role="dialog"`,
     `aria-label="Tell the board"`) containing the header row and `<CommandBar .../>`.
   - Open: click the button, or the slash key pressed anywhere when no input, textarea or
     contenteditable has focus (a `keydown` listener on `document`, removed on unmount). On
     open, focus the bar's input (the bar already has `inputRef`; expose a focus method via a
     small `ref` prop on the bar, or focus `#command-bar-input` after mount; prefer the latter
     if it keeps the bar untouched).
   - Close: the button (now a close cross), a mousedown outside the panel and button, or
     Escape when the bar has nothing left to clear. To know that without changing the bar's
     rules, add ONE optional prop to the bar, `onEscapeIdle?: () => void`, called from the
     bar's Escape handler only when it found nothing to do (not listening, no status, empty
     input). That is the only change to `CommandBar.tsx` besides the icon.
   - The panel must not close on its own; closing unmounts the bar (which clears the
     highlight, aborts a reading, stops listening --- it already does all three on unmount).
   - Pop-ups the bar opens (`CreatePopover` and friends) render from `BoardPage`, outside the
     panel; make sure a mousedown inside such a pop-up does not count as "outside" and close
     the panel (check the target against the panel AND `[role="dialog"]` ancestors, or leave
     the panel open while `BoardPage` has a pop-up: pick the simpler that works and say which).
3. `CommandBar.tsx`: replace the emoji with `<Microphone filled={listening} />`; keep the
   `Listening…` label and aria state; add `onEscapeIdle`. Nothing else.
4. `BoardPage.tsx`: render `<CommandLauncher ...>` with the same props and the same
   `canPlace && commandCtx !== null` guard, in place of `<CommandBar>`. Remove the bar's old
   top-of-board placement (the launcher is fixed, so it can render anywhere in the page tree;
   put it where the bar was).
5. `e2e/roleWalk.spec.ts`: where it asserts the bar's textbox, first click the launcher button
   (`getByRole("button", { name: "Tell the board" })`) if present; a viewer has no launcher and
   the assertion for them stays "absent". Keep the walk's other assertions untouched.
   `e2e/voiceBar.spec.ts`: click the launcher before typing, in each case.
6. Tests, new `src/test/commandLauncher.test.tsx`, cases CL-1..CL-7: no button when not
   rendered (the guard is BoardPage's; test the launcher renders a button and no panel at
   rest); pressing opens the panel with the bar's input focused; slash opens (and slash inside
   a focused input does not); Escape with a status standing clears the status and keeps the
   panel, Escape again with empty input closes; mousedown outside closes; closing while a
   question stands calls `onHighlight(null)`; the button shows `aria-expanded` true/false.
   Run `npx vitest run src/test/commandLauncher.test.tsx src/test/commandBar.test.tsx
   src/test/commandPurity.test.ts`, `npx tsc --noEmit -p .`, eslint and prettier on your
   files, then `npx playwright test e2e/roleWalk.spec.ts --workers=1`.

## 3. Rules

- Files you own: `src/components/icons.tsx`, `src/features/board/components/CommandLauncher.tsx`
  and its CSS module, `CommandBar.tsx` (the two changes named) and its CSS module if the icon
  needs a size rule, `BoardPage.tsx` (the placement), `e2e/roleWalk.spec.ts` (the one
  assertion), `e2e/voiceBar.spec.ts`, `src/test/commandLauncher.test.tsx`. Not
  `src/lib/command/*`, not `src/lib/voice/*`, not `docs/plan.yaml`.
- The bar stays free of the commandPurity U2 needles; so does the launcher. No new
  dependencies. Do not run the full `npm run test`. Do not commit.
- Report: the files with a line each, which "outside" rule you chose for pop-ups, each test
  title, the vitest/tsc/lint/roleWalk summaries, `git diff --stat`.
