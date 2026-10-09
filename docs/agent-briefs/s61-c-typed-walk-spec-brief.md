# S61-c — the typed walk as a spec: every sentence the maintainer will be handed has run first

The maintainer, 16 Sept (session 176): "clear the board, make sure you have the tests figured
out properly before you hand me the testing." Twice a hand-written list met a board the
writer had not checked (a person without the cell's training, a date that rolled overnight, a
grammar form that does not exist). From now on the typed half of a walk is a Playwright spec
that drives the REAL bar on the REAL board and asserts each answer, and the maintainer is
handed only what that spec has already passed.

You own `e2e/typedWalk.spec.ts` (new), `e2e/walk/` (new folder: the sentence list as data and
its helpers), and a line in `docs/plan.yaml` is NOT yours. Read `e2e/voiceBar.spec.ts` (sign-in,
opening the bar, `statusLine`), `e2e/env.ts` (credentials; the spec skips itself without a
backend), `e2e/copyWeek.spec.ts` (a spec that prepares board rows through supabase-js and
cleans up after itself), `e2e/roleWalk.spec.ts` (which demo person can do what), and
`scripts/demo/rename-plant-a-operators.sql` (the six names). Plant A is on America/Chicago;
Line 1 (Cells 1 and 2) requires Welding; Sam Patel, Maria Lopez, John Kim and Priya Shah hold
it, Tom Baker and Lena Novak do not. Shifts on every cell: Shift 1 06:00–14:00, Shift 2
14:00–22:00, Shift 3 22:00–06:00. Parts: Cells 1–2 make Bracket A, Common Fastener, Housing A,
Line 1 Subassembly A; Cells 3–4 make the first three; Cells 5–6 add Area 2 Frame A.

1. **Setup and teardown through the database, not the screen.** `beforeAll` deletes every
   assignment and run on Plant A's nodes whose range starts within the spec's own window
   (today − 1 to today + 8, Chicago), as `copyWeek.spec.ts` prepares rows — read how it gets a
   client that may write, and reuse that exact door. `afterAll` deletes the same again. The
   spec signs in as the Plant A admin the role walk uses and opens the board on today's window.
2. **The sentences are data.** A single sentence runs on its readout with no yes (the bar's own
   rule, S47; the trace records `answered: "auto"`); only a lot's listing and a question take an
   answer, and a `not_certified` question under warn takes a reason as its answer. Write the
   entries accordingly. `e2e/walk/sentences.ts` exports an ordered list of
   `{ say: string; answer?: "yes" | "no" | string; expect: RegExp | { button: string; then: RegExp }
   ; note?: string }`. The spec runs them in order; each entry's `expect` matches the bar's status
   line (or the question text, then presses the named button, then matches). Write the list to
   cover: a clear of an empty cell (nothing_to_do), assign with a part, the plural near-miss
   ("Common Fasteners" matches directly — no question, say so in `note`), a real near-miss
   ("Housing Pay" → a Did-you-mean with the Housing A button), a sentence with no part (Which
   part? with the cell's menu), a booking with headcount, "from 2 until end of shift" (14:00–
   22:00 by the rules; the model may say 02:00 — the spec asserts what the bar SHOWS and marks
   the entry `note: "model gap until the sixth run"`, matching either and recording which in
   the test's own output), end/extend adjusts, the headcount form ("make the Bracket A job on
   Cell 3 4 people"), a split, a copy to tomorrow, a swap, "every weekday next week" answered
   no, an uncertified person on Cell 1 (Tom Baker: the not_certified question — under warn, a
   typed reason then runs; assert the block exists with `eligibility_override = true`), the
   same inside a swap (refused before the yes), a day-less sentence after Show that day moved
   the window (asks day_off_board "today"), and a clear of today at the end that lists every
   block created (the count must match what the spec created). Every person you place must
   hold the cell's training unless the entry is the certification case. Every clock in an
   `expect` is derived from the entry's own words, never hand-summed.
3. **Assert the writes, not only the words.** After each `yes`, read the assignments for
   Plant A through the client and assert the row the readout promised (person, node, product,
   range in UTC computed from Chicago) exists; after a swap or a clear, that the removed rows
   are gone. This is what catches a lot that "reverted" nothing.
4. **The trace.** After the run, read `data/voice/trace/bar.jsonl` from disk (the dev server
   the spec starts appends it) and assert one line per sentence in order, each with `asked`
   and `answered` non-null (F-157's rule) and `heard` equal to the sentence.
5. **Output for the maintainer.** On success the spec prints a table (sentence → what the bar
   said → what was written) to stdout; the developer hands the voice sentences from the same
   data file with `voice: true` entries, which the spec skips (they are the maintainer's).

Run it: `npx playwright test e2e/typedWalk.spec.ts --workers=1` against the running stack
(the dev server, the model and Whisper containers are up). The whole spec must be idempotent:
run it twice in a row. No commits, no plan edits. Report: the sentence table as printed, any
sentence whose answer surprised you (that is a finding for the developer, not something to
work around in the spec), and the totals.
