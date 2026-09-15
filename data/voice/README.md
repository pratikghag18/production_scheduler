# `data/voice/` — the voice-command training and test sets

S42-a (`docs/agent-briefs/s42-a-training-set-brief.md`), Stage 3 of
`docs/voice-commands-plan.md`. Two files, two very different lifecycles.

## `heldout.jsonl` — committed, generated ONCE, never regenerated

1000 rows: 100 per intent (assign, book, unassign, move, several — "several"
joined the other four at S50 — replace, swap, copy — the three
board-answered intents that joined at S56 — and split, headcount — the two
that joined at S58), half clean and half perturbed within each intent. Generated with a fixed seed so it is reproducible, but
the file itself — not the command that made it — is the source of truth
from here on:

```
node scripts/voice/generate.mjs --out data/voice/heldout.jsonl --n 400 --seed 20260915 --heldout
```

(the `--n` above is ignored for `--heldout`; the row count is fixed by
`generateHeldoutRows` itself, 50 clean + 50 perturbed per intent.)

Every model this project ever trains, including the rule parser itself, is
scored against this exact file (`npm run voice:score`). Regenerating it would
silently change what "the bar" means from one day to the next, which is the
one thing a held-out set may never do. `src/test/voiceData.test.ts`'s V4
re-parses every CLEAN row in the committed file with the CURRENT rule parser
on every test run — that is the test that goes red the day the grammar drifts
out from under this file, which is its job; a red V4 means come back here and
decide, in the open, whether to accept the drift (and regenerate, deliberately,
with a new seed and a plan entry saying so) or fix the grammar.

**Regenerated 14 Sept 2026 (session 168-169, S56, D130):** the whole file was
rebuilt from scratch on the new seed `20260915`, 100 rows per intent across
eight intents (up from five) — `replace`, `swap` and `copy` joined the
other five, and every existing intent's own templates gained the new
sentence shapes S55's grammar widening added (durations, the two "end of"
boundaries, time-of-day shift words, "everyone"/absence removals, a
place-less move of everyone). The old 14 Sept migration note (session 168,
S55, R-409: `until: null` added to every unassign form by hand, one row's
verb bug-fixed) is superseded by this regeneration — that migration was
explicitly a bridge until S56, not a new steady state.

**Regenerated again, same day, same seed (S56 review):** the reviewer of the
S56-a lane found three template bugs by hand-reading sampled rows and
checking every S55-a-brief sentence against what a template actually
produced (`src/test/voiceData.test.ts`'s V24/V25 now pin all three): A20
-time-of-day and U13-pull-time-of-day could draw "this night" (nobody says
that -- "tonight" is the word), and A14-duration never produced DU6's
"half an hour" or DU4's decimal "1.5 hours" even though the grammar has
parsed both since S55. Fixing the templates and regenerating on the SAME
seed (`data/voice/README.md`'s own rule: a template fix, not a grammar
drift, still needs a fresh file, but never a new seed for the same
regeneration) changed the row mix, which is why the perturbed baseline
below moved. Rule-parser baseline on this file: clean 400/400 (1.0),
perturbed 19/400 (0.0475) — see `data/voice/colab/manifest.json`'s
`ruleParserBaseline` for the number a trained model has to beat.

**Regenerated again, same seed (S58, D132, S56-b data brief):** two more intents,
`split` and `headcount`, joined the ten (R-413/R-415), and every existing move
template family gained an `adjust` field (R-412) — a re-time by one edge — plus
F-146's own "to midnight" writes DAY_END fix (found reviewing the first pass,
`scripts/voice/lib/time.mjs`'s own `buildTimePair`). Rule-parser baseline on this
file: clean 500/500 (1.0), perturbed 43/500 (0.086) — see
`data/voice/colab/manifest.json`'s `ruleParserBaseline` for the number a trained
model has to beat.

**Regenerated a fourth time, same seed (F-151, session 174, "six is the morning"):**
the full suite showed `parse.ts`'s own lone-edge workday rule (an hour 1-6 with no
am/pm reads pm) was wrong for a lone START -- every demo plant's Shift 1 starts at
06:00, so "from 6 for 8 hours"/"from 6 until end of shift" read 18:00, and this
file's own recorded rows for "from 6 ..." no longer parsed as recorded. New rule,
lone START only: hours 1-5 read pm, 6 through 12 stay as said; a lone END (the
removal grammar's "before 2"/"after 2", the adjust grammar's own end door) keeps
the old 1-to-6 range, unchanged. `scripts/voice/lib/time.mjs` gained
`applyLoneStartRule`/`resolveLoneStart`, the mirror of `parse.ts`'s own
`applyLoneStartRule`; every template that draws a lone start before a boundary or
a length (A14-duration, A16, A17, B9, and the move grammar's own edge-tail
template M15 when it draws the START edge) now computes its recorded form through
it instead of assuming the raw literal hour. The fifth (model-training) run's own
score (99.8% / 97.4%, session 173) stands against the file as it was at commit
`36b684d` -- this regeneration changes exactly the rows whose lone start was an
hour 1-6 with no am/pm (most visibly the "from 6 ..." rows LS6 itself pins), so
that score is not directly comparable to this file; the sixth run's data carries
this fix forward. Rule-parser baseline on this file: clean 500/500 (1.0),
perturbed 43/500 (0.086) — see `data/voice/colab/manifest.json`'s
`ruleParserBaseline` for the number a trained model has to beat.

## `train.jsonl` — gitignored, generated on demand

Not committed. Generate it with:

```
npm run voice:generate
```

(7000 rows, seed 1 — raised from 6000 at S58 so each of the now ten
intents keeps roughly the rows it had before split/headcount joined).
Every sentence in it is checked, at generation time,
against `heldout.jsonl` and dropped/retried on collision, so the two files
never share a sentence — training on a sentence the held-out set will later
test you on defeats the point of a held-out set.

## Row shape (both files), one JSON object per line

```
{ "id": string,
  "intent": "assign" | "book" | "unassign" | "move" | "several" | "replace" | "swap" | "copy" |
    "split" | "headcount",
  "sentence": string, "form": Command, "clean": boolean,
  "source": "<template id>" | "<template id>+<perturbation id>+..." }
```

`form` is always the CLEAN sentence's form, even on a perturbed row — a
perturbation is defined to never change what a sentence means (brief §2), so
a row's `form` is not owed to the parser, it is what the generator recorded
before perturbing.

## Regenerating `train.jsonl` on another seed

`npm run voice:generate` always writes seed 1. For a different seed or a
different `--n`, run `scripts/voice/generate.mjs` directly with `--out
data/voice/train.jsonl --seed <n>` — the `.gitignore` entry is on the path,
not the seed, so this stays untracked either way.
