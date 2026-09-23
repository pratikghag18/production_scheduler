# S71-f — the bar keeps every clip it sends to Whisper, with why the clip ended (R-453, R-434)

Serves **R-453** (the recogniser is measured on recorded clips) and **R-434** (every bar feature
traces). On 23 Sept the maintainer said three sentences to the board on small.en and "this is
even worse". The whisper-server log showed the clips it received were 3.6, 7.2, 6.4, 3.3 and
5.1 s while the second and third sentences take about 7 s to say; a 3.3 s clip came back as
fifteen words ("... Common Fasteners himself, working Line 2, Completely and people, clear,
clear"), which is Whisper inventing words over padding. Nothing recorded which rule ended each
clip or what the audio was, so nobody can say whether the recorder cut the sentence or the model
misheard it. This lane makes every spoken sentence a kept, scoreable clip.

## 0. What exists (read first, do not redo)

- `src/lib/voice/localRecognizer.ts`: `handleFrame` (~561) and `finalize` (~536). A clip ends by
  one of: `stop()` (the button), `SILENCE_END_MS` (1500 ms after the last frame above `RMS_FLOOR`
  0.02, once speech started), or `MAX_CLIP_MS` (12 s cap). Speech "starts" on one frame at or
  above `SPEECH_ON_LOUD_FRAME_RMS` 0.08 (not frame 0) or two consecutive frames above the floor.
  If speech never started and the cap hit with some quiet sound, a WINDOW of at most
  `QUIET_CLIP_MAX_FRAMES` 12 frames (3 s) around the quiet sound is sent instead of the clip.
  `transcribe(framesToSend?)` (~420-480) encodes WAV (`wav.ts`) and posts to `${baseUrl}/inference`.
  A frame is 4096 samples at 16 kHz, 256 ms. `rmsOf(frame)` exists.
- `src/lib/voice/trace.ts` posts a trace entry per sentence to the dev server's `POST /__trace`;
  `src/lib/voice/traceServer.ts` writes it to `data/voice/trace/bar.jsonl` (gitignored);
  `vite.config.ts` ~19 mounts the middleware. The trace entry's fields are in `trace.ts`.
- `src/features/board/components/CommandBar.tsx` `startListening` (~3300) wires the recogniser's
  events (`onFinal`, `onError`, `onInterim`, `onEnd`) into the sentence's trace entry.
- The scorer `scripts/voice/clips/score.mjs` reads a manifest `{ clips: [{ n, file, sentence }] }`
  from a clips directory (`--clips <dir>`) and scores each WAV; `scripts/voice/clips/README.md`.
- Tests: `src/test/localRecognizer.test.ts` (LREC-1..29e, a fake audio harness that feeds frames
  and a fake fetch), `src/test/voiceTrace.test.ts` or similar for trace.ts (find it with
  `grep -ln "__trace" src/test/*.ts*`), `src/test/commandBar.test.tsx` CB-* for the bar.

## 1. Deliverables

### A. The recogniser reports what it sent
Extend the recogniser's events with one more, `onClip(info: ClipInfo)`, fired once per clip
posted (right before or after the fetch, once), where
```ts
export interface ClipInfo {
  wav: ArrayBuffer;            // exactly the bytes posted
  durationMs: number;          // of the bytes posted
  recordedMs: number;          // whole recording before any windowing
  endedBy: "stop" | "silence" | "cap" | "cap-window";  // which rule ended it; cap-window = the quiet-window send
  speechStarted: boolean;
  peakRms: number;             // max frame RMS over the whole recording
  meanRms: number;
  framesAboveFloor: number;
  hint: string | null;         // the prompt sent, or null
}
```
Keep every existing event and rule unchanged; `onClip` is optional in the events type so
existing callers and tests need no change. `finalize` must know which rule called it: give it
the reason instead of the boolean it takes today (keep behaviour identical).

### B. The bar posts the clip to the dev server and traces the numbers
In `CommandBar.tsx`'s recogniser wiring, on `onClip`: (1) add to the sentence's trace entry the
numbers (`clip: { durationMs, recordedMs, endedBy, speechStarted, peakRms, meanRms,
framesAboveFloor }` — extend the trace entry type in `trace.ts`), and (2) POST the WAV bytes to
`/__clip` with the trace entry's own id/timestamp in a header or query (`?at=<iso>`), through
the same small helper style `trace.ts` uses (fire and forget, never blocks the bar, swallowed on
failure, no-op outside dev like the trace is — read how `trace.ts` decides that). The WAV posted
is the exact bytes `ClipInfo.wav` holds.

### C. The dev server keeps the clips
`traceServer.ts` (or a sibling `clipServer.ts` mounted the same way in `vite.config.ts` next to
`/__trace`): `POST /__clip?at=<iso>` writes `data/voice/trace/clips/<at-with-colons-replaced>.wav`
and appends a line to `data/voice/trace/clips/manifest.jsonl` `{ at, file, durationMs, endedBy,
... the same numbers, heard: null }`. Keep the directory under the already-gitignored
`data/voice/trace/`. Cap the directory at the newest 500 clips (delete the oldest beyond that on
each write) so it never grows without bound.

### D. The scorer reads the bar's clips too
`scripts/voice/clips/score.mjs` gains `--from-trace [N]`: score the newest N (default 20) clips
from `data/voice/trace/clips/manifest.jsonl`, using as the reference sentence the `heard` string
from `data/voice/trace/bar.jsonl` for the entry with the same `at` (join on `at`), so the table
prints, per clip: at, durationMs, endedBy, peakRms, what Whisper wrote THEN (the trace's heard)
and what it writes NOW (this run), and their WER against each other — there is no ground truth
for a live sentence, so "then vs now" is the comparison, and the maintainer reads the words.
Document the flag in `scripts/voice/clips/README.md` with the two-line recipe: say sentences to
the board, then `npm run voice:clips:score -- --from-trace 5` against any container.

### E. Pins
- `localRecognizer.test.ts` LREC-30a..d: `onClip` fires once with `endedBy` "silence" (speech
  then 1.5 s quiet), "cap" (speech running to 12 s), "cap-window" (quiet sound, never started —
  `durationMs` about 3 s and `recordedMs` 12 s), "stop"; `peakRms` and `framesAboveFloor` right
  for the fed frames; the `wav` bytes equal what the fake fetch received.
- The trace test file: an entry with `clip` numbers serialises and posts as before.
- A small test for the server handler (the trace server test, if one exists, as the pattern):
  a POST writes the file and the manifest line; the 501st clip evicts the oldest.
- `commandBar.test.tsx` CB-clip-1: with a fake recogniser that fires `onClip`, the sentence's
  trace entry carries the numbers (read how existing CB tests assert trace entries — `stubFetch`
  captures `/__trace` posts).

### F. Nothing else changes
Do not change any threshold or rule in the recogniser (RMS_FLOOR, SILENCE_END_MS, the onset
rules): this lane measures, it does not tune. Do not touch `scripts/voice/serve/`,
`recognizerHint.ts`, `supabase/`, `docs/plan.yaml`.

## 2. Proving it
`npx vitest run src/test/localRecognizer.test.ts src/test/commandBar.test.tsx <the trace test
file> src/test/voiceClips.test.ts` green; prettier, eslint on every file touched; `npx tsc
--noEmit -p .` no errors in your files. Then, with the dev server running on 5173 (it is the
maintainer's; do not restart it; Vite reloads your files), prove the server half by posting a
small synthetic WAV to `http://localhost:5173/__clip?at=2026-09-23T00:00:00.000Z` with curl or
node and reading the file and the manifest line back, then delete that synthetic clip and its
manifest line. Do not run the full `npm run test`. Do not commit.

## 3. Files you own
`src/lib/voice/localRecognizer.ts`, `src/lib/voice/recognizer.ts` (the events type, if it lives
there), `src/lib/voice/trace.ts`, `src/lib/voice/traceServer.ts` (or a new `clipServer.ts`),
`vite.config.ts` (the one mount line), `src/features/board/components/CommandBar.tsx` (the
recogniser wiring only), `scripts/voice/clips/score.mjs` and its README, and the test files named
in §1E. No other lane is running.

## 4. Report shape
Under 40 lines: the `ClipInfo` fields and where `endedBy` is decided; the trace entry's new
field; the server path and the eviction rule; the `--from-trace` table's columns; the pin ids;
vitest totals; the synthetic-clip proof output; anything left.
