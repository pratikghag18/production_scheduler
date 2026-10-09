# S56-c — a short prompt for training and serving; the long one becomes documentation (R-417)

The maintainer, 15 Sept (session 172): the fifth run's training time is spent re-reading a
1,500-token system prompt before each of 7,000 examples, three times over. Decision: train AND
serve with a short prompt; sort batches by length; a bigger per-step batch on the L4 at the same
effective batch; the long prompt kept as documentation; three epochs kept; the same held-out set
and the same 0.95 bar judge the result, and the fourth run's 99.6 / 97.2 is the number to beat.

`scripts/voice/train/system_prompt.txt` is the ONE prompt: `src/lib/voice/readSentence.ts` imports
it raw for the served bar, `scripts/voice/serve/probe.mjs` reads it, `scripts/voice/train/prepare.mjs`
writes it into every chat row. You own that file, a new `scripts/voice/train/system_prompt.long.md`
(the current text, moved, with a heading saying what it is), the `MAX_LEN`/`BATCH`/`GRAD_ACCUM` lines
of the notebook's Settings cell and the `TrainingArguments` in the Train cell, `scripts/voice/train/README.md`,
`src/test/voiceData.test.ts` (V23 only), `src/test/voiceTrain.test.ts`, `src/test/voiceRead.test.ts`
ONLY if a case pins the prompt's length or wording (check with grep before editing). Nothing else.
The model service on 127.0.0.1:8089 is up; use `POST /tokenize` with a JSON body
`{"content": "..."}` (write the body to a file and `curl --data-binary @file`) to measure. Do not
stop it. Edit the notebook only through a node script that parses the JSON and writes it back with
the same formatting; every other cell byte-identical.

1. **The short prompt** (target 120–180 tokens, measured): one paragraph in the same register,
   saying: turn one sentence about the production board into a JSON form, answer with the JSON
   object only; the ten intents by name (assign, book, unassign, move, several, replace, swap,
   copy, split, headcount); every field must be present and attach/existing are always null; a
   shift name stands in for hours and never both; "everyone" is a reserved operator word; day
   words are today, tomorrow, yesterday, a weekday, a date, this week, next week, last week,
   every weekday, every day. No field-by-field paragraphs — the examples teach the shapes and the
   served model is forced through the schema. V23's vocabulary guard must still pass: every intent
   word and the words it checks appear in the prompt (read V23 first and write the prompt so its
   list holds; if V23 checks a word that has no place in a short prompt, re-pin V23 with the
   reason, naming R-417).
2. **The long prompt** moves verbatim to `system_prompt.long.md` under a heading: "The long form of
   the prompt, kept as the human-readable description of every field. Not read by any code since
   R-417 (15 Sept); the short prompt in system_prompt.txt is what the model is trained and served
   with." The README says the same in its prompt paragraph.
3. **The notebook**: `BATCH = 16`, `GRAD_ACCUM = 2` (the assert on 32 holds); `group_by_length=True`
   in `TrainingArguments`; `MAX_LEN` re-measured — run `npm run voice:prepare` after the prompt
   change, measure the longest prepared example's tokens through `/tokenize`, set `MAX_LEN` to the
   next 128 above it (expect around 512), and say the number. `EPOCHS` stays 3.
4. `npm run voice:prepare`: the Colab folder is rebuilt (the notebook copy included). Report the
   manifest's numbers and the longest example.
5. Tests: `npx vitest run src/test/voiceData.test.ts src/test/voiceTrain.test.ts src/test/voiceRead.test.ts`,
   `python scripts/voice/train/check_notebook.py` on the source and the copy, `npm run voice:probe -- "put Sam on Housing A on Cell 1 from 8 to 4"`
   (the SERVED model is the fourth run's, trained on the long prompt: the probe with the short prompt may
   read worse — report what it does, it is expected and is why the fifth run is scored before it
   ships). No full suite, no commits, no plan edits.

Report: the prompt text and its token count; the longest example and MAX_LEN; the batch lines;
the probe's answer; test counts; anything V23 needed.
