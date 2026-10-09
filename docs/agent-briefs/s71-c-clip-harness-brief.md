# S71-c — record the walk once, score every Whisper setting offline

Serves queue item **S71-c** and the maintainer's decision of 23 Sept (R-453): the maintainer's
voice is not a test instrument. Two spoken walks cost two afternoons and the second was worse than
the first with nothing measured. From now on the maintainer records the sentence list ONCE, the
clips live on disk, and every change to the recogniser (model size, decoding flags, the prompt) is a
number produced by a script, never a feeling from a walk.

## 0. What exists (read, do not redo)

- `scripts/voice/serve/serve.mjs` starts the `scheduler-whisper` container (whisper.cpp's
  `whisper-server`, image `scheduler-whisper-server:arm64-local`) — see `startWhisper()` ~139-200.
  Today's command is `whisper-server -m /models/ggml-<model>.bin --host 0.0.0.0 --port 8080 -l en`:
  greedy decoding, no non-speech suppression. `--whisper-model <name>` and `--whisper-only` exist.
  Models on disk under `data/voice/whisper/` (gitignored): `ggml-base.en.bin` and, fetched today,
  `ggml-small.en.bin`.
- The server's flags (from `whisper-server --help` inside the container): `-bs N` beam size, `-bo N`
  best-of, `-sns` suppress non-speech tokens, `-nth N` no-speech threshold, `-t N` threads, `-p N`
  processors, `--vad` + `-vm` (needs a VAD model file, do not use), `--prompt`, `--convert`
  (needs ffmpeg, do not use). The client posts multipart `file` (16 kHz mono PCM16 WAV),
  `response_format=json`, `temperature=0`, `language=en`, `prompt=<hint>` to `/inference`
  (`src/lib/voice/localRecognizer.ts` ~434-450). The hint today is
  `src/lib/voice/recognizerHint.ts` (`VOCABULARY` + board names, capped at 200 words).
- The 22-sentence list is the table in `docs/walks/voice-walk-2026-09-22.md` (rows 1-22, the
  first column). Plant A's names: cells "Cell 1".."Cell 6", places "Area 1", "Area 2", "Line 1",
  "Line 2", "Line 3", parts "Housing A", "Bracket A", "Common Fastener", "Line 1 Subassembly A",
  "Area 2 Frame A", people "Sam Patel", "Maria Lopez", "John Kim", "Priya Shah", "Tom Baker",
  "Lena Novak" (`supabase/dev_demo.sql` ~162-165, ~283, ~329, ~555-565).
- The machine: 16 GB, Docker VM 7.5 GB, ARM (Snapdragon X, 12 cores), no GPU. Memory is tight;
  do not start more than one whisper container at a time.

## 1. Deliverables

### A. `scripts/voice/clips/record.mjs` — the recording page
`node scripts/voice/clips/record.mjs [--port 8092] [--out data/voice/clips]`. A plain Node http
server (no dependencies) that serves ONE inline HTML page at `/` and accepts `POST /clip/<n>`.

The page: lists the 22 sentences from `scripts/voice/clips/sentences.json` (you create it — see C),
one row each, with the sentence text, a **Record** button that becomes **Stop** while recording, a
"saved" mark once the clip is on disk, and a **Play** button to hear it back. Recording uses
`getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } })` —
the SAME constraints as `localRecognizer.ts` (grep `getUserMedia` there and copy them exactly; if
it sets `sampleRate` or `autoGainControl`, copy those too) — captures through an `AudioContext`
at 16 kHz (or resamples to 16 kHz if the device refuses, the way localRecognizer does), and encodes
16-bit mono WAV in the page (write the small RIFF encoder in the page's script). On Stop it POSTs
the WAV to `/clip/<n>`; the server writes `data/voice/clips/<nn>.wav` (two-digit, zero-padded) and
`data/voice/clips/manifest.json` ({ recordedAt, clips: [{ n, file, sentence }] }). Re-recording a row
overwrites. A "Record all in order" mode is NOT needed; keep it row by row. The page must work in
Chrome/Edge with no build step: plain script, no modules from `src/`.

### B. `scripts/voice/clips/score.mjs` — the scorer
`node scripts/voice/clips/score.mjs --whisper http://127.0.0.1:8090 [--prompt-file <path> |
--no-prompt] [--clips data/voice/clips] [--label <name>]`. For each clip in the manifest: POST to
`<whisper>/inference` with exactly the fields the app sends (file, response_format json,
temperature 0, language en, prompt when a prompt file is given), take `text`, and score it against
the sentence:
- **normalise** both sides: lower-case; strip punctuation; `a.m.`/`am`/`a m` → `am`, same for pm;
  spelled numbers one..twelve → digits; "twenty-eighth"/"28th" → "28"; collapse whitespace.
- **word error rate** (Levenshtein over words / reference length).
- **name hits**: for each board name that appears in the reference sentence (the list in §0,
  matched case-insensitively after normalisation), whether it appears in the hypothesis. Report
  hits / total.
- **exact**: normalised strings equal.
Print one row per clip (n, WER, names hit/total, the heard text when not exact) and a summary line:
mean WER, names hit total, exact count, wall time per clip (mean). Write
`data/voice/clips/results/<label>.json` with everything (label defaults to a timestamp). Put the
normaliser and WER in `scripts/voice/clips/lib/score.mjs` (pure, exported) so they can be unit
tested; the entry script only does I/O.

### C. `scripts/voice/clips/sentences.json`
The 22 sentences verbatim from the walk table's first column, as `[{ "n": 1, "text": "..." }]`.
Row 19's italic placeholder becomes the literal words "on September twenty-eighth". Row 7 keeps
"from 2 until end of shift today".

### D. Prompts under `scripts/voice/clips/prompts/`
- `none` is a flag, not a file.
- `words-34.txt`: the VOCABULARY string as it was before F-195 (`git show 3c5b618:src/lib/voice/
  recognizerHint.ts` and take that file's `VOCABULARY`), followed by ", " and Plant A's names in the
  order `buildRecognizerHint` uses (cells, places, parts, people).
- `words-53.txt`: today's `VOCABULARY` (`src/lib/voice/recognizerHint.ts`) plus the same names.
- `sentences.txt`: two or three example sentences in the bar's own shape, no list, e.g.
  "Assign Sam Patel to Housing A on Cell 1 in Line 1 from 8am to 4pm today. Clear Cell 4 today. End
  John Kim's block at 2pm." Keep it under 60 words.
Build the two word files with a tiny script or by hand; either way they are committed text.

### E. `scripts/voice/serve/serve.mjs` — decoding flags
Add `--whisper-decode greedy|beam` (default **beam**: `-bs 5 -bo 5`), `--whisper-threads N`
(default 8, `-t 8`), and always `-sns`. Keep every existing flag and message; print the whole
command line once at start. Update the header comment and the README under `scripts/voice/serve/`
if it lists the command.

### F. `package.json` scripts
`"voice:clips:record": "node scripts/voice/clips/record.mjs"`,
`"voice:clips:score": "node scripts/voice/clips/score.mjs"`.

### G. Unit test
`src/test/voiceClips.test.ts` (vitest, importing `scripts/voice/clips/lib/score.mjs` the way
`src/test/voiceData.test.ts` imports its script — copy that pattern): the normaliser on the am/pm
and number cases above; WER on three small pairs including an exact match (0) and an empty
hypothesis (1); name hits on a sentence with two names, one misheard. Eight to ten cases.

### H. `.gitignore`
Add `data/voice/clips/` (the recordings are the maintainer's voice; never committed), with a
comment in the file's own style (see the `data/voice/whisper/` entry).

### I. `scripts/voice/clips/README.md`
Fifteen lines: how to record (start the page, allow the mic, one row at a time), how to score
(start the whisper container with a given model and decode flag, run the scorer with a prompt
file, read the summary line), and the matrix the maintainer will run:
base.en/greedy/words-53 (today's setting), base.en/beam/words-53, small.en/beam/words-53,
small.en/beam/words-34, small.en/beam/sentences, small.en/beam/none.

## 2. Proving it without the maintainer's voice

You have no recordings. Prove the pipeline with whisper.cpp's own sample: inside the container there
is `/app/samples/jfk.wav` (check with `docker exec scheduler-whisper ls /app/samples`); copy it out
with `docker cp scheduler-whisper:/app/samples/jfk.wav <scratch>` and write a throwaway manifest
whose one sentence is "And so my fellow Americans ask not what your country can do for you ask what
you can do for your country". Run the scorer against the running container (port 8090) with
`--no-prompt` and with `prompts/sentences.txt`; both must produce a row and a summary and a results
file. Do NOT restart or stop the running container (the maintainer's app uses it); do not start a
second one. Delete the throwaway manifest afterwards. Prove `record.mjs` serves the page and accepts
a POST with a small synthetic WAV (a node script posting 1 s of silence) and writes the file and the
manifest.

`npx vitest run src/test/voiceClips.test.ts`; `npx prettier --check` and `npx eslint` on every
file you touched (scripts are linted too); `node --check` on each .mjs.

## 3. Files you own / must not touch

Own: everything under `scripts/voice/clips/`, `scripts/voice/serve/serve.mjs` and its README,
`package.json` (the two script lines only), `.gitignore` (one entry), `src/test/voiceClips.test.ts`.

Do NOT touch anything else under `src/` (two other lanes are editing `src/lib/voice/`,
`src/lib/command/` and the board components), `supabase/`, `docs/plan.yaml`,
`fetch-whisper.mjs`. Do not run the full `npm run test`. Do not commit.

## 4. Report shape

Under 40 lines: the commands to record and to score, verbatim; the jfk.wav rows you got (heard text
and WER) with and without the prompt; the serve.mjs command line now printed; test/lint status;
anything you could not prove and why.
