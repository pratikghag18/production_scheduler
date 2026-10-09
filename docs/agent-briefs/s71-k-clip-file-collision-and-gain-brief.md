# S71-k — an answer's clip no longer overwrites the sentence's clip (F-209), and the scorer can test a gain (R-453)

## F-209 — two clips, one file

`data/voice/trace/clips/manifest.jsonl` on 23 Sept 20:41: two lines with the same `at`
(`2026-09-23T20:41:41.045Z`), 2816 ms then 2048 ms, both naming the same file
`2026-09-23T20-41-41.045Z.wav`. The sentence "Clear, Cell 3, today." and the spoken "Yes" that
answered its question share one trace entry (an answer continues the entry, it does not open one),
so `postClip` posted both under the entry's `at`, and `clipServer.ts` named the file from `at`, so
the yes overwrote the sentence. The manifest still lists both, pointing at one file.

Fix in `src/lib/voice/trace.ts` `postClip` and `src/lib/voice/clipServer.ts`: the file name is the
POST's own instant (`Date.now()` at post, ISO, colons to dashes) plus the entry's `at` kept as a
manifest field, so several clips of one entry are several files; the manifest line gains
`postedAt`. Keep the strict ISO check on both. The scorer's `--from-trace` groups by `at` and prints
each clip of an entry on its own row (the answer's row labelled `answer`) — join the entry's `heard`
to the first clip only, and print the entry's `answered` beside the answer clip (read `bar.jsonl`'s
`answered`). Pins: CS-12 (two POSTs with the same `at` → two files, two lines, both readable);
CS-13 (`postedAt` present and ISO); PC-6 (`postClip` sends `postedAt`).

## The loudness finding (F-210), measured before anything is tuned

The same three clips: peak RMS 0.044, 0.065, 0.037; mean 0.012-0.023; frames above the 0.02 floor
2, 5 and 2 of 8-12. whisper.cpp's own sample, on which the onset rules were tuned, peaks at 0.12 to
0.39. The maintainer's microphone delivers a third to a tenth of that, which is why the onset rule
(a single frame at 0.08, or two at 0.02) starts late and the silence rule ends early, and why the
"PSL 3, today" clip (peak 0.044) misheard where the 0.065 one heard right. Nothing in the recogniser
changes in this lane (R-453: measure first). Instead:

`scripts/voice/clips/score.mjs` gains `--gain <factor|peak:<target>>`: before posting, scale the
WAV's samples by the factor, or peak-normalise to the target (0 to 1, default target 0.5 when
`peak:` is given bare), clipping at ±1; print the gain used per row. Put the sample maths in
`scripts/voice/clips/lib/wavGain.mjs` (pure: takes a WAV ArrayBuffer/Buffer, returns a new one;
16-bit PCM only, read the header the way `record.mjs`'s encoder writes it), with a `.d.mts`. Unit
cases in `src/test/voiceClips.test.ts` (VCLIP-14 onward: a factor doubles samples; peak-normalise
lands the peak on the target; clipping at full scale; a silent clip is unchanged). The README's
matrix gains a row: small.en beam, hint, `--gain peak:0.5` against no gain.

## Files you own / must not touch
Own: `src/lib/voice/trace.ts`, `src/lib/voice/clipServer.ts`, `scripts/voice/clips/score.mjs`,
`scripts/voice/clips/lib/wavGain.mjs` (+ `.d.mts`), `scripts/voice/clips/README.md`,
`src/test/trace.test.ts`, `src/test/voiceClips.test.ts`. Do not touch `CommandBar.tsx`,
`localRecognizer.ts`, `recognizer.ts` (another lane), `docs/plan.yaml`. No full `npm run test`, no
commit, no dev-server restart, no container restart. Prove the collision fix with two synthetic
POSTs to the running dev server on 5173 under one `at`, read both files back, delete them and their
lines. Prove `--gain` by scoring the three real clips already on disk (`--from-trace 3`) with and
without `--gain peak:0.5` against the running container and quoting both tables — do not delete
those clips, they are the maintainer's.

## Report
Under 25 lines: the file-name rule; the manifest fields; the scorer's rows for an entry with an
answer; the gain flag; the two tables from the three real clips; pin ids; totals.
