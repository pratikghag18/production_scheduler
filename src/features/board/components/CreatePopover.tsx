import { useEffect, useMemo, useRef, useState } from "react";
import type { Product, BoardOperator, Skill, AssignmentTarget } from "@/lib/api";
import type { ShiftChip } from "../hooks/useDragGesture";
import { formatClock, formatFull, addMinutes } from "../lib/time";
import { certificateGaps, type CertificateGap } from "../lib/boardIndex";
import { absenceGaps, type AbsenceRow, type AbsenceHit } from "@/lib/absence";
import { leaveLine } from "../lib/leave";
import { DEFAULT_DATE_FORMAT, formatCalendarDay, type DateFormat } from "@/lib/format/dates";
import { BoardPopover } from "./BoardPopover";
import { TargetField, normalizeTarget } from "./TargetField";
import fieldStyles from "@/components/Field.module.css";
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
  hereOperatorIds,
  windowStart,
  dateFormat = DEFAULT_DATE_FORMAT,
  zone,
  requiredSkills,
  outsideAreaOperatorIds,
  eligibilityPolicy,
  absences = [],
  presetOperatorId,
  presetProductId,
  presetRun,
  autoCreate,
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
  /**
   * ⭐ R-342: THE LEFT PANEL'S OWN LIST — this plant's people (`operatorPool` in
   * `BoardPage`). The maintainer, 6 Sept: *"Operators from other plants should
   * not be shown in the list, period, it is the same as the operators shown on
   * the left panel."*
   *
   * ⚠️ IT USED TO BE `boardQuery.data.operators`, WHICH WAS EVERY PERSON IN THE
   * COMPANY — `board_window` returned them all so that a chip for a cross-plant
   * assignment could still be DRAWN (S18), and drawing a name and offering it
   * are different questions. That is settled at the source now: migration 0058
   * sends the PLANT'S people and R-345's table guard refuses a placement across
   * plants outright, so no such assignment can be made and none is left to draw.
   * `src/test/pickerPool.test.ts` is what stops this list and the panel's
   * drifting apart again.
   *
   * ⚠️ ONLY THE DIRECT-ASSIGNMENT TAB CHOOSES A PERSON. The Product run tab
   * writes a run with a planned headcount and no operator at all, so there is
   * nothing there to narrow, mark, or ask a reason for; the crew is attached
   * afterwards, through the assignment pop-up.
   */
  operators: BoardOperator[];
  /**
   * ⭐⭐ R-346: of `operators`, the ones offered at THIS CELL by default —
   * home covers the cell, or sits inside it. The select opens on exactly these;
   * the rest of the plant is added by the "Show other people in this plant"
   * control under it, marked, and taken through the D113 reason below.
   *
   * The maintainer, 6 Sept: *"If a operator is assigned to higher hierarchy
   * they should automatically become available to all lower hierarchy within
   * that hierarchy ... That should be the default behaviour. For other
   * operators in the plant we need to give an option to the supervisor to click
   * through something so show remaining operators."*
   *
   * ⚠️ NOT THE COMPLEMENT OF `outsideAreaOperatorIds` BELOW, and the two are
   * kept apart on purpose. Both are resolved by `lib/outsideArea.ts`, but the
   * split is about being offered and the mark is about needing a reason — a
   * person homed inside this cell's own subtree is a default offer AND marked.
   */
  hereOperatorIds: ReadonlySet<string>;
  windowStart: Date;
  dateFormat?: DateFormat;
  zone?: string;
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
   *
   * ⚠️⚠️ R-342 / R-345 PUT A FLOOR UNDER THAT, AND THE TWO STATEMENTS ARE NOT
   * IN CONFLICT. What is offered-and-marked is ANOTHER AREA OF THIS PLANT.
   * Another PLANT is not in `operators` at all (see that prop above) and cannot
   * be placed here by any writer, so this set never has to speak for one. The
   * mark is still what the maintainer asked for and the server still asks for
   * the reason: it is decided from each person's own home PATH against this
   * cell's, the comparison `app_owner_covers_in_org` makes.
   *
   * ⚠️ AND IT IS DECIDED WITHOUT THE BOARD'S NODE MAP NOW (R-346). The map
   * starts at the reader's grant, so for a supervisor granted a line the plant
   * above it was missing and everyone homed there was marked — a reason asked
   * for a placement the server takes without one.
   */
  outsideAreaOperatorIds: ReadonlySet<string>;
  /**
   * ⭐ R-331 / migration 0051: THE POLICY FOR **THIS** NODE, resolved on the
   * server and looked up by `BoardPage` through `policyForNode` — not
   * `org.settings.eligibility_policy`, which is only what a node inherits when
   * nothing nearer overrides it.
   *
   * Until 0051 the board handed every cell in the company the same value, so on
   * a plant deliberately set to `block` this popover still drew an override tick
   * and a reason box, and Create then failed with a message about an override
   * the server would never take — a dead end, the same shape as F-087. Like
   * `requiredSkills` and `outsideAreaOperatorIds` beside it, this is resolved
   * before it gets here: the popover holds no rule, it only renders one.
   */
  eligibilityPolicy: "warn" | "block";
  /**
   * R-357: every absence the board can see (RLS-scoped upstream to this board's
   * own people). `absenceGaps` narrows it to the selected person and the window
   * being written — the same predicate `create_assignment` runs — so a person on
   * leave is named BEFORE Create, and Create is refused in place under `block`,
   * exactly as the expired-certificate case is (R-338). There is no override:
   * the server takes no absence override, so under `warn` this is a warning only
   * and Create stays enabled (offering a reason box the server ignores would be
   * the screen refusing what the server allows — CLAUDE.md §4).
   *
   * Optional with an empty default so a test or a caller that has no absences
   * loaded renders exactly the pre-R-357 pop-up; `BoardPage` always passes the
   * board's own list.
   */
  absences?: readonly AbsenceRow[];
  /** D65: set only when this popover was opened by a panel drop. */
  presetOperatorId?: string;
  /**
   * P1-7a: set when this popover was opened from the typed command bar
   * resolving to a direct product target (R-378) — preselects `productChoice`
   * the same way `presetOperatorId` preselects the operator. The existing
   * `productId` derivation (falls back to the first offered product when the
   * choice is not on the list) already copes with a preset that turns out not
   * to be offered here — belt, not braces: the resolver has already refused
   * that case (`not_offered`) before this popover ever opens.
   */
  presetProductId?: string;
  /**
   * P1-7a / R-383: set when the typed command's span landed inside a job
   * already booked for that part on that cell and the person chose to join it.
   * There is nothing to pick — the part is the run's — so the product select
   * is replaced by one read-only "Joining <label>" line, and Create sends this
   * run as the target instead of `productId`.
   */
  presetRun?: { id: string; label: string };
  /**
   * R-384: set only by `openCreateFromCommand` — the typed command bar's
   * Enter path — never by a drag or a keyboard create. When true and the
   * pop-up's own verdicts read clean (see `clean` below), Create is pressed
   * once, on mount, with exactly the arguments a real click would send.
   */
  autoCreate?: boolean;
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
    /** P1-7a: was `productId: string` — now whichever target the person
     *  actually chose (the product select, or the joined run's id under
     *  `presetRun`), threaded straight through to `create_assignment`. */
    target: AssignmentTarget,
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
  const [productChoice, setProductChoice] = useState(presetProductId ?? "");
  const firstOffered = products[0]?.id ?? "";
  const productId = products.some((p) => p.id === productChoice) ? productChoice : firstOffered;
  const [plannedHeadcount, setPlannedHeadcount] = useState("2");

  /**
   * ⭐⭐ R-346: THE SELECT OPENS ON `here` AND NOTHING ELSE. The rest of the
   * plant is one press away, and the press is the supervisor's decision --
   * "we need to give an option to the supervisor to click through something so
   * show remaining operators so they can make that decision to assign someone
   * outside of that area."
   *
   * ⚠️ A PRESET FROM OUTSIDE THE AREA OPENS THE LIST ALREADY REVEALED. `BoardPage`
   * sets `presetOperatorId` when this pop-up was opened by dropping a panel chip,
   * and the panel can drop somebody from the rest of the plant (that is the whole
   * point of its own control). A `<select>` whose value matches no option shows
   * the FIRST option instead, so a hidden preset would silently swap the person
   * the user just dragged -- the same failure mode AP8 records in the assignment
   * pop-up. The person picked is pinned into the list for the same reason.
   */
  // ACTIVE PEOPLE ONLY, the same filter the panel and the assignment pop-up
  // apply before their own split. The first draft split the whole list here,
  // so the panel showed no "other people" control while this pop-up counted
  // one --- a person who had left --- and offered them (the reviewer, session
  // 78). The three render one decision; they must filter the same way first.
  const here = useMemo(
    () => operators.filter((o) => o.active && hereOperatorIds.has(o.id)),
    [operators, hereOperatorIds],
  );
  const elsewhere = useMemo(
    () => operators.filter((o) => o.active && !hereOperatorIds.has(o.id)),
    [operators, hereOperatorIds],
  );
  // Opens on `here` and nothing else: with nobody homed at or above this cell
  // the select starts empty rather than on a person from behind the click.
  const [operatorId, setOperatorId] = useState(presetOperatorId ?? here[0]?.id ?? "");
  const [showOthers, setShowOthers] = useState(
    presetOperatorId !== undefined && !hereOperatorIds.has(presetOperatorId),
  );
  const offeredPeople = showOthers
    ? [...here, ...elsewhere]
    : [...here, ...elsewhere.filter((o) => o.id === operatorId)];
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

  const timeLabel = `${formatFull(addMinutes(windowStart, range.startMin), dateFormat, zone)} – ${formatClock(addMinutes(windowStart, range.endMin), zone)}`;

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

  // R-357: the leave check, the twin of `gapsByOperator` right above and keyed
  // the same way. The window is the one being written — start AND end move while
  // the form is open (the shift chips and drag handles change them), so both
  // instants key the memo, exactly as the certificate check keys on the end.
  const windowStartInstant = addMinutes(windowStart, range.startMin);
  const absenceByOperator = useMemo(() => {
    const m = new Map<string, AbsenceHit>();
    for (const o of operators) {
      const hit = absenceGaps(absences, o.id, { start: windowStartInstant, end: windowEnd });
      if (hit !== null) m.set(o.id, hit);
    }
    return m;
  }, [operators, absences, windowStartInstant.getTime(), windowEnd.getTime()]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedOutsideArea = outsideAreaOperatorIds.has(operatorId);
  const selectedGaps = gapsByOperator.get(operatorId) ?? [];
  const selectedAbsence = absenceByOperator.get(operatorId) ?? null;
  // Under `block` the person cannot be placed (no absence override exists);
  // under `warn` it is a warning only and Create is still offered.
  const absenceBlocked = selectedAbsence !== null && eligibilityPolicy === "block";
  const selectedUntrained = selectedGaps.filter((g) => g.state === "never-trained");
  const selectedLapsed = selectedGaps.filter(
    (g): g is Extract<CertificateGap, { state: "lapsed" }> => g.state === "lapsed",
  );
  const ineligible = selectedGaps.length > 0;
  const blocked = ineligible && eligibilityPolicy === "block";
  const needsOverride = ineligible && eligibilityPolicy === "warn";
  // Both modes need a product on offer here — `create_run` requires one, and a
  // direct Create needs SOME product selected even under `presetRun` (the run's
  // own product is on offer at this cell by construction) — so an empty offer
  // list disables Create in either mode rather than posting `""` for the server
  // to refuse. `presetRun` itself changes WHICH target `onSubmitDirect` is sent
  // (P1-7a), not this gate.
  const createDisabled =
    productId === "" ||
    (mode === "direct" &&
      (blocked ||
        // R-357: a person on leave cannot be placed under `block` — no override.
        absenceBlocked ||
        (needsOverride && (!overrideChecked || overrideReason.trim() === "")) ||
        // D113: the server refuses an override with no reason, so the button
        // must not offer to send one. Same shape as the line above it.
        (selectedOutsideArea && (!areaChecked || areaReason.trim() === ""))));

  // R-384: THE ONE PLACE that builds `onSubmitDirect`'s 12 arguments, so
  // the Create button's click and an R-384 auto-press below can never send
  // two different shapes. Extracted verbatim from what the button used to
  // build inline; nothing about the arguments themselves changed.
  function submitDirect() {
    const eff = Math.max(10, Math.min(150, Number(efficiencyPercent) || 100));
    // Shared with the edit popover so the two cannot drift again: no
    // quantity means no unit (never the literal "units").
    const target = normalizeTarget(targetQty, targetUnit);
    // P1-7a / R-383: joining an existing run sends its id; every other
    // Create sends the product select's own choice, exactly as before
    // this stage.
    const assignmentTarget: AssignmentTarget = presetRun
      ? { kind: "run", runId: presetRun.id }
      : { kind: "direct", productId };
    // D64: "never send an override the user did not tick" —
    // `needsOverride && overrideChecked` is the only path that sends
    // `eligibilityOverride: true`; every other case (fully eligible, or
    // blocked-and-disabled so unreachable) sends `false`/`undefined`.
    onSubmitDirect(
      nodeId,
      range,
      operatorId,
      assignmentTarget,
      eff,
      target.qty ?? undefined,
      target.unit ?? undefined,
      needsOverride && overrideChecked,
      needsOverride && overrideChecked ? overrideReason.trim() : undefined,
      // D113: sent only when it actually overrode something. The server
      // normalises the flag off anyway, so this is belt and braces — but
      // a client that always sent `true` would make every screen reading
      // the flag say "overridden" about rows nobody decided anything
      // about.
      selectedOutsideArea && areaChecked,
      selectedOutsideArea && areaChecked ? areaReason.trim() : undefined,
      anchor,
    );
  }

  // R-384: NOT a new copy of "is it clean" — the pop-up's OWN
  // already-computed verdicts above, read once. Direct mode (a preset
  // operator forces it), a part or job actually selected, trained, in
  // area, and not on leave under EITHER policy (a `warn` absence is a
  // warning box, so it is not clean; a `block` absence disables Create,
  // also not clean).
  const clean =
    mode === "direct" &&
    productId !== "" &&
    operatorId !== "" &&
    !ineligible &&
    !selectedOutsideArea &&
    selectedAbsence === null;

  const autoFiredRef = useRef(false);

  /**
   * R-384: Enter on a typed sentence creates the block without a second
   * press when this pop-up would show no warning. `autoCreate` is set only
   * by `openCreateFromCommand` (a drag or a keyboard create never sets it),
   * so this effect is a no-op for every other opener.
   *
   * F-128: the write is a side effect, so it runs in an EFFECT, never
   * inside a `setState` updater — that shape is exactly how one Continue
   * became two writes under StrictMode, which invokes an updater twice on
   * purpose to catch a side effect hidden there. `autoFiredRef` is a ref,
   * not state, so it survives StrictMode's simulated mount/unmount/remount
   * of this effect: the second run sees the ref already true and does
   * nothing, while a genuinely new mount of this component gets a fresh
   * ref and may fire once more.
   */
  useEffect(() => {
    if (autoCreate && clean && !autoFiredRef.current) {
      autoFiredRef.current = true;
      submitDirect();
    }
    // Mount-only, on purpose: `clean` is derived from the presets this
    // popover opened with, which do not change before first paint, and
    // `autoFiredRef` is what limits this effect to the one press it may
    // ever make (see the F-128 note above) — re-running it on every
    // dependency change would defeat that guard, not strengthen it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
                {c.name} {formatClock(addMinutes(windowStart, c.startMin), zone)}–
                {formatClock(addMinutes(windowStart, c.endMin), zone)}
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
              {offeredPeople.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.displayName}
                  {/* F-087: the list used to say "— not certified (override)"
                      for a missing training and NOTHING AT ALL for a lapsed
                      one. Two problems, two labels, so the difference is
                      visible before anybody is selected. */}
                  {operatorLabelSuffix(gapsByOperator.get(o.id) ?? [])}
                  {/* R-357: the leave mark travels in the list too, so it is
                      visible before anybody is picked — like the certificate
                      suffix beside it. */}
                  {absenceByOperator.has(o.id) ? " — on leave" : ""}
                  {outsideAreaOperatorIds.has(o.id) ? " — not from this area (override)" : ""}
                </option>
              ))}
            </select>
            {/* ⚠️ ABSENT WHEN THERE IS NOBODY BEHIND IT -- on a board whose place
                covers every home in the plant (a plant admin's) the whole plant
                is already on offer, and a control reading "(0)" would be a door
                onto an empty room. The skin is the app's shared field button
                (R-318), not a copy. */}
            {elsewhere.length > 0 && (
              <button
                type="button"
                className={`${fieldStyles.btn} ${styles.othersBtn}`}
                aria-expanded={showOthers}
                onClick={() => setShowOthers((v) => !v)}
              >
                {showOthers ? "Hide" : "Show"} other people in this plant ({elsewhere.length})
              </button>
            )}
            {presetRun ? (
              // P1-7a / R-383: the part is the run's -- nothing to choose.
              <p className={styles.time}>Joining {presetRun.label}</p>
            ) : products.length === 0 ? (
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
                  // R-331: "this org" was true when the policy was read once
                  // from the company's bag. It is now resolved for THIS cell —
                  // the plant it sits in may refuse while the plant next door
                  // allows an override — so the sentence names the place the
                  // rule was actually found for, which is here.
                  <p>Certification is required at this place, so there is no override.</p>
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

            {selectedAbsence !== null && (
              <div className={styles.eligWarn}>
                {/* R-357: named and dated through the app's date seam, the way
                    the expired-certificate line is (R-338). No override box:
                    the server takes no absence override, so under `warn` this
                    is a warning the planner reads and Create stays enabled;
                    under `block` there is nothing to tick and Create is off. */}
                <p>
                  <strong>{leaveLine(selectedAbsence, dateFormat, zone)}</strong>
                </p>
                {absenceBlocked ? (
                  <p>This person is on leave for this window, so there is no override.</p>
                ) : (
                  <p>Placing them anyway records the assignment over their leave.</p>
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
                submitDirect();
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
