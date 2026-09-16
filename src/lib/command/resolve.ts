/**
 * P1-7a — the typed command bar, half two: the FORM's words become RECORDS.
 *
 * ⚠️ THIS MODULE IMPORTS ONLY TYPES FROM `./parse.ts`. Every rule it needs
 * from the board is PASSED IN through `ResolveContext` by `BoardPage` — the
 * product scope (`offeredAt`, the same `productsOfferedAtNode` the pop-up's
 * list is built with), the run-containment rule (`fitsRun`, the same
 * `assignmentFitsRun` a drag uses), the run-overlap rule (`findRunOverlap`,
 * the same one a drag uses when dropping a run onto a cell), the plant-local
 * day axis (`days`, `todayIndex`, `wallToOffset`, all from `index.dayAxis`)
 * and the minimum duration. This module holds NO copy of any of them, so the
 * bar and the pop-up cannot disagree (CLAUDE.md §4: whatever a client offers
 * is decided by the same test the server runs).
 *
 * Never guesses: two candidates is a question, not a coin toss (R-379).
 *
 * S41-a (docs/agent-briefs/s41-a-book-a-job-brief.md) adds `resolveCommand`'s
 * second intent, `book` — a JOB (a run of a part on a cell for a span), never
 * a person. `resolveCommand` dispatches on `command.intent`; the assign path
 * (`resolveAssignCommand`) is unchanged in meaning. The cell step, the part
 * step, and the day-and-span step are shared by both intents through private
 * helpers (`resolveCellStep`, `resolvePartStep`, `resolveDaySpanStep`).
 */
import type {
  Adjust,
  AssignCommand,
  BookCommand,
  ClockTime,
  Command,
  CopyCommand,
  DayWord,
  HeadcountCommand,
  MoveCommand,
  ReplaceCommand,
  SeveralCommand,
  SingleCommand,
  SplitCommand,
  SwapCommand,
  UnassignCommand,
} from "./parse.ts";

/** One day of the board's window, as the plant's calendar sees it. Built by
 *  `BoardPage` from `index.dayAxis.dayStarts` + `partsInZone(_, index.zone)`. */
export interface BoardDay {
  /** 0-based position in the window. */
  index: number;
  /** "2026-09-03" in the PLANT'S zone. */
  iso: string;
  /** 0 = Sunday … 6 = Saturday, of `iso`. */
  weekday: 0 | 1 | 2 | 3 | 4 | 5 | 6;
}

/** A block the board is showing, in the pop-up's own minute coordinates (R-385). */
export interface ContextAssignment {
  id: string;
  nodeId: string;
  /** null for a departed person (D110) — such a block never matches. */
  operatorId: string | null;
  /** The block's EFFECTIVE part: its own `productId` for a direct block, its run's
   *  product for a run-attached block; null when neither is known (deleted product,
   *  D110) — such a block never matches. */
  productId: string | null;
  startMin: number;
  endMin: number;
  /** "10:00–14:00" in the plant's zone — the same `formatClock` pair the run label
   *  uses, without the name (the question sentence supplies person, part and cell). */
  label: string;
  /** S41-b: the effective part's NAME (its own product for a direct block,
   *  its run's product for a run-attached one — the same lookup that builds
   *  `productId` above, one step further, in `commandAssignments`). null
   *  when the id itself is null or the product is unknown. */
  productName: string | null;
  /** S55 (D130 item 1): the run this block is attached to, null for a direct
   *  block — `expandCommand`'s `replace`/`swap` read this to write the new
   *  assign's own `attach` (`{ kind: "run", runId }` or `{ kind: "direct" }`)
   *  without re-deriving it from `fitsRun`. */
  runId: string | null;
}

/** A run the board is showing, in the pop-up's own minute coordinates. */
export interface ContextRun {
  id: string;
  nodeId: string;
  /** null once the product has been deleted (D110) — such a run never matches. */
  productId: string | null;
  startMin: number;
  endMin: number;
  /** The D66 label a drag's confirm prompt uses: "<product name> <start>–<end>". */
  label: string;
  /** S41-a: "08:00–16:00" — the same two `formatClock` calls `label` is built
   *  from, without the product name (the `job_exists` sentence already names
   *  the product, so the run's own label would repeat it). */
  span: string;
  /** S55 (D130 item 4): the run's own product NAME -- `expandCommand`'s
   *  `copy` writes a `book` command with this as its `product` words. null
   *  only when the product itself has been deleted (D110), same as
   *  `ContextAssignment.productName`'s own null. */
  productName: string | null;
  /** S55: the run's headcount, carried straight onto a copied `book`
   *  command's own `headcount` field. null when the run was never given one. */
  headcount: number | null;
}

/** What the resolver is allowed to know. Built by `BoardPage` beside `offeredProducts`. */
export interface ResolveContext {
  /** Track rows only (`row.isTrack`), in board order. */
  cells: ReadonlyArray<{ id: string; name: string; path: string }>;
  /** Every node the index knows, for walking a cell's ancestors by name. */
  nodeById: ReadonlyMap<string, { id: string; name: string; path: string }>;
  /** THE SAME VARIABLE the create pop-up receives as `operators` (`operatorPool`,
   *  R-342 / `pickerPool.test.ts`). The resolver matches ACTIVE people only —
   *  the pop-up's `here` and `elsewhere` lists both filter on `active` first. */
  operators: ReadonlyArray<{
    id: string;
    displayName: string;
    employeeRef: string | null;
    active: boolean;
  }>;
  /** Active parts, NOT yet narrowed to a cell. */
  products: ReadonlyArray<{ id: string; sku: string; name: string }>;
  /** The board's own scope rule, passed in: `BoardPage` hands
   *  `(nodeId) => productsOfferedAtNode(activeProducts, nodeId)`. */
  offeredAt: (nodeId: string) => ReadonlyArray<{ id: string }>;
  /** The window's days, index order, length = dayCount. */
  days: ReadonlyArray<BoardDay>;
  /** The day `now` falls on in the plant's zone, or null when today is not on the board. */
  todayIndex: number | null;
  /** D88a/D88b: real minutes from the window's origin to wall-clock `minuteOfDay`
   *  on day `dayIndex` — `index.dayAxis.wallToOffset`. On a DST changeover day
   *  this is NOT `dayIndex * 1440 + minuteOfDay`; never do that arithmetic here. */
  wallToOffset: (dayIndex: number, minuteOfDay: number) => number;
  /** Every run in the window (`index.runsByNode`, flattened, board order). */
  runs: ReadonlyArray<ContextRun>;
  /** D66 containment, passed in (`assignmentFitsRun` from `lib/interaction.ts`). */
  fitsRun: (
    a: { startMin: number; endMin: number },
    run: { startMin: number; endMin: number },
  ) => boolean;
  /** `MIN_DURATION_MINUTES` (D31), passed in, never retyped. */
  minDurationMinutes: number;
  /** R-385: every block in the window (`commandAssignments(index)`), board order. */
  assignments: ReadonlyArray<ContextAssignment>;
  /** R-385: half-open overlap, passed in (`rangesOverlap` from `lib/interaction.ts`). */
  overlaps: (
    a: { startMin: number; endMin: number },
    b: { startMin: number; endMin: number },
  ) => boolean;
  /** S41-a: a cell runs one job at a time — the SAME `findRunOverlap` a run
   *  drag/resize refuses a drop with, passed in from `lib/interaction.ts`.
   *  `excludeRunId` lets a re-time check against every OTHER job on the cell. */
  findRunOverlap: (
    range: { startMin: number; endMin: number },
    runs: ContextRun[],
    excludeRunId: string | null,
  ) => ContextRun | null;
  /** S52-b (R-402): the bands of the shift pattern that applies to `nodeId`,
   *  in the pattern's own order, empty when the node resolves no pattern --
   *  `BoardPage` builds this from `index.templateForNode`, the SAME
   *  nearest-ancestor map `shiftChipsFor` reads for the pop-up's own shift
   *  chips (no ancestry walk of this module's own, CLAUDE.md §4). Minutes
   *  are the pattern's own (a day's 0..1440, an overnight band's end past
   *  1440) -- never window-relative. */
  shiftsAt: (nodeId: string) => { name: string; startMin: number; endMin: number }[];
  /** S55 (D130 item 3): minutes since midnight, plant zone, on the day
   *  `todayIndex` names; null when today is off the board (or the caller has
   *  no clock at all). Fed by `BoardPage`, read only where "now" decides a
   *  boundary's missing start (`ALL_DAY`/`END_OF_SHIFT`/`END_OF_DAY`, R-404)
   *  -- never anywhere else in this module. */
  nowMinuteOfDay: number | null;
  /** S55 (D130 item 4): the inverse of `wallToOffset` for a window offset --
   *  which day, and the wall-clock minute of that day. A plain `wallOf` for a
   *  non-DST window is `{ dayIndex: floor(m/1440), minuteOfDay: m % 1440 }`;
   *  a real one (`index.dayAxis`'s own) answers correctly across a DST
   *  changeover the same way `wallToOffset` already does the other
   *  direction. `expandCommand` uses this to read a run's or a block's own
   *  wall-clock hours back off its real-minute `startMin`/`endMin` when
   *  copying them onto another day. */
  wallOf: (offsetMin: number) => { dayIndex: number; minuteOfDay: number };
}

/**
 * The first two members are structurally identical to `AssignmentTarget` in
 * `src/lib/api/mutations.ts` (declared again here so this module keeps its
 * no-import rule; `tsc` in `BoardPage` proves the narrowing before
 * `openCreateFromCommand`, which only ever receives an `AssignmentTarget`).
 */
export type CommandTarget =
  | { kind: "run"; runId: string }
  | { kind: "direct"; productId: string }
  /** R-385: not a create at all — re-time this existing block to `range`. */
  | { kind: "retime"; assignmentId: string };

export interface ResolvedCommand {
  intent: "assign";
  nodeId: string;
  operatorId: string;
  productId: string;
  target: CommandTarget;
  /** Real minutes from the window's origin — the pop-up's own `Range`. */
  range: { startMin: number; endMin: number };
  /** "Sam Patel → Housing A · Plant 1 › Assembly › Line 1 › Cell 1 · 2026-09-03 · 10:00–14:00"
   *  (+ " · joining <run label>" for a run target). The ISO day is a token the bar
   *  re-renders through `formatDayLabel(_, dateFormat, zone)`. */
  readout: string;
}

/** S41-a: a "book a job" sentence resolves to either a brand-new job (never
 *  written by this module — `CreatePopover`'s run mode writes it) or a
 *  re-time of an existing one (the drag's own `retimeRun`, R-387). */
export type BookTarget =
  | { kind: "run_create"; productId: string; headcount: number | null }
  | { kind: "retime_run"; runId: string };

export interface ResolvedBook {
  intent: "book";
  nodeId: string;
  productId: string;
  target: BookTarget;
  range: { startMin: number; endMin: number };
  /** "Housing A · Plant 1 › Assembly › Line 1 › Cell 1 · 2026-09-03 · 06:00–14:00 · 3 people"
   *  (+ " · changing <run label>" for a retime; the " · N people" part only
   *  when the sentence said a number). */
  readout: string;
}

/**
 * S41-b (docs/agent-briefs/s41-b-unassign-brief.md §3): "Unassign Sam from
 * Cell 1 in Line 1 from 10 to 2" resolves to the ONE existing block it names
 * -- never a create, never written by this module. The pressed button's
 * answer is `assignmentId`; the caller removes it through the SAME
 * `dragApi.removeAssignment` the block's own Delete button calls.
 */
export interface ResolvedUnassign {
  intent: "unassign";
  assignmentId: string;
  /** "Removing Sam Patel's Housing A block · Plant 1 › Assembly › Line 1 ›
   *  Cell 1 · 2026-09-03 · 10:00–14:00" */
  readout: string;
}

/**
 * S41-c (docs/agent-briefs/s41-c-move-brief.md §4): "Move Sam on Cell 1 to
 * Cell 2 in Line 1" resolves to the ONE existing block it names, moved to
 * `nodeId` (the TARGET -- the source cell for a `retime`, the new cell for a
 * `move_cell`) over `range`. Never written by this module: the caller sends
 * `moveAssignment` (a `move_cell` target) or re-times through the SAME path
 * R-385's own retime uses (a `retime` target -- no second door for the
 * move-in-time half).
 */
export interface ResolvedMove {
  intent: "move";
  assignmentId: string;
  /** The TARGET node: unchanged for a `retime`, the new cell for `move_cell`. */
  nodeId: string;
  operatorId: string;
  /** The block's EFFECTIVE part today (its own, or its run's). */
  productId: string;
  range: { startMin: number; endMin: number };
  target: { kind: "retime" } | { kind: "move_cell" };
  /** "Moving Sam Patel's Housing A block · Plant 1 › Assembly › Line 1 ›
   *  Cell 1 · 2026-09-03 · 10:00–14:00 → Cell 2 · 10:00–14:00" (the arrow
   *  names what changes: the cell, the hours, or both). */
  readout: string;
}

export type Candidate = {
  id: string;
  label: string;
  /** What to put in the sentence when this button is pressed ("" for a run: the
   *  answer goes into `attach`, not the sentence). */
  word: string;
  /** S41-b: the block's effective part NAME, `null` when unknown -- ONLY set
   *  by the unassign path's `remove_which` candidates, so the one-block
   *  message doesn't have to recover it by parsing `label` back apart.
   *  Every other question leaves this undefined. */
  part?: string | null;
  /** S49: the candidate's OWN cell name and bare hours ("10:00–14:00", the
   *  block's own `label`) -- set ONLY on a candidate built from the
   *  "elsewhere" gathering (a `remove_which`/`move_which` whose hits on the
   *  named cell came up empty, or whose sentence named no cell at all), so
   *  `describeQuestion` never parses `label` ("<cell> · <part> <hours>")
   *  back apart. Every other candidate leaves these undefined. */
  cell?: string;
  when?: string;
};

export type Question =
  | {
      kind: "ambiguous";
      field: "operator" | "product" | "place" | "shift";
      text: string;
      candidates: Candidate[];
    }
  /** D133 item 1: up to four names close enough to `text` to offer as
   *  buttons -- absent (never an empty array) when nothing clears the floor,
   *  so a caller with no suggestions is byte-identical to before this field
   *  existed. Each candidate's `word` is the name itself; picking one
   *  substitutes it into the field named here and re-runs, the same way an
   *  `ambiguous` pick already does.
   *
   *  S60-b (R-422): for `field: "product"` ONLY, `suggestions` may instead be
   *  the parts the resolved CELL actually offers (`ctx.offeredAt`, board
   *  order, at most eight) -- when the sentence named no product at all
   *  (`text` then carries the CELL's own name, the one thing this question
   *  is about, never the empty string) or named one that matched nothing AND
   *  had no near name either (R-418's own floor; `text` stays the word said).
   *  `more: true` flags a cell offering more than eight -- the bar appends
   *  "and more" rather than dropping the rest silently. See
   *  `resolvePartStep`'s own comment for why a near name and the cell's menu
   *  are never merged into one list.
   *
   *  Reviewer fix (S60-b review, R-422): a single-segment sentence
   *  ("assign Sam to Housing A 8 to 4", no separator) reads its one segment
   *  as the PLACE (`parse.ts`'s own R-422 branch), `product: ""` -- but
   *  nothing stops that segment from actually NAMING a part instead ("Housing
   *  A" a product, not a cell). `asPart: true` on a `field: "place"` question
   *  flags exactly that: `resolveCellStep` found no cell for the word AND the
   *  word matches a part (`matchName`'s own tiers, or a near name past
   *  R-418's floor) -- `suggestions` then carries every track cell
   *  (`ctx.cells`, board order) instead of a place near-miss, capped at eight;
   *  past eight, `suggestions` is omitted entirely (unlike the product menu's
   *  own `more` flag, there is no meaningful partial list of every cell on
   *  the board to lead with) and the bar says "say the cell" instead. A
   *  person who named the part gets told the part was heard, never sent
   *  place suggestions for a word they never meant as a place. */
  | {
      kind: "unknown";
      field: "operator" | "product" | "place";
      text: string;
      suggestions?: Candidate[];
      more?: true;
      asPart?: true;
    }
  | { kind: "not_offered"; product: string; cell: string }
  | { kind: "place_mismatch"; cell: string; qualifier: string; elsewhere: Candidate[] }
  | { kind: "day_off_board"; text: string }
  | { kind: "too_short"; minutes: number; min: number }
  /** R-383: the span sits inside one or more jobs for this part on this cell,
   *  and `command.attach` is still null. `runs` are the candidates, board order. */
  | { kind: "run_exists"; product: string; cell: string; runs: Candidate[] }
  /** R-385: the person already has one or more blocks for this part on this cell whose
   *  hours overlap the sentence's, and `command.existing` is still null. `blocks` are
   *  the candidates, board order; `span` is the sentence's "HH:MM–HH:MM"; `same` is
   *  true when there is exactly one block and its hours equal the sentence's. */
  | {
      kind: "block_exists";
      person: string;
      product: string;
      cell: string;
      span: string;
      blocks: Candidate[];
      same: boolean;
    }
  /** R-385: `command.existing` names a block that is no longer among the hits and no
   *  other block of this person's overlaps — the board changed under the question. */
  | { kind: "block_gone"; person: string; product: string; cell: string }
  /** S41-a / R-387: a job of the SAME part already overlaps the sentence's
   *  hours on that cell. `run` is that job (`word` is always "" — the answer
   *  goes into `existing`, not the sentence); `same` is true when its hours
   *  already equal the sentence's. */
  | {
      kind: "job_exists";
      product: string;
      cell: string;
      span: string;
      run: Candidate;
      same: boolean;
    }
  /** S41-a: a job of ANOTHER part overlaps — a cell runs one job at a time;
   *  nothing to offer but the sentence's own words. */
  | { kind: "job_in_the_way"; product: string; cell: string; other: string }
  /** S41-a: `command.existing` names a job that is no longer on this cell and
   *  no other job overlaps — the board changed under the question. */
  | { kind: "job_gone"; product: string; cell: string }
  /** S41-b / R-388: the blocks the sentence names, each a button; `same` is
   *  irrelevant here (a removal, never a re-time). S49: `cell` is `null`
   *  when the sentence named no place at all ("wherever they are");
   *  `elsewhere` is set ONLY when a cell WAS named and it had none of the
   *  person's blocks -- `blocks` are then gathered from every other cell,
   *  each candidate carrying its own `cell`/`when` (R-397). */
  | {
      kind: "remove_which";
      person: string;
      cell: string | null;
      when: string;
      blocks: Candidate[];
      elsewhere?: true;
    }
  /** S41-b: no block of this person's on this cell (for the sentence's
   *  hours, or the whole day when it gave none) — nothing to remove. S49:
   *  `cell` is `null` when the sentence named no place at all. */
  | { kind: "no_block"; person: string; cell: string | null; when: string }
  /** S41-b: `command.existing` names a block that is no longer among the
   *  hits and no other block overlaps — the board changed under the
   *  question. S49: `cell` is `null` when the sentence named no place. */
  | { kind: "block_gone_remove"; person: string; cell: string | null }
  /** S41-c / R-389: more than one block matches the move sentence's person,
   *  cell and day, and `command.existing` is still null -- each a button,
   *  in `remove_which`'s shape (a removal asks even for one; a move never
   *  does -- exactly one hit is taken without asking, UNLESS the block is
   *  elsewhere: S49, a move whose named cell was wrong asks even for one).
   *  `cell`, `elsewhere` as `remove_which`'s; `destination` is set ONLY in
   *  the elsewhere case -- the sentence's own words for where the move would
   *  land, built without resolving the destination cell (R-397). */
  | {
      kind: "move_which";
      person: string;
      cell: string | null;
      when: string;
      blocks: Candidate[];
      elsewhere?: true;
      destination?: string;
    }
  /** S50 (brief §2 item 4, R-398): the sentence parsed as a `several` --
   *  more than one operator or place segment in one sentence. Resolving and
   *  confirming each inner command is its own later stage; for now the bar
   *  only says so. `count` is `command.commands.length`. */
  | { kind: "several_unsupported"; count: number }
  /** S52-b (R-402): the named cell resolves no shift pattern at all -- there
   *  is nothing for the shift's name to mean, so the sentence must give
   *  hours instead. */
  | { kind: "no_shift_pattern"; cell: string }
  /** S52-b (R-402): the sentence's shift name matched none of the cell's own
   *  pattern's bands. `shifts` is every band's name, pattern order, for the
   *  message to list. */
  | { kind: "no_shift"; text: string; cell: string; shifts: string[] }
  /** S55 (R-404, D130 item 3): `END_OF_SHIFT` with a start that falls inside
   *  no band and after no band's own start either -- there is nothing for
   *  "the end of the shift" to mean. `time` is the start, "HH:MM". */
  | { kind: "no_shift_at"; cell: string; time: string }
  /** S55 (R-404, D130 item 3): an assign or a booking said `END_OF_SHIFT`/
   *  `END_OF_DAY` with no start, on a day that is not today (or today with
   *  no clock, `nowMinuteOfDay` null) -- there is no "now" to round up, and
   *  those two grammars need a start of their own. */
  | { kind: "no_start"; text: string }
  /** S55 (R-406/R-407/R-408, D130 item 5): `expandCommand` would write more
   *  than `max` commands -- counted before building, never truncated. */
  | { kind: "lot_too_big"; count: number; max: number }
  /** S55 (D130 items 1/4): a plain answer, not an error -- the sentence's
   *  board-answered shape found nothing to do ("Cell 1 has nobody on it
   *  2026-09-03.", "Sam has no block from 2026-09-14 to 2026-09-18.", "Cell 1
   *  already matches yesterday."). */
  | { kind: "nothing_to_do"; text: string }
  /** S55 (R-407, D130 item 5): an `everyone` removal's span falls strictly
   *  inside a block on BOTH edges -- a split the app does not have. Nothing
   *  is built; the person is asked for a span that reaches one end instead.
   *  `span` is the WINDOW the sentence itself named (true only when that
   *  window sits inside a single day, e.g. "clear ... from 8 to 12" over a
   *  same-day block) -- never used when the reason is the block itself
   *  crossing a day boundary; that reason is `across_midnight` below. */
  | { kind: "split_needed"; person: string; cell: string; block: string; span: string }
  /** F-152 review follow-up (the maintainer, 16 Sept): a block that itself
   *  cannot be written as one day's clock pair (a leftover, or a night
   *  shift's own band) AND matches no shift band exactly -- `expandReplace`,
   *  `expandSwap`, and `expandEveryoneUnassign`'s both-edges-outside branch
   *  all reach this for the SAME reason (never the sentence's own span
   *  crossing a same-day block -- that stays `split_needed`, above).
   *  `hours` is the block's OWN real span, start clock to end clock with
   *  the day boundary implied (`formatSpan` of `clockOfOffset` on the
   *  block's real minutes, the same rendering `expandSplit`'s own
   *  `split_needed` already uses) -- never the window's bounds, which for
   *  a whole-day window is the untrue, unanswerable "00:00-00:00". */
  | { kind: "across_midnight"; person: string; cell: string; block: string; hours: string }
  /** S55 (R-406): a `swap` found more than one block for `person` in the
   *  window -- `blocks` are that person's own, "<part> <hours>" strings, for
   *  the message to list (never a button list -- a swap is four commands at
   *  once, not a single pick). */
  | { kind: "swap_which"; person: string; when: string; blocks: string[] }
  /** S55 (R-409): an absence's `until` names a day before `day` itself, or
   *  (defensively) a `copy`'s resolved `to` before its `from` -- never a
   *  guess which end was meant. `first`/`second` are the two ISO dates, in
   *  the order the sentence said them. */
  | { kind: "day_order"; first: string; second: string }
  /** S55 (D130 item 1): a `BoardCommand` (`replace`/`swap`/`copy`) reached
   *  `resolveCommand` without first going through `expandCommand` -- a
   *  caller's bug, never a crash, the same role `several_unsupported` plays
   *  for an un-run `several`. */
  | { kind: "expand_first"; intent: string }
  /** S58 (R-412, D132 item 1): an adjust's new end would fall at or before
   *  its new start -- "shorten Sam's block by 6 hours" on a 4-hour block. */
  | { kind: "adjust_inverts"; person: string; block: string }
  /** S58 (R-412): an adjust's new range would reach past the block's own
   *  day's midnight in either direction -- an adjust never carries the
   *  block onto another day. */
  | { kind: "adjust_off_day"; person: string; block: string }
  /** S58 (R-412): `command.adjust` set alongside `toPlace`/`span`/`shift` --
   *  a contradiction the grammar never produces (parse.ts's own `bad_adjust`
   *  ParseFailure catches it first); a caller's bug, never a crash, the same
   *  role `expand_first` plays for an unexpanded board command. `text` is
   *  the full one-line message. */
  | { kind: "bad_adjust"; text: string }
  /** S58 (R-413, D132 item 2): a split's `at` falls inside none of the
   *  person's blocks that day -- `blocks` are those blocks' own "<part>
   *  <hours>" strings, for the message to list (a split is never a button
   *  pick -- it writes two commands at once, `swap_which`'s own shape). */
  | { kind: "split_outside"; person: string; at: string; blocks: string[] }
  /** S58 (R-414/R-415, D132 items 3/4): "the job's hours" (an assign) or a
   *  headcount sentence named a part/cell/window with no job on it at all. */
  | { kind: "no_job"; product: string; cell: string; when: string }
  /** S58 (R-414/R-415, D132 items 3/4): more than one job of that part
   *  overlaps the window -- `runs` are their own "HH:MM–HH:MM" spans, for
   *  the message to list (never a button pick -- the sentence named no
   *  single time to choose by). */
  | { kind: "which_job"; product: string; cell: string; runs: string[] }
  /** S58 (R-416, D132 item 5): a `weekdays`/`every_day` repeat day reached
   *  `resolveDay` on an intent other than assign/book -- the grammar never
   *  produces one there (parse.ts's own `bad_day` ParseFailure catches it
   *  first); a caller's bug, never a crash. `text` is the day word's own
   *  plain-language name (`dayWordLabel`). */
  | { kind: "bad_repeat_day"; text: string };

export interface ResolvedHeadcount {
  intent: "headcount";
  runId: string;
  nodeId: string;
  headcount: number;
  /** "Housing A · Plant 1 › Assembly › Line 1 › Cell 1 · 2026-09-03 ·
   *  08:00–16:00 · 4 people" */
  readout: string;
}

export type Resolution =
  | {
      ok: true;
      resolved:
        ResolvedCommand | ResolvedBook | ResolvedUnassign | ResolvedMove | ResolvedHeadcount;
    }
  | { ok: false; question: Question };

// ---------------------------------------------------------------------------
// Private helpers. None of these are exported; nothing here is a copy of a
// board rule — they are string/shape plumbing only (matching tiers, ancestor
// walks, label building). The rules themselves (offeredAt, fitsRun,
// findRunOverlap, the day axis, the minimum duration) all come from
// ResolveContext.
// ---------------------------------------------------------------------------

/**
 * S55 (R-404/R-407, D130 item 3): mirrors parse.ts's own `BOUNDARY_SHIFTS`,
 * `EVERYONE` and `DAY_END` spellings exactly, word for word -- this module
 * imports only TYPES from `parse.ts` (its own header comment, "no second
 * door" for a value would still be an import), so a literal duplicate is the
 * price of that rule, same as this file's shift-band matching already
 * duplicates no LOGIC of parse.ts's, only spelling. A change to any of
 * parse.ts's own constants must be mirrored here.
 */
const ALL_DAY = "all day";
const END_OF_SHIFT = "end of shift";
const END_OF_DAY = "end of day";
/** S58 (R-414, D132 item 3): parse.ts's own fourth `BOUNDARY_SHIFTS` member,
 *  mirrored the same way -- but its resolution mechanism is NOT a band
 *  lookup like the other three (it finds an existing RUN), so it is never
 *  added to `boundaryKind`'s own set; `isJobHours` is its own check, tried
 *  only where the caller also has a `product` to search runs with
 *  (`resolveShiftSpanStep`'s own `jobProduct` parameter, the assign path
 *  only). Every other caller never passes one, so "the job" falls through
 *  to the ordinary band-matching below and refuses `no_shift`, naming it --
 *  the "no_shift-class refusal" the brief asks for, for free. */
const JOB_HOURS = "the job";
const EVERYONE = "everyone";
/** parse.ts's `DAY_END` ClockTime, `{ hour: 23, minute: 59 }` -- the one
 *  value that type can hold for "the day's end" (R-404). */
const DAY_END_HOUR = 23;
const DAY_END_MINUTE = 59;

/** S55 (R-410): `expandCommand` never writes more than this many commands --
 *  counted before building, never truncated (`lot_too_big`). */
const LOT_CEILING = 100;

type Node = { id: string; name: string; path: string };
type ProductLike = ResolveContext["products"][number];

/** S60-b (R-422 brief §5; the S59 reviewer, 15 Sept): a recogniser writes
 *  "Cell one"/"shift two" for "Cell 1"/"shift 2" -- every spelled-out number
 *  word one through twenty, STANDALONE, becomes its digit. `\b`-anchored on
 *  both sides so a spelled digit that is merely part of a longer word ("one"
 *  inside "Stone Cell") is never touched -- NW3. */
const NUMBER_WORDS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
};
const NUMBER_WORD_RE = new RegExp(`\\b(${Object.keys(NUMBER_WORDS).join("|")})\\b`, "g");

/** S60-b: the spelled-digit substitution itself -- a standalone word only
 *  (`NUMBER_WORD_RE`'s own `\b` anchors), never a digit run inside a longer
 *  word. Note the space a multi-word name keeps around the substituted
 *  digit is NOT collapsed away by this step or by `normalizeForMatch`'s own
 *  whitespace pass below (that pass only collapses RUNS of whitespace down
 *  to one space, it never deletes a single space) -- "Operator A three"
 *  normalises to "operator a 3", one space short of "Operator A3"'s own
 *  "operator a3", so the two are never an EXACT tier hit; `closenessScore`'s
 *  digit-equality check still lets the near-name floor (D133 item 2) offer
 *  "Operator A3" as a suggestion instead (NW2) -- never a silent guess. */
function spellDigitsToNumerals(s: string): string {
  return s.replace(NUMBER_WORD_RE, (word) => String(NUMBER_WORDS[word]));
}

function normalizeForMatch(s: string): string {
  return spellDigitsToNumerals(s.toLowerCase().replace(/\s+/g, " ").trim())
    .replace(/[^a-z0-9 /-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The three tiers themselves -- exact, then starts-with, then contains;
 *  first tier with ANY hit wins; never the "best" of several. Shared by
 *  `matchName`'s own word and (D133 item 1) its plural variants. */
function matchTiers<T>(w: string, withKeys: ReadonlyArray<{ it: T; key: string }>): T[] {
  const exact = withKeys.filter((x) => x.key === w).map((x) => x.it);
  if (exact.length > 0) return exact;
  const starts = withKeys.filter((x) => x.key.startsWith(w)).map((x) => x.it);
  if (starts.length > 0) return starts;
  return withKeys.filter((x) => x.key.includes(w)).map((x) => x.it);
}

/** The one matching function (brief §5): exact, then starts-with, then
 *  contains; first tier with ANY hit wins; never the "best" of several.
 *
 * D133 item 1: when all three come up empty, tries again with ONE trailing
 * "s"/"es" removed from the word (a plural word, a singular item -- "Common
 * Fasteners" finds "Common Fastener"), then with an "s" added (kept for the
 * reverse shape, since a starts-with match already catches most singular-
 * word/plural-item pairs on its own) -- each through the same three tiers,
 * first non-empty wins. A word already found by the plain three tiers (e.g.
 * "Bracket" against "Bracket A"/"Bracket B", a starts-with) never reaches
 * this -- the plural passes are a fallback, not a fourth ordinary tier. */
function matchName<T>(word: string, items: readonly T[], keyOf: (t: T) => string): T[] {
  const w = normalizeForMatch(word);
  if (w === "") return [];
  const withKeys = items.map((it) => ({ it, key: normalizeForMatch(keyOf(it)) }));
  const base = matchTiers(w, withKeys);
  if (base.length > 0) return base;
  let stripped: string | null = null;
  if (w.endsWith("es")) stripped = w.slice(0, -2);
  else if (w.endsWith("s")) stripped = w.slice(0, -1);
  if (stripped !== null && stripped.length > 0) {
    const strippedHits = matchTiers(stripped, withKeys);
    if (strippedHits.length > 0) return strippedHits;
  }
  return matchTiers(`${w}s`, withKeys);
}

/** D133 item 2: below this Dice-plus-prefix score (`closenessScore` below),
 *  `nearestNames` offers nothing -- "Housing Pay" against "Housing A" scores
 *  ~0.93 (14 of their 18 combined bigrams shared, plus the shared-prefix
 *  bonus for "housing ") and clears it easily; "xyzzy" scores 0 against
 *  every fixture name (no letter pair in "xyzzy" appears in any of them) and
 *  does not. */
const NEAREST_FLOOR = 0.35;

/** D133 item 2: a shared normalised prefix this long or longer adds this
 *  much to the Dice score -- named for the rule it rewards ("Operator" and
 *  "Opertor" already clear the floor on bigrams alone; the bonus is what
 *  lets a short, heavily-prefixed word like a two-letter cell qualifier
 *  clear it too). Ties among a fixture's own "Housing A"/"Housing B"/
 *  "Housing C" -- which all share the whole "housing " prefix with a probe
 *  word -- are unaffected: the bonus is the same for all three, so the
 *  stable sort below still returns them in the fixture's own order. */
const PREFIX_BONUS = 0.15;
const PREFIX_MIN_LENGTH = 3;

/** Every two-letter (Unicode code point) slice of `s`, in order -- the unit
 *  `diceCoefficient` compares. */
function bigramsOf(s: string): string[] {
  const chars = Array.from(s);
  const out: string[] = [];
  for (let i = 0; i < chars.length - 1; i++) out.push(chars[i] + chars[i + 1]);
  return out;
}

/** Dice coefficient over letter bigrams: twice the bigrams the two strings
 *  share (as a multiset -- each bigram of `a` claimed by at most one bigram
 *  of `b`), over their combined bigram count. 1 for identical strings, 0 for
 *  two that share no bigram at all (including when either is under two
 *  characters, so has none of its own). */
function diceCoefficient(a: string, b: string): number {
  if (a === b) return 1;
  const bigramsA = bigramsOf(a);
  const bigramsB = bigramsOf(b);
  if (bigramsA.length === 0 || bigramsB.length === 0) return 0;
  const remaining = new Map<string, number>();
  for (const g of bigramsA) remaining.set(g, (remaining.get(g) ?? 0) + 1);
  let shared = 0;
  for (const g of bigramsB) {
    const left = remaining.get(g) ?? 0;
    if (left > 0) {
      shared++;
      remaining.set(g, left - 1);
    }
  }
  return (2 * shared) / (bigramsA.length + bigramsB.length);
}

function sharedPrefixLength(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/** Every digit in `s`, in order, other characters dropped -- "cell 9" -> "9". */
function digitsOf(s: string): string {
  return s.replace(/[^0-9]/g, "");
}

/** D133 item 2: the closeness score `nearestNames` ranks by -- explainable
 *  in one sentence: a Dice coefficient over letter bigrams of the two
 *  (already-normalised) strings, plus `PREFIX_BONUS` when they share a
 *  normalised prefix of `PREFIX_MIN_LENGTH` letters or more -- EXCEPT that
 *  two strings that both carry digits score 0 outright when those digits
 *  differ ("Cell 9" against "Cell 1"/"Cell 2", R22/R23's own fixture: a cell
 *  NUMBER is an identifier, not a spelling, so sharing every letter around
 *  it is never a reason to guess at a DIFFERENT one -- only a misheard WORD
 *  ("Sell 1" for "Cell 1", "Housing Pay" for "Housing A") is offered; a word
 *  with no digit at all (either side) skips this check, so it never keeps a
 *  plain word ("Housing Pay") from matching a plain word ("Housing A"). */
function closenessScore(a: string, b: string): number {
  const digitsA = digitsOf(a);
  const digitsB = digitsOf(b);
  if (digitsA !== "" && digitsB !== "" && digitsA !== digitsB) return 0;
  let score = diceCoefficient(a, b);
  if (sharedPrefixLength(a, b) >= PREFIX_MIN_LENGTH) score += PREFIX_BONUS;
  return score;
}

/** D133 item 2: a pure `nearestNames(word, names): string[]` -- up to four
 *  of `names` scoring at or above `NEAREST_FLOOR` against `word`
 *  (`closenessScore`), highest first; ties keep `names`' own relative order
 *  (a stable sort), so a fixture listing "Housing A", "Housing B",
 *  "Housing C" -- which tie exactly against "Housing Pay", only their last
 *  letter unshared with "pay" either way -- comes back in that same order.
 *  A name repeated in `names` (two cells sharing one name, on different
 *  lines) is offered once. No `ResolveContext`, no ids: the three lookup
 *  steps below turn what this returns into each field's own `Candidate`s. */
function nearestNames(word: string, names: readonly string[]): string[] {
  const w = normalizeForMatch(word);
  if (w === "") return [];
  const scored = names
    .map((name) => ({ name, score: closenessScore(w, normalizeForMatch(name)) }))
    .filter((x) => x.score >= NEAREST_FLOOR);
  scored.sort((x, y) => y.score - x.score);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const { name } of scored) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= 4) break;
  }
  return out;
}

/** D133 item 3: `nearestNames`' output, turned back into `pool`'s own items
 *  (the first item in `pool` whose `keyOf` equals each name -- `nearestNames`
 *  already deduplicated the names themselves) and then into each field's own
 *  `Candidate` shape via `toCandidate`. */
function candidatesForNames<T>(
  names: readonly string[],
  pool: readonly T[],
  keyOf: (t: T) => string,
  toCandidate: (t: T) => Candidate,
): Candidate[] {
  const out: Candidate[] = [];
  for (const name of names) {
    const match = pool.find((t) => keyOf(t) === name);
    if (match !== undefined) out.push(toCandidate(match));
  }
  return out;
}

/** Root-first ancestor path prefixes, EXCLUDING the node's own full path
 *  (brief §5: "copy `ancestorPaths`'s idea ... not its export"). */
function ancestorPrefixes(path: string): string[] {
  const segments = path.split(".");
  const out: string[] = [];
  for (let i = 1; i < segments.length; i++) {
    out.push(segments.slice(0, i).join("."));
  }
  return out;
}

function buildPathIndex(nodeById: ResolveContext["nodeById"]): Map<string, Node> {
  const byPath = new Map<string, Node>();
  for (const n of nodeById.values()) byPath.set(n.path, n);
  return byPath;
}

function ancestorsOf(cell: Node, byPath: Map<string, Node>): Node[] {
  return ancestorPrefixes(cell.path)
    .map((p) => byPath.get(p))
    .filter((n): n is Node => n !== undefined);
}

function placeLabel(cell: Node, byPath: Map<string, Node>): string {
  const names = ancestorsOf(cell, byPath).map((n) => n.name);
  return `${cell.name} — ${names.join(" › ")}`;
}

/** Filters a set of cell candidates by one qualifier word, using the same
 *  three-tier rule as `matchName`, applied to each candidate's ancestor
 *  names as a group (first tier with ANY hit, across all candidates, wins). */
function filterByQualifier(cands: Node[], qualifier: string, byPath: Map<string, Node>): Node[] {
  const w = normalizeForMatch(qualifier);
  const exact: Node[] = [];
  const starts: Node[] = [];
  const contains: Node[] = [];
  for (const c of cands) {
    const names = ancestorsOf(c, byPath).map((n) => normalizeForMatch(n.name));
    if (names.some((n) => n === w)) {
      exact.push(c);
    } else if (names.some((n) => n.startsWith(w))) {
      starts.push(c);
    } else if (names.some((n) => n.includes(w))) {
      contains.push(c);
    }
  }
  if (exact.length > 0) return exact;
  if (starts.length > 0) return starts;
  return contains;
}

/** D133 item 3: suggestions for a place word matched against a specific pool
 *  of nodes -- the SAME pool the caller itself searched on this word (a
 *  suggestion drawn from anywhere else could never re-resolve through that
 *  caller's own step). Each candidate's `label` is the full ancestor path
 *  (`placeLabel`, `ambiguous`'s own place candidates' shape); `word` is the
 *  bare name, substituted into the field named on a pick. */
function nodeSuggestions(
  word: string,
  pool: readonly Node[],
  byPath: Map<string, Node>,
): Candidate[] {
  const names = nearestNames(
    word,
    pool.map((n) => n.name),
  );
  return candidatesForNames(
    names,
    pool,
    (n) => n.name,
    (n) => ({
      id: n.id,
      label: placeLabel(n, byPath),
      word: n.name,
    }),
  );
}

/** D133 item 3: suggestions for a place word `resolveCellStep`'s first pass
 *  matched no cell at all -- track cells' own names (`ctx.cells`, the SAME
 *  pool `resolveCellStep` itself searches on this word -- a suggestion drawn
 *  from anywhere else could never re-resolve through this step, R23's own
 *  "`ctx.cells` empty" fixture pins that: with no cells at all, there is
 *  nothing to suggest, even though other nodes exist). */
function placeSuggestions(
  word: string,
  ctx: ResolveContext,
  byPath: Map<string, Node>,
): Candidate[] {
  return nodeSuggestions(word, ctx.cells as readonly Node[], byPath);
}

/** D133 item 3: suggestions for a product word `resolvePartStep` matched
 *  nowhere (name, SKU, or the "sku/name" and slash-split fallbacks all
 *  empty) -- product names only, `ambiguous`'s own product candidates'
 *  shape (`label`/`word` both the name). Scope is deliberately every active
 *  product, not narrowed to `cell`'s own `offeredAt` -- the person is being
 *  shown what name they might have meant, the same not-yet-scoped pool
 *  `resolvePartStep`'s own three matching tiers already search before its
 *  `offeredAt` check. */
function productSuggestions(word: string, ctx: ResolveContext): Candidate[] {
  const names = nearestNames(
    word,
    ctx.products.map((p) => p.name),
  );
  return candidatesForNames(
    names,
    ctx.products,
    (p) => p.name,
    (p) => ({
      id: p.id,
      label: p.name,
      word: p.name,
    }),
  );
}

/** S60-b (R-422): the resolver's own floor for offering a WHOLE MENU rather
 *  than a near-miss guess -- the count `offeredSuggestions` shows before
 *  flagging `more`. */
const MAX_PRODUCT_MENU_SUGGESTIONS = 8;

/** S60-b (R-422): the parts `cell` actually offers (`ctx.offeredAt`, the
 *  SAME scope check `resolvePartStep`'s own `offered` check below already
 *  runs, board order -- the same order the create pop-up's own product list
 *  is built in), each turned into a `Candidate` the same shape
 *  `productSuggestions` builds (`label`/`word` both the name). Capped at
 *  `MAX_PRODUCT_MENU_SUGGESTIONS`; `more` is true only when the cell offers
 *  more than that many. `ctx.offeredAt` returns bare `{ id }`s (no name), so
 *  each is looked up in `ctx.products`; a dangling id (a deleted product
 *  still on the scope list, D110) is skipped rather than crashing. */
function offeredSuggestions(
  cell: Node,
  ctx: ResolveContext,
): { suggestions: Candidate[]; more: boolean } {
  const offered: ProductLike[] = [];
  for (const o of ctx.offeredAt(cell.id)) {
    const p = ctx.products.find((x) => x.id === o.id);
    if (p !== undefined) offered.push(p);
  }
  const more = offered.length > MAX_PRODUCT_MENU_SUGGESTIONS;
  const shown = more ? offered.slice(0, MAX_PRODUCT_MENU_SUGGESTIONS) : offered;
  return { suggestions: shown.map((p) => ({ id: p.id, label: p.name, word: p.name })), more };
}

/** Reviewer fix (S60-b review, R-422): every track cell on the board
 *  (`ctx.cells`, board order), offered when a single-segment word turns out
 *  to name a part rather than a place -- see the `Question` type's own
 *  `asPart` doc above. Eight or fewer cells: all of them, as buttons (the
 *  same `placeLabel` shape `placeSuggestions`/`nodeSuggestions` already
 *  build). More than eight: `sayOnly: true` and no candidates at all --
 *  unlike `offeredSuggestions`'s own eight-plus-`more` menu, a cell list this
 *  long has no natural lead-with-the-first-eight order worth showing, so the
 *  bar says "say the cell" instead of a partial, arbitrary-feeling list. */
function trackCellSuggestions(
  ctx: ResolveContext,
  byPath: Map<string, Node>,
): { suggestions: Candidate[]; sayOnly: boolean } {
  if (ctx.cells.length > MAX_PRODUCT_MENU_SUGGESTIONS) return { suggestions: [], sayOnly: true };
  return {
    suggestions: (ctx.cells as readonly Node[]).map((c) => ({
      id: c.id,
      label: placeLabel(c, byPath),
      word: c.name,
    })),
    sayOnly: false,
  };
}

/** D133 item 3: suggestions for a person word `resolvePersonStep` matched
 *  nowhere -- display names first (the same pool its own first pass
 *  searches); only when none of those is close enough, active employee refs
 *  (its own second pass' pool). Either way each candidate is built from its
 *  OWN operator, `label`/`word` always the display name -- `ambiguous`'s own
 *  operator candidates never read from `employeeRef` either, only from
 *  which operators matched. */
function operatorSuggestions(word: string, activeOperators: readonly OperatorLike[]): Candidate[] {
  const toCandidate = (o: OperatorLike): Candidate => ({
    id: o.id,
    label: o.displayName,
    word: o.displayName,
  });
  const nameHits = nearestNames(
    word,
    activeOperators.map((o) => o.displayName),
  );
  if (nameHits.length > 0) {
    return candidatesForNames(nameHits, activeOperators, (o) => o.displayName, toCandidate);
  }
  const withRef = activeOperators.filter((o) => o.employeeRef !== null);
  const refHits = nearestNames(
    word,
    withRef.map((o) => o.employeeRef as string),
  );
  return candidatesForNames(refHits, withRef, (o) => o.employeeRef as string, toCandidate);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** The one place "HH:MM–HH:MM" is built from a start/end pair -- used by
 *  `resolveDaySpanStep`'s `timeText` (the arrow) AND (S49) by the elsewhere
 *  destination text, so the two are always the same string for the same
 *  hours. */
function formatSpan(
  start: { hour: number; minute: number },
  end: { hour: number; minute: number },
): string {
  return `${pad2(start.hour)}:${pad2(start.minute)}–${pad2(end.hour)}:${pad2(end.minute)}`;
}

/** S55 (R-404, D130 item 3): a `ClockTime` of `DAY_END` (23:59, parse.ts's
 *  own reserved spelling for "the day's end") reads as MIDNIGHT -- 1440
 *  minutes into the day, one minute later than the literal clock reading --
 *  so "after 2" reaches all the way to the next day's 00:00, never stopping
 *  a minute short. The one helper, used everywhere a `ClockTime` is turned
 *  into a minute-of-day for a span's edge (an ordinary clock time is
 *  unaffected -- the grammar never produces a literal 23:59 any other way). */
function clockToMinuteOfDay(t: { hour: number; minute: number }): number {
  if (t.hour === DAY_END_HOUR && t.minute === DAY_END_MINUTE) return 24 * 60;
  return t.hour * 60 + t.minute;
}

/** "HH:MM" for a single minute-of-day -- `no_shift_at`'s own `time` field,
 *  and the boundary helpers below. */
function formatClockMinuteOfDay(mod: number): string {
  const c = shiftClockOf(mod);
  return `${pad2(c.hour)}:${pad2(c.minute)}`;
}

/** R-404: `m` rounded UP to the next quarter hour (10:07 -> 10:15; 10:15
 *  stays 10:15) -- the boundary's own "now" start when the sentence gave
 *  none and today is on the board. */
function roundUpToQuarterHour(m: number): number {
  const r = m % 15;
  return r === 0 ? m : m + (15 - r);
}

/** S49 (R-397, §19.96/D125): a candidate built from a block NOT on the
 *  sentence's named cell (or, when the sentence named none, from any cell)
 *  -- carries its OWN cell name and bare hours so `describeQuestion` never
 *  parses `label` back apart. */
function elsewhereCandidate(x: ContextAssignment, ctx: ResolveContext): Candidate {
  const cellName = ctx.nodeById.get(x.nodeId)?.name ?? "";
  return {
    id: x.id,
    label: `${cellName} · ${x.productName ?? "block"} ${x.label}`,
    word: "",
    part: x.productName,
    cell: cellName,
    when: x.label,
  };
}

function elsewhereCandidates(list: readonly ContextAssignment[], ctx: ResolveContext): Candidate[] {
  return list.map((x) => elsewhereCandidate(x, ctx));
}

/** S49: the person's blocks overlapping `window` on ANY cell -- gathered
 *  only once the named cell (or "wherever they are" for an empty place) has
 *  come up with nothing, in board order (`ctx.assignments`' own order). */
function gatherElsewhereBlocks(
  operatorId: string,
  window: { startMin: number; endMin: number },
  ctx: ResolveContext,
): ContextAssignment[] {
  return ctx.assignments.filter((x) => x.operatorId === operatorId && ctx.overlaps(window, x));
}

const WEEKDAY_FULL_NAMES: readonly string[] = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

function resolveDay(
  day: AssignCommand["day"],
  ctx: ResolveContext,
): { ok: true; dayIndex: number } | { ok: false; question: Question } {
  if (day === null) {
    return { ok: true, dayIndex: ctx.todayIndex ?? 0 };
  }
  if (day.kind === "today") {
    if (ctx.todayIndex === null)
      return { ok: false, question: { kind: "day_off_board", text: "today" } };
    return { ok: true, dayIndex: ctx.todayIndex };
  }
  if (day.kind === "tomorrow") {
    if (ctx.todayIndex === null) {
      return { ok: false, question: { kind: "day_off_board", text: "tomorrow" } };
    }
    const idx = ctx.todayIndex + 1;
    if (ctx.days.some((d) => d.index === idx)) return { ok: true, dayIndex: idx };
    return { ok: false, question: { kind: "day_off_board", text: "tomorrow" } };
  }
  if (day.kind === "yesterday") {
    // S55 (R-404): a day like any other -- read exactly where today/
    // tomorrow already are.
    if (ctx.todayIndex === null) {
      return { ok: false, question: { kind: "day_off_board", text: "yesterday" } };
    }
    const idx = ctx.todayIndex - 1;
    if (ctx.days.some((d) => d.index === idx)) return { ok: true, dayIndex: idx };
    return { ok: false, question: { kind: "day_off_board", text: "yesterday" } };
  }
  if (day.kind === "weekday") {
    const found = ctx.days.find((d) => d.weekday === day.day);
    if (found) return { ok: true, dayIndex: found.index };
    return { ok: false, question: { kind: "day_off_board", text: WEEKDAY_FULL_NAMES[day.day] } };
  }
  if (day.kind === "date") {
    const found = ctx.days.find((d) => d.iso === day.iso);
    if (found) return { ok: true, dayIndex: found.index };
    return { ok: false, question: { kind: "day_off_board", text: day.iso } };
  }
  // S58 (R-416, D132 item 5): `weekdays`/`every_day` are legal ONLY on an
  // assign or a booking, and only BEFORE `expandCommand` turns them into one
  // `{ kind: "date" }` per written day -- a caller reaching this function
  // with one still set (any other intent, or an assign/book that skipped
  // `expandCommand`) is a bug, never a crash. `resolveDay` on these kinds is
  // the one place the refusal lives; every caller shares it.
  if (day.kind === "weekdays" || day.kind === "every_day") {
    return { ok: false, question: { kind: "bad_repeat_day", text: dayWordLabel(day) } };
  }
  // S55 (D130 item 4): `this_week`/`next_week`/`last_week` are legal ONLY on
  // a `copy`'s own `from`/`to` (parse.ts's own `DayWord` doc) -- resolved by
  // `resolveWeekDays` below, never by this function. Unreachable via the
  // documented grammar; kept so the switch stays exhaustive against
  // parse.ts's full `DayWord` rather than a narrower alias of it.
  return { ok: false, question: { kind: "day_off_board", text: dayWordLabel(day) } };
}

/** S55 (D130 item 4): a plain-language name for any `DayWord`, for a
 *  `nothing_to_do`/defensive message that must name a day -- "yesterday",
 *  "Monday", "2026-09-04", "this week". S58 adds the two repeat kinds
 *  (`weekdays`/`every_day`), each naming its own week. */
function dayWordLabel(day: DayWord): string {
  if (day.kind === "today") return "today";
  if (day.kind === "tomorrow") return "tomorrow";
  if (day.kind === "yesterday") return "yesterday";
  if (day.kind === "weekday") return WEEKDAY_FULL_NAMES[day.day];
  if (day.kind === "date") return day.iso;
  if (day.kind === "this_week") return "this week";
  if (day.kind === "next_week") return "next week";
  if (day.kind === "last_week") return "last week";
  const week = day.week === "next_week" ? "next week" : "this week";
  if (day.kind === "weekdays") return `every weekday ${week}`;
  return `every day ${week}`;
}

// ---------------------------------------------------------------------------
// Shared steps (brief §3: "the parser and resolver share the assign path's
// ... cell and part steps through private helpers"). Both `AssignCommand` and
// `BookCommand` carry `place`/`product`/`day`/`start`/`end` in the same shape,
// so these take just those fields rather than a whole command.
// ---------------------------------------------------------------------------

/** Step 1 (both intents): the first place word against `ctx.cells`, each
 *  further word a qualifier over ancestor names, exactly as brief §5
 *  describes. */
function resolveCellStep(
  place: readonly string[],
  ctx: ResolveContext,
  byPath: Map<string, Node>,
  // Reviewer fix (S60-b review, R-422): the command's own `product` word,
  // passed ONLY by the three callers that have one (assign/book/headcount) --
  // used solely to tell whether this call is the R-422 single-segment
  // ambiguity (`product === ""` and `place.length === 1`; every other caller,
  // and every ordinary multi-segment sentence, leaves this undefined and gets
  // byte-identical behaviour to before this parameter existed).
  emptyProductWord?: string,
): { ok: true; cell: Node } | { ok: false; question: Question } {
  const firstPlaceWord = place[0] ?? "";
  let cellCandidates = matchName(firstPlaceWord, ctx.cells, (c) => c.name) as Node[];
  if (cellCandidates.length === 0) {
    // Reviewer fix (S60-b review, R-422): "assign Sam to Housing A 8 to 4"
    // (a PART, no place) now parses with place ["Housing A"], product "" --
    // parse.ts's own single-segment branch cannot tell "Housing A" the part
    // from "Housing A" the cell name, so it reads the one segment as the
    // place. When no cell matches AND this is exactly that ambiguous shape,
    // check whether the word instead names a part (the same three tiers
    // `matchName` uses everywhere, or a near name past R-418's own floor)
    // before falling back to an ordinary "no place" question -- a person who
    // named the part gets told the part was heard and asked which cell,
    // never sent place suggestions for a word they never meant as a place.
    if (emptyProductWord === "" && place.length === 1) {
      const exactPartHits = matchName(firstPlaceWord, ctx.products, (p) => p.name);
      const isPart =
        exactPartHits.length > 0 ||
        nearestNames(
          firstPlaceWord,
          ctx.products.map((p) => p.name),
        ).length > 0;
      if (isPart) {
        const { suggestions, sayOnly } = trackCellSuggestions(ctx, byPath);
        return {
          ok: false,
          question: {
            kind: "unknown",
            field: "place",
            text: firstPlaceWord,
            asPart: true,
            ...(sayOnly ? {} : { suggestions }),
          },
        };
      }
    }
    const suggestions = placeSuggestions(firstPlaceWord, ctx, byPath);
    return {
      ok: false,
      question:
        suggestions.length > 0
          ? { kind: "unknown", field: "place", text: firstPlaceWord, suggestions }
          : { kind: "unknown", field: "place", text: firstPlaceWord },
    };
  }
  for (const qualifier of place.slice(1)) {
    const filtered = filterByQualifier(cellCandidates, qualifier, byPath);
    if (filtered.length === 0) {
      const elsewhere = cellCandidates.map((c) => ({
        id: c.id,
        label: placeLabel(c, byPath),
        word: c.name,
      }));
      return {
        ok: false,
        question: { kind: "place_mismatch", cell: firstPlaceWord, qualifier, elsewhere },
      };
    }
    cellCandidates = filtered;
  }
  if (cellCandidates.length > 1) {
    return {
      ok: false,
      question: {
        kind: "ambiguous",
        field: "place",
        text: firstPlaceWord,
        candidates: cellCandidates.map((c) => ({
          id: c.id,
          label: placeLabel(c, byPath),
          word: c.name,
        })),
      },
    };
  }
  return { ok: true, cell: cellCandidates[0] };
}

/** Step 2 (both intents): match the product word, then check `offeredAt`
 *  this cell — exactly brief §5's matching tiers and scope check. */
function resolvePartStep(
  productWord: string,
  cell: Node,
  ctx: ResolveContext,
): { ok: true; product: ProductLike } | { ok: false; question: Question } {
  let productHits = matchName(productWord, ctx.products, (p) => p.name);
  if (productHits.length === 0) {
    productHits = matchName(productWord, ctx.products, (p) => p.sku);
  }
  if (productHits.length === 0) {
    productHits = matchName(productWord, ctx.products, (p) => `${p.sku}/${p.name}`);
  }
  if (productHits.length === 0 && productWord.includes("/")) {
    const pieces = productWord
      .split("/")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const matchedIds = new Set<string>();
    for (const piece of pieces) {
      for (const p of matchName(piece, ctx.products, (x) => x.name)) matchedIds.add(p.id);
      for (const p of matchName(piece, ctx.products, (x) => x.sku)) matchedIds.add(p.id);
    }
    if (matchedIds.size === 1) {
      const [onlyId] = matchedIds;
      productHits = ctx.products.filter((p) => p.id === onlyId);
    }
  }
  if (productHits.length === 0) {
    // S60-b (R-422): a near-miss WORD (matchName found nothing, but R-418's
    // own floor clears for a real name -- "Widgt" against "Widget A") is
    // offered FIRST and alone -- never merged with the cell's own menu
    // below. A near name is a better guess at what the person actually said
    // than the whole menu is, so the two lists are tried in order, first
    // non-empty wins, the same one-tier-at-a-time discipline `matchTiers`
    // itself already uses for the ordinary exact/starts-with/contains tiers.
    const nearSuggestions = productSuggestions(productWord, ctx);
    if (nearSuggestions.length > 0) {
      return {
        ok: false,
        question: {
          kind: "unknown",
          field: "product",
          text: productWord,
          suggestions: nearSuggestions,
        },
      };
    }
    // No near name either -- including the ordinary case, `productWord ===
    // ""` (R-422's own "no part at all"), since `nearestNames`/`matchName`
    // both read an empty word as no match by construction. Offer the
    // resolved CELL's own menu instead (`offeredSuggestions`), capped at
    // eight with a `more` flag; `text` carries the CELL's name for the
    // empty-product shape specifically (there is no word to report, and the
    // bar's own message for it names the cell, not a misheard word -- brief
    // §4) but stays the word said for a genuine near-miss with no near name.
    const { suggestions, more } = offeredSuggestions(cell, ctx);
    if (suggestions.length === 0) {
      // No offerings at all -- the existing plain `unknown`, byte for byte.
      return { ok: false, question: { kind: "unknown", field: "product", text: productWord } };
    }
    return {
      ok: false,
      question: {
        kind: "unknown",
        field: "product",
        text: productWord === "" ? cell.name : productWord,
        suggestions,
        ...(more ? { more: true as const } : {}),
      },
    };
  }
  if (productHits.length > 1) {
    return {
      ok: false,
      question: {
        kind: "ambiguous",
        field: "product",
        text: productWord,
        candidates: productHits.map((p) => ({ id: p.id, label: p.name, word: p.name })),
      },
    };
  }
  const product = productHits[0];
  const offered = ctx.offeredAt(cell.id);
  if (!offered.some((o) => o.id === product.id)) {
    return { ok: false, question: { kind: "not_offered", product: product.name, cell: cell.name } };
  }
  return { ok: true, product };
}

/** Step 3 (both intents): resolve the day word to an index, compute the span
 *  in real minutes, and refuse a too-short one — exactly brief §5's rules. */
function resolveDaySpanStep(
  day: AssignCommand["day"],
  start: { hour: number; minute: number },
  end: { hour: number; minute: number },
  ctx: ResolveContext,
):
  | {
      ok: true;
      dayIndex: number;
      startMin: number;
      endMin: number;
      timeText: string;
      jobRunId?: string;
    }
  | { ok: false; question: Question } {
  const dayResolution = resolveDay(day, ctx);
  if (!dayResolution.ok) return { ok: false, question: dayResolution.question };
  const dayIndex = dayResolution.dayIndex;
  // R-404 (D130 item 3): `clockToMinuteOfDay` reads a DAY_END `end` (23:59)
  // as midnight -- 1440, not 1439 -- so "after 2" reaches the next day's
  // 00:00.
  const startMin = ctx.wallToOffset(dayIndex, clockToMinuteOfDay(start));
  const endMin = ctx.wallToOffset(dayIndex, clockToMinuteOfDay(end));
  if (endMin - startMin < ctx.minDurationMinutes) {
    return {
      ok: false,
      question: { kind: "too_short", minutes: endMin - startMin, min: ctx.minDurationMinutes },
    };
  }
  const timeText = formatSpan(start, end);
  return { ok: true, dayIndex, startMin, endMin, timeText };
}

type ShiftBand = { name: string; startMin: number; endMin: number };

/** A minute-of-day, wrapped into 0..1439 -- an overnight band's `endMin`
 *  (past 1440, the pattern's own convention, brief §19.99/D128) reads back
 *  as its real wall-clock hour, exactly as `formatClock` on the real `Date`
 *  the board's own blocks are built from would (S52-b brief §2 item 2). */
function shiftClockOf(min: number): { hour: number; minute: number } {
  const m = ((min % 1440) + 1440) % 1440;
  return { hour: Math.floor(m / 60), minute: m % 60 };
}

/** "HH:MM–HH:MM" for a band, the same `formatSpan` the hours form uses --
 *  so a shift's resolved text and a typed one are the same string for the
 *  same hours (S52-b brief §2 item 4, SR1). */
function shiftBandTimeText(band: ShiftBand): string {
  return formatSpan(shiftClockOf(band.startMin), shiftClockOf(band.endMin));
}

/** The band name's last SIGNIFICANT word -- the generic trailing word
 *  "shift" itself is dropped first when there is another word before it, so
 *  "Night Shift" and "Night" both offer their last token as "night", and
 *  "Shift 2" (the word "shift" leads, not trails) offers "2" unchanged. */
function significantLastToken(name: string): string {
  const tokens = normalizeForMatch(name)
    .split(" ")
    .filter((t) => t.length > 0);
  if (tokens.length > 1 && tokens[tokens.length - 1] === "shift") tokens.pop();
  return tokens[tokens.length - 1] ?? "";
}

/** S52-b (brief §2 item 2): exact name first (case-blind, whitespace-
 *  collapsed), else a bare number/word matching the name's last significant
 *  token, else the one band whose name contains the words -- the first tier
 *  with ANY hit wins, never the "best" of several (the same discipline as
 *  `matchName`, but shift bands have no separate "starts-with" tier). */
function matchShiftBand(text: string, bands: readonly ShiftBand[]): ShiftBand[] {
  const w = normalizeForMatch(text);
  if (w === "") return [];
  const exact = bands.filter((b) => normalizeForMatch(b.name) === w);
  if (exact.length > 0) return exact;
  const byToken = bands.filter((b) => significantLastToken(b.name) === w);
  if (byToken.length > 0) return byToken;
  return bands.filter((b) => normalizeForMatch(b.name).includes(w));
}

/** S55 (R-404, D130 item 3): the start an assign/book sentence may itself
 *  carry on `END_OF_SHIFT`/`END_OF_DAY` (R-404's amendment to R-402's
 *  invariant -- unassign/move never have a `start` field of their own, so
 *  every OTHER caller passes `givenStart: null`), and what to do when
 *  neither that nor "now" supplies one. */
interface BoundaryOpts {
  givenStart: ClockTime | null;
  /** `"ask"` (assign/book: `no_start`) or `"cover"` (a removal or a move:
   *  the whole band/day, §2's own words). */
  onMissingStart: "ask" | "cover";
}

const DEFAULT_BOUNDARY_OPTS: BoundaryOpts = { givenStart: null, onMissingStart: "ask" };

/** S55 (R-404, D130 item 3): which of the three reserved boundary names, if
 *  any -- checked BEFORE a shift name is ever tried against a pattern's own
 *  bands, case-insensitive and exact, so a band actually named "All Day"
 *  (BN8) is never reached by the word. */
function boundaryKind(shiftText: string): "all_day" | "end_of_shift" | "end_of_day" | null {
  const w = normalizeForMatch(shiftText);
  if (w === ALL_DAY) return "all_day";
  if (w === END_OF_SHIFT) return "end_of_shift";
  if (w === END_OF_DAY) return "end_of_day";
  return null;
}

/** S58 (R-414): case-insensitive, exact -- matches `JOB_HOURS` the same way
 *  `boundaryKind` matches its own three names. */
function isJobHours(shiftText: string): boolean {
  return normalizeForMatch(shiftText) === JOB_HOURS;
}

/** True when `mod` (a plain minute-of-day, 0..1439) falls in `band`'s own
 *  `[startMin, endMin)` -- checked both as given and shifted a day later, so
 *  an overnight band (`endMin` past 1440, the pattern's own convention)
 *  still contains an early-morning `mod` that belongs to its SECOND half. */
function containsMinuteOfDay(band: ShiftBand, mod: number): boolean {
  return (
    (mod >= band.startMin && mod < band.endMin) ||
    (mod + 1440 >= band.startMin && mod + 1440 < band.endMin)
  );
}

function finishBoundarySpan(
  dayIndex: number,
  startMod: number,
  endMod: number,
  ctx: ResolveContext,
):
  | { ok: true; dayIndex: number; startMin: number; endMin: number; timeText: string }
  | { ok: false; question: Question } {
  const startMin = ctx.wallToOffset(dayIndex, startMod);
  const endMin = ctx.wallToOffset(dayIndex, endMod);
  if (endMin - startMin < ctx.minDurationMinutes) {
    return {
      ok: false,
      question: { kind: "too_short", minutes: endMin - startMin, min: ctx.minDurationMinutes },
    };
  }
  const timeText = formatSpan(shiftClockOf(startMod), shiftClockOf(endMod));
  return { ok: true, dayIndex, startMin, endMin, timeText };
}

/**
 * S55 (R-404, D130 item 3): the three reserved boundary names, answered from
 * `cell`'s own pattern, never from the clock -- `all_day` is the first
 * band's start to the last band's end, in the pattern's OWN order
 * (`shiftsAt`, never sorted by clock); `end_of_shift`/`end_of_day` need a
 * START -- the sentence's own (`opts.givenStart`), else "now" rounded up on
 * today (`ctx.nowMinuteOfDay`), else (a removal or a move only, `opts.
 * onMissingStart === "cover"`) the whole band ("end of shift", the FIRST
 * band whole) or the whole day ("end of day", 00:00 to its own end) -- an
 * assign or a booking with none of those (`onMissingStart === "ask"`) gets
 * `no_start` instead.
 */
function resolveBoundarySpan(
  kind: "all_day" | "end_of_shift" | "end_of_day",
  dayIndex: number,
  cell: { id: string; name: string },
  ctx: ResolveContext,
  opts: BoundaryOpts,
):
  | { ok: true; dayIndex: number; startMin: number; endMin: number; timeText: string }
  | { ok: false; question: Question } {
  const bands = ctx.shiftsAt(cell.id);

  if (kind === "all_day") {
    if (bands.length === 0) {
      return { ok: false, question: { kind: "no_shift_pattern", cell: cell.name } };
    }
    return finishBoundarySpan(dayIndex, bands[0].startMin, bands[bands.length - 1].endMin, ctx);
  }

  const today = dayIndex === ctx.todayIndex && ctx.nowMinuteOfDay !== null;
  let startMod: number | null =
    opts.givenStart !== null ? opts.givenStart.hour * 60 + opts.givenStart.minute : null;
  if (startMod === null && today) {
    startMod = roundUpToQuarterHour(ctx.nowMinuteOfDay!);
  }

  if (kind === "end_of_day") {
    // R-404: with a pattern, the last band's own end; with none, midnight.
    const endMod = bands.length > 0 ? bands[bands.length - 1].endMin : 24 * 60;
    if (startMod !== null) return finishBoundarySpan(dayIndex, startMod, endMod, ctx);
    if (opts.onMissingStart === "ask") {
      return {
        ok: false,
        question: { kind: "no_start", text: "Say when it starts — from 10, say." },
      };
    }
    // A removal or a move, on a day that is not today: covers the whole day.
    return finishBoundarySpan(dayIndex, 0, endMod, ctx);
  }

  // kind === "end_of_shift"
  if (bands.length === 0) {
    return { ok: false, question: { kind: "no_shift_pattern", cell: cell.name } };
  }
  if (startMod !== null) {
    let band = bands.find((b) => containsMinuteOfDay(b, startMod!)) ?? null;
    if (!band) band = bands.find((b) => b.startMin > startMod!) ?? null;
    if (!band) {
      return {
        ok: false,
        question: { kind: "no_shift_at", cell: cell.name, time: formatClockMinuteOfDay(startMod) },
      };
    }
    return finishBoundarySpan(dayIndex, startMod, band.endMin, ctx);
  }
  if (opts.onMissingStart === "ask") {
    return {
      ok: false,
      question: { kind: "no_start", text: "Say when it starts — from 10, say." },
    };
  }
  // A removal or a move, on a day that is not today: the band containing
  // "now" is meaningless on another day -- the FIRST band, whole (§2).
  return finishBoundarySpan(dayIndex, bands[0].startMin, bands[0].endMin, ctx);
}

/** S58 (R-414/R-415, D132 items 3/4): every run of `product` on `cell`
 *  overlapping `[windowStart, windowEnd)`, in `ctx.runs`' own (board) order --
 *  shared by "the job's hours" (the assign path, the whole day as its
 *  window) and a headcount sentence (its own shift/span-narrowed window). */
function findJobRuns(
  cell: { id: string },
  product: ProductLike,
  windowStart: number,
  windowEnd: number,
  ctx: ResolveContext,
): ContextRun[] {
  return ctx.runs.filter(
    (r) =>
      r.nodeId === cell.id &&
      r.productId === product.id &&
      ctx.overlaps({ startMin: windowStart, endMin: windowEnd }, r),
  );
}

/** S58: the shared none/several refusal for `findJobRuns`' own result --
 *  `null` means exactly one, the caller's own success case. */
function jobRunsQuestion(
  runs: readonly ContextRun[],
  product: ProductLike,
  cell: { name: string },
  when: string,
): Question | null {
  if (runs.length === 0) return { kind: "no_job", product: product.name, cell: cell.name, when };
  if (runs.length > 1) {
    return {
      kind: "which_job",
      product: product.name,
      cell: cell.name,
      runs: runs.map((r) => r.span),
    };
  }
  return null;
}

/**
 * S58 (R-414, D132 item 3): "the job's hours" on an assign -- `resolveShift
 * SpanStep`'s own `jobProduct` branch. The runs of `product` on `cell`
 * overlapping the WHOLE DAY (never narrowed by a start -- the sentence gave
 * none, that is the point of saying "the job"); none/several is `no_job`/
 * `which_job`; exactly one takes ITS OWN hours as the span (`jobRunId` tells
 * `resolveAssignCommand` to skip the run-matching step entirely -- the
 * sentence already named the job, R-383's `run_exists` question would never
 * make sense here). A misconfigured run shorter than the minimum is refused
 * the same way a pattern's own too-short band already is (§2's own comment).
 */
function resolveJobHoursSpan(
  dayIndex: number,
  cell: { id: string; name: string },
  product: ProductLike,
  ctx: ResolveContext,
):
  | {
      ok: true;
      dayIndex: number;
      startMin: number;
      endMin: number;
      timeText: string;
      jobRunId?: string;
    }
  | { ok: false; question: Question } {
  const dayStart = ctx.wallToOffset(dayIndex, 0);
  const dayEnd = ctx.wallToOffset(dayIndex, 1440);
  const runs = findJobRuns(cell, product, dayStart, dayEnd, ctx);
  const when = ctx.days.find((d) => d.index === dayIndex)?.iso ?? "";
  const q = jobRunsQuestion(runs, product, cell, when);
  if (q !== null) return { ok: false, question: q };
  const run = runs[0];
  if (run.endMin - run.startMin < ctx.minDurationMinutes) {
    return {
      ok: false,
      question: {
        kind: "too_short",
        minutes: run.endMin - run.startMin,
        min: ctx.minDurationMinutes,
      },
    };
  }
  return {
    ok: true,
    dayIndex,
    startMin: run.startMin,
    endMin: run.endMin,
    timeText: run.span,
    jobRunId: run.id,
  };
}

/**
 * S52-b (R-402, design §19.99/D128): a shift's name resolves to `cell`'s
 * own band for the resolved day, from `ctx.shiftsAt` -- the SAME map
 * `BoardPage` builds from `index.templateForNode`, the pop-up's own shift
 * chips' source (no copy, CLAUDE.md §4). Returns the same shape
 * `resolveDaySpanStep` does, so every caller after this step is unchanged.
 *
 * S55 (R-404, D130 item 3): `boundaryKind` is checked FIRST -- before the
 * band-matching tiers below ever run -- so `ALL_DAY`/`END_OF_SHIFT`/
 * `END_OF_DAY` never fall through to `matchShiftBand` (BN8: a band actually
 * named "All Day" is never reached by the word).
 */
function resolveShiftSpanStep(
  day: AssignCommand["day"],
  shiftText: string,
  cell: { id: string; name: string },
  ctx: ResolveContext,
  boundary: BoundaryOpts = DEFAULT_BOUNDARY_OPTS,
  /** S58 (R-414): set ONLY by the assign path's own call -- every other
   *  caller (book, unassign, move) passes none, so `isJobHours` below never
   *  fires for them and "the job" falls through to the ordinary band match. */
  jobProduct: ProductLike | null = null,
):
  | {
      ok: true;
      dayIndex: number;
      startMin: number;
      endMin: number;
      timeText: string;
      jobRunId?: string;
    }
  | { ok: false; question: Question } {
  const dayResolution = resolveDay(day, ctx);
  if (!dayResolution.ok) return { ok: false, question: dayResolution.question };
  const dayIndex = dayResolution.dayIndex;

  if (jobProduct !== null && isJobHours(shiftText)) {
    return resolveJobHoursSpan(dayIndex, cell, jobProduct, ctx);
  }

  const kind = boundaryKind(shiftText);
  if (kind !== null) return resolveBoundarySpan(kind, dayIndex, cell, ctx, boundary);

  const bands = ctx.shiftsAt(cell.id);
  if (bands.length === 0) {
    return { ok: false, question: { kind: "no_shift_pattern", cell: cell.name } };
  }
  const hits = matchShiftBand(shiftText, bands);
  if (hits.length === 0) {
    return {
      ok: false,
      question: {
        kind: "no_shift",
        text: shiftText,
        cell: cell.name,
        shifts: bands.map((b) => b.name),
      },
    };
  }
  if (hits.length > 1) {
    return {
      ok: false,
      question: {
        kind: "ambiguous",
        field: "shift",
        text: shiftText,
        candidates: hits.map((b) => ({
          id: b.name,
          label: `${b.name} ${shiftBandTimeText(b)}`,
          word: b.name,
        })),
      },
    };
  }
  const band = hits[0];
  const startMin = ctx.wallToOffset(dayIndex, band.startMin);
  const endMin = ctx.wallToOffset(dayIndex, band.endMin);
  // A pattern's own band shorter than the minimum is refused the same way
  // typed hours are -- reachable (a misconfigured pattern), just unlikely.
  if (endMin - startMin < ctx.minDurationMinutes) {
    return {
      ok: false,
      question: { kind: "too_short", minutes: endMin - startMin, min: ctx.minDurationMinutes },
    };
  }
  const timeText = shiftBandTimeText(band);
  return { ok: true, dayIndex, startMin, endMin, timeText };
}

/**
 * R-402 / D128 (docs/design-plan.md §19.99): a place-less sentence's shift
 * name is resolved against each of `blocks`' cells, in BOARD ORDER --
 * skipping a cell with no pattern or no matching band -- and the first cell
 * that resolves to exactly one band (or answers ambiguous) is the answer.
 *
 * Reviewer fix (14 Sept follow-up): taking only the FIRST block's cell was
 * order-dependent -- `[blkC2 (no pattern), blk1 (has Shift 1)]` refused with
 * `no_shift_pattern` naming Cell 2, while the reverse order succeeded on
 * Cell 1. This tries every cell in order instead, so the sentence's meaning
 * does not depend on which of the person's blocks happens to sort first.
 *
 * When no cell resolves: `no_shift` naming the first cell (board order)
 * that HAS a pattern, with that cell's own bands; `no_shift_pattern` (naming
 * the very first block's cell) only when NONE of them has a pattern at all.
 */
function resolveShiftAgainstBlocks(
  day: AssignCommand["day"],
  shiftText: string,
  blocks: readonly ContextAssignment[],
  ctx: ResolveContext,
):
  | { ok: true; dayIndex: number; startMin: number; endMin: number; timeText: string }
  | { ok: false; question: Question } {
  const cellOf = (b: ContextAssignment): { id: string; name: string } =>
    ctx.nodeById.get(b.nodeId) ?? { id: b.nodeId, name: b.nodeId };

  // S55 (R-404, D130 item 3): a boundary word needs no per-band NAME match
  // -- only a cell with a pattern (`all_day`/`end_of_shift`) or any cell at
  // all (`end_of_day`, which falls back to midnight with none). The first
  // candidate cell in board order that can answer wins -- the same
  // board-order rule the named-shift loop below already follows. `onMissing
  // Start: "cover"` throughout: this path is unassign/move's own (D130 item
  // 3), neither of which has a `start` field to carry.
  const kind = boundaryKind(shiftText);
  if (kind !== null) {
    for (const b of blocks) {
      const cell = cellOf(b);
      if (kind !== "end_of_day" && ctx.shiftsAt(cell.id).length === 0) continue;
      return resolveShiftSpanStep(day, shiftText, cell, ctx, {
        givenStart: null,
        onMissingStart: "cover",
      });
    }
    return { ok: false, question: { kind: "no_shift_pattern", cell: cellOf(blocks[0]).name } };
  }

  let firstCellWithPattern: { id: string; name: string } | null = null;
  for (const b of blocks) {
    const cell = cellOf(b);
    const bands = ctx.shiftsAt(cell.id);
    if (bands.length === 0) continue; // no pattern on this cell -- skip
    const hits = matchShiftBand(shiftText, bands);
    if (hits.length === 0) {
      // A pattern, but no matching band -- skip, remembering the first such
      // cell for the "no cell resolves" fallback message below.
      if (firstCellWithPattern === null) firstCellWithPattern = cell;
      continue;
    }
    // Exactly one band, or an ambiguity between several -- this cell is THE
    // answer either way (an ambiguous cell is never skipped in favor of a
    // later, unambiguous one).
    return resolveShiftSpanStep(day, shiftText, cell, ctx);
  }
  if (firstCellWithPattern !== null) {
    return {
      ok: false,
      question: {
        kind: "no_shift",
        text: shiftText,
        cell: firstCellWithPattern.name,
        shifts: ctx.shiftsAt(firstCellWithPattern.id).map((b) => b.name),
      },
    };
  }
  return { ok: false, question: { kind: "no_shift_pattern", cell: cellOf(blocks[0]).name } };
}

type OperatorLike = ResolveContext["operators"][number];

/** Step (assign AND unassign, S41-b brief §2: extracted rather than
 *  duplicated so the assign path's own meaning is untouched): match the
 *  person word against active operators, name first then employeeRef —
 *  exactly brief §5's tiers, unchanged from the pre-S41-b inline step 3 of
 *  `resolveAssignCommand`. */
function resolvePersonStep(
  operatorWord: string,
  ctx: ResolveContext,
): { ok: true; operator: OperatorLike } | { ok: false; question: Question } {
  const activeOperators = ctx.operators.filter((o) => o.active);
  let operatorHits = matchName(operatorWord, activeOperators, (o) => o.displayName);
  if (operatorHits.length === 0) {
    const withRef = activeOperators.filter((o) => o.employeeRef !== null);
    operatorHits = matchName(operatorWord, withRef, (o) => o.employeeRef as string);
  }
  if (operatorHits.length === 0) {
    const suggestions = operatorSuggestions(operatorWord, activeOperators);
    return {
      ok: false,
      question:
        suggestions.length > 0
          ? { kind: "unknown", field: "operator", text: operatorWord, suggestions }
          : { kind: "unknown", field: "operator", text: operatorWord },
    };
  }
  if (operatorHits.length > 1) {
    return {
      ok: false,
      question: {
        kind: "ambiguous",
        field: "operator",
        text: operatorWord,
        candidates: operatorHits.map((o) => ({
          id: o.id,
          label: o.displayName,
          word: o.displayName,
        })),
      },
    };
  }
  return { ok: true, operator: operatorHits[0] };
}

/** The assign path (unchanged in meaning from before S41-a/S41-b): cell,
 *  part, person (shared, `resolvePersonStep`), day and span, the own-block
 *  question (R-385), the run question (R-383), then the readout. */
function resolveAssignCommand(command: AssignCommand, ctx: ResolveContext): Resolution {
  const byPath = buildPathIndex(ctx.nodeById);

  // 1. Cell.
  const cellResult = resolveCellStep(command.place, ctx, byPath, command.product);
  if (!cellResult.ok) return { ok: false, question: cellResult.question };
  const cell = cellResult.cell;

  // 2. Part.
  const partResult = resolvePartStep(command.product, cell, ctx);
  if (!partResult.ok) return { ok: false, question: partResult.question };
  const product = partResult.product;

  // 3. Person (shared with unassign, S41-b: resolvePersonStep).
  const personResult = resolvePersonStep(command.operator, ctx);
  if (!personResult.ok) return { ok: false, question: personResult.question };
  const operator = personResult.operator;

  // 4. Day and span. S52-b (R-402): a shift name resolves to CELL's own
  // band for the day (the type's own invariant means `start`/`end` are null
  // exactly when `shift` is not). S55 (R-404): `command.start` carries a
  // start ONLY when `shift` is `END_OF_SHIFT`/`END_OF_DAY`; an assign asks
  // (`no_start`) when neither it nor "now" supplies one. S58 (R-414): the
  // FIFTH argument, `product`, is read only here -- `resolveShiftSpanStep`'s
  // own `jobProduct` branch, "the job's hours". Every other caller of this
  // shared step (book, unassign, move) passes none, so "the job" falls
  // through to an ordinary (failing) band match for them instead.
  const spanResult =
    command.shift !== null
      ? resolveShiftSpanStep(
          command.day,
          command.shift,
          cell,
          ctx,
          { givenStart: command.start, onMissingStart: "ask" },
          product,
        )
      : resolveDaySpanStep(command.day, command.start!, command.end!, ctx);
  if (!spanResult.ok) return { ok: false, question: spanResult.question };
  const { dayIndex, startMin, endMin, timeText, jobRunId } = spanResult;

  // 5. The own-block question (R-385).
  // S58-e (R-413): `separate_from` behaves like `null` EXCEPT that the named
  // block (the one this assign is being split out of, still full-length in
  // `ctx.assignments` -- D127 means the whole lot resolves before either
  // half writes) is removed from `own` first. A genuine second overlapping
  // block of the same person/part/cell still asks `block_exists`, naming
  // only that other block; if none remains, this falls through to the run
  // question exactly as `separate` does.
  const ownAll = ctx.assignments.filter(
    (x) =>
      x.nodeId === cell.id &&
      x.operatorId === operator.id &&
      x.productId === product.id &&
      ctx.overlaps({ startMin, endMin }, x),
  );
  const existing = command.existing;
  const own =
    existing !== null && existing.kind === "separate_from"
      ? ownAll.filter((x) => x.id !== existing.assignmentId)
      : ownAll;
  const blockCandidates = (): Candidate[] =>
    own.map((x) => ({ id: x.id, label: x.label, word: "" }));
  const askBlock = (): Resolution => ({
    ok: false,
    question: {
      kind: "block_exists",
      person: operator.displayName,
      product: product.name,
      cell: cell.name,
      span: timeText,
      blocks: blockCandidates(),
      same: own.length === 1 && own[0].startMin === startMin && own[0].endMin === endMin,
    },
  });
  let retime: ContextAssignment | null = null;
  if (own.length > 0 && (existing === null || existing.kind === "separate_from")) {
    return askBlock();
  } else if (existing !== null && existing.kind === "retime") {
    const wantedId = existing.assignmentId;
    const hit = own.find((x) => x.id === wantedId) ?? null;
    if (hit) {
      retime = hit;
    } else if (own.length > 0) {
      return askBlock(); // the board changed: re-ask, never guess
    } else {
      return {
        ok: false,
        question: {
          kind: "block_gone",
          person: operator.displayName,
          product: product.name,
          cell: cell.name,
        },
      };
    }
  }
  // `existing.kind === "separate"`, or `separate_from` with nothing left in
  // `own` after removing its named block, or no own block at all: fall
  // through to the run question.

  // 6. The run question (R-383) — skipped entirely when re-timing a block: a
  // re-timed block's attachment is decided by the drag's own containment
  // logic on the way to the write (§6), not by the resolver.
  let target: CommandTarget;
  let hits: ContextRun[] = [];
  if (retime !== null) {
    target = { kind: "retime", assignmentId: retime.id };
  } else if (jobRunId !== undefined) {
    // S58 (R-414): "the job's hours" already named the job -- the run
    // question (R-383) never runs, `attach` is never consulted.
    target = { kind: "run", runId: jobRunId };
  } else {
    hits = ctx.runs.filter(
      (r) =>
        r.nodeId === cell.id && r.productId === product.id && ctx.fitsRun({ startMin, endMin }, r),
    );
    const runCandidates = (): Candidate[] =>
      hits.map((r) => ({ id: r.id, label: r.label, word: "" }));
    if (hits.length === 0) {
      target = { kind: "direct", productId: product.id };
    } else if (command.attach === null) {
      return {
        ok: false,
        question: {
          kind: "run_exists",
          product: product.name,
          cell: cell.name,
          runs: runCandidates(),
        },
      };
    } else if (command.attach.kind === "run") {
      const runId = command.attach.runId;
      const matchedRun = hits.find((r) => r.id === runId);
      if (matchedRun) {
        target = { kind: "run", runId: matchedRun.id };
      } else {
        return {
          ok: false,
          question: {
            kind: "run_exists",
            product: product.name,
            cell: cell.name,
            runs: runCandidates(),
          },
        };
      }
    } else {
      target = { kind: "direct", productId: product.id };
    }
  }

  // Readout.
  const ancestorNames = ancestorsOf(cell, byPath).map((n) => n.name);
  const chain = [...ancestorNames, cell.name].join(" › ");
  const iso = ctx.days.find((d) => d.index === dayIndex)?.iso ?? "";
  let readout = `${operator.displayName} → ${product.name} · ${chain} · ${iso} · ${timeText}`;
  if (target.kind === "run") {
    // S58: `ctx.runs` (not `hits`, which stays empty on the job-hours
    // branch) so the readout names the run regardless of which path found it.
    const runLabel = ctx.runs.find((r) => r.id === target.runId)?.label ?? "";
    readout += ` · joining ${runLabel}`;
  } else if (target.kind === "retime" && retime !== null) {
    readout += ` · changing ${retime.label}`;
  }

  return {
    ok: true,
    resolved: {
      intent: "assign",
      nodeId: cell.id,
      operatorId: operator.id,
      productId: product.id,
      target,
      range: { startMin, endMin },
      readout,
    },
  };
}

/**
 * S41-a — the book path: cell, part (shared with assign), day and span
 * (shared), then the job question (brief §3): a cell runs one job at a
 * time, so an overlap of the SAME part asks whether to change its hours
 * (R-387); an overlap of ANOTHER part just says which job is in the way.
 */
function resolveBookCommand(command: BookCommand, ctx: ResolveContext): Resolution {
  const byPath = buildPathIndex(ctx.nodeById);

  // 1. Cell.
  const cellResult = resolveCellStep(command.place, ctx, byPath, command.product);
  if (!cellResult.ok) return { ok: false, question: cellResult.question };
  const cell = cellResult.cell;

  // 2. Part.
  const partResult = resolvePartStep(command.product, cell, ctx);
  if (!partResult.ok) return { ok: false, question: partResult.question };
  const product = partResult.product;

  // 3. Day and span. S52-b (R-402): a shift name resolves to CELL's own
  // band for the day. S55 (R-404): same `command.start`/`no_start` rule as
  // the assign path.
  const spanResult =
    command.shift !== null
      ? resolveShiftSpanStep(command.day, command.shift, cell, ctx, {
          givenStart: command.start,
          onMissingStart: "ask",
        })
      : resolveDaySpanStep(command.day, command.start!, command.end!, ctx);
  if (!spanResult.ok) return { ok: false, question: spanResult.question };
  const { dayIndex, startMin, endMin, timeText } = spanResult;

  // 4. The job question (R-387).
  const runsOnCell = ctx.runs.filter((r) => r.nodeId === cell.id);
  let target: BookTarget;
  let retimeHit: ContextRun | null = null;
  if (command.existing === null) {
    const overlap = ctx.findRunOverlap({ startMin, endMin }, runsOnCell, null);
    if (overlap && overlap.productId === product.id) {
      const same = overlap.startMin === startMin && overlap.endMin === endMin;
      return {
        ok: false,
        question: {
          kind: "job_exists",
          product: product.name,
          cell: cell.name,
          span: timeText,
          run: { id: overlap.id, label: overlap.span, word: "" },
          same,
        },
      };
    }
    if (overlap) {
      return {
        ok: false,
        question: {
          kind: "job_in_the_way",
          product: product.name,
          cell: cell.name,
          other: overlap.label,
        },
      };
    }
    target = { kind: "run_create", productId: product.id, headcount: command.headcount };
  } else {
    // existing.kind === "retime"
    const hit = runsOnCell.find((r) => r.id === command.existing!.runId) ?? null;
    if (!hit) {
      return { ok: false, question: { kind: "job_gone", product: product.name, cell: cell.name } };
    }
    // The retime must not collide with ANOTHER job on the cell — the same
    // rule a drag applies before writing.
    const other = ctx.findRunOverlap({ startMin, endMin }, runsOnCell, hit.id);
    if (other) {
      return {
        ok: false,
        question: {
          kind: "job_in_the_way",
          product: product.name,
          cell: cell.name,
          other: other.label,
        },
      };
    }
    retimeHit = hit;
    target = { kind: "retime_run", runId: hit.id };
  }

  // Readout.
  const ancestorNames = ancestorsOf(cell, byPath).map((n) => n.name);
  const chain = [...ancestorNames, cell.name].join(" › ");
  const iso = ctx.days.find((d) => d.index === dayIndex)?.iso ?? "";
  let readout = `${product.name} · ${chain} · ${iso} · ${timeText}`;
  if (target.kind === "run_create" && command.headcount !== null) {
    readout += ` · ${command.headcount} people`;
  } else if (target.kind === "retime_run" && retimeHit !== null) {
    readout += ` · changing ${retimeHit.label}`;
  }

  return {
    ok: true,
    resolved: {
      intent: "book",
      nodeId: cell.id,
      productId: product.id,
      target,
      range: { startMin, endMin },
      readout,
    },
  };
}

/**
 * S41-b — the unassign path: cell, person (shared, `resolvePersonStep`), day
 * and span, then the block(s) to remove (brief §3/§6). `command.span ===
 * null` means "the whole day": `ctx.wallToOffset(dayIndex, 0)` through
 * `ctx.wallToOffset(dayIndex, 24 * 60)` — `wallToOffset` accepts a
 * minute-of-day past 1440 directly (`src/features/board/lib/time.ts`'s own
 * doc comment: "the excess carries into the following day"), so no special
 * case is needed even on the window's last day; the minimum-duration check
 * (part of `resolveDaySpanStep`) does not apply to the whole-day case since
 * it never calls that step.
 */
function resolveUnassignCommand(command: UnassignCommand, ctx: ResolveContext): Resolution {
  const byPath = buildPathIndex(ctx.nodeById);

  // 1. Cell -- OPTIONAL (S49: an empty place means "wherever they are").
  let cell: Node | null = null;
  if (command.place.length > 0) {
    const cellResult = resolveCellStep(command.place, ctx, byPath);
    if (!cellResult.ok) return { ok: false, question: cellResult.question };
    cell = cellResult.cell;
  }

  // 2. Person (shared with assign).
  const personResult = resolvePersonStep(command.operator, ctx);
  if (!personResult.ok) return { ok: false, question: personResult.question };
  const operator = personResult.operator;

  // 3. Day and span. R-402 / D128 (docs/design-plan.md §19.99): a shift name
  // resolves to the NAMED cell's own band for the day. An EMPTY place
  // ("wherever they are") has no single cell to resolve a pattern against
  // up front, so it is never silently ignored -- it gathers the person's
  // WHOLE-DAY blocks first (the same S49 elsewhere lookup), resolves the
  // shift against those blocks' cells in board order (`resolveShiftAgainst
  // Blocks`, order-independent -- reviewer fix, 14 Sept follow-up), and
  // narrows to that band; step 4 below then re-gathers the person's blocks
  // overlapping THAT window on any cell, exactly as it already does for the
  // no-shift empty-place case, so no candidate list is built twice. No
  // blocks at all that day -- no_block, cell null, the shift never
  // consulted (there is no cell to resolve it against either).
  let dayIndex: number;
  let startMin: number;
  let endMin: number;
  let whenText: string;
  if (command.shift !== null && cell !== null) {
    // S55 (R-404): unassign has no `start` field of its own -- a boundary's
    // missing start covers the whole band/day (`onMissingStart: "cover"`),
    // never asks.
    const spanResult = resolveShiftSpanStep(command.day, command.shift, cell, ctx, {
      givenStart: null,
      onMissingStart: "cover",
    });
    if (!spanResult.ok) return { ok: false, question: spanResult.question };
    dayIndex = spanResult.dayIndex;
    startMin = spanResult.startMin;
    endMin = spanResult.endMin;
    whenText = spanResult.timeText;
  } else if (command.shift !== null) {
    const wholeDay = resolveDay(command.day, ctx);
    if (!wholeDay.ok) return { ok: false, question: wholeDay.question };
    const wholeDayStart = ctx.wallToOffset(wholeDay.dayIndex, 0);
    const wholeDayEnd = ctx.wallToOffset(wholeDay.dayIndex, 24 * 60);
    const wholeDayBlocks = gatherElsewhereBlocks(
      operator.id,
      { startMin: wholeDayStart, endMin: wholeDayEnd },
      ctx,
    );
    if (wholeDayBlocks.length === 0) {
      return {
        ok: false,
        question: {
          kind: "no_block",
          person: operator.displayName,
          cell: null,
          when: ctx.days.find((d) => d.index === wholeDay.dayIndex)?.iso ?? "",
        },
      };
    }
    const spanResult = resolveShiftAgainstBlocks(command.day, command.shift, wholeDayBlocks, ctx);
    if (!spanResult.ok) return { ok: false, question: spanResult.question };
    dayIndex = spanResult.dayIndex;
    startMin = spanResult.startMin;
    endMin = spanResult.endMin;
    whenText = spanResult.timeText;
  } else if (command.span !== null) {
    const spanResult = resolveDaySpanStep(command.day, command.span.start, command.span.end, ctx);
    if (!spanResult.ok) return { ok: false, question: spanResult.question };
    dayIndex = spanResult.dayIndex;
    startMin = spanResult.startMin;
    endMin = spanResult.endMin;
    whenText = spanResult.timeText;
  } else {
    const dayResolution = resolveDay(command.day, ctx);
    if (!dayResolution.ok) return { ok: false, question: dayResolution.question };
    dayIndex = dayResolution.dayIndex;
    startMin = ctx.wallToOffset(dayIndex, 0);
    endMin = ctx.wallToOffset(dayIndex, 24 * 60);
    whenText = ctx.days.find((d) => d.index === dayIndex)?.iso ?? "";
  }

  // 4. The block(s) on the NAMED cell -- brief §3: no product filter, just
  // person, cell and overlap. `hits` is empty by definition when no cell was
  // named (there is no cell to filter on).
  const hits =
    cell === null
      ? []
      : ctx.assignments.filter(
          (x) =>
            x.nodeId === cell!.id &&
            x.operatorId === operator.id &&
            ctx.overlaps({ startMin, endMin }, x),
        );
  const blockCandidates = (): Candidate[] =>
    hits.map((x) => ({
      id: x.id,
      label: `${x.productName ?? "block"} ${x.label}`,
      word: "",
      part: x.productName,
    }));
  // S49: a named cell with none of the person's blocks (or no cell named at
  // all) looks further -- the person's blocks that day/window on every OTHER
  // cell. `flagElsewhere` (the Question's `elsewhere: true`) is set ONLY
  // when a cell WAS named and turned out wrong -- nothing was "wrong" about
  // an empty place, so that case's candidates still carry their own cell
  // names (the caller's buttons still need to disambiguate) without the flag
  // or the "but has ... elsewhere" wording.
  const askRemoveWhich = (list: ContextAssignment[], fromElsewhere: boolean): Resolution => ({
    ok: false,
    question: {
      kind: "remove_which",
      person: operator.displayName,
      cell: cell?.name ?? null,
      when: whenText,
      blocks: fromElsewhere ? elsewhereCandidates(list, ctx) : blockCandidates(),
      ...(fromElsewhere && cell !== null ? { elsewhere: true as const } : {}),
    },
  });
  const finishRemoval = (hit: ContextAssignment): Resolution => {
    const hitCellNode = ctx.nodeById.get(hit.nodeId) ?? null;
    const ancestorNames = hitCellNode ? ancestorsOf(hitCellNode, byPath).map((n) => n.name) : [];
    const chain = hitCellNode ? [...ancestorNames, hitCellNode.name].join(" › ") : "";
    const iso = ctx.days.find((d) => d.index === dayIndex)?.iso ?? "";
    const readout = `Removing ${operator.displayName}'s ${hit.productName ?? "block"} block · ${chain} · ${iso} · ${hit.label}`;
    return { ok: true, resolved: { intent: "unassign", assignmentId: hit.id, readout } };
  };

  if (command.existing === null) {
    if (hits.length > 0) return askRemoveWhich(hits, false);
    const elsewhere = gatherElsewhereBlocks(operator.id, { startMin, endMin }, ctx);
    if (elsewhere.length === 0) {
      return {
        ok: false,
        question: {
          kind: "no_block",
          person: operator.displayName,
          cell: cell?.name ?? null,
          when: whenText,
        },
      };
    }
    return askRemoveWhich(elsewhere, true);
  }

  // An answer was given: look it up in the named cell's hits, then in the
  // elsewhere set (S49: "the resolver accepts it from the named cell or from
  // elsewhere").
  const wantedId = command.existing.assignmentId;
  const hitOnCell = hits.find((x) => x.id === wantedId) ?? null;
  if (hitOnCell) return finishRemoval(hitOnCell);

  const elsewhere = gatherElsewhereBlocks(operator.id, { startMin, endMin }, ctx);
  const hitElsewhere = elsewhere.find((x) => x.id === wantedId) ?? null;
  if (hitElsewhere) return finishRemoval(hitElsewhere);

  // Stale: the board changed under the question -- re-ask with whatever it
  // holds now, never guess.
  if (hits.length > 0) return askRemoveWhich(hits, false);
  if (elsewhere.length > 0) return askRemoveWhich(elsewhere, true);
  return {
    ok: false,
    question: { kind: "block_gone_remove", person: operator.displayName, cell: cell?.name ?? null },
  };
}

/** S49: the destination in the SENTENCE'S OWN WORDS, for the elsewhere
 *  question's `Move that one to ...?` -- never resolves the destination
 *  cell (that still happens below, only once a block has been chosen).
 *  `toPlace`'s words are joined with " in " (place order is "most specific
 *  first", the same order `toPlace` itself is in); the span, when given, is
 *  `formatSpan` -- the SAME helper the arrow uses -- joined with " · ". */
function buildDestinationText(command: MoveCommand): string {
  if (command.toPlace === null) {
    // A move naming no destination cell must give new hours -- the TEXT
    // grammar's own check (R-389, parseMoveRest's `no_move`). `decodeMove`
    // mirrors that check too (a model answer with both null is refused,
    // never reaches here), but this module never trusts a caller's shape:
    // review fix (reviewer, S49) -- an untrusted `Command` union member with
    // BOTH null must still get a Resolution back, never throw.
    if (command.span === null) return "the same place and hours";
    return formatSpan(command.span.start, command.span.end);
  }
  const placeText = command.toPlace.join(" in ");
  if (command.span !== null)
    return `${placeText} · ${formatSpan(command.span.start, command.span.end)}`;
  return placeText;
}

/**
 * S41-c — the move path: the current cell, the person (both shared), then
 * the day and the block -- found across the WHOLE DAY regardless of whether
 * the sentence gave hours (brief §4: "not the new hours — the new hours are
 * the destination"; RM9 pins a block found by the day even though the new
 * hours it is moved TO do not overlap it). Then the destination: `toPlace`
 * null resolves to R-385's own `retime` target; `toPlace` given resolves the
 * new cell by the shared cell step, checks the part is offered there, and
 * uses the sentence's new hours if given, else the block's own.
 */
function resolveMoveCommand(command: MoveCommand, ctx: ResolveContext): Resolution {
  const byPath = buildPathIndex(ctx.nodeById);

  // S58 (R-412, D132 item 1): `adjust` set alongside a destination cell, new
  // hours or a shift is a contradiction the grammar never produces (parse.ts's
  // own `bad_adjust` ParseFailure catches it first) -- a caller's bug, never
  // a crash, the same one-line role `expand_first` plays elsewhere.
  if (
    command.adjust !== null &&
    (command.toPlace !== null || command.span !== null || command.shift !== null)
  ) {
    return {
      ok: false,
      question: {
        kind: "bad_adjust",
        text: "An adjust cannot also carry a new cell, span or shift.",
      },
    };
  }

  // 1. The current cell -- OPTIONAL (S49: an empty place means "wherever
  // they are").
  let cell: Node | null = null;
  if (command.place.length > 0) {
    const cellResult = resolveCellStep(command.place, ctx, byPath);
    if (!cellResult.ok) return { ok: false, question: cellResult.question };
    cell = cellResult.cell;
  }

  // 2. The person (shared with assign/unassign).
  const personResult = resolvePersonStep(command.operator, ctx);
  if (!personResult.ok) return { ok: false, question: personResult.question };
  const operator = personResult.operator;

  // 3. The day, and the block(s) on the NAMED cell -- searched over the
  // WHOLE DAY. `hits` is empty by definition when no cell was named.
  const dayResolution = resolveDay(command.day, ctx);
  if (!dayResolution.ok) return { ok: false, question: dayResolution.question };
  const dayIndex = dayResolution.dayIndex;
  const dayStart = ctx.wallToOffset(dayIndex, 0);
  const dayEnd = ctx.wallToOffset(dayIndex, 24 * 60);
  const whenText = ctx.days.find((d) => d.index === dayIndex)?.iso ?? "";

  const hits =
    cell === null
      ? []
      : ctx.assignments.filter(
          (x) =>
            x.nodeId === cell!.id &&
            x.operatorId === operator.id &&
            ctx.overlaps({ startMin: dayStart, endMin: dayEnd }, x),
        );
  const blockCandidates = (): Candidate[] =>
    hits.map((x) => ({
      id: x.id,
      label: `${x.productName ?? "block"} ${x.label}`,
      word: "",
      part: x.productName,
    }));
  // S49: `wrongCellNamed` gates both the Question's `elsewhere: true` and
  // whether one block is taken without asking -- a cell WAS named and had
  // nothing (D125: "a move that would take its one block without asking
  // still asks when the block is not on the cell the sentence named"); an
  // empty place is never "wrong" (nothing was said to be wrong about), so
  // one block there is still taken, as every move with one block is.
  const askMoveWhich = (list: ContextAssignment[], fromElsewhere: boolean): Resolution => ({
    ok: false,
    question: {
      kind: "move_which",
      person: operator.displayName,
      cell: cell?.name ?? null,
      when: whenText,
      blocks: fromElsewhere ? elsewhereCandidates(list, ctx) : blockCandidates(),
      ...(fromElsewhere && cell !== null
        ? { elsewhere: true as const, destination: buildDestinationText(command) }
        : {}),
    },
  });

  let blk: ContextAssignment;
  if (hits.length === 0) {
    const elsewhere = gatherElsewhereBlocks(
      operator.id,
      { startMin: dayStart, endMin: dayEnd },
      ctx,
    );
    if (elsewhere.length === 0) {
      return {
        ok: false,
        question: {
          kind: "no_block",
          person: operator.displayName,
          cell: cell?.name ?? null,
          when: whenText,
        },
      };
    }
    const wrongCellNamed = cell !== null;
    if (!wrongCellNamed && elsewhere.length === 1 && command.existing === null) {
      blk = elsewhere[0];
    } else if (command.existing !== null) {
      const hit = elsewhere.find((x) => x.id === command.existing!.assignmentId) ?? null;
      if (!hit) return askMoveWhich(elsewhere, true); // stale: re-ask, never guess
      blk = hit;
    } else {
      return askMoveWhich(elsewhere, true);
    }
  } else if (hits.length === 1) {
    blk = hits[0];
  } else if (command.existing === null) {
    return askMoveWhich(hits, false);
  } else {
    const hit = hits.find((x) => x.id === command.existing!.assignmentId) ?? null;
    if (!hit) return askMoveWhich(hits, false); // the board changed: re-ask, never guess
    blk = hit;
  }

  // 4. The destination. S52-b (R-402): a shift name resolves to a band on
  // whichever cell the block ends up on -- the block's OWN cell for a move
  // in time, the NEW cell when one was also said (reviewer, blocker 3: a
  // `toPlace` set must not fall into the "keep the block's own hours"
  // branch and drop the shift silently -- it now resolves there too).

  let target: { kind: "retime" } | { kind: "move_cell" };
  let targetNodeId: string;
  let startMin: number;
  let endMin: number;
  let arrow: string;

  if (command.adjust !== null) {
    // S58 (R-412, D132 item 1): a re-time by ONE edge -- the top-of-function
    // guard already proved `toPlace`/`span`/`shift` are all null here. `by`
    // moves the named edge that many minutes from the block's OWN value;
    // `at` sets it to that wall-clock time on the BLOCK'S day (the day
    // already resolved above, dayIndex -- the same day the block was found
    // on, `wallToOffset`).
    const adjust: Adjust = command.adjust;
    let newStartMin = blk.startMin;
    let newEndMin = blk.endMin;
    const edgeMin =
      "by" in adjust
        ? (adjust.edge === "start" ? blk.startMin : blk.endMin) + adjust.by
        : ctx.wallToOffset(dayIndex, clockToMinuteOfDay(adjust.at));
    if (adjust.edge === "start") newStartMin = edgeMin;
    else newEndMin = edgeMin;

    const blockWords = `${blk.productName ?? "block"} ${blk.label}`;
    // Checks, in order (brief §1): inverted, too short, off the day.
    if (newEndMin <= newStartMin) {
      return {
        ok: false,
        question: { kind: "adjust_inverts", person: operator.displayName, block: blockWords },
      };
    }
    if (newEndMin - newStartMin < ctx.minDurationMinutes) {
      return {
        ok: false,
        question: {
          kind: "too_short",
          minutes: newEndMin - newStartMin,
          min: ctx.minDurationMinutes,
        },
      };
    }
    const dayStart = ctx.wallToOffset(dayIndex, 0);
    const dayEndBound = ctx.wallToOffset(dayIndex, 1440);
    if (newStartMin < dayStart || newEndMin > dayEndBound) {
      return {
        ok: false,
        question: { kind: "adjust_off_day", person: operator.displayName, block: blockWords },
      };
    }

    startMin = newStartMin;
    endMin = newEndMin;
    target = { kind: "retime" };
    targetNodeId = blk.nodeId;
    arrow = formatSpan(clockOfOffset(newStartMin, ctx), clockOfOffset(newEndMin, ctx));
  } else if (command.toPlace === null) {
    // Move in time only -- R-385's own retime target (`command.span` is
    // guaranteed non-null here whenever `shift` is null too: parseMoveRest's
    // own R-389/R-402 check never returns toPlace, span AND shift all null
    // together). S49: the target is the BLOCK's own cell, never the
    // sentence's (the block may have come from elsewhere) -- so the shift
    // pattern resolved is that cell's, not the named cell's.
    const blkCell = ctx.nodeById.get(blk.nodeId) ?? { id: blk.nodeId, name: blk.nodeId, path: "" };
    // S55 (R-404): move has no `start` field either -- same "cover" rule.
    const spanResult =
      command.shift !== null
        ? resolveShiftSpanStep(command.day, command.shift, blkCell, ctx, {
            givenStart: null,
            onMissingStart: "cover",
          })
        : resolveDaySpanStep(command.day, command.span!.start, command.span!.end, ctx);
    if (!spanResult.ok) return { ok: false, question: spanResult.question };
    startMin = spanResult.startMin;
    endMin = spanResult.endMin;
    target = { kind: "retime" };
    targetNodeId = blk.nodeId;
    arrow = spanResult.timeText;
  } else {
    const newCellResult = resolveCellStep(command.toPlace, ctx, byPath);
    if (!newCellResult.ok) return { ok: false, question: newCellResult.question };
    const newCell = newCellResult.cell;
    const offered = ctx.offeredAt(newCell.id);
    if (blk.productId === null || !offered.some((o) => o.id === blk.productId)) {
      return {
        ok: false,
        question: { kind: "not_offered", product: blk.productName ?? "", cell: newCell.name },
      };
    }
    if (command.shift !== null) {
      const spanResult = resolveShiftSpanStep(command.day, command.shift, newCell, ctx, {
        givenStart: null,
        onMissingStart: "cover",
      });
      if (!spanResult.ok) return { ok: false, question: spanResult.question };
      startMin = spanResult.startMin;
      endMin = spanResult.endMin;
      arrow = `${newCell.name} · ${spanResult.timeText}`;
    } else if (command.span !== null) {
      const spanResult = resolveDaySpanStep(command.day, command.span.start, command.span.end, ctx);
      if (!spanResult.ok) return { ok: false, question: spanResult.question };
      startMin = spanResult.startMin;
      endMin = spanResult.endMin;
      arrow = `${newCell.name} · ${spanResult.timeText}`;
    } else {
      startMin = blk.startMin;
      endMin = blk.endMin;
      arrow = `${newCell.name} · ${blk.label}`;
    }
    target = { kind: "move_cell" };
    targetNodeId = newCell.id;
  }

  // Readout -- the chain names the BLOCK's own cell (S49: it may have come
  // from elsewhere, never the sentence's named cell).
  const blkCellNode = ctx.nodeById.get(blk.nodeId) ?? null;
  const ancestorNames = blkCellNode ? ancestorsOf(blkCellNode, byPath).map((n) => n.name) : [];
  const chain = blkCellNode ? [...ancestorNames, blkCellNode.name].join(" › ") : "";
  const readout = `Moving ${operator.displayName}'s ${blk.productName ?? "block"} block · ${chain} · ${whenText} · ${blk.label} → ${arrow}`;

  return {
    ok: true,
    resolved: {
      intent: "move",
      assignmentId: blk.id,
      nodeId: targetNodeId,
      operatorId: operator.id,
      productId: blk.productId ?? "",
      range: { startMin, endMin },
      target,
      readout,
    },
  };
}

/**
 * S58 (R-415, D132 item 4): "make the Housing A job on Cell 1 4 people" --
 * one existing write, the run's own planned headcount. Cell, part (shared,
 * `resolveCellStep`/`resolvePartStep`), then the window (the span or shift
 * when given, else the whole day -- `resolveWindowForCell`, the same helper
 * `expandEveryoneUnassign`/`expandEveryoneMove` narrow a cell's window with),
 * then the run: none/several is `no_job`/`which_job` (shared with "the job's
 * hours", `findJobRuns`/`jobRunsQuestion`), exactly one is the write. Nothing
 * here checks `command.headcount` beyond the grammar's own 1-99.
 */
function resolveHeadcountCommand(command: HeadcountCommand, ctx: ResolveContext): Resolution {
  const byPath = buildPathIndex(ctx.nodeById);

  const cellResult = resolveCellStep(command.place, ctx, byPath, command.product);
  if (!cellResult.ok) return { ok: false, question: cellResult.question };
  const cell = cellResult.cell;

  const partResult = resolvePartStep(command.product, cell, ctx);
  if (!partResult.ok) return { ok: false, question: partResult.question };
  const product = partResult.product;

  const dayResult = resolveDay(command.day, ctx);
  if (!dayResult.ok) return { ok: false, question: dayResult.question };
  const dayIndex = dayResult.dayIndex;
  const whenIso = ctx.days.find((d) => d.index === dayIndex)?.iso ?? "";

  const window = resolveWindowForCell(
    command.day,
    command.span,
    command.shift,
    dayIndex,
    cell,
    ctx,
  );
  if (!window.ok) return window;

  const runsHere = findJobRuns(cell, product, window.startMin, window.endMin, ctx);
  const q = jobRunsQuestion(runsHere, product, cell, whenIso);
  if (q !== null) return { ok: false, question: q };
  const run = runsHere[0];

  const ancestorNames = ancestorsOf(cell, byPath).map((n) => n.name);
  const chain = [...ancestorNames, cell.name].join(" › ");
  const readout = `${product.name} · ${chain} · ${whenIso} · ${run.span} · ${command.headcount} people`;

  return {
    ok: true,
    resolved: {
      intent: "headcount",
      runId: run.id,
      nodeId: cell.id,
      headcount: command.headcount,
      readout,
    },
  };
}

/** Order of resolution: cell, then part, then (assign only) person, then day
 *  and span, then the job/run/own-block question(s) (brief §5, extended by
 *  §3 for `book`, and S41-b for `unassign`). One question at a time.
 *  Dispatches on `command.intent`; the assign and book paths' own meaning
 *  are untouched by this dispatch.
 *
 * Overloaded (not just typed as `Command -> Resolution`) so a caller holding
 * a concrete `AssignCommand`, `BookCommand` or `UnassignCommand` — every
 * existing test's `cmd()`/`bookCmd()` fixture, for one — gets back the
 * narrower result type without a cast; only `CommandBar`, which holds the
 * `Command` union, sees the full `Resolution`.
 */
export function resolveCommand(
  command: AssignCommand,
  ctx: ResolveContext,
): { ok: true; resolved: ResolvedCommand } | { ok: false; question: Question };
export function resolveCommand(
  command: BookCommand,
  ctx: ResolveContext,
): { ok: true; resolved: ResolvedBook } | { ok: false; question: Question };
export function resolveCommand(
  command: UnassignCommand,
  ctx: ResolveContext,
): { ok: true; resolved: ResolvedUnassign } | { ok: false; question: Question };
export function resolveCommand(
  command: MoveCommand,
  ctx: ResolveContext,
): { ok: true; resolved: ResolvedMove } | { ok: false; question: Question };
export function resolveCommand(
  command: HeadcountCommand,
  ctx: ResolveContext,
): { ok: true; resolved: ResolvedHeadcount } | { ok: false; question: Question };
export function resolveCommand(command: Command, ctx: ResolveContext): Resolution;
export function resolveCommand(command: Command, ctx: ResolveContext): Resolution {
  // S50 (brief §2 item 4, R-398): a several is read but not yet run -- the
  // bar's one-yes-for-the-lot confirmation is the next stage after this one.
  if (command.intent === "several") {
    return { ok: false, question: { kind: "several_unsupported", count: command.commands.length } };
  }
  // S55 (D130 item 1): a `BoardCommand` (`replace`/`swap`/`copy`) must go
  // through `expandCommand` first -- it is never itself a single write. A
  // caller that skips that step gets a question, never a crash (the same
  // role `several_unsupported` plays above). Note this is NOT how `EVERYONE`
  // or an absence `until` on an ordinary single is refused: those reach here
  // unexpanded too on a caller's bug, and fail naturally -- `resolvePersonStep`
  // finds no operator literally named "everyone", and `until` is simply never
  // read by `resolveUnassignCommand` (§4, pinned by PT tests).
  // S58 (R-413, D132 item 2): `split` joins the board-answered group --
  // it too is never a single write, `expandCommand` always writes its move
  // and its assign first.
  if (
    command.intent === "replace" ||
    command.intent === "swap" ||
    command.intent === "copy" ||
    command.intent === "split"
  ) {
    return { ok: false, question: { kind: "expand_first", intent: command.intent } };
  }
  if (command.intent === "book") return resolveBookCommand(command, ctx);
  if (command.intent === "unassign") return resolveUnassignCommand(command, ctx);
  if (command.intent === "move") return resolveMoveCommand(command, ctx);
  if (command.intent === "headcount") return resolveHeadcountCommand(command, ctx);
  return resolveAssignCommand(command, ctx);
}

// ---------------------------------------------------------------------------
// S55 (R-406 to R-410, D130): `expandCommand` -- a board-answered sentence
// (`replace`/`swap`/`copy`, `everyone` on a removal or a move, an absence's
// `until`) turns into an ordinary `several` of `SingleCommand`s, in BOARD
// ORDER, with `existing`/`attach` already filled from the blocks it found.
// Nothing here WRITES anything or resolves the commands it builds -- the
// bar's lot does that, unchanged, with `resolveCommand` (D127).
// ---------------------------------------------------------------------------

export type Expansion =
  | {
      ok: true;
      // S58 (R-415, D132 item 4): `HeadcountCommand` is never itself part of
      // a lot (never wrapped in `several`), but `expandCommand` still hands
      // one back UNCHANGED (never a lot member, always the caller's own
      // single write) -- so it must be a member here too, not just of
      // `Command`.
      command: SingleCommand | SeveralCommand | HeadcountCommand;
    }
  | { ok: false; question: Question };

/** R-407: the reserved operator word, matched the same case/whitespace-blind
 *  way every other word in this module is (`normalizeForMatch`) -- the
 *  parser already canonicalizes a matched sentence's operator to `EVERYONE`
 *  exactly (EV4-EV6), but this module trusts nothing of a caller's shape. */
function isEveryone(operator: string): boolean {
  return normalizeForMatch(operator) === EVERYONE;
}

/** How a written command names a PERSON (brief §3): the operator's own
 *  `employeeRef` when it has one, else `displayName` -- whichever the lot's
 *  own `resolvePersonStep` will find again. */
function personWords(op: OperatorLike): string {
  return op.employeeRef ?? op.displayName;
}

/** How a written command names a CELL (brief §3): `[cell.name, nearest
 *  ancestor's name]` -- enough for `resolveCellStep`'s own qualifier step to
 *  land on this exact cell again even when another cell shares its bare
 *  name (S49's own "two Cell 1s" case). A root cell with no ancestor at all
 *  names itself alone. */
function cellWordsOf(cell: Node, byPath: Map<string, Node>): string[] {
  const ancestors = ancestorsOf(cell, byPath);
  const nearest = ancestors[ancestors.length - 1];
  return nearest ? [cell.name, nearest.name] : [cell.name];
}

/** How a written command names a DAY (brief §3): `{ kind: "date", iso }` off
 *  `ctx.days` for the already-resolved `dayIndex` -- never a relative word
 *  (today/tomorrow), so the built command means the same day regardless of
 *  when the lot actually runs it. */
function dayWordForIndex(dayIndex: number, ctx: ResolveContext): DayWord {
  return { kind: "date", iso: ctx.days.find((d) => d.index === dayIndex)?.iso ?? "" };
}

/** How a written command names HOURS (brief §3): `ctx.wallOf` of a real
 *  minute offset, read back as a plain `ClockTime`. */
function clockOfOffset(offsetMin: number, ctx: ResolveContext): ClockTime {
  const { minuteOfDay } = ctx.wallOf(offsetMin);
  return { hour: Math.floor(minuteOfDay / 60), minute: minuteOfDay % 60 };
}

function hoursOfBlock(
  startMin: number,
  endMin: number,
  ctx: ResolveContext,
): { start: ClockTime; end: ClockTime } {
  return { start: clockOfOffset(startMin, ctx), end: clockOfOffset(endMin, ctx) };
}

/**
 * F-152: the day a block-derived MINUTE OFFSET (a remainder's own start, a
 * split's own edge -- never the sentence's own already-checked `resolveDay`
 * result) falls on, guarded -- `dayWordForIndex` alone would silently write
 * `iso: ""` for a day `ctx.days` carries no row for (the exact shape the
 * John Kim bug's item 4 catches: a kept part dated off the board's own
 * window). Returns `day_off_board` naming THAT day's own ISO instead, never
 * "today"/"yesterday" (there is no relative word for a day reached by
 * walking a block's own minutes) -- computed off any day already on the
 * board via `addDaysToIso`, the same pure day-arithmetic `resolveWeekDays`
 * already uses for the identical gap, so the person's "Show that day"
 * button lands on the right date. `dayIndex` is resolved through
 * `ctx.wallOf`, never called with a raw offset. */
function dayWordOrOffBoard(
  dayIndex: number,
  ctx: ResolveContext,
): { ok: true; day: DayWord } | { ok: false; question: Question } {
  const row = ctx.days.find((d) => d.index === dayIndex);
  if (row) return { ok: true, day: { kind: "date", iso: row.iso } };
  const ref = ctx.days[0] as BoardDay | undefined;
  const iso = ref ? addDaysToIso(ref.iso, dayIndex - ref.index) : "";
  return { ok: false, question: { kind: "day_off_board", text: iso } };
}

/**
 * F-152 (`expandEveryoneUnassign`'s move branch, `expandSplit`'s first
 * half): the day and same-day clock pair a REMAINDER piece of a block --
 * `keptStart` to `keptEnd`, real continuous minutes, never a sentence's own
 * span -- renders as. Dated by `keptStart`'s OWN day (`ctx.wallOf`), never
 * the day the sentence named (the John Kim bug: a block that starts the day
 * BEFORE the window it is cleared from kept its start's own clock reading
 * but the sentence's own day, so `resolveDaySpanStep` read it as negative).
 * The piece's own minutes read through `copyableSpan`'s already-proven
 * single-day/DAY_END/not-representable rule for the END. `ok: false,
 * question: null` means genuinely not representable (the piece crosses into
 * a later day's daytime hours) -- the caller asks `split_needed` itself,
 * never a guess and never a silent skip that loses the block. */
function remainderDayAndSpan(
  keptStart: number,
  keptEnd: number,
  ctx: ResolveContext,
):
  | { ok: true; day: DayWord; span: { start: ClockTime; end: ClockTime } }
  | { ok: false; question: Question | null } {
  const span = copyableSpan(keptStart, keptEnd, ctx);
  if (span === null) return { ok: false, question: null };
  const dayResult = dayWordOrOffBoard(ctx.wallOf(keptStart).dayIndex, ctx);
  if (!dayResult.ok) return dayResult;
  return {
    ok: true,
    day: dayResult.day,
    span: { start: clockFromMinuteOfDay(span.startMOD), end: clockFromMinuteOfDay(span.endMOD) },
  };
}

/**
 * F-152 follow-up (the maintainer, 16 Sept: a replace/swap on a night-shift
 * block must WORK, not refuse -- "cover Sam with Tom" on Shift 3 is the
 * everyday case, not an edge case). A block not representable as one day's
 * clock pair may still be EXACTLY one band of its own cell's shift pattern,
 * on the day it itself starts -- `ctx.shiftsAt`'s own bands, whose `endMin`
 * already carries an overnight band past 1440 (R-402/D128 §19.99), rendered
 * onto that day through the SAME `ctx.wallToOffset` the board's own blocks
 * are. An EXACT match only (both ends) -- never "close enough", never a
 * guess at which band a block that merely overlaps one was meant to be. */
function matchingShiftBandName(
  cell: Node,
  startDayIndex: number,
  startMin: number,
  endMin: number,
  ctx: ResolveContext,
): string | null {
  for (const band of ctx.shiftsAt(cell.id)) {
    if (
      ctx.wallToOffset(startDayIndex, band.startMin) === startMin &&
      ctx.wallToOffset(startDayIndex, band.endMin) === endMin
    ) {
      return band.name;
    }
  }
  return null;
}

/**
 * F-152 follow-up: how `expandReplace`/`expandSwap` re-describe an existing
 * block that is being carried whole onto a new person -- `remainderDayAndSpan`
 * first (the common case: a same-day block, `hours` set, `shift` null,
 * unchanged from before); when that block is genuinely not representable as
 * one day's clock pair, `matchingShiftBandName` next -- the grammar already
 * carries an overnight span this way (an assign's own `shift` clause,
 * R-402's "shift stands in for hours, never alongside them" invariant, so
 * `hours` is null here, mirrored exactly). `ok: false, question: null` means
 * neither: the caller asks `across_midnight` naming the block's own real
 * hours, never a guess and never a silently wrong write. */
function renderBlockForRebuild(
  x: ContextAssignment,
  xCell: Node,
  ctx: ResolveContext,
):
  | {
      ok: true;
      day: DayWord;
      hours: { start: ClockTime; end: ClockTime } | null;
      shift: string | null;
    }
  | { ok: false; question: Question | null } {
  const rendered = remainderDayAndSpan(x.startMin, x.endMin, ctx);
  if (rendered.ok) return { ok: true, day: rendered.day, hours: rendered.span, shift: null };
  if (rendered.question !== null) return rendered;
  const startDayIndex = ctx.wallOf(x.startMin).dayIndex;
  const bandName = matchingShiftBandName(xCell, startDayIndex, x.startMin, x.endMin, ctx);
  if (bandName === null) return { ok: false, question: null };
  const dayResult = dayWordOrOffBoard(startDayIndex, ctx);
  if (!dayResult.ok) return dayResult;
  return { ok: true, day: dayResult.day, hours: null, shift: bandName };
}

/**
 * F-152 review follow-up (the maintainer, 16 Sept): `expandEveryoneUnassign`
 * refuses a block that crosses BOTH edges of its window for two DIFFERENT
 * reasons, and only one of them makes the WINDOW's own bounds a true,
 * answerable message -- the sentence's own span sitting strictly inside an
 * otherwise same-day block (EX4: "clear ... from 10 to 12" over an
 * 08:00-16:00 block; "say a span that reaches one end" is real, sound
 * advice there). When the block ITSELF cannot be written as one day's clock
 * pair (`copyableSpan` on its own real minutes, null), the window's bounds
 * are beside the point -- a whole-day window's own "00:00-00:00" is not
 * even true, and "say a span that reaches one end" cannot be answered (the
 * block crosses TWO calendar days no span fixes) -- `across_midnight`,
 * naming the block's own real hours, is asked instead. */
function crossesBothEdgesQuestion(
  op: OperatorLike,
  x: ContextAssignment,
  xCell: Node,
  window: { startMin: number; endMin: number },
  ctx: ResolveContext,
): { ok: false; question: Question } {
  const block = `${x.productName ?? "block"} ${x.label}`;
  if (copyableSpan(x.startMin, x.endMin, ctx) === null) {
    return {
      ok: false,
      question: {
        kind: "across_midnight",
        person: op.displayName,
        cell: xCell.name,
        block,
        hours: formatSpan(clockOfOffset(x.startMin, ctx), clockOfOffset(x.endMin, ctx)),
      },
    };
  }
  return {
    ok: false,
    question: {
      kind: "split_needed",
      person: op.displayName,
      cell: xCell.name,
      block,
      span: formatSpan(clockOfOffset(window.startMin, ctx), clockOfOffset(window.endMin, ctx)),
    },
  };
}

function operatorById(id: string | null, ctx: ResolveContext): OperatorLike | null {
  if (id === null) return null;
  return ctx.operators.find((o) => o.id === id) ?? null;
}

function wrapMany(commands: SingleCommand[]): Expansion {
  if (commands.length === 1) return { ok: true, command: commands[0] };
  return { ok: true, command: { intent: "several", commands } };
}

/**
 * R-407 (D130 item 5): the place a `everyone` sentence names, gathered as
 * CELLS -- the sentence's own words matched against every node (not just
 * `ctx.cells`, since "Line 1" is never itself a track row), then every track
 * cell AT OR BELOW the match (a line or area names every cell under it, by
 * path prefix); an empty place is every cell the board shows. Also `copy`'s
 * own place, D130 item 4: the same rule, word for word.
 *
 * Reviewer fix (S59 review, D133 item 1): the first-word dead end below used
 * to build its OWN bare `unknown` question, never offering a suggestion --
 * unlike `resolveCellStep`'s identical dead end, so "copy Sell 1 to
 * tomorrow" (and the EVERYONE reading of unassign/move) got a dead end with
 * no nearest-name buttons while the same typo on an ordinary assign already
 * did. Routed through `nodeSuggestions` scoped to `allNodes` -- the SAME
 * pool searched two lines below (never `ctx.cells`: a line or area is a
 * legitimate match for THIS function, so it must be a legitimate suggestion
 * too, pinned NN10/NN10 twin).
 */
function resolveEveryonePlaceCells(
  place: readonly string[],
  ctx: ResolveContext,
  byPath: Map<string, Node>,
): { ok: true; cells: Node[] } | { ok: false; question: Question } {
  if (place.length === 0) return { ok: true, cells: [...ctx.cells] as Node[] };

  const allNodes = [...ctx.nodeById.values()];
  const firstWord = place[0];
  let candidates = matchName(firstWord, allNodes, (n) => n.name);
  if (candidates.length === 0) {
    // D133 item 1 (R-418): the EVERYONE/`copy` place word gets the same
    // nearest-names offer as an ordinary `resolveCellStep` dead end -- the
    // suggestion pool is `allNodes`, the SAME pool searched two lines above
    // (never `ctx.cells`: a suggestion of a line or area could never
    // re-resolve through this function's own first pass otherwise).
    const suggestions = nodeSuggestions(firstWord, allNodes, byPath);
    return {
      ok: false,
      question:
        suggestions.length > 0
          ? { kind: "unknown", field: "place", text: firstWord, suggestions }
          : { kind: "unknown", field: "place", text: firstWord },
    };
  }
  for (const qualifier of place.slice(1)) {
    const filtered = filterByQualifier(candidates, qualifier, byPath);
    if (filtered.length === 0) {
      const elsewhere = candidates.map((c) => ({
        id: c.id,
        label: placeLabel(c, byPath),
        word: c.name,
      }));
      return {
        ok: false,
        question: { kind: "place_mismatch", cell: firstWord, qualifier, elsewhere },
      };
    }
    candidates = filtered;
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      question: {
        kind: "ambiguous",
        field: "place",
        text: firstWord,
        candidates: candidates.map((c) => ({
          id: c.id,
          label: placeLabel(c, byPath),
          word: c.name,
        })),
      },
    };
  }
  const node = candidates[0];
  if (ctx.cells.some((c) => c.id === node.id)) return { ok: true, cells: [node as Node] };
  const below = ctx.cells.filter(
    (c) => c.path === node.path || c.path.startsWith(`${node.path}.`),
  ) as Node[];
  return { ok: true, cells: below };
}

/** R-407 (D130 item 5): the window a `everyone` removal/move gathers over,
 *  for ONE cell -- the shift (through THAT cell's own pattern), the span, or
 *  the whole day. Never asks `no_start` (`onMissingStart: "cover"` -- a
 *  removal/move, same as the ordinary unassign/move paths). */
function resolveWindowForCell(
  day: DayWord | null,
  span: { start: ClockTime; end: ClockTime } | null,
  shift: string | null,
  dayIndex: number,
  cell: Node,
  ctx: ResolveContext,
): { ok: true; startMin: number; endMin: number } | { ok: false; question: Question } {
  if (shift !== null) {
    const spanResult = resolveShiftSpanStep(day, shift, cell, ctx, {
      givenStart: null,
      onMissingStart: "cover",
    });
    if (!spanResult.ok) return spanResult;
    return { ok: true, startMin: spanResult.startMin, endMin: spanResult.endMin };
  }
  if (span !== null) {
    return {
      ok: true,
      startMin: ctx.wallToOffset(dayIndex, clockToMinuteOfDay(span.start)),
      endMin: ctx.wallToOffset(dayIndex, clockToMinuteOfDay(span.end)),
    };
  }
  return {
    ok: true,
    startMin: ctx.wallToOffset(dayIndex, 0),
    endMin: ctx.wallToOffset(dayIndex, 1440),
  };
}

/**
 * R-407 / D130 item 5, §3.1: every block on the gathered cells overlapping
 * each cell's own window, in `ctx.assignments`' own order -- fully inside
 * becomes an `unassign`, across exactly one edge becomes a `move` of the
 * part OUTSIDE the window (`toPlace: null`), across BOTH edges is
 * `split_needed` (nothing built). No blocks at all is `nothing_to_do`.
 */
function expandEveryoneUnassign(command: UnassignCommand, ctx: ResolveContext): Expansion {
  const byPath = buildPathIndex(ctx.nodeById);
  const cellsResult = resolveEveryonePlaceCells(command.place, ctx, byPath);
  if (!cellsResult.ok) return cellsResult;
  const targetCells = cellsResult.cells;

  const dayResult = resolveDay(command.day, ctx);
  if (!dayResult.ok) return { ok: false, question: dayResult.question };
  const dayIndex = dayResult.dayIndex;

  const windows = new Map<string, { startMin: number; endMin: number }>();
  for (const cell of targetCells) {
    const w = resolveWindowForCell(command.day, command.span, command.shift, dayIndex, cell, ctx);
    if (!w.ok) return w;
    windows.set(cell.id, { startMin: w.startMin, endMin: w.endMin });
  }
  const cellIds = new Set(targetCells.map((c) => c.id));

  const commands: SingleCommand[] = [];
  for (const x of ctx.assignments) {
    if (!cellIds.has(x.nodeId)) continue;
    const window = windows.get(x.nodeId);
    if (!window || !ctx.overlaps(window, x)) continue;
    const op = operatorById(x.operatorId, ctx);
    if (op === null) continue; // a departed person's block has no words to name it by -- skipped
    const xCell = ctx.nodeById.get(x.nodeId) as Node;
    const insideStart = x.startMin >= window.startMin;
    const insideEnd = x.endMin <= window.endMin;
    if (insideStart && insideEnd) {
      commands.push({
        intent: "unassign",
        operator: personWords(op),
        place: cellWordsOf(xCell, byPath),
        day: dayWordForIndex(dayIndex, ctx),
        span: hoursOfBlock(x.startMin, x.endMin, ctx),
        existing: { kind: "remove", assignmentId: x.id },
        shift: null,
        until: null,
      });
    } else if (insideStart !== insideEnd) {
      // F-152 items 1/2/4: the kept (outside-window) part is dated by the
      // day IT starts on, never `dayIndex` (the sentence's own day) -- a
      // block that starts the day before (kept 02:00-DAY_END, item 1) or
      // ends the day after (kept 00:00-06:00 on tomorrow, item 2) a
      // same-day `today` window used to read as a negative span on the
      // sentence's own day; a kept day off the board asks `day_off_board`
      // naming its own ISO (item 4) instead of the old bare `iso: ""`.
      const outsideStart = insideStart ? window.endMin : x.startMin;
      const outsideEnd = insideStart ? x.endMin : window.startMin;
      const remainder = remainderDayAndSpan(outsideStart, outsideEnd, ctx);
      if (!remainder.ok) {
        if (remainder.question !== null) return { ok: false, question: remainder.question };
        // Item 3 / the review follow-up: genuinely not representable
        // (crosses into a later day's daytime hours) -- the same question
        // the both-edges case just below asks: `across_midnight`, naming
        // the block's own real hours, when the BLOCK itself (not just this
        // kept piece) cannot be written as one day's clock pair.
        return crossesBothEdgesQuestion(op, x, xCell, window, ctx);
      }
      commands.push({
        intent: "move",
        operator: personWords(op),
        place: cellWordsOf(xCell, byPath),
        toPlace: null,
        day: remainder.day,
        span: remainder.span,
        existing: { kind: "move", assignmentId: x.id },
        shift: null,
        adjust: null,
      });
    } else {
      return crossesBothEdgesQuestion(op, x, xCell, window, ctx);
    }
  }
  if (commands.length === 0) {
    const iso = ctx.days.find((d) => d.index === dayIndex)?.iso ?? "";
    const label = command.place.length > 0 ? command.place[0] : "The board";
    return {
      ok: false,
      question: { kind: "nothing_to_do", text: `${label} has nobody on it ${iso}.` },
    };
  }
  if (commands.length > LOT_CEILING) {
    return {
      ok: false,
      question: { kind: "lot_too_big", count: commands.length, max: LOT_CEILING },
    };
  }
  return wrapMany(commands);
}

/**
 * R-407 / D130 item 5, §3.2: the same gathering as `expandEveryoneUnassign`
 * (place, day, window), each overlapping block WHOLE (never clipped -- a
 * move relocates, it does not split) becomes a `move`: `toPlace` given ->
 * the sentence's own words, `span`/`shift` null (each block keeps its own
 * hours on the new cell); `toPlace` null (a re-time of everyone) -> the
 * sentence's own `span`/`shift` carried straight onto every block.
 */
function expandEveryoneMove(command: MoveCommand, ctx: ResolveContext): Expansion {
  const byPath = buildPathIndex(ctx.nodeById);
  const cellsResult = resolveEveryonePlaceCells(command.place, ctx, byPath);
  if (!cellsResult.ok) return cellsResult;
  const targetCells = cellsResult.cells;

  const dayResult = resolveDay(command.day, ctx);
  if (!dayResult.ok) return { ok: false, question: dayResult.question };
  const dayIndex = dayResult.dayIndex;

  const windows = new Map<string, { startMin: number; endMin: number }>();
  for (const cell of targetCells) {
    const w = resolveWindowForCell(command.day, command.span, command.shift, dayIndex, cell, ctx);
    if (!w.ok) return w;
    windows.set(cell.id, { startMin: w.startMin, endMin: w.endMin });
  }
  const cellIds = new Set(targetCells.map((c) => c.id));

  const commands: SingleCommand[] = [];
  for (const x of ctx.assignments) {
    if (!cellIds.has(x.nodeId)) continue;
    const window = windows.get(x.nodeId);
    if (!window || !ctx.overlaps(window, x)) continue;
    const op = operatorById(x.operatorId, ctx);
    if (op === null) continue;
    const xCell = ctx.nodeById.get(x.nodeId) as Node;
    commands.push({
      intent: "move",
      operator: personWords(op),
      place: cellWordsOf(xCell, byPath),
      toPlace: command.toPlace,
      day: dayWordForIndex(dayIndex, ctx),
      span: command.toPlace === null ? command.span : null,
      existing: { kind: "move", assignmentId: x.id },
      shift: command.toPlace === null ? command.shift : null,
      adjust: null,
    });
  }
  if (commands.length === 0) {
    const iso = ctx.days.find((d) => d.index === dayIndex)?.iso ?? "";
    const label = command.place.length > 0 ? command.place[0] : "The board";
    return {
      ok: false,
      question: { kind: "nothing_to_do", text: `${label} has nobody on it ${iso}.` },
    };
  }
  if (commands.length > LOT_CEILING) {
    return {
      ok: false,
      question: { kind: "lot_too_big", count: commands.length, max: LOT_CEILING },
    };
  }
  return wrapMany(commands);
}

/** R-406, §3.3/3.4's shared window: the shift (against `cell` when named,
 *  else -- S49's own idea -- gathered from `gatherFor`'s whole-day blocks
 *  and resolved against THOSE blocks' cells in board order), the span, or
 *  the whole day. */
function resolveReplaceOrSwapWindow(
  day: DayWord | null,
  span: { start: ClockTime; end: ClockTime } | null,
  shift: string | null,
  dayIndex: number,
  cell: Node | null,
  gatherFor: OperatorLike,
  ctx: ResolveContext,
): { ok: true; startMin: number; endMin: number } | { ok: false; question: Question } {
  if (shift !== null) {
    if (cell !== null) {
      const spanResult = resolveShiftSpanStep(day, shift, cell, ctx, {
        givenStart: null,
        onMissingStart: "cover",
      });
      if (!spanResult.ok) return spanResult;
      return { ok: true, startMin: spanResult.startMin, endMin: spanResult.endMin };
    }
    const wholeDayStart = ctx.wallToOffset(dayIndex, 0);
    const wholeDayEnd = ctx.wallToOffset(dayIndex, 1440);
    const wholeDayBlocks = gatherElsewhereBlocks(
      gatherFor.id,
      { startMin: wholeDayStart, endMin: wholeDayEnd },
      ctx,
    );
    if (wholeDayBlocks.length === 0) {
      return {
        ok: false,
        question: {
          kind: "no_block",
          person: gatherFor.displayName,
          cell: null,
          when: ctx.days.find((d) => d.index === dayIndex)?.iso ?? "",
        },
      };
    }
    const spanResult = resolveShiftAgainstBlocks(day, shift, wholeDayBlocks, ctx);
    if (!spanResult.ok) return spanResult;
    return { ok: true, startMin: spanResult.startMin, endMin: spanResult.endMin };
  }
  if (span !== null) {
    return {
      ok: true,
      startMin: ctx.wallToOffset(dayIndex, clockToMinuteOfDay(span.start)),
      endMin: ctx.wallToOffset(dayIndex, clockToMinuteOfDay(span.end)),
    };
  }
  return {
    ok: true,
    startMin: ctx.wallToOffset(dayIndex, 0),
    endMin: ctx.wallToOffset(dayIndex, 1440),
  };
}

/** R-406, §3.3: A's blocks in the window become a removal-then-assign pair
 *  each, B taking A's block's own cell/part/hours/attachment. All removals
 *  first, then all assigns. */
function expandReplace(command: ReplaceCommand, ctx: ResolveContext): Expansion {
  const byPath = buildPathIndex(ctx.nodeById);
  const aResult = resolvePersonStep(command.operator, ctx);
  if (!aResult.ok) return { ok: false, question: aResult.question };
  const bResult = resolvePersonStep(command.with, ctx);
  if (!bResult.ok) return { ok: false, question: bResult.question };
  const a = aResult.operator;
  const b = bResult.operator;
  if (a.id === b.id) {
    return {
      ok: false,
      question: {
        kind: "nothing_to_do",
        text: `${a.displayName} cannot cover for ${a.displayName}`,
      },
    };
  }

  const dayResult = resolveDay(command.day, ctx);
  if (!dayResult.ok) return { ok: false, question: dayResult.question };
  const dayIndex = dayResult.dayIndex;

  let cell: Node | null = null;
  if (command.place.length > 0) {
    const cellResult = resolveCellStep(command.place, ctx, byPath);
    if (!cellResult.ok) return { ok: false, question: cellResult.question };
    cell = cellResult.cell;
  }

  const window = resolveReplaceOrSwapWindow(
    command.day,
    command.span,
    command.shift,
    dayIndex,
    cell,
    a,
    ctx,
  );
  if (!window.ok) return window;
  const { startMin, endMin } = window;

  const blocks = ctx.assignments.filter(
    (x) =>
      x.operatorId === a.id &&
      (cell === null || x.nodeId === cell.id) &&
      ctx.overlaps({ startMin, endMin }, x),
  );
  if (blocks.length === 0) {
    return {
      ok: false,
      question: {
        kind: "no_block",
        person: a.displayName,
        cell: cell?.name ?? null,
        when: ctx.days.find((d) => d.index === dayIndex)?.iso ?? "",
      },
    };
  }

  const removals: SingleCommand[] = [];
  const assigns: SingleCommand[] = [];
  for (const x of blocks) {
    const xCell = ctx.nodeById.get(x.nodeId) as Node;
    // F-152 follow-up: `blocks` is gathered by OVERLAP with the window, the
    // same as `expandEveryoneUnassign` -- a leftover block only partly
    // inside it (an overnight shift's own band, or a plain leftover that
    // started the day before) is taken WHOLE, same as always, but dated by
    // the day IT starts on, never `dayIndex` (the sentence's own day); the
    // exact "22:00 to 06:00 on a single day" negative span the John Kim bug
    // shipped from otherwise. A night-shift block ("cover Sam with Tom" on
    // Shift 3 -- the everyday case, not an edge case) is not representable
    // as a clock pair at all, but IS exactly one band of its own cell's
    // pattern -- `renderBlockForRebuild` hands back a `shift` name instead
    // of `hours` for it (the removal never needs either, `existing`'s own
    // assignment id finds it). Only a block matching NEITHER shape asks
    // `across_midnight`, naming the block's own real hours -- never the
    // window's bounds (`expandReplace` never clips, so there is no "the
    // sentence's own span crossed a same-day block" reading here at all).
    const rendered = renderBlockForRebuild(x, xCell, ctx);
    if (!rendered.ok) {
      if (rendered.question !== null) return { ok: false, question: rendered.question };
      return {
        ok: false,
        question: {
          kind: "across_midnight",
          person: a.displayName,
          cell: xCell.name,
          block: `${x.productName ?? "block"} ${x.label}`,
          hours: formatSpan(clockOfOffset(x.startMin, ctx), clockOfOffset(x.endMin, ctx)),
        },
      };
    }
    removals.push({
      intent: "unassign",
      operator: personWords(a),
      place: cellWordsOf(xCell, byPath),
      day: rendered.day,
      span: rendered.hours,
      existing: { kind: "remove", assignmentId: x.id },
      shift: null,
      until: null,
    });
    assigns.push({
      intent: "assign",
      operator: personWords(b),
      product: x.productName ?? "",
      place: cellWordsOf(xCell, byPath),
      day: rendered.day,
      start: rendered.hours?.start ?? null,
      end: rendered.hours?.end ?? null,
      attach: x.runId !== null ? { kind: "run", runId: x.runId } : { kind: "direct" },
      existing: null,
      shift: rendered.shift,
    });
  }
  const commands = [...removals, ...assigns];
  if (commands.length > LOT_CEILING) {
    return {
      ok: false,
      question: { kind: "lot_too_big", count: commands.length, max: LOT_CEILING },
    };
  }
  return wrapMany(commands);
}

/** R-406, §3.4: each of A and B must have EXACTLY one block in the window;
 *  four commands cross their blocks -- remove A's, remove B's, assign A onto
 *  B's old block, assign B onto A's old block. */
function expandSwap(command: SwapCommand, ctx: ResolveContext): Expansion {
  const byPath = buildPathIndex(ctx.nodeById);
  const aResult = resolvePersonStep(command.operator, ctx);
  if (!aResult.ok) return { ok: false, question: aResult.question };
  const bResult = resolvePersonStep(command.other, ctx);
  if (!bResult.ok) return { ok: false, question: bResult.question };
  const a = aResult.operator;
  const b = bResult.operator;
  if (a.id === b.id) {
    return {
      ok: false,
      question: {
        kind: "nothing_to_do",
        text: `${a.displayName} cannot swap with ${a.displayName}`,
      },
    };
  }

  const dayResult = resolveDay(command.day, ctx);
  if (!dayResult.ok) return { ok: false, question: dayResult.question };
  const dayIndex = dayResult.dayIndex;

  let cell: Node | null = null;
  if (command.place.length > 0) {
    const cellResult = resolveCellStep(command.place, ctx, byPath);
    if (!cellResult.ok) return { ok: false, question: cellResult.question };
    cell = cellResult.cell;
  }

  const window = resolveReplaceOrSwapWindow(
    command.day,
    command.span,
    command.shift,
    dayIndex,
    cell,
    a,
    ctx,
  );
  if (!window.ok) return window;
  const { startMin, endMin } = window;

  const blocksOf = (person: OperatorLike): ContextAssignment[] =>
    ctx.assignments.filter(
      (x) =>
        x.operatorId === person.id &&
        (cell === null || x.nodeId === cell.id) &&
        ctx.overlaps({ startMin, endMin }, x),
    );
  const aBlocks = blocksOf(a);
  const bBlocks = blocksOf(b);
  const when = ctx.days.find((d) => d.index === dayIndex)?.iso ?? "";

  if (aBlocks.length === 0) {
    return {
      ok: false,
      question: { kind: "no_block", person: a.displayName, cell: cell?.name ?? null, when },
    };
  }
  if (bBlocks.length === 0) {
    return {
      ok: false,
      question: { kind: "no_block", person: b.displayName, cell: cell?.name ?? null, when },
    };
  }
  if (aBlocks.length > 1) {
    return {
      ok: false,
      question: {
        kind: "swap_which",
        person: a.displayName,
        when,
        blocks: aBlocks.map((x) => `${x.productName ?? "block"} ${x.label}`),
      },
    };
  }
  if (bBlocks.length > 1) {
    return {
      ok: false,
      question: {
        kind: "swap_which",
        person: b.displayName,
        when,
        blocks: bBlocks.map((x) => `${x.productName ?? "block"} ${x.label}`),
      },
    };
  }

  const blkA = aBlocks[0];
  const blkB = bBlocks[0];
  const cellA = ctx.nodeById.get(blkA.nodeId) as Node;
  const cellB = ctx.nodeById.get(blkB.nodeId) as Node;

  // F-152 follow-up (the same fix `expandReplace` needed, plus the
  // maintainer's night-shift follow-up): each block is dated by the day IT
  // starts on, never `dayIndex` (the sentence's own day) -- a leftover or
  // an overnight shift's own band read as a negative span the John Kim
  // bug's own way otherwise. A night-shift block that matches no band AND
  // is not a same-day clock pair asks `across_midnight`, naming the
  // block's OWN real hours -- `expandSwap` never clips either, so there is
  // no window-bounds reading to fall back to. `a`'s removal and `b`'s new
  // assign onto that same block share `blkA`'s own rendering (and the
  // mirror for `blkB`), never one `dayWord` for all four.
  const notRepresentable = (
    person: string,
    blk: ContextAssignment,
    blkCell: Node,
  ): { ok: false; question: Question } => ({
    ok: false,
    question: {
      kind: "across_midnight",
      person,
      cell: blkCell.name,
      block: `${blk.productName ?? "block"} ${blk.label}`,
      hours: formatSpan(clockOfOffset(blk.startMin, ctx), clockOfOffset(blk.endMin, ctx)),
    },
  });
  const renderedA = renderBlockForRebuild(blkA, cellA, ctx);
  if (!renderedA.ok) {
    return renderedA.question !== null
      ? { ok: false, question: renderedA.question }
      : notRepresentable(a.displayName, blkA, cellA);
  }
  const renderedB = renderBlockForRebuild(blkB, cellB, ctx);
  if (!renderedB.ok) {
    return renderedB.question !== null
      ? { ok: false, question: renderedB.question }
      : notRepresentable(b.displayName, blkB, cellB);
  }

  const commands: SingleCommand[] = [
    {
      intent: "unassign",
      operator: personWords(a),
      place: cellWordsOf(cellA, byPath),
      day: renderedA.day,
      span: renderedA.hours,
      existing: { kind: "remove", assignmentId: blkA.id },
      shift: null,
      until: null,
    },
    {
      intent: "unassign",
      operator: personWords(b),
      place: cellWordsOf(cellB, byPath),
      day: renderedB.day,
      span: renderedB.hours,
      existing: { kind: "remove", assignmentId: blkB.id },
      shift: null,
      until: null,
    },
    {
      intent: "assign",
      operator: personWords(a),
      product: blkB.productName ?? "",
      place: cellWordsOf(cellB, byPath),
      day: renderedB.day,
      start: renderedB.hours?.start ?? null,
      end: renderedB.hours?.end ?? null,
      attach: blkB.runId !== null ? { kind: "run", runId: blkB.runId } : { kind: "direct" },
      existing: null,
      shift: renderedB.shift,
    },
    {
      intent: "assign",
      operator: personWords(b),
      product: blkA.productName ?? "",
      place: cellWordsOf(cellA, byPath),
      day: renderedA.day,
      start: renderedA.hours?.start ?? null,
      end: renderedA.hours?.end ?? null,
      attach: blkA.runId !== null ? { kind: "run", runId: blkA.runId } : { kind: "direct" },
      existing: null,
      shift: renderedA.shift,
    },
  ];
  return wrapMany(commands);
}

/** Gregorian leap-year rule, spelled out here (not imported: this module
 *  imports only types from `parse.ts`, and `parse.ts`'s own `isLeap` is not
 *  a type) -- a literal duplicate of `parse.ts`'s own `isRealDate` helper's
 *  rule, same reason this file's shift-band matching already duplicates
 *  `matchName`'s spelling rather than importing it (line ~434's own note). */
function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const DAYS_IN_MONTH_ORDINARY = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function daysInMonth(year: number, month1to12: number): number {
  if (month1to12 === 2 && isLeapYear(year)) return 29;
  return DAYS_IN_MONTH_ORDINARY[month1to12 - 1];
}

/** S55 (D130 item 4): adds `delta` days to `iso` ("YYYY-MM-DD"), for a week
 *  day-index that falls off `ctx.days` -- calendar arithmetic (no zone:
 *  `BoardDay.iso` is already the plant's own calendar date), never a guess.
 *
 * Reviewer fix (14 Sept follow-up): the original wrote this with
 * `new Date(Date.UTC(...))` -- deterministic, no real clock ever read, but
 * `commandPurity.test.ts`'s own U1 audit is a BLUNT textual match on `/new
 * Date\(/` across the whole module, on purpose (its own header: "the
 * cheapest way to guarantee no accidental clock read is to forbid
 * constructing one AT ALL", never mind that this particular call was pure
 * arithmetic) -- so the audit failed on committed, working code. Manual
 * Gregorian carry arithmetic instead: never constructs a `Date`, so U1 stays
 * green by construction, not by the developer remembering not to touch this
 * function. `delta` may be negative (`yesterday`'s own -1, and `last_week`'s
 * -7 through `resolveWeekDays`). */
function addDaysToIso(iso: string, delta: number): string {
  let [y, m, d] = iso.split("-").map(Number);
  d += delta;
  while (d < 1) {
    m -= 1;
    if (m < 1) {
      m = 12;
      y -= 1;
    }
    d += daysInMonth(y, m);
  }
  while (d > daysInMonth(y, m)) {
    d -= daysInMonth(y, m);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/** D130 item 4: the seven day indexes of `kind`'s own week, Monday first --
 *  `this_week` the Monday-to-Sunday week containing today, `next_week`/
 *  `last_week` that shifted by seven. Every day of the week must be on the
 *  board, else `day_off_board` naming the first missing one's own iso
 *  (`addDaysToIso` off today's, for a day outside `ctx.days`' own range). */
function resolveWeekDays(
  kind: "this_week" | "next_week" | "last_week",
  ctx: ResolveContext,
): { ok: true; days: number[] } | { ok: false; question: Question } {
  if (ctx.todayIndex === null) {
    return { ok: false, question: { kind: "day_off_board", text: "today" } };
  }
  const todayDay = ctx.days.find((d) => d.index === ctx.todayIndex)!;
  const daysFromMonday = (todayDay.weekday + 6) % 7; // Sun(0)->6 .. Sat(6)->5, Mon(1)->0
  const weekOffset = kind === "last_week" ? -7 : kind === "next_week" ? 7 : 0;
  const mondayIndex = ctx.todayIndex - daysFromMonday + weekOffset;
  const indexes: number[] = [];
  for (let i = 0; i < 7; i++) indexes.push(mondayIndex + i);
  for (const idx of indexes) {
    if (!ctx.days.some((d) => d.index === idx)) {
      return {
        ok: false,
        question: { kind: "day_off_board", text: addDaysToIso(todayDay.iso, idx - ctx.todayIndex) },
      };
    }
  }
  return { ok: true, days: indexes };
}

/** D130 item 4: a `copy`'s own `from`/`to` -- a day kind resolves through
 *  `resolveDay` (one index), a week kind through `resolveWeekDays` (seven,
 *  Monday first) -- `parse.ts`'s own `copy_mismatch`/`copy_same` already
 *  guarantee `from` and `to` are the same kind of thing by the time this
 *  runs. */
function resolveCopyDayOrWeek(
  day: DayWord,
  ctx: ResolveContext,
): { ok: true; days: number[] } | { ok: false; question: Question } {
  if (day.kind === "this_week" || day.kind === "next_week" || day.kind === "last_week") {
    return resolveWeekDays(day.kind, ctx);
  }
  const dayResult = resolveDay(day, ctx);
  if (!dayResult.ok) return { ok: false, question: dayResult.question };
  return { ok: true, days: [dayResult.dayIndex] };
}

/**
 * Reviewer finding (14 Sept follow-up, probing "wallOf on a block spanning
 * midnight"): a run/block whose wall-clock END falls on a LATER calendar day
 * than its own START (an overnight span, "22:00-02:00") cannot be written as
 * a single `book`/`assign` command at all -- both carry exactly ONE `day`
 * and a same-day `ClockTime` pair, with `DAY_END` (F-146's own 23:59, read
 * as the day's own 1440th minute) the only way to reach the day's own END,
 * never past it. `expandCopy` used to read `ctx.wallOf` on each end
 * independently and write both onto the SAME target day regardless -- an
 * overnight run copied this way silently wrote an END clock reading EARLIER
 * than its own START ("book ... from 22:00 to 02:00"), which
 * `resolveDaySpanStep` then read as a NEGATIVE-length span and asked
 * `too_short` with "-1200 minutes": never a crash, but never a sane
 * question either. Ending EXACTLY at midnight (minute-of-day 0, one
 * calendar day later -- an ordinary shape now that F-146 lets a typed
 * command end there too) IS representable, as `DAY_END`; anything that
 * genuinely crosses into a later day's daytime hours is not representable
 * here at all and is skipped, the same documented-limitation shape
 * `expandCopy` already uses for a departed person's/deleted part's block
 * just below. Returns `null` to mean "skip this one", never a guess.
 */
function copyableSpan(
  startMin: number,
  endMin: number,
  ctx: ResolveContext,
): { startMOD: number; endMOD: number } | null {
  const startWall = ctx.wallOf(startMin);
  const endWall = ctx.wallOf(endMin);
  if (endWall.dayIndex === startWall.dayIndex) {
    return { startMOD: startWall.minuteOfDay, endMOD: endWall.minuteOfDay };
  }
  if (endWall.dayIndex === startWall.dayIndex + 1 && endWall.minuteOfDay === 0) {
    return { startMOD: startWall.minuteOfDay, endMOD: 24 * 60 };
  }
  return null;
}

/** The inverse of `clockToMinuteOfDay` for a bare 0..1440 minute-of-day (as
 *  `copyableSpan` returns) -- 1440 (never a real `wallOf` output; that
 *  function's own `minuteOfDay` is always 0..1439) prints as `DAY_END`. */
function clockFromMinuteOfDay(mod: number): ClockTime {
  if (mod === 24 * 60) return { hour: DAY_END_HOUR, minute: DAY_END_MINUTE };
  return { hour: Math.floor(mod / 60), minute: mod % 60 };
}

/**
 * R-408, §3.5: a day copies to a day, a week to a week, Monday to Monday.
 * Each run on the source day/cell becomes a `book` on the target (same
 * product, headcount, wall-clock hours, via `ctx.wallOf`); each block
 * becomes a direct `assign`. A target that already holds the same thing
 * (same person/product/hours for a block, same product/hours for a run) is
 * skipped -- "said twice does nothing". A block/run with a null operator/
 * product (departed person, deleted part) is skipped with no question.
 */
function expandCopy(command: CopyCommand, ctx: ResolveContext): Expansion {
  const byPath = buildPathIndex(ctx.nodeById);
  const fromResult = resolveCopyDayOrWeek(command.from, ctx);
  if (!fromResult.ok) return fromResult;
  const toResult = resolveCopyDayOrWeek(command.to, ctx);
  if (!toResult.ok) return toResult;
  const fromDays = fromResult.days;
  const toDays = toResult.days;

  const cellsResult = resolveEveryonePlaceCells(command.place, ctx, byPath);
  if (!cellsResult.ok) return cellsResult;
  const targetCells = cellsResult.cells;

  const commands: SingleCommand[] = [];
  const pairCount = Math.min(fromDays.length, toDays.length);
  for (let i = 0; i < pairCount; i++) {
    const srcIdx = fromDays[i];
    const dstIdx = toDays[i];
    const dstIso = ctx.days.find((d) => d.index === dstIdx)?.iso ?? "";
    const srcDayStart = ctx.wallToOffset(srcIdx, 0);
    const srcDayEnd = ctx.wallToOffset(srcIdx, 1440);
    const dstDayStart = ctx.wallToOffset(dstIdx, 0);
    const dstDayEnd = ctx.wallToOffset(dstIdx, 1440);

    for (const cell of targetCells) {
      const srcRuns = ctx.runs.filter(
        (r) => r.nodeId === cell.id && r.startMin < srcDayEnd && srcDayStart < r.endMin,
      );
      for (const run of srcRuns) {
        if (run.productId === null) continue;
        const span = copyableSpan(run.startMin, run.endMin, ctx);
        if (span === null) continue; // genuinely overnight -- not representable, skipped
        const { startMOD, endMOD } = span;
        const alreadyThere = ctx.runs.some((r) => {
          if (r.nodeId !== cell.id || r.productId !== run.productId) return false;
          if (r.startMin < dstDayStart || r.startMin >= dstDayEnd) return false;
          const rSpan = copyableSpan(r.startMin, r.endMin, ctx);
          return rSpan !== null && rSpan.startMOD === startMOD && rSpan.endMOD === endMOD;
        });
        if (alreadyThere) continue;
        commands.push({
          intent: "book",
          product: run.productName ?? "",
          place: cellWordsOf(cell, byPath),
          headcount: run.headcount,
          day: { kind: "date", iso: dstIso },
          start: clockFromMinuteOfDay(startMOD),
          end: clockFromMinuteOfDay(endMOD),
          existing: null,
          shift: null,
        });
      }

      const srcBlocks = ctx.assignments.filter(
        (x) => x.nodeId === cell.id && x.startMin < srcDayEnd && srcDayStart < x.endMin,
      );
      for (const blk of srcBlocks) {
        if (blk.operatorId === null || blk.productId === null) continue;
        const op = operatorById(blk.operatorId, ctx);
        if (op === null) continue;
        const span = copyableSpan(blk.startMin, blk.endMin, ctx);
        if (span === null) continue; // genuinely overnight -- not representable, skipped
        const { startMOD, endMOD } = span;
        const alreadyThere = ctx.assignments.some((x) => {
          if (
            x.nodeId !== cell.id ||
            x.operatorId !== blk.operatorId ||
            x.productId !== blk.productId
          ) {
            return false;
          }
          if (x.startMin < dstDayStart || x.startMin >= dstDayEnd) return false;
          const xSpan = copyableSpan(x.startMin, x.endMin, ctx);
          return xSpan !== null && xSpan.startMOD === startMOD && xSpan.endMOD === endMOD;
        });
        if (alreadyThere) continue;
        commands.push({
          intent: "assign",
          operator: personWords(op),
          product: blk.productName ?? "",
          place: cellWordsOf(cell, byPath),
          day: { kind: "date", iso: dstIso },
          start: clockFromMinuteOfDay(startMOD),
          end: clockFromMinuteOfDay(endMOD),
          attach: { kind: "direct" },
          existing: null,
          shift: null,
        });
      }
    }
  }

  if (commands.length === 0) {
    const label = command.place.length > 0 ? command.place[0] : "The board";
    return {
      ok: false,
      question: {
        kind: "nothing_to_do",
        text: `${label} already matches ${dayWordLabel(command.from)}.`,
      },
    };
  }
  if (commands.length > LOT_CEILING) {
    return {
      ok: false,
      question: { kind: "lot_too_big", count: commands.length, max: LOT_CEILING },
    };
  }
  return wrapMany(commands);
}

/**
 * R-409, §3.6: `command.until` non-null -- every day from `command.day` to
 * `until` inclusive, each of the person's blocks (anywhere, the S49
 * gathering -- narrowed by a place/span when the sentence unusually carries
 * one too, brief §3.6's own comment) becomes an `unassign`. `until` before
 * `day` is `day_order`; nothing over every day is `nothing_to_do`.
 */
function expandAbsence(command: UnassignCommand, ctx: ResolveContext): Expansion {
  const until = command.until as DayWord;
  const byPath = buildPathIndex(ctx.nodeById);

  const dayResult = resolveDay(command.day, ctx);
  if (!dayResult.ok) return { ok: false, question: dayResult.question };
  const untilResult = resolveDay(until, ctx);
  if (!untilResult.ok) return { ok: false, question: untilResult.question };

  const fromIso = ctx.days.find((d) => d.index === dayResult.dayIndex)?.iso ?? "";
  const toIso = ctx.days.find((d) => d.index === untilResult.dayIndex)?.iso ?? "";

  if (untilResult.dayIndex < dayResult.dayIndex) {
    return { ok: false, question: { kind: "day_order", first: fromIso, second: toIso } };
  }

  const personResult = resolvePersonStep(command.operator, ctx);
  if (!personResult.ok) return { ok: false, question: personResult.question };
  const person = personResult.operator;

  let cellFilter: Node | null = null;
  if (command.place.length > 0) {
    const cellResult = resolveCellStep(command.place, ctx, byPath);
    if (!cellResult.ok) return { ok: false, question: cellResult.question };
    cellFilter = cellResult.cell;
  }

  const commands: SingleCommand[] = [];
  // F-152 (the `until` form): a block spanning midnight (a night-shift
  // leftover, the same shape the John Kim bug shipped from) overlaps TWO of
  // this loop's own per-day windows -- `seen` keeps it a single removal,
  // never one per day it touches.
  const seen = new Set<string>();
  for (let dayIndex = dayResult.dayIndex; dayIndex <= untilResult.dayIndex; dayIndex++) {
    let dayStart: number;
    let dayEnd: number;
    if (command.span !== null) {
      dayStart = ctx.wallToOffset(dayIndex, clockToMinuteOfDay(command.span.start));
      dayEnd = ctx.wallToOffset(dayIndex, clockToMinuteOfDay(command.span.end));
    } else {
      dayStart = ctx.wallToOffset(dayIndex, 0);
      dayEnd = ctx.wallToOffset(dayIndex, 1440);
    }
    const dayBlocks = ctx.assignments.filter(
      (x) =>
        x.operatorId === person.id &&
        (cellFilter === null || x.nodeId === cellFilter.id) &&
        ctx.overlaps({ startMin: dayStart, endMin: dayEnd }, x),
    );
    for (const x of dayBlocks) {
      if (seen.has(x.id)) continue;
      seen.add(x.id);
      const xCell = ctx.nodeById.get(x.nodeId) as Node;
      // F-152: a whole block (never clipped here, R-409's own "each of the
      // person's blocks becomes an unassign") is dated by the day IT
      // starts on, never the loop's own `dayIndex` -- the same "22:00 to
      // 06:00 dated today" negative span the John Kim bug shipped from,
      // reached here whenever a leftover block overlaps a later day's
      // window without starting on it. When the block's own hours are not
      // representable on that one day (genuinely two nights, not just an
      // exact-midnight end), `span: null` (S49's own "whole day" window)
      // still finds and removes the SAME block by its `existing`
      // assignment id -- never a guess at hours nobody asked for.
      const dayForBlock = dayWordOrOffBoard(ctx.wallOf(x.startMin).dayIndex, ctx);
      if (!dayForBlock.ok) return dayForBlock;
      const repSpan = copyableSpan(x.startMin, x.endMin, ctx);
      commands.push({
        intent: "unassign",
        operator: personWords(person),
        place: cellWordsOf(xCell, byPath),
        day: dayForBlock.day,
        span:
          repSpan === null
            ? null
            : {
                start: clockFromMinuteOfDay(repSpan.startMOD),
                end: clockFromMinuteOfDay(repSpan.endMOD),
              },
        existing: { kind: "remove", assignmentId: x.id },
        shift: null,
        until: null,
      });
    }
  }

  if (commands.length === 0) {
    return {
      ok: false,
      question: {
        kind: "nothing_to_do",
        text: `${person.displayName} has no block from ${fromIso} to ${toIso}.`,
      },
    };
  }
  if (commands.length > LOT_CEILING) {
    return {
      ok: false,
      question: { kind: "lot_too_big", count: commands.length, max: LOT_CEILING },
    };
  }
  return wrapMany(commands);
}

/**
 * S58 (R-413, D132 item 2): "split Sam's block at noon" -- the person's block
 * (placed or anywhere, that day, the same gathering a place-less move/removal
 * uses); when several of the person's blocks overlap the day, `at` itself
 * picks the one that CONTAINS it (no button -- unlike a move/removal, a split
 * has no `existing` field to carry an answer in at all); none contains it is
 * `split_outside`. Both halves must reach the minimum duration (`too_short`
 * otherwise). Writes a `move` in time (the block's own first half, `existing`
 * filled, `adjust` null) and an `assign` (the second half, the block's own
 * part/cell/attachment, `existing: { kind: "separate_from", assignmentId }` naming the
 * block it is cut from -- see the comment on that field below, S58-e) -- the move
 * FIRST, so the lot's own board-order write never has the assign racing the
 * still-full-length block.
 */
function expandSplit(command: SplitCommand, ctx: ResolveContext): Expansion {
  const byPath = buildPathIndex(ctx.nodeById);

  let cell: Node | null = null;
  if (command.place.length > 0) {
    const cellResult = resolveCellStep(command.place, ctx, byPath);
    if (!cellResult.ok) return { ok: false, question: cellResult.question };
    cell = cellResult.cell;
  }

  const personResult = resolvePersonStep(command.operator, ctx);
  if (!personResult.ok) return { ok: false, question: personResult.question };
  const operator = personResult.operator;

  const dayResult = resolveDay(command.day, ctx);
  if (!dayResult.ok) return { ok: false, question: dayResult.question };
  const dayIndex = dayResult.dayIndex;
  const dayStart = ctx.wallToOffset(dayIndex, 0);
  const dayEnd = ctx.wallToOffset(dayIndex, 1440);
  const whenText = ctx.days.find((d) => d.index === dayIndex)?.iso ?? "";

  const hits =
    cell === null
      ? []
      : ctx.assignments.filter(
          (x) =>
            x.nodeId === cell!.id &&
            x.operatorId === operator.id &&
            ctx.overlaps({ startMin: dayStart, endMin: dayEnd }, x),
        );
  const candidates =
    hits.length > 0
      ? hits
      : gatherElsewhereBlocks(operator.id, { startMin: dayStart, endMin: dayEnd }, ctx);
  if (candidates.length === 0) {
    return {
      ok: false,
      question: {
        kind: "no_block",
        person: operator.displayName,
        cell: cell?.name ?? null,
        when: whenText,
      },
    };
  }

  const atMin = ctx.wallToOffset(dayIndex, clockToMinuteOfDay(command.at));
  const containing = candidates.filter((x) => x.startMin <= atMin && atMin < x.endMin);
  if (containing.length === 0) {
    return {
      ok: false,
      question: {
        kind: "split_outside",
        person: operator.displayName,
        at: formatClockMinuteOfDay(atMin - dayStart),
        blocks: candidates.map((x) => `${x.productName ?? "block"} ${x.label}`),
      },
    };
  }
  const blk = containing[0];
  const blkCell = ctx.nodeById.get(blk.nodeId) as Node;

  const firstMinutes = atMin - blk.startMin;
  const secondMinutes = blk.endMin - atMin;
  if (firstMinutes < ctx.minDurationMinutes || secondMinutes < ctx.minDurationMinutes) {
    return {
      ok: false,
      question: {
        kind: "too_short",
        minutes: Math.min(firstMinutes, secondMinutes),
        min: ctx.minDurationMinutes,
      },
    };
  }

  // Reviewer fix (S58-b lane review, 14 Sept): a block legitimately ends
  // exactly at the day's own 1440th minute (F146: "20:00 to DAY_END" writes
  // `endMin` at `dayEnd` below, not 1439) -- `hoursOfBlock`'s own
  // `clockOfOffset` reads THAT through `ctx.wallOf`, whose `minuteOfDay` is
  // always 0..1439 by contract (never a real `wallOf` output holds 1440), so
  // a block ending at day's end came back as `{ hour: 0, minute: 0 }` --
  // midnight of THIS day, not DAY_END -- and the second half's own `end`
  // silently read as EARLIER than its own `start` once re-resolved
  // (`resolveDaySpanStep`/`clockToMinuteOfDay`, which never special-cases a
  // bare `00:00`), surfacing as `too_short` with a negative count instead of
  // the split completing.
  //
  // F-152 follow-up: `copyableSpan` is that same DAY_END rule (`expandCopy`'s
  // own fix for the identical shape) generalized to BOTH halves at once, so
  // it replaces the ad hoc `blk.endMin === dayEnd` ternary here. `atMin` is
  // always on `dayIndex` (it is built from it, two lines up), so the second
  // half's own day never moves -- only its END needed the DAY_END rule. The
  // FIRST half's own START is `blk.startMin`, which -- unlike `atMin` -- can
  // fall on an EARLIER calendar day (a night-shift block found by `atMin`
  // long after it started, a leftover the same shape the John Kim bug
  // shipped from): dating it `dayIndex` regardless used to read a negative
  // span the same way. Neither half representable on a single day (the
  // block genuinely runs two nights) asks `split_needed`, never a guess.
  const firstSpan = copyableSpan(blk.startMin, atMin, ctx);
  const secondSpan = copyableSpan(atMin, blk.endMin, ctx);
  if (firstSpan === null || secondSpan === null) {
    return {
      ok: false,
      question: {
        kind: "split_needed",
        person: operator.displayName,
        cell: blkCell.name,
        block: `${blk.productName ?? "block"} ${blk.label}`,
        span: formatSpan(clockOfOffset(blk.startMin, ctx), clockOfOffset(blk.endMin, ctx)),
      },
    };
  }
  const firstDayResult = dayWordOrOffBoard(ctx.wallOf(blk.startMin).dayIndex, ctx);
  if (!firstDayResult.ok) return firstDayResult;
  const firstHours = {
    start: clockFromMinuteOfDay(firstSpan.startMOD),
    end: clockFromMinuteOfDay(firstSpan.endMOD),
  };
  const secondHours = {
    start: clockFromMinuteOfDay(secondSpan.startMOD),
    end: clockFromMinuteOfDay(secondSpan.endMOD),
  };
  const dayWord = dayWordForIndex(dayIndex, ctx);
  const cellWords = cellWordsOf(blkCell, byPath);

  const moveCommand: MoveCommand = {
    intent: "move",
    operator: personWords(operator),
    place: cellWords,
    toPlace: null,
    day: firstDayResult.day,
    span: firstHours,
    existing: { kind: "move", assignmentId: blk.id },
    shift: null,
    adjust: null,
  };
  // Reviewer fix (S58-b lane review, 14 Sept), amended S58-e (R-413): D127's
  // "never write before the yes" means `resolveLotStep` resolves EVERY step
  // of a lot against the SAME unwritten `ctx` -- so when this second command
  // reaches `resolveAssignCommand`, `blk` (10:00-14:00, say) is STILL its own
  // full-length self in `ctx.assignments`; the second half's own new range
  // (noon-14:00, say) sits entirely inside it, same person/product/cell. The
  // R-385 own-block step (resolveAssignCommand's own step 5) cannot tell that
  // apart from a genuine second block and would ask `block_exists` on EVERY
  // split, defeating the "one yes" (D132 item 2) -- reproduced by SP6 below
  // with `existing: null`. `existing: { kind: "separate" }` (the S58-b fix)
  // silenced the question for EVERY overlapping block of the same person,
  // part and cell, not only `blk` itself -- a genuine second block was never
  // asked about either (CB-y-9, two S58 reviewers). `separate_from` names
  // `blk.id` specifically: the own-block step removes only that block before
  // checking, so a real second block still asks, naming the OTHER block.
  // `attach` (below) still decides run vs. direct independently.
  const assignCommand: AssignCommand = {
    intent: "assign",
    operator: personWords(operator),
    product: blk.productName ?? "",
    place: cellWords,
    day: dayWord,
    start: secondHours.start,
    end: secondHours.end,
    attach: blk.runId !== null ? { kind: "run", runId: blk.runId } : { kind: "direct" },
    existing: { kind: "separate_from", assignmentId: blk.id },
    shift: null,
  };
  return wrapMany([moveCommand, assignCommand]);
}

/**
 * S58 (R-416, D132 item 5): "every weekday this week" / "every day next
 * week" -- an assign or a booking whose `day.kind` is `weekdays`/`every_day`.
 * The week's own seven day indexes, `resolveWeekDays` (D130's copy machinery,
 * unchanged): `weekdays` takes its own first five (Monday-Friday, the array's
 * own order); `every_day` all seven. Every day of the WEEK must be on the
 * board (`resolveWeekDays` already checks that, `day_off_board` naming the
 * first missing iso) -- the same rule a week-to-week copy uses. One copy of
 * the command per day, in order, `day: { kind: "date", iso }`; every other
 * field (`attach`/`existing` included) copied onto each exactly as given.
 */
function expandRepeatDay(command: AssignCommand | BookCommand, ctx: ResolveContext): Expansion {
  const day = command.day as { kind: "weekdays" | "every_day"; week: "this_week" | "next_week" };
  const weekResult = resolveWeekDays(day.week, ctx);
  if (!weekResult.ok) return weekResult;
  const dayIndexes = day.kind === "weekdays" ? weekResult.days.slice(0, 5) : weekResult.days;

  const commands = dayIndexes.map(
    (idx) => ({ ...command, day: dayWordForIndex(idx, ctx) }) as SingleCommand,
  );
  if (commands.length > LOT_CEILING) {
    return {
      ok: false,
      question: { kind: "lot_too_big", count: commands.length, max: LOT_CEILING },
    };
  }
  return wrapMany(commands);
}

/**
 * S55 (D130 item 1): the board's own expansion step, called ONCE before the
 * bar's `several` intercept so the rules path and a future model path
 * expand the same way. Returns the SAME object for every ordinary form (R-406
 * to R-409's three intents never reach here unhandled; an ordinary single or
 * an already-built `several` passes straight through).
 */
export function expandCommand(command: Command, ctx: ResolveContext): Expansion {
  if (command.intent === "several") return { ok: true, command };
  if (command.intent === "replace") return expandReplace(command, ctx);
  if (command.intent === "swap") return expandSwap(command, ctx);
  if (command.intent === "copy") return expandCopy(command, ctx);
  // S58 (R-413, D132 item 2): a split is a shorten plus an assign, both
  // written here -- the board's own mechanism, same as replace/swap/copy.
  if (command.intent === "split") return expandSplit(command, ctx);
  // S58 (R-415, D132 item 4): a headcount is never part of a lot -- one
  // existing write, unchanged (`resolveCommand`'s own new branch does it).
  if (command.intent === "headcount") return { ok: true, command };
  if (command.intent === "unassign") {
    if (command.until !== null) return expandAbsence(command, ctx);
    if (isEveryone(command.operator)) return expandEveryoneUnassign(command, ctx);
    return { ok: true, command };
  }
  if (command.intent === "move") {
    if (isEveryone(command.operator)) return expandEveryoneMove(command, ctx);
    return { ok: true, command };
  }
  // The two remaining members, assign and book: S58 (R-416, D132 item 5)'s
  // own repeat day -- "every weekday this week" writes one command per day,
  // in order, before either ever reaches `resolveCommand`.
  if (
    command.day !== null &&
    (command.day.kind === "weekdays" || command.day.kind === "every_day")
  ) {
    return expandRepeatDay(command, ctx);
  }
  return { ok: true, command };
}

function fieldWord(field: "operator" | "product" | "place" | "shift"): string {
  if (field === "operator") return "person";
  if (field === "product") return "part";
  if (field === "shift") return "shift";
  return "cell";
}

/** S49: "<part> <hours>" with a known part, "a block <hours>" without --
 *  the elsewhere question's own phrase for its one candidate, read off
 *  `part`/`when` directly (never `label`, which already carries the cell
 *  name too). */
function partHoursPhrase(c: Candidate): string {
  return c.part ? `${c.part} ${c.when}` : `a block ${c.when}`;
}

/** The sentence for a Question — the words the bar shows. Pure, so it is tested verbatim. */
export function describeQuestion(q: Question): string {
  switch (q.kind) {
    case "ambiguous":
      return `Which ${fieldWord(q.field)}? "${q.text}" matches ${q.candidates.length}:`;
    case "unknown":
      return `No ${fieldWord(q.field)} called "${q.text}" on this board.`;
    case "not_offered":
      return `${q.product} is not made at ${q.cell}, so it cannot be scheduled there.`;
    case "place_mismatch":
      return `There is no ${q.cell} in ${q.qualifier}. ${q.cell} is in ${q.elsewhere
        .map((c) => c.label)
        .join(" / ")}.`;
    case "day_off_board":
      return `${q.text} is not on the board. Move the board to that day first.`;
    case "too_short":
      return `That is ${q.minutes} minutes; a block is at least ${q.min} minutes.`;
    case "run_exists":
      if (q.runs.length === 1) {
        return `A ${q.product} job is already booked on ${q.cell}, ${q.runs[0].label}. Join it, or make a separate block?`;
      }
      return `${q.runs.length} ${q.product} jobs are already booked on ${q.cell}. Join one, or make a separate block?`;
    case "block_exists":
      if (q.blocks.length === 1) {
        if (q.same) {
          return `${q.person} is already on ${q.product} at ${q.cell} ${q.blocks[0].label} — nothing to change. Add a separate block?`;
        }
        return `${q.person} is already on ${q.product} at ${q.cell} ${q.blocks[0].label}. Change it to ${q.span}, or add a separate block?`;
      }
      return `${q.person} already has ${q.blocks.length} ${q.product} blocks at ${q.cell} (${q.blocks.map((b) => b.label).join(", ")}). Change one to ${q.span}, or add a separate block?`;
    case "block_gone":
      return `That ${q.product} block of ${q.person}'s at ${q.cell} is no longer on the board. Add it as a new block?`;
    case "job_exists":
      if (q.same) {
        return `A ${q.product} job is already booked on ${q.cell} ${q.run.label} — nothing to change.`;
      }
      return `A ${q.product} job is already booked on ${q.cell} ${q.run.label}. Change it to ${q.span}, or pick other hours?`;
    case "job_in_the_way":
      return `${q.cell} already runs ${q.other}; a cell runs one job at a time. Pick other hours, or change that job on the board.`;
    case "job_gone":
      return `That ${q.product} job on ${q.cell} is no longer on the board. Book it again?`;
    case "remove_which": {
      if (q.blocks.length === 1) {
        const candidate = q.blocks[0];
        if (q.elsewhere) {
          // S49: the sentence's cell was wrong -- name both (§19.96/D125).
          return `${q.person} has no block on ${q.cell} ${q.when}, but has one on ${candidate.cell}: ${partHoursPhrase(candidate)}. Remove that one?`;
        }
        if (q.cell === null) {
          // S49: no place at all -- name the block's OWN cell.
          return candidate.part
            ? `Remove ${q.person}'s ${candidate.part} block on ${candidate.cell}, ${candidate.when}?`
            : `Remove ${q.person}'s block on ${candidate.cell}, ${candidate.when}?`;
        }
        // The candidate's own `part` (S41-b), never recovered by parsing
        // `label` back apart -- `label` stays the combined "<part> <time>"
        // string the many-block buttons read, so only the KNOWN prefix
        // (`part` plus one space, or the "block" fallback) is stripped to
        // get the bare time back out.
        const prefix = `${candidate.part ?? "block"} `;
        const when = candidate.label.startsWith(prefix)
          ? candidate.label.slice(prefix.length)
          : candidate.label;
        return candidate.part
          ? `Remove ${q.person}'s ${candidate.part} block on ${q.cell}, ${when}?`
          : `Remove ${q.person}'s block on ${q.cell}, ${when}?`;
      }
      if (q.elsewhere) {
        return `${q.person} has no block on ${q.cell} ${q.when}, but has ${q.blocks.length} elsewhere. Remove which?`;
      }
      if (q.cell === null) {
        return `${q.person} has ${q.blocks.length} blocks ${q.when}. Remove which?`;
      }
      return `${q.person} has ${q.blocks.length} blocks on ${q.cell} ${q.when}. Remove which?`;
    }
    case "no_block":
      return q.cell === null
        ? `${q.person} has no block ${q.when}.`
        : `${q.person} has no block on ${q.cell} ${q.when}.`;
    case "block_gone_remove":
      return q.cell === null
        ? `That block of ${q.person}'s is already gone.`
        : `That block of ${q.person}'s on ${q.cell} is already gone.`;
    case "move_which": {
      if (q.elsewhere) {
        const destination = q.destination ?? "";
        if (q.blocks.length === 1) {
          const candidate = q.blocks[0];
          return `${q.person} has no block on ${q.cell} ${q.when}, but has one on ${candidate.cell}: ${partHoursPhrase(candidate)}. Move that one to ${destination}?`;
        }
        return `${q.person} has no block on ${q.cell} ${q.when}, but has ${q.blocks.length} elsewhere. Move which to ${destination}?`;
      }
      if (q.cell === null) {
        return `${q.person} has ${q.blocks.length} blocks ${q.when}. Move which?`;
      }
      return `${q.person} has ${q.blocks.length} blocks on ${q.cell} ${q.when}. Move which?`;
    }
    case "several_unsupported":
      return "Several commands in one sentence are read but not yet run; say them one at a time for now.";
    case "no_shift_pattern":
      return `${q.cell} has no shift pattern, so say the hours.`;
    case "no_shift":
      return `No shift called "${q.text}" on ${q.cell}; it has ${q.shifts.join(", ")}.`;
    case "no_shift_at":
      return `No shift on ${q.cell} covers ${q.time}; say a start that falls in one.`;
    case "no_start":
      return q.text;
    case "lot_too_big":
      return `That is ${q.count} commands; say a smaller place or span (the limit is ${q.max}).`;
    case "nothing_to_do":
      return q.text;
    case "split_needed":
      return `${q.person}'s ${q.block} on ${q.cell} crosses both ends of ${q.span}; say a span that reaches one end of the block instead.`;
    case "across_midnight":
      return `${q.person}'s ${q.block} block on ${q.cell} crosses midnight and matches no shift; split it at midnight first, or say the shift.`;
    case "swap_which":
      return `${q.person} has ${q.blocks.length} blocks ${q.when} (${q.blocks.join(", ")}). Swap which?`;
    case "day_order":
      return `${q.second} is before ${q.first}; say the later day second.`;
    case "expand_first":
      return `That ${q.intent} has to be worked out before it can run.`;
    case "adjust_inverts":
      return `${q.person}'s ${q.block} would end before it starts.`;
    case "adjust_off_day":
      return `${q.person}'s ${q.block} would cross midnight; that is not on this board.`;
    case "bad_adjust":
      return q.text;
    case "split_outside":
      return q.blocks.length > 0
        ? `${q.person} has no block that covers ${q.at} (has ${q.blocks.join(", ")}).`
        : `${q.person} has no block that covers ${q.at}.`;
    case "no_job":
      return `No ${q.product} job on ${q.cell} ${q.when}.`;
    case "which_job":
      return `${q.runs.length} ${q.product} jobs on ${q.cell} (${q.runs.join(", ")}). Say which.`;
    case "bad_repeat_day":
      return `${q.text} cannot be used here.`;
  }
}
