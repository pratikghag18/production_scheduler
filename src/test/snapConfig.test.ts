import { describe, expect, it } from "vitest";
import { snapConfigFor } from "@/features/board/hooks/useDragGesture";
import { ZOOMS } from "@/features/board/lib/geometry";
import { buildDayAxis } from "@/features/board/lib/time";
import { useBoardViewStore } from "@/features/board/store/boardView";

const AXIS = buildDayAxis(new Date("2026-08-24T00:00:00.000Z"), 1, "UTC");

/**
 * R-024 (the TRUE half only — see below) and R-043 (the shift-boundary-snap
 * half only): `snapConfigFor` (useDragGesture.ts) is the wiring between a
 * zoomIndex and the params interaction.test.ts's `snapMinute` cases already
 * exercise by hand. That function's own logic was tested; this wiring
 * was not, before this file.
 *
 * ⛔ R-024 AS WORDED CLAIMS THE WRONG SNAP VALUES. Its claim text says "Each
 * zoom level has a default snap (shift at the coarsest, then 1 h, 15 min,
 * 5 min)". The real, ported-verbatim table (geometry.ts ZOOMS, "D16 — zoom
 * table, ported verbatim") is Compact=60min, Standard=30min, Fine=15min —
 * matching R-D16's claim, not R-024's. F1-F3 below assert the REAL values.
 * Do not read F1-F3 as proving R-024's claim text; they prove R-D16's and
 * disprove the specific numbers in R-024's. R-024's only claim that IS true
 * is the modifier-key one (F4-F5, plus interaction.test.ts case2a/case2b).
 *
 * ⛔ R-043's SECOND CLAUSE IS NOT BUILT. Its claim also says "the creation
 * popover offers one-click whole-shift creation for that row's pattern" —
 * grepped the whole src/features/board tree for "whole shift" / "full
 * shift" / "quick action" and found nothing; CreatePopover.tsx has no such
 * control. F6-F7 below prove only the shift-boundary-snap clause, which IS
 * real and matches the wiring already found in `useShiftSnap`.
 */
describe("snapConfigFor (R-024 / R-043 / R-D16 zoom-to-snap wiring)", () => {
  it("F1: Compact (zoomIndex 0) wires snapMinutes=60, useShiftSnap=true", () => {
    const cfg = snapConfigFor(0, null, AXIS);
    expect(cfg.snapMinutes).toBe(60);
    expect(cfg.useShiftSnap).toBe(true);
  });

  it("F2: Standard (zoomIndex 1) wires snapMinutes=30, useShiftSnap=false", () => {
    const cfg = snapConfigFor(1, null, AXIS);
    expect(cfg.snapMinutes).toBe(30);
    expect(cfg.useShiftSnap).toBe(false);
  });

  it("F3: Fine (zoomIndex 2) wires snapMinutes=15, useShiftSnap=false", () => {
    const cfg = snapConfigFor(2, null, AXIS);
    expect(cfg.snapMinutes).toBe(15);
    expect(cfg.useShiftSnap).toBe(false);
  });

  it("F4: useShiftSnap is true at Compact and ONLY Compact, across all three zooms", () => {
    const flags = ZOOMS.map((_, i) => snapConfigFor(i as 0 | 1 | 2, null, AXIS).useShiftSnap);
    expect(flags).toEqual([true, false, false]);
  });

  it("F5: a null template (row resolves no shift pattern) always yields an empty shiftPoints array", () => {
    expect(snapConfigFor(0, null, AXIS).shiftPoints).toEqual([]);
  });

  it("F6: R-043's shift-boundary-snap clause — Compact zoom's snapMinutes/useShiftSnap pairing matches useShiftSnap's own condition (zoom.name === 'Compact')", () => {
    // Cross-checked directly against the ZOOMS table rather than the magic
    // index 0, so a future reordering of ZOOMS fails this case instead of
    // silently testing the wrong zoom.
    const compactIndex = ZOOMS.findIndex((z) => z.name === "Compact");
    const cfg = snapConfigFor(compactIndex as 0 | 1 | 2, null, AXIS);
    expect(cfg.useShiftSnap).toBe(true);
  });

  it("F7: the two non-Compact zooms never use shift-boundary snap", () => {
    const nonCompact = ZOOMS.map((z, i) => [z.name, i] as const).filter(([n]) => n !== "Compact");
    for (const [, i] of nonCompact) {
      expect(snapConfigFor(i as 0 | 1 | 2, null, AXIS).useShiftSnap).toBe(false);
    }
  });

  // F1-F3 above prove R-D16's snapMinutes clause via the wiring; pxPerHour was
  // never pinned anywhere. A literal-value test so an accidental table edit
  // fails loudly instead of only failing whatever screen a human happens to look at.
  it("F8: R-D16's full table — Compact 64px/60min, Standard 104px/30min, Fine 168px/15min", () => {
    expect(ZOOMS).toEqual([
      { name: "Compact", pxPerHour: 64, snapMinutes: 60 },
      { name: "Standard", pxPerHour: 104, snapMinutes: 30 },
      { name: "Fine", pxPerHour: 168, snapMinutes: 15 },
    ]);
  });

  it("F9: R-D16's default clause — the store opens at zoomIndex 1 (Standard)", () => {
    expect(useBoardViewStore.getState().zoomIndex).toBe(1);
    expect(ZOOMS[useBoardViewStore.getState().zoomIndex].name).toBe("Standard");
  });
});
