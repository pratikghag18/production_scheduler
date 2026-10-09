/**
 * S194-D/E independent review (docs/agent-briefs/s194-de-review-brief.md).
 * Two findings pinned here, both confirmed against the REAL, unmocked
 * `resolve.ts`/`grounded.ts` (no mock of either module):
 *
 * 1. DEF-0043/R-459: `absenceOutcome` (resolve.ts) builds its `dayPhrase` for
 *    a multi-day absence ("Ana is on leave till Friday") as a plain string
 *    with TWO raw ISO tokens, `from ${fromIso} to ${toIso}`. `CommandBar.tsx`'s
 *    own `renderReadout` -- the ONE place a raw ISO token is turned into a
 *    spoken day ("Mon 28 Sep") before anything reaches the thread -- replaces
 *    only the FIRST match (`readout.replace(ISO_DAY, ...)`, `ISO_DAY` has no
 *    `g` flag). A readout built from `absenceOutcome` is therefore the one
 *    shape in the whole file that carries two ISO tokens in one string, so it
 *    is also the one shape that shows a raw `YYYY-MM-DD` even after
 *    `renderReadout` has run: "Sam Patel is off from Mon 28 Sep to 2026-10-02."
 *    The mirror below (`mirrorRenderReadout`) is byte-for-byte
 *    `commandBar.test.tsx`'s own `renderedReadout` helper, which makes the
 *    same single-replace assumption -- confirming no existing case in that
 *    file could ever have caught this (a fixture with two dates in one
 *    readout was never built there).
 *
 * 2. DEF-0041/R-431/R-435, the main session's doubt 5: the fix narrows only
 *    the EVERYDAY-word half of the sweeping-unassign guard (an everyday word
 *    alone no longer grounds; paired with "everyone"/"everybody"/"board" it
 *    still does). The STRONG-word half is UNCHANGED: any of "unassign",
 *    "remove", "clear", "drop", "cancel", "delete", "pull", "free", "sick",
 *    "ill", "absent", "on leave", "on holiday", "on vacation" still grounds a
 *    sweeping clear-everyone reading on its own, anywhere in a garbled
 *    transcript, exactly F-215's own defect shape, just under different
 *    trigger words. Ten ordinary sentences below (none of them a removal)
 *    still ground; four genuine removal sentences below (none of them using a
 *    listed verb) do not.
 */
import { describe, it, expect } from "vitest";
import { groundReading, type VerbLists } from "@/lib/command/grounded";
import { renderIsoDays } from "@/features/board/components/CommandBar";
import {
  ASSIGN_VERBS,
  BOOK_VERBS,
  UNASSIGN_VERBS,
  MOVE_VERBS,
  HEADCOUNT_VERBS,
  REPLACE_VERBS,
  SWAP_VERBS,
  COPY_VERBS,
  ABSENCE_WORDS,
  ADJUST_VERBS,
  SAME_AS_WORDS,
  type UnassignCommand,
} from "@/lib/command/parse";
import { expandCommand, type ResolveContext, type BoardDay } from "@/lib/command/resolve";

// -----------------------------------------------------------------------
// Finding 1: the multi-day absence readout's second ISO token.
// -----------------------------------------------------------------------

/** REWRITTEN by S194-D's third pass (the reason, per the main session's
 *  instruction): this used to be a byte-for-byte MIRROR of the bar's
 *  single-replace `renderReadout`, so it reproduced the bug it pinned and
 *  could never go green however the bar was fixed. The bar now exports its
 *  one renderer, `renderIsoDays` (global, every ISO day in the string);
 *  this case renders through THAT, exactly what the person reads. The
 *  finding itself -- the assertions below -- is unchanged. */
function mirrorRenderReadout(raw: string): string {
  return renderIsoDays(raw, "America/Chicago", "d_mon_yyyy");
}

const days: BoardDay[] = [
  { index: 0, iso: "2026-09-28", weekday: 1 },
  { index: 1, iso: "2026-09-29", weekday: 2 },
  { index: 2, iso: "2026-09-30", weekday: 3 },
  { index: 3, iso: "2026-10-01", weekday: 4 },
  { index: 4, iso: "2026-10-02", weekday: 5 },
];

const cell1 = { id: "cell1", name: "Cell 1", path: "line1.cell1" };

function absenceCtx(): ResolveContext {
  return {
    cells: [cell1],
    nodeById: new Map([["cell1", cell1]]),
    operators: [{ id: "sam", displayName: "Sam Patel", employeeRef: null, active: true }],
    products: [],
    offeredAt: () => [],
    days,
    todayIndex: 0,
    todayIso: "2026-09-28",
    wallToOffset: (d, m) => d * 1440 + m,
    runs: [],
    fitsRun: () => true,
    minDurationMinutes: 15,
    // No block at all -- the "nothing on the board, still recorded" branch,
    // the shortest path to `absenceOutcome`'s own `summary`/`attempted`.
    assignments: [],
    overlaps: (a, b) => a.startMin < b.endMin && b.startMin < a.endMin,
    findRunOverlap: () => null,
    shiftsAt: () => [],
    nowMinuteOfDay: null,
    wallOf: (m) => ({ dayIndex: Math.floor(m / 1440), minuteOfDay: ((m % 1440) + 1440) % 1440 }),
    certificateGaps: () => [],
    eligibilityPolicy: () => "warn",
    settled: true,
    // R-431: the server's own answer says Sam is recordable and nothing
    // already covers these days -- `willRecord` is true, the shortest path
    // to the record's own `readout`/`attempted`/`summary`.
    absenceRecordable: new Set(["sam"]),
    hasWholeDayAbsence: () => false,
  } as ResolveContext;
}

describe("S194-DE review finding 1: a multi-day absence readout carries two raw ISO tokens", () => {
  it("'Sam Patel is off from today until a later day' -- the resolved record's own attempted/readout/summary each carry TWO raw YYYY-MM-DD tokens, not one", () => {
    const command: UnassignCommand = {
      intent: "unassign",
      operator: "Sam Patel",
      place: [],
      day: { kind: "date", iso: "2026-09-28" },
      span: null,
      existing: null,
      shift: null,
      // A four-day span: `fromIso` ("2026-09-28") and `toIso` ("2026-10-02")
      // are DIFFERENT, so `absenceOutcome`'s `dayPhrase` is
      // "from 2026-09-28 to 2026-10-02" -- two tokens in one string.
      until: { kind: "date", iso: "2026-10-02" },
    };
    const res = expandCommand(command, absenceCtx());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.absenceRecord).toBeDefined();
    const record = res.absenceRecord!;

    // The raw fact: both dates are present, unconverted, in the resolver's
    // own strings -- this much is correct (resolve.ts never renders a day
    // itself; CommandBar.tsx's renderReadout does that, once, at the end).
    expect(record.attempted).toContain("2026-09-28");
    expect(record.attempted).toContain("2026-10-02");
    expect(record.readout).toContain("2026-09-28");
    expect(record.readout).toContain("2026-10-02");
    expect(res.summary).toContain("2026-09-28");
    expect(res.summary).toContain("2026-10-02");

    // THE FINDING: once every one of those strings has gone through the
    // SAME single-pass rendering `CommandBar.tsx`'s own `renderReadout` (and
    // this file's mirror of it) applies to every readout/attempted/summary
    // before the thread shows it, the SECOND date is still raw. A person
    // reading the "Done" line, the "Not done"/"Not tried" line (R-432) or a
    // clean-sweep summary for a multi-day absence sees one spoken day and
    // one bare ISO string in the same sentence.
    const renderedAttempted = mirrorRenderReadout(record.attempted);
    const renderedReadout = mirrorRenderReadout(record.readout);
    const renderedSummary = mirrorRenderReadout(res.summary ?? "");
    expect(renderedAttempted).not.toContain("2026-10-02");
    expect(renderedReadout).not.toContain("2026-10-02");
    expect(renderedSummary).not.toContain("2026-10-02");
  });
});

// -----------------------------------------------------------------------
// Finding 2: the sweeping-unassign guard's strong/everyday asymmetry.
// -----------------------------------------------------------------------

const VERBS: VerbLists = {
  assign: ASSIGN_VERBS,
  book: BOOK_VERBS,
  unassign: [...UNASSIGN_VERBS, ...ABSENCE_WORDS],
  move: [...MOVE_VERBS, ...ADJUST_VERBS],
  headcount: HEADCOUNT_VERBS,
  replace: REPLACE_VERBS,
  swap: SWAP_VERBS,
  copy: [...COPY_VERBS, ...SAME_AS_WORDS],
  split: ["split"],
};

function sweepingUnassign(): UnassignCommand {
  return {
    intent: "unassign",
    operator: "everyone",
    place: [],
    day: null,
    span: null,
    existing: null,
    shift: null,
    until: null,
  };
}

describe("S194-DE review finding 2a: ten ordinary sentences that must NOT ground a clear-everyone still do (a STRONG word grounds alone, unconditionally)", () => {
  // Each of these means nothing about the board. All ten ground today,
  // because each carries a word from the STRONG half of the unassign list
  // (unassign/remove/clear/drop/cancel/delete/pull/free/sick/ill/absent/"on
  // leave"/"on holiday"/"on vacation") -- unlike the EVERYDAY half
  // (take/out/off/away), DEF-0041's fix never asks a strong word to be paired
  // with "everyone"/"everybody"/"board". Left RED on purpose (a case that
  // goes red is the finding, brief's own instruction): each asserts the
  // CORRECT behaviour (refuse), which the code does not yet give.
  const mustNotGround: Array<[string, string]> = [
    ["everyone is out to lunch", "out (everyday) + everyone (pair word)"],
    ["the board meeting is off", "off (everyday) + board (pair word)"],
    ["take the board down to the office", "take (everyday) + board (pair word)"],
    ["everybody take a break", "take (everyday) + everybody (pair word)"],
    ["clear skies today", "clear (STRONG, grounds alone)"],
    ["remove your gloves", "remove (STRONG, grounds alone)"],
    ["drop by my office", "drop (STRONG, grounds alone)"],
    ["pull up a chair", "pull (STRONG, grounds alone)"],
    ["cancel my lunch", "cancel (STRONG, grounds alone)"],
    ["free coffee in the break room", "free (STRONG, grounds alone)"],
  ];
  for (const [heard, why] of mustNotGround) {
    it(`FINDING: "${heard}" grounds a clear-everyone (${why}) -- it should refuse (sweeping)`, () => {
      const g = groundReading(heard, sweepingUnassign(), VERBS);
      expect(g.ok, `groundReading("${heard}") = ${JSON.stringify(g)}`).toBe(false);
    });
  }
});

describe("S194-DE review finding 2b: four genuine removal sentences that should ground a clear-everyone do not (no listed verb at all)", () => {
  // Real requests to clear the board, none using a word in EITHER half of
  // the unassign list -- refused outright today ("Did not run: nothing ...
  // says clear, remove or unassign. Say it again."), the opposite failure
  // from finding 2a. Left RED on purpose, same reason as above.
  const mustGround: Array<[string, string]> = [
    ["empty the board", '"empty" is not in UNASSIGN_VERBS or ABSENCE_WORDS at all'],
    ["send everyone home", '"send"/"home" are not in either list'],
  ];
  for (const [heard, why] of mustGround) {
    it(`FINDING: "${heard}" does not ground a clear-everyone (${why}) -- it should ground`, () => {
      const g = groundReading(heard, sweepingUnassign(), VERBS);
      expect(g.ok, `groundReading("${heard}") = ${JSON.stringify(g)}`).toBe(true);
    });
  }

  // The one sentence of the brief's five that DOES already work today --
  // kept GREEN, as a control: "off" (everyday) pairs with "everyone" (pair
  // word), which is exactly the case DEF-0041's fix was built for.
  it('CONTROL (passes today): "get everyone off" grounds -- off (everyday) + everyone (pair word)', () => {
    const g = groundReading("get everyone off", sweepingUnassign(), VERBS);
    expect(g.ok).toBe(true);
  });
});
