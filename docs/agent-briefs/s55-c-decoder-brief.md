# S55-c — the decoder and the form schema read S55's shapes (R-408 to R-410, D130)

You are lane C of S55. You own `src/lib/voice/decode.ts`, `src/test/voiceRead.test.ts`,
`scripts/voice/serve/form.schema.json` and `scripts/voice/serve/README.md`, nothing else. Lane A
has landed the types in `src/lib/command/parse.ts`; read its header and the S55-a brief
(`docs/agent-briefs/s55-a-grammar-brief.md` §1) for the exact names. Read the header of
`decode.ts` (F-140's lesson: read known fields, build a fresh object, never hand back the input)
and `docs/design-plan.md` §19.101 (D130 item 2) first.

Run `npx vitest run src/test/voiceRead.test.ts` and `npx tsc --noEmit -p tsconfig.json` (errors in
`resolve.ts`, `CommandBar.tsx`, `BoardPage.tsx` belong to lanes B and D — list, do not fix). No
full suite, no commits, no plan edits.

## 1. `decode.ts`
- `DayWord`: the four new kinds (`yesterday`, `this_week`, `next_week`, `last_week`) decode; the
  week kinds are accepted ONLY on a `copy`'s `from`/`to` — on any other form's `day`, or on
  `until`, a week kind is garbled (the grammar never produces it there; the model must not either).
- `unassign` gains `until`: REQUIRED (missing is garbled, the same strictness `shift` got at VR8),
  `null` or a day kind.
- Three new top-level decoders: `replace` (`operator`, `with`, `place` string array possibly
  empty, `day`, `span`, `shift`), `swap` (`operator`, `other`, …), `copy` (`place`, `from`, `to`).
  No `existing`/`attach` on these; an extra key is ignored, as everywhere. A `several` still holds
  only the four singles — a `replace` inside `commands` is garbled.
- Update the header comment with the S55 paragraph; export nothing new beyond what the bar needs
  (it calls `decodeCommand` as before).

## 2. `form.schema.json` (the grammar the served model is forced through)
- `day_word`: four more `oneOf` members.
- `unassign`: `until` property (`null` or `day_word`), added to `required`.
- `$defs.week_word`: `this_week` | `next_week` | `last_week`; `$defs.copy` with `from`/`to` as
  `oneOf [day_word, week_word]` (the day-vs-week pairing is the grammar's check, not the schema's).
- `$defs.replace`, `$defs.swap`; the top-level `oneOf` gains the three; the `several` branch's inner
  `oneOf` stays the four.
- Keep keys sorted as the file has them; `additionalProperties: false` everywhere.

## 3. Tests (`voiceRead.test.ts`) — VR14 onward
Each new decoder: a well-formed answer decodes to the exact form; a missing `until` is garbled; a
week kind on an assign's `day` is garbled; a `replace` inside a `several` is garbled; a `copy` with
week words decodes; extra keys ignored. Keep the existing schema test that checks every branch of
the schema against the decoder (find it: it went red at VR8 until the schema carried `shift`) and
extend it so a form the schema accepts always decodes and vice versa for the new shapes.

## 4. `scripts/voice/serve/README.md`
One paragraph: the S55 shapes the schema now carries, and that `max_tokens` (640) still holds
because a board-answered form is short (the board makes the many; the model says one).

## 5. Report
Names of the new cases; anything ambiguous in the types you had to decide; tsc errors outside your
files; the file's case count before and after.
