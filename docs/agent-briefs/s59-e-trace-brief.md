# S59-e — the bar's trace: heard, answered, read, asked, ran; written to a local file by the dev server (R-421)

The maintainer, 15 Sept (session 174): "create a temporary log of what whisper is hearing, what
the model responds and check the corresponding activity through the activity tab", then "put it
in a local temporary file instead of me pasting it".

You own `vite.config.ts` (a dev-only plugin, see 3), `.gitignore` (one line),
`src/lib/voice/readSentence.ts` (a `raw` field on `Reading` if it lacks one, nothing else),
`src/lib/voice/trace.ts` (new, pure), `src/test/trace.test.ts`, `src/test/traceServer.test.ts`,
`src/features/board/components/CommandBar.tsx`, `src/features/board/BoardPage.tsx` (one prop
line) and `src/test/commandBar.test.tsx`. Read R-421 in `docs/plan.yaml`, then the bar's
`runCommand`, `applyReading`/`fallbackToRules`, `questionToStatus`, `startListening`'s events,
`runLotNow`, and every `setStatus` of a readout. Lanes A–D of S59 have landed; read `git log -1`
and the bar as it is.

1. `trace.ts`: an entry type and `renderLine(entry): string` (one JSON line, the raw answer
   trimmed to 600 characters). The entry: `{ at: string (ISO time), heard: string, by: "typed" |
   "browser" | "local", model: { raw: string } | { skipped: string }, read: string (formatCommand
   of the command, or the failure kind), asked: string | null, answered: string | null, ran:
   string[] }`. Pure, tested.
2. `readSentence.ts`: the `Reading` the reader resolves to carries the raw response text (`raw`)
   on every outcome that had one (a form, a garbled answer), and the reason on the others
   (`skipped`: "no service", "timeout", "network", and so on). Pin in `voiceRead.test.ts` only if a
   case there builds a `Reading` literal that now needs the field; otherwise leave that file.
3. The bar and the dev server: one entry in progress per mounted bar (a ref). It starts when a
   sentence is submitted (typed) or a final transcript arrives (`by` from a new prop
   `recognizerName?: "browser" | "local"` that BoardPage passes, one line there), is filled as
   the reading, the question or readout, the answer (a candidate label or the confirm word) and
   the lot's or single command's readouts arrive, and when the sentence's life ends (a readout
   written, a cancel, a new sentence) it is POSTed as JSON to `/__trace`, fire-and-forget, errors
   swallowed, only when `import.meta.env.DEV`. `vite.config.ts` gains a small plugin whose
   `configureServer` handles POST `/__trace`: append one JSON line per body to
   `data/voice/trace/bar.jsonl` (mkdir as needed), answer 204; anything else 405. `.gitignore`
   gets `data/voice/trace/`. No clipboard, no button.
4. Tests: CB-t-1 a typed sentence that resolves and runs → one posted entry with by "typed",
   the model line, the read form, the readout, ran (stub `fetch`, assert the body); CB-t-2 a
   spoken sentence through the reader stub → by "local" and the raw answer; CB-t-3 a question
   answered by a button → asked and answered; CB-t-4 a lot → ran lists every command; CB-t-5 a
   failed post is swallowed; CB-t-6 nothing is posted when not DEV (stub the env). The plugin:
   `traceServer.test.ts` calls the handler with a fake request and response and checks the file
   line, the 204 and the 405 (put the handler in a small module the plugin imports, so it is
   testable without Vite).
Run `npx vitest run src/test/trace.test.ts src/test/traceServer.test.ts src/test/commandBar.test.tsx
src/test/voiceRead.test.ts`, `npx tsc --noEmit -p tsconfig.json`, `npx eslint src/features/board
src/lib/voice vite.config.ts`. No commits, no plan edits. Report the entry shape and a sample line.
