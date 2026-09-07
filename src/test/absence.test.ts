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
