import { describe, expect, it, vi } from "vitest";
import type { CapacityProbe, CapacityProbeOverlap, SchedulerError } from "@/lib/api";
import {
  busyElsewhereSentence,
  explainCapacityRefusal,
  isBusyElsewhere,
  outsideRows,
  type CapacityAttempt,
} from "@/features/board/lib/busyElsewhere";
import { formatDayLabel } from "@/features/board/lib/time";

/**
 * R-465 (S195-D, the maintainer, 30 Sept): a person busy on a place the caller
 * cannot read is told the PLACE and the HOURS -- never the product or the job:
 * "Priya Shah is already on Cell 4 in Line 2 today from 6 am to 2 pm." Every day
 * and hour is the PLANT'S (R-426), so the cases that depend on the clock hold it
 * still and run it on both sides of UTC.
 */

const CHICAGO = "America/Chicago"; // UTC-5 on these dates (CDT)
const TOKYO = "Asia/Tokyo"; // UTC+9

/** An outside row as `capacity_probe` returns it: a place and hours, no ids, no product. */
function outside(
  nodeName: string,
  parentName: string | null,
  startUtc: string,
  endUtc: string,
): CapacityProbeOverlap {
  return {
    assignmentId: null,
    nodeId: null,
    nodeName,
    parentName,
    productName: null,
    timerange: `["${startUtc}+00","${endUtc}+00")`,
    efficiency: 1,
    outside: true,
  };
}

/** A row the caller CAN read: it has its ids and a product the sentence must never name. */
const READABLE: CapacityProbeOverlap = {
  assignmentId: "asg-1",
  nodeId: "node-1",
  nodeName: "Cell 1",
  parentName: "Line 1",
  productName: "Housing A",
  timerange: '["2026-09-30 15:00:00+00","2026-09-30 17:00:00+00")',
  efficiency: 1,
  outside: false,
};

// 6 am to 2 pm on Wed 30 Sept in Chicago.
const PRIYA_CELL_4 = outside("Cell 4", "Line 2", "2026-09-30 11:00:00", "2026-09-30 19:00:00");

function say(
  rows: CapacityProbeOverlap[],
  over: Partial<{ zone: string; now: Date; dateFormat: "d_mon_yyyy" | "mdy_slash" }> = {},
): string | null {
  return busyElsewhereSentence({
    person: "Priya Shah",
    rows,
    zone: over.zone ?? CHICAGO,
    dateFormat: over.dateFormat ?? "d_mon_yyyy",
    now: over.now ?? new Date("2026-09-30T18:00:00Z"), // 1 pm Wed in Chicago
  });
}

describe("busyElsewhereSentence (R-465)", () => {
  it("BE-1: one outside block is the place and the hours, exactly the maintainer's sentence", () => {
    expect(say([PRIYA_CELL_4])).toBe(
      "Priya Shah is already on Cell 4 in Line 2 today from 6 am to 2 pm.",
    );
  });

  it("BE-2: two outside blocks are joined with 'and', in the order they start, whatever order the server sent", () => {
    const evening = outside("Cell 5", "Line 2", "2026-09-30 20:00:00", "2026-10-01 01:00:00");
    const expected =
      "Priya Shah is already on Cell 4 in Line 2 today from 6 am to 2 pm and Cell 5 in Line 2 today from 3 pm to 8 pm.";
    expect(say([PRIYA_CELL_4, evening])).toBe(expected);
    expect(say([evening, PRIYA_CELL_4])).toBe(expected);
  });

  it("BE-3: three blocks read 'a, b and c'", () => {
    const b = outside("Cell 5", "Line 2", "2026-09-30 20:00:00", "2026-09-30 22:00:00");
    const c = outside("Cell 6", "Line 3", "2026-09-30 22:00:00", "2026-10-01 00:00:00");
    expect(say([PRIYA_CELL_4, b, c])).toBe(
      "Priya Shah is already on Cell 4 in Line 2 today from 6 am to 2 pm, Cell 5 in Line 2 today from 3 pm to 5 pm and Cell 6 in Line 3 today from 5 pm to 7 pm.",
    );
  });

  it("BE-4: a place with no parent is just its own name", () => {
    const root = outside("Plant A", null, "2026-09-30 11:00:00", "2026-09-30 19:00:00");
    expect(say([root])).toBe("Priya Shah is already on Plant A today from 6 am to 2 pm.");
  });

  it("BE-5: a block across midnight says so; one that stops AT midnight stays on its own day", () => {
    // 10 pm Wed to 6 am Thu, Chicago.
    const night = outside("Cell 4", "Line 2", "2026-10-01 03:00:00", "2026-10-01 11:00:00");
    expect(say([night])).toBe(
      "Priya Shah is already on Cell 4 in Line 2 today from 10 pm to 6 am the next day.",
    );
    // 2 pm to midnight Wed, Chicago: the end is exclusive, so it ends on Wednesday.
    const toMidnight = outside("Cell 4", "Line 2", "2026-09-30 19:00:00", "2026-10-01 05:00:00");
    expect(say([toMidnight])).toBe(
      "Priya Shah is already on Cell 4 in Line 2 today from 2 pm to midnight.",
    );
  });

  it("BE-6: WEST of UTC with the clock frozen in the evening -- today is the plant's Wednesday, though the UTC date is already Thursday", () => {
    // 8 pm Wed 30 Sept in Chicago is 01:00 UTC on Thu 1 Oct.
    const now = new Date("2026-10-01T01:00:00Z");
    expect(say([PRIYA_CELL_4], { now })).toBe(
      "Priya Shah is already on Cell 4 in Line 2 today from 6 am to 2 pm.",
    );
    // The same block read on Thursday's plant clock is YESTERDAY, never "today".
    expect(say([PRIYA_CELL_4], { now: new Date("2026-10-01T18:00:00Z") })).toBe(
      "Priya Shah is already on Cell 4 in Line 2 yesterday from 6 am to 2 pm.",
    );
    // And a block on the plant's tomorrow is "tomorrow".
    const tomorrow = outside("Cell 4", "Line 2", "2026-10-01 11:00:00", "2026-10-01 19:00:00");
    expect(say([tomorrow], { now })).toBe(
      "Priya Shah is already on Cell 4 in Line 2 tomorrow from 6 am to 2 pm.",
    );
  });

  it("BE-7: EAST of UTC with the clock frozen in the early morning -- today is the plant's Wednesday, though the UTC date is still Tuesday", () => {
    // 5 am Wed 30 Sept in Tokyo is 20:00 UTC on Tue 29 Sept.
    const now = new Date("2026-09-29T20:00:00Z");
    // 6 am to 2 pm Wed in Tokyo = 21:00Z Tue to 05:00Z Wed.
    const block = outside("Cell 4", "Line 2", "2026-09-29 21:00:00", "2026-09-30 05:00:00");
    expect(say([block], { zone: TOKYO, now })).toBe(
      "Priya Shah is already on Cell 4 in Line 2 today from 6 am to 2 pm.",
    );
    const tomorrow = outside("Cell 4", "Line 2", "2026-09-30 21:00:00", "2026-10-01 05:00:00");
    expect(say([tomorrow], { zone: TOKYO, now })).toBe(
      "Priya Shah is already on Cell 4 in Line 2 tomorrow from 6 am to 2 pm.",
    );
  });

  it("BE-8: a day further off is the board's own day label, in the plant's zone and the plant's format", () => {
    const monday = outside("Cell 4", "Line 2", "2026-10-05 11:00:00", "2026-10-05 19:00:00");
    const label = formatDayLabel(new Date("2026-10-05T11:00:00Z"), "d_mon_yyyy", CHICAGO);
    expect(say([monday])).toBe(
      `Priya Shah is already on Cell 4 in Line 2 ${label} from 6 am to 2 pm.`,
    );
    const slash = formatDayLabel(new Date("2026-10-05T11:00:00Z"), "mdy_slash", CHICAGO);
    expect(say([monday], { dateFormat: "mdy_slash" })).toBe(
      `Priya Shah is already on Cell 4 in Line 2 ${slash} from 6 am to 2 pm.`,
    );
    expect(label).not.toBe(slash);
  });

  it("BE-9: only an outside block is named -- a readable one, its product and its job never appear", () => {
    const said = say([READABLE, PRIYA_CELL_4]) ?? "";
    expect(said).toBe("Priya Shah is already on Cell 4 in Line 2 today from 6 am to 2 pm.");
    expect(said).not.toMatch(/Housing A|Cell 1|Line 1/);
  });

  it("BE-10: nothing outside means nothing to say (null) -- the caller keeps today's words", () => {
    expect(say([])).toBeNull();
    expect(say([READABLE])).toBeNull();
    expect(outsideRows([READABLE, PRIYA_CELL_4])).toEqual([PRIYA_CELL_4]);
  });
});

describe("isBusyElsewhere (R-465): the one test the create path refuses by", () => {
  const probe = (fits: boolean, overlapping: CapacityProbeOverlap[]): CapacityProbe => ({
    fits,
    peak: fits ? 1 : 2,
    cap: 1,
    overlapping,
  });

  it("BE-11: does not fit AND an outside row is among those that overlap", () => {
    expect(isBusyElsewhere(probe(false, [PRIYA_CELL_4]))).toBe(true);
    // One readable row beside it does not make it splittable: she cannot change the other.
    expect(isBusyElsewhere(probe(false, [READABLE, PRIYA_CELL_4]))).toBe(true);
  });

  it("BE-12: a readable overlap alone is the split pop-up's business, and a fit is a fit", () => {
    expect(isBusyElsewhere(probe(false, [READABLE]))).toBe(false);
    expect(isBusyElsewhere(probe(false, []))).toBe(false);
    expect(isBusyElsewhere(probe(true, [PRIYA_CELL_4]))).toBe(false);
  });
});

describe("explainCapacityRefusal (R-465): a capacity refusal asks the probe who the person is busy with", () => {
  const capacity: SchedulerError = {
    kind: "CapacityExceeded",
    operatorId: "op-priya",
    peak: 2,
    cap: 1,
    timerange: '["2026-09-30 15:00:00+00","2026-09-30 16:00:00+00")',
  };
  const attempt: CapacityAttempt = {
    operatorId: "op-priya",
    start: new Date("2026-09-30T15:00:00Z"),
    end: new Date("2026-09-30T16:00:00Z"),
    efficiencyPercent: 100,
    excludeAssignmentId: "asg-moving",
  };
  const deps = (probe: CapacityProbeProbe) => ({
    probe,
    personName: "Priya Shah",
    zone: CHICAGO,
    dateFormat: "d_mon_yyyy" as const,
    now: () => new Date("2026-09-30T18:00:00Z"),
  });
  type CapacityProbeProbe = (input: CapacityAttempt) => Promise<CapacityProbe>;

  it("BE-13: an outside row carries the sentence on the refusal, every other field kept, and the probe is asked about the same person and hours", async () => {
    const probe = vi.fn<CapacityProbeProbe>().mockResolvedValue({
      fits: false,
      peak: 2,
      cap: 1,
      overlapping: [PRIYA_CELL_4],
    });

    const out = await explainCapacityRefusal(capacity, attempt, deps(probe));

    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith(attempt);
    expect(out).toEqual({
      ...capacity,
      elsewhere: "Priya Shah is already on Cell 4 in Line 2 today from 6 am to 2 pm.",
    });
  });

  it("BE-14: the probe failing keeps today's words -- the refusal comes back untouched", async () => {
    const probe = vi.fn<CapacityProbeProbe>().mockRejectedValue(new Error("network"));
    expect(await explainCapacityRefusal(capacity, attempt, deps(probe))).toBe(capacity);
  });

  it("BE-15: nothing outside (a block she CAN read, or none) keeps today's words", async () => {
    const readable = vi.fn<CapacityProbeProbe>().mockResolvedValue({
      fits: false,
      peak: 2,
      cap: 1,
      overlapping: [READABLE],
    });
    expect(await explainCapacityRefusal(capacity, attempt, deps(readable))).toBe(capacity);
  });

  it("BE-16: any other refusal is handed back without asking anything", async () => {
    const probe = vi.fn<CapacityProbeProbe>();
    const other: SchedulerError = { kind: "WriteRefused" };
    expect(await explainCapacityRefusal(other, attempt, deps(probe))).toBe(other);
    expect(probe).not.toHaveBeenCalled();
  });
});

/**
 * S195 review: the assignment pop-up's own refusal line (`describeRefusal`)
 * says the place and the hours for a busy-elsewhere refusal, never "would reach
 * N% of capacity" about a block the caller cannot see.
 */
describe("describeRefusal carries the busy-elsewhere sentence (S195 review)", () => {
  it("says the sentence when the refusal has one, and the numbers when it has none", async () => {
    const { describeRefusal } = await import("@/features/board/components/AssignmentPopover");
    const base = {
      kind: "CapacityExceeded" as const,
      operatorId: "op-1",
      peak: 2,
      cap: 1,
      timerange: "[2026-09-30 15:00:00+00,2026-09-30 19:00:00+00)",
    };
    const sentence = "Priya Shah is already on Cell 4 in Line 2 today from 6 am to 2 pm.";
    expect(describeRefusal({ ...base, elsewhere: sentence }, "Priya Shah", undefined, "UTC")).toBe(
      sentence,
    );
    expect(describeRefusal(base, "Priya Shah", undefined, "UTC")).toBe(
      "Priya Shah would reach 200% of capacity at this time (limit 100%).",
    );
  });
});
