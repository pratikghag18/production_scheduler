# S70-c — the thread scrolls, the hint knows the bar's words, a spoken answer runs

Read F-192, F-195 and F-197 in `docs/plan.yaml` (their `story` is the evidence, from the spoken
walk of 22 Sept), R-427, R-425, R-434, R-420, and CLAUDE.md §4 and §7. Three fixes, one lane, all
in the bar's own files. The trace of the walk is `data/voice/trace/bar.jsonl` (lines from
2026-09-22T17:31Z on, `"by":"local"`); read the turns the findings cite before touching code.

## 1. The thread cannot be scrolled back (F-192)

`src/features/board/components/CommandBar.module.css`, `.threadBody`: `justify-content: flex-end`
together with `overflow-y: auto` in a flex column pushes the overflow above the box where no
scrollbar reaches it. Replace the bottom anchoring with a mechanism that keeps the turns pinned to
the bottom when there are few and lets the box scroll when there are many: `margin-top: auto` on
the first turn (a `.turn:first-child` rule, or a spacer element before the turns). Keep every other
rule and the S63-a comments true; rewrite the comment that explains the anchoring so it says why
`flex-end` was wrong. Pin it: a case in `src/test/commandBar.test.tsx` beside CH-1 that renders a
thread with many turns and asserts the scrolling element does not carry `flex-end` (jsdom lays
nothing out, so assert the class contract the way TB-13 does, and say so). Then LOOK at it in the
browser with twenty turns: the oldest must be reachable by scrolling, and with two turns they must
sit at the bottom. Report what you saw.

## 2. The hint lacks the bar's own words (F-195)

`src/lib/voice/recognizerHint.ts`, `VOCABULARY`: add the verbs and nouns the walk says and Whisper
missed -- end, block, clear, copy, make, job, until, shift, from, to, today, tomorrow, week, on --
in the same style as the list there (D133 item 4). Keep the cap the file enforces; if the cap is
hit, the board's names come first and the vocabulary is trimmed from the end, never the other way
round, and say which words fell off. Update `src/test/recognizerHint.test.ts`.

## 3. A spoken free-text answer is swallowed (F-197)

Typed, "The line supervisor approved the cover." answers the not-certified warn question and runs
the override (typedWalk entry 18, green). Spoken, the trace shows the same text as `answered` and
`outcome: null`, no write. Find the path: a final transcript submits "exactly as Enter does"
(`submitText` in `CommandBar.tsx`, S46-a), but the standing-question branch that turns a typed
free text into the override re-resolution may be keyed on the typed path, or the recogniser's
final result may clear the standing question before the answer is applied, or the answer is
applied and then the recognised text is submitted a second time as a sentence. Read
`startListening`/`stopListening`, the `recognizerName` and `startTrace` plumbing, and the
warn-question answer code (grep `override_reason`, `not_certified`, `answerIfAny`-like branches).
Fix it so a spoken answer to ANY standing question (yes, no, a reason, a candidate's words) runs
exactly as the typed one, and the trace line shows `answered` AND the outcome. Pin it in
`commandBar.test.tsx` with the fake recogniser the CB-t cases already use: a standing warn
question, a final transcript of a reason, the override write runs, the trace entry carries both.

## Boundaries

- You own: `CommandBar.tsx`, `CommandBar.module.css`, `src/lib/voice/recognizerHint.ts`,
  `src/test/commandBar.test.tsx`, `src/test/recognizerHint.test.ts`. Nothing under `src/lib/command/`
  (another lane owns `parse.ts`), nothing in `src/features/admin/` (another lane), no `e2e/`, no
  `docs/plan.yaml`, no `CLAUDE.md`.
- `npx vitest run` on the two test files plus `src/test/scaleAudit.test.ts`; `npx prettier --write`,
  `npx eslint`, `npx tsc -b`. Do not run the full `npm run test`. Do not commit.
- Report: for each of the three, what was wrong in one sentence, what changed, the pin's name, and
  the runner output verbatim; for the thread, what you saw in the browser.
