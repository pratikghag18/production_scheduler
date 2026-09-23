# S71-j — the input holds only what the person typed or said; progress shows beside the mic (R-454)

The maintainer, 23 Sept: "Why is it writing the listening and transcribing in the chat box? That
doesn't seem to be the correct place and is highly unprofessional that it is a text, there is also
a listening indicator right by the microphone." Requirement **R-454** (written in the plan by the
main session): the bar's input never shows a word the person did not type or say; a recogniser's
progress ("Listening…", "Transcribing…") is shown beside the microphone, and an interim transcript,
if the engine gives one, is shown as the input's placeholder, never as its value.

## 0. How it is today

- `src/lib/voice/recognizer.ts` `RecognizerEvents.onInterim(text)` carries BOTH partial transcripts
  (the browser engine's, `recognizer.ts` ~151-153) and the local recogniser's status words:
  `localRecognizer.ts` ~694 `events.onInterim("Listening…")` and ~541/~555 `events.onInterim("Transcribing…")`.
- `CommandBar.tsx` ~3414 `onInterim` does `setText(interimText)` — into the input's value — and
  F-206's `lastInterimTextRef` (S71-i) exists only to clean that up on stop. The mic button has a
  `listeningLabel` span "Listening…" shown while `listening` (~3720).

## 1. The change

1. `recognizer.ts`: add `onStatus?(phase: "listening" | "transcribing"): void` to `RecognizerEvents`
   (optional). `localRecognizer.ts` calls `onStatus("listening")` where it now says
   `onInterim("Listening…")` and `onStatus("transcribing")` where it says `onInterim("Transcribing…")`,
   and never sends a status word through `onInterim` again. `withFallback` forwards `onStatus` on
   both legs (the shape guard LREC-31c will fail tsc until you do — that is the point).
2. `CommandBar.tsx`: `onInterim(text)` sets a `interimHint` state used as the input's PLACEHOLDER
   (when non-empty it wins over `answerTakes(status) ?? PLACEHOLDER`), never `setText`. `onStatus`
   sets a `micPhase` state; the label beside the mic reads "Listening…" or "Transcribing…" from it
   and clears on `onEnd`/`endSession`. Remove `lastInterimTextRef` and its three sites (F-206's
   fix becomes unnecessary because nothing writes into the value any more) — but keep CB-mic-13/14/15
   green by rewriting them to the new contract (the input value is "" or the typed text throughout;
   the placeholder carries the interim; the label carries the phase). Keep F-197's rule that an
   interim while an answer box stands does not clear `heldRef` — re-read that comment and keep the
   behaviour.
3. The trace and thread are untouched: nothing here is a turn.

## 2. Pins
- `localRecognizer.test.ts` LREC-32a: `onStatus("listening")` fires on start, `onStatus("transcribing")`
  when the clip is posted, and `onInterim` is never called with a status word; LREC-32b: `withFallback`
  forwards `onStatus` (extend the shape guard's object).
- `commandBar.test.tsx` CB-mic-16: while listening the input value stays "" and the mic label reads
  "Listening…"; CB-mic-17: a partial transcript arrives → the input value is still "" and its
  placeholder is the partial; CB-mic-18: phase "transcribing" → label "Transcribing…"; CB-mic-19:
  the person had typed "clear" and pressed the mic → the typed text is untouched by interim and
  status; CB-mic-13/14/15 rewritten as above.
- `commandLauncher.test.tsx` unchanged, but run it.

`npx vitest run src/test/localRecognizer.test.ts src/test/commandBar.test.tsx src/test/commandLauncher.test.tsx
src/test/voiceRecognizer.test.ts`; prettier, eslint, `npx tsc -b`.

## 3. Files you own / must not touch
Own: `src/lib/voice/recognizer.ts`, `src/lib/voice/localRecognizer.ts` (the three call sites and
`withFallback` only), `src/features/board/components/CommandBar.tsx`, `CommandBar.module.css` (if the
label needs a rule), `src/test/localRecognizer.test.ts`, `src/test/commandBar.test.tsx`,
`src/test/voiceRecognizer.test.ts`. Do not touch `clipServer.ts`, `trace.ts`, `scripts/` (another lane),
`docs/plan.yaml`. No full `npm run test`, no commit, no dev-server restart.

## 4. Report
Under 20 lines: the event, the two states, what the placeholder and the label read in each phase,
the pin ids, totals.
