import { BoardPopover } from "./BoardPopover";
import styles from "./SplitCoveragePopover.module.css";

export interface SplitCoverageParticipant {
  assignmentId: string | null;
  label: string;
  efficiencyPercent: number;
}

/**
 * D62's `openSplitPop`, ported. The operator's overlapping assignments
 * (editable efficiency fields) plus the incoming assignment, a live peak
 * readout, "Split evenly", and Confirm disabled while the peak exceeds the
 * cap. Cancel reverts and sends nothing (§5 step 7). Built on the existing
 * `BoardPopover` shell, same as every other popover in this feature.
 *
 * D63: the peak readout below is PURE ARITHMETIC over `participants` — the
 * sum of what the user is editing (`splitFits`, Part A) — never a
 * `peakLoad()`-style recomputation. The database's `operator_peak_load()`
 * is what actually re-validates on confirm.
 */
export function SplitCoveragePopover({
  operatorName,
  capPercent,
  participants,
  anchor,
  onChangeParticipant,
  onSplitEvenly,
  onConfirm,
  onCancel,
  fits,
}: {
  operatorName: string;
  capPercent: number;
  participants: SplitCoverageParticipant[];
  anchor: { x: number; y: number };
  onChangeParticipant: (index: number, efficiencyPercent: number) => void;
  onSplitEvenly: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  fits: boolean;
}) {
  const peakPercent = participants.reduce((sum, p) => sum + p.efficiencyPercent, 0);

  return (
    <BoardPopover anchor={anchor} onClose={onCancel} title={`Split coverage — ${operatorName}`}>
      <div className={styles.body}>
        {participants.map((p, i) => (
          <div
            key={p.assignmentId ?? "incoming"}
            className={`${styles.splitRow} ${p.assignmentId === null ? styles.inc : ""}`}
          >
            <span className={styles.splitLbl}>{p.label}</span>
            <input
              type="number"
              min={10}
              max={150}
              step={5}
              value={p.efficiencyPercent}
              aria-label={`${p.label} efficiency percent`}
              onChange={(e) => onChangeParticipant(i, Math.max(0, Number(e.target.value) || 0))}
            />
          </div>
        ))}

        <div className={`${styles.splitFoot} ${fits ? "" : styles.over}`}>
          Peak load: {Math.round(peakPercent)}% {fits ? "" : `(cap ${capPercent}%)`}
        </div>

        <div className={styles.row}>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" onClick={onSplitEvenly}>
            Split evenly
          </button>
          <button type="button" className={styles.pri} disabled={!fits} onClick={onConfirm}>
            Confirm
          </button>
        </div>
      </div>
    </BoardPopover>
  );
}
