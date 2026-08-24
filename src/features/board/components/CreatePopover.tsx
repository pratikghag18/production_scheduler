import { useState } from "react";
import type { Product, BoardOperator } from "@/lib/api";
import type { ShiftChip } from "../hooks/useDragGesture";
import { formatClock, formatFull, addMinutes } from "../lib/time";
import { BoardPopover } from "./BoardPopover";
import styles from "./CreatePopover.module.css";

/**
 * Port of the mockup's `openCreatePop` (brief §5.4). D35: `mode` is
 * pre-selected from `profile.defaultCreateMode` and the user can flip it.
 * The per-operator hints the mockup shows next to each name (*"— at 100%
 * (will ask to split)"*, *"— not certified (override)"*) are P1-4c
 * (split-coverage / eligibility overrides) — omitted here per the scope
 * fence (§5.4), not silently ported.
 *
 * Field/label/input styling is scoped under the local `.body` wrapper
 * (`.body label`, `.body select, .body input`) rather than the mockup's
 * `#pop label` / `#pop select, #pop input` — CSS Modules only hash class
 * selectors, so a bare `label {}`/`input {}` rule here would leak globally
 * to every form in the app; `.body` reproduces the mockup's id-scoped
 * descendant shape locally instead of flattening it away (§10.1's trap).
 */
export function CreatePopover({
  nodeId,
  anchor,
  initialRange,
  shiftChips,
  defaultCreateMode,
  products,
  operators,
  windowStart,
  onCancel,
  onSubmitRun,
  onSubmitDirect,
}: {
  nodeId: string;
  anchor: { x: number; y: number };
  initialRange: { startMin: number; endMin: number };
  shiftChips: ShiftChip[];
  defaultCreateMode: "run" | "direct";
  products: Product[];
  operators: BoardOperator[];
  windowStart: Date;
  onCancel: () => void;
  onSubmitRun: (
    nodeId: string,
    range: { startMin: number; endMin: number },
    productId: string,
    plannedHeadcount: number | undefined,
  ) => void;
  onSubmitDirect: (
    nodeId: string,
    range: { startMin: number; endMin: number },
    operatorId: string,
    productId: string,
    efficiencyPercent: number,
    targetQty: number | undefined,
    targetUnit: string | undefined,
  ) => void;
}) {
  const [mode, setMode] = useState<"run" | "direct">(defaultCreateMode);
  const [range, setRange] = useState(initialRange);
  const [productId, setProductId] = useState(products[0]?.id ?? "");
  const [plannedHeadcount, setPlannedHeadcount] = useState("2");
  const [operatorId, setOperatorId] = useState(operators[0]?.id ?? "");
  const [efficiencyPercent, setEfficiencyPercent] = useState("100");
  const [targetQty, setTargetQty] = useState("");
  const [targetUnit, setTargetUnit] = useState("units");

  const timeLabel = `${formatFull(addMinutes(windowStart, range.startMin))} – ${formatClock(addMinutes(windowStart, range.endMin))}`;

  return (
    <BoardPopover anchor={anchor} onClose={onCancel} title="New" width={272}>
      <div className={styles.body}>
        <div className={styles.seg}>
          <button
            type="button"
            className={mode === "run" ? styles.segOn : ""}
            onClick={() => setMode("run")}
          >
            Product run
          </button>
          <button
            type="button"
            className={mode === "direct" ? styles.segOn : ""}
            onClick={() => setMode("direct")}
          >
            Direct assignment
          </button>
        </div>

        {shiftChips.length > 0 && (
          <div className={styles.shiftChipRow}>
            {shiftChips.map((c) => (
              <button
                key={`${c.name}-${c.startMin}`}
                type="button"
                className={styles.shiftChipBtn}
                onClick={() => setRange({ startMin: c.startMin, endMin: c.endMin })}
              >
                {c.name} {formatClock(addMinutes(windowStart, c.startMin))}–
                {formatClock(addMinutes(windowStart, c.endMin))}
              </button>
            ))}
          </div>
        )}

        {mode === "run" ? (
          <>
            <label htmlFor="cp-prod">Product</label>
            <select id="cp-prod" value={productId} onChange={(e) => setProductId(e.target.value)}>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <label htmlFor="cp-hc">Planned headcount</label>
            <input
              id="cp-hc"
              type="number"
              min={1}
              max={9}
              value={plannedHeadcount}
              onChange={(e) => setPlannedHeadcount(e.target.value)}
            />
          </>
        ) : (
          <>
            <label htmlFor="cp-op">Operator</label>
            <select id="cp-op" value={operatorId} onChange={(e) => setOperatorId(e.target.value)}>
              {operators.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.displayName}
                </option>
              ))}
            </select>
            <label htmlFor="cp-dprod">Product</label>
            <select id="cp-dprod" value={productId} onChange={(e) => setProductId(e.target.value)}>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <label htmlFor="cp-eff">Efficiency %</label>
            <input
              id="cp-eff"
              type="number"
              min={10}
              max={150}
              step={5}
              value={efficiencyPercent}
              onChange={(e) => setEfficiencyPercent(e.target.value)}
            />
            <label htmlFor="cp-target">Target (optional)</label>
            <div className={styles.row2}>
              <input
                id="cp-target"
                type="number"
                min={1}
                placeholder="—"
                value={targetQty}
                onChange={(e) => setTargetQty(e.target.value)}
              />
              <input
                id="cp-unit"
                aria-label="Target unit"
                type="text"
                maxLength={8}
                value={targetUnit}
                onChange={(e) => setTargetUnit(e.target.value)}
              />
            </div>
          </>
        )}

        <div className={styles.time}>{timeLabel}</div>

        <div className={styles.row}>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={styles.pri}
            onClick={() => {
              if (mode === "run") {
                const hc = Math.max(1, Math.round(Number(plannedHeadcount)) || 1);
                onSubmitRun(nodeId, range, productId, hc);
              } else {
                const eff = Math.max(10, Math.min(150, Number(efficiencyPercent) || 100));
                const tRaw = targetQty.trim();
                const qty = tRaw === "" ? undefined : Math.max(1, Number(tRaw) || 1);
                onSubmitDirect(
                  nodeId,
                  range,
                  operatorId,
                  productId,
                  eff,
                  qty,
                  (targetUnit || "units").slice(0, 8),
                );
              }
            }}
          >
            Create
          </button>
        </div>
      </div>
    </BoardPopover>
  );
}
