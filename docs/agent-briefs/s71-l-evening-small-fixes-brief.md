# S71-l — the evening walk's small fixes: F-211, F-214, F-216, F-213

Four findings from the 23 Sept evening walk (`docs/plan.yaml`, `grep -n "id: F-21[1346]" -A 18`).
Each is a few lines with a pin. F-214 matters most: the first word of the sentence is where the
walk went wrong. Another lane (S71-m) is editing `CommandBar.tsx` around `applyReading` (~2070)
and `src/test/commandBar.test.tsx` at the same time: you may touch CommandBar.tsx ONLY at the one
line named in §2 and you must not open commandBar.test.tsx.

## 1. F-211 — the leading dash
whisper.cpp writes a dialogue dash for a clip that starts mid-utterance: "-Assign Priya Shah…",
"- Assign…", "-2, Area 2…", "-A, Sign Lena Novak…". The parser then reads "-assign Priya Shah" as a
person. In `src/lib/voice/localRecognizer.ts`, `stripNonSpeechTags` (F-201) also strips any run of
leading hyphens, en dashes or em dashes and the whitespace after them (only at the START of the
transcript; a dash inside the text stays). Pins LREC-29f (`"-Assign Sam"` → `"Assign Sam"`),
LREC-29g (`"- Assign Sam"`, `"—Assign"`, `"-- Assign"`), LREC-29h (a dash inside stays), and a
tag-then-dash combination `"[Music] -clear Cell 3"` → `"clear Cell 3"`.

## 2. F-214 — Listening announced before the microphone is open
`localRecognizer.ts` ~694 fires `events.onStatus?.("listening")` BEFORE `d.getUserMedia(...)` is
even called; the microphone and the audio graph take a few hundred milliseconds; the bar shows
"Listening…" at once and the person begins the sentence before capture is live. Evidence: three
loud clips are mid-sentence in their first frame, fourteen transcripts open with the dash, and the
first word is the one misheard ("M Sam Patel", "Head, Sam Patel", "Assail", "-2, Area 2", "EF76.").

Move the `onStatus("listening")` call to the point where the audio graph is connected and
`recordingStartedAt` is set (inside the getUserMedia `.then` where `processorNode` is wired), so
the phase is announced when the first frame can actually arrive. `withFallback`'s own
`onStatus("listening")` on the fallback leg (S71-j) stays. In `CommandBar.tsx`, delete the ONE line
`setMicPhase("listening");` in `startListening` (~3565) and its comment above it (the browser
engine case it defends: instead, make `browserRecognizer` in `src/lib/voice/recognizer.ts` fire
`events.onStatus?.("listening")` from the engine's own `onstart` handler, so both engines announce
the phase themselves and the bar never guesses). Touch nothing else in CommandBar.tsx.

Pins: LREC-33a — with a `getUserMedia` that resolves only after a tick, `onStatus("listening")` is
NOT called before it resolves and IS called once after the processor is connected; LREC-33b —
`stop()` before getUserMedia resolves never announces listening; `voiceRecognizer.test.ts` VR-x —
the browser engine's `onstart` announces listening. Do not add a CommandBar pin (that file's tests
are the other lane's); say in the report which existing CB-mic case (CB-mic-2 documents the
synchronous set) now needs rewriting and I will hand it to that lane.

## 3. F-216 — "split Sam Patel's block at 1pm"
`"Split, Sam Patel, Block at 1 p.m."` and `"Split, Sam Patel's Block at 1 p.m."` were refused No cell
called "Block"; only "assignment" parses. In `src/lib/command/parse.ts` find the split grammar
(`grep -n "split" src/lib/command/parse.ts`) and accept "block" wherever it accepts "assignment"
(and "shift" if that is already a synonym elsewhere — check `parseHeadcountRest`/the adjust grammar
for the noun list they accept, and use the same list, extracted not retyped). A comma after the
person ("Sam Patel, Block") is Whisper's punctuation; the parser already strips commas somewhere —
confirm and pin. Pins in `src/test/commandParse.test.ts` (`SP-` series or whatever the split cases
are called): the two heard strings above parse to the same split as the "assignment" form.

## 4. F-213 — "Cell 5 is in Cell 5"
`src/lib/command/resolve.ts` ~5042: `There is no ${q.cell} in ${q.qualifier}. ${q.cell} is in
${q.elsewhere}` printed "Cell 5 is in Cell 5 — Plant A › Area 2 › Line 3" because `elsewhere` was
built from the cell's own label with its path. Make `elsewhere` the PARENT's name with the path
("Line 3 — Plant A › Area 2 › Line 3"), and offer the parent as a button (R-430: the refusal
carries the nearest choice) if the question shape allows candidates; if it does not, say so and
only fix the wording. Pin in `src/test/commandResolve.test.ts`: the message names the parent, never
the cell twice.

## 5. Run
`npx vitest run src/test/localRecognizer.test.ts src/test/voiceRecognizer.test.ts
src/test/commandParse.test.ts src/test/commandResolve.test.ts`; prettier, eslint, `npx tsc -b`.
Files you own: `localRecognizer.ts`, `recognizer.ts`, `parse.ts`, `resolve.ts`, the one CommandBar
line, and the four test files above. No `npm run test`, no commit, no `docs/plan.yaml`, no
dev-server or container restart, no git stash.

## 6. Report
Under 25 lines: where `onStatus("listening")` fires now (line), the dash rule, the split nouns
accepted, the new refusal wording, the pin ids, totals, and the CB-mic case that needs rewriting.
