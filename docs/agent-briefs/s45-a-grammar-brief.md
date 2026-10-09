# Brief S45-a: the service refuses a wrong key by grammar, measured (Stage 5b)

Stage S45, requirement R-393, design §19.93 (D122). Another lane (S46, the microphone) is
editing `CommandBar.tsx`, its CSS module, `BoardPage.tsx` and `src/test/commandBar.test.tsx`
at the same time; you never touch those.

## 1. What exists

- The service: `npm run voice:serve` starts llama.cpp's server in the container
  `scheduler-voice` on `http://127.0.0.1:8089` (`scripts/voice/serve/serve.mjs`). It may
  already be running (`docker ps`); if so use it, do not restart it.
- The probe: `scripts/voice/serve/probe.mjs` sends one sentence, or the held-out set with
  `--heldout data/voice/heldout.jsonl --out <predictions.jsonl> [--limit N]`, resuming by id.
  It builds the request body in one place; find it.
- The reader: `src/lib/voice/readSentence.ts` builds the same body for the app. Its tests are
  `src/test/voiceRead.test.ts` (VR1–VR7; VR6 asserts the body's fields exactly).
- The decoder: `src/lib/voice/decode.ts` — the four forms' fields and shapes. The schema must
  agree with it field for field.
- The served file's score without a grammar, all 400 rows (session 157):
  clean 196/200, perturbed 185/200; misses include three answers that wrote `type` instead of
  `intent`, and "extra keys ignored: 8 rows (toPlace: 3, type: 6)". The predictions are at
  `data/voice/runs/served-q4/predictions.jsonl` — keep that file; it is the "without" table.
- llama.cpp's server accepts, on `/v1/chat/completions`, the OpenAI-style
  `"response_format": {"type": "json_schema", "json_schema": {"schema": { ...JSON schema... }}}`
  and converts the schema to a grammar per request. Verify the exact field names against the
  running server by sending one request; if it errors, read the server's response text, which
  names what it expected, and say in the report what the server accepted.

## 2. What to build

1. `scripts/voice/serve/form.schema.json` — one JSON schema for the answer: `oneOf` (or
   `anyOf`, whichever the server converts) of four objects, one per intent, each with
   `additionalProperties: false`, every field `required`, and **properties listed in
   alphabetical order** (the model writes keys alphabetically; the grammar must not demand
   another order). Shapes: `intent` a `const`; `operator`/`product` strings; `place` an array
   of strings (`minItems: 1`); `toPlace` an array of strings or null; `day` null or one of
   `{kind:"today"}`, `{kind:"tomorrow"}`, `{day: 0-6 integer, kind:"weekday"}`,
   `{iso: string, kind:"date"}` (alphabetical inside too); `start`/`end`/span's
   `{hour: integer, minute: integer}`; `span` null or `{end, start}` (alphabetical);
   `headcount` integer or null; `attach` and `existing` null. Keep it readable: define the time
   object and the day object once under `$defs` and `$ref` them if the server's converter
   supports `$defs`/`$ref` (llama.cpp's does); otherwise inline.
2. `probe.mjs`: send the schema by default under `response_format`; `--no-grammar` sends the
   body exactly as before. Print which mode ran in the first line of output.
3. `readSentence.ts`: import the schema (`import formSchema from "../../../scripts/voice/serve/form.schema.json"`;
   Vite and vitest resolve JSON imports; if tsc needs `resolveJsonModule`, check `tsconfig`
   and say so — do not copy the schema into `src`) and send it under `response_format` in
   every request. Update VR6 to assert the body carries `response_format` with that schema
   object, byte-equal to the file's parsed content.
4. Test, in `src/test/voiceRead.test.ts` (VR8): for each of the four canonical forms
   (`parseCommand` of a fixed sentence per intent), assert that every key in the form is a
   property of the matching schema branch, that the branch's `required` list equals the
   form's keys, and that the properties are in alphabetical order. No schema-validation
   library (no new dependencies): a small hand-written walk is enough.
5. `scripts/voice/serve/README.md`: two sentences on the grammar (what it forbids, that
   `--no-grammar` exists for measuring) and where the schema file is.

## 3. Measure (required)

- With the container up (start it if it is not; `npm run voice:serve` in the background):
  `npm run voice:probe -- --repeat 2 "put Ana Silva on Housing A at Cell 1 tomorrow from 8 till noon"`
  with the grammar; paste the form and both timings. Then the same with `--no-grammar` and
  paste the timings, so the grammar's cost is visible.
- The full held-out set with the grammar:
  `npm run voice:probe -- --heldout data/voice/heldout.jsonl --out data/voice/runs/served-q4-grammar/predictions.jsonl`
  This takes about 40 minutes at six seconds a row. Run it as a DETACHED process (PowerShell
  `Start-Process node -ArgumentList ... -WindowStyle Hidden -RedirectStandardOutput <log>`)
  so no tool timeout kills it, and poll the file's line count every few minutes with a light
  command; the machine is short on memory, so run nothing heavy meanwhile. If the system kills
  it, run the same command again; it resumes.
- Score: `node scripts/voice/score.mjs --heldout data/voice/heldout.jsonl --predictions data/voice/runs/served-q4-grammar/predictions.jsonl --bar 0.95`
  and paste the whole table. Also paste the "without" table from
  `data/voice/runs/served-q4/predictions.jsonl` (score it the same way) so both sit in the
  report.
- List every row that is still wrong with the grammar (sentence, expected field, got), the
  way a python one-liner over the two files would.
- Leave the container running at the end.

## 4. Rules

- Files you own: `scripts/voice/serve/form.schema.json`, `scripts/voice/serve/probe.mjs`,
  `scripts/voice/serve/README.md`, `src/lib/voice/readSentence.ts`, `src/test/voiceRead.test.ts`,
  and `tsconfig*.json` only if a JSON import setting is needed. Nothing else.
- No new dependencies. Do not run the full `npm run test`; run `npx vitest run src/test/voiceRead.test.ts`,
  `npx tsc --noEmit -p .`, eslint and prettier on your files. Do not commit.
- Report: the schema's shape in five lines, the request field the server accepted, the probe
  timings with and without, both score tables, the remaining misses, the vitest/tsc/lint
  results, `git diff --stat`.
