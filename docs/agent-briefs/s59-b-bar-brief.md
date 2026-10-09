# S59-b — the decoder refuses punctuation names, the floor's confirm words, Show that day (F-149, F-150, R-419, R-418's message)

You own `src/lib/voice/decode.ts`, `src/test/voiceRead.test.ts`,
`src/features/board/components/CommandBar.tsx`, `src/features/board/BoardPage.tsx`,
`src/test/commandBar.test.tsx`, and `src/features/board/store/boardView.ts` only if the window
move needs a helper there (with `src/test/boardView.test.ts` or wherever that store is pinned).
Read `docs/design-plan.md` §19.104 (D133), the F-149 and F-150 cards in `docs/plan.yaml`, and the
bar's `submitText`/`normalizeWord`/`UNIVERSAL_CONFIRM_WORDS`/`questionToStatus`/`pickCandidate`.
Lane A (resolver) is concurrently adding `suggestions?: Candidate[]` to the `unknown` question;
until it lands, type against `Candidate` and guard on `question.suggestions` being present.

1. **F-149, `decode.ts`**: every name string the decoder reads (operator, product, with, other,
   every element of place and toPlace, a non-null shift) must contain at least one letter or
   digit (any script: `/\p{L}|\p{N}/u`), else the whole answer is garbled — so the bar's rules
   fallback runs. Pin with both probes from the card: the assign with place `["],", "product"]`
   and the headcount with place `["],"]` are garbled; a place `["Cell 1"]` and a shift `"2"` are
   not; a person named `"A-3"` is fine.
2. **F-150, the bar**: `UNIVERSAL_CONFIRM_WORDS` gains yeah, yep, yup, sure, okay, go ahead, go
   on, correct, right, yes yes; `CANCEL_WORDS` gains nope, nah, never mind, forget it. `normalizeWord`
   (or whatever compares) lower-cases, trims, and strips every punctuation character, not only a
   trailing one, so "Yes." / "yeah," / "Okay!" match. Pin: each new word confirms a one-block
   question and a lot; "Yes." from the reader stub runs the lot; "right" as the FIRST word of a
   sentence ("right, put Sam on…") is not a confirm (only the whole transcript, normalised, equal
   to a confirm word is).
3. **R-419, Show that day**: `questionToStatus` for `day_off_board` gains one candidate button
   labelled "Show that day" whose onClick moves the window so that day is on it, then re-runs
   `runCommand` with the SAME command. BoardPage supplies `onShowDay(target)`; the target is what
   the question names (`text`: "yesterday", "tomorrow", a weekday name, an ISO date, or a week
   word from D130's copy — read every place `day_off_board` is built in resolve.ts and make the
   button work for each: for a weekday or a date compute the ISO from the board's days and the
   plant zone; for "yesterday" move the start one day back keeping the count; for a week word set
   the start to that week's Monday and the count to at least 7). Use the store's own
   `setWindowStartDate`/`setWindowDayCount`/`shiftWindowByDays`. Because the window query is
   asynchronous, re-run the sentence when the new window's `ctx` arrives (an effect keyed on a
   "pending rerun" ref, cleared on cancel/typing/Escape), never against the old ctx. Pin: the
   button appears only on `day_off_board`; clicking it calls `onShowDay` with the right target for
   yesterday, Friday and 2026-09-25; the rerun happens once the ctx changes and not before; a
   cancel word or Escape drops the pending rerun.
4. **R-418's message**: when an `unknown` question carries `suggestions`, the status message is
   `No <part|person|place> called "<text>" on this board. Did you mean one of these?` with the
   suggestions as candidate buttons (the same rendering as `ambiguous`); a pick substitutes the
   name and re-runs, as `ambiguous` does. Pin one case per field with a hand-built question.
Run `npx vitest run src/test/voiceRead.test.ts src/test/commandBar.test.tsx`, `npx tsc --noEmit -p
tsconfig.json`, `npx eslint src/features/board src/lib/voice`. No commits, no plan edits. Report the
words added, how the rerun waits for the new ctx, case counts, and anything lane A must match.
