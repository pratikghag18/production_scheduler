# S72-b — the bar after the third spoken round: the last turn stays while listening (R-458), a line offered as a button (R-457), the board goes to the day itself (R-455, F-219), and the verb question (R-456)

The maintainer, 24 Sept (session 191), after speaking the second list on small.en. Four decisions, each a
`requirements` row in `docs/plan.yaml` — read R-455, R-456, R-457, R-458 and findings F-219, F-220,
F-221, F-222 before anything. The trace is `data/voice/trace/bar.jsonl` from `2026-09-24T19:25` on.

## 0. Read first
- `src/features/board/components/CommandBar.tsx`: `startListening` (~3566, the `setStatus((prev) =>
  answerTakes(prev) ...)` line and F-197's comment above it), `questionToStatus` (~2600–2700: the
  `day_off_board` and `unknown` branches, and note there is NO `place_mismatch` branch), the rerun effect
  (~1372–1400, `pendingRerunRef`, `isTargetOnBoard`), `fallbackToRules` (~2093), `applyReading` (~2190,
  the grounding site), `askUngrounded`/`refuseUngrounded` (~2160–2185), `runCandidateAction` (~2940–
  3000: `show_day`, `run_ungrounded`, `pick_candidate`).
- `src/features/board/store/commandConversation.ts`: the `CandidateAction` union (~118–132), the history
  turns (R-427).
- `src/features/board/BoardPage.tsx`: `commandCtx` memo (~661), `index` memo (~428, built from
  `boardQuery.data` — which is `placeholderData: keepPreviousData`'s OLD window during a move, see
  `src/features/board/hooks/useBoardWindow.ts`'s header), `handleShowDay` (~827–900).
- `src/lib/command/resolve.ts`: the `place_mismatch` question (`{ kind, cell, qualifier, elsewhere:
  Candidate[] }`, ~437 and ~1492–1506) and `ResolveContext` (~120–160).
- `src/lib/command/verbGuess.ts`: a PRE-SEATED STUB — `guessVerbs(heard, verbs): VerbGuess[]` and
  (once lane S72-a lands) `describeVerbGuess`. Code against the stub's signature; S72-a fills it in at the
  same time. `guessVerbs` returns `[]` until then, so your R-456 branch is a no-op you can still pin by
  mocking the module (`vi.mock("@/lib/command/verbGuess")`) in your tests.
- `src/test/commandBar.test.tsx` (CB-showday-1..6, CB-ground-1..6, CB-mic-2/3/11–19) for the style and
  the harness; `src/test/commandBarGate.test.ts`.

## 1. R-458 / F-221 — the last turn stays (CommandBar.tsx)
Delete the status-clearing at the top of `startListening` (the `setStatus((prev) => ...)` line): a mic
press leaves `status` untouched, whatever it is. Check `handleMicClick`, the Ctrl+M path
(`micRequest`), and `endSession` for any other clear of `status` on a mic START (a stop must not clear
either). Pins: CB-mic-20..: a readout standing, press the mic → the readout is still rendered while
"Listening…" shows beside the button; same for a refusal ("Did not run: …") and a one-button question;
the next answer replaces it. Rewrite the CB-mic case that pinned the old clearing if one does (read it
first, say in the report whether it pinned the bug).

## 2. R-457 / F-220 — place_mismatch offers the parent (CommandBar.tsx)
In `questionToStatus`, add a `place_mismatch` branch: message = `describeQuestion` (unchanged wording)
+ the `elsewhere` candidates as buttons, label = each candidate's `label` (the parent's own name as the
resolver built it — check `elsewhereParents` in resolve.ts for whether `label` is the bare name or a
path; if a path, show the NAME and keep the path in the key). A press substitutes the qualifier:
`command.place` = `[command.place[0], <parent name>]` for the question's `qualifier` index (the place
list beyond index 0 — find the qualifier's own index by matching `q.qualifier` against `command.place`,
never assume index 1), then `runCommand` on the new command — a `pick_candidate` with `field: "place"`
if `pickCandidate` already does exactly this (read it; it substitutes `place[0]` today, so you will
probably need a new `CandidateAction` kind, `pick_place_parent`, in `commandConversation.ts`). Trace: the
press is `answered: <label>` as any other pick. Pins CB-pm-1..: the trace sentence "Assign John Kim to
Common Fastener on Cell 5, Online 3, from 8 am to 12 pm, today" (or the typed equivalent that produces
`place_mismatch` in the harness) shows a "Line 3" button; pressing it writes; the readout and trace
carry the pick; a `place_mismatch` with empty `elsewhere` shows no button (unchanged).

## 3. R-455 / F-219 — the board goes to the day itself, after the data lands
(a) **The move without the press.** Where `questionToStatus` today builds the `day_off_board` question
with a "Show that day" button, instead: push one turn into the thread — a readout-shaped status, text
`Moved the board to <day label>.` (the same `renderReadout` day formatting the readouts use, R-426) —
and dispatch the `show_day` action immediately (the same `onShowDay` + `pendingRerunRef` path the
button used, so every guard R-419 built — cancel, Escape, new typing dropping the rerun; the rerun gated
on a window that holds the day — stays exactly as it is). Keep the `show_day` action kind; only the
press is gone. The trace: `asked` records the "Moved the board …" line and `answered: "auto"`, so a
reader of the trace sees the move.

(b) **The race.** `commandCtx` is rebuilt from `boardQuery.data` while that is still the PREVIOUS
window's rows under the NEW window's `from`/`to` (`index` memo + `keepPreviousData`), so the rerun's gate
(`isTargetOnBoard`) passes on the new day axis while `ctx.assignments` are the old window's — that is
how the bar told the maintainer "Maria Lopez has no block Thu Sep 24" when she had one. Add
`settled: boolean` to `ResolveContext` (resolve.ts — the type only; you may add the field and nothing
else there) set in `BoardPage`'s memo to `!boardQuery.isPlaceholderData` (add `boardQuery.
isPlaceholderData` to the memo's deps), and gate the rerun effect on `ctx.settled` as well as
`isTargetOnBoard`. The bar must NOT unmount or go null (R-424) — `settled: false` is a flag, not a null
ctx. Every existing `ResolveContext` literal in the tests needs the field: add it with `settled: true`
to the shared fixture builder, not by hand in each test (grep for how the tests build a ctx —
`makeCtx`/`baseCtx` or similar — and say which).
Pins: CB-showday-7..: a day-off-board sentence produces the "Moved the board to …" turn and calls
`onShowDay` with no press; the rerun does NOT fire on a ctx with `settled: false` even when the day is
on it, and fires on the next ctx with `settled: true`; Escape during the move still drops the rerun.
Rewrite CB-showday-1..6 where they assert the button (read each; say which pinned the button and what
they assert now). Update R-419's cases note only if a case name changes.

## 4. R-456 / F-222 — the verb question (CommandBar.tsx)
Two sites. (1) `fallbackToRules`: when `parseCommand` fails, before `failureToStatus`, call
`guessVerbs(sentence, GROUNDING_VERBS)`; if non-empty, set a question status whose message is
`describeVerbGuess(...)`'s text and whose candidates are the guesses (label = `guess.label`, action a
new `CandidateAction` kind `run_sentence` with `{ sentence }` that runs `submitText`/the same path Enter
takes on `guess.sentence`, so the model reads it again and the trace gets a fresh entry with the pressed
sentence as `heard` and the button as the previous entry's `answered`). Only when it is empty does the
grammar hint show (R-456: never the hint first for a sentence with a shape). (2) `applyReading`'s
ungrounded branch: before `refuseUngrounded`/`askUngrounded`, the same call; a non-empty result asks the
verb question instead of refusing (the sweeping case included: "Show up Lena Novak and Priya Shah
today" must become a swap question, not a refusal). Until S72-a lands the stub returns `[]` and
nothing changes; pin with `vi.mock` returning two guesses: the buttons render, a press runs the
guess's sentence through the reader, the trace shows the press. CB-verb-1..4.

## 5. Files you own / must not touch
Own: `src/features/board/components/CommandBar.tsx`, `src/features/board/store/commandConversation.ts`,
`src/features/board/BoardPage.tsx` (the memo only), `src/lib/command/resolve.ts` (the `settled` field
on the type ONLY), `src/test/commandBar.test.tsx`, `src/test/commandBarGate.test.ts`, the shared ctx
fixture in the tests. Do not touch `parse.ts`, `grounded.ts`, `verbGuess.ts` (S72-a owns them and is
editing them now — ignore `tsc` noise from there), `docs/plan.yaml`, `scripts/`, `e2e/`. Run `npx vitest
run src/test/commandBar.test.tsx src/test/commandBarGate.test.ts src/test/commandResolve.test.ts` and
`npx tsc -b` (report S72-a's errors separately from yours) — not the full suite. No commit, no
`db:reset`, do not restart the dev server on 5173.

## 6. Report
Under 40 lines: each of the four pieces — what changed, which old cases pinned the old behaviour and
what they say now, new case ids; the ctx fixture you added `settled` to; test totals for the three
files; `tsc` result split by owner.
