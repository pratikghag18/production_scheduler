# Brief S49-a: a wrong or missing cell offers the person's blocks elsewhere

Stage S49, requirement R-397 (read it in `docs/plan.yaml`; its claim is the contract), design
§19.96 (D125), finding F-144. No other lane is running. The command bar, the launcher, the
reader and the rule grammar do not change.

## 1. What exists (read first)

- `src/lib/command/resolve.ts`: `resolveUnassignCommand` (line ~853) and `resolveMoveCommand`
  (~953). Both resolve the cell (`resolveCellStep`), the person, the day/span, then filter
  `ctx.assignments` by `nodeId === cell.id && operatorId === operator.id && overlaps`. Empty
  hits are `no_block`; the answer (`command.existing`) is looked up among those hits only, and a
  miss with no hits is `block_gone_remove` (removal) or a re-ask (move). A move with exactly
  one hit takes it without asking; a removal always asks (`remove_which`, one candidate gets
  the bar's yes suffix). `Candidate` has `id`, `label`, `word`, `part?`. `Question` kinds
  `remove_which`, `move_which`, `no_block` and `describeQuestion` (~1121) write the messages.
  `ResolvedMove.nodeId` is the TARGET node (the source cell for a `retime`).
- `src/lib/command/parse.ts`: `UnassignCommand.place` and `MoveCommand.place` are `string[]`
  documented "at least one". The rule grammar refuses a sentence without a place
  (`no_place`); leave the grammar alone.
- `src/lib/voice/decode.ts`: `decodeUnassign`/`decodeMove` require `isNonEmptyStringArray(place)`.
- `src/features/board/components/CommandBar.tsx` `questionToStatus` (~575): `remove_which`
  with one block becomes a "Remove it" button with the yes suffix and the outline; several
  become `Remove <label>` buttons; `move_which` becomes `Move <label>` buttons (it has no
  one-block branch because a move never asked for one — after this brief it can, and
  `withBlockHighlight` already adds the yes suffix for exactly one candidate, so the branch
  works as is; you may add a "Move it" label for the one-block case, nothing more).
- Tests: `src/test/commandResolve.test.ts` (fixtures: `c1a` Cell 1 in Line 1, `c2` Cell 2,
  `c1b` Cell 1 in Line 3; `blk1`, `blk2`, `blkC2` = blk1 on c2, `blkSp` another person;
  `unassignCmd()`, `moveCmd()`, `withBlocks()`), `src/test/commandBar.test.tsx` (`renderBar`,
  `BLK1`, `BLK2`, the CB-yes cases), `src/test/voiceRead.test.ts` (VR1–VR8).

## 2. What to build

1. **Resolver, both paths.** After the hits on the named cell come back empty, gather
   `elsewhere`: the person's blocks overlapping the same window (the sentence's hours for a
   removal, the whole day for a move — exactly the window the hits used) on ANY cell in
   `ctx.assignments`. Then:
   - hits non-empty: everything exactly as today (RU1–RU10, RM1–RM10 must not change).
   - hits empty, elsewhere empty: `no_block` as today.
   - hits empty, elsewhere non-empty: ask `remove_which` / `move_which` with the elsewhere
     blocks as candidates, in board order (`ctx.assignments` order). A move asks even for
     ONE such block. The question carries a new optional field `elsewhere: true`, and `cell`
     stays the cell the sentence named. Each candidate's `label` is `"<cell name> · <part>
     <hours>"` (cell name from `ctx.nodeById.get(x.nodeId)`), and the candidate gains an
     optional `cell?: string` and `when?: string` (the bare hours, `x.label`) so
     `describeQuestion` never parses a label apart.
   - `move_which` gains an optional `destination?: string` set ONLY in the elsewhere case:
     the sentence's `toPlace` words joined with `" in "` and/or the sentence's span as
     `"HH:MM–HH:MM"`, joined by `" · "` (`"Cell 2 · 20:00–23:00"`, `"Cell 2"`,
     `"20:00–23:00"`). Build the span text with the same helper the arrow uses; do not
     resolve the destination cell here (that still happens after the block is chosen, so
     `not_offered` and `unknown` come as today).
   - The answer: look `command.existing.assignmentId` up in hits, then in elsewhere. A hit
     from elsewhere is used like any other; the readout's chain and a `retime`'s `nodeId`
     come from the BLOCK's cell (`blk.nodeId`), never the sentence's. A stale answer re-asks
     with the current candidates (hits if any, else elsewhere), else `block_gone_remove` /
     the existing move behaviour.
2. **An empty place.** `resolveUnassignCommand` and `resolveMoveCommand` accept `place: []`:
   skip the cell step, hits is empty by definition, elsewhere is the person's blocks in the
   window on any cell. `no_block` then has `cell: null` (widen the type to `string | null`
   on `no_block`, `remove_which` and `move_which`). A removal with one block asks as always
   (`remove_which`, `elsewhere` NOT set — nothing was wrong); a move with exactly one block
   takes it; several ask with cell-named candidates. Update the two `place` doc comments in
   `parse.ts` ("at least one for an assign or a booking; may be empty for a removal or a
   move: wherever the person is") — no code change there.
3. **Messages** (`describeQuestion`; the bar renders an ISO `when` as "today" etc. by itself,
   so write `${q.when}` as today):
   - `remove_which`, elsewhere, one: `${person} has no block on ${cell} ${when}, but has one
     on ${c.cell}: ${c.part ?? "a"} block ${c.when}. Remove that one?` — write it as
     `"Operator 1 has no block on Cell 1 2026-09-03, but has one on Cell 2: Housing A 10:00–14:00. Remove that one?"`
     (with a known part: `<part> <hours>`; unknown part: `a block <hours>`).
   - `remove_which`, elsewhere, several: `${person} has no block on ${cell} ${when}, but has
     ${n} elsewhere. Remove which?`
   - `move_which`, elsewhere, one: `${person} has no block on ${cell} ${when}, but has one on
     ${c.cell}: ${part} ${hours}. Move that one to ${destination}?`
   - `move_which`, elsewhere, several: `... but has ${n} elsewhere. Move which to ${destination}?`
   - `no_block` with `cell: null`: `${person} has no block ${when}.`
   - `remove_which` with `cell: null`, one block: `Remove ${person}'s ${part} block on
     ${c.cell}, ${hours}?` (the existing one-block sentence, the block's own cell);
     several: `${person} has ${n} blocks ${when}. Remove which?`
   - `move_which` with `cell: null`: `${person} has ${n} blocks ${when}. Move which?`
   - Every existing message string stays byte-for-byte.
4. **Decoder.** `decodeUnassign` and `decodeMove` accept an empty array for `place` (still
   an array of non-empty strings); `decodeAssign` and `decodeBook` unchanged. Do not touch
   `scripts/voice/serve/form.schema.json` (the current model never writes an empty list; the
   retrain changes it).
5. **Tests.**
   - `src/test/commandResolve.test.ts`, a new `describe("commandResolve: S49 the block is
     elsewhere")`, cases RE1–RE12: RE1 removal with hours, wrong cell, one block elsewhere
     (`blkC2`) → `remove_which` with `elsewhere: true`, `cell: "Cell 1"`, the one candidate
     labelled `"Cell 2 · Housing A 10:00–14:00"` with `cell`/`when`/`part`, the message
     verbatim; RE2 the same whole-day; RE3 several elsewhere (blkC2 and a block on c1b) in
     board order, message verbatim; RE4 none anywhere (only `blkSp`) → `no_block` unchanged;
     RE5 the answer from elsewhere → ok, `assignmentId: "blkC2"`, readout chain names
     `Line 1 › Cell 2`; RE6 a stale answer re-asks with elsewhere, and `block_gone_remove`
     when nothing is anywhere; RE7 move in time, wrong cell, one block elsewhere → asks
     `move_which` with `destination: "10:00–14:00"`-style text, message verbatim; RE8 move
     in place with hours → `destination: "Cell 2 in Line 1 · 12:00–16:00"`; RE9 the answer
     from elsewhere for a retime → `nodeId` is `c2` (the block's cell), readout chain names
     Cell 2; RE10 a wrong-cell move with several elsewhere → `move_which`, all candidates;
     RE11 empty place: removal one block → plain `remove_which` (no `elsewhere`), `cell:
     null`, message `Remove Operator 1's Housing A block on Cell 1, 10:00–14:00?`; several →
     the `cell: null` message; none → `no_block` with `cell: null` and its message; RE12
     empty place: move with one block is taken (ok, retime on the block's cell), with two
     asks. Also assert RU1–RU10 and RM1–RM10 still pass unchanged (do not edit them).
   - `src/test/commandBar.test.tsx`, CB-else-1..4 as R-397's `verified_by` names them
     (`BLK1` is on which cell? read the fixture; put the block on another cell of the
     fixture's tree, or add a `BLK_C2` fixture): CB-else-1 a wrong-cell removal outlines the
     elsewhere block as kind `remove`, the message carries the yes suffix, yes + Enter calls
     `onUnassign` with that block's id; CB-else-2 a wrong-cell move in time with one block
     asks (no `onMove` call), the message contains the destination hours, yes calls
     `onMove` with the block's id and `target.kind === "retime"`; CB-else-3 several
     elsewhere blocks outline all and a bare yes answers "Which one? …"; CB-else-4 a
     right-cell removal behaves as CB-yes-1 (message has no "but has").
   - `src/test/voiceRead.test.ts` VR9: `decodeCommand` accepts `place: []` for unassign and
     move (returns the command with `place: []`) and returns null for assign and book with
     `place: []`.
   Run `npx vitest run src/test/commandResolve.test.ts src/test/commandBar.test.tsx
   src/test/voiceRead.test.ts src/test/commandPurity.test.ts src/test/commandAssignments.test.ts
   src/test/commandParse.test.ts`, then `npx tsc --noEmit -p .`, eslint and prettier on your
   files.

## 3. Rules

- Files you own: `src/lib/command/resolve.ts`, `src/lib/command/parse.ts` (doc comments only),
  `src/lib/voice/decode.ts`, `CommandBar.tsx` (at most the one-block "Move it" label; say if
  you did), the three test files. Not `docs/plan.yaml`, not the schema, not the generator.
- `src/lib/command/*.ts` stay free of runtime imports (commandPurity U1). No new dependencies.
  Do not run the full `npm run test`. Do not commit.
- Every rule the resolver applies comes from `ctx` (overlaps, the day axis); do not add a copy.
- Report: the files with a line each, each test title, the exact message strings you wrote,
  the vitest/tsc/lint summaries, `git diff --stat`.
