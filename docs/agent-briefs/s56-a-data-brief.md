# S56-a — the data widens for S55's shapes and the fifth run is prepared (R-405, R-410, D126/D130)

You are the one lane of S56. You own `scripts/voice/lib/*.mjs` (and their `.d.mts`),
`scripts/voice/train/system_prompt.txt`, `scripts/voice/train/score_port.py`,
`scripts/voice/train/README.md`, the `MAX_LEN` cell of `scripts/voice/train/train_qwen3.ipynb`,
`data/voice/heldout.jsonl`, `data/voice/README.md`, `src/test/voiceData.test.ts`,
`src/test/voiceTrain.test.ts`, and `package.json`'s `voice:generate` line only. Nothing else.

S55 has landed: read `docs/design-plan.md` §19.101 (D130) and §19.97 (D126: data follows the
grammar), the S55-a brief (`docs/agent-briefs/s55-a-grammar-brief.md` §1–§3: every sentence there
is a shape the data must carry), the header of `scripts/voice/lib/templates.mjs`, `rows.mjs`,
`perturb.mjs`, `score.mjs`, the S50-b and S52-c briefs for the house style, and
`scripts/voice/serve/form.schema.json` (lane C's, the shapes the served model may emit).

Run `npx vitest run src/test/voiceData.test.ts src/test/voiceTrain.test.ts`, `npm run
voice:generate`, `npm run voice:score` (the rule parser's baseline), `npm run voice:prepare`. No full
suite, no commits, no plan edits.

## 1. Intents and counts
`INTENTS` in `rows.mjs` gains `"replace"`, `"swap"`, `"copy"` (eight). The held-out set is
REGENERATED once more, with the new seed 20260915 and 100 rows per intent (800 rows, half clean,
half perturbed per intent) — the README's own rule for when a regeneration is allowed (a plan entry
will say so). Re-pin V4 to 800 rows and eight intents with the reason. `voice:generate` moves to
`--n 6000` so each intent keeps roughly the rows it had.

## 2. Templates — one per shape of the S55-a brief, drawing verbs from `parse.ts`'s exports
Import the new constants (`REPLACE_VERBS`, `SWAP_VERBS`, `COPY_VERBS`, `ABSENCE_WORDS`,
`TIME_OF_DAY_WORDS`, `EVERYONE`, `ALL_DAY`, `END_OF_SHIFT`, `END_OF_DAY`, `DAY_END`) — never retype
a word the grammar owns. Each template's `form(slots)` is built from the slots, never from
`parseCommand` (the oracle in `generate.mjs` checks the two agree). Ids and shapes, at least:
- assign: `A14-duration` (from T for N hours / an hour / N and a half hours / N minutes, the end
  computed in the template), `A15-all-day`, `A16-from-until-end-of-shift`, `A17-rest-of-day` (with
  and without a start), `A18-works-on`, `A19-cell-gets`, `A20-time-of-day` (this afternoon /
  tonight / tomorrow morning / for the night).
- book: `B8-cell-runs` (with and without `with N people`), `B9-duration-headcount`, `B10-all-day`.
- unassign: `U12-take-off`, `U13-pull-time-of-day`, `U14-after-edge` (end = `DAY_END`),
  `U15-before-until-edge`, `U16-clear-cell` (operator `EVERYONE`, place, day), `U17-everyone-after`
  (a from-place everyone with an edge), `U18-absence-day` (X is off/out/sick today/tomorrow →
  place [], `until` null; a bare "Sam is out" → day today), `U19-absence-until` (on leave till /
  away until a weekday or a date; with and without a from-day), `U20-rest-of-day`.
- move: `M12-move-everyone` (on/from a place to a cell, with and without a day).
- replace: `R1-cover-place-day`, `R2-replace-bare` (place []), `R3-cover-hours`, `R4-replace-shift`.
- swap: `W1-swap-and`, `W2-swap-with-place-day`, `W3-exchange`.
- copy: `C1-same-as-yesterday` (with and without a place), `C2-copy-weekday-to-weekday`,
  `C3-week` (repeat this week next week / copy this week to next week), `C4-same-as-last-week`,
  `C5-dates`.
The pools (`pools.mjs`) already hold people, parts, cells, lines, shifts; add nothing to the
demo pools that is not a real fixture name. Perturbations (`perturb.mjs`) apply as they do: check
that none of the existing perturbers breaks a form-bearing unit word in a way that makes a
perturbed row's CLEAN form wrong — the recorded form is the clean sentence's, V3 pins that.

## 3. The scorer and its Python port
`score.mjs`'s by-field tally must cover the new intents' fields (`with`, `other`, `from`, `to`,
`until`) and the port `score_port.py` must print the same table on the same file (the parity case
in `voiceTrain.test.ts` — extend its fixture with a row per new intent). `form.mjs`'s canonical
form handles the new shapes without a special case; if it does not, fix it there once.

## 4. The system prompt
Add to `system_prompt.txt`, in the same plain register: the four day words; the three reserved
shift names and that the two "end of" names may carry a start; a start and a length → the end
computed; "after T" on a removal → end 23:59, "before/until T" → start 00:00; the time-of-day
words are a shift's name; `everyone` on a removal or a move, and "clear <place>"; an absence →
unassign with place [] and `until`; the three new intents with their fields; that a `several`
never holds them. Keep the whole prompt under 1400 tokens — measure with the running service
(`curl -s http://127.0.0.1:8089/tokenize -d '{"content": ...}'`, or count words × 1.4 and say
which you did). Then run `npm run voice:prepare` and measure the LONGEST prepared example the same
way; if it is over 1200 tokens, raise `MAX_LEN` in the notebook to the next 128 above it and say
so.

## 5. Baseline, README, prepare
`npm run voice:score` prints the rule parser's baseline on the new held-out (clean must be 1.0;
perturbed is whatever it is — record both numbers in your report). Update `data/voice/README.md`
(the regeneration, its seed and date, the eight intents, the count) and the train README's
"what good looks like" if the bar wording needs the new count. `npm run voice:prepare` writes
`data/voice/colab/` — report the manifest's row counts.

## 6. Tests
V19 onward: every new template's fixed-slot sentence parses to its recorded form (V2 covers it
automatically — confirm the count of templates it walked); the held-out shape (V4 re-pinned); the
scorer on a `copy` and a `replace` row (right, wrong field, missing `until`); a perturbed
absence row keeps its clean form; the prompt mentions every new intent word (a cheap guard against
a prompt that drifts from the schema).

## 7. Report
The template count before and after; the held-out counts per intent; the two baseline numbers; the
prompt's token count and the longest example's; `MAX_LEN` if changed; the manifest's numbers; any
sentence shape from the S55-a brief you could not template and why; the test counts before and
after for the two files.
