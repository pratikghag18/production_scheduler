# Record the walk once, score every Whisper setting offline (S71-c, R-453)

**Record** (once): `npm run voice:clips:record` (`-- --port`/`-- --out` to change
either), open `http://127.0.0.1:8092/`, allow the mic, and go row by row -- Record,
say the sentence exactly as written, Stop. Re-recording a row overwrites it. Clips
land at `data/voice/clips/<nn>.wav`, `manifest.json` beside them (gitignored).

**Score**: start `scheduler-whisper` with the setting to measure, e.g. `npm run
voice:serve -- --whisper-model small.en --whisper-decode beam`, then `npm run
voice:clips:score -- --whisper http://127.0.0.1:8090 --prompt-file
scripts/voice/clips/prompts/words-53.txt --label small-en-beam-words-53` (or
`--no-prompt`). Read the summary line -- mean WER, names heard, exact count, wall
time per clip -- not a feeling. The full run is written to
`data/voice/clips/results/<label>.json`.

The matrix, one whisper restart per row: `base.en`/greedy/words-53 (today),
`base.en`/beam/words-53, `small.en`/beam/words-53, `small.en`/beam/words-34,
`small.en`/beam/sentences, `small.en`/beam/none. `words-53.txt` is today's
`recognizerHint.ts` vocabulary plus Plant A's names; `words-34.txt` is the
vocabulary from before F-195; `sentences.txt` is example sentences, no name list.

## Re-scoring a live walk (S71-f, R-453)

Every clip the bar actually posts to Whisper is kept on its own, separately
from the deliberately-recorded set above (`localRecognizer.ts`'s `onClip`,
via `POST /__clip`, `data/voice/trace/clips/`, capped at the newest 500).
There is no ground truth for a live sentence, so this mode compares what
Whisper wrote THEN (the bar's own trace, `data/voice/trace/bar.jsonl`) against
what it writes NOW, against whichever `scheduler-whisper` container is
running -- read the words yourself, not just the WER.

Say sentences to the board, then:

    npm run voice:clips:score -- --whisper http://127.0.0.1:8090 \
      --prompt-file scripts/voice/clips/prompts/words-53.txt --from-trace 5

`--from-trace` alone scores the newest 20; `--from-trace N` scores the
newest N. `--no-prompt` works here too, same as the recorded-set mode above.
