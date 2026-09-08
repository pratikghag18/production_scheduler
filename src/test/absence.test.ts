/**
 * absence.test.ts — `absenceGaps` (src/lib/absence.ts), the client's copy of the
 * server's `absence_overlap` (migration 0066). The two must agree on the day
 * boundaries, so the cases here are named for their twins in
 * `supabase/tests/88_absences_test.sql` (AB8, AB8b) and pin the same instants.
 */
import { describe, it, expect } from "vitest";
import { absenceGaps, type AbsenceRow } from "@/lib/absence";

const el = "op-elena";
const leave = (from: string, to: string, operatorId = el): AbsenceRow => ({
  operatorId,
  from,
  to,
  reason: "leave",
});

const shift = (startIso: string, endIso: string | null) => ({
  start: new Date(startIso),
  end: endIso === null ? null : new Date(endIso),
});

describe("absenceGaps — the boundary, mirrored on 88_absences_test.sql", () => {
  it("AB8: an absence ENDING on the day a shift STARTS overlaps", () => {
    const hit = absenceGaps(
      [leave("2027-01-01", "2027-01-05")],
      el,
      shift("2027-01-05T06:00:00Z", "2027-01-05T14:00:00Z"),
    );
    expect(hit).not.toBeNull();
    expect(hit?.reason).toBe("leave");
    expect(hit?.from).toBe("2027-01-01");
    expect(hit?.to).toBe("2027-01-05");
  });

  it("AB8b: a shift ENDING exactly at midnight on the absence's start day does NOT overlap", () => {
    // Shift [Jan 4 06:00, Jan 5 00:00) touches only Jan 4; the absence starts Jan 5.
    const hit = absenceGaps(
      [leave("2027-01-05", "2027-01-08")],
      el,
      shift("2027-01-04T06:00:00Z", "2027-01-05T00:00:00Z"),
    );
    expect(hit).toBeNull();
  });

  it("a shift wholly the day after the absence does not overlap", () => {
    const hit = absenceGaps(
      [leave("2027-01-01", "2027-01-05")],
      el,
      shift("2027-01-06T06:00:00Z", "2027-01-06T14:00:00Z"),
    );
    expect(hit).toBeNull();
  });

  it("a shift ending mid-day on the absence's first day DOES overlap", () => {
    // [Jan 5 06:00, Jan 5 14:00) touches Jan 5; the absence starts Jan 5.
    const hit = absenceGaps(
      [leave("2027-01-05", "2027-01-06")],
      el,
      shift("2027-01-05T06:00:00Z", "2027-01-05T14:00:00Z"),
    );
    expect(hit).not.toBeNull();
  });

  it("a shift crossing midnight into the absence's first day overlaps (that day is touched)", () => {
    // [Jan 4 22:00, Jan 5 06:00) touches Jan 4 AND Jan 5; the absence starts Jan 5.
    const hit = absenceGaps(
      [leave("2027-01-05", "2027-01-05")],
      el,
      shift("2027-01-04T22:00:00Z", "2027-01-05T06:00:00Z"),
    );
    expect(hit).not.toBeNull();
  });

  it("an open-ended window overlaps any absence ending on or after its start day", () => {
    const hit = absenceGaps(
      [leave("2027-03-01", "2027-03-10")],
      el,
      shift("2027-02-20T06:00:00Z", null),
    );
    expect(hit).not.toBeNull();
    const miss = absenceGaps(
      [leave("2027-01-01", "2027-01-10")],
      el,
      shift("2027-02-20T06:00:00Z", null),
    );
    expect(miss).toBeNull();
  });

  it("returns the EARLIEST overlapping absence, matching ORDER BY lower(daterange) LIMIT 1", () => {
    const rows = [leave("2027-05-10", "2027-05-12"), leave("2027-05-01", "2027-05-20")];
    const hit = absenceGaps(rows, el, shift("2027-05-11T06:00:00Z", "2027-05-11T14:00:00Z"));
    expect(hit?.from).toBe("2027-05-01");
  });

  it("only considers the given operator's absences", () => {
    const rows = [leave("2027-06-01", "2027-06-05", "someone-else")];
    const hit = absenceGaps(rows, el, shift("2027-06-02T06:00:00Z", "2027-06-02T14:00:00Z"));
    expect(hit).toBeNull();
  });

  it("no absences means eligible (null)", () => {
    expect(absenceGaps([], el, shift("2027-01-05T06:00:00Z", "2027-01-05T14:00:00Z"))).toBeNull();
  });
});

/* ===========================================================================
 * R-359 / 0069 — a part-day absence is judged by the HOURS, not the day.
 * Named for their twins in 88_absences_test.sql (AB15/AB16/AB17).
 * ======================================================================== */

/** A part-day absence: one day, a start and an end instant (ISO). */
const partDay = (
  from: string,
  startsAt: string,
  endsAt: string,
  operatorId = el,
): AbsenceRow => ({ operatorId, from, to: from, reason: "leave", startsAt, endsAt });

describe("absenceGaps — R-359, a part-day absence is judged by the HOURS", () => {
  it("AB15: a part-day 09:00-13:00 absence clashes with an overlapping shift", () => {
    const hit = absenceGaps(
      [partDay("2027-06-10", "2027-06-10T09:00:00.000Z", "2027-06-10T13:00:00.000Z")],
      el,
      shift("2027-06-10T10:00:00Z", "2027-06-10T12:00:00Z"),
    );
    expect(hit).not.toBeNull();
    expect(hit?.startsAt).toBe("2027-06-10T09:00:00.000Z");
    expect(hit?.endsAt).toBe("2027-06-10T13:00:00.000Z");
  });

  it("AB15: the same part-day absence does NOT clash with a shift outside those hours", () => {
    const hit = absenceGaps(
      [partDay("2027-06-10", "2027-06-10T09:00:00.000Z", "2027-06-10T13:00:00.000Z")],
      el,
      shift("2027-06-10T14:00:00Z", "2027-06-10T16:00:00Z"),
    );
    expect(hit).toBeNull();
  });

  it("a shift ending exactly when the absence ends does not clash (half-open, touching is not overlapping)", () => {
    const hit = absenceGaps(
      [partDay("2027-06-10", "2027-06-10T09:00:00.000Z", "2027-06-10T13:00:00.000Z")],
      el,
      shift("2027-06-10T13:00:00Z", "2027-06-10T15:00:00Z"),
    );
    expect(hit).toBeNull();
  });

  it("a shift starting exactly when the absence starts DOES clash", () => {
    const hit = absenceGaps(
      [partDay("2027-06-10", "2027-06-10T09:00:00.000Z", "2027-06-10T13:00:00.000Z")],
      el,
      shift("2027-06-10T09:00:00Z", "2027-06-10T10:00:00Z"),
    );
    expect(hit).not.toBeNull();
  });

  it("AB24: a shift ending exactly when the absence starts does not clash (half-open, touching is not overlapping)", () => {
    const hit = absenceGaps(
      [partDay("2027-06-10", "2027-06-10T09:00:00.000Z", "2027-06-10T13:00:00.000Z")],
      el,
      shift("2027-06-10T07:00:00Z", "2027-06-10T09:00:00Z"),
    );
    expect(hit).toBeNull();
  });

  it("AB16: an open-ended window overlaps a part-day absence that ends after the window's start", () => {
    const hit = absenceGaps(
      [partDay("2027-06-10", "2027-06-10T09:00:00.000Z", "2027-06-10T13:00:00.000Z")],
      el,
      shift("2027-06-10T08:00:00Z", null),
    );
    expect(hit).not.toBeNull();
  });

  it("an open-ended window does NOT overlap a part-day absence that already ended before it starts", () => {
    const hit = absenceGaps(
      [partDay("2027-06-10", "2027-06-10T09:00:00.000Z", "2027-06-10T13:00:00.000Z")],
      el,
      shift("2027-06-10T13:00:00Z", null),
    );
    expect(hit).toBeNull();
  });

  it("a whole-day absence on the same operator and day still clashes independently of a part-day row", () => {
    const hit = absenceGaps(
      [leave("2027-06-10", "2027-06-10")],
      el,
      shift("2027-06-10T14:00:00Z", "2027-06-10T16:00:00Z"),
    );
    expect(hit).not.toBeNull();
    expect(hit?.startsAt).toBeUndefined();
  });

  it("whole-day before part-day on a tied day: the whole-day row's reason is returned first (server's NULLS FIRST)", () => {
    const rows = [
      partDay("2027-06-10", "2027-06-10T09:00:00.000Z", "2027-06-10T13:00:00.000Z", el),
      { operatorId: el, from: "2027-06-10", to: "2027-06-10", reason: "whole day" },
    ];
    const hit = absenceGaps(rows, el, shift("2027-06-10T09:30:00Z", "2027-06-10T09:45:00Z"));
    expect(hit?.reason).toBe("whole day");
  });
});
