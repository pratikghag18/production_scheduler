import { useState } from "react";
import type { Product, BoardOperator } from "@/lib/api";
import type { IndexedAssignment, IndexedRun } from "../lib/boardIndex";
import { formatClock, formatFull, addMinutes } from "../lib/time";
import { DEFAULT_DATE_FORMAT, type DateFormat } from "@/lib/format/dates";
import { BoardPopover } from "./BoardPopover";
import { TargetField, normalizeTarget } from "./TargetField";
import styles from "./AssignmentPopover.module.css";

const STATUS_OPTIONS = ["planned", "active", "done"];

/**
 * Port of the mockup's `openChipPop` (run-attached) / `openDirectPop`
 * (direct) — brief §5.4 combines both into one component keyed on whether
 * `homeRun` is set. The delete label differs in the mockup ("Remove" for
 * a chip vs "Delete" for a direct block); unified here as "Delete".
 *
 * Two flagged deviations from a literal port (see the agent report):
 * - The mockup's `openDirectPop` has an editable product `<select>` for a
 *   direct assignment ("Product (one edit = whole crew changes over)" on
 *   the run popover; a plain product select here). `AssignmentFieldEdit`/
 *   `updateAssignmentFields` (P1-3b, not to be extended per D36) has no
 *   `productId` field, so product is read-only here for BOTH a
 *   run-attached chip and a direct assignment, same reasoning as
 *   `RunPopover`'s read-only product field — see that file's header
 *   comment.
 * - `status` is a brief-only addition (§5.4 lists it; neither
 *   `openChipPop` nor `openDirectPop` has a status control in the mockup)
 *   — flagged, not silently ported. Values are the three non-terminal
 *   states from `docs/design-plan.md`'s `status text ... -- planned |
 *   active | done | cancelled`; `cancelled` is reached only via the
 *   Delete button (rule 17 of `boardIndex.ts` already drops cancelled
 *   rows everywhere), not offered as a fourth option here to avoid a
 *   second, redundant path to the same effect as Delete.
 */
export function AssignmentPopover({
  assignment,
  homeRun,
  operator,
  products,
  anchor,
  windowStart,
  dateFormat = DEFAULT_DATE_FORMAT,
  onCancel,
  onSave,
  onDelete,
}: {
  assignment: IndexedAssignment;
  homeRun: IndexedRun | null;
  operator: BoardOperator | undefined;
  products: Product[];
  anchor: { x: number; y: number };
  windowStart: Date;
  dateFormat?: DateFormat;
  onCancel: () => void;
  onSave: (
    assignmentId: string,
    efficiencyPercent: number,
    targetQty: number | null,
    targetUnit: string | null,
    status: string,
  ) => void;
  onDelete: (assignmentId: string) => void;
}) {
  const isDirect = homeRun === null;
  const currentProductId = isDirect ? (assignment.productId ?? "") : homeRun.productId;
  const [efficiencyPercent, setEfficiencyPercent] = useState(String(assignment.efficiencyPercent));
  const [targetQty, setTargetQty] = useState(
    assignment.targetQty == null ? "" : String(assignment.targetQty),
  );
  const [targetUnit, setTargetUnit] = useState(assignment.targetUnit ?? "");
  const [status, setStatus] = useState(
    STATUS_OPTIONS.includes(assignment.status) ? assignment.status : "planned",
  );

  const product = products.find((p) => p.id === currentProductId);
  const name = operator?.displayName ?? "(unknown operator)";
  const timeLabel = `${formatFull(addMinutes(windowStart, assignment.startMin), dateFormat)} – ${formatClock(addMinutes(windowStart, assignment.endMin))}${assignment.eligibilityOverride ? " · certification override" : ""}`;

  return (
    <BoardPopover anchor={anchor} onClose={onCancel} title={`${name} — ${product?.name ?? "—"}`}>
      <div className={styles.body}>
        <label htmlFor="ap-eff">Efficiency %</label>
        <input
          id="ap-eff"
          type="number"
          min={10}
          max={150}
          step={5}
          value={efficiencyPercent}
          onChange={(e) => setEfficiencyPercent(e.target.value)}
        />

        <TargetField
          idPrefix="ap"
          qty={targetQty}
          unit={targetUnit}
          onQtyChange={setTargetQty}
          onUnitChange={setTargetUnit}
        />

        <label htmlFor="ap-status">Status</label>
        <select id="ap-status" value={status} onChange={(e) => setStatus(e.target.value)}>
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>

        <div className={styles.time}>{timeLabel}</div>

        <div className={styles.row}>
          <button type="button" onClick={() => onDelete(assignment.id)}>
            Delete
          </button>
          <button type="button" onClick={onCancel}>
            Close
          </button>
          <button
            type="button"
            className={styles.pri}
            onClick={() => {
              const eff = Math.max(10, Math.min(150, Number(efficiencyPercent) || 100));
              const { qty, unit } = normalizeTarget(targetQty, targetUnit);
              onSave(assignment.id, eff, qty, unit, status);
            }}
          >
            Save
          </button>
        </div>
      </div>
    </BoardPopover>
  );
}
