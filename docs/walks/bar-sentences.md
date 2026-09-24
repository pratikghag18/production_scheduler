# Every sentence the bar shows (R-459 inventory)

S72-d, section 1. Built by reading `src/lib/command/resolve.ts` (the readout builders and
`describeQuestion`), `src/features/board/components/CommandBar.tsx` (the shape hints, the lot
wording, the refusal prefixes, its own `expandQuestion`-style switch for swap/replace/split
questions, and the dead-end/candidate wording), and `src/lib/command/parse.ts` (`expectedShape`,
the one grammar-hint string that module owns; failure *kinds* live there but every failure
*sentence* is built in `CommandBar.tsx`'s `failureToStatus`). `src/lib/command/verbGuess.ts`'s
`describeVerbGuess` is listed for completeness (R-426 duty: every string) but is owned by S72-a,
already landed, and this lane does not touch it.

Three columns: where, today's text (paraphrased where the template has many branches), the
proposed new sentence in the R-459 register. Rows marked **(fact only)** already read as plain
words and keep their fact, just tidied; rows marked **(rework)** carry a path/arrow/ISO/internal
word today and need the sentence rebuilt around the same facts.

## A. Readout builders — `resolve.ts`

| # | Where | Today's text | New sentence |
|---|---|---|---|
| 1 | `resolveAssignCommand`, resolve.ts:2343 | `"Sam Patel → Housing A · Plant 1 › Assembly › Line 1 › Cell 1 · 2026-09-03 · 10:00–14:00"` | "Done. Sam Patel is on Cell 1 today from 10 am to 2 pm, making Housing A." |
| 2 | same, `· joining <run>` suffix, resolve.ts:2348 | `"... · joining Housing A 06:00-14:00"` | "...joining the Housing A job already there." |
| 3 | same, `· changing <label>` suffix, resolve.ts:2350 | `"... · changing 06:00-14:00"` | "...changing the block that ran 6 am to 2 pm." |
| 4 | `resolveBookCommand`, resolve.ts:2461 | `"Housing A · Plant 1 › Assembly › Line 1 › Cell 1 · 2026-09-03 · 06:00–14:00"` | "Done. Cell 1 is booked today from 6 am to 2 pm, making Housing A." |
| 5 | same, `· N people` suffix, resolve.ts:2463 | `"... · 3 people"` | "...for 3 people." |
| 6 | same, `· changing <label>` suffix, resolve.ts:2465 | `"... · changing 06:00-14:00"` | "...changing the job that ran 6 am to 2 pm." |
| 7 | `resolveUnassignCommand`/`finishRemoval`, resolve.ts:2622 | `"Removing Sam Patel's Housing A block · Plant 1 › Assembly › Line 1 › Cell 1 · 2026-09-03 · 10:00–14:00"` | "Done. Sam Patel is off Cell 1 today; that was 10 am to 2 pm making Housing A." |
| 8 | `resolveMoveCommand`, adjust branch, resolve.ts:2999 | `"Sam Patel · Cell 1 · ends 14:00, was 10:00"` | "Done. Sam Patel's block on Cell 1 today now ends at 2 pm; it was 10 am." |
| 9 | same, move-cell branch, resolve.ts:3011 | `"Moving Sam Patel's Housing A block · Plant 1 › Assembly › Line 1 › Cell 1 · 2026-09-03 · 10:00-14:00 → Cell 2 · 10:00-14:00"` | "Done. Sam Patel is moving from Cell 1 to Cell 2 today, 10 am to 2 pm, making Housing A." |
| 10 | `resolveHeadcountCommand`, resolve.ts:3064 | `"Housing A · Plant 1 › Assembly › Line 1 › Cell 1 · 2026-09-03 · 06:00-14:00 · 3 people"` | "Done. The Housing A job on Cell 1 today (6 am to 2 pm) now takes 3 people." |
| 11 | `expandRunRemovals`, resolve.ts:3794 | `"Removing the Bracket A job · Plant 1 › Assembly › Line 1 › Cell 3 · 2026-09-03 · 08:00-16:00 · 3 people"` | "Done. The Bracket A job is off Cell 3 today; that was 8 am to 4 pm for 3 people." |
| 12 | swap/replace/split/copy | *(no own readout — each expands into several ordinary assign/unassign/book commands above, shown as a lot)* | *(covered by the lot rows below)* |

## B. `describeQuestion` — resolve.ts:5066-5225 (one row per `kind`)

| # | Where (`case`) | Today's text | New sentence |
|---|---|---|---|
| 13 | `ambiguous` | `Which person? "sam" matches 3:` | (fact only) "Which person? "sam" matches 3 people." |
| 14 | `unknown` | `No cell called "cel 9" on this board.` | (fact only, keep) |
| 15 | `not_offered` | `Housing A is not made at Cell 3, so it cannot be scheduled there.` | (fact only, keep) |
| 16 | `place_mismatch` (1 line) | `There is no Cell 9 in Line 2.` | (fact only, keep) |
| 17 | `place_mismatch` (2 lines) | `... Cell 9 is in Line 3 / Line 4.` | (fact only, keep) |
| 18 | `not_certified` (block) | `Lena Novak is not certified for Cell 2: missing Welding.` | "Not done: Lena Novak is not certified for Cell 2, she is missing Welding." |
| 19 | `not_certified` (warn) | `... Say the reason to schedule anyway, or no.` | (fact only, keep second sentence) |
| 20 | `outside_area` | `Lena Novak is not from Cell 2's area. Say the reason to schedule anyway, or no.` | "Not done: Lena Novak is not from Cell 2's area. Say the reason to schedule her anyway, or no." |
| 21 | `day_off_board` | `Mon 28 Sep is not on the board. Move the board to that day first.` | (fact only, keep) |
| 22 | `too_short` | `That is 15 minutes; a block is at least 30 minutes.` | (fact only, keep) |
| 23 | `run_exists` (1) | `A Housing A job is already booked on Cell 1, 06:00-14:00. Join it, or make a separate block?` | **(rework: raw "06:00-14:00")** "...already booked on Cell 1 from 6 am to 2 pm. Join it, or make a separate block?" |
| 24 | `run_exists` (n) | `3 Housing A jobs are already booked on Cell 1. Join one, or make a separate block?` | (fact only, keep) |
| 25 | `block_exists` (1, same) | `Sam Patel is already on Housing A at Cell 1 10:00-14:00 — nothing to change. Add a separate block?` | **(rework hours)** "...from 10 am to 2 pm — nothing to change..." |
| 26 | `block_exists` (1, change) | `... Change it to 10:00-14:00, or add a separate block?` | **(rework)** "Change it to 10 am to 2 pm, or add a separate block?" |
| 27 | `block_exists` (n) | `Sam Patel already has 2 Housing A blocks at Cell 1 (10:00-14:00, 14:00-22:00). Change one to 10:00-14:00, or add a separate block?` | **(rework hours list + span)** |
| 28 | `block_gone` | `That Housing A block of Sam Patel's at Cell 1 is no longer on the board. Add it as a new block?` | (fact only, keep) |
| 29 | `job_exists` (same) | `A Housing A job is already booked on Cell 1 06:00-14:00 — nothing to change.` | **(rework hours)** |
| 30 | `job_exists` (change) | `... Change it to 06:00-14:00, or pick other hours?` | **(rework hours)** |
| 31 | `job_in_the_way` | `Cell 1 already runs 06:00-14:00; a cell runs one job at a time. Pick other hours, or change that job on the board.` | **(rework hours)** |
| 32 | `job_gone` | `That Housing A job on Cell 1 is no longer on the board. Book it again?` | (fact only, keep) |
| 33 | `remove_which` (1, elsewhere) | `Sam Patel has no block on Cell 1 today, but has one on Cell 2: Housing A 10:00-14:00. Remove that one?` | **(rework hours in `partHoursPhrase`)** |
| 34 | `remove_which` (1, no cell) | `Remove Sam Patel's Housing A block on Cell 1, 10:00-14:00?` | **(rework hours)** "Remove Sam Patel's Housing A block on Cell 1, 10 am to 2 pm?" |
| 35 | `remove_which` (1, cell given) | `Remove Sam Patel's Housing A block on Cell 1, 10:00-14:00?` | same fix as #34 |
| 36 | `remove_which` (n) | `Sam Patel has 2 blocks on Cell 1 today. Remove which?` | (fact only, keep) |
| 37 | `no_block` | `Sam Patel has no block on Cell 1 today.` | (fact only, keep) |
| 38 | `block_gone_remove` | `That block of Sam Patel's on Cell 1 is already gone.` | (fact only, keep) |
| 39 | `move_which` (1, elsewhere) | `Sam Patel has no block on Cell 1 today, but has one on Cell 2: Housing A 10:00-14:00. Move that one to Cell 3?` | **(rework hours)** |
| 40 | `move_which` (n, elsewhere) | `... has 2 elsewhere. Move which to Cell 3?` | (fact only, keep) |
| 41 | `move_which` (n) | `Sam Patel has 2 blocks on Cell 1 today. Move which?` | (fact only, keep) |
| 42 | `several_unsupported` | `Several commands in one sentence are read but not yet run; say them one at a time for now.` | **(rework, "commands")** "I can only do one thing at a time from a typed sentence right now; say them one at a time." |
| 43 | `no_shift_pattern` | `Cell 1 has no shift pattern, so say the hours.` | (fact only, keep) |
| 44 | `no_shift` | `No shift called "nights" on Cell 1; it has Day, Swing.` | (fact only, keep) |
| 45 | `no_shift_at` | `No shift on Cell 1 covers 3 am; say a start that falls in one.` | **(rework raw clock text upstream?)** check `question.time` formatting |
| 46 | `no_start` | `q.text` (verbatim from parse.ts) | **needs read** — depends what parse.ts hands it |
| 47 | `lot_too_big` | `That is 40 commands; say a smaller place or span (the limit is 30).` | **(rework, "commands")** "That is 40 things at once; say a smaller place or span (up to 30 at a time)." |
| 48 | `nothing_to_do` | `q.text` verbatim, e.g. "Sam Patel cannot cover for Sam Patel" | (fact only, keep) |
| 49 | `split_needed` | `Sam Patel's Housing A block on Cell 1 crosses both ends of 10 am to 2 pm; say a span that reaches one end of the block instead.` | (fact only, keep) |
| 50 | `across_midnight` | `Sam Patel's Housing A block on Cell 1 crosses midnight and matches no shift; split it at midnight first, or say the shift.` | (fact only, keep) |
| 51 | `swap_which` | `Sam Patel has 2 blocks today (Housing A 10:00-14:00, Bracket A 14:00-22:00). Swap which?` | **(rework hours list)** |
| 52 | `day_order` | `Tue 29 Sep is before Mon 28 Sep; say the later day second.` | (fact only, keep) |
| 53 | `expand_first` | `That swap has to be worked out before it can run.` | **(rework, "swap"/`intent` is an internal word here)** "Say that one on its own first, then I can run it." |
| 54 | `adjust_inverts` | `Sam Patel's Housing A block would end before it starts.` | (fact only, keep) |
| 55 | `adjust_off_day` | `Sam Patel's Housing A block would cross midnight; that is not on this board.` | (fact only, keep) |
| 56 | `bad_adjust` | `q.text` verbatim | **needs read** |
| 57 | `split_outside` (with blocks) | `Sam Patel has no block that covers noon (has 10:00-14:00, 14:00-22:00).` | **(rework hours list)** |
| 58 | `split_outside` (no blocks) | `Sam Patel has no block that covers noon.` | (fact only, keep) |
| 59 | `no_job` | `No Housing A job on Cell 1 today.` | (fact only, keep) |
| 60 | `which_job` | `2 Housing A jobs on Cell 1 (10:00-14:00, 14:00-22:00). Say which.` | **(rework hours list)** |
| 61 | `bad_repeat_day` | `q.text cannot be used here.` | **needs read** |

## C. `CommandBar.tsx` — shape hints, lot, refusals, dead ends

| # | Where | Today's text | New sentence |
|---|---|---|---|
| 62 | `expectedShape`, parse.ts:4458 (read by `failureToStatus`) | `Say it like: assign <person> to <part> on <cell> [in <line>] ...` (4 alternatives, angle brackets) | "I did not understand that. Say who, where and when, like: assign Sam Patel to Cell 1 today from 8 am to 4 pm." (one example, per brief §2) |
| 63 | `failureToStatus`, two_days, CommandBar.tsx:928 | `I read two days, "Mon" and "Tue". Say one.` | (fact only, keep) |
| 64 | `failureToStatus`, bad_time/bad_day/bad_headcount, :936 | `I could not read "3ish". <expectedShape>` | keeps first sentence, second sentence becomes row #62's new text |
| 65 | `failureToStatus`, which_job, :946 | `Say which job — "make the Housing A job on Cell 1 4 people".` | (fact only, keep) |
| 66 | `failureToStatus`, bad_adjust, :950 | `Say how much — "by an hour", or "at 3".` | (fact only, keep) |
| 67 | `failureToStatus`, no_split_time, :953 | `Say where to split — "at noon".` | (fact only, keep) |
| 68 | `whyForReason`, :2108 | `"the model service is off"` / `"the model took too long"` / `"the model's answer was not a form"` | last one: "form" is a banned word — "the model's answer did not make sense" |
| 69 | `failurePrefixForReason`, :2116 | `The model service is off, so the rules read this: ` | "the rules" reads a bit internal — least-sure row, see report |
| 70 | " · read by the model" suffix, :2189/2288/3127 | appended to readout, shown on screen | **retired from the thread entirely** (brief §2) — trace keeps `by` |
| 71 | " · read by the rules (...)" suffix, :2189 | appended to readout | same call — retire or fold into the sentence itself; see report |
| 72 | `verbGuessStatus`/`describeVerbGuess`, verbGuess.ts:341 | `I heard "asign". Did you mean:` | already plain — **no change, owned by S72-a** |
| 73 | dup-block guard, CommandBar.tsx:1980 | `Commands assign-1 and assign-2 name the same block; say them one at a time.` | "commands" + raw ids — "Those two lines are about the same block; say them one at a time." |
| 74 | several-commands parse guard, :1854 | `I could not read that as several commands. Say them one at a time.` | "commands" — "I could not read that as more than one thing. Say them one at a time." |
| 75 | per-lot-step prefix, :1877 | `2 of 5: <question>` | (fact only, keep — numbering, not a banned word) |
| 76 | lot question, `presentLot`, :1994 | `4 commands ready: 1. <readout>; 2. <readout>; ... — say or type yes to do them, no to leave them.` | "commands" — "Ready to do 4 things: 1. ...; 2. ... Say yes to do all 4, or no." |
| 77 | lot button label, :1998 | `Do all 4` | (fact only, keep) |
| 78 | lot outcome, success, :2085 | `Done: 4 commands.` | "Done, 4 things." (matches §0 register exactly) |
| 79 | lot outcome, partial, :2086 | `Did 2 of 4; the next failed: <error> The 2 done stayed: <readout>; <readout>.` | "Did 2 of 4 things; the next failed: <error>. What was already done stayed: ..." |
| 80 | busy states, :2037/2301 | `Working…` / `Reading…` | (fact only, keep — status words, not sentences) |
| 81 | ungrounded refusal, `refuseUngrounded`, :2219 | `Did not run: nothing in "assign Sam to Cell 1" says assign. Say it again.` | "Did not run:" vs register's "Not done:" — least-sure row |
| 82 | `not_certified` in-lot, expandQuestion, :2652 | `Lena Novak is not certified for Cell 2: missing Welding. Nothing was written.` | "Not done: Lena Novak is not certified for Cell 2, she is missing Welding. Nothing changed." |
| 83 | `outside_area` in-lot, :2665 | `Lena Novak is not from Cell 2's area. Nothing was written.` | "Not done: Lena Novak is not from Cell 2's area. Nothing changed." |
| 84 | `lot_too_big` (client copy), expandQuestion :2576 | `That would be 40 changes; say a smaller span — one cell, or one day.` | "changes" ok, "commands" avoided already — keep, tidy only |
| 85 | `split_needed` (client copy), :2583 | duplicate of resolve.ts row #49, slightly different wording ("runs across both sides of" vs "crosses both ends of") | reconcile the two copies to ONE wording (R-449) — flag for maintainer |
| 86 | `across_midnight` (client copy), :2598 | duplicate of row #50 | reconcile — same flag |
| 87 | `swap_which` (client copy), :2605 | `Sam Patel has more than one block today: 10:00-14:00, 14:00-22:00. Say the hours.` | **(rework hours list)**, and reconcile with row #51 |
| 88 | `day_order` (client copy), :2612 | duplicate of row #52, different wording ("say the days the other way round" vs "say the later day second") | reconcile |
| 89 | `no_start` (client copy), :2619 | `Say when it starts — "from 10", say.` | odd trailing "say" — least-sure row |
| 90 | `no_shift_at` (client copy), :2626 | `No shift on Cell 1 covers 3 am.` (shorter than resolve.ts's own, no "say a start" clause) | reconcile with row #45 |
| 91 | `adjust_inverts`/`adjust_off_day`/`split_outside`/`no_job`/`which_job` (client copies), :2684-2712 | duplicates of rows #54, #55, #57/58, #59, #60 | same reconcile flag, one pass |
| 92 | part-as-place question, with suggestions, :2805 | `Housing A is a part; which cell?` | (fact only, keep) |
| 93 | part-as-place question, no suggestions, :2820 | `Housing A is a part; which cell? Say the cell.` | (fact only, keep) |
| 94 | dead-end with suggestions, R-430, :2853 | `No person called "sam ptael" on this board. Did you mean one of these?` | (fact only, keep — this IS the R-430 dead-end wording) |
| 95 | product-empty "which part", :2839 | `Which part? Cell 3 makes: <candidates>` | matches §0's own example almost exactly — keep |
| 96 | lot ambiguous confirm, :3477 | `That is a lot of 4 commands; say yes to do them all, or no.` | "lot"/"commands" both banned words — "That is 4 things at once; say yes to do them all, or no." |
| 97 | multi-candidate "which one", :3500 | `Which one? Cell 1, Cell 2, Cell 3` | (fact only, keep) |
| 98 | wrong-kind confirm, remove, :3517 | `That question is about a removal; say "remove it", yes, or no.` | (fact only, keep) |
| 99 | wrong-kind confirm, move, :3518 | `That question is about a move; say "move it", yes, or no.` | (fact only, keep) |
| 100 | "say the reason, not yes", :3400 | `Say the reason, not yes.` | (fact only, keep) |
| 101 | pop-up gate, :3531 | `The pop-up needs a decision first.` | "pop-up" reads like UI jargon — least-sure row |
| 102 | "say which one" fallback, :3615 | `Say which one.` | (fact only, keep) |
| 103 | cap refusal rewrite, `rewriteCapRefusal`, :974-978 | `Sam Patel would be over the cap today (92% of 85%). Nothing changed.` | already in register — keep |
| 104 | `whichPartBase`/`more` tail, :3499-3503 | `Which part? Cell 3 makes: … and more — say the part.` | (fact only, keep) |

Row count: **104** (more than the 60-90 estimate because several `describeQuestion` cases have 2-4
distinct branches and `CommandBar.tsx` keeps a second, slightly different copy of about ten of
`resolve.ts`'s own question texts — flagged above as an R-449 duplicate-control question for the
maintainer, not decided here).
