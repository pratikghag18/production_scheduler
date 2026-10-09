# F-147 — a saved adapter must name the data it was trained on, and a mismatch refuses

The fifth Colab run, 14 Sept (session 170): the notebook's Train cell found the FOURTH run's
adapter under `scheduler-voice/run-qwen3-1.7b/adapter` on Drive, printed "training skipped: a
trained adapter already exists", loaded it and went on to predict the fifth run's held-out set
with the fourth run's model. F-145 closed the same hole one folder over (the predictions file);
the adapter folder has the same shape: a fixed name, a resume-by-existence rule, and nothing that
says which data it came from.

You own `scripts/voice/train/train_qwen3.ipynb` (the Train cell, cell 6, and the Settings cell if a
constant belongs there), `scripts/voice/train/README.md`, `src/test/voiceTrain.test.ts`. Nothing
else. Edit the notebook with a node script under `C:/Users/prati/.claude/jobs/0586b6d2/tmp/`
that parses the JSON, changes `source` lines, and writes it back with the same indentation —
never by hand, never with PowerShell text tools. Keep every other cell byte-identical (`git diff`
must show only cell 6, and the Settings cell if used).

1. **After training**, beside `adapter_config.json`, write `adapter/trained-on.json` holding the
   manifest's identifying fields, read from the `manifest.json` the notebook already loads:
   `gitSha`, `trainRows`, `heldoutRows`, `seeds` (or whatever the manifest names them — read
   `scripts/voice/train/prepare.mjs` for the exact keys), and the sha256 of `train.chat.jsonl`
   computed in the notebook (hashlib, streamed).
2. **Before skipping training** because an adapter exists: read `trained-on.json`. Missing (an
   adapter from before this change) → refuse: print an F-147 message saying the adapter has no
   record of its data and must be deleted (name the folder) or, to knowingly reuse it, set
   `ALLOW_UNSTAMPED_ADAPTER = True` in the Settings cell, then `raise SystemExit`. Present but any
   field differs from the current manifest or the current training file's hash → refuse the same
   way, printing both sides field by field (the adapter's and the current), naming F-147, and
   `raise SystemExit`; no flag overrides a mismatch. Present and equal → the existing skip, with
   one line saying which data it matches.
3. The checkpoint-resume path (a half-finished run resuming from `checkpoints/`) has the same
   hole one level down: a checkpoint from a different data set. Stamp the checkpoints dir the same
   way when training starts (`checkpoints/trained-on.json` written before the first step) and
   refuse a resume whose stamp differs; a checkpoints dir with no stamp is refused too.
4. README: the "delete the adapter folder to force a fresh run" paragraph becomes: the notebook
   refuses an adapter or a checkpoint from other data on its own (F-147); the only reason to
   delete the folder now is to retrain on the SAME data.
5. `voiceTrain.test.ts`: VT8 — cell 6's source contains the stamp write, the read-and-compare
   before the skip, the SystemExit on mismatch and on a missing stamp, and the checkpoint stamp;
   assert on the code, not a comment (VT4's lesson: a test that passed on a comment alone).
   Also VT4's guard style.
6. Run `npx vitest run src/test/voiceTrain.test.ts`, `node -e "JSON.parse(require('fs').readFileSync('scripts/voice/train/train_qwen3.ipynb','utf8'))"`, and `git diff --stat`. No commits, no plan edits.
Report: the exact message texts, the manifest keys you compared, and the diff's cell list.
