# Brief S50-b: the data follows the grammar — templates, prompt, schema, decoder, scorer, held-out

Stage S50, requirement R-399 (read it in `docs/plan.yaml`; its claim is the contract), design
§19.97 (D126). Lane S50-a (the grammar) is done and committed: `parseCommand` reads a
place-less removal or move (`place: []`) and a several (`{intent:"several", commands:[...]}`,
inner commands complete single forms). Read `docs/agent-briefs/s50-a-grammar-brief.md` for the
exact shapes and the list rules (pairs, one-to-many, mismatch). No other lane is running.

## 1. What exists (read first)

- `scripts/voice/lib/templates.mjs` — one template per sentence shape: `id`, `intent`,
  `genSlots(rng)`, `sentence(slots)`, `form(slots)`; verbs drawn from `parse.ts`'s exported
  lists (R-391); `baseCommand`. `scripts/voice/lib/rows.mjs` — `buildClean` asserts the
  rule-parser oracle on EVERY clean sentence (`OracleMismatchError`); `generateHeldoutRows`
  writes 100 rows per intent in `INTENTS` (50 clean, 50 perturbed, templates cycled);
  `generateTrainingRows` picks templates at random. `scripts/voice/lib/perturb.mjs` — the
  perturbations (typos, speech artefacts) with `perturbedRowForm`. `scripts/voice/lib/pools.mjs`.
- `scripts/voice/lib/score.mjs` — the verdict compares canonical forms; the by-intent and
  by-field tallies (F-143: key-order blind); `scripts/voice/train/score_port.py` mirrors it
  and must keep mirroring it. `scripts/voice/lib/form.mjs` — `canonical`, `equalForms`.
- `scripts/voice/train/system_prompt.txt` — the one prompt, read by `prepare.mjs` and the
  notebook (never retyped), and by the app (`readSentence.ts` imports it `?raw`).
- `scripts/voice/serve/form.schema.json` — the grammar the service enforces: top-level
  `oneOf` of four object branches, `additionalProperties:false`, every `properties` object
  alphabetical (VR8 pins that, at every depth), `$defs` clock_time/day_word/span.
- `src/lib/voice/decode.ts` — `decodeCommand(unknown): Command | null`; ignores extra keys,
  forces `attach`/`existing` null; S49 accepts `place: []` for unassign/move; refuses a move
  with neither `toPlace` nor `span`. `src/lib/voice/readSentence.ts` — the request body
  (`max_tokens: 256`, `response_format` json_schema from the file above).
- `data/voice/heldout.jsonl` — 400 rows, committed, the reference set; `src/test/voiceData.test.ts`
  V4 pins "400 rows, 100/intent, half clean/intent, clean rows parse today", V6/V13 pin the
  rule parser's baseline on it (1.0 clean, well below 0.5 perturbed), V7 disjointness, V9 verbs.
  `src/test/voiceRead.test.ts` VR1–VR9 (decoder, reader, schema). `src/test/voiceTrain.test.ts`
  (the notebook and prepare checks — read what it pins about row counts).
- The notebook `scripts/voice/train/train_qwen3.ipynb` asserts every training example is
  under `MAX_LEN = 1024` tokens measured with the real tokenizer (F-142); the prompt alone is
  ~470–526 tokens and a single form ~100–130. A several of three is the longest example
  the set may contain; keep lists to two or three items so the assertion holds.

## 2. What to build

1. **Templates** (`templates.mjs`), each checked by the oracle like every other:
   - Unassign, no place: `U8-no-place-day` (`${verb} ${op} ${day}`), `U9-no-place-hours`
     (`${verb} ${op} from ${span}`), `U10-no-place-bare` (`${verb} ${op}`), forms with
     `place: []`.
   - Move, no place: `M7-no-place-hours` (`${verb} ${op} to ${span}` where the span uses the
     grammar's "to <time> to <time>" or "from <time> to <time>" shape — check which the
     parser reads after S50-a and use both if both parse), `M8-no-place-day-hours`,
     `M9-no-place-cell` (`${verb} ${op} to ${cell2}`).
   - Several: `S1-two-people-one-cell` (assign; `${verb} ${op1} and ${op2} to ${part} on
     ${cell} from ${span}`), `S2-one-person-two-cells`, `S3-pairs` (the maintainer's
     sentence shape: two people, two cells, a line qualifier, a day, hours), `S4-three-people-
     one-cell` (`${op1}, ${op2} and ${op3}`), `S5-remove-two` (unassign two people from a
     cell), `S6-book-two-cells` (book on two cells). Slots must draw DISTINCT names for a
     list (no `A2 and A2`). Forms are `{intent:"several", commands:[...]}` built from
     `baseCommand`. Add `"several"` to `INTENTS` in `rows.mjs` so the held-out set gains 100
     rows of it (50/50) — it becomes 500 rows.
   - Perturbations: `perturb.mjs` must not break a several's structure — check that no
     perturbation rewrites the word "and" or the commas between names (add "and" to whatever
     keyword-avoid list the spell perturbations use, if there is one), and that
     `perturbedRowForm` needs no change (the form is the clean sentence's, whatever the ids).
2. **The held-out set.** `npm run voice:generate -- --heldout` (read `generate.mjs` for the
   exact flags; the seed stays what it is) regenerates `data/voice/heldout.jsonl` to 500 rows.
   Commit-ready: it is the new reference. Then `npm run voice:generate` (the training set,
   gitignored) must run clean — no oracle mismatch. Update V4 to 500 rows / 5 intents, and
   re-pin V6/V13's baseline numbers by READING the runner (the rule parser should still be
   1.0 clean by construction; the perturbed number will move — record the new one).
3. **The prompt** (`system_prompt.txt`): add to unassign and move that `place` is an empty
   array when the sentence names no place ("the board finds the block"); add a `several`
   paragraph: `{"intent":"several","commands":[...]}` when one sentence names several people
   or several places, one complete form per person-and-place pair, the pairing rules in one
   sentence each; keep every existing sentence of the prompt as it is. The notebook reads
   the prompt through the manifest — no notebook change needed; check `voiceTrain.test.ts`.
4. **The schema** (`form.schema.json`): move the four branches into `$defs` (`assign`,
   `book`, `unassign`, `move`), keep the top-level `oneOf` referencing them plus a fifth
   branch `{type:"object", additionalProperties:false, properties:{commands:{type:"array",
   minItems:2, maxItems:3, items:{oneOf:[the four $refs]}}, intent:{const:"several"}},
   required:["commands","intent"]}`; `place` for unassign and move becomes `minItems: 0`
   (or drop the constraint); every `properties` object alphabetical (VR8). Then
   `readSentence.ts`: `max_tokens` 256 → 640 (a several of three must fit; say what you
   measured with the probe on the served model — the CURRENT model will not emit a several,
   so measure a single form's length and multiply). `scripts/voice/serve/probe.mjs` uses the
   same file; check it needs nothing else.
5. **The decoder** (`decode.ts`): `intent:"several"` → decode each inner object with the
   existing single decoders; any inner failure → null (the whole form is garbled); fewer than
   two inner commands → null; an inner `several` → null. Extra keys ignored as today.
6. **The scorer** (`score.mjs` AND `score_port.py`, mirrored): the row verdict already works
   (canonical deep-equality); the by-field tally iterates `Object.keys(row.form)` — for a
   several that is `commands` and `intent`, which is fine, but ADD a by-field tally of the
   INNER commands' fields when both sides are several with the same count (so `place` and
   `span` keep their diagnostic meaning); document it in both files' comments. Add V14
   (several: exact match scores 1; one inner field wrong is wrong for the row and tallied
   under that field; a different count is wrong and tallies nothing inner) to `voiceData.test.ts`
   and mirror it in the Python port's own check if it has one (read `voiceTrain.test.ts`).
7. **Tests**: `voiceData.test.ts` V4/V6/V13 re-pinned, V2 covers the new templates by
   itself (it walks every template), V14 new; `voiceRead.test.ts` VR10 (decode a several of
   two; refuse one inner malformed; refuse one of one; refuse nested), VR11 (the schema's
   fifth branch: `intent` const several, `commands` items are the four `$defs`; `place`
   minItems 0 for unassign and move; VR8 still passes). Run `npx vitest run
   src/test/voiceData.test.ts src/test/voiceRead.test.ts src/test/voiceTrain.test.ts
   src/test/commandParse.test.ts src/test/commandPurity.test.ts`, `npx tsc --noEmit -p .`,
   eslint and prettier on your files, `python scripts/voice/train/check_notebook.py` if the
   notebook was touched (it should not be), and `node scripts/voice/train/prepare.mjs` per
   `package.json`'s `voice:prepare` to prove the manifest builds (report `trainRows`,
   `heldoutRows`, `ruleParserBaseline`).

## 3. Rules

- Files you own: `scripts/voice/lib/{templates,rows,perturb,score}.mjs` and their `.d.mts`
  if types change, `scripts/voice/train/{system_prompt.txt,score_port.py}`,
  `scripts/voice/serve/form.schema.json`, `src/lib/voice/{decode,readSentence}.ts`,
  `data/voice/heldout.jsonl`, `src/test/{voiceData,voiceRead,voiceTrain}.test.ts`. Not
  `parse.ts`, not `resolve.ts`, not the bar, not the notebook, not `docs/plan.yaml`.
- The oracle is the law: a template whose sentence the parser reads differently is a
  template bug (or a grammar gap to REPORT, not to patch in `parse.ts`).
- No new dependencies. Do not run the full `npm run test`. Do not commit.
- Report: the files with a line each; the new template ids with one example sentence each;
  the new held-out counts and the rule parser's new baseline (clean and perturbed, read from
  the runner); the `max_tokens` you chose and why; the prompt's added sentences verbatim;
  each new test title; vitest/tsc/lint summaries; the `voice:prepare` manifest lines;
  `git diff --stat`.
