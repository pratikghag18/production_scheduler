# P1-7a — "Tell the board": the typed command bar

**You are building the typed half of a spoken feature.** The maintainer wants to
be able to say *"Assign Operator 1 to Housing A on Cell 1 in Line 1 from 10AM to
2PM"* and have the board do it. Speech, and the small local language model that
will later read free-form sentences, are later stages (§11). This stage ships the
part every later stage stands on: a text box on the board that reads ONE fixed
sentence shape, turns the words into the records they name, and opens the
existing create popover pre-filled so the person can look at it and press
Create. **No new way of writing to the database is built here.** Read §2 twice.

Before anything else: `CLAUDE.md` §1 — read `docs/plan.yaml`, run `git merge
tester`, read the open defects, and confirm the baseline (`npm run test` must
report the count in the newest `confirmed: true` session — 1753 tests in 57
files at the time of writing; if the number differs, chase that first).

---

## §1. What this is, in the product's words

A scheduler looks at the board and types, in one line, who goes where, on what,
and when. The board reads the line, works out which person, which part and
which cell it means, and — instead of writing anything — opens the same "New
block" popover that a drag would have opened, with everything already filled
in: the operator selected, the part selected, the times set, the cell chosen.
The person checks it and presses **Create**. Everything that happens after
Create is what already happens today: the training warning with its override
box, the "not from this line" warning with its reason box, the capacity probe
and the split popover, the server's refusal shown in words if it refuses.

If the line is not clear the bar asks **one** question with the choices as
buttons — *"Two people match 'Sam' — Sam Patel · Sam Ortiz"* — and pressing a
button puts the exact name into the sentence. If the line does not have the
shape the bar understands, the bar shows the shape it understands, with an
example, rather than guessing.

What the maintainer gets after this stage: typing is faster than dragging for a
person who knows the board, and every sentence anyone types becomes the raw
material for the later model.

---

## §2. ⛔ THE ONE DESIGN RULE: NO SECOND DOOR

Every assignment on the board today goes through `createAssignment` in
`src/lib/api/mutations.ts`, which calls the server's `create_assignment`, which
refuses an untrained person, a person outside their area without a reason, an
overlap, a product not offered at that cell, and a scheduler who may not write
there. On the screen, the ONLY thing that calls `createAssignment` for a new
block is `submitCreateDirect` in `src/features/board/hooks/useDragGesture.ts`,
and the only thing that calls `submitCreateDirect` is `CreatePopover`.

**This stage adds nothing to that chain and calls nothing in it directly.** The
command bar's whole job ends when it opens `CreatePopover` in direct mode with
the fields pre-filled. From that moment the bar is out of the picture: the
popover, the probe, the split, the override boxes and the server are exactly
the ones a drag uses, because they are literally the same code path (D65 made a
panel drop open the create popover in forced direct mode with the operator
preset; this stage opens it the same way, with the product and the times preset
too). **If you find yourself importing `createAssignment`, `useCreateAssignment`
or `supabase` into anything under `lib/command/` or into `CommandBar.tsx`, stop
— that is a second door arriving through the side.**

The same rule for the RULES. The bar does not decide who is trained, who
belongs at a cell, or which parts are offered there. Where it needs to narrow a
list it uses the function the board already uses for that list
(`productsOfferedHere` for parts, the board's already-narrowed operator pool for
people — §8), so the bar and the popover cannot disagree about what is on offer.

---

## §3. The form — what a sentence turns into

Two pure modules, no React, no imports outside `import type` and each other,
so `node --experimental-strip-types` can run their tests and so the later model
can produce the SAME form and hand it to the SAME resolver (that is the point
of separating parse from resolve: the model replaces `parse.ts` one day and
nothing else moves).

### `src/features/board/lib/command/parse.ts`

```ts
/** A clock time on the board's own clock (BOARD_ZONE in time.ts), 24h. */
export interface ClockTime {
  hour: number;   // 0–23
  minute: number; // 0–59
}

/** Which day, as the person said it. null = "the day the board is showing" (§5). */
export type DayWord =
  | { kind: "today" }
  | { kind: "tomorrow" }
  | { kind: "weekday"; day: 0 | 1 | 2 | 3 | 4 | 5 | 6 } // 0 = Sunday, matching Date#getUTCDay
  | { kind: "date"; iso: string };                      // "2026-09-04"

export interface AssignCommand {
  intent: "assign";
  /** The words the person used, trimmed, original case. NEVER an id. */
  operator: string;
  product: string;
  /** Place words, most specific first: "Cell 1 in Line 1" -> ["Cell 1", "Line 1"]. At least one. */
  place: string[];
  day: DayWord | null;
  start: ClockTime;
  end: ClockTime;
}

export type ParseFailure =
  | { kind: "empty" }
  | { kind: "no_time" }            // no "from <time> to <time>" clause at the end
  | { kind: "bad_time"; text: string }
  | { kind: "time_order" }         // end not after start even after the afternoon rule
  | { kind: "no_product" }         // operator given, nothing after it
  | { kind: "no_place" }           // operator and product given, no place
  | { kind: "bad_day"; text: string };

export type ParseResult =
  | { ok: true; command: AssignCommand }
  | { ok: false; failure: ParseFailure };

export function parseCommand(text: string): ParseResult;

/** The canonical sentence for a command — the inverse of parseCommand for the
 *  shape in §4 (24h times, `on … in …` places, names quoted when they contain
 *  a separator word). The bar rebuilds the input from this after a candidate
 *  button is pressed (§6). */
export function formatCommand(command: AssignCommand): string;

/** The one sentence the bar shows when parsing fails — see §6. */
export function expectedShape(): string;
```

### `src/features/board/lib/command/resolve.ts`

```ts
import type { AssignCommand } from "./parse.ts";

/** What the resolver is allowed to know. Built by BoardPage from the index (§8). */
export interface ResolveContext {
  /** Track rows only (level.isSchedulable), active, in the loaded window. */
  cells: ReadonlyArray<{ id: string; name: string; path: string }>;
  /** Every node the index knows, for walking a cell's ancestors by name. */
  nodeById: ReadonlyMap<string, { id: string; name: string; path: string }>;
  /** The board's assignable pool — the same list the create popover is given. */
  operators: ReadonlyArray<{ id: string; displayName: string; employeeRef: string | null }>;
  /** Parts, NOT yet narrowed to a cell — the resolver narrows per cell with `offeredAt` below. */
  products: ReadonlyArray<{ id: string; sku: string; name: string; siteNodeIds: readonly string[] }>;
  /** The board's own scope rule, passed in so this module needs no import: BoardPage hands
   *  `(products, cellPath) => productsOfferedHere(products, cellPath, index.nodeById)`. */
  offeredAt: (products: ResolveContext["products"], cellPath: string) => ResolveContext["products"];
  windowStart: Date;   // index.windowStart — a UTC midnight
  dayCount: number;    // index.dayCount
  now: Date;           // injected, never read from the clock inside the module
  minDurationMinutes: number; // MIN_DURATION_MINUTES from interaction.ts, passed in
}

export interface ResolvedCommand {
  nodeId: string;
  operatorId: string;
  productId: string;
  /** Minutes from windowStart, the popover's own Range. */
  range: { startMin: number; endMin: number };
  /** For the bar's status line and the announcement: "Sam Patel → Housing A · Line 1 › Cell 1 · <day> · 10:00–14:00" */
  readout: string;
}

export type Candidate = { id: string; label: string; /** what to put in the sentence */ word: string };

export type Question =
  | { kind: "ambiguous"; field: "operator" | "product" | "place"; text: string; candidates: Candidate[] }
  | { kind: "unknown"; field: "operator" | "product" | "place"; text: string }
  | { kind: "not_offered"; product: string; cell: string }      // the part exists, not at this cell
  | { kind: "place_mismatch"; cell: string; qualifier: string; elsewhere: Candidate[] } // "no Cell 1 in Line 1; Cell 1 is in Line 3"
  | { kind: "day_off_board"; text: string }
  | { kind: "too_short"; minutes: number };

export type Resolution =
  | { ok: true; resolved: ResolvedCommand }
  | { ok: false; question: Question };

export function resolveCommand(command: AssignCommand, ctx: ResolveContext): Resolution;

/** The sentence for a Question — the words the bar shows. Pure, so it is tested. */
export function describeQuestion(q: Question): string;
```

The readout's day part is the calendar day. `resolve.ts` cannot import the date
seam (strip-types and the no-import rule), so `readout` carries the day as an
ISO date string inside the sentence, and **`CommandBar` re-renders the day
through `formatDayLabel(date, dateFormat)` from `../lib/time`** for display
(the date-seam audit `dateSeam.test.ts` will fail the build on any other
formatter — read its header). Concretely: `readout` is
`"<operator> → <product> · <ancestors › cell> · <YYYY-MM-DD> · HH:MM–HH:MM"`
and the bar replaces the ISO token when it renders. Test the pure string; the
bar's substitution is one `replace` and is covered by the component test (§9).

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

Worked examples — **these are test cases, verbatim (§9, P-cases)**:

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
`employeeRef`. The list is exactly what `BoardPage` passes the create popover
as `operators` (§6, §8) — nobody outside it, and nobody filtered out of it
either: a person outside their area is a legitimate choice with a reason,
and the popover is where that reason is asked for.

**Parts** are matched on `name`, then `sku`, then the whole word against
`"<sku>/<name>"`, then — because the maintainer's own example was `Product
A/Housing A` — each `/`-separated piece of the word against name and sku,
accepting only if exactly one part matches across pieces. Then the winner is
checked with `ctx.offeredAt([winner], cell.path)`: empty → `not_offered`
(the part is real; it is not made at this cell, and the server would refuse it
with no override, so the bar says so instead of opening a popover that cannot
succeed). Products are narrowed to `active` by `BoardPage` before they reach
the context, the same filter the popover's list gets.

**Cells**: the FIRST place word is matched against `ctx.cells` (track rows
only — you cannot assign onto a line or a department, and the popover would
not open there either). Each FURTHER place word is a qualifier: it must match
(same three tiers) the name of some ancestor of the cell, found by walking
`cell.path` through `ctx.nodeById` exactly as `ancestorPaths` in
`boardIndex.ts` does — copy that function's *idea* (split the ltree path,
prefixes nearest-first), not its export; `boardIndex.ts` imports React-free
modules but the rule in §3 is that `resolve.ts` imports nothing. Cells left after
qualifiers: one → resolved; several → `ambiguous` (field `place`) with each
candidate labelled `"Cell 1 — Plant 1 › Assembly › Line 3"` (the ancestor chain,
root first) so the buttons are tellable apart; none, but there were cells before the qualifiers were applied →
`place_mismatch` naming where the cell actually is; none at all → `unknown`.

**Order of resolution is cell, then part, then person**, so that a question
about the part can name the cell ("Housing A is not made at Cell 1") and a
sentence with two problems asks about the FIRST one only. One question at a
time; the person fixes it and presses Enter again.

**Day**: `null` → today if today (in `BOARD_ZONE`, from `ctx.now`) is inside the
window, else the window's first day. `today`/`tomorrow` → from `ctx.now`; a
weekday → the first day in the window with that weekday; a date → that date.
Any of these outside `[windowStart, windowStart + dayCount days)` →
`day_off_board` with the day as the person said it. The day index times 1440
plus the clock minutes is the `Range`.

**Duration**: `endMin - startMin < ctx.minDurationMinutes` → `too_short`. The
number is passed in from `MIN_DURATION_MINUTES` in `lib/interaction.ts` (D31),
never retyped.

`describeQuestion` returns, for each kind (these strings are tested verbatim):

| kind | text |
|---|---|
| ambiguous | `Which <person / part / cell>? "<text>" matches <n>:` (the candidates render as buttons after it) |
| unknown | `No <person / part / cell> called "<text>" on this board.` |
| not_offered | `<product> is not made at <cell>, so it cannot be scheduled there.` |
| place_mismatch | `There is no <cell> in <qualifier>. <cell> is in <elsewhere labels, joined by " / ">.` |
| day_off_board | `<text> is not on the board. Move the board to that day first.` |
| too_short | `That is <minutes> minutes; a block is at least <min> minutes.` |

**Worked examples — test cases, verbatim (§9, R-cases).** The fixture is
published in full so your collateral matches the table (brief rule 14):

```ts
// windowStart 2026-08-31T00:00:00Z (a Monday), dayCount 7, now 2026-09-03T15:00:00Z (Thursday)
// levels: plant (not schedulable), line (not), cell (schedulable)
// nodes (id, name, path):
//   p1 "Plant 1" plant_1 · asm "Assembly" plant_1.assembly
//   l1 "Line 1" plant_1.assembly.line_1 · l3 "Line 3" plant_1.assembly.line_3
//   c1a "Cell 1" plant_1.assembly.line_1.cell_1 · c2 "Cell 2" plant_1.assembly.line_1.cell_2
//   c1b "Cell 1" plant_1.assembly.line_3.cell_1
// cells: c1a, c2, c1b
// operators: op1 "Operator 1" ref "E100" · sp "Sam Patel" ref null · so "Sam Ortiz" ref "E200" · lin "Lin On" ref null
// products: ha "Housing A" sku "HA-1" sites [l1] · hb "Housing B" sku "HB-1" sites [l1] · cov "Cover" sku "CV-9" sites [l3]
// offeredAt: keeps a product when any of its siteNodeIds is a path-prefix of cellPath
//   (this fixture stub mirrors productsOfferedHere's rule; the real one is passed in by BoardPage)
// minDurationMinutes 15
```

| # | command (already parsed) | result |
|---|---|---|
| R1 | op `Operator 1`, `Housing A`, `["Cell 1","Line 1"]`, day null, 10:00–14:00 | ok: c1a, op1, ha, range 3·1440+600 … 3·1440+840 (today = Thu = day index 3), readout `Operator 1 → Housing A · Plant 1 › Assembly › Line 1 › Cell 1 · 2026-09-03 · 10:00–14:00` |
| R2 | same, 09:00–09:10 | too_short 10 |
| R3 | `Cell 1` alone, no qualifier | ambiguous place, candidates `Cell 1 — Plant 1 › Assembly › Line 1` (c1a) and `… › Line 3` (c1b), in `cells` order |
| R4 | `["Cell 1","Line 3"]`, product `Cover` | ok: c1b, cov |
| R5 | `["Cell 1","Line 2"]` | place_mismatch cell `Cell 1`, qualifier `Line 2`, elsewhere both c1a and c1b labels |
| R6 | `["Cell 9"]` | unknown place `Cell 9` |
| R7 | `Sam`, c1a | ambiguous operator, candidates Sam Patel (word `Sam Patel`), Sam Ortiz |
| R8 | `sam patel` | ok, sp (exact tier, case-insensitive) |
| R9 | `E200` | ok, so (employeeRef fallback) |
| R10 | `Pat` | ok, sp — "contains" tier, one hit |
| R11 | `Nobody` | unknown operator |
| R12 | product `Housing` | ambiguous product, ha and hb |
| R13 | product `HA-1` | ok, ha (sku) |
| R14 | product `Product A/Housing A` | ok, ha — piece `Housing A` matches by name, `Product A` matches nothing |
| R15 | product `Cover` at c1a | not_offered `Cover` at `Cell 1` |
| R16 | product `Gasket` | unknown product |
| R17 | day tomorrow | day index 4 (Fri) |
| R18 | day weekday 1 (Monday) | day index 0 |
| R19 | day weekday 0 (Sunday) | day index 6 |
| R20 | day date `2026-09-08` | day_off_board `2026-09-08` — the window is 31 Aug through 6 Sep (7 Sep exclusive); add the twin: `2026-09-06` resolves to day index 6 |
| R21 | day null with `now` = 2026-09-20 (outside window) | day index 0 (window's first day) |
| R22 | a sentence with BOTH an unknown cell and an unknown operator | the question is about the cell (order: cell, part, person) |
| R23 | ctx with `cells` = [] | unknown place (nothing to match) — never throws |
| R24 | R1 with 10:00–10:15 | ok — exactly the minimum is allowed (this row exists so M13 has something to fail) |

The order of candidates is the order of the source list; the resolver does not
sort (the board's own order is deterministic and the popover shows the same).

---

## §6. The screen

### `src/features/board/components/CommandBar.tsx` (+ `.module.css`)

One row under the toolbar, above the grid, rendered by `BoardPage` only when
the board has data (`hasData`), because the popover cannot open without an
index and the bar has nothing to resolve against.

- A single text input, **the shared field** (`className={fieldStyles.field}`
  from `@/components/Field.module.css`, R-318 — `fieldStandard.test.ts` fails
  the build if the bar's stylesheet declares its own field border). Accessible
  name `Tell the board` (a `<label>` — visually hidden is fine; the placeholder
  is the example sentence `Assign Sam to Housing A on Cell 1 in Line 1 from 10 to 2`
  and a placeholder is not a name).
- Enter → `parseCommand` → `resolveCommand` → either `onOpen(resolved)` or a
  status line under the input.
- The status line is ONE element with `aria-live="polite"`, and it shows one of:
  the parse failure (`expectedShape()` — one sentence: `Say it like: assign
  <person> to <part> on <cell> [in <line>] [on <day>] from <time> to <time>` —
  plus, for `bad_time`/`bad_day`, `I could not read "<text>".` in front); a
  question from `describeQuestion` followed by the candidates as buttons; or,
  after a successful open, the readout (with the ISO day replaced through
  `formatDayLabel`) so the person sees in words what the popover is showing.
- Clicking a candidate button **replaces the matched words in the input with
  the candidate's `word`** and re-runs Enter. Replacing means: the field the
  question was about (`operator` / `product` / `place`) is what changes — keep
  the `AssignCommand` from the last parse, substitute that field (for `place`,
  the first place word, and drop the qualifiers), and rebuild the sentence with
  `formatCommand(command)` (add it to `parse.ts`; it is the inverse of
  `parseCommand` for the canonical shape and is tested as such, P23–P24 in §9).
  Rebuilding the sentence rather than splicing text is what keeps a quoted
  name quoted.
- Escape clears the status line; a second Escape clears the input.
- No history, no autocomplete, no suggestions while typing (§11).

Props:

```ts
{
  ctx: ResolveContext;
  dateFormat: DateFormat;
  onOpen: (resolved: ResolvedCommand, anchor: { x: number; y: number }) => void;
}
```

`anchor` is the input's bounding rect: `{ x: rect.left, y: rect.bottom }`, so
the popover hangs off the bar the way it hangs off a drop point.

Visual: the bar sits in the same band as the toolbar's controls, full width,
one line tall, with the status line beneath in the toolbar's small text size.
Use the toolbar's existing tokens (`BoardToolbar.module.css` is the reference
for spacing and font size); do not introduce a colour. Candidate buttons are
`fieldStyles.btn`. Render it, look at it at the board's default zoom and at
`--ui-scale` 0.8, and include the screenshot in your report.

### `useDragGesture.ts` — one new action

Add to the returned object:

```ts
openCreateFromCommand: (r: {
  nodeId: string;
  range: Range;
  operatorId: string;
  productId: string;
  anchor: { x: number; y: number };
}) => void;
```

Its body is the tail of `endPanelDrag` (the block that starts `const template =
index.templateForNode.get(hit.nodeId) ?? null;`) with the snapping removed —
the resolver's minutes are already exact — and two presets:

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
  presetProductId: r.productId,
});
```

`PopoverState`'s `create` member gains `presetProductId?: string`. Do not
touch `endPanelDrag`; the duplicated five lines are the price of not changing a
drop path this stage does not own (brief rule 10 — report the duplication, do
not refactor it).

### `CreatePopover.tsx` — one new optional prop

`presetProductId?: string`, and the only change in the body is
`useState(presetProductId ?? "")` for `productChoice`. The existing derivation
(`productId = products.some(...) ? productChoice : firstOffered`) already
handles a preset that is not on offer at this cell by falling back — but the
resolver has already refused that case (`not_offered`), so the fallback is a
belt, not the braces. `mode` already forces `"direct"` when `presetOperatorId`
is set; nothing to add.

### `BoardPage.tsx` — wiring

Build the context beside the existing `offeredProducts` memo, from the same
sources it uses:

```ts
const commandCtx = useMemo<ResolveContext | null>(() => {
  if (!boardQuery.data || index === null) return null;
  return {
    cells: index.rows.filter((r) => r.isTrack).map((r) => r.node),
    nodeById: index.nodeById,
    operators: /* the SAME list the popover receives as `operators` — see below */,
    products: boardQuery.data.products.filter((p) => p.active),
    offeredAt: (ps, cellPath) => productsOfferedHere(ps, cellPath, index.nodeById),
    windowStart: index.windowStart,
    dayCount: index.dayCount,
    now: new Date(),
    minDurationMinutes: MIN_DURATION_MINUTES,
  };
}, [boardQuery.data, index /* + whatever the operator list depends on */]);
```

The operator list is **whatever `<CreatePopover operators={…}>` is passed** —
read that line and pass the identical value, so the bar can name exactly the
people the popover's dropdown will then show and no others. **Quote the line in
your report.** ⚠️ At the time of writing the popover receives
`boardQuery.data?.operators ?? []` (every operator on the wire) while the left
panel receives `operatorPool` (the ⭐ "assignable pool, cut to the chosen
plant" memo — `ownedInScope(all, …)`). That looks like the left panel's own
defect ("a system admin who picks one plant still saw every plant's
operators") surviving in the popover's dropdown. **Do not fix it in this
stage** — the bar follows the popover, whichever list it has — but write it up
as a `findings` card (`found_by: agent`, status `open`) in `docs/plan.yaml` and
name it in your report. If the maintainer has already changed the popover to
`operatorPool` by the time you build, the rule stands: follow the popover. `now: new Date()` inside a memo is deliberately coarse: it changes
when the board data changes, which is at least every refetch, and a sentence
typed at 23:59 resolving against a "today" from 30 seconds earlier is not a
defect worth a timer.

Render `<CommandBar ctx={commandCtx} dateFormat={dateFormat}
onOpen={(r, anchor) => dragApi.openCreateFromCommand({ ...r, anchor })} />`
between `BoardToolbar` and the grid, only when `commandCtx !== null`.

---

## §7. Files

**Add**

- `src/features/board/lib/command/parse.ts` — pure, no imports.
- `src/features/board/lib/command/resolve.ts` — pure, `import type` from `./parse.ts` only.
- `src/features/board/components/CommandBar.tsx`
- `src/features/board/components/CommandBar.module.css`
- `src/test/commandParse.test.ts` — vitest, `describe`/`it`/`expect`, **one plain `it()` per case, no `it.each`** (brief rule 5/11), cases P1–P24.
- `src/test/commandResolve.test.ts` — same, R1–R24, the §5 fixture verbatim.
- `src/test/commandBar.test.tsx` — same shape as `settingsPanel.test.tsx` (`@testing-library/react`, jsdom), cases C1–C8.

**Change**

- `src/features/board/hooks/useDragGesture.ts` — `openCreateFromCommand`, `presetProductId` on `PopoverState`.
- `src/features/board/components/CreatePopover.tsx` — `presetProductId` prop.
- `src/features/board/BoardPage.tsx` — `commandCtx`, render the bar, pass `presetProductId` through to the popover from `popover.presetProductId`.
- `docs/plan.yaml` — §12.
- `docs/design-plan.md` — §12.

**Do not change**: anything under `src/lib/api/`, anything under `supabase/`,
`submitCreateDirect`, `endPanelDrag`, `scope.ts`, `interaction.ts`. If one of
them is in your way, say so in the report and stop at the boundary.

The fences are by property: nothing new may write to the database; nothing new
may hold a copy of a rule that `scope.ts`, the popover or the server already
holds. A CSS Module is one per component; `CommandBar.module.css` is the bar's
only stylesheet and declares no field border and no month names.

---

## §8. What already exists — quoted, so you read it rather than predict it

`src/features/board/hooks/useDragGesture.ts`, the create popover state:

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

and the tail of `endPanelDrag` this stage copies from:

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

`src/features/board/components/CreatePopover.tsx`:

```ts
  const [mode, setMode] = useState<"run" | "direct">(
    presetOperatorId ? "direct" : defaultCreateMode,
  );
  …
  const [productChoice, setProductChoice] = useState("");
  const firstOffered = products[0]?.id ?? "";
  const productId = products.some((p) => p.id === productChoice) ? productChoice : firstOffered;
  …
  const [operatorId, setOperatorId] = useState(presetOperatorId ?? operators[0]?.id ?? "");
```

`src/features/board/lib/boardIndex.ts` — the index the context is built from:

```ts
export interface BoardIndex {
  windowStart: Date;
  windowMinutes: number;
  dayCount: number;
  rows: BoardRow[];            // BoardRow has `node: BoardNode` and `isTrack: boolean`
  …
  productById: Map<string, Product>;
  operatorById: Map<string, BoardOperator>;
  nodeById: Map<string, BoardNode>;
  …
}
```

`src/lib/api/shapes.ts`: `BoardNode { id; parentId; levelId; name; path; sortOrder; active }`,
`BoardOperator { id; homeNodeId; displayName; employeeRef; active; siteNodeId; skillIds }`,
`Product { id; sku; name; active; siteNodeIds; … }`.

`src/features/admin/lib/scope.ts`:

```ts
export function productsOfferedHere<T extends { siteNodeIds: readonly string[] }>(
```

— already imported by `BoardPage.tsx` (`import { offeredHere, ownedInScope,
productsOfferedHere } from "@/features/admin/lib/scope";`). Use that import;
do not add a second path to the rule.

`src/features/board/lib/interaction.ts`: `export const MIN_DURATION_MINUTES = 15; // D31`.

`src/features/board/lib/time.ts`: `BOARD_ZONE = "UTC"`, `addMinutes`,
`formatClock` (24h, `hourCycle: "h23"`, in `BOARD_ZONE`), `formatDayLabel(d, fmt)`.
`windowStart` is a UTC midnight, so "day index × 1440 + clock minutes" is exact
and no DST arithmetic exists on this board (R-D88).

Audits that will fail your build if you forget them, all in `src/test/`:
`fieldStandard.test.ts` (no field border outside `Field.module.css`),
`dateSeam.test.ts` (no `Intl.DateTimeFormat`/`toLocaleDateString`/month-name
array outside the two seams), `iconStandard.test.ts` (no raw chevron glyphs),
`popoverStandard.test.ts` (no `role="dialog"` outside `Popover.tsx` — the bar
is not a dialog and must not become one). `scaleAudit`'s `REM_SURFACES` lists
admin stylesheets only; the board is not on it, so nothing to add there — say
so in your report rather than assuming.

---

## §9. Tests

Predicted `npm run test` after this stage: **1753 + 24 + 24 + 8 = 1809 tests, 60 files.**
If your number differs, the difference must be explained by a case you added or
one you found impossible (report which), never by a file that failed to load.

`commandParse.test.ts`: P1–P22 from §4, plus
- P23: `formatCommand(parseCommand(P1).command)` re-parses to the same command (round trip).
- P24: `formatCommand` of a command whose operator is `Lin On` produces a quoted `"Lin On"` and re-parses to the same command.

`commandResolve.test.ts`: R1–R24 from §5, the fixture verbatim, and every
`describeQuestion` string asserted verbatim in the case that produces it.

`commandBar.test.tsx` (mount with a small ctx built from the §5 fixture):
- C1: the input has the accessible name `Tell the board` (`getByRole("textbox", { name: "Tell the board" })`) and the placeholder is the example sentence. (The shared-field requirement is enforced by `fieldStandard.test.ts` on the stylesheet, not asserted here — vitest runs with `css: false`, so class names are not reliably inspectable.)
- C2: typing P1's sentence and pressing Enter calls `onOpen` once with `nodeId: "c1a"`, `operatorId: "op1"`, `productId: "ha"`, and the status line shows the readout with the day rendered through `formatDayLabel` (assert the ISO token is gone and the label for that day is present).
- C3: typing `assign Sam to Housing A on Cell 1 in Line 1 from 10 to 2` shows the ambiguous-operator question and two buttons, `Sam Patel` and `Sam Ortiz`; `onOpen` not called.
- C4: clicking `Sam Patel` rewrites the input to the canonical sentence with `Sam Patel` in it and calls `onOpen` with `operatorId: "sp"`.
- C5: an empty Enter shows `expectedShape()` and calls nothing.
- C6: `from 10:75 to 2` shows `I could not read "10:75".` followed by the shape.
- C7: Escape once clears the status line and keeps the input; Escape twice clears the input.
- C8: `onOpen`'s anchor is the input's rect bottom-left (mock `getBoundingClientRect`).

---

## §10. Mutations — apply each, one at a time, and record which case fails

The PRIMARY column is the commitment. Collateral was measured against the
brief author's reference implementation (§15); your cases may differ — report
the difference, do not chase it (brief rule 14).

| # | break | primary | collateral measured |
|---|---|---|---|
| M1 | afternoon rule: never add 12h (P2's `2` stays 02:00 → `time_order`) | P2 | P4–P7, P9, P10, P14, P15, P17–P19, P21, P24 (every row whose end is a bare hour) |
| M2 | afternoon rule: add 12h to every bare end, even one already after the start | P3 | P11, P22, P23, P24 |
| M3 | `12am` → 12 instead of 0 | P11 | — |
| M4 | treat any last word before the time clause as a day | P18 | most of the table (the last place word disappears) |
| M5 | drop `to work on` from the operator/product separators | P1 (product becomes `work`) | P23 |
| M6 | ignore double quotes | P17 | P24 |
| M7 | `matchName` returns only the first hit when several match | R7 | R3, R4, R5, R12 |
| M8 | skip the `offeredAt` check | R15 | — |
| M9 | ignore qualifiers entirely | R1 (two "Cell 1"s → ambiguous) | nearly every ok row, R5 |
| M10 | resolve the person before the cell | R22 | — (reasoned, not executed — §15) |
| M11 | day null → always the window's first day | R1 (index 3 → 0) | R4, R8–R10, R13, R14, R24 |
| M12 | weekday uses `getDay` instead of `getUTCDay` | R18 | R19 — **inert in a UTC test run**; caught only under `TZ=America/Chicago`. Run vitest once with that `TZ` and record it; do not make the suite depend on the zone |
| M13 | `too_short` uses `<=` instead of `<` | R24 | — |
| M14 | `openCreateFromCommand` omits `presetProductId` | none — **verified by the screenshot only; say so in the report** | — |
| M15 | `CommandBar` calls `onOpen` even when resolution returned a question | C3 | C4 possibly |

Publish what you measured, not this table.

---

## §11. Non-goals, each with its reason

- **No speech.** The microphone is a later stage; it produces text and hands it to this bar. Building it here would tie the bar to one recogniser.
- **No free-form phrasing.** One shape, stated back to the person when missed. The later local model's whole job is the phrasing; the shape it must produce is §3's form, unchanged.
- **No attaching to an existing run.** The sentence always makes a DIRECT block (the popover's direct mode), even when a run of that part already sits on that cell at that time. "Put Sam on the Housing A job" is the *book/staff a job* command, a later stage with its own form; the maintainer has a decision to make there (§12, "for the maintainer").
- **No saving of typed sentences.** It is the later training set, but it needs a table, a migration and a consent decision, none of which belong in a client-only stage. Say in the report where the hook point is (the `onOpen` call and the question path are the two events worth recording).
- **No cross-midnight span.** `time_order` refuses it. A night shift's sentence needs a day for each end, which is a form change, not a parser fix.
- **No "who is free", no move, no unassign.** Each is a new `intent` in the union; the union has one member on purpose so nothing downstream switches on it yet.
- **No autocomplete, no history.** The bar must not become a second operator picker; the popover is the picker.

---

## §12. The plan is part of the deliverable

`docs/plan.yaml`, in the same commit as the code (CLAUDE.md §3):

**Stage** `S26`, track `core`, num 26, title `Tell the board what to do`, status
`done` when shipped, owner `agent`, refs `[§19.88, D116]`, delivers
`[R-321, R-322, R-323, R-324, R-325]`. `what:` in the maintainer's register — the
§1 text is the model. `state:` the numbers you measured.

**Requirements** (all `stated_by: maintainer`, `source: [the maintainer, 3 Sept (in
session, "Assign operator 1 to work on Product A/Housing A on Cell 1 in Line 1
from 10AM to 2PM"), §19.88]`):

- `R-321` — *A typed sentence can place a person on a part at a cell for a span, and it does so through the same popover and the same server gate as a drag.* verified_by: `commandBar.test.tsx` C2/C4 (the popover opener is called with the resolved ids); `manual` steps: type the sentence, see the create popover open pre-filled, press Create, see the block.
- `R-322` — *The bar never guesses between candidates; it asks, with the choices as buttons.* verified_by: `commandResolve.test.ts` R3/R7/R12; `commandBar.test.tsx` C3/C4.
- `R-323` — *What will be created is spelled out in words — the person, the part, the cell with its line, the calendar day and the 24-hour times — before anything is written.* verified_by: `commandResolve.test.ts` R1 (readout); `commandBar.test.tsx` C2.
- `R-324` — *A refusal, an override or a split reached by typing is the same one reached by dragging, because it is the same code.* verified_by: `mutation` — M14/M15 as measured, plus a `manual` step: type a sentence naming a person outside their area and see the same "not from this line" box the drag shows.
- `R-325` — *A sentence the bar cannot read is answered with the shape it can read, never with a guess.* verified_by: `commandParse.test.ts` P13–P16; `commandBar.test.tsx` C5/C6.

**Session** entry at the top of `sessions`: date, title, `shipped: [S26]`,
commits, numbers read off the runners, `confirmed: true` only if you ran
`npm run test` yourself.

**`docs/design-plan.md`**: append `§19.88 — Tell the board (P1-7a)` with the
§2 rule and the parse/resolve split as its two decisions, and `D116 — a typed
command opens the create popover; it never writes.` Dense register is fine
there; it is the archive.

Then `npm run plan` — a red validator is a finished piece with a hole in it.

---

## §13. Acceptance — in order, all of them

1. `npm run test` collects the three new suites and reports **1809 / 60** (or your explained number).
2. `node node_modules/typescript/lib/tsc.js -b --force` is clean. No migration in this stage, so `db:types` is not in question and "clean" may be said.
3. `node node_modules/eslint/bin/eslint.js src/features/board src/test` is clean (the whole repo does not fit in one call).
4. `npm run plan -- --check` exits zero.
5. Mutation table executed; results recorded per §10.
6. Screenshot: the bar with P1's sentence typed and the popover open beneath it, operator/part/times visibly pre-filled; a second with the R7 question and its two buttons.
7. `git status` shows only the files in §7 plus the plan and design-plan.
8. Commit, message in the repo's style (prose, ASCII, no bullets; nothing names a person or a machine).

---

## §14. Your report

In this order, plain language first:

1. What the maintainer can now do that they could not before — two sentences.
2. The numbers: tests before/after, files, tsc, eslint, mutations caught of applied.
3. The operator-list line you quoted from `BoardPage.tsx` (§6), verbatim.
4. Every case you could not make pass as written, with what you did instead.
5. Every fence you breached deliberately (§7), with the reason.
6. Where the sentence-saving hook point is (§11).
7. Anything you believe is wrong in this brief.

---

## §15. What this brief's author did NOT verify

Brief rule 5 says the acceptance and mutation tables are run before a brief
ships. What was and was not done here:

- **Executed:** P1–P24 and R1–R24 were run against a throwaway reference
  implementation of `parse.ts` and `resolve.ts` written from §3–§5 (pure TS,
  `node --experimental-strip-types`, outside the repo), and every row's result
  in the tables is what that run printed. Mutations M1–M9 and M11–M13 were
  applied to that reference one at a time; the primary and collateral columns
  are what was measured. The author's first reading of P9 was wrong before the
  run — reason to run yours.
- **Not executed:** M10 (reasoned from the resolution order), M14 and M15
  (need the component), and every C-case (the component does not exist). The
  reference was not typechecked (`tsc`), only run — strip-types is not a
  typecheck (brief rule 1c), so the §3 signatures are a design, not compiled code.
- The predicted test count is arithmetic on the case lists, not a runner's line.
- The operator-list memo in `BoardPage.tsx` was located by its comment ("THE
  ASSIGNABLE POOL, CUT TO THE CHOSEN PLANT") and not read to its end; §6 tells you
  to quote it for that reason.
- `formatDayLabel`'s exact output for the fixture day depends on the org's date
  format; C2 asserts through the function, not a literal, for that reason.
- The reference implementation is deliberately NOT shipped with this brief:
  writing yours from the tables is how the tables get a second, independent
  reading.
