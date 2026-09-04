/**
 * THE COLLAPSE TOGGLE — one button, one look, everywhere a left panel folds.
 *
 * The maintainer, 3 Sept: the collapse button looked different on the board and
 * the admin pages. It did — the admin rail drew a borderless 0.875rem glyph and
 * the board's operator panel drew a bordered 20px box scaled by `--ui-scale`.
 * Unifying only the chevron (icons.tsx) was not enough; the BUTTON around it has
 * to be one thing too. This component is that button: identical chrome, the
 * shared `Chevron`, and the state-to-direction rule in ONE place.
 *
 * Left panels only (the two we have). The chevron points AT the panel edge when
 * open (left) and AWAY when collapsed (right), so it always points the way the
 * click will move the panel.
 */
import { Chevron } from "./icons";
import styles from "./PanelToggle.module.css";

export function PanelToggle({
  collapsed,
  onToggle,
  label,
  className,
}: {
  collapsed: boolean;
  onToggle: () => void;
  /** The thing being folded, for the label/title, e.g. "admin sections". */
  label: string;
  /** Optional positioning class from the host layout (never chrome). */
  className?: string;
}) {
  const verb = collapsed ? "Show" : "Hide";
  return (
    <button
      type="button"
      className={className === undefined ? styles.toggle : `${styles.toggle} ${className}`}
      aria-label={`${verb} the ${label}`}
      aria-expanded={!collapsed}
      title={`${verb} ${label}`}
      onClick={onToggle}
    >
      <Chevron direction={collapsed ? "right" : "left"} />
    </button>
  );
}
