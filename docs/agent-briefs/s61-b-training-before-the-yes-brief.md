# S61-b — training before the yes; a day-less sentence when today is off the board (R-425, F-155, F-156)

Read `docs/plan.yaml`: R-425, F-155, F-156, F-154; `certificateGaps` and `readEligibilityPolicy`
in `src/features/board/lib/boardIndex.ts` (the server's rule, transcribed — F-087); how
`BoardPage.tsx` builds `requiredSkills` for a node (R-331) and hands the pop-up its verdict;
how `createFromCommand` in `useDragGesture.ts` carries an `eligibilityOverride` and reason
today. You own `src/lib/command/resolve.ts`, `src/test/commandResolve.test.ts`, and in
`src/features/board/BoardPage.tsx` ONLY the `commandCtx` useMemo (the block that builds the
`ResolveContext`). Another lane edits the same file's render part at the same time: use the
Edit tool with small anchors, never Write the whole file, re-read before each edit.

1. **`ResolveContext` gains `certificateGaps(operatorId, nodeId, endMin): { skill: string;
   state: "never-trained" | "lapsed" }[]` and `eligibilityPolicy(nodeId): "warn" | "block"`.**
   BoardPage feeds both from the SAME helpers the create pop-up uses (`certificateGaps`, the
   node's required skills up its path, `readEligibilityPolicy` of the node's settings), with
   `windowEnd` = the instant of `endMin` on the window (`addMinutes(index.windowStart, endMin)`),
   never a second copy of the rule. The resolver imports nothing (commandPurity).
2. **The question, before anything is written.** Every resolved write that puts a person on a
   cell — assign (single, shift form, job attach), move to another cell, replace's new block,
   swap's two new blocks, copy's blocks, the lot's members — asks first. New question kind
   `{ kind: "not_certified"; person; cell; missing: string[]; policy: "warn" | "block"; inLot:
   boolean }` where `missing` names the skills ("Welding", or "Welding (lapsed)"). For a
   single under `warn`: the bar (the other lane wires the text; you define the shape and pin
   the resolver) will say `Tom Baker is not certified for Cell 1: missing Welding. Say the
   reason to schedule anyway, or no.` and the reason typed next becomes the write's
   `eligibilityOverride: true, overrideReason`. Define on `ResolvedAssign` (and the move) an
   `override?: { reason: string }` field the bar fills before calling the writer; the writer
   side (`createFromCommand`'s input) is NOT yours — say in the report exactly which input
   field must carry it. Under `block`: the question with `policy: "block"` and no reason
   offered. Inside a lot (`inLot: true`): the expansion itself returns the question for the
   FIRST uncertified member before the lot's yes — a lot never asks a reason, never writes
   half of itself (R-425).
3. **F-156.** `resolveDay(null)` returns `ctx.todayIndex ?? 0`. A sentence with no day means
   today: when `todayIndex` is null, return `day_off_board` with text "today", the same
   question a spoken "today" gets. Grep for every other `?? 0` on `todayIndex` and treat each
   the same; list them.
4. **Pins** in `commandResolve.test.ts` with a ctx builder that carries a `certificateGaps`
   fake keyed by operator+node: NC1 assign an uncertified person → `not_certified` warn with
   the skill names; NC2 the same under block; NC3 a certified person → no question; NC4 a
   lapsed certificate → "(lapsed)"; NC5 a swap where the second new block is uncertified →
   the question, nothing resolved; NC6 a replace; NC7 a copy of a day with one uncertified
   member → the question names them (a copy is a lot); NC8 `resolveDay(null)` with todayIndex
   null → `day_off_board` "today"; NC9 the override field present on a resolved single when
   the ctx says the reason was given (however you model that: a `command.override` on the
   grammar? no — the bar re-resolves with the reason; model it as a resolver option
   `{ overrideReason }` on `resolveCommand` and pin that it suppresses the question and fills
   the field).

Run `npx vitest run src/test/commandResolve.test.ts src/test/commandPurity.test.ts`, `npx tsc
--noEmit -p tsconfig.json`, `npx eslint src/lib/command src/features/board/BoardPage.tsx`, `npx
prettier --check` on your files. No commits, no plan edits. Report: the exact `ResolveContext`
additions, the question shape, the `override` field and the writer input it must reach, the
`?? 0` sites, the pins, the totals.
