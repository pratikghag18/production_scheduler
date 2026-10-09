# Brief F-142: the notebook truncates every training example before the answer's tail

## What went wrong

`scripts/voice/train/train_qwen3.ipynb`: the Settings cell sets `MAX_LEN = 512` and the
training cell passes it as `SFTConfig(max_length=MAX_LEN)`. The system prompt alone is 450
tokens under Qwen3's tokenizer; a full prompt (system + user turn + the empty think block) is
470 to 526 tokens; the answers are 50 to 80 tokens and come last. Measured over all 4,000
training rows: the answer's `product` key survived the cut in 0 of 1,361 assign rows and 0 of
842 book rows; `start` in 0; `toPlace` in 197 of 771 move rows. Two training runs scored
`product` at 2.5% for exactly this reason. The trainer's assistant-only loss was fine (TRL
patches Qwen3's template itself); the loss reached 0.005 over the twenty-odd easy tokens per
row that survived.

## What to change (and only this)

1. Settings cell: `MAX_LEN = 1024`. Replace its comment with one that says the longest training
   conversation is about 610 tokens and that 512 cut the answer off (F-142), so the number must
   stay above the measured maximum printed by the data cell.
2. The cell that loads `train_chat_rows` and does the chat-template round trip (the one that
   prints "chat-template round trip OK"): after that check, tokenise every training
   conversation in full with
   `tokenizer.apply_chat_template(row["messages"], tokenize=True, add_generation_prompt=False)`
   (this is what the trainer sees), collect the lengths, print
   `training conversations: median N tokens, longest M tokens, MAX_LEN=...`, and
   `assert max_len_seen < MAX_LEN` with a message that names F-142 and says the answer would be
   truncated. If `apply_chat_template(..., tokenize=True)` returns a dict in transformers 5.x,
   take `["input_ids"]`; write it so both return shapes work. 4,000 rows tokenise in a few
   seconds; no progress print needed.
3. `scripts/voice/train/README.md`: in the numbered first-run findings paragraph area, add a
   short paragraph for F-142 (what the cut did, that the data cell now measures and refuses).
   Also, in the "second run" / retrain instructions, say the adapter AND the checkpoints folder
   under the run folder on Drive must be deleted before a retrain, since the resume logic would
   otherwise pick up a checkpoint trained under the old cut. Keep the batch note as it is.
4. Run `python scripts/voice/train/check_notebook.py` and paste its output in your report.

## Rules

- Edit the notebook JSON in place with a small python script that asserts on the exact lines it
  replaces; do not rewrite the file wholesale. Every other cell must be byte-identical
  afterwards: confirm with `git diff --stat` and say so.
- Files you own: `scripts/voice/train/train_qwen3.ipynb`, `scripts/voice/train/README.md`.
  Nothing else; not `docs/plan.yaml`.
- Do not run `npm run test`. Do not commit.
- Report: the changed lines of each edited cell as plain text, the README paragraphs, the
  check_notebook output, the `git diff --stat` line.
