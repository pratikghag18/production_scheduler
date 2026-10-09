# S42-a — the training set and the held-out test set (voice plan Stage 3)

_Brief for one Sonnet build lane and one Sonnet review lane. Written 11 Sept 2026 (session 147)
by the developer session, to be started once S41-c (move) is committed, because the generator's
oracle is the rule parser and the parser must know all four sentences first. Stage S42;
requirement R-390. Background: `docs/voice-commands-plan.md` ("How much training data" and
"Stage 3"), `p1-7a-typed-command-bar-brief.md` §3–§4 (the form and the assign grammar), and
the four briefs `p1-7a`, `s41-a`, `s41-b`, `s41-c` for the four grammars. Read the CURRENT
`src/lib/command/parse.ts` before writing a line: its exported `Command` union IS the form._

## §1. What this is, in the product's words

The small local model that will one day read free-form sentences has to be trained on
thousands of sentences with their correct forms, and judged on a few hundred it has never
seen. Nobody writes those by hand. A script combines sentence templates for the four commands
(assign, book a job, unassign, move) with realistic names, days and times, adds the
misspellings and speech-recognition slips people actually produce, and writes each sentence
beside the form it means. The **held-out set is the instrument**: it is committed to the repo,
never trained on, and every reader — the rule parser today, each model later — is scored
against it; a score below the bar fails the build the way a lost test file fails `npm run
test`. The rule parser's own score on it is the baseline any model must beat.

Not in this piece, flagged for the maintainer: the plan's "every sentence a person types into
the command bar is saved (with the site's permission) to grow both sets" is a product decision
— a table, a site setting, a privacy question — and is parked until they say so.

## §2. ⛔ THE RULES

- **The rule parser is the oracle for clean sentences.** Every sentence the generator emits
  from a template WITHOUT perturbation must parse with `parseCommand` to exactly the form the
  generator recorded; the generator asserts this on every row and exits non-zero on the first
  mismatch. A template the parser cannot read is a template bug, never a parser change made
  from here (the parser is S40/S41's; a real grammar gap becomes a finding, filed in the
  report, not a fix).
- **Perturbed sentences carry the clean sentence's form** and are NOT expected to parse with
  the rule parser; that gap is the whole reason for a model. The scorer reports the rule
  parser's rate on them as the baseline.
- **Deterministic.** A seeded pseudo-random generator (a small pure function in the script, no
  dependency) so `--seed 1` always writes the same file. The held-out set is generated ONCE
  with a fixed seed, committed, and never regenerated; the training set is generated on demand
  and NOT committed (`data/voice/train.jsonl` in `.gitignore`).
- **Disjoint.** No sentence string in the training set appears in the held-out set; the
  generator checks and drops collisions from the training side.
- **No dependency on the database or the app.** Names come from pools in the script, shaped
  like the demo world's (`Operator A1`, `Housing A`, `Cell 1`, `Line 1`, `Area 1`, `Plant A`)
  plus realistic person, part and place names (fifty or so each) so a model does not learn one
  plant's names. The resolver, not the model, matches names to records.
- **Pure pieces are testable.** Templates, pools, expansion, perturbation, serialization and
  scoring live in `scripts/voice/lib/*.mjs` as pure functions; `generate.mjs` and `score.mjs`
  are thin CLIs over them; `src/test/voiceData.test.ts` imports the lib the way
  `testerStack.test.ts` imports `scripts/lib/testerStack.mjs`.
- The script imports the parser as `../../src/lib/command/parse.ts` — Node 24 strips types by
  default and the purity audit guarantees the module has no runtime imports, which is exactly
  why `parse.ts` was kept dependency-free (D117).

## §3. Files

| file | what |
| --- | --- |
| `scripts/voice/lib/pools.mjs` | name pools: people (first+last, fifty), parts (fifty, some with digits, some with a slash, some containing a separator word), cells/lines/areas/plants (the demo shapes plus twenty more), day words, times |
| `scripts/voice/lib/templates.mjs` | the sentence templates per intent (§4), each a function of a filled slot set → sentence string, plus the slot set → form (`Command`) |
| `scripts/voice/lib/perturb.mjs` | the perturbation catalogue (§5), each a pure function sentence → sentence, and `perturbAll(sentence, rng, n)` |
| `scripts/voice/lib/rng.mjs` | `mulberry32(seed)` or equivalent, `pick`, `shuffle` |
| `scripts/voice/lib/form.mjs` | `canonical(form)` — JSON with sorted keys; `equalForms(a, b)` |
| `scripts/voice/lib/score.mjs` | `score(rows, predict)` → `{ clean: {n, correct}, perturbed: {n, correct}, byIntent, byField }` |
| `scripts/voice/generate.mjs` | CLI: `--out <file> --n <rows> --seed <s> [--heldout]`; asserts the oracle on every clean row; writes JSONL `{ id, intent, sentence, form, clean: boolean, source: "<template id>" | "<template id>+<perturbation ids>" }` |
| `scripts/voice/score.mjs` | CLI: `--heldout data/voice/heldout.jsonl [--predictions <file> | --rule-parser] --bar 0.95`; prints the table; exits 1 below the bar on CLEAN rows |
| `data/voice/heldout.jsonl` | committed, ~400 rows: 100 per intent, half clean and half perturbed, seed 20260911 |
| `data/voice/README.md` | what the files are, how to regenerate train, why held-out is never regenerated |
| `.gitignore` | `data/voice/train.jsonl` |
| `package.json` | scripts `voice:generate` (train, n=4000, seed 1) and `voice:score` (the rule parser against held-out) |
| `src/test/voiceData.test.ts` | §6 |

## §4. Templates — at least these, per intent (more is better; every one oracle-checked)

Assign (8+): the maintainer's own ("Assign {op} to work on {part} on {cell} in {line} from
{t1} to {t2}"), "put {op} on {part} at {cell} from {t1} to {t2}", "{op} to {part} on {cell},
{line}, {area} from {t1} to {t2}", with and without a verb, with a day word in each of its
forms (today, tomorrow, weekday, `on <iso>`), with am/pm, 24h, `noon`, `until`, a dash, a
quoted name. Book (6+): "Book {part} on {cell} in {line} from {t1} to {t2}", "run {part} at
{cell} for {n} people …", "book {part} on {cell} for {n} tomorrow from …". Unassign (6+): with
and without hours, `remove`/`clear`, `off`. Move (6+): to a cell, to hours, both, with a day.
Times: the afternoon rule must be exercised ("from 10 to 2") and so must explicit pm.

## §5. Perturbations — each a named pure function, composable, never changing the form

Spelling: drop a letter, double a letter, swap two adjacent letters — in a NAME (the common
case: names are fuzzy) and, as separate perturbation ids with a lower weight, in a KEYWORD
too, since a recognizer mishears "assign" as "a sign" and the model must survive that. Speech: "housing eh" for "Housing A", "sell
one" for "Cell 1", "to" → "two"/"too" inside a time, "ten" for "10", "a m"/"p m", missing
commas, "line one" for "Line 1". Case and spacing: all lower, all caps, doubled spaces, a
trailing period, no space after a comma. Filler: "please", "can you", "um" at the start;
"thanks" at the end. Each row's `source` names the template and the perturbation ids applied
(one to three per perturbed row).

## §6. Tests — `src/test/voiceData.test.ts`

- **V1** the RNG is deterministic: two generators with seed 7 produce the same first 100 picks.
- **V2** every template, filled with a fixed slot set, yields a sentence the rule parser parses
  to the template's own form (loop over all templates; the assertion names the template id).
- **V3** every perturbation applied to every template's clean sentence leaves the recorded
  form unchanged (the form is attached to the row, not re-derived — assert the row's `form`
  equals the clean row's `form`) and changes the sentence string.
- **V4** the committed `data/voice/heldout.jsonl` is valid JSONL, has 400 rows, 100 per intent,
  half clean per intent, and every CLEAN row still parses to its recorded form with the
  CURRENT parser (this is the case that goes red if the grammar drifts — that is its job).
- **V5** the scorer: a predictor that returns the recorded form scores 1.0; one that returns
  the form with one field wrong scores the right fraction; the per-field table names the field.
- **V6** the rule parser's baseline on held-out is 1.0 on clean rows and below 0.5 on perturbed
  rows (pin the actual number with a tolerance, so a perturbation catalogue that stops
  perturbing goes red).
- **V7** a generated training set (n=200, seed 1, in a temp dir) shares no sentence with
  held-out and is 50% clean ±10%.
- **V8** `canonical(form)` is stable under key order.

## §7. Acceptance

1. `node scripts/voice/generate.mjs --out data/voice/heldout.jsonl --n 400 --seed 20260911 --heldout`
   once; `npm run voice:generate` (train, 4000 rows) and `npm run voice:score` — paste the
   score table (clean 1.0 expected; the perturbed baseline is what it is).
2. `npx vitest run src/test/voiceData.test.ts` — count copied. `npx tsc -b --force` clean.
   `npx eslint scripts/voice src/test/voiceData.test.ts` clean (check `eslint.config.js`
   covers `.mjs`; if it does not, say so rather than widening it). Prettier clean on every
   touched file.
3. Mutations on scratch copies: X1 a template whose form records the wrong end hour → V2 red
   naming it; X2 a perturbation that also edits a keyword's form field → V3 red; X3 the scorer
   comparing only `intent` → V5 red; X4 held-out regenerated with another seed → V4 still green
   (the rows changed but every clean one still parses) — say so, and say why that is the
   correct outcome and what WOULD go red (a grammar drift).
4. No full `npm run test`; no commit.

## §8. Report — as before. Name every template id and every perturbation id.

## §9. The review lane

Break it: (1) read ten random held-out rows by hand — is the recorded form what the sentence
means to a person? Name any row where a human would disagree with the oracle (that is a
grammar finding, not a generator bug). (2) Apply X1 and X3; restore from copies. (3) Run
`npm run voice:score` and confirm the exit code is 0; then lower `--bar` to 1.01 and confirm it
is 1. (4) Report with one closing sentence.
