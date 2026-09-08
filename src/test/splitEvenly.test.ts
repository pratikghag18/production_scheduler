import { describe, expect, it } from "vitest";
import { splitEvenly } from "@/features/board/lib/interaction";

/**
 * R-036: "An even split gives one extra unit to the first remainder
 * participants so max share minus min share is at most 1 for any count and
 * cap." The plan's own note says a property test caught the bug that an
 * example-based case could not (dumping the whole remainder on participant
 * 0 instead of distributing one unit each) but never named the file --
 * this is that file.
 */
describe("splitEvenly (R-036)", () => {
  it("E1: three-way at 100% is 34/33/33, remainder on the first participant", () => {
    expect(splitEvenly(3, 100)).toEqual([34, 33, 33]);
  });

  it("E2: two-way at 100% is 50/50 — zero remainder", () => {
    expect(splitEvenly(2, 100)).toEqual([50, 50]);
  });

  it("E3: participantCount <= 0 returns an empty array", () => {
    expect(splitEvenly(0, 100)).toEqual([]);
    expect(splitEvenly(-1, 100)).toEqual([]);
  });

  it("E4: an 8-way split at 100% distributes the remainder one unit each, not dumped on the first", () => {
    // 100/8 = 12 remainder 4. The bug this test exists to catch: dumping the
    // whole remainder on participant 0 gives [16,12,12,12,12,12,12,12]
    // (spread 4). The fix distributes one unit to each of the first 4.
    expect(splitEvenly(8, 100)).toEqual([13, 13, 13, 13, 12, 12, 12, 12]);
  });

  it("E5: every proposal sums to exactly Math.round(capPercent), never merely close to it", () => {
    for (let cap = 0; cap <= 200; cap += 7) {
      for (let n = 1; n <= 12; n++) {
        const shares = splitEvenly(n, cap);
        const sum = shares.reduce((s, x) => s + x, 0);
        expect(sum).toBe(Math.round(cap));
      }
    }
  });

  it("E6 (the property test): max share minus min share is at most 1, for any count 1-20 and cap 0-300", () => {
    for (let cap = 0; cap <= 300; cap += 3) {
      for (let n = 1; n <= 20; n++) {
        const shares = splitEvenly(n, cap);
        const max = Math.max(...shares);
        const min = Math.min(...shares);
        expect(max - min).toBeLessThanOrEqual(1);
      }
    }
  });

  it("E7: a non-integer capPercent rounds first, then splits the rounded total", () => {
    // Math.round(100.6) = 101; three-way is 34/34/33.
    expect(splitEvenly(3, 100.6)).toEqual([34, 34, 33]);
  });
});
