import { useMemo, useState } from "react";
import type { Product, BoardOperator, Skill } from "@/lib/api";
import type { ShiftChip } from "../hooks/useDragGesture";
import { formatClock, formatFull, addMinutes } from "../lib/time";
import { certificateGaps, type CertificateGap } from "../lib/boardIndex";
import { DEFAULT_DATE_FORMAT, formatCalendarDay, type DateFormat } from "@/lib/format/dates";
import { BoardPopover } from "./BoardPopover";
import { TargetField, normalizeTarget } from "./TargetField";
import styles from "./CreatePopover.module.css";

/** Shown in place of the product picker when nothing belongs at this cell.
 *  An empty `<select>` is a dead control that explains nothing. */
const NO_PRODUCTS_HERE = "No product belongs at this cell, so there is nothing to schedule here.";

/**
 * F-087: what the operator picker appends to a name that has a problem at this
 * cell. The two states get their own words in the LIST as well as in the
 * warning, because the list is where a planner picks somebody — a person who
 * only needs a renewal should not read the same as one who has never done the
 * course, and before this change the second read the same as somebody with no
 * problem at all.
 */
function operatorLabelSuffix(gaps: readonly CertificateGap[]): string {
  const untrained = gaps.some((g) => g.state === "never-trained");
  const lapsed = gaps.some((g) => g.state === "lapsed");
  if (untrained && lapsed) return " — Never trained, and a certificate expired (override)";
  if (untrained) return " — Never trained for this (override)";
  if (lapsed) return " — Certificate expired (override)";
  return "";
}

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
 * forbids — so it is NOT ported; the eligibility half is ported, per D65's
 * own "hint from skillsForNode + operator.skillIds" instruction.
 *
 * ⛔ AND THAT INSTRUCTION IS EXACTLY WHERE F-087 CAME FROM. "Set arithmetic
 * over `skillsForNode`/`operator.skillIds`" answers "was this person ever
 * trained" — and `check_eligibility` has ALSO refused a certificate that ran
 * out before the window ends since migration 0009. So a person whose ticket
 * lapsed a year ago drew as eligible, warned nobody, was offered no override
 * tick, and Create failed with "override required under warn policy" against
 * a screen with no box to supply one: a dead end, not a warning. The board
 * could not have done better — `board_window` sent a bare array of ids with
 * no date on it until migration 0048. The verdict now comes from
 * `certificateGaps` (`../lib/boardIndex`), which is the server's own rule
 * transcribed, judged against the END OF THE WINDOW BEING CREATED.
 *
 * D64, extended by F-087: when the selected operator has a gap this node
 * cares about, the popover names it, says WHICH KIND it is — never trained,
 * or trained and lapsed, which need a course and a renewal respectively —
 * dates the lapsed one through the app's date seam, and offers, under `warn`
 * policy, ONE override checkbox with a required free-text reason (the server
 * has one `p_eligibility_override` covering both). Create stays disabled
 * until either the operator IS eligible, or the box is ticked with a
 * non-empty reason. Under `block` policy there is no override; Create is
 * disabled outright with an explanatory line, matching `create_assignment`'s
 * own refusal (docs/api.md §3 item 2). The server is still the actual
 * authority either way — this is a same-call UI courtesy, not a second
 * security layer (§8's rule, restated for eligibility instead of peak load).
 *
 * D108/0028: `products` arrives ALREADY NARROWED to what is offered at this
 * cell (and to what is still made) — `BoardPage` resolves it from the board
 * index and this node, exactly as it resolves `requiredSkills`. This file
 * holds no scope rule of its own; it only has to cope with the list being
 * short, changing, or empty. Note the asymmetry with the operator picker
 * directly above it, which is deliberate: an operator out of their area is
 * refused with an OVERRIDE, so it is offered with a warning; a product not
 * offered here is refused outright with no override, so it is not offered.
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
  dateFormat = DEFAULT_DATE_FORMAT,
  requiredSkills,
  outsideAreaOperatorIds,
  eligibilityPolicy,
  presetOperatorId,
  onCancel,
  onSubmitRun,
  onSubmitDirect,
  defaultTargetFor,
}: {
  nodeId: string;
  anchor: { x: number; y: number };
  initialRange: { startMin: number; endMin: number };
  shiftChips: ShiftChip[];
  defaultCreateMode: "run" | "direct";
  products: Product[];
  operators: BoardOperator[];
  windowStart: Date;
  dateFormat?: DateFormat;
  /** D64/D65: this node's effective required skills (`skillsForNode`, an
   *  ancestor-inherited union — already resolved by `boardIndex.ts`). */
  requiredSkills: Skill[];
  /**
   * D113: the people who do NOT belong at this cell. Resolved in `BoardPage`
   * from the index and this node, exactly as `requiredSkills` is — the popover
   * holds no rule, it only renders one.
   *
   * ⚠️ THEY ARE OFFERED, NOT HIDDEN, and that is the difference between this
   * list and the product list beside it. A product outside its scope is
   * refused by the database with no way through, so it is filtered out; a
   * person outside theirs can be placed anyway by anyone who may schedule here,
   * with a reason. Filtering them would delete the feature.
   */
  outsideAreaOperatorIds: ReadonlySet<string>;
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
    areaOverride: boolean,
    areaOverrideReason: string | undefined,
    anchor: { x: number; y: number },
  ) => void;
  /**
   * R-316: the TARGET a candidate part, time span and efficiency work out to
   * from this cell's standard cycle time — or null when the cell has no cycle
   * time for that part. A target, not a standard: the standard is the seconds
   * per unit, set once on the Cycle times screen.
   *
   * All three inputs move while this form is open (the product select, the
   * shift chips and the drag handles, the efficiency box), so this is asked per
   * render rather than passed as a number.
   */
  defaultTargetFor?: (
    productId: string,
    range: { startMin: number; endMin: number },
    efficiencyPercent: number,
  ) => number | null;
}) {
  const [mode, setMode] = useState<"run" | "direct">(
    presetOperatorId ? "direct" : defaultCreateMode,
  );
  const [range, setRange] = useState(initialRange);
  // D108/0028: `products` is what is offered AT THIS CELL, so the selection
  // has to survive that list changing under it. Two ways it can:
  //   * it can be EMPTY — no product belongs here — and then there is no
  //     valid id to hold at all;
  //   * the popover can stay MOUNTED while `nodeId` changes (same component
  //     in the same position, so React keeps this state), and the product
  //     picked at the old cell may not be offered at the new one.
  // `useState(products[0]?.id ?? "")` answers neither, because it runs once,
  // on mount: it would leave the popover PRE-SELECTED on a product it is no
  // longer offering, and Create would send it. So what is stored is the
  // user's CHOICE, and the effective id is DERIVED from it every render,
  // falling back to the first thing actually on offer (`""` when there is
  // nothing). No effect, and no render in between showing a stale value.
  const [productChoice, setProductChoice] = useState("");
  const firstOffered = products[0]?.id ?? "";
  const productId = products.some((p) => p.id === productChoice) ? productChoice : firstOffered;
  const [plannedHeadcount, setPlannedHeadcount] = useState("2");
  const [operatorId, setOperatorId] = useState(presetOperatorId ?? operators[0]?.id ?? "");
  const [efficiencyPercent, setEfficiencyPercent] = useState("100");
  const [targetQty, setTargetQty] = useState("");
  const [targetUnit, setTargetUnit] = useState("");
  const [overrideChecked, setOverrideChecked] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  // D113. A SECOND pair, deliberately not reusing the one above: waving through
  // "no Welding ticket" must not silently also place somebody in a plant they
  // are not cleared for. Two decisions, two reasons, two records.
  const [areaChecked, setAreaChecked] = useState(false);
  const [areaReason, setAreaReason] = useState("");

  const timeLabel = `${formatFull(addMinutes(windowStart, range.startMin), dateFormat)} – ${formatClock(addMinutes(windowStart, range.endMin))}`;

  // R-316: recomputed as the part, the span or the efficiency changes. Only
  // meaningful in direct mode — a run carries no target of its own.
  const typedEfficiency = Number(efficiencyPercent);
  const derivedQty =
    productId === ""
      ? null
      : (defaultTargetFor?.(
          productId,
          range,
          Number.isFinite(typedEfficiency) && typedEfficiency > 0 ? typedEfficiency : 100,
        ) ?? null);

  /**
   * F-087. This used to be `requiredSkills.filter((s) => !o.skillIds.includes(s.id))`
   * — "does this person hold the training at all" — and EXPIRY WAS NEVER
   * CONSIDERED. So somebody whose certificate lapsed a year ago drew as
   * eligible, warned nobody, was offered no override tick, and Create then
   * failed with "override required under warn policy" against a screen with no
   * box to supply one. `certificateGaps` asks `check_eligibility`'s own
   * question instead, and answers it per REASON rather than per person.
   *
   * ⚠️ IT DEPENDS ON `range.endMin`, WHICH MOVES WHILE THIS FORM IS OPEN. The
   * server compares against the END of the window being written, so dragging a
   * handle past a renewal date has to change the answer here too — exactly as
   * it changes it on the server.
   */
  const windowEnd = addMinutes(windowStart, range.endMin);
  const gapsByOperator = useMemo(() => {
    const m = new Map<string, CertificateGap[]>();
    if (requiredSkills.length === 0) return m;
    for (const o of operators) {
      const gaps = certificateGaps(o, requiredSkills, windowEnd);
      if (gaps.length > 0) m.set(o.id, gaps);
    }
    return m;
    // `windowEnd` is a fresh Date each render; its INSTANT is what the answer
    // turns on, so the memo keys on that rather than on object identity.
  }, [operators, requiredSkills, windowEnd.getTime()]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedOutsideArea = outsideAreaOperatorIds.has(operatorId);
  const selectedGaps = gapsByOperator.get(operatorId) ?? [];
  const selectedUntrained = selectedGaps.filter((g) => g.state === "never-trained");
  const selectedLapsed = selectedGaps.filter(
    (g): g is Extract<CertificateGap, { state: "lapsed" }> => g.state === "lapsed",
  );
  const ineligible = selectedGaps.length > 0;
  const blocked = ineligible && eligibilityPolicy === "block";
  const needsOverride = ineligible && eligibilityPolicy === "warn";
  // Both modes send a product — `create_run` requires one and `submitCreateDirect`
  // always builds a `{ kind: "direct", productId }` target — so an empty offer
  // list disables Create in either mode rather than posting `""` for the server
  // to refuse.
  const createDisabled =
    productId === "" ||
    (mode === "direct" &&
      (blocked ||
        (needsOverride && (!overrideChecked || overrideReason.trim() === "")) ||
        // D113: the server refuses an override with no reason, so the button
        // must not offer to send one. Same shape as the line above it.
        (selectedOutsideArea && (!areaChecked || areaReason.trim() === ""))));

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
            {products.length === 0 ? (
              <p className={styles.time}>{NO_PRODUCTS_HERE}</p>
            ) : (
              <>
                <label htmlFor="cp-prod">Product</label>
                <select
                  id="cp-prod"
                  value={productId}
                  onChange={(e) => setProductChoice(e.target.value)}
                >
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </>
            )}
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
                  {/* F-087: the list used to say "— not certified (override)"
                      for a missing training and NOTHING AT ALL for a lapsed
                      one. Two problems, two labels, so the difference is
                      visible before anybody is selected. */}
                  {operatorLabelSuffix(gapsByOperator.get(o.id) ?? [])}
                  {outsideAreaOperatorIds.has(o.id) ? " — not from this area (override)" : ""}
                </option>
              ))}
            </select>
            {products.length === 0 ? (
              <p className={styles.time}>{NO_PRODUCTS_HERE}</p>
            ) : (
              <>
                <label htmlFor="cp-dprod">Product</label>
                <select
                  id="cp-dprod"
                  value={productId}
                  onChange={(e) => setProductChoice(e.target.value)}
                >
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </>
            )}
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
            <TargetField
              idPrefix="cp"
              qty={targetQty}
              unit={targetUnit}
              onQtyChange={setTargetQty}
              onUnitChange={setTargetUnit}
              derivedQty={derivedQty}
            />

            {selectedOutsideArea && (
              <div className={styles.eligWarn}>
                {/* D113: "the area rule becomes a strong warning rather than a
                    wall, and the audit log carries who waved it through." */}
                <p>This person doesn&rsquo;t belong to this part of the structure.</p>
                <label className={styles.overrideLbl}>
                  <input
                    type="checkbox"
                    checked={areaChecked}
                    onChange={(e) => setAreaChecked(e.target.checked)}
                  />
                  Place them here anyway
                </label>
                {areaChecked && (
                  <>
                    <label htmlFor="cp-area-reason">Reason (required)</label>
                    <input
                      id="cp-area-reason"
                      type="text"
                      value={areaReason}
                      onChange={(e) => setAreaReason(e.target.value)}
                      placeholder="Why are they working here?"
                    />
                  </>
                )}
              </div>
            )}

            {ineligible && (
              <div className={styles.eligWarn}>
                {/* ⛔ F-087: TWO PARAGRAPHS, NEVER ONE. "Never trained" needs a
                    course booked; "certificate expired" needs a renewal. The
                    old screen printed one sentence for the first and nothing
                    at all for the second. Each names the trainings it is about,
                    and the expired one names the DATE — through the app's date
                    seam, in the org's chosen format. */}
                {selectedUntrained.length > 0 && (
                  <p>
                    <strong>Never trained:</strong>{" "}
                    {selectedUntrained.map((g) => g.skill.name).join(", ")}. Booking the training is
                    what fixes this.
                  </p>
                )}
                {selectedLapsed.length > 0 && (
                  <p>
                    <strong>Certificate expired:</strong>{" "}
                    {selectedLapsed
                      .map(
                        (g) =>
                          `${g.skill.name} (expired ${formatCalendarDay(g.expiresAt, dateFormat)})`,
                      )
                      .join(", ")}
                    . They held this — it needs renewing before this shift ends.
                  </p>
                )}
                {blocked ? (
                  <p>This org requires certification for this cell, so there is no override.</p>
                ) : (
                  <>
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
                // Shared with the edit popover so the two cannot drift again: no
                // quantity means no unit (never the literal "units").
                const target = normalizeTarget(targetQty, targetUnit);
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
                  target.qty ?? undefined,
                  target.unit ?? undefined,
                  needsOverride && overrideChecked,
                  needsOverride && overrideChecked ? overrideReason.trim() : undefined,
                  // D113: sent only when it actually overrode something. The
                  // server normalises the flag off anyway, so this is belt and
                  // braces — but a client that always sent `true` would make
                  // every screen reading the flag say "overridden" about rows
                  // nobody decided anything about.
                  selectedOutsideArea && areaChecked,
                  selectedOutsideArea && areaChecked ? areaReason.trim() : undefined,
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
