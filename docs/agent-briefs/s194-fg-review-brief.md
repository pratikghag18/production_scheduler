# Review brief: S194-F and S194-G -- one job: break it

You are a reviewer, not the author. One lane made two changes:

- **S194-F (R-463), committed as 4cde4cc.** The app's 15-minute minimum length for a job and a
  person's block became one minute. Brief: `docs/agent-briefs/s194-f-no-minimum-length-brief.md`.
  Diff: `git show 4cde4cc`.
- **S194-G (F-233), NOT committed, in the working tree.** A block the server has not yet answered
  for (id `optimistic-<uuid>`) is no longer handed to the bar's resolver, cannot be grabbed by a
  drag or opened in a pop-up, and a sentence said while a create is pending is held and rerun.
  Brief: `docs/agent-briefs/s194-g-placeholder-id-brief.md`. Diff: `git diff` and the two new files
  `src/features/board/lib/optimisticId.ts`, `src/test/optimisticId.test.ts`.

Read `CLAUDE.md` §4 and §7, and in `docs/plan.yaml` the rows R-463, R-431, R-432, R-434, R-455,
R-459 and the findings F-233, F-234. The main session ran the full suite (4676 passed, 3 known
reds) and both walks green. Green is where you START.

## Rules

Nobody else is editing the repository. Do not commit. Never `npm run db:reset`. Write nothing to
the maintainer's database (`supabase_db_production_scheduler`). No migration. Do not edit
`docs/defects/*.md`, `docs/plan.yaml`, `CLAUDE.md`, `src/test/defects/`. Do not start or stop
containers. PowerShell runs npm and npx (no `&&`). Never `git checkout -- <file>`: copy first,
restore from the copy, confirm by hash after every mutation. Never patch with
`Get-Content`/`Set-Content`. You MAY run `e2e/typedWalk.spec.ts` against the TESTER'S stack only
(the one-line setup is in the S194-F brief); confirm before every run that
`$env:VITE_SUPABASE_URL` is `http://127.0.0.1:54421`. Run the full `npm run test` once, at the end.

## What you may write

New cases in ONE new file, `src/test/s194fgReview.test.tsx`. A red case is a finding; leave it red.
Fix a finding in the lane's files only when it is a few lines and the right answer is not in doubt.
Do not change any sentence a person reads, or how anything is drawn; report with a proposal.

## The main session's doubts -- test these first

1. **A sentence is held for up to five seconds and the person is told nothing.** While a create is
   pending, `runCommand` holds the sentence "invisibly". R-434: everything the bar hears is a trace
   entry and a turn in the thread. R-437: Enter empties the box. So for up to five seconds: is the
   sentence in the thread, does the bar show it is working, is there a trace entry, what happens
   if the person types a SECOND sentence while the first is held (is the first dropped, run twice,
   run out of order?), what does Escape do, what does a typed "yes" do? What if the page closes
   while held (DEF-0049: the trace must keep the turn)? Build each case.
2. **The hold is for the whole window, not the row.** Any pending create anywhere on the board
   holds EVERY sentence. Two people on one board, or one person dragging while another... it is one
   browser, so: a person who drags three blocks quickly and then speaks. Does each new create reset
   the five seconds, so a run of creates can hold a sentence without bound? Find where the bound
   starts counting.
3. **Past the five-second bound the sentence "proceeds against whatever ctx exists".** The
   placeholder is filtered from the resolver's view, so "clear Cell 1" then says "Cell 1 has nobody
   on it" while the person is looking at a block on Cell 1, and the block arrives a moment later
   and stays. That is a wrong answer said plainly. Build it: a create that never answers within the
   bound. What should the bar say instead? Propose; do not change.
4. **A create that FAILS.** The placeholder is drawn, the server refuses (a certificate, an
   overlap), the placeholder is rolled back. Is `hasPendingCreate` cleared on failure as well as on
   success, in every path (`onError`, `onSettled`, an unmounted component, a thrown mutation)? A flag
   that sticks true holds every sentence five seconds for the rest of the session. Find every place
   the placeholder row is added and removed and check they pair. Prove with a case per mutation
   hook (`useAssignmentMutations` has two sites, `useRunMutations` one).
5. **Other placeholders.** Grep the whole of `src/` for other optimistic inserts or temporary ids
   (`optimistic`, `temp-`, `pending-`, `crypto.randomUUID`) in any query cache the board or the bar
   reads: absences, runs' crew, templates. Does anything else hand an id the server never issued
   to something that acts?
6. **The one helper.** The brief demanded that no code compares an id with the string
   "optimistic-" in more than one place. Grep. Also: can a REAL id ever start with those characters
   (no: uuids are hex; say so), and does `isPlaceholderId` hold for `undefined`, an empty string, a
   number?
7. **The drag's new floor (R-463).** A resize stops one snap step from the fixed edge. An existing
   SHORT block, 5 minutes long, placed by the bar: can it be resized at all by hand? If the block
   is shorter than one snap step, does grabbing its edge jump it to a full step, refuse, or shrink?
   Can it be MOVED by drag without changing its length? Does a keyboard nudge keep its length? At
   Compact zoom the step is 60 minutes: moving a 5-minute block by drag must not make it 60.
8. **The 46-pixel drawn floor on a job's band.** Two 5-minute jobs five minutes apart on one cell
   at Compact zoom are each drawn 46 pixels wide from their own start: they overlap on screen though
   not in time. Which is on top, can the one underneath be clicked, and does the same already
   happen for two short person's blocks (the floor they had before)? Read the components; say what
   a person sees. Report, do not restyle.
9. **F-234 is pinned, not fixed.** "from 10 pm to 2 am" answers "That is -1200 minutes; a block is
   at least 1 minute." Confirm the case asserts the WRONG sentence only to stop it changing
   unnoticed, and that its name and comment say it is a known fault (a green case can be pinning the
   bug; the next reader must not take it for the contract).

## Then break it your own way

Mutate, copy-backed, red by name: the resolver's filter; the drag guard; the keyboard guard (the
lane wrote no case for it; if nothing goes red, write the case); the hold; the bound; the
rewriter's new branch for the generic failure; the constant back to 15. A change no case notices
is a finding.

Run the throttled-create spec inside `e2e/typedWalk.spec.ts` with the delay raised to SIX seconds,
past the bound, on the tester's stack, and report what the bar says and what the database holds
afterwards. Restore the delay.

## Report

Plain prose, findings first and most serious first: what a person would see, the case that shows
it (name and the runner's line), whether you fixed it. Then the nine doubts, confirmed or refuted
with evidence. The mutations and what caught each. The runner's total, copied. What you did not
examine.
