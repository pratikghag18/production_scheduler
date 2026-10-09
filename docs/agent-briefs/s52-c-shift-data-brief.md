# Brief S52-c: the data learns change, shift, and a shift by name

Stage S52, requirements R-401 and R-402 (read them in `docs/plan.yaml`), design §19.99 (D128).
Lane S52-a (the grammar) is committed: `MOVE_VERBS` has change and shift; a move reads the
possessive tail ("A3's timing"); every single form has `shift: string | null` (assign/book
with a shift have start/end null; unassign/move with a shift have span null); an assign may
put the product last ("… on Cell 1 in Line 1 for Housing A"). The named shift clause takes
only `for` and `during` (`for shift 2`, `during shift 3`) — never `on`/`in`, which are place
prepositions; "the X shift" takes `for|on|during` (`on the night shift`). `formatCommand`
quotes a shift name of more than one word. Lane S52-b (the resolver) runs
at the same time and owns `src/lib/command/resolve.ts`, `src/features/board/**`,
`src/test/commandResolve.test.ts`, `commandBar.test.tsx`; do not touch those. You built
S50-b; the same files are yours again.

## 1. What exists (read first)

- `scripts/voice/lib/templates.mjs` (yours from S50-b), `rows.mjs`, `perturb.mjs`,
  `pools.mjs`; `scripts/voice/train/system_prompt.txt`; `scripts/voice/serve/form.schema.json`
  (`$defs` with the four branches and `several`); `src/lib/voice/decode.ts` (lane A added
  `shift`); `scripts/voice/lib/form.mjs` (lane A may have made `canonical` treat a missing
  `shift` as null — read it and its comment; once the held-out set is regenerated with the
  field, remove that tolerance and say so); `src/test/{voiceData,voiceRead,voiceTrain}.test.ts`.
- The demo plant's shifts (`supabase/seed.sql` ~line 138): "Shift 1" 06:00–14:00, "Shift 2"
  14:00–22:00, "Shift 3" 22:00–06:00. Realistic names to add to `pools.mjs`: Morning, Day,
  Afternoon, Evening, Night, Nights, Early, Late, A, B, C, Day A, Day B, First, Second, Third,
  Weekend, Late Turn.

## 2. What to build

1. **Verbs.** Nothing to add: the move templates draw from `MOVE_VERBS` and V9 proves every
   verb opens a clean row. Add ONE template `M10-change-timing`: `${pick(change, shift)}
   ${op}'s ${pick(timing, hours, time)} to ${span}` → move, place [], toPlace null, span. And
   a perturbation (or a template variant) that writes the possessive without the apostrophe
   (`operator a3s timing`), the way the recogniser does (F-144).
2. **Shift by name.** Templates: `A9-shift` (assign, `… for shift ${name}` in place of the
   hours), `A10-shift-product-last` (the maintainer's order: `${verb} ${op} to work for shift
   ${name} on ${cell} in ${line} for ${part}`), `A11-the-x-shift` (`on the ${word} shift`),
   `B7-shift` (book), `U11-shift` (unassign `for shift ${name}`), `M11-shift` (move `during
   shift ${name}`, toPlace null), `S7-several-shift` (two people, one cell, `for shift
   ${name}`). Forms: `shift` the name as written (`"2"`, `"Shift 2"`, `"night"`), start/end
   or span null. Names drawn from a `SHIFTS_DEMO` (`Shift 1`, `Shift 2`, `Shift 3`, `1`, `2`,
   `3`) and `SHIFTS_REALISTIC` pool. Every other template sets `shift: null` (lane A's
   `baseCommand`).
3. **The held-out set.** Regenerate with the committed seed; it grows by the new templates'
   share (still 100 rows per intent — the count per intent is fixed by `generateHeldoutRows`;
   say what the new total is). Re-pin V4 and the baseline in V6/V13 from the runner. Then
   remove the missing-`shift` tolerance in `form.mjs` if lane A added one, and prove the
   training generation runs with zero oracle mismatches.
4. **The prompt.** One sentence per intent that has hours: "When the sentence names a shift
   instead of hours ("for shift 2", "on the night shift"), shift is the shift's name exactly as
   said and start and end are null" (assign/book) / "… and span is null" (unassign/move); a
   sentence in the general rules: "shift is null whenever hours are given; never both."; the
   move paragraph gains "change and shift are move verbs; "change A3's timing to 8 pm to
   11 pm" is a move of A3 in time with no place". Keep every existing sentence.
5. **The schema.** Lane A already added `shift` to the four `$defs` and made `start`/`end`
   nullable in assign/book (VR8 green); verify, change nothing else. Re-measure the prompt's token count with the
   served model's `/tokenize` if the container is up (`docker ps`), else estimate from the
   added characters, and report it against the notebook's 1280 cap with the longest example
   (use the `measure-len.mjs` approach: longest `train.chat.jsonl` row through `/tokenize`).
6. **Tests.** `voiceData.test.ts`: V4/V6/V13 re-pinned, V15 (a shift template's form has
   start/end null and a name; the oracle holds), V16 (the apostrophe-less possessive parses
   to the same move). `voiceRead.test.ts`: VR13 (schema: `shift` present in all four `$defs`,
   nullable start/end only in assign and book, alphabetical). Run `npx vitest run
   src/test/voiceData.test.ts src/test/voiceRead.test.ts src/test/voiceTrain.test.ts
   src/test/commandParse.test.ts src/test/commandPurity.test.ts`, `npx tsc --noEmit -p .`,
   eslint and prettier on your files, `npm run voice:generate` then `npm run voice:prepare`.

## 3. Rules

- Files you own: `scripts/voice/lib/{templates,rows,perturb,pools,form}.mjs` and `.d.mts`,
  `scripts/voice/train/system_prompt.txt`, `scripts/voice/serve/form.schema.json`,
  `data/voice/heldout.jsonl`, the three voice test files, the two READMEs if a count changes.
  Not `parse.ts`, not `decode.ts` (lane A finished it; report a gap instead), not the
  notebook, not `docs/plan.yaml`.
- The oracle is the law. No new dependencies. Do not run the full `npm run test`. Do not
  commit. Do not start or stop the model container.
- Report: files with a line each; the new template ids with one example sentence each; the
  held-out total and per-intent counts; the baseline (clean, perturbed) from the runner; the
  prompt's added sentences verbatim; the token measurement; each new test title;
  vitest/tsc/lint summaries; the manifest lines; `git diff --stat`.
