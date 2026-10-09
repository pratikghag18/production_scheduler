# S58-c — the decoder and the schema for group 2 (R-412 to R-416, D132)

You are lane C of S58. You own `src/lib/voice/decode.ts`, `src/test/voiceRead.test.ts`,
`scripts/voice/serve/form.schema.json` and `scripts/voice/serve/README.md` only. Lane A has landed
the types (`docs/agent-briefs/s58-a-grammar-brief.md` §1). Read `docs/design-plan.md` §19.103
(D132) and the S55-c brief for the house rule: the schema is the fence the served model is forced
through and must be exactly as strict as the decoder. Run only `npx vitest run
src/test/voiceRead.test.ts` and `npx tsc --noEmit -p tsconfig.json`. No commits, no plan edits.

- `move` gains `adjust` (REQUIRED, `null` or `{edge, by}` or `{edge, at}`; `by` a non-zero integer;
  when set, `span`, `shift` and `toPlace` must be null — the decoder garbles otherwise).
- New top-level decoders `split` (operator, place, day, at) and `headcount` (product, place, day,
  span, shift, headcount 1–99). Neither may appear inside a `several`.
- `day_word` stays the five day kinds; a new `$defs.repeat_day_word` (weekdays / every_day with
  week this_week | next_week) is admitted ONLY on `assign.day` and `book.day` (as `oneOf
  [day_word, repeat_day_word]`); the decoder mirrors: a repeat kind on any other form's `day`, on
  `until`, or on a copy's from/to is garbled.
- `shift` strings are free text as before ("the job" needs nothing new).
- Extend the VR18-style structural walk of the schema so it proves: `adjust` required on move;
  repeat kinds reachable only from assign/book `day`; split and headcount present at the top,
  absent from the several's inner union. Cases VR20 onward: each new decoder happy path; adjust
  with span set garbled; by = 0 garbled; a split inside a several garbled; a repeat day on an
  unassign garbled; the schema/decoder agreement.
- README: one paragraph for the S58 shapes.
Report: case names, decisions, tsc errors outside your files, counts.
