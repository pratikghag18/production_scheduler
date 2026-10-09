# Brief S44-a: serve the model beside the database (llama.cpp server in a container)

Stage S44, requirement R-393, design §19.92 (D121). You are lane A. Lane B is writing the
app side (`src/`) at the same time; you never touch `src/`. The contract between you is in §2
and is not yours to change; if it cannot work, stop and say why.

## 1. What exists

- The fine-tuned model from S43: a Q4_K_M GGUF of Qwen3 1.7B, on this machine at
  `data/voice/runs/third-run/model-q4_k_m.gguf` (1.1 GB, gitignored). Its system prompt is
  `scripts/voice/train/system_prompt.txt`; the model answers a sentence with one JSON object
  (the parser's form), keys alphabetical, thinking off. Score on the held-out set (Colab, f16):
  clean 200/200, perturbed 187/200.
- Docker Desktop is running, `linux/arm64`. `ghcr.io/ggml-org/llama.cpp:server` has an arm64
  image. The Supabase containers run beside it; do not touch them.
- The scorer: `node scripts/voice/score.mjs --heldout data/voice/heldout.jsonl --predictions
  <file> --bar 0.95` reads a predictions file of `{"id": "...", "form": {...}|null}` lines.
- The app's dev server is Vite on port 5173 (`vite.config.ts`).

## 2. The contract (fixed; lane B builds against the same text)

- The service listens on `http://127.0.0.1:8089`. In development the app reaches it through a
  Vite proxy: any request to `/voice/...` on the dev server is forwarded to
  `http://127.0.0.1:8089/...` with the `/voice` prefix stripped.
- Endpoint: `POST /v1/chat/completions`, JSON body exactly:

  ```json
  {
    "messages": [
      {"role": "system", "content": "<scripts/voice/train/system_prompt.txt, byte for byte>"},
      {"role": "user", "content": "<the sentence>"}
    ],
    "temperature": 0,
    "max_tokens": 256,
    "cache_prompt": true,
    "chat_template_kwargs": {"enable_thinking": false}
  }
  ```

- Answer: `choices[0].message.content` is text; the form is the first complete top-level
  `{...}` object in it (scan braces, honour strings), parsed as JSON. Anything else is "not a
  form". The optional `timings` object on the response (prompt tokens, predicted tokens, ms)
  is diagnostic.

## 3. What to build

1. `scripts/voice/serve/serve.mjs` — starts the container in the foreground (Ctrl+C stops it,
   like `npm run dev`). Model path: `--model <path>` argument, else `VOICE_MODEL` env, else
   `data/voice/model/scheduler-voice.gguf`. If the file is missing, print one plain paragraph
   saying where to put it (copy the S43 file there) and exit 1; do not start Docker. Otherwise
   run, with the model's directory mounted read-only:
   `docker run --rm --name scheduler-voice -p 8089:8080 -v <abs dir>:/models:ro ghcr.io/ggml-org/llama.cpp:server -m /models/<file> --host 0.0.0.0 --port 8080 --jinja -c 2048 -np 1 --reasoning-budget 0 --cache-reuse 256`
   Check each flag against `docker run --rm ghcr.io/ggml-org/llama.cpp:server --help` before
   trusting it; drop or replace one that does not exist and say so in the report. Print the URL
   and the one-line health check (`GET /health`) before handing over to the container's own
   output. Build the Windows path for `-v` with forward slashes. `--stop` runs
   `docker stop scheduler-voice`.
2. `scripts/voice/serve/probe.mjs` — sends one sentence (the arguments joined, or `--sentence`)
   through the contract to `--url` (default `http://127.0.0.1:8089`) and prints: the raw
   content, the parsed form (pretty), the wall time, and the server's timings if present. With
   `--repeat N` it sends the same sentence N times and prints each time, so the prompt-cache
   effect is visible (the second call should be far faster than the first).
   With `--heldout <file> --out <predictions.jsonl> [--limit N]` it runs every held-out row's
   sentence through the service and writes the scorer's predictions format (`form: null` when
   the answer is not a form), printing a progress line every 25 rows with the rate, appending
   as it goes and skipping ids already in the file (same resume rule as the notebook).
3. `package.json`: `"voice:serve": "node scripts/voice/serve/serve.mjs"` and
   `"voice:probe": "node scripts/voice/serve/probe.mjs"`.
4. `vite.config.ts`: the `/voice` proxy from §2 under `server.proxy`, with a two-line comment
   naming R-393 and why it is a proxy (same origin, no CORS on the service).
5. `.gitignore`: `data/voice/model/` with a one-line comment (S44-a: the served model file).
6. `.env.example`: a commented line `# VITE_VOICE_URL=/voice` with one sentence: set it to send
   command-bar sentences to the local model service (`npm run voice:serve`); unset, the bar
   uses the rules alone.
7. `scripts/voice/serve/README.md`: the maintainer's step-by-step, in plain language: copy the
   file, `npm run voice:serve`, first start pulls the image, `npm run voice:probe -- "..."`,
   the `.env.local` line, what the bar shows when the service is off, how to stop, and the
   held-out check with its expected duration. Under 80 lines.

## 4. Prove it on this machine (required)

- Copy `data/voice/runs/third-run/model-q4_k_m.gguf` to `data/voice/model/scheduler-voice.gguf`
  (Node `fs.copyFileSync`, or PowerShell `Copy-Item`; the file is 1.1 GB).
- `npm run voice:serve` in the background (the Bash tool's `run_in_background`, or a
  PowerShell `Start-Process`); wait for `/health` to answer. The first start pulls the image.
- `npm run voice:probe -- --repeat 3 "put Ana Silva on Housing A at Cell 1 tomorrow from 8 till noon"`
  and paste all three timings and the form.
- `npm run voice:probe -- --heldout data/voice/heldout.jsonl --out data/voice/runs/served-q4/predictions.jsonl --limit 40`
  then `node scripts/voice/score.mjs --heldout data/voice/heldout.jsonl --predictions data/voice/runs/served-q4/predictions.jsonl --bar 0.95`;
  paste the Overall block (the scorer counts the missing 360 rows as wrong; the point is the
  40 you ran and the rate per row). The developer runs the full 400 after you.
- Stop the container (`npm run voice:serve -- --stop`) and confirm `docker ps` no longer lists
  it. Leave the copied model file in place.

## 5. Rules

- Files you own: `scripts/voice/serve/*`, `package.json` (two script lines only),
  `vite.config.ts`, `.gitignore`, `.env.example`. Nothing under `src/`, `docs/plan.yaml`, or
  `scripts/voice/train/`.
- Plain Node, no new dependencies. `npx prettier --check` on every file you touch; `npx eslint`
  on the `.mjs` files.
- Do not run `npm run test`. Do not commit.
- Report: each file's purpose in a line, the probe output (three timings, the form), the
  40-row score block and the rows-per-second, any flag you had to drop, the README's line
  count, `git diff --stat`.
