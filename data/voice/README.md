# `data/voice/` — the voice-command training and test sets

S42-a (`docs/agent-briefs/s42-a-training-set-brief.md`), Stage 3 of
`docs/voice-commands-plan.md`. Two files, two very different lifecycles.

## `heldout.jsonl` — committed, generated ONCE, never regenerated

400 rows: 100 per intent (assign, book, unassign, move), half clean and half
perturbed within each intent. Generated with a fixed seed so it is
reproducible, but the file itself — not the command that made it — is the
source of truth from here on:

```
node scripts/voice/generate.mjs --out data/voice/heldout.jsonl --n 400 --seed 20260911 --heldout
```

Every model this project ever trains, including the rule parser itself, is
scored against this exact file (`npm run voice:score`). Regenerating it would
silently change what "the bar" means from one day to the next, which is the
one thing a held-out set may never do. `src/test/voiceData.test.ts`'s V4
re-parses every CLEAN row in the committed file with the CURRENT rule parser
on every test run — that is the test that goes red the day the grammar drifts
out from under this file, which is its job; a red V4 means come back here and
decide, in the open, whether to accept the drift (and regenerate, deliberately,
with a new seed and a plan entry saying so) or fix the grammar.

## `train.jsonl` — gitignored, generated on demand

Not committed. Generate it with:

```
npm run voice:generate
```

(4000 rows, seed 1). Every sentence in it is checked, at generation time,
against `heldout.jsonl` and dropped/retried on collision, so the two files
never share a sentence — training on a sentence the held-out set will later
test you on defeats the point of a held-out set.

## Row shape (both files), one JSON object per line

```
{ "id": string, "intent": "assign" | "book" | "unassign" | "move",
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
