# Lane brief: S195-A, the bar's words (DEF-0043 reopened, DEF-0052 reopened, DEF-0055, DEF-0044 item 6)

You are a build lane on the developer's tree at 992ffbc (branch `Development`). One other lane,
S195-B, is working at the same time; its files are listed under "Files you must not touch". Read
`CLAUDE.md` first (section 4 and section 7 are the rules this work is judged by), then the four
defect files named below, each from top to bottom including the tester's notes of 30 Sept:
`docs/defects/DEF-0043.md`, `DEF-0052.md`, `DEF-0055.md`, `DEF-0044.md`.

## The standards this serves

- **R-459, every sentence the bar says is one a supervisor would say.** One or two plain
  sentences; never a 24-hour span ("22:00-06:00"), a chain joined with a middle dot, an ISO date,
  or an internal word. Grep `^- id: R-459` in `docs/plan.yaml` for the full text.
- **R-432, a lot says what it did and what it did not** (restated 28 Sept): done, not done with
  its reason in the plant's words, and not tried, every change named so a person who cannot see
  the board can tell what it looks like now.
- **R-430, a dead end offers the nearest choices**, and **R-435, when in doubt, ask.**
- **R-434, every bar feature traces**: whatever the thread says, the trace entry says.
- DEF-0044's class: a limit that holds today but that no test would notice going.

## What is already done and must not be redone

Session 194 (commits 504a74b, a381b01, f84fbd3) fixed and the tester VERIFIED: "for 1 person" in
job readouts (`peopleCount`), the Done line's day ("Mon Oct 12" not the ISO date), the three-line
lot outcome (`buildLotOutcome` in `CommandBar.tsx` ~l.3084), `attempted` and `notTried` on every
resolved kind (`resolve.ts`), the one refusal rewriter (`rewriteRefusal`, `CommandBar.tsx`
~l.1094), the week clear planned once over the whole span (DEF-0047), the unknown-cell fallback
that offers the caller's own cells (DEF-0051). Six of DEF-0044's seven mutations are held. Leave
all of that standing; you are finishing what the tester found still wrong.

## The work, item by item

### 1. DEF-0043: the which-block and join buttons still carry 24-hour spans and a chain

The tester's reproduction, still red:

```
Maria Lopez has 2 blocks Sat Oct 3. Remove which?
Remove Cell 2 · Housing A 22:00–06:00
Remove Cell 2 · Housing A 14:00–22:00
```

and on the join question: a button reading `Housing A 06:00–14:00` beside `Separate block`.

Where it is built: `resolve.ts` `elsewhereCandidate` (~l.1471, `label: \`${cellName} · ...\``)
and the other `Candidate` builders near it (grep `label:` in `resolve.ts` and read every one);
`CommandBar.tsx` ~l.4178, 4223, 4282 (`Change ${b.label}`, `Change ${run.label}`,
`Remove ${b.label}`); the block's and the run's own `label` (the doc comments at `resolve.ts`
~l.65 and ~l.90 say "10:00–14:00": find where the board builds `ContextAssignment.label` and
`ContextRun.label`, probably `BoardPage.tsx` or a lib beside it, and see who else reads it before
you change it). The spoken helpers already exist in `resolve.ts`: `spokenClock`, `formatSpan`,
`spokenizeSpans` (~l.1380 to 1440). Use them; do not write a second clock formatter (R-449's
spirit, and CLAUDE.md "a column list that appears twice").

What the buttons must read (the main session's choice under R-459; say in your report if the
code makes a different form more natural, but build this one):

- a block on one day: `Housing A on Cell 2, 2 pm to 10 pm`
- a block that crosses midnight, offered under the day it ends on or starts on: name both days,
  `Housing A on Cell 2, Fri 10 pm to Sat 6 am`. The tester's note: "the first button is Friday's
  night shift, offered under Saturday with no day said".
- the verb stays in front where it is today: `Remove Housing A on Cell 2, 2 pm to 10 pm`,
  `Change Housing A on Cell 2, ...`.
- the join button: `Join the Housing A job, 6 am to 2 pm`; `Separate block` stays.
- no middle dot, no en dash span, no 24-hour clock in any candidate label the bar can show. When
  you are done, grep the candidate builders for `·` and `–` and list what is left and why.

A dozen or more existing cases pin the raw form. CLAUDE.md section 4: "When a fix makes existing
cases fail, read those cases before touching the fix; say in writing whether they were wrong or
the contract changed." Here the contract changed (R-459, 24 Sept; the tester held it to the
buttons on 28 and 30 Sept). Update each, and list every case you changed in the report.

Candidate labels are also what a person may TYPE or SAY to answer a question (grep how an
answer is matched to a candidate: `label`, `word`, `matchCandidate` or similar in
`CommandBar.tsx`). Make sure an answer still matches after the label changes, and add a case.

### 2. DEF-0043: "1 things", "do them", and the list's joins

```
Ready to do 1 things: 1. Maria Lopez is recorded as off Wed Sep 30. Say yes to do them, or no.
Done, 1 things. Maria Lopez has nothing on the board Wed Sep 30; the absence is recorded. Written: ...
... making Housing A.; 2. ...          (".; " between numbered items)
… and 16 more Say yes to do them, or no.   (no full stop before "Say")
```

`CommandBar.tsx` `showLotStatus` (~l.2992 to 3008), `buildLotOutcome` (~l.3092), the `Written:`
joins at ~l.839 and ~l.841, and ~l.4867 ("That is N things at once; say yes to do them all").
Wanted:

- one: `Ready to do 1 thing: <readout> Say yes to do it, or no.` (no "1." numbering for a lot of
  one) and `Done, 1 thing.`
- several: `Ready to do 3 things: 1. <readout> 2. <readout> 3. <readout> Say yes to do them, or
  no.` Each readout already ends in its own full stop; join with a space, never "; ".
- more than six: `... 5. <readout> And 16 more. Say yes to do them, or no.`
- `Written:` followed by readouts joined with a space.
- `resolve.ts` ~l.6661 ("That would be N things at once") cannot be 1, leave it.

One helper for the singular/plural (like `peopleCount`), used at every site; prove it by a
mutation that makes it always plural going red BY NAME.

### 3. DEF-0052: "Not done" and "Not tried" leave the day out, and a vanished block is reported as a permission refusal

The tester's run (a week clear of 21 changes, one block deleted underneath before the yes):

```
Not done: Maria Lopez's block on Cell 2. You cannot change that from here.
Not tried: Maria Lopez stays on Cell 2. Sam Patel stays on Cell 1. ... The Housing A job on Cell 1 stays as it was, 6 am to 2 pm. (five times, word for word)
```

(a) Every `attempted` and `notTried` string the resolver builds (`resolve.ts` ~l.2917, 3367,
3435, 4754, 4913, 6027; grep `attempted:` and `notTried:`) names the DAY and the hours the way
that step's own `readout` does. The readout carries the day as an ISO token that the bar
re-renders through `renderReadout` (read `renderReadout` in `CommandBar.tsx` and the doc at
`resolve.ts` ~l.298); carry the same token so the day reads "Fri Oct 2", never raw. Wanted:

```
Not done: Maria Lopez's block on Cell 2 Fri Oct 2, 2 pm to 10 pm. That block is no longer on the board.
Not tried: Maria Lopez stays on Cell 2 Sat Oct 3, 2 pm to 10 pm. The Housing A job on Cell 1 Sat Oct 3 stays as it was, 6 am to 2 pm. ...
```

so no two lines of one answer can be word-for-word the same unless they are the same change. Add
a case that builds a lot over several days and asserts every Not tried sentence is distinct.

(b) The reason. Find where a delete (or a re-time) that changed no row becomes "You don't have
permission to change that." (start at `useDragGesture.ts` ~l.2842 to 2929, the lot runner, and
follow the writer into `src/lib/api/`; CLAUDE.md section 4: "a write that reports success can
have changed nothing"). A row that is GONE and a row that is FORBIDDEN are different facts and
must read differently. The client can tell them apart without a migration: after a write that
changed nothing, read the row by id as the caller; if the caller can still read it, it is
forbidden ("You cannot change that from here."); if it reads nothing, say "That block is no
longer on the board." (for a job: "That job is no longer on the board."). If the API layer makes
this impossible without a migration, STOP that sub-item and report what you found; do not write a
migration. Whatever shape you choose, the single-sentence path and the lot path must say the same
thing for the same fact, through `rewriteRefusal`, the one rewriter.

`commandBar.test.tsx` CB-lot cases pin today's wording; the contract changed (R-432 restated 28
Sept, held to multi-day lots by the tester 30 Sept). Say so in the file where you change them.

### 4. DEF-0055: "clear Maria Lopez tomorrow" is read as a cell

Pin: `src/test/defects/DEF-0055.test.ts` (red now; do not edit it). Trace of the live read:
`unassign "everyone" from Maria Lopez on tomorrow`.

The grammar reads whatever follows "clear" as a place with the reserved person "everyone"
(`parse.ts`; grep `everyone` and the clear/unassign grammar). The resolver then finds no cell and
falls to DEF-0051's fallback (grep the question kind that prints `No cell called` in
`resolve.ts`'s `describeQuestion`, and work back to where it is raised).

Wanted, decided where the board's facts are (the resolver has `ctx.operators`; the parser has no
board):

- the place text matches no cell or line on the board and matches exactly one person (the same
  name matcher "remove <person>" uses; find it, do not write another): the sentence is about that
  person. It must then behave exactly as the resolver's existing named-person removal does for
  that span: "clear Sam Patel this week" reaches the branch DEF-0043's and DEF-0047's pins build
  by hand (`expandRepeatUnassign`'s named-person branch), and "clear Maria Lopez tomorrow" reaches
  whatever "remove Maria Lopez tomorrow" reaches. Report in plain words what a person sees for:
  one block that day; two blocks that day; none.
- the text matches BOTH a place and a person (a person called like a cell): a question with both
  as buttons (R-435), never a quiet pick.
- the text matches neither: the nearest people AND the nearest cells are offered, by the
  closeness measure the unknown-name questions already use; with nothing close, DEF-0051's
  fallback (the caller's own cells) stays as it is.
- "clear Cell 2 tomorrow", "clear Line 1 for the rest of the week", "clear the board" and every
  other existing clear must read exactly as today. Run the whole `commandParse`/`commandResolve`
  suites to prove it.

The trace's `read` field for such a turn should say the person reading, not
`unassign "everyone" from Maria Lopez` (R-434); find where `read` is formatted and check.

The tester also saw, and did not file (F-229's family): "extend Sam Patel today by 30 minutes" is
answered `No person called "Sam Patel today"`. NOT in this lane; do not chase it.

### 5. DEF-0044 item 6: the case labelled mutation-provable that the mutation does not move

`commandResolve.test.ts`, the case titled "DEF-0044 item 6 (mutation-provable): a block edge
sitting exactly on the board's own last midnight is ON the board". With `edgeOnBoard`
(`resolve.ts` ~l.3691) changed from `<=` to `<` it still passes, because its sentence ("clear Sam
next week") goes through the week clear, which no longer calls `edgeOnBoard`.

Write the case that does exercise it: `blockEdgesOnBoard`'s callers are at ~l.3872, 4804, 5179,
5356/5358 (swap), 5718, 5758, 6120, and two filters at ~l.5729 and ~l.5774. A swap or a copy of a
block whose end sits exactly on the board's last midnight is the tester's suggestion. Then run
the mutation (copy the file first, restore from the copy; never `git checkout -- <file>`) and show
the case red BY NAME, then green restored. Fix or delete the old mislabelled case; a case that
says "mutation-provable" and is not must not survive.

## Files you own

`src/lib/command/resolve.ts`, `src/lib/command/parse.ts`,
`src/features/board/components/CommandBar.tsx` (and its CSS Module only if a label needs room),
`src/features/board/hooks/useDragGesture.ts` and the writer it calls under `src/lib/api/` ONLY for
item 3(b), the file that builds `ContextAssignment.label` / `ContextRun.label` for item 1,
`e2e/walk/sentences.ts` and `e2e/walk/sentences2.ts` (expected wording only), and the tests:
`src/test/commandResolve.test.ts`, `src/test/commandParse*.test.ts`, `src/test/commandBar.test.tsx`,
`src/test/s194bReview.test.ts`, `src/test/s194deReview.test.tsx`, `src/test/s194fgReview.test.tsx`,
and any other test under `src/test/` (not `src/test/defects/`) that pins a wording you changed.
New cases go in the existing files beside the code they test.

## Files you must not touch

- `src/lib/command/grounded.ts`, `src/test/grounded.test.ts`, `e2e/typedWalk.spec.ts`,
  `e2e/walk/db.ts`, `src/features/admin/**`, `src/test/operatorAbsences.test.tsx`,
  `.gitattributes`: lane S195-B is editing these now. If a wording you change is asserted in
  `e2e/typedWalk.spec.ts` (grep it for the old strings, e.g. `/02:00–06:00/` at ~l.864), do NOT
  edit the spec: list the exact line and the new text in your report.
- `src/test/defects/**`, `docs/defects/**`, `docs/plan.yaml`, `docs/plan.html`, `CLAUDE.md`,
  `supabase/**`. No migration.
- Ignore `tsc` errors in files you do not own; report them.

## Rules

Do not commit. Never `npm run db:reset`. **The database stack is DOWN and stays down**: do not
start, stop or reset any container, and do not run Playwright. PowerShell runs `npm`/`npx` (no
`&&`; use `;`). Never patch a file with `Get-Content`/`Set-Content` (it re-encodes UTF-8); use
your Edit tool. Never `git checkout -- <file>`. Memory is short on this machine:
`npx vitest run --maxWorkers=2 <files>`; do NOT run the full `npm run test`.

The model never writes a sentence the person reads (R-459): every string is built from the
board's own facts by the resolver or the bar.

## Proving it

1. The pins, by name: `npx vitest run src/test/defects/DEF-0055.test.ts
   src/test/defects/DEF-0043.test.ts src/test/defects/DEF-0043-headcount.test.ts
   src/test/defects/DEF-0047.test.ts src/test/defects/DEF-0040.test.ts
   src/test/defects/DEF-0046.test.ts src/test/defects/DEF-0048.test.ts` : all green, DEF-0055 green
   for the first time.
2. `npx vitest run --maxWorkers=2 src/test/commandResolve.test.ts src/test/commandBar.test.tsx
   src/test/s194bReview.test.ts src/test/s194deReview.test.tsx src/test/s194fgReview.test.tsx`
   plus every `src/test/command*.test.*` file: copy each runner's total line.
3. Mutations, copy-backed, each red BY NAME then restored: the singular helper made always
   plural; the day dropped from `notTried`; the gone-versus-forbidden read removed (every refusal
   reads as permission again); the person reading of "clear <person>" removed; `edgeOnBoard`
   `<=` to `<`.
4. `npx tsc -b` (say which errors, if any, are in files you do not own), `npx eslint` and
   `npx prettier --check` over the files you changed.
5. Grep the tests for the words you removed ("things" with 1, `·`, "You cannot change that from
   here" where the block was gone): `tsc` cannot see a string expectation.

## Report

Plain prose, in this order. For each of the five items: what a person sees now, as the exact
lines the bar prints (copy them from a test's output, do not compose them). Every existing case
you changed, with one line saying the contract changed and which requirement says so. Every new
case by name. The mutations and their red lines. Every runner total line, copied. The lines of
`e2e/typedWalk.spec.ts` that need a new wording. What you did not do or could not prove (nothing
here was run in a browser; say so). A draft commit message in the repo's style: plain ASCII, the
reasoning in prose, no bullet lists.
