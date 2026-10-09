# S58-e — a split's second half skips only its own block, not every block (R-413, D132)

Found by two S58 reviewers: `expandSplit` writes the second half's assign with `existing: {
kind: "separate" }` so the assign does not trip R-385's own-block question against the block it
is being cut from (which, before the lot's yes, still sits at full length in `ctx.assignments`).
But that answer skips the own-block check against EVERY overlapping block of the same person,
part and cell — a genuine second block is never asked about (pinned as CB-y-9 in
`src/test/commandBar.test.tsx`, currently pinning the wrong behaviour on purpose).

You own `src/lib/command/parse.ts`, `src/lib/command/resolve.ts`, `src/test/commandParse.test.ts`,
`src/test/commandResolve.test.ts`, `src/test/commandBar.test.tsx` (only CB-y-9 and one new case),
`src/lib/voice/decode.ts` and `src/test/voiceRead.test.ts` (only if the type change reaches them
— `existing` is forced null by the decoder, so it should not). Nothing else.

1. `parse.ts`: `Existing` gains a third member `{ kind: "separate_from"; assignmentId: string }`
   — "add a separate block, and the block with this id is the one I already know about". A
   comment names R-413 and this brief. `formatCommand` never prints `existing` (unchanged).
2. `resolve.ts`: in `resolveAssignCommand`'s own-block step, `separate_from` behaves like
   `null` EXCEPT that the block with that id is removed from `own` before the check; if other
   overlapping own blocks remain, `block_exists` is asked exactly as for a fresh sentence (the
   candidates and their ids as today); if none remain, the target is a fresh block as `separate`
   gives. `expandSplit` writes `separate_from` with the source block's id instead of `separate`.
   `pickExisting`-style answers from the bar (`retime`/`separate`) are untouched.
3. Tests: commandResolve SP9 (a split with a second overlapping block → the written assign, run
   through resolveCommand, asks block_exists naming the OTHER block only), SP10 (no other block →
   resolves fresh, as SP6); commandParse: the type round-trips through parse/format unchanged (a
   one-line case that `separate_from` on a parsed command is left alone by formatCommand);
   commandBar CB-y-9 re-pinned to the RIGHT behaviour (the lot's step asks about the other block,
   the answer substitutes, the lot completes) with the reason beside it.
4. Run `npx vitest run src/test/commandParse.test.ts src/test/commandResolve.test.ts
   src/test/commandBar.test.tsx src/test/voiceRead.test.ts src/test/commandPurity.test.ts`, `npx
   tsc --noEmit -p tsconfig.json`, `npx eslint src/lib/command src/features/board`. No commits,
   no plan edits. Report what changed and the case counts.
