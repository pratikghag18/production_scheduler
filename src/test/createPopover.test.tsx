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
    products?: Product[];
    requiredSkills?: Skill[];
    outsideAreaOperatorIds?: ReadonlySet<string>;
    eligibilityPolicy?: "warn" | "block";
    absences?: AbsenceRow[];
    presetOperatorId?: string;
    presetProductId?: string;
    presetRun?: { id: string; label: string };
    presetMode?: "run";
    presetHeadcount?: number;
    presetMove?: { assignmentId: string };
    autoCreate?: boolean;
    /** R-384: renders under `<StrictMode>`, the way `src/main.tsx` mounts the
     *  app — needed to prove the auto-press fires exactly once (F-128). */
    strict?: boolean;
  } = {},
) {
  const onSubmitRun = vi.fn();
  const onSubmitDirect = vi.fn();
  const onSubmitMove = vi.fn().mockResolvedValue(undefined);
  const onCancel = vi.fn();
  const ops = over.operators ?? [operator];
  const element = (
    <CreatePopover
      nodeId="cell-1"
      anchor={{ x: 0, y: 0 }}
      initialRange={{ startMin: 360, endMin: 480 }}
      shiftChips={[]}
      defaultCreateMode={over.defaultCreateMode ?? "run"}
      products={over.products ?? [product]}
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
      presetMode={over.presetMode}
      presetHeadcount={over.presetHeadcount}
      presetMove={over.presetMove}
      autoCreate={over.autoCreate}
      onCancel={onCancel}
      onSubmitRun={onSubmitRun}
      onSubmitDirect={onSubmitDirect}
      onSubmitMove={onSubmitMove}
    />
  );
  render(over.strict ? <StrictMode>{element}</StrictMode> : element);
  return { onSubmitRun, onSubmitDirect, onSubmitMove, onCancel };
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

/**
 * S41-a — `presetMode`/`presetHeadcount`, brief s41-a-book-a-job-brief.md
 * §3/§5 (AC8-AC11): the typed "book a job" sentence opens this SAME popover
 * forced into Product run mode, with the run/direct segment disabled (there
 * is no operator to protect a flip back to direct from), and Create/auto-
 * press go through `submitRun()` — the SAME arguments a click sends.
 */
describe("CreatePopover — S41-a: presetMode 'run' (book a job)", () => {
  it("AC8: presetMode 'run' + presetProductId + autoCreate -- onSubmitRun once, with the same arguments a click sends", () => {
    // As AC1 does: a plain click's arguments are the reference, so the
    // Create button and the auto-press cannot silently diverge (M39).
    const clickCase = renderPopover({ presetMode: "run", presetProductId: "prod-1" });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(clickCase.onSubmitRun).toHaveBeenCalledTimes(1);
    expect(clickCase.onSubmitRun.mock.calls[0]).toEqual([
      "cell-1",
      { startMin: 360, endMin: 480 },
      "prod-1",
      2,
    ]);
    expect(clickCase.onSubmitDirect).not.toHaveBeenCalled();

    const autoCase = renderPopover({
      presetMode: "run",
      presetProductId: "prod-1",
      autoCreate: true,
      strict: true,
    });
    expect(autoCase.onSubmitRun).toHaveBeenCalledTimes(1);
    expect(autoCase.onSubmitRun.mock.calls[0]).toEqual(clickCase.onSubmitRun.mock.calls[0]);
    expect(autoCase.onSubmitDirect).not.toHaveBeenCalled();
  });

  it("AC9: presetHeadcount 3 -- the fourth argument is 3", () => {
    const { onSubmitRun } = renderPopover({
      presetMode: "run",
      presetProductId: "prod-1",
      presetHeadcount: 3,
      autoCreate: true,
    });
    expect(onSubmitRun).toHaveBeenCalledTimes(1);
    expect(onSubmitRun.mock.calls[0][3]).toBe(3);
  });

  it("AC10: presetMode 'run' with no product offered here -- nothing called", () => {
    const { onSubmitRun, onSubmitDirect } = renderPopover({
      presetMode: "run",
      products: [],
      presetProductId: "prod-1",
      autoCreate: true,
    });
    expect(onSubmitRun).not.toHaveBeenCalled();
    expect(onSubmitDirect).not.toHaveBeenCalled();
  });

  it("AC11: the segment's two buttons are disabled under presetMode, and a click does not flip the mode", () => {
    renderPopover({ presetMode: "run", presetProductId: "prod-1" });
    const runBtn = screen.getByRole("button", { name: "Product run" }) as HTMLButtonElement;
    const directBtn = screen.getByRole("button", {
      name: "Direct assignment",
    }) as HTMLButtonElement;
    expect(runBtn.disabled).toBe(true);
    expect(directBtn.disabled).toBe(true);

    fireEvent.click(directBtn);
    // Still in run mode: the headcount field is present, the operator picker is not.
    expect(screen.getByLabelText("Planned headcount")).toBeTruthy();
    expect(screen.queryByLabelText("Operator")).toBeNull();
  });
});

/**
 * S41-c — `presetMove`, brief s41-c-move-brief.md §4/§5 (AC12-AC14): the
 * typed "move" sentence opens this SAME popover on the TARGET cell, direct
 * mode forced (via `presetOperatorId`, as it already was), the operator
 * select replaced by a read-only line naming the person, and Create/auto-
 * press routed to `onSubmitMove` instead of `onSubmitDirect` — the SAME
 * training/area/leave boxes decide `clean` exactly as a create's do.
 */
describe("CreatePopover — S41-c: presetMove (move to another cell)", () => {
  it("AC12: presetMove forces direct mode with the person fixed -- no operator select, a 'Moving <person>'s block' line instead", () => {
    renderPopover({
      operators: [operator],
      presetOperatorId: "op-1",
      presetProductId: "prod-1",
      presetMove: { assignmentId: "asg-1" },
    });
    expect(screen.queryByLabelText("Operator")).toBeNull();
    expect(document.body.textContent).toContain("Moving Ana Ortiz’s block");
    // Efficiency/target fields are meaningless for a move (the server takes
    // none of them) and are hidden rather than shown-and-ignored.
    expect(screen.queryByLabelText("Efficiency %")).toBeNull();
  });

  it("AC13: Enter calls onSubmitMove once under StrictMode, with the same arguments a click sends", () => {
    const clickCase = renderPopover({
      operators: [trainedOperator],
      requiredSkills: [CNC],
      presetOperatorId: "op-1",
      presetProductId: "prod-1",
      presetMove: { assignmentId: "asg-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(clickCase.onSubmitMove).toHaveBeenCalledTimes(1);
    expect(clickCase.onSubmitMove.mock.calls[0]).toEqual([
      "cell-1",
      { startMin: 360, endMin: 480 },
      "asg-1",
      false,
      undefined,
      false,
      undefined,
    ]);
    expect(clickCase.onSubmitDirect).not.toHaveBeenCalled();

    const autoCase = renderPopover({
      operators: [trainedOperator],
      requiredSkills: [CNC],
      presetOperatorId: "op-1",
      presetProductId: "prod-1",
      presetMove: { assignmentId: "asg-1" },
      autoCreate: true,
      strict: true,
    });
    expect(autoCase.onSubmitMove).toHaveBeenCalledTimes(1);
    expect(autoCase.onSubmitMove.mock.calls[0]).toEqual(clickCase.onSubmitMove.mock.calls[0]);
    expect(autoCase.onSubmitDirect).not.toHaveBeenCalled();
  });

  it("AC14: an ineligible target opens the training box, does not auto-create, and calls nothing", () => {
    const { onSubmitMove, onSubmitDirect } = renderPopover({
      operators: [untrainedOperator],
      requiredSkills: [CNC],
      eligibilityPolicy: "warn",
      presetOperatorId: "op-1",
      presetProductId: "prod-1",
      presetMove: { assignmentId: "asg-1" },
      autoCreate: true,
    });
    expect(onSubmitMove).not.toHaveBeenCalled();
    expect(onSubmitDirect).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Never trained");
  });

  it("AC15 (D120): the segment's two buttons are disabled under presetMove, and clicking 'Product run' does not flip the mode -- Create still calls onSubmitMove, never onSubmitRun", () => {
    const { onSubmitRun, onSubmitMove } = renderPopover({
      operators: [trainedOperator],
      requiredSkills: [CNC],
      presetOperatorId: "op-1",
      presetProductId: "prod-1",
      presetMove: { assignmentId: "asg-1" },
    });
    const runBtn = screen.getByRole("button", { name: "Product run" }) as HTMLButtonElement;
    const directBtn = screen.getByRole("button", {
      name: "Direct assignment",
    }) as HTMLButtonElement;
    expect(runBtn.disabled).toBe(true);
    expect(directBtn.disabled).toBe(true);

    fireEvent.click(runBtn);
    // Still in direct mode: the "Moving <person>'s block" line is present,
    // the run-only headcount field is not -- a click on the disabled
    // button did not flip `mode`.
    expect(document.body.textContent).toContain("Moving Ana Ortiz’s block");
    expect(screen.queryByLabelText("Planned headcount")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(onSubmitMove).toHaveBeenCalledTimes(1);
    expect(onSubmitRun).not.toHaveBeenCalled();
  });

  it("AC16 (the review lane's race): a fresh key re-arms the R-384 auto-press for a second, different move", () => {
    // `BoardPage` keys `<CreatePopover>` on `popover.seq` precisely so a
    // second typed command opening this popover while an earlier one is
    // still in flight is a NEW MOUNT, not a prop update on the same
    // instance (which would leave the mount-only auto-press effect
    // permanently spent after its first firing). This drives that directly
    // through `rerender`, changing both `key` and the moved block's id.
    const onSubmitMove = vi.fn().mockResolvedValue(undefined);
    const onSubmitRun = vi.fn();
    const onSubmitDirect = vi.fn();
    const onCancel = vi.fn();

    function element(key: number, assignmentId: string) {
      return (
        <CreatePopover
          key={key}
          nodeId="cell-1"
          anchor={{ x: 0, y: 0 }}
          initialRange={{ startMin: 360, endMin: 480 }}
          shiftChips={[]}
          defaultCreateMode="direct"
          products={[product]}
          operators={[trainedOperator]}
          hereOperatorIds={new Set(["op-1"])}
          windowStart={WINDOW_START}
          requiredSkills={[CNC]}
          outsideAreaOperatorIds={new Set()}
          eligibilityPolicy="warn"
          absences={[]}
          presetOperatorId="op-1"
          presetProductId="prod-1"
          presetMove={{ assignmentId }}
          autoCreate={true}
          onCancel={onCancel}
          onSubmitRun={onSubmitRun}
          onSubmitDirect={onSubmitDirect}
          onSubmitMove={onSubmitMove}
        />
      );
    }

    const { rerender } = render(element(1, "asg-1"));
    expect(onSubmitMove).toHaveBeenCalledTimes(1);
    expect(onSubmitMove.mock.calls[0][2]).toBe("asg-1");

    rerender(element(2, "asg-2"));
    expect(onSubmitMove).toHaveBeenCalledTimes(2);
    expect(onSubmitMove.mock.calls[1][2]).toBe("asg-2");
    expect(onSubmitRun).not.toHaveBeenCalled();
    expect(onSubmitDirect).not.toHaveBeenCalled();
  });
});
