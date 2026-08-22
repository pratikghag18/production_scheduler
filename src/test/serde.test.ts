import { describe, expect, it } from "vitest";
import { fromEfficiency, parseTstzRange, toEfficiency, toTstzRange } from "@/lib/api";

describe("toTstzRange / parseTstzRange", () => {
  it("serialises to the exact half-open, quoted form (brief §5)", () => {
    const start = new Date("2026-08-24T06:00:00.000Z");
    const end = new Date("2026-08-24T14:00:00.000Z");
    expect(toTstzRange(start, end)).toBe('["2026-08-24T06:00:00.000Z","2026-08-24T14:00:00.000Z")');
  });

  it("round-trips our own toTstzRange output", () => {
    const start = new Date("2026-08-18T06:00:00.000Z");
    const end = new Date("2026-08-18T14:00:00.000Z");
    const { start: parsedStart, end: parsedEnd } = parseTstzRange(toTstzRange(start, end));
    expect(parsedStart.toISOString()).toBe(start.toISOString());
    expect(parsedEnd.toISOString()).toBe(end.toISOString());
  });

  it("round-trips a window crossing midnight", () => {
    const start = new Date("2026-08-18T22:00:00.000Z");
    const end = new Date("2026-08-19T06:00:00.000Z");
    const { start: parsedStart, end: parsedEnd } = parseTstzRange(toTstzRange(start, end));
    expect(parsedStart.toISOString()).toBe(start.toISOString());
    expect(parsedEnd.toISOString()).toBe(end.toISOString());
  });

  it("round-trips a window spanning a US DST boundary (2026-03-08, non-UTC zone)", () => {
    // America/New_York goes from EST (UTC-5) to EDT (UTC-4) at 2026-03-08
    // 07:00 UTC. A window either side of that instant, expressed in wall
    // time with its EST/EDT offset, must still land on the correct UTC
    // instant after a round trip.
    const start = new Date("2026-03-08T01:00:00-05:00"); // 06:00 UTC, still EST
    const end = new Date("2026-03-08T04:00:00-04:00"); // 08:00 UTC, already EDT
    const { start: parsedStart, end: parsedEnd } = parseTstzRange(toTstzRange(start, end));
    expect(parsedStart.toISOString()).toBe("2026-03-08T06:00:00.000Z");
    expect(parsedEnd.toISOString()).toBe("2026-03-08T08:00:00.000Z");
    expect(parsedStart.toISOString()).toBe(start.toISOString());
    expect(parsedEnd.toISOString()).toBe(end.toISOString());
  });

  it("parses Postgres's own quoted, space-separated text form", () => {
    const { start, end } = parseTstzRange('["2026-08-18 06:00:00+00","2026-08-18 12:00:00+00")');
    expect(start.toISOString()).toBe("2026-08-18T06:00:00.000Z");
    expect(end.toISOString()).toBe("2026-08-18T12:00:00.000Z");
  });

  it("parses a non-UTC offset without a colon (Postgres's bare +HH/-HH style)", () => {
    const { start, end } = parseTstzRange('["2026-08-18 06:00:00+05","2026-08-18 12:00:00-08")');
    expect(start.toISOString()).toBe("2026-08-18T01:00:00.000Z");
    expect(end.toISOString()).toBe("2026-08-18T20:00:00.000Z");
  });

  it("accepts alternate bound characters ([)/((]/etc.)", () => {
    const { start, end } = parseTstzRange(
      '("2026-08-18T06:00:00.000Z","2026-08-18T12:00:00.000Z"]',
    );
    expect(start.toISOString()).toBe("2026-08-18T06:00:00.000Z");
    expect(end.toISOString()).toBe("2026-08-18T12:00:00.000Z");
  });

  it("throws on a malformed range literal", () => {
    expect(() => parseTstzRange("not a range")).toThrow();
    expect(() => parseTstzRange('["2026-08-18T06:00:00.000Z")')).toThrow(); // missing the comma-separated second bound
  });
});

describe("toEfficiency / fromEfficiency", () => {
  it("converts the brief's own worked examples", () => {
    expect(toEfficiency(50)).toBe(0.5);
    expect(toEfficiency(100)).toBe(1);
    expect(toEfficiency(37.5)).toBe(0.375);
  });

  it("rounds to 3 decimal places", () => {
    expect(toEfficiency(33.333333)).toBe(0.333);
    expect(toEfficiency(66.66666)).toBe(0.667);
  });

  it("never produces the 50 -> 50000% class of bug", () => {
    // The failure mode the brief calls out explicitly: 50% must become
    // 0.5, never 50 (which capacity_probe/create_assignment would reject
    // outright via the numeric(4,3) CHECK (efficiency <= 2), but silently
    // wrong math anywhere along this boundary is exactly what this guards).
    expect(toEfficiency(50)).not.toBe(50);
    expect(toEfficiency(50)).toBeLessThan(1);
  });

  it("fromEfficiency is the inverse", () => {
    expect(fromEfficiency(0.5)).toBe(50);
    expect(fromEfficiency(1)).toBe(100);
    expect(fromEfficiency(0.375)).toBe(37.5);
  });

  it("round-trips stably in both directions", () => {
    for (const percent of [0.1, 1, 12.5, 33.3, 37.5, 50, 66.7, 75, 99.9, 100, 150, 200]) {
      expect(fromEfficiency(toEfficiency(percent))).toBeCloseTo(percent, 5);
    }
    for (const value of [0.001, 0.1, 0.375, 0.5, 0.667, 1, 1.5, 2]) {
      expect(toEfficiency(fromEfficiency(value))).toBeCloseTo(value, 5);
    }
  });
});
