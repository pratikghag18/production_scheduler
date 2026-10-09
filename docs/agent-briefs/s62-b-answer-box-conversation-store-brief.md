# S62-b — the answer box, the conversation outside the bar, the trace's last word, and the swap's fourth step (F-162 to F-165)

Read F-162, F-163, F-164, F-165, R-424 and R-421 in `docs/plan.yaml`, then
`src/features/board/components/CommandLauncher.tsx` (close on outside mousedown, Esc closes),
`CommandBar.tsx` (status, `heldRef`, `lotRef`, `traceRef`, `pendingRerunRef`, `handleChange`'s
"any edit drops the held command", `runLotNow`, `postTrace`/`finishTrace`), and
`useDragGesture.ts`'s `openCreateFromCommand`/`createFromCommand`. You own `CommandBar.tsx`,
`CommandLauncher.tsx`, a new `src/features/board/store/commandConversation.ts`, their tests
(`commandBar.test.tsx`, `commandLauncher.test.tsx`, a new store test), `src/lib/voice/trace.ts`
and `trace.test.ts`, and for F-165 whatever the reproduction leads to (list every file). Do not
run the full `npm run test`; no commits; no docs edits.

1. **F-162 — the answer box.** When a question stands (a candidate list, a lot's listing, a
   confirm, a `not_certified` reason, `which_job`, any question), the input is EMPTIED and its
   placeholder says what the question takes: "yes or no", "yes, no, or the reason", "a name, or
   no", "the job's name". The sentence stays readable in the status line above ("You said:
   …" is not needed if the question already quotes it; keep it short). Typing the answer never
   drops the held command; typing something that parses as a full new sentence (the CB-nc-6
   rule) IS a new sentence and drops the question. Escape drops the question and restores the
   sentence in the input so it can be edited. Pin CB-ans-1..5.
2. **F-163 — the conversation lives outside the bar.** Move the bar's conversation state
   (status, held command, pending question, lot, pending rerun, the open trace entry, the input
   text) into a small zustand store `commandConversation.ts` keyed per board mount, so the
   launcher's close/open (outside mousedown, Esc) unmounts and remounts the bar without losing
   anything: reopening shows exactly the status, the buttons and the input that stood. The
   store is reset only by a cancel word, a finished readout's natural end, or a new sentence —
   never by open/close. Keep R-424's placeholder-data protection as is. Pin CB-keep-4..6: close
   by outside mousedown with a question standing, reopen → same question and buttons; close
   with a lot listing → reopen → "Do all N" still there; Escape inside the bar (the panel's own
   rule) still closes and does NOT lose the conversation (R-424) — say in a comment which key
   closes and which cancels, and make "Esc closes" mean close, with the cancel word the only
   cancel.
3. **F-164 — the trace's last word.** `runLotNow` sets the failure status AFTER `finishTrace`;
   record the failure text as the entry's last `asked` (a new field `outcome` if `asked` is the
   question) before finishing. A single's `ran` entry must only be written once the writer
   answered: `onOpen`/`onMove`/`onBook`/`onSetHeadcount` return a promise (or a callback) that
   resolves to `written`, `refused: <message>` or `popup: <what it waits for>`; the trace records
   which. Pin CB-t-15..17.
4. **F-165 — the fourth step.** Reproduce in the real browser (dev server 5173, sign in as the
   voiceBar spec does) the exact sequence, reading the trace after each step now that F-164
   records outcomes: "clear Area 1 today" (answer if asked), "assign John Kim to Housing A on
   Cell 3 from 8 to 12", "assign Sam Patel to Cell 1 from 8 to 4" → Housing A, "end Sam Patel at
   2", "swap John Kim and Sam Patel today" → Do all 4. Read the fourth step's outcome. Then say
   "assign Sam Patel to Housing A on Cell 3 from 8 to 12" on its own and read its outcome and
   whether a pop-up opened behind the bar. Name the cause (a server refusal and its text, a
   pop-up waiting for an override, an overlap with an unwritten step, or something else) and
   fix it if it is the bar's; if it is the server's rule working as designed, the bar must ask
   before the yes (R-425's shape) and say so. Pin whatever the cause is. Clean every row you
   wrote; leave Plant A's 17 Sept empty.

Run `npx vitest run src/test/commandBar.test.tsx src/test/commandLauncher.test.tsx src/test/trace.test.ts
src/test/traceServer.test.ts` plus the new store test, `npx tsc -b`, `npx eslint src/features/board
src/lib/voice`, `npx prettier --check` on your files, then `npx playwright test e2e/typedWalk.spec.ts
--workers=1` once (it drives the real bar; it must still pass). Report: the cause of F-165 with
the outcome lines from the trace, the placeholder texts, the store's shape, the pins, the totals.
