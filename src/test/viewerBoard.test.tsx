import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { BoardOperator, Product } from "@/lib/api";
import type { IndexedAssignment, IndexedRun } from "@/features/board/lib/boardIndex";
import { AssignmentPopover } from "@/features/board/components/AssignmentPopover";
import { RunPopover } from "@/features/board/components/RunPopover";

/**
 * DEF-0015 / R-239 / R-346 — THE VIEWER'S POP-UPS ARE READ-ONLY.
 *
 * A viewer is someone the server answers `can_place: false` for. `BoardPage`
 * reads that one boolean and hands the assignment and run pop-ups `readOnly`,
 * so a viewer who clicks a chip or a band still SEES it — but is offered no
 * Person select, no editable field, and no Save or Delete, only Close. Every
 * one of those writes is refused by the `assignments_*` / run policies, and
 * R-239 is that a control is never shown for something the server refuses.
 *
 * ⚠️ WHY THE COMPONENTS AND NOT THE BOARD. Rendering `BoardPage` needs the
 * session, the query client, the API and the drag layer mocked at once (the
 * DEF-0015 pin says as much, and reads `BoardPage.tsx` as source instead). The
 * gesture-layer half of the fix — that a viewer opens no create pop-up and
 * starts no drag — is proven in `dragGesture.test.ts`. This file proves the
 * pop-ups honour the `readOnly` prop `BoardPage` hands them, both ways.
 */

const CELL = "n-cell-1";
const PRODUCT: Product = {
  id: "p1",
  orgId: "org-1",
  sku: "SKU-1",
  name: "Housing A",
  colorToken: null,
  active: true,
} as unknown as Product;

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

const PAT = op("op-pat", "Pat");
const QUINN = op("op-quinn", "Quinn");
const PLANT = [PAT, QUINN];
const HERE = new Set([PAT.id, QUINN.id]);

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

const runFixture: IndexedRun = {
  id: "run-1",
  orgId: "org-1",
  nodeId: CELL,
  productId: "p1",
  productSku: null,
  productName: null,
  productColorToken: null,
  timerange: "[2026-09-07 06:00+00,2026-09-07 10:00+00)",
  plannedHeadcount: 2,
  notes: "morning line",
  createdBy: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  startMin: 360,
  endMin: 600,
} as unknown as IndexedRun;

function renderAssignment(
  readOnly: boolean,
  over: Partial<Parameters<typeof AssignmentPopover>[0]> = {},
) {
  const onCancel = vi.fn();
  const onSave = vi.fn();
  const onDelete = vi.fn();
  const onReassign = vi.fn().mockResolvedValue(undefined);
  render(
    <AssignmentPopover
      readOnly={readOnly}
      operators={PLANT}
      hereOperatorIds={HERE}
      outsideAreaOperatorIds={new Set<string>()}
      assignment={assignment()}
      homeRun={null}
      operator={PAT}
      products={[PRODUCT]}
      anchor={{ x: 10, y: 10 }}
      windowStart={new Date("2026-09-07T00:00:00Z")}
      onCancel={onCancel}
      onSave={onSave}
      onReassign={onReassign}
      onDelete={onDelete}
      {...over}
    />,
  );
  return { onCancel, onSave, onDelete };
}

function renderRun(readOnly: boolean) {
  const onCancel = vi.fn();
  const onSave = vi.fn();
  const onDelete = vi.fn();
  render(
    <RunPopover
      readOnly={readOnly}
      run={runFixture}
      crew={[]}
      anchor={{ x: 10, y: 10 }}
      windowStart={new Date("2026-09-07T00:00:00Z")}
      products={[PRODUCT]}
      onCancel={onCancel}
      onSave={onSave}
      onDelete={onDelete}
    />,
  );
  return { onCancel, onSave, onDelete };
}

function pop(): HTMLElement {
  return screen.getByRole("dialog");
}

describe("DEF-0015: the viewer's assignment pop-up", () => {
  it("offers no Person select, no Save and no Delete — only Close, which works", () => {
    const { onCancel } = renderAssignment(true);
    expect(within(pop()).queryByLabelText("Person")).toBeNull();
    expect(within(pop()).queryByRole("button", { name: "Save" })).toBeNull();
    expect(within(pop()).queryByRole("button", { name: "Delete" })).toBeNull();
    const close = within(pop()).getByRole("button", { name: "Close" });
    fireEvent.click(close);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("still shows the assignment's details", () => {
    renderAssignment(true);
    // The person and the efficiency are read off, so a viewer sees the row.
    expect(within(pop()).getByText(/Person: Pat/)).toBeTruthy();
    expect(within(pop()).getByText(/Efficiency: 100%/)).toBeTruthy();
  });

  it("with canPlace true (readOnly false) the write controls are unchanged", () => {
    renderAssignment(false);
    expect(within(pop()).getByLabelText("Person")).toBeTruthy();
    expect(within(pop()).getByRole("button", { name: "Save" })).toBeTruthy();
    expect(within(pop()).getByRole("button", { name: "Delete" })).toBeTruthy();
  });
});

describe("DEF-0015: the viewer's run pop-up", () => {
  it("offers no editable field, no Save and no Delete — only Close, which works", () => {
    const { onCancel } = renderRun(true);
    expect(within(pop()).queryByLabelText("Planned headcount")).toBeNull();
    expect(within(pop()).queryByLabelText("Notes")).toBeNull();
    expect(within(pop()).queryByRole("button", { name: "Save" })).toBeNull();
    expect(within(pop()).queryByRole("button", { name: "Delete" })).toBeNull();
    const close = within(pop()).getByRole("button", { name: "Close" });
    fireEvent.click(close);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("still shows the run's details", () => {
    renderRun(true);
    expect(within(pop()).getByText(/Planned headcount: 2/)).toBeTruthy();
    expect(within(pop()).getByText(/morning line/)).toBeTruthy();
  });

  it("with canPlace true (readOnly false) the write controls are unchanged", () => {
    renderRun(false);
    expect(within(pop()).getByLabelText("Planned headcount")).toBeTruthy();
    expect(within(pop()).getByRole("button", { name: "Save" })).toBeTruthy();
    expect(within(pop()).getByRole("button", { name: "Delete" })).toBeTruthy();
  });
});
