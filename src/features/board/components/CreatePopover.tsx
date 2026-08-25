import { useMemo, useState } from "react";
import type { Product, BoardOperator, Skill } from "@/lib/api";
import type { ShiftChip } from "../hooks/useDragGesture";
import { formatClock, formatFull, addMinutes } from "../lib/time";
import { BoardPopover } from "./BoardPopover";
import styles from "./CreatePopover.module.css";

/**
 * Port of the mockup's `openCreatePop` (brief §5.4/P1-4e D64/D65). D35:
 * `mode` is pre-selected from `profile.defaultCreateMode` and the user can
 * flip it — UNLESS `presetOperatorId` is set (D65: a panel drop always
 * opens this popover in forced "direct" mode with that operator selected).
 *
 * P1-4b's own comment on this file said the mockup's per-operator hints
 * ("— at 100% (will ask to split)", "— not certified (override)") were
 * "omitted here per the scope fence, not silently ported" — this brief is
 * exactly where the fence lifts, but only HALF the hint is ported. The
 * "will ask to split" half requires the mockup's client-side `peakLoad()`
 * — exactly the second implementation of `operator_peak_load()` D63/§8
 * forbids — so it is NOT ported; the eligibility half ("not certified") is
 * plain set arithmetic over `skillsForNode`/`operator.skillIds` (no peak
 * load involved) and is ported, per D65's own "hint from skillsForNode +
 * operator.skillIds" instruction.
 *
 * D64: when the selected operator is missing a skill this node requires,
 * shows what is missing and — under `warn` policy — an override checkbox
 * with a required free-text reason; Create stays disabled until either the
 * operator IS eligible, or the box is ticked with a non-empty reason.
 * Under `block` policy there is no override; Create is disabled outright
 * with an explanatory line, matching `create_assignment`'s own refusal
 * (docs/api.md §3 item 2). The server is still the actual authority
 * either way — this is a same-call UI courtesy, not a second security
 * layer (§8's rule, restated for eligibility instead of peak load).
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
  requiredSkills,
  eligibilityPolicy,
  presetOperatorId,
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
  /** D64/D65: this node's effective required skills (`skillsForNode`, an
   *  ancestor-inherited union — already resolved by `boardIndex.ts`). */
  requiredSkills: Skill[];
  eligibilityPolicy: "warn" | "block";
  /** D65: set only when this popover was opened by a panel drop. */
  presetOperatorId?: string;
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
    eligibilityOverride: boolean,
    overrideReason: string | undefined,
    anchor: { x: number; y: number },
  ) => void;
}) {
  const [mode, setMode] = useState<"run" | "direct">(
    presetOperatorId ? "direct" : defaultCreateMode,
  );
  const [range, setRange] = useState(initialRange);
  const [productId, setProductId] = useState(products[0]?.id ?? "");
  const [plannedHeadcount, setPlannedHeadcount] = useState("2");
  const [operatorId, setOperatorId] = useState(presetOperatorId ?? operators[0]?.id ?? "");
  const [efficiencyPercent, setEfficiencyPercent] = useState("100");
  const [targetQty, setTargetQty] = useState("");
  const [targetUnit, setTargetUnit] = useState("units");
  const [overrideChecked, setOverrideChecked] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");

  const timeLabel = `${formatFull(addMinutes(windowStart, range.startMin))} – ${formatClock(addMinutes(windowStart, range.endMin))}`;

  const missingSkillsByOperator = useMemo(() => {
    const m = new Map<string, Skill[]>();
    if (requiredSkills.length === 0) return m;
    for (const o of operators) {
      const missing = requiredSkills.filter((s) => !o.skillIds.includes(s.id));
      if (missing.length > 0) m.set(o.id, missing);
    }
    return m;
  }, [operators, requiredSkills]);

  const selectedMissing = missingSkillsByOperator.get(operatorId) ?? [];
  const ineligible = selectedMissing.length > 0;
  const blocked = ineligible && eligibilityPolicy === "block";
  const needsOverride = ineligible && eligibilityPolicy === "warn";
  const createDisabled =
    mode === "direct" &&
    (blocked || (needsOverride && (!overrideChecked || overrideReason.trim() === "")));

  return (
    <BoardPopover anchor={anchor} onClose={onCancel} title="New">
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
                  {missingSkillsByOperator.has(o.id) ? " — not certified (override)" : ""}
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

            {ineligible && (
              <div className={styles.eligWarn}>
                {blocked ? (
                  <p>
                    Missing {selectedMissing.map((s) => s.name).join(", ")} — this org requires
                    certification for this cell (no override).
                  </p>
                ) : (
                  <>
                    <p>Missing {selectedMissing.map((s) => s.name).join(", ")}.</p>
                    <label className={styles.overrideLbl}>
                      <input
                        type="checkbox"
                        checked={overrideChecked}
                        onChange={(e) => setOverrideChecked(e.target.checked)}
                      />
                      Override — I'm certifying this placement anyway
                    </label>
                    {overrideChecked && (
                      <>
                        <label htmlFor="cp-override-reason">Reason (required)</label>
                        <input
                          id="cp-override-reason"
                          type="text"
                          value={overrideReason}
                          onChange={(e) => setOverrideReason(e.target.value)}
                          placeholder="Why is this OK?"
                        />
                      </>
                    )}
                  </>
                )}
              </div>
            )}
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
            disabled={createDisabled}
            onClick={() => {
              if (mode === "run") {
                const hc = Math.max(1, Math.round(Number(plannedHeadcount)) || 1);
                onSubmitRun(nodeId, range, productId, hc);
              } else {
                const eff = Math.max(10, Math.min(150, Number(efficiencyPercent) || 100));
                const tRaw = targetQty.trim();
                const qty = tRaw === "" ? undefined : Math.max(1, Number(tRaw) || 1);
                // D64: "never send an override the user did not tick" —
                // `needsOverride && overrideChecked` is the only path that
                // sends `eligibilityOverride: true`; every other case
                // (fully eligible, or blocked-and-disabled so unreachable)
                // sends `false`/`undefined`.
                onSubmitDirect(
                  nodeId,
                  range,
                  operatorId,
                  productId,
                  eff,
                  qty,
                  (targetUnit || "units").slice(0, 8),
                  needsOverride && overrideChecked,
                  needsOverride && overrideChecked ? overrideReason.trim() : undefined,
                  anchor,
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
