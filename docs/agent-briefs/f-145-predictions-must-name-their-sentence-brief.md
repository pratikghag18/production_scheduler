# Brief F-145: a predictions file must say which sentences it answered

Finding F-145 (read it in `docs/plan.yaml`). No other lane is running.

## 1. What happened

The maintainer's fourth Colab run scored 20% clean: every single-sentence row wrong, every
compound row right, the intent right on all 714. The 400 single-row predictions answer
sentences that are not in the committed held-out file at all (the file was regenerated twice
on 14 Sept with the same seed and the same ids, and the Predict cell resumes by id from a
`predictions.jsonl` already on Drive), while the 100 compound rows were predicted fresh on the
current file and are right. The scorer joined the rows by id and had no way to notice.

## 2. What to build

1. **The notebook** `scripts/voice/train/train_qwen3.ipynb`, the Predict cell: every prediction
   row it writes carries `"sentence": <the row's sentence>` beside `id` and `form`. On resume
   (an existing `predictions.jsonl`), before skipping any id, read the existing rows and
   refuse to continue — a plain message naming F-145, the two first sentences, and the
   remedy (delete the file and run the cell again) — when any existing row's `sentence`
   differs from the held-out row with the same id, or when an existing row has no `sentence`
   at all (a file from before this change). Keep the per-row writing and the resume itself.
   `python scripts/voice/train/check_notebook.py` must pass.
2. **`scripts/voice/lib/score.mjs` / `scripts/voice/score.mjs`**: when a prediction row carries
   `sentence`, it must equal the held-out row's sentence; the first mismatch stops the run
   before any table is printed, with a message naming F-145, the id, both sentences, and
   "these predictions answered a different held-out file". A row without `sentence` is
   accepted (older files) but the summary prints one line `sentences not checked: N rows
   (predictions from before F-145)`. `scripts/voice/train/score_port.py` mirrors both
   behaviours byte for byte in intent.
3. **`scripts/voice/train/prepare.mjs` / the manifest**: nothing.
4. **The README** `scripts/voice/train/README.md`: in step 3, say that a re-run on a DIFFERENT
   held-out file must start from a deleted `predictions.jsonl`, and that the notebook now
   refuses to resume across files; in step 5, that the scorer checks the sentences.
5. **Tests**: `src/test/voiceData.test.ts` V18 (a predictions row whose sentence differs from
   the held-out row's makes the scorer throw with a message naming F-145 and the id; a row
   with the right sentence scores; a row without a sentence scores and is counted in the
   not-checked line), `src/test/voiceTrain.test.ts` (whatever it pins about the predictions
   round trip gains the `sentence` field; and the notebook's Predict cell text contains the
   refusal — grep the cell source for "F-145"). Run `npx vitest run src/test/voiceData.test.ts
   src/test/voiceTrain.test.ts src/test/voiceRead.test.ts`, `npx tsc --noEmit -p .`, eslint and
   prettier on your files, `python scripts/voice/train/check_notebook.py`, and
   `python scripts/voice/train/score_port.py data/voice/heldout.jsonl data/voice/runs/fourth-run/predictions.jsonl`
   (must now refuse with the F-145 message, since those predictions answered other sentences
   — this is the real file; do not modify it), and the same through
   `node scripts/voice/score.mjs --heldout data/voice/heldout.jsonl --predictions data/voice/runs/fourth-run/predictions.jsonl --bar 0.95`.
   Hmm: the fourth-run rows have no `sentence` field, so both scorers will accept them and
   print the not-checked line — say so, and ALSO build a scratch predictions file under
   `C:\Users\prati\.claude\jobs\0586b6d2\tmp\` with a wrong sentence to prove the refusal
   through both CLIs.

## 3. Rules

- Files you own: the notebook (`NotebookEdit` or a script over its JSON; keep every other cell
  byte-identical and say how you checked), `scripts/voice/lib/score.mjs`, `scripts/voice/score.mjs`
  if its printing changes, `scripts/voice/train/score_port.py`, `scripts/voice/train/README.md`,
  the two test files. Not the generator, not the held-out file, not `docs/plan.yaml`.
- No new dependencies. Do not run the full `npm run test`. Do not commit.
- Report: files with a line each; the refusal messages verbatim (notebook, score.mjs,
  score_port.py); each new test title; the runner summaries; the two CLI runs on the real file
  and on the scratch file; `git diff --stat`.
