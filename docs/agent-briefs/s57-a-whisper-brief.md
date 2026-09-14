# S57-a — Whisper beside the model: a local recogniser with the S46 shape (R-411, D131)

You are the one lane of S57. Read `docs/design-plan.md` §19.102 (D131) first, then
`src/lib/voice/recognizer.ts` (the contract you implement a second time), `CommandBar.tsx`'s
`startListening`/`stopListening`/`endSession` (read only — you do not edit the bar),
`scripts/voice/serve/serve.mjs` and its README (the container pattern you extend), `vite.config.ts`
(the `/voice` proxy you copy for `/whisper`), and `BoardPage.tsx` where `browserRecognizer` is
chosen (the one place you edit there).

You own: `src/lib/voice/localRecognizer.ts` (new), `src/lib/voice/wav.ts` (new, pure),
`src/test/localRecognizer.test.ts` and `src/test/wav.test.ts` (new), the recogniser line(s) in
`src/features/board/BoardPage.tsx`, `vite.config.ts` (the new proxy entry only), `.env.example`
(one commented line), `scripts/voice/serve/serve.mjs`, `scripts/voice/serve/README.md`,
`scripts/voice/serve/fetch-whisper.mjs` (new), `package.json` (two new `voice:` lines only —
another lane is editing the `voice:generate` line concurrently; use exact-string edits), and
`.gitignore` (the model folder). Nothing else; do not edit `CommandBar.tsx`, anything under
`scripts/voice/lib`, `scripts/voice/train`, or `data/voice/heldout.jsonl`.

## 0. First, prove the container runs here — before anything else
This machine is Windows on Snapdragon; Docker Desktop runs linux/arm64 containers. Check that
whisper.cpp's server image runs on it: try `docker pull ghcr.io/ggml-org/whisper.cpp:main` and run
it with `--help` for the server binary (`whisper-server` in current images; older ones call it
`server`), and confirm the arm64 manifest exists. If no published image runs on arm64, try building
one from the whisper.cpp repo's `Dockerfile` (a `docker build` on this machine may take long and
memory is tight — cap it, and if it fails, STOP and report: "blocked: no arm64 image"; do not spend
hours on it). Report which image and binary name you settled on.

Fetch the model: `ggml-base.en.bin` from `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin`
into `data/voice/whisper/` (add that folder to `.gitignore` beside the model's). Put the download
in `scripts/voice/serve/fetch-whisper.mjs` (`npm run voice:whisper:fetch [-- small.en]`, a plain
`fetch` to a file with a size check and a printed progress line), so the README's step is one
command.

## 1. `serve.mjs`: a second container, the same command
`npm run voice:serve` starts `scheduler-voice` as today AND `scheduler-whisper`: the whisper.cpp
image, `-p 127.0.0.1:8090:8080`, the model folder bind-mounted read-only, the server run with
`-m /models/ggml-base.en.bin --host 0.0.0.0 --port 8080 -l en` (add `--convert` only if the server
you settled on needs it for WAV — it should not). `--stop` stops both. A `--whisper-model <name>`
flag picks `small.en`. The health check: whisper-server answers `GET /` (or whatever the settled
version answers — find it) — poll it the way the model's `/health` is polled. Keep the existing
behaviour byte-for-byte when whisper's model file is absent: print one line saying the local
recogniser is not started and why, and start the model alone (a machine without the file must not
lose the model service).

## 2. `wav.ts` — pure, tested
`encodeWav16k(samples: Float32Array, sampleRate: number): ArrayBuffer` — a 16-bit PCM mono WAV
with a 44-byte RIFF header; and `rmsOf(frame: Float32Array): number`. Tests: header bytes
(RIFF/WAVE/fmt/data, sizes, 1 channel, the sample rate, 16 bits), clipping at ±1, an empty
clip, rms of silence and of a full-scale square.

## 3. `localRecognizer.ts` — the S46 `Recognizer` shape
```ts
export function localRecognizer(baseUrl: string, deps?: Partial<LocalRecognizerDeps>): Recognizer
```
`deps` is for tests: `getUserMedia`, an `AudioContext` factory, `fetch`, and a clock; defaults
are the window's. A session:
1. `onInterim("Listening…")`; `getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })`;
   on `NotAllowedError` → `onError("not-allowed")` then `onEnd()`.
2. An `AudioContext` with a `ScriptProcessorNode` or `AudioWorklet` (pick the simpler that jsdom
   can be faked for; say which) collecting Float32 frames; `rmsOf` per frame; speech = rms above a
   floor (`0.02`, a named constant) for two consecutive frames; the clip ends when 1500 ms of
   frames below the floor follow speech, or at 12 000 ms total, or when the handle's `stop()` is
   called. No speech at all by the end → `onError("no-speech")`, `onEnd()`.
3. Resample to 16 kHz with an `OfflineAudioContext` (or, if the context can be opened at 16 kHz
   directly, do that and say so), `encodeWav16k`, `onInterim("Transcribing…")`.
4. `POST ${baseUrl}/inference` as `multipart/form-data` with fields `file` (the WAV, name
   `clip.wav`), `response_format=json`, `temperature=0`, `language=en`. The JSON's `text`,
   trimmed → `onFinal(text)` → `onEnd()`. An empty text → `onError("no-speech")`.
5. A network failure or a non-2xx → `onError("other", "local recogniser not answering")` → `onEnd()`.
   Every path releases the microphone tracks and closes the context; `stop()` after the end is a
   no-op; a late response after `stop()` is ignored (a generation counter, as the bar has).
Tests with faked deps: the happy path (frames → WAV posted → text final); silence ends the clip;
the twelve-second cap; `stop()` mid-clip; not-allowed; no speech; the service down; late response
after stop ignored; tracks released on every path.

## 4. The choice, in `BoardPage.tsx`
Where `browserRecognizer()` is chosen today: `VITE_WHISPER_URL` (trimmed, empty = unset, read the
way `readSentence.ts` reads `VITE_VOICE_URL`) set → `withFallback(localRecognizer(url),
browserRecognizer())`: a small wrapper in `localRecognizer.ts` that, when the local session ends
with `onError("other", …)` BEFORE any final text, starts one browser session in its place for that
call (the bar sees one session: the wrapper forwards the browser's events) and prefixes the first
interim with nothing — the bar's own error line already shows the local error; when the window
has no browser recogniser the error stands. Unset → `browserRecognizer()` as today. The typed-only
mode (S54, `recognizer` null) is untouched — read `commandBarGate.ts` and keep its rule.

## 5. Proxy and env
`vite.config.ts`: `/whisper` → `http://127.0.0.1:8090`, rewrite the prefix, exactly like `/voice`.
`.env.example`: `# VITE_WHISPER_URL=/whisper` with one comment line. Do not edit `.env.local` (it
is the maintainer's); tell them in your report to add `VITE_WHISPER_URL=/whisper` to it.

## 6. Verify on this machine
With the model file fetched and `npm run voice:serve` running both containers, `curl` a WAV at
`http://127.0.0.1:8090/inference` (make one with `encodeWav16k` from a synthetic tone, or record
one) and show the JSON answer. Run `npx vitest run src/test/localRecognizer.test.ts
src/test/wav.test.ts src/test/commandBar.test.tsx src/test/commandBarGate.test.ts`, `npx tsc
--noEmit -p tsconfig.json`, `npx eslint src/lib/voice src/features/board scripts/voice/serve`.
No full suite, no commits, no plan edits.

## 7. Report
The image and binary you settled on and whether arm64 ran; the model file's size and path; the
curl answer; what jsdom could and could not fake and how you faked it; the case counts; and the
one line the maintainer must add to `.env.local`.
