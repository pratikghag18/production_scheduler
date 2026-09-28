import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatClock } from "@/features/board/lib/time";

/**
 * DEF-0038 — the board's New pop-up prints every hour and day in UTC, not the plant's zone.
 *
 * `CreatePopover` takes `zone?: string` and hands it to `formatClock` / `formatFull` for
 * its shift chips, its "Mon Sep 28 11:00 – 19:00" line and the leave line; with no zone
 * those fall back to `BOARD_ZONE = "UTC"`. `BoardPage.tsx` mounts it WITHOUT `zone`
 * (every other pop-up it mounts passes `zone={zone}`). The demo plant has been in
 * Chicago since R-450 (22 Sept), so on a fresh seed Ana opens New on Cell 1 under an
 * axis reading 08:00, 09:00 ... and is offered "Shift 1 11:00–19:00", "Shift 3
 * 03:00–11:00" — the UTC hours of 06:00–14:00 and 22:00–06:00 Chicago (measured live,
 * see the defect). A night block starting Monday 22:00 Chicago is labelled Tuesday.
 * R-426: every day and hour the app shows is in the plant's zone.
 *
 * `src/test/dateSeam.test.ts` cannot see this: it hunts machine-zone reads
 * (getHours, toLocale*), not an optional zone prop left off at its mount.
 * Green when the board's CreatePopover mount passes the plant's zone.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/** The props of the first `<Name ... />` element in a TSX source, comments stripped. */
function mountProps(src: string, name: string): string {
  const start = src.indexOf(`<${name}`);
  expect(start, `no <${name} mount found`).toBeGreaterThanOrEqual(0);
  const end = src.indexOf("/>", start);
  return src
    .slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

describe("DEF-0038: the New pop-up reads the plant's clock, not UTC", () => {
  it("what the pop-up prints without a zone: the UTC hour, 11:00 for 06:00 Chicago", () => {
    // 06:00 Chicago on 28 Sep 2026 (CDT, UTC-5) is 11:00Z.
    const sixAmChicago = new Date("2026-09-28T11:00:00.000Z");
    expect(formatClock(sixAmChicago, "America/Chicago")).toBe("06:00");
    expect(formatClock(sixAmChicago)).toBe("11:00"); // the default the pop-up falls back to
  });

  it("BoardPage mounts CreatePopover with the plant's zone, as it does every other pop-up", () => {
    const board = read("src/features/board/BoardPage.tsx");
    const create = mountProps(board, "CreatePopover");
    expect(
      /\bzone=\{/.test(create),
      "BoardPage's <CreatePopover> is mounted without zone=, so its chips and times read UTC",
    ).toBe(true);
  });
});
