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

/**
 * S66-b / R-444 — the small sort mark a sortable column heading carries AT
 * REST as well as active. The maintainer, 18 Sept: "The column names are not
 * telling me naturally that I can sort them." A neutral up-and-down chevron
 * pair says "this heading sorts" before anything is clicked; once a heading
 * becomes the active sort, the pair collapses to a single chevron pointing
 * the way the rows are ordered, and the OTHER heading falls back to the
 * neutral pair (`OperatorsPanel` passes `"none"` for it).
 *
 * Same shape as `Chevron` above: inline SVG, sized in `em`, `currentColor` —
 * never a text glyph. This is deliberately its own component rather than two
 * stacked `Chevron`s: the neutral mark is a single compact glyph (both
 * arrowheads read at once, dimmed), not two full-size chevrons that would
 * crowd a table heading.
 */
export function SortMark({
  direction = "none",
  className,
}: {
  direction?: "ascending" | "descending" | "none";
  className?: string;
}) {
  const style: CSSProperties = { display: "inline-block", width: "1em", height: "1em" };
  if (direction === "none") {
    return (
      <svg
        viewBox="0 0 16 16"
        style={style}
        className={className}
        aria-hidden="true"
        focusable="false"
      >
        <path
          d="M4.5 6.5 8 3.5 11.5 6.5"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={0.55}
        />
        <path
          d="M4.5 9.5 8 12.5 11.5 9.5"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={0.55}
        />
      </svg>
    );
  }
  return (
    <svg
      viewBox="0 0 16 16"
      style={style}
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d={direction === "ascending" ? "M4 10 8 5.5 12 10" : "M4 6 8 10.5 12 6"}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * S48 / R-396 — the corner launcher's own glyph, and the microphone the
 * command bar folds in beside it. Same shape as `Chevron` above: inline SVG,
 * `currentColor`, decorative by default (`aria-hidden`) since the button
 * around each of these already carries its own accessible name. Traced from
 * the maintainer's approved mock (`docs/mockups/launcher-corner.html`).
 */

/** The closed launcher button's glyph: a rounded speech bubble with two
 *  lines, standing for "tell the board something". */
export function SpeechBubble({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinejoin="round"
      strokeLinecap="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.6 3.6c-.5.4-1.4 0-1.4-.7V5.5z" />
      <path d="M8 8h8M8 11.5h5" />
    </svg>
  );
}

/**
 * The microphone glyph `CommandBar`'s mic button draws in place of the 🎤
 * emoji it used before S48. `filled` is the listening state — a solid
 * capsule, as the mock draws it — meant to track the same `aria-pressed`
 * the button around it already carries.
 */
export function Microphone({
  size = 18,
  filled = false,
  className,
}: {
  size?: number;
  filled?: boolean;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <rect x="9" y="3" width="6" height="11" rx="3" fill={filled ? "currentColor" : "none"} />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0" />
      <path d="M12 17.5V21M8.5 21h7" />
    </svg>
  );
}
