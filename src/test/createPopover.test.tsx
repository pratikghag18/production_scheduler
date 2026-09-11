/**
 * R-026: a type selector in the creation popover chooses between a product run
 * and a direct assignment. (The claim's other clause -- "drag-select can create
 * ... at any time" -- is the gesture layer's job, dragGesture.test.ts's, and
 * still has zero CREATE cases per R-025's own note; not provable from this
 * component alone, so it stays off this row.)
 *
 * `CreatePopover` takes no hooks of its own -- every scope decision (which
 * products, which operators, which policy) is resolved by `BoardPage` and
 * handed down as props, so the popover itself holds no rule and needs no
 * mocking to mount.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { CreatePopover } from "@/features/board/components/CreatePopover";
import type { Product, BoardOperator } from "@/lib/api";

const WINDOW_START = new Date("2026-08-24T00:00:00.000Z");

const product: Product = {
  id: "prod-1",
  name: "Widget A",
  sku: "W-A",
  active: true,
  siteNodeIds: [],
  offeredNodeIds: [],
  colorToken: "product-1",
};

const operator: BoardOperator = {
  id: "op-1",
  displayName: "Ana Ortiz",
  homeNodeId: null,
  employeeRef: null,
  active: true,
  siteNodeId: "n-plant",
  sitePath: "plant_a",
  skillIds: [],
  skillExpiries: [],
};

function renderPopover(over: { defaultCreateMode?: "run" | "direct" } = {}) {
  const onSubmitRun = vi.fn();
  const onSubmitDirect = vi.fn();
  const onCancel = vi.fn();
  render(
    <CreatePopover
      nodeId="cell-1"
      anchor={{ x: 0, y: 0 }}
      initialRange={{ startMin: 360, endMin: 480 }}
      shiftChips={[]}
      defaultCreateMode={over.defaultCreateMode ?? "run"}
      products={[product]}
      operators={[operator]}
      hereOperatorIds={new Set(["op-1"])}
      windowStart={WINDOW_START}
      requiredSkills={[]}
      outsideAreaOperatorIds={new Set()}
      eligibilityPolicy="warn"
      onCancel={onCancel}
      onSubmitRun={onSubmitRun}
      onSubmitDirect={onSubmitDirect}
    />,
  );
  return { onSubmitRun, onSubmitDirect, onCancel };
}

describe("CreatePopover — the type selector (R-026)", () => {
  it("C1: opens on the caller's default mode, with that segment marked current", () => {
    renderPopover({ defaultCreateMode: "direct" });
    expect(screen.getByRole("button", { name: "Direct assignment" }).className).toMatch(/segOn/);
    expect(screen.getByRole("button", { name: "Product run" }).className).not.toMatch(/segOn/);
    // Direct mode's own field is on screen; the run-only headcount field is not.
    expect(screen.getByLabelText("Operator")).toBeTruthy();
    expect(screen.queryByLabelText("Planned headcount")).toBeNull();
  });

  it("C2: Product run mode shows the headcount field, not the operator picker", () => {
    renderPopover({ defaultCreateMode: "run" });
    expect(screen.getByLabelText("Planned headcount")).toBeTruthy();
    expect(screen.queryByLabelText("Operator")).toBeNull();
  });

  it("C3: clicking the other segment switches the fields shown, without reloading the popover", () => {
    renderPopover({ defaultCreateMode: "run" });
    fireEvent.click(screen.getByRole("button", { name: "Direct assignment" }));
    expect(screen.getByLabelText("Operator")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Product run" }));
    expect(screen.getByLabelText("Planned headcount")).toBeTruthy();
  });

  it("C4: Create in run mode calls onSubmitRun, never onSubmitDirect", () => {
    const { onSubmitRun, onSubmitDirect } = renderPopover({ defaultCreateMode: "run" });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(onSubmitRun).toHaveBeenCalledTimes(1);
    expect(onSubmitRun.mock.calls[0][0]).toBe("cell-1");
    expect(onSubmitRun.mock.calls[0][2]).toBe("prod-1");
    expect(onSubmitDirect).not.toHaveBeenCalled();
  });

  it("C5: Create in direct mode calls onSubmitDirect, never onSubmitRun", () => {
    const { onSubmitRun, onSubmitDirect } = renderPopover({ defaultCreateMode: "direct" });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(onSubmitDirect).toHaveBeenCalledTimes(1);
    expect(onSubmitDirect.mock.calls[0][0]).toBe("cell-1");
    expect(onSubmitDirect.mock.calls[0][2]).toBe("op-1");
    // P1-7a: the contract changed here, not the case -- position 3 used to be
    // the bare product id; it is now the target `create_assignment` already
    // takes a discriminated union for (`AssignmentTarget`), so a run-attached
    // create sent through the same popover can be told apart from this one.
    expect(onSubmitDirect.mock.calls[0][3]).toEqual({ kind: "direct", productId: "prod-1" });
    expect(onSubmitRun).not.toHaveBeenCalled();
  });

  it("C6: Cancel calls onCancel and submits nothing", () => {
    const { onSubmitRun, onSubmitDirect, onCancel } = renderPopover();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmitRun).not.toHaveBeenCalled();
    expect(onSubmitDirect).not.toHaveBeenCalled();
  });
});
