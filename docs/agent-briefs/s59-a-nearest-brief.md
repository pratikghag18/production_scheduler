# S59-a — a word that matches nothing offers the nearest names (R-418, D133 item 1)

You own `src/lib/command/resolve.ts` and `src/test/commandResolve.test.ts` only. Read
`docs/design-plan.md` §19.104 (D133), then `matchName`, `resolvePersonStep`, `resolvePartStep`
(the product lookup that answers `{ kind: "unknown", field: "product" }`), `resolveCellStep`, and
the `ambiguous` question with its `Candidate` shape (label, word, and whatever the bar
substitutes) in resolve.ts. `resolve.ts` imports only types. Run only `npx vitest run
src/test/commandResolve.test.ts` and `npx tsc --noEmit -p tsconfig.json`. No commits, no plan edits.

1. **Plural tolerance in `matchName`**: after the exact, starts-with and contains passes find
   nothing, try the word with one trailing "s" (or "es") removed, and the word with an "s" added
   — the same three passes. "Common Fasteners" finds Common Fastener; "Bracket" still finds
   Bracket A and Bracket B (a starts-with today). Pin both.
2. **Nearest names**: a pure `nearestNames(word, names): string[]` — up to four, ranked by a
   closeness score of your choice that is explainable in one sentence (say which: a Dice
   coefficient over letter bigrams of the normalised strings, plus a bonus for a shared prefix
   of three letters or more, is enough), with a floor below which nothing is offered (the score
   at which "Housing Pay" offers Housing A but "xyzzy" offers nothing — pin the floor with both).
3. **The question**: `{ kind: "unknown"; field; text }` gains an optional `suggestions?:
   Candidate[]` — the same `Candidate` shape the `ambiguous` question uses, so the bar's existing
   candidate buttons render them and `pickCandidate` substitutes the name and re-runs (read how
   the bar substitutes an ambiguous pick — by `word` into the field named — and give each
   suggestion the same `word`). Products, people (display name, then employee ref) and places
   (track cells' names, then every node's) all offer suggestions. The message text is the bar's
   (lane B): you supply the fields. When no name is close enough, `suggestions` is absent and the
   question is byte-identical to today's.
4. Tests, NN1 onward: the plural passes; "Housing Pay" → [Housing A, Housing B, Housing C] in a
   fixture with all three, and only Housing A when only it exists; "Common Fasteners" resolves
   without a question (the plural pass wins first); "Operator A" (a prefix) still resolves as an
   ambiguous list, not a suggestion; "xyzzy" → no suggestions; a person ("Opertor A3") → the
   suggestion Operator A3; a place ("Sell 1") → Cell 1; the suggestions' `word` re-resolves to
   exactly one thing when fed back through `resolveCommand`. Every existing case stays green.
Report: the score and floor you chose, the fields added, case counts, tsc outside your files.
