# Lane brief: S198-A, a lot step that cannot go ASKS (DEF-0061, DEF-0062, R-466, R-467, R-435)

You are a build lane on the developer's tree (branch `Development`, clean at the tester's merge
fa8abdf plus one uncommitted edit to `docs/plan.yaml`, which you do not touch). Nobody else is
editing the repository. Read `CLAUDE.md` first (sections 4 and 7), then `docs/defects/DEF-0061.md`
and `docs/defects/DEF-0062.md`, then in `docs/plan.yaml`: R-466, R-467 (new today, the maintainer's
decision), R-425, R-435 (its 30 Sept restatement), R-431, R-432, R-459, and session 196's entry
(`docs/agent-briefs/s196-a-refuse-before-the-readout-brief.md` is the brief the lot pre-check
`refuseBusyLotSteps` came from -- read it, this piece builds on that one).

## Read this first: how this work is to be done

This piece is about what the bar SAYS and ASKS when a lot's step cannot go. On 28 and 29 Sept three
attempts at a piece of this kind were green on the unit suite and wrong in a browser (F-233). So:

1. **Browser first.** Reproduce DEF-0061 (both orders) and DEF-0062 as Ana on the tester's stack
   with a throwaway spec, and copy the thread's bubbles and the trace entry as they are now.
2. **Then the unit cases**, red, for what you saw.
3. **Then the fix.**
4. **Then the browser again**, and permanent cases in `e2e/typedWalk.spec.ts`.

Do not report this piece as done on unit tests.

## The two defects

Both are in `src/features/board/components/CommandBar.tsx`'s lot stepping (`startLot`,
`resolveLotStep`/`resolveLotStepBody`, `refuseBusyLotSteps`, `showLotStatus`, `runLotNow`,
`questionToStatus`, and `submitText`'s `awaitingOverrideReason` branch, ~l.5157).

**DEF-0061** -- "put Lena Novak and Sam Patel on Housing A at Cell 2 2026-10-13 from 3 pm to 5 pm"
(Lena lacks Welding, which Cell 2 needs; policy warn). The parse is `intent: several`, a lot of two.
`resolveLotStepBody` resolves Lena's step through `resolveCommand` with `inLot: false` (a several
lot's steps are ordinary singles), so `certificateGate` returns the `not_certified` warn question,
`questionToStatus` sets `awaitingOverrideReason: true`, and the status reads "1 of 2: Not done: Lena
... Say the reason to schedule anyway, or no." The typed reason then goes down `submitText`'s reason
branch, which re-runs `heldRef.current` -- and `runCommand`'s `several` branch returns BEFORE
`heldRef.current = command` (~l.2673 vs ~l.2685), so `heldRef` holds whatever the PREVIOUS sentence
was, or null. Lena first: a stale held command wrote Lena alone and Sam was never mentioned. Sam
first: `heldRef` was null, the branch's "belt and braces" `return` (~l.5200) swallowed the reason
three times over with no answer at all. Read those lines and confirm this account before you build;
if the cause is different, say so in the report.

**DEF-0062** -- "replace Sam Patel with Priya Shah on Cell 1" (today, Priya on Cell 4 of Line 2,
which Ana cannot read). `expandReplace` (`src/lib/command/resolve.ts` ~l.5221) builds a lot of two:
remove Sam, place Priya. Session 196's `refuseBusyLotSteps` puts the placement to `capacity_probe`,
finds Priya busy, DROPS that step and lists the rest: "Not doing Priya Shah on Cell 1 ...: she is
already on Cell 4 in Line 2 today from 6 am to 2 pm. Ready to do 1 thing: Sam Patel is off Cell 1
... Say yes to do it, or no." One press removed Sam and left the cell uncovered. The maintainer
ruled (R-466): a replace is ONE intent; the bar asks.

## The rules (decided, not open)

- **R-466 (the maintainer, 30 Sept).** A replace whose incoming person cannot be placed -- busy
  elsewhere, capacity, short a certificate, outside the area, absent -- says in one plain sentence
  why she cannot go and asks what to do next, with the choices as buttons: take the outgoing person
  off anyway (and the question says the place is left with nobody on it), or leave things as they
  are. Nothing is written before the answer.
- **R-467 (the maintainer, today, session 198).** A lot of INDEPENDENT steps ("put A and B on ...")
  asks a step's certificate question under warn, numbered as the lot's step, takes the reason for
  THAT step only, carries on to the next step, and lists everything for its one yes. Under block the
  step is refused and named in the listing's own words and the rest are listed -- the same shape
  `refuseBusyLotSteps` gives a busy step (R-465) -- or the refusal stands alone when nothing is
  left. "No" at the question drops the whole sentence. The area question is the same shape. Nothing
  is written before the yes.
- R-425's "a lot is refused before its yes" now reads as the rule for a COUPLED lot (replace, swap,
  copy) only; R-467's note in the plan says so. A coupled lot never asks a reason.
- R-431: no button offers what the server refuses. R-459: one or two plain sentences, no internal
  words. R-434: every ask, offer, write and refusal is a trace entry. R-447: the two buttons of a
  question are one width (look at how `yesNo` questions and the lot's "Do all N" are styled).

## What to build

### 1. DEF-0061: a several lot's step asks its reason and carries on

- `resolveLotStepBody`'s question branch already numbers the step's question. Make the reason answer
  work while a lot stands: in `submitText`'s `awaitingOverrideReason`/`awaitingAreaReason` branch,
  when `lotRef.current !== null`, the typed reason is the answer for the lot's CURRENT step -- record
  it as `answered`, re-resolve that step with `{ overrideReason }` (or `areaReason`), and carry on
  (`resolveLotStep`). The reason belongs to that step: a second uncertified step asks its own
  question and takes its own reason. Never `heldRef` for a lot. Decide where the per-step options
  live (a field on `Lot`, `src/features/board/store/commandConversation.ts`, is the honest place;
  `heldOptionsRef` is a single sentence's) and say so.
- The listing (`showLotStatus`) names the reason with its step, the way a single's readout does today
  ("... making Housing A. The reason given: covering an absence."). Find where the single builds
  that suffix (`suffixParts`, ~l.5214) and use ONE builder for both (R-449), not a second copy.
- Under block: `certificateGate` refuses (`policy: "block"`); the lot names the step and lists the
  rest, in `refuseBusyLotSteps`'s own words ("Not doing Lena Novak on Cell 2 ...: she is not
  certified for Cell 2, missing Welding."), or the refusal alone when nothing is left. The reason
  sentence comes from `describeQuestion` (`resolve.ts`) -- the same text, never retyped -- minus its
  "Not done:" lead (say how you strip it, or add a field the question carries; do not regex the
  sentence apart).
- "No" or a cancel word at the question drops the whole lot (`cancelStanding` already does).
- The trace: one entry for the whole lot (the file's own rule, read `resolveLotStepBody`'s comment on
  it); the step's question is `asked`, the reason is `answered`, the lot's listing is the next
  `asked`, the yes the next `answered`, and `ran`/`outcome` as `runLotNow` already records them.
  Read `src/lib/voice/trace.ts` for what the entry can hold and keep it truthful.
- The `refusalBeforeAsking` pre-check (~l.2877) returns null while a lot stands; the lot's own
  pre-check runs at the end in `refuseBusyLotSteps`. Keep that order and say in the report why a
  reason question inside a lot is not itself a door for the busy check (the write is still checked
  before the listing).

### 2. DEF-0062: a coupled lot asks instead of shrinking

- Mark the lot a replace builds as COUPLED. `Expansion` (`resolve.ts` ~l.3640) grows an optional
  field -- something like `coupled: { kind: "replace"; outgoing: string; incoming: string; place:
  string }` (names as the board says them; `place` is the cell the sentence named, or the cells of
  the blocks when it named none -- decide and say). `startLot`'s `extras` and `Lot` carry it. A swap
  and a copy are coupled too (say `kind: "swap" | "copy"`), but the QUESTION below is a replace's;
  a swap or copy that cannot go keeps today's whole refusal ("... Nothing changed.") -- there is no
  half of a swap a supervisor would want, and the maintainer's rule names the replace. Say this in
  the report as the line you drew.
- Two doors, ONE status shape. Write one builder in the bar (`replaceBlockedStatus(reason, lot)` or
  the like) that makes: message `${reason} Take ${outgoing} off ${place} anyway? ${place} would be
  left with nobody on it.` (adjust the words to R-459 -- a supervisor's sentence; if Sam has two
  blocks in the window, say the places plainly), and two buttons of one width: "Take Sam Patel off
  anyway" and "Leave it". Both doors reach it:
  - **The async door** (busy elsewhere, capacity): in `refuseBusyLotSteps`, when `lot.coupled?.kind
    === "replace"` and any placement step is refused, do NOT drop and list -- ask through the
    builder. The refusal sentence is the probe's own (`isBusyElsewhere`'s words, as today).
  - **The sync door** (certificate, area): `expandReplace` today returns the gate's question with
    `inLot: true` ("... Nothing changed."). Change it to return a new `Question` kind (name it
    `replace_blocked`) carrying the gate's own question as `reason` (so `describeQuestion` builds the
    reason sentence from the SAME text, never a retype), `outgoing`, `incoming`, `place`, and the
    REMOVAL commands (`SingleCommand[]`, the `removals` array it already builds). `describeQuestion`
    gets a case for it (the sentence above). `questionToStatus` in the bar turns it into the same two
    buttons. The `not_certified`/`outside_area` questions with `inLot: true` stay for swap and copy.
    Absence: find where an absent person is refused for a placement today (grep `absent` in
    `resolve.ts` and the bar) and route a replace's through the same door; if absence is only the
    server's refusal today, say so and leave it to the async door.
- **The buttons' actions** are data (`CandidateAction`, `commandConversation.ts`), never closures.
  "Take Sam Patel off anyway": for the async door, the lot minus its refused placement steps, RUN
  NOW (`runLotNow` over the kept steps -- the button IS the yes; no second "Ready to do 1 thing"
  question after it, the label says exactly what one press does). For the sync door, start a lot
  from the removal commands and run it the same way once they have resolved (they carry `existing`
  ids, so they resolve without questions; if one does not, the question is shown as a lot step is).
  Add one action kind for this, say `run_removals`, carrying what each door needs; do not add two.
  "Leave it": `cancelStanding`'s shape -- "Left it.", outcome cancelled, nothing written.
- The trace: the question is `asked`, the button's label `answered`, then `ran`/`outcome` from the
  run, or `cancelled`.
- Nothing is written before the answer: assert it (`onRunLot`/`onUnassign` not called until the
  press).

### 3. The sweep (CLAUDE.md section 7, duty 2)

The tester wrote: "the sweep of the bar for other places it drops or shrinks part of a sentence
instead of asking" is not done. Do it: read every place in `CommandBar.tsx` and `resolve.ts` where a
lot's step or a sentence's part is dropped, skipped, or silently narrowed (grep `kept`, `dropped`,
`slice(`, `filter(` over lot steps, `Nothing changed`, `several_unsupported`, `lot_too_big`), and
for each say in the report: asks (fine), refuses whole and says so (fine), or drops quietly (a
defect -- fix it if it is small and in your files, otherwise describe it precisely for a new defect
card). Do not widen the piece beyond the two defects without saying so.

## Files you own

`src/features/board/components/CommandBar.tsx` and its CSS Module,
`src/features/board/store/commandConversation.ts`, `src/lib/command/resolve.ts` (the `Expansion`
field, the `replace_blocked` question, `describeQuestion`'s case, `expandReplace`),
`src/lib/command/readout.ts` if the reason suffix builder belongs there, `src/lib/voice/trace.ts`
only if the entry's shape needs it (say why), and the tests: `src/test/commandBar.test.tsx`,
`src/test/commandResolve.test.ts`, `src/test/commandConversation.test.ts`, `e2e/typedWalk.spec.ts`,
`e2e/walk/*`, and throwaway specs under `e2e/` that you delete before you report.

## Files you must not touch

`supabase/**`, `src/lib/database.types.ts`, `src/lib/api/**`, `src/features/board/hooks/
useDragGesture.ts`, `src/features/board/lib/busyElsewhere.ts`, `src/features/board/components/
OperatorPanel.tsx`, `src/lib/command/grounded.ts`, `src/lib/command/parse.ts`,
`src/features/admin/**`, `src/test/defects/**`, `docs/defects/**`, `docs/plan.yaml`, `CLAUDE.md`,
`playwright.config.ts`. No migration.

## Existing cases that will go red, and what to do with each

CLAUDE.md section 4: "a green case can be pinning the bug." Read each before touching the fix and say
in the report, per case, whether it was WRONG or the CONTRACT CHANGED (name the rule):

- `commandResolve.test.ts` NC6 and NC5 (a replace refuses at expansion with `inLot: true`): the
  contract changed (R-466) -- they now expect `replace_blocked` carrying the same `not_certified`
  question as `reason`. NC7 (a copy) and the swap cases stay as they are.
- `commandBar.test.tsx` CB-nc-5b (a lot's `inLot: true` refusal takes no reason): stays true for a
  coupled lot; read it and say whether its fixture is a coupled lot or a several.
- CB-pre-11 / CB-pre-12 (a several with a busy step drops it and lists the rest): UNCHANGED -- that
  is R-465's shape for an independent lot and the tester verified it. If your change to
  `refuseBusyLotSteps` breaks them, the change is wrong, not the cases.
- `e2e/typedWalk.spec.ts`: "the same inside a swap is refused before the yes" (R-425) stays.
  Anything asserting a replace's old "Nothing changed." changes contract (R-466).

## Rules

Do not commit. Never `npm run db:reset`. PowerShell runs `npm`/`npx` (no `&&`; use `;`). Never
patch a file with `Get-Content`/`Set-Content`; use your Edit tool. Never `git checkout -- <file>`
(copy first, restore from the copy). **The tester's stack is UP** (the main session started it and
will stop it); do not run `tester-stack.mjs up`/`down`, start or stop any container, and never
point anything at `http://127.0.0.1:54321` (the developer's own stack, the maintainer's app). Set
the environment from `node scripts/tester-stack.mjs env` in the same PowerShell command as each
Playwright run and confirm `$env:VITE_SUPABASE_URL` is `http://127.0.0.1:54421`. ONE Playwright
process at a time, `--workers=1`, FOREGROUND. Put back whatever your browser runs write (a replace
that runs removes Sam's Cell 1 block -- restore it; a DEF-0061 run that writes Lena and Sam on
2026-10-13 -- remove them). The voice model is not served; `/v1/chat/completions` proxy errors are
noise. `npx vitest run --maxWorkers=2 <files>`; do NOT run the full `npm run test`. Ignore `tsc`
errors in files you do not own.

## Proving it

1. What you saw in the browser BEFORE the fix, all three sentences (DEF-0061 both orders, DEF-0062),
   as the thread's lines and the trace's.
2. Unit cases in `commandBar.test.tsx`, named `CB-lot-ask-N` (DEF-0061) and `CB-rep-N` (DEF-0062):
   Lena first -- the numbered question, the typed reason, Sam's step resolved, the listing names
   both with Lena's reason, one yes runs both with `override.reason` on Lena's step only; Sam
   first -- the same; block policy names Lena and lists Sam; every step blocked -- the refusal
   alone; "no" at the question drops the lot, nothing written; "yes" at the question re-asks ("Say
   the reason, not yes."); a reason that parses as a sentence runs as a sentence (CB-nc-6's rule);
   the trace entry at each point. Replace: busy incoming -- the question with both buttons, nothing
   written; "Take ... off anyway" runs the removal only, trace answered/ran/outcome; "Leave it"
   writes nothing, outcome cancelled; uncertified incoming (sync door) -- the same question, the same
   buttons, the removal on press; a replace whose incoming CAN go is unchanged (the ordinary
   two-step listing). `commandResolve.test.ts`: `expandReplace` returns `replace_blocked` with the
   gate's question inside and the removals; `describeQuestion` for it; a swap still refuses whole.
3. Mutations, copy-backed, each red BY NAME then restored: the lot branch of the reason answer
   removed (the reason falls to `heldRef` again); the coupled mark dropped from `expandReplace`
   (the replace shrinks again); "Take ... off anyway" wired to the whole lot instead of the kept
   steps; the sync door returning the bare `not_certified` again.
4. In the browser, on the tester's stack, as Ana: DEF-0061's two sentences (thread and trace copied,
   the rows read back after the yes, then removed); DEF-0062's sentence, both buttons, Sam's block
   read back after each (restored after "anyway"); a permanent case for each in
   `e2e/typedWalk.spec.ts` after the DEF-0060 case, in the file's serial order; then `npx playwright
   test e2e/typedWalk.spec.ts --workers=1` twice and once with `$env:WALK_SET = "2"`;
   `e2e/roleWalk.spec.ts` once. Copy each result line and duration.
5. `npx vitest run --maxWorkers=2` over `src/test/commandBar.test.tsx`,
   `src/test/commandResolve.test.ts`, `src/test/commandConversation.test.ts`,
   `src/test/commandLauncher.test.tsx`, `src/test/dragGesture.test.ts` and `src/test/defects/`:
   copy the total lines. `npx tsc -b` (conclusive; no migration), `npx eslint` and `npx prettier
   --check` over your files.

## Report

Plain prose. What you saw in the browser first. Where the per-step reason lives and why. What a
person sees now for: DEF-0061 both orders under warn, under block, and after "no"; DEF-0062 with a
busy Priya, with an uncertified Priya, after each button. The line you drew for swap and copy. The
sweep's findings, one line each. Every case added or changed (and for a changed one, wrong or
contract changed, with the rule). The mutations' red lines. Every run's result line and duration,
copied. What you wrote to the stack's database and put back. What you did not do or could not
prove. A draft commit message in the repo's style: plain ASCII, the reasoning in prose, no bullet
lists.
