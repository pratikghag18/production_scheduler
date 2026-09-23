# S71-d — a keyboard shortcut starts the microphone (R-451)

Serves requirement **R-451** (the maintainer, 23 Sept: "I also want a shortcut to start the mic
icon like we have '/' to enter the chatbot"). Standards touched: **R-434** (every bar feature
traces — the mic path already traces its listening; the shortcut reuses it, adds no new path),
**R-447** (no new button; the existing mic button's title gains the key).

## 0. The decision already made

The key is **Ctrl+M** ("M for microphone"). Unlike "/", it must also work while the bar's own
input has focus, because the normal flow is: press "/" (the panel opens, the input is focused),
then press the shortcut to speak. A plain letter would be typed into the input, so a modifier is
required. Ctrl+M is unbound in Chrome and Edge, the browsers the app is used in.

Behaviour, exactly:
1. Panel closed, Ctrl+M → the panel opens AND the bar starts listening (the same as clicking the
   mic button), provided a recogniser is configured. If no recogniser (`recognizer` prop null) the
   panel just opens.
2. Panel open, not listening, Ctrl+M (input focused or not) → starts listening.
3. Panel open, listening, Ctrl+M → stops listening (the mic button's own toggle).
4. `preventDefault()` on the handled keydown. Ctrl+M with Shift or Alt also held is NOT the
   shortcut (leave it to the browser). Match `e.key === "m" || e.key === "M"` with `e.ctrlKey` true
   and `e.altKey`/`e.shiftKey`/`e.metaKey` false.
5. The mic button's `title` and `aria-label` stay as they are except the title gains " (Ctrl+M)" at
   the end, so the key is discoverable on hover.

## 1. How the code is shaped today (read before editing)

- `src/features/board/components/CommandLauncher.tsx` ~233-245: the "/" listener on `document`
  (`useEffect` keyed on `open`), guarded by `isEditableTarget(document.activeElement)`. It sets
  `open`; a second effect focuses `BAR_INPUT_ID`. The bar is rendered at ~423 as
  `<CommandBar {...props} onEscapeIdle={close} conversation={conversation} />`.
- `src/features/board/components/CommandBar.tsx`: `handleMicClick()` ~3406 toggles
  `startListening(recognizer)` / `stopListening()`; the mic button ~3712 (`aria-label="Speak a
  sentence"`, `onClick={handleMicClick}`), rendered only when `recognizer` is non-null.
  `CommandBarProps` starts ~335.

## 2. The walk

1. **One listener, in the launcher.** Extend the existing document keydown effect in
   `CommandLauncher.tsx` (or add a sibling effect) to handle Ctrl+M as in §0. The launcher does not
   own the recogniser, so it tells the bar through a prop: add `micRequest?: number` to
   `CommandBarProps` (default 0). The launcher keeps `const [micRequest, setMicRequest] =
   useState(0)`; on Ctrl+M it does `setOpen(true)` (no-op when open) and `setMicRequest(n => n + 1)`.
2. **The bar acts on the counter.** In `CommandBar.tsx`, a `useEffect` on `micRequest`: if
   `micRequest > 0`, call `handleMicClick()`. Because the bar mounts fresh when the panel opens
   (it is inside `{open && ...}`), the effect fires on mount with the incremented value — case 1
   in §0 — and on each later increment — cases 2 and 3. Guard against the mount-with-0 case. If
   `handleMicClick` closes over state the effect would see stale, use the same pattern the file
   already uses for late values (`store.getState()` / refs) — read how `submitText` reads
   `status` (search "CB-stale-1").
3. **Title.** Mic button `title` gains " (Ctrl+M)".
4. **Pins**, in `src/test/commandLauncher.test.tsx` continuing its `CL-` numbering (read CL-3 and
   the `renderLauncher(over, recognizer)` helper at ~127; a fake `Recognizer` is `() => ({ stop })`
   — see ~269 for one that records `start`):
   - CL-a: panel closed, `fireEvent.keyDown(document, { key: "m", ctrlKey: true })` → the dialog
     "Tell the board" is open and the fake recogniser was started once (the mic button reads
     `aria-pressed="true"`).
   - CL-b: same with the bar's input focused (open the panel first, focus the textbox "Tell the
     board", press Ctrl+M) → listening starts; the input's value is still "" (nothing typed).
   - CL-c: while listening, Ctrl+M → `stop` called, `aria-pressed="false"`.
   - CL-d: Ctrl+Shift+M and plain "m" do nothing (panel stays closed; recogniser not started).
   - CL-e: with `recognizer={null}`, Ctrl+M opens the panel and nothing throws.
   If the bar's own mic behaviour needs a pin in `src/test/commandBar.test.tsx` (e.g. the counter
   effect), add it there under a new `CB-mic-` id; keep it to the counter prop, nothing else.
5. Run `npx vitest run src/test/commandLauncher.test.tsx src/test/commandBar.test.tsx` — green.
   `npx prettier --check`, `npx eslint` on changed files, `npx tsc --noEmit -p .` (errors only in
   files you own count).

## 3. Files you own / must not touch

Own: `src/features/board/components/CommandLauncher.tsx`, `CommandBar.tsx`,
`src/test/commandLauncher.test.tsx`, `src/test/commandBar.test.tsx`.

Do NOT touch: `src/lib/command/resolve.ts`, `src/lib/voice/*` (another lane is fixing F-199 and
F-201 there now), `src/lib/command/parse.ts`, anything under `scripts/`, `supabase/`,
`docs/plan.yaml`. Do not run the full `npm run test`. Do not commit.

## 4. Report shape

Under 30 lines: the prop's name and where the effect lives; the CL ids added and that each ran;
the vitest totals for the two files; prettier/eslint/tsc status; anything left.
