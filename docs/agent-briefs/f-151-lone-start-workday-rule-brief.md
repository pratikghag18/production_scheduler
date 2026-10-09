# F-151 — a lone start before a boundary or a length reads by the workday rule

The maintainer typed "Put Operator A3 on Common Fastener on Cell 1 from 2 until end of shift"
(15 Sept, session 174) and the rules parser read the start as 02:00, so "end of shift" found the
night band and the readout said 02:00–06:00. The bar's other one-edge forms already read a lone
hour from 1 to 6 as the afternoon (RM6 "before 2" → 14:00, AJ7 "end Sam early at 3" → 15:00, the
same `applyLoneEdgeRule` the pair grammar's end uses); the start of a boundary clause ("from 2
until end of shift", "from 2 for the rest of the day") and of a length clause ("from 2 for 4
hours") were left out.

You own `src/lib/command/parse.ts` and `src/test/commandParse.test.ts` only. Read the S55-a brief
§3 (DU and BD cases) and `applyLoneEdgeRule`/`extractLoneEdgeSpan` in parse.ts. Apply the same
rule to a start that stands alone (no end clock beside it): "from 2 until end of shift" → 14:00,
"from 2 for 4 hours" → 14:00–18:00, "at 3 for the rest of the day" → 15:00, while "from 8 for 4
hours" stays 08:00–12:00, "from 2 pm …" and "from 14:00 …" are untouched, and "from 6 until end
of shift" → 18:00 (the rule's own edge; a person who means the morning says 6 am — pin it and
say so in the comment). `formatCommand` prints these as 24-hour clocks already, so round trips
hold. Pin as LS1–LS6 with the F-151 name. Run `npx vitest run src/test/commandParse.test.ts
src/test/commandPurity.test.ts` and `npx tsc --noEmit -p tsconfig.json`. No commits, no plan edits.
Report the rule's one-sentence statement and the counts.
