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

Ctrl+C in the terminal running `npm run voice:serve` stops the container. If that terminal
is gone, from any terminal:

```
npm run voice:serve -- --stop
```

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
