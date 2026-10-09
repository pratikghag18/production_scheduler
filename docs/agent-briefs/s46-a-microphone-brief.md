# Brief S46-a: the microphone — the browser's recogniser types the sentence (Stage 6)

Stage S46, requirement R-394, design §19.94 (D123). Another lane (S45) is editing
`src/lib/voice/readSentence.ts`, `src/test/voiceRead.test.ts` and `scripts/voice/serve/*` at
the same time; you never touch those.

## 1. What exists (read first)

- `src/features/board/components/CommandBar.tsx`: the bar. Props include `reader?: Reader | null`
  (S44). Enter goes through `handleKeyDown` → `startReading(text, reader)` when a reader is set
  and the text is not blank, else `parseCommand` + `runCommand`. `status` is a union rendered
  in the `aria-live="polite"` line; `{kind:"reading"}` renders "Reading…". `heldRef` and the
  candidate buttons re-read canonical sentences through the rules. Any edit aborts a reading.
- `src/test/commandBar.test.tsx`: `renderBar(ctx, reader?)` and the CB-model cases show how
  the bar is rendered and how Enter, the status line and the callbacks are asserted. Add a new
  `describe("CB-mic: ...")`; do not restructure the file.
- `src/test/commandPurity.test.ts` U2: `CommandBar.tsx` must not contain `createAssignment`,
  `useCreateAssignment`, `supabase`, `@/lib/api/mutations`. Stays green.
- `e2e/roleWalk.spec.ts` walks every demo person through the board; it must pass unchanged.
  Playwright's Chromium defines `webkitSpeechRecognition`, so the button WILL render there;
  make sure the walk's assertions do not break because of one more button in the bar (run it).
- The maintainer's standing preference: fold a capability into the existing control; no
  parallel widget.

## 2. What to build

1. `src/lib/voice/recognizer.ts` — a thin wrapper over the Web Speech API so the bar and the
   tests share one shape:

   ```ts
   export interface RecognizerEvents {
     onInterim(text: string): void;   // what has been heard so far, may be revised
     onFinal(text: string): void;     // the sentence is final; listening ends after this
     onError(kind: "not-allowed" | "no-speech" | "other", detail?: string): void;
     onEnd(): void;                   // the recogniser stopped, for any reason
   }
   export interface RecognizerHandle { stop(): void }
   export type Recognizer = (events: RecognizerEvents) => RecognizerHandle;
   export function browserRecognizer(): Recognizer | null; // null when window has no SpeechRecognition/webkitSpeechRecognition
   ```

   `browserRecognizer()` returns a function that creates one recognition session:
   `continuous: false`, `interimResults: true`, `lang` from `document.documentElement.lang`
   or `navigator.language`, `maxAlternatives: 1`; maps `result` events to `onInterim` (joined
   transcript so far) and, when `isFinal`, to `onFinal`; maps `error` events: `not-allowed`
   and `service-not-allowed` → `not-allowed`, `no-speech` → `no-speech`, everything else →
   `other` with the error name; `end` → `onEnd`. `stop()` calls `abort()` if available, else
   `stop()`. Never throws: wrap `start()` in try/catch and route a throw to `onError("other")`.
   Type the API minimally yourself (`interface SpeechRecognitionLike { ... }`); do not add a
   dependency or a global `lib` entry.
2. `CommandBar.tsx` — a new optional prop `recognizer?: Recognizer | null` (default `null`).
   - `null`: no button rendered; behaviour and markup otherwise byte for byte as today.
   - set: a `<button type="button">` inside the bar's row, after the input, with
     `aria-label="Speak a sentence"`, `title="Uses the browser's speech recogniser; audio is sent
     to the browser maker's service"`, showing a microphone glyph (a Unicode character or an
     inline SVG; no icon library) and, while listening, the text `Listening…` beside it and
     `aria-pressed="true"`.
   - Press when idle: abort any in-flight reading (the S44 path), clear the status, start a
     session, set `listening` state. `onInterim` sets the input text to the interim transcript
     (and clears `heldRef`, as an edit does). `onFinal` sets the text and then submits exactly
     as Enter does (call the same function `handleKeyDown` uses for Enter; extract it into
     `submitText(text)` if it is inline, without changing the Enter path's behaviour). `onEnd`
     sets `listening` false. `onError`: `not-allowed` → status message `The microphone was
     refused. Allow it in the browser's address bar and try again.`; `no-speech` → `Nothing
     was heard.`; `other` → `The recogniser stopped: <detail>.`; all three end listening and
     keep whatever text was in the input.
   - Press while listening, or Escape while listening: `stop()`, listening false, text kept,
     status untouched (then Escape's existing rules do not run for that press).
   - Unmount while listening: `stop()` (a `useEffect` cleanup).
   - Keep the bar free of the U2 needles. CSS in `CommandBar.module.css`: the button, the
     listening state; reuse the bar's existing tokens and sizes; no new colours.
3. `src/features/board/BoardPage.tsx` — pass `recognizer={BOARD_RECOGNIZER}` where
   `BOARD_RECOGNIZER = browserRecognizer()`, computed once at module level beside the
   `COMMAND_BAR_READER` constant S44 added.
4. Tests, `src/test/commandBar.test.tsx`, `describe("CB-mic: ...")` with a fake recogniser
   (a function that records the events object and returns a handle with a `stop` spy):
   - CB-mic-1: with `recognizer={null}` there is no button with the label; with a fake, there is.
   - CB-mic-2: pressing starts a session (the fake was called), the button shows Listening…
     and `aria-pressed="true"`; an in-flight reading (a never-resolving fake reader) is aborted.
   - CB-mic-3: `onInterim("put ana")` puts `put ana` in the input.
   - CB-mic-4: `onFinal(<a canonical assign sentence>)` submits: with no reader, `onOpen` is
     called with the same command the typed sentence plus Enter yields; with a fake reader,
     the reader is called with that text.
   - CB-mic-5: pressing again while listening calls `stop()`, the text stays, the button is idle.
   - CB-mic-6: Escape while listening calls `stop()` and keeps text and status.
   - CB-mic-7: `onError("not-allowed")`, `onError("no-speech")`, `onError("other", "network")`
     each set the status line to the sentence above and end listening.
   - Run `npx vitest run src/test/commandBar.test.tsx src/test/commandPurity.test.ts`, then
     `npx tsc --noEmit -p .`, eslint and prettier on your files, then
     `npx playwright test e2e/roleWalk.spec.ts` (the app and the database are running; the
     config starts its own dev server on its own port). Paste the summaries.

## 3. Rules

- Files you own: `src/lib/voice/recognizer.ts`, `src/features/board/components/CommandBar.tsx`
  and `CommandBar.module.css`, `src/features/board/BoardPage.tsx`, `src/test/commandBar.test.tsx`.
  Nothing else; not `readSentence.ts`, not `voiceRead.test.ts`, not `docs/plan.yaml`.
- No new dependencies. Do not run the full `npm run test`. Do not commit.
- Report: the wrapper's exports, the bar's changed paths in prose, each test's title, the
  vitest/tsc/lint/roleWalk summaries, `git diff --stat`.
