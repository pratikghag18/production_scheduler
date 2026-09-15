# F-151 (second half) — a lone START of 6 is the morning; the data follows the rule; one pin looks up by ref

Three things the full suite showed after S59/S60 landed (15 Sept, session 174):

1. **The rule's edge is wrong for a plant whose first shift starts at 06:00.** F-151 made a lone
   start before a boundary or a length read by the workday rule "1 to 6 is the afternoon", so
   "from 6 for 8 hours" became 18:00, and the training data's own "from 6 for 15 minutes" no
   longer parses as recorded. Every demo plant's Shift 1 starts at 06:00; a scheduler who says
   "from 6" means the morning. New rule, for a lone START only: hours 1 to 5 with no am/pm read
   as the afternoon, 6 to 12 stay as said; a lone END (RM6 "before 2", AJ7 "end Sam early at 3",
   the pair grammar's end) keeps 1 to 6. You own `src/lib/command/parse.ts` and
   `src/test/commandParse.test.ts`: change the start rule, re-pin LS6 (6 → 06:00, with the
   reason) and add LS13 ("from 5 for 4 hours" → 17:00) and LS14 ("from 6 until end of shift" →
   06:00 to the first band's end, resolver-side is unchanged).
2. **The data follows the grammar (D126).** `scripts/voice/lib/templates.mjs` and `time.mjs`: the
   templates that draw a lone start (A14-duration, A16, A17, B9, B10, U20 and any other with a
   boundary or a length) compute their recorded form with the same start rule (a `resolveLoneStart`
   beside `resolveLoneTime` in time.mjs, or an option on it); regenerate `data/voice/heldout.jsonl`
   on seed 20260915 and `data/voice/train.jsonl` (`npm run voice:generate`), then `npm run
   voice:prepare`. You own those two lib files, `data/voice/heldout.jsonl`, `data/voice/README.md`
   (a note: regenerated a fourth time on the same seed for F-151's rule; the fifth run's score
   stands against the file as it was at 36b684d; the sixth run's data carries this), and
   `src/test/voiceData.test.ts` (V4/V6/V9/V13/V25 must pass again; re-pin V6/V13's baseline
   number with the reason if it moves).
3. **One live pin names the renamed person.** `src/test/defects/DEF-0022.test.ts` looks up
   "Operator A2" by display name; R-423 renamed that person to Maria Lopez. Change ONLY the
   lookup to `.eq("employee_ref", "EMP-1002")` with a one-line comment naming R-423, and the
   error text to name the ref; nothing else in the tester's pin. Run it: `npx vitest run
   src/test/defects/DEF-0022.test.ts` (it needs the live database, which is up).
Run `npx vitest run src/test/commandParse.test.ts src/test/commandPurity.test.ts src/test/voiceData.test.ts
src/test/voiceTrain.test.ts src/test/defects/DEF-0022.test.ts`, `npm run voice:score` (clean must be
1.0), `npx tsc --noEmit -p tsconfig.json`. No commits, no plan edits. Report the rule, the
baseline numbers, and the counts.
