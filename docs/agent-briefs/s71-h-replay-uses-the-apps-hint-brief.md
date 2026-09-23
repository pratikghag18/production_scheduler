# S71-h — a replayed clip is scored with the prompt the app actually sent (R-453)

Serves **R-453**. `npm run voice:clips:score -- --whisper http://127.0.0.1:8090 --from-trace 6`
refuses to run without `--prompt-file` or `--no-prompt`, and neither is right for a live clip:
the app sent Whisper its own hint (`buildRecognizerHint`, the 53-word vocabulary plus the board's
names), and a fair replay uses exactly that string. The recogniser already reports it: `ClipInfo.hint`
(`src/lib/voice/recognizer.ts`), fired to the bar in `onClip`, but `postClip` (`src/lib/voice/trace.ts`)
does not send it and `clipServer.ts` does not keep it.

## 1. The change

1. `postClip` sends the hint as the request BODY's companion: since the body is the WAV, put the
   hint in a header `x-clip-hint` (URL-encoded, since headers are Latin-1) or, cleaner, switch the
   POST to multipart with fields `file` and `hint` — pick the one that keeps `clipServer.ts`
   dependency-free (a multipart parser is not in the repo; a header is). `clipServer.ts` decodes it
   and writes `hint` (string or null) into the manifest line. Cap the header at 4 KB (the hint is
   capped at 200 words already); reject longer with 400.
2. `score.mjs --from-trace N`: the prompt for each clip defaults to the manifest's `hint` (null →
   no prompt), and prints which was used in the row; `--prompt-file`/`--no-prompt` override it
   for every clip when given, so the same clips can be scored against another prompt. The
   ordinary (manifest of recorded sentences) mode keeps requiring one of the two flags.
3. Also in `--from-trace` mode, print a one-line header naming the container's model if the
   server tells it (`GET /health` does not; skip if not available — say so).
4. README: update the two-line recipe (no prompt flag needed for a replay).

## 2. Pins

`src/test/trace.test.ts` PC-5: `postClip` sends the hint header, URL-encoded, and omits it when
null. `src/test/voiceClips.test.ts` CS-9: a POST with the header writes `hint` in the manifest;
CS-10: an over-long header is 400. A unit case for the scorer's prompt choice if its arg parsing
is testable from the lib; otherwise say so.

`npx vitest run src/test/trace.test.ts src/test/voiceClips.test.ts src/test/commandBar.test.tsx`;
prettier, eslint, tsc on your files. Prove the whole path with a synthetic POST to the running dev
server on 5173 (do not restart it) carrying a header, read the manifest line back, then delete
that synthetic clip and its line.

## 3. Files you own / must not touch

Own: `src/lib/voice/trace.ts`, `src/lib/voice/clipServer.ts`, `scripts/voice/clips/score.mjs`,
`scripts/voice/clips/README.md`, `src/test/trace.test.ts`, `src/test/voiceClips.test.ts`. Do not
touch `CommandBar.tsx` (it already passes `info.hint` through if `postClip`'s signature takes the
clip record — check: if the hint has to be threaded through `attachPendingClip`, tell me the
one-line change you need there instead of making it, and I will make it), `localRecognizer.ts`,
`CreatePopover*` (another lane), `docs/plan.yaml`. Do not run the full `npm run test`. Do not commit.

## 4. Report

Under 20 lines: the header name and cap; the manifest field; the scorer's default rule; pin ids;
totals; the synthetic proof line; the CommandBar one-liner if needed.
