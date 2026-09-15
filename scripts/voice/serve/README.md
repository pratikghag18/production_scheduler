# Serving the voice model (S44-a)

This runs the fine-tuned model from S43 in a container beside the database, so the
command bar can send it sentences instead of relying on the rules parser alone.

## First time

1. Copy the fine-tuned model file into place:

   ```
   Copy-Item data\voice\runs\third-run\model-q4_k_m.gguf data\voice\model\scheduler-voice.gguf
   ```

   (Any S43 run's `model-q4_k_m.gguf` works; `data/voice/model/` is gitignored.)

2. Start the service:

   ```
   npm run voice:serve
   ```

   The **first** start pulls the `ghcr.io/ggml-org/llama.cpp:server` image, which can take
   a few minutes. Leave this running in its own terminal, like `npm run dev` -- it prints
   the container's own log lines, and Ctrl+C stops it.

   To use a model file somewhere else, pass it explicitly: `npm run voice:serve -- --model <path>`
   (the bare positional form, `npm run voice:serve -- <path>`, works the same way).

3. Check it answers:

   ```
   npm run voice:probe -- "put Ana Silva on Housing A at Cell 1 tomorrow from 8 till noon"
   ```

   This prints the raw text back, the parsed form, and how long the call took.

## Pointing the app at it

Add this line to `.env.local` (create the file if it does not exist):

```
VITE_VOICE_URL=/voice
```

Restart `npm run dev` after adding it. With the line set and `npm run voice:serve` running,
the command bar sends sentences to the model. With the line unset -- or set but the service
is not running -- the bar falls back to the rules parser alone; it does not hang waiting on
a dead service.

## Stopping it

Ctrl+C in the terminal running `npm run voice:serve` stops the container(s) it started
(`scheduler-voice`, and `scheduler-whisper` if it started too). If that terminal is
gone, from any terminal:

```
npm run voice:serve -- --stop
```

(S57-a: this stops BOTH `scheduler-voice` and `scheduler-whisper` -- do not run it while
another lane's `scheduler-voice` is in use; see "Testing just the whisper half" below.)

Confirm it is gone with `docker ps`.

## Checking accuracy against the held-out set

This takes a while -- measured on this machine, about six seconds a row (0.17 rows/s), so
500 rows is roughly 50 minutes. Run a small batch first to see the rate before committing
to the full set:

```
npm run voice:probe -- --heldout data/voice/heldout.jsonl --out data/voice/runs/served-q4/predictions.jsonl --limit 40
node scripts/voice/score.mjs --heldout data/voice/heldout.jsonl --predictions data/voice/runs/served-q4/predictions.jsonl --bar 0.95
```

Drop `--limit` to run all 500 (S50: the held-out set now covers five intents --
assign/book/unassign/move/several -- 100 rows each). The probe skips ids already in `--out`,
so an interrupted run picks up where it left off instead of starting over -- rerun the same
command to continue it.

## The grammar (S45-a)

By default the probe and the app send `form.schema.json` under `response_format`, which
llama.cpp turns into a grammar that forbids any answer but the five command shapes (S50 adds
`several` to the original four) in the model's own alphabetical key order -- no wrong field
name, no missing or extra key, no out-of-range hour or weekday. Pass `--no-grammar` to
`npm run voice:probe` to send the plain request instead, the way S44 measured it, so the
grammar's accuracy and time cost can be compared against a run without it.

## S57-a: the local (whisper.cpp) recogniser

`npm run voice:serve` also starts a second container, `scheduler-whisper`, running
whisper.cpp's server on `http://127.0.0.1:8090` -- the command bar's microphone, when
`VITE_WHISPER_URL` is set, records a clip and posts it there instead of using the
browser's own speech recognition (design-plan §19.102 / D131). `--stop` stops both
containers.

### First time

1. Fetch whisper.cpp's own model file (not the fine-tuned one above -- a separate,
   published model that reads audio, `data/voice/whisper/`, gitignored):

   ```
   npm run voice:whisper:fetch
   ```

   (`npm run voice:whisper:fetch -- small.en` for the larger model, a one-flag upgrade
   for a loud floor -- pass the same name to `npm run voice:serve -- --whisper-model
small.en` afterward so the served model matches.)

2. **This machine (Windows on Snapdragon) needs its own image.** whisper.cpp's own CI
   publishes `ghcr.io/ggml-org/whisper.cpp:main-arm64`, and it pulls here without
   error -- but every binary in it (`whisper-cli`, `whisper-bench`, the server) raises
   `SIGILL` the moment it runs: that image is built on GitHub's own arm64 runners with
   `ggml`'s `GGML_NATIVE` CMake default tuned to THEIR cores, which use at least one
   instruction (this machine's `/proc/cpuinfo` has no `sve`) this machine's Snapdragon
   cores do not have. Building whisper.cpp's own `.devops/main.Dockerfile` locally
   fixes it -- `GGML_NATIVE` then tunes to this machine's actual cores. One command
   does it (clones `ggml-org/whisper.cpp` into `data/voice/whisper/src/`, gitignored,
   builds `.devops/main.Dockerfile`, tags it, and sanity-checks `whisper-server --help`
   before returning):

   ```
   npm run voice:whisper:build
   ```

   A machine whose Docker Desktop already runs the published `main-arm64` image fine
   (no SIGILL) does not need this step -- `serve.mjs` only ever runs
   `scheduler-whisper-server:arm64-local` (this build's own tag), so on such a machine
   run `docker tag ghcr.io/ggml-org/whisper.cpp:main-arm64
scheduler-whisper-server:arm64-local` once instead.

3. Add this line to `.env.local` (alongside `VITE_VOICE_URL`, if set):

   ```
   VITE_WHISPER_URL=/whisper
   ```

   Restart `npm run dev` after adding it. Unset, the command bar's microphone is the
   browser's own recogniser, exactly as before this stage; set, the local recogniser is
   used first, falling back once to the browser's own if the service does not answer
   (design-plan §19.102 D131 §3).

4. Start it (with the fine-tuned model from the section above too, if using both):

   ```
   npm run voice:serve
   ```

   Check it answers -- whisper.cpp's server takes a WAV and returns `{"text": "..."}`:

   ```
   curl -F "file=@path/to/a/clip.wav" -F "response_format=json" -F "temperature=0" -F "language=en" http://127.0.0.1:8090/inference
   ```

### Testing just the whisper half

A second lane may already own `scheduler-voice` (e.g. mid-training-run). `npm run
voice:serve -- --whisper-only` starts (and, on Ctrl+C, stops) only `scheduler-whisper`,
leaving `scheduler-voice` alone -- `npm run voice:serve -- --stop` stops BOTH
containers, so do not use it while another lane's `scheduler-voice` is in use.

## S55: the board-answered shapes

The schema now carries eight `oneOf` branches, not five: the original `assign`/`book`/
`unassign`/`move`/`several` plus `replace` ("cover Sam with Ana"), `swap` ("swap Sam and Ana")
and `copy` ("same as yesterday for Cell 1" / "copy Monday to Tuesday") -- `several`'s own inner
`commands` array still holds only the original four, never one of these three (D130 item 2: the
board makes the many, not the grammar). `day_word` gains `yesterday` only -- the three week kinds
(`this_week`/`next_week`/`last_week`) live in a separate `week_word` def, and only `copy`'s
`from`/`to` reference both (`oneOf [day_word, week_word]`); every other `day_word` use (`day` on
the other five branches, `unassign`'s own `until`) stays the five ordinary day kinds. The schema
is the fence, not a hint: the served model is FORCED through this grammar, so a week kind is
refused there before `decode.ts` ever sees one -- the decoder's own refusal (`decodeDayWord` has
no case for a week kind) is the second gate, for every caller that is not the served model.
`unassign` gains a required `until` (`null` or a `day_word`) for "off till Friday". None of this
moves `max_tokens`: it stays 640, because a board-answered form is still one short JSON object --
the board makes the many blocks, the model still ever says one.

## S58: group 2 of the catalogue

The schema now carries ten `oneOf` branches: S55's eight plus `split` ("split Sam's block at
noon") and `headcount` ("make the Housing A job on Cell 1 4 people") -- `several`'s own inner
`commands` array still holds only the original four (D132: neither is ever part of a lot). `move`
gains a required `adjust` (`null`, or `$defs.adjust`'s own two-variant union -- `{edge, by}`, a
non-zero integer of minutes, or `{edge, at}`, a `clock_time`); the decoder is the one place the
house rule ("when adjust is set, `toPlace`/`span`/`shift` are all null") is enforced -- the schema,
like R-402's own shift-vs-hours pairing, only shapes the field, it does not cross-check it. The
fence widens once more for `day_word`: a new `$defs.repeat_day_word` (`weekdays`/`every_day`, each
carrying `week: "this_week" | "next_week"`) is reachable ONLY from `assign.day` and `book.day`
(`oneOf [day_word, repeat_day_word]`) -- every other `day` field in the schema, and `unassign`'s
own `until`, stays plain `day_word` alone, the same fence `week_word` already has around every
field but a copy's `from`/`to`. `max_tokens` still holds at 640.
