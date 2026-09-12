# S43-a — fine-tuning the voice model on Google Colab

This is the maintainer's step-by-step for turning the training set (S42-a) into a scored
model. Written for someone who has never opened Colab. Background: `docs/voice-commands-plan.md`
("Is a small local model enough", "Stage 4"), `docs/agent-briefs/s43-a-first-model-brief.md`.

Nothing in the app changes from running this. No model is served until its score clears the bar.

## What the pieces are

| file                                    | what                                                                                                                        |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `scripts/voice/train/prepare.mjs`       | turns `data/voice/train.jsonl` and the committed `data/voice/heldout.jsonl` into the three files Colab needs                |
| `scripts/voice/train/system_prompt.txt` | the one system prompt — read by `prepare.mjs` and, through `manifest.json`, by the notebook; never retyped in either place  |
| `scripts/voice/train/train_qwen3.ipynb` | the Colab notebook that fine-tunes Qwen3 1.7B and scores it                                                                 |
| `scripts/voice/train/score_port.py`     | a Python port of `scripts/voice/score.mjs`'s arithmetic — the notebook's own table, and a standalone check you can run here |
| `scripts/voice/train/check_notebook.py` | pulls every code cell out of the notebook and checks it compiles — no GPU or Colab needed                                   |

## Steps

1. **On this machine:** `npm run voice:generate` (writes `data/voice/train.jsonl`, gitignored,
   4000 rows) then `npm run voice:prepare`. The folder `data/voice/colab/` now holds three files:
   `train.chat.jsonl`, `heldout.jsonl`, `manifest.json`. The command prints the manifest — check
   `trainRows` and `heldoutRows` look right, and note `ruleParserBaseline`: that is the number
   the trained model has to beat.

2. **Google Drive:** make a folder `scheduler-voice/data` and upload those three files there.

3. **Colab:** open `train_qwen3.ipynb` (File → Upload notebook). Also upload
   `scripts/voice/train/score_port.py` into the notebook's own file browser (the folder icon on
   the left, drag the file in, or use its upload button) — the scoring cell imports it from
   `/content/score_port.py` and fails with a plain message if it is missing. Then:
   Runtime → Change runtime type → T4 GPU, then Runtime → Run all. About an hour; the early
   cells print progress within seconds, training is the long step. If the session disconnects,
   run it again — the notebook writes everything to Drive, not to the Colab session, but there
   is no mid-training checkpoint resume in this version, so a disconnect during training means
   that pass restarts from the beginning.

4. **When it finishes**, download `predictions.jsonl` and `model-q4_k_m.gguf` from the run
   folder in Drive (`scheduler-voice/run-<timestamp>/`, the exact path is printed by the
   Settings cell and again by the last markdown cell) into `data/voice/runs/<timestamp>/`
   locally (gitignored).

5. **Score it here** — this is the number that counts, not the notebook's own printout:

   ```
   node scripts/voice/score.mjs --heldout data/voice/heldout.jsonl --predictions data/voice/runs/<timestamp>/predictions.jsonl --bar 0.95
   ```

   Paste the table to the developer session; it goes on S43's card.

6. **What "good" looks like:** clean at or above 95%; perturbed far above the rule parser's
   baseline (`ruleParserBaseline.perturbed` in the manifest — currently 3.5%; the plan expects
   90% or better on sentences shaped like the training ones). Below that, the developer session
   changes the settings cell or the data, not the board.

## What you can check without Colab, on this machine

- `npm run voice:prepare` runs end to end and prints a manifest.
- `npx vitest run src/test/voiceTrain.test.ts src/test/voiceData.test.ts` — the pure pieces
  (the chat-row format, the predictions-file round trip through `score.mjs`, the manifest's
  sample) and the training-set generator underneath it.
- `python -m py_compile scripts/voice/train/score_port.py` and
  `python scripts/voice/train/check_notebook.py` — every code cell in the notebook is
  syntactically valid Python, checked without `torch` or `transformers` installed (compilation
  checks syntax only; it does not run the cells or need the imports to resolve).
- `python scripts/voice/train/score_port.py data/voice/heldout.jsonl <a predictions file>`
  prints the same numbers as `npm run voice:score` on the same file — built and checked once,
  in the report for S43-a.

## What is NOT checked without a GPU

The training cells themselves — the model loads, the LoRA adapter trains, generation produces
usable JSON, the merge and GGUF export run, `llama-quantize` builds and runs — are **unverified
until the maintainer's first real run in Colab**. This lane has no GPU and cannot reach Colab.
Library APIs used (`SFTConfig(assistant_only_loss=True)`, `apply_chat_template(...,
enable_thinking=False)`, `dtype=` on `from_pretrained`) are believed current for the pinned
versions as of 12 Sept 2026 (see the install cell's comments and the S43-a report for how each
version was chosen), but "believed current" is not "run and passed". If a cell errors on first
run, that is expected findings work, not a sign the notebook was never tried — say what failed
and paste it back to the developer session.
