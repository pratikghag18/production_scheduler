import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import type { BoardOperator, Product, Skill } from "@/lib/api";
import type { IndexedAssignment } from "@/features/board/lib/boardIndex";
import { OperatorPanel } from "@/features/board/components/OperatorPanel";
import { CreatePopover } from "@/features/board/components/CreatePopover";
import { AssignmentPopover } from "@/features/board/components/AssignmentPopover";

/**
 * R-346 — THE TWO LISTS, ON ALL THREE SCREENS THAT OFFER A PERSON.
 *
 * ⭐⭐ THE MAINTAINER, 6 Sept, and this file is that sentence turned into cases:
 * *"If a operator is assigned to higher hierarchy they should automatically
 * become available to all lower hierarchy within that hierarchy ... That should
 * be the default behaviour. For other operators in the plant we need to give an
 * option to the supervisor to click through something so show remaining
 * operators so they can make that decision to assign someone outside of that
 * area."*
 *
 * ⚠️ WHY ONE FILE FOR THREE COMPONENTS. The left panel, the create pop-up and
 * the assignment pop-up are the three places a person is chosen (the list
 * `pickerPool.test.ts` guards), and the maintainer's rule names them as one
 * behaviour: the same default, the same control, the same wording. Split across
 * three files, one of them drifts and each file still passes. Here, the
 * expected wording is a single constant and a change to it is one edit that
 * three describes must agree with.
 *
 * ⚠️ NONE OF THESE COMPONENTS DECIDES WHO IS WHERE. `BoardPage` resolves the
 * split from `lib/outsideArea.ts` and hands down `hereOperatorIds`; these cases
 * therefore hand it down too, and `outsideArea.test.ts` is where the RULE is
 * judged. What is judged here is the screen: what is listed before the press,
 * what the press reveals, how it is marked, and that picking a revealed person
 * still runs the D113 reason flow unchanged.
 */

const SHOW = /^Show other people in this plant \((\d+)\)$/;
const CONTROL = /other people in this plant/;
const MARK = " — not from this area (override)";

/** Ana's board: she is granted Line 1, and the pop-ups are opened on a cell. */
const CELL = "n-cell-1";

function op(id: string, displayName: string): BoardOperator {
  return {
    id,
    homeNodeId: null,
    displayName,
    employeeRef: null,
    active: true,
    siteNodeId: `n-${id}`,
    sitePath: "plant_a",
    skillIds: [],
    skillExpiries: [],
  };
}

/** Homed at the plant, or on this line: offered by default. */
const PAT = op("op-pat", "Pat");
const QUINN = op("op-quinn", "Quinn");
/** Homed in another area of the same plant: behind the control, and marked. */
const ROSA = op("op-rosa", "Rosa");
const SAM = op("op-sam", "Sam");

// Tam has left: homed in another area, inactive. The server still sends
// them (board_window does not filter on active); every picker must drop them
// BEFORE its split, or the panel and a pop-up disagree about the count (the
// reviewer, session 78).
const TAM = { ...op("op-tam", "Tam"), active: false };
const PLANT = [PAT, QUINN, ROSA, SAM, TAM];
const HERE = new Set([PAT.id, QUINN.id]);
const EVERYONE = new Set(PLANT.map((o) => o.id));
/** The mark is a separate answer (see `outsideArea.ts`); at this cell it is the
 *  two people whose home does not cover it. */
const OUTSIDE = new Set([ROSA.id, SAM.id, TAM.id]);

beforeEach(() => {
  vi.clearAllMocks();
});

/* ===========================================================================
 * The left panel.
 * ======================================================================== */

function renderPanel(over: Partial<ComponentProps<typeof OperatorPanel>> = {}) {
  const beginPanelDrag = vi.fn();
  render(
    <OperatorPanel
      operators={PLANT}
      hereOperatorIds={HERE}
      skillById={new Map<string, Skill>()}
      nodeById={new Map()}
      assignmentsByOperator={new Map<string, IndexedAssignment[]>()}
      windowStart={new Date("2026-09-07T00:00:00Z")}
      windowMinutes={1440}
      capacityCap={1}
      open
      onToggleOpen={vi.fn()}
      dragApi={{
        beginPanelDrag,
        updatePanelDrag: vi.fn(),
        endPanelDrag: vi.fn(),
        cancelDrag: vi.fn(),
      }}
      {...over}
    />,
  );
  return { beginPanelDrag };
}

function panel(): HTMLElement {
  return screen.getByRole("complementary", { name: "Operators" });
}

function panelNames(): string[] {
  // Every chip carries the person's name; the control is a button and the
  // header is a label, so reading the chips by their name spans is the honest
  // way to ask "who is listed".
  return Array.from(panel().querySelectorAll("div[title], div"))
    .map((el) => el.firstElementChild?.nextElementSibling?.textContent ?? "")
    .filter((t) => PLANT.some((o) => o.displayName === t));
}

describe("PP1: the left panel opens on the people whose home covers this board", () => {
  /**
   * ⭐⭐ THE DEFECT THIS STAGE STARTED FROM, ON THE SCREEN. Ana, granted Line 1:
   * *"Ana can't see any operators on the left panel. What am I missing?
   * Something is definitely wrong."* The panel now shows the default offers and
   * nothing else -- but it shows them.
   */
  it("lists `here` and not the rest of the plant", () => {
    renderPanel();
    expect(panelNames()).toEqual(["Pat", "Quinn"]);
    expect(within(panel()).queryByText("Rosa")).toBeNull();
  });

  it("⭐ the control says how many are behind it", () => {
    renderPanel();
    expect(
      (within(panel()).getByRole("button", { name: CONTROL }) as HTMLButtonElement).textContent,
    ).toMatch(SHOW);
    expect(within(panel()).getByRole("button", { name: CONTROL }).textContent).toBe(
      "Show other people in this plant (2)",
    );
  });

  it("pressing it reveals them, each marked, and a second press hides them again", () => {
    renderPanel();
    const btn = within(panel()).getByRole("button", { name: CONTROL });
    fireEvent.click(btn);
    expect(panelNames()).toEqual(["Pat", "Quinn", "Rosa", "Sam"]);
    expect(within(panel()).getAllByText("not from this area")).toHaveLength(2);

    fireEvent.click(within(panel()).getByRole("button", { name: CONTROL }));
    expect(panelNames()).toEqual(["Pat", "Quinn"]);
    expect(within(panel()).queryByText("not from this area")).toBeNull();
  });

  it("⚠️ the control is absent when the board's place covers every home in the plant", () => {
    // A plant admin's board. A control reading "(0)" is a door onto an empty
    // room, so it is not rendered at all.
    renderPanel({ hereOperatorIds: EVERYONE });
    expect(within(panel()).queryByRole("button", { name: CONTROL })).toBeNull();
    expect(panelNames()).toEqual(["Pat", "Quinn", "Rosa", "Sam"]);
  });

  /**
   * ⭐ AND A REVEALED PERSON IS DRAGGED THE SAME WAY AS ANYBODY ELSE. There is
   * no second path: the chip starts the one shared panel drag (D29/D65), the
   * drop opens the create pop-up with them preset, and that pop-up marks them
   * and asks for the D113 reason. Nothing about the server contract changes.
   */
  it("a revealed person is a drag source like any other chip", () => {
    const { beginPanelDrag } = renderPanel();
    fireEvent.click(within(panel()).getByRole("button", { name: CONTROL }));
    fireEvent.pointerDown(within(panel()).getByText("Rosa"));
    expect(beginPanelDrag).toHaveBeenCalledTimes(1);
    expect(beginPanelDrag.mock.calls[0][0]).toMatchObject({ id: ROSA.id });
  });
});

/* ===========================================================================
 * The create pop-up.
 * ======================================================================== */

const PRODUCT: Product = {
  id: "p1",
  sku: "WX",
  name: "Widget X",
  active: true,
  siteNodeIds: ["n-plant"],
  offeredNodeIds: [CELL],
  colorToken: "product-1",
} as Product;

type DirectSubmit = ComponentProps<typeof CreatePopover>["onSubmitDirect"];

function renderCreate(over: Partial<ComponentProps<typeof CreatePopover>> = {}) {
  const onSubmitDirect = vi.fn<DirectSubmit>();
  render(
    <CreatePopover
      nodeId={CELL}
      anchor={{ x: 10, y: 10 }}
      initialRange={{ startMin: 360, endMin: 840 }}
      shiftChips={[]}
      defaultCreateMode="direct"
      products={[PRODUCT]}
      operators={PLANT}
      hereOperatorIds={HERE}
      windowStart={new Date("2026-09-07T00:00:00Z")}
      requiredSkills={[]}
      outsideAreaOperatorIds={OUTSIDE}
      eligibilityPolicy="warn"
      onCancel={vi.fn()}
      onSubmitRun={vi.fn()}
      onSubmitDirect={onSubmitDirect}
      {...over}
    />,
  );
  return { onSubmitDirect };
}

function pop(): HTMLElement {
  return screen.getByRole("dialog");
}

function labelsOf(select: HTMLSelectElement): (string | null)[] {
  return Array.from(select.options).map((o) => o.textContent);
}

function operatorSelect(): HTMLSelectElement {
  return within(pop()).getByLabelText("Operator") as HTMLSelectElement;
}

describe("PP2: the create pop-up's Operator select", () => {
  it("opens on the people offered at this cell", () => {
    renderCreate();
    expect(labelsOf(operatorSelect())).toEqual(["Pat", "Quinn"]);
  });

  it("⭐ the control names the count and adds them, marked for the override", () => {
    renderCreate();
    expect(within(pop()).getByRole("button", { name: CONTROL }).textContent).toBe(
      "Show other people in this plant (2)",
    );
    fireEvent.click(within(pop()).getByRole("button", { name: CONTROL }));
    expect(labelsOf(operatorSelect())).toEqual(["Pat", "Quinn", `Rosa${MARK}`, `Sam${MARK}`]);
  });

  it("is absent when everybody in the plant is offered here", () => {
    renderCreate({ hereOperatorIds: EVERYONE, outsideAreaOperatorIds: new Set<string>() });
    expect(within(pop()).queryByRole("button", { name: CONTROL })).toBeNull();
  });

  /**
   * ⭐⭐ THE REASON FLOW IS UNCHANGED, AND THAT IS THE POINT OF PUTTING THEM IN
   * THE SAME SELECT RATHER THAN GIVING THEM A SEPARATE ONE. The click is the
   * supervisor's decision to look outside the area; D113's question is still
   * what asks WHY, and the same `areaOverride` pair still goes to the server.
   */
  it("picking a revealed person asks the D113 reason and sends the area override", () => {
    const { onSubmitDirect } = renderCreate();
    fireEvent.click(within(pop()).getByRole("button", { name: CONTROL }));
    fireEvent.change(operatorSelect(), { target: { value: ROSA.id } });

    expect(
      within(pop()).getByText("This person doesn’t belong to this part of the structure."),
    ).toBeTruthy();
    const create = within(pop()).getByRole("button", { name: "Create" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.click(within(pop()).getByLabelText("Place them here anyway"));
    expect(create.disabled).toBe(true);
    fireEvent.change(within(pop()).getByLabelText("Reason (required)"), {
      target: { value: "  covering Line 1 today  " },
    });
    expect(create.disabled).toBe(false);

    fireEvent.click(create);
    expect(onSubmitDirect).toHaveBeenCalledTimes(1);
    const call = onSubmitDirect.mock.calls[0];
    expect(call[2]).toBe(ROSA.id);
    expect(call[9]).toBe(true);
    expect(call[10]).toBe("covering Line 1 today");
  });

  it("and says nothing about the area for one of this cell's own people", () => {
    renderCreate();
    fireEvent.change(operatorSelect(), { target: { value: QUINN.id } });
    expect(within(pop()).queryByText(/belong to this part of the structure/)).toBeNull();
  });

  /**
   * ⚠️ A PANEL DROP OF A REVEALED PERSON OPENS THE LIST ALREADY REVEALED. A
   * `<select>` whose value matches no option shows the FIRST option instead, so
   * a hidden preset would silently swap the person the supervisor just dragged
   * -- and the create would then be for somebody they never chose.
   */
  it("a preset from the rest of the plant is listed and selected, not silently swapped", () => {
    renderCreate({ presetOperatorId: SAM.id });
    expect(operatorSelect().value).toBe(SAM.id);
    expect(labelsOf(operatorSelect())).toEqual(["Pat", "Quinn", `Rosa${MARK}`, `Sam${MARK}`]);
    expect(
      within(pop()).getByText("This person doesn’t belong to this part of the structure."),
    ).toBeTruthy();
  });
});

/* ===========================================================================
 * The assignment pop-up.
 * ======================================================================== */

function assignment(over: Partial<IndexedAssignment> = {}): IndexedAssignment {
  return {
    id: "a1",
    orgId: "org-1",
    nodeId: CELL,
    operatorId: PAT.id,
    operatorDisplayName: null,
    runId: null,
    productId: "p1",
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
  } as IndexedAssignment;
}

function renderAssignment(over: Partial<ComponentProps<typeof AssignmentPopover>> = {}) {
  const onReassign = vi.fn<ComponentProps<typeof AssignmentPopover>["onReassign"]>();
  onReassign.mockResolvedValue(undefined);
  render(
    <AssignmentPopover
      operators={PLANT}
      hereOperatorIds={HERE}
      outsideAreaOperatorIds={OUTSIDE}
      assignment={assignment()}
      homeRun={null}
      operator={PAT}
      products={[PRODUCT]}
      anchor={{ x: 10, y: 10 }}
      windowStart={new Date("2026-09-07T00:00:00Z")}
      onCancel={vi.fn()}
      onSave={vi.fn()}
      onReassign={onReassign}
      onDelete={vi.fn()}
      {...over}
    />,
  );
  return { onReassign };
}

function personSelect(): HTMLSelectElement {
  return within(pop()).getByLabelText("Person") as HTMLSelectElement;
}

describe("PP3: the assignment pop-up's Person select", () => {
  it("opens on the people offered at this cell", () => {
    renderAssignment();
    expect(labelsOf(personSelect())).toEqual(["Pat", "Quinn"]);
  });

  it("⭐ the control names the count and adds them, marked for the override", () => {
    renderAssignment();
    expect(within(pop()).getByRole("button", { name: CONTROL }).textContent).toBe(
      "Show other people in this plant (2)",
    );
    fireEvent.click(within(pop()).getByRole("button", { name: CONTROL }));
    expect(labelsOf(personSelect())).toEqual(["Pat", "Quinn", `Rosa${MARK}`, `Sam${MARK}`]);
  });

  it("is absent when everybody in the plant is offered here", () => {
    renderAssignment({ hereOperatorIds: EVERYONE, outsideAreaOperatorIds: new Set<string>() });
    expect(within(pop()).queryByRole("button", { name: CONTROL })).toBeNull();
  });

  it("picking a revealed person asks the D113 reason and sends the area override", async () => {
    const { onReassign } = renderAssignment();
    fireEvent.click(within(pop()).getByRole("button", { name: CONTROL }));
    fireEvent.change(personSelect(), { target: { value: ROSA.id } });

    expect(
      within(pop()).getByText("This person doesn’t belong to this part of the structure."),
    ).toBeTruthy();
    const save = within(pop()).getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(within(pop()).getByLabelText("Place them here anyway"));
    fireEvent.change(within(pop()).getByLabelText("Reason (required)"), {
      target: { value: "short-handed on Line 1" },
    });
    expect(save.disabled).toBe(false);

    fireEvent.click(save);
    await waitFor(() => expect(onReassign).toHaveBeenCalledTimes(1));
    expect(onReassign).toHaveBeenCalledWith({
      assignmentId: "a1",
      operatorId: ROSA.id,
      eligibilityOverride: false,
      overrideReason: undefined,
      areaOverride: true,
      areaOverrideReason: "short-handed on Line 1",
    });
  });

  /**
   * ⚠️ THE "KEEP THE CURRENT PERSON IN THE LIST" EXCEPTION, IN ITS NARROWED
   * FORM. It used to cover a live person on loan from another plant; R-345
   * makes such a row impossible, so what is left is a live person from another
   * AREA -- pinned in even while the control is unpressed, because a select
   * whose value matches no option silently shows somebody else.
   */
  it("pins a live person from another area when they are the one on the row", () => {
    renderAssignment({ assignment: assignment({ operatorId: SAM.id }), operator: SAM });
    expect(personSelect().value).toBe(SAM.id);
    expect(labelsOf(personSelect())).toEqual(["Pat", "Quinn", `Sam${MARK}`]);
  });

  /** D110's ghost is the only row whose person is in no pool at all. */
  it("and the departed-person row still names them and is still the value", () => {
    renderAssignment({
      assignment: assignment({ operatorId: null, operatorDisplayName: "Ada" }),
      operator: undefined,
    });
    expect(personSelect().value).toBe("");
    expect(personSelect().selectedOptions[0].textContent).toContain("Ada");
    expect(personSelect().selectedOptions[0].textContent).toContain("no longer in the system");
  });
});

describe("an inactive person counts nowhere, so the panel and the pop-ups agree", () => {
  it("the panel's control counts two, not three, and never lists Tam", () => {
    renderPanel();
    const btn = within(panel()).getByRole("button", { name: CONTROL });
    expect(btn.textContent).toBe("Show other people in this plant (2)");
    fireEvent.click(btn);
    expect(within(panel()).queryByText("Tam")).toBeNull();
  });

  it("the create pop-up's control counts the same two, and never offers Tam", () => {
    renderCreate();
    const btn = screen.getByRole("button", { name: CONTROL });
    expect(btn.textContent).toBe("Show other people in this plant (2)");
    fireEvent.click(btn);
    expect(
      Array.from((screen.getByLabelText("Operator") as HTMLSelectElement).options).map(
        (o) => o.value,
      ),
    ).not.toContain(TAM.id);
  });
});
