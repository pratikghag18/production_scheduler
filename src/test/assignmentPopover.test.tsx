/**
 * Changing who is on an assignment, at the level a person reads it (R-343 / S37).
 *
 * The maintainer's words, verbatim: "once you assign someone say Operator 1,
 * there is no way to modify that assignment to operator 2 unless you delete
 * existing assignment, this is not practical." Every case below is one clause
 * of what replaces that: the pop-up SHOWS who is on the row; picking somebody
 * else and saving sends exactly that change and nothing else; a person from
 * another area is marked and asked about before Save is offered; and the
 * server's `not_eligible` answer becomes the override tick under `warn` and a
 * flat refusal under `block` -- never a dead end with a message about a box the
 * screen does not have (F-087's shape, which this pop-up could reproduce
 * exactly if it toasted the refusal and closed).
 *
 * ⚠️ THE MOCK STOPS AT THE COMPONENT'S OWN BOUNDARY. `onReassign` and `onSave`
 * are the props `BoardPage` fills from `useDragGesture`; `@/lib/api` is the real
 * module, so `toSchedulerError`, `describeSchedulerError` and the error union
 * run for real, and the shared `Popover` shell renders for real. Asserted on
 * what a person can perceive -- the select's value, the option text, the
 * disabled state, the sentences -- never on a CSS class.
 *
 * ⭐ AND EVERY REFUSAL IS BUILT FROM THE REAL RAW SHAPE. The cases feed
 * `onReassign` a rejection made by `toSchedulerError` from a PostgREST-shaped
 * error with the DETAIL json migration 0057 actually raises, rather than a
 * hand-built `SchedulerError` literal -- so a change to the parser or to the
 * writer's payload turns these red instead of leaving them agreeing with a
 * fiction.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { BoardOperator, SchedulerError } from "@/lib/api";
import { describeSchedulerError, toSchedulerError } from "@/lib/api";
import { AssignmentPopover, describeRefusal } from "@/features/board/components/AssignmentPopover";
import type { IndexedAssignment } from "@/features/board/lib/boardIndex";

const WINDOW_START = new Date("2026-09-07T00:00:00.000Z");
const NODE = "n-cell-1";

function operator(
  over: Partial<BoardOperator> & { id: string; displayName: string },
): BoardOperator {
  return {
    homeNodeId: null,
    employeeRef: null,
    active: true,
    siteNodeId: "n-plant",
    // S39/0058: the home as a PATH. The component never reads it -- `BoardPage`
    // resolves both sets and hands them down -- but the shape requires it, and
    // the values here say which set each person belongs in.
    sitePath: "plant_a",
    skillIds: [],
    skillExpiries: [],
    ...over,
  };
}

const ANA = operator({ id: "op-ana", displayName: "Ana" });
const BEN = operator({ id: "op-ben", displayName: "Ben" });
/**
 * Homed in another AREA of this plant. R-346: behind the "show other people in
 * this plant" control, and once revealed, marked and asked for a reason.
 */
const CARA = operator({
  id: "op-cara",
  displayName: "Cara",
  siteNodeId: "n-line-9",
  sitePath: "plant_a.area_9",
});
/** Left the company: in the window's list, and not on offer. */
const DEV = operator({ id: "op-dev", displayName: "Dev", active: false });

function assignment(over: Partial<IndexedAssignment> = {}): IndexedAssignment {
  return {
    id: "a1",
    orgId: "org-1",
    nodeId: NODE,
    operatorId: ANA.id,
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
    ...over,
  };
}

/**
 * A refusal exactly as it arrives: a PostgREST error whose `details` is the
 * JSON `api_raise` encodes (docs/api.md §1), through the real parser.
 */
function refusal(detail: Record<string, unknown>, code = "PT409") {
  return toSchedulerError({
    message: "refused",
    details: JSON.stringify(detail),
    code,
    hint: "",
    name: "PostgrestError",
  } as never);
}

const NOT_ELIGIBLE_WARN = refusal({
  error: "not_eligible",
  operator_id: BEN.id,
  node_id: NODE,
  missing_skills: [{ id: "sk-weld", name: "Welding" }],
  expiring_skills: [],
  policy: "warn",
});

const NOT_ELIGIBLE_BLOCK = refusal({
  error: "not_eligible",
  operator_id: BEN.id,
  node_id: NODE,
  missing_skills: [{ id: "sk-weld", name: "Welding" }],
  expiring_skills: [],
  policy: "block",
});

const NOT_PERMITTED = refusal({ error: "not_permitted", node_id: NODE }, "PT403");

function renderPopover(over: Partial<React.ComponentProps<typeof AssignmentPopover>> = {}) {
  const onSave = vi.fn();
  const onReassign = vi.fn<React.ComponentProps<typeof AssignmentPopover>["onReassign"]>();
  const onDelete = vi.fn();
  const onCancel = vi.fn();
  onReassign.mockResolvedValue(undefined);
  render(
    <AssignmentPopover
      operators={[ANA, BEN, CARA, DEV]}
      // R-346: Ana and Ben are homed at or above this cell; Cara is not, so she
      // is the one behind the control. Dev is inactive and is in neither set.
      hereOperatorIds={new Set([ANA.id, BEN.id])}
      assignment={assignment()}
      homeRun={null}
      operator={ANA}
      outsideAreaOperatorIds={new Set([CARA.id])}
      products={[{ id: "pr-a", orgId: "org-1", sku: "A", name: "Widget A" } as never]}
      anchor={{ x: 10, y: 10 }}
      windowStart={WINDOW_START}
      onCancel={onCancel}
      onSave={onSave}
      onReassign={onReassign}
      onDelete={onDelete}
      {...over}
    />,
  );
  return { onSave, onReassign, onDelete, onCancel };
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

/** R-346's control, whichever way round it is currently worded. */
function othersButton(): HTMLButtonElement | null {
  return within(pop()).queryByRole("button", {
    name: /other people in this plant/,
  }) as HTMLButtonElement | null;
}

function optionLabels(): (string | null)[] {
  return Array.from(personSelect().options).map((o) => o.textContent);
}

beforeEach(() => {
  vi.clearAllMocks();
});

/* ===========================================================================
 * The picker itself.
 * ======================================================================== */

describe("AP1: the select shows who is on the row now", () => {
  /**
   * ⭐⭐ R-346 CHANGED WHAT "THE POOL" MEANS HERE. It used to be every active
   * person the board carried, Cara included and marked. Now the default list is
   * the people this cell is under -- "a person is available everywhere under
   * their home" -- and Cara waits behind one press.
   */
  it("is set to the current person, and lists only the people offered here", () => {
    renderPopover();
    expect(personSelect().value).toBe(ANA.id);
    expect(optionLabels()).toEqual([
      "Ana",
      "Ben",
      // ⚠️ Dev is INACTIVE and is not on offer. He is in `operators` because
      // the window still carries him; a picker that offered him would post a
      // placement the board could not draw.
      // ⚠️ Cara is ACTIVE and not here either: she is homed in another area,
      // and R-346 puts her behind the control rather than in this list.
    ]);
  });

  it("⭐ the control names how many are behind it, and reveals them marked", () => {
    renderPopover();
    const btn = othersButton();
    expect(btn?.textContent).toBe("Show other people in this plant (1)");
    fireEvent.click(btn as HTMLButtonElement);
    expect(optionLabels()).toEqual(["Ana", "Ben", "Cara — not from this area (override)"]);
  });

  it("and the control is absent when everybody in the plant is already offered", () => {
    renderPopover({ hereOperatorIds: new Set([ANA.id, BEN.id, CARA.id]) });
    expect(othersButton()).toBeNull();
    expect(optionLabels()).toEqual(["Ana", "Ben", "Cara — not from this area (override)"]);
  });

  /**
   * ⚠️ AP1b USED TO BE "somebody on loan from a plant this board is not
   * showing", AND THAT ROW CANNOT EXIST ANY MORE (R-345: the table refuses a
   * cross-plant placement, override or not). What survives is the real version
   * of the same worry: the row holds a LIVE person who is behind the control.
   * A select whose value matches no option shows the FIRST option instead, so
   * hiding her would silently swap the person on the row -- so she is pinned
   * into the list whether the control has been pressed or not.
   */
  it("pins the person already on the row into the list even before the control is pressed", () => {
    renderPopover({
      assignment: assignment({ operatorId: CARA.id }),
      operator: CARA,
    });
    expect(personSelect().value).toBe(CARA.id);
    expect(optionLabels()).toEqual(["Ana", "Ben", "Cara — not from this area (override)"]);
    // ...and the control is still offered, because there is nobody else behind
    // it only when `elsewhere` is empty, which it is not: Cara is in it.
    expect(othersButton()?.textContent).toBe("Show other people in this plant (1)");
  });
});

describe("AP2: choosing somebody else and saving sends exactly that", () => {
  it("calls onReassign with the row and the new person and no override, does not touch onSave, and closes", async () => {
    const { onReassign, onSave, onCancel } = renderPopover();
    fireEvent.change(personSelect(), { target: { value: BEN.id } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(onReassign).toHaveBeenCalledTimes(1));
    expect(onReassign).toHaveBeenCalledWith({
      assignmentId: "a1",
      operatorId: BEN.id,
      eligibilityOverride: false,
      overrideReason: undefined,
      areaOverride: false,
      areaOverrideReason: undefined,
    });
    // ⭐ NOTHING ELSE MOVED, so there is no field edit to send after it. A
    // second write here would be an efficiency PATCH nobody asked for.
    expect(onSave).not.toHaveBeenCalled();
    // ...and the pop-up closes on its own, since no field write will close it.
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("sends the field edits after the person, and only when they changed", async () => {
    const { onReassign, onSave } = renderPopover();
    fireEvent.change(personSelect(), { target: { value: BEN.id } });
    fireEvent.change(within(pop()).getByLabelText("Efficiency %"), { target: { value: "50" } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith("a1", 50, null, null);
    expect(onReassign).toHaveBeenCalledTimes(1);
  });

  it("saving without changing the person calls onSave only", () => {
    const { onReassign, onSave } = renderPopover();
    fireEvent.change(within(pop()).getByLabelText("Efficiency %"), { target: { value: "80" } });
    fireEvent.click(saveButton());
    expect(onSave).toHaveBeenCalledWith("a1", 80, null, null);
    expect(onReassign).not.toHaveBeenCalled();
  });
});

/* ===========================================================================
 * D113 — a person from another area.
 * ======================================================================== */

describe("AP3: a person outside this area is marked, and the reason is asked for", () => {
  it("reveals the reason box, holds Save until it says something, and sends the area override", async () => {
    const { onReassign } = renderPopover();
    // R-346: she is behind the control now, and pressing it is the supervisor's
    // decision to look outside the area. Everything after it is unchanged.
    fireEvent.click(othersButton() as HTMLButtonElement);
    fireEvent.change(personSelect(), { target: { value: CARA.id } });

    expect(
      within(pop()).getByText("This person doesn’t belong to this part of the structure."),
    ).toBeTruthy();
    // The server refuses an override with no reason, so the button must not
    // offer to send one.
    expect(saveButton().disabled).toBe(true);
    fireEvent.click(within(pop()).getByLabelText("Place them here anyway"));
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(within(pop()).getByLabelText("Reason (required)"), {
      target: { value: "  covering Line 1 this week  " },
    });
    expect(saveButton().disabled).toBe(false);

    fireEvent.click(saveButton());
    await waitFor(() => expect(onReassign).toHaveBeenCalledTimes(1));
    expect(onReassign).toHaveBeenCalledWith({
      assignmentId: "a1",
      operatorId: CARA.id,
      eligibilityOverride: false,
      overrideReason: undefined,
      areaOverride: true,
      areaOverrideReason: "covering Line 1 this week",
    });
  });

  it("says nothing about the area for a person who does belong here", () => {
    renderPopover();
    fireEvent.change(personSelect(), { target: { value: BEN.id } });
    expect(within(pop()).queryByText(/belong to this part of the structure/)).toBeNull();
    expect(saveButton().disabled).toBe(false);
  });
});

/* ===========================================================================
 * The server's answer about certification.
 * ======================================================================== */

describe("AP4: a not_eligible answer under warn asks for the override and resends with it", () => {
  it("names the training, offers the tick and a required reason, then sends both", async () => {
    const { onReassign } = renderPopover();
    onReassign.mockRejectedValueOnce(NOT_ELIGIBLE_WARN);
    fireEvent.change(personSelect(), { target: { value: BEN.id } });
    fireEvent.click(saveButton());

    // The first attempt carries no flags at all: the screen had nothing to
    // predict this from and must not send an override nobody ticked.
    await waitFor(() => expect(onReassign).toHaveBeenCalledTimes(1));
    expect(onReassign.mock.calls[0][0]).toMatchObject({ eligibilityOverride: false });

    await screen.findByText("Never trained:");
    expect(within(pop()).getByText(/Welding/)).toBeTruthy();
    expect(saveButton().disabled).toBe(true);

    onReassign.mockResolvedValueOnce(undefined);
    fireEvent.click(
      within(pop()).getByLabelText("Override — I’m certifying this placement anyway"),
    );
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(within(pop()).getByLabelText("Reason (required)"), {
      target: { value: "Ben is shadowing Ana" },
    });
    expect(saveButton().disabled).toBe(false);

    fireEvent.click(saveButton());
    await waitFor(() => expect(onReassign).toHaveBeenCalledTimes(2));
    expect(onReassign.mock.calls[1][0]).toEqual({
      assignmentId: "a1",
      operatorId: BEN.id,
      eligibilityOverride: true,
      overrideReason: "Ben is shadowing Ana",
      areaOverride: false,
      areaOverrideReason: undefined,
    });
  });

  it("forgets the answer when a different person is picked", async () => {
    const { onReassign } = renderPopover();
    onReassign.mockRejectedValueOnce(NOT_ELIGIBLE_WARN);
    fireEvent.change(personSelect(), { target: { value: BEN.id } });
    fireEvent.click(saveButton());
    await screen.findByText("Never trained:");

    // An answer about Ben says nothing about Ana or Cara.
    fireEvent.change(personSelect(), { target: { value: CARA.id } });
    expect(within(pop()).queryByText("Never trained:")).toBeNull();
  });
});

describe("AP5: under block there is no override to offer", () => {
  it("says so and leaves Save disabled, and never sends a second attempt", async () => {
    const { onReassign } = renderPopover();
    onReassign.mockRejectedValueOnce(NOT_ELIGIBLE_BLOCK);
    fireEvent.change(personSelect(), { target: { value: BEN.id } });
    fireEvent.click(saveButton());

    await screen.findByText("Certification is required at this place, so there is no override.");
    expect(
      within(pop()).queryByLabelText("Override — I’m certifying this placement anyway"),
    ).toBeNull();
    expect(saveButton().disabled).toBe(true);

    fireEvent.click(saveButton());
    expect(onReassign).toHaveBeenCalledTimes(1);
  });
});

describe("AP6: every other refusal is shown in the pop-up", () => {
  it("prints the error contract's own sentence and keeps the choice on screen", async () => {
    const { onReassign, onSave } = renderPopover();
    onReassign.mockRejectedValueOnce(NOT_PERMITTED);
    fireEvent.change(personSelect(), { target: { value: BEN.id } });
    fireEvent.change(within(pop()).getByLabelText("Efficiency %"), { target: { value: "50" } });
    fireEvent.click(saveButton());

    await screen.findByText("You do not have edit rights on this cell.");
    // ⭐ AND THE FIELD EDIT DID NOT GO EITHER. The two writes are not one
    // transaction, so a refused reassignment must leave the row exactly as it
    // was rather than half-edited.
    expect(onSave).not.toHaveBeenCalled();
    expect(personSelect().value).toBe(BEN.id);
  });
});

describe("AP7: a capacity refusal names the person, not their id", () => {
  it("says who would be over capacity, with the peak and the limit as percentages", () => {
    expect(
      describeRefusal(
        { kind: "CapacityExceeded", operatorId: BEN.id, peak: 2, cap: 1, timerange: "" },
        "Ben",
      ),
    ).toBe("Ben would reach 200% of capacity at this time (limit 100%).");
  });

  it("leaves every other refusal to the contract's own sentence", () => {
    const notPermitted = { kind: "NotPermitted", nodeId: "n1" } as const;
    expect(describeRefusal(notPermitted, "Ben")).toBe(describeSchedulerError(notPermitted));
  });
});

describe("AP8: a row whose person was deleted (D110) names them and can be re-staffed", () => {
  it("shows the remembered name as the current value, not the first person in the pool", () => {
    renderPopover({
      assignment: { ...assignment(), operatorId: null, operatorDisplayName: "Ada" },
      operator: undefined,
    });
    expect(personSelect().value).toBe("");
    expect(personSelect().selectedOptions[0].textContent).toContain("Ada");
    expect(personSelect().selectedOptions[0].textContent).toContain("no longer in the system");
  });

  it("saving without picking anyone reassigns nobody; picking Ben reassigns to Ben", async () => {
    const { onReassign, onSave } = renderPopover({
      assignment: { ...assignment(), operatorId: null, operatorDisplayName: "Ada" },
      operator: undefined,
    });
    fireEvent.click(saveButton());
    expect(onReassign).not.toHaveBeenCalled();
    expect(onSave).toHaveBeenCalledTimes(1);

    fireEvent.change(personSelect(), { target: { value: BEN.id } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(onReassign).toHaveBeenCalledTimes(1));
    expect(onReassign.mock.calls[0][0]).toMatchObject({ assignmentId: "a1", operatorId: BEN.id });
  });
});

describe("AP9: the eligibility answer survives a later refusal of another kind", () => {
  it("keeps the training message and the tick when the resend is refused for capacity, and resends with the override", async () => {
    const { onReassign } = renderPopover();
    onReassign.mockRejectedValueOnce(NOT_ELIGIBLE_WARN);
    fireEvent.change(personSelect(), { target: { value: BEN.id } });
    fireEvent.click(saveButton());
    await screen.findByText("Never trained:");
    fireEvent.click(
      within(pop()).getByLabelText("Override — I’m certifying this placement anyway"),
    );
    fireEvent.change(within(pop()).getByLabelText("Reason (required)"), {
      target: { value: "Ben is shadowing Ana" },
    });

    const busy: SchedulerError = {
      kind: "CapacityExceeded",
      operatorId: BEN.id,
      peak: 2,
      cap: 1,
      timerange: "",
    };
    onReassign.mockRejectedValueOnce(busy);
    fireEvent.click(saveButton());
    await waitFor(() => expect(onReassign).toHaveBeenCalledTimes(2));
    expect(onReassign.mock.calls[1][0]).toMatchObject({ eligibilityOverride: true });

    // Both answers are on screen: the capacity sentence, and the training
    // question still answered.
    expect(within(pop()).getByRole("alert").textContent).toBe(
      "Ben would reach 200% of capacity at this time (limit 100%).",
    );
    expect(within(pop()).getByText("Never trained:")).toBeTruthy();
    expect(
      (
        within(pop()).getByLabelText(
          "Override — I’m certifying this placement anyway",
        ) as HTMLInputElement
      ).checked,
    ).toBe(true);

    onReassign.mockResolvedValueOnce(undefined);
    fireEvent.click(saveButton());
    await waitFor(() => expect(onReassign).toHaveBeenCalledTimes(3));
    expect(onReassign.mock.calls[2][0]).toMatchObject({
      eligibilityOverride: true,
      overrideReason: "Ben is shadowing Ana",
    });
  });
});
