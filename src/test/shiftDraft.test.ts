/**
 * Acceptance suite for `src/features/admin/lib/shiftDraft.ts` — the pure half
 * of the shift-pattern admin section.
 *
 * A VITEST suite, because `npm run test` is what guards this permanently and
 * vitest collects every `src/test/*.test.ts`.
 *
 * ONE PLAIN `it()` PER CASE, never a table-driven one. A table's failure names
 * the row it was fed, not the rule that broke; every case below fails by the
 * sentence describing what is wrong with the module.
 *
 * ---------------------------------------------------------------------------
 * THE FIXTURE IS THE SEED'S NIGHT SHIFT, deliberately: `1320..1800` — 22:00
 * until 06:00 the next morning, stored UNWRAPPED, exactly as
 * `20260821000005_shifts.sql` allows and the seed writes it. Almost every
 * interesting case in this module is a consequence of that one row:
 *
 *   - a break at `1440..1455` reads 00:00–00:15 and IS inside it;
 *   - a break at `600..660` reads 10:00–11:00 and IS NOT, even though those
 *     are hours a human would call "daytime";
 *   - `1440` is `"00:00 +1d"`, not `"00:00"`;
 *   - and `1320..1800` does NOT collide with `0..480`, because the database's
 *     exclusion constraint compares the raw minutes and never wraps.
 *
 * Getting any of those backwards is a `%1440` somewhere, which is the exact
 * bug this module exists to make impossible.
 */
import { describe, expect, it } from "vitest";
import {
  addedProblems,
  breakProblems,
  clockToMinutes,
  dayOffset,
  describeSpan,
  durationLabel,
  labelToMinutes,
  minutesToClock,
  minutesToLabel,
  overlappingShifts,
  patternRows,
  spansOverlap,
  validatePatternDraft,
  type BreakSpan,
  type PatternDraft,
  type ShiftDraft,
} from "@/features/admin/lib/shiftDraft";
import type { ShiftPatternsPayload } from "@/lib/api";

/** 22:00 -> 06:00 the next morning. The seed's own row. */
const NIGHT = { startMin: 1320, endMin: 1800 };
/** 06:00 -> 14:00. */
const DAY = { startMin: 360, endMin: 840 };

function brk(id: string, startMin: number, endMin: number, name = "Break"): BreakSpan {
  return { id, name, startMin, endMin };
}

function shiftDraft(over: Partial<ShiftDraft> = {}): ShiftDraft {
  return {
    id: null,
    name: "Nights",
    startMin: 1320,
    endMin: 1800,
    breaks: [],
    ...over,
  };
}

function patternDraft(over: Partial<PatternDraft> = {}): PatternDraft {
  return { id: null, name: "Standard", shifts: [shiftDraft()], ...over };
}

function messages(draft: PatternDraft, existing: readonly string[] = []): string[] {
  return validatePatternDraft(draft, existing).problems.map((p) => p.message);
}

/* ===========================================================================
 * A — CLOCK LABELS. Minutes never reach the screen.
 * =========================================================================== */

describe("shiftDraft: minutes to a clock a person reads", () => {
  it("prints a morning start as a plain clock face", () => {
    expect(minutesToLabel(360)).toBe("06:00");
  });

  it("prints midnight at the start of the day with no day marker", () => {
    expect(minutesToLabel(0)).toBe("00:00");
  });

  it("prints a past-midnight end as the clock plus the day it lands on", () => {
    expect(minutesToLabel(1500)).toBe("01:00 +1d");
  });

  it("prints 1440 as 00:00 +1d, not as bare 00:00", () => {
    expect(minutesToLabel(1440)).toBe("00:00 +1d");
  });

  it("prints the seed night shift's end as 06:00 +1d", () => {
    expect(minutesToLabel(1800)).toBe("06:00 +1d");
  });

  it("gives the last minute of the first day no day marker", () => {
    expect(minutesToLabel(1439)).toBe("23:59");
  });

  it("strips the day off a clock face for a time input's value", () => {
    expect(minutesToClock(1500)).toBe("01:00");
  });

  it("puts 1440 on day 1 and 1439 on day 0", () => {
    expect([dayOffset(1439), dayOffset(1440)]).toEqual([0, 1]);
  });

  it("refuses to invent a clock for a non-number", () => {
    expect(minutesToLabel(Number.NaN)).toBe("--:--");
  });
});

describe("shiftDraft: whole spans", () => {
  it("describes a day shift as one range", () => {
    expect(describeSpan(DAY)).toBe("06:00–14:00");
  });

  it("describes the night shift with the day marker on the end only", () => {
    expect(describeSpan(NIGHT)).toBe("22:00–06:00 +1d");
  });

  it("reports the night shift's length in whole hours", () => {
    expect(durationLabel(NIGHT)).toBe("8h");
  });

  it("reports a part-hour length with both units", () => {
    expect(durationLabel({ startMin: 0, endMin: 450 })).toBe("7h 30m");
  });

  it("reports a sub-hour break in minutes alone", () => {
    expect(durationLabel({ startMin: 360, endMin: 405 })).toBe("45m");
  });

  it("refuses to report a length for a reversed span", () => {
    expect(durationLabel({ startMin: 800, endMin: 400 })).toBe("—");
  });
});

/* ===========================================================================
 * B — BACK FROM A CONTROL. `null`, never NaN, never a guess.
 * =========================================================================== */

describe("shiftDraft: reading a time back off the screen", () => {
  it("reads a plain clock face", () => {
    expect(labelToMinutes("06:00")).toBe(360);
  });

  it("reads a past-midnight label the way it was printed", () => {
    expect(labelToMinutes("01:00 +1d")).toBe(1500);
  });

  it("reads a past-midnight label typed without the space or the d", () => {
    expect(labelToMinutes("01:00+1")).toBe(1500);
  });

  it("reads a single-digit hour", () => {
    expect(labelToMinutes("6:00")).toBe(360);
  });

  it("accepts 24:00 as the end of the day, since that is how people write it", () => {
    expect(labelToMinutes("24:00")).toBe(1440);
  });

  it("refuses an hour past 24", () => {
    expect(labelToMinutes("25:00")).toBeNull();
  });

  it("refuses 24 past the exact hour", () => {
    expect(clockToMinutes("24:30")).toBeNull();
  });

  it("refuses a minute past 59", () => {
    expect(labelToMinutes("06:60")).toBeNull();
  });

  it("refuses an empty control rather than calling it midnight", () => {
    expect(labelToMinutes("")).toBeNull();
  });

  it("refuses a half-typed value rather than calling it midnight", () => {
    expect(labelToMinutes("06:")).toBeNull();
  });

  it("combines a clock face and a day offset", () => {
    expect(clockToMinutes("01:00", 1)).toBe(1500);
  });

  it("round-trips the seed night shift's end through its own label", () => {
    expect(labelToMinutes(minutesToLabel(1800))).toBe(1800);
  });
});

/* ===========================================================================
 * C — OVERLAP, mirroring `shifts_no_overlap_within_template`.
 * =========================================================================== */

describe("shiftDraft: the exclusion constraint, in JS", () => {
  it("lets two shifts touch end-to-start, which is what a real day looks like", () => {
    expect(spansOverlap(DAY, { startMin: 840, endMin: 1320 })).toBe(false);
  });

  it("catches two shifts that share minutes", () => {
    expect(spansOverlap(DAY, { startMin: 800, endMin: 900 })).toBe(true);
  });

  it("treats an empty range as overlapping nothing, exactly as int4range does", () => {
    expect(spansOverlap({ startMin: 600, endMin: 600 }, DAY)).toBe(false);
  });

  it("catches a shift fully contained in another", () => {
    expect(spansOverlap({ startMin: 400, endMin: 500 }, DAY)).toBe(true);
  });

  it("reports nothing for a clean three-shift day", () => {
    const shifts = [
      { id: "a", name: "Early", startMin: 360, endMin: 840 },
      { id: "b", name: "Late", startMin: 840, endMin: 1320 },
      { id: "c", name: "Nights", startMin: 1320, endMin: 1800 },
    ];
    expect(overlappingShifts(shifts)).toEqual([]);
  });

  it("reports the colliding pair earlier-start first", () => {
    const shifts = [
      { id: "late", name: "Late", startMin: 800, endMin: 1200 },
      { id: "early", name: "Early", startMin: 360, endMin: 840 },
    ];
    expect(overlappingShifts(shifts)).toEqual([{ aId: "early", bId: "late" }]);
  });

  it("does NOT wrap the night shift onto the next morning, because the database does not", () => {
    const shifts = [
      { id: "night", name: "Nights", startMin: 1320, endMin: 1800 },
      { id: "early", name: "Early", startMin: 0, endMin: 480 },
    ];
    expect(overlappingShifts(shifts)).toEqual([]);
  });

  it("still catches two night shifts that really do share unwrapped minutes", () => {
    const shifts = [
      { id: "n1", name: "Nights", startMin: 1320, endMin: 1800 },
      { id: "n2", name: "Nights B", startMin: 1400, endMin: 1900 },
    ];
    expect(overlappingShifts(shifts)).toEqual([{ aId: "n1", bId: "n2" }]);
  });
});

/* ===========================================================================
 * D — BREAKS. The database checks `end_min > start_min` and nothing else, so
 * everything below is the only check there is.
 * =========================================================================== */

describe("shiftDraft: breaks against their shift", () => {
  it("accepts a break at 00:00 the next morning as inside the 22:00–06:00 shift", () => {
    expect(breakProblems(NIGHT, [brk("b", 1440, 1455)])).toEqual([]);
  });

  it("rejects a 10:00 break on that same shift, however daytime it looks", () => {
    const kinds = breakProblems(NIGHT, [brk("b", 600, 660)]).map((p) => p.kind);
    expect(kinds).toEqual(["outside-shift"]);
  });

  it("says which shift a stray break fell outside of, in clock times", () => {
    const [problem] = breakProblems(NIGHT, [brk("b", 600, 660)]);
    expect(problem.message).toBe("10:00–11:00 falls outside the shift (22:00–06:00 +1d).");
  });

  it("accepts a break flush against the start of the shift", () => {
    expect(breakProblems(NIGHT, [brk("b", 1320, 1350)])).toEqual([]);
  });

  it("accepts a break flush against the end of the shift", () => {
    expect(breakProblems(NIGHT, [brk("b", 1770, 1800)])).toEqual([]);
  });

  it("rejects a break that starts before the shift does", () => {
    const kinds = breakProblems(NIGHT, [brk("b", 1300, 1340)]).map((p) => p.kind);
    expect(kinds).toEqual(["outside-shift"]);
  });

  it("rejects a break that runs past the end of the shift", () => {
    const kinds = breakProblems(NIGHT, [brk("b", 1770, 1830)]).map((p) => p.kind);
    expect(kinds).toEqual(["outside-shift"]);
  });

  it("rejects a zero-length break", () => {
    const kinds = breakProblems(NIGHT, [brk("b", 1400, 1400)]).map((p) => p.kind);
    expect(kinds).toEqual(["empty"]);
  });

  it("rejects a reversed break", () => {
    const kinds = breakProblems(NIGHT, [brk("b", 1500, 1400)]).map((p) => p.kind);
    expect(kinds).toEqual(["empty"]);
  });

  it("does not also call an empty break outside its shift", () => {
    const problems = breakProblems(NIGHT, [brk("b", 600, 600)]);
    expect(problems).toHaveLength(1);
  });

  it("lets two breaks sit back to back", () => {
    expect(breakProblems(NIGHT, [brk("a", 1440, 1470), brk("b", 1470, 1500)])).toEqual([]);
  });

  it("reports an overlap between two breaks on both of them", () => {
    const problems = breakProblems(NIGHT, [brk("a", 1440, 1500), brk("b", 1470, 1530)]);
    expect(problems.map((p) => p.breakId)).toEqual(["a", "b"]);
  });

  it("names the other break in the overlap message", () => {
    const problems = breakProblems(NIGHT, [
      brk("a", 1440, 1500, "Lunch"),
      brk("b", 1470, 1530, "Tea"),
    ]);
    expect(problems[0].message).toBe("Overlaps Tea.");
  });

  it("points each overlap message at the other break's id", () => {
    const problems = breakProblems(NIGHT, [brk("a", 1440, 1500), brk("b", 1470, 1530)]);
    expect(problems.map((p) => p.otherBreakId)).toEqual(["b", "a"]);
  });

  it("falls back to 'another break' when the other one has no name", () => {
    const problems = breakProblems(NIGHT, [
      brk("a", 1440, 1500, "Lunch"),
      brk("b", 1470, 1530, "   "),
    ]);
    expect(problems[0].message).toBe("Overlaps another break.");
  });

  it("does not count an empty break as overlapping anything", () => {
    const problems = breakProblems(NIGHT, [brk("a", 1440, 1440), brk("b", 1430, 1500)]);
    expect(problems.map((p) => p.kind)).toEqual(["empty"]);
  });

  it("reports both faults when a break is outside the shift and overlaps another", () => {
    const problems = breakProblems(NIGHT, [brk("a", 600, 700), brk("b", 650, 750)]);
    expect(problems.map((p) => p.kind).sort()).toEqual([
      "outside-shift",
      "outside-shift",
      "overlaps-break",
      "overlaps-break",
    ]);
  });
});

/* ===========================================================================
 * E — THE DRAFT. What would stop this saving.
 * =========================================================================== */

describe("shiftDraft: validating a pattern before it is written", () => {
  it("passes a clean overnight pattern", () => {
    expect(validatePatternDraft(patternDraft()).ok).toBe(true);
  });

  it("asks for a pattern name", () => {
    expect(messages(patternDraft({ name: "   " }))).toContain("Give this shift pattern a name.");
  });

  it("hands back the trimmed name, because nothing trims it server-side", () => {
    expect(validatePatternDraft(patternDraft({ name: "  Standard  " })).name).toBe("Standard");
  });

  it("compares the trimmed name against the ones already taken", () => {
    const v = validatePatternDraft(patternDraft({ name: " Standard " }), ["Standard"]);
    expect(v.ok).toBe(false);
  });

  it("says a duplicate name is taken across the whole company, not just this site", () => {
    expect(messages(patternDraft(), ["Standard"])).toContain(
      "Another shift pattern in this company already uses that name.",
    );
  });

  it("treats a different case as a different name, because the unique index does", () => {
    expect(validatePatternDraft(patternDraft({ name: "standard" }), ["Standard"]).ok).toBe(true);
  });

  it("asks for at least one shift", () => {
    expect(messages(patternDraft({ shifts: [] }))).toContain("Add at least one shift.");
  });

  it("asks for a shift name", () => {
    const draft = patternDraft({ shifts: [shiftDraft({ name: " " })] });
    expect(messages(draft)).toContain("Give this shift a name.");
  });

  it("asks for times that have not been entered yet", () => {
    const draft = patternDraft({ shifts: [shiftDraft({ endMin: null })] });
    expect(messages(draft)).toContain("Enter a start and an end time.");
  });

  it("points a backwards night shift at the +1 day marker instead of refusing blankly", () => {
    const draft = patternDraft({ shifts: [shiftDraft({ startMin: 1320, endMin: 360 })] });
    expect(messages(draft)).toContain(
      "This shift ends before it starts. For a night shift, mark the end as +1 day.",
    );
  });

  it("refuses a shift longer than 24 hours, as the CHECK does", () => {
    const draft = patternDraft({ shifts: [shiftDraft({ startMin: 0, endMin: 1441 })] });
    expect(messages(draft)).toContain("A shift can't be longer than 24 hours.");
  });

  it("refuses a start outside the day it belongs to, as the CHECK does", () => {
    const draft = patternDraft({ shifts: [shiftDraft({ startMin: 1440, endMin: 1500 })] });
    expect(messages(draft)).toContain("A shift has to start within the day it belongs to.");
  });

  it("accepts a start at the last minute of the day", () => {
    const draft = patternDraft({ shifts: [shiftDraft({ startMin: 1439, endMin: 1800 })] });
    expect(validatePatternDraft(draft).ok).toBe(true);
  });

  it("catches two drafted shifts that overlap each other", () => {
    const draft = patternDraft({
      shifts: [
        shiftDraft({ name: "Early", startMin: 360, endMin: 840 }),
        shiftDraft({ name: "Late", startMin: 800, endMin: 1200 }),
      ],
    });
    expect(messages(draft)).toContain(
      "Early overlaps Late — two shifts in one pattern can't share minutes.",
    );
  });

  it("anchors the overlap problem to the earlier shift's row", () => {
    const draft = patternDraft({
      shifts: [
        shiftDraft({ name: "Early", startMin: 360, endMin: 840 }),
        shiftDraft({ name: "Late", startMin: 800, endMin: 1200 }),
      ],
    });
    const overlap = validatePatternDraft(draft).problems.find((p) => p.field === "shift-overlap");
    expect(overlap?.shiftIndex).toBe(0);
  });

  it("does not report an overlap between a night shift and the next morning's", () => {
    const draft = patternDraft({
      shifts: [
        shiftDraft({ name: "Nights", startMin: 1320, endMin: 1800 }),
        shiftDraft({ name: "Early", startMin: 0, endMin: 480 }),
      ],
    });
    expect(validatePatternDraft(draft).ok).toBe(true);
  });

  it("surfaces a break problem against the break's own row", () => {
    const draft = patternDraft({
      shifts: [
        shiftDraft({
          breaks: [{ id: null, name: "Lunch", startMin: 600, endMin: 660 }],
        }),
      ],
    });
    const problem = validatePatternDraft(draft).problems.find((p) => p.field === "break-time");
    expect([problem?.shiftIndex, problem?.breakIndex]).toEqual([0, 0]);
  });

  it("accepts a break that lands after midnight on a night shift", () => {
    const draft = patternDraft({
      shifts: [
        shiftDraft({
          breaks: [{ id: null, name: "Lunch", startMin: 1440, endMin: 1455 }],
        }),
      ],
    });
    expect(validatePatternDraft(draft).ok).toBe(true);
  });

  it("treats a break with no times as empty rather than crashing on null", () => {
    const draft = patternDraft({
      shifts: [shiftDraft({ breaks: [{ id: null, name: "Lunch", startMin: null, endMin: null }] })],
    });
    expect(validatePatternDraft(draft).ok).toBe(false);
  });

  it("skips break checks for a shift whose own times are unusable", () => {
    const draft = patternDraft({
      shifts: [
        shiftDraft({
          startMin: 1320,
          endMin: 360,
          breaks: [{ id: null, name: "Lunch", startMin: 1440, endMin: 1455 }],
        }),
      ],
    });
    expect(validatePatternDraft(draft).problems.filter((p) => p.field === "break-time")).toEqual([]);
  });
});

/* ===========================================================================
 * F — THE READ, ASSEMBLED. Skip and COUNT; never blank the panel.
 * =========================================================================== */

function payload(over: Partial<ShiftPatternsPayload> = {}): ShiftPatternsPayload {
  return { templates: [], shifts: [], breaks: [], attachments: [], nodes: [], ...over };
}

const PLANT = { id: "n-plant", name: "Plant 1", parentId: null, path: "plant1" };
const LINE = { id: "n-line", name: "Line A", parentId: "n-plant", path: "plant1.linea" };
const OWNED = { id: "t-owned", name: "Plant 1 nights", siteNodeId: "n-plant" };
// ⭐ 0028 / D108: this was `siteNodeId: null` — the company-wide pattern. There
// is no such row now. It keeps its name and its role in this file (the pattern
// whose OWNER the fixture deliberately does not supply a node for, so
// `ownerLabel` has to fall back) but the owner is a real node id the fixture
// omits from `nodes`, which is the state that still exists: a row you can read
// whose owning node you cannot name.
const SHARED = { id: "t-shared", name: "Company standard", siteNodeId: "n-elsewhere" };

/** The seed's night shift, on the site-owned pattern. */
const NIGHT_ROW = {
  id: "s-night",
  templateId: "t-owned",
  name: "Nights",
  startMin: 1320,
  endMin: 1800,
};

describe("shiftDraft: assembling what the panel draws", () => {
  it("returns an empty view rather than throwing when the query has not resolved", () => {
    expect(patternRows(undefined)).toEqual({ patterns: [], nodes: [], skipped: 0 });
  });

  it("⭐ (rewritten by 0028) labels a pattern whose owner it cannot name as another site, never as everyone's", () => {
    // Was: "labels a pattern no site owns as company-wide". D108 deleted the
    // state and the label with it. What survives is the distinction that
    // mattered — "I cannot see where this lives" must never render as "anyone
    // may use this".
    const view = patternRows(payload({ templates: [SHARED] }));
    expect(view.patterns[0].ownerLabel).toBe("Another site");
  });

  it("labels an owned pattern with its site's name, never a uuid", () => {
    const view = patternRows(payload({ templates: [OWNED], nodes: [PLANT] }));
    expect(view.patterns[0].ownerLabel).toBe("Plant 1");
  });

  it("says 'Another site' when the owning node is not in the payload", () => {
    const view = patternRows(payload({ templates: [OWNED] }));
    expect(view.patterns[0].ownerLabel).toBe("Another site");
  });

  it("sorts patterns by name", () => {
    const view = patternRows(payload({ templates: [OWNED, SHARED], nodes: [PLANT] }));
    expect(view.patterns.map((p) => p.name)).toEqual(["Company standard", "Plant 1 nights"]);
  });

  it("counts a template row the guard could not read", () => {
    const view = patternRows(payload({ templates: [SHARED, null] }));
    expect(view.skipped).toBe(1);
  });

  it("still draws the readable patterns beside the one it skipped", () => {
    const view = patternRows(payload({ templates: [SHARED, null] }));
    expect(view.patterns).toHaveLength(1);
  });

  it("counts a shift whose pattern is not in the payload", () => {
    const view = patternRows(payload({ templates: [SHARED], shifts: [NIGHT_ROW] }));
    expect(view.skipped).toBe(1);
  });

  it("counts a break whose shift is not in the payload", () => {
    const view = patternRows(
      payload({
        templates: [OWNED],
        breaks: [{ id: "b1", shiftId: "s-missing", name: "Lunch", startMin: 1, endMin: 2 }],
      }),
    );
    expect(view.skipped).toBe(1);
  });

  it("counts an attachment pointing at a pattern that is not there", () => {
    const view = patternRows(
      payload({ templates: [SHARED], attachments: [{ nodeId: "n-plant", templateId: "t-gone" }] }),
    );
    expect(view.skipped).toBe(1);
  });

  it("counts a node row the guard could not read", () => {
    const view = patternRows(payload({ nodes: [PLANT, null] }));
    expect(view.skipped).toBe(1);
  });

  it("counts how many nodes hold a pattern, which is what blocks deleting it", () => {
    const view = patternRows(
      payload({
        templates: [OWNED],
        nodes: [PLANT, LINE],
        attachments: [
          { nodeId: "n-plant", templateId: "t-owned" },
          { nodeId: "n-line", templateId: "t-owned" },
        ],
      }),
    );
    expect(view.patterns[0].attachedCount).toBe(2);
  });

  it("names the nodes holding a pattern", () => {
    const view = patternRows(
      payload({
        templates: [OWNED],
        nodes: [PLANT],
        attachments: [{ nodeId: "n-plant", templateId: "t-owned" }],
      }),
    );
    expect(view.patterns[0].attachedNodeIds).toEqual(["n-plant"]);
  });

  it("orders a pattern's shifts by when they start", () => {
    const view = patternRows(
      payload({
        templates: [OWNED],
        shifts: [
          NIGHT_ROW,
          { id: "s-early", templateId: "t-owned", name: "Early", startMin: 360, endMin: 840 },
        ],
      }),
    );
    expect(view.patterns[0].shifts.map((s) => s.name)).toEqual(["Early", "Nights"]);
  });

  it("labels a saved night shift in clock times with the day marker", () => {
    const view = patternRows(payload({ templates: [OWNED], shifts: [NIGHT_ROW] }));
    expect(view.patterns[0].shifts[0].span).toBe("22:00–06:00 +1d");
  });

  it("marks a shift that runs past its own midnight", () => {
    const view = patternRows(payload({ templates: [OWNED], shifts: [NIGHT_ROW] }));
    expect(view.patterns[0].shifts[0].crossesMidnight).toBe(true);
  });

  it("orders a shift's breaks by when they start", () => {
    const view = patternRows(
      payload({
        templates: [OWNED],
        shifts: [NIGHT_ROW],
        breaks: [
          { id: "b2", shiftId: "s-night", name: "Second", startMin: 1620, endMin: 1635 },
          { id: "b1", shiftId: "s-night", name: "First", startMin: 1440, endMin: 1455 },
        ],
      }),
    );
    expect(view.patterns[0].shifts[0].breaks.map((b) => b.name)).toEqual(["First", "Second"]);
  });

  it("accepts an after-midnight break already saved against a night shift", () => {
    const view = patternRows(
      payload({
        templates: [OWNED],
        shifts: [NIGHT_ROW],
        breaks: [{ id: "b1", shiftId: "s-night", name: "Lunch", startMin: 1440, endMin: 1455 }],
      }),
    );
    expect(view.patterns[0].shifts[0].problems).toEqual([]);
  });

  it("flags a saved break that the database happily let sit outside its shift", () => {
    const view = patternRows(
      payload({
        templates: [OWNED],
        shifts: [NIGHT_ROW],
        breaks: [{ id: "b1", shiftId: "s-night", name: "Lunch", startMin: 600, endMin: 660 }],
      }),
    );
    expect(view.patterns[0].shifts[0].problems.map((p) => p.kind)).toEqual(["outside-shift"]);
  });

  it("still draws a break that is outside its shift, because hiding it hides the fault", () => {
    const view = patternRows(
      payload({
        templates: [OWNED],
        shifts: [NIGHT_ROW],
        breaks: [{ id: "b1", shiftId: "s-night", name: "Lunch", startMin: 600, endMin: 660 }],
      }),
    );
    expect(view.patterns[0].shifts[0].breaks).toHaveLength(1);
  });

  it("reports nothing wrong with a pattern whose shifts merely touch", () => {
    const view = patternRows(
      payload({
        templates: [OWNED],
        shifts: [
          { id: "s1", templateId: "t-owned", name: "Early", startMin: 360, endMin: 840 },
          { id: "s2", templateId: "t-owned", name: "Late", startMin: 840, endMin: 1320 },
        ],
      }),
    );
    expect(view.patterns[0].overlaps).toEqual([]);
  });

  it("tells a node which pattern is attached to it by name", () => {
    const view = patternRows(
      payload({
        templates: [SHARED],
        nodes: [PLANT],
        attachments: [{ nodeId: "n-plant", templateId: "t-shared" }],
      }),
    );
    expect(view.nodes[0].templateName).toBe("Company standard");
  });

  it("leaves a node with no attachment of its own pointing at nothing", () => {
    const view = patternRows(payload({ templates: [SHARED], nodes: [PLANT] }));
    expect(view.nodes[0].templateId).toBeNull();
  });

  it("derives a node's depth from its ltree path so the picker can indent", () => {
    const view = patternRows(payload({ nodes: [PLANT, LINE] }));
    expect(view.nodes.map((n) => n.depth)).toEqual([0, 1]);
  });
});

/* ---------------------------------------------------------------------------
   GROUP V — THE SIX THINGS THE ADVERSARIAL PASS FOUND UNPINNED (27 Aug).

   Every case below was written because a deliberate break of the module went
   NOT CAUGHT by the 96 cases above. Four of them were holes over code that was
   already right (V1, V2, V3, V4); two were holes over code that was WRONG, and
   the fix went in with them (V5, V6). A boundary nobody asserts is a boundary
   that can move in either direction without a word.
   --------------------------------------------------------------------------- */
describe("shiftDraft: the boundaries the first pass left unpinned", () => {
  it("V1: patternRows carries the overlap answer through to the view", () => {
    // `overlaps: overlappingShifts(shifts)` -> `overlaps: []` was NOT CAUGHT:
    // group C proves the function, nothing proved the WIRING. The panel's
    // "Two of these shifts share minutes" banner hangs off this field.
    const view = patternRows(
      payload({
        templates: [OWNED],
        shifts: [
          { id: "s1", templateId: "t-owned", name: "Early", startMin: 360, endMin: 840 },
          { id: "s2", templateId: "t-owned", name: "Handover", startMin: 810, endMin: 870 },
        ],
      }),
    );
    expect(view.patterns[0].overlaps.length).toBe(1);
  });

  it("V2: accepts a shift of exactly 24 hours, as the CHECK does", () => {
    // 06:00 -> 06:00 +1d. `end_min - start_min <= 1440` allows it. Turning the
    // module's `>` into `>=` refused every one of these and was NOT CAUGHT --
    // the nearest case only ever fed 1441.
    expect(messages(patternDraft({ shifts: [shiftDraft({ startMin: 360, endMin: 1800 })] }))).toEqual(
      [],
    );
  });

  it("V3: refuses a shift that ends on the very minute it starts", () => {
    // 06:00 -> 06:00 with no +1d is zero-length. Turning `<=` into `<` let it
    // through to a raw 23514 from the CHECK, and was NOT CAUGHT.
    expect(messages(patternDraft({ shifts: [shiftDraft({ startMin: 360, endMin: 360 })] }))).toEqual([
      "This shift ends before it starts. For a night shift, mark the end as +1 day.",
    ]);
  });

  it("V4: a break with an unreadable bound is reported once, and pairs with nothing", () => {
    // ⚠️ MEASURED VERDICT: `usable`'s filter is INERT, not untested. Dropping
    // it entirely is still NOT CAUGHT after this case, and that is correct --
    // `spansOverlap` guards empty ranges itself, and every comparison against
    // NaN is false, so no input exists where the filter changes an answer. It
    // is defensive duplication and may stay. What this case DOES pin is the
    // output that matters: an unreadable bound surfaces as exactly one
    // "empty", never as a phantom overlap and never silently dropped.
    const problems = breakProblems(NIGHT, [brk("a", Number.NaN, 1500), brk("b", 1430, 1520)]);
    expect(problems.map((p) => p.kind)).toEqual(["empty"]);
  });

  it("V5: a shift that ends exactly at midnight crosses midnight", () => {
    // 16:00 -> 00:00 is stored 960..1440. `span` says "+1d" and `dayOffset`
    // says 1; `crossesMidnight` said false, and that flag is what gives the
    // break form its "+1 day" box. Without it the legal 23:45-00:00 break was
    // unenterable. The three answers must agree.
    const view = patternRows(
      payload({
        templates: [OWNED],
        shifts: [{ id: "s1", templateId: "t-owned", name: "Evening", startMin: 960, endMin: 1440 }],
      }),
    );
    const shift = view.patterns[0].shifts[0];
    expect([shift.span, shift.crossesMidnight]).toEqual(["16:00–00:00 +1d", true]);
  });

  it("V6: a break that starts after midnight says so on the START, not only the end", () => {
    // The seed stores three breaks past 1440 on its night shift. Marking the
    // end only, `{1440,1455}` and `{0,1455}` -- two different, both-storable
    // rows -- rendered the SAME string.
    expect(describeSpan({ startMin: 1440, endMin: 1455 })).toBe("00:00 +1d–00:15 +1d");
    expect(describeSpan({ startMin: 0, endMin: 1455 })).toBe("00:00–00:15 +1d");
  });

  it("V7: a plain day shift gains no day markers from V6's fix", () => {
    expect(describeSpan(DAY)).toBe("06:00–14:00");
  });
});

/* ---------------------------------------------------------------------------
   GROUP W — `addedProblems`: only the problems THIS change is responsible for.

   It moved out of `ShiftsPanel.tsx` on 27 Aug, where it was pure logic with no
   test that could reach it — and where it had shipped a defect that made a
   shift's times permanently uneditable. W3 is that defect, pinned.
   --------------------------------------------------------------------------- */
describe("shiftDraft: the problems a change is responsible for", () => {
  /** A pattern with one night shift carrying one break, both configurable. */
  function pat(endMin: number, breaks: { name: string; startMin: number; endMin: number }[]) {
    return {
      id: "t1",
      name: "3 x 8h",
      shifts: [
        {
          id: "s3",
          name: "Shift 3",
          startMin: 1320,
          endMin,
          breaks: breaks.map((b) => ({ id: b.name, ...b })),
        },
      ],
    };
  }

  it("W1: reports a problem the change actually introduced", () => {
    const before = pat(1800, []);
    const after = pat(1800, [{ name: "Stray", startMin: 600, endMin: 660 }]);
    expect(addedProblems(before, after)).toEqual([
      "10:00–11:00 falls outside the shift (22:00–06:00 +1d).",
    ]);
  });

  it("W2: stays silent about a problem that was already there", () => {
    const stray = [{ name: "Stray", startMin: 600, endMin: 660 }];
    expect(addedProblems(pat(1800, stray), pat(1800, stray))).toEqual([]);
  });

  it("W3: a stray break does not block an edit to the SHIFT's own times", () => {
    // ⚠️ THE 27-AUG DEFECT. The outside-shift sentence embeds the shift's own
    // label, so moving the end 06:00 -> 06:30 rewrites it. Keyed on the TEXT,
    // the untouched break's problem read as one this edit had added and the
    // save never left the browser — with the refusal quoting the break rather
    // than the times just changed, and no way out except deleting the break.
    const stray = [{ name: "Stray", startMin: 600, endMin: 660 }];
    expect(addedProblems(pat(1800, stray), pat(1830, stray))).toEqual([]);
  });

  it("W4: two breaks with the SAME sentence are two problems, not one", () => {
    // The other half of keying on coordinates: identical text at different
    // coordinates must not collapse, or adding a second identical mistake
    // would report nothing at all.
    const one = [{ name: "A", startMin: 600, endMin: 660 }];
    const two = [
      { name: "A", startMin: 600, endMin: 660 },
      { name: "B", startMin: 600, endMin: 660 },
    ];
    // B's sentence is WORD-FOR-WORD A's, and A's was already in the "before"
    // set. It still comes through, because A's problem is (break-time, 0, 0)
    // and B's is (break-time, 0, 1). Keyed on the text it would have been
    // swallowed and the second mistake would have reported nothing at all.
    // The overlap is real too: two breaks on the same minutes collide.
    expect(addedProblems(pat(1800, one), pat(1800, two))).toEqual([
      "10:00–11:00 falls outside the shift (22:00–06:00 +1d).",
      "Overlaps A.",
    ]);
  });

  it("W6: two problems of DIFFERENT kinds on one shift do not collide", () => {
    // ⚠️ Found by mutation: dropping `field` from the key went NOT CAUGHT, and
    // it is a real hole rather than an inert change. A shift-name problem and a
    // shift-time problem both carry (shiftIndex 0, breakIndex null), so without
    // the field they key identically — and a shift that already had a naming
    // problem could then be given an illegal time and the save would go through
    // silently. The pre-existing problem must mask ITSELF and nothing else.
    const named = (name: string, endMin: number) => ({
      id: "t1",
      name: "3 x 8h",
      shifts: [{ id: "s1", name, startMin: 360, endMin, breaks: [] }],
    });
    expect(addedProblems(named("", 840), named("", 360))).toEqual([
      "This shift ends before it starts. For a night shift, mark the end as +1 day.",
    ]);
  });

  it("W5: a problem that is FIXED by the change is not reported as added", () => {
    const stray = [{ name: "Stray", startMin: 600, endMin: 660 }];
    const moved = [{ name: "Stray", startMin: 1440, endMin: 1500 }];
    expect(addedProblems(pat(1800, stray), pat(1800, moved))).toEqual([]);
  });
});
