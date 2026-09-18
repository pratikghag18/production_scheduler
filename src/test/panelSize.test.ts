/**
 * S63-a (R-429) — `src/features/board/lib/panelSize.ts`'s own tests, PS-1..4.
 * Pure `localStorage` reasoning, same shape as `commandConversation.test.ts`'s
 * own `historyStorageKey`/`readStoredHistory` pins -- no React, no store.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  MIN_PANEL_HEIGHT,
  MIN_PANEL_WIDTH,
  clampPanelSize,
  readPanelSize,
  writePanelSize,
} from "@/features/board/lib/panelSize";

const KEY = "commandConversation.history.user-1.plant_a";
const VIEWPORT = { width: 1280, height: 800 };

beforeEach(() => {
  window.localStorage.clear();
});

describe("panelSize (S63-a, R-429)", () => {
  it("PS-1: a round trip -- what is written is what comes back", () => {
    writePanelSize(KEY, { width: 400, height: 500 });
    expect(readPanelSize(KEY)).toEqual({ width: 400, height: 500 });
  });

  it("PS-2: corrupt JSON is ignored, not thrown or repaired", () => {
    window.localStorage.setItem("commandLauncher.panelSize." + KEY, "{not json");
    expect(readPanelSize(KEY)).toBeNull();

    // The right shape of JSON, the wrong shape of value, is dropped the same
    // way (storage is untrusted input, same rule the thread's own
    // `isHistoryTurn` follows).
    window.localStorage.setItem(
      "commandLauncher.panelSize." + KEY,
      JSON.stringify({ width: "400", height: 500 }),
    );
    expect(readPanelSize(KEY)).toBeNull();

    // Nothing stored at all is the ordinary case, not an error either.
    window.localStorage.clear();
    expect(readPanelSize(KEY)).toBeNull();
  });

  it("PS-3: clampPanelSize clamps both ways -- too small comes up to the floor, too large comes down to the viewport", () => {
    expect(clampPanelSize({ width: 10, height: 10 }, VIEWPORT)).toEqual({
      width: MIN_PANEL_WIDTH,
      height: MIN_PANEL_HEIGHT,
    });
    // CR-3 (reviewer fix, S63 review): height's ceiling is `viewport.height -
    // 94`, not `- 36` -- `.panel` is anchored `bottom: 76px`
    // (`CommandLauncher.module.css`), not `bottom: 18px` the way its `right`
    // is, so the two axes are NOT symmetric the way this pin used to assert.
    // A height clamped to `- 36` let the remembered size read up to 58px
    // taller than the panel can actually occupy before its top edge goes
    // off-screen (masked visually by the CSS's own `max-height: calc(100% -
    // 94px)`, but still wrong for what `size` itself, and `localStorage`,
    // held).
    expect(clampPanelSize({ width: 5000, height: 5000 }, VIEWPORT)).toEqual({
      width: VIEWPORT.width - 36,
      height: VIEWPORT.height - 94,
    });
    // A size already inside both floors is untouched.
    expect(clampPanelSize({ width: 400, height: 500 }, VIEWPORT)).toEqual({
      width: 400,
      height: 500,
    });
  });

  it("PS-4: a null key is not persisted, and never touches storage", () => {
    writePanelSize(null, { width: 400, height: 500 });
    expect(window.localStorage.length).toBe(0);
    expect(readPanelSize(null)).toBeNull();
  });
});
