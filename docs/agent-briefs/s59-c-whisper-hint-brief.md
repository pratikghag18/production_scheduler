# S59-c — the local recogniser is told the board's own words (R-420, D133 item 4)

You own `src/lib/voice/localRecognizer.ts`, `src/test/localRecognizer.test.ts`, a new pure
`src/lib/voice/recognizerHint.ts` with `src/test/recognizerHint.test.ts`, and the recogniser
lines of `src/features/board/BoardPage.tsx` (lane B has finished with that file when you start).
Read `docs/design-plan.md` §19.104 (D133) and §19.102 (D131), and how `localRecognizer` posts the
clip (the FormData fields). whisper.cpp's server takes an initial prompt as the multipart field
`prompt` (verify against the running container: `curl -F file=@… -F prompt="…"` on
127.0.0.1:8090/inference; report the field name you confirmed).

1. `recognizerHint.ts`: `buildRecognizerHint(names: { cells: string[]; places: string[]; parts:
   string[]; people: string[] }): string` — one line, the bar's own vocabulary first ("cell, line,
   shift, job, people, everyone, assign, book, remove, move, cover, swap, split, extend, one two
   three four five six seven eight nine ten, 1 2 3 4 5 6 7 8 9 10"), then the names in board
   order, de-duplicated, joined by ", ", cut at roughly 200 words on a word boundary. Pure,
   tested: order, de-duplication, the cap, an empty board.
2. `localRecognizer(baseUrl, deps, hint?: () => string)`: a third argument, a function returning
   the current hint (so a window change is picked up without rebuilding the recogniser); when
   it returns a non-empty string the clip's request carries it as `prompt`. Pin: the field is
   sent when a hint is given and absent when not; the hint is read at clip time, not at
   construction.
3. `BoardPage.tsx`: build the names from the same `ctx` the resolver gets (`ctx.cells`,
   `ctx.nodeById`, `ctx.products`, `ctx.operators`, active only), memoised on ctx, and pass
   `() => hint` to `localRecognizer`; the browser recogniser is untouched.
4. Prove it on this machine: take whisper.cpp's sample or a clip you record of "put Operator A3
   on Housing A on Cell 1" (if you can record: a short WAV via any tool; if not, say so) and post
   it with and without the prompt; report both transcripts.
Run `npx vitest run src/test/localRecognizer.test.ts src/test/recognizerHint.test.ts
src/test/commandBar.test.tsx`, `npx tsc --noEmit -p tsconfig.json`, `npx eslint src/lib/voice
src/features/board`. No commits, no plan edits. Report the field name, the hint's shape, the two
transcripts, case counts.
