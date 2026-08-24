import { describe, expect, it } from "vitest";
import {
  BOARD_ZONE,
  formatClock,
  formatDayLabel,
  formatFull,
  formatNumber,
  startOfUtcDay,
  utcMondayOfWeek,
  addMinutes,
  minutesBetween,
} from "@/features/board/lib/time";

/**
 * §12 case 1-3, ported to Vitest. Authored, not run in this container (no
 * npm) — the harness under /tmp/harness proved these exact assertions
 * against this exact code (see the agent report).
 */
describe("time.ts", () => {
  it("BOARD_ZONE is UTC (D13)", () => {
    expect(BOARD_ZONE).toBe("UTC");
  });

  it("formatClock is 24h, BOARD_ZONE (case 1)", () => {
    expect(formatClock(new Date("2026-08-17T06:00:00Z"))).toBe("06:00");
    expect(formatClock(new Date("2026-08-17T22:30:00Z"))).toBe("22:30");
  });

  it("formatClock never prints 24:00 at midnight", () => {
    expect(formatClock(new Date("2026-08-17T00:00:00Z"))).toBe("00:00");
  });

  it("formatDayLabel has no comma (mockup's DAY_NAMES style)", () => {
    expect(formatDayLabel(new Date("2026-08-17T00:00:00Z"))).toBe("Mon Aug 17");
  });

  it("formatFull composes day label and clock", () => {
    expect(formatFull(new Date("2026-08-17T06:00:00Z"))).toBe("Mon Aug 17 06:00");
  });

  it("startOfUtcDay truncates to a whole UTC day", () => {
    const d = startOfUtcDay(new Date("2026-08-17T14:32:10Z"));
    expect(d.toISOString()).toBe("2026-08-17T00:00:00.000Z");
  });

  it("utcMondayOfWeek returns the same Monday for that Monday, the Wednesday after, and the Sunday after (case 2)", () => {
    const monday = new Date("2026-08-17T00:00:00Z");
    const wednesday = new Date("2026-08-19T13:00:00Z");
    const sunday = new Date("2026-08-23T09:00:00Z");
    expect(utcMondayOfWeek(monday).getTime()).toBe(monday.getTime());
    expect(utcMondayOfWeek(wednesday).getTime()).toBe(monday.getTime());
    expect(utcMondayOfWeek(sunday).getTime()).toBe(monday.getTime());
  });

  it("addMinutes / minutesBetween are inverses", () => {
    const base = new Date("2026-08-17T06:00:00Z");
    const next = addMinutes(base, 90);
    expect(next.toISOString()).toBe("2026-08-17T07:30:00.000Z");
    expect(minutesBetween(base, next)).toBe(90);
  });

  it("formatNumber: 2dp, trailing zeros stripped (case 3)", () => {
    expect(formatNumber(1)).toBe("1");
    expect(formatNumber(1.5)).toBe("1.5");
    expect(formatNumber(1.25)).toBe("1.25");
  });
});
