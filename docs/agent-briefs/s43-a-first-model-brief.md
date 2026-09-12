# S43-a — the first model: fine-tune Qwen3 1.7B on Colab and score it against the held-out set

_Brief for one Sonnet build lane. Written 12 Sept 2026 (session 152) by the developer session.
Plan entry: `docs/plan.yaml` S43 (now), R-392 (uncovered). Background: `docs/voice-commands-plan.md`
("Is a small local model enough", "How much training data", Stage 4, "Hardware, honestly"),
`docs/agent-briefs/s42-a-training-set-brief.md` (the data, the scorer), the CURRENT
`scripts/voice/score.mjs` (how `--predictions` reads rows by `id`), `scripts/voice/lib/form.mjs`
(`canonical`), `data/voice/heldout.jsonl` (a row's shape), and `src/lib/command/parse.ts`'s
exported `Command` union (the form the model must emit)._

## §1. What this is, in the product's words

The board reads four fixed sentences. The model sits in front of the bar as a translator:
whatever a person says, it answers with the strict form the board already reads, and nothing
else. This piece is the notebook that teaches it and the harness that scores it. The maintainer
chose the base model, Qwen3 1.7B, from a shortlist; the training runs on Google Colab's free
GPU because this machine has none. The maintainer presses run and brings back two things: a
predictions file the repo scores, and the compressed model file Stage 5 will serve.

Nothing in the app changes in this piece. No model is served until its score is recorded and
clears the bar.

## §2. The rules

- **The form is the parser's, byte for byte.** The model's target answer for a row is
  `canonical(row.form)` — the same sorted-key JSON `scripts/voice/lib/form.mjs` produces — and
  nothing else: no prose, no code fence, no "thinking". Qwen3 has a thinking mode; it is OFF in
  both training and inference (`enable_thinking=False` in the chat template call, and the
  generation is stopped at the first closing brace of a complete JSON object).
- **Scored only on rows it never saw.** The notebook trains on `train.jsonl` only, scores on
  `heldout.jsonl` only, and asserts before training that no sentence appears in both.
- **The repo's scorer is the judge.** The notebook writes `predictions.jsonl` with rows
  `{ "id": "<heldout id>", "form": <parsed JSON or null> }` for every held-out row; the
  maintainer runs `node scripts/voice/score.mjs --heldout data/voice/heldout.jsonl --predictions predictions.jsonl --bar 0.95`
  locally, and THAT table is the number recorded on S43's card. The notebook also prints its
  own table (a Python port of `score.mjs`'s arithmetic, per intent and per field) so the
  maintainer sees a result in Colab, but the repo's run is the one that counts.
- **Reproducible.** Fixed seeds everywhere (`torch`, `numpy`, `random`, the trainer), the
  hyper-parameters in one cell at the top, the versions of `transformers`, `peft`, `trl`,
  `datasets`, `accelerate` pinned to versions current in September 2026 that you can name
  from PyPI (say which and why; do not guess a version that may not exist — if you cannot
  verify, pin `>=` with the minimum the APIs you use appeared in and say so).
- **No dependency added to the repo.** The notebook installs its own in Colab. The repo gains
  Python files and a README, and one small vitest case; `package.json` gains one script.
- **Honest about what is verified.** You have no GPU and Colab is not reachable from a lane.
  What you CAN verify here: the data-prep step runs end to end on this machine and produces
  the chat-format file; the predictions format round-trips through `score.mjs`; the notebook
  is valid JSON and every code cell passes `python -m py_compile` (Python 3.14 is installed;
  `torch` and `transformers` are not, so import lines must be tolerated by the compile step —
  compile checks syntax only). Say in the README and the report that the training cells are
  unverified until the maintainer's first run.

## §3. Files

| file | what |
| --- | --- |
| `scripts/voice/train/prepare.mjs` | node: `--train data/voice/train.jsonl --heldout data/voice/heldout.jsonl --out data/voice/colab/` writes `train.chat.jsonl` (rows `{ "messages": [ {system}, {user: sentence}, {assistant: canonical(form)} ] }`), copies `heldout.jsonl`, writes `manifest.json` (row counts, seeds, the git sha, the `canonical` of one sample so the notebook can assert its own serialisation matches), and asserts train/held-out disjointness. `data/voice/colab/` is gitignored |
| `scripts/voice/train/system_prompt.txt` | the one system prompt, used by prepare and by the notebook (read, never retyped): "You turn one sentence about the production board into a JSON form. Answer with the JSON object only." plus the four intents' key lists in one short paragraph each |
| `scripts/voice/train/train_qwen3.ipynb` | the Colab notebook (§4) |
| `scripts/voice/train/score_port.py` | the Python port of `score.mjs`'s arithmetic (exact-match per field over the same field list), imported by the notebook and runnable standalone: `python score_port.py heldout.jsonl predictions.jsonl` |
| `scripts/voice/train/README.md` | the maintainer's step-by-step (§5), written for a person who has never opened Colab |
| `src/test/voiceTrain.test.ts` | VT1 `prepare.mjs`'s pure pieces: the chat row for a sample equals the system prompt + sentence + `canonical(form)`; VT2 a predictions file written for three held-out rows scores through the repo's `score` exactly as the rule parser's own answers do (build predictions from `parseCommand`, feed both paths, equal results); VT3 the manifest names a sample whose `canonical` matches `form.mjs` |
| `package.json` | `"voice:prepare": "node scripts/voice/train/prepare.mjs --train data/voice/train.jsonl --heldout data/voice/heldout.jsonl --out data/voice/colab"` |
| `.gitignore` | `data/voice/colab/` |

Keep `prepare.mjs`'s logic in `scripts/voice/train/lib/prepare.mjs` (pure, tested) with the CLI thin, as S42 did.

## §4. The notebook, cell by cell

1. **Title and the four things the maintainer must do** (upload two files, choose GPU, run all, download two files) — a markdown cell.
2. **Settings** — one code cell: `BASE_MODEL = "Qwen/Qwen3-1.7B"`, `SEED = 20260912`, `EPOCHS = 3`, `LR = 2e-4`, `LORA_R = 16`, `LORA_ALPHA = 32`, `LORA_DROPOUT = 0.05`, target modules the attention and MLP projections (`q_proj k_proj v_proj o_proj gate_proj up_proj down_proj`), `MAX_LEN = 512`, `BATCH = 8` with gradient accumulation to an effective 32, bf16 if the GPU supports it else fp16, `OUT_DIR = "/content/drive/MyDrive/scheduler-voice/run-<timestamp>"`.
3. **Install** — pinned versions; `llama.cpp` cloned for the converter; a cell that prints the GPU name and fails loudly with a plain sentence if there is none ("Runtime → Change runtime type → T4 GPU").
4. **Mount Drive and load data** — from `/content/drive/MyDrive/scheduler-voice/data/` (the maintainer uploads `train.chat.jsonl`, `heldout.jsonl`, `manifest.json` there); assert row counts against the manifest and disjointness of sentences.
5. **Tokenizer and base model** — load; apply the chat template with `enable_thinking=False`; assert the tokenised sample decodes back to the canonical JSON in the manifest.
6. **LoRA** — `peft.LoraConfig`; print trainable parameter count.
7. **Train** — `trl.SFTTrainer` on the chat rows, loss on the assistant turn only (use the trainer's completion-only / assistant-only masking; say which API), save the adapter to `OUT_DIR/adapter`.
8. **Predict on held-out** — greedy decoding, `max_new_tokens` 256, stop at the end of the first complete JSON object (a small helper that scans braces), parse; on any failure the row's form is `null`; write `OUT_DIR/predictions.jsonl`; print how many rows failed to parse.
9. **Score** — `score_port.py`'s table; print the rule parser's recorded baseline beside it (100.0% clean, 3.5% perturbed, from `manifest.json`) so the comparison is on screen.
10. **Merge and export** — merge the adapter into the base, save `OUT_DIR/merged/`, run `convert_hf_to_gguf.py` to f16, then `llama-quantize` to `Q4_K_M`; print the two file sizes.
11. **What to bring back** — a markdown cell: `predictions.jsonl` and `model-q4_k_m.gguf` from `OUT_DIR`, and the score line, to the developer session.

Every cell that can fail has one plain-sentence assertion message; no cell swallows an error.

## §5. The README's steps (write them; this is the maintainer's document)

1. On this machine: `npm run voice:generate` then `npm run voice:prepare`; the folder
   `data/voice/colab/` now holds three files.
2. Google Drive: make a folder `scheduler-voice/data` and upload those three files.
3. Colab: open `train_qwen3.ipynb` (File → Upload notebook), Runtime → Change runtime type → T4
   GPU, then Runtime → Run all. About an hour; the first cells print progress. If the session
   disconnects, run it again — the notebook saves to Drive, not to the session.
4. When it finishes, download `predictions.jsonl` and `model-q4_k_m.gguf` from the run folder
   in Drive into `data/voice/runs/<timestamp>/` locally (gitignored).
5. Score it here: `node scripts/voice/score.mjs --heldout data/voice/heldout.jsonl --predictions data/voice/runs/<timestamp>/predictions.jsonl --bar 0.95`.
   Paste the table to the developer session; it goes on S43's card.
6. What "good" looks like: clean at or above 95%; perturbed far above the rule parser's 3.5%
   (the plan expects 90% or better on sentences shaped like the training ones). Below that, the
   developer session changes the settings cell or the data, not the board.

## §6. Acceptance

1. `npm run voice:generate` (if `train.jsonl` is absent) and `npm run voice:prepare` run here;
   paste the manifest.
2. `npx vitest run src/test/voiceTrain.test.ts src/test/voiceData.test.ts` — counts copied.
3. `python -m py_compile scripts/voice/train/score_port.py` clean; a small script that extracts
   every code cell of the notebook to a temp `.py` and compiles it — clean; `python scripts/voice/train/score_port.py data/voice/heldout.jsonl <a predictions file you build from the rule parser via prepare's lib>` prints the same numbers as `npm run voice:score`.
4. `npx tsc -b --force`, eslint and prettier clean on the touched files; `npm run plan -- --check`
   untouched by you (do not edit the plan).
5. No full `npm run test`; no commit. Report as the other briefs' §8, and say plainly which
   cells are unverified.
