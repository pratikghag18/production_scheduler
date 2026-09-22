# S70-e — a one-word spoken answer is heard (F-198)

Read F-198 in `docs/plan.yaml` (its story is the trace: `data/voice/trace/bar.jsonl`, the turns
from 2026-09-22T19:42Z to 19:45Z), F-197, R-435, R-434, design-plan §19.102 (D131, the clip
rules), and CLAUDE.md §4 and §7. The maintainer, 22 Sept: "I'm saying clear cell 3 today ... I
eventually had to type yes."

## What the trace shows

"Clear, Cell 3, Today" was heard and the bar asked its question with the job listed. The spoken
"yes" that followed came back five times as `heard: ""`, `outcome: refused: Nothing was heard`,
each about fifteen seconds after the press. Between them, retries of the whole sentence were
misheard ("Sand 3", "Sun 3", "Video cell 3") and each replaced the standing question, so even a
heard "yes" would have had nothing to answer. The person typed "yes" in the end.

## Why

`src/lib/voice/localRecognizer.ts`: a clip's speech "starts" only after `SPEECH_ON_FRAMES = 2`
consecutive frames above `RMS_FLOOR = 0.02`, and a frame is `BUFFER_SIZE = 4096` samples at 16
kHz, a quarter of a second each. A one-syllable "yes" is shorter than half a second of steady
loudness, so speech never "starts", the clip runs to the twelve-second cap, and `finalize` raises
`no-speech` without ever sending the audio to Whisper. The same rule that keeps a silent clip from
being posted throws away every short answer.

## The change

1. Speech starts on ONE frame above the floor (`SPEECH_ON_FRAMES = 1`), and the floor is checked
   against real short clips: record a "yes" and a "no" at ordinary speaking distance in the
   browser (Playwright can feed a WAV through a fake media stream, or use the recogniser's `deps`
   seam with a real recording from `whisper.cpp`'s samples folder plus a synthetic 300 ms burst)
   and confirm both are sent. If a single frame is too eager for room noise, use a higher floor
   with one frame rather than two frames; say what you measured.
2. When the cap is reached and frames were captured but speech never "started", send the clip
   anyway if any frame came within a factor of the floor (a quiet yes), and let Whisper answer;
   an empty transcript still reads "Nothing was heard". Never post a clip whose every frame is
   silence.
3. The hint (`src/lib/voice/recognizerHint.ts` VOCABULARY) gains the answers: yes, no, and the
   candidate words the bar offers most ("Do all", "Show that day"); keep them ahead of the
   board's names. Update `recognizerHint.test.ts`'s word count and helper.
4. Pins in `src/test/localRecognizer.test.ts` with the fake deps: a 300 ms burst above the floor
   is sent (was: no-speech); a quiet burst under the floor but within the factor is sent at the
   cap; all-silence is no-speech; the twelve-second cap still holds. Update every case that
   encoded `SPEECH_ON_FRAMES = 2` and say which contract changed (CLAUDE.md §4: a green case can
   be pinning the bug).

## Boundaries

- You own: `src/lib/voice/localRecognizer.ts`, `src/lib/voice/recognizerHint.ts`,
  `src/test/localRecognizer.test.ts`, `src/test/recognizerHint.test.ts`. Nothing in
  `CommandBar.tsx` (the standing-question behaviour is F-197's and is fixed), nothing under
  `src/lib/command/`, no `e2e/`, no `docs/plan.yaml`.
- `npx vitest run` on the two test files; `npx prettier --write`, `npx eslint`, `npx tsc -b`. No
  full `npm run test`, no commit.
- Report: the frame arithmetic in one sentence, the floor and frame count chosen and what you
  measured, the pins, files changed from `git status`, runner output verbatim.
