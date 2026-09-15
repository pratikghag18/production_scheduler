# S60-b — a sentence with no part asks which, from what the cell makes (R-422)

The maintainer, 15 Sept (session 174): "It can also ask what product if I don't give it one to
choose from the list of available products for the hierarchy level."

You own `src/lib/command/parse.ts`, `src/lib/command/resolve.ts`, `src/lib/voice/decode.ts`,
`src/features/board/components/CommandBar.tsx`, and their tests (`commandParse`, `commandResolve`,
`voiceRead`, `commandBar`). Read R-422 in `docs/plan.yaml`, R-418's nearest-name question
(`unknown` with `suggestions`) in resolve.ts and its rendering in the bar, and the grammar's
`no_product` failure.

1. **Grammar**: an assign or a booking whose sentence names a place and hours (or a shift) but
   no part ("assign Sam to Cell 1 from 8 to 4", "put Sam on Cell 1 for shift 2", "book Cell 2
   8 to 4 for 3 people") parses with `product: ""` instead of failing `no_product`; `no_product`
   stays for a sentence with nothing after the person at all. `formatCommand` prints such a form
   without a part ("assign Sam to Cell 1 from 08:00 to 16:00") and the round trip holds. Pin
   WP1–WP6 (assign, book, a shift form, the several list form with no part, `no_product` still
   fires for "assign Sam", a quoted place that looks like a part).
2. **Decoder**: `product` may be the empty string on assign, book and headcount (only there;
   F-149's letter-or-digit rule keeps applying to a NON-empty product). Pin.
3. **Resolver**: an empty product, or a product word that matches nothing and has no near name
   (R-418's floor), after the cell resolved: the question `{ kind: "unknown", field: "product",
   text, suggestions }` where `suggestions` are the parts offered at that cell (`ctx.offeredAt(cell.id)`
   mapped to names, board order, at most eight); more than eight → the first eight and a flag
   `more: true` so the bar can say "and more — say the part". With no offerings at all → the
   existing plain `unknown`. Pin RS-WP1–RS-WP5: empty product on a cell with three parts → three
   suggestions; a near-miss word still gets R-418's nearest names FIRST (the two lists are not
   merged — say why in a comment: a near name is a better guess than the whole menu); a cell with
   nine parts → eight and `more`; a cell with none → plain unknown; a suggestion's `word`
   re-resolves to exactly one part.
4. **The bar**: the message for an empty product: `Which part? Cell 1 makes: ` followed by the
   buttons (the existing suggestion rendering), and `… and more — say the part.` when flagged;
   a pick substitutes and re-runs (as today). Pin CB-wp-1..3 (typed sentence with no part →
   the buttons; a pick runs; more than eight shows the tail).
5. **Spelled digits** (the S59 reviewer, 15 Sept): a recogniser writes "Cell one" and "shift two"; the resolver's name normalisation (the one place, used by every match tier and by the nearest-name score) maps the words one to twenty, standing alone, to digits before comparing, so "Cell one" matches Cell 1 exactly and never ties with Cell 2. Pin NW1-NW3 in commandResolve.test.ts ("Cell one", "Operator A three" -> "Operator A3"? decide: only a standalone word becomes a digit, so "A three" becomes "A 3" and the space is dropped by the existing normalisation if it drops spaces -- read it and pin what is true; "one" inside "Stone Cell" is untouched).
6. **The model path**: the model was never taught a part-less sentence and will guess a part; the
   readout shows the guess before the yes, so nothing runs unseen. Say so in the bar's code
   comment and in your report; the sixth run's data will carry the shape (a note for S56's
   successor, not your work).
Run the four test files, `npx tsc --noEmit -p tsconfig.json`, `npx eslint src/lib/command src/lib/voice
src/features/board`. No commits, no plan edits. Report the decisions, re-pins, and counts.
