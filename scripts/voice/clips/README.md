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
`small.en`/beam/sentences, `small.en`/beam/none, `small.en`/beam/hint +
`--gain peak:0.5` against no gain (F-210 -- see below). `words-53.txt` is
today's `recognizerHint.ts` vocabulary plus Plant A's names; `words-34.txt`
is the vocabulary from before F-195; `sentences.txt` is example sentences,
no name list.

## Boosting a quiet clip before it is scored (F-210, S71-k, R-453)

F-210: the maintainer's own three real clips measured peak RMS 0.044, 0.065
and 0.037 -- a third to a tenth of the 0.12-0.39 whisper.cpp's own onset and
silence rules were tuned against. `--gain <factor|peak:<target>>` scales a
clip's samples before it is posted, so that can be MEASURED against the same
clip unboosted, rather than tuned on a feeling -- nothing about the
recogniser's own onset/silence rules changes here.

    npm run voice:clips:score -- --whisper http://127.0.0.1:8090 --from-trace 3 --gain peak:0.5

`--gain 2` scales every sample by a flat factor of 2. `--gain peak:0.7`
picks, per clip, whatever factor lands THAT clip's own peak at 0.7; `--gain
peak:` (or bare `--gain peak`) defaults the target to 0.5. Either way,
scaling clips at +-1 the same way `record.mjs`'s own encoder does, and the
factor actually used prints on every row (`gain=<factor>`). The sample maths
live in `lib/wavGain.mjs`, pure and unit-tested on their own
(`src/test/voiceClips.test.ts`, VCLIP-14 onward) -- `score.mjs` only ever
calls it, never re-derives it.

## Re-scoring a live walk (S71-f, S71-h, R-453)

Every clip the bar actually posts to Whisper is kept on its own, separately
from the deliberately-recorded set above (`localRecognizer.ts`'s `onClip`,
via `POST /__clip`, `data/voice/trace/clips/`, capped at the newest 500).
There is no ground truth for a live sentence, so this mode compares what
Whisper wrote THEN (the bar's own trace, `data/voice/trace/bar.jsonl`) against
what it writes NOW, against whichever `scheduler-whisper` container is
running -- read the words yourself, not just the WER.

Say sentences to the board, then:

    npm run voice:clips:score -- --whisper http://127.0.0.1:8090 --from-trace 5

No prompt flag needed: a replay is fair only when it uses the SAME prompt the
app actually sent, so each clip is scored against its own manifest `hint`
(the vocabulary `buildRecognizerHint` built for it, kept from the live
request) by default -- the row prints `prompt=hint` (or `prompt=none` when
the app sent none). `--from-trace` alone scores the newest 20; `--from-trace
N` scores the newest N. Pass `--prompt-file <path>` or `--no-prompt` to
override every clip's own hint with the SAME prompt for the whole run instead
(printed as `prompt=override`) -- useful for asking "how would a different
prompt have done against what actually got said," not for the ordinary
replay.

F-209 (S71-k): an answer continues its sentence's trace entry rather than
opening a new one, so one entry's `at` can now genuinely list two clips --
the sentence's own and the "yes"/"no"/candidate word that answered its
question (each posted under its own file, named from ITS OWN post instant,
never the shared `at` -- see `clipServer.ts`). `--from-trace` groups its
selected lines by `at` before printing: the sentence's own clip prints first
(`bar.jsonl`'s `heard` as its "then"), then any answer clip, labelled
`answer`, `bar.jsonl`'s own `answered` printed as ITS "then" instead --
`heard` never repeats on an answer's row.

### Against what was actually said (24 Sept, R-453)

Then-vs-now only says whether a setting changed the reading. To compare two
models you need the truth. Write what was said per clip into a JSON file,
keyed by the entry's `at` for sentences and by the clip's `postedAt` for
answers (the walk list with the day's date; `data/voice/clips/references.json`
holds the 23 Sept walk, `data/voice/clips/references-2026-09-24.json` the 24
Sept walk's second list, gitignored with the clips), and pass it:

    npm run voice:clips:score -- --whisper http://127.0.0.1:8090 --from-trace 36 --references data/voice/clips/references.json --label small-en-beam-hint

Each row with a reference prints `said:` instead of `then:`, its WER against
the truth, the board names heard (`names=hit/total`) and the wall time; the
summary gives mean WER, names and exact matches over the referenced clips
and the mean wall time per clip, and `--label` writes the rows to
`results/<label>.json`. Run it once per container (swap the model, run the
same command with a new label) and read the summaries side by side.
