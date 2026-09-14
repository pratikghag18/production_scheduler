/**
 * R-403 / D129 (S54) — whether `BoardPage` renders the command bar launcher
 * at all, and whether it hands `CommandLauncher` a speech recogniser.
 *
 * Pulled out as its own pure function so the rule is pinned without
 * rendering the whole board (`commandBarGate.test.ts`, G1-G4): the launcher
 * is BoardPage's ~800-line render tree, and `src/test/boardPage*` does not
 * exist as a lighter harness for it.
 *
 * ⛔ `canPlace` IS STILL THE OUTER GUARD, NOT SOMETHING THIS FUNCTION CAN
 * OVERRIDE. A viewer never clears `canPlace` (R-346), so this returns
 * `{ show: false, voice: false }` for any mode when `canPlace` is false --
 * the same guard `BoardPage` already applied at `canPlace && commandCtx !==
 * null` before this migration, now folded in here so one call answers both
 * questions instead of two conditions the caller has to keep in step.
 *
 * ⚠️ `mode` IS TYPED AS THE CLOSED UNION, but the runtime check does not
 * trust that boundary blindly: `board_window`'s payload already came through
 * `parseCommandBarMode` (`shapes.ts`), which fails an unrecognised STORED
 * value to `"off"` before this ever runs. This function's own `default`
 * branch is the second line of that same fail-safe rule -- belt and
 * suspenders, CLAUDE.md §4 -- and is what G4 exercises via a cast, since the
 * type system alone cannot produce the case it guards against.
 */
import type { CommandBarMode } from "@/lib/api";

export interface CommandBarLaunch {
  /** Render the launcher button (and the bar behind it) at all. */
  show: boolean;
  /** Hand the bar a speech recogniser -- only meaningful when `show` is true. */
  voice: boolean;
}

const HIDDEN: CommandBarLaunch = { show: false, voice: false };

export function launcherFor(mode: CommandBarMode, canPlace: boolean): CommandBarLaunch {
  if (!canPlace) return HIDDEN;
  switch (mode) {
    case "off":
      return HIDDEN;
    case "typed":
      return { show: true, voice: false };
    case "voice":
      return { show: true, voice: true };
    default:
      // Fails safe: an unrecognised mode hides the button, exactly as the
      // requirement states -- never falls open to `voice`.
      return HIDDEN;
  }
}
