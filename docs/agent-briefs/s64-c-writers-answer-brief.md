# S64-c — every writer answers, and a spoken sentence clears a stale rerun (F-168, F-169, R-434)

Read F-168, F-169, R-421, R-427 and R-434 in `docs/plan.yaml`, `docs/agent-briefs/s64-b-lots-and-trace-audit.md`
(the "Found on the way" paragraph and list C), and CLAUDE.md §4 ("a write that reports success can have
changed nothing") and §7. Then `src/features/board/components/CommandBar.tsx` — `settleWrite` (grep it; the
lines that read an `undefined` outcome as `written`), `submitText` (grep `pendingRerunRef`), the `onRetime`,
`onRetimeRun`, `onUnassign` and `onMove` prop types (grep `CommandBarProps`), — `src/features/board/BoardPage.tsx`
(the four writer props ~1152–1194 that return nothing), and `src/features/board/hooks/useDragGesture.ts`
(`removeAssignment` ~2685, `retimeAssignmentFromCommand` ~1841, `retimeRunFromCommand`, each a fire-and-forget
`.mutate` with a toast on error; `openMoveFromCommand` for the move-cell half, which already reports).

You own `CommandBar.tsx`, `BoardPage.tsx` (the four writer props only), `useDragGesture.ts` (those three
writers only), `src/test/commandBar.test.tsx` and `src/test/dragGesture.test.ts`. No commits, no docs
edits, no full `npm run test`, no playwright; never `db:reset`.

1. **F-168 — the four silent writers answer.** `onRetime`, `onRetimeRun`, `onUnassign` and the retime
   half of `onMove` return the same `WriteOutcome` promise the create and book writers return
   (`{kind: "written"}` or `{kind: "refused", message}` in the plant's words, the toast's sentence through
   `rewriteCapRefusal` where it is the capacity one), by awaiting `mutateAsync` in the three drag hooks
   (keep the toast on error; do not throw past it). `settleWrite` treats an `undefined` outcome as a TYPE
   ERROR, not a success: make the prop types return `Promise<WriteOutcome>` so a void writer no longer
   compiles, and remove the `undefined → written` branch. Pins CB-w-1..CB-w-4: a refused unassign, retime,
   run retime and move-retime each show Refused with the server's reason in the thread, the trace's
   `outcome` says `refused: …`, and `ran` is empty; a written one shows Written.
2. **F-169 — a new sentence clears the pending rerun.** `submitText` clears `pendingRerunRef` the way it
   clears the lot, so a spoken sentence (which never passes `handleChange`) cannot inherit a "Show that
   day" rerun. Pin CB-rr-1: press "Show that day", then a spoken final sentence arrives before the window
   lands; the window then lands; the OLD command does not run and the NEW sentence's trace entry keeps its
   own `read`/`ran`/`outcome`.
3. **R-434 — the entry closes on the four paths list C names.** Exactly these four, nothing more in this
   lane: the recogniser's errors (mic refused, nothing heard, stopped) write a trace entry with `heard`
   empty and `outcome: refused: <the message>` and file a turn; `submitText`'s no-op while a lot is writing
   files a turn saying the sentence waited ("Working…" stands, the sentence is not lost: keep it in the
   store and run it when the lot finishes, or say plainly it was dropped — say which you chose and why);
   `nothing_to_do` and `cancelStanding` set `outcome` so the thread's last line is never blank. Pins
   CB-tr-1..CB-tr-4.

Then `npx vitest run src/test/commandBar.test.tsx src/test/dragGesture.test.ts src/test/commandConversation.test.ts
src/test/trace.test.ts`, `npx tsc -b`, `npx eslint src/features/board src/test`, `npx prettier --check` on your
files. Report: the pins, every existing case changed with its reason (CLAUDE.md §4), the runners' totals
verbatim, the choice you made on item 3's lot-busy path, and anything the brief got wrong.
