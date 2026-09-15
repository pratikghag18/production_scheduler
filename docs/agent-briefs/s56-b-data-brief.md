# S56-b — the data's second pass: S58's shapes, the move form's adjust, and the flags from the first pass (R-410, R-412 to R-416, D132)

You are the one lane of S56's second pass. Read the first pass's brief
(`docs/agent-briefs/s56-a-data-brief.md`) for the file list you own — the same, plus
`scripts/voice/lib/time.mjs` and `scripts/voice/train/prepare.mjs` this time — and its rules
(verbs and constants imported from `parse.ts`, forms built from slots never from `parseCommand`,
the oracle in `generate.mjs`). Read `docs/design-plan.md` §19.103 (D132), the S58-a brief
(`docs/agent-briefs/s58-a-grammar-brief.md` §1–§2: every sentence there is a shape), and lane A's
landed `parse.ts` header. S58 is committed when you start.

The model service is at http://127.0.0.1:8089 for `/tokenize`; do not stop it. Run `npx vitest
run src/test/voiceData.test.ts src/test/voiceTrain.test.ts`, `npm run voice:generate`, `npm run
voice:score`, `npm run voice:prepare`. No full suite, no commits, no plan edits.

## 1. The form's growth
Every move template's form gains `adjust: null` (one comment). `INTENTS` gains `"split"` and
`"headcount"` (ten). Held-out: regenerated on the SAME seed 20260915, still 100 per intent (1000
rows); `voice:generate` at `--n 7000`. Re-pin V4 with the reason.

## 2. Templates (ids and shapes)
- move/adjust: `M13-extend-by` (extend/lengthen/shorten by N minutes / an hour / N hours, with
  and without a place), `M14-end-at` (end/finish at T, early at T, N earlier/later), `M15-edge-tail`
  (move/shift/change X's start|end|finish to T / by D / an hour later|earlier).
- split: `X1-split-at` (split X's block at noon / at T; with and without a place and a day).
- assign, the job's hours: `A21-add-to-job` (add/put X to|on the <part> job|run on <cell> [day]);
  a quoted part that contains a keyword.
- headcount: `H1-make-job-people` (make the <part> job on <cell> N people), `H2-set-job-to`
  (set … to N people), `H3-with-hours-or-shift` (a span or a shift narrowing the job).
- repeat days: `A22-every-weekday` (assign, this/next week, hours or a shift), `B11-every-day`
  (book, every day next week, with a headcount sometimes).
- F-146 in the data: `time.mjs`'s `buildTimePair` must be able to say an END of midnight (the
  first-pass reviewer found it never could): an end token "midnight" / "12 am" / "24:00" writes
  `DAY_END` {23,59} on every intent; add `A23-to-midnight` (assign/book from an evening start to
  midnight, and a duration landing on midnight) and make `randomSpan` draw it sometimes. A START
  of midnight stays {0,0}.
- Every existing template unchanged otherwise.

## 3. The prompt
Paragraphs, in the same register: the move's `adjust` (edge, `by` signed minutes or `at`, and
that span/shift/toPlace are then null); `split`; `headcount`; the reserved shift name "the job";
the two repeat day kinds and that they appear only on an assign or a booking; "make it N people" is
not a sentence (say the job). Measure the prompt with `/tokenize` (stay under 1500) and the longest
prepared example; raise the notebook's `MAX_LEN` to the next 128 above it only if it passes 1536,
and say so.

## 4. The first pass's flags
- `prepare.mjs`: `HELDOUT_SEED` is hard-coded at 20260911 and the manifest reports it — make it
  read the seed the README documents (a constant beside the held-out command, or the value
  written into the held-out file's first line if the generator stamps one — check), and pin that
  the manifest says 20260915.
- `perturb.mjs`'s `speech-digit-as-word` turning an ISO date's zero-padded month into a word
  ("2026-one-28"): make the perturber skip digits inside an ISO date (a small regex guard), pin it.

## 5. Baseline, README, prepare, tests
As the first pass: the two baseline numbers, the READMEs (the second regeneration, same seed,
ten intents, the count), `npm run voice:prepare` and the manifest's numbers; V27 onward for each
new template family, the scorer on a `split` and a `headcount` row, the prompt-vocabulary guard
extended to the new intent words, the midnight span, the seed in the manifest, the perturber guard.

## 6. Report
Template count before/after; held-out per intent; the baselines; prompt and longest-example
tokens; MAX_LEN; manifest numbers; anything from the S58-a brief you could not template; test
counts.
