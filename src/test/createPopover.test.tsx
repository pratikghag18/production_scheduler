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
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { CreatePopover } from "@/features/board/components/CreatePopover";
import type { Product, BoardOperator, Skill } from "@/lib/api";
import type { AbsenceRow } from "@/lib/absence";

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

/** R-384 fixtures: one skill, an operator who holds it and one who does not. */
const CNC: Skill = { id: "sk-cnc", name: "CNC" };
const trainedOperator: BoardOperator = { ...operator, skillIds: ["sk-cnc"] };
const untrainedOperator: BoardOperator = { ...operator, skillIds: [] };

function renderPopover(
  over: {
    defaultCreateMode?: "run" | "direct";
    operators?: BoardOperator[];
    requiredSkills?: Skill[];
    outsideAreaOperatorIds?: ReadonlySet<string>;
    eligibilityPolicy?: "warn" | "block";
    absences?: AbsenceRow[];
    presetOperatorId?: string;
    presetProductId?: string;
    presetRun?: { id: string; label: string };
    autoCreate?: boolean;
    /** R-384: renders under `<StrictMode>`, the way `src/main.tsx` mounts the
     *  app — needed to prove the auto-press fires exactly once (F-128). */
    strict?: boolean;
  } = {},
) {
  const onSubmitRun = vi.fn();
  const onSubmitDirect = vi.fn();
  const onCancel = vi.fn();
  const ops = over.operators ?? [operator];
  const element = (
    <CreatePopover
      nodeId="cell-1"
      anchor={{ x: 0, y: 0 }}
      initialRange={{ startMin: 360, endMin: 480 }}
      shiftChips={[]}
      defaultCreateMode={over.defaultCreateMode ?? "run"}
      products={[product]}
      operators={ops}
      hereOperatorIds={new Set(ops.map((o) => o.id))}
      windowStart={WINDOW_START}
      requiredSkills={over.requiredSkills ?? []}
      outsideAreaOperatorIds={over.outsideAreaOperatorIds ?? new Set()}
      eligibilityPolicy={over.eligibilityPolicy ?? "warn"}
      absences={over.absences ?? []}
      presetOperatorId={over.presetOperatorId}
      presetProductId={over.presetProductId}
      presetRun={over.presetRun}
      autoCreate={over.autoCreate}
      onCancel={onCancel}
      onSubmitRun={onSubmitRun}
      onSubmitDirect={onSubmitDirect}
    />
  );
  render(over.strict ? <StrictMode>{element}</StrictMode> : element);
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

/**
 * R-384 — the maintainer, 11 Sept, after trying the typed command bar: "Enter
 * creates when the pop-up is clean, otherwise it defeats the purpose of the
 * voice option." `autoCreate` is set only by `openCreateFromCommand`
 * (dragGesture.test.ts pins that a drag's popover never carries it); these
 * cases are about what THIS component does with it once set — press Create
 * itself, exactly once, only when its OWN already-computed verdicts (the
 * training gap, the area mark, the leave line) would show nothing.
 *
 * F-128 is why AC1 renders under `<StrictMode>`: a side effect that fires
 * from a state updater runs twice there, and the fix for that (a ref, not a
 * second state flag) has to be proven under the mount the app actually uses.
 */
describe("CreatePopover — R-384: Enter auto-creates when the pop-up is clean", () => {
  it("AC1: a fully clean fixture auto-creates exactly once under StrictMode, with the same arguments a click would send", () => {
    const clickCase = renderPopover({
      operators: [trainedOperator],
      requiredSkills: [CNC],
      presetOperatorId: "op-1",
      presetProductId: "prod-1",
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(clickCase.onSubmitDirect).toHaveBeenCalledTimes(1);

    const autoCase = renderPopover({
      operators: [trainedOperator],
      requiredSkills: [CNC],
      presetOperatorId: "op-1",
      presetProductId: "prod-1",
      autoCreate: true,
      strict: true,
    });
    expect(autoCase.onSubmitDirect).toHaveBeenCalledTimes(1);
    expect(autoCase.onSubmitDirect.mock.calls[0]).toEqual(clickCase.onSubmitDirect.mock.calls[0]);
  });

  it("AC2: an operator missing a required training under 'warn' does not auto-create; the Never trained box renders", () => {
    const { onSubmitDirect } = renderPopover({
      operators: [untrainedOperator],
      requiredSkills: [CNC],
      eligibilityPolicy: "warn",
      presetOperatorId: "op-1",
      presetProductId: "prod-1",
      autoCreate: true,
    });
    expect(onSubmitDirect).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Never trained");
  });

  it("AC3: an operator outside this area does not auto-create; the area box renders", () => {
    const { onSubmitDirect } = renderPopover({
      operators: [trainedOperator],
      requiredSkills: [CNC],
      outsideAreaOperatorIds: new Set(["op-1"]),
      presetOperatorId: "op-1",
      presetProductId: "prod-1",
      autoCreate: true,
    });
    expect(onSubmitDirect).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("doesn’t belong to this part of the structure");
  });

  it("AC4: an operator on leave under 'warn' does not auto-create; the leave line renders", () => {
    const { onSubmitDirect } = renderPopover({
      operators: [trainedOperator],
      requiredSkills: [CNC],
      eligibilityPolicy: "warn",
      absences: [{ operatorId: "op-1", from: "2026-08-24", to: "2026-08-24", reason: "sick" }],
      presetOperatorId: "op-1",
      presetProductId: "prod-1",
      autoCreate: true,
    });
    expect(onSubmitDirect).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Placing them anyway records the assignment");
  });

  it("AC5: an untrained operator under 'block' does not auto-create; Create is disabled", () => {
    const { onSubmitDirect } = renderPopover({
      operators: [untrainedOperator],
      requiredSkills: [CNC],
      eligibilityPolicy: "block",
      presetOperatorId: "op-1",
      presetProductId: "prod-1",
      autoCreate: true,
    });
    expect(onSubmitDirect).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("AC6: a clean presetRun auto-creates once with { kind: 'run', runId } as the 4th argument", () => {
    const { onSubmitDirect } = renderPopover({
      operators: [trainedOperator],
      requiredSkills: [CNC],
      presetOperatorId: "op-1",
      presetRun: { id: "run-9", label: "Widget A 06:00-08:00" },
      autoCreate: true,
    });
    expect(onSubmitDirect).toHaveBeenCalledTimes(1);
    expect(onSubmitDirect.mock.calls[0][3]).toEqual({ kind: "run", runId: "run-9" });
  });

  it("AC7: the same clean fixture WITHOUT autoCreate never auto-creates (a drag's pop-up never does)", () => {
    const { onSubmitDirect } = renderPopover({
      operators: [trainedOperator],
      requiredSkills: [CNC],
      presetOperatorId: "op-1",
      presetProductId: "prod-1",
    });
    expect(onSubmitDirect).not.toHaveBeenCalled();
  });
});
