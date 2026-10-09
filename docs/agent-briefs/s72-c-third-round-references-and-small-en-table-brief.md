# S72-c — the third round's clips get a references file and the small.en table (R-453)

The maintainer spoke the second list (`docs/walks/voice-walk-2026-09-24.md`, 22 sentences) on 24 Sept
between 19:25Z and 19:53Z on small.en (beam, the app's hint). 41 clips landed in
`data/voice/trace/clips/` (the manifest's rows from `2026-09-24T19:25` on); the bar's trace
`data/voice/trace/bar.jsonl` has one entry per clip (same `at`), with `heard` = what Whisper wrote. The
goal (the maintainer: "I want to retest all whisper models, that is the goal") is one table per model on
THESE clips; this lane builds the yardstick row and the file every later row reuses.

## 0. Read first
- `scripts/voice/clips/README.md` ("Against what was actually said" and the replay section) and
  `scripts/voice/clips/score.mjs` (`--from-trace N`, `--references <file>`, `--label`, `--gain`).
- `data/voice/clips/references.json` — the 23 Sept file: `{ "references": { "<at>": "<sentence>" },
  "answers": { "<postedAt>": "<text>" } }`; the lookup falls back from `at` to `postedAt`. Copy its shape.
- The walk document's table (lines 59–80) for the 22 sentences and the answers the walk expects (the
  reason for sentence 4, "yes"/"no"/"Remove it"/"Show that day" for the rest).
- `data/voice/trace/results/` for the earlier tables' file names and the summary lines they print.

## 1. The references file
Write `data/voice/clips/references-2026-09-24.json`. For each of the 41 trace entries from 19:25Z on,
decide what the maintainer actually SAID, in this order of evidence: the walk's sentence when `heard`
is plainly that sentence or a mishearing of it (the trace order follows the list's order: 1, 1, 1, 2,
3, 4 + its reason, 5, 5, 6, 7, 7, 8, 9 ×5, 10, 11, 12 ×3, 13 ×2, 14 ×2, 15 ×2, 16 ×5 (one typed — no
clip), 17, 18, 19 ×2, 20, 21, 22 — check this against `heard` yourself, entry by entry); an ANSWER
clip (`answered` on the previous entry — "Yes.", "Do all 2", "Bracket A", "Tom Baker", the reason for
Lena) is a reference of the answer's words as spoken. Where the maintainer clearly said something OTHER
than the list (a shortened retry like "Close John Kim's block at 10 a.m."), the reference is what was
said, as best `heard` shows, and you mark it in a `notes` object keyed by `at` with one line why. Do not
guess a reference from nothing: an entry whose `heard` is unrelated to any list sentence and any answer
("See you at the next one.") gets the list sentence it sits between in the order (the maintainer said
"clear Cell 6 today" three times) with a note. Numbers as words or digits: match the walk document's
spelling (the scorer normalises am/pm and apostrophes already — read `lib/score.mjs`'s normaliser and
say whether "6am" and "6 a.m." score equal; if not, write the reference the way the document spells it
and report the gap).

## 2. The small.en row
Container `scheduler-whisper` is on small.en now (curl `http://127.0.0.1:8090/` answers). Run
`node scripts/voice/clips/score.mjs --from-trace 41 --references data/voice/clips/references-2026-09-24.json
--label small-en-round3` (check the flag names in `score.mjs`; `--from-trace N` takes the newest N
trace groups — confirm 41 picks exactly the 19:25Z-onward set and no earlier clip; if the count is off,
say why and use the right N). Quote the summary line: mean WER, names hits/total, exact count, wall ms
per clip. Then a second run with `--no-prompt` (no hint) under label `small-en-round3-nohint` for the
"does the hint help" row. Both results land under `data/voice/trace/results/` (gitignored; quote the
path). The machine is shared with two other lanes running vitest: run the scorer alone (it is ~6 s a
clip, so ~4–5 minutes each) and do not run any test suite.

## 3. The table for the maintainer
Write the two rows as a Markdown table into `docs/walks/voice-walk-2026-09-24.md` under a new heading
"Results" at the end: model, decode, hint, WER, names, exact, s/clip — with the 23 Sept small.en row
(0.191, 69/78, 11, 5.7 s, from the plan's session 191 summary) as the comparison line, marked as a
different clip set. Leave rows for tiny.en, base.en, medium.en-q5_0 and large-v3-turbo-q5_0 as "waiting
for the swap". Also list, under the table, the ten worst clips by WER: `heard` beside the reference, one
line each — this is what the maintainer reads.

## 4. Files you own / must not touch
Own: `data/voice/clips/references-2026-09-24.json` (new), `docs/walks/voice-walk-2026-09-24.md` (the
Results section only), `scripts/voice/clips/README.md` (one line naming the new file, if the README
lists the references files). Do not touch `src/`, `docs/plan.yaml`, `score.mjs` (if a flag is missing,
report it; do not add it). No commit, no `docker` commands (the container swap is the maintainer's
hand), no `npm run test`.

## 5. Report
Under 30 lines: the two summary lines verbatim, the worst ten, every reference you had to decide by
note (count and the list), the normaliser answer from §1, and the exact command the main session runs
for the next model after the swap.
