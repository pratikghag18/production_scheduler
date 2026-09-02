/* ---------------------------------------------------------------------------
   The shared matrix cell visual — chip, legend and record-in-place popover.

   ⭐ ONE SOURCE FOR BOTH MATRICES (D100, anti-drift). The team matrix
   (`MatrixPanel`) and the single-operator matrix on the Operators tab draw the
   same chips, name the same states and open the same record popover. Rather than
   keep two copies that drift, both import from here. The glyph and the label for
   each state — including the maintainer's rule that `×` is NOT trained and `↻`
   is expired, and the two must never read alike — are decided in ONE place.

   The three record facts (certified on, expires, signed off by) are the same
   three the held-training rows on the Operators tab always carried, in the same
   order, and the popover keeps them OPTIONAL AND INDEPENDENT (0032 / D114 writes
   no CHECK tying them): empty is a fact nobody recorded, not an error.
   --------------------------------------------------------------------------- */
import { useState } from "react";
import { describeSchedulerError, type SchedulerError } from "@/lib/api";
import type { CellState } from "../lib/matrix";
import styles from "./matrixCells.module.css";

/** How many days ahead counts as "expiring soon". A setting later (stage M5). */
export const EXPIRING_WINDOW_DAYS = 30;

/** Legend order — worst-to-clear so a reader scans the problems first. */
export const STATE_ORDER: readonly CellState[] = ["trained", "expiring", "expired", "missing", "na"];

/** ⚠️ THE GLYPHS ARE THE MAINTAINER'S DECISION. `×` = not trained (the intuitive
 *  read), `↻` = expired (renewal overdue). The two must never be confused. */
export const STATE_GLYPH: Record<CellState, string> = {
  trained: "✓",
  expiring: "▲",
  expired: "↻",
  missing: "×",
  na: "·",
};
export const STATE_LABEL: Record<CellState, string> = {
  trained: "Trained",
  expiring: "Expiring soon",
  expired: "Expired",
  missing: "Not trained",
  na: "Not applicable here",
};

/** One cell chip. With `onClick` it is a button (record-in-place); without, a
 *  static marker. The visible glyph carries the state and the `title` spells it
 *  out for a pointer; callers add their own accessible name where a glyph alone
 *  would not name the cell. */
export function MatrixChip({
  state,
  title,
  onClick,
  ariaLabel,
}: {
  state: CellState;
  title: string;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  ariaLabel?: string;
}) {
  const cls = `${styles.chip} ${styles[state]}`;
  if (onClick) {
    return (
      <button type="button" className={`${cls} ${styles.cellBtn}`} title={title} aria-label={ariaLabel} onClick={onClick}>
        {STATE_GLYPH[state]}
      </button>
    );
  }
  return (
    <span className={cls} title={title} aria-label={ariaLabel}>
      {STATE_GLYPH[state]}
    </span>
  );
}

/** The state key for the legend and the grid. */
export function MatrixLegend() {
  return (
    <div className={styles.legend}>
      {STATE_ORDER.map((s) => (
        <span key={s} className={styles.legendItem}>
          <span className={`${styles.chip} ${styles[s]}`}>{STATE_GLYPH[s]}</span>
          {STATE_LABEL[s]}
        </span>
      ))}
    </div>
  );
}

export interface RecordFields {
  certifiedAt: string | null;
  expiresAt: string | null;
  signedOffBy: string | null;
}

export interface RecordPopoverProps {
  /** Who the record is about — the operator's name. */
  who: string;
  /** What it is — the training's name. */
  what: string;
  /** The training's document number, if any. */
  whatRef?: string | null;
  /** Does a holding already exist (edit + remove) or not (record a new one)? */
  held: boolean;
  /** The stored values, or blanks for a fresh record. */
  initial: RecordFields;
  /** Where to anchor the popover — viewport coordinates. */
  position: { top: number; left: number };
  saving: boolean;
  error: SchedulerError | null;
  onSave: (fields: RecordFields) => void;
  onRemove: () => void;
  onClose: () => void;
}

/**
 * Record-in-place: the popover that a cell click opens. Self-contained — it owns
 * its three form fields, initialised from `initial`. Give it a React `key` of
 * the cell so a new cell mounts a fresh form rather than carrying the last one's
 * text.
 *
 * ⚠️ THE THREE FACTS ARE TRIMMED AND NULLED ON THE WAY OUT, not inside the
 * fields: an empty date is `null`, and a signer of only spaces is `null`, so
 * "  " never reaches a column with no trim trigger. None gates the others.
 */
export function RecordPopover({
  who,
  what,
  whatRef,
  held,
  initial,
  position,
  saving,
  error,
  onSave,
  onRemove,
  onClose,
}: RecordPopoverProps) {
  const [certified, setCertified] = useState(initial.certifiedAt ?? "");
  const [expires, setExpires] = useState(initial.expiresAt ?? "");
  const [signedBy, setSignedBy] = useState(initial.signedOffBy ?? "");

  const submit = () =>
    onSave({
      certifiedAt: certified === "" ? null : certified,
      expiresAt: expires === "" ? null : expires,
      signedOffBy: signedBy.trim() === "" ? null : signedBy.trim(),
    });

  return (
    <>
      <div className={styles.scrim} onClick={onClose} aria-hidden="true" />
      <div
        className={styles.pop}
        role="dialog"
        aria-label={`Record ${what} for ${who}`}
        style={{ top: position.top, left: position.left }}
      >
        <div className={styles.popHead}>
          <span className={styles.popWho}>{who}</span>
          <span className={styles.popWhat}>
            {what}
            {whatRef ? ` · ${whatRef}` : ""}
          </span>
        </div>
        <label className={styles.popField}>
          <span>Certified on</span>
          <input type="date" value={certified} disabled={saving} onChange={(e) => setCertified(e.target.value)} />
        </label>
        <label className={styles.popField}>
          <span>Expires</span>
          <input type="date" value={expires} disabled={saving} onChange={(e) => setExpires(e.target.value)} />
        </label>
        <label className={styles.popField}>
          <span>Signed off by</span>
          <input
            type="text"
            value={signedBy}
            placeholder="e.g. R. Silva"
            disabled={saving}
            onChange={(e) => setSignedBy(e.target.value)}
          />
        </label>
        {error && (
          <p className={styles.popError} role="alert">
            {describeSchedulerError(error)}
          </p>
        )}
        <div className={styles.popActions}>
          <button type="button" className={styles.popPrimary} onClick={submit} disabled={saving}>
            {held ? "Save changes" : "Record training"}
          </button>
          {held && (
            <button type="button" className={styles.popDanger} onClick={onRemove} disabled={saving}>
              Remove
            </button>
          )}
          <button type="button" className={styles.popCancel} onClick={onClose} disabled={saving}>
            Cancel
          </button>
        </div>
      </div>
    </>
  );
}
