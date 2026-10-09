# F-148 — the notebook checks the data files on Drive against the manifest before it does anything

The fifth Colab run (15 Sept, session 171) trained and predicted, and the scorer here refused the
predictions file: row ho-00000 answered the FOURTH run's held-out sentence. The new
`heldout.jsonl` had not replaced the old one on Drive; the notebook read whatever sat there. F-145
(the predictions file) and F-147 (the adapter and checkpoints) each closed one folder; the data
files themselves were still trusted by name.

You own `scripts/voice/train/lib/prepare.mjs` (or wherever `buildManifest` lives — find it),
`scripts/voice/train/train_qwen3.ipynb` (the Settings/Load cell that reads the manifest and the
data — cells 1–3 — and, only if needed, cell 6's stamp fields), `scripts/voice/train/README.md`,
`src/test/voiceTrain.test.ts`, `src/test/voiceData.test.ts` (one case if the manifest shape is
pinned there). Nothing else. Edit the notebook only with a node script that parses the JSON and
writes it back with the same formatting; every other cell byte-identical.

1. `prepare.mjs`: the manifest gains `files: { "train.chat.jsonl": { sha256, rows }, "heldout.jsonl":
   { sha256, rows } }`, computed from the bytes it just wrote (streamed sha256, the same algorithm
   the notebook uses). Pin it (VT7's neighbour): the written manifest's hashes equal a fresh hash of
   the written files.
2. The notebook, in the cell that loads the manifest and before any training or prediction:
   hash the two files on Drive and count their rows; any difference from the manifest → print
   `F-148: <file> on Drive is not the file this manifest was prepared with` with both hashes and
   both row counts, and `raise SystemExit`. A manifest without `files` (an old one) → refuse too,
   naming F-148 and asking for `npm run voice:prepare` to be run again. Then one line per file
   saying it matches.
3. Cell 6's stamp (F-147) already hashes `train.chat.jsonl` itself; make it take the hash from the
   manifest's `files` instead of re-hashing, so there is one hash, and add the held-out hash to the
   stamp (an adapter now also names the held-out set it was scored against).
4. README: the upload step says the notebook refuses a stale file on its own (F-148) and names
   what to re-upload.
5. Tests: VT9 asserts the check is code (the hash, the compare, the SystemExit, the F-148 text);
   the manifest shape case. Run `npx vitest run src/test/voiceTrain.test.ts src/test/voiceData.test.ts`,
   `npm run voice:prepare` (the manifest now carries `files`), `python scripts/voice/train/check_notebook.py`,
   `node -e "JSON.parse(require('fs').readFileSync('scripts/voice/train/train_qwen3.ipynb','utf8'))"`.
   No commits, no plan edits. Report the message texts, the manifest's new block, and the diff's
   cell list.
