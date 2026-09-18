/**
 * absenceOnBoard.test.tsx — the board's own surfacing of an absence (R-357), the
 * follow-up to lane D's server + admin work. Every case names the SQL twin in
 * `supabase/tests/88_absences_test.sql` it mirrors, because the whole point of
 * this lane is that the SCREEN offers exactly what the SERVER would take and
 * refuses exactly what it would refuse (CLAUDE.md §4): a person on leave is
 * named before Save the way an expired certificate is (R-338), and Save is
 * refused in place under `block`, allowed as a warning under `warn`.
 *
 * ⚠️ THE PREDICATE IS `absenceGaps` (src/lib/absence.ts), lane D's, already
 * pinned against the SQL by name (AB8, AB8b). These cases pin that the pop-ups
 * and the panel show a gap EXACTLY when it says so, on the same fixture days —
 * so a screen and a server drifting apart turns them red.
 *
 * ⭐ THE REFUSALS ARE BUILT FROM THE REAL RAW SHAPE. The `absent` cases feed the
 * real parser (`toSchedulerError`) a PostgREST error carrying the DETAIL json
 * migration 0066 raises, so a change to the writer's payload or the parser turns
 * these red instead of agreeing with a fiction.
 */
import { describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { BoardOperator, Skill, ShiftTemplate } from "@/lib/api";
import {
  describeSchedulerError,
  toSchedulerError,
  parseCreateAssignmentResult,
  parseMoveRunResult,
} from "@/lib/api";
import type { AbsenceRow, AbsenceHit } from "@/lib/absence";
import { CreatePopover } from "@/features/board/components/CreatePopover";
import { AssignmentPopover, describeRefusal } from "@/features/board/components/AssignmentPopover";
import { OperatorPanel } from "@/features/board/components/OperatorPanel";
import type { IndexedAssignment } from "@/features/board/lib/boardIndex";
import { leaveLine } from "@/features/board/lib/leave";
import { addMinutes, formatClock, formatFull } from "@/features/board/lib/time";

const NODE = "n-cell";

function operator(id: string, displayName: string): BoardOperator {
  return {
    id,
    homeNodeId: null,
    homeShiftId: null,
    displayName,
    employeeRef: null,
    active: true,
    siteNodeId: "n-plant",
    sitePath: "plant_a",
    skillIds: [],
    skillExpiries: [],
  };
}

const ELENA = operator("op-elena", "Elena");
const RAY = operator("op-ray", "Ray");

/** One absence, in the server's inclusive `YYYY-MM-DD` terms. */
const leave = (operatorId: string, from: string, to: string, reason = "sick"): AbsenceRow => ({
  operatorId,
  from,
  to,
  reason,
});

const PRODUCT = {
  id: "p1",
  sku: "WX",
  name: "Widget X",
  active: true,
  siteNodeIds: ["n-plant"],
  offeredNodeIds: [NODE],
  colorToken: "product-1",
} as never;

/* ===========================================================================
 * 1. The create pop-up: the line before Save, warn vs block (AB8, AB8b, AB9).
 * ======================================================================== */

type DirectSubmit = ComponentProps<typeof CreatePopover>["onSubmitDirect"];

function renderCreate(opts: {
  absences: AbsenceRow[];
  eligibilityPolicy?: "warn" | "block";
  // 06:00 of 1 Oct 2026 to `endMin` minutes past that day's midnight.
  endMin?: number;
  onSubmitDirect?: DirectSubmit;
}) {
  const onSubmitDirect = opts.onSubmitDirect ?? vi.fn<DirectSubmit>();
  render(
    <CreatePopover
      nodeId={NODE}
      anchor={{ x: 100, y: 100 }}
      initialRange={{ startMin: 360, endMin: opts.endMin ?? 840 }}
      shiftChips={[]}
      defaultCreateMode="direct"
      products={[PRODUCT]}
      operators={[ELENA]}
      hereOperatorIds={new Set([ELENA.id])}
      windowStart={new Date("2026-10-01T00:00:00Z")}
      requiredSkills={[]}
      outsideAreaOperatorIds={new Set<string>()}
      eligibilityPolicy={opts.eligibilityPolicy ?? "warn"}
      absences={opts.absences}
      presetOperatorId={ELENA.id}
      dateFormat="d_mon_yyyy"
      onCancel={vi.fn()}
      onSubmitRun={vi.fn()}
      onSubmitDirect={onSubmitDirect}
    />,
  );
  return onSubmitDirect;
}

function createButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Create" }) as HTMLButtonElement;
}
function body(): string {
  return document.body.textContent ?? "";
}

describe("create pop-up: the leave line before Save", () => {
  it("AB8/AB9-warn: an absence ending on the shift's start day is named, Create still offered", () => {
    // AB8: the absence ends 2026-10-01, the day the 06:00–14:00 shift STARTS.
    renderCreate({
      absences: [leave(ELENA.id, "2026-09-28", "2026-10-01")],
      eligibilityPolicy: "warn",
    });
    expect(body()).toMatch(/On leave/);
    expect(body()).toMatch(/1 Oct 2026/); // through the app's date seam
    expect(body()).toMatch(/sick/);
    // warn: a warning, not a wall — the server takes the placement.
    expect(createButton().disabled).toBe(false);
  });

  it("AB9-block: under block the same leave refuses Create in place, no override", () => {
    renderCreate({
      absences: [leave(ELENA.id, "2026-09-28", "2026-10-01")],
      eligibilityPolicy: "block",
    });
    expect(body()).toMatch(/On leave/);
    expect(body()).toMatch(/no override/);
    expect(createButton().disabled).toBe(true);
  });

  it("AB8b: a shift ending exactly at midnight does NOT clash with an absence starting next day", () => {
    // [1 Oct 06:00, 2 Oct 00:00) touches only 1 Oct; the absence starts 2 Oct.
    renderCreate({
      absences: [leave(ELENA.id, "2026-10-02", "2026-10-05")],
      eligibilityPolicy: "block",
      endMin: 1440,
    });
    expect(body()).not.toMatch(/On leave/);
    expect(createButton().disabled).toBe(false);
  });

  it("warn: Create actually submits over the leave (the placement the server would take)", () => {
    const onSubmitDirect = renderCreate({
      absences: [leave(ELENA.id, "2026-09-28", "2026-10-01")],
      eligibilityPolicy: "warn",
    });
    fireEvent.click(createButton());
    expect(onSubmitDirect).toHaveBeenCalledTimes(1);
  });

  it("no absence: the pre-R-357 pop-up, no leave line", () => {
    renderCreate({ absences: [], eligibilityPolicy: "block" });
    expect(body()).not.toMatch(/On leave/);
    expect(createButton().disabled).toBe(false);
  });
});

/* ===========================================================================
 * 2. The reassign pop-up: the same line for the chosen person (AB8, AB11).
 * ======================================================================== */

function assignment(): IndexedAssignment {
  return {
    id: "a1",
    orgId: "org-1",
    nodeId: NODE,
    operatorId: ELENA.id,
    operatorDisplayName: null,
    runId: null,
    productId: "pr-a",
    productSku: null,
    productName: null,
    productColorToken: null,
    timerange: "[2026-09-07 06:00+00,2026-09-07 14:00+00)",
    efficiency: 1,
    eligibilityOverride: false,
    overrideReason: null,
    areaOverride: false,
    areaOverrideReason: null,
    targetQty: null,
    targetUnit: null,
    createdBy: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    startMin: 360,
    endMin: 840,
    efficiencyPercent: 100,
    lane: 0,
    defaultTargetQty: null,
  };
}

function renderReassign(opts: { absences: AbsenceRow[]; eligibilityPolicy?: "warn" | "block" }) {
  render(
    <AssignmentPopover
      operators={[ELENA, RAY]}
      hereOperatorIds={new Set([ELENA.id, RAY.id])}
      assignment={assignment()}
      homeRun={null}
      operator={ELENA}
      outsideAreaOperatorIds={new Set<string>()}
      products={[{ id: "pr-a", orgId: "org-1", sku: "A", name: "Widget A" } as never]}
      anchor={{ x: 10, y: 10 }}
      windowStart={new Date("2026-09-07T00:00:00.000Z")}
      dateFormat="d_mon_yyyy"
      absences={opts.absences}
      eligibilityPolicy={opts.eligibilityPolicy ?? "warn"}
      onCancel={vi.fn()}
      onSave={vi.fn()}
      onReassign={vi
        .fn<ComponentProps<typeof AssignmentPopover>["onReassign"]>()
        .mockResolvedValue(undefined)}
      onDelete={vi.fn()}
    />,
  );
}

function pop(): HTMLElement {
  return screen.getByRole("dialog");
}
function personSelect(): HTMLSelectElement {
  return within(pop()).getByLabelText("Person") as HTMLSelectElement;
}
function saveButton(): HTMLButtonElement {
  return within(pop()).getByRole("button", { name: "Save" }) as HTMLButtonElement;
}

describe("reassign pop-up: the leave line for the chosen person", () => {
  it("AB11-warn: changing to an absent person names the leave, Save still offered", () => {
    // Ray is on leave over this row's 7 Sep window (AB8: absence ends on the start day).
    renderReassign({
      absences: [leave(RAY.id, "2026-09-04", "2026-09-07")],
      eligibilityPolicy: "warn",
    });
    // No line yet — the person on the row (Elena) is not being changed.
    expect(body()).not.toMatch(/On leave/);
    fireEvent.change(personSelect(), { target: { value: RAY.id } });
    expect(body()).toMatch(/On leave/);
    expect(body()).toMatch(/7 Sep 2026/);
    expect(saveButton().disabled).toBe(false);
  });

  it("AB11-block: under block changing to an absent person refuses Save in place", () => {
    renderReassign({
      absences: [leave(RAY.id, "2026-09-04", "2026-09-07")],
      eligibilityPolicy: "block",
    });
    fireEvent.change(personSelect(), { target: { value: RAY.id } });
    expect(body()).toMatch(/no override/);
    expect(saveButton().disabled).toBe(true);
  });

  it("an already-placed person's leave does not wall a plain field edit", () => {
    // Elena (on the row) is on leave, but she is not being changed — the server
    // does not re-check a field-only edit, so the screen must not block it.
    renderReassign({
      absences: [leave(ELENA.id, "2026-09-04", "2026-09-07")],
      eligibilityPolicy: "block",
    });
    expect(body()).not.toMatch(/On leave/);
    expect(saveButton().disabled).toBe(false);
  });
});

/* ===========================================================================
 * 3. The operator panel mark.
 * ======================================================================== */

function renderPanel(
  absences: AbsenceRow[],
  opts: {
    skillById?: Map<string, Skill>;
    assignmentsByOperator?: Map<string, IndexedAssignment[]>;
    nodeById?: Map<string, unknown>;
    capacityCap?: number;
    operators?: BoardOperator[];
    windowStart?: Date;
    zone?: string;
    /** S65-a (R-438): the board root's shift pattern, threaded straight to
     *  `OperatorPanel`'s own `rootTemplate` prop. Omitted (the default,
     *  `null`) is the common case here -- `bookingWords`' own fallback, the
     *  window itself, which is what every R-038 case below was written
     *  against before R-438 gave the panel a real pattern to read. */
    rootTemplate?: ShiftTemplate | null;
  } = {},
) {
  const ops = opts.operators ?? [ELENA, RAY];
  const dragApi = {
    beginPanelDrag: vi.fn(),
    updatePanelDrag: vi.fn(),
    endPanelDrag: vi.fn(),
    cancelDrag: vi.fn(),
  };
  // DEF-0028: the F-125 memo cases need a SECOND render with one memo input
  // changed and the rest held by reference, so the element is built by a
  // function of the two inputs that vary and the helper hands back `rerender`.
  // Every collection is built ONCE here, not inside `element`: a fresh Map
  // per render would invalidate the memo on its own and the rerender cases
  // would stay green with the key wrong (the first draft of this did exactly
  // that, and the tester's mutation passed against it).
  const DEFAULT_WINDOW_START = new Date("2026-09-07T00:00:00.000Z");
  const hereOperatorIds = new Set(ops.map((o) => o.id));
  const skillById = opts.skillById ?? new Map<string, Skill>();
  const nodeById = (opts.nodeById as never) ?? new Map();
  const assignmentsByOperator = opts.assignmentsByOperator ?? new Map();
  const element = (windowStart: Date, zone: string | undefined) => (
    <OperatorPanel
      operators={ops}
      hereOperatorIds={hereOperatorIds}
      absences={absences}
      skillById={skillById}
      nodeById={nodeById}
      assignmentsByOperator={assignmentsByOperator}
      windowStart={windowStart}
      windowMinutes={1440}
      zone={zone}
      capacityCap={opts.capacityCap ?? 1}
      rootTemplate={opts.rootTemplate ?? null}
      open={true}
      onToggleOpen={vi.fn()}
      draggingOperatorId={null}
      dragApi={dragApi}
    />
  );
  const { rerender } = render(element(opts.windowStart ?? DEFAULT_WINDOW_START, opts.zone));
  return {
    rerender: (next: { windowStart?: Date; zone?: string }) =>
      rerender(
        element(
          next.windowStart ?? opts.windowStart ?? DEFAULT_WINDOW_START,
          "zone" in next ? next.zone : opts.zone,
        ),
      ),
  };
}

/** A minimal IndexedAssignment carrying only the fields OperatorPanel's
 *  chip() actually reads: nodeId/startMin/endMin/efficiencyPercent (the
 *  tooltip), and startMin/endMin again for `bookingWords` (R-438). `efficiency`
 *  is kept on the fixture even though nothing in the CURRENT chip sums it --
 *  `isFullyAllocated` (`geometry.ts`) read it before S65-a retired the count
 *  pill/dimmed "full" look that consumed it here; `boardGeometry.test.ts`
 *  still pins `isFullyAllocated` itself directly. */
function assignmentFor(nodeId: string, startMin: number, endMin: number, efficiencyPercent = 100) {
  return {
    nodeId,
    startMin,
    endMin,
    efficiencyPercent,
    efficiency: efficiencyPercent / 100,
  } as unknown as IndexedAssignment;
}

describe("operator panel: the on-leave mark", () => {
  it("marks a person on leave over the shown window, and only them", () => {
    // Ray is away 7 Sep; Elena is not.
    renderPanel([leave(RAY.id, "2026-09-07", "2026-09-09")]);
    const rayChip = screen.getByText("Ray").closest("div") as HTMLElement;
    const elenaChip = screen.getByText("Elena").closest("div") as HTMLElement;
    expect(within(rayChip).queryByText("on leave")).not.toBeNull();
    expect(within(elenaChip).queryByText("on leave")).toBeNull();
  });

  it("does not mark anyone when nobody is away", () => {
    renderPanel([]);
    expect(screen.queryByText("on leave")).toBeNull();
  });
});

describe("operator panel (R-038, SUPERSEDED BY R-438 -- see the note below): avatar, name, skill badges, booking words", () => {
  /*
   * ⚠️ S65-a, R-438 SUPERSEDES R-038 WHEN IT SHIPS (`docs/plan.yaml`'s own
   * note on R-438 said so in advance). R-038's claim was "avatar, name, skill
   * badges and a count pill ... dimmed when full"; the maintainer replaced
   * the pill and the dimming with `railWords.ts`'s booking words (17 Sept,
   * "the bar is not very useful, we don't know what a full bar would mean").
   * R-038a and R-038c (the avatar/name/skill-badge presence and the tooltip)
   * are UNCHANGED by that -- nothing about them was the pill or the dimming,
   * so they stay as they were. R-038b (the count pill) and R-038d (the
   * dimmed "full" chip) are REWRITTEN below to pin the new contract in their
   * place: the pill and the dimming are gone, replaced by the words. This is
   * a CONTRACT CHANGE, not a case that was wrong (CLAUDE.md §4's "a green
   * case can be pinning the bug" -- these two were pinning exactly what they
   * were written to pin; the maintainer changed what the chip shows).
   */
  it("R-038a: each chip shows an avatar (initials), the name, and one badge per skill", () => {
    const welding: Skill = { id: "sk-1", name: "Welding" } as never;
    const skilled: BoardOperator = { ...operator("op-nia", "Nia"), skillIds: ["sk-1"] };
    renderPanel([], { operators: [skilled], skillById: new Map([["sk-1", welding]]) });
    const chip = screen.getByText("Nia").closest("div") as HTMLElement;
    // initials("Nia") -> "Nia".slice(0, 2).toUpperCase() -> "NI"
    expect(within(chip).getByText("NI")).not.toBeNull();
    expect(within(chip).getByText("Nia")).not.toBeNull();
    expect(within(chip).getByText("Welding")).not.toBeNull();
  });

  it("R-038b (REWRITTEN, R-438): the count pill is gone -- the booking words say how booked the person is instead", () => {
    // Same fixture R-038b always used (Elena: two blocks inside the day,
    // 00:00-08:00 and 10:00-15:00; Ray: none). With no root template, the
    // band `bookingWords` measures against is `bookingWords`' own fallback,
    // the window itself (R-438 DECIDED) -- Elena's first uncovered minute is
    // 08:00 (the end of her first block; her second starts at 10:00, so it
    // does not touch minute 480), and Ray has no blocks in the window at all.
    const assignments = new Map<string, IndexedAssignment[]>([
      [ELENA.id, [assignmentFor(NODE, 0, 480), assignmentFor(NODE, 600, 900)]],
    ]);
    renderPanel([], { assignmentsByOperator: assignments });
    const elenaChip = screen.getByText("Elena").closest("div") as HTMLElement;
    expect(within(elenaChip).queryByText("2")).toBeNull(); // the count pill is gone
    expect(within(elenaChip).getByText("free 08:00")).not.toBeNull();
    const rayChip = screen.getByText("Ray").closest("div") as HTMLElement;
    expect(within(rayChip).queryByText("0")).toBeNull(); // never a "0" pill, before or after
    expect(within(rayChip).getByText("free")).not.toBeNull(); // bare -- no blocks in the window at all
  });

  it("R-438: a root shift pattern narrows the band -- 'free'/'booked' follow the shift, not the whole loaded window", () => {
    // A single-band pattern, 06:00-14:00 (`rootBand` reads a template's
    // FIRST shift) -- Elena's one assignment covers the WHOLE band exactly,
    // so she reads "booked" even though the same block leaves most of the
    // 1440-minute window itself uncovered (the R-038b case above, with no
    // pattern, would have called this "free 14:00").
    const pattern: ShiftTemplate = {
      id: "t1",
      name: "Day",
      shifts: [{ id: "s1", name: "Day", startMin: 360, endMin: 840, breaks: [] }],
    };
    const assignments = new Map<string, IndexedAssignment[]>([
      [ELENA.id, [assignmentFor(NODE, 360, 840)]],
    ]);
    renderPanel([], { assignmentsByOperator: assignments, rootTemplate: pattern });
    const elenaChip = screen.getByText("Elena").closest("div") as HTMLElement;
    expect(within(elenaChip).getByText("booked")).not.toBeNull();
  });

  it("R-038c: the chip's title attribute lists the operator's assignments in the window (node, times, efficiency)", () => {
    const assignments = new Map<string, IndexedAssignment[]>([
      [ELENA.id, [assignmentFor(NODE, 360, 480, 50)]], // 06:00-08:00, 50%
    ]);
    renderPanel([], { assignmentsByOperator: assignments });
    const elenaChip = screen.getByText("Elena").closest("div") as HTMLElement;
    expect(elenaChip.title).toMatch(NODE);
    expect(elenaChip.title).toMatch("50%");
  });

  it("R-038c (F-125): the title reads exactly `<node> · <start>–<end> · <eff>%`, off the same helpers the memo calls", () => {
    // OperatorPanel used to build this string inline in chip() on every
    // render; it is now a useMemo keyed on
    // [assignmentsByOperator, nodeById, windowStart.getTime(), zone]. This
    // pins the exact rendered string, unchanged. The memo's KEY is pinned by
    // the two rerender cases below (DEF-0028), not by this one.
    const windowStart = new Date("2026-09-07T00:00:00.000Z"); // matches renderPanel's fixture
    const assignments = new Map<string, IndexedAssignment[]>([
      [ELENA.id, [assignmentFor(NODE, 360, 480, 50)]], // 06:00-08:00, 50%
    ]);
    renderPanel([], { assignmentsByOperator: assignments });
    const elenaChip = screen.getByText("Elena").closest("div") as HTMLElement;
    const expected = `${NODE} · ${formatFull(addMinutes(windowStart, 360), undefined, undefined)}–${formatClock(addMinutes(windowStart, 480), undefined)} · 50%`;
    expect(elenaChip.title).toBe(expected);
  });

  /*
   * DEF-0028: a memo that ignores a dependency only shows on a SECOND render
   * with that dependency changed and every other input held by reference.
   * The tester dropped `windowStart.getTime()` and `zone` from the tooltip
   * memo's key and every case touching the component stayed green, because
   * none rendered it twice. These two do: the same `assignmentsByOperator`
   * and `nodeById` Map instances across the rerender, one of the other two
   * keys changed, and the title must follow it.
   */
  it("R-038c (DEF-0028): a rerender with the same assignments but a later windowStart rebuilds the title -- the memo is keyed on the window", () => {
    const assignments = new Map<string, IndexedAssignment[]>([
      [ELENA.id, [assignmentFor(NODE, 360, 480, 50)]],
    ]);
    const day1 = new Date("2026-09-07T00:00:00.000Z");
    const day2 = new Date("2026-09-08T00:00:00.000Z");
    const { rerender } = renderPanel([], { assignmentsByOperator: assignments, windowStart: day1 });
    const chip = () => screen.getByText("Elena").closest("div") as HTMLElement;
    const titleFor = (d: Date) =>
      `${NODE} · ${formatFull(addMinutes(d, 360), undefined, undefined)}–${formatClock(addMinutes(d, 480), undefined)} · 50%`;
    expect(chip().title).toBe(titleFor(day1));
    rerender({ windowStart: day2 });
    expect(chip().title).toBe(titleFor(day2));
    expect(chip().title).not.toBe(titleFor(day1));
  });

  it("R-038c (DEF-0028): a rerender with the same assignments but a different zone rebuilds the title -- the memo is keyed on the zone", () => {
    const assignments = new Map<string, IndexedAssignment[]>([
      [ELENA.id, [assignmentFor(NODE, 360, 480, 50)]],
    ]);
    const windowStart = new Date("2026-09-07T00:00:00.000Z");
    const { rerender } = renderPanel([], {
      assignmentsByOperator: assignments,
      windowStart,
      zone: "UTC",
    });
    const chip = () => screen.getByText("Elena").closest("div") as HTMLElement;
    const titleIn = (zone: string) =>
      `${NODE} · ${formatFull(addMinutes(windowStart, 360), undefined, zone)}–${formatClock(addMinutes(windowStart, 480), zone)} · 50%`;
    expect(chip().title).toBe(titleIn("UTC"));
    rerender({ zone: "America/Chicago" });
    expect(chip().title).toBe(titleIn("America/Chicago"));
    // The two zones read the same instants differently, or this case proves nothing.
    expect(titleIn("America/Chicago")).not.toBe(titleIn("UTC"));
  });

  it("R-038d (REWRITTEN, R-438): the dimmed 'full' chip is gone -- a fully-covered person reads 'booked' in plain text, with no dimming at all", () => {
    // Same fixture R-038d always used: one assignment covering the whole
    // window (windowMinutes=1440) at 100% efficiency -- with no root
    // template, `bookingWords`' fallback band IS that window, so this is
    // covered end to end.
    const full = new Map<string, IndexedAssignment[]>([
      [ELENA.id, [assignmentFor(NODE, 0, 1440, 100)]],
    ]);
    renderPanel([], { assignmentsByOperator: full });
    const elenaChip = screen.getByText("Elena").closest("div") as HTMLElement;
    const rayChip = screen.getByText("Ray").closest("div") as HTMLElement;
    // No chip is ever dimmed any more -- the class itself is gone from
    // `OperatorPanel.module.css`, not merely unapplied here.
    expect(elenaChip.className).not.toMatch(/full/);
    expect(rayChip.className).not.toMatch(/full/);
    expect(within(elenaChip).getByText("booked")).not.toBeNull();
    expect(within(rayChip).getByText("free")).not.toBeNull(); // no blocks at all
  });
});

/* ===========================================================================
 * 4. The describer sentence and the warn-path payload parse (AB9, AB10, AB11).
 * ======================================================================== */

/** A refusal exactly as it arrives: a PostgREST error whose `details` is the
 *  DETAIL json `api_raise` encodes. */
function refusal(detail: Record<string, unknown>, code = "PT409") {
  return toSchedulerError({
    message: "refused",
    details: JSON.stringify(detail),
    code,
    hint: "",
    name: "PostgrestError",
  } as never);
}

describe("errors.ts: the `absent` describer", () => {
  it("AB9/AB11: names the person and the leave for a single-person refusal", () => {
    // The shape create_assignment / reassign_assignment raise under block.
    const err = refusal({
      error: "absent",
      operator_id: ELENA.id,
      node_id: NODE,
      absence: { absent: true, from: "2026-09-28", to: "2026-10-01", reason: "sick" },
      policy: "block",
    });
    expect(err.kind).toBe("Absent");
    const sentence = describeSchedulerError(err);
    expect(sentence).toMatch(/on leave/);
    expect(sentence).toMatch(/2026-09-28 – 2026-10-01/);
    expect(sentence).toMatch(/sick/);
    // The pop-up names the person rather than the id.
    expect(describeRefusal(err, "Elena")).toMatch(/^Elena is on leave/);
  });

  it("AB10: names the whole absent crew for a move_run refusal", () => {
    // The shape move_run raises under block: every absent crew member listed.
    const err = refusal({
      error: "absent",
      node_id: NODE,
      operators: [
        {
          operator_id: ELENA.id,
          absence: { absent: true, from: "2026-09-28", to: "2026-10-01", reason: "sick" },
        },
        {
          operator_id: RAY.id,
          absence: { absent: true, from: "2026-09-30", to: "2026-10-02", reason: "training" },
        },
      ],
      policy: "block",
    });
    expect(err.kind).toBe("Absent");
    expect(describeSchedulerError(err)).toMatch(/2 crew members are on leave/);
  });

  it("a malformed absent payload falls through to Unknown, never a raw key", () => {
    // No node_id: not this refusal.
    const err = refusal({ error: "absent", operator_id: ELENA.id, policy: "block" });
    expect(err.kind).toBe("Unknown");
  });

  /*
   * R-359, the third surface in this family. `absence_overlap` has emitted
   * `starts_at`/`ends_at` since migration 0069, additively, exactly when the
   * matched row is PART-DAY. `AbsentOperator` did not lift them, so a placement
   * refused against a 09:00-13:00 absence was refused CORRECTLY -- the server
   * decides by the hours -- and then explained as "10 Jun - 10 Jun", which reads
   * as the whole day being gone when the afternoon is free.
   */
  describe("a part-day refusal says WHICH hours (R-359)", () => {
    const partDay = {
      error: "absent",
      operator_id: ELENA.id,
      node_id: NODE,
      absence: {
        absent: true,
        from: "2026-06-10",
        to: "2026-06-10",
        reason: "appointment",
        starts_at: "2026-06-10T09:00:00.000Z",
        ends_at: "2026-06-10T13:00:00.000Z",
      },
      policy: "block",
    };

    it("lifts the server's own starts_at/ends_at onto the refusal", () => {
      const err = refusal(partDay);
      expect(err.kind).toBe("Absent");
      if (err.kind !== "Absent") throw new Error("unreachable");
      expect(err.operators[0].startsAt).toBe("2026-06-10T09:00:00.000Z");
      expect(err.operators[0].endsAt).toBe("2026-06-10T13:00:00.000Z");
    });

    it("names the hours, not just the day", () => {
      const err = refusal(partDay);
      const sentence = describeRefusal(err, "Elena", "d_mon_yyyy", "UTC");
      expect(sentence).toContain("09:00");
      expect(sentence).toContain("13:00");
      expect(sentence).toContain("Elena");
      // The old sentence, and the thing a reader mis-concluded from.
      expect(sentence).not.toMatch(/2026-06-10 – 2026-06-10/);
    });

    it("phrases it through leaveLine, so it cannot drift from the pop-up's own line", () => {
      const err = refusal(partDay);
      const hit: AbsenceHit = {
        from: "2026-06-10",
        to: "2026-06-10",
        reason: "appointment",
        startsAt: "2026-06-10T09:00:00.000Z",
        endsAt: "2026-06-10T13:00:00.000Z",
      };
      const line = leaveLine(hit, "d_mon_yyyy", "UTC");
      // Same words, only the subject and the full stop differ.
      expect(describeRefusal(err, "Elena", "d_mon_yyyy", "UTC")).toBe(
        `Elena is ${line.charAt(0).toLowerCase()}${line.slice(1)}.`,
      );
    });

    it("reads the hours in the zone it is given, not in UTC by accident", () => {
      const err = refusal(partDay);
      const utc = describeRefusal(err, "Elena", "d_mon_yyyy", "UTC");
      const chicago = describeRefusal(err, "Elena", "d_mon_yyyy", "America/Chicago");
      expect(utc).not.toBe(chicago);
      expect(chicago).toContain("04:00");
    });

    it("a WHOLE-DAY refusal is unchanged -- no hours invented", () => {
      const err = refusal({
        error: "absent",
        operator_id: ELENA.id,
        node_id: NODE,
        absence: { absent: true, from: "2026-09-28", to: "2026-10-01", reason: "sick" },
        policy: "block",
      });
      if (err.kind !== "Absent") throw new Error("unreachable");
      expect(err.operators[0].startsAt).toBeUndefined();
      const sentence = describeRefusal(err, "Elena", "d_mon_yyyy", "UTC");
      expect(sentence).not.toMatch(/\d\d:\d\d/);
      expect(sentence).toMatch(/^Elena is on leave/);
      expect(sentence).toContain("sick");
    });

    it("half a pair is not half a sentence -- it degrades to the whole-day form", () => {
      // The server emits both or neither; a malformed answer must not print a
      // range with one end missing.
      const err = refusal({
        error: "absent",
        operator_id: ELENA.id,
        node_id: NODE,
        absence: {
          absent: true,
          from: "2026-06-10",
          to: "2026-06-10",
          reason: "appointment",
          starts_at: "2026-06-10T09:00:00.000Z",
        },
        policy: "block",
      });
      if (err.kind !== "Absent") throw new Error("unreachable");
      expect(err.operators[0].startsAt).toBeUndefined();
      expect(err.operators[0].endsAt).toBeUndefined();
      const sentence = describeRefusal(err, "Elena", "d_mon_yyyy", "UTC");
      expect(sentence).not.toMatch(/\d\d:\d\d/);
      expect(sentence).toContain("10 Jun 2026");
    });
  });
});

describe("shapes.ts: the warn-path payload keys are parsed, never raw", () => {
  const assignmentRow = {
    id: "90000000-0000-0000-0000-000000000001",
    org_id: "org-1",
    node_id: NODE,
    operator_id: ELENA.id,
    operator_display_name: null,
    run_id: null,
    product_id: "pr-a",
    product_sku: null,
    product_name: null,
    product_color_token: null,
    timerange: "[2026-09-07 06:00+00,2026-09-07 14:00+00)",
    efficiency: 1,
    eligibility_override: false,
    override_reason: null,
    area_override: false,
    area_override_reason: null,
    target_qty: null,
    target_unit: null,
    created_by: null,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
  };

  it("AB9-warn: create_assignment's `absence` key rides back on the result", () => {
    const parsed = parseCreateAssignmentResult({
      assignment: assignmentRow,
      eligibility: { eligible: true, policy: "warn", missing_skills: [], expiring_skills: [] },
      absence: { absent: true, from: "2026-09-28", to: "2026-10-01", reason: "sick" },
    } as never);
    expect(parsed?.absence.absent).toBe(true);
    expect(parsed?.absence.from).toBe("2026-09-28");
    expect(parsed?.absence.reason).toBe("sick");
  });

  it("an older payload with no `absence` key defaults to not-absent, not a mismatch", () => {
    const parsed = parseCreateAssignmentResult({
      assignment: assignmentRow,
      eligibility: { eligible: true, policy: "warn", missing_skills: [], expiring_skills: [] },
    } as never);
    expect(parsed).not.toBeNull();
    expect(parsed?.absence.absent).toBe(false);
  });

  it("AB10-warn: move_run's `absence_warnings` are parsed to camelCase", () => {
    const parsed = parseMoveRunResult({
      run: {
        id: "r1",
        org_id: "org-1",
        node_id: NODE,
        product_id: "pr-a",
        product_sku: null,
        product_name: null,
        product_color_token: null,
        timerange: "[2026-09-07 06:00+00,2026-09-07 14:00+00)",
        planned_headcount: 1,
        notes: null,
        status: "planned",
        created_by: null,
        created_at: "2026-09-01T00:00:00.000Z",
        updated_at: "2026-09-01T00:00:00.000Z",
      },
      assignments: [assignmentRow],
      eligibility_warnings: [],
      absence_warnings: [
        {
          operator_id: ELENA.id,
          absence: { absent: true, from: "2026-09-28", to: "2026-10-01", reason: "sick" },
        },
      ],
    } as never);
    expect(parsed?.absenceWarnings).toHaveLength(1);
    expect(parsed?.absenceWarnings[0]?.operatorId).toBe(ELENA.id);
    expect(parsed?.absenceWarnings[0]?.absence.reason).toBe("sick");
  });

  it("a move payload with no `absence_warnings` key parses to an empty list", () => {
    const parsed = parseMoveRunResult({
      run: {
        id: "r1",
        org_id: "org-1",
        node_id: NODE,
        product_id: "pr-a",
        product_sku: null,
        product_name: null,
        product_color_token: null,
        timerange: "[2026-09-07 06:00+00,2026-09-07 14:00+00)",
        planned_headcount: 1,
        notes: null,
        status: "planned",
        created_by: null,
        created_at: "2026-09-01T00:00:00.000Z",
        updated_at: "2026-09-01T00:00:00.000Z",
      },
      assignments: [assignmentRow],
      eligibility_warnings: [],
    } as never);
    expect(parsed?.absenceWarnings).toEqual([]);
  });

  /**
   * R-359 / migration 0069 — THE HOLE THIS LANE CLOSES. `absence_overlap` grew
   * two additive keys on a part-day hit (`starts_at`/`ends_at`), forwarded whole
   * by both `create_assignment` (under `absence`) and `move_run` (inside each
   * `absence_warnings` entry). `parseAbsenceInfo` read only `absent`/`from`/
   * `to`/`reason` and dropped them, so a part-day absence surfaced through
   * either path rendered as a whole-day one and the hours vanished silently —
   * proved here end to end: parse the raw payload, then feed the parsed shape
   * straight into `leaveLine`, the same seam the pop-ups and the drag toast
   * read leave through.
   */
  it("R-359: create_assignment's part-day `absence` reaches leaveLine's sentence with its hours", () => {
    const parsed = parseCreateAssignmentResult({
      assignment: assignmentRow,
      eligibility: { eligible: true, policy: "warn", missing_skills: [], expiring_skills: [] },
      absence: {
        absent: true,
        from: "2026-09-28",
        to: "2026-09-28",
        reason: "sick",
        starts_at: "2026-09-28T09:00:00.000Z",
        ends_at: "2026-09-28T13:00:00.000Z",
      },
    } as never);
    const a = parsed?.absence;
    expect(a?.startsAt).toBe("2026-09-28T09:00:00.000Z");
    expect(a?.endsAt).toBe("2026-09-28T13:00:00.000Z");
    const sentence = leaveLine(
      {
        from: a!.from!,
        to: a!.to!,
        reason: a!.reason ?? "",
        startsAt: a?.startsAt,
        endsAt: a?.endsAt,
      },
      "d_mon_yyyy",
    );
    expect(sentence).toBe("On leave 28 Sep 2026, 09:00–13:00: sick");
  });

  it("R-359: move_run's part-day absence_warnings entry reaches leaveLine's sentence with its hours, in a given zone", () => {
    const parsed = parseMoveRunResult({
      run: {
        id: "r1",
        org_id: "org-1",
        node_id: NODE,
        product_id: "pr-a",
        product_sku: null,
        product_name: null,
        product_color_token: null,
        timerange: "[2026-09-07 06:00+00,2026-09-07 14:00+00)",
        planned_headcount: 1,
        notes: null,
        status: "planned",
        created_by: null,
        created_at: "2026-09-01T00:00:00.000Z",
        updated_at: "2026-09-01T00:00:00.000Z",
      },
      assignments: [assignmentRow],
      eligibility_warnings: [],
      absence_warnings: [
        {
          operator_id: ELENA.id,
          absence: {
            absent: true,
            from: "2026-09-28",
            to: "2026-09-28",
            reason: "sick",
            starts_at: "2026-09-28T09:00:00.000Z",
            ends_at: "2026-09-28T13:00:00.000Z",
          },
        },
      ],
    } as never);
    const a = parsed?.absenceWarnings[0]?.absence;
    expect(a?.startsAt).toBe("2026-09-28T09:00:00.000Z");
    expect(a?.endsAt).toBe("2026-09-28T13:00:00.000Z");
    // America/Chicago is UTC-5 in September (CDT): 09:00Z/13:00Z -> 04:00/08:00.
    const sentence = leaveLine(
      {
        from: a!.from!,
        to: a!.to!,
        reason: a!.reason ?? "",
        startsAt: a?.startsAt,
        endsAt: a?.endsAt,
      },
      "d_mon_yyyy",
      "America/Chicago",
    );
    expect(sentence).toBe("On leave 28 Sep 2026, 04:00–08:00: sick");
  });
});

/* ===========================================================================
 * 5. R-359 / 0069 — `leaveLine` reads a part-day hit's hours in the given
 *    zone; a whole-day hit's sentence is untouched (both sides of Part B).
 * ======================================================================== */

describe("leaveLine: R-359, a part-day hit reads as the day plus the hours", () => {
  const partDayHit: AbsenceHit = {
    from: "2026-09-14",
    to: "2026-09-14",
    reason: "sick",
    startsAt: "2026-09-14T09:00:00.000Z",
    endsAt: "2026-09-14T13:00:00.000Z",
  };

  it("reads the hours in the given zone, in the plant's date format", () => {
    expect(leaveLine(partDayHit, "d_mon_yyyy", "UTC")).toBe(
      "On leave 14 Sep 2026, 09:00–13:00: sick",
    );
  });

  it("the same instants read differently in a different zone", () => {
    // America/Chicago is UTC-5 in September (CDT): 09:00Z/13:00Z -> 04:00/08:00.
    expect(leaveLine(partDayHit, "d_mon_yyyy", "America/Chicago")).toBe(
      "On leave 14 Sep 2026, 04:00–08:00: sick",
    );
  });

  it("`zone` defaults to UTC, so every existing board caller (two positional args) keeps compiling and reads UTC", () => {
    expect(leaveLine(partDayHit, "d_mon_yyyy")).toBe("On leave 14 Sep 2026, 09:00–13:00: sick");
  });

  it("a whole-day hit's sentence does not change, whatever zone is passed", () => {
    const wholeDayHit: AbsenceHit = { from: "2026-09-14", to: "2026-09-18", reason: "sick" };
    expect(leaveLine(wholeDayHit, "d_mon_yyyy", "America/Chicago")).toBe(
      "On leave 14 Sep 2026 – 18 Sep 2026: sick",
    );
  });
});
