# Brief F-143: the scorer's per-field tally is sensitive to key order; the row verdict is not

## What went wrong

`scripts/voice/lib/score.mjs`: the row verdict compares `canonical(normalizedPredicted)` with
`canonical(row.form)` (keys sorted recursively, from `lib/form.mjs`). The per-field tally a
few lines below compares `JSON.stringify(predicted[field]) === JSON.stringify(row.form[field])`,
raw, insertion order. A fine-tuned model writes keys alphabetically; the generator writes
`{"kind":"weekday","day":3}` and `{"start":{...},"end":{...}}`. So every day value with two
keys and every non-null span counts as wrong in the field table while the row itself counts as
right. Third training run, 13 Sept: clean 200/200 exact, yet the table said span 94/200 (47%)
and day 351/400 (87.8%). Both numbers are artefacts. `scripts/voice/train/score_port.py` line
~150 ports the raw `json.dumps` comparison deliberately ("to match") and so shares the bug.
Also: the field tally reads `predicted[field]`, not the normalised prediction; the time objects
inside a field may carry an extra key the model invented (F-140 normalisation strips those at
the top level and inside time objects) -- the tally should judge the same normalised value the
row verdict judges.

## What to change (and only this)

1. `scripts/voice/lib/score.mjs`: the per-field comparison uses `canonical()` on both sides and
   reads the field from `normalizedPredicted` (guarding null the same way `sameIntent` does).
   Update the comment block above `score()` that documents `byField` so it says the field is
   judged with the same key-order-blind comparison as the row.
2. `scripts/voice/train/score_port.py`: the same change, using its own `canonical()`; replace
   the "ported as plain json.dumps with no key sorting, to match" comment with the truth. The
   port must keep producing the same table as `score.mjs` for the same inputs.
3. Test, in `src/test/voiceData.test.ts` (find the existing `score` cases and add beside them):
   a row whose expected form has `day: {kind:"weekday", day:3}` and a non-null span, and a
   prediction that is the same form with every object's keys reversed in order (and one invented
   key inside a time object, to cover the normalisation path); assert the row is correct AND
   `byField.day` and `byField.span` count it correct. Add the mirror case: a prediction whose
   span END differs by one minute is correct in `day` and wrong in `span`, so the tally still
   discriminates. Then run `npx vitest run src/test/voiceData.test.ts` and paste the summary.
4. Python: run `python scripts/voice/train/score_port.py --help` or, if it has no CLI, a small
   inline check with the same two cases, and paste the output showing `day` and `span` counted
   correct. Remove the scratch file after.
5. `npm run voice:score` (rule-parser baseline over the committed held-out set): paste the
   Overall and By field blocks; the baseline's overall numbers must be unchanged (clean 200/200,
   perturbed 7/200). If a by-field number changes, say which and why.

## Rules

- Files you own: `scripts/voice/lib/score.mjs`, `scripts/voice/train/score_port.py`,
  `src/test/voiceData.test.ts`. Nothing else; not `docs/plan.yaml`, not the notebook.
- Do not run the full `npm run test`; run only the file named above. Do not commit.
- `npx prettier --check` and `npx eslint` on the two JS/TS files you touch; fix what they flag.
- Report: the diff of each file as plain text, the vitest summary line, the Python check
  output, the `npm run voice:score` blocks, `git diff --stat`.
