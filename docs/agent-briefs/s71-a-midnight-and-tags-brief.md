# S71-a — a block ending at midnight is removable (F-199) and a Whisper non-speech tag is never a sentence (F-201)

Serves `docs/plan.yaml` findings **F-199** and **F-201** (both `status: open`, filed 23 Sept from
the second spoken walk), standards **R-431** (nothing offered that the server refuses), **R-435**
(when in doubt, ask) and **R-434** (every bar feature traces). Read the two finding cards first
(`grep -n "id: F-199" -A 16 docs/plan.yaml`, same for F-201).

## 0. What happened, in one paragraph each

**F-199.** Sam Patel had a block on Cell 1 from 14:00 to 00:00 (midnight, i.e. the START of the
next calendar day). "Clear, Area 1" resolved the clear as an unassign of every block on the day and
answered "1 of 7: That is -840 minutes; a block is at least 15 minutes", four times, removing
nothing. The removal read the block's end as minute 0 of the SAME day, 14 hours before its start.
The maintainer could not empty the board by any sentence and stopped the walk.

**F-201.** Between two sentences Whisper returned the text `[Music]`. The recogniser handed it to the
bar as a heard sentence, the model read it as "unassign everyone on today", and the lot ran as far as
"6 of 6: That is -840 minutes" before F-199 stopped it. On a day without F-199 a cough would have
cleared the board. whisper.cpp writes such tags in square brackets or parentheses: `[Music]`,
`[BLANK_AUDIO]`, `(clippers buzzing)`, `[inaudible]`, `(applause)`.

## 1. What is already done and must not be redone

- The resolver already knows the midnight shape. `src/lib/command/resolve.ts` ~4405-4425 (the
  `DAY_END` note on `expandCopy`) and ~4830-4845 (`copyableSpan`, the F-152 follow-up) explain it:
  `ctx.wallOf` returns `minuteOfDay` 0..1439 by contract, so a block ending exactly at midnight comes
  back as `{hour: 0, minute: 0}` of the NEXT day; anything that reads that as "00:00 of this day"
  gets a negative span. `expandCopy` and the split path already use `DAY_END` (minute 1440) for it.
  **Reuse that rule; do not invent a second one.** Find every place a removal/unassign/clear turns a
  block's end into a minute-of-day and feed the same DAY_END rule through it. The `too_short` sites
  are at ~1628, ~1736, ~1994, ~2839 (`grep -n '"too_short"' src/lib/command/resolve.ts`); read the
  callers upstream of each to find which one the clear path hits (`expandEveryoneUnassign` and the
  unassign resolvers are the suspects — search `runRemovals`, `ResolvedUnassign`).
- The recogniser (`src/lib/voice/localRecognizer.ts` ~465-485) already treats an empty transcript as
  `no-speech` and `[BLANK_AUDIO]` is mentioned in its comment at ~260 but NOT filtered. F-198's onset
  and windowed-send rules (LREC-19..28) are done and must stay green.

## 2. The walk, step by step

### F-199 (resolver)
1. Write the failing pin FIRST in `src/test/commandResolve.test.ts`: a context with one assignment on
   Cell 1 from 14:00 to 00:00 next day (build it the way neighbouring cases build blocks — copy a
   fixture, set the end instant to the next day's midnight in the fixture's zone); resolve
   `unassign everyone on Cell 1 today` and `clear Cell 1 today` (whichever phrasing the existing
   cases use for the clear — grep `clear ` in that file); assert NO `too_short` question, and that
   the removal covers the block (its readout names 14:00 to 00:00 or the day's end the way the
   existing readouts spell it). Also pin the single-person form: `remove Sam Patel from Cell 1
   today` with the same block. Name them `RS-midnight-1` .. as the file's own numbering goes.
2. Run them red, confirm the message is the `-840` one.
3. Fix in `resolve.ts` with the DAY_END rule already used by copy/split. Keep the change in the
   removal path(s); do not touch the copy or split code.
4. Run `npx vitest run src/test/commandResolve.test.ts src/test/commandBar.test.tsx
   src/test/commandParse.test.ts` — all green. If a green case goes red, READ it before changing
   anything and write in your report whether it pinned the bug or the contract changed (CLAUDE.md §4).

### F-201 (recogniser)
5. In `src/lib/voice/localRecognizer.ts`, where the JSON `text` is read (~468): strip every
   bracketed or parenthesised tag — `[...]` and `(...)` — from the transcript, collapse whitespace,
   trim. If nothing remains, report `events.onError("no-speech")` exactly as the empty case does. If
   words remain (e.g. `[Music] clear Cell 3`), send the words only. Put the stripping in a small
   exported pure function (`stripNonSpeechTags(text)`) in the same file so the test can hit it
   directly, and add a comment naming F-201 and the whisper.cpp tag shapes above.
6. Pins in `src/test/localRecognizer.test.ts`, continuing the numbering at **LREC-29**: (a) `[Music]`
   alone → `no-speech`, `onFinal` never called; (b) `[BLANK_AUDIO]` alone → the same; (c)
   `(clippers buzzing)` alone → the same; (d) `[Music] clear Cell 3 today` → `onFinal("clear Cell 3
   today")`; (e) a plain sentence with no tag is unchanged; (f) a sentence with real brackets a person
   could not say is not a concern — do not try to preserve any. Use the file's existing fake-fetch
   harness (see LREC-24..28 for how a payload is fed).
7. Run `npx vitest run src/test/localRecognizer.test.ts src/test/voiceRecognizer.test.ts` — green.
8. `npx prettier --check` and `npx eslint` on every file you changed; `npx tsc --noEmit -p .` — read
   only errors in files you own.

## 3. Files you own / must not touch

Own: `src/lib/command/resolve.ts`, `src/test/commandResolve.test.ts`,
`src/lib/voice/localRecognizer.ts`, `src/test/localRecognizer.test.ts`.

Do NOT touch: `src/features/board/components/CommandBar.tsx`, `CommandLauncher.tsx`,
`src/test/commandBar.test.tsx`, `src/test/commandLauncher.test.tsx` (another lane is adding a
microphone keyboard shortcut there right now), `src/lib/voice/recognizerHint.ts`, anything under
`scripts/`, `supabase/`, `docs/plan.yaml`. Do not run the full `npm run test`. Do not commit.

## 4. Report shape

Under 40 lines: the exact `resolve.ts` function(s) changed and the DAY_END rule reused; the pin ids
added and that each failed before the fix (quote the `-840` message from the red run); the LREC ids
added; the vitest totals for the files you ran; prettier/eslint/tsc status on your files; anything
you saw and did not fix (one line each).
