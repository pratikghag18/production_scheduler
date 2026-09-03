import styles from "./TargetField.module.css";

/** What the two fields normalise to for the server. */
export interface TargetValue {
  qty: number | null;
  unit: string | null;
}

/**
 * THE ONE PLACE THE TARGET/UNIT RULE LIVES.
 *
 * The maintainer, repeatedly ("this unit thing happened again"): assignments
 * kept getting a stray unit "units" even with no target. The cause was that this
 * field was hand-duplicated in the create popover AND the edit popover, and both
 * seeded the unit input with the literal string `"units"` and, on save, coerced
 * `targetUnit || "units"` — so a unit was written whether or not a quantity was.
 * Sharing the field AND this normaliser is what stops the two drifting again.
 *
 * The rule: a unit only means something next to a quantity. No quantity -> no
 * unit (never the literal "units"). With a quantity, the unit is trimmed and
 * capped, and a blank one collapses to null. "units" is only ever a placeholder.
 */
export function normalizeTarget(qtyRaw: string, unitRaw: string): TargetValue {
  const q = qtyRaw.trim();
  if (q === "") return { qty: null, unit: null };
  const qty = Math.max(1, Number(q) || 1);
  const unit = unitRaw.trim().slice(0, 8);
  return { qty, unit: unit === "" ? null : unit };
}

export function TargetField({
  idPrefix,
  qty,
  unit,
  onQtyChange,
  onUnitChange,
}: {
  /** e.g. "cp" or "ap", so the create and edit forms keep distinct input ids. */
  idPrefix: string;
  qty: string;
  unit: string;
  onQtyChange: (v: string) => void;
  onUnitChange: (v: string) => void;
}) {
  return (
    <>
      <label htmlFor={`${idPrefix}-target`}>Target (optional)</label>
      <div className={styles.row2}>
        <input
          id={`${idPrefix}-target`}
          type="number"
          min={1}
          placeholder="—"
          value={qty}
          onChange={(e) => onQtyChange(e.target.value)}
        />
        <input
          id={`${idPrefix}-unit`}
          aria-label="Target unit"
          type="text"
          maxLength={8}
          placeholder="units"
          value={unit}
          onChange={(e) => onUnitChange(e.target.value)}
        />
      </div>
    </>
  );
}
