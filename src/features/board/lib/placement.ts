/**
 * Pure popover placement (design plan §19.11, brief P1-5c §4.1).
 *
 * One rule, in this order:
 *   1. desired = anchor + gap on the vertical axis only (no horizontal gap).
 *   2. An unknown viewport (either dimension not finite, or <= 0) returns the
 *      desired position UNCLAMPED — the SSR / before-first-measurement path.
 *   3. A non-finite or non-positive width/height is treated as 0 (unmeasured),
 *      so it clamps to the far edge rather than past it.
 *   4. Per axis: max = viewport - size - margin. If max <= margin the box
 *      cannot fit between the margins at all, so it pins to margin. Otherwise
 *      clamp(desired, margin, max).
 */

export interface PlacementInput {
  anchorX: number;
  anchorY: number;
  /** MEASURED rendered width, already scaled. Never a hardcoded constant. */
  width: number;
  /** MEASURED rendered height, already scaled. Replaces the hardcoded 420. */
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  margin?: number;
  gap?: number;
}

export interface Placement {
  left: number;
  top: number;
}

export const DEFAULT_MARGIN = 10;
export const DEFAULT_GAP = 8;

function isUnknownViewportDimension(v: number): boolean {
  return !Number.isFinite(v) || v <= 0;
}

function sanitizeSize(v: number): number {
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * `margin` and `gap` are caller-supplied offsets, not measurements: NaN means
 * the caller's arithmetic slipped, and the documented default is a better
 * answer than propagating it. Infinity is deliberately NOT rejected -- it
 * clamps correctly through Math.min/Math.max and is a meaningful "as far as
 * possible" request.
 */
function sanitizeOffset(v: number | undefined, fallback: number): number {
  return v !== undefined && Number.isFinite(v) ? v : fallback;
}

function clampAxis(desired: number, size: number, viewport: number, margin: number): number {
  const max = viewport - size - margin;
  if (max <= margin) return margin;
  // NaN survives BOTH Math.max and Math.min and would reach the DOM as
  // `left: NaNpx`, which the browser discards -- so a `position: fixed`
  // popover silently renders at its static position instead of being clamped
  // on screen, which is the exact failure this module exists to prevent.
  // Every other numeric input here was already sanitised (size, and both
  // viewport dimensions); the anchor was the one that was not
  // (verification-standard rule 7). Design-session verification, P1-5c.
  const start = Number.isNaN(desired) ? margin : desired;
  return Math.min(Math.max(start, margin), max);
}

export function resolvePopoverPlacement(input: PlacementInput): Placement {
  const margin = sanitizeOffset(input.margin, DEFAULT_MARGIN);
  const gap = sanitizeOffset(input.gap, DEFAULT_GAP);

  const desiredLeft = input.anchorX;
  const desiredTop = input.anchorY + gap;

  if (
    isUnknownViewportDimension(input.viewportWidth) ||
    isUnknownViewportDimension(input.viewportHeight)
  ) {
    return { left: desiredLeft, top: desiredTop };
  }

  const width = sanitizeSize(input.width);
  const height = sanitizeSize(input.height);

  return {
    left: clampAxis(desiredLeft, width, input.viewportWidth, margin),
    top: clampAxis(desiredTop, height, input.viewportHeight, margin),
  };
}
