# S55-d — the bar expands before it resolves, and the board feeds the clock (R-404, R-406 to R-410, D130)

You are lane D of S55. You own `src/features/board/components/CommandBar.tsx`,
`src/features/board/BoardPage.tsx`, `src/features/board/lib/commandAssignments.ts`,
`src/test/commandBar.test.tsx` and `src/test/commandAssignments.test.ts` (create it if absent),
nothing else. Lanes A, B and C have landed: read the S55-a brief §1 (the names), the S55-b brief
(`docs/agent-briefs/s55-b-expand-brief.md`, `expandCommand`, the new `ResolveContext` fields and
question kinds) and `docs/design-plan.md` §19.101 (D130) and §19.98 (D127) first. Then read
`CommandBar.tsx`'s `runCommand`, `startLot`, `resolveLotStep`, `showLotStatus`,
`questionToStatus` and `BoardPage.tsx`'s `ctx` memo.

Run `npx vitest run src/test/commandBar.test.tsx src/test/commandAssignments.test.ts
src/test/boardPage*.test.tsx` (whatever exists) and `npx tsc --noEmit -p tsconfig.json`, which
must now be clean across the repo. Then `npx eslint src/features/board src/lib/command
src/lib/voice`. No full suite, no commits, no plan edits.

## 1. `BoardPage.tsx` — the context grows
- `nowMinuteOfDay`: from the same `now` the memo already computes `todayIndex` with — the minute
  of the day in the plant's zone (use the zone helpers `formatClock` is built on, in
  `./lib/time`; never `getHours()` on the local clock). `null` when `todayIndex` is null.
- `wallOf(offsetMin)`: the day index whose `axis.dayStarts` band holds `windowStart + offset`, and
  the wall-clock minute of that day in the zone, derived with the same helpers. A short pure
  helper in `lib/time.ts` or `lib/boardIndex.ts` is fine if one is needed; say which.
- `runs`: each `ContextRun` gains `productName` (the same `productViewFor` call the label uses)
  and `headcount` (the run's own field; find its name on the indexed run).
- `commandAssignments.ts`: `runId` on every `ContextAssignment` (the block's own `runId`, null
  when direct). Pin it in `commandAssignments.test.ts`.

## 2. `CommandBar.tsx` — expand first, once, for both paths
In `runCommand`, BEFORE the S51 several intercept:
```ts
const expanded = expandCommand(command, ctx);
if (!expanded.ok) { setStatus(questionToStatus(expanded.question, command)); return; }
```
and continue with `expanded.command` (a several → `startLot`; a single → the existing path). This
is the one place both the rules path and the model path land, so both expand the same way. The
`heldRef` holds the ORIGINAL sentence's command (the one a re-parse after a button press must
start from) — check what the re-run paths (`pickCandidate`, `pickExisting`, `pickAttach`) hand back
in and make sure an expanded lot's step answers substitute into the LOT (as S51 does), never into
the board form.

## 3. The new questions, in the bar's words (`questionToStatus`)
- `lot_too_big`: `That would be ${count} changes; say a smaller span — one cell, or one day.`
- `nothing_to_do`: a `readout`, not a question: the text as the resolver wrote it.
- `split_needed`: `${person}'s ${block} block on ${cell} runs across both sides of ${span}; say a span that reaches one end of it.`
- `swap_which`: `${person} has more than one block ${when}: ${blocks.join(", ")}. Say the hours.`
- `day_order`: `${second} is before ${first}; say the days the other way round.`
- `no_start`: `Say when it starts — "from 10", say.`
- `no_shift_at`: `No shift on ${cell} covers ${time}; it has ${shifts}.` (take the field names from
  lane B's report).
- `expand_first`: should never show; a plain sentence naming the intent.
No candidates on any of these; a cancel word or new typing clears them as any question.

## 4. The lot's status for a big lot
`showLotStatus` today lists every command; keep that for lots of up to 6 and, above it, list the
first 5 followed by `… and ${n - 5} more` — the existing CB-lot cases pin the small format and must
stay green. The "Do all N" button, the highlight list and `onRunLot` are unchanged. The lot's
`done` readout (`Done: N commands.`) is unchanged.

## 5. Tests (`commandBar.test.tsx`), CB-x-1 onward
Use a context fixture with two blocks on Cell 1 today and one on Cell 2, a run with a headcount,
`nowMinuteOfDay` set, a plain `wallOf`:
- CB-x-1 `clear Cell 1 today` → the lot's "2 commands ready" status, both blocks outlined, one
  yes → `onRunLot` receives two resolved removals in board order.
- CB-x-2 `cover Sam with Ana on Cell 1 today` → a lot of two (remove, then assign) whose assign
  resolved with the run target when Sam's block was in a run.
- CB-x-3 `same as yesterday for Cell 1` on a fixture where yesterday holds one block → a lot of
  one → the single-command path (a create), not a lot.
- CB-x-4 a `lot_too_big` fixture (build 101 blocks) → the message with the count; nothing runs.
- CB-x-5 `clear Cell 3 today` with nobody there → a readout, not a question, in the resolver's words.
- CB-x-6 the model path: `applyReading` with a decoded `replace` form lands in the same lot (the
  reader stub returns the form; the lot status appears).
- CB-x-7 a lot of 8 shows five and `… and 3 more`; a lot of 3 shows all three (the old format).
- CB-x-8 `assign Sam to Housing A on Cell 1 for the rest of the day` today at 10:07 → the readout
  shows a block from 10:15 (the resolver's rounding, through the bar).
Every existing case stays green unless a contract changed; write why beside any re-pin.

## 6. Report
What `nowMinuteOfDay` and `wallOf` are built from; any place the expanded lot and the S51 lot
behave differently and why; tsc/eslint results for the whole repo; the file's case count before and
after.
