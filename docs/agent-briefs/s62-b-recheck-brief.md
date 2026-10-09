# S62-b re-check — the six fixes after the first review

Read `docs/agent-briefs/s62-b-review-brief.md` and the first review's four breaks (in the plan's
session 177 summary once written; until then: the word guard only under a non-question status,
a stored turn with a missing array crashing the bar, the split-coverage and cancel-word hand-offs
never reporting, and a superseded write updating the thread but not the file or neither). Then
`git diff`. Drive the REAL bar; clean every row; leave Plant A's 15 to 27 Sept empty.

1. "no" at a candidate question ("assign Bob to …" → No person called Bob → "no"): nothing
   written, the question dropped, the reader never called (the trace's `model` says skipped).
   "yes" at a run_exists question; "no" at an ambiguous-person question; "ok" with a lot standing
   (runs it); "no" with a reason question standing (drops it). Read each placeholder: it names
   only words the question takes.
2. localStorage seeded with `[{"at":"2026-09-17T10:00:00Z","heard":"hello"}]` under the live key:
   the board renders, the thread is empty or shows nothing for that turn, no throw. Then a turn
   with `offered: "x"` (a string, not an array). Then one with `model: 5`.
3. A sentence whose write goes to the split-coverage pop-up (a person already on another cell
   at those hours): the thread's line says handed off, and when the split pop-up completes or is
   cancelled the line settles. "no" spoken at a waiting create pop-up: the pop-up closes and the
   turn says Cancelled, in the thread and in `data/voice/trace/bar.jsonl`.
4. Delay `create_assignment` by 6 s (route interception), answer a reason question, say the next
   sentence 1 s after the readout: when the write lands, the earlier turn shows Written in the
   thread and the file holds a later line with the same `at` and `revises: true` carrying `ran`.
5. A person failing both gates (re-home one through the app as before, restore after): the
   final readout names both overrides; both columns set on the row.
6. Switch the board root (if any demo person has two grants now; else prove by the store's
   unit pin CS-4 that a key change flushes the open entry and resets the status).
7. `npx playwright test e2e/typedWalk.spec.ts --workers=1`; `npx vitest run src/test/commandPurity.test.ts
   src/test/popoverStandard.test.ts src/test/scaleAudit.test.ts`; `npx prettier --check` on the diff.

Scratch files deleted before reporting. Report each as BROKEN or HELD, and anything new you saw.
