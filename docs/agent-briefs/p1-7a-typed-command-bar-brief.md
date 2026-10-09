# P1-7a — "Tell the board": the typed command bar

**You are building the typed half of a spoken feature.** The maintainer wants to
be able to say *"Assign Operator 1 to Housing A on Cell 1 in Line 1 from 10AM to
2PM"* and have the board do it. Speech, and the small local language model that
will later read free-form sentences, are later stages (§11;
`docs/voice-commands-plan.md`). This stage ships the part every later stage
stands on: a text box on the board that reads ONE fixed sentence shape, turns
the words into the records they name, and opens the existing create popover
pre-filled so the person can look at it and press Create. **No new way of
writing to the database is built here.** Read §2 twice.

> **Refreshed 11 Sept 2026 (session 139)** against the tree at `af2b9ae`. The
> 4 Sept draft was written against a tree seven days and forty sessions older;
> §15 lists exactly what changed and what was re-verified. Where this brief and
> the 4 Sept text disagree, this one is right. The ids in §12 were all re-taken
> since the draft (S26, R-321–R-325, D116, §19.88 belong to other work now).

Before anything else: `CLAUDE.md` §1 — read `docs/plan.yaml`, and confirm the
baseline (`npm run test` must report the count in the newest `confirmed: true`
session — **2750 tests in 133 files** at the time of writing; if the number
differs, chase that first). Two live pins (`DEF-0020`, `DEF-0022`) fail on the
developer's machine for a data reason recorded in session 139; they are not
yours.

---

## §1. What this is, in the product's words

A scheduler looks at the board and types, in one line, who goes where, on what,
and when. The board reads the line, works out which person, which part and
which cell it means, and — instead of writing anything — opens the same "New
block" popover that a drag would have opened, with everything already filled
in: the operator selected, the part selected, the times set, the cell chosen.
The person checks it and presses **Create**. Everything that happens after
Create is what already happens today: the training warning with its override
box, the "not from this area" warning with its reason box, the leave warning,
the capacity probe and the split popover, and the server's refusal shown in
words (as a toast — `useSchedulerToast.ts` — not inside the popover) if it
refuses.

If the line is not clear the bar asks **one** question with the choices as
buttons — *"Two people match 'Sam' — Sam Patel · Sam Ortiz"* — and pressing a
button puts the exact name into the sentence. If the line does not have the
shape the bar understands, the bar shows the shape it understands, with an
example, rather than guessing.

**Decision 2 (the maintainer, 11 Sept):** if the span lands inside a job already
booked for that part on that cell, the bar asks *"join the job, or make a
separate block?"* with the job(s) as buttons and a "Separate block" button. Join
opens the same popover with the job named in place of the part select, and
Create sends the run target the API already has.

What the maintainer gets after this stage: typing is faster than dragging for a
person who knows the board, and every sentence anyone types becomes the raw
material for the later model.

---

## §2. ⛔ THE ONE DESIGN RULE: NO SECOND DOOR

Every assignment on the board today goes through `createAssignment` in
`src/lib/api/mutations.ts`, which calls the server's `create_assignment`, which
refuses an untrained person, a person outside their area without a reason, an
overlap, a person on leave, a product not offered at that cell, and a scheduler
who may not write there. On the screen, the ONLY thing that calls
`createAssignment` for a new block is `submitCreateDirect` in
`src/features/board/hooks/useDragGesture.ts`, and the only thing that calls
`submitCreateDirect` is `CreatePopover`.

**This stage adds nothing to that chain and calls nothing in it directly.** The
command bar's whole job ends when it opens `CreatePopover` in direct mode with
the fields pre-filled. From that moment the bar is out of the picture: the
popover, the probe, the split, the override boxes and the server are exactly
the ones a drag uses, because they are literally the same code path (D65 made a
panel drop open the create popover in forced direct mode with the operator
preset; this stage opens it the same way, with the product — or the run — and
the times preset too). **If you find yourself importing `createAssignment`,
`useCreateAssignment` or `supabase` into anything under `src/lib/command/` or
into `CommandBar.tsx`, stop — that is a second door arriving through the side.**
`src/test/commandPurity.test.ts` (§9) fails the build on exactly those imports.

The same rule for the RULES. The bar does not decide who is trained, who
belongs at a cell, which parts are offered there, or whether a block fits a
run. Where it needs a rule it is PASSED the function the board already uses
(`productsOfferedAtNode` for parts, `assignmentFitsRun` for runs, the board's
`operatorPool` for people, `index.dayAxis.wallToOffset` for minutes — §6), so
the bar and the popover cannot disagree about what is on offer.

---

## §3. The form — what a sentence turns into

Two pure modules, no React, no runtime imports (`import type` from each other
only), so `node --experimental-strip-types` can run their tests and so the later
model can produce the SAME form and hand it to the SAME resolver (that is the
point of separating parse from resolve: the model replaces `parse.ts` one day
and nothing else moves).

They live under **`src/lib/command/`**, not under the board feature. `src/lib`
is the home for non-React pure helpers (`docs/conventions.md`), and the
name-matching and cell-resolving rules these modules hold are the same ones a
later app-wide question panel ("who is free on Line 1 this afternoon?") will
need; the feature-first rule forbids that panel importing from
`src/features/board/`, so putting them in `lib` now saves a move later. Nothing
in them may import from a feature.

**Both files are PRE-SEATED as type-only skeletons** (every export declared,
bodies `throw new Error("not implemented — Lane A")`). Lane A replaces the
bodies and may add private helpers; it does not change an exported shape
without saying so in its report, because Lane B is compiling against them.
The skeletons are the authority; this section summarises them.

### `src/lib/command/parse.ts`

- `ClockTime { hour; minute }` — 24h.
- `DayWord` — `today` | `tomorrow` | `weekday(0–6, 0 = Sunday)` | `date(iso)`.
- `Attach` — `{ kind: "run"; runId }` | `{ kind: "direct" }` — decision 2's answer.
- `AssignCommand { intent: "assign"; operator; product; place: string[]; day: DayWord | null; start; end; attach: Attach | null }`.
  `parseCommand` always returns `attach: null`; the bar sets it after the run question.
- `ParseFailure` — `empty` | `no_time` | `bad_time(text)` | `time_order` | `no_product` | `no_place` | `bad_day(text)`.
- `parseCommand(text): ParseResult`, `formatCommand(command): string` (the
  inverse for the canonical shape; never prints `attach`), `expectedShape(): string`.

### `src/lib/command/resolve.ts`

- `BoardDay { index; iso; weekday }` — one window day in the PLANT'S calendar.
- `ContextRun { id; nodeId; productId | null; startMin; endMin; label }`.
- `ResolveContext { cells; nodeById; operators (with active); products; offeredAt(nodeId); days; todayIndex; wallToOffset(dayIndex, minuteOfDay); runs; fitsRun(a, run); minDurationMinutes }`.
- `CommandTarget` — structurally `AssignmentTarget` from `src/lib/api/mutations.ts`.
- `ResolvedCommand { nodeId; operatorId; productId; target; range; readout }`.
- `Candidate { id; label; word }`; `Question` — the six kinds of the 4 Sept draft
  plus `run_exists { product; cell; runs: Candidate[] }`.
- `resolveCommand(command, ctx): Resolution`, `describeQuestion(q): string`.

The readout's day part is the calendar day. `resolve.ts` cannot import the date
seam, so `readout` carries the day as an ISO date string inside the sentence,
and **`CommandBar` re-renders the day through `formatDayLabel(date, dateFormat,
zone)` from `../lib/time`** for display (the date-seam audit `dateSeam.test.ts`
fails the build on any other formatter — read its header; and D88a means the
ZONE argument is not optional in spirit: pass `index.zone`). Concretely:
`readout` is `"<operator> → <product> · <ancestors › cell> · <YYYY-MM-DD> ·
HH:MM–HH:MM"`, plus `" · joining <run label>"` when the target is a run, and the
bar replaces the ISO token when it renders. Test the pure string; the bar's
substitution is one `replace` and is covered by the component test (§9).

---

## §4. The parser — exactly what it reads

One shape. Case-insensitive, runs of whitespace collapsed, a trailing `.`
ignored. Double-quoted segments are atomic (a name containing " in " or " on "
can be quoted: `assign "Lin On" to Housing A on "Cell in 2" from 10 to 2`).

```
[assign | put | schedule | add]  <operator>
   (to [work on] | on)  <product>
   (on | at | in)  <place>  { (in | on | at | ,)  <place> }
   [on <day>]
   from <time>  (to | - | – | until | till)  <time>
```

Read it back to front, because the time clause is the only unambiguous anchor:

1. **Time clause** — the LAST occurrence of `from <time> <sep> <time>` at the end of
   the line. Absent → `no_time`. `from` is required (it is what separates a place
   called "Bay 2" from a time). A `<time>` is one of: `10`, `10am`, `10 am`,
   `10:30`, `10.30`, `10:30pm`, `14:00`, `noon` (= 12:00), `midnight` (= 0:00).
   Hour 1–12 with am/pm (12am → 0, 12pm → 12); hour 0–23 without. Anything else →
   `bad_time` with the offending text.
2. **The afternoon rule.** If the END has no am/pm and, read literally, is not after
   the start, add 12 hours to it once ("from 10 to 2" → 10:00–14:00; "from 8 to
   4" → 08:00–16:00). If it is STILL not after the start → `time_order`. The
   start is always read literally ("from 1 to 5" is 01:00–05:00 — the readout
   shows the 24h clock precisely so this is visible before Create).
3. **Day word** — immediately before the time clause, optional: `on today`,
   `today`, `tomorrow`, a weekday name or its first three letters (`mon`,
   `tuesday`), or `on 2026-09-04`. An `on` followed by something that is none of
   these is NOT a day; it is a place. A weekday-looking token that is not a
   weekday (`on funday`) is a place, not `bad_day`; `bad_day` is only for an ISO-
   looking date that is not a real date (`2026-13-40`).
4. **Verb** — an optional leading `assign` / `put` / `schedule` / `add`.
5. **The middle** — what is left. Split on the FIRST ` to work on ` or ` to ` or
   ` on `: before it is the operator; after it is the product-and-places. Split
   THAT on ` on `, ` at `, ` in `, and `,`: the first segment is the product, the
   rest are places, in order. Empty operator → `empty`; no product segment →
   `no_product`; no place segment → `no_place`.

Worked examples — **these are test cases, verbatim (§9, P-cases)**. Every `ok`
row also has `attach: null`.

| # | input | result |
|---|---|---|
| P1 | `Assign Operator 1 to work on Product A/Housing A on Cell 1 in Line 1 from 10AM to 2PM` | operator `Operator 1`, product `Product A/Housing A`, place `["Cell 1","Line 1"]`, day null, 10:00–14:00 |
| P2 | `put sam on housing a at cell 1 from 10 to 2` | `sam`, `housing a`, `["cell 1"]`, 10:00–14:00 |
| P3 | `Sam Patel to Housing A on Cell 1, Line 1, Assembly from 6:30 to 14:30` | places `["Cell 1","Line 1","Assembly"]`, 06:30–14:30 |
| P4 | `assign Sam to Housing A on Cell 1 on tomorrow from 10 to 2` | day `{tomorrow}` |
| P5 | `assign Sam to Housing A on Cell 1 tue from 10 to 2` | day `{weekday: 2}` |
| P6 | `assign Sam to Housing A on Cell 1 on 2026-09-04 from 10 to 2` | day `{date: "2026-09-04"}` |
| P7 | `assign Sam to Housing A on Cell 1 from 10 - 2` | 10:00–14:00 (dash separator) |
| P8 | `assign Sam to Housing A on Cell 1 from 22 to 2` | `time_order` — 2 → 14 is still before 22 |
| P9 | `assign Sam to Housing A on Cell 1 from 10 to 10` | 10:00–22:00 — the end is not after the start read literally, so the afternoon rule adds 12h once. (The author's first reading of this row was `time_order`; it is the row most likely to be reasoned wrong.) |
| P10 | `assign Sam to Housing A on Cell 1 from noon to 3` | 12:00–15:00 |
| P11 | `assign Sam to Housing A on Cell 1 from 12am to 4` | 00:00–04:00 |
| P12 | `assign Sam to Housing A on Cell 1 from 10:75 to 2` | `bad_time` text `10:75` |
| P13 | `assign Sam to Housing A on Cell 1` | `no_time` |
| P14 | `assign Sam from 10 to 2` | `no_product` |
| P15 | `assign Sam to Housing A from 10 to 2` | `no_place` |
| P16 | `   ` | `empty` |
| P17 | `assign "Lin On" to Housing A on "Cell in 2" in Line 1 from 10 to 2` | operator `Lin On`, place `["Cell in 2","Line 1"]` |
| P18 | `assign Sam to Housing A on Cell 1 on funday from 10 to 2` | places `["Cell 1","funday"]`, day null |
| P19 | `assign Sam to Housing A on Cell 1 on 2026-13-40 from 10 to 2` | `bad_day` text `2026-13-40` |
| P20 | `ASSIGN SAM TO HOUSING A ON CELL 1 FROM 10AM TO 2PM.` | same as P2 shape, original case kept in the words (`SAM`) |
| P21 | `Sam to Housing A on Cell 1 from 8 until 4` | 08:00–16:00 (`until`), no verb |
| P22 | `assign Sam to Housing A on Cell 1 from 9 to 9:15` | 09:00–09:15 (the parser does not enforce the minimum; the resolver does, R2) |

Run the table; do not reason it. §15 says which rows were executed by the
author and which were not.

---

## §5. The resolver — from words to records, never guessing

**Matching a word to a list** (people, parts, cells) uses one function,
`matchName(word, items, keyOf)`, in three tiers, and the first tier with any
hit wins:

1. exact, after normalising both sides (lower-case, whitespace collapsed,
   punctuation other than `/` and `-` removed);
2. starts-with;
3. contains.

One hit → resolved. Several → `ambiguous` with every hit as a candidate. None →
`unknown`. **Never the "best" of several**: two people whose names both start
with "Sam" is a question, not a coin toss, however different their surnames.

**People** are matched on `displayName`, then (if no tier hits) on
`employeeRef`, over `ctx.operators` filtered to `active` — the same first
filter the popover's `here` and `elsewhere` lists apply
(`CreatePopover.tsx:300-307`). The list is exactly what `BoardPage` passes the
create popover as `operators` (`operatorPool`, §6, §8) — nobody outside it, and
nobody filtered out of it either: a person outside their area is a legitimate
choice with a reason, and the popover is where that reason is asked for (a
preset from `elsewhere` opens the popover with the rest of the plant already
revealed — `showOthers`, `CreatePopover.tsx:311-313` — so nothing new is needed
for that case).

**Parts** are matched on `name`, then `sku`, then the whole word against
`"<sku>/<name>"`, then — because the maintainer's own example was `Product
A/Housing A` — each `/`-separated piece of the word against name and sku,
accepting only if exactly one part matches across pieces. Then the winner is
checked with `ctx.offeredAt(cell.id)`: winner absent → `not_offered` (the part
is real; it is not made at this cell, and the server would refuse it with no
override, so the bar says so instead of opening a popover that cannot
succeed). `ctx.products` are already `active` only; `BoardPage` filters them
before they reach the context, the same filter the popover's list gets.

**Cells**: the FIRST place word is matched against `ctx.cells` (track rows
only — you cannot assign onto a line or a department, and the popover would
not open there either). Each FURTHER place word is a qualifier: it must match
(same three tiers) the name of some ancestor of the cell, found by walking
`cell.path` through `ctx.nodeById` exactly as `ancestorPaths` in
`boardIndex.ts` does — copy that function's *idea* (split the ltree path,
prefixes nearest-first), not its export. Cells left after qualifiers: one →
resolved; several → `ambiguous` (field `place`) with each candidate labelled
`"Cell 1 — Plant 1 › Assembly › Line 3"` (the ancestor chain, root first) so the
buttons are tellable apart; none, but there were cells before the qualifiers
were applied → `place_mismatch` naming where the cell actually is; none at all
→ `unknown`.

**Order of resolution is cell, then part, then person, then day and span, then
the run question**, so that a question about the part can name the cell
("Housing A is not made at Cell 1") and a sentence with two problems asks about
the FIRST one only. One question at a time; the person fixes it and presses
Enter again.

**Day** (D88a: the plant's calendar, never UTC arithmetic — every fact comes
from `ctx.days` and `ctx.todayIndex`, built by `BoardPage` in the plant's zone):
`null` → `ctx.todayIndex ?? 0`. `today` → `todayIndex`, or `day_off_board`
("today") when it is null. `tomorrow` → `todayIndex + 1` if that index exists,
else `day_off_board` ("tomorrow"). A weekday → the first `BoardDay` whose
`weekday` matches, else `day_off_board` (the word as typed). A date → the
`BoardDay` whose `iso` matches, else `day_off_board` (the iso). **The resolver
never reads a clock and never constructs a `Date`.**

**Span** (D88b): `startMin = ctx.wallToOffset(dayIndex, start.hour * 60 +
start.minute)` and the same for `endMin`. Never `dayIndex * 1440 + …`: on a
changeover day the real-minute width of the day is 1380 or 1500, and
`wallToOffset` is the board's one answer to "where does 10:00 fall". The
fixture stubs it; the DST row (R25) makes the stub non-linear so the arithmetic
shortcut fails.

**Duration**: `endMin - startMin < ctx.minDurationMinutes` → `too_short`. The
number is passed in from `MIN_DURATION_MINUTES` in `lib/interaction.ts` (D31),
never retyped.

**The run question (R-383).** With cell, part, person and range resolved:
`hits = ctx.runs.filter(r => r.nodeId === cell.id && r.productId === product.id
&& ctx.fitsRun(range, r))`, in `ctx.runs` order. Then:

- `hits` empty → target `{ kind: "direct", productId }`, whatever `attach` says.
- `hits` non-empty and `command.attach === null` → `run_exists` with one
  `Candidate` per hit (`id` = run id, `label` = run label, `word` = `""`).
- `attach = { kind: "run", runId }` and `runId` is among `hits` → target
  `{ kind: "run", runId }`, readout gains ` · joining <label>`.
- `attach = { kind: "run", runId }` and `runId` is NOT among `hits` (the board
  refetched under the person) → `run_exists` again, never a silent fallback.
- `attach = { kind: "direct" }` → target direct.

The rule for "fits" is `ctx.fitsRun`, i.e. `assignmentFitsRun` (D66, plain
containment); the resolver holds no copy.

`describeQuestion` returns, for each kind (these strings are tested verbatim):

| kind | text |
|---|---|
| ambiguous | `Which <person / part / cell>? "<text>" matches <n>:` (the candidates render as buttons after it) |
| unknown | `No <person / part / cell> called "<text>" on this board.` |
| not_offered | `<product> is not made at <cell>, so it cannot be scheduled there.` |
| place_mismatch | `There is no <cell> in <qualifier>. <cell> is in <elsewhere labels, joined by " / ">.` |
| day_off_board | `<text> is not on the board. Move the board to that day first.` |
| too_short | `That is <minutes> minutes; a block is at least <min> minutes.` (the question carries both numbers, `minutes` and `min`) |
| run_exists (one) | `A <product> job is already booked on <cell>, <run label>. Join it, or make a separate block?` |
| run_exists (several) | `<n> <product> jobs are already booked on <cell>. Join one, or make a separate block?` |

**Worked examples — test cases, verbatim (§9, R-cases).** The fixture is
published in full so your collateral matches the table:

```ts
// window: 7 days from Monday 2026-08-31 (the plant's calendar)
// days: [{index:0, iso:"2026-08-31", weekday:1}, {1,"2026-09-01",2}, {2,"2026-09-02",3},
//        {3,"2026-09-03",4}, {4,"2026-09-04",5}, {5,"2026-09-05",6}, {6,"2026-09-06",0}]
// todayIndex: 3 (Thursday)
// wallToOffset: (d, m) => d * 1440 + m            // the PLAIN stub, no changeover
// wallToOffsetDst: (d, m) => d * 1440 + m - (d >= 1 ? 60 : 0)   // R25 only: an hour lost overnight into day 1
// levels: plant (not schedulable), line (not), cell (schedulable)
// nodes (id, name, path):
//   p1 "Plant 1" plant_1 · asm "Assembly" plant_1.assembly
//   l1 "Line 1" plant_1.assembly.line_1 · l3 "Line 3" plant_1.assembly.line_3
//   c1a "Cell 1" plant_1.assembly.line_1.cell_1 · c2 "Cell 2" plant_1.assembly.line_1.cell_2
//   c1b "Cell 1" plant_1.assembly.line_3.cell_1
// cells: c1a, c2, c1b
// operators: op1 "Operator 1" ref "E100" active · sp "Sam Patel" ref null active
//            · so "Sam Ortiz" ref "E200" active · lin "Lin On" ref null active
//            · gone "Sam Gone" ref null INACTIVE (must never match)
// products: ha "Housing A" sku "HA-1" · hb "Housing B" sku "HB-1" · cov "Cover" sku "CV-9"
// offeredAt: c1a, c2 -> [ha, hb]; c1b -> [cov]         (a stub of productsOfferedAtNode's answer)
// runs: run1 { nodeId c1a, productId ha, 3*1440+480 … 3*1440+960, label "Housing A 08:00–16:00" }
//       (R32 adds run2, same cell/product, 3*1440+540 … 3*1440+900, label "Housing A 09:00–15:00")
// fitsRun: (a, r) => a.startMin >= r.startMin && a.endMin <= r.endMin   (assignmentFitsRun's rule, stubbed)
// minDurationMinutes: 15
// Every command below has attach: null unless the row says otherwise.
```

| # | command (already parsed) | result |
|---|---|---|
| R1 | op `Operator 1`, `Housing A`, `["Cell 1","Line 1"]`, day null, 10:00–14:00, **with `runs: []`** | ok: c1a, op1, ha, target direct ha, range 3·1440+600 … 3·1440+840 (today = index 3), readout `Operator 1 → Housing A · Plant 1 › Assembly › Line 1 › Cell 1 · 2026-09-03 · 10:00–14:00` |
| R2 | same, 09:00–09:10 | too_short minutes 10, min 15 |
| R3 | `Cell 1` alone, no qualifier | ambiguous place, candidates `Cell 1 — Plant 1 › Assembly › Line 1` (c1a) and `… › Line 3` (c1b), in `cells` order |
| R4 | `["Cell 1","Line 3"]`, product `Cover` | ok: c1b, cov |
| R5 | `["Cell 1","Line 2"]` | place_mismatch cell `Cell 1`, qualifier `Line 2`, elsewhere both c1a and c1b labels |
| R6 | `["Cell 9"]` | unknown place `Cell 9` |
| R7 | `Sam`, c1a | ambiguous operator, candidates Sam Patel (word `Sam Patel`), Sam Ortiz — and NOT Sam Gone (inactive) |
| R8 | `sam patel` | ok, sp (exact tier, case-insensitive) |
| R9 | `E200` | ok, so (employeeRef fallback) |
| R10 | `Pat` | ok, sp — "contains" tier, one hit |
| R11 | `Nobody` | unknown operator |
| R12 | product `Housing` | ambiguous product, ha and hb |
| R13 | product `HA-1` | ok, ha (sku) |
| R14 | product `Product A/Housing A` | ok, ha — piece `Housing A` matches by name, `Product A` matches nothing |
| R15 | product `Cover` at c1a | not_offered `Cover` at `Cell 1` |
| R16 | product `Gasket` | unknown product |
| R17 | day tomorrow | day index 4 (Fri); twin: with `todayIndex: 6`, day_off_board `tomorrow` |
| R18 | day weekday 1 (Monday) | day index 0 |
| R19 | day weekday 0 (Sunday) | day index 6 |
| R20 | day date `2026-09-08` | day_off_board `2026-09-08`; twin: `2026-09-06` resolves to day index 6 |
| R21 | day null with `todayIndex: null` (today is off the board) | day index 0 (the window's first day) |
| R22 | a sentence with BOTH an unknown cell and an unknown operator | the question is about the cell (order: cell, part, person) |
| R23 | ctx with `cells` = [] | unknown place (nothing to match) — never throws |
| R24 | R1 with 10:00–10:15 | ok — exactly the minimum is allowed (this row exists so M13 has something to fail) |
| R25 | R1 with day tomorrow and `wallToOffset: wallToOffsetDst` | range 4·1440+600−60 … 4·1440+840−60 — the stub's numbers, not the arithmetic's |
| R26 | day today with `todayIndex: 5` | day index 5; twin: `todayIndex: null` → day_off_board `today` |
| R27 | R1 with the fixture's `runs` (run1) | run_exists, product `Housing A`, cell `Cell 1`, runs `[{id "run1", label "Housing A 08:00–16:00", word ""}]`; describeQuestion = `A Housing A job is already booked on Cell 1, Housing A 08:00–16:00. Join it, or make a separate block?` |
| R28 | R27 with `attach: { kind: "run", runId: "run1" }` | ok, target `{ kind: "run", runId: "run1" }`, readout = R1's readout + ` · joining Housing A 08:00–16:00` |
| R29 | R27 with `attach: { kind: "direct" }` | ok, target direct ha, readout = R1's |
| R30 | R27 but 07:00–14:00 | ok, target direct — the span is not contained, so no question |
| R31 | R27 but product `Housing B` | ok, target direct hb — a different part's job is not this part's |
| R32 | R27 with run1 AND run2 | run_exists listing both in `runs` order; describeQuestion = `2 Housing A jobs are already booked on Cell 1. Join one, or make a separate block?` |
| R33 | R27 with `attach: { kind: "run", runId: "run9" }` (not among the hits) | run_exists again, never a silent direct |

The order of candidates is the order of the source list; the resolver does not
sort (the board's own order is deterministic and the popover shows the same).

---

## §6. The screen

### `src/features/board/components/CommandBar.tsx` (+ `.module.css`)

One row under the toolbar, above the grid, rendered by `BoardPage` only when
the board has data AND the person may place (`canPlace && commandCtx !== null`
— the same server flag that gates the left panel and the create popover,
`BoardPage.tsx:670` and `:736`; a viewer never sees a bar whose popover cannot
open, and `e2e/roleWalk.spec.ts` gets one fact for it, §9).

- A single text input, **the shared field** (`className={fieldStyles.field}`
  from `@/components/Field.module.css`, R-318 — `fieldStandard.test.ts` fails
  the build if the bar's stylesheet declares its own field border). Accessible
  name `Tell the board` (a `<label>` — visually hidden is fine; the placeholder
  is the example sentence `Assign Sam to Housing A on Cell 1 in Line 1 from 10 to 2`
  and a placeholder is not a name).
- Enter → `parseCommand` → `resolveCommand` → either `onOpen(resolved, anchor)`
  or a status line under the input.
- The status line is ONE element with `aria-live="polite"`, and it shows one of:
  the parse failure (`expectedShape()` — one sentence: `Say it like: assign
  <person> to <part> on <cell> [in <line>] [on <day>] from <time> to <time>` —
  plus, for `bad_time`/`bad_day`, `I could not read "<text>".` in front); a
  question from `describeQuestion` followed by the candidates as buttons; or,
  after a successful open, the readout (with the ISO day replaced through
  `formatDayLabel(date, dateFormat, zone)`) so the person sees in words what
  the popover is showing.
- Clicking a candidate button for an `ambiguous` question **replaces the
  matched words in the input with the candidate's `word`** and re-runs Enter.
  Replacing means: the field the question was about (`operator` / `product` /
  `place`) is what changes — keep the `AssignCommand` from the last parse,
  substitute that field (for `place`, the first place word, and drop the
  qualifiers), and rebuild the sentence with `formatCommand(command)`.
  Rebuilding the sentence rather than splicing text is what keeps a quoted
  name quoted.
- For a `run_exists` question the buttons are each run's `label` plus one
  `Separate block`. Pressing a run button keeps the sentence as it is, sets
  `attach: { kind: "run", runId }` on the held command, and re-resolves;
  `Separate block` sets `attach: { kind: "direct" }` and re-resolves. Any edit
  to the input clears the held `attach` (a new sentence is a new question).
- Escape clears the status line; a second Escape clears the input.
- No history, no autocomplete, no suggestions while typing (§11).

Props:

```ts
{
  ctx: ResolveContext;
  dateFormat: DateFormat;
  zone: string;                       // index.zone — D88a
  onOpen: (resolved: ResolvedCommand, anchor: { x: number; y: number }) => void;
}
```

`anchor` is the input's bounding rect: `{ x: rect.left, y: rect.bottom }`, so
the popover hangs off the bar the way it hangs off a drop point.

Visual: the bar sits in the same band as the toolbar's controls, full width,
one line tall, with the status line beneath in the toolbar's small text size.
Use the toolbar's existing tokens (`BoardToolbar.module.css` is the reference
for spacing and font size); do not introduce a colour and do not use
`--ink-1` (it is undefined — F-130). Candidate buttons are `fieldStyles.btn`.
Render it, look at it at the board's default zoom and at `--ui-scale` 0.8, and
include the screenshot in your report.

### `useDragGesture.ts` — one new action, one widened parameter

Add to the returned object:

```ts
openCreateFromCommand: (r: {
  nodeId: string;
  range: Range;
  operatorId: string;
  target: AssignmentTarget;          // from "@/lib/api/mutations" — the type the API already has
  anchor: { x: number; y: number };
}) => void;
```

Its body is the tail of `endPanelDrag` (the block that starts `const template =
index.templateForNode.get(r.nodeId) ?? null;`) with the snapping removed —
the resolver's minutes are already exact — and the presets:

```ts
const template = index.templateForNode.get(r.nodeId) ?? null;
const chips = shiftChipsFor(template, r.range.startMin, index.windowMinutes);
setPopover({
  kind: "create",
  nodeId: r.nodeId,
  range: r.range,
  anchor: r.anchor,
  shiftChips: chips,
  presetOperatorId: r.operatorId,
  ...(r.target.kind === "direct"
    ? { presetProductId: r.target.productId }
    : { presetRun: { id: r.target.runId, label: runLabelById(r.target.runId) } }),
});
```

`PopoverState`'s `create` member gains `presetProductId?: string` and
`presetRun?: { id: string; label: string }` (the label from the existing
`runLabelById`, which is the D66 label a drag's confirm prompt already uses —
one label format on the board, not two). Do not touch `endPanelDrag`; the
duplicated five lines are the price of not changing a drop path this stage
does not own (report the duplication, do not refactor it).

**`submitCreateDirect`'s fourth parameter changes from `productId: string` to
`target: AssignmentTarget`**, and the body passes it through where it built
`{ kind: "direct", productId }` today. This is the ONE deliberate breach of the
4 Sept draft's "do not change `submitCreateDirect`" fence, and it is the
smallest one that honours §2: the popover stays the one door, and it learns to
send the target the API already defines instead of a second submit path
growing beside it. Existing tests read that argument positionally
(`createPopover.test.tsx:107` asserts `calls[0][3]` is `"prod-1"`;
`certificateExpiry.test.tsx:429/498` and `peoplePicker.test.tsx:280` read the
same call). **Update them to expect `{ kind: "direct", productId: "prod-1" }`
and write in your report, per CLAUDE.md §4, that the CONTRACT changed and the
cases were not wrong.** Any other consumer `tsc` finds is yours to update the
same way; list each.

### `CreatePopover.tsx` — two new optional props

- `presetProductId?: string` — the only change in the body is
  `useState(presetProductId ?? "")` for `productChoice`. The existing
  derivation (`productId = products.some(...) ? productChoice : firstOffered`)
  already handles a preset that is not on offer at this cell by falling back —
  but the resolver has already refused that case (`not_offered`), so the
  fallback is a belt, not the braces.
- `presetRun?: { id: string; label: string }` — direct mode (as
  `presetOperatorId` already forces), the product `<select>` REPLACED by one
  read-only line `Joining <label>` (the part is the run's; there is nothing to
  choose), and Create sends `onSubmitDirect(…, { kind: "run", runId }, …)`.
  Without `presetRun`, Create sends `{ kind: "direct", productId }` exactly as
  today. The training, area and leave checks run unchanged: they are about the
  person and the cell, not about the target — and read `create_assignment`'s
  run branch yourself (`grep -in "function \(public\.\)\?create_assignment("
  supabase/migrations/*.sql`, LAST hit) to confirm the server applies the same
  three for a run-attached row; say what you found. The UI has never sent a
  run target before this stage.

`mode` already forces `"direct"` when `presetOperatorId` is set; nothing to add.

### `BoardPage.tsx` — wiring

Build the context beside the existing `offeredProducts` memo, from the same
sources it uses. **This is the refreshed shape; the 4 Sept draft's
`windowStart/dayCount/now/offeredAt(products, cellPath)` no longer exists on
the board.**

```ts
const commandCtx = useMemo<ResolveContext | null>(() => {
  if (!boardQuery.data || index === null) return null;
  const active = boardQuery.data.products.filter((p) => p.active);
  const axis = index.dayAxis;
  const pad = (n: number) => String(n).padStart(2, "0");
  const days: BoardDay[] = [];
  for (let i = 0; i < axis.dayCount; i++) {
    const p = partsInZone(axis.dayStarts[i], index.zone);          // "@/lib/format/timezones"
    const iso = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
    days.push({ index: i, iso, weekday: new Date(`${iso}T00:00:00Z`).getUTCDay() as BoardDay["weekday"] });
  }
  const now = new Date();
  const t = axis.dayStarts.findIndex((s, i) => i < axis.dayCount && now >= s && now < axis.dayStarts[i + 1]);
  const runs: ContextRun[] = [];
  for (const [nodeId, list] of index.runsByNode) {
    for (const r of list) runs.push({ id: r.id, nodeId, productId: r.productId, startMin: r.startMin, endMin: r.endMin, label: /* the same D66 label runLabelById builds — expose it from dragApi or build it with productViewFor + the board's formatRange; ONE format */ });
  }
  return {
    cells: index.rows.filter((r) => r.isTrack).map((r) => r.node),
    nodeById: index.nodeById,
    operators: operatorPool,                                        // THE popover's variable, §8
    products: active,
    offeredAt: (nodeId) => productsOfferedAtNode(active, nodeId),   // already imported
    days,
    todayIndex: t === -1 ? null : t,
    wallToOffset: axis.wallToOffset,
    runs,
    fitsRun: assignmentFitsRun,                                     // "./lib/interaction"
    minDurationMinutes: MIN_DURATION_MINUTES,                       // "./lib/interaction"
  };
}, [boardQuery.data, index, operatorPool]);
```

`new Date(iso + "T00:00:00Z").getUTCDay()` is a UTC method on a UTC-constructed
date, not a local-time read; the date-seam audit bans `Intl`/`toLocale*`/month
arrays, not this. `now` inside a memo is deliberately coarse: it changes when
the board data changes, which is at least every refetch; a sentence typed at
23:59 resolving against a "today" from 30 seconds earlier is not a defect worth
a timer.

The operator list is **whatever `<CreatePopover operators={…}>` is passed** —
today that line is `BoardPage.tsx:748`, `operators={operatorPool}`, under the
R-342 comment, and `hereOperatorIds={createHereIds}` on the next line. Pass
`operatorPool` itself; `pickerPool.test.ts` pins that every person picker on the
board is handed the same variable and you add `CommandBar`'s context to that
list (§9). **Quote both lines in your report.**

Render `<CommandBar ctx={commandCtx} dateFormat={dateFormat} zone={index.zone}
onOpen={(r, anchor) => dragApi.openCreateFromCommand({ ...r, anchor })} />`
between `BoardToolbar` and the grid, only when `canPlace && commandCtx !== null`,
and pass `presetProductId={popover.presetProductId}` and
`presetRun={popover.presetRun}` through to the popover.

---

## §7. Files

**Add**

- `src/lib/command/parse.ts` — pure, no imports. (Pre-seated.)
- `src/lib/command/resolve.ts` — pure, `import type` from `./parse.ts` only. (Pre-seated.)
- `src/features/board/components/CommandBar.tsx`
- `src/features/board/components/CommandBar.module.css`
- `src/test/commandParse.test.ts` — vitest, `describe`/`it`/`expect`, **one plain `it()` per case, no `it.each`**, cases P1–P24.
- `src/test/commandResolve.test.ts` — same, R1–R33, the §5 fixture verbatim.
- `src/test/commandPurity.test.ts` — the audit (§9).
- `src/test/commandBar.test.tsx` — same shape as `settingsPanel.test.tsx` (`@testing-library/react`, jsdom), cases C1–C10.

**Change**

- `src/features/board/hooks/useDragGesture.ts` — `openCreateFromCommand`, `presetProductId`/`presetRun` on `PopoverState`, `submitCreateDirect`'s target parameter.
- `src/features/board/components/CreatePopover.tsx` — `presetProductId`, `presetRun`, the run line, the target sent.
- `src/features/board/BoardPage.tsx` — `commandCtx`, render the bar, pass the presets through.
- `src/test/pickerPool.test.ts` — one added picker.
- `src/test/createPopover.test.tsx`, `src/test/certificateExpiry.test.tsx`, `src/test/peoplePicker.test.tsx` — the positional `productId` argument becomes a target (contract change, §6).
- `e2e/roleWalk.spec.ts` — one added fact (§9).
- `docs/plan.yaml`, `docs/design-plan.md` — §12 (the developer session writes these; lanes report their numbers).

**Do not change**: anything under `src/lib/api/`, anything under `supabase/`,
`endPanelDrag`, `scope.ts`, `interaction.ts`, `outsideArea.ts`, `time.ts`. If
one of them is in your way, say so in the report and stop at the boundary.

The fences are by property: nothing new may write to the database; nothing new
may hold a copy of a rule that `scope.ts`, `interaction.ts`, the popover or the
server already holds. A CSS Module is one per component; `CommandBar.module.css`
is the bar's only stylesheet and declares no field border and no month names.

---

## §8. What already exists — quoted, so you read it rather than predict it

`src/features/board/hooks/useDragGesture.ts:131-143`, the create popover state:

```ts
  | {
      kind: "create";
      nodeId: string;
      range: Range;
      anchor: { x: number; y: number };
      shiftChips: ShiftChip[];
      /** D65: set only when this popover was opened by a panel drop — the
       *  dropped operator, pre-selected, in forced "direct" mode. */
      presetOperatorId?: string;
    }
```

and the tail of `endPanelDrag` (`:1449-1458`) this stage copies from:

```ts
      const chips = shiftChipsFor(template, startMin, windowMinutes);
      setPopover({
        kind: "create",
        nodeId: hit.nodeId,
        range: { startMin, endMin },
        anchor: { x: e.clientX, y: e.clientY },
        shiftChips: chips,
        presetOperatorId: d.subject.operator.id,
      });
```

`runLabelById` (`:1476-1483`) — the one run label on the board:

```ts
  const runLabelById = useCallback(
    (runId: string): string => {
      const run = index.runById.get(runId);
      if (!run) return "Run";
      const p = productViewFor(run, index.productById);
      return `${p?.name ?? "Run"} ${ctx.formatRange?.(run.startMin, run.endMin) ?? ""}`;
    },
```

`src/features/board/components/CreatePopover.tsx` (`:257-315`), abridged:

```ts
  const [mode, setMode] = useState<"run" | "direct">(
    presetOperatorId ? "direct" : defaultCreateMode,
  );
  …
  const [productChoice, setProductChoice] = useState("");
  const firstOffered = products[0]?.id ?? "";
  const productId = products.some((p) => p.id === productChoice) ? productChoice : firstOffered;
  …
  const here = useMemo(
    () => operators.filter((o) => o.active && hereOperatorIds.has(o.id)),
    [operators, hereOperatorIds],
  );
  const elsewhere = useMemo(
    () => operators.filter((o) => o.active && !hereOperatorIds.has(o.id)),
    [operators, hereOperatorIds],
  );
  const [operatorId, setOperatorId] = useState(presetOperatorId ?? here[0]?.id ?? "");
  const [showOthers, setShowOthers] = useState(
    presetOperatorId !== undefined && !hereOperatorIds.has(presetOperatorId),
  );
```

`src/features/board/BoardPage.tsx:737-766`, the popover render (abridged):

```tsx
        <CreatePopover
          nodeId={popover.nodeId}
          anchor={popover.anchor}
          initialRange={popover.range}
          shiftChips={popover.shiftChips}
          defaultCreateMode={defaultCreateMode}
          products={offeredProducts}
          // R-342, the maintainer: "Operators from other plants should not be shown
          // in the list, period, it is the same as the operators shown on the left
          // panel." So this is the panel's own list, the same variable, not a
          // second filter that could drift from it.
          operators={operatorPool}
          hereOperatorIds={createHereIds}
          windowStart={index?.windowStart ?? from}
          …
          absences={absences}
          presetOperatorId={popover.presetOperatorId}
          dateFormat={dateFormat}
          onCancel={dragApi.closePopover}
          onSubmitRun={dragApi.submitCreateRun}
          onSubmitDirect={dragApi.submitCreateDirect}
```

`offeredProducts` (`BoardPage.tsx:410-426`) ends in
`return productsOfferedAtNode(active, createNodeId);` and the import is
`import { productsOfferedAtNode } from "@/features/admin/lib/scope";` (`:7`).
`canPlace` is `boardQuery.data?.canPlace ?? false` (`:195`).

`src/features/board/lib/boardIndex.ts` — the index the context is built from:

```ts
export interface BoardIndex {
  windowStart: Date;       // D88a: the window's local-midnight instant IN THE PLANT'S ZONE
  windowMinutes: number;
  dayCount: number;
  zone: string;            // D88a / migration 0063 (R-353)
  dayAxis: DayAxis;        // dayStarts, dayOffsets, wallToOffset(dayIndex, minuteOfDay)
  rows: BoardRow[];        // BoardRow has `node: BoardNode` and `isTrack: boolean`
  runsByNode: Map<string, IndexedRun[]>;   // IndexedRun = Run & { startMin; endMin }
  runById: Map<string, IndexedRun>;
  productById: Map<string, Product>;
  operatorById: Map<string, BoardOperator>;
  nodeById: Map<string, BoardNode>;
  …
}
```

`src/features/board/lib/time.ts:196-254`: `DayAxis { zone; windowStart;
dayCount; dayStarts: Date[]; dayOffsets: number[]; windowMinutes;
wallToOffset(dayIndex, minuteOfDay) }`; `BOARD_ZONE = "UTC"` is only the
DEFAULT; `formatClock(d, zone)`, `formatDayLabel(d, fmt, zone)`.
`src/lib/format/timezones.ts:222`: `partsInZone(d, zone): { year; month; day;
hour; minute; second }` (month 1-based).

`src/lib/api/shapes.ts`: `BoardNode { id; parentId; levelId; name; path; sortOrder; active }`,
`BoardOperator { id; homeNodeId; displayName; employeeRef; active; siteNodeId; skillIds }`,
`Product { id; sku; name; active; siteNodeIds; offeredNodeIds; … }`,
`Run { id; nodeId; productId: string | null; productName; timerange; plannedHeadcount; … }`.

`src/features/board/lib/interaction.ts`: `export const MIN_DURATION_MINUTES = 15; // D31`
(`:28`) and `assignmentFitsRun(assignment, run)` (`:327`, D66 containment).

`src/lib/api/mutations.ts:41`:
`export type AssignmentTarget = { kind: "run"; runId: string } | { kind: "direct"; productId: string };`

Audits that will fail your build if you forget them, all in `src/test/`:
`fieldStandard.test.ts` (no field border outside `Field.module.css`),
`dateSeam.test.ts` (no `Intl.DateTimeFormat`/`toLocaleDateString`/month-name
array outside the two seams), `iconStandard.test.ts` (no raw chevron glyphs),
`popoverStandard.test.ts` (no `role="dialog"` outside `Popover.tsx` — the bar
is not a dialog and must not become one), `pickerPool.test.ts` (every person
picker on the board is handed the same variable — add the bar). `scaleAudit`'s
`REM_SURFACES` lists admin stylesheets only; the board is not on it, so nothing
to add there — say so in your report rather than assuming. There is NO ESLint
import-boundary rule in this repo; `commandPurity.test.ts` is that rule for
this stage.

---

## §9. Tests

Predicted `npm run test` after this stage: **2750 + 24 + 33 + 10 + 2 + 1 = 2820
tests, 137 files.** If your number differs, the difference must be explained by
a case you added or one you found impossible (report which), never by a file
that failed to load.

`commandParse.test.ts`: P1–P22 from §4, plus
- P23: `formatCommand(parseCommand(P1).command)` re-parses to the same command (round trip).
- P24: `formatCommand` of a command whose operator is `Lin On` produces a quoted `"Lin On"` and re-parses to the same command; and a command with `attach: { kind: "direct" }` formats to the same sentence as with `attach: null` (attach is never printed).

`commandResolve.test.ts`: R1–R33 from §5, the fixture verbatim, and every
`describeQuestion` string asserted verbatim in the case that produces it.

`commandPurity.test.ts` (two cases, file-content audit in the shape of
`popoverStandard.test.ts` — comments stripped first):
- U1: every `.ts` under `src/lib/command/` has no `import` that is not `import type`, and no `require(`.
- U2: `src/features/board/components/CommandBar.tsx` contains none of `createAssignment`, `useCreateAssignment`, `supabase`, `@/lib/api/mutations` (a type import of `AssignmentTarget` belongs in `useDragGesture.ts`, not the bar).

`commandBar.test.tsx` (mount with a small ctx built from the §5 fixture):
- C1: the input has the accessible name `Tell the board` (`getByRole("textbox", { name: "Tell the board" })`) and the placeholder is the example sentence.
- C2: typing P1's sentence and pressing Enter (ctx with `runs: []`) calls `onOpen` once with `nodeId: "c1a"`, `operatorId: "op1"`, `target: { kind: "direct", productId: "ha" }`, and the status line shows the readout with the day rendered through `formatDayLabel(_, dateFormat, zone)` (assert the ISO token is gone and the label for that day is present).
- C3: typing `assign Sam to Housing A on Cell 1 in Line 1 from 10 to 2` shows the ambiguous-operator question and two buttons, `Sam Patel` and `Sam Ortiz`; `onOpen` not called.
- C4: clicking `Sam Patel` rewrites the input to the canonical sentence with `Sam Patel` in it and calls `onOpen` with `operatorId: "sp"`.
- C5: an empty Enter shows `expectedShape()` and calls nothing.
- C6: `from 10:75 to 2` shows `I could not read "10:75".` followed by the shape.
- C7: Escape once clears the status line and keeps the input; Escape twice clears the input.
- C8: `onOpen`'s anchor is the input's rect bottom-left (mock `getBoundingClientRect`).
- C9: with the fixture's `runs` (run1), P1's sentence shows the run question verbatim (R27's string) and two buttons, `Housing A 08:00–16:00` and `Separate block`; `onOpen` not called.
- C10: clicking `Housing A 08:00–16:00` calls `onOpen` with `target: { kind: "run", runId: "run1" }` and the input unchanged; in a fresh mount, clicking `Separate block` calls `onOpen` with `target: { kind: "direct", productId: "ha" }`.

`pickerPool.test.ts`: add the bar's context to the named pickers, asserting
`BoardPage.tsx` hands `CommandBar`'s `operators:` the same `operatorPool`.

`e2e/roleWalk.spec.ts`: in the existing "Viewer Viva and admin Dana" case (or
a sibling in the same file), assert the `Tell the board` textbox is present for
Dana and absent for Viva — the same fact the panel already asserts.

---

## §10. Mutations — apply each, one at a time, and record which case fails

The PRIMARY column is the commitment. Collateral was measured against the
4 Sept reference implementation (§15) where it was measured at all; your cases
may differ — report the difference, do not chase it.

| # | break | primary | collateral measured |
|---|---|---|---|
| M1 | afternoon rule: never add 12h (P2's `2` stays 02:00 → `time_order`) | P2 | P4–P7, P9, P10, P14, P15, P17–P19, P21, P24 |
| M2 | afternoon rule: add 12h to every bare end, even one already after the start | P3 | P11, P22, P23, P24 |
| M3 | `12am` → 12 instead of 0 | P11 | — |
| M4 | treat any last word before the time clause as a day | P18 | most of the table |
| M5 | drop `to work on` from the operator/product separators | P1 (product becomes `work`) | P23 |
| M6 | ignore double quotes | P17 | P24 |
| M7 | `matchName` returns only the first hit when several match | R7 | R3, R4, R5, R12 |
| M8 | skip the `offeredAt` check | R15 | — |
| M9 | ignore qualifiers entirely | R1 (two "Cell 1"s → ambiguous) | nearly every ok row, R5 |
| M10 | resolve the person before the cell | R22 | — |
| M11 | day null → always index 0 | R1 (index 3 → 0) | R4, R8–R10, R13, R14, R24 |
| M12 | `dayIndex * 1440 + minute` instead of `ctx.wallToOffset` | R25 | — (inert on every plain-stub row, by design) |
| M13 | `too_short` uses `<=` instead of `<` | R24 | — |
| M14 | `openCreateFromCommand` omits `presetProductId` | none — **verified by the screenshot only; say so in the report** | — |
| M15 | `CommandBar` calls `onOpen` even when resolution returned a question | C3 | C4, C9 |
| M16 | match inactive people too | R7 (three candidates) | — |
| M17 | skip the run check (always direct) | R27 | R28, R32, R33, C9 |
| M18 | an `attach.runId` not among the hits falls back to direct | R33 | — |
| M19 | `fitsRun` retyped as overlap instead of passed-in containment | R30 | — |

Publish what you measured, not this table.

---

## §11. Non-goals, each with its reason

- **No speech.** The microphone is a later stage; it produces text and hands it to this bar. Building it here would tie the bar to one recogniser.
- **No free-form phrasing.** One shape, stated back to the person when missed. The later local model's whole job is the phrasing; the shape it must produce is §3's form, unchanged.
- **No saving of typed sentences.** It is the later training set, but it needs a table, a migration and a consent decision, none of which belong in a client-only stage. Say in the report where the hook point is (the `onOpen` call and the question path are the two events worth recording).
- **No cross-midnight span.** `time_order` refuses it. A night shift's sentence needs a day for each end, which is a form change, not a parser fix.
- **No "who is free", no move, no unassign, no "book a job".** Each is a new `intent` in the union; the union has one member on purpose so nothing downstream switches on it yet. (The maintainer's order for later: book a job, unassign, move; "who is free" goes to the chatbot's lookup menu.)
- **No autocomplete, no history.** The bar must not become a second operator picker; the popover is the picker.
- **No joining a job by name.** "Put Sam on the Housing A job" is the *book/staff a job* command; this stage only ASKS when the plain assign sentence happens to land inside one (R-383).

---

## §12. The plan is part of the deliverable (the developer session writes it; lanes report)

`docs/plan.yaml`, in the same commit as the code (CLAUDE.md §3):

**Stage** `S40`, track `core`, num 40, title `Tell the board what to do`,
status `now` while building and `done` when shipped, owner `agent`, refs
`[§19.88, D117, docs/agent-briefs/p1-7a-typed-command-bar-brief.md, docs/voice-commands-plan.md]`,
delivers `[R-378, R-379, R-380, R-381, R-382, R-383]`.

**Requirements** (all `stated_by: maintainer`, source: the maintainer, 3 Sept
(in session, "Assign operator 1 to work on Product A/Housing A on Cell 1 in
Line 1 from 10AM to 2PM") and 11 Sept (session 139) for R-383):

- `R-378` — *A typed sentence can place a person on a part at a cell for a span, and it does so through the same popover and the same server gate as a drag.* verified_by: `commandBar.test.tsx` C2/C4; `manual`.
- `R-379` — *The bar never guesses between candidates; it asks, with the choices as buttons.* verified_by: `commandResolve.test.ts` R3/R7/R12; `commandBar.test.tsx` C3/C4.
- `R-380` — *What will be created is spelled out in words — the person, the part, the cell with its line, the calendar day in the plant's zone and the 24-hour times — before anything is written.* verified_by: `commandResolve.test.ts` R1/R25; `commandBar.test.tsx` C2.
- `R-381` — *A refusal, an override or a split reached by typing is the same one reached by dragging, because it is the same code.* verified_by: `commandPurity.test.ts` U1/U2; `mutation` M14/M15; `manual`.
- `R-382` — *A sentence the bar cannot read is answered with the shape it can read, never with a guess.* verified_by: `commandParse.test.ts` P13–P16; `commandBar.test.tsx` C5/C6.
- `R-383` — *When the span lands inside a job already booked for that part on that cell, the bar asks whether to join the job or make a separate block, and joining sends the run target through the same popover.* verified_by: `commandResolve.test.ts` R27–R33; `commandBar.test.tsx` C9/C10; `manual`.

**`docs/design-plan.md`**: append `§19.88 — Tell the board (P1-7a)` with the
§2 rule and the parse/resolve split as its two decisions, and `D117 — a typed
command opens the create popover; it never writes.`

---

## §13. Acceptance — in order, all of them

1. `npm run test` collects the four new suites and reports **2820 / 137** (or the explained number).
2. `node node_modules/typescript/lib/tsc.js -b --force` is clean. No migration in this stage, so `db:types` is not in question and "clean" may be said.
3. `node node_modules/eslint/bin/eslint.js src/features/board src/lib/command src/test` is clean.
4. `npm run plan -- --check` exits zero.
5. Mutation table executed; results recorded per §10.
6. Screenshots: the bar with P1's sentence typed and the popover open beneath it, operator/part/times visibly pre-filled; a second with the R7 question and its two buttons; a third with the run question and the popover's `Joining …` line after pressing the run button.
7. `git status` shows only the files in §7 plus the plan and design-plan.
8. The developer session commits; lanes do not.

---

## §14. Your report (each lane)

In this order, plain language first:

1. What the maintainer can now do that they could not before — two sentences.
2. The numbers: tests before/after for YOUR files, tsc on your files, eslint, mutations caught of applied.
3. (Lane B) The two `operators=`/`hereOperatorIds=` lines you quoted from `BoardPage.tsx`, verbatim, and the `create_assignment` run-branch finding (§6).
4. Every case you could not make pass as written, with what you did instead; every existing case that went red and whether it was wrong or the contract changed.
5. Every fence you breached deliberately (§7), with the reason.
6. Where the sentence-saving hook point is (§11).
7. Anything you believe is wrong in this brief.

---

## §15. What this brief's author did and did NOT verify

**4 Sept draft:** P1–P24 and R1–R24 were run against a throwaway reference
implementation of `parse.ts` and `resolve.ts` (pure TS,
`node --experimental-strip-types`, outside the repo), and every row's result in
those tables is what that run printed. Mutations M1–M9 and M11–M13 were applied
to that reference one at a time. M10, M14, M15 and every C-case were NOT
executed. The reference was not typechecked.

**11 Sept refresh (session 139), re-verified by reading the tree, not by
running anything new:** the popover's `operators={operatorPool}` and
`hereOperatorIds` props and its `here`/`elsewhere` split (R-342/R-346; the
draft's "popover receives every operator" finding is dead and must NOT be
filed); `productsOfferedAtNode(active, nodeId)` replacing the path-based
function; `index.zone` and `index.dayAxis.wallToOffset` (D88a/D88b) replacing
the UTC-midnight arithmetic; `canPlace` gating the panel and the popover;
`assignmentFitsRun` and `AssignmentTarget` existing and the popover never
sending a run target; the four audits and `pickerPool.test.ts`; the absence of
any ESLint import boundary; the positional `productId` readers in three test
files. **Not executed in the refresh:** R25–R33, M12 (new meaning), M16–M19,
C9–C10 — they were written from the rules above, not run. The predicted test
count is arithmetic on the case lists, not a runner's line. The demo world's
plant zone was checked by the reviewer: Plant A has no zone override (UTC, no changeover), and the
seeded world has exactly one "Cell 1" anywhere, so R25 is the only DST proof and R3 the only place-ambiguity proof; the 8 Sept runs on Line 1 are "Line 1 Subassembly A", the 7 Sept ones "Housing A".
