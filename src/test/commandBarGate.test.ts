/**
 * `launcherFor` (R-403/D129, S54) pinned without rendering `BoardPage` --
 * see the module doc in `src/features/board/lib/commandBarGate.ts`.
 *
 * G1-G3: the three modes, each crossed with `canPlace` true/false -- `off`
 * always hides, and `canPlace: false` always hides regardless of mode (a
 * viewer never sees the launcher, R-346, unchanged by this setting). G4: an
 * unrecognised mode -- the fail-safe branch `shapes.ts`'s own parse should
 * already have caught, pinned again here as the second line of the same
 * rule (CLAUDE.md §4).
 */
import { describe, expect, it } from "vitest";
import type { CommandBarMode } from "@/lib/api";
import { launcherFor } from "@/features/board/lib/commandBarGate";

describe("launcherFor (R-403/D129): off/typed/voice x canPlace", () => {
  it("G1: off hides the launcher regardless of canPlace", () => {
    expect(launcherFor("off", true)).toEqual({ show: false, voice: false });
    expect(launcherFor("off", false)).toEqual({ show: false, voice: false });
  });

  it("G2: typed shows the launcher without a recogniser, but only when canPlace", () => {
    expect(launcherFor("typed", true)).toEqual({ show: true, voice: false });
    expect(launcherFor("typed", false)).toEqual({ show: false, voice: false });
  });

  it("G3: voice shows the launcher with a recogniser, but only when canPlace", () => {
    expect(launcherFor("voice", true)).toEqual({ show: true, voice: true });
    expect(launcherFor("voice", false)).toEqual({ show: false, voice: false });
  });

  it("G4: an unrecognised mode fails SAFE -- hidden, never falls open to voice", () => {
    expect(launcherFor("garbled" as CommandBarMode, true)).toEqual({
      show: false,
      voice: false,
    });
    expect(launcherFor("garbled" as CommandBarMode, false)).toEqual({
      show: false,
      voice: false,
    });
  });

  it("canPlace is checked before the mode: a viewer never sees the launcher, on any mode", () => {
    const modes: CommandBarMode[] = ["off", "typed", "voice"];
    for (const mode of modes) {
      expect(launcherFor(mode, false)).toEqual({ show: false, voice: false });
    }
  });
});
