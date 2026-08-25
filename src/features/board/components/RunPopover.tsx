import { useState } from "react";
import type { Product } from "@/lib/api";
import type { IndexedRun, IndexedAssignment } from "../lib/boardIndex";
import { formatClock, formatFull, formatNumber, addMinutes } from "../lib/time";
import { BoardPopover } from "./BoardPopover";
import styles from "./RunPopover.module.css";

/**
 * Port of the mockup's `openRunPop` (brief §5.4): product, planned
 * headcount, notes, delete with the cascade/detach choice.
 *
 * Two flagged deviations from a literal port (see the agent report):
 * - `notes` is not in the mockup's `openRunPop` fields at all (the mockup
 *   has no notes UI anywhere) but the brief explicitly lists it for this
 *   popover — added here as the brief requires. `Run.notes` already exists
 *   on the wire shape (`src/lib/api/shapes.ts`), so this is a UI-only
 *   addition, not a new API surface.
 * - The mockup's product select ("one edit = whole crew changes over") is
 *   rendered here as READ-ONLY text, not an editable `<select>`. D36 says
 *   this brief adds no new mutation hook or `src/lib/api/` file, and
 *   `RunFieldEdit`/`updateRunFields` (P1-3b) has no `productId` field —
 *   changing a run's product isn't reachable without widening that P1-3b
 *   surface, which is out of scope here. Flagged, not silently dropped.
 *
 * `RunPopover.module.css` duplicates (rather than imports)
 * `CreatePopover.module.css`'s field styles (`.body label`, `.body input`,
 * `.time`, `.row`, `.pri`) — identical rules to what the mockup's single
 * shared `#pop` stylesheet applied to every popover variant; duplicating
 * the (small) ruleset per component keeps each CSS Module self-contained
 * per `docs/conventions.md`'s one-module-per-component rule.
 */
export function RunPopover({
  run,
  crew,
  anchor,
  windowStart,
  products,
  onCancel,
  onSave,
  onDelete,
}: {
  run: IndexedRun;
  crew: IndexedAssignment[];
  anchor: { x: number; y: number };
  windowStart: Date;
  products: Product[];
  onCancel: () => void;
  onSave: (runId: string, notes: string | null, plannedHeadcount: number | null) => void;
  onDelete: (runId: string, mode: "cascade" | "detach") => void;
}) {
  const [productId] = useState(run.productId);
  const [plannedHeadcount, setPlannedHeadcount] = useState(String(run.plannedHeadcount ?? 1));
  const [notes, setNotes] = useState(run.notes ?? "");
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const staffedHc = crew.reduce((sum, a) => sum + a.efficiencyPercent / 100, 0);
  const product = products.find((p) => p.id === productId);
  const timeLabel = `${formatFull(addMinutes(windowStart, run.startMin))} – ${formatClock(addMinutes(windowStart, run.endMin))} · staffed ${formatNumber(staffedHc)}/${run.plannedHeadcount ?? "—"}`;

  return (
    <BoardPopover
      anchor={anchor}
      onClose={onCancel}
      title={`Run — ${product?.name ?? productId}`}
      width={272}
    >
      <div className={styles.body}>
        <label htmlFor="rp-hc">Planned headcount</label>
        <input
          id="rp-hc"
          type="number"
          min={1}
          max={9}
          value={plannedHeadcount}
          onChange={(e) => setPlannedHeadcount(e.target.value)}
        />

        <label htmlFor="rp-notes">Notes</label>
        <input id="rp-notes" type="text" value={notes} onChange={(e) => setNotes(e.target.value)} />

        <div className={styles.time}>{timeLabel}</div>

        {/* P1-4e D57: this used to say "moving this run is disabled until
            they're detached" — that refusal is deleted, not reworded, now
            that a staffed run moves (crew and all) in one `move_run` call. */}
        {crew.length > 0 && (
          <div className={styles.time}>
            {crew.length} crew assigned — dragging this run moves them all with it.
          </div>
        )}

        {!confirmingDelete ? (
          <div className={styles.row}>
            <button type="button" onClick={() => setConfirmingDelete(true)}>
              Delete
            </button>
            <button type="button" onClick={onCancel}>
              Close
            </button>
            <button
              type="button"
              className={styles.pri}
              onClick={() => {
                const hc =
                  plannedHeadcount.trim() === ""
                    ? null
                    : Math.max(1, Math.round(Number(plannedHeadcount)) || 1);
                onSave(run.id, notes.trim() === "" ? null : notes, hc);
              }}
            >
              Save
            </button>
          </div>
        ) : (
          <>
            <div className={styles.time}>
              Delete this run — cascade removes {crew.length} crew assignment(s) with it, detach
              keeps them as direct assignments.
            </div>
            <div className={styles.row}>
              <button type="button" onClick={() => setConfirmingDelete(false)}>
                Back
              </button>
              <button type="button" onClick={() => onDelete(run.id, "detach")}>
                Detach
              </button>
              <button
                type="button"
                className={styles.pri}
                onClick={() => onDelete(run.id, "cascade")}
              >
                Cascade
              </button>
            </div>
          </>
        )}
      </div>
    </BoardPopover>
  );
}
