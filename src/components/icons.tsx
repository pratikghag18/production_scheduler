/**
 * THE ICON STANDARD — one home for every glyph the app draws.
 *
 * The maintainer, 3 Sept: the collapse chevron on the board and on the admin
 * pages looked different. The cause was that each surface drew its own — the
 * admin rail and the board panel used the Unicode guillemets `«`/`»`, the two
 * tree carets used `▸`/`▾`, and a raw glyph renders in whatever the surrounding
 * font happens to be, at whatever weight, with no way to size or align it
 * consistently. Four affordances, four appearances, for one idea.
 *
 * So a directional chevron is ONE component, an inline SVG that takes its colour
 * from `currentColor` and points where it is told. Every collapse/expand control
 * — panel toggles and tree carets alike — uses it, so they cannot drift again.
 *
 * ⚠️ THE STANDARD IS ENFORCED, NOT JUST OFFERED. `src/test/iconStandard.test.ts`
 * fails the build if a raw directional glyph (`« » ‹ › ▸ ▾ ◀ ▶ …`) appears in a
 * component outside this module — the same shape as the date-seam and rem-surface
 * guards. A new chevron has to come from here.
 *
 * New icons belong in THIS file, as small `currentColor` SVG components, so the
 * app keeps one visual vocabulary rather than growing a second inline set.
 */
import type { CSSProperties } from "react";

export type ChevronDirection = "right" | "down" | "left" | "up";

const ROTATION: Record<ChevronDirection, number> = {
  right: 0,
  down: 90,
  left: 180,
  up: 270,
};

/**
 * A single chevron, pointing `direction`. Decorative by default (`aria-hidden`),
 * because the control around it carries the label; pass a `title` only when the
 * icon is the sole affordance and needs a tooltip.
 *
 * Sized in `em` so it scales with the button's font (the rem/scale discipline
 * D84/D89 keeps for the admin surfaces) rather than pinning a pixel size.
 */
export function Chevron({
  direction = "right",
  title,
  className,
}: {
  direction?: ChevronDirection;
  title?: string;
  className?: string;
}) {
  const style: CSSProperties = {
    display: "inline-block",
    width: "1em",
    height: "1em",
    transform: `rotate(${ROTATION[direction]}deg)`,
    transition: "transform 120ms ease",
  };
  return (
    <svg
      viewBox="0 0 16 16"
      style={style}
      className={className}
      aria-hidden={title === undefined}
      role={title === undefined ? undefined : "img"}
      focusable="false"
    >
      {title !== undefined && <title>{title}</title>}
      <path
        d="M6 3.5 10.5 8 6 12.5"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
