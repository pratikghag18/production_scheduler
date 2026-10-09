/**
 * S65-a (R-439): THE OPERATOR RAIL'S REMEMBERED WIDTH.
 *
 * `panelSize.ts` (S63/R-429) is `CommandLauncher`'s own store: a WIDTH+HEIGHT
 * pair, clamped to a floor and to the viewport minus a margin. The rail has
 * only one free dimension (its height is the board's), and R-439's clamp is a
 * plain, fixed range -- `[190px * ui-scale, 480px]` -- not viewport-relative,
 * so `clampPanelSize` does not fit. Rather than edit `panelSize.ts` (S63's own
 * lane, in flight in this tree at the same time), this wraps its
 * `readPanelSize`/`writePanelSize` -- the localStorage round-trip and the
 * best-effort try/catch, the part that DOES fit -- with a width-only API.
 *
 * ⚠️ THE KEY MUST NOT COLLIDE WITH THE COMMAND PANEL'S OWN. `readPanelSize`/
 * `writePanelSize` build their storage key as
 * `` `commandLauncher.panelSize.${key}` `` -- ONLY the `key` varies. R-439
 * reuses the exact value `BoardPage` already derives for `CommandLauncher`'s
 * own `historyKey` (user id + board root, `historyStorageKey`), so passing it
 * straight through would read and write the SAME localStorage entry as the
 * command bar's remembered size. `railKey` below prefixes the VALUE itself
 * before it ever reaches `panelSize.ts`, landing the two stores at different
 * keys under that one shared storage.
 *
 * The pair shape is kept only because `PanelSize` requires both fields:
 * `height` is written equal to `width` and never read back.
 */
import { readPanelSize, writePanelSize } from "./panelSize";

/** R-439: "clamped to a sensible range" -- the maintainer's own numbers. The
 *  floor scales with `ui-scale` (a rail can't be sacrificed to a phone the
 *  way the command panel's viewport-relative clamp lets it be); the ceiling
 *  is fixed. */
export const RAIL_MIN_WIDTH = 190;
export const RAIL_MAX_WIDTH = 480;

/** `historyKey === null` (session/board not yet known): no key to store
 *  under, same contract `panelSize.ts`'s own functions already carry for a
 *  `null` key. `prefix` defaults to the operator rail's own `"rail:"` so
 *  every existing caller is unaffected; a later panel (S68-a's admin rail
 *  review, RR-1) passes its own prefix instead of re-deriving this function
 *  bare in its own file -- the point of generalising it here rather than
 *  leaving a second copy to drift from this one. */
export function railKey(historyKey: string | null, prefix: string = "rail:"): string | null {
  return historyKey === null ? null : `${prefix}${historyKey}`;
}

/**
 * RR-1 (reviewer, S68-a review): the shared clamp math, taking the FLOOR
 * directly rather than deriving it from `RAIL_MIN_WIDTH * uiScale`. The
 * operator rail's floor is that constant times the current scale;
 * the admin rail's floor (R-446) is a measured `--rail-w`, not a scale
 * multiple of a constant -- but both are "clamp this width into
 * `[floor, max(floor, ceiling)]`", the same two-sided clamp
 * `clampPanelSize` also runs. Before this, `AdminPage.tsx` re-typed this
 * exact clamp under its own name (`clampAdminRailWidth`) instead of asking
 * this file for a floor-only version of its own -- copied math, not shared,
 * the shape R-446 exists to rule out. `clampRailWidth` below is this with
 * the operator rail's own floor plugged in, so OP-1..OP-4 (a fixed
 * `[190px * ui-scale, 480px]`) see no change.
 */
export function clampWidthToFloor(
  width: number,
  floor: number,
  ceiling: number = RAIL_MAX_WIDTH,
): number {
  const max = Math.max(floor, ceiling);
  return Math.min(max, Math.max(floor, width));
}

/**
 * Clamps both ways: too small (a corrupt/hand-edited value, or one saved at a
 * larger `ui-scale` than now applies) and too large both come back inside
 * `[190px * uiScale, 480px]`. When the scaled floor would exceed the fixed
 * ceiling (an extreme `ui-scale`), the floor wins -- same reasoning
 * `clampPanelSize` uses when the viewport is smaller than its own floor.
 */
export function clampRailWidth(width: number, uiScale: number): number {
  return clampWidthToFloor(width, RAIL_MIN_WIDTH * uiScale);
}

/** `key` is already `railKey(historyKey)`'s output (or `null`). Returns
 *  `null` for anything `readPanelSize` itself would: no key, nothing stored,
 *  or a stored value that doesn't parse as a `{width, height}` pair. */
export function readRailWidth(key: string | null): number | null {
  const size = readPanelSize(key);
  return size === null ? null : size.width;
}

export function writeRailWidth(key: string | null, width: number): void {
  writePanelSize(key, { width, height: width });
}
