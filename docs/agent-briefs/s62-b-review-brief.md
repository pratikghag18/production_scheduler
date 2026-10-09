# S62-b review — break the answer box, the conversation store, the thread, the area gate

Read `docs/agent-briefs/s62-b-answer-box-conversation-store-brief.md`, the R-427 and F-166/F-167
follow-ups described in `docs/plan.yaml` (R-427, F-162 to F-167), then `git diff` (all uncommitted).
One job: break it. Do not fix; report. Drive the REAL bar (dev server 5173, sign in as the
voiceBar spec does, Plant A admin) for anything that can be driven; clean every row you write.

1. **The store across close/open.** Open the bar, type "assign Tom Baker to Housing A on Cell 1
   from 3 to 5" (a reason question), click the toolbar's day-count field (outside), reopen: the
   question, the empty answer box and the thread must stand. Type the reason: the block is
   written with the override. Then the same with a lot listing standing; then with a Show
   that day button standing — press it after reopening. Then two boards: open the bar on Plant
   A, switch the board's place to Plant B (or another plant), open the bar: the thread must be
   Plant B's own (key = user + plant), not Plant A's; back to A: A's thread returns.
2. **The history's storage.** Fill 210 turns through the store's API in a unit-style scratch
   (or the real bar if fast enough): cap at 200 holds; an entry stamped 25 h ago is pruned on
   load; a corrupt localStorage value (not JSON, wrong shape) is ignored, not thrown; storage
   disabled (throwing setItem) is swallowed and the bar still works.
3. **Nothing in the past is live.** A past turn's chips: click each; nothing runs, nothing
   changes. The CURRENT question's chips still run. Keyboard: Tab through the thread — no past
   chip takes focus as a button.
4. **The area gate.** Sam Patel (owned by Line 1) onto Cell 3: asks before the yes; reason
   typed → row written with `area_override` true and the reason, `eligibility_override` false.
   Tom Baker (no Welding) onto Cell 1: `eligibility_override` true, `area_override` false. A
   person failing BOTH (make one: Lena Novak has no Welding; is she owned by Area 2? check
   `operators.site_node_id`) onto Cell 1: are both questions asked, in what order, and does one
   reason satisfy both or does the bar ask twice? Whatever it does, is it honest and pinned?
   A lot with an outside-area member: refused before the yes, nothing written (count rows).
   Then the mirror the brief warns about: the gate must use `site_node_id`, not `home_node_id`;
   find a demo person whose two columns differ and prove the bar agrees with the server.
5. **F-166.** "yes" alone, "no" alone, "ok" alone with nothing standing: the status says
   there is nothing to answer, the model is not called (watch the trace's `model` field), and a
   sentence-opened create pop-up still takes a spoken yes.
6. **F-167.** An ordinary assign that opens the pop-up: the pop-up's auto-create writes, and the
   thread's line turns from Waiting to Written; cancel the pop-up: Cancelled; make the server
   refuse (a person on two cells at once): Refused with the message. The trace file agrees.
7. **The typed walk and the rest.** `npx playwright test e2e/typedWalk.spec.ts --workers=1`
   once; `npx vitest run src/test/commandPurity.test.ts src/test/scaleAudit.test.ts
   src/test/popoverStandard.test.ts`; `npx prettier --check` on every file in the diff.

Scratch files under `src/test/` or `e2e/` must be deleted before you report. Report each attack
BROKEN (sentence, board, wrong output) or HELD, and the one thing you would change first.
